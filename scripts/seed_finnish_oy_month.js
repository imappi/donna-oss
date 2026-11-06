#!/usr/bin/env node
// One-off: seed a realistic month (June 2026) of bank activity for the
// Aava Digital Oy demo client, PLUS one open owner ask on a "hero" line
// so the WhatsApp owner-loop demo has something to reconcile on camera.
//
// Companion to create_demo_client_finnish_oy.js + seed_chart_of_accounts_finnish_oy.js.
// Independently idempotent (deterministic ids, ON CONFLICT DO UPDATE).
//
// The demo story ("one text, books close"):
//   - 14 lines are already AUTO-RECONCILED by Donna (status settled,
//     coded to a real EUR account) — the two-terminal-states "done" side.
//   - 1 hero line (a Finnair charge) is ON THE OWNER: Donna can't tell
//     the trip's business purpose, so it holds an OPEN client_evidence_
//     request. Answering it over WhatsApp ("asiakastapaaminen
//     Tukholmassa" / a receipt photo) makes the strong coder re-decide
//     with high confidence and AUTO-POST to the Donna ledger — and the
//     owner gets "Got it — booked to Matkakulut."
//
// Preconditions this seed sets so the reply auto-applies (verified
// against firmDb.js resolveClientEvidenceRequestInDb / __shouldApplyReplyRecode):
//   - hero tx: status='needs_client', reconciliation_status='pending',
//     payload.review_state='waiting', account_code=null, a Matkakulut
//     ai_suggestion prior with evidence_required=true.
//   - ask: status='open', transaction_id set, request_payload envelope
//     (evidence_request + amount/currency/date), send_count=0 (the demo's
//     outbound WhatsApp send is the first send).
//
// RUNTIME DEPENDENCY (not seed-controlled): the reply recode calls
// suggestTransactionCoding — the demo env MUST have the OpenAI creds set,
// else the recode returns skipped:'llm_unavailable' and the line stays at
// manual review. The hero + the expected answer are deliberately
// unambiguous so the coder returns confidence:'high', evidence_required:false.
//
// Usage:
//   node scripts/seed_finnish_oy_month.js
//   node scripts/seed_finnish_oy_month.js --reset   # delete this seed's rows first

import crypto from 'node:crypto';

import { DEFAULT_FIRM_ID, withFirmDbClient } from '../server/donna/firmDb.js';

const FIRM_ID = DEFAULT_FIRM_ID;
const CLIENT_ID = 'aava-digital-oy';
const SEED_TAG = 'aava_digital_fi_month_2026_06_v1';
const HERO_ASK_ID = 'cer-aava-hero-finnair-2026-06';

const RESET = process.argv.includes('--reset');

const det = (...parts) =>
  crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
const txnId = (externalId) => `txn-aava-${det(FIRM_ID, CLIENT_ID, externalId)}`;

// A coded prior for a pre-reconciled line. Marked seed-origin so it never
// pollutes model-quality reads ("the model id is part of the receipt").
const codedSuggestion = (account, reason) => ({
  proposed_account: account,
  confidence: 'high',
  evidence_required: false,
  source: 'merchant_rule',
  model: 'seed',
  seed: true,
  reason
});

