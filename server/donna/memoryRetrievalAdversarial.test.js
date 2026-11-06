// Donna — BizOS Slice 2c-i: memoryRetrieval ADVERSARIAL invariants (§18). The
// deterministic service properties are in memoryRetrieval.test.js; this file is
// the hostile half — the leakage/isolation proofs that make the read path safe:
//
//   - INVARIANT 1: zero cross-tenant / cross-user (a tenant-B or user-Y record
//     never appears in a tenant-A / user-X bundle).
//   - INVARIANT 2: zero erased / dismissed / superseded (non-active states are
//     absent from all consumer-observable output).
//   - INVARIANT 3: zero restricted content in the payload / receipt / stamp /
//     logs / traces / errors — proven with SEEDED CANARY strings + a whole-object
//     serializer (stronger than a field-by-field allowlist: it checks EVERY key),
//     not a substring grep over the source.
//   - HIDDEN-ROW ZERO-CHANGE: adding OR removing an inaccessible row causes zero
//     change in the consumer bundle, receipt, and bundle_fingerprint (the
//     no-existence-leak invariant that killed hidden_excluded_count).
//   - the scope-resolver matrix fails closed (team/project/contact_relationship);
//     role gates CONTENT on firm scopes.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMemoryBundle } from './memoryRetrieval.js';

const firmMemberAcl = {
  isFirmMember: (p) => p?.kind === 'firm_member',
  getAllowedClientIds: async () => null,
  getAssignmentRole: async () => null
};

let seq = 0;
const mem = (over = {}) => {
  seq += 1;
  return {
    memory_id: over.memory_id || `mem-a${seq}`,
    memory_key: over.memory_key || `memk-a${seq}`,
    revision: 1,
    content_hash: over.content_hash || `memh-a${seq}`,
    schema_version: 'memory.v1',
    tenant_id: 'firm-1',
    scope_type: 'legal_entity',
    scope_id: 'client-1',
    lifecycle_owner_type: 'legal_entity',
    lifecycle_owner_id: 'client-1',
    subject_type: 'contact',
    subject_id: 'contact-123',
    kind: 'temporal_marker',
    predicate: 'birthday',
    predicate_class: 'contextual',
    structured_value: { value_type: 'anniversary', value: { month: 3, day: 14 } },
    source_text: 'birthday sentence',
    assertion_origin: 'owner_asserted',
    observed_at: '2026-01-01T00:00:00.000Z',
    recorded_at: '2026-01-01T00:00:00.000Z',
    valid_from: null,
    valid_until: null,
    review_after: null,
    truth_confidence: 'high',
    confidentiality: 'internal',
    personal_data_class: 'personal',
    record_state: 'active',
    epistemic_state: 'verified',
    ...over
  };
};

const firmTC = (over = {}) => ({
  tenant_id: 'firm-1',
  authenticated_principal: { id: 'user-kari', kind: 'firm_member' },
  delegated_principal: { id: 'user-kari', kind: 'firm_member' },
  resolved_audience: { audience_class: 'firm_operator' },
  source_surface: 'transaction_chat',
  consumer_capability_id: 'transactionChatContext',
  source_event_id: 'evt-1',
  occurred_at: '2026-07-13T10:00:00.000Z',
  config_snapshot_id: 'cfg-1',
  ...over
});

const portalTC = (over = {}) => ({
  tenant_id: 'firm-1',
  authenticated_principal: { id: 'owner-1' },
  delegated_principal: { id: 'owner-1' },
  resolved_audience: { audience_class: 'owner' },
  source_surface: 'portal_chat',
  consumer_capability_id: 'clientPortalChatContext',
  source_event_id: 'evt-2',
  occurred_at: '2026-07-13T10:00:00.000Z',
  config_snapshot_id: 'cfg-1',
  ...over
});

const firmReq = (over = {}) => ({ purpose_id: 'transaction_bookkeeping_context', subject_refs: [{ subject_type: 'contact', subject_id: 'contact-123' }], ...over });

const run = ({ trustedContext = firmTC(), request = firmReq(), records = [], legacy = [], acl = firmMemberAcl, sink } = {}) =>
  buildMemoryBundle({
    trustedContext,
    request,
    deps: {
      acl,
      loadMemoryRecords: async () => { if (sink) sink.load = true; return records; },
      loadLegacyViews: async () => legacy
    }
  });

// The consumer-observable surface — everything the caller/model can ever see.
const observable = (out) => ({ bundle: out.bundle, consumer_receipt: out.consumer_receipt });

// ── INVARIANT 1 — cross-tenant / cross-user isolation ────────────────────────

