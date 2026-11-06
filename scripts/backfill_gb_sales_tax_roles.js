#!/usr/bin/env node
//
// GB canonical sales-tax-role repair — REPORT-ONLY unless an operator names the
// account.
//
// Why it exists: GB's VAT control leg resolves BY CANONICAL ROLE
// (`liability.sales_tax_payable`) from the client's own chart, because the UK
// ships no statutory chart (accountRoles.js:66-70). An existing GB client whose
// VAT account still carries the pre-split `liability.tax_payable` role therefore
// gets the named refusal OUTBOUND_AR_NO_SALES_TAX_ACCOUNT.
//
// Why it does NOT choose the account: on a GB book `liability.tax_payable` is
// ambiguous BY CONSTRUCTION. accountRoles.js:57-64 records that the GB pack
// declares TWO accounts on that shared role — VAT payable AND Corporation tax
// payable — and that this ambiguity is the whole reason
// `liability.sales_tax_payable` was split out (gap 10). So:
//
//   - TWO candidates is the EXPECTED legacy shape, not an anomaly, and
//   - ONE candidate is NOT "unambiguous" — it only means the other account was
//     never roled. The single row is as likely to be Corporation tax payable,
//     which this repo's own GB default chart assigns `liability.tax_payable`
//     at code 2230 (gb/defaultChart.js).
//
// Account arity carries no information about which account is the VAT control.
// Neither does the account NAME: inferring a canonical role from a name is
// intelligence-substituting scaffolding in precisely the place the Keep layer
// owns (CLAUDE.md), and the sibling `backfill_canonical_roles.js` already binds
// itself to the same two rules this script now follows — it "does not GUESS a
// role" and "never OVERWRITES an existing canonical_role".
//
// So the only thing this script does on its own is REPORT. A write happens only
// when an operator names one candidate account id explicitly, and even then the
// update is a compare-and-swap against the expected prior role.
//
// Scope:
//
//   --firm    <firm_id>     defaults to donna-demo-firm
//   --client  <client_id>   optional; restricts the pass to one client
//   --account <account_id>  the operator's explicit choice of VAT control
//                           account. REQUIRED for any write. Requires --client.
//   --apply                 commits the named repair; default is dry-run.
//
// Without --account the script never writes, with or without --apply.

import { withFirmDbClient } from '../server/donna/firmDb.js';

export const LEGACY_GB_SALES_TAX_ROLE = 'liability.tax_payable';
export const GB_SALES_TAX_ROLE = 'liability.sales_tax_payable';

// Closed refusal vocabulary. A repair that does not happen names one of these.
export const GB_SALES_TAX_REPAIR_REFUSALS = Object.freeze([
  'no_candidates',
  'account_not_specified',
  'account_not_a_candidate'
]);

export const parseArgv = (argv = process.argv.slice(2)) => {
  const out = { apply: false, firmId: 'donna-demo-firm', clientId: null, accountId: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--firm') { out.firmId = argv[i + 1]; i += 1; }
    else if (a === '--client') { out.clientId = argv[i + 1]; i += 1; }
    else if (a === '--account') { out.accountId = argv[i + 1]; i += 1; }
  }
  return out;
};

const isGbLegacyCandidate = (account) =>
  String(account?.jurisdiction || '').toUpperCase() === 'GB' &&
  account?.canonical_role === LEGACY_GB_SALES_TAX_ROLE;

const asCandidate = ({ id, name }) => ({ id, name: name ?? null });

// Pure helper exported for tests. Given ledger_accounts rows joined to their
// client's jurisdiction, returns one REPORT entry per GB client holding legacy
// candidates. It never returns an update: which candidate is the VAT control is
// not derivable from these rows, at any arity.
export const planGbSalesTaxRoleReport = (accounts = []) => {
  const byClient = new Map();
  for (const account of Array.isArray(accounts) ? accounts : []) {
    if (!isGbLegacyCandidate(account)) continue;
    const rows = byClient.get(account.client_id) || [];
    rows.push(account);
    byClient.set(account.client_id, rows);
  }
  return [...byClient].map(([clientId, rows]) => ({
    action: 'report',
    client_id: clientId,
    candidates: rows.map(asCandidate),
    // Stated for every client at every arity, so the report can never be read
    // as "this one is obvious".
    note: 'liability.tax_payable is ambiguous on a GB book (VAT vs corporation tax); '
      + 'name the VAT control account with --account to repair it.'
  }));
};

