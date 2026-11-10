// FI-09 — the pure census: which uploaded sales documents an accrual book's
// posted ledger does not recognise in the period, and why.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRecognitionGap, recognitionStatement, recognitionDraftReason, buildSalesRecognitionQuestion, buildSupplierBillSettlementQuestion, buildSupplierCreditNoteQuestion, toCents,
  noSettlementAskStillOpen, NO_SETTLEMENT_STILL_OPEN_RECHECK_DAYS, SALES_RECOGNITION_ASK_LANE, SUPPLIER_BILL_SETTLEMENT_ASK_LANE,
  noSettlementAskLaneAnswers, buildSettlementShortfallQuestion, recordedBankFeeCents } from './salesRecognitionGap.js';

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

// Part-paid documents: an instalment posted inside the period recognises only
// itself. The unpaid remainder is an item, named with its amount, computed in
// cents from the stored decimals.
const posted = (id, docId, amount, journalDate, extra = {}) => ({
  match: { id: `m-${id}`, bank_transaction_id: id, matched_object_id: docId, status: 'confirmed', match_amount: amount, payload: {}, ...extra },
  journal: journalDate ? { source_id: id, journal_date: journalDate } : null
});
const book = (rows) => ({ matches: rows.map((r) => r.match), transactionJournals: rows.map((r) => r.journal).filter(Boolean) });

test('money is read as cents from the stored decimal text', () => {
  assert.deepEqual(['1004.00', '0.10', '-62.00', '183.6', 903.6, 0.1 + 0.2, '12.345', '7', null, '', 'abc'].map(toCents),
    [100400, 10, -6200, 18360, 90360, 30, 1235, 700, null, null, null]);
});

test('part-paid: a sales invoice and a supplier bill with one instalment in the period name their unpaid remainder', () => {
  const salesRows = [posted('tx-1', 'osa', '502.00', '2025-02-20'), posted('tx-2', 'osa', '502.00', '2025-03-20'),
    posted('tx-3', 'full', '125.50', '2025-02-10'), posted('tx-4', 'full', '125.50', '2025-02-24')];
  const sales = classifyRecognitionGap({ basis: 'accrual', period: FEB, ...book(salesRows),
    documents: [doc('osa', { total_amount: '1004.00', tax_amount: '204.00' }), doc('full', { total_amount: '251.00', tax_amount: '51.00' })] });
  assert.deepEqual(sales.items.map((i) => [i.document_id, i.rests, i.gross, i.net, i.tax]), [['osa', 'part_settled_in_period', 502, 400, 102]]);
  assert.deepEqual(sales.items[0].remainder, { document_gross: 1004, settled_in_period: 502, remaining_gross: 502, remaining_tax: 102 });
  assert.deepEqual(sales.items[0].settlement, { transaction_ids: ['tx-1', 'tx-2'], journal_dates: ['2025-02-20', '2025-03-20'] });
  assert.deepEqual(sales.represented, [{ document_id: 'full', by: 'settlement_journal' }]);
  assert.equal(recognitionStatement(sales), '1 uploaded sales document is not fully recognised in this period\'s posted ledger; the unrecognised part is excluded '
    + 'from these figures: 400.00 EUR net + 102.00 tax. 1 of them is paid only in part in this period; only its unpaid remainder is counted here.');
  const purchase = classifyRecognitionGap({ side: 'purchase', basis: 'accrual', period: FEB,
    ...book([posted('tx-b', 'bill-osa', '248.00', '2025-02-17'), posted('tx-b2', 'bill-osa', '248.00', null)]),
    documents: [sbill('bill-osa', { total_amount: '496.00', tax_amount: '96.00' })] });
  // The second instalment is decided but not posted: still only the first is in the ledger.
  assert.deepEqual(purchase.items.map((i) => [i.document_id, i.rests, i.gross, i.net, i.tax]), [['bill-osa', 'part_settled_in_period', 248, 200, 48]]);
  assert.match(recognitionStatement(purchase), /: 200\.00 EUR expense \+ 48\.00 input tax\. 1 of them is paid only in part/);
});

