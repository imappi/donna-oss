// Donna — BizOS Slice 2b: memoriesDb writer tests. Load-bearing properties:
//   - dark behind MEMORY_MODEL_V2 (flag off ⇒ no mutation, no audit, no model of any kind)
//   - preflight is live: the §8 hostile set produces NO row and NO audit event
//   - atomic audit+mutation: one transaction, both or neither (audit failure ⇒ rollback)
//   - natural-key discipline: reassert appends evidence; different content conflicts;
//     erased slots never re-mint; dismissed slots stay dismissed
//   - supersede mints revision+1 in-slot (identity frozen), flips the prior, links the edge
//   - erasure is scrub-in-place, one operation, content-free audit
//   - verifiers verify; the lifecycle purge is ungated and presence-guarded

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MEMORY_MODEL_V2_FLAG_KEY,
  MEMORY_MODEL_V2_POSTURES,
  DELIVERY_STATE_CONSTRAINTS_GUC,
  memoryModelV2Acts,
  memoryModelV2Posture,
  memoryModelV2Observes,
  armDeliveryStateConstraints,
  completeMemoryRecordDraft,
  rowToMemoryRecord,
  saveMemory,
  supersedeMemory,
  dismissMemory,
  eraseUserMemories,
  linkMemoryRelation,
  verifyMemoryRecordPersisted,
  verifyMemoryRecordState,
  verifyMemoryErased,
  purgeMemoriesForDeletedLegalEntity
} from './memoriesDb.js';
import {
  MEMORY_SCHEMA_VERSION, MEMORY_SCHEMA_VERSION_V2, APPLICABILITY_VERSION,
  memoryContentHash, evidenceSetFingerprint, validateMemoryRecord
} from './memoryModel.js';

const ENV = { MEMORY_KEY_HMAC_SECRET: 'test-secret' };
const ON = { [MEMORY_MODEL_V2_FLAG_KEY]: { stage: 'canary', source: 'test' } };

const makeMockClient = (responders = [], { tablesPresent = true } = {}) => {
  const calls = [];
  const queue = [...responders];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const text = String(sql).toLowerCase();
      if (text === 'begin' || text === 'commit' || text === 'rollback') return { rows: [], rowCount: 0 };
      const idx = queue.findIndex((r) => text.includes(r.match));
      if (idx !== -1) {
        const [r] = queue.splice(idx, 1);
        if (r.throw) throw r.throw;
        return { rows: r.rows || [], rowCount: r.rowCount ?? (r.rows || []).length };
      }
      if (text.includes('to_regclass')) return { rows: [{ present: tablesPresent ? 'memories' : null }] };
      return { rows: [], rowCount: 0 };
    }
  };
};

const baseDraft = () => ({
  tenant_id: 'firm-1',
  scope_type: 'organisation',
  scope_id: 'firm-1',
  lifecycle_owner_type: 'organisation',
  lifecycle_owner_id: 'firm-1',
  subject_type: 'contact',
  subject_id: 'contact-123',
  kind: 'assertion',
  predicate: 'office_location',
  structured_value: { value_type: 'string', value: 'Helsinki' },
  source_text: 'Our office is in Helsinki',
  source_refs: [{ message_id: 'msg-1' }],
  asserted_by_principal_id: 'user-kari',
  assertion_origin: 'owner_asserted',
  observed_at: '2026-07-12T10:00:00.000Z',
  assertion_confidence: 'high',
  confidentiality: 'internal',
  personal_data_class: 'none'
});

// A memories row as the pg driver would return it (timestamptz → Date).
const recordToRow = (record) => {
  const row = { ...record };
  for (const f of ['observed_at', 'recorded_at', 'valid_from', 'valid_until', 'retain_until', 'review_after', 'last_confirmed_at', 'erased_at']) {
    if (row[f]) row[f] = new Date(row[f]);
  }
  return row;
};

const completed = (overrides = {}) => {
  const { record, errors } = completeMemoryRecordDraft({ record: { ...baseDraft(), ...overrides }, env: ENV });
  assert.deepEqual(errors, []);
  return record;
};

test('memoryModelV2Acts: envFallback is false — only a DB stage row turns the writers on', () => {
  assert.equal(memoryModelV2Acts({ snapshot: null, env: {} }), false);
  assert.equal(memoryModelV2Acts({ snapshot: {}, env: { MEMORY_MODEL_V2: 'true' } }), false); // never an env pair
  assert.equal(memoryModelV2Acts({ snapshot: ON, env: {} }), true);
  assert.equal(memoryModelV2Acts({ snapshot: { [MEMORY_MODEL_V2_FLAG_KEY]: { stage: 'shadow' } }, env: {} }), false); // writers ACT — shadow does not
});

test('completeMemoryRecordDraft: derives predicate_class, mints identity, normalizes timestamps before hashing', () => {
  const record = completed({ observed_at: '2026-07-12T12:00:00+02:00' });
  assert.equal(record.predicate_class, 'unclassified'); // derived, never declared
  assert.match(record.memory_id, /^mem-/);
  assert.match(record.memory_key, /^memk-/);
  assert.equal(record.revision, 1);
  assert.equal(record.observed_at, '2026-07-12T10:00:00.000Z'); // UTC-ms normalization
  assert.equal(record.content_hash, memoryContentHash(record));
});

