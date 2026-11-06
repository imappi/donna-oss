#!/usr/bin/env node
// Xero live-writeback smoke harness — CLI orchestrator.
//
// Turns "validate the live Xero writeback end-to-end" into ONE command run
// against a CONNECTED Xero org (sandbox recommended). The write path makes real
// HTTP calls to Xero; this script is dry-run-safe BY DEFAULT and only writes
// when you pass --execute. See docs/xero-live-writeback-runbook.md for the full
// setup (Xero app, env vars, OAuth connect).
//
// Usage:
//   node scripts/xero_writeback_smoke.js --client <clientId> --transaction <txId> [--firm <id>]
//        [--connection <id>] [--sync] [--execute] [--force] [--verify-only]
//
//   --sync         first sync Xero reference data (accounts + contacts) for the client
//   --execute      ACTUALLY write the bank transaction to Xero, then mirror-verify
//                  (omit for a safe dry-run pre-flight only)
//   --force        bypass the already-synced / idempotency guard on --execute
//   --verify-only  skip the dry-run + write; just mirror-verify a transaction that
//                  was already written (fetch it back from Xero and report drift)
//
// Prereqs (the script fails loud if missing): a configured Xero app
// (XERO_CLIENT_ID/SECRET/REDIRECT_URI), a firm DB connection, and a connected
// xero_connections row for the client (GET /xero/connect → /xero/callback).

import {
  syncXeroReferenceDataInDb,
  writebackXeroTransactionInDb,
  verifyXeroMirrorInDb
} from '../server/donna/firmDb.js';
import { classifyXeroWritebackDryRun, formatXeroWritebackReadiness } from '../server/donna/xeroWritebackSmoke.js';

const parseArgs = (argv) => {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true; // boolean flag
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
};

const line = (...parts) => console.log(parts.join(' '));
const bounded = (value, max = 1200) => {
  const s = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

const fail = (message, hint) => {
  console.error(`\n✗ ${message}`);
  if (hint) console.error(`  fix: ${hint}`);
  process.exit(1);
};

// Mirror-verify one transaction: fetch it back from Xero and compare to what we
// sent. verifyXeroMirrorInDb period-scopes by transaction_date, so pass a WIDE
// window — the explicit --transaction id is the real scope and the row can be
// any historical date (bank statements routinely are), so the current-month
// default would scan 0 and report "not found in period". The result rows live
// under the `xero_mirror_verification` envelope.
const mirrorVerify = async ({ scope, transactionId, label }) => {
  line(`\n${label} mirror-verify (fetch from Xero, compare to what we sent)…`);
  try {
    const verify = await verifyXeroMirrorInDb({
      ...scope,
      transactionIds: [transactionId],
      periodStart: '2000-01-01',
      periodEnd: new Date().toISOString().slice(0, 10)
    });
    const payload = verify?.xero_mirror_verification || verify;
    const rows = payload?.results || (Array.isArray(payload) ? payload : [payload]);
    let allOk = rows.length > 0;
    for (const row of Array.isArray(rows) ? rows : [rows]) {
      const status = row?.status || row?.mirror_status || 'unknown';
      const ok = /ok/i.test(String(status));
      if (!ok) allOk = false;
      line(`    ${ok ? '✓' : '✗'} ${row?.transaction_id || transactionId}: ${status}`);
      if (!ok && row) line(`      ${bounded(row?.checks || row, 600)}`);
    }
    line(`\n${allOk ? '✓' : '✗'} mirror-verify ${allOk ? 'complete — Xero matches what we sent' : 'reported drift / not-found'}.`);
  } catch (error) {
    const v = classifyXeroWritebackDryRun({ error });
    fail(`mirror-verify failed (the write may have succeeded): ${v.blocker.message}`, v.blocker.hint);
  }
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const clientId = args.client;
  const transactionId = args.transaction;
  const firmId = args.firm; // undefined → firmDb defaults to DEFAULT_FIRM_ID
  const connectionId = args.connection;
  const execute = Boolean(args.execute);
  const force = Boolean(args.force);
  const verifyOnly = Boolean(args['verify-only']);

  if (!clientId || !transactionId) {
    fail('Both --client <clientId> and --transaction <transactionId> are required.',
      'node scripts/xero_writeback_smoke.js --client <id> --transaction <id> [--sync] [--execute]');
  }

  const scope = { firmId, clientId, connectionId };
  const mode = verifyOnly ? '  (VERIFY-ONLY: no write)' : execute ? '  (EXECUTE: will write to Xero)' : '  (dry-run only)';
  line(`\nXero writeback smoke — client ${clientId}, transaction ${transactionId}${mode}`);

  // Verify-only: the write already happened on a prior run — just re-fetch from
  // Xero and report drift. Skips the dry-run + write entirely.
  if (verifyOnly) {
    await mirrorVerify({ scope, transactionId, label: '[verify-only]' });
    return;
  }

  // 1) Optional reference-data sync.
  if (args.sync) {
    line('\n[1] syncing Xero reference data (accounts + contacts)…');
    try {
      const synced = await syncXeroReferenceDataInDb(scope);
      const accounts = synced?.accounts?.length ?? synced?.account_count ?? synced?.counts?.accounts ?? '?';
      const contacts = synced?.contacts?.length ?? synced?.contact_count ?? synced?.counts?.contacts ?? '?';
      line(`    synced: ${accounts} accounts, ${contacts} contacts`);
    } catch (error) {
      const v = classifyXeroWritebackDryRun({ error });
      fail(`reference sync failed: ${v.blocker.message}`, v.blocker.hint);
    }
  }

  // 2) Dry-run pre-flight (never writes). This surfaces every blocker —
  //    connection, bank account, the missing-account dead-end — before any
  //    live call.
  line(`\n[${args.sync ? 2 : 1}] dry-run pre-flight…`);
  let verdict;
  try {
    const result = await writebackXeroTransactionInDb({ ...scope, transactionId, dryRun: true });
    verdict = classifyXeroWritebackDryRun({ result });
  } catch (error) {
    verdict = classifyXeroWritebackDryRun({ error });
  }
  line(formatXeroWritebackReadiness(verdict, { transactionId }).split('\n').map((l) => `    ${l}`).join('\n'));

  if (!verdict.ready) {
    fail('pre-flight says NOT READY — not writing to Xero.', verdict.blocker?.hint || undefined);
  }
  if (!execute) {
    line('\n✓ Dry-run pre-flight passed. Re-run with --execute to write this transaction to Xero.');
    return;
  }

  // 3) Live write.
  line('\n[3] EXECUTING live writeback to Xero…');
  let writeResult;
  try {
    writeResult = await writebackXeroTransactionInDb({ ...scope, transactionId, dryRun: false, force });
  } catch (error) {
    const v = classifyXeroWritebackDryRun({ error });
    fail(`live writeback failed: ${v.blocker.message}`, v.blocker.hint);
  }
  const xeroId = writeResult?.transaction?.xero_bank_transaction_id
    || writeResult?.xero_bank_transaction_id
    || writeResult?.xero_writeback?.xero_bank_transaction_id
    || null;
  line(`    xero_bank_transaction_id: ${xeroId || '(not found in result — inspect below)'}`);
  if (!xeroId) line(`    result: ${bounded(writeResult)}`);

  // 4) Mirror-verify: fetch back from Xero and report drift.
  await mirrorVerify({ scope, transactionId, label: '[4]' });
};

main().catch((error) => {
  console.error('\n✗ unexpected error:', error?.stack || error?.message || error);
  process.exit(1);
});
