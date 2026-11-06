// Listing copy pins for the hosted chat surface (mcpListingCopy.js) —
// docs/design-donna-chatgpt-app-build-brief.md §5 slice 4. Same rails the
// /claude page is held to (claudeExtensionCopy.test.js), applied to the two
// directory listings: sells the close; tool results reach the chat provider,
// said plainly; the surface's verbs named (five reads, ask, confirm) and the
// denial sentence; per-business consent off by default; audit receipt; no
// custody slogans, no prices, no human-review claims, no dashes; URLs derive
// from PUBLIC_APP_URL and are null (with a note) until it is set.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  MCP_LISTING_AUDIT,
  MCP_LISTING_CAN,
  MCP_LISTING_CANNOT,
  MCP_LISTING_CONSENT,
  MCP_LISTING_NAME,
  MCP_LISTING_READ_VIEWS,
  MCP_LISTING_SURFACE_IDS,
  MCP_LISTING_TAGLINE,
  MCP_LISTING_URL_PATHS,
  mcpListingDataPosture,
  mcpListingFor,
  mcpListingUrls
} from './mcpListingCopy.js';
import { MCP_HOSTED_SURFACE_IDS, MCP_TOOLS } from './mcpReadSurface.js';

const CUSTODY_SLOGAN = /never leaves?|stays? on (this|your) (machine|office)|100% private|your office/i;
const PRICE = /[$£€]\s?\d|\d+\s?(\/|per\s)(mo|month|year|yr)/i;
const RETIRED_PROMISES = ['human-monitored', 'human-reviewed', 'appointed professional', 'hands off specialist', 'prepares the handoff', 'human back office reviewing'];

const allText = (listing) => [
  listing.tagline, listing.short_description, listing.long_description, listing.data_posture,
  ...listing.can, listing.cannot, listing.consent, listing.audit, listing.write_tools_note
].join('\n');

test('one listing per hosted surface, and only those', () => {
  assert.deepEqual(MCP_LISTING_SURFACE_IDS, MCP_HOSTED_SURFACE_IDS);
  assert.equal(mcpListingFor('claude_desktop_mcp'), null, 'the desktop MCPB keeps its own manifest copy');
  assert.equal(mcpListingFor('nope'), null);
  for (const id of MCP_LISTING_SURFACE_IDS) {
    const listing = mcpListingFor(id, { env: {} });
    assert.equal(listing.name, MCP_LISTING_NAME);
    assert.equal(listing.surface, id);
    assert.ok(listing.host === 'ChatGPT' || listing.host === 'Claude');
  }
});

test('sells the close: the blocking-the-close ask is the headline on both listings', () => {
  assert.match(MCP_LISTING_TAGLINE, /blocking the close/i);
  for (const id of MCP_LISTING_SURFACE_IDS) {
    const listing = mcpListingFor(id, { env: {} });
    assert.match(listing.short_description, /blocking the close/i);
    assert.match(listing.long_description, /blocking the close/i);
  }
});

test('data posture stated plainly, per host: tool results reach the chat provider; no custody slogans', () => {
  assert.match(mcpListingDataPosture('chatgpt_app'), /Tool results are sent to OpenAI’s ChatGPT model/);
  assert.match(mcpListingDataPosture('claude_remote'), /Tool results are sent to Anthropic’s Claude model/);
  assert.equal(mcpListingDataPosture('claude_desktop_mcp'), null);
  for (const id of MCP_LISTING_SURFACE_IDS) {
    const text = allText(mcpListingFor(id, { env: {} }));
    assert.match(text, /data-routing decision/);
    assert.doesNotMatch(text, CUSTODY_SLOGAN);
  }
});

test('names what the surface can and cannot do: the five reads, ask, confirm; never post, approve, file or send anything else', () => {
  assert.equal(MCP_LISTING_READ_VIEWS.length, 5);
  assert.equal(MCP_LISTING_CAN.length, 3);
  assert.match(MCP_LISTING_CAN[0], /five views/);
  assert.match(MCP_LISTING_CAN[1], /ask Donna/i);
  assert.match(MCP_LISTING_CAN[1], /her own model/);
  assert.match(MCP_LISTING_CAN[2], /confirm an answer she proposed/);
  assert.match(MCP_LISTING_CAN[2], /same tracked path as the Confirm button/);
  assert.match(MCP_LISTING_CANNOT, /never posts, approves, files or sends anything else/);
  assert.match(MCP_LISTING_CANNOT, /Donna enforces every gate on her side/);
  // The listing's verb set is the registry's, not a wider promise.
  const registryNames = MCP_TOOLS.map((t) => t.name);
  assert.ok(registryNames.includes('ask_donna') && registryNames.includes('confirm_action'));
  for (const id of MCP_LISTING_SURFACE_IDS) {
    const text = allText(mcpListingFor(id, { env: {} }));
    assert.doesNotMatch(text, /(ChatGPT|Claude|Donna) (can|will) (draft|send|post|file|approve|chase|pay|recategori[sz]e)/i);
  }
});