test('completeMemoryRecordDraft: no MEMORY_KEY_HMAC_SECRET ⇒ fail-closed completion error', () => {
  const { errors } = completeMemoryRecordDraft({ record: baseDraft(), env: {} });
  assert.ok(errors.some((e) => e.includes('MEMORY_KEY_HMAC_SECRET')));
});

test('saveMemory: flag off ⇒ flag_off, no mutation, no audit', async () => {
  const c = makeMockClient();
  const out = await saveMemory({ client: c, tenantId: 'firm-1', record: baseDraft(), configSnapshot: {}, env: ENV });
  assert.equal(out.status, 'flag_off');
  assert.ok(!c.calls.some((q) => /insert into memories/i.test(q.sql)));
  assert.ok(!c.calls.some((q) => /audit_events/i.test(q.sql)));
});

test('saveMemory: persists row + audit inside ONE transaction, returns the receipt-pinned write', async () => {
  const c = makeMockClient();
  const out = await saveMemory({ client: c, tenantId: 'firm-1', record: baseDraft(), actor: { type: 'firm', id: 'kari' }, configSnapshot: ON, env: ENV });
  assert.equal(out.status, 'persisted');
  assert.match(out.write.memory_id, /^mem-/);
  assert.match(out.write.memory_key, /^memk-/);
  assert.equal(out.write.revision, 1);
  assert.equal(out.write.record_state, 'active');
  const sqls = c.calls.map((q) => q.sql.toLowerCase());
  const begin = sqls.indexOf('begin');
  const insert = sqls.findIndex((s) => s.includes('insert into memories'));
  const audit = sqls.findIndex((s) => s.includes('insert into audit_events'));
  const commit = sqls.indexOf('commit');
  assert.ok(begin < insert && insert < audit && audit < commit, 'mutation + audit commit together');
  const auditCall = c.calls[audit];
  assert.equal(auditCall.params[4], 'memory.record_saved');
  // content-free audit: ids/hashes/classes only — never the words or the value
  const metadata = auditCall.params[6];
  assert.ok(!metadata.includes('Helsinki'), 'audit metadata must not carry memory content');
});

test('saveMemory: the §8 hostile set is refused BEFORE any transaction — no row, no audit', async () => {
  for (const hostile of [
    { predicate: 'bank_account' },                                   // prohibited_secret
    { predicate: 'communication_preference' },                       // preference candidate routes OUT
    { subject_id: 'unknown' },                                       // unresolved subject
    { assertion_origin: 'third_party_reported' },                    // quarantined origin, no confirmation
    { kind: 'preference' }                                           // not a memory.v1 kind
  ]) {
    const c = makeMockClient();
    const out = await saveMemory({ client: c, tenantId: 'firm-1', record: { ...baseDraft(), ...hostile }, configSnapshot: ON, env: ENV });
    assert.equal(out.status, 'refused', JSON.stringify(hostile));
    assert.ok(!c.calls.some((q) => /insert into memories|audit_events|begin/i.test(q.sql)), JSON.stringify(hostile));
  }
});

test('saveMemory: cross-tenant record is refused', async () => {
  const c = makeMockClient();
  const out = await saveMemory({ client: c, tenantId: 'firm-1', record: { ...baseDraft(), tenant_id: 'firm-2' }, configSnapshot: ON, env: ENV });
  assert.equal(out.status, 'refused');
  assert.match(out.errors[0], /cross-tenant/);
});

// DMEM-R1 W2 (INV-08): a re-assertion appends EVIDENCE; only INDEPENDENT evidence
// (a new dependence group) is confirmation freshness. The same source again is a
// 'repeated' link and leaves last_confirmed_at untouched.
test('saveMemory: re-assertion from an INDEPENDENT source links the evidence and refreshes last_confirmed_at (+ audit), never a duplicate row', async () => {
  const record = completed();
  const c = makeMockClient([
    { match: 'order by revision desc', rows: [{ memory_id: record.memory_id, memory_key: record.memory_key, revision: 1, content_hash: record.content_hash, record_state: 'active' }] },
    // The claim already has support from ANOTHER source; the incoming ref is a new group.
    { match: 'from memory_evidence_links', rows: [{ evidence_id: 'evid-other', dependence_group: 'evgrp-other', corroboration_class: 'independent' }] },
    { match: 'insert into memory_evidence_links', rows: [{ evidence_id: 'evid-new' }] }
  ]);
  const out = await saveMemory({ client: c, tenantId: 'firm-1', record: baseDraft(), configSnapshot: ON, env: ENV });
  assert.equal(out.status, 'reasserted');
  assert.equal(out.corroboration, 'independent');
  assert.equal(out.evidence_added, 1);
  assert.equal(out.write.memory_id, record.memory_id);
  const link = c.calls.find((q) => /insert into memory_evidence_links/.test(q.sql));
  assert.equal(link.params[8], 'independent', 'a new dependence group is independent corroboration');
  assert.ok(c.calls.some((q) => /set last_confirmed_at = now\(\)/.test(q.sql)));
  assert.ok(!c.calls.some((q) => /insert into memories/i.test(q.sql)));
  const audit = c.calls.find((q) => /audit_events/.test(q.sql));
  assert.equal(audit.params[4], 'memory.record_reasserted');
  assert.equal(JSON.parse(audit.params[6]).corroboration, 'independent');
});

