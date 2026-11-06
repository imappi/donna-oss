#!/usr/bin/env node
//
// One-off backfill for `donna-demo-firm / alex-morgan-personal` (v2).
//
// Fixes the misclassified documents identified end-of-day 2026-06-03:
//
//   - Rent receipts (filename `*_rent_receipt.pdf`) issued by Alex's
//     letting business "M & R Holdings (Trading) Ltd" to her tenants.
//     They are AR documents (the firm RECEIVED money) — the upload
//     classifier filed them as `receipt` (AP). Re-type to
//     `issued_receipt`, set direction=incoming.
//
//   - Purchase invoices wrongly typed as `sales_invoice` because the
//     filename hint said "invoice" (without the `_issued` suffix that
//     this synthetic dataset uses to disambiguate AR from AP). Each is
//     a bill the firm RECEIVED from a supplier (AWS, WeWork, University
//     accommodation, accountant retainers, Foxbury letting agent,
//     MJHeating, …). Re-type to `supplier_bill`, direction=outgoing.
//     Vendor name is derived from the controlled filename pattern
//     (`NN_YYYY-MM-DD_<vendor>_invoice.pdf`) and written into
//     `vendor_name`; `customer_name` is cleared (the sales_invoice
//     extractor wrote hallucinated counterparties there).
//
// v2 changes vs v1:
//   - AP detection moved from a customer_name pattern list to a
//     filename predicate (`%_invoice.pdf` minus `%_invoice_issued.pdf`).
//     v1's customer_name matchers found 0 rows in the live DB because
//     the sales_invoice extractor hallucinated unrelated names like
//     "Priya Ramanathan" / "Jordan Williams" into customer_name — none
//     of v1's vendor patterns matched. Filename is the actually-correct
//     signal for this controlled synthetic dataset.
//   - Vendor name now derived from filename rather than relying on the
//     `customer_name → vendor_name` shuffle.
//   - Every mutated row stamps `parse_summary.classification_backfill`
//     with the audit blob `{source, original_type, final_type,
//     original_direction, final_direction, reason, changed_at,
//     changed_by}` so future operators can see why the type changed.
//   - Dry-run output prints ISO dates and before→after per row.
//   - Apply path prints post-apply verification queries.
//
// Filename heuristics are ONLY appropriate for this bounded Alex repair
// because the dataset filenames follow a controlled convention. Do not
// generalise this approach into the production router — production
// classification is router-driven (see `server/donna/documentRouter.js`).
//
// Also writes Alex's structured identity into clients.legal_names so
// the router can resolve direction on future uploads from this client
// without re-encountering the same bug.
//
// Usage:
//   DATABASE_URL='postgresql://…@…:5432/postgres' \
//     node scripts/backfill_alex_morgan_classification.js          # dry-run preview
//   DATABASE_URL='…' node scripts/backfill_alex_morgan_classification.js --apply
//
// After --apply, hit the reconcile cron so the AR/AP matchers re-run:
//   curl -i -H "Authorization: Bearer ${CRON_SECRET}" \
//     "https://books-app.example/api/donna/firms/documents/parse-cron?task=reconcile&client_id=alex-morgan-personal"
//
// Re-running this script is safe. The UPDATEs are scoped to documents
// whose current document_type is the one we expect to FIND; once
// applied, the second run is a no-op (both detection queries return
// zero rows because the rows now have document_type='issued_receipt' or
// 'supplier_bill' respectively).

import { withFirmDbClient } from '../server/donna/firmDb.js';

const FIRM_ID = 'donna-demo-firm';
const CLIENT_ID = 'alex-morgan-personal';
const BACKFILL_SOURCE = 'alex_morgan_backfill_v2';

const ALEX_LEGAL_NAMES = [
  'Alex Morgan',
  'M & R Holdings (Trading) Ltd'
];

// Pure helpers — exported for unit tests.

