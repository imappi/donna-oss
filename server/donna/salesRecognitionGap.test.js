// FI-09 — the pure census: which uploaded sales documents an accrual book's
// posted ledger does not recognise in the period, and why.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySalesRecognitionGap, salesRecognitionStatement, salesRecognitionDraftReason, buildSalesRecognitionQuestion, buildSupplierBillSettlementQuestion,
  noSettlementAskStillOpen, NO_SETTLEMENT_STILL_OPEN_RECHECK_DAYS, SALES_RECOGNITION_ASK_LANE, SUPPLIER_BILL_SETTLEMENT_ASK_LANE } from './salesRecognitionGap.js';

const FEB = { starts_on: '2025-02-01', ends_on: '2025-02-28' };
const doc = (id, extra = {}) => ({ id, filename: `${id}.pdf`, document_type: 'sales_invoice', document_date: '2025-02-12', total_amount: 903.6, tax_amount: 183.6,
  currency: 'EUR', customer_name: 'Lumikki Oy', payment_status: 'unpaid', reference_number: null, parse_summary: { references: [{ type: 'invoice_number', value: '1002' }] }, payload: {}, ...extra });
const ids = (gap) => gap.items.map((i) => i.document_id);

test('cash books recognise at settlement: nothing is excluded', () => {
  const gap = classifySalesRecognitionGap({ basis: 'cash', period: FEB, documents: [doc('lumikki')] });
  assert.equal(gap.applies, false); assert.equal(gap.status, 'not_applicable'); assert.deepEqual(gap.items, []);
});

test('accrual: an unpaid invoice is excluded with its net and tax, on nobody until asked (Kultalanka CG-1)', () => {
  const gap = classifySalesRecognitionGap({ basis: 'accrual', period: FEB, documents: [doc('lumikki')] });
  assert.equal(gap.status, 'excluded');
  assert.deepEqual(gap.items.map((i) => [i.document_id, i.kind, i.net, i.tax, i.rests, i.on_nobody, i.invoice_numbers]), [['lumikki', 'invoice', 720, 183.6, 'no_settlement', true, ['1002']]]);
  assert.deepEqual(gap.totals, [{ currency: 'EUR', count: 1, gross: 903.6, net: 720, tax: 183.6, tax_unknown_count: 0 }]);
  const asked = classifySalesRecognitionGap({ basis: 'accrual', period: FEB, documents: [doc('lumikki')],
    asks: [{ id: 'ask-1', status: 'draft', evidence_type: 'payment_method', request_payload: { document_id: 'lumikki' } }] });
  assert.equal(asked.items[0].on_nobody, false); assert.equal(asked.items[0].held_by[0].anchor, 'document');
  assert.match(salesRecognitionStatement(gap), /1 uploaded sales document is not recognised .* 720\.00 EUR net \+ 183\.60 tax/);
  assert.equal(salesRecognitionDraftReason(gap).code, 'unrecognized_sales_documents');
  assert.equal(salesRecognitionDraftReason({ items: [] }), null);
});

test('accrual: settlement inside the period represents the invoice; outside, unposted or proposed it does not', () => {
  const matches = [
    { id: 'm-in', bank_transaction_id: 'tx-in', matched_object_id: 'paid-in', status: 'auto_matched', payload: {} },
    { id: 'm-later', bank_transaction_id: 'tx-later', matched_object_id: 'paid-later', status: 'confirmed', payload: {} },
    { id: 'm-held', bank_transaction_id: 'tx-held', matched_object_id: 'held', status: 'auto_matched', payload: {} },
    { id: 'm-sugg', bank_transaction_id: 'tx-sugg', matched_object_id: 'suggested', status: 'suggested', payload: {} }
  ];
  const journals = [{ source_id: 'tx-in', journal_date: '2025-02-20' }, { source_id: 'tx-later', journal_date: '2025-03-05' }];
  const gap = classifySalesRecognitionGap({ basis: 'accrual', period: FEB, documents: ['paid-in', 'paid-later', 'held', 'suggested'].map((id) => doc(id)),
    matches, transactionJournals: journals, asks: [{ id: 'q', status: 'open', evidence_type: 'document_discrepancy', transaction_id: 'tx-held', request_payload: {} }] });
  assert.deepEqual(gap.items.map((i) => [i.document_id, i.rests]), [['paid-later', 'settled_outside_period'], ['held', 'settlement_unposted'], ['suggested', 'settlement_proposed']]);
  assert.deepEqual(gap.items.find((i) => i.document_id === 'held').held_by.map((h) => h.anchor), ['transaction']);
});

