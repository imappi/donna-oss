// Donna — role certification, the gate ABOVE the lanes (S6 of
// docs/design-donna-specialist-roles.md §5).
//
// A model-lane gate (modelLaneGate.js) certifies ONE model call site. A ROLE
// is more than its call sites: it is a leash, an authority envelope, wired
// dispatch, and observed behavior under real traffic. This module defines the
// RoleCertification MANIFEST per role × jurisdiction × version — the named
// requirements a role must hold green ON DATA before its card may claim
// **Autonomous** — and the arithmetic that evaluates a gathered evidence
// bundle against it. Until a manifest is green AND a human signs, the card
// displays honestly as **Preview / supervised** (INV-S9).
//
// The modelLaneGate discipline applies wholesale:
//   - HONESTY RULE: absent evidence, an absent table, a thin window, or an
//     unbuilt requirement reads RED with insufficient_data — never green.
//     Today every manifest is red by construction (zero lanes gate-governed
//     for R1's constituents, no EAW role curriculum, no observation window at
//     volume): that is the gate telling the truth. The JOURNEY requirement is
//     the one that changed on 2026-08-15 — both runs are built
//     (roles/journeys/collectionsJourneys.js) and pass, so supplying their run
//     reports turns that requirement green; the rest stay red on their own
//     evidence, which is the point of a conjunction. The LEASH requirement
//     changed the same day in a different way: its evidence was always
//     available but only as a hand-authored claim, and now has a producer
//     (leashTestRun.js) whose report the gather requires by artifact kind.
//   - MODEL IDS COME FROM RECEIPTS, NOT CODE: lane evidence rides gap tables
//     over model_challenger_runs (deciding->>'model'); observation evidence
//     carries the distinct outbound_action_receipts.model values. No config
//     default appears anywhere in a verdict.
//   - NOTHING AUTO-CERTIFIES: this module never writes the claim. A green
//     gate makes the verdict artifact SIGNABLE; the Autonomous claim is a
//     separate, dated, human-signed commit that sets the role's
//     `certification` record in roleRegistry.js with the signed artifact
//     attached (validateCertificationRecord refuses anything less). The
//     roster's claim ladder (certificationClaimForRole) is fail-closed:
//     null, malformed, unsigned, unknown-manifest, or stale-vintage records
//     all read 'preview'.
//
// READ module — no writer, no store (the verdict artifact is a written JSON,
// the run_lane_gate.js pattern; runner: scripts/run_role_certification.js;
// the DB-free half can be previewed in one command with
// scripts/run_role_certification_offline.js, whose artifact is a distinct,
// never-signable kind). The INV-S5 channel scan (roleEvents.test.js) covers
// this file like every roles/ module: nothing here can reach an LLM engine.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getLane } from '../modelLanes.js';
import { computeLaneGapTable, evaluateLaneGate } from '../modelLaneGate.js';
import { OUTBOUND_ACTION_TYPES } from '../outbound/actionGate.js';
import { findRoleDefinition } from './roleRegistry.js';
import { roleSurfaceCoverageGaps } from './roleActionSurface.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const deepFreeze = (node) => {
  if (node && typeof node === 'object') {
    for (const value of Object.values(node)) deepFreeze(value);
    Object.freeze(node);
  }
  return node;
};

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

export const ROLE_CERTIFICATION_VERDICT_ARTIFACT = 'donna.roleCertificationVerdict.v1';

// The leash-test run report this module accepts as `--tests` evidence. Named
// here (not in its producer) so the producer can go on importing this module
// for the runtime version without a cycle; leashTestRun.js re-exports it.
export const ROLE_LEASH_TEST_RUN_ARTIFACT = 'donna.roleLeashTestRun.v1';

// The journey run report this module accepts as `--journey` evidence — the
// same naming home for the same reason (collectionsJourneys.js re-exports it,
// the leashTestRun.js pattern). The producer has stamped this kind on every
// report since its first day; the gather only started DEMANDING it on
// 2026-08-15, when a review of the leash refusal found the journey
// requirement — built one session before that refusal existed — still
// accepted a bare `{ gate: 'PASS' }` blob: a hand-authored claim, not a run.
export const ROLE_JOURNEY_RUN_ARTIFACT = 'donna.roleJourneyRun.v1';

// The OFFLINE PREVIEW artifact (scripts/run_role_certification_offline.js).
// Deliberately a DIFFERENT kind from the verdict artifact: a preview is never
// signable, and a reader — or a certification record — must never mistake one
// for the verdict a human signs. buildRoleCertificationOfflinePreview refuses
// full evidence for the same reason.
export const ROLE_CERTIFICATION_OFFLINE_PREVIEW_ARTIFACT = 'donna.roleCertificationOfflinePreview.v1';

// The signing ceremony's TERMS (Kari's WHO-SIGNS call, 2026-08-16 — design
// §10.8), held as data because a decision of record that nothing
// machine-checks is the exact hole this module keeps closing. The signer is
// KARI, by name — the product's accountable human; auto-sign-on-green was
// argued and REJECTED, so a validator that accepted any non-empty signed_by
// left that door ajar one field wide. A second name here is a new dated
// decision, never a code drift. And the signed verdict is COMMITTED under one
// home directory, referenced by repo path — a reference anywhere else is
// refused UNREAD (validateCertificationRecord enforces both).
export const ROLE_CERTIFICATION_SIGNERS = Object.freeze(['kari']);
export const ROLE_CERTIFICATION_ARTIFACT_HOME = 'data/certifications/';

// The two requirements whose evidence lives ONLY in the DB (lane gap tables
// over model_challenger_runs; role-leash-passed send receipts + would-block
// counts). An offline gather cannot evaluate them: they stay ungathered and
// read red with insufficient_data downstream — never fabricated, never green.
export const DB_GATHERED_REQUIREMENTS = Object.freeze(['model_lane_gates', 'observation_evidence']);

export const CERTIFICATION_CLAIMS = Object.freeze(['preview', 'autonomous']);

// The code + policy-pack vintage certification evidence binds to. Bump this
// when a role's machinery changes materially (leash semantics, executor gate
// order, pack cadence law): every manifest then mismatches and reads red until
// re-issued at a new version against re-gathered evidence — a certification
// must never quietly outlive the runtime it certified. Re-gathering is honest
// because the gather REFUSES supplied run reports stamped at any other
// vintage (2026-08-16): without that, a "re-gather" could quietly launder OLD
// reports into the new version — the gather stamps the fresh constant into
// the evidence, so the gate's runtime_version check alone can never catch a
// stale supplied report.
export const CURRENT_ROLE_RUNTIME_VERSION = 1;

