// Doc-first terminal drain Slice 2 — document disposition producer tests.
//
// Mock-pg + mock-fetch harness mirrors bankLineDispositionLlm.test.js.
// Pins: the parser's deterministic Keep-layer guards (material auto_explain
// → chase_evidence downgrade; confidence floor → needs_human; safe-by-
// default), the prompt builder (header + coverage + firm anchor, no raw
// content), the strong call's non-OK normalization, the sweep's population
// guards / already-asked skip / incremental guard, and the shadow-vs-act
// write split (shadow: verdict row ONLY; act: + the payload merge Slice 1
// renders + the before_state audit).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseDocumentDispositionResponse,
  buildDocumentDispositionUserPrompt,
  proposeDocumentDisposition,
  buildDocumentDispositionSystemPrompt,
  __SYSTEM_PROMPT,
  runDocumentDispositionForClient,
  DOCUMENT_NO_LINE_DISPOSITION_FAMILY,
  DOCUMENT_NO_LINE_DISPOSITION_TARGET_TYPE,
  DOCUMENT_NO_LINE_DISPOSITION_POLICY_VERSION,
  DOCUMENT_NO_LINE_DISPOSITION_FLAG_KEY,
  RECONCILABLE_DOC_TYPES,
  DEFAULT_AUTO_EXPLAIN_CONFIDENCE_FLOOR,
  __DISPOSITION_TO_VERDICT,
  __DISPOSITION_DEFAULT_REASON,
  isTechnicalNeedsHuman,
  machineRerunDueAt,
  buildNeedsHumanOwnerQuestion,
  buildOwnerReplyClarificationQuestion,
  MACHINE_RERUN_MAX_ATTEMPTS,
  OWNER_ASK_MAX_GENERATIONS
} from './documentDispositionLlm.js';
import { RECONCILABLE_DOCUMENT_KINDS } from '../../src/lib/documentsInbox.js';
// RT-11b (2026-09-02): the disposition ceiling FOLLOWS THE PACK (reconciliation.
// disposition_ceiling, resolved from the client's canonical jurisdiction); env
// is the only override and no pack ⇒ the guard fails closed. The fixtures in
// this file carry display-string / packless jurisdictions, so the ceiling is
// pinned through the env override here (the same convention the family-matcher
// tests use for RECONCILIATION_AUTO_MATCH_MATERIALITY_CEILING). The pack path
// itself is pinned in dispositionMateriality.test.js and the RT-11b appliance
// fixture (materialityCeilingPackAppliancePgLifecycle.test.js).
process.env.DISPOSITION_MATERIALITY_CEILING = '500';

// ── Mock client ───────────────────────────────────────────────────────
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

const makeFetchOk = (responseBody) => async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    content: [{ text: typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody) }]
  })
});

const makeFetchError = (status) => async () => ({
  ok: false,
  status,
  json: async () => ({ error: { message: 'boom' } })
});

const findEvalInsert = (client) =>
  client.calls.find((c) => c.sql.includes('insert into reconciliation_evaluations'));
const findAudits = (client, action) =>
  client.calls.filter((c) => c.sql.includes('insert into audit_events') && c.params?.[2] === action);

const EXXON_DOC = {
  id: 'doc-exxon-1', document_type: 'receipt', vendor_name: 'Exxon',
  filename: 'exxon-receipt.pdf', total_amount: 41.2, currency: 'USD',
  document_date: '2026-05-14', payment_status: 'paid'
};

const AUTO_EXPLAIN = {
  disposition: 'auto_explain', materiality: 'immaterial', expense_kind: 'fuel',
  settlement_channel: 'personal_card', confidence: 0.92,
  reasoning: 'Small fuel receipt with full feed coverage and no line — settled on a personal card.'
};
const CHASE = {
  disposition: 'chase_evidence', materiality: 'material', expense_kind: 'equipment',
  settlement_channel: 'uncovered_account', confidence: 0.8,
  reasoning: 'Material purchase with no visible settlement — the owner must say how it was paid.'
};

// Canned rows for a full sweep. `match` substrings are unique per query.
// The `update documents` row makes the mock report rowCount 1 (a real merge).
const sweepResponses = ({ candidates, asked = [], priorEvals = [], coverage = [{ line_count: 120, first_date: '2026-01-01', last_date: '2026-06-30' }], identity = [{ id: 'client-1', company_name: 'Honeybee Hills Apiary LLC', legal_names: [] }], docRow = [{ before_state: null }] }) => [
  { match: 'from documents d', rows: candidates },
  { match: 'from client_evidence_requests', rows: asked },
  { match: 'from reconciliation_evaluations', rows: priorEvals },
  { match: 'from transactions', rows: coverage },
  { match: 'from clients where firm_id', rows: identity },
  { match: "payload->'no_line_disposition' as before_state", rows: docRow },
  { match: 'update documents', rows: [{ id: 'updated' }] }
];

// ── Constants / lock-step pins ────────────────────────────────────────

test('constants — family / target / policy / flag key are pinned', () => {
  assert.equal(DOCUMENT_NO_LINE_DISPOSITION_FAMILY, 'document_no_line_disposition');
  assert.equal(DOCUMENT_NO_LINE_DISPOSITION_TARGET_TYPE, 'document');
  assert.equal(DOCUMENT_NO_LINE_DISPOSITION_POLICY_VERSION, 'document_no_line_disposition_v1');
  assert.equal(DOCUMENT_NO_LINE_DISPOSITION_FLAG_KEY, 'DOCUMENT_NO_LINE_DISPOSITION');
});

test('constants — RECONCILABLE_DOC_TYPES is LOCK-STEP with the Slice-1 selector kinds', () => {
  assert.deepEqual([...RECONCILABLE_DOC_TYPES].sort(), [...RECONCILABLE_DOCUMENT_KINDS].sort(),
    'the sweep population and selectNoLineReconcilableDocs must drain the same kinds');
});

test('constants — disposition → verdict / default reason maps', () => {
  assert.deepEqual(__DISPOSITION_TO_VERDICT, {
    auto_explain: 'auto_explained', chase_evidence: 'no_match', needs_human: 'no_match'
  });
  // evidence_needed is in loopGoalRegistry's owner-ask set (client-owned gap);
  // document_needs_review deliberately is NOT (firm-side violation, surfaced).
  assert.deepEqual(__DISPOSITION_DEFAULT_REASON, {
    chase_evidence: 'evidence_needed', needs_human: 'document_needs_review'
  });
});

// ── Parser (Keep-layer guards) ────────────────────────────────────────

test('parser — a clean immaterial high-confidence auto_explain passes through', () => {
  const out = parseDocumentDispositionResponse(JSON.stringify(AUTO_EXPLAIN));
  assert.equal(out.disposition, 'auto_explain');
  assert.equal(out.downgraded_from, null);
  assert.equal(out.materiality, 'immaterial');
  assert.equal(out.settlement_channel, 'personal_card');
  assert.equal(out.confidence, 0.92);
});

test('parser — MATERIAL auto_explain downgrades to chase_evidence (on the owner), recording the original call', () => {
  const out = parseDocumentDispositionResponse(JSON.stringify({ ...AUTO_EXPLAIN, materiality: 'material' }));
  assert.equal(out.disposition, 'chase_evidence', 'material + no grant ⇒ on the owner, never silently settled');
  assert.equal(out.downgraded_from, 'auto_explain', 'the receipt shows what the model said');
});

test('parser — auto_explain below the confidence floor falls to needs_human (visible)', () => {
  const out = parseDocumentDispositionResponse(
    JSON.stringify({ ...AUTO_EXPLAIN, confidence: DEFAULT_AUTO_EXPLAIN_CONFIDENCE_FLOOR - 0.01 })
  );
  assert.equal(out.disposition, 'needs_human');
  assert.equal(out.downgraded_from, 'auto_explain');
});

test('parser — unknown enums collapse safe; malformed JSON fails toward a human', () => {
  const weird = parseDocumentDispositionResponse(JSON.stringify({
    disposition: 'post_it', materiality: 'huge', settlement_channel: 'crypto', confidence: 99
  }));
  assert.equal(weird.disposition, 'needs_human');
  assert.equal(weird.materiality, 'material');
  assert.equal(weird.settlement_channel, 'unknown');
  assert.equal(weird.confidence, 1, 'confidence clamped to [0,1]');

  const broken = parseDocumentDispositionResponse('not json at all');
  assert.equal(broken.disposition, 'needs_human');
  assert.equal(broken.unmatchable_reason, 'invalid_llm_response');
});

// ── Prompt builder ────────────────────────────────────────────────────

test('prompt — carries the doc header, feed coverage, and the firm anchor; never raw content', () => {
  const prompt = buildDocumentDispositionUserPrompt({
    document: EXXON_DOC,
    firmContext: {
      clientIdentity: { display_name: 'Honeybee Hills Apiary LLC', legal_names: [], jurisdiction: 'US' },
      knownCounterparties: ['Dadant & Sons'],
      bankFeedCoverage: { lineCount: 120, firstDate: '2026-01-01', lastDate: '2026-06-30' }
    }
  });
  assert.ok(prompt.includes('id=doc-exxon-1'));
  assert.ok(prompt.includes('type=receipt (direction=money_out)'));
  assert.ok(prompt.includes('counterparty="Exxon"'));
  assert.ok(prompt.includes('120 bank lines from 2026-01-01 to 2026-06-30'));
  assert.ok(prompt.includes('Honeybee Hills Apiary LLC'), 'the firm-side anchor is rendered');
  assert.ok(prompt.includes('Dadant & Sons'), 'known suppliers rendered');
});

test('prompt — zero coverage renders the "no bank lines uploaded yet" signal; money-in direction flips', () => {
  const prompt = buildDocumentDispositionUserPrompt({
    document: { ...EXXON_DOC, id: 'doc-inv', document_type: 'sales_invoice' },
    firmContext: { bankFeedCoverage: { lineCount: 0 } }
  });
  assert.ok(prompt.includes('NO bank lines uploaded yet'));
  assert.ok(prompt.includes('direction=money_in'));
});

// ── The strong call ───────────────────────────────────────────────────

