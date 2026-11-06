import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { resolveRuntimeHostIdentity } from './runtimeHostIdentity.js';
import { CLOUD_ATTESTATION_VERSION, attestationBytes, verifyCloudDeploymentAttestation } from './cloudDeploymentAttestation.js';
import { makeDependencyFact, verifyDependencyFact, cloudCredentialGeneration } from './cloudDependencyEvidence.js';
import { captureCloudProviderProvenance } from './cloudProviderProvenance.js';
import { createExecutionBudget, runWithExecutionBudget } from './executionBudget.js';
const at = '2026-09-13T12:00:00.000Z';
const pair = generateKeyPairSync('ed25519');
const env = { VERCEL:'1',VERCEL_ENV:'preview',VERCEL_PROJECT_ID:'prj_fixture',VERCEL_DEPLOYMENT_ID:'dpl_fixture',
  VERCEL_GIT_COMMIT_SHA:'a'.repeat(40),DATABASE_URL:'postgresql://fixture:secret@db.invalid/db',SUPABASE_URL:'https://storage.invalid',
  DONNA_HOST_ATTESTATION_TEAM_ID:'team_fixture',DONNA_HOST_ATTESTATION_PUBLIC_KEY:pair.publicKey.export({type:'spki',format:'pem'}),
  OPENAI_API_KEY:'fixture-openai',ANTHROPIC_API_KEY:'fixture-anthropic',INNGEST_SIGNING_KEY:'fixture-signing'};
const identity = resolveRuntimeHostIdentity(env);
const payload = { version:CLOUD_ATTESTATION_VERSION,platform:'vercel',platform_state:'READY',deployment_id:'dpl_fixture',
  project_id:'prj_fixture',team_id:'team_fixture',environment:'preview',source_commit:'a'.repeat(40),platform_response_digest:'fixture-response-digest',
  issued_at:at,expires_at:'2026-09-20T12:00:00.000Z' };
const signed = p=>({payload:p,signature:sign(null,attestationBytes(p),pair.privateKey).toString('base64')});
const verify = (artifact,options={})=>verifyCloudDeploymentAttestation({artifact,identity,env,observedAt:at,...options});
test('deployment attestation binds platform/team/project/source and exact expiry; reordered JSON survives',()=>{
  const artifact = signed(payload);
  assert.equal(verify(artifact).status,'PASS');
  const reordered = { ...artifact,payload:Object.fromEntries(Object.entries(payload).reverse()) };
  assert.equal(verify(reordered).status,'PASS');
  for(const [key,value] of Object.entries({platform:'caller',platform_state:'BUILDING',deployment_id:'other',project_id:'other',team_id:'other',environment:'production',source_commit:'b'.repeat(40)})) {
    assert.equal(verify(signed({...payload,[key]:value})).status,'INCOMPLETE',key);
  }
  for(const p of [{...payload,issued_at:'2026-09-13T12:00:01Z'},{...payload,expires_at:at},{...payload,expires_at:'2026-09-20T12:00:00.001Z'}]) assert.equal(verify(signed(p)).status,'INCOMPLETE');
  assert.equal(verify(artifact,{observedAt:payload.expires_at}).status,'INCOMPLETE');
  assert.equal(verify({...artifact,payload:{...payload,expires_at:'2027-01-01'}}).status,'INCOMPLETE');
  assert.equal(verify(artifact,{env:{...env,DONNA_HOST_ATTESTATION_TEAM_ID:'wrong'}}).status,'INCOMPLETE');
  assert.equal(verify(artifact,{env:{...env,DONNA_HOST_ATTESTATION_PUBLIC_KEY:'bad'}}).status,'INCOMPLETE');
  for(const value of [null,{},'PASS',{payload:null,signature:'not-a-signature'}]) assert.equal(verify(value).status,'INCOMPLETE');
});
test('dependency receipts survive JSON persistence and refuse source/key/time changes or caller metadata',()=>{
  const fact=makeDependencyFact({kind:'openai',env,observedAt:at,detail:{outcome:'response_received'}});
  assert.equal(verifyDependencyFact('openai',fact,identity,at,env),true);
  const reversed={...fact,fact:Object.fromEntries(Object.entries(fact.fact).reverse())};
  assert.equal(verifyDependencyFact('openai',reversed,identity,at,env),true);
  assert.equal(verifyDependencyFact('openai',{...fact,fact:{...fact.fact,detail:{outcome:'caller_pass'}}},identity,at,env),false);
  assert.equal(verifyDependencyFact('openai',fact,identity,at,{...env,OPENAI_API_KEY:'rotated'}),false);
  assert.notEqual(cloudCredentialGeneration('openai',env),cloudCredentialGeneration('anthropic',env));
  assert.equal(verifyDependencyFact('openai',fact,resolveRuntimeHostIdentity({...env,VERCEL_DEPLOYMENT_ID:'next'}),at,env),false);
  assert.equal(verifyDependencyFact('openai',fact,identity,'2026-09-20T12:00:00Z',env),false);
  assert.equal(verifyDependencyFact('openai',fact,identity,'2026-09-13T11:59:59Z',env),false);
});
test('provider evidence requires actual endpoint, credential, completed body and nonzero output; transport failures invalidate',()=>{
  const args={url:'https://api.openai.com/v1/responses',headers:{Authorization:'Bearer fixture-openai'},response:{url:'https://api.openai.com/v1/responses',ok:true,status:200},
    payload:{id:'response-fixture',model:'fixture-served-model',usage:{input_tokens:8,output_tokens:2}},observedAt:at,env};
  const capture=a=>captureCloudProviderProvenance({...args,...a});
  assert.equal(capture({}).fact.detail.outcome,'response_received');
  assert.equal(capture({response:{...args.response,url:'https://other.invalid'}}),null);
  assert.equal(capture({headers:{Authorization:'Bearer wrong'}}),null);
  for(const overrides of [{payload:{}},{payload:{...args.payload,usage:{input_tokens:1,output_tokens:0}}},{response:null,error:{code:'PROVIDER_NETWORK'}},{error:{code:'PROVIDER_TIMEOUT'}}]) {
    assert.equal(capture(overrides).fact.detail.outcome,'provider_failed');
  }
  const text=JSON.stringify(capture({}));assert.ok(!text.includes('fixture-openai'));assert.ok(!text.includes('secret'));
  const budget=createExecutionBudget({timeoutMs:1000});budget.abort();
  assert.throws(()=>runWithExecutionBudget(budget,()=>capture({})),{code:'CLOUD_PRODUCER_EXECUTION_EXPIRED'});
});