// ── The manifests ───────────────────────────────────────────────────────────
// One per role × jurisdiction × version. R1 × GB × v1 is the only manifest:
// the UK is the shipping market and invoicing_collections the only role with
// an autonomous surface. Adding a market or role is a NEW manifest entry —
// the key carries jurisdiction precisely so the shape holds for the other
// market unchanged (the standing design question).
//
// Requirement semantics:
//   required_model_lane_gates    — constituent model call sites of the role's
//     judgment surface; each must hold a GREEN modelLaneGate evaluation.
//     R1's: owner_invoice_command_read (the owner command → draft mint) and
//     marketing_drafting (carries outbound/replyIngestion.js — the
//     record_reply_correction classifier). Dunning/issuance copy is
//     pack-declared and deterministic — no lane to gate.
//   required_eaw_core_curriculum — the shared bookkeeping competence worlds;
//     ids map to REAL fixtures (data/worlds/<id>.json, validated) and each
//     needs a supplied passing run report.
//   required_eaw_role_curriculum — role-specific adversarial worlds. These do
//     NOT exist yet (the long arc under the EAW plan's own gates) — declared
//     so the gate reads red until they are built and passed, which is the
//     point: the Preview bench does not wait for them, the Autonomous claim
//     does.
//   required_journey_tests       — end-to-end production-shaped runs. BUILT
//     (roles/journeys/collectionsJourneys.js, 2026-08-15): each entry names the
//     file that defines it and validation checks that file exists, exactly as
//     it does for leash tests. Existence is not evidence: the gate still needs
//     a supplied run report whose `gate` is PASS
//     (scripts/run_role_journeys.js writes them), and the report must declare
//     the ROLE_JOURNEY_RUN_ARTIFACT kind — one that does not is refused
//     loudly by the gather (added 2026-08-15: the leash refusal below,
//     applied here. Until then a hand-authored `{ gate: 'PASS' }` blob
//     satisfied this requirement — the producer stamped the kind from its
//     first day, but nothing asked). The report must also RECORD the journey
//     it is supplied for: one whose own `journey` id differs is refused the
//     same way (added 2026-08-16 — the kind refusal tells a run from a lie;
//     this tells one journey's run from another's, because `--journey
//     <id>=<path>` keys the evidence map from the CLI, so a real passing
//     report for one journey could previously stand in for the other).
//   required_leash_tests         — authority/refusal correctness (INV-S2/S10);
//     REAL test files (validated to exist) whose green status must be
//     evidenced by a supplied test-run report, not assumed. The report is now
//     PRODUCED, not written by hand (leashTestRun.js, 2026-08-15): it must
//     declare the ROLE_LEASH_TEST_RUN_ARTIFACT kind, and a report that does
//     not is refused loudly by the gather. Until that producer existed this
//     was the one requirement whose evidence was a human's word — the same
//     hole the journey requirement closed the same day, one requirement over.
//   required_wiring_coverage     — the role's audited surface fully dispatched:
//     roleSurfaceCoverageGaps() must be empty. max_gaps is pinned 0 by
//     validation — a certification that tolerates uncovered surface is
//     dishonest by construction.
//   required_observation_evidence— receipts at volume: role-leash-passed send
//     receipts (min count + min calendar window, the lane-gate numbers) and
//     ZERO specialist_role.would_block receipts. max_would_blocks is pinned 0
//     by validation for the same reason as max_gaps.
//   runtime_version              — must equal CURRENT_ROLE_RUNTIME_VERSION at
//     evaluation time (see the constant above).
export const ROLE_CERTIFICATION_MANIFESTS = deepFreeze([
  {
    role: 'invoicing_collections',
    jurisdiction: 'GB',
    version: 1,
    runtime_version: 1,
    required_model_lane_gates: ['owner_invoice_command_read', 'marketing_drafting'],
    required_eaw_core_curriculum: [
      'proof0',
      'slice1-gross-to-net-single',
      'slice1-batched-fx-fee-netted',
      'slice1-director-purpose-close'
    ],
    required_eaw_role_curriculum: [
      {
        id: 'eaw.collections.dunning-adversarial.v1',
        description: 'adversarial dunning worlds: disputed invoices, partial payments, wrong-party replies, cadence abuse'
      },
      {
        id: 'eaw.collections.settlement-truth.v1',
        description: 'paid-truth adversarial worlds: FX-settled, processor-intermediated, reference-mangled settlements'
      }
    ],
    required_journey_tests: [
      {
        id: 'journey.collections.invoice-to-settlement.v1',
        description: 'issue → send → overdue sweep opens the chase → pay-link settlement cancels it → receivable case terminal, production-shaped',
        file: 'server/donna/roles/journeys/collectionsJourneys.js'
      },
      {
        id: 'journey.collections.cadence-to-owner-escalation.v1',
        description: 'reminder cadence exhausted → decide_collection_next_step rests on the owner, receipted',
        file: 'server/donna/roles/journeys/collectionsJourneys.js'
      }
    ],
    required_leash_tests: [
      'server/donna/roles/roleAuthority.test.js',
      'server/donna/roles/roleEmployment.test.js',
      'server/donna/roles/roleActionSurface.test.js',
      'server/donna/roles/roleEvents.test.js',
      'server/donna/outbound/actionExecutor.test.js'
    ],
    required_wiring_coverage: { max_gaps: 0 },
    required_observation_evidence: {
      min_role_receipts: 200,
      min_window_days: 14,
      max_would_blocks: 0
    }
  }
]);

export const findCertificationManifest = (roleId, jurisdiction, version) =>
  ROLE_CERTIFICATION_MANIFESTS.find((m) =>
    m.role === roleId && m.jurisdiction === jurisdiction && m.version === Number(version)) || null;

export const manifestsForRole = (roleId) =>
  ROLE_CERTIFICATION_MANIFESTS.filter((m) => m.role === roleId);

