// Explicit member actions for the prepared FI pilot. No operation accepts
// caller-supplied readiness, an actor id, a model id, or arbitrary flag stages.
import { createExecutionBudget,runWithExecutionBudget } from './executionBudget.js';
import { evaluateEntityReadinessAdmissionWithClient } from './runtimeReadinessAdmission.js';
import { randomUUID } from 'node:crypto';
import { withCloudReadinessClient,renewCloudHostReadinessIfDue } from './cloudRuntimeReadiness.js';
import { readInternalPilotAccessWithClient } from './internalPilotAccess.js';
import { readCurrentHostCertificateWithClient,hostReadinessIsMutationReady,provisionEntityReadiness } from './runtimeReadiness.js';
import { resolveRuntimeHostIdentity } from './runtimeHostIdentity.js';
import { cloudCredentialGeneration,CLOUD_DEPENDENCY_EVIDENCE_VERSION,verifyDependencyFact } from './cloudDependencyEvidence.js';
import { resolveUnifiedProvider } from './unifiedExtractor.js';
import { llmCall,telemetryForDecision } from './llmCall.js';
import { recordLlmDecision } from './llmDecisions.js';
import { providerFetchWithDeadline } from './providerTransport.js';
import { setClientFlagStage,clientFlagActs } from './clientConfig.js';
import { readConsumedOwnerAdoptionWithClient } from './existingOwnerRevalidation.js';
import { hostDigest } from './hostCertificateA.js';
import { getLane } from './modelLanes.js';
import { readLaneDecidingPolicy,setLaneDecidingPolicy } from './modelLanePolicy.js';
import { DEFAULT_MODEL,getModel } from './reconciliationLlmCore.js';
import { refreshTransactionIntelForClient } from './db/transactions.js';


import { CLOUD_PILOT_PROCESSING_VERSION,CLOUD_PILOT_PROCESSING_FLAGS } from './cloudPilotConfig.js';
export { CLOUD_PILOT_PROCESSING_VERSION,CLOUD_PILOT_PROCESSING_FLAGS };
const refuse=(code,message)=>{throw Object.assign(new Error(message),{code,statusCode:409});};
const scopedMember=async(client,{firmId,clientId,principal})=>{
  if(principal?.principalType!=='firm_member'||!principal.principalId)refuse('PILOT_OPERATOR_REQUIRED','An identified active firm member must run this action.');
  const member=(await client.query("select id from firm_members where firm_id=$1 and id=$2 and status='active' for share",[firmId,principal.principalId])).rows[0];
  if(!member||!await readInternalPilotAccessWithClient(client,{firmId,clientId}))refuse('PILOT_OPERATOR_REQUIRED','Select an explicitly prepared pilot and an active member of its firm.');
  return member.id;
};
const legacyPosture=()=>Object.fromEntries(['AUTO_AI_CODING_ENABLED','RECONCILIATION_AUTO_MATCH_POLICY','BILL_MATCHER_ENABLED',
  'SALES_INVOICE_MATCHER_ENABLED','RECEIPT_CLASSIFIER_ENABLED','BILL_AUTO_EXPLAIN_ENABLED','SALES_INVOICE_AUTO_EXPLAIN_ENABLED','LOOPS_TIER']
  .map(key=>[key,key==='LOOPS_TIER'?(['off','shadow','canary','active'].includes(process.env[key])?process.env[key]:process.env[key]?'invalid':null)
    :process.env[key]==null?null:['1','true'].includes(process.env[key].toLowerCase())?'on':['0','false',''].includes(process.env[key].toLowerCase())?'off':'invalid']));
