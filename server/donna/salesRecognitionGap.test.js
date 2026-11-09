// FI-09 — the pure census: which uploaded sales documents an accrual book's
// posted ledger does not recognise in the period, and why.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRecognitionGap, recognitionStatement, recognitionDraftReason, buildSalesRecognitionQuestion, buildSupplierBillSettlementQuestion } from './salesRecognitionGap.js';

const FEB = { starts_on: '2025-02-01', ends_on: '2025-02-28' };
const doc = (id, extra = {}) => ({ id, filename: `${id}.pdf`, document_type: 'sales_invoice', document_date: '2025-02-12', total_amount: 903.6, tax_amount: 183.6,
  currency: 'EUR', customer_name: 'Lumikki Oy', payment_status: 'unpaid', reference_number: null, parse_summary: { references: [{ type: 'invoice_number', value: '1002' }] }, payload: {}, ...extra });
const ids = (gap) => gap.items.map((i) => i.document_id);

test('cash books recognise at settlement: nothing is excluded', () => {
  const gap = classifyRecognitionGap({ basis: 'cash', period: FEB, documents: [doc('lumikki')] });
  assert.equal(gap.applies, false); assert.equal(gap.status, 'not_applicable'); assert.deepEqual(gap.items, []);
});

test('accrual: an unpaid invoice is excluded with its net and tax, on nobody until asked (Kultalanka CG-1)', () => {
  const gap = classifyRecognitionGap({ basis: 'accrual', period: FEB, documents: [doc('lumikki')] });
  assert.equal(gap.status, 'excluded');
  assert.deepEqual(gap.items.map((i) => [i.document_id, i.kind, i.net, i.tax, i.rests, i.on_nobody, i.invoice_numbers]), [['lumikki', 'invoice', 720, 183.6, 'no_settlement', true, ['1002']]]);
  assert.deepEqual(gap.totals, [{ currency: 'EUR', count: 1, gross: 903.6, net: 720, tax: 183.6, tax_unknown_count: 0 }]);
  const asked = classifyRecognitionGap({ basis: 'accrual', period: FEB, documents: [doc('lumikki')],
    asks: [{ id: 'ask-1', status: 'draft', evidence_type: 'payment_method', request_payload: { document_id: 'lumikki' } }] });
  assert.equal(asked.items[0].on_nobody, false); assert.equal(asked.items[0].held_by[0].anchor, 'document');
  assert.match(recognitionStatement(gap), /1 uploaded sales document is not recognised .* 720\.00 EUR net \+ 183\.60 tax/);
  assert.equal(recognitionDraftReason(gap).code, 'unrecognized_sales_documents');
  assert.equal(recognitionDraftReason({ items: [] }), null);
});

