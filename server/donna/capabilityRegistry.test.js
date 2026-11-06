// Contract + lint tests for the capability registry (BizOS Slice 1a).
//
// Two jobs, mirroring accountingMutationRegistry.test.js + the hardening plan's Slice-B
// compatibility proof:
//   1. The finance.*.v1 retrofit is a LOSSLESS derivation of ACCOUNTING_MUTATION_REGISTRY —
//      exact bijection, per-dimension field equality, INV-1 writers, capability-class
//      equality against operatorCapability, and surface-map equality against the LIVE
//      per-surface allowlists in both directions.
//   2. The lint half: the legacy-gap manifest is CLOSED (pinned to the 16 retrofit verbs by
//      name; membership and per-member gap lists asserted against computed reality both
//      ways) and the validator refuses a new write capability shipping with any unsafe gap.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPABILITY_REGISTRY,
  CAPABILITY_ID_PATTERN,
  CAPABILITY_ACCESS,
  SIDE_EFFECT_CLASSES,
  SIDE_EFFECT_RISK_FLOORS,
  RISK_CLASSES,
  SCHEMA_STATUSES,
  DRY_RUN_STATES,
  IDEMPOTENCY_KINDS,
  GRANT_REQUIREMENTS,
  LEGACY_GAP_KINDS,
  LEGACY_CAPABILITY_GAP_MANIFEST,
  financeCapabilityPack,
  buildCapabilityRegistry,
  validateCapabilityEntry,
  findCapability,
  isRegisteredCapability,
  capabilityCoverageGaps,
  canonicalCapabilityRegistrySnapshot,
  capabilityRegistryFingerprint
} from './capabilityRegistry.js';

import {
  ACCOUNTING_MUTATION_REGISTRY,
  KNOWN_WRITERS,
  AUTONOMY_CLASSES,
  PRESENCE_STATES,
  RECEIPT_STATES,
  REVERSIBILITY_CLASSES
} from './accountingMutationRegistry.js';
import { requiredCapabilityForAction, CAPABILITY_CLASSES } from './operatorCapability.js';

import { FEED_CHAT_ALL_APPLIABLE_ACTION_TYPES } from './feedChat.js';
import { TRANSACTION_CHAT_ALL_APPLIABLE_ACTION_TYPES } from './transactionChat.js';
import { CLIENT_PORTAL_CHAT_APPLIABLE_ACTION_TYPES } from './clientPortalChat.js';
import { DOCUMENT_CHAT_APPLIABLE_ACTION_TYPES } from './documentChat.js';
import { INVENTORY_EXECUTOR_APPLIABLE_VERBS } from './inventory/postingLog.js';

const uniq = (xs) => [...new Set(xs)];
const financePack = financeCapabilityPack();

// A well-formed NEW (non-legacy) write capability — the fixture the lint tests mutate.
const validNewCapability = () => ({
  capability: 'communications.send_email.v1',
  domain: 'communications',
  verb: 'send_email',
  version: 1,
  input_schema: { type: 'object', additionalProperties: false, properties: {} },
  output_schema: { type: 'object', additionalProperties: false, properties: {} },
  schema_status: 'declared',
  access: 'write',
  side_effect_class: 'external_comms',
  risk_class: 'medium',
  reversibility: 'irreversible_external',
  dry_run: 'supported',
  idempotency: 'caller_key',
  authority_requirements: {
    autonomy_class: 'owner_ask',
    required_capability_class: 'founder',
    grant_required: 'scoped_grant'
  },
  legacy_entrypoint_bindings: { surfaces: [] },
  executor: 'sendCommunicationsEmail',
  execution_verifier: 'verifyProviderAcceptance',
  audit_record: 'yes',
  execution_receipt: 'live',
  preflight: 'live',
  preflight_alternative: null,
  eval_scenarios: ['send_email_basic']
});

// ── Retrofit compatibility (the §4 proof) ────────────────────────────────────────

