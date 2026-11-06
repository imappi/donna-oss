// Ask-batch view helpers — pure functions behind the firm-side
// "Client asks" surface (ask-batch-panel.jsx). Kept out of the
// component so the staleness rule and the message-markdown parsing are
// unit-testable without a DOM.
//
// The staleness rule mirrors the server's verdicts_as_of contract
// (firmDb.js draft gather): verdicts_as_of is the newest signal the
// draft was based on. Any verdict movement after that instant —
// a new/updated suggestion or an applied coding — means the drafted
// message describes books that have since moved: re-draft, don't send.

const toEpochMs = (value) => {
  if (value == null || value === '') return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

// Latest verdict movement across the client's transactions: the newest
// of each line's suggestion stamp and applied stamp. Transactions in
// the firm snapshot carry payload keys hoisted onto the row
// (ai_suggestion, ai_suggestion_applied_at).
export const latestVerdictMovementMs = (transactions = []) => {
  let latest = 0;
  for (const transaction of transactions) {
    const suggestion = transaction?.ai_suggestion || transaction?.payload?.ai_suggestion || null;
    const candidates = [
      suggestion?.suggested_at,
      transaction?.ai_suggestion_applied_at ?? transaction?.payload?.ai_suggestion_applied_at
    ];
    for (const candidate of candidates) {
      const ms = toEpochMs(candidate);
      if (ms > latest) latest = ms;
    }
  }
  return latest;
};

export const askBatchStaleness = ({ batch = null, transactions = [] } = {}) => {
  const verdictsAsOfMs = toEpochMs(batch?.verdicts_as_of);
  const latestMovementMs = latestVerdictMovementMs(transactions);
  return {
    stale: Boolean(verdictsAsOfMs && latestMovementMs > verdictsAsOfMs),
    verdictsAsOfMs,
    latestMovementMs
  };
};

// The Actions "Waiting on client" lane is the persisted open-ask ledger,
// not the sent-message batch ledger. Drafts have not reached the client and
// replied/resolved requests are no longer the client's move, so neither may
// appear here. Newest sent request first keeps the visible list stable.
export const openClientEvidenceRequests = (requests = []) =>
  (Array.isArray(requests) ? requests : [])
    .filter((request) => String(request?.status || '').toLowerCase() === 'open')
    .sort((a, b) =>
      toEpochMs(b?.first_sent_at || b?.created_at)
      - toEpochMs(a?.first_sent_at || a?.created_at));

// Compact Actions-row fallback for a persisted open ask. The normal path
// reuses buildFirmFeed's exact item; this keeps the identity visible during a
// transient feed/snapshot skew without inventing a second classification.
// Its transaction/document anchors are the same ones the shared artifact
// opener consumes, so activating the row still opens Material's artifact.
export const evidenceRequestListItem = ({ request, transaction = null } = {}) => {
  if (!request?.id) return null;
  const moneyIn = Number(transaction?.money_in) || 0;
  const moneyOut = Number(transaction?.money_out) || 0;
  const question = request.question || request.request_payload?.question || 'Open question to the client';
  return {
    kind: 'client_evidence_request',
    source_id: request.id,
    client_id: request.client_id ?? transaction?.client_id ?? null,
    transaction_id: request.transaction_id ?? null,
    document_id: request.request_payload?.document_id ?? null,
    transaction_date: transaction?.transaction_date || request.first_sent_at || request.created_at || null,
    amount: transaction ? moneyIn - moneyOut : null,
    currency: transaction?.currency ?? null,
    descriptor: transaction?.description || question,
    reason: question,
    counterparty: transaction?.counterparty ?? null,
    verdict: { disposition: 'client_info_needed' }
  };
};

// ── Message-markdown mini parser ──────────────────────────────────────
//
// The drafter writes plain markdown (## headings, - bullets, numbered
// lists, **bold**, `code`). The repo carries no markdown dependency, so
// this renders the four constructs the prompt asks for and treats
// everything else as a paragraph. Inline spans only handle bold and
// code — links and nesting are out of the drafter's vocabulary.

export const parseInlineSpans = (text = '') => {
  const spans = [];
  let remaining = String(text);
  const pattern = /(\*\*([^*]+)\*\*|`([^`]+)`)/;
  while (remaining) {
    const match = remaining.match(pattern);
    if (!match) {
      spans.push({ text: remaining, bold: false, code: false });
      break;
    }
    if (match.index > 0) spans.push({ text: remaining.slice(0, match.index), bold: false, code: false });
    if (match[2] != null) spans.push({ text: match[2], bold: true, code: false });
    else spans.push({ text: match[3], bold: false, code: true });
    remaining = remaining.slice(match.index + match[1].length);
  }
  return spans.filter((span) => span.text);
};

export const parseAskMessageMarkdown = (markdown = '') => {
  const blocks = [];
  for (const rawLine of String(markdown).split('\n')) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) continue;
    const heading = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      blocks.push({ type: 'heading', spans: parseInlineSpans(heading[2]) });
      continue;
    }
    const bullet = trimmed.match(/^[-•]\s+(.*)$/);
    if (bullet) {
      // Indented bullets (the FYI sub-lists) keep their nesting level.
      blocks.push({ type: 'bullet', nested: /^\s{2,}/.test(line), spans: parseInlineSpans(bullet[1]) });
      continue;
    }
    const numbered = trimmed.match(/^(\d+)[.)]\s+(.*)$/);
    if (numbered) {
      blocks.push({ type: 'numbered', marker: numbered[1], spans: parseInlineSpans(numbered[2]) });
      continue;
    }
    blocks.push({ type: 'paragraph', spans: parseInlineSpans(trimmed) });
  }
  return blocks;
};

// The ledger months a draft's items cover — the honest date for the draft
// row's date slot (Kari's 2026-09-01 bug report: with drafts auto-refreshing
// on verdict movement, created_at is always "today", and a wall-clock date
// in a ledger-dated list reads as fresh September data when everything the
// message asks about is June/July). Resolved from the PERSISTED draft items'
// transactions; drafted-at stays in the artifact's audit line. Items whose
// transaction is not in the snapshot are skipped; a draft with nothing
// resolvable (e.g. document-only asks) returns null and the caller renders
// a dash rather than a fabricated date.
const MONTH_SHORT_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const monthKeyShortLabel = (monthKey) =>
  MONTH_SHORT_LABELS[Number(String(monthKey).slice(5, 7)) - 1] || String(monthKey);

export const askBatchCoveredSpanLabel = ({ batch = null, transactions = [] } = {}) => {
  const items = Array.isArray(batch?.draft?.items) ? batch.draft.items : [];
  const transactionById = new Map(
    (Array.isArray(transactions) ? transactions : [])
      .filter((transaction) => transaction?.id)
      .map((transaction) => [transaction.id, transaction])
  );
  const monthKeys = new Set();
  for (const item of items) {
    const transaction = transactionById.get(item?.transaction_id);
    const monthKey = String(transaction?.date || transaction?.transaction_date || '').slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(monthKey)) monthKeys.add(monthKey);
  }
  if (!monthKeys.size) return null;
  const sorted = [...monthKeys].sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  return first === last
    ? monthKeyShortLabel(first)
    : `${monthKeyShortLabel(first)}–${monthKeyShortLabel(last)}`;
};

// Compact "what's in this draft" line for the panel header.
export const askBatchCountsLabel = (counts = {}) => {
  const parts = [];
  const ask = Number(counts.ask || 0);
  const notify = Number(counts.notify || 0);
  const statements = Number(counts.statement_requests || 0);
  if (ask) parts.push(`${ask} question${ask === 1 ? '' : 's'}`);
  if (statements) parts.push(`${statements} statement request${statements === 1 ? '' : 's'}`);
  if (notify) parts.push(`${notify} FYI${notify === 1 ? '' : 's'}`);
  return parts.length ? parts.join(' · ') : 'Nothing to ask';
};