test('proposeDocumentDisposition — ok response parses; no key / transport error fail safe', async () => {
  const ok = await proposeDocumentDisposition({
    document: EXXON_DOC, apiKey: 'sk-test', fetchImpl: makeFetchOk(AUTO_EXPLAIN)
  });
  assert.equal(ok.disposition, 'auto_explain');

  const noKey = await proposeDocumentDisposition({ document: EXXON_DOC, apiKey: '' });
  assert.equal(noKey.disposition, 'needs_human');
  assert.equal(noKey.unmatchable_reason, 'no_api_key');

  // A non-transient status (400) throws inside the core; the producer
  // catches and fails toward a human carrying 'transport_error' — an API
  // failure is never a bookkeeping judgment.
  const err = await proposeDocumentDisposition({
    document: EXXON_DOC, apiKey: 'sk-test', fetchImpl: makeFetchError(400)
  });
  assert.equal(err.disposition, 'needs_human', 'non-OK transport falls toward a human');
  assert.equal(err.unmatchable_reason, 'transport_error');
});

// ── The sweep ─────────────────────────────────────────────────────────

test('sweep — missing ids / missing key disable cleanly', async () => {
  const noIds = await runDocumentDispositionForClient({ client: makeMockClient([]), firmId: null, clientId: null });
  assert.equal(noIds.disabled, true);
  assert.equal(noIds.disabled_reason, 'missing_ids');

  const noKey = await runDocumentDispositionForClient({
    client: makeMockClient([]), firmId: 'f', clientId: 'c', apiKeyOverride: ''
  });
  assert.equal(noKey.disabled, true);
  assert.equal(noKey.disabled_reason, 'no_anthropic_api_key');
});

test('sweep — SHADOW mode: verdict row only (matcher_mode shadow), NO payload merge, nothing settled', async () => {
  const client = makeMockClient(sweepResponses({ candidates: [EXXON_DOC] }));
  const stats = await runDocumentDispositionForClient({
    client, firmId: 'firm-1', clientId: 'client-1', mode: 'shadow',
    apiKeyOverride: 'sk-test', fetchImpl: makeFetchOk(AUTO_EXPLAIN)
  });
  assert.equal(stats.evaluated, 1);
  assert.equal(stats.auto_explained, 1);
  assert.deepEqual(stats.evaluated_target_ids, ['doc-exxon-1']);
  assert.deepEqual(stats.settled_doc_ids, [], 'shadow settles nothing');

  const ins = findEvalInsert(client);
  assert.ok(ins, 'the evaluation row is the shadow receipt');
  assert.equal(ins.params[3], 'document', 'target_type document');
  assert.equal(ins.params[5], DOCUMENT_NO_LINE_DISPOSITION_FAMILY);
  assert.equal(ins.params[6], 'auto_explained');
  const payload = JSON.parse(ins.params[12]);
  assert.equal(payload.matcher_mode, 'shadow');
  assert.equal(payload.disposition, 'auto_explain');
  assert.equal(payload.policy_version, DOCUMENT_NO_LINE_DISPOSITION_POLICY_VERSION);

  assert.ok(!client.calls.some((c) => /update documents/.test(c.sql)), 'no live write in shadow');
  assert.equal(findAudits(client, 'document.disposition.evaluated').length, 1, 'the evaluation is audited');
  assert.equal(findAudits(client, 'document.disposition.auto_explained').length, 0, 'no settle audit in shadow');
});

test('sweep — ACT mode + auto_explain: payload merge (the Slice-1 verdict) + before_state audit + settled id', async () => {
  const client = makeMockClient(sweepResponses({ candidates: [EXXON_DOC] }));
  const stats = await runDocumentDispositionForClient({
    client, firmId: 'firm-1', clientId: 'client-1', mode: 'act',
    apiKeyOverride: 'sk-test', fetchImpl: makeFetchOk(AUTO_EXPLAIN)
  });
  assert.deepEqual(stats.settled_doc_ids, ['doc-exxon-1']);

  const merge = client.calls.find((c) => /update documents/.test(c.sql));
  assert.ok(merge, 'the documents payload merge ran');
  const merged = JSON.parse(merge.params[3]);
  assert.equal(merged.no_line_disposition.disposition, 'auto_explain',
    'exactly the shape documentsInbox.noLineDispositionFor reads');
  assert.equal(merged.no_line_disposition.settlement_channel, 'personal_card');

  const settleAudits = findAudits(client, 'document.disposition.auto_explained');
  assert.equal(settleAudits.length, 1, 'the settle is audited');
  const meta = JSON.parse(settleAudits[0].params[4]);
  assert.ok('before_state' in meta, 'reversibility: before_state rides the audit');

  const ins = findEvalInsert(client);
  assert.equal(JSON.parse(ins.params[12]).matcher_mode, 'act');
});

test('sweep — G2 PR-12: a failed audit insert fails the per-doc transaction (audit-as-precondition)', async () => {
  const client = makeMockClient([
    ...sweepResponses({ candidates: [EXXON_DOC] }),
    { match: 'insert into audit_events', throw: new Error('audit store down') }
  ]);
  const stats = await runDocumentDispositionForClient({
    client, firmId: 'firm-1', clientId: 'client-1', mode: 'shadow',
    apiKeyOverride: 'sk-test', fetchImpl: makeFetchOk(AUTO_EXPLAIN)
  });
  assert.equal(stats.stamp_failures, 1, 'the verdict must not commit without its receipt');
  assert.deepEqual(stats.evaluated_target_ids, [], 'no evaluated target is reported for a rolled-back stamp');
  assert.ok(
    client.calls.some((c) => c.sql.trim().toLowerCase() === 'rollback'),
    'the per-doc mini-transaction rolled back'
  );
});

test('stamp — G2 PR-12: an audit failure inside the ACT payload merge RETHROWS (rollback), never a swallowed poisoned-commit', async () => {
  const client = makeMockClient([
    ...sweepResponses({ candidates: [EXXON_DOC] }),
    { match: 'insert into audit_events', rows: [{ id: 'audit-evaluated' }] },
    { match: 'insert into audit_events', throw: new Error('audit store down') }
  ]);
  const stats = await runDocumentDispositionForClient({
    client, firmId: 'firm-1', clientId: 'client-1', mode: 'act',
    apiKeyOverride: 'sk-test', fetchImpl: makeFetchOk(AUTO_EXPLAIN)
  });
  assert.equal(stats.stamp_failures, 1, 'the settle must not stand without its before_state receipt');
  assert.deepEqual(stats.settled_doc_ids, [], 'no settle is reported for a receipt-less merge');
  assert.ok(
    client.calls.some((c) => c.sql.trim().toLowerCase() === 'rollback'),
    'the per-doc transaction rolled back'
  );
});

test('stamp — a NON-audit merge failure still falls to the verdict row (F3 posture unchanged by G2 PR-12)', async () => {
  const responses = sweepResponses({ candidates: [EXXON_DOC] }).filter((r) => r.match !== 'update documents');
  responses.push({ match: 'update documents', throw: new Error('merge down') });
  const client = makeMockClient(responses);
  const stats = await runDocumentDispositionForClient({
    client, firmId: 'firm-1', clientId: 'client-1', mode: 'act',
    apiKeyOverride: 'sk-test', fetchImpl: makeFetchOk(AUTO_EXPLAIN)
  });
  assert.equal(stats.stamp_failures, 0, 'the verdict row stays authoritative on a non-audit merge failure');
  assert.deepEqual(stats.evaluated_target_ids, ['doc-exxon-1'], 'the stamp stands');
  assert.deepEqual(stats.settled_doc_ids, [], 'the failed merge reports no settle');
});

test('sweep — ACT mode + chase_evidence: no_match verdict with evidence_needed, NO payload merge', async () => {
  const client = makeMockClient(sweepResponses({ candidates: [EXXON_DOC] }));
  const stats = await runDocumentDispositionForClient({
    client, firmId: 'firm-1', clientId: 'client-1', mode: 'act',
    apiKeyOverride: 'sk-test', fetchImpl: makeFetchOk(CHASE)
  });
  assert.equal(stats.chase_evidence, 1);
  assert.deepEqual(stats.settled_doc_ids, []);
  const ins = findEvalInsert(client);
  assert.equal(ins.params[6], 'no_match');
  assert.equal(ins.params[7], 'evidence_needed', 'the owner-ask reason Slice 3 drafts from');
  assert.ok(!client.calls.some((c) => /update documents/.test(c.sql)), 'only auto_explain settles');
});

test('sweep — population guards are in the SQL: parse states, kinds, amount, live-match exclusion, id scope', async () => {
  const client = makeMockClient(sweepResponses({ candidates: [] }));
  await runDocumentDispositionForClient({
    client, firmId: 'firm-1', clientId: 'client-1', apiKeyOverride: 'sk-test'
  });
  const pop = client.calls.find((c) => c.sql.includes('from documents d'));
  assert.ok(pop, 'population query ran');
  assert.ok(pop.sql.includes("parse_status = 'completed'"));
  assert.ok(pop.sql.includes("parse_status = 'skipped' and d.document_type = 'payment_confirmation'"),
    'the deliberate skipped payment_confirmation lane stays in the population');
  assert.ok(pop.sql.includes('total_amount is not null'), 'amount-less docs never read as awaiting a line');
  assert.ok(pop.sql.includes("matched_object_type <> 'bank_line'"), 'any live doc match excludes');
  assert.ok(pop.sql.includes("in ('suggested', 'auto_matched', 'confirmed')"));
  assert.deepEqual(pop.params[2], [...RECONCILABLE_DOC_TYPES]);
});

test('sweep — a doc with an open doc-anchored owner ask is skipped (already terminal-on-owner)', async () => {
  const client = makeMockClient(sweepResponses({
    candidates: [EXXON_DOC],
    asked: [{ document_id: 'doc-exxon-1' }]
  }));
  const stats = await runDocumentDispositionForClient({
    client, firmId: 'firm-1', clientId: 'client-1', apiKeyOverride: 'sk-test',
    fetchImpl: makeFetchOk(AUTO_EXPLAIN)
  });
  assert.equal(stats.evaluated, 0);
  assert.equal(stats.skipped_already_asked, 1);
  assert.ok(!findEvalInsert(client), 'no second verdict over an open ask');
});