test('per-business consent off by default, the real menu path, and the audit receipt', () => {
  assert.match(MCP_LISTING_CONSENT, /per business, off by default/);
  assert.match(MCP_LISTING_CONSENT, /Settings and AI chat access/);
  assert.match(MCP_LISTING_CONSENT, /switch it off again at any time/);
  assert.match(MCP_LISTING_AUDIT, /audit trail/);
  assert.match(MCP_LISTING_AUDIT, /naming the chat app as the door/);
});

test('no prices, no human-review claims, no dashes in the listing copy', () => {
  for (const id of MCP_LISTING_SURFACE_IDS) {
    const text = allText(mcpListingFor(id, { env: {} }));
    assert.doesNotMatch(text, PRICE);
    assert.doesNotMatch(text, /[—–]/, 'no em or en dashes');
    for (const retired of RETIRED_PROMISES) {
      assert.equal(text.toLowerCase().includes(retired), false, `listing must not contain "${retired}"`);
    }
    assert.doesNotMatch(text, /bookkeeper (reviews|checks|finishes)/i);
  }
});

test('the demo is named honestly: labeled sample company, nothing changes any books', () => {
  for (const id of MCP_LISTING_SURFACE_IDS) {
    const listing = mcpListingFor(id, { env: {} });
    assert.match(listing.long_description, /clearly labeled sample company/);
    assert.match(listing.long_description, /nothing in it changes any books/);
  }
});

test('URLs derive from PUBLIC_APP_URL (then APP_BASE_URL) and are null with a note until the domain is set', () => {
  const unset = mcpListingUrls({ env: {} });
  assert.equal(unset.origin, null);
  for (const key of Object.keys(MCP_LISTING_URL_PATHS)) assert.equal(unset[key], null, key);
  assert.match(unset.note, /PUBLIC_APP_URL is not set/);
  assert.match(unset.note, /on Kari/);
  const set = mcpListingUrls({ env: { PUBLIC_APP_URL: 'https://app.donna.test/' } });
  assert.equal(set.origin, 'https://app.donna.test');
  assert.equal(set.privacy, 'https://app.donna.test/privacy');
  assert.equal(set.terms, 'https://app.donna.test/terms');
  assert.equal(set.support, 'https://app.donna.test/faq');
  assert.equal(set.documentation, 'https://app.donna.test/claude');
  assert.equal(set.note, null);
  const fallback = mcpListingUrls({ env: { APP_BASE_URL: 'https://base.donna.test' } });
  assert.equal(fallback.website, 'https://base.donna.test/');
  assert.deepEqual(mcpListingFor('chatgpt_app', { env: { PUBLIC_APP_URL: 'https://app.donna.test' } }).urls.privacy, 'https://app.donna.test/privacy');
  // Every path the listing points at is a mounted marketing route.
  const marketing = readFileSync(new URL('../../../src/components/marketing/MarketingPage.jsx', import.meta.url), 'utf8');
  for (const path of ['/claude', '/privacy', '/terms', '/faq', '/security']) {
    assert.match(marketing, new RegExp(`'${path}': '`), `${path} is a mounted marketing route`);
  }
});

test('the module is data: it imports only the registry (never a writer, never the funnel)', () => {
  const source = readFileSync(new URL('./mcpListingCopy.js', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(imports, ['./mcpReadSurface.js']);
  // The desktop manifest is not sourced from here (desktop untouched): no
  // import reaches desktop/, and no writer or funnel symbol is named.
  assert.doesNotMatch(source, /from '[^']*desktop\//);
  assert.doesNotMatch(source, /withFirmDbClient|invokeMcpTool|setClientFlagStage|chatApplySpine/);
});
