// G-6 (FI-15) — ennakkoperintärekisteri (prepayment register) awareness
// (docs/design-donna-finland-production-readiness.md). Two halves:
//
//   • OWN status — the client's own registration. Falling out of the register
//     means the client's customers must withhold tax from work-compensation
//     (työkorvaus) payments; removal usually signals filing/payment neglect.
//     Donna tracks the latest dated check and nudges when it's missing, stale,
//     or negative.
//   • SUPPLIER-SIDE check — before paying a SERVICE invoice from a supplier
//     that is not in the register, the PAYER is normally obliged to withhold
//     (ennakonpidätys, EPL §25). Donna joins recorded checks to the book's
//     supplier-bill vendors and ESCALATES a not-registered supplier to the
//     owner (goods vs services is the owner's knowledge — genuinely on them).
//     Donna flags and asks; it NEVER executes a withholding.
//
// Deterministic KEEP-layer module, no model call and no live registry call:
// checks are dated, persisted receipts (migration 068) recorded through an
// audited writer; freshness evaluates at READ time against the policy TTL.
// The automated YTJ open-data lookup (source 'ytj_open_data') is a named
// network-open follow-up — avoindata.prh.fi is proxy-blocked from the build
// container, so the adapter ships only once verified against the live API.

// Config-plane flag (migration 042 pattern) — clientFlagActs, envFallback
// () => false; dark by default, canary per client.
export const FINLAND_PREPAYMENT_REGISTER_WATCH_FLAG_KEY = 'FINLAND_PREPAYMENT_REGISTER_WATCH';

// Closed vocabularies. status = what the registry SAID at the check moment
// ('unknown' = a check was attempted but got no answer); freshness is never a
// stored state — it evaluates at read time.
export const PREPAYMENT_REGISTER_STATUSES = Object.freeze(['registered', 'not_registered', 'unknown']);
export const PREPAYMENT_REGISTER_SOURCES = Object.freeze(['ytj_manual', 'ytj_open_data']);
export const PREPAYMENT_REGISTER_SUBJECTS = Object.freeze(['self', 'supplier']);

// Read-time verdicts (closed). Own: registered is quiet; everything else
// nudges. Supplier: 'ok' is quiet, 'withholding_risk' escalates to the owner,
// 'check_needed' converges via the automated lookup follow-up.
export const OWN_REGISTER_VERDICTS = Object.freeze(['registered', 'not_registered', 'check_due']);
export const SUPPLIER_REGISTER_VERDICTS = Object.freeze(['ok', 'withholding_risk', 'check_needed']);

// The owner-ask evidence type (rides the existing owner-clarification lane).
export const PREPAYMENT_REGISTER_EVIDENCE_TYPE = 'prepayment_register_review';

// SERVICE-SCOPE policy constants — re-tune only on Kari's dated call.
//   • CHECK_TTL_DAYS — a registry check older than this is stale (Vero's
//     guidance is to check at payment time; 90 days is the service posture).
//   • SUPPLIER_LOOKBACK_DAYS — how far back the watch scans supplier bills
//     for vendors worth checking.
export const PREPAYMENT_REGISTER_CHECK_TTL_DAYS = 90;
export const PREPAYMENT_REGISTER_SUPPLIER_LOOKBACK_DAYS = 180;

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

// Y-tunnus validation: 7 digits + '-' + check digit; weights 7,9,10,5,8,4,2,
// sum mod 11 → 0 ⇒ check 0, 1 ⇒ no valid id exists, else 11 − remainder.
const Y_TUNNUS_WEIGHTS = [7, 9, 10, 5, 8, 4, 2];
export const isValidBusinessId = (value) => {
  const raw = String(value || '').trim();
  if (!/^\d{7}-\d$/.test(raw)) return false;
  const digits = raw.slice(0, 7).split('').map(Number);
  const check = Number(raw.slice(8));
  const sum = digits.reduce((acc, d, i) => acc + d * Y_TUNNUS_WEIGHTS[i], 0);
  const remainder = sum % 11;
  if (remainder === 1) return false;
  return check === (remainder === 0 ? 0 : 11 - remainder);
};

