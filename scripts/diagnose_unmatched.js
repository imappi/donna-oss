#!/usr/bin/env node
// Diagnose why specific documents remain unmatched.
// Usage: DATABASE_URL="..." node scripts/diagnose_unmatched.js

import { queryFirmDb } from '../server/donna/firmDb.js';

const FIRM_ID = process.env.FIRM_ID || 'donna-demo-firm';
const CLIENT_ID = process.env.CLIENT_ID || 'honeybee-hills-apiary';

async function main() {
  // 1. Find unmatched documents
  const docs = await queryFirmDb(
    `select d.id, d.filename, d.vendor_name, d.total_amount, d.currency,
            d.document_date, d.document_type, d.payment_status
       from documents d
      where d.firm_id = $1 and d.client_id = $2
        and d.parse_status = 'completed'
        and d.total_amount is not null
        and d.duplicate_of is null
        and d.id not in (
          select matched_object_id from reconciliation_matches
          where firm_id = $1 and client_id = $2
            and status in ('confirmed', 'auto_matched', 'suggested')
        )
      order by d.document_date`,
    [FIRM_ID, CLIENT_ID]
  );

  console.log(`\n=== ${docs.rows.length} unmatched documents ===\n`);

  for (const doc of docs.rows) {
    console.log(`--- ${doc.filename} ---`);
    console.log(`  Type: ${doc.document_type}, Amount: ${doc.currency} ${doc.total_amount}, Date: ${doc.document_date}`);
    console.log(`  Vendor: ${doc.vendor_name || 'NULL'}`);

    // Find transactions with matching amount
    const txs = await queryFirmDb(
      `select id, description, money_out, money_in, currency,
              transaction_date, reconciliation_status
         from transactions
        where firm_id = $1 and client_id = $2
          and abs(coalesce(money_out, 0) - $3) < 0.01
        order by transaction_date`,
      [FIRM_ID, CLIENT_ID, Number(doc.total_amount)]
    );

    if (!txs.rows.length) {
      console.log('  >> No transactions with matching amount found');
    } else {
      for (const tx of txs.rows) {
        const status = tx.reconciliation_status || 'null';
        console.log(`  TX: ${tx.description} | ${tx.currency} ${tx.money_out} | ${tx.transaction_date} | recon_status=${status}`);

        // Check if this tx is already matched to something
        if (tx.reconciliation_status) {
          const existingMatch = await queryFirmDb(
            `select rm.id, rm.matched_object_id, rm.matched_object_type, rm.status,
                    d.filename as matched_doc
               from reconciliation_matches rm
               left join documents d on d.id = rm.matched_object_id
              where rm.bank_transaction_id = $1 and rm.firm_id = $2
                and rm.status in ('confirmed', 'auto_matched')`,
            [tx.id, FIRM_ID]
          );
          for (const m of existingMatch.rows) {
            console.log(`     >> Already matched to: ${m.matched_doc} (${m.status})`);
          }
        }
      }
    }
    console.log('');
  }
}

main().catch((err) => {
  console.error('Diagnostic failed:', err);
  process.exit(1);
});
