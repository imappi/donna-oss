// The SEVENTH LLM matcher: payout statements and deposit slips (RT-18,
// docs/plan-2026-09-01-runtime-refactor-slices.md; audit F-04 part 2 / F-23).
// Mirrors paymentConfirmationReconciliationLlm.test.js (a payout is the
// money_in twin of a confirmation: one NET amount settled by one inbound
// bank line). Shared logic (parse validation, suppression, UPSERT shape,
// makeMatchId, firm-context render, authorizeMatch) is pinned by
// reconciliationLlmCore.test.js; this file pins the payout-specific surfaces:
//
//   - System + user prompt render payout / provider / money_in tokens, the
//     settlement breakdown (gross → fees → NET) and the non-footing note —
//     and DON'T leak customer_name / money_out.
//   - The system prompt opens with the recorded-providers lane signature
//     ("You match a parsed …") so the appliance harness classifies it.
//   - SQL filters on document_type in (payout_statement, deposit_slip) +
//     money_in > 0; ONE evaluation family for both types.
//   - matched_object_type = the document's OWN type in inserts (so the
//     exact-reference tier's suggestion row is refreshed, never doubled);
//     suppression scans both types; payload.source =
//     'payout_reconciliation_llm'.
//   - ★ Settlement-signal direction SAME as receipts / confirmations: a
//     payout is paid-by-construction, so its recorded 'paid' status never
//     surfaces the settlement guard — only an actual prior matched line does.
//   - The wrapper's PAYOUT_MATCHER_ENABLED gate (the desktop-default wave).

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  buildProposeMatchesUserPrompt,
  parseProposeMatchesResponse,
  proposeMatches,
  runPayoutReconciliationLlmForDocument,
  makeMatchId,
  computeWindow,
  isWithinWindow,
  PAYOUT_MATCHER_DOCUMENT_TYPES,
  __DEFAULT_AUTO_THRESHOLD,
  __WINDOW_DAYS,
  __PAYOUT_MATCHER_FAMILY,
  __PAYOUT_PAYLOAD_SOURCE,
  __PAYOUT_SYSTEM_PROMPT
} from './payoutReconciliationLlm.js';
import { PAYOUT_MATCHER_FLAG, runPayoutReconciliationForDocument } from './payoutReconciliation.js';
import { ANTHROPIC_SYSTEM_LANES } from './testSupport/recordedProviders.js';

// ── Env helpers ───────────────────────────────────────────────────────
const setApiKey = (key = 'sk-test') => { process.env.ANTHROPIC_API_KEY = key; };
const clearApiKey = () => { delete process.env.ANTHROPIC_API_KEY; };
// The auto-match authority policy is OFF by default (suggestion-only). The
// orchestrator auto-match test exercises the WRITE path, which needs the
// policy enabled with a gate-passing fixture; a finite ceiling above the
// fixture amounts (an UNSET ceiling refuses act-mode, fail-closed) and no
// client allowlist inherited from the host.
process.env.RECONCILIATION_AUTO_MATCH_POLICY = '1';
process.env.RECONCILIATION_AUTO_MATCH_MATERIALITY_CEILING = '1000000';
delete process.env.RECONCILIATION_AUTO_MATCH_CLIENTS;

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
        return { rows: response.rows || [] };
      }
      return { rows: [] };
    }
  };
};

// SQL anchors — distinctive substrings that appear in exactly one of the
// queries the orchestrator issues (existing-matches runs before few-shot,
// so the shared 'matched_object_type' anchor is consumed by the former).
const cannedDoc = (rows) => ({ match: "document_type in ('payout_statement', 'deposit_slip')", rows });
const cannedTxs = (rows) => ({ match: 'money_in > 0', rows });
const cannedExistingMatches = (rows) => ({ match: "matched_object_type in ('payout_statement', 'deposit_slip')", rows });
const cannedFewShot = (rows) => ({ match: 'order by m.created_at desc', rows });
const cannedInsertReturn = (rows) => ({ match: 'insert into reconciliation_matches', rows });

const FRESH_INSERT = cannedInsertReturn([
  { id: 'recon-x', inserted: true, prior_status: 'inserted', final_status: 'auto_matched' }
]);

const findInsert = (client) => client.calls.find((c) => c.sql.includes('insert into reconciliation_matches'));

const makeFetchOk = (responseBody) => async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    content: [{ text: typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody) }]
  })
});

