// Accounting view is independent of cash/accrual method. Keep historical profile
// bytes; interpret legacy view homes only when no explicit view was supplied.
export const ACCOUNTING_PROFILE_CONTRACT_VERSION = 'donna.accounting-profile.v1';
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const clean = (value) => typeof value === 'string' ? value.trim().toLowerCase() : value;
const VIEWS = ['management_books', 'statutory_books'];
const METHODS = ['cash', 'accrual'];
const VIEW_KEYS = ['accounting_view', 'accountingView'];
const METHOD_KEYS = ['accountingBasis', 'accounting_basis'];
export const ACCOUNTING_PROFILE_KEYS = [...VIEW_KEYS, ...METHOD_KEYS, 'bookBasis'];
export const hasAccountingProfilePatch = (profile) => ACCOUNTING_PROFILE_KEYS.some((key) => own(profile, key));
const legacyView = (profile, key) => own(profile, key) && VIEWS.includes(clean(profile[key]));
const resolve = (profile, keys, choices, defaultValue) => {
  const supplied = keys.filter((key) => own(profile, key));
  if (!supplied.length) return { value: defaultValue, status: 'unspecified', sources: [] };
  const values = supplied.map((key) => clean(profile[key]));
  if (new Set(values).size > 1) return { value: null, status: 'conflicting', sources: supplied };
  return { value: choices.includes(values[0]) ? values[0] : null,
    status: choices.includes(values[0]) ? 'stated' : 'unknown', sources: supplied };
};
export const readAccountingProfile = (profile = {}) => {
  const explicitView = VIEW_KEYS.some((key) => own(profile, key));
  const viewKeys = explicitView ? VIEW_KEYS : [
    ...(own(profile, 'bookBasis') ? ['bookBasis'] : []),
    ...(legacyView(profile, 'accounting_basis') ? ['accounting_basis'] : [])
  ];
  const methodKeys = METHOD_KEYS.filter((key) => !(key === 'accounting_basis' && legacyView(profile, key)));
  return {
    contract_version: ACCOUNTING_PROFILE_CONTRACT_VERSION,
    view: resolve(profile, viewKeys, VIEWS, 'management_books'),
    method: resolve(profile, methodKeys, METHODS, null)
  };
};
export class AccountingProfileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AccountingProfileError';
    this.code = code;
    this.statusCode = 422;
    this.details = { recovery: 'update_client_profile', fields: { accounting_view: VIEWS, accountingBasis: METHODS } };
  }
}
export const normalizeAccountingProfilePatch = (patch, stored = {}) => {
  const out = { ...patch };
  for (const key of ACCOUNTING_PROFILE_KEYS.filter((key) => own(patch, key))) {
    const value = clean(patch[key]);
    const choices = VIEW_KEYS.includes(key) || key === 'bookBasis' ? VIEWS
      : key === 'accounting_basis' ? [...METHODS, ...VIEWS] : METHODS;
    if (value !== null && value !== 'unknown' && !choices.includes(value)) {
      throw new AccountingProfileError('ACCOUNTING_PROFILE_INVALID', `${key} must be ${choices.join(' or ')}, or null when unknown.`);
    }
    out[key] = value;
  }
  // The legacy snake-case slot historically held either axis. Reusing it
  // cannot erase the previous declaration on the other axis. Promote only the
  // otherwise-lost fact; explicit modern homes (including null) always win.
  if (own(out, 'accounting_basis') && own(stored, 'accounting_basis')) {
    const previous = clean(stored.accounting_basis);
    const next = out.accounting_basis;
    if (VIEWS.includes(previous) && !VIEWS.includes(next)
        && !VIEW_KEYS.some((key) => own(out, key) || own(stored, key))) {
      const priorView = readAccountingProfile(stored).view;
      if (next !== null && next !== 'unknown' && ['unknown', 'conflicting'].includes(priorView.status)) {
        throw new AccountingProfileError('ACCOUNTING_PROFILE_CONFLICT', 'The previous accounting view is unresolved. State accounting_view explicitly when changing the legacy field to a method.');
      }
      out.accounting_view = next === null || next === 'unknown' ? null : priorView.value;
    }
    if (METHODS.includes(previous) && VIEWS.includes(next) && !own(out, 'accountingBasis')) {
      const priorMethod = readAccountingProfile(stored).method;
      if (['unknown', 'conflicting'].includes(priorMethod.status)) {
        throw new AccountingProfileError('ACCOUNTING_PROFILE_CONFLICT', 'The previous accounting method is unresolved. State accountingBasis explicitly when changing the legacy field to a view.');
      }
      if (!own(stored, 'accountingBasis')) out.accountingBasis = priorMethod.value;
    }
  }
  const requested = readAccountingProfile(out);
  for (const axis of ['view', 'method']) {
    if (requested[axis].status === 'conflicting') {
      throw new AccountingProfileError('ACCOUNTING_PROFILE_CONFLICT', `Conflicting accounting ${axis} fields. Supply one consistent ${axis}.`);
    }
  }
  // Correct existing duplicate authoritative homes without adding absent aliases.
  // Explicit view eclipses legacy view homes; legacy bytes remain provenance.
  for (const keys of [VIEW_KEYS, METHOD_KEYS]) {
    const changed = keys.filter((key) => own(out, key) && !(key === 'accounting_basis' && legacyView(out, key)));
    if (!changed.length) continue;
    for (const key of keys) {
      if (!own(out, key) && own(stored, key) && !(key === 'accounting_basis' && legacyView(stored, key))) out[key] = out[changed[0]];
    }
  }
  return out;
};
export const accountingProfileFailures = (profile) => {
  const { view, method } = readAccountingProfile(profile);
  return [
    ...(view.status === 'unknown' || view.status === 'conflicting' ? [`accounting_view_${view.status}`] : []),
    ...(view.value === 'statutory_books' ? ['accounting_view_unsupported'] : []),
    ...(method.status === 'unknown' || method.status === 'conflicting' ? [`accounting_method_${method.status}`] : [])
  ];
};