test('saveMemory: re-assertion from the SAME source is repeated corroboration — no confirmation freshness, no new link (INV-08)', async () => {
  const record = completed();
  const [ownEvidence] = record.evidence;
  const c = makeMockClient([
    { match: 'order by revision desc', rows: [{ memory_id: record.memory_id, memory_key: record.memory_key, revision: 1, content_hash: record.content_hash, record_state: 'active' }] },
    { match: 'from memory_evidence_links', rows: [{ evidence_id: ownEvidence.evidence_id, dependence_group: ownEvidence.dependence_group, corroboration_class: 'independent' }] }
  ]);
  const out = await saveMemory({ client: c, tenantId: 'firm-1', record: baseDraft(), configSnapshot: ON, env: ENV });
  assert.equal(out.status, 'reasserted');
  assert.equal(out.corroboration, 'repeated');
  assert.equal(out.evidence_added, 0);
  assert.ok(!c.calls.some((q) => /insert into memory_evidence_links/.test(q.sql)), 'the identical evidence is already linked');
  assert.ok(!c.calls.some((q) => /set last_confirmed_at = now\(\)/.test(q.sql)), 'repeated exposure to one source is not freshness');
  const audit = c.calls.find((q) => /audit_events/.test(q.sql));
  assert.equal(JSON.parse(audit.params[6]).corroboration, 'repeated');
});

test('saveMemory: a re-observation of the same source (new version, same dependence group) links as repeated, not independent', async () => {
  const record = completed();
  const [ownEvidence] = record.evidence;
  const c = makeMockClient([
    { match: 'order by revision desc', rows: [{ memory_id: record.memory_id, memory_key: record.memory_key, revision: 1, content_hash: record.content_hash, record_state: 'active' }] },
    { match: 'from memory_evidence_links', rows: [{ evidence_id: 'evid-earlier-version', dependence_group: ownEvidence.dependence_group, corroboration_class: 'independent' }] },
    { match: 'insert into memory_evidence_links', rows: [{ evidence_id: ownEvidence.evidence_id }] }
  ]);
  const out = await saveMemory({ client: c, tenantId: 'firm-1', record: baseDraft(), configSnapshot: ON, env: ENV });
  assert.equal(out.status, 'reasserted');
  assert.equal(out.corroboration, 'repeated');
  assert.equal(out.evidence_added, 1);
  const link = c.calls.find((q) => /insert into memory_evidence_links/.test(q.sql));
  assert.equal(link.params[8], 'repeated');
  assert.ok(!c.calls.some((q) => /set last_confirmed_at = now\(\)/.test(q.sql)));
});

test('saveMemory: different content against an active slot is a CONFLICT, never a silent overwrite', async () => {
  const c = makeMockClient([
    { match: 'order by revision desc', rows: [{ memory_id: 'mem-old', memory_key: 'memk-x', revision: 1, content_hash: 'memh-other', record_state: 'active' }] }
  ]);
  const out = await saveMemory({ client: c, tenantId: 'firm-1', record: baseDraft(), configSnapshot: ON, env: ENV });
  assert.equal(out.status, 'conflict');
  assert.ok(!c.calls.some((q) => /insert into memories/i.test(q.sql)));
});

test('saveMemory: an erased slot is never re-minted; a dismissed slot is a standing human "no"', async () => {
  for (const state of ['erased', 'dismissed']) {
    const c = makeMockClient([
      { match: 'order by revision desc', rows: [{ memory_id: 'mem-old', memory_key: 'memk-x', revision: 1, content_hash: 'memh-other', record_state: state }] }
    ]);
    const out = await saveMemory({ client: c, tenantId: 'firm-1', record: baseDraft(), configSnapshot: ON, env: ENV });
    assert.equal(out.status, 'refused', state);
    assert.ok(!c.calls.some((q) => /insert into memories/i.test(q.sql)), state);
  }
});

test('saveMemory: dryRun previews the write — no insert, no audit', async () => {
  const c = makeMockClient();
  const out = await saveMemory({ client: c, tenantId: 'firm-1', record: baseDraft(), dryRun: true, configSnapshot: ON, env: ENV });
  assert.equal(out.status, 'dry_run');
  assert.equal(out.effect, 'persist');
  assert.match(out.write.memory_id, /^mem-/);
  assert.ok(!c.calls.some((q) => /insert into memories|audit_events/i.test(q.sql)));
});

