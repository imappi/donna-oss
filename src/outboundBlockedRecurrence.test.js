import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { BLOCKED_RECURRENCE_COPY } from '../server/donna/outbound/ownerDigest.js';

test('blocked next recurrence mounts with only an explicit stop control and disappears after decline', async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const values = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    localStorage: dom.window.localStorage, HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true };
  const saved = new Map([...Object.keys(values), 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const directory = await mkdtemp(path.resolve('.sg1a-mounted-'));
  let root;
  t.after(async () => {
    if (root) await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
    await rm(directory, { recursive: true, force: true });
  });
  const surface = { pending: [], failed: [], stale: [], escalated: [], needs_input: [], auto_sent: [], earned: [], owner_replies: [],
    blocked_invoices: [{ id: 'old-invoice', description: 'Invoice SG-OLD', heading: 'Blocked invoices', explanation: 'Singapore tax-invoice rendering is not supported; this invoice cannot be sent', stop_label: 'Don’t send' }],
    blocked_recurrences: [{ id: 'next-period', next_issue_date: '2026-10-24',
      description: 'Blocked next recurrence for Fixture buyer on 2026-10-24: invoice creation is unsupported',
      heading: BLOCKED_RECURRENCE_COPY.heading, explanation: BLOCKED_RECURRENCE_COPY.explanation, stop_label: BLOCKED_RECURRENCE_COPY.stop }] };
  const writes = [];
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === 'POST') {
      writes.push({ url: String(url), body: JSON.parse(init.body) }); if (writes.at(-1).body.action_id === 'next-period') surface.blocked_recurrences = [];
      else surface.blocked_invoices = [];
      return new Response(JSON.stringify({ decided: true, decision: 'decline', status: 'cancelled' }));
    }
    return new Response(JSON.stringify({ surface }));
  };
  await build({ stdin: { contents: "export {default as Surface} from './src/components/outbound-owner-actions.jsx'; export {LocaleProvider} from './src/i18n/LocaleProvider.jsx';", resolveDir: process.cwd() },
    outfile: path.join(directory, 'mounted.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic',
    define: { 'import.meta.env': '{}' }, loader: { '.css': 'empty' }, logLevel: 'silent' });
  const { Surface, LocaleProvider } = await import(pathToFileURL(path.join(directory, 'mounted.mjs')));
  const { createRoot } = await import('react-dom/client');
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(LocaleProvider, null, React.createElement(Surface, { clientId: 'fixture', enabled: true }))));
  assert.match(document.body.textContent, /Blocked recurring invoices/);
  assert.match(document.body.textContent, /2026-10-24/);
  assert.doesNotMatch(document.body.textContent, /Needs your approval|Edit draft|Approve|handled manually/);
  const buttons = [...document.querySelectorAll('button')];
  assert.deepEqual(buttons.map(button => button.textContent), ['Don’t send', 'Stop blocked recurrence']);
  await act(async () => buttons[1].click());
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.action_id, 'next-period');
  assert.equal(writes[0].body.decision, 'decline');
  assert.doesNotMatch(document.body.textContent, /Blocked next recurrence/);
  await act(async () => document.querySelector('button').click());
  assert.equal(writes[1].body.action_id, 'old-invoice');
  assert.equal(writes[1].body.decision, 'decline');
  assert.doesNotMatch(document.body.textContent, /Blocked invoices/);
});
