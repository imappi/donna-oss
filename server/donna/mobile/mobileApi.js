// Donna mobile API — the owner-scoped adapter behind the phone app's contract
// (server/donna/mobile/contract/mobile-api.yaml, pinned from
// imappi/donna-mobile-oss; GAPS.md lists where Donna cannot say what the
// contract asks).
//
// THE ADAPTER RULE: this module is a router over existing reads and existing
// named writers. It holds no accounting logic. Every mutation is an existing
// firm route run in-process with the caller's verified identity
// (mobileDispatch.js), so it passes the same assertFirmAccess, entitlement,
// readiness and capability checks as the web portal and has the same
// consequences. The adapter's own work is: authenticate, admit only an owner,
// map the contract's closed request shapes onto those routes, and project the
// persisted result back (mobileProjection.js).
//
// Mounted at MOBILE_API_PATH_PREFIX (point the app's EXPO_PUBLIC_API_URL at
// it). Dispatched from api.js BEFORE requireDonnaAccess, the way the hosted
// MCP adapter is: this surface has its own token flow, and it must never
// accept the shared DONNA_ACCESS_TOKEN (the admin token) or fall open when no
// access token is configured.
//
// Kill switch: DONNA_MOBILE_API=off answers every request (sign-in included)
// 503 MOBILE_API_DISABLED. The environment can only turn this surface OFF.
//
// CORS (the app also ships as a web build): any origin, never credentials.
// Authentication is a bearer token the app attaches itself; there are no
// cookies, so a cross-site page gains nothing a non-browser client lacks and
// no request rides ambient authority.
import {
  createSignInLimiter,
  mobileError,
  ownerScopeForEntity,
  passwordGrant,
  refreshGrant,
  resolveMobileOwner,
  revokeSession
} from './mobileAuth.js';
import { confirmBusinessProfile } from './mobileBusinessProfile.js';
import { createFirmRouteDispatcher } from './mobileDispatch.js';
import {
  buildBooksStatus,
  buildQueue,
  CARD_KINDS,
  isOwnerAsk,
  parseCardId,
  projectApprovalCard,
  projectAskCard,
  projectDocument,
  projectEntity,
  projectFyiCard,
  projectParseStatus,
  projectPrincipal,
  projectReceipt
} from './mobileProjection.js';
import {
  readAuditRowsSince,
  readAuditWatermark,
  readClosePeriods,
  readDocuments,
  readDocumentsById,
  readEntities,
  readOpenDocumentAsks,
  readOutboundAction,
  readOwnerName
} from './mobileReads.js';
import { describePendingAction } from '../outbound/ownerDigest.js';

export const MOBILE_API_PATH_PREFIX = '/api/donna/mobile/v1';
export const isMobileApiPath = (pathname) =>
  pathname === MOBILE_API_PATH_PREFIX || String(pathname || '').startsWith(`${MOBILE_API_PATH_PREFIX}/`);

export const isMobileApiDisabled = (env = process.env) =>
  ['off', '0', 'false', 'disabled'].includes(String(env.DONNA_MOBILE_API || '').trim().toLowerCase());

const signInLimiter = createSignInLimiter();
export const __resetMobileSignInLimiterForTests = () => signInLimiter.reset();

const MAX_BODY_BYTES = 256 * 1024;
const UPLOAD_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf', 'text/csv']);
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;
const DECISION_TYPES = new Set(['approve', 'reject', 'answer', 'veto_flag']);

// ── Plumbing ──────────────────────────────────────────────────────────────

const applyHeaders = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, Accept-Language, X-Audio-Filename, X-Audio-Duration-Seconds');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
};

const send = (res, status, body) => {
  res.statusCode = status;
  if (body === undefined) {
    res.end();
    return;
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
};

const readJson = async (req) => {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw mobileError(413, 'REQUEST_BODY_TOO_LARGE', 'Request body too large.');
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw mobileError(400, 'BAD_REQUEST', 'The request body must be a JSON object.');
  }
};