// The appliance world's PayLink settlement (server/donna/fixtures/appliance/
// world.json): gross 1,250, fees 36.25, net 1,213.75, paid out 18 Aug and
// credited 19 Aug as "PAYLINK PAYOUT PO-88121".
const PAYLINK_PAYOUT = {
  id: 'po-paylink-1',
  firm_id: 'firm-1',
  client_id: 'client-1',
  document_type: 'payout_statement',
  vendor_name: 'PayLink',
  document_date: '2026-08-18',
  due_date: null,
  total_amount: 1213.75,
  currency: 'GBP',
  extraction_confidence: 0.96,
  parse_summary: {
    warnings: [],
    settlement: {
      kind: 'payout_statement',
      provider_name: 'PayLink',
      period_start: '2026-08-11',
      period_end: '2026-08-17',
      payout_date: '2026-08-18',
      currency: 'GBP',
      gross_sales: 1250,
      refunds: 0,
      fees: [{ description: 'Processing fees (2.9%)', amount: 36.25, tax_amount: 0 }],
      adjustments: [],
      net_payout: 1213.75,
      transaction_count: 23,
      bank_last4: '5678'
    },
    totals_validation: { matches: true, expected: 1213.75, total: 1213.75, drift: 0 }
  },
  duplicate_of: null,
  reference_number: 'PO-88121',
  filename: 'paylink-PO-88121-2026-08-18.pdf',
  payment_status: 'paid'
};

const PAYLINK_CREDIT_TX = {
  id: 'tx-in-1',
  firm_id: 'firm-1',
  client_id: 'client-1',
  money_in: 1213.75,
  money_out: 0,
  currency: 'GBP',
  date: '2026-08-19',
  description: 'PAYLINK PAYOUT PO-88121',
  raw_description: 'PAYLINK PAYOUT PO-88121',
  contact: 'PayLink',
  source_line: '',
  reconciliation_status: null,
  account_code: null,
  status: 'needs_review'
};

const RUN_ARGS = { firmId: 'firm-1', clientId: 'client-1', documentId: 'po-paylink-1' };

// ── 1: window + match id + family constants ───────────────────────────
await test('computeWindow / isWithinWindow are the shared core shape', () => {
  const w = computeWindow({ document_date: '2026-08-18' });
  const issueMs = new Date('2026-08-18T00:00:00Z').getTime();
  const DAY_MS = 24 * 60 * 60 * 1000;
  assert.equal(w.lowerMs, issueMs - __WINDOW_DAYS * DAY_MS);
  assert.equal(w.upperMs, issueMs + __WINDOW_DAYS * DAY_MS);
  assert.equal(isWithinWindow({ date: '2026-08-19' }, w), true);
  assert.equal(isWithinWindow({ date: '2027-01-15' }, w), false);
  assert.equal(__DEFAULT_AUTO_THRESHOLD, 0.85);
});

await test('makeMatchId keys on the document type; the family is the evaluation key', () => {
  const id = makeMatchId('client-1', 'tx-1', 'po-1');
  assert.match(id, /^recon-client-1-tx-1-payout-statement-po-1-/);
  assert.match(makeMatchId('client-1', 'tx-1', 'ds-1', 'deposit_slip'), /^recon-client-1-tx-1-deposit-slip-ds-1-/);
  assert.equal(__PAYOUT_MATCHER_FAMILY, 'payout_statement');
  assert.equal(__PAYOUT_PAYLOAD_SOURCE, 'payout_reconciliation_llm');
  assert.deepEqual([...PAYOUT_MATCHER_DOCUMENT_TYPES], ['payout_statement', 'deposit_slip']);
});

await test('the system prompt carries the recorded-providers lane signature and the NET rule', () => {
  const lane = ANTHROPIC_SYSTEM_LANES.find(({ prefix }) => __PAYOUT_SYSTEM_PROMPT.startsWith(prefix));
  assert.equal(lane?.lane, 'reconciliation_reasoning', 'the harness classifies this matcher onto the reasoning lane by its opening words');
  assert.match(__PAYOUT_SYSTEM_PROMPT, /never the gross/);
  assert.match(__PAYOUT_SYSTEM_PROMPT, /money_in/);
  assert.match(__PAYOUT_SYSTEM_PROMPT, /deposit slip/i);
  assert.match(__PAYOUT_SYSTEM_PROMPT, /Counterparty discipline/);
  assert.doesNotMatch(__PAYOUT_SYSTEM_PROMPT, /money_out/);
});

