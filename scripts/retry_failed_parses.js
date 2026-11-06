#!/usr/bin/env node
// Retry all documents with parse_status='failed' or 'duplicate_pending'.
//
// Finds failed documents, mints new parse_run_ids, and either:
//   (a) sends Inngest events if INNGEST_EVENT_KEY is configured, or
//   (b) runs the parse worker inline (same as parse-cron drain task).
//
// Usage:
//   DATABASE_URL="..." node scripts/retry_failed_parses.js [--inline] [--client=<id>] [--dry-run]
//
// Options:
//   --inline    Run parse worker inline instead of sending Inngest events
//   --client=X  Only retry documents for a specific client_id
//   --dry-run   List failed documents without retrying

import { DEFAULT_FIRM_ID, queryFirmDb, withFirmDbClient } from '../server/donna/firmDb.js';
import { retryParseRunsInDb } from '../server/donna/parseDocumentsDb.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const inline = args.includes('--inline');
const clientArg = args.find((a) => a.startsWith('--client='));
const clientFilter = clientArg ? clientArg.split('=')[1] : null;

async function main() {
  console.log('[retry] Scanning for failed documents...\n');

  const clientClause = clientFilter
    ? `AND d.client_id = '${clientFilter.replace(/'/g, "''")}'`
    : '';

  const result = await queryFirmDb(
    `SELECT d.id, d.client_id, d.document_type, d.filename, d.parse_status,
            d.parse_error->>'code' as error_code,
            d.parse_error->>'safe_user_message' as error_message,
            d.parse_attempts,
            c.company_name as client_name
     FROM documents d
     LEFT JOIN clients c ON c.id = d.client_id AND c.firm_id = d.firm_id
     WHERE d.firm_id = $1
       AND d.parse_status IN ('failed', 'duplicate_pending')
       ${clientClause}
     ORDER BY c.company_name, d.filename`,
    [DEFAULT_FIRM_ID]
  );

  const rows = result.rows;
  if (rows.length === 0) {
    console.log('[retry] No failed documents found.');
    return;
  }

  console.log(`[retry] Found ${rows.length} failed document(s):\n`);

  const byClient = new Map();
  for (const row of rows) {
    const key = row.client_name || row.client_id || 'unknown';
    if (!byClient.has(key)) byClient.set(key, []);
    byClient.get(key).push(row);
  }

  for (const [clientName, docs] of byClient) {
    console.log(`  ${clientName} (${docs.length} docs):`);
    for (const doc of docs) {
      const errorInfo = doc.error_code ? ` [${doc.error_code}]` : '';
      const attempts = doc.parse_attempts ? ` (${doc.parse_attempts} attempts)` : '';
      console.log(`    - ${doc.filename || doc.id} (${doc.document_type})${errorInfo}${attempts}`);
    }
    console.log('');
  }

  if (dryRun) {
    console.log('[retry] Dry run — no retries executed.');
    return;
  }

  const documentIds = rows.map((r) => r.id);
  console.log(`[retry] Retrying ${documentIds.length} document(s)...`);

  const { retried, skipped } = await retryParseRunsInDb({
    firmId: DEFAULT_FIRM_ID,
    documentIds
  });

  console.log(`[retry] ${retried.length} document(s) queued for retry.`);
  if (skipped.length > 0) {
    console.log(`[retry] ${skipped.length} document(s) skipped (status no longer retryable).`);
  }

  if (inline && retried.length > 0) {
    console.log('[retry] Running inline parse for retried documents...\n');
    const { runParseInline } = await import('../server/donna/inngest/parseDocument.js');
    let success = 0;
    let fail = 0;
    for (const doc of retried) {
      try {
        const outcome = await runParseInline({
          firmId: DEFAULT_FIRM_ID,
          documentId: doc.id,
          parseRunId: doc.parse_run_id,
          logger: console
        });
        if (outcome.handled && outcome.outcome === 'completed') {
          success++;
          console.log(`  ✓ ${doc.filename || doc.id} → completed`);
        } else if (outcome.handled && outcome.outcome === 'failed') {
          fail++;
          console.log(`  ✗ ${doc.filename || doc.id} → failed (${outcome.code || 'unknown'})`);
        } else {
          console.log(`  ? ${doc.filename || doc.id} → ${outcome.outcome || outcome.reason || 'unknown'}`);
        }
      } catch (err) {
        fail++;
        console.error(`  ✗ ${doc.filename || doc.id} → error: ${err?.message || err}`);
      }
    }
    console.log(`\n[retry] Inline results: ${success} succeeded, ${fail} failed.`);
  } else if (retried.length > 0) {
    console.log('[retry] Documents are in pending state. They will be picked up by:');
    console.log('        - Inngest worker (if INNGEST_EVENT_KEY is set)');
    console.log('        - Parse cron drain task (/documents/parse-cron?task=drain)');
    console.log('        - Or re-run this script with --inline to process now.');
  }
}

main().catch((err) => {
  console.error('[retry] FAILED:', err?.message || err);
  process.exit(1);
});
