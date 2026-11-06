import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApplianceForTest, applianceHarnessSkipReason } from './testSupport/applianceHarness.js';
import { accountingEffectHash } from './testSupport/dmemFixtureSupport.js';
import { withFirmDbClient } from './firmDb.js';
import { stageMemoryCandidate, promoteMemoryCandidate, dismissMemoryCandidate, listMemoryCandidatesWithConflicts, buildMemoryCandidateId, listMemoryCandidatesForClient } from './memoryCandidates.js';
import { saveFirmFact, dismissFirmFact, distillAndStageFirmFactCandidates } from './firmFacts.js';

const tx = async (fn) => withFirmDbClient(async (client) => {
  await client.query('begin');
  try { const out = await fn(client); await client.query('commit'); return out; }
  catch (error) { await client.query('rollback'); throw error; }
});

test('real PG: candidate identity, governance and events retain the authorized client', { skip: applianceHarnessSkipReason() }, async () => {
  const app = await bootApplianceForTest();
  try {
    const { firmId } = app;
    const { clientId: a } = await app.createClient();
    const { clientId: b } = await app.createClient();
    const learning = { scope: 'merchant', subject: 'acme supplies', fact: 'Acme supplies stationery', confidence: 'high' };
    const stage = (clientId, extra = {}) => withFirmDbClient((client) => stageMemoryCandidate({ client, firmId, clientId,
      source: 'isolation-fixture', ...learning, provenance: { client_id: clientId }, ...extra }));
    const beforeLedger = await accountingEffectHash(app.query, { firmId });
    const distill = (clientId) => withFirmDbClient((client) => distillAndStageFirmFactCandidates({ client, firmId, clientId,
      event: { kind: 'correction' }, provenance: { client_id: clientId, transaction_id: `${clientId}-source` },
      distillFn: async () => ({ facts: [learning], model: null }) }));
    const [distilledA] = await distill(a);
    const [distilledB] = await distill(b);
    assert.ok(distilledA?.id && distilledB?.id, 'real configured distiller stages candidates');
    assert.notEqual(distilledA.id, distilledB.id);
    assert.equal((await app.query("select count(*)::int as n from firm_facts where firm_id=$1", [firmId])).rows[0].n, 0);
    const ca = await stage(a);
    const cb = await stage(b);
    assert.notEqual(ca.id, cb.id);
    const repeat = await stage(a);
    assert.equal(repeat.id, ca.id);
    assert.equal(repeat.version, 2);
    assert.equal((await tx(client => promoteMemoryCandidate({ client, firmId, clientId: a, candidateId: ca.id, expectedVersion: ca.version, decidedBy: app.memberId }))).refused, 'version_mismatch');
    assert.equal((await tx(client => promoteMemoryCandidate({ client, firmId, clientId: b, candidateId: ca.id, expectedVersion: repeat.version, decidedBy: app.memberId }))).refused, 'legal_entity_mismatch');
    const promoted = await tx(client => promoteMemoryCandidate({ client, firmId, clientId: a, candidateId: ca.id, expectedVersion: repeat.version, decidedBy: app.memberId }));
    assert.equal(promoted.promoted, true);
    assert.equal((await app.query('select provenance from firm_facts where id=$1', [promoted.factId])).rows[0].provenance.client_id, a);
    const events = (await app.query('select event_type,candidate_version from memory_candidate_events where candidate_id=$1 order by event_seq', [ca.id])).rows;
    assert.deepEqual(events, [{ event_type: 'staged', candidate_version: 1 }, { event_type: 'version_bumped', candidate_version: 2 }, { event_type: 'promoted', candidate_version: 3 }]);
    await assert.rejects(tx(async client => {
      await stageMemoryCandidate({ client, firmId, clientId: a, source: 'rollback', ...learning, fact: 'Rollback sentinel' });
      throw new Error('rollback fixture');
    }), /rollback fixture/);
    assert.equal((await app.query("select count(*)::int as n from memory_candidates where fact='Rollback sentinel'")).rows[0].n, 0);
    await tx(async client => {
      const one = await stageMemoryCandidate({ client, firmId, clientId: a, source: 'same-transaction', ...learning, fact: 'Same transaction' });
      const two = await stageMemoryCandidate({ client, firmId, clientId: a, source: 'same-transaction', ...learning, fact: 'Same transaction' });
      assert.equal(two.version, one.version + 1);
      const refused = await dismissMemoryCandidate({ client, firmId, clientId: a, candidateId: one.id, expectedVersion: one.version, decidedBy: app.memberId });
      assert.equal(refused.refused, 'version_mismatch');
    });
    // An existing collided legacy row must refuse governance and cannot be repaired
    // implicitly by re-staging. Its original id, human decision and provenance stay.
    const legacyId = buildMemoryCandidateId({ firmId, ...learning, fact: 'Legacy ownership' });
    await app.query(`insert into memory_candidates (id,firm_id,client_id,candidate_type,status,source,scope,subject,fact,provenance)
      values ($1,$2,$3,'fact','dismissed','legacy','merchant',$4,'Legacy ownership',$5::jsonb)`, [legacyId, firmId, a, learning.subject, JSON.stringify({ client_id: b })]);
    const refusal = await tx(client => promoteMemoryCandidate({ client, firmId, clientId: a, candidateId: legacyId, expectedVersion: 1, decidedBy: app.memberId }));
    assert.equal(refusal.refused, 'candidate_owner_conflict');
    assert.equal(await stage(a, { fact: 'Legacy ownership' }), null);
    const legacyGood = buildMemoryCandidateId({ firmId, ...learning, fact: 'Legacy dismissed' });
    await app.query(`insert into memory_candidates (id,firm_id,client_id,candidate_type,status,source,scope,subject,fact,provenance)
      values ($1,$2,$3,'fact','dismissed','legacy','merchant',$4,'Legacy dismissed',$5::jsonb)`, [legacyGood, firmId, a, learning.subject, JSON.stringify({ client_id: a })]);
    const adopted = await stage(a, { fact: 'Legacy dismissed' });
    assert.equal(adopted.id, legacyGood);
    assert.equal(adopted.status, 'dismissed');
    // Full conflict text belongs to the authorized client, including GET enrichment.
    await tx(client => saveFirmFact({ client, firmId, ...learning, fact: 'PRIVATE CLIENT B FACT', provenance: { client_id: b }, teach: 'explicit' }));
    const conflicted = await stage(a, { fact: 'A disputed learning', status: 'conflicted' });
    const view = await withFirmDbClient(client => listMemoryCandidatesWithConflicts({ client, firmId, clientId: a }));
    assert.ok(view.find(row => row.id === conflicted.id)?.conflicts_with.length);
    assert.ok(!JSON.stringify(view).includes('PRIVATE CLIENT B FACT'));
    const routeView = await app.api.request({ path: `/api/donna/firms/memory-candidates?firm_id=${firmId}&client_id=${a}`, auth: true });
    assert.equal(routeView.status, 200);
    assert.ok(!routeView.text.includes('PRIVATE CLIENT B FACT'));
    const routePromote = await app.api.request({ method: 'POST', path: `/api/donna/firms/memory-candidates/${cb.id}/promote`, auth: true,
      body: { firm_id: firmId, client_id: b, expected_version: cb.version } });
    assert.equal(routePromote.status, 200);
    assert.equal(routePromote.json.promoted, true);
    const routeDismiss = await app.api.request({ method: 'POST', path: `/api/donna/firms/memory-candidates/${cb.id}/dismiss`, auth: true,
      body: { firm_id: firmId, client_id: b, expected_version: routePromote.json.version } });
    assert.equal(routeDismiss.json.dismissed, true, 'the returned version supports the next mounted governance action');
    const dismissalAudit = (await app.query("select actor_type,actor_id from audit_events where action='firm_fact.dismissed' and resource_id=$1 order by id desc limit 1", [routePromote.json.factId])).rows[0];
    const candidateAudit = (await app.query("select actor_id from memory_candidate_events where candidate_id=$1 and event_type='dismissed'", [cb.id])).rows[0];
    assert.equal(dismissalAudit.actor_type, 'firm');
    assert.equal(dismissalAudit.actor_id, candidateAudit.actor_id);
    assert.notEqual(dismissalAudit.actor_id, 'system');

    // Nonmerchant fact IDs historically share a firm-wide slot. A candidate's
    // client authorization cannot adopt or reassert the other client's target.
    // A jurisdiction-scope candidate never reaches the shared slot at all: it is
    // general knowledge, refused at promotion for every client (FIK-0b follow-up,
    // plan-2026-09-22 §8.4). The owner fence is exercised on firm/client scope.
    for (const clientId of [a, b]) {
      const jurisdiction = await stage(clientId, { scope: 'jurisdiction', subject: 'gb', fact: 'jurisdiction shared target' });
      const refused = await tx(client => promoteMemoryCandidate({ client, firmId, clientId, candidateId: jurisdiction.id, expectedVersion: jurisdiction.version, decidedBy: app.memberId }));
      assert.equal(refused.refused, 'jurisdiction_knowledge');
    }
    assert.equal((await app.query("select count(*)::int as n from firm_facts where firm_id=$1 and scope='jurisdiction'", [firmId])).rows[0].n, 0);
    for (const scope of ['firm', 'client']) {
      const common = { scope, subject: 'shared subject', fact: `${scope} shared target` };
      const first = await stage(a, common);
      const second = await stage(b, common);
      const yes = await tx(client => promoteMemoryCandidate({ client, firmId, clientId: a, candidateId: first.id, expectedVersion: first.version, decidedBy: app.memberId }));
      assert.equal(yes.promoted, true);
      const beforeFact = (await app.query('select * from firm_facts where id=$1', [yes.factId])).rows[0];
      const no = await tx(client => promoteMemoryCandidate({ client, firmId, clientId: b, candidateId: second.id, expectedVersion: second.version, decidedBy: app.memberId }));
      assert.equal(no.promoted, false, 'one client cannot promote another client’s nonmerchant fact');
      assert.equal(no.refused, 'fact_owner_conflict');
      assert.deepEqual((await app.query('select * from firm_facts where id=$1', [yes.factId])).rows[0], beforeFact);
      assert.equal((await app.query('select status from memory_candidates where id=$1', [second.id])).rows[0].status, 'suggested');
      assert.equal((await app.query('select count(*)::int as n from memory_candidate_events where candidate_id=$1', [second.id])).rows[0].n, 1);
    }
    const ownerRaceCandidate = await stage(a, { scope: 'firm', subject: 'race owner', fact: 'Owner changes during dismissal' });
    const ownerRaceFact = await tx(client => promoteMemoryCandidate({ client, firmId, clientId: a,
      candidateId: ownerRaceCandidate.id, expectedVersion: ownerRaceCandidate.version, decidedBy: app.memberId }));
    await assert.rejects(tx(client => dismissMemoryCandidate({ client, firmId, clientId: a,
      candidateId: ownerRaceCandidate.id, expectedVersion: ownerRaceFact.version, decidedBy: app.memberId,
      dismissFirmFactFn: async (args) => {
        // Another transaction changes the shared fact's surviving owner after
        // candidate admission. Only the named writer's UPDATE can fence this.
        await app.query("update firm_facts set provenance=jsonb_set(provenance,'{client_id}',to_jsonb($2::text)) where id=$1", [ownerRaceFact.factId, b]);
        return dismissFirmFact(args);
      }
    })), error => error.code === 'FIRM_FACT_OWNER_CONFLICT');
    assert.equal((await app.query('select status from firm_facts where id=$1', [ownerRaceFact.factId])).rows[0].status, 'active');
    assert.equal((await app.query('select status from memory_candidates where id=$1', [ownerRaceCandidate.id])).rows[0].status, 'promoted');
    const sharedRace = await Promise.all([stage(a, { scope: 'firm', subject: 'concurrent shared', fact: 'Concurrent shared target' }), stage(b, { scope: 'firm', subject: 'concurrent shared', fact: 'Concurrent shared target' })]);
    const sharedResults = await Promise.all(sharedRace.map((candidate, index) => tx(client => promoteMemoryCandidate({ client, firmId, clientId: index === 0 ? a : b, candidateId: candidate.id, expectedVersion: candidate.version, decidedBy: app.memberId }))));
    assert.equal(sharedResults.filter(result => result.promoted).length, 1);
    assert.equal(sharedResults.filter(result => result.refused === 'fact_owner_conflict').length, 1);
    const simultaneous = await Promise.all([stage(a, { fact: 'Concurrent source' }), stage(a, { fact: 'Concurrent source' })]);
    assert.equal(simultaneous[0].id, simultaneous[1].id);
    assert.deepEqual(simultaneous.map(row => row.version).sort(), [1, 2]);
    const raceCandidate = await stage(a, { fact: 'Concurrent governance' });
    const race = await Promise.all([
      tx(client => promoteMemoryCandidate({ client, firmId, clientId: a, candidateId: raceCandidate.id, expectedVersion: 1, decidedBy: app.memberId })),
      tx(client => dismissMemoryCandidate({ client, firmId, clientId: a, candidateId: raceCandidate.id, expectedVersion: 1, decidedBy: app.memberId }))
    ]);
    assert.equal(race.filter(result => result.refused === 'version_mismatch').length, 1);
    const rollbackCandidate = await stage(a, { fact: 'Rollback promotion' });
    await assert.rejects(tx(async client => {
      await promoteMemoryCandidate({ client, firmId, clientId: a, candidateId: rollbackCandidate.id, expectedVersion: 1, decidedBy: app.memberId });
      throw new Error('after promotion rollback');
    }), /after promotion rollback/);
    assert.equal((await app.query('select status from memory_candidates where id=$1', [rollbackCandidate.id])).rows[0].status, 'suggested');
    assert.equal((await app.query("select count(*)::int as n from firm_facts where fact='Rollback promotion'")).rows[0].n, 0);
    assert.equal((await app.query('select count(*)::int as n from memory_candidate_events where candidate_id=$1', [rollbackCandidate.id])).rows[0].n, 1);
    const listed = await withFirmDbClient(client => listMemoryCandidatesForClient({ client, firmId, clientId: a }));
    assert.ok(listed.every(row => Number.isInteger(row.version)));
    // Poisoning only the target pointer cannot make A dismiss B's fact either.
    const foreignFact = (await app.query("select id from firm_facts where fact='PRIVATE CLIENT B FACT'")).rows[0].id;
    await app.query('update memory_candidates set minted_fact_id=$2 where id=$1', [conflicted.id, foreignFact]);
    assert.equal((await tx(client => dismissMemoryCandidate({ client, firmId, clientId: a, candidateId: conflicted.id, expectedVersion: conflicted.version, decidedBy: app.memberId }))).refused, 'minted_target_owner_conflict');
    assert.equal((await app.query('select status from firm_facts where id=$1', [foreignFact])).rows[0].status, 'active');
    assert.deepEqual(await accountingEffectHash(app.query, { firmId }), beforeLedger);
    assert.deepEqual(app.providers.unscripted, []);
  } finally { await app.stop(); }
});
