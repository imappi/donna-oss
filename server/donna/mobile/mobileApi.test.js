// DB-free tests for the mobile adapter: the contract pin, route coverage of
// every contract operation, schema conformance of every projection, the
// queue doctrine, and the request-level refusals that need no database
// (kill switch, CORS preflight, missing/admin tokens, sign-in rate limit).
// The PostgreSQL lifecycle lives in mobileApiPgLifecycle.test.js.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  componentSchema, contractOperations, MOBILE_CONTRACT, MOBILE_CONTRACT_SOURCE, responseSchemaFor, validateAgainst
} from './contractSchema.js';
import {
  __resetMobileSignInLimiterForTests, handleMobileApiRequest, MOBILE_API_PATH_PREFIX, mobileRouteState, NOT_IMPLEMENTED
} from './mobileApi.js';
import { SIGN_IN_MAX_PER_EMAIL } from './mobileAuth.js';
import { createFirmRouteDispatcher } from './mobileDispatch.js';
import {
  buildBooksStatus, buildQueue, parseCardId, projectApprovalCard, projectAskCard, projectDocument, projectEntity,
  projectFyiCard, projectParseStatus, projectPrincipal, projectReceipt
} from './mobileProjection.js';

const ok = (value, schema, label) => assert.deepEqual(validateAgainst(value, schema), [], label);
const component = (name) => ({ $ref: `#/components/schemas/${name}` });

test('the pinned contract is byte-identical to its recorded source', () => {
  const yaml = readFileSync(new URL('./contract/mobile-api.yaml', import.meta.url));
  assert.equal(createHash('sha256').update(yaml).digest('hex'), MOBILE_CONTRACT_SOURCE.yaml_sha256);
  assert.match(MOBILE_CONTRACT_SOURCE.commit, /^[0-9a-f]{40}$/);
  assert.equal(MOBILE_CONTRACT.info.version, MOBILE_CONTRACT_SOURCE.contract_version);
  assert.equal(MOBILE_CONTRACT.openapi, '3.1.0');
});

test('every contract operation is either routed or answers NOT_IMPLEMENTED — none falls through', () => {
  const operations = contractOperations();
  assert.equal(operations.length, 34, 'the 31 paths carry 34 operations');
  const states = {};
  for (const { pathTemplate, method } of operations) {
    const concrete = pathTemplate.replace('{artifactKind}', 'document').replace('{reviewKind}', 'taxes').replace(/\{[^}]+\}/g, 'x1');
    const state = mobileRouteState(method, concrete);
    assert.ok(state, `${method} ${pathTemplate} is unrouted`);
    states[`${method} ${pathTemplate}`] = state;
  }
  const implemented = Object.entries(states).filter(([, state]) => state === 'implemented').map(([key]) => key).sort();
  assert.deepEqual(implemented, [
    'DELETE /auth/sessions/current',
    'DELETE /notifications/registrations/{registrationId}',
    'GET /entities/{entityId}/business-setup',
    'GET /entities/{entityId}/documents',
    'GET /entities/{entityId}/documents/parse-status',
    'GET /entities/{entityId}/documents/{documentId}',
    'GET /entities/{entityId}/queue',
    'GET /entities/{entityId}/queue/cards/{cardId}',
    'GET /entities/{entityId}/settings',
    'GET /entities/{entityId}/status',
    'GET /me',
    'POST /auth/sessions',
    'POST /auth/sessions/refresh',
    'POST /entities/{entityId}/business-setup',
    'POST /entities/{entityId}/documents/register',
    'POST /entities/{entityId}/documents/upload-intent',
    'POST /entities/{entityId}/documents/{documentId}/resolve-duplicate',
    'POST /entities/{entityId}/documents/{documentId}/retry',
    'POST /entities/{entityId}/queue/cards/{cardId}/decision',
    'POST /entities/{entityId}/settings',
    'POST /me/deletion-request',
    'POST /notifications/registrations',
    'PUT /entities/{entityId}/onboarding/profile'
  ]);
  assert.equal(operations.length - implemented.length, NOT_IMPLEMENTED.length, 'one 501 entry per remaining operation');
});

