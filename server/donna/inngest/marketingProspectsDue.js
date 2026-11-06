// Marketing prospects — the hourly prospect clock (M2 of the marketing
// track's closed-commercial-loop arc). The sweep itself lives in
// marketing/prospectClock.js (pure + injectable, tested without Inngest);
// this file is only the cron registration, mirroring outboundActionsDue.
//
// Firm-agnostic by construction (047's line): ONE pass over
// marketing_prospect, no firm/client enumeration. Registering this cron is
// near-inert until prospects exist: an empty table costs one bounded query
// and does nothing. Deterministic arithmetic only — no LLM, no sends to
// leads; its single outward effect is a founder nudge email, cooldown-
// limited and receipted as a `prospect_clock` source run.
//
// Cron knob is tuning only (MARKETING_PROSPECTS_DUE_CRON — env-legitimate);
// MARKETING_CLOCK_FORCE_DISABLE is the kill switch (env may KILL, never
// enable). Staggered off the :20 outbound sweep.

import { inngest } from './client.js';
import { runMarketingProspectsDueSweep } from '../marketing/prospectClock.js';

const MARKETING_PROSPECTS_DUE_CRON = process.env.MARKETING_PROSPECTS_DUE_CRON || '40 * * * *';

export const marketingProspectsDueFunction = inngest.createFunction(
  {
    id: 'marketing-prospects-due',
    name: 'Marketing prospects — hourly due sweep (the prospect clock)',
    concurrency: { limit: 1 },
    retries: 0,
    triggers: [{ cron: MARKETING_PROSPECTS_DUE_CRON }]
  },
  async ({ step, logger }) => {
    return step.run('sweep', () => runMarketingProspectsDueSweep({ logger }));
  }
);

export const marketingProspectsDueFunctions = [marketingProspectsDueFunction];
