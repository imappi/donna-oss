// Donna MCPB demo fixtures — pins.
//
// Load-bearing properties:
//   - HONESTY: every demo answer carries demo:true + the demo notice; the
//     sample company is labeled in id and name; the notice says Donna is not
//     running and the data is not real; no custody slogans (2026-08-11 copy
//     register — bridge-era copy never claims books stay on the machine).
//   - SHAPE PARITY: each fixture mirrors the real executor result shape in
//     server/donna/mcp/mcpReadSurface.js, so the demo behaves like the
//     product and a Claude conversation over it transfers 1:1 to real books.
//   - CONTENT, NOT LOGIC: demoResultFor is a lookup — unknown tool ⇒ null,
//     wrong entity ⇒ notFound; it never invents tools or entities.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEMO_ENTITY_ID,
  DEMO_ENTITY_NAME,
  DEMO_NOTICE,
  DEMO_FIXTURES,
  demoResultFor
} from './demoFixtures.mjs';

const TOOL_NAMES = ['entity_list', 'close_status', 'unmatched_items', 'document_status', 'audit_recent'];

// The real executor result shapes (mcpReadSurface.js) — update BOTH sides
// deliberately if a tool's shape ever changes.
const RESULT_KEYS = {
  entity_list: ['entities', 'count'],
  close_status: ['entity', 'totals', 'open_owner_asks', 'blockers', 'blockers_truncated', 'generated_at'],
  unmatched_items: ['entity', 'total', 'page', 'page_size', 'has_more', 'items'],
  document_status: ['entities', 'open_requests'],
  audit_recent: ['events', 'count']
};

const FEED_ITEM_KEYS = [
  'kind', 'disposition', 'blocks_close', 'entity_id', 'transaction_id',
  'document_id', 'date', 'amount', 'currency', 'descriptor', 'counterparty', 'reason'
];

test('demo identity is unmistakable and the notice is honest', () => {
  assert.match(DEMO_ENTITY_ID, /^demo-/);
  assert.match(DEMO_ENTITY_NAME, /\(demo\)/);
  assert.match(DEMO_NOTICE, /nothing here is real/i);
  assert.match(DEMO_NOTICE, /Donna is not running/);
  // DELIBERATE (hosted slice 4, 2026-09-15): the settings label became
  // "AI chat access", but the shim's notice ships INSIDE the packed MCPB
  // (0.2.1) and the desktop is untouched by the hosted slices, so this
  // notice keeps the label the packed bundle was verified with. It is
  // corrected at the next MCPB repack, with the version bump that repack
  // carries — never silently here. The hosted demo notice
  // (mcpRemoteAdapter.js) names the current label.
  assert.match(DEMO_NOTICE, /Settings → Claude access/, 'the shim’s notice names the label of the packed bundle it ships in (see comment)');
  // Copy register: no custody slogans in bridge-era copy.
  assert.doesNotMatch(DEMO_NOTICE, /never leaves?|stays? on (this|your) (machine|office)|100% private/i);
});

test('every tool answers in demo mode with the demo label and the real result shape', () => {
  for (const tool of TOOL_NAMES) {
    const args = tool === 'close_status' || tool === 'unmatched_items' ? { entity_id: DEMO_ENTITY_ID } : {};
    const demo = demoResultFor(tool, args);
    assert.ok(demo?.result, `${tool} has a demo answer`);
    assert.equal(demo.result.demo, true, `${tool} carries demo:true`);
    assert.equal(demo.result.demo_notice, DEMO_NOTICE, `${tool} carries the notice`);
    for (const key of RESULT_KEYS[tool]) {
      assert.ok(key in demo.result, `${tool} demo result carries '${key}' like the real executor`);
    }
  }
});

test('demo feed items carry the compactFeedItem keys and belong to the demo entity', () => {
  const items = [
    ...DEMO_FIXTURES.close_status.blockers,
    ...DEMO_FIXTURES.unmatched_items.items
  ];
  assert.ok(items.length > 0);
  for (const item of items) {
    assert.deepEqual(Object.keys(item).sort(), [...FEED_ITEM_KEYS].sort());
    assert.equal(item.entity_id, DEMO_ENTITY_ID);
  }
});

test('the demo story holds together: totals, blockers, asks, and documents agree', () => {
  const close = DEMO_FIXTURES.close_status;
  assert.equal(close.totals.blocks_close, close.blockers.filter((b) => b.blocks_close).length);
  assert.equal(
    close.open_owner_asks,
    close.blockers.filter((b) => b.kind === 'client_evidence_request').length
  );
  assert.equal(DEMO_FIXTURES.document_status.open_requests, close.open_owner_asks);
  assert.equal(DEMO_FIXTURES.audit_recent.count, DEMO_FIXTURES.audit_recent.events.length);
  assert.equal(DEMO_FIXTURES.entity_list.entities[0].close, close.totals);
});

test('demoResultFor: lookup only — wrong entity ⇒ notFound, unknown tool ⇒ null, pagination mirrors shape', () => {
  assert.deepEqual(demoResultFor('close_status', { entity_id: 'someone-real' }), { notFound: true });
  assert.equal(demoResultFor('ledger_commit', {}), null);
  assert.equal(demoResultFor('transaction_query', {}), null);

  const pageOne = demoResultFor('unmatched_items', { entity_id: DEMO_ENTITY_ID, page: 1, page_size: 3 }).result;
  assert.equal(pageOne.items.length, 3);
  assert.equal(pageOne.has_more, true);
  const pageBeyond = demoResultFor('unmatched_items', { entity_id: DEMO_ENTITY_ID, page: 99 }).result;
  assert.deepEqual(pageBeyond.items, []);
  assert.equal(pageBeyond.has_more, false);
  assert.equal(pageBeyond.total, pageOne.total);
});
