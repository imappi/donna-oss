#!/usr/bin/env node
//
// Force re-parse of specific documents. Resets parse_status to
// 'pending' and mints a new parse_run_id so the outbox cron will
// re-dispatch them through the worker on the next sweep.
//
// Intended use cases:
//
//   - A misclassified document was manually re-typed (e.g. via the
//     alex-morgan classification backfill). The new type changes the
//     extractor; re-parsing re-extracts with the correct fields
//     (e.g. issued_receipt rows need customer_name extracted via the
//     sales_invoice extractor instead of the receipt extractor which
//     stuffs the issuer into vendor_name).
//
//   - The classifier or an extractor prompt shipped a fix and we
//     want a specific list of historical docs to benefit.
//
// Destructive. Wipes the existing parse_summary / extraction header
// / lines on the re-parse. Dry-run by default — use --apply to
// commit.
//
// Usage:
//
//   DATABASE_URL='postgresql://…' \
//     node scripts/reparse_documents.js \
//       --firm donna-demo-firm \
//       --client alex-morgan-personal \
//       --ids doc-id-1,doc-id-2,doc-id-3
//
//   DATABASE_URL='…' node scripts/reparse_documents.js \
//     --firm donna-demo-firm \
//     --client alex-morgan-personal \
//     --type issued_receipt \
//     --apply
//
// --type selects all documents of that type for the client (useful
// after a backfill that re-classified a bunch of rows at once).
// --ids overrides --type and re-parses only the listed ids.
//
// After re-queueing, the outbox cron picks up the pending docs and
// fires Inngest events. No additional curl needed — the cron runs
// every ~5 min in production.

import crypto from 'node:crypto';

import { withFirmDbClient } from '../server/donna/firmDb.js';

const parseArgs = () => {
  const args = { firm: null, client: null, ids: null, type: null, apply: false };
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--apply') { args.apply = true; continue; }
    const eq = arg.indexOf('=');
    const [key, valueInline] = eq >= 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, null];
    const value = valueInline ?? process.argv[i + 1];
    if (valueInline == null) i++;
    if (key === '--firm') args.firm = value;
    else if (key === '--client') args.client = value;
    else if (key === '--ids') args.ids = value.split(',').map((s) => s.trim()).filter(Boolean);
    else if (key === '--type') args.type = value;
  }
  return args;
};

const log = (...a) => console.log('[reparse]', ...a);

const previewDocs = async (client, { firm, clientId, ids, type }) => {
  if (ids && ids.length) {
    const result = await client.query(
      `select id, filename, document_type, direction, parse_status, parse_completed_at
         from documents
        where firm_id = $1 and client_id = $2 and id = any($3::text[])
        order by filename`,
      [firm, clientId, ids]
    );
    return result.rows;
  }
  if (type) {
    const result = await client.query(
      `select id, filename, document_type, direction, parse_status, parse_completed_at
         from documents
        where firm_id = $1 and client_id = $2 and document_type = $3
        order by filename`,
      [firm, clientId, type]
    );
    return result.rows;
  }
  return [];
};

const applyReparse = async (client, { firm, ids }) => {
  if (!ids.length) return [];
  const updated = [];
  for (const id of ids) {
    const newRunId = crypto.randomUUID();
    const row = await client.query(
      `update documents
          set parse_status = 'pending',
              parse_run_id = $3::uuid,
              parse_stage = null,
              parse_progress_current = null,
              parse_progress_total = null,
              parse_error = null,
              parse_enqueued_at = now(),
              parse_event_sent_at = null,
              parse_started_at = null,
              parse_heartbeat_at = null,
              parse_completed_at = null,
              updated_at = now()
        where firm_id = $1 and id = $2
        returning id, client_id, document_type`,
      [firm, id, newRunId]
    );
    if (row.rows.length) {
      const r = row.rows[0];
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', 'document.parse.force_reparse', 'document', $3, $4::jsonb)`,
        [firm, r.client_id, r.id, JSON.stringify({
          parse_run_id: newRunId,
          script: 'reparse_documents.js',
          document_type_at_reparse: r.document_type
        })]
      );
      updated.push({ id: r.id, new_run_id: newRunId });
    }
  }
  return updated;
};

const main = async () => {
  const args = parseArgs();
  if (!args.firm || !args.client) {
    console.error('[reparse] missing required --firm and --client');
    process.exit(2);
  }
  if (!args.ids && !args.type) {
    console.error('[reparse] supply either --ids=doc-1,doc-2 or --type=issued_receipt');
    process.exit(2);
  }

  log(`firm=${args.firm} client=${args.client} mode=${args.apply ? 'APPLY' : 'dry-run'}`);
  if (args.ids) log(`selector: ids = ${args.ids.join(', ')}`);
  if (args.type) log(`selector: document_type = ${args.type}`);

  await withFirmDbClient(async (client) => {
    const rows = await previewDocs(client, {
      firm: args.firm,
      clientId: args.client,
      ids: args.ids,
      type: args.type
    });
    log(`\n${rows.length} document(s) selected:`);
    for (const row of rows) {
      log(`  ${row.id}  type=${row.document_type}  direction=${row.direction || '(none)'}  status=${row.parse_status}  completed_at=${row.parse_completed_at || '(none)'}  ${row.filename}`);
    }
    if (!rows.length) {
      log('Nothing to re-parse. Exiting.');
      return;
    }
    if (!args.apply) {
      log(`\nDry run complete. Re-run with --apply to commit.`);
      return;
    }

    log(`\n— applying —`);
    await client.query('begin');
    try {
      const updated = await applyReparse(client, {
        firm: args.firm,
        ids: rows.map((r) => r.id)
      });
      await client.query('commit');
      log(`reparse queued for ${updated.length} document(s).`);
      log(`The outbox cron will pick them up and dispatch Inngest events`);
      log(`on the next sweep (~5 min in production). To force immediate`);
      log(`processing:`);
      log(`  curl -i -H "Authorization: Bearer \${CRON_SECRET}" \\`);
      log(`    "https://books-app.example/api/donna/firms/documents/parse-cron?task=outbox"`);
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    }
  });
};

main().catch((err) => {
  console.error('[reparse] failed:', err?.message || err);
  process.exit(1);
});
