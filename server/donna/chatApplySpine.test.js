// Chat-apply spine — unit tests + the source-lint contract (pod-safety #4,
// compile → authorize half).
//
// Load-bearing properties (CLAUDE.md GOAL §4):
//   - ONE prologue for all three chat apply routes: action resolved from the
//     PERSISTED message, idempotent replay, 409 on non-proposed, per-surface
//     type allowlist, the #3 capability gate, actor attribution;
//   - refusal bodies reproduce the routes' pre-spine responses byte-for-byte
//     (adopting the spine is wiring, not behaviour — except feed-chat gaining
//     the previously-missing capability gate);
//   - fail-closed: a route that forgets to inject the capability check is
//     refused, never silently ungated;
//   - the lint half: api.js's three chat apply handlers each pass through
//     gateChatApplyAction, and NO chat apply handler calls the capability gate
//     directly (the drift that produced the feed-chat gap) — the same
//     source-as-contract style sqlWriterLint uses for the SQL writers.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CHAT_APPLY_SURFACES,
  chatApplyActorId,
  compileChatApplyAction,
  gateChatApplyAction,
  executeChatApplyAction,
  auditChatApplyEvent
} from './chatApplySpine.js';

const message = (over = {}) => ({
  payload: {
    actions: [
      { type: 'apply_category', status: 'proposed', account_name: 'Software' },
      { type: 'sync_to_accounting', status: 'proposed' }
    ]
  },
  ...over
});

const TYPES = ['apply_category', 'sync_to_accounting'];
const allow = async () => ({ allowed: true, enforced: false });

// ─── compile ─────────────────────────────────────────────────────────────────

await test('compile: missing message / out-of-range index refuse with the routes\' exact 404 bodies', () => {
  const noMessage = compileChatApplyAction({ message: null, actionIndex: 0, appliableActionTypes: TYPES });
  assert.deepEqual(noMessage, { disposition: 'refuse', statusCode: 404, body: { error: 'Chat message not found.' } });

  const outOfRange = compileChatApplyAction({ message: message(), actionIndex: 7, appliableActionTypes: TYPES });
  assert.equal(outOfRange.statusCode, 404);
  assert.equal(outOfRange.body.error, 'Action index 7 out of range.');
});

await test('compile: an already-applied action replays idempotently, never re-running a writer', () => {
  const applied = message();
  applied.payload.actions[0].status = 'applied';
  const out = compileChatApplyAction({ message: applied, actionIndex: 0, appliableActionTypes: TYPES });
  assert.equal(out.disposition, 'replay');
  assert.equal(out.action.type, 'apply_category');
});

await test('compile: any other non-proposed status 409s; a missing status still proceeds (legacy rows)', () => {
  const failed = message();
  failed.payload.actions[0].status = 'failed';
  const out = compileChatApplyAction({ message: failed, actionIndex: 0, appliableActionTypes: TYPES });
  assert.equal(out.statusCode, 409);
  assert.equal(out.body.error, "Action is in status 'failed' and cannot be applied.");

  const legacy = message();
  delete legacy.payload.actions[0].status;
  assert.equal(compileChatApplyAction({ message: legacy, actionIndex: 0, appliableActionTypes: TYPES }).disposition, 'proceed');
});

await test('compile: the per-surface type allowlist is the defensive gate (400 + action_type)', () => {
  const out = compileChatApplyAction({ message: message(), actionIndex: 1, appliableActionTypes: ['apply_category'] });
  assert.equal(out.statusCode, 400);
  assert.deepEqual(out.body, {
    error: "Apply not yet supported for action type 'sync_to_accounting'.",
    action_type: 'sync_to_accounting'
  });
});

// ─── authorize ───────────────────────────────────────────────────────────────

await test('gate: proceed carries the compiled action + the attributed actor', async () => {
  const out = await gateChatApplyAction({
    surface: 'feed_chat',
    firmId: 'firm-1',
    clientId: 'client-1',
    principal: { email: 'reviewer@pod.example' },
    message: message(),
    actionIndex: 0,
    appliableActionTypes: TYPES,
    assertCapability: allow
  });
  assert.equal(out.disposition, 'proceed');
  assert.equal(out.action.type, 'apply_category');
  assert.equal(out.actorId, 'reviewer@pod.example');
  assert.equal(out.surface, 'feed_chat');
});