test('exact bijection: registry verbs ↔ finance.*.v1 capabilities, both directions', () => {
  const registryVerbs = ACCOUNTING_MUTATION_REGISTRY.map((e) => e.verb);
  const packVerbs = financePack.map((e) => e.verb);
  assert.deepEqual([...packVerbs].sort(), [...registryVerbs].sort());
  assert.equal(financePack.length, uniq(financePack.map((e) => e.capability)).length, 'duplicate capability id');
  for (const entry of financePack) {
    assert.equal(entry.capability, `finance.${entry.verb}.v1`);
    assert.equal(entry.domain, 'finance');
    assert.equal(entry.version, 1);
  }
});

test('lossless derivation: every shared field equals its registry row, dimension for dimension', () => {
  for (const row of ACCOUNTING_MUTATION_REGISTRY) {
    const cap = findCapability(`finance.${row.verb}.v1`);
    assert.ok(cap, `no capability for registry verb "${row.verb}"`);
    assert.equal(cap.executor, row.writer, `${row.verb}: executor`);
    assert.equal(cap.reversibility, row.reversibility, `${row.verb}: reversibility`);
    assert.equal(cap.authority_requirements.autonomy_class, row.autonomyClass, `${row.verb}: autonomy_class`);
    // The three coverage dimensions map 1:1 — never collapsed into one lossy field.
    assert.equal(cap.audit_record, row.emitsAudit, `${row.verb}: audit_record`);
    assert.equal(cap.execution_receipt, row.emitsApplyReceipt, `${row.verb}: execution_receipt`);
    assert.equal(cap.preflight, row.preflightToday, `${row.verb}: preflight`);
    // Entry-point exposure is metadata, not authority.
    assert.deepEqual(cap.legacy_entrypoint_bindings.surfaces, row.surfaces, `${row.verb}: surfaces`);
    assert.ok(!('surfaces' in cap.authority_requirements), `${row.verb}: surfaces leaked into authority`);
  }
});

test('every executor is a known existing writer (INV-1, no second backend)', () => {
  for (const cap of financePack) {
    assert.ok(KNOWN_WRITERS.includes(cap.executor), `${cap.capability}: executor "${cap.executor}"`);
  }
});

test('required_capability_class is derived from operatorCapability, never hand-copied', () => {
  for (const cap of financePack) {
    assert.equal(
      cap.authority_requirements.required_capability_class,
      requiredCapabilityForAction(cap.verb),
      `${cap.capability}: capability class drifted from operatorCapability`
    );
  }
});

test('surface map ↔ the live per-surface allowlists, both directions', () => {
  const liveAllowlists = {
    feed_chat: FEED_CHAT_ALL_APPLIABLE_ACTION_TYPES,
    transaction_chat: TRANSACTION_CHAT_ALL_APPLIABLE_ACTION_TYPES,
    document_chat: DOCUMENT_CHAT_APPLIABLE_ACTION_TYPES,
    client_chat: CLIENT_PORTAL_CHAT_APPLIABLE_ACTION_TYPES,
    inventory_executor: INVENTORY_EXECUTOR_APPLIABLE_VERBS
  };
  // Registry → allowlist: every declared binding exists live. 'drawer' is an entry point
  // that rides the chat allowlists (no allowlist export of its own) — only the five spine
  // surfaces are asserted, and no OTHER unknown surface may appear.
  for (const cap of financePack) {
    for (const surface of cap.legacy_entrypoint_bindings.surfaces) {
      if (surface === 'drawer') continue;
      const live = liveAllowlists[surface];
      assert.ok(live, `${cap.capability}: unknown surface "${surface}"`);
      assert.ok(live.includes(cap.verb), `${cap.capability}: not in the live ${surface} allowlist`);
    }
  }
  // Allowlist → registry: every live appliable verb is bound to that surface.
  for (const [surface, verbs] of Object.entries(liveAllowlists)) {
    for (const verb of verbs) {
      const cap = findCapability(`finance.${verb}.v1`);
      assert.ok(cap, `live ${surface} verb "${verb}" has no capability`);
      assert.ok(
        cap.legacy_entrypoint_bindings.surfaces.includes(surface),
        `finance.${verb}.v1 misses its live ${surface} binding`
      );
    }
  }
});

// ── Contract validity of the assembled registry ──────────────────────────────────

