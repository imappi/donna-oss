// Values inserted into interface sentences must read in the interface
// language, never as the raw stored English or code. Each surface is rendered
// for real (esbuild bundle + jsdom + react-dom/client, the
// reconciliationAuthorityUi.test.js pattern) in English and in Finnish:
//   1. the upload tray's document-type argument ({documentType});
//   2. the ask-client prompt's {businessUse} and {transaction} phrases;
//   3. stored status codes (a ledger journal's status in the owner's book
//      view, a chat action's status in the firm feed);
//   4. the portal's "loading your books" screen, shown before the client is
//      known, follows the portal's language instead of always English;
//   5. an authority grant with no example vendor name.
// Nothing sent to the server changes: the ask-client draft and the grant
// requests are asserted unchanged.
import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

let dom, directory, root, createRoot, m, requests, responder;
const original = new Map(['window', 'document', 'navigator', 'localStorage', 'HTMLElement', 'MutationObserver', 'IS_REACT_ACT_ENVIRONMENT', 'fetch', 'requestAnimationFrame']
  .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const flush = async () => act(async () => { await new Promise((r) => setTimeout(r, 10)); });
const $ = (id) => document.querySelector(`[data-testid="${id}"]`);
const text = (node) => (node?.textContent || '').replace(/[  ]/g, ' ');
const LOCALES = ['en', 'fi'];

const render = async (element, { locale = null, storage = undefined } = {}) => {
  root = createRoot(document.getElementById('root'));
  const props = { ...(locale ? { initialPreferences: { locale } } : {}), ...(storage ? { storage } : {}) };
  await act(async () => root.render(React.createElement(m.LocaleProvider, props, element)));
  await flush();
};

const memoryStorage = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    values
  };
};