await test('gate: a capability denial maps to the routes\' exact 403 body and never proceeds', async () => {
  const deny = async () => {
    const err = new Error('Your role (reviewer) may not perform "sync_to_accounting" — requires founder capability.');
    err.statusCode = 403;
    throw err;
  };
  const out = await gateChatApplyAction({
    surface: 'transaction_chat',
    principal: { email: 'reviewer@pod.example' },
    message: message(),
    actionIndex: 1,
    appliableActionTypes: TYPES,
    assertCapability: deny
  });
  assert.equal(out.disposition, 'refuse');
  assert.equal(out.statusCode, 403);
  assert.deepEqual(out.body, {
    error: 'Your role (reviewer) may not perform "sync_to_accounting" — requires founder capability.',
    action_type: 'sync_to_accounting'
  });
});

await test('gate: the capability check is consulted with the COMPILED action type', async () => {
  const seen = [];
  await gateChatApplyAction({
    surface: 'document_chat',
    firmId: 'firm-1',
    clientId: 'client-1',
    principal: { userId: 'user-9' },
    message: message(),
    actionIndex: 1,
    appliableActionTypes: TYPES,
    assertCapability: async (args) => { seen.push(args); }
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].actionType, 'sync_to_accounting');
  assert.equal(seen[0].firmId, 'firm-1');
  assert.equal(seen[0].clientId, 'client-1');
});

await test('gate: fail-CLOSED when the capability check is not injected', async () => {
  const out = await gateChatApplyAction({
    surface: 'feed_chat',
    message: message(),
    actionIndex: 0,
    appliableActionTypes: TYPES,
    assertCapability: null
  });
  assert.equal(out.disposition, 'refuse');
  assert.equal(out.statusCode, 500);
});

await test('gate: compile refusals short-circuit BEFORE the capability check runs', async () => {
  let consulted = false;
  const out = await gateChatApplyAction({
    surface: 'feed_chat',
    message: null,
    actionIndex: 0,
    appliableActionTypes: TYPES,
    assertCapability: async () => { consulted = true; }
  });
  assert.equal(out.statusCode, 404);
  assert.equal(consulted, false);
});

await test('actor attribution ladder: email > userId > principalId > system', () => {
  assert.equal(chatApplyActorId({ email: 'a@b.c', userId: 'u', principalId: 'p' }), 'a@b.c');
  assert.equal(chatApplyActorId({ userId: 'u', principalId: 'p' }), 'u');
  assert.equal(chatApplyActorId({ principalId: 'p' }), 'p');
  assert.equal(chatApplyActorId(null), 'system');
});

// ─── execute (the #4 audit → execute half, writer-dispatch leg) ───────────────

await test('execute: the applied path stamps status through the injected writer and returns the extras', async () => {
  const stamps = [];
  const out = await executeChatApplyAction({
    action: { type: 'apply_category' },
    execute: async () => ({
      result: { review_item_id: 'ri-1', account_name: 'Software' },
      writerSnapshot: { firm: 'snap' }
    }),
    stamp: {
      write: async (args) => { stamps.push(args); return { id: 'msg-1', updated: true }; },
      scope: { firmId: 'firm-1', clientId: 'client-1', transactionId: 'tx-1', messageId: 'msg-1', actionIndex: 0 }
    }
  });
  assert.equal(out.disposition, 'applied');
  assert.deepEqual(out.updatedMessage, { id: 'msg-1', updated: true });
  assert.deepEqual(out.executed.writerSnapshot, { firm: 'snap' });
  // The spine owns the `status: 'applied'` write — scope + status + result, nothing else.
  assert.equal(stamps.length, 1);
  assert.deepEqual(stamps[0], {
    firmId: 'firm-1',
    clientId: 'client-1',
    transactionId: 'tx-1',
    messageId: 'msg-1',
    actionIndex: 0,
    status: 'applied',
    result: { review_item_id: 'ri-1', account_name: 'Software' }
  });
});

await test('execute: a writer error maps to the routes\' exact refusal — statusCode || 500, message || fallback, action_type — and never stamps', async () => {
  let stamped = 0;
  const err = new Error('Review item was updated by another user.');
  err.statusCode = 409;
  const out = await executeChatApplyAction({
    action: { type: 'recode_decided' },
    fallbackErrorMessage: 'Re-code failed.',
    execute: async () => { throw err; },
    stamp: { write: async () => { stamped += 1; }, scope: {} }
  });
  assert.deepEqual(out, {
    disposition: 'refuse',
    statusCode: 409,
    body: { error: 'Review item was updated by another user.', action_type: 'recode_decided' }
  });
  assert.equal(stamped, 0);

  const bare = await executeChatApplyAction({
    action: { type: 'recode_decided' },
    fallbackErrorMessage: 'Re-code failed.',
    execute: async () => { throw new Error(''); },
    stamp: { write: async () => {}, scope: {} }
  });
  assert.equal(bare.statusCode, 500);
  assert.equal(bare.body.error, 'Re-code failed.');
});