// ── 2: prompt builder — payout / provider / money_in tokens + the breakdown ──
await test('buildProposeMatchesUserPrompt renders Payout statement: header + provider + NET + the breakdown + money_in candidates', () => {
  const prompt = buildProposeMatchesUserPrompt({
    document: PAYLINK_PAYOUT,
    candidateBankLines: [PAYLINK_CREDIT_TX],
    firmContext: null
  });
  assert.match(prompt, /^Payout statement:/m);
  assert.match(prompt, /provider="PayLink"/);
  assert.match(prompt, /net_amount=1213\.75 GBP/);
  assert.match(prompt, /payout_reference="PO-88121"/);
  assert.match(prompt, /settlement_period=2026-08-11 to 2026-08-17/);
  assert.match(prompt, /Settlement breakdown \(from the document\):/);
  assert.match(prompt, /gross_sales=1250 GBP/);
  assert.match(prompt, /fee: Processing fees \(2\.9%\) 36\.25/);
  assert.match(prompt, /net_payout=1213\.75 GBP/);
  assert.match(prompt, /paid_to_bank_account_ending=5678/);
  assert.match(prompt, /money_in=1213\.75 GBP/);
  assert.match(prompt, /description="PAYLINK PAYOUT PO-88121"/);
  assert.match(prompt, /money_in, within ±90 days of the payout date/);
  // AP-direction wording must not leak; a payout has no due date.
  assert.doesNotMatch(prompt, /customer_name/);
  assert.doesNotMatch(prompt, /money_out=/);
  assert.doesNotMatch(prompt, /due_date=/);
  assert.doesNotMatch(prompt, /do not foot/, 'a footing statement carries no drift note');
});

await test('buildProposeMatchesUserPrompt — a NON-footing statement names its drift, and the NET is still what is matched', () => {
  const nonfooting = {
    ...PAYLINK_PAYOUT,
    id: 'po-northgate-1',
    vendor_name: 'Northgate Marketplace',
    total_amount: 1590,
    parse_summary: {
      settlement: {
        gross_sales: 2150,
        refunds: 0,
        fees: [{ description: 'Marketplace commission (20%)', amount: 430, tax_amount: 86 }],
        adjustments: [],
        net_payout: 1590,
        currency: 'GBP'
      },
      totals_validation: { matches: false, expected: 1634, total: 1590, drift: -44 }
    }
  };
  const prompt = buildProposeMatchesUserPrompt({ document: nonfooting, candidateBankLines: [], firmContext: null });
  assert.match(prompt, /fee: Marketplace commission \(20%\) 430 \(tax on fee 86\)/);
  assert.match(prompt, /NOTE: the printed components do not foot to the net \(expected 1634, printed net 1590, drift -44\)/);
  assert.match(prompt, /net_amount=1590 GBP/);
  assert.match(prompt, /Candidate bank transactions[^:]*: NONE\./);
});

await test('buildProposeMatchesUserPrompt — a deposit slip renders as one, with its components', () => {
  const slip = {
    ...PAYLINK_PAYOUT,
    id: 'ds-1',
    document_type: 'deposit_slip',
    vendor_name: 'Barclays',
    total_amount: 3000,
    reference_number: 'DS-4471',
    document_date: '2026-09-03',
    parse_summary: {
      settlement: { gross_sales: 3000, refunds: 0, fees: [], adjustments: [], net_payout: 3000, currency: 'GBP', transaction_count: 2 }
    }
  };
  const prompt = buildProposeMatchesUserPrompt({ document: slip, candidateBankLines: [], firmContext: null });
  assert.match(prompt, /^Deposit slip:/m);
  assert.match(prompt, /document_type=deposit_slip/);
  assert.match(prompt, /provider="Barclays"/);
  assert.match(prompt, /payout_reference="DS-4471"/);
  assert.match(prompt, /settlement_period=unknown to unknown/);
});

await test('buildProposeMatchesUserPrompt — datePairs ON pairs same-amount twins by date and reference, suppresses the tie note', () => {
  const twins = [
    { id: 'tx-1', money_in: 500, currency: 'GBP', date: '2026-08-05', description: 'STRIPE PAYOUT', contact: 'Stripe' },
    { id: 'tx-2', money_in: 500, currency: 'GBP', date: '2026-08-12', description: 'STRIPE PAYOUT', contact: 'Stripe' }
  ];
  const doc = { id: 'po-1', document_type: 'payout_statement', vendor_name: 'Stripe', total_amount: 500, currency: 'GBP', document_date: '2026-08-05' };
  const prompt = buildProposeMatchesUserPrompt({ document: doc, candidateBankLines: twins, firmContext: null });
  assert.doesNotMatch(prompt, /INDISTINGUISHABLE CANDIDATES DETECTED/);
  assert.match(prompt, /told apart by DATE and REFERENCE/, 'date-pair guidance is foundational');
});