test('accrual: settlement inside the period represents the invoice; outside, unposted or proposed it does not', () => {
  const matches = [
    { id: 'm-in', bank_transaction_id: 'tx-in', matched_object_id: 'paid-in', status: 'auto_matched', payload: {} },
    { id: 'm-later', bank_transaction_id: 'tx-later', matched_object_id: 'paid-later', status: 'confirmed', payload: {} },
    { id: 'm-held', bank_transaction_id: 'tx-held', matched_object_id: 'held', status: 'auto_matched', payload: {} },
    { id: 'm-sugg', bank_transaction_id: 'tx-sugg', matched_object_id: 'suggested', status: 'suggested', payload: {} }
  ];
  const journals = [{ source_id: 'tx-in', journal_date: '2025-02-20' }, { source_id: 'tx-later', journal_date: '2025-03-05' }];
  const gap = classifyRecognitionGap({ basis: 'accrual', period: FEB, documents: ['paid-in', 'paid-later', 'held', 'suggested'].map((id) => doc(id)),
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
  const gap = classifyRecognitionGap({ basis: 'accrual', period: FEB, documents, matches,
    transactionJournals: [{ source_id: 'tx-rem', journal_date: '2025-02-24' }, { source_id: 'tx-aroma', journal_date: '2025-02-20' }],
    issuedJournals: [{ source_id: 'INV-77' }],
    applications: [{ credit_document_id: 'aroma-cn', invoice_document_id: 'aroma', amount: 376.5, settlement_match_id: 'm-aroma', counterpart_date: '2025-02-03' }] });
  assert.deepEqual(ids(gap), []);
  assert.equal(gap.status, 'none');
});

test('accrual: an unapplied credit note is excluded negatively; an undated invoice is uncertainty, never attributed', () => {
  const gap = classifyRecognitionGap({ basis: 'unresolved', period: FEB, documents: [
    doc('cn', { total_amount: -376.5, tax_amount: -76.5, payment_status: 'credit_note' }),
    doc('undated', { document_date: null, tax_amount: null, currency: 'eur' })
  ] });
  assert.equal(gap.applies, true);
  assert.deepEqual(gap.items.map((i) => [i.document_id, i.kind, i.gross, i.net, i.tax, i.period_scope]),
    [['cn', 'credit_note', -376.5, -300, -76.5, 'in_period'], ['undated', 'invoice', 903.6, null, null, 'period_unknown']]);
  assert.deepEqual(gap.totals, [{ currency: 'EUR', count: 2, gross: 527.1, net: -300, tax: -76.5, tax_unknown_count: 1 }]);
});

// The purchase side of the same census: uploaded supplier bills and supplier
// credit notes on an accrual book, named with their expense and input tax.
const sbill = (id, extra = {}) => doc(id, { document_type: 'supplier_bill', customer_name: null, vendor_name: 'Tukku Oy', total_amount: 248, tax_amount: 48,
  document_date: '2025-02-05', parse_summary: { references: [{ type: 'invoice_number', value: '4711' }] }, ...extra });

test('purchase: cash books are unchanged; an unresolved basis reports as the sales side does', () => {
  const cash = classifyRecognitionGap({ side: 'purchase', basis: 'cash', period: FEB, documents: [sbill('tukku')] });
  assert.deepEqual([cash.applies, cash.status, cash.items, cash.blocker], [false, 'not_applicable', [], 'unrecognized_purchase_documents']);
  const unresolved = classifyRecognitionGap({ side: 'purchase', basis: 'unresolved', period: FEB, documents: [sbill('tukku')] });
  assert.deepEqual([unresolved.applies, unresolved.items.map((i) => i.document_id)], [true, ['tukku']]);
});

test('purchase: an unpaid bill is excluded with its expense and input tax under its own blocker; the sales side never reads it', () => {
  const documents = [sbill('tukku'), doc('lumikki')];
  const asks = [{ id: 'ask-b', status: 'draft', evidence_type: 'payment_method', request_payload: { document_id: 'tukku', lane: 'supplier_bill_settlement' } }];
  const purchase = classifyRecognitionGap({ side: 'purchase', basis: 'accrual', period: FEB, documents, asks });
  const sales = classifyRecognitionGap({ side: 'sales', basis: 'accrual', period: FEB, documents, asks });
  assert.deepEqual(purchase.items.map((i) => [i.document_id, i.side, i.kind, i.vendor, i.counterparty, i.net, i.tax, i.rests, i.on_nobody]),
    [['tukku', 'purchase', 'invoice', 'Tukku Oy', 'Tukku Oy', 200, 48, 'no_settlement', false]]);
  assert.deepEqual(sales.items.map((i) => i.document_id), ['lumikki']);
  assert.equal(recognitionStatement(purchase), '1 uploaded supplier document is not recognised in this period\'s posted ledger and is excluded from these figures: 200.00 EUR expense + 48.00 input tax.');
  assert.match(recognitionStatement(sales), /1 uploaded sales document is not recognised .* 720\.00 EUR net \+ 183\.60 tax/);
  assert.deepEqual(recognitionDraftReason(purchase), { code: 'unrecognized_purchase_documents', detail: recognitionStatement(purchase), count: 1,
    totals: [{ currency: 'EUR', count: 1, gross: 248, net: 200, tax: 48, tax_unknown_count: 0 }], document_ids: ['tukku'] });
});

test('purchase: each resting state, an instalment bill as one entry, and the owner-funds journal as a settlement', () => {
  const documents = ['paid-in', 'instalments', 'instalments-later', 'paid-later', 'held', 'suggested', 'owner-cash', 'owner-cash-later'].map((id) => sbill(id));
  const matches = [
    { id: 'm-in', bank_transaction_id: 'tx-in', matched_object_id: 'paid-in', status: 'auto_matched', payload: {} },
    // One bill, two instalments: one inside the period represents it once.
    { id: 'm-i1', bank_transaction_id: 'tx-i1', matched_object_id: 'instalments', status: 'confirmed', payload: {} },
    { id: 'm-i2', bank_transaction_id: 'tx-i2', matched_object_id: 'instalments', status: 'confirmed', payload: {} },
    // Both instalments after the period: one entry, not two.
    { id: 'm-l1', bank_transaction_id: 'tx-l1', matched_object_id: 'instalments-later', status: 'confirmed', payload: {} },
    { id: 'm-l2', bank_transaction_id: 'tx-l2', matched_object_id: 'instalments-later', status: 'confirmed', payload: {} },
    { id: 'm-later', bank_transaction_id: 'tx-later', matched_object_id: 'paid-later', status: 'auto_matched', payload: {} },
    { id: 'm-held', bank_transaction_id: 'tx-held', matched_object_id: 'held', status: 'auto_matched', payload: {} },
    { id: 'm-sugg', bank_transaction_id: 'tx-sugg', matched_object_id: 'suggested', status: 'suggested', payload: {} }
  ];
  const transactionJournals = [['tx-in', '2025-02-20'], ['tx-i1', '2025-02-15'], ['tx-i2', '2025-03-15'], ['tx-l1', '2025-03-10'], ['tx-l2', '2025-04-10'], ['tx-later', '2025-03-05']]
    .map(([source_id, journal_date]) => ({ source_id, journal_date }));
  const documentJournals = [{ source_id: 'owner-cash', journal_date: '2025-02-05' }, { source_id: 'owner-cash-later', journal_date: '2025-03-01' }];
  const gap = classifyRecognitionGap({ side: 'purchase', basis: 'accrual', period: FEB, documents, matches, transactionJournals, documentJournals });
  assert.deepEqual(gap.items.map((i) => [i.document_id, i.rests]), [
    ['instalments-later', 'settled_outside_period'], ['paid-later', 'settled_outside_period'], ['held', 'settlement_unposted'],
    ['suggested', 'settlement_proposed'], ['owner-cash-later', 'settled_outside_period']]);
  assert.deepEqual(gap.items[0].settlement, { transaction_ids: ['tx-l1', 'tx-l2'], journal_dates: ['2025-03-10', '2025-04-10'] });
  assert.deepEqual(gap.represented, [{ document_id: 'paid-in', by: 'settlement_journal' }, { document_id: 'instalments', by: 'settlement_journal' },
    { document_id: 'owner-cash', by: 'settlement_journal' }]);
  // Every in-scope document is in exactly one of the two lists.
  assert.equal(gap.items.length + gap.represented.length, documents.length);
  // The period the payment landed in does not list the February bill again.
  const march = classifyRecognitionGap({ side: 'purchase', basis: 'accrual', period: { starts_on: '2025-03-01', ends_on: '2025-03-31' }, documents, matches, transactionJournals, documentJournals });
  assert.deepEqual(march.items, []);
});

test('purchase: an unsettled supplier credit note reduces the excluded expense and input tax; one refunded in the period is represented', () => {
  const documents = [sbill('tukku'), sbill('tukku-cn', { total_amount: -62, tax_amount: -12, payment_status: 'credit_note' }),
    sbill('refunded-cn', { total_amount: -31, tax_amount: -6, payment_status: 'credit_note' })];
  const matches = [{ id: 'm-ref', bank_transaction_id: 'tx-ref', matched_object_id: 'refunded-cn', status: 'auto_matched', payload: {} }];
  const gap = classifyRecognitionGap({ side: 'purchase', basis: 'accrual', period: FEB, documents, matches,
    transactionJournals: [{ source_id: 'tx-ref', journal_date: '2025-02-18' }] });
  assert.deepEqual(gap.items.map((i) => [i.document_id, i.kind, i.gross, i.net, i.tax]), [['tukku', 'invoice', 248, 200, 48], ['tukku-cn', 'credit_note', -62, -50, -12]]);
  assert.deepEqual(gap.totals, [{ currency: 'EUR', count: 2, gross: 186, net: 150, tax: 36, tax_unknown_count: 0 }]);
  assert.deepEqual(gap.represented, [{ document_id: 'refunded-cn', by: 'settlement_journal' }]);
  assert.match(recognitionStatement(gap), /^2 uploaded supplier documents are not recognised .*: 150\.00 EUR expense \+ 36\.00 input tax\.$/);
});

test('purchase: a supplier bill whose number matches an issued sales journal is still a purchase, never an issued twin', () => {
  const gap = classifyRecognitionGap({ side: 'purchase', basis: 'accrual', period: FEB, documents: [sbill('tukku')], issuedJournals: [{ source_id: '4711' }] });
  assert.deepEqual(gap.items.map((i) => i.document_id), ['tukku']);
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
    + 'ja luonnoksissa se näkyy pois jätettynä. Onko asiakas maksanut laskun? Jos on, milloin ja mille tilille? '
    + 'Jos lasku on vielä maksamatta, vastaa "vielä maksamatta".');
});

// The supplier-bill question invites only answers the doc-ask reply path
// consumes: an account and a date, or the owner's own cash or personal card.
// An unpaid bill needs no reply; its later bank line resolves the question.
const bill = doc('tukku', { document_type: 'supplier_bill', customer_name: null, vendor_name: 'Tukku Oy', total_amount: 248, tax_amount: 48,
  document_date: '2025-02-05', parse_summary: { references: [{ type: 'invoice_number', value: '4711' }] } });
test('the supplier-bill question in English names the bill and asks whether, when and how it was paid', () => {
  assert.equal(buildSupplierBillSettlementQuestion({ document: bill }),
    'Supplier bill 4711 from Tukku Oy (248.00 EUR, dated 2025-02-05) has no payment on the bank statements Donna holds. '
    + 'Donna does not yet record an unpaid supplier bill in the books, so it is missing from that period\'s expenses and VAT. '
    + 'Has it been paid? If so, when, and from which account? If you paid it with your own money, in cash or on a personal card, say which. '
    + 'If it is still unpaid, you don\'t need to reply now: this question closes on its own once the payment shows on a bank statement you send.');
});
test('the supplier-bill question in Finnish', () => {
  assert.equal(buildSupplierBillSettlementQuestion({ document: bill, language: 'fi' }),
    'Ostolasku 4711 (Tukku Oy, 248,00 EUR, päivätty 5.2.2025): Donnalla olevissa tiliotteissa ei näy tälle laskulle maksua. '
    + 'Donna ei vielä kirjaa maksamatonta ostolaskua kirjanpitoon, joten se puuttuu sen kauden kuluista ja arvonlisäverosta. '
    + 'Onko lasku maksettu? Jos on, milloin ja miltä tililtä? Jos maksoit sen omilla rahoillasi käteisellä tai omalla kortillasi, kerro kumpi. '
    + 'Jos lasku on vielä maksamatta, sinun ei tarvitse vastata nyt: kysymys sulkeutuu itsestään, kun maksu näkyy tiliotteella, jonka lähetät.');
});