test('sweep — incremental guard: a current-policy verdict skips the strong call (no flip-flops, no re-spend)', async () => {
  const client = makeMockClient(sweepResponses({
    candidates: [EXXON_DOC],
    priorEvals: [{ target_id: 'doc-exxon-1' }]
  }));
  const stats = await runDocumentDispositionForClient({
    client, firmId: 'firm-1', clientId: 'client-1', apiKeyOverride: 'sk-test',
    fetchImpl: makeFetchOk(AUTO_EXPLAIN)
  });
  assert.equal(stats.evaluated, 0);
  assert.equal(stats.skipped_existing, 1);
  assert.ok(!findEvalInsert(client));
});

test("sweep — act mode's incremental guard only honours prior ACT verdicts (a shadow week must not block the canary's first settle)", async () => {
  const client = makeMockClient(sweepResponses({ candidates: [] }));
  await runDocumentDispositionForClient({
    client, firmId: 'firm-1', clientId: 'client-1', mode: 'act', apiKeyOverride: 'sk-test'
  });
  // Population empty → the guard query never runs; pin the clause on the SQL
  // via a populated run instead.
  const client2 = makeMockClient(sweepResponses({ candidates: [EXXON_DOC] }));
  await runDocumentDispositionForClient({
    client: client2, firmId: 'firm-1', clientId: 'client-1', mode: 'act',
    apiKeyOverride: 'sk-test', fetchImpl: makeFetchOk(AUTO_EXPLAIN)
  });
  const guard = client2.calls.find((c) => /^\s*select target_id\s+from reconciliation_evaluations/.test(c.sql));
  assert.ok(guard.sql.includes("is distinct from 'act' or payload->>'matcher_mode' = 'act'"),
    'act sweeps skip only prior act verdicts; shadow rows are re-evaluated');
  assert.equal(guard.params[5], 'act', 'the mode rides the guard');
});

test('sweep — documentIds scope: an explicitly scoped empty set is a no-op', async () => {
  const client = makeMockClient([]);
  const stats = await runDocumentDispositionForClient({
    client, firmId: 'firm-1', clientId: 'client-1', apiKeyOverride: 'sk-test', documentIds: []
  });
  assert.equal(stats.evaluated, 0);
  assert.equal(client.calls.length, 0, 'zero queries for an empty scope');
});

test('sweep — a transport failure on one doc falls toward a human and the sweep continues', async () => {
  const second = { ...EXXON_DOC, id: 'doc-exxon-2' };
  const client = makeMockClient(sweepResponses({ candidates: [EXXON_DOC, second] }));
  let call = 0;
  const flaky = async (...args) => {
    call += 1;
    if (call === 1) throw new Error('socket hangup');
    return makeFetchOk(AUTO_EXPLAIN)(...args);
  };
  const stats = await runDocumentDispositionForClient({
    client, firmId: 'firm-1', clientId: 'client-1', mode: 'shadow',
    apiKeyOverride: 'sk-test', fetchImpl: flaky
  });
  assert.equal(stats.evaluated, 2);
  assert.equal(stats.needs_human, 1, 'the failed doc fell to needs_human');
  assert.equal(stats.auto_explained, 1, 'the second doc still evaluated');
});

// ── Slice 4a — the ANSWER leg (owner-reply re-disposition) ────────────
// docs/donna-settlement-answer-and-ledger-entry-plan.md §2. Pins: the
// owner-reply parser mode (materiality veto lifts ONLY on a confirmed
// cash/personal channel; chase_evidence only as the single payment_method →
// statement lane change; everything unclear coerces to needs_human — the
// ping-pong guard), the reply prompt, and the orchestrator's atomicity
// contract (the request leaves the open set ONLY in the same commit as a
// successful verdict stamp).

import {
  buildOwnerReplyUserPrompt,
  runOwnerReplyRedisposition
} from './documentDispositionLlm.js';

const OWNER_REPLY_MODE = { ownerReply: { answeredEvidenceType: 'payment_method' } };

test('parser (owner-reply) — a confirmed cash/personal channel settles EVEN MATERIAL (the ask was the escalation)', () => {
  const out = parseDocumentDispositionResponse(
    JSON.stringify({ ...AUTO_EXPLAIN, materiality: 'material', settlement_channel: 'personal_card' }),
    OWNER_REPLY_MODE
  );
  assert.equal(out.disposition, 'auto_explain', 'the owner word lifts the materiality veto');
  assert.equal(out.downgraded_from, null);
  assert.equal(out.materiality, 'material', 'materiality stays honest on the receipt');
});

test('parser (owner-reply) — material WITHOUT a confirmed channel coerces to needs_human, never a re-ask', () => {
  const out = parseDocumentDispositionResponse(
    JSON.stringify({ ...AUTO_EXPLAIN, materiality: 'material', settlement_channel: 'unknown' }),
    OWNER_REPLY_MODE
  );
  assert.equal(out.disposition, 'needs_human', 'a chase_evidence downgrade would re-ask what was answered');
  assert.equal(out.downgraded_from, 'auto_explain');
  assert.equal(out.unmatchable_reason, 'owner_reply_unclear');
});

test('parser (owner-reply) — the confidence floor still binds', () => {
  const out = parseDocumentDispositionResponse(
    JSON.stringify({ ...AUTO_EXPLAIN, confidence: DEFAULT_AUTO_EXPLAIN_CONFIDENCE_FLOOR - 0.01 }),
    OWNER_REPLY_MODE
  );
  assert.equal(out.disposition, 'needs_human');
  assert.equal(out.unmatchable_reason, 'owner_reply_unclear');
});

test('parser (owner-reply) — chase_evidence is allowed ONLY as the payment_method → statement lane change', () => {
  const laneChange = parseDocumentDispositionResponse(JSON.stringify(CHASE), OWNER_REPLY_MODE);
  assert.equal(laneChange.disposition, 'chase_evidence', 'the one legitimate follow-up: a statement request');

  const wrongChannel = parseDocumentDispositionResponse(
    JSON.stringify({ ...CHASE, settlement_channel: 'unknown' }), OWNER_REPLY_MODE
  );
  assert.equal(wrongChannel.disposition, 'needs_human', 'never re-ask how it was paid');
  assert.equal(wrongChannel.downgraded_from, 'chase_evidence');

  const afterStatementAsk = parseDocumentDispositionResponse(
    JSON.stringify(CHASE), { ownerReply: { answeredEvidenceType: 'bank_statement' } }
  );
  assert.equal(afterStatementAsk.disposition, 'needs_human', 'a second automatic ask is ping-pong — a human reads it');
});

test('prompt (owner-reply) — carries the question, the lane, the reply verbatim (bounded), and the upload count', () => {
  const prompt = buildOwnerReplyUserPrompt({
    document: EXXON_DOC,
    firmContext: { bankFeedCoverage: { lineCount: 120, firstDate: '2026-01-01', lastDate: '2026-06-30' } },
    askedQuestion: 'How was this Exxon receipt paid?',
    answeredEvidenceType: 'payment_method',
    ownerReply: 'Paid cash at the pump.',
    replyDocumentCount: 2
  });
  assert.ok(prompt.includes('id=doc-exxon-1'), 'the doc header still rides');
  assert.ok(prompt.includes('(payment_method lane): "How was this Exxon receipt paid?"'));
  assert.ok(prompt.includes('The owner answered: "Paid cash at the pump."'));
  assert.ok(prompt.includes('uploaded 2 document(s)'));

  const noText = buildOwnerReplyUserPrompt({ document: EXXON_DOC, ownerReply: '' });
  assert.ok(noText.includes('The owner answered with NO text.'));
});

// Canned rows for the answer-leg flow. Same unique-substring mock as the sweep.
const replyResponses = ({
  doc = [EXXON_DOC],
  liveMatch = [],
  coverage = [{ line_count: 120, first_date: '2026-01-01', last_date: '2026-06-30' }],
  identity = [{ id: 'client-1', company_name: 'Honeybee Hills Apiary LLC', legal_names: [] }],
  beforeState = [{ before_state: null }],
  evalThrow = null
} = {}) => [
  { match: 'from documents d', rows: doc },
  { match: 'from reconciliation_matches', rows: liveMatch },
  { match: 'from transactions', rows: coverage },
  { match: 'from clients where firm_id', rows: identity },
  { match: "payload->'no_line_disposition' as before_state", rows: beforeState },
  { match: 'update documents', rows: [{ id: 'updated' }] },
  { match: 'update client_evidence_requests', rows: [{ id: 'req-1' }] },
  ...(evalThrow ? [{ match: 'insert into reconciliation_evaluations', throw: evalThrow }] : [])
];

const REPLY_ARGS = {
  firmId: 'firm-1',
  clientId: 'client-1',
  documentId: 'doc-exxon-1',
  evidenceRequestId: 'req-1',
  answeredEvidenceType: 'payment_method',
  askedQuestion: 'How was this paid?',
  ownerReply: 'my own card',
  actorId: 'op-kari'
};
const findRequestFlip = (client) =>
  client.calls.find((c) => c.sql.includes('update client_evidence_requests'));
const findResolveAudit = (client) =>
  client.calls.find((c) => c.sql.includes("'client_evidence_request'") && c.params?.[3] === 'evidence_request.resolve');