await test('execute: code/details stay OFF the error body unless the site opts in (correct_document_field\'s contract)', async () => {
  const err = new Error('field_path not allowed');
  err.statusCode = 400;
  err.code = 'field_not_allowed';
  err.details = { allowed: ['total_amount'] };
  const thunk = async () => { throw err; };

  const hidden = await executeChatApplyAction({
    action: { type: 'apply_category' },
    execute: thunk,
    stamp: { write: async () => {}, scope: {} }
  });
  assert.deepEqual(hidden.body, { error: 'field_path not allowed', action_type: 'apply_category' });

  const exposed = await executeChatApplyAction({
    action: { type: 'correct_document_field' },
    exposeErrorDetails: true,
    execute: thunk,
    stamp: { write: async () => {}, scope: {} }
  });
  assert.deepEqual(exposed.body, {
    error: 'field_path not allowed',
    action_type: 'correct_document_field',
    code: 'field_not_allowed',
    details: { allowed: ['total_amount'] }
  });
});

await test('execute: a verb-owned respond terminal passes through verbatim, WITHOUT stamping (the action stays proposed)', async () => {
  let stamped = 0;
  const out = await executeChatApplyAction({
    action: { type: 'remember_merchant' },
    execute: async () => ({
      respond: {
        statusCode: 200,
        body: { applied: false, skipped_reason: 'merchant_pattern_unusable', action_type: 'remember_merchant' }
      }
    }),
    stamp: { write: async () => { stamped += 1; }, scope: {} }
  });
  assert.equal(out.disposition, 'respond');
  assert.equal(out.statusCode, 200);
  assert.deepEqual(out.body, {
    applied: false,
    skipped_reason: 'merchant_pattern_unusable',
    action_type: 'remember_merchant'
  });
  assert.equal(stamped, 0);
});

await test('execute: a stamp failure maps through the SAME refusal shape — the pre-spine 4-of-12 divergence is unified', async () => {
  const err = new Error('Chat message not found.');
  err.statusCode = 404;
  const out = await executeChatApplyAction({
    action: { type: 'ask_client' },
    fallbackErrorMessage: 'Ask client failed.',
    execute: async () => ({ result: { evidence_request_id: 'ev-1' } }),
    stamp: { write: async () => { throw err; }, scope: {} }
  });
  assert.deepEqual(out, {
    disposition: 'refuse',
    statusCode: 404,
    body: { error: 'Chat message not found.', action_type: 'ask_client' }
  });
});

await test('execute: fail-CLOSED when the writer thunk or the stamp writer is not injected', async () => {
  const noThunk = await executeChatApplyAction({
    action: { type: 'apply_category' },
    stamp: { write: async () => {}, scope: {} }
  });
  assert.equal(noThunk.disposition, 'refuse');
  assert.equal(noThunk.statusCode, 500);
  assert.equal(noThunk.body.error, 'Apply executor unavailable for this route.');

  const noStamp = await executeChatApplyAction({
    action: { type: 'apply_category' },
    execute: async () => ({ result: {} })
  });
  assert.equal(noStamp.disposition, 'refuse');
  assert.equal(noStamp.statusCode, 500);
});

// ─── audit emission (the #4 audit → execute half, emission leg) ───────────────

await test('audit: emits the ONE row shape — attributed, scoped, verb name verbatim', async () => {
  const calls = [];
  const ok = await auditChatApplyEvent({
    query: async (sql, params) => calls.push({ sql, params }),
    firmId: 'firm-1',
    clientId: 'client-1',
    actorId: 'reviewer@pod.example',
    action: 'review.note_added',
    resourceType: 'transaction_review',
    resourceId: 42,
    metadata: { note: 'chase the invoice' }
  });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].sql.includes('insert into audit_events'));
  assert.deepEqual(calls[0].params, [
    'firm-1',
    'client-1',
    'firm',                        // actor_type defaults to firm (the operator surfaces)
    'reviewer@pod.example',
    'review.note_added',           // the CALLER's action name, never renamed
    'transaction_review',
    '42',                          // resource ids stringified
    JSON.stringify({ note: 'chase the invoice' })
  ]);
});

