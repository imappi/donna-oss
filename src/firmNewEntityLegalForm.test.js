import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

// FI-14 (UI half): the hosted Finnish birth accepts only an osakeyhtiö
// (server FI_HOSTED_LEGAL_FORM_UNSUPPORTED). The mounted firm intake says so
// before any file is read, and an unsupported or missing form keeps Create
// closed so no create request — and no first upload — is ever sent.
let dom, directory, root, createRoot, FirmNewEntity, LocaleProvider, draft, requests, created;
const originals = new Map(['window', 'document', 'navigator', 'localStorage', 'HTMLElement', 'MutationObserver', 'IS_REACT_ACT_ENVIRONMENT', 'fetch', 'FileReader']
  .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const flush = () => act(async () => { await new Promise((done) => setTimeout(done, 15)); });
const button = (label) => [...document.querySelectorAll('button')].find((node) => node.textContent === label);
const fieldInput = (label) => [...document.querySelectorAll('label.firm-field')]
  .find((node) => node.querySelector('span')?.textContent === label)?.querySelector('input, textarea');
const type = async (node, value) => {
  await act(async () => {
    const proto = node instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, value);
    node.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await flush();
};
const mount = async (dataSource = 'database') => {
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(LocaleProvider, null, React.createElement(FirmNewEntity, {
    dataSource, onCancel() {}, onCreateEntity: async (profile) => { created.push(profile); return profile.id; }
  }))));
  await flush();
};
const readPastedText = async () => {
  await type(fieldInput('Or paste document text'), 'Registry extract for a Finnish company');
  await act(async () => button('Read pasted text').click());
  await flush();
};
before(async () => {
  dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/firms/new', pretendToBeVisual: true });
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    localStorage: dom.window.localStorage, HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true, FileReader: dom.window.FileReader })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method || 'GET' });
    if (String(url).includes('/bizfile/intake-draft')) return new Response(JSON.stringify({ draft }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  ({ createRoot } = await import('react-dom/client'));
  directory = await mkdtemp(resolve('.firm-new-entity-test-'));
  await build({ stdin: { contents: "export { default as FirmNewEntity } from './src/components/FirmNewEntity.jsx'; export { LocaleProvider } from './src/i18n/LocaleProvider.jsx';", resolveDir: process.cwd() },
    outfile: `${directory}/mounted.mjs`, bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic',
    loader: { '.css': 'empty' }, define: { 'import.meta.env': '{}' }, logLevel: 'silent' });
  ({ FirmNewEntity, LocaleProvider } = await import(pathToFileURL(`${directory}/mounted.mjs`)));
});
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  root = null; document.body.innerHTML = '<div id="root"></div>';
});
after(async () => {
  try { dom?.window.close(); } finally {
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

const finnishDraft = (entityType) => ({ company_name: 'Synthetic Kahvila', jurisdiction: 'FI', default_currency: 'EUR',
  entity_type: entityType, document_kind: 'registry_extract', extraction_confidence: 0.9, legal_names: [], other_parties: [] });

test('hosted intake explains the Oy-only Finnish scope before any file is read', async () => {
  requests = []; created = [];
  await mount();
  assert.match(document.querySelector('[data-testid="fi-oy-only"]').textContent, /only for an osakeyhtiö \(Oy\).*toiminimi/);
  assert.equal(requests.length, 0, 'the explanation precedes any upload or read');
});

test('a toiminimi draft is refused in the UI and never reaches company creation; Oy continues', async () => {
  requests = []; created = []; draft = finnishDraft('Toiminimi');
  await mount();
  await readPastedText();
  const create = button('Create entity');
  assert.match(document.querySelector('[data-testid="fi-form-refusal"]').textContent, /other than osakeyhtiö \(Oy\).*nothing has been created/);
  assert.equal(create.disabled, true);
  await act(async () => create.click()); await flush();
  assert.equal(created.length, 0, 'no half-configured book: create is never called');

  await type(fieldInput('Entity type'), '');
  assert.match(document.querySelector('[data-testid="fi-form-refusal"]').textContent, /Set the entity type to Oy/);
  assert.equal(create.disabled, true);

  await type(fieldInput('Entity type'), 'Oy');
  assert.equal(document.querySelector('[data-testid="fi-form-refusal"]'), null);
  assert.equal(create.disabled, false);
  await act(async () => create.click()); await flush();
  assert.equal(created.length, 1);
  assert.equal(created[0].entityType, 'Oy');
});

test('the Finnish rule binds only the hosted birth and only Finland', async () => {
  requests = []; created = []; draft = { ...finnishDraft('Toiminimi') };
  await mount('local');
  assert.equal(document.querySelector('[data-testid="fi-oy-only"]'), null);
  await readPastedText();
  assert.equal(document.querySelector('[data-testid="fi-form-refusal"]'), null);
  await act(async () => root.unmount()); root = null; document.body.innerHTML = '<div id="root"></div>';
  draft = { ...finnishDraft('Ltd'), jurisdiction: 'GB', default_currency: 'GBP' };
  await mount();
  await readPastedText();
  assert.equal(document.querySelector('[data-testid="fi-form-refusal"]'), null);
});