// ── Manifest validation (the registry-lint pattern: the test asserts empty) ──
export const validateRoleCertificationManifests = ({ deps = {} } = {}) => {
  const exists = deps.existsSync || ((relPath) => existsSync(join(REPO_ROOT, relPath)));
  const problems = [];
  const seen = new Set();
  for (const m of ROLE_CERTIFICATION_MANIFESTS) {
    const tag = `manifest ${m?.role}/${m?.jurisdiction}/v${m?.version}`;
    if (!findRoleDefinition(m.role)) problems.push(`${tag}: unknown role`);
    if (!/^[A-Z]{2}$/.test(m.jurisdiction || '')) problems.push(`${tag}: jurisdiction must be an ISO 3166 alpha-2 code`);
    if (!Number.isInteger(m.version) || m.version < 1) problems.push(`${tag}: version must be a positive integer`);
    if (!Number.isInteger(m.runtime_version) || m.runtime_version < 1) problems.push(`${tag}: runtime_version must be a positive integer`);
    const key = `${m.role}/${m.jurisdiction}/${m.version}`;
    if (seen.has(key)) problems.push(`${tag}: duplicate manifest coordinates`);
    seen.add(key);
    if (!Array.isArray(m.required_model_lane_gates) || m.required_model_lane_gates.length === 0) {
      problems.push(`${tag}: required_model_lane_gates must name at least one lane`);
    } else {
      for (const laneId of m.required_model_lane_gates) {
        if (!getLane(laneId)) problems.push(`${tag}: unknown model lane '${laneId}'`);
      }
    }
    if (!Array.isArray(m.required_eaw_core_curriculum) || m.required_eaw_core_curriculum.length === 0) {
      problems.push(`${tag}: required_eaw_core_curriculum must name at least one world`);
    } else {
      for (const worldId of m.required_eaw_core_curriculum) {
        if (!exists(`data/worlds/${worldId}.json`)) {
          problems.push(`${tag}: core world '${worldId}' has no fixture at data/worlds/${worldId}.json`);
        }
      }
    }
    for (const list of ['required_eaw_role_curriculum', 'required_journey_tests']) {
      if (!Array.isArray(m[list]) || m[list].length === 0) {
        problems.push(`${tag}: ${list} must declare at least one requirement`);
        continue;
      }
      for (const entry of m[list]) {
        if (!entry || !isNonEmptyString(entry.id) || !isNonEmptyString(entry.description)) {
          problems.push(`${tag}: every ${list} entry needs id + description`);
        }
      }
    }
    // Journeys are BUILT now (2026-08-15), so their declaration is validated
    // the way leash tests are: the file must exist in the tree. The role
    // CURRICULUM above deliberately keeps no such check — those worlds are
    // still unbuilt by design, and the gate's red on a missing run report is
    // exactly how that stays visible. A journey id whose home was deleted or
    // renamed would otherwise sit here looking satisfied while nothing could
    // ever produce its run report.
    for (const entry of (m.required_journey_tests || [])) {
      if (!entry || !isNonEmptyString(entry.id)) continue;
      if (!isNonEmptyString(entry.file)) {
        problems.push(`${tag}: journey '${entry.id}' must name the file that defines it`);
      } else if (!exists(entry.file)) {
        problems.push(`${tag}: journey '${entry.id}' names '${entry.file}', which does not exist in the tree`);
      }
    }
    if (!Array.isArray(m.required_leash_tests) || m.required_leash_tests.length === 0) {
      problems.push(`${tag}: required_leash_tests must name at least one test file`);
    } else {
      for (const relPath of m.required_leash_tests) {
        if (!exists(relPath)) problems.push(`${tag}: leash test '${relPath}' does not exist in the tree`);
      }
    }
    if (m.required_wiring_coverage?.max_gaps !== 0) {
      problems.push(`${tag}: required_wiring_coverage.max_gaps is pinned 0 — a certification tolerating uncovered surface is dishonest`);
    }
    const obs = m.required_observation_evidence;
    if (!obs || !Number.isInteger(obs.min_role_receipts) || obs.min_role_receipts < 1
      || !Number.isInteger(obs.min_window_days) || obs.min_window_days < 1) {
      problems.push(`${tag}: required_observation_evidence needs positive min_role_receipts + min_window_days`);
    }
    if (obs?.max_would_blocks !== 0) {
      problems.push(`${tag}: required_observation_evidence.max_would_blocks is pinned 0 — observed would-blocks refute the leash claim`);
    }
  }
  return problems;
};

// ── Evidence gathering ──────────────────────────────────────────────────────
// Reads what the tree persists (fleet-wide — certification is a product
// decision, the promotion-gate scope); accepts the offline halves (gold-set /
// EAW / journey / test-run reports) as supplied inputs, exactly like
// evaluateLaneGate takes goldReport. What is not supplied stays null and
// reads red downstream.

export const gatherObservationEvidence = async (client, { manifest } = {}) => {
  const empty = {
    table_present: false,
    role_receipts: 0,
    would_blocks: 0,
    first_receipt_at: null,
    last_receipt_at: null,
    window_days: 0,
    models: []
  };
  const role = findRoleDefinition(manifest?.role);
  if (!client || !role) return empty;
  const sendTypes = role.action_set.filter((verb) => OUTBOUND_ACTION_TYPES.includes(verb));

  const present = await client.query("select to_regclass('public.outbound_action_receipts') as present");
  if (!present.rows[0]?.present) return empty;
  const out = { ...empty, table_present: true };

  // Positive evidence: SENT receipts whose checks carry the role_leash pass
  // (INV-S7 — the S1 executor stamps it on every claimed send). jsonb
  // containment ignores the check's other fields.
  const leashPass = JSON.stringify([{ check: 'role_leash', status: 'pass' }]);
  if (sendTypes.length) {
    const receipts = await client.query(
      `select count(*)::int as role_receipts,
              min(created_at) as first_receipt_at, max(created_at) as last_receipt_at
         from outbound_action_receipts
        where action_type = any($1) and outcome = 'sent' and checks @> $2::jsonb`,
      [sendTypes, leashPass]
    );
    const row = receipts.rows[0] || {};
    out.role_receipts = Number(row.role_receipts) || 0;
    out.first_receipt_at = row.first_receipt_at ? new Date(row.first_receipt_at).toISOString() : null;
    out.last_receipt_at = row.last_receipt_at ? new Date(row.last_receipt_at).toISOString() : null;
    if (out.first_receipt_at && out.last_receipt_at) {
      out.window_days = (new Date(out.last_receipt_at) - new Date(out.first_receipt_at)) / 86_400_000;
    }
    // The model ids ride from the receipts' NOT NULL model column — never
    // from a config default.
    const models = await client.query(
      `select distinct model from outbound_action_receipts
        where action_type = any($1) and outcome = 'sent' and checks @> $2::jsonb`,
      [sendTypes, leashPass]
    );
    out.models = (models.rows || []).map((r) => r.model).filter(Boolean).sort();
  }

  // Negative evidence: the shadow window's would-block receipts. Any nonzero
  // count refutes the leash claim (the S1 expectation is ZERO).
  const wouldBlocks = await client.query(
    "select count(*)::int as would_blocks from audit_events where action = 'specialist_role.would_block'"
  );
  out.would_blocks = Number(wouldBlocks.rows[0]?.would_blocks) || 0;
  return out;
};