export const ACCOUNTING_ADMISSION_CONTRACT = Object.freeze({
  version: ACCOUNTING_PROFILE_CONTRACT_VERSION,
  scope: 'technical_entity_birth_readiness',
  admitted_views: ['management_books'],
  permitted_method_declarations: ['cash', 'accrual'],
  unspecified_method: 'not_asserted',
  certifies_complete_books: false,
  certifies_statutory_service: false,
  statutory_dependencies: ['U02_opening_intake', 'U08_native_tax_posting', 'U10_U11_VAT_delivery', 'U13_CT_delivery', 'U19_U20_close_and_annual_outputs', 'U26_retention', 'D01_customer_scope', 'D05_provider_authority']
});
export const accountingProfileRecovery = (code) => {
  if (code === 'accounting_view_unsupported') return {
    label: 'Requested accounting view is unavailable',
    detail: 'Statutory books are not admitted by this runtime. Required opening, tax, close, filing and retention capabilities and service authority remain unproven. Management books are a separate, narrower choice; change the profile only if that is your intended scope.',
    recovery: 'update_client_profile',
    responsibility: 'accounting_setup'
  };
  if (/^accounting_(view|method)_(unknown|conflicting)$/.test(code || '')) return {
    label: 'Accounting setup needs a choice',
    detail: 'Record a consistent accounting view (management or statutory books) separately from the cash or accrual method in the client profile, then retry readiness.',
    recovery: 'update_client_profile',
    responsibility: 'accounting_setup'
  };
  return null;
};

export const ACCOUNTING_CURRENCY_KEYS = ['currency', 'accountingCurrency', 'baseCurrency', 'defaultCurrency', 'default_currency'];
export const readAccountingCurrency = (profile = {}, { defaultCurrency = null } = {}) => {
  const sources = ACCOUNTING_CURRENCY_KEYS.filter((key) => own(profile, key));
  if (!sources.length) return { value: defaultCurrency, status: 'unspecified', sources };
  const values = sources.map((key) => typeof profile[key] === 'string' ? profile[key].trim().toUpperCase() : null);
  if (new Set(values).size > 1) return { value: null, status: 'conflicting', sources };
  const value = /^[A-Z]{3}$/.test(values[0] || '') && values[0] !== 'UNK' ? values[0] : null;
  return { value, status: value ? 'stated' : 'unknown', sources };
};