const bearerOf = (req) => {
  const match = String(req.headers?.authorization || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
};
const clientAddress = (req) => String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim()
  || req.socket?.remoteAddress || 'unknown';
const localeOf = (req) => (/^fi\b/i.test(String(req.headers?.['accept-language'] || '')) ? 'fi' : 'en');
const badRequest = (message, code = 'BAD_REQUEST') => mobileError(400, code, message);
// The origin an absolute upload URL is built on. api.js resolvePublicOrigin
// is the owner (configured base URL, then forwarded headers, defaulting to
// https for the proxied cloud host). A request that reached this process over
// plain HTTP with no proxy in front (local dev, a LAN runtime) gets http, or
// the phone would be handed an https URL nothing is listening on.
const uploadOrigin = (req, deps) => {
  const origin = deps.publicOrigin(req);
  const configured = String(process.env.PUBLIC_APP_URL || process.env.APP_BASE_URL || '').trim();
  if (configured || req.headers?.['x-forwarded-proto'] || req.socket?.encrypted || !req.socket) return origin;
  return origin.replace(/^https:/, 'http:');
};

// A firm route's refusal, surfaced in the contract's error envelope.
const routeFailure = (response, fallback) => mobileError(
  response.status >= 400 ? response.status : 502,
  response.body?.code || fallback,
  response.body?.error || 'Donna could not complete this request.'
);
const expectOk = (response, fallback) => {
  if (response.status < 200 || response.status >= 300) throw routeFailure(response, fallback);
  return response.body || {};
};

// ── Identity ──────────────────────────────────────────────────────────────

// The verified identity of a bearer token, via the same resolver every firm
// route uses. Only an identity-provider user is accepted: the shared access
// token and the cron secret are refused here.
const verifiedIdentity = async (deps, token) => {
  if (!token) throw mobileError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
  const probe = { headers: { authorization: `Bearer ${token}` } };
  const resolved = await deps.resolveAuth(probe);
  const auth = resolved?.type === 'supabase_user' ? resolved : probe.donnaVerifiedIdentity;
  if (auth?.type !== 'supabase_user') throw mobileError(401, 'AUTH_REQUIRED', 'The session has expired. Sign in again.');
  return auth;
};

const meBody = async (owner) => {
  const entities = [];
  for (const { firmId, clientIds } of owner.owners) {
    for (const row of await readEntities({ firmId, clientIds })) entities.push(projectEntity(row));
  }
  const first = owner.owners[0];
  const name = await readOwnerName({ firmId: first.firmId, principalId: first.principal.principalId });
  return {
    principal: projectPrincipal({ principal: { ...first.principal, name }, identity: owner.identity }),
    entities,
    default_entity_id: entities[0]?.id || first.clientIds[0]
  };
};

// Mint the contract Session for a fresh token pair, or refuse — revoking the
// just-minted provider session so a refused staff sign-in leaves nothing live.
const sessionFor = async (deps, tokens) => {
  try {
    const auth = await verifiedIdentity(deps, tokens.access_token);
    const owner = await resolveMobileOwner(auth);
    return { ...tokens, ...(await meBody(owner)) };
  } catch (error) {
    await revokeSession(deps.identityProvider, tokens.access_token).catch(() => false);
    throw error;
  }
};

// ── Queue ─────────────────────────────────────────────────────────────────

const readQueueSources = async (ctx) => {
  const [requests, actions] = await Promise.all([
    ctx.dispatch({ path: '/evidence/requests', query: { firm_id: ctx.firmId, client_id: ctx.clientId } }),
    ctx.dispatch({ path: '/outbound/owner-actions', query: { firm_id: ctx.firmId, client_id: ctx.clientId } })
  ]);
  return {
    requests: expectOk(requests, 'QUEUE_READ_FAILED').requests || [],
    surface: expectOk(actions, 'QUEUE_READ_FAILED').surface || null
  };
};

const findCard = async (ctx, rawCardId) => {
  const parsed = parseCardId(rawCardId);
  if (!parsed) throw mobileError(404, 'NOT_FOUND', 'No such card.');
  const { requests, surface } = await readQueueSources(ctx);
  if (parsed.kind === CARD_KINDS.ask) {
    const request = requests.find((row) => row.id === parsed.id && isOwnerAsk(row));
    if (request) return { parsed, request, card: projectAskCard(request, ctx.clientId) };
  } else if (parsed.kind === CARD_KINDS.approval) {
    const pending = (surface?.pending || []).find((row) => row.id === parsed.id);
    if (pending) return { parsed, card: projectApprovalCard(pending, ctx.clientId) };
    const row = await readOutboundAction({ firmId: ctx.firmId, clientId: ctx.clientId, actionId: parsed.id });
    if (row?.gate_verdict === 'hold_for_approval' || row?.approved_by_actor_type === 'owner' || row?.cancel_reason === 'owner_declined') {
      return { parsed, card: decidedApprovalCard(row, ctx.clientId) };
    }
  } else if (parsed.kind === CARD_KINDS.fyi) {
    const sent = (surface?.auto_sent || []).find((row) => row.id === parsed.id && row.sent_at);
    if (sent) return { parsed, card: projectFyiCard(sent, ctx.clientId) };
  }
  throw mobileError(404, 'NOT_FOUND', 'No such card.');
};

// A held action the owner (or anyone) has since decided, re-rendered from its
// own row: approved/executing/executed → approved, cancelled → rejected when
// the owner declined, otherwise cancelled; still held → open.
const decidedApprovalCard = (row, entityId) => {
  const base = projectApprovalCard({
    id: row.id, action_type: row.action_type, description: describePendingAction(row), hold_copy: null,
    party_name: row.party_name, amount: row.amount, currency: row.currency, created_at: row.created_at
  }, entityId);
  const state = row.status === 'hold_for_approval' ? 'open'
    : row.status === 'cancelled' ? (row.cancel_reason === 'owner_declined' ? 'rejected' : 'cancelled')
      : row.status === 'failed' ? 'cancelled' : 'approved';
  const decidedAt = row.approved_at || (state === 'open' ? null : row.updated_at);
  return { ...base, state, approval: { ...base.approval, decided_at: decidedAt ? new Date(decidedAt).toISOString() : null } };
};

const receiptAfter = async (ctx, { watermark, resourceId, summary, cardIdValue, applied }) => {
  const auditRows = await readAuditRowsSince({ firmId: ctx.firmId, clientId: ctx.clientId, watermark, resourceIds: [resourceId] });
  return projectReceipt({ summary, targets: [{ target: cardIdValue, applied }], auditRows });
};

const validateDecision = (body) => {
  if (!DECISION_TYPES.has(body.type)) throw badRequest('type must be one of approve, reject, answer, veto_flag.', 'DECISION_TYPE_INVALID');
  if (body.note != null && (typeof body.note !== 'string' || body.note.length > 2000)) throw badRequest('note must be a string of at most 2000 characters.');
  const answer = body.answer ?? null;
  if (answer !== null && (typeof answer !== 'object' || Array.isArray(answer))) throw badRequest('answer must be an object.');
  if (answer?.text != null && (typeof answer.text !== 'string' || answer.text.length > 4000)) throw badRequest('answer.text must be at most 4000 characters.');
  if (answer?.document_ids != null && (!Array.isArray(answer.document_ids) || answer.document_ids.some((id) => typeof id !== 'string'))) {
    throw badRequest('answer.document_ids must be a list of document ids.');
  }
};

const wrongClass = (card, type) => mobileError(409, 'DECISION_NOT_VALID_FOR_CARD',
  `A ${card.class} card does not accept '${type}'.`);

// Answer an open ask through the portal's reply route.
const answerAsk = async (ctx, found, { text, documentIds }) => {
  const { card, request } = found;
  if (card.state !== 'open') return { applied: false, already: card.state, card };
  if (documentIds.length) {
    const owned = await readDocumentsById({ firmId: ctx.firmId, clientId: ctx.clientId, ids: documentIds });
    if (owned.length !== new Set(documentIds).size) throw badRequest('Attach only documents registered to this business.', 'DOCUMENT_NOT_IN_ENTITY');
  }
  const watermark = await readAuditWatermark({ firmId: ctx.firmId });
  const routed = await ctx.dispatch({
    method: 'POST',
    path: `/evidence/requests/${encodeURIComponent(request.id)}/resolve`,
    body: { firm_id: ctx.firmId, reply: text, document_ids: documentIds }
  });
  const result = expectOk(routed, 'ANSWER_FAILED');
  const after = await findCard(ctx, card.id).catch(() => ({ card: { ...card, state: 'resolved' } }));
  const topicOpen = result.status === 'topic_open';
  const summary = topicOpen
    ? 'Donna recorded your reply. The question stays open until it is fully answered.'
    : 'Your answer is with Donna.';
  return {
    applied: true,
    already: null,
    card: after.card,
    receipt: await receiptAfter(ctx, { watermark, resourceId: request.id, summary, cardIdValue: card.id, applied: true })
  };
};

const decideApproval = async (ctx, found, type) => {
  const { card, parsed } = found;
  if (card.state !== 'open') return { applied: false, already: card.state, card };
  const watermark = await readAuditWatermark({ firmId: ctx.firmId });
  const routed = await ctx.dispatch({
    method: 'POST',
    path: '/outbound/owner-actions/decide',
    body: { firm_id: ctx.firmId, client_id: ctx.clientId, action_id: parsed.id, decision: type === 'approve' ? 'approve' : 'decline' }
  });
  const result = expectOk(routed, 'DECISION_FAILED');
  const row = await readOutboundAction({ firmId: ctx.firmId, clientId: ctx.clientId, actionId: parsed.id });
  const after = row ? decidedApprovalCard(row, ctx.clientId) : card;
  if (!result.decided) return { applied: false, already: after.state === 'open' ? String(result.already || 'open') : after.state, card: after };
  const summary = type === 'approve' ? 'Approved. Donna will carry this out.' : 'Declined. Donna will not send this.';
  return {
    applied: true, already: null, card: after,
    receipt: await receiptAfter(ctx, { watermark, resourceId: parsed.id, summary, cardIdValue: card.id, applied: true })
  };
};

const flagFyi = async (ctx, found) => {
  const { card, parsed } = found;
  if (card.state === 'flagged') return { applied: false, already: 'flagged', card };
  const watermark = await readAuditWatermark({ firmId: ctx.firmId });
  const routed = await ctx.dispatch({
    method: 'POST',
    path: '/outbound/owner-actions/mark-wrong',
    body: { firm_id: ctx.firmId, client_id: ctx.clientId, action_id: parsed.id }
  });
  const result = expectOk(routed, 'FLAG_FAILED');
  const after = (await findCard(ctx, card.id).catch(() => null))?.card || card;
  if (!result.marked) return { applied: false, already: result.already === 'marked' ? 'flagged' : String(result.already || after.state), card: after };
  return {
    applied: true, already: null, card: after,
    receipt: await receiptAfter(ctx, { watermark, resourceId: parsed.id, summary: 'Thanks — Donna has recorded that this was wrong.', cardIdValue: card.id, applied: true })
  };
};

const decide = async (ctx, rawCardId, body) => {
  validateDecision(body);
  const found = await findCard(ctx, rawCardId);
  const { card } = found;
  if (card.class === 'ask') {
    if (body.type !== 'answer') throw wrongClass(card, body.type);
    if (body.answer?.choice_id != null) throw badRequest('This question offers no choices; answer in words or with a document.', 'CHOICES_NOT_OFFERED');
    const text = String(body.answer?.text || '').trim();
    const documentIds = [...new Set(body.answer?.document_ids || [])];
    if (!text && !documentIds.length) throw badRequest('An answer needs text or at least one document.', 'ANSWER_EMPTY');
    return answerAsk(ctx, found, { text, documentIds });
  }
  if (card.class === 'approval') {
    if (body.type !== 'approve' && body.type !== 'reject') throw wrongClass(card, body.type);
    return decideApproval(ctx, found, body.type);
  }
  if (body.type !== 'veto_flag') throw wrongClass(card, body.type);
  return flagFyi(ctx, found);
};

// ── Documents ─────────────────────────────────────────────────────────────

const documentsWithState = async (ctx, rows) => {
  const asks = await readOpenDocumentAsks({ firmId: ctx.firmId, clientId: ctx.clientId });
  const openAskByDocument = new Map();
  for (const ask of asks) if (!openAskByDocument.has(ask.document_id)) openAskByDocument.set(ask.document_id, ask.id);
  return rows.map((row) => projectDocument(row, { entityId: ctx.clientId, openAskByDocument }));
};

const oneDocument = async (ctx, documentId) => {
  const [row] = await readDocumentsById({ firmId: ctx.firmId, clientId: ctx.clientId, ids: [documentId] });
  if (!row) throw mobileError(404, 'NOT_FOUND', 'No such document.');
  return row;
};

const uploadIntent = async (ctx, body) => {
  const { filename, mime_type: mimeType, size, checksum_sha256: checksum } = body;
  if (typeof filename !== 'string' || !filename.trim()) throw badRequest('filename is required.');
  if (!UPLOAD_MIME_TYPES.has(mimeType)) throw badRequest('Unsupported file type.', 'EVIDENCE_FILE_TYPE_UNSUPPORTED');
  if (!Number.isInteger(size) || size < 1) throw badRequest('size must be a positive integer.');
  if (size > MAX_UPLOAD_BYTES) throw mobileError(413, 'EVIDENCE_FILE_SIZE_INVALID', 'Files up to 10 MB are supported.');
  if (typeof checksum !== 'string' || !/^[a-f0-9]{64}$/i.test(checksum)) throw badRequest('checksum_sha256 must be a hex SHA-256.');
  const routed = await ctx.dispatch({
    method: 'POST',
    path: '/documents/upload-url',
    body: { firm_id: ctx.firmId, client_id: ctx.clientId, filename, mime_type: mimeType, size, checksum_sha256: checksum.toLowerCase() }
  });
  const signed = expectOk(routed, 'UPLOAD_INTENT_FAILED');
  if (!signed.signed_url || !signed.bucket || !signed.key) throw mobileError(502, 'UPLOAD_INTENT_FAILED', 'Donna returned no upload target.');
  return {
    upload_url: new URL(signed.signed_url, ctx.publicOrigin).toString(),
    headers: { 'Content-Type': mimeType, 'x-upsert': 'false' },
    storage_bucket: signed.bucket,
    storage_object_key: signed.key,
    expires_in: Number.isInteger(signed.expires_in) ? signed.expires_in : 600
  };
};

const registerDocuments = async (ctx, body) => {
  const incoming = Array.isArray(body.documents) ? body.documents : null;
  if (!incoming?.length) throw badRequest('documents[] is required.', 'DOCUMENTS_REQUIRED');
  if (incoming.length > 100) throw badRequest('At most 100 documents per call.', 'TOO_MANY_DOCUMENTS');
  for (const doc of incoming) {
    if (!doc || typeof doc !== 'object') throw badRequest('Each document must be an object.');
    if (doc.purpose !== undefined && doc.purpose !== 'prior_records') throw badRequest('Invalid document purpose.', 'DOCUMENT_PURPOSE_INVALID');
    if (doc.purpose === 'prior_records') {
      // Donna has no store for background records that stays out of the
      // posting pipeline; registering one would parse and post it.
      throw mobileError(501, 'NOT_IMPLEMENTED', 'Background records are not supported by this server yet.');
    }
    for (const key of ['id', 'filename', 'storage_bucket', 'storage_object_key', 'checksum_sha256']) {
      if (typeof doc[key] !== 'string' || !doc[key].trim()) throw badRequest(`documents[].${key} is required.`);
    }
    if (!CLIENT_ID_PATTERN.test(doc.id)) throw badRequest('documents[].id must be 1–160 letters, digits, dots, dashes, colons or underscores.');
    if (!doc.storage_object_key.startsWith(`${ctx.firmId}/${ctx.clientId}/`)) {
      throw badRequest('This upload does not belong to this business. Request a new upload first.', 'UPLOAD_NOT_IN_ENTITY');
    }
    if (doc.answers_card_id != null && parseCardId(doc.answers_card_id)?.kind !== CARD_KINDS.ask) {
      throw badRequest('answers_card_id must name a question card.');
    }
  }
  const routed = await ctx.dispatch({
    method: 'POST',
    path: '/documents/register',
    body: {
      firm_id: ctx.firmId,
      // The web portal's register shape; the server types an `unknown`
      // document itself (filename recovery, then the router at parse).
      documents: incoming.map((doc) => ({
        id: doc.id,
        client_id: ctx.clientId,
        filename: doc.filename,
        document_type: 'unknown',
        status: 'needs_review',
        uploaded_at: Date.now(),
        source: doc.answers_card_id ? 'client_evidence_reply' : 'client_upload',
        evidence_request_id: doc.answers_card_id ? parseCardId(doc.answers_card_id).id : null,
        storage_bucket: doc.storage_bucket,
        storage_object_key: doc.storage_object_key,
        checksum_sha256: doc.checksum_sha256.toLowerCase(),
        file_storage: {
          mode: 'object_storage',
          bucket: doc.storage_bucket,
          key: doc.storage_object_key,
          checksum_sha256: doc.checksum_sha256.toLowerCase(),
          filename: doc.filename
        },
        captured_at: typeof doc.captured_at === 'string' ? doc.captured_at : null,
        capture_source: ['camera', 'photo_library', 'file'].includes(doc.source) ? doc.source : null,
        mobile_terminal: true
      }))
    }
  });
  const registered = expectOk(routed, 'REGISTER_FAILED').documents || [];
  // The portal's evidence reply: register the file, then answer the question
  // with it through the same reply route the decision endpoint uses.
  for (const doc of incoming) {
    if (!doc.answers_card_id) continue;
    const found = await findCard(ctx, doc.answers_card_id).catch(() => null);
    if (found?.card?.class === 'ask' && found.card.state === 'open') {
      await answerAsk(ctx, found, { text: '', documentIds: [doc.id] });
    }
  }
  const rows = await readDocumentsById({ firmId: ctx.firmId, clientId: ctx.clientId, ids: registered.map((doc) => doc.id) });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return { documents: await documentsWithState(ctx, registered.map((doc) => byId.get(doc.id)).filter(Boolean)) };
};

const parseStatus = async (ctx, query) => {
  const ids = String(query.get('ids') || '').split(',').map((id) => id.trim()).filter(Boolean);
  if (!ids.length) throw badRequest('ids is required.', 'IDS_REQUIRED');
  if (ids.length > 100) throw badRequest('Too many ids (max 100).', 'TOO_MANY_IDS');
  const routed = await ctx.dispatch({ path: '/documents/parse-status', query: { firm_id: ctx.firmId, ids: ids.join(',') } });
  const rows = expectOk(routed, 'PARSE_STATUS_FAILED').documents || [];
  return { documents: rows.filter((row) => row.client_id === ctx.clientId).map(projectParseStatus) };
};

const encodeCursor = (row) => Buffer.from(JSON.stringify({ u: new Date(row.uploaded_at).toISOString(), i: row.id })).toString('base64url');
const decodeCursor = (value) => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof parsed.i !== 'string' || Number.isNaN(Date.parse(parsed.u))) throw new Error('bad');
    return { uploadedAt: parsed.u, id: parsed.i };
  } catch {
    throw badRequest('Invalid cursor.', 'CURSOR_INVALID');
  }
};

