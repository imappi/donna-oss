import { HOSTED_PILOT_VERSIONS } from './internalPilotAccess.js';
// The existing outbox cron is the renewal clock. No timer, scheduler, flag or
// alternate worker graph is introduced. Recovery is not mutation admission.
import { currentExecutionBudget, remainingExecutionBudgetMs } from './executionBudget.js';
import { loadPgPool } from './db/pool.js';
import { resolveRuntimeHostIdentity, CLOUD_RUNTIME_HOST, cloudCertificateIdentityMatches } from './runtimeHostIdentity.js';
import { observeCloudHostCertificateA } from './cloudHostCertificateA.js';
import { evaluateHostCertificateFreshness } from './hostCertificateA.js';
import { readCurrentHostCertificateWithClient, persistHostReadinessAttempt,
  hostReadinessIsMutationReady, healTargetedEntityReadiness } from './runtimeReadiness.js';

export const CLOUD_READINESS_DB_STATEMENT_TIMEOUT_MS = 5000;
export const CLOUD_READINESS_DEADLINE_MS = 15000;
// Renewal includes seven sequential storage exchanges before database/schema
// observation and receipt persistence. Other scoped operations retain 15s.
export const CLOUD_READINESS_RENEWAL_DEADLINE_MS = 30000;

// Use the existing pool and named writers. Server-side timeouts cancel SQL;
// the enclosing deadline closes and awaits this owned connection if transport
// stalls. No Promise.race abandons a still-running observer or later write.
export const withCloudReadinessClient = async (work, { timeoutMs = CLOUD_READINESS_DEADLINE_MS } = {}) => {
  const pool = await loadPgPool();
  const connectMs = Number(pool?.options?.connectionTimeoutMillis);
  if (!pool || !(connectMs > 0 && connectMs <= 30000)) {
    throw Object.assign(new Error('Cloud observation requires a bounded database connection acquisition.'),
      { code: 'CLOUD_DATABASE_CONNECT_BOUND_REQUIRED' });
  }
  const client = await pool.connect();
  const abort = new AbortController();
  let closePromise = null, prior = null;
  const parentBudget = currentExecutionBudget();
  const closeExpired = () => {
    abort.abort(Object.assign(new Error('Cloud observation deadline exceeded.'), { code: 'CLOUD_OBSERVATION_DEADLINE' }));
    closePromise = client.end().catch(() => {});
  };
  const timer = setTimeout(closeExpired, Math.max(1, Math.min(timeoutMs, remainingExecutionBudgetMs() ?? Infinity)));
  parentBudget?.signal.addEventListener('abort', closeExpired, { once: true });
  if (parentBudget?.signal.aborted) closeExpired();
  try {
    prior = (await client.query("select current_setting('statement_timeout') as statement, current_setting('lock_timeout') as lock")).rows[0];
    await client.query("select set_config('statement_timeout', $1, false), set_config('lock_timeout', $1, false)", [String(CLOUD_READINESS_DB_STATEMENT_TIMEOUT_MS)]);
    const result = await work(client, abort.signal);
    abort.signal.throwIfAborted();
    return result;
  } catch (error) {
    if (abort.signal.aborted) throw abort.signal.reason;
    throw error;
  } finally {
    try {
      if (prior && !abort.signal.aborted) await client.query("select set_config('statement_timeout', $1, false), set_config('lock_timeout', $2, false)", [prior.statement, prior.lock]);
    } catch { closePromise ||= client.end().catch(() => {}); }
    clearTimeout(timer);
    parentBudget?.signal.removeEventListener('abort', closeExpired);
    if (closePromise) await closePromise;
    client.release(closePromise ? new Error('Cloud observation connection closed.') : undefined);
  }
};

// Probe failures are receipts: a non-PASS check's error/code, plus a failed
// storage lifecycle exchange carried inside a PASS check (v6), plus a worker
// execution or provider response proof that is not VERIFIED (v7). Code-only.
export const collectProbeFailures = (certificate) => (certificate?.checks || []).flatMap(check => {
  const failures = [];
  if (check.detail?.error || check.detail?.code) failures.push({ check: check.id, code: check.detail.error?.code || check.detail.code });
  const probe = check.detail?.lifecycle_probe;
  if (probe?.status === 'FAIL') {
    failures.push({ check: check.id, probe: 'lifecycle', code: probe.error?.code || probe.reason,
      operation: probe.operation ?? null, http_status: probe.http_status ?? null, cleanup_required: probe.cleanup_required === true });
  }
  for (const [kind, proof, entries, key] of [
    ['execution', check.detail?.execution_proof, check.detail?.execution_proof?.workers, 'function_id'],
    ['response', check.detail?.response_proof, check.detail?.response_proof?.providers, 'kind']
  ]) {
    if (!proof || proof.status === 'verified') continue;
    const open = (entries || []).filter(entry => entry.status !== 'verified');
    failures.push({ check: check.id, probe: kind, status: String(proof.status).toUpperCase(),
      code: open.find(entry => entry.error_code)?.error_code || open[0]?.reason || null,
      subjects: open.map(entry => ({ [key]: entry[key], status: entry.status, reason: entry.reason || null, error_code: entry.error_code || null })) });
  }
  return failures;
});

