// FIK-2 (plan-2026-09-22-fi-jev-decision-knowledge.md §5, §8.5): the reviewed
// Finnish decision guidance ("v8") and its renderer. It is rendered only
// through resolveCodingPolicy, and only when the call owner selects the
// 'reviewed' variant (FI_JEV_DECISION_GUIDANCE, off for every client).
//
// A reviewed entry REPLACES the unreviewed ("v7") clauses it covers, in
// place: its claim takes the position of its first covered clause and every
// covered clause text is removed. A covered clause is never sent beside it.
// With no applicable entry the rendered text is byte-identical to v7.
//
// Only an entry with status 'reviewed', a named reviewer and a review date
// renders. An unreviewed entry never reaches a prompt. The set ships EMPTY:
// activation is FIK-1's reviewed work, never this module's.
//
// FIK-3 provisional arm (plan §8.8): unreviewed DRAFT entries can be measured
// on synthetic books before a reviewer exists. They render through the same
// replace-never-append renderer, but only inside a scope the offline harness
// opens with __runWithFiProvisionalGuidanceForHarness. No flag, env var,
// config stage or client row opens it, and outside it renderFiProvisionalGuidance
// returns null, so production never renders a provisional entry.
// fiProvisionalGuidanceBoundary.test.js pins who may reference the seam.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

