// RT-27 — credit notes in the AR matcher's context: the pure Keep layer.
//
// Eligibility (identity, currency, availability, linkage), the plan (the
// model's selection → exact amounts, ambiguity), the prompt section (call-
// local handles only), the parser (handles → persisted ids), Gate C with
// prior settled + applied credits, and the credit-only authorization. The
// real-PostgreSQL lifecycle (locking, atomic application, reversal, journals,
// asks) lives in creditNoteSettlementPgLifecycle.test.js.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CREDIT_LINKAGE,
  CREDIT_REFUSAL_CODES,
  authorizeCreditOnlyApplication,
  buildCreditReceipt,
  citedInvoiceNumbersOf,
  classifyCreditLinkage,
  classifyCreditNoteEligibility,
  creditRefForIndex,
  customerNamesCorrespond,
  formatCreditNotes,
  makeCreditApplicationId,
  planCreditApplications,
  withCreditApplicationTransaction
} from './creditNoteApplications.js';
import { amountReconciles, authorizeMatch, parseProposeMatchesResponse } from './reconciliationLlmCore.js';
import { buildProposeMatchesUserPrompt } from './salesInvoiceReconciliationLlm.js';

const INVOICE = {
  id: 'doc-inv-1',
  customer_name: 'Aroma Kahvila Oy',
  currency: 'EUR',
  total_amount: 2008,
  document_date: '2025-02-03',
  reference_number: 'LASKU 2025-014',
  structured_reference: '10014',
  parse_summary: { references: [{ type: 'invoice_number', value: '2025-014' }] }
};
const credit = (over = {}) => ({
  id: 'doc-cn-1',
  customer_name: 'Aroma Kahvila Oy',
  currency: 'EUR',
  total_amount: 376.5,
  applied_total: 0,
  document_date: '2025-02-06',
  reference_number: 'HYVITYS 2025-002',
  payment_status: 'credit_note',
  parse_status: 'completed',
  duplicate_of: null,
  parse_summary: { references: [{ type: 'invoice_number', value: '2025-014' }] },
  ...over
});
const eligible = (over = {}) => {
  const c = credit(over);
  const v = classifyCreditNoteEligibility({ invoice: INVOICE, credit: c });
  return { ...c, linkage: v.linkage, remaining: v.remaining, reasons: v.reasons };
};
const POLICY = { enabled: true, floor: 0.9, separation: 0.1, amountAbsTol: 0.01, amountRelTol: 0.005, fxMin: 0.3, fxMax: 3, feeFloor: 0.8, materialityCeiling: 500, materialityCeilingSource: 'pack:fi', materialityCeilingCurrency: 'EUR' };

test('signed credit amounts consume their magnitude, only for an explicit credit note', () => {
  for (const total_amount of [376.5, -376.5]) {
    const c = credit({ total_amount, applied_total: 100 });
    assert.equal(classifyCreditNoteEligibility({ invoice: INVOICE, credit: c }).remaining, 276.5);
    assert.equal(classifyCreditNoteEligibility({ invoice: INVOICE, credit: { ...c, applied_total: 376.5 } }).eligible, false);
    assert.equal(classifyCreditNoteEligibility({ invoice: INVOICE, credit: { ...c, payment_status: 'unpaid' } }).eligible, false);
  }
});

test('customer identity corresponds on suffix-stripped names, never on silence', () => {
  assert.equal(customerNamesCorrespond('Aroma Kahvila Oy', 'AROMA KAHVILA'), true);
  assert.equal(customerNamesCorrespond('Aroma Kahvila Oy', 'Aroma Oy'), true);
  assert.equal(customerNamesCorrespond('Aroma Kahvila Oy', 'Muu Asiakas Oy'), false);
  assert.equal(customerNamesCorrespond('', 'Aroma Kahvila Oy'), false);
});

