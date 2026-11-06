// DMEM-R1 W0 — S08, the full lifecycle: acquire → candidate → promote → retrieve →
// decide → correct → supersede → replay → erase (forensic §13.8;
// docs/audit-2026-09-04-memory-re-baseline.md §1 F-02 / F-04 / F-06 / F-10 / F-14 /
// F-15, canaries 14–15; ACC-F02, F04, F06, F10, F14, F15, ACC-C14, ACC-C15).
//
// EXPECTED FAILURE + REGISTERED GAP on the current tree (registered in
// scripts/run-tests.mjs). The V2 plane (`memory_candidates` → `memories`) driven
// through its REAL writers under a canary posture on the harness firm: staging,
// promotion, the governed retrieval seam the owner turn uses, supersession and
// erasure. What holds: a suggested candidate is excluded from retrieval, promotion
// mints one active revision, supersession leaves one active revision, erasure
// scrubs the memory. The same learning staged by two legal
// entities now yields distinct candidates (G-1 closes the F-04 identity leg); the
// owner prompt packet drops origin / trust / epistemic state (F-15); no
// pre-action receipt of the prompt-time set exists before the owner turn's model
// call (F-06); erasure leaves the candidate's content standing (F-14). Exact
// replay of the owner turn is a REGISTERED_GAP (no replay entry point for a turn
// beyond the artifact script whose classifier throws). CLOSED by DMEM-R1 W1
// (2026-09-04): the producer and the governance API resolve ONE posture — the
// MEMORY_CANDIDATES plane key (F-10) — a plain assertion below.

import test from 'node:test';
import assert from 'node:assert/strict';

import { bootApplianceForTest, applianceHarnessSkipReason } from './testSupport/applianceHarness.js';
import { expectedFailure, layerMessage, registeredGap } from './testSupport/dmemFixtureSupport.js';
import { withFirmDbClient } from './firmDb.js';
import {
  memoryCandidatesGovernanceMayAct, memoryCandidatesProducerMayStage, promoteMemoryCandidate,
  resolveMemoryCandidatesPosture, stageMemoryCandidate
} from './memoryCandidates.js';
import { MEMORY_MODEL_V2_FLAG_KEY, eraseUserMemories, supersedeMemory } from './memoriesDb.js';
import { MEMORY_RETRIEVAL_V2_FLAG_KEY, buildMemoryBundle } from './memoryRetrieval.js';
import { makeMemoryRetrievalShadowDeps, captureRetrievalRequestSnapshot, invocationFromSnapshot } from './memoryRetrievalShadow.js';
import { renderRecordedFactsFromBundle } from './ownerMemoryRender.js';
import { isLoopSystemEnabled } from './loopExecutionGate.js';
import { setClientFlagStage } from './clientConfig.js';
import { buildScopedCandidateIdentity, evidenceFromSourceRefs, evidenceSetFingerprint } from './memoryModel.js';

const S = 'S08';
export const S08_FINGERPRINTS = Object.freeze({
  L1_identity: layerMessage(S, 1, 'the same learning staged by two legal entities yields two candidates (candidate identity includes the lifecycle owner)'),
  L1_posture: layerMessage(S, 1, 'the candidate producer and the governance API resolve ONE capability posture on the appliance env'),
  L1_erase: layerMessage(S, 1, 'erasure reaches every content-bearing copy: the promoted candidate\'s subject, fact and contract_payload are scrubbed'),
  L2: layerMessage(S, 2, 'the owner prompt packet preserves each fact\'s origin, trust and epistemic state labels'),
  L3: layerMessage(S, 3, 'the prompt-time retrieval set is persisted as an immutable pre-action receipt before the owner turn\'s model call'),
  GAP: 'no replay entry point re-executes an owner turn against its recorded pre-action set on this tree (the artifact script re-queries live rows and its classifier throws); exact replay is a W5 deliverable over the W4 envelope'
});