const listDocuments = async (ctx, query) => {
  const rawLimit = query.get('limit');
  const limit = rawLimit == null ? 30 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw badRequest('limit must be 1–100.');
  const rows = await readDocuments({ firmId: ctx.firmId, clientId: ctx.clientId, limit, cursor: decodeCursor(query.get('cursor')) });
  const page = rows.slice(0, limit);
  return {
    documents: await documentsWithState(ctx, page),
    next_cursor: rows.length > limit ? encodeCursor(page.at(-1)) : null
  };
};

const retryDocument = async (ctx, documentId) => {
  await oneDocument(ctx, documentId);
  const routed = await ctx.dispatch({ method: 'POST', path: '/documents/retry-parse', body: { firm_id: ctx.firmId, document_ids: [documentId] } });
  if (routed.status === 403) {
    // Donna's retry route is firm-member-only (async-parsing plan); the
    // owner's way to retry is a fresh upload of the same file.
    throw mobileError(403, 'RETRY_NOT_AVAILABLE_TO_OWNER',
      'Retrying is done by your accountant in Donna. You can also upload the file again.');
  }
  const result = expectOk(routed, 'RETRY_FAILED');
  if (!(result.documents || []).some((row) => row.id === documentId)) {
    throw mobileError(409, 'NOT_RETRYABLE', 'This document is not in a state that can be retried.');
  }
  return (await documentsWithState(ctx, [await oneDocument(ctx, documentId)]))[0];
};

