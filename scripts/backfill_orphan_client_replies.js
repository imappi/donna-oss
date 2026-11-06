#!/usr/bin/env node
// Backfill `client_reply_received` system messages for client portal
// replies resolved BEFORE PR #142 wired the live bridge. Idempotent
// by design — re-runs are safe (presence check matches the same
// `payload.evidence_request_id` key the live writer uses).
//
// Usage:
//   node scripts/backfill_orphan_client_replies.js                 # dry-run, all firms
//   node scripts/backfill_orphan_client_replies.js --apply         # actually insert
//   node scripts/backfill_orphan_client_replies.js --firm-id=foo   # scope to one firm
//   node scripts/backfill_orphan_client_replies.js --client-id=bar # scope to one client
//
// Default is dry-run. Prints counts + a per-row sample so an operator
// can sanity-check before flipping --apply. No FE/UI changes.

import { withFirmDbClient } from '../server/donna/firmDb.js';
import {
  buildClientReplyChatMessage,
  CANDIDATE_REQUESTS_SQL,
  EXISTING_BRIDGE_ROW_SQL,
  INSERT_CHAT_MESSAGE_SQL,
  TRANSACTION_EXISTS_SQL
} from '../server/donna/orphanReplyBackfill.js';

const parseFlags = (argv) => {
  const flags = { apply: false, firmId: null, clientId: null };
  for (const arg of argv.slice(2)) {
    if (arg === '--apply') flags.apply = true;
    else if (arg.startsWith('--firm-id=')) flags.firmId = arg.slice('--firm-id='.length) || null;
    else if (arg.startsWith('--client-id=')) flags.clientId = arg.slice('--client-id='.length) || null;
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/backfill_orphan_client_replies.js [--apply] [--firm-id=ID] [--client-id=ID]');
      process.exit(0);
    } else {
      console.error(`Unknown flag: ${arg}`);
      process.exit(2);
    }
  }
  return flags;
};

const main = async () => {
  const flags = parseFlags(process.argv);
  const mode = flags.apply ? 'APPLY' : 'DRY-RUN';
  console.log(`[orphan-reply-backfill] mode=${mode} firmId=${flags.firmId || '*'} clientId=${flags.clientId || '*'}`);

  await withFirmDbClient(async (client) => {
    const candidates = await client.query(CANDIDATE_REQUESTS_SQL, [flags.firmId, flags.clientId]);
    console.log(`[orphan-reply-backfill] candidates=${candidates.rows.length}`);

    let alreadyBridged = 0;
    let missingTransaction = 0;
    let ineligible = 0;
    let queued = 0;
    let inserted = 0;
    const samples = [];

    for (const row of candidates.rows) {
      const msg = buildClientReplyChatMessage(row);
      if (!msg) {
        ineligible += 1;
        continue;
      }

      const existing = await client.query(EXISTING_BRIDGE_ROW_SQL, [
        msg.firm_id,
        msg.client_id,
        msg.transaction_id,
        row.id
      ]);
      if (existing.rows.length) {
        alreadyBridged += 1;
        continue;
      }

      const txCheck = await client.query(TRANSACTION_EXISTS_SQL, [
        msg.firm_id,
        msg.client_id,
        msg.transaction_id
      ]);
      if (!txCheck.rows.length) {
        missingTransaction += 1;
        continue;
      }

      queued += 1;
      if (samples.length < 5) {
        samples.push({
          evidence_request_id: row.id,
          firm_id: msg.firm_id,
          client_id: msg.client_id,
          transaction_id: msg.transaction_id,
          content_preview: msg.content.slice(0, 80),
          payload_kind: msg.payload.kind,
          backfill_created_at: msg.created_at
        });
      }

      if (flags.apply) {
        const insert = await client.query(INSERT_CHAT_MESSAGE_SQL, [
          msg.id,
          msg.firm_id,
          msg.client_id,
          msg.transaction_id,
          msg.role,
          msg.content,
          JSON.stringify(msg.payload),
          msg.actor_type,
          msg.created_at
        ]);
        if (insert.rows.length) inserted += 1;
      }
    }

    console.log(`[orphan-reply-backfill] already_bridged=${alreadyBridged}`);
    console.log(`[orphan-reply-backfill] missing_transaction=${missingTransaction}`);
    console.log(`[orphan-reply-backfill] ineligible=${ineligible}`);
    console.log(`[orphan-reply-backfill] queued_for_backfill=${queued}`);
    if (flags.apply) {
      console.log(`[orphan-reply-backfill] inserted=${inserted}`);
    } else {
      console.log('[orphan-reply-backfill] dry-run — pass --apply to insert.');
    }
    if (samples.length) {
      console.log('[orphan-reply-backfill] sample:');
      for (const sample of samples) {
        console.log(`  - ${JSON.stringify(sample)}`);
      }
    }
  });
};

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[orphan-reply-backfill] FAILED', err);
    process.exit(1);
  }
);