test('part-paid: the remainder tax is the stated tax less the settled share, rounded half up in cents', () => {
  const gap = classifyRecognitionGap({ basis: 'accrual', period: FEB, ...book([posted('tx', 'odd', '33.33', '2025-02-15')]),
    documents: [doc('odd', { total_amount: '100.00', tax_amount: '20.32' })] });
  // settled share of tax: 20.32 × 33.33 / 100 = 6.772… → 6.77; remainder 13.55 of 66.67.
  assert.deepEqual(gap.items.map((i) => [i.gross, i.tax, i.net]), [[66.67, 13.55, 53.12]]);
  const noTax = classifyRecognitionGap({ basis: 'accrual', period: FEB, ...book([posted('tx', 'nt', '10.00', '2025-02-15')]),
    documents: [doc('nt', { total_amount: '30.00', tax_amount: null })] });
  assert.deepEqual(noTax.items.map((i) => [i.gross, i.tax, i.net, i.remainder.remaining_tax]), [[20, null, null, null]]);
});

test('part-paid: a 1-cent shortfall is paid (the payment_status epsilon); an unstated or foreign-currency line amount keeps the document represented', () => {
  const gap = classifyRecognitionGap({ basis: 'accrual', period: FEB, documents: [doc('cent'), doc('unstated'), doc('fx')],
    ...book([posted('tx-c', 'cent', '903.59', '2025-02-15'), posted('tx-u', 'unstated', null, '2025-02-15'),
      posted('tx-f', 'fx', '400.00', '2025-02-15', { bank_currency: 'SEK' })]) });
  assert.deepEqual(gap.items, []);
  assert.deepEqual(gap.represented.map((r) => r.document_id), ['cent', 'unstated', 'fx']);
});

test('part-paid: credit applied to an invoice on its posted line counts toward it, and the credit note itself is netted', () => {
  const applications = [{ credit_document_id: 'aroma-cn', invoice_document_id: 'aroma', amount: '376.50', settlement_match_id: 'm-tx-aroma', counterpart_date: '2025-02-03' }];
  const documents = [doc('aroma', { total_amount: '2008.00', tax_amount: '408.00' }), doc('aroma-cn', { total_amount: '-376.50', tax_amount: '-76.50', payment_status: 'credit_note' })];
  const full = classifyRecognitionGap({ basis: 'accrual', period: FEB, documents, applications, ...book([posted('tx-aroma', 'aroma', '1631.50', '2025-02-20')]) });
  assert.deepEqual([full.items, full.represented.map((r) => r.document_id)], [[], ['aroma', 'aroma-cn']]);
  // Half the credit-adjusted balance paid in February: the invoice names what is left.
  const half = classifyRecognitionGap({ basis: 'accrual', period: FEB, documents, applications, ...book([posted('tx-aroma', 'aroma', '815.75', '2025-02-20')]) });
  assert.deepEqual(half.items.map((i) => [i.document_id, i.gross]), [['aroma', 815.75]]);
  assert.deepEqual(half.represented.map((r) => r.document_id), ['aroma-cn']);
});

test('netted supplier credit note: without a record of the deduction both the bill remainder and the credit are named; with one, both are represented', () => {
  const documents = [sbill('bill-net'), sbill('bill-net-cn', { total_amount: '-62.00', tax_amount: '-12.00', payment_status: 'credit_note' })];
  const line = book([posted('tx-net', 'bill-net', '186.00', '2025-02-15')]);
  // Amounts that add up (248 − 62 = 186) are not a record: nothing is inferred.
  const unlinked = classifyRecognitionGap({ side: 'purchase', basis: 'accrual', period: FEB, documents, ...line });
  assert.deepEqual(unlinked.items.map((i) => [i.document_id, i.kind, i.rests, i.gross, i.tax]),
    [['bill-net', 'invoice', 'part_settled_in_period', 62, 12], ['bill-net-cn', 'credit_note', 'no_settlement', -62, -12]]);
  assert.deepEqual(unlinked.totals, [{ currency: 'EUR', count: 2, gross: 0, net: 0, tax: 0, tax_unknown_count: 0 }]);
  // The record that would settle it: the credit applied to the bill on the bill's posted line.
  const linked = classifyRecognitionGap({ side: 'purchase', basis: 'accrual', period: FEB, documents, ...line,
    applications: [{ credit_document_id: 'bill-net-cn', invoice_document_id: 'bill-net', amount: '62.00', settlement_match_id: 'm-tx-net', counterpart_date: '2025-02-05' }] });
  assert.deepEqual([linked.items, linked.represented], [[], [{ document_id: 'bill-net', by: 'settlement_journal' }, { document_id: 'bill-net-cn', by: 'settlement_journal' }]]);
});

