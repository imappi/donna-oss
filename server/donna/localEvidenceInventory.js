// Local-evidence inventory for irreversible client asks.
//
// A document that is already on Donna's side does not become "missing"
// merely because extraction skipped, routing chose the wrong family, or a
// matcher has not written reconciliation_matches yet.  The ask pipeline uses
// this bounded, deterministic inventory at BOTH draft and send time.  It does
// not decide accounting or create a match; it answers the narrower Keep-layer
// question: "is there already a plausible local artifact that the next
// reconciliation pass must consider before we ask the client to send it?"
//
// Matching is deliberately conservative.  Exact header amount + nearby date
// is enough to hold a send.  An opaque/pending document needs BOTH a nearby
// date encoded in its filename and a distinctive counterparty token.  A false
// positive delays one outbound message and forces another reconciliation
// pass; a false negative asks a client for evidence they already supplied.
import { toIsoDay, toLocalIsoDay } from './dates.js';

const LIVE_PARSE_STATUSES = new Set([
  'pending',
  'processing',
  'completed',
  'skipped',
  'failed'
]);

const GENERIC_TOKENS = new Set([
  'account', 'bank', 'bill', 'business', 'card', 'charge', 'company',
  'corp', 'corporation', 'deposit', 'document', 'invoice', 'inc', 'limited',
  'llc', 'ltd', 'payment', 'payout', 'pdf', 'receipt', 'report', 'statement',
  'transaction', 'transfer', 'unknown'
]);

const MONTHS = Object.freeze({
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12
});

const aliases = (token) => {
  if (token === 'sq' || token === 'gosq') return 'square';
  if (token === 'ubereats') return 'uber';
  if (token === 'doordashinc') return 'doordash';
  if (token === 'usfoods') return 'foods';
  if (token === 'counterculture') return 'culture';
  return token;
};

const words = (value) => String(value || '')
  .normalize('NFKD')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()
  .split(/\s+/)
  .filter(Boolean)
  .map(aliases);

const identityTokens = (value) => words(value)
  .filter((token) => token.length >= 3 && !/^\d+$/.test(token) && !GENERIC_TOKENS.has(token));

const compactIdentity = (value) => identityTokens(value).join('');

const dayNumber = (value) => {
  if (!value) return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return Math.floor(Date.UTC(
      value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()
    ) / 86400000);
  }
  const text = String(value);
  const iso = text.match(/(20\d{2})[-_./](\d{1,2})[-_./](\d{1,2})/);
  if (iso) {
    return Math.floor(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])) / 86400000);
  }
  const named = text.toLowerCase().match(
    /(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)[^0-9]{0,4}(\d{1,2})[^0-9]{0,4}(20\d{2})/
  );
  if (named) {
    const month = MONTHS[named[1]] || MONTHS[named[1].slice(0, 3)];
    if (month) return Math.floor(Date.UTC(Number(named[3]), month - 1, Number(named[2])) / 86400000);
  }
  return null;
};

const isoDay = (value) => {
  if (!value) return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return toIsoDay(value); // a pg `date`: local midnight
  }
  const text = String(value);
  const iso = text.match(/(20\d{2})[-_./](\d{1,2})[-_./](\d{1,2})/);
  if (iso) {
    return `${iso[1]}-${String(iso[2]).padStart(2, '0')}-${String(iso[3]).padStart(2, '0')}`;
  }
  // Free text parses to host-local midnight, so the host-local day is the
  // day the text named (audit F-11).
  return toLocalIsoDay(new Date(text)) || null;
};

const magnitude = (transaction = {}) => {
  const incoming = Math.abs(Number(transaction.money_in || 0));
  const outgoing = Math.abs(Number(transaction.money_out || 0));
  return incoming || outgoing || 0;
};

const textForTransaction = (transaction = {}) => [
  transaction.description,
  transaction.raw_description,
  transaction.cleaned_description,
  transaction.structured_reference
].filter(Boolean).join(' ');

const textForDocument = (document = {}) => [
  document.filename,
  document.vendor_name,
  document.customer_name,
  document.reference_number,
  document.structured_reference
].filter(Boolean).join(' ');

