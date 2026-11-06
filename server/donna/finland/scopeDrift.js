// G-7 (FI-15) — scope-drift detection for a Finnish toiminimi pilot book.
// Deterministic KEEP-layer evaluator, no model call anywhere: the DB caller
// reads hard signals from the posted ledger + bank feed (personnel accounts,
// inventory accounts, cash, EU/import/reverse-charge tax codes, payment-
// processor patterns) and THIS module maps them onto a CLOSED verdict enum.
// The pilot's narrow ICP is itself an escalation-rate control (CLAUDE.md):
// each trigger below is a gate from the pilot-eligibility checklist
// (docs/design-donna-finland-production-readiness.md) — drift means the book
// has started doing something the service deliberately does not promise, and
// the two-terminal doctrine demands that surfaces as an escalation, never a
// silent guess.
//
// Verdict semantics (the review's enum, adopted verbatim):
//   • supported            — no drift; the book is inside the promised scope.
//   • supported_with_review — activity Donna handles but flags (the 2026-07-05
//     commerce re-scope posture: flagged-and-escalated, never silently guessed).
//   • migration_required   — activity outside the pilot's service scope; the
//     client needs a deliberate scope decision (Kari's dated call), not code.
//   • filing_blocked       — activity whose STATUTORY return treatment demands
//     review before any ALV filing; the filing start motion escalates instead
//     of minting a confirm ask.
//
// The trigger→severity mapping is SERVICE-SCOPE POLICY (the ratified pilot
// gates), not statute: re-tune it only on a dated call from Kari, same as the
// segment tiers in docs/design-donna-prospecting.md §3C.

import { ALV_CODES, resolveAlvCode } from './alvCodes.js';

// Config-plane flag (migration 042 pattern) — read via clientFlagActs with
// envFallback () => false, never an env pair. Canary per client; dark = the
// report route 403s and the filing gate is a no-op (prod byte-identical).
export const FINLAND_SCOPE_DRIFT_WATCH_FLAG_KEY = 'FINLAND_SCOPE_DRIFT_WATCH';

// G-7P (detection-before-POSTING, D-G7P-5) — SEPARATE from the read-only watch:
// a report and a posting-behavior change canary independently. Dark at birth;
// off ⇒ the posting seam never stamps, never mints, byte-identical.
export const FINLAND_SCOPE_DRIFT_POSTING_GATE_FLAG_KEY = 'FINLAND_SCOPE_DRIFT_POSTING_GATE';

// Severity-ordered (weakest → strongest); overall verdict = the max fired.
export const SCOPE_DRIFT_VERDICTS = Object.freeze([
  'supported',
  'supported_with_review',
  'migration_required',
  'filing_blocked'
]);

// Derived from the ALV vocabulary, not re-hardcoded: a code the vocabulary
// gains later shows up here automatically.
export const EU_OR_IMPORT_TAX_CODES = Object.freeze(
  ALV_CODES.filter((c) => ['eu', 'import', 'zero'].includes(c.kind)).map((c) => c.code)
);
export const REVERSE_CHARGE_TAX_CODES = Object.freeze(
  ALV_CODES.filter((c) => c.kind === 'reverse_charge').map((c) => c.code)
);

// Deterministic account-code signal sets (the FI tilikartta, tilikartta.js):
// 5000/5300/5400 — personnel expenses (a toiminimi owner cannot pay themselves
// salary, so ANY movement here means someone else is being paid); inventory
// asset accounts; 1900 käteinen raha; 3200/3400 EU/export revenue.
export const PERSONNEL_ACCOUNT_CODES = Object.freeze(['5000', '5300', '5400']);
export const INVENTORY_ACCOUNT_CODES = Object.freeze(['1500']);
export const CASH_ACCOUNT_CODES = Object.freeze(['1900']);
export const EU_REVENUE_ACCOUNT_CODES = Object.freeze(['3200', '3400']);

