// The firm-side authority surface for material matches, rendered for real
// (esbuild bundle + jsdom + react-dom/client, the finnishCompanyDetails.test.js
// pattern):
//   - the held-match block offers two SEPARATE acts; confirm alone calls the
//     line-level confirm and never reaches a grant route (mints nothing);
//   - "Authorise future matches like this" previews exactly what is granted,
//     nothing pre-ticked, and mints only after the acknowledgement;
//   - the grants view lists proposed grants for approve / decline, shows the
//     auto-suspension cause, says when delegated authority is off, and every
//     action needs a reason;
//   - both are mounted: the grants card renders inside the real
//     FirmClientWorkspace Profile tab; the held block sits in the mounted
//     transaction artifact, fed by the mounted reconcile panel.
import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

import { isMatchHeldForAuthority, grantActionsFor } from './lib/heldMatchAuthority.js';
import { delegationGateProof } from '../server/donna/reconciliationLlmCore.js';

let dom, directory, root, createRoot, Held, Grants, Workspace, LocaleProvider, calls, responder;
const original = new Map(['window', 'document', 'navigator', 'localStorage', 'HTMLElement', 'MutationObserver', 'IS_REACT_ACT_ENVIRONMENT', 'fetch']
  .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const flush = async () => act(async () => { await new Promise((r) => setTimeout(r, 10)); });
const $ = (id) => document.querySelector(`[data-testid="${id}"]`);
const click = async (node) => { await act(async () => node.click()); await flush(); };
const setValue = async (node, value) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(node, value);
    node.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await flush();
};
const render = async (element) => { root = createRoot(document.getElementById('root')); await act(async () => root.render(React.createElement(LocaleProvider, null, element))); await flush(); };

const gates = { A: true, B: true, C: true, D: true, E: false };
const heldMatch = { id: 'm-held', status: 'suggested', bank_transaction_id: 'tx-1', payload: { authorization: { band: 'suggested', reasons: ['above_materiality_ceiling'], gates, model: 'scripted' } } };
const preview = {
  match_id: 'm-held', eligible: true, ineligible_reason: null, delegated_authority_acts: true, archetype: 'recurring_rent_lease', scope_kind: 'merchant',
  scope_key: 'merchant:harbour-lane-properties|doc:supplier-bill|acct:7100', scope: { merchant: 'harbour-lane-properties', document_type: 'supplier-bill', account: '7100' },
  action: 'accept_match', amount: 1200, currency: 'GBP',
  example: { match_id: 'm-held', vendor_name: 'Harbour Lane Properties Ltd', document_type: 'supplier_bill', amount: 1200, currency: 'GBP', date: '2025-04-16' }
};