export const gatherRoleCertificationEvidence = async (client, {
  manifest,
  goldReports = {}, // laneId → the lane's gold-set report (its runner's output)
  eawReports = {}, // world/curriculum id → EAW run report
  journeyRuns = {}, // journey id → run report
  testRunReport = null, // { files: { '<path>': { green: true } } }
  offline = false, // true = no DB at hand: DB_GATHERED_REQUIREMENTS stay ungathered
  deps = {}
} = {}) => {
  if (!manifest) throw new Error('gatherRoleCertificationEvidence requires a manifest');
  // The offline/client split is refused loudly in both directions. Offline
  // WITH a client would silently discard evidence that was one query away;
  // full WITHOUT a client used to die as a TypeError three calls deep — a
  // broken-harness message masquerading as a gather bug.
  if (offline && client) {
    throw new Error('an offline gather with a DB client at hand is a contradiction — drop offline, or drop the client');
  }
  if (!offline && !client) {
    throw new Error('the full gather requires a DB client (lane gap tables + observation evidence live there) — pass offline: true for the DB-free half');
  }
  // Gold reports are half of a lane-gate evaluation; the other half (the gap
  // table) lives in the DB. Accepting them offline and quietly not evaluating
  // them is the silently-dropped-report trap the leash refusal below closes —
  // same law here.
  if (offline && Object.keys(goldReports).length) {
    throw new Error('gold reports cannot be evaluated offline (a lane gate needs its DB gap table) — run scripts/run_role_certification.js for lane evidence');
  }
  const exists = deps.existsSync || ((relPath) => existsSync(join(REPO_ROOT, relPath)));

  const laneGates = {};
  if (!offline) {
    for (const laneId of manifest.required_model_lane_gates) {
      const lane = getLane(laneId);
      const gapTable = await computeLaneGapTable({ client, laneId });
      laneGates[laneId] = {
        ...evaluateLaneGate({
          gapTable,
          goldReport: goldReports[laneId] || null,
          qualified: lane?.qualified ?? null
        }),
        gap_table: gapTable
      };
    }
  }

  // The supplied report must be a RUN, not a claim. Before 2026-08-15 any
  // hand-authored `{ files: { <path>: { green: true } } }` blob satisfied this
  // requirement — a human's word standing in for evidence, the one requirement
  // in the gate with no producer. scripts/run_role_leash_tests.js produces the
  // real thing; anything else is refused LOUDLY here rather than being quietly
  // ignored, because a silently-dropped report reads as "no run" and would
  // send the reader hunting for a missing file they actually supplied.
  if (testRunReport != null && testRunReport.artifact !== ROLE_LEASH_TEST_RUN_ARTIFACT) {
    throw new Error(
      `the test-run report is not a ${ROLE_LEASH_TEST_RUN_ARTIFACT} (got ${
        testRunReport.artifact ? `'${testRunReport.artifact}'` : 'no artifact kind'
      }) — produce it with scripts/run_role_leash_tests.js`
    );
  }
  // The VINTAGE refusal (2026-08-16), both supplied report kinds — the third
  // field the producers stamped from their first day that nothing asked about
  // (kind 2026-08-15, journey identity 2026-08-16, vintage now). Without it
  // the constant's re-issue law above was unenforceable against the supplied
  // halves: bumping CURRENT_ROLE_RUNTIME_VERSION re-reds every manifest, but
  // a re-gather could quietly launder OLD reports into the new vintage,
  // because this gather stamps the FRESH constant into the evidence and never
  // read the reports' own field. Evidence must not outlive the runtime it
  // certifies.
  if (testRunReport != null && testRunReport.runtime_version !== CURRENT_ROLE_RUNTIME_VERSION) {
    throw new Error(
      `the test-run report was produced at role runtime ${
        testRunReport.runtime_version != null ? `v${testRunReport.runtime_version}` : 'no version at all'
      } and this gather runs at v${CURRENT_ROLE_RUNTIME_VERSION} — evidence must not outlive the runtime it certifies; re-produce it with scripts/run_role_leash_tests.js`
    );
  }
  // The same law for journey runs, one requirement over. The producer
  // (collectionsJourneys.js) has stamped ROLE_JOURNEY_RUN_ARTIFACT on every
  // report since its first day, but until 2026-08-15 nothing here asked — a
  // hand-authored `{ gate: 'PASS' }` blob satisfied the requirement, which is
  // exactly the run-versus-lie difference the leash refusal above exists to
  // catch. (The EAW reports deliberately have NO kind refusal yet: their
  // producer belongs to the codex EAW lane, which has not built one, and
  // naming its report format here would front-run that lane's design.)
  for (const [journeyId, run] of Object.entries(journeyRuns)) {
    if (run != null && run.artifact !== ROLE_JOURNEY_RUN_ARTIFACT) {
      throw new Error(
        `the journey run report for '${journeyId}' is not a ${ROLE_JOURNEY_RUN_ARTIFACT} (got ${
          run.artifact ? `'${run.artifact}'` : 'no artifact kind'
        }) — produce it with scripts/run_role_journeys.js`
      );
    }
    // The kind refusal tells a run from a lie; THIS tells one run from
    // another. The report has recorded which journey it ran (`journey`) since
    // its first day — the same story as the kind — but the evidence map's
    // keys come from the CLI (`--journey <id>=<path>`), so a real,
    // kind-stamped, PASSing report for one journey supplied under the other's
    // id turned journey_tests green for a journey that never ran (closed
    // 2026-08-16). The leash report needs no such check: its identity is
    // inherent in its shape — the files map is keyed by the paths that
    // actually ran, so a wrong report reads green:null, missing, red — which
    // is exactly what the journey report's sibling `journey` field is not.
    if (run != null && run.journey !== journeyId) {
      throw new Error(
        `the journey run report supplied for '${journeyId}' records a run of ${
          run.journey ? `'${run.journey}'` : 'no journey at all'
        } — one journey's run is not another journey's evidence; produce the right report with scripts/run_role_journeys.js`
      );
    }
    // The same vintage law as the test-run report above: a journey report
    // stamped at any other role runtime is refused, not quietly re-certified.
    if (run != null && run.runtime_version !== CURRENT_ROLE_RUNTIME_VERSION) {
      throw new Error(
        `the journey run report for '${journeyId}' was produced at role runtime ${
          run.runtime_version != null ? `v${run.runtime_version}` : 'no version at all'
        } and this gather runs at v${CURRENT_ROLE_RUNTIME_VERSION} — evidence must not outlive the runtime it certifies; re-produce it with scripts/run_role_journeys.js`
      );
    }
  }
  const leashTests = {};
  for (const relPath of manifest.required_leash_tests) {
    leashTests[relPath] = {
      exists: exists(relPath),
      green: testRunReport?.files?.[relPath]?.green === true ? true : null
    };
  }

  // Only R1 has an audited surface inventory today; a manifest for a role
  // without one gathers null and reads red honestly (the inventory IS the
  // wiring evidence — no inventory, no coverage claim).
  const wiring = manifest.role === 'invoicing_collections'
    ? { surface: 'roleActionSurface.R1_AUTONOMOUS_SURFACE', gaps: roleSurfaceCoverageGaps() }
    : null;

  return {
    offline: offline === true,
    lane_gates: laneGates,
    eaw_reports: eawReports,
    journey_runs: journeyRuns,
    leash_tests: leashTests,
    // The report itself rides the evidence (2026-08-16, the tenth ask), not
    // just the rows derived from it: the arithmetic reads green FROM the
    // report and asks its kind and vintage there, and the verdict artifact
    // embeds it — so the record layer's re-derivation has a report to ask,
    // instead of rows a fabricated artifact could hand-author. The derived
    // rows stay (existence is a tree fact; surfaces render them).
    leash_test_run: testRunReport ?? null,
    wiring,
    // Offline, observation is NULL — not the empty-counts shape, whose
    // table_present:false downstream detail ("migration 091 has not run
    // here") would claim a DB fact nothing checked. Null reads as
    // observation_missing: "no observation evidence gathered", which is
    // exactly what happened.
    observation: offline ? null : await gatherObservationEvidence(client, { manifest }),
    runtime_version: CURRENT_ROLE_RUNTIME_VERSION
  };
};

