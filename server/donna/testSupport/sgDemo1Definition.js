import { createHash } from 'node:crypto';

export const SG_DEMO_1_BOOK_SCHEMA_VERSION = 'sg-demo-1.book.v1';
export const SG_DEMO_1_SOURCE_SCHEMA_VERSION = 'sg-demo-1.sources.v1';
export const SG_DEMO_1_EVIDENCE_RECEIPT_VERSION = 'sg-demo-1.evidence-receipts.v1';
export const SG_DEMO_1_EVALUATION_RECEIPT_VERSION = 'sg-demo-1.evaluation-receipt.v1';
export const SG_DEMO_1_WORLD_ID = 'sg-demo-1';
export const SG_DEMO_1_ENTITY_ID = 'entity_sg_demo_1';
export const SG_DEMO_1_SIBLING_ENTITY_ID = 'entity_sg_demo_1_sibling';
export const SG_DEMO_1_PERIOD_ID = '2026-Q1';
export const SG_DEMO_1_FIXTURE_CLOCK = '2026-04-07T09:00:00.000+08:00';

export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON does not support non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new TypeError('canonical JSON supports only JSON values');
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

const accounts = [
  ['1700', 'Accounts receivable', 'asset'],
  ['1900', 'Cash', 'asset'],
  ['1910', 'Bank and wallets', 'asset'],
  ['2000', 'Share capital', 'equity'],
  ['2251', 'Retained earnings', 'equity'],
  ['2870', 'Accounts payable', 'liability'],
  ['2950', 'Output GST', 'liability'],
  ['2951', 'Input GST', 'asset'],
  ['3000', 'Standard and out-of-scope revenue', 'revenue'],
  ['3200', 'Zero-rated revenue', 'revenue'],
  ['3900', 'Other income and realised FX', 'revenue'],
  ['4000', 'Direct costs', 'expense'],
  ['4400', 'Subcontractor costs', 'expense'],
  ['7000', 'Rent', 'expense'],
  ['7600', 'Marketing', 'expense'],
  ['7800', 'Other operating expense', 'expense'],
  ['9300', 'Interest income', 'revenue'],
].map(([code, name, type]) => ({ code, name, type }));

const bankLines = [
  ['b001', '2026-01-06', 'dbs', 'SGD', '1090.00', 'PAYNOW QR / LC-INV-001', 'LC-INV-001', 'E01', 'auto_reconciled', '1090.00'],
  ['b002', '2026-01-09', 'ocbc', 'SGD', '545.00', 'FAST / LC-INV-002', 'LC-INV-002', 'E02', 'auto_reconciled', '545.00'],
  ['b003', '2026-01-13', 'airwallex', 'USD', '1000.00', 'USD RECEIPT / LC-INV-003', 'LC-INV-003', 'E03', 'auto_reconciled', '1350.00'],
  ['b004', '2026-01-16', 'dbs', 'SGD', '-2180.00', 'GIRO / SG-SUP-001', 'SG-SUP-001', 'E04', 'auto_reconciled', '-2180.00'],
  ['b005', '2026-01-20', 'dbs', 'SGD', '-654.00', 'PAYNOW UEN / SG-SUP-002', 'SG-SUP-002', 'E05', 'auto_reconciled', '-654.00'],
  ['b006', '2026-01-23', 'wise', 'EUR', '-240.00', 'EUR TRANSFER / EU-SUP-001', 'EU-SUP-001', 'E06', 'auto_reconciled', '-350.40'],
  ['b007', '2026-01-28', 'dbs', 'SGD', '-109.00', 'PAYNOW / POS-001', 'POS-001', 'E07', 'auto_reconciled', '-109.00'],
  ['b008', '2026-01-30', 'dbs', 'SGD', '3000.00', 'FAST / DIRECTOR TRANSFER', 'DIRECTOR-TRANSFER', 'U01', 'on_owner', '3000.00'],
  ['b009', '2026-02-05', 'ocbc', 'SGD', '2943.00', 'PROCESSOR PAYOUT / SET-001', 'SET-001', 'E08', 'auto_reconciled', '2943.00'],
  ['b010', '2026-02-09', 'ocbc', 'SGD', '-2180.00', 'GIRO RENT / FEB-2026', 'FEB-2026', 'E09', 'auto_reconciled', '-2180.00'],
  ['b011', '2026-02-12', 'wise', 'EUR', '-260.00', 'WALLET CONVERSION / FX-001', 'FX-001', 'E10', 'auto_reconciled', '-379.60'],
  ['b012', '2026-02-12', 'dbs', 'SGD', '382.80', 'WISE PAYOUT NET / FX-001', 'FX-001', 'E10', 'auto_reconciled', '382.80'],
  ['b013', '2026-02-17', 'airwallex', 'USD', '-500.00', 'WALLET CONVERSION / FX-002', 'FX-002', 'E11', 'auto_reconciled', '-670.00'],
  ['b014', '2026-02-17', 'dbs', 'SGD', '678.00', 'AIRWALLEX PAYOUT NET / FX-002', 'FX-002', 'E11', 'auto_reconciled', '678.00'],
  ['b015', '2026-02-20', 'ocbc', 'SGD', '-1000.00', 'FAST OWN ACCOUNT / XFER-001', 'XFER-001', 'E12', 'auto_reconciled', '-1000.00'],
  ['b016', '2026-02-20', 'dbs', 'SGD', '1000.00', 'FAST OWN ACCOUNT / XFER-001', 'XFER-001', 'E12', 'auto_reconciled', '1000.00'],
  ['b017', '2026-02-23', 'dbs', 'SGD', '-218.00', 'PAYNOW / OFFICE-001', 'OFFICE-001', 'E13', 'auto_reconciled', '-218.00'],
  ['b018', '2026-02-24', 'airwallex', 'USD', '-400.00', 'IMPORTED SAAS / US-SUP-001', 'US-SUP-001', 'U02', 'on_owner', '-536.00'],
  ['b019', '2026-02-25', 'dbs', 'SGD', '-4500.00', 'CPF EZPAY', 'CPF-FEB', 'U03', 'on_owner', '-4500.00'],
  ['b020', '2026-02-26', 'dbs', 'SGD', '-600.00', 'DIRECTOR CARD / HOTEL', 'HOTEL-FEB', 'U04', 'on_owner', '-600.00'],
  ['b021', '2026-02-27', 'dbs', 'SGD', '-2000.00', 'IRAS GIRO', 'IRAS-FEB', 'U05', 'on_owner', '-2000.00'],
  ['b022', '2026-03-03', 'dbs', 'SGD', '2180.00', 'PAYNOW QR / LC-INV-004', 'LC-INV-004', 'E14', 'auto_reconciled', '2180.00'],
  ['b023', '2026-03-06', 'wise', 'EUR', '1000.00', 'EUR RECEIPT / LC-INV-005', 'LC-INV-005', 'E15', 'auto_reconciled', '1490.00'],
  ['b024', '2026-03-10', 'dbs', 'SGD', '-1090.00', 'FAST / SG-SUP-003', 'SG-SUP-003', 'E16', 'auto_reconciled', '-1090.00'],
  ['b025', '2026-03-16', 'dbs', 'SGD', '15.00', 'CREDIT INTEREST', 'INTEREST-MAR', 'E17', 'auto_reconciled', '15.00'],
  ['b026', '2026-03-19', 'ocbc', 'SGD', '5000.00', 'FAST / FUNDING', 'FUNDING-MAR', 'U06', 'on_owner', '5000.00'],
  ['b027', '2026-03-23', 'dbs', 'SGD', '-550.00', 'LOAN REPAYMENT', 'LOAN-MAR', 'U07', 'on_owner', '-550.00'],
  ['b028', '2026-03-25', 'dbs', 'SGD', '-4800.00', 'CPF EZPAY', 'CPF-MAR', 'U08', 'on_owner', '-4800.00'],
  ['b029', '2026-03-27', 'dbs', 'SGD', '-163.50', 'PAYNOW / OFFICE-002', 'OFFICE-002', 'E18', 'auto_reconciled', '-163.50'],
  ['b030', '2026-03-30', 'ocbc', 'SGD', '-500.00', 'CASH WITHDRAWAL / PETTY CASH', 'PETTY-CASH-001', 'E19', 'auto_reconciled', '-500.00'],
  ['b031', '2026-03-31', 'dbs', 'SGD', '1200.00', 'OVERSEAS TT / OS-GOODS-001', 'OS-GOODS-001', 'E20', 'auto_reconciled', '1200.00'],
].map(([id, date, account_id, currency, amount, narrative, reference, group_id, terminal, sgd_measurement]) => ({
  id,
  entity_id: SG_DEMO_1_ENTITY_ID,
  date,
  account_id,
  currency,
  amount,
  narrative,
  reference,
  group_id,
  terminal,
  sgd_measurement,
}));