const ENV = { MEMORY_KEY_HMAC_SECRET: 'dmem-w0-hmac' };
const TX = (client, fn) => (async () => {
  await client.query('begin');
  try {
    const out = await fn();
    await client.query('commit');
    return out;
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
})();

const contractPayloadFor = (clientId) => ({
  lifecycle_owner_type: 'legal_entity', lifecycle_owner_id: clientId,
  scope_type: 'legal_entity', scope_id: clientId,
  subject_type: 'legal_entity', subject_id: clientId, observed_alias: null,
  // A contextual predicate with a SAFE structured renderer: the owner purpose
  // (portal_owner_context) permits no free text, so a string value is excluded
  // as unrenderable_free_text_not_permitted BY DESIGN — policy, not the finding.
  kind: 'assertion', predicate: 'anniversary',
  structured_value: { value_type: 'anniversary', value: { month: 3, day: 31 } },
  source_text: 'The company celebrates its founding anniversary on 31 March.',
  source_refs: [{ message_id: `${clientId}-msg-1` }],
  asserted_by_principal_id: `${clientId}-owner`, assertion_origin: 'owner_asserted',
  observed_at: '2026-09-01T10:00:00.000Z', assertion_confidence: 'high',
  // 'verified' (the owner confirmed it) so the use-decision matrix admits the
  // claim as a context_item; an 'asserted' record is routed to
  // confirmation_candidates BY DESIGN (memoryRetrieval.js decideUse), which the
  // owner render deliberately never reads — that is policy, not the finding.
  epistemic_state: 'verified', truth_confidence: 'high',
  confidentiality: 'internal', personal_data_class: 'none'
});

test(
  'real PG (appliance, DMEM S08): the V2 lifecycle runs end to end with cross-entity, posture, prompt-label, receipt and erasure gaps',
  { skip: applianceHarnessSkipReason() },
  async (t) => {
    const appliance = await bootApplianceForTest({ now: new Date('2026-09-04T09:00:00.000Z') });
    try {
      const { firmId } = appliance;
      const { clientId } = await appliance.createClient();
      const { clientId: otherClientId } = await appliance.createClient({ profile: { companyName: 'Dune Apparel Ltd' } });
      const env = { ...process.env, ...ENV };
      // The canary posture on the plane, through the ONE audited writer.
      await withFirmDbClient((client) => TX(client, async () => {
        await setClientFlagStage(client, { firmId, clientId, flagKey: MEMORY_MODEL_V2_FLAG_KEY, stage: 'canary', source: 'manual', reason: 'dmem w0 lifecycle fixture', actorType: 'system', actorId: 'dmem-w0' });
        await setClientFlagStage(client, { firmId, clientId, flagKey: MEMORY_RETRIEVAL_V2_FLAG_KEY, stage: 'canary', source: 'manual', reason: 'dmem w0 lifecycle fixture', actorType: 'system', actorId: 'dmem-w0' });
      }));
      const configSnapshot = { [MEMORY_MODEL_V2_FLAG_KEY]: { stage: 'canary', source: 'manual' }, [MEMORY_RETRIEVAL_V2_FLAG_KEY]: { stage: 'canary', source: 'manual' } };

      // ── acquire → candidate ──
      const staged = await withFirmDbClient((client) => TX(client, () => stageMemoryCandidate({
        client, firmId, clientId, candidateType: 'fact', status: 'suggested', source: 'dmem_w0_owner_turn',
        targetContract: 'memory', contractPayload: contractPayloadFor(clientId), provenance: { source: 'dmem_w0' }
      })));
      assert.ok(staged?.id && staged.inserted, 'the candidate was staged');
      // The LIVE acquisition path (onMemoryFactDistilled) stages firm_fact-targeted
      // candidates: the same merchant learning staged by two legal entities.
      const legacyStage = (forClientId) => withFirmDbClient((client) => TX(client, () => stageMemoryCandidate({
        client, firmId, clientId: forClientId, candidateType: 'fact', status: 'suggested', source: 'dmem_w0_distiller',
        scope: 'merchant', subject: 'ACME SUPPLIES LTD', fact: 'Acme Supplies sells stationery to the studio.', confidence: 'medium',
        provenance: { source: 'dmem_w0', client_id: forClientId }
      })));
      const legacyForClient = await legacyStage(clientId);
      const legacyForOther = await legacyStage(otherClientId);

      const retrieve = async () => withFirmDbClient(async (client) => {
        const snapshot = captureRetrievalRequestSnapshot({
          firmId, clientId, sourceMessageId: `${clientId}-msg-1`,
          ownerPrincipal: { principalType: 'firm_member', principalId: appliance.memberId },
          occurredAt: new Date('2026-09-04T09:05:00.000Z')
        });
        const { trustedContext, request } = invocationFromSnapshot({ snapshot, resolvedConfigSnapshotId: null });
        return buildMemoryBundle({ trustedContext, request, deps: makeMemoryRetrievalShadowDeps({ client, env }) });
      });

      await t.test('L1 database state — the same learning on two legal entities is two candidates', async () => {
        assert.ok(legacyForClient?.id && legacyForClient.inserted, layerMessage(S, 1, 'the first entity staged its learning'));
        assert.ok(legacyForOther?.id, layerMessage(S, 1, 'the other entity staged its own learning'));
        assert.notEqual(legacyForOther.id, legacyForClient.id, S08_FINGERPRINTS.L1_identity);
        assert.equal(legacyForOther.inserted, true, S08_FINGERPRINTS.L1_identity);
        const row = (await appliance.query('select client_id from memory_candidates where firm_id = $1 and id = $2', [firmId, legacyForClient.id])).rows[0];
        assert.equal(row.client_id, clientId, layerMessage(S, 1, 'the first entity still owns its candidate'));
      });

      // DMEM-R1 W2 (migration 141 + memoryModel.js buildScopedCandidateIdentity): the
      // SUBSTRATE of L1-identity — a scoped identity column on memory_candidates and a
      // deterministic identity that includes the legal entity. Plain assertions; the
      // wiring of memoryCandidates.js onto it is sequenced after W1 (audit §4.3) and
      // G-1 now wires both the identity and the lifecycle events.
      await t.test('L1 identity substrate (W2) — memory_candidates carries a scoped identity, and the v2 identity differs across legal entities', async () => {
        const columns = new Set((await appliance.query("select column_name from information_schema.columns where table_name = 'memory_candidates'")).rows.map((row) => row.column_name));
        for (const column of ['scoped_identity', 'subject_class', 'applicability', 'evidence_fingerprint', 'dependence_group', 'candidate_version', 'expected_claim_generation']) {
          assert.ok(columns.has(column), layerMessage(S, 1, `memory_candidates.${column} exists (migration 141 / 146)`));
        }
        const identityFor = (legalEntityId) => buildScopedCandidateIdentity({
          tenantId: firmId, legalEntityId, subjectClass: 'merchant_fact', applicability: { jurisdiction: 'GB' },
          normalizedValue: { scope: 'merchant', subject: 'ACME SUPPLIES LTD', fact: 'Acme Supplies sells stationery to the studio.' },
          evidenceFingerprint: evidenceSetFingerprint(evidenceFromSourceRefs([{ transaction_id: `${clientId}-tx-acme-1` }]))
        });
        assert.notEqual(identityFor(clientId), identityFor(otherClientId), layerMessage(S, 1, 'the same learning on two legal entities is two scoped identities'));
        assert.equal(identityFor(clientId), identityFor(clientId), layerMessage(S, 1, 'deterministic'));
        assert.ok((await appliance.query('select scoped_identity from memory_candidates where firm_id = $1 and id = $2', [firmId, legacyForClient.id])).rows[0].scoped_identity,
          layerMessage(S, 1, 'G-1 stages new candidates with scoped identity'));
        // The append-only event log exists and refuses mutation in the database.
        const seeded = await appliance.query('select id from memory_candidate_events where candidate_id = $1 order by event_seq limit 1', [legacyForClient.id]);
        await assert.rejects(() => appliance.query('update memory_candidate_events set reason = $2 where id = $1', [seeded.rows[0].id, 'rewritten']), /memory_candidate_events_append_only/);
        await assert.rejects(() => appliance.query('delete from memory_candidate_events where id = $1', [seeded.rows[0].id]), /memory_candidate_events_append_only/);
      });

      await t.test('L1 posture — producer and governance API agree on the appliance env', async () => {
        // W1 (F-10 / N-05): the candidate feature has ONE posture — the
        // MEMORY_CANDIDATES plane key, seeded `auto` on the owner shell — read by
        // the producer (the distiller's staging entry) and by the governance
        // routes through the same resolver. The raw LOOPS_SHADOW env no longer
        // decides either side: with it set or unset the resolved posture is the
        // same, and the loop workers' LOOPS_TIER master is a different switch.
        assert.equal(process.env.LOOPS_TIER, 'canary', layerMessage(S, 1, 'the appliance boot staged LOOPS_TIER=canary'));
        const resolved = await withFirmDbClient((client) => resolveMemoryCandidatesPosture({ client, firmId, clientId }));
        assert.equal(resolved.posture, 'act', S08_FINGERPRINTS.L1_posture);
        assert.equal(memoryCandidatesProducerMayStage(resolved.posture), memoryCandidatesGovernanceMayAct(resolved.posture), S08_FINGERPRINTS.L1_posture);
        const priorShadow = process.env.LOOPS_SHADOW;
        try {
          process.env.LOOPS_SHADOW = 'off';
          const withShadowOff = await withFirmDbClient((client) => resolveMemoryCandidatesPosture({ client, firmId, clientId }));
          assert.equal(withShadowOff.posture, resolved.posture, layerMessage(S, 1, 'the legacy LOOPS_SHADOW env decides nothing about the candidate feature'));
        } finally {
          if (priorShadow === undefined) delete process.env.LOOPS_SHADOW; else process.env.LOOPS_SHADOW = priorShadow;
        }
        assert.equal(isLoopSystemEnabled(), true, layerMessage(S, 1, 'the loop workers keep their own tier master, untouched'));
      });

      await t.test('L2a retrieval — a suggested candidate is excluded from the governed bundle (INV-02)', async () => {
        const bundle = await retrieve();
        assert.deepEqual(bundle?.bundle?.context_items ?? [], [], layerMessage(S, 2, 'nothing retrievable before promotion'));
      });

      // ── promote ──
      // W1: a governance action names the legal entity and the version it read (fail closed otherwise).
      const promoted = await withFirmDbClient((client) => TX(client, () => promoteMemoryCandidate({ client, firmId, clientId, candidateId: staged.id, expectedVersion: staged.version, decidedBy: `${clientId}-owner`, configSnapshot, env })));
      assert.equal(promoted.promoted, true, `promotion minted a memory: ${JSON.stringify(promoted)}`);
      const memoryId = promoted.memoryId;
      const activeCount = async () => (await appliance.query("select count(*)::int as n from memories where tenant_id = $1 and owner_client_id = $2 and record_state = 'active'", [firmId, clientId])).rows[0].n;
      assert.equal(await activeCount(), 1, 'one active revision after promotion');

      await t.test('L2 retrieval — the promoted claim is retrievable and the prompt packet keeps its labels', () => expectedFailure({ id: `${S}/L2`, fingerprint: S08_FINGERPRINTS.L2 }, async () => {
        const result = await retrieve();
        const items = result?.bundle?.context_items ?? [];
        assert.equal(items.length, 1, layerMessage(S, 2, `the promoted claim is in the governed bundle: ${JSON.stringify({ status: result?.status, failure: result?.failure, hidden: result?.privileged_record?.hidden, excluded_restricted: result?.privileged_record?.excluded_restricted, visible_excluded: result?.consumer_receipt?.visible_excluded })}`));
        assert.equal(items[0].ref?.memory_id, memoryId, layerMessage(S, 2, 'the bundle names the exact revision'));
        assert.ok(items[0].epistemic_state && items[0].value_source_trust, layerMessage(S, 2, 'the bundle item carries epistemic state and trust'));
        const rendered = renderRecordedFactsFromBundle(result.bundle);
        assert.ok(rendered.length === 1 && rendered[0].epistemic_state && rendered[0].origin, S08_FINGERPRINTS.L2);
      }));

      await t.test('L3 decision receipt — the prompt-time set is receipted BEFORE the model call', () => expectedFailure({ id: `${S}/L3`, fingerprint: S08_FINGERPRINTS.L3 }, async () => {
        await retrieve();
        const evidence = (await appliance.query('select evidence_id from memory_replay_evidence where firm_id = $1 and client_id = $2', [firmId, clientId])).rows;
        assert.ok(evidence.length >= 1, S08_FINGERPRINTS.L3);
      }));

      // ── correct → supersede ──
      const superseded = await withFirmDbClient((client) => TX(client, () => supersedeMemory({
        client, tenantId: firmId, priorMemoryId: memoryId,
        changes: { structured_value: { value_type: 'string', value: 'email' }, source_text: 'The owner now prefers email for questions about the books.', source_refs: [{ message_id: `${clientId}-msg-2` }] },
        actor: { type: 'firm', id: `${clientId}-owner` }, configSnapshot, env
      })));
      await t.test('L1b database state — supersession leaves exactly one active revision with the successor link', async () => {
        assert.equal(superseded.status, 'superseded', layerMessage(S, 1, `the supersession persisted: ${JSON.stringify(superseded)}`));
        assert.equal(await activeCount(), 1, layerMessage(S, 1, 'one active revision after supersession'));
        const successor = (await appliance.query('select memory_id, supersedes_memory_id, revision from memories where tenant_id = $1 and owner_client_id = $2 and record_state = $3', [firmId, clientId, 'active'])).rows[0];
        assert.equal(successor.supersedes_memory_id, memoryId, layerMessage(S, 1, 'the successor names its predecessor'));
        const relations = (await appliance.query('select relation from memory_relations where tenant_id = $1 and source_memory_id = $2', [firmId, successor.memory_id])).rows;
        assert.ok(relations.length >= 1, layerMessage(S, 1, 'the supersession wrote its relation row'));
        const prior = (await appliance.query('select record_state, source_text from memories where memory_id = $1', [memoryId])).rows[0];
        assert.equal(prior.record_state, 'superseded', layerMessage(S, 1, 'the prior revision is superseded, auditable, not current'));
        assert.ok(prior.source_text, layerMessage(S, 1, 'the prior revision keeps its content for replay'));
      });

      await t.test('L3 replay — exact replay of the owner turn against its recorded set', () => registeredGap({ id: `${S}/L3-replay`, reason: S08_FINGERPRINTS.GAP }));

      // ── erase ──
      const erased = await withFirmDbClient((client) => TX(client, () => eraseUserMemories({
        client, tenantId: firmId, lifecycleOwnerType: 'legal_entity', lifecycleOwnerId: clientId,
        reason: 'dmem w0 erasure leg', actor: { type: 'firm', id: `${clientId}-owner` }, configSnapshot, env
      })));
      await t.test('L1 erasure — every content-bearing copy is scrubbed', () => expectedFailure({ id: `${S}/L1-erase`, fingerprint: S08_FINGERPRINTS.L1_erase }, async () => {
        assert.ok(Array.isArray(erased.writes) && erased.writes.length >= 1, layerMessage(S, 1, `the erasure ran: ${JSON.stringify(erased)}`));
        const memories = (await appliance.query('select record_state, source_text, structured_value from memories where tenant_id = $1 and owner_client_id = $2', [firmId, clientId])).rows;
        assert.ok(memories.every((row) => row.record_state === 'erased' && row.source_text === null && row.structured_value === null), layerMessage(S, 1, 'every revision of the slot is scrubbed'));
        const candidate = (await appliance.query('select subject, fact, contract_payload, status from memory_candidates where firm_id = $1 and id = $2', [firmId, staged.id])).rows[0];
        assert.ok(candidate.subject === null && candidate.fact === null && candidate.contract_payload === null, S08_FINGERPRINTS.L1_erase);
      }));
    } finally {
      await appliance.stop();
    }
  }
);
