// Donna hosted chat surface — the LISTING copy, pinned
// (docs/design-donna-chatgpt-app-build-brief.md §5 slice 4; the register is
// docs/design-donna-mcp-surface.md §8 item 4 + §10.7, and CLAUDE.md
// "DELIVERY RE-AMENDED … chat surfaces carry the owner verbs" (2026-09-14)).
//
// This module holds the texts the two directory listings are filled from:
// the ChatGPT plugin listing (Plugin Directory) and the Claude connector
// listing (Connectors Directory). They are DATA, pinned by
// mcpListingCopy.test.js the way claudeExtensionCopy.test.js pins the /claude
// page, so the register cannot drift between a form field and the product:
//
//   - sells the CLOSE (the blocking-the-close ask is the headline use case);
//   - states plainly that tool results reach the chat provider (the
//     2026-08-11 bridge register; no custody slogans, which are end-game copy);
//   - names what the surface can and cannot do: read the five views, ask
//     Donna, confirm an answer she proposed; never post, approve, file or
//     send anything else;
//   - per-business consent, off by default; every call receipted in Donna's
//     audit trail;
//   - no prices, no human-review claims (the honest-promise rail:
//     no "human-monitored", "human-reviewed", "appointed professional").
//
// URLs: every listing form wants website, privacy, terms and support URLs.
// They derive from PUBLIC_APP_URL (brief §8 F7: the public production domain
// is still on Kari; nothing is hard-coded). Until it is set the URL fields
// are null and `urls.note` says so — a placeholder is never a made-up host.
//
// The desktop MCPB's own listing (desktop/mcpb/manifest.json) is NOT sourced
// from here: the shim, its manifest and the desktop app are untouched by the
// hosted slices.

import { MCP_SURFACES, MCP_HOSTED_SURFACE_IDS } from './mcpReadSurface.js';

export const MCP_LISTING_NAME = 'Donna';

// One line, the same on both directories.
export const MCP_LISTING_TAGLINE =
  'Ask Donna, the AI bookkeeper, what is blocking the close, answer her open questions, and see what she did overnight.';

// The host names the copy substitutes. `provider` is who receives tool
// results (the data-posture sentence names it plainly).
const HOSTS = Object.freeze({
  chatgpt_app: Object.freeze({ host: 'ChatGPT', provider: 'OpenAI', listing: 'ChatGPT plugin' }),
  claude_remote: Object.freeze({ host: 'Claude', provider: 'Anthropic', listing: 'Claude connector' })
});

export const MCP_LISTING_SURFACE_IDS = MCP_HOSTED_SURFACE_IDS;

// The five read views, in the words the listing uses (one line each).
export const MCP_LISTING_READ_VIEWS = Object.freeze([
  'what is blocking the close, with bucket counts and the questions waiting on you',
  'unresolved transactions and documents, paginated',
  'outstanding document and evidence requests, per business',
  'what Donna did overnight, straight from the audit trail',
  'which businesses you have connected, with a close-status summary'
]);

// What it can do (three verbs) and what it never does (the denial sentence).
export const MCP_LISTING_CAN = Object.freeze([
  'read the five views above',
  'ask Donna about the books, in your own words; she answers from the recorded state with her own model, and the exchange is saved to your Donna thread',
  'confirm an answer she proposed, on your say-so, through the same tracked path as the Confirm button in your Donna portal'
]);

export const MCP_LISTING_CANNOT =
  'It never posts, approves, files or sends anything else. There is no write path from the chat to your ledger beyond that one confirmation, and Donna enforces every gate on her side, not the chat app.';

export const MCP_LISTING_CONSENT =
  'No business is visible until you expose it inside Donna, per business, off by default, under Settings and AI chat access. A business you have not exposed answers exactly like one that does not exist, and you can switch it off again at any time.';

export const MCP_LISTING_AUDIT =
  'Every call is written to Donna’s audit trail before the answer is returned, naming the chat app as the door.';

