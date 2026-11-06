#!/usr/bin/env node
// One-off: seed a Finnish (EUR) chart of accounts for the Aava Digital
// Oy demo client. Companion to create_demo_client_finnish_oy.js — runs
// against the same firm DB and is independently idempotent.
//
// Why a custom CoA: the canonical Donna seed is SG/SGD and the honeybee
// CoA is US/USD. A Finnish Oy needs EUR accounts named in Finnish with
// ALV (VAT) awareness. Names are distinctive so the categoriser can pin
// a code from the transaction description alone (e.g. "Matkakulut" for a
// Finnair charge, "Ohjelmistot ja SaaS" for a Google Workspace debit).
//
// Codes follow the common Finnish small-business blocks (kirjanpidon
// tilikartta), compressed:
//   1xxx vastaavaa (assets), 2xxx vastattavaa (liabilities/equity),
//   3xxx liikevaihto (revenue), 4xxx aine- ja alihankinta,
//   6-8xxx liiketoiminnan kulut (operating expenses), 9999 suspense.
//
// Usage:
//   node scripts/seed_chart_of_accounts_finnish_oy.js
//
// Idempotency:
//   - ledger_accounts.id is deterministic per (firm, client, code) so
//     ON CONFLICT (id) DO UPDATE keeps each row in sync. Re-runs safe.
//   - The client row is REQUIRED to exist (FK) — this script validates
//     and exits with a helpful message if you haven't run
//     create_demo_client_finnish_oy.js first.

import crypto from 'node:crypto';

import { DEFAULT_FIRM_ID, withFirmDbClient } from '../server/donna/firmDb.js';

const FIRM_ID = DEFAULT_FIRM_ID;
const CLIENT_ID = 'aava-digital-oy';

// Finnish EUR CoA for a service consultancy. `alv` is the standard ALV
// treatment note carried into ledger_accounts.tax_type (the strong coder
// renders the rate verdict; this is a hint, not a re-decider). Standard
// rate 25,5 % since 2024-09-01.
const ACCOUNTS = [
  // ─── Vastaavaa / Assets (debit-normal) ─────────────────────────────
  { code: '1900', name: 'Pankkitili (Nordea)', type: 'asset' },
  { code: '1910', name: 'Käteiskassa', type: 'asset' },
  { code: '1700', name: 'Myyntisaamiset', type: 'asset' },
  { code: '1750', name: 'Muut saamiset', type: 'asset' },
  { code: '1780', name: 'Siirtosaamiset (ennakot)', type: 'asset' },

  // ─── Vastattavaa / Liabilities (credit-normal) ─────────────────────
  { code: '2870', name: 'Ostovelat', type: 'liability', normal: 'credit' },
  { code: '2939', name: 'ALV-velka (suoritettava)', type: 'liability', normal: 'credit', alv: 'output_standard' },
  { code: '1763', name: 'ALV-saaminen (vähennettävä)', type: 'asset', alv: 'input_standard' },
  { code: '2960', name: 'Ennakonpidätysvelka', type: 'liability', normal: 'credit' },
  { code: '2900', name: 'Muut lyhytaikaiset velat', type: 'liability', normal: 'credit' },

  // ─── Oma pääoma / Equity (credit-normal) ───────────────────────────
  { code: '2000', name: 'Osakepääoma', type: 'equity', normal: 'credit' },
  { code: '2251', name: 'Edellisten tilikausien voitto', type: 'equity', normal: 'credit' },
  { code: '2371', name: 'Tilikauden tulos', type: 'equity', normal: 'credit' },

  // ─── Liikevaihto / Revenue (credit-normal) ─────────────────────────
  { code: '3000', name: 'Palvelumyynti (konsultointi)', type: 'revenue', normal: 'credit', alv: 'output_standard' },
  { code: '3010', name: 'Suunnittelupalvelut', type: 'revenue', normal: 'credit', alv: 'output_standard' },
  { code: '3020', name: 'Ylläpito ja tuki', type: 'revenue', normal: 'credit', alv: 'output_standard' },
  { code: '3300', name: 'Myynti EU-alueelle (käännetty ALV)', type: 'revenue', normal: 'credit', alv: 'output_eu_reverse' },
  { code: '3900', name: 'Muut liiketoiminnan tuotot', type: 'revenue', normal: 'credit' },

  // ─── Aine- ja alihankinta / COGS-ish (debit-normal) ────────────────
  { code: '4000', name: 'Alihankinta ja freelancerit', type: 'cost_of_sales', alv: 'input_standard' },
  { code: '4400', name: 'Ohjelmistolisenssit (jälleenmyynti)', type: 'cost_of_sales', alv: 'input_standard' },

  // ─── Liiketoiminnan kulut / Operating expenses (debit-normal) ──────
  { code: '6000', name: 'Toimitilavuokra', type: 'expense', alv: 'input_standard' },
  { code: '6050', name: 'Sähkö ja vesi', type: 'expense', alv: 'input_standard' },
  { code: '6100', name: 'Ohjelmistot ja SaaS', type: 'expense', alv: 'input_standard' },
  { code: '6110', name: 'IT-laitteet ja tarvikkeet', type: 'expense', alv: 'input_standard' },
  { code: '6200', name: 'Puhelin ja internet', type: 'expense', alv: 'input_standard' },
  { code: '6300', name: 'Toimistotarvikkeet', type: 'expense', alv: 'input_standard' },
  { code: '6400', name: 'Matkakulut', type: 'expense', alv: 'input_standard' },
  { code: '6410', name: 'Kilometrikorvaukset ja päivärahat', type: 'expense', alv: 'exempt' },
  { code: '6500', name: 'Edustuskulut', type: 'expense', alv: 'entertainment_nondeductible' },
  { code: '6510', name: 'Neuvottelukulut', type: 'expense', alv: 'input_standard' },
  { code: '6600', name: 'Markkinointi ja mainonta', type: 'expense', alv: 'input_standard' },
  { code: '6700', name: 'Kirjanpito ja tilintarkastus', type: 'expense', alv: 'input_standard' },
  { code: '6710', name: 'Vakuutukset', type: 'expense', alv: 'exempt' },
  { code: '6800', name: 'Koulutus ja jäsenmaksut', type: 'expense', alv: 'input_standard' },
  { code: '6900', name: 'Pankki- ja maksuliikennekulut', type: 'expense', alv: 'exempt' },
  { code: '7000', name: 'Palkat', type: 'expense' },
  { code: '7100', name: 'Henkilösivukulut (TyEL, sotu)', type: 'expense' },

  // ─── Suspense ──────────────────────────────────────────────────────
  // Donna's categoriser falls back to this when no rule fires and the
  // LLM isn't confident. A line resting here is NOT auto-reconciled.
  { code: '9999', name: 'Selvittelytili (Suspense)', type: 'asset' }
];