before(async () => {
  dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/firms', pretendToBeVisual: true });
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, localStorage: dom.window.localStorage, HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (cb) => setTimeout(cb, 0) })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  ({ createRoot } = await import('react-dom/client'));
  globalThis.fetch = async (url, init = {}) => {
    const address = new URL(String(url), 'http://localhost');
    requests.push({ url: address, ...init });
    return responder ? responder(address, init) : new Response('{}', { status: 404 });
  };
  directory = await mkdtemp(resolve('.interface-raw-values-test-'));
  await build({
    stdin: {
      contents: [
        "export {LocaleProvider, SurfaceInterfaceLocaleDefault} from './src/i18n/LocaleProvider.jsx';",
        "export {UploadActivityRows} from './src/components/UploadTray.jsx';",
        "export {default as TransactionArtifact} from './src/components/financials/transaction-artifact.jsx';",
        "export {default as Inspection} from './src/components/client-book-inspection.jsx';",
        "export {default as FeedChat} from './src/components/financials/feed-chat.jsx';",
        "export {default as Grants} from './src/components/ReconciliationAuthorityGrants.jsx';",
        "export {default as Held} from './src/components/financials/HeldMatchAuthority.jsx';",
        "export {ClientPortalRestoring, ClientPortalLocaleDefault} from './src/components/ClientPortalRestoring.jsx';"
      ].join('\n'),
      resolveDir: process.cwd()
    },
    outfile: `${directory}/bundle.mjs`, bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', loader: { '.css': 'empty' }, define: { 'import.meta.env': '{}' }, logLevel: 'silent'
  });
  m = await import(pathToFileURL(`${directory}/bundle.mjs`));
});
afterEach(async () => { if (root) await act(async () => root.unmount()); root = null; requests = []; responder = null; document.body.innerHTML = '<div id="root"></div>'; });
after(async () => {
  dom?.window.close();
  for (const [key, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  if (directory) await rm(directory, { recursive: true, force: true });
});
requests = [];

// ── 1. Upload tray: {documentType} ──────────────────────────────────────
const trayRow = (id, extra) => ({ row_id: id, document_id: `doc-${id}`, filename: `${id}.pdf`, upload_state: 'uploaded', parse_status: 'completed', ...extra });
const trayRows = [
  trayRow('guess', { parse_summary: { document_type: 'generic_document', document_type_guess: 'tax_notice' } }),
  trayRow('guess-unknown', { parse_summary: { document_type: 'generic_document', document_type_guess: 'lease addendum' } }),
  trayRow('saved-as', { parse_summary: { document_type: 'contract' } }),
  trayRow('no-parser', { parse_status: 'skipped', document_type: 'payout_statement', parse_summary: { reason: 'extractor_unavailable', document_type: 'payout_statement' } })
];
const TRAY_EXPECTED = {
  en: ['Saved · tax notice', 'Saved · other document', 'Saved as contract', 'Saved — no parser for payout statement yet'],
  fi: ['Tallennettu · Verohallinnon kirje', 'Tallennettu · muu tosite', 'Tallennettu · tyyppi: sopimus', 'Tallennettu — tätä tyyppiä (tilitysraportti) ei vielä osata lukea']
};
for (const locale of LOCALES) {
  test(`upload tray (${locale}): the guessed or stored document type reads in the interface language`, async () => {
    await render(React.createElement(m.UploadActivityRows, { rows: trayRows }), { locale });
    const shown = text(document.body);
    for (const expected of TRAY_EXPECTED[locale]) assert.ok(shown.includes(expected), `${expected} in: ${shown}`);
    for (const raw of ['tax_notice', 'tax notice', 'lease addendum', 'payout_statement', 'payout statement', 'contract']) {
      if (locale === 'fi') assert.ok(!shown.includes(raw), `raw ${raw} leaked into Finnish: ${shown}`);
    }
    assert.ok(!shown.includes('lease addendum'), 'a free-text guess never prints itself');
  });
}

// ── 2. Ask-client prompt: {businessUse} and {transaction} ─────────────────
const askArtifact = (moneyIn) => ({
  type: 'transaction',
  data: {
    previewMode: 'action-cards',
    previewMessages: [],
    previewAppliableActionTypes: [],
    clientId: 'client-synthetic',
    transaction: { id: 'tx-synthetic-1', client_id: 'client-synthetic', transaction_date: '2026-08-18', description: 'CARD PURCHASE NORTHWIND SUPPLIES', money_in: moneyIn ? 250 : 0, money_out: moneyIn ? 0 : 250, account_currency: 'EUR', reconciliation_status: 'unreconciled' },
    match: null,
    previewExplanation: { confidence: 'uncertain', actions: ['ask_client'] }
  }
});
const askPill = () => [...document.querySelectorAll('button[title]')].find((b) => /Hi —|Hei!/.test(b.title));
const ASK_EXPECTED = {
  en: { expense: /confirm whether it’s a business expense\?/, income: /confirm whether it’s business income\?/, subject: /quick check on (the .+ transaction|this transaction) on .+ for / },
  fi: { expense: /Onko kyseessä liiketoiminnan kulu\?/, income: /Onko kyseessä liiketulo\?/, subject: /Tarkistaisin vielä (tapahtuman .+|tämän tapahtuman) \(.+, .+\)\./ }
};
for (const locale of LOCALES) {
  test(`ask-client prompt (${locale}): the business-use and transaction phrases read in the interface language; the draft sent is unchanged`, async () => {
    for (const moneyIn of [false, true]) {
      await render(React.createElement(m.TransactionArtifact, { artifact: askArtifact(moneyIn), setArtifact: () => {} }), { locale });
      const pill = askPill();
      assert.ok(pill, 'the ask-client pill renders');
      assert.match(pill.title, ASK_EXPECTED[locale][moneyIn ? 'income' : 'expense']);
      assert.match(pill.title, ASK_EXPECTED[locale].subject);
      if (locale === 'fi') assert.doesNotMatch(pill.title, /business|transaction| on | for /, `English in the Finnish prompt: ${pill.title}`);
      await act(async () => pill.click());
      await flush();
      const draft = document.querySelector('textarea')?.value || '';
      // The composer draft is what Send transmits: it stays exactly as before.
      assert.match(draft, moneyIn ? /confirm whether it's business income\? Thanks!$/ : /confirm whether it's a business expense\? Thanks!$/);
      await act(async () => root.unmount());
      root = null;
    }
  });
}

// ── 3. Stored status codes ────────────────────────────────────────────────
const journalResponder = (address) => {
  if (address.pathname.endsWith('/ledger/audit-trail')) {
    return new Response(JSON.stringify({ client_id: 'client-synthetic', native_ledger: { journals: [
      { id: 'j-posted', journal_date: '2026-08-04', description: 'Synthetic rent', status: 'posted', lines: [] },
      { id: 'j-draft', journal_date: '2026-08-05', description: 'Synthetic draft', status: 'draft', lines: [] },
      { id: 'j-closed', journal_date: '2026-08-06', description: 'Synthetic closed', status: 'closed', lines: [] },
      { id: 'j-odd', journal_date: '2026-08-07', description: 'Synthetic odd', status: 'something_new', lines: [] }
    ] } }));
  }
  return new Response(JSON.stringify({ verokausi: 'month', period: { key: address.searchParams.get('period') }, review: { status: 'ready' }, alvReturn: { nilReturn: true, boxes: {} } }));
};
const JOURNAL_EXPECTED = {
  en: ['Synthetic rent · Posted', 'Synthetic draft · Draft', 'Synthetic closed · Period closed', 'Synthetic odd · Status not recognised'],
  fi: ['Synthetic rent · Kirjattu', 'Synthetic draft · Luonnos', 'Synthetic closed · Kausi päätetty', 'Synthetic odd · Tila tuntematon']
};
for (const locale of LOCALES) {
  test(`owner book view (${locale}): a journal's stored status reads as a label`, async () => {
    responder = journalResponder;
    await render(React.createElement(m.Inspection, { clientId: 'client-synthetic', databaseMode: true, jurisdiction: 'FI', defaultDate: '2026-08-01' }), { locale });
    const summaries = [...document.querySelectorAll('summary')].map(text).join('\n');
    for (const expected of JOURNAL_EXPECTED[locale]) assert.ok(summaries.includes(expected), `${expected} in: ${summaries}`);
    for (const raw of ['posted', 'draft', 'closed', 'something_new']) assert.ok(!summaries.split(' · ').includes(raw), `raw ${raw}`);
  });
}

const feedMessages = [
  { id: 'feed-user', role: 'user', content: 'Synthetic question', created_at: '2026-09-01T08:10:00Z', payload: {} },
  { id: 'feed-assistant', role: 'assistant', content: 'Synthetic answer', created_at: '2026-09-01T08:11:00Z', payload: { actions: [
    { type: 'apply_category', status: 'superseded', transaction_ids: ['tx-1'], account_name: 'Office supplies', account_code: '6200' },
    { type: 'apply_category', status: 'something_new', transaction_ids: ['tx-2'], account_name: 'Office supplies', account_code: '6200' }
  ] } }
];
const FEED_EXPECTED = { en: ['Superseded by a later reply', 'Not applied'], fi: ['Korvattu myöhemmällä vastauksella', 'Ei käytetty'] };
for (const locale of LOCALES) {
  test(`firm feed (${locale}): a chat action's stored status reads as a label`, async () => {
    await render(React.createElement(m.FeedChat, { clientId: 'client-synthetic', previewMessages: feedMessages, previewAppliableActionTypes: [] }), { locale });
    const shown = text(document.body);
    for (const expected of FEED_EXPECTED[locale]) assert.ok(shown.includes(expected), `${expected} in: ${shown}`);
    assert.ok(!/\bsuperseded\b|something_new/.test(shown), `raw status shown: ${shown}`);
  });
}

// ── 4. The portal loader ──────────────────────────────────────────────────
const PREFS = 'donna.interface_preferences.v1';
test('portal loader: a saved choice on this device is followed before the client is known', async () => {
  const storage = memoryStorage({ [PREFS]: JSON.stringify({ locale: 'fi', numberStyle: 'locale' }) });
  await render(React.createElement(m.ClientPortalRestoring, { storage }), { storage });
  assert.equal(text(document.body).trim(), 'Ladataan kirjanpitoasi…');
});
test('portal loader: with no saved choice it follows the language the portal last opened in on this device', async () => {
  const storage = memoryStorage();
  // A first visit: the portal opens in its owner's language (Finnish) …
  await render(React.createElement(m.ClientPortalLocaleDefault, { locale: 'fi', storage }, React.createElement('p', null, 'portal')), { storage });
  await act(async () => root.unmount());
  root = null;
  // … the next load's loader, shown before the client is known, is Finnish too.
  await render(React.createElement(m.ClientPortalRestoring, { storage }), { storage });
  assert.equal(text(document.body).trim(), 'Ladataan kirjanpitoasi…');
  assert.equal(storage.getItem(PREFS), null, 'the remembered portal language is never saved as the person’s choice');
  await act(async () => root.unmount());
  root = null;
  // An English portal is remembered the same way.
  await render(React.createElement(m.ClientPortalLocaleDefault, { locale: 'en', storage }, React.createElement('p', null, 'portal')), { storage });
  await act(async () => root.unmount());
  root = null;
  await render(React.createElement(m.ClientPortalRestoring, { storage }), { storage });
  assert.equal(text(document.body).trim(), 'Loading your books…');
});
test('portal loader: with nothing known it stays in the registry default (English)', async () => {
  const storage = memoryStorage();
  await render(React.createElement(m.ClientPortalRestoring, { storage }), { storage });
  assert.equal(text(document.body).trim(), 'Loading your books…');
});

// ── 5. Authority grant with no example vendor name ────────────────────────
const unnamedGrant = {
  id: 'g-unnamed', status: 'active', archetype: 'recurring_rent_lease', scope_key: 'merchant:kiinteisto-oy-esimerkki|doc:supplier-bill|acct:7100',
  amount_ceiling: 1500, currency: 'EUR', use_count: 0, correction_count: 0, created_at: '2025-04-20T10:00:00Z', authorized_by_actor_id: null, authorized_by_actor_type: 'accountant', review_after: '2025-10-20T23:59:59Z', example: null
};
const SCOPE_EXPECTED = {
  en: 'Payee not named (vendor key kiinteisto-oy-esimerkki) · Bill · account 7100',
  fi: 'Saajan nimi puuttuu (toimittajan tunniste kiinteisto-oy-esimerkki) · Ostolasku · tili 7100'
};
for (const locale of LOCALES) {
  test(`authority grants (${locale}): a grant with no example vendor says so and shows the stored key as a key`, async () => {
    const api = { list: async () => ({ client_id: 'client-synthetic', delegated_authority_acts: true, grants: [unnamedGrant] }), approve: async () => ({}), suspend: async () => ({}), revoke: async () => ({}) };
    await render(React.createElement(m.Grants, { clientId: 'client-synthetic', api }), { locale });
    assert.equal(text($('grant-scope')), SCOPE_EXPECTED[locale]);
  });
}