test('saveMemory: audit failure rolls the mutation back (atomic — both or neither)', async () => {
  const c = makeMockClient([
    { match: 'insert into audit_events', throw: new Error('audit write failed') }
  ]);
  await assert.rejects(
    saveMemory({ client: c, tenantId: 'firm-1', record: baseDraft(), configSnapshot: ON, env: ENV }),
    /audit write failed/
  );
  const sqls = c.calls.map((q) => q.sql.toLowerCase());
  assert.ok(sqls.includes('rollback'));
  assert.ok(!sqls.includes('commit'));
});

test('saveMemory: quarantined origin WITH a recorded activation confirmation persists', async () => {
  const c = makeMockClient();
  const out = await saveMemory({
    client: c, tenantId: 'firm-1',
    record: {
      ...baseDraft(),
      assertion_origin: 'distilled_from_document',
      transport_actor: 'owner',
      activation_confirmation: { via: 'explicit_confirmation', confirmed_by_principal_id: 'kari', confirmed_at: '2026-07-12T10:00:00.000Z' }
    },
    configSnapshot: ON, env: ENV
  });
  assert.equal(out.status, 'persisted');
});

test('supersedeMemory: mints revision+1 in-slot, flips the prior, links the supersedes edge — one transaction', async () => {
  const prior = completed();
  const c = makeMockClient([
    { match: 'for update', rows: [recordToRow(prior)] },
    { match: "set record_state = 'superseded'", rows: [], rowCount: 1 }
  ]);
  const out = await supersedeMemory({
    client: c, tenantId: 'firm-1', priorMemoryId: prior.memory_id,
    changes: { structured_value: { value_type: 'string', value: 'Espoo' }, source_text: 'We moved to Espoo', source_refs: [{ message_id: 'msg-2' }] },
    actor: { type: 'firm', id: 'kari' }, configSnapshot: ON, env: ENV
  });
  assert.equal(out.status, 'superseded');
  assert.equal(out.write.revision, 2);
  assert.equal(out.write.memory_key, prior.memory_key); // same slot
  assert.notEqual(out.write.memory_id, prior.memory_id); // new immutable version
  const insert = c.calls.find((q) => /insert into memories/i.test(q.sql));
  assert.ok(insert.params.includes(prior.memory_id)); // supersedes_memory_id
  const rel = c.calls.find((q) => /insert into memory_relations/.test(q.sql));
  assert.equal(rel.params[2], prior.memory_id);
  const audit = c.calls.find((q) => /audit_events/.test(q.sql));
  assert.equal(audit.params[4], 'memory.record_superseded');
  const sqls = c.calls.map((q) => q.sql.toLowerCase());
  assert.ok(sqls.indexOf('begin') < sqls.findIndex((s) => s.includes('insert into memories')));
  assert.ok(sqls.lastIndexOf('commit') > sqls.findIndex((s) => s.includes('audit_events')));
  // The order that survives migration 085's one-active-per-key partial unique
  // index on real PostgreSQL: the prior flips to 'superseded' BEFORE the new
  // active head is inserted. (Insert-first collides with the index — the
  // 2026-08-11 round-2 finding; memoriesPgLifecycle.test.js exercises it
  // against a real database.)
  assert.ok(
    sqls.findIndex((s) => s.includes("set record_state = 'superseded'"))
      < sqls.findIndex((s) => s.includes('insert into memories')),
    'prior must flip to superseded before the new head is inserted'
  );
});

test('supersedeMemory: stale head at flip time ⇒ loud refusal, no insert, no audit, nothing written', async () => {
  const prior = completed();
  const c = makeMockClient([
    { match: 'for update', rows: [recordToRow(prior)] },
    // The flip matches zero rows: a concurrent corrector superseded the head
    // between our read and our write. The writer must refuse — never insert.
    { match: "set record_state = 'superseded'", rows: [], rowCount: 0 }
  ]);
  const out = await supersedeMemory({
    client: c, tenantId: 'firm-1', priorMemoryId: prior.memory_id,
    changes: { structured_value: { value_type: 'string', value: 'Espoo' }, source_text: 'We moved to Espoo', source_refs: [{ message_id: 'msg-2' }] },
    actor: { type: 'firm', id: 'kari' }, configSnapshot: ON, env: ENV
  });
  assert.equal(out.status, 'refused');
  assert.ok(out.errors.some((e) => /no longer the active head/.test(e)));
  assert.ok(!c.calls.some((q) => /insert into memories/i.test(q.sql)), 'no new head may be inserted on a stale flip');
  assert.ok(!c.calls.some((q) => /audit_events/.test(q.sql)), 'no audit row for a refused supersede');
  assert.ok(!c.calls.some((q) => /memory_relations/.test(q.sql)), 'no supersedes edge for a refused supersede');
});

test('supersedeMemory: the DB round trip reproduces the exact content hash (UTC-ms normalization)', async () => {
  const prior = completed({ valid_from: '2026-07-01T00:00:00.000Z' });
  const c = makeMockClient([
    { match: 'for update', rows: [recordToRow(prior)] },
    { match: "set record_state = 'superseded'", rows: [], rowCount: 1 }
  ]);
  // No content-field changes: the next revision's hash must equal the prior's —
  // proving the row→record rebuild is hash-stable.
  const out = await supersedeMemory({
    client: c, tenantId: 'firm-1', priorMemoryId: prior.memory_id,
    changes: { assertion_confidence: 'medium' }, configSnapshot: ON, env: ENV
  });
  assert.equal(out.status, 'superseded');
  assert.equal(out.write.content_hash, prior.content_hash);
});

