// Donna — operational self-knowledge context pack (the governed-learning-system
// lineage; docs/donna-self-awareness-plan.md §6 — capability knowledge comes from
// the REGISTRY, never from runtime repo introspection).
//
// THE FAILURE THIS FIXES (2026-07-24, Kari's Telegram): asked for a portal link,
// Donna replied that she has no access to such things and that she IS a client
// portal. The owner-channel prompt carried nothing about who Donna is, which
// surfaces exist, or what is enabled for this client, so the strong model
// improvised a wrong self-story. This module is the fix's Keep layer: a compact,
// VERSIONED, deterministic context block assembled at answer time from PERSISTED
// sources only —
//   (a) identity: who Donna is, who the owner is, which surfaces exist;
//   (b) capabilities: the curated owner-facing manifest below, grounded against
//       the versioned capability registry (this is the registry's FIRST live
//       consumer, READ-ONLY — selfKnowledge.test.js asserts every referenced
//       capability id is registered), resolved against what is actually ENABLED
//       for THIS client via the config control plane snapshot (the SAME
//       clientFlagActs + envFallback:false predicate the runtime gates on, so
//       "not switched on for you yet" always matches what would really happen);
//   (c) limits + roadmap essence: the curated cannot-yet list — DATA with
//       provenance and an as-of date, maintained like a pack manifest.
// The strong model then answers as herself, honestly, FROM this context
// (trust-the-strong-LLM: the pack feeds the model more good context; it is not
// a cage). The pack version + fingerprint ride every prompt receipt (the model
// id is part of the receipt; so is the capability-context version).
//
// Flags (rollout-flags rail: born on the config plane, envFallback false, never
// an env pair):
//   SELF_KNOWLEDGE_CONTEXT — gates the prompt injection. off/dry_run/shadow: no
//     block, byte-identical prompt. canary/auto: the block is appended to the
//     owner-channel (and portal-chat) system prompt.
//   OWNER_PORTAL_LINK — gates owner-directed portal-link delivery on owner
//     channels: the share_portal_link governed action (model-proposed, owner
//     channels only) AND the deterministic sensitive-ask fallback notice
//     (firmDb.js deliverSensitiveAskPortalNotice — when askSafety blocks an ask
//     as sensitive_ask_portal_only, the owner gets a safe "this needs your
//     portal" notice instead of silence; same trust class, same lever, no model
//     in that loop). Both flags born off; staged per client via
//     scripts/enable_self_knowledge_context.js. The action instruction rides the
//     self-knowledge block, so OWNER_PORTAL_LINK without SELF_KNOWLEDGE_CONTEXT
//     is inert for the CHAT action (the model is never told the action exists,
//     and the sanitizer drops unsolicited emissions unless the flag acts); the
//     sensitive-ask notice needs only OWNER_PORTAL_LINK (pure Keep layer).
//
// The portal deep link (slice 2) reuses the EXISTING auth substrate: portal auth
// is the Supabase session + client-scoped collaborator row (assertFirmAccess);
// the link itself grants nothing, so no bearer token is minted. `/client/<id>#list`
// lands on the portal's "What I still need from you" section (the #list anchor in
// donna-client-portal.jsx — the mounted surface). No base URL configured degrades
// to an instruction, never a dead link (the ownerDigest posture).

import { createHash } from 'node:crypto';

import { isRegisteredCapability, capabilityRegistryFingerprint } from './capabilityRegistry.js';
import { clientFlagActs, readClientConfigSnapshot, configSnapshotId } from './clientConfig.js';
import { resolveAssistantName } from './assistantIdentity.js';

export const SELF_KNOWLEDGE_FLAG_KEY = 'SELF_KNOWLEDGE_CONTEXT';