test('the draft statement in Finnish, with and without a part-paid document', () => {
  const plain = classifyRecognitionGap({ basis: 'accrual', period: FEB, documents: [doc('lumikki')] });
  assert.equal(recognitionStatement(plain, { language: 'fi' }),
    '1 ladattu myyntiasiakirja ei ole kirjattu tämän kauden kirjanpitoon, ja se on jätetty pois näistä luvuista: 720,00 EUR nettomyyntiä + 183,60 ALV.');
  const parts = classifyRecognitionGap({ side: 'purchase', basis: 'accrual', period: FEB, documents: [sbill('a', { total_amount: '496.00', tax_amount: '96.00' }), sbill('b')],
    ...book([posted('tx-a', 'a', '248.00', '2025-02-17')]) });
  assert.equal(recognitionStatement(parts, { language: 'fi' }),
    '2 ladattua ostoasiakirjaa ei ole kirjattu kokonaan tämän kauden kirjanpitoon; kirjaamaton osa on jätetty pois näistä luvuista: 400,00 EUR kuluja + 96,00 vähennettävää ALV:tä. '
    + 'Niistä 1 on maksettu tällä kaudella vain osittain; mukana on vain maksamaton loppuosa.');
  assert.equal(recognitionDraftReason(parts, { language: 'fi' }).detail, recognitionStatement(parts, { language: 'fi' }));
  assert.equal(recognitionDraftReason(parts).detail, recognitionStatement(parts));
});

const creditNote = doc('tukku-cn', { document_type: 'supplier_bill', customer_name: null, vendor_name: 'Tukku Oy', total_amount: '-62.00', tax_amount: '-12.00',
  payment_status: 'credit_note', document_date: '2025-02-09', parse_summary: { references: [{ type: 'invoice_number', value: 'HL-30' }] } });
test('the supplier credit-note question asks deducted, refunded or still open, in English and Finnish', () => {
  assert.equal(buildSupplierCreditNoteQuestion({ document: creditNote }),
    'Supplier credit note HL-30 from Tukku Oy (62.00 EUR, dated 2025-02-09) has no refund on the bank statements Donna holds, '
    + 'and nothing Donna holds shows it deducted from a payment of a bill. Donna does not yet record an open supplier credit note in the books, '
    + 'so it is missing from that period\'s expenses and VAT. Was it deducted from a payment to the supplier, or refunded to you? '
    + 'If it was deducted, reply which bill\'s payment it was deducted from and when that payment was made. If it was refunded, reply when and into which account. '
    + 'If it is still open, reply "still open".');
  assert.equal(buildSupplierCreditNoteQuestion({ document: creditNote, language: 'fi' }),
    'Ostohyvityslasku HL-30 (Tukku Oy, 62,00 EUR, päivätty 9.2.2025): Donnalla olevissa tiliotteissa ei näy tälle hyvitykselle palautusta, '
    + 'eikä Donnalla ole tietoa siitä, että se olisi vähennetty jonkin laskun maksusta. Donna ei vielä kirjaa avointa ostohyvityslaskua kirjanpitoon, '
    + 'joten se puuttuu sen kauden kuluista ja arvonlisäverosta. Onko hyvitys vähennetty toimittajalle maksetusta laskusta, vai onko se palautettu sinulle? '
    + 'Jos se on vähennetty, kerro minkä laskun maksusta ja milloin maksu tehtiin. Jos se on palautettu, kerro milloin ja mille tilille. '
    + 'Jos hyvitys on vielä käyttämättä, vastaa "vielä avoin".');
  const credit = noSettlementAskStillOpen(SUPPLIER_BILL_SETTLEMENT_ASK_LANE, 'unrecorded_uploaded_supplier_credit_note');
  assert.match(credit.meaning, /credit note .* still open/);
  assert.equal(noSettlementAskStillOpen(SUPPLIER_BILL_SETTLEMENT_ASK_LANE, 'unrecorded_uploaded_supplier_bill').meaning,
    noSettlementAskStillOpen(SUPPLIER_BILL_SETTLEMENT_ASK_LANE).meaning);
  // The sales lane has no credit-note question: customer credits are settled by their application.
  assert.equal(noSettlementAskStillOpen(SALES_RECOGNITION_ASK_LANE, 'unrecorded_uploaded_supplier_credit_note'), noSettlementAskStillOpen(SALES_RECOGNITION_ASK_LANE));
});

