// Donna Loops — proposalStore unit tests. Load-bearing properties:
//   - validates against operatorContract.js before any write (refuses bad shapes)
//   - card is immutable: re-persist no-ops + skips children; supersede creates a
//     NEW card and only transitions the OLD card's lifecycle pointer
//   - apply receipt is append-only + records the per-target apply outcome
//   - normalized targets carry the optimistic-concurrency token

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  persistProposalCard, supersedeProposalCard, persistApplyReceipt, getProposalCardSnapshot,
  getOwnerIntentProposalCardForPreflight, listOwnerIntentProposalCards,
  loadReversibleProposalCards, recordOwnerIntentPreflightReport, withdrawOwnerIntentProposalCard
} from './proposalStore.js';
import { EXAMPLE_PROPOSAL_CARD, EXAMPLE_APPLY_RECEIPT } from './operatorContract.js';

const makeMockClient = (responders = []) => {
  const calls = [];
  const queue = [...responders];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const text = String(sql).toLowerCase().replace(/\s+/g, ' ').trim();
      const idx = queue.findIndex((r) => text.includes(r.match));
      if (idx !== -1) {
        const [r] = queue.splice(idx, 1);
        if (r.throw) throw r.throw;
        return { rows: r.rows || [], rowCount: (r.rows || []).length };
      }
      return { rows: [], rowCount: 0 };
    }
  };
};

const sqlsMatching = (c, re) => c.calls.filter((q) => re.test(q.sql.toLowerCase().replace(/\s+/g, ' ')));

test('persistProposalCard: inserts card + normalized targets + check report (created)', async () => {
  const c = makeMockClient([{ match: 'insert into proposal_cards', rows: [{ id: EXAMPLE_PROPOSAL_CARD.proposal_id }] }]);
  const out = await persistProposalCard({
    client: c, firmId: 'f', clientId: 'cl', card: EXAMPLE_PROPOSAL_CARD, objectType: 'transaction'
  });
  assert.deepEqual(out, { id: 'prop_example_1', created: true });
  assert.match(c.calls[0].sql, /on conflict \(id\) do nothing/);
  // one proposal_targets row per target, carrying the precondition version token.
  const targetInserts = sqlsMatching(c, /insert into proposal_targets/);
  assert.equal(targetInserts.length, EXAMPLE_PROPOSAL_CARD.targets.length);
  assert.ok(targetInserts.every((q) => q.params.includes('2026-06-12T10:00:00Z')));
  assert.ok(targetInserts.every((q) => q.params.includes('transaction')));
  // one check report, and the card-level check_status is denormalized from it.
  assert.equal(sqlsMatching(c, /insert into check_reports/).length, 1);
  assert.ok(c.calls[0].params.includes('warning'));
});

test('persistProposalCard: already persisted → no child writes (immutable)', async () => {
  const c = makeMockClient([{ match: 'insert into proposal_cards', rows: [] }]);
  const out = await persistProposalCard({ client: c, firmId: 'f', clientId: 'cl', card: EXAMPLE_PROPOSAL_CARD });
  assert.deepEqual(out, { id: 'prop_example_1', created: false });
  assert.equal(sqlsMatching(c, /insert into proposal_targets/).length, 0);
  assert.equal(sqlsMatching(c, /insert into check_reports/).length, 0);
});

test('persistProposalCard: with a caseId, links the card (role proposal) + records the verdict on the case', async () => {
  const c = makeMockClient([{ match: 'insert into proposal_cards', rows: [{ id: EXAMPLE_PROPOSAL_CARD.proposal_id }] }]);
  await persistProposalCard({
    client: c, firmId: 'f', clientId: 'cl', card: EXAMPLE_PROPOSAL_CARD, caseId: 'case-evidence-1', objectType: 'transaction'
  });
  const links = sqlsMatching(c, /insert into bookkeeping_case_links/);
  assert.equal(links.length, 1);
  assert.ok(links[0].params.includes('proposal'), 'links with role proposal');
  assert.ok(links[0].params.includes('proposal_card'), 'object_type is proposal_card');
  const events = sqlsMatching(c, /insert into bookkeeping_case_events/);
  assert.equal(events.length, 1);
  assert.ok(events[0].params.includes('proposal.created'), 'records proposal.created');
  assert.match(JSON.stringify(events[0].params), /check_status/, 'carries the persisted verdict (rail #1)');
});