test('linkage reads the cited invoice number, never the credit note\'s own number', () => {
  assert.deepEqual(citedInvoiceNumbersOf(credit()), ['2025014']);
  assert.equal(classifyCreditLinkage({ credit: credit(), invoice: INVOICE }), CREDIT_LINKAGE.LINKED);
  assert.equal(classifyCreditLinkage({ credit: credit({ parse_summary: { references: [] } }), invoice: INVOICE }), CREDIT_LINKAGE.UNLINKED);
  const other = { id: 'doc-inv-2', reference_number: 'LASKU 2025-031', parse_summary: {} };
  assert.equal(
    classifyCreditLinkage({ credit: credit({ parse_summary: { references: [{ type: 'invoice_number', value: '2025-031' }] } }), invoice: INVOICE, siblingInvoices: [other] }),
    CREDIT_LINKAGE.OTHER_INVOICE
  );
});

test('an explicitly cited different invoice is refused even before that invoice is uploaded', () => {
  const c = credit({ parse_summary: { references: [{ type: 'invoice_number', value: '2025-0140' }] } });
  assert.equal(classifyCreditLinkage({ credit: c, invoice: INVOICE }), CREDIT_LINKAGE.OTHER_INVOICE);
  assert.equal(classifyCreditNoteEligibility({ credit: c, invoice: INVOICE }).eligible, false);
  assert.equal(classifyCreditLinkage({ credit: credit({ parse_summary: { references: [{ type: 'invoice_number', value: '2025-099' }] } }), invoice: INVOICE }), CREDIT_LINKAGE.OTHER_INVOICE);
});

test('eligibility refuses wrong customer, wrong currency, exhausted, other-invoice and pre-dated credits by code', () => {
  assert.deepEqual(classifyCreditNoteEligibility({ invoice: INVOICE, credit: credit() }), { eligible: true, reasons: [], linkage: 'linked', remaining: 376.5 });
  const refuse = (over, code, extra = {}) => {
    const v = classifyCreditNoteEligibility({ invoice: INVOICE, credit: credit(over), ...extra });
    assert.equal(v.eligible, false, JSON.stringify(v));
    assert.ok(v.reasons.includes(code), `${code} in ${v.reasons}`);
  };
  refuse({ customer_name: 'Muu Asiakas Oy' }, CREDIT_REFUSAL_CODES.CUSTOMER_MISMATCH);
  refuse({ customer_name: '' }, CREDIT_REFUSAL_CODES.CUSTOMER_UNKNOWN);
  refuse({ currency: 'USD' }, CREDIT_REFUSAL_CODES.CURRENCY_MISMATCH);
  refuse({ applied_total: 376.5 }, CREDIT_REFUSAL_CODES.EXHAUSTED);
  refuse({ payment_status: 'unpaid' }, CREDIT_REFUSAL_CODES.NOT_ELIGIBLE);
  refuse({ document_date: '2025-01-20' }, CREDIT_REFUSAL_CODES.PREDATES_INVOICE);
  refuse(
    { parse_summary: { references: [{ type: 'invoice_number', value: '2025-031' }] } },
    CREDIT_REFUSAL_CODES.OTHER_INVOICE,
    { siblingInvoices: [{ id: 'doc-inv-2', reference_number: 'LASKU 2025-031' }] }
  );
});