const statements = [
  ['doc_statement_dbs_2026_01', 'dbs', 'DBS-style', '2026-01', '2026-01-31', 'SGD', '20000.00', '21147.00', '21147.00', ['b001', 'b004', 'b005', 'b007', 'b008']],
  ['doc_statement_ocbc_2026_01', 'ocbc', 'OCBC-style', '2026-01', '2026-01-31', 'SGD', '5000.00', '5545.00', '5545.00', ['b002']],
  ['doc_statement_airwallex_2026_01', 'airwallex', 'Airwallex-style', '2026-01', '2026-01-31', 'USD', '1000.00', '2000.00', '2690.00', ['b003']],
  ['doc_statement_wise_2026_01', 'wise', 'Wise-style', '2026-01', '2026-01-31', 'EUR', '500.00', '260.00', '379.60', ['b006']],
  ['doc_statement_dbs_2026_02', 'dbs', 'DBS-style', '2026-02', '2026-02-28', 'SGD', '21147.00', '15889.80', '15889.80', ['b012', 'b014', 'b016', 'b017', 'b019', 'b020', 'b021']],
  ['doc_statement_ocbc_2026_02', 'ocbc', 'OCBC-style', '2026-02', '2026-02-28', 'SGD', '5545.00', '5308.00', '5308.00', ['b009', 'b010', 'b015']],
  ['doc_statement_airwallex_2026_02', 'airwallex', 'Airwallex-style', '2026-02', '2026-02-28', 'USD', '2000.00', '1100.00', '1484.00', ['b013', 'b018']],
  ['doc_statement_wise_2026_02', 'wise', 'Wise-style', '2026-02', '2026-02-28', 'EUR', '260.00', '0.00', '0.00', ['b011']],
  ['doc_statement_dbs_2026_03', 'dbs', 'DBS-style', '2026-03', '2026-03-31', 'SGD', '15889.80', '12681.30', '12681.30', ['b022', 'b024', 'b025', 'b027', 'b028', 'b029', 'b031']],
  ['doc_statement_ocbc_2026_03', 'ocbc', 'OCBC-style', '2026-03', '2026-03-31', 'SGD', '5308.00', '9808.00', '9808.00', ['b026', 'b030']],
  ['doc_statement_airwallex_2026_03', 'airwallex', 'Airwallex-style', '2026-03', '2026-03-31', 'USD', '1100.00', '1100.00', '1484.00', []],
  ['doc_statement_wise_2026_03', 'wise', 'Wise-style', '2026-03', '2026-03-31', 'EUR', '0.00', '1000.00', '1490.00', ['b023']],
].map(([id, account_id, provider_style, month, closing_date, currency, opening_balance, closing_balance, closing_sgd_measurement, bank_line_ids]) => ({
  id,
  entity_id: SG_DEMO_1_ENTITY_ID,
  account_id,
  provider_style,
  month,
  closing_date,
  currency,
  opening_balance,
  closing_balance,
  closing_sgd_measurement,
  bank_line_ids,
  terminal: 'auto_reconciled',
  filename: `${id.replace(/^doc_/, '').replaceAll('_', '-')}.pdf`,
}));