test('supersedeMemory: slot identity fields are frozen (a different slot is a new saveMemory)', async () => {
  for (const frozen of [{ predicate: 'renewal_month' }, { subject_id: 'contact-999' }, { scope_type: 'legal_entity' }, { record_state: 'dismissed' }]) {
    const c = makeMockClient();
    const out = await supersedeMemory({ client: c, tenantId: 'firm-1', priorMemoryId: 'mem-x', changes: frozen, configSnapshot: ON, env: ENV });
    assert.equal(out.status, 'refused', JSON.stringify(frozen));
    assert.ok(!c.calls.some((q) => /insert into memories/i.test(q.sql)));
  }
});

test('supersedeMemory: only the active head may be superseded', async () => {
  const prior = completed();
  const c = makeMockClient([
    { match: 'for update', rows: [{ ...recordToRow(prior), record_state: 'superseded' }] }
  ]);
  const out = await supersedeMemory({ client: c, tenantId: 'firm-1', priorMemoryId: prior.memory_id, changes: {}, configSnapshot: ON, env: ENV });
  assert.equal(out.status, 'refused');
  assert.match(out.errors[0], /active head/);
});

test('dismissMemory: active → dismissed + audit; already-dismissed is an idempotent no-op', async () => {
  const row = { memory_id: 'mem-1', memory_key: 'memk-1', revision: 1, content_hash: 'memh-1', record_state: 'active', lifecycle_owner_type: 'organisation', lifecycle_owner_id: 'firm-1' };
  const c = makeMockClient([{ match: 'for update', rows: [row] }]);
  const out = await dismissMemory({ client: c, tenantId: 'firm-1', memoryId: 'mem-1', reason: 'wrong', configSnapshot: ON, env: ENV });
  assert.equal(out.status, 'dismissed');
  assert.equal(out.write.record_state, 'dismissed');
  assert.equal(c.calls.find((q) => /audit_events/.test(q.sql)).params[4], 'memory.record_dismissed');

  const c2 = makeMockClient([{ match: 'for update', rows: [{ ...row, record_state: 'dismissed' }] }]);
  const out2 = await dismissMemory({ client: c2, tenantId: 'firm-1', memoryId: 'mem-1', configSnapshot: ON, env: ENV });
  assert.equal(out2.status, 'already_dismissed');
  assert.ok(!c2.calls.some((q) => /audit_events/.test(q.sql)));
});

test('eraseUserMemories: scrub-in-place — one operation, content nulls + erased + erased_at, content-free batch audit', async () => {
  const c = makeMockClient([
    { match: 'update memories', rows: [
      { memory_id: 'mem-1', memory_key: 'memk-1', revision: 1, content_hash: 'memh-1', record_state: 'erased' },
      { memory_id: 'mem-2', memory_key: 'memk-2', revision: 3, content_hash: 'memh-2', record_state: 'erased' }
    ] }
  ]);
  const out = await eraseUserMemories({
    client: c, tenantId: 'firm-1', lifecycleOwnerType: 'user', lifecycleOwnerId: 'user-kari',
    reason: 'user requested erasure', configSnapshot: ON, env: ENV
  });
  assert.equal(out.status, 'erased');
  assert.equal(out.count, 2);
  const scrub = c.calls.find((q) => /update memories/.test(q.sql));
  assert.match(scrub.sql, /structured_value = null/);
  assert.match(scrub.sql, /source_text = null/);
  assert.match(scrub.sql, /source_refs = null/);
  assert.match(scrub.sql, /observed_alias = null/);
  assert.match(scrub.sql, /record_state = 'erased'/);
  assert.match(scrub.sql, /erased_at = now\(\)/);
  assert.ok(!/delete from/.test(scrub.sql), 'no hard delete in the general path');
  const audit = c.calls.find((q) => /audit_events/.test(q.sql));
  assert.equal(audit.params[4], 'memory.records_erased');
  assert.ok(audit.params[6].includes('mem-1') && audit.params[6].includes('"count":2'));
});

test('eraseUserMemories: requested ids that matched nothing are reported, never guessed at', async () => {
  const c = makeMockClient([
    { match: 'update memories', rows: [{ memory_id: 'mem-1', memory_key: 'memk-1', revision: 1, content_hash: 'memh-1', record_state: 'erased' }] }
  ]);
  const out = await eraseUserMemories({
    client: c, tenantId: 'firm-1', lifecycleOwnerType: 'user', lifecycleOwnerId: 'user-kari',
    memoryIds: ['mem-1', 'mem-not-mine'], configSnapshot: ON, env: ENV
  });
  assert.deepEqual(out.unmatched_ids, ['mem-not-mine']);
});