// ── The gate arithmetic ─────────────────────────────────────────────────────
// Pure conjunction over the manifest's requirements: EVERY requirement must be
// green; missing evidence is red-with-insufficient_data, never green. A green
// constituent lane alone is NOT a certified role (INV-S9) — it is one green
// requirement among eight.
export const evaluateRoleCertification = ({ manifest, evidence = {} } = {}) => {
  if (!manifest) {
    return {
      verdict: 'red',
      insufficient_data: true,
      reasons: [{ requirement: 'manifest', code: 'no_manifest', detail: 'no certification manifest supplied' }],
      requirements: {}
    };
  }
  const reasons = [];
  const insufficient = [];
  const requirements = {};
  const check = (name, fn) => {
    const local = [];
    // Every reason carries its class: insufficient=true is ABSENT evidence
    // (nothing gathered/supplied), insufficient=false is a REFUTATION (the
    // evidence was looked at and found red). The arithmetic always knew the
    // split; recording it per-reason is what lets a reader — and the offline
    // preview's exit code — tell "not yet evidenced" from "found wrong".
    const fail = (code, detail) => local.push({ code, detail, insufficient: false });
    const missing = (code, detail) => { local.push({ code, detail, insufficient: true }); insufficient.push(code); };
    fn({ fail, missing });
    requirements[name] = { verdict: local.length ? 'red' : 'green', reasons: local };
    for (const r of local) reasons.push({ requirement: name, ...r });
  };

  check('model_lane_gates', ({ fail, missing }) => {
    for (const laneId of manifest.required_model_lane_gates) {
      const gate = evidence.lane_gates?.[laneId];
      if (!gate) { missing('lane_gate_missing', `no gate evaluation supplied for lane '${laneId}'`); continue; }
      if (gate.verdict !== 'green') {
        const detail = `lane '${laneId}' gate is ${gate.verdict}: [${(gate.reasons || []).map((r) => r.code).join(', ')}]`;
        if (gate.insufficient_data) missing('lane_gate_insufficient', detail);
        else fail('lane_gate_red', detail);
      }
    }
  });

  check('eaw_core_curriculum', ({ fail, missing }) => {
    for (const worldId of manifest.required_eaw_core_curriculum) {
      const report = evidence.eaw_reports?.[worldId];
      if (!report) { missing('eaw_core_report_missing', `no run report supplied for core world '${worldId}'`); continue; }
      if (report.gate !== 'PASS') fail('eaw_core_gate_red', `core world '${worldId}' gate is ${report.gate ?? 'absent'}`);
    }
  });

  check('eaw_role_curriculum', ({ fail, missing }) => {
    for (const entry of manifest.required_eaw_role_curriculum) {
      const report = evidence.eaw_reports?.[entry.id];
      if (!report) { missing('eaw_role_report_missing', `no run report supplied for role curriculum '${entry.id}'`); continue; }
      if (report.gate !== 'PASS') fail('eaw_role_gate_red', `role curriculum '${entry.id}' gate is ${report.gate ?? 'absent'}`);
    }
  });

  check('journey_tests', ({ fail, missing }) => {
    for (const entry of manifest.required_journey_tests) {
      const run = evidence.journey_runs?.[entry.id];
      if (!run) { missing('journey_run_missing', `no run supplied for journey '${entry.id}'`); continue; }
      // The journey-report laws, IN the arithmetic (2026-08-16, the ninth
      // ask). The gather refuses these at supply time (kind #1688, identity
      // #1693, vintage #1694) — but gathered evidence is not the only
      // evidence this arithmetic reads: the record layer RE-DERIVES a
      // committed verdict artifact's gate from its embedded numbers (#1705),
      // and until now the embedded journey runs answered only for
      // `gate: 'PASS'` — the exact hand-authored blob #1688 closed, alive
      // one layer up. The laws live here now, so every layer that evaluates
      // asks them; a wrong field is a REFUTATION (the evidence was looked at
      // and found wrong), never thin data. The EAW reports keep no such law
      // by design — their producer belongs to the codex EAW lane (the
      // recorded boundary, unchanged).
      if (run.artifact !== ROLE_JOURNEY_RUN_ARTIFACT) {
        fail('journey_run_wrong_kind', `journey '${entry.id}' run report declares ${run.artifact ? `'${run.artifact}'` : 'no artifact kind'}, not ${ROLE_JOURNEY_RUN_ARTIFACT} — a claim is not a run`);
        continue;
      }
      if (run.journey !== entry.id) {
        fail('journey_run_wrong_identity', `journey '${entry.id}' run report records a run of ${run.journey ? `'${run.journey}'` : 'no journey at all'} — one journey's run is not another journey's evidence`);
        continue;
      }
      if (run.runtime_version !== manifest.runtime_version) {
        fail('journey_run_wrong_vintage', `journey '${entry.id}' run report was produced at role runtime ${run.runtime_version != null ? `v${run.runtime_version}` : 'no version at all'}, the manifest certifies v${manifest.runtime_version} — evidence must not outlive the runtime it certifies`);
        continue;
      }
      if (run.gate !== 'PASS') fail('journey_gate_red', `journey '${entry.id}' gate is ${run.gate ?? 'absent'}`);
    }
  });

  check('leash_tests', ({ fail, missing }) => {
    // The leash RUN REPORT is the evidence, not the rows derived from it
    // (2026-08-16, the tenth ask). The gather has always required the report
    // by kind (#1678) and vintage (#1694) but kept only its derived
    // green-per-file rows, so the record layer's re-derivation (#1705) read
    // rows a fabricated artifact could hand-author, with no report to ask
    // anything of — the journey hole (#1706), one requirement over. Green is
    // read FROM the report now, and the report answers for its kind and
    // vintage here in the arithmetic — refutation class, like the journey
    // laws above. The derived rows still carry existence (a tree fact).
    const report = evidence.leash_test_run;
    if (report != null && report.artifact !== ROLE_LEASH_TEST_RUN_ARTIFACT) {
      fail('leash_run_wrong_kind', `the leash test-run report declares ${report.artifact ? `'${report.artifact}'` : 'no artifact kind'}, not ${ROLE_LEASH_TEST_RUN_ARTIFACT} — a claim is not a run`);
    } else if (report != null && report.runtime_version !== manifest.runtime_version) {
      fail('leash_run_wrong_vintage', `the leash test-run report was produced at role runtime ${report.runtime_version != null ? `v${report.runtime_version}` : 'no version at all'}, the manifest certifies v${manifest.runtime_version} — evidence must not outlive the runtime it certifies`);
    }
    const reportValid = report != null
      && report.artifact === ROLE_LEASH_TEST_RUN_ARTIFACT
      && report.runtime_version === manifest.runtime_version;
    for (const relPath of manifest.required_leash_tests) {
      const row = evidence.leash_tests?.[relPath];
      if (!row) { missing('leash_test_evidence_missing', `no evidence supplied for '${relPath}'`); continue; }
      if (row.exists !== true) { fail('leash_test_file_missing', `'${relPath}' does not exist in the tree`); continue; }
      if (!reportValid || report.files?.[relPath]?.green !== true) {
        missing('leash_test_run_missing', `no green test-run evidence for '${relPath}'`);
      }
    }
  });

  check('wiring_coverage', ({ fail, missing }) => {
    if (!evidence.wiring || !Array.isArray(evidence.wiring.gaps)) {
      missing('wiring_evidence_missing', 'no surface inventory evidence — the role has no audited autonomous surface');
      return;
    }
    if (evidence.wiring.gaps.length > manifest.required_wiring_coverage.max_gaps) {
      fail('wiring_gaps', `${evidence.wiring.gaps.length} uncovered surface operation(s): ${evidence.wiring.gaps.map((g) => g.operation).join('; ')}`);
    }
  });

  check('observation_evidence', ({ fail, missing }) => {
    const need = manifest.required_observation_evidence;
    const obs = evidence.observation;
    if (!obs) { missing('observation_missing', 'no observation evidence gathered'); return; }
    if (!obs.table_present) missing('receipts_table_absent', 'outbound_action_receipts is absent — migration 091 has not run here');
    else {
      if (obs.role_receipts < need.min_role_receipts) {
        missing('insufficient_role_receipts', `${obs.role_receipts} role-leash-passed send receipts < min ${need.min_role_receipts}`);
      }
      if ((obs.window_days || 0) < need.min_window_days) {
        missing('observation_window_too_short', `${Math.round((obs.window_days || 0) * 10) / 10} days < min ${need.min_window_days}`);
      }
    }
    if ((obs.would_blocks || 0) > need.max_would_blocks) {
      fail('would_blocks_observed', `${obs.would_blocks} specialist_role.would_block receipt(s) — the leash claim is refuted, not thin`);
    }
  });

  check('runtime_version', ({ fail, missing }) => {
    if (evidence.runtime_version == null) { missing('runtime_version_missing', 'no runtime version in the evidence'); return; }
    if (evidence.runtime_version !== manifest.runtime_version) {
      fail('runtime_version_mismatch', `evidence gathered at runtime v${evidence.runtime_version}, manifest certifies v${manifest.runtime_version} — re-issue the manifest against the current runtime`);
    }
  });

  return {
    verdict: reasons.length ? 'red' : 'green',
    insufficient_data: insufficient.length > 0,
    reasons,
    requirements
  };
};

