// DMEM-R1 W0 — S06, authority and conflict (forensic §13.6;
// docs/audit-2026-09-04-memory-re-baseline.md §1 F-13, canaries 10–11;
// ACC-F13, ACC-C10, ACC-C11).
//
// EXPECTED FAILURE on the current tree (registered in scripts/run-tests.mjs).
// Through the REAL writers (`saveFirmFact`, `saveMemory`) and the REAL reader the
// coder uses (`getFirmFactsForSubjects`): two contradicting active facts on one
// subject come back as two authoritative facts with no conflict marker (doctrine
// §3: admissible sources that conflict are represented AS a conflict, never
// settled by insertion order or recency); re-asserting the SAME fact from the SAME
// source refreshes its recency (`updated_at`, the retrieval order) — repeated
// exposure to one source cannot increase freshness or support (INV-08). The V2
// plane's half (L1b, `last_confirmed_at`) was FLIPPED by DMEM-R1 W2 (2026-09-04):
// migration 142's evidence links make same-source reassertion 'repeated' and
// freshness independent-only; it is a plain assertion below. The coding prompt's known_facts drop the
// provenance class the authority ladder needs (forensic §7).

import test from 'node:test';
import assert from 'node:assert/strict';

import { bootApplianceForTest, applianceHarnessSkipReason } from './testSupport/applianceHarness.js';
import { expectedFailure, layerMessage } from './testSupport/dmemFixtureSupport.js';
import { withFirmDbClient } from './firmDb.js';
import { getFirmFactsForSubjects, saveFirmFact } from './firmFacts.js';
import { MEMORY_MODEL_V2_FLAG_KEY, saveMemory } from './memoriesDb.js';

