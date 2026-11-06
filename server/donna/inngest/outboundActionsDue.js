// Outbound actions — the due-actions sweep (M0.5, G6; execution plan §1).
// ONE cron for every outbound action type: claims due outbound_actions rows
// and runs THE executor (actionExecutor.js — all A3 interlocks live there,
// not here). The cadence mechanic is askReaskCadence's nudge/escalate shape
// generalized into PACK-SUPPLIED data (packs.dunningCadenceForPack): the
// executor advances the next step / escalates to the owner after a send; this
// cron is only the clock.
//
// Hourly resolution (the bankLineAutoExplain posture): dunning steps are
// DAYS apart, but an owner-approved action should leave within the hour, not
// the day. A client with no OUTBOUND_* stage rows costs one config read and
// does nothing — registering this cron is INERT until a stage row exists
// (careful-canary discipline; all four flags are born 'off' and their 'auto'
// terminal sits in AUTO_FORBIDDEN_FLAGS).
//
// Paid-truth guard (G4, landed with M1): the composed guard
// (outbound/paidTruthGuard.js) re-checks BOTH settlement mechanisms fresh at
// send time — only an explicit 'unpaid' lets a reminder through; ambiguity
// (including the suggested-but-unconfirmed match case) holds for the owner;
// settled cancels with a receipt. Tests can still inject their own check.
//
// Overdue detection (G5, landed with M1): before executing due work, the
// sweep runs the receivable detector per client — it opens chase cases and
// mints step-1 reminders through the gate (act stage only; shadow audits
// would-open receipts; off is dark).
//
// Scale note (plan risk #4): per-client sequential sweep is fine at current
// scale; at ~1,000 clients batch the due-scan into one query across clients
// before touching per-client execution.
//
// Cron knob is tuning only (OUTBOUND_ACTIONS_DUE_CRON — env-legitimate); the
// BEHAVIOUR gates live on the config plane.

import { inngest } from './client.js';
import { queryFirmDb, withFirmDbClient } from '../firmDb.js';
import { executeDueOutboundActions } from '../outbound/actionExecutor.js';
import { paidTruthCheck as composedPaidTruthCheck } from '../outbound/paidTruthGuard.js';
import { detectOverdueReceivables } from '../outbound/receivableCases.js';
import { detectUpcomingPayables } from '../outbound/payableNotices.js';
import { ensureOutboundPayLinks } from '../outbound/payLinks.js';
import {
  captureStructuredReferences, captureDocumentStructuredReferences
} from '../outbound/referenceCapture.js';
import { processOwnerReplies } from '../outbound/replyIngestion.js';
import { sweepEarnedAutoGraduations } from '../outbound/earnedAutoLadder.js';
import { resolveFirmSuspension } from '../loopExecutionGate.js';
import { sendEmail } from '../email/resendClient.js';
import { runWithEntityReadinessWorkerAdmission } from '../runtimeReadinessAdmission.js';

const OUTBOUND_ACTIONS_DUE_CRON = process.env.OUTBOUND_ACTIONS_DUE_CRON || '20 * * * *';

const findFirms = async () => {
  const result = await queryFirmDb('select id, metadata from firms', []);
  return (result.rows || [])
    .map((row) => ({ id: row.id, metadata: row.metadata }))
    .filter((f) => Boolean(f.id));
};

const findClientsForFirm = async (firmId) => {
  const result = await queryFirmDb('select id from clients where firm_id = $1', [firmId]);
  return (result.rows || []).map((row) => row.id).filter(Boolean);
};

// The email deliverer: Resend through the one module boundary. Fails the
// action (never throws through the executor's finalize path) when Resend is
// unconfigured. D7 identity (customer name in the From display over the
// shared verified domain, owner reply-to) and the one-click unsubscribe
// headers are resolved by the executor and passed through here.
export const emailDeliverer = async ({
  recipient, subject, body, text = body, html, identity, headers, attachments,
  send = sendEmail
}) => {
  const result = await send({
    to: recipient, subject, text,
    ...(html ? { html } : {}),
    ...(identity?.from ? { from: identity.from } : {}),
    ...(identity?.replyTo ? { replyTo: identity.replyTo } : {}),
    ...(headers && Object.keys(headers).length ? { headers } : {}),
    ...(Array.isArray(attachments) && attachments.length ? { attachments } : {})
  });
  if (!result.ok) {
    throw new Error(result.error || result.reason || 'email send failed');
  }
  return { providerMessageId: result.id || null };
};

