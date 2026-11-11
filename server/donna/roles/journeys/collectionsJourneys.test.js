// Journey tests for invoicing_collections (S6 `required_journey_tests`) plus
// the substrate's own laws. Two layers, deliberately:
//
//   1. THE JOURNEYS THEMSELVES run here so they cannot rot between
//      certification runs. A journey that only ever runs when someone
//      remembers to invoke the runner is not evidence of anything.
//   2. THE HARNESS IS TESTED TOO. A journey harness that silently returns
//      empty rows, or reports PASS with a failed check, would manufacture
//      exactly the false confidence certification exists to prevent — so the
//      fail-loud substrate and the gate arithmetic are pinned directly.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_JOURNEY_CLOCK,
  JOURNEY_DEFINITIONS,
  ROLE_JOURNEY_RUN_ARTIFACT,
  findJourneyDefinition,
  runAllJourneys,
  runJourney
} from './collectionsJourneys.js';
import { UnroutedSqlError, createJourneySubstrate } from './journeySubstrate.js';
import {
  CURRENT_ROLE_RUNTIME_VERSION,
  ROLE_CERTIFICATION_MANIFESTS,
  findCertificationManifest,
  gatherRoleCertificationEvidence
} from '../roleCertification.js';

// ── The manifest binding ────────────────────────────────────────────────────

test('every journey the R1 manifest requires has a definition here, and no orphans', () => {
  const required = ROLE_CERTIFICATION_MANIFESTS
    .flatMap((manifest) => manifest.required_journey_tests.map((entry) => entry.id))
    .sort();
  const defined = JOURNEY_DEFINITIONS.map((definition) => definition.id).sort();
  assert.deepEqual(defined, required,
    'a declared journey with no definition reads red forever; a definition no manifest requires is dead weight');
});

test('every definition names the role and jurisdiction it certifies', () => {
  for (const definition of JOURNEY_DEFINITIONS) {
    assert.equal(definition.role, 'invoicing_collections', definition.id);
    assert.equal(definition.jurisdiction, 'GB', definition.id);
    assert.equal(typeof definition.run, 'function', definition.id);
  }
});

test('an unknown journey id refuses rather than reporting a vacuous pass', async () => {
  await assert.rejects(() => runJourney('journey.not.a.thing'), /unknown journey/);
  assert.equal(findJourneyDefinition('journey.not.a.thing'), null);
});

test('the gate refuses a hand-authored journey report: only a real run report is evidence', async () => {
  const manifest = findCertificationManifest('invoicing_collections', 'GB', 1);
  const client = { query: async () => ({ rows: [] }) };
  const [first] = manifest.required_journey_tests;

  await assert.rejects(
    () => gatherRoleCertificationEvidence(client, {
      manifest,
      // The exact blob that satisfied this requirement until 2026-08-15 — a
      // human's word that the journey passed, no receipt of a run (the leash
      // refusal's law, applied one requirement over).
      journeyRuns: { [first.id]: { gate: 'PASS' } }
    }),
    /not a donna\.roleJourneyRun\.v1.*no artifact kind/s
  );

  await assert.rejects(
    () => gatherRoleCertificationEvidence(client, {
      manifest,
      journeyRuns: { [first.id]: { artifact: 'donna.roleLeashTestRun.v1', gate: 'PASS' } }
    }),
    /not a donna\.roleJourneyRun\.v1/
  );

  // The producer's own report is accepted and flows to the evidence verbatim.
  const report = await runJourney(first.id);
  const evidence = await gatherRoleCertificationEvidence(client, {
    manifest,
    journeyRuns: { [first.id]: report }
  });
  assert.equal(evidence.journey_runs[first.id].artifact, ROLE_JOURNEY_RUN_ARTIFACT);
  assert.equal(evidence.journey_runs[first.id].gate, 'PASS');
});

