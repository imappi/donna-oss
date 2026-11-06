// Terminal-drain tests — the reconcile loop's "no line left hanging" step.
//
// runReconciliationTerminalDrain (loopsShadowProducers.js) is what enforces
// Kari's invariant: after the document matchers run, every bare bank line —
// money_out AND money_in — is disposed by the strong model so it exits the
// loop either settled (auto_explain) or carrying a no_match verdict the
// gap→ask chain escalates to a client question. Nothing stays at 'suggested'.
//
// These pin: the canary+ gate (inert at shadow), both-direction sweep, and
// that the disposed transaction ids come back as targets for the single
// onReconciliationRunCompleted pass the orchestrator already makes.

import assert from 'node:assert/strict';
import test from 'node:test';

import { runReconciliationTerminalDrain } from './loopsShadowProducers.js';

const makeMockClient = (responses = []) => {
  const calls = [];
  const reserved = [...responses];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const text = String(sql).trim().toLowerCase();
      if (text === 'begin' || text === 'commit' || text === 'rollback') return { rows: [] };
      const idx = reserved.findIndex((r) => text.includes(r.match));
      if (idx !== -1) {
        const [response] = reserved.splice(idx, 1);
        if (response.throw) throw response.throw;
        return { rows: response.rows || [] };
      }
      return { rows: [] };
    }
  };
};

const makeFetchOk = (body) => async () => ({
  ok: true,
  status: 200,
  json: async () => ({ content: [{ text: typeof body === 'string' ? body : JSON.stringify(body) }] })
});

const CHASE_EVIDENCE = {
  disposition: 'chase_evidence',
  materiality: 'material',
  expense_kind: 'processor_payout',
  confidence: 0.8,
  reasoning: 'Shopify payout needs its settlement report to substantiate revenue.'
};

const withEnv = async (vars, fn) => {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
};

const findEvalInsert = (client) =>
  client.calls.find((c) => c.sql.includes('insert into reconciliation_evaluations'));

test('terminal drain — LOOPS_SHADOW off → null no-op (inert, zero queries)', async () => {
  await withEnv({ LOOPS_SHADOW: undefined }, async () => {
    const client = makeMockClient([]);
    const out = await runReconciliationTerminalDrain({ client, firmId: 'firm-1', clientId: 'client-1' });
    assert.equal(out, null, 'no producer runs when the shadow master is off');
    assert.equal(client.calls.length, 0, 'zero queries — byte-identical to no producer');
  });
});

test('terminal drain — a shadow-tier firm does not execute (disabled, no verdict stamped)', async () => {
  await withEnv({ LOOPS_SHADOW: 'true', LOOPS_TIER: undefined, ANTHROPIC_API_KEY: 'sk-test' }, async () => {
    const client = makeMockClient([
      { match: 'to_regclass', rows: [{ present: 'public.bookkeeping_cases' }] },
      { match: 'from firms where id', rows: [{ metadata: { loops: { tier: 'shadow' } } }] }
    ]);
    const out = await runReconciliationTerminalDrain({
      client, firmId: 'firm-1', clientId: 'client-1', env: {}
    });
    assert.equal(out.disabled, true, 'the proposal_creation gate blocks a shadow-tier firm');
    assert.deepEqual(out.targets, []);
    assert.ok(!findEvalInsert(client), 'no disposition verdict written for a non-canary firm');
  });
});

test('terminal drain — canary firm: a bare money-in line is disposed and returned as a target', async () => {
  await withEnv({ LOOPS_SHADOW: 'true', LOOPS_TIER: 'canary', ANTHROPIC_API_KEY: 'sk-test' }, async () => {
    const client = makeMockClient([
      { match: 'to_regclass', rows: [{ present: 'public.bookkeeping_cases' }] },
      { match: 'from firms where id', rows: [{ metadata: { loops: { tier: 'canary' } } }] },
      // money_out sweep runs first: no debits → early return (one candidate query).
      { match: 'reconciliation_status is null', rows: [] },
      // money_in sweep: one bare revenue deposit with no matching document.
      { match: 'reconciliation_status is null', rows: [{ id: 'tx-shopify', money_in: 2283.87, money_out: 0, currency: 'USD', description: 'SHOPIFY INC ACH', reconciliation_status: null }] },
      { match: 'from reconciliation_matches', rows: [] },
      { match: 'from reconciliation_evaluations', rows: [] },
      { match: 'select description, raw_description', rows: [] },
      { match: 'from clients where firm_id', rows: [{ id: 'client-1', company_name: 'Honeybee Hills Apiary LLC', legal_names: [] }] }
    ]);
    const out = await runReconciliationTerminalDrain({
      client, firmId: 'firm-1', clientId: 'client-1',
      fetchImpl: makeFetchOk(CHASE_EVIDENCE)
    });
    assert.equal(out.disabled, false, 'canary executes the drain');
    assert.deepEqual(
      out.targets,
      [{ targetType: 'transaction', targetId: 'tx-shopify' }],
      'the disposed revenue line comes back as a transaction target for the gap producer'
    );
    const ins = findEvalInsert(client);
    assert.ok(ins, 'a disposition verdict was stamped for the bare line');
    assert.equal(ins.params[4], 'tx-shopify', 'target is the revenue line');
    assert.equal(ins.params[6], 'no_match', 'chase_evidence → no_match (the gap → client ask)');
    assert.equal(ins.params[7], 'evidence_needed', 'money-in chase reason');
  });
});

// F5 — the drain no longer wraps its model calls in one big transaction: the
// FIRST begin must come after the candidate scan (it is the per-line stamp's
// mini-transaction), so a backlog sweep never holds the max-2 firm pool open
// across sequential Anthropic calls.
test('terminal drain — F5: no outer transaction; the only begins are the per-line stamp mini-transactions', async () => {
  await withEnv({ LOOPS_SHADOW: 'true', LOOPS_TIER: 'canary', ANTHROPIC_API_KEY: 'sk-test' }, async () => {
    const client = makeMockClient([
      { match: 'to_regclass', rows: [{ present: 'public.bookkeeping_cases' }] },
      { match: 'from firms where id', rows: [{ metadata: { loops: { tier: 'canary' } } }] },
      { match: 'reconciliation_status is null', rows: [] },
      { match: 'reconciliation_status is null', rows: [{ id: 'tx-shopify', money_in: 2283.87, money_out: 0, currency: 'USD', description: 'SHOPIFY INC ACH', reconciliation_status: null }] },
      { match: 'from reconciliation_matches', rows: [] },
      { match: 'from reconciliation_evaluations', rows: [] },
      { match: 'select description, raw_description', rows: [] },
      { match: 'from clients where firm_id', rows: [{ id: 'client-1', company_name: 'Honeybee Hills Apiary LLC', legal_names: [] }] }
    ]);
    await runReconciliationTerminalDrain({
      client, firmId: 'firm-1', clientId: 'client-1',
      fetchImpl: makeFetchOk(CHASE_EVIDENCE)
    });
    const lowered = client.calls.map((c) => c.sql.trim().toLowerCase());
    const firstBegin = lowered.indexOf('begin');
    const firstCandidateScan = client.calls.findIndex((c) => c.sql.includes('reconciliation_status is null'));
    assert.ok(firstCandidateScan !== -1);
    assert.ok(firstBegin > firstCandidateScan, 'no transaction open before/during the sweep — only the per-line stamp txn');
    assert.equal(lowered.filter((s) => s === 'begin').length, 1, 'exactly one mini-transaction for the one stamped line');
    assert.equal(lowered.filter((s) => s === 'commit').length, 1);
  });
});