test('persistProposalCard: without a caseId, no case link or event is written', async () => {
  const c = makeMockClient([{ match: 'insert into proposal_cards', rows: [{ id: EXAMPLE_PROPOSAL_CARD.proposal_id }] }]);
  await persistProposalCard({ client: c, firmId: 'f', clientId: 'cl', card: EXAMPLE_PROPOSAL_CARD, objectType: 'transaction' });
  assert.equal(sqlsMatching(c, /insert into bookkeeping_case_links/).length, 0);
  assert.equal(sqlsMatching(c, /insert into bookkeeping_case_events/).length, 0);
});

test('persistProposalCard: contract violation is refused before any write', async () => {
  const c = makeMockClient();
  const bad = { ...EXAMPLE_PROPOSAL_CARD, review_mode: 'not_a_mode' };
  await assert.rejects(
    () => persistProposalCard({ client: c, firmId: 'f', clientId: 'cl', card: bad }),
    /proposal_card contract violation/
  );
  assert.equal(c.calls.length, 0);
});

test('supersedeProposalCard: persists the new card + transitions the old lifecycle pointer', async () => {
  const newCard = { ...EXAMPLE_PROPOSAL_CARD, proposal_id: 'prop_example_2' };
  const c = makeMockClient([{ match: 'insert into proposal_cards', rows: [{ id: 'prop_example_2' }] }]);
  const out = await supersedeProposalCard({
    client: c, firmId: 'f', clientId: 'cl', oldProposalId: 'prop_example_1', newCard, objectType: 'transaction'
  });
  assert.equal(out.id, 'prop_example_2');
  // the new card records what it supersedes …
  assert.ok(c.calls[0].params.includes('prop_example_1'));
  // … and the old card's pointer transitions (content untouched).
  const upd = sqlsMatching(c, /update proposal_cards set status = 'superseded'/);
  assert.equal(upd.length, 1);
  assert.deepEqual(upd[0].params, ['prop_example_1', 'prop_example_2']);
});

test('persistApplyReceipt: appends receipt + records per-target outcome + flips card to applied', async () => {
  const c = makeMockClient();
  const out = await persistApplyReceipt({ client: c, firmId: 'f', clientId: 'cl', receipt: EXAMPLE_APPLY_RECEIPT });
  assert.ok(out.id.startsWith('receipt-'));
  assert.equal(sqlsMatching(c, /insert into apply_receipts/).length, 1);
  const targetUpdates = sqlsMatching(c, /update proposal_targets set apply_status/);
  assert.equal(targetUpdates.length, EXAMPLE_APPLY_RECEIPT.per_target.length);
  const byTarget = Object.fromEntries(targetUpdates.map((q) => [q.params[1], q.params[2]]));
  assert.equal(byTarget.txn_1, 'applied');   // applied: true
  assert.equal(byTarget.txn_2, 'failed');    // applied: false, error: 'no_review_item'
  assert.equal(sqlsMatching(c, /update proposal_cards set status = 'applied'/).length, 1);
});

test('persistApplyReceipt: generation receipt (no proposal_id) touches no targets', async () => {
  const c = makeMockClient();
  await persistApplyReceipt({ client: c, firmId: 'f', clientId: 'cl', receipt: { ...EXAMPLE_APPLY_RECEIPT, proposal_id: null } });
  assert.equal(sqlsMatching(c, /insert into apply_receipts/).length, 1);
  assert.equal(sqlsMatching(c, /update proposal_targets/).length, 0);
  assert.equal(sqlsMatching(c, /update proposal_cards/).length, 0);
});

test('persistApplyReceipt: contract violation is refused', async () => {
  const c = makeMockClient();
  await assert.rejects(
    () => persistApplyReceipt({ client: c, firmId: 'f', clientId: 'cl', receipt: { ...EXAMPLE_APPLY_RECEIPT, model: 42 } }),
    /apply_receipt contract violation/
  );
  assert.equal(c.calls.length, 0);
});