// The surfaces the pack can describe. 'client_portal' and 'owner_channel' are
// the original two; 'external_chat' (hosted chat surface slice 4, 2026-09-15:
// ChatGPT / Claude via ask_donna, mcpAskDonna.js) is the third — the owner is
// NOT in the portal and has no channel bound: documents cannot arrive through
// it, proposals are confirmed in the chat itself (the chat app calls Donna's
// confirm_action) or on the portal's Confirm card, and the portal deep link is
// the door for uploads when OWNER_PORTAL_LINK acts. The portal and channel
// renders are byte-identical to before this surface existed (pinned against
// selfKnowledge.surfaces.golden.json).
export const SELF_KNOWLEDGE_SURFACES = Object.freeze(['client_portal', 'owner_channel', 'external_chat']);
export const OWNER_PORTAL_LINK_FLAG_KEY = 'OWNER_PORTAL_LINK';
export const SELF_KNOWLEDGE_PACK_VERSION = 'self-knowledge-pack.v1';

const deepFreeze = (node) => {
  if (node && typeof node === 'object') {
    for (const value of Object.values(node)) deepFreeze(value);
    Object.freeze(node);
  }
  return node;
};

// ── The curated owner-facing capability manifest ─────────────────────────────
//
// DATA, not code: each entry is an owner-legible statement of something Donna
// can do on the owner surfaces, with provenance. Entries with a `flag` resolve
// per client at answer time; `always` entries are the owner-chat action grammar
// itself (clientPortalChat.js) and the channel intake paths (inboundCore.js).
// `registry_capabilities` grounds an entry against the versioned capability
// registry — the test refuses a manifest entry naming an unregistered id, which
// is what keeps this list a registry DERIVATION rather than free prose.
// Maintenance rule (the immutability boundary): changing what an entry MEANS is
// a new entry key; fixing wording bumps nothing but must keep as_of current.

export const OWNER_CAPABILITY_MANIFEST = deepFreeze({
  version: SELF_KNOWLEDGE_PACK_VERSION,
  as_of: '2026-07-24',
  provenance: 'curated in server/donna/selfKnowledge.js from the owner-chat action grammar (clientPortalChat.js), the channel intake paths (inboundCore.js), the outbound action gate flag families (outbound/actionGate.js), and the versioned capability registry (capabilityRegistry.js); flag-gated entries resolve against the client_capability_config snapshot at answer time',
  capabilities: [
    {
      key: 'answer_books_questions',
      availability: 'always',
      registry_capabilities: [],
      label: 'Answer questions about the books from the recorded state: transactions, documents, open questions, and the period summary'
    },
    {
      key: 'file_ask_answers',
      availability: 'always',
      registry_capabilities: ['finance.answer_evidence_request.v1'],
      label: 'Take the owner\'s answer to an open question and file it into the books (confirm-gated in the portal; applied directly on a bound owner channel)'
    },
    {
      key: 'record_mileage',
      availability: 'always',
      registry_capabilities: ['finance.record_mileage.v1'],
      label: 'Record owner-stated business mileage at the current mileage rate'
    },
    {
      key: 'run_reports',
      availability: 'always',
      registry_capabilities: [],
      label: 'Run a deterministic P&L or financial-statement report for any period and explain it'
    },
    {
      key: 'receive_documents_on_chat',
      availability: 'always',
      registry_capabilities: [],
      label: 'Receive receipts, invoices, and photos sent on this chat and file them into the books'
    },
    {
      key: 'share_portal_link',
      availability: 'flag',
      flag: OWNER_PORTAL_LINK_FLAG_KEY,
      registry_capabilities: [],
      label: 'Send a direct link to the client portal\'s open questions and missing documents list'
    },
    {
      key: 'issue_invoices',
      availability: 'flag',
      flag: 'FINLAND_INVOICING',
      registry_capabilities: [],
      label: 'Create and send invoices from this chat (Finnish e-invoicing: message "laskuta ..." with the customer and amount)'
    },
    {
      key: 'issue_quotes',
      availability: 'flag',
      flag: 'FINLAND_QUOTES',
      registry_capabilities: [],
      label: 'Create and send quotes (tarjous) from this chat'
    },
    {
      key: 'receive_einvoices',
      availability: 'flag',
      flag: 'FINLAND_EINVOICE_RECEIVE',
      registry_capabilities: [],
      label: 'Receive e-invoices (Finvoice/UBL) sent to the business and book them as supplier bills'
    },
    {
      key: 'file_alv_returns',
      availability: 'flag',
      flag: 'FINLAND_ALV_FILING',
      registry_capabilities: [],
      label: 'Prepare Finnish VAT (ALV) returns and file them after the owner confirms'
    },
    {
      key: 'file_gst_returns',
      availability: 'flag',
      flag: 'SINGAPORE_GST_FILING',
      registry_capabilities: [],
      label: 'Prepare Singapore GST F5 draft returns for the owner to confirm; the firm files externally (the IRAS transmit channel is not live)'
    },
    // The owner-visible OUTBOUND_* lanes (#1095's workspace Actions tab). Flag
    // keys are the outbound action gate's flag family (outbound/actionGate.js
    // OUTBOUND_ACTION_FLAG_KEYS), read here as literals like the FINLAND_*/
    // SINGAPORE_* entries above — this module touches no outbound files; if
    // the gate ever renames a key, this manifest must follow. Labels are
    // stage-stable on purpose: at canary every send holds for owner approval
    // in the Actions tab, at the earned-auto terminal some sends graduate, so
    // the label says where the lane is MANAGED, not that every send waits.
    {
      key: 'outbound_invoicing',
      availability: 'flag',
      flag: 'OUTBOUND_INVOICING',
      registry_capabilities: [],
      label: 'Draft and send customer invoices from the books, managed from the workspace Actions tab'
    },
    {
      key: 'outbound_quotes',
      availability: 'flag',
      flag: 'OUTBOUND_QUOTES',
      registry_capabilities: [],
      label: 'Draft and send quotes to customers, managed from the workspace Actions tab'
    },
    {
      key: 'outbound_dunning',
      availability: 'flag',
      flag: 'OUTBOUND_DUNNING',
      registry_capabilities: [],
      label: 'Chase unpaid customer invoices with payment reminders, managed from the workspace Actions tab'
    },
    {
      key: 'outbound_payable_notices',
      availability: 'flag',
      flag: 'OUTBOUND_PAYABLES',
      registry_capabilities: [],
      label: 'Notify the owner directly when a supplier bill is due, with the payment details'
    }
  ],
  cannot_yet: [
    { key: 'voice_notes', label: 'Listen to voice notes (type the answer or send a photo instead)' },
    { key: 'make_payments', label: 'Pay bills, move money, or touch any bank account' },
    { key: 'change_connections', label: 'Connect or disconnect banks or accounting systems from this chat (that lives in the portal)' },
    { key: 'edit_transactions_from_chat', label: 'Recategorise, delete, or edit transactions directly from this chat' },
    { key: 'formal_tax_advice', label: 'Give formal tax advice or rulings beyond what the books record' }
  ]
});

