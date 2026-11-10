// FI-3 read surface — pure view-model tests (format-only: the view model never
// recomputes a box; it renders the envelope + lifecycle row verbatim).
// node --test src/lib/alvReturnView.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALV_VIEW_BOX_FIELDS,
  alvBlockerView,
  alvPeriodOptions,
  buildAlvReturnViewModel,
  defaultAlvPeriodKey,
  formatEur
} from './alvReturnView.js';

const envelope = ({ overrides = {}, review = {}, lifecycle = undefined } = {}) => ({
  period: { key: '2026-06', type: 'month', starts_on: '2026-06-01', ends_on: '2026-06-30' },
  alvReturn: {
    boxes: { 301: 127.5, 307: 25.5, 308: 102, 309: 0, 311: 0 },
    payable: 102,
    refund: false,
    nilReturn: false,
    selfAssessedFullyDeductible: true,
    ...overrides
  },
  review: { status: 'ready', blockers: [], uncodedRevenueLines: [], incompatibleLines: [], uncodedExpenseLineCount: 0, ...review },
  provenance: { source: 'ledger_read_model', deterministic: true, readAt: '2026-07-10T12:00:00Z', boxMap: { confirmedAgainstPrimary: false } },
  ...(lifecycle !== undefined ? { lifecycle } : {})
});

test('renders the envelope verbatim: period, payable, non-zero boxes only, provenance', () => {
  const vm = buildAlvReturnViewModel(envelope());
  assert.equal(vm.status, 'ready');
  assert.equal(vm.periodKey, '2026-06');
  assert.equal(vm.periodTypeLabel, 'kuukausi');
  assert.equal(vm.periodRangeLabel, '1.6.2026 – 30.6.2026');
  assert.equal(vm.payableLabel, 'Maksettava vero (308)');
  assert.equal(vm.payableDisplay, '102,00 €');
  // Only the non-zero boxes render; 308 renders separately as the total line.
  assert.deepEqual(vm.boxRows.map((r) => r.field), ['301', '307']);
  assert.equal(vm.boxRows[0].display, '127,50 €');
  assert.match(vm.provenanceLine, /Deterministinen laskenta/);
  assert.match(vm.boxMapUnconfirmedNote, /F-FI3-1/);
  assert.match(vm.selfAssessedNote, /vähennetty täysimääräisesti/);
  assert.equal(vm.lifecycle, null);
});

test('refund and nil returns read honestly; non-envelopes hide the surface', () => {
  const refund = buildAlvReturnViewModel(envelope({ overrides: { payable: -50, refund: true, boxes: { 307: 50, 308: -50 } } }));
  assert.equal(refund.payableLabel, 'Palautukseen oikeuttava vero (308)');
  assert.equal(refund.payableDisplay, '50,00 €');
  const nil = buildAlvReturnViewModel(envelope({ overrides: { payable: 0, nilReturn: true, boxes: { 308: 0 } } }));
  assert.equal(nil.nilReturn, true);
  assert.equal(buildAlvReturnViewModel(null), null);
  assert.equal(buildAlvReturnViewModel({ review: {} }), null);
  assert.equal(buildAlvReturnViewModel({ ok: true }), null);
});

test('blockers + offending lines surface verbatim; unknown codes render as themselves', () => {
  const vm = buildAlvReturnViewModel(envelope({
    review: {
      status: 'needs_review',
      blockers: ['uncoded_revenue_lines', 'something_new'],
      uncodedRevenueLines: [{ journal_id: 'j-1', account_code: '3000', amount: 620 }],
      incompatibleLines: [{ journal_id: 'j-2', account_code: '1763', tax_type: 'ALV_25_5_OUTPUT', amount: -10 }],
      uncodedExpenseLineCount: 3
    }
  }));
  assert.equal(vm.status, 'needs_review');
  assert.equal(vm.blockers[0].label, 'Tulotapahtumia ilman ALV-käsittelyä');
  assert.equal(vm.blockers[1].label, 'something_new'); // surfacing beats prettiness
  assert.equal(vm.uncodedRevenueLines[0].display, '620,00 €');
  assert.equal(vm.incompatibleLines[0].taxType, 'ALV_25_5_OUTPUT');
  assert.match(vm.uncodedExpenseNote, /^3 kulutapahtumaa/);
  assert.equal(alvBlockerView('incompatible_tax_lines').severity, 'blocker');
});

