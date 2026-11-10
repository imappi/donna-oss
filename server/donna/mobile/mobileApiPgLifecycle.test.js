// The mobile adapter end to end on real PostgreSQL, through the real runtime
// server and the real firm routes (appliance harness): an owner signs in,
// uploads a receipt and follows it to parsed, sees Donna's question about it,
// answers it and watches it leave the queue with the consequence recorded by
// the portal's own reply writer, and reads Status. Refusals: a firm member, a
// staff seat, another client's entity, an expired token, the shared access
// token, and the kill switch. Every response is checked against the pinned
// contract. All identities and companies are synthetic.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';

import { applianceHarnessSkipReason, bootApplianceForTest } from '../testSupport/applianceHarness.js';
import { loadApplianceFixture } from '../fixtures/appliance/index.js';
import { createClientEvidenceRequestInDb, withFirmDbClient } from '../firmDb.js';
import { provisionEntityReadiness } from '../runtimeReadiness.js';
import { selfProvisionClientWorkspace } from '../selfProvisionDb.js';
import { responseSchemaFor, validateAgainst } from './contractSchema.js';
import { __resetMobileSignInLimiterForTests, MOBILE_API_PATH_PREFIX } from './mobileApi.js';

const IDP = 'https://idp.mobile-fixture.invalid';
const IDENTITIES = {
  owner: { id: 'user-mobile-owner', email: 'owner@mobile-fixture.example', password: 'owner-pass' },
  neighbour: { id: 'user-mobile-neighbour', email: 'neighbour@mobile-fixture.example', password: 'neighbour-pass' },
  seat: { id: 'user-mobile-seat', email: 'seat@mobile-fixture.example', password: 'seat-pass' },
  member: { id: 'user-mobile-member', email: 'member@mobile-fixture.example', password: 'member-pass' }
};

// The identity provider at the wire: password + refresh grants, /user, logout.
const installIdentityProvider = () => {
  const realFetch = globalThis.fetch;
  const live = new Map(); // access token -> identity key
  const revoked = [];
  const revokedScopes = [];
  let seq = 0;
  const mint = (key) => {
    seq += 1;
    const access = `access-${key}-${seq}`;
    live.set(access, key);
    return { access_token: access, refresh_token: `refresh-${key}-${seq}`, expires_in: 3600, token_type: 'bearer' };
  };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.origin !== IDP) return realFetch(input, init);
    const bearer = String(init.headers?.Authorization || '').replace(/^Bearer\s+/i, '');
    if (url.pathname === '/auth/v1/user') {
      const key = live.get(bearer);
      return key ? json({ id: IDENTITIES[key].id, email: IDENTITIES[key].email }) : json({ msg: 'invalid JWT' }, 401);
    }
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
      const body = JSON.parse(init.body);
      const key = Object.keys(IDENTITIES).find((name) => IDENTITIES[name].email === body.email && IDENTITIES[name].password === body.password);
      return key ? json(mint(key)) : json({ error: 'invalid_grant', error_description: 'Invalid login credentials' }, 400);
    }
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
      const body = JSON.parse(init.body);
      const key = Object.keys(IDENTITIES).find((name) => String(body.refresh_token).startsWith(`refresh-${name}-`));
      return key ? json(mint(key)) : json({ error: 'invalid_grant' }, 400);
    }
    if (url.pathname === '/auth/v1/logout') {
      // The provider's rule: no scope (or `global`) ends EVERY session of the
      // user; `local` ends only the session of the token presented.
      const scope = url.searchParams.get('scope') || 'global';
      const key = live.get(bearer);
      revoked.push(bearer);
      revokedScopes.push(scope);
      if (scope === 'local') live.delete(bearer);
      else for (const [access, owner] of [...live]) if (owner === key) live.delete(access);
      return new Response(null, { status: 204 });
    }
    return json({ error: 'unexpected' }, 404);
  };
  return {
    revoked,
    revokedScopes,
    // A session opened somewhere else (the web portal), not through the adapter.
    openElsewhere: (key) => mint(key).access_token,
    isLive: (token) => live.has(token),
    expire: (token) => live.delete(token),
    restore: () => { globalThis.fetch = realFetch; }
  };
};