test('a tenant-B record never appears in a tenant-A bundle (cross-tenant isolation)', async () => {
  const mine = mem();
  const other = mem({ memory_id: 'mem-B', memory_key: 'memk-B', content_hash: 'memh-B', tenant_id: 'firm-2', source_text: 'SECRET-B' });
  const out = await run({ records: [mine, other] });
  assert.equal(out.bundle.context_items.length, 1);
  assert.equal(out.bundle.context_items[0].ref.memory_id, mine.memory_id);
  assert.ok(!JSON.stringify(observable(out)).includes('mem-B'));
  assert.ok(!JSON.stringify(observable(out)).includes('SECRET-B'));
  // It exists in the PRIVILEGED record only, as a content-free hidden id.
  assert.ok(out.privileged_record.hidden.some((h) => h.reason_category === 'cross_tenant'));
});

test("another user's user_private memory is never in this owner's bundle", async () => {
  const otherPrivate = mem({
    memory_id: 'mem-U2', memory_key: 'memk-U2', content_hash: 'memh-U2',
    scope_type: 'user_private', lifecycle_owner_type: 'user', lifecycle_owner_id: 'owner-2',
    subject_id: 'owner-2', source_text: 'SECRET-U2'
  });
  const out = await run({
    trustedContext: portalTC(),
    request: firmReq({ purpose_id: 'portal_owner_context', subject_refs: [{ subject_type: 'contact', subject_id: 'owner-2' }] }),
    records: [otherPrivate]
  });
  assert.equal(out.bundle.context_items.length, 0);
  assert.ok(!JSON.stringify(observable(out)).includes('SECRET-U2'));
  assert.ok(out.privileged_record.hidden.some((h) => h.reason_category === 'user_private_not_owner'));
});

// ── INVARIANT 2 — non-active states absent ───────────────────────────────────

for (const state of ['erased', 'dismissed', 'superseded']) {
  test(`a ${state} record is absent from all consumer-observable output`, async () => {
    const dead = mem({ memory_id: `mem-${state}`, memory_key: `memk-${state}`, content_hash: `memh-${state}`, record_state: state, source_text: `SECRET-${state}` });
    const alive = mem();
    const out = await run({ records: [dead, alive] });
    assert.equal(out.bundle.context_items.length, 1);
    assert.ok(!JSON.stringify(observable(out)).includes(`mem-${state}`));
    assert.ok(!JSON.stringify(observable(out)).includes(`SECRET-${state}`));
    // Non-active is hidden (privileged), NOT visible_excluded — its existence must not leak.
    assert.equal(out.consumer_receipt.visible_excluded.length, 0);
    assert.ok(out.privileged_record.hidden.some((h) => h.reason_category === `non_active_${state}`));
  });
}

// ── INVARIANT 3 — canary leak test (seeded secrets + whole-object serializer) ─

test('seeded canary content never appears in payload / receipt / stamp / logs / errors', async () => {
  const CANARY = 'CANARY-3f9a1c7d-do-not-leak';
  // The canary lives ONLY in fields that must never be surfaced:
  //   - the raw source_text of an ALLOWED record (rendered_value is the date, not source_text);
  //   - EVERYTHING on an inaccessible cross-tenant record.
  const allowed = mem({ source_text: `${CANARY} birthday note` });
  const hidden = mem({
    memory_id: 'mem-H', memory_key: 'memk-H', content_hash: 'memh-H', tenant_id: 'firm-9',
    source_text: CANARY, structured_value: { value_type: 'string', value: CANARY }
  });

  const logs = [];
  const errors = [];
  let out;
  try {
    out = await buildMemoryBundle({
      trustedContext: firmTC(),
      request: firmReq(),
      deps: {
        acl: firmMemberAcl,
        // A tracer/logger the service could (but must not) leak into.
        logger: (...a) => logs.push(...a),
        loadMemoryRecords: async () => [allowed, hidden],
        loadLegacyViews: async () => []
      }
    });
  } catch (e) {
    errors.push(String(e && e.stack || e));
  }
  assert.ok(out, 'the service must not throw on hostile content');
  assert.equal(out.bundle.context_items.length, 1);

  // Serialize EVERYTHING the service produced or touched, and assert the canary
  // is nowhere — payload, both receipts, the privileged (content-free) record,
  // captured logs, captured errors.
  const everything = JSON.stringify({
    bundle: out.bundle,
    consumer_receipt: out.consumer_receipt,
    privileged_record: out.privileged_record,
    logs,
    errors
  });
  assert.ok(!everything.includes(CANARY), 'a seeded canary leaked into an externally-visible object');
  // The allowed record still rendered its safe value.
  assert.equal(out.bundle.context_items[0].rendered_value, '--03-14');
});

// ── HIDDEN-ROW ZERO-CHANGE ────────────────────────────────────────────────────

