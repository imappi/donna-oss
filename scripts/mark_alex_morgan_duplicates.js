#!/usr/bin/env node
//
// One-off duplicate marking for `donna-demo-firm / alex-morgan-personal`.
//
// The Alex Morgan backfill (PR #179) surfaced four pairs of documents
// that were uploaded twice — same filename, same firm/client, same
// content. The reconciliation matchers already filter
// `duplicate_of IS NULL` (since migration 011), but the dupe pairs
// were never marked, so both copies still feed the matcher and create
// competing candidates for the same bank transaction.
//
// Per the architecture review: don't delete. Mark via `duplicate_of`.
// Keep the earliest-uploaded row as canonical (created_at ASC); the
// later upload becomes a duplicate pointing at it. The matcher's
// `duplicate_of IS NULL` filter then naturally drops the duplicate
// from candidate scoring without losing the row.
//
// Scope: filename collisions inside Alex's client where `duplicate_of
// IS NULL` for both. The four known clusters at time of writing:
//   - 02_2026-04-03_University_accommodation_invoice.pdf
//   - 07_2026-02-13_Wheeler_accountant_invoice.pdf
//   - 12_2026-04-15_Amazon_VAT_invoice.pdf
//   - 05_2026-04-05_Dominos_receipt.pdf
//
// The query is generic — `group by filename having count(*) > 1` —
// so any future Alex dupes are caught too. Other firms / clients are
// not in scope.
//
// Usage:
//   DATABASE_URL='postgresql://…@…:5432/postgres' \
//     node scripts/mark_alex_morgan_duplicates.js          # dry-run
//   DATABASE_URL='…' node scripts/mark_alex_morgan_duplicates.js --apply
//
// Re-running this script is safe. The detection query excludes rows
// already marked as duplicate, so a second run finds zero clusters.
//
// After applying, hit the reconcile cron so the matchers re-score
// without the duplicate candidates:
//   curl -i -H "Authorization: Bearer ${CRON_SECRET}" \
//     "https://books-app.example/api/donna/firms/documents/parse-cron?task=reconcile&client_id=alex-morgan-personal"
//
// Operator note: this is a bounded historical repair. The actual
// product fix is upstream — the upload pipeline should detect dupes
// at insert time and either dedupe or surface a review prompt. That
// path already exists in parseDocumentsDb.js (search `duplicate_of`)
// but evidently didn't catch these uploads. Worth a separate
// investigation; not in scope here.

import { withFirmDbClient } from '../server/donna/firmDb.js';
import { __clearReconciliationMatchesForDuplicateWithClient } from '../server/donna/parseDocumentsDb.js';

const FIRM_ID = 'donna-demo-firm';
const CLIENT_ID = 'alex-morgan-personal';
const BACKFILL_SOURCE = 'alex_morgan_duplicate_marking_v1';

const APPLY = process.argv.includes('--apply');

const log = (...args) => console.log('[alex-morgan-dedup]', ...args);

// Pure helper — exported for tests. Given an array of rows sorted by
// `created_at ASC` (earliest first), return the canonical row and the
// rows to mark as duplicates of it. Earliest-by-created_at is the
// stable convention: the first upload is the original; later uploads
// are the dupes.
//
// Tiebreak when created_at values are equal: prefer parse_status =
// 'completed' over 'failed' / 'pending'. Within equally-completed
// rows, prefer the lex-lower id (deterministic).
export const choosCanonical = (rowsAscByCreatedAt) => {
  if (!Array.isArray(rowsAscByCreatedAt) || rowsAscByCreatedAt.length < 2) {
    return { canonical: null, duplicates: [] };
  }
  // The DB query is `order by created_at asc, id asc`, but if multiple
  // rows share the earliest created_at we want to prefer 'completed'
  // among them. Collect everything at the earliest timestamp, pick the
  // best, then everything else is a duplicate.
  const earliestTs = rowsAscByCreatedAt[0].created_at;
  const tied = rowsAscByCreatedAt.filter((r) => sameInstant(r.created_at, earliestTs));
  const others = rowsAscByCreatedAt.filter((r) => !sameInstant(r.created_at, earliestTs));

  const completed = tied.filter((r) => r.parse_status === 'completed');
  const canonical = (completed.length ? completed : tied)
    .slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];

  const duplicates = rowsAscByCreatedAt.filter((r) => r.id !== canonical.id);
  return { canonical, duplicates, others };
};