// The FIK-1 clause inventory (docs/fik-1-fi-policy-clause-inventory.md),
// keyed by its row ids, quoting the CURRENT policy text (version 10; the rows
// amended in inventory §7 quote their version-9 or version-10 wording). Each quote is
// an exact substring of its block, and together they cover both blocks;
// finlandDecisionGuidance.test.js pins both facts, so an edit to either block
// that orphans a clause fails before a reviewed entry can silently miss it.
const CLAUSE_ROWS = [
  ['FI-ALV-01', "The applicable jurisdiction is Finland; the tax_treatment options are Finnish ALV treatments."],
  ['FI-ALV-02', "Pick the treatment the line's substance supports"],
  ['FI-ALV-03', "standard 25,5 % for most domestic sales/purchases"],
  ['FI-ALV-04', "the reduced rates only where they genuinely apply"],
  ['FI-ALV-05', "13,5 % (food, restaurants, books, medicine, transport, accommodation, culture, sport) for supplies from 1.1.2026"],
  ['FI-ALV-06', "14 % for those categories where the goods were delivered, the service performed, or an advance payment received during 2025"],
  ['FI-ALV-07', "(the time of supply decides the rate, not the payment date — a 2026 bank line settling a 2025 supply is still 14 %)"],
  ['FI-ALV-08', "and 10 % for newspapers and periodicals"],
  ['FI-ALV-09', "for historical supplies or advances before 1.1.2025, the categories then taxed at 10 % (including passenger transport) retain that historical rate"],
  ['FI-ALV-10', "'ALV 0 % / vienti' for exports outside the EU"],
  ['FI-ALV-11', "the EU options for intra-community goods/services (myynti = the client sells, osto = the client buys)"],
  ['FI-ALV-12', "'Maahantuonti EU:n ulkopuolelta' for imports of goods from outside the EU"],
  ['FI-ALV-13', "'Rakennusalan käännetty ALV' only for construction-industry reverse charge"],
  ['FI-ALV-14', "'Veroton toiminta (ALV-vapaa)' for exempt activities (healthcare, financial, insurance, education)"],
  ['FI-ALV-15', "'Vähennyskelvoton ALV (osto)' for a purchase on which ALV was charged but which the client may not deduct — the gross amount stays in the expense and no input VAT is claimed"],
  ['FI-ALV-16', "it is never for an EU acquisition, import or construction reverse charge (their self-assessed tax is still due)"],
  ['FI-ALV-17', "never for a purchase that carried no ALV"],
  ['FI-ALV-18', "and never a substitute for a missing receipt"],
  ['FI-ALV-19', "'Ei ALV-käsittelyä' for out-of-scope internal transfers/equity/capital movements"],
  ['FI-ALV-20', "When you genuinely cannot determine the treatment, answer 'ALV-tarkistus' instead of guessing a rate — it never posts: without a held source the owner is asked for the source document, and with a held source the line is re-examined against that source."],
  ['FI-ALV-21', "'ALV-tarkistus' is for a line whose plausible components carry DIFFERENT rates and the evidence cannot split them"],
  ['FI-ALV-22', "it is never the answer for a composite whose every plausible component carries the same rate — a hair salon's or a shop's card-terminal payout mixes services and retail goods that are all 25,5 %, so it is 'ALV 25,5 %'"],
  ['FI-ALV-23', "Commercial premises rent follows the matched rent bill: if the bill states ALV, 'ALV 25,5 %'; if it states no ALV (the landlord has not opted to tax the premises), 'Veroton toiminta (ALV-vapaa)'"],
  ['FI-ALV-24', "read the bill's tax fields before answering 'ALV-tarkistus'"],
  ['FI-ALV-25', "A bank payment to Verohallinto / OmaVero that settles the client's ALV (VAT) is NOT an expense, but the bank line and its OmaVero/tax-account reference do not by themselves establish that liability: without the ALV return, tax notice or payment confirmation for it, ask for that source; once it is held, code the payment to the ALV payable account 'Suoritettava arvonlisävero' with 'Ei ALV-käsittelyä'"],
  ['FI-ALV-26', "(it clears the liability the ALV return already reported)"],
  ['FI-ALV-27', "an ALV refund FROM Verohallinto codes to the same account"],
  ['FI-ALV-28', "A Verohallinto payment that is clearly a different tax (income-tax prepayment / ennakkovero, employer payroll contributions) is NOT the ALV settlement — code it by its own substance; if the reference, amount and supplied evidence cannot tell which tax it settles, ask which tax or contribution it settles — 'ALV-tarkistus' is a tax-treatment marker, never the answer to which obligation a payment settles."],
  ['FI-POST-01', "For a Finnish out-of-scope loan payment whose matched notice decomposes principal and interest, use posting_requirement document_allocation: select every source line's call-local handle exactly once in document_allocations with its correct chart account."],
  ['FI-POST-02', "Amounts come from the document; never invent amounts or book interest as principal."],
  ['FI-POST-03', "A payment described as principal plus interest needs the loan notice: without it set evidence_required true and request that notice."],
  ['FI-POST-04', "A remittance of employee payroll withholding and employer health-insurance contributions settles Payroll withholding and employer health-insurance payable, with Ei ALV-käsittelyä; it is not a fresh Payroll expense."],
  ['FI-POST-05', "Keep pension/unemployment contributions on their evidenced payroll-contribution liability."],
  ['FI-POST-06', "If a required liability is absent from a synced chart, never substitute an expense: the missing account is a chart-capability gap for Donna to resolve, not a question for the owner."],
  ['FI-POST-07', "An Oy has no owner drawings"],
  ['FI-POST-08', "private expenditure paid by the company requires an evidenced receivable from the shareholder or the appropriate taxable benefit treatment."],
  ['FI-POST-09', "Do not infer the recipient relationship or a shareholder loan merely from private-use evidence."],
  ['FI-POST-10', "A Finnish salary payment, whatever the employer's legal form, requires an external balanced payroll package (gross/net, withholding, employer contributions, pension/insurance and liability accounts)."],
  ['FI-POST-11', "A payslip alone is not that package: use payroll_package and ask specifically for the missing payroll journal, acknowledging the payslip held."],
  ['FI-POST-12', "Never book net salary as the whole payroll expense or invent employer contributions."],
  ['FI-POST-13', "When posting_recovery is present, the original file has been independently re-read after a posting refusal."],
  ['FI-POST-14', "First establish the evidenced supply or advance-payment date, then the applicable dated Finnish treatment, then compare the printed amounts."],
  ['FI-POST-15', "Printed VAT is evidence of what the supplier charged; it does not establish that the rate is applicable."],
  ['FI-POST-16', "Passenger transport supplied in 2025 is 14%, NOT 10%."],
  ['FI-POST-17', "A 2025 receipt printing 10% does not itself prove a pre-2025 supply or advance payment."],
  ['FI-POST-18', "Only explicit source evidence or an attributable owner answer can establish that exception; never infer it merely because the printed arithmetic works."],
  ['FI-POST-19', "If that timing fact is absent after the source re-read, retain the discrepancy and ask for the factual timing or a corrected receipt."],
  ['FI-POST-20', "Whenever you select a rate that applied only before a rate change (10 % on a line dated 2025 or later; 14 % on a line dated 2026 or later), state its basis in historical_rate_basis: periodical, supply_before_rate_change or advance_paid_before_rate_change, each only when the source or an attributable owner answer establishes it; otherwise timing_not_established, which makes the line a timing question — against the held source when it has been verified, otherwise to the owner — never a posting."],
  ['FI-POST-21', "A single printed source line that combines two separately accounted charges without stating each amount (for example late interest together with a reminder fee) cannot be allocated: never book the whole line to one of them and never invent a split; use document_discrepancy and ask for the split or a corrected document."],
  ['FI-POST-22', "Correct your coding if your earlier treatment was wrong."],
  ['FI-POST-23', "Never change the printed VAT or select a false rate just to make posting pass."],
  ['FI-POST-24', "If a genuine source discrepancy remains, use posting_requirement document_discrepancy, evidence_required true and a precise ask_client_question citing the file and conflicting figures."],
  ['FI-POST-25', "Ask only for a missing factual date, explanation or corrected document; never ask the owner which VAT rate/account to choose or request the same file again."],
  ['FI-POST-26', "A technical failure, unsupported allocation or missing chart capability is Donna's problem and is not document_discrepancy."],
  ['FI-POST-27', "On an owner reply, consider the new factual answer and the tax amounts in reply_documents before retaining that requirement."],
  ['FI-POST-28', "Document allocation supports positive source components, each with its own explicit tax treatment: a tax-bearing component needs its own tax evidence in the source, and its selected rate must match the source rate. Signed components (credit lines, refunds inside one document) and signed payroll imports require their own source contract."],
];
export const FI_POLICY_CLAUSES = Object.freeze(Object.fromEntries(CLAUSE_ROWS.map(([id, text]) =>
  [id, Object.freeze({ id, block: id.startsWith('FI-ALV-') ? 'alv' : 'posting', text })])));

