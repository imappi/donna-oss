// Bank-line disposition — hourly Inngest cron (Phase 7.2 turn-on).
//
// The strong-model successor to the retiring bank-line auto-explain cron
// (`bankLineAutoExplain.js`). Sweeps each firm opted in via
// `metadata.bank_line_disposition.enabled = true`, and for each client runs
// `runBankLineDispositionForClient` — one strong call per bare money_out line
// with no document match → a persisted `reconciliation_evaluations` verdict
// (`auto_explained` / `no_match`). The producer is incremental (it skips lines
// already evaluated at the current policy version), so a recurring sweep does
// not re-spend a strong-model call on settled lines.
//
// DOUBLE-GATED, OFF by default:
//   - global:   BANK_LINE_DISPOSITION_MODE=llm — checked inside the producer
//     AND here, so the cron does not even enumerate firms while the feature is
//     fully off,
//   - per-firm: metadata.bank_line_disposition.enabled = true.
// With the env unset the sweep enumerates nothing and the producer no-ops, so
// registering this cron is INERT in prod until a deliberate, calibrated
// turn-on (mirrors the auto-explain cron's posture).
//
// Cron default hourly (`0 * * * *` UTC). The sweep is idempotent, so a missed
// hour just delays a disposition by 60 minutes; quiet hours don't matter.

import { inngest } from './client.js';
import { queryFirmDb, withFirmDbClient } from '../firmDb.js';
import {
  runBankLineDispositionForClient,
  isBankLineDispositionEnabled
} from '../bankLineDispositionLlm.js';
import { resolveFirmSuspension } from '../loopExecutionGate.js';
import { readClientConfigSnapshot } from '../clientConfig.js';
import { retractAsksSettledByAutoExplain } from '../reconciliationTwinAging.js';
import { readLaneDecidingPolicy } from '../modelLanePolicy.js';
import {
  BANK_LINE_DISPOSITION_CHALLENGER_LANE,
  bankLineDispositionChallengerConfigured,
  makeBankLineDispositionChallengerHook
} from '../bankLineDispositionChallenger.js';
import { runWithEntityReadinessWorkerAdmission } from '../runtimeReadinessAdmission.js';
import { BANK_LINE_DISPOSITION_TARGET_TYPE } from '../bankLineDispositionShape.js';

const BANK_LINE_DISPOSITION_CRON = process.env.BANK_LINE_DISPOSITION_CRON || '0 * * * *';

const findActiveDispositionFirms = async () => {
  // Select metadata too so the Step-6 firm-suspension override (below) can pause a
  // suspended firm without a second query.
  const result = await queryFirmDb(
    `select id, metadata
       from firms
      where (metadata->'bank_line_disposition'->>'enabled') = 'true'`,
    []
  );
  return (result.rows || [])
    .map((row) => ({ id: row.id, metadata: row.metadata }))
    .filter((f) => Boolean(f.id));
};

const findClientsForFirm = async (firmId) => {
  const result = await queryFirmDb(
    `select id from clients where firm_id = $1`,
    [firmId]
  );
  return (result.rows || []).map((row) => row.id).filter(Boolean);
};

// RT-14 (RT-10 §4 item 5): a machine re-run job carries its target. The
// job's payload names the (firm, client) — and the transaction — the
// TECHNICAL needs_human lane scheduled; the runner sweeps THAT client only
// instead of every enrolled client. The producer's incremental guard picks
// the due line; a cron tick's payload ({ tick }) has no target and sweeps
// everything, as before. Exported for the sweep test.
export const scopedRerunTarget = (payload) => {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.target_type !== BANK_LINE_DISPOSITION_TARGET_TYPE) return null;
  const firmId = String(payload.firm_id || '').trim();
  const clientId = String(payload.client_id || '').trim();
  if (!firmId || !clientId) return null;
  return { firmId, clientId, targetId: payload.target_id ?? null, attempt: payload.attempt ?? null };
};

const findFirmById = async (firmId) => {
  const result = await queryFirmDb(
    `select id, metadata
       from firms
      where id = $1
        and (metadata->'bank_line_disposition'->>'enabled') = 'true'`,
    [firmId]
  );
  const row = result.rows?.[0];
  return row?.id ? { id: row.id, metadata: row.metadata } : null;
};