// Resolve the manifest against THIS client's config snapshot. Uses the exact
// predicate the runtime gates on (clientFlagActs, envFallback: () => false), so
// the rendered state can never disagree with what would actually happen if the
// owner tried: a flag we cannot confirm does not act, and is stated as not
// switched on.
export const resolveOwnerCapabilityStates = ({ snapshot = {}, env = process.env } = {}) =>
  OWNER_CAPABILITY_MANIFEST.capabilities.map((entry) => ({
    key: entry.key,
    label: entry.label,
    state: entry.availability === 'always'
      ? 'available'
      : (clientFlagActs({ flagKey: entry.flag, snapshot, envFallback: () => false, env }) ? 'available' : 'not_enabled')
  }));

// Deterministic fingerprint over the RESOLVED pack content, so the receipt pins
// exactly what the model was told (the canonicalize-then-hash shape from
// clientConfig.configSnapshotId).
const canonicalize = (node) => {
  if (Array.isArray(node)) return node.map(canonicalize);
  if (node && typeof node === 'object') {
    const out = {};
    for (const key of Object.keys(node).sort()) out[key] = canonicalize(node[key]);
    return out;
  }
  return node;
};

export const selfKnowledgeFingerprint = (resolved) =>
  `selfknow-${createHash('sha256').update(JSON.stringify(canonicalize(resolved))).digest('hex')}`;

// ── The portal deep link (slice 2 — deterministic, no bearer token) ──────────

