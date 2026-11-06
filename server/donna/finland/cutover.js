// G-10 (FI-15) — the fuller cutover pack for a Finnish switcher. Design:
// docs/design-donna-finland-fi15-g10-g14-p2-batch.md (D-P2-4/D-P2-5).
//
// FI-6's avaava tase seeds AGGREGATE opening balances (balanced-or-refuse,
// idempotent per tilikausi). What it cannot carry is the itemized/tax-side
// cutover state: WHICH invoices make up the opening 1700/2870 balances, the
// EVL menojäännös tax bases behind the fixed-asset accounts, the confirmed
// prior losses (vahvistetut tappiot) Vero will deduct, the prior year's
// ACTUAL nettovarallisuus (which may legitimately differ from the opening
// tase book figure), and the outstanding ALV position at switch date.
//
// This module is RECORDED DATA + READ-TIME RECONCILIATION only (INV-1: no
// second writer — the avaava tase journal stays the only cutover ledger
// touch). Writes ride the validated profile-patch path
// (clientProfileSchema.js → normalizeCutoverProfile); consumption is
// deterministic reads: the annual return (nettovarallisuus override + losses
// + asset bases surfaced) and GET /reports/finland-cutover (the pack
// reconciled against the POSTED opening journal — mismatches SURFACED
// verbatim, never auto-corrected, never blocking; the correction path is
// fixing the record or FI-6's idempotent re-seed).

import { toUtcIsoDay } from '../dates.js';

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const dateOnly = (value) => {
  const raw = String(value || '').slice(0, 10);
  if (!ISO_DATE.test(raw)) return null;
  // toUtcIsoDay round-trips a bare day and refuses an impossible one
  // (2026-02-30 → '', never a rolled-over March 2).
  return toUtcIsoDay(raw) === raw ? raw : null;
};

const badRequest = (message) => {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
};

export const CUTOVER_FIXED_ASSET_CATEGORIES = Object.freeze([
  'machinery_and_equipment',
  'buildings',
  'other'
]);

// The opening-journal account codes each reconciliation keys on (the FI
// tilikartta): 1700 Myyntisaamiset · 2870 Ostovelat · 2939 Suoritettava ALV ·
// 1763 Arvonlisäverosaaminen · 1120/1180 tangible assets (net of accumulated
// depreciation). Kept here so the DB caller and the evaluator share one map.
export const CUTOVER_CONTROL_CODES = Object.freeze({
  receivables: ['1700'],
  payables: ['2870'],
  vat_payable: ['2939'],
  vat_receivable: ['1763'],
  fixed_assets: ['1000', '1030', '1120', '1180']
});

const MAX_ITEMS = 200;
const MAX_ABS_AMOUNT = 100000000;

const normalizeAmount = (value, { field, allowZero = false } = {}) => {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > MAX_ABS_AMOUNT || (!allowZero && amount === 0)) {
    throw badRequest(`${field} must be a positive number of euros.`);
  }
  return round2(amount);
};

const normalizeOpenItems = (value, { field }) => {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw badRequest(`${field} must be an array.`);
  if (value.length > MAX_ITEMS) throw badRequest(`${field} is limited to ${MAX_ITEMS} items.`);
  const out = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw badRequest(`Each ${field} item must be an object.`);
    }
    const counterparty = typeof raw.counterparty === 'string' ? raw.counterparty.trim().slice(0, 200) : '';
    if (!counterparty) throw badRequest(`Each ${field} item needs a counterparty.`);
    const item = {
      counterparty,
      amount_eur: normalizeAmount(raw.amount_eur, { field: `${field}.amount_eur` })
    };
    if (typeof raw.invoice_number === 'string' && raw.invoice_number.trim()) {
      item.invoice_number = raw.invoice_number.trim().slice(0, 60);
    }
    if (typeof raw.reference === 'string' && raw.reference.trim()) {
      item.reference = raw.reference.trim().slice(0, 60);
    }
    if (raw.issued_on !== undefined && raw.issued_on !== null) {
      const issuedOn = dateOnly(raw.issued_on);
      if (!issuedOn) throw badRequest(`${field}.issued_on must be an ISO date (YYYY-MM-DD).`);
      item.issued_on = issuedOn;
    }
    out.push(item);
  }
  return out.length ? out : undefined;
};

