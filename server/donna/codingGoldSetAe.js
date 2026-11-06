// Donna — the UAE coding gold set (Desert Rose round-4 review §D, 2026-09-01).
//
// WHAT THIS IS: a small, versioned set of bank lines whose CODING (account +
// UAE VAT treatment) the strong coder has been observed to get wrong or to
// FLIP between identical runs on a real two-month book — Nol top-up "out of
// scope" in January and "VAT 5%" in February (local passenger transport is
// exempt, so February would have claimed input VAT that does not exist);
// Netflix on reverse charge (a UAE-VAT-registered non-resident charging 5%);
// Zoho defaulted to RCM without reading the invoice on file; AC maintenance
// flipping between Operating supplies and Utilities because no palette
// offered repairs; the FTA administrative penalty filed under statutory fees.
// These are material-error class, not cosmetic, and under the 100%
// self-service model the owner's own correction is the only catch — so the
// answer is a PINNED eval plus the invoice handed to the model, never a rule
// (CLAUDE.md: trust the strong LLM; the goldset is how a model change is
// scored, not how a verdict is forced).
//
// Same shape as bankLineDispositionGoldSet.js / intentCompilerGoldSet.js: the fixtures
// and the deterministic scorer live here (CI-tested, no network); the real-
// model runner is scripts/run_coding_goldset.js (never CI — K real coder
// calls per fixture, the same suggestTransactionCoding call path production
// uses with the AE client profile, so a gold run scores exactly the
// production observation). The runner reports STABILITY: a fixture passes
// only when every one of its K runs passes — a treatment that is right four
// times in five is the flip-flop this set exists to catch.
//
// Expectation vocabulary (null = not asserted):
//   account_one_of   the proposed_account must be one of these palette names
//   tax              exact tax_treatment (AE vocabulary)
//   tax_one_of       allowed tax_treatment set
// Every fixture is MUST: a miss is a regression, never a soft score.

import { TAX_VOCABULARY_REGISTRY } from './taxVocabularyRegistry.js';
const { options: AE_VAT_TAX_TREATMENT_OPTIONS } = TAX_VOCABULARY_REGISTRY.ae;

export const CODING_GOLD_SET_AE_VERSION = 'coding_ae.v1-gold.1';

// The profile the runner codes under: a UAE VAT-registered café on Donna's
// own ledger, routed to the AE palette and the AE VAT vocabulary — the same
// markers resolveClientCodingPolicyWithClient stamps for a routed AE client.
export const AE_GOLD_CLIENT_PROFILE = Object.freeze({
  id: 'gold-ae-cafe',
  companyName: 'Desert Rose Café LLC',
  jurisdiction: 'ae',
  entityType: 'llc',
  accountingCurrency: 'AED',
  taxProfile: { vat_registered: true }
});

const STANDARD = 'VAT 5% (standard rated)';
const EXEMPT = 'Exempt supply';
const OUT_OF_SCOPE = 'Out of scope of UAE VAT';
const RCM = 'Reverse charge (RCM)';

const fixture = (f) => Object.freeze({
  ...f,
  input: Object.freeze({
    currency: 'AED',
    account_currency: 'AED',
    money_in: 0,
    money_out: 0,
    date: '2026-02-10',
    ...f.input
  }),
  expect: Object.freeze({ account_one_of: null, tax: null, tax_one_of: null, ...f.expect })
});