// The portal lives on the app origin (the same resolver the Stripe portal
// redirects use: PUBLIC_APP_URL, then APP_BASE_URL). Deliberately NOT
// OUTBOUND_PUBLIC_BASE_URL — that is the outbound/marketing origin, not the
// app; a portal link with no app origin refuses (no_base_url) rather than
// guessing the marketing host. publicAppOrigin is for OUTBOUND links only.
export const ownerPortalBaseUrl = (env = process.env) => {
  const clean = (v) => String(v ?? '').trim();
  return clean(env.PUBLIC_APP_URL) || clean(env.APP_BASE_URL) || '';
};

// #list is the portal's "What I still need from you" section anchor (the open
// asks + missing documents master list) in donna-client-portal.jsx, the MOUNTED
// portal surface.
export const OWNER_PORTAL_OPEN_ASKS_PATH = (clientId) =>
  `/client/${encodeURIComponent(String(clientId ?? '').trim())}#list`;

export const buildOwnerPortalDeepLink = ({ baseUrl, clientId } = {}) => {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  const id = String(clientId ?? '').trim();
  if (!base || !id) return null;
  return `${base}${OWNER_PORTAL_OPEN_ASKS_PATH(id)}`;
};

// Resolve the link for a bound owner's request. Fails honestly and NAMED when
// the base URL is unset (the ownerDigest posture: degrade with an instruction,
// never a dead link, never silence). The channel-unbound case never reaches
// here — the general owner chat path requires exactly one active binding.
export const resolveOwnerPortalLink = ({ clientId, env = process.env } = {}) => {
  const url = buildOwnerPortalDeepLink({ baseUrl: ownerPortalBaseUrl(env), clientId });
  return url
    ? { status: 'sent', url, path: OWNER_PORTAL_OPEN_ASKS_PATH(clientId) }
    : { status: 'no_base_url', url: null, path: null, blocker: 'no_portal_base_url' };
};

// Owner-facing copy (voice rule: no em or en dashes; comma, colon, or a new
// sentence instead — pinned by test like the channel copy strings).
//
// `language` is the owner's (preferredOwnerTemplateLanguage); anything but 'fi'
// gets the English copy, unchanged. The portal section is named by its title
// as the portal shows it, the same as the sensitive-ask notice below.
const PORTAL_LINK_COPY = Object.freeze({
  en: Object.freeze({
    unavailable: "I can't send a working link right now: the portal web address isn't configured on my side yet. "
      + 'Open your Donna portal and go to the section called What I still need from you. '
      + 'Your open questions and missing documents are all listed there.',
    lead: 'Here is your portal link. Your open questions and missing documents are under What I still need from you.'
  }),
  fi: Object.freeze({
    unavailable: 'En pysty lähettämään toimivaa linkkiä juuri nyt, koska portaalin verkko-osoitetta ei ole vielä asetettu minun päässäni. '
      + 'Avaa Donna-portaalisi ja mene kohtaan What I still need from you. '
      + 'Kaikki avoimet kysymyksesi ja puuttuvat asiakirjat löytyvät sieltä.',
    lead: 'Tässä on portaalilinkkisi. Avoimet kysymyksesi ja puuttuvat asiakirjat löytyvät kohdasta What I still need from you.'
  })
});
const portalLinkCopyFor = (language) => PORTAL_LINK_COPY[language] || PORTAL_LINK_COPY.en;

export const portalLinkUnavailableText = (language = 'en') => portalLinkCopyFor(language).unavailable;

export const portalLinkDefaultText = (language = 'en') => portalLinkCopyFor(language).lead;

// The deterministic outbound text for a share_portal_link turn: the model's own
// short text plus the REAL resolved link on its own line, or the honest named
// degrade copy. The model never types a URL (render the persisted verdict; a
// fabricated link is the failure mode this lineage exists to kill). The model's
// own text is kept as written; only the deterministic lines follow `language`.
export const composePortalLinkReply = ({ text = '', link = null, language = 'en' } = {}) => {
  if (!link || link.status !== 'sent' || !link.url) return portalLinkUnavailableText(language);
  const lead = String(text || '').trim() || portalLinkDefaultText(language);
  return `${lead}\n${link.url}`;
};