test('eraseUserMemories: dryRun counts without scrubbing', async () => {
  const c = makeMockClient([
    { match: "record_state <> 'erased'", rows: [{ memory_id: 'mem-1', memory_key: 'memk-1', revision: 1, content_hash: 'memh-1' }] }
  ]);
  const out = await eraseUserMemories({
    client: c, tenantId: 'firm-1', lifecycleOwnerType: 'user', lifecycleOwnerId: 'user-kari',
    dryRun: true, configSnapshot: ON, env: ENV
  });
  assert.equal(out.status, 'dry_run');
  assert.equal(out.count, 1);
  assert.ok(!c.calls.some((q) => /update memories|audit_events/.test(q.sql)));
});

test('linkMemoryRelation: contradicts records the edge AND flips both epistemic states', async () => {
  const c = makeMockClient([
    { match: 'select memory_id, lifecycle_owner_type', rows: [
      { memory_id: 'mem-a', lifecycle_owner_type: 'organisation', lifecycle_owner_id: 'firm-1', record_state: 'active' },
      { memory_id: 'mem-b', lifecycle_owner_type: 'organisation', lifecycle_owner_id: 'firm-1', record_state: 'active' }
    ] },
    { match: 'insert into memory_relations', rows: [{ source_memory_id: 'mem-a' }] }
  ]);
  const out = await linkMemoryRelation({ client: c, tenantId: 'firm-1', sourceMemoryId: 'mem-a', relation: 'contradicts', targetMemoryId: 'mem-b', configSnapshot: ON, env: ENV });
  assert.equal(out.status, 'linked');
  const flip = c.calls.find((q) => /epistemic_state = 'contradicted'/.test(q.sql));
  assert.ok(flip, 'contradiction reflects in the state axis');
  assert.equal(c.calls.find((q) => /audit_events/.test(q.sql)).params[4], 'memory.relation_linked');
});

test('linkMemoryRelation: an existing edge is already_linked — no duplicate audit', async () => {
  const c = makeMockClient([
    { match: 'select memory_id, lifecycle_owner_type', rows: [
      { memory_id: 'mem-a', lifecycle_owner_type: 'organisation', lifecycle_owner_id: 'firm-1', record_state: 'active' },
      { memory_id: 'mem-b', lifecycle_owner_type: 'organisation', lifecycle_owner_id: 'firm-1', record_state: 'active' }
    ] },
    { match: 'insert into memory_relations', rows: [] }
  ]);
  const out = await linkMemoryRelation({ client: c, tenantId: 'firm-1', sourceMemoryId: 'mem-a', relation: 'confirms', targetMemoryId: 'mem-b', configSnapshot: ON, env: ENV });
  assert.equal(out.status, 'already_linked');
  assert.ok(!c.calls.some((q) => /audit_events/.test(q.sql)));
});

test('verifiers: persisted / state / erased', async () => {
  const row = { memory_id: 'mem-1', memory_key: 'memk-1', revision: 1, content_hash: 'memh-1', record_state: 'active' };
  const c1 = makeMockClient([{ match: 'from memories', rows: [row] }]);
  assert.equal((await verifyMemoryRecordPersisted({ client: c1, tenantId: 'firm-1', memoryId: 'mem-1', expectedContentHash: 'memh-1' })).verified, true);
  const c2 = makeMockClient([{ match: 'from memories', rows: [row] }]);
  assert.equal((await verifyMemoryRecordPersisted({ client: c2, tenantId: 'firm-1', memoryId: 'mem-1', expectedContentHash: 'memh-other' })).verified, false);
  const c3 = makeMockClient([{ match: 'from memories', rows: [row] }]);
  assert.equal((await verifyMemoryRecordState({ client: c3, tenantId: 'firm-1', memoryId: 'mem-1', expectedState: 'active' })).verified, true);
  const c4 = makeMockClient([{ match: 'count(*)', rows: [{ remaining: 0 }] }]);
  assert.equal((await verifyMemoryErased({ client: c4, tenantId: 'firm-1', lifecycleOwnerType: 'user', lifecycleOwnerId: 'user-kari' })).verified, true);
  const c5 = makeMockClient([{ match: 'count(*)', rows: [{ remaining: 2 }] }]);
  const out5 = await verifyMemoryErased({ client: c5, tenantId: 'firm-1', lifecycleOwnerType: 'user', lifecycleOwnerId: 'user-kari' });
  assert.equal(out5.verified, false);
  assert.equal(out5.remaining, 2);
});

test('purgeMemoriesForDeletedLegalEntity: hard-deletes the legal_entity root; presence-guarded; never flag-gated', async () => {
  const c = makeMockClient([{ match: 'delete from memories', rows: [], rowCount: 3 }]);
  const out = await purgeMemoriesForDeletedLegalEntity({ client: c, firmId: 'firm-1', clientId: 'cl-1' });
  assert.equal(out.deleted, 3);
  const del = c.calls.find((q) => /delete from memories/.test(q.sql));
  assert.match(del.sql, /lifecycle_owner_type = 'legal_entity'/);
  assert.deepEqual(del.params, ['firm-1', 'cl-1']);

  const pre085 = makeMockClient([], { tablesPresent: false });
  assert.deepEqual(await purgeMemoriesForDeletedLegalEntity({ client: pre085, firmId: 'firm-1', clientId: 'cl-1' }), { deleted: 0 });
  assert.ok(!pre085.calls.some((q) => /delete from memories/.test(q.sql)));
});

