#!/usr/bin/env node
// Seed 4 test clients from bank statement PDFs.
// Idempotent — ON CONFLICT upserts. Safe to re-run.
//
// Usage:
//   DATABASE_URL="..." node scripts/seed_test_clients.js

import crypto from 'node:crypto';
import { DEFAULT_FIRM_ID, withFirmDbClient } from '../server/donna/firmDb.js';

const txId = (clientId, idx) => `${clientId}-tx-${String(idx).padStart(4, '0')}`;

const seedClient = async (client, { clientId, companyName, profile, transactions }) => {
  await client.query(
    `insert into firms (id, name, slug, jurisdiction, default_currency, metadata)
     values ($1, $2, $3, $4, $5, $6::jsonb)
     on conflict (id) do nothing`,
    [DEFAULT_FIRM_ID, 'Donna Firms Demo', 'donna-demo', 'SG', 'SGD', '{"seed":true}']
  );

  const res = await client.query(
    `insert into clients
       (id, firm_id, company_name, uen, entity_type, incorporation_date,
        stage, next_deadline, status, profile)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     on conflict (id) do update set
       company_name = excluded.company_name,
       profile = excluded.profile,
       updated_at = now()
     returning xmax = 0 as inserted`,
    [
      clientId, DEFAULT_FIRM_ID, companyName, null,
      profile.entityType || 'Company', null,
      'Onboarding active', 'Upload documents to begin.',
      'active', JSON.stringify(profile)
    ]
  );
  const verb = res.rows[0]?.inserted ? 'created' : 'updated';
  console.log(`  ${verb} client ${clientId}`);

  let inserted = 0;
  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];
    const id = txId(clientId, i);
    const r = await client.query(
      `insert into transactions
         (id, firm_id, client_id, transaction_date, description, raw_description,
          money_in, money_out, currency, status, payload)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
       on conflict (id) do update set
         description = excluded.description,
         money_in = excluded.money_in,
         money_out = excluded.money_out,
         updated_at = now()
       returning xmax = 0 as was_insert`,
      [
        id, DEFAULT_FIRM_ID, clientId,
        tx.date, tx.description, tx.description,
        tx.moneyIn || 0, tx.moneyOut || 0,
        tx.currency || 'USD', 'needs_review',
        JSON.stringify({ source: 'seed_test_client', source_line: tx.description })
      ]
    );
    if (r.rows[0]?.was_insert) inserted++;
  }
  console.log(`  ${inserted} new transactions (${transactions.length} total)`);
};

// ─── Client 1: Alex Morgan (UK personal, GBP) ───────────────────

const ALEX_MORGAN = {
  clientId: 'alex-morgan-personal',
  companyName: 'Alex Morgan',
  profile: {
    companyName: 'Alex Morgan',
    entityType: 'Individual',
    jurisdiction: 'UK',
    defaultCurrency: 'GBP',
    bank: 'Sample Bank PLC',
    accountNumber: '26753883',
    sortCode: '00-68-78',
    industry: 'Personal'
  },
  transactions: [
    { date: '2026-01-01', description: 'BRITISH GAS DIRECT DEBIT', moneyOut: 78.40, currency: 'GBP' },
    { date: '2026-01-01', description: 'THAMES WATER DD REF 8821554', moneyOut: 32.10, currency: 'GBP' },
    { date: '2026-01-01', description: 'VIRGIN MEDIA BB', moneyOut: 45.99, currency: 'GBP' },
    { date: '2026-01-02', description: 'PRET A MANGER LONDON', moneyOut: 47.48, currency: 'GBP' },
    { date: '2026-01-03', description: 'SAINSBURYS LOCAL SE15', moneyOut: 63.95, currency: 'GBP' },
    { date: '2026-01-04', description: 'COSTA COFFEE 8821', moneyOut: 3.89, currency: 'GBP' },
    { date: '2026-01-05', description: 'SPOTIFY UK', moneyOut: 63.68, currency: 'GBP' },
    { date: '2026-01-06', description: 'AMAZON*MK7G88JK1', moneyOut: 55.62, currency: 'GBP' },
    { date: '2026-01-08', description: 'NETFLIX.COM', moneyOut: 28.85, currency: 'GBP' },
    { date: '2026-01-09', description: 'UBER *TRIP HELP.UBER.C', moneyOut: 15.03, currency: 'GBP' },
    { date: '2026-01-10', description: 'WAITROSE 027', moneyOut: 75.00, currency: 'GBP' },
    { date: '2026-01-11', description: 'GREGGS 0114', moneyOut: 28.58, currency: 'GBP' },
    { date: '2026-01-14', description: 'TESCO STORES 4477', moneyOut: 10.34, currency: 'GBP' },
    { date: '2026-01-19', description: 'REFUND AMAZON*MK7G88JK1', moneyIn: 24.99, currency: 'GBP' },
    { date: '2026-01-21', description: 'BOOTS 0815 LONDON', moneyOut: 10.63, currency: 'GBP' },
    { date: '2026-01-22', description: 'CO-OP GROUP 1234', moneyOut: 66.79, currency: 'GBP' },
    { date: '2026-01-23', description: 'DELIVEROO LONDON', moneyOut: 48.56, currency: 'GBP' },
    { date: '2026-01-24', description: 'TFL TRAVEL CH', moneyOut: 63.77, currency: 'GBP' },
    { date: '2026-01-25', description: 'ACME LIMITED SALARY REF MAR2026PAY', moneyIn: 2840.55, currency: 'GBP' },
    { date: '2026-01-28', description: 'STANDING ORDER TO J PATEL RENT', moneyOut: 1450.00, currency: 'GBP' }
  ]
};