// The bounded sweep: per firm (suspension-aware) per client, run the executor
// in its own connection. Per-client try/catch — one poisoned book never
// stalls the rest (the convergenceClocks posture).
export const runOutboundActionsDueSweep = async ({ logger, deliverers, paidTruthCheck = composedPaidTruthCheck } = {}) => {
  const log = logger || console;
  const summary = {
    firms_evaluated: 0,
    firms_suspended: 0,
    clients_evaluated: 0,
    considered: 0,
    sent: 0,
    held: 0,
    cancelled: 0,
    failed: 0,
    shadow_would_send: 0,
    stale_executing: 0,
    cadence_minted: 0,
    cadence_escalations: 0,
    cases_opened: 0,
    detector_minted: 0,
    needs_owner_input: 0,
    shadow_would_open: 0,
    pay_links_created: 0,
    references_captured: 0,
    document_references_captured: 0,
    owner_replies_scanned: 0,
    owner_replies_marked_wrong: 0,
    owner_replies_needs_owner: 0,
    owner_reply_shadow_would_mark: 0,
    payable_notices_minted: 0,
    payable_shadow_would_notice: 0,
    ladders_graduated: 0,
    ladders_earned_pending: 0,
    errors: []
  };
  let firms = [];
  try {
    firms = await findFirms();
  } catch (err) {
    log.error?.('outbound-actions-due: firm enumeration failed', { error: err?.message });
    summary.errors.push({ stage: 'enumeration', message: err?.message || String(err) });
    return summary;
  }
  for (const firmRec of firms) {
    const firmId = firmRec.id;
    if (resolveFirmSuspension({ firmMetadata: firmRec.metadata })) {
      summary.firms_suspended += 1;
      continue;
    }
    summary.firms_evaluated += 1;
    let clientIds = [];
    try {
      clientIds = await findClientsForFirm(firmId);
    } catch (err) {
      log.warn?.('outbound-actions-due: client enumeration failed', { firm_id: firmId, error: err?.message });
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
          // G12 capture FIRST: a viite captured this sweep is visible to the
          // detector's and executor's paid-truth reads below. Flag-dark and
          // scheme-gated — a scheme-less pack (US) costs one pack read.
          const capturedRefs = await captureStructuredReferences({
            client, firmId, clientId, logger: log
          });
          if (!capturedRefs?.skipped) {
            summary.references_captured += capturedRefs?.captured || 0;
          }
          // The invoice-side sibling: a viite captured from a parsed FI
          // sales invoice is visible to the detector's mint-time coalesce
          // below, so the case stops resting as missing_reference_number.
          const capturedDocRefs = await captureDocumentStructuredReferences({
            client, firmId, clientId, logger: log
          });
          if (!capturedDocRefs?.skipped) {
            summary.document_references_captured += capturedDocRefs?.captured || 0;
          }
          // reply_if_wrong v2: classify stored owner replies BEFORE any
          // send work — a correction recorded here (streak reset, auto
          // demotion) binds the gate reads for everything below. Flag-dark;
          // shadow receipts would-mark counts with zero marking.
          const replies = await processOwnerReplies({
            client, firmId, clientId, logger: log
          });
          if (!replies?.skipped) {
            summary.owner_replies_scanned += replies?.scanned || 0;
            summary.owner_replies_marked_wrong += replies?.marked_wrong || 0;
            summary.owner_replies_needs_owner += replies?.needs_owner || 0;
            summary.owner_reply_shadow_would_mark += replies?.shadow_would_mark || 0;
          }
          // G5 detector: newly-overdue invoices become cases + step-1
          // mints this same sweep can then execute below (once due).
          const detected = await detectOverdueReceivables({
            client, firmId, clientId, paidTruthCheck, logger: log
          });
          if (!detected?.skipped) {
            summary.cases_opened += detected?.cases_opened || 0;
            summary.detector_minted += detected?.actions_minted || 0;
            summary.needs_owner_input += detected?.needs_owner_input || 0;
            summary.shadow_would_open += detected?.shadow_would_open || 0;
          }
          // M4 payables: upcoming supplier bills become owner-directed
          // notices this same sweep can execute below (scheduled now).
          const payables = await detectUpcomingPayables({
            client, firmId, clientId, logger: log
          });
          if (!payables?.skipped) {
            summary.payable_notices_minted += payables?.notices_minted || 0;
            summary.payable_shadow_would_notice += payables?.shadow_would_notice || 0;
          }
          // D4 (M2): ensure pay-links AFTER detection (new cases get a link
          // this same sweep) and BEFORE execution (the renderer swaps the
          // link into the payment block at send time). Stripe calls happen
          // inside the module, outside any DB transaction.
          const links = await ensureOutboundPayLinks({
            client, firmId, clientId, logger: log
          });
          if (!links?.skipped) summary.pay_links_created += links?.created || 0;
          const stats = await executeDueOutboundActions({
            client, firmId, clientId,
            deliverers: deliverers || { email: emailDeliverer },
            paidTruthCheck,
            logger: log
          });
          // D1 earned-auto: graduate any 'earned' ladder whose terminal Kari
          // has since approved (the veto lift lands as a PR editing
          // AUTO_FORBIDDEN_FLAGS; this hook turns it into graduation without
          // waiting for another owner-approved send).
          const ladders = await sweepEarnedAutoGraduations(client, { firmId, clientId });
          if (!ladders?.skipped) {
            summary.ladders_graduated += ladders?.graduated || 0;
            summary.ladders_earned_pending += ladders?.earned_pending || 0;
          }
          if (stats?.skipped) return;
          summary.clients_evaluated += 1;
          for (const key of ['considered', 'sent', 'held', 'cancelled', 'failed',
            'shadow_would_send', 'stale_executing', 'cadence_minted', 'cadence_escalations']) {
            summary[key] += stats?.[key] || 0;
          }
          }
        }));
      } catch (err) {
        log.warn?.('outbound-actions-due: per-client sweep failed', {
          firm_id: firmId, client_id: clientId, error: err?.message
        });
        summary.errors.push({ firm_id: firmId, client_id: clientId, message: err?.message || String(err) });
      }
    }
  }
  return summary;
};

export const outboundActionsDueFunction = inngest.createFunction(
  {
    id: 'outbound-actions-due',
    name: 'Outbound actions — hourly due sweep',
    concurrency: { limit: 1 },
    retries: 0,
    triggers: [{ cron: OUTBOUND_ACTIONS_DUE_CRON }]
  },
  async ({ step, logger }) => {
    return step.run('sweep', () => runOutboundActionsDueSweep({ logger }));
  }
);

export const outboundActionsDueFunctions = [outboundActionsDueFunction];