test('control_account_mismatch carries FI copy + the cross-check rows render the diagnosis (D-FI3-S5)', () => {
  // The new blocker is part of the closed vocabulary — never the raw-code fallback.
  const view = alvBlockerView('control_account_mismatch');
  assert.equal(view.severity, 'blocker');
  assert.match(view.label, /ALV-velkatilien/);
  assert.match(view.hint, /peruutus \+ uusi kirjaus/);

  const vm = buildAlvReturnViewModel(envelope({
    review: {
      status: 'needs_review',
      blockers: ['control_account_mismatch'],
      controlCheck: {
        ran: true,
        outputTax: { expected: 255, actual: 0 },
        domesticDeductible: { expected: 25.5, actual: 25.5 },
        tolerance: 0.02,
        legCount: 1,
        unmarkedControlMovement: 0
      }
    }
  }));
  assert.equal(vm.blockers[0].label, view.label);
  assert.equal(vm.controlCheckRows.length, 2);
  const [output, deductible] = vm.controlCheckRows;
  assert.equal(output.mismatch, true);
  assert.equal(output.expected, '255,00 €');
  assert.equal(output.actual, '0,00 €');
  // Agreement within tolerance is informational, not a mismatch.
  assert.equal(deductible.mismatch, false);
  assert.equal(vm.unmarkedControlMovementNote, null);
});

test('the unmarked-control-movement INFO lane renders — the 308 settlement\'s resting surface', () => {
  const vm = buildAlvReturnViewModel(envelope({
    review: {
      status: 'ready',
      blockers: [],
      controlCheck: {
        ran: true,
        outputTax: { expected: 255, actual: 255 },
        domesticDeductible: { expected: 0, actual: 0 },
        tolerance: 0.02,
        legCount: 1,
        unmarkedControlMovement: 812.4
      }
    }
  }));
  assert.deepEqual(vm.blockers, []);
  assert.match(vm.unmarkedControlMovementNote, /^812,40 € liikettä ALV-velkatileillä/);
  assert.match(vm.unmarkedControlMovementNote, /ei estä ilmoitusta/);
  assert.equal(vm.controlCheckRows.some((r) => r.mismatch), false);
  // No cross-check on the envelope (a pre-slice-S verdict) → empty rows, no note.
  const legacy = buildAlvReturnViewModel(envelope({ review: { status: 'ready', blockers: [] } }));
  assert.deepEqual(legacy.controlCheckRows, []);
  assert.equal(legacy.unmarkedControlMovementNote, null);
});

test('the persisted lifecycle row renders by its closed enum — never inferred', () => {
  const filed = buildAlvReturnViewModel(envelope({
    lifecycle: { status: 'filed', filed_at: '2026-07-12T09:00:00Z', filing_receipt: { submission_id: 'SUB-9' } }
  }));
  assert.equal(filed.lifecycle.tone, 'ok');
  assert.equal(filed.lifecycle.label, 'Lähetetty Verohallinnolle');
  assert.equal(filed.lifecycle.filedAt, '12.7.2026');
  assert.equal(filed.lifecycle.submissionId, 'SUB-9');
  const pending = buildAlvReturnViewModel(envelope({ lifecycle: { status: 'draft_pending_confirmation' } }));
  assert.equal(pending.lifecycle.tone, 'pending');
  const cancelled = buildAlvReturnViewModel(envelope({ lifecycle: { status: 'cancelled', cancel_reason: 'owner_declined' } }));
  assert.equal(cancelled.lifecycle.tone, 'muted');
  assert.equal(cancelled.lifecycle.cancelReason, 'owner_declined');
  // An unknown status renders as itself.
  const odd = buildAlvReturnViewModel(envelope({ lifecycle: { status: 'weird' } }));
  assert.equal(odd.lifecycle.label, 'weird');
});