test('answer leg — an owner-confirmed settle: act-mode verdict (verdict_source owner_reply) + merge with owner_notified TRUE + request resolved, atomically', async () => {
  const client = makeMockClient(replyResponses());
  const result = await runOwnerReplyRedisposition({
    ...REPLY_ARGS, client,
    apiKeyOverride: 'sk-test',
    fetchImpl: makeFetchOk({ ...AUTO_EXPLAIN, materiality: 'material', settlement_channel: 'personal_card' })
  });
  assert.deepEqual(
    { stamped: result.stamped, settled: result.settled, request_resolved: result.request_resolved, disposition: result.disposition, skipped: result.skipped },
    { stamped: true, settled: true, request_resolved: true, disposition: 'auto_explain', skipped: null }
  );

  const ins = findEvalInsert(client);
  assert.ok(ins, 'the verdict upsert replaces the chase_evidence row (one row per doc/family)');
  assert.equal(ins.params[6], 'auto_explained');
  const payload = JSON.parse(ins.params[12]);
  assert.equal(payload.matcher_mode, 'act');
  assert.equal(payload.verdict_source, 'owner_reply');
  assert.equal(payload.evidence_request_id, 'req-1');
  assert.equal(payload.materiality, 'material', 'material + the owner word — settled honestly, not shaded');

  const merge = client.calls.find((c) => /update documents/.test(c.sql));
  assert.ok(merge, 'the settle merge ran (act mode)');
  const merged = JSON.parse(merge.params[3]);
  assert.equal(merged.no_line_disposition.owner_notified, true, 'the owner answer IS the notification — no digest FYI owed');
  assert.equal(merged.no_line_disposition.verdict_source, 'owner_reply');

  assert.equal(findAudits(client, 'document.disposition.owner_confirmed').length, 1, 'the settle audit is the owner_confirmed action');
  assert.equal(findAudits(client, 'document.disposition.auto_explained').length, 0);

  const flip = findRequestFlip(client);
  assert.ok(flip, 'the request leaves the open set');
  assert.ok(flip.sql.includes("status = 'resolved'"));
  assert.ok(flip.sql.includes("status in ('draft', 'open', 'replied')"), 'idempotent flip');
  assert.equal(flip.params[3], 'op-kari', 'resolved_by carries the actor');
  const audit = findResolveAudit(client);
  assert.ok(audit, 'the resolve is audited');
  assert.equal(JSON.parse(audit.params[5]).via, 'owner_reply_redisposition');
});

test('answer leg — an unclear answer lands needs_human (owner_reply_unclear): no merge, request still resolved for a HUMAN to read', async () => {
  const client = makeMockClient(replyResponses());
  const result = await runOwnerReplyRedisposition({
    ...REPLY_ARGS, client,
    apiKeyOverride: 'sk-test',
    fetchImpl: makeFetchOk({ ...CHASE, settlement_channel: 'unknown' })
  });
  assert.equal(result.disposition, 'needs_human');
  assert.equal(result.settled, false);
  assert.equal(result.request_resolved, true);
  const ins = findEvalInsert(client);
  assert.equal(ins.params[6], 'no_match');
  assert.equal(ins.params[7], 'owner_reply_unclear');
  assert.ok(!client.calls.some((c) => /update documents/.test(c.sql)), 'nothing settles');
});

test('answer leg — the lane change (statement request) resolves the answered ask so the batch drafter re-gathers off the new verdict', async () => {
  const client = makeMockClient(replyResponses());
  const result = await runOwnerReplyRedisposition({
    ...REPLY_ARGS, client,
    apiKeyOverride: 'sk-test',
    fetchImpl: makeFetchOk(CHASE)
  });
  assert.equal(result.disposition, 'chase_evidence');
  assert.equal(result.request_resolved, true);
  const ins = findEvalInsert(client);
  assert.equal(ins.params[7], 'evidence_needed', 'the reason the Slice-3 drafter keys on — the statement ask rides the next batch');
});

test('answer leg — a live match arriving while the ask was out makes it moot: request resolved, NO re-disposition, NO model call', async () => {
  const client = makeMockClient(replyResponses({ liveMatch: [{ ok: 1 }] }));
  const result = await runOwnerReplyRedisposition({
    ...REPLY_ARGS, client,
    apiKeyOverride: 'sk-test',
    fetchImpl: async () => { throw new Error('must not be called'); }
  });
  assert.equal(result.skipped, 'live_match');
  assert.equal(result.request_resolved, true);
  assert.ok(!findEvalInsert(client), 'INV-4: the match outranks any verdict');
  assert.equal(JSON.parse(findResolveAudit(client).params[5]).via, 'live_match');
});

test('answer leg — no api key: nothing stamped, nothing resolved — the reply stays visible for a re-drive (RT-10)', async () => {
  // Pre-RT-10 this stamped a needs_human off an infrastructure gap AND
  // resolved the ask — the answer consumed by nobody. A missing key is no
  // judgment: the request rests 'replied' (F8's owner_answered_processing).
  const client = makeMockClient(replyResponses());
  const result = await runOwnerReplyRedisposition({ ...REPLY_ARGS, client, apiKeyOverride: '' });
  assert.equal(result.skipped, 'no_api_key');
  assert.equal(result.stamped, false);
  assert.equal(result.request_resolved, false);
  assert.ok(!findEvalInsert(client), 'no verdict from an outage');
  assert.ok(!findRequestFlip(client), 'the owner answer survives');
});

test('answer leg — a failed verdict stamp leaves the request replied (never a resolved-request/stale-verdict split the sweep would re-ask)', async () => {
  const client = makeMockClient(replyResponses({ evalThrow: new Error('db down') }));
  const result = await runOwnerReplyRedisposition({
    ...REPLY_ARGS, client,
    apiKeyOverride: 'sk-test',
    fetchImpl: makeFetchOk(AUTO_EXPLAIN)
  });
  assert.equal(result.stamped, false);
  assert.equal(result.request_resolved, false);
  assert.ok(!findRequestFlip(client), 'no flip without a new verdict');
});

test('answer leg — missing document: nothing stamped, nothing flipped', async () => {
  const client = makeMockClient(replyResponses({ doc: [] }));
  const result = await runOwnerReplyRedisposition({
    ...REPLY_ARGS, client, apiKeyOverride: 'sk-test', fetchImpl: makeFetchOk(AUTO_EXPLAIN)
  });
  assert.equal(result.skipped, 'document_not_found');
  assert.ok(!findEvalInsert(client));
  assert.ok(!findRequestFlip(client));
});

// ── F1 — deterministic materiality ceiling (parser Keep-layer guard) ──
// The unprompted sweep refuses a >$ceiling auto_explain regardless of the
// model's own materiality label (→ chase_evidence, on the owner). The
// owner-reply leg is EXEMPT: the ask was the material escalation and the
// answer resolves it.

test('parser — F1: auto_explain ABOVE the ceiling downgrades to chase_evidence with the receipt', () => {
  const out = parseDocumentDispositionResponse(
    JSON.stringify(AUTO_EXPLAIN),
    { amount: 900, materialityCeiling: 500 }
  );
  assert.equal(out.disposition, 'chase_evidence', 'the deterministic ceiling overrides the model label');
  assert.equal(out.downgraded_from, 'auto_explain');
  assert.equal(out.materiality_ceiling, 500, 'the resolved ceiling rides the receipt');
});

test('parser — F1: at/below the ceiling the model keeps its judgment (+ ceiling receipted)', () => {
  const out = parseDocumentDispositionResponse(
    JSON.stringify(AUTO_EXPLAIN),
    { amount: 55.98, materialityCeiling: 500 }
  );
  assert.equal(out.disposition, 'auto_explain');
  assert.equal(out.downgraded_from, null);
  assert.equal(out.materiality_ceiling, 500);
});

test('parser — F1: the owner-reply leg is EXEMPT from the ceiling (the answer resolves the escalation)', () => {
  const out = parseDocumentDispositionResponse(
    JSON.stringify({ ...AUTO_EXPLAIN, materiality: 'material', settlement_channel: 'cash', funding_source:'owner' }),
    { ...OWNER_REPLY_MODE, amount: 5000, materialityCeiling: 500 }
  );
  assert.equal(out.disposition, 'auto_explain', 'a clear owner answer settles even a material amount');
  assert.equal(out.materiality_ceiling, null, 'no ceiling bound this verdict — receipted as such');
});

// ── F5 — sweep bound (counted) + per-doc transaction posture ──────────
test('sweep — F5: the model-call bound is COUNTED (truncated_remainder), and each stamp commits per doc', async () => {
  process.env.DOCUMENT_DISPOSITION_SWEEP_LIMIT = '1';
  try {
    const client = makeMockClient([
      { match: 'from documents d', rows: [
        { id: 'doc-a', document_type: 'receipt', vendor_name: 'Exxon', filename: 'a.pdf', total_amount: 40, currency: 'USD', document_date: '2026-05-01', payment_status: 'paid' },
        { id: 'doc-b', document_type: 'receipt', vendor_name: 'Shell', filename: 'b.pdf', total_amount: 30, currency: 'USD', document_date: '2026-05-02', payment_status: 'paid' }
      ] },
      { match: 'from client_evidence_requests', rows: [] },
      { match: 'from reconciliation_evaluations', rows: [] },
      { match: 'from transactions', rows: [{ line_count: 10, first_date: '2026-01-01', last_date: '2026-06-30' }] },
      { match: 'from clients where firm_id', rows: [{ id: 'client-1', company_name: 'Honeybee Hills Apiary LLC', legal_names: [] }] }
    ]);
    const stats = await runDocumentDispositionForClient({
      client, firmId: 'firm-1', clientId: 'client-1', mode: 'shadow',
      apiKeyOverride: 'sk-test', fetchImpl: makeFetchOk(AUTO_EXPLAIN)
    });
    assert.equal(stats.evaluated, 1, 'model calls bounded per sweep');
    assert.equal(stats.truncated_remainder, 1, 'the remainder is counted, never silent');
    const begins = client.calls.filter((c) => c.sql.trim().toLowerCase() === 'begin').length;
    const commits = client.calls.filter((c) => c.sql.trim().toLowerCase() === 'commit').length;
    assert.equal(begins, 1, 'one mini-transaction per stamped doc');
    assert.equal(commits, 1);
    const firstBegin = client.calls.findIndex((c) => c.sql.trim().toLowerCase() === 'begin');
    const gather = client.calls.findIndex((c) => c.sql.includes('from documents d'));
    assert.ok(firstBegin > gather, 'no transaction open during the gather / model call');
  } finally {
    delete process.env.DOCUMENT_DISPOSITION_SWEEP_LIMIT;
  }
});

