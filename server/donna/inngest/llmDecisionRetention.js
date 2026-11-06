// Decision-receipt retention — the daily sweep cron.
//
// Policy: decisions-2026-07-28.md decision 4 (Kari, 2026-07-28).
// Mechanism + the finding that reframes it: docs/donna-kernel-audit/telemetry-retention-design.md.
//
// TWO TIERS, one clock each (docs/donna-data-lifecycle-policy.md, Kari
// 2026-07-28). Tier 2 (`llm_reasoning`) is the POPULATED column and its first
// run does real work — expect a large one-off `reasoning_redacted` count that
// falls toward zero and stays there. Tier 3 (`llm_raw_response`) is NULL on
// every row because no caller writes it, so it stays a PROSPECTIVE control and
// should report zero indefinitely; a non-zero `raw_redacted` means something
// started capturing raw envelopes, which is itself worth knowing.
//
// Daily resolution is deliberate for a 90-DAY clock; hourly would only burn
// queries. The cron knob is tuning only (env-legitimate); the retention WINDOW
// is policy and lives as a constant in llmDecisionRetention.js, never in env.
//
// Firm suspension deliberately does NOT gate this sweep, unlike the outbound
// crons. Not SENDING on a suspended firm's behalf is a choice; not DELETING is
// a legal position, and a suspension must not quietly extend retention.

import { inngest } from './client.js';
import { listFirmIdsInDb, withFirmDbClient } from '../firmDb.js';
import {
  sweepLlmProseRetention,
  LLM_RAW_RESPONSE_RETENTION_DAYS,
  LLM_REASONING_RETENTION_DAYS
} from '../llmDecisionRetention.js';

const LLM_DECISION_RETENTION_CRON = process.env.LLM_DECISION_RETENTION_CRON || '40 3 * * *';

export const runLlmDecisionRetentionSweep = async ({ logger, now = Date.now() } = {}) => {
  const log = logger || console;
  const summary = {
    reasoning_retention_days: LLM_REASONING_RETENTION_DAYS,
    raw_retention_days: LLM_RAW_RESPONSE_RETENTION_DAYS,
    firms_evaluated: 0,
    redacted: 0,
    reasoning_redacted: 0,
    raw_redacted: 0,
    undated: 0,
    more_remaining: false,
    errors: []
  };

  let firmIds = [];
  try {
    firmIds = await listFirmIdsInDb();
  } catch (err) {
    log.error?.('llm-decision-retention: firm enumeration failed', { error: err?.message });
    summary.errors.push({ stage: 'enumeration', message: err?.message || String(err) });
    return summary;
  }

  for (const firmId of firmIds) {
    // Per-firm try/catch: one firm's failure must not stop the others' clocks.
    try {
      const result = await withFirmDbClient((client) =>
        sweepLlmProseRetention({ client, firmId, now, logger: log }));
      summary.firms_evaluated += 1;
      summary.redacted += result.redacted;
      summary.reasoning_redacted += result.reasoning_redacted;
      summary.raw_redacted += result.raw_redacted;
      summary.undated += result.undated;
      if (result.more_remaining) summary.more_remaining = true;
      if (result.undated > 0) {
        log.warn?.('llm-decision-retention: raw responses with no created_at cannot be aged', {
          firm_id: firmId, undated: result.undated
        });
      }
    } catch (err) {
      log.warn?.('llm-decision-retention: per-firm sweep failed', {
        firm_id: firmId, error: err?.message
      });
      summary.errors.push({ firm_id: firmId, message: err?.message || String(err) });
    }
  }

  return summary;
};

export const llmDecisionRetentionFunction = inngest.createFunction(
  {
    id: 'llm-decision-retention',
    name: 'Decision receipts — daily raw-response retention sweep',
    concurrency: { limit: 1 },
    retries: 0,
    triggers: [{ cron: LLM_DECISION_RETENTION_CRON }]
  },
  async ({ step, logger }) => {
    return step.run('sweep', () => runLlmDecisionRetentionSweep({ logger }));
  }
);

export const llmDecisionRetentionFunctions = [llmDecisionRetentionFunction];
