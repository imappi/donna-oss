// Doc-first terminal drain tests — Slice 2's "no doc left hanging" step.
//
// runDocumentTerminalDrain / the onReconciliationRunCompleted integration
// (loopsShadowProducers.js) enforce Kari's fork for a parsed doc with no
// bank line: auto_explain settles it ("Explained"), chase_evidence writes
// the verdict Slice 3's ask leg escalates to the owner, needs_human stays
// the surfaced violation. These pin the config-plane flag ladder
// (DOCUMENT_NO_LINE_DISPOSITION: ∅ → inert; shadow → verdicts only, nothing
// acts; canary/auto → act: payload merge + stale-gap resolution + gap-open
// skip), the force-disable kill switch, and the two gap-projection guards
// (shadow rows never drive a gap; a settled doc never re-opens one).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  runDocumentTerminalDrain,
  onReconciliationRunCompleted
} from './loopsShadowProducers.js';
// RT-11b (2026-09-02): the disposition ceiling FOLLOWS THE PACK (reconciliation.
// disposition_ceiling, resolved from the client's canonical jurisdiction); env
// is the only override and no pack ⇒ the guard fails closed. This file's
// fixtures carry no pack-resolvable jurisdiction, so the ceiling is pinned
// through the env override here (the family-matcher tests' convention for
// RECONCILIATION_AUTO_MATCH_MATERIALITY_CEILING). The pack path is pinned in
// dispositionMateriality.test.js and materialityCeilingPackAppliancePgLifecycle.test.js.
process.env.DISPOSITION_MATERIALITY_CEILING = '500';

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
        return { rows: response.rows || [], rowCount: (response.rows || []).length };
      }
      return { rows: [], rowCount: 0 };
    }
  };
};

const makeFetchOk = (body) => async () => ({
  ok: true,
  status: 200,
  json: async () => ({ content: [{ text: typeof body === 'string' ? body : JSON.stringify(body) }] })
});

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
const findDocMerge = (client) =>
  client.calls.find((c) => /update documents/.test(c.sql));

const AUTO_EXPLAIN = {
  disposition: 'auto_explain', materiality: 'immaterial', expense_kind: 'fuel',
  settlement_channel: 'personal_card', confidence: 0.92,
  reasoning: 'Small fuel receipt; full feed coverage; settled on a personal card.'
};

const EXXON_ROW = {
  id: 'doc-exxon-1', document_type: 'receipt', vendor_name: 'Exxon',
  filename: 'exxon.pdf', total_amount: 41.2, currency: 'USD',
  document_date: '2026-05-14', payment_status: 'paid'
};

// Base plumbing every enabled run needs: loops tables present + the config
// snapshot carrying the flag at `stage`.
const baseResponses = (stage) => [
  { match: 'to_regclass', rows: [{ present: 'public.bookkeeping_cases' }] },
  {
    match: 'from client_capability_config',
    rows: [{ flag_key: 'DOCUMENT_NO_LINE_DISPOSITION', stage, source: 'manual', client_id: 'client-1' }]
  }
];

const sweepResponses = () => [
  { match: 'from documents d', rows: [EXXON_ROW] },
  { match: 'from client_evidence_requests', rows: [] },
  { match: 'from reconciliation_evaluations', rows: [] },
  { match: 'from transactions', rows: [{ line_count: 120, first_date: '2026-01-01', last_date: '2026-06-30' }] },
  { match: 'from clients where firm_id', rows: [{ id: 'client-1', company_name: 'Honeybee Hills Apiary LLC', legal_names: [] }] },
  { match: "payload->'no_line_disposition' as before_state", rows: [{ before_state: null }] },
  { match: 'update documents', rows: [{ id: 'updated' }] }
];

test('doc drain — LOOPS_SHADOW off → null no-op (zero queries)', async () => {
  await withEnv({ LOOPS_SHADOW: undefined }, async () => {
    const client = makeMockClient([]);
    const out = await runDocumentTerminalDrain({ client, firmId: 'firm-1', clientId: 'client-1' });
    assert.equal(out, null);
    assert.equal(client.calls.length, 0);
  });
});

test('doc drain — flag ∅ (no DB row) → disabled flag_off; envFallback is FALSE (born on the plane, no env pair)', async () => {
  await withEnv({ LOOPS_SHADOW: 'true', ANTHROPIC_API_KEY: 'sk-test' }, async () => {
    const client = makeMockClient([
      { match: 'to_regclass', rows: [{ present: 'public.bookkeeping_cases' }] },
      { match: 'from client_capability_config', rows: [] }
    ]);
    const out = await runDocumentTerminalDrain({ client, firmId: 'firm-1', clientId: 'client-1' });
    assert.equal(out.disabled, true);
    assert.equal(out.reason, 'flag_off');
    assert.ok(!findEvalInsert(client), 'no verdict for an un-enrolled client');
  });
});

