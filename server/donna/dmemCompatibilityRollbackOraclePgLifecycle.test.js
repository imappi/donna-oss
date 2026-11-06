// DMEM-R1 W0 — CR-01, the compatibility-rollback oracle (plan v1.0 §7 W0 "the
// dedicated compatibility-rollback oracle"; W2 exit "feature-disable rollback
// preserves graph hashes"; W5 exit "rollback to the compatibility projection
// succeeds without losing canonical writes"; docs/audit-2026-09-04-memory-re-baseline.md
// §3 row 9, §6.2 rollback RTO/RPO).
//
// EXPECTED FAILURE on the current tree (registered in scripts/run-tests.mjs), with
// the rollback halves PINNED. Under a canary posture a canonical claim is written
// through the REAL V2 writer; the graph hash (§6.1) of the canonical plane is
// frozen; the posture is rolled back to `off` through the ONE audited stage
// writer; then restored. What holds: the rollback refuses new canonical writes,
// the graph hash is identical before and after (from DMEM-R1 W2 the hash spans the
// evidence links, dependency rows, projections and candidate events too — the
// W2 exit-gate item "feature-disable rollback preserves the graph hash"), the
// claim is served again when the posture returns. What does not: after a canonical write the compatibility
// projection (`firm_facts`, the legacy readers' home) carries NO projected row —
// `memories` and `firm_facts` are unrelated on this tree, so a rollback to the
// legacy readers loses the claim from every prompt (map §6 move 1 is W3's).

import test from 'node:test';
import assert from 'node:assert/strict';

import { bootApplianceForTest, applianceHarnessSkipReason } from './testSupport/applianceHarness.js';
import { canonicalDigest, expectedFailure, layerMessage } from './testSupport/dmemFixtureSupport.js';
import { withFirmDbClient } from './firmDb.js';
import { getFirmFactsForSubjects } from './firmFacts.js';
import { MEMORY_MODEL_V2_FLAG_KEY, saveMemory } from './memoriesDb.js';
import { readClientConfigSnapshot, setClientFlagStage } from './clientConfig.js';

const S = 'CR-01';
export const CR01_FINGERPRINTS = Object.freeze({
  L1: layerMessage(S, 1, 'after a canonical claim is written, the compatibility projection (firm_facts) carries its projected row for the legacy readers')
});
const ENV = { MEMORY_KEY_HMAC_SECRET: 'dmem-w0-hmac' };

// The graph hash covers the whole canonical graph — from DMEM-R1 W2 also the
// evidence links, dependency rows, projections and candidate events (migrations
// 141–144), so a rollback that lost a W2 row would show.
const graphHash = async (query, firmId) => {
  const memories = (await query(
    "select memory_id, memory_key, revision, content_hash, record_state, supersedes_memory_id, claim_generation::text as claim_generation, evidence_fingerprint from memories where tenant_id = $1 order by memory_key, revision",
    [firmId]
  )).rows;
  const relations = (await query(
    'select source_memory_id, relation, target_memory_id from memory_relations where tenant_id = $1 order by source_memory_id, relation, target_memory_id',
    [firmId]
  )).rows;
  const evidence = (await query(
    'select memory_id, evidence_id, dependence_group, corroboration_class from memory_evidence_links where tenant_id = $1 order by memory_id, evidence_id',
    [firmId]
  )).rows;
  const dependencies = (await query(
    'select memory_id, dependent_kind, dependent_id, state from memory_dependencies where tenant_id = $1 order by memory_id, dependent_kind, dependent_id',
    [firmId]
  )).rows;
  const projections = (await query(
    'select projection_id, projection_kind, logical_slot, revision, current_state, rebuild_digest from memory_projections where tenant_id = $1 order by projection_id',
    [firmId]
  )).rows;
  const candidateEvents = (await query(
    'select candidate_id, event_seq, event_type, to_status from memory_candidate_events where firm_id = $1 order by candidate_id, event_seq',
    [firmId]
  )).rows;
  return {
    hash: canonicalDigest({ memories, relations, evidence, dependencies, projections, candidateEvents }),
    memories: memories.length, relations: relations.length, evidence: evidence.length,
    dependencies: dependencies.length, projections: projections.length, candidateEvents: candidateEvents.length
  };
};

