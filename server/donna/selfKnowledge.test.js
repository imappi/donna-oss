// Operational self-knowledge context pack — the pin-by-test cases the lineage
// brief names: the acceptance exchange's self-description, the
// "not enabled for you" case, and the never-fabricate case — plus the
// registry-groundedness contract (capability knowledge comes from the REGISTRY,
// docs/donna-self-awareness-plan.md §0/§6) and the slice-2 deep-link + honest
// degrade behaviour.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SELF_KNOWLEDGE_FLAG_KEY,
  OWNER_PORTAL_LINK_FLAG_KEY,
  SELF_KNOWLEDGE_PACK_VERSION,
  OWNER_CAPABILITY_MANIFEST,
  resolveOwnerCapabilityStates,
  selfKnowledgeFingerprint,
  ownerPortalBaseUrl,
  OWNER_PORTAL_OPEN_ASKS_PATH,
  buildOwnerPortalDeepLink,
  resolveOwnerPortalLink,
  portalLinkUnavailableText,
  portalLinkDefaultText,
  composePortalLinkReply,
  sensitiveAskPortalNoticeText,
  SENSITIVE_ASK_NOTICE_VERSION,
  SENSITIVE_ASK_NOTICE_TEMPLATE,
  SENSITIVE_ASK_WA_TEMPLATE,
  SENSITIVE_ASK_WA_ITEM_PARAM,
  recordOwnerPortalLinkShare,
  renderSelfKnowledgeBlock,
  buildSelfKnowledgeContext,
  manifestRegistryViolations
} from './selfKnowledge.js';

const EMPTY_ENV = {};

// A fake pg client whose config read returns the given active rows.
const fakeClient = (rows = []) => ({
  query: async (sql) => {
    if (/from client_capability_config/.test(sql)) return { rows };
    if (/from cohort_capability_config/.test(sql)) return { rows: [] };
    return { rows: [] };
  }
});

const configRow = (flagKey, stage) => ({ flag_key: flagKey, stage, source: 'manual', client_id: 'client-1' });

// ─── Manifest contract ──────────────────────────────────────────────────────