test('doc drain — SHADOW stage: verdicts accrue (matcher_mode shadow), nothing acts', async () => {
  await withEnv({ LOOPS_SHADOW: 'true', ANTHROPIC_API_KEY: 'sk-test' }, async () => {
    const client = makeMockClient([...baseResponses('shadow'), ...sweepResponses()]);
    const out = await runDocumentTerminalDrain({
      client, firmId: 'firm-1', clientId: 'client-1', fetchImpl: makeFetchOk(AUTO_EXPLAIN)
    });
    assert.equal(out.disabled, false);
    assert.equal(out.mode, 'shadow');
    assert.deepEqual(out.settledDocIds, [], 'shadow settles nothing');
    const ins = findEvalInsert(client);
    assert.ok(ins, 'the shadow verdict row is written');
    assert.equal(JSON.parse(ins.params[12]).matcher_mode, 'shadow');
    assert.ok(!findDocMerge(client), 'no payload merge at shadow');
    assert.ok(!client.calls.some((c) => c.sql.includes('from bookkeeping_case_blockers')),
      'no gap-case touch at shadow');
  });
});

test('doc drain — CANARY stage acts: auto_explain merges the payload verdict + resolves a stale doc gap', async () => {
  await withEnv({ LOOPS_SHADOW: 'true', ANTHROPIC_API_KEY: 'sk-test' }, async () => {
    const client = makeMockClient([
      ...baseResponses('canary'),
      ...sweepResponses(),
      // A stale open unclear_match blocker from a prior family no_match gap.
      { match: 'from bookkeeping_case_blockers', rows: [{ id: 'blk-1', reason: 'No matching bank line found.' }] }
    ]);
    const out = await runDocumentTerminalDrain({
      client, firmId: 'firm-1', clientId: 'client-1', fetchImpl: makeFetchOk(AUTO_EXPLAIN)
    });
    assert.equal(out.mode, 'act');
    assert.deepEqual(out.settledDocIds, ['doc-exxon-1']);
    const merge = findDocMerge(client);
    assert.ok(merge, 'the act-mode settle merged the payload verdict Slice 1 renders');
    const merged = JSON.parse(merge.params[3]).no_line_disposition;
    assert.equal(merged.disposition, 'auto_explain');
    // Slice 3 — the decide-and-notify marker: the ask-batch FYI gather keys on
    // owner_notified 'false' and the send chokepoint flips it (FYI'd once).
    assert.equal(merged.owner_notified, false, 'the settle seeds the one-time owner-FYI marker');
    assert.ok(client.calls.some((c) => c.sql.includes('from bookkeeping_case_blockers')),
      'the stale gap case was looked up for resolution');
  });
});

test('doc drain — CLIENT_CONFIG_FORCE_DISABLE kills the flag even at canary', async () => {
  await withEnv({
    LOOPS_SHADOW: 'true', ANTHROPIC_API_KEY: 'sk-test',
    CLIENT_CONFIG_FORCE_DISABLE: 'DOCUMENT_NO_LINE_DISPOSITION'
  }, async () => {
    const client = makeMockClient(baseResponses('canary'));
    const out = await runDocumentTerminalDrain({ client, firmId: 'firm-1', clientId: 'client-1' });
    assert.equal(out.disabled, true, 'env can KILL a behavior, never enable one');
    assert.ok(!findEvalInsert(client));
  });
});

test('hook integration — a drain-settled doc SKIPS gap projection; an unsettled one still projects', async () => {
  await withEnv({ LOOPS_SHADOW: 'true', ANTHROPIC_API_KEY: 'sk-test' }, async () => {
    const client = makeMockClient([
      ...baseResponses('canary'),
      ...sweepResponses(),
      // Gap resolution lookup for the settled doc (no open blocker → no-op).
      { match: 'from bookkeeping_case_blockers', rows: [] }
    ]);
    const out = await onReconciliationRunCompleted({
      client, firmId: 'firm-1', clientId: 'client-1',
      targets: [{ targetType: 'document', targetId: 'doc-exxon-1' }],
      fetchImpl: makeFetchOk(AUTO_EXPLAIN)
    });
    assert.equal(out.docDrain?.settled, 1);
    // The settled doc must NOT reach openReconciliationGapForUnmatchedTarget —
    // its query is recognizable by the match-state read that precedes every
    // gap projection (readTargetMatchState's bool_or aggregate).
    assert.ok(!client.calls.some((c) => c.sql.includes('bool_or')),
      'no gap projection ran for the settled doc');
    assert.equal(out.opened, 0);
  });
});

test('hook integration — flag ∅ leaves the hook byte-identical (gap projection runs as before)', async () => {
  await withEnv({ LOOPS_SHADOW: 'true', ANTHROPIC_API_KEY: 'sk-test' }, async () => {
    const client = makeMockClient([
      { match: 'to_regclass', rows: [{ present: 'public.bookkeeping_cases' }] },
      { match: 'from client_capability_config', rows: [] }
      // Every other query (match state, verdict read) returns [] → no gap opens.
    ]);
    const out = await onReconciliationRunCompleted({
      client, firmId: 'firm-1', clientId: 'client-1',
      targets: [{ targetType: 'document', targetId: 'doc-exxon-1' }]
    });
    assert.equal(out.docDrain, null, 'no drain surface when the flag is off');
    assert.ok(!findEvalInsert(client), 'no disposition verdict');
    assert.ok(client.calls.some((c) => c.sql.includes('bool_or')),
      'the normal gap projection still ran for the doc target');
  });
});