// Batch-common tokens carry no identity. A token that appears across most of
// the client's documents — a jurisdiction tag in every filename ("uae_…"), an
// upload-batch prefix, the client's own name — cannot pick one document out
// of the pile, so treating it as counterparty identity makes nearly every
// line "overlap" nearly every document. The live failure (Desert Rose,
// 2026-09-01): all 41 fixture files began "uae_" and several bank lines said
// "UAE", so one Office Depot charge collected eight absurd candidates and the
// drafter — contract-bound to reference at least one — listed them all at the
// owner. Frequency is computed against THIS batch of documents (deterministic,
// self-calibrating — no hand-kept stop-word list, which would be the exact
// weak-model-era pattern to avoid); a real vendor token never approaches a
// majority of a client's documents. Small doc sets can't establish frequency,
// so pruning only arms at 8+ documents.
const BATCH_COMMON_MIN_DOCUMENTS = 8;
const BATCH_COMMON_FRACTION = 0.5;

export const batchCommonDocumentTokens = (documents = []) => {
  const docs = Array.isArray(documents) ? documents : [];
  if (docs.length < BATCH_COMMON_MIN_DOCUMENTS) return new Set();
  const counts = new Map();
  for (const document of docs) {
    for (const token of new Set(identityTokens(textForDocument(document)))) {
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }
  const threshold = docs.length * BATCH_COMMON_FRACTION;
  return new Set([...counts.entries()]
    .filter(([, count]) => count > threshold)
    .map(([token]) => token));
};

const identityOverlaps = (transaction = {}, document = {}, commonTokens = null) => {
  const drop = commonTokens instanceof Set ? commonTokens : new Set();
  const txText = textForTransaction(transaction);
  const docText = textForDocument(document);
  const txTokens = new Set(identityTokens(txText).filter((token) => !drop.has(token)));
  const docTokens = new Set(identityTokens(docText).filter((token) => !drop.has(token)));
  if ([...txTokens].some((token) => docTokens.has(token))) return true;
  const txCompact = compactIdentity(txText);
  const docCompact = compactIdentity(docText);
  if (!txCompact || !docCompact) return false;
  return [...txTokens, ...docTokens]
    .filter((token) => token.length >= 4)
    .some((token) => txCompact.includes(token) && docCompact.includes(token));
};

const documentDay = (document = {}) =>
  dayNumber(document.document_date) ?? dayNumber(document.filename);

const transactionDay = (transaction = {}) => dayNumber(transaction.transaction_date || transaction.date);

export const localDocumentCandidate = (transaction = {}, document = {}, { commonTokens = null } = {}) => {
  const parseStatus = String(document.parse_status || '');
  if (!LIVE_PARSE_STATUSES.has(parseStatus)) return null;
  if (document.duplicate_of) return null;
  if (String(document.document_type || '') === 'bank_statement') return null;

  const liveMatches = Array.isArray(document.live_match_transaction_ids)
    ? document.live_match_transaction_ids.map(String)
    : [];
  if (liveMatches.length && !liveMatches.includes(String(transaction.id || ''))) return null;

  const txAmount = magnitude(transaction);
  const docAmount = Math.abs(Number(document.total_amount || 0));
  const exactAmount = txAmount > 0 && docAmount > 0 && Math.abs(txAmount - docAmount) <= 0.01;
  const txDay = transactionDay(transaction);
  const docDay = documentDay(document);
  const dayDistance = txDay != null && docDay != null ? Math.abs(txDay - docDay) : null;
  const nearby = dayDistance != null && dayDistance <= 31;
  const close = dayDistance != null && dayDistance <= 14;
  const identity = identityOverlaps(transaction, document, commonTokens);

  let basis = null;
  if (exactAmount && nearby) basis = 'exact_amount_nearby_date';
  else if (exactAmount && identity) basis = 'exact_amount_counterparty';
  else if (identity && close) basis = 'counterparty_nearby_date';
  if (!basis) return null;

  return {
    id: String(document.id),
    filename: String(document.filename || document.id || ''),
    document_type: String(document.document_type || ''),
    parse_status: parseStatus,
    document_date: isoDay(document.document_date),
    total_amount: docAmount || null,
    currency: document.currency || null,
    basis,
    // Days between the line and the document. Carried so consumers can prefer
    // the NEAREST artifact when several share one weak identity token ("cash",
    // "counter") — the same-day slip is the evidence, the rest are siblings.
    // null when either side has no usable date.
    day_distance: dayDistance
  };
};

// The bases that identify a SPECIFIC document rather than merely a coincident
// number. `exact_amount_nearby_date` is amount-only: within a ±31-day window a
// same-amount document of unrelated counterparty qualifies, which is fine for
// this inventory's original job (hold an outbound send, force another
// reconciliation pass — a false positive costs a delay) but NOT for naming a
// file to the owner. Live sighting (Desert Rose, 2026-09-01): a 1,450 Careem
// payout was offered as the evidence for a 1,450 Gulf Food SUPPLIER PAYMENT
// seven days later — `magnitude()` is direction-blind by design, so money-in
// and money-out collide on equal amounts.
const CITABLE_BASES = new Set(['exact_amount_counterparty', 'counterparty_nearby_date']);

// The candidates it is honest to NAME in an owner-facing question. Two rules,
// both learned from the same live book:
//   1. identity-bearing basis only (above);
//   2. nearest-dated first, capped at one by default — where three cash-deposit
//      slips share the token "cash", the slip dated the same day is the answer
//      and citing a sibling twelve days away is a confident false claim.
// The full candidate list is unchanged for every other consumer (the send-hold
// guard and the batch drafter's allowed_document_refs still see all of it).
export const citableEvidenceCandidates = (candidates = [], { limit = 1 } = {}) =>
  (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => CITABLE_BASES.has(candidate?.basis))
    .slice(0, Math.max(0, limit));

// The citable law, extended across a BATCH: one document may be NAMED by at
// most ONE line — the nearest-dated one. Third live sighting (Desert Rose,
// 2026-09-01): four Clover settlements each carried uae_clover_std_jan15.pdf
// as a citable candidate (shared token "clover", every line within the
// 14-day window), and the drafter's output contract — citation required
// whenever any candidate exists — made it assert the SAME statement as the
// evidence for four different payouts. Only the 15 Jan line can be right;
// for the rest the honest ask names nothing. Deterministic: smallest
// day_distance wins the document, undated candidates lose to dated ones,
// transaction id breaks ties. Losing a shared candidate can empty a line's
// citable set — that line asks WITHOUT naming a file (selection
// must_be_empty), which is the truthful shape when the right file for it is
// a date-less unextracted sibling the inventory cannot see.
// Draft and send MUST derive this from the same candidate lists (the
// freshness receipt carries basis + day_distance for exactly this).
export const assignExclusiveCitableEvidence = (candidatesByTransaction = new Map()) => {
  const entries = (candidatesByTransaction instanceof Map
    ? [...candidatesByTransaction.entries()]
    : Object.entries(candidatesByTransaction || {}))
    .map(([transactionId, candidates]) => [
      String(transactionId),
      (Array.isArray(candidates) ? candidates : [])
        .filter((candidate) => CITABLE_BASES.has(String(candidate?.basis || '')))
    ]);
  const winners = new Map(); // document id → { transactionId, distance }
  for (const [transactionId, citable] of entries) {
    for (const candidate of citable) {
      const documentId = String(candidate?.id || candidate?.document_id || '');
      if (!documentId) continue;
      const distance = candidate?.day_distance == null
        ? Number.POSITIVE_INFINITY
        : Number(candidate.day_distance);
      const current = winners.get(documentId);
      if (!current
          || distance < current.distance
          || (distance === current.distance && transactionId < current.transactionId)) {
        winners.set(documentId, { transactionId, distance });
      }
    }
  }
  return new Map(entries.map(([transactionId, citable]) => [
    transactionId,
    citable.filter((candidate) => {
      const documentId = String(candidate?.id || candidate?.document_id || '');
      return documentId && winners.get(documentId)?.transactionId === transactionId;
    })
  ]));
};

// The stale-ask refresh trigger (2026-09-01, the February burst — see
// reconciliationTwinAging.js's supersedable-ask law). A sweep-minted generic
// ask records which citable candidates it named (request_payload.
// citable_local_evidence, stamped at mint and again at every refresh send).
// A line whose open supersedable ask exists is re-fed to the batch drafter
// ONLY when the citable set has genuinely changed since the ask last named it
// — the once-guard that keeps "refresh the wording" from becoming "re-prompt
// the owner every draft". Deliberately keyed on the CITABLE subset (identity-
// bearing bases only): an amount-only coincidence arriving later must never
// re-open a question, the same law that keeps it out of the wording (#1945).
// Compares document-id SETS: a parse-status change on the same file improves
// nothing worth a re-prompt.
export const citableRefreshDue = ({ persisted = [], candidates = [] } = {}) => {
  const currentIds = citableEvidenceCandidates(candidates)
    .map((candidate) => String(candidate?.id || candidate?.document_id || ''))
    .filter(Boolean);
  if (!currentIds.length) return false;
  const persistedIds = new Set((Array.isArray(persisted) ? persisted : [])
    .map((entry) => String(entry?.document_id || entry?.id || ''))
    .filter(Boolean));
  return currentIds.length !== persistedIds.size
    || currentIds.some((id) => !persistedIds.has(id));
};

export const localEvidenceCandidatesByTransaction = ({ transactions = [], documents = [] } = {}) => {
  const out = new Map();
  const commonTokens = batchCommonDocumentTokens(documents);
  for (const transaction of transactions) {
    const candidates = [];
    for (const document of documents) {
      const candidate = localDocumentCandidate(transaction, document, { commonTokens });
      if (candidate) candidates.push(candidate);
    }
    // Nearest-dated first (undated last), id as the stable tiebreak. The order
    // is what `citableEvidenceCandidates` reads to pick the one artifact worth
    // naming, and it also puts the drafter's best candidate first; membership
    // of the list is unchanged, so no consumer loses a candidate.
    candidates.sort((a, b) => {
      const da = a.day_distance == null ? Number.POSITIVE_INFINITY : a.day_distance;
      const db = b.day_distance == null ? Number.POSITIVE_INFINITY : b.day_distance;
      return da === db ? a.id.localeCompare(b.id) : da - db;
    });
    if (candidates.length) out.set(String(transaction.id), candidates.slice(0, 8));
  }
  return out;
};

const rowsOrEmpty = async (promise) => promise.catch((error) => {
  if (error?.code === '42P01' || error?.code === '42703') return { rows: [] };
  throw error;
});

// Real-DB boundary.  The document query is client-scoped and bounded; ask
// batches are already capped at forty transactions, so 500 recent documents
// is a deliberately generous local evidence window without a cross-client
// scan.  Live matches are included so one document cannot suppress asks for a
// different transaction after it has already settled elsewhere.
export const loadLocalEvidenceCandidatesWithClient = async ({
  client,
  firmId,
  clientId,
  transactionIds = [],
  transactions = []
} = {}) => {
  if (!client || !firmId || !clientId) return new Map();
  let transactionRows = Array.isArray(transactions) ? transactions.filter((row) => row?.id) : [];
  const ids = [...new Set((transactionIds || []).filter(Boolean).map(String))];
  if (!transactionRows.length && ids.length) {
    const result = await rowsOrEmpty(client.query(
      `select id, transaction_date, description, raw_description, cleaned_description,
              structured_reference, money_in, money_out, currency
         from transactions
        where firm_id = $1 and client_id = $2 and id = any($3::text[])`,
      [firmId, clientId, ids]
    ));
    transactionRows = result.rows || [];
  }
  if (!transactionRows.length) return new Map();

  const result = await rowsOrEmpty(client.query(
    `select d.id, d.filename, d.document_type, d.parse_status, d.duplicate_of,
            d.vendor_name, d.customer_name, d.document_date, d.total_amount,
            d.currency, d.reference_number, d.structured_reference,
            coalesce(array_remove(array_agg(distinct rm.bank_transaction_id)
              filter (where rm.status in ('suggested', 'auto_matched', 'confirmed')), null), '{}')
              as live_match_transaction_ids
       from documents d
       left join reconciliation_matches rm
         on rm.firm_id = d.firm_id
        and rm.client_id = d.client_id
        and rm.matched_object_id = d.id
      where d.firm_id = $1 and d.client_id = $2
        and coalesce(d.document_type, '') <> 'bank_statement'
        and coalesce(d.parse_status, '') in ('pending', 'processing', 'completed', 'skipped', 'failed')
      group by d.id
      order by d.created_at desc
      limit 500`,
    [firmId, clientId]
  ));
  return localEvidenceCandidatesByTransaction({
    transactions: transactionRows,
    documents: result.rows || []
  });
};

export const localEvidenceCandidateReceipt = (candidateMap = new Map()) =>
  Object.fromEntries([...candidateMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([transactionId, candidates]) => [
      transactionId,
      (candidates || []).map((candidate) => ({
        document_id: candidate.id,
        filename: candidate.filename,
        document_type: candidate.document_type,
        parse_status: candidate.parse_status,
        document_date: candidate.document_date,
        total_amount: candidate.total_amount,
        currency: candidate.currency,
        basis: candidate.basis,
        // Send re-derives the exclusive-citable assignment from this receipt;
        // without the distance a persisted draft could not reproduce which
        // line won a shared document.
        day_distance: candidate.day_distance == null ? null : candidate.day_distance
      }))
    ]));
