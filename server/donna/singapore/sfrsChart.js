// SG native reference, authored once in the pack; no seed or coding activation.
// Product data with qualified accounting review still pending. Existing public
// five-field rows and pure builders are compatibility projections only: their
// boolean/default arguments never establish a client's GST registration.
// Keep this reader outside loadOutboundPack / country-policy initialization.
import { readFileSync } from 'node:fs';
import { nativeChartForPack, selectNativeChartForPack } from '../outbound/nativeChart.js';

const pack = JSON.parse(readFileSync(new URL('../../../packs/sg/manifest.json', import.meta.url), 'utf8'));
if (pack.pack?.id !== 'sg') throw new Error('Singapore reference requires the SG pack');
const native = nativeChartForPack(pack);
if (!native || native.id !== 'sg_sfrs_reference') throw new Error('Singapore native chart reference unavailable');
// The shared schema allows country-authored set names. This projection requires
// these specific bindings: Set(undefined) would otherwise silently drop controls.
for (const [field, names] of Object.entries({
  account_sets: ['base', 'sole_proprietor_equity', 'llp_equity'],
  code_sets: ['gst_control'],
  group_sets: ['pte_ltd_only']
})) {
  for (const name of names) {
    if (!Object.hasOwn(native[field], name)) throw new Error(`Singapore native chart requires ${field}.${name}`);
  }
}
const rows = entries => entries.map(({ canonical_role, ...account }) => account);

export const readSgNativeChartReference = () => structuredClone(native);

export const SG_STATUTORY_GROUPS = native.reporting_groups;
export const SFRS_CHART = rows(native.account_sets.base);
export const SOLE_PROP_EQUITY_ACCOUNTS = rows(native.account_sets.sole_proprietor_equity);
export const LLP_EQUITY_ACCOUNTS = rows(native.account_sets.llp_equity);
export const PTE_LTD_ONLY_STATUTORY_GROUPS = new Set(native.group_sets.pte_ltd_only);
export const GST_ACCOUNT_CODES = new Set(native.code_sets.gst_control);

// Company-only equity groups excluded from a sole-prop / LLP chart; their
// result flows to the capital / partners' accounts instead.
const COMPANY_ONLY_EQUITY_GROUPS = new Set(['share_capital', 'retained_earnings', 'dividends_payable']);
const COMPANY_ONLY_RELATED_PARTY_GROUPS = new Set(['director_loan_receivable', 'director_loan_payable']);

// buildSoleProprietorChart({ gstRegistered }) — the sole-proprietor account list
// derived from the shared base: drop company-only equity + director balances,
// add the capital-account equity, and (when not GST-registered) drop the
// dormant GST accounts. Pure; returns a new array, never mutates SFRS_CHART.
export const buildSoleProprietorChart = ({ gstRegistered = false } = {}) => {
  const base = SFRS_CHART.filter((e) => {
    if (COMPANY_ONLY_EQUITY_GROUPS.has(e.statutory_group)) return false;
    if (COMPANY_ONLY_RELATED_PARTY_GROUPS.has(e.statutory_group)) return false;
    if (e.statutory_group === 'income_tax_payable' || e.statutory_group === 'income_taxes') return false; // sole-prop income is taxed on the OWNER (personal), not the business
    if (!gstRegistered && GST_ACCOUNT_CODES.has(e.code)) return false;
    return true;
  });
  return [...base, ...SOLE_PROP_EQUITY_ACCOUNTS];
};

// buildLlpChart({ gstRegistered }) — the LLP account list: like the sole-prop
// chart (LLP income is taxed on the PARTNERS, not the entity) but with partner
// equity instead of the owner's capital account, and the related-party balance
// lines kept (partners are the related parties).
export const buildLlpChart = ({ gstRegistered = false } = {}) => {
  const base = SFRS_CHART.filter((e) => {
    if (COMPANY_ONLY_EQUITY_GROUPS.has(e.statutory_group)) return false;
    if (e.statutory_group === 'income_tax_payable' || e.statutory_group === 'income_taxes') return false;
    if (!gstRegistered && GST_ACCOUNT_CODES.has(e.code)) return false;
    return true;
  });
  return [...base, ...LLP_EQUITY_ACCOUNTS];
};

// buildPteLtdChart({ gstRegistered }) — the private-limited-company account
// list: the shared base as-is (it already carries the company equity, director
// balances, and income-tax lines). `gstRegistered` defaults true (a Pte Ltd at
// Donna's ICP is ordinarily GST-registered or registering) but a non-registered
// company drops the dormant GST accounts, same rule as the other charts.
export const buildPteLtdChart = ({ gstRegistered = true } = {}) => {
  return SFRS_CHART.filter((e) => {
    if (!gstRegistered && GST_ACCOUNT_CODES.has(e.code)) return false;
    return true;
  });
};

// O(1) lookup by code. Built once at module load.
const BY_CODE = new Map(SFRS_CHART.map((entry) => [entry.code, entry]));

// resolveSgAccount(code) — return the chart entry for an account number, or null.
// Pure; never throws on a miss (a miss = "not a standard SG chart account",
// which the caller decides how to handle — it is not an error here).
export const resolveSgAccount = (code) => {
  if (code === null || code === undefined) return null;
  return BY_CODE.get(String(code).trim()) || null;
};

// resolveSgStatutoryGroup(key) — return the SFRS statement-line descriptor, or null.
export const resolveSgStatutoryGroup = (key) => SG_STATUTORY_GROUPS[key] || null;

// The set of valid statutory-group keys (for validation by callers/tests).
export const SG_STATUTORY_GROUP_KEYS = new Set(Object.keys(SG_STATUTORY_GROUPS));

// Explicit, provisional product-data projection; no production caller selects
// it at birth or coding. Identity must already be canonical, never defaulted.
export const selectSgProvisionalChart = ({ jurisdiction, legalForm } = {}) => {
  const selection = native.selections?.sg_pte_provisional;
  if (!selection) throw new TypeError('Native chart selection unavailable');
  if (selection.jurisdiction !== 'sg' || selection.legal_form !== 'sg-pte' ||
      selection.account_sets.length !== 2 || selection.account_sets[0] !== 'base' ||
      selection.account_sets[1] !== 'pte_launch_extensions') {
    throw new TypeError('Singapore provisional chart requires its Pte base and extension composition');
  }
  // Country-owned binding checks, like the compatibility projection above.
  // Reuse authored control codes/groups; do not duplicate the chart or infer
  // transaction tax treatment. Missing/partial reservations cannot become an
  // ordinary account choice just because the generic schema is still valid.
  const expectedReservations = {
    gst_control: native.code_sets.gst_control,
    period_close: native.account_sets.base.filter(row => row.statutory_group === 'profit_for_year').map(row => row.code),
    tax_classified_revenue: native.account_sets.base.filter(row => row.statutory_group === 'revenue').map(row => row.code)
  };
  for (const [use, expected] of Object.entries(expectedReservations)) {
    const actual = selection.reserved_uses[use];
    if (!expected.length || !actual || actual.length !== expected.length || expected.some(code => !actual.includes(code))) {
      throw new TypeError(`Singapore provisional chart requires reserved_uses.${use} to match its reference binding`);
    }
  }
  return selectNativeChartForPack(pack, { selectionId: 'sg_pte_provisional', jurisdiction, legalForm });
};