const sameInstant = (a, b) => {
  if (a === b) return true;
  if (a == null || b == null) return false;
  const av = a instanceof Date ? a.getTime() : new Date(a).getTime();
  const bv = b instanceof Date ? b.getTime() : new Date(b).getTime();
  return av === bv;
};

const previewClusters = async (client) => {
  // Find filename collisions where BOTH rows have duplicate_of=null.
  // (If one is already marked, the cluster is already handled.) We
  // also surface non-collision metadata so the dry-run reviewer can
  // verify the rows really are the same document.
  const result = await client.query(
    `with clusters as (
       select filename,
              array_agg(id order by created_at asc, id asc) as ids,
              count(*) as n
         from documents
        where firm_id = $1
          and client_id = $2
          and duplicate_of is null
        group by filename
       having count(*) > 1
     )
     select c.filename, c.n,
            d.id, d.created_at, d.parse_status, d.document_type, d.direction,
            d.document_date, d.total_amount, d.vendor_name, d.customer_name
       from clusters c
       join documents d
         on d.firm_id = $1
        and d.client_id = $2
        and d.filename = c.filename
        and d.duplicate_of is null
      order by c.filename, d.created_at asc, d.id asc`,
    [FIRM_ID, CLIENT_ID]
  );

  // Group by filename for printing.
  const clusters = new Map();
  for (const row of result.rows) {
    if (!clusters.has(row.filename)) clusters.set(row.filename, []);
    clusters.get(row.filename).push(row);
  }
  return clusters;
};

const formatIsoDate = (value) => {
  if (value == null) return '(no date)';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '(invalid date)';
    return value.toISOString().slice(0, 19).replace('T', ' ');
  }
  return String(value).slice(0, 19).replace('T', ' ');
};

const printCluster = (filename, rows) => {
  const { canonical, duplicates } = choosCanonical(rows);
  log(`  ${filename}  (${rows.length} rows)`);
  for (const row of rows) {
    const role = row.id === canonical.id ? 'CANONICAL ' : 'duplicate ';
    log(`    ${role}${row.id}`);
    log(`      created_at:    ${formatIsoDate(row.created_at)}`);
    log(`      parse_status:  ${row.parse_status}`);
    log(`      document_type: ${row.document_type}`);
    log(`      doc_date:      ${row.document_date || '(none)'}`);
    log(`      amount:        ${row.total_amount != null ? row.total_amount : '(none)'}`);
  }
  return { canonical, duplicates };
};

const applyCluster = async (client, canonicalId, duplicateRows) => {
  let marked = 0;
  let staleRowsCleared = 0;
  for (const row of duplicateRows) {
    const result = await client.query(
      `update documents
          set duplicate_of = $4,
              updated_at = now()
        where firm_id = $1 and client_id = $2 and id = $3
          and duplicate_of is null
        returning id`,
      [FIRM_ID, CLIENT_ID, row.id, canonicalId]
    );
    if (!result.rows.length) continue;
    // Drop any reconciliation_matches rows the now-dupe doc had
    // accumulated while it was canonical. They'd never refresh
    // (matcher filters duplicate_of IS NULL) and the UI's JOIN
    // hides them; cleaner to remove them outright in the same
    // transaction. See parseDocumentsDb.js for the helper.
    const cleared = await __clearReconciliationMatchesForDuplicateWithClient(
      client,
      { firmId: FIRM_ID, documentId: row.id }
    );
    staleRowsCleared += cleared.deleted;
    await client.query(
      `insert into audit_events
         (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
       values ($1, $2, 'system', 'document.marked_duplicate', 'document', $3, $4::jsonb)`,
      [FIRM_ID, CLIENT_ID, row.id, JSON.stringify({
        script: 'mark_alex_morgan_duplicates.js',
        source: BACKFILL_SOURCE,
        canonical_id: canonicalId,
        stale_match_rows_deleted: cleared.deleted,
        prior_state: {
          parse_status: row.parse_status,
          document_type: row.document_type,
          document_date: row.document_date,
          total_amount: row.total_amount
        }
      })]
    );
    marked += 1;
  }
  return { marked, staleRowsCleared };
};