test('every registered capability passes the full contract', () => {
  for (const cap of CAPABILITY_REGISTRY) {
    assert.deepEqual(validateCapabilityEntry(cap), [], `${cap.capability} fails its own contract`);
    assert.match(cap.capability, CAPABILITY_ID_PATTERN);
    assert.ok(CAPABILITY_ACCESS.includes(cap.access));
    assert.ok(SIDE_EFFECT_CLASSES.includes(cap.side_effect_class));
    assert.ok(RISK_CLASSES.includes(cap.risk_class));
    assert.ok(SCHEMA_STATUSES.includes(cap.schema_status));
    assert.ok(DRY_RUN_STATES.includes(cap.dry_run));
    assert.ok(IDEMPOTENCY_KINDS.includes(cap.idempotency));
    assert.ok(GRANT_REQUIREMENTS.includes(cap.authority_requirements.grant_required));
    assert.ok(AUTONOMY_CLASSES.includes(cap.authority_requirements.autonomy_class));
    assert.ok(CAPABILITY_CLASSES.includes(cap.authority_requirements.required_capability_class));
    assert.ok(PRESENCE_STATES.includes(cap.audit_record));
    assert.ok(RECEIPT_STATES.includes(cap.execution_receipt));
    assert.ok(RECEIPT_STATES.includes(cap.preflight));
    assert.ok(cap.reversibility === null || REVERSIBILITY_CLASSES.includes(cap.reversibility));
    assert.ok(Object.isFrozen(cap), `${cap.capability} is not frozen`);
  }
});

test('risk classes respect the explicit side-effect floor map', () => {
  for (const cap of CAPABILITY_REGISTRY) {
    const floor = SIDE_EFFECT_RISK_FLOORS[cap.side_effect_class];
    assert.ok(
      RISK_CLASSES.indexOf(cap.risk_class) >= RISK_CLASSES.indexOf(floor),
      `${cap.capability}: risk "${cap.risk_class}" below floor "${floor}"`
    );
  }
});

// ── The closed legacy-gap manifest (the lint half) ───────────────────────────────

test('the manifest is pinned to retrofit capabilities with legacy gaps only', () => {
  const manifestIds = Object.keys(LEGACY_CAPABILITY_GAP_MANIFEST);
  const packIds = financePack.map((e) => e.capability);
  assert.ok(manifestIds.every((id) => packIds.includes(id)));
  assert.ok(!manifestIds.includes('finance.record_mileage.v1'));
  assert.equal(manifestIds.length, 16);
  for (const gaps of Object.values(LEGACY_CAPABILITY_GAP_MANIFEST)) {
    for (const gap of gaps) assert.ok(LEGACY_GAP_KINDS.includes(gap), `unknown gap kind "${gap}"`);
  }
});

test('manifest ↔ computed reality, both directions (a claimed gap must exist; an actual gap must be claimed)', () => {
  const actual = Object.fromEntries(capabilityCoverageGaps().map((g) => [g.capability, g.gaps]));
  for (const [id, claimed] of Object.entries(LEGACY_CAPABILITY_GAP_MANIFEST)) {
    assert.deepEqual(
      [...(actual[id] || [])].sort(),
      [...claimed].sort(),
      `${id}: manifest and computed gaps disagree`
    );
  }
  for (const id of Object.keys(actual)) {
    assert.ok(id in LEGACY_CAPABILITY_GAP_MANIFEST, `${id} has gaps but no manifest entry`);
  }
});

