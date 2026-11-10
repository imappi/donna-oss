// The app's Settings resource: GET/POST /entities/{entityId}/settings.
//
// What each field is, and who owns it (nothing here decides a business fact):
//   - vat_period: the filing cadence the owner declares the tax authority gave
//     the business. Finland: clients.profile.verokausi, written through the
//     client-profile route (POST /clients/:id/profile → updateClientProfileInDb,
//     the profile's named writer, which commits its own client.profile.update
//     audit row). Read falls back to the ALV registration record's tax_period
//     when no verokausi is recorded (the web company-details form reads both).
//     UK: the HMRC VAT stagger under profile.gb is a quarterly stagger by
//     definition, so a recorded stagger reads `quarter`; it cannot be declared
//     from the phone (the stagger number is the fact, not the cadence).
//     Unknown stays null — never inferred from legal form or turnover, and NOT
//     the ALV engine's monthly default (verokausiCadenceForProfile).
//   - financial_year: the persisted fiscal_years rows, through the owner's
//     existing route GET /clients/:id/fiscal-periods. Missing is null; the
//     calendar projection (calendarFiscalPeriod) is not persisted data.
//   - notifications: the owner's own switches (migration 167). No row ⇒ the
//     product default below.
//   - notification_delivery: `not_configured` — no push sender exists.
//   - phone_number: the owner's own verified WhatsApp/SMS binding, in clear.
import { mobileError } from './mobileAuth.js';
import { projectReceipt } from './mobileProjection.js';
import { readAuditRowsSince, readAuditWatermark } from './mobileReads.js';
import {
  readLiveAlvReturns,
  readNotificationPreferences,
  readOwnerPhoneNumber,
  readSettingsClientFacts,
  saveNotificationPreferences
} from './mobileSettingsDb.js';
import { toUtcIsoDay } from '../dates.js';

export const VAT_PERIODS = Object.freeze(['month', 'quarter', 'year']);
export const NOTIFICATION_KEYS = Object.freeze(['needs_you', 'due_dates', 'monthly_summary', 'every_receipt']);
// PRODUCT DEFAULT (the app's reference mock): what the switches show before the
// owner has saved anything. It is not a stored choice and nothing acts on it.
export const NOTIFICATION_DEFAULTS = Object.freeze({ needs_you: true, due_dates: true, monthly_summary: false, every_receipt: false });

// The profile writer's own vocabulary (finland/profileValidation.js verokausi
// and alvRegistration.js TAX_PERIOD_ALIASES), read-side only.
const CADENCE_ALIASES = Object.freeze({
  month: 'month', monthly: 'month', kuukausi: 'month',
  quarter: 'quarter', quarterly: 'quarter', neljannes: 'quarter', 'neljännes': 'quarter',
  year: 'year', yearly: 'year', annual: 'year', annually: 'year', vuosi: 'year'
});
const cadence = (value) => CADENCE_ALIASES[String(value ?? '').trim().toLowerCase()] || null;
const countryOf = (facts) => String(facts?.jurisdiction || '').trim().toUpperCase();

// ── Pure projections ──────────────────────────────────────────────────────

export const projectVatPeriod = (facts) => {
  if (!facts) return null;
  const country = countryOf(facts);
  if (country === 'FI') return cadence(facts.verokausi) || cadence(facts.alv_tax_period);
  if (country === 'GB') return ['1', '2', '3'].includes(String(facts.gb_vat_stagger ?? '')) ? 'quarter' : null;
  return null;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const formatDay = (day, locale) => {
  const date = new Date(`${day}T00:00:00Z`);
  if (locale === 'fi') return `${date.getUTCDate()}.${date.getUTCMonth() + 1}.${date.getUTCFullYear()}`;
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date);
};
const formatRange = (period, locale) => `${formatDay(period.starts_on, locale)}–${formatDay(period.ends_on, locale)}`;
const STATEMENT_STATE = Object.freeze({
  en: { closed: 'closed', closing: 'being closed', open: 'not closed yet' },
  fi: { closed: 'suljettu', closing: 'sulkeminen kesken', open: 'ei vielä suljettu' }
});

