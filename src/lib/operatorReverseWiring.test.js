// The founder recovery executor still exists and remains confirm-gated, but it
// is no longer a client-workspace destination. A dangerous internal recovery
// tool does not earn a permanent row in every venture's everyday menu.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

const consoleSource = read('../components/FirmOpsConsole.jsx');
const workspaceSource = read('../components/FirmClientWorkspace.jsx');
const panelSource = read('../components/operator-reverse-panel.jsx');
const apiSource = read('./firmApi.js');

test('the reverse recovery tool is absent from the owner-facing client workspace', () => {
  assert.doesNotMatch(consoleSource, /\{ key: 'reverse', label: 'Reverse' \}/);
  assert.doesNotMatch(workspaceSource, /import OperatorReversePanel/);
  assert.doesNotMatch(workspaceSource, /activeTab === 'reverse'/);
  assert.doesNotMatch(workspaceSource, /<OperatorReversePanel/);
});

test('the panel renders the plan from the persisted verdict, not a re-derivation', () => {
  assert.match(panelSource, /reverseOperatorApplies/);
  assert.match(panelSource, /buildReversePlanView/);
  assert.match(panelSource, /buildReverseReceiptView/);
  // The PR-14 halves a lying UI would drop: surfaced side effects and the
  // verbatim ledger instruction both have render sites.
  assert.match(panelSource, /entry\.surfaced\.map/);
  assert.match(panelSource, /entry\.instruction/);
  assert.match(panelSource, /LINE_HANGING_WARNING/);
  assert.match(panelSource, /row\.memoryStatusCopy/);
});

test('execute: true is only reachable through the armed-confirm guard', () => {
  // The API helper is the ONLY place the execute flag is spelled, and it only
  // sends it on execute === true.
  assert.match(apiSource, /\.\.\.\(execute === true \? \{ execute: true \} : \{\}\)/);
  assert.equal(apiSource.match(/\{ execute: true \}/g)?.length, 1, 'exactly one code site constructs the execute flag');
  // The panel makes exactly two calls: the dry-run load (no execute) and the
  // execute call, which sits behind canExecuteReverse.
  assert.equal(panelSource.match(/reverseOperatorApplies\(\{/g)?.length, 2);
  assert.match(panelSource, /if \(!canExecuteReverse\(state\)\) return state;/);
  const guardIndex = panelSource.indexOf('if (!canExecuteReverse(state)) return state;');
  const executeIndex = panelSource.indexOf('proposalIds: selected, execute: true');
  assert.ok(guardIndex > -1 && executeIndex > guardIndex, 'the execute call must sit behind the confirm guard');
});

test('the endpoint is the existing executor route, zero new server surface', () => {
  assert.match(apiSource, /'\/api\/donna\/firms\/operator\/reverse'/);
});
