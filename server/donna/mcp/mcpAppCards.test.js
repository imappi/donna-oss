// MCP Apps cards — pins (mcpAppCards.js + mcpAppCardsHtml.js;
// docs/design-donna-chatgpt-app-build-brief.md §5 slice 4).
//
// Load-bearing properties:
//   - the resource is spec-shaped (SEP-1865 rev 2026-01-26, read from the
//     ext-apps spec source): `ui://` uri, `text/html;profile=mcp-app`, content
//     as `text`, `_meta.ui.csp` with NO domains (no network, nothing
//     external), `prefersBorder`, and Claude's `_meta.ui.domain` ONLY on the
//     Claude surface, computed exactly as Anthropic's docs show;
//   - the tool metadata is the standard `_meta.ui.resourceUri` plus the SDK's
//     legacy flat key, on close_status and ask_donna only;
//   - the bundle is a self-contained View: no external scripts/styles/fonts,
//     no fetch/XHR/WebSocket, no alert/prompt/confirm/clipboard, no innerHTML;
//     it speaks the spec's method names; the ONLY tool it ever calls is
//     confirm_action (the two-call shape, through the host's tools/call);
//   - copy in the bridge register (nothing recorded until you confirm; audit
//     trail; results reach the chat provider), demo banner, no custody
//     slogans, no prices, Donna's voice (no em dashes);
//   - the module is static content: it imports the registry and the html only.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import {
  MCP_TOOLS_WITH_CARDS,
  MCP_UI_CARDS_RESOURCE,
  MCP_UI_CARDS_RESOURCE_URI,
  MCP_UI_CLAUDE_DOMAIN_SUFFIX,
  MCP_UI_CSP,
  MCP_UI_EXTENSION_ID,
  MCP_UI_LEGACY_RESOURCE_URI_META_KEY,
  MCP_UI_MIME_TYPE,
  claudeMcpAppDomainFor,
  hostSupportsMcpUi,
  listMcpUiResources,
  mcpUiResourceMeta,
  mcpUiToolMeta,
  readMcpUiResource
} from './mcpAppCards.js';
import { MCP_APP_CARDS_HTML, MCP_APP_CARDS_PROTOCOL_VERSION } from './mcpAppCardsHtml.js';
import { MCP_SURFACES, MCP_TOOLS, findMcpTool } from './mcpReadSurface.js';

const CUSTODY_SLOGAN = /never leaves?|stays? on (this|your) (machine|office)|100% private|your office/i;
const PRICE = /[$£€]\s?\d|\d+\s?(\/|per\s)(mo|month|year|yr)/i;

// The spec's keys, verbatim.
test('the resource is spec-shaped: ui:// uri, the mcp-app mime type, text content, csp with no domains, prefersBorder', () => {
  assert.equal(MCP_UI_EXTENSION_ID, 'io.modelcontextprotocol/ui');
  assert.equal(MCP_UI_MIME_TYPE, 'text/html;profile=mcp-app');
  assert.equal(MCP_UI_LEGACY_RESOURCE_URI_META_KEY, 'ui/resourceUri');
  assert.match(MCP_UI_CARDS_RESOURCE_URI, /^ui:\/\//);
  assert.equal(MCP_UI_CARDS_RESOURCE.uri, MCP_UI_CARDS_RESOURCE_URI);
  const listed = listMcpUiResources({ surface: MCP_SURFACES.chatgpt_app, serverUrl: 'https://app.donna.test/api/donna/mcp/remote/chatgpt' });
  assert.equal(listed.resources.length, 1, 'exactly one resource');
  const [resource] = listed.resources;
  assert.deepEqual(Object.keys(resource).sort(), ['_meta', 'description', 'mimeType', 'name', 'title', 'uri']);
  assert.equal(resource.mimeType, MCP_UI_MIME_TYPE);
  assert.deepEqual(resource._meta.ui.csp, { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] });
  assert.equal(resource._meta.ui.prefersBorder, false);
  assert.ok(!('domain' in resource._meta.ui), 'no domain on the ChatGPT surface (format not verified from a primary source)');
  for (const list of Object.values(MCP_UI_CSP)) assert.equal(list.length, 0, 'the card declares no external origin');
  const read = readMcpUiResource({ uri: MCP_UI_CARDS_RESOURCE_URI, surface: MCP_SURFACES.chatgpt_app });
  assert.equal(read.contents.length, 1);
  assert.equal(read.contents[0].uri, MCP_UI_CARDS_RESOURCE_URI);
  assert.equal(read.contents[0].mimeType, MCP_UI_MIME_TYPE);
  assert.equal(read.contents[0].text, MCP_APP_CARDS_HTML);
  assert.ok(!('blob' in read.contents[0]));
  assert.deepEqual(read.contents[0]._meta.ui.csp, resource._meta.ui.csp);
  // Any other uri is not this server's.
  assert.equal(readMcpUiResource({ uri: 'ui://donna-books/other' }), null);
  assert.equal(readMcpUiResource({ uri: 'file:///etc/passwd' }), null);
  assert.equal(readMcpUiResource({ uri: '' }), null);
  assert.equal(readMcpUiResource({}), null);
});