test('period helpers: previous-month default (D3) and a clean picker enumeration', () => {
  assert.equal(defaultAlvPeriodKey(new Date(Date.UTC(2026, 6, 10))), '2026-06'); // July → June
  assert.equal(defaultAlvPeriodKey(new Date(Date.UTC(2026, 0, 5))), '2025-12'); // Jan → Dec prior year

  const options = alvPeriodOptions(new Date(Date.UTC(2026, 6, 10)));
  const keys = options.map((o) => o.key);
  assert.equal(keys[0], '2026-06');
  assert.equal(keys[11], '2025-07'); // 12 months back, no gaps
  assert.deepEqual(keys.slice(12, 16), ['2026-Q2', '2026-Q1', '2025-Q4', '2025-Q3']);
  assert.deepEqual(keys.slice(16), ['2026', '2025']);
  assert.equal(new Set(keys).size, keys.length, 'no duplicate period keys');

  const january = alvPeriodOptions(new Date(Date.UTC(2026, 0, 5)));
  assert.equal(january[0].key, '2025-12');
  assert.equal(january.map((o) => o.key)[12], '2025-Q4');
});

test('period helpers: cadence-aware default + picker leads with the client cadence (F-FI3-3)', () => {
  const now = new Date(Date.UTC(2026, 6, 10)); // July 2026
  // Default = the previous COMPLETED period for the cadence.
  assert.equal(defaultAlvPeriodKey(now, 'month'), '2026-06');
  assert.equal(defaultAlvPeriodKey(now, 'quarter'), '2026-Q2');
  assert.equal(defaultAlvPeriodKey(now, 'year'), '2025');
  // Omitted / unknown cadence ⇒ the D3 monthly default (backward compatible).
  assert.equal(defaultAlvPeriodKey(now), '2026-06');
  assert.equal(defaultAlvPeriodKey(now, 'bogus'), '2026-06');

  // The picker leads with the cadence group but still offers all three.
  const quarterly = alvPeriodOptions(now, 'quarter').map((o) => o.key);
  assert.equal(quarterly[0], '2026-Q2', 'quarterly filer sees quarters first');
  assert.deepEqual(quarterly.slice(0, 4), ['2026-Q2', '2026-Q1', '2025-Q4', '2025-Q3']);
  assert.ok(quarterly.includes('2026-06') && quarterly.includes('2025'), 'months + years still available');
  assert.equal(new Set(quarterly).size, quarterly.length, 'no duplicate keys when reordered');

  const annual = alvPeriodOptions(now, 'year').map((o) => o.key);
  assert.equal(annual[0], '2026', 'annual filer sees years first');
  assert.equal(new Set(annual).size, 18, 'all 18 periods present regardless of lead');
});

test('formatEur + the display box map covers every VSRALVKV field except the computed 308', () => {
  assert.equal(formatEur(12345.678), '12 345,68 €');
  assert.equal(formatEur(-4.2), '−4,20 €');
  const expected = ['301', '302', '303', '304', '305', '306', '318', '307', '309', '310', '311', '312', '313', '314', '319', '320'];
  assert.deepEqual(ALV_VIEW_BOX_FIELDS, expected);
});