// ── The sensitive-ask portal fallback notice (slice 3 — deterministic) ───────
//
// askSafety.js blocks an ask that solicits a sensitive identifier from WA/SMS/
// Telegram (failure_reason 'sensitive_ask_portal_only'). Before this slice that
// block was a SILENT firm-side ledger row — a two-terminal-states violation:
// the ask rested neither auto-handled nor on the owner. The fallback (wired in
// firmDb.js deliverSensitiveAskPortalNotice, gated by OWNER_PORTAL_LINK) sends
// the bound owner a SAFE notice instead: never the question content, just
// "a question needs your secure portal" plus the deterministic deep link, or
// the named degrade instruction when no base URL is configured. This composer
// is the copy's single home (voice rule: no em or en dashes; pinned by test).
// By construction it takes NO question text, so sensitive content cannot leak
// through it.
export const SENSITIVE_ASK_NOTICE_VERSION = 'sensitive-ask-notice.v1';

// The WhatsApp leg cannot carry free-form text outside Meta's 24h window, so it
// rides the REGISTERED portal-redirect template the WA runbook designed for
// exactly this refuse-layer ("This one needs the secure route: {{1}}. Ref:
// {{2}}. Put it in the Donna portal rather than here, and I'll take it from
// there."). {{1}} is a fixed safe phrase, never the question; a URL never rides
// a Meta template parameter.
export const SENSITIVE_ASK_WA_TEMPLATE = 'donna_secure_upload_v1';
export const SENSITIVE_ASK_WA_ITEM_PARAM = 'my next question for you';
// {{1}} follows the language of the template actually sent (as the ask
// template's period does): a Finnish template carries the Finnish phrase, an
// English one (including the English retry) the English phrase, unchanged.
const SENSITIVE_ASK_WA_ITEM_PARAMS = Object.freeze({
  en: SENSITIVE_ASK_WA_ITEM_PARAM,
  fi: 'seuraava kysymykseni sinulle'
});
export const sensitiveAskWaItemParam = (language = 'en') => SENSITIVE_ASK_WA_ITEM_PARAMS[language] || SENSITIVE_ASK_WA_ITEM_PARAMS.en;

// SMS/Telegram render code-side, so the notice text below is what the owner
// reads there (the ledger records it under this template name).
export const SENSITIVE_ASK_NOTICE_TEMPLATE = 'donna_sensitive_ask_notice_v1';

// `language` is the owner's (preferredOwnerTemplateLanguage); anything but 'fi'
// gets the English notice, unchanged. The portal section is named by its title
// as the portal shows it. "(ref X)" stays verbatim in both languages because
// extractAskRef anchors a reply on the word "ref".
const SENSITIVE_ASK_NOTICE_COPY = Object.freeze({
  en: Object.freeze({
    lead: (name) => `${name} here. I have a question for you that is too sensitive for this chat, so I put it in your secure Donna portal.`,
    withLink: (url, ref) => `Answer it under What I still need from you: ${url}${ref}`,
    withoutLink: (ref) => `Open your Donna portal and look under What I still need from you.${ref}`
  }),
  fi: Object.freeze({
    lead: (name) => `Hei, täällä ${name}. Minulla on sinulle kysymys, joka on liian arkaluonteinen tähän keskusteluun, joten laitoin sen suojattuun Donna-portaaliisi.`,
    withLink: (url, ref) => `Löydät sen kohdasta What I still need from you: ${url}${ref}`,
    withoutLink: (ref) => `Avaa Donna-portaalisi ja katso kohta What I still need from you.${ref}`
  })
});

export const sensitiveAskPortalNoticeText = ({ assistantName = 'Donna', url = null, askRef = null, language = 'en' } = {}) => {
  const copy = SENSITIVE_ASK_NOTICE_COPY[language] || SENSITIVE_ASK_NOTICE_COPY.en;
  const name = String(assistantName || '').trim() || 'Donna';
  const ref = askRef ? ` (ref ${askRef})` : '';
  const lead = copy.lead(name);
  return url
    ? `${lead} ${copy.withLink(url, ref)}`
    : `${lead} ${copy.withoutLink(ref)}`;
};

