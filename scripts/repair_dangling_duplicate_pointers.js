#!/usr/bin/env node
//
// Repair Alex's dangling duplicate_of pointers.
//
// Discovered during the post-PR-#180 diagnostic dig: three rows in
// `donna-demo-firm / alex-morgan-personal` carry
// `duplicate_of=<id>` where the target document has been deleted.
// The dangling rows are still correctly excluded from matchers
// (`duplicate_of IS NULL` filter), so functionally there's no
// regression — but the chain can't be navigated and re-dedup passes
// can't reason about it. Migration 011's "logical reference, no FK"
// makes the dangling state schema-legal, but it shouldn't exist in
// practice.
//
// Root cause (fixed in this PR's firmDb.js / parseDocumentsDb.js
// changes): three document-deletion paths didn't clear
// `duplicate_of` on dependent rows. Future deletions will promote
// dependents to canonical (clear duplicate_of in the same
// transaction). This script repairs the rows that were left behind
// before that fix.
//
// Repair semantics:
//
//   - Find rows in scope where `duplicate_of IS NOT NULL` AND the
//     target document doesn't exist in the same firm.
//   - NULL out `duplicate_of` (promote-to-canonical).
//   - Write an audit event with the prior pointer so the original
//     intent is recoverable from history.
//
// After this script applies, the promoted rows become candidates for
// the existing `mark_alex_morgan_duplicates.js` re-dedup pass (if
// they share filenames with other current canonicals, the script
// will re-mark them — this time pointing at a row that actually
// exists).
//
// Scope: alex-morgan-personal only. A whole-system audit is a
// separate diagnostic — out of scope here.
//
// Usage:
//   DATABASE_URL='postgresql://…@…:5432/postgres' \
//     node scripts/repair_dangling_duplicate_pointers.js          # dry-run
//   DATABASE_URL='…' node scripts/repair_dangling_duplicate_pointers.js --apply
//
// Re-running is safe — the detection query excludes rows whose
// targets exist, so a second run finds zero.

import { withFirmDbClient } from '../server/donna/firmDb.js';

const FIRM_ID = 'donna-demo-firm';
const CLIENT_ID = 'alex-morgan-personal';
const REPAIR_SOURCE = 'alex_morgan_dangling_pointer_repair_v1';

const APPLY = process.argv.includes('--apply');

const log = (...args) => console.log('[alex-morgan-repair]', ...args);

// Find rows whose `duplicate_of` points at a non-existent document.
// Uses a LEFT JOIN with an IS NULL check rather than NOT EXISTS so
// the canonical's filename / current state can be reported (or null
// if truly missing) for the operator's eyeball check.
const previewDanglers = async (client) => {
  const result = await client.query(
    `select d.id, d.filename, d.document_type, d.parse_status,
            d.created_at, d.duplicate_of,
            canon.id   as canonical_exists_id,
            canon.filename as canonical_filename
       from documents d
       left join documents canon
              on canon.firm_id = d.firm_id
             and canon.id = d.duplicate_of
      where d.firm_id = $1
        and d.client_id = $2
        and d.duplicate_of is not null
        and canon.id is null
      order by d.filename, d.id`,
    [FIRM_ID, CLIENT_ID]
  );
  return result.rows;
};

const applyRepair = async (client, row) => {
  const updated = await client.query(
    `update documents
        set duplicate_of = null, updated_at = now()
      where firm_id = $1 and client_id = $2 and id = $3
        and duplicate_of = $4
      returning id`,
    [FIRM_ID, CLIENT_ID, row.id, row.duplicate_of]
  );
  if (!updated.rows.length) return false;
  await client.query(
    `insert into audit_events
       (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
     values ($1, $2, 'system', 'document.dangling_pointer_repaired', 'document', $3, $4::jsonb)`,
    [FIRM_ID, CLIENT_ID, row.id, JSON.stringify({
      script: 'repair_dangling_duplicate_pointers.js',
      source: REPAIR_SOURCE,
      former_duplicate_of: row.duplicate_of,
      prior_state: {
        filename: row.filename,
        document_type: row.document_type,
        parse_status: row.parse_status
      }
    })]
  );
  return true;
};

const formatIsoDate = (value) => {
  if (value == null) return '(none)';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '(invalid)';
    return value.toISOString().slice(0, 19).replace('T', ' ');
  }
  return String(value).slice(0, 19).replace('T', ' ');
};

const runScript = async () => {
  log(`firm=${FIRM_ID} client=${CLIENT_ID} mode=${APPLY ? 'APPLY' : 'dry-run'}`);

  await withFirmDbClient(async (client) => {
    const danglers = await previewDanglers(client);

    if (!danglers.length) {
      log(`\nNo dangling duplicate_of pointers found. Exiting.`);
      return;
    }

    log(`\n— ${danglers.length} dangling pointer(s) —`);
    for (const row of danglers) {
      log(`  ${row.id}`);
      log(`    file:        ${row.filename}`);
      log(`    type:        ${row.document_type}`);
      log(`    parse_status: ${row.parse_status}`);
      log(`    created_at:  ${formatIsoDate(row.created_at)}`);
      log(`    duplicate_of: ${row.duplicate_of} → CHANGE: null (target document does not exist)`);
    }

    if (!APPLY) {
      log(`\nDry run complete. Re-run with --apply to commit.`);
      return;
    }

    log(`\n— applying —`);
    await client.query('begin');
    try {
      let repaired = 0;
      for (const row of danglers) {
        if (await applyRepair(client, row)) repaired += 1;
      }
      await client.query('commit');
      log(`\nRepaired ${repaired} row(s).`);
      log(`\nNext step (optional): re-run the dedup script. Rows whose`);
      log(`filename matches a currently-canonical row will be re-marked`);
      log(`with the live canonical's id:`);
      log(`  node scripts/mark_alex_morgan_duplicates.js`);
      log(`  node scripts/mark_alex_morgan_duplicates.js --apply`);
      log(`\nVerification:`);
      log(`psql "\\$DATABASE_URL" -c "`);
      log(`  select count(*) as remaining_dangling`);
      log(`    from documents d`);
      log(`    left join documents canon on canon.firm_id = d.firm_id and canon.id = d.duplicate_of`);
      log(`   where d.firm_id='${FIRM_ID}' and d.client_id='${CLIENT_ID}'`);
      log(`     and d.duplicate_of is not null and canon.id is null;"`);
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    }
  });
};

const invokedAsScript = import.meta.url === `file://${process.argv[1]}`;
if (invokedAsScript) {
  runScript().catch((err) => {
    console.error('[alex-morgan-repair] failed:', err?.message || err);
    process.exit(1);
  });
}