// Pure helper exported for tests. Given the same rows plus an operator's
// explicit choice, returns either the single update to apply or a named
// refusal. The choice is validated against the candidate set — an operator
// cannot re-role an account this script would not have surfaced.
export const planConfirmedGbSalesTaxRepair = (accounts = [], { clientId, accountId } = {}) => {
  const candidates = (Array.isArray(accounts) ? accounts : [])
    .filter((account) => isGbLegacyCandidate(account) && account.client_id === clientId);
  if (!candidates.length) return { action: 'refuse', reason: 'no_candidates', client_id: clientId };
  if (!accountId) {
    return {
      action: 'refuse',
      reason: 'account_not_specified',
      client_id: clientId,
      candidates: candidates.map(asCandidate)
    };
  }
  const chosen = candidates.find(({ id }) => id === accountId);
  if (!chosen) {
    return {
      action: 'refuse',
      reason: 'account_not_a_candidate',
      client_id: clientId,
      account_id: accountId,
      candidates: candidates.map(asCandidate)
    };
  }
  return {
    action: 'update',
    client_id: clientId,
    id: chosen.id,
    from: LEGACY_GB_SALES_TAX_ROLE,
    to: GB_SALES_TAX_ROLE
  };
};

const log = (...args) => console.log('[gb-sales-tax-role-backfill]', ...args);

const main = async () => {
  const args = parseArgv();
  if (args.accountId && !args.clientId) {
    log('REFUSED: --account requires --client (an account id is only meaningful within one client).');
    process.exitCode = 1;
    return;
  }
  const mode = args.accountId ? (args.apply ? 'APPLY' : 'DRY-RUN') : 'REPORT-ONLY';
  log(`mode=${mode} firm=${args.firmId} client=${args.clientId || '(all)'} account=${args.accountId || '(none)'}`);

  await withFirmDbClient(async (client) => {
    const clientFilterClause = args.clientId ? 'and la.client_id = $2' : '';
    const roleParamIndex = args.clientId ? 3 : 2;
    const params = args.clientId
      ? [args.firmId, args.clientId, LEGACY_GB_SALES_TAX_ROLE]
      : [args.firmId, LEGACY_GB_SALES_TAX_ROLE];
    const accountsResult = await client.query(
      `select la.id, la.client_id, la.name, la.canonical_role, c.jurisdiction
         from ledger_accounts la
         join clients c
           on c.id = la.client_id
          and c.firm_id = la.firm_id
        where la.firm_id = $1 ${clientFilterClause}
          and upper(c.jurisdiction) = 'GB'
          and la.canonical_role = $${roleParamIndex}
        order by la.client_id, la.id`,
      params
    );

    // No operator choice: report and stop. This is the default path.
    if (!args.accountId) {
      const report = planGbSalesTaxRoleReport(accountsResult.rows);
      for (const entry of report) {
        log(`client=${entry.client_id} candidates=${entry.candidates.length} — ${entry.note}`);
        for (const candidate of entry.candidates) {
          log(`    ${candidate.id}  ${candidate.name || '(unnamed)'}`);
        }
      }
      log(`done clients_needing_repair=${report.length} writes=0 (report-only; pass --client and --account to repair)`);
      return;
    }

    const plan = planConfirmedGbSalesTaxRepair(accountsResult.rows, {
      clientId: args.clientId,
      accountId: args.accountId
    });
    if (plan.action === 'refuse') {
      log(`REFUSED client=${plan.client_id} reason=${plan.reason}`);
      for (const candidate of plan.candidates || []) {
        log(`    candidate ${candidate.id}  ${candidate.name || '(unnamed)'}`);
      }
      process.exitCode = 1;
      return;
    }
    if (!args.apply) {
      log(`would set ${plan.to} on ${plan.id} client=${plan.client_id} (re-run with --apply)`);
      return;
    }
    // Compare-and-swap: the row must still carry the role we planned against.
    const updated = await client.query(
      `update ledger_accounts
          set canonical_role = $2, updated_at = now()
        where id = $1 and canonical_role = $3`,
      [plan.id, plan.to, plan.from]
    );
    if (!updated.rowCount) {
      log(`REFUSED client=${plan.client_id} reason=role_changed_since_plan id=${plan.id}`);
      process.exitCode = 1;
      return;
    }
    log(`set ${plan.to} on ${plan.id} client=${plan.client_id}`);
  });
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    () => process.exit(process.exitCode || 0),
    (error) => {
      console.error('[gb-sales-tax-role-backfill] FAILED', error);
      process.exit(1);
    }
  );
}
