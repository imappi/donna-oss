// Pure projections: persisted Donna rows → mobile contract shapes.
//
// Render-the-persisted-verdict: every field comes from a row or a route
// response the server already produced. Where Donna persists nothing for a
// contract field, the projection returns the contract's own absent value
// (null, an omitted optional key, `unchecked`) and the gap is listed in
// GAPS.md — it never infers. No model call, no classifier, no I/O here.

const iso = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};
const plainDate = (value) => {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  const text = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
};
const num = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const str = (value) => {
  const text = value === null || value === undefined ? '' : String(value).trim();
  return text || null;
};

// ── Card identity: `<source.kind>:<source.id>` ─────────────────────────────
export const CARD_KINDS = Object.freeze({
  ask: 'client_evidence_request',
  approval: 'outbound_action',
  fyi: 'outbound_action_sent'
});
export const cardId = (kind, id) => `${kind}:${id}`;
export const parseCardId = (value) => {
  const text = String(value || '');
  const at = text.indexOf(':');
  if (at <= 0) return null;
  const kind = text.slice(0, at);
  const id = text.slice(at + 1);
  return Object.values(CARD_KINDS).includes(kind) && id ? { kind, id } : null;
};

// ── Entity ────────────────────────────────────────────────────────────────
export const projectEntity = (row) => ({
  id: row.id,
  display_name: str(row.company_name) || row.id,
  currency: str(row.profile_currency) || str(row.firm_currency) || 'EUR',
  country: (str(row.jurisdiction) || str(row.firm_jurisdiction) || 'ZZ').toUpperCase(),
  entity_type: str(row.entity_type),
  // Donna has no canonical business-profile aggregate (DESIGN-NOTES smell 9).
  business_profile: null
});

export const projectPrincipal = ({ principal, identity }) => ({
  id: principal.principalId,
  display_name: str(principal.name) || identity.email || principal.principalId,
  email: identity.email || null
});

// ── Asks: open client-audience evidence requests ───────────────────────────
// Lifecycle draft→open→replied→resolved/cancelled. `draft` is the firm's
// unsent draft and never reaches the owner; every other status maps 1:1.
const ASK_STATE = Object.freeze({ open: 'open', replied: 'answered', resolved: 'resolved', cancelled: 'cancelled', rejected: 'cancelled' });

export const isOwnerAsk = (request) => (request?.audience || 'client') === 'client' && request?.status !== 'draft'
  && Boolean(ASK_STATE[request?.status]);

export const projectAskCard = (request, entityId) => {
  const payload = request.request_payload || {};
  const response = request.response_payload || {};
  return {
    id: cardId(CARD_KINDS.ask, request.id),
    entity_id: entityId,
    class: 'ask',
    state: ASK_STATE[request.status],
    title: str(request.question) || 'Donna has a question',
    detail: str(payload.transaction_description) || str(payload.description),
    occurred_on: plainDate(payload.date),
    created_at: iso(request.first_sent_at) || iso(request.created_at),
    amount: num(payload.amount),
    currency: str(payload.currency),
    counterparty: null,
    // No per-ask close-blocking verdict is persisted (the client_evidence
    // close check stores a count, not ask ids) — see GAPS.md.
    blocks_close: false,
    source: { kind: CARD_KINDS.ask, id: request.id },
    transaction_id: request.transaction_id || null,
    document_id: str(payload.document_id),
    ask: {
      question: str(request.question) || '',
      evidence_type: str(request.evidence_type),
      allows_text: true,
      allows_documents: true,
      // Donna's ask pipeline has no choice shape (DESIGN-NOTES smell 1).
      choices: null,
      answered_text: str(response.reply),
      answered_at: iso(request.responded_at)
    }
  };
};

// ── Approvals: outbound actions held for the owner ─────────────────────────
// Only `surface.pending` (status hold_for_approval, approvable). Blocked
// invoices/recurrences offer "don't send", receivable cases offer pause /
// dispute: neither is an approve/reject decision, so neither is served.
export const projectApprovalCard = (action, entityId) => ({
  id: cardId(CARD_KINDS.approval, action.id),
  entity_id: entityId,
  class: 'approval',
  state: 'open',
  title: str(action.description) || 'Donna needs your approval',
  detail: str(action.hold_copy),
  occurred_on: null,
  created_at: iso(action.created_at),
  amount: num(action.amount),
  currency: str(action.currency),
  counterparty: str(action.party_name),
  blocks_close: false,
  source: { kind: CARD_KINDS.approval, id: action.id },
  transaction_id: null,
  document_id: null,
  approval: {
    action_type: action.action_type,
    description: str(action.description) || action.action_type,
    hold_reason: str(action.hold_copy),
    party_name: str(action.party_name),
    batch_key: null,
    decided_at: null
  }
});