// `NN_YYYY-MM-DD_<vendor>_invoice.pdf` → "<vendor>" with `_` → space.
// Case is preserved from the filename (so `AWS` stays `AWS`, `WeWork`
// stays `WeWork`). Returns null when the pattern doesn't match.
export const deriveVendorFromFilename = (filename) => {
  if (!filename) return null;
  const match = String(filename).match(
    /^(?:\d+_)?(?:\d{4}-\d{2}-\d{2}_)?(.+?)_invoice\.pdf$/i
  );
  if (!match) return null;
  const vendor = match[1].replace(/_/g, ' ').trim();
  return vendor || null;
};

// Format a Postgres date / Date / string as `YYYY-MM-DD`. Avoids
// `Date.toString()`'s timezone-stamped output for date-only facts.
export const formatIsoDate = (value) => {
  if (value == null) return '(no date)';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '(invalid date)';
    return value.toISOString().slice(0, 10);
  }
  const str = String(value).trim();
  if (!str) return '(no date)';
  const isoMatch = str.match(/^(\d{4}-\d{2}-\d{2})/);
  return isoMatch ? isoMatch[1] : str;
};

export const buildBackfillAudit = ({
  originalType,
  finalType,
  originalDirection,
  finalDirection,
  reason,
  extras = {}
}) => ({
  source: BACKFILL_SOURCE,
  original_type: originalType,
  final_type: finalType,
  original_direction: originalDirection,
  final_direction: finalDirection,
  reason,
  changed_at: new Date().toISOString(),
  changed_by: 'system',
  ...extras
});

const APPLY = process.argv.includes('--apply');

const log = (...args) => console.log('[alex-morgan-backfill]', ...args);

const previewDocs = async (client) => {
  const rentReceipts = await client.query(
    `select id, filename, document_type, direction, vendor_name, customer_name,
            document_date, total_amount, currency
       from documents
      where firm_id = $1
        and client_id = $2
        and filename ilike '%rent_receipt%'
        and document_type = 'receipt'
      order by document_date nulls last, filename`,
    [FIRM_ID, CLIENT_ID]
  );

  // Filename-based AP detection. Synthetic dataset convention:
  //   *_invoice.pdf        → AP supplier bill (filed wrong as sales_invoice)
  //   *_invoice_issued.pdf → AR sales invoice (correctly typed)
  // The ILIKE pattern accepts the suffix anywhere in the basename; the
  // NOT-ILIKE filters out the `_issued` family.
  const apMisclassified = await client.query(
    `select id, filename, document_type, direction, vendor_name, customer_name,
            document_date, total_amount, currency
       from documents
      where firm_id = $1
        and client_id = $2
        and document_type = 'sales_invoice'
        and filename ilike '%_invoice.pdf'
        and filename not ilike '%_invoice_issued.pdf'
      order by document_date nulls last, filename`,
    [FIRM_ID, CLIENT_ID]
  );

  return { rentReceipts: rentReceipts.rows, apMisclassified: apMisclassified.rows };
};

const previewClient = async (client) => {
  const result = await client.query(
    'select id, company_name, legal_names from clients where firm_id = $1 and id = $2',
    [FIRM_ID, CLIENT_ID]
  );
  return result.rows[0] || null;
};

const applyClientIdentity = async (client) => {
  await client.query(
    `update clients
        set legal_names = $3::text[],
            updated_at = now()
      where firm_id = $1 and id = $2`,
    [FIRM_ID, CLIENT_ID, ALEX_LEGAL_NAMES]
  );
};

const RENT_RECEIPT_REASON =
  'Controlled synthetic dataset: filename `*_rent_receipt.pdf` denotes ' +
  'a receipt ISSUED by Alex\'s letting company (M & R Holdings) to a ' +
  'tenant. Original upload classifier filed it as `receipt` (AP); the ' +
  'document is AR / incoming.';

const AP_MISCLASSIFIED_REASON =
  'Controlled synthetic dataset: filename `*_invoice.pdf` (without the ' +
  '`_issued` suffix) denotes an AP supplier bill in this firm\'s upload ' +
  'convention. The sales_invoice extractor filed it as AR and hallucinated ' +
  'a counterparty into customer_name; rewriting vendor_name from the ' +
  'controlled filename and clearing customer_name.';

