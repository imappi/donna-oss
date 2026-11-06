import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { physicalHash } from './physicalReconciliation.js';
import { buildPhysicalQualification, renderPhysicalQualification } from './physicalQualification.js';
const snapshot = JSON.parse(await readFile(new URL('../../../fixtures/physical-qualification/snapshot.json',import.meta.url),'utf8'));
const inputs = JSON.parse(await readFile(new URL('../../../fixtures/physical-qualification/inputs.json',import.meta.url),'utf8'));
const fixture = () => structuredClone(snapshot);
const reseal = s => { delete s.sourceDigest; s.sourceDigest = physicalHash(s); return s; };

test('qualification retains incomplete denominator, unknown costs, occlusion, and wrong confident support',()=>{
  const report = buildPhysicalQualification(snapshot,inputs);
  assert.equal(report.sample.admittedLines,6); assert.equal(report.sample.pairedLines,5);
  assert.deepEqual(report.detection.detection,{ numerator:2,denominator:4,fraction:.5 });
  assert.equal(report.detection.materialFalseSupported,1);
  assert.equal(report.completion.submissionTime.unknown,1);
  assert.equal(report.sessions[0].valueCoverage.selectedValue,null);
  assert.equal(report.sessions[0].valueCoverage.unknownCostItems,1);
  assert.equal(report.sessions[0].rows[3].quantity,null);
  assert.equal(report.burden.uniqueEvidenceDocuments,1);
  assert.equal(report.burden.overdueAsks,1);
  assert.equal(report.burden.acknowledgedAsks,0);
  assert.equal(report.sessions[0].rows[4].pair.falseSupported,true);
  assert.equal(report.sessions[0].rows[4].pair.confidence,.99);
  assert.equal(report.completion.activeWorkerTime.status,'unavailable');
  assert.match(renderPhysicalQualification(report),/Fixture and automated test results are not pilot success/);
  assert.deepEqual(report,buildPhysicalQualification(snapshot,inputs));
});
test('pairs require independent actors and exact source versions; unknowns are not zero successes',()=>{
  const missing=buildPhysicalQualification(snapshot);
  assert.equal(missing.detection.detection.fraction,null);
  assert.equal(missing.sample.missingPairs,6);
  const bad=structuredClone(inputs);bad.pairedGroundTruth[0].actorId='counter';bad.pairedGroundTruth[1].observationDigest='superseded';
  assert.equal(buildPhysicalQualification(snapshot,bad).sample.pairedLines,3);
  bad.sourceDigest='old'; assert.throws(()=>buildPhysicalQualification(snapshot,bad),/input_revision/);
  bad.sourceDigest=inputs.sourceDigest;bad.pairedGroundTruth.push(bad.pairedGroundTruth[0]);
  assert.throws(()=>buildPhysicalQualification(snapshot,bad),/duplicate_pair/);
  const corrupt=fixture();corrupt.lines[0].counted_quantity=99;
  assert.throws(()=>buildPhysicalQualification(corrupt),/integrity/);
});
test('evidence/source changes and dismissed lines cannot certify coverage or completed reconciliation',()=>{
  const s=fixture();s.documents[0].checksum_sha256='changed';s.lines[0].physical_status='dismissed';
  const report=buildPhysicalQualification(reseal(s));
  assert.equal(report.completion.limitedLines,1);
  assert.equal(report.sessions[0].sufficientItems.numerator,0);
  assert.equal(report.sessions[0].staleItems,5);
  assert.equal(report.sessions[0].rows[0].complete,false);
  assert.equal(report.sessions[0].rows[0].consequence.laterOutcome.status,'unknown');
});
test('zero-cost coverage remains known, mixed currencies and missing population refuse value percentage',()=>{
  const s=fixture();s.lines=s.lines.slice(0,1);s.sessions=s.sessions.slice(0,1);
  s.lines[0].physical_basis.valuation={status:'priced',unitCost:0,carryingValue:0,currency:'GBP'};
  let report=buildPhysicalQualification(reseal(s));
  assert.equal(report.sessions[0].valueCoverage.selectedValue,0);
  assert.equal(report.sessions[0].valueCoverage.unknownCostItems,0);
  assert.equal(report.sessions[0].valueCoverage.selectedCoverage.fraction,null);
  assert.equal(report.sessions[0].valueCoverage.populationCoverage.status,'unavailable');
  s.lines[0].physical_basis.valuation.carryingValue=50;s.lines[0].physical_basis.valuation.unitCost=5;reseal(s);
  const population={sessionId:'1',totalCarryingValue:100,currency:'GBP',sourceReference:'synthetic-population',
    basisDigest:physicalHash([{lineId:'1',digest:'basis-0'}])};
  report=buildPhysicalQualification(s,{sourceDigest:s.sourceDigest,populations:[population]});
  assert.equal(report.sessions[0].valueCoverage.populationCoverage.fraction,.5);
  population.currency='EUR';assert.equal(buildPhysicalQualification(s,{sourceDigest:s.sourceDigest,populations:[population]}).sessions[0].valueCoverage.populationCoverage.status,'unavailable');
});
test('superseded attempts and reported review time survive without becoming active time',()=>{
  const s=fixture();const l=s.lines[1];l.payload.versions.push({kind:'resolution',resolution:{learning:{reviewer:{seconds:60}}}},
    {kind:'resolution',resolution:{learning:{reviewer:{seconds:null}}}}, {kind:'observation',observation:{...l.physical_observation,inputDigest:'second',version:2}});
  const r=buildPhysicalQualification(reseal(s));
  assert.equal(r.burden.repeatedAttempts,1);
  assert.equal(r.completion.reportedReviewTotalSeconds,60);
  assert.equal(r.completion.reportedReviewTime.unknown,1);
  assert.equal(r.completion.activeReviewTime.status,'unavailable');
});
test('historical pairs, photos, and observation denominators survive a real recount-shaped transition',()=>{
  const s=fixture(),line=s.lines[3],original=line.physical_observation;
  line.payload.versions.push({kind:'resolution',before:{basis:{...line.physical_basis,expectedQuantity:10},observation:original},resolution:{action:'recount_required'}});
  line.physical_basis={...line.physical_basis,inputDigest:'fresh-basis'};line.physical_observation=null;line.physical_status='recount_required';
  reseal(s);const pairedInputs={...structuredClone(inputs),sourceDigest:s.sourceDigest};
  let r=buildPhysicalQualification(s,pairedInputs);
  assert.equal(r.detection.knownDiscrepancies,4,'recount never removes an independent known discrepancy');
  assert.equal(r.sample.pairedObservations,5);
  const second={...original,quantity:7,variance:-3,uncertain:false,inputDigest:'second-count',expectedDigest:'fresh-basis',version:2,evidenceRefs:[{documentId:'second-photo',checksum:'b',size:100}]};
  line.payload.versions.push({kind:'observation',observation:second});line.physical_observation=second;line.physical_status='variance';
  s.documents.push({id:'second-photo',checksum_sha256:'b',storage_object_key:'synthetic/second'});reseal(s);pairedInputs.sourceDigest=s.sourceDigest;
  pairedInputs.pairedGroundTruth.push({...pairedInputs.pairedGroundTruth[3],observationDigest:'second-count',expectationDigest:'fresh-basis'});
  r=buildPhysicalQualification(s,pairedInputs);
  assert.equal(r.detection.knownDiscrepancies,5);assert.equal(r.sample.pairedObservations,6);
  assert.equal(r.burden.uniqueEvidenceDocuments,2);assert.equal(r.burden.knownBytes,142);
  assert.equal(r.noChange.humanCounts.denominator,6);
});
test('replied asks remain active/overdue and out-of-window ground truth is refused',()=>{
  const s=fixture();s.asks[0].status='replied';reseal(s);
  const pairedInputs={...structuredClone(inputs),sourceDigest:s.sourceDigest};
  pairedInputs.pairedGroundTruth[0].observedAt='2000-01-01';pairedInputs.pairedGroundTruth[1].observedAt='2099-01-01';
  const r=buildPhysicalQualification(s,pairedInputs);
  assert.equal(r.burden.activeAsks,1);assert.equal(r.burden.overdueAsks,1);assert.equal(r.sample.pairedLines,3);
});
test('known zero cost is quantity discrepancy evidence, never a nonzero value discrepancy',()=>{
  const s=fixture();s.lines[1].physical_basis.valuation={status:'priced',unitCost:0,carryingValue:0,currency:'GBP'};reseal(s);
  const r=buildPhysicalQualification(s,{...inputs,sourceDigest:s.sourceDigest});
  assert.equal(r.detection.detection.denominator,4);assert.equal(r.detection.valueDetection.denominator,2);
  assert.equal(r.sessions[0].rows[1].pair.value.truthVariance,0);
});
test('separate active interval and cost records remain attributable with missing session denominators',()=>{
  const r=buildPhysicalQualification(snapshot,{sourceDigest:snapshot.sourceDigest,sessionMeasurements:[{sessionId:'1',actorId:'timer',sourceReference:'interval-log',
    ownerActiveSeconds:120,reviewerActiveSeconds:60,costs:{currency:'GBP',inferenceAmount:0,operatorAmount:2}}]});
  assert.equal(r.externalMeasurements.ownerActiveTime.samples,1);assert.equal(r.externalMeasurements.ownerActiveTime.denominator,2);
  assert.equal(r.externalMeasurements.costs[0].inferenceAmount,0);assert.equal(r.externalMeasurements.costs[0].mediaStorageAmount,null);
  assert.equal(r.externalMeasurements.costs[1].operatorAmount,null);
  assert.equal(r.completion.activeWorkerTime.status,'unavailable');
});