// Payment processors: the pilot excludes processor-paid customers (Kari's
// ratified push-back, 2026-07-10) — "new processor detected" is exactly this
// trigger. Closed, deterministic name list matched over bank-line descriptions;
// extend by PR, never by prose.
export const PROCESSOR_PATTERNS = Object.freeze([
  { name: 'stripe', pattern: /\bstripe\b/i },
  { name: 'paypal', pattern: /\bpaypal\b/i },
  { name: 'sumup', pattern: /\bsumup\b/i },
  { name: 'zettle', pattern: /\bi?zettle\b/i },
  { name: 'klarna', pattern: /\bklarna\b/i },
  { name: 'mollie', pattern: /\bmollie\b/i },
  { name: 'adyen', pattern: /\badyen\b/i },
  { name: 'square', pattern: /\bsquareup\b|\bsquare\b/i },
  { name: 'shopify', pattern: /\bshopify\b/i },
  { name: 'viva_wallet', pattern: /\bviva\s?wallet\b/i },
  { name: 'checkout_com', pattern: /\bcheckout\.com\b/i },
  { name: 'braintree', pattern: /\bbraintree\b/i },
  { name: 'worldpay', pattern: /\bworldpay\b/i }
]);

// The same closed list as ONE case-insensitive SQL alternation (`~*`), so the
// DB caller fetches only candidate rows and matchProcessors names them. Keep
// in lockstep with PROCESSOR_PATTERNS — the pin test walks both.
export const PROCESSOR_SQL_PATTERN =
  String.raw`stripe|paypal|sumup|i?zettle|klarna|mollie|adyen|squareup|square|shopify|viva ?wallet|checkout\.com|braintree|worldpay`;

// matchProcessors(descriptions) → sorted unique processor names found.
export const matchProcessors = (descriptions = []) => {
  const found = new Set();
  for (const raw of descriptions) {
    const text = String(raw || '');
    if (!text) continue;
    for (const { name, pattern } of PROCESSOR_PATTERNS) {
      if (pattern.test(text)) found.add(name);
    }
  }
  return [...found].sort();
};

const severityRank = (verdict) => SCOPE_DRIFT_VERDICTS.indexOf(verdict);