// ── Projection conformance ────────────────────────────────────────────────
const ask = (overrides = {}) => ({
  id: 'er-1', client_id: 'c1', transaction_id: 'tx-1', status: 'open', audience: 'client', evidence_type: 'business_purpose',
  question: 'What was this for?', request_payload: { date: '2026-10-14', amount: -9.15, currency: 'EUR', transaction_description: 'CITY GYM' },
  response_payload: {}, first_sent_at: '2026-10-15T08:00:00.000Z', created_at: '2026-10-15T07:00:00.000Z', responded_at: null, ...overrides
});
const held = { id: 'oa-1', action_type: 'send_receivable_reminder', description: 'Payment reminder (step 1) to A Ltd', hold_copy: 'First reminder to this customer.', party_name: 'A Ltd', amount: '480.00', currency: 'GBP', created_at: '2026-11-01T10:00:00.000Z' };
const sent = { id: 'oa-2', description: 'Payment reminder (step 1) to B Ltd', sent_at: '2026-11-02T10:00:00.000Z', marked_wrong_at: null };

test('cards of all three classes conform to QueueCard, with exactly the matching payload key', () => {
  const cards = [
    projectAskCard(ask(), 'c1'),
    projectAskCard(ask({ status: 'replied', response_payload: { reply: 'Gym for a client visit' }, responded_at: '2026-10-16T09:00:00Z' }), 'c1'),
    projectAskCard(ask({ request_payload: {}, transaction_id: null, question: null }), 'c1'),
    projectApprovalCard(held, 'c1'),
    projectApprovalCard({ ...held, amount: null, currency: null, party_name: null, hold_copy: null }, 'c1'),
    projectFyiCard(sent, 'c1'),
    projectFyiCard({ ...sent, marked_wrong_at: '2026-11-03T10:00:00Z' }, 'c1')
  ];
  for (const card of cards) {
    ok(card, component('QueueCard'), card.id);
    assert.deepEqual(['ask', 'approval', 'fyi'].filter((key) => key in card), [card.class]);
    assert.deepEqual(parseCardId(card.id), { kind: card.source.kind, id: card.source.id });
  }
  assert.equal(cards[1].state, 'answered');
  assert.equal(cards[3].amount, 480);
  assert.deepEqual(cards[6].fyi.corrective_verbs, [], 'a flagged FYI offers no second flag');
});

test('the queue doctrine: the badge is the open ask+approval cards of the same list; drafts and colleague asks never appear', () => {
  const queue = buildQueue({
    entityId: 'c1',
    requests: [ask(), ask({ id: 'er-2', status: 'draft' }), ask({ id: 'er-3', audience: 'seat' }), ask({ id: 'er-4', status: 'replied' }), ask({ id: 'er-5', audience: 'agent' })],
    surface: { pending: [held], auto_sent: [sent, { ...sent, id: 'oa-3', sent_at: null }] },
    generatedAt: new Date('2026-11-09T12:00:00Z')
  });
  ok(queue, component('QueueResponse'));
  assert.deepEqual(queue.cards.map((card) => card.id), ['outbound_action:oa-1', 'client_evidence_request:er-1', 'outbound_action_sent:oa-2']);
  assert.equal(queue.needs_you_count, 2);
  assert.equal(buildQueue({ entityId: 'c1' }).needs_you_count, 0);
});