// current: the persisted year that contains today. first: the earliest
// persisted year, only when it starts on the recorded incorporation date (a
// book adopted mid-life has an earlier first year Donna never recorded).
// statements: the latest persisted year that has ended, with its close state.
export const projectFinancialYear = ({ periods = [], incorporationDate = null, today, locale = 'en' }) => {
  const rows = periods
    .filter((row) => DAY.test(String(row?.starts_on || '')) && DAY.test(String(row?.ends_on || '')))
    .sort((a, b) => a.starts_on.localeCompare(b.starts_on));
  const current = rows.find((row) => row.starts_on <= today && today <= row.ends_on) || null;
  const first = rows[0] && DAY.test(String(incorporationDate || '')) && rows[0].starts_on === incorporationDate ? rows[0] : null;
  const ended = rows.filter((row) => row.ends_on < today).at(-1) || null;
  const words = STATEMENT_STATE[locale] || STATEMENT_STATE.en;
  return {
    current: current ? formatRange(current, locale) : null,
    first: first ? formatRange(first, locale) : null,
    statements: ended && words[ended.status] ? `${formatRange(ended, locale)}: ${words[ended.status]}` : null
  };
};

export const projectSettings = ({ facts, periods, preferences, phoneNumber, today, locale }) => ({
  source: 'backend',
  vat_period: projectVatPeriod(facts),
  notifications: preferences
    ? Object.fromEntries(NOTIFICATION_KEYS.map((key) => [key, preferences[key] === true]))
    : { ...NOTIFICATION_DEFAULTS },
  notification_delivery: 'not_configured',
  phone_number: phoneNumber || null,
  financial_year: projectFinancialYear({
    periods,
    incorporationDate: facts?.incorporation_date || facts?.profile_incorporation_date || null,
    today,
    locale
  })
});

// The contract's closed request shapes (MobileSettingsAction). Anything else is
// a 400, exactly as the reference mock refuses it.
export const validateSettingsAction = (body) => {
  const invalid = (message) => mobileError(400, 'SETTINGS_INVALID', message);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('The settings action must be an object.');
  if (body.type === 'set_vat_period') {
    if (Object.keys(body).some((key) => !['type', 'vat_period'].includes(key))) throw invalid('set_vat_period takes only vat_period.');
    if (!VAT_PERIODS.includes(body.vat_period)) throw invalid('vat_period must be one of month, quarter, year.');
    return { type: body.type, vat_period: body.vat_period };
  }
  if (body.type === 'set_notifications') {
    if (Object.keys(body).some((key) => !['type', 'notifications'].includes(key))) throw invalid('set_notifications takes only notifications.');
    const prefs = body.notifications;
    if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)
      || Object.keys(prefs).length !== NOTIFICATION_KEYS.length
      || NOTIFICATION_KEYS.some((key) => typeof prefs[key] !== 'boolean')) {
      throw invalid(`notifications must carry exactly ${NOTIFICATION_KEYS.join(', ')} as true or false.`);
    }
    return { type: body.type, notifications: Object.fromEntries(NOTIFICATION_KEYS.map((key) => [key, prefs[key]])) };
  }
  throw invalid('type must be set_vat_period or set_notifications.');
};

// ── Reads ─────────────────────────────────────────────────────────────────

const routeFailure = (response, fallback) => mobileError(
  response.status >= 400 ? response.status : 502,
  response.body?.code || fallback,
  response.body?.error || 'Donna could not complete this request.'
);

const readFiscalPeriods = async (ctx) => {
  const routed = await ctx.dispatch({ path: `/clients/${encodeURIComponent(ctx.clientId)}/fiscal-periods`, query: { firm_id: ctx.firmId } });
  if (routed.status < 200 || routed.status >= 300) throw routeFailure(routed, 'FISCAL_YEAR_READ_FAILED');
  return Array.isArray(routed.body?.periods) ? routed.body.periods : [];
};

export const readMobileSettings = async (ctx, { now = new Date() } = {}) => {
  const principalId = ctx.principal.principalId;
  const [facts, periods, preferences, phoneNumber] = await Promise.all([
    readSettingsClientFacts({ firmId: ctx.firmId, clientId: ctx.clientId }),
    readFiscalPeriods(ctx),
    readNotificationPreferences({ firmId: ctx.firmId, clientId: ctx.clientId, principalId }),
    readOwnerPhoneNumber({ firmId: ctx.firmId, clientId: ctx.clientId, principalId })
  ]);
  if (!facts) throw mobileError(404, 'NOT_FOUND', 'No such business in this account.');
  return projectSettings({ facts, periods, preferences, phoneNumber, today: toUtcIsoDay(now), locale: ctx.locale });
};

// ── Writes ────────────────────────────────────────────────────────────────

