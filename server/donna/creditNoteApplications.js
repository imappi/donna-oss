// RT-27 — credit notes in the AR matcher's context (2026-09-12).
//
// A customer credit note (documents.payment_status = 'credit_note', the same
// customer as the invoice) reduces an invoice without a bank line. This module
// is the Keep layer around that fact:
//
//   - `loadEligibleCreditNotes`   gathers the customer's open credit notes and
//                                  classifies each against ONE invoice
//                                  (identity, scope, currency, availability,
//                                  linkage) — the compact, accounting-relevant
//                                  view the strong model reasons over;
//   - `formatCreditNotes`          renders them with call-local handles
//                                  (`credit_1..N`, AGENTS.md lesson L — the
//                                  persisted ids never reach the prompt);
//   - `planCreditApplications`     turns the model's SELECTION into exact
//                                  amounts (pure arithmetic: a credit applies
//                                  only to what the invoice still needs);
//   - `lockAndRevalidateCreditNotes` re-reads the selected credits FOR UPDATE
//                                  inside the write transaction (lesson K: the
//                                  model's evidence is revalidated at the
//                                  write statement, never trusted from the
//                                  gather);
//   - `applyCreditApplicationsWithClient` persists exactly which credit went to
//                                  which invoice for what amount, receipted,
//                                  atomically with the settlement it rides;
//   - `reverseCreditApplicationsForMatch/Document` honour a human "no" (a
//                                  rejected settlement, a deleted document)
//                                  by freeing the credit again.
//
// The model chooses; the runtime refuses. Every refusal is a closed code on
// the authorization receipt (`credit_notes.refused[].code`), never a shaded
// amount. No ledger row is written here (INV-1: the settlement journal is the
// bank line's, through the named posting writer; an uploaded credit note is
// never journaled on its own).

import { createHash } from 'node:crypto';
import { documentSourceComponents } from './documentAllocationComponents.js';
import { toIsoDay } from './dates.js';
import { assessDocumentEntityAlignment, readClientIdentityWithClient } from './crossEntityGuard.js';
import { assertEntityReadinessAdmissionWithClient } from './runtimeReadinessAdmission.js';
import { applyDocumentPaymentStatusAfterMatch } from './firmDb.js';
import { applyConvergenceStateBestEffort } from './reconcileConvergenceState.js';
import {
  DOCUMENT_NO_LINE_DISPOSITION_FAMILY,
  DOCUMENT_NO_LINE_DISPOSITION_TARGET_TYPE
} from './documentDispositionShape.js';

export const CREDIT_NOTE_PAYMENT_STATUS = 'credit_note';
export const CREDIT_NOTE_APPLIED_LANE = 'credit_note_applied';
export const INVOICE_CREDITED_IN_FULL_LANE = 'credited_in_full';
export const CREDIT_NOTE_APPLICATION_POLICY_VERSION = 'credit_note_application_v1';
export const CREDIT_NOTE_APPLICATION_SOURCE = 'credit_note_application';
export const CREDIT_APPLICATION_SAVEPOINT = 'donna_credit_application';
// The eligible-credit universe shown to the model per invoice; a customer
// with more open credit notes than this is not a matching problem.
export const MAX_CREDIT_NOTES_PER_CALL = 12;
export const MAX_INVOICES_PER_CREDIT_ARRIVAL = 5;
// Closed refusal / receipt vocabulary. Pinned by creditNoteApplications.test.js.
export const CREDIT_REFUSAL_CODES = Object.freeze({
  NOT_ELIGIBLE: 'credit_not_eligible',
  CURRENCY_MISMATCH: 'credit_currency_mismatch',
  CUSTOMER_MISMATCH: 'credit_customer_mismatch',
  CUSTOMER_UNKNOWN: 'credit_customer_unknown',
  ENTITY_MISMATCH: 'credit_entity_mismatch',
  OTHER_INVOICE: 'credit_references_other_invoice',
  PREDATES_INVOICE: 'credit_predates_invoice',
  EXHAUSTED: 'credit_exhausted',
  NOT_NEEDED: 'credit_not_needed',
  STALE: 'credit_note_stale',
  CONFLICT: 'credit_application_conflict',
  BANK_CURRENCY: 'credit_bank_currency_mismatch',
  AMBIGUOUS: 'ambiguous_credit_notes'
});
export const CREDIT_LINKAGE = Object.freeze({
  LINKED: 'linked',
  UNLINKED: 'unlinked',
  OTHER_INVOICE: 'other_invoice'
});

const DEFAULT_ABS_TOL = 0.01;
const DEFAULT_REL_TOL = 0.005;

export const creditRefForIndex = (index) => `credit_${Number(index) + 1}`;

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const normalizeCurrency = (c) => String(c || '').trim().toUpperCase();
const stripNonAlnum = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

const shortHash = (value = '') => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
};
const slugify = (value = '') =>
  String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);

export const makeCreditApplicationId = ({ clientId, creditDocumentId, invoiceDocumentId, generation = 1 }) => {
  const raw = `${clientId}|${creditDocumentId}|${invoiceDocumentId}|${generation}`;
  const suffix = generation > 1 ? `-g${generation}` : '';
  return `credapp-${slugify(creditDocumentId)}-${slugify(invoiceDocumentId)}${suffix}`.slice(0, 110) + `-${shortHash(raw)}`;
};