test('FI-09: excluded uploaded sales documents are listed by name, amount and state in the blocker', () => {
  const vm = buildAlvReturnViewModel(envelope({
    review: {
      status: 'needs_review',
      blockers: ['unrecognized_sales_documents'],
      unrecognizedSales: { items: [
        { document_id: 'd1', kind: 'invoice', invoice_numbers: ['1002'], customer: 'Lumikki Oy', document_date: '2025-02-12', net: 720, tax: 183.6, gross: 903.6, rests: 'no_settlement', on_nobody: false },
        { document_id: 'd2', kind: 'credit_note', invoice_numbers: [], customer: null, document_date: null, net: null, tax: null, gross: -50, rests: 'settled_outside_period', on_nobody: true }
      ] }
    }
  }));
  const [view] = vm.blockers;
  assert.equal(view.label, 'Ladattuja myyntilaskuja puuttuu kirjanpidosta');
  assert.match(view.hint, /Myyntilasku 1002, Lumikki Oy \(12\.2\.2025\): 720,00 € \+ ALV 183,60 € — maksua ei ole tiliotteilla, kysytty\./);
  assert.match(view.hint, /Hyvityslasku \(päiväys puuttuu\): −50,00 € \(ALV-erittely puuttuu\) — maksu on kirjattu toiselle kaudelle\./);
});

test('FI-09: excluded uploaded supplier documents have their own blocker, listed apart from the sales ones with expense and input ALV', () => {
  const vm = buildAlvReturnViewModel(envelope({
    review: {
      status: 'needs_review',
      blockers: ['unrecognized_sales_documents', 'unrecognized_purchase_documents'],
      unrecognizedSales: { items: [
        { document_id: 'd1', kind: 'invoice', invoice_numbers: ['1002'], customer: 'Lumikki Oy', counterparty: 'Lumikki Oy', document_date: '2025-02-12', net: 720, tax: 183.6, gross: 903.6, rests: 'no_settlement', on_nobody: false }
      ] },
      unrecognizedPurchases: { items: [
        { document_id: 'b1', side: 'purchase', kind: 'invoice', invoice_numbers: ['4711'], vendor: 'Tukku Oy', counterparty: 'Tukku Oy', document_date: '2025-02-05', net: 200, tax: 48, gross: 248, rests: 'no_settlement', on_nobody: false },
        { document_id: 'b2', side: 'purchase', kind: 'credit_note', invoice_numbers: ['HL-12'], vendor: 'Tukku Oy', counterparty: 'Tukku Oy', document_date: '2025-02-09', net: -50, tax: -12, gross: -62, rests: 'settlement_proposed', on_nobody: true }
      ] }
    }
  }));
  const [sales, purchases] = vm.blockers;
  assert.equal(sales.label, 'Ladattuja myyntilaskuja puuttuu kirjanpidosta');
  assert.doesNotMatch(sales.hint, /Tukku/);
  assert.equal(purchases.label, 'Ladattuja ostolaskuja puuttuu kirjanpidosta');
  assert.match(purchases.hint, /^Nämä ladatut ostolaskut .* kulut ja vähennettävä ALV puuttuvat/);
  assert.match(purchases.hint, /Ostolasku 4711, Tukku Oy \(5\.2\.2025\): kulu 200,00 € \+ ALV 48,00 € — maksua ei ole tiliotteilla, kysytty\./);
  assert.match(purchases.hint, /Ostohyvityslasku HL-12, Tukku Oy \(9\.2\.2025\): kulu −50,00 € \+ ALV −12,00 € — maksu on ehdotettu, ei vahvistettu\./);
  assert.doesNotMatch(purchases.hint, /Lumikki/);
});

