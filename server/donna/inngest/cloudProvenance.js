// The SDK authenticates the request before executing these hooks. Discovery
// and cached steps never become fresh worker execution evidence.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Middleware } from 'inngest';
import { hostDigest, canonicalHostJson } from '../hostCertificateA.js';
import { assertDependencyProducerLive, makeDependencyFact, persistCloudDependencyEvidence } from '../cloudDependencyEvidence.js';

const requests = new AsyncLocalStorage();
export const cloudWorkerManifest = manifest => (manifest || []).map(entry => ({
  id: entry.opts?.id || (typeof entry.id === 'string' ? entry.id : null),
  triggers: entry.opts?.triggers || [], retries: entry.opts?.retries ?? null,
  concurrency: entry.opts?.concurrency ?? null
})).sort((a, b) => String(a.id).localeCompare(String(b.id)));
// These existing workers prove read/convergence and recovery transport, even
// before an accounting entity can be admitted. They do not prove bookkeeping.
export const CLOUD_REQUIRED_WORKERS = Object.freeze(['convergence-metrics-daily', 'document-terminal-drain']);
const failedOutput = output => Boolean(output && typeof output === 'object'
  && ((Array.isArray(output.errors) && output.errors.length) || output.transport_failures > 0
    || output.ok === false || output.status === 'failed'));
const record = async ({ ctx, fn, output, stepInfo, error, event }) => {
  const request = requests.getStore();
  if (!request || !ctx?.runId || ctx.runId !== request.run_id || stepInfo?.memoized) return;
  if (!error && !failedOutput(output)) assertDependencyProducerLive();
  const { registeredInngestFunctions } = await import('./serve.js');
  const manifest = cloudWorkerManifest(registeredInngestFunctions);
  const functionId = fn.opts?.id;
  if (!manifest.some(entry => entry.id === functionId)) return;
  const signed = makeDependencyFact({ kind: 'inngest', detail: {
    outcome: error || failedOutput(output) ? 'worker_failed' : event,
    function_id: functionId, run_id: ctx.runId, step_id: stepInfo?.hashedId || null,
    step_name: stepInfo?.options?.id || null, attempt: ctx.attempt ?? null,
    request_digest: request.request_digest, manifest_digest: hostDigest(manifest),
    output_digest: output === undefined ? null : hostDigest(output),
    error_code: error ? 'CLOUD_WORKER_EXECUTION_FAILED' : failedOutput(output) ? 'CLOUD_WORKER_REPORTED_ERRORS' : null
  } });
  await persistCloudDependencyEvidence(signed);
};
export class CloudInngestProvenanceMiddleware extends Middleware.BaseMiddleware {
  id = 'donna-cloud-provenance';
  async wrapRequest({ next, requestInfo, requestArgs, runId }) {
    const env = process.env;
    if (this.client.mode !== 'cloud' || env.NODE_ENV !== 'production' || ['1', 'true'].includes(env.INNGEST_DEV)
      || !env.INNGEST_SIGNING_KEY || requestInfo.method !== 'POST'
      || !requestArgs?.[0]?.headers?.['x-inngest-signature'] || !runId) return next();
    const body = await requestInfo.body();
    // SDK verification still owns authentication. This additional comparison
    // binds the fact to the current key, excluding a configured fallback key.
    const incoming = new URLSearchParams(requestArgs[0].headers['x-inngest-signature']);
    const signature = incoming.get('s') || '';
    const expected = createHmac('sha256',env.INNGEST_SIGNING_KEY.replace(/^signkey-[\w]+-/,''))
      .update(canonicalHostJson(body)).update(incoming.get('t') || '').digest('hex');
    if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature),Buffer.from(expected))) return next();
    const request_digest = hostDigest(body);
    return requests.run({ request_digest, run_id: runId }, next);
  }
  async wrapStepHandler(args) {
    try {
      const output = await args.next();
      await record({ ...args, output, event: 'step_completed' });
      return output;
    } catch (error) {
      // An expired budget cannot mint any late receipt, including success.
      try { await record({ ...args, error, event: 'worker_failed' }); } catch { /* original failure wins */ }
      throw error;
    }
  }
  async onRunComplete(args) { await record({ ...args, event: 'run_completed' }); }
  async onRunError(args) { try { await record({ ...args, event: 'worker_failed' }); } catch { /* SDK retains failure */ } }
}
