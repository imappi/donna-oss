import test from 'node:test';
import assert from 'node:assert/strict';
import { physicalQualificationFixture } from '../testSupport/physicalQualificationFixture.js';
import { exportPhysicalQualification } from './physicalQualificationDb.js';
import { buildPhysicalQualification } from './physicalQualification.js';
import { openPhysicalReconciliation, observePhysicalReconciliation, resolvePhysicalReconciliation } from './physicalReconciliationDb.js';

test('qualification exports actual count/evidence/ask/outcome history read-only and scoped',async()=>{
  const f=await physicalQualificationFixture(),client=await f.pool.connect();
  try{
    const a={...f.a,client};
    const open=await openPhysicalReconciliation({...a,itemIds:['item-0','item-1','item-2','item-3','item-4'],locationId:'shelf',idempotencyKey:'qualification-open'});
    assert.equal(open.applied,true,JSON.stringify(open));
    const sessionId=open.session.id;
    const observations=[];
    for(let i=0;i<4;i++){
      const line=open.lines.find(l=>l.item_id===`item-${i}`);
      const result=await observePhysicalReconciliation({...a,sessionId,lineId:line.id,observedQuantity:[10,8,12,null][i],uncertain:i===3,humanConfirmed:true,
        observedAt:new Date().toISOString(),evidenceRefs:[{documentId:'fixture-photo',checksum:f.checksum}],idempotencyKey:`observation-${i}`});
      assert.equal(result.applied,true,JSON.stringify(result)); observations.push(result.lines.find(l=>l.id===line.id));
    }
    const line=observations[1];
    const recount=await resolvePhysicalReconciliation({...a,sessionId,lineId:line.id,action:'recount_required',reason:'Independent recount required',
      reviewSeconds:60,expectedObservationDigest:line.physical_observation.inputDigest,idempotencyKey:'recount'});
    assert.equal(recount.applied,true,JSON.stringify(recount));
    const before=(await client.query("select (select count(*) from inventory_operations) operations,(select count(*) from ledger_journals) journals,(select count(*) from audit_events) audits")).rows[0];
    const snapshot=await exportPhysicalQualification(a);
    const after=(await client.query("select (select count(*) from inventory_operations) operations,(select count(*) from ledger_journals) journals,(select count(*) from audit_events) audits")).rows[0];
    assert.deepEqual(after,before);
    assert.equal(snapshot.lines.length,5);assert.equal(snapshot.documents.length,1);
    assert.ok(snapshot.asks.some(ask=>ask.status==='resolved'),'retains answered asks');
    assert.ok(snapshot.asks.some(ask=>ask.status==='draft'),'retains undelivered obligations');
    assert.ok(snapshot.audit.length>=6);assert.ok(snapshot.caseEvents.length>0);
    const report=buildPhysicalQualification(snapshot);
    assert.equal(report.completion.lines.numerator,1);assert.equal(report.completion.lines.denominator,5);
    assert.equal(report.completion.reportedReviewTotalSeconds,60);
    assert.equal(report.sample.missingPairs,5);
    assert.equal(report.sessions[0].rows.find(r=>r.lineId===String(line.id)).observationAttempts,1,'superseded observation retained after recount');
    assert.equal(report.sessions[0].valueCoverage.populationCoverage.status,'unavailable');
    const paired=buildPhysicalQualification(snapshot,{sourceDigest:snapshot.sourceDigest,cohort:'test',pairedGroundTruth:[{
      sessionId:String(sessionId),lineId:String(line.id),observationDigest:line.physical_observation.inputDigest,
      expectationDigest:line.physical_basis.inputDigest,quantity:8,actorId:'independent-counter',blind:true,independent:true,
      sourceReference:'synthetic-independent-sheet',environment:'synthetic_shelf',failureClass:'shortage',observedAt:line.physical_observation.observedAt
    }]});
    assert.equal(paired.detection.knownDiscrepancies,1);
    assert.equal(paired.detection.detection.numerator,1,'actual persisted version remains paired after recount clears the head');
    await assert.rejects(exportPhysicalQualification({...a,firmId:'other-firm'}),/access/i);
    await assert.rejects(exportPhysicalQualification({...a,clientId:'foreign-client'}),/scope_refused/);
    await client.query("update firm_members set status='suspended' where id='member'");
    await assert.rejects(exportPhysicalQualification(a),/access/i);
  }finally{client.release();await f.dispose();}
});
test('qualification retains more than the UI last-20 checks, including closed matches',async()=>{
  const f=await physicalQualificationFixture(),client=await f.pool.connect();
  try{
    const a={...f.a,client};
    for(let i=0;i<21;i++){
      const opened=await openPhysicalReconciliation({...a,itemIds:['item-0'],locationId:'shelf',idempotencyKey:`archive-${i}`});
      assert.equal(opened.applied,true,JSON.stringify(opened));
      const counted=await observePhysicalReconciliation({...a,sessionId:opened.session.id,lineId:opened.lines[0].id,observedQuantity:10,humanConfirmed:true,
        observedAt:new Date().toISOString(),evidenceRefs:[{documentId:'fixture-photo',checksum:f.checksum}],idempotencyKey:`archive-count-${i}`});
      assert.equal(counted.applied,true,JSON.stringify(counted));assert.equal(counted.session.state,'closed');
    }
    const snapshot=await exportPhysicalQualification(a),report=buildPhysicalQualification(snapshot);
    assert.equal(snapshot.sessions.length,21);assert.equal(snapshot.lines.length,21);
    assert.equal(report.sample.admittedSessions,21);assert.equal(report.completion.sessions.numerator,21);
    assert.equal(report.burden.admittedAsks,21);assert.equal(report.noChange.humanCounts.denominator,21);
  }finally{client.release();await f.dispose();}
});
