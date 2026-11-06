// Marketing reply triage — the hourly M4 sweep (closed-commercial-loop arc,
// rescoped 2026-07-24: reply triage + drafted responses; no booking
// machinery). The sweep lives in marketing/replyTriageSweep.js (injectable,
// tested without Inngest); this file is only the cron registration, mirroring
// marketingProspectsDue.
//
// Firm-agnostic (047's line): one pass over marketing_inbound_message, no
// firm/client enumeration. Near-inert until inbound is configured: an empty
// untriaged queue costs one bounded query and leaves no receipt. The sweep
// spends strong-model tokens on triage + drafts, but every draft rests
// 'proposed' under per-send approval — the cron can never send anything.
//
// Cron knob is tuning only (MARKETING_REPLY_TRIAGE_CRON — env-legitimate);
// MARKETING_TRIAGE_FORCE_DISABLE is the kill switch (env may KILL, never
// enable). Staggered at :50, off outbound's :20 and the prospect clock's :40.

import { inngest } from './client.js';
import { runReplyTriageSweep } from '../marketing/replyTriageSweep.js';

const MARKETING_REPLY_TRIAGE_CRON = process.env.MARKETING_REPLY_TRIAGE_CRON || '50 * * * *';

export const marketingReplyTriageFunction = inngest.createFunction(
  {
    id: 'marketing-reply-triage',
    name: 'Marketing inbound — hourly reply-triage sweep (M4)',
    concurrency: { limit: 1 },
    retries: 0,
    triggers: [{ cron: MARKETING_REPLY_TRIAGE_CRON }]
  },
  async ({ step, logger }) => {
    return step.run('sweep', () => runReplyTriageSweep({ logger }));
  }
);

export const marketingReplyTriageFunctions = [marketingReplyTriageFunction];