test('adding or removing an INACCESSIBLE row changes nothing observable (bundle, receipt, fingerprint)', async () => {
  const base = [
    mem({ memory_id: 'mem-1', memory_key: 'memk-1', content_hash: 'memh-1' }),
    mem({ memory_id: 'mem-2', memory_key: 'memk-2', content_hash: 'memh-2', predicate: 'renewal_month', structured_value: { value_type: 'local_date', value: '2026-09-01' } })
  ];
  const inaccessible = mem({
    memory_id: 'mem-X', memory_key: 'memk-X', content_hash: 'memh-X', tenant_id: 'firm-99',
    source_text: 'SECRET-X', structured_value: { value_type: 'anniversary', value: { month: 1, day: 1 } }
  });

  const without = await run({ records: base });
  const withRow = await run({ records: [base[0], inaccessible, base[1]] });

  assert.deepEqual(withRow.bundle, without.bundle, 'the bundle changed when an inaccessible row was added');
  assert.deepEqual(withRow.consumer_receipt, without.consumer_receipt, 'the consumer receipt changed');
  assert.equal(withRow.consumer_receipt.bundle_fingerprint, without.consumer_receipt.bundle_fingerprint, 'the fingerprint changed');
  // The privileged record MAY differ (it records the hidden row) — that is the point of the split.
  assert.ok(withRow.privileged_record.hidden.length > without.privileged_record.hidden.length);
});

// ── Scope fail-closed + role gates content ────────────────────────────────────

for (const scope of ['team', 'project', 'contact_relationship']) {
  test(`scope "${scope}" fails closed (unsupported_in_retrieval_v1) — never surfaces`, async () => {
    const r = mem({ memory_id: `mem-${scope}`, memory_key: `memk-${scope}`, content_hash: `memh-${scope}`, scope_type: scope, source_text: `SECRET-${scope}` });
    const out = await run({ records: [r] });
    assert.equal(out.bundle.context_items.length, 0);
    assert.ok(!JSON.stringify(observable(out)).includes(`SECRET-${scope}`));
    assert.ok(out.privileged_record.hidden.some((h) => h.reason_category === 'unsupported_in_retrieval_v1' || h.reason_category === 'scope_not_permitted'));
  });
}

test('a firm viewer never sees restricted content on a firm scope (role gates CONTENT)', async () => {
  const scopedAcl = {
    isFirmMember: () => false,
    getAllowedClientIds: async () => ['client-1'],   // has ACCESS to the client
    getAssignmentRole: async () => 'viewer'          // but only as a viewer
  };
  const restricted = mem({ confidentiality: 'restricted', source_text: 'SECRET-RESTRICTED' });
  const ok = mem({ memory_id: 'mem-ok', memory_key: 'memk-ok', content_hash: 'memh-ok', confidentiality: 'internal' });
  const out = await run({
    trustedContext: firmTC({ authenticated_principal: { id: 'collab-1' }, delegated_principal: { id: 'collab-1' } }),
    records: [restricted, ok],
    acl: scopedAcl
  });
  // The viewer sees the internal record, never the restricted one.
  assert.equal(out.bundle.context_items.length, 1);
  assert.equal(out.bundle.context_items[0].ref.memory_id, 'mem-ok');
  assert.ok(!JSON.stringify(observable(out)).includes('SECRET-RESTRICTED'));
  assert.ok(out.privileged_record.hidden.some((h) => h.reason_category === 'role_restricted_content'));
});

test('a collaborator with NO access to the legal entity gets nothing from it', async () => {
  const noAccessAcl = { isFirmMember: () => false, getAllowedClientIds: async () => ['client-other'], getAssignmentRole: async () => 'viewer' };
  const r = mem({ source_text: 'SECRET-NOACCESS' });
  const out = await run({
    trustedContext: firmTC({ authenticated_principal: { id: 'collab-2' }, delegated_principal: { id: 'collab-2' } }),
    records: [r],
    acl: noAccessAcl
  });
  assert.equal(out.bundle.context_items.length, 0);
  assert.ok(!JSON.stringify(observable(out)).includes('SECRET-NOACCESS'));
  assert.ok(out.privileged_record.hidden.some((h) => h.reason_category === 'legal_entity_no_access'));
});

// ── No externally-observable difference from an ACL infra error (fail closed) ─

test('an ACL resolver infra error fails closed for that record (no leak, no throw)', async () => {
  const throwingAcl = {
    isFirmMember: () => false,
    getAllowedClientIds: async () => { throw new Error('acl db down'); },
    getAssignmentRole: async () => null
  };
  const r = mem({ source_text: 'SECRET-INFRA' });
  const out = await run({
    trustedContext: firmTC({ authenticated_principal: { id: 'collab-3' }, delegated_principal: { id: 'collab-3' } }),
    records: [r],
    acl: throwingAcl
  });
  assert.equal(out.status, 'ok');
  assert.equal(out.bundle.context_items.length, 0);
  assert.ok(!JSON.stringify(observable(out)).includes('SECRET-INFRA'));
  assert.ok(out.privileged_record.hidden.some((h) => h.reason_category === 'acl_resolution_failed'));
});