// ─── Client 2: Cactus Blossom Café Corp (US restaurant, USD) ────

const CACTUS_BLOSSOM = {
  clientId: 'cactus-blossom-cafe',
  companyName: 'Cactus Blossom Café Corp',
  profile: {
    companyName: 'Cactus Blossom Café Corp',
    entityType: 'Corporation',
    jurisdiction: 'US',
    jurisdictionDetail: 'Arizona, United States',
    defaultCurrency: 'USD',
    bank: 'Sonoran Desert National Bank',
    accountNumber: '****4076',
    industry: 'Restaurant / Food Service',
    primaryContact: { name: 'Elena Reyes', role: 'Owner' }
  },
  transactions: [
    { date: '2025-01-01', description: 'SQ *GOSQ.COM 4263539', moneyIn: 5923.13, currency: 'USD' },
    { date: '2025-01-01', description: 'CASH DEPOSIT', moneyIn: 1750.41, currency: 'USD' },
    { date: '2025-01-01', description: 'INTUIT *QUICKBOOKS 915699767', moneyOut: 23.29, currency: 'USD' },
    { date: '2025-01-01', description: 'TOAST INC ACH 22713332', moneyOut: 85.47, currency: 'USD' },
    { date: '2025-01-01', description: 'GUSTO TAX ACH 2457852', moneyOut: 1589.65, currency: 'USD' },
    { date: '2025-01-01', description: 'COMMERCIAL LEASE PMT ACH 721175', moneyOut: 3831.79, currency: 'USD' },
    { date: '2025-01-01', description: 'ACH DEBIT GUSTO 2457852', moneyOut: 4595.71, currency: 'USD' },
    { date: '2025-01-02', description: 'COUNTER DEPOSIT', moneyIn: 1666.21, currency: 'USD' },
    { date: '2025-01-02', description: 'GUSTO FEE ACH 2457852', moneyOut: 24.73, currency: 'USD' },
    { date: '2025-01-03', description: 'ACH DEBIT US FOODS AUSTIN 7519610354', moneyOut: 248.19, currency: 'USD' },
    { date: '2025-01-05', description: 'AMZN MKTP US*NHL1N13JCA Cedar', moneyOut: 108.29, currency: 'USD' },
    { date: '2025-01-06', description: 'DOORDASH INC ACH 192744441157', moneyIn: 1531.90, currency: 'USD' },
    { date: '2025-01-07', description: 'SQ *KEEPMORE 5982337100', moneyIn: 2935.04, currency: 'USD' },
    { date: '2025-01-07', description: 'ACH DEBIT SYSCO CENTRAL TX 7030495058', moneyOut: 1134.39, currency: 'USD' },
    { date: '2025-01-08', description: 'UBER EATS ACH 726303659', moneyIn: 1057.48, currency: 'USD' },
    { date: '2025-01-08', description: 'WM EZPAY ACH 263322966', moneyOut: 117.31, currency: 'USD' },
    { date: '2025-01-09', description: 'ATMOS ENERGY ACH 8082463', moneyOut: 130.91, currency: 'USD' },
    { date: '2025-01-10', description: 'SQ *KEEPMORE 189025', moneyIn: 1763.86, currency: 'USD' },
    { date: '2025-01-10', description: 'VZW*VZWRLSS*APOCC 9598076526', moneyOut: 75.28, currency: 'USD' },
    { date: '2025-01-13', description: 'DOORDASH ACH PYMT 89238434', moneyIn: 1723.15, currency: 'USD' },
    { date: '2025-01-13', description: 'COUNTER CULTURE COF ACH DEBIT', moneyOut: 273.48, currency: 'USD' },
    { date: '2025-01-13', description: 'AUSTIN ENERGY ACH 624194', moneyOut: 273.70, currency: 'USD' },
    { date: '2025-01-14', description: 'SYSCO CENTRAL TX ACH DEBIT', moneyOut: 1083.73, currency: 'USD' },
    { date: '2025-01-15', description: 'SQUARE INC 110045', moneyIn: 4954.46, currency: 'USD' },
    { date: '2025-01-15', description: 'COMCAST BUSINESS ACH 8363942252', moneyOut: 61.17, currency: 'USD' },
    { date: '2025-01-15', description: 'ACH DEBIT GUSTO 781151148', moneyOut: 4302.09, currency: 'USD' },
    { date: '2025-01-16', description: 'CHECKCARD COSTCO WHSE*88796', moneyOut: 116.59, currency: 'USD' },
    { date: '2025-01-17', description: 'ACH DEBIT US FOODS AUSTIN 880739888271', moneyOut: 216.57, currency: 'USD' },
    { date: '2025-01-17', description: 'ACH DEBIT GUSTO TAX 781151148', moneyOut: 1564.25, currency: 'USD' },
    { date: '2025-01-20', description: 'SQ *KEEPMORE 12107589443', moneyIn: 3795.09, currency: 'USD' },
    { date: '2025-01-20', description: 'CITY OF AUSTIN WATER ACH', moneyOut: 77.78, currency: 'USD' },
    { date: '2025-01-20', description: 'ACH DEBIT COUNTER CULTURE COF', moneyOut: 252.03, currency: 'USD' },
    { date: '2025-01-20', description: 'ACH DEBIT NEXT INS 3199954', moneyOut: 729.74, currency: 'USD' },
    { date: '2025-01-20', description: 'ONLINE BANKING TRANSFER 71159598', moneyOut: 2880.39, currency: 'USD' },
    { date: '2025-01-22', description: 'SQ *GOSQ.COM 85715429489', moneyIn: 4732.31, currency: 'USD' },
    { date: '2025-01-24', description: 'US FOODS AUSTIN ACH DEBIT', moneyOut: 216.57, currency: 'USD' },
    { date: '2025-01-24', description: 'FUNDS TRANSFER TO 7065', moneyOut: 3444.68, currency: 'USD' },
    { date: '2025-01-27', description: 'SQUARE INC 459654137672', moneyIn: 3155.02, currency: 'USD' },
    { date: '2025-01-27', description: 'COUNTER CULTURE COF ACH DEBIT', moneyOut: 255.38, currency: 'USD' },
    { date: '2025-01-28', description: 'ACH DEBIT SYSCO CENTRAL TX 659182', moneyOut: 1386.07, currency: 'USD' },
    { date: '2025-01-31', description: 'PURCHASE WEBSTAURANTSTR.C', moneyOut: 77.24, currency: 'USD' },
    { date: '2025-01-31', description: 'ACH DEBIT US FOODS AUSTIN', moneyOut: 216.57, currency: 'USD' }
  ]
};

