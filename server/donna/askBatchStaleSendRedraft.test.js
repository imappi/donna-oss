// A stale MANUAL send keeps the promise it prints — the ratchet.
//
// sendClientAskBatchInDb detects stale anchors under the batch row lock, marks
// the batch superseded, audits ask_batch.superseded_before_send, COMMITS, and
// only then throws ASK_BATCH_STALE. The commit is the point: by the time any
// caller sees the error, the firm's live draft is already gone.
//
// The auto-send path handles that — askAutoSendProducer catches the code and
// calls requestRedraftFn, so one fresh draft is requested. The MANUAL route did
// not: it serialised the error to JSON and stopped. The user clicked Send, read
// "Donna will draft a fresh one" (the writer's own message), and was left with
// no draft and nothing pending — a row resting on nobody, which is the
// two-terminal-states violation, and a user-visible promise the code did not
// keep, which is the honest-copy rail.
//
// This pins the three halves of the fix together, because any one of them alone
// re-opens the hole:
//   1. the writer's message states only what it did (no unconditional promise);
//   2. the manual send route requests the re-draft through the SAME durable
//      ask_draft.requested seam the auto path uses -- not a second mechanism --
//      and reports whether the gate actually enqueued one;
//   3. the surface says which of the two happened.
//
// Source-level assertions: the wiring is what regresses (someone simplifies the
// catch back to a bare JSON.stringify), and the behaviour itself is covered by
// askBatchFreshnessPgLifecycle.test.js against real PostgreSQL.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
// RT-17: firmDb.js is decomposed plane by plane into server/donna/db/<plane>.js
// (the hub re-exports every public symbol). The pinned code lives in whichever
// file its plane has reached, so read the whole surface: every plane file
// (sorted) followed by the hub, hub LAST so a marker naming a symbol finds the
// declaration before the hub's re-export line.
const readFirmDbSurface = () => [
  ...readdirSync(fileURLToPath(new URL('./db/', import.meta.url)))
    .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
    .sort()
    .map((f) => read(`./db/${f}`)),
  read('./firmDb.js')
].join('\n');

test('the stale-send writer promises nothing it does not itself do', () => {
  const source = readFirmDbSurface();
  const message = /const staleAskBatchError[\s\S]{0,400}?new Error\('([^']+)'\)/.exec(source);
  assert.ok(message, 'staleAskBatchError must still construct its message inline');
  assert.doesNotMatch(message[1], /will draft a fresh one/i,
    'the writer only supersedes -- it does not re-draft, so its message must not promise one. '
    + 'The promise belongs to whoever actually requests the re-draft (the send route).');
  assert.match(message[1], /not sent/i, 'it must still say the message was not sent');
});

test('the manual send route requests a re-draft on ASK_BATCH_STALE', () => {
  const source = read('./api.js');
  const route = source.slice(source.indexOf('askBatchSendMatch[1]'));
  const handler = route.slice(0, route.indexOf('/evidence/requests'));

  assert.match(handler, /error\?\.code === 'ASK_BATCH_STALE'/,
    'the catch must single out ASK_BATCH_STALE -- the supersede has already committed');
  assert.match(handler, /onReconcileCompleteRequestAskDraft/,
    'it must heal through the existing ask_draft.requested producer, not a second mechanism');
  assert.match(handler, /source: 'stale_manual_send'/,
    'the request must name its own source so the outbox row is attributable');
  assert.match(handler, /redraft_requested/,
    'the response must report whether a re-draft was actually enqueued -- the gate can decline');
  assert.match(handler, /catch \(redraftError\)/,
    'the re-draft request is best-effort: it must never turn the honest 409 into a 500');
});

test('the auto-send path still heals the same way (the symmetry this fix restores)', () => {
  const source = read('./askAutoSendProducer.js');
  assert.match(source, /error\?\.code === 'ASK_BATCH_STALE'/);
  assert.match(source, /requestRedraftFn/);
});

test('the artifact says which of the two outcomes happened', () => {
  const source = read('../../src/components/financials/ask-batch-artifact.jsx');
  assert.match(source, /ASK_BATCH_STALE/,
    'a stale send is not a plain failure -- the draft is gone either way');
  assert.match(source, /redraft_requested/,
    'the notice must key on what the route reported, not assume a re-draft');
  assert.match(source, /Refresh draft/,
    'the manual refresh stays available as the user\'s own move in both cases');
});