const stage = (firmId, clientId, stageName, reason) => withFirmDbClient(async (client) => {
  await client.query('begin');
  try {
    await setClientFlagStage(client, { firmId, clientId, flagKey: MEMORY_MODEL_V2_FLAG_KEY, stage: stageName, source: 'manual', reason, actorType: 'system', actorId: 'dmem-w0' });
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
});

test(
  'real PG (appliance, DMEM CR-01): a feature-disable rollback keeps every canonical write, but the legacy readers never saw the claim',
  { skip: applianceHarnessSkipReason() },
  async (t) => {
    const appliance = await bootApplianceForTest({ now: new Date('2026-09-04T09:00:00.000Z') });
    try {
      const { firmId } = appliance;
      const { clientId } = await appliance.createClient();
      const env = { ...process.env, ...ENV };
      const record = {
        scope_type: 'legal_entity', scope_id: clientId, lifecycle_owner_type: 'legal_entity', lifecycle_owner_id: clientId,
        subject_type: 'merchant', subject_id: 'acme-supplies', observed_alias: 'ACME SUPPLIES LTD',
        kind: 'assertion', predicate: 'supplier_category',
        structured_value: { value_type: 'string', value: 'stationery' }, source_text: 'Acme Supplies sells stationery to the studio.',
        source_refs: [{ transaction_id: `${clientId}-tx-acme-1` }], asserted_by_principal_id: 'dmem-w0', assertion_origin: 'owner_asserted',
        observed_at: '2026-09-01T10:00:00.000Z', assertion_confidence: 'high', confidentiality: 'internal', personal_data_class: 'none'
      };
      const save = async () => withFirmDbClient(async (client) => {
        const configSnapshot = await readClientConfigSnapshot(client, { firmId, clientId });
        return saveMemory({ client, tenantId: firmId, record, actor: { type: 'firm', id: 'dmem-w0' }, configSnapshot, env });
      });
      const legacyFacts = () => withFirmDbClient((client) => getFirmFactsForSubjects({ client, firmId, clientId, subjects: [{ scope: 'merchant', value: 'ACME SUPPLIES LTD' }] }));

      await stage(firmId, clientId, 'canary', 'dmem w0 rollback oracle: the canonical plane acts');
      const written = await save();
      assert.equal(written.status, 'persisted', `the canonical claim persisted under canary: ${JSON.stringify(written)}`);
      // DMEM-R1 W2: the canonical write also linked its evidence and (through the
      // fixture, the only writer W2 has) a dependency row and a projection revision —
      // the graph a rollback must preserve is the whole of it.
      const memoryId = written.write.memory_id;
      const approval = (await appliance.query("select id from audit_events where firm_id = $1 and action = 'memory.record_saved' and resource_id = $2", [firmId, memoryId])).rows[0];
      assert.ok(approval?.id, 'the canonical write left its receipt');
      await appliance.query(
        `insert into memory_dependencies (tenant_id, memory_id, memory_revision, dependent_kind, dependent_id, claim_generation)
         values ($1, $2, 1, 'decision', $3, 1)`,
        [firmId, memoryId, (await appliance.query(
          `insert into llm_decisions (id, firm_id, client_id, decision_type, target_type, target_id) values ($1, $2, $3, 'coding', 'transaction', $4) returning id`,
          [`dmem-cr01-decision-${clientId}`, firmId, clientId, `${clientId}-tx-acme-1`]
        )).rows[0].id]
      );
      await appliance.query(
        `insert into memory_projections (projection_id, tenant_id, owner_client_id, projection_kind, logical_slot, revision, source_revision_set, source_revision_set_digest, claim_generation, approval_receipt_id, approval_actor_type, approval_actor_id, rebuild_digest)
         values ($1, $2, $3, 'firm_fact', $4, 1, $5::jsonb, $6, 1, $7, 'firm', 'dmem-w2', $8)`,
        [`proj-${memoryId}`, firmId, clientId, `merchant:acme-supplies:supplier_category`, JSON.stringify([{ memory_id: memoryId, revision: 1, claim_generation: 1 }]),
          canonicalDigest([memoryId]), approval.id, canonicalDigest({ fact: 'stationery' })]
      );
      const frozen = await graphHash(appliance.query, firmId);
      assert.equal(frozen.memories, 1, 'one canonical revision');
      assert.equal(frozen.evidence, 1, 'the write linked its one evidence identity (W2)');
      assert.equal(frozen.dependencies, 1);
      assert.equal(frozen.projections, 1);

      await t.test('L1 database state — the compatibility projection carries the canonical claim', () => expectedFailure({ id: `${S}/L1`, fingerprint: CR01_FINGERPRINTS.L1 }, async () => {
        const projected = await legacyFacts();
        assert.equal(projected.length, 1, CR01_FINGERPRINTS.L1);
        assert.match(projected[0].fact, /stationery/, layerMessage(S, 1, 'the projected row renders the claim'));
      }));

      // ── Rollback: the posture goes off through the ONE audited writer. ──
      await stage(firmId, clientId, 'off', 'dmem w0 rollback oracle: feature-disable rollback');
      await t.test('L1b rollback — the disabled posture refuses new canonical writes and loses none', async () => {
        const refused = await save();
        assert.equal(refused.status, 'flag_off', layerMessage(S, 1, `a canonical write is refused while rolled back: ${JSON.stringify(refused)}`));
        const after = await graphHash(appliance.query, firmId);
        assert.equal(after.hash, frozen.hash, layerMessage(S, 1, 'the graph hash is identical after the rollback (RPO 0)'));
        // DMEM-R1 W2 exit gate: feature-disable rollback preserves the WHOLE graph —
        // the W2 stores included — and the dark posture is what the resolver says.
        const { memoryModelV2Posture } = await import('./memoriesDb.js');
        const snapshot = await withFirmDbClient((client) => readClientConfigSnapshot(client, { firmId, clientId }));
        assert.equal(memoryModelV2Posture({ snapshot }), 'off', layerMessage(S, 1, 'the rolled-back posture is off through the one resolver'));
        assert.deepEqual(
          { evidence: after.evidence, dependencies: after.dependencies, projections: after.projections },
          { evidence: 1, dependencies: 1, projections: 1 },
          layerMessage(S, 1, 'every W2 row survives the rollback')
        );
        const receipts = await appliance.read.audit({ clientId, action: 'client_config.stage_set' });
        assert.ok(receipts.length >= 2, layerMessage(S, 1, 'every stage move is receipted'));
      });

      await t.test('L2 retrieval — the legacy readers serve the same set before and after the rollback', async () => {
        const during = await legacyFacts();
        assert.deepEqual(during.map((row) => row.id), [], layerMessage(S, 2, 'the legacy readers never carried the claim, so the rollback changes nothing they serve'));
      });

      // ── Restore: the claim is served again, unchanged. ──
      await stage(firmId, clientId, 'canary', 'dmem w0 rollback oracle: restore');
      await t.test('L1c restore — the canonical write survives the round trip', async () => {
        const restored = await graphHash(appliance.query, firmId);
        assert.equal(restored.hash, frozen.hash, layerMessage(S, 1, 'the graph hash is identical after the restore'));
        const again = await save();
        assert.equal(again.status, 'reasserted', layerMessage(S, 1, `the same claim is recognised as the slot head after the restore: ${JSON.stringify(again)}`));
      });
    } finally {
      await appliance.stop();
    }
  }
);
