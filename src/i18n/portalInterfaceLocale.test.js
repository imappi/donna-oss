import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

import { preferredOwnerTemplateLanguage } from '../../server/donna/ownerLanguage.js';
import { portalClientForDefault, portalDefaultInterfaceLocale } from './portalInterfaceLocale.js';

const PREFERENCES_KEY = 'donna.interface_preferences.v1';

// A snapshot client is the stored profile spread at the top level
// (server/donna/db/snapshot.js), so these mirror what the portal receives.
const finnishClient = { id: 'fi-client', companyName: 'Esimerkki Oy', jurisdiction: 'FI' };
const englishChoiceClient = { id: 'fi-en', companyName: 'Esimerkki Oy', jurisdiction: 'FI', language: 'en' };
const finnishChoiceClient = { id: 'gb-fi', companyName: 'Example Ltd', jurisdiction: 'GB', preferredLanguage: 'fi-FI' };
const ukClient = { id: 'gb-client', companyName: 'Example Ltd', jurisdiction: 'GB' };

test('the portal default is the server owner-language resolver, mapped to a ready interface locale', () => {
  assert.equal(portalDefaultInterfaceLocale(finnishClient), 'fi');
  assert.equal(portalDefaultInterfaceLocale(englishChoiceClient), 'en');
  assert.equal(portalDefaultInterfaceLocale(finnishChoiceClient), 'fi');
  assert.equal(portalDefaultInterfaceLocale(ukClient), 'en');
  assert.equal(portalDefaultInterfaceLocale(null), null);
  // One rule: for every client shape the portal answer equals the server's.
  for (const client of [finnishClient, englishChoiceClient, finnishChoiceClient, ukClient, {}]) {
    assert.equal(portalDefaultInterfaceLocale(client), preferredOwnerTemplateLanguage(client));
  }
});

test('the default follows the client the portal renders', () => {
  const clients = [ukClient, finnishClient];
  assert.equal(portalClientForDefault(clients, 'fi-client'), finnishClient);
  assert.equal(portalClientForDefault(clients, null), ukClient);
  assert.equal(portalClientForDefault(clients, 'missing'), null);
  assert.equal(portalClientForDefault(undefined, 'fi-client'), null);
});

test('the mounted portal route proposes the default and the portal mounts a language selector', async () => {
  const app = await readFile(new URL('../App.jsx', import.meta.url), 'utf8');
  assert.match(
    app,
    /<ClientPortalLocaleDefault\s+locale=\{portalDefaultInterfaceLocale\(portalClientForDefault\(firmClients, getClientPortalEntityId\(\)\)\)\}\s*>\s*<ClientPortalGate/
  );
  // The wrapper proposes exactly that default (and remembers it for the next
  // load's loader, src/interfaceRawValues.test.js).
  const wrapper = await readFile(new URL('../components/ClientPortalRestoring.jsx', import.meta.url), 'utf8');
  assert.match(wrapper, /export const ClientPortalLocaleDefault = \(\{ locale, storage = undefined, children \}\) => \{\s*useSurfaceInterfaceLocaleDefault\(locale\);/);
  const portal = await readFile(new URL('../components/donna-client-portal.jsx', import.meta.url), 'utf8');
  assert.match(portal, /onChange=\{\(event\) => setInterfaceLocale\(event\.target\.value\)\}/);
  assert.match(portal, /PRODUCTION_INTERFACE_LOCALES\.map\(\(entry\) => \(\s*<option key=\{entry\.tag\} value=\{entry\.tag\}/);
  assert.match(portal, /\{entry\.productionLabel\}/);
});

let dom, directory, createRoot, mounted, root;
const originals = new Map(['window', 'document', 'navigator', 'localStorage', 'HTMLElement', 'CustomEvent', 'IS_REACT_ACT_ENVIRONMENT']
  .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));

before(async () => {
  dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/client/fi-client', pretendToBeVisual: true });
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement,
    CustomEvent: dom.window.CustomEvent,
    IS_REACT_ACT_ENVIRONMENT: true
  })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  ({ createRoot } = await import('react-dom/client'));
  directory = await mkdtemp(resolve('.portal-locale-test-'));
  await build({
    stdin: {
      contents: `
        import { FormattedMessage } from 'react-intl';
        import { LocaleProvider, SurfaceInterfaceLocaleDefault, useInterfaceLocale } from './src/i18n/LocaleProvider.jsx';
        export const paints = [];
        const Probe = () => {
          const { locale, setInterfaceLocale, formatAmount } = useInterfaceLocale();
          return (
            <div>
              <span data-locale>{locale}</span>
              <span data-message><FormattedMessage id="portal.logOut" /></span>
              <span data-amount>{formatAmount(1234.56, { currency: 'EUR' })}</span>
              <button data-choose-en onClick={() => setInterfaceLocale('en')}>en</button>
              <button data-choose-fi onClick={() => setInterfaceLocale('fi')}>fi</button>
            </div>
          );
        };
        export const Portal = ({ locale }) => (
          <SurfaceInterfaceLocaleDefault locale={locale}><Probe /></SurfaceInterfaceLocaleDefault>
        );
        export const Firm = () => <Probe />;
        export const App = ({ surface, locale }) => (
          <LocaleProvider>{surface === 'portal' ? <Portal locale={locale} /> : <Firm />}</LocaleProvider>
        );
      `,
      resolveDir: process.cwd(),
      loader: 'jsx'
    },
    outfile: `${directory}/mounted.mjs`,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    jsx: 'automatic',
    define: { 'import.meta.env': '{}' },
    logLevel: 'silent'
  });
  mounted = await import(pathToFileURL(`${directory}/mounted.mjs`));
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  root = null;
  window.localStorage.clear();
  document.documentElement.lang = '';
});