const evidenceRows = [
  ['E00', 'doc_opening_balance_001', 'opening_balance_schedule', 'Opening balance schedule', '2026-01-01', 'SGD', '27070.00', 'OPENING-2026-01-01', ['DBS 20000.00', 'OCBC 5000.00', 'Airwallex USD 1000.00 at 1.3400', 'Wise EUR 500.00 at 1.4600']],
  ['E01', 'doc_tax_invoice_lc_001', 'sales_invoice', 'Domestic tax invoice LC-INV-001', '2026-01-05', 'SGD', '1090.00', 'LC-INV-001', ['Exclusive base 1000.00', 'GST 9% 90.00', 'Total 1090.00']],
  ['E02', 'doc_tax_invoice_lc_002', 'sales_invoice', 'Domestic GST-inclusive invoice LC-INV-002', '2026-01-08', 'SGD', '545.00', 'LC-INV-002', ['GST-inclusive total 545.00', 'Base 500.00', 'GST 45.00']],
  ['E03', 'doc_export_invoice_lc_003', 'sales_invoice', 'International service invoice LC-INV-003', '2026-01-12', 'USD', '1000.00', 'LC-INV-003', ['Non-resident customer', 'Direct benefit outside Singapore', 'Invoice rate USD/SGD 1.3500', 'Zero-rated base SGD 1350.00']],
  ['E04', 'doc_supplier_bill_sg_001', 'supplier_bill', 'Domestic supplier bill SG-SUP-001', '2026-01-15', 'SGD', '2180.00', 'SG-SUP-001', ['Exclusive base 2000.00', 'GST 9% 180.00', 'Total 2180.00']],
  ['E05', 'doc_supplier_bill_sg_002', 'supplier_bill', 'Domestic marketing bill SG-SUP-002', '2026-01-19', 'SGD', '654.00', 'SG-SUP-002', ['Exclusive base 600.00', 'GST 9% 54.00', 'Total 654.00']],
  ['E06', 'doc_supplier_bill_eu_001', 'supplier_bill', 'Foreign supplier bill EU-SUP-001', '2026-01-22', 'EUR', '240.00', 'EU-SUP-001', ['Service EUR 200.00', 'Foreign VAT EUR 40.00', 'No Singapore GST', 'Invoice rate EUR/SGD 1.4500']],
  ['E07', 'doc_receipt_pos_001', 'receipt', 'Domestic GST-inclusive receipt POS-001', '2026-01-28', 'SGD', '109.00', 'POS-001', ['GST-inclusive total 109.00', 'Base 100.00', 'GST 9.00']],
  ['E08', 'doc_processor_settlement_001', 'payout_statement', 'Processor payout settlement SET-001', '2026-02-05', 'SGD', '2943.00', 'SET-001', ['Gross sales 3270.00 GST-inclusive', 'Refund 218.00 GST-inclusive', 'Processor fee 109.00 GST-inclusive', 'Net payout 2943.00']],
  ['E09', 'doc_rent_bill_2026_02', 'supplier_bill', 'February rent tax invoice', '2026-02-08', 'SGD', '2180.00', 'RENT-FEB-2026', ['Exclusive rent 2000.00', 'GST 180.00', 'Total 2180.00']],
  ['E10', 'doc_wise_conversion_001', 'wallet_conversion', 'Wise EUR to SGD conversion FX-001', '2026-02-12', 'SGD', '382.80', 'FX-001', ['Sell EUR 260.00', 'Gross SGD 384.80 at 1.4800', 'Fee SGD 2.00', 'Net SGD 382.80']],
  ['E11', 'doc_airwallex_conversion_002', 'wallet_conversion', 'Airwallex USD to SGD conversion FX-002', '2026-02-17', 'SGD', '678.00', 'FX-002', ['Sell USD 500.00', 'Gross SGD 680.00 at 1.3600', 'Fee SGD 2.00', 'Net SGD 678.00']],
  ['E12', 'doc_internal_transfer_001', 'transfer_confirmation', 'Own-account FAST transfer XFER-001', '2026-02-20', 'SGD', '1000.00', 'XFER-001', ['From OCBC collections', 'To DBS operating', 'No income or expense']],
  ['E13', 'doc_receipt_office_001', 'receipt', 'Office receipt OFFICE-001', '2026-02-23', 'SGD', '218.00', 'OFFICE-001', ['GST-inclusive total 218.00', 'Base 200.00', 'GST 18.00']],
  ['E14', 'doc_tax_invoice_lc_004', 'sales_invoice', 'Domestic tax invoice LC-INV-004', '2026-03-02', 'SGD', '2180.00', 'LC-INV-004', ['Exclusive base 2000.00', 'GST 9% 180.00', 'Total 2180.00']],
  ['E15', 'doc_export_invoice_lc_005', 'sales_invoice', 'International service invoice LC-INV-005', '2026-03-04', 'EUR', '1000.00', 'LC-INV-005', ['Non-resident customer', 'Direct benefit outside Singapore', 'Invoice rate EUR/SGD 1.4700', 'Settlement rate EUR/SGD 1.4900']],
  ['E16', 'doc_supplier_bill_sg_003', 'supplier_bill', 'Domestic subcontractor bill SG-SUP-003', '2026-03-09', 'SGD', '1090.00', 'SG-SUP-003', ['Exclusive base 1000.00', 'GST 9% 90.00', 'Total 1090.00']],
  ['E17', 'doc_interest_advice_2026_03', 'interest_advice', 'DBS-style March interest advice', '2026-03-16', 'SGD', '15.00', 'INTEREST-MAR', ['Deposit interest 15.00', 'Exempt supply for fixture']],
  ['E18', 'doc_receipt_office_002', 'receipt', 'Office receipt OFFICE-002', '2026-03-27', 'SGD', '163.50', 'OFFICE-002', ['GST-inclusive total 163.50', 'Base 150.00', 'GST 13.50']],
  ['E19', 'doc_petty_cash_voucher_001', 'cash_voucher', 'Petty cash withdrawal voucher', '2026-03-30', 'SGD', '500.00', 'PETTY-CASH-001', ['Transfer from OCBC bank to petty cash', 'No expense at withdrawal']],
  ['E20', 'doc_foreign_goods_invoice_001', 'sales_invoice', 'Foreign-to-foreign goods invoice OS-GOODS-001', '2026-03-31', 'SGD', '1200.00', 'OS-GOODS-001', ['Goods move between two countries outside Singapore', 'Goods never enter Singapore', 'Out-of-scope supply']],
].map(([event_id, id, kind, title, document_date, currency, total_amount, reference, details]) => ({
  id,
  entity_id: SG_DEMO_1_ENTITY_ID,
  event_id,
  kind,
  filename: `${id.replace(/^doc_/, '').replaceAll('_', '-')}.pdf`,
  title,
  document_date,
  currency,
  total_amount,
  reference,
  details,
  terminal: 'auto_reconciled',
}));