await test('buildProposeMatchesUserPrompt — few-shot renders provider-side, firm anchor names the provider clause', () => {
  const prompt = buildProposeMatchesUserPrompt({
    document: PAYLINK_PAYOUT,
    candidateBankLines: [PAYLINK_CREDIT_TX],
    firmContext: {
      clientIdentity: { display_name: 'Kestrel Print Studio Ltd', legal_names: ['Kestrel Print'] },
      recentConfirmedMatches: [{
        vendor_name: 'Stripe',
        doc_amount: 820.4,
        doc_currency: 'GBP',
        doc_date: '2026-07-14',
        tx_amount: 820.4,
        tx_currency: 'GBP',
        tx_date: '2026-07-15',
        tx_description: 'STRIPE PAYMENTS UK',
        hops: ['amount_exact', 'processor:stripe', 'settlement_lag_1d']
      }]
    }
  });
  assert.match(prompt, /Firm \(the bookkeeping client — "us"\): "Kestrel Print Studio Ltd"/);
  assert.match(prompt, /never an individual customer/);
  assert.match(prompt, /Recent confirmed matches/);
  assert.match(prompt, /settlement: Stripe net 820\.4 GBP on 2026-07-14/);
  assert.match(prompt, /hops: amount_exact, processor:stripe, settlement_lag_1d/);
});

// ── 3: parseProposeMatchesResponse — the shared contract ──────────────
await test('parseProposeMatchesResponse — accepts well-formed proposals and drops hallucinated ids', () => {
  const ok = parseProposeMatchesResponse(
    JSON.stringify({
      proposals: [{ bank_transaction_id: 'tx-in-1', confidence: 0.95, reasoning: 'Reference on the line.', hops: ['reference_match'] }],
      unmatchable_reason: null
    }),
    [PAYLINK_CREDIT_TX]
  );
  assert.equal(ok.proposals.length, 1);
  assert.equal(ok.proposals[0].bank_transaction_id, 'tx-in-1');
  const bad = parseProposeMatchesResponse(
    JSON.stringify({ proposals: [{ bank_transaction_id: 'tx-hallucinated', confidence: 0.9 }], unmatchable_reason: null }),
    [PAYLINK_CREDIT_TX]
  );
  assert.equal(bad.proposals.length, 0);
  assert.deepEqual(parseProposeMatchesResponse('not json', []), { proposals: [], unmatchable_reason: 'invalid_llm_response' });
});

// ── 4: proposeMatches — HTTP contract ─────────────────────────────────
await test('proposeMatches — formats request with the payout system + user prompt, returns parsed', async () => {
  let capturedBody = null;
  const fetchImpl = async (url, init) => {
    capturedBody = JSON.parse(init.body);
    return makeFetchOk({
      proposals: [{ bank_transaction_id: 'tx-in-1', confidence: 0.95, reasoning: 'PAYLINK PAYOUT PO-88121 on the credit.', hops: ['reference_match', 'processor:paylink'] }],
      unmatchable_reason: null
    })();
  };
  const result = await proposeMatches({ document: PAYLINK_PAYOUT, candidateBankLines: [PAYLINK_CREDIT_TX], apiKey: 'sk-test', fetchImpl });
  assert.equal(result.proposals.length, 1);
  assert.equal(capturedBody.system, __PAYOUT_SYSTEM_PROMPT, 'the exact deciding prompt, never forked');
  assert.equal(capturedBody.messages.length, 1);
  assert.match(capturedBody.messages[0].content, /provider="PayLink"/);
  const none = await proposeMatches({ document: PAYLINK_PAYOUT, candidateBankLines: [PAYLINK_CREDIT_TX], apiKey: '' });
  assert.equal(none.unmatchable_reason, 'no_api_key');
});