test('documents: the persisted parse_status in owner words, needs_info only from an anchored open ask', () => {
  const row = { id: 'd1', filename: 'receipt.jpg', parse_status: 'completed', uploaded_at: new Date('2026-11-09T10:00:00Z'),
    document_type: 'receipt', document_date: new Date(2026, 10, 8), total_amount: '12.50', currency: 'EUR', vendor_name: 'Cafe' };
  const expectations = [
    [{ parse_status: 'pending' }, 'received'], [{ parse_status: 'processing' }, 'processing'], [{}, 'attached'],
    [{ parse_status: null }, 'attached'], [{ parse_status: 'failed', parse_error: { safe_user_message: 'Could not read.' } }, 'failed'],
    [{ parse_status: 'skipped', duplicate_of: 'd0' }, 'stored'], [{ parse_status: 'duplicate_pending' }, 'duplicate']
  ];
  for (const [patch, state] of expectations) {
    const doc = projectDocument({ ...row, ...patch }, { entityId: 'c1' });
    ok(doc, component('Document'), state);
    assert.equal(doc.capture_state, state);
  }
  const needsInfo = projectDocument(row, { entityId: 'c1', openAskByDocument: new Map([['d1', 'er-9']]) });
  assert.equal(needsInfo.capture_state, 'needs_info');
  assert.equal(needsInfo.needs_info_card_id, 'client_evidence_request:er-9');
  assert.equal(needsInfo.document_date, '2026-11-08');
  assert.equal(projectDocument({ ...row, parse_status: 'processing' }, { entityId: 'c1', openAskByDocument: new Map([['d1', 'er-9']]) }).capture_state, 'processing');
  assert.equal(projectDocument({ ...row, parse_status: 'failed', parse_error: { safe_user_message: 'Could not read.' } }, { entityId: 'c1' }).failure_message, 'Could not read.');
  for (const parse of [{ id: 'd1', parse_status: 'processing', parse_stage: 'extracting', parse_progress_current: 1, parse_progress_total: 3 },
    { id: 'd2', parse_status: 'failed', parse_error: { code: 'X', safe_user_message: 'No.', retryable: true } },
    { id: 'd3', parse_status: 'completed', parse_completed_at: '2026-11-09T10:00:00.000Z', parse_stage: 'unknown_stage' }]) {
    ok(projectParseStatus(parse), component('ParseStatus'), parse.id);
  }
});

test('entity, principal, receipt and status projections conform', () => {
  ok(projectEntity({ id: 'c1', company_name: 'Kestrel Print Studio Ltd', jurisdiction: 'gb', entity_type: 'gb-ltd', profile_currency: null, firm_currency: 'GBP' }), component('Entity'));
  ok(projectEntity({ id: 'c2', company_name: null, jurisdiction: null, firm_jurisdiction: null }), component('Entity'));
  ok(projectPrincipal({ principal: { principalId: 'collab-1', name: null }, identity: { email: 'owner@example.test' } }), component('Principal'));
  ok(projectReceipt({ summary: 'Done.', targets: [{ target: 'client_evidence_request:er-1', applied: true }], auditRows: [{ id: '41', created_at: new Date() }] }), component('Receipt'));
  const queue = buildQueue({ entityId: 'c1', requests: [ask(), ask({ id: 'er-4', status: 'replied' })] });
  const status = buildBooksStatus({
    periods: [{ id: 'p-oct', period_start: '2026-10-01', period_end: '2026-10-31', status: 'reviewing', payload: { close_status: 'review' } },
      { id: 'p-sep', period_start: '2026-09-01', period_end: '2026-09-30', status: 'locked', payload: {} }],
    checks: [{ close_period_id: 'p-oct', check_type: 'client_evidence', status: 'warning', payload: { count: 2 } },
      { close_period_id: 'p-oct', check_type: 'ledger_balance', status: 'passed', payload: {} },
      { close_period_id: 'p-oct', check_type: 'some_future_check', status: 'blocked', summary: 'Persisted summary.', payload: {} }],
    queue, requests: [ask(), ask({ id: 'er-4', status: 'replied' })], now: new Date('2026-11-09T12:00:00Z')
  });
  ok(status, component('BooksStatus'));
  assert.deepEqual(status.periods.map((period) => [period.period_start, period.state, period.lifecycle]),
    [['2026-11-01', 'unchecked', 'open'], ['2026-10-01', 'review', 'reviewing'], ['2026-09-01', 'unchecked', 'locked']]);
  assert.equal(status.periods[0].label, 'November 2026');
  assert.deepEqual(status.periods[1].blockers.map((blocker) => [blocker.code, blocker.on, blocker.count]),
    [['client_evidence', 'you', 2], ['some_future_check', 'donna', null]]);
  assert.equal(status.periods[1].blockers[1].label, 'Persisted summary.');
  assert.equal(status.needs_you_count, queue.needs_you_count);
  assert.equal(status.donna_working_count, 1);
  assert.match(buildBooksStatus({ periods: [], checks: [], queue, now: new Date('2026-11-09T12:00:00Z'), locale: 'fi' }).periods[0].label, /2026/);
});