test('the gate refuses a real report supplied under a different journey\'s id: one run is not another\'s evidence', async () => {
  const manifest = findCertificationManifest('invoicing_collections', 'GB', 1);
  const client = { query: async () => ({ rows: [] }) };
  const [first, second] = manifest.required_journey_tests;

  // A REAL, kind-stamped, PASSing report — for the WRONG journey. The kind
  // refusal above tells a run from a lie; until 2026-08-16 nothing told one
  // run from another: `--journey <second>=<first's report>` keyed the evidence
  // map from the CLI and turned journey_tests green for a journey that never
  // ran.
  const report = await runJourney(first.id);
  assert.equal(report.gate, 'PASS');
  await assert.rejects(
    () => gatherRoleCertificationEvidence(client, {
      manifest,
      journeyRuns: { [second.id]: report }
    }),
    (error) => error.message.includes(`supplied for '${second.id}'`)
      && error.message.includes(`records a run of '${first.id}'`)
  );

  // A kind-stamped blob that records no journey at all is refused the same
  // way — the artifact kind alone is no longer enough to pass for a run.
  await assert.rejects(
    () => gatherRoleCertificationEvidence(client, {
      manifest,
      journeyRuns: { [first.id]: { artifact: ROLE_JOURNEY_RUN_ARTIFACT, gate: 'PASS' } }
    }),
    /records a run of no journey at all/
  );
});

test('the gate refuses a journey report stamped at a different runtime vintage', async () => {
  const manifest = findCertificationManifest('invoicing_collections', 'GB', 1);
  const client = { query: async () => ({ rows: [] }) };
  const [first] = manifest.required_journey_tests;

  // A REAL report, doctored only in vintage — the shape a stale report would
  // have after a CURRENT_ROLE_RUNTIME_VERSION bump. The producer stamps the
  // live constant on every report; until 2026-08-16 nothing asked, so a
  // re-gather at the new version would have quietly laundered old evidence
  // into a runtime it never certified.
  const report = await runJourney(first.id);
  assert.equal(report.runtime_version, CURRENT_ROLE_RUNTIME_VERSION);
  const stale = { ...report, runtime_version: CURRENT_ROLE_RUNTIME_VERSION + 1 };
  await assert.rejects(
    () => gatherRoleCertificationEvidence(client, {
      manifest,
      journeyRuns: { [first.id]: stale }
    }),
    new RegExp(`produced at role runtime v${CURRENT_ROLE_RUNTIME_VERSION + 1} and this gather runs at v${CURRENT_ROLE_RUNTIME_VERSION}.*run_role_journeys`, 's')
  );
});

// ── The runs ────────────────────────────────────────────────────────────────

test('journey: invoice to settlement passes end to end', async () => {
  const report = await runJourney('journey.collections.invoice-to-settlement.v1');
  assert.equal(report.gate, 'PASS', report.failures.join(' | '));
  assert.equal(report.artifact, ROLE_JOURNEY_RUN_ARTIFACT);
  assert.equal(report.role, 'invoicing_collections');
  assert.equal(report.jurisdiction, 'GB');

  // The seams the journey exists to cross, in order, read off what it wrote:
  // the pay link before the send, the AR leg with the send, the overdue sweep
  // opening the chase and resting the step-1 reminder on the owner, and
  // settlement withdrawing that reminder on its way to the case terminal.
  assert.deepEqual(report.evidence.audit_actions, [
    'outbound_payment_link.created',
    // The AR leg posts to the chart's own 1100 and 4000 rows: the mint finds
    // them by code, so nothing is minted and no mint receipt is written
    // (2026-11-10; until then each posting minted a second row for the code,
    // which this harness did not refuse, and receipted it).
    'ledger.post_sales_invoice',
    'outbound_action.executed',
    'invoice.issued',
    'receivable_case.opened',
    'outbound_action.minted',
    'role.handed_to_owner',
    'outbound_payment_link.settled',
    'outbound_action.cancelled',
    'role.resumed_from_owner',
    'receivable_case.settled'
  ], 'the full loop: link → send+books → detector opens the chase → settlement cancels it → terminal');
  assert.equal(report.evidence.emails_sent, 1);
  assert.deepEqual(report.evidence.outbound_action_statuses, [
    { action_type: 'issue_invoice', status: 'executed' },
    { action_type: 'send_receivable_reminder', status: 'cancelled' }
  ], 'the issue executed; the detector-minted chase cancelled when the money arrived — both DONE terminals');
  assert.equal(report.evidence.receivable_case_statuses[0].status, 'settled');
  assert.equal(report.evidence.receivable_case_statuses[0].reason, 'payment_link_settled');
  assert.equal(report.evidence.payment_link_statuses[0].status, 'settled');
  // The held reminder entered the owner's queue at mint and left it at
  // settlement — the S5 handoff pair, read off the loop inbox the run wrote.
  assert.deepEqual(report.evidence.loop_events, ['role.handed_to_owner', 'role.resumed_from_owner']);
  // The model-id-is-part-of-the-receipt rail: read from the receipts the run
  // produced, never from a code default. The cancel receipt carries the
  // deterministic gate id (the minted reminder never reached a model).
  assert.deepEqual(report.evidence.receipt_models, ['deterministic:gate', 'deterministic:pack:gb@v4']);
});