// Slice 3 — the standalone backlog sweep drives its chase verdicts toward the
// ask terminal: an ACT-mode sweep that produced chase_evidence verdicts
// requests the client's ask-batch (re)draft through the coalesced producer
// (its own gating still applies). Shadow mode never enqueues.
const CHASE_EVIDENCE = {
  disposition: 'chase_evidence', materiality: 'material', expense_kind: 'unknown',
  settlement_channel: 'uncovered_account', confidence: 0.85,
  reasoning: 'Material bill; the paying account has no statement in the feed.'
};

const chaseSweepResponses = () => [
  { match: 'from documents d', rows: [EXXON_ROW] },
  { match: 'from client_evidence_requests', rows: [] },
  { match: 'from reconciliation_evaluations', rows: [] },
  { match: 'from transactions', rows: [{ line_count: 120, first_date: '2026-01-01', last_date: '2026-06-30' }] },
  { match: 'from clients where firm_id', rows: [{ id: 'client-1', company_name: 'Honeybee Hills Apiary LLC', legal_names: [] }] }
];

test('doc drain — ACT-mode chase_evidence requests the ask-batch redraft (Slice 3 ask leg)', async () => {
  await withEnv({ LOOPS_SHADOW: 'true', ANTHROPIC_API_KEY: 'sk-test', LOOPS_TIER: 'canary' }, async () => {
    const client = makeMockClient([
      ...baseResponses('canary'),
      // The drain's lane-policy read (the #1748 shape) probes its own table
      // first — absent ⇒ null policy ⇒ the strong default decides.
      { match: 'to_regclass', rows: [{ present: null }] },
      ...chaseSweepResponses(),
      // The producer's own runShadow re-checks the loops tables…
      { match: 'to_regclass', rows: [{ present: 'public.bookkeeping_cases' }] },
      // …then gates on the firm tier (canary ⇒ proposal_creation allowed)…
      { match: 'select metadata from firms', rows: [{ metadata: { loops: { tier: 'canary' } } }] },
      // …coalesce check finds nothing in flight, and the outbox row lands.
      { match: "status in ('pending', 'dispatching', 'failed')", rows: [] },
      { match: 'insert into loop_event_outbox', rows: [{ id: 'ob-doc-1' }] }
    ]);
    const out = await runDocumentTerminalDrain({
      client, firmId: 'firm-1', clientId: 'client-1', fetchImpl: makeFetchOk(CHASE_EVIDENCE)
    });
    assert.equal(out.mode, 'act');
    assert.equal(out.stats.chase_evidence, 1);
    const enqueue = client.calls.find((c) => c.sql.toLowerCase().includes('insert into loop_event_outbox'));
    assert.ok(enqueue, 'the sweep requested the ask-batch (re)draft');
    assert.equal(enqueue.params[3], 'ask_draft.requested');
  });
});

test('doc drain — SHADOW-mode chase_evidence never requests a draft (verdicts only)', async () => {
  await withEnv({ LOOPS_SHADOW: 'true', ANTHROPIC_API_KEY: 'sk-test', LOOPS_TIER: 'canary' }, async () => {
    const client = makeMockClient([
      ...baseResponses('shadow'),
      ...chaseSweepResponses()
    ]);
    const out = await runDocumentTerminalDrain({
      client, firmId: 'firm-1', clientId: 'client-1', fetchImpl: makeFetchOk(CHASE_EVIDENCE)
    });
    assert.equal(out.mode, 'shadow');
    assert.ok(!client.calls.some((c) => c.sql.toLowerCase().includes('insert into loop_event_outbox')),
      'shadow writes verdicts only — no ask-draft request');
  });
});

test('gap guards — the forward open query excludes shadow disposition rows and payload-settled docs', async () => {
  await withEnv({ LOOPS_SHADOW: 'true' }, async () => {
    const client = makeMockClient([
      { match: 'to_regclass', rows: [{ present: 'public.bookkeeping_cases' }] },
      { match: 'from client_capability_config', rows: [] }
    ]);
    await onReconciliationRunCompleted({
      client, firmId: 'firm-1', clientId: 'client-1',
      targets: [{ targetType: 'document', targetId: 'doc-exxon-1' }]
    });
    const openQuery = client.calls.find((c) =>
      c.sql.includes("e.verdict = 'no_match'") && c.sql.includes('order by e.evaluated_at desc'));
    assert.ok(openQuery, 'the forward gap-open query ran');
    assert.ok(openQuery.sql.includes("e.payload->>'matcher_mode' is distinct from 'shadow'"),
      'a shadow verdict can never become the projected latest no_match');
    assert.ok(openQuery.sql.includes("sd.payload->'no_line_disposition'->>'disposition' = 'auto_explain'"),
      'a payload-settled doc never re-opens a gap off its older family verdict');
  });
});
