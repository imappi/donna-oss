// MCP consent screen — wiring + copy-register pins (design-donna-mcp-surface.md
// §8 item 1). Source-scanning, like the other *Wiring tests: the "wire UI into
// the mounted surface" rail is machine-checked here so the consent screen can
// never quietly become a ghost, and the 2026-08-11 copy register (bridge copy
// admits book content reaches the model provider; custody slogans are end-game
// copy) is pinned on the one screen where drifting would matter most.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sidebarSource = readFileSync(new URL('../components/settings/SettingsSidebar.jsx', import.meta.url), 'utf8');
const panelSource = readFileSync(new URL('../components/settings/SettingsPanel.jsx', import.meta.url), 'utf8');
const mountedCatalogSource = readFileSync(new URL('../i18n/catalogs/mountedSurfaces.en.js', import.meta.url), 'utf8');
const firmApiSource = readFileSync(new URL('./firmApi.js', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../../server/donna/api.js', import.meta.url), 'utf8');
const consentSource = readFileSync(new URL('../../server/donna/mcp/mcpConsent.js', import.meta.url), 'utf8');
const vercelConfig = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'));

test('the AI chat access section is declared in the settings rail AND rendered by the mounted panel', () => {
  // Rail: SettingsSidebar's SETTINGS_SECTIONS carries the section id (kept as
  // 'claude' for route stability; the LABEL generalized in slice 4).
  assert.match(sidebarSource, /\{ id: 'claude', labelId: 'mounted\.settings\.section\.claude' \}/);
  assert.match(mountedCatalogSource, /'mounted\.settings\.section\.claude': 'AI chat access'/);
  // Pane: the mounted SettingsPanel (imported by App.jsx as default) renders it.
  assert.match(panelSource, /\{section === 'claude' && <AiChatAccessSection firm=\{firm\} \/>\}/);
  assert.match(panelSource, /claude: \['mounted\.settings\.section\.claude'/);
});

test('one consent covers every chat surface: the screen lists the surfaces the server returns, never a client-side copy', () => {
  assert.match(panelSource, /surfaces: Array\.isArray\(data\?\.surfaces\) \? data\.surfaces : \[\]/);
  assert.match(panelSource, /message\('mounted\.settings\.claude\.whatDesc', \{ surfaces: surfacesText \}\)/);
  assert.match(mountedCatalogSource, /'mounted\.settings\.claude\.whatDesc': 'One consent covers every chat surface: \{surfaces\}\./);
  assert.match(consentSource, /surfaces: MCP_CONSENT_SURFACES/);
  assert.match(consentSource, /Object\.values\(MCP_SURFACES\)/);
  // The flag is unchanged: MCP_ENTITY_EXPOSE, per entity, canary rows only.
  assert.match(consentSource, /MCP_EXPOSE_STAGE = 'canary'/);
  assert.match(consentSource, /MCP_REVOKE_STAGE = 'off'/);
  assert.doesNotMatch(panelSource, /Claude Desktop \(local extension\)|ChatGPT \(Donna app\)/, 'surface labels come from the server');
});

test('the consent screen is wired to the real routes, not local state', () => {
  assert.match(panelSource, /fetchMcpExposure\(\{ firmId: firm\?\.id/);
  assert.match(panelSource, /setMcpEntityExposure\(\{ firmId: firm\?\.id, clientId: entity\.id, expose: next \}\)/);
  assert.match(firmApiSource, /\/api\/donna\/firms\/mcp-exposure/);
});

test('the firms handler mounts /mcp-exposure and routes the write through mcpConsent (one config path)', () => {
  assert.match(apiSource, /requestUrl\.pathname === '\/mcp-exposure' && req\.method === 'GET'/);
  assert.match(apiSource, /requestUrl\.pathname === '\/mcp-exposure' && req\.method === 'POST'/);
  assert.match(apiSource, /from '\.\/mcp\/mcpConsent\.js'/);
  assert.match(apiSource, /setEntityExposure\(\{/);
  // The consent module writes through the ONE audited config-plane writer.
  assert.match(consentSource, /setClientFlagStage/);
  assert.match(consentSource, /actorType: 'owner'/);
});

test('the /firms route carries its vercel rewrite (the dev-works/prod-404s guard, by hand for /firms)', () => {
  const sources = new Set((vercelConfig.rewrites || []).map((rule) => rule.source));
  assert.ok(sources.has('/api/donna/firms/mcp-exposure'), 'vercel.json rewrites /api/donna/firms/mcp-exposure');
});

test('copy register: the screen states plainly that tool results reach whichever chat provider the owner connects, and carries no custody slogan', () => {
  const sectionStart = panelSource.indexOf('const AiChatAccessSection');
  const sectionEnd = panelSource.indexOf('const DataSection');
  assert.ok(sectionStart >= 0 && sectionEnd > sectionStart);
  const section = `${panelSource.slice(sectionStart, sectionEnd)}\n${mountedCatalogSource}`;
  // The honest data-posture statement (design doc §2, reframed for hosting
  // in §10.11): whichever provider the owner connects, named.
  assert.match(section, /sent to whichever chat provider you connect/);
  assert.match(section, /Anthropic('|&apos;|’)s cloud for Claude, OpenAI('|&apos;|’)s for ChatGPT/);
  // The pinned consent clauses (§5, extended by §10.11): the three verbs
  // named, the denial sentence, off by default, revocable.
  assert.match(section, /ask Donna about them, and confirm an answer she proposed/);
  assert.match(section, /same tracked path as the Confirm button/);
  assert.match(section, /cannot post, approve, file or send anything else/);
  assert.match(section, /off by default/);
  assert.match(section, /Turn a venture off anytime/);
  // The visible copy no longer names one host as the only door.
  assert.doesNotMatch(mountedCatalogSource, /'mounted\.settings\.claude\.[a-zA-Z]+': '[^']*Claude Desktop/);
  assert.doesNotMatch(mountedCatalogSource, /Visible to Claude\./);
  // Custody slogans are END-GAME copy (2026-08-11 register) — not on this screen.
  assert.doesNotMatch(section, /never leaves? your (office|machine)/i);
});
