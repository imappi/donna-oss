// FIK-0b follow-up (docs/plan-2026-09-22-fi-jev-decision-knowledge.md §8.4) —
// the firm-fact distiller never stages a jurisdiction-scope fact, and a
// jurisdiction-scope candidate that already rests in memory_candidates can
// never be promoted into firm_facts. A jurisdiction rule applies to every
// client in the jurisdiction, so it is general tax/accounting knowledge
// (factIsJurisdictionKnowledge) — K1 or the reviewed pack, never company memory.
//
// Real PG through the appliance harness: the staging writer, the promotion
// transaction and the audit receipt all run against the migrated schema.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApplianceForTest, applianceHarnessSkipReason } from './testSupport/applianceHarness.js';
import { withFirmDbClient } from './firmDb.js';
import { stageMemoryCandidate, promoteMemoryCandidate, dismissMemoryCandidate } from './memoryCandidates.js';
import { distillAndStageFirmFactCandidates } from './firmFacts.js';

const tx = async (fn) => withFirmDbClient(async (client) => {
  await client.query('begin');
  try { const out = await fn(client); await client.query('commit'); return out; }
  catch (error) { await client.query('rollback'); throw error; }
});

const RULE = { scope: 'jurisdiction', subject: 'FI', fact: 'Rent of business premises is VAT-exempt in Finland.', confidence: 'high' };

test('real PG: the distiller drops a jurisdiction-scope fact (receipted) while its client, merchant and firm siblings stage', { skip: applianceHarnessSkipReason() }, async () => {
  const app = await bootApplianceForTest();
  try {
    const { firmId } = app;
    const { clientId } = await app.createClient();
    const out = await withFirmDbClient((client) => distillAndStageFirmFactCandidates({
      client, firmId, clientId,
      event: { kind: 'client_reply_recode' },
      provenance: { client_id: clientId, transaction_id: `${clientId}-tx` },
      distillFn: async () => ({ model: 'recorded-distiller', facts: [
        RULE,
        { scope: 'client', subject: 'Kestrel Studio', fact: 'Kestrel Studio rents its premises from its director.', confidence: 'high' },
        { scope: 'merchant', subject: 'ACME SUPPLIES LTD', fact: 'Acme Supplies sells the studio stationery.', confidence: 'medium' },
        { scope: 'firm', subject: firmId, fact: 'The firm closes its clients monthly.', confidence: 'medium' }
      ] })
    }));
    assert.deepEqual(out.map((row) => row.scope).sort(), ['client', 'firm', 'merchant']);
    assert.deepEqual(out.refused, [{ scope: 'jurisdiction', subject: 'fi', reason: 'jurisdiction_knowledge' }]);

    const rows = (await app.query(
      'select scope, status from memory_candidates where firm_id = $1 and client_id = $2 order by scope', [firmId, clientId]
    )).rows;
    assert.deepEqual(rows.map((r) => r.scope), ['client', 'firm', 'merchant'], 'no jurisdiction candidate is staged');
    assert.ok(rows.every((r) => r.status === 'suggested'));
    assert.equal((await app.query('select count(*)::int as n from firm_facts where firm_id = $1', [firmId])).rows[0].n, 0);

    const receipts = (await app.query(
      "select client_id, actor_id, metadata from audit_events where firm_id = $1 and action = 'firm_fact.distill_refused'", [firmId]
    )).rows;
    assert.equal(receipts.length, 1, 'the drop is receipted once');
    assert.equal(receipts[0].client_id, clientId);
    assert.equal(receipts[0].metadata.reason, 'jurisdiction_knowledge');
    assert.equal(receipts[0].metadata.subject, 'fi');
    assert.equal(receipts[0].metadata.transaction_id, `${clientId}-tx`);
    assert.equal(receipts[0].metadata.fact, undefined, 'the refused rule text is not copied into the receipt');
  } finally {
    await app.stop();
  }
});

test('real PG: a pre-existing jurisdiction-scope candidate refuses promotion and stays governable; a client sibling promotes', { skip: applianceHarnessSkipReason() }, async () => {
  const app = await bootApplianceForTest();
  try {
    const { firmId } = app;
    const { clientId } = await app.createClient();
    // A candidate staged before the distiller stopped proposing the scope (or
    // reconstructed by the backfill from a legacy row): the writer below is the
    // table writer, not the distiller, so the row exists.
    const stage = (learning) => withFirmDbClient((client) => stageMemoryCandidate({
      client, firmId, clientId, source: 'legacy-distiller', ...learning,
      provenance: { client_id: clientId, distilled: true }
    }));
    const legacy = await stage(RULE);
    assert.ok(legacy?.id, 'fixture: the legacy jurisdiction candidate exists');
    const sibling = await stage({ scope: 'client', subject: 'Kestrel Studio', fact: 'Kestrel Studio rents its premises from its director.', confidence: 'high' });

    const refused = await tx((client) => promoteMemoryCandidate({
      client, firmId, clientId, candidateId: legacy.id, expectedVersion: legacy.version, decidedBy: app.memberId
    }));
    assert.equal(refused.promoted, false);
    assert.equal(refused.refused, 'jurisdiction_knowledge');
    assert.equal((await app.query('select count(*)::int as n from firm_facts where firm_id = $1', [firmId])).rows[0].n, 0,
      'no firm_facts row is minted from the jurisdiction candidate');
    const rest = (await app.query('select status, candidate_version from memory_candidates where id = $1', [legacy.id])).rows[0];
    assert.equal(rest.status, 'suggested', 'the refused candidate is untouched — still on a human to dismiss');
    const events = (await app.query('select event_type from memory_candidate_events where candidate_id = $1 order by event_seq', [legacy.id])).rows;
    assert.ok(!events.some((e) => e.event_type === 'promoted'));

    const dismissed = await tx((client) => dismissMemoryCandidate({
      client, firmId, clientId, candidateId: legacy.id, expectedVersion: legacy.version, decidedBy: app.memberId
    }));
    assert.equal(dismissed.dismissed, true, 'the human "no" still works on it');

    const promoted = await tx((client) => promoteMemoryCandidate({
      client, firmId, clientId, candidateId: sibling.id, expectedVersion: sibling.version, decidedBy: app.memberId
    }));
    assert.equal(promoted.promoted, true, 'the neighbouring client-scope candidate promotes as before');
    const minted = (await app.query('select scope, status from firm_facts where id = $1', [promoted.factId])).rows[0];
    assert.deepEqual(minted, { scope: 'client', status: 'active' });
  } finally {
    await app.stop();
  }
});
