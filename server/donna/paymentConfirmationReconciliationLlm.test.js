// Slice E — the SIXTH LLM matcher: payment confirmations. Retires the
// weighted paymentConfirmationReconciliation.js auto-match authority (the
// Honeybee leak: a confirmed 2,087.97 / 3,683.67 payment auto-matched
// through a 500 materiality ceiling because the legacy path never called
// authorizeMatch). Mirrors paymentAccountStatementReconciliationLlm.test.js
// (a confirmation is the AP twin of a bill: money_out / payee, one amount
// settled by one outbound bank line). Shared logic (parse validation,
// suppression, UPSERT shape, makeMatchId, firm-context render) is pinned by
// reconciliationLlmCore.test.js; this file pins the confirmation-specific
// surfaces:
//
//   - System + user prompt render confirmation / payee / money_out tokens
//     (and DON'T leak customer_name / money_in).
//   - SQL filters on document_type='payment_confirmation' + money_out > 0.
//   - matched_object_type = 'payment_confirmation' in inserts + suppression.
//   - payload.source = 'payment_confirmation_reconciliation_llm'.
//   - ★ Settlement-signal direction SAME as receipts (OPPOSITE of
//     statements): a confirmation is paid-by-construction, so a recorded
//     'paid' status does NOT surface the settlement guard — only an actual
//     prior matched bank line does (paymentStatusIsSettlementSignal=false).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildProposeMatchesUserPrompt,
  parseProposeMatchesResponse,
  proposeMatches,
  runPaymentConfirmationReconciliationLlmForDocument,
  makeMatchId,
  computeWindow,
  isWithinWindow,
  __DEFAULT_AUTO_THRESHOLD,
  __WINDOW_DAYS,
  __PAYMENT_CONFIRMATION_OBJECT_TYPE
} from './paymentConfirmationReconciliationLlm.js';

// ── Env helpers ───────────────────────────────────────────────────────
const setApiKey = (key = 'sk-test') => {
  process.env.ANTHROPIC_API_KEY = key;
};
const clearApiKey = () => {
  delete process.env.ANTHROPIC_API_KEY;
};
// The auto-match authority policy is OFF by default (suggestion-only). The
// orchestrator auto-match test below exercises the WRITE path, which needs
// the policy enabled with a gate-passing fixture. Enabled for the whole
// file (node isolates env per test file); the authorizeMatch gates
// themselves are unit-tested in reconciliationAutoMatchPolicy.test.js. We
// also pin a finite materiality ceiling above the fixture amounts (F1: an
// UNSET ceiling refuses act-mode, fail-closed) and clear the client
// allowlist so the auto-match fixture is not held by the client gate
// inherited from the host.
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
      if (text === 'begin' || text === 'commit' || text === 'rollback') {
        return { rows: [] };
      }
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
const cannedDoc = (rows) => ({ match: "document_type = 'payment_confirmation'", rows });
const cannedTxs = (rows) => ({ match: 'money_out > 0', rows });
const cannedExistingMatches = (rows) => ({ match: "matched_object_type = 'payment_confirmation'", rows });
const cannedFewShot = (rows) => ({ match: 'order by m.created_at desc', rows });
const cannedInsertReturn = (rows) => ({ match: 'insert into reconciliation_matches', rows });
const cannedClients = (rows) => ({ match: 'from clients where firm_id', rows });
const cannedXeroContacts = (rows) => ({ match: 'from xero_contacts', rows });

const FRESH_INSERT = cannedInsertReturn([
  { id: 'recon-x', inserted: true, prior_status: 'inserted', final_status: 'auto_matched' }
]);

const findInsert = (client) =>
  client.calls.find((c) => c.sql.includes('insert into reconciliation_matches'));

const makeFetchOk = (responseBody) => async (url, init) => ({
  ok: true,
  status: 200,
  json: async () => ({
    content: [
      { text: typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody) }
    ]
  })
});