test('accrual: an issued-invoice twin, a reminder, an out-of-period date and a settled credit note are not excluded twice', () => {
  const documents = [
    doc('issued', { reference_number: 'INV-77', parse_summary: {} }),
    doc('reminder', { payload: { reminder_obligation: { status: 'applied', reminder_document_id: 'reminder', invoice_document_id: 'orig' } } }),
    doc('orig'),
    doc('january', { document_date: '2025-01-31' }),
    doc('aroma', { total_amount: 2008, tax_amount: 408 }),
    doc('aroma-cn', { total_amount: -376.5, tax_amount: -76.5, payment_status: 'credit_note' })
  ];
  const matches = [
    { id: 'm-rem', bank_transaction_id: 'tx-rem', matched_object_id: 'reminder', status: 'auto_matched', payload: { reminder_obligation: { status: 'applied', invoice_document_id: 'orig' } } },
    { id: 'm-aroma', bank_transaction_id: 'tx-aroma', matched_object_id: 'aroma', status: 'auto_matched', payload: {} }
  ];
  const gap = classifySalesRecognitionGap({ basis: 'accrual', period: FEB, documents, matches,
    transactionJournals: [{ source_id: 'tx-rem', journal_date: '2025-02-24' }, { source_id: 'tx-aroma', journal_date: '2025-02-20' }],
    issuedJournals: [{ source_id: 'INV-77' }],
    applications: [{ credit_document_id: 'aroma-cn', invoice_document_id: 'aroma', amount: 376.5, settlement_match_id: 'm-aroma', counterpart_date: '2025-02-03' }] });
  assert.deepEqual(ids(gap), []);
  assert.equal(gap.status, 'none');
});

test('accrual: an unapplied credit note is excluded negatively; an undated invoice is uncertainty, never attributed', () => {
  const gap = classifySalesRecognitionGap({ basis: 'unresolved', period: FEB, documents: [
    doc('cn', { total_amount: -376.5, tax_amount: -76.5, payment_status: 'credit_note' }),
    doc('undated', { document_date: null, tax_amount: null, currency: 'eur' })
  ] });
  assert.equal(gap.applies, true);
  assert.deepEqual(gap.items.map((i) => [i.document_id, i.kind, i.gross, i.net, i.tax, i.period_scope]),
    [['cn', 'credit_note', -376.5, -300, -76.5, 'in_period'], ['undated', 'invoice', 903.6, null, null, 'period_unknown']]);
  assert.deepEqual(gap.totals, [{ currency: 'EUR', count: 2, gross: 527.1, net: -300, tax: -76.5, tax_unknown_count: 1 }]);
});

test('the owner question names the invoice and asks only the payment fact', () => {
  const q = buildSalesRecognitionQuestion({ document: doc('lumikki') });
  assert.match(q, /^Sales invoice 1002 to Lumikki Oy \(903\.60 EUR, dated 2025-02-12\) has no payment/);
  assert.match(q, /still unpaid/);
});