test('manifest is versioned data with provenance and an as-of date, never runtime introspection', () => {
  assert.equal(OWNER_CAPABILITY_MANIFEST.version, SELF_KNOWLEDGE_PACK_VERSION);
  assert.match(OWNER_CAPABILITY_MANIFEST.as_of, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(OWNER_CAPABILITY_MANIFEST.provenance.length > 40, 'provenance names its sources');
  assert.ok(Object.isFrozen(OWNER_CAPABILITY_MANIFEST));
  assert.ok(OWNER_CAPABILITY_MANIFEST.capabilities.length >= 6);
  assert.ok(OWNER_CAPABILITY_MANIFEST.cannot_yet.length >= 3);
  for (const entry of OWNER_CAPABILITY_MANIFEST.capabilities) {
    assert.ok(entry.key && entry.label, `entry ${entry.key} has key + label`);
    assert.ok(['always', 'flag'].includes(entry.availability));
    if (entry.availability === 'flag') assert.ok(entry.flag, `${entry.key} names its flag`);
    assert.ok(Array.isArray(entry.registry_capabilities));
  }
});

test('registry-groundedness: every referenced capability id is actually registered (READ-ONLY first consumer)', () => {
  assert.deepEqual(manifestRegistryViolations(), []);
});

// ─── State resolution (the runtime predicate, not a second opinion) ─────────

test('flag-gated entries resolve exactly like the runtime: canary/auto act, everything else (incl. missing row) is not_enabled', () => {
  const snapshot = {
    FINLAND_INVOICING: { stage: 'canary', source: 'manual' },
    FINLAND_QUOTES: { stage: 'shadow', source: 'manual' }
  };
  const states = Object.fromEntries(
    resolveOwnerCapabilityStates({ snapshot, env: EMPTY_ENV }).map((s) => [s.key, s.state])
  );
  assert.equal(states.issue_invoices, 'available');
  assert.equal(states.issue_quotes, 'not_enabled', 'shadow does not act');
  assert.equal(states.file_alv_returns, 'not_enabled', 'missing row = ∅ = not enabled');
  assert.equal(states.answer_books_questions, 'available', 'always entries are always available');
});

test('fingerprint is deterministic and changes when a state changes', () => {
  const a = selfKnowledgeFingerprint({ v: 1, states: [{ key: 'x', state: 'available' }] });
  const b = selfKnowledgeFingerprint({ states: [{ state: 'available', key: 'x' }], v: 1 });
  const c = selfKnowledgeFingerprint({ v: 1, states: [{ key: 'x', state: 'not_enabled' }] });
  assert.equal(a, b, 'key order never perturbs the hash');
  assert.notEqual(a, c);
  assert.match(a, /^selfknow-[0-9a-f]{64}$/);
});

// ─── The assembler ──────────────────────────────────────────────────────────

test('flag off (no row) → null: the prompt stays byte-identical for every un-staged client', async () => {
  const pack = await buildSelfKnowledgeContext({
    client: fakeClient([]),
    firmId: 'firm-1',
    clientId: 'client-1',
    env: EMPTY_ENV
  });
  assert.equal(pack, null);
});

test('the acceptance self-description: a canaried owner-channel turn gets identity, surfaces, and the receipt', async () => {
  const pack = await buildSelfKnowledgeContext({
    client: fakeClient([configRow(SELF_KNOWLEDGE_FLAG_KEY, 'canary')]),
    firmId: 'firm-1',
    clientId: 'client-1',
    clientProfile: { name: 'Honeybee Hills Apiary LLC', assistant_name: null },
    surface: 'owner_channel',
    channel: 'telegram',
    env: EMPTY_ENV
  });
  assert.ok(pack, 'pack assembles at canary');
  const block = pack.systemPromptExtra;
  // Identity: who she is, who she is NOT (the exact 2026-07-24 failure).
  assert.match(block, /You are Donna, the AI bookkeeper that runs the books for Honeybee Hills Apiary LLC/);
  assert.match(block, /You are NOT the client portal/);
  assert.match(block, /no human back office/);
  // Surfaces: the portal is named as a SEPARATE surface with its open-asks list.
  assert.match(block, /What I still need from you/);
  assert.match(block, /owner digest/i);
  assert.match(block, /their Telegram chat with you/);
  // The receipt: version + fingerprints + config snapshot (the capability-context
  // version is part of the receipt, like the model id).
  assert.equal(pack.receipt.self_knowledge_version, SELF_KNOWLEDGE_PACK_VERSION);
  assert.match(pack.receipt.self_knowledge_fingerprint, /^selfknow-/);
  assert.match(pack.receipt.registry_fingerprint, /^capreg-/);
  assert.match(pack.receipt.config_snapshot_id, /^cfg-/);
});

test('the owner rename rides the pack (assistantIdentity is extended, never duplicated)', async () => {
  const pack = await buildSelfKnowledgeContext({
    client: fakeClient([configRow(SELF_KNOWLEDGE_FLAG_KEY, 'canary')]),
    firmId: 'firm-1',
    clientId: 'client-1',
    clientProfile: { name: 'Acme LLC', assistant_name: 'Tessa' },
    surface: 'owner_channel',
    channel: 'telegram',
    env: EMPTY_ENV
  });
  assert.match(pack.systemPromptExtra, /You are Tessa, the AI bookkeeper/);
});

test('the "not enabled for you" case: an existing-but-unstaged feature is stated plainly, never hidden, never claimed on', async () => {
  const pack = await buildSelfKnowledgeContext({
    client: fakeClient([configRow(SELF_KNOWLEDGE_FLAG_KEY, 'canary')]),
    firmId: 'firm-1',
    clientId: 'client-1',
    surface: 'owner_channel',
    channel: 'telegram',
    env: EMPTY_ENV
  });
  const block = pack.systemPromptExtra;
  assert.match(block, /EXISTS IN DONNA BUT NOT SWITCHED ON FOR THIS CLIENT YET/);
  const notEnabledSection = block.slice(block.indexOf('NOT SWITCHED ON'));
  assert.match(notEnabledSection, /invoices/i, 'invoicing is named as existing-but-off');
  // And with the flag staged canary, it moves to the available section.
  const enabled = await buildSelfKnowledgeContext({
    client: fakeClient([
      configRow(SELF_KNOWLEDGE_FLAG_KEY, 'canary'),
      configRow('FINLAND_INVOICING', 'canary')
    ]),
    firmId: 'firm-1',
    clientId: 'client-1',
    surface: 'owner_channel',
    channel: 'telegram',
    env: EMPTY_ENV
  });
  const canDo = enabled.systemPromptExtra.slice(0, enabled.systemPromptExtra.indexOf('NOT SWITCHED ON'));
  assert.match(canDo, /Create and send invoices/);
});

test('the never-fabricate case: the hard rule binds absent capabilities to "can\'t do that yet", never an invented feature or URL', async () => {
  const pack = await buildSelfKnowledgeContext({
    client: fakeClient([configRow(SELF_KNOWLEDGE_FLAG_KEY, 'canary')]),
    firmId: 'firm-1',
    clientId: 'client-1',
    surface: 'owner_channel',
    channel: 'telegram',
    env: EMPTY_ENV
  });
  const block = pack.systemPromptExtra;
  assert.match(block, /If a capability is not listed above, you do NOT have it/);
  assert.match(block, /Never invent a feature, a surface, a team, or a state you cannot see/);
  assert.match(block, /Never type out a URL/);
  assert.match(block, /WHAT YOU CANNOT DO YET/);
  assert.match(block, /say "I can't do that yet"/i);
});

test('portal_link_enabled: owner-channel + OWNER_PORTAL_LINK canary only; the portal surface never arms the action', async () => {
  const rows = [
    configRow(SELF_KNOWLEDGE_FLAG_KEY, 'canary'),
    configRow(OWNER_PORTAL_LINK_FLAG_KEY, 'canary')
  ];
  const channelPack = await buildSelfKnowledgeContext({
    client: fakeClient(rows), firmId: 'f', clientId: 'c', surface: 'owner_channel', channel: 'telegram', env: EMPTY_ENV
  });
  assert.equal(channelPack.portal_link_enabled, true);
  assert.match(channelPack.systemPromptExtra, /share_portal_link/);
  const portalPack = await buildSelfKnowledgeContext({
    client: fakeClient(rows), firmId: 'f', clientId: 'c', surface: 'client_portal', env: EMPTY_ENV
  });
  assert.equal(portalPack.portal_link_enabled, false);
  assert.ok(!portalPack.systemPromptExtra.includes('share_portal_link'));
  // Without the sibling flag, the channel pack tells the model it CANNOT send links.
  const noLink = await buildSelfKnowledgeContext({
    client: fakeClient([configRow(SELF_KNOWLEDGE_FLAG_KEY, 'canary')]),
    firmId: 'f', clientId: 'c', surface: 'owner_channel', channel: 'telegram', env: EMPTY_ENV
  });
  assert.equal(noLink.portal_link_enabled, false);
  assert.match(noLink.systemPromptExtra, /cannot send portal links from this chat yet/);
});

test('a failed config read fails safe to no pack (a flag we cannot confirm does not act)', async () => {
  const pack = await buildSelfKnowledgeContext({
    client: { query: async () => { throw new Error('db down'); } },
    firmId: 'f',
    clientId: 'c',
    env: EMPTY_ENV
  });
  assert.equal(pack, null);
});

// ─── Slice 2: the deep link + honest degrade ────────────────────────────────

test('deep link: app origin + /client/<id>#list (the mounted portal\'s open-asks anchor)', () => {
  assert.equal(OWNER_PORTAL_OPEN_ASKS_PATH('client-1'), '/client/client-1#list');
  assert.equal(
    buildOwnerPortalDeepLink({ baseUrl: 'https://app.books.example/', clientId: 'client 1' }),
    'https://app.books.example/client/client%201#list'
  );
  assert.equal(buildOwnerPortalDeepLink({ baseUrl: '', clientId: 'c' }), null);
  assert.equal(buildOwnerPortalDeepLink({ baseUrl: 'https://x', clientId: '' }), null);
});

test('base URL resolves from the app origin (PUBLIC_APP_URL then APP_BASE_URL), never the outbound origin', () => {
  assert.equal(ownerPortalBaseUrl({ PUBLIC_APP_URL: 'https://app.books.example' }), 'https://app.books.example');
  assert.equal(ownerPortalBaseUrl({ APP_BASE_URL: 'https://donna.example' }), 'https://donna.example');
  assert.equal(ownerPortalBaseUrl({ PUBLIC_APP_URL: 'https://a', APP_BASE_URL: 'https://b' }), 'https://a');
  assert.equal(ownerPortalBaseUrl({ OUTBOUND_PUBLIC_BASE_URL: 'https://outbound.example' }), '', 'outbound origin is not the portal');
});

test('resolveOwnerPortalLink: sent with a URL, or the NAMED no_base_url blocker — never a half-built link', () => {
  const sent = resolveOwnerPortalLink({ clientId: 'client-1', env: { PUBLIC_APP_URL: 'https://app.books.example' } });
  assert.deepEqual(sent, { status: 'sent', url: 'https://app.books.example/client/client-1#list', path: '/client/client-1#list' });
  const degraded = resolveOwnerPortalLink({ clientId: 'client-1', env: {} });
  assert.equal(degraded.status, 'no_base_url');
  assert.equal(degraded.url, null);
  assert.equal(degraded.blocker, 'no_portal_base_url');
});

test('composePortalLinkReply: model text + the REAL link, or the honest instruction (the ownerDigest degrade posture)', () => {
  const link = { status: 'sent', url: 'https://app.books.example/client/c#list' };
  assert.equal(
    composePortalLinkReply({ text: 'Here you go.', link }),
    'Here you go.\nhttps://app.books.example/client/c#list'
  );
  assert.equal(
    composePortalLinkReply({ text: '', link }),
    `${portalLinkDefaultText()}\nhttps://app.books.example/client/c#list`
  );
  const degraded = composePortalLinkReply({ text: 'Here you go.', link: { status: 'no_base_url', url: null } });
  assert.equal(degraded, portalLinkUnavailableText());
  assert.match(degraded, /isn't configured on my side/);
  assert.ok(!degraded.includes('http'), 'no dead link in the degrade copy');
});

test('outbound capabilities resolve from the config snapshot exactly like every other flag-gated entry', () => {
  const states = resolveOwnerCapabilityStates({
    snapshot: { OUTBOUND_DUNNING: { stage: 'canary', source: 'test' } },
    env: EMPTY_ENV
  });
  assert.equal(states.find((cap) => cap.key === 'outbound_dunning').state, 'available');
  // No row ⇒ off (envFallback false — the rollout-flags rail), and shadow
  // observes without acting, so both are stated as not switched on.
  assert.equal(states.find((cap) => cap.key === 'outbound_invoicing').state, 'not_enabled');
  const shadow = resolveOwnerCapabilityStates({
    snapshot: { OUTBOUND_QUOTES: { stage: 'shadow', source: 'test' } },
    env: EMPTY_ENV
  });
  assert.equal(shadow.find((cap) => cap.key === 'outbound_quotes').state, 'not_enabled');
  // The four flag keys stay in lockstep with outbound/actionGate.js
  // OUTBOUND_ACTION_FLAG_KEYS (read as literals there and here on purpose —
  // this lineage touches no outbound files; a gate rename must update both).
  const flags = OWNER_CAPABILITY_MANIFEST.capabilities
    .filter((entry) => entry.key.startsWith('outbound_'))
    .map((entry) => entry.flag)
    .sort();
  assert.deepEqual(flags, ['OUTBOUND_DUNNING', 'OUTBOUND_INVOICING', 'OUTBOUND_PAYABLES', 'OUTBOUND_QUOTES']);
});

test('the workspace Actions tab joins SURFACES only when an outbound lane is live for this client', () => {
  const base = { assistantName: 'Donna', surface: 'owner_channel', channel: 'telegram', portalLinkEnabled: false };
  const live = renderSelfKnowledgeBlock({
    ...base,
    capabilityStates: [{ key: 'outbound_dunning', label: 'Chase unpaid customer invoices with payment reminders', state: 'available' }]
  });
  assert.match(live, /workspace Actions tab/);
  assert.match(live, /owner digest email links straight to it/);
  // Dark lane ⇒ the surface line is absent (the tab renders nothing while the
  // pipeline is dark; a pointer to an empty tab would be a wrong self-story).
  // The fixture label deliberately avoids the phrase so this pin isolates the
  // SURFACES line from the not-enabled capability listing.
  const dark = renderSelfKnowledgeBlock({
    ...base,
    capabilityStates: [{ key: 'outbound_dunning', label: 'Chase unpaid customer invoices with payment reminders', state: 'not_enabled' }]
  });
  assert.ok(!dark.includes('workspace Actions tab'));
  const none = renderSelfKnowledgeBlock({ ...base, capabilityStates: [] });
  assert.ok(!none.includes('workspace Actions tab'));
});

test('owner-facing copy holds the voice rule: no em or en dashes', () => {
  for (const copy of [
    portalLinkUnavailableText(),
    portalLinkDefaultText(),
    sensitiveAskPortalNoticeText({ assistantName: 'Donna', url: 'https://app.books.example/client/c#list', askRef: 'AB12CD34' }),
    sensitiveAskPortalNoticeText({ assistantName: 'Donna', url: null, askRef: 'AB12CD34' }),
    SENSITIVE_ASK_WA_ITEM_PARAM,
    // Manifest labels render straight into the owner-facing block.
    ...OWNER_CAPABILITY_MANIFEST.capabilities.map((entry) => entry.label),
    ...OWNER_CAPABILITY_MANIFEST.cannot_yet.map((entry) => entry.label)
  ]) {
    assert.ok(!copy.includes('—') && !copy.includes('–'), `no em/en dash in: ${copy}`);
  }
});

test('sensitiveAskPortalNoticeText: portal pointer + real link or the named degrade instruction, never question content', () => {
  // By construction the composer takes no question text — this test pins the
  // rest of the contract: the link version carries the REAL url, the degrade
  // version carries an instruction and no dead link, both carry the ask ref.
  const withLink = sensitiveAskPortalNoticeText({ assistantName: 'Maija', url: 'https://app.books.example/client/c-1#list', askRef: 'AB12CD34' });
  assert.match(withLink, /^Maija here\./);
  assert.match(withLink, /secure Donna portal/);
  assert.match(withLink, /What I still need from you/);
  assert.ok(withLink.includes('https://app.books.example/client/c-1#list'));
  assert.ok(withLink.includes('(ref AB12CD34)'));

  const degraded = sensitiveAskPortalNoticeText({ assistantName: null, url: null, askRef: 'AB12CD34' });
  assert.match(degraded, /^Donna here\./, 'assistant name falls back to Donna');
  assert.match(degraded, /Open your Donna portal/);
  assert.ok(!degraded.includes('http'), 'no dead link in the degrade copy');
  assert.ok(degraded.includes('(ref AB12CD34)'));

  const noRef = sensitiveAskPortalNoticeText({ url: null, askRef: null });
  assert.ok(!noRef.includes('(ref'), 'ref clause omitted when no ref');

  assert.equal(SENSITIVE_ASK_NOTICE_VERSION, 'sensitive-ask-notice.v1');
  assert.equal(SENSITIVE_ASK_NOTICE_TEMPLATE, 'donna_sensitive_ask_notice_v1');
  // The WA leg rides the runbook's REGISTERED portal-redirect template with a
  // fixed safe item phrase (a URL never rides a Meta template parameter).
  assert.equal(SENSITIVE_ASK_WA_TEMPLATE, 'donna_secure_upload_v1');
  assert.ok(SENSITIVE_ASK_WA_ITEM_PARAM.length <= 60);
});

test('recordOwnerPortalLinkShare writes one audit_events row with actor, authority basis, and the pack version', async () => {
  const queries = [];
  const client = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; } };
  await recordOwnerPortalLinkShare(client, {
    firmId: 'firm-1',
    clientId: 'client-1',
    actorId: 'collab-1',
    channel: 'telegram',
    status: 'sent',
    linkPath: '/client/client-1#list',
    selfKnowledgeVersion: SELF_KNOWLEDGE_PACK_VERSION,
    selfKnowledgeFingerprint: 'selfknow-abc',
    configSnapshotId: 'cfg-abc'
  });
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /insert into audit_events/);
  assert.match(queries[0].sql, /owner_portal_link\.shared/);
  assert.equal(queries[0].params[2], 'client', 'actor_type defaults to client (the owner asked)');
  const metadata = JSON.parse(queries[0].params[4]);
  assert.equal(metadata.actor_id, 'collab-1');
  assert.equal(metadata.channel, 'telegram');
  assert.equal(metadata.status, 'sent');
  assert.equal(metadata.authority_basis, `config_stage:${OWNER_PORTAL_LINK_FLAG_KEY}`);
  assert.equal(metadata.trigger, 'owner_request', 'trigger defaults to the owner-request share');
  assert.equal(metadata.self_knowledge_version, SELF_KNOWLEDGE_PACK_VERSION);
  assert.equal(metadata.config_snapshot_id, 'cfg-abc');
  await assert.rejects(() => recordOwnerPortalLinkShare(client, { firmId: 'f' }), /requires/);
});