// An Amex payment confirmation (the firm paid its Amex card balance) and
// the outbound ACH that IS that payment, posting two days later as
// "ACH DEBIT AMEX EPAYMENT".
const AMEX_CONFIRMATION = {
  id: 'pc-amex-1',
  firm_id: 'firm-1',
  client_id: 'client-1',
  document_type: 'payment_confirmation',
  vendor_name: 'American Express',
  document_date: '2024-03-01',
  due_date: null,
  total_amount: 941.42,
  currency: 'USD',
  extraction_confidence: 0.95,
  parse_summary: { warnings: [] },
  duplicate_of: null,
  reference_number: 'AMEX-8869258115',
  filename: 'amex-payment-confirmation-2024-03.pdf',
  payment_status: 'paid'
};

const AMEX_ACH_TX = {
  id: 'tx-ach-1',
  firm_id: 'firm-1',
  client_id: 'client-1',
  money_in: 0,
  money_out: 941.42,
  currency: 'USD',
  date: '2024-03-03',
  description: 'ACH DEBIT AMEX EPAYMENT',
  raw_description: 'ACH DEBIT AMEX EPAYMENT 8869258115',
  contact: 'American Express',
  source_line: '',
  reconciliation_status: null,
  account_code: null,
  status: 'needs_review'
};

const RUN_ARGS = {
  firmId: 'firm-1',
  clientId: 'client-1',
  documentId: 'pc-amex-1'
};

// (The RECONCILIATION_MATCHER_MODE env-parsing test is gone with the gate —
// batch-2 terminal state 1: LLM-primary is unconditional.)

// ── 2: window + match id (shared shape with the other paths) ──────────
await test('computeWindow returns ±WINDOW_DAYS around document_date', () => {
  const w = computeWindow({ document_date: '2024-03-01' });
  assert.ok(w);
  const issueMs = new Date('2024-03-01T00:00:00Z').getTime();
  const DAY_MS = 24 * 60 * 60 * 1000;
  assert.equal(w.lowerMs, issueMs - __WINDOW_DAYS * DAY_MS);
  assert.equal(w.upperMs, issueMs + __WINDOW_DAYS * DAY_MS);
});

await test('isWithinWindow respects the ±90d window', () => {
  const w = computeWindow({ document_date: '2024-03-01' });
  assert.equal(isWithinWindow({ date: '2024-03-03' }, w), true);
  assert.equal(isWithinWindow({ date: '2024-06-15' }, w), false, 'well beyond → outside');
});

await test('makeMatchId encodes payment_confirmation object type', () => {
  const id = makeMatchId('client-1', 'tx-1', 'pc-1');
  assert.match(id, /^recon-client-1-tx-1-payment-confirmation-pc-1-/);
  assert.equal(__PAYMENT_CONFIRMATION_OBJECT_TYPE, 'payment_confirmation');
});

// ── 3: prompt builder — confirmation / payee / money_out tokens ───────
await test('buildProposeMatchesUserPrompt renders Payment confirmation: header + vendor + money_out', () => {
  const prompt = buildProposeMatchesUserPrompt({
    document: AMEX_CONFIRMATION,
    candidateBankLines: [AMEX_ACH_TX],
    firmContext: null
  });
  assert.match(prompt, /^Payment confirmation:/m);
  assert.match(prompt, /vendor_name="American Express"/);
  assert.match(prompt, /total_amount=941\.42 USD/);
  assert.match(prompt, /money_out=941\.42 USD/);
  assert.match(prompt, /description="ACH DEBIT AMEX EPAYMENT"/);
  // Direction wording — money_out window header.
  assert.match(prompt, /money_out, within ±90 days of confirmation date/);
  // Customer-side / AR-direction wording should NOT leak through.
  assert.doesNotMatch(prompt, /customer_name/);
  assert.doesNotMatch(prompt, /money_in=/);
  // A confirmation is settled by construction — no due_date concept.
  assert.doesNotMatch(prompt, /due_date=/);
});

await test('buildProposeMatchesUserPrompt — empty candidates announces NONE', () => {
  const prompt = buildProposeMatchesUserPrompt({
    document: AMEX_CONFIRMATION,
    candidateBankLines: [],
    firmContext: null
  });
  assert.match(prompt, /Candidate bank transactions[^:]*: NONE\./);
});

