#!/usr/bin/env node
// One-off: add a single "hero" bank line + one OPEN client_evidence_request
// to the existing Honeybee Hills Apiary LLC demo client, so the WhatsApp
// owner-loop demo has a guaranteed-to-fire beat in English/USD — without
// waiting on the Finnish template's Meta review.
//
// Honeybee already has a client row, a US CoA, and (Kari's) uploaded
// content. This script does NOT touch any of that — it ADDS one clean,
// unambiguous line we control (a Delta Air Lines charge) and asks the
// owner its business purpose, so answering over WhatsApp re-codes to
// Travel with high confidence and auto-posts. (An arbitrary existing
// uncategorized line is not guaranteed to come back confidence:'high';
// this one is chosen so it will.)
//
// Companion to create_demo_client_honeybee_hills.js +
// seed_chart_of_accounts_honeybee_hills.js (run those first). Idempotent:
// deterministic ids, ON CONFLICT DO UPDATE.
//
// Preconditions this sets (verified against firmDb.js
// resolveClientEvidenceRequestInDb / __shouldApplyReplyRecode):
//   - hero tx: status='needs_client', reconciliation_status='pending',
//     payload.review_state='waiting', account_code=null, a Travel
//     ai_suggestion prior with evidence_required=true.
//   - ask: status='open', transaction_id set, request_payload envelope.
//
// RUNTIME DEPENDENCY (not seed-controlled): the reply recode calls
// suggestTransactionCoding — the demo env MUST have the OpenAI creds set.
//
// Usage:
//   node scripts/seed_honeybee_hero_ask.js
//   node scripts/seed_honeybee_hero_ask.js --reset   # remove this hero + ask

import crypto from 'node:crypto';

import { DEFAULT_FIRM_ID, withFirmDbClient } from '../server/donna/firmDb.js';

const FIRM_ID = DEFAULT_FIRM_ID;
const CLIENT_ID = 'honeybee-hills-apiary';
const SEED_TAG = 'honeybee_hero_ask_v1';
const HERO_ASK_ID = 'cer-honeybee-hero-delta-2026-06';
const HERO_EXT = 'HONEYBEE-2026-06-HERO-DELTA';

const RESET = process.argv.includes('--reset');

const det = (...parts) => crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
const HERO_TXN_ID = `txn-honeybee-${det(FIRM_ID, CLIENT_ID, HERO_EXT)}`;

const HERO_DESC = 'DELTA AIR LINES';
const HERO_AMOUNT = 214.60;          // money_out
const HERO_DATE = '2026-06-12';
const HERO_PERIOD = 'June 2026';     // {{1}} in donna_evidence_ask_v1
// Concise: the template wrapper supplies the "reply with a photo / in words /
// 'not sure'" CTA, so {{2}} stays short and stands alone in the portal.
const HERO_QUESTION =
  'What was the $214.60 Delta Air Lines charge (Jun 12) for? If it was a business trip, tell me the event or destination and I’ll book it to Travel.';

const main = async () => {
  await withFirmDbClient(async (client) => {
    const clientCheck = await client.query('select id from clients where firm_id = $1 and id = $2', [FIRM_ID, CLIENT_ID]);
    if (!clientCheck.rows.length) {
      console.error(`[honeybee-hero] FAILED: client ${CLIENT_ID} not found. Run create_demo_client_honeybee_hills.js first.`);
      process.exit(2);
    }

    if (RESET) {
      await client.query('delete from client_evidence_requests where firm_id = $1 and client_id = $2 and id = $3', [FIRM_ID, CLIENT_ID, HERO_ASK_ID]);
      const del = await client.query('delete from transactions where firm_id = $1 and client_id = $2 and id = $3', [FIRM_ID, CLIENT_ID, HERO_TXN_ID]);
      console.log(`[honeybee-hero] --reset: removed ${del.rowCount} hero txn + ask.`);
      return;
    }

    const txnPayload = {
      external_transaction_id: HERO_EXT,
      merchant: HERO_DESC,
      currency: 'USD',
      seed: SEED_TAG,
      ai_suggestion: {
        proposed_account: '6060 Travel',
        confidence: 'medium',
        evidence_required: true,
        source: 'llm',
        model: 'seed',
        seed: true,
        reason: 'Airline charge — likely business travel, but I need the trip’s business purpose to confirm deductibility.'
      }
    };

    await client.query(
      `insert into transactions (
         id, firm_id, client_id, transaction_date, description, money_in, money_out, currency, status,
         external_transaction_id, raw_description, cleaned_description, direction, category, account_code,
         confidence_score, reconciliation_status, coding_state, payload
       )
       values ($1,$2,$3,$4,$5,0,$6,'USD','needs_client',$7,$5,$5,'money_out',null,null,null,'pending','asked',$8::jsonb)
       on conflict (id) do update set
         transaction_date = excluded.transaction_date,
         description = excluded.description,
         money_out = excluded.money_out,
         status = excluded.status,
         direction = excluded.direction,
         category = null, account_code = null, confidence_score = null,
         reconciliation_status = 'pending',
         coding_state = 'asked',
         payload = excluded.payload,
         updated_at = now()`,
      [HERO_TXN_ID, FIRM_ID, CLIENT_ID, HERO_DATE, HERO_DESC, HERO_AMOUNT, HERO_EXT, JSON.stringify(txnPayload)]
    );

    const dueAt = '2026-07-06T00:00:00.000Z';
    const requestPayload = {
      ask_batch_id: 'demo-honeybee-2026-06',
      period: HERO_PERIOD,
      transaction_id: HERO_TXN_ID,
      transaction_description: HERO_DESC,
      amount: -HERO_AMOUNT,
      currency: 'USD',
      date: HERO_DATE,
      seed: SEED_TAG,
      evidence_request: {
        id: HERO_ASK_ID,
        status: 'open',
        evidence_type: 'supporting_document',
        question: HERO_QUESTION,
        sent_at: null,
        first_sent_at: null,
        send_count: 0,
        due_at: dueAt
      }
    };
    const askResult = await client.query(
      `insert into client_evidence_requests (
         id, firm_id, client_id, transaction_id, status, evidence_type, question,
         request_payload, send_count, due_at, created_by
       )
       values ($1,$2,$3,$4,'open','supporting_document',$5,$6::jsonb,0,$7::timestamptz,$8)
       on conflict (id) do update set
         status = 'open', transaction_id = excluded.transaction_id, question = excluded.question,
         request_payload = excluded.request_payload, updated_at = now()
       returning xmax = 0 as inserted`,
      [HERO_ASK_ID, FIRM_ID, CLIENT_ID, HERO_TXN_ID, HERO_QUESTION, JSON.stringify(requestPayload), dueAt, 'seed:honeybee-demo']
    );

    console.log(`[honeybee-hero] hero txn ${HERO_TXN_ID} ($${HERO_AMOUNT} ${HERO_DESC}) on-owner.`);
    console.log(`[honeybee-hero] hero ask ${HERO_ASK_ID} ${askResult.rows[0]?.inserted ? 'inserted' : 'refreshed'} (status=open).`);
    console.log('[honeybee-hero] Demo ready. Send over WhatsApp via the client-ask-batch / delivery path for this client.');
  });
};

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[honeybee-hero] FAILED', err);
    process.exit(1);
  }
);