// Audit the share (best-effort at the call site; the receipt also rides the
// assistant-message payload and the message delivery ledger). `client` is a pg
// client/transaction handle. actor_type defaults 'client' (the bound OWNER
// asked; Donna executed under the flag stage named in authority_basis); the
// sensitive-ask fallback passes actorType 'system' + trigger
// 'sensitive_ask_blocked' (no owner request in that loop — the refuse-layer
// triggered the send).
export const recordOwnerPortalLinkShare = async (client, {
  firmId, clientId, actorId = null, actorType = 'client', channel = null, status, linkPath = null,
  authorityBasis = `config_stage:${OWNER_PORTAL_LINK_FLAG_KEY}`,
  trigger = 'owner_request', askId = null, noticeVersion = null,
  selfKnowledgeVersion = null, selfKnowledgeFingerprint: packFingerprint = null,
  configSnapshotId: snapshotId = null
} = {}) => {
  if (!client || !firmId || !clientId) throw new Error('recordOwnerPortalLinkShare requires client, firmId, clientId');
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
     values ($1, $2, $3, 'owner_portal_link.shared', 'owner_portal_link', $4, $5::jsonb)`,
    [firmId, clientId, actorType, clientId, JSON.stringify({
      actor_id: actorId,
      channel,
      status,
      link_path: linkPath,
      authority_basis: authorityBasis,
      trigger,
      ask_id: askId,
      notice_version: noticeVersion,
      self_knowledge_version: selfKnowledgeVersion,
      self_knowledge_fingerprint: packFingerprint,
      config_snapshot_id: snapshotId
    })]
  );
};

// ── Rendering ────────────────────────────────────────────────────────────────

// The external chat surface (ChatGPT / Claude via ask_donna): a chat app
// cannot carry files to Donna, so the receive-documents entry is stated as
// not-on-this-surface with the door that does work; the two confirm-gated
// verbs are worded for the doors that exist there (the chat's own confirm
// step, the portal's Confirm card). Voice rule: no em or en dashes.
const EXTERNAL_CHAT_NOT_HERE = Object.freeze({
  receive_documents_on_chat: 'Receive receipts, invoices, and photos through this chat (a chat app cannot send files to Donna: the owner uploads them in their Donna portal)'
});
const EXTERNAL_CHAT_LABEL_OVERRIDES = Object.freeze({
  file_ask_answers: 'Take the owner\'s answer to an open question and file it into the books, once the owner confirms it (right here, by saying so, or on the Confirm card in their portal)',
  record_mileage: 'Record owner-stated business mileage at the current mileage rate, once the owner confirms the entry'
});

const channelLabel = (channel) => ({
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  sms: 'SMS'
}[String(channel || '').toLowerCase()] || null);

// The system-prompt block. Deterministic prose over the resolved states; the
// hard rules at the bottom are the never-fabricate rail (a capability absent
// from this pack yields "I can't do that yet", never an invented feature, and
// never a typed-out URL).
export const renderSelfKnowledgeBlock = ({
  assistantName,
  clientName = null,
  surface = 'client_portal',
  channel = null,
  capabilityStates = [],
  portalLinkEnabled = false,
  asOf = OWNER_CAPABILITY_MANIFEST.as_of
} = {}) => {
  const name = assistantName;
  const business = clientName ? ` for ${clientName}` : '';
  const onChannel = channelLabel(channel);
  const external = surface === 'external_chat';
  const here = surface === 'owner_channel'
    ? (onChannel ? `their ${onChannel} chat with you` : 'their messaging chat with you')
    : external
      ? 'an external chat app (ChatGPT or Claude) that relays their words to you'
      : 'the client portal chat';
  // On the external chat surface one manifest entry does not hold (files
  // cannot arrive through a chat app) and two are worded for that surface's
  // confirm door; every other surface renders the manifest labels verbatim.
  const notHere = external
    ? capabilityStates.filter((c) => c.state === 'available' && EXTERNAL_CHAT_NOT_HERE[c.key])
    : [];
  const labelFor = (cap) => (external && EXTERNAL_CHAT_LABEL_OVERRIDES[cap.key]) || cap.label;
  const available = capabilityStates.filter((c) => c.state === 'available' && !(external && EXTERNAL_CHAT_NOT_HERE[c.key]));
  const notEnabled = capabilityStates.filter((c) => c.state === 'not_enabled');
  const lines = [];
  lines.push(`OPERATIONAL SELF-KNOWLEDGE (${SELF_KNOWLEDGE_PACK_VERSION}, as of ${asOf}):`);
  lines.push('This block is the authoritative, versioned statement of who you are, which surfaces exist, and what you can and cannot do. It is assembled from Donna\'s capability registry and this client\'s live configuration. Trust it over any general impression of what an AI assistant can do.');
  lines.push('');
  lines.push('IDENTITY:');
  lines.push(`- You are ${name}, the AI bookkeeper that runs the books${business}. You are part of the Donna product.`);
  lines.push('- You are NOT the client portal, NOT a human bookkeeper, and there is no human back office behind you. You run the books yourself within the owner\'s rules, show what you did, and ask the owner only for facts about their business that only they can know.');
  lines.push(`- The person you are talking to is the business owner, in ${here}.`);
  lines.push('');
  lines.push('SURFACES (what exists and what each is for):');
  if (external) {
    lines.push('- This chat: an external chat app (ChatGPT or Claude) the owner connected to Donna. It relays their words to you and shows them your reply; it is a window, not Donna, and it holds none of your context. Quick bookkeeping questions and answers to your open questions belong here. Receipts and document photos cannot arrive through it: for uploads, point the owner to their Donna portal.');
    lines.push('- Confirming a proposal from this chat: when you propose an answer to an open question or a mileage entry, nothing is recorded yet. The owner confirms it right here by saying so (the chat app then calls Donna\'s confirm step, which files it through the same tracked path as the portal) or on the Confirm card in their Donna portal. Never say it is recorded until you are told it was confirmed.');
  } else {
    lines.push(`- This chat: receipts and document photos, quick bookkeeping questions, and answers to your open questions.${surface === 'owner_channel' ? ' It reaches you because the owner connected this channel from their portal.' : ''}`);
  }
  lines.push(`- The Donna client portal (a web app): the owner's workspace. Its section called "What I still need from you" lists every open question and missing document; it also holds uploads, reports, and settings. The portal is a separate surface: you can point the owner to it${portalLinkEnabled ? ', and you can send a direct link with the share_portal_link action' : ', but you cannot send links to it from this chat yet: tell the owner to open their Donna portal'}.`);
  lines.push('- The owner digest (email): a periodic summary of what Donna did and what needs the owner.');
  // The workspace Actions tab (#1095, mounted App.jsx -> FirmOpsConsole ->
  // OutboundOwnerActions) exists for the owner only when an outbound lane is
  // live for this client — the tab renders nothing while the pipeline is dark,
  // so telling the model about an empty surface would invite a wrong pointer.
  if (capabilityStates.some((cap) => cap.state === 'available' && String(cap.key).startsWith('outbound_'))) {
    lines.push('- The workspace Actions tab (in the Donna web app): where outbound work such as invoices, quotes, and payment reminders waits for the owner\'s decision; the owner digest email links straight to it.');
  }
  lines.push('');
  lines.push('WHAT YOU CAN DO (authoritative, from the registry and this client\'s configuration):');
  for (const cap of available) lines.push(`- ${labelFor(cap)}.`);
  if (notHere.length) {
    lines.push('');
    lines.push('EXISTS IN DONNA BUT NOT ON THIS SURFACE (say where it does work; never pretend it works here):');
    for (const cap of notHere) lines.push(`- ${EXTERNAL_CHAT_NOT_HERE[cap.key]}.`);
  }
  if (notEnabled.length) {
    lines.push('');
    lines.push('EXISTS IN DONNA BUT NOT SWITCHED ON FOR THIS CLIENT YET (state this plainly when asked; never pretend the feature does not exist, and never pretend it is already on):');
    for (const cap of notEnabled) lines.push(`- ${cap.label}.`);
  }
  lines.push('');
  lines.push('WHAT YOU CANNOT DO YET (say "I can\'t do that yet", plainly; no invented workarounds, no invented teams):');
  for (const cap of OWNER_CAPABILITY_MANIFEST.cannot_yet) lines.push(`- ${cap.label}.`);
  lines.push('');
  lines.push('HARD RULES:');
  lines.push('- If a capability is not listed above, you do NOT have it: say you can\'t do that yet. Never invent a feature, a surface, a team, or a state you cannot see.');
  lines.push('- Never type out a URL or link yourself. ' + (portalLinkEnabled
    ? 'When the owner asks for the portal, a portal link, or an easier way to see or answer their open questions or missing documents, include an action of type share_portal_link with a short reason. The system resolves and appends the real link to your reply, or an honest instruction when no link can be built. Keep your text short: say the link opens their open items.'
    : 'You cannot send portal links from this chat yet. Tell the owner to open their Donna portal and look at What I still need from you.'));
  return lines.join('\n');
};