// ── The written verdict artifact (buildPromotionVerdict's sibling) ──────────
export const buildRoleCertificationVerdict = ({
  manifest,
  evidence = {},
  gate,
  producedAt = new Date()
} = {}) => ({
  artifact: ROLE_CERTIFICATION_VERDICT_ARTIFACT,
  produced_at: new Date(producedAt).toISOString(),
  manifest: {
    role: manifest?.role ?? null,
    jurisdiction: manifest?.jurisdiction ?? null,
    version: manifest?.version ?? null,
    runtime_version: manifest?.runtime_version ?? null
  },
  gate,
  numbers: {
    lane_gates: evidence.lane_gates ?? null, // gap tables carry the receipt-grade model ids
    eaw_reports: evidence.eaw_reports ?? null,
    journey_runs: evidence.journey_runs ?? null,
    leash_tests: evidence.leash_tests ?? null,
    // The report the leash rows were derived from (the offline preview always
    // embedded its copy) — the record layer's re-derivation asks it for kind,
    // vintage, and per-file green.
    leash_test_run: evidence.leash_test_run ?? null,
    wiring: evidence.wiring ?? null,
    observation: evidence.observation ?? null, // models from outbound_action_receipts.model
    runtime_version: evidence.runtime_version ?? null
  },
  claim: {
    happens_here: false,
    mechanism: 'a dated commit sets the role\'s `certification` record in roles/roleRegistry.js (shape law: validateCertificationRecord) with this signed verdict attached; certificationClaimForRole then reads autonomous',
    note: 'A green gate makes this artifact SIGNABLE; the Autonomous claim is a separate, dated, human-signed change. Nothing auto-certifies.'
  },
  signature: {
    signed_by: null,
    signed_at: null,
    decision: null,
    note: `Kari signs a role certification (decided 2026-08-16, design §10.8): commit this artifact to ${ROLE_CERTIFICATION_ARTIFACT_HOME} and set the signed record in roleRegistry.js referencing it by repo path. Unsigned means unactionable.`
  }
});