after(async () => {
  dom?.window.close();
  for (const [key, value] of originals) {
    if (value) Object.defineProperty(globalThis, key, value);
    else delete globalThis[key];
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

const render = async (props) => {
  root ||= createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(mounted.App, props)));
};
const text = (selector) => document.querySelector(selector)?.textContent;

test('a Finnish owner with no saved choice sees the portal in Finnish, without saving anything', async () => {
  await render({ surface: 'portal', locale: portalDefaultInterfaceLocale(finnishClient) });
  assert.equal(text('[data-locale]'), 'fi');
  assert.equal(text('[data-message]'), 'Kirjaudu ulos');
  assert.equal(text('[data-amount]'), '1 234,56 €');
  assert.equal(document.documentElement.lang, 'fi');
  assert.equal(window.localStorage.getItem(PREFERENCES_KEY), null);
});

test('the firm workspace keeps today’s default and the portal proposal ends when the portal unmounts', async () => {
  await render({ surface: 'firm' });
  assert.equal(text('[data-locale]'), 'en');
  await render({ surface: 'portal', locale: 'fi' });
  assert.equal(text('[data-locale]'), 'fi');
  await render({ surface: 'firm' });
  assert.equal(text('[data-locale]'), 'en');
  assert.equal(document.documentElement.lang, 'en');
});

test('a person’s saved choice always wins over the portal default', async () => {
  window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ locale: 'en', numberStyle: 'locale' }));
  await render({ surface: 'portal', locale: 'fi' });
  assert.equal(text('[data-locale]'), 'en');
  assert.equal(text('[data-message]'), 'Log out');
});

test('choosing a language in the portal is saved and then outranks the default', async () => {
  await render({ surface: 'portal', locale: 'fi' });
  assert.equal(text('[data-locale]'), 'fi');
  await act(async () => document.querySelector('[data-choose-en]').click());
  assert.equal(text('[data-locale]'), 'en');
  assert.deepEqual(JSON.parse(window.localStorage.getItem(PREFERENCES_KEY)), { locale: 'en', numberStyle: 'locale' });
  // A later visit to the same Finnish portal keeps the person's English.
  await act(async () => root.unmount());
  root = null;
  await render({ surface: 'portal', locale: 'fi' });
  assert.equal(text('[data-locale]'), 'en');
});

test('an English-speaking owner of a Finnish company stays in English', async () => {
  await render({ surface: 'portal', locale: portalDefaultInterfaceLocale(englishChoiceClient) });
  assert.equal(text('[data-locale]'), 'en');
});