// ── F3 — the act-mode merge reconciles on EVERY verdict ───────────────
test('sweep — F3: a superseding chase verdict UNWINDS a stale settle (removal + audited before_state)', async () => {
  const client = makeMockClient(sweepResponses({
    candidates: [EXXON_DOC],
    docRow: [{ before_state: { disposition: 'auto_explain', owner_notified: true }, settlement_journal_id: '' }]
  }));
  const stats = await runDocumentDispositionForClient({
    client, firmId: 'firm-1', clientId: 'client-1', mode: 'act',
    apiKeyOverride: 'sk-test', fetchImpl: makeFetchOk(CHASE)
  });
  assert.equal(stats.superseded, 1, 'the stale holder is counted as superseded');
  assert.deepEqual(stats.settled_doc_ids, [], 'nothing settled');
  const removal = client.calls.find((c) => c.sql.includes("- 'no_line_disposition'"));
  assert.ok(removal, 'the stale settle object is removed so every reader re-renders off the fresh verdict row');
  const audits = findAudits(client, 'document.disposition.superseded');
  assert.equal(audits.length, 1, 'the supersede is audited');
  const meta = JSON.parse(audits[0].params[4]);
  assert.equal(meta.before_state.disposition, 'auto_explain', 'reversibility: the removed holder rides the audit');
});

test('sweep — F3: a supersede is REFUSED (and receipted) when a settlement journal was already posted', async () => {
  const client = makeMockClient(sweepResponses({
    candidates: [EXXON_DOC],
    docRow: [{ before_state: { disposition: 'auto_explain', owner_notified: false }, settlement_journal_id: 'lj-settle-1' }]
  }));
  const stats = await runDocumentDispositionForClient({
    client, firmId: 'firm-1', clientId: 'client-1', mode: 'act',
    apiKeyOverride: 'sk-test', fetchImpl: makeFetchOk(CHASE)
  });
  assert.equal(stats.superseded, 0, 'no silent un-settle under a posted journal (doc/ledger split-brain)');
  assert.ok(!client.calls.some((c) => c.sql.includes("- 'no_line_disposition'")), 'the holder is kept');
  const blocked = findAudits(client, 'document.disposition.supersede_blocked');
  assert.equal(blocked.length, 1, 'the refusal is receipted');
  assert.equal(JSON.parse(blocked[0].params[4]).settlement_journal_id, 'lj-settle-1');
});

test('sweep — F3: a RE-settle preserves an already-true owner_notified (no duplicate FYI re-arm)', async () => {
  const client = makeMockClient(sweepResponses({
    candidates: [EXXON_DOC],
    docRow: [{ before_state: { disposition: 'auto_explain', owner_notified: true }, settlement_journal_id: '' }]
  }));
  await runDocumentDispositionForClient({
    client, firmId: 'firm-1', clientId: 'client-1', mode: 'act',
    apiKeyOverride: 'sk-test', fetchImpl: makeFetchOk(AUTO_EXPLAIN)
  });
  const merge = client.calls.find((c) => /update documents/.test(c.sql) && c.params?.length === 4);
  assert.ok(merge, 'the re-settle merge ran');
  assert.equal(JSON.parse(merge.params[3]).no_line_disposition.owner_notified, true,
    'the sweep default (false) must not re-enter the doc into the FYI gather');
});

// ── The #1748 shape (2026-08-19 follow-up): a seated non-claude rung ──
// decides the doc disposition keyless over the compatible endpoint; an
// active policy with no endpoint fails LOUD; transport-class failures under
// the policy skip the stamp (the incremental guard re-picks); a mismatch
// aborts the sweep with nothing stamped.

const Q7_POLICY = { deciding_model: 'qwen/qwen3.8-27b', basis: 'experiment' };
const setCompatibleEnv = () => {
  process.env.OPENAI_COMPATIBLE_BASE_URL = 'https://compat.test/v1';
  process.env.OPENAI_COMPATIBLE_API_KEY = 'sk-compat';
};
const clearCompatibleEnv = () => {
  delete process.env.OPENAI_COMPATIBLE_BASE_URL;
  delete process.env.OPENAI_COMPATIBLE_API_KEY;
};
const compatibleFetchOk = (responseBody, seen = [], servedModel = 'qwen/qwen3.8-27b') => async (url, init) => {
  seen.push({ url, body: JSON.parse(init.body) });
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({
      model: servedModel,
      choices: [{ message: { content: typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody) } }],
      usage: { prompt_tokens: 200, completion_tokens: 40, total_tokens: 240 }
    })
  };
};

test('policy — a seated non-claude rung does NOT require the Anthropic key: keyless sweep decides over the compatible endpoint, stamp carries policy_basis + the response model (Kari, 2026-08-19)', async () => {
  setCompatibleEnv();
  try {
    const seen = [];
    const client = makeMockClient(sweepResponses({ candidates: [EXXON_DOC] }));
    const stats = await runDocumentDispositionForClient({
      client, firmId: 'firm-1', clientId: 'client-1', mode: 'shadow',
      apiKeyOverride: '', decidingPolicy: Q7_POLICY,
      fetchImpl: compatibleFetchOk(AUTO_EXPLAIN, seen)
    });
    assert.notEqual(stats.disabled_reason, 'no_anthropic_api_key',
      'choosing qwen must never require an Anthropic key');
    assert.equal(stats.evaluated, 1);
    assert.equal(stats.auto_explained, 1);

    assert.equal(seen.length, 1, 'the rung decided — over the compatible endpoint, never anthropic');
    assert.equal(seen[0].url, 'https://compat.test/v1/chat/completions');
    assert.equal(seen[0].body.model, 'qwen/qwen3.8-27b');
    const sentUser = seen[0].body.messages.find((m) => m.role === 'user')?.content;
    assert.ok(sentUser.includes('id=doc-exxon-1'), 'the exact disposition user prompt rode the compatible transport');

    const ins = findEvalInsert(client);
    assert.ok(ins);
    assert.equal(ins.params[11], 'qwen/qwen3.8-27b', 'the eval stamp carries the provider-RESPONSE model id');
    const payload = JSON.parse(ins.params[12]);
    assert.equal(payload.policy_basis, 'experiment');
    assert.equal(payload.policy_model, 'qwen/qwen3.8-27b');
    assert.equal(payload.model_source, 'response_proven');
  } finally {
    clearCompatibleEnv();
  }
});

test('policy — an active policy with no compatible endpoint fails LOUD before any read: policy_endpoint_unconfigured', async () => {
  clearCompatibleEnv();
  const client = makeMockClient([]);
  const stats = await runDocumentDispositionForClient({
    client, firmId: 'firm-1', clientId: 'client-1',
    apiKeyOverride: 'sk-test', decidingPolicy: Q7_POLICY
  });
  assert.equal(stats.disabled, true);
  assert.equal(stats.disabled_reason, 'policy_endpoint_unconfigured',
    'never a silent fallback to the strong model mid-experiment');
  assert.ok(client.calls.every(c => /from (client_capability_config|cohort_capability_config)/.test(c.sql)), 'only routing configuration is read — nothing evaluated or stamped');
});

test('policy — mismatch guard: an endpoint attesting a DIFFERENT model aborts the sweep, NOTHING stamped', async () => {
  setCompatibleEnv();
  try {
    const client = makeMockClient(sweepResponses({ candidates: [EXXON_DOC] }));
    const stats = await runDocumentDispositionForClient({
      client, firmId: 'firm-1', clientId: 'client-1', mode: 'shadow',
      apiKeyOverride: '', decidingPolicy: Q7_POLICY,
      fetchImpl: compatibleFetchOk(AUTO_EXPLAIN, [], 'some-other-loaded-model')
    });
    assert.equal(stats.aborted_reason, 'policy_model_mismatch');
    assert.ok(!findEvalInsert(client),
      'a mismatched reply must not persist under either model id — not even as needs_human');
  } finally {
    clearCompatibleEnv();
  }
});

test('policy — a transport-class failure under the policy skips the stamp (counted) so the incremental guard re-picks the doc', async () => {
  setCompatibleEnv();
  try {
    const client = makeMockClient(sweepResponses({ candidates: [EXXON_DOC] }));
    const stats = await runDocumentDispositionForClient({
      client, firmId: 'firm-1', clientId: 'client-1', mode: 'shadow',
      apiKeyOverride: '', decidingPolicy: Q7_POLICY,
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); }
    });
    assert.equal(stats.transport_failures, 1);
    assert.equal(stats.needs_human, 0, 'no model judgment existed — not a needs_human');
    assert.ok(!findEvalInsert(client), 'no stamp — the doc stays unevaluated for the next sweep');
  } finally {
    clearCompatibleEnv();
  }
});

test('policy — the KEYED path is byte-identical: a transport error with NO policy still stamps the historical fail-closed needs_human', async () => {
  const client = makeMockClient(sweepResponses({ candidates: [EXXON_DOC] }));
  const stats = await runDocumentDispositionForClient({
    client, firmId: 'firm-1', clientId: 'client-1', mode: 'shadow',
    apiKeyOverride: 'sk-test', fetchImpl: async () => { throw new Error('ECONNREFUSED'); }
  });
  assert.equal(stats.needs_human, 1);
  assert.equal(stats.transport_failures, 0, 'the keyed path never sets the policy-path marker');
  const ins = findEvalInsert(client);
  assert.ok(ins, 'the historical fail-closed stamp is unchanged');
  assert.equal(ins.params[7], 'transport_error');
});

test('answer leg (policy) — a seated rung decides the re-disposition keyless over the compatible endpoint', async () => {
  setCompatibleEnv();
  try {
    const seen = [];
    const client = makeMockClient(replyResponses());
    const result = await runOwnerReplyRedisposition({
      ...REPLY_ARGS, client,
      apiKeyOverride: '', decidingPolicy: Q7_POLICY,
      fetchImpl: compatibleFetchOk({ ...AUTO_EXPLAIN, settlement_channel: 'personal_card' }, seen)
    });
    assert.equal(result.disposition, 'auto_explain');
    assert.equal(result.request_resolved, true);
    assert.equal(seen[0].url, 'https://compat.test/v1/chat/completions');
    const payload = JSON.parse(findEvalInsert(client).params[12]);
    assert.equal(payload.policy_basis, 'experiment');
    assert.equal(payload.verdict_source, 'owner_reply');
  } finally {
    clearCompatibleEnv();
  }
});