// Reviewed entries, in id order. EMPTY by design (FIK-1 activates entries after
// the named reviewer verifies each one against a captured primary source).
export const FI_REVIEWED_GUIDANCE_ENTRIES = Object.freeze([]);
// Test seam only: lets a real-database lifecycle render fixture entries through
// the live registry. Every entry still passes the same shape and review checks.
let entriesInForce = FI_REVIEWED_GUIDANCE_ENTRIES;
export const __setFiReviewedGuidanceEntriesForTests = (entries) => {
  const previous = entriesInForce;
  entriesInForce = entries == null ? FI_REVIEWED_GUIDANCE_ENTRIES : entries;
  return () => { entriesInForce = previous; };
};

export const FI_GUIDANCE_VARIANT = 'reviewed';
export const FI_PROVISIONAL_GUIDANCE_VARIANT = 'provisional';
// 'provisional' is a known status so a draft entry misplaced in the reviewed
// set is inert there (like 'unreviewed'), never a crash and never rendered.
const ENTRY_STATUSES = new Set(['unreviewed', 'provisional', 'reviewed', 'superseded']);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export class FiGuidanceEntryError extends Error {
  constructor(reason, entryId = null) {
    super(`Finnish decision guidance entry invalid: ${reason}${entryId ? ` (${entryId})` : ''}`);
    this.name = 'FiGuidanceEntryError';
    this.reason = reason;
    this.entryId = entryId;
  }
}
const invalid = (reason, id) => { throw new FiGuidanceEntryError(reason, id); };
const text = (value) => typeof value === 'string' && value.trim() === value && value.length > 0;
const day = (value) => typeof value === 'string' && ISO_DAY.test(value);
const dayOrNull = (value) => value == null || day(value);