await test('audit: the owner surface stamps actor_type client — never masquerading as a firm operator', async () => {
  const calls = [];
  await auditChatApplyEvent({
    query: async (sql, params) => calls.push(params),
    firmId: 'firm-1',
    clientId: 'client-1',
    actorId: 'owner@honeybee.example',
    actorType: 'client',
    action: 'client_chat.answer_evidence_request_applied'
  });
  assert.equal(calls[0][2], 'client');
  assert.equal(calls[0][3], 'owner@honeybee.example');
});

await test('audit: a missing actor falls back to system — the column can no longer be omitted', async () => {
  const calls = [];
  await auditChatApplyEvent({
    query: async (sql, params) => calls.push(params),
    firmId: 'firm-1',
    actorId: null,
    action: 'transaction.feed_chat_apply'
  });
  assert.equal(calls[0][3], 'system');
  assert.equal(calls[0][1], null);   // clientId optional
  assert.equal(calls[0][6], null);   // resourceId optional
});

await test('audit: bestEffort=true swallows the failure, warns, and reports false (mutation stands)', async () => {
  const warned = [];
  const ok = await auditChatApplyEvent({
    query: async () => { throw new Error('db down'); },
    firmId: 'firm-1',
    action: 'review.recode_decided',
    bestEffort: true,
    warn: (...args) => warned.push(args)
  });
  assert.equal(ok, false);
  assert.equal(warned.length, 1);
  assert.ok(String(warned[0][0]).includes('review.recode_decided'));
});

await test('audit: bestEffort=false is audit-as-precondition — the failure propagates', async () => {
  await assert.rejects(
    () => auditChatApplyEvent({
      query: async () => { throw new Error('db down'); },
      firmId: 'firm-1',
      action: 'review.note_added',
      bestEffort: false
    }),
    /db down/
  );
});

await test('audit: a missing query injection fails closed under precondition mode, loud under best-effort', async () => {
  await assert.rejects(
    () => auditChatApplyEvent({ firmId: 'firm-1', action: 'x', bestEffort: false }),
    /injected query function/
  );
  const warned = [];
  const ok = await auditChatApplyEvent({
    firmId: 'firm-1',
    action: 'x',
    bestEffort: true,
    warn: (...args) => warned.push(args)
  });
  assert.equal(ok, false);
  assert.equal(warned.length, 1);
});

// ─── the source-lint contract over api.js ────────────────────────────────────
// Same style as sqlWriterLint: the discipline is enforceable only if the routes
// actually pass through the spine, so the test reads api.js and pins it.

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiSource = readFileSync(resolvePath(__dirname, 'api.js'), 'utf8');
// The client-chat apply body lives in clientChatApply.js since slice 3 of the
// hosted chat surface (the confirm_action MCP tool is the same owner
// confirming the same proposal through another door — ONE apply path, two
// doors). The api.js route delegates to it; this file lints the module the
// way it lints api.js and feedChatApply.js, so the discipline moved WITH the
// body, never out from under it.
const clientChatApplySource = readFileSync(resolvePath(__dirname, 'clientChatApply.js'), 'utf8');
const CLIENT_CHAT_ROUTE_MARKER = '/^\\/client-chat\\/messages\\/([^/]+)\\/actions\\/(\\d+)\\/apply$/';

const CHAT_APPLY_ROUTE_MARKERS = [
  '/^\\/feed-chat\\/messages\\/([^/]+)\\/actions\\/(\\d+)\\/apply$/',
  '/^\\/transaction-chat\\/messages\\/([^/]+)\\/actions\\/(\\d+)\\/apply$/',
  '/^\\/document-chat\\/messages\\/([^/]+)\\/actions\\/(\\d+)\\/apply$/',
  '/^\\/client-chat\\/messages\\/([^/]+)\\/actions\\/(\\d+)\\/apply$/'
];