const jl = (id, account_code, debit, credit) => ({ id, account_code, debit, credit });
const journal = (id, date, lines) => ({ id, date, currency: 'SGD', lines });
const coding = (account_codes, gst_code) => ({
  authority_basis: 'fixture_declared_economics',
  account_codes,
  gst_code,
});
const gst = (values = {}) => ({
  box1: '0.00', box2: '0.00', box5: '0.00', box6: '0.00', box7: '0.00', box13: '0.00', box14: '0.00',
  exempt_non_fx_box3: '0.00', realized_fx: '0.00', ...values,
});
const event = ({ id, date, bank_line_ids, evidence_id, match_id, journal: eventJournal, coding: eventCoding, gst: eventGst }) => ({
  id,
  entity_id: SG_DEMO_1_ENTITY_ID,
  date,
  bank_line_ids,
  evidence_id,
  match_id,
  journal: eventJournal,
  coding: eventCoding,
  gst: eventGst,
  terminal: 'auto_reconciled',
});

const openingJournal = journal('journal_e00', '2026-01-01', [
  jl('journal_e00_l01', '1910', '20000.00', '0.00'),
  jl('journal_e00_l02', '1910', '5000.00', '0.00'),
  jl('journal_e00_l03', '1910', '1340.00', '0.00'),
  jl('journal_e00_l04', '1910', '730.00', '0.00'),
  jl('journal_e00_l05', '2000', '0.00', '20000.00'),
  jl('journal_e00_l06', '2251', '0.00', '7070.00'),
]);