// ── FYIs: what Donna already sent under authority ──────────────────────────
export const projectFyiCard = (sent, entityId) => ({
  id: cardId(CARD_KINDS.fyi, sent.id),
  entity_id: entityId,
  class: 'fyi',
  state: sent.marked_wrong_at ? 'flagged' : 'done',
  title: str(sent.description) || 'Donna sent this for you',
  detail: null,
  occurred_on: null,
  created_at: iso(sent.sent_at),
  amount: null,
  currency: null,
  counterparty: null,
  blocks_close: false,
  source: { kind: CARD_KINDS.fyi, id: sent.id },
  transaction_id: null,
  document_id: null,
  fyi: {
    description: str(sent.description) || '',
    done_at: iso(sent.sent_at),
    corrective_verbs: sent.marked_wrong_at ? [] : ['veto_flag'],
    marked_wrong_at: iso(sent.marked_wrong_at)
  }
});

// ONE read → cards AND the badge. needs_you_count is the number of open
// ask+approval cards in the very list returned (the queue doctrine's law).
export const buildQueue = ({ entityId, requests = [], surface = null, generatedAt = new Date() }) => {
  const asks = requests.filter((request) => isOwnerAsk(request) && request.status === 'open')
    .map((request) => projectAskCard(request, entityId));
  const approvals = (surface?.pending || []).map((action) => projectApprovalCard(action, entityId));
  const fyis = (surface?.auto_sent || []).filter((sent) => sent.sent_at).map((sent) => projectFyiCard(sent, entityId));
  const byNewest = (a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''));
  const cards = [...[...asks, ...approvals].sort(byNewest), ...fyis.sort(byNewest)];
  return {
    generated_at: iso(generatedAt),
    needs_you_count: cards.filter((card) => card.state === 'open' && (card.class === 'ask' || card.class === 'approval')).length,
    cards
  };
};

// ── Documents ─────────────────────────────────────────────────────────────
// The owner vocabulary over the persisted parse_status — the same total
// mapping the web portal renders (src/lib/firmDocuments.js
// CLIENT_UPLOAD_STATUS: Received / Reading / Filed / Couldn't read / On file /
// Duplicate), plus `needs_info` exactly when an open owner ask is anchored on
// the document. A null status is `completed`, the snapshot's convention.
const CAPTURE_STATE = Object.freeze({
  pending: 'received',
  processing: 'processing',
  completed: 'attached',
  failed: 'failed',
  skipped: 'stored',
  duplicate_pending: 'duplicate'
});

export const projectDocument = (row, { entityId, openAskByDocument = new Map() } = {}) => {
  const parseStatus = row.parse_status || 'completed';
  const askId = openAskByDocument.get(row.id) || null;
  const captureState = askId && parseStatus === 'completed' ? 'needs_info' : (CAPTURE_STATE[parseStatus] || 'attached');
  return {
    id: row.id,
    entity_id: entityId,
    filename: str(row.filename) || row.id,
    capture_state: captureState,
    uploaded_at: iso(row.uploaded_at) || iso(row.created_at),
    captured_at: iso(row.captured_at),
    document_type: str(row.document_type) === 'unknown' ? null : str(row.document_type),
    document_date: plainDate(row.document_date),
    total_amount: num(row.total_amount),
    currency: str(row.currency),
    counterparty: str(row.vendor_name) || str(row.customer_name),
    needs_info_card_id: captureState === 'needs_info' ? cardId(CARD_KINDS.ask, askId) : null,
    failure_message: captureState === 'failed' ? (str(row.parse_error?.safe_user_message) || null) : null,
    duplicate_of: row.duplicate_of || null
  };
};

const PARSE_STATUSES = new Set(['pending', 'processing', 'completed', 'failed', 'skipped', 'duplicate_pending']);
const PARSE_STAGES = new Set(['fetching', 'extracting', 'writing', 'enriching', 'finalizing']);
export const projectParseStatus = (row) => {
  const error = row.parse_error && typeof row.parse_error === 'object' ? row.parse_error : null;
  return {
    id: row.id,
    parse_status: PARSE_STATUSES.has(row.parse_status) ? row.parse_status : 'completed',
    parse_stage: PARSE_STAGES.has(row.parse_stage) ? row.parse_stage : null,
    parse_progress_current: Number.isInteger(row.parse_progress_current) ? row.parse_progress_current : null,
    parse_progress_total: Number.isInteger(row.parse_progress_total) ? row.parse_progress_total : null,
    parse_error: error
      ? {
        code: String(error.code || 'PARSE_FAILED'),
        safe_user_message: String(error.safe_user_message || 'Donna could not read this file.'),
        retryable: Boolean(error.retryable)
      }
      : null,
    duplicate_of: row.duplicate_of || null,
    parse_completed_at: iso(row.parse_completed_at)
  };
};