// ── identity: does the credit note's customer correspond to the invoice's? ──
// Mirrors the matcher's customer-name discipline (suffix-stripped, token
// overlap) without importing the matcher (keeps this module a leaf of the
// core). Both names must be present: identity is proven positively, never
// assumed from silence.
const CORPORATE_SUFFIXES = new Set([
  'oy', 'oyj', 'ab', 'abp', 'as', 'asa', 'aps', 'ltd', 'limited', 'llc', 'llp', 'plc', 'inc',
  'corp', 'co', 'company', 'gmbh', 'ag', 'sa', 'sas', 'srl', 'spa', 'nv', 'bv', 'kg', 'ky',
  'tmi', 'ry', 'the', 'and'
]);
export const normalizeCustomerIdentity = (value = '') => {
  const cleaned = String(value || '').toLowerCase().replace(/[''ʼ]/g, '').replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  return cleaned.split(' ').filter((t) => t && !CORPORATE_SUFFIXES.has(t)).join(' ');
};
export const customerNamesCorrespond = (a, b) => {
  const x = normalizeCustomerIdentity(a);
  const y = normalizeCustomerIdentity(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
  if (shorter.length >= 4 && longer.includes(shorter)) return true;
  const xt = new Set(x.split(' ').filter((t) => t.length >= 4));
  for (const t of y.split(' ')) if (t.length >= 4 && xt.has(t)) return true;
  return false;
};

// ── linkage: which invoice number(s) does the credit note cite? ─────────────
const referencesOf = (doc = {}) => {
  const summary = doc.parse_summary && typeof doc.parse_summary === 'object' ? doc.parse_summary : {};
  const list = Array.isArray(summary.references) ? summary.references : [];
  return list
    .filter((r) => r && r.value != null && String(r.value).trim())
    .map((r) => ({ type: String(r.type || 'other'), value: String(r.value).trim() }));
};
export const invoiceNumbersOf = (invoice = {}) => {
  const out = new Set();
  for (const v of [invoice.reference_number, invoice.structured_reference]) {
    const n = stripNonAlnum(v);
    if (n.length >= 3) out.add(n);
  }
  for (const r of referencesOf(invoice)) {
    if (r.type === 'invoice_number' || r.type === 'other') {
      const n = stripNonAlnum(r.value);
      if (n.length >= 3) out.add(n);
    }
  }
  return [...out];
};
// The numbers a credit note CITES (never its own primary reference — a credit
// note number is not an invoice number, even when the series is shared).
export const citedInvoiceNumbersOf = (credit = {}) => {
  const own = stripNonAlnum(credit.reference_number);
  const out = new Set();
  for (const r of referencesOf(credit)) {
    if (r.type !== 'invoice_number' && r.type !== 'other') continue;
    const n = stripNonAlnum(r.value);
    if (n.length >= 3 && n !== own) out.add(n);
  }
  return [...out];
};
const numbersCorrespond = (a, b) => {
  // Printed labels are furniture; the actual reference remains exact. A
  // prefix match would treat invoice 2025-0140 as invoice 2025-014.
  const withoutLabel = (value) => String(value || '').replace(/^(?:lasku|invoice|inv|nro|no)/, '');
  return Boolean(a && b) && (a === b || withoutLabel(a) === withoutLabel(b));
};
export const classifyCreditLinkage = ({ credit, invoice, siblingInvoices = [] } = {}) => {
  const cited = citedInvoiceNumbersOf(credit);
  if (!cited.length) return CREDIT_LINKAGE.UNLINKED;
  const mine = invoiceNumbersOf(invoice);
  if (cited.some((c) => mine.some((m) => numbersCorrespond(c, m)))) return CREDIT_LINKAGE.LINKED;
  for (const sibling of siblingInvoices) {
    if (!sibling || sibling.id === invoice.id) continue;
    const theirs = invoiceNumbersOf(sibling);
    if (cited.some((c) => theirs.some((m) => numbersCorrespond(c, m)))) return CREDIT_LINKAGE.OTHER_INVOICE;
  }
  // A printed citation does not become unlinked merely because the other
  // invoice is absent from this upload or beyond the bounded sibling gather.
  return CREDIT_LINKAGE.OTHER_INVOICE;
};

// ── eligibility of ONE credit note against ONE invoice (pure) ───────────────
// Returns { eligible, reasons:[code], linkage, remaining }. Fail-closed: any
// unproven identity axis makes the credit ineligible for THIS invoice (it then
// retains its existing generic document workflow; it is never silently subtracted).
export const classifyCreditNoteEligibility = ({ invoice, credit, siblingInvoices = [] } = {}) => {
  const reasons = [];
  // Credit notes may print a signed reduction or a positive credit amount.
  // Their explicit document status supplies direction; retain the signed
  // source in the evidence fingerprint and consume only its magnitude.
  const remaining = round2(Math.abs(num(credit?.total_amount)) - num(credit?.applied_total));
  if (!invoice?.id || !credit?.id || credit.id === invoice.id) reasons.push(CREDIT_REFUSAL_CODES.NOT_ELIGIBLE);
  if (String(credit?.payment_status || '') !== CREDIT_NOTE_PAYMENT_STATUS) reasons.push(CREDIT_REFUSAL_CODES.NOT_ELIGIBLE);
  const cur = normalizeCurrency(credit?.currency);
  if (!cur || cur !== normalizeCurrency(invoice?.currency)) reasons.push(CREDIT_REFUSAL_CODES.CURRENCY_MISMATCH);
  if (!normalizeCustomerIdentity(credit?.customer_name) || !normalizeCustomerIdentity(invoice?.customer_name)) {
    reasons.push(CREDIT_REFUSAL_CODES.CUSTOMER_UNKNOWN);
  } else if (!customerNamesCorrespond(credit.customer_name, invoice.customer_name)) {
    reasons.push(CREDIT_REFUSAL_CODES.CUSTOMER_MISMATCH);
  }
  const linkage = classifyCreditLinkage({ credit, invoice, siblingInvoices });
  if (linkage === CREDIT_LINKAGE.OTHER_INVOICE) reasons.push(CREDIT_REFUSAL_CODES.OTHER_INVOICE);
  const creditDay = toIsoDay(credit?.document_date);
  const invoiceDay = toIsoDay(invoice?.document_date);
  if (creditDay && invoiceDay && creditDay < invoiceDay) reasons.push(CREDIT_REFUSAL_CODES.PREDATES_INVOICE);
  if (!(remaining > DEFAULT_ABS_TOL)) reasons.push(CREDIT_REFUSAL_CODES.EXHAUSTED);
  return { eligible: reasons.length === 0, reasons, linkage, remaining };
};

const ELIGIBLE_CREDIT_NOTES_SQL = `
  select d.id, d.firm_id, d.client_id, d.document_type, d.vendor_name, d.customer_name, d.document_date, d.total_amount, d.currency, d.reference_number,
         d.structured_reference, d.parse_summary, d.filename, d.payment_status, d.parse_status,
         d.duplicate_of, d.updated_at,
         coalesce((select sum(a.amount) from document_credit_applications a
                    where a.credit_document_id = d.id and a.status = 'applied'), 0) as applied_total,
         coalesce((select sum(a.amount) from document_credit_applications a
                    where a.credit_document_id = d.id and a.invoice_document_id = $3 and a.status = 'applied'), 0) as applied_to_invoice
    from documents d
   where d.firm_id = $1 and d.client_id = $2 and d.id <> $3
     and d.document_type in ('sales_invoice', 'issued_receipt')
     and d.payment_status = 'credit_note'
     and d.parse_status = 'completed'
     and d.total_amount is not null and d.total_amount <> 0
     and d.duplicate_of is null
   order by d.document_date asc nulls last, d.id asc
   limit 200`;

const SIBLING_INVOICES_SQL = `
  select d.id, d.reference_number, d.structured_reference, d.parse_summary
    from documents d
   where d.firm_id = $1 and d.client_id = $2 and d.id <> $3
     and d.document_type in ('sales_invoice', 'issued_receipt')
     and d.payment_status <> 'credit_note'
     and d.parse_status = 'completed'
     and d.duplicate_of is null
   order by d.document_date desc nulls last, d.id desc
   limit 2000`;

// Gather the customer's open credit notes and classify them against this
// invoice. Returns { eligible: [...], ineligible: [...] } where each entry is
// the persisted row plus { linkage, remaining, reasons, snapshot }. The
// snapshot is the evidence fingerprint the write revalidates against.
export const loadEligibleCreditNotes = async ({ client, firmId, clientId, invoice } = {}) => {
  const empty = { eligible: [], ineligible: [] };
  if (!client || !firmId || !clientId || !invoice?.id) return empty;
  const creditsResult = await client.query(ELIGIBLE_CREDIT_NOTES_SQL, [firmId, clientId, invoice.id]);
  const credits = creditsResult.rows || [];
  if (!credits.length) return empty;
  const siblingsResult = await client.query(SIBLING_INVOICES_SQL, [firmId, clientId, invoice.id]);
  const siblingInvoices = siblingsResult.rows || [];
  const eligible = [];
  const ineligible = [];
  for (const credit of credits) {
    const verdict = classifyCreditNoteEligibility({ invoice, credit, siblingInvoices });
    const entry = {
      ...credit,
      total_amount: num(credit.total_amount),
      applied_total: num(credit.applied_total),
      applied_to_invoice: num(credit.applied_to_invoice),
      document_date: toIsoDay(credit.document_date),
      linkage: verdict.linkage,
      remaining: verdict.remaining,
      reasons: verdict.reasons,
      snapshot: creditSnapshot(credit)
    };
    (verdict.eligible ? eligible : ineligible).push(entry);
  }
  return { eligible: eligible.slice(0, MAX_CREDIT_NOTES_PER_CALL), ineligible };
};

// The evidence fingerprint: the fields the plan depended on. A changed field
// between gather and write is a STALE credit (the row moved under the model).
const evidenceSnapshot = (document = {}) => ({
  firm_id: document.firm_id || null,
  client_id: document.client_id || null,
  document_type: document.document_type || null,
  total_amount: round2(num(document.total_amount)),
  currency: normalizeCurrency(document.currency),
  customer: normalizeCustomerIdentity(document.customer_name),
  vendor_name: document.vendor_name || null,
  own_side_parties: (Array.isArray(document.parse_summary?.parties) ? document.parse_summary.parties : [])
    .filter((party) => ['supplier', 'merchant'].includes(String(party?.role || '').toLowerCase()))
    .map((party) => `${party.role}|${party.name || ''}`).sort(),
  document_date: toIsoDay(document.document_date),
  reference_number: document.reference_number || null,
  structured_reference: document.structured_reference || null,
  references: referencesOf(document).map(({ type, value }) => `${type}|${value}`).sort(),
  duplicate_of: document.duplicate_of || null,
  parse_status: String(document.parse_status || '')
});
export const creditSnapshot = (credit = {}) => ({
  ...evidenceSnapshot(credit),
  payment_status: String(credit.payment_status || '')
});

// ── the prompt section (call-local handles only) ────────────────────────────
export const formatCreditNotes = (creditNotes, { docNoun = 'invoice', invoice = null } = {}) => {
  const list = Array.isArray(creditNotes) ? creditNotes.filter((c) => c && c.id) : [];
  if (!list.length) return null;
  const rows = list.map((c, idx) => {
    const link = c.linkage === CREDIT_LINKAGE.LINKED
      ? `cites THIS ${docNoun}'s number`
      : 'cites no invoice number';
    const partly = c.applied_total > 0 ? `; ${c.applied_total.toFixed(2)} already applied elsewhere` : '';
    return `  ${idx + 1}. credit_ref=${creditRefForIndex(idx)}
     date=${c.document_date || 'unknown'}
     amount=${c.total_amount.toFixed(2)} ${c.currency || ''} (available=${c.remaining.toFixed(2)}${partly})
     customer_name="${c.customer_name || ''}"
     credit_note_number="${c.reference_number || ''}"
     linkage: ${link}`;
  });
  const total = invoice ? num(invoice.total_amount) : null;
  return `Customer credit notes that MAY reduce this ${docNoun} (same customer, same currency, still available):
${rows.join('\n')}
How to use them:
- A credit note is not a payment and never appears as a bank line. It reduces what the customer owes on an invoice: invoice total − applied credit(s) = the amount the bank line should carry${total != null ? ` (this ${docNoun}: ${total.toFixed(2)} ${invoice?.currency || ''})` : ''}.
- Select a credit ONLY when this ${docNoun} actually consumes it — the arithmetic closes (bank line + selected credits = the remaining due), or the credit cites this ${docNoun}'s number. Never select a credit merely because the customer has one; an unrelated credit belongs to another invoice.
- Name selected credits on the proposal as "applied_credits": ["credit_1"]. When the credit(s) alone settle what the ${docNoun} still owes and NO bank line is involved, return them at the top level as "credit_applications": [{"credit_ref": "credit_1", "confidence": 0.9, "reasoning": "..."}] with "proposals": [].
- Two credits of the same amount, neither citing an invoice number, are a genuine tie: say so in the reasoning and select at most the one the dates make more plausible — the runtime will refuse the ambiguous application rather than guess.
- credit_ref MUST be a verbatim credit_ref from this list. Credit-note database ids are intentionally not shown.`;
};

// ── the plan: the model's selection → exact amounts (pure) ──────────────────
// A credit applies only to what the invoice still needs after prior settled
// lines and the bank line in hand; never more than the credit's remaining
// availability. Selections that would apply nothing are refused (not
// needed); a selected UNLINKED credit with an equal-amount unlinked twin is a
// genuine ambiguity — refused for automatic application whatever the model's confidence.
export const planCreditApplications = ({
  invoice,
  priorSettled = 0,
  bankAmount = 0,
  bankCurrency = null,
  selectedIds = [],
  creditNotes = [],
  policy = null
} = {}) => {
  const total = num(invoice?.total_amount);
  const tol = Math.max(num(policy?.amountAbsTol) || DEFAULT_ABS_TOL, total * (num(policy?.amountRelTol) || DEFAULT_REL_TOL));
  const byId = new Map((Array.isArray(creditNotes) ? creditNotes : []).filter((c) => c && c.id).map((c) => [String(c.id), c]));
  const selected = [...new Set((Array.isArray(selectedIds) ? selectedIds : []).map((id) => String(id)).filter(Boolean))];
  const refusals = [];
  const applications = [];
  let ambiguity = null;
  if (!selected.length) {
    return { ok: true, applications, refusals, ambiguity, creditTotal: 0, need_before: round2(total - num(priorSettled) - num(bankAmount)), tol };
  }
  if (bankAmount > 0 && normalizeCurrency(bankCurrency) !== normalizeCurrency(invoice?.currency)) {
    for (const id of selected) refusals.push({ credit_document_id: id, code: CREDIT_REFUSAL_CODES.BANK_CURRENCY });
    return { ok: false, applications, refusals, ambiguity, creditTotal: 0, need_before: null, tol };
  }
  let need = round2(total - num(priorSettled) - num(bankAmount));
  const needBefore = need;
  for (const id of selected) {
    const credit = byId.get(id);
    if (!credit) { refusals.push({ credit_document_id: id, code: CREDIT_REFUSAL_CODES.NOT_ELIGIBLE }); continue; }
    if (need <= tol) { refusals.push({ credit_document_id: id, code: CREDIT_REFUSAL_CODES.NOT_NEEDED }); continue; }
    const amount = round2(Math.min(num(credit.remaining), need));
    if (amount <= tol) { refusals.push({ credit_document_id: id, code: CREDIT_REFUSAL_CODES.EXHAUSTED }); continue; }
    applications.push({
      credit_document_id: id,
      amount,
      credit_ref: creditRefForIndex([...byId.keys()].indexOf(id)),
      linkage: credit.linkage || CREDIT_LINKAGE.UNLINKED,
      snapshot: credit.snapshot || creditSnapshot(credit)
    });
    need = round2(need - amount);
  }
  // Ambiguity: an applied UNLINKED credit with an equal-amount, unselected,
  // unlinked twin. Deterministic — independent of the model's confidence.
  for (const app of applications) {
    if (app.linkage === CREDIT_LINKAGE.LINKED) continue;
    const twins = [...byId.values()].filter((c) =>
      String(c.id) !== app.credit_document_id
      && !applications.some((other) => other.credit_document_id === String(c.id)
        && Math.abs(other.amount - num(c.remaining)) <= DEFAULT_ABS_TOL)
      && c.linkage !== CREDIT_LINKAGE.LINKED
      && Math.abs(num(c.remaining) - app.amount) <= tol);
    if (twins.length) {
      ambiguity = { code: CREDIT_REFUSAL_CODES.AMBIGUOUS, selected: app.credit_document_id, competing: twins.map((c) => String(c.id)) };
      break;
    }
  }
  if (ambiguity) {
    for (const app of applications) refusals.push({ credit_document_id: app.credit_document_id, code: CREDIT_REFUSAL_CODES.AMBIGUOUS });
    return { ok: false, applications: [], refusals, ambiguity, creditTotal: 0, need_before: needBefore, tol };
  }
  const creditTotal = round2(applications.reduce((s, a) => s + a.amount, 0));
  return { ok: applications.length > 0, applications, refusals, ambiguity, creditTotal, need_before: needBefore, remaining_after: need, tol, invoice_snapshot: evidenceSnapshot(invoice), prior_settled: num(priorSettled), bank_amount: num(bankAmount) };
};

// Compact receipt for the authorization payload (persisted on the match row
// and on the evaluation stamp).
export const buildCreditReceipt = ({ plan = null, live = null, eligibleCount = 0 } = {}) => {
  const applied = (live?.applications || []).map((a) => ({
    credit_document_id: a.credit_document_id, amount: a.amount, linkage: a.linkage || null, already_applied: a.already_applied === true
  }));
  const refused = [...(plan?.refusals || []), ...(live?.refusals || [])];
  return {
    policy_version: CREDIT_NOTE_APPLICATION_POLICY_VERSION,
    eligible_count: eligibleCount,
    applied,
    applied_total: round2(applied.reduce((s, a) => s + a.amount, 0)),
    refused,
    ambiguity: plan?.ambiguity || null
  };
};

// ── the owned transaction ───────────────────────────────────────────────────
// The match upsert, the credit application and the cascade must commit or
// roll back TOGETHER. The family matchers run on a bare client (no wrapping
// transaction) in the sweep and inside the parse writer's transaction at
// parse time, so this probes: a SAVEPOINT succeeds only inside a transaction
// (25P01 otherwise), in which case it opens and owns one.
export const withCreditApplicationTransaction = async (client, fn) => {
  let mode = 'savepoint';
  try {
    await client.query(`savepoint ${CREDIT_APPLICATION_SAVEPOINT}`);
  } catch (error) {
    if (error?.code !== '25P01') throw error;
    mode = 'owned';
    await client.query('begin');
  }
  try {
    const out = await fn();
    if (mode === 'savepoint') await client.query(`release savepoint ${CREDIT_APPLICATION_SAVEPOINT}`);
    else await client.query('commit');
    return out;
  } catch (error) {
    if (mode === 'savepoint') {
      await client.query(`rollback to savepoint ${CREDIT_APPLICATION_SAVEPOINT}`).catch(() => {});
      await client.query(`release savepoint ${CREDIT_APPLICATION_SAVEPOINT}`).catch(() => {});
    } else {
      await client.query('rollback').catch(() => {});
    }
    throw error;
  }
};

// ── revalidate under the lock ───────────────────────────────────────────────
// Locks the invoice row, then every selected credit row (ids ascending — one
// lock order for every applier), re-reads the live evidence and the live
// applied sums, and re-decides each planned application:
//   stale     — a plan-bearing field moved since the gather;
//   conflict  — a live application for this pair exists at a DIFFERENT amount;
//   exhausted — the live remaining availability no longer covers the amount;
//   idempotent — a live application for this pair at the SAME amount is kept
//                as already_applied (a redelivery is a no-op, never a double).
const LOCK_INVOICE_SQL = `
  select id, firm_id, client_id, document_type, vendor_name, customer_name, total_amount, currency,
         document_date, reference_number, structured_reference, parse_summary,
         payment_status, duplicate_of, parse_status
    from documents where firm_id = $1 and id = $2 for update`;
const LOCK_CREDITS_SQL = `
  select d.id, d.firm_id, d.client_id, d.document_type, d.vendor_name, d.customer_name, d.total_amount, d.currency,
         d.document_date, d.reference_number, d.structured_reference, d.parse_summary,
         d.payment_status, d.duplicate_of, d.parse_status
    from documents d
   where d.firm_id = $1 and d.id = any($2::text[])
   order by d.id asc
     for update`;
const LIVE_APPLIED_SQL = `
  select credit_document_id, invoice_document_id, status, amount
    from document_credit_applications
   where firm_id = $1 and credit_document_id = any($2::text[]) and status = 'applied'`;

export const lockAndRevalidateCreditNotes = async ({ client, firmId, invoice, plan } = {}) => {
  const applications = plan?.applications || [];
  if (!applications.length) return { ok: true, applications: [], refusals: [] };
  const invoiceResult = await client.query(LOCK_INVOICE_SQL, [firmId, invoice.id]);
  const liveInvoice = invoiceResult.rows?.[0];
  if (!liveInvoice || !plan.invoice_snapshot
      || JSON.stringify(evidenceSnapshot(liveInvoice)) !== JSON.stringify(plan.invoice_snapshot)
      || ['credit_note', 'void'].includes(liveInvoice.payment_status)) {
    return { ok: false, applications: [], invoice_fresh: false,
      refusals: applications.map((a) => ({ credit_document_id: a.credit_document_id, code: CREDIT_REFUSAL_CODES.STALE })) };
  }
  const clientIdentity = await readClientIdentityWithClient(client, { firmId, clientId: liveInvoice.client_id });
  if (assessDocumentEntityAlignment({ clientIdentity, document: liveInvoice }).verdict === 'mismatch') {
    return { ok: false, applications: [], invoice_fresh: false,
      refusals: applications.map((a) => ({ credit_document_id: a.credit_document_id, code: CREDIT_REFUSAL_CODES.ENTITY_MISMATCH })) };
  }
  const ids = [...new Set(applications.map((a) => a.credit_document_id))].sort();
  const liveRows = await client.query(LOCK_CREDITS_SQL, [firmId, ids]);
  const live = new Map((liveRows.rows || []).map((r) => [String(r.id), r]));
  const appliedRows = await client.query(LIVE_APPLIED_SQL, [firmId, ids]);
  const appliedTotal = new Map();
  const appliedToInvoice = new Map();
  for (const row of appliedRows.rows || []) {
    const cid = String(row.credit_document_id);
    appliedTotal.set(cid, round2((appliedTotal.get(cid) || 0) + num(row.amount)));
    if (String(row.invoice_document_id) === String(invoice.id)) appliedToInvoice.set(cid, num(row.amount));
  }
  const tol = num(plan?.tol) || DEFAULT_ABS_TOL;
  const accepted = [];
  const refusals = [];
  for (const app of applications) {
    const row = live.get(app.credit_document_id);
    if (!row) { refusals.push({ credit_document_id: app.credit_document_id, code: CREDIT_REFUSAL_CODES.STALE }); continue; }
    if (assessDocumentEntityAlignment({ clientIdentity, document: row }).verdict === 'mismatch') {
      refusals.push({ credit_document_id: app.credit_document_id, code: CREDIT_REFUSAL_CODES.ENTITY_MISMATCH });
      continue;
    }
    const now = creditSnapshot(row);
    const then = app.snapshot || now;
    const same = JSON.stringify(now) === JSON.stringify(then)
      && row.client_id === liveInvoice.client_id && row.firm_id === liveInvoice.firm_id
      && now.payment_status === CREDIT_NOTE_PAYMENT_STATUS
      && now.duplicate_of == null && now.parse_status === 'completed';
    if (!same) { refusals.push({ credit_document_id: app.credit_document_id, code: CREDIT_REFUSAL_CODES.STALE }); continue; }
    const priorForPair = appliedToInvoice.get(app.credit_document_id);
    if (priorForPair != null) {
      if (Math.abs(priorForPair - app.amount) <= tol) { accepted.push({ ...app, already_applied: true }); continue; }
      refusals.push({ credit_document_id: app.credit_document_id, code: CREDIT_REFUSAL_CODES.CONFLICT });
      continue;
    }
    const remainingLive = round2(Math.abs(now.total_amount) - (appliedTotal.get(app.credit_document_id) || 0));
    if (remainingLive + tol < app.amount) { refusals.push({ credit_document_id: app.credit_document_id, code: CREDIT_REFUSAL_CODES.EXHAUSTED }); continue; }
    accepted.push({ ...app, already_applied: false, remaining_live: remainingLive });
  }
  // All-or-nothing: a partly refused selection changes the arithmetic the
  // model reasoned over, so the whole selection stands down (the settlement
  // then decides on the bank line alone; the receipt names every refusal).
  if (refusals.length) return { ok: false, applications: [], refusals, accepted_before_refusal: accepted };
  const settlement = await client.query(INVOICE_SETTLED_SQL, [firmId, invoice.id]);
  const settled = settlement.rows?.[0];
  const alreadyApplied = accepted.filter((a) => a.already_applied).reduce((sum, a) => sum + a.amount, 0);
  const livePrior = round2(num(settled?.settled_by_lines) + num(settled?.settled_by_credits) - alreadyApplied);
  if (Math.abs(livePrior - plan.prior_settled) > DEFAULT_ABS_TOL) {
    return { ok: false, applications: [], invoice_fresh: false,
      refusals: applications.map((a) => ({ credit_document_id: a.credit_document_id, code: CREDIT_REFUSAL_CODES.STALE })) };
  }
  return { ok: true, applications: accepted, refusals: [] };
};

// ── persist ─────────────────────────────────────────────────────────────────
const INSERT_APPLICATION_SQL = `
  insert into document_credit_applications (
    id, firm_id, client_id, credit_document_id, invoice_document_id, amount, currency, status,
    settlement_match_id, applied_by, payload
  ) values ($1, $2, $3, $4, $5, $6, $7, 'applied', $8, $9, $10::jsonb)
  returning id`;
const COUNT_PAIR_ROWS_SQL = `
  select count(*)::int as n from document_credit_applications
   where firm_id = $1 and credit_document_id = $2 and invoice_document_id = $3`;
const CREDIT_LIVE_TOTAL_SQL = `
  select d.total_amount,
         coalesce((select sum(a.amount) from document_credit_applications a
                    where a.credit_document_id = d.id and a.status = 'applied'), 0) as applied_total
    from documents d where d.firm_id = $1 and d.id = $2`;
const INVOICE_SETTLED_SQL = `
  select d.total_amount,
         coalesce((select sum(m.match_amount) from reconciliation_matches m
                    where m.firm_id = d.firm_id and m.matched_object_type = 'sales_invoice'
                      and m.matched_object_id = d.id and m.status in ('confirmed', 'auto_matched')), 0) as settled_by_lines,
         coalesce((select sum(a.amount) from document_credit_applications a
                    where a.invoice_document_id = d.id and a.status = 'applied'), 0) as settled_by_credits
    from documents d where d.firm_id = $1 and d.id = $2`;
const AUDIT_SQL = `
  insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
  values ($1, $2, 'system', $3, $4, 'document', $5, $6::jsonb)`;
const STAMP_HOLDER_SQL = `
  update documents
     set payload = coalesce(payload, '{}'::jsonb) || $3::jsonb,
         updated_at = now()
   where firm_id = $1 and id = $2`;
const APPEND_APPLICATION_RECEIPT_SQL = `
  update documents
     set payload = jsonb_set(coalesce(payload, '{}'::jsonb), '{credit_note_applications}',
                             coalesce(payload->'credit_note_applications', '[]'::jsonb) || $3::jsonb),
         updated_at = now()
   where firm_id = $1 and id = $2`;
const UPSERT_EVALUATION_SQL = `
  insert into reconciliation_evaluations (
    id, firm_id, client_id, target_type, target_id, matcher_family,
    matcher_mode, verdict, unmatchable_reason, proposal_count, candidate_count, eligible_count, model, payload
  ) values ($1, $2, $3, $4, $5, $6, 'llm', 'auto_explained', null, 0, 1, 1, $7, $8::jsonb)
  on conflict (firm_id, client_id, target_type, target_id, matcher_family) do update
    set verdict = excluded.verdict, unmatchable_reason = excluded.unmatchable_reason,
        proposal_count = excluded.proposal_count, candidate_count = excluded.candidate_count,
        eligible_count = excluded.eligible_count, matcher_mode = excluded.matcher_mode,
        model = excluded.model, payload = excluded.payload, evaluated_at = now()`;
const RESOLVE_DOC_ASKS_SQL = `
  update client_evidence_requests
     set status = 'resolved', resolved_at = now(), resolved_by = 'system',
         response_payload = coalesce(response_payload, '{}'::jsonb) || $4::jsonb,
         updated_at = now()
   where firm_id = $1 and client_id = $2
     and request_payload->>'document_id' = $3
     and status in ('draft', 'open', 'replied')
     and evidence_type = any($5::text[])
   returning id, evidence_type`;

const evaluationId = (clientId, targetId) => {
  const raw = `${clientId}|${DOCUMENT_NO_LINE_DISPOSITION_TARGET_TYPE}|${targetId}|${DOCUMENT_NO_LINE_DISPOSITION_FAMILY}`;
  return `recon-eval-${slugify(clientId)}-${slugify(targetId)}-${slugify(DOCUMENT_NO_LINE_DISPOSITION_FAMILY)}`.slice(0, 110) + `-${shortHash(raw)}`;
};

// The no-line disposition holder a settled document rests on: the SAME
// shape the doc-first drain writes (documents.payload.no_line_disposition,
// disposition 'auto_explain' + lane), so the persisted convergence projection,
// the inbox chip and the drain's own skip all read one verdict.
const settleDocumentAsExplained = async ({ client, firmId, clientId, documentId, lane, reasoning, receipt, model, actorId }) => {
  const at = new Date().toISOString();
  const holder = {
    policy_version: CREDIT_NOTE_APPLICATION_POLICY_VERSION,
    disposition: 'auto_explain',
    lane,
    materiality: null,
    expense_kind: 'credit_note',
    settlement_channel: 'credit_note',
    confidence: 1,
    reasoning,
    downgraded_from: null,
    matcher_mode: 'act',
    settled_at: at,
    ...receipt
  };
  await client.query(STAMP_HOLDER_SQL, [firmId, documentId, JSON.stringify({ no_line_disposition: holder })]);
  await client.query(UPSERT_EVALUATION_SQL, [
    evaluationId(clientId, documentId), firmId, clientId,
    DOCUMENT_NO_LINE_DISPOSITION_TARGET_TYPE, documentId, DOCUMENT_NO_LINE_DISPOSITION_FAMILY,
    model || null, JSON.stringify({ ...holder, matcher_mode: 'act' })
  ]);
  await client.query(AUDIT_SQL, [
    firmId, clientId, actorId || 'system', 'document.disposition.auto_explained', documentId,
    JSON.stringify({ ...holder, verdict: 'auto_explained', source: CREDIT_NOTE_APPLICATION_SOURCE })
  ]);
};

// A settled credit note answers the asks that asked how it settled or which
// invoice it reduces; a settled invoice answers its payment/statement asks
// (the D3 law: a business-purpose question about either document stays open;
// a settlement does not establish its business purpose).
const CREDIT_DOC_RESOLVABLE_ASK_TYPES = Object.freeze(['payment_method', 'bank_statement', 'supporting_document']);
const INVOICE_DOC_RESOLVABLE_ASK_TYPES = Object.freeze(['payment_method', 'bank_statement', 'supporting_document']);
const resolveDocumentAsks = async ({ client, firmId, clientId, documentId, types, receipt, resolutionSource = 'credit_application' }) => {
  const result = await client.query(RESOLVE_DOC_ASKS_SQL, [
    firmId, clientId, documentId,
    JSON.stringify({ [`auto_resolved_by_${resolutionSource}`]: true, resolved_review_state: 'resolved', ...receipt }),
    [...types]
  ]);
  const rows = result.rows || [];
  for (const row of rows) {
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
       values ($1, $2, 'system', 'evidence_request.superseded_by_${resolutionSource}', 'client_evidence_request', $3, $4::jsonb)`,
      [firmId, clientId, row.id, JSON.stringify({ document_id: documentId, evidence_type: row.evidence_type, ...receipt })]
    );
  }
  return rows.map((r) => r.id);
};

// Persist the accepted applications (from lockAndRevalidateCreditNotes) for
// ONE invoice, under the caller's transaction (the lock is held there). Writes:
//   - one document_credit_applications row per new application (receipted:
//     reconciliation.credit_note_applied, audit-as-precondition — no receipt,
//     no row);
//   - the credit note's payload receipt, and its auto_explain holder + the
//     drain's evaluation stamp once it is applied in full;
//   - the invoice's sum-based payment_status (bank lines + credits), and its
//     own holder when credits alone settle it in full with no bank line;
//   - the asks a settlement answers, then the persisted convergence verdict
//     of both documents (RT-13, same transaction).
export const applyCreditApplicationsWithClient = async ({
  client, firmId, clientId, invoice, applications = [],
  settlementMatchId = null, actorId = 'system', model = null, authority = null, source = CREDIT_NOTE_APPLICATION_SOURCE
} = {}) => {
  const out = { applied: [], already_applied: [], invoice_payment_status: null, credit_notes_settled: [], invoice_settled_by_credits: false, asks_resolved: [] };
  if (!client || !firmId || !clientId || !invoice?.id) return out;
  await assertEntityReadinessAdmissionWithClient({
    client, firmId, clientId, boundary: 'reconciliation_authority',
    resourceType: 'document_credit_application', resourceId: invoice.id
  });
  const touched = new Set();
  for (const app of applications) {
    if (app.already_applied) { out.already_applied.push(app.credit_document_id); touched.add(app.credit_document_id); continue; }
    const pairCount = await client.query(COUNT_PAIR_ROWS_SQL, [firmId, app.credit_document_id, invoice.id]);
    const generation = Number(pairCount.rows?.[0]?.n || 0) + 1;
    const id = makeCreditApplicationId({ clientId, creditDocumentId: app.credit_document_id, invoiceDocumentId: invoice.id, generation });
    const receipt = {
      source,
      credit_ref: app.credit_ref || null,
      linkage: app.linkage || null,
      snapshot: app.snapshot || null,
      authority: authority || null,
      model: model || null,
      policy_version: CREDIT_NOTE_APPLICATION_POLICY_VERSION
    };
    await client.query(INSERT_APPLICATION_SQL, [
      id, firmId, clientId, app.credit_document_id, invoice.id, app.amount, normalizeCurrency(invoice.currency) || null,
      settlementMatchId, actorId, JSON.stringify(receipt)
    ]);
    await client.query(AUDIT_SQL, [
      firmId, clientId, actorId, 'reconciliation.credit_note_applied', app.credit_document_id,
      JSON.stringify({
        application_id: id, credit_document_id: app.credit_document_id, invoice_document_id: invoice.id,
        amount: app.amount, currency: normalizeCurrency(invoice.currency) || null,
        settlement_match_id: settlementMatchId, linkage: app.linkage || null, authority: authority || null, model: model || null
      })
    ]);
    await client.query(APPEND_APPLICATION_RECEIPT_SQL, [
      firmId, app.credit_document_id,
      JSON.stringify([{ application_id: id, invoice_document_id: invoice.id, amount: app.amount, settlement_match_id: settlementMatchId, at: new Date().toISOString() }])
    ]);
    out.applied.push({ application_id: id, credit_document_id: app.credit_document_id, amount: app.amount });
    touched.add(app.credit_document_id);
  }

  // A credit note applied in full rests explained; a partly applied one keeps
  // its remaining balance visible to the existing generic document workflow.
  for (const creditId of touched) {
    const liveTotal = await client.query(CREDIT_LIVE_TOTAL_SQL, [firmId, creditId]);
    const row = liveTotal.rows?.[0];
    if (!row) continue;
    const remaining = round2(Math.abs(num(row.total_amount)) - num(row.applied_total));
    if (remaining <= DEFAULT_ABS_TOL) {
      await settleDocumentAsExplained({
        client, firmId, clientId, documentId: creditId, lane: CREDIT_NOTE_APPLIED_LANE, model, actorId,
        reasoning: `Credit note applied in full to invoice ${invoice.reference_number || invoice.id}.`,
        receipt: { applied_to_invoice_id: invoice.id, applied_total: round2(num(row.applied_total)), settlement_match_id: settlementMatchId }
      });
      out.credit_notes_settled.push(creditId);
      const resolved = await resolveDocumentAsks({
        client, firmId, clientId, documentId: creditId, types: CREDIT_DOC_RESOLVABLE_ASK_TYPES,
        receipt: { credit_document_id: creditId, invoice_document_id: invoice.id }
      });
      out.asks_resolved.push(...resolved);
    }
  }

  // The invoice: sum-based status now counts credits (db/documents.js).
  await applyDocumentPaymentStatusAfterMatch({ client, firmId, matchId: settlementMatchId, matchedObjectType: 'sales_invoice', documentId: invoice.id });
  const settled = await client.query(INVOICE_SETTLED_SQL, [firmId, invoice.id]);
  const s = settled.rows?.[0];
  if (s) {
    const total = num(s.total_amount);
    const byLines = num(s.settled_by_lines);
    const byCredits = num(s.settled_by_credits);
    out.invoice_payment_status = byLines + byCredits + DEFAULT_ABS_TOL >= total ? 'paid' : (byLines + byCredits > 0 ? 'partial' : 'unpaid');
    if (out.invoice_payment_status === 'paid') {
      const resolved = await resolveDocumentAsks({
        client, firmId, clientId, documentId: invoice.id, types: INVOICE_DOC_RESOLVABLE_ASK_TYPES,
        receipt: { invoice_document_id: invoice.id, settlement_match_id: settlementMatchId }
      });
      out.asks_resolved.push(...resolved);
      if (byLines <= DEFAULT_ABS_TOL && !settlementMatchId) {
        out.invoice_settled_by_credits = true;
        await settleDocumentAsExplained({
          client, firmId, clientId, documentId: invoice.id, lane: INVOICE_CREDITED_IN_FULL_LANE, model, actorId,
          reasoning: 'Invoice credited in full by the customer credit note(s); nothing remains due and no bank line is expected.',
          receipt: { credited_total: byCredits, credit_document_ids: [...touched] }
        });
      }
    }
  }
  await applyConvergenceStateBestEffort(client, { firmId, documentIds: [invoice.id, ...touched] }, { logTag: 'creditNoteApplications' });
  return out;
};

// ── reversal (a human decision or a deleted document frees the credit) ──────
const REVERSE_BY_MATCH_SQL = `
  update document_credit_applications
     set status = 'reversed', reversed_at = now(), updated_at = now(),
         payload = coalesce(payload, '{}'::jsonb) || $3::jsonb
   where firm_id = $1 and settlement_match_id = $2 and status = 'applied'
   returning id, client_id, credit_document_id, invoice_document_id, amount`;
const REVERSE_BY_DOCUMENT_SQL = `
  update document_credit_applications
     set status = 'reversed', reversed_at = now(), updated_at = now(),
         payload = coalesce(payload, '{}'::jsonb) || $3::jsonb
   where firm_id = $1 and (credit_document_id = $2 or invoice_document_id = $2) and status = 'applied'
   returning id, client_id, credit_document_id, invoice_document_id, amount`;
const CLEAR_HOLDER_SQL = `
  update documents
     set payload = payload - 'no_line_disposition', updated_at = now()
   where firm_id = $1 and id = $2
     and payload->'no_line_disposition'->>'lane' = $3`;
const SUPERSEDE_EVALUATION_SQL = `
  update reconciliation_evaluations
     set verdict = 'superseded', payload = coalesce(payload, '{}'::jsonb) || $4::jsonb, evaluated_at = now()
   where firm_id = $1 and target_type = $2 and target_id = $3
     and matcher_family = 'document_no_line_disposition'
     and payload->>'lane' = $5`;

const afterReversal = async ({ client, firmId, rows, reason, actorId }) => {
  const out = { reversed: rows.map((r) => r.id), credit_document_ids: [], invoice_document_ids: [] };
  if (!rows.length) return out;
  const credits = [...new Set(rows.map((r) => r.credit_document_id))];
  const invoices = [...new Set(rows.map((r) => r.invoice_document_id))];
  const clientId = rows[0].client_id;
  for (const creditId of credits) {
    await client.query(CLEAR_HOLDER_SQL, [firmId, creditId, CREDIT_NOTE_APPLIED_LANE]);
    await client.query(SUPERSEDE_EVALUATION_SQL, [firmId, DOCUMENT_NO_LINE_DISPOSITION_TARGET_TYPE, creditId, JSON.stringify({ superseded_by: 'credit_application_reversed', reason }), CREDIT_NOTE_APPLIED_LANE]);
  }
  for (const invoiceId of invoices) {
    await client.query(CLEAR_HOLDER_SQL, [firmId, invoiceId, INVOICE_CREDITED_IN_FULL_LANE]);
    await client.query(SUPERSEDE_EVALUATION_SQL, [firmId, DOCUMENT_NO_LINE_DISPOSITION_TARGET_TYPE, invoiceId, JSON.stringify({ superseded_by: 'credit_application_reversed', reason }), INVOICE_CREDITED_IN_FULL_LANE]);
    await applyDocumentPaymentStatusAfterMatch({ client, firmId, matchId: null, matchedObjectType: 'sales_invoice', documentId: invoiceId });
  }
  for (const row of rows) {
    await client.query(AUDIT_SQL, [
      firmId, clientId, actorId || 'system', 'reconciliation.credit_note_application_reversed', row.credit_document_id,
      JSON.stringify({ application_id: row.id, credit_document_id: row.credit_document_id, invoice_document_id: row.invoice_document_id, amount: num(row.amount), reason })
    ]);
  }
  out.credit_document_ids = credits;
  out.invoice_document_ids = invoices;
  await applyConvergenceStateBestEffort(client, { firmId, documentIds: [...credits, ...invoices] }, { logTag: 'creditNoteApplications' });
  return out;
};

export const reverseCreditApplicationsForMatch = async ({ client, firmId, matchId, reason = 'match_rejected', actorId = 'system' } = {}) => {
  if (!client || !firmId || !matchId) return { reversed: [], credit_document_ids: [], invoice_document_ids: [] };
  const result = await client.query(REVERSE_BY_MATCH_SQL, [firmId, matchId, JSON.stringify({ reversal: { reason, actor_id: actorId, at: new Date().toISOString() } })]);
  return afterReversal({ client, firmId, rows: result.rows || [], reason, actorId });
};

export const reverseCreditApplicationsForDocument = async ({ client, firmId, documentId, reason = 'document_deleted', actorId = 'system' } = {}) => {
  if (!client || !firmId || !documentId) return { reversed: [], credit_document_ids: [], invoice_document_ids: [] };
  const result = await client.query(REVERSE_BY_DOCUMENT_SQL, [firmId, documentId, JSON.stringify({ reversal: { reason, actor_id: actorId, at: new Date().toISOString() } })]);
  // The document being deleted may itself be one of the ids; its holder clear
  // and status recompute are harmless no-ops once the row is gone.
  return afterReversal({ client, firmId, rows: (result.rows || []), reason, actorId });
};

// ── credit-only authorization (no bank line in the call) ────────────────────
// The same gate law as a bank-line match, over the credit application: A the
// model proposed it, B its confidence clears the floor, C the arithmetic
// closes (the plan already refused anything that does not apply), D no
// ambiguity, E the materiality ceiling on the applied credit total. Returns
// the authorization receipt shape upsertMatchAndCascade persists, so
// applyMaterialAutoFyi (the D2 path) can flip a held material application
// exactly as it flips a held material match — no new grant class.
export const authorizeCreditOnlyApplication = ({ confidence, plan, policy, clientAllowed = true } = {}) => {
  const conf = Number(confidence);
  if (!policy?.enabled) return { band: 'suggested', reasons: ['policy_disabled'], gates: {}, secondBestConfidence: 0, policy: null };
  if (!clientAllowed) return { band: 'suggested', reasons: ['client_not_in_auto_match_allowlist'], gates: {}, secondBestConfidence: 0, policy: null };
  const gates = {};
  const reasons = [];
  gates.A = Number.isFinite(conf) && (plan?.applications || []).length > 0;
  if (!gates.A) reasons.push('no_model_proposal');
  gates.B = Number.isFinite(conf) && conf >= num(policy.floor);
  if (!gates.B) reasons.push('below_floor');
  gates.C = plan?.ok === true && (plan.refusals || []).length === 0;
  if (!gates.C) reasons.push('amount_or_currency_unreconciled');
  gates.D = !plan?.ambiguity;
  if (!gates.D) reasons.push('ambiguous_candidates');
  const ceilingSet = Number.isFinite(policy.materialityCeiling);
  gates.E = ceilingSet && num(plan?.creditTotal) <= policy.materialityCeiling;
  if (!gates.E) reasons.push(ceilingSet ? 'above_materiality_ceiling' : 'materiality_ceiling_unset');
  const auto = gates.A && gates.B && gates.C && gates.D && gates.E;
  return {
    band: auto ? 'auto_matched' : 'suggested',
    reasons: auto ? ['all_gates_passed'] : reasons,
    gates,
    secondBestConfidence: 0,
    policy: {
      floor: policy.floor, separation: policy.separation, materiality_ceiling: policy.materialityCeiling,
      materiality_ceiling_source: policy.materialityCeilingSource ?? null, currency: policy.materialityCeilingCurrency ?? null
    }
  };
};

// ── the credit-note arrival: which invoices should reconsider? ──────────────
// A credit note's own matching pass has nothing to match (no bank line ever
// carries it). Its arrival instead wakes the customer's invoices that still
// owe something, so the existing clock (the parse-time trigger and the sweep)
// converges in BOTH orders: credit-before-payment and payment-before-credit.
const OPEN_INVOICES_FOR_CREDIT_SQL = `
  select d.id, d.customer_name, d.currency, d.total_amount, d.document_date, d.reference_number,
         d.structured_reference, d.parse_summary, d.payment_status,
         coalesce((select sum(m.match_amount) from reconciliation_matches m
                    where m.firm_id = d.firm_id and m.matched_object_type = 'sales_invoice'
                      and m.matched_object_id = d.id and m.status in ('confirmed', 'auto_matched')), 0) as settled_by_lines,
         coalesce((select sum(a.amount) from document_credit_applications a
                    where a.invoice_document_id = d.id and a.status = 'applied'), 0) as settled_by_credits
    from documents d
   where d.firm_id = $1 and d.client_id = $2 and d.id <> $3
     and d.document_type in ('sales_invoice', 'issued_receipt')
     and d.payment_status not in ('credit_note', 'void')
     and d.parse_status = 'completed'
     and d.total_amount is not null and d.total_amount > 0
     and d.duplicate_of is null
   order by d.document_date desc nulls last, d.id desc
   limit 400`;

export const loadInvoicesToReconsiderForCreditNote = async ({ client, firmId, clientId, creditNote } = {}) => {
  if (!client || !firmId || !clientId || !creditNote?.id) return [];
  const result = await client.query(OPEN_INVOICES_FOR_CREDIT_SQL, [firmId, clientId, creditNote.id]);
  const rows = (result.rows || []).map((r) => ({
    ...r,
    total_amount: num(r.total_amount),
    remaining_due: round2(num(r.total_amount) - num(r.settled_by_lines) - num(r.settled_by_credits))
  }));
  const open = rows.filter((inv) => inv.remaining_due > DEFAULT_ABS_TOL);
  const verdicts = open.map((inv) => ({ invoice: inv, verdict: classifyCreditNoteEligibility({ invoice: inv, credit: creditNote, siblingInvoices: rows }) }));
  // Linked invoices first, then the rest of the customer's open invoices.
  const eligible = verdicts.filter((v) => v.verdict.eligible);
  eligible.sort((a, b) => (a.verdict.linkage === CREDIT_LINKAGE.LINKED ? -1 : 0) - (b.verdict.linkage === CREDIT_LINKAGE.LINKED ? -1 : 0));
  return eligible.slice(0, MAX_INVOICES_PER_CREDIT_ARRIVAL).map((v) => ({ ...v.invoice, linkage: v.verdict.linkage }));
};

export const __round2 = round2;

// A reminder and its original invoice represent one principal obligation.
// The model selects this relationship; source arithmetic only binds its amounts.
export function planReminderObligation({ reminder, invoice } = {}) {
  const refuse = reason => ({ ok: false, reason });
  if (!reminder || !invoice || reminder.id === invoice.id
    || reminder.firm_id !== invoice.firm_id || reminder.client_id !== invoice.client_id
    || reminder.parse_status !== 'completed' || invoice.parse_status !== 'completed'
    || (invoice.parse_summary?.document_type || invoice.document_type) !== 'sales_invoice'
    || (reminder.parse_summary?.document_type || reminder.document_type) !== 'sales_invoice') return refuse('reminder_source_scope');
  if (normalizeCurrency(reminder.currency) !== normalizeCurrency(invoice.currency)) return refuse('reminder_currency');
  const customer = doc => normalizeCustomerIdentity(doc.customer_name || doc.parse_summary?.counterparty_name);
  if (!customer(reminder) || customer(reminder) !== customer(invoice)) return refuse('reminder_customer');
  const originalRefs = invoiceNumbersOf(invoice);
  const cited = referencesOf(reminder).filter(r => r.type === 'invoice_number' || r.type === 'other').map(r => stripNonAlnum(r.value));
  if (!originalRefs.some(ref => cited.includes(ref))) return refuse('reminder_reference');
  if (!toIsoDay(invoice.document_date) || !toIsoDay(reminder.document_date)
    || toIsoDay(reminder.document_date) < toIsoDay(invoice.document_date)) return refuse('reminder_date');
  const components = documentSourceComponents(reminder);
  const original = documentSourceComponents(invoice);
  if (!components.complete || !components.tax_complete || !original.complete || !original.tax_complete) return refuse('reminder_components_incomplete');
  const principal = components.components.filter(line => round2(line.gross) === round2(invoice.total_amount));
  if (principal.length !== 1 || components.components.length < 2 || Number(reminder.total_amount) <= Number(invoice.total_amount)) return refuse('reminder_principal_ambiguous');
  if (round2(principal[0].source_tax) !== round2(original.source_tax)) return refuse('reminder_principal_tax_conflict');
  const principalAmount = round2(principal[0].gross), chargesAmount = round2(Number(reminder.total_amount) - principalAmount);
  const facts = { invoice_document_id: invoice.id, reminder_document_id: reminder.id, principal_line_handle: principal[0].line_handle,
    currency: normalizeCurrency(invoice.currency), principal_amount: principalAmount, principal_tax: original.source_tax, charges_amount: chargesAmount,
    invoice_date: toIsoDay(invoice.document_date), reminder_date: toIsoDay(reminder.document_date), customer: customer(invoice),
    references: originalRefs.filter(ref => cited.includes(ref)).sort(), components: components.components };
  return { ok: true, version: 1, ...facts, source_digest: createHash('sha256').update(JSON.stringify(facts)).digest('hex') };
}

export async function applyReminderSettlementWithClient({ client, firmId, clientId, matchId,
  reminderDocumentId, invoiceDocumentId, plan, actorId, model } = {}) {
  const refuse = reason => { throw Object.assign(new Error(reason), { code: 'REMINDER_OBLIGATION_REFUSED', statusCode: 409 }); };
  if (!plan?.ok || !actorId || !model || !matchId) refuse('A selected reminder relationship and authority receipt are required.');
  const ids = [reminderDocumentId, invoiceDocumentId].sort();
  const documents = (await client.query(`select * from documents where firm_id=$1 and client_id=$2 and id=any($3::text[]) order by id for update`, [firmId,clientId,ids])).rows;
  const lines = (await client.query(`select * from document_lines where firm_id=$1 and client_id=$2 and document_id=any($3::text[]) order by document_id,line_no,id for update`, [firmId,clientId,ids])).rows;
  const document = id => { const row=documents.find(d=>d.id===id);return row?{...row,lines:lines.filter(l=>l.document_id===id)}:null; };
  const reminder=document(reminderDocumentId),invoice=document(invoiceDocumentId);
  const current=planReminderObligation({reminder,invoice});
  if (!current.ok || current.source_digest!==plan.source_digest) refuse('The selected reminder facts changed; reconsider the current source.');
  const identity=await readClientIdentityWithClient(client,{firmId,clientId});
  if ([reminder,invoice].some(d=>assessDocumentEntityAlignment({clientIdentity:identity,document:d}).verdict==='mismatch')) refuse('A source belongs to another company.');
  const match=(await client.query(`select * from reconciliation_matches where firm_id=$1 and client_id=$2 and id=$3 for update`,[firmId,clientId,matchId])).rows[0];
  if (!match || match.matched_object_id!==reminderDocumentId || !['confirmed','auto_matched'].includes(match.status)
    || round2(match.match_amount)!==round2(reminder.total_amount)) refuse('The reminder must have its full current settled bank relationship.');
  const existing=match.payload?.reminder_obligation;
  if (existing?.status==='applied' && existing.source_digest===current.source_digest) return existing;
  if (existing?.status==='applied') refuse('This payment already carries another reminder relationship.');
  const other=(await client.query(`select id from reconciliation_matches where firm_id=$1 and client_id=$2 and id<>$3
    and status in ('confirmed','auto_matched') and (matched_object_id=$4
      or (payload->'reminder_obligation'->>'invoice_document_id'=$4 and payload->'reminder_obligation'->>'status'='applied')) limit 1`,[firmId,clientId,matchId,invoiceDocumentId])).rows[0];
  if (other) refuse('The original invoice already has a settled payment; this reminder cannot settle it twice.');
  const credits=(await client.query(`select id from document_credit_applications where firm_id=$1 and invoice_document_id=$2 and status='applied' limit 1`,[firmId,invoiceDocumentId])).rows;
  if (credits.length) refuse('The original invoice has applied credits; reconsider the remaining obligation.');
  const receipt={...current,status:'applied',settlement_match_id:matchId,bank_transaction_id:match.bank_transaction_id,
    actor_id:actorId,authority_basis:'selected_reminder_obligation',model};
  await client.query(`update reconciliation_matches set payload=payload || jsonb_build_object('reminder_obligation',$4::jsonb),updated_at=now() where firm_id=$1 and client_id=$2 and id=$3`,[firmId,clientId,matchId,JSON.stringify(receipt)]);
  await client.query(`update documents set payload=payload || jsonb_build_object('reminder_obligation',$4::jsonb),updated_at=now() where firm_id=$1 and client_id=$2 and id=any($3::text[])`,[firmId,clientId,ids,JSON.stringify(receipt)]);
  await applyDocumentPaymentStatusAfterMatch({client,firmId,matchId,matchedObjectType:'sales_invoice',documentId:invoiceDocumentId});
  await settleDocumentAsExplained({client,firmId,clientId,documentId:invoiceDocumentId,lane:'settled_through_reminder',actorId,model,
    reasoning:'The reminder payment settles this original invoice once; the additional reminder charges are separate components.',
    receipt:{...receipt,expense_kind:'invoice',settlement_channel:'bank',policy_version:'reminder_obligation_v1'}});
  await resolveDocumentAsks({client,firmId,clientId,documentId:invoiceDocumentId,types:INVOICE_DOC_RESOLVABLE_ASK_TYPES,receipt,resolutionSource:'reminder_settlement'});
  await applyConvergenceStateBestEffort(client,{firmId,documentIds:ids,transactionIds:[match.bank_transaction_id]},{logTag:'reminderSettlement'});
  return receipt;
}

export async function reverseReminderSettlementWithClient({client,firmId,matchId,reason='match_rejected',actorId='system'}={}) {
  const match=(await client.query(`select id,client_id,payload from reconciliation_matches where firm_id=$1 and id=$2 for update`,[firmId,matchId])).rows[0];
  const receipt=match?.payload?.reminder_obligation;
  if (receipt?.status!=='applied') return null;
  const reversed={...receipt,status:'reversed',reversal:{reason,actor_id:actorId}};
  await client.query(`update reconciliation_matches set payload=payload || jsonb_build_object('reminder_obligation',$3::jsonb),updated_at=now() where firm_id=$1 and id=$2`,[firmId,matchId,JSON.stringify(reversed)]);
  const ids=[receipt.invoice_document_id,receipt.reminder_document_id];
  await client.query(`update documents set payload=payload || jsonb_build_object('reminder_obligation',$3::jsonb),updated_at=now()
    where firm_id=$1 and id=any($2::text[]) and payload->'reminder_obligation'->>'settlement_match_id'=$4`,[firmId,ids,JSON.stringify(reversed),matchId]);
  await client.query(CLEAR_HOLDER_SQL,[firmId,receipt.invoice_document_id,'settled_through_reminder']);
  await client.query(SUPERSEDE_EVALUATION_SQL,[firmId,DOCUMENT_NO_LINE_DISPOSITION_TARGET_TYPE,receipt.invoice_document_id,JSON.stringify({superseded_by:'reminder_settlement_reversed',reason}),'settled_through_reminder']);
  await applyDocumentPaymentStatusAfterMatch({client,firmId,matchId:null,matchedObjectType:'sales_invoice',documentId:receipt.invoice_document_id});
  await client.query(AUDIT_SQL,[firmId,match.client_id,actorId,'reconciliation.reminder_settlement_reversed',receipt.invoice_document_id,JSON.stringify(reversed)]);
  await applyConvergenceStateBestEffort(client,{firmId,documentIds:ids},{logTag:'reminderSettlement'});
  return reversed;
}
