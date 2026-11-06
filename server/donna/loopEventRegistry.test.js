// Donna Loops — the event-registry STATIC invariant (audit §G "event completeness").
//
// The teeth: scan the REAL loop source for every queue event a producer enqueues
// (an enqueueOutbox / insertLoopEvent call) and assert each one is registered as
// consumed-or-parked. A new producer that forgets to wire (or explicitly park) a
// consumer fails here — the proposal_rerun.requested-class orphan the audit flagged
// can never recur silently. Consumed-ness is verified against the RUNTIME truth
// (the dispatcher's handler set, the LoopDefinition trigger matchers, the inbox
// worker's switch) — not a hand-copied list — so registry drift is caught too.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  LOOP_EVENT_REGISTRY, registeredEventTypes, parkedEventTypes, isParked, isProduced
} from './loopEventRegistry.js';
import { DISPATCH_HANDLED_EVENT_TYPES } from './loopOutboxDispatcher.js';
import { LOOP_DEFINITIONS } from './loopGoalRegistry.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// ── source scan: the set of queue event types actually PRODUCED in loop source ──
// We read the source (not the registry) so a new, unregistered producer is caught.
// Scoped to the two queue producers' CALL sites; the append-only case-event stream
// (appendCaseEvent) routes nowhere and is intentionally not scanned.
const PRODUCER_FNS = ['enqueueOutbox', 'insertLoopEvent'];

const walkJsFiles = (dir) => {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) { out.push(...walkJsFiles(full)); continue; }
    if (name.endsWith('.test.js')) continue;
    if (name.endsWith('.js')) out.push(full);
  }
  return out;
};

// The balanced (...) argument text starting at the '(' index — paren/brace/string
// aware, so an `eventType:` is attributed to THIS call, never a neighbouring one.
const balancedCallArg = (text, openParenIdx) => {
  let depth = 0;
  let inStr = null;
  for (let i = openParenIdx; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') { inStr = ch; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') { depth -= 1; if (depth === 0) return text.slice(openParenIdx, i + 1); }
  }
  return text.slice(openParenIdx);
};

const scanProducedEventTypes = () => {
  const found = new Map(); // type -> [relative file paths]
  for (const file of walkJsFiles(HERE)) {
    const text = readFileSync(file, 'utf8');
    for (const fn of PRODUCER_FNS) {
      const re = new RegExp(`\\b${fn}\\s*\\(`, 'g');
      let m;
      while ((m = re.exec(text))) {
        const openIdx = m.index + m[0].length - 1; // index of '('
        const arg = balancedCallArg(text, openIdx);
        const em = /eventType:\s*['"]([^'"]+)['"]/.exec(arg);
        if (!em) continue; // dynamic eventType (none in the loop layer today)
        const type = em[1];
        if (!found.has(type)) found.set(type, []);
        found.get(type).push(file.slice(HERE.length + 1));
      }
    }
  }
  return found;
};

// The set of inbox event types something actually consumes: every LoopDefinition
// trigger matcher ∪ every inbox-worker special-case the registry declares.
const inboxConsumedTypes = () => {
  const s = new Set();
  for (const def of Object.values(LOOP_DEFINITIONS)) {
    for (const t of def.triggerMatchers || []) s.add(t);
  }
  for (const t of registeredEventTypes()) {
    if (LOOP_EVENT_REGISTRY[t].consumer?.via === 'inbox_worker_special_case') s.add(t);
  }
  return s;
};

// ── the invariants ─────────────────────────────────────────────────────────────

test('every queue event produced in the loop source is registered', () => {
  const produced = scanProducedEventTypes();
  assert.ok(produced.size >= 6, `source scan found only ${produced.size} produced types — scanner likely broken`);
  const unregistered = [...produced.keys()].filter((t) => !LOOP_EVENT_REGISTRY[t]);
  assert.deepEqual(
    unregistered, [],
    `unregistered loop event producer(s): ${unregistered.join(', ')} — add to loopEventRegistry.js as consumed or parked`
  );
});

test('registry producedBy matches what the source actually produces (no stale claims)', () => {
  const produced = scanProducedEventTypes();
  for (const type of registeredEventTypes()) {
    assert.equal(
      produced.has(type), isProduced(type),
      `${type}: registry says produced=${isProduced(type)} but source scan found produced=${produced.has(type)}`
    );
  }
});

test('every produced event is consumed or explicitly parked', () => {
  const inbox = inboxConsumedTypes();
  for (const type of registeredEventTypes().filter(isProduced)) {
    if (isParked(type)) continue;
    const entry = LOOP_EVENT_REGISTRY[type];
    if (entry.channel === 'outbox') {
      // An outbox event is consumed either by the dispatcher (DISPATCH_HANDLED_EVENT_TYPES)
      // OR by a dedicated outbox worker (consumer.via='outbox_worker', e.g. the PR 1b
      // reconciliation fresh-evaluation consumer, which the dispatcher deliberately does
      // NOT handle). A worker-consumed type is verified to name a real worker that
      // references it by the 'outbox-worker' cross-check below.
      const consumedByDispatcher = DISPATCH_HANDLED_EVENT_TYPES.includes(type);
      const consumedByWorker = entry.consumer?.via === 'outbox_worker';
      assert.ok(
        consumedByDispatcher || consumedByWorker,
        `${type} is produced to the outbox but has no dispatcher handler / outbox worker and is not parked`
      );
    } else {
      assert.ok(
        inbox.has(type),
        `${type} is produced to the inbox but has no consumer (loop trigger / worker case) and is not parked`
      );
    }
  }
});

