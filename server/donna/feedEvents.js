// Slice 1 of the realtime-truthful-feedback arc
// (docs/design-realtime-truthful-feedback.md): the polled changes-cursor
// projection behind GET /feed-events. Read-side ONLY — this module renders
// persisted receipts (audit_events), persisted pipeline state
// (documents.parse_*), and row-touch signals (transactions.updated_at) so the
// FE can tick without a page refresh. It writes nothing, gates nothing, and
// must never grow a mutation: the streams it reads are the product of the
// "nothing silent" writers, not a place to add semantics.
//
// Cursor design: audit_events.id is a bigserial, so `event_id` is the exact,
// gap-tolerant cursor for events (strictly `id > cursor`, ascending). The
// documents/transactions legs key on `updated_at > ts` — timestamps can tie,
// so a row updated in the same microsecond as the cursor read could repeat on
// the next poll; the FE merge (merge-don't-clobber, the document-chat tick
// pattern) makes repeats harmless, which is why this stays simple instead of
// growing a composite cursor.
//
// Sanitization: the browser never sees raw audit rows. Only whitelisted
// metadata keys pass through (receipt-shaped facts the UI renders), and
// firm-global events (client_id null) are excluded by the client scope —
// this endpoint is per-client by construction, like every other client
// surface.

const FEED_EVENT_METADATA_KEYS = new Set([
  'action_type',
  'action_types',
  'action_index',
  'action_count',
  'surface',
  'requested',
  'applied',
  'failed',
  'account_name',
  'from_review_state',
  'ledger_adjustment_required',
  'original_journal_id',
  'transaction_id',
  'journal_date',
  'reason',
  'correction_journal_ids',
  // Per-row failure detail on feed applies (feedChatApply audit metadata) —
  // our own error strings, capped at the writer; safe to render.
  'errors'
]);

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

const badRequest = (message) => {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
};

export const __sanitizeFeedEvent = (row = {}) => {
  const metadata = {};
  const raw = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  for (const key of Object.keys(raw)) {
    if (FEED_EVENT_METADATA_KEYS.has(key)) metadata[key] = raw[key];
  }
  return {
    id: Number(row.id),
    action: row.action,
    actor_type: row.actor_type || null,
    actor_id: row.actor_id || null,
    resource_type: row.resource_type || null,
    resource_id: row.resource_id || null,
    metadata,
    created_at: row.created_at
  };
};

const sanitizeDocumentDelta = (row = {}) => ({
  id: row.id,
  parse_status: row.parse_status || null,
  parse_stage: row.parse_stage || null,
  parse_progress_current: row.parse_progress_current ?? null,
  parse_progress_total: row.parse_progress_total ?? null,
  // parse_error jsonb can carry internals (stack fragments, provider
  // payloads) — the tick only needs the boolean; the document surface
  // fetches the full row when the user opens it.
  has_parse_error: Boolean(row.parse_error),
  updated_at: row.updated_at
});

const clampLimit = (limit) => {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
};

export const buildFeedEventsFromDb = async ({
  firmId,
  clientId,
  sinceEventId = null,
  sinceTs = null,
  limit = DEFAULT_LIMIT,
  query
} = {}) => {
  if (!firmId) throw badRequest('firm_id is required.');
  if (!clientId) throw badRequest('client_id is required.');
  if (typeof query !== 'function') throw new Error('feedEvents requires a query function.');
  const cappedLimit = clampLimit(limit);

  const hasEventCursor = sinceEventId !== null && sinceEventId !== undefined && String(sinceEventId) !== '';
  const hasTsCursor = sinceTs !== null && sinceTs !== undefined && String(sinceTs) !== '';
  let eventCursor = null;
  if (hasEventCursor) {
    eventCursor = Number(sinceEventId);
    if (!Number.isInteger(eventCursor) || eventCursor < 0) {
      throw badRequest('since_event_id must be a non-negative integer.');
    }
  }
  if (hasTsCursor && Number.isNaN(Date.parse(sinceTs))) {
    throw badRequest('since_ts must be an ISO-8601 timestamp.');
  }

  // Bootstrap (no cursors): hand back the CURRENT high-water marks and no
  // rows. The first poll must not replay history — the page just rendered a
  // fresh snapshot; the tick only carries what happens after it.
  if (!hasEventCursor && !hasTsCursor) {
    const marks = await query(
      `select coalesce(max(id), 0) as max_event_id, now() as ts
         from audit_events
        where firm_id = $1 and client_id = $2`,
      [firmId, clientId]
    );
    const row = marks.rows[0] || {};
    return {
      client_id: clientId,
      events: [],
      documents: [],
      transactions: [],
      cursor: { event_id: Number(row.max_event_id || 0), ts: row.ts }
    };
  }
  if (!hasEventCursor || !hasTsCursor) {
    throw badRequest('since_event_id and since_ts must be provided together (or both omitted to bootstrap).');
  }

  const [eventsResult, documentsResult, transactionsResult] = await Promise.all([
    query(
      `select id, action, actor_type, actor_id, resource_type, resource_id, metadata, created_at
         from audit_events
        where firm_id = $1 and client_id = $2 and id > $3
        order by id asc
        limit $4`,
      [firmId, clientId, eventCursor, cappedLimit]
    ),
    query(
      `select id, parse_status, parse_stage, parse_progress_current, parse_progress_total,
              parse_error, updated_at
         from documents
        where firm_id = $1 and client_id = $2 and updated_at > $3
        order by updated_at asc
        limit $4`,
      [firmId, clientId, sinceTs, cappedLimit]
    ),
    query(
      `select id, updated_at
         from transactions
        where firm_id = $1 and client_id = $2 and updated_at > $3
        order by updated_at asc
        limit $4`,
      [firmId, clientId, sinceTs, cappedLimit]
    )
  ]);

  const events = eventsResult.rows.map(__sanitizeFeedEvent);
  const documents = documentsResult.rows.map(sanitizeDocumentDelta);
  const transactions = transactionsResult.rows.map((row) => ({ id: row.id, updated_at: row.updated_at }));

  // Advance each cursor leg only as far as what was actually returned — a
  // limit-clipped page continues exactly where it stopped on the next poll.
  const nextEventId = events.length ? events[events.length - 1].id : eventCursor;
  const tsCandidates = [
    documents.length ? documents[documents.length - 1].updated_at : null,
    transactions.length ? transactions[transactions.length - 1].updated_at : null
  ].filter(Boolean);
  let nextTs = sinceTs;
  for (const candidate of tsCandidates) {
    if (Date.parse(candidate) > Date.parse(nextTs)) nextTs = candidate;
  }

  return {
    client_id: clientId,
    events,
    documents,
    transactions,
    cursor: { event_id: nextEventId, ts: nextTs }
  };
};