// ─── Client 3: Jason's Rental LLC (US micro-LLC, USD) ───────────

const JASONS_RENTAL = {
  clientId: 'jasons-rental-llc',
  companyName: "Jason's Rental LLC",
  profile: {
    companyName: "Jason's Rental LLC",
    entityType: 'Limited liability company',
    jurisdiction: 'US',
    jurisdictionDetail: 'Texas, United States',
    defaultCurrency: 'USD',
    bank: 'Lone Star Community Bank',
    accountNumber: '****5526',
    industry: 'Real Estate / Rental',
    primaryContact: { name: 'Jason Staats', role: 'Owner' }
  },
  transactions: [
    { date: '2025-01-01', description: 'ACH DEBIT WELLS FARGO MTG 95822412', moneyOut: 1285.47, currency: 'USD' },
    { date: '2025-01-02', description: 'ZELLE FROM SARAH MITCHELL', moneyIn: 1350.00, currency: 'USD' },
    { date: '2025-01-03', description: 'Check #1001 - CHECK DEP 1001', moneyIn: 1425.00, currency: 'USD' },
    { date: '2025-01-03', description: 'LOWES #02847', moneyOut: 152.04, currency: 'USD' },
    { date: '2025-01-06', description: 'AVAIL *MONTHLY 5614226', moneyOut: 19.99, currency: 'USD' },
    { date: '2025-01-10', description: 'TRUGREEN LP ACH 13356886', moneyOut: 85.00, currency: 'USD' },
    { date: '2025-01-15', description: 'STATE FARM P&C INS ACH 24942603', moneyOut: 165.00, currency: 'USD' },
    { date: '2025-01-20', description: 'LOWES #02847', moneyOut: 171.61, currency: 'USD' },
    { date: '2025-01-22', description: 'LOWES #02847', moneyOut: 67.63, currency: 'USD' },
    { date: '2025-01-22', description: 'STANLEY STEEMER', moneyOut: 246.66, currency: 'USD' }
  ]
};

