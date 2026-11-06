import test from 'node:test';
import assert from 'node:assert/strict';

import {
  __getActiveWhatsAppBindingForClientWithClient,
  __getActiveWhatsAppBindingsByPhoneHashWithClient,
  __mintWhatsAppBindTokenWithClient,
  __recordMessageDeliveryLedgerWithClient,
  __redeemWhatsAppBindTokenWithClient,
  __revokeWhatsAppBindingWithClient,
  deliverWhatsAppEvidenceAsksAfterSend,
  deliverSmsEvidenceAsksAfterSend,
  preferredOwnerTemplateLanguage,
  OWNER_TEMPLATE_FALLBACK_LANGUAGE
} from './firmDb.js';
import { hashPhoneE164 } from './channels/whatsappWebhookCore.js';

const makeFakeClient = ({ tokens = [], bindings = [], asks = [], profile = null, configStages = [] } = {}) => {
  const state = { tokens: [...tokens], bindings: [...bindings], ledger: new Map(), asks: [...asks], profile, configStages: [...configStages] };
  const calls = [];
  const auditRows = [];
  const client = {
    calls,
    state,
    auditRows,
    query: async (sql, params = []) => {
      const text = String(sql).toLowerCase();
      calls.push({ sql: String(sql), params });
      if (['begin', 'commit', 'rollback'].includes(text.trim())) return { rows: [] };
      if (text.includes('insert into client_whatsapp_bind_tokens')) {
        const row = { token_hash: params[0], firm_id: params[1], client_id: params[2], collaborator_id: params[3], created_by: params[4], expires_at: params[5], redeemed_at: null, revoked_at: null };
        state.tokens.push(row);
        return { rows: [row] };
      }
      if (text.includes('from client_whatsapp_bind_tokens')) return { rows: state.tokens.filter((row) => row.token_hash === params[0]) };
      if (text.includes('insert into client_whatsapp_bindings')) {
        const row = { id: params[0], firm_id: params[1], client_id: params[2], collaborator_id: params[3], phone_e164: params[4], phone_hash: params[5], verified_set_by: params[6], opted_in_set_by: params[6], channel: params[7] || 'whatsapp', revoked_at: null };
        const index = state.bindings.findIndex((existing) => existing.firm_id === row.firm_id && existing.client_id === row.client_id && existing.collaborator_id === row.collaborator_id && existing.phone_hash === row.phone_hash);
        if (index >= 0) state.bindings[index] = { ...state.bindings[index], ...row, revoked_at: null };
        else state.bindings.push(row);
        return { rows: [row] };
      }
      if (text.includes('update client_whatsapp_bind_tokens')) {
        const token = state.tokens.find((row) => row.token_hash === params[0]);
        if (token) { token.redeemed_at = new Date().toISOString(); token.redeemed_phone_e164 = params[1]; }
        return { rows: token ? [token] : [] };
      }
      if (text.includes('update client_whatsapp_bindings')) {
        const row = state.bindings.find((binding) => binding.firm_id === params[0] && binding.client_id === params[1] && binding.id === params[2] && !binding.revoked_at);
        if (row) { row.revoked_at = new Date().toISOString(); row.revoked_by = params[3]; }
        return { rows: row ? [row] : [] };
      }
      if (text.includes('from client_whatsapp_bindings') && text.includes('client_id = $2')) {
        const wantsSms = text.includes("'sms'");
        const wantsWhatsapp = text.includes("'whatsapp'") && !wantsSms;
        return { rows: state.bindings.filter((row) => row.firm_id === params[0] && row.client_id === params[1] && !row.revoked_at && (!wantsSms || row.channel === 'sms') && (!wantsWhatsapp || (row.channel || 'whatsapp') === 'whatsapp')).slice(0, 1) };
      }
      if (text.includes('from client_whatsapp_bindings') && text.includes('phone_hash = $1')) {
        const wantsSms = text.includes("'sms'");
        const wantsWhatsapp = text.includes("'whatsapp'") && !wantsSms;
        return { rows: state.bindings.filter((row) => row.phone_hash === params[0] && !row.revoked_at && (!wantsSms || row.channel === 'sms') && (!wantsWhatsapp || (row.channel || 'whatsapp') === 'whatsapp')) };
      }
      if (text.includes('select profile from clients')) {
        return { rows: [{ profile: state.profile }] };
      }
      // Config control plane (migration 042/043) — the sensitive-ask portal
      // notice reads OWNER_PORTAL_LINK through readClientConfigSnapshot.
      if (text.includes('from client_capability_config')) return { rows: state.configStages };
      if (text.includes('from cohort_capability_config')) return { rows: [] };
      if (text.includes('from client_evidence_requests')) {
        return { rows: state.asks.filter((row) => row.firm_id === params[0] && row.client_id === params[1] && row.id === params[2]).slice(0, 1) };
      }
      if (text.includes('insert into message_delivery_ledger')) {
        const row = {
          id: params[0], message_id: params[1], channel: params[2], provider: params[3], ask_id: params[4], client_id: params[5], recipient_phone_hash: params[6], template_name: params[7], sent_at: params[8], delivered_at: params[9], read_at: params[10], failed_at: params[11], failure_reason: params[12], fallback_triggered_at: params[13], inbound_reply_id: params[14], resolved_request_id: params[15], provider_payload: JSON.parse(params[16] || '{}')
        };
        const key = `${row.provider}:${row.message_id}`;
        const existing = state.ledger.get(key);
        const merged = existing ? {
          ...existing,
          delivered_at: existing.delivered_at || row.delivered_at,
          read_at: existing.read_at || row.read_at,
          failed_at: existing.failed_at || row.failed_at,
          failure_reason: row.failure_reason || existing.failure_reason,
          fallback_triggered_at: existing.fallback_triggered_at || row.fallback_triggered_at,
          provider_payload: { ...(existing.provider_payload || {}), ...(row.provider_payload || {}) }
        } : row;
        state.ledger.set(key, merged);
        return { rows: [merged] };
      }
      if (text.includes('insert into audit_events')) {
        const action = String(text.match(/'(?:whatsapp|owner_portal_link)\.[^']+'/)?.[0] || '').replaceAll("'", '');
        const row = { params, action, actor_id: params[2] };
        auditRows.push(row);
        return { rows: [row] };
      }
      return { rows: [] };
    }
  };
  return client;
};

test('mint then redeem binds phone to client and audits with real actor', async () => {
  const client = makeFakeClient();
  await __mintWhatsAppBindTokenWithClient({ client, firmId: 'firm', clientId: 'client', collaboratorId: 'collab', actorId: 'owner-1', tokenHash: 'tok', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const binding = await __redeemWhatsAppBindTokenWithClient({ client, tokenHash: 'tok', phoneE164: '+44 (7700) 900-123', actorId: 'whatsapp:webhook' });
  assert.equal(binding.client_id, 'client');
  assert.equal(binding.phone_e164, '+447700900123');
  assert.equal(binding.phone_hash, hashPhoneE164('+447700900123'));
  const verifiedAudit = client.auditRows.find((row) => row.action === 'whatsapp.binding.verified');
  assert.ok(verifiedAudit);
  assert.equal(verifiedAudit.actor_id, 'whatsapp:webhook');
  assert.notEqual(verifiedAudit.actor_id, 'system');
});

test('redeem is single-use and expired tokens reject 409', async () => {
  const client = makeFakeClient({ tokens: [{ token_hash: 'used', firm_id: 'firm', client_id: 'client', collaborator_id: 'collab', created_by: 'owner-1', expires_at: new Date(Date.now() + 60_000).toISOString(), redeemed_at: new Date().toISOString(), revoked_at: null }] });
  await assert.rejects(() => __redeemWhatsAppBindTokenWithClient({ client, tokenHash: 'used', phoneE164: '+447700900123' }), (error) => error.statusCode === 409 && error.code === 'WHATSAPP_BIND_TOKEN_INVALID');

  const expired = makeFakeClient({ tokens: [{ token_hash: 'expired', firm_id: 'firm', client_id: 'client', collaborator_id: 'collab', created_by: 'owner-1', expires_at: new Date(Date.now() - 60_000).toISOString(), redeemed_at: null, revoked_at: null }] });
  await assert.rejects(() => __redeemWhatsAppBindTokenWithClient({ client: expired, tokenHash: 'expired', phoneE164: '+447700900123' }), (error) => error.statusCode === 409 && error.code === 'WHATSAPP_BIND_TOKEN_INVALID');
});

test('revoked binding is excluded from active lookup helpers and audited', async () => {
  const phoneHash = hashPhoneE164('+447700900123');
  const client = makeFakeClient({ bindings: [{ id: 'binding', firm_id: 'firm', client_id: 'client', collaborator_id: 'collab', phone_e164: '+447700900123', phone_hash: phoneHash, revoked_at: null }] });
  await __revokeWhatsAppBindingWithClient({ client, firmId: 'firm', clientId: 'client', bindingId: 'binding', actorId: 'owner-1' });
  assert.equal(await __getActiveWhatsAppBindingForClientWithClient({ client, firmId: 'firm', clientId: 'client' }), null);
  assert.deepEqual(await __getActiveWhatsAppBindingsByPhoneHashWithClient({ client, phoneHash }), []);
  assert.ok(client.auditRows.find((row) => row.action === 'whatsapp.binding.revoked'));
});

test('recordMessageDeliveryLedgerInDb merges status events without clobbering timestamps', async () => {
  const client = makeFakeClient();
  await __recordMessageDeliveryLedgerWithClient({ client, entry: { message_id: 'wamid.1', provider: 'meta', channel: 'whatsapp', ask_id: 'ask_1', client_id: 'client', sent_at: '2026-07-07T00:00:00.000Z', template_name: 'donna_evidence_ask_v1' } });
  await __recordMessageDeliveryLedgerWithClient({ client, entry: { message_id: 'wamid.1', provider: 'meta', delivered_at: '2026-07-07T00:01:00.000Z' } });
  const row = await __recordMessageDeliveryLedgerWithClient({ client, entry: { message_id: 'wamid.1', provider: 'meta', delivered_at: null, read_at: '2026-07-07T00:02:00.000Z' } });
  assert.equal(client.state.ledger.size, 1);
  assert.equal(row.sent_at, '2026-07-07T00:00:00.000Z');
  assert.equal(row.delivered_at, '2026-07-07T00:01:00.000Z');
  assert.equal(row.read_at, '2026-07-07T00:02:00.000Z');
});

test('deliverWhatsAppEvidenceAsksAfterSend skips safely, records sent ledgers and visible failures', async () => {
  const flagOff = makeFakeClient();
  assert.deepEqual(await deliverWhatsAppEvidenceAsksAfterSend({ client: flagOff, firmId: 'firm', clientId: 'client', evidenceRequestIds: ['ask_1'], env: { WHATSAPP_ENABLED: 'false', WHATSAPP_CLIENTS: 'client' } }), { skipped: true, reason: 'flag_off' });

  const unbound = makeFakeClient();
  assert.deepEqual(await deliverWhatsAppEvidenceAsksAfterSend({ client: unbound, firmId: 'firm', clientId: 'client', evidenceRequestIds: ['ask_1'], env: { WHATSAPP_ENABLED: 'true', WHATSAPP_CLIENTS: 'client' } }), { skipped: true, reason: 'unbound' });

  const phoneHash = hashPhoneE164('+447700900123');
  const success = makeFakeClient({ bindings: [{ id: 'binding', firm_id: 'firm', client_id: 'client', phone_e164: '+447700900123', phone_hash: phoneHash, revoked_at: null }], asks: [{ id: 'ask_1', firm_id: 'firm', client_id: 'client', question: 'receipt?', request_payload: { period: 'June' } }] });
  await deliverWhatsAppEvidenceAsksAfterSend({ client: success, firmId: 'firm', clientId: 'client', evidenceRequestIds: ['ask_1'], env: { WHATSAPP_ENABLED: 'true', WHATSAPP_CLIENTS: 'client' }, deps: { deliverOwnerMessage: async () => ({ ok: true, id: 'wamid.ok', body: { sent: true } }), OWNER_CHANNELS: { WHATSAPP: 'whatsapp' } } });
  const sent = success.state.ledger.get('meta:wamid.ok');
  assert.equal(sent.ask_id, 'ask_1');
  assert.equal(sent.template_name, 'donna_evidence_ask_v1');
  assert.ok(sent.sent_at);

  const failure = makeFakeClient({ bindings: [{ id: 'binding', firm_id: 'firm', client_id: 'client', phone_e164: '+447700900123', phone_hash: phoneHash, revoked_at: null }], asks: [{ id: 'ask_2', firm_id: 'firm', client_id: 'client', question: 'receipt?', request_payload: {} }] });
  await deliverWhatsAppEvidenceAsksAfterSend({ client: failure, firmId: 'firm', clientId: 'client', evidenceRequestIds: ['ask_2'], env: { WHATSAPP_ENABLED: 'true', WHATSAPP_CLIENTS: 'client' }, deps: { deliverOwnerMessage: async () => ({ ok: false, error: 'blocked' }), OWNER_CHANNELS: { WHATSAPP: 'whatsapp' } } });
  const failed = failure.state.ledger.get('meta:fallback_ask_2');
  assert.ok(failed.failed_at);
  assert.ok(failed.fallback_triggered_at);
  assert.equal(failed.failure_reason, 'blocked');
});


test('deliverSmsEvidenceAsksAfterSend sends SMS asks and records visible failures', async () => {
  const flagOff = makeFakeClient();
  assert.deepEqual(await deliverSmsEvidenceAsksAfterSend({ client: flagOff, firmId: 'firm', clientId: 'client', evidenceRequestIds: ['ask_1'], env: { SMS_ENABLED: 'false', SMS_CLIENTS: 'client' } }), { skipped: true, reason: 'flag_off' });

  const phoneHash = hashPhoneE164('+15551234567');
  const success = makeFakeClient({ bindings: [{ id: 'sms-binding', firm_id: 'firm', client_id: 'client', phone_e164: '+15551234567', phone_hash: phoneHash, channel: 'sms', revoked_at: null }], asks: [{ id: 'ask_1', firm_id: 'firm', client_id: 'client', question: 'receipt?', request_payload: { period: 'June' } }] });
  await deliverSmsEvidenceAsksAfterSend({ client: success, firmId: 'firm', clientId: 'client', evidenceRequestIds: ['ask_1'], env: { SMS_ENABLED: 'true', SMS_CLIENTS: 'client' }, deps: { deliverOwnerMessage: async () => ({ ok: true, id: 'SM.ok', body: { sid: 'SM.ok' } }), OWNER_CHANNELS: { SMS: 'sms' } } });
  const sent = success.state.ledger.get('twilio:SM.ok');
  assert.equal(sent.channel, 'sms');
  assert.equal(sent.provider, 'twilio');
  assert.equal(sent.ask_id, 'ask_1');
  assert.ok(sent.sent_at);

  const failure = makeFakeClient({ bindings: [{ id: 'sms-binding', firm_id: 'firm', client_id: 'client', phone_e164: '+15551234567', phone_hash: phoneHash, channel: 'sms', revoked_at: null }], asks: [{ id: 'ask_2', firm_id: 'firm', client_id: 'client', question: 'receipt?', request_payload: {} }] });
  await deliverSmsEvidenceAsksAfterSend({ client: failure, firmId: 'firm', clientId: 'client', evidenceRequestIds: ['ask_2'], env: { SMS_ENABLED: 'true', SMS_CLIENTS: 'client' }, deps: { deliverOwnerMessage: async () => ({ ok: false, error: 'carrier blocked' }), OWNER_CHANNELS: { SMS: 'sms' } } });
  const failed = failure.state.ledger.get('twilio:sms_fallback_ask_2');
  assert.ok(failed.failed_at);
  assert.ok(failed.fallback_triggered_at);
  assert.equal(failed.failure_reason, 'carrier blocked');
});

test('deliverWhatsAppEvidenceAsksAfterSend sanitizes the question param and refuses sensitive asks', async () => {
  const phoneHash = hashPhoneE164('+447700900123');
  const binding = { id: 'binding', firm_id: 'firm', client_id: 'client', phone_e164: '+447700900123', phone_hash: phoneHash, revoked_at: null };

  // Sanitized: newlines collapsed, length-capped before it reaches the template.
  const longQuestion = `receipt\nfor ${'x'.repeat(200)}`;
  const sanitized = makeFakeClient({ bindings: [binding], asks: [{ id: 'ask_s', firm_id: 'firm', client_id: 'client', question: longQuestion, request_payload: { period: 'June' } }] });
  let captured = null;
  await deliverWhatsAppEvidenceAsksAfterSend({ client: sanitized, firmId: 'firm', clientId: 'client', evidenceRequestIds: ['ask_s'], env: { WHATSAPP_ENABLED: 'true', WHATSAPP_CLIENTS: 'client' }, deps: { deliverOwnerMessage: async (msg) => { captured = msg; return { ok: true, id: 'wamid.s', body: {} }; }, OWNER_CHANNELS: { WHATSAPP: 'whatsapp' } } });
  const questionParam = captured.template.bodyParameters[1];
  assert.ok(!questionParam.includes('\n'), 'no newline in sent question');
  assert.ok(questionParam.length <= 120, 'question is length-capped');
  assert.ok(questionParam.endsWith('…'), 'over-long question is ellipsized');

  // Sensitive ask: never sent — recorded as a visible portal/email fallback.
  const sensitive = makeFakeClient({ bindings: [binding], asks: [{ id: 'ask_x', firm_id: 'firm', client_id: 'client', question: 'reply with your full card number', request_payload: { period: 'June' } }] });
  let called = false;
  await deliverWhatsAppEvidenceAsksAfterSend({ client: sensitive, firmId: 'firm', clientId: 'client', evidenceRequestIds: ['ask_x'], env: { WHATSAPP_ENABLED: 'true', WHATSAPP_CLIENTS: 'client' }, deps: { deliverOwnerMessage: async () => { called = true; return { ok: true, id: 'wamid.x', body: {} }; }, OWNER_CHANNELS: { WHATSAPP: 'whatsapp' } } });
  assert.equal(called, false, 'sensitive ask is not sent over WhatsApp');
  const fallback = sensitive.state.ledger.get('meta:fallback_ask_x');
  assert.ok(fallback, 'a fallback ledger row is recorded');
  assert.equal(fallback.failure_reason, 'sensitive_ask_portal_only');
  assert.ok(fallback.fallback_triggered_at);
  // OWNER_PORTAL_LINK dark (no config row) ⇒ no notice send either — the
  // pre-slice-3 behaviour is byte-identical until the flag is staged.
  assert.equal(sensitive.state.ledger.size, 1, 'no notice ledger row while the flag is dark');
});

test('blocked sensitive ask sends the SAFE WhatsApp portal-redirect notice when OWNER_PORTAL_LINK acts', async () => {
  const phoneHash = hashPhoneE164('+447700900123');
  const binding = { id: 'binding', firm_id: 'firm', client_id: 'client', phone_e164: '+447700900123', phone_hash: phoneHash, revoked_at: null };
  const db = makeFakeClient({
    bindings: [binding],
    asks: [{ id: 'ask_x', firm_id: 'firm', client_id: 'client', question: 'reply with your full card number', request_payload: { period: 'June' } }],
    configStages: [{ flag_key: 'OWNER_PORTAL_LINK', stage: 'canary', source: 'test', client_id: 'client' }]
  });
  const sends = [];
  await deliverWhatsAppEvidenceAsksAfterSend({
    client: db, firmId: 'firm', clientId: 'client', evidenceRequestIds: ['ask_x'],
    env: { WHATSAPP_ENABLED: 'true', WHATSAPP_CLIENTS: 'client', PUBLIC_APP_URL: 'https://app.books.example' },
    deps: { deliverOwnerMessage: async (msg) => { sends.push(msg); return { ok: true, id: 'wamid.notice', body: {} }; }, OWNER_CHANNELS: { WHATSAPP: 'whatsapp' } }
  });
  // Exactly ONE send reaches the channel: the notice — never the ask itself.
  assert.equal(sends.length, 1);
  assert.equal(sends[0].template.name, 'donna_secure_upload_v1');
  const paramsJoined = JSON.stringify(sends[0].template.bodyParameters);
  assert.ok(!paramsJoined.toLowerCase().includes('card number'), 'question content never rides the channel');
  assert.ok(!paramsJoined.includes('http'), 'a URL never rides a Meta template parameter');
  assert.equal(sends[0].template.bodyParameters[1], 'ASKX', 'the ask ref rides the redirect template');
  // Ledger: the visible block row stays AND the notice send is receipted.
  assert.equal(db.state.ledger.get('meta:fallback_ask_x').failure_reason, 'sensitive_ask_portal_only');
  const notice = db.state.ledger.get('meta:wamid.notice');
  assert.ok(notice.sent_at, 'the notice send is receipted');
  assert.equal(notice.ask_id, 'ask_x');
  assert.equal(notice.template_name, 'donna_secure_upload_v1');
  assert.equal(notice.provider_payload.notice, 'sensitive-ask-notice.v1');
  assert.equal(notice.provider_payload.trigger, 'sensitive_ask_blocked');
  assert.equal(notice.provider_payload.link_status, 'sent');
  assert.equal(notice.provider_payload.link_path, '/client/client#list');
  assert.match(notice.provider_payload.config_snapshot_id, /^cfg-/);
  // Audit: owner_portal_link.shared, actor_type system (refuse-layer trigger).
  const audit = db.auditRows.find((row) => row.action === 'owner_portal_link.shared');
  assert.ok(audit, 'the notice send is audited');
  assert.equal(audit.params[2], 'system');
  const metadata = JSON.parse(audit.params[4]);
  assert.equal(metadata.trigger, 'sensitive_ask_blocked');
  assert.equal(metadata.ask_id, 'ask_x');
  assert.equal(metadata.status, 'sent');
});

test('sensitive-ask notice send failure is a NAMED ledger row, never a throw into the ask batch', async () => {
  const phoneHash = hashPhoneE164('+447700900123');
  const binding = { id: 'binding', firm_id: 'firm', client_id: 'client', phone_e164: '+447700900123', phone_hash: phoneHash, revoked_at: null };
  const db = makeFakeClient({
    bindings: [binding],
    asks: [{ id: 'ask_x', firm_id: 'firm', client_id: 'client', question: 'send your bank login', request_payload: {} }],
    configStages: [{ flag_key: 'OWNER_PORTAL_LINK', stage: 'canary', source: 'test', client_id: 'client' }]
  });
  const result = await deliverWhatsAppEvidenceAsksAfterSend({
    client: db, firmId: 'firm', clientId: 'client', evidenceRequestIds: ['ask_x'],
    env: { WHATSAPP_ENABLED: 'true', WHATSAPP_CLIENTS: 'client' },
    deps: { deliverOwnerMessage: async () => ({ ok: false, status: 400, error: 'template does not exist', body: { error: { code: 132002 } } }), OWNER_CHANNELS: { WHATSAPP: 'whatsapp' } }
  });
  assert.deepEqual(result, { sent: 1 }, 'the batch completes');
  const failed = db.state.ledger.get('meta:whatsapp_sensitive_notice_ask_x');
  assert.ok(failed.failed_at, 'the failed notice is visible in the ledger');
  assert.equal(failed.failure_reason, 'template does not exist');
  assert.equal(failed.template_name, 'donna_secure_upload_v1');
  const audit = db.auditRows.find((row) => row.action === 'owner_portal_link.shared');
  assert.equal(JSON.parse(audit.params[4]).status, 'send_failed');
});

test('blocked sensitive ask over SMS sends the notice text with the REAL deep link and no question content', async () => {
  const phoneHash = hashPhoneE164('+15551234567');
  const db = makeFakeClient({
    bindings: [{ id: 'sms-binding', firm_id: 'firm', client_id: 'client', phone_e164: '+15551234567', phone_hash: phoneHash, channel: 'sms', revoked_at: null }],
    asks: [{ id: 'ask_x', firm_id: 'firm', client_id: 'client', question: 'reply with your routing number', request_payload: {} }],
    configStages: [{ flag_key: 'OWNER_PORTAL_LINK', stage: 'canary', source: 'test', client_id: 'client' }]
  });
  const sends = [];
  await deliverSmsEvidenceAsksAfterSend({
    client: db, firmId: 'firm', clientId: 'client', evidenceRequestIds: ['ask_x'],
    env: { SMS_ENABLED: 'true', SMS_CLIENTS: 'client', PUBLIC_APP_URL: 'https://app.books.example' },
    deps: { deliverOwnerMessage: async (msg) => { sends.push(msg); return { ok: true, id: 'SM.notice', body: {} }; }, OWNER_CHANNELS: { SMS: 'sms' } }
  });
  assert.equal(sends.length, 1, 'only the notice rides the channel');
  assert.equal(sends[0].template.name, 'donna_sensitive_ask_notice_v1');
  const text = sends[0].template.bodyParameters[0];
  assert.ok(text.includes('https://app.books.example/client/client#list'), 'the deterministic deep link is delivered');
  assert.ok(!text.toLowerCase().includes('routing number'), 'question content never rides the channel');
  assert.match(text, /What I still need from you/);
  const notice = db.state.ledger.get('twilio:SM.notice');
  assert.ok(notice.sent_at);
  assert.equal(notice.provider_payload.notice, 'sensitive-ask-notice.v1');
});

test('preferredOwnerTemplateLanguage picks fi for Finnish clients, en otherwise', () => {
  assert.equal(preferredOwnerTemplateLanguage({ jurisdiction: 'FI' }), 'fi');
  assert.equal(preferredOwnerTemplateLanguage({ jurisdiction: 'fi' }), 'fi');
  assert.equal(preferredOwnerTemplateLanguage({ locale: 'fi-FI' }), 'fi');
  assert.equal(preferredOwnerTemplateLanguage({ language: 'fi' }), 'fi');
  assert.equal(preferredOwnerTemplateLanguage({ jurisdiction: 'US' }), 'en');
  assert.equal(preferredOwnerTemplateLanguage({ jurisdiction: 'SG' }), 'en');
  assert.equal(preferredOwnerTemplateLanguage(null), 'en');
  assert.equal(preferredOwnerTemplateLanguage(undefined), OWNER_TEMPLATE_FALLBACK_LANGUAGE);
});

test('deliverWhatsAppEvidenceAsksAfterSend sends the FI template and records the language', async () => {
  const phoneHash = hashPhoneE164('+358401234567');
  const binding = { id: 'binding', firm_id: 'firm', client_id: 'client', phone_e164: '+358401234567', phone_hash: phoneHash, revoked_at: null };
  const fi = makeFakeClient({
    profile: { jurisdiction: 'FI' },
    bindings: [binding],
    asks: [{ id: 'ask_fi', firm_id: 'firm', client_id: 'client', question: 'kuitti?', request_payload: { period: 'kesäkuu 2026' } }]
  });
  const languages = [];
  await deliverWhatsAppEvidenceAsksAfterSend({
    client: fi, firmId: 'firm', clientId: 'client', evidenceRequestIds: ['ask_fi'],
    env: { WHATSAPP_ENABLED: 'true', WHATSAPP_CLIENTS: 'client' },
    deps: { deliverOwnerMessage: async (msg) => { languages.push(msg.template.languageCode); return { ok: true, id: 'wamid.fi', body: {} }; }, OWNER_CHANNELS: { WHATSAPP: 'whatsapp' } }
  });
  assert.deepEqual(languages, ['fi'], 'the Finnish template is attempted');
  assert.equal(fi.state.ledger.get('meta:wamid.fi').provider_payload.language, 'fi');
});

test('deliverWhatsAppEvidenceAsksAfterSend falls back to en when the fi template is not approved (132001)', async () => {
  const phoneHash = hashPhoneE164('+358401234567');
  const binding = { id: 'binding', firm_id: 'firm', client_id: 'client', phone_e164: '+358401234567', phone_hash: phoneHash, revoked_at: null };
  const fi = makeFakeClient({
    profile: { jurisdiction: 'FI' },
    bindings: [binding],
    asks: [{ id: 'ask_fb', firm_id: 'firm', client_id: 'client', question: 'kuitti?', request_payload: { period: 'kesäkuu 2026' } }]
  });
  const languages = [];
  await deliverWhatsAppEvidenceAsksAfterSend({
    client: fi, firmId: 'firm', clientId: 'client', evidenceRequestIds: ['ask_fb'],
    env: { WHATSAPP_ENABLED: 'true', WHATSAPP_CLIENTS: 'client' },
    deps: {
      deliverOwnerMessage: async (msg) => {
        languages.push(msg.template.languageCode);
        if (msg.template.languageCode === 'fi') return { ok: false, status: 400, body: { error: { code: 132001, message: 'Template name does not exist in the translation' } } };
        return { ok: true, id: 'wamid.en', body: {} };
      },
      OWNER_CHANNELS: { WHATSAPP: 'whatsapp' }
    }
  });
  assert.deepEqual(languages, ['fi', 'en'], 'fi is attempted first, then en');
  const sent = fi.state.ledger.get('meta:wamid.en');
  assert.ok(sent.sent_at, 'the en retry is recorded as sent');
  assert.equal(sent.provider_payload.language, 'en');
});

test('deliverWhatsAppEvidenceAsksAfterSend does NOT retry on a non-language failure', async () => {
  const phoneHash = hashPhoneE164('+358401234567');
  const binding = { id: 'binding', firm_id: 'firm', client_id: 'client', phone_e164: '+358401234567', phone_hash: phoneHash, revoked_at: null };
  const fi = makeFakeClient({
    profile: { jurisdiction: 'FI' },
    bindings: [binding],
    asks: [{ id: 'ask_err', firm_id: 'firm', client_id: 'client', question: 'kuitti?', request_payload: { period: 'kesäkuu 2026' } }]
  });
  let attempts = 0;
  await deliverWhatsAppEvidenceAsksAfterSend({
    client: fi, firmId: 'firm', clientId: 'client', evidenceRequestIds: ['ask_err'],
    env: { WHATSAPP_ENABLED: 'true', WHATSAPP_CLIENTS: 'client' },
    deps: { deliverOwnerMessage: async () => { attempts += 1; return { ok: false, status: 429, error: 'rate limited', body: { error: { code: 131056, message: 'rate limit hit' } } }; }, OWNER_CHANNELS: { WHATSAPP: 'whatsapp' } }
  });
  assert.equal(attempts, 1, 'a non-language failure is not retried in english');
  const failed = fi.state.ledger.get('meta:fallback_ask_err');
  assert.ok(failed.failed_at, 'the failure is recorded');
});
