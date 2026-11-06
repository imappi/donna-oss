// serve.js registration guard. The Inngest serve handler must register EVERY
// function module's set. The (since deleted, RT-14) bank-line auto-explain
// cron once shipped with its function set defined but never spread into
// serve(), so its hourly sweep never ran in prod (PR #443's v4 migration
// touched the function, but nothing pinned that it was actually served). This
// pins the invariant by object identity — no dependency on Inngest's internal
// id accessor.
//
// CI-only: imports the Inngest function modules, which require the `inngest`
// package (not installed in the sandbox) — same constraint as parseDocument.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';

import { registeredInngestFunctions } from './serve.js';
import { parseDocumentFunctions } from './parseDocument.js';
import { bankLineDispositionFunctions } from './bankLineDisposition.js';
import { documentTerminalDrainFunctions } from './documentTerminalDrain.js';
import { ledgerMirrorVerifyFunctions } from './ledgerMirrorVerify.js';
import { ledgerAutoExportFunctions } from './ledgerAutoExport.js';
import { convergenceClocksFunctions } from './convergenceClocks.js';
import { outboundActionsDueFunctions } from './outboundActionsDue.js';
import { outboundOwnerDigestFunctions } from './outboundOwnerDigest.js';
import { outboundMetricsRollupFunctions } from './outboundMetricsRollup.js';
import { marketingProspectsDueFunctions } from './marketingProspectsDue.js';
import { marketingReplyTriageFunctions } from './marketingReplyTriage.js';
import { llmDecisionRetentionFunctions } from './llmDecisionRetention.js';

test('serve registers every declared Inngest function set — none missing, none extra', () => {
  const expected = [
    ...parseDocumentFunctions,
    ...bankLineDispositionFunctions,
    ...documentTerminalDrainFunctions,
    ...ledgerMirrorVerifyFunctions,
    ...ledgerAutoExportFunctions,
    ...convergenceClocksFunctions,
    ...outboundActionsDueFunctions,
    ...outboundOwnerDigestFunctions,
    ...outboundMetricsRollupFunctions,
    ...marketingProspectsDueFunctions,
    ...marketingReplyTriageFunctions,
    ...llmDecisionRetentionFunctions
  ];
  for (const fn of expected) {
    assert.ok(registeredInngestFunctions.includes(fn), 'every declared function set is spread into serve()');
  }
  assert.equal(
    registeredInngestFunctions.length,
    expected.length,
    'serve registers exactly the declared sets — a new set added to a module but not to serve() fails here'
  );
});

test('the bank-line disposition cron is registered (the strong-model successor must be served)', () => {
  assert.ok(bankLineDispositionFunctions.length >= 1, 'there is a disposition cron function to register');
  for (const fn of bankLineDispositionFunctions) {
    assert.ok(registeredInngestFunctions.includes(fn), 'bankLineDispositionFunctions must be served, not orphaned');
  }
});

test('the document terminal-drain cron is registered (the doc-first backstop must be served)', () => {
  assert.ok(documentTerminalDrainFunctions.length >= 1, 'there is a doc terminal-drain cron function to register');
  for (const fn of documentTerminalDrainFunctions) {
    assert.ok(registeredInngestFunctions.includes(fn), 'documentTerminalDrainFunctions must be served, not orphaned');
  }
});

test('the ledger mirror-verify cron is registered (INT-4c: drift found by schedule, not accident)', () => {
  assert.ok(ledgerMirrorVerifyFunctions.length >= 1, 'there is a mirror-verify cron function to register');
  for (const fn of ledgerMirrorVerifyFunctions) {
    assert.ok(registeredInngestFunctions.includes(fn), 'ledgerMirrorVerifyFunctions must be served, not orphaned');
  }
});

test('the ledger auto-export cron is registered (INT-6: the delegated-authority drain must be served)', () => {
  assert.ok(ledgerAutoExportFunctions.length >= 1, 'there is an auto-export cron function to register');
  for (const fn of ledgerAutoExportFunctions) {
    assert.ok(registeredInngestFunctions.includes(fn), 'ledgerAutoExportFunctions must be served, not orphaned');
  }
});

test('the convergence-clock crons are registered (Q5 daily sample + the twin/re-ask clock ticks)', () => {
  assert.ok(convergenceClocksFunctions.length >= 2, 'both clock cron functions exist to register');
  for (const fn of convergenceClocksFunctions) {
    assert.ok(registeredInngestFunctions.includes(fn), 'convergenceClocksFunctions must be served, not orphaned');
  }
});

test('the outbound-actions-due sweep is registered (M0.5: the one clock every outbound action rides)', () => {
  assert.ok(outboundActionsDueFunctions.length >= 1, 'there is an outbound due-sweep function to register');
  for (const fn of outboundActionsDueFunctions) {
    assert.ok(registeredInngestFunctions.includes(fn), 'outboundActionsDueFunctions must be served, not orphaned');
  }
});

test('the outbound owner-digest cron is registered (M1 G9: the owner surface must actually fire)', () => {
  assert.ok(outboundOwnerDigestFunctions.length >= 1, 'there is an owner-digest cron function to register');
  for (const fn of outboundOwnerDigestFunctions) {
    assert.ok(registeredInngestFunctions.includes(fn), 'outboundOwnerDigestFunctions must be served, not orphaned');
  }
});

test('the outbound metrics rollup cron is registered (M1 §3: instrumentation lands WITH the milestone)', () => {
  assert.ok(outboundMetricsRollupFunctions.length >= 1, 'there is a metrics rollup cron function to register');
  for (const fn of outboundMetricsRollupFunctions) {
    assert.ok(registeredInngestFunctions.includes(fn), 'outboundMetricsRollupFunctions must be served, not orphaned');
  }
});

test('the marketing prospect clock is registered (marketing M2: no non-terminal prospect rests unswept)', () => {
  assert.ok(marketingProspectsDueFunctions.length >= 1, 'there is a prospect-clock cron function to register');
  for (const fn of marketingProspectsDueFunctions) {
    assert.ok(registeredInngestFunctions.includes(fn), 'marketingProspectsDueFunctions must be served, not orphaned');
  }
});

test('the marketing reply-triage sweep is registered (marketing M4: inbound human mail must not rest unjudged)', () => {
  assert.ok(marketingReplyTriageFunctions.length >= 1, 'there is a reply-triage cron function to register');
  for (const fn of marketingReplyTriageFunctions) {
    assert.ok(registeredInngestFunctions.includes(fn), 'marketingReplyTriageFunctions must be served, not orphaned');
  }
});

test('the decision-receipt retention sweep is registered (decision 4: a retention policy that never fires is paper)', () => {
  assert.ok(llmDecisionRetentionFunctions.length >= 1, 'there is a retention sweep cron function to register');
  for (const fn of llmDecisionRetentionFunctions) {
    assert.ok(registeredInngestFunctions.includes(fn), 'llmDecisionRetentionFunctions must be served, not orphaned');
  }
});