test('recordOwnerPortalLinkShare carries the sensitive-ask fallback shape: system actor, trigger, ask id, notice version', async () => {
  const queries = [];
  const client = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; } };
  await recordOwnerPortalLinkShare(client, {
    firmId: 'firm-1',
    clientId: 'client-1',
    actorId: 'ask:ask-9',
    actorType: 'system',
    channel: 'whatsapp',
    status: 'sent',
    linkPath: '/client/client-1#list',
    trigger: 'sensitive_ask_blocked',
    askId: 'ask-9',
    noticeVersion: SENSITIVE_ASK_NOTICE_VERSION,
    configSnapshotId: 'cfg-xyz'
  });
  assert.equal(queries[0].params[2], 'system', 'the refuse-layer triggered the send, not an owner request');
  const metadata = JSON.parse(queries[0].params[4]);
  assert.equal(metadata.trigger, 'sensitive_ask_blocked');
  assert.equal(metadata.ask_id, 'ask-9');
  assert.equal(metadata.notice_version, SENSITIVE_ASK_NOTICE_VERSION);
  assert.equal(metadata.authority_basis, `config_stage:${OWNER_PORTAL_LINK_FLAG_KEY}`);
});

test('renderSelfKnowledgeBlock is deterministic prose over the resolved states (no dynamic reads)', () => {
  const args = {
    assistantName: 'Donna',
    clientName: 'Acme',
    surface: 'owner_channel',
    channel: 'telegram',
    capabilityStates: [{ key: 'a', label: 'Do a thing', state: 'available' }],
    portalLinkEnabled: true,
    asOf: '2026-07-24'
  };
  assert.equal(renderSelfKnowledgeBlock(args), renderSelfKnowledgeBlock(args));
  assert.match(renderSelfKnowledgeBlock(args), /self-knowledge-pack\.v1, as of 2026-07-24/);
});