// ── 5: orchestrator — the PayLink payout auto-matches its credit ──────
await test('runPayoutReconciliationLlmForDocument — the NET credit auto-matches under the document\'s own object type', async () => {
  setApiKey();
  try {
    let capturedPrompt = null;
    const fetchImpl = async (url, init) => {
      capturedPrompt = JSON.parse(init.body).messages[0].content;
      return makeFetchOk({
        proposals: [{
          bank_transaction_id: 'tx-in-1',
          confidence: 0.95,
          reasoning: 'The credit quotes the payout reference and equals the net exactly, one day after the payout date.',
          hops: ['amount_exact', 'reference_match', 'processor:paylink', 'settlement_lag_1d']
        }],
        unmatchable_reason: null
      })();
    };
    const client = makeMockClient([
      cannedDoc([PAYLINK_PAYOUT]),
      cannedTxs([PAYLINK_CREDIT_TX]),
      cannedExistingMatches([]),
      cannedFewShot([]),
      FRESH_INSERT
    ]);

    const stats = await runPayoutReconciliationLlmForDocument({ client, ...RUN_ARGS, fetchImpl });

    assert.equal(stats.suggested_inserted, 1);
    assert.equal(stats.auto_match_eligible, 1, 'confidence 0.95 + authority gates pass → auto-matched');
    assert.equal(stats.disabled, false);

    // ★ Paid-by-construction: the document's 'paid' status alone never
    // surfaces the settlement guard (no prior matched line here).
    assert.doesNotMatch(capturedPrompt, /already been matched/i);
    assert.doesNotMatch(capturedPrompt, /prior matched bank line/i);

    const insertCall = findInsert(client);
    assert.ok(insertCall);
    // INSERT param positions: $5=matched_object_type, $7=match_amount.
    assert.equal(insertCall.params[4], 'payout_statement');
    assert.equal(Number(insertCall.params[6]), 1213.75, 'the NET, never the gross');
    const payload = JSON.parse(insertCall.params[10]);
    assert.equal(payload.source, 'payout_reconciliation_llm');
    assert.deepEqual(payload.match_reason.hops, ['amount_exact', 'reference_match', 'processor:paylink', 'settlement_lag_1d']);
    assert.equal(payload.authorization.band, 'auto_matched');

    // The doc query names both types; the tx query is money_in only.
    const docQuery = client.calls.find((c) => c.sql.includes("document_type in ('payout_statement', 'deposit_slip')"));
    assert.ok(docQuery, 'the document query admits both settlement types');
    const txQuery = client.calls.find((c) => c.sql.includes('money_in > 0'));
    assert.ok(txQuery && txQuery.sql.includes('(money_out is null or money_out = 0)'));
    // The verdict stamp names the family.
    const evaluation = client.calls.find((c) => c.sql.includes('insert into reconciliation_evaluations'));
    assert.ok(evaluation && evaluation.params.includes('payout_statement'), 'the evaluation row carries matcher_family payout_statement');
  } finally {
    clearApiKey();
  }
});

// ── RT-21c: the koontilasku (fixture 018) ───────────────────────────────────
const KOONTILASKU = JSON.parse(readFileSync(new URL('../../data/evals/fixtures/reconciliation/018-kultalanka-nets-koontilasku-rows.json', import.meta.url), 'utf8'));
const netsDocument = () => {
  const { lines, ...doc } = KOONTILASKU.document;
  return { ...doc, firm_id: 'firm-1', client_id: 'client-1', duplicate_of: null };
};
const netsSettlementLines = () => KOONTILASKU.document.lines.map((l) => ({
  id: l.id, line_no: l.line_no, description: l.description, amount: l.amount, settlement_row: l.payload.raw_extraction.settlement_row
}));
const netsCandidates = () => KOONTILASKU.candidate_bank_lines.map((c) => ({
  ...c, firm_id: 'firm-1', client_id: 'client-1', money_out: 0, source_line: '', reconciliation_status: null, account_code: null, status: 'needs_review'
}));
const cannedSettlementLines = (rows) => ({ match: "settlement_row' is not null", rows });
const NETS_RUN_ARGS = { firmId: 'firm-1', clientId: 'client-1', documentId: 'doc-nets-koontilasku-02-2025' };