// The data-posture sentence, per host: says plainly where tool results go.
export const mcpListingDataPosture = (surfaceId) => {
  const h = HOSTS[surfaceId];
  if (!h) return null;
  return `Tool results are sent to ${h.provider}’s ${h.host} model with your ${h.host} account, the same way anything else you put in a ${h.host} conversation is. Exposing a business is a data-routing decision, which is why it is off by default and per business.`;
};

export const mcpListingShortDescription = (surfaceId) => {
  const h = HOSTS[surfaceId];
  if (!h) return null;
  return `Donna runs your books. In ${h.host}, ask what is blocking the close, answer her open questions and see what she did overnight.`;
};

export const mcpListingLongDescription = (surfaceId) => {
  const h = HOSTS[surfaceId];
  if (!h) return null;
  const views = MCP_LISTING_READ_VIEWS.map((line) => `${line[0].toUpperCase()}${line.slice(1)}.`).join(' ');
  return [
    `Donna is the AI bookkeeper that runs your books herself and asks you only for the facts about your business that only you can know. This ${h.listing} puts that conversation where you already are: ask ${h.host} what is blocking the close and Donna answers from the recorded state of your books.`,
    `What you can see: ${views}`,
    `What you can do: ${MCP_LISTING_CAN.map((c) => c).join('; ')}.`,
    MCP_LISTING_CANNOT,
    MCP_LISTING_CONSENT,
    MCP_LISTING_AUDIT,
    mcpListingDataPosture(surfaceId),
    'No Donna account yet? The demo endpoint answers from a clearly labeled sample company, so you can see the experience before connecting anything. Every demo answer says it is demo data and nothing in it changes any books.'
  ].join('\n\n');
};

// The public pages the listing forms ask for. Derived from PUBLIC_APP_URL
// (then APP_BASE_URL, the same precedence resolvePublicOrigin uses); null
// with a note until the domain is set (brief §9.1).
export const MCP_LISTING_URL_PATHS = Object.freeze({
  website: '/',
  documentation: '/claude',
  privacy: '/privacy',
  terms: '/terms',
  support: '/faq',
  security: '/security'
});

export const mcpListingUrls = ({ env = process.env } = {}) => {
  const origin = String(env.PUBLIC_APP_URL || env.APP_BASE_URL || '').trim().replace(/\/+$/, '');
  const urls = Object.fromEntries(
    Object.entries(MCP_LISTING_URL_PATHS).map(([key, path]) => [key, origin ? `${origin}${path}` : null])
  );
  return {
    origin: origin || null,
    ...urls,
    note: origin
      ? null
      : 'PUBLIC_APP_URL is not set: the public production domain is still on Kari (brief §9.1). Every listing URL derives from it; none is hard-coded.'
  };
};

// The whole listing for one hosted surface, as the directory form is filled.
export const mcpListingFor = (surfaceId, { env = process.env } = {}) => {
  const surface = MCP_SURFACES[surfaceId];
  const h = HOSTS[surfaceId];
  if (!surface || !h) return null;
  return {
    surface: surface.id,
    host: h.host,
    listing: h.listing,
    name: MCP_LISTING_NAME,
    tagline: MCP_LISTING_TAGLINE,
    short_description: mcpListingShortDescription(surfaceId),
    long_description: mcpListingLongDescription(surfaceId),
    data_posture: mcpListingDataPosture(surfaceId),
    can: [...MCP_LISTING_CAN],
    cannot: MCP_LISTING_CANNOT,
    consent: MCP_LISTING_CONSENT,
    audit: MCP_LISTING_AUDIT,
    // The registry's write tools are annotated (readOnlyHint false); the
    // directory reviewers check that — the listing says it in words too.
    write_tools_note: 'ask_donna saves a chat turn to your Donna thread; confirm_action applies one proposal you confirmed. Both are annotated as writes so the chat app asks before calling them, per your setting.',
    urls: mcpListingUrls({ env })
  };
};

export const MCP_LISTINGS = Object.freeze(
  Object.fromEntries(MCP_LISTING_SURFACE_IDS.map((id) => [id, HOSTS[id]]))
);