const NORMAL_BY_TYPE = {
  asset: 'debit',
  liability: 'credit',
  equity: 'credit',
  revenue: 'credit',
  cost_of_sales: 'debit',
  expense: 'debit'
};

const ledgerAccountId = ({ firmId, clientId, code }) => {
  const hash = crypto
    .createHash('sha256')
    .update(`${firmId}|${clientId}|${code}`)
    .digest('hex')
    .slice(0, 16);
  return `ledger-account-${hash}`;
};

const main = async () => {
  await withFirmDbClient(async (client) => {
    const clientCheck = await client.query(
      'select id from clients where firm_id = $1 and id = $2',
      [FIRM_ID, CLIENT_ID]
    );
    if (!clientCheck.rows.length) {
      console.error(
        `[aava-coa] FAILED: client ${CLIENT_ID} not found under firm ${FIRM_ID}. ` +
          'Run scripts/create_demo_client_finnish_oy.js first.'
      );
      process.exit(2);
    }

    let inserted = 0;
    let updated = 0;
    for (const account of ACCOUNTS) {
      const id = ledgerAccountId({ firmId: FIRM_ID, clientId: CLIENT_ID, code: account.code });
      const normalBalance = account.normal || NORMAL_BY_TYPE[account.type] || 'debit';
      const payload = {
        label: `${account.code} · ${account.name}`,
        seed: 'aava_digital_fi_oy_coa_v1'
      };
      const result = await client.query(
        `insert into ledger_accounts (
           id, firm_id, client_id, code, name, account_type, normal_balance,
           currency, tax_type, xero_account_id, status, payload
         )
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active', $11::jsonb)
         on conflict (id) do update set
           code = excluded.code,
           name = excluded.name,
           account_type = excluded.account_type,
           normal_balance = excluded.normal_balance,
           currency = excluded.currency,
           tax_type = excluded.tax_type,
           status = 'active',
           payload = ledger_accounts.payload || excluded.payload,
           updated_at = now()
         returning xmax = 0 as inserted`,
        [
          id,
          FIRM_ID,
          CLIENT_ID,
          account.code,
          account.name,
          account.type,
          normalBalance,
          'EUR',
          account.alv || null,   // tax_type: ALV treatment hint
          null,                  // xero_account_id: no Xero tenant for this demo client
          JSON.stringify(payload)
        ]
      );
      if (result.rows[0]?.inserted) inserted += 1;
      else updated += 1;
    }

    console.log(`[aava-coa] inserted=${inserted} updated=${updated} total=${ACCOUNTS.length}.`);
    console.log('[aava-coa] Next: node scripts/seed_finnish_oy_month.js');
  });
};

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[aava-coa] FAILED', err);
    process.exit(1);
  }
);