// The normalized matching key that joins a recorded supplier check to the
// book's supplier-bill vendor names: lower, trim, collapse whitespace. Keep
// in lockstep with the SQL form in getFinlandPrepaymentRegisterFromDb.
export const counterpartyKey = (name) =>
  String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');

// normalizePrepaymentRegisterCheck(value) — the validated write shape for the
// audited record writer. Throws statusCode-400 errors on a bad shape. What is
// stored is a dated RECEIPT of what the registry said — never a Donna guess.
export const normalizePrepaymentRegisterCheck = (value = {}) => {
  const bad = (message) => {
    const error = new Error(message);
    error.statusCode = 400;
    throw error;
  };
  const subjectType = String(value.subjectType || value.subject_type || '').trim().toLowerCase();
  if (!PREPAYMENT_REGISTER_SUBJECTS.includes(subjectType)) {
    bad(`subject_type must be one of ${PREPAYMENT_REGISTER_SUBJECTS.join('/')}.`);
  }
  const status = String(value.status || '').trim().toLowerCase();
  if (!PREPAYMENT_REGISTER_STATUSES.includes(status)) {
    bad(`status must be one of ${PREPAYMENT_REGISTER_STATUSES.join('/')}.`);
  }
  const checkedOn = dateOnly(value.checkedOn || value.checked_on);
  if (!checkedOn) bad('checked_on must be an ISO date (YYYY-MM-DD).');
  const source = String(value.source || 'ytj_manual').trim().toLowerCase();
  if (!PREPAYMENT_REGISTER_SOURCES.includes(source)) {
    bad(`source must be one of ${PREPAYMENT_REGISTER_SOURCES.join('/')}.`);
  }
  const businessId = String(value.businessId || value.business_id || '').trim() || null;
  if (businessId && !isValidBusinessId(businessId)) {
    bad(`business_id must be a valid Y-tunnus (NNNNNNN-T), got ${JSON.stringify(businessId)}.`);
  }
  const counterpartyName = String(value.counterpartyName || value.counterparty_name || '').trim() || null;
  if (subjectType === 'supplier' && !counterpartyName) {
    bad('counterparty_name is required for a supplier check.');
  }
  return {
    subject_type: subjectType,
    business_id: businessId,
    counterparty_name: subjectType === 'supplier' ? counterpartyName : null,
    counterparty_key: subjectType === 'supplier' ? counterpartyKey(counterpartyName) : null,
    status,
    checked_on: checkedOn,
    source,
    reference: String(value.reference || '').trim().slice(0, 500) || null,
    note: String(value.note || '').trim().slice(0, 500) || null
  };
};

const checkAgeDays = (check, at) => {
  const checkedOn = dateOnly(check?.checked_on);
  return checkedOn ? daysBetween(checkedOn, at) : null;
};

// evaluateOwnPrepaymentRegister({ latestCheck, onDate })
// → { verdict, check, notes_fi }. registered+fresh is quiet.
export const evaluateOwnPrepaymentRegister = ({ latestCheck = null, onDate } = {}) => {
  const at = dateOnly(onDate);
  if (!at) throw new Error('evaluateOwnPrepaymentRegister requires an onDate (ISO date or timestamp).');
  const notes = [];
  const envelope = (verdict) => ({ verdict, check: latestCheck || null, notes_fi: notes });

  if (!latestCheck || !dateOnly(latestCheck.checked_on)) {
    notes.push('Ennakkoperintärekisteriin kuulumista ei ole tarkistettu. Tarkistetaan YTJ:stä ja kirjataan päivämäärä — jos yritys ei kuulu rekisteriin, asiakkaiden pitää toimittaa työkorvauksesta ennakonpidätys.');
    return envelope('check_due');
  }
  if (latestCheck.status === 'not_registered') {
    notes.push(`Yritys ei ollut ennakkoperintärekisterissä tarkistushetkellä (${latestCheck.checked_on}). Asiakkaasi joutuvat silloin toimittamaan ennakonpidätyksen työkorvauksesta — selvitetään tilanne Verohallinnon kanssa heti (poisto johtuu usein ilmoitus- tai maksupuutteista).`);
    return envelope('not_registered');
  }
  const age = checkAgeDays(latestCheck, at) ?? 0;
  if (latestCheck.status === 'unknown' || age > PREPAYMENT_REGISTER_CHECK_TTL_DAYS) {
    notes.push(`Edellinen ennakkoperintärekisteri-tarkistus (${latestCheck.checked_on}) on vanhentunut tai jäi epäselväksi — tarkistetaan YTJ:stä ja kirjataan uusi päivämäärä.`);
    return envelope('check_due');
  }
  return envelope('registered');
};