// June 2026. Amounts are gross (bank lines). `code`/`account` null ⇒ the
// hero line (left uncoded, on the owner). Everything else is pre-coded and
// reads as auto_reconciled via the convergence projection.
const LINES = [
  // ─── Revenue inflows (money_in) ────────────────────────────────────
  { ext: 'AAVA-2026-06-IN-041', date: '2026-06-05', desc: 'SEPA-TILISIIRTO ACME OY VIITE 2026-041',
    money_in: 6150.00, code: '3000', account: 'Palvelumyynti (konsultointi)', reason: 'Asiakasmaksu, myyntilaskun viite' },
  { ext: 'AAVA-2026-06-IN-042', date: '2026-06-18', desc: 'NORDEA SIIRTO KONTIO DESIGN OY 2026-042',
    money_in: 3844.00, code: '3010', account: 'Suunnittelupalvelut', reason: 'Asiakasmaksu suunnitteluprojektista' },
  { ext: 'AAVA-2026-06-IN-044', date: '2026-06-27', desc: 'SEPA ILVES MEDIA OY VIITE 2026-044',
    money_in: 7687.50, code: '3000', account: 'Palvelumyynti (konsultointi)', reason: 'Asiakasmaksu, myyntilaskun viite' },

  // ─── Operating outflows (money_out) ────────────────────────────────
  { ext: 'AAVA-2026-06-OUT-01', date: '2026-06-02', desc: 'REGUS FINLAND OY TOIMITILAVUOKRA',
    money_out: 690.00, code: '6000', account: 'Toimitilavuokra', reason: 'Kuukausittainen toimistovuokra' },
  { ext: 'AAVA-2026-06-OUT-02', date: '2026-06-03', desc: 'GOOGLE WORKSPACE',
    money_out: 14.45, code: '6100', account: 'Ohjelmistot ja SaaS', reason: 'SaaS-työkalu, toistuva veloitus' },

  // ─── HERO LINE — on the owner (open ask) ───────────────────────────
  { ext: 'AAVA-2026-06-OUT-03', date: '2026-06-06', desc: 'FINNAIR OYJ',
    money_out: 248.50, code: null, account: null, hero: true,
    reason: 'Lentoveloitus — todennäköisesti liikematka, mutta tarvitsen matkan tarkoituksen vahvistaakseni vähennyskelpoisuuden.' },

  { ext: 'AAVA-2026-06-OUT-04', date: '2026-06-09', desc: 'RAVINTOLA SAVOY HELSINKI',
    money_out: 128.00, code: '6500', account: 'Edustuskulut', reason: 'Ravintolaveloitus — kirjattu edustuskuluihin' },
  { ext: 'AAVA-2026-06-OUT-05', date: '2026-06-10', desc: 'TELIA FINLAND OYJ',
    money_out: 44.90, code: '6200', account: 'Puhelin ja internet', reason: 'Puhelin- ja liittymälasku, toistuva' },
  { ext: 'AAVA-2026-06-OUT-06', date: '2026-06-12', desc: 'FIGMA INC',
    money_out: 12.00, code: '6100', account: 'Ohjelmistot ja SaaS', reason: 'Suunnitteluohjelmisto, toistuva veloitus' },
  { ext: 'AAVA-2026-06-OUT-07', date: '2026-06-13', desc: 'NORDEA PALVELUMAKSU',
    money_out: 4.90, code: '6900', account: 'Pankki- ja maksuliikennekulut', reason: 'Pankin palvelumaksu' },
  { ext: 'AAVA-2026-06-OUT-08', date: '2026-06-16', desc: 'ADOBE',
    money_out: 59.99, code: '6100', account: 'Ohjelmistot ja SaaS', reason: 'Ohjelmistolisenssi, toistuva veloitus' },
  { ext: 'AAVA-2026-06-OUT-09', date: '2026-06-17', desc: 'ALIHANKINTA JUUSO MAKINEN TMI',
    money_out: 420.00, code: '4000', account: 'Alihankinta ja freelancerit', reason: 'Freelance-alihankinta projektille' },
  { ext: 'AAVA-2026-06-OUT-10', date: '2026-06-20', desc: 'VR-YHTYMA OYJ MATKALIPUT',
    money_out: 89.00, code: '6400', account: 'Matkakulut', reason: 'Junaliput — matkakulu' },
  { ext: 'AAVA-2026-06-OUT-11', date: '2026-06-24', desc: 'LINKEDIN ADS',
    money_out: 250.00, code: '6600', account: 'Markkinointi ja mainonta', reason: 'Markkinointimainonta' },
  { ext: 'AAVA-2026-06-OUT-12', date: '2026-06-30', desc: 'PALKKA KORHONEN ELINA',
    money_out: 2400.00, code: '7000', account: 'Palkat', reason: 'Kuukausipalkka' }
];

// Concise: this becomes {{2}} in the donna_evidence_ask_v1 template, whose
// wrapper already supplies the "reply with a photo / in words / 'not sure'"
// call-to-action — so the question itself stays short and stands alone in
// the portal. "kerro tapaaminen tai asiakas" nudges the owner to give the
// business purpose, which is what drives evidence_required → false on recode.
const HERO_QUESTION =
  'Mihin Finnairin lento 248,50 € (6.6.2026) liittyi? Jos se oli liikematka, kerro tapaaminen tai asiakas.';
const HERO_PERIOD = 'kesäkuu 2026'; // {{1}} in the ask template

const buildTxnPayload = (line) => {
  const base = {
    external_transaction_id: line.ext,
    merchant: line.desc,
    seed: SEED_TAG,
    currency: 'EUR'
  };
  if (line.hero) {
    // On the owner: waiting review_state, a Matkakulut prior that FLAGS
    // evidence_required so the ask is honest, no applied coding.
    return {
      ...base,
      ai_suggestion: {
        proposed_account: '6400 Matkakulut',
        confidence: 'medium',
        evidence_required: true,
        source: 'llm',
        model: 'seed',
        seed: true,
        reason: line.reason
      }
    };
  }
  return {
    ...base,
    ai_suggestion_status: 'auto_applied',
    ai_suggestion: codedSuggestion(`${line.code} ${line.account}`, line.reason)
  };
};