const applyRentReceipts = async (client, rows) => {
  let updated = 0;
  for (const row of rows) {
    const audit = buildBackfillAudit({
      originalType: row.document_type,
      finalType: 'issued_receipt',
      originalDirection: row.direction,
      finalDirection: 'incoming',
      reason: RENT_RECEIPT_REASON
    });
    const result = await client.query(
      `update documents
          set document_type = 'issued_receipt',
              direction = 'incoming',
              payment_status = coalesce(payment_status, 'paid'),
              parse_summary = jsonb_set(
                coalesce(parse_summary, '{}'::jsonb),
                '{classification_backfill}',
                $4::jsonb,
                true
              ),
              updated_at = now()
        where firm_id = $1 and client_id = $2 and id = $3
        returning id`,
      [FIRM_ID, CLIENT_ID, row.id, JSON.stringify(audit)]
    );
    updated += result.rows.length;
  }
  return { updated };
};

const applyApMisclassified = async (client, rows) => {
  let updated = 0;
  for (const row of rows) {
    const derivedVendor = deriveVendorFromFilename(row.filename);
    // Prefer derived vendor name from the controlled filename. Fall
    // back to the existing vendor_name (almost always blank for this
    // misclassification class), then to customer_name (hallucinated,
    // usually wrong, but better than null if both else fail).
    const vendorName = derivedVendor || row.vendor_name || row.customer_name || null;
    const audit = buildBackfillAudit({
      originalType: row.document_type,
      finalType: 'supplier_bill',
      originalDirection: row.direction,
      finalDirection: 'outgoing',
      reason: AP_MISCLASSIFIED_REASON,
      extras: {
        original_vendor_name: row.vendor_name,
        original_customer_name: row.customer_name,
        vendor_name_source: derivedVendor ? 'derived_from_filename' : 'preserved_from_extraction'
      }
    });
    const result = await client.query(
      `update documents
          set document_type = 'supplier_bill',
              direction = 'outgoing',
              vendor_name = $4,
              customer_name = null,
              parse_summary = jsonb_set(
                coalesce(parse_summary, '{}'::jsonb),
                '{classification_backfill}',
                $5::jsonb,
                true
              ),
              updated_at = now()
        where firm_id = $1 and client_id = $2 and id = $3
        returning id`,
      [FIRM_ID, CLIENT_ID, row.id, vendorName, JSON.stringify(audit)]
    );
    updated += result.rows.length;
  }
  return { updated };
};

const printRentReceiptPreview = (rows) => {
  log(`\n— rent receipts (document_type='receipt' → 'issued_receipt') —`);
  log(`found ${rows.length} row(s):`);
  for (const row of rows) {
    const amount = row.total_amount != null
      ? `${row.currency || ''} ${row.total_amount}`.trim()
      : '(no amount)';
    log(`  ${row.id}`);
    log(`    file:      ${row.filename}`);
    log(`    date:      ${formatIsoDate(row.document_date)}`);
    log(`    amount:    ${amount}`);
    log(`    type:      ${row.document_type || '(none)'} → issued_receipt`);
    log(`    direction: ${row.direction || '(none)'} → incoming`);
  }
};

const printApPreview = (rows) => {
  log(`\n— AP-misclassified sales_invoices (→ 'supplier_bill') —`);
  log(`found ${rows.length} row(s):`);
  for (const row of rows) {
    const amount = row.total_amount != null
      ? `${row.currency || ''} ${row.total_amount}`.trim()
      : '(no amount)';
    const derivedVendor = deriveVendorFromFilename(row.filename);
    const vendorBefore = row.vendor_name || '(none)';
    const vendorAfter = derivedVendor || row.vendor_name || row.customer_name || '(none)';
    log(`  ${row.id}`);
    log(`    file:      ${row.filename}`);
    log(`    date:      ${formatIsoDate(row.document_date)}`);
    log(`    amount:    ${amount}`);
    log(`    type:      ${row.document_type || '(none)'} → supplier_bill`);
    log(`    direction: ${row.direction || '(none)'} → outgoing`);
    log(`    vendor:    ${vendorBefore} → ${vendorAfter}${derivedVendor ? ' (derived from filename)' : ''}`);
    log(`    customer:  ${row.customer_name || '(none)'} → null`);
  }
};