test('the plan applies a selected credit only to what the invoice still needs, in the model\'s order', () => {
  const plan = planCreditApplications({ invoice: INVOICE, priorSettled: 0, bankAmount: 1631.5, bankCurrency: 'EUR', selectedIds: ['doc-cn-1'], creditNotes: [eligible()], policy: POLICY });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.applications.map((a) => [a.credit_document_id, a.amount, a.credit_ref, a.linkage]), [['doc-cn-1', 376.5, 'credit_1', 'linked']]);
  assert.equal(plan.creditTotal, 376.5);
  assert.equal(plan.remaining_after, 0);
  // A credit larger than the need applies partially; the rest stays available.
  const big = planCreditApplications({ invoice: INVOICE, bankAmount: 1631.5, bankCurrency: 'EUR', selectedIds: ['doc-cn-1'], creditNotes: [eligible({ total_amount: 400 })], policy: POLICY });
  assert.deepEqual(big.applications.map((a) => a.amount), [376.5]);
  // Nothing needed → nothing applied, receipted.
  const paid = planCreditApplications({ invoice: INVOICE, priorSettled: 2008, bankAmount: 0, selectedIds: ['doc-cn-1'], creditNotes: [eligible()], policy: POLICY });
  assert.equal(paid.applications.length, 0);
  assert.deepEqual(paid.refusals, [{ credit_document_id: 'doc-cn-1', code: CREDIT_REFUSAL_CODES.NOT_NEEDED }]);
  // An id outside the eligible universe never applies.
  const foreign = planCreditApplications({ invoice: INVOICE, bankAmount: 1631.5, bankCurrency: 'EUR', selectedIds: ['doc-cn-foreign'], creditNotes: [eligible()], policy: POLICY });
  assert.deepEqual(foreign.refusals, [{ credit_document_id: 'doc-cn-foreign', code: CREDIT_REFUSAL_CODES.NOT_ELIGIBLE }]);
  // A cross-currency bank line never carries a credit.
  const fx = planCreditApplications({ invoice: INVOICE, bankAmount: 1800, bankCurrency: 'USD', selectedIds: ['doc-cn-1'], creditNotes: [eligible()], policy: POLICY });
  assert.deepEqual(fx.refusals, [{ credit_document_id: 'doc-cn-1', code: CREDIT_REFUSAL_CODES.BANK_CURRENCY }]);
  // No selection: never subtract the customer's credits automatically.
  const none = planCreditApplications({ invoice: INVOICE, bankAmount: 1631.5, bankCurrency: 'EUR', selectedIds: [], creditNotes: [eligible()], policy: POLICY });
  assert.deepEqual(none.applications, []);
});

test('two equal-amount unlinked credits are a genuine ambiguity — refused for automatic application, whatever the confidence', () => {
  const a = eligible({ id: 'doc-cn-a', parse_summary: { references: [] } });
  const b = eligible({ id: 'doc-cn-b', parse_summary: { references: [] }, document_date: '2025-02-08' });
  const plan = planCreditApplications({ invoice: INVOICE, bankAmount: 1631.5, bankCurrency: 'EUR', selectedIds: ['doc-cn-a'], creditNotes: [a, b], policy: POLICY });
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.ambiguity, { code: CREDIT_REFUSAL_CODES.AMBIGUOUS, selected: 'doc-cn-a', competing: ['doc-cn-b'] });
  assert.deepEqual(plan.applications, []);
  const selectedBoth = planCreditApplications({ invoice: INVOICE, bankAmount: 1631.5, bankCurrency: 'EUR', selectedIds: ['doc-cn-a', 'doc-cn-b'], creditNotes: [a, b], policy: POLICY });
  assert.equal(selectedBoth.ok, false, 'naming both twins cannot authorize choosing the first when only one is needed');
  assert.equal(selectedBoth.ambiguity?.code, CREDIT_REFUSAL_CODES.AMBIGUOUS);
  // A LINKED selection is not ambiguous even with an equal twin.
  const linked = planCreditApplications({ invoice: INVOICE, bankAmount: 1631.5, bankCurrency: 'EUR', selectedIds: ['doc-cn-1'], creditNotes: [eligible(), b], policy: POLICY });
  assert.equal(linked.ambiguity, null);
  assert.equal(linked.ok, true);

});