// Shape of one entry. A malformed entry fails loudly whatever its status, so
// a broken source file is never mistaken for "nothing reviewed yet".
// Only a reviewed entry must hold its source capture; a draft may record the
// URL with the snapshot still owed (it never renders from the reviewed set).
const assertEntryShape = (entry, { captureOwed = entry?.status !== 'reviewed' } = {}) => {
  const id = entry?.id;
  if (!entry || typeof entry !== 'object' || !text(id)) invalid('id_missing');
  if (!ENTRY_STATUSES.has(entry.status)) invalid('status_invalid', id);
  if (!text(entry.claim)) invalid('claim_missing', id);
  if (!Array.isArray(entry.covers) || !entry.covers.length || new Set(entry.covers).size !== entry.covers.length
      || entry.covers.some((clause) => !Object.prototype.hasOwnProperty.call(FI_POLICY_CLAUSES, clause))) {
    invalid('covers_invalid', id);
  }
  if (!Array.isArray(entry.sources) || !entry.sources.length || entry.sources.some((source) => !source
      || typeof source !== 'object' || !/^https:\/\/\S+$/.test(source.url || '')
      || !(day(source.captured_on) || (captureOwed && source.captured_on === null && source.snapshot_owed === true))
      || !dayOrNull(source.effective_from) || !dayOrNull(source.effective_to)
      || (source.effective_from && source.effective_to && source.effective_from > source.effective_to))) {
    invalid('sources_invalid', id);
  }
  if (entry.entity_types != null && (!Array.isArray(entry.entity_types) || !entry.entity_types.length
      || entry.entity_types.some((type) => !text(type) || type !== type.toLowerCase()))) {
    invalid('entity_types_invalid', id);
  }
  if (entry.reviewer != null && !text(entry.reviewer)) invalid('reviewer_invalid', id);
  if (entry.reviewed_on != null && !day(entry.reviewed_on)) invalid('reviewed_on_invalid', id);
  if (entry.status === 'reviewed' && (!entry.reviewer || !entry.reviewed_on)) invalid('reviewer_missing', id);
};

// An entry applies to a decision when it is reviewed, its entity scope admits
// the entity, and the business date lies inside every source's effective
// interval. Without a business date only an entry whose sources are all
// open-ended applies: an interval that cannot be checked is not assumed.
const applies = (entry, { businessDate, entityType }, status = 'reviewed') => {
  if (entry.status !== status) return false;
  if (entry.entity_types && !entry.entity_types.includes(entityType || '')) return false;
  return entry.sources.every(({ effective_from: from = null, effective_to: to = null }) => {
    if (!businessDate) return !from && !to;
    return (!from || businessDate >= from) && (!to || businessDate <= to);
  });
};

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => [key, canonical(value[key])]));
  }
  return value;
};
const sha256 = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

// Replace, never append: each covered clause is cut out of its block; the
// entry's claim is written where its first covered clause (in prompt order)
// stood. Deterministic for a given entry set, whatever the input order.
const renderBlocks = (blocks, applied) => {
  const order = { alv: 0, posting: 1 };
  const owner = new Map();
  for (const entry of applied) {
    for (const clause of entry.covers) {
      if (owner.has(clause)) invalid('clause_covered_twice', clause);
      owner.set(clause, entry);
    }
  }
  const cuts = { alv: [], posting: [] };
  for (const [clauseId, entry] of owner) {
    const clause = FI_POLICY_CLAUSES[clauseId];
    const start = blocks[clause.block].indexOf(clause.text);
    if (start < 0) invalid('clause_text_absent', clauseId);
    cuts[clause.block].push({ start, end: start + clause.text.length, entry });
  }
  const anchored = new Set();
  const rendered = {};
  for (const block of Object.keys(order).sort((a, b) => order[a] - order[b])) {
    const ordered = cuts[block].sort((a, b) => a.start - b.start);
    let out = '';
    let pos = 0;
    for (const cut of ordered) {
      if (cut.start < pos) invalid('clause_overlap', cut.entry.id);
      out += blocks[block].slice(pos, cut.start);
      if (!anchored.has(cut.entry.id)) { out += cut.entry.claim; anchored.add(cut.entry.id); }
      pos = cut.end;
    }
    rendered[block] = out + blocks[block].slice(pos);
  }
  return rendered;
};

