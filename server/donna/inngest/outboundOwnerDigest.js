// Outbound owner digest — the daily owner-surface sweep (M1, G9; execution
// plan A4/D2 digest-first). ONE daily email per client gathering everything
// the outbound pipeline has resting on the OWNER: approvals (one-tap links),
// must-review rows (failed sends, stale leases, exhausted cadences), and
// needs-info gaps. All gathering/rendering/dedup lives in
// outbound/ownerDigest.js; this cron is only the clock (the outboundActionsDue
// posture: suspension-aware, per-client try/catch, inert for clients whose
// OUTBOUND_* flags don't act).
//
// Default 13:40 UTC ≈ US-East morning (the US-first M1 audience). Cron knob
// is tuning only (env-legitimate); the behaviour gates live on the config
// plane.

import { inngest } from './client.js';
import { queryFirmDb, withFirmDbClient } from '../firmDb.js';
import { sendOwnerDigestForClient } from '../outbound/ownerDigest.js';
import { resolveFirmSuspension } from '../loopExecutionGate.js';
import { sendEmail } from '../email/resendClient.js';
import { runWithEntityReadinessWorkerAdmission } from '../runtimeReadinessAdmission.js';

const OUTBOUND_OWNER_DIGEST_CRON = process.env.OUTBOUND_OWNER_DIGEST_CRON || '40 13 * * *';

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

// Owner mail goes out as plain Donna (the default identity — this is Donna
// talking to her OWNER, not a counterparty send). replyTo passes through:
// the digest sets it to the reply-ingestion inbound address for clients
// whose lane is on (reply_if_wrong v2); absent, resendClient's monitored
// default applies as always.
const ownerEmailDeliverer = async ({ to, subject, text, html, replyTo }) => {
  const result = await sendEmail({ to, subject, text, html, ...(replyTo ? { replyTo } : {}) });
  if (!result.ok) {
    throw new Error(result.error || result.reason || 'digest email send failed');
  }
  return { providerMessageId: result.id || null };
};

export const runOutboundOwnerDigestSweep = async ({ logger, deliverEmail } = {}) => {
  const log = logger || console;
  const summary = {
    firms_evaluated: 0,
    firms_suspended: 0,
    clients_evaluated: 0,
    digests_sent: 0,
    skipped_dark: 0,
    skipped_empty: 0,
    skipped_unchanged: 0,
    skipped_no_owner_email: 0,
    errors: []
  };
  let firms = [];
  try {
    firms = await findFirms();
  } catch (err) {
    log.error?.('outbound-owner-digest: firm enumeration failed', { error: err?.message });
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
      log.warn?.('outbound-owner-digest: client enumeration failed', { firm_id: firmId, error: err?.message });
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
          const result = await sendOwnerDigestForClient({
            client, firmId, clientId,
            deliverEmail: deliverEmail || ownerEmailDeliverer,
            logger: log
          });
          summary.clients_evaluated += 1;
          if (result?.sent) summary.digests_sent += 1;
          else if (result?.reason === 'pipeline_dark') summary.skipped_dark += 1;
          else if (result?.reason === 'nothing_pending') summary.skipped_empty += 1;
          else if (result?.reason === 'unchanged') summary.skipped_unchanged += 1;
          else if (result?.reason === 'no_owner_email') summary.skipped_no_owner_email += 1;
          }
        }));
      } catch (err) {
        log.warn?.('outbound-owner-digest: per-client digest failed', {
          firm_id: firmId, client_id: clientId, error: err?.message
        });
        summary.errors.push({ firm_id: firmId, client_id: clientId, message: err?.message || String(err) });
      }
    }
  }
  return summary;
};

export const outboundOwnerDigestFunction = inngest.createFunction(
  {
    id: 'outbound-owner-digest',
    name: 'Outbound actions — daily owner digest',
    concurrency: { limit: 1 },
    retries: 0,
    triggers: [{ cron: OUTBOUND_OWNER_DIGEST_CRON }]
  },
  async ({ step, logger }) => {
    return step.run('digest', () => runOutboundOwnerDigestSweep({ logger }));
  }
);

export const outboundOwnerDigestFunctions = [outboundOwnerDigestFunction];
