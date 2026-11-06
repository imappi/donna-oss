// A1 (asks design Phase 0) — "Record client's answer": a firm principal
// records the client's out-of-band answer (phone / firm email / in person)
// down the EXISTING resolve spine with full attribution. These tests pin the
// three things that make the slice honest:
//   1. the source enum is closed (Keep-layer — attribution, not prose);
//   2. the writer stamps WHO recorded and over WHICH channel, on both the
//      response payload and the audit row (operator-safety substrate #1);
//   3. the writer remains available to the existing artifact/chat surface,
//      while Actions stays an index over that same mounted artifact instead
//      of growing a second, bespoke answer-recording panel.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';

import { ANSWER_SOURCES, __normalizeAnswerSource } from './firmDb.js';

// RT-17: firmDb.js is decomposed plane by plane into server/donna/db/<plane>.js
// (the hub re-exports every public symbol). The pinned code lives in whichever
// file its plane has reached, so read the whole surface: every plane file
// (sorted) followed by the hub, hub LAST so a marker naming a symbol finds the
// declaration before the hub's re-export line.
const firmDbSource = [
  ...readdirSync(new URL('./db/', import.meta.url))
    .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
    .sort()
    .map((f) => readFileSync(new URL(`./db/${f}`, import.meta.url), 'utf8')),
  readFileSync(new URL('./firmDb.js', import.meta.url), 'utf8')
].join('\n');
const apiSource = await readFile(new URL('./api.js', import.meta.url), 'utf8');
const panelSource = await readFile(
  new URL('../../src/components/financials/ask-batch-panel.jsx', import.meta.url),
  'utf8'
);
const consoleSource = await readFile(
  new URL('../../src/components/FirmOpsConsole.jsx', import.meta.url),
  'utf8'
);

test('answer sources are a closed set and normalize predictably', () => {
  assert.deepEqual([...ANSWER_SOURCES], ['phone', 'email', 'in_person', 'other']);
  assert.equal(__normalizeAnswerSource('phone'), 'phone');
  assert.equal(__normalizeAnswerSource('  Email '), 'email');
  assert.equal(__normalizeAnswerSource('In Person'), 'in_person');
  assert.equal(__normalizeAnswerSource('in-person'), 'in_person');
  // Unknown channels normalize to null — the resolver treats null as "not a
  // firm-recorded answer", so a typo can never silently claim the firm lane.
  assert.equal(__normalizeAnswerSource('sms'), null);
  assert.equal(__normalizeAnswerSource(''), null);
  assert.equal(__normalizeAnswerSource(null), null);
});

test('lint: the resolver stamps attribution on the response payload and the audit row', () => {
  const resolver = firmDbSource.slice(
    firmDbSource.indexOf('export const resolveClientEvidenceRequestInDb'),
    firmDbSource.indexOf('export const __resumeEvidenceRecodeAfterParseWithClient')
  );
  assert.ok(resolver.length > 0, 'resolver body found');
  assert.ok(
    resolver.includes('answer_source: cleanAnswerSource, answer_recorded_by: actorId'),
    'response payload must carry answer_source + answer_recorded_by together'
  );
  assert.ok(
    /audit_events[\s\S]{0,900}answer_source/.test(resolver),
    'the audit metadata must carry answer_source'
  );
});

test('lint: the resolve route switches lanes on answer_source — topic branch bypassed, firm actor type', () => {
  const route = apiSource.slice(
    apiSource.indexOf('const evidenceResolveMatch'),
    apiSource.indexOf('const evidenceAcceptMatch')
  );
  assert.ok(route.length > 0, 'resolve route body found');
  assert.ok(
    route.includes('__normalizeAnswerSource('),
    'the route must normalize through the same closed set as the writer'
  );
  // DMEM-R1 W1 (INV-14): the portal topic-turn branch accepts a `draft` ask
  // too (minted, not yet sent by a channel — the portal is the one place it can
  // already be answered); the firm lane still bypasses it on answerSource.
  assert.ok(
    route.includes("!answerSource && (evidenceRequest?.status === 'open' || evidenceRequest?.status === 'draft')"),
    'a firm-recorded answer must bypass the portal topic-turn branch — the firm records a COMPLETE answer, not a chat turn'
  );
  assert.ok(
    route.includes("actorType: answerSource ? 'firm' : 'client'") && route.includes("...(answerSource ? { answerSource } : {})"),
    "the firm lane must resolve with actorType 'firm' (substrate #1); the default portal lane stays untouched"
  );
});

test('lint: Actions indexes the mounted Material artifact instead of owning an answer panel', () => {
  assert.doesNotMatch(
    panelSource,
    /resolveClientEvidenceRequest|Record client's answer|answerSource: source|<textarea/,
    'Actions must not recreate the artifact conversation as a bespoke inline answer form'
  );
  assert.match(
    panelSource,
    /onActivate=\{\(\) => activateRow\(item\)\}/,
    'the compact waiting row must activate the shared artifact route'
  );
  // FirmOpsConsole owns the artifact state used by both Material and Actions.
  const mount = consoleSource.slice(
    consoleSource.indexOf('<AskBatchPanel'),
    consoleSource.indexOf('/>', consoleSource.indexOf('<AskBatchPanel'))
  );
  assert.ok(
    mount.includes('evidenceRequests={selectedClientEvidenceRequests}'),
    'the mounted AskBatchPanel must receive the open evidence requests'
  );
  assert.ok(
    mount.includes('onActivateItem={handleHomeFeedActivate}'),
    'the mounted Actions surface must use the console artifact opener'
  );
  assert.ok(
    consoleSource.includes('onArtifact={setArtifact}'),
    'Material and Actions must converge on the same artifact state'
  );
});
