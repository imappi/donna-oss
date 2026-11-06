// FI-13 slice 13.3A PR2 (D-FI13-19 + D-FI13-18) — the Oy balance-sheet watches.
//
// A reconciled bank feed is NOT an Oy close (D-FI13-15). An osakeyhtiö carries
// governance and statutory-liability obligations that live on the BALANCE SHEET,
// and Donna's job is to DETECT the six conditions below and escalate each to a
// named human — never to conclude the legal or tax consequence itself. This is
// the detection layer; the monthly-close checklist (D-FI13-15, PR3) consumes
// these verdicts and drives each to a terminal.
//
// Deterministic KEEP-layer module, no model call. The DB caller reads the posted
// ledger (balances by statutory_group), the shareholder-loan account, the
// related-party receivables, and the fiscal-year registry; THIS module maps the
// signals onto a CLOSED watch catalog. Pure; never throws on garbage.
//
// Two hard lines carried from the design:
//   • The osakaslaina (shareholder-debit) watch DETECTS and presents two clocks
//     (recipient calendar year for TVL 53 a §; company fiscal period for 6B) and
//     draws ZERO tax conclusions (borrower identity/residency, family ownership,
//     draw/repayment schedule, contract and intent are all reviewer-resolved).
//   • The negative-equity watch carries the OYL 20:23 register-notification duty
//     in its copy (osakepääoman menettäminen) but the pääomalaina add-back and
//     the exact statute reference are confirmedAgainstPrimary:false.

// Config-plane flag (migration 042 pattern) — clientFlagActs, envFallback
// () => false; dark by default, canary per client.
export const FINLAND_OY_BALANCE_SHEET_WATCHES_FLAG_KEY = 'FINLAND_OY_BALANCE_SHEET_WATCHES';

// Severity, weakest → strongest (overall = the max fired), like scopeDrift.
export const OY_WATCH_SEVERITIES = Object.freeze(['informational', 'review_required', 'legal_duty']);

// The named human each fired watch rests on (two-terminal-states: an Oy
// judgment item's terminal is "assigned to a named human", D-FI13-15). Pinned
// to the StatutoryBlocker assigned_to vocabulary (migration 076).
export const OY_WATCH_ASSIGNEES = Object.freeze(['firm', 'accountant', 'reviewer', 'counsel']);

// Related-party receivable ageing horizon (days) — a receivable from a related
// party outstanding beyond this is escalated. Policy, not statute;
// confirmedAgainstPrimary:false.
export const RELATED_PARTY_AGEING_DAYS = 180;

// Per-kind statutory settlement lag (days from the oldest unpaid movement) after
// which an unpaid statutory liability is treated as overdue. PLACEHOLDER lags —
// confirmedAgainstPrimary:false; the exact due-date rule is confirmed against
// the Finnish primary source (and refined via the deadline engine) before any
// FI canary.
export const STATUTORY_LIABILITY_LAG_DAYS = Object.freeze({
  vat: 42,
  employer_contribution: 12,
  corporate_tax: 30
});
export const STATUTORY_LIABILITY_KINDS = Object.freeze(Object.keys(STATUTORY_LIABILITY_LAG_DAYS));

const OY_WATCH_IDS = Object.freeze([
  'negative_equity',
  'distributable_equity_depleted',
  'overdue_statutory_liability',
  'related_party_receivable_ageing',
  'unsupported_shareholder_debit',
  'registry_books_period_mismatch'
]);
export const OY_BALANCE_SHEET_WATCH_IDS = OY_WATCH_IDS;

const severityRank = (s) => OY_WATCH_SEVERITIES.indexOf(s);
const numOrNull = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const round2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

const dateOnly = (value) => {
  const raw = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
};
const daysBetween = (fromIso, toIso) => {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.floor((to - from) / 86400000);
};