const resolveDuplicate = async (ctx, documentId, body) => {
  if (!['create', 'replace', 'cancel'].includes(body.action)) throw badRequest('action must be one of create, replace, cancel.', 'UNSUPPORTED_RESOLVE_ACTION');
  await oneDocument(ctx, documentId);
  const routed = await ctx.dispatch({
    method: 'POST',
    path: `/documents/${encodeURIComponent(documentId)}/resolve-duplicate`,
    body: { firm_id: ctx.firmId, action: body.action }
  });
  expectOk(routed, 'RESOLVE_DUPLICATE_FAILED');
  const [row] = await readDocumentsById({ firmId: ctx.firmId, clientId: ctx.clientId, ids: [documentId] });
  if (!row) throw mobileError(404, 'NOT_FOUND', 'The duplicate was cancelled and is no longer on file.');
  return (await documentsWithState(ctx, [row]))[0];
};

// ── Routes ────────────────────────────────────────────────────────────────
// Everything in the contract that has no existing Donna reader or writer to
// route to answers 501 NOT_IMPLEMENTED with the reason (never a fake success).
export const NOT_IMPLEMENTED = Object.freeze([
  ['POST', /^\/me\/deletion-request$/, 'Donna has no account-deletion request writer yet.'],
  ['POST', /^\/entities\/[^/]+\/onboarding\/voice-draft$/, 'Voice onboarding is not available on this server.'],
  ['POST', /^\/entities\/[^/]+\/onboarding\/text-draft$/, 'Onboarding drafts are not available on this server.'],
  ['GET', /^\/entities\/[^/]+\/settings$/, 'Mobile settings are not stored by this server yet.'],
  ['POST', /^\/entities\/[^/]+\/settings$/, 'Mobile settings are not stored by this server yet.'],
  ['GET', /^\/entities\/[^/]+\/business-setup$/, 'Business setup is not available on this server yet.'],
  ['POST', /^\/entities\/[^/]+\/business-setup$/, 'Business setup is not available on this server yet.'],
  ['POST', /^\/entities\/[^/]+\/business-setup\/lookup$/, 'Business register lookup is not available on this server yet.'],
  ['GET', /^\/entities\/[^/]+\/reviews\/(taxes|month)$/, 'Tax and month reviews are not available on this server yet.'],
  ['GET', /^\/entities\/[^/]+\/chat$/, 'Chat is not available in the app on this server yet; use Donna on the web.'],
  ['POST', /^\/entities\/[^/]+\/chat\/messages$/, 'Chat is not available in the app on this server yet; use Donna on the web.'],
  ['POST', /^\/entities\/[^/]+\/chat\/actions\/[^/]+\/apply$/, 'Chat is not available in the app on this server yet; use Donna on the web.'],
  ['GET', /^\/entities\/[^/]+\/artifacts\/(queue_card|document)\/[^/]+\/messages$/, 'Item conversations are not available on this server yet.'],
  ['POST', /^\/entities\/[^/]+\/artifacts\/(queue_card|document)\/[^/]+\/messages$/, 'Item conversations are not available on this server yet.'],
  ['POST', /^\/entities\/[^/]+\/mileage$/, 'Donna records mileage only from a chat proposal today.'],
  ['GET', /^\/entities\/[^/]+\/activity$/, 'The activity feed is not available on this server yet.'],
  ['POST', /^\/notifications\/registrations$/, 'Push notifications are not available on this server yet.'],
  ['DELETE', /^\/notifications\/registrations\/[^/]+$/, 'Push notifications are not available on this server yet.']
]);

