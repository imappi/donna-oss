#!/usr/bin/env node
// One-off backfill: re-run reconciliation matching + auto-categorize
// for a client's existing transactions. Use after deploying fuzzy
// matching improvements to pick up matches that the old code missed.
//
// Usage:
//   BANK_STATEMENT_MATCHER_ENABLED=true BILL_MATCHER_ENABLED=true \
//     node scripts/backfill_reconcile_and_categorize.js

import { DEFAULT_FIRM_ID } from '../server/donna/firmDb.js';
import {
  runReconciliationForBankStatementInDb,
  autoCategorizeMatchedTransactionsInDb,
  autoCategorizeUnmatchedTransactionsInDb
} from '../server/donna/parseDocumentsDb.js';

const FIRM_ID = DEFAULT_FIRM_ID;
const CLIENT_ID = process.env.CLIENT_ID || 'honeybee-hills-apiary';

async function main() {
  console.log(`[backfill] client=${CLIENT_ID}, firm=${FIRM_ID}`);
  console.log(`[backfill] BANK_STATEMENT_MATCHER_ENABLED=${process.env.BANK_STATEMENT_MATCHER_ENABLED}`);
  console.log(`[backfill] BILL_MATCHER_ENABLED=${process.env.BILL_MATCHER_ENABLED}`);

  console.log('\n[backfill] Step 1: Re-running reconciliation...');
  const reconStats = await runReconciliationForBankStatementInDb({
    firmId: FIRM_ID,
    clientId: CLIENT_ID
  });
  console.log('[backfill] Reconciliation:', reconStats);

  console.log('\n[backfill] Step 2: Auto-categorizing matched transactions...');
  const matchedStats = await autoCategorizeMatchedTransactionsInDb({
    firmId: FIRM_ID,
    clientId: CLIENT_ID
  });
  console.log('[backfill] Matched:', matchedStats);

  console.log('\n[backfill] Step 3: Auto-categorizing unmatched transactions (force=true)...');
  const unmatchedStats = await autoCategorizeUnmatchedTransactionsInDb({
    firmId: FIRM_ID,
    clientId: CLIENT_ID,
    force: true
  });
  console.log('[backfill] Unmatched:', unmatchedStats);

  console.log('\n[backfill] Done.');
  console.log(`  New matches: ${reconStats.matched || 0}`);
  console.log(`  Matched categorized: ${matchedStats.categorized || 0}`);
  console.log(`  Unmatched categorized: ${unmatchedStats.categorized || 0}`);
}

main().catch((err) => {
  console.error('[backfill] FAILED', err);
  process.exit(1);
});