test('listOwnerIntentProposalCards: read-only projection of staged owner intents', async () => {
  const c = makeMockClient([
    {
      match: 'from proposal_cards',
      rows: [{
        id: 'owner_intent_123',
        status: 'proposed',
        proposal_type: 'owner_intent_candidate',
        triage_source: 'memory_candidate',
        review_mode: 'client_confirmation',
        check_status: 'requires_review',
        detail: {
          compile_id: 'ic-1',
          source_message_id: 'msg-1',
          object: {
            kind: 'memory',
            summary: 'Remember Alex birthday',
            parse_confidence: 'high'
          },
          unmet_capability_needs: [{ local_id: 'o1', capability: 'memory.remember.v1' }]
        },
        warnings: ['staged only'],
        created_at: '2026-07-14T12:00:00.000Z',
        updated_at: '2026-07-14T12:00:00.000Z'
      }]
    },
    {
      match: 'from memory_candidates',
      rows: [{
        id: 'memcand-1',
        status: 'suggested',
        target_contract: 'memory',
        candidate_type: 'fact',
        proposal_id: 'owner_intent_123'
      }]
    },
    {
      match: 'from check_reports',
      rows: [{
        proposal_id: 'owner_intent_123',
        status: 'requires_review',
        created_at: '2026-07-14T12:01:00.000Z',
        checks: [{
          name: 'owner_intent_accept_preflight',
          status: 'requires_review',
          blockers: [{ code: 'apply_executor_not_enabled' }],
          required_capabilities: [{ capability: 'memory.remember.v1' }],
          consequence_diff: { status: 'not_computed' },
          apply_plan: { selected_mutation: { verb: 'ask_client', writer: 'createClientEvidenceRequestInDb' } },
          execution_gate: {
            status: 'blocked',
            enabled: false,
            writer_invoked: false,
            apply_receipt_required: true,
            apply_receipt_persisted: false,
            authority_materialized: false,
            reasons: [{ code: 'apply_executor_not_enabled' }]
          },
          actor: { actor_id: 'collab-1', unknown: false }
        }]
      }]
    }
  ]);

  const rows = await listOwnerIntentProposalCards({ client: c, firmId: 'f', clientId: 'cl', limit: 10 });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    proposal_id: 'owner_intent_123',
    status: 'proposed',
    created_at: '2026-07-14T12:00:00.000Z',
    updated_at: '2026-07-14T12:00:00.000Z',
    intent_kind: 'memory',
    summary: 'Remember Alex birthday',
    parse_confidence: 'high',
    triage_source: 'memory_candidate',
    review_mode: 'client_confirmation',
    check_status: 'requires_review',
    source_message_id: 'msg-1',
    compile_id: 'ic-1',
    memory_candidate: {
      id: 'memcand-1',
      status: 'suggested',
      target_contract: 'memory',
      candidate_type: 'fact'
    },
    preflight: {
      status: 'requires_review',
      blockers: [{ code: 'apply_executor_not_enabled' }],
      required_capabilities: [{ capability: 'memory.remember.v1' }],
      authority: null,
      consequence_diff: { status: 'not_computed' },
      apply_plan: { selected_mutation: { verb: 'ask_client', writer: 'createClientEvidenceRequestInDb' } },
      execution_gate: {
        status: 'blocked',
        enabled: false,
        writer_invoked: false,
        apply_receipt_required: true,
        apply_receipt_persisted: false,
        authority_materialized: false,
        reasons: [{ code: 'apply_executor_not_enabled' }]
      },
      actor: { actor_id: 'collab-1', unknown: false },
      created_at: '2026-07-14T12:01:00.000Z'
    },
    warnings: ['staged only'],
    unmet_capability_needs: [{ local_id: 'o1', capability: 'memory.remember.v1' }]
  });
  const query = c.calls.find((call) => /from proposal_cards/.test(call.sql.toLowerCase()));
  assert.match(query.sql, /proposal_type = 'owner_intent_candidate'/);
  assert.match(query.sql, /status = \$3/);
  assert.deepEqual(query.params, ['f', 'cl', 'proposed', 10]);
  const memoryQuery = c.calls.find((call) => /from memory_candidates/.test(call.sql.toLowerCase()));
  assert.match(memoryQuery.sql, /provenance->>'proposal_id'/);
  assert.deepEqual(memoryQuery.params, ['f', 'cl', ['owner_intent_123']]);
  const preflightQuery = c.calls.find((call) => /from check_reports/.test(call.sql.toLowerCase()));
  assert.deepEqual(JSON.parse(preflightQuery.params[3]), [{ name: 'owner_intent_accept_preflight' }]);
});

