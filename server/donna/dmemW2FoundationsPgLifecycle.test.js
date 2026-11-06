// DMEM-R1 W2 — the additive canonical foundations, proven INACTIVE on real
// PostgreSQL 16 (docs/plan-2026-09-02-memory-remediation-slices.md §5 W2;
// docs/plan-2026-09-02-memory-remediation-v1.md "Wave 2" exit gate;
// docs/audit-2026-09-04-memory-re-baseline.md §4.3).
//
// Plain assertions (this wave's fixture, expected to PASS from W2 on — never
// registered). One appliance boot (the complete migration set from empty — the
// "from empty" half of the gate; the N-1 half is dmemW2MigrationsFromPriorHead…),
// then the exit-gate items the tree can now express, each at the DATABASE
// boundary where the doctrine puts it:
//   - the schema landed (141–147: tables, columns, triggers);
//   - the MEMORY_MODEL_V2 key is born OFF with no row, resolves off / shadow /
//     canary / kill through the ONE resolver, and refuses the `auto` terminal;
//   - a cross-scope relation fails at the database;
//   - concurrent supersession leaves exactly one current revision;
//   - same-source replay is authority-idempotent (INV-08);
//   - invalid temporal overlap, an unauthorized projection, mutable history, a
//     false delivery (armed) and an orphan dependency are rejected;
//   - the claim generation advances in the database and never moves backwards;
//   - the local-job claim is a generation-checked compare-and-swap: a stale
//     generation loses, two claimers on one generation resolve to one winner.
// Nothing here activates a writer: every row the new tables receive is written by
// this fixture, on a scratch database the harness provisions and drops (INV-24).

import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { bootApplianceForTest, applianceHarnessSkipReason } from './testSupport/applianceHarness.js';
import { canonicalDigest, layerMessage } from './testSupport/dmemFixtureSupport.js';
import { withFirmDbClient } from './firmDb.js';
import {
  MEMORY_MODEL_V2_FLAG_KEY, DELIVERY_STATE_CONSTRAINTS_GUC,
  saveMemory, supersedeMemory, dismissMemory, linkMemoryRelation, listMemoryEvidenceLinks,
  memoryModelV2Posture, memoryModelV2Acts, memoryModelV2Observes, armDeliveryStateConstraints
} from './memoriesDb.js';
import { readClientConfigSnapshot, setClientFlagStage } from './clientConfig.js';
import { bumpLocalJobClaimGeneration, claimNextLocalJob, enqueueLocalJob } from './desktop/localJobQueue.js';
import { DESKTOP_DARK_PLANE_EXTENSIONS } from './desktop/hostPlaneSeed.js';

const S = 'W2';
const ENV = { MEMORY_KEY_HMAC_SECRET: 'dmem-w2-hmac' };
const W2_MIGRATIONS = Object.freeze([
  '141_memory_candidate_scoped_identity', '142_claim_applicability_evidence_links',
  '143_memory_relations_same_scope_dependencies', '144_memory_projections',
  '145_decision_envelopes', '146_claim_generation', '147_delivery_state_constraints'
]);
const W2_TABLES = Object.freeze(['memory_candidate_events', 'memory_evidence_links', 'memory_dependencies', 'memory_projections', 'decision_envelopes', 'decision_results']);
const W2_TRIGGERS = Object.freeze([
  'memory_candidate_events_append_only', 'memory_evidence_links_same_tenant', 'memory_evidence_links_append_only',
  'memory_relations_same_scope', 'memory_dependencies_guard', 'memory_dependencies_delete_guard',
  'memory_projections_guard', 'memory_projections_delete_guard', 'decision_envelopes_immutable', 'decision_results_guard',
  'memories_claim_generation_advance', 'client_evidence_requests_delivery_state'
]);

const TX = async (client, fn) => {
  await client.query('begin');
  try {
    const out = await fn();
    await client.query('commit');
    return out;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  }
};

const stage = (firmId, clientId, stageName, reason) => withFirmDbClient((client) => TX(client, () =>
  setClientFlagStage(client, { firmId, clientId, flagKey: MEMORY_MODEL_V2_FLAG_KEY, stage: stageName, source: 'manual', reason, actorType: 'system', actorId: 'dmem-w2' })
));