await test('buildProposeMatchesUserPrompt — datePairs ON pairs same-amount twins by date, suppresses the tie note (confirmation)', () => {
  // Two same-amount payments to one payee a day apart; confirmation dated 03-01.
  const twins = [
    { id: 'tx-1', money_out: 100, currency: 'USD', date: '2026-03-01', description: 'AMEX EPAYMENT', contact: 'Amex' },
    { id: 'tx-2', money_out: 100, currency: 'USD', date: '2026-03-02', description: 'AMEX EPAYMENT', contact: 'Amex' }
  ];
  const doc = { id: 'pc-1', vendor_name: 'Amex', total_amount: 100, currency: 'USD', document_date: '2026-03-01' };
  // Default: the document date pairs tx-1 and the prompt explains the foundational rule.
  const off = buildProposeMatchesUserPrompt({ document: doc, candidateBankLines: twins, firmContext: null });
  assert.doesNotMatch(off, /INDISTINGUISHABLE CANDIDATES DETECTED/);
  assert.match(off, /told apart by DATE/, 'date-pair guidance is foundational');
  // Explicit true is equivalent.
  const on = buildProposeMatchesUserPrompt({ document: doc, candidateBankLines: twins, firmContext: null, datePairs: true });
  assert.match(on, /told apart by DATE/, 'datePairs on → twin-date guidance present');
  assert.doesNotMatch(on, /INDISTINGUISHABLE CANDIDATES DETECTED/, 'and the date-blind tie note is suppressed (date pairs them)');
});

await test('buildProposeMatchesUserPrompt — few-shot renders confirmation/payee-side', () => {
  const prompt = buildProposeMatchesUserPrompt({
    document: AMEX_CONFIRMATION,
    candidateBankLines: [AMEX_ACH_TX],
    firmContext: {
      recentConfirmedMatches: [{
        vendor_name: 'Internal Revenue Service',
        doc_amount: 3683.67,
        doc_currency: 'USD',
        doc_date: '2024-01-15',
        tx_amount: 3683.67,
        tx_currency: 'USD',
        tx_date: '2024-01-16',
        tx_description: 'IRS USATAXPYMT',
        hops: ['amount_exact', 'processor:ach_debit', 'settlement_lag_1d']
      }]
    }
  });
  assert.match(prompt, /Recent confirmed matches/);
  assert.match(prompt, /payment confirmation: Internal Revenue Service 3683\.67 USD on 2024-01-15/);
  assert.match(prompt, /hops: amount_exact, processor:ach_debit, settlement_lag_1d/);
});

// ── 4: parseProposeMatchesResponse — schema + validation ─────────────
await test('parseProposeMatchesResponse — accepts well-formed proposals', () => {
  const out = parseProposeMatchesResponse(
    JSON.stringify({
      proposals: [{
        bank_transaction_id: 'tx-ach-1',
        confidence: 0.93,
        reasoning: 'Exact USD 941.42; AMEX EPAYMENT names the payee; ACH posts 2d after the confirmation.',
        hops: ['amount_exact', 'vendor_overlap', 'processor:ach_debit', 'settlement_lag_2d']
      }],
      unmatchable_reason: null
    }),
    [AMEX_ACH_TX]
  );
  assert.equal(out.proposals.length, 1);
  assert.equal(out.proposals[0].bank_transaction_id, 'tx-ach-1');
  assert.equal(out.proposals[0].confidence, 0.93);
  assert.deepEqual(out.proposals[0].hops, ['amount_exact', 'vendor_overlap', 'processor:ach_debit', 'settlement_lag_2d']);
});

await test('parseProposeMatchesResponse — rejects ids not in candidate list', () => {
  const out = parseProposeMatchesResponse(
    JSON.stringify({
      proposals: [{ bank_transaction_id: 'tx-hallucinated', confidence: 0.9 }],
      unmatchable_reason: null
    }),
    [AMEX_ACH_TX]
  );
  assert.equal(out.proposals.length, 0, 'hallucinated id dropped');
});

await test('parseProposeMatchesResponse — wholly malformed → invalid_llm_response', () => {
  const out = parseProposeMatchesResponse('not json at all', []);
  assert.deepEqual(out, { proposals: [], unmatchable_reason: 'invalid_llm_response' });
});