await test('lint: every chat apply route in api.js passes through gateChatApplyAction', () => {
  assert.equal(CHAT_APPLY_ROUTE_MARKERS.length, CHAT_APPLY_SURFACES.length);
  // Each route handler (from its pathname regex to the next route's) must call the gate.
  const markerIndexes = CHAT_APPLY_ROUTE_MARKERS.map((marker) => {
    const idx = apiSource.indexOf(marker);
    assert.notEqual(idx, -1, `route marker missing from api.js: ${marker}`);
    return { marker, idx };
  });
  for (const { marker, idx } of markerIndexes) {
    // A handler is contiguous; the gate call must appear within it — bound the
    // search window at the next chat-apply route marker (or +20k chars).
    const nextIdx = Math.min(
      ...markerIndexes.map((m) => (m.idx > idx ? m.idx : Infinity)),
      idx + 20000
    );
    const handler = apiSource.slice(idx, nextIdx);
    if (marker === CLIENT_CHAT_ROUTE_MARKER) {
      // The owner route delegates to the shared apply module, which carries
      // the gate (pinned on that module below).
      assert.ok(handler.includes('applyClientChatAction('), 'the client-chat route must delegate to applyClientChatAction');
      assert.ok(!handler.includes('gateChatApplyAction('), 'the client-chat route must not re-implement the gate beside the shared module');
      continue;
    }
    assert.ok(
      handler.includes('gateChatApplyAction('),
      `chat apply handler ${marker} does not pass through the spine`
    );
  }
  assert.ok(clientChatApplySource.includes('gateChatApplyAction('), 'clientChatApply.js must pass through the spine gate');
  assert.ok(
    clientChatApplySource.includes('appliableActionTypes: CLIENT_PORTAL_CHAT_APPLIABLE_ACTION_TYPES'),
    'clientChatApply.js must gate on the OWNER grammar, imported'
  );
  assert.ok(
    clientChatApplySource.includes('assertCapability: d.assertClientChatActionCapability'),
    'clientChatApply.js must inject the owner capability gate'
  );
});

await test('lint: no chat apply handler calls the capability gate directly (the feed-chat drift class)', () => {
  // Direct assertActionCapability calls in api.js are allowed ONLY on the
  // sanctioned NON-CHAT privileged routes: /operator/reverse (pod-safety #2)
  // and the five direct push routes (INT-5, 2026-07-06 — /xero|qbo aliases
  // share each /xero handler), document corrections, and attributed transaction
  // review facts (U08-S2: member-scoped recode_decided, pinned separately below).
  // A chat apply handler must go through the spine
  // (gateChatApplyAction) instead — the exact drift #4 exists to prevent. The
  // count is pinned so ANY new direct call site lands here for review.
  const allowedRouteContexts = [
    "'/operator/reverse'",
    "'/xero/writeback-transaction'",
    "'/xero/writeback-transactions'",
    "'/xero/mirror-retry'",
    "'/ledger/post-transaction'",
    "'/ledger/post-period'",
    '// /documents/:id/corrections',
    'const transactionReviewMatch = requestUrl.pathname.match('
  ];
  const callIndexes = [];
  for (let idx = apiSource.indexOf('await assertActionCapability('); idx !== -1;
    idx = apiSource.indexOf('await assertActionCapability(', idx + 1)) {
    callIndexes.push(idx);
  }
  assert.equal(
    callIndexes.length,
    allowedRouteContexts.length,
    `expected exactly ${allowedRouteContexts.length} direct assertActionCapability calls in api.js (the sanctioned non-chat routes)`
  );
  const seen = new Set();
  for (const idx of callIndexes) {
    const context = apiSource.slice(Math.max(0, idx - 2500), idx);
    const route = allowedRouteContexts.find((r) => context.includes(r));
    assert.ok(route, `a direct capability call sits outside the sanctioned non-chat routes (offset ${idx})`);
    seen.add(route);
  }
  assert.equal(seen.size, allowedRouteContexts.length, 'every sanctioned route carries its own gate call');
});