// ─── Client 4: Lone Star Apiaries LLC (high-volume, USD) ────────
// Seeding a representative sample from the 23-page, 919-txn statement.
// First 3 days (~95 txns) + payroll days + month-end for balance validation.

const LONE_STAR = {
  clientId: 'lone-star-apiaries',
  companyName: 'Lone Star Apiaries LLC',
  profile: {
    companyName: 'Lone Star Apiaries LLC',
    entityType: 'Limited liability company',
    jurisdiction: 'US',
    jurisdictionDetail: 'Texas, United States',
    defaultCurrency: 'USD',
    bank: 'Lone Star National Bank',
    accountNumber: '****8292',
    industry: 'Agriculture / Beekeeping',
    primaryContact: { name: 'Carl Whitfield', role: 'Owner' }
  },
  transactions: [
    // Apr 1 — payroll day + suppliers
    { date: '2025-04-01', description: 'WIRE TRF IN JASON HALL 27135607770', moneyIn: 5741.50, currency: 'USD' },
    { date: '2025-04-01', description: 'ACH PMT WILLIAM PHILLIPS SVC 184052975', moneyIn: 4879.55, currency: 'USD' },
    { date: '2025-04-01', description: 'ACH PMT SARAH MURPHY SVC 120822364463', moneyIn: 3129.89, currency: 'USD' },
    { date: '2025-04-01', description: 'SHOPIFY INC ACH 336212080693', moneyIn: 747.13, currency: 'USD' },
    { date: '2025-04-01', description: 'HIVE TRACKS ACH 90572848692', moneyOut: 21.18, currency: 'USD' },
    { date: '2025-04-01', description: 'PURCHASE EXXON 92024 032', moneyOut: 29.55, currency: 'USD' },
    { date: '2025-04-01', description: 'INTUIT *QUICKBOOKS 974347973838', moneyOut: 41.70, currency: 'USD' },
    { date: '2025-04-01', description: 'SHELL 93950 TX', moneyOut: 85.05, currency: 'USD' },
    { date: '2025-04-01', description: 'FOOD SAFETY CERT ACH 9114394', moneyOut: 85.76, currency: 'USD' },
    { date: '2025-04-01', description: 'POS AMZN MKTP US*QEGCBQ7ZGDIJ CEDA', moneyOut: 98.93, currency: 'USD' },
    { date: '2025-04-01', description: 'POS TRACTOR SUPPLY CO #04005 0117 C', moneyOut: 288.83, currency: 'USD' },
    { date: '2025-04-01', description: 'ACH DEBIT CHEMICALS LAIF SPA ACH', moneyOut: 774.95, currency: 'USD' },
    { date: '2025-04-01', description: 'POS DEBIT - BETTERBEE.COM G80IY3LQC', moneyOut: 894.54, currency: 'USD' },
    { date: '2025-04-01', description: 'POS PURCHASE - BETTERBEE.COM 1', moneyOut: 952.00, currency: 'USD' },
    { date: '2025-04-01', description: 'ACH DEBIT BRUSHY MTN BEE FM', moneyOut: 1102.67, currency: 'USD' },
    { date: '2025-04-01', description: 'OLD DOMINION FRGHT ACH ACH DEBIT', moneyOut: 1288.33, currency: 'USD' },
    { date: '2025-04-01', description: 'ACH DEBIT MAXANT INDUSTRIES ACH 95641257', moneyOut: 2365.38, currency: 'USD' },
    { date: '2025-04-01', description: 'ACH DEBIT - MANN LAKE BEE SUP ACH', moneyOut: 4021.15, currency: 'USD' },
    { date: '2025-04-01', description: 'ACH DEBIT GREYSTAR REAL EST LEASE STE B', moneyOut: 4259.46, currency: 'USD' },
    { date: '2025-04-01', description: 'ACH DEBIT GREYSTAR REAL EST LEASE', moneyOut: 8484.31, currency: 'USD' },
    { date: '2025-04-01', description: 'ACH DEBIT GUSTO FED 58733656', moneyOut: 30217.04, currency: 'USD' },
    { date: '2025-04-01', description: 'GUSTO ACH DEBIT 58733656', moneyOut: 101030.77, currency: 'USD' },
    // Apr 2 — revenue + expenses
    { date: '2025-04-02', description: 'WIRE TRF IN WILLIAM PHILLIPS 748199387', moneyIn: 9458.35, currency: 'USD' },
    { date: '2025-04-02', description: 'ACH PMT STEVEN REED SVC 92316375711', moneyIn: 4908.55, currency: 'USD' },
    { date: '2025-04-02', description: 'SQ *GOSQ.COM 6300288492', moneyIn: 495.15, currency: 'USD' },
    { date: '2025-04-02', description: 'FEDEX #00951 TX', moneyOut: 56.57, currency: 'USD' },
    { date: '2025-04-02', description: 'CHECKCARD VISTAPRINT*VSCQ', moneyOut: 90.08, currency: 'USD' },
    { date: '2025-04-02', description: 'TRACTOR SUPPLY #04005', moneyOut: 238.30, currency: 'USD' },
    { date: '2025-04-02', description: 'BETTERBEE INC ACH TX', moneyOut: 915.21, currency: 'USD' },
    { date: '2025-04-02', description: 'ELECTRONIC DEBIT ULINE SHIP SUPPLIE', moneyOut: 985.58, currency: 'USD' },
    { date: '2025-04-02', description: 'W.W. GRAINGER ACH Cedar', moneyOut: 1017.94, currency: 'USD' },
    // Apr 3 — diverse mix
    { date: '2025-04-03', description: 'WIRE TRF IN SARAH WILSON 630588', moneyIn: 6825.90, currency: 'USD' },
    { date: '2025-04-03', description: 'AMAZON PYMTS ACH 76219066', moneyIn: 761.98, currency: 'USD' },
    { date: '2025-04-03', description: 'SHOPIFY*PAYOUT 49900840', moneyIn: 392.11, currency: 'USD' },
    { date: '2025-04-03', description: 'ZELLE PYMT FROM JASON HALL', moneyIn: 209.18, currency: 'USD' },
    { date: '2025-04-03', description: 'GUSTO FEE ACH 58733656', moneyOut: 101.18, currency: 'USD' },
    { date: '2025-04-03', description: 'ACH DEBIT EUROFINS FOOD TEST ACH 16', moneyOut: 471.25, currency: 'USD' },
    { date: '2025-04-03', description: 'DADANT & SONS ACH ACH DEBIT', moneyOut: 1615.47, currency: 'USD' },
    { date: '2025-04-03', description: 'GLORYBEE INC ACH PMT ACH DEBIT', moneyOut: 1772.15, currency: 'USD' },
    { date: '2025-04-03', description: 'ACH DEBIT BERLIN INDUSTRIES ACH', moneyOut: 3123.14, currency: 'USD' },
    // Apr 4 — insurance + vehicle
    { date: '2025-04-04', description: 'PROGRESSIVE COMML ACH 4582005', moneyOut: 2765.48, currency: 'USD' },
    { date: '2025-04-04', description: 'PURCHASE THE HOME DEPOT #66337', moneyOut: 447.78, currency: 'USD' },
    // Apr 7 — gas utility
    { date: '2025-04-07', description: 'TEXAS GAS SVC ACH 6755144', moneyOut: 71.08, currency: 'USD' },
    { date: '2025-04-07', description: 'ACH DEBIT DOMINO SUGAR IND ACH', moneyOut: 5676.92, currency: 'USD' },
    // Apr 8 — utility + vehicle payment
    { date: '2025-04-08', description: 'AUSTIN ENERGY ACH 296081', moneyOut: 416.46, currency: 'USD' },
    { date: '2025-04-08', description: 'FORD MTR CR CO ACH 01192511', moneyOut: 1103.47, currency: 'USD' },
    { date: '2025-04-08', description: 'MANN LAKE BEE SUP ACH ACH DEBIT', moneyOut: 3152.83, currency: 'USD' },
    // Apr 10 — workers comp
    { date: '2025-04-10', description: 'STATE FUND WC ACH 058101046070', moneyOut: 3517.48, currency: 'USD' },
    { date: '2025-04-10', description: 'GOOGLE *ADS 12922328', moneyOut: 688.37, currency: 'USD' },
    // Apr 11 — Verizon
    { date: '2025-04-11', description: 'VERIZON WRLS 609773468', moneyOut: 314.62, currency: 'USD' },
    // Apr 15 — second payroll + insurance
    { date: '2025-04-15', description: 'COMCAST BUSINESS ACH 58261036109', moneyOut: 108.19, currency: 'USD' },
    { date: '2025-04-15', description: 'FACEBK *ADS 850784941', moneyOut: 375.05, currency: 'USD' },
    { date: '2025-04-15', description: 'ACH DEBIT NEXT INS 925658323', moneyOut: 1178.29, currency: 'USD' },
    { date: '2025-04-15', description: 'CHASE CARD AUTOPAY 01970898109', moneyOut: 1901.21, currency: 'USD' },
    { date: '2025-04-15', description: 'ACH DEBIT MANN LAKE LTD J4PH6UJTRFT', moneyOut: 3887.97, currency: 'USD' },
    { date: '2025-04-15', description: 'ACH DEBIT GUSTO FED 94443789195', moneyOut: 30125.02, currency: 'USD' },
    { date: '2025-04-15', description: 'GUSTO ACH DEBIT 94443789195', moneyOut: 105861.67, currency: 'USD' },
    // Apr 17 — internal transfer
    { date: '2025-04-17', description: 'ACH DEBIT - DADANT & SONS ACH', moneyOut: 1814.63, currency: 'USD' },
    { date: '2025-04-17', description: 'ONLINE BANKING TRANSFER 463410959', moneyOut: 40814.29, currency: 'USD' },
    // Apr 18 — Ford + waste
    { date: '2025-04-18', description: 'WM EZPAY ACH 958869004', moneyOut: 146.93, currency: 'USD' },
    { date: '2025-04-18', description: 'FORD MOTOR CREDIT ACH 692042847147', moneyOut: 970.24, currency: 'USD' },
    // Apr 30 — month-end maintenance
    { date: '2025-04-30', description: 'MONTHLY MAINTENANCE FEE', moneyOut: 12.00, currency: 'USD' },
    { date: '2025-04-30', description: 'ACH DEBIT ESTES EXPRESS ACH 693567', moneyOut: 1371.07, currency: 'USD' }
  ]
};

async function main() {
  console.log('[seed] Creating 4 test clients...\n');

  await withFirmDbClient(async (client) => {
    for (const data of [ALEX_MORGAN, CACTUS_BLOSSOM, JASONS_RENTAL, LONE_STAR]) {
      await seedClient(client, data);
      console.log('');
    }
  });

  console.log('[seed] Done. 4 clients seeded.');
}

main().catch((err) => {
  console.error('[seed] FAILED', err);
  process.exit(1);
});