test('the prompt section carries call-local handles and never a persisted id', () => {
  const section = formatCreditNotes([eligible()], { docNoun: 'invoice', invoice: INVOICE });
  assert.match(section, /credit_ref=credit_1/);
  assert.match(section, /available=376\.50/);
  assert.match(section, /cites THIS invoice's number/);
  assert.ok(!section.includes('doc-cn-1'));
  assert.equal(formatCreditNotes([], {}), null);
  const prompt = buildProposeMatchesUserPrompt({
    document: INVOICE,
    candidateBankLines: [{ id: 'tx-1', money_in: 1631.5, currency: 'EUR', date: '2025-02-20', description: 'AROMA KAHVILA OY' }],
    firmContext: { creditNotes: [eligible()], settlement: { settledCount: 0, appliedCredits: 0, remainingDue: 2008 } }
  });
  assert.match(prompt, /Customer credit notes that MAY reduce this invoice/);
  assert.match(prompt, /remaining due: 2008\.00/);
  assert.ok(!prompt.includes('doc-cn-1'));
  assert.equal(creditRefForIndex(0), 'credit_1');
});

test('the parser maps credit handles back to persisted ids inside the trusted boundary; unknown handles are dropped and counted', () => {
  const lines = [{ id: 'tx-1' }];
  const credits = [{ id: 'doc-cn-1' }, { id: 'doc-cn-2' }];
  const text = JSON.stringify({
    proposals: [{ candidate_ref: 'candidate_1', confidence: 0.94, reasoning: 'closes to the cent', hops: ['amount_exact'], applied_credits: ['credit_2', 'credit_9', 'doc-cn-1'] }],
    credit_applications: [{ credit_ref: 'credit_1', confidence: 0.9, reasoning: 'settles the rest' }, 'credit_7'],
    unmatchable_reason: null
  });
  const out = parseProposeMatchesResponse(text, lines, { creditNotes: credits });
  assert.deepEqual(out.proposals[0].applied_credit_document_ids, ['doc-cn-2']);
  assert.equal(out.proposals[0].invalid_credit_refs, 2, 'a bare id and an unknown handle never resolve');
  assert.deepEqual(out.credit_applications, [{ credit_document_id: 'doc-cn-1', confidence: 0.9, reasoning: 'settles the rest' }]);
  assert.equal(out.invalid_credit_refs, 1);
  // Without the option the output shape is byte-identical to before.
  const legacy = parseProposeMatchesResponse(text, lines);
  assert.deepEqual(Object.keys(legacy), ['proposals', 'unmatchable_reason']);
  assert.deepEqual(Object.keys(legacy.proposals[0]), ['bank_transaction_id', 'confidence', 'reasoning', 'hops']);
});

test('Gate C closes on bank line + prior settled + applied credits in the document currency, and stays byte-identical without them', () => {
  const document = { total_amount: 2008, currency: 'EUR' };
  assert.equal(amountReconciles({ matchAmount: 1631.5, bankCurrency: 'EUR', document, hops: ['amount_exact'], policy: POLICY }), false);
  assert.equal(amountReconciles({ matchAmount: 1631.5, bankCurrency: 'EUR', document, hops: ['amount_exact'], policy: POLICY, creditApplied: 376.5 }), true);
  assert.equal(amountReconciles({ matchAmount: 1008, bankCurrency: 'EUR', document, hops: [], policy: POLICY, priorSettled: 1000 }), true, 'a completing partial closes without a hop');
  assert.equal(amountReconciles({ matchAmount: 2008, bankCurrency: 'EUR', document, hops: [], policy: POLICY, priorSettled: 1000 }), false, 'a second full deposit over-settles');
  assert.equal(amountReconciles({ matchAmount: 1800, bankCurrency: 'USD', document, hops: ['fx_conversion_EUR_USD'], policy: POLICY, creditApplied: 376.5 }), true, 'cross-currency judges the bank amount alone');
  const receipt = buildCreditReceipt({ plan: { refusals: [], ambiguity: null }, live: { applications: [{ credit_document_id: 'doc-cn-1', amount: 376.5, linkage: 'linked' }], refusals: [] }, eligibleCount: 1 });
  const auth = authorizeMatch({
    proposal: { bank_transaction_id: 'tx-1', confidence: 0.94, hops: ['amount_exact'] },
    allProposals: [{ bank_transaction_id: 'tx-1', confidence: 0.94 }],
    bankLine: { id: 'tx-1', money_in: 1631.5, currency: 'EUR', contact: 'Aroma Kahvila Oy' },
    candidateBankLines: [{ id: 'tx-1', money_in: 1631.5, currency: 'EUR', contact: 'Aroma Kahvila Oy' }],
    document, matchAmount: 1631.5, clientId: 'c1', policy: POLICY, env: {}, creditApplied: 376.5, creditReceipt: receipt
  });
  assert.equal(auth.gates.C, true);
  assert.equal(auth.gates.E, false, 'the materiality ceiling still holds the material line for the D2 path');
  assert.deepEqual(auth.reasons, ['above_materiality_ceiling']);
  assert.deepEqual(auth.credit_notes.applied, [{ credit_document_id: 'doc-cn-1', amount: 376.5, linkage: 'linked', already_applied: false }]);
  const plain = authorizeMatch({
    proposal: { bank_transaction_id: 'tx-1', confidence: 0.94, hops: ['amount_exact'] }, allProposals: [],
    bankLine: { id: 'tx-1', money_in: 2008, currency: 'EUR' }, candidateBankLines: [], document, matchAmount: 2008, clientId: 'c1', policy: POLICY, env: {}
  });
  assert.ok(!('credit_notes' in plain), 'no credit receipt key without credits in play');
});

test('credit-only authorization runs the same gate law over the applied credit total', () => {
  const okPlan = { ok: true, applications: [{ credit_document_id: 'doc-cn-1', amount: 300 }], refusals: [], ambiguity: null, creditTotal: 300 };
  const auto = authorizeCreditOnlyApplication({ confidence: 0.93, plan: okPlan, policy: POLICY });
  assert.equal(auto.band, 'auto_matched');
  assert.deepEqual(auto.gates, { A: true, B: true, C: true, D: true, E: true });
  const material = authorizeCreditOnlyApplication({ confidence: 0.93, plan: { ...okPlan, creditTotal: 900, applications: [{ credit_document_id: 'doc-cn-1', amount: 900 }] }, policy: POLICY });
  assert.equal(material.band, 'suggested');
  assert.deepEqual(material.reasons, ['above_materiality_ceiling'], 'held ONLY by materiality — the D2 auto-FYI shape');
  const low = authorizeCreditOnlyApplication({ confidence: 0.6, plan: okPlan, policy: POLICY });
  assert.ok(low.reasons.includes('below_floor'));
  const ambiguous = authorizeCreditOnlyApplication({ confidence: 0.95, plan: { ...okPlan, ok: false, applications: [], ambiguity: { code: 'ambiguous_credit_notes' } }, policy: POLICY });
  assert.ok(ambiguous.reasons.includes('ambiguous_candidates'));
  assert.equal(authorizeCreditOnlyApplication({ confidence: 0.95, plan: okPlan, policy: { ...POLICY, enabled: false } }).band, 'suggested');
  assert.equal(authorizeCreditOnlyApplication({ confidence: 0.95, plan: okPlan, policy: POLICY, clientAllowed: false }).reasons[0], 'client_not_in_auto_match_allowlist');
});

test('the owned transaction probes for an enclosing transaction and rolls back with the caller on failure', async () => {
  const calls = [];
  const bare = { query: async (sql) => { calls.push(sql); if (/^savepoint/i.test(sql)) { const e = new Error('no txn'); e.code = '25P01'; throw e; } return { rows: [] }; } };
  await withCreditApplicationTransaction(bare, async () => 'ok');
  assert.deepEqual(calls, ['savepoint donna_credit_application', 'begin', 'commit']);
  calls.length = 0;
  await assert.rejects(withCreditApplicationTransaction(bare, async () => { throw new Error('boom'); }), /boom/);
  assert.deepEqual(calls, ['savepoint donna_credit_application', 'begin', 'rollback']);
  const inner = { query: async (sql) => { calls.push(sql); return { rows: [] }; } };
  calls.length = 0;
  await assert.rejects(withCreditApplicationTransaction(inner, async () => { throw new Error('boom'); }), /boom/);
  assert.deepEqual(calls, ['savepoint donna_credit_application', 'rollback to savepoint donna_credit_application', 'release savepoint donna_credit_application']);
  assert.match(makeCreditApplicationId({ clientId: 'c', creditDocumentId: 'doc-cn-1', invoiceDocumentId: 'doc-inv-1' }), /^credapp-doc-cn-1-doc-inv-1-/);
  assert.match(makeCreditApplicationId({ clientId: 'c', creditDocumentId: 'doc-cn-1', invoiceDocumentId: 'doc-inv-1', generation: 2 }), /-g2-/);
});