const renderSelection = ({ alvNote, postingNote, businessDate, entityType, entries, status, variant, assertEntry }) => {
  if (!Array.isArray(entries)) invalid('entries_not_list');
  const seen = new Set();
  for (const entry of entries) {
    assertEntry(entry);
    if (seen.has(entry.id)) invalid('entry_id_duplicate', entry.id);
    seen.add(entry.id);
  }
  const applied = entries.filter((entry) => applies(entry, { businessDate, entityType }, status))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const blocks = renderBlocks({ alv: alvNote, posting: postingNote }, applied);
  return Object.freeze({
    taxInstructions: `${blocks.alv}\n\n${blocks.posting}`,
    // The selected guidance: the variant and every applied entry, whole. An
    // empty selection still has a digest, so a v8 decision is never a v7 one.
    guidanceDigest: sha256({ variant, entries: applied }),
    entryIds: Object.freeze(applied.map((entry) => entry.id))
  });
};

export const renderFiReviewedGuidance = ({ alvNote, postingNote, businessDate = null, entityType = null,
  entries = entriesInForce } = {}) => renderSelection({ alvNote, postingNote, businessDate, entityType, entries,
  status: 'reviewed', variant: FI_GUIDANCE_VARIANT, assertEntry: assertEntryShape });

// ── FIK-3 provisional arm: offline harness only ──────────────────────────────
// A provisional entry is the FIK-2 shape plus its draft receipt: status
// 'provisional', an author, a drafting date and a rationale, and no reviewer.
// Its source may be recorded before the snapshot is captured (captured_on null
// with snapshot_owed true); a reviewed entry's never may.
const assertProvisionalEntry = (entry) => {
  if (entry?.status !== 'provisional') invalid('provisional_status_required', typeof entry?.id === 'string' ? entry.id : null);
  assertEntryShape(entry);
  const id = entry.id;
  if (!text(entry.author)) invalid('author_missing', id);
  if (!day(entry.drafted_on)) invalid('drafted_on_invalid', id);
  if (!text(entry.rationale)) invalid('rationale_missing', id);
  if (entry.reviewer != null || entry.reviewed_on != null) invalid('provisional_entry_carries_review', id);
};
export const validateFiProvisionalGuidanceEntries = (entries) => {
  if (!Array.isArray(entries) || !entries.length) invalid('provisional_entries_empty');
  const seen = new Set();
  for (const entry of entries) {
    assertProvisionalEntry(entry);
    if (seen.has(entry.id)) invalid('entry_id_duplicate', entry.id);
    seen.add(entry.id);
  }
  return entries;
};

const provisionalScope = new AsyncLocalStorage();
// The ONLY way in: the offline harness runs one arm inside this scope. Every
// coding-policy resolve in that async flow (coder, apply, posting lineage)
// selects the provisional variant; nothing outside the flow can see it. The
// result names the entries the scope actually rendered.
export const __runWithFiProvisionalGuidanceForHarness = async (entries, fn) => {
  const frozen = Object.freeze(structuredClone(validateFiProvisionalGuidanceEntries(entries)).map((entry) => Object.freeze(entry)));
  const store = { entries: frozen, rendered: new Set() };
  const result = await provisionalScope.run(store, fn);
  return { result, renderedEntryIds: [...store.rendered].sort() };
};

// The FI definition's provisional hook. null outside the harness scope, so no
// production resolve can ever select it; inside, the v7 blocks with the
// provisional entries replacing the clauses they cover.
export const renderFiProvisionalGuidance = ({ alvNote, postingNote, businessDate = null, entityType = null } = {}) => {
  const store = provisionalScope.getStore();
  if (!store) return null;
  const rendered = renderSelection({ alvNote, postingNote, businessDate, entityType, entries: store.entries,
    status: 'provisional', variant: FI_PROVISIONAL_GUIDANCE_VARIANT, assertEntry: assertProvisionalEntry });
  for (const id of rendered.entryIds) store.rendered.add(id);
  return Object.freeze({ ...rendered, guidanceVariant: FI_PROVISIONAL_GUIDANCE_VARIANT });
};