// normalizeCutoverProfile(value) — the validated write shape for
// profile.cutover (clientProfileSchema.js delegates here). Throws
// statusCode-400 errors on a bad shape; null clears. Every field except
// as_of is optional — the pack grows as the cutover facts arrive.
export const normalizeCutoverProfile = (value) => {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest('cutover must be an object or null.');
  }
  const asOf = dateOnly(value.as_of);
  if (!asOf) throw badRequest('cutover.as_of must be an ISO date (YYYY-MM-DD) — the cutover date the pack describes.');
  const out = { as_of: asOf };

  if (value.prior_year_net_worth_eur !== undefined && value.prior_year_net_worth_eur !== null) {
    out.prior_year_net_worth_eur = normalizeAmount(value.prior_year_net_worth_eur, {
      field: 'cutover.prior_year_net_worth_eur',
      allowZero: true
    });
  }

  if (value.confirmed_losses !== undefined && value.confirmed_losses !== null) {
    if (!Array.isArray(value.confirmed_losses)) throw badRequest('cutover.confirmed_losses must be an array.');
    if (value.confirmed_losses.length > 25) throw badRequest('cutover.confirmed_losses is limited to 25 items.');
    const losses = [];
    for (const raw of value.confirmed_losses) {
      if (!raw || typeof raw !== 'object') throw badRequest('Each confirmed loss must be an object.');
      const taxYear = Number(raw.tax_year);
      if (!Number.isInteger(taxYear) || taxYear < 2000 || taxYear > 2100) {
        throw badRequest('Each confirmed loss needs a four-digit tax_year.');
      }
      losses.push({
        tax_year: taxYear,
        amount_eur: normalizeAmount(raw.amount_eur, { field: 'confirmed_losses.amount_eur' })
      });
    }
    if (losses.length) out.confirmed_losses = losses.sort((a, b) => a.tax_year - b.tax_year);
  }

  if (value.fixed_assets !== undefined && value.fixed_assets !== null) {
    if (!Array.isArray(value.fixed_assets)) throw badRequest('cutover.fixed_assets must be an array.');
    if (value.fixed_assets.length > MAX_ITEMS) throw badRequest(`cutover.fixed_assets is limited to ${MAX_ITEMS} items.`);
    const assets = [];
    for (const raw of value.fixed_assets) {
      if (!raw || typeof raw !== 'object') throw badRequest('Each fixed asset must be an object.');
      const description = typeof raw.description === 'string' ? raw.description.trim().slice(0, 200) : '';
      if (!description) throw badRequest('Each fixed asset needs a description.');
      const category = String(raw.category || '').trim();
      if (!CUTOVER_FIXED_ASSET_CATEGORIES.includes(category)) {
        throw badRequest(`Fixed asset category must be one of: ${CUTOVER_FIXED_ASSET_CATEGORIES.join(', ')}.`);
      }
      assets.push({
        description,
        category,
        undepreciated_balance_eur: normalizeAmount(raw.undepreciated_balance_eur, {
          field: 'fixed_assets.undepreciated_balance_eur',
          allowZero: true
        })
      });
    }
    if (assets.length) out.fixed_assets = assets;
  }

  const receivables = normalizeOpenItems(value.open_receivables, { field: 'cutover.open_receivables' });
  if (receivables) out.open_receivables = receivables;
  const payables = normalizeOpenItems(value.open_payables, { field: 'cutover.open_payables' });
  if (payables) out.open_payables = payables;

  if (value.vat_opening !== undefined && value.vat_opening !== null) {
    const raw = value.vat_opening;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('cutover.vat_opening must be an object.');
    const vat = {};
    if (raw.payable_eur !== undefined && raw.payable_eur !== null) {
      vat.payable_eur = normalizeAmount(raw.payable_eur, { field: 'vat_opening.payable_eur', allowZero: true });
    }
    if (raw.receivable_eur !== undefined && raw.receivable_eur !== null) {
      vat.receivable_eur = normalizeAmount(raw.receivable_eur, { field: 'vat_opening.receivable_eur', allowZero: true });
    }
    if (!('payable_eur' in vat) && !('receivable_eur' in vat)) {
      throw badRequest('cutover.vat_opening needs payable_eur or receivable_eur.');
    }
    if (typeof raw.period_label === 'string' && raw.period_label.trim()) {
      vat.period_label = raw.period_label.trim().slice(0, 40);
    }
    out.vat_opening = vat;
  }

  if (typeof value.note === 'string' && value.note.trim()) out.note = value.note.trim().slice(0, 500);
  return out;
};