const COPY = Object.freeze({
  en: {
    vatSaved: (p) => `VAT period saved as ${{ month: 'monthly', quarter: 'quarterly', year: 'yearly' }[p]}. This records what the Tax Administration has told you; it does not change their records or file anything.`,
    vatSame: 'Your VAT period was already set to this. Nothing changed.',
    prefsSaved: 'Notification choices saved. This server does not send phone notifications yet.',
    prefsSame: 'Your notification choices were already saved. Nothing changed.'
  },
  fi: {
    vatSaved: (p) => `Verokausi tallennettu: ${{ month: 'kuukausi', quarter: 'neljännesvuosi', year: 'vuosi' }[p]}. Tämä kirjaa Verohallinnon sinulle ilmoittaman verokauden; se ei muuta Verohallinnon tietoja eikä lähetä ilmoituksia.`,
    vatSame: 'Verokausi oli jo tämä. Mitään ei muutettu.',
    prefsSaved: 'Ilmoitusvalinnat tallennettu. Tämä palvelin ei vielä lähetä ilmoituksia puhelimeen.',
    prefsSame: 'Ilmoitusvalinnat olivat jo tallessa. Mitään ei muutettu.'
  }
});
const copyFor = (ctx) => COPY[ctx.locale] || COPY.en;

const unchanged = async (ctx, target, summary) => ({
  settings: await readMobileSettings(ctx),
  receipt: projectReceipt({ summary, targets: [{ target, applied: false }], auditRows: [] })
});

const setVatPeriod = async (ctx, requested) => {
  const facts = await readSettingsClientFacts({ firmId: ctx.firmId, clientId: ctx.clientId });
  if (!facts) throw mobileError(404, 'NOT_FOUND', 'No such business in this account.');
  const country = countryOf(facts);
  if (country === 'GB') {
    if (projectVatPeriod(facts) === requested) return unchanged(ctx, 'vat_period', copyFor(ctx).vatSame);
    throw mobileError(409, 'VAT_PERIOD_FROM_HMRC_STAGGER',
      'For a UK business Donna takes the VAT period from the HMRC VAT stagger in your filing details. Ask your accountant to update it.');
  }
  if (country !== 'FI') {
    throw mobileError(409, 'VAT_PERIOD_NOT_SUPPORTED', 'Donna cannot record a VAT period for a business in this country yet.');
  }
  if (cadence(facts.verokausi) === requested) return unchanged(ctx, 'vat_period', copyFor(ctx).vatSame);
  // History guard. A pending or filed ALV return was prepared on the cadence in
  // force; the draft writer's uniqueness is per period key, not per date range,
  // so switching cadence now could let a new return overlap one already filed.
  const live = await readLiveAlvReturns({ firmId: ctx.firmId, clientId: ctx.clientId });
  if (live.some((row) => row.period_type !== requested)) {
    throw mobileError(409, 'VAT_PERIOD_IN_USE',
      'Donna has already prepared or filed a VAT return on your current VAT period, so it cannot be changed here. Ask your accountant to change it.');
  }
  const watermark = await readAuditWatermark({ firmId: ctx.firmId });
  const routed = await ctx.dispatch({
    method: 'POST',
    path: `/clients/${encodeURIComponent(ctx.clientId)}/profile`,
    body: { firm_id: ctx.firmId, profile_patch: { verokausi: requested } }
  });
  if (routed.status < 200 || routed.status >= 300) throw routeFailure(routed, 'VAT_PERIOD_SAVE_FAILED');
  const actors = new Set([ctx.principal.principalId, ctx.principal.userId, ctx.principal.email].filter(Boolean));
  const auditRows = (await readAuditRowsSince({ firmId: ctx.firmId, clientId: ctx.clientId, watermark, resourceIds: [ctx.clientId] }))
    .filter((row) => row.action === 'client.profile.update' && row.resource_type === 'client' && actors.has(row.actor_id));
  if (!auditRows.length) throw mobileError(502, 'RECEIPT_MISSING', 'Donna saved the VAT period but returned no receipt.');
  return {
    settings: await readMobileSettings(ctx),
    receipt: projectReceipt({ summary: copyFor(ctx).vatSaved(requested), targets: [{ target: 'vat_period', applied: true }], auditRows })
  };
};

const setNotifications = async (ctx, preferences) => {
  const saved = await saveNotificationPreferences({
    firmId: ctx.firmId, clientId: ctx.clientId, principalId: ctx.principal.principalId, preferences
  });
  if (!saved.applied) return unchanged(ctx, 'notifications', copyFor(ctx).prefsSame);
  return {
    settings: await readMobileSettings(ctx),
    receipt: projectReceipt({ summary: copyFor(ctx).prefsSaved, targets: [{ target: 'notifications', applied: true }], auditRows: saved.auditRows })
  };
};

export const updateMobileSettings = async (ctx, body) => {
  const action = validateSettingsAction(body);
  return action.type === 'set_vat_period' ? setVatPeriod(ctx, action.vat_period) : setNotifications(ctx, action.notifications);
};