test('answer leg (policy) — no endpoint / transport failure: NOTHING stamped or resolved, the reply is preserved for a re-drive', async () => {
  clearCompatibleEnv();
  const unconfigured = makeMockClient([]);
  const refused = await runOwnerReplyRedisposition({
    ...REPLY_ARGS, client: unconfigured,
    apiKeyOverride: 'sk-test', decidingPolicy: Q7_POLICY
  });
  assert.equal(refused.skipped, 'policy_endpoint_unconfigured');
  assert.equal(refused.stamped, false);
  assert.equal(refused.request_resolved, false, 'the request stays replied — visible, the answer preserved');
  assert.ok(unconfigured.calls.every(c => /from (client_capability_config|cohort_capability_config)/.test(c.sql)), 'only routing configuration is read');

  setCompatibleEnv();
  try {
    const client = makeMockClient(replyResponses());
    const result = await runOwnerReplyRedisposition({
      ...REPLY_ARGS, client,
      apiKeyOverride: '', decidingPolicy: Q7_POLICY,
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); }
    });
    assert.equal(result.skipped, 'transport_failure');
    assert.ok(!findEvalInsert(client), 'no junk verdict off an HTTP error');
    assert.ok(!findRequestFlip(client), 'the request is not consumed — the owner answer survives for a re-drive');
  } finally {
    clearCompatibleEnv();
  }
});


// ── RT-10 (audit F-08) — the needs_human LANE ─────────────────────────────
// A needs_human verdict is a transition, never a resting state: a judgment
// verdict mints an OWNER ask in the stamp's own transaction; a technical one
// (no model judgment existed) schedules a bounded MACHINE re-run. The lane
// rides the verdict payload. Writers are injected (laneDeps) so the mock
// client never reaches the real ask writer / job queue.

const NEEDS_HUMAN = {
  disposition: 'needs_human', materiality: 'material', expense_kind: 'unknown',
  settlement_channel: 'unknown', confidence: 0.4,
  reasoning: 'Could be a personal purchase; only the owner can say.'
};
const makeLaneStubs = () => {
  const mints = [];
  const enqueues = [];
  return {
    mints,
    enqueues,
    laneDeps: {
      mintOwnerAsk: async (args) => {
        mints.push(args);
        if (args.mintOutcome) args.mintOutcome.minted = true;
        return { id: `ask-${args.documentId}`, status: 'open' };
      },
      enqueueRerun: async (args) => { enqueues.push(args); return { id: 41 }; }
    }
  };
};
const laneOfInsert = (client) => JSON.parse(findEvalInsert(client).params[12]).lane;

test('RT-10 sweep — a JUDGMENT needs_human mints the owner ask in the stamp transaction and the verdict carries the lane', async () => {
  const client = makeMockClient(sweepResponses({ candidates: [EXXON_DOC] }));
  const stubs = makeLaneStubs();
  const stats = await runDocumentDispositionForClient({
    client, firmId: 'firm-1', clientId: 'client-1', mode: 'shadow',
    apiKeyOverride: 'sk-test', fetchImpl: makeFetchOk(NEEDS_HUMAN), laneDeps: stubs.laneDeps
  });
  assert.equal(stats.needs_human, 1);
  assert.equal(stats.owner_asks_minted, 1, 'the lane is counted');
  assert.equal(stubs.mints.length, 1);
  assert.equal(stubs.mints[0].documentId, 'doc-exxon-1');
  assert.equal(stubs.mints[0].evidenceType, 'business_purpose');
  assert.equal(stubs.mints[0].requestContext.lane, 'needs_human_disposition');
  assert.equal(stubs.mints[0].client, client, 'minted through the sweep\'s own client (same mini-transaction)');
  assert.match(stubs.mints[0].question, /Exxon/);
  assert.match(stubs.mints[0].question, /how does it relate to your business/);
  assert.doesNotMatch(stubs.mints[0].question, /only the owner can say/);
  const lane = laneOfInsert(client);
  assert.equal(lane.kind, 'owner_ask');
  assert.equal(lane.evidence_request_id, 'ask-doc-exxon-1');
  assert.equal(lane.minted, true);
  assert.equal(findAudits(client, 'document.disposition.owner_asked').length, 1, 'receipted');
  assert.equal(stubs.enqueues.length, 0, 'a judgment never schedules a machine re-run');
  // Shadow mode too — ask existence is never plane-gated (the stamp above
  // ran in shadow); the settling merge stays act-only.
  assert.ok(!client.calls.find((c) => c.sql.includes("|| $4::jsonb") && c.sql.includes('update documents')), 'no settle merge in shadow');
});

test('RT-10 sweep — a TECHNICAL needs_human schedules a bounded machine re-run (no ask), and the verdict carries the due lane', async () => {
  const client = makeMockClient(sweepResponses({ candidates: [EXXON_DOC] }));
  const stubs = makeLaneStubs();
  const stats = await runDocumentDispositionForClient({
    client, firmId: 'firm-1', clientId: 'client-1', mode: 'act',
    apiKeyOverride: 'sk-test', fetchImpl: makeFetchOk('not json at all {{{'), laneDeps: stubs.laneDeps
  });
  assert.equal(stats.needs_human, 1, 'an unparseable reply falls to needs_human…');
  assert.equal(stats.reruns_scheduled, 1, '…on the MACHINE lane');
  assert.equal(stubs.mints.length, 0, 'never an ask minted from a garbled reply');
  assert.equal(stubs.enqueues.length, 1);
  assert.equal(stubs.enqueues[0].functionId, 'document-terminal-drain');
  assert.equal(stubs.enqueues[0].dedupeKey, 'machine-rerun:document_no_line_disposition:doc-exxon-1:1');
  assert.equal(stubs.enqueues[0].client, client, 'enqueued in the same transaction');
  const lane = laneOfInsert(client);
  assert.equal(lane.kind, 'machine_rerun');
  assert.equal(lane.attempt, 1);
  assert.equal(lane.max_attempts, MACHINE_RERUN_MAX_ATTEMPTS);
  assert.equal(lane.reason, 'invalid_llm_response');
  assert.equal(lane.job_id, 41);
  assert.ok(new Date(lane.due_at).getTime() > Date.now(), 'due in the future');
  assert.equal(findAudits(client, 'document.disposition.machine_rerun_scheduled').length, 1);
});

test('RT-10 sweep — the machine re-run is bounded: past MACHINE_RERUN_MAX_ATTEMPTS the lane rests exhausted, surfaced, no job', async () => {
  const client = makeMockClient([
    ...sweepResponses({ candidates: [EXXON_DOC] }),
    { match: "payload->'lane' as lane", rows: [{ lane: { kind: 'machine_rerun', attempt: MACHINE_RERUN_MAX_ATTEMPTS, due_at: '2026-01-01T00:00:00.000Z' } }] }
  ]);
  const stubs = makeLaneStubs();
  const stats = await runDocumentDispositionForClient({
    client, firmId: 'firm-1', clientId: 'client-1', mode: 'act',
    apiKeyOverride: 'sk-test', fetchImpl: makeFetchOk('garbage'), laneDeps: stubs.laneDeps
  });
  assert.equal(stats.lanes_exhausted, 1);
  assert.equal(stubs.enqueues.length, 0);
  assert.equal(stubs.mints.length, 0, 'a system failure is never laundered into an owner question');
  const lane = laneOfInsert(client);
  assert.equal(lane.kind, 'machine_rerun_exhausted');
  assert.equal(lane.attempts, MACHINE_RERUN_MAX_ATTEMPTS);
  assert.equal(findAudits(client, 'document.disposition.machine_rerun_exhausted').length, 1);
});

test('RT-10 sweep — the owner ask is bounded: two prior asks on the document ⇒ owner_ask_exhausted, no third nag', async () => {
  const client = makeMockClient([
    ...sweepResponses({ candidates: [EXXON_DOC] }),
    { match: "coalesce(audience, 'client') = 'client'", rows: [{ n: OWNER_ASK_MAX_GENERATIONS }] }
  ]);
  const stubs = makeLaneStubs();
  const stats = await runDocumentDispositionForClient({
    client, firmId: 'firm-1', clientId: 'client-1', mode: 'act',
    apiKeyOverride: 'sk-test', fetchImpl: makeFetchOk(NEEDS_HUMAN), laneDeps: stubs.laneDeps
  });
  assert.equal(stats.lanes_exhausted, 1);
  assert.equal(stubs.mints.length, 0);
  assert.equal(laneOfInsert(client).kind, 'owner_ask_exhausted');
  assert.equal(findAudits(client, 'document.disposition.owner_ask_exhausted').length, 1);
});

test('RT-10 sweep — a failed ask mint fails the per-doc transaction: a needs_human verdict cannot commit without its lane', async () => {
  const client = makeMockClient(sweepResponses({ candidates: [EXXON_DOC] }));
  const stats = await runDocumentDispositionForClient({
    client, firmId: 'firm-1', clientId: 'client-1', mode: 'act',
    apiKeyOverride: 'sk-test', fetchImpl: makeFetchOk(NEEDS_HUMAN),
    laneDeps: { mintOwnerAsk: async () => { throw new Error('ask writer down'); } }
  });
  assert.equal(stats.stamp_failures, 1);
  assert.equal(stats.owner_asks_minted, 0);
  assert.ok(client.calls.some((c) => c.sql.trim().toLowerCase() === 'rollback'), 'rolled back');
  assert.ok(!findEvalInsert(client), 'no verdict row without its lane');
});

test('RT-10 sweep — the incremental guard re-picks a DUE machine re-run (the scheduled re-run actually re-evaluates)', async () => {
  const client = makeMockClient(sweepResponses({ candidates: [EXXON_DOC] }));
  await runDocumentDispositionForClient({
    client, firmId: 'firm-1', clientId: 'client-1', mode: 'act',
    apiKeyOverride: 'sk-test', fetchImpl: makeFetchOk(AUTO_EXPLAIN)
  });
  const guard = client.calls.find((c) => /^\s*select target_id\s+from reconciliation_evaluations/.test(c.sql));
  assert.ok(guard.sql.includes("payload->'lane'->>'kind' = 'machine_rerun'"), 'the guard knows the lane');
  assert.ok(guard.sql.includes("(payload->'lane'->>'due_at')::timestamptz, now()) <= now()"), 'and re-picks it once due');
  assert.ok(guard.sql.includes("is distinct from 'act' or payload->>'matcher_mode' = 'act'"), 'the act/shadow clause is intact');
});

