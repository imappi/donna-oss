#!/usr/bin/env node
// Smoke test: verify LLM merchant lookup works end-to-end.
// Fetches the real CoA from the DB, sends test bank descriptions
// that VENDOR_SIGNALS won't match, prints LLM results.
// Does NOT write anything to the database.
//
// Usage:
//   DATABASE_URL="..." ANTHROPIC_API_KEY="..." \
//     node scripts/test_merchant_lookup.js

import { queryFirmDb } from '../server/donna/firmDb.js';
import { lookupMerchants, deduplicateMerchants, isMerchantLookupEnabled } from '../server/donna/merchantLookup.js';
import { suggestAccountForVendor } from '../server/donna/vendorAccountSuggestion.js';

const FIRM_ID = process.env.FIRM_ID || 'donna-demo-firm';
const CLIENT_ID = process.env.CLIENT_ID || 'honeybee-hills-apiary';

const TEST_DESCRIPTIONS = [
  // Unknown merchants (no VENDOR_SIGNALS match)
  { description: 'ACH DEBIT FERGUSON ENTERPRISES ACH 45892', money_out: 2847.33 },
  { description: 'SYSCO FOODS 1234 PHOENIX AZ', money_out: 1234.56 },
  { description: 'GRAINGER IND SUPPLY W23', money_out: 456.78 },
  { description: 'BRUSHY MOUNTAIN BEE FARM', money_out: 312.50 },
  { description: 'GLORYBEE FOODS INC', money_out: 189.00 },
  { description: 'KELLEY BEEKEEPING CO', money_out: 245.00 },
  { description: 'ULINE SHIP SUPPLIES', money_out: 167.89 },
  { description: 'CINTAS CORP UNIFORMS', money_out: 234.56 },
  // VENDOR_SIGNALS matches that map to WRONG accounts —
  // LLM should correct these with CoA context:
  { description: 'owner distribution 6881134', money_out: 3806.40 },
  { description: 'land lease pmt ach 80680971', money_out: 854.41 },
  { description: 'transfer to owner acct', money_out: 3139.86 },
  { description: 'check 3853 check dep 3853', money_in: 3455.57 },
  { description: 'sq gosq com 9445235564', money_in: 2502.93 },
];

async function main() {
  console.log(`\n=== Merchant Lookup Smoke Test ===`);
  console.log(`Firm: ${FIRM_ID}, Client: ${CLIENT_ID}`);
  console.log(`ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? 'set' : 'NOT SET'}\n`);

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ERROR: ANTHROPIC_API_KEY is required. Set it in your environment.');
    process.exit(1);
  }

  // Fetch real CoA
  const accountsResult = await queryFirmDb(
    `select id, code, name, account_type
       from ledger_accounts
      where firm_id = $1 and client_id = $2
        and status = 'active'`,
    [FIRM_ID, CLIENT_ID]
  );
  const accounts = accountsResult.rows;
  console.log(`Chart of Accounts: ${accounts.length} active accounts`);
  for (const a of accounts) {
    console.log(`  ${a.code || '—'} | ${a.name} (${a.account_type})`);
  }

  // Check which descriptions VENDOR_SIGNALS can handle
  console.log(`\n--- VENDOR_SIGNALS coverage ---`);
  const signalMisses = [];
  for (const td of TEST_DESCRIPTIONS) {
    const suggestion = suggestAccountForVendor('', td.description, accounts);
    if (suggestion) {
      console.log(`  ✓ "${td.description}" → ${suggestion.account.name} (${suggestion.source})`);
    } else {
      console.log(`  ✗ "${td.description}" → no match`);
      signalMisses.push(td);
    }
  }

  if (signalMisses.length === 0) {
    console.log('\nAll test descriptions matched VENDOR_SIGNALS. Add harder ones to test the LLM.');
    process.exit(0);
  }

  // Deduplicate for LLM
  const rows = signalMisses.map((td) => ({
    description: td.description,
    raw_description: '',
    money_in: 0,
    money_out: td.money_out,
    currency: 'USD',
    review_id: 'test',
    transaction_id: 'test'
  }));
  const merchants = deduplicateMerchants(rows);

  console.log(`\n--- LLM Merchant Lookup (${merchants.length} unknown merchants) ---`);
  const clientRow = await queryFirmDb(
    'select company_name, profile from clients where firm_id = $1 and id = $2',
    [FIRM_ID, CLIENT_ID]
  );
  const clientName = clientRow.rows[0]?.company_name
    || clientRow.rows[0]?.profile?.companyName || 'Unknown';
  console.log(`Client name: ${clientName}\n`);

  const startMs = Date.now();
  const results = await lookupMerchants({ merchants, accounts, clientName });
  const elapsed = Date.now() - startMs;

  if (results.length === 0) {
    console.log('No results returned. Check ANTHROPIC_API_KEY and API connectivity.');
    process.exit(1);
  }

  console.log(`LLM returned ${results.length} identifications in ${elapsed}ms:\n`);
  for (const r of results) {
    console.log(`  "${r.bankDescription}"`);
    console.log(`    → ${r.merchantName} (${r.merchantCategory})`);
    console.log(`    → Account: ${r.accountCode} / ${r.accountName}`);
    console.log(`    → Confidence: ${r.confidenceLabel} (${r.confidence})`);
    console.log(`    → Pattern: "${r.canonicalPattern}"`);
    console.log(`    → Reasoning: ${r.reasoning}`);
    console.log('');
  }

  console.log(`Done. ${results.length}/${merchants.length} merchants identified.`);
}

main().catch((err) => {
  console.error('FAILED', err);
  process.exit(1);
});