export const CODING_GOLD_FIXTURES_AE = Object.freeze([
  fixture({
    id: 'nol_topup_exempt',
    note: 'Flipped out-of-scope (Jan) → VAT 5% (Feb) on the same vendor. Local passenger transport is exempt; 5% would claim input VAT that does not exist.',
    input: { id: 'gold-nol', description: 'NOL TOP UP RTA DUBAI', money_out: 100 },
    expect: { account_one_of: ['Travel', 'Motor expenses'], tax: EXEMPT }
  }),
  fixture({
    id: 'netflix_registered_nonresident',
    note: 'Netflix charges UAE VAT as a registered non-resident e-services supplier; RCM is wrong.',
    input: { id: 'gold-netflix', description: 'NETFLIX.COM AMSTERDAM NL', money_out: 39.9 },
    expect: { account_one_of: ['Software subscriptions', 'Office expenses', 'Marketing', 'Meals and entertainment'], tax: STANDARD }
  }),
  fixture({
    id: 'zoho_invoice_shows_no_uae_vat',
    note: 'Read the invoice: the matched Zoho invoice carries no UAE VAT line — an imported service, so RCM is right here.',
    input: {
      id: 'gold-zoho-rcm',
      description: 'ZOHO CORPORATION PVT LTD',
      money_out: 250,
      matched_document: {
        match_status: 'auto_matched',
        document_type: 'supplier_bill',
        vendor_name: 'Zoho Corporation Pvt. Ltd.',
        document_date: '2026-02-08',
        total_amount: 250,
        currency: 'AED',
        lines: [
          { description: 'Zoho Books Professional — monthly subscription', amount: 250 },
          { description: 'VAT: not applicable — service supplied from outside the UAE', amount: 0 }
        ]
      }
    },
    expect: { account_one_of: ['Software subscriptions', 'Accounting fees'], tax: RCM }
  }),
  fixture({
    id: 'zoho_invoice_shows_uae_vat',
    note: 'Same vendor, but this invoice shows 5% UAE VAT charged — standard rated, not RCM. The invoice on file decides, never a vendor default.',
    input: {
      id: 'gold-zoho-std',
      description: 'ZOHO CORPORATION PVT LTD',
      money_out: 250,
      matched_document: {
        match_status: 'auto_matched',
        document_type: 'supplier_bill',
        vendor_name: 'Zoho Corporation Pvt. Ltd. (TRN 100XXXXXXXXXXXX)',
        document_date: '2026-02-08',
        total_amount: 250,
        currency: 'AED',
        lines: [
          { description: 'Zoho Books Professional — monthly subscription', amount: 238.1 },
          { description: 'UAE VAT 5%', amount: 11.9 }
        ]
      }
    },
    expect: { account_one_of: ['Software subscriptions', 'Accounting fees'], tax: STANDARD }
  }),
  fixture({
    id: 'ac_maintenance_repairs',
    note: 'Flipped Operating supplies (Jan) → Utilities (Feb); both wrong. Now that the palette offers Repairs and maintenance, that is the account.',
    input: { id: 'gold-ac', description: 'COOL BREEZE AC MAINTENANCE LLC', money_out: 520 },
    expect: { account_one_of: ['Repairs and maintenance'], tax: STANDARD }
  }),
  fixture({
    id: 'insurance_standard_rated',
    note: 'Sukoon/Oman Insurance was the earlier flip-flopper; general insurance premiums are standard rated.',
    input: { id: 'gold-sukoon', description: 'SUKOON INSURANCE PJSC PREMIUM', money_out: 1800 },
    expect: { account_one_of: ['Insurance'], tax: STANDARD }
  }),
  fixture({
    id: 'fta_penalty_own_account',
    note: 'An FTA administrative penalty is non-deductible for CT and out of scope of VAT; it belongs in Fines and penalties, never in statutory fees.',
    input: { id: 'gold-fta-penalty', description: 'FEDERAL TAX AUTHORITY ADMINISTRATIVE PENALTY', money_out: 1000 },
    expect: { account_one_of: ['Fines and penalties'], tax: OUT_OF_SCOPE }
  }),
  fixture({
    id: 'fta_vat_return_payment',
    note: 'Control: a VAT return payment clears the VAT liability; not an expense, out of scope.',
    input: { id: 'gold-fta-vat', description: 'FEDERAL TAX AUTHORITY VAT PAYMENT 100XXXXXXXXXXXX', money_out: 4320 },
    expect: { account_one_of: ['VAT payable'], tax: OUT_OF_SCOPE }
  }),
  fixture({
    id: 'rent_standard_rated',
    note: 'Control (stable on the real book): commercial rent, 5%.',
    input: { id: 'gold-rent', description: 'AL WASL PROPERTIES LLC RENT FEB 2026', money_out: 8500 },
    expect: { account_one_of: ['Rent'], tax: STANDARD }
  }),
  fixture({
    id: 'dewa_utilities',
    note: 'Control (stable on the real book): DEWA, 5%.',
    input: { id: 'gold-dewa', description: 'DEWA BILL PAYMENT 2026020012345', money_out: 1240 },
    expect: { account_one_of: ['Utilities'], tax: STANDARD }
  }),
  fixture({
    id: 'wps_payroll_out_of_scope',
    note: 'Control (stable on the real book): WPS salary transfer, out of scope.',
    input: { id: 'gold-wps', description: 'WPS SALARY TRANSFER FEB 2026', money_out: 12000 },
    expect: { account_one_of: ['Payroll'], tax: OUT_OF_SCOPE }
  })
]);