const S = 'S06';
export const S06_FINGERPRINTS = Object.freeze({
  L1: layerMessage(S, 1, 're-asserting a fact from the same source does not refresh its recency (updated_at unchanged)'),
  L1b: layerMessage(S, 1, 'a same-source reassertion of a memory adds no confirmation freshness (last_confirmed_at unchanged, evidence identity first-class)'),
  L2: layerMessage(S, 2, 'contradicting active facts on one subject surface as an explicit conflict, not as two authoritative facts')
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test(
  'real PG (appliance, DMEM S06): contradicting facts coexist as authority and same-source repetition reads as freshness',
  { skip: applianceHarnessSkipReason() },
  async (t) => {
    const appliance = await bootApplianceForTest({ now: new Date('2026-09-04T09:00:00.000Z') });
    try {
      const { firmId } = appliance;
      const { clientId } = await appliance.createClient();
      const provenance = { client_id: clientId, source: 'dmem_w0_same_source', transaction_id: `${clientId}-tx-acme-1` };
      // W1: saveFirmFact activates only under the explicit teaching precondition —
      // this fixture's mint IS an explicit assertion (the owner teaching a fact).
      const mint = (fact) => withFirmDbClient((client) => saveFirmFact({
        client, firmId, scope: 'merchant', subject: 'ACME SUPPLIES LTD', fact, confidence: 'medium', provenance, model: 'dmem-w0', teach: 'explicit'
      }));
      const first = await mint('Acme Supplies sells stationery to the studio.');
      await sleep(25);
      const second = await mint('Acme Supplies is a software vendor, not a supplier of goods.');
      assert.ok(first?.id && second?.id && first.id !== second.id, 'two facts, two ids');
      const readOrder = async () => (await withFirmDbClient((client) => getFirmFactsForSubjects({
        client, firmId, clientId, subjects: [{ scope: 'merchant', value: 'ACME SUPPLIES LTD' }]
      }))).map((row) => row.id);
      const updatedAt = async (id) => (await appliance.query('select updated_at from firm_facts where firm_id = $1 and id = $2', [firmId, id])).rows[0].updated_at.toISOString();

      await t.test('L2 retrieval — a contradiction is a conflict, not two facts', () => expectedFailure({ id: `${S}/L2`, fingerprint: S06_FINGERPRINTS.L2 }, async () => {
        const facts = await withFirmDbClient((client) => getFirmFactsForSubjects({ client, firmId, clientId, subjects: [{ scope: 'merchant', value: 'ACME SUPPLIES LTD' }] }));
        assert.equal(facts.length, 2, layerMessage(S, 2, 'both active facts are in reach of the reader'));
        assert.ok(facts.every((fact) => fact.conflict === true || fact.epistemic_state === 'disputed'), S06_FINGERPRINTS.L2);
      }));

      await t.test('L1 database state — same-source reassertion is not freshness', () => expectedFailure({ id: `${S}/L1`, fingerprint: S06_FINGERPRINTS.L1 }, async () => {
        const before = await updatedAt(first.id);
        const orderBefore = await readOrder();
        assert.deepEqual(orderBefore, [second.id, first.id], layerMessage(S, 1, 'the newer fact reads first before any reassertion'));
        await sleep(25);
        const again = await mint('Acme Supplies sells stationery to the studio.');
        assert.equal(again.id, first.id, layerMessage(S, 1, 'the same text from the same source lands on the same row'));
        assert.equal(again.inserted, false);
        assert.equal(await updatedAt(first.id), before, S06_FINGERPRINTS.L1);
        assert.deepEqual(await readOrder(), orderBefore, layerMessage(S, 1, 'the retrieval order is unchanged by a same-source reassertion'));
      }));

      // DMEM-R1 W2 FLIPPED this layer (2026-09-04): the V2 writer links evidence by
      // identity (migration 142, memory_evidence_links); a same-source reassertion is
      // a 'repeated' corroboration and refreshes nothing; only an INDEPENDENT source
      // (a new dependence group) is confirmation freshness (INV-08).
      await t.test('L1b V2 plane (W2) — a same-source reassertion appends evidence, never confirmation freshness', async () => {
        const env = { ...process.env, MEMORY_KEY_HMAC_SECRET: 'dmem-w0-hmac' };
        const configSnapshot = { [MEMORY_MODEL_V2_FLAG_KEY]: { stage: 'canary', source: 'dmem-w0' } };
        const record = {
          scope_type: 'legal_entity', scope_id: clientId, lifecycle_owner_type: 'legal_entity', lifecycle_owner_id: clientId,
          subject_type: 'merchant', subject_id: 'acme-supplies', kind: 'assertion', predicate: 'supplier_category',
          structured_value: { value_type: 'string', value: 'stationery' }, source_text: 'Acme Supplies sells stationery to the studio.',
          source_refs: [{ transaction_id: `${clientId}-tx-acme-1` }], asserted_by_principal_id: 'dmem-w0', assertion_origin: 'operator_asserted',
          observed_at: '2026-08-12T10:00:00.000Z', assertion_confidence: 'medium', confidentiality: 'internal', personal_data_class: 'none'
        };
        const saved = await withFirmDbClient((client) => saveMemory({ client, tenantId: firmId, record, actor: { type: 'firm', id: 'dmem-w0' }, configSnapshot, env }));
        assert.equal(saved.status, 'persisted', layerMessage(S, 1, `the V2 writer persisted the claim under the canary posture: ${JSON.stringify(saved)}`));
        const memoryId = saved.write.memory_id;
        const confirmedBefore = (await appliance.query('select last_confirmed_at from memories where memory_id = $1', [memoryId])).rows[0].last_confirmed_at;
        await sleep(25);
        const again = await withFirmDbClient((client) => saveMemory({ client, tenantId: firmId, record, actor: { type: 'firm', id: 'dmem-w0' }, configSnapshot, env }));
        assert.equal(again.status, 'reasserted', layerMessage(S, 1, 'the same content from the same source is recognised as a reassertion'));
        assert.equal(again.corroboration, 'repeated', layerMessage(S, 1, 'the writer classifies the same source as repeated corroboration'));
        const confirmedAfter = (await appliance.query('select last_confirmed_at from memories where memory_id = $1', [memoryId])).rows[0].last_confirmed_at;
        assert.equal(String(confirmedAfter), String(confirmedBefore), S06_FINGERPRINTS.L1b);
        const links = (await appliance.query('select evidence_id, dependence_group, corroboration_class from memory_evidence_links where tenant_id = $1 and memory_id = $2 order by id', [firmId, memoryId])).rows;
        assert.equal(links.length, 1, layerMessage(S, 1, 'one evidence identity, linked once — the replay added no link'));
        assert.equal(links[0].corroboration_class, 'independent', layerMessage(S, 1, 'the first observation of the source is the independent support'));
        // An INDEPENDENT source (a different transaction) is legitimate freshness.
        await sleep(25);
        const independent = await withFirmDbClient((client) => saveMemory({
          client, tenantId: firmId, record: { ...record, source_refs: [{ transaction_id: `${clientId}-tx-acme-2` }] },
          actor: { type: 'firm', id: 'dmem-w0' }, configSnapshot, env
        }));
        assert.equal(independent.status, 'reasserted');
        assert.equal(independent.corroboration, 'independent', layerMessage(S, 1, 'a second source is independent corroboration'));
        const confirmedIndependent = (await appliance.query('select last_confirmed_at from memories where memory_id = $1', [memoryId])).rows[0].last_confirmed_at;
        assert.notEqual(String(confirmedIndependent), String(confirmedBefore), layerMessage(S, 1, 'independent corroboration refreshes last_confirmed_at'));
        const linksAfter = (await appliance.query('select corroboration_class from memory_evidence_links where tenant_id = $1 and memory_id = $2 order by id', [firmId, memoryId])).rows;
        assert.deepEqual(linksAfter.map((l) => l.corroboration_class), ['independent', 'independent']);
      });

      await t.test('L3 prompt receipt — the coder\'s known_facts carry the provenance class the authority ladder needs', () => expectedFailure({ id: `${S}/L3`, fingerprint: layerMessage(S, 3, 'known_facts carry each fact\'s asserting origin and authority class, not only text and confidence') }, async () => {
        const facts = await withFirmDbClient((client) => getFirmFactsForSubjects({ client, firmId, clientId, subjects: [{ scope: 'merchant', value: 'ACME SUPPLIES LTD' }] }));
        // The exact projection transactionLlm.js:999 renders into known_facts.
        const rendered = facts.map((fact) => ({ id: fact.id, scope: fact.scope, subject: fact.subject, fact: fact.fact, confidence: fact.confidence, status: fact.status, origin: fact.assertion_origin ?? fact.provenance?.source ?? null }));
        assert.ok(rendered.every((item) => item.origin), layerMessage(S, 3, 'known_facts carry each fact\'s asserting origin and authority class, not only text and confidence'));
      }));
    } finally {
      await appliance.stop();
    }
  }
);
