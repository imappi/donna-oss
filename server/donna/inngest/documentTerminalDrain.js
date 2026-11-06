// Doc-first terminal drain — hourly Inngest cron (the "future cron" the
// standalone `runDocumentTerminalDrain` entry point was written for,
// loopsShadowProducers.js).
//
// WHY A CRON AT ALL: the drain's only other trigger is
// `onReconciliationRunCompleted`, which fires for the documents a matcher
// run just touched. A doc whose matcher chance came while the drain's flag
// was off — or whose disposition job died mid-burst — is never re-touched,
// and rests as `parsed_no_match` with no verdict: the owner's list renders
// it "Processing" forever with no job coming (Desert Rose, 2026-09-01 —
// four unmatched January documents pinned exactly this). The hourly sweep
// is the backstop that walks every enrolled client's no-line backlog to a
// terminal. The producer is incremental (policy-version guard skips docs
// already evaluated), so the recurring sweep does not re-spend strong-model
// calls on decided docs.
//
// GATING — nothing new invented here:
//   - per-client: DOCUMENT_NO_LINE_DISPOSITION (config plane, envFallback
//     false — born on the plane). The cron only ENUMERATES clients holding
//     a live observing-stage row; the drain re-reads the snapshot itself
//     and no-ops on flag_off, so a stage change between enumeration and
//     execution is safe. No row anywhere ⇒ the sweep enumerates nothing —
//     registering this cron is INERT until a deliberate stage write (on the
//     appliance, the DESKTOP_CLIENT_FLAG_SEEDS row).
//   - loop system: runDocumentTerminalDrain is runShadow-wrapped
//     (isLoopSystemEnabled + loops tables), same as every producer.
//   - per-firm: metadata.loops.suspended pauses a firm, mirroring the
//     bank-line disposition cron.
//   - readiness: each client sweep runs under the entity-readiness worker
//     admission, like every other worker lane.
//
// Hosted pilot: Vercel admission also requires the existing live manual
// INTERNAL_PILOT_ACCESS client grant, for both cron and scoped readiness events.
// This narrows scheduling only; it cannot grant readiness or alter book authority.
// Non-Vercel discovery retains the existing disposition-enrollment behavior.
//
// Cron default `15 * * * *` UTC — offset from the bank-line disposition
// sweep's minute 0 so the two strong-model sweeps don't stack on the same
// tick. Idempotent; a missed hour delays a disposition by 60 minutes.

import { inngest } from './client.js';
import { queryFirmDb, withFirmDbClient } from '../firmDb.js';
import { runDocumentTerminalDrain } from '../loopsShadowProducers.js';
import { resolveFirmSuspension } from '../loopExecutionGate.js';
import { DOCUMENT_NO_LINE_DISPOSITION_FLAG_KEY, DOCUMENT_NO_LINE_DISPOSITION_TARGET_TYPE } from '../documentDispositionShape.js';
import { EntityReadinessAdmissionError, ENTITY_READINESS_ADMISSION_ERROR, runWithEntityReadinessWorkerAdmission } from '../runtimeReadinessAdmission.js';
import { readInternalPilotAccessWithClient } from '../internalPilotAccess.js';
import { resolveRuntimeHostIdentity } from '../runtimeHostIdentity.js';

const DOCUMENT_TERMINAL_DRAIN_CRON = process.env.DOCUMENT_TERMINAL_DRAIN_CRON || '15 * * * *';

// Clients enrolled in the drain: a live config row at an observing stage
// (stageObserves: shadow / canary / auto). The firm's metadata rides along
// so the suspension override needs no second query.
const findEnrolledDrainClients = async () => {
  const result = await queryFirmDb(
    `select c.firm_id, c.client_id, f.metadata as firm_metadata
       from client_capability_config c
       join firms f on f.id = c.firm_id
      where c.flag_key = $1
        and c.valid_to is null
        and c.stage in ('shadow', 'canary', 'auto')
      order by c.firm_id, c.client_id`,
    [DOCUMENT_NO_LINE_DISPOSITION_FLAG_KEY]
  );
  return (result.rows || []).filter((row) => row.firm_id && row.client_id);
};

// RT-14 (RT-10 §4 item 5): a machine re-run job carries its target. The
// job's payload names the (firm, client) and the document the TECHNICAL
// needs_human lane scheduled; the runner drains THAT document for THAT
// client only (still under the client's own flag row and readiness
// admission) instead of every enrolled client. A cron tick's payload
// ({ tick }) has no target and sweeps everything, as before.
export const scopedRerunTarget = (payload) => {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.target_type !== DOCUMENT_NO_LINE_DISPOSITION_TARGET_TYPE) return null;
  const firmId = String(payload.firm_id || '').trim();
  const clientId = String(payload.client_id || '').trim();
  if (!firmId || !clientId) return null;
  return { firmId, clientId, targetId: payload.target_id ?? null, attempt: payload.attempt ?? null };
};

