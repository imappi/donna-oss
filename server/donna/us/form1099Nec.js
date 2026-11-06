// US-2 — Form 1099-NEC readiness. Pure computation plus a thin, I/O-injectable
// owner-ask route. It renders persisted payee facts and posted-line arithmetic;
// it never files, transmits, or invents a fact.
//
// ── The fact-vs-knowledge fork (CLAUDE.md, 2026-07-23 re-amendment) ──────────
// This module asks the owner ONLY for business FACTS they alone hold — how the
// payee actually worked, whether a W-9 is on file, the payee's TIN and mailing
// address. It deliberately does NOT ask the owner "is this person a contractor
// or an employee?": worker classification is a JUDGMENT applying the IRS
// common-law test (behavioural control, financial control, relationship type),
// and under the self-service model Donna owes that answer herself from the
// curated high-trust base — she must not shift it onto an unqualified owner.
//
// So the shape here is: Donna asks for the relationship FACTS, and records a
// classification only when one is already PERSISTED. Deciding the
// classification from those facts is the NEXT slice (US-4), not this one — an
// unclassified payee therefore rests as an open owner ask, which is a
// sanctioned terminal, never a firm-side parking lot.

import { CONTRACTOR_CLASSIFICATION_DESCRIPTOR } from '../closeDisposition.js';
import { toUtcIsoDay } from '../dates.js';

export const US_CONTRACTOR_1099_FLAG_KEY = 'US_CONTRACTOR_1099';

// Authority: IRC §6041; IRS Instructions for Forms 1099-MISC and 1099-NEC —
// the $600 nonemployee-compensation reporting threshold ("$600 or more", so the
// comparison below is a strict less-than skip); as of 2026-07-27.
export const FORM_1099_NEC_THRESHOLD_USD = 600;

export const FORM_1099_NEC_PROVENANCE = Object.freeze({
  authority: 'IRC §6041; IRS Instructions for Forms 1099-MISC and 1099-NEC',
  asOf: '2026-07-27'
});

const money = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const nextWeekday = (date) => {
  const d = new Date(`${date}T00:00:00Z`);
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  return toUtcIsoDay(d); // UTC on purpose: the weekend roll-forward is UTC day arithmetic
};

// Authority: IRC §§6071(c), 6041; IRS 1099-NEC instructions — recipient and IRS
// copies both due January 31, rolling to the next business day when that falls
// on a weekend; as of 2026-07-27.
//
// `date_posture` is explicit for the same reason statutoryDeadlines.js carries
// one: this rolls WEEKENDS only. A January 31 that lands next to a federal
// holiday is not adjusted here, and the verdict says so rather than presenting a
// nominal date as a business-day date.
export const FORM_1099_NEC_DATE_POSTURE = 'weekend_rolled_federal_holidays_not_applied';

export const form1099NecCalendar = (calendarYear) => {
  const year = Number(calendarYear);
  if (!Number.isInteger(year) || year < 2000) {
    throw Object.assign(new Error('calendarYear is required.'), { code: 'US_1099_YEAR_INVALID' });
  }
  const due = nextWeekday(`${year + 1}-01-31`);
  return {
    calendar_year: year,
    recipient_copy_due_on: due,
    irs_due_on: due,
    date_posture: FORM_1099_NEC_DATE_POSTURE,
    provenance: FORM_1099_NEC_PROVENANCE
  };
};

// The MISSING-FACT vocabulary. Closed on purpose, and each entry is a fact the
// OWNER can answer — `working_relationship` asks how the payee actually worked,
// it does not ask the owner to render the classification verdict.
export const MISSING_FACT_PROMPTS = Object.freeze({
  working_relationship: 'how they worked for you (who set their hours and methods, whether they used their own tools, and whether they worked for other clients too)',
  w9: 'a signed Form W-9',
  tin: 'their taxpayer ID number (EIN, SSN or ITIN)',
  address: 'their current mailing address'
});

export const MISSING_FACT_KEYS = Object.freeze(Object.keys(MISSING_FACT_PROMPTS));

// Renders the owner-facing sentence. Owner copy never leaks machine field
// names — a bookkeeping question should read like a person asking it.
const ownerAskFor = (missing, displayName) => {
  if (!missing.length) return null;
  const who = displayName || 'this payee';
  const parts = missing.map((key) => MISSING_FACT_PROMPTS[key]).filter(Boolean);
  const phrase = parts.length === 1
    ? parts[0]
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `To get ${who}'s 1099-NEC right I still need ${phrase}. Could you fill me in?`;
};