test('verified ledger verbs declare their idempotency/dry-run posture; the rest declare nothing', () => {
  for (const cap of financePack) {
    if (cap.verb === 'sync_to_accounting' || cap.verb === 'post_inventory_journal') {
      assert.equal(cap.dry_run, 'supported', cap.capability);
      assert.equal(cap.idempotency, 'natural_key', cap.capability);
      assert.equal(cap.side_effect_class, 'external_ledger', cap.capability);
      assert.equal(cap.risk_class, 'high', cap.capability);
    } else if (cap.verb === 'record_mileage') {
      assert.equal(cap.dry_run, 'unsupported', cap.capability);
      assert.equal(cap.idempotency, 'natural_key', cap.capability);
      assert.equal(cap.preflight_alternative.includes('balanced journal'), true);
    } else if (cap.verb === 'draft_evidence_request' || cap.verb === 'mark_immaterial') {
      // G1(a) (godmode build-spec PR-8): registered past the CLOSED manifest,
      // so their guarantees are declared and verified — the evidence writer's
      // F-19 id-determinism, the immaterial verdict's per-document overwrite.
      assert.equal(cap.dry_run, 'unsupported', cap.capability);
      assert.equal(cap.idempotency, 'natural_key', cap.capability);
      assert.equal(cap.schema_status, 'declared', cap.capability);
      assert.ok(cap.execution_verifier, cap.capability);
      assert.ok(cap.eval_scenarios.length > 0, cap.capability);
    } else if (cap.verb === 'forget_fact' || cap.verb === 'retire_rule') {
      // G1(c-early) (godmode build-spec PR-10): registered past the CLOSED
      // manifest — guarantees declared and verified: the deterministic
      // fact/rule id is the natural key, the writers flip status only from a
      // verified prior state (active-only dismiss; status-locked retire), so
      // a replay reports a skip / 409 rather than a second mutation.
      assert.equal(cap.dry_run, 'unsupported', cap.capability);
      assert.equal(cap.idempotency, 'natural_key', cap.capability);
      assert.equal(cap.schema_status, 'declared', cap.capability);
      assert.equal(cap.side_effect_class, 'governed_memory', cap.capability);
      assert.ok(cap.execution_verifier, cap.capability);
      assert.ok(cap.eval_scenarios.length > 0, cap.capability);
    } else if (cap.verb === 'cancel_ask' || cap.verb === 'resend_ask' || cap.verb === 'amend_ask') {
      // amend_ask joined on §7.2's dated call (2026-08-14): the writer
      // amends only OPEN asks under the row lock, preserves the original
      // question in the composite + the structured amendments history, and
      // the amendment cap bounds even a replay loop to a reported skip.
      // G1(b) (godmode build-spec PR-9): registered past the CLOSED manifest —
      // guarantees declared and verified. cancel_ask's natural key is the ask
      // id and its writer flips status only from draft/open under a row lock.
      // resend_ask is the interesting one: an outbound message is not
      // idempotent for free, and the closed manifest REFUSED the gap, so the
      // writer earns the guarantee — a resend whose ask genuinely reached the
      // owner inside RESEND_MIN_INTERVAL_MS is refused and reported as a skip,
      // making the natural key (ask id, last successful send).
      assert.equal(cap.dry_run, 'unsupported', cap.capability);
      assert.equal(cap.idempotency, 'natural_key', cap.capability);
      assert.equal(cap.schema_status, 'declared', cap.capability);
      assert.equal(cap.side_effect_class, 'client_visible', cap.capability);
      assert.ok(cap.execution_verifier, cap.capability);
      assert.ok(cap.eval_scenarios.length > 0, cap.capability);
    } else if (cap.verb === 'approve_role_grant' || cap.verb === 'revoke_role_grant') {
      // Team-screen recede (2026-08-14): the standing-authority pair,
      // registered past the CLOSED manifest — guarantees declared and
      // verified. The grant id derives from (firm, client, domain, action,
      // scope) with on-conflict-update, and a re-revoke reports skipped
      // through the same id — the natural key is the grant id. risk high +
      // no dry-run ⇒ the named preflight alternative is the roleEmployment
      // writer's own refusing transaction (owner actor, active hire, shape
      // offered, authority ⊆ leash, mandatory time bound).
      assert.equal(cap.dry_run, 'unsupported', cap.capability);
      assert.equal(cap.idempotency, 'natural_key', cap.capability);
      assert.equal(cap.schema_status, 'declared', cap.capability);
      assert.equal(cap.side_effect_class, 'internal_state', cap.capability);
      assert.equal(cap.risk_class, 'high', cap.capability);
      assert.ok(cap.preflight_alternative, cap.capability);
      assert.ok(cap.execution_verifier, cap.capability);
      assert.ok(cap.eval_scenarios.length > 0, cap.capability);
    } else if (cap.verb === 'correct_document_field' || cap.verb === 'answer_evidence_request') {
      // G2 idempotency sweep (build-spec-g2 PR-13): the two verbs that
      // genuinely have no natural key. correct_document_field appends to a
      // correction JOURNAL (random event id by design); answer_evidence_request
      // converges on the ask id but its post-commit reply-recode re-invokes the
      // coder on a replay. Each keeps 'none' WITH its recorded honest posture —
      // a bare 'none' is the sweep's refused state.
      assert.equal(cap.idempotency, 'none', cap.capability);
      assert.ok(
        typeof cap.idempotency_note === 'string' && cap.idempotency_note.trim().length > 0,
        `${cap.capability}: 'none' must carry its recorded replay posture`
      );
    } else {
      // PR-13: every remaining retrofit verb's guarantee was VERIFIED at its
      // writer (see the sweep comment on FINANCE_OVERLAY): review-item /
      // match / transaction / ask / rule / fact / document natural keys,
      // state-guarded requeues, edge-gated cascades, and the review-item-keyed
      // confirmation bump (__shouldBumpRuleConfirmation).
      assert.equal(
        cap.idempotency, 'natural_key',
        `${cap.capability}: PR-13 verified this writer's natural key — a regression to 'none' needs a new dated audit`
      );
    }
  }
});

