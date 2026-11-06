#!/usr/bin/env node
// Fix wrong/missing client_rules for honeybee-hills-apiary.
// 1. Delete wrong LLM rule: irs usataxpymt → Owner Wages
// 2. Create rule: check dep → Retail Honey Sales (4000)
// 3. Create rule: land lease → Prepaid Expenses (1500) — closest to rent without a dedicated account

import { queryFirmDb, withFirmDbClient } from '../server/donna/firmDb.js';

const FIRM_ID = 'donna-demo-firm';
const CLIENT_ID = 'honeybee-hills-apiary';

async function main() {
  await withFirmDbClient(async (client) => {
    // 1. Delete wrong IRS rule so VENDOR_SIGNALS (Sales Tax Payable) takes over
    const del = await client.query(
      `delete from client_rules
        where firm_id = $1 and client_id = $2
          and pattern_text = 'irs usataxpymt'
          and created_by = 'ai'`,
      [FIRM_ID, CLIENT_ID]
    );
    console.log(`Deleted IRS rule: ${del.rowCount} row(s)`);

    // Also reset the transactions back to correct category
    const irs = await client.query(
      `update transactions
          set category = 'Sales Tax Payable',
              account_code = '2100',
              payload = payload || '{"auto_categorize_source":"vendor_signal_fix"}'::jsonb,
              updated_at = now()
        where firm_id = $1 and client_id = $2
          and (description ilike '%irs%usataxpymt%' or raw_description ilike '%irs%usataxpymt%')`,
      [FIRM_ID, CLIENT_ID]
    );
    console.log(`Fixed IRS transactions: ${irs.rowCount} row(s)`);

    await client.query(
      `update transaction_review_queue
          set payload = payload || $3::jsonb, updated_at = now()
        where firm_id = $1 and client_id = $2 and status = 'open'
          and item_id in (
            select id from transactions
             where firm_id = $1 and client_id = $2
               and (description ilike '%irs%usataxpymt%' or raw_description ilike '%irs%usataxpymt%')
          )`,
      [FIRM_ID, CLIENT_ID, JSON.stringify({
        category: 'Sales Tax Payable',
        account_code: '2100',
        proposed_account: 'Sales Tax Payable',
        auto_categorize_source: 'vendor_signal_fix'
      })]
    );

    // 2. Create rule: check deposits → Retail Honey Sales
    await client.query(
      `insert into client_rules (
         id, firm_id, client_id, rule_type, pattern_text,
         account_code, notes, created_by, status, payload
       ) values ($1, $2, $3, 'merchant_category', 'check', '4000',
         'Check deposits are retail honey sales for this client', 'human', 'active',
         $4::jsonb)
       on conflict (id) do update set
         account_code = excluded.account_code,
         notes = excluded.notes,
         status = 'active',
         updated_at = now()`,
      [
        'client-rule-honeybee-check-4000',
        FIRM_ID, CLIENT_ID,
        JSON.stringify({
          source: 'manual_fix',
          merchant_pattern: 'check',
          account_code: '4000',
          account_name: 'Retail Honey Sales',
          confidence: 0.92,
          label: 'check deposit -> 4000'
        })
      ]
    );
    console.log('Created rule: check → Retail Honey Sales');

    // Apply to check dep transactions
    const chk = await client.query(
      `update transactions
          set category = 'Retail Honey Sales',
              account_code = '4000',
              payload = payload || '{"auto_categorize_source":"client_rule","matched_client_rule_id":"client-rule-honeybee-check-4000"}'::jsonb,
              updated_at = now()
        where firm_id = $1 and client_id = $2
          and (description ilike '%check dep%' or description ilike '%check %dep%')`,
      [FIRM_ID, CLIENT_ID]
    );
    console.log(`Fixed check dep transactions: ${chk.rowCount} row(s)`);

    await client.query(
      `update transaction_review_queue
          set payload = payload || $3::jsonb, updated_at = now()
        where firm_id = $1 and client_id = $2 and status = 'open'
          and item_id in (
            select id from transactions
             where firm_id = $1 and client_id = $2
               and (description ilike '%check dep%' or description ilike '%check %dep%')
          )`,
      [FIRM_ID, CLIENT_ID, JSON.stringify({
        category: 'Retail Honey Sales',
        account_code: '4000',
        proposed_account: 'Retail Honey Sales',
        auto_categorize_source: 'client_rule',
        matched_client_rule_id: 'client-rule-honeybee-check-4000'
      })]
    );

    // 3. Delete wrong land lease LLM rule if one exists, leave as Property Tax
    // (CoA gap — no Rent/Lease account. Property Tax is the closest available.)
    const landDel = await client.query(
      `delete from client_rules
        where firm_id = $1 and client_id = $2
          and pattern_text = 'land lease'
          and created_by = 'ai'`,
      [FIRM_ID, CLIENT_ID]
    );
    if (landDel.rowCount) console.log(`Deleted land lease LLM rule: ${landDel.rowCount} row(s)`);
    console.log('Land lease → Property Tax (CoA gap — no Rent/Lease account)');

    console.log('\nDone.');
  });
}

main().catch((err) => { console.error('FAILED', err); process.exit(1); });