// ── The offline preview artifact (never the verdict) ────────────────────────
// Built ONLY from offline-gathered evidence: the DB-gathered requirements were
// not evaluated, so the artifact says so by kind and by name instead of
// carrying nulls a reader must decode. A preview can never read green (the
// observation requirement is unsatisfiable offline), can never be signed
// (there is no signature block to fill), and can never back an Autonomous
// claim (validateCertificationRecord requires a green verdict).
export const buildRoleCertificationOfflinePreview = ({
  manifest,
  evidence = {},
  gate,
  leashTestRunReport = null, // the full run report, so the preview is self-contained
  producedAt = new Date()
} = {}) => {
  if (evidence.offline !== true) {
    throw new Error('the offline preview is built from OFFLINE-gathered evidence only — full evidence belongs in the signable verdict artifact (buildRoleCertificationVerdict)');
  }
  if (!gate || typeof gate !== 'object') {
    throw new Error('buildRoleCertificationOfflinePreview requires the evaluated gate');
  }
  if (gate.verdict === 'green') {
    // Unreachable when the evidence really was gathered offline — observation
    // lives in the DB, so the conjunction cannot close. Reaching this means
    // fabricated evidence, which must crash, not publish.
    throw new Error('an offline preview can never read green — the DB-gathered requirements were not evaluated; this gate was fed fabricated evidence');
  }
  return {
    artifact: ROLE_CERTIFICATION_OFFLINE_PREVIEW_ARTIFACT,
    produced_at: new Date(producedAt).toISOString(),
    manifest: {
      role: manifest?.role ?? null,
      jurisdiction: manifest?.jurisdiction ?? null,
      version: manifest?.version ?? null,
      runtime_version: manifest?.runtime_version ?? null
    },
    gate,
    numbers: {
      lane_gates: null, // not gathered — see preview.not_gathered
      eaw_reports: evidence.eaw_reports ?? null,
      journey_runs: evidence.journey_runs ?? null,
      leash_tests: evidence.leash_tests ?? null,
      leash_test_run: leashTestRunReport,
      wiring: evidence.wiring ?? null,
      observation: null, // not gathered — see preview.not_gathered
      runtime_version: evidence.runtime_version ?? null
    },
    preview: {
      signable: false,
      not_gathered: [...DB_GATHERED_REQUIREMENTS],
      note: 'Offline preview: the DB-gathered requirements (lane gap tables, observation receipts) were NOT evaluated and read red with insufficient_data. The signable verdict is scripts/run_role_certification.js with the DB. Nothing here certifies a role.'
    }
  };
};