test('journey: cadence exhaustion rests the next step on the owner', async () => {
  const report = await runJourney('journey.collections.cadence-to-owner-escalation.v1');
  assert.equal(report.gate, 'PASS', report.failures.join(' | '));

  assert.deepEqual(report.evidence.audit_actions, [
    'outbound_action.executed',
    'outbound_action.cadence_exhausted',
    'role.handed_to_owner',
    'receivable_case.escalated'
  ], 'the final send, the exhausted cadence, the role handoff, and the case coming to rest on the owner');
  assert.deepEqual(report.evidence.loop_events, ['role.handed_to_owner']);
  assert.equal(report.evidence.receivable_case_statuses[0].status, 'escalated');
  assert.equal(report.evidence.receivable_case_statuses[0].reason, 'cadence_exhausted');
  // The manifest's own words: the commitment that rests on the owner.
  const handoff = report.steps.find((step) => step.step === 'handed_to_the_owner');
  const commitment = handoff.checks.find((check) => check.check === 'next_commitment_is_decide_collection_next_step');
  assert.equal(commitment.status, 'pass', JSON.stringify(commitment));
});

test('both journeys run together and are deterministic on a fixed clock', async () => {
  const first = await runAllJourneys();
  const second = await runAllJourneys({ now: DEFAULT_JOURNEY_CLOCK });
  for (const definition of JOURNEY_DEFINITIONS) {
    assert.equal(first[definition.id].gate, 'PASS');
    // Ids are random per run (uuid), so compare the shape that must not drift.
    assert.deepEqual(
      first[definition.id].evidence.audit_actions,
      second[definition.id].evidence.audit_actions,
      `${definition.id} must produce the same consequences on the same clock`
    );
    assert.equal(first[definition.id].produced_at, second[definition.id].produced_at);
  }
});

test('every journey asserts the two-terminal-states principle over its own rows', async () => {
  const reports = await runAllJourneys();
  for (const report of Object.values(reports)) {
    const terminal = report.steps.find((step) => step.step === 'terminal_state');
    assert.ok(terminal, `${report.journey} must end on a terminal_state step`);
    const names = terminal.checks.map((check) => check.check);
    assert.ok(names.includes('two_terminal_states_outbound'), report.journey);
    assert.ok(names.includes('two_terminal_states_cases'), report.journey);
    for (const check of terminal.checks) assert.equal(check.status, 'pass', `${report.journey}: ${check.check}`);
  }
});

test('a journey that could not exercise something records it rather than staying silent', async () => {
  const report = await runJourney('journey.collections.invoice-to-settlement.v1');
  assert.ok(report.observations.length >= 1);
  // The earlier observation here claimed the issued_invoice case-opener did
  // not exist — checked against the tree 2026-08-15, that was WRONG (the
  // detector's issued lane landed with M2/#1589, wired into the hourly
  // sweep). The journey now DRIVES that opener; what it still walks past is
  // the parsed-document lane, and that is what must be stated.
  assert.ok(
    report.observations.some((note) => note.includes('parsed-document candidate lane')),
    'the lane this run does not drive must be stated'
  );
  assert.ok(
    report.observations.every((note) => !note.includes('no production sweep opens a receivable case')),
    'the corrected observation must not resurrect the stale opener-gap claim'
  );
});

// ── The harness's own laws ──────────────────────────────────────────────────