// ─── The third surface: the external chat hosts (hosted chat surface, slice 4) ─

import { readFileSync } from 'node:fs';
import { SELF_KNOWLEDGE_SURFACES } from './selfKnowledge.js';

const GOLDEN = JSON.parse(readFileSync(new URL('./selfKnowledge.surfaces.golden.json', import.meta.url), 'utf8'));
const GOLDEN_STATES = [
  { key: 'answer_books_questions', label: 'Answer questions about the books', state: 'available' },
  { key: 'share_portal_link', label: 'Send a direct link', state: 'not_enabled' },
  { key: 'outbound_invoicing', label: 'Draft and send customer invoices', state: 'available' }
];
const stripReceipt = (pack) => ({ ...pack, receipt: undefined });

test('the portal and owner-channel packs are BYTE-IDENTICAL to before the external-chat surface existed (golden, captured from the pre-slice-4 tree)', async () => {
  assert.deepEqual(SELF_KNOWLEDGE_SURFACES, ['client_portal', 'owner_channel', 'external_chat']);
  assert.equal(
    renderSelfKnowledgeBlock({ assistantName: 'Donna', clientName: 'Honeybee', surface: 'client_portal', capabilityStates: GOLDEN_STATES, portalLinkEnabled: false }),
    GOLDEN.render_portal
  );
  assert.equal(
    renderSelfKnowledgeBlock({ assistantName: 'Donna', clientName: 'Honeybee', surface: 'owner_channel', channel: 'telegram', capabilityStates: GOLDEN_STATES, portalLinkEnabled: false }),
    GOLDEN.render_channel_telegram_nolink
  );
  assert.equal(
    renderSelfKnowledgeBlock({ assistantName: 'Mira', clientName: null, surface: 'owner_channel', channel: 'whatsapp', capabilityStates: GOLDEN_STATES, portalLinkEnabled: true }),
    GOLDEN.render_channel_whatsapp_link
  );
  assert.equal(
    renderSelfKnowledgeBlock({ assistantName: 'Donna', surface: 'owner_channel', channel: null, capabilityStates: GOLDEN_STATES, portalLinkEnabled: false }),
    GOLDEN.render_channel_unknown
  );
  const both = [configRow(SELF_KNOWLEDGE_FLAG_KEY, 'canary'), configRow(OWNER_PORTAL_LINK_FLAG_KEY, 'canary')];
  const profile = { name: 'Honeybee Hills Apiary LLC', assistant_name: null };
  assert.deepEqual(
    JSON.parse(JSON.stringify(stripReceipt(await buildSelfKnowledgeContext({ client: fakeClient(both), firmId: 'f', clientId: 'c', clientProfile: profile, surface: 'client_portal', env: EMPTY_ENV })))),
    GOLDEN.build_portal
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(stripReceipt(await buildSelfKnowledgeContext({ client: fakeClient(both), firmId: 'f', clientId: 'c', clientProfile: profile, surface: 'owner_channel', channel: 'telegram', env: EMPTY_ENV })))),
    GOLDEN.build_channel
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(stripReceipt(await buildSelfKnowledgeContext({ client: fakeClient([configRow(SELF_KNOWLEDGE_FLAG_KEY, 'canary')]), firmId: 'f', clientId: 'c', clientProfile: profile, surface: 'owner_channel', channel: 'sms', env: EMPTY_ENV })))),
    GOLDEN.build_channel_nolink
  );
});