test('a sales shortfall is named with the lines it was short on; only an amount-bearing bank-fee record on the match settles it, never a hop label or a guess', () => {
  const documents = [doc('fee', { total_amount: '1004.00', tax_amount: '204.00' })];
  const short = classifyRecognitionGap({ basis: 'accrual', period: FEB, documents, ...book([posted('tx-fee', 'fee', '1001.50', '2025-02-20')]) });
  assert.deepEqual(short.items.map((i) => [i.document_id, i.rests, i.gross, i.tax, i.shortfall]),
    [['fee', 'part_settled_in_period', 2.5, 0.51, { amount: '2.50', match_ids: ['m-tx-fee'] }]]);
  // The matcher's hop label names no amount: still the same shortfall.
  const hop = classifyRecognitionGap({ basis: 'accrual', period: FEB, documents,
    ...book([posted('tx-fee', 'fee', '1001.50', '2025-02-20', { payload: { match_reason: { hops: ['processor_fee'] } } })]) });
  assert.deepEqual(hop.items.map((i) => i.shortfall.amount), ['2.50']);
  // A later decided instalment pays the rest: no shortfall question about it.
  const later = classifyRecognitionGap({ basis: 'accrual', period: FEB, documents,
    ...book([posted('tx-1', 'fee', '502.00', '2025-02-20'), posted('tx-2', 'fee', '502.00', '2025-03-20')]) });
  assert.deepEqual(later.items.map((i) => [i.rests, i.gross, i.shortfall]), [['part_settled_in_period', 502, undefined]]);
  // A recorded bank fee in the invoice's currency completes it: represented, net of the fee.
  const record = (extra = {}) => ({ payload: { settlement_shortfall: { kind: 'bank_fee', amount: '2.50', currency: 'EUR', ...extra } } });
  const fee = classifyRecognitionGap({ basis: 'accrual', period: FEB, documents, ...book([posted('tx-fee', 'fee', '1001.50', '2025-02-20', record())]) });
  assert.deepEqual([fee.items, fee.represented], [[], [{ document_id: 'fee', by: 'settlement_journal', net_of_bank_fee: { amount: 2.5, match_ids: ['m-tx-fee'] } }]]);
  // A fee smaller than the shortfall leaves the rest named; a fee in another currency or of another kind counts for nothing.
  const partFee = classifyRecognitionGap({ basis: 'accrual', period: FEB, documents, ...book([posted('tx-fee', 'fee', '1001.50', '2025-02-20', record({ amount: '1.00' }))]) });
  assert.deepEqual(partFee.items.map((i) => [i.gross, i.shortfall.amount]), [[1.5, '1.50']]);
  for (const bad of [{ currency: 'USD' }, { kind: 'discount' }, { amount: 'n/a' }, { amount: '-2.50' }]) {
    assert.equal(recordedBankFeeCents(record(bad), 'EUR'), 0, JSON.stringify(bad));
  }
  assert.equal(recordedBankFeeCents(record(), 'EUR'), 250);
  // The purchase side names its remainder as before, without a shortfall question.
  const purchase = classifyRecognitionGap({ side: 'purchase', basis: 'accrual', period: FEB, documents: [sbill('b', { total_amount: '248.00', tax_amount: '48.00' })],
    ...book([posted('tx-b', 'b', '245.50', '2025-02-20')]) });
  assert.deepEqual(purchase.items.map((i) => [i.rests, i.gross, i.shortfall]), [['part_settled_in_period', 2.5, undefined]]);
});

