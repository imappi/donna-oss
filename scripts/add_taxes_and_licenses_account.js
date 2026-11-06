#!/usr/bin/env node
//
// Idempotently add a "Taxes & Licenses" expense account to any client
// whose chart of accounts lacks one.
//
// Why it exists: the IRS / federal-tax vendor signal in
// server/donna/vendorAccountSuggestion.js prefers expense accounts
// whose name contains 'tax' alongside a discriminator like 'license'
// or 'federal' or 'income'. A client whose CoA lacks any such account
// gets the autoCategorize fallback — for Honeybee that landed IRS
// USATAXPYMT on the Property Tax bucket, which is confidently wrong.
// This script seeds the missing expense account so the categoriser
// has a correct landing target.
//
// Scope:
//
//   --firm  <firm_id>     defaults to donna-demo-firm
//   --client <client_id>  optional; restricts the pass to one client
//                         (default: all clients under the firm)
//   --apply               commits; default is dry-run (no writes)
//
// Idempotent:
//   - Detection is name-based — any active expense account whose name
//     matches /\btaxes?\s*(?:and|&)\s*licen[cs]e/i is treated as
//     "already present", regardless of code.
//   - Insert uses the same deterministic-id pattern as
//     scripts/seed_chart_of_accounts_honeybee_hills.js (sha256 over
//     firm|client|code), so a re-run upserts the exact row instead of
//     duplicating.
//   - Code defaults to '6115' (mid-gap in Honeybee's expense block);
//     if taken, falls through the candidate set in CODE_CANDIDATES
//     until an unused code is found. Skips the client with a warning
//     if every candidate is occupied.

import crypto from 'node:crypto';

import { withFirmDbClient } from '../server/donna/firmDb.js';

const SOURCE = 'taxes_and_licenses_backfill_v1';

// Candidate codes, in priority order. The first two slot adjacent to
// Property Tax (6110) in Honeybee's chart; the rest provide fallback
// for charts with different code conventions.
const CODE_CANDIDATES = ['6115', '6116', '6117', '6118', '6119', '6300', '6301'];

const TAXES_AND_LICENSES_NAME_PATTERN = /\btaxes?\s*(?:and|&)\s*licen[cs]e/i;

export const parseArgv = (argv = process.argv.slice(2)) => {
  const out = { apply: false, firmId: 'donna-demo-firm', clientId: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--firm') { out.firmId = argv[i + 1]; i += 1; }
    else if (a === '--client') { out.clientId = argv[i + 1]; i += 1; }
  }
  return out;
};

// Pure helper exported for tests. Returns true if any active expense
// account in `accounts` has a name matching the Taxes & Licenses
// pattern. Tolerates the two CoA name shapes ('account_name' vs
// 'name') and account_type casings.
export const hasTaxesAndLicensesAccount = (accounts) => {
  if (!Array.isArray(accounts)) return false;
  return accounts.some((a) => {
    const name = String(a.name || a.account_name || '');
    const type = String(a.account_type || a.type || '').toLowerCase();
    if (type !== 'expense') return false;
    return TAXES_AND_LICENSES_NAME_PATTERN.test(name);
  });
};

// Pure helper exported for tests. Picks the first code from
// CODE_CANDIDATES not already used by `existingCodes`. Returns null
// if every candidate is taken — the script then skips the client.
export const pickInsertCode = (existingCodes, candidates = CODE_CANDIDATES) => {
  const taken = new Set((existingCodes || []).map(String));
  for (const code of candidates) {
    if (!taken.has(code)) return code;
  }
  return null;
};

const ledgerAccountId = ({ firmId, clientId, code }) => {
  const hash = crypto
    .createHash('sha256')
    .update(`${firmId}|${clientId}|${code}`)
    .digest('hex')
    .slice(0, 16);
  return `ledger-account-${hash}`;
};

const log = (...args) => console.log('[taxes-licenses-backfill]', ...args);

const insertAccount = async (client, { firmId, clientId, code }) => {
  const id = ledgerAccountId({ firmId, clientId, code });
  const payload = {
    label: `${code} · Taxes & Licenses`,
    seed: SOURCE
  };
  await client.query(
    `insert into ledger_accounts (
       id, firm_id, client_id, code, name, account_type, normal_balance,
       currency, tax_type, xero_account_id, status, payload
     )
     values ($1, $2, $3, $4, 'Taxes & Licenses', 'expense', 'debit',
             'USD', null, null, 'active', $5::jsonb)
     on conflict (id) do update set
       code = excluded.code,
       name = excluded.name,
       account_type = excluded.account_type,
       normal_balance = excluded.normal_balance,
       status = 'active',
       payload = ledger_accounts.payload || excluded.payload,
       updated_at = now()`,
    [id, firmId, clientId, code, JSON.stringify(payload)]
  );
  return { id, code };
};

const main = async () => {
  const args = parseArgv();
  const mode = args.apply ? 'APPLY' : 'DRY-RUN';
  log(`mode=${mode} firm=${args.firmId} client=${args.clientId || '(all)'}`);

  await withFirmDbClient(async (client) => {
    const clientFilterClause = args.clientId ? 'and id = $2' : '';
    const clientParams = args.clientId ? [args.firmId, args.clientId] : [args.firmId];
    const clientsResult = await client.query(
      `select id from clients where firm_id = $1 ${clientFilterClause}`,
      clientParams
    );

    if (!clientsResult.rows.length) {
      log('no clients matched — nothing to do');
      return;
    }

    const summary = { scanned: 0, skipped_existing: 0, skipped_full: 0, inserted: 0 };

    for (const row of clientsResult.rows) {
      summary.scanned += 1;
      const clientId = row.id;

      const accountsResult = await client.query(
        `select code, name, account_type
           from ledger_accounts
          where firm_id = $1 and client_id = $2 and status = 'active'`,
        [args.firmId, clientId]
      );
      const accounts = accountsResult.rows;

      if (hasTaxesAndLicensesAccount(accounts)) {
        log(`client=${clientId}: already has a Taxes & Licenses account, skipping`);
        summary.skipped_existing += 1;
        continue;
      }

      const existingCodes = accounts.map((a) => a.code);
      const insertCode = pickInsertCode(existingCodes);
      if (!insertCode) {
        log(`client=${clientId}: WARN every candidate code occupied (${CODE_CANDIDATES.join(',')}), skipping`);
        summary.skipped_full += 1;
        continue;
      }

      if (args.apply) {
        const inserted = await insertAccount(client, {
          firmId: args.firmId,
          clientId,
          code: insertCode
        });
        log(`client=${clientId}: inserted code=${inserted.code} id=${inserted.id}`);
      } else {
        log(`client=${clientId}: would insert code=${insertCode} (dry-run)`);
      }
      summary.inserted += 1;
    }

    log(
      `done: scanned=${summary.scanned} ` +
        `inserted=${summary.inserted} ` +
        `skipped_existing=${summary.skipped_existing} ` +
        `skipped_full=${summary.skipped_full} ` +
        `(mode=${mode})`
    );
    if (!args.apply) {
      log('re-run with --apply to commit the inserts above.');
    }
  });
};

const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error('[taxes-licenses-backfill] FAILED', err);
      process.exit(1);
    }
  );
}
