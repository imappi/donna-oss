// Global dependency facts use the existing immutable host attempt store. They
// never update the current Host A projection or carry tenant/model prompt data.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { resolveRuntimeHostIdentity } from './runtimeHostIdentity.js';
import { hostDigest, canonicalHostJson, buildHostCertificateFreshness } from './hostCertificateA.js';
import { currentExecutionBudget, remainingExecutionBudgetMs, createExecutionBudget, runWithExecutionBudget } from './executionBudget.js';
import { MODEL_LANES } from './modelLanes.js';
import { CLOUD_VERIFIABLE_PROVIDER_ENDPOINTS } from './providerEndpoints.js';

export const dependencyEvidenceMaxAgeMs = kind => (kind === 'inngest' ? 26 : 7 * 24) * 60 * 60 * 1000;
export const CLOUD_DEPENDENCY_EVIDENCE_VERSION = 'donna.cloud-dependency-evidence.v1';
export const cloudCredentialGeneration = (provider, env = process.env) => {
  const key = provider === 'openai' ? env.OPENAI_API_KEY : provider === 'anthropic' ? env.ANTHROPIC_API_KEY : env.INNGEST_SIGNING_KEY;
  return key ? createHmac('sha256', key).update(`donna:credential-generation:${provider}`).digest('hex') : null;
};
const evidenceSecret = (kind, env) => kind === 'openai' ? env.OPENAI_API_KEY : kind === 'anthropic' ? env.ANTHROPIC_API_KEY : kind === 'inngest' ? env.INNGEST_SIGNING_KEY : null;
export const signDependencyFact = (kind, fact, env = process.env) => {
  const secret = evidenceSecret(kind, env);
  if (!secret) return null;
  return { fact, signature: createHmac('sha256', secret).update(canonicalHostJson(fact)).digest('hex') };
};
export const verifyDependencyFact = (kind, signed, identity, observedAt, env = process.env) => {
  try {
    const expected = signDependencyFact(kind, signed.fact, env)?.signature;
    if (!expected || typeof signed.signature !== 'string' || signed.signature.length !== expected.length
      || !timingSafeEqual(Buffer.from(expected), Buffer.from(signed.signature))) return false;
    const f = signed.fact, at = Date.parse(observedAt), minted = Date.parse(f.observed_at);
    return f.version === CLOUD_DEPENDENCY_EVIDENCE_VERSION && f.kind === kind
      && f.host_id === identity.host_id && f.generation_digest === identity.generation_digest
      && f.credential_generation === cloudCredentialGeneration(kind, env)
      && Number.isFinite(at) && Number.isFinite(minted) && minted <= at && at - minted < dependencyEvidenceMaxAgeMs(kind);
  } catch { return false; }
};
export const assertDependencyProducerLive = () => {
  const budget = currentExecutionBudget();
  if (budget && (budget.signal.aborted || remainingExecutionBudgetMs() <= 0)) {
    throw Object.assign(new Error('Dependency producer execution expired.'), { code: 'CLOUD_PRODUCER_EXECUTION_EXPIRED' });
  }
};
export const makeDependencyFact = ({ kind, detail, observedAt = new Date().toISOString(), env = process.env }) => {
  if (!['provider_failed','worker_failed'].includes(detail?.outcome)) assertDependencyProducerLive();
  const identity = resolveRuntimeHostIdentity(env);
  if (identity.runtime_host !== 'vercel' || identity.reason || !cloudCredentialGeneration(kind, env)) return null;
  return signDependencyFact(kind, { version: CLOUD_DEPENDENCY_EVIDENCE_VERSION, kind,
    host_id: identity.host_id, generation_digest: identity.generation_digest,
    credential_generation: cloudCredentialGeneration(kind, env), observed_at: observedAt, detail }, env);
};
export const persistCloudDependencyEvidence = async (signed) => {
  if (!signed) return null;
  const failure = ['provider_failed','worker_failed'].includes(signed.fact?.detail?.outcome);
  if (failure && currentExecutionBudget()?.signal.aborted) {
    // A separate bounded cleanup may retain only negative operational evidence.
    // It cannot execute a model or an accounting writer, or mint success.
    return runWithExecutionBudget(createExecutionBudget({timeoutMs:5000,label:'cloud-negative-evidence-cleanup'}),
      () => persistCloudDependencyEvidence(signed));
  }
  assertDependencyProducerLive();
  const identity = resolveRuntimeHostIdentity();
  if (!verifyDependencyFact(signed.fact.kind, signed, identity, new Date().toISOString())) throw new Error('Invalid dependency producer receipt.');
  const observedAt = signed.fact.observed_at;
  const body = { version: CLOUD_DEPENDENCY_EVIDENCE_VERSION, certificate: 'cloud_dependency_evidence',
    status: 'INCOMPLETE', runtime_host: 'vercel', host_identity: identity, observed_at: observedAt,
    freshness: buildHostCertificateFreshness({ mintedAt: observedAt }),
    checks: [{ id: 'dependency_fact', status: 'INCOMPLETE', detail: { reason: 'dependency_evidence_is_not_host_readiness' } }],
    dependency_evidence: signed };
  const { withCloudReadinessClient } = await import('./cloudRuntimeReadiness.js');
  const { persistHostReadinessAttempt } = await import('./runtimeReadiness.js');
  return withCloudReadinessClient(async (client, signal) => {
    assertDependencyProducerLive(); signal.throwIfAborted();
    return persistHostReadinessAttempt({ withFirmDbClientFn: callback => callback(client), hostId: identity.host_id,
      certificate: { ...body, receipt_digest: hostDigest(body) }, eventType: 'retry', evidenceOnly: true });
  });
};