test('the lanes\' record-settling answers: "deducted from bill X" on a supplier credit-note ask, "bank fee" on a sales shortfall ask, nowhere else', () => {
  const credit = noSettlementAskLaneAnswers(SUPPLIER_BILL_SETTLEMENT_ASK_LANE, 'unrecorded_uploaded_supplier_credit_note');
  assert.match(credit.creditDeducted.meaning, /deducted from the payment of a supplier bill/);
  assert.equal(credit.bankFee, undefined); assert.equal(credit.matchedDocument, false);
  const shortfall = noSettlementAskLaneAnswers(SALES_RECOGNITION_ASK_LANE, 'unexplained_settlement_shortfall');
  assert.match(shortfall.bankFee.meaning, /bank fee/); assert.equal(shortfall.matchedDocument, true);
  assert.match(noSettlementAskStillOpen(SALES_RECOGNITION_ASK_LANE, 'unexplained_settlement_shortfall').meaning, /part-payment/);
  assert.equal(noSettlementAskStillOpen(SALES_RECOGNITION_ASK_LANE, 'unexplained_settlement_shortfall').recheckDays, NO_SETTLEMENT_STILL_OPEN_RECHECK_DAYS);
  for (const [lane, recognition] of [[SUPPLIER_BILL_SETTLEMENT_ASK_LANE, 'unrecorded_uploaded_supplier_bill'], [SALES_RECOGNITION_ASK_LANE, 'unrecognised_uploaded_sales_invoice'],
    [SALES_RECOGNITION_ASK_LANE, 'unrecorded_uploaded_supplier_credit_note'], ['owner_reply_clarification', null], [undefined, null]]) {
    assert.equal(noSettlementAskLaneAnswers(lane, recognition), null, `${lane}/${recognition}`);
  }
});

test('the shortfall question asks bank fee or part-payment, in English and Finnish', () => {
  const document = doc('fee', { total_amount: '1004.00', document_date: '2025-02-04', customer_name: 'Pankkikulu Oy', parse_summary: { references: [{ type: 'invoice_number', value: '1020' }] } });
  const shortfall = { amount: '2.50', settled: '1001.50' };
  assert.equal(buildSettlementShortfallQuestion({ document, shortfall }), 'Sales invoice 1020 to Pankkikulu Oy (1004.00 EUR, dated 2025-02-04): the payment recorded for it was 2.50 EUR short '
    + '(1001.50 EUR received). Donna does not know why, so for now the difference is left out of that period\'s sales and VAT. Was it a bank fee or a part-payment? '
    + 'If it was a bank fee, reply "bank fee". If the customer paid only part and the rest is still unpaid, reply "part-payment".');
  const fi = buildSettlementShortfallQuestion({ document, shortfall, language: 'fi' });
  assert.match(fi, /^Myyntilasku 1020 \(Pankkikulu Oy, 1004,00 EUR, päivätty 4\.2\.2025\): tälle laskulle kirjattu maksu oli 2,50 EUR laskua pienempi \(saatu 1001,50 EUR\)\. /);
  assert.match(fi, /Oliko erotus pankin palvelumaksu vai osamaksu\? Jos se oli pankin palvelumaksu, vastaa "pankin palvelumaksu"\. .*vastaa "osamaksu"\.$/);
});