const claimDraft = (clientId, overrides = {}) => ({
  scope_type: 'legal_entity', scope_id: clientId, lifecycle_owner_type: 'legal_entity', lifecycle_owner_id: clientId,
  subject_type: 'merchant', subject_id: 'acme-supplies', observed_alias: 'ACME SUPPLIES LTD',
  kind: 'assertion', predicate: 'supplier_category',
  structured_value: { value_type: 'string', value: 'stationery' }, source_text: 'Acme Supplies sells stationery to the studio.',
  source_refs: [{ transaction_id: `${clientId}-tx-acme-1` }], asserted_by_principal_id: 'dmem-w2', assertion_origin: 'owner_asserted',
  observed_at: '2026-09-01T10:00:00.000Z', assertion_confidence: 'high', confidentiality: 'internal', personal_data_class: 'none',
  applicability: { jurisdiction: 'GB' },
  ...overrides
});

test(
  'real PG (appliance, DMEM W2): the canonical foundations apply from empty, stay dark, and refuse at the database boundary',
  { skip: applianceHarnessSkipReason() },
  async (t) => {
    const appliance = await bootApplianceForTest({ now: new Date('2026-09-04T09:00:00.000Z') });
    const extra = [];
    const openClient = async () => {
      const client = new pg.Client({ connectionString: appliance.databaseUrl });
      await client.connect();
      extra.push(client);
      return client;
    };
    try {
      const { firmId } = appliance;
      const { clientId } = await appliance.createClient();
      const { clientId: otherClientId } = await appliance.createClient({ profile: { companyName: 'Dune Apparel Ltd' } });
      const env = { ...process.env, ...ENV };
      const canary = { [MEMORY_MODEL_V2_FLAG_KEY]: { stage: 'canary', source: 'manual' } };

      await t.test('schema — migrations 141–147 applied from empty: tables, triggers, columns', async () => {
        const applied = new Set((await appliance.query("select version from schema_migrations where version >= '141' order by version")).rows.map((r) => r.version));
        for (const version of W2_MIGRATIONS) assert.ok(applied.has(version), layerMessage(S, 1, `${version} applied`));
        for (const table of W2_TABLES) {
          assert.ok((await appliance.query('select to_regclass($1) as r', [`public.${table}`])).rows[0].r, layerMessage(S, 1, `${table} exists`));
        }
        const triggers = new Set((await appliance.query('select tgname from pg_trigger where not tgisinternal')).rows.map((r) => r.tgname));
        for (const trigger of W2_TRIGGERS) assert.ok(triggers.has(trigger), layerMessage(S, 1, `trigger ${trigger} exists`));
        const columns = async (table) => new Set((await appliance.query('select column_name from information_schema.columns where table_name = $1', [table])).rows.map((r) => r.column_name));
        for (const column of ['applicability', 'effective_from', 'effective_to', 'evidence_fingerprint', 'claim_generation', 'source_object_id', 'raw_value', 'normalized_value', 'confirmation_history', 'supersession_reason', 'consuming_decision_refs', 'promotion_receipt_id']) {
          assert.ok((await columns('memories')).has(column), layerMessage(S, 1, `memories.${column}`));
        }
        for (const [table, column] of [['client_rules', 'valid_from'], ['client_rules', 'claim_generation'], ['firm_facts', 'applicability'], ['reconciliation_matches', 'claim_generation'], ['reconciliation_evaluations', 'claim_generation'], ['client_evidence_requests', 'claim_generation'], ['local_jobs', 'claim_generation'], ['loop_event_outbox', 'dispatch_fence_worker_id'], ['llm_decisions', 'envelope_id'], ['llm_decisions', 'pre_action_envelope_digest'], ['local_evidence_objects', 'owner_client_id'], ['memory_candidates', 'scoped_identity'], ['memory_candidates', 'expected_claim_generation']]) {
          assert.ok((await columns(table)).has(column), layerMessage(S, 1, `${table}.${column}`));
        }
        const schemaCheck = (await appliance.query("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'memories_schema_version_check'")).rows[0];
        assert.match(schemaCheck.def, /memory\.v1/);
        assert.match(schemaCheck.def, /memory\.v2/, layerMessage(S, 1, 'the version check widened to admit memory.v2'));
      });

      await t.test('plane key — born OFF with no row; off / shadow / canary / kill through the one resolver; the auto terminal refused', async () => {
        assert.deepEqual([...DESKTOP_DARK_PLANE_EXTENSIONS], ['MEMORY_MODEL_V2']);
        const liveKeys = (await appliance.query('select flag_key from client_capability_config where firm_id = $1 and client_id = $2 and valid_to is null', [firmId, clientId])).rows.map((r) => r.flag_key);
        assert.ok(!liveKeys.includes(MEMORY_MODEL_V2_FLAG_KEY), layerMessage(S, 1, 'the desktop seed wrote NO row for the dark key (born off = no row)'));
        const snapshotNow = () => withFirmDbClient((client) => readClientConfigSnapshot(client, { firmId, clientId }));
        assert.equal(memoryModelV2Posture({ snapshot: await snapshotNow(), env }), 'off');
        assert.equal(memoryModelV2Acts({ snapshot: await snapshotNow(), env }), false);
        const darkSnapshot = await snapshotNow();
        const darkWrite = await withFirmDbClient((client) => saveMemory({ client, tenantId: firmId, record: claimDraft(clientId), actor: { type: 'firm', id: 'dmem-w2' }, configSnapshot: darkSnapshot, env }));
        assert.equal(darkWrite.status, 'flag_off', layerMessage(S, 1, 'dark: the canonical writer refuses'));
        assert.equal((await appliance.query('select count(*)::int as n from memories where tenant_id = $1', [firmId])).rows[0].n, 0);
        await stage(firmId, clientId, 'shadow', 'dmem w2: observe only');
        assert.equal(memoryModelV2Posture({ snapshot: await snapshotNow(), env }), 'shadow');
        assert.equal(memoryModelV2Observes({ snapshot: await snapshotNow(), env }), true);
        assert.equal(memoryModelV2Acts({ snapshot: await snapshotNow(), env }), false);
        await stage(firmId, clientId, 'canary', 'dmem w2: the canonical plane acts');
        assert.equal(memoryModelV2Posture({ snapshot: await snapshotNow(), env }), 'canary');
        assert.equal(memoryModelV2Posture({ snapshot: await snapshotNow(), env: { ...env, CLIENT_CONFIG_FORCE_DISABLE: MEMORY_MODEL_V2_FLAG_KEY } }), 'kill', layerMessage(S, 1, 'the kill switch wins over a canary row'));
        await assert.rejects(() => stage(firmId, clientId, 'auto', 'dmem w2: must be refused'), /may not be staged 'auto'/, layerMessage(S, 1, 'authoritative (auto) is W6A\'s terminal — the plane refuses it now'));
        assert.equal(memoryModelV2Posture({ snapshot: await snapshotNow(), env }), 'canary', 'the refused write changed nothing');
      });

      // ── from here the client is canary: the fixture is the writer ──
      const written = await withFirmDbClient((client) => saveMemory({ client, tenantId: firmId, record: claimDraft(clientId), actor: { type: 'firm', id: 'dmem-w2' }, configSnapshot: canary, env }));
      assert.equal(written.status, 'persisted', JSON.stringify(written));
      const memoryId = written.write.memory_id;

      await t.test('same-source replay is authority-idempotent (INV-08) — one link, repeated corroboration, no freshness, generation unchanged', async () => {
        const row = (await appliance.query('select schema_version, applicability, evidence_fingerprint, claim_generation::int as claim_generation, last_confirmed_at from memories where memory_id = $1', [memoryId])).rows[0];
        assert.equal(row.schema_version, 'memory.v2');
        assert.deepEqual(row.applicability.jurisdiction, { kind: 'value', value: 'GB' });
        assert.deepEqual(row.applicability.currency, { kind: 'unspecified' }, 'undeclared dimensions are unspecified, never any');
        assert.equal(row.claim_generation, 1);
        const links = await withFirmDbClient((client) => listMemoryEvidenceLinks({ client, tenantId: firmId, memoryId }));
        assert.equal(links.length, 1);
        assert.equal(links[0].corroboration_class, 'independent');
        for (let i = 0; i < 2; i += 1) {
          const replay = await withFirmDbClient((client) => saveMemory({ client, tenantId: firmId, record: claimDraft(clientId), actor: { type: 'firm', id: 'dmem-w2' }, configSnapshot: canary, env }));
          assert.equal(replay.status, 'reasserted');
          assert.equal(replay.corroboration, 'repeated');
          assert.equal(replay.evidence_added, 0);
        }
        const after = (await appliance.query('select claim_generation::int as claim_generation, last_confirmed_at from memories where memory_id = $1', [memoryId])).rows[0];
        assert.equal(after.claim_generation, 1);
        assert.equal(String(after.last_confirmed_at), String(row.last_confirmed_at), 'no freshness from the same source');
        assert.equal((await withFirmDbClient((client) => listMemoryEvidenceLinks({ client, tenantId: firmId, memoryId }))).length, 1);
        // A second independent link per dependence group is refused IN THE DATABASE.
        await assert.rejects(
          () => appliance.query(
            `insert into memory_evidence_links (tenant_id, memory_id, evidence_id, evidence_kind, dependence_group, corroboration_class) values ($1, $2, 'evid-forged', 'transaction', $3, 'independent')`,
            [firmId, memoryId, links[0].dependence_group]
          ),
          /memory_evidence_links_one_independent_per_group_idx/,
          'one independent corroboration per dependence group'
        );
      });

      await t.test('concurrent supersession leaves exactly one current revision; the prior generation advances in the database', async () => {
        const [a, b] = await Promise.all([openClient(), openClient()]);
        const race = (client, value) => supersedeMemory({
          client, tenantId: firmId, priorMemoryId: memoryId,
          changes: { structured_value: { value_type: 'string', value }, source_text: `Acme Supplies now sells ${value}.`, source_refs: [{ transaction_id: `${clientId}-tx-acme-${value}` }] },
          actor: { type: 'firm', id: 'dmem-w2' }, configSnapshot: canary, env
        });
        const [ra, rb] = await Promise.all([race(a, 'software'), race(b, 'hardware')]);
        const outcomes = [ra.status, rb.status].sort();
        assert.deepEqual(outcomes.filter((s) => s === 'superseded'), ['superseded'], `exactly one winner: ${JSON.stringify([ra, rb])}`);
        const loser = ra.status === 'superseded' ? rb : ra;
        assert.equal(loser.status, 'refused', `the loser is refused loudly: ${JSON.stringify(loser)}`);
        assert.ok(loser.errors.some((e) => /no longer the active head|only the active head/.test(e)));
        const heads = (await appliance.query("select memory_id, revision, record_state, claim_generation::int as claim_generation from memories where tenant_id = $1 and owner_client_id = $2 order by revision", [firmId, clientId])).rows;
        assert.equal(heads.filter((h) => h.record_state === 'active').length, 1, 'one current revision');
        assert.equal(heads.length, 2);
        const prior = heads.find((h) => h.memory_id === memoryId);
        assert.equal(prior.record_state, 'superseded');
        assert.equal(prior.claim_generation, 2, 'the database advanced the superseded claim\'s generation (146)');
        await assert.rejects(() => appliance.query('update memories set claim_generation = 1 where memory_id = $1', [memoryId]), /never moves backwards/);
        const successor = heads.find((h) => h.record_state === 'active');
        const successorLinks = await withFirmDbClient((client) => listMemoryEvidenceLinks({ client, tenantId: firmId, memoryId: successor.memory_id }));
        assert.equal(successorLinks.length, 1, 'the successor carries its own evidence link');
      });

      const activeHead = async (ownerId) => (await appliance.query("select memory_id from memories where tenant_id = $1 and owner_client_id = $2 and record_state = 'active'", [firmId, ownerId])).rows[0]?.memory_id;

      await t.test('a cross-scope relation fails at the DATABASE boundary (143), through raw SQL and through the writer alike', async () => {
        const other = await withFirmDbClient((client) => saveMemory({ client, tenantId: firmId, record: claimDraft(otherClientId, { source_refs: [{ transaction_id: `${otherClientId}-tx-1` }] }), actor: { type: 'firm', id: 'dmem-w2' }, configSnapshot: { [MEMORY_MODEL_V2_FLAG_KEY]: { stage: 'canary', source: 'manual' } }, env }));
        assert.equal(other.status, 'persisted', JSON.stringify(other));
        const head = await activeHead(clientId);
        await assert.rejects(
          () => appliance.query(`insert into memory_relations (tenant_id, source_memory_id, relation, target_memory_id) values ($1, $2, 'contradicts', $3)`, [firmId, head, other.write.memory_id]),
          /memory_relations_scope: cross-owner relation refused/
        );
        await assert.rejects(
          () => withFirmDbClient((client) => linkMemoryRelation({ client, tenantId: firmId, sourceMemoryId: head, relation: 'contradicts', targetMemoryId: other.write.memory_id, actor: { type: 'firm', id: 'dmem-w2' }, configSnapshot: canary, env })),
          /cross-owner relation refused/,
          'the writer cannot bypass it'
        );
        assert.equal((await appliance.query("select count(*)::int as n from memory_relations where tenant_id = $1 and relation = 'contradicts'", [firmId])).rows[0].n, 0);
        assert.equal((await appliance.query("select epistemic_state from memories where memory_id = $1", [head])).rows[0].epistemic_state, 'asserted', 'the refused relation flipped nothing');
        // The same-slot supersedes edge the race wrote is same-owner and same-scope by construction.
        assert.equal((await appliance.query("select count(*)::int as n from memory_relations where tenant_id = $1 and relation = 'supersedes'", [firmId])).rows[0].n, 1);
      });

      await t.test('invalid temporal overlap and an unauthorized projection are refused (144); a projection\'s history is immutable', async () => {
        const head = await activeHead(clientId);
        const approval = (await appliance.query("select id from audit_events where firm_id = $1 and action = 'memory.record_superseded' and resource_id = $2", [firmId, head])).rows[0];
        assert.ok(approval?.id, 'the supersession left its receipt');
        const insert = (projectionId, { from = null, to = null, receipt = approval.id, sources = [{ memory_id: head, revision: 2, claim_generation: 1 }], state = 'current' } = {}) => appliance.query(
          `insert into memory_projections (projection_id, tenant_id, owner_client_id, projection_kind, logical_slot, revision, source_revision_set, source_revision_set_digest, approval_receipt_id, approval_actor_type, current_state, effective_from, effective_to, rebuild_digest, superseded_at)
           values ($1, $2, $3, 'client_rule', 'merchant:acme', (select coalesce(max(revision), 0) + 1 from memory_projections where tenant_id = $2 and projection_kind = 'client_rule' and logical_slot = 'merchant:acme'), $4::jsonb, $5, $6, 'firm', $7, $8::date, $9::date, $10, case when $7 = 'current' then null else now() end)`,
          [projectionId, firmId, clientId, JSON.stringify(sources), canonicalDigest(sources.map((s) => s.memory_id)), receipt, state, from, to, canonicalDigest({ projectionId, from, to })]
        );
        await assert.rejects(() => insert('proj-no-receipt', { receipt: 999999999 }), /memory_projections_unauthorized: approval_receipt_id/, 'no confirmation receipt → refused');
        await assert.rejects(() => insert('proj-orphan-source', { sources: [{ memory_id: 'mem-does-not-exist', revision: 1, claim_generation: 1 }] }), /memory_projections_unauthorized: source claim .* does not exist/);
        // A claim of ANOTHER tenant as the source: copy the head under a foreign firm.
        await appliance.query("insert into firms (id, name, slug, jurisdiction, default_currency) values ('dmem-w2-other-firm', 'Other', 'dmem-w2-other-firm', 'GB', 'GBP') on conflict do nothing");
        await appliance.query(
          `insert into memories select * from jsonb_populate_record(null::memories, (select to_jsonb(m) || '{"memory_id":"mem-foreign-w2","memory_key":"memk-foreign-w2","tenant_id":"dmem-w2-other-firm"}'::jsonb from memories m where m.memory_id = $1))`,
          [head]
        );
        await assert.rejects(() => insert('proj-foreign-source', { sources: [{ memory_id: 'mem-foreign-w2', revision: 2, claim_generation: 1 }] }), /belongs to tenant dmem-w2-other-firm/);
        await insert('proj-h1', { from: '2026-01-01', to: '2026-07-01' });
        await assert.rejects(() => insert('proj-overlap', { from: '2026-06-01', to: null }), /memory_projections_temporal_overlap/, 'an overlapping current interval on the slot is refused');
        await insert('proj-h2', { from: '2026-07-01', to: null });
        assert.equal((await appliance.query("select count(*)::int as n from memory_projections where tenant_id = $1 and current_state = 'current'", [firmId])).rows[0].n, 2, 'disjoint intervals coexist on one slot');
        await assert.rejects(() => appliance.query("update memory_projections set rebuild_digest = 'edited' where projection_id = 'proj-h1'"), /memory_projections_frozen/);
        await appliance.query("update memory_projections set current_state = 'superseded', superseded_at = now() where projection_id = 'proj-h1'");
        await assert.rejects(() => appliance.query("update memory_projections set current_state = 'current', superseded_at = null where projection_id = 'proj-h1'"), /not a forward transition/);
        await assert.rejects(() => appliance.query("delete from memory_projections where projection_id = 'proj-h1'"), /memory_projections_append_only/);
        await assert.rejects(() => appliance.query("update memories set effective_from = '2026-07-01', effective_to = '2026-07-01' where memory_id = $1", [head]), /memories_effective_interval_half_open/);
      });

      await t.test('an orphan dependency write is refused (143); a dependency only moves forward', async () => {
        const head = await activeHead(clientId);
        await assert.rejects(
          () => appliance.query(`insert into memory_dependencies (tenant_id, memory_id, memory_revision, dependent_kind, dependent_id, claim_generation) values ($1, $2, 2, 'match', 'match-does-not-exist', 1)`, [firmId, head]),
          /memory_dependencies_orphan: match match-does-not-exist does not exist/
        );
        await assert.rejects(
          () => appliance.query(`insert into memory_dependencies (tenant_id, memory_id, memory_revision, dependent_kind, dependent_id, claim_generation) values ($1, 'mem-does-not-exist', 1, 'rule', 'r', 1)`, [firmId]),
          /memory_dependencies_scope: memory mem-does-not-exist does not exist|memory_dependencies_memory_id_fkey/
        );
        await assert.rejects(
          () => appliance.query(`insert into memory_dependencies (tenant_id, memory_id, memory_revision, dependent_kind, dependent_id, claim_generation) values ('dmem-w2-other-firm', $1, 2, 'rule', 'r', 1)`, [head]),
          /does not match the claim tenant/
        );
        const decision = (await appliance.query(
          `insert into llm_decisions (id, firm_id, client_id, decision_type, target_type, target_id) values ($1, $2, $3, 'coding', 'transaction', $4) returning id`,
          [`dmem-w2-decision-${clientId}`, firmId, clientId, `${clientId}-tx-acme-1`]
        )).rows[0];
        const dep = (await appliance.query(
          `insert into memory_dependencies (tenant_id, memory_id, memory_revision, dependent_kind, dependent_id, claim_generation) values ($1, $2, 2, 'decision', $3, 1) returning id`,
          [firmId, head, decision.id]
        )).rows[0];
        await assert.rejects(() => appliance.query("update memory_dependencies set dependent_id = 'other' where id = $1", [dep.id]), /memory_dependencies_frozen/);
        await appliance.query("update memory_dependencies set state = 'stale', invalidated_at = now(), invalidation_reason = 'dmem w2' where id = $1", [dep.id]);
        await assert.rejects(() => appliance.query("update memory_dependencies set state = 'current', invalidated_at = null where id = $1", [dep.id]), /not a forward transition/);
        await assert.rejects(() => appliance.query('delete from memory_dependencies where id = $1', [dep.id]), /memory_dependencies_append_only/);
      });

      await t.test('mutable history is refused: evidence links, candidate events, envelopes and results are append-only in the database', async () => {
        const head = await activeHead(clientId);
        const link = (await appliance.query('select id from memory_evidence_links where memory_id = $1 limit 1', [head])).rows[0];
        await assert.rejects(() => appliance.query("update memory_evidence_links set corroboration_class = 'independent' where id = $1", [link.id]), /memory_evidence_links_append_only/);
        await assert.rejects(() => appliance.query('delete from memory_evidence_links where id = $1', [link.id]), /memory_evidence_links_append_only/);
        const envelopeInput = { prompt: 'code the line', line: `${clientId}-tx-acme-1` };
        const inputDigest = canonicalDigest(envelopeInput);
        await appliance.query(
          `insert into decision_envelopes (envelope_id, firm_id, client_id, decision_kind, purpose, scope, as_of, claim_generations, input_kind, input_payload, input_digest, envelope_digest)
           values ('env-w2-1', $1, $2, 'coding', 'coding', '{}'::jsonb, now(), $3::jsonb, 'outbound_payload', $4::jsonb, $5, $6)`,
          [firmId, clientId, JSON.stringify({ [head]: 2 }), JSON.stringify(envelopeInput), inputDigest, canonicalDigest({ envelope: 'env-w2-1', inputDigest })]
        );
        await assert.rejects(() => appliance.query("update decision_envelopes set purpose = 'x' where envelope_id = 'env-w2-1'"), /decision_envelopes_immutable/);
        await assert.rejects(() => appliance.query("delete from decision_envelopes where envelope_id = 'env-w2-1'"), /decision_envelopes_immutable/);
        await assert.rejects(
          () => appliance.query(`insert into decision_envelopes (envelope_id, firm_id, decision_kind, purpose, as_of, input_kind, input_payload, input_digest, envelope_digest) values ('env-w2-bad', $1, 'coding', 'coding', now(), 'outbound_payload', '{}'::jsonb, 'same', 'same')`, [firmId]),
          /decision_envelopes_digests_distinct/, 'the envelope digest is distinct from the nested input digest (INV-28)'
        );
        await assert.rejects(
          () => appliance.query(`insert into decision_results (result_id, firm_id, envelope_id, ordinal, result_kind, adapter_input_digest) values ('res-w2-forged', $1, 'env-w2-1', 1, 'attempt', 'not-the-envelope-digest')`, [firmId]),
          /does not equal the envelope input digest/
        );
        await appliance.query(`insert into decision_results (result_id, firm_id, envelope_id, ordinal, result_kind, adapter_input_digest, outcome) values ('res-w2-1', $1, 'env-w2-1', 1, 'attempt', $2, 'ok')`, [firmId, inputDigest]);
        await assert.rejects(() => appliance.query(`insert into decision_results (result_id, firm_id, envelope_id, ordinal, result_kind) values ('res-w2-dup', $1, 'env-w2-1', 1, 'response')`, [firmId]), /decision_results_envelope_ordinal_idx/, 'ordinals are exactly 1..n');
        await assert.rejects(() => appliance.query("update decision_results set outcome = 'edited' where result_id = 'res-w2-1'"), /decision_results_immutable/);
        await assert.rejects(() => appliance.query("delete from decision_results where result_id = 'res-w2-1'"), /decision_results_immutable/);
      });

      await t.test('false delivery is refused when armed, and the unarmed writers are byte-identical (147)', async () => {
        const client = await openClient();
        const askInsert = (id, { sent = true } = {}) => client.query(
          `insert into client_evidence_requests (id, firm_id, client_id, status, evidence_type, question, request_payload, first_sent_at, last_sent_at, send_count)
           values ($1, $2, $3, 'open', 'supporting_document', 'Which receipt covers this?', $4::jsonb, $5, $5, 0)`,
          [id, firmId, clientId, JSON.stringify(sent ? { sent_at: Date.now() } : {}), sent ? new Date().toISOString() : null]
        );
        // Unarmed (the tree today): the F-11 shape is accepted — no behaviour change while dark.
        await TX(client, () => askInsert(`${clientId}-ask-legacy`));
        assert.equal((await appliance.query('select send_count from client_evidence_requests where id = $1', [`${clientId}-ask-legacy`])).rows[0].send_count, 0);
        // Armed through the resolver: only a canary/authoritative posture arms; the GUC is transaction-local.
        const armedOff = await TX(client, () => armDeliveryStateConstraints(client, { snapshot: {}, env }));
        assert.deepEqual(armedOff, { armed: false, posture: 'off' });
        await assert.rejects(
          () => TX(client, async () => {
            const armed = await armDeliveryStateConstraints(client, { snapshot: canary, env });
            assert.deepEqual(armed, { armed: true, posture: 'canary' });
            assert.equal((await client.query('select current_setting($1, true) as v', [DELIVERY_STATE_CONSTRAINTS_GUC])).rows[0].v, 'enforce');
            await askInsert(`${clientId}-ask-false-sent`);
          }),
          /client_evidence_requests_delivery_state: ask .* claims a sent state .* with no channel receipt/,
          'a sent stamp with no channel receipt fails the COMMIT'
        );
        assert.equal((await appliance.query('select count(*)::int as n from client_evidence_requests where id = $1', [`${clientId}-ask-false-sent`])).rows[0].n, 0, 'nothing committed');
        assert.equal((await client.query('select current_setting($1, true) as v', [DELIVERY_STATE_CONSTRAINTS_GUC])).rows[0].v ?? '', '', 'the GUC did not outlive the transaction');
        // Armed, honest: the deliverer's receipt makes the stamp true — in either order.
        await TX(client, async () => {
          await armDeliveryStateConstraints(client, { snapshot: canary, env });
          await askInsert(`${clientId}-ask-honest`);
          await client.query(
            `insert into message_delivery_ledger (id, message_id, channel, provider, ask_id, client_id, sent_at) values ($1, $2, 'email', 'resend', $3, $4, now())`,
            [`mdl-${clientId}-honest`, `msg-${clientId}-honest`, `${clientId}-ask-honest`, clientId]
          );
        });
        assert.equal((await appliance.query('select count(*)::int as n from client_evidence_requests where id = $1', [`${clientId}-ask-honest`])).rows[0].n, 1);
        // Armed, a draft with no sent claim needs no receipt.
        await TX(client, async () => {
          await armDeliveryStateConstraints(client, { snapshot: canary, env });
          await askInsert(`${clientId}-ask-draft`, { sent: false });
        });
      });

      await t.test('the local-job claim is a generation-checked compare-and-swap: a stale generation loses; two claimers on one generation resolve to one winner', async () => {
        const [a, b] = await Promise.all([openClient(), openClient()]);
        const functionId = 'dmem-w2-fixture-job';
        const job = await enqueueLocalJob({ client: a, functionId, payload: { firm_id: firmId, client_id: clientId }, dedupeKey: `dmem-w2-${clientId}` });
        assert.ok(job?.id);
        assert.equal(Number(job.claim_generation), 1, 'born at generation 1 (146)');
        const bumped = await bumpLocalJobClaimGeneration({ client: a, jobId: job.id });
        assert.equal(bumped.claim_generation, 2, 'an invalidation advances the generation');
        const stale = await claimNextLocalJob({ client: a, workerId: 'stale-worker', eligibleFunctionIds: [functionId], jobId: job.id, expectedClaimGeneration: 1 });
        assert.equal(stale, null, 'a claimer holding the old generation loses the claim');
        assert.equal((await appliance.query('select status, attempt_count from local_jobs where id = $1', [job.id])).rows[0].status, 'pending', 'the lost claim spent nothing');
        const [ca, cb] = await Promise.all([
          claimNextLocalJob({ client: a, workerId: 'worker-a', eligibleFunctionIds: [functionId], jobId: job.id, expectedClaimGeneration: 2 }),
          claimNextLocalJob({ client: b, workerId: 'worker-b', eligibleFunctionIds: [functionId], jobId: job.id, expectedClaimGeneration: 2 })
        ]);
        const winners = [ca, cb].filter(Boolean);
        assert.equal(winners.length, 1, `exactly one claimer wins the same generation: ${JSON.stringify([ca?.locked_by, cb?.locked_by])}`);
        assert.equal(winners[0].status, 'running');
        assert.equal(Number(winners[0].claim_generation), 2);
        assert.equal(await bumpLocalJobClaimGeneration({ client: a, jobId: job.id }), null, 'past the fence: an in-flight conflict, never a cancellation');
        // The legacy claim (no fence) is untouched: a fresh pending job is claimed as before.
        const legacy = await enqueueLocalJob({ client: a, functionId, payload: {}, dedupeKey: `dmem-w2-legacy-${clientId}` });
        const claimed = await claimNextLocalJob({ client: b, workerId: 'legacy-worker', eligibleFunctionIds: [functionId] });
        assert.equal(claimed?.id, legacy.id);
      });

      await t.test('the claim generation advances in the database on every lifecycle move (146)', async () => {
        const head = await activeHead(clientId);
        const before = (await appliance.query('select claim_generation::int as g from memories where memory_id = $1', [head])).rows[0].g;
        const dismissed = await withFirmDbClient((client) => dismissMemory({ client, tenantId: firmId, memoryId: head, reason: 'dmem w2', actor: { type: 'firm', id: 'dmem-w2' }, configSnapshot: canary, env }));
        assert.equal(dismissed.status, 'dismissed');
        const after = (await appliance.query('select claim_generation::int as g from memories where memory_id = $1', [head])).rows[0].g;
        assert.equal(after, before + 1);
      });
    } finally {
      for (const client of extra) await client.end().catch(() => {});
      await appliance.stop();
    }
  }
);