// evaluateOyBalanceSheetWatches({ signals, asOf }) → { verdict, watches,
// evaluatedWatchIds, confirmedAgainstPrimary, provenance }. `watches` carries
// only FIRED ones, each { id, severity, assigned_to, label_fi, note_fi, note_en,
// evidence }.
export const evaluateOyBalanceSheetWatches = ({ signals = {}, asOf = null } = {}) => {
  const at = dateOnly(asOf);
  const fired = [];
  const fire = (w) => fired.push(w);

  // 1 — Negative equity (OYL 20:23 osakepääoman menettäminen).
  const equityTotal = numOrNull(signals.equityTotal);
  if (equityTotal !== null && equityTotal < 0) {
    const capitalLoans = numOrNull(signals.capitalLoansTotal) ?? 0;
    fire({
      id: 'negative_equity',
      severity: 'legal_duty',
      assigned_to: 'firm',
      label_fi: 'Oma pääoma negatiivinen',
      note_fi: 'Yhtiön oma pääoma on negatiivinen. Osakeyhtiölain mukaan hallituksen on tehtävä osakepääoman menettämisestä rekisteri-ilmoitus kaupparekisteriin (PRH). Pääomalaina voidaan lukea omaan pääomaan tietyin edellytyksin — tarkistetaan tilanne. Donna ei tee oikeudellista johtopäätöstä.',
      note_en: 'The company\'s equity is negative. Under the Companies Act the board must file a register notification of the loss of share capital with the Trade Register (PRH). A capital loan (pääomalaina) may be counted toward equity under conditions — to be reviewed. Donna draws no legal conclusion.',
      evidence: { equity_total: round2(equityTotal), capital_loans_total: round2(capitalLoans), equity_plus_capital_loans: round2(equityTotal + capitalLoans) }
    });
  }

  // 2 — Distributable unrestricted equity depleted (gates any distribution).
  const distributable = numOrNull(signals.distributableEquity);
  if (distributable !== null && distributable <= 0) {
    fire({
      id: 'distributable_equity_depleted',
      severity: 'review_required',
      assigned_to: 'accountant',
      label_fi: 'Ei jakokelpoista vapaata omaa pääomaa',
      note_fi: 'Yhtiöllä ei ole jakokelpoista vapaata omaa pääomaa. Osinkoa tai muuta varojenjakoa ei voi tehdä (OYL 13 luku) — tarkistetaan ennen mahdollista jakopäätöstä.',
      note_en: 'The company has no distributable unrestricted equity. No dividend or other distribution can be made (Companies Act ch. 13) — to be reviewed before any distribution decision.',
      evidence: { distributable_equity: round2(distributable) }
    });
  }

  // 3 — Overdue statutory liabilities (VAT / employer contributions / corporate tax).
  const liabilities = Array.isArray(signals.statutoryLiabilities) ? signals.statutoryLiabilities : [];
  const overdue = [];
  for (const l of liabilities) {
    const kind = String(l?.kind || '').trim();
    const lag = STATUTORY_LIABILITY_LAG_DAYS[kind];
    const balance = numOrNull(l?.balance);
    const oldest = dateOnly(l?.oldest_unpaid_date);
    if (lag === undefined || balance === null || balance <= 0 || !oldest || !at) continue;
    const age = daysBetween(oldest, at);
    if (age !== null && age > lag) overdue.push({ kind, balance: round2(balance), oldest_unpaid_date: oldest, age_days: age, lag_days: lag });
  }
  if (overdue.length > 0) {
    fire({
      id: 'overdue_statutory_liability',
      severity: 'review_required',
      assigned_to: 'accountant',
      label_fi: 'Erääntynyt lakisääteinen velka',
      note_fi: 'Kirjanpidossa on lakisääteisiä velkoja (ALV, työnantajasuoritukset tai yhteisövero), jotka näyttävät maksamattomilta yli eräpäivän. Tarkistetaan maksutilanne — viivästys voi aiheuttaa viivästyskorkoa ja seuraamuksia.',
      note_en: 'The books carry statutory liabilities (VAT, employer contributions or corporate tax) that appear unpaid past their due date. The payment status is reviewed — a delay can trigger late interest and penalties.',
      evidence: { overdue }
    });
  }

  // 4 — Related-party receivable ageing.
  const rp = signals.relatedPartyReceivable;
  if (rp && at) {
    const balance = numOrNull(rp.balance);
    const oldest = dateOnly(rp.oldest_open_date);
    const age = oldest ? daysBetween(oldest, at) : null;
    if (balance !== null && balance > 0 && age !== null && age > RELATED_PARTY_AGEING_DAYS) {
      fire({
        id: 'related_party_receivable_ageing',
        severity: 'review_required',
        assigned_to: 'accountant',
        label_fi: 'Vanha lähipiirisaaminen',
        note_fi: 'Lähipiiriltä oleva saaminen on ollut avoinna pitkään. Tarkistetaan saamisen peruste, takaisinmaksuaikataulu ja mahdollinen korko — vanha lähipiirisaaminen voi olla osakaslaina tai peiteltyä varojenjakoa.',
        note_en: 'A receivable from a related party has been open for a long time. The basis, repayment schedule and any interest are reviewed — an aged related-party receivable can be a shareholder loan or a disguised distribution.',
        evidence: { balance: round2(balance), oldest_open_date: oldest, age_days: age, threshold_days: RELATED_PARTY_AGEING_DAYS }
      });
    }
  }

  // 5 — Unsupported shareholder debit balance (osakaslaina, D-FI13-18 dual clock).
  const sd = signals.shareholderDebit;
  if (sd) {
    const companyBalance = numOrNull(sd.companyPeriod?.balance);
    const calendarBalance = numOrNull(sd.calendarYtd?.balance);
    // A DEBIT balance means the company has lent to a shareholder.
    if ((companyBalance !== null && companyBalance > 0) || (calendarBalance !== null && calendarBalance > 0)) {
      fire({
        id: 'unsupported_shareholder_debit',
        severity: 'review_required',
        assigned_to: 'reviewer',
        label_fi: 'Osakaslaina (osakkaan velka yhtiölle)',
        note_fi: 'Osakastililla on debet-saldo — yhtiö on lainannut osakkaalle (osakaslaina). Tämä esitetään KAHDELLA eri jaksolla: saajan kalenterivuosi 31.12. (TVL 53 a §) ja yhtiön tilikausi (6B-esittäminen). Donna vain havaitsee saldon eikä tee verotuksellista johtopäätöstä — laina, takaisinmaksu, korko ja osapuolet tarkistetaan.',
        note_en: 'The shareholder account shows a debit balance — the company has lent to a shareholder (osakaslaina). This is presented on TWO clocks: the recipient\'s calendar year at 31 Dec (TVL 53 a §) and the company\'s fiscal period (6B presentation). Donna only detects the balance and draws no tax conclusion — the loan, repayment, interest and parties are reviewed.',
        evidence: {
          company_fiscal_period: companyBalance !== null ? { balance: round2(companyBalance), period_end: dateOnly(sd.companyPeriod?.period_end) } : null,
          recipient_calendar_year_31dec: calendarBalance !== null ? { balance: round2(calendarBalance), year_end: dateOnly(sd.calendarYtd?.year_end) } : null
        }
      });
    }
  }

  // 6 — Registry-vs-books fiscal-period mismatch.
  const reg = signals.registryPeriod;
  const books = signals.booksPeriod;
  if (reg && books) {
    const regStart = dateOnly(reg.start); const regEnd = dateOnly(reg.end);
    const bkStart = dateOnly(books.start); const bkEnd = dateOnly(books.end);
    if (regStart && regEnd && bkStart && bkEnd && (regStart !== bkStart || regEnd !== bkEnd)) {
      fire({
        id: 'registry_books_period_mismatch',
        severity: 'review_required',
        assigned_to: 'firm',
        label_fi: 'Tilikausi ei täsmää rekisteriin',
        note_fi: 'Kaupparekisteriin merkitty tilikausi ei täsmää kirjanpidon jaksoon. Tarkistetaan, kumpi on oikea — väärä tilikausi vaikuttaa tilinpäätöksen ja veroilmoituksen määräaikoihin.',
        note_en: 'The fiscal period registered with the Trade Register does not match the books\' period. Which is correct is reviewed — a wrong fiscal period affects the financial-statement and tax-return deadlines.',
        evidence: { registry: { start: regStart, end: regEnd }, books: { start: bkStart, end: bkEnd } }
      });
    }
  }

  const verdict = fired.reduce((worst, w) => (severityRank(w.severity) > severityRank(worst) ? w.severity : worst), 'informational');

  return {
    verdict: fired.length ? verdict : 'clear',
    watches: fired,
    evaluatedWatchIds: OY_WATCH_IDS,
    // The statutory references (OYL 20:23, the VAT/employer lags, the 6B/TVL
    // dual-clock framing) are confirmed against a Finnish primary source before
    // any FI canary — F-FI13-V.
    confirmedAgainstPrimary: false,
    provenance: { deterministic: true, policy: 'D-FI13-19 balance-sheet watches + D-FI13-18 osakaslaina dual-clock; detection only, zero legal/tax conclusions' }
  };
};