// Host Certificate A v7 (2026-09-23, "fix deployment readiness"): the two
// dependency checks score CONFIGURATION, never historical liveness.
//
// This LOOSENS admission, deliberately. Through v6 both checks required proof
// that the required workers ran and both providers answered from THIS
// deployment. That is the wrong admission condition: it says nothing about the
// next call, every merge voided it, the worker proof waited for the 04:00 cron,
// and the provider proof needed a model call that admission itself forbade —
// the deadlock that refused every company's uploads from 2026-09-22 21:40Z to
// 2026-09-23 10:08Z until a manual button produced the evidence.
//
// v7 applies the v6 storage split (evidence_storage / detail.lifecycle_probe)
// to both checks:
// - scheduler_worker_manifest PASS = every required worker is registered in the
//   served manifest and the Inngest signing key is present. The last signed
//   run per worker is a receipt under detail.execution_proof.
// - provider_capability PASS = both required provider classes have a
//   credential and a route (a verifiable endpoint and a registered model lane).
//   The newest signed response per provider is a receipt under
//   detail.response_proof.
// A receipt is VERIFIED, UNVERIFIED or FAILED. It never scores the check, the
// certificate or the compatibility digest; collectProbeFailures reports it
// once per renewal at workspace level. The real per-call outcome carries its
// own named failure receipt on the document it touched.
export const CLOUD_REQUIRED_PROVIDER_CLASSES = Object.freeze(['openai', 'anthropic']);
const summarizeProof = entries => entries.some(entry => entry.status === 'failed') ? 'failed'
  : entries.length && entries.every(entry => entry.status === 'verified') ? 'verified' : 'unverified';
export const cloudProviderConfiguration = ({ env = process.env, modelLanes = MODEL_LANES } = {}) =>
  CLOUD_REQUIRED_PROVIDER_CLASSES.map(kind => {
    const lanes = (Array.isArray(modelLanes) ? modelLanes : []).filter(lane => lane?.endpointClass === kind
      || (Array.isArray(lane?.providers) && lane.providers.includes(kind))).map(lane => lane.id).sort();
    const endpoints = Object.entries(CLOUD_VERIFIABLE_PROVIDER_ENDPOINTS).filter(([, owner]) => owner === kind).map(([url]) => url).sort();
    return { kind, credential_present: Boolean(cloudCredentialGeneration(kind, env)), route_present: endpoints.length > 0 && lanes.length > 0,
      endpoints, lanes };
  });