const main = async () => {
  await withFirmDbClient(async (client) => {
    const clientCheck = await client.query('select id from clients where firm_id = $1 and id = $2', [FIRM_ID, CLIENT_ID]);
    if (!clientCheck.rows.length) {
      console.error(`[aava-month] FAILED: client ${CLIENT_ID} not found. Run create_demo_client_finnish_oy.js first.`);
      process.exit(2);
    }

    if (RESET) {
      await client.query('delete from client_evidence_requests where firm_id = $1 and client_id = $2 and id = $3', [FIRM_ID, CLIENT_ID, HERO_ASK_ID]);
      const del = await client.query(
        `delete from transactions where firm_id = $1 and client_id = $2 and payload->>'seed' = $3`,
        [FIRM_ID, CLIENT_ID, SEED_TAG]
      );
      console.log(`[aava-month] --reset: removed ${del.rowCount} seeded transactions + hero ask.`);
    }

    let inserted = 0;
    let heroTxnId = null;
    for (const line of LINES) {
      const id = txnId(line.ext);
      if (line.hero) heroTxnId = id;
      const moneyIn = line.money_in || 0;
      const moneyOut = line.money_out || 0;
      const direction = moneyIn > 0 ? 'money_in' : 'money_out';
      const status = line.hero ? 'needs_client' : 'categorized';
      const reconStatus = line.hero ? 'pending' : 'auto_reconciled';
      const result = await client.query(
        `insert into transactions (
           id, firm_id, client_id, transaction_date, description, money_in, money_out, currency, status,
           external_transaction_id, raw_description, cleaned_description, direction, category, account_code,
           confidence_score, reconciliation_status, coding_state, payload
         )
         values ($1,$2,$3,$4,$5,$6,$7,'EUR',$8,$9,$5,$5,$10,$11,$12,$13,$14,$16,$15::jsonb)
         on conflict (id) do update set
           transaction_date = excluded.transaction_date,
           description = excluded.description,
           money_in = excluded.money_in,
           money_out = excluded.money_out,
           status = excluded.status,
           direction = excluded.direction,
           category = excluded.category,
           account_code = excluded.account_code,
           confidence_score = excluded.confidence_score,
           reconciliation_status = excluded.reconciliation_status,
           coding_state = excluded.coding_state,
           payload = excluded.payload,
           updated_at = now()
         returning xmax = 0 as inserted`,
        [
          id, FIRM_ID, CLIENT_ID, line.date, line.desc, moneyIn, moneyOut, status,
          line.ext, direction,
          line.hero ? null : line.account,     // category
          line.hero ? null : line.code,        // account_code
          line.hero ? null : 0.97,             // confidence_score
          reconStatus,
          JSON.stringify(buildTxnPayload(line)),
          line.hero ? 'asked' : 'applied'   // coding_state (RT-16)
        ]
      );
      if (result.rows[0]?.inserted) inserted += 1;
    }

    // The hero open ask (client_evidence_requests). Mirrors the real
    // minter's request_payload envelope so resolveClientEvidenceRequestInDb
    // re-codes and auto-posts on reply.
    const amount = -248.50; // money_out is signed negative in the envelope
    const dueAt = '2026-07-06T00:00:00.000Z';
    const requestPayload = {
      ask_batch_id: 'demo-aava-2026-06',
      period: HERO_PERIOD,        // {{1}} in donna_evidence_ask_v1 (else falls back to 'this period')
      transaction_id: heroTxnId,
      transaction_description: 'FINNAIR OYJ',
      amount,
      currency: 'EUR',
      date: '2026-06-06',
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
         status = 'open',
         transaction_id = excluded.transaction_id,
         question = excluded.question,
         request_payload = excluded.request_payload,
         updated_at = now()
       returning xmax = 0 as inserted`,
      [HERO_ASK_ID, FIRM_ID, CLIENT_ID, heroTxnId, HERO_QUESTION, JSON.stringify(requestPayload), dueAt, 'seed:aava-demo']
    );

    console.log(`[aava-month] transactions: ${inserted} inserted / ${LINES.length} total (1 hero on-owner, ${LINES.length - 1} auto-reconciled).`);
    console.log(`[aava-month] hero ask ${HERO_ASK_ID} ${askResult.rows[0]?.inserted ? 'inserted' : 'refreshed'} (status=open) on txn ${heroTxnId}.`);
    console.log('[aava-month] Demo ready. On camera: node scripts/send_finnish_oy_hero_ask_whatsapp.js');
  });
};

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[aava-month] FAILED', err);
    process.exit(1);
  }
);