test('Claude’s _meta.ui.domain: sha256(server url)[0:32] + .claudemcpcontent.com, exactly the docs’ worked example; only on the Claude surface, only with a url', () => {
  // The worked example in claude.com/docs/connectors/building/mcp-apps/cross-compatibility (fetched 2026-09-15).
  assert.equal(claudeMcpAppDomainFor('https://example.com/mcp'), 'c3d80a4ed901ee05b21755a88273b4a4.claudemcpcontent.com');
  assert.equal(
    claudeMcpAppDomainFor('https://example.com/mcp'),
    `${createHash('sha256').update('https://example.com/mcp').digest('hex').slice(0, 32)}${MCP_UI_CLAUDE_DOMAIN_SUFFIX}`
  );
  // The hash covers the exact string: a trailing slash is a different domain.
  assert.notEqual(claudeMcpAppDomainFor('https://example.com/mcp/'), claudeMcpAppDomainFor('https://example.com/mcp'));
  assert.equal(claudeMcpAppDomainFor(''), null);
  assert.equal(claudeMcpAppDomainFor(null), null);
  const url = 'https://app.donna.test/api/donna/mcp/remote/claude';
  assert.equal(mcpUiResourceMeta({ surface: MCP_SURFACES.claude_remote, serverUrl: url }).domain, claudeMcpAppDomainFor(url));
  assert.ok(!('domain' in mcpUiResourceMeta({ surface: MCP_SURFACES.claude_remote, serverUrl: null })), 'no url, no domain (never a guessed host)');
  assert.ok(!('domain' in mcpUiResourceMeta({ surface: MCP_SURFACES.chatgpt_app, serverUrl: url })));
  assert.ok(!('domain' in mcpUiResourceMeta({ surface: MCP_SURFACES.claude_desktop_mcp, serverUrl: url })), 'a local connector has no url to hash');
  assert.ok(!('domain' in mcpUiResourceMeta({})));
});

test('tool metadata: close_status and ask_donna carry _meta.ui.resourceUri (+ the SDK’s legacy flat key); every other tool carries none', () => {
  assert.deepEqual([...MCP_TOOLS_WITH_CARDS], ['close_status', 'ask_donna']);
  for (const tool of MCP_TOOLS) {
    const meta = mcpUiToolMeta(tool);
    if (MCP_TOOLS_WITH_CARDS.includes(tool.name)) {
      assert.deepEqual(meta, { ui: { resourceUri: MCP_UI_CARDS_RESOURCE_URI }, 'ui/resourceUri': MCP_UI_CARDS_RESOURCE_URI }, tool.name);
      assert.equal(tool.ui.resource_uri, MCP_UI_CARDS_RESOURCE_URI);
    } else {
      assert.equal(meta, null, `${tool.name} has no card`);
      assert.ok(!('ui' in tool), `${tool.name} carries no ui data`);
    }
  }
  assert.deepEqual(mcpUiToolMeta('ask_donna'), mcpUiToolMeta(findMcpTool('ask_donna')));
  assert.equal(mcpUiToolMeta('confirm_action'), null, 'confirm_action renders as text: the card calls it, it has no card of its own');
  assert.equal(mcpUiToolMeta('nope'), null);
});

test('host support is read from the extension capability, with the mime type when the host lists one', () => {
  assert.equal(hostSupportsMcpUi(undefined), false);
  assert.equal(hostSupportsMcpUi({}), false);
  assert.equal(hostSupportsMcpUi({ extensions: {} }), false);
  assert.equal(hostSupportsMcpUi({ extensions: { [MCP_UI_EXTENSION_ID]: {} } }), true);
  assert.equal(hostSupportsMcpUi({ extensions: { [MCP_UI_EXTENSION_ID]: { mimeTypes: [MCP_UI_MIME_TYPE] } } }), true);
  assert.equal(hostSupportsMcpUi({ extensions: { [MCP_UI_EXTENSION_ID]: { mimeTypes: ['text/plain'] } } }), false);
});

// ── The bundle ─────────────────────────────────────────────────────────────

const html = MCP_APP_CARDS_HTML;
const script = html.slice(html.indexOf('<script>'), html.indexOf('</script>'));