test('listOwnerIntentProposalCards: proposals survive when the memory-candidate table is absent', async () => {
  const c = makeMockClient([
    {
      match: 'from proposal_cards',
      rows: [{ id: 'owner_intent_456', status: 'proposed', detail: { object: { kind: 'task', summary: 'Do a thing' } } }]
    },
    { match: 'from memory_candidates', throw: Object.assign(new Error('no table'), { code: '42P01' }) }
  ]);
  const rows = await listOwnerIntentProposalCards({ client: c, firmId: 'f', clientId: 'cl' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].proposal_id, 'owner_intent_456');
  assert.equal(rows[0].memory_candidate, null);
  assert.equal(rows[0].preflight, null);
});

test('listOwnerIntentProposalCards: invalid status and pre-034 stores return empty', async () => {
  const c = makeMockClient();
  assert.deepEqual(await listOwnerIntentProposalCards({ client: c, firmId: 'f', clientId: 'cl', status: 'bogus' }), []);
  assert.equal(c.calls.length, 0);

  const missing = makeMockClient([{ match: 'from proposal_cards', throw: Object.assign(new Error('no table'), { code: '42P01' }) }]);
  assert.deepEqual(await listOwnerIntentProposalCards({ client: missing, firmId: 'f', clientId: 'cl' }), []);
});

test('withdrawOwnerIntentProposalCard: terminal owner skip records visible report without apply receipt', async () => {
  const c = makeMockClient([
    { match: 'update proposal_cards set status =', rows: [{ id: 'owner_intent_123', status: 'withdrawn' }] },
    { match: 'insert into check_reports', rows: [] }
  ]);
  const result = await withdrawOwnerIntentProposalCard({
    client: c,
    firmId: 'f',
    clientId: 'cl',
    proposalId: 'owner_intent_123',
    reason: 'not now',
    actor: { actor_id: null, actor_type: 'owner', basis: 'unknown', unknown: true }
  });
  assert.deepEqual(result, { status: 'withdrawn', proposal_id: 'owner_intent_123', reason: 'not now' });
  const update = sqlsMatching(c, /update proposal_cards set status = 'withdrawn'/)[0];
  assert.match(update.sql, /proposal_type = 'owner_intent_candidate'/);
  assert.match(update.sql, /status = 'proposed'/);
  const report = sqlsMatching(c, /insert into check_reports/)[0];
  const checks = JSON.parse(report.params[4]);
  assert.equal(checks[0].name, 'owner_intent_owner_withdrawn');
  assert.deepEqual(checks[0].actor, { actor_id: null, actor_type: 'owner', basis: 'unknown', unknown: true });
  assert.equal(sqlsMatching(c, /insert into apply_receipts/).length, 0);
});

test('getProposalCardSnapshot: reads card + targets + reports + receipts', async () => {
  const c = makeMockClient([
    { match: 'select * from proposal_cards', rows: [{ id: 'prop_example_1', status: 'proposed' }] },
    { match: 'from proposal_targets', rows: [{ object_id: 'txn_1', apply_status: 'pending' }] },
    { match: 'from check_reports', rows: [{ status: 'warning' }] },
    { match: 'from apply_receipts', rows: [{ id: 'receipt-1' }] }
  ]);
  const snap = await getProposalCardSnapshot({ client: c, proposalId: 'prop_example_1' });
  assert.equal(snap.card.id, 'prop_example_1');
  assert.equal(snap.targets.length, 1);
  assert.equal(snap.check_reports[0].status, 'warning');
  assert.equal(snap.apply_receipts[0].id, 'receipt-1');
});

test('getProposalCardSnapshot: unknown proposal → null', async () => {
  const c = makeMockClient([{ match: 'select * from proposal_cards', rows: [] }]);
  assert.equal(await getProposalCardSnapshot({ client: c, proposalId: 'nope' }), null);
});