const conform = (pathTemplate, method, response) => {
  const schema = responseSchemaFor(pathTemplate, method, response.status);
  assert.ok(schema, `${method} ${pathTemplate} → ${response.status} is a contract response: ${response.text.slice(0, 300)}`);
  assert.deepEqual(validateAgainst(response.json, schema), [], `${method} ${pathTemplate} → ${response.status} conforms`);
  return response.json;
};
const conformError = (response, status, code) => {
  assert.equal(response.status, status, response.text);
  assert.deepEqual(validateAgainst(response.json, { $ref: '#/components/schemas/ApiError' }), []);
  if (code) assert.equal(response.json.code, code);
};

test('real PG: an owner signs in, captures a receipt, answers Donna, and reads status through the mobile adapter', {
  skip: applianceHarnessSkipReason(), timeout: 600_000
}, async (t) => {
  const idp = installIdentityProvider();
  __resetMobileSignInLimiterForTests();
  const appliance = await bootApplianceForTest({
    env: { SUPABASE_URL: IDP, SUPABASE_ANON_KEY: 'fixture-anon', SUPABASE_PUBLISHABLE_KEY: '', DONNA_AUTH_ALLOWED_EMAILS: '', DONNA_MOBILE_API: '' }
  });
  t.after(async () => { await appliance.stop(); idp.restore(); });
  const { firmId } = appliance;
  // Owners exactly as self-signup creates them today: the real writer behind
  // /self-provision (cloud-fenced as a ROUTE on this host, the writer is the
  // same), which mints the book, the non-seat owner collaborator and its one
  // capability assignment, and certifies the book under the owner profile.
  process.env.DONNA_DEFAULT_FIRM_ID = firmId;
  const provision = async (key, companyName) => {
    const result = await selfProvisionClientWorkspace({ auth: { userId: IDENTITIES[key].id, email: IDENTITIES[key].email },
      companyName, jurisdiction: 'GB', entityType: 'gb-ltd' });
    assert.ok(result.clientId, JSON.stringify(result));
    // …followed by the route's own readiness step (api.js /self-provision).
    await provisionEntityReadiness({ withFirmDbClientFn: withFirmDbClient, firmId, clientId: result.clientId,
      creationPath: 'self_provision', lifecycle: 'cold_create', compatibilityScope: 'birth_residue_proof',
      initiatingPrincipal: { actor_type: 'supabase_user', actor_id: IDENTITIES[key].id },
      authorityBasis: { source: 'authenticated_self_provision_route', principal_id: IDENTITIES[key].id } });
    const readiness = await appliance.read.readiness(result.clientId);
    assert.equal(readiness?.state, 'ready', JSON.stringify(readiness));
    return result.clientId;
  };
  const clientId = await provision('owner', 'Kestrel Print Studio Ltd');
  const neighbourClientId = await provision('neighbour', 'Harbour Lantern Repairs Ltd');
  delete process.env.DONNA_DEFAULT_FIRM_ID;
  await appliance.query("update firm_collaborators set name = 'Fixture owner' where firm_id = $1 and lower(email) = $2", [firmId, IDENTITIES.owner.email]);
  // A staff seat and a firm member in the same firm.
  await appliance.query(
    `insert into firm_collaborators (id, firm_id, user_id, email, name, role, status, access_level, seat_role)
     values ('collab-seat', $1, $2, $3, 'Fixture seat', 'bookkeeper', 'active', 'client_scoped', 'junior')`,
    [firmId, IDENTITIES.seat.id, IDENTITIES.seat.email]
  );
  await appliance.query(
    `insert into firm_members (id, firm_id, user_id, email, name, role, status, access_level)
     values ('member-mobile', $1, $2, $3, 'Fixture member', 'member', 'active', 'staff')`,
    [firmId, IDENTITIES.member.id, IDENTITIES.member.email]
  );

  const api = ({ method = 'GET', path, token, body, headers = {} }) => appliance.api.request({
    method, path: `${MOBILE_API_PATH_PREFIX}${path}`, body,
    headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) }
  });
  const signIn = (key, password = IDENTITIES[key].password) =>
    api({ method: 'POST', path: '/auth/sessions', body: { email: IDENTITIES[key].email, password } });

  // ── Sign in ─────────────────────────────────────────────────────────────
  const session = conform('/auth/sessions', 'POST', await signIn('owner'));
  assert.deepEqual(session.entities.map((entity) => entity.id), [clientId], 'exactly the owner’s own books');
  assert.equal(session.default_entity_id, clientId);
  assert.equal(session.principal.email, IDENTITIES.owner.email);
  assert.equal(session.principal.display_name, 'Fixture owner');
  // The owner surface rule is the snapshot's own.
  const snapshot = await appliance.api.request({ path: `/api/donna/firms/snapshot?firm_id=${firmId}`, headers: { authorization: `Bearer ${session.access_token}` } });
  assert.equal(snapshot.json.workspaceAccess.surface, 'owner');
  let token = session.access_token;
  const me = conform('/me', 'GET', await api({ path: '/me', token }));
  assert.deepEqual(me.entities, session.entities);

  // Refresh mints a new pair for the same principal.
  const refreshed = conform('/auth/sessions/refresh', 'POST', await api({ method: 'POST', path: '/auth/sessions/refresh', body: { refresh_token: session.refresh_token } }));
  assert.notEqual(refreshed.access_token, token);
  token = refreshed.access_token;
  conformError(await signIn('owner', 'wrong'), 401, 'INVALID_CREDENTIALS');

  // ── Refusals ────────────────────────────────────────────────────────────
  await t.test('staff identities are refused and their provider session is revoked', async () => {
    for (const key of ['member', 'seat']) {
      const web = idp.openElsewhere(key);
      const before = idp.revoked.length;
      conformError(await signIn(key), 403, 'MOBILE_OWNER_ONLY');
      assert.equal(idp.revoked.length, before + 1, `${key}: the minted session was revoked`);
      assert.equal(idp.revokedScopes.at(-1), 'local', `${key}: only the session just minted is revoked`);
      assert.ok(idp.isLive(web), `${key}: the web session survives the phone's refusal`);
    }
  });
  await t.test('another client’s entity is not found, for reads and writes', async () => {
    conformError(await api({ path: `/entities/${neighbourClientId}/queue`, token }), 404, 'NOT_FOUND');
    conformError(await api({ path: `/entities/${neighbourClientId}/status`, token }), 404, 'NOT_FOUND');
    conformError(await api({ method: 'POST', path: `/entities/${neighbourClientId}/documents/upload-intent`, token,
      body: { filename: 'x.pdf', mime_type: 'application/pdf', size: 10, checksum_sha256: 'a'.repeat(64) } }), 404, 'NOT_FOUND');
    conformError(await api({ path: `/entities/${neighbourClientId}/settings`, token }), 404, 'NOT_FOUND');
  });
  await t.test('no token, an expired token and the shared access token are 401', async () => {
    conformError(await api({ path: '/me' }), 401, 'AUTH_REQUIRED');
    const stale = conform('/auth/sessions', 'POST', await signIn('owner'));
    idp.expire(stale.access_token);
    conformError(await api({ path: '/me', token: stale.access_token }), 401, 'AUTH_REQUIRED');
    conformError(await api({ path: `/entities/${clientId}/queue`, token: appliance.accessToken }), 401, 'AUTH_REQUIRED');
  });
  await t.test('unimplemented contract paths answer 501 in the error envelope', async () => {
    conformError(await api({ path: `/entities/${clientId}/chat`, token }), 501, 'NOT_IMPLEMENTED');
    conformError(await api({ path: `/entities/${clientId}/activity`, token }), 501, 'NOT_IMPLEMENTED');
  });

  // ── Queue starts empty; status starts unchecked ─────────────────────────
  const emptyQueue = conform('/entities/{entityId}/queue', 'GET', await api({ path: `/entities/${clientId}/queue`, token }));
  assert.equal(emptyQueue.needs_you_count, 0);
  assert.deepEqual(emptyQueue.cards, []);

  // ── Capture: intent → PUT → register → parse ────────────────────────────
  const source = loadApplianceFixture('supplier_bill_discount');
  const checksum = createHash('sha256').update(source.bytes).digest('hex');
  const intent = conform('/entities/{entityId}/documents/upload-intent', 'POST', await api({
    method: 'POST', path: `/entities/${clientId}/documents/upload-intent`, token,
    body: { filename: source.filename, mime_type: 'application/pdf', size: source.bytes.length, checksum_sha256: checksum }
  }));
  assert.ok(intent.storage_object_key.startsWith(`${firmId}/${clientId}/`), intent.storage_object_key);
  // The phone PUTs to the absolute URL it was given, exactly as handed out.
  assert.equal(new URL(intent.upload_url).origin, appliance.baseUrl, 'a reachable origin, not an https guess');
  const put = await fetch(intent.upload_url, { method: 'PUT', headers: intent.headers, body: source.bytes });
  assert.equal(put.status, 200, await put.text());

  appliance.providers.script('document_routing', ['document_routing/ochre-supplier-bill']);
  appliance.providers.script('unified_extraction', ['unified_extraction/ochre-discount-line']);
  appliance.providers.script('document_disposition', ['document_disposition/ochre-bill-uncovered-account']);
  const registration = { id: `${clientId}-mobile-capture-1`, filename: source.filename, storage_bucket: intent.storage_bucket,
    storage_object_key: intent.storage_object_key, checksum_sha256: checksum, captured_at: '2026-11-09T08:15:00+02:00', source: 'camera' };
  const register = () => api({ method: 'POST', path: `/entities/${clientId}/documents/register`, token, body: { documents: [registration] } });
  // Concurrent identical registrations (an offline replay racing the live
  // send) collapse onto one document, exactly as on the web.
  const raced = await Promise.all([register(), register(), register()]);
  for (const response of raced) conform('/entities/{entityId}/documents/register', 'POST', response);
  assert.deepEqual([...new Set(raced.map((response) => response.json.documents[0].id))], [registration.id]);
  assert.equal((await appliance.query('select count(*)::int n from documents where firm_id = $1 and client_id = $2', [firmId, clientId])).rows[0].n, 1);
  assert.equal(raced[0].json.documents[0].capture_state, 'received');
  // A second capture of the same bytes under a fresh upload auto-collapses.
  const twinIntent = (await api({ method: 'POST', path: `/entities/${clientId}/documents/upload-intent`, token,
    body: { filename: source.filename, mime_type: 'application/pdf', size: source.bytes.length, checksum_sha256: checksum } })).json;
  assert.equal((await fetch(twinIntent.upload_url, { method: 'PUT', headers: twinIntent.headers, body: source.bytes })).status, 200);
  const twin = conform('/entities/{entityId}/documents/register', 'POST', await api({ method: 'POST', path: `/entities/${clientId}/documents/register`, token,
    body: { documents: [{ ...registration, id: `${clientId}-mobile-capture-twin`, storage_object_key: twinIntent.storage_object_key }] } }));
  assert.equal(twin.documents[0].capture_state, 'stored');
  assert.equal(twin.documents[0].duplicate_of, registration.id);
  // Someone else's upload key cannot be registered here.
  conformError(await api({ method: 'POST', path: `/entities/${clientId}/documents/register`, token,
    body: { documents: [{ ...registration, id: 'foreign-key', storage_object_key: `${firmId}/${neighbourClientId}/evidence/x.pdf` }] } }), 400, 'UPLOAD_NOT_IN_ENTITY');

  const pending = conform('/entities/{entityId}/documents/parse-status', 'GET', await api({ path: `/entities/${clientId}/documents/parse-status?ids=${registration.id}`, token }));
  assert.equal(pending.documents[0].parse_status, 'pending');
  const tick = await appliance.tick();
  const parsed = conform('/entities/{entityId}/documents/parse-status', 'GET', await api({ path: `/entities/${clientId}/documents/parse-status?ids=${registration.id}`, token }));
  assert.equal(parsed.documents[0].parse_status, 'completed', JSON.stringify({ parsed, log: tick.log.slice(-10) }));
  assert.ok(parsed.documents[0].parse_completed_at);
  // Another client's id is filtered out of parse-status, never echoed.
  const filtered = conform('/entities/{entityId}/documents/parse-status', 'GET', await api({ path: `/entities/${clientId}/documents/parse-status?ids=${registration.id},nope`, token }));
  assert.deepEqual(filtered.documents.map((row) => row.id), [registration.id]);

  const list = conform('/entities/{entityId}/documents', 'GET', await api({ path: `/entities/${clientId}/documents?limit=1`, token }));
  assert.equal(list.documents.length, 1);
  assert.ok(list.next_cursor, 'two documents, page of one');
  const page2 = conform('/entities/{entityId}/documents', 'GET', await api({ path: `/entities/${clientId}/documents?limit=1&cursor=${list.next_cursor}`, token }));
  assert.equal(page2.documents.length, 1);
  assert.equal(page2.next_cursor, null);
  assert.notEqual(page2.documents[0].id, list.documents[0].id);
  const detail = conform('/entities/{entityId}/documents/{documentId}', 'GET', await api({ path: `/entities/${clientId}/documents/${registration.id}`, token }));
  assert.equal(detail.captured_at, '2026-11-09T06:15:00.000Z');
  assert.equal(detail.total_amount, source.expected.total_amount);
  assert.equal(detail.counterparty, source.expected.vendor_name);
  conformError(await api({ path: `/entities/${clientId}/documents/${clientId}-nope`, token }), 404, 'NOT_FOUND');

  // Retry is firm-only on Donna today; the owner gets a clear refusal.
  conformError(await api({ method: 'POST', path: `/entities/${clientId}/documents/${registration.id}/retry`, token }), 403, 'RETRY_NOT_AVAILABLE_TO_OWNER');

  // ── Donna asks about the receipt (the named ask writer) ─────────────────
  // Minted by the named ask writer (it lands `draft`). Sending it is the
  // ask-batch drafter's job (a model lane, out of scope here), so the fixture
  // stands in for the send with the state change the sender makes.
  await createClientEvidenceRequestInDb({ firmId, clientId, documentId: registration.id, evidenceType: 'business_purpose',
    question: 'What was this purchase from the supplier for?', actorId: 'system', returnSnapshot: false });
  await appliance.query(
    "update client_evidence_requests set status = 'open', first_sent_at = now(), last_sent_at = now(), send_count = 1 where firm_id = $1 and client_id = $2 and status = 'draft' and audience = 'client'",
    [firmId, clientId]);
  const openAsks = (await appliance.query(
    "select id from client_evidence_requests where firm_id = $1 and client_id = $2 and status = 'open' and audience = 'client'",
    [firmId, clientId])).rows;
  assert.ok(openAsks.length >= 1, 'an open owner ask exists');
  // A draft the firm has not sent never reaches the phone.
  await createClientEvidenceRequestInDb({ firmId, clientId, documentId: twin.documents[0].id, evidenceType: 'supporting_document',
    question: 'Draft: is this a duplicate?', actorId: 'system', returnSnapshot: false }).catch(() => null);
  // An internal colleague question on the same book never reaches the phone.
  await createClientEvidenceRequestInDb({ firmId, clientId, documentId: registration.id, evidenceType: 'supporting_document',
    question: 'Colleague: please check the VAT line.', actorId: 'system', audience: 'seat',
    addresseePrincipalType: 'firm_member', addresseePrincipalId: 'member-mobile', returnSnapshot: false });

  const queue = conform('/entities/{entityId}/queue', 'GET', await api({ path: `/entities/${clientId}/queue`, token }));
  assert.equal(queue.needs_you_count, openAsks.length);
  assert.equal(queue.needs_you_count, queue.cards.filter((card) => card.state === 'open' && card.class !== 'fyi').length, 'badge = the list');
  assert.ok(queue.cards.every((card) => card.class === 'ask' && !/Colleague|Draft/.test(card.title)), 'no seat ask and no draft reaches the owner');
  const card = queue.cards.find((entry) => entry.document_id === registration.id) || queue.cards[0];
  const cardPath = `/entities/${clientId}/queue/cards/${encodeURIComponent(card.id)}`;
  assert.deepEqual(conform('/entities/{entityId}/queue/cards/{cardId}', 'GET', await api({ path: cardPath, token })), card);
  if (card.document_id === registration.id) {
    const needsInfo = conform('/entities/{entityId}/documents/{documentId}', 'GET', await api({ path: `/entities/${clientId}/documents/${registration.id}`, token }));
    assert.equal(needsInfo.capture_state, 'needs_info');
    assert.equal(needsInfo.needs_info_card_id, card.id);
  }

  // The closed grammar: approve on an ask is a doctrine violation.
  conformError(await api({ method: 'POST', path: `${cardPath}/decision`, token, body: { type: 'approve' } }), 409, 'DECISION_NOT_VALID_FOR_CARD');
  conformError(await api({ method: 'POST', path: `${cardPath}/decision`, token, body: { type: 'answer', answer: { text: '' } } }), 400, 'ANSWER_EMPTY');
  conformError(await api({ method: 'POST', path: `${cardPath}/decision`, token, body: { type: 'answer', answer: { document_ids: [`${clientId}-nope`] } } }), 400, 'DOCUMENT_NOT_IN_ENTITY');

  // ── Answer ──────────────────────────────────────────────────────────────
  const askId = card.source.id;
  const answerText = 'Printer paper and toner for the studio — business use.';
  const decided = conform('/entities/{entityId}/queue/cards/{cardId}/decision', 'POST', await api({
    method: 'POST', path: `${cardPath}/decision`, token, body: { type: 'answer', answer: { text: answerText } }
  }));
  assert.equal(decided.applied, true);
  assert.notEqual(decided.card.state, 'open', JSON.stringify(decided));
  assert.equal(decided.card.ask.answered_text, answerText);
  // The consequence, as the portal's reply writer records it.
  const stored = (await appliance.query('select status, response_payload from client_evidence_requests where id = $1', [askId])).rows[0];
  assert.ok(['replied', 'resolved'].includes(stored.status), stored.status);
  assert.equal(stored.response_payload.reply, answerText);
  const audit = (await appliance.query(
    "select id::text id, actor_type, actor_id, action from audit_events where resource_id = $1 and action in ('evidence_request.reply', 'evidence_request.resolve') order by id",
    [askId])).rows;
  assert.equal(audit.length, 1, JSON.stringify(audit));
  assert.deepEqual([audit[0].actor_type, audit[0].actor_id], ['client', IDENTITIES.owner.email], 'attributed to the owner');
  assert.ok(decided.receipt.audit_event_ids.includes(audit[0].id), 'the receipt is the writer’s own audit row');
  assert.deepEqual(decided.receipt.actor, { type: 'owner', terminal: 'mobile' });
  assert.deepEqual(decided.receipt.changes, [{ target: card.id, applied: true, error: null }]);

  const after = conform('/entities/{entityId}/queue', 'GET', await api({ path: `/entities/${clientId}/queue`, token }));
  assert.equal(after.needs_you_count, queue.needs_you_count - 1);
  assert.ok(!after.cards.some((entry) => entry.id === card.id), 'the answered ask left the queue');
  // Replay is safe: applied=false with the card's current state.
  const replay = conform('/entities/{entityId}/queue/cards/{cardId}/decision', 'POST', await api({
    method: 'POST', path: `${cardPath}/decision`, token, body: { type: 'answer', answer: { text: answerText } }
  }));
  assert.equal(replay.applied, false);
  assert.equal(replay.already, decided.card.state);
  assert.equal((await appliance.query("select count(*)::int n from audit_events where resource_id = $1 and action in ('evidence_request.reply', 'evidence_request.resolve')", [askId])).rows[0].n, 1);

  // ── Approval and FYI through the outbound owner writers ─────────────────
  // One reminder held for the owner's say, one Donna sent under staged
  // authority (the receipt row is what makes it a sent-FYI).
  await appliance.query(
    `insert into client_parties (id, firm_id, client_id, display_name, normalized_name, is_customer)
     values ('party-mobile', $1, $2, 'Copperleaf Events Ltd', 'copperleaf events ltd', true)`, [firmId, clientId]);
  const insertAction = (id, status, gate) => appliance.query(
    `insert into outbound_actions (id, firm_id, client_id, action_type, target_party_id, anchor_type, anchor_id, pack_id,
       template, language, payload, amount, currency, confidence, gate_verdict, status, cadence_step, idempotency_key, created_by)
     values ($1, $2, $3, 'send_receivable_reminder', 'party-mobile', 'document', $4, 'gb', 'reminder_step_1', 'en',
       $5::jsonb, 480, 'GBP', 1, $6, $7, 1, $1, 'mobile_fixture')`,
    [id, firmId, clientId, `invoice-${id}`, JSON.stringify({ render_values: { invoice_number: `INV-${id}`, amount_due: '480.00' } }), gate, status]);
  await insertAction('action-held', 'hold_for_approval', 'hold_for_approval');
  await insertAction('action-sent', 'executed', 'auto_execute');
  await appliance.query(
    `insert into outbound_action_receipts (id, firm_id, client_id, action_id, action_type, channel, outcome, approved_by, authority, model, checks, attachment_manifest)
     values ('receipt-sent', $1, $2, 'action-sent', 'send_receivable_reminder', 'email', 'sent', 'system', 'stage:auto:OUTBOUND_DUNNING', 'none', '{}'::jsonb, '[]'::jsonb)`,
    [firmId, clientId]);
  const withOutbound = conform('/entities/{entityId}/queue', 'GET', await api({ path: `/entities/${clientId}/queue`, token }));
  const approvalCard = withOutbound.cards.find((entry) => entry.class === 'approval');
  const fyiCard = withOutbound.cards.find((entry) => entry.class === 'fyi');
  assert.equal(approvalCard?.id, 'outbound_action:action-held', JSON.stringify(withOutbound.cards.map((c) => c.id)));
  assert.equal(approvalCard.counterparty, 'Copperleaf Events Ltd');
  assert.equal(fyiCard?.id, 'outbound_action_sent:action-sent');
  assert.equal(withOutbound.needs_you_count, after.needs_you_count + 1, 'the held approval counts, the FYI never does');
  const approvalPath = `/entities/${clientId}/queue/cards/${encodeURIComponent(approvalCard.id)}`;
  const fyiPath = `/entities/${clientId}/queue/cards/${encodeURIComponent(fyiCard.id)}`;
  conformError(await api({ method: 'POST', path: `${fyiPath}/decision`, token, body: { type: 'approve' } }), 409, 'DECISION_NOT_VALID_FOR_CARD');
  conformError(await api({ method: 'POST', path: `${approvalPath}/decision`, token, body: { type: 'veto_flag' } }), 409, 'DECISION_NOT_VALID_FOR_CARD');

  const approved = conform('/entities/{entityId}/queue/cards/{cardId}/decision', 'POST',
    await api({ method: 'POST', path: `${approvalPath}/decision`, token, body: { type: 'approve' } }));
  assert.equal(approved.applied, true);
  assert.equal(approved.card.state, 'approved');
  const heldRow = (await appliance.query("select status, approved_by_actor_type, approved_by_actor_id from outbound_actions where id = 'action-held'")).rows[0];
  assert.deepEqual(heldRow, { status: 'approved', approved_by_actor_type: 'owner', approved_by_actor_id: IDENTITIES.owner.email });
  const approveAudit = (await appliance.query("select id::text id from audit_events where resource_id = 'action-held' order by id")).rows.map((row) => row.id);
  assert.ok(approved.receipt.audit_event_ids.length >= 1 && approved.receipt.audit_event_ids.every((id) => approveAudit.includes(id)),
    JSON.stringify({ receipt: approved.receipt, approveAudit }));
  const approvedAgain = conform('/entities/{entityId}/queue/cards/{cardId}/decision', 'POST',
    await api({ method: 'POST', path: `${approvalPath}/decision`, token, body: { type: 'reject' } }));
  assert.deepEqual([approvedAgain.applied, approvedAgain.already, approvedAgain.card.state], [false, 'approved', 'approved']);

  const flagged = conform('/entities/{entityId}/queue/cards/{cardId}/decision', 'POST',
    await api({ method: 'POST', path: `${fyiPath}/decision`, token, body: { type: 'veto_flag', note: 'Wrong customer.' } }));
  assert.equal(flagged.applied, true);
  assert.equal(flagged.card.state, 'flagged');
  assert.ok(flagged.card.fyi.marked_wrong_at);
  const sentRow = (await appliance.query("select status, payload->>'owner_marked_wrong_at' marked from outbound_actions where id = 'action-sent'")).rows[0];
  assert.equal(sentRow.status, 'executed', 'a flag changes no action state');
  assert.ok(sentRow.marked);
  const flaggedAgain = conform('/entities/{entityId}/queue/cards/{cardId}/decision', 'POST',
    await api({ method: 'POST', path: `${fyiPath}/decision`, token, body: { type: 'veto_flag' } }));
  assert.deepEqual([flaggedAgain.applied, flaggedAgain.already], [false, 'flagged']);
  const settled = conform('/entities/{entityId}/queue', 'GET', await api({ path: `/entities/${clientId}/queue`, token }));
  assert.equal(settled.needs_you_count, after.needs_you_count);

  // ── Status: persisted close verdicts ────────────────────────────────────
  const today = new Date();
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const monthEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  const unchecked = conform('/entities/{entityId}/status', 'GET', await api({ path: `/entities/${clientId}/status`, token }));
  assert.equal(unchecked.periods[0].period_start, monthStart);
  assert.equal(unchecked.periods[0].state, 'unchecked', 'no checks run yet → no verdict');
  assert.equal(unchecked.needs_you_count, after.needs_you_count, 'one badge');
  const run = await appliance.api.request({ method: 'POST', path: '/api/donna/firms/close/checks/run', auth: true,
    body: { firm_id: firmId, client_id: clientId, period_start: monthStart, period_end: monthEnd } });
  assert.equal(run.status, 200, run.text);
  const status = conform('/entities/{entityId}/status', 'GET', await api({ path: `/entities/${clientId}/status`, token, headers: { 'accept-language': 'fi-FI' } }));
  const persisted = (await appliance.query('select status, payload->>\'close_status\' verdict from close_periods where firm_id = $1 and client_id = $2 and period_start = $3', [firmId, clientId, monthStart])).rows[0];
  assert.equal(status.periods[0].state, persisted.verdict);
  assert.equal(status.periods[0].lifecycle, persisted.status);
  assert.match(status.periods[0].label, /\d{4}/);
  const openChecks = (await appliance.query("select check_type from close_checks c join close_periods p on p.id = c.close_period_id where p.client_id = $1 and p.period_start = $2 and c.status in ('open','blocked','warning') order by check_type", [clientId, monthStart])).rows;
  assert.deepEqual(status.periods[0].blockers.map((blocker) => blocker.code), openChecks.map((row) => row.check_type));

  // ── Sign out; kill switch ───────────────────────────────────────────────
  const ownerWeb = idp.openElsewhere('owner');
  const out = await api({ method: 'DELETE', path: '/auth/sessions/current', token });
  assert.equal(out.status, 204);
  assert.ok(idp.revoked.includes(token));
  assert.ok(idp.revokedScopes.every((scope) => scope === 'local'), 'every revoke names the local scope');
  assert.ok(idp.isLive(ownerWeb), 'signing out on the phone leaves the owner signed in on the web');
  conformError(await api({ path: '/me', token }), 401, 'AUTH_REQUIRED');
  process.env.DONNA_MOBILE_API = 'off';
  try {
    conformError(await signIn('owner'), 503, 'MOBILE_API_DISABLED');
    conformError(await api({ path: '/me', token: refreshed.access_token }), 503, 'MOBILE_API_DISABLED');
  } finally {
    delete process.env.DONNA_MOBILE_API;
  }
});