// The closed trigger catalog. Each maps a deterministic signal to a severity
// and an owner/firm-readable Finnish note.
export const SCOPE_DRIFT_TRIGGERS = Object.freeze([
  {
    id: 'first_employee',
    severity: 'migration_required',
    label_fi: 'Palkkakirjauksia (ensimmäinen työntekijä?)',
    note_fi: 'Kirjanpidossa on palkka- tai henkilösivukulukirjauksia. Toiminimiyrittäjä ei maksa itselleen palkkaa, joten kirjaukset viittaavat työntekijään — palkkahallinto ei kuulu palvelun piiriin ja vaatii erillisen päätöksen.'
  },
  // FI-13 13.3A (D-FI13-6 v2) — the Oy fork of the personnel-account signal. An
  // osakeyhtiö's owner IS paid a salary (through external payroll), so personnel
  // movements are not the toiminimi "first employee, out of scope" signal. The
  // boundary Donna draws: booking externally-administered payroll is IN scope
  // (D-FI13-16, books-only payroll is a data contract); running payroll
  // ADMINISTRATION is not. So this fires for review — confirm the payroll is
  // administered externally and that the payroll package arrives for
  // reconciliation — never as a migration_required scope decision. Selected
  // instead of `first_employee` only when the entity axis is 'oy'.
  {
    id: 'payroll_activity',
    severity: 'supported_with_review',
    label_fi: 'Palkkakirjauksia',
    note_fi: 'Kirjanpidossa on palkka- tai henkilösivukulukirjauksia. Ulkoistetun palkanlaskennan kirjaaminen kuuluu palveluun — mutta palkanlaskennan HALLINTA (palkkojen laskeminen) ei. Varmistetaan, että palkat lasketaan yhtiön ulkopuolella ja että palkka-aineisto toimitetaan täsmäytystä varten.'
  },
  {
    id: 'inventory_activity',
    severity: 'supported_with_review',
    label_fi: 'Varastokirjauksia',
    note_fi: 'Kirjanpidossa on vaihto-omaisuuskirjauksia. Varastokirjanpito ja hankintameno käsitellään erikseen — tarkistetaan yhdessä, ei arvata.'
  },
  {
    id: 'cash_activity',
    severity: 'supported_with_review',
    label_fi: 'Käteiskirjauksia',
    note_fi: 'Kirjanpidossa on käteiskassan kirjauksia. Palvelu on rakennettu lasku- ja tilisiirtotuloille — käteismyynti tarkistetaan erikseen.'
  },
  {
    id: 'payment_processor',
    severity: 'migration_required',
    label_fi: 'Maksunvälittäjä havaittu',
    note_fi: 'Tiliotteelta löytyy maksunvälittäjän tapahtumia. Maksunvälittäjien brutto-netto-täsmäytys ei kuulu pilotin piiriin — jatko vaatii erillisen päätöksen.'
  },
  {
    id: 'eu_or_import_activity',
    severity: 'migration_required',
    label_fi: 'EU-/ulkomaankauppaa',
    note_fi: 'Kirjanpidossa on EU-myyntiä/-ostoja, vientiä tai maahantuontia. Ulkomaankaupan ALV-käsittely laajentaa palvelun piiriä — vaatii erillisen päätöksen.'
  },
  {
    id: 'construction_reverse_charge',
    severity: 'filing_blocked',
    label_fi: 'Rakennusalan käännetty ALV',
    note_fi: 'Kirjanpidossa on rakennusalan käännetyn verovelvollisuuden kirjauksia. Ilmoituksen käsittely tarkistetaan ennen kuin yhtään ALV-ilmoitusta lähetetään.'
  }
]);

const TRIGGERS_BY_ID = new Map(SCOPE_DRIFT_TRIGGERS.map((t) => [t.id, t]));

// G-14 (FI-15, D-P2-1) — scope boundaries the ledger CANNOT evidence. These are
// STATED on every evaluation instead of pretended-watched: spouse participation
// (yrittäjäpuolisoiden tulonjako, TVL 14 §) leaves no deterministic ledger
// signal, so the exclusion is copy the owner sees, and the disclosure rests ON
// THE OWNER (two-terminal-states — Donna states what it cannot see; the answer
// arrives through the normal chat/ask lanes). Closed list; extend by PR.
export const SCOPE_DRIFT_STATED_EXCLUSIONS = Object.freeze([
  {
    id: 'spouse_participation',
    label_fi: 'Puolison työpanos',
    note_fi: 'Puolison työpanos ei kuulu palvelun piiriin — kerro Donnalle, jos puolisosi osallistuu yritystoimintaan.',
    note_en: 'Spouse participation in the business is outside the service scope — tell Donna if your spouse takes part in the business.'
  }
]);

const count = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : 0);

// FI-13 13.3A — the scope-drift fork keys on the internal legal-form axis
// (finland/entity.js: 'toiminimi' | 'oy'). Anything that is not an explicit
// osakeyhtiö — null, 'general', an unknown string — normalises to 'toiminimi',
// so an omitted axis is byte-identical to the pre-fork toiminimi behaviour.
export const normalizeScopeDriftEntityAxis = (axis) => (axis === 'oy' ? 'oy' : 'toiminimi');

// The personnel-account signal maps to a DIFFERENT trigger per entity: a
// toiminimi's owner cannot draw salary, so any personnel line is the
// first-employee drift; an Oy's owner IS salaried, so the same signal is the
// review-only payroll_activity (D-FI13-6 v2). Both live in the closed catalog;
// exactly one is applicable per evaluation.
const PERSONNEL_TRIGGER_BY_AXIS = Object.freeze({ toiminimi: 'first_employee', oy: 'payroll_activity' });