test('RT-10 helpers — the technical set, the backoff ladder, the owner question', () => {
  assert.equal(isTechnicalNeedsHuman({ disposition: 'needs_human', unmatchable_reason: 'transport_error' }), true);
  assert.equal(isTechnicalNeedsHuman({ disposition: 'needs_human', unmatchable_reason: 'api_error_503' }), true);
  assert.equal(isTechnicalNeedsHuman({ disposition: 'needs_human', unmatchable_reason: null }), false, 'the default reason is a judgment');
  assert.equal(isTechnicalNeedsHuman({ disposition: 'needs_human', unmatchable_reason: 'owner_reply_unclear' }), false);
  assert.equal(isTechnicalNeedsHuman({ disposition: 'chase_evidence', unmatchable_reason: 'transport_error' }), false);
  const t0 = Date.parse('2026-09-02T10:00:00.000Z');
  assert.equal(machineRerunDueAt(1, t0), '2026-09-02T10:10:00.000Z');
  assert.equal(machineRerunDueAt(2, t0), '2026-09-02T11:00:00.000Z');
  assert.equal(machineRerunDueAt(3, t0), '2026-09-02T16:00:00.000Z');
  assert.equal(machineRerunDueAt(9, t0), '2026-09-02T16:00:00.000Z', 'clamped to the ladder');
  const q = buildNeedsHumanOwnerQuestion({ document: EXXON_DOC, semantic: NEEDS_HUMAN });
  assert.match(q, /the receipt from Exxon for USD 41\.20 dated 2026-05-14 \(exxon-receipt\.pdf\)/);
  assert.match(q, /how does it relate to your business/);
});

test('RT-10 answer leg — an UNCLEAR reply gets ONE bounded clarification ask after the answered request is resolved', async () => {
  const client = makeMockClient(replyResponses());
  const stubs = makeLaneStubs();
  const unclear = { ...NEEDS_HUMAN, reasoning: 'The answer does not say how it was paid.' };
  const result = await runOwnerReplyRedisposition({
    ...REPLY_ARGS, client, apiKeyOverride: 'sk-test', fetchImpl: makeFetchOk(unclear), laneDeps: stubs.laneDeps
  });
  assert.equal(result.disposition, 'needs_human');
  assert.equal(result.stamped, true);
  assert.equal(result.request_resolved, true, 'the answered request is consumed…');
  assert.equal(stubs.mints.length, 1, '…and one clarification is asked');
  assert.equal(stubs.mints[0].evidenceType, 'payment_method', 'phrased for the lane that was answered');
  assert.equal(stubs.mints[0].requestContext.lane, 'owner_reply_clarification');
  assert.equal(stubs.mints[0].requestContext.prior_evidence_request_id, 'req-1');
  assert.match(stubs.mints[0].question, /could not tell from your answer/);
  assert.equal(result.lane.kind, 'owner_ask');
  assert.equal(result.lane.clarification, true);
  assert.equal(result.clarification_request_id, 'ask-doc-exxon-1');
  // Ordering: the flip of the answered request precedes the mint.
  const flipIdx = client.calls.findIndex((c) => c.sql.includes('update client_evidence_requests'));
  const laneIdx = client.calls.findIndex((c) => c.sql.includes('update reconciliation_evaluations') && c.sql.includes('payload = coalesce(payload'));
  assert.ok(flipIdx !== -1 && laneIdx > flipIdx, 'resolve first, then the lane lands on the verdict row');
  assert.equal(findAudits(client, 'document.disposition.owner_asked').length, 1);
});

// Owner language: the code-built document questions are written in the
// owner's language (preferredOwnerTemplateLanguage); English is byte-identical.
const FI_DOC = {
  id: 'doc-fi-1', document_type: 'receipt', vendor_name: 'Kahvila Esimerkki Oy', total_amount: '1234.5',
  currency: 'EUR', document_date: '2025-02-03', filename: 'kuitti-0203.pdf'
};
const CASH_QUESTION = { owner_question: 'The receipt shows a cash payment. Was it paid from company cash or from your personal funds?', owner_question_evidence_type: 'payment_method' };

test('owner language — the needs-human question and its wrapper, in Finnish and byte-identical English', () => {
  assert.equal(buildNeedsHumanOwnerQuestion({ document: FI_DOC, semantic: NEEDS_HUMAN }),
    'About the receipt from Kahvila Esimerkki Oy for EUR 1234.50 dated 2025-02-03 (kuitti-0203.pdf): What is this document for, and how does it relate to your business?');
  assert.equal(buildNeedsHumanOwnerQuestion({ document: FI_DOC, semantic: NEEDS_HUMAN, language: 'fi' }),
    'Kuitti (Kahvila Esimerkki Oy, 1234,50 EUR, päivätty 3.2.2025, kuitti-0203.pdf): Mitä tämä tosite koskee, ja miten se liittyy yrityksesi toimintaan?');
  // The forced cash-funding question keeps its English receipt and reads Finnish to a Finnish owner.
  assert.equal(buildNeedsHumanOwnerQuestion({ document: FI_DOC, semantic: CASH_QUESTION }),
    `About the receipt from Kahvila Esimerkki Oy for EUR 1234.50 dated 2025-02-03 (kuitti-0203.pdf): ${CASH_QUESTION.owner_question}`);
  assert.equal(buildNeedsHumanOwnerQuestion({ document: FI_DOC, semantic: CASH_QUESTION, language: 'fi' }),
    'Kuitti (Kahvila Esimerkki Oy, 1234,50 EUR, päivätty 3.2.2025, kuitti-0203.pdf): Kuitin mukaan se maksettiin käteisellä. Maksettiinko se yrityksen kassasta vai omista rahoistasi?');
  const forced = parseDocumentDispositionResponse(JSON.stringify({ ...AUTO_EXPLAIN, settlement_channel: 'cash', funding_source: 'unknown' }));
  assert.equal(forced.owner_question, CASH_QUESTION.owner_question, 'the parser stores the one English fact');
  // A model-drafted question passes through as written; only the wrapper changes.
  assert.equal(buildNeedsHumanOwnerQuestion({ document: { document_type: 'supplier_bill' }, semantic: { owner_question: 'Mihin hankinta liittyi?', owner_question_evidence_type: 'business_purpose' }, language: 'fi' }),
    'Ostolasku: Mihin hankinta liittyi?');
});

test('owner language — the second-round clarification questions, in Finnish and byte-identical English', () => {
  assert.equal(buildOwnerReplyClarificationQuestion({ document: FI_DOC }),
    "Thanks — we could not tell from your answer how the receipt from Kahvila Esimerkki Oy (kuitti-0203.pdf) was paid. Was it cash, a personal card, or a business account we don't yet have statements for?");
  assert.equal(buildOwnerReplyClarificationQuestion({ document: FI_DOC, answeredEvidenceType: 'bank_statement' }),
    "Thanks — we still could not tell which account paid the receipt from Kahvila Esimerkki Oy (kuitti-0203.pdf). Which bank or card account was it, and could you upload that account's statement for the period?");
  assert.equal(buildOwnerReplyClarificationQuestion({ document: FI_DOC, language: 'fi' }),
    'Kuitti (Kahvila Esimerkki Oy, kuitti-0203.pdf): Kiitos vastauksestasi! Emme pystyneet päättelemään vastauksestasi, miten se maksettiin. Maksettiinko se käteisellä, omalla kortillasi vai yrityksen tililtä, jonka tiliotteita meillä ei vielä ole?');
  assert.equal(buildOwnerReplyClarificationQuestion({ document: FI_DOC, answeredEvidenceType: 'bank_statement', language: 'fi' }),
    'Kuitti (Kahvila Esimerkki Oy, kuitti-0203.pdf): Kiitos vastauksestasi! Emme vieläkään pystyneet päättelemään, miltä tililtä se maksettiin. Mikä pankki- tai korttitili se oli? Voisitko lähettää sen tilin tiliotteen kyseiseltä kaudelta?');
});

test('owner language — both mint paths read the owner language from the client profile', async () => {
  const sweepClient = makeMockClient([...sweepResponses({ candidates: [EXXON_DOC] }), { match: 'select jurisdiction, profile from clients', rows: [{ profile: { jurisdiction: 'FI' } }] }]);
  const sweepStubs = makeLaneStubs();
  await runDocumentDispositionForClient({
    client: sweepClient, firmId: 'firm-1', clientId: 'client-1', mode: 'shadow',
    apiKeyOverride: 'sk-test', fetchImpl: makeFetchOk(NEEDS_HUMAN), laneDeps: sweepStubs.laneDeps
  });
  assert.match(sweepStubs.mints[0].question, /^Kuitti \(Exxon, 41,20 USD, päivätty 14\.5\.2026, exxon-receipt\.pdf\): Mitä tämä tosite koskee/);
  const replyClient = makeMockClient([...replyResponses(), { match: 'select jurisdiction, profile from clients', rows: [{ profile: { locale: 'fi-FI' } }] }]);
  const replyStubs = makeLaneStubs();
  await runOwnerReplyRedisposition({
    ...REPLY_ARGS, client: replyClient, apiKeyOverride: 'sk-test', fetchImpl: makeFetchOk(NEEDS_HUMAN), laneDeps: replyStubs.laneDeps
  });
  assert.match(replyStubs.mints[0].question, /Kiitos vastauksestasi! Emme pystyneet päättelemään vastauksestasi/);
});

// The model drafts owner_question; the prompt is told the owner's language for
// that one owner-facing field (askPipeline's drafter rule). Recorded provider:
// the request bodies are captured, the reply is synthetic bytes.
const recordedProvider = (reply, bodies) => async (_url, init) => {
  bodies.push(JSON.parse(init.body));
  return { ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify(reply) }] }) };
};
const systemOf = (body) => (typeof body.system === 'string' ? body.system : (body.system || []).map((b) => b.text).join(''));
const FI_DRAFT = { ...NEEDS_HUMAN, owner_question: 'Mihin tämä ostos liittyi?', owner_question_evidence_type: 'business_purpose' };