const events = [
  event({ id: 'E01', date: '2026-01-06', bank_line_ids: ['b001'], evidence_id: 'doc_tax_invoice_lc_001', match_id: 'match_e01_b001', coding: coding(['1700', '3000', '2950', '1910'], 'GST_STANDARD_OUTPUT'), gst: gst({ box1: '1000.00', box6: '90.00', box13: '1000.00' }), journal: journal('journal_e01', '2026-01-06', [jl('journal_e01_l01', '1700', '1090.00', '0.00'), jl('journal_e01_l02', '3000', '0.00', '1000.00'), jl('journal_e01_l03', '2950', '0.00', '90.00'), jl('journal_e01_l04', '1910', '1090.00', '0.00'), jl('journal_e01_l05', '1700', '0.00', '1090.00')]) }),
  event({ id: 'E02', date: '2026-01-09', bank_line_ids: ['b002'], evidence_id: 'doc_tax_invoice_lc_002', match_id: 'match_e02_b002', coding: coding(['1700', '3000', '2950', '1910'], 'GST_STANDARD_OUTPUT'), gst: gst({ box1: '500.00', box6: '45.00', box13: '500.00' }), journal: journal('journal_e02', '2026-01-09', [jl('journal_e02_l01', '1700', '545.00', '0.00'), jl('journal_e02_l02', '3000', '0.00', '500.00'), jl('journal_e02_l03', '2950', '0.00', '45.00'), jl('journal_e02_l04', '1910', '545.00', '0.00'), jl('journal_e02_l05', '1700', '0.00', '545.00')]) }),
  event({ id: 'E03', date: '2026-01-13', bank_line_ids: ['b003'], evidence_id: 'doc_export_invoice_lc_003', match_id: 'match_e03_b003', coding: coding(['1700', '3200', '1910'], 'GST_ZERO_OUTPUT'), gst: gst({ box2: '1350.00', box13: '1350.00' }), journal: journal('journal_e03', '2026-01-13', [jl('journal_e03_l01', '1700', '1350.00', '0.00'), jl('journal_e03_l02', '3200', '0.00', '1350.00'), jl('journal_e03_l03', '1910', '1350.00', '0.00'), jl('journal_e03_l04', '1700', '0.00', '1350.00')]) }),
  event({ id: 'E04', date: '2026-01-16', bank_line_ids: ['b004'], evidence_id: 'doc_supplier_bill_sg_001', match_id: 'match_e04_b004', coding: coding(['4000', '2951', '2870', '1910'], 'GST_STANDARD_INPUT'), gst: gst({ box5: '2000.00', box7: '180.00' }), journal: journal('journal_e04', '2026-01-16', [jl('journal_e04_l01', '4000', '2000.00', '0.00'), jl('journal_e04_l02', '2951', '180.00', '0.00'), jl('journal_e04_l03', '2870', '0.00', '2180.00'), jl('journal_e04_l04', '2870', '2180.00', '0.00'), jl('journal_e04_l05', '1910', '0.00', '2180.00')]) }),
  event({ id: 'E05', date: '2026-01-20', bank_line_ids: ['b005'], evidence_id: 'doc_supplier_bill_sg_002', match_id: 'match_e05_b005', coding: coding(['7600', '2951', '2870', '1910'], 'GST_STANDARD_INPUT'), gst: gst({ box5: '600.00', box7: '54.00' }), journal: journal('journal_e05', '2026-01-20', [jl('journal_e05_l01', '7600', '600.00', '0.00'), jl('journal_e05_l02', '2951', '54.00', '0.00'), jl('journal_e05_l03', '2870', '0.00', '654.00'), jl('journal_e05_l04', '2870', '654.00', '0.00'), jl('journal_e05_l05', '1910', '0.00', '654.00')]) }),
  event({ id: 'E06', date: '2026-01-23', bank_line_ids: ['b006'], evidence_id: 'doc_supplier_bill_eu_001', match_id: 'match_e06_b006', coding: coding(['7800', '2870', '3900', '1910'], 'NO_SG_GST_FOREIGN_TAX'), gst: gst({ box13: '-2.40', realized_fx: '-2.40' }), journal: journal('journal_e06', '2026-01-23', [jl('journal_e06_l01', '7800', '348.00', '0.00'), jl('journal_e06_l02', '2870', '0.00', '348.00'), jl('journal_e06_l03', '2870', '348.00', '0.00'), jl('journal_e06_l04', '3900', '2.40', '0.00'), jl('journal_e06_l05', '1910', '0.00', '350.40')]) }),
  event({ id: 'E07', date: '2026-01-28', bank_line_ids: ['b007'], evidence_id: 'doc_receipt_pos_001', match_id: 'match_e07_b007', coding: coding(['7800', '2951', '1910'], 'GST_STANDARD_INPUT'), gst: gst({ box5: '100.00', box7: '9.00' }), journal: journal('journal_e07', '2026-01-28', [jl('journal_e07_l01', '7800', '100.00', '0.00'), jl('journal_e07_l02', '2951', '9.00', '0.00'), jl('journal_e07_l03', '1910', '0.00', '109.00')]) }),
  event({ id: 'E08', date: '2026-02-05', bank_line_ids: ['b009'], evidence_id: 'doc_processor_settlement_001', match_id: 'match_e08_b009', coding: coding(['1910', '3000', '2950', '7800', '2951'], 'MIXED_STANDARD_PAYOUT'), gst: gst({ box1: '2800.00', box5: '100.00', box6: '252.00', box7: '9.00', box13: '2800.00' }), journal: journal('journal_e08', '2026-02-05', [jl('journal_e08_l01', '1910', '2943.00', '0.00'), jl('journal_e08_l02', '3000', '200.00', '0.00'), jl('journal_e08_l03', '2950', '18.00', '0.00'), jl('journal_e08_l04', '7800', '100.00', '0.00'), jl('journal_e08_l05', '2951', '9.00', '0.00'), jl('journal_e08_l06', '3000', '0.00', '3000.00'), jl('journal_e08_l07', '2950', '0.00', '270.00')]) }),
  event({ id: 'E09', date: '2026-02-09', bank_line_ids: ['b010'], evidence_id: 'doc_rent_bill_2026_02', match_id: 'match_e09_b010', coding: coding(['7000', '2951', '2870', '1910'], 'GST_STANDARD_INPUT'), gst: gst({ box5: '2000.00', box7: '180.00' }), journal: journal('journal_e09', '2026-02-09', [jl('journal_e09_l01', '7000', '2000.00', '0.00'), jl('journal_e09_l02', '2951', '180.00', '0.00'), jl('journal_e09_l03', '2870', '0.00', '2180.00'), jl('journal_e09_l04', '2870', '2180.00', '0.00'), jl('journal_e09_l05', '1910', '0.00', '2180.00')]) }),
  event({ id: 'E10', date: '2026-02-12', bank_line_ids: ['b011', 'b012'], evidence_id: 'doc_wise_conversion_001', match_id: 'match_e10_b011_b012', coding: coding(['1910', '7800', '3900'], 'GST_EXEMPT_OUTPUT'), gst: gst({ box13: '5.20', realized_fx: '5.20' }), journal: journal('journal_e10', '2026-02-12', [jl('journal_e10_l01', '1910', '382.80', '0.00'), jl('journal_e10_l02', '7800', '2.00', '0.00'), jl('journal_e10_l03', '1910', '0.00', '379.60'), jl('journal_e10_l04', '3900', '0.00', '5.20')]) }),
  event({ id: 'E11', date: '2026-02-17', bank_line_ids: ['b013', 'b014'], evidence_id: 'doc_airwallex_conversion_002', match_id: 'match_e11_b013_b014', coding: coding(['1910', '7800', '3900'], 'GST_EXEMPT_OUTPUT'), gst: gst({ box13: '10.00', realized_fx: '10.00' }), journal: journal('journal_e11', '2026-02-17', [jl('journal_e11_l01', '1910', '678.00', '0.00'), jl('journal_e11_l02', '7800', '2.00', '0.00'), jl('journal_e11_l03', '1910', '0.00', '670.00'), jl('journal_e11_l04', '3900', '0.00', '10.00')]) }),
  event({ id: 'E12', date: '2026-02-20', bank_line_ids: ['b015', 'b016'], evidence_id: 'doc_internal_transfer_001', match_id: 'match_e12_b015_b016', coding: coding(['1910'], 'NO_GST'), gst: gst(), journal: journal('journal_e12', '2026-02-20', [jl('journal_e12_l01', '1910', '1000.00', '0.00'), jl('journal_e12_l02', '1910', '0.00', '1000.00')]) }),
  event({ id: 'E13', date: '2026-02-23', bank_line_ids: ['b017'], evidence_id: 'doc_receipt_office_001', match_id: 'match_e13_b017', coding: coding(['7800', '2951', '1910'], 'GST_STANDARD_INPUT'), gst: gst({ box5: '200.00', box7: '18.00' }), journal: journal('journal_e13', '2026-02-23', [jl('journal_e13_l01', '7800', '200.00', '0.00'), jl('journal_e13_l02', '2951', '18.00', '0.00'), jl('journal_e13_l03', '1910', '0.00', '218.00')]) }),
  event({ id: 'E14', date: '2026-03-03', bank_line_ids: ['b022'], evidence_id: 'doc_tax_invoice_lc_004', match_id: 'match_e14_b022', coding: coding(['1700', '3000', '2950', '1910'], 'GST_STANDARD_OUTPUT'), gst: gst({ box1: '2000.00', box6: '180.00', box13: '2000.00' }), journal: journal('journal_e14', '2026-03-03', [jl('journal_e14_l01', '1700', '2180.00', '0.00'), jl('journal_e14_l02', '3000', '0.00', '2000.00'), jl('journal_e14_l03', '2950', '0.00', '180.00'), jl('journal_e14_l04', '1910', '2180.00', '0.00'), jl('journal_e14_l05', '1700', '0.00', '2180.00')]) }),
  event({ id: 'E15', date: '2026-03-06', bank_line_ids: ['b023'], evidence_id: 'doc_export_invoice_lc_005', match_id: 'match_e15_b023', coding: coding(['1700', '3200', '1910', '3900'], 'GST_ZERO_OUTPUT'), gst: gst({ box2: '1470.00', box13: '1490.00', realized_fx: '20.00' }), journal: journal('journal_e15', '2026-03-06', [jl('journal_e15_l01', '1700', '1470.00', '0.00'), jl('journal_e15_l02', '3200', '0.00', '1470.00'), jl('journal_e15_l03', '1910', '1490.00', '0.00'), jl('journal_e15_l04', '1700', '0.00', '1470.00'), jl('journal_e15_l05', '3900', '0.00', '20.00')]) }),
  event({ id: 'E16', date: '2026-03-10', bank_line_ids: ['b024'], evidence_id: 'doc_supplier_bill_sg_003', match_id: 'match_e16_b024', coding: coding(['4400', '2951', '2870', '1910'], 'GST_STANDARD_INPUT'), gst: gst({ box5: '1000.00', box7: '90.00' }), journal: journal('journal_e16', '2026-03-10', [jl('journal_e16_l01', '4400', '1000.00', '0.00'), jl('journal_e16_l02', '2951', '90.00', '0.00'), jl('journal_e16_l03', '2870', '0.00', '1090.00'), jl('journal_e16_l04', '2870', '1090.00', '0.00'), jl('journal_e16_l05', '1910', '0.00', '1090.00')]) }),
  event({ id: 'E17', date: '2026-03-16', bank_line_ids: ['b025'], evidence_id: 'doc_interest_advice_2026_03', match_id: 'match_e17_b025', coding: coding(['1910', '9300'], 'GST_EXEMPT_OUTPUT'), gst: gst({ box13: '15.00', exempt_non_fx_box3: '15.00' }), journal: journal('journal_e17', '2026-03-16', [jl('journal_e17_l01', '1910', '15.00', '0.00'), jl('journal_e17_l02', '9300', '0.00', '15.00')]) }),
  event({ id: 'E18', date: '2026-03-27', bank_line_ids: ['b029'], evidence_id: 'doc_receipt_office_002', match_id: 'match_e18_b029', coding: coding(['7800', '2951', '1910'], 'GST_STANDARD_INPUT'), gst: gst({ box5: '150.00', box7: '13.50' }), journal: journal('journal_e18', '2026-03-27', [jl('journal_e18_l01', '7800', '150.00', '0.00'), jl('journal_e18_l02', '2951', '13.50', '0.00'), jl('journal_e18_l03', '1910', '0.00', '163.50')]) }),
  event({ id: 'E19', date: '2026-03-30', bank_line_ids: ['b030'], evidence_id: 'doc_petty_cash_voucher_001', match_id: 'match_e19_b030', coding: coding(['1900', '1910'], 'NO_GST'), gst: gst(), journal: journal('journal_e19', '2026-03-30', [jl('journal_e19_l01', '1900', '500.00', '0.00'), jl('journal_e19_l02', '1910', '0.00', '500.00')]) }),
  event({ id: 'E20', date: '2026-03-31', bank_line_ids: ['b031'], evidence_id: 'doc_foreign_goods_invoice_001', match_id: 'match_e20_b031', coding: coding(['1700', '3000', '1910'], 'GST_OUT_OF_SCOPE'), gst: gst({ box13: '1200.00' }), journal: journal('journal_e20', '2026-03-31', [jl('journal_e20_l01', '1700', '1200.00', '0.00'), jl('journal_e20_l02', '3000', '0.00', '1200.00'), jl('journal_e20_l03', '1910', '1200.00', '0.00'), jl('journal_e20_l04', '1700', '0.00', '1200.00')]) }),
];