// Stated exclusions Donna cannot evidence from the ledger drop when they do not
// apply to the entity. spouse_participation (yrittäjäpuolisoiden tulonjako, TVL
// 14 §) is a toiminimi concept — an Oy spouse is either a TyEL employee or a
// shareholder, both modelled elsewhere — so it is NOT stated for an Oy.
export const OY_DROPPED_STATED_EXCLUSION_IDS = Object.freeze(['spouse_participation']);

const statedExclusionsForAxis = (axis) =>
  axis === 'oy'
    ? SCOPE_DRIFT_STATED_EXCLUSIONS.filter((e) => !OY_DROPPED_STATED_EXCLUSION_IDS.includes(e.id))
    : SCOPE_DRIFT_STATED_EXCLUSIONS;

// The catalog minus the OTHER entity's personnel trigger — the closed set of
// triggers actually considered for this evaluation.
const evaluatedTriggerIdsForAxis = (axis) => {
  const inapplicable = axis === 'oy' ? 'first_employee' : 'payroll_activity';
  return SCOPE_DRIFT_TRIGGERS.map((t) => t.id).filter((id) => id !== inapplicable);
};

// evaluateScopeDrift({ signals, entityAxis }) → { verdict, triggers, entity_axis,
// evaluatedTriggerIds }. Pure, never throws; unknown/missing signals simply
// don't fire. `triggers` carries only the FIRED ones, each with its
// deterministic evidence. `entityAxis` defaults to 'toiminimi' (byte-identical
// to the pre-fork evaluator for every caller that omits it).
export const evaluateScopeDrift = ({ signals = {}, entityAxis } = {}) => {
  const axis = normalizeScopeDriftEntityAxis(entityAxis);
  const fired = [];
  const fire = (id, evidence) => {
    const spec = TRIGGERS_BY_ID.get(id);
    fired.push({ id, severity: spec.severity, label_fi: spec.label_fi, note_fi: spec.note_fi, evidence });
  };

  const personnel = count(signals.personnelAccountMovements);
  if (personnel > 0) fire(PERSONNEL_TRIGGER_BY_AXIS[axis], { ledger_lines: personnel });

  const inventory = count(signals.inventoryAccountMovements);
  if (inventory > 0) fire('inventory_activity', { ledger_lines: inventory });

  const cash = count(signals.cashAccountMovements);
  if (cash > 0) fire('cash_activity', { ledger_lines: cash });

  const processors = Array.isArray(signals.processorsDetected) ? signals.processorsDetected.filter(Boolean) : [];
  if (processors.length > 0) fire('payment_processor', { processors: [...processors].sort() });

  const euLines = count(signals.euOrImportTaxLines) + count(signals.euRevenueAccountMovements);
  if (euLines > 0) fire('eu_or_import_activity', { ledger_lines: euLines });

  const reverseCharge = count(signals.reverseChargeTaxLines);
  if (reverseCharge > 0) fire('construction_reverse_charge', { ledger_lines: reverseCharge });

  const verdict = fired.reduce(
    (worst, t) => (severityRank(t.severity) > severityRank(worst) ? t.severity : worst),
    'supported'
  );

  return {
    verdict,
    triggers: fired,
    entity_axis: axis,
    evaluatedTriggerIds: evaluatedTriggerIdsForAxis(axis),
    // G-14: rides EVERY evaluation regardless of signals — a boundary that
    // cannot be detected must always be stated, never only when something
    // else fires. Entity-scoped: an exclusion that does not apply to the form
    // (spouse_participation for an Oy) is not stated.
    stated_exclusions: statedExclusionsForAxis(axis),
    provenance: {
      deterministic: true,
      policy: 'pilot-eligibility gates (docs/design-donna-finland-production-readiness.md); severities re-tunable only by dated call'
    }
  };
};

