// Vercel API route mounting the Inngest serve handler at /api/inngest.
//
// The handler reads `req.url` for sync/introspection; the Vercel
// rewrite in vercel.json must preserve that path so signature verification
// and the Inngest dashboard sync work.

import { handleInngestServeRequest } from '../server/donna/inngest/serve.js';
import { trackHostedInvocation } from '../server/donna/db/pool.js';

export const config = {
  // Bank-statement OCR can take 60-120s on long PDFs; keep the same
  // timeout headroom as the donna-router function.
  maxDuration: 300
};

export default function handler(req, res) {
  // Hosted session hygiene (pool.js): a worker instance frozen between
  // invocations must hold no pooler session (the 2026-09-21 EMAXCONNSESSION).
  trackHostedInvocation(res);
  // The rewrite in vercel.json passes the original path through, so
  // req.url already looks like '/api/inngest…' inside this function.
  return handleInngestServeRequest(req, res);
}