// Reads only what is PERSISTED. An absent verdict is 'unknown' — never inferred
// from a ledger description (that is the #497 fuzzy-classifier trap, and it is
// exactly the kind of guess a 1099 must not rest on).
const partyFacts = (party = {}) => {
  const detail = party.detail || {};
  const verdict = detail.contractor_classification_verdict || detail.classification_verdict || null;
  const descriptor = typeof verdict === 'string' ? verdict : verdict?.descriptor;
  return {
    classification: descriptor && CONTRACTOR_CLASSIFICATION_DESCRIPTOR.test(descriptor)
      ? 'contractor'
      : (verdict ? 'not_contractor' : 'unknown'),
    w9: detail.w9_status === 'received' ? 'received' : 'missing',
    tin: String(detail.tin || party.business_id || '').trim() || null,
    address: String(detail.address || '').trim() || null
  };
};

const missingFactsFor = (facts) => {
  if (facts.classification === 'unknown') return ['working_relationship'];
  if (facts.classification !== 'contractor') return [];
  return [['w9', facts.w9], ['tin', facts.tin], ['address', facts.address]]
    .filter(([, value]) => !value || value === 'missing')
    .map(([key]) => key);
};

export const computeForm1099NecReadiness = ({ calendarYear, ledgerLines = [], parties = [] } = {}) => {
  const calendar = form1099NecCalendar(calendarYear);
  const byId = new Map(parties.map((p) => [String(p.id), p]));

  // Sum POSTED USD lines per payee for the calendar year. A line that is not
  // posted, not USD, or carries no payee is not reportable payment evidence.
  const totals = new Map();
  for (const line of ledgerLines) {
    const lineYear = Number(line.calendar_year ?? String(line.posted_on || '').slice(0, 4));
    if (lineYear !== calendar.calendar_year) continue;
    if (line.posted !== true) continue;
    if (String(line.currency || 'USD') !== 'USD') continue;
    const id = String(line.party_id || '');
    if (!id) continue;
    totals.set(id, money((totals.get(id) || 0) + Number(line.amount || 0)));
  }

  const payees = [];
  for (const [partyId, total] of [...totals].sort(([a], [b]) => a.localeCompare(b))) {
    if (total < FORM_1099_NEC_THRESHOLD_USD) continue;
    const party = byId.get(partyId) || { id: partyId };
    const facts = partyFacts(party);
    const missing = missingFactsFor(facts);
    const displayName = party.display_name || partyId;
    payees.push({
      party_id: partyId,
      display_name: displayName,
      reportable_payments_usd: total,
      classification: facts.classification,
      // Two terminals only: 'ready' / 'handled_not_reportable' are Donna's own
      // resting states; 'owner_ask_required' is on the owner. Nothing rests
      // anywhere else.
      status: facts.classification === 'not_contractor'
        ? 'handled_not_reportable'
        : missing.length ? 'owner_ask_required' : 'ready',
      missing_facts: missing,
      owner_ask: ownerAskFor(missing, party.display_name)
    });
  }

  return { calendar, payees };
};

// Thin injectable persistence route. The caller supplies the existing party /
// ledger readers and the EXISTING evidence-request writer — no parallel store
// is minted here.
//
// ATOMICITY: every anchor is resolved BEFORE the first ask is written. A payee
// with no anchoring transaction refuses the whole evaluation rather than
// leaving a partial set of asks behind (a half-written batch is the worst of
// both terminals — some owner questions live, the rest silently dropped).
export const evaluateForm1099NecFromDb = async ({
  firmId,
  clientId,
  calendarYear,
  flagActs = false,
  readLedgerLines,
  readParties,
  createEvidenceRequest,
  actorId
} = {}) => {
  if (!flagActs) return { action: 'skipped', reason: 'flag_off' };

  const ledgerLines = await readLedgerLines({ firmId, clientId, calendarYear });
  const result = computeForm1099NecReadiness({
    calendarYear,
    ledgerLines,
    parties: await readParties({ firmId, clientId })
  });

  const pending = result.payees.filter((p) => p.status === 'owner_ask_required');
  const planned = pending.map((payee) => {
    const anchor = ledgerLines.find((l) => String(l.party_id) === payee.party_id)?.transaction_id;
    if (!anchor) {
      throw Object.assign(new Error('A 1099 owner ask requires an existing transaction anchor.'), {
        code: 'US_1099_ASK_ANCHOR_REQUIRED',
        partyId: payee.party_id
      });
    }
    return { payee, anchor };
  });

  const asks = [];
  for (const { payee, anchor } of planned) {
    asks.push(await createEvidenceRequest({
      firmId,
      clientId,
      transactionId: anchor,
      question: payee.owner_ask,
      evidenceType: 'contractor_tax_details',
      actorId
    }));
  }

  return { action: 'evaluated', ...result, asks };
};
