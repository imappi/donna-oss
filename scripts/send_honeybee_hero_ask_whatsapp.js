#!/usr/bin/env node
// On-camera trigger: send the Honeybee Hills hero evidence ask (the Delta
// Air Lines line) to the owner over WhatsApp. Same delivery path as the
// ask-batch send (deliverWhatsAppEvidenceAsksAfterSend, firmDb.js), so the
// outbound is recorded in the delivery ledger and the owner's reply anchors
// to it. English template (donna_evidence_ask_v1) — already Meta-approved,
// so this demo needs no Finnish-template wait.
//
// Preconditions (Kari-side, off-camera):
//   - WHATSAPP_ENABLED=true and honeybee-hills-apiary in WHATSAPP_CLIENTS.
//   - Owner's WhatsApp bound to this client (connect-token flow).
//   - The hero seeded (seed_honeybee_hero_ask.js).
//
// Usage:
//   node scripts/send_honeybee_hero_ask_whatsapp.js

import { DEFAULT_FIRM_ID, withFirmDbClient, deliverWhatsAppEvidenceAsksAfterSend } from '../server/donna/firmDb.js';

const FIRM_ID = DEFAULT_FIRM_ID;
const CLIENT_ID = 'honeybee-hills-apiary';
const HERO_ASK_ID = 'cer-honeybee-hero-delta-2026-06';

const main = async () => {
  const result = await withFirmDbClient((client) =>
    deliverWhatsAppEvidenceAsksAfterSend({ client, firmId: FIRM_ID, clientId: CLIENT_ID, evidenceRequestIds: [HERO_ASK_ID] })
  );

  if (result?.skipped) {
    console.error(`[honeybee-send] SKIPPED (${result.reason}).`);
    if (result.reason === 'flag_off') console.error('  → Set WHATSAPP_ENABLED=true and add ' + CLIENT_ID + ' to WHATSAPP_CLIENTS, then redeploy.');
    if (result.reason === 'unbound') console.error('  → No active WhatsApp binding. Bind the owner phone first.');
    process.exit(1);
  }

  console.log(`[honeybee-send] hero ask ${HERO_ASK_ID} dispatched to the owner over WhatsApp.`);
  console.log('[honeybee-send] Next beat: owner replies "beekeeping supply conference in Sacramento" (or sends a receipt photo).');
};

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[honeybee-send] FAILED', err);
    process.exit(1);
  }
);