test('rowToMemoryRecord: typed lifecycle roots are storage, not contract (closed envelope survives)', () => {
  const record = completed();
  const row = { ...recordToRow(record), owner_user_id: null, owner_organisation_id: 'firm-1', owner_client_id: null, owner_ephemeral_ref: null };
  const rebuilt = rowToMemoryRecord(row);
  assert.equal(rebuilt.owner_organisation_id, undefined);
  assert.equal(rebuilt.content_hash, memoryContentHash(rebuilt)); // hash-stable rebuild
});

// ── DMEM-R1 W2: memory.v2 minting, the posture projection, the armed law ─────

test('completeMemoryRecordDraft: an undeclared draft mints memory.v2 — applicability normalized (never widened), evidence derived from source_refs, generation 1', () => {
  const record = completed();
  assert.equal(record.schema_version, MEMORY_SCHEMA_VERSION_V2);
  assert.equal(record.applicability_version, APPLICABILITY_VERSION);
  assert.deepEqual(record.applicability.jurisdiction, { kind: 'unspecified' }, 'an undeclared dimension is unspecified, not any');
  assert.equal(record.evidence.length, 1);
  assert.equal(record.evidence[0].evidence_kind, 'message');
  assert.equal(record.evidence[0].source_object_id, 'msg-1');
  assert.equal(record.evidence_fingerprint, evidenceSetFingerprint(record.evidence));
  assert.equal(record.claim_generation, 1);
  assert.deepEqual(record.confirmation_history, []);
  assert.equal(record.source_object_type, 'message', 'single-evidence provenance is filled from the evidence');
  assert.deepEqual(validateMemoryRecord(record), []);
  assert.equal(record.content_hash, memoryContentHash(record));
});

test('completeMemoryRecordDraft: a draft that DECLARES memory.v1 stays v1, byte-identical (the version is a field, never inferred)', () => {
  const v1 = completed({ schema_version: MEMORY_SCHEMA_VERSION });
  assert.equal(v1.schema_version, MEMORY_SCHEMA_VERSION);
  assert.equal(v1.applicability, undefined);
  assert.equal(v1.evidence, undefined);
  assert.deepEqual(validateMemoryRecord(v1), []);
  const { errors } = completeMemoryRecordDraft({ record: { ...baseDraft(), schema_version: 'memory.v9' }, env: ENV });
  assert.ok(errors.some((e) => /not a memory contract version/.test(e)));
});

test('completeMemoryRecordDraft: a declared applicability is kept as typed values; a bare string is a value, never a wildcard', () => {
  const record = completed({ applicability: { jurisdiction: 'GB', currency: { kind: 'any' } }, effective_from: '2026-01-01', effective_to: null });
  assert.deepEqual(record.applicability.jurisdiction, { kind: 'value', value: 'GB' });
  assert.deepEqual(record.applicability.currency, { kind: 'any' });
  assert.deepEqual(record.applicability.party, { kind: 'unspecified' });
  assert.equal(record.effective_from, '2026-01-01');
  assert.deepEqual(validateMemoryRecord(record), []);
  const other = completed({ applicability: { jurisdiction: 'FI' } });
  assert.notEqual(other.content_hash, completed().content_hash, 'applicability is receipted content under v2');
});

test('saveMemory: persisting a v2 record inserts the row AND its evidence links, in the same transaction, before the audit', async () => {
  const c = makeMockClient([{ match: 'insert into memory_evidence_links', rows: [{ evidence_id: 'x' }] }]);
  const out = await saveMemory({ client: c, tenantId: 'firm-1', record: baseDraft(), configSnapshot: ON, env: ENV });
  assert.equal(out.status, 'persisted');
  assert.equal(out.evidence_linked, 1);
  const order = c.calls.map((q) => q.sql.toLowerCase());
  const rowAt = order.findIndex((q) => q.includes('insert into memories'));
  const linkAt = order.findIndex((q) => q.includes('insert into memory_evidence_links'));
  const auditAt = order.findIndex((q) => q.includes('audit_events'));
  const commitAt = order.findIndex((q) => q === 'commit');
  assert.ok(rowAt !== -1 && rowAt < linkAt && linkAt < auditAt && auditAt < commitAt, `row → links → audit → commit: ${JSON.stringify([rowAt, linkAt, auditAt, commitAt])}`);
  const insert = c.calls[rowAt];
  assert.match(insert.sql, /applicability, applicability_version, effective_from, effective_to/);
  const audit = c.calls[auditAt];
  const metadata = JSON.parse(audit.params[6]);
  assert.equal(metadata.schema_version, MEMORY_SCHEMA_VERSION_V2);
  assert.match(metadata.evidence_fingerprint, /^evset-/);
  assert.ok(!('source_text' in metadata) && !('structured_value' in metadata), 'audit metadata stays content-free');
});

