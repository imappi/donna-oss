// Donna hosted chat surface — the MCP Apps cards as a `ui://` resource
// (docs/design-donna-chatgpt-app-build-brief.md §5 slice 4; the extension is
// SEP-1865 "MCP Apps", revision 2026-01-26, read from the spec source in
// modelcontextprotocol/ext-apps — specification/2026-01-26/apps.mdx and the
// server helpers in src/server/index.ts — never from memory).
//
// What this module is: STATIC CONTENT and the two spec-shaped projections of
// it. It holds no data, no policy and no authorization decision; the remote
// adapter's `resources/list` and `resources/read` reach ONLY the one bundled
// resource below (mcpRemoteAdapter.test.js pins that a read of any other URI
// is refused and that the funnel is never touched by a resource method).
//
// The spec keys, verbatim from the source:
//   - resource: uri `ui://…`, mimeType `text/html;profile=mcp-app`, content
//     as `text`; `_meta.ui.csp` { connectDomains, resourceDomains,
//     frameDomains, baseUriDomains } (empty = the host's restrictive default:
//     no network, no external resources, `frame-src 'none'`), `_meta.ui.
//     prefersBorder`, `_meta.ui.domain` (host-specific; for Claude the docs
//     give sha256(serverUrl).hex.slice(0, 32) + '.claudemcpcontent.com',
//     validated against the URL the connector was registered with — so it
//     is emitted only on the Claude surface and only when the request's own
//     URL is known; ChatGPT's format is not verified from a primary source
//     and is omitted);
//   - tool: `_meta.ui.resourceUri` (the SDK's registerAppTool also writes the
//     deprecated flat `_meta["ui/resourceUri"]` for older hosts; we do the
//     same); visibility defaults to ["model", "app"], which is what the ask
//     card needs to call confirm_action;
//   - host capability: `capabilities.extensions["io.modelcontextprotocol/ui"]`
//     on the initialize request; a host without it gets the text block only.

import { createHash } from 'node:crypto';

import { MCP_APP_CARDS_HTML, MCP_APP_CARDS_VERSION } from './mcpAppCardsHtml.js';
import { MCP_SURFACES, MCP_TOOLS_WITH_CARDS, MCP_UI_CARDS_RESOURCE_URI, findMcpTool } from './mcpReadSurface.js';

export const MCP_UI_EXTENSION_ID = 'io.modelcontextprotocol/ui';
export const MCP_UI_MIME_TYPE = 'text/html;profile=mcp-app';
export const MCP_UI_LEGACY_RESOURCE_URI_META_KEY = 'ui/resourceUri';
export const MCP_UI_CLAUDE_DOMAIN_SUFFIX = '.claudemcpcontent.com';

// The one resource. Both cards live in the one bundle; the View renders the
// close-status card or the ask card from the result's shape.
export const MCP_UI_CARDS_RESOURCE = Object.freeze({
  uri: MCP_UI_CARDS_RESOURCE_URI,
  name: 'donna_cards',
  title: 'Donna cards',
  description: 'Donna’s close-status card and ask card, rendered from the close_status and ask_donna results. The ask card’s Confirm button calls confirm_action through the chat app; nothing is recorded until the owner confirms.',
  version: MCP_APP_CARDS_VERSION
});

// No domains at all: the card makes no network request and loads nothing
// external (the spec's restrictive default), stated explicitly so it is a
// decision, not an omission.
export const MCP_UI_CSP = Object.freeze({
  connectDomains: Object.freeze([]),
  resourceDomains: Object.freeze([]),
  frameDomains: Object.freeze([]),
  baseUriDomains: Object.freeze([])
});

// Claude's dedicated sandbox origin for a REMOTE connector: the first 32 hex
// characters of the SHA-256 of the exact connector URL (scheme, host, path,
// trailing slash included), plus the suffix. Pinned against the worked
// example in Anthropic's docs (https://example.com/mcp).
export const claudeMcpAppDomainFor = (serverUrl) => {
  const url = String(serverUrl || '').trim();
  if (!url) return null;
  return `${createHash('sha256').update(url).digest('hex').slice(0, 32)}${MCP_UI_CLAUDE_DOMAIN_SUFFIX}`;
};

// The resource's `_meta.ui`, per surface. `serverUrl` is the URL the request
// arrived on (origin + MCP path) — the same string the RFC 9728 `resource`
// advertises, so the hash covers exactly what the host registered.
export const mcpUiResourceMeta = ({ surface = null, serverUrl = null } = {}) => {
  const domain = surface?.id === MCP_SURFACES.claude_remote.id ? claudeMcpAppDomainFor(serverUrl) : null;
  return {
    csp: {
      connectDomains: [...MCP_UI_CSP.connectDomains],
      resourceDomains: [...MCP_UI_CSP.resourceDomains],
      frameDomains: [...MCP_UI_CSP.frameDomains],
      baseUriDomains: [...MCP_UI_CSP.baseUriDomains]
    },
    prefersBorder: false,
    ...(domain ? { domain } : {})
  };
};

// resources/list → exactly the one resource.
export const listMcpUiResources = ({ surface = null, serverUrl = null } = {}) => ({
  resources: [
    {
      uri: MCP_UI_CARDS_RESOURCE.uri,
      name: MCP_UI_CARDS_RESOURCE.name,
      title: MCP_UI_CARDS_RESOURCE.title,
      description: MCP_UI_CARDS_RESOURCE.description,
      mimeType: MCP_UI_MIME_TYPE,
      _meta: { ui: mcpUiResourceMeta({ surface, serverUrl }) }
    }
  ]
});

// resources/read → the bundle, or null for any other URI (the caller answers
// "resource not found"; nothing else is ever served through this path).
export const readMcpUiResource = ({ uri, surface = null, serverUrl = null } = {}) => {
  if (String(uri || '') !== MCP_UI_CARDS_RESOURCE.uri) return null;
  return {
    contents: [
      {
        uri: MCP_UI_CARDS_RESOURCE.uri,
        mimeType: MCP_UI_MIME_TYPE,
        text: MCP_APP_CARDS_HTML,
        _meta: { ui: mcpUiResourceMeta({ surface, serverUrl }) }
      }
    ]
  };
};

// A tool's `_meta` for the listing: the standard nested key plus the SDK's
// legacy flat key; null for tools without a card (no `_meta` is emitted).
export const mcpUiToolMeta = (tool) => {
  const entry = typeof tool === 'string' ? findMcpTool(tool) : tool;
  const uri = entry?.ui?.resource_uri;
  if (!uri) return null;
  return {
    ui: { resourceUri: uri },
    [MCP_UI_LEGACY_RESOURCE_URI_META_KEY]: uri
  };
};

// Whether a host declared the extension (modern era: per request in
// _meta clientCapabilities; legacy era: on initialize, which a stateless
// server cannot remember — the adapter lists the card metadata there
// unconditionally, and a host without the extension keeps the text block).
export const hostSupportsMcpUi = (clientCapabilities) => {
  const ext = clientCapabilities?.extensions?.[MCP_UI_EXTENSION_ID];
  if (!ext || typeof ext !== 'object') return false;
  const mimeTypes = Array.isArray(ext.mimeTypes) ? ext.mimeTypes : null;
  return mimeTypes ? mimeTypes.includes(MCP_UI_MIME_TYPE) : true;
};

export { MCP_TOOLS_WITH_CARDS, MCP_UI_CARDS_RESOURCE_URI };