const reviewReconcileOwnership=async(client,scope,host)=>{
  const seats=[];
  for(const laneId of ['bank_line_disposition','reconciliation_reasoning']) {
    const policy=await readLaneDecidingPolicy({client,firmId:scope.firmId,clientId:scope.clientId,laneId});
    if(policy)seats.push({lane:laneId,...policy});
  }
  let route=null;try{route=resolveUnifiedProvider({provider:'anthropic'});}catch{}
  const defaultUnchanged=getModel()===DEFAULT_MODEL && route?.model===DEFAULT_MODEL
    && getLane('reconciliation_reasoning')?.qualified?.includes(DEFAULT_MODEL)===true;
  // Host A v7: provider_capability PASS is configuration. Choosing a deciding
  // model still requires that both providers actually answered this
  // deployment — the response proof receipt, read here, never at admission.
  const providerProven=host?.checks?.some(check=>check.id==='provider_capability'&&check.status==='PASS'
    &&check.detail?.response_proof?.status==='verified')===true;
  const residue=(await client.query(`select count(*)::integer as n from reconciliation_matches m
    where firm_id=$1 and client_id=$2 and created_by='system' and status='suggested'
      and payload->>'source'='transaction_intel'
      and (payload->'authorization' is null or payload->'authorization'='null'::jsonb)
      and not exists(select 1 from reconciliation_authorization_requests auth_ref where auth_ref.match_id=m.id)
      and not exists(select 1 from document_credit_applications credit_ref where credit_ref.settlement_match_id=m.id)`,[scope.firmId,scope.clientId])).rows[0]?.n||0;
  return {seats,default_unchanged:defaultUnchanged,provider_proven:providerProven,
    proposed:seats.length?null:{lane:'reconciliation_reasoning',deciding_model:DEFAULT_MODEL,basis:'experiment'},
    eligible:seats.length>0 || defaultUnchanged&&providerProven,residue_count:residue};
};
const reviewWithClient=async(client,scope)=>{
  await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))",[`entity-readiness:${scope.firmId}:${scope.clientId}`]);
  const actorId=await scopedMember(client,scope);
  const target=(await client.query('select id,profile,jurisdiction,entity_type,xmin::text as version from clients where firm_id=$1 and id=$2 for update',[scope.firmId,scope.clientId])).rows[0];
  if(target?.jurisdiction?.toUpperCase()==='SG')refuse('SG_PROCESSING_SCOPE_FIXED','Singapore setup permits document processing and review only. Automatic posting is off.');
  if(!target || target.jurisdiction?.toUpperCase()!=='FI' || target.entity_type!=='fi-oy')refuse('PILOT_CLIENT_REQUIRED','Select the prepared Finnish Oy.');
  await client.query('select host_id from runtime_host_readiness where host_id=$1 for share',[resolveRuntimeHostIdentity().host_id]);
  const host=await readCurrentHostCertificateWithClient(client);
  const configuration=(await client.query('select flag_key,stage,source,reason from client_capability_config where firm_id=$1 and client_id=$2 and valid_to is null order by flag_key',[scope.firmId,scope.clientId])).rows;
  const changes=CLOUD_PILOT_PROCESSING_FLAGS.map(flag_key=>({flag_key,stage:'canary',source:'manual',reason:CLOUD_PILOT_PROCESSING_VERSION}));
  const identity=resolveRuntimeHostIdentity();
  const hostReady=hostReadinessIsMutationReady({certificate:host,hostIdentity:identity});
  const reasoningOwnership=await reviewReconcileOwnership(client,scope,host);
  const adoption=await readConsumedOwnerAdoptionWithClient(client,{firmId:scope.firmId,clientId:scope.clientId,lock:true});
  const preparation=(await client.query(`select metadata->'owner_provenance'->>'kind' as kind from audit_events
    where firm_id=$1 and client_id=$2 and action='pilot.prepared' order by id desc limit 1`,[scope.firmId,scope.clientId])).rows[0];
  const firmIntake=preparation?.kind==='authenticated_firm_creation';
  const review={...(firmIntake?{firm_intake:true}:{}),...(adoption?{owner_adoption:adoption}:{}),firm_id:scope.firmId,client_id:scope.clientId,actor_id:actorId,client_version:target?.version,
    host_ready:hostReady,host_receipt:host?.receipt_digest||null,host_generation:identity.generation_digest,
    expires_at:host?.effective_valid_until||host?.freshness?.valid_until||null,
    // A PASS dependency check names its unverified/failed proof (v7 monitoring).
    checks:(host?.checks||[]).map(c=>{const proof=c.detail?.execution_proof||c.detail?.response_proof;
      return {id:c.id,status:c.status,reason:c.detail?.reason||(proof&&proof.status!=='verified'?`${c.detail.execution_proof?'execution':'response'}_${proof.status}`:null)};}),
    changes,configuration,reasoning_ownership:reasoningOwnership,legacy_configuration:legacyPosture(),
    scope:'this_client_only_no_material_authority_no_sends_no_filing',
    processing_staged:reasoningOwnership.seats.length>0 && reasoningOwnership.residue_count===0 && changes.every(c=>configuration.some(r=>r.flag_key===c.flag_key&&r.stage===c.stage&&r.source===c.source&&r.reason===c.reason
      &&clientFlagActs({flagKey:c.flag_key,snapshot:{[c.flag_key]:r},envFallback:()=>false}))),
    material_authority:'existing_country_policy_and_explicit_owner_actions_only'};
  const admission=await evaluateEntityReadinessAdmissionWithClient({client,firmId:scope.firmId,clientId:scope.clientId,boundary:'upload_sign'});
  review.entity_ready=admission.enforced===true && admission.allowed===true;
  review.entity_reason=admission.reason_code||null;
  return {...review,review_digest:hostDigest(review)};
};
export const reviewCloudPilotOperations=scope=>withCloudReadinessClient(async client=>{
  await client.query('begin');try{const result=await reviewWithClient(client,scope);await client.query('commit');return result;}catch(e){await client.query('rollback');throw e;}
});
export const enableCloudPilotProcessing=async(scope,{reviewDigest,confirmed}={})=>{
  if(confirmed!==true||!reviewDigest)refuse('PILOT_PROCESSING_REVIEW_REQUIRED','Review the exact client processing changes before applying them.');
  const result=await withCloudReadinessClient(async client=>{
    await client.query('begin');try{
      await client.query('lock table model_lane_policy in share row exclusive mode');
      const review=await reviewWithClient(client,scope);
      if(review.review_digest!==reviewDigest)refuse('PILOT_PROCESSING_REVIEW_STALE','The pilot or host changed. Refresh the review.');
      if(!review.host_ready)refuse('PILOT_HOST_NOT_READY','Complete the hosted dependency checks first.');
      if(!review.reasoning_ownership.eligible)refuse('PILOT_RECONCILE_DEFAULT_UNPROVEN','The current default reconciliation route needs review and provider evidence.');
      if(review.reasoning_ownership.proposed)await setLaneDecidingPolicy({client,firmId:scope.firmId,clientId:scope.clientId,
        laneId:review.reasoning_ownership.proposed.lane,decidingModel:review.reasoning_ownership.proposed.deciding_model,
        basis:'experiment',reason:'explicit_fi_pilot_default_reconcile_ownership',actorType:'firm_member',actorId:review.actor_id,manageTransaction:false});

      for(const change of review.changes)await setClientFlagStage(client,{firmId:scope.firmId,clientId:scope.clientId,flagKey:change.flag_key,
        stage:change.stage,source:change.source,reason:change.reason,actorType:'firm_member',actorId:review.actor_id});
      const receipt=(await client.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
        values($1,$2,'firm_member',$3,'pilot.processing.staged','client',$2,$4::jsonb) returning id`,[scope.firmId,scope.clientId,review.actor_id,
        JSON.stringify({version:CLOUD_PILOT_PROCESSING_VERSION,review_digest:reviewDigest,host_receipt:review.host_receipt,changes:review.changes,reasoning_ownership:review.reasoning_ownership,
          authority_basis:'active_member_confirmed_exact_client_configuration',material_authority_granted:false,external_sends:false,filing:false})])).rows[0];
      const hasSaga=(await client.query('select 1 from entity_readiness_sagas where firm_id=$1 and client_id=$2',[scope.firmId,scope.clientId])).rowCount>0;
      await client.query('commit');return{receipt_id:Number(receipt.id),firm_id:scope.firmId,client_id:scope.clientId,actor_id:review.actor_id,retry_existing:hasSaga,creation_path:review.owner_adoption?'existing_owner_adoption':review.firm_intake?'desktop_firm_intake':'self_provision'};
    }catch(e){await client.query('rollback');throw e;}
  });
  try {
    const readiness=await provisionEntityReadiness({withFirmDbClientFn:withCloudReadinessClient,firmId:scope.firmId,clientId:scope.clientId,creationPath:result.creation_path,
      retry:result.retry_existing,requiredEnrollmentKind:'manual_target',compatibilityScope:'current_generation_compatibility'});
    let reconciliationRecovery=null;
    if(readiness.row?.state==='ready') try { reconciliationRecovery=await withCloudReadinessClient(async client=>{
      await client.query('begin');try{
        await client.query('lock table model_lane_policy in share mode');
        await scopedMember(client,scope);
        const admission=await evaluateEntityReadinessAdmissionWithClient({client,firmId:scope.firmId,clientId:scope.clientId,boundary:'upload_sign'});
        if(admission.enforced!==true||admission.allowed!==true)refuse('PILOT_RECONCILE_RECOVERY_NOT_READY','The pilot must remain admitted for reconciliation recovery.');
        const recovered=await refreshTransactionIntelForClient({client,firmId:scope.firmId,clientId:scope.clientId,retireSuggestedResidueOnly:true,
          retirementAuthority:{actorId:result.actor_id,receiptId:result.receipt_id,reviewDigest}});
        await client.query('commit');return recovered;
      }catch(error){await client.query('rollback');throw error;}
    });
    } catch(error) { reconciliationRecovery={outcome:'retry_pending',code:error.code||'PILOT_RECONCILE_RECOVERY_FAILED'}; }
    return {...result,configuration_staged:true,entity_state:readiness.row?.state||'INCOMPLETE',reason:reconciliationRecovery?.outcome==='retry_pending'?'PILOT_RECONCILE_RECOVERY_RETRY_REQUIRED':readiness.row?.reason_code||null,reconciliation_recovery:reconciliationRecovery};
  } catch(error) {
    return {...result,configuration_staged:true,entity_state:'INCOMPLETE',reason:error.code||'ENTITY_READINESS_RETRY_REQUIRED'};
  }
};

const reserveProviderProbe=async(scope,kind)=>withCloudReadinessClient(async client=>{
  await client.query('begin');try{
    const actorId=await scopedMember(client,scope),identity=resolveRuntimeHostIdentity();
    if(identity.reason||identity.runtime_host!=='vercel')refuse('PILOT_CLOUD_IDENTITY_REQUIRED','An identified cloud deployment is required.');
    const credential=cloudCredentialGeneration(kind);
    if(!credential)refuse('PILOT_PROVIDER_KEY_MISSING','The provider is not configured.');
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))",['cloud-provider-probe:'+identity.host_id+':'+kind]);
    const latest=(await client.query(`select certificate->'dependency_evidence' as evidence from runtime_host_readiness_attempts
      where host_id=$1 and certificate_version=$2 and certificate #>> '{dependency_evidence,fact,kind}'=$3 order by attempt_sequence desc limit 1`,
    [identity.host_id,CLOUD_DEPENDENCY_EVIDENCE_VERSION,kind])).rows[0]?.evidence;
    if(latest&&verifyDependencyFact(kind,latest,identity,new Date().toISOString())&&latest.fact.detail.outcome==='response_received'){
      await client.query('commit');return{already_proven:true};
    }
    const attempts=(await client.query(`select count(*)::integer as n,max(created_at) as last_at from audit_events where action='pilot.provider_probe.started'
      and metadata->>'host_generation'=$1 and metadata->>'credential_generation'=$2 and metadata->>'provider'=$3
      and created_at > clock_timestamp() - interval '5 minutes'`,
    [identity.generation_digest,credential,kind])).rows[0];
    if(attempts.n>=3||attempts.last_at&&Date.now()-Date.parse(attempts.last_at)<60000)refuse('PILOT_PROVIDER_PROBE_LIMIT','This provider has a recent probe or has used its three checks for five minutes. Inspect the failure and retry after the cooldown.');
    const id=randomUUID();
    await client.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
      values($1,$2,'firm_member',$3,'pilot.provider_probe.started','provider_probe',$4,$5::jsonb)`,[scope.firmId,scope.clientId,actorId,id,
      JSON.stringify({host_generation:identity.generation_digest,credential_generation:credential,provider:kind,max_output_tokens:128,
        maximum_calls:1,purpose:'synthetic_transport_only',authority_basis:'explicit_active_member_dependency_action'})]);
    await client.query('commit');return{id};
  }catch(e){await client.query('rollback');throw e;}
});
const runDependencyProbes=async scope=>{
  const results=[];
  for(const kind of ['openai','anthropic']){
    let reservation;
    try{
      reservation=await reserveProviderProbe(scope,kind);
      if(reservation.already_proven){results.push({provider:kind,status:'already_proven'});continue;}
      const route=resolveUnifiedProvider({provider:kind});
      const prompt='Reply with exactly OK.';
      const common={provider:kind,execution:{root:{type:'host_provider_probe',id:reservation.id}},maxAttempts:1,
        fetchImpl:providerFetchWithDeadline({provider:kind,timeoutMs:30000,reserveMs:5000}),sections:{context:prompt}};
      const call=kind==='openai'?{
        url:'https://api.openai.com/v1/responses',headers:{'Content-Type':'application/json',Authorization:`Bearer ${route.apiKey}`},
        body:{model:route.model,store:false,max_output_tokens:128,reasoning:{effort:'low'},input:prompt}
      }:{url:'https://api.anthropic.com/v1/messages',headers:{'Content-Type':'application/json','x-api-key':route.apiKey,'anthropic-version':'2023-06-01'},
        body:{model:route.model,max_tokens:128,messages:[{role:'user',content:prompt}]}};
      const {telemetry}=await llmCall({...common,...call});
      await withCloudReadinessClient(client=>recordLlmDecision({client,firmId:scope.firmId,clientId:scope.clientId,decisionType:'host_provider_probe',
        targetType:'provider_probe',targetId:reservation.id,modelName:telemetry?.model,finalState:'transport_observed',telemetry:telemetryForDecision(telemetry)}));
      results.push({provider:kind,status:telemetry?.cloud_dependency_evidence?.fact?.detail?.outcome==='response_received'?'response_observed':'INCOMPLETE'});
    }catch(error){results.push({provider:kind,status:'INCOMPLETE',code:error.code||'CLOUD_PROVIDER_PROBE_FAILED'});}
  }
  // Revalidate the principal immediately before dispatch. SDK events carry the
  // selected scope; only the existing convergence and recovery functions run.
  const actorId=await withCloudReadinessClient(client=>scopedMember(client,scope));
  const {inngest}=await import('./inngest/client.js');
  const event=await inngest.send({name:'donna/host.readiness.requested',data:{firm_id:scope.firmId,client_id:scope.clientId}});
  const host=await renewCloudHostReadinessIfDue();
  return{firm_id:scope.firmId,client_id:scope.clientId,actor_id:actorId,providers:results,worker_event_ids:event.ids,host,scope:'synthetic_transport_only_no_bookkeeping_verdict'};
};

export const runCloudPilotDependencyProbes = scope => {
  const budget=createExecutionBudget({timeoutMs:70000,label:'cloud-pilot-dependency-probe'});
  const timer=setTimeout(()=>budget.abort('cloud_probe_deadline'),70000);
  return runWithExecutionBudget(budget,()=>runDependencyProbes(scope)).finally(()=>clearTimeout(timer));
};