test('substrate: an unmodelled statement throws and is recorded, never an empty result', async () => {
  const substrate = createJourneySubstrate({ tables: { widgets: [{ id: 'w-1' }] } });
  await assert.rejects(
    () => substrate.query('select count(*) from widgets group by id', []),
    (error) => error instanceof UnroutedSqlError
  );
  assert.equal(substrate.unrouted.length, 1);
  assert.match(substrate.unrouted[0], /group by/);
});

test('substrate: an unrecognised WHERE predicate refuses instead of matching everything', async () => {
  const substrate = createJourneySubstrate({
    tables: { widgets: [{ id: 'w-1', status: 'open' }, { id: 'w-2', status: 'shut' }] }
  });
  // A silently-ignored predicate would widen this UPDATE to every row — the
  // harness bug class that makes a journey lie.
  await assert.rejects(
    () => substrate.query("update widgets set status = 'done' where status ~ 'op'", []),
    (error) => error instanceof UnroutedSqlError
  );
  assert.deepEqual(substrate.rows('widgets').map((row) => row.status), ['open', 'shut']);
});

test('substrate: writes are visible to later reads (the property a fixture mock lacks)', async () => {
  const substrate = createJourneySubstrate({ now: Date.parse('2026-08-14T09:00:00Z') });
  await substrate.query(
    'insert into widgets (id, name, payload) values ($1, $2, $3::jsonb)',
    ['w-1', 'first', JSON.stringify({ a: 1 })]
  );
  const read = await substrate.query('select * from widgets where id = $1', ['w-1']);
  assert.equal(read.rows[0].name, 'first');
  assert.deepEqual(read.rows[0].payload, { a: 1 });
  assert.equal(read.rows[0].created_at, '2026-08-14T09:00:00.000Z', 'the clock is frozen, not wall-time');

  await substrate.query(
    "update widgets set name = $2, payload = payload || $3::jsonb where id = $1",
    ['w-1', 'second', JSON.stringify({ b: 2 })]
  );
  const after = await substrate.query('select * from widgets where id = $1', ['w-1']);
  assert.equal(after.rows[0].name, 'second');
  assert.deepEqual(after.rows[0].payload, { a: 1, b: 2 }, 'jsonb merge, not replace');
});

test('substrate: on conflict do nothing skips, do update merges the stored row', async () => {
  const substrate = createJourneySubstrate();
  const insert = (id, note) => substrate.query(
    `insert into things (id, tag, note) values ($1, $2, $3)
     on conflict (tag) do nothing
     returning *`,
    [id, 'unique-tag', note]
  );
  const first = await insert('t-1', 'original');
  const second = await insert('t-2', 'duplicate');
  assert.equal(first.rows.length, 1);
  assert.equal(second.rows.length, 0, 'a skipped insert returns no row — the dedupe branch callers rely on');
  assert.equal(substrate.rows('things').length, 1);

  await substrate.query(
    `insert into things (id, tag, note) values ($1, $2, $3)
     on conflict (tag) do update set note = excluded.note, keeper = things.id
     returning *`,
    ['t-3', 'unique-tag', 'updated']
  );
  const [row] = substrate.rows('things');
  assert.equal(row.note, 'updated', 'excluded.<col> is the proposed row');
  assert.equal(row.keeper, 't-1', '<table>.<col> is the stored row');
});

test('substrate: column defaults stand in for the schema, so an omitted status is not undefined', async () => {
  const substrate = createJourneySubstrate();
  await substrate.query(
    'insert into receivable_cases (id, firm_id, client_id) values ($1, $2, $3)',
    ['case-1', 'firm', 'client']
  );
  assert.equal(substrate.rows('receivable_cases')[0].status, 'open');
});

test('the gate is FAIL when any check fails, when a statement was unmodelled, or when the run threw', async () => {
  // The recorder is reached through a real run, then re-derived: a report whose
  // gate could read PASS with a non-empty failure list would make every green
  // journey meaningless.
  const report = await runJourney('journey.collections.cadence-to-owner-escalation.v1');
  assert.equal(report.gate, 'PASS');
  assert.deepEqual(report.failures, []);
  const everyCheck = report.steps.flatMap((step) => step.checks);
  assert.ok(everyCheck.length >= 15, `a journey with ${everyCheck.length} checks is not an end-to-end run`);
  assert.ok(everyCheck.every((check) => check.status === 'pass'));
});