test('owner language — the sweep prompt carries the owner language for owner_question only', async () => {
  const sweep = async (profile, reply) => {
    const bodies = [];
    const stubs = makeLaneStubs();
    await runDocumentDispositionForClient({
      client: makeMockClient([...sweepResponses({ candidates: [EXXON_DOC] }), { match: 'select jurisdiction, profile from clients', rows: [{ profile }] }]),
      firmId: 'firm-1', clientId: 'client-1', mode: 'shadow', apiKeyOverride: 'sk-test',
      fetchImpl: recordedProvider(reply, bodies), laneDeps: stubs.laneDeps
    });
    assert.equal(bodies.length, 1, 'one recorded provider call');
    return { system: systemOf(bodies[0]), user: JSON.stringify(bodies[0].messages), mints: stubs.mints };
  };
  const fi = await sweep({ jurisdiction: 'FI' }, FI_DRAFT);
  assert.ok(fi.system.startsWith(__SYSTEM_PROMPT), 'the decision prompt itself is unchanged');
  assert.equal(fi.system, buildDocumentDispositionSystemPrompt({ ownerLanguage: 'fi' }));
  assert.match(fi.system, /Owner language: "fi"/);
  assert.match(fi.system, /write that question entirely in this language/);
  assert.match(fi.system, /Every other field, including "reasoning", stays in English/);
  assert.equal(fi.mints[0].question, 'Kuitti (Exxon, 41,20 USD, päivätty 14.5.2026, exxon-receipt.pdf): Mihin tämä ostos liittyi?',
    'the Finnish draft sits in the Finnish wrapper');
  const en = await sweep({ jurisdiction: 'GB' }, { ...NEEDS_HUMAN, owner_question: 'What was this purchase for?', owner_question_evidence_type: 'business_purpose' });
  assert.equal(en.system, buildDocumentDispositionSystemPrompt({ ownerLanguage: 'en' }));
  assert.match(en.system, /Owner language: "en"/);
  assert.equal(en.mints[0].question, 'About the receipt from Exxon for USD 41.20 dated 2026-05-14 (exxon-receipt.pdf): What was this purchase for?');
  assert.equal(fi.user, en.user, 'the observation is the same for both languages');
});

test('owner language — a direct call without an owner language keeps the historical prompt byte for byte', async () => {
  const bodies = [];
  await proposeDocumentDisposition({ document: EXXON_DOC, firmContext: null, apiKey: 'sk-test', fetchImpl: recordedProvider(NEEDS_HUMAN, bodies) });
  assert.equal(systemOf(bodies[0]), __SYSTEM_PROMPT);
  assert.equal(buildDocumentDispositionSystemPrompt(), __SYSTEM_PROMPT);
});

test('RT-10 answer leg — a second unclear reply rests owner_ask_exhausted (never a third nag), request still consumed', async () => {
  const client = makeMockClient([
    ...replyResponses(),
    { match: "coalesce(audience, 'client') = 'client'", rows: [{ n: OWNER_ASK_MAX_GENERATIONS }] }
  ]);
  const stubs = makeLaneStubs();
  const result = await runOwnerReplyRedisposition({
    ...REPLY_ARGS, client, apiKeyOverride: 'sk-test', fetchImpl: makeFetchOk(NEEDS_HUMAN), laneDeps: stubs.laneDeps
  });
  assert.equal(result.request_resolved, true);
  assert.equal(stubs.mints.length, 0);
  assert.equal(result.lane.kind, 'owner_ask_exhausted');
  assert.equal(findAudits(client, 'document.disposition.owner_ask_exhausted').length, 1);
});

test('RT-10 answer leg — a transport failure on the KEYED path stamps nothing and resolves nothing (the reply survives)', async () => {
  const client = makeMockClient(replyResponses());
  const result = await runOwnerReplyRedisposition({
    ...REPLY_ARGS, client, apiKeyOverride: 'sk-test', fetchImpl: async () => { throw new Error('ECONNREFUSED'); }
  });
  assert.equal(result.skipped, 'transport_failure');
  assert.equal(result.stamped, false);
  assert.ok(!findEvalInsert(client));
  assert.ok(!findRequestFlip(client), 'the owner answer survives for a re-drive');
});

// Frozen replay 2026-09-21: the Aroma credit-note draft asked which invoice it
// reduces, labelled business_purpose, so the applied credit application could
// not answer it. A credit note's owner question is a settlement fact.
test('parser — a credit note\'s owner question is a payment_method fact, receipted; other documents keep business_purpose', () => {
  const question = { ...NEEDS_HUMAN, owner_question: 'Does this credit note reduce invoice 1001, or is it a separate refund?', owner_question_evidence_type: 'business_purpose' };
  const credit = parseDocumentDispositionResponse(JSON.stringify(question), { documentType: 'credit_note' });
  assert.equal(credit.disposition, 'needs_human');
  assert.equal(credit.owner_question_evidence_type, 'payment_method');
  assert.equal(credit.owner_question_evidence_type_coerced_from, 'business_purpose');
  assert.match(credit.owner_question, /invoice 1001/);
  const bill = parseDocumentDispositionResponse(JSON.stringify(question), { documentType: 'supplier_bill' });
  assert.equal(bill.owner_question_evidence_type, 'business_purpose');
  assert.equal(bill.owner_question_evidence_type_coerced_from, undefined);
  const stated = parseDocumentDispositionResponse(JSON.stringify({ ...question, owner_question_evidence_type: 'payment_method' }), { documentType: 'credit_note' });
  assert.equal(stated.owner_question_evidence_type_coerced_from, undefined);
});

// "Still unpaid" — the no-settlement lanes' stillOpen answer. Valid only where
// the asking lane offers it; the prompt says so only there.
test('parser (owner-reply) — obligation_open is an answer only on a lane that accepts it', async () => {
  const { buildOwnerReplySystemPrompt, OBLIGATION_OPEN } = await import('./documentDispositionLlm.js');
  const stillOpen = { meaning: 'the customer has not paid this sales invoice yet', recheckDays: 30 };
  const open = JSON.stringify({ disposition: OBLIGATION_OPEN, materiality: 'material', expense_kind: 'unknown', settlement_channel: 'unknown', confidence: 0.9, reasoning: 'Still unpaid.' });
  const accepted = parseDocumentDispositionResponse(open, { ownerReply: { answeredEvidenceType: 'payment_method', stillOpen } });
  assert.equal(accepted.disposition, OBLIGATION_OPEN);
  assert.equal(accepted.unmatchable_reason, null);
  const otherLane = parseDocumentDispositionResponse(open, OWNER_REPLY_MODE);
  assert.equal(otherLane.disposition, 'needs_human', 'a lane without the answer reads it as unclear, as before');
  assert.equal(parseDocumentDispositionResponse(open).disposition, 'needs_human', 'never a sweep disposition');
  const hesitant = parseDocumentDispositionResponse(JSON.stringify({ ...JSON.parse(open), confidence: 0.3 }), { ownerReply: { answeredEvidenceType: 'payment_method', stillOpen } });
  assert.equal(hesitant.disposition, 'needs_human');
  assert.equal(hesitant.unmatchable_reason, 'owner_reply_unclear');
  assert.equal(buildOwnerReplySystemPrompt().includes(OBLIGATION_OPEN), false, 'other lanes keep the historical prompt');
  const offered = buildOwnerReplySystemPrompt({ stillOpen });
  assert.match(offered, /"obligation_open": the owner says it is STILL UNPAID, i\.e\. the customer has not paid this sales invoice yet\./);
  assert.match(offered, /"disposition": "auto_explain" \| "chase_evidence" \| "needs_human" \| "obligation_open"/);
});

test('runOwnerReplyRedisposition — "still unpaid" puts the ask back on the owner: nothing stamped, no clarification, due later', async () => {
  const { OBLIGATION_OPEN } = await import('./documentDispositionLlm.js');
  const calls = [];
  const request = { id: 'ask-1', status: 'replied', send_count: 2, question: 'Has the customer paid it?', request_payload: { document_id: 'doc-1', lane: 'sales_invoice_recognition' },
    response_payload: { reply: 'still unpaid', reply_processing: { actor_id: 'owner-1' } } };
  const client = { query: async (sql, params = []) => {
    calls.push({ sql, params });
    if (/from documents d/.test(sql)) return { rows: [{ id: 'doc-1', document_type: 'sales_invoice', customer_name: 'Example Customer Oy', total_amount: 100, currency: 'EUR', document_date: '2025-02-12' }] };
    if (/from reconciliation_matches/.test(sql)) return { rows: [] };
    if (/from transactions/.test(sql)) return { rows: [{ line_count: 0 }] };
    if (/from client_evidence_requests/.test(sql) && /for update/.test(sql)) return { rows: [request] };
    return { rows: [] };
  } };
  const mintOwnerAsk = async () => { throw new Error('no clarification may be minted'); };
  const before = Date.now();
  const result = await runOwnerReplyRedisposition({ client, firmId: 'firm', clientId: 'client', documentId: 'doc-1', evidenceRequestId: 'ask-1',
    askedQuestion: request.question, ownerReply: 'still unpaid', jevEnabled: false, apiKeyOverride: 'k', laneDeps: { mintOwnerAsk },
    stillOpen: { meaning: 'the customer has not paid this sales invoice yet', recheckDays: 30 },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: JSON.stringify({ disposition: OBLIGATION_OPEN, materiality: 'material', expense_kind: 'unknown', settlement_channel: 'unknown', confidence: 0.9, reasoning: 'Still unpaid.' }) }] }) }) });
  assert.equal(result.obligation_open, true);
  assert.equal(result.request_resolved, false);
  assert.equal(result.stamped, false);
  assert.equal(result.lane.kind, OBLIGATION_OPEN);
  const days = (new Date(result.lane.recheck_at).getTime() - before) / 86400000;
  assert.ok(days >= 30 && days < 30.01, String(days));
  assert.equal(calls.some((c) => /reconciliation_evaluations/.test(c.sql)), false, 'no verdict stamped');
  const reopen = calls.find((c) => /set status = 'open'/.test(c.sql));
  assert.ok(reopen, 'the ask goes back to the owner');
  const topic = JSON.parse(reopen.params[4]);
  assert.equal(topic.turns.at(-1).outcome, OBLIGATION_OPEN);
  assert.equal(topic.turns.at(-1).reply_excerpt, 'still unpaid');
  assert.equal(JSON.parse(reopen.params[5]).send_count, 2);
  assert.ok(calls.some((c) => c.params.includes('ask-1') && /owner_reported_still_open/.test(c.sql)), 'receipted');
  assert.ok(calls.some((c) => c.sql === 'commit'));
});