const printVerificationQueries = () => {
  log(`\n— verification queries (run on prod after this script) —`);
  log(`-- 1. Confirm duplicates carry duplicate_of pointers:`);
  log(`psql "\\$DATABASE_URL" -c "`);
  log(`  select id, filename, document_type, parse_status,`);
  log(`         duplicate_of`);
  log(`    from documents`);
  log(`   where firm_id='${FIRM_ID}' and client_id='${CLIENT_ID}'`);
  log(`     and duplicate_of is not null`);
  log(`   order by filename, id;"`);
  log(``);
  log(`-- 2. Confirm no remaining unmarked dupe clusters:`);
  log(`psql "\\$DATABASE_URL" -c "`);
  log(`  select filename, count(*) as n`);
  log(`    from documents`);
  log(`   where firm_id='${FIRM_ID}' and client_id='${CLIENT_ID}'`);
  log(`     and duplicate_of is null`);
  log(`   group by 1 having count(*) > 1;"`);
};

const runScript = async () => {
  log(`firm=${FIRM_ID} client=${CLIENT_ID} mode=${APPLY ? 'APPLY' : 'dry-run'}`);

  await withFirmDbClient(async (client) => {
    const clusters = await previewClusters(client);

    if (!clusters.size) {
      log(`\nNo unmarked duplicate clusters found. Exiting.`);
      return;
    }

    log(`\n— ${clusters.size} duplicate cluster(s) —`);

    const plan = [];
    for (const [filename, rows] of clusters) {
      const { canonical, duplicates } = printCluster(filename, rows);
      plan.push({ filename, canonicalId: canonical.id, duplicates });
    }

    const totalDupes = plan.reduce((sum, p) => sum + p.duplicates.length, 0);
    log(`\nTotal rows to mark as duplicate: ${totalDupes}`);

    if (!APPLY) {
      log(`\nDry run complete. Re-run with --apply to commit.`);
      return;
    }

    log(`\n— applying —`);
    await client.query('begin');
    try {
      let total = 0;
      let totalStaleCleared = 0;
      for (const p of plan) {
        const { marked, staleRowsCleared } = await applyCluster(client, p.canonicalId, p.duplicates);
        log(`  ${p.filename}: ${marked} row(s) → duplicate_of=${p.canonicalId}${staleRowsCleared ? ` (cleared ${staleRowsCleared} stale match row(s))` : ''}`);
        total += marked;
        totalStaleCleared += staleRowsCleared;
      }
      await client.query('commit');
      log(`\nDone. ${total} document(s) now carry duplicate_of.${totalStaleCleared ? ` ${totalStaleCleared} stale reconciliation_matches row(s) deleted.` : ''}`);
      log(`\nNext step: trigger reconcile so the matchers drop duplicate candidates:`);
      log(`  curl -i -H "Authorization: Bearer \${CRON_SECRET}" \\`);
      log(`    "https://books-app.example/api/donna/firms/documents/parse-cron?task=reconcile&client_id=${CLIENT_ID}"`);
      printVerificationQueries();
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    }
  });
};

const invokedAsScript = import.meta.url === `file://${process.argv[1]}`;
if (invokedAsScript) {
  runScript().catch((err) => {
    console.error('[alex-morgan-dedup] failed:', err?.message || err);
    process.exit(1);
  });
}
