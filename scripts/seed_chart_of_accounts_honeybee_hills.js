#!/usr/bin/env node
// One-off: seed a US-flavoured chart of accounts for the Honeybee
// Hills Apiary LLC demo client. Companion to
// scripts/create_demo_client_honeybee_hills.js — runs against the
// same firm DB and is independently idempotent.
//
// Why a custom CoA: the canonical Donna seed is SG/SGD. For an
// Arkansas apiary, the SG accounts (GST, ACRA, Bizfile-driven
// vocabulary) don't fit. This list is small but distinctive enough
// for the categoriser to learn against — every account name is
// uniquely identifiable from a transaction description (e.g.
// "Hive Feed & Supplements" not just "Supplies").
//
// Usage:
//   node scripts/seed_chart_of_accounts_honeybee_hills.js
//
// Idempotency:
//   - ledger_accounts.id is deterministic per (firm, client, code) so
//     ON CONFLICT (id) DO UPDATE keeps each row in sync with this
//     script's definition. Re-runs are safe.
//   - The client row is REQUIRED to exist (FK from ledger_accounts) —
//     this script validates and exits with a helpful message if you
//     haven't run create_demo_client_honeybee_hills.js first.

import crypto from 'node:crypto';

import { DEFAULT_FIRM_ID, withFirmDbClient } from '../server/donna/firmDb.js';

const FIRM_ID = DEFAULT_FIRM_ID;
const CLIENT_ID = 'honeybee-hills-apiary';

// Compact US apiary CoA. Codes follow standard small-biz blocks:
//   1xxx assets, 2xxx liabilities, 3xxx equity, 4xxx revenue,
//   5xxx cost of sales, 6xxx expenses, 9999 suspense.
//
// Distinctive names are intentional — the categoriser leans on the
// account_name string when matching a transaction to a code. Generic
// names ("Supplies", "Other") force every ambiguous row through the
// chat surface, which is fine but slow. Specific names ("Hive Feed
// & Supplements", "Vehicle Fuel") let merchant-pattern rules pin
// the right code on first sight.
const ACCOUNTS = [
  // ─── Assets (debit-normal) ─────────────────────────────────────────
  { code: '1000', name: 'Operating Checking', type: 'asset' },
  { code: '1010', name: 'Savings', type: 'asset' },
  { code: '1100', name: 'Accounts Receivable', type: 'asset' },
  { code: '1200', name: 'Inventory — Honey', type: 'asset' },
  { code: '1210', name: 'Inventory — Beeswax & By-products', type: 'asset' },
  { code: '1500', name: 'Prepaid Expenses', type: 'asset' },

  // ─── Liabilities (credit-normal) ───────────────────────────────────
  { code: '2000', name: 'Accounts Payable', type: 'liability', normal: 'credit' },
  { code: '2100', name: 'Sales Tax Payable', type: 'liability', normal: 'credit' },
  { code: '2200', name: 'Credit Card — Operating', type: 'liability', normal: 'credit' },
  { code: '2300', name: 'Loans Payable', type: 'liability', normal: 'credit' },

  // ─── Equity (credit-normal) ────────────────────────────────────────
  { code: '3000', name: "Owner's Equity — Ruth Calloway", type: 'equity', normal: 'credit' },
  { code: '3100', name: "Owner's Draws", type: 'equity', normal: 'debit' },
  { code: '3200', name: 'Retained Earnings', type: 'equity', normal: 'credit' },

  // ─── Revenue (credit-normal) ───────────────────────────────────────
  { code: '4000', name: 'Retail Honey Sales', type: 'revenue', normal: 'credit' },
  { code: '4010', name: 'Wholesale Honey Sales', type: 'revenue', normal: 'credit' },
  { code: '4020', name: 'Beeswax & Hive Product Sales', type: 'revenue', normal: 'credit' },
  { code: '4030', name: 'Pollination Services', type: 'revenue', normal: 'credit' },
  { code: '4040', name: 'Workshop & Education Revenue', type: 'revenue', normal: 'credit' },
  { code: '4090', name: 'Other Income', type: 'revenue', normal: 'credit' },

  // ─── Cost of Sales (debit-normal) ──────────────────────────────────
  { code: '5000', name: 'Bee Stock Purchases', type: 'cost_of_sales' },
  { code: '5010', name: 'Hive Feed & Supplements', type: 'cost_of_sales' },
  { code: '5020', name: 'Bottling, Jars & Labels', type: 'cost_of_sales' },
  { code: '5030', name: 'Hive Treatments & Medications', type: 'cost_of_sales' },
  { code: '5040', name: 'Pollination Service Costs', type: 'cost_of_sales' },

  // ─── Expenses (debit-normal) ───────────────────────────────────────
  { code: '6000', name: 'Hive Equipment & Maintenance', type: 'expense' },
  { code: '6010', name: 'Vehicle Fuel', type: 'expense' },
  { code: '6020', name: 'Vehicle Repairs & Maintenance', type: 'expense' },
  { code: '6030', name: 'Insurance', type: 'expense' },
  { code: '6040', name: 'Office Supplies', type: 'expense' },
  { code: '6050', name: 'Marketing & Sales', type: 'expense' },
  { code: '6060', name: 'Travel', type: 'expense' },
  { code: '6070', name: 'Meals & Entertainment', type: 'expense' },
  { code: '6080', name: 'Bank & Card Fees', type: 'expense' },
  { code: '6090', name: 'Professional Services', type: 'expense' },
  { code: '6100', name: 'Utilities', type: 'expense' },
  { code: '6110', name: 'Property Tax', type: 'expense' },
  { code: '6115', name: 'Taxes & Licenses', type: 'expense' },
  { code: '6120', name: 'Education, Subscriptions & Memberships', type: 'expense' },
  { code: '6900', name: 'Owner Wages', type: 'expense' },

  // ─── Suspense ──────────────────────────────────────────────────────
  // Donna's categoriser falls back to this when no rule fires and
  // the LLM isn't confident. Keep it visually distinctive in the FE.
  { code: '9999', name: 'Suspense', type: 'asset' }
];