// ---------------------------------------------------------------------------------
// G-7P — detection BEFORE POSTING (D-G7P-1..4,
// docs/design-donna-finland-g7-posting-detection.md). Pure additions only; the
// seam hook lives in firmDb.js (__writeLedgerJournalRows), the auto-lane
// demotion in codingAutoPost.js.
// ---------------------------------------------------------------------------------

// evaluateJournalScopeDrift({ lines, entityAxis }) → { verdict, triggers }. The
// SAME closed catalog evaluated over ONE journal's own lines (account codes +
// tax_type) — the payment_processor trigger is structurally excluded (a
// bank-feed description signal has no journal representation; it stays read-time
// only, D-G7P-1). `entityAxis` forks the personnel signal (D-FI13-6 v2);
// omitted ⇒ 'toiminimi', byte-identical to the pre-fork seam. Pure, never
// throws; a healthy journal costs zero I/O.
export const evaluateJournalScopeDrift = ({ lines = [], entityAxis } = {}) => {
  const rows = Array.isArray(lines) ? lines : [];
  const codeOf = (line) => String(line?.account?.code || '').trim();
  // The writer persists ledger_lines.tax_type from line.account.tax_type (the
  // journal-builder convention); line.tax_type is a defensive fallback only.
  const taxOf = (line) => String(line?.account?.tax_type ?? line?.tax_type ?? '').trim().toUpperCase();
  const countBy = (fn) => rows.reduce((n, line) => n + (fn(line) ? 1 : 0), 0);

  const { verdict, triggers } = evaluateScopeDrift({
    entityAxis,
    signals: {
      personnelAccountMovements: countBy((l) => PERSONNEL_ACCOUNT_CODES.includes(codeOf(l))),
      inventoryAccountMovements: countBy((l) => INVENTORY_ACCOUNT_CODES.includes(codeOf(l))),
      cashAccountMovements: countBy((l) => CASH_ACCOUNT_CODES.includes(codeOf(l))),
      euRevenueAccountMovements: countBy((l) => EU_REVENUE_ACCOUNT_CODES.includes(codeOf(l))),
      euOrImportTaxLines: countBy((l) => EU_OR_IMPORT_TAX_CODES.includes(taxOf(l))),
      reverseChargeTaxLines: countBy((l) => REVERSE_CHARGE_TAX_CODES.includes(taxOf(l))),
      processorsDetected: []
    }
  });
  return { verdict, triggers };
};

// D-G7P-4 — does a coder suggestion resolve to a reverse-charge ALV code (the
// catalog's only filing_blocked severity)? Uses the SAME resolver the posting
// preview uses (resolveAlvCode), so the demotion decision and the code that
// would actually post can never disagree. Membership only — the output/input
// variant does not matter here, so an unknown direction is fine.
export const suggestionFiresReverseChargeDrift = ({ taxType = '', taxTreatment = '' } = {}) => {
  const code = resolveAlvCode({ taxType, taxTreatment });
  return Boolean(code) && REVERSE_CHARGE_TAX_CODES.includes(code);
};

// The posting-time owner ask (the G-2 escalation substrate's vocabulary).
export const SCOPE_DRIFT_EVIDENCE_TYPE = 'scope_drift_review';

// Deterministic ask id — ONE per (client, trigger), shared namespace with any
// future drift mint so collisions land on `on conflict do nothing` (D-G7P-7).
export const scopeDriftAskId = ({ firmId, clientId, triggerId }) =>
  `scope-drift-${firmId}-${clientId}-${triggerId}`;

// buildScopeDriftEscalationQuestion({ trigger }) → the owner-readable Finnish
// question. The trigger's note_fi already explains the signal; the closing
// line asks the ONE thing only the owner can answer.
export const buildScopeDriftEscalationQuestion = ({ trigger = {} } = {}) =>
  `${trigger.note_fi || trigger.label_fi || 'Kirjanpidossa on palvelun piirin ulkopuolista toimintaa.'} Kerro lyhyesti, mistä on kyse — tarkistan käsittelyn kanssasi.`;
