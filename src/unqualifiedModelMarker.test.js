// The "unqualified local model" marker (2026-11-10, server/donna/modelLanes.js
// SELF_HOSTED_DECISION): rendered through the production LocaleProvider in
// en, fi and ar-AE, only for a decision whose PERSISTED policy_basis is
// self_hosted_unqualified, and wired into every mounted place that shows a
// decision's model (coding suggestion card, ask batch, bank-line disposition
// row, match hero) plus the proposed-rule row. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { UNQUALIFIED_LOCAL_BASIS, isUnqualifiedLocalDecision, policyBasisOf } from './lib/unqualifiedModel.js';
import { proposedRuleSummary } from './lib/ruleProposals.js';
import { summarizeBankLineDispositions } from '../server/donna/bankLineDispositionShape.js';
import { SELF_HOSTED_BASIS } from '../server/donna/modelLanes.js';

test('the predicate reads the persisted basis on the decision or its payload, nothing else', () => {
  assert.equal(UNQUALIFIED_LOCAL_BASIS, SELF_HOSTED_BASIS, 'the browser restates the server basis exactly');
  assert.equal(isUnqualifiedLocalDecision({ policy_basis: SELF_HOSTED_BASIS }), true);
  assert.equal(isUnqualifiedLocalDecision({ payload: { policy_basis: SELF_HOSTED_BASIS } }), true);
  assert.equal(isUnqualifiedLocalDecision(SELF_HOSTED_BASIS), true);
  for (const other of [null, undefined, {}, { policy_basis: 'experiment' }, { model: 'local-test-model' }, 'promotion']) {
    assert.equal(isUnqualifiedLocalDecision(other), false, JSON.stringify(other));
  }
  assert.equal(policyBasisOf({ payload: { policy_basis: 'experiment' } }), 'experiment');
});

test('the marker renders in en, fi and ar-AE for an unqualified decision and renders nothing otherwise', async (t) => {
  const directory = await mkdtemp(resolve('.unqualified-marker-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await build({ stdin: { contents: "export { UnqualifiedModelMarker } from './src/components/shared/UnqualifiedModelMarker.jsx'; export { LocaleProvider } from './src/i18n/LocaleProvider.jsx';", resolveDir: process.cwd() },
    outfile: `${directory}/render.mjs`, bundle: true, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic',
    define: { 'import.meta.env': '{}' }, logLevel: 'silent' });
  const { UnqualifiedModelMarker, LocaleProvider } = await import(pathToFileURL(`${directory}/render.mjs`));
  const render = (locale, props) => renderToStaticMarkup(React.createElement(LocaleProvider, { initialPreferences: { locale } },
    React.createElement(UnqualifiedModelMarker, props)));
  const seat = { policy_basis: SELF_HOSTED_BASIS };
  assert.match(render('en', { decision: seat }), /data-unqualified-model="true"[^>]*>unqualified local model</);
  assert.match(render('fi', { decision: seat }), /arvioimaton paikallinen malli/);
  assert.match(render('ar-AE', { decision: seat }), /نموذج محلي غير مؤهل/);
  assert.match(render('en', { decision: { proposed_by: seat }.proposed_by, messageId: 'mounted.model.proposedByUnqualifiedLocal' }), /proposed by an unqualified local model/);
  for (const decision of [null, { policy_basis: 'experiment' }, { model: 'claude-opus-5-5' }]) {
    assert.doesNotMatch(render('en', { decision }), /unqualified/, 'no seat, no marker: the screen is unchanged');
  }
});

test('the read shapes carry the persisted basis to the screens', () => {
  const rows = [{ target_type: 'transaction', matcher_family: 'bank_line_disposition', target_id: 'tx-1', verdict: 'auto_explained', model: 'local-test-model',
    payload: { disposition: 'auto_explain', policy_basis: SELF_HOSTED_BASIS } },
  { target_type: 'transaction', matcher_family: 'bank_line_disposition', target_id: 'tx-2', verdict: 'auto_explained', model: 'claude-opus-4-8', payload: { disposition: 'auto_explain' } }];
  const map = summarizeBankLineDispositions(rows);
  assert.equal(map.get('tx-1').policy_basis, SELF_HOSTED_BASIS);
  assert.equal(map.get('tx-2').policy_basis, null);
  const summary = proposedRuleSummary({ pattern_text: 'esimerkkikauppa', account_code: '4000',
    payload: { proposed_by: { model: 'local-test-model', policy_basis: SELF_HOSTED_BASIS, policy_id: 'p1' } } });
  assert.equal(isUnqualifiedLocalDecision(summary.proposed_by), true);
  assert.equal(proposedRuleSummary({ pattern_text: 'x', payload: {} }).proposed_by, null);
  const asks = readFileSync(new URL('../server/donna/db/asks.js', import.meta.url), 'utf8');
  assert.match(asks, /policy_basis: row\.payload\?\.policy_basis \|\| null/, 'the ask batch read carries the basis');
});

test('every mounted place that shows a decision\'s model renders the marker for it', () => {
  const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
  assert.match(source('./components/financials/financials-view.jsx'), /<UnqualifiedModelMarker decision=\{suggestion\} \/>/, 'coding suggestion card');
  assert.match(source('./components/financials/financials-view.jsx'), /decision=\{summary\.proposed_by\} messageId="mounted\.model\.proposedByUnqualifiedLocal"/, 'proposed-rule row');
  assert.match(source('./components/financials/ask-batch-artifact.jsx'), /<UnqualifiedModelMarker decision=\{liveDraft\} \/>/, 'ask batch');
  assert.match(source('./components/financials/donna-financials-panel.jsx'), /<UnqualifiedModelMarker decision=\{tx\._tx\?\.bank_line_disposition\}/, 'bank-line disposition row');
  assert.match(source('./components/financials/transaction-artifact.jsx'), /<UnqualifiedModelMarker decision=\{match\}/, 'match hero');
  // The match payload carries the basis: every LLM match family hands it to the one match writer.
  for (const family of ['supplierBill', 'salesInvoice', 'receipt', 'paymentConfirmation', 'payout', 'paymentAccountStatement']) {
    assert.match(source(`../server/donna/${family}ReconciliationLlm.js`), /returnedModel: llmResult\.model \|\| model,\n\s+policyBasis,/, family);
  }
  assert.match(source('../server/donna/reconciliationLlmCore.js'), /\.\.\.\(policyBasis \? \{ policy_basis: policyBasis \} : \{\}\)/);
});
