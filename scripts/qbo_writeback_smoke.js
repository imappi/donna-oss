#!/usr/bin/env node
// QBO live-writeback smoke harness — CLI orchestrator (INT-2; ports
// scripts/xero_writeback_smoke.js to the QBO JournalEntry path).
//
// Turns "validate the live QBO writeback end-to-end" into ONE command run
// against a CONNECTED Intuit sandbox company. Dry-run-safe BY DEFAULT; only
// writes when --execute is passed. Passing this smoke against the live
// sandbox is the exit criterion for flipping `available: true` in
// src/lib/clientAxes.js (the deliberate GA flip). See
// docs/qbo-live-writeback-runbook.md for the full setup.
//
// Usage:
//   node scripts/qbo_writeback_smoke.js --client <clientId> --transaction <txId> [--firm <id>]
//        [--connection <id>] [--sync] [--execute] [--force] [--verify-only] [--retry]
//
//   --sync         first sync QBO reference data (accounts/classes/vendors/customers)
//   --execute      ACTUALLY write the JournalEntry to QBO, then mirror-verify
//                  (omit for a safe dry-run pre-flight only)
//   --force        bypass the synced-mirror idempotency skip on --execute
//                  (re-push becomes an UPDATE via stored Id+SyncToken)
//   --verify-only  skip dry-run + write; just fetch the mirror back from QBO
//                  and report drift
//   --retry        re-push every mirror currently at status='error' for this
//                  client (exercises retryQboMirrorInDb), then exit
//
// Prereqs (fails loud if missing): QBO_CLIENT_ID/SECRET/REDIRECT_URI (+
// QBO_ENVIRONMENT=sandbox for the smoke), a firm DB connection, and a
// connected qbo_connections row for the client. The transaction must already
// be POSTED to the Donna ledger — QBO writeback mirrors posted journals.

import {
  syncQboReferenceDataInDb,
  writebackQboTransactionInDb,
  retryQboMirrorInDb,
  verifyQboMirrorInDb
} from '../server/donna/firmDb.js';
import { classifyQboWritebackDryRun, formatQboWritebackReadiness } from '../server/donna/qboWritebackSmoke.js';

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

// Mirror-verify: fetch the JournalEntry back from QBO and compare to what we
// sent. Unlike the Xero verifier there is no period window — verifyQboMirrorInDb
// scopes by transaction ids (or the most recent mirrors when none given).
// Results live under the `qbo_mirror_verification` envelope.
const mirrorVerify = async ({ scope, transactionId, label }) => {
  line(`\n${label} mirror-verify (fetch from QBO, compare to what we sent)…`);
  try {
    const verify = await verifyQboMirrorInDb({
      ...scope,
      transactionIds: transactionId ? [transactionId] : []
    });
    const payload = verify?.qbo_mirror_verification || verify;
    const rows = Array.isArray(payload?.results) ? payload.results : [];
    if (!rows.length) {
      fail('mirror-verify found no synced mirror rows to check.',
        'Confirm the writeback ran (--execute) and the qbo_journal_mirrors row is status=synced with a qbo_journal_entry_id.');
    }
    let allOk = true;
    for (const row of rows) {
      const ok = row?.status === 'mirror_ok';
      if (!ok) allOk = false;
      line(`    ${ok ? '✓' : '✗'} journal ${row?.journal_id || '(unknown)'}: ${row?.status}`);
      if (!ok && row) line(`      ${bounded(row?.checks || row, 600)}`);
    }
    const counts = payload?.counts;
    if (counts) line(`    counts: ${bounded(counts, 200)}`);
    line(`\n${allOk ? '✓' : '✗'} mirror-verify ${allOk ? 'complete — QBO matches what we sent' : 'reported drift / missing / error'}.`);
  } catch (error) {
    const v = classifyQboWritebackDryRun({ error });
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
  const retry = Boolean(args.retry);

  if (!clientId || (!transactionId && !retry)) {
    fail('Both --client <clientId> and --transaction <transactionId> are required (or --client with --retry).',
      'node scripts/qbo_writeback_smoke.js --client <id> --transaction <id> [--sync] [--execute]');
  }

  const scope = { firmId, clientId, connectionId };
  const mode = retry ? '  (RETRY errored mirrors)' : verifyOnly ? '  (VERIFY-ONLY: no write)' : execute ? '  (EXECUTE: will write to QBO)' : '  (dry-run only)';
  line(`\nQBO writeback smoke — client ${clientId}${transactionId ? `, transaction ${transactionId}` : ''}${mode}`);

  // Retry lane: re-push errored mirrors (the error → synced recovery path of
  // the runbook checklist), then stop.
  if (retry) {
    line('\n[retry] re-pushing mirrors at status=error…');
    try {
      const result = await retryQboMirrorInDb(scope);
      const payload = result?.xero_mirror_retry || result;
      line(`    ${bounded(payload?.counts || payload, 600)}`);
    } catch (error) {
      const v = classifyQboWritebackDryRun({ error });
      fail(`mirror retry failed: ${v.blocker.message}`, v.blocker.hint);
    }
    return;
  }

  if (verifyOnly) {
    await mirrorVerify({ scope, transactionId, label: '[verify-only]' });
    return;
  }

  // 1) Optional reference-data sync.
  if (args.sync) {
    line('\n[1] syncing QBO reference data (accounts/classes/vendors/customers)…');
    try {
      await syncQboReferenceDataInDb(scope);
      line('    synced (see qbo_sync_runs for counts).');
    } catch (error) {
      const v = classifyQboWritebackDryRun({ error });
      fail(`reference sync failed: ${v.blocker.message}`, v.blocker.hint);
    }
  }

  // 2) Dry-run pre-flight (never writes). Surfaces every blocker — config,
  //    connection, unposted journal, unmapped accounts — before any live call.
  line(`\n[${args.sync ? 2 : 1}] dry-run pre-flight…`);
  let verdict;
  try {
    const result = await writebackQboTransactionInDb({ ...scope, transactionId, dryRun: true });
    verdict = classifyQboWritebackDryRun({ result });
  } catch (error) {
    verdict = classifyQboWritebackDryRun({ error });
  }
  line(formatQboWritebackReadiness(verdict, { transactionId }).split('\n').map((l) => `    ${l}`).join('\n'));

  if (!verdict.ready) {
    fail('pre-flight says NOT READY — not writing to QBO.', verdict.blocker?.hint || undefined);
  }
  if (!execute) {
    line('\n✓ Dry-run pre-flight passed. Re-run with --execute to write this journal to QBO.');
    return;
  }

  // 3) Live write.
  line('\n[3] EXECUTING live writeback to QBO…');
  let writeResult;
  try {
    writeResult = await writebackQboTransactionInDb({ ...scope, transactionId, dryRun: false, force });
  } catch (error) {
    const v = classifyQboWritebackDryRun({ error });
    fail(`live writeback failed: ${v.blocker.message}`, v.blocker.hint);
  }
  const wb = writeResult?.xero_writeback || {};
  line(`    status: ${wb.status || '(unknown)'}${wb.skipped ? ' (skipped — already synced; use --force to update)' : ''}`);
  line(`    qbo_journal_entry_id: ${wb.qbo_journal_entry_id || '(not found in result — inspect below)'}`);
  if (!wb.qbo_journal_entry_id) line(`    result: ${bounded(wb)}`);

  // 4) Mirror-verify: fetch back from QBO and report drift.
  await mirrorVerify({ scope, transactionId, label: '[4]' });
};

main().catch((error) => {
  console.error('\n✗ unexpected error:', error?.stack || error?.message || error);
  process.exit(1);
});