// Newest provider outcome wins, including failure. Never search backward for
// an older success after the current credential/deployment stopped answering.
export const readCloudDependencyEvidence = async ({ query, identity, observedAt, env = process.env, manifestDigest, requiredWorkers, handlers = [],
  modelLanes = MODEL_LANES }) => {
  const incomplete = (id, reason, detail = {}) => ({ id, status: 'INCOMPLETE', detail: { ...detail, reason } });
  const configuration = cloudProviderConfiguration({ env, modelLanes });
  const providerDetail = { required_provider_classes: [...CLOUD_REQUIRED_PROVIDER_CLASSES], configuration, proofs: [] };
  const registered = new Set((handlers || []).map(entry => entry?.id));
  const workerConfiguration = { signing_key_present: Boolean(cloudCredentialGeneration('inngest', env)),
    unregistered_workers: (requiredWorkers || []).filter(id => !registered.has(id)) };
  const workerDetail = { required_workers: requiredWorkers, configuration: workerConfiguration, proofs: [],
    proof_scope: 'authenticated_transport_and_recovery_execution' };
  const providerReceipts = [], workerReceipts = [];
  let storeCode = null;
  if (identity.reason) return [incomplete('provider_capability','cloud_dependency_store_unavailable',providerDetail), incomplete('scheduler_worker_manifest','cloud_dependency_store_unavailable',workerDetail)];
  if (!query) storeCode = 'CLOUD_DEPENDENCY_STORE_UNAVAILABLE';
  else try {
    const providerRows = (await query(`select distinct on (certificate #>> '{dependency_evidence,fact,kind}') id,certificate->'dependency_evidence' as evidence
      from runtime_host_readiness_attempts where host_id=$1 and certificate_version=$2
        and certificate #>> '{dependency_evidence,fact,kind}' in ('openai','anthropic')
      order by certificate #>> '{dependency_evidence,fact,kind}',attempt_sequence desc`, [identity.host_id,CLOUD_DEPENDENCY_EVIDENCE_VERSION])).rows;
    for (const kind of CLOUD_REQUIRED_PROVIDER_CLASSES) {
      const row = providerRows.find(r=>r.evidence?.fact?.kind===kind);
      const fact = row?.evidence?.fact;
      const receipt = { kind, attempt_id: row ? Number(row.id) : null, observed_at: fact?.observed_at || null };
      if (!row) providerReceipts.push({ ...receipt, status: 'unverified', reason: 'no_response_evidence' });
      else if (!verifyDependencyFact(kind,row.evidence,identity,observedAt,env)) providerReceipts.push({ ...receipt, status: 'unverified',
        reason: fact?.generation_digest !== identity.generation_digest ? 'evidence_from_previous_deployment' : 'evidence_expired_or_rotated' });
      else if (fact.detail.outcome !== 'response_received') providerReceipts.push({ ...receipt, status: 'failed', reason: 'provider_failed',
        error_code: fact.detail.error_code || null, response_status: fact.detail.response_status ?? null });
      else {
        providerReceipts.push({ ...receipt, status: 'verified', reason: null });
        providerDetail.proofs.push({ kind, attempt_id: Number(row.id), evidence: row.evidence });
      }
    }
    // A busy minute worker must not crowd the daily worker's still-valid proof
    // out of the bounded read. Each required function owns its own window.
    const workerRows = (await query(`select receipt.* from unnest($3::text[]) required(function_id)
      cross join lateral (select id,attempt_sequence,certificate->'dependency_evidence' as evidence from runtime_host_readiness_attempts
        where host_id=$1 and certificate_version=$2 and certificate #>> '{dependency_evidence,fact,kind}'='inngest'
          and certificate #>> '{dependency_evidence,fact,detail,function_id}'=required.function_id
        order by attempt_sequence desc limit 1000) receipt
      order by required.function_id,receipt.attempt_sequence desc`, [identity.host_id,CLOUD_DEPENDENCY_EVIDENCE_VERSION,requiredWorkers||[]])).rows;
    for (const functionId of requiredWorkers || []) {
      const rows = workerRows.filter(r=>r.evidence?.fact?.detail?.function_id===functionId);
      const current = rows.filter(r=>verifyDependencyFact('inngest',r.evidence,identity,observedAt,env));
      const completedIndex = current.findIndex(r=>r.evidence.fact.detail.outcome==='run_completed' && r.evidence.fact.detail.manifest_digest===manifestDigest);
      const failedIndex = current.findIndex(r=>r.evidence.fact.detail.outcome==='worker_failed');
      if (failedIndex >= 0 && (completedIndex < 0 || failedIndex < completedIndex)) {
        const failed = current[failedIndex].evidence.fact;
        workerReceipts.push({ function_id: functionId, status: 'failed', reason: 'worker_failed', run_id: failed.detail.run_id || null,
          observed_at: failed.observed_at, error_code: failed.detail.error_code || null });
        continue;
      }
      const latest = completedIndex >= 0 ? current[completedIndex].evidence : null;
      const step = latest && current.find(r=>r.evidence.fact.detail.run_id===latest.fact.detail.run_id
        && r.evidence.fact.detail.outcome==='step_completed'
        && r.evidence.fact.detail.manifest_digest===manifestDigest
        && r.evidence.fact.detail.output_digest===latest.fact.detail.output_digest);
      if (!step) {
        workerReceipts.push({ function_id: functionId, status: 'unverified', observed_at: latest?.fact?.observed_at || null,
          reason: latest ? 'run_without_executed_step'
            : rows.some(r=>r.evidence?.fact?.generation_digest===identity.generation_digest) ? 'execution_evidence_expired_or_rotated'
              : rows.length ? 'execution_evidence_from_previous_deployment' : 'no_execution_evidence' });
        continue;
      }
      workerReceipts.push({ function_id: functionId, status: 'verified', reason: null, run_id: latest.fact.detail.run_id, observed_at: latest.fact.observed_at });
      workerDetail.proofs.push({ function_id: functionId, run: latest, step: step.evidence });
    }
  } catch (error) { storeCode = error.code || 'CLOUD_DEPENDENCY_READ_FAILED'; }
  if (storeCode) {
    providerReceipts.splice(0, Infinity, ...CLOUD_REQUIRED_PROVIDER_CLASSES.map(kind => ({ kind, status: 'unverified', reason: 'dependency_evidence_unreadable', error_code: storeCode })));
    workerReceipts.splice(0, Infinity, ...(requiredWorkers || []).map(function_id => ({ function_id, status: 'unverified', reason: 'dependency_evidence_unreadable', error_code: storeCode })));
    providerDetail.proofs = []; workerDetail.proofs = [];
  }
  providerDetail.response_proof = { gate: false, status: summarizeProof(providerReceipts), providers: providerReceipts };
  workerDetail.execution_proof = { gate: false, status: summarizeProof(workerReceipts), workers: workerReceipts };
  const missingCredential = configuration.filter(entry => !entry.credential_present).map(entry => entry.kind);
  const missingRoute = configuration.filter(entry => !entry.route_present).map(entry => entry.kind);
  return [missingCredential.length ? incomplete('provider_capability','cloud_provider_credential_missing',{...providerDetail,missing:missingCredential})
    : missingRoute.length ? incomplete('provider_capability','cloud_provider_route_missing',{...providerDetail,missing:missingRoute})
      : { id:'provider_capability',status:'PASS',detail:providerDetail },
  !workerConfiguration.signing_key_present ? incomplete('scheduler_worker_manifest','cloud_inngest_signing_key_missing',workerDetail)
    : !requiredWorkers?.length || workerConfiguration.unregistered_workers.length ? incomplete('scheduler_worker_manifest','cloud_required_worker_unregistered',workerDetail)
      : { id:'scheduler_worker_manifest',status:'PASS',detail:workerDetail }];
};