const printVerificationQueries = () => {
  log(`\n— verification queries (run on prod after this script) —`);
  log(`-- 1. Type/direction mix should show issued_receipt + supplier_bill counts:`);
  log(`psql "\\$DATABASE_URL" -c "`);
  log(`  select document_type, direction, count(*)`);
  log(`    from documents`);
  log(`   where firm_id='${FIRM_ID}' and client_id='${CLIENT_ID}'`);
  log(`   group by 1, 2`);
  log(`   order by 1, 2;"`);
  log(``);
  log(`-- 2. Audit trail: each fixed row should carry classification_backfill metadata:`);
  log(`psql "\\$DATABASE_URL" -c "`);
  log(`  select id, filename, document_type,`);
  log(`         parse_summary->'classification_backfill'->>'source'        as bf_source,`);
  log(`         parse_summary->'classification_backfill'->>'original_type' as bf_orig_type`);
  log(`    from documents`);
  log(`   where firm_id='${FIRM_ID}' and client_id='${CLIENT_ID}'`);
  log(`     and parse_summary->'classification_backfill'->>'source' = '${BACKFILL_SOURCE}'`);
  log(`   order by filename;"`);
};

const runScript = async () => {
  log(`firm=${FIRM_ID} client=${CLIENT_ID} mode=${APPLY ? 'APPLY' : 'dry-run'}`);

  await withFirmDbClient(async (client) => {
    const clientRow = await previewClient(client);
    if (!clientRow) {
      log(`ERROR: client ${CLIENT_ID} not found in firm ${FIRM_ID}.`);
      process.exit(1);
    }
    log(`current client.legal_names = ${JSON.stringify(clientRow.legal_names || [])}`);
    log(`target  client.legal_names = ${JSON.stringify(ALEX_LEGAL_NAMES)}`);

    const { rentReceipts, apMisclassified } = await previewDocs(client);

    printRentReceiptPreview(rentReceipts);
    printApPreview(apMisclassified);

    if (!APPLY) {
      log(`\nDry run complete. Re-run with --apply to commit.`);
      return;
    }

    log(`\n— applying —`);
    await client.query('begin');
    try {
      await applyClientIdentity(client);
      const rrStats = await applyRentReceipts(client, rentReceipts);
      const apStats = await applyApMisclassified(client, apMisclassified);
      await client.query('commit');
      log(`legal_names: written`);
      log(`rent receipts updated: ${rrStats.updated}`);
      log(`AP-misclassified updated: ${apStats.updated}`);
      log(`\nNext step: trigger reconcile so the AR/AP matchers re-run:`);
      log(`  curl -i -H "Authorization: Bearer \${CRON_SECRET}" \\`);
      log(`    "https://books-app.example/api/donna/firms/documents/parse-cron?task=reconcile&client_id=${CLIENT_ID}"`);
      log(`\nKnown limitation: rent receipts were extracted by the receipt`);
      log(`extractor, which stuffs the issuer (Alex / M & R Holdings) into`);
      log(`vendor_name and leaves customer_name null. The AR matcher will`);
      log(`fall back to amount+date matching for these — customer_name`);
      log(`overlap won't fire until the docs are re-parsed through the`);
      log(`sales_invoice extractor. Suggested matches should still land at`);
      log(`tier amount_exact_no_customer (score 0.55).`);
      printVerificationQueries();
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    }
  });
};

// Skip auto-run when the module is imported (e.g. by tests). Only the
// CLI entry point invokes runScript().
const invokedAsScript = import.meta.url === `file://${process.argv[1]}`;
if (invokedAsScript) {
  runScript().catch((err) => {
    console.error('[alex-morgan-backfill] failed:', err?.message || err);
    process.exit(1);
  });
}
