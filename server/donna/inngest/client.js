// Inngest client for the Donna firm services.
//
// PR 2 of the async-document-parsing rollout (see
// docs/async-parsing-plan.md). The client is the single sender of the
// `document/parse.requested` event and is also imported by the serve
// route (so the registered worker shares its identity with the producer).
//
// Env: INNGEST_EVENT_KEY is required to send events to Inngest Cloud. In
// local dev the Inngest dev server (npx inngest-cli dev) accepts events
// without a key, so the constructor is happy with an empty string.

import { currentExecutionBudget } from '../executionBudget.js';
import { providerFetchWithDeadline } from '../providerTransport.js';
import { Inngest } from 'inngest';
import { CloudInngestProvenanceMiddleware } from './cloudProvenance.js';
import { InngestExecutionBudgetMiddleware } from './executionBudget.js';

const APP_ID = process.env.INNGEST_APP_ID || 'donna-firm';
const EVENT_KEY = process.env.INNGEST_EVENT_KEY || '';
const IS_DEV =
  process.env.NODE_ENV !== 'production' ||
  process.env.INNGEST_DEV === '1' ||
  process.env.INNGEST_DEV === 'true';

export const inngest = new Inngest({
  id: APP_ID,
  fetch: (url, init) => currentExecutionBudget()
    ? providerFetchWithDeadline({provider:'inngest',timeoutMs:10000,reserveMs:1000})(url,init)
    : globalThis.fetch(url,init),
  middleware: [CloudInngestProvenanceMiddleware, InngestExecutionBudgetMiddleware],
  ...(EVENT_KEY ? { eventKey: EVENT_KEY } : {}),
  ...(IS_DEV ? { isDev: true } : {})
});

// True when the local fan-out is at least minimally configured. Cron
// callers use this to skip outbox sweeps in environments where Inngest
// isn't wired (avoids hot-looping rows we can't actually enqueue).
//
// The desktop runtime has NO Inngest — no dev server, no cloud bus; the
// local scheduler's drain is the transport (desktop plan §4). The host
// gate keys on DONNA_DESKTOP_BLOB_DIR (the same signal evidenceStorage
// uses for local mode, set by both desktop entry points) and beats both
// the IS_DEV assumption (NODE_ENV is never 'production' in the shell, so
// every launch read as "dev server present" and the outbox failed a send
// per minute — observed on the 2026-08-03 Mac session) and any developer
// .env carrying cloud keys, which must never point a local book at the
// cloud event bus. Read per-call: the shell finalizes env before the
// router loads, but a call-time read costs nothing and can't go stale.
export const isInngestConfigured = () =>
  !process.env.DONNA_DESKTOP_BLOB_DIR && (Boolean(EVENT_KEY) || IS_DEV);