// ── 5: proposeMatches — HTTP contract ─────────────────────────────────
await test('proposeMatches — formats request with system + user, returns parsed', async () => {
  let capturedBody = null;
  const fetchImpl = async (url, init) => {
    capturedBody = JSON.parse(init.body);
    return makeFetchOk({
      proposals: [{
        bank_transaction_id: 'tx-ach-1',
        confidence: 0.93,
        reasoning: 'ACH payment settlement.',
        hops: ['amount_exact', 'processor:ach_debit']
      }],
      unmatchable_reason: null
    })();
  };
  const result = await proposeMatches({
    document: AMEX_CONFIRMATION,
    candidateBankLines: [AMEX_ACH_TX],
    apiKey: 'sk-test',
    fetchImpl
  });
  assert.equal(result.proposals.length, 1);
  // System prompt mentions confirmation domain + money_out direction.
  assert.match(capturedBody.system, /payment confirmation/);
  assert.match(capturedBody.system, /money_out/);
  // User content is the prompt body.
  assert.equal(capturedBody.messages.length, 1);
  assert.match(capturedBody.messages[0].content, /vendor_name="American Express"/);
});

await test('proposeMatches — no api key → no-op return', async () => {
  const result = await proposeMatches({
    document: AMEX_CONFIRMATION,
    candidateBankLines: [AMEX_ACH_TX],
    apiKey: ''
  });
  assert.equal(result.unmatchable_reason, 'no_api_key');
  assert.deepEqual(result.proposals, []);
});

// ── 6: orchestrator — confirmation payment auto-match end-to-end ─────
await test('runPaymentConfirmationReconciliationLlmForDocument — Amex confirmation auto-matches', async () => {
  setApiKey();
  try {
    const fetchImpl = async () => makeFetchOk({
      proposals: [{
        bank_transaction_id: 'tx-ach-1',
        confidence: 0.93,
        reasoning: 'Exact USD 941.42; AMEX EPAYMENT names the payee; ACH posts 2d after the confirmation.',
        hops: ['amount_exact', 'vendor_overlap', 'processor:ach_debit', 'settlement_lag_2d']
      }],
      unmatchable_reason: null
    })();

    const client = makeMockClient([
      cannedDoc([AMEX_CONFIRMATION]),
      cannedTxs([AMEX_ACH_TX]),
      cannedExistingMatches([]),
      cannedFewShot([]),
      FRESH_INSERT
    ]);

    const stats = await runPaymentConfirmationReconciliationLlmForDocument({
      client,
      ...RUN_ARGS,
      fetchImpl
    });

    assert.equal(stats.suggested_inserted, 1);
    assert.equal(stats.auto_match_eligible, 1, 'confidence 0.93 + authority gates pass → auto-matched');
    assert.equal(stats.disabled, false);

    const insertCall = findInsert(client);
    assert.ok(insertCall);
    // INSERT param positions: $5=matched_object_type, $7=match_amount.
    assert.equal(insertCall.params[4], 'payment_confirmation');
    assert.equal(Number(insertCall.params[6]), 941.42);

    const payload = JSON.parse(insertCall.params[10]);
    assert.equal(payload.source, 'payment_confirmation_reconciliation_llm');
    assert.deepEqual(payload.match_reason.hops, [
      'amount_exact',
      'vendor_overlap',
      'processor:ach_debit',
      'settlement_lag_2d'
    ]);
  } finally {
    clearApiKey();
  }
});

// ── 7: orchestrator — no api key → disabled stats ────────────────────
await test('runPaymentConfirmationReconciliationLlmForDocument — no api key → disabled', async () => {
  clearApiKey();
  const client = makeMockClient([]);
  const stats = await runPaymentConfirmationReconciliationLlmForDocument({
    client,
    ...RUN_ARGS
  });
  assert.equal(stats.disabled, true);
  assert.equal(stats.disabled_reason, 'no_anthropic_api_key');
  assert.equal(client.calls.length, 2, 'only the Jev routing configuration is read');
  assert.ok(client.calls.every(call => /from (client_capability_config|cohort_capability_config)/.test(call.sql)), 'no accounting evidence read or mutation');
});