test('complete attributable intervals and costs remove the external missing-input labels only',()=>{
  const sessionMeasurements=snapshot.sessions.map(s=>({sessionId:String(s.id),actorId:'timer',sourceReference:'interval-log',
    ownerActiveSeconds:120,reviewerActiveSeconds:60,costs:{currency:'GBP',inferenceAmount:0,mediaStorageAmount:0,operatorAmount:2}}));
  const r=buildPhysicalQualification(snapshot,{sourceDigest:snapshot.sourceDigest,sessionMeasurements});
  assert.equal(r.missingInputs.includes('active_worker_and_reviewer_intervals'),false);
  assert.equal(r.missingInputs.includes('inference_storage_and_operator_costs'),false);
  assert.equal(r.completion.activeWorkerTime.status,'unavailable');
  sessionMeasurements[0].costs.currency='invalid';
  assert.equal(buildPhysicalQualification(snapshot,{sourceDigest:snapshot.sourceDigest,sessionMeasurements}).missingInputs.includes('inference_storage_and_operator_costs'),true);
});


test('escalated drafts retain prior delivery history without acknowledging the new recipient',()=>{
  const s=fixture(),ask=s.asks[0];
  ask.status='draft';ask.send_count=1;ask.addressee_principal_id='senior';
  ask.request_payload.physical_escalation={recipient:{principalId:'senior'},escalated_at:'2026-10-07T10:30:00Z'};
  ask.last_sent_at='2026-10-07T10:20:00Z';
  ask.request_payload.delivery_status='not_delivered';reseal(s);
  let r=buildPhysicalQualification(s);
  assert.equal(r.burden.acknowledgedAsks,0);assert.equal(r.burden.undeliveredAsks,1);
  assert.equal(r.burden.activeAsks,1);
  ask.status='resolved';reseal(s);r=buildPhysicalQualification(s);
  assert.equal(r.burden.acknowledgedAsks,0,'resolution cannot manufacture delivery to the new recipient');
  ask.status='open';ask.send_count=2;ask.last_sent_at='2026-10-07T10:35:00Z';reseal(s);r=buildPhysicalQualification(s);
  assert.equal(r.burden.acknowledgedAsks,1);assert.equal(r.burden.undeliveredAsks,0);
});