test('no write capability rests on a BARE idempotency none — the recorded posture is mandatory (PR-13)', () => {
  for (const cap of CAPABILITY_REGISTRY) {
    if (cap.access !== 'write' || cap.idempotency !== 'none') continue;
    assert.ok(
      typeof cap.idempotency_note === 'string' && cap.idempotency_note.trim().length > 0,
      `${cap.capability}: idempotency 'none' with no recorded idempotency_note`
    );
  }
  // The validator refuses the bare state, so it can never rest silently.
  const bare = { ...validNewCapability(), idempotency: 'none' };
  const errors = validateCapabilityEntry(bare, {
    legacyManifest: { 'communications.send_email.v1': ['idempotency_none'] }
  });
  assert.ok(
    errors.some((e) => e.includes('idempotency_note')),
    `expected the bare-'none' refusal even when the gap itself is sanctioned, got: ${JSON.stringify(errors)}`
  );
  const noted = { ...bare, idempotency_note: 'replay-gated at spine; double-execution bounded: provider dedupes on message id' };
  assert.deepEqual(
    validateCapabilityEntry(noted, { legacyManifest: { 'communications.send_email.v1': ['idempotency_none'] } }),
    []
  );
});

// ── The validator refuses new unsafe gaps ────────────────────────────────────────

test('a NEW write capability cannot ship with any legacy gap', () => {
  const cases = [
    { patch: { schema_status: 'legacy_untyped', input_schema: null, output_schema: null }, gap: 'legacy_untyped' },
    { patch: { idempotency: 'none' }, gap: 'idempotency_none' },
    { patch: { execution_verifier: null }, gap: 'execution_verifier_missing' },
    { patch: { execution_receipt: 'none' }, gap: 'execution_receipt_none' },
    { patch: { eval_scenarios: [] }, gap: 'eval_scenarios_empty' }
  ];
  for (const { patch, gap } of cases) {
    const errors = validateCapabilityEntry({ ...validNewCapability(), ...patch });
    assert.ok(
      errors.some((e) => e.includes(gap)),
      `expected refusal for unsanctioned gap "${gap}", got: ${JSON.stringify(errors)}`
    );
  }
  // The clean fixture itself passes — the refusals above are the patches, not the base.
  assert.deepEqual(validateCapabilityEntry(validNewCapability()), []);
});

test('adding a NEW capability to the manifest is the refused path (the manifest only shrinks)', () => {
  // Sanctioning the same gaps via a widened manifest makes the entry validate — which is
  // exactly why manifest MEMBERSHIP is pinned by the 16-name test above: this test documents
  // the mechanism, that test closes the door.
  const widened = { ...LEGACY_CAPABILITY_GAP_MANIFEST, 'communications.send_email.v1': ['idempotency_none'] };
  // PR-13: sanctioning the GAP no longer suffices on its own — 'none' must also
  // carry its recorded posture, so the fixture records one.
  const entry = {
    ...validNewCapability(),
    idempotency: 'none',
    idempotency_note: 'replay-gated at spine; double-execution bounded: provider dedupes on message id'
  };
  assert.ok(validateCapabilityEntry(entry).length > 0);
  assert.deepEqual(validateCapabilityEntry(entry, { legacyManifest: widened }), []);
});