await test('lint: the non-chat transaction review fact gate binds the member and client before its writer', () => {
  const start = apiSource.indexOf('const transactionReviewMatch = requestUrl.pathname.match(');
  assert.notEqual(start, -1);
  const end = apiSource.indexOf('// ── Ask-pipeline batches', start);
  assert.ok(end > start, 'review handler must have an explicit bounded source window');
  const handler = apiSource.slice(start, end);
  assert.ok(handler.includes('/^\\/transaction-review\\/([^/]+)$/'));
  assert.ok(handler.includes("if (transactionReviewMatch && req.method === 'PATCH')"));
  assert.equal((handler.match(/await assertActionCapability\(/g) || []).length, 1);
  assert.ok(handler.includes('requireMember: Boolean(body?.patch?.tax_posting_facts)'));
  assert.match(handler, /const reviewItem = \(await queryFirmDb\('select client_id from transaction_review_queue where firm_id=\$1 and id=\$2',\s*\[firmId \|\| DEFAULT_FIRM_ID,reviewItemId\]\)\)\.rows\[0\]/);
  assert.ok(handler.includes("if (!reviewItem) throw Object.assign(new Error('Review item not found.'), {statusCode:404})"));
  assert.ok(handler.includes('clientIds: collectClientIds(reviewItem?.client_id)'));
  assert.match(handler, /const reviewPrincipal = await resolveDesktopClientCreationPrincipal\(\{ firmId, principal: access\.principal \}\)/);
  assert.match(handler, /if \(body\?\.patch\?\.tax_posting_facts\) await assertActionCapability\(\{ firmId, clientId: reviewItem\?\.client_id,\s*principal: reviewPrincipal, actionType: 'recode_decided' \}\)/);
  assert.ok(handler.includes('actorId: reviewPrincipal.principalId'));
  assert.ok(handler.includes('reviewAuthority: {clientId:reviewItem.client_id,principal:reviewPrincipal}'));
  assert.ok(handler.indexOf('await queryFirmDb(') < handler.indexOf('await assertFirmAccess('));
  assert.ok(handler.indexOf('await assertFirmAccess(') < handler.indexOf('await resolveDesktopClientCreationPrincipal('));
  assert.ok(handler.indexOf('await assertActionCapability(') < handler.indexOf('await updateTransactionReviewItemInDb('));
});

await test('lint: the pre-spine inline prologue did not grow back into the handlers', () => {
  // The six-step prologue used to live inline; its most distinctive line was the
  // per-route action resolution. It must now appear ZERO times in api.js — the
  // spine owns it.
  const inlineResolution = apiSource.match(/const actions = Array\.isArray\(message\?\.payload\?\.actions\)/g) || [];
  assert.equal(inlineResolution.length, 0, 'inline action resolution re-appeared in api.js — use gateChatApplyAction');
});

// ─── the audit-half lint: route-level audit rows go through the spine ─────────
// Pre-#4-audit-half, api.js hand-inserted three audit rows (two of them
// actor-LESS — the same drift class the capability-gate lint exists for) and
// feedChatApply.js two more. All five now emit through auditChatApplyEvent;
// a raw insert re-appearing in either file is the regression this pins.

const feedChatApplySource = readFileSync(resolvePath(__dirname, 'feedChatApply.js'), 'utf8');

await test('lint: clientChatApply.js (the owner apply, both doors) emits its audit through the spine, audit-as-precondition, naming the door', () => {
  assert.equal((clientChatApplySource.match(/insert into audit_events/gi) || []).length, 0, 'no raw audit insert in clientChatApply.js');
  assert.ok(clientChatApplySource.includes('auditChatApplyEvent('), 'clientChatApply.js must emit through auditChatApplyEvent');
  assert.equal((clientChatApplySource.match(/bestEffort: true/g) || []).length, 0, 'the owner apply audit is never best-effort');
  assert.equal((clientChatApplySource.match(/bestEffort: false/g) || []).length, 1, 'exactly one audit emission site, audit-as-precondition');
  // The DOOR is the surface the audit records — never a hardcoded 'client_chat'
  // in the metadata (the MCP doors would masquerade as the portal).
  assert.match(clientChatApplySource, /metadata: \{[\s\S]*?surface: door/, 'metadata.surface must be the calling door');
  assert.doesNotMatch(clientChatApplySource, /metadata: \{[\s\S]*?surface: 'client_chat'/, 'metadata.surface must not be hardcoded');
  // The audit is emitted INSIDE the execute thunk, before the result returns
  // to the spine (so a failed receipt leaves the action un-stamped): the
  // emission sites sit between the writer calls and the `return { result`.
  const execStart = clientChatApplySource.indexOf('execute: async () => {');
  const stampStart = clientChatApplySource.indexOf('stamp: {', execStart);
  assert.ok(execStart > 0 && stampStart > execStart, 'execute thunk and stamp injection present');
  const thunk = clientChatApplySource.slice(execStart, stampStart);
  assert.equal((thunk.match(/await auditApplied\(/g) || []).length, 2, 'both verbs audit inside the execute thunk (mileage + answer)');
  assert.equal((clientChatApplySource.slice(stampStart).match(/auditApplied\(/g) || []).length, 0, 'no audit emission after the stamp');
});

await test('lint: api.js contains ZERO raw audit_events inserts — routes emit through the spine', () => {
  const rawInserts = apiSource.match(/insert into audit_events/g) || [];
  assert.equal(
    rawInserts.length,
    0,
    'a raw `insert into audit_events` appeared in api.js — route-level audit must go through auditChatApplyEvent'
  );
  assert.ok(apiSource.includes('auditChatApplyEvent('), 'api.js must emit route-level audit through the spine');
});

await test('lint: feedChatApply.js contains ZERO raw audit_events inserts — the dispatcher emits through the spine', () => {
  const rawInserts = feedChatApplySource.match(/insert into audit_events/g) || [];
  assert.equal(
    rawInserts.length,
    0,
    'a raw `insert into audit_events` appeared in feedChatApply.js — use auditChatApplyEvent'
  );
  assert.ok(
    feedChatApplySource.includes('auditChatApplyEvent('),
    'feedChatApply.js must emit its audit rows through the spine'
  );
});

// ─── the G2 PR-12 ratchet: route-level audit is audit-as-precondition ─────────
// The three route-level sites (review.recode_decided, reconciliation.reject_match,
// transaction.feed_chat_apply) flipped to `bestEffort: false` on G2 PR-12
// (docs/design-donna-chat-memory-godmode-build-spec-g2.md): an audit-insert
// failure propagates — the apply reports the error and the action stays
// proposed — instead of a warn line. A `bestEffort: true` re-appearing in
// either route file is the regression this pins; the CLAUDE.md end-state
// leaves NO best-effort route-level audit emission.

await test('lint: ZERO `bestEffort: true` audit emissions remain in api.js / feedChatApply.js / clientChatApply.js (G2 PR-12)', () => {
  for (const [name, source] of [['api.js', apiSource], ['feedChatApply.js', feedChatApplySource], ['clientChatApply.js', clientChatApplySource]]) {
    const relaxed = source.match(/bestEffort: true/g) || [];
    assert.equal(
      relaxed.length,
      0,
      `${name} carries ${relaxed.length} \`bestEffort: true\` audit emission(s) — route-level audit is audit-as-precondition since G2 PR-12`
    );
  }
});

// ─── the writer-dispatch lint: the applied-status stamp goes through the spine ─
// Pre-#4-writer-dispatch, each of the 12 verb branches invoked the status
// writer itself with an inline `status: 'applied'` and its own copy of the
// writer-error → HTTP mapping (4 of 12 caught the stamp's failure with
// action_type; 8 let it fall to the route catch without — the drift class the
// spine exists to close). The spine now owns the stamp: api.js may reference
// the status writers ONLY as the `write:` stamp injection, never invoke them.

await test('lint: every chat apply route in api.js dispatches through executeChatApplyAction', () => {
  const markerIndexes = CHAT_APPLY_ROUTE_MARKERS.map((marker) => {
    const idx = apiSource.indexOf(marker);
    assert.notEqual(idx, -1, `route marker missing from api.js: ${marker}`);
    return { marker, idx };
  });
  for (const { marker, idx } of markerIndexes) {
    const nextIdx = Math.min(
      ...markerIndexes.map((m) => (m.idx > idx ? m.idx : Infinity)),
      idx + 60000
    );
    const handler = apiSource.slice(idx, nextIdx);
    if (marker === CLIENT_CHAT_ROUTE_MARKER) {
      assert.ok(handler.includes('applyClientChatAction('), 'the client-chat route must delegate to applyClientChatAction');
      assert.ok(!handler.includes('executeChatApplyAction('), 'the client-chat route must not re-implement the executor beside the shared module');
      continue;
    }
    assert.ok(
      handler.includes('executeChatApplyAction('),
      `chat apply handler ${marker} does not dispatch through the spine executor`
    );
  }
  assert.ok(clientChatApplySource.includes('executeChatApplyAction('), 'clientChatApply.js must dispatch through the spine executor');
});

await test('lint: recode_decided mints a decided bare-line case through the named writer before applying', () => {
  const start = apiSource.indexOf("if (action.type === 'recode_decided')");
  const end = apiSource.indexOf("if (action.type === 'sync_to_accounting')", start);
  assert.notEqual(start, -1, 'recode_decided route missing');
  assert.ok(end > start, 'recode_decided route boundary missing');
  const handler = apiSource.slice(start, end);
  assert.match(handler, /ensureTransactionReviewItemInDb\(\{/,
    'a decided bare line must mint its case through the existing named writer');
  assert.match(handler, /preserveTransactionReviewState:\s*true/,
    'the case mint must derive the decided state from the persisted transaction');
  assert.match(handler, /const ensuredLookup = await queryFirmDb\(/,
    'the route must re-read the minted case before the decided-state guard');
  assert.match(handler, /updateTransactionReviewItemInDb\(\{/,
    'the recode consequence must still use the existing coding writer');
  assert.match(handler, /codingPatch\.account_code = action\.account_name/,
    'a name-only local-ledger recode must replace the prior transaction code');
  assert.doesNotMatch(handler, /update transactions\s+set/i,
    'the route must not add a direct transaction mutation');
});

await test('lint: api.js contains ZERO inline applied-status stamps — the spine owns `status: \'applied\'`', () => {
  const inlineStamps = apiSource.match(/status: 'applied'/g) || [];
  assert.equal(
    inlineStamps.length,
    0,
    "an inline `status: 'applied'` stamp appeared in api.js — route it through executeChatApplyAction's stamp injection"
  );
  const inlineFeedStamps = feedChatApplySource.match(/status: 'applied'/g) || [];
  assert.equal(inlineFeedStamps.length, 0, "an inline `status: 'applied'` stamp appeared in feedChatApply.js");
  const inlineClientStamps = clientChatApplySource.match(/status: 'applied'/g) || [];
  assert.equal(inlineClientStamps.length, 0, "an inline `status: 'applied'` stamp appeared in clientChatApply.js");
});

await test('lint: the chat action status writers are never INVOKED in api.js — only injected as the stamp', () => {
  // `updateTransactionChatActionStatusInDb(` / `updateDocumentChatActionStatusInDb(`
  // with an open paren is a direct invocation — a verb branch flipping an action
  // applied (or failed) without passing through the spine. The injection form
  // (`write: updateTransactionChatActionStatusInDb,`) has no paren.
  const directCalls = apiSource.match(/update(?:Transaction|Document|ClientPortal)ChatActionStatusInDb\(/g) || [];
  assert.equal(
    directCalls.length,
    0,
    'a chat action status writer is invoked directly in api.js — inject it via executeChatApplyAction({ stamp })'
  );
  assert.ok(
    apiSource.includes('write: updateTransactionChatActionStatusInDb'),
    'the transaction-chat stamp injection is missing from api.js'
  );
  assert.ok(
    apiSource.includes('write: updateDocumentChatActionStatusInDb'),
    'the document-chat stamp injection is missing from api.js'
  );
  // The client-chat stamp moved WITH the apply body to clientChatApply.js:
  // injected there (through the deps map), never invoked; api.js no longer
  // references the writer at all.
  assert.ok(
    !apiSource.includes('updateClientPortalChatActionStatusInDb'),
    'api.js must not reference the client-chat status writer (the apply body lives in clientChatApply.js)'
  );
  assert.ok(
    clientChatApplySource.includes('write: d.updateClientPortalChatActionStatusInDb'),
    'the client-chat stamp injection is missing from clientChatApply.js'
  );
  const clientDirectCalls = clientChatApplySource.match(/updateClientPortalChatActionStatusInDb\(/g) || [];
  assert.equal(clientDirectCalls.length, 0, 'the client-chat status writer is invoked directly in clientChatApply.js — inject it via the stamp');
});

await test('gate: the S4 acting role is forwarded verbatim into the capability check', async () => {
  let seen = null;
  const out = await gateChatApplyAction({
    surface: 'feed_chat',
    firmId: 'firm-1',
    clientId: 'client-1',
    principal: { email: 'owner@example.com' },
    message: message(),
    actionIndex: 0,
    appliableActionTypes: TYPES,
    specialistRoleId: 'invoicing_collections',
    assertCapability: async (args) => { seen = args; return { allowed: true }; }
  });
  assert.equal(out.disposition, 'proceed');
  assert.equal(seen.specialistRoleId, 'invoicing_collections');
  // And absent routing stays null — the firmDb law then resolves the
  // principal's own assignment (or none) untouched.
  await gateChatApplyAction({
    surface: 'feed_chat',
    message: message(),
    actionIndex: 0,
    appliableActionTypes: TYPES,
    assertCapability: async (args) => { seen = args; return { allowed: true }; }
  });
  assert.equal(seen.specialistRoleId, null);
});