// ── The claim ladder (INV-S9, fail-closed) ──────────────────────────────────
// A role's `certification` field in the registry is either null (no claim —
// 'preview') or the signed certification RECORD a dated commit set:
//   { manifest: { role, jurisdiction, version },
//     verdict: 'green', verdict_artifact: 'data/certifications/<file>.json',
//     runtime_version: CURRENT_ROLE_RUNTIME_VERSION,
//     signed_by: 'kari', signed_at: '<ISO date>' }
// Deep validation lives HERE (not in validateRoleRegistry) so the registry
// stays a pure leaf; roleCertification.test.js pins that every registry role's
// record validates — a malformed record fails CI, and at read time it still
// only ever reads 'preview'.
//
// The runtime_version field (2026-08-16) is the vintage law's LAST layer. The
// gather's vintage refusal binds supplied EVIDENCE to the runtime; this binds
// the signed CLAIM: the record states the runtime its verdict was gathered
// at, and the moment CURRENT_ROLE_RUNTIME_VERSION moves past it, the
// fail-closed ladder reads 'preview' again — automatically, with no curation
// step to forget. Without it a signed record was the one place a stale
// certification could still rest: the gate re-reds on a bump, but the CLAIM
// never re-checked, so an old record kept reading 'autonomous' against a
// runtime it never certified.
//
// THE CEREMONY (Kari's WHO-SIGNS call, 2026-08-16 — design §10.8): KARI signs,
// by name, as the product's accountable human — certification is fleet-wide
// product scope, and signing it is internal product work, never a human in a
// customer's loop. The signature rides a dated commit; the verdict artifact is
// COMMITTED to the tree (data/certifications/) and referenced by repo path,
// and validation READS it: the referenced file must BE the verdict the record
// claims — the right kind (never the offline preview: its distinct kind
// exists so a record cannot mistake a preview for a verdict, enforced here at
// last), a green gate, and the record's own manifest coordinates and runtime
// vintage. The ceremony's own TERMS bind too (2026-08-16, same day's seventh
// ask): the signer must BE the signer of record (ROLE_CERTIFICATION_SIGNERS),
// the reference must live under ROLE_CERTIFICATION_ARTIFACT_HOME and is
// refused UNREAD anywhere else, and signed_at must be a real ISO date. And
// the artifact's green gate is RE-DERIVED from its own numbers with the same
// pure arithmetic (the eighth ask, same day) — a verdict is its evidence's
// arithmetic, not a field.
// Fail-closed: any problem reads 'preview' downstream.
export const validateCertificationRecord = (roleId, record, { deps = {} } = {}) => {
  const problems = [];
  if (!record || typeof record !== 'object') return ['certification record must be an object'];
  const m = record.manifest;
  if (!m || typeof m !== 'object' || m.role !== roleId) {
    problems.push('record.manifest.role must equal the carrying role');
  } else if (!findCertificationManifest(m.role, m.jurisdiction, m.version)) {
    problems.push(`record references undeclared manifest ${m.role}/${m.jurisdiction}/v${m.version}`);
  }
  if (record.verdict !== 'green') problems.push('record.verdict must be the green gate verdict');
  if (!isNonEmptyString(record.verdict_artifact)) {
    problems.push('record must attach the verdict artifact reference');
  } else if (
    // The home law (2026-08-16, the ceremony's own terms): the reference must
    // live under data/certifications/ and is judged BEFORE it is dereferenced.
    // Reading first and refusing after would make the validator open arbitrary
    // paths on the strength of an unvalidated record — a '../' hop escaping
    // the tree, an absolute path, or a loose in-tree file is refused UNREAD.
    record.verdict_artifact.startsWith('/')
    || record.verdict_artifact.includes('\\')
    || record.verdict_artifact.split('/').some((seg) => seg === '..' || seg === '.')
    || !record.verdict_artifact.startsWith(ROLE_CERTIFICATION_ARTIFACT_HOME)
  ) {
    problems.push(`record's verdict artifact '${record.verdict_artifact}' is not committed under ${ROLE_CERTIFICATION_ARTIFACT_HOME} — the ceremony commits the signed verdict there and references it by repo path (design §10.8); the reference was refused unread`);
  } else {
    const readArtifact = deps.readArtifact || ((relPath) => {
      const abs = join(REPO_ROOT, relPath);
      if (!existsSync(abs)) return null;
      return JSON.parse(readFileSync(abs, 'utf8'));
    });
    let artifact = null;
    try {
      artifact = readArtifact(record.verdict_artifact);
    } catch (error) {
      problems.push(`record's verdict artifact '${record.verdict_artifact}' is unreadable: ${error?.message || error}`);
      artifact = undefined; // distinct from null: unreadable, already reported
    }
    if (artifact === null) {
      problems.push(`record's verdict artifact '${record.verdict_artifact}' does not exist in the tree — a signed verdict is committed evidence (data/certifications/), not a loose file`);
    } else if (artifact !== undefined) {
      if (artifact?.artifact !== ROLE_CERTIFICATION_VERDICT_ARTIFACT) {
        problems.push(`record's verdict artifact declares ${
          artifact?.artifact ? `'${artifact.artifact}'` : 'no artifact kind'
        }, not ${ROLE_CERTIFICATION_VERDICT_ARTIFACT} — an offline preview or any other artifact can never back an Autonomous claim`);
      }
      if (artifact?.gate?.verdict !== 'green') {
        problems.push(`record's verdict artifact carries gate '${artifact?.gate?.verdict ?? 'absent'}' — only a green gate is signable`);
      }
      const am = artifact?.manifest || {};
      if (m && typeof m === 'object'
        && (am.role !== m.role || am.jurisdiction !== m.jurisdiction || am.version !== m.version)) {
        problems.push(`record's verdict artifact certifies ${am.role}/${am.jurisdiction}/v${am.version}, the record claims ${m.role}/${m.jurisdiction}/v${m.version}`);
      }
      if (am.runtime_version !== record.runtime_version) {
        problems.push(`record's verdict artifact was issued at runtime v${am.runtime_version ?? '?'} but the record states v${record.runtime_version} — the signature must bind the vintage the verdict actually certified`);
      }
      // The verdict is its evidence's ARITHMETIC, not a field (2026-08-16,
      // the eighth ask): gate.verdict was taken at the artifact's word, so a
      // committed file wearing the verdict kind with `gate: green` over
      // evidence that evaluates red — or over no evidence at all — validated
      // and read autonomous. The gate arithmetic is pure and lives in this
      // module, so the record layer re-runs it over the artifact's own
      // numbers: a mismatch is a lie wearing the kind. (Deep fabrication of
      // a whole consistent evidence bundle is what the human signature is
      // for; this makes the casual lie impossible and the deliberate one
      // elaborate.) Only audited when the artifact claims green — a red gate
      // is already refused as unsignable above.
      const declared = m && typeof m === 'object'
        ? findCertificationManifest(m.role, m.jurisdiction, m.version)
        : null;
      if (artifact?.gate?.verdict === 'green' && declared) {
        const rederived = evaluateRoleCertification({ manifest: declared, evidence: artifact.numbers ?? {} });
        if (rederived.verdict !== 'green') {
          problems.push(`record's verdict artifact claims a green gate but its own evidence re-evaluates ${rederived.verdict}${rederived.insufficient_data ? ' (insufficient data)' : ''} — a verdict is its evidence's arithmetic, not a field; re-produce it with scripts/run_role_certification.js`);
        }
      }
    }
  }
  if (record.runtime_version !== CURRENT_ROLE_RUNTIME_VERSION) {
    problems.push(record.runtime_version == null
      ? 'record must state the runtime vintage it certifies (runtime_version)'
      : `record certifies runtime v${record.runtime_version} but the runtime is v${CURRENT_ROLE_RUNTIME_VERSION} — a certification must not outlive the runtime it certified; re-gather, re-evaluate, re-sign`);
  }
  if (!isNonEmptyString(record.signed_by) || !isNonEmptyString(record.signed_at)) {
    problems.push('record must be signed (signed_by + signed_at) — unsigned means unactionable');
  } else {
    // The WHO-SIGNS decision as arithmetic (2026-08-16): 'kari' in the shape
    // law's example was documentation, not enforcement — any non-empty string
    // signed, which is auto-sign's door left ajar. And "a dated commit" needs
    // an actual date: signed_at must say WHEN the ceremony happened.
    if (!ROLE_CERTIFICATION_SIGNERS.includes(record.signed_by)) {
      problems.push(`record is signed by '${record.signed_by}', who is not a signer of record — Kari signs a role certification, by name (WHO-SIGNS, 2026-08-16, design §10.8); auto-sign and every other signer were argued and rejected, and a new name is a new dated decision, not a validator bypass`);
    }
    if (!/^\d{4}-\d{2}-\d{2}/.test(record.signed_at) || Number.isNaN(Date.parse(record.signed_at))) {
      problems.push(`record's signed_at '${record.signed_at}' is not an ISO date — the ceremony is a DATED commit; a signature that cannot say when it happened is not dated`);
    }
  }
  return problems;
};

export const certificationClaimForRole = (role, options = {}) => {
  if (!role?.certification) return 'preview';
  return validateCertificationRecord(role.id, role.certification, options).length ? 'preview' : 'autonomous';
};

// The roster's compressed view: the claim, which manifests exist for the role
// (so the card can say what a claim WOULD be measured against), and the
// signed record when one exists.
export const certificationSummaryForRole = (role, options = {}) => ({
  claim: certificationClaimForRole(role, options),
  manifests: manifestsForRole(role?.id || '').map(({ jurisdiction, version }) => ({ jurisdiction, version })),
  record: role?.certification ?? null
});