test('high-impact without dry-run requires a named preflight alternative', () => {
  const entry = { ...validNewCapability(), risk_class: 'high', dry_run: 'unsupported', preflight_alternative: null };
  assert.ok(validateCapabilityEntry(entry).some((e) => e.includes('preflight/consequence-diff alternative')));
  const named = { ...entry, preflight_alternative: 'runDeterministicPreflight' };
  assert.deepEqual(validateCapabilityEntry(named), []);
});

test('grammar, recomposition, floor, and surfaces-in-authority violations are refused', () => {
  assert.ok(validateCapabilityEntry({ ...validNewCapability(), capability: 'SendEmail.v1' }).length > 0);
  assert.ok(validateCapabilityEntry({ ...validNewCapability(), version: 2 })
    .some((e) => e.includes('recompose')));
  assert.ok(validateCapabilityEntry({ ...validNewCapability(), side_effect_class: 'external_payment' })
    .some((e) => e.includes('floor')));
  const authLeak = validateCapabilityEntry({
    ...validNewCapability(),
    authority_requirements: { ...validNewCapability().authority_requirements, surfaces: ['feed_chat'] }
  });
  assert.ok(authLeak.some((e) => e.includes('NOT authority')));
});

test('buildCapabilityRegistry throws on an invalid or duplicate entry', () => {
  assert.throws(
    () => buildCapabilityRegistry([[{ ...validNewCapability(), idempotency: 'none' }]]),
    /idempotency_none/
  );
  assert.throws(
    () => buildCapabilityRegistry([[validNewCapability(), validNewCapability()]]),
    /duplicate capability id/
  );
});

// ── Fingerprint + canonical snapshot ─────────────────────────────────────────────

test('the fingerprint is deterministic and key-order-independent; any row change moves it', () => {
  const fp1 = capabilityRegistryFingerprint();
  const fp2 = capabilityRegistryFingerprint(CAPABILITY_REGISTRY);
  assert.equal(fp1, fp2);
  assert.match(fp1, /^capreg-[0-9a-f]{64}$/);
  // Same content, scrambled key/array order → same fingerprint.
  const scrambled = [...CAPABILITY_REGISTRY].reverse().map((e) => {
    const out = {};
    for (const key of Object.keys(e).sort().reverse()) out[key] = e[key];
    return out;
  });
  assert.equal(capabilityRegistryFingerprint(scrambled), fp1);
  // One field changed → different fingerprint.
  const mutated = CAPABILITY_REGISTRY.map((e, i) => (i === 0 ? { ...e, risk_class: 'critical' } : e));
  assert.notEqual(capabilityRegistryFingerprint(mutated), fp1);
});

test('the canonical snapshot round-trips to the same fingerprint (history stays reproducible)', () => {
  const snapshot = canonicalCapabilityRegistrySnapshot();
  const rehydrated = JSON.parse(JSON.stringify(snapshot));
  assert.equal(capabilityRegistryFingerprint(rehydrated), capabilityRegistryFingerprint());
});

test('the committed snapshot build artifact matches the live registry (regenerate in the same commit)', async () => {
  // A receipt pins registry_fingerprint; the RETAINED snapshot is what makes that
  // fingerprint resolvable to the full registry (addendum §2). A registry change without
  // `node scripts/write_capability_registry_snapshot.js` fails here by design.
  const { readFileSync } = await import('node:fs');
  const artifact = JSON.parse(readFileSync(new URL('./capabilityRegistrySnapshot.json', import.meta.url), 'utf8'));
  assert.equal(artifact.fingerprint, capabilityRegistryFingerprint(),
    'capabilityRegistrySnapshot.json is stale — run scripts/write_capability_registry_snapshot.js in this commit');
  assert.equal(capabilityRegistryFingerprint(artifact.capabilities), artifact.fingerprint);
});

// ── Helpers ──────────────────────────────────────────────────────────────────────

test('lookup helpers resolve registered ids and reject unknown ones', () => {
  assert.equal(findCapability('finance.apply_category.v1')?.executor, 'updateTransactionReviewItemInDb');
  assert.equal(findCapability('finance.apply_category.v2'), null);
  assert.equal(isRegisteredCapability('finance.sync_to_accounting.v1'), true);
  assert.equal(isRegisteredCapability('communications.send_email.v1'), false);
});
