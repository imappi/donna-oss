#!/usr/bin/env node
// On-camera trigger: send the Honeybee Hills hero evidence ask (the Delta Air
// Lines line) to the owner over TELEGRAM. Same delivery path as the ask-batch
// send (deliverTelegramEvidenceAsksAfterSend, firmDb.js), so the outbound is
// recorded in the delivery ledger and the owner's reply anchors to it. Free-form
// text — no template review, no Meta dependency, nothing to wait on.
//
// Preconditions (Kari-side, off-camera):
//   - TELEGRAM_ENABLED=true and honeybee-hills-apiary in TELEGRAM_CLIENTS.
//   - TELEGRAM_BOT_TOKEN set; webhook registered (set_telegram_webhook.js).
//   - Owner's Telegram chat bound to this client (deep link or direct-bind).
//   - The hero ask seeded (cer-honeybee-hero-delta-2026-06, already in prod).
//
// Usage:
//   node --env-file=.env.demo scripts/send_honeybee_hero_ask_telegram.js

import { DEFAULT_FIRM_ID, withFirmDbClient, deliverTelegramEvidenceAsksAfterSend } from '../server/donna/firmDb.js';

const FIRM_ID = DEFAULT_FIRM_ID;
const CLIENT_ID = 'honeybee-hills-apiary';
const HERO_ASK_ID = 'cer-honeybee-hero-delta-2026-06';

const main = async () => {
  const result = await withFirmDbClient((client) =>
    deliverTelegramEvidenceAsksAfterSend({ client, firmId: FIRM_ID, clientId: CLIENT_ID, evidenceRequestIds: [HERO_ASK_ID] })
  );

  if (result?.skipped) {
    console.error(`[honeybee-telegram] SKIPPED (${result.reason}).`);
    if (result.reason === 'flag_off') console.error('  → Set TELEGRAM_ENABLED=true and add ' + CLIENT_ID + ' to TELEGRAM_CLIENTS, then redeploy.');
    if (result.reason === 'unbound') console.error('  → No active Telegram binding. Bind the owner chat first (bind_telegram_chat_directly.js).');
    process.exit(1);
  }

  console.log(`[honeybee-telegram] hero ask ${HERO_ASK_ID} dispatched to the owner over Telegram.`);
  console.log('[honeybee-telegram] Next beat: owner replies "beekeeping supply conference in Sacramento" → books to Travel.');
  console.log('[honeybee-telegram] (If it looks stuck, run telegram_demo_doctor.js — it reads the delivery ledger for the real send result.)');
};

main().then(() => process.exit(0), (err) => { console.error('[honeybee-telegram] FAILED', err); process.exit(1); });