test('external_chat pack: the chat app is a window; documents cannot arrive; the confirm doors are the chat itself and the portal; the receive-documents entry is stated as not-on-this-surface', async () => {
  const pack = await buildSelfKnowledgeContext({
    client: fakeClient([configRow(SELF_KNOWLEDGE_FLAG_KEY, 'canary')]),
    firmId: 'f', clientId: 'c',
    clientProfile: { name: 'Honeybee Hills Apiary LLC', assistant_name: null },
    surface: 'external_chat', channel: 'chatgpt_app', env: EMPTY_ENV
  });
  assert.equal(pack.surface, 'external_chat');
  const block = pack.systemPromptExtra;
  assert.match(block, /in an external chat app \(ChatGPT or Claude\) that relays their words to you/);
  assert.match(block, /it is a window, not Donna, and it holds none of your context/);
  assert.match(block, /Receipts and document photos cannot arrive through it: for uploads, point the owner to their Donna portal/);
  assert.match(block, /Confirming a proposal from this chat: .* nothing is recorded yet/);
  assert.match(block, /right here by saying so \(the chat app then calls Donna's confirm step/);
  assert.match(block, /or on the Confirm card in their Donna portal/);
  assert.match(block, /Never say it is recorded until you are told it was confirmed/);
  // The manifest entry that does not hold here moves out of CAN into NOT ON THIS SURFACE.
  assert.match(block, /EXISTS IN DONNA BUT NOT ON THIS SURFACE/);
  assert.match(block, /Receive receipts, invoices, and photos through this chat \(a chat app cannot send files to Donna/);
  const canSection = block.slice(block.indexOf('WHAT YOU CAN DO'), block.indexOf('EXISTS IN DONNA BUT NOT ON THIS SURFACE'));
  assert.doesNotMatch(canSection, /Receive receipts, invoices, and photos sent on this chat/);
  // The confirm-gated verbs are worded for this surface's doors.
  assert.match(canSection, /file it into the books, once the owner confirms it \(right here, by saying so, or on the Confirm card in their portal\)/);
  assert.match(canSection, /mileage rate, once the owner confirms the entry/);
  assert.doesNotMatch(canSection, /applied directly on a bound owner channel/);
  // The portal stays a separate, named surface; without the link flag the model cannot send links.
  assert.match(block, /What I still need from you/);
  assert.equal(pack.portal_link_enabled, false);
  assert.match(block, /cannot send portal links from this chat yet/);
  // Voice rule on the new lines.
  assert.doesNotMatch(block, /[—–]/);
});

test('portal_link_enabled arms on external_chat with OWNER_PORTAL_LINK canary (the deep link is the upload door there); the portal surface still never arms it', async () => {
  const rows = [configRow(SELF_KNOWLEDGE_FLAG_KEY, 'canary'), configRow(OWNER_PORTAL_LINK_FLAG_KEY, 'canary')];
  const external = await buildSelfKnowledgeContext({ client: fakeClient(rows), firmId: 'f', clientId: 'c', surface: 'external_chat', channel: 'claude_remote', env: EMPTY_ENV });
  assert.equal(external.portal_link_enabled, true);
  assert.match(external.systemPromptExtra, /include an action of type share_portal_link/);
  assert.match(external.systemPromptExtra, /The system resolves and appends the real link/);
  const portal = await buildSelfKnowledgeContext({ client: fakeClient(rows), firmId: 'f', clientId: 'c', surface: 'client_portal', env: EMPTY_ENV });
  assert.equal(portal.portal_link_enabled, false);
  // The receipt carries the surface's verdict like every other pack.
  assert.equal(external.receipt.portal_link_enabled, true);
  assert.match(external.fingerprint, /^selfknow-/);
  assert.notEqual(external.fingerprint, portal.fingerprint, 'a different surface is a different resolved pack');
});