test('dispatcher handler set and the registry agree (no drift)', () => {
  for (const type of DISPATCH_HANDLED_EVENT_TYPES) {
    const entry = LOOP_EVENT_REGISTRY[type];
    assert.ok(entry, `dispatcher handles ${type} but it is not registered`);
    assert.equal(entry.channel, 'outbox', `${type} is dispatched, so it must be registered as an outbox event`);
    assert.ok(!isParked(type), `${type} is dispatched — it cannot also be parked`);
  }
});

test('every LoopDefinition trigger subscription is a registered inbox event', () => {
  for (const def of Object.values(LOOP_DEFINITIONS)) {
    for (const t of def.triggerMatchers || []) {
      const entry = LOOP_EVENT_REGISTRY[t];
      assert.ok(entry, `LoopDefinition ${def.key} subscribes to ${t} but it is not registered`);
      assert.equal(entry.channel, 'inbox', `${t} is a loop trigger; it must be registered as an inbox event`);
    }
  }
});

test('every parked event declares owner, monitoring, and activation', () => {
  const parked = parkedEventTypes();
  assert.ok(parked.includes('proposal_rerun.requested'), 'expected proposal_rerun.requested to be a parked event');
  for (const type of parked) {
    const p = LOOP_EVENT_REGISTRY[type].parked;
    for (const field of ['owner', 'monitoring', 'activation']) {
      assert.ok(
        typeof p[field] === 'string' && p[field].trim().length > 0,
        `parked event ${type} is missing a non-empty "${field}"`
      );
    }
  }
});

test('inbox-worker special-cases and the registry agree (no bypass)', () => {
  // Cross-check the registry's inbox_worker_special_case declarations against the
  // worker source: a new switch case can't bypass the registry, and a stale
  // registry declaration can't outlive its case.
  const workerSrc = readFileSync(join(HERE, 'loopInboxWorker.js'), 'utf8');
  const declared = registeredEventTypes().filter(
    (t) => LOOP_EVENT_REGISTRY[t].consumer?.via === 'inbox_worker_special_case'
  );
  for (const t of declared) {
    assert.ok(workerSrc.includes(`case '${t}'`), `registry says ${t} is a worker special-case but loopInboxWorker has no \`case '${t}'\``);
  }
  const cases = [...workerSrc.matchAll(/case\s+'([a-z_]+\.[a-z_]+)'\s*:/g)].map((m) => m[1]);
  for (const t of cases) {
    assert.ok(declared.includes(t), `loopInboxWorker special-cases ${t} but the registry does not declare it inbox_worker_special_case`);
  }
});

test('outbox-worker consumers name a real worker that drains the type (no bypass)', () => {
  // Cross-check every consumer.via='outbox_worker' declaration against the named
  // worker source: the worker file must exist AND reference the event type, so the
  // registry can't claim an outbox worker that doesn't actually consume the row (the
  // PR 1b reconciliation.evaluation_requested class). Mirrors the inbox-worker
  // special-case cross-check.
  const workerConsumed = registeredEventTypes().filter(
    (t) => LOOP_EVENT_REGISTRY[t].consumer?.via === 'outbox_worker'
  );
  for (const t of workerConsumed) {
    const entry = LOOP_EVENT_REGISTRY[t];
    assert.equal(entry.channel, 'outbox', `${t} is consumed by an outbox worker; it must be an outbox event`);
    assert.ok(!isParked(t), `${t} is consumed by an outbox worker — it cannot also be parked`);
    const worker = entry.consumer?.worker;
    assert.ok(worker, `${t} declares consumer.via='outbox_worker' but no consumer.worker file`);
    let src;
    try {
      src = readFileSync(join(HERE, worker), 'utf8');
    } catch {
      assert.fail(`${t} names outbox worker ${worker} but that file does not exist`);
    }
    assert.ok(
      src.includes(`'${t}'`) || src.includes(`"${t}"`),
      `outbox worker ${worker} does not reference the event type ${t} it claims to consume`
    );
  }
});

test('subscribedNotYetProduced entries are exactly the unproduced inbox subscriptions', () => {
  for (const type of registeredEventTypes()) {
    const entry = LOOP_EVENT_REGISTRY[type];
    if (entry.subscribedNotYetProduced) {
      assert.equal(isProduced(type), false, `${type} is flagged subscribedNotYetProduced but has producers`);
      assert.equal(entry.channel, 'inbox', `${type} subscribedNotYetProduced must be an inbox trigger`);
    }
  }
});