// ── Receipts ──────────────────────────────────────────────────────────────
// The audit rows the writer committed for this decision, by id. `terminal`
// says which surface carried the request; the persisted audit row does not
// record it (GAPS.md).
export const projectReceipt = ({ summary, targets, auditRows, at = new Date() }) => ({
  at: iso(auditRows.at(-1)?.created_at) || iso(at),
  summary,
  changes: targets.map(({ target, applied, error = null }) => ({ target, applied, error })),
  checks: null,
  audit_event_ids: auditRows.map((row) => String(row.id)),
  actor: { type: 'owner', terminal: 'mobile' }
});

// ── Status ────────────────────────────────────────────────────────────────
// Plain-language phrasing for the persisted close check codes, next to the
// verdict (DESIGN-NOTES smell 7). `on` names whose move it is; there is no
// third owner. Unknown codes fall back to the check's own persisted summary.
export const BLOCKER_COPY = Object.freeze({
  client_evidence: { on: 'you', label: 'Donna is waiting for your answers to some questions.' },
  source_import: { on: 'you', label: 'Some bank lines or statements are still missing their documents.' },
  posting_completeness: { on: 'donna', label: 'Donna is still entering some of this month’s transactions.' },
  ledger_balance: { on: 'donna', label: 'Donna is checking that the books balance.' },
  xero_mirror: { on: 'donna', label: 'Donna is retrying a copy to your accounting software.' }
});
const OPEN_CHECK_STATUSES = new Set(['open', 'blocked', 'warning']);
const CLOSE_VERDICTS = new Set(['ready', 'review', 'blocked']);
const LIFECYCLES = new Set(['open', 'reviewing', 'closed', 'locked']);

const monthBounds = (date) => {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
  return { period_start: start.toISOString().slice(0, 10), period_end: end.toISOString().slice(0, 10) };
};
const periodLabel = (periodStart, periodEnd, locale) => {
  const start = new Date(`${periodStart}T00:00:00Z`);
  const month = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(start);
  return monthBounds(start).period_end === periodEnd ? month : `${periodStart} – ${periodEnd}`;
};

export const projectPeriod = (period, checks, locale = 'en') => {
  const verdict = period.payload?.close_status;
  return {
    period_start: plainDate(period.period_start),
    period_end: plainDate(period.period_end),
    label: periodLabel(plainDate(period.period_start), plainDate(period.period_end), locale),
    // `unchecked` for a period no checks run has given a verdict.
    state: CLOSE_VERDICTS.has(verdict) ? verdict : 'unchecked',
    lifecycle: LIFECYCLES.has(period.status) ? period.status : 'open',
    completion: null,
    blockers: checks.filter((check) => OPEN_CHECK_STATUSES.has(check.status)).map((check) => {
      const copy = BLOCKER_COPY[check.check_type];
      return {
        code: check.check_type,
        label: copy?.label || str(check.summary) || check.check_type,
        on: copy?.on || 'donna',
        count: Number.isInteger(check.payload?.count) ? check.payload.count : null,
        // The persisted check carries no ask ids (GAPS.md).
        card_ids: null
      };
    })
  };
};

export const buildBooksStatus = ({ periods, checks, queue, requests = [], now = new Date(), locale = 'en' }) => {
  const checksByPeriod = new Map();
  for (const check of checks) {
    if (!checksByPeriod.has(check.close_period_id)) checksByPeriod.set(check.close_period_id, []);
    checksByPeriod.get(check.close_period_id).push(check);
  }
  const projected = periods.map((period) => projectPeriod(period, checksByPeriod.get(period.id) || [], locale));
  const current = monthBounds(now);
  const currentIndex = projected.findIndex((period) => period.period_start === current.period_start);
  const ordered = currentIndex >= 0
    ? [projected[currentIndex], ...projected.filter((_, index) => index !== currentIndex)]
    // The current month has no persisted period row: it is open and unchecked.
    : [{ ...current, label: periodLabel(current.period_start, current.period_end, locale), state: 'unchecked', lifecycle: 'open', completion: null, blockers: [] }, ...projected];
  return {
    as_of: iso(now),
    needs_you_count: queue.needs_you_count,
    // Donna's own open work on the owner's answers: asks the owner answered
    // that Donna has not resolved yet (status `replied`), from the same read.
    donna_working_count: requests.filter((request) => isOwnerAsk(request) && request.status === 'replied').length,
    headline: null,
    periods: ordered
  };
};