const findEnrolledDrainClient = async ({ firmId, clientId }) => {
  const result = await queryFirmDb(
    `select c.firm_id, c.client_id, f.metadata as firm_metadata
       from client_capability_config c
       join firms f on f.id = c.firm_id
      where c.flag_key = $1
        and c.firm_id = $2 and c.client_id = $3
        and c.valid_to is null
        and c.stage in ('shadow', 'canary', 'auto')`,
    [DOCUMENT_NO_LINE_DISPOSITION_FLAG_KEY, firmId, clientId]
  );
  return (result.rows || []).filter((row) => row.firm_id && row.client_id);
};

// A sweep whose database work failed is a FAILED run, never a summary that
// reads as success. On 2026-10-14 the hosted drain could not reach its
// database for nine hours ("ENOTFOUND" / "tenant or user not found"); each
// tick logged the enumeration error and returned normally, so every run
// counted as completed. The failure cannot be receipted in the database it
// could not reach, so the run itself fails: Inngest records it as Failed (the
// cloud provenance middleware stamps CLOUD_WORKER_EXECUTION_FAILED), the
// appliance's job queue fails the job, and the next tick is the retry (the
// sweep is incremental; `retries: 0` like every cron here). The summary rides
// on the error for the log. Policy outcomes (a scoped target without pilot
// access, a readiness deferral) are not failures and still return normally.
export const DOCUMENT_DRAIN_SWEEP_FAILED = 'DOCUMENT_DRAIN_SWEEP_FAILED';
export class DocumentDrainSweepError extends Error {
  constructor(summary, failures) {
    const first = failures[0] || {};
    super(`Document terminal drain failed (${failures.length} ${failures.length === 1 ? 'failure' : 'failures'}; `
      + `${first.stage || 'client'}${first.client_id ? ` ${first.client_id}` : ''}: ${first.message || 'unknown error'})`);
    this.name = 'DocumentDrainSweepError';
    this.code = DOCUMENT_DRAIN_SWEEP_FAILED;
    this.summary = summary;
  }
}

// A completed admission check can defer accounting while proving the worker
// transport ran. Only the pre-work discovery refusal has that meaning.
export const documentDrainReadinessDeferral = ({ error, workStarted, firmId, clientId }) => {
  const decision = error?.details;
  if (workStarted || !(error instanceof EntityReadinessAdmissionError)
    || error.code !== ENTITY_READINESS_ADMISSION_ERROR || decision?.enforced !== true
    || decision.allowed !== false || decision.boundary !== 'worker_discovery') return null;
  return { firm_id: firmId, client_id: clientId, code: error.code,
    boundary: decision.boundary, reason_code: decision.reason_code,
    responsible_system: decision.responsible_system, retryable: decision.retryable,
    saga_id: decision.saga_id, entity_receipt_ref: decision.entity_receipt_ref,
    root_cause_receipt_ref: decision.root_cause_receipt_ref, host_receipt_ref: decision.host_receipt_ref };
};