// v7 producer, never a gate: when this deployment has no verified worker
// execution, the renewal requests the existing `donna/host.readiness.requested`
// event (the same event the operator's "Run dependency checks" sends) for one
// explicitly prepared pilot. The event id is the deployment generation, so the
// Inngest event API deduplicates it: at most one request per deployment per
// dedup window, no retry loop, no new clock. The renewal never calls a model;
// provider response proofs come from real admitted work (and the operator
// probe). A failed send is a receipt on the renewal result, nothing more.
const sendHostReadinessWorkerEvent = async (event) => {
  const { inngest, isInngestConfigured } = await import('./inngest/client.js');
  if (!isInngestConfigured()) return { status: 'skipped', reason: 'inngest_not_configured' };
  const sent = await inngest.send(event);
  return { status: 'requested', event_ids: sent?.ids || [] };
};

export const renewCloudHostReadinessIfDue = async ({
  observedAt = new Date().toISOString(), rootDir = process.cwd(), logger = console,
  sendWorkerEvent = sendHostReadinessWorkerEvent
} = {}) => {
  const identity = resolveRuntimeHostIdentity();
  if (identity.runtime_host !== CLOUD_RUNTIME_HOST) return null;
  if (!identity.host_id) return { status: 'INCOMPLETE', reason: identity.reason };
  let result, workerEventScope = null;
  try {
    result = await withCloudReadinessClient(async (client, signal) => {
      const selected = await client.query(`select firm_id, client_id from client_capability_config
        where flag_key = 'INTERNAL_PILOT_ACCESS' and stage = 'canary' and source = 'manual'
          and reason = any($1::text[]) and client_id is not null and valid_to is null
        order by firm_id, client_id limit 1`, [HOSTED_PILOT_VERSIONS]);
      if (!selected.rows.length) return { status: 'not_selected', reason: 'no_explicit_cloud_pilot' };
      const current = await readCurrentHostCertificateWithClient(client, identity.host_id);
      const freshness = evaluateHostCertificateFreshness({ certificate: current, asOf: observedAt });
      if (cloudCertificateIdentityMatches(current, identity) && freshness.status === 'fresh' && !freshness.renewal_due) {
        return { status: current.status, reason: 'renewal_not_due', receipt_digest: current.receipt_digest };
      }
      const { registeredInngestFunctions } = await import('./inngest/serve.js');
      const certificate = await observeCloudHostCertificateA({ observedAt, rootDir, manifest: registeredInngestFunctions,
        query: client.query.bind(client), signal });
      signal.throwIfAborted();
      const withObserverClient = callback => callback(client);
      const persisted = await persistHostReadinessAttempt({ withFirmDbClientFn: withObserverClient,
        hostId: identity.host_id, certificate, eventType: current ? 'renewal' : 'boot' });
      if (hostReadinessIsMutationReady({ certificate: persisted.certificate, asOf: observedAt, hostIdentity: identity })) {
        await healTargetedEntityReadiness({ withFirmDbClientFn: withObserverClient, observedAt, rootDir, logger,
          renewedCloudHostCompatibilityDigest: persisted.certificate.compatibility_digest });
      }
      const probeFailures = collectProbeFailures(certificate);
      // Monitoring, once per renewal at workspace level: a failed synthetic
      // storage exchange, or a worker execution / provider response proof
      // that is not verified on this deployment, is a shared service
      // observation with a code — never a per-transaction failure and never
      // a gate.
      for (const failure of probeFailures.filter(entry => entry.probe === 'lifecycle')) {
        logger.warn?.('[cloud-readiness] storage lifecycle probe failed', { ...failure, attempt_id: persisted.attempt_id, host_status: persisted.status });
      }
      for (const failure of probeFailures.filter(entry => entry.probe === 'execution' || entry.probe === 'response')) {
        logger.warn?.(`[cloud-readiness] ${failure.probe === 'execution' ? 'worker execution' : 'provider response'} ${failure.status.toLowerCase()} on this deployment`,
          { ...failure, attempt_id: persisted.attempt_id, host_status: persisted.status });
      }
      const scheduler = certificate.checks.find(check => check.id === 'scheduler_worker_manifest');
      if (scheduler?.status === 'PASS' && scheduler.detail?.execution_proof?.status !== 'verified') workerEventScope = selected.rows[0];
      return { status: persisted.status, reason: persisted.reason_code,
        receipt_digest: persisted.certificate.receipt_digest, attempt_id: persisted.attempt_id,
        probe_failures: probeFailures };
    }, { timeoutMs: CLOUD_READINESS_RENEWAL_DEADLINE_MS });
  } catch (error) {
    const code = error?.code || 'CLOUD_READINESS_OBSERVATION_FAILED';
    logger.error?.('[cloud-readiness] observation incomplete', { code });
    return { status: 'INCOMPLETE', reason: code };
  }
  // Outside the observer's database client: the request is a producer for
  // the monitoring receipt, sent only after the renewal receipt committed.
  if (workerEventScope) {
    try {
      result.worker_event = await sendWorkerEvent({ id: `donna-host-readiness:${identity.generation_digest}`,
        name: 'donna/host.readiness.requested', data: { firm_id: workerEventScope.firm_id, client_id: workerEventScope.client_id } });
    } catch (error) {
      result.worker_event = { status: 'failed', code: error?.code || 'CLOUD_WORKER_EVENT_SEND_FAILED' };
      logger.warn?.('[cloud-readiness] worker execution request failed', result.worker_event);
    }
  }
  return result;
};
