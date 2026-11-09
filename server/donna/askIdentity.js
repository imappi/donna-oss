// Ask identity — what makes two owner questions THE SAME question.
//
// The 2026-07-29 KUILI BARBACOA loop: the owner uploaded one receipt, was asked
// what the charge was for, re-uploaded the same receipt, and was asked again
// with a NEW Ref. Both asks were open at once for one physical receipt.
//
// The old dedupe was not broken; it was anchored on the wrong thing. It keyed on
// `document:<document.id>`, and every Telegram upload mints a fresh document id
// (derived from the Telegram message id, unique per send). Two uploads of one
// receipt are therefore two documents, two anchors, and two legitimately-distinct
// asks. Nothing in the schema refused it.
//
// The rule this module encodes:
//
//   * an UPLOAD stays an immutable artifact — every send keeps its own document
//     row, its own bytes, its own audit trail. Nothing is overwritten or deleted;
//   * duplicates are MAPPED onto one canonical document (or, when the bytes
//     differ, one canonical CASE), and the ask anchors on that;
//   * an active ask is unique per (canonical anchor, blocker code, generation) —
//     never per upload id, never per raw hash alone, and never per question text,
//     because two drafters can word the same question differently and that must
//     not mint two asks.
//
// Pure and dependency-free: every function here is a total function of its
// arguments, so the identity rules are unit-testable without a database. The DB
// reads that FEED them live in firmDb.js.
import { toIsoDay, toUtcIsoDay } from './dates.js';

// The statuses in which an ask is still live and therefore still occupies its
// anchor. 'resolved' and 'cancelled' are terminal history and may repeat freely,
// which is what lets a legitimate RE-ASK take the next generation.
export const ACTIVE_ASK_STATUSES = Object.freeze(['draft', 'open', 'replied']);

export const isActiveAskStatus = (status) => ACTIVE_ASK_STATUSES.includes(String(status || '').trim());

const squash = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

// Money to a fixed 2dp string so 115.6 and 115.60 are one amount.
//
// Absent, non-numeric, and zero all yield '' — deliberately. `Number(null)` is
// 0, not NaN, so a naive Number() check turns "this document has no total" into
// a confident "0.00" and two totals-less receipts from one vendor would collapse
// into a single ask, silently losing an owner question. A zero total carries no
// identity either. Both must fail towards asking.
const money = (value) => {
  if (value === null || value === undefined || String(value).trim() === '') return '';
  const n = Number(value);
  return Number.isFinite(n) && n !== 0 ? n.toFixed(2) : '';
};

// A date to an ISO day. Accepts a Date, an ISO string, or a bare 'YYYY-MM-DD'.
const isoDay = (value) => {
  if (!value) return '';
  if (value instanceof Date) return toIsoDay(value); // a pg `date`: local midnight
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  // UTC on purpose: an ISO instant string here is a serialized calendar day
  // ('2026-07-28T00:00:00.000Z'), and a case KEY must not depend on the host
  // zone — the same document has to key the same on every machine.
  return toUtcIsoDay(raw);
};

// ── The blocker code ────────────────────────────────────────────────────────
//
// WHAT is blocking this line, as a stable code — never the question's wording.
// `evidence_type` is already that code in this tree ('business_purpose',
// 'supporting_document', 'bank_statement', 'receipt', …), so this normalises
// rather than invents a parallel vocabulary. Two drafters asking about the same
// receipt's business purpose in different words collapse onto one ask; the SAME
// receipt genuinely blocked on two different things (purpose AND a statement)
// stays two asks, which is correct.
export const DEFAULT_BLOCKER_CODE = 'supporting_document';

export const normalizeBlockerCode = (evidenceType) => {
  const code = squash(evidenceType).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return code || DEFAULT_BLOCKER_CODE;
};

// ── The canonical case key (the "or case" route) ────────────────────────────
//
// Two uploads of one receipt are byte-identical only if the owner re-sent the
// same FILE. Re-photographing the same receipt produces different bytes and
// therefore a different checksum, so a hash alone cannot collapse them. The
// extracted identity can: same vendor, same date, same total, same currency, same
// document type, same client is the same receipt for bookkeeping purposes.
//
// Deliberately conservative — it returns '' unless BOTH a vendor-ish party and a
// total are known. A key built from thin extraction would collapse two genuinely
// different receipts into one ask, which loses an owner question. Losing a
// question is worse than asking twice, so this fails towards asking.
export const buildDocumentCaseKey = ({
  documentType = '',
  vendorName = '',
  counterpartyName = '',
  documentDate = '',
  totalAmount = null,
  currency = ''
} = {}) => {
  const party = squash(vendorName) || squash(counterpartyName);
  const total = money(totalAmount);
  if (!party || !total) return '';
  return [
    squash(documentType) || 'document',
    party,
    isoDay(documentDate),
    total,
    squash(currency)
  ].join('|');
};