// ── 8: orchestrator — suppression honours firm confirms ──────────────
await test('runPaymentConfirmationReconciliationLlmForDocument — suppresses confirmed pairs', async () => {
  setApiKey();
  try {
    let fetchCalled = false;
    const fetchImpl = async () => {
      fetchCalled = true;
      return makeFetchOk({ proposals: [], unmatchable_reason: null })();
    };

    const existingConfirmed = {
      id: 'recon-prior',
      bank_transaction_id: 'tx-ach-1',
      matched_object_type: 'payment_confirmation',
      matched_object_id: 'pc-amex-1',
      status: 'confirmed',
      match_amount: 941.42,
      match_confidence: 1.0,
      payload: {}
    };

    const client = makeMockClient([
      cannedDoc([AMEX_CONFIRMATION]),
      cannedTxs([AMEX_ACH_TX]),
      cannedExistingMatches([existingConfirmed]),
      cannedFewShot([])
    ]);

    const stats = await runPaymentConfirmationReconciliationLlmForDocument({
      client,
      ...RUN_ARGS,
      fetchImpl
    });

    assert.equal(fetchCalled, false, 'no LLM call when no eligible candidates');
    assert.equal(stats.skipped_confirmed, 1);
    assert.equal(stats.suggested_inserted, 0);
  } finally {
    clearApiKey();
  }
});

// ── 9: orchestrator — non-confirmation document → zero stats ─────────
await test('runPaymentConfirmationReconciliationLlmForDocument — non-confirmation document → no-op', async () => {
  setApiKey();
  try {
    const client = makeMockClient([
      // Empty doc result: the SQL filter is document_type='payment_confirmation'.
      cannedDoc([])
    ]);
    const stats = await runPaymentConfirmationReconciliationLlmForDocument({
      client,
      ...RUN_ARGS
    });
    assert.equal(stats.suggested_inserted, 0);
    assert.equal(stats.disabled, false, 'not disabled — just no row');
  } finally {
    clearApiKey();
  }
});

// ── 10: firm anchor + known-vendors roster (FX false-positive guard) ──
await test('buildProposeMatchesUserPrompt — renders firm anchor when clientIdentity present', () => {
  const prompt = buildProposeMatchesUserPrompt({
    document: AMEX_CONFIRMATION,
    candidateBankLines: [AMEX_ACH_TX],
    firmContext: {
      clientIdentity: { display_name: 'Honeybee Hills Apiary LLC', legal_names: ['Honeybee Hills'] }
    }
  });
  assert.match(prompt, /Firm \(the bookkeeping client — "us"\): "Honeybee Hills Apiary LLC"/);
  assert.match(prompt, /also recorded as "Honeybee Hills"/);
  assert.match(prompt, /never an unrelated third party/);
});