const ENTITY_ROUTES = [
  ['GET', /^\/queue$/, (ctx) => readQueueSources(ctx).then((sources) => buildQueue({ entityId: ctx.clientId, ...sources }))],
  ['GET', /^\/queue\/cards\/([^/]+)$/, (ctx, [id]) => findCard(ctx, id).then((found) => found.card)],
  ['POST', /^\/queue\/cards\/([^/]+)\/decision$/, async (ctx, [id]) => decide(ctx, id, await readJson(ctx.req))],
  ['GET', /^\/status$/, async (ctx) => {
    const sources = await readQueueSources(ctx);
    const queue = buildQueue({ entityId: ctx.clientId, ...sources });
    const { periods, checks } = await readClosePeriods({ firmId: ctx.firmId, clientId: ctx.clientId });
    return buildBooksStatus({ periods, checks, queue, requests: sources.requests, locale: ctx.locale });
  }],
  ['POST', /^\/documents\/upload-intent$/, async (ctx) => uploadIntent(ctx, await readJson(ctx.req))],
  ['POST', /^\/documents\/register$/, async (ctx) => registerDocuments(ctx, await readJson(ctx.req))],
  ['GET', /^\/documents\/parse-status$/, (ctx) => parseStatus(ctx, ctx.query)],
  ['GET', /^\/documents$/, (ctx) => listDocuments(ctx, ctx.query)],
  ['POST', /^\/documents\/([^/]+)\/retry$/, (ctx, [id]) => retryDocument(ctx, id)],
  ['POST', /^\/documents\/([^/]+)\/resolve-duplicate$/, async (ctx, [id]) => resolveDuplicate(ctx, id, await readJson(ctx.req))],
  ['GET', /^\/documents\/([^/]+)$/, async (ctx, [id]) => (await documentsWithState(ctx, [await oneDocument(ctx, id)]))[0]],
  ['PUT', /^\/onboarding\/profile$/, async (ctx) => confirmBusinessProfile(ctx, await readJson(ctx.req))]
];