// ── The anchor ──────────────────────────────────────────────────────────────
//
// Precedence is deliberate and ordered strongest-evidence-first: a bank line is
// the firmest anchor there is, then a review item, then the canonical document,
// then the extracted case. The canonical document id is resolved by the caller
// (firmDb) from the checksum/duplicate pointer that parseDocumentsDb already
// persists — this module never re-derives it, and never touches that writer.
//
// `accountRole` is last, and is the one anchor kind that names no artifact. A
// canonical-role ask ("which of your accounts is the VAT one?") is about the
// CHART, not about any one line or upload: it blocks every VAT-carrying sale at
// once, and it is answered once for the whole book. Anchoring it on whichever
// invoice happened to hit the refusal first would mint a fresh ask per invoice
// for one standing question, which is the KUILI failure in a different costume.
// Ordered last because a role ask never co-occurs with a transaction or a
// document; if one somehow arrives with both, the artifact is the firmer anchor.
export const buildCanonicalAnchor = ({
  transactionId = '',
  reviewItemId = '',
  canonicalDocumentId = '',
  caseKey = '',
  accountRole = '',
  physicalCountLineId = ''
} = {}) => {
  const txn = String(transactionId || '').trim();
  if (txn) return `transaction:${txn}`;
  const review = String(reviewItemId || '').trim();
  if (review) return `review_item:${review}`;
  const doc = String(canonicalDocumentId || '').trim();
  if (doc) return `document:${doc}`;
  const kase = String(caseKey || '').trim();
  if (kase) return `case:${kase}`;
  const physical = String(physicalCountLineId || '').trim();
  if (physical) return `physical_count_line:${physical}`;
  const role = String(accountRole || '').trim();
  if (role) return `account_role:${role}`;
  return '';
};

// ── Reply affordances ───────────────────────────────────────────────────────
//
// The 'dull' half of the KUILI report: the ask template appended "reply with a
// photo, answer in words, or reply 'not sure'" unconditionally, INCLUDING on a
// document-anchored ask where Donna is holding the photo already. Asking the
// owner to send a picture of the receipt she has just read back to him is the
// absurdity, and it is one branch.
//
// So affordances become explicit rather than assumed. A document-anchored ask
// wants words; it must never solicit the artifact it already has.
export const askAffordances = ({ anchor = '', evidenceType = '' } = {}) => {
  const kind = String(anchor || '').split(':')[0];
  const code = normalizeBlockerCode(evidenceType);
  // Donna already holds the artifact for a document/case-anchored ask.
  const holdsDocument = kind === 'document' || kind === 'case';
  // A role-anchored ask has no artifact to want. Donna is holding the client's
  // whole chart of accounts and is asking which line in it means what; there is
  // no photograph of an answer. Soliciting one is the same absurdity the KUILI
  // fix named, so this branch is not an optimisation, it is the same rule.
  const isChartAnchored = kind === 'account_role';
  // A bank-statement ask is the one document-shaped ask that genuinely wants a
  // file even though it may be anchored to a line.
  const wantsDocument = !isChartAnchored && (!holdsDocument || code === 'bank_statement');
  return Object.freeze({
    photo: wantsDocument,
    words: true,
    not_sure: true
  });
};

// The owner-facing tail for an ask, built from its affordances. Voice rule
// (Kari 2026-07-21): never an em or en dash; comma, colon, or a new sentence.
// `language` is the owner's (preferredOwnerTemplateLanguage); anything but 'fi'
// gets the English tail, unchanged. The Finnish 'not sure' keyword it invites
// ("en ole varma") is one assessEvidenceTopicTurn reads.
const ASK_AFFORDANCE_TAIL_COPY = Object.freeze({
  en: Object.freeze({ photo: 'reply with a photo', words: 'answer in words', wordsOnly: 'just reply in words', notSure: "reply 'not sure'", or: ', or ' }),
  fi: Object.freeze({ photo: 'vastaa kuvalla', words: 'kirjoita vastaus', wordsOnly: 'vastaa vain kirjoittamalla', notSure: "vastaa 'en ole varma'", or: ' tai ' })
});

export const renderAskAffordanceTail = (affordances = {}, language = 'en') => {
  const copy = ASK_AFFORDANCE_TAIL_COPY[language] || ASK_AFFORDANCE_TAIL_COPY.en;
  const options = [];
  if (affordances.photo) options.push(copy.photo);
  options.push(affordances.photo ? copy.words : copy.wordsOnly);
  if (affordances.not_sure) options.push(copy.notSure);
  if (options.length === 1) return options[0];
  return `${options.slice(0, -1).join(', ')}${copy.or}${options[options.length - 1]}`;
};