// ── Request-level behaviour without a database ────────────────────────────
const call = async ({ method = 'GET', path, headers = {}, body, deps = {} }) => {
  const encoded = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(encoded ? [Buffer.from(encoded)] : []);
  req.method = method; req.url = `${MOBILE_API_PATH_PREFIX}${path}`; req.headers = headers;
  const headersOut = {};
  let text = '';
  const res = { statusCode: 200, setHeader: (name, value) => { headersOut[name.toLowerCase()] = value; }, end: (value = '') => { text = String(value); res.writableEnded = true; } };
  await handleMobileApiRequest(req, res, new URL(req.url, 'http://local'), {
    resolveAuth: async () => null,
    identityProvider: () => ({ url: 'https://idp.unit.invalid', publishableKey: 'anon' }),
    dispatchFirmRoute: async () => { throw new Error('no firm route in unit tests'); },
    publicOrigin: () => 'https://donna.unit.invalid',
    ...deps
  });
  return { status: res.statusCode, headers: headersOut, json: text ? JSON.parse(text) : null };
};
const apiError = (response, status, code) => {
  assert.equal(response.status, status, JSON.stringify(response.json));
  ok(response.json, component('ApiError'));
  assert.equal(response.json.code, code);
};

test('CORS: any origin, never credentials; the preflight allows the contract’s methods', async () => {
  const preflight = await call({ method: 'OPTIONS', path: '/auth/sessions/current' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], '*');
  assert.match(preflight.headers['access-control-allow-methods'], /DELETE/);
  assert.match(preflight.headers['access-control-allow-headers'], /Authorization/);
  assert.equal(preflight.headers['access-control-allow-credentials'], undefined);
  assert.equal(preflight.headers['cache-control'], 'no-store');
});

test('the kill switch turns the whole surface off, sign-in included', async () => {
  process.env.DONNA_MOBILE_API = 'off';
  try {
    for (const request of [{ method: 'POST', path: '/auth/sessions', body: { email: 'a@example.test', password: 'x' } }, { path: '/me' }, { path: '/entities/c1/queue' }]) {
      apiError(await call(request), 503, 'MOBILE_API_DISABLED');
    }
  } finally {
    delete process.env.DONNA_MOBILE_API;
  }
});

test('no token, an unverifiable token and the shared access token are all 401', async () => {
  apiError(await call({ path: '/me' }), 401, 'AUTH_REQUIRED');
  apiError(await call({ path: '/me', headers: { authorization: 'Bearer junk' } }), 401, 'AUTH_REQUIRED');
  apiError(await call({ path: '/entities/c1/queue', headers: { authorization: 'Bearer admin' }, deps: { resolveAuth: async () => ({ type: 'access_token' }) } }), 401, 'AUTH_REQUIRED');
  apiError(await call({ path: '/me', headers: { authorization: 'Bearer cron' }, deps: { resolveAuth: async () => ({ type: 'cron_secret' }) } }), 401, 'AUTH_REQUIRED');
});