test('rowToMemoryRecord: a v1 row rebuilds into the v1 envelope (v2 storage columns dropped); a v2 row keeps them, hash-stable', () => {
  const v1 = completed({ schema_version: MEMORY_SCHEMA_VERSION });
  const v1row = { ...recordToRow(v1), applicability: null, claim_generation: '1', confirmation_history: [], consuming_decision_refs: [], owner_organisation_id: 'firm-1' };
  const rebuiltV1 = rowToMemoryRecord(v1row);
  assert.equal(rebuiltV1.applicability, undefined);
  assert.equal(rebuiltV1.claim_generation, undefined);
  assert.deepEqual(validateMemoryRecord(rebuiltV1), []);
  const v2 = completed({ effective_from: '2026-01-01' });
  const { evidence, ...persisted } = v2;
  const v2row = { ...recordToRow(persisted), claim_generation: '1', effective_from: new Date('2026-01-01T00:00:00'), owner_organisation_id: 'firm-1' };
  const rebuiltV2 = rowToMemoryRecord(v2row);
  assert.equal(rebuiltV2.claim_generation, 1);
  assert.equal(rebuiltV2.effective_from, '2026-01-01');
  assert.deepEqual(validateMemoryRecord(rebuiltV2), [], 'a v2 row validates without its write-time evidence array (the fingerprint is on the row)');
  assert.equal(rebuiltV2.content_hash, memoryContentHash(rebuiltV2));
});

test('memoryModelV2Posture: off / shadow / canary / authoritative, and KILL through CLIENT_CONFIG_FORCE_DISABLE — one resolver, agreeing with acts/observes', () => {
  assert.deepEqual([...MEMORY_MODEL_V2_POSTURES], ['kill', 'off', 'shadow', 'canary', 'authoritative']);
  const env = {};
  const at = (stage) => ({ [MEMORY_MODEL_V2_FLAG_KEY]: { stage, source: 'test' } });
  assert.equal(memoryModelV2Posture({ snapshot: null, env }), 'off', 'no row: born off (envFallback false)');
  assert.equal(memoryModelV2Posture({ snapshot: at('off'), env }), 'off');
  assert.equal(memoryModelV2Posture({ snapshot: at('dry_run'), env }), 'off');
  assert.equal(memoryModelV2Posture({ snapshot: at('shadow'), env }), 'shadow');
  assert.equal(memoryModelV2Posture({ snapshot: at('canary'), env }), 'canary');
  assert.equal(memoryModelV2Posture({ snapshot: at('auto'), env }), 'authoritative');
  assert.equal(memoryModelV2Posture({ snapshot: at('canary'), env: { CLIENT_CONFIG_FORCE_DISABLE: 'MEMORY_MODEL_V2' } }), 'kill');
  assert.equal(memoryModelV2Posture({ snapshot: at('auto'), env: { CLIENT_CONFIG_FORCE_DISABLE: 'all' } }), 'kill');
  for (const stage of ['off', 'dry_run', 'shadow', 'canary', 'auto']) {
    const posture = memoryModelV2Posture({ snapshot: at(stage), env });
    assert.equal(memoryModelV2Acts({ snapshot: at(stage), env }), posture === 'canary' || posture === 'authoritative', `${stage}: acts ⇔ canary|authoritative`);
    assert.equal(memoryModelV2Observes({ snapshot: at(stage), env }), ['shadow', 'canary', 'authoritative'].includes(posture), `${stage}: observes ⇔ shadow|canary|authoritative`);
  }
  assert.equal(memoryModelV2Acts({ snapshot: at('canary'), env: { CLIENT_CONFIG_FORCE_DISABLE: 'MEMORY_MODEL_V2' } }), false, 'kill wins over a canary row');
});

test('armDeliveryStateConstraints: arms the transaction-local GUC only when the posture acts; kill / off / shadow leave the writers byte-identical', async () => {
  const at = (stage) => ({ [MEMORY_MODEL_V2_FLAG_KEY]: { stage, source: 'test' } });
  for (const [snapshot, env, expected] of [
    [null, {}, 'off'], [at('shadow'), {}, 'shadow'], [at('canary'), { CLIENT_CONFIG_FORCE_DISABLE: 'all' }, 'kill']
  ]) {
    const c = makeMockClient();
    const out = await armDeliveryStateConstraints(c, { snapshot, env });
    assert.deepEqual(out, { armed: false, posture: expected });
    assert.equal(c.calls.length, 0, `${expected}: no set_config`);
  }
  const c = makeMockClient();
  const out = await armDeliveryStateConstraints(c, { snapshot: at('canary'), env: {} });
  assert.deepEqual(out, { armed: true, posture: 'canary' });
  assert.equal(c.calls.length, 1);
  assert.match(c.calls[0].sql, /set_config\(\$1, \$2, true\)/, 'transaction-local (set_config is_local = true)');
  assert.deepEqual(c.calls[0].params, [DELIVERY_STATE_CONSTRAINTS_GUC, 'enforce']);
});