// Default normal_balance by account_type. Equity is split — owner's
// draws are debit-normal even though most equity accounts are credit.
const NORMAL_BY_TYPE = {
  asset: 'debit',
  liability: 'credit',
  equity: 'credit',
  revenue: 'credit',
  cost_of_sales: 'debit',
  expense: 'debit'
};

// Deterministic id so re-runs upsert the same row instead of
// duplicating. Hash includes (firm, client, code) so two clients
// with the same code don't collide.
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
    // Validate the client exists. The FK from ledger_accounts to
    // clients would surface a less helpful error.
    const clientCheck = await client.query(
      'select id from clients where firm_id = $1 and id = $2',
      [FIRM_ID, CLIENT_ID]
    );
    if (!clientCheck.rows.length) {
      console.error(
        `[honeybee-coa] FAILED: client ${CLIENT_ID} not found under firm ${FIRM_ID}. ` +
          'Run scripts/create_demo_client_honeybee_hills.js first.'
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
        seed: 'honeybee_hills_us_apiary_coa_v1'
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
          'USD',
          null, // tax_type: leave null; US sales tax handled per-line, not per-account
          null, // xero_account_id: no Xero tenant connected for this demo client
          JSON.stringify(payload)
        ]
      );
      if (result.rows[0]?.inserted) inserted += 1;
      else updated += 1;
    }

    console.log(
      `[honeybee-coa] inserted=${inserted} updated=${updated} total=${ACCOUNTS.length}.`
    );
    console.log(
      '[honeybee-coa] CoA ready. Open the firm console and upload statements / invoices against Honeybee Hills.'
    );
  });
};

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[honeybee-coa] FAILED', err);
    process.exit(1);
  }
);