test('cadence notice: a disagreement between the two recorded VAT periods, or a default, is shown — never resolved', () => {
  const base = { period: { key: '2026-09', type: 'month', starts_on: '2026-09-01', ends_on: '2026-09-30' }, alvReturn: { boxes: {}, payable: 0 }, review: { status: 'ready', blockers: [] } };
  const vm = (verokausi_basis) => buildAlvReturnViewModel({ ...base, verokausi: verokausi_basis?.cadence, verokausi_basis });
  assert.equal(vm(undefined).cadenceNotice, null, 'an envelope without the basis renders as before');
  assert.equal(vm({ cadence: 'quarter', defaulted: false, recorded: { verokausi: 'quarter', alv_registration_tax_period: 'quarter' }, disagreement: false }).cadenceNotice, null);
  const split = vm({ cadence: 'month', defaulted: false, recorded: { verokausi: 'month', alv_registration_tax_period: 'quarter' }, disagreement: true }).cadenceNotice;
  assert.equal(split.kind, 'disagreement');
  assert.match(split.text, /yrityksen tiedoissa: kuukausi, ALV-rekisteröinnissä: neljännesvuosi/);
  const onlyRegistration = vm({ cadence: 'month', defaulted: true, recorded: { verokausi: null, alv_registration_tax_period: 'year' }, disagreement: true }).cadenceNotice;
  assert.equal(onlyRegistration.kind, 'disagreement');
  assert.match(onlyRegistration.text, /oletuksella \(kuukausi\).*kalenterivuosi/);
  const nothing = vm({ cadence: 'month', defaulted: true, recorded: { verokausi: null, alv_registration_tax_period: null }, disagreement: false }).cadenceNotice;
  assert.deepEqual(nothing, { kind: 'defaulted', text: 'Yritykselle ei ole kirjattu verokautta, joten luvut lasketaan oletuksella (kuukausi).' });
});

test('covered_by: another live return over these dates is shown as the server gives it; nothing covering ⇒ empty', () => {
  const covered = buildAlvReturnViewModel({
    ...envelope(),
    period: { key: '2026-09', type: 'month', starts_on: '2026-09-01', ends_on: '2026-09-30' },
    lifecycle: null,
    covered_by: [
      { id: 'alv-q3', period_key: '2026-Q3', period_type: 'quarter', starts_on: '2026-07-01', ends_on: '2026-09-30', status: 'filed', filed_at: '2026-10-12T09:00:00Z' },
      { id: 'alv-x', period_key: '2026-08', starts_on: '2026-08-01', ends_on: '2026-08-31', status: 'cancelled' }
    ]
  });
  assert.deepEqual(covered.coveredBy, [{ periodKey: '2026-Q3', status: 'filed', tone: 'ok', rangeLabel: '1.7.2026 – 30.9.2026' }], 'a cancelled row covers nothing');
  assert.equal(covered.lifecycle, null);
  const pending = buildAlvReturnViewModel({ ...envelope(), covered_by: [{ period_key: '2026', starts_on: '2026-01-01', ends_on: '2026-12-31', status: 'draft_pending_confirmation' }] });
  assert.deepEqual(pending.coveredBy.map((c) => `${c.periodKey}:${c.tone}`), ['2026:pending']);
  assert.deepEqual(buildAlvReturnViewModel(envelope()).coveredBy, [], 'an envelope without covered_by (older server) renders nothing extra');
});

test('open correction cases: the blocker names each line, its reason and a closed period', () => {
  const view = alvBlockerView('open_coding_corrections', { openCodingCorrections: { count: 3, truncated: true, items: [
    { transaction_id: 'tx-1', journal_id: 'j-1', journal_date: '2026-06-10', reason: 'posted_source_evidence_changed', next_action: 'recode_decided', recovery: null },
    { transaction_id: 'tx-2', journal_id: 'j-2', journal_date: '2026-06-12', reason: 'posted_tax_registration_changed', next_action: 'person_corrects_closed_period', recovery: { state: 'blocked', code: 'CODING_CORRECTION_TAX_PERIOD_CLOSED' } }
  ] } });
  assert.equal(view.severity, 'blocker');
  assert.equal(view.label, 'Kauden kirjauksia korjataan');
  assert.match(view.hint, /^3 tämän kauden kirjauksella on avoin korjaus\. Luvut ovat kirjanpidon mukaiset/);
  assert.match(view.hint, /10\.6\.2026 \(tapahtuma tx-1, kirjaus j-1\): tosite muuttui kirjauksen jälkeen\./);
  assert.match(view.hint, /12\.6\.2026 \(tapahtuma tx-2, kirjaus j-2\): ALV-rekisteröinti on nyt toinen kuin kirjattaessa — kausi on lukittu tai ilmoitettu, korjauksen tekee ihminen\./);
  assert.match(view.hint, /Näytetään 2 \/ 3\.$/);
});