export const runDocumentTerminalDrainSweep = async ({ logger, payload = null, enrollmentScope = null } = {}) => {
  const log = logger || console;
  const scoped = scopedRerunTarget(payload);
  const hostedPilotOnly = resolveRuntimeHostIdentity().runtime_host === 'vercel';
  const summary = {
    clients_enrolled: 0,
    firms_suspended: 0,
    clients_evaluated: 0,
    clients_disabled: 0,
    clients_deferred: 0,
    readiness_deferrals: [],
    documents_evaluated: 0,
    auto_explained: 0,
    chase_evidence: 0,
    needs_human: 0,
    skipped_existing: 0,
    transport_failures: 0,
    resolved_gaps: 0,
    errors: []
  };

  let enrolled = [];
  try {
    if (hostedPilotOnly && (enrollmentScope || scoped)) {
      const scope = enrollmentScope || scoped;
      const allowed = await withFirmDbClient(client => readInternalPilotAccessWithClient(client, scope));
      if (!allowed) {
        summary.errors.push({ stage: 'scoped', code: 'INTERNAL_PILOT_ACCESS_REQUIRED', message: 'Hosted document drain requires current explicit pilot access.' });
        return summary;
      }
    }
    if (enrollmentScope) {
      enrolled = await findEnrolledDrainClient(enrollmentScope);
    } else if (scoped) {
      summary.scoped = { firm_id: scoped.firmId, client_id: scoped.clientId, target_id: scoped.targetId, attempt: scoped.attempt };
      enrolled = await findEnrolledDrainClient(scoped);
      if (!enrolled.length) summary.errors.push({ stage: 'scoped', firm_id: scoped.firmId, client_id: scoped.clientId, message: 'client not enrolled in the document terminal drain' });
    } else {
      enrolled = await findEnrolledDrainClients();
    }
  } catch (err) {
    log.error?.('document-terminal-drain: enumeration failed', { error: err?.message });
    const failure = { stage: 'enumeration', ...(err?.code ? { code: err.code } : {}), message: err?.message || String(err) };
    summary.errors.push(failure);
    throw new DocumentDrainSweepError(summary, [failure]);
  }
  const failures = [];
  if (!hostedPilotOnly) summary.clients_enrolled = enrolled.length;

  for (const { firm_id: firmId, client_id: clientId, firm_metadata: firmMetadata } of enrolled) {
    if (resolveFirmSuspension({ firmMetadata })) {
      summary.firms_suspended += 1;
      continue;
    }
    let workStarted = false;
    try {
      await withFirmDbClient(async (client) => {
        // A disposition stage is not pilot enrollment. Check the existing
        // manual-client authority reader before readiness or producer work,
        // including scoped retries; a read failure never enters the worker.
        if (hostedPilotOnly) {
          if (!await readInternalPilotAccessWithClient(client, { firmId, clientId })) {
            if (enrollmentScope || scoped) summary.errors.push({ stage: 'scoped', code: 'INTERNAL_PILOT_ACCESS_REQUIRED', message: 'Hosted document drain requires current explicit pilot access.' });
            return;
          }
          summary.clients_enrolled += 1;
        }
        return runWithEntityReadinessWorkerAdmission({
          client,
          firmId,
          clientId,
          work: async () => {
            workStarted = true;
            // documentIds null = the client's full no-line backlog; the
            // producer's incremental guard keeps the re-sweep cheap. The
            // drain result also carries Slice 3 (chase → ask-batch redraft
            // request) and Slice 4b (settlement entries, own flag, inert
            // while unstaged) — all inside runDocumentTerminalDrain.
            const documentIds = scoped?.targetId ? [String(scoped.targetId)] : null;
            const result = await runDocumentTerminalDrain({ client, firmId, clientId, documentIds });
            if (!result || result.disabled) {
              summary.clients_disabled += 1;
              return;
            }
            summary.clients_evaluated += 1;
            const stats = result.stats || {};
            summary.documents_evaluated += stats.evaluated || 0;
            summary.auto_explained += stats.auto_explained || 0;
            summary.chase_evidence += stats.chase_evidence || 0;
            summary.needs_human += stats.needs_human || 0;
            summary.skipped_existing += stats.skipped_existing || 0;
            summary.transport_failures += stats.transport_failures || 0;
            summary.resolved_gaps += result.resolvedGaps || 0;
            if (stats.aborted_reason) {
              summary.errors.push({ firm_id: firmId, client_id: clientId, message: `sweep aborted: ${stats.aborted_reason}` });
            }
          }
        });
      });
    } catch (err) {
      const deferred = documentDrainReadinessDeferral({ error: err, workStarted, firmId, clientId });
      if (deferred) {
        summary.clients_deferred += 1;
        summary.readiness_deferrals.push(deferred);
        log.info?.('document-terminal-drain: client deferred by readiness', deferred);
        continue;
      }
      log.warn?.('document-terminal-drain: per-client sweep failed', {
        firm_id: firmId,
        client_id: clientId,
        error: err?.message
      });
      const failure = { firm_id: firmId, client_id: clientId, ...(err?.code ? { code: err.code } : {}), message: err?.message || String(err) };
      summary.errors.push(failure);
      failures.push(failure);
    }
  }

  if (failures.length) throw new DocumentDrainSweepError(summary, failures);
  return summary;
};

export const documentTerminalDrainFunction = inngest.createFunction(
  {
    id: 'document-terminal-drain',
    name: 'Document no-line terminal drain — hourly sweep',
    concurrency: { limit: 1 },
    retries: 0,
    triggers: [{ cron: DOCUMENT_TERMINAL_DRAIN_CRON }, { event: 'donna/host.readiness.requested' }]
  },
  async ({ step, logger, event }) => {
    const enrollmentScope = event.name === 'donna/host.readiness.requested' ? { firmId: event.data?.firm_id, clientId: event.data?.client_id } : null;
    if (enrollmentScope && (!enrollmentScope.firmId || !enrollmentScope.clientId)) throw new Error('Scoped readiness event requires a firm and client.');
    return step.run('sweep', () => runDocumentTerminalDrainSweep({ logger, enrollmentScope }));
  }
);

export const documentTerminalDrainFunctions = [documentTerminalDrainFunction];
