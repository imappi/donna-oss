// The Donna runtime, as run inside the Electron shell's utilityProcess
// (plan §1: router · scheduler · provider adapters · all app logic — and
// none of it in main). Also runs standalone under plain node for headless
// verification: `node desktop/runtime.mjs` with the same env.
//
// Env contract (set by main before fork):
//   DATABASE_URL              from the PG supervisor
//   DONNA_ACCESS_TOKEN        per-boot token; the proxy injects it
//   DONNA_RUNTIME_SOCKET      unix socket path to serve the router on
//   DONNA_DESKTOP_BLOB_DIR    blob store root (signed URLs are origin-relative)

import process from 'node:process';

import { createDonnaRuntimeServer } from '../server/donna/desktop/runtimeServer.js';

const socketPath = process.env.DONNA_RUNTIME_SOCKET;
if (!socketPath) {
  console.error('[runtime] DONNA_RUNTIME_SOCKET is required');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('[runtime] DATABASE_URL is required');
  process.exit(1);
}

const runtime = await createDonnaRuntimeServer({
  listen: { socketPath },
  logger: console
});

// Inside Electron, utilityProcess wires `process.parentPort`; standalone
// node has no parent to signal, and signals handle shutdown instead.
if (process.parentPort) {
  process.parentPort.postMessage({ type: 'ready' });
  process.parentPort.on('message', async (event) => {
    if (event.data?.type === 'shutdown') {
      await runtime.stop();
      process.exit(0);
    }
  });
} else {
  console.log('[runtime] ready (standalone)');
}

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await runtime.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