test('sign-in: unconfigured IdP is 503, bad input 400, wrong password 401, then the per-email limit is 429', async (t) => {
  __resetMobileSignInLimiterForTests();
  apiError(await call({ method: 'POST', path: '/auth/sessions', body: { email: 'a@example.test', password: 'x' }, deps: { identityProvider: () => ({}) } }), 503, 'IDENTITY_PROVIDER_NOT_CONFIGURED');
  apiError(await call({ method: 'POST', path: '/auth/sessions', body: { email: 'a@example.test' } }), 400, 'BAD_REQUEST');
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  let grants = 0;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), 'https://idp.unit.invalid/auth/v1/token?grant_type=password');
    grants += 1;
    return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
  };
  __resetMobileSignInLimiterForTests();
  for (let attempt = 1; attempt <= SIGN_IN_MAX_PER_EMAIL; attempt += 1) {
    apiError(await call({ method: 'POST', path: '/auth/sessions', body: { email: 'Owner@Example.test', password: 'wrong' } }), 401, 'INVALID_CREDENTIALS');
  }
  const limited = await call({ method: 'POST', path: '/auth/sessions', body: { email: 'owner@example.test', password: 'wrong' } });
  apiError(limited, 429, 'SIGN_IN_RATE_LIMITED');
  assert.ok(Number(limited.headers['retry-after']) > 0);
  assert.equal(grants, SIGN_IN_MAX_PER_EMAIL, 'a limited attempt never reaches the identity provider');
  assert.ok(responseSchemaFor('/auth/sessions', 'POST', 401));
  __resetMobileSignInLimiterForTests();
});

test('the dispatcher runs a firm route with the verified identity and only the mapped body', async () => {
  let seen = null;
  const dispatch = createFirmRouteDispatcher({
    auth: { type: 'supabase_user', userId: 'u1', email: 'owner@example.test' },
    forwardHeaders: { host: 'donna.unit.invalid' },
    firmHandler: async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      seen = { url: req.url, method: req.method, auth: req.donnaAuth, host: req.headers.host, body: JSON.parse(Buffer.concat(chunks).toString()) };
      res.statusCode = 201;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    }
  });
  const response = await dispatch({ method: 'POST', path: '/evidence/requests/er%201/resolve', query: { firm_id: 'f1', empty: '' }, body: { reply: 'hi' } });
  assert.deepEqual(response, { status: 201, body: { ok: true } });
  assert.deepEqual(seen, { url: '/evidence/requests/er%201/resolve?firm_id=f1', method: 'POST', auth: { type: 'supabase_user', userId: 'u1', email: 'owner@example.test' }, host: 'donna.unit.invalid', body: { reply: 'hi' } });
  const thrown = await createFirmRouteDispatcher({ auth: {}, firmHandler: async () => { throw Object.assign(new Error('nope'), { statusCode: 403, code: 'FIRM_ACCESS_DENIED' }); } })({ path: '/x' });
  assert.deepEqual(thrown, { status: 403, body: { error: 'nope', code: 'FIRM_ACCESS_DENIED' } });
});

test('the validator itself rejects what the contract forbids', () => {
  assert.notDeepEqual(validateAgainst({ ...projectAskCard(ask(), 'c1'), class: 'todo' }, component('QueueCard')), []);
  assert.notDeepEqual(validateAgainst({ ...projectAskCard(ask(), 'c1'), created_at: '2026-10-15T08:00:00' }, component('QueueCard')), [], 'an offset-less timestamp is refused');
  assert.notDeepEqual(validateAgainst({ ...projectAskCard(ask(), 'c1'), occurred_on: '2026-10-14T00:00:00Z' }, component('QueueCard')), [], 'a timestamp is not a business date');
  assert.notDeepEqual(validateAgainst({ type: 'approve', note: 'x'.repeat(2001) }, componentSchema('Decision')), []);
});
