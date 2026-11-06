#!/usr/bin/env node
// One-off: add the "Aava Digital Oy" Finnish demo client to the firm
// database. Additive and idempotent — re-runs UPSERT the client row
// without touching any other seed data.
//
// Created for the WhatsApp owner-loop demo aimed at a Finnish audience.
// The canonical Donna seed is SG-defaulted and the other demo client
// (Honeybee Hills) is US/USD — neither reads as real to Finnish
// viewers. Aava Digital Oy is a Helsinki digital design & consulting
// service business (squarely inside the narrow ICP: single-entity,
// service, FI jurisdiction, EUR, accrual-or-cash), so every seeded
// line is answerable to a clean account and the demo's auto-reconcile
// beat lands.
//
// Companion scripts (run in order):
//   1. node scripts/create_demo_client_finnish_oy.js
//   2. node scripts/seed_chart_of_accounts_finnish_oy.js
//   3. node scripts/seed_finnish_oy_month.js
//   4. node scripts/send_finnish_oy_hero_ask_whatsapp.js   (on-camera: fire the ask)
//
// Idempotency:
//   - clients.id = 'aava-digital-oy' is the natural key. ON CONFLICT
//     (id) DO UPDATE keeps fields in sync if you edit this script and
//     rerun.
//   - The firm row is also upserted in case you're pointing at a fresh
//     DB.
//
// The client id printed at the end is what goes into the Vercel
// WHATSAPP_CLIENTS allowlist.

import { DEFAULT_FIRM_ID, withFirmDbClient } from '../server/donna/firmDb.js';

const CLIENT_ID = 'aava-digital-oy';
const COMPANY_NAME = 'Aava Digital Oy';
// Y-tunnus (Finnish business ID) with a VALID check digit: base 2896341,
// weights [7,9,10,5,8,4,2] → sum 248, 248 mod 11 = 6, 11-6 = 5.
const BUSINESS_ID = '2896341-5';

// Profile blob mirrors the shape mockData.js firmClientProfile uses,
// with FI-appropriate fields (Y-tunnus, ALV number, Osakeyhtiö entity,
// Finnish registered address). Anything the FE doesn't recognise is
// handed back as opaque JSON.
const CLIENT_PROFILE = {
  id: CLIENT_ID,
  companyName: COMPANY_NAME,
  legalName: COMPANY_NAME,
  jurisdiction: 'FI',
  jurisdictionDetail: 'Helsinki, Suomi / Finland',
  defaultCurrency: 'EUR',
  entityType: 'Osakeyhtiö (Oy)',
  businessId: BUSINESS_ID,            // Y-tunnus
  vatNumber: 'FI28963415',            // ALV-numero (Y-tunnus without the dash, FI-prefixed)
  vatRegistered: true,
  accountingBasis: 'accrual',         // suoriteperuste
  fiscalYearEnd: '12-31',
  stage: 'Onboarding active',
  nextDeadline: 'First reconciliation pending — upload statements to begin.',
  primaryContact: {
    name: 'Elina Korhonen',
    role: 'Toimitusjohtaja / Owner',
    email: null
  },
  registeredAddress: {
    line1: 'Eerikinkatu 27',
    city: 'Helsinki',
    postalCode: '00180',
    country: 'FI'
  },
  bank: {
    name: 'Nordea',
    // Canonical valid FI IBAN example (checksum-valid); demo only.
    iban: 'FI21 1234 5600 0007 85',
    bic: 'NDEAFIHH'
  },
  businessDescription:
    'Digitaalisen suunnittelun ja konsultoinnin palveluyritys (digital design & consulting).',
  intakeChecklist: [
    {
      id: 'company-basics',
      label: 'Yrityksen perustiedot / Company basics',
      detail: 'Oy name, Y-tunnus, and Helsinki registered address captured.',
      status: 'complete'
    },
    {
      id: 'principal-owner',
      label: 'Omistaja / Principal owner',
      detail: 'Elina Korhonen — single-shareholder Oy.',
      status: 'complete'
    },
    {
      id: 'alv-registration',
      label: 'ALV-rekisteröinti / VAT registration',
      detail: 'Registered for ALV (VAT). Standard rate 25,5 %.',
      status: 'complete'
    },
    {
      id: 'bank-statements',
      label: 'Tiliote / Bank statements',
      detail: 'Upload monthly Nordea statements via the Documents tab.',
      status: 'pending'
    },
    {
      id: 'chart-of-accounts',
      label: 'Tilikartta / Chart of accounts',
      detail: 'Finnish EUR CoA seeded by seed_chart_of_accounts_finnish_oy.js.',
      status: 'pending'
    }
  ],
  notes: [
    'FI-jurisdiction service-consultancy client added for the WhatsApp owner-loop demo.',
    'Standard ALV 25,5 % (since 2024-09-01). EUR. Single-entity, accrual basis.'
  ]
};

const main = async () => {
  await withFirmDbClient(async (client) => {
    const queryFirmDb = (text, params = []) => client.query(text, params);

    // Make sure the firm row exists (the seed runner does this too, but
    // a script that assumes db:seed ran is brittle).
    await queryFirmDb(
      `insert into firms (id, name, slug, jurisdiction, default_currency, metadata)
       values ($1, $2, $3, $4, $5, $6::jsonb)
       on conflict (id) do nothing`,
      [
        DEFAULT_FIRM_ID,
        'Donna Firms Demo',
        'donna-demo',
        'SG',
        'SGD',
        JSON.stringify({ seed: true })
      ]
    );

    const result = await queryFirmDb(
      `insert into clients
         (id, firm_id, company_name, uen, entity_type, incorporation_date,
          stage, next_deadline, status, profile)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       on conflict (id) do update set
         company_name = excluded.company_name,
         uen = excluded.uen,
         entity_type = excluded.entity_type,
         stage = excluded.stage,
         next_deadline = excluded.next_deadline,
         status = excluded.status,
         profile = excluded.profile,
         updated_at = now()
       returning xmax = 0 as inserted`,
      [
        CLIENT_ID,
        DEFAULT_FIRM_ID,
        COMPANY_NAME,
        BUSINESS_ID,                             // uen column holds the Y-tunnus for FI
        CLIENT_PROFILE.entityType,
        null,                                    // incorporation_date free-form, skipped
        CLIENT_PROFILE.stage,
        CLIENT_PROFILE.nextDeadline,
        'active',
        JSON.stringify(CLIENT_PROFILE)
      ]
    );

    const inserted = result.rows[0]?.inserted;
    if (inserted) {
      console.log(`[aava-digital] inserted client ${CLIENT_ID} (${COMPANY_NAME}) under firm ${DEFAULT_FIRM_ID}.`);
    } else {
      console.log(`[aava-digital] updated existing client ${CLIENT_ID}; profile refreshed.`);
    }
    console.log('[aava-digital] Next: node scripts/seed_chart_of_accounts_finnish_oy.js');
    console.log(`[aava-digital] Put this in the Vercel WHATSAPP_CLIENTS allowlist: ${CLIENT_ID}`);
  });
};

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[aava-digital] FAILED', err);
    process.exit(1);
  }
);