await test('buildProposeMatchesUserPrompt — renders the known-vendors roster when present', () => {
  const prompt = buildProposeMatchesUserPrompt({
    document: AMEX_CONFIRMATION,
    candidateBankLines: [AMEX_ACH_TX],
    firmContext: { knownCounterparties: ['American Express', 'Internal Revenue Service'] }
  });
  assert.match(prompt, /Known vendors for this firm \(the counterparties it pays\): American Express, Internal Revenue Service\./);
  assert.match(prompt, /positively place a counterparty/);
  assert.match(prompt, /this confirmation's payee/);
});

await test('proposeMatches — system prompt weighs counterparty discipline above amount', async () => {
  let capturedBody = null;
  const fetchImpl = async (url, init) => {
    capturedBody = JSON.parse(init.body);
    return makeFetchOk({ proposals: [], unmatchable_reason: 'no_plausible_match' })();
  };
  await proposeMatches({
    document: AMEX_CONFIRMATION,
    candidateBankLines: [AMEX_ACH_TX],
    apiKey: 'sk-test',
    fetchImpl
  });
  assert.match(capturedBody.system, /Counterparty discipline/);
  assert.match(capturedBody.system, /coincide across unrelated currencies/);
  assert.match(capturedBody.system, /already_settled/);
});

await test('orchestrator — threads firm identity + known-vendors roster into the prompt', async () => {
  setApiKey();
  try {
    let capturedBody = null;
    const fetchImpl = async (url, init) => {
      capturedBody = JSON.parse(init.body);
      return makeFetchOk({ proposals: [], unmatchable_reason: 'no_plausible_match' })();
    };
    const client = makeMockClient([
      cannedDoc([AMEX_CONFIRMATION]),
      cannedTxs([AMEX_ACH_TX]),
      cannedExistingMatches([]),
      cannedFewShot([]),
      cannedClients([{ id: 'client-1', company_name: 'Honeybee Hills Apiary LLC', legal_names: [] }]),
      cannedXeroContacts([{ name: 'American Express' }, { name: 'Internal Revenue Service' }])
    ]);
    await runPaymentConfirmationReconciliationLlmForDocument({ client, ...RUN_ARGS, fetchImpl });
    assert.ok(capturedBody, 'LLM was called');
    const userPrompt = capturedBody.messages[0].content;
    assert.match(userPrompt, /Firm \(the bookkeeping client — "us"\): "Honeybee Hills Apiary LLC"/, 'firm identity threaded in');
    assert.match(userPrompt, /Known vendors for this firm/, 'roster threaded into the prompt');
    assert.match(capturedBody.system, /Counterparty discipline/, 'counterparty rule present in system prompt');
  } finally {
    clearApiKey();
  }
});

// ── 11: ★ settlement signal — SAME as receipts (OPPOSITE of statements) ─
// A payment confirmation is paid-by-construction. Its recorded
// payment_status='paid' is its NORMAL state and is NOT a settlement signal,
// so a 'paid' confirmation with no prior matched bank line does NOT surface
// the settlement guard — matching the receipt matcher, NOT the statement
// matcher (paymentStatusIsSettlementSignal=false).

await test('orchestrator — a recorded paid status does NOT surface the settlement guard (like a receipt)', async () => {
  setApiKey();
  try {
    let capturedBody = null;
    const fetchImpl = async (url, init) => {
      capturedBody = JSON.parse(init.body);
      return makeFetchOk({ proposals: [], unmatchable_reason: 'no_plausible_match' })();
    };
    const client = makeMockClient([
      // payment_status='paid' (its intrinsic state), but NO prior matched bank line.
      cannedDoc([{ ...AMEX_CONFIRMATION, payment_status: 'paid' }]),
      cannedTxs([AMEX_ACH_TX]),
      cannedExistingMatches([]),
      cannedFewShot([]),
      cannedClients([{ id: 'client-1', company_name: 'Honeybee Hills Apiary LLC', legal_names: [] }])
    ]);
    await runPaymentConfirmationReconciliationLlmForDocument({ client, ...RUN_ARGS, fetchImpl });
    assert.ok(capturedBody, 'LLM was called');
    const userPrompt = capturedBody.messages[0].content;
    // Unlike a statement, the intrinsic 'paid' does NOT fire the guard here.
    assert.doesNotMatch(userPrompt, /Settlement state for this payment confirmation/, 'intrinsic paid is NOT a settlement signal for confirmations');
  } finally {
    clearApiKey();
  }
});

await test('orchestrator — an ACTUAL prior matched bank line DOES surface the settlement guard', async () => {
  setApiKey();
  try {
    let capturedBody = null;
    const fetchImpl = async (url, init) => {
      capturedBody = JSON.parse(init.body);
      return makeFetchOk({ proposals: [], unmatchable_reason: 'already_settled' })();
    };
    // A prior auto_matched bank line on a DIFFERENT tx → settledCount=1, so
    // the guard fires even though that pair is suppressed from candidates.
    const priorMatch = {
      id: 'recon-prior',
      bank_transaction_id: 'tx-other',
      matched_object_type: 'payment_confirmation',
      matched_object_id: 'pc-amex-1',
      status: 'auto_matched',
      match_amount: 941.42,
      match_confidence: 0.95,
      payload: {}
    };
    const client = makeMockClient([
      cannedDoc([AMEX_CONFIRMATION]),
      cannedTxs([AMEX_ACH_TX]),
      cannedExistingMatches([priorMatch]),
      cannedFewShot([]),
      cannedClients([{ id: 'client-1', company_name: 'Honeybee Hills Apiary LLC', legal_names: [] }])
    ]);
    await runPaymentConfirmationReconciliationLlmForDocument({ client, ...RUN_ARGS, fetchImpl });
    assert.ok(capturedBody, 'LLM was called');
    const userPrompt = capturedBody.messages[0].content;
    assert.match(userPrompt, /Settlement state for this payment confirmation/, 'an actual prior matched line IS a settlement signal');
  } finally {
    clearApiKey();
  }
});