test('known contradictory independent count is workflow-terminal but never successful completion or no-change',()=>{
  const r=buildPhysicalQualification(snapshot,inputs);
  const wrong=r.sessions[0].rows.find(row=>row.pair.falseSupported);
  assert.equal(wrong.workflowComplete,true);assert.equal(wrong.independentValidation,'contradicted');
  assert.equal(wrong.complete,false);assert.equal(wrong.coverage.sufficientAtPinnedBasis,false);
  assert.equal(r.sessions[0].rows.find(row=>row.status==='uncertain').independentValidation,'unknown');
  assert.deepEqual(r.completion.lines,{numerator:1,denominator:6,fraction:1/6});
  assert.deepEqual(r.noChange.humanCounts,{numerator:1,denominator:5,fraction:1/5});
  const unpaired=buildPhysicalQualification(snapshot).sessions[0].rows.find(row=>row.lineId===wrong.lineId);
  assert.equal(unpaired.workflowComplete,true);assert.equal(unpaired.independentValidation,'unknown');
  assert.match(renderPhysicalQualification(r),/missing pairs remain unknown/);
});

test('paired ground truth refuses intervening movements but retains counts before later movements',()=>{
  for(const occurred_at of ['2026-10-07T10:00:30Z','2026-10-07T10:01:15Z','2026-10-07T10:02:00Z']){
    const s=fixture(),line=s.lines[0];
    s.operations.push({id:'new-movement',item_id:line.item_id,location_id:line.location_id,operation_type:'shipment',quantity:2,occurred_at});
    reseal(s);
    const r=buildPhysicalQualification(s,{...inputs,sourceDigest:s.sourceDigest});
    const later=occurred_at==='2026-10-07T10:02:00Z';
    assert.equal(r.sample.admittedLines,6);assert.equal(r.sample.admittedObservations,5);
    assert.equal(r.sample.pairedObservations,later?5:4);
    assert.equal(r.sample.unpairedObservations,later?0:1);
    assert.equal(r.sessions[0].rows[0].pair.status,later?'available':'unavailable');
    if(!later)assert.ok(r.inputProblems.some(p=>p.startsWith('pair_movement:')));
  }
});
