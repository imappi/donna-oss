#!/usr/bin/env node
// On-camera trigger: send the Aava Digital Oy hero evidence ask (the
// Finnair line) to the owner over WhatsApp, so the demo's beat 1 fires
// on cue. Wraps the same delivery path the ask-batch send uses
// (deliverWhatsAppEvidenceAsksAfterSend, firmDb.js), so the outbound is
// recorded in the message delivery ledger and the owner's reply anchors
// to it.
//
// Preconditions (all Kari-side, off-camera):
//   - WHATSAPP_ENABLED=true and the client id in WHATSAPP_CLIENTS.
//   - Owner's WhatsApp bound to this client (POST /whatsapp/connect-token
//     → open the wa.me link on the phone → send "connect <token>").
//   - The demo data seeded (seed_finnish_oy_month.js).
//   - The donna_evidence_ask_v1 template approved by Meta.
//
// This is the ONLY outbound this script performs — a single ask to a
// single bound owner. It honours the same WHATSAPP_ENABLED + allowlist
// gate as production (returns skipped:'flag_off' / 'unbound' otherwise).
//
// Usage:
//   node scripts/send_finnish_oy_hero_ask_whatsapp.js

import { DEFAULT_FIRM_ID, withFirmDbClient, deliverWhatsAppEvidenceAsksAfterSend } from '../server/donna/firmDb.js';

const FIRM_ID = DEFAULT_FIRM_ID;
const CLIENT_ID = 'aava-digital-oy';
const HERO_ASK_ID = 'cer-aava-hero-finnair-2026-06';

const main = async () => {
  const result = await withFirmDbClient((client) =>
    deliverWhatsAppEvidenceAsksAfterSend({
      client,
      firmId: FIRM_ID,
      clientId: CLIENT_ID,
      evidenceRequestIds: [HERO_ASK_ID]
    })
  );

  if (result?.skipped) {
    console.error(`[aava-send] SKIPPED (${result.reason}).`);
    if (result.reason === 'flag_off') {
      console.error('  → Set WHATSAPP_ENABLED=true and add ' + CLIENT_ID + ' to WHATSAPP_CLIENTS, then redeploy.');
    }
    if (result.reason === 'unbound') {
      console.error('  → No active WhatsApp binding. Mint a connect-token and bind the owner phone first.');
    }
    process.exit(1);
  }

  console.log(`[aava-send] hero ask ${HERO_ASK_ID} dispatched to the owner over WhatsApp.`);
  console.log('[aava-send] Next beat: owner replies "asiakastapaaminen Tukholmassa" (or sends a receipt photo).');
};

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[aava-send] FAILED', err);
    process.exit(1);
  }
);