// ── The assembler (the one entry point) ──────────────────────────────────────
//
// buildSelfKnowledgeContext({ client, firmId, clientId, clientProfile, surface,
// channel }) → null when SELF_KNOWLEDGE_CONTEXT does not act for this client
// (byte-identical prompt), else the pack: { version, as_of, fingerprint,
// registry_fingerprint, config_snapshot_id, portal_link_enabled, capabilities,
// systemPromptExtra, receipt }. `client` is a pg client handle (the clientConfig
// pattern: this module does no connection management). Soft-fails are the
// caller's job (assembleClientPortalTurn wraps in catch → null).
export const buildSelfKnowledgeContext = async ({
  client,
  firmId,
  clientId,
  clientProfile = null,
  surface = 'client_portal',
  channel = null,
  env = process.env,
  deps = {}
} = {}) => {
  const readConfig = deps.readConfig || readClientConfigSnapshot;
  let snapshot = {};
  try {
    snapshot = (await readConfig(client, { firmId, clientId })) || {};
  } catch {
    snapshot = {};
  }
  if (!clientFlagActs({ flagKey: SELF_KNOWLEDGE_FLAG_KEY, snapshot, envFallback: () => false, env })) {
    return null;
  }
  // The governed action arms on the owner channels and on the external chat
  // surface (ChatGPT / Claude via ask_donna — the owner is NOT in the portal
  // there, and a deep link is exactly the door they need for uploads; the
  // link is resolved deterministically by the runtime, never model-typed).
  // Never on the portal chat: the owner is already IN the portal.
  const portalLinkEnabled = (surface === 'owner_channel' || surface === 'external_chat')
    && clientFlagActs({ flagKey: OWNER_PORTAL_LINK_FLAG_KEY, snapshot, envFallback: () => false, env });
  const capabilityStates = resolveOwnerCapabilityStates({ snapshot, env });
  const assistantName = resolveAssistantName(clientProfile);
  const clientName = String(clientProfile?.name || '').trim() || null;
  const resolved = {
    version: SELF_KNOWLEDGE_PACK_VERSION,
    as_of: OWNER_CAPABILITY_MANIFEST.as_of,
    surface,
    channel: channel || null,
    assistant_name: assistantName,
    client_name: clientName,
    portal_link_enabled: portalLinkEnabled,
    capabilities: capabilityStates
  };
  const fingerprint = selfKnowledgeFingerprint(resolved);
  const registryFingerprint = capabilityRegistryFingerprint();
  const snapshotId = configSnapshotId({ firmId, clientId, snapshot });
  return {
    ...resolved,
    fingerprint,
    registry_fingerprint: registryFingerprint,
    config_snapshot_id: snapshotId,
    systemPromptExtra: renderSelfKnowledgeBlock({
      assistantName,
      clientName,
      surface,
      channel,
      capabilityStates,
      portalLinkEnabled,
      asOf: OWNER_CAPABILITY_MANIFEST.as_of
    }),
    receipt: {
      self_knowledge_version: SELF_KNOWLEDGE_PACK_VERSION,
      self_knowledge_fingerprint: fingerprint,
      registry_fingerprint: registryFingerprint,
      config_snapshot_id: snapshotId,
      portal_link_enabled: portalLinkEnabled
    }
  };
};

// Every referenced registry id must actually be registered — the test calls
// this; a manifest entry naming an unregistered capability is a build error,
// which is what keeps the manifest a registry derivation (§6: capability
// knowledge comes from the registry, never free prose).
export const manifestRegistryViolations = () => {
  const violations = [];
  for (const entry of OWNER_CAPABILITY_MANIFEST.capabilities) {
    for (const id of entry.registry_capabilities || []) {
      if (!isRegisteredCapability(id)) violations.push({ key: entry.key, capability: id });
    }
  }
  return violations;
};
