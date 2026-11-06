#!/usr/bin/env node
// One-off: add the Honeybee Hills Apiary LLC demo client to the firm
// database. Additive and idempotent — re-runs UPSERT the client row
// without touching any other seed data. Safe to run against any
// environment that has the firm DB schema applied.
//
// Created on request to have a clean US-jurisdiction client to test
// mass uploads (statements, invoices, receipts) and the
// categorisation pipeline against. The canonical seed is SG-defaulted
// so we intentionally do NOT modify firmSeeds.js / mockData.js — this
// script is the canonical "add Honeybee Hills" path so a db:seed
// reset can rerun it cleanly.
//
// Usage:
//   node scripts/create_demo_client_honeybee_hills.js
//
// Idempotency:
//   - clients.id = 'honeybee-hills-apiary' is the natural key. ON
//     CONFLICT (id) DO UPDATE keeps fields in sync if you edit this
//     script and rerun.
//   - The firm row is also upserted in case you're pointing at a
//     fresh DB (the seed runner already does this, but we don't
//     assume it has been run).

import { DEFAULT_FIRM_ID, withFirmDbClient } from '../server/donna/firmDb.js';

const CLIENT_ID = 'honeybee-hills-apiary';
const COMPANY_NAME = 'Honeybee Hills Apiary LLC';

// Profile blob mirrors the shape mockData.js firmClientProfile uses
// for the SG demo clients, with US-appropriate fields where the SG
// equivalents don't apply (UEN, Bizfile, AML/CDD per MAS). Anything
// the FE doesn't recognise is harmless — the snapshot just hands it
// back as opaque JSON.
const CLIENT_PROFILE = {
  id: CLIENT_ID,
  companyName: COMPANY_NAME,
  legalName: COMPANY_NAME,
  jurisdiction: 'US',
  jurisdictionDetail: 'Arkansas, United States',
  defaultCurrency: 'USD',
  entityType: 'Limited liability company',
  stage: 'Onboarding active',
  nextDeadline: 'First reconciliation pending — upload statements to begin.',
  primaryContact: {
    name: 'Ruth Calloway',
    role: 'Owner',
    email: null
  },
  registeredAddress: {
    line1: '4820 County Road 217',
    city: 'Prairie Grove',
    state: 'AR',
    postalCode: '72753',
    country: 'US'
  },
  intakeChecklist: [
    {
      id: 'company-basics',
      label: 'Company basics',
      detail: 'LLC name and Arkansas registered address captured.',
      status: 'complete'
    },
    {
      id: 'principal-owner',
      label: 'Principal owner',
      detail: 'Ruth Calloway — single-member LLC.',
      status: 'complete'
    },
    {
      id: 'bank-statements',
      label: 'Bank statements',
      detail: 'Upload monthly statements via the Documents tab.',
      status: 'pending'
    },
    {
      id: 'invoices-receipts',
      label: 'Invoices & receipts',
      detail: 'Drop AR invoices, AP bills, and receipts into the upload tray.',
      status: 'pending'
    },
    {
      id: 'chart-of-accounts',
      label: 'Chart of accounts',
      detail: 'US-flavoured CoA not yet wired — Donna will fall back to merchant-pattern categorisation.',
      status: 'pending'
    }
  ],
  notes: [
    'US-jurisdiction client added for mass-upload + categorisation testing.',
    'Default Donna seed targets SG; this client exercises the parsing pipeline against US source documents.'
  ]
};

const main = async () => {
  await withFirmDbClient(async (client) => {
    const queryFirmDb = (text, params = []) => client.query(text, params);

    // Make sure the firm row exists. The seed runner does this too,
    // but a script that depends on "I assume db:seed ran" is brittle.
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
        null,                                    // no UEN — US LLC
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
      console.log(`[honeybee-hills] inserted client ${CLIENT_ID} (${COMPANY_NAME}) under firm ${DEFAULT_FIRM_ID}.`);
    } else {
      console.log(`[honeybee-hills] updated existing client ${CLIENT_ID}; profile refreshed.`);
    }
    console.log('[honeybee-hills] ready for uploads. Open the firm console and select the client.');
  });
};

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[honeybee-hills] FAILED', err);
    process.exit(1);
  }
);