// evaluateSupplierPrepaymentRegister({ name, billCount, lastBillOn,
// latestCheck, onDate }) → { verdict, name, bill_count, last_bill_on, check,
// notes_fi }. 'ok' is quiet; 'withholding_risk' escalates to the owner;
// 'check_needed' (no/stale/unknown check) converges via the automated-lookup
// follow-up — the note never alleges anything about the supplier.
export const evaluateSupplierPrepaymentRegister = ({
  name,
  billCount = 0,
  lastBillOn = null,
  latestCheck = null,
  onDate
} = {}) => {
  const at = dateOnly(onDate);
  if (!at) throw new Error('evaluateSupplierPrepaymentRegister requires an onDate (ISO date or timestamp).');
  const notes = [];
  const envelope = (verdict) => ({
    verdict,
    name: String(name || '').trim() || null,
    bill_count: Number(billCount) || 0,
    last_bill_on: dateOnly(lastBillOn),
    check: latestCheck || null,
    notes_fi: notes
  });

  if (latestCheck?.status === 'not_registered') {
    notes.push(`${String(name || 'Toimittaja').trim()} ei ollut ennakkoperintärekisterissä tarkistushetkellä (${latestCheck.checked_on}). Jos laskut ovat työkorvausta (palvelua), maksusta pitää yleensä toimittaa ennakonpidätys ennen maksamista — tavaraostoissa velvoitetta ei ole. Varmistetaan ennen maksua.`);
    return envelope('withholding_risk');
  }
  if (latestCheck?.status === 'registered') {
    const age = checkAgeDays(latestCheck, at) ?? 0;
    if (age <= PREPAYMENT_REGISTER_CHECK_TTL_DAYS) return envelope('ok');
  }
  return envelope('check_needed');
};

// buildPrepaymentRegisterEscalationQuestion({ name, checkedOn, billCount })
// — the owner ask for a not-registered service supplier. Goods vs services
// is the owner's knowledge (the withholding obligation applies to work
// compensation only), so the question legitimately rests on them. Bounded
// honesty: Donna flags and guides; it never executes a withholding.
export const buildPrepaymentRegisterEscalationQuestion = ({ name, checkedOn, billCount = 0 } = {}) => {
  const supplier = String(name || 'toimittaja').trim();
  const bills = Number(billCount) || 0;
  return [
    `Toimittaja ${supplier} ei ole ennakkoperintärekisterissä (tarkistettu ${dateOnly(checkedOn) || '—'}).`,
    bills ? `Kirjanpidossa on ${bills} lasku${bills === 1 ? '' : 'a'} tältä toimittajalta.` : '',
    'Jos laskut ovat työkorvausta (palvelua), maksusta pitää yleensä toimittaa ennakonpidätys ennen maksamista — tavaraostoissa velvoitetta ei ole.',
    'Kerro, onko kyse palvelusta vai tavarasta, niin neuvon miten edetä. Donna ei toimita ennakonpidätystä puolestasi.'
  ].filter(Boolean).join(' ');
};
