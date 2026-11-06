#!/usr/bin/env node
// One-off: apply filename fallback enrichment to already-parsed documents
// that have null critical fields (vendor_name, document_date, total_amount).
//
// Usage:
//   DATABASE_URL="..." node scripts/backfill_filename_fallback.js

import { queryFirmDb, withFirmDbClient } from '../server/donna/firmDb.js';
import { applyPostExtractionEnrichment } from '../server/donna/filenameFallback.js';

const FIRM_ID = process.env.FIRM_ID || 'donna-demo-firm';
const CLIENT_ID = process.env.CLIENT_ID || 'honeybee-hills-apiary';

async function main() {
  console.log(`[filename-fallback] firm=${FIRM_ID}, client=${CLIENT_ID}\n`);

  const docs = await queryFirmDb(
    `select id, filename, vendor_name, customer_name, document_date,
            due_date, total_amount, currency, tax_amount, reference_number,
            payment_status, extraction_confidence, parse_summary
       from documents
      where firm_id = $1 and client_id = $2
        and parse_status = 'completed'
        and duplicate_of is null
        and (vendor_name is null or document_date is null or total_amount is null)`,
    [FIRM_ID, CLIENT_ID]
  );

  console.log(`Found ${docs.rows.length} documents with null critical fields\n`);

  let updated = 0;

  await withFirmDbClient(async (client) => {
    for (const doc of docs.rows) {
      const header = {
        vendor_name: doc.vendor_name,
        customer_name: doc.customer_name,
        document_date: doc.document_date,
        due_date: doc.due_date,
        total_amount: doc.total_amount,
        currency: doc.currency,
        tax_amount: doc.tax_amount,
        reference_number: doc.reference_number,
        payment_status: doc.payment_status,
        extraction_confidence: doc.extraction_confidence
      };
      const summary = doc.parse_summary && typeof doc.parse_summary === 'object'
        ? { ...doc.parse_summary }
        : { warnings: [] };

      const { filled } = applyPostExtractionEnrichment({
        header,
        summary,
        filename: doc.filename
      });

      if (!filled.length) {
        console.log(`  ${doc.filename}: no fields fillable from filename`);
        continue;
      }

      console.log(`  ${doc.filename}: filling ${filled.join(', ')}`);

      const setClauses = [];
      const params = [FIRM_ID, doc.id];
      let paramIdx = 3;

      if (filled.includes('vendor_name')) {
        setClauses.push(`vendor_name = $${paramIdx++}`);
        params.push(header.vendor_name);
      }
      if (filled.includes('document_date')) {
        setClauses.push(`document_date = $${paramIdx++}`);
        params.push(header.document_date);
      }
      if (filled.includes('total_amount')) {
        setClauses.push(`total_amount = $${paramIdx++}`);
        params.push(header.total_amount);
      }

      setClauses.push(`parse_summary = $${paramIdx++}`);
      params.push(JSON.stringify(summary));

      setClauses.push('updated_at = now()');

      await client.query(
        `update documents set ${setClauses.join(', ')}
          where firm_id = $1 and id = $2`,
        params
      );

      updated++;
    }
  });

  console.log(`\nDone. Updated ${updated} of ${docs.rows.length} documents.`);
}

main().catch((err) => {
  console.error('[filename-fallback] FAILED', err);
  process.exit(1);
});
