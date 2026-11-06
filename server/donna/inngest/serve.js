// Inngest serve handler. Mounted at /api/inngest in both:
//   - local dev (server/index.js routes the path through here),
//   - Vercel (api/inngest.js wraps this same handler).
//
// The handler is an http.RequestListener (`(req, res) => void`), which
// is what both Node's http server and Vercel's Node serverless runtime
// expect.
//
// Env:
//   INNGEST_SIGNING_KEY — required in prod so Inngest webhooks can be
//     verified. In dev (npx inngest-cli dev) signing is bypassed.
//   INNGEST_EVENT_KEY — required to SEND events to Inngest Cloud;
//     handled in inngest/client.js, not here.

import { serve } from 'inngest/node';
import { runInngestRequestWithBudget } from './executionBudget.js';

import { inngest } from './client.js';
import { parseDocumentFunctions } from './parseDocument.js';
import { bankLineDispositionFunctions } from './bankLineDisposition.js';
import { documentTerminalDrainFunctions } from './documentTerminalDrain.js';
import { ledgerMirrorVerifyFunctions } from './ledgerMirrorVerify.js';
import { ledgerAutoExportFunctions } from './ledgerAutoExport.js';
import { convergenceClocksFunctions } from './convergenceClocks.js';
import { outboundActionsDueFunctions } from './outboundActionsDue.js';
import { outboundOwnerDigestFunctions } from './outboundOwnerDigest.js';
import { outboundMetricsRollupFunctions } from './outboundMetricsRollup.js';
import { marketingProspectsDueFunctions } from './marketingProspectsDue.js';
import { marketingReplyTriageFunctions } from './marketingReplyTriage.js';
import { llmDecisionRetentionFunctions } from './llmDecisionRetention.js';

const SIGNING_KEY = process.env.INNGEST_SIGNING_KEY || '';

let cachedHandler = null;

// The full set of Inngest functions this deployment serves. Exported so a test
// can pin that every function module is registered: the (since deleted, RT-14)
// bank-line auto-explain cron once shipped with its function set defined but
// never spread into serve(), so its hourly sweep never ran in prod. Add new
// function sets HERE and they are covered by serve.test.js's identity check.
export const registeredInngestFunctions = [
  ...parseDocumentFunctions,
  ...bankLineDispositionFunctions,
  ...documentTerminalDrainFunctions,
  ...ledgerMirrorVerifyFunctions,
  ...ledgerAutoExportFunctions,
  ...convergenceClocksFunctions,
  ...outboundActionsDueFunctions,
  ...outboundOwnerDigestFunctions,
  ...outboundMetricsRollupFunctions,
  ...marketingProspectsDueFunctions,
  ...marketingReplyTriageFunctions,
  ...llmDecisionRetentionFunctions
];

const buildHandler = () =>
  serve({
    client: inngest,
    functions: registeredInngestFunctions,
    ...(SIGNING_KEY ? { signingKey: SIGNING_KEY } : {})
  });

export const handleInngestServeRequest = (req, res) => {
  if (!cachedHandler) cachedHandler = buildHandler();
  return runInngestRequestWithBudget(req, res, () => cachedHandler(req, res));
};