const AUTH_ROUTES = [['POST', /^\/auth\/sessions$/], ['POST', /^\/auth\/sessions\/refresh$/], ['DELETE', /^\/auth\/sessions\/current$/], ['GET', /^\/me$/]];

// 'implemented' | 'not_implemented' | null for a concrete contract path (no
// prefix). Used by the coverage test that pins every contract operation.
export const mobileRouteState = (method, path) => {
  if (AUTH_ROUTES.some(([verb, pattern]) => verb === method && pattern.test(path))) return 'implemented';
  if (NOT_IMPLEMENTED.some(([verb, pattern]) => verb === method && pattern.test(path))) return 'not_implemented';
  const entity = path.match(/^\/entities\/[^/]+(\/.*)$/);
  if (entity && ENTITY_ROUTES.some(([verb, pattern]) => verb === method && pattern.test(entity[1]))) return 'implemented';
  return null;
};

const decodeSegments = (match) => match.slice(1).map((value) => decodeURIComponent(value));

const route = async (req, res, requestUrl, deps) => {
  const path = requestUrl.pathname.slice(MOBILE_API_PATH_PREFIX.length) || '/';
  const method = req.method;

  // Auth: no bearer needed to mint or refresh.
  if (path === '/auth/sessions' && method === 'POST') {
    const body = await readJson(req);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!email || typeof body.password !== 'string' || !body.password) throw badRequest('email and password are required.');
    const verdict = signInLimiter.check({ email, address: clientAddress(req) });
    if (!verdict.allowed) {
      res.setHeader('Retry-After', String(verdict.retryAfterSeconds));
      throw mobileError(429, 'SIGN_IN_RATE_LIMITED', 'Too many sign-in attempts. Try again later.');
    }
    const tokens = await passwordGrant(deps.identityProvider, { email, password: body.password });
    return send(res, 200, await sessionFor(deps, tokens));
  }
  if (path === '/auth/sessions/refresh' && method === 'POST') {
    const body = await readJson(req);
    if (typeof body.refresh_token !== 'string' || !body.refresh_token) throw badRequest('refresh_token is required.');
    const tokens = await refreshGrant(deps.identityProvider, { refreshToken: body.refresh_token });
    return send(res, 200, await sessionFor(deps, tokens));
  }
  if (path === '/auth/sessions/current' && method === 'DELETE') {
    const token = bearerOf(req);
    if (!token) throw mobileError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
    await revokeSession(deps.identityProvider, token);
    return send(res, 204);
  }

  // Everything else: a verified owner.
  const auth = await verifiedIdentity(deps, bearerOf(req));
  const owner = await resolveMobileOwner(auth);

  if (path === '/me' && method === 'GET') return send(res, 200, await meBody(owner));

  for (const [verb, pattern, reason] of NOT_IMPLEMENTED) {
    if (verb === method && pattern.test(path)) {
      const entity = path.match(/^\/entities\/([^/]+)\//);
      if (entity) ownerScopeForEntity(owner, decodeURIComponent(entity[1]));
      throw mobileError(501, 'NOT_IMPLEMENTED', reason);
    }
  }

  const entityMatch = path.match(/^\/entities\/([^/]+)(\/.*)$/);
  if (entityMatch) {
    const scope = ownerScopeForEntity(owner, decodeURIComponent(entityMatch[1]));
    const rest = entityMatch[2];
    for (const [verb, pattern, handler] of ENTITY_ROUTES) {
      const match = verb === method ? rest.match(pattern) : null;
      if (!match) continue;
      const ctx = {
        ...scope,
        auth,
        identity: owner.identity,
        req,
        query: requestUrl.searchParams,
        locale: localeOf(req),
        publicOrigin: uploadOrigin(req, deps),
        dispatch: createFirmRouteDispatcher({
          firmHandler: deps.dispatchFirmRoute,
          auth,
          forwardHeaders: Object.fromEntries(['host', 'x-forwarded-host', 'x-forwarded-proto', 'user-agent']
            .filter((name) => req.headers?.[name]).map((name) => [name, req.headers[name]]))
        })
      };
      return send(res, 200, await handler(ctx, decodeSegments(match)));
    }
  }
  throw mobileError(404, 'NOT_FOUND', 'No such mobile API route.');
};

export const handleMobileApiRequest = async (req, res, requestUrl, deps) => {
  applyHeaders(res);
  if (req.method === 'OPTIONS') return send(res, 204);
  if (isMobileApiDisabled()) return send(res, 503, { error: 'The Donna app is switched off on this server.', code: 'MOBILE_API_DISABLED' });
  try {
    await route(req, res, requestUrl, deps);
  } catch (error) {
    const status = Number.isInteger(error?.statusCode) && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500 && status !== 501 && status !== 503) console.error('[mobile-api]', error?.stack || error);
    if (!res.writableEnded) {
      send(res, status, {
        error: status === 500 ? 'Something went wrong on Donna’s side.' : (error?.message || 'Request failed.'),
        code: status === 500 ? 'INTERNAL_ERROR' : String(error?.code || 'ERROR')
      });
    }
  }
};