const ownerCases = [
  ['U01', 'b008', 'ask_u01_funding_basis', 'required_evidence_u01', 'funding_agreement_or_remittance_advice', 'What is the source and legal basis of the SGD 3,000.00 transfer on 30 January: a director loan, a repayment, share capital, or a customer receipt? Please identify and send the agreement or remittance reference.', '3000.00'],
  ['U02', 'b018', 'ask_u02_imported_service_use', 'required_evidence_u02', 'vendor_invoice_and_business_use_statement', 'Was US-SUP-001 used solely for taxable business activities, or also for exempt, private, or other non-business activities? Please send the vendor invoice and identify any Singapore GST or foreign tax shown on it.', '-536.00'],
  ['U03', 'b019', 'ask_u03_cpf_split', 'required_evidence_u03', 'cpf_ezpay_submission_or_receipt', 'Which contribution month does the SGD 4,500.00 CPF EZPay debit cover, and what are its employee CPF, employer CPF, SDL, FWL, and self-help-fund amounts? Please send the submission or receipt.', '-4500.00'],
  ['U04', 'b020', 'ask_u04_hotel_purpose', 'required_evidence_u04', 'hotel_folio_and_business_purpose_statement', 'Who travelled for the SGD 600.00 hotel charge, on which dates, and for what business purpose or customer event? Please send the hotel folio.', '-600.00'],
  ['U05', 'b021', 'ask_u05_iras_liability', 'required_evidence_u05', 'iras_notice_or_payment_breakdown', 'Which tax type, filing period or Year of Assessment, and notice or liability does the SGD 2,000.00 IRAS GIRO debit settle? Please send the notice or payment breakdown.', '-2000.00'],
  ['U06', 'b026', 'ask_u06_funding_basis', 'required_evidence_u06', 'facility_or_funding_agreement', 'Who provided the SGD 5,000.00 funding on 19 March, and was it a bank loan, director funding, customer money, or share capital? Please send the facility, funding agreement, or remittance advice.', '5000.00'],
  ['U07', 'b027', 'ask_u07_loan_split', 'required_evidence_u07', 'lender_statement_or_amortisation_schedule', 'Which loan does the SGD 550.00 repayment relate to, and how much is principal, interest, and fees? Please send the lender statement or amortisation schedule.', '-550.00'],
  ['U08', 'b028', 'ask_u08_cpf_split', 'required_evidence_u08', 'cpf_ezpay_submission_or_receipt', 'Which contribution month does the SGD 4,800.00 CPF EZPay debit cover, and what are its employee CPF, employer CPF, SDL, FWL, and self-help-fund amounts? Please send the submission or receipt.', '-4800.00'],
].map(([id, bank_line_id, ask_id, required_evidence_id, expected_evidence_type, question, sgd_movement]) => ({
  id,
  entity_id: SG_DEMO_1_ENTITY_ID,
  bank_line_id,
  ask_id,
  required_evidence_id,
  expected_evidence_type,
  question,
  sgd_movement,
  expected_coding: 'blocked_missing_business_fact',
  actor_id: 'principal/owner-sg-demo-1',
  audience: 'customer_human',
  authority_basis: 'missing_business_fact',
  terminal: 'on_owner',
}));

const trialBalance = [
  ['1910', '30449.30', '0.00'],
  ['1900', '500.00', '0.00'],
  ['2951', '553.50', '0.00'],
  ['4000', '2000.00', '0.00'],
  ['4400', '1000.00', '0.00'],
  ['7000', '2000.00', '0.00'],
  ['7600', '600.00', '0.00'],
  ['7800', '902.00', '0.00'],
  ['2000', '0.00', '20000.00'],
  ['2251', '0.00', '7070.00'],
  ['2950', '0.00', '567.00'],
  ['3000', '0.00', '7500.00'],
  ['3200', '0.00', '2820.00'],
  ['9300', '0.00', '15.00'],
  ['3900', '0.00', '32.80'],
].map(([account_code, debit, credit]) => ({ account_code, debit, credit }));