const EPSILON = 0.01;

const sum = (items = [], key) => round2(items.reduce((acc, item) => acc + (Number(item?.[key]) || 0), 0));

// Signed net across the given codes. A POSTED opening journal with no line on
// a control code means that balance is genuinely ZERO (the tase states the
// whole position) — so this returns 0, not null, when the journal exists;
// the "no journal at all" case is handled by the caller's hasJournal gate.
const netBalanceFor = (openingBalances, codes) => {
  if (!openingBalances || typeof openingBalances !== 'object') return null;
  let net = 0;
  for (const code of codes) {
    const value = Number(openingBalances[code]);
    if (Number.isFinite(value)) net = round2(net + value);
  }
  return net;
};

// evaluateCutoverPack({ cutover, openingBalances }) → the reconciliation
// verdict. `openingBalances` is the POSTED opening journal aggregated per
// account code as SIGNED net (debit − credit); null/absent means no opening
// journal is posted yet (checks report `unverified`, never guessed).
// Mismatch notes use closed codes and a 1-cent epsilon; the fixed-asset
// comparison is INFO always (tax base ≠ book value is legitimate — stated,
// not alarmed). Pure; never throws on garbage.
export const evaluateCutoverPack = ({ cutover = null, openingBalances = null } = {}) => {
  if (!cutover || typeof cutover !== 'object') {
    return { status: 'no_pack', checks: [], summary_fi: 'Cutover-pakettia ei ole kirjattu.' };
  }
  const checks = [];
  const hasJournal = openingBalances && typeof openingBalances === 'object' && Object.keys(openingBalances).length > 0;

  const compare = ({ code, label_fi, recorded, expected, info = false }) => {
    if (recorded === null || recorded === undefined) return;
    if (!hasJournal || expected === null) {
      checks.push({
        code,
        severity: 'unverified',
        label_fi,
        recorded_eur: round2(recorded),
        opening_journal_eur: null,
        note_fi: 'Avaavaa tasetta ei ole kirjattu — täsmäytystä ei voi tehdä.'
      });
      return;
    }
    const delta = round2(recorded - expected);
    const matches = Math.abs(delta) <= EPSILON;
    checks.push({
      code,
      severity: matches ? 'ok' : info ? 'info' : 'mismatch',
      label_fi,
      recorded_eur: round2(recorded),
      opening_journal_eur: round2(expected),
      delta_eur: delta,
      note_fi: matches
        ? 'Täsmää avaavan taseen kanssa.'
        : info
          ? 'Poikkeaa kirjanpitoarvosta — verotuksen menojäännös saa poiketa kirjanpitoarvosta; kirjattu tiedoksi.'
          : 'Ei täsmää avaavan taseen kanssa — korjaa erittely tai avaava tase (FI-6:n uudelleenkirjaus).'
    });
  };

  if (Array.isArray(cutover.open_receivables)) {
    compare({
      code: 'open_receivables_vs_1700',
      label_fi: 'Avoimet myyntisaamiset vs. 1700',
      recorded: sum(cutover.open_receivables, 'amount_eur'),
      expected: netBalanceFor(openingBalances, CUTOVER_CONTROL_CODES.receivables)
    });
  }
  if (Array.isArray(cutover.open_payables)) {
    const net = netBalanceFor(openingBalances, CUTOVER_CONTROL_CODES.payables);
    compare({
      code: 'open_payables_vs_2870',
      label_fi: 'Avoimet ostovelat vs. 2870',
      recorded: sum(cutover.open_payables, 'amount_eur'),
      // 2870 is a credit balance — the journal net is negative; compare magnitudes.
      expected: net === null ? null : round2(-net)
    });
  }
  if (cutover.vat_opening && cutover.vat_opening.payable_eur !== undefined) {
    const net = netBalanceFor(openingBalances, CUTOVER_CONTROL_CODES.vat_payable);
    compare({
      code: 'vat_payable_vs_2939',
      label_fi: 'ALV-velka vs. 2939',
      recorded: cutover.vat_opening.payable_eur,
      expected: net === null ? null : round2(-net)
    });
  }
  if (cutover.vat_opening && cutover.vat_opening.receivable_eur !== undefined) {
    compare({
      code: 'vat_receivable_vs_1763',
      label_fi: 'ALV-saaminen vs. 1763',
      recorded: cutover.vat_opening.receivable_eur,
      expected: netBalanceFor(openingBalances, CUTOVER_CONTROL_CODES.vat_receivable)
    });
  }
  if (Array.isArray(cutover.fixed_assets)) {
    compare({
      code: 'fixed_asset_bases_vs_book',
      label_fi: 'Käyttöomaisuuden menojäännökset vs. kirjanpitoarvo',
      recorded: sum(cutover.fixed_assets, 'undepreciated_balance_eur'),
      expected: netBalanceFor(openingBalances, CUTOVER_CONTROL_CODES.fixed_assets),
      info: true
    });
  }

  const hasMismatch = checks.some((c) => c.severity === 'mismatch');
  const hasUnverified = checks.some((c) => c.severity === 'unverified');
  const status = hasMismatch ? 'mismatches' : hasUnverified ? 'unverified' : checks.length ? 'reconciled' : 'recorded';
  return {
    status,
    checks,
    summary_fi: hasMismatch
      ? 'Cutover-erittely ei täsmää avaavan taseen kanssa — tarkista erittely tai avaava tase.'
      : hasUnverified
        ? 'Cutover-erittely kirjattu; avaava tase puuttuu, joten täsmäytys on tekemättä.'
        : checks.length
          ? 'Cutover-erittely täsmää avaavan taseen kanssa.'
          : 'Cutover-tiedot kirjattu (ei täsmäytettäviä eriä).'
  };
};

// cutoverNetWorthForTaxYear({ cutover, tilikausi }) → the recorded prior-year
// nettovarallisuus IF this pack anchors to the tilikausi (as_of inside
// [starts_on, ends_on] — the switcher's first Donna year); null otherwise.
// Later years must use Donna's own persisted balance sheets (D-P2-5).
export const cutoverNetWorthForTaxYear = ({ cutover = null, tilikausi = null } = {}) => {
  if (!cutover || typeof cutover !== 'object') return null;
  const netWorth = Number(cutover.prior_year_net_worth_eur);
  if (!Number.isFinite(netWorth)) return null;
  const asOf = dateOnly(cutover.as_of);
  const startsOn = dateOnly(tilikausi?.starts_on);
  const endsOn = dateOnly(tilikausi?.ends_on);
  if (!asOf || !startsOn || !endsOn) return null;
  if (asOf < startsOn || asOf > endsOn) return null;
  return round2(netWorth);
};
