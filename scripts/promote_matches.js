#!/usr/bin/env node
// Promote eligible reconciliation matches from 'suggested' to 'auto_matched'.
// Applies to Tier 1 and Tier 2 matches (exact amount + vendor/customer).
// Cascades: transaction → reconciled, review queue → resolved.

import { queryFirmDb, withFirmDbClient } from '../server/donna/firmDb.js';

const FIRM_ID = process.env.FIRM_ID || 'donna-demo-firm';
const CLIENT_ID = process.env.CLIENT_ID || 'honeybee-hills-apiary';

async function main() {
  console.log(`[promote] firm=${FIRM_ID}, client=${CLIENT_ID}\n`);

  await withFirmDbClient(async (client) => {
    // Phase 1: Promote any remaining 'suggested' matches
    const suggested = await client.query(
      `select m.id, m.bank_transaction_id, m.match_confidence, m.payload
         from reconciliation_matches m
        where m.firm_id = $1 and m.client_id = $2
          and m.status = 'suggested'
          and m.match_confidence >= 0.85`,
      [FIRM_ID, CLIENT_ID]
    );

    let promoted = 0;
    for (const match of suggested.rows) {
      await client.query(
        `update reconciliation_matches
            set status = 'auto_matched',
                payload = payload || '{"auto_promoted":"backfill"}'::jsonb,
                updated_at = now()
          where firm_id = $1 and id = $2`,
        [FIRM_ID, match.id]
      );
      promoted++;
    }
    console.log(`Promoted ${promoted} suggested → auto_matched.`);

    // Phase 2: Patch all auto_matched/confirmed transaction statuses
    const matched = await client.query(
      `select distinct m.bank_transaction_id
         from reconciliation_matches m
        where m.firm_id = $1 and m.client_id = $2
          and m.status in ('auto_matched', 'confirmed')`,
      [FIRM_ID, CLIENT_ID]
    );

    let patched = 0;
    for (const row of matched.rows) {
      await client.query(
        `update transactions
            set reconciliation_status = 'reconciled',
                reconciled_at = coalesce(reconciled_at, now()),
                status = case when status = 'needs_review' then 'ready' else status end,
                payload = payload || '{"reconciliation_status":"reconciled","support_status":"rule_explained"}'::jsonb,
                updated_at = now()
          where firm_id = $1 and id = $2`,
        [FIRM_ID, row.bank_transaction_id]
      );

      // RT-16: the coding state is the transaction's own column (the case
      // file carries none); a backfilled reconcile is an applied coding.
      await client.query(
        `update transactions
            set coding_state = 'applied', coding_state_as_of = now(), updated_at = now()
          where firm_id = $1 and id = $2
            and (coding_state is null or coding_state in ('proposed', 'asked', 'held', 'applied'))`,
        [FIRM_ID, row.bank_transaction_id]
      );
      await client.query(
        `update transaction_review_queue
            set payload = payload || '{"closed_by":"auto_reconcile_backfill","reconciliation_status":"reconciled"}'::jsonb,
                updated_at = now()
          where firm_id = $1 and client_id = $2
            and item_id = $3
            and item_type = 'transaction'`,
        [FIRM_ID, CLIENT_ID, row.bank_transaction_id]
      );
      patched++;
    }

    console.log(`Patched ${patched} transactions to reconciled.`);

    // Reopen items that were incorrectly closed by the earlier promote run
    const reopened = await client.query(
      `update transaction_review_queue
          set status = 'open',
              updated_at = now()
        where firm_id = $1 and client_id = $2
          and status = 'resolved'
          and payload->>'closed_by' = 'auto_reconcile_backfill'`,
      [FIRM_ID, CLIENT_ID]
    );
    console.log(`Reopened ${reopened.rowCount} incorrectly closed review items.`);

    console.log('\nDone.');
  });
}

main().catch((err) => { console.error('FAILED', err); process.exit(1); });