test('loadReversibleProposalCards: scopes to firm+client, requires before_after, maps the row', async () => {
  const c = makeMockClient([{
    match: 'from proposal_cards',
    rows: [{
      id: 'prop-1', proposal_type: 'state_correction', status: 'applied',
      before_after: [{ target: 'txn_1', before: {}, after: {} }], before_after_total: 1, created_at: '2026-07-02'
    }]
  }]);
  const cards = await loadReversibleProposalCards({ client: c, firmId: 'f', clientId: 'cl' });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].proposal_id, 'prop-1');
  assert.equal(cards[0].before_after.length, 1);
  // firm + client are always bound; the query filters before_after_total > 0
  const q = c.calls.find((call) => /from proposal_cards/.test(call.sql.toLowerCase()));
  assert.equal(q.params[0], 'f');
  assert.equal(q.params[1], 'cl');
  assert.match(q.sql.toLowerCase().replace(/\s+/g, ' '), /before_after_total > 0/);
});

test('getOwnerIntentProposalCardForPreflight scopes lookup to firm/client/proposal', async () => {
  const c = makeMockClient([{ match: 'from proposal_cards', rows: [{ id: 'owner_intent_123', status: 'proposed' }] }]);
  const row = await getOwnerIntentProposalCardForPreflight({ client: c, firmId: 'f', clientId: 'cl', proposalId: 'owner_intent_123' });
  assert.equal(row.id, 'owner_intent_123');
  assert.deepEqual(c.calls[0].params, ['f', 'cl', 'owner_intent_123']);
  assert.match(c.calls[0].sql, /firm_id = \$1 and client_id = \$2 and id = \$3/);
});

test('recordOwnerIntentPreflightReport appends check report and updates denormalized status only', async () => {
  const c = makeMockClient();
  await recordOwnerIntentPreflightReport({
    client: c,
    firmId: 'f',
    clientId: 'cl',
    proposalId: 'owner_intent_123',
    report: { status: 'requires_review', checks: [{ name: 'owner_intent_accept_preflight', status: 'requires_review' }] }
  });
  assert.equal(sqlsMatching(c, /insert into check_reports/).length, 1);
  assert.equal(sqlsMatching(c, /update proposal_cards set check_status/).length, 1);
  assert.equal(sqlsMatching(c, /insert into apply_receipts/).length, 0);
  assert.equal(sqlsMatching(c, /ledger_/).length, 0);
});

test('recordOwnerIntentPreflightReport can append accept-refusal checks without apply receipt', async () => {
  const c = makeMockClient();
  await recordOwnerIntentPreflightReport({
    client: c,
    firmId: 'f',
    clientId: 'cl',
    proposalId: 'owner_intent_123',
    report: {
      status: 'requires_review',
      checks: [
        { name: 'owner_intent_accept_preflight', status: 'requires_review' },
        {
          name: 'owner_intent_accept_refused',
          status: 'requires_review',
          reason: 'preflight_blocked',
          apply_plan: { selected_mutation: { verb: 'ask_client', writer: 'createClientEvidenceRequestInDb' } }
        }
      ]
    }
  });
  assert.equal(sqlsMatching(c, /insert into check_reports/).length, 1);
  assert.equal(sqlsMatching(c, /update proposal_cards set check_status/).length, 1);
  const report = sqlsMatching(c, /insert into check_reports/)[0];
  assert.deepEqual(JSON.parse(report.params[5]).map((check) => check.name), [
    'owner_intent_accept_preflight',
    'owner_intent_accept_refused'
  ]);
  assert.equal(JSON.parse(report.params[5])[1].apply_plan.selected_mutation.writer, 'createClientEvidenceRequestInDb');
  assert.equal(sqlsMatching(c, /insert into apply_receipts/).length, 0);
});

test('loadReversibleProposalCards: proposalIds adds an id filter; empty inputs → []', async () => {
  const c = makeMockClient([{ match: 'from proposal_cards', rows: [] }]);
  await loadReversibleProposalCards({ client: c, firmId: 'f', clientId: 'cl', proposalIds: ['prop-1', 'prop-2'] });
  const q = c.calls.find((call) => /from proposal_cards/.test(call.sql.toLowerCase()));
  assert.match(q.sql.toLowerCase(), /id = any\(/);
  assert.deepEqual(q.params[2], ['prop-1', 'prop-2']);
  assert.deepEqual(await loadReversibleProposalCards({ client: null, firmId: 'f', clientId: 'cl' }), []);
  assert.deepEqual(await loadReversibleProposalCards({ client: c, firmId: '', clientId: 'cl' }), []);
});