await test('RT-21c: the system prompt carries the koontilasku rule and the statement_row hop', () => {
  assert.match(__PAYOUT_SYSTEM_PROMPT, /CONSOLIDATED statement/);
  assert.match(__PAYOUT_SYSTEM_PROMPT, /ONE bank credit per row at THAT row's NET/);
  assert.match(__PAYOUT_SYSTEM_PROMPT, /"statement_row:<n>"/);
  assert.match(__PAYOUT_SYSTEM_PROMPT, /Never use "partial_payment" for a listed row/);
});

await test('RT-21c: buildProposeMatchesUserPrompt renders the settlement rows — numbered, at their NET, with the settled state', () => {
  const document = { ...netsDocument(), settlement_lines: netsSettlementLines().map((l, i) => (i === 0 ? { ...l, settled_by_bank_transaction_id: 'tx-nets-vko5' } : l)) };
  const prompt = buildProposeMatchesUserPrompt({ document, candidateBankLines: netsCandidates(), firmContext: null });
  assert.match(prompt, /SETTLEMENT ROWS \(4 listed settlements/);
  assert.match(prompt, /statement_row:1 · VKO5 2025 \(27\.1\.–2\.2\.\) · period 2025-01-27\.\.2025-02-02 · gross 2480 · fee 27\.28 · NET 2452\.72 EUR · paid 2025-02-03 · 31 transactions · ALREADY SETTLED/);
  assert.match(prompt, /statement_row:4 · VKO8 2025 \(17\.2\.–23\.2\.\) · .* NET 2709\.86 EUR · paid 2025-02-24 · 35 transactions · open/);
  assert.match(prompt, /net_amount=10206\.48 EUR/, 'the statement total still heads the document');
});

await test('RT-21c: runPayoutReconciliationLlmForDocument — four rows, four credits: one row match per credit, matched_line_id written, the row on the receipt, every row auto-matched', async () => {
  setApiKey();
  try {
    let capturedPrompt = null;
    const fetchImpl = async (url, init) => {
      capturedPrompt = JSON.parse(init.body).messages[0].content;
      return makeFetchOk({
        proposals: [5, 6, 7, 8].map((n) => ({
          bank_transaction_id: `tx-nets-vko${n}`, confidence: 0.93,
          reasoning: `The ${n - 4}th listed settlement: NETS credit equal to the row's net on its paid date.`,
          hops: ['amount_exact', 'processor:nets', `statement_row:${n - 4}`, 'within_window']
        })),
        unmatchable_reason: null
      })();
    };
    const client = makeMockClient([
      cannedDoc([netsDocument()]),
      cannedSettlementLines(netsSettlementLines()),
      cannedTxs(netsCandidates()),
      cannedExistingMatches([]),
      cannedFewShot([]),
      FRESH_INSERT, FRESH_INSERT, FRESH_INSERT, FRESH_INSERT
    ]);
    const stats = await runPayoutReconciliationLlmForDocument({ client, ...NETS_RUN_ARGS, fetchImpl });
    assert.equal(stats.suggested_inserted, 4);
    assert.equal(stats.auto_match_eligible, 4, 'four rows, four auto-matches — separation per row, Gate C per row');
    assert.match(capturedPrompt, /SETTLEMENT ROWS \(4 listed settlements/);
    assert.doesNotMatch(capturedPrompt, /already been matched/i, 'no document-level settlement note while rows are open');
    const inserts = client.calls.filter((c) => c.sql.includes('insert into reconciliation_matches'));
    assert.equal(inserts.length, 4);
    assert.ok(inserts[0].sql.includes('matched_line_id') && inserts[0].sql.includes('matched_line_id = excluded.matched_line_id'));
    const byLine = new Map(inserts.map((c) => [c.params[11], c]));
    assert.deepEqual([...byLine.keys()].sort(), KOONTILASKU.document.lines.map((l) => l.id).sort(), 'each match points at its row');
    for (const line of KOONTILASKU.document.lines) {
      const call = byLine.get(line.id);
      assert.equal(Number(call.params[6]), line.amount, 'the match amount is the row net');
      assert.match(String(call.params[0]), new RegExp(`-row${line.line_no}-`), 'the id carries the row');
      const payload = JSON.parse(call.params[10]);
      assert.equal(payload.authorization.band, 'auto_matched');
      assert.deepEqual(payload.authorization.reasons, ['all_gates_passed']);
      assert.equal(payload.authorization.settlement_row.line_no, line.line_no);
      assert.equal(payload.settlement_row.line_id, line.id);
      assert.equal(payload.settlement_row.net, line.amount);
      assert.ok(!payload.match_reason.hops.includes('partial_payment'));
    }
  } finally {
    clearApiKey();
  }
});

await test('RT-21c: a proposal on a rows statement without its row hop rests suggested with statement_row_required; every row settled ⇒ already_settled, no model call', async () => {
  setApiKey();
  try {
    const fetchImpl = makeFetchOk({
      proposals: [{ bank_transaction_id: 'tx-nets-vko5', confidence: 0.95, reasoning: 'partial of the monthly total', hops: ['processor:nets', 'partial_payment'] }],
      unmatchable_reason: null
    });
    const client = makeMockClient([
      cannedDoc([netsDocument()]), cannedSettlementLines(netsSettlementLines()), cannedTxs(netsCandidates()),
      cannedExistingMatches([]), cannedFewShot([]), cannedInsertReturn([{ id: 'recon-x', inserted: true, prior_status: 'inserted', final_status: 'suggested' }])
    ]);
    const stats = await runPayoutReconciliationLlmForDocument({ client, ...NETS_RUN_ARGS, fetchImpl });
    assert.equal(stats.auto_match_eligible, 0);
    const payload = JSON.parse(findInsert(client).params[10]);
    assert.equal(payload.authorization.band, 'suggested');
    assert.ok(payload.authorization.reasons.includes('statement_row_required'), JSON.stringify(payload.authorization.reasons));
    assert.equal(findInsert(client).params[11], null, 'no row named ⇒ no matched_line_id');

    // Every row settled: the settlement note applies, no model call, the honest verdict.
    let called = 0;
    const neverFetch = async () => { called += 1; throw new Error('must not call the model'); };
    const settled = makeMockClient([
      cannedDoc([netsDocument()]), cannedSettlementLines(netsSettlementLines()), cannedTxs(netsCandidates()),
      cannedExistingMatches(KOONTILASKU.document.lines.map((l, i) => ({
        id: `m-${i}`, bank_transaction_id: `tx-nets-vko${5 + i}`, matched_object_type: 'payout_statement', matched_object_id: 'doc-nets-koontilasku-02-2025',
        status: 'auto_matched', match_amount: l.amount, match_confidence: 0.93, payload: {}, matched_line_id: l.id
      }))),
      cannedFewShot([])
    ]);
    const stats2 = await runPayoutReconciliationLlmForDocument({ client: settled, ...NETS_RUN_ARGS, fetchImpl: neverFetch });
    assert.equal(called, 0);
    assert.equal(stats2.skipped_auto_matched, 4);
    const evaluation = settled.calls.find((c) => c.sql.includes('insert into reconciliation_evaluations'));
    assert.ok(evaluation && evaluation.params.includes('already_settled'), 'the verdict names already_settled');
  } finally {
    clearApiKey();
  }
});

await test('runPayoutReconciliationLlmForDocument — a deposit slip writes its own object type, so the intel tier\'s suggestion row is refreshed, not doubled', async () => {
  setApiKey();
  try {
    const slip = { ...PAYLINK_PAYOUT, id: 'ds-1', document_type: 'deposit_slip', vendor_name: 'Barclays', total_amount: 3000, reference_number: 'DS-4471', document_date: '2026-09-03',
      parse_summary: { settlement: { gross_sales: 3000, refunds: 0, fees: [], adjustments: [], net_payout: 3000, currency: 'GBP' } } };
    const credit = { ...PAYLINK_CREDIT_TX, id: 'tx-in-2', money_in: 3000, date: '2026-09-03', description: 'COUNTER CREDIT YORK PARLIAMENT ST', raw_description: 'COUNTER CREDIT YORK PARLIAMENT ST', contact: '' };
    const fetchImpl = async () => makeFetchOk({
      proposals: [{ bank_transaction_id: 'tx-in-2', confidence: 0.94, reasoning: 'Same-day counter credit for the deposited total.', hops: ['amount_exact', 'deposit_channel'] }],
      unmatchable_reason: null
    })();
    const client = makeMockClient([cannedDoc([slip]), cannedTxs([credit]), cannedExistingMatches([]), cannedFewShot([]), FRESH_INSERT]);
    const stats = await runPayoutReconciliationLlmForDocument({ client, firmId: 'firm-1', clientId: 'client-1', documentId: 'ds-1', fetchImpl });
    assert.equal(stats.suggested_inserted, 1);
    const insertCall = findInsert(client);
    assert.equal(insertCall.params[4], 'deposit_slip', 'the row is keyed on the document type — the same key the exact-reference tier writes');
    assert.equal(Number(insertCall.params[6]), 3000);
    const evaluation = client.calls.find((c) => c.sql.includes('insert into reconciliation_evaluations'));
    assert.ok(evaluation && evaluation.params.includes('payout_statement'), 'the evaluation family stays payout_statement for both types');
  } finally {
    clearApiKey();
  }
});

await test('runPayoutReconciliationLlmForDocument — no api key → disabled, config-only reads', async () => {
  clearApiKey();
  const client = makeMockClient([]);
  const stats = await runPayoutReconciliationLlmForDocument({ client, ...RUN_ARGS });
  assert.equal(stats.disabled, true);
  assert.equal(stats.disabled_reason, 'no_anthropic_api_key');
  assert.equal(client.calls.length, 2, 'only the Jev routing configuration is read');
  assert.ok(client.calls.every(call => /from (client_capability_config|cohort_capability_config)/.test(call.sql)), 'no accounting evidence read or mutation');
});

await test('runPayoutReconciliationLlmForDocument — suppresses confirmed pairs and records no_candidates without a model call', async () => {
  setApiKey();
  try {
    let fetchCalled = false;
    const fetchImpl = async () => { fetchCalled = true; return makeFetchOk({ proposals: [], unmatchable_reason: null })(); };
    const client = makeMockClient([
      cannedDoc([PAYLINK_PAYOUT]),
      cannedTxs([PAYLINK_CREDIT_TX]),
      cannedExistingMatches([{
        id: 'recon-prior', bank_transaction_id: 'tx-in-1', matched_object_type: 'payout_statement', matched_object_id: 'po-paylink-1',
        status: 'confirmed', match_amount: 1213.75, match_confidence: 1, payload: {}
      }]),
      cannedFewShot([])
    ]);
    const stats = await runPayoutReconciliationLlmForDocument({ client, ...RUN_ARGS, fetchImpl });
    assert.equal(fetchCalled, false, 'no LLM call when no eligible candidates');
    assert.equal(stats.skipped_confirmed, 1);
    assert.equal(stats.suggested_inserted, 0);
    const evaluation = client.calls.find((c) => c.sql.includes('insert into reconciliation_evaluations'));
    assert.ok(evaluation && evaluation.params.includes('no_candidates'), 'the honest verdict is recorded');
  } finally {
    clearApiKey();
  }
});

await test('runPayoutReconciliationLlmForDocument — a non-settlement document is a no-op', async () => {
  setApiKey();
  try {
    const client = makeMockClient([cannedDoc([])]);
    const stats = await runPayoutReconciliationLlmForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.suggested_inserted, 0);
    assert.equal(stats.disabled, false);
  } finally {
    clearApiKey();
  }
});

// ── 6: the wrapper — the desktop-default gate ─────────────────────────
await test('runPayoutReconciliationForDocument — PAYOUT_MATCHER_ENABLED gates the family; off ⇒ disabled stats, no reads', async () => {
  const prior = process.env[PAYOUT_MATCHER_FLAG];
  delete process.env[PAYOUT_MATCHER_FLAG];
  try {
    const client = makeMockClient([]);
    const off = await runPayoutReconciliationForDocument({ client, ...RUN_ARGS });
    assert.equal(off.disabled, true);
    assert.match(off.disabled_reason, /PAYOUT_MATCHER_ENABLED not enabled/);
    assert.equal(client.calls.length, 0, 'disabled family makes no reads');

    process.env[PAYOUT_MATCHER_FLAG] = 'true';
    clearApiKey();
    // 2026-09-13: a missing Anthropic key is a PROVIDER failure that rests on
    // the operator — the LLM matcher self-disables, the wrapper receipts it
    // on the document (reconciliationProviderFailure.js) and returns the zero
    // shape carrying the typed cause; the clock re-drives once a key exists.
    const on = await runPayoutReconciliationForDocument({ client, ...RUN_ARGS });
    assert.equal(on.disabled, false, 'not a disabled run — a receipted provider failure');
    assert.equal(on.provider_failure?.code, 'PROVIDER_KEY_MISSING');
    assert.equal(on.provider_failure?.owner, 'operator');
    assert.equal(on.provider_failure?.matcher_family, 'payout_statement');
    const receiptWrite = client.calls.find((c) => c.sql.includes('update documents') && c.params.includes('reconciliation_provider_failure'));
    assert.ok(receiptWrite, 'the receipt was written on the document');
  } finally {
    if (prior === undefined) delete process.env[PAYOUT_MATCHER_FLAG];
    else process.env[PAYOUT_MATCHER_FLAG] = prior;
  }
});