export function buildSgDemo1Book() {
  return deepFreeze({
    schema_version: SG_DEMO_1_BOOK_SCHEMA_VERSION,
    world_id: SG_DEMO_1_WORLD_ID,
    source_manifest_id: 'sg-demo-1-source-manifest-v1',
    fixture_clock: SG_DEMO_1_FIXTURE_CLOCK,
    entity: {
      id: SG_DEMO_1_ENTITY_ID,
      legal_name: 'Lion City Commerce Pte. Ltd.',
      jurisdiction: 'SG',
      entity_type: 'sg-pte',
      functional_currency: 'SGD',
      book_basis: 'accrual_management_books',
      financial_year_end: '12-31',
      gst_registered: true,
      gst_rate: '0.09',
      owner_actor_id: 'principal/owner-sg-demo-1',
    },
    period: { id: SG_DEMO_1_PERIOD_ID, start: '2026-01-01', end: '2026-03-31' },
    accounts,
    opening_journal: openingJournal,
    statements,
    bank_lines: bankLines,
    evidence: evidenceRows,
    events,
    owner_cases: ownerCases,
    gst_f5: {
      box1: '6300.00', box2: '2820.00', box3: '47.80', box4: '9167.80', box5: '6150.00',
      box6: '567.00', box7: '553.50', box8: '13.50', box9: '0.00', box13: '10367.80', box14: '0.00',
      exempt_non_fx_box3: '15.00', realized_fx_net: '32.80',
    },
    reverse_charge_alternative: {
      owner_case_id: 'U02',
      base_sgd: '536.00',
      box1_increment: '536.00',
      box14_increment: '536.00',
      box6_increment: '48.24',
      box7_increment: 'conditional_on_input_tax_entitlement',
      base_fixture_posting: 'none_on_owner',
    },
    trial_balance: trialBalance,
    controls: {
      statement_closing_sgd: '25463.30',
      posted_bank_control_sgd: '30449.30',
      owner_pending_movement_sgd: '-4986.00',
      petty_cash_sgd: '500.00',
      cash_and_cash_equivalents_sgd: '30949.30',
      opening_cash_sgd: '27070.00',
      cash_increase_sgd: '3879.30',
      revenue_and_other_income_sgd: '10367.80',
      expenses_sgd: '6502.00',
      profit_sgd: '3865.80',
      input_gst_asset_sgd: '553.50',
      output_gst_liability_sgd: '567.00',
      closing_equity_sgd: '30935.80',
      assets_including_input_gst_sgd: '31502.80',
    },
    cross_entity_decoys: [{
      id: 'decoy_b001_sibling',
      entity_id: SG_DEMO_1_SIBLING_ENTITY_ID,
      date: '2026-01-06',
      currency: 'SGD',
      amount: '1090.00',
      reference: 'LC-INV-001',
      expected_match_id: null,
      terminal: 'on_owner',
    }],
  });
}

const sourceRows = [
  ['iras_gst_rate', 'Current GST rate', 'https://www.iras.gov.sg/taxes/goods-services-tax-%28gst%29/basics-of-gst/current-gst-rates', 'Singapore GST rate is 9% for the fixture period.', 'afaeadb91d018d90ad3c4c25eb1fe72a990668d82de702bb25765c62deec965a'],
  ['iras_gst_inclusive', 'Displaying and quoting prices', 'https://www.iras.gov.sg/taxes/goods-services-tax-%28gst%29/basics-of-gst/invoicing-price-display-and-record-keeping/displaying-and-quoting-prices', 'GST-inclusive amounts use the 9/109 tax fraction.', '9f907f6f8bc4ded136c82e4273f156229f494a334a13e7357d1593cb4a8bf542'],
  ['iras_gst_return', 'Completing GST returns', 'https://www.iras.gov.sg/taxes/goods-services-tax-%28gst%29/filing-gst/completing-gst-returns', 'GST return figures are SGD; imported services under reverse charge affect Box 1 and Box 14.', 'bff347150defbaada4d717aad9badad3bb88719440bfa6770f4b26378b1d8688'],
  ['iras_input_tax', 'Conditions for claiming input tax', 'https://www.iras.gov.sg/taxes/goods-services-tax-%28gst%29/claiming-gst-%28input-tax%29/conditions-for-claiming-input-tax', 'Input GST requires registration, business purpose and valid supporting tax evidence.', 'ca98f7f41c086f1eec44b2c537465139ea7307bea7760fe044e2a3d7f27e1188'],
  ['iras_imported_services', 'GST on imported services for local businesses', 'https://www.iras.gov.sg/taxes/goods-services-tax-%28gst%29/gst-and-digital-economy/local-businesses', 'Reverse charge depends on use and input-tax entitlement; incorrectly charged overseas tax is not Singapore input GST.', 'e130ea418f22bf9e64bb1d3e112e17d9c493f2c9edcaefff8a0a8e95ce53278b'],
  ['iras_international_services', 'Providing international services', 'https://www.iras.gov.sg/taxes/goods-services-tax-%28gst%29/charging-gst-%28output-tax%29/when-to-charge-0-gst-%28zero-rate%29/providing-international-services', 'International services are zero-rated only when the applicable statutory conditions are met.', 'cce2001d29a50d14e8ea275357da47c7242f3e5d1f96fcf0508ce0bbef91175d'],
  ['iras_exempt_supplies', 'Supplies exempt from GST', 'https://www.iras.gov.sg/taxes/goods-services-tax-%28gst%29/charging-gst-%28output-tax%29/when-is-gst-not-charged/supplies-exempt-from-gst', 'Bank interest and the absolute net realised FX result are represented in Box 3.', '854b99aad14708a4fcea1da894fcc8cb8eacdaf60d12a4f5757182b57b406737'],
  ['iras_interest', 'Interest scenarios', 'https://www.iras.gov.sg/taxes/goods-services-tax-%28gst%29/charging-gst-%28output-tax%29/common-scenarios---do-i-charge-gst/interest-relating-to-bank-deposit-loan-trade-debt', 'Deposit interest is an exempt supply in this fixture.', 'b9b8ecfd4039fc910ee08fde4eee6ee242da6885e4b411c8edbcbb42c09485a9'],
  ['iras_cit_giro', 'GIRO for Corporate Income Tax', 'https://www.iras.gov.sg/quick-links/payments/giro-corporate-income-tax/1000', 'An IRAS GIRO narrative does not identify the liability or assessment period by itself.', '252df9239536d6a514e62486d1b4e297fabcd382c42c9e5b9000d4ed67cddae1'],
  ['cpf_employer', 'Employer obligations', 'https://www.cpf.gov.sg/employer/employer-obligations', 'CPF settlement needs the contribution month and component split before coding.', '2bbd93131ecba5d693871b9242be6329e189b3127f298b4aeb8de5de873ce917'],
  ['abs_paynow', 'PayNow fact sheet', 'https://abs.org.sg/docs/library/paynow_factsheet.pdf?sfvrsn=2803cc6f_34', 'PayNow is represented as a Singapore bank-transfer rail, not an accounting conclusion.', '092f41a8eb2c29535cd5a83350375d1d11ac8c942e1af97891dd150ec9bc137a'],
  ['dbs_terms', 'DBS general banking terms and conditions', 'https://www.dbs.com.sg/documents/1038650/406595596/gbtc.pdf/9368efb2-f57c-a3ff-40c5-3d7fa7f7ed47?t=1763089213400', 'DBS-style evidence uses synthetic FAST, PayNow and GIRO narratives.', '32392e79b1f53162bd8be98b141b15017c9694c53bc5b66b073e6e2299138cd2'],
  ['ocbc_terms', 'OCBC business account terms and conditions', 'https://www.ocbc.com/iwov-resources/sg/ocbc/business/pdf/business_account_terms_and_conditions_effective1jan25.pdf', 'OCBC-style evidence uses synthetic FAST and GIRO narratives.', '374e17b00a675b156c5bfbb4ed281a4f03298a0725d50751e16af67239cc65f8'],
  ['airwallex_account', 'Airwallex Business Account', 'https://www.airwallex.com/en-sg/business-account/', 'Airwallex-style wallet evidence identifies source currency, conversion, fees and net settlement.', 'e0d66cf7d77879491618afc72a4e17c7500a12fc9fa6096265d3ec22892ed56c'],
  ['wise_fees', 'Wise Business fees', 'https://wise.com/help/articles/2977969/fees-for-using-wise-business', 'Wise-style wallet evidence identifies source currency, exchange rate, fee and net settlement.', '99ee28d25206375ae6374226e50208443f355adafe27912a4bdeb32f907e5808'],
];

