#!/usr/bin/env node

// CI runtime activation for Host Certificate A. Starting the real local
// scheduler initializes its durable cron manifest through the same code as the
// desktop app; the long poll interval prevents handler execution in this
// setup step. The certificate itself remains a read-only observer.

import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { buildDesktopHandlerManifest } from '../server/donna/desktop/handlerManifest.js';
import { createLocalScheduler } from '../server/donna/desktop/localScheduler.js';
import { closeFirmDbPool, queryFirmDb } from '../server/donna/firmDb.js';

export const initializeCiHostScheduler = async ({ env = process.env, logger = console } = {}) => {
  if (!env.CI) throw new Error('CI=true is required; this setup command is CI-only.');
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required; CI PostgreSQL was not provisioned.');
  const parsed = new URL(env.DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`Refusing to initialize a scheduler on non-local PostgreSQL (${parsed.hostname}).`);
  }
  // The whole manifest (the CI host has no book to read an adapter from, so
  // the ledger sweeps are declared — the superset); retire whatever a
  // previous run's manifest declared that this one does not.
  const manifest = buildDesktopHandlerManifest();
  const scheduler = createLocalScheduler({
    manifest,
    client: { query: (text, params) => queryFirmDb(text, params) },
    logger,
    pollIntervalMs: 60 * 60 * 1000,
    retireUndeclaredFunctions: true
  });
  await scheduler.start();
  await scheduler.stop();
  return { handler_count: manifest.length };
};

const main = async () => {
  try {
    const result = await initializeCiHostScheduler();
    console.log(`Initialized ${result.handler_count} durable scheduler handlers.`);
  } finally {
    await closeFirmDbPool();
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}