test('the bundle is a self-contained HTML5 View: no external resources, no network, no forbidden browser APIs, no innerHTML; declares color-scheme', () => {
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<meta name="color-scheme" content="light dark">/);
  assert.match(html, /<meta name="viewport"/);
  assert.doesNotMatch(html, /<script[^>]+src=/i, 'no external scripts');
  assert.doesNotMatch(html, /<link\b/i, 'no external stylesheets or fonts');
  assert.doesNotMatch(html, /<img\b|<iframe\b|<object\b|<embed\b/i, 'nothing embedded');
  assert.doesNotMatch(html, /https?:\/\//, 'no URL of any kind in the bundle (links come from results, at runtime)');
  assert.doesNotMatch(script, /\bfetch\s*\(|XMLHttpRequest|WebSocket|navigator\.sendBeacon|importScripts/, 'no network');
  assert.doesNotMatch(script, /\balert\s*\(|\bprompt\s*\(|\bconfirm\s*\(|clipboard|localStorage|sessionStorage|indexedDB|document\.cookie/, 'no forbidden or stateful APIs');
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, 'every result value is text, never HTML');
  assert.doesNotMatch(script, /\beval\s*\(|new Function\(/);
  assert.ok(html.length < 32_000, `bundle stays small (${html.length} chars)`);
});

test('the bundle speaks the spec: ui/initialize with appInfo/appCapabilities/protocolVersion, initialized, tool-input/result, host-context-changed, size-changed, teardown; and calls ONLY confirm_action', () => {
  assert.equal(MCP_APP_CARDS_PROTOCOL_VERSION, '2026-01-26');
  for (const method of [
    'ui/initialize', 'ui/notifications/initialized', 'ui/notifications/tool-input', 'ui/notifications/tool-result',
    'ui/notifications/tool-cancelled', 'ui/notifications/host-context-changed', 'ui/notifications/size-changed',
    'ui/resource-teardown', 'ui/open-link', 'ui/update-model-context', 'tools/call'
  ]) {
    assert.ok(script.includes(`'${method}'`), `speaks ${method}`);
  }
  assert.match(script, /request\('ui\/initialize', \{ appInfo: APP, appCapabilities: \{ availableDisplayModes: \['inline'\] \}, protocolVersion: PROTOCOL \}\)/);
  assert.match(script, /window\.parent\.postMessage\(msg, '\*'\)/);
  // The only tool the View ever calls, with exactly the ask_donna-returned ids.
  const toolCalls = [...script.matchAll(/request\('tools\/call', \{ name: '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(toolCalls, ['confirm_action']);
  assert.match(script, /var args = \{ entity_id: sc\.entity && sc\.entity\.id, message_id: sc\.message_id, action_index: action\.index \};/);
  assert.match(script, /request\('tools\/call', \{ name: 'confirm_action', arguments: args \}\)/);
  assert.doesNotMatch(script, /ask_donna|recategorize|post_journal|approve|admin_chat/, 'the card proposes nothing and applies nothing itself');
  // Host → View requests are answered (teardown, ping, tools/list) so the host never hangs.
  assert.match(script, /case 'ui\/resource-teardown': if \(isRequest\) reply\(data\.id, \{\}\)/);
  assert.match(script, /case 'tools\/list': if \(isRequest\) reply\(data\.id, \{ tools: \[\] \}\)/);
  // Theme: data-theme + color-scheme from hostContext, style variables applied to :root.
  assert.match(script, /setAttribute\('data-theme', ctx\.theme\)/);
  assert.match(script, /document\.documentElement\.style\.setProperty\(k, vars\[k\]\)/);
});

test('copy in the bridge register: nothing recorded until you confirm; audit trail; results reach the chat provider; demo banner; no custody slogans, prices or em dashes', () => {
  assert.match(html, /Nothing is recorded until you confirm\./);
  assert.match(html, /Every call is written to Donna\\u2019s audit trail\. Tool results are sent to the chat provider you are using\./);
  assert.match(html, /Demo data\. Nothing here is real and nothing you do here changes any books\./);
  assert.match(html, /Demo proposal\. Confirming here records nothing\./);
  assert.match(html, /Not recorded yet\./);
  assert.match(html, /Recorded\. Your answer is filed and the question is closed\./);
  assert.doesNotMatch(html, CUSTODY_SLOGAN);
  assert.doesNotMatch(html, PRICE);
  assert.doesNotMatch(html, /[—–]/, 'Donna’s voice: no em or en dashes');
  assert.doesNotMatch(html, /human (review|back office)|bookkeeper (review|check)/i);
  // The close card names the two-terminal buckets in the owner's words.
  for (const label of ['Cleared by Donna', 'Posting with the close', 'Waiting on you', 'Needs your decision']) assert.ok(html.includes(label), label);
  // Phone-width safe: 44px tap targets, a two-column fallback under 400px.
  assert.match(html, /min-height: 44px/);
  assert.match(html, /@media \(max-width: 400px\)/);
  // Light/dark via the host's variables with the D palette as fallback, on a transparent body.
  assert.match(html, /var\(--color-text-primary, light-dark\(/);
  assert.match(html, /html, body \{ margin: 0; padding: 0; background: transparent; \}/);
});

test('the module is static content: it imports the html, the registry and node:crypto only', () => {
  const source = readFileSync(new URL('./mcpAppCards.js', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['./mcpAppCardsHtml.js', './mcpReadSurface.js', 'node:crypto']);
  assert.doesNotMatch(source, /withFirmDbClient|invokeMcpTool|firmDb|clientPortalChat|chatApplySpine/);
  const htmlSource = readFileSync(new URL('./mcpAppCardsHtml.js', import.meta.url), 'utf8');
  assert.doesNotMatch(htmlSource, /from '/, 'the html module imports nothing');
});