test('the sales question in Finnish: the same payment fact, plain everyday words', () => {
  const q = buildSalesRecognitionQuestion({ document: doc('lumikki'), language: 'fi' });
  assert.equal(q, 'Myyntilasku 1002 (Lumikki Oy, 903,60 EUR, päivätty 12.2.2025): Donnalla olevissa tiliotteissa ei näy tälle laskulle maksua. '
    + 'Donna ei vielä kirjaa maksamatonta myyntilaskua kirjanpitoon, joten se jää pois sen kauden myynnistä ja arvonlisäverosta, '
    + 'ja luonnoksissa se näkyy pois jätettynä. Onko asiakas maksanut laskun? Jos se on maksettu, kerro milloin ja mille tilille. '
    + 'Jos se on vielä maksamatta, vastaa "vielä maksamatta".');
});

// The supplier-bill question invites only answers the doc-ask reply path
// consumes: an account and a date, the owner's own cash or personal card, or
// "still unpaid" (the lane's stillOpen answer). Its later bank line resolves it.
const bill = doc('tukku', { document_type: 'supplier_bill', customer_name: null, vendor_name: 'Tukku Oy', total_amount: 248, tax_amount: 48,
  document_date: '2025-02-05', parse_summary: { references: [{ type: 'invoice_number', value: '4711' }] } });
test('the supplier-bill question in English names the bill and asks whether, when and how it was paid', () => {
  assert.equal(buildSupplierBillSettlementQuestion({ document: bill }),
    'Supplier bill 4711 from Tukku Oy (248.00 EUR, dated 2025-02-05) has no payment on the bank statements Donna holds. '
    + 'Donna does not yet record an unpaid supplier bill in the books, so it is missing from that period\'s expenses and VAT. '
    + 'Has it been paid? If it has been paid, reply when and from which account, or, if you paid it with your own money in cash or on a personal card, say which. '
    + 'If it is still unpaid, reply "still unpaid".');
});
test('the supplier-bill question in Finnish', () => {
  assert.equal(buildSupplierBillSettlementQuestion({ document: bill, language: 'fi' }),
    'Ostolasku 4711 (Tukku Oy, 248,00 EUR, päivätty 5.2.2025): Donnalla olevissa tiliotteissa ei näy tälle laskulle maksua. '
    + 'Donna ei vielä kirjaa maksamatonta ostolaskua kirjanpitoon, joten se puuttuu sen kauden kuluista ja arvonlisäverosta. '
    + 'Onko lasku maksettu? Jos se on maksettu, kerro milloin ja miltä tililtä, tai jos maksoit sen omilla rahoillasi käteisellä tai omalla kortillasi, kerro kumpi. '
    + 'Jos se on vielä maksamatta, vastaa "vielä maksamatta".');
});

test('both no-settlement questions end the same way in each language, and both lanes accept "still unpaid"', () => {
  const sales = doc('lumikki');
  for (const [language, ending] of [['en', 'If it is still unpaid, reply "still unpaid".'], ['fi', 'Jos se on vielä maksamatta, vastaa "vielä maksamatta".']]) {
    assert.ok(buildSalesRecognitionQuestion({ document: sales, language }).endsWith(ending), language);
    assert.ok(buildSupplierBillSettlementQuestion({ document: bill, language }).endsWith(ending), language);
  }
  assert.equal(buildSalesRecognitionQuestion({ document: sales }),
    'Sales invoice 1002 to Lumikki Oy (903.60 EUR, dated 2025-02-12) has no payment on the bank statements Donna holds. '
    + 'Donna does not yet record an unpaid sales invoice in the books, so it is left out of that period\'s sales and VAT figures, and the drafts list it as excluded. '
    + 'Has the customer paid it? If it has been paid, reply when and into which account. If it is still unpaid, reply "still unpaid".');
  for (const lane of [SALES_RECOGNITION_ASK_LANE, SUPPLIER_BILL_SETTLEMENT_ASK_LANE]) {
    const stillOpen = noSettlementAskStillOpen(lane);
    assert.match(stillOpen.meaning, /not paid .* yet/);
    assert.equal(stillOpen.recheckDays, NO_SETTLEMENT_STILL_OPEN_RECHECK_DAYS);
  }
  assert.equal(noSettlementAskStillOpen('owner_reply_clarification'), null);
  assert.equal(noSettlementAskStillOpen(undefined), null);
});