export function buildSgDemo1SourceManifest() {
  return deepFreeze({
    schema_version: SG_DEMO_1_SOURCE_SCHEMA_VERSION,
    id: 'sg-demo-1-source-manifest-v1',
    retrieved_at: '2026-09-02',
    sources: sourceRows.map(([id, title, url, stored_interpretation, retrieved_content_sha256]) => ({
      id,
      title,
      url,
      retrieved_content_sha256,
      stored_interpretation,
      stored_interpretation_sha256: sha256(stored_interpretation),
    })),
  });
}

export function buildSgDemo1EvidenceWorld(book = buildSgDemo1Book()) {
  const artifactRows = [
    ...book.statements.map((statement) => ({
      id: statement.id,
      kind: 'bank_statement_pdf',
      format: 'pdf',
      trusted: true,
      fixtureFile: statement.filename,
      title: `Synthetic ${statement.provider_style} statement ${statement.month}`,
      fields: {
        filename: statement.filename,
        providerStyle: statement.provider_style,
        period: statement.month,
        currency: statement.currency,
        openingBalance: statement.opening_balance,
        closingBalance: statement.closing_balance,
        transactions: statement.bank_line_ids.map((id) => {
          const line = book.bank_lines.find((candidate) => candidate.id === id);
          return `${line.date} | ${line.narrative} | ${line.amount} ${line.currency}`;
        }),
        syntheticNotice: 'Synthetic SG-Demo-1 evidence; not issued by the named provider.',
      },
      occurredAt: statement.closing_date,
      terminal: statement.terminal,
    })),
    ...book.evidence.map((item) => ({
      id: item.id,
      kind: `${item.kind}_pdf`,
      format: 'pdf',
      trusted: true,
      fixtureFile: item.filename,
      title: item.title,
      fields: {
        filename: item.filename,
        documentDate: item.document_date,
        currency: item.currency,
        totalAmount: item.total_amount,
        reference: item.reference,
        details: item.details,
        syntheticNotice: 'Synthetic SG-Demo-1 evidence; no customer or provider data.',
      },
      occurredAt: item.document_date,
      terminal: item.terminal,
    })),
  ];
  return deepFreeze({
    specVersion: 'donna.world.v2',
    worldId: 'sg-demo-1/evidence-v1',
    seed: 'sg-demo-1-evidence-seed-v1',
    effectiveDate: '2026-03-31',
    manifest: {
      manifestVersion: 'sg-demo-1.fixture.v1',
      capabilityId: 'evaluate_sg_demo_1_goldset',
      jurisdiction: 'SG',
      entityType: 'sg-pte',
      bookBasis: 'management_books',
      scenarioLane: 'offline_accounting_goldset',
      accountingView: 'management_books',
      protectedFailures: ['fee_as_revenue', 'foreign_tax_as_sg_input_gst', 'owner_fact_guessed', 'cross_entity_match'],
      requiredWorldFamilies: ['sg_books_in'],
      permittedActions: ['evaluate_fixture'],
      maximumAuthority: 'offline_assertion_only',
      fallback: { terminalState: 'blocked', responsibleActor: 'test_operator', nextPermittedAction: 'repair_fixture' },
    },
    entities: [
      { id: SG_DEMO_1_ENTITY_ID, kind: 'legal_entity', activeFrom: '2026-01-01' },
      { id: SG_DEMO_1_SIBLING_ENTITY_ID, kind: 'legal_entity', activeFrom: '2026-01-01' },
    ],
    events: artifactRows.map((artifact) => ({
      id: `render_event_${artifact.id}`,
      type: 'fixture_evidence',
      legalEntityId: SG_DEMO_1_ENTITY_ID,
      occurredAt: artifact.occurredAt,
      causalParents: [],
      evidenceRefs: [artifact.id],
    })),
    observations: artifactRows.map((artifact) => ({
      id: `observation_${artifact.id}`,
      eventId: `render_event_${artifact.id}`,
      artifactId: artifact.id,
      observedAt: artifact.occurredAt,
    })),
    hiddenFacts: [],
    artifacts: artifactRows.map(({ occurredAt: _occurredAt, terminal: _terminal, ...artifact }) => artifact),
  });
}

function deepFreeze(value) {
  if (Array.isArray(value)) value.forEach(deepFreeze);
  else if (isPlainObject(value)) Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