// Lint: every asserted name/treatment must be one the routed AE coder can
// actually emit — an expectation naming an account the palette lacks is a
// gold-set bug, not a model miss. `paletteNames` is injected so this module
// stays a pure leaf (the pack loader lives in outbound/packs.js).
export const codingGoldSetAeLintErrors = ({ paletteNames = [] } = {}) => {
  const errors = [];
  const ids = new Set();
  const palette = new Set(paletteNames.map((n) => String(n).trim().toLowerCase()));
  const treatments = new Set(AE_VAT_TAX_TREATMENT_OPTIONS);
  for (const f of CODING_GOLD_FIXTURES_AE) {
    if (ids.has(f.id)) errors.push(`${f.id}: duplicate id`);
    ids.add(f.id);
    if (!f.input.description) errors.push(`${f.id}: input.description required`);
    if (!(f.input.money_out > 0 || f.input.money_in > 0)) errors.push(`${f.id}: needs a non-zero amount`);
    if (!Array.isArray(f.expect.account_one_of) || !f.expect.account_one_of.length) errors.push(`${f.id}: expect.account_one_of required`);
    for (const name of f.expect.account_one_of || []) {
      if (palette.size && !palette.has(String(name).trim().toLowerCase())) errors.push(`${f.id}: account "${name}" is not in the AE palette`);
    }
    if (f.expect.tax == null && !Array.isArray(f.expect.tax_one_of)) errors.push(`${f.id}: expect.tax or expect.tax_one_of required`);
    for (const t of [f.expect.tax, ...(f.expect.tax_one_of || [])].filter((x) => x != null)) {
      if (!treatments.has(t)) errors.push(`${f.id}: tax treatment "${t}" is not in the AE vocabulary`);
    }
  }
  return errors;
};

// Score ONE coder suggestion (the sanitized production shape) against a
// fixture. Both checks are MUST.
export const scoreCodingGoldFixture = ({ suggestion, fixture: f }) => {
  const s = suggestion && typeof suggestion === 'object' ? suggestion : null;
  const account = s ? String(s.proposed_account || '') : '';
  const tax = s ? String(s.tax_treatment || '') : '';
  const accountPass = Boolean(s) && (f.expect.account_one_of || []).includes(account);
  const taxPass = Boolean(s) && (
    (f.expect.tax != null && tax === f.expect.tax)
    || (Array.isArray(f.expect.tax_one_of) && f.expect.tax_one_of.includes(tax))
  );
  return {
    fixture_id: f.id,
    pass: accountPass && taxPass,
    checks: {
      account: { pass: accountPass, actual: account, expected: f.expect.account_one_of },
      tax: { pass: taxPass, actual: tax, expected: f.expect.tax ?? f.expect.tax_one_of }
    },
    confidence: s ? String(s.confidence || '') : '',
    evidence_required: s ? Boolean(s.evidence_required) : null,
    model: s ? String(s.model || '') : ''
  };
};

// Per-fixture stability across K runs. A fixture is STABLE when every run
// produced the same (account, tax) pair, and PASSES only when every run
// passed — the gate is zero flips, not a pass rate.
export const summarizeCodingGoldRuns = (scoredRuns = []) => {
  const byFixture = new Map();
  for (const score of scoredRuns) {
    if (!byFixture.has(score.fixture_id)) byFixture.set(score.fixture_id, []);
    byFixture.get(score.fixture_id).push(score);
  }
  const fixtures = [...byFixture.entries()].map(([fixtureId, runs]) => {
    const pairs = runs.map((r) => `${r.checks.account.actual}|${r.checks.tax.actual}`);
    const distinct = [...new Set(pairs)];
    const passed = runs.filter((r) => r.pass).length;
    return {
      fixture_id: fixtureId,
      runs: runs.length,
      passed,
      pass_rate: runs.length ? passed / runs.length : 0,
      stable: distinct.length <= 1,
      distinct_verdicts: distinct,
      pass: runs.length > 0 && passed === runs.length
    };
  });
  const models = [...new Set(scoredRuns.map((r) => r.model).filter(Boolean))];
  return {
    fixtures,
    fixture_count: fixtures.length,
    passing_fixtures: fixtures.filter((f) => f.pass).length,
    unstable_fixtures: fixtures.filter((f) => !f.stable).map((f) => f.fixture_id),
    failing_fixtures: fixtures.filter((f) => !f.pass).map((f) => f.fixture_id),
    models
  };
};

// The gate: every fixture passes every run, and every run proved its model
// id (the model-id-is-part-of-the-receipt rail — a run that cannot say which
// model answered is not evidence).
export const meetsCodingGoldThresholds = (summary) =>
  Boolean(summary)
  && summary.fixture_count > 0
  && summary.failing_fixtures.length === 0
  && summary.unstable_fixtures.length === 0
  && summary.models.length === 1;