export const runBankLineDisposition = async ({ logger, payload = null } = {}) => {
  const log = logger || console;
  const scoped = scopedRerunTarget(payload);
  const summary = {
    skipped_globally: false,
    firms_evaluated: 0,
    firms_suspended: 0,
    clients_evaluated: 0,
    transactions_evaluated: 0,
    auto_explained: 0,
    statutory_payment: 0,
    needs_human: 0,
    chase_receipt: 0,
    skipped_existing: 0,
    transport_failures: 0,
    asks_retracted: 0,
    errors: []
  };

  // Global gate first — don't even enumerate firms while the feature is off.
  if (!isBankLineDispositionEnabled()) {
    summary.skipped_globally = true;
    return summary;
  }

  let firms = [];
  try {
    if (scoped) {
      summary.scoped = { firm_id: scoped.firmId, client_id: scoped.clientId, target_id: scoped.targetId, attempt: scoped.attempt };
      const firm = await findFirmById(scoped.firmId);
      firms = firm ? [firm] : [];
      if (!firm) summary.errors.push({ stage: 'scoped', firm_id: scoped.firmId, message: 'firm not enrolled for bank-line disposition' });
    } else {
      firms = await findActiveDispositionFirms();
    }
  } catch (err) {
    log.error?.('bank-line-disposition: firm enumeration failed', { error: err?.message });
    summary.errors.push({ stage: 'enumeration', message: err?.message || String(err) });
    return summary;
  }

  for (const firmRec of firms) {
    const firmId = firmRec.id;
    // Step 6 (additive, no regression): a firm-level loop SUSPENSION pauses the
    // sweep for that firm. No-op until an authority sets metadata.loops.suspended;
    // never couples to the loop tier (which would dark the cron in prod).
    if (resolveFirmSuspension({ firmMetadata: firmRec.metadata })) {
      summary.firms_suspended += 1;
      continue;
    }
    summary.firms_evaluated += 1;

    let clientIds = [];
    try {
      clientIds = scoped ? [scoped.clientId] : await findClientsForFirm(firmId);
    } catch (err) {
      log.warn?.('bank-line-disposition: client enumeration failed', { firm_id: firmId, error: err?.message });
      summary.errors.push({ firm_id: firmId, message: err?.message || String(err) });
      continue;
    }

    for (const clientId of clientIds) {
      try {
        await withFirmDbClient(async (client) => runWithEntityReadinessWorkerAdmission({
          client,
          firmId,
          clientId,
          work: async () => {
          // Q6c (the model lab): the lane's active model-policy row — which
          // QUALIFIED model decides this client's lines. Read best-effort:
          // an unreadable policy sweeps on the strong default (absence
          // semantics), never aborts the sweep.
          let decidingPolicy = null;
          try {
            decidingPolicy = await readLaneDecidingPolicy({
              client, firmId, clientId, laneId: BANK_LINE_DISPOSITION_CHALLENGER_LANE
            });
          } catch (err) {
            log.warn?.('bank-line-disposition: policy read failed; sweeping on the strong default', {
              firm_id: firmId, client_id: clientId, error: err?.message
            });
          }
          // Descent-ladder Q6a: build the shadow-challenger hook for this
          // (firm, client) — forward mode needs the endpoint/model/cap env;
          // reverse mode (an active experiment policy, Q6c) needs the
          // anthropic key and the cap. Hook construction must never affect
          // the sweep: any failure degrades to hook = null.
          let challengerHook = null;
          if (bankLineDispositionChallengerConfigured() || decidingPolicy) {
            try {
              const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
              challengerHook = makeBankLineDispositionChallengerHook({
                firmId,
                clientId,
                snapshot,
                withClient: withFirmDbClient,
                decidingPolicy
              });
            } catch (err) {
              log.warn?.('bank-line-disposition: challenger hook construction failed; sweeping without it', {
                firm_id: firmId,
                client_id: clientId,
                error: err?.message
              });
            }
          }
          const stats = await runBankLineDispositionForClient({ client, firmId, clientId, challengerHook, decidingPolicy });
          // RT-11 / D4: the auto_explains this sweep just stamped retract the
          // open purpose/document asks on the same lines — plane-gated
          // (RECONCILE_AUTO_EXPLAIN_RETRACTS), receipted, idempotent
          // (reconciliationTwinAging.js). Best-effort: a failure is logged and
          // never undoes a verdict.
          try {
            const retraction = await retractAsksSettledByAutoExplain(client, {
              firmId,
              clientId,
              configSnapshot: await readClientConfigSnapshot(client, { firmId, clientId })
            });
            summary.asks_retracted += retraction.retracted_request_ids?.length || 0;
          } catch (err) {
            log.warn?.('bank-line-disposition: auto-explain ask retraction failed', {
              firm_id: firmId, client_id: clientId, error: err?.message
            });
          }
          summary.clients_evaluated += 1;
          summary.transactions_evaluated += stats.evaluated || 0;
          summary.auto_explained += stats.auto_explained || 0;
          summary.statutory_payment += stats.statutory_payment || 0;
          summary.needs_human += stats.needs_human || 0;
          summary.chase_receipt += stats.chase_receipt || 0;
          summary.skipped_existing += stats.skipped_existing || 0;
          summary.transport_failures += stats.transport_failures || 0;
          // A typed abort is an endpoint/config problem the operator must
          // see in the summary, not only in per-line logs.
          if (stats.aborted_reason) {
            summary.errors.push({ firm_id: firmId, client_id: clientId, message: `sweep aborted: ${stats.aborted_reason}` });
          }
          }
        }));
      } catch (err) {
        log.warn?.('bank-line-disposition: per-client sweep failed', {
          firm_id: firmId,
          client_id: clientId,
          error: err?.message
        });
        summary.errors.push({ firm_id: firmId, client_id: clientId, message: err?.message || String(err) });
      }
    }
  }

  return summary;
};

export const bankLineDispositionFunction = inngest.createFunction(
  {
    id: 'bank-line-disposition',
    name: 'Bank-line disposition — hourly sweep',
    concurrency: { limit: 1 },
    retries: 0,
    triggers: [{ cron: BANK_LINE_DISPOSITION_CRON }]
  },
  async ({ step, logger }) => {
    return step.run('sweep', () => runBankLineDisposition({ logger }));
  }
);

export const bankLineDispositionFunctions = [bankLineDispositionFunction];
