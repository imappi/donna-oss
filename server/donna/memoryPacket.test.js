// Slice H — memory packet v1 (receipt-only). The pure half: set arithmetic on
// fact ids (never fuzzy text matching — the #497 guard), plus the per-client
// MEMORY_PACKET_RECEIPTS observe gate (the stageObserves dual, mirroring
// LOOPS_SHADOW_RISK_CONTEXT). The threading half (loader → hooks → receipt)
// is covered in feedChatProposalShadow.test.js.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MEMORY_PACKET_FLAG_KEY,
  buildMemoryPacket,
  memoryPacketObserves,
  selfReportFromAction
} from './memoryPacket.js';

test('buildMemoryPacket: null/undefined facts → null packet (nothing loaded ≠ none known)', () => {
  assert.equal(buildMemoryPacket({ facts: null }), null);
  assert.equal(buildMemoryPacket({}), null);
  assert.equal(buildMemoryPacket(), null);
  assert.equal(buildMemoryPacket({ facts: 'not-an-array' }), null);
});

test('buildMemoryPacket: [] facts → a recorded-empty packet (a REAL "no facts known" signal)', () => {
  assert.deepEqual(buildMemoryPacket({ facts: [] }), {
    facts_available: [],
    facts_used: [],
    facts_conflicted: []
  });
});

test('buildMemoryPacket: available = retrieved ids, deduped, rows or bare strings', () => {
  const packet = buildMemoryPacket({
    facts: [
      { id: 'fact-a', fact: 'AWS is infra spend' },
      { id: 'fact-b' },
      { id: 'fact-a' }, // dup row
      'fact-c',          // bare id
      { fact: 'no id — dropped' },
      { id: '   ' }      // blank id — dropped
    ]
  });
  assert.deepEqual(packet.facts_available, ['fact-a', 'fact-b', 'fact-c']);
  assert.deepEqual(packet.facts_used, []);
  assert.deepEqual(packet.facts_conflicted, []);
});

test('buildMemoryPacket: self-report sanitized to ids ∩ available — a hallucinated id is DROPPED', () => {
  const packet = buildMemoryPacket({
    facts: [{ id: 'fact-a' }, { id: 'fact-b' }, { id: 'fact-c' }],
    selfReport: {
      used: ['fact-a', 'fact-hallucinated', 'fact-a'],
      conflicted: ['fact-b', 'fact-not-retrieved']
    }
  });
  assert.deepEqual(packet.facts_available, ['fact-a', 'fact-b', 'fact-c']);
  assert.deepEqual(packet.facts_used, ['fact-a']);
  assert.deepEqual(packet.facts_conflicted, ['fact-b']);
});

test('buildMemoryPacket: an id claimed both ways counts once, as conflicted (the stronger claim)', () => {
  const packet = buildMemoryPacket({
    facts: [{ id: 'fact-a' }],
    selfReport: { used: ['fact-a'], conflicted: ['fact-a'] }
  });
  assert.deepEqual(packet.facts_used, []);
  assert.deepEqual(packet.facts_conflicted, ['fact-a']);
});

test('selfReportFromAction: nothing emitted today → null; arrays picked defensively when present', () => {
  assert.equal(selfReportFromAction({ type: 'apply_category', account_name: 'Software' }), null);
  assert.equal(selfReportFromAction({}), null);
  assert.equal(selfReportFromAction(), null);
  // non-arrays are no report, not a crash
  assert.equal(selfReportFromAction({ facts_used: 'fact-a' }), null);
  assert.deepEqual(
    selfReportFromAction({ facts_used: ['fact-a'] }),
    { used: ['fact-a'], conflicted: [] }
  );
  assert.deepEqual(
    selfReportFromAction({ facts_conflicted: ['fact-b'] }),
    { used: [], conflicted: ['fact-b'] }
  );
});

// ─── the per-client observe gate ─────────────────────────────────────────────

const cleanEnv = { };

test('memoryPacketObserves: no snapshot row → observe (env fallback true — dormant gate, byte-identical)', () => {
  assert.equal(memoryPacketObserves({ snapshot: {}, env: cleanEnv }), true);
  assert.equal(memoryPacketObserves({ snapshot: null, env: cleanEnv }), true);
});

test('memoryPacketObserves: staged off / dry_run does NOT observe; shadow / canary / auto observes', () => {
  for (const [stage, expected] of [['off', false], ['dry_run', false], ['shadow', true], ['canary', true], ['auto', true]]) {
    assert.equal(
      memoryPacketObserves({ snapshot: { [MEMORY_PACKET_FLAG_KEY]: { stage } }, env: cleanEnv }),
      expected,
      `stage=${stage}`
    );
  }
});

test('memoryPacketObserves: CLIENT_CONFIG_FORCE_DISABLE kills it fleet-wide', () => {
  const env = { CLIENT_CONFIG_FORCE_DISABLE: MEMORY_PACKET_FLAG_KEY };
  assert.equal(memoryPacketObserves({ snapshot: {}, env }), false);
  assert.equal(
    memoryPacketObserves({ snapshot: { [MEMORY_PACKET_FLAG_KEY]: { stage: 'auto' } }, env }),
    false
  );
});