before(async () => {
  dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/firms', pretendToBeVisual: true });
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, localStorage: dom.window.localStorage, HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  ({ createRoot } = await import('react-dom/client'));
  globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), ...init }); return responder(String(url), init); };
  directory = await mkdtemp(resolve('.recon-authority-ui-test-'));
  await build({
    stdin: { contents: "export {default as Held} from './src/components/financials/HeldMatchAuthority.jsx'; export {default as Grants} from './src/components/ReconciliationAuthorityGrants.jsx'; export {default as Workspace} from './src/components/FirmClientWorkspace.jsx'; export {LocaleProvider} from './src/i18n/LocaleProvider.jsx';", resolveDir: process.cwd() },
    outfile: `${directory}/bundle.mjs`, bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', loader: { '.css': 'empty' }, define: { 'import.meta.env': '{}' }, logLevel: 'silent'
  });
  ({ Held, Grants, Workspace, LocaleProvider } = await import(pathToFileURL(`${directory}/bundle.mjs`)));
});
afterEach(async () => { if (root) await act(async () => root.unmount()); root = null; calls = []; responder = null; document.body.innerHTML = '<div id="root"></div>'; });
after(async () => {
  dom?.window.close();
  for (const [key, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  if (directory) await rm(directory, { recursive: true, force: true });
});
const noNetwork = async (url) => { throw new Error(`unexpected request ${url}`); };

test('lock-step: the UI held predicate agrees with the server gate proof', () => {
  const receipts = [
    heldMatch.payload.authorization,
    { band: 'suggested', reasons: ['above_materiality_ceiling'], gates: { ...gates, D: false } },
    { band: 'suggested', reasons: ['above_materiality_ceiling', 'below_floor'], gates },
    { band: 'suggested', reasons: ['above_materiality_ceiling'] },
    { band: 'auto_matched', reasons: ['delegated_authority'], gates },
    null
  ];
  for (const authorization of receipts) {
    assert.equal(isMatchHeldForAuthority({ status: 'suggested', payload: { authorization } }), delegationGateProof(authorization), JSON.stringify(authorization));
  }
  assert.equal(isMatchHeldForAuthority({ ...heldMatch, status: 'confirmed' }), false);
});

test('two separate acts: confirming the held match calls the line confirm once and touches no grant route', async () => {
  calls = []; responder = noNetwork;
  const confirms = [];
  const minted = [];
  await render(React.createElement(Held, { match: heldMatch, clientId: 'client-a', onConfirmMatch: async () => { confirms.push('m-held'); }, preview: noNetwork, mint: async (b) => { minted.push(b); } }));
  assert.ok($('held-confirm') && $('held-authorise'), 'both actions are offered, separately');
  assert.equal($('grant-preview'), null, 'the grant form is not open by default');
  await click($('held-confirm'));
  assert.deepEqual(confirms, ['m-held']);
  assert.deepEqual(minted, [], 'confirm alone mints nothing');
  assert.equal(calls.filter((c) => c.url.includes('reconciliation-authority')).length, 0);
  assert.match($('held-match-confirmed').textContent, /No standing authority was granted/);
});

test('a match that is not held only by materiality renders no authority block', async () => {
  for (const match of [{ ...heldMatch, status: 'auto_matched' }, { ...heldMatch, payload: { authorization: { band: 'suggested', reasons: ['ambiguous_candidates'], gates: { ...gates, D: false } } } }, null]) {
    await render(React.createElement(Held, { match, clientId: 'client-a', onConfirmMatch: async () => {} }));
    assert.equal($('held-match-authority'), null);
    await act(async () => root.unmount()); root = null;
  }
});

test('authorise future matches: shows exactly what is granted, nothing pre-ticked, mints only after the acknowledgement', async () => {
  const minted = [];
  const confirms = [];
  await render(React.createElement(Held, {
    match: heldMatch, clientId: 'client-a', onConfirmMatch: async () => { confirms.push(1); },
    preview: async ({ clientId, matchId }) => { assert.deepEqual([clientId, matchId], ['client-a', 'm-held']); return { preview }; },
    mint: async (body) => { minted.push(body); return { minted: { id: 'g1' } }; }
  }));
  await click($('held-authorise'));
  const form = $('grant-preview');
  assert.ok(form);
  assert.match($('grant-scope').textContent, /Harbour Lane Properties Ltd/);
  assert.match($('grant-scope').textContent, /7100/);
  assert.match(form.textContent, /Recurring rent or lease/);
  assert.match(form.textContent, /Accept the match only\. Posting authority is not available\./);
  assert.equal($('grant-currency').textContent, 'GBP');
  assert.equal($('grant-ceiling').value, '1200');
  assert.match(form.textContent, /2025-04-16/, 'this match is the example');
  assert.equal($('grant-acknowledge').checked, false, 'nothing is pre-ticked');
  assert.equal($('grant-submit').disabled, true);
  await click($('grant-submit'));
  assert.deepEqual(minted, []);
  await setValue($('grant-ceiling'), '1500');
  await click($('grant-acknowledge'));
  assert.equal($('grant-submit').disabled, false);
  await click($('grant-submit'));
  assert.equal(minted.length, 1);
  assert.deepEqual([minted[0].matchId, minted[0].amountCeiling, minted[0].currency, minted[0].acknowledged], ['m-held', 1500, 'GBP', true]);
  assert.ok(minted[0].reviewAfter > new Date().toISOString(), 'a future review date rides on the grant');
  assert.deepEqual(confirms, [], 'granting never confirms the example');
  assert.match($('grant-granted').textContent, /still waits for its own confirmation/);
});

test('an ineligible match explains why and offers no grant form', async () => {
  for (const [reason, text] of [['not_pre_authorisable', /cannot be pre-authorised/], ['delegated_authority_off', /Delegated authority is off/], ['grant_exists', /already exists \(active\)/]]) {
    await render(React.createElement(Held, { match: heldMatch, clientId: 'client-a', onConfirmMatch: async () => {},
      preview: async () => ({ preview: { ...preview, eligible: false, ineligible_reason: reason, existing_grant: reason === 'grant_exists' ? { id: 'g', status: 'active' } : null } }) }));
    await click($('held-authorise'));
    assert.match($('grant-ineligible').textContent, text);
    assert.equal($('grant-preview'), null);
    await act(async () => root.unmount()); root = null;
  }
});

const grantRow = (extra) => ({
  id: 'g-active', scope_kind: 'merchant', scope_key: preview.scope_key, archetype: 'recurring_rent_lease', action: 'accept_match', amount_ceiling: 1500, currency: 'GBP',
  status: 'active', authorized_by_actor_id: 'partner@ledgerlight.example', authorized_by_actor_type: 'accountant', created_at: '2025-04-20T10:00:00Z', review_after: '2026-01-01T00:00:00Z',
  correction_count: 0, use_count: 2, last_used_at: '2025-07-27T10:00:00Z', last_auto_suspension: null, example: preview.example, inert_reason: null, ...extra
});

test('grants view: proposed grants wait for approve or decline; suspension cause is shown; every action needs a reason', async () => {
  const sent = [];
  const list = { client_id: 'client-a', delegated_authority_acts: true, grants: [
    grantRow({ id: 'g-proposed', status: 'proposed', use_count: 0, last_used_at: null }),
    grantRow({ id: 'g-suspended', status: 'suspended', correction_count: 1, inert_reason: 'suspended', last_auto_suspension: { at: '2025-08-01T00:00:00Z', reason: 'match_rejected', match_id: 'm3' } }),
    grantRow()
  ] };
  const api = {
    list: async () => list,
    approve: async (b) => { sent.push(['approve', b]); return { ...list }; },
    suspend: async (b) => { sent.push(['suspend', b]); return { ...list }; },
    revoke: async (b) => { sent.push(['revoke', b]); return { ...list }; }
  };
  await render(React.createElement(Grants, { clientId: 'client-a', api }));
  const card = $('reconciliation-authority-grants');
  assert.match(card.textContent, /Proposed — waiting for approval/);
  const proposedRow = $('grant-g-proposed');
  assert.ok(proposedRow.querySelector('[data-testid="grant-action-approve"]') && proposedRow.querySelector('[data-testid="grant-action-decline"]'));
  assert.match($('grant-g-suspended').textContent, /Suspended automatically on 2025-08-01.*match rejected/);
  assert.match($('grant-g-suspended').textContent, /1 correction/);
  assert.match($('grant-g-active').textContent, /Granted by partner@ledgerlight\.example on 2025-04-20/);
  assert.doesNotMatch(proposedRow.textContent, /Granted by/, 'a proposed grant has not been granted by anyone yet');
  assert.match($('grant-g-active').textContent, /Used 2 times, last 2025-07-27/);
  assert.match($('grant-g-active').textContent, /Up to 1500 GBP/);
  assert.equal($('grants-flag-off'), null);
  const suspend = $('grant-g-active').querySelector('[data-testid="grant-action-suspend"]');
  assert.equal(suspend.disabled, true, 'no reason, no action');
  await setValue($('grant-g-active').querySelector('[data-testid="grant-reason"]'), 'Tenant moved premises');
  await click(suspend);
  assert.deepEqual(sent, [['suspend', { clientId: 'client-a', grantId: 'g-active', reason: 'Tenant moved premises' }]]);
  await setValue(proposedRow.querySelector('[data-testid="grant-reason"]'), 'Recurring storage rent');
  await click(proposedRow.querySelector('[data-testid="grant-action-approve"]'));
  assert.equal(sent[1][0], 'approve');
  assert.ok(sent[1][1].reviewAfter, 'approval carries a review date');
});

test('grants view: delegated authority off says so and offers no approve or re-activate', async () => {
  const api = { list: async () => ({ client_id: 'client-b', delegated_authority_acts: false, grants: [grantRow({ id: 'g-p', status: 'proposed' }), grantRow({ id: 'g-s', status: 'suspended', inert_reason: 'suspended' })] }) };
  await render(React.createElement(Grants, { clientId: 'client-b', api }));
  assert.match($('grants-flag-off').textContent, /Delegated authority is off for this client/);
  assert.equal(document.querySelector('[data-testid="grant-action-approve"]'), null);
  assert.equal(document.querySelector('[data-testid="grant-action-reactivate"]'), null);
  assert.ok($('grant-g-p').querySelector('[data-testid="grant-action-decline"]'));
  assert.ok($('grant-g-s').querySelector('[data-testid="grant-action-revoke"]'));
  assert.deepEqual(grantActionsFor({ status: 'revoked' }, { delegatedAuthorityActs: false }), []);
});

test('grants view hides itself for a principal the server refuses (403)', async () => {
  const api = { list: async () => { throw Object.assign(new Error('owner'), { status: 403 }); } };
  await render(React.createElement(Grants, { clientId: 'client-a', api }));
  assert.equal($('reconciliation-authority-grants'), null);
});

test('mounted: the real FirmClientWorkspace Profile tab renders the grants card from the grants route', async () => {
  calls = [];
  responder = async (url) => {
    if (url.includes('/reconciliation-authority-grants')) {
      return new Response(JSON.stringify({ client_id: 'client-a', delegated_authority_acts: true, grants: [grantRow()] }), { status: 200 });
    }
    return new Response(JSON.stringify(url.includes('/fiscal-periods') ? { periods: [] } : {}), { status: 200 });
  };
  const profile = { id: 'client-a', companyName: 'Pierpoint Studio Ltd', jurisdiction: 'GB', entityType: 'gb-ltd', profile: { jurisdiction: 'GB' } };
  await render(React.createElement(Workspace, { profile, queue: [], onDatabaseSnapshot: () => {} }));
  // The workspace opens on its default view; switch to Profile the way the
  // entity menu does if the card is not already on screen.
  if (!$('reconciliation-authority-grants')) {
    const profileTab = [...document.querySelectorAll('button')].find((b) => /^Profile$/.test(b.textContent.trim()));
    if (profileTab) await click(profileTab);
  }
  assert.ok($('reconciliation-authority-grants'), 'the grants card is mounted on the Profile tab');
  assert.ok(calls.some((c) => c.url.includes('/api/donna/firms/reconciliation-authority-grants?client_id=client-a')));
  assert.ok($('grant-g-active'));
});

test('mounted: the held block sits in the mounted transaction artifact, fed by the mounted reconcile panel', async () => {
  const artifact = await readFile(new URL('./components/financials/transaction-artifact.jsx', import.meta.url), 'utf8');
  const panel = await readFile(new URL('./components/financials/donna-financials-panel.jsx', import.meta.url), 'utf8');
  assert.match(artifact, /import HeldMatchAuthority from '\.\/HeldMatchAuthority\.jsx';/);
  assert.match(artifact, /<HeldMatchAuthority match=\{match\} clientId=\{[^}]+\} onConfirmMatch=\{data\.onConfirmMatch \|\| null\} \/>/);
  assert.match(panel, /onUpdateReconciliationMatch\(txMatch\.id, \{ status: 'confirmed' \}\)/);
  assert.match(panel, /onConfirmMatch: confirmMatch,/);
});
