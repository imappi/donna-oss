// server/donna/db/ledger.js — plane S — Donna's own ledger: settlement plans, transaction and period posting, ledger accounts, journals, opening balances, invoice / bill / credit-note journals, corrections and adjustments, the ledger audit trail.
//
// RT-17 (2026-09-02): extracted from server/donna/firmDb.js as a pure move.
// Public symbols retain their import paths through firmDb.js. Wave 6 moves
// country operations behind named registries; shared writers retain persistence.

import { planRefundGroup } from '../jevRefundGroup.js';
import { resolveDocumentAllocation } from './documentAllocation.js';
import { assertCurrentCodingEvidence, autonomousCoding, CODING_EVIDENCE_REFUSAL_CODES } from './codingEvidence.js';
import { taxRegistrationRuleFor, taxRegistrationPeriodState } from './taxRegistrationChange.js';
import { correctionReturnMovement } from '../ledgerCorrectionLines.js';
import { hash } from '../jevEvidenceContract.js';

import { loadTaxPostingContext, readTaxPostingEvidence, taxFactsDigest } from './taxPostingFacts.js';
import { readPostingAdmissionWithClient, requirePostingAdmission } from '../postingAdmissionRegistry.js';
import { resolveMarketPostingAccounts } from '../provisioningPolicyRegistry.js';

import { aeOpeningDigest } from '../ae/openingBalances.js';
import { prepareAeOpeningPostWithClient, finishAeOpeningPostWithClient } from '../ae/openingBalanceDb.js';

import { normalizeIntelText } from '../transactionIntel.js';
import { toIsoDay } from '../dates.js';
import { requireLedgerCurrency, assertLedgerCurrencyMatches } from '../ledgerCurrency.js';
import { executePostingPolicyOperation, PostingPolicyError } from '../postingPolicy.js';
import { resolvePostingContextWithClient, assertPostingContextReceipt, assertPostingSuggestionLineage, postingSourceReceipt, assertPostingSourceReceipt } from './postingPolicyContext.js';
import { recordCodingPolicyFailure, recordCodingPolicyRecovery } from '../codingPolicyRecovery.js';
import { isCodingPolicyError } from '../codingPolicy.js';
import { fallbackAccountOptionsForClient } from '../transactionLlm.js';
import { requireCodingPolicyForClient } from '../codingPolicy.js';
import { nativeAccountChoices, nativeCodingContext, resolveNativeAccountChoice, codingChoiceFailure } from '../codingAccountChoices.js';
import { isAccountRole, normalBalanceForRole, roleForSeedName, roleMeta } from '../accountRoles.js';
import { clientFlagActs, readClientConfigSnapshot } from '../clientConfig.js';
import { EntityReadinessAdmissionError, evaluateEntityReadinessAdmissionWithClient, evaluateRetainedProcessingScopeWithClient, recordEntityReadinessBlockedWithClient } from '../runtimeReadinessAdmission.js';
// RT-16 — the ONE coding state (transactions.coding_state, migration 138):
// the machine, the legacy-input mapping, the DTO projection, the writer.
import { applyCodingTransition, legacyReviewStateFor, normalizeTransactionReviewState } from '../codingState.js';
// FI-4 — tilikausi (Finnish fiscal year) resolver + KEEP-layer invariants. Pure;
// the close-period nesting guard below calls these under the FINLAND_TILIKAUSI flag.
// FI-13 (D-FI13-1/C1) — the legal-form fail-safe: an osakeyhtiö must never be
// served the elinkeinonharjoittaja (form-5) annual return. Refuses fi-oy here,
// inside the reader, so no caller can bypass it.
// FI-3 slice W — ALV coder wiring (D-FI3-W1..W4): the FINLAND_ALV_CODING flag
// routes the coder's tax vocabulary and stamps ALV codes onto the posting-preview
// coding, so the codes reach ledger_lines.tax_type through the fields the journal
// builder already reads — zero isolation-listed writer changes.
import { lifecycleJurisdiction } from '../countryLifecycleContext.js';
import { nativeChartFailure, nativeBirthReceipt, readNativeChartReceipts, readNativeChartObservation, verifyNativeChartObservation, readNativeChartLineage } from '../nativeChartLineage.js';
import { marketBirthChart, marketHasNativeDefaultChart } from '../defaultCharts.js';
// gap 7 — the country-pack chart-of-accounts leg: jurisdiction resolves to an
// AUTHORED pack id, and the pack's palette becomes the client's fallback
// coding menu when JURISDICTION_ACCOUNT_PALETTE acts.
import { fallbackAccountsForPack, JURISDICTION_ACCOUNT_PALETTE_FLAG_KEY, loadOutboundPack, resolvePackIdForJurisdiction } from '../outbound/packs.js';
import { paymentMatchesInvoice } from '../issuedInvoiceSettlementMath.js';
// INT-6 — auto-suspend-on-export-correction (producer side; the 040 Slice-5
// semantics applied to sync grants). Called post-commit + no-throw from the
// ledger correction writer when the corrected journal had been exported.
import { suspendLedgerSyncGrantsAfterExportCorrection } from '../ledgerSyncAuthorityGrants.js';
import { buildXeroBankTransactionWriteback, codingInputFromTransaction, codingModelForTransaction } from '../xeroWriteback.js';
import { buildDonnaLedgerWriteback } from '../donnaLedgerWriteback.js';
import { buildCreditNoteJournal, buildLedgerJournalForDocumentSettlement, buildLedgerJournalForTransaction, buildOpeningBalanceJournal, buildSalesInvoiceJournal, buildSupplierBillJournal, ledgerDateOnly, ledgerTransactionDirection } from '../ledger.js';
import { isRedAccount } from '../lanePolicy.js';
import { normalizeLedgerPeriod } from '../ledgerReadModel.js';
import { buildLedgerAuditTrail } from '../ledgerAuditTrail.js';

import { queryFirmDb, withFirmDbClient } from './pool.js';
import { shortHash, slugifyRulePart, ledgerRecordId } from './shared.js';
export { ledgerRecordId } from './shared.js';
import { clientAccountingBasisFromProfile, DEFAULT_FIRM_ID, getClientAccountingSystemWithClient, requireClientInFirm } from './clients.js';
import { rowToTransactionPayload } from './transactions.js';
import { REVIEW_QUEUE_WITH_CODING_STATE_SQL, rowToTransactionReviewPayload } from './coding.js';
import { rowToClientEvidenceRequestPayload, resolveOpenEvidenceRequestsForTransaction, resolveOpenSettlementRequestsForDocument } from './asks.js';
import { ensureFiscalYearRowTx, resolveClientFiscalYearTx } from './close.js';
import { getXeroAccountsForClient, isTransactionSyncedToXero } from './xero.js';
import { getFirmSnapshotFromDb } from './snapshot.js';


export const receiptPostingFailure = async ({ client, firmId, clientId, transactionIds, error }) => {
  const processingScopeFailure = error?.code === 'PROCESSING_SCOPE_ACCOUNTING_UNAVAILABLE';
  const aeVatFailure = /^(TRANSACTION_AE_VAT_|AE_VAT_|TAX_POSTING_FACTS_)/.test(String(error?.code || ''));
  const componentFailure = /^(TRANSACTION_ALV_|TRANSACTION_DOCUMENT_ALLOCATION_|SETTLEMENT_SPLIT_|REFUND_GROUP_)/.test(String(error?.code || ''));
  const policyFailure = isCodingPolicyError(error) || error instanceof PostingPolicyError;
  // The coding-evidence gate's refusals (assertCurrentCodingEvidence) are
  // row receipts like the component ones; they are not policy incidents.
  const evidenceFailure = CODING_EVIDENCE_REFUSAL_CODES.includes(error?.code);
  if (!policyFailure && !aeVatFailure && !componentFailure && !processingScopeFailure && !evidenceFailure) return;
  if (policyFailure || aeVatFailure || processingScopeFailure) await recordCodingPolicyFailure({ client, firmId, clientId, transactionIds, error, operation: 'posting' });
  if (aeVatFailure || componentFailure || processingScopeFailure || evidenceFailure) {
    // The existing RT-23 projection must see refusal from direct/manual and
    // preview entrypoints too, not only after the auto-post sweep visits it.
    await client.query(`update transactions set payload = payload || jsonb_build_object('ledger_post_refusal', $4::jsonb)
      where firm_id = $1 and client_id = $2 and id = any($3::text[])
        and coalesce(coding_state, '') not in ('posted', 'synced', 'closed')`,
    [firmId, clientId, transactionIds, JSON.stringify({ code: error.code, error: error.message, details: error.details || null, source: evidenceFailure ? 'coding_evidence' : 'posting_policy' })]);
  }
};

const assertRetainedLedgerScope = async ({ client, firmId, clientId, actorId, resourceId, lock = true }) => {
  const decision = await evaluateRetainedProcessingScopeWithClient({ client, firmId, clientId, lock });
  if (decision.allowed) return;
  await recordEntityReadinessBlockedWithClient({ client: { query: queryFirmDb }, firmId, clientId,
    boundary: 'ledger_write', decision, actorId: actorId || 'ledger_command', resourceType: 'ledger_source', resourceId });
  throw Object.assign(new EntityReadinessAdmissionError(decision), { actorId });
};

export const rowToLedgerAccountPayload = (row = {}) => ({
  ...(row.payload || {}),
  id: row.id,
  firm_id: row.firm_id,
  client_id: row.client_id,
  code: row.code,
  name: row.name,
  account_type: row.account_type,
  normal_balance: row.normal_balance,
  currency: row.currency,
  tax_type: row.tax_type,
  xero_account_id: row.xero_account_id,
  canonical_role: row.canonical_role || null,
  status: row.status,
  // code === name happens when the legacy name-as-code fallback leaked into the
  // code slot of a code-less minted row — render the name once, not "X · X".
  account_label: row.code && row.name && row.code !== row.name ? `${row.code} · ${row.name}` : row.name || row.code || '',
  created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
  updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null
});

export const rowToLedgerJournalPayload = (row = {}) => ({
  ...(row.payload || {}),
  id: row.id,
  firm_id: row.firm_id,
  client_id: row.client_id,
  source_type: row.source_type,
  source_id: row.source_id,
  // toIsoDay — date column; see rowToTransactionPayload's date note.
  journal_date: row.journal_date ? toIsoDay(row.journal_date) : row.journal_date,
  currency: row.currency,
  status: row.status,
  memo: row.memo,
  // FI-5 — the persisted Finnish voucher number (tositenumero) + its tilikausi.
  // Both are DB columns (not payload JSONB), so this whitelist would drop them;
  // surfaced so the close UI can render the number (render-the-persisted-verdict).
  // Null on flag-off / pre-FI-5 journals.
  tosite_number: row.tosite_number ?? null,
  fiscal_year_id: row.fiscal_year_id ?? null,
  correction_type: row.correction_type || row.payload?.correction_type || null,
  correction_of_journal_id: row.correction_of_journal_id || row.payload?.correction_of_journal_id || null,
  reversal_of_journal_id: row.reversal_of_journal_id || row.payload?.reversal_of_journal_id || null,
  correction_reason: row.correction_reason || row.payload?.correction_reason || null,
  posted_at: row.posted_at ? new Date(row.posted_at).toISOString() : null,
  closed_at: row.closed_at ? new Date(row.closed_at).toISOString() : null,
  reversed_at: row.reversed_at ? new Date(row.reversed_at).toISOString() : null,
  created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
  updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null
});

export const rowToLedgerLinePayload = (row = {}) => ({
  ...(row.payload || {}),
  id: row.id,
  journal_id: row.journal_id,
  firm_id: row.firm_id,
  client_id: row.client_id,
  account_id: row.account_id,
  account_code: row.account_code,
  account_name: row.account_name,
  account_type: row.account_type || row.payload?.account_type,
  normal_balance: row.normal_balance || row.payload?.normal_balance,
  line_no: row.line_no,
  direction: row.direction,
  debit: Number(row.debit || 0),
  credit: Number(row.credit || 0),
  amount: Number(row.amount || 0),
  currency: row.currency,
  tax_type: row.tax_type,
  counterparty: row.counterparty,
  memo: row.memo,
  created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
  updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null
});

// The Donna-ledger chart for clients with no external accounting
// system. ledger_accounts is the client's REAL chart — the local
// ledger auto-creates rows at posting time (upsertLedgerAccountForJournal)
// and the missing-account pipeline adds verdict-named accounts. Mapped
// to the option shape the coding menu reads ({ name, code, type }).
export const getDonnaLedgerAccountsForClient = async ({ client, firmId, clientId }) => {
  if (!clientId) return [];
  const result = await client.query(
    `select id, code, name, account_type, normal_balance, currency, tax_type, canonical_role, status,
            payload->>'palette_name' as palette_name
       from ledger_accounts
      where firm_id = $1 and client_id = $2 and status = 'active'
      order by code nulls last, name`,
    [firmId, clientId]
  ).catch((error) => {
    if (error?.code === '42P01' || error?.code === '42703') return { rows: [] };
    throw error;
  });
  return result.rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.account_type,
    normal_balance: row.normal_balance,
    currency: row.currency,
    tax_type: row.tax_type,
    canonical_role: row.canonical_role,
    status: row.status,
    source: 'native_ledger',
    // A born coded row answers to the pack-palette name the coder uses
    // (FI-21); the account matcher resolves that name to this row.
    ...(row.palette_name ? { aliases: [row.palette_name] } : {})
  }));
};

// The market's declared cash account (FI: 1900 Käteinen raha) is offered
// before its first posting mints it — bank and cash rows are minted, not born
// (finland/provisioningPolicy.js), and an account the coder cannot name is a
// cash-box payment that can only go to suspense.
const declaredMenuAccounts = (ledgerAccounts = [], jurisdiction = null) => {
  const cash = resolveMarketPostingAccounts(jurisdiction)?.cashAccount?.();
  if (!cash || ledgerAccounts.some((account) => String(account.code || '').trim() === cash.code)) return [];
  return [{ code: cash.code, name: cash.name, type: cash.account_type, canonical_role: cash.canonical_role }];
};

// Menu accounts for a Donna-chart client: their accumulated
// ledger_accounts rows UNIONED with the base vocabulary. The union is
// load-bearing — a client whose ledger chart has one row (the first
// verdict-created account) must not have the coding menu collapse to
// that row + Suspense. accountOptionsForClient dedupes by name.
// gap 7: the base vocabulary is the client's own market's palette when the
// client is routed (clientProfile.accountPalette), and the legacy SG list
// otherwise — the same marker-routed resolution the coder's enum uses, so the
// menu and the enum can never disagree.
export const __donnaChartMenuAccounts = (ledgerAccounts = [], clientProfile = {}) => requireCodingPolicyForClient(clientProfile).nativeMenu
  ? requireCodingPolicyForClient(clientProfile).nativeMenu.choices.filter(choice => choice.kind === 'account')
  : [
  // A row the palette names is offered under that palette name (below), so
  // the coder's vocabulary is the same whether or not the book is coded.
  ...ledgerAccounts.filter((account) => !account.aliases?.length),
  ...declaredMenuAccounts(ledgerAccounts, requireCodingPolicyForClient(clientProfile).jurisdiction),
  ...fallbackAccountOptionsForClient(clientProfile).map((name) => ({ name }))
];

// FI-21: a journal account that names its account only by a pack-palette
// name (no code, or the name welded into the code slot) lands on the coded
// row born for that name, never on a code-less duplicate minted beside it.
// Both journal writers pass their accounts through here before the upsert,
// so every posting path (bank lines, bills, settlements, adjustments) agrees.
const resolvePaletteAliasAccountsWithClient = async ({ client, firmId, clientId, accounts = [] }) => {
  const nameOnly = (account = {}) => {
    const code = String(account.code || '').trim();
    const name = String(account.name || account.label || '').trim();
    return name && !String(account.xero_account_id || '').trim()
      && (!code || normalizeIntelText(code) === normalizeIntelText(name));
  };
  if (!accounts.some(nameOnly)) return accounts;
  const rows = (await client.query(
    `select code, name, payload->>'palette_name' as palette_name
       from ledger_accounts
      where firm_id = $1 and client_id = $2 and status = 'active'
        and coalesce(code, '') <> '' and payload ? 'palette_name'`,
    [firmId, clientId]
  )).rows;
  if (!rows.length) return accounts;
  const byAlias = new Map(rows.map((row) => [normalizeIntelText(row.palette_name), row]));
  return accounts.map((account) => {
    if (!nameOnly(account)) return account;
    const row = byAlias.get(normalizeIntelText(account.name || account.label));
    return row ? { ...account, code: row.code, name: row.name, label: `${row.code} · ${row.name}` } : account;
  });
};

// The ONE lookup a chat correction uses to turn the account name it was given
// into the client's ledger code (transaction chat apply / mark-personal /
// re-code, feed chat apply). The chat speaks pack-palette names, and a born
// coded row (FI-21) keeps that name only as its palette alias, so the match is
// the row's name OR its alias — the same alias rule the posting resolver above
// applies. Only rows that carry a code can answer, so a code-less duplicate
// named like the alias never shadows the coded row posting would land on.
// Precedence: the row's own name before another row's alias (the coder's
// account matcher order: code, name, then aliases), then a row whose code is
// the name itself, then the most recently updated. Returns null on a miss;
// it never makes up a code.
export const findLedgerAccountByNameOrAlias = async ({ query, firmId, clientId, name }) => {
  const label = String(name || '').trim();
  if (!clientId || !label) return null;
  const result = await query(
    `select id, code, name
       from ledger_accounts
      where firm_id = $1 and client_id = $2 and status = 'active'
        and coalesce(code, '') <> ''
        and (lower(name) = lower($3) or lower(payload->>'palette_name') = lower($3))
      order by (lower(name) = lower($3)) desc, (lower(code) = lower($3)) desc, updated_at desc
      limit 1`,
    [firmId, clientId, label]
  );
  return result.rows[0] || null;
};

// Account class (the missing-account vocabulary) → ledger normal
// balance. Pure; exported for tests.
export const __normalBalanceForAccountClass = (accountClass = '') =>
  ['liability', 'equity', 'revenue'].includes(String(accountClass || '').toLowerCase())
    ? 'credit'
    : 'debit';

// Resolve a ledger account's canonical role (the stable semantic identity —
// docs/donna-coa-architecture.md slice 2, vocabulary in accountRoles.js) at mint
// time. Precedence:
//   1. an explicit `canonical_role` the caller passes (a future provision_account
//      / strong-model path) — IF it is a real role,
//   2. a `role` field IF it is itself a canonical role — NOTE the ledger journal
//      builder's `account.role` is a LINE role ('counterparty' / 'bank'), NOT a
//      CoA role, so isAccountRole correctly rejects it and we fall through,
//   3. the explicit seed-name table for Donna's OWN known accounts
//      (roleForSeedName) — never a fuzzy classifier (the #497 guard),
//   4. null — an unknown (model-proposed) name whose role a later slice resolves.
// Pure; exported for tests.
export const __canonicalRoleForAccount = ({ name = '', role = null, canonical_role = null } = {}) => {
  if (isAccountRole(canonical_role)) return canonical_role;
  if (isAccountRole(role)) return role;
  return roleForSeedName(name) || null;
};

// Create the verdict-named account in the client's Donna chart.
// Additive and idempotent: the id keys on the account NAME — the same
// scheme upsertLedgerAccountForJournal uses for code-less accounts —
// so a later posting upsert lands on THIS row instead of minting a
// duplicate. Audits only on genuine insert (xmax = 0).
export const ensureLedgerAccountFromVerdict = async ({
  client,
  firmId,
  clientId,
  missingAccount = {},
  sourceTransactionId = null
} = {}) => {
  const name = String(missingAccount.name || '').trim();
  if (!clientId || !name) return null;
  const nativeLineage = await readNativeChartLineage({ query: client.query.bind(client), firmId, clientId, lock: true });
  if (nativeLineage) {
    const choice = resolveNativeAccountChoice(nativeAccountChoices(nativeCodingContext(nativeLineage)), missingAccount, { allowAlias: true });
    if (missingAccount.account_type != null && missingAccount.account_type !== choice.account_type) codingChoiceFailure('account_metadata_mismatch');
    return { accountId: choice.id, name: choice.name, accountType: choice.account_type, inserted: false };
  }
  const aliased = (await client.query(
    `select id, name, account_type from ledger_accounts
      where firm_id = $1 and client_id = $2 and coalesce(code, '') <> ''
        and lower(payload->>'palette_name') = lower($3)
      limit 1`,
    [firmId, clientId, name]
  )).rows[0];
  if (aliased) return { accountId: aliased.id, name: aliased.name, accountType: aliased.account_type, inserted: false };
  const accountType = String(missingAccount.account_type || '').trim().toLowerCase() || 'unknown';
  const accountId = ledgerRecordId('account', firmId, clientId, name);
  // A verdict carries only a name (+ a coarse class). roleForSeedName resolves it
  // when it's one of Donna's own known accounts; a model-proposed business name
  // returns null, for a later slice to resolve. coalesce on conflict never clobbers
  // a role already set (e.g. by a human / model) with a re-derived null.
  const canonicalRole = __canonicalRoleForAccount({ name });
  const result = await client.query(
    `insert into ledger_accounts (
       id, firm_id, client_id, code, name, account_type, normal_balance, currency, tax_type, canonical_role, status, payload
     )
     values ($1, $2, $3, null, $4, $5, $6, null, null, $7, 'active', $8::jsonb)
     on conflict (id) do update set
       status = 'active',
       canonical_role = coalesce(ledger_accounts.canonical_role, excluded.canonical_role),
       updated_at = now()
     returning (xmax = 0) as inserted`,
    [
      accountId,
      firmId,
      clientId,
      name,
      accountType,
      __normalBalanceForAccountClass(accountType),
      canonicalRole,
      JSON.stringify({
        source: 'missing_account_verdict',
        label: name,
        reason: missingAccount.reason || null,
        source_transaction_id: sourceTransactionId
      })
    ]
  );
  const inserted = Boolean(result.rows[0]?.inserted);
  if (inserted) {
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
       values ($1, $2, 'system', 'ledger.account.created_from_verdict', 'ledger_account', $3, $4::jsonb)`,
      [
        firmId,
        clientId,
        accountId,
        JSON.stringify({
          name,
          account_type: accountType,
          reason: missingAccount.reason || null,
          source_transaction_id: sourceTransactionId
        })
      ]
    );
  }
  return { accountId, name, accountType, inserted };
};

// Once the verdict-named account exists in the chart, the park
// resolves mechanically — the verdict already names the account it
// wanted; no second model call. The line STAYS a suggestion (see the
// missing_account_resolved veto in the auto-apply gate): the first
// posting into a just-created account gets one human glance. Pure;
// exported for tests.
export const __resolveMissingAccountSuggestion = (suggestion = {}, { accountId = null, resolvedAt = Date.now() } = {}) => {
  const missing = suggestion?.missing_account;
  if (!missing || !missing.name) return suggestion;
  return {
    ...suggestion,
    proposed_account: missing.name,
    account_code: missing.name,
    missing_account: null,
    missing_account_resolved: {
      ...missing,
      account_id: accountId,
      resolved_at: resolvedAt
    }
  };
};

// FI-9 trigger wiring (docs/design-donna-finland-fi9-trigger-wiring.md §T.1) —
// the AP-settlement plan for a Donna-ledger bank-line post. Resolved at PREPARE,
// executed at COMMIT: when a money-out line has exactly ONE decided
// (confirmed/auto_matched) supplier_bill match and the gates hold (flag acts,
// accrual basis, document currency == transaction currency), the commit posts
// the AP journal first (the #914 writer — DR expense / CR 2870, invoice-dated)
// and then the settlement journal with its counterparty SWAPPED to the same
// payables account (DR 2870 / CR bank, payment-dated) in the SAME transaction.
// A failed gate returns { planned: false, reason } — the post proceeds exactly
// as today and the reason rides the ledger.post_transaction receipt (D-FI9-P2,
// nothing silent). Provenance-agnostic: any completed supplier_bill qualifies,
// not only e-invoice-minted ones.
const resolveApSettlementPlan = async ({ client, firmId, clientId, transaction, postingContext }) => {
  const admissionFlag = postingContext.policy.supplierBillAdmissionFlagKey;
  if (!admissionFlag || !clientFlagActs({ flagKey: admissionFlag, snapshot: postingContext.snapshot, envFallback: () => false })) {
    return { planned: false, reason: 'flag_off' };
  }
  if (clientAccountingBasisFromProfile(postingContext.row) !== 'accrual') {
    return { planned: false, reason: 'cash_basis' };
  }

  // A supplier bill settles through a money-OUT line; swapping the coding on a
  // receive line would post DR bank / CR 2870 (a payable INCREASE), never right.
  if (ledgerTransactionDirection(transaction) !== 'spend') {
    return { planned: false, reason: 'not_money_out' };
  }

  const matches = await client.query(
    `select d.id, d.currency, d.reference_number, d.vendor_name
       from reconciliation_matches m
       join documents d
         on d.firm_id = m.firm_id and d.id = m.matched_object_id
      where m.firm_id = $1
        and m.client_id = $2
        and m.bank_transaction_id = $3
        and m.matched_object_type = 'supplier_bill'
        and m.status in ('confirmed', 'auto_matched')`,
    [firmId, clientId, transaction.id]
  );
  if (!matches.rows.length) return { planned: false, reason: 'no_decided_match' };
  // One line settling MANY bills is split territory, not v1 (§T.3).
  if (new Set(matches.rows.map((row) => row.id)).size > 1) {
    return { planned: false, reason: 'multiple_bill_matches' };
  }
  const doc = matches.rows[0];
  const txCurrency = String(transaction.account_currency || transaction.currency || '').trim().toUpperCase();
  const docCurrency = String(doc.currency || '').trim().toUpperCase();
  if (!txCurrency || !docCurrency || txCurrency !== docCurrency) {
    return { planned: false, reason: 'currency_mismatch' };
  }
  return {
    planned: true,
    document_id: doc.id,
    reference_number: doc.reference_number || null,
    vendor_name: doc.vendor_name || null
  };
};

// D-FI9-P2 — the ENUMERATED refusals of the AP leg. Any of these at commit
// means "no AP journal for a stated reason": the settlement posts exactly as
// today (byte-identical journal) with the reason receipted. Anything else is
// an unexpected error and fails the whole post — falling back silently on a
// transient DB error would launder an accrual gap as a decision. Every code
// here is thrown by postSupplierBillJournalWithClient/buildSupplierBillJournal
// BEFORE any ledger write, so the transaction stays clean for the fallback.
const AP_SETTLEMENT_FALLBACK_CODES = new Set([
  'FINLAND_EINVOICE_RECEIVE_DISABLED',
  'SUPPLIER_BILL_CASH_BASIS_NO_AP_POST',
  'SUPPLIER_BILL_CODING_VERDICT_REQUIRED',
  'SUPPLIER_BILL_CODING_NOT_CONFIDENT',
  'SUPPLIER_BILL_CODING_RED_ACCOUNT',
  'SUPPLIER_BILL_DOCUMENT_NOT_FOUND',
  'SUPPLIER_BILL_WRONG_DOCUMENT_TYPE',
  'SUPPLIER_BILL_PARSE_NOT_COMPLETED',
  'SUPPLIER_BILL_DUPLICATE_DOCUMENT',
  // FI-3 slice S: UNSUPPORTED now means the verdict carries no resolvable ALV
  // treatment; MISMATCH means the bill's stated VAT disagrees with the code's
  // rate arithmetic (D-FI3-S4) — both refuse before any write. RT-23
  // (2026-09-09): for a P&L-coded line the UNSUPPORTED case is no longer
  // reachable here — assertPostableTaxCoding refuses the WHOLE post at prepare
  // (TRANSACTION_ALV_TREATMENT_UNRESOLVED), so the "fallback" journal that
  // used to post the expense gross and uncoded never forms. The code stays
  // enumerated for a non-P&L coding (an asset-coded bill) and for the GB twin.
  'SUPPLIER_BILL_ALV_SPLIT_UNSUPPORTED',
  'SUPPLIER_BILL_ALV_AMOUNT_MISMATCH',
  'SUPPLIER_BILL_ALV_SPLIT_UNBALANCED',
  // IV-1 — the GB AP twin's refusals (design-donna-gb-input-vat-boxes-4-7.md
  // §2): same posture as the ALV trio above, thrown before any ledger write.
  'SUPPLIER_BILL_GB_VAT_SPLIT_UNSUPPORTED',
  'SUPPLIER_BILL_GB_VAT_AMOUNT_MISMATCH',
  'SUPPLIER_BILL_GB_VAT_CONTROL_UNRESOLVED',
  'SUPPLIER_BILL_GB_PAYABLES_UNRESOLVED',
  'SUPPLIER_BILL_MISSING_DOCUMENT_ID',
  'SUPPLIER_BILL_MISSING_DATE',
  'SUPPLIER_BILL_NON_POSITIVE_TOTAL',
  'SUPPLIER_BILL_MISSING_EXPENSE_ACCOUNT',
  'LEDGER_LOCKED_PERIOD_IMMUTABLE'
]);

// F-G8-1 (docs/design-donna-finland-ar-settlement-posting.md) — the AR
// settlement plan for a Donna-ledger bank-line post: the exact mirror of the
// AP plan above, for money-IN lines paying a Donna-ISSUED invoice. Resolved at
// PREPARE, executed at COMMIT as a pure coding swap (CR revenue → CR 1700
// Myyntisaamiset, the receivable already booked at issuance — no second
// journal, so unlike AP there is no commit-time writer to fail: the plan's
// typed reasons are the complete enumeration). The decision logic lives PURE
// in finland/issuedInvoiceSettlement.js (planArSettlement); this resolver only
// hydrates it. A failed gate returns { planned:false, reason } — the post
// proceeds exactly as today with the reason receipted (nothing silent).
const resolveArSettlementPlan = async ({ client, firmId, clientId, transaction, postingContext }) => {
  const { policy, snapshot } = postingContext;
  const arActs = policy.arSettlementFlagKey && clientFlagActs({ flagKey: policy.arSettlementFlagKey, snapshot, envFallback: () => false });
  if (!arActs) return { planned: false, reason: 'flag_off' };
  const planArSettlement = (input) => executePostingPolicyOperation(policy, 'planArSettlement', input);
  const basis = clientAccountingBasisFromProfile(postingContext.row);
  const direction = ledgerTransactionDirection(transaction);
  const amountEur = Number(transaction.money_in) || 0;
  if (basis !== 'accrual' || direction !== 'receive' || !(amountEur > 0)) {
    return planArSettlement({ flagActs: true, basis, direction, amountEur });
  }

  const invoiceResult = await client.query(
    `select id,
            buyer_name,
            draft->'invoice'->>'invoiceNumber' as display_number,
            draft->'invoice'->>'total' as total,
            draft->'invoice'->>'currency' as currency,
            coalesce(draft->'finvoice'->'invoiceDetails'->>'referenceNumber',
                     draft->'finvoice'->'paymentDetails'->>'referenceNumber') as reference_number
       from issued_invoices
      where firm_id = $1 and client_id = $2
        and status = 'issued'
        and coalesce(kind, 'invoice') = 'invoice'`,
    [firmId, clientId]
  );
  const matched = invoiceResult.rows.filter((inv) => paymentMatchesInvoice(
    { referenceNumber: inv.reference_number, invoiceNumber: inv.display_number },
    transaction
  ));
  if (matched.length !== 1) {
    return planArSettlement({
      flagActs: true,
      basis,
      direction,
      amountEur,
      transactionCurrency: transaction.account_currency || transaction.currency || null,
      matchCount: matched.length,
      candidate: matched.length ? {} : null
    });
  }

  const inv = matched[0];
  // KEEP hydration: the issuance journal (source-keyed sales_invoice/<number>)
  // must exist for the swap to clear a receivable that was actually booked.
  const issuanceJournal = await client.query(
    `select id from ledger_journals
      where firm_id = $1 and client_id = $2
        and source_type = 'sales_invoice' and source_id = $3
      limit 1`,
    [firmId, clientId, inv.display_number]
  );
  const creditResult = await client.query(
    `select coalesce(sum((draft->'invoice'->>'total')::numeric), 0) as credited
       from issued_invoices
      where firm_id = $1 and client_id = $2
        and kind = 'credit_note'
        and status = 'issued'
        and credits_invoice_id = $3`,
    [firmId, clientId, inv.id]
  );
  // What already cleared 1700 for this invoice = prior lines posted with the
  // applied ar_settlement marker (the ledger's own record — D-AR-4, no
  // stored settlement state beyond the receipt itself).
  const settledResult = await client.query(
    `select coalesce(sum(money_in), 0) as settled
       from transactions
      where firm_id = $1 and client_id = $2
        and id <> $3
        and payload->'ar_settlement'->>'invoice_id' = $4`,
    [firmId, clientId, transaction.id, inv.id]
  );

  return planArSettlement({
    flagActs: true,
    basis,
    direction,
    amountEur,
    transactionCurrency: transaction.account_currency || transaction.currency || null,
    matchCount: 1,
    candidate: {
      invoice_id: inv.id,
      invoice_number: inv.display_number || null,
      reference_number: inv.reference_number || null,
      buyer_name: inv.buyer_name || null,
      currency: inv.currency,
      total_eur: Number(inv.total) || 0,
      credited_total_eur: Number(creditResult.rows[0]?.credited) || 0,
      settled_before_eur: Number(settledResult.rows[0]?.settled) || 0,
      has_issuance_journal: issuanceJournal.rows.length > 0
    }
  });
};

// The AR settlement leg's swapped coding — same shape as the AP helper above,
// off the SAME constant the issuance journal's DR side uses (D-AR-3: no drift).
const arSettlementReceivableCoding = (postingContext) =>
  executePostingPolicyOperation(postingContext.policy, 'arSettlementReceivableCoding');

// ── RT-21f — the settlement-row split (RT-18 §4 (i)–(iii)) ─────────────────
// A money-in line settled by a koontilasku ROW (RT-21c: a decided match with
// matched_line_id; RT-21b: the row's printed gross / fee / net under
// document_lines.payload.raw_extraction.settlement_row) posts
//   Dr bank NET · Dr expense.platform_fees fee (tax NONE) · Cr revenue GROSS
// with the coding's tax code on the revenue leg (an FI ALV split is taken on
// the GROSS — the VAT base is the sale, not the bank receipt). The split is
// DERIVED here from the matched row, never emitted by the model, and it
// refuses by name whenever the row and the bank line disagree:
//   SETTLEMENT_SPLIT_BANK_AMOUNT_MISMATCH  the row's net ≠ the bank amount
//   SETTLEMENT_SPLIT_CURRENCY_MISMATCH     statement and bank currencies differ
//   SETTLEMENT_SPLIT_ROW_INCOMPLETE        the row printed no usable gross
//   SETTLEMENT_SPLIT_MULTIPLE_ROWS         two decided row matches on one line
//   SETTLEMENT_SPLIT_CODING_NOT_REVENUE    the line is coded to a non-revenue
//                                          account (e.g. a clearing rule) —
//                                          a fee-and-gross split has no meaning
//                                          there; surfaced, never blessed
//   SETTLEMENT_SPLIT_FEE_ACCOUNT_MISSING   no active expense.platform_fees
//                                          account in the client's chart
// Not planned (the two-line journal as before): no decided row match on the
// line, or a money-out line. Donna-ledger clients only (the Xero/QBO bank
// transaction is written by the connector's own shape — RT-21 handoff §4).
export const SETTLEMENT_SPLIT_FEE_ROLE = 'expense.platform_fees';
const SETTLEMENT_SPLIT_REVENUE_CLASSES = new Set(['revenue', 'income', 'sales', 'other_income']);
const settlementRound2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const refuseSettlementSplit = (code, message, details = {}) => {
  throw Object.assign(new Error(message), { code, statusCode: 409, details });
};

export const resolveSettlementRowSplit = async ({ client, firmId, clientId, transaction, coding = {}, ledgerAccounts = [], postingContext = null, lock = false } = {}) => {
  if (ledgerTransactionDirection(transaction) !== 'receive') return { planned: false, reason: 'not_money_in' };
  const rows = await client.query(
    `select m.id as match_id, m.matched_line_id, m.status,
            dl.line_no, dl.description as row_label, dl.amount as row_net,
            dl.payload->'raw_extraction'->'settlement_row' as settlement_row,
            d.id as document_id, d.document_type, d.currency as document_currency
       from reconciliation_matches m
       join document_lines dl on dl.id = m.matched_line_id and dl.firm_id = m.firm_id
       join documents d on d.id = m.matched_object_id and d.firm_id = m.firm_id
      where m.firm_id = $1
        and m.client_id = $2
        and m.bank_transaction_id = $3
        and m.matched_line_id is not null
        and m.status in ('confirmed', 'auto_matched')
        and dl.payload->'raw_extraction'->'settlement_row' is not null
        ${lock ? 'for update of m,dl,d' : ''}`,
    [firmId, clientId, transaction.id]
  ).catch((error) => {
    if (error?.code === '42P01' || error?.code === '42703') return { rows: [] };
    throw error;
  });
  // Only a decided match that names a persisted settlement ROW plans a split;
  // anything else (a document-level match, a fixture row without the payload)
  // is the two-line journal as before — never a refusal.
  const rowMatches = (rows.rows || []).filter((r) => r && r.matched_line_id && r.settlement_row && typeof r.settlement_row === 'object');
  if (!rowMatches.length) return { planned: false, reason: 'no_settlement_row_match' };
  if (rowMatches.length > 1) {
    refuseSettlementSplit('SETTLEMENT_SPLIT_MULTIPLE_ROWS',
      `Bank line ${transaction.id} carries ${rows.rows.length} decided settlement-row matches — one bank line settles one row.`,
      { match_ids: rowMatches.map((r) => r.match_id) });
  }
  const row = rowMatches[0];
  const sr = row.settlement_row && typeof row.settlement_row === 'object' ? row.settlement_row : {};
  const gross = settlementRound2(sr.gross);
  const fee = settlementRound2(sr.fee ?? 0);
  const feeTax = settlementRound2(sr.fee_tax ?? 0);
  const net = settlementRound2(sr.net ?? row.row_net);
  const bankAmount = settlementRound2(transaction.money_in);
  const txCurrency = String(transaction.account_currency || transaction.currency || '').trim().toUpperCase();
  const docCurrency = String(row.document_currency || '').trim().toUpperCase();
  if (txCurrency && docCurrency && txCurrency !== docCurrency) {
    refuseSettlementSplit('SETTLEMENT_SPLIT_CURRENCY_MISMATCH',
      `The statement is in ${docCurrency} but the bank line is in ${txCurrency} — a settlement split never converts.`);
  }
  if (!(gross > 0)) {
    refuseSettlementSplit('SETTLEMENT_SPLIT_ROW_INCOMPLETE',
      `Settlement row ${row.line_no} of ${row.document_id} printed no usable gross — cannot book sales gross and the fee.`);
  }
  if (settlementRound2(gross - fee - feeTax) !== bankAmount || net !== bankAmount) {
    refuseSettlementSplit('SETTLEMENT_SPLIT_BANK_AMOUNT_MISMATCH',
      `Settlement row ${row.line_no} (${row.row_label || ''}) nets ${net} (gross ${gross} − fee ${fee} − fee tax ${feeTax}) but the bank line is ${bankAmount} — refusing rather than shading either.`,
      { document_id: row.document_id, line_no: row.line_no, gross, fee, fee_tax: feeTax, net, bank_amount: bankAmount });
  }
  const codedClass = String(coding.xero_account_type || coding.account_type || coding.type || '').trim().toLowerCase();
  if (!SETTLEMENT_SPLIT_REVENUE_CLASSES.has(codedClass)) {
    refuseSettlementSplit('SETTLEMENT_SPLIT_CODING_NOT_REVENUE',
      `Bank line ${transaction.id} settles statement row ${row.line_no} but is coded to ${coding.account_label || coding.account_name || coding.account_code || 'an uncoded account'} (${codedClass || 'unknown class'}) — a card-sales settlement books sales gross and the fee, not a ${codedClass || 'non-revenue'} account.`,
      { account_code: coding.account_code || null, account_class: codedClass || null });
  }
  const feeDeduction = settlementRound2(fee + feeTax);
  const feeAccountRow = feeDeduction > 0
    ? (ledgerAccounts || []).find((account) => String(account?.canonical_role || '') === SETTLEMENT_SPLIT_FEE_ROLE && (!account.status || account.status === 'active'))
    : null;
  if (feeDeduction > 0 && !feeAccountRow) {
    refuseSettlementSplit('SETTLEMENT_SPLIT_FEE_ACCOUNT_MISSING',
      `No active ledger account carries the role ${SETTLEMENT_SPLIT_FEE_ROLE} — the processor fee of ${feeDeduction} has nowhere to post.`);
  }
  const prior = (await client.query(`select lj.id from ledger_journals lj
    left join transactions posted on posted.firm_id=lj.firm_id and posted.client_id=lj.client_id and posted.id=lj.source_id
    where lj.firm_id=$1 and lj.client_id=$2 and lj.status='posted' and lj.source_id<>$3
      and (lj.source_id=$4 or lj.payload->'settlement_split'->'row'->>'line_id'=$5
        or posted.payload->'settlement_split'->>'line_id'=$5) limit 1`,
    [firmId,clientId,transaction.id,row.document_id,row.matched_line_id])).rows[0];
  if (prior) refuseSettlementSplit('SETTLEMENT_SPLIT_ALREADY_RECOGNIZED',
    'The matched statement or settlement row is already recognized. Reconcile its existing clearing/receivable posting instead of recognizing sales again.', { journal_id: prior.id });
  let feeAlvSplit = null;
  const feeTreatment = transaction.ai_suggestion?.processor_fee_tax_treatment;
  const feeTaxPlan = (feeTreatment || feeTax > 0) && postingContext?.policy?.capabilities.sourceTaxPosting
    ? executePostingPolicyOperation(postingContext.policy, 'sourceTaxPosting', { taxTreatment: feeTreatment || '', direction: 'in', gross: feeDeduction })
    : null;
  if (feeTax === 0 && feeTreatment && feeTaxPlan?.split) {
    refuseSettlementSplit('SETTLEMENT_SPLIT_FEE_TAX_UNRESOLVED', 'The selected fee tax would invent VAT on a source fee with no VAT. Correct the fee treatment.');
  }
  if (feeTax > 0) {
    const split = feeTaxPlan?.split;
    if (!split || Math.abs(split.vat - feeTax) > 0.02) refuseSettlementSplit('SETTLEMENT_SPLIT_FEE_TAX_UNRESOLVED',
      'The source fee includes tax; select its supported fee-tax treatment before posting.', { fee, fee_tax: feeTax });
    feeAlvSplit = { ...split, net: fee, vat: feeTax };
    // The fee leg carries its own tax code and VAT split, whatever the sales
    // leg carries (with the country's tax-coding switch off, the sales leg is
    // not checked for one). Registration binds it the same way: the policy's
    // own reader on the line's date; only a recorded registration posts.
    const registrationRule = postingContext?.policy?.taxRegistration;
    if (registrationRule) {
      const onDate = transaction.date || transaction.transaction_date;
      const registration = registrationRule.onDate({ profile: postingContext.profile || null, onDate });
      if (registration?.registered !== true) refuseSettlementSplit(registrationRule.refusalCodes[0],
        'The processor fee would post its VAT split, but the business is not recorded as VAT-registered on this date, so nothing was posted. Record the registration (or correct the fee coding) and post again.',
        { vat_code: feeTaxPlan.code || null, as_of: String(onDate || '').slice(0, 10) || null, registered: registration?.registered ?? null, registration_reason: registration?.reason || null });
    }
  }
  const rowReceipt = {
    document_id: row.document_id,
    document_type: row.document_type,
    match_id: row.match_id,
    line_id: row.matched_line_id,
    line_no: Number(row.line_no),
    label: row.row_label || null
  };
  return {
    planned: true,
    split: {
      gross,
      fee,
      fee_tax: feeTax,
      ...(feeAlvSplit ? { fee_alv_split: feeAlvSplit } : {}),
      net,
      feeAccount: feeAccountRow
        ? { code: feeAccountRow.code, name: feeAccountRow.name, role: SETTLEMENT_SPLIT_FEE_ROLE, account_type: feeAccountRow.type || feeAccountRow.account_type || 'expense', xero_account_id: feeAccountRow.xero_account_id || '' }
        : null,
      row: rowReceipt
    },
    receipt: { ...rowReceipt, gross, fee, fee_tax: feeTax, net, fee_account_code: feeAccountRow?.code || null }
  };
};

// The ALV split for a settlement-split line is taken on the GROSS (the sale),
// so the policy's transactionSplit is asked about a transaction whose money_in
// is the row's gross — explicitly, never by shading the real line.
// RT-23 — policies that declare the invariant run it; the others (no tax
// coding on the bank-line post path yet) are a documented no-op, never an
// implicit one: the capability table names each.
export const authoritativeTaxCoding = (transaction) => ({ ...codingInputFromTransaction(transaction),
  tax_type: transaction.tax_type || transaction.ai_suggestion?.tax_type || '' });
export const assertPostableTaxCoding = (policy, input) => {
  if (!policy?.capabilities?.assertPostableTaxCoding) return;
  executePostingPolicyOperation(policy, 'assertPostableTaxCoding', { ...input, sourceCoding: authoritativeTaxCoding(input.transaction || {}),
    autonomousCoding: autonomousCoding(input.transaction || {}) });
};

const settlementAlvSplit = (policy, { coding, transaction, settlementSplit }) =>
  policy.capabilities.transactionSplit ? executePostingPolicyOperation(policy, 'transactionSplit', {
    coding,
    transaction: settlementSplit?.planned ? { ...transaction, money_in: settlementSplit.split.gross, money_out: 0 } : transaction
  }) : null;

const prepareLedgerTransactionPosting = async ({
  client,
  firmId,
  clientId,
  transactionId,
  dryRun = true,
  force = false,
  skipClientCheck = false,
  refundGroupManaged = false,
  correctionSuggestion = null
} = {}) => {
  if (!skipClientCheck) await requireClientInFirm({ client, firmId, clientId });
  const transactionResult = await client.query(
    `select * from transactions where firm_id = $1 and client_id = $2 and id = $3${dryRun ? '' : ' for update'}`,
    [firmId, clientId, transactionId]
  );
  const transactionRow = transactionResult.rows[0];
  if (!transactionRow) {
    const error = new Error('Transaction not found for ledger posting.');
    error.statusCode = 404;
    throw error;
  }
  const transaction = rowToTransactionPayload(transactionRow);
  // Read-only reconstruction for the correction writer. Never persist a new
  // coding over the posted row before the journal consequence commits.
  if (correctionSuggestion) {
    for (const key of ['accepted_coding_evidence','accepted_coding_policy','tax_posting_facts',
      'category','account_code','account_name','account_label','proposed_account',
      'xero_account_code','xero_account_name','xero_account_type','xero_tax_type','tax_type','tax_code']) delete transaction[key];
    Object.assign(transaction, { ai_suggestion: correctionSuggestion, ai_suggestion_status: 'auto_applied',
      category: correctionSuggestion.proposed_account, proposed_account: correctionSuggestion.proposed_account,
      account_code: correctionSuggestion.account_code || correctionSuggestion.proposed_account,
      tax_treatment: correctionSuggestion.tax_treatment });
  }
  if (transaction.jev_refund_group?.status === 'selected' && !refundGroupManaged) throw Object.assign(new Error('The complete selected refund group must post atomically.'), {code:'REFUND_GROUP_POSTING_REQUIRED',statusCode:409});
  const matchedDocument = await assertCurrentCodingEvidence({ client, firmId, clientId, transaction });
  const sourceReceipt = postingSourceReceipt(transaction);
  const reviewResult = await client.query(
    `select payload
     from transaction_review_queue
     where firm_id = $1
       and client_id = $2
       and (
         item_id = $3
         or payload->>'transaction_id' = $3
       )
     order by updated_at desc
     limit 1`,
    [firmId, clientId, transactionId]
  );
  const reviewRow = reviewResult.rows[0];
  if (reviewRow) {
    // The case file may supply a note, never replace the source transaction's
    // account/tax decision, evidence amounts, identity or accepted policy.
    transaction.reviewer_note ||= reviewRow.payload?.reviewer_note || null;
  }
  if (!dryRun && !force && transaction.ledger_journal_id) {
    const error = new Error('Transaction has already been posted to the Donna ledger.');
    error.statusCode = 409;
    error.code = 'LEDGER_ALREADY_POSTED';
    throw error;
  }
  const postingContext = await resolvePostingContextWithClient({ client, firmId, clientId, businessDate: transaction.date, lockContext: !dryRun });
  assertPostingSuggestionLineage(postingContext, transaction);
  // A Donna-ledger-only client (accounting_system = 'none') has an EMPTY
  // xero_accounts mirror, so the Xero builder can never resolve its bank
  // account ("No Xero bank account is synced…" on every post — the
  // client-portal reports-all-zeros root cause). Its account universe is its
  // OWN ledger_accounts chart; see donnaLedgerWriteback.js for the mint-by-name
  // and synthesized-default-bank posture. Every other client keeps the Xero
  // builder verbatim.
  const accountingSystem = await getClientAccountingSystemWithClient({ client, firmId, clientId });
  let preview;
  let apSettlement = null;
  let arSettlement = null;
  let settlementSplit = null;
  let taxPostingContext = null;
  let documentAllocation = null;
  if (accountingSystem === 'none') {
    const ledgerAccounts = await getDonnaLedgerAccountsForClient({ client, firmId, clientId });
    const { policy, taxCodingEnabled } = postingContext;
    taxPostingContext = await loadTaxPostingContext({ client, firmId, clientId, transaction, postingContext, ledgerAccounts, lock: !dryRun });
    preview = buildDonnaLedgerWriteback({
      transaction,
      jurisdiction: postingContext.policy.jurisdiction,
      ledgerAccounts: executePostingPolicyOperation(policy, 'prepareLedgerAccounts', { ledgerAccounts, taxCodingEnabled })
    });
    preview = { ...preview, coding: executePostingPolicyOperation(policy, 'enrichCoding', {
      coding: preview.coding, sourceCoding: authoritativeTaxCoding(transaction), transaction, ledgerAccounts, taxCodingEnabled, taxPostingContext
    }) };
    // RT-23: the Keep layer refuses an unresolved tax treatment on a P&L leg
    // before any journal is shaped — in the preview too, so the consequence
    // diff says "cannot commit" rather than rendering a code-less post.
    assertPostableTaxCoding(policy, { coding: preview.coding, transaction, taxCodingEnabled, profile: postingContext.profile, taxPostingContext, matchedDocument });
    documentAllocation = await resolveDocumentAllocation({ client, firmId, clientId, transaction, postingContext, ledgerAccounts, coding: preview.coding });
    // FI-9 wiring (D-FI9-P1): resolve the AP-settlement plan for the Donna
    // branch only — commit executes it (or receipts why not). The preview
    // coding stays the coder's verdict either way: the swap happens at commit,
    // and ONLY after the AP leg has actually posted.
    apSettlement = documentAllocation ? null : await resolveApSettlementPlan({ client, firmId, clientId, transaction, postingContext });
    // F-G8-1: the AR mirror — mutually exclusive with the AP plan by direction
    // (spend vs receive); at most one of the two ever plans.
    arSettlement = await resolveArSettlementPlan({ client, firmId, clientId, transaction, postingContext });
    // RT-21f: a bank line settled by a koontilasku row posts the row's split.
    settlementSplit = await resolveSettlementRowSplit({ client, firmId, clientId, transaction, coding: preview.coding, ledgerAccounts, postingContext });
    if (preview.coding.ae_vat_split && (apSettlement?.planned || arSettlement?.planned || settlementSplit?.planned)) {
      throw Object.assign(new Error('Native UAE standard VAT does not support AP, AR or processor settlement in this slice.'), { code: 'TRANSACTION_AE_VAT_SCOPE_UNSUPPORTED', statusCode: 409 });
    }
  } else {
    const xeroAccounts = await getXeroAccountsForClient({ client, firmId, clientId });
    preview = buildXeroBankTransactionWriteback({ transaction, xeroAccounts, xeroContacts: [], jurisdiction: postingContext.policy.jurisdiction });
    const { policy, taxCodingEnabled } = postingContext;
    preview = { ...preview, coding: executePostingPolicyOperation(policy, 'enrichCoding', {
      coding: preview.coding, sourceCoding: authoritativeTaxCoding(transaction), transaction, ledgerAccounts: xeroAccounts, taxCodingEnabled
    }) };
    assertPostableTaxCoding(policy, { coding: preview.coding, transaction, taxCodingEnabled, profile: postingContext.profile, matchedDocument });
  }
  const ledgerPreview = buildLedgerJournalForTransaction({
    transaction,
    coding: preview.coding,
    bankAccount: preview.bank_account,
    alvSplit: settlementAlvSplit(postingContext.policy, { coding: preview.coding, transaction, settlementSplit }),
    settlementSplit: settlementSplit?.planned ? settlementSplit.split : null,
    documentAllocation
  });
  return { transaction, preview, ledgerPreview, documentAllocation, apSettlement, arSettlement, settlementSplit, postingContext, sourceReceipt, taxFactsReceipt: taxPostingContext ? taxFactsDigest(taxPostingContext) : null };
};

const ledgerPostingPreviewPayload = ({ clientId, transactionId, prepared }) => ({
  source: 'ledger_posting_preview',
  dry_run: true,
  client_id: clientId,
  transaction_id: transactionId,
  coding: prepared.preview.coding,
  posting_policy: prepared.postingContext.receipt,
  bank_account: prepared.preview.bank_account,
  ledger_journal: prepared.ledgerPreview,
  ...(prepared.documentAllocation ? { document_allocation: prepared.documentAllocation } : {}),
  ...(prepared.apSettlement ? { ap_settlement: prepared.apSettlement } : {}),
  ...(prepared.arSettlement ? { ar_settlement: prepared.arSettlement } : {}),
  ...(prepared.settlementSplit?.planned ? { settlement_split: prepared.settlementSplit.receipt } : {})
});

const commitPreparedLedgerPosting = async ({
  client,
  firmId,
  clientId,
  transactionId,
  prepared,
  actorId = null
} = {}) => {
  const currentRow = (await client.query('select * from transactions where firm_id = $1 and client_id = $2 and id = $3 for update', [firmId, clientId, transactionId])).rows[0];
  assertPostingSourceReceipt(rowToTransactionPayload(currentRow || {}), prepared.sourceReceipt);
  const currentContext = await resolvePostingContextWithClient({ client, firmId, clientId,
    businessDate: prepared.transaction.date, lockContext: true });
  assertPostingContextReceipt(currentContext, prepared.postingContext?.receipt);
  assertPostingSuggestionLineage(currentContext, prepared.transaction);
  const currentTransaction = rowToTransactionPayload(currentRow || {});
  const matchedDocument = await assertCurrentCodingEvidence({ client, firmId, clientId, transaction: currentTransaction, lock: true });
  const taxPostingContext = await loadTaxPostingContext({ client, firmId, clientId, transaction: currentTransaction,
    postingContext: currentContext, ledgerAccounts: currentTransaction.tax_posting_facts ? await getDonnaLedgerAccountsForClient({ client, firmId, clientId }) : [], lock: true });
  if (prepared.taxFactsReceipt && prepared.taxFactsReceipt !== taxFactsDigest(taxPostingContext)) {
    throw Object.assign(new Error('The prepared tax facts, document or chart changed. Prepare again.'), { code: 'TRANSACTION_AE_VAT_FACTS_STALE', statusCode: 409 });
  }
  assertPostableTaxCoding(currentContext.policy, { coding: prepared.preview.coding, transaction: currentTransaction,
    taxCodingEnabled: currentContext.taxCodingEnabled, profile: currentContext.profile, taxPostingContext, matchedDocument });
  // FI-9 wiring (§T.1): the AP leg FIRST, in this same transaction. On success
  // the settlement journal's counterparty swaps to the payables account the AP
  // journal credited (DR 2870 / CR bank — the payable clears instead of the
  // expense double-booking). On an ENUMERATED refusal the line posts exactly
  // as today with the reason receipted (D-FI9-P2); an unexpected error throws
  // and the whole post rolls back. The row's coding verdict (ai_suggestion)
  // stays untouched either way (D-FI9-P4) — only the journal and the
  // account_code/category columns follow 2870.
  let journalCoding = prepared.preview.coding;
  let apSettlement = null;
  if (prepared.apSettlement?.planned) {
    const plan = prepared.apSettlement;
    // The DR side of the AP journal is the line's PERSISTED coding verdict
    // (KEEP invariant 5) — the writer re-checks the confident bar itself.
    const verdict = prepared.transaction.ai_suggestion && typeof prepared.transaction.ai_suggestion === 'object'
      ? prepared.transaction.ai_suggestion
      : null;
    try {
      const apPost = await postSupplierBillJournalWithClient({
        client,
        firmId,
        clientId,
        documentId: plan.document_id,
        coding: verdict,
        authorityBasis: { source: 'ap_settlement', transaction_id: transactionId },
        model: verdict?.model || null,
        actorId: actorId || 'system'
      });
      // Follow the account the AP journal ACTUALLY credited (KEEP invariant
      // 2): FI returns the shared 2870 constant, a GB post its chart-resolved
      // payables — either way the swap cannot drift from the journal.
      if (!apPost.payables_coding?.account_code) {
        throw new PostingPolicyError('posting_policy_invalid', { jurisdiction: currentContext.policy.jurisdiction,
          details: { reason: 'supplier_post_payables_coding_missing' } });
      }
      journalCoding = apPost.payables_coding;
      apSettlement = {
        applied: true,
        journal_id: apPost.journal_id,
        document_id: plan.document_id,
        tosite_number: apPost.tosite_number ?? null,
        reference_number: plan.reference_number || null,
        vendor_name: plan.vendor_name || null
      };
    } catch (error) {
      if (!AP_SETTLEMENT_FALLBACK_CODES.has(error?.code)) throw error;
      apSettlement = { applied: false, reason: error.code };
    }
  } else if (prepared.apSettlement) {
    apSettlement = { applied: false, reason: prepared.apSettlement.reason };
  }
  // F-G8-1: the AR swap — a pure coding change (no second journal: the
  // receivable was booked at issuance), so unlike the AP leg there is no
  // commit-time writer failure to enumerate. The settlement leg clears GROSS
  // 1700; the 1700 coding carries no ALV code, so it never splits (D-AR-4).
  let arSettlement = null;
  if (prepared.arSettlement?.planned) {
    const plan = prepared.arSettlement;
    journalCoding = arSettlementReceivableCoding(currentContext);
    arSettlement = {
      applied: true,
      invoice_id: plan.invoice_id,
      invoice_number: plan.invoice_number || null,
      reference_number: plan.reference_number || null,
      buyer_name: plan.buyer_name || null,
      amount_eur: plan.amount_eur,
      open_before_eur: plan.open_before_eur,
      open_after_eur: plan.open_after_eur
    };
  } else if (prepared.arSettlement) {
    arSettlement = { applied: false, reason: prepared.arSettlement.reason };
  }
  const ledgerPostResult = await postLedgerJournalForTransaction({
    client,
    firmId,
    clientId,
    transaction: prepared.transaction,
    coding: journalCoding,
    bankAccount: prepared.preview.bank_account,
    postingPolicyReceipt: prepared.postingContext.receipt,
    sourceReceipt: prepared.sourceReceipt,
    settlementSplit: prepared.settlementSplit?.planned ? prepared.settlementSplit.split : null,
    actorId: actorId || 'system'
  });
  // RT-21f: the row this post settled, on the transaction and the audit receipt.
  const settlementSplitReceipt = prepared.settlementSplit?.planned ? prepared.settlementSplit.receipt : null;
  const payloadPatch = {
    ...journalCoding,
    ...(prepared.documentAllocation ? { document_allocation: prepared.documentAllocation } : {}),
    ...(settlementSplitReceipt ? { settlement_split: settlementSplitReceipt } : {}),
    review_status: 'resolved',
    ledger_status: 'posted',
    ledger_journal_id: ledgerPostResult.ledger_journal_id,
    ledger_posted_at: ledgerPostResult.ledger_posted_at,
    ledger_amount: ledgerPostResult.ledger_amount,
    ledger_currency: ledgerPostResult.ledger_currency,
    // §T.5 — the marker that lets a surface render "settles Ostolasku <ref>".
    // Only the APPLIED case marks the row; a fallback stays byte-identical to
    // today's post (the reason lives on the audit receipt).
    ...(apSettlement?.applied ? { ap_settlement: apSettlement } : {}),
    // F-G8-1: the AR marker — doubles as the resolver's settled-before source
    // (payload->'ar_settlement'->>'invoice_id'), so a second partial payment
    // computes its open amount off what already cleared 1700.
    ...(arSettlement?.applied ? { ar_settlement: arSettlement } : {})
  };
  await client.query(
    `update transactions
     set status = 'posted',
         reconciliation_status = 'posted',
         account_code = coalesce($4, account_code),
         category = coalesce($5, category),
         payload = (payload - 'ledger_post_refusal') || $6::jsonb,
         updated_at = now()
     where firm_id = $1 and client_id = $2 and id = $3`,
    [
      firmId,
      clientId,
      transactionId,
      journalCoding.account_code || null,
      journalCoding.account_label || journalCoding.account_name || null,
      JSON.stringify(payloadPatch)
    ]
  );
  // RT-16: the journal is the receipt — the coding state is a ledger fact now.
  await applyCodingTransition(client, { firmId, clientId, transactionId, to: 'posted' });
  // RT-24 (2026-09-09): a POSTED line cannot also rest on the owner. "Applied
  // coding outranks an open ask" (db/asks.js) already holds at apply time; a
  // post is the stronger decision, and an ask minted after the apply (a
  // matcher's clarification, a doc-lane confirm) otherwise rendered the line
  // ASKED with a journal behind it — the Kampaamo Ilmarinen and Lumikki rows.
  // Receipted by the resolver ('evidence_request.superseded_by_coding').
  await resolveOpenEvidenceRequestsForTransaction({
    client, firmId, clientId, transactionId,
    actorId: actorId || 'system',
    note: `Superseded by ledger post (journal ${ledgerPostResult.ledger_journal_id}).`
  });
  // The same journal answers the settled source's own statement/payment asks
  // (a loan notice asking for the statement it was just posted against).
  if (matchedDocument?.document_id && ['confirmed', 'auto_matched'].includes(matchedDocument.match_status)) {
    await resolveOpenSettlementRequestsForDocument({
      client, firmId, clientId, documentId: matchedDocument.document_id, transactionId,
      actorId: actorId || 'system',
      note: `Superseded by ledger post (journal ${ledgerPostResult.ledger_journal_id}).`
    });
  }
  await client.query(
    `update transaction_review_queue
     set status = 'resolved',
         payload = payload || $4::jsonb,
         updated_at = now()
     where firm_id = $1
       and client_id = $2
       and (
         item_id = $3
         or payload->>'transaction_id' = $3
       )`,
    [firmId, clientId, transactionId, JSON.stringify(payloadPatch)]
  );
  // INT-3 (receipts): actor_id records WHICH operator drove the post (same
  // idiom as the adjustment audit) and metadata carries the coding model id
  // read from the row's persisted verdict — never a code default.
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'system', $3, 'ledger.post_transaction', 'transaction', $4, $5::jsonb)`,
    [
      firmId,
      clientId,
      actorId || 'system',
      transactionId,
      JSON.stringify({
        ledger_journal_id: ledgerPostResult.ledger_journal_id,
        account_code: journalCoding.account_code || null,
        bank_account: prepared.preview.bank_account?.account_label || null,
        coding_model: codingModelForTransaction(prepared.transaction),
        ...(prepared.documentAllocation ? { document_allocation: prepared.documentAllocation } : {}),
        ...(settlementSplitReceipt ? { settlement_split: settlementSplitReceipt } : {}),
        // D-FI9-P2 (nothing silent): why the AP leg did / did not post, on the
        // receipt every settlement already writes. Absent for non-Donna clients.
        ...(apSettlement ? { ap_settlement: apSettlement } : {}),
        // F-G8-1 (same discipline): why the AR swap did / did not apply.
        ...(arSettlement ? { ar_settlement: arSettlement } : {})
      })
    ]
  );
  return ledgerPostResult;
};

// FI-9 wiring — test seam (the finlandAlvReturnFilingDb.test.js `__` idiom):
// the prepare/commit pair stays internal to the posting path; these aliases
// exist so the wiring tests can drive it against a fake pg client.
export {
  prepareLedgerTransactionPosting as __prepareLedgerTransactionPosting,
  commitPreparedLedgerPosting as __commitPreparedLedgerPosting
};

// A selected duplicate/refund group uses the same prepare/commit writers as
// an ordinary bank line, once per member, on ONE database transaction.
const postRefundGroup = async ({firmId,clientId,transactionId,dryRun,actorId,skipSnapshot}) => {
  const result=await withFirmDbClient(async client=>{
    await client.query('begin');
    let groupIds=[transactionId];
    try {
      const marker=(await client.query("select payload->'jev_refund_group' as receipt from transactions where firm_id=$1 and client_id=$2 and id=$3",[firmId,clientId,transactionId])).rows[0]?.receipt;
      if(!marker || marker.status!=='selected' || !marker.model || !marker.actor_id || !Array.isArray(marker.transaction_ids) || marker.transaction_ids.length!==3 || new Set(marker.transaction_ids).size!==3 || !marker.transaction_ids.includes(transactionId)) throw Object.assign(new Error('The refund group has no current semantic selection receipt.'),{code:'REFUND_GROUP_SOURCE_CHANGED',statusCode:409});
      groupIds=marker.transaction_ids;
      const rows=(await client.query(`select * from transactions where firm_id=$1 and client_id=$2 and id=any($3::text[]) order by id for update`,[firmId,clientId,groupIds])).rows;
      const document=(await client.query('select * from documents where firm_id=$1 and client_id=$2 and id=$3 for update',[firmId,clientId,marker.document_id])).rows[0];
      const lines=(await client.query('select * from document_lines where firm_id=$1 and client_id=$2 and document_id=$3 order by line_no,id for update',[firmId,clientId,marker.document_id])).rows;
      const plan=planRefundGroup({document:document?{...document,lines}:null,transactions:rows});
      if(!plan.ok || plan.source_digest!==marker.source_digest || rows.some(row=>row.payload?.jev_refund_group?.source_digest!==marker.source_digest || row.payload?.jev_refund_group?.status!=='selected')) throw Object.assign(new Error('The selected refund group source changed. Reconsider the complete current group.'),{code:'REFUND_GROUP_SOURCE_CHANGED',statusCode:409,details:{transaction_ids:groupIds}});
      if(rows.some(row=>row.payload?.ledger_journal_id || ['posted','synced','closed'].includes(row.coding_state))) throw Object.assign(new Error('This group includes a posted item; use the existing correction flow rather than replacing its history.'),{code:'REFUND_GROUP_CORRECTION_REQUIRED',statusCode:409,details:{transaction_ids:groupIds}});
      const matches=(await client.query(`select * from reconciliation_matches where firm_id=$1 and client_id=$2 and bank_transaction_id=any($3::text[]) and status in ('confirmed','auto_matched') order by id for update`,[firmId,clientId,groupIds])).rows;
      if(rows.some(row=>matches.filter(m=>m.bank_transaction_id===row.id&&m.matched_object_id===marker.document_id).length!==1) || matches.some(m=>m.matched_object_id!==marker.document_id || Math.round(Number(m.match_amount)*100)!==(m.bank_transaction_id===plan.purchase_transaction_id?Math.round(plan.amount*100):0))
        || Math.round(matches.reduce((sum,m)=>sum+Number(m.match_amount),0)*100)!==Math.round(plan.amount*100)) throw Object.assign(new Error('The group must consume its source exactly once across all three current relationships.'),{code:'REFUND_GROUP_SOURCE_CHANGED',statusCode:409,details:{transaction_ids:groupIds}});
      if(rows.some(row=>row.coding_state!=='applied'||row.payload?.ai_suggestion_status!=='auto_applied'||!row.payload?.ai_suggestion||row.payload.ai_suggestion.evidence_required)) throw Object.assign(new Error('The selected refund group awaits complete autonomous source-backed coding for every member.'),{code:'REFUND_GROUP_CODING_PENDING',statusCode:409,details:{transaction_ids:groupIds}});
      const prepared=[];
      for(const row of rows)prepared.push(await prepareLedgerTransactionPosting({client,firmId,clientId,transactionId:row.id,dryRun,refundGroupManaged:true}));
      const codingKey=p=>JSON.stringify([p.preview.coding.account_code,p.preview.coding.account_name,p.preview.coding.tax_type||p.preview.coding.xero_tax_type,
        p.documentAllocation?.lines.map(l=>[l.line_handle,l.coding.account_code,l.coding.account_name,l.coding.tax_type])||null]);
      if(new Set(prepared.map(codingKey)).size!==1) throw Object.assign(new Error('The duplicate and refund must mirror the selected purchase account and input-tax treatment. Reconsider the complete group.'),{code:'REFUND_GROUP_CODING_CONFLICT',statusCode:409,details:{transaction_ids:groupIds,selected_codings:prepared.map(p=>({transaction_id:p.transaction.id,coding:p.preview.coding}))}});
      if(prepared.some(p=>p.apSettlement?.planned||p.arSettlement?.planned||p.settlementSplit?.planned)) throw Object.assign(new Error('The refund group conflicts with an already recognized obligation or another settlement plan.'),{code:'REFUND_GROUP_CORRECTION_REQUIRED',statusCode:409,details:{transaction_ids:groupIds}});
      const net=prepared.flatMap(p=>p.ledgerPreview.lines).reduce((byAccount,line)=>{
        const key=line.account.code||line.account.name;byAccount[key]=(byAccount[key]||0)+Math.round((line.debit-line.credit)*100);return byAccount;
      },{});
      const requested=prepared.find(p=>p.transaction.id===transactionId);
      const results=[];
      if(!dryRun){
        for(const p of prepared)results.push(await commitPreparedLedgerPosting({client,firmId,clientId,transactionId:p.transaction.id,prepared:p,actorId:actorId||marker.actor_id}));
        const receipt={...marker,status:'posted',journal_ids:results.map(r=>r.ledger_journal_id),net_account_minor:net};
        await client.query("update transactions set payload=payload || jsonb_build_object('jev_refund_group',$4::jsonb) where firm_id=$1 and client_id=$2 and id=any($3::text[])",[firmId,clientId,groupIds,JSON.stringify(receipt)]);
      }
      await client.query('commit');
      return {ledger_posting:{...ledgerPostingPreviewPayload({clientId,transactionId,prepared:requested}),...(results.length?{state:'posted',ledger_journal_id:results[prepared.indexOf(requested)].ledger_journal_id}:{}),refund_group:{...marker,transaction_ids:groupIds,net_account_minor:net,state:dryRun?'preview':'posted'}}};
    }catch(error){await client.query('rollback');await receiptPostingFailure({client,firmId,clientId,transactionIds:groupIds,error});throw error;}
  });
  if(!dryRun&&!skipSnapshot)result.snapshot=await getFirmSnapshotFromDb({firmId});
  return result;
};

export const postLedgerTransactionInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  transactionId,
  dryRun = true,
  force = false,
  actorId = null,
  // Batch callers (the ledger auto-post sweep) skip the full firm snapshot —
  // N posts per tick must not cost N snapshot assemblies. The prepare/commit
  // invariants are untouched by this; only the response payload thins.
  skipSnapshot = false
} = {}) => {
  if (!clientId) {
    const error = new Error('Client id is required for ledger posting.');
    error.statusCode = 400;
    throw error;
  }
  if (!transactionId) {
    const error = new Error('Transaction id is required for ledger posting.');
    error.statusCode = 400;
    throw error;
  }

  if (!dryRun) await withFirmDbClient(async client => {
    try {
      await assertRetainedLedgerScope({ client, firmId, clientId, actorId, resourceId: `transaction:${transactionId}`, lock: false });
    } catch (error) {
      await receiptPostingFailure({ client, firmId, clientId, transactionIds: [transactionId], error });
      throw error;
    }
  });

  const refundGroup = await withFirmDbClient(async client => (await client.query("select payload->'jev_refund_group' as receipt from transactions where firm_id=$1 and client_id=$2 and id=$3", [firmId,clientId,transactionId])).rows[0]?.receipt);
  if (refundGroup?.status === 'selected') return postRefundGroup({firmId,clientId,transactionId,dryRun,actorId,skipSnapshot});

  if (!dryRun) {
    const { ensureAeVatPostingFactsInDb } = await import('./coding.js');
    let facts;
    try { facts = await ensureAeVatPostingFactsInDb({ firmId, clientId, transactionId }); }
    catch (error) {
      await withFirmDbClient(client => receiptPostingFailure({ client, firmId, clientId, transactionIds: [transactionId], error }));
      throw error;
    }
    if (facts?.waiting_on_owner) return { ledger_posting: { state: 'waiting_on_owner', evidence_request_id: facts.evidence_request_id } };
  }

  if (dryRun) {
    const prepared = await withFirmDbClient(async (client) => {
      try { return await prepareLedgerTransactionPosting({ client, firmId, clientId, transactionId, dryRun, force }); }
      catch (error) {
        await receiptPostingFailure({ client, firmId, clientId, transactionIds: [transactionId], error });
        throw error;
      }
    });
    return { ledger_posting: ledgerPostingPreviewPayload({ clientId, transactionId, prepared }) };
  }

  let ledgerPostResult = null;
  let previewPayload = null;
  await withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      const prepared = await prepareLedgerTransactionPosting({ client, firmId, clientId, transactionId, dryRun, force });
      previewPayload = ledgerPostingPreviewPayload({ clientId, transactionId, prepared });
      ledgerPostResult = await commitPreparedLedgerPosting({ client, firmId, clientId, transactionId, prepared, actorId });
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      await receiptPostingFailure({ client, firmId, clientId, transactionIds: [transactionId], error });
      throw error;
    }
  });

  const snapshot = skipSnapshot ? null : await getFirmSnapshotFromDb({ firmId });

  return {
    snapshot,
    ledger_posting: {
      ...previewPayload,
      source: 'ledger_posting',
      dry_run: false,
      ...ledgerPostResult
    }
  };
};

const transactionIdFromReviewRow = (row = {}) =>
  row.item_id || row.payload?.transaction_id || row.payload?.transactionId || '';

const latestReviewByTransactionId = (rows = []) => {
  const byId = new Map();
  for (const row of rows) {
    const transactionId = transactionIdFromReviewRow(row);
    if (transactionId && !byId.has(transactionId)) byId.set(transactionId, row);
  }
  return byId;
};

// RT-16: the eligibility label is the projection of the line's own coding
// state (the case file carries none); a never-coded line reads 'suggested'.
const stateForBulkLedgerPosting = ({ transaction = {} } = {}) =>
  legacyReviewStateFor(transaction.coding_state) || 'suggested';

const buildLedgerPeriodPostingPayload = ({
  dryRun,
  clientId,
  period,
  allowedStates,
  requestedCount,
  results
}) => {
  const ready = results.filter((item) => item.status === 'ready').length;
  const posted = results.filter((item) => item.status === 'posted').length;
  const skipped = results.filter((item) => item.status === 'skipped').length;
  const errors = results.filter((item) => item.status === 'error').length;
  return {
    source: dryRun ? 'ledger_period_posting_preview' : 'ledger_period_posting',
    dry_run: Boolean(dryRun),
    client_id: clientId,
    period_start: period.period_start,
    period_end: period.period_end,
    eligible_review_states: Array.from(allowedStates),
    requested_count: requestedCount,
    ready_count: ready,
    posted_count: posted,
    skipped_count: skipped,
    error_count: errors,
    atomic: !dryRun,
    results
  };
};

export const postLedgerPeriodInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  periodStart,
  periodEnd,
  dryRun = true,
  force = false,
  reviewStates = ['accepted'],
  limit = 100,
  actorId = null
} = {}) => {
  if (!clientId) {
    const error = new Error('Client id is required for period ledger posting.');
    error.statusCode = 400;
    throw error;
  }
  const period = normalizeLedgerPeriod({ periodStart, periodEnd });
  const allowedStates = new Set(
    (Array.isArray(reviewStates) ? reviewStates : ['accepted'])
      .map((state) => normalizeTransactionReviewState(state))
      .filter(Boolean)
  );
  if (!allowedStates.size) allowedStates.add('accepted');
  const maxRows = Math.max(1, Math.min(Number(limit || 100), 250));

  const periodPosting = await withFirmDbClient(async (client) => {
    await requireClientInFirm({ client, firmId, clientId });
    if (!dryRun) await assertRetainedLedgerScope({ client, firmId, clientId, actorId,
      resourceId: `period:${period.period_start}:${period.period_end}`, lock: false });
    const inTransaction = !dryRun;
    const results = [];
    let candidates = [];
    let postingFailureTransactionId = null;
    if (inTransaction) await client.query('begin');
    try {
      const transactionsResult = await client.query(
        `select *
         from transactions
         where firm_id = $1
           and client_id = $2
           and transaction_date >= $3
           and transaction_date <= $4
         order by transaction_date, created_at
         limit $5`,
        [firmId, clientId, period.period_start, period.period_end, maxRows]
      );
      const reviewResult = await client.query(
        `select *
         from transaction_review_queue
         where firm_id = $1
           and client_id = $2
         order by updated_at desc`,
        [firmId, clientId]
      );
      const reviewByTransactionId = latestReviewByTransactionId(reviewResult.rows);
      candidates = transactionsResult.rows.map((row) => {
        const transaction = rowToTransactionPayload(row);
        const reviewRow = reviewByTransactionId.get(transaction.id) || {};
        const reviewState = stateForBulkLedgerPosting({ transaction, reviewRow });
        return {
          transaction,
          review_state: reviewState,
          already_posted: Boolean(transaction.ledger_journal_id || transaction.ledger_status === 'posted')
        };
      });

      for (const candidate of candidates) {
        const base = {
          transaction_id: candidate.transaction.id,
          date: candidate.transaction.date,
          description: candidate.transaction.description,
          review_state: candidate.review_state
        };
        if (candidate.already_posted && !force) {
          results.push({ ...base, status: 'skipped', reason: 'already_posted' });
          continue;
        }
        if (!allowedStates.has(candidate.review_state) && !(force && candidate.review_state === 'posted')) {
          results.push({ ...base, status: 'skipped', reason: `review_state:${candidate.review_state || 'unknown'}` });
          continue;
        }
        try {
          postingFailureTransactionId = candidate.transaction.id;
          const prepared = await prepareLedgerTransactionPosting({
            client,
            firmId,
            clientId,
            transactionId: candidate.transaction.id,
            dryRun,
            force,
            skipClientCheck: true
          });
          if (dryRun) {
            results.push({
              ...base,
              status: 'ready',
              ledger_journal_id: prepared.ledgerPreview?.id || null,
              account_code: prepared.preview?.coding?.account_code || prepared.preview?.coding?.xero_account_code || null,
              amount: prepared.ledgerPreview?.amount || null,
              currency: prepared.ledgerPreview?.currency || null
            });
            continue;
          }
          const ledgerPostResult = await commitPreparedLedgerPosting({
            client,
            firmId,
            clientId,
            transactionId: candidate.transaction.id,
            prepared,
            actorId
          });
          results.push({
            ...base,
            status: 'posted',
            ledger_journal_id: ledgerPostResult.ledger_journal_id || null,
            account_code: prepared.preview?.coding?.account_code || prepared.preview?.coding?.xero_account_code || null,
            amount: ledgerPostResult.ledger_amount || null,
            currency: ledgerPostResult.ledger_currency || null
          });
        } catch (error) {
          const errorRow = {
            ...base,
            status: 'error',
            error: error.message || 'Ledger posting failed.',
            code: error.code || null
          };
          results.push(errorRow);
          if (dryRun) await receiptPostingFailure({ client, firmId, clientId, transactionIds: [candidate.transaction.id], error });
          if (!dryRun) {
            error.statusCode = error.statusCode || 409;
            error.code = error.code || 'LEDGER_PERIOD_POSTING_FAILED';
            error.details = {
              ...(error.details || {}),
              ledger_period_posting: buildLedgerPeriodPostingPayload({
                dryRun,
                clientId,
                period,
                allowedStates,
                requestedCount: candidates.length,
                results
              })
            };
            throw error;
          }
        }
      }
      if (inTransaction) await client.query('commit');
      return buildLedgerPeriodPostingPayload({
        dryRun,
        clientId,
        period,
        allowedStates,
        requestedCount: candidates.length,
        results
      });
    } catch (error) {
      if (inTransaction) await client.query('rollback');
      if (postingFailureTransactionId) await receiptPostingFailure({ client, firmId, clientId, transactionIds: [postingFailureTransactionId], error });
      throw error;
    }
  });

  if (!dryRun) {
    const snapshot = await getFirmSnapshotFromDb({ firmId });
    return { snapshot, ledger_period_posting: periodPosting };
  }
  return { ledger_period_posting: periodPosting };
};

export const getLedgerAuditTrailFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  transactionId,
  ledgerJournalId,
  periodStart,
  periodEnd
} = {}) => {
  if (!clientId) {
    const error = new Error('Client id is required for a ledger audit trail.');
    error.statusCode = 400;
    throw error;
  }
  const requestedTransactionId = String(transactionId || '').trim();
  const requestedJournalId = String(ledgerJournalId || '').trim();
  const needsPeriod = !requestedTransactionId && !requestedJournalId;
  const period = (periodStart || periodEnd || needsPeriod)
    ? normalizeLedgerPeriod({ periodStart, periodEnd })
    : { period_start: periodStart || null, period_end: periodEnd || null };

  return withFirmDbClient(async (client) => {
    await requireClientInFirm({ client, firmId, clientId });

    let transaction = null;
    if (requestedTransactionId) {
      const transactionResult = await client.query(
        `select *
         from transactions
         where firm_id = $1
           and client_id = $2
           and id = $3
         limit 1`,
        [firmId, clientId, requestedTransactionId]
      );
      transaction = transactionResult.rows[0] ? rowToTransactionPayload(transactionResult.rows[0]) : null;
      if (!transaction) {
        const error = new Error('Transaction not found for ledger audit trail.');
        error.statusCode = 404;
        error.code = 'LEDGER_AUDIT_TRANSACTION_NOT_FOUND';
        throw error;
      }
    }

    let primaryJournalsResult = { rows: [] };
    if (requestedJournalId) {
      primaryJournalsResult = await client.query(
        `select *
         from ledger_journals
         where firm_id = $1
           and client_id = $2
           and id = $3
         limit 1`,
        [firmId, clientId, requestedJournalId]
      );
      if (!primaryJournalsResult.rows.length) {
        const error = new Error('Ledger journal not found for audit trail.');
        error.statusCode = 404;
        error.code = 'LEDGER_AUDIT_JOURNAL_NOT_FOUND';
        throw error;
      }
    } else if (requestedTransactionId) {
      const knownJournalIds = [
        transaction?.ledger_journal_id,
        transaction?.payload?.ledger_journal_id
      ].filter(Boolean);
      primaryJournalsResult = await client.query(
        `select *
         from ledger_journals
         where firm_id = $1
           and client_id = $2
           and (
             (source_type = 'transaction' and source_id = $3)
             or id = any($4::text[])
           )
         order by journal_date, created_at`,
        [firmId, clientId, requestedTransactionId, knownJournalIds]
      );
    } else {
      primaryJournalsResult = await client.query(
        `select *
         from ledger_journals
         where firm_id = $1
           and client_id = $2
           and journal_date >= $3
           and journal_date <= $4
           and status <> 'voided'
         order by journal_date, created_at`,
        [firmId, clientId, period.period_start, period.period_end]
      );
    }

    const primaryJournals = primaryJournalsResult.rows.map(rowToLedgerJournalPayload);
    if (requestedJournalId && !transaction && primaryJournals[0]?.source_type === 'transaction' && primaryJournals[0]?.source_id) {
      const transactionResult = await client.query(
        `select *
         from transactions
         where firm_id = $1
           and client_id = $2
           and id = $3
         limit 1`,
        [firmId, clientId, primaryJournals[0].source_id]
      );
      transaction = transactionResult.rows[0] ? rowToTransactionPayload(transactionResult.rows[0]) : null;
    }

    const primaryJournalIds = primaryJournals.map((journal) => journal.id).filter(Boolean);
    const relatedOriginalIds = primaryJournals
      .flatMap((journal) => [journal.correction_of_journal_id, journal.reversal_of_journal_id])
      .filter(Boolean);
    const relatedJournalsResult = primaryJournalIds.length
      ? await client.query(
          `select *
           from ledger_journals
           where firm_id = $1
             and client_id = $2
             and status <> 'voided'
             and (
               id = any($3::text[])
               or correction_of_journal_id = any($3::text[])
               or reversal_of_journal_id = any($3::text[])
               or id = any($4::text[])
             )
           order by journal_date, created_at`,
          [firmId, clientId, primaryJournalIds, relatedOriginalIds]
        )
      : { rows: [] };
    const ledgerJournals = relatedJournalsResult.rows.map(rowToLedgerJournalPayload);
    const ledgerJournalIds = ledgerJournals.map((journal) => journal.id).filter(Boolean);
    const linesResult = ledgerJournalIds.length
      ? await client.query(
          `select ll.*, la.account_type, la.normal_balance
           from ledger_lines ll
           join ledger_accounts la on la.id = ll.account_id
           where ll.firm_id = $1
             and ll.client_id = $2
             and ll.journal_id = any($3::text[])
           order by ll.journal_id, ll.line_no`,
          [firmId, clientId, ledgerJournalIds]
        )
      : { rows: [] };

    const reviewResult = transaction?.id
      ? await client.query(
          `select q.*, t.coding_state as transaction_coding_state
           from ${REVIEW_QUEUE_WITH_CODING_STATE_SQL}
           where q.firm_id = $1
             and q.client_id = $2
             and (
               q.item_id = $3
               or q.payload->>'transaction_id' = $3
             )
           order by q.updated_at desc
           limit 1`,
          [firmId, clientId, transaction.id]
        )
      : { rows: [] };

    const periodTransactionsResult = !transaction?.id
      ? await client.query(
          `select *
           from transactions
           where firm_id = $1
             and client_id = $2
             and transaction_date >= $3
             and transaction_date <= $4
           order by transaction_date, created_at`,
          [firmId, clientId, period.period_start, period.period_end]
        )
      : { rows: [] };

    const resourceIds = Array.from(new Set([
      transaction?.id,
      ...ledgerJournalIds
    ].filter(Boolean)));
    const auditResult = resourceIds.length || transaction?.id
      ? await client.query(
          `select *
           from audit_events
           where firm_id = $1
             and client_id = $2
             and (
               resource_id = any($3::text[])
               or metadata->>'transaction_id' = $4
               or metadata->>'original_journal_id' = any($5::text[])
               or metadata->>'ledger_journal_id' = any($5::text[])
               or metadata->'correction_journal_ids' ?| $5::text[]
             )
           order by created_at desc
           limit 200`,
          [firmId, clientId, resourceIds, transaction?.id || '', ledgerJournalIds]
        )
      : await client.query(
          `select *
           from audit_events
           where firm_id = $1
             and client_id = $2
             and created_at >= $3::date
             and created_at < ($4::date + interval '1 day')
           order by created_at desc
           limit 200`,
          [firmId, clientId, period.period_start, period.period_end]
        );

    return buildLedgerAuditTrail({
      clientId,
      periodStart: period.period_start,
      periodEnd: period.period_end,
      transaction,
      transactions: periodTransactionsResult.rows.map(rowToTransactionPayload),
      reviewItem: reviewResult.rows[0] ? rowToTransactionReviewPayload(reviewResult.rows[0]) : null,
      ledgerJournals,
      ledgerLines: linesResult.rows.map(rowToLedgerLinePayload),
      auditEvents: auditResult.rows.map((row) => ({
        id: row.id,
        firm_id: row.firm_id,
        client_id: row.client_id,
        actor_type: row.actor_type,
        actor_id: row.actor_id,
        action: row.action,
        resource_type: row.resource_type,
        resource_id: row.resource_id,
        metadata: row.metadata || {},
        created_at: row.created_at ? new Date(row.created_at).toISOString() : null
      }))
    });
  });
};

// Mint-time account typing. A journal line whose coding carried no usable type
// mints 'unknown' — but when the name resolved a canonical role (the explicit
// seed-name table, never fuzzy), the role's class IS the deterministic type and
// its normal balance travels with it. A declared (non-unknown) type always wins:
// it came from a matched chart row or an explicit caller. Pure; exported for tests.
export const __ledgerAccountMintShape = ({ account = {}, canonicalRole = null } = {}) => {
  const declaredType = String(account.type || '').trim().toLowerCase();
  if (declaredType && declaredType !== 'unknown') {
    return { account_type: declaredType, normal_balance: account.normal_balance || 'debit' };
  }
  const roleClass = roleMeta(canonicalRole)?.class || '';
  if (String(canonicalRole || '') === 'asset.cash') {
    return { account_type: 'bank', normal_balance: 'debit' };
  }
  if (['asset', 'liability', 'equity', 'revenue', 'expense'].includes(roleClass)) {
    return {
      account_type: roleClass,
      normal_balance: normalBalanceForRole(canonicalRole) || account.normal_balance || 'debit'
    };
  }
  return { account_type: declaredType || 'unknown', normal_balance: account.normal_balance || 'debit' };
};

// Exported for canonicalRoleResolutionDb.js: the strong-model role-resolution
// lane mints a ledger row for a synced (xero-mirror) chart account through THIS
// writer rather than a second insert — same deterministic id scheme, same
// coalesce-FILL (a resolved role fills a null, never overwrites a settled one).
export const upsertLedgerAccountForJournal = async ({ client, firmId, clientId, account = {}, currency = '' } = {}) => {
  const nativeLineage = await readNativeChartLineage({ query: client.query.bind(client), firmId, clientId, lock: true });
  if (nativeLineage) {
    const choice = resolveNativeAccountChoice(nativeAccountChoices(nativeCodingContext(nativeLineage)), account, { allowAlias: true });
    for (const [input, field] of [['type', 'account_type'], ['account_type', 'account_type'], ['normal_balance', 'normal_balance'], ['canonical_role', 'canonical_role'], ['status', 'status']]) {
      if (Object.hasOwn(account, input) && account[input] !== choice[field]) codingChoiceFailure('account_metadata_mismatch');
    }
    if ((currency && currency !== choice.currency) || (account.currency && account.currency !== choice.currency)) codingChoiceFailure('account_currency_mismatch');
    return choice.id;
  }
  const code = String(account.code || '').trim();
  const name = String(account.name || account.label || code || 'Uncoded account').trim();
  const accountId = ledgerRecordId('account', firmId, clientId, code || account.xero_account_id || name);
  // payload.role is the LINE role ('counterparty'/'bank'); canonical_role is the
  // CoA-level semantic identity (see __canonicalRoleForAccount). On conflict we
  // coalesce-FILL — a posting upsert may resolve a role for a previously-null row,
  // but must never overwrite a role already set with a re-derived null.
  const canonicalRole = __canonicalRoleForAccount({
    name,
    role: account.role,
    canonical_role: account.canonical_role
  });
  const mintShape = __ledgerAccountMintShape({ account, canonicalRole });
  // A market-declared posting account (FI 1910 / 1900) names its statutory
  // group; the read model places the row by it, as it places a born row.
  const payload = {
    role: account.role || null,
    label: account.label || (code && name && code !== name ? `${code} · ${name}` : name),
    xero_account_id: account.xero_account_id || null,
    ...(account.statutory_group ? { statutory_group: account.statutory_group } : {})
  };
  const result = await client.query(
    `insert into ledger_accounts (
       id, firm_id, client_id, code, name, account_type, normal_balance, currency, tax_type, xero_account_id, canonical_role, status, payload
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active', $12::jsonb)
     on conflict (id) do update set
       code = excluded.code,
       name = excluded.name,
       account_type = case
         when excluded.account_type is null or excluded.account_type in ('', 'unknown')
           then ledger_accounts.account_type
         else excluded.account_type
       end,
       normal_balance = case
         when excluded.account_type is null or excluded.account_type in ('', 'unknown')
           then ledger_accounts.normal_balance
         else excluded.normal_balance
       end,
       currency = excluded.currency,
       tax_type = excluded.tax_type,
       xero_account_id = excluded.xero_account_id,
       canonical_role = coalesce(ledger_accounts.canonical_role, excluded.canonical_role),
       status = 'active',
       payload = ledger_accounts.payload || excluded.payload,
       updated_at = now()
     returning (xmax = 0) as inserted`,
    [
      accountId,
      firmId,
      clientId,
      code || null,
      name,
      mintShape.account_type,
      mintShape.normal_balance,
      currency || null,
      account.tax_type || null,
      account.xero_account_id || null,
      canonicalRole,
      JSON.stringify(payload)
    ]
  );
  // Nothing-silent at the chart plane: a posting that MINTS a brand-new
  // account (the union-menu mint-by-name path) leaves a receipt, same as
  // ensureLedgerAccountFromVerdict's created_from_verdict event. Fresh
  // insert only — the routine upsert of an existing row stays quiet.
  // Same transaction as the mint: the account cannot appear without its
  // receipt.
  if (result.rows[0]?.inserted) {
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
       values ($1, $2, 'system', 'ledger.account.created_at_posting', 'ledger_account', $3, $4::jsonb)`,
      [
        firmId,
        clientId,
        accountId,
        JSON.stringify({
          name,
          code: code || null,
          account_type: mintShape.account_type,
          canonical_role: canonicalRole,
          source: 'journal_posting'
        })
      ]
    );
  }
  return accountId;
};

// ── Pack-palette chart seed (Desert Rose round-4 review §D, 2026-09-01) ──────
// A routed client's coder codes against its market's pack palette (the
// JURISDICTION_ACCOUNT_PALETTE menu), but until now NOTHING put those accounts
// in the client's chart: each first posting minted the account by name through
// upsertLedgerAccountForJournal, and because the mint resolves roles only from
// Donna's own seed-name table, a pack-declared name the table does not know
// ("Licence and statutory fees", "Motor expenses") landed with
// account_type='unknown' and no canonical role — reports classified it as
// neither P&L nor balance sheet — and every fresh insert tripped the
// migration-127 readiness fence mid-sweep (the Desert Rose flap: 7
// invalidations → 137 admission blocks). The palette is the pack's DATA
// (name + canonical role, closed vocabulary at load), so the chart can be
// seeded from it up front: this writer inserts every palette account the
// client does not already have — id keyed on the NAME, the exact scheme the
// posting upsert uses for code-less accounts, so a later posting lands on the
// seeded row instead of minting — and FILLS type/role on an existing same-name
// row that was minted 'unknown' (coalesce-fill, never overwrite a settled
// value). Type + normal balance derive from the role's class via
// __ledgerAccountMintShape; clearing/control roles stay 'unknown' by design
// (the read model places them by role). Codes stay null: the palette declares
// none, and inventing them here would be the engine trimming the pack.
//
// Gated on the SAME flag that routes the menu, so chart and menu never
// disagree; skipped when an external chart is synced (xero_accounts — the
// pack palette is the fallback for a client with NO synced chart, and a
// synced chart is the client's, not Donna's to pad); skipped for a market
// that ships a Donna-native CODED default chart (defaultCharts.js — GB), whose
// persisted chart is a pinned certificate contract that palette rows would
// break (Entity Certificate B, 2026-09-01: the first version of this seed
// pre-empted the GB default chart at self-provision and failed
// `persisted_chart_contract_mismatch`); and skipped when the chart already
// holds a CODED row — a coded chart is a provisioned chart, whichever market
// it came from, and the palette never pads one. Idempotent per call;
// receipts once per client per change (`ledger.chart.palette_seeded`) — the
// chart-plane sibling of created_at_posting / created_from_verdict. Runs
// inside the caller's transaction (client creation; the desktop boot
// backfill). Never throws on a pack it cannot load — that is a deploy bug the
// pack's own load test owns — but DB failures propagate so a partial seed
// never survives.
export const PACK_PALETTE_CHART_SEED_ACTION = 'ledger.chart.palette_seeded';

export const seedPackPaletteChartWithClient = async (client, { firmId, clientId, birthContext = null, newBook = false } = {}) => {
  const none = (reason, packId = null) => ({ seeded: false, reason, pack_id: packId, inserted: [], filled: [] });
  if (!client || !firmId || !clientId) return none('missing_scope');
  const clientRes = await client.query(
    // Creation already owns the identity row. Boot may own a readiness key, so
    // refuse contention without waiting in the reverse lock order; its caller
    // rolls back the whole seed and a later boot rereads committed identity.
    'select jurisdiction, entity_type, profile from clients where firm_id = $1 and id = $2 for share nowait',
    [firmId, clientId]
  );
  const clientRow = clientRes.rows?.[0];
  if (!clientRow) return none('client_missing');
  const readScope = { query: client.query.bind(client), firmId, clientId };
  const receipts = await readNativeChartReceipts(readScope);
  const observation = birthContext || lifecycleJurisdiction(clientRow) === 'sg'
    || receipts.some(row => row.metadata?.birth_contract || row.metadata?.native_chart_birth)
    ? await readNativeChartObservation({ ...readScope, receipts }) : null;
  const lineage = observation ? verifyNativeChartObservation(observation) : null;
  // Retained books verify even when new selection is disabled. No legacy fill,
  // active-creator dependency, recertification rewrite or boot adoption.
  if (lineage) return { seeded: true, reason: 'already_complete', pack_id: lineage.receipt.metadata.pack_id, inserted: [], filled: [] };
  const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  if (!clientFlagActs({ flagKey: JURISDICTION_ACCOUNT_PALETTE_FLAG_KEY, snapshot, envFallback: () => false })) {
    if (birthContext) nativeChartFailure('palette_flag_inactive');
    return none('palette_flag_inactive');
  }
  if (birthContext) {
    if (birthContext.createdNewClient !== true) nativeChartFailure('new_client_required');
    const metadata = nativeBirthReceipt({ observation, birthContract: birthContext.birthContract, creationAudit: birthContext.creationAudit });
    const member = (await client.query("select id from firm_members where firm_id=$1 and id=$2 and status='active' for share",
      [firmId, birthContext.creationAudit.actorId])).rows[0];
    if (!member) nativeChartFailure('active_member_required');
    const currentReceipts = observation.receipts.filter(row => BigInt(row.id) > BigInt(metadata.client_life.after_delete_id));
    if (currentReceipts.some(row => row.action === 'client.create' || row.action === PACK_PALETTE_CHART_SEED_ACTION)) nativeChartFailure('existing_birth_evidence');
    if (observation.accounts.length) nativeChartFailure('existing_chart');
    // Opening balances are journals; imported accounting sources are documents
    // and transactions. Check all statuses, including archived/external rows.
    const residue = await client.query(`select 'external_chart' as kind from xero_accounts where firm_id=$1 and client_id=$2
      union all select 'journal' from ledger_journals where firm_id=$1 and client_id=$2
      union all select 'ledger_line' from ledger_lines where firm_id=$1 and client_id=$2
      union all select 'imported_transaction' from transactions where firm_id=$1 and client_id=$2
      union all select 'imported_document' from documents where firm_id=$1 and client_id=$2
      union all select 'inventory_operation' from inventory_operations where firm_id=$1 and client_id=$2 limit 1`, [firmId, clientId]);
    if (residue.rows.length) nativeChartFailure(`birth_residue:${residue.rows[0].kind}`);
    for (const account of metadata.accounts) {
      await client.query(`insert into ledger_accounts
        (id,firm_id,client_id,code,name,account_type,normal_balance,canonical_role,status,currency,payload)
        values($1,$2,$3,$4,$5,$6,$7,$8,'active','SGD',$9::jsonb)`,
      [account.id, firmId, clientId, account.code, account.name, account.account_type, account.normal_balance, account.canonical_role,
        JSON.stringify({ source: 'pack_palette_seed', palette_pack_id: metadata.pack_id,
          statutory_group: account.statutory_group, reserved_use: account.reserved_use,
          birth_contract: account.birth_contract, selection_digest: account.selection_digest })]);
    }
    await client.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
      values($1,$2,'firm_member',$3,$4,'client',$2,$5::jsonb)`,
    [firmId, clientId, member.id, PACK_PALETTE_CHART_SEED_ACTION, JSON.stringify(metadata)]);
    return { seeded: true, reason: 'seeded', pack_id: metadata.pack_id, inserted: metadata.accounts.map(row => row.name), filled: [] };
  }
  const jurisdiction = lifecycleJurisdiction(clientRow);
  if (!jurisdiction) return none('jurisdiction_context_required');
  const packId = resolvePackIdForJurisdiction(jurisdiction);
  if (!packId) return none('no_pack_for_jurisdiction');
  if (marketHasNativeDefaultChart(jurisdiction)) return none('market_has_default_chart', packId);
  const synced = await client.query(
    'select 1 from xero_accounts where firm_id = $1 and client_id = $2 limit 1',
    [firmId, clientId]
  ).catch((error) => {
    if (error?.code === '42P01' || error?.code === '42703') return { rows: [] };
    throw error;
  });
  if (synced.rows?.length) return none('external_chart_synced', packId);
  let palette = [];
  try {
    palette = fallbackAccountsForPack(loadOutboundPack(packId));
  } catch {
    return none('pack_unloadable', packId);
  }
  if (!palette.length) return none('pack_has_no_palette', packId);

  const existingRes = await client.query(
    `select id, code, name, account_type, canonical_role
       from ledger_accounts
      where firm_id = $1 and client_id = $2`,
    [firmId, clientId]
  );
  // FI-21: a NEW book of a market/form that declares a coded birth chart is
  // born with it whole — codes, statutory names, roles — instead of the
  // code-less palette. Existing books (boot backfill, reviewed adoption) keep
  // the palette path below, unchanged.
  const birthChart = newBook && !(existingRes.rows || []).length ? marketBirthChart(jurisdiction, clientRow.entity_type) : null;
  if (birthChart) return seedMarketBirthChartWithClient(client, { firmId, clientId, packId, palette, birthChart });
  if ((existingRes.rows || []).some((row) => String(row.code || '').trim())) {
    return none('coded_chart_present', packId);
  }
  const byName = new Map();
  for (const row of existingRes.rows || []) {
    const key = normalizeIntelText(row.name);
    if (key && !byName.has(key)) byName.set(key, row);
  }

  const inserted = [];
  const filled = [];
  for (const account of palette) {
    const name = String(account.name || '').trim();
    const role = isAccountRole(account.role) ? account.role : null;
    if (!name) continue;
    const shape = __ledgerAccountMintShape({ account: {}, canonicalRole: role });
    const existing = byName.get(normalizeIntelText(name));
    if (existing) {
      const typeUnknown = !existing.account_type || existing.account_type === 'unknown';
      const roleMissing = !existing.canonical_role && Boolean(role);
      // Only a row that the mint left half-typed is touched; a fill that would
      // change nothing (unknown → unknown for a clearing role) is not a fill.
      if (!(typeUnknown && shape.account_type !== 'unknown') && !roleMissing) continue;
      await client.query(
        `update ledger_accounts
            set account_type = case
                  when account_type is null or account_type in ('', 'unknown') then $3
                  else account_type
                end,
                normal_balance = case
                  when account_type is null or account_type in ('', 'unknown') then $4
                  else normal_balance
                end,
                canonical_role = coalesce(canonical_role, $5),
                payload = payload || $6::jsonb,
                updated_at = now()
          where id = $1 and firm_id = $2`,
        [
          existing.id,
          firmId,
          shape.account_type,
          shape.normal_balance,
          role,
          JSON.stringify({ palette_pack_id: packId, palette_filled_at: new Date().toISOString() })
        ]
      );
      filled.push(name);
      continue;
    }
    const accountId = ledgerRecordId('account', firmId, clientId, name);
    const result = await client.query(
      `insert into ledger_accounts (
         id, firm_id, client_id, code, name, account_type, normal_balance, currency, tax_type, canonical_role, status, payload
       )
       values ($1, $2, $3, null, $4, $5, $6, null, null, $7, 'active', $8::jsonb)
       on conflict (id) do nothing
       returning id`,
      [
        accountId,
        firmId,
        clientId,
        name,
        shape.account_type,
        shape.normal_balance,
        role,
        JSON.stringify({ source: 'pack_palette_seed', label: name, palette_pack_id: packId })
      ]
    );
    if (result.rows?.length || result.rowCount) inserted.push(name);
  }

  if (inserted.length || filled.length) {
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
       values ($1, $2, 'system', '${PACK_PALETTE_CHART_SEED_ACTION}', 'client', $2, $3::jsonb)`,
      [firmId, clientId, JSON.stringify({ pack_id: packId, inserted, filled })]
    );
  }
  return { seeded: true, reason: inserted.length || filled.length ? 'seeded' : 'already_complete', pack_id: packId, inserted, filled };
};

// The coded birth chart (FI-21). Same writer plane, same receipt action as the
// palette seed: one insert per account (id keyed on the CODE — the scheme the
// journal upsert uses for coded accounts, so postings land on these rows) and
// one receipt naming the chart and version. A row the pack palette names takes
// the palette's role, so the chart can never disagree with the coder's menu;
// a palette name the pack does not declare is a deploy bug and refuses the
// birth rather than seeding a chart the menu cannot reach.
const seedMarketBirthChartWithClient = async (client, { firmId, clientId, packId, palette, birthChart }) => {
  const paletteRoles = new Map(palette.map((account) => [String(account.name || '').trim(), account.role]));
  const inserted = [];
  for (const account of birthChart.accounts) {
    if (account.palette_name && !paletteRoles.has(account.palette_name)) {
      throw Object.assign(new Error(`Birth chart ${birthChart.id} names '${account.palette_name}', which the ${packId} pack palette does not declare.`),
        { code: 'BIRTH_CHART_PALETTE_MISMATCH', statusCode: 500 });
    }
    const paletteRole = account.palette_name ? paletteRoles.get(account.palette_name) : null;
    const role = isAccountRole(paletteRole) ? paletteRole : isAccountRole(account.canonical_role) ? account.canonical_role : null;
    const label = `${account.code} · ${account.name}`;
    await client.query(
      `insert into ledger_accounts (
         id, firm_id, client_id, code, name, account_type, normal_balance, currency, tax_type, canonical_role, status, payload
       )
       values ($1, $2, $3, $4, $5, $6, $7, null, null, $8, 'active', $9::jsonb)`,
      [
        ledgerRecordId('account', firmId, clientId, account.code),
        firmId,
        clientId,
        account.code,
        account.name,
        account.account_type,
        account.normal_balance,
        role,
        JSON.stringify({
          source: 'market_birth_chart', label, palette_pack_id: packId,
          birth_chart: birthChart.id, birth_chart_version: birthChart.version,
          statutory_group: account.statutory_group || null,
          ...(account.palette_name ? { palette_name: account.palette_name } : {})
        })
      ]
    );
    inserted.push(label);
  }
  const chart = { id: birthChart.id, version: birthChart.version };
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
     values ($1, $2, 'system', '${PACK_PALETTE_CHART_SEED_ACTION}', 'client', $2, $3::jsonb)`,
    [firmId, clientId, JSON.stringify({ pack_id: packId, birth_chart: chart, inserted, filled: [] })]
  );
  return { seeded: true, reason: 'seeded', pack_id: packId, birth_chart: chart, inserted, filled: [] };
};

// Every journal account upsert follows the same client-scoped existing-row order.
// Native validation needs these locks earlier; the shared writer also takes them
// so ordinary no-tax journals cannot invert bank/counterparty acquisition.
const lockLedgerChartWithClient = ({client,firmId,clientId}) =>
  client.query('select id from ledger_accounts where firm_id=$1 and client_id=$2 order by id for update', [firmId,clientId]);

export const postLedgerJournalForTransaction = async ({
  client,
  firmId,
  clientId,
  transaction = {},
  coding = {},
  bankAccount = {},
  xeroBankTransactionId = null,
  xeroMatchStrategy = null,
  actorId = 'system',
  postingPolicyReceipt = null,
  sourceReceipt = null,
  // RT-21f: the verified settlement split the preparation derived from the
  // matched row (resolveSettlementRowSplit().split); null ⇒ unchanged.
  settlementSplit = null
} = {}) => {
  const currentRow = (await client.query('select * from transactions where firm_id = $1 and client_id = $2 and id = $3 for update',
    [firmId, clientId, transaction.id])).rows[0];
  const currentTransaction = rowToTransactionPayload(currentRow || {});
  const matchedDocument = await assertCurrentCodingEvidence({ client, firmId, clientId, transaction: currentTransaction, lock: true });
  assertPostingSourceReceipt(currentTransaction, sourceReceipt || postingSourceReceipt(transaction));
  assertPostingSourceReceipt(transaction, postingSourceReceipt(currentTransaction));
  const postingContext = await resolvePostingContextWithClient({ client, firmId, clientId,
    businessDate: transaction.date || transaction.transaction_date, lockContext: true });
  if (postingPolicyReceipt) assertPostingContextReceipt(postingContext, postingPolicyReceipt);
  assertPostingSuggestionLineage(postingContext, transaction);
  // RT-23: re-asserted at commit on the coding the journal is built from.
  // Re-read and lock the fact-bearing chart/evidence at the named boundary.
  if (transaction.tax_posting_facts) {
    // Match prepare's document → chart order even for direct named-writer calls.
    await readTaxPostingEvidence({client,firmId,clientId,documentId:transaction.tax_posting_facts.document_id,lock:true});
    await lockLedgerChartWithClient({client,firmId,clientId});
  }
  const taxPostingContext = await loadTaxPostingContext({ client, firmId, clientId, transaction,
    postingContext, ledgerAccounts: transaction.tax_posting_facts ? await getDonnaLedgerAccountsForClient({ client, firmId, clientId }) : [], lock: true });
  assertPostableTaxCoding(postingContext.policy, { coding, transaction, taxCodingEnabled: postingContext.taxCodingEnabled, profile: postingContext.profile, taxPostingContext, matchedDocument });
  let codingRepresentation = null;
  const documentAllocation = await resolveDocumentAllocation({ client, firmId, clientId, transaction: currentTransaction, postingContext,
    coding, onSingleAccount: receipt => { codingRepresentation = receipt; },
    ledgerAccounts: currentTransaction.ai_suggestion?.posting_requirement === 'document_allocation' ? await getDonnaLedgerAccountsForClient({ client, firmId, clientId }) : [] });
  if (settlementSplit) {
    const currentSettlement = await resolveSettlementRowSplit({ client, firmId, clientId,
      transaction: currentTransaction, coding, postingContext, ledgerAccounts: await getDonnaLedgerAccountsForClient({ client, firmId, clientId }), lock: true });
    if (!currentSettlement.planned || JSON.stringify(currentSettlement.split) !== JSON.stringify(settlementSplit)) {
      refuseSettlementSplit('SETTLEMENT_SPLIT_EVIDENCE_CHANGED', 'The settlement source changed after selection; reconsider the current source before posting.');
    }
  }
  if (coding.ae_vat_split && settlementSplit) throw Object.assign(new Error('UAE processor settlement is unsupported.'), { code: 'TRANSACTION_AE_VAT_SCOPE_UNSUPPORTED', statusCode: 409 });
  const journal = buildLedgerJournalForTransaction({
    transaction, coding, bankAccount,
    alvSplit: settlementAlvSplit(postingContext.policy, {
      coding, transaction, settlementSplit: settlementSplit ? { planned: true, split: settlementSplit } : null
    }),
    settlementSplit,
    documentAllocation
  });
  if (!journal.source_id) {
    const error = new Error('Ledger journal source transaction id is required.');
    error.statusCode = 400;
    error.code = 'LEDGER_MISSING_SOURCE_ID';
    throw error;
  }

  const existingJournal = await client.query(
    `select lj.id, lj.status, lj.journal_date, cp.id as close_period_id
     from ledger_journals lj
     left join close_periods cp
       on cp.firm_id = lj.firm_id
      and cp.client_id = lj.client_id
      and cp.status = 'locked'
      and lj.journal_date >= cp.period_start
      and lj.journal_date <= cp.period_end
     where lj.firm_id = $1
       and lj.client_id = $2
       and lj.source_type = $3
       and lj.source_id = $4
     limit 1`,
    [firmId, clientId, journal.source_type, journal.source_id]
  );
  if (existingJournal.rows[0]?.close_period_id) {
    const error = new Error('Ledger journal is in a locked close period. Use an adjustment journal instead of reposting.');
    error.statusCode = 409;
    error.code = 'LEDGER_LOCKED_PERIOD_IMMUTABLE';
    throw error;
  }
  const lockedPeriod = await client.query(
    `select id
     from close_periods
     where firm_id = $1
       and client_id = $2
       and status = 'locked'
       and period_start <= $3
       and period_end >= $3
     limit 1`,
    [firmId, clientId, journal.journal_date]
  );
  if (lockedPeriod.rows.length) {
    const error = new Error('Close period is locked. Post a dated adjustment journal instead of mutating the locked period.');
    error.statusCode = 409;
    error.code = 'LEDGER_LOCKED_PERIOD_IMMUTABLE';
    throw error;
  }

  const payload = {
    source: 'native_ledger',
    posting_policy: postingContext.receipt,
    ...(codingRepresentation ? { coding_representation: codingRepresentation } : {}),
    direction: journal.direction,
    amount: journal.amount,
    ...(journal.settlement_split ? { settlement_split: journal.settlement_split } : {}),
    xero_bank_transaction_id: xeroBankTransactionId || null,
    xero_match_strategy: xeroMatchStrategy || null,
    ...(coding.ae_vat_split ? { tax_point: coding.ae_vat_split.tax_point } : {})
  };
  const result = await __writeLedgerJournalRows({
    client, firmId, clientId, journal, payload,
    existingJournalId: existingJournal.rows[0]?.id || null,
    actorId
  });
  await recordCodingPolicyRecovery({ client, firmId, clientId, transactionIds: [transaction.id], policy: postingContext.policy, operation: 'posting' });
  return result;
};

// FI-5 — allocate the gap-free tositenumero (running voucher number) for a posted
// journal, from a row-locked per-tilikausi counter, inside the caller's transaction.
//
// Gap-free BY CONSTRUCTION, not by a Postgres SEQUENCE: a SEQUENCE burns a number
// on rollback (that is why audit_events.id is deliberately gap-prone). Every step
// here runs in the caller's begin/commit, so a failed post rolls the counter
// increment back with it — no number is ever consumed by an aborted post.
//   1. flags off ⇒ no-op (tosite_number stays null, behaviour unchanged)
//   2. lock THIS journal row: if it already carries a tosite_number, REUSE it and
//      return — a re-post (the upsert's UPDATE branch) never reallocates (which
//      would burn a number ⇒ a gap). This is the idempotency guard, driven by the
//      persisted column, so it is correct without depending on xmax/insert-vs-update.
//   3. resolve the tilikausi for the journal_date; ensure its fiscal_years row
//   4. SELECT next_tosite_no ... FOR UPDATE → serialize concurrent posts per
//      (client, tilikausi); the partial unique index (064) is the backstop
//   5. assign that number, bump the counter, stamp the journal, and emit
//      ledger.journal_posted (F3 companion, audit-as-precondition — a failed audit
//      aborts the post)
//
// Voids/reversals: a voided journal keeps its number; a reversing entry is a new
// source_id ⇒ a new journal row ⇒ its own next number. Never renumber, never reuse.
//
// NO-OP unless BOTH FINLAND_TOSITENUMERO and its dependency FINLAND_TILIKAUSI act
// for the client (dependency enforced here at flag-read).
const allocateTositeNumberTx = async ({ client, firmId, clientId, journalId, journalDate, actorId = 'system' }) => {
  const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  const { policy } = await readPostingAdmissionWithClient({ client, firmId, clientId });
  if (!policy?.voucherNumberingActs?.({ snapshot })) return null;
  if (typeof journalDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(journalDate)) return null;

  // Idempotency guard — lock the journal row and reuse an already-assigned number.
  // A concurrent re-post of the SAME journal is serialized by the natural-key
  // unique constraint at insert, so by the time it reads here the first post has
  // committed its number and this returns it (no double-allocation, no gap).
  const already = await client.query(
    `select tosite_number, fiscal_year_id from ledger_journals where id = $1 for update`,
    [journalId]
  );
  const existingNumber = already.rows[0]?.tosite_number ?? null;
  if (existingNumber != null) {
    return { tosite_number: existingNumber, fiscal_year_id: already.rows[0]?.fiscal_year_id ?? null };
  }

  const clientRow = await client.query(
    `select incorporation_date, entity_type from clients where firm_id = $1 and id = $2 limit 1`,
    [firmId, clientId]
  );
  const incorporationDate = clientRow.rows[0]?.incorporation_date || null;
  const entityType = clientRow.rows[0]?.entity_type || null;
  const fiscalYear = await resolveClientFiscalYearTx({ client, firmId, clientId, date: journalDate, incorporationDate, entityType });
  const fyRow = await ensureFiscalYearRowTx({ client, firmId, clientId, fiscalYear, actorId });
  if (!fyRow) return null;

  // Serialize the counter per (client, tilikausi). FOR UPDATE holds the lock to
  // the caller's commit; a concurrent post for the same year waits here.
  const locked = await client.query(
    `select next_tosite_no from fiscal_years where id = $1 for update`,
    [fyRow.id]
  );
  const tositeNumber = locked.rows[0]?.next_tosite_no;
  if (!Number.isInteger(tositeNumber)) return null;

  await client.query(
    `update fiscal_years set next_tosite_no = next_tosite_no + 1, updated_at = now() where id = $1`,
    [fyRow.id]
  );
  await client.query(
    `update ledger_journals set fiscal_year_id = $1, tosite_number = $2, updated_at = now() where id = $3`,
    [fyRow.id, tositeNumber, journalId]
  );
  // F3 companion — the transaction post path had NO journal-specific audit event
  // (design §0B). Emit it now, in-transaction, audit-as-precondition (nothing silent).
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'system', $3, 'ledger.journal_posted', 'ledger_journal', $4, $5::jsonb)`,
    [firmId, clientId, actorId, journalId, JSON.stringify({
      tosite_number: tositeNumber,
      fiscal_year_id: fyRow.id,
      fiscal_year_label: fyRow.label,
      journal_date: journalDate
    })]
  );
  return { tosite_number: tositeNumber, fiscal_year_id: fyRow.id };
};

// The shared row-writing tail of a ledger post: resolve the deterministic
// journal id, upsert the accounts, upsert the journal, replace its lines.
// Extracted verbatim from postLedgerJournalForTransaction (Slice 4b) so the
// document-settlement writer reuses the SAME insert discipline instead of a
// second copy. Callers own validation, period-lock checks, and the payload.
export const __writeLedgerJournalRows = async ({
  client, firmId, clientId, journal, payload = {}, existingJournalId = null, actorId = 'system'
}) => {
  const admission = await evaluateEntityReadinessAdmissionWithClient({
    client,
    firmId,
    clientId,
    boundary: 'ledger_write'
  });
  if (!admission.allowed) {
    // The journal caller owns this transaction and will roll it back. Persist
    // the refusal through the existing pooled writer so the recovery receipt
    // survives while every journal/account/line mutation remains zero.
    await recordEntityReadinessBlockedWithClient({
      client: { query: queryFirmDb },
      firmId,
      clientId,
      boundary: 'ledger_write',
      decision: admission,
      actorId,
      resourceType: 'ledger_source',
      resourceId: `${journal?.source_type || 'unknown'}:${journal?.source_id || 'unknown'}`
    });
    throw Object.assign(new EntityReadinessAdmissionError(admission), { actorId });
  }
  // Reuse the existing row's id when this (firm, client, source_type, source_id)
  // already has a journal — the id is a derived surrogate, and reusing the
  // stored value keeps a re-post stable even if the derivation ever changes.
  // New journals fall back to the deterministic id.
  const journalId = existingJournalId
    || ledgerRecordId('journal', firmId, clientId, journal.source_type, journal.source_id);

  // Country-owned receipt and owner-recovery effects share this admitted transaction.
  const { row: admissionRow, policy: countryAdmission } = await readPostingAdmissionWithClient({ client, firmId, clientId });
  const effectivePayload = countryAdmission?.beforeJournalWrite
    ? await countryAdmission.beforeJournalWrite({ client, firmId, clientId, journalId, journal, payload, actorId, clientRow: admissionRow, evaluatedAt: new Date().toISOString() })
    : payload;
  await lockLedgerChartWithClient({client,firmId,clientId});
  {
    const named = [...journal.accounts, ...journal.lines.map((line) => line.account || {})];
    const resolved = await resolvePaletteAliasAccountsWithClient({ client, firmId, clientId, accounts: named });
    if (resolved !== named) {
      const count = journal.accounts.length;
      journal = { ...journal, accounts: resolved.slice(0, count),
        lines: journal.lines.map((line, index) => (resolved[count + index] === named[count + index]
          ? line : { ...line, account: resolved[count + index] })) };
    }
  }
  const accountIds = new Map();
  for (const account of journal.accounts) {
    const key = `${account.role || ''}|${account.code || ''}|${account.name || ''}|${account.xero_account_id || ''}`;
    accountIds.set(
      key,
      await upsertLedgerAccountForJournal({
        client,
        firmId,
        clientId,
        account,
        currency: journal.currency
      })
    );
  }

  const journalResult = await client.query(
    `insert into ledger_journals (
       id, firm_id, client_id, source_type, source_id, journal_date, currency, status, memo, posted_at, payload
     )
     values ($1, $2, $3, $4, $5, $6, $7, 'posted', $8, now(), $9::jsonb)
     on conflict (firm_id, client_id, source_type, source_id) do update set
       journal_date = excluded.journal_date,
       currency = excluded.currency,
       status = 'posted',
       memo = excluded.memo,
       posted_at = coalesce(ledger_journals.posted_at, now()),
       payload = ledger_journals.payload || excluded.payload,
       updated_at = now()
     returning id`,
    [
      journalId,
      firmId,
      clientId,
      journal.source_type,
      journal.source_id,
      journal.journal_date,
      journal.currency,
      journal.memo,
      JSON.stringify(effectivePayload)
    ]
  );
  const resolvedJournalId = journalResult.rows[0]?.id || journalId;
  await client.query('delete from ledger_lines where journal_id = $1', [resolvedJournalId]);

  for (const [index, line] of journal.lines.entries()) {
    const account = line.account || {};
    const key = `${account.role || ''}|${account.code || ''}|${account.name || ''}|${account.xero_account_id || ''}`;
    const accountId = accountIds.get(key) ||
      await upsertLedgerAccountForJournal({ client, firmId, clientId, account, currency: journal.currency });
    await client.query(
      `insert into ledger_lines (
         id, journal_id, firm_id, client_id, account_id, account_code, account_name, line_no,
         direction, debit, credit, amount, currency, tax_type, memo, payload
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)`,
      [
        ledgerRecordId('line', resolvedJournalId, index + 1),
        resolvedJournalId,
        firmId,
        clientId,
        accountId,
        account.code || null,
        account.name || null,
        index + 1,
        line.direction,
        line.debit,
        line.credit,
        line.amount,
        line.currency,
        account.tax_type || null,
        line.memo || null,
        JSON.stringify({
          account_label: account.label || null,
          role: account.role || null
        })
      ]
    );
  }

  // FI-5 — allocate the gap-free tositenumero (no-op unless the Finland flags act).
  // Idempotent: the allocator locks the journal row and reuses an already-assigned
  // number, so a re-post never burns/reallocates (→ no gap). Same txn as the insert.
  const tosite = await allocateTositeNumberTx({
    client, firmId, clientId, journalId: resolvedJournalId, journalDate: journal.journal_date, actorId
  });

  return {
    ledger_journal_id: resolvedJournalId,
    ledger_status: 'posted',
    ledger_posted_at: new Date().toISOString(),
    ledger_line_count: journal.lines.length,
    ledger_amount: journal.amount,
    ledger_currency: journal.currency,
    ledger_tosite_number: tosite?.tosite_number ?? null,
    ledger_fiscal_year_id: tosite?.fiscal_year_id ?? null
  };
};

// Slice 4b (docs/donna-settlement-answer-and-ledger-entry-plan.md §3) — the
// owner's-funds credit account for a cash/personal-card settlement entry: the
// DONNA_COA 901 seed (xeroCoaProvisioning.js), jurisdiction-safe in all four
// markets (plan decision #2, ratified by the silent #792 merge).
// upsertLedgerAccountForJournal mints it on demand — no provisioning step.
export const DOCUMENT_SETTLEMENT_OWNER_FUNDS_ACCOUNT = Object.freeze({
  code: '901',
  name: 'Director loan',
  type: 'liability',
  canonical_role: 'liability.director_loan',
  tax_type: 'NONE'
});

// Slice 4b — the NAMED WRITER for a document-settlement journal (plan §3;
// INV-1: proposals route here, the card only observes). For a money-out doc
// whose persisted no_line_disposition settled with settlement_channel
// cash/personal_card, posts DR expense / CR owner-funds and flips the doc to
// the settled state the panel renders (render-the-persisted-verdict; the
// exact surface Failure B showed lying). The CALLER owns the transaction —
// this writer never begins/commits, mirroring postLedgerJournalForTransaction.
//
// What it writes, in order (all-or-nothing under the caller's txn):
//   1. builder → balanced-by-construction journal, re-asserted at runtime
//      (assertCorrectionLinesBalance — the Keep layer refuses, never shades).
//   2. The two period-lock checks VERBATIM from the transaction writer:
//      an existing document_settlement journal inside a locked period is
//      immutable, and a journal_date inside a locked period refuses with the
//      dated-adjustment message (409 LEDGER_LOCKED_PERIOD_IMMUTABLE).
//   3. __writeLedgerJournalRows — the SAME insert discipline as every other
//      ledger post; deterministic id ⇒ ONE entry per doc, ever.
//   4. documents: payment_status='paid' + payload.settlement_entry
//      {journal_id, posted_at, owner_notified:false, …} + the supersede —
//      no_line_disposition.owner_notified flips true so the stronger
//      "recorded" FYI replaces the weaker "explained" FYI (never two digest
//      lines for one doc).
//   5. audit ledger.post_document_settlement (resource document) with
//      before_state, authority basis, and the model id in metadata —
//      in-transaction, audit-as-precondition (a failed audit aborts the txn).
export const postDocumentSettlementJournalWithClient = async ({
  client,
  firmId,
  clientId,
  document = {},
  expenseAccount = {},
  ownerFundsAccount = DOCUMENT_SETTLEMENT_OWNER_FUNDS_ACCOUNT,
  settlement = {},
  authorityBasis = null,
  model = null,
  actorId = 'system'
} = {}) => {
  // Re-read denomination at the named writer. NOWAIT avoids holding another
  // runtime lock while waiting for a concurrent source correction; the existing
  // proposal retry re-enters after that correction commits.
  const source = (await client.query(
    'select * from documents where firm_id = $1 and client_id = $2 and id = $3 for update nowait',
    [firmId, clientId, document.id]
  )).rows[0];
  if (!source) throw Object.assign(new Error('Settlement document was not found for its ledger post.'), {
    statusCode: 404, code: 'DOCUMENT_SETTLEMENT_DOC_NOT_FOUND'
  });
  const currency = requireLedgerCurrency(source?.currency, 'document');
  assertLedgerCurrencyMatches(document.currency, currency, 'settlement source');
  // Posting consumes the locked source, not a stale proposal's amount or tax.
  const currentDocument = {...document,...source,currency};
  const disposition = source.payload?.no_line_disposition || {};
  if (disposition.settlement_channel === 'cash' && disposition.funding_source !== 'owner') {
    throw Object.assign(new Error('Cash settlement needs evidence of whose funds paid the document.'), {
      code:'DOCUMENT_SETTLEMENT_FUNDING_REQUIRED',statusCode:409});
  }
  const context = await resolvePostingContextWithClient({client,firmId,clientId,
    businessDate:toIsoDay(currentDocument.document_date),lockContext:true});
  const ledgerAccounts = context.policy.supplierBillNeedsChart
    ? await getDonnaLedgerAccountsForClient({client,firmId,clientId}) : [];
  const {alvSplit,expenseTaxType} = context.policy.capabilities.supplierBillTaxPosting
    ? executePostingPolicyOperation(context.policy,'supplierBillTaxPosting',{
      verdict:expenseAccount,document:currentDocument,ledgerAccounts,taxCodingEnabled:context.taxCodingEnabled,profile:context.profile})
    : {alvSplit:null,expenseTaxType:expenseAccount.tax_type || expenseAccount.xero_tax_type};
  const journal = buildLedgerJournalForDocumentSettlement({ document:currentDocument,
    expenseAccount:{...expenseAccount,tax_type:expenseTaxType,xero_tax_type:expenseTaxType},ownerFundsAccount,alvSplit });
  assertCorrectionLinesBalance(journal.lines);

  const existingJournal = await client.query(
    `select lj.id, lj.status, lj.journal_date, cp.id as close_period_id
     from ledger_journals lj
     left join close_periods cp
       on cp.firm_id = lj.firm_id
      and cp.client_id = lj.client_id
      and cp.status = 'locked'
      and lj.journal_date >= cp.period_start
      and lj.journal_date <= cp.period_end
     where lj.firm_id = $1
       and lj.client_id = $2
       and lj.source_type = $3
       and lj.source_id = $4
     limit 1`,
    [firmId, clientId, journal.source_type, journal.source_id]
  );
  if (existingJournal.rows[0]?.close_period_id) {
    const error = new Error('Ledger journal is in a locked close period. Use an adjustment journal instead of reposting.');
    error.statusCode = 409;
    error.code = 'LEDGER_LOCKED_PERIOD_IMMUTABLE';
    throw error;
  }
  const lockedPeriod = await client.query(
    `select id
     from close_periods
     where firm_id = $1
       and client_id = $2
       and status = 'locked'
       and period_start <= $3
       and period_end >= $3
     limit 1`,
    [firmId, clientId, journal.journal_date]
  );
  if (lockedPeriod.rows.length) {
    const error = new Error('Close period is locked. Post a dated adjustment journal instead of mutating the locked period.');
    error.statusCode = 409;
    error.code = 'LEDGER_LOCKED_PERIOD_IMMUTABLE';
    throw error;
  }

  const settlementReceipt = {
    document_id: document.id,
    settlement_channel: settlement.settlement_channel || null,
    verdict_source: settlement.verdict_source || null,
    evidence_request_id: settlement.evidence_request_id || null
  };
  const payload = {
    source: 'native_ledger_document_settlement',
    direction: journal.direction,
    amount: journal.amount,
    settlement: settlementReceipt,
    authority_basis: authorityBasis || null,
    model: model || null
  };
  const post = await __writeLedgerJournalRows({
    client, firmId, clientId, journal, payload,
    existingJournalId: existingJournal.rows[0]?.id || null,
    actorId
  });

  // The document flip + supersede. before_state captures everything the flip
  // touches, so a reverse restores it wholesale (pod-safety #2 shape).
  const prior = await client.query(
    `select payment_status,
            payload->'settlement_entry' as settlement_entry,
            payload->'no_line_disposition'->>'owner_notified' as no_line_owner_notified
       from documents
      where id = $1 and firm_id = $2 and client_id = $3`,
    [document.id, firmId, clientId]
  );
  if (!prior.rows.length) {
    const error = new Error('Settlement document was not found for its ledger post.');
    error.statusCode = 404;
    error.code = 'DOCUMENT_SETTLEMENT_DOC_NOT_FOUND';
    throw error;
  }
  const beforeState = {
    payment_status: prior.rows[0].payment_status ?? null,
    settlement_entry: prior.rows[0].settlement_entry ?? null,
    no_line_disposition_owner_notified: prior.rows[0].no_line_owner_notified ?? null
  };
  const expenseLine = journal.lines[0]?.account || {};
  const settlementEntry = {
    journal_id: post.ledger_journal_id,
    posted_at: post.ledger_posted_at,
    amount: journal.amount,
    currency: journal.currency,
    expense_account: expenseLine.label || expenseLine.name || '',
    owner_funds_account: `${ownerFundsAccount.code || ''} · ${ownerFundsAccount.name || ''}`.replace(/^ · /, ''),
    settlement_channel: settlementReceipt.settlement_channel,
    verdict_source: settlementReceipt.verdict_source,
    evidence_request_id: settlementReceipt.evidence_request_id,
    authority_basis: authorityBasis || null,
    model: model || null,
    // The recorded-FYI marker: gathered by the ask-batch draft while 'false',
    // flipped true at the single send chokepoint (exactly-once, like the
    // explained-FYI marker this supersedes).
    owner_notified: false
  };
  await client.query(
    `update documents
        set payment_status = 'paid',
            payload = case
              when coalesce(payload, '{}'::jsonb) ? 'no_line_disposition'
                then jsonb_set(
                  coalesce(payload, '{}'::jsonb) || $4::jsonb,
                  '{no_line_disposition,owner_notified}', 'true'::jsonb, true)
              else coalesce(payload, '{}'::jsonb) || $4::jsonb
            end,
            updated_at = now()
      where id = $1 and firm_id = $2 and client_id = $3`,
    [document.id, firmId, clientId, JSON.stringify({ settlement_entry: settlementEntry })]
  );

  // Audit-as-precondition: inside the caller's txn — no record, no post.
  const auditResult = await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'system', $3, 'ledger.post_document_settlement', 'document', $4, $5::jsonb)
     returning id`,
    [firmId, clientId, actorId, document.id, JSON.stringify({
      journal_id: post.ledger_journal_id,
      amount: journal.amount,
      currency: journal.currency,
      expense_account: settlementEntry.expense_account,
      owner_funds_account: settlementEntry.owner_funds_account,
      settlement_channel: settlementReceipt.settlement_channel,
      verdict_source: settlementReceipt.verdict_source,
      evidence_request_id: settlementReceipt.evidence_request_id,
      authority_basis: authorityBasis || null,
      model: model || null,
      before_state: beforeState
    })]
  );

  return {
    journal_id: post.ledger_journal_id,
    audit_event_id: auditResult.rows[0]?.id != null ? String(auditResult.rows[0].id) : null,
    before_state: beforeState,
    settlement_entry: settlementEntry,
    post
  };
};

// FI-6 Half A — post a switcher's opening balances (avaava tase) as ONE balanced
// opening journal dated at the tilikausi start, routed through the SAME
// __writeLedgerJournalRows every other post uses (INV-1: a router, never a second
// accounting backend). It inherits FI-5 tosite allocation (the opening journal is
// the tilikausi's first voucher), the locked-period 409 guards, in-txn audit, and
// idempotent re-post. Caller owns the transaction (mirrors
// postDocumentSettlementJournalWithClient). Full design:
// docs/design-donna-finland-opening-balances.md §1.
//
// KEEP-layer guards — each refuses, none guesses:
//   - the opening journal balances (buildOpeningBalanceJournal + assertCorrectionLinesBalance)
//   - it is dated at the tilikausi start (buildOpeningBalanceJournal)
//   - ONE avaava tase per tilikausi (natural key opening_balance/<fiscal_year_id>;
//     a re-seed REPLACES via the upsert, never appends a second opening)
//   - GREENFIELD refuses: a client whose incorporation IS the tilikausi start has
//     nothing to carry forward (category error)
//   - only into an OPEN, non-locked tilikausi (reuses the period-lock one-way-door)
//
// NO-OP/refuse guard: requires BOTH FINLAND_OPENING_BALANCES and its dependency
// FINLAND_TILIKAUSI to act for the client — a switcher seed is a Finland feature,
// never a silent write on a non-Finnish book.
const postOpeningBalanceJournalForJurisdictionWithClient = async ({
  client, firmId, clientId, fiscalPeriod, sourceId, openingLines, currency,
  memo, authorityBasis, model, actorId, openingSource = null
}) => {
  const journal = buildOpeningBalanceJournal({
    fiscalYear: { id: fiscalPeriod.id, label: fiscalPeriod.label, starts_on: fiscalPeriod.starts_on },
    openingLines,
    currency,
    memo
  });
  journal.source_id = sourceId;
  // Belt-and-braces: the builder already refuses an unbalanced seed; re-assert on
  // the write path (the Keep layer refuses, never shades).
  assertCorrectionLinesBalance(journal.lines);

  // Locked-period one-way-door (identical to the settlement writer): an opening
  // journal may not be posted into a locked close period / on a locked date.
  const existingJournal = await client.query(
    `select lj.id, lj.status, lj.journal_date, cp.id as close_period_id
     from ledger_journals lj
     left join close_periods cp
       on cp.firm_id = lj.firm_id
      and cp.client_id = lj.client_id
      and cp.status = 'locked'
      and lj.journal_date >= cp.period_start
      and lj.journal_date <= cp.period_end
     where lj.firm_id = $1
       and lj.client_id = $2
       and lj.source_type = $3
       and lj.source_id = $4
     limit 1`,
    [firmId, clientId, journal.source_type, journal.source_id]
  );
  if (existingJournal.rows[0]?.close_period_id) {
    const error = new Error('Opening journal is in a locked close period. A closed fiscal-period opening is immutable.');
    error.statusCode = 409;
    error.code = 'LEDGER_LOCKED_PERIOD_IMMUTABLE';
    throw error;
  }
  const lockedPeriod = await client.query(
    `select id
     from close_periods
     where firm_id = $1
       and client_id = $2
       and status = 'locked'
       and period_start <= $3
       and period_end >= $3
     limit 1`,
    [firmId, clientId, journal.journal_date]
  );
  if (lockedPeriod.rows.length) {
    const error = new Error('Close period is locked at the fiscal-period start. Cannot seed an opening balance into a locked period.');
    error.statusCode = 409;
    error.code = 'LEDGER_LOCKED_PERIOD_IMMUTABLE';
    throw error;
  }

  const payload = {
    source: 'native_ledger_opening_balance',
    ...(openingSource ? { opening_source: openingSource } : {}),
    direction: journal.direction,
    amount: journal.amount,
    fiscal_year_id: fiscalPeriod.id,
    fiscal_year_label: fiscalPeriod.label,
    authority_basis: authorityBasis || null,
    // The model id is part of the receipt (a strong-model TB extraction records
    // which model produced the opening figures).
    model: model || null
  };
  const post = await __writeLedgerJournalRows({
    client, firmId, clientId, journal, payload,
    existingJournalId: existingJournal.rows[0]?.id || null,
    actorId
  });

  // Audit-as-precondition: a material statutory mutation (seeding equity) records
  // its own event in-txn — no record, no post. (__writeLedgerJournalRows also emits
  // ledger.journal_posted via the tosite allocator; this is the opening-specific
  // receipt with the full seed metadata.)
  const auditResult = await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'system', $3, 'ledger.post_opening_balance', 'ledger_journal', $4, $5::jsonb)
     returning id`,
    [firmId, clientId, actorId, post.ledger_journal_id, JSON.stringify({
      fiscal_year_id: fiscalPeriod.id,
      fiscal_year_label: fiscalPeriod.label,
      journal_date: journal.journal_date,
      currency: journal.currency,
      total: journal.amount,
      line_count: journal.lines.length,
      tosite_number: post.ledger_tosite_number ?? null,
      authority_basis: authorityBasis || null,
      ...(openingSource ? { opening_source: openingSource } : {}),
      model: model || null
    })]
  );

  return {
    journal_id: post.ledger_journal_id,
    fiscal_year_id: fiscalPeriod.id,
    tosite_number: post.ledger_tosite_number ?? null,
    audit_event_id: auditResult.rows[0]?.id != null ? String(auditResult.rows[0].id) : null,
    post
  };

};

export const postOpeningBalanceJournalWithClient = async ({
  client,
  firmId = DEFAULT_FIRM_ID,
  clientId,
  asOf = null,
  openingLines = [],
  currency = 'EUR',
  memo = null,
  authorityBasis = null,
  model = null,
  actorId = 'system'
} = {}) => {
  if (!clientId) {
    const error = new Error('Client id is required to seed opening balances.');
    error.statusCode = 400;
    throw error;
  }
  const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  requirePostingAdmission('fi').assertOpeningBalanceEnabled({ snapshot });
  const asOfDate = ledgerDateOnly(asOf);
  if (!asOfDate) throw Object.assign(new Error('Opening-balance seeding requires a target date (asOf) inside the tilikausi to seed.'), { statusCode: 400, code: 'OPENING_BALANCE_MISSING_AS_OF' });
  const clientRow = await client.query(`select incorporation_date, entity_type, jurisdiction, profile from clients where firm_id = $1 and id = $2 limit 1`, [firmId, clientId]);
  requirePostingAdmission('fi').assertOpeningBalanceJurisdiction(clientRow.rows[0]);
  const incorporationDate = clientRow.rows[0]?.incorporation_date || null;
  const entityType = clientRow.rows[0]?.entity_type || null;
  const fiscalYear = await resolveClientFiscalYearTx({ client, firmId, clientId, date: asOfDate, incorporationDate, entityType });
  if (incorporationDate && ledgerDateOnly(incorporationDate) === fiscalYear.starts_on) throw Object.assign(new Error('Greenfield client has no opening balances to seed.'), { statusCode: 409, code: 'OPENING_BALANCE_GREENFIELD_NO_SEED' });
  const fyRow = await ensureFiscalYearRowTx({ client, firmId, clientId, fiscalYear, actorId });
  if (!fyRow) throw Object.assign(new Error('Could not resolve the tilikausi row for the opening balance.'), { statusCode: 500, code: 'OPENING_BALANCE_NO_FISCAL_YEAR' });
  // The FI natural key is the BARE tilikausi id — the value buildOpeningBalanceJournal
  // already produces (`ledger.js`: source_id = trim(fiscalYear.id)), pinned by
  // ledger.test.js "source_id is the tilikausi id (one avaava tase per year)".
  // Do NOT market-tag it. (source_type, source_id) is both the idempotent upsert key
  // and the lookup behind the locked-period immutability check, so prefixing it would
  // miss an already-persisted opening journal — bypassing the lock guard and appending
  // a SECOND avaava tase instead of replacing the first. A market tag buys nothing
  // here either: fiscal_years.id is already globally unique and a client has exactly
  // one jurisdiction, so FI and GB cannot collide on it.
  return postOpeningBalanceJournalForJurisdictionWithClient({ client, firmId, clientId, fiscalPeriod: fyRow, sourceId: fyRow.id, openingLines, currency, memo, authorityBasis, model, actorId });
};

export const GB_OPENING_BALANCES_FLAG_KEY = 'GB_OPENING_BALANCES';

export const postGbOpeningBalanceJournalWithClient = async ({ client, firmId = DEFAULT_FIRM_ID, clientId, asOf = null, openingLines = [], currency = 'GBP', memo = null, authorityBasis = null, model = null, actorId = 'system' } = {}) => {
  if (!clientId) throw Object.assign(new Error('Client id is required to seed GB opening balances.'), { statusCode: 400, code: 'OPENING_BALANCE_CLIENT_REQUIRED' });
  const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  if (!clientFlagActs({ flagKey: GB_OPENING_BALANCES_FLAG_KEY, snapshot, envFallback: () => false })) throw Object.assign(new Error('GB opening balances are disabled for this client.'), { statusCode: 409, code: 'GB_OPENING_BALANCES_DISABLED' });
  const asOfDate = ledgerDateOnly(asOf);
  if (!asOfDate) throw Object.assign(new Error('GB opening balances require an asOf date.'), { statusCode: 400, code: 'OPENING_BALANCE_MISSING_AS_OF' });
  const clientRow = await client.query(`select jurisdiction, incorporation_date from clients where firm_id = $1 and id = $2 limit 1 for update`, [firmId, clientId]);
  if (String(clientRow.rows[0]?.jurisdiction || '').trim().toUpperCase() !== 'GB') throw Object.assign(new Error('GB opening balances require a persisted GB client jurisdiction.'), { statusCode: 409, code: 'GB_OPENING_BALANCE_JURISDICTION_REQUIRED' });
  const periods = await client.query(`select id, label, starts_on, ends_on, status from fiscal_years where firm_id = $1 and client_id = $2 and starts_on <= $3::date and ends_on >= $3::date for update`, [firmId, clientId, asOfDate]);
  if (periods.rows.length !== 1 || periods.rows[0].status !== 'open') throw Object.assign(new Error('GB opening balances require exactly one persisted open fiscal period.'), { statusCode: 409, code: 'GB_OPENING_BALANCE_OPEN_PERIOD_REQUIRED' });
  const fiscalPeriod = { ...periods.rows[0], starts_on: ledgerDateOnly(periods.rows[0].starts_on), ends_on: ledgerDateOnly(periods.rows[0].ends_on) };
  if (clientRow.rows[0]?.incorporation_date && ledgerDateOnly(clientRow.rows[0].incorporation_date) === fiscalPeriod.starts_on) throw Object.assign(new Error('Greenfield client has no opening balances to seed.'), { statusCode: 409, code: 'OPENING_BALANCE_GREENFIELD_NO_SEED' });
  return postOpeningBalanceJournalForJurisdictionWithClient({ client, firmId, clientId, fiscalPeriod, sourceId: `GB:${fiscalPeriod.id}`, openingLines, currency, memo, authorityBasis, model, actorId });
};

// AE is an exact persisted-confirmation adapter, never arbitrary market selection.
export const postAeOpeningBalanceJournalWithClient = async ({ client, firmId = DEFAULT_FIRM_ID, clientId, askId, proposalDigest, actorId, authorityBasis } = {}) => {
  const prepared = await prepareAeOpeningPostWithClient({ client, firmId, clientId, askId, proposalDigest, actorId, authorityBasis });
  if (prepared.replay) return prepared.replay;
  const { context, state, proposal } = prepared;
  actorId = prepared.actorId;
  const openingSource = { proposal_digest: state.proposal_digest, intake_digest: aeOpeningDigest(state.intake), source_document_id: context.source.id,
    source_as_of: proposal.source_as_of, as_of: proposal.as_of, context_fingerprint: context.fingerprint,
    prior_journal_id: state.prior_journal_id, prior_opening_digest: state.prior_opening_digest,
    complete: true, intake_kind: 'owner_declared_complete_trial_balance', limitations: proposal.limitations };
  const receipt = await postOpeningBalanceJournalForJurisdictionWithClient({ client, firmId, clientId,
    fiscalPeriod: context.period, sourceId: `AE:${context.period.id}`, openingLines: proposal.openingLines,
    currency: proposal.currency, memo: `Opening trial balance — ${proposal.as_of}`, authorityBasis, actorId, openingSource });
  return finishAeOpeningPostWithClient({ client, firmId, clientId, actorId, authorityBasis, prepared, receipt });
};

// FI-6 Half A — standalone entry: opens its own transaction around the WithClient
// writer (begin/commit/rollback), so the intake layer (TB-extract or bank-only)
// can seed opening balances without owning a connection. Mirrors the settlement
// writer's txn discipline.
export const postOpeningBalanceJournalFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  asOf = null,
  openingLines = [],
  currency = 'EUR',
  memo = null,
  authorityBasis = null,
  model = null,
  actorId = 'system'
} = {}) => {
  return withFirmDbClient(async (client) => {
    await requireClientInFirm({ client, firmId, clientId });
    await client.query('begin');
    try {
      const result = await postOpeningBalanceJournalWithClient({
        client, firmId, clientId, asOf, openingLines, currency, memo, authorityBasis, model, actorId
      });
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
};

export const postGbOpeningBalanceJournalFromDb = async ({
  firmId = DEFAULT_FIRM_ID, clientId, asOf = null, openingLines = [], currency = 'GBP',
  memo = null, authorityBasis = null, model = null, actorId = 'system'
} = {}) => withFirmDbClient(async (client) => {
  await requireClientInFirm({ client, firmId, clientId });
  await client.query('begin');
  try {
    const result = await postGbOpeningBalanceJournalWithClient({ client, firmId, clientId, asOf, openingLines, currency, memo, authorityBasis, model, actorId });
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
});

// ---------------------------------------------------------------------------------
// Tax-posting profiles for buildSalesInvoiceJournal (2026-07-27).
// ---------------------------------------------------------------------------------
// `ledger.js` no longer imports any country module: it takes the per-rate output
// code map and the tax control account as an injected `taxPosting`, and the two
// callers below supply their market's. Design:
// docs/design-donna-gb-vat-ar-posting.md §3–§4.
//
// The two profiles are DELIBERATELY not the same shape underneath, and that
// asymmetry is the design rather than an inconsistency: Finland ships a
// statutory chart of accounts (tilikartta 2939), so a hardcoded account code is
// a real statutory fact; the UK ships none, so GB's control account is resolved
// from the CLIENT's own chart by canonical role and a hardcoded GB code would be
// an invention wearing a statutory face.
const roundTaxMoney2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

// FI-10 send-half — the NAMED WRITER for an issued sale invoice's AR journal
// (INV-1: routes through the SAME __writeLedgerJournalRows every other post uses —
// never a second accounting backend). It inherits FI-5 tosite allocation, the
// locked-period 409 guards, in-txn ledger.journal_posted audit, and idempotent
// re-post on the natural key sales_invoice/<invoiceNumber>. Caller owns the
// transaction (mirrors postOpeningBalanceJournalWithClient). Design:
// docs/design-donna-finland-fi10-send-half.md.
//
// KEEP-layer guards — each refuses, none guesses:
//   - FINLAND_INVOICING must act for the client (config plane, envFallback false)
//   - ACCRUAL-ONLY (D-FI10-S1): a cash-basis client refuses — under cash basis
//     income is recognized at settlement (the bank-line reconciliation path),
//     never at issuance
//   - non-ALV only (D-FI10-S2, enforced in buildSalesInvoiceJournal): a VAT total
//     refuses until FI-2/FI-3 wire the ALV-payable side
//   - the journal balances (builder + assertCorrectionLinesBalance re-assert)
//   - locked-period one-way-door checks verbatim from the opening/settlement writers
//   - audit-as-precondition: the ledger.post_sales_invoice receipt (authority
//     basis + model id + tosite) records in the SAME txn — no record, no post
export const postSalesInvoiceJournalWithClient = async ({
  client,
  firmId = DEFAULT_FIRM_ID,
  clientId,
  invoice = null,
  currency = 'EUR',
  memo = null,
  authorityBasis = null,
  model = null,
  actorId = 'system'
} = {}) => {
  if (!clientId) {
    const error = new Error('Client id is required to post a sales-invoice journal.');
    error.statusCode = 400;
    throw error;
  }
  if (!invoice || typeof invoice !== 'object') {
    const error = new Error('A built invoice (buildInvoice result) is required to post a sales-invoice journal.');
    error.statusCode = 400;
    error.code = 'SALES_INVOICE_MISSING_INVOICE';
    throw error;
  }

  const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  requirePostingAdmission('fi').assertInvoiceEnabled({ snapshot, kind: 'Sales-invoice' });

  // D-FI10-S1 — accrual-only. Basis is a CLIENT attribute: a cash-basis
  // (yhdenkertainen) book recognizes income at settlement; the existing
  // reconciliation path books it when the payment lands (viitenumero match).
  const postingContext = await resolvePostingContextWithClient({ client, firmId, clientId, businessDate: invoice.date, lockContext: true });
  if (!postingContext.policy.salesInvoiceChannels.includes('finland')) {
    throw new PostingPolicyError('posting_operation_unsupported', { jurisdiction: postingContext.policy.jurisdiction,
      details: { reason: 'sales_invoice_channel_unsupported' } });
  }
  const basis = clientAccountingBasisFromProfile(postingContext.row);
  if (basis !== 'accrual') {
    const error = new Error('A cash-basis client does not post AR at issuance — income books at settlement via reconciliation.');
    error.statusCode = 409;
    error.code = 'SALES_INVOICE_CASH_BASIS_NO_AR_POST';
    throw error;
  }

  const journal = buildSalesInvoiceJournal({
    invoice,
    currency: currency || invoice.currency,
    memo,
    // 2026-07-27 — the FI tax-posting profile, injected rather than imported by
    // ledger.js (gap 8's fourth edge, now deleted from the isolation-listed post
    // path). The SAME frozen vocabulary and the SAME control account the builder
    // used to reach for directly, so this lane is byte-identical: FI's statutory
    // 2939 stays hardcoded because Finland ships a statutory tilikartta, which
    // is exactly why GB's equivalent resolves by role instead.
    taxPosting: executePostingPolicyOperation(postingContext.policy, 'salesInvoiceTaxPosting', { channel: 'finland' })
  });
  // Belt-and-braces: the builder already refuses an unbalanced journal; re-assert
  // on the write path (the Keep layer refuses, never shades).
  assertCorrectionLinesBalance(journal.lines);

  // Locked-period one-way-door (verbatim discipline from the opening/settlement
  // writers): neither an existing sales_invoice journal inside a locked period nor
  // a journal_date inside one may be (re)posted.
  const existingJournal = await client.query(
    `select lj.id, lj.status, lj.journal_date, cp.id as close_period_id
     from ledger_journals lj
     left join close_periods cp
       on cp.firm_id = lj.firm_id
      and cp.client_id = lj.client_id
      and cp.status = 'locked'
      and lj.journal_date >= cp.period_start
      and lj.journal_date <= cp.period_end
     where lj.firm_id = $1
       and lj.client_id = $2
       and lj.source_type = $3
       and lj.source_id = $4
     limit 1`,
    [firmId, clientId, journal.source_type, journal.source_id]
  );
  if (existingJournal.rows[0]?.close_period_id) {
    const error = new Error('Sales-invoice journal is in a locked close period. Post a dated adjustment instead.');
    error.statusCode = 409;
    error.code = 'LEDGER_LOCKED_PERIOD_IMMUTABLE';
    throw error;
  }
  const lockedPeriod = await client.query(
    `select id
     from close_periods
     where firm_id = $1
       and client_id = $2
       and status = 'locked'
       and period_start <= $3
       and period_end >= $3
     limit 1`,
    [firmId, clientId, journal.journal_date]
  );
  if (lockedPeriod.rows.length) {
    const error = new Error('Close period is locked at the invoice date. Post a dated adjustment instead.');
    error.statusCode = 409;
    error.code = 'LEDGER_LOCKED_PERIOD_IMMUTABLE';
    throw error;
  }

  const payload = {
    source: 'native_ledger_sales_invoice',
    posting_policy: postingContext.receipt,
    direction: journal.direction,
    amount: journal.amount,
    invoice_number: journal.source_id,
    buyer_name: invoice.buyer?.name || null,
    reference_number: invoice.referenceNumber || null,
    authority_basis: authorityBasis || null,
    // The model id is part of the receipt (when a model drafted the invoice).
    model: model || null
  };
  const post = await __writeLedgerJournalRows({
    client, firmId, clientId, journal, payload,
    existingJournalId: existingJournal.rows[0]?.id || null,
    actorId
  });

  // Audit-as-precondition: the sales-invoice receipt records in the SAME txn —
  // no record, no post. (__writeLedgerJournalRows also emits ledger.journal_posted
  // via the tosite allocator; this is the invoice-specific receipt.)
  const auditResult = await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'system', $3, 'ledger.post_sales_invoice', 'ledger_journal', $4, $5::jsonb)
     returning id`,
    [firmId, clientId, actorId, post.ledger_journal_id, JSON.stringify({
      invoice_number: journal.source_id,
      journal_date: journal.journal_date,
      currency: journal.currency,
      total: journal.amount,
      buyer_name: invoice.buyer?.name || null,
      tosite_number: post.ledger_tosite_number ?? null,
      authority_basis: authorityBasis || null,
      model: model || null
    })]
  );

  return {
    journal_id: post.ledger_journal_id,
    invoice_number: journal.source_id,
    tosite_number: post.ledger_tosite_number ?? null,
    audit_event_id: auditResult.rows[0]?.id != null ? String(auditResult.rows[0].id) : null,
    post
  };
};

// FI-10 send-half — standalone entry: opens its own transaction around the
// WithClient writer, mirroring postOpeningBalanceJournalFromDb's txn discipline.
export const postSalesInvoiceJournalFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  invoice = null,
  currency = 'EUR',
  memo = null,
  authorityBasis = null,
  model = null,
  actorId = 'system'
} = {}) => {
  return withFirmDbClient(async (client) => {
    await requireClientInFirm({ client, firmId, clientId });
    await client.query('begin');
    try {
      const result = await postSalesInvoiceJournalWithClient({
        client, firmId, clientId, invoice, currency, memo, authorityBasis, model, actorId
      });
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
};

// ---------------------------------------------------------------------------------
// OUTBOUND — the AR journal for an outbound-pipeline issued invoice (the "US AR
// ledger post" slice; jurisdiction-neutral by construction). A NEW SIBLING routed
// through the SAME __writeLedgerJournalRows backend (INV-1) — the FI writer above
// keeps serving finland/ byte-identical. Accounts come from the CLIENT'S OWN chart
// resolved by CANONICAL ROLE (chart-of-accounts resolution at write-back): exactly
// one ACTIVE 'asset.accounts_receivable' row and one 'revenue.operating' row; zero
// or many REFUSE with a named code — never a guessed account, never a mint-at-post
// (chart pollution is the #497 class of bug).
//
// KEEP-layer guards, each a typed refusal the outbound finalize catches into a
// RECEIPTED skip (a books refusal never blocks the send lifecycle — the send
// already happened; the skip rests visible on the receipt and the issued row):
//   - OUTBOUND_INVOICING must act for the client (config plane, envFallback false)
//   - accrual-only: cash basis refuses SALES_INVOICE_CASH_BASIS_NO_AR_POST (income
//     books at settlement — the D-FI10-S1 posture; the SAME code, so the caller's
//     cashBasisSkip lane is shared with the FI motion)
//   - tax-free only: buildSalesInvoiceJournal's non-registered branch refuses a
//     declared tax total (SALES_INVOICE_ALV_UNSUPPORTED) — the sales-tax payable
//     leg is deliberately unwired (the D-FI10-S2 mirror; its own later slice)
//   - locked-period one-way-door checks verbatim from the FI writer
//   - audit-as-precondition: ledger.post_sales_invoice records in the SAME txn,
//     channel 'outbound_pipeline' — no record, no post
// Idempotent re-post on the natural key sales_invoice/<invoiceNumber> — the SAME
// key the FI lane uses, so one invoice can never carry two AR journals whatever
// lane touched it. Caller owns the transaction.
export const postOutboundArJournalWithClient = async ({
  client,
  firmId = DEFAULT_FIRM_ID,
  clientId,
  invoice = null,
  memo = null,
  authorityBasis = null,
  model = null,
  actorId = 'system'
} = {}) => {
  if (!clientId) {
    const error = new Error('Client id is required to post an outbound AR journal.');
    error.statusCode = 400;
    throw error;
  }
  if (!invoice || typeof invoice !== 'object') {
    const error = new Error('A built outbound invoice (draft.invoice) is required to post an AR journal.');
    error.statusCode = 400;
    error.code = 'SALES_INVOICE_MISSING_INVOICE';
    throw error;
  }

  const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  const invoicingActs = clientFlagActs({ flagKey: 'OUTBOUND_INVOICING', snapshot, envFallback: () => false });
  if (!invoicingActs) {
    const error = new Error('Outbound AR posting requires OUTBOUND_INVOICING acting for this client.');
    error.statusCode = 409;
    error.code = 'OUTBOUND_INVOICING_DISABLED';
    throw error;
  }

  // Accrual-only (the D-FI10-S1 posture): a cash-basis book recognizes income at
  // settlement via the reconciliation path, never at issuance.
  // `jurisdiction` joins the read for the tax-posting profile below — one query,
  // not a second round-trip for a column already on the row.
  const postingContext = await resolvePostingContextWithClient({ client, firmId, clientId, businessDate: invoice.date, lockContext: true });
  const basis = clientAccountingBasisFromProfile(postingContext.row);
  if (basis !== 'accrual') {
    const error = new Error('A cash-basis client does not post AR at issuance — income books at settlement via reconciliation.');
    error.statusCode = 409;
    error.code = 'SALES_INVOICE_CASH_BASIS_NO_AR_POST';
    throw error;
  }

  // Role-resolved accounts from the client's own chart. Fail-closed both ways:
  // no account and more-than-one account are each a NAMED refusal — the finalize
  // receipts the skip and the gap rests visible, never a guessed posting.
  const accountForRole = async (role, missingCode, ambiguousCode) => {
    const found = await client.query(
      `select id, code, name, account_type, normal_balance, currency, tax_type, canonical_role
         from ledger_accounts
        where firm_id = $1 and client_id = $2 and status = 'active' and canonical_role = $3
        order by code nulls last, name
        limit 2`,
      [firmId, clientId, role]
    );
    if (!found.rows.length) {
      const error = new Error(`No active ledger account carries canonical role '${role}' for this client.`);
      error.statusCode = 409;
      error.code = missingCode;
      throw error;
    }
    if (found.rows.length > 1) {
      const error = new Error(`More than one active ledger account carries canonical role '${role}' — ambiguous, refusing to guess.`);
      error.statusCode = 409;
      error.code = ambiguousCode;
      throw error;
    }
    const row = found.rows[0];
    return {
      code: row.code,
      name: row.name,
      type: row.account_type,
      normal_balance: row.normal_balance,
      tax_type: row.tax_type,
      canonical_role: row.canonical_role
    };
  };
  const receivableAccount = await accountForRole(
    'asset.accounts_receivable', 'OUTBOUND_AR_NO_RECEIVABLE_ACCOUNT', 'OUTBOUND_AR_AMBIGUOUS_RECEIVABLE_ACCOUNT'
  );
  const revenueAccount = await accountForRole(
    'revenue.operating', 'OUTBOUND_AR_NO_REVENUE_ACCOUNT', 'OUTBOUND_AR_AMBIGUOUS_REVENUE_ACCOUNT'
  );

  // --- the tax leg (2026-07-27) ---------------------------------------------
  // Design: docs/design-donna-gb-vat-ar-posting.md §3b/§3c/§4b. Until this
  // landed, a VAT-registered GB invoice SENT and then never booked AR — the
  // named skip `sales_tax_unwired` on an already-sent invoice, which is a
  // firm-side limbo with a polite name rather than either terminal state.
  //
  // Vocabulary mapping happens HERE, not in the journal builder: the generic
  // model carries `taxTotal` / `taxRate` / `taxAmount` and the builder speaks
  // `alvTotal` / `alvRate` / `alv`. Adapting at the caller (which already mapped
  // taxTotal → alvTotal) keeps the isolation-listed post path to ONE seam — the
  // injected profile — instead of teaching it a second vocabulary.
  const taxTotal = roundTaxMoney2(Number(invoice.taxTotal ?? invoice.alvTotal ?? 0) || 0);

  // TRI-STATE, and it must stay tri-state. `seller.taxRegistered` is
  // true / false / null-for-unknown by design (outbound/issuance.js; only a
  // RECORDED status yields false). Collapsing unknown into "not registered"
  // would post a net-only journal and silently drop output VAT — a statutory
  // error, not a cosmetic one. So:
  //   true            → the split branch
  //   false           → the net branch (a non-zero tax still refuses, by name)
  //   null + zero tax → the net branch, BYTE-IDENTICAL to the pre-2026-07-27
  //                     behaviour, which is what preserves every existing
  //                     caller (US invoices, and every invoice built before a
  //                     registration record existed)
  //   null + tax > 0  → REFUSE by name; never a guess in either direction
  const taxRegistered = typeof invoice.seller?.taxRegistered === 'boolean'
    ? invoice.seller.taxRegistered
    : null;
  // NO PRODUCER TODAY, AND KEPT DELIBERATELY (Kari decision, 2026-07-28).
  // `taxTotal > 0` is currently unreachable from production: createOutboundInvoiceDraft
  // has exactly two production callers and both pass zero — the owner-command lane
  // hardcodes `taxTotal: 0` (and refuses `tax_not_supported` before it gets here), and
  // the recurrence lane copies `previous.taxTotal || 0` from a draft only that lane
  // could have minted. This guard therefore cannot fire until some lane learns to put
  // tax on an outbound invoice — which is a known, named ISSUANCE gap, not a posting
  // one (`docs/design-donna-tax-registration-owner-ask.md` §2).
  //
  // It stays anyway: it is a correct fail-closed refusal that goes live the moment
  // that lane lands, and deleting a correct guard because nothing currently trips it
  // is exactly how the guard turns out to be missing on the day it matters. It is NOT
  // a firm-side rest and NOT a candidate for an owner ask — there is no invoice in
  // this state for anyone to be asked about. Do not describe it as either.
  if (taxRegistered === null && taxTotal > 0) {
    const error = new Error('This invoice declares tax but the seller\'s tax-registration status is not recorded — refusing to guess whether to post a VAT split or a net-only journal.');
    error.statusCode = 409;
    error.code = 'SALES_INVOICE_TAX_REGISTRATION_UNKNOWN';
    throw error;
  }

  // Only a declared invoice channel can supply this country's tax profile.
  let taxPosting = null;
  if (taxRegistered === true && postingContext.policy.salesInvoiceChannels.includes('outbound')) {
    const controlAccount = taxTotal > 0 && postingContext.policy.salesTaxControlRole
      ? await accountForRole(postingContext.policy.salesTaxControlRole,
        'OUTBOUND_AR_NO_SALES_TAX_ACCOUNT', 'OUTBOUND_AR_AMBIGUOUS_SALES_TAX_ACCOUNT')
      : null;
    taxPosting = executePostingPolicyOperation(postingContext.policy, 'salesInvoiceTaxPosting', { controlAccount, channel: 'outbound' });
  }

  // The builder's non-registered branch still refuses a non-zero tax
  // (SALES_INVOICE_ALV_UNSUPPORTED) and re-asserts totals and balance.
  const journal = buildSalesInvoiceJournal({
    invoice: {
      ...invoice,
      alvTotal: taxTotal,
      // `alvExempt === false` is what selects the split branch. undefined stays
      // undefined on the unknown-with-no-tax path, so that invoice takes the
      // exact same branch it took before this change.
      alvExempt: taxRegistered === null ? invoice.alvExempt : !taxRegistered,
      lines: Array.isArray(invoice.lines)
        ? invoice.lines.map((l) => ({
          ...l,
          // Declared, never computed — the generic model validates that per-line
          // tax is all-or-nothing and foots to taxTotal, so the builder's own
          // per-rate sums re-assert an invariant already established rather than
          // inventing one. `?? null` keeps an undeclared line at 0 the way the
          // net branch always treated it.
          alvRate: l?.taxRate ?? l?.alvRate ?? 0,
          alv: l?.taxAmount ?? l?.alv ?? 0
        }))
        : invoice.lines
    },
    currency: invoice.currency,
    memo: memo || `Invoice ${invoice.invoiceNumber}${invoice.buyer?.name ? ` — ${invoice.buyer.name}` : ''}`,
    receivableAccount,
    revenueAccount,
    taxPosting
  });
  assertCorrectionLinesBalance(journal.lines);

  // Locked-period one-way-door (verbatim discipline from the FI writer).
  const existingJournal = await client.query(
    `select lj.id, lj.status, lj.journal_date, cp.id as close_period_id
     from ledger_journals lj
     left join close_periods cp
       on cp.firm_id = lj.firm_id
      and cp.client_id = lj.client_id
      and cp.status = 'locked'
      and lj.journal_date >= cp.period_start
      and lj.journal_date <= cp.period_end
     where lj.firm_id = $1
       and lj.client_id = $2
       and lj.source_type = $3
       and lj.source_id = $4
     limit 1`,
    [firmId, clientId, journal.source_type, journal.source_id]
  );
  if (existingJournal.rows[0]?.close_period_id) {
    const error = new Error('Sales-invoice journal is in a locked close period. Post a dated adjustment instead.');
    error.statusCode = 409;
    error.code = 'LEDGER_LOCKED_PERIOD_IMMUTABLE';
    throw error;
  }
  const lockedPeriod = await client.query(
    `select id
     from close_periods
     where firm_id = $1
       and client_id = $2
       and status = 'locked'
       and period_start <= $3
       and period_end >= $3
     limit 1`,
    [firmId, clientId, journal.journal_date]
  );
  if (lockedPeriod.rows.length) {
    const error = new Error('Close period is locked at the invoice date. Post a dated adjustment instead.');
    error.statusCode = 409;
    error.code = 'LEDGER_LOCKED_PERIOD_IMMUTABLE';
    throw error;
  }

  const payload = {
    source: 'native_ledger_sales_invoice',
    posting_policy: postingContext.receipt,
    channel: 'outbound_pipeline',
    direction: journal.direction,
    amount: journal.amount,
    invoice_number: journal.source_id,
    buyer_name: invoice.buyer?.name || null,
    reference_number: invoice.referenceNumber || null,
    authority_basis: authorityBasis || null,
    // The model id is part of the receipt (when a model drafted the invoice).
    model: model || null
  };
  const post = await __writeLedgerJournalRows({
    client, firmId, clientId, journal, payload,
    existingJournalId: existingJournal.rows[0]?.id || null,
    actorId
  });

  // Audit-as-precondition: the sales-invoice receipt records in the SAME txn —
  // no record, no post.
  const auditResult = await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'system', $3, 'ledger.post_sales_invoice', 'ledger_journal', $4, $5::jsonb)
     returning id`,
    [firmId, clientId, actorId, post.ledger_journal_id, JSON.stringify({
      channel: 'outbound_pipeline',
      invoice_number: journal.source_id,
      journal_date: journal.journal_date,
      currency: journal.currency,
      total: journal.amount,
      buyer_name: invoice.buyer?.name || null,
      tosite_number: post.ledger_tosite_number ?? null,
      authority_basis: authorityBasis || null,
      model: model || null
    })]
  );

  return {
    journal_id: post.ledger_journal_id,
    invoice_number: journal.source_id,
    tosite_number: post.ledger_tosite_number ?? null,
    audit_event_id: auditResult.rows[0]?.id != null ? String(auditResult.rows[0].id) : null,
    post
  };
};

// ---------------------------------------------------------------------------------
// OUTBOUND — the post_send_reversal books half: reverse an outbound-posted AR
// journal via the EXISTING correction machinery (a line-mirrored 'reversal'
// correction journal with reversal_of_journal_id linkage — the postLedgerAdjustment
// motion, composed in the CALLER'S transaction so the outbound verb writer can
// bind the reversal, the D1 correction record, and the action marker atomically).
// The reversal journal is dated TODAY (an adjustment posts in the open period —
// never a mutation of the original), and a locked today refuses (the one-way-door
// discipline). Belt-and-braces: an already-reversed journal refuses — the verb's
// action-payload marker is the primary idempotency guard, this is the books-side
// double-check.
export const __reverseOutboundArJournalWithClient = async ({
  client,
  firmId = DEFAULT_FIRM_ID,
  clientId,
  arJournalId,
  reason = 'owner_post_send_reversal',
  journalDate = null,
  actorId = 'system'
} = {}) => {
  if (!clientId || !arJournalId) {
    const error = new Error('Client id and the AR journal id are required to reverse an outbound AR post.');
    error.statusCode = 400;
    error.code = 'OUTBOUND_AR_REVERSAL_ARGS_REQUIRED';
    throw error;
  }
  const originalResult = await client.query(
    `select *
     from ledger_journals
     where firm_id = $1
       and client_id = $2
       and id = $3
     limit 1`,
    [firmId, clientId, String(arJournalId)]
  );
  const originalJournal = originalResult.rows[0] || null;
  if (!originalJournal) {
    const error = new Error('The AR journal to reverse was not found.');
    error.statusCode = 404;
    error.code = 'OUTBOUND_AR_JOURNAL_NOT_FOUND';
    throw error;
  }
  if (!['posted', 'closed'].includes(originalJournal.status)) {
    const error = new Error('Only a posted or closed AR journal can be reversed.');
    error.statusCode = 409;
    error.code = 'OUTBOUND_AR_JOURNAL_NOT_POSTED';
    throw error;
  }
  const priorReversal = await client.query(
    `select id from ledger_journals
      where firm_id = $1 and client_id = $2 and reversal_of_journal_id = $3
      limit 1`,
    [firmId, clientId, originalJournal.id]
  );
  if (priorReversal.rows.length) {
    const error = new Error('This AR journal already carries a reversal.');
    error.statusCode = 409;
    error.code = 'OUTBOUND_AR_ALREADY_REVERSED';
    throw error;
  }
  const resolvedDate = ledgerDateOnly(journalDate || new Date());
  const lockedPeriod = await client.query(
    `select id
     from close_periods
     where firm_id = $1
       and client_id = $2
       and status = 'locked'
       and period_start <= $3
       and period_end >= $3
     limit 1`,
    [firmId, clientId, resolvedDate]
  );
  if (lockedPeriod.rows.length) {
    const error = new Error('Adjustment journal date falls inside a locked period. Use a later open period date.');
    error.statusCode = 409;
    error.code = 'LEDGER_ADJUSTMENT_DATE_LOCKED';
    throw error;
  }
  const originalLinesResult = await client.query(
    `select ll.*, la.account_type, la.normal_balance
     from ledger_lines ll
     join ledger_accounts la on la.id = ll.account_id
     where ll.firm_id = $1
       and ll.client_id = $2
       and ll.journal_id = $3
     order by ll.line_no`,
    [firmId, clientId, originalJournal.id]
  );
  const reversalLines = originalLinesResult.rows.map(rowToLedgerLinePayload).map(reverseLedgerLine);
  const reversal = await insertLedgerCorrectionJournal({
    client,
    firmId,
    clientId,
    sourceId: `outbound-ar-reversal-${originalJournal.id}`,
    journalDate: resolvedDate,
    currency: originalJournal.currency,
    memo: `Correction reversal: ${originalJournal.memo || originalJournal.id}`,
    lines: reversalLines,
    correctionType: 'reversal',
    correctionOfJournalId: originalJournal.id,
    reversalOfJournalId: originalJournal.id,
    correctionReason: String(reason || 'owner_post_send_reversal'),
    actorId
  });
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'system', $3, 'ledger.adjustment_posted', 'ledger_journal', $4, $5::jsonb)`,
    [firmId, clientId, actorId, reversal.ledger_journal_id, JSON.stringify({
      original_journal_id: originalJournal.id,
      transaction_id: originalJournal.source_id || null,
      reason: String(reason || 'owner_post_send_reversal'),
      journal_date: resolvedDate,
      correction_journal_ids: [reversal.ledger_journal_id],
      channel: 'outbound_pipeline'
    })]
  );
  return {
    reversal_journal_id: reversal.ledger_journal_id,
    original_journal_id: originalJournal.id,
    journal_date: resolvedDate,
    amount: reversal.amount,
    currency: originalJournal.currency
  };
};

// ---------------------------------------------------------------------------------
// FI-15 G-8 — the credit-note (hyvityslasku) AR-reversal writer. The exact mirror
// of postSalesInvoiceJournalWithClient (D-G8-5): a NEW SIBLING routed through the
// SAME __writeLedgerJournalRows backend (INV-1) — no existing posting machinery
// modified. Inherits tosite allocation, locked-period 409s, idempotent re-post on
// credit_note/<number>. KEEP-layer guards, each a typed refusal:
//   - FINLAND_INVOICING must act (same capability as the AR post it reverses)
//   - accrual-only: a cash-basis client refuses with
//     CREDIT_NOTE_CASH_BASIS_NO_POST (caught by the issue motion and recorded as
//     an honest skip — the D-FI10-S1 mirror)
//   - non-ALV only + balanced + positive credit total (buildCreditNoteJournal)
//   - audit-as-precondition: ledger.post_credit_note in the SAME txn
// Design: docs/design-donna-finland-fi15-g8-credit-notes.md.
// ---------------------------------------------------------------------------------
export const postCreditNoteJournalWithClient = async ({
  client,
  firmId = DEFAULT_FIRM_ID,
  clientId,
  creditNote = null,
  currency = 'EUR',
  memo = null,
  authorityBasis = null,
  model = null,
  actorId = 'system'
} = {}) => {
  if (!clientId) {
    const error = new Error('Client id is required to post a credit-note journal.');
    error.statusCode = 400;
    throw error;
  }
  if (!creditNote || typeof creditNote !== 'object') {
    const error = new Error('A built credit note (buildCreditNote result) is required to post a credit-note journal.');
    error.statusCode = 400;
    error.code = 'CREDIT_NOTE_MISSING_MODEL';
    throw error;
  }

  const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  requirePostingAdmission('fi').assertInvoiceEnabled({ snapshot, kind: 'Credit-note' });

  // Accrual-only (the D-G8-5 mirror of D-FI10-S1): a cash-basis book never
  // posted the AR, so there is nothing to reverse — the artifact still issues.
  const clientRow = await client.query(
    `select profile from clients where firm_id = $1 and id = $2 limit 1`,
    [firmId, clientId]
  );
  const basis = clientAccountingBasisFromProfile(clientRow.rows[0] || {});
  if (basis !== 'accrual') {
    const error = new Error('A cash-basis client posts no AR reversal for a credit note — settlement nets through the bank feed.');
    error.statusCode = 409;
    error.code = 'CREDIT_NOTE_CASH_BASIS_NO_POST';
    throw error;
  }

  const journal = buildCreditNoteJournal({ creditNote, currency: currency || creditNote.currency, memo });
  assertCorrectionLinesBalance(journal.lines);

  // Locked-period one-way-door — verbatim discipline from the sales-invoice writer.
  const existingJournal = await client.query(
    `select lj.id, lj.status, lj.journal_date, cp.id as close_period_id
     from ledger_journals lj
     left join close_periods cp
       on cp.firm_id = lj.firm_id
      and cp.client_id = lj.client_id
      and cp.status = 'locked'
      and lj.journal_date >= cp.period_start
      and lj.journal_date <= cp.period_end
     where lj.firm_id = $1
       and lj.client_id = $2
       and lj.source_type = $3
       and lj.source_id = $4
     limit 1`,
    [firmId, clientId, journal.source_type, journal.source_id]
  );
  if (existingJournal.rows[0]?.close_period_id) {
    const error = new Error('Credit-note journal is in a locked close period. Post a dated adjustment instead.');
    error.statusCode = 409;
    error.code = 'LEDGER_LOCKED_PERIOD_IMMUTABLE';
    throw error;
  }
  const lockedPeriod = await client.query(
    `select id
     from close_periods
     where firm_id = $1
       and client_id = $2
       and status = 'locked'
       and period_start <= $3
       and period_end >= $3
     limit 1`,
    [firmId, clientId, journal.journal_date]
  );
  if (lockedPeriod.rows.length) {
    const error = new Error('Close period is locked at the credit-note date. Post a dated adjustment instead.');
    error.statusCode = 409;
    error.code = 'LEDGER_LOCKED_PERIOD_IMMUTABLE';
    throw error;
  }

  const payload = {
    source: 'native_ledger_credit_note',
    direction: journal.direction,
    amount: journal.amount,
    credit_note_number: journal.source_id,
    credits_invoice_number: creditNote.creditsInvoiceNumber || null,
    buyer_name: creditNote.buyer?.name || null,
    authority_basis: authorityBasis || null,
    // The model id is part of the receipt (when a model drafted the credit note).
    model: model || null
  };
  const post = await __writeLedgerJournalRows({
    client, firmId, clientId, journal, payload,
    existingJournalId: existingJournal.rows[0]?.id || null,
    actorId
  });

  // Audit-as-precondition: the credit-note receipt records in the SAME txn.
  const auditResult = await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'system', $3, 'ledger.post_credit_note', 'ledger_journal', $4, $5::jsonb)
     returning id`,
    [firmId, clientId, actorId, post.ledger_journal_id, JSON.stringify({
      credit_note_number: journal.source_id,
      credits_invoice_number: creditNote.creditsInvoiceNumber || null,
      journal_date: journal.journal_date,
      currency: journal.currency,
      total: journal.amount,
      buyer_name: creditNote.buyer?.name || null,
      tosite_number: post.ledger_tosite_number ?? null,
      authority_basis: authorityBasis || null,
      model: model || null
    })]
  );

  return {
    journal_id: post.ledger_journal_id,
    credit_note_number: journal.source_id,
    tosite_number: post.ledger_tosite_number ?? null,
    audit_event_id: auditResult.rows[0]?.id != null ? String(auditResult.rows[0].id) : null,
    post
  };
};

// G-8 — standalone entry: opens its own transaction around the WithClient
// writer, mirroring postSalesInvoiceJournalFromDb's txn discipline.
export const postCreditNoteJournalFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  creditNote = null,
  currency = 'EUR',
  memo = null,
  authorityBasis = null,
  model = null,
  actorId = 'system'
} = {}) => {
  return withFirmDbClient(async (client) => {
    await requireClientInFirm({ client, firmId, clientId });
    await client.query('begin');
    try {
      const result = await postCreditNoteJournalWithClient({
        client, firmId, clientId, creditNote, currency, memo, authorityBasis, model, actorId
      });
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
};

// FI-9 (P) — the AP post: the NAMED WRITER for a received supplier bill's accrual
// (ostovelat) journal (INV-1: routes through the SAME __writeLedgerJournalRows
// every other post uses — never a second accounting backend). It inherits FI-5
// tosite allocation, the locked-period 409 guards, in-txn audit, and idempotent
// re-post on the natural key supplier_bill/<documentId>. Caller owns the
// transaction (mirrors postSalesInvoiceJournalWithClient). Design:
// docs/design-donna-finland-fi9-receive-and-ap-post.md §P.
//
// KEEP-layer guards — each refuses, none guesses:
//   - FINLAND_EINVOICE_RECEIVE must act for the client (config plane, envFallback
//     false — the same flag that gates the receive lane; the AP post is its
//     ledger half)
//   - ACCRUAL-ONLY (mirror of D-FI10-S1): a cash-basis client refuses — under
//     cash basis the expense books at settlement via the existing bank-line
//     flow, never at receipt of the bill
//   - the coding-verdict gate (D-FI9-2): the DR side is the coder's PERSISTED
//     verdict, passed in by the caller. A missing/placeholder account, a
//     confidence below 'high', or a red / balance-sheet-class account refuses —
//     the post fires on a confident persisted verdict, never a guess at receive
//     time, and balance-sheet judgment stays stubborn per the L1 doctrine
//   - the ALV fork (D-FI9-3, enforced in buildSupplierBillJournal): an
//     ALV-coding client refuses until FI-3's split-posting convention mints;
//     a non-ALV client posts GROSS
//   - the bill header is read from the PERSISTED document row (render the
//     persisted verdict): supplier_bill type, parse completed, not a duplicate
//   - the journal balances (builder + assertCorrectionLinesBalance re-assert)
//   - locked-period one-way-door checks verbatim from the sales-invoice writer
//   - audit-as-precondition: the ledger.post_supplier_bill receipt (authority
//     basis + coding verdict + model id + tosite) records in the SAME txn —
//     no record, no post
const SUPPLIER_BILL_CODING_PLACEHOLDER_ACCOUNTS = new Set(['', 'suspense', 'unknown', 'uncategorized', 'uncategorised']);

export const postSupplierBillJournalWithClient = async ({
  client,
  firmId = DEFAULT_FIRM_ID,
  clientId,
  documentId,
  coding = null,
  currency = null,
  memo = null,
  authorityBasis = null,
  model = null,
  actorId = 'system'
} = {}) => {
  if (!clientId) {
    const error = new Error('Client id is required to post a supplier-bill journal.');
    error.statusCode = 400;
    throw error;
  }
  if (!documentId) {
    const error = new Error('A bill document id is required to post a supplier-bill journal.');
    error.statusCode = 400;
    error.code = 'SUPPLIER_BILL_MISSING_DOCUMENT_ID';
    throw error;
  }

  const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  const postingContext = await resolvePostingContextWithClient({ client, firmId, clientId, lockContext: true });
  const admissionFlag = postingContext.policy.supplierBillAdmissionFlagKey;
  const supplierActs = admissionFlag && clientFlagActs({ flagKey: admissionFlag, snapshot, envFallback: () => false });
  if (!supplierActs) {
    const error = new Error('Supplier-bill posting requires FINLAND_EINVOICE_RECEIVE or GB VAT coding (JURISDICTION_TAX_CODING) for this client.');
    error.statusCode = 409;
    error.code = 'FINLAND_EINVOICE_RECEIVE_DISABLED';
    throw error;
  }

  // Accrual-only (mirror of D-FI10-S1). Basis is a CLIENT attribute: a
  // cash-basis (yhdenkertainen) book recognizes the expense at settlement via
  // the existing bank-line reconciliation path, never at receipt of the bill.
  const basis = clientAccountingBasisFromProfile(postingContext.row);
  if (basis !== 'accrual') {
    const error = new Error('A cash-basis client does not post AP at receipt — the expense books at settlement via reconciliation.');
    error.statusCode = 409;
    error.code = 'SUPPLIER_BILL_CASH_BASIS_NO_AP_POST';
    throw error;
  }

  // D-FI9-2 — the coding-verdict gate. The caller passes the PERSISTED coding
  // verdict (e.g. payload.ai_suggestion off the coder); this writer refuses
  // anything below the confident bar rather than posting a guessed DR side.
  const verdict = coding && typeof coding === 'object' ? coding : {};
  const proposedName = String(verdict.proposed_account || verdict.account_name || '').trim();
  const proposedCode = String(verdict.account_code || verdict.code || '').trim();
  if (SUPPLIER_BILL_CODING_PLACEHOLDER_ACCOUNTS.has(proposedName.toLowerCase()) && !proposedCode) {
    const error = new Error('Supplier-bill posting requires a persisted coding verdict naming the expense account.');
    error.statusCode = 409;
    error.code = 'SUPPLIER_BILL_CODING_VERDICT_REQUIRED';
    throw error;
  }
  if (String(verdict.confidence || '').trim().toLowerCase() !== 'high') {
    const error = new Error('Supplier-bill posting requires a high-confidence coding verdict — an unsure coding stays an owner ask, never an AP post.');
    error.statusCode = 409;
    error.code = 'SUPPLIER_BILL_CODING_NOT_CONFIDENT';
    throw error;
  }
  if (isRedAccount(verdict.account_type || verdict.xero_account_type, proposedName)) {
    const error = new Error('Supplier-bill posting refuses a red / balance-sheet-class expense account — that judgment stays with the firm.');
    error.statusCode = 409;
    error.code = 'SUPPLIER_BILL_CODING_RED_ACCOUNT';
    throw error;
  }

  // The bill header comes from the PERSISTED document row — the extraction
  // verdict the receive lane (or the vision extractor) wrote, never a
  // caller-supplied re-statement of it.
  const docResult = await client.query(
    `select id, document_type, parse_status, duplicate_of, vendor_name, total_amount,
            tax_amount, document_date, currency, reference_number
       from documents
      where firm_id = $1 and client_id = $2 and id = $3
      limit 1 for share`,
    [firmId, clientId, documentId]
  );
  const doc = docResult.rows[0];
  if (!doc) {
    const error = new Error('Bill document not found for this client.');
    error.statusCode = 404;
    error.code = 'SUPPLIER_BILL_DOCUMENT_NOT_FOUND';
    throw error;
  }
  if (doc.document_type !== 'supplier_bill') {
    const error = new Error('Only a supplier_bill document posts an AP journal.');
    error.statusCode = 409;
    error.code = 'SUPPLIER_BILL_WRONG_DOCUMENT_TYPE';
    throw error;
  }
  if (doc.parse_status !== 'completed') {
    const error = new Error('The bill must finish parsing before its AP journal posts.');
    error.statusCode = 409;
    error.code = 'SUPPLIER_BILL_PARSE_NOT_COMPLETED';
    throw error;
  }
  if (doc.duplicate_of) {
    const error = new Error('A duplicate bill does not post — the original carries the AP journal.');
    error.statusCode = 409;
    error.code = 'SUPPLIER_BILL_DUPLICATE_DOCUMENT';
    throw error;
  }

  // Re-resolve with the persisted bill's business date, holding the same client
  // lock. Country rules stay in the selected adapter; the named writer owns I/O.
  const datedContext = await resolvePostingContextWithClient({ client, firmId, clientId, businessDate: toIsoDay(doc.document_date), lockContext: true });
  if (verdict.coding_policy) {
    const judgmentContext = await resolvePostingContextWithClient({ client, firmId, clientId, businessDate: verdict.coding_policy.businessDate, lockContext: true });
    assertPostingSuggestionLineage(judgmentContext, { ai_suggestion: verdict });
  }
  const ledgerAccounts = datedContext.policy.supplierBillNeedsChart
    ? await getDonnaLedgerAccountsForClient({ client, firmId, clientId }) : [];
  const { alvSplit, payablesAccount, expenseTaxType } = executePostingPolicyOperation(datedContext.policy, 'supplierBillTaxPosting', {
    verdict, document: doc, ledgerAccounts, taxCodingEnabled: datedContext.taxCodingEnabled, profile: datedContext.profile
  });

  const journal = buildSupplierBillJournal({
    bill: {
      documentId: doc.id,
      vendorName: doc.vendor_name,
      date: doc.document_date,
      total: doc.total_amount,
      currency: doc.currency,
      referenceNumber: doc.reference_number
    },
    expenseAccount: {
      code: proposedCode,
      name: proposedName,
      type: verdict.account_type || verdict.xero_account_type || 'expense',
      tax_type: expenseTaxType
    },
    payablesAccount,
    currency: currency || doc.currency,
    memo,
    alvSplit
  });
  // Belt-and-braces: the builder already refuses an unbalanced journal; re-assert
  // on the write path (the Keep layer refuses, never shades).
  assertCorrectionLinesBalance(journal.lines);

  // Locked-period one-way-door (verbatim discipline from the sales-invoice
  // writer): neither an existing supplier_bill journal inside a locked period
  // nor a journal_date inside one may be (re)posted.
  const existingJournal = await client.query(
    `select lj.id, lj.status, lj.journal_date, cp.id as close_period_id
     from ledger_journals lj
     left join close_periods cp
       on cp.firm_id = lj.firm_id
      and cp.client_id = lj.client_id
      and cp.status = 'locked'
      and lj.journal_date >= cp.period_start
      and lj.journal_date <= cp.period_end
     where lj.firm_id = $1
       and lj.client_id = $2
       and lj.source_type = $3
       and lj.source_id = $4
     limit 1`,
    [firmId, clientId, journal.source_type, journal.source_id]
  );
  if (existingJournal.rows[0]?.close_period_id) {
    const error = new Error('Supplier-bill journal is in a locked close period. Post a dated adjustment instead.');
    error.statusCode = 409;
    error.code = 'LEDGER_LOCKED_PERIOD_IMMUTABLE';
    throw error;
  }
  const lockedPeriod = await client.query(
    `select id
     from close_periods
     where firm_id = $1
       and client_id = $2
       and status = 'locked'
       and period_start <= $3
       and period_end >= $3
     limit 1`,
    [firmId, clientId, journal.journal_date]
  );
  if (lockedPeriod.rows.length) {
    const error = new Error('Close period is locked at the bill date. Post a dated adjustment instead.');
    error.statusCode = 409;
    error.code = 'LEDGER_LOCKED_PERIOD_IMMUTABLE';
    throw error;
  }

  const codingReceipt = {
    account_code: proposedCode || null,
    proposed_account: proposedName || null,
    confidence: String(verdict.confidence || '').trim().toLowerCase(),
    // The model id is part of the receipt — read from the persisted verdict.
    model: verdict.model || null
  };
  const payload = {
    source: 'native_ledger_supplier_bill',
    posting_policy: datedContext.receipt,
    direction: journal.direction,
    amount: journal.amount,
    document_id: doc.id,
    vendor_name: doc.vendor_name || null,
    reference_number: doc.reference_number || null,
    coding: codingReceipt,
    authority_basis: authorityBasis || null,
    model: model || verdict.model || null
  };
  const post = await __writeLedgerJournalRows({
    client, firmId, clientId, journal, payload,
    existingJournalId: existingJournal.rows[0]?.id || null,
    actorId
  });

  // Audit-as-precondition: the supplier-bill receipt records in the SAME txn —
  // no record, no post. (__writeLedgerJournalRows also emits ledger.journal_posted
  // via the tosite allocator; this is the bill-specific receipt.)
  const auditResult = await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'system', $3, 'ledger.post_supplier_bill', 'ledger_journal', $4, $5::jsonb)
     returning id`,
    [firmId, clientId, actorId, post.ledger_journal_id, JSON.stringify({
      document_id: doc.id,
      journal_date: journal.journal_date,
      currency: journal.currency,
      total: journal.amount,
      vendor_name: doc.vendor_name || null,
      coding: codingReceipt,
      tosite_number: post.ledger_tosite_number ?? null,
      authority_basis: authorityBasis || null,
      model: model || verdict.model || null
    })]
  );

  // The settlement swap must DR the SAME account this journal credited (KEEP
  // invariant 2 — no drift): return the credited payables shaped for
  // ledgerAccountFromCoding + the column patch, so the commit-time swap
  // follows the journal instead of re-deriving a constant that may not be the
  // account a GB post actually used.
  const creditedPayables = payablesAccount;
  return {
    journal_id: post.ledger_journal_id,
    document_id: doc.id,
    tosite_number: post.ledger_tosite_number ?? null,
    audit_event_id: auditResult.rows[0]?.id != null ? String(auditResult.rows[0].id) : null,
    payables_coding: {
      account_code: creditedPayables.code,
      account_name: creditedPayables.name,
      account_type: creditedPayables.type || creditedPayables.account_type || 'liability',
      account_label: `${creditedPayables.code} · ${creditedPayables.name}`
    },
    post
  };
};

// FI-9 (P) — standalone entry: opens its own transaction around the WithClient
// writer, mirroring postSalesInvoiceJournalFromDb's txn discipline.
export const postSupplierBillJournalFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  documentId,
  coding = null,
  currency = null,
  memo = null,
  authorityBasis = null,
  model = null,
  actorId = 'system'
} = {}) => {
  return withFirmDbClient(async (client) => {
    await requireClientInFirm({ client, firmId, clientId });
    await client.query('begin');
    try {
      const result = await postSupplierBillJournalWithClient({
        client, firmId, clientId, documentId, coding, currency, memo, authorityBasis, model, actorId
      });
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
};

const normalizeCorrectionLine = (line = {}, fallbackCurrency = '', retainedCurrency = null) => {
  const debit = Number(line.debit || 0);
  const credit = Number(line.credit || 0);
  const amount = Math.round(Number(line.amount || debit || credit || 0) * 100) / 100;
  const direction = debit > 0 ? 'debit' : credit > 0 ? 'credit' : String(line.direction || '').toLowerCase();
  return {
    account: {
      code: String(line.account_code || line.code || '').trim(),
      name: String(line.account_name || line.name || line.account_label || line.account_code || '').trim(),
      type: String(line.account_type || line.type || 'unknown').trim().toLowerCase() || 'unknown',
      normal_balance: String(line.normal_balance || (direction === 'credit' ? 'credit' : 'debit')).trim().toLowerCase() === 'credit' ? 'credit' : 'debit',
      tax_type: String(line.tax_type || '').trim(),
      xero_account_id: String(line.xero_account_id || '').trim(),
      // The LINE role (e.g. the ALV split legs' alv_output/alv_input_deductible)
      // rides through to ledger_lines.payload — same convention as the main
      // journal writer, so the cross-check reads corrections like any post.
      role: String(line.role || '').trim() || null,
      label: line.account_label || (line.account_code && line.account_name ? `${line.account_code} · ${line.account_name}` : line.account_name || line.account_code || '')
    },
    direction,
    debit: Math.round(debit * 100) / 100,
    credit: Math.round(credit * 100) / 100,
    amount,
    currency: requireLedgerCurrency(Object.hasOwn(line, 'currency') ? line.currency : fallbackCurrency, 'adjustment line', {
      retained: retainedCurrency != null && String(Object.hasOwn(line, 'currency') ? line.currency : fallbackCurrency).trim().toUpperCase() === retainedCurrency
    }),
    memo: line.memo || null
  };
};

const reverseLedgerLine = (line = {}) => normalizeCorrectionLine({
  account_code: line.account_code,
  account_name: line.account_name,
  account_type: line.account_type || line.payload?.account_type || 'unknown',
  normal_balance: line.normal_balance || line.payload?.normal_balance || 'debit',
  tax_type: line.tax_type,
  // FI-3 slice S: the split's control leg is ROLE-marked (payload.role, spread
  // onto the line by rowToLedgerLinePayload). The reversal must carry the same
  // role so the return engine's cross-check NETS the reversed leg against the
  // original — a role-less reversal leaves the period's control sums
  // permanently mismatched (control_account_mismatch on a correct book).
  role: line.role || line.payload?.role || null,
  debit: Number(line.credit || 0),
  credit: Number(line.debit || 0),
  amount: line.amount,
  currency: line.currency,
  memo: `Reverse: ${line.memo || line.account_name || line.account_code || ''}`.trim()
}, line.currency, String(line.currency || '').trim().toUpperCase());

// Exported (additive — P5 inventory posting, isolation-list touch approved by Kari
// 2026-07-12) so the ONE balance guard is reused by ledgerPostingGateway.js, never
// re-implemented (INV-1: one backend, one gate). Behaviour is unchanged.
export const assertCorrectionLinesBalance = (lines = []) => {
  const totalDebit = Math.round(lines.reduce((sum, line) => sum + Number(line.debit || 0), 0) * 100) / 100;
  const totalCredit = Math.round(lines.reduce((sum, line) => sum + Number(line.credit || 0), 0) * 100) / 100;
  if (!lines.length || Math.abs(totalDebit - totalCredit) >= 0.01 || totalDebit <= 0) {
    const error = new Error('Ledger correction lines must be balanced and greater than zero.');
    error.statusCode = 400;
    error.code = 'LEDGER_CORRECTION_UNBALANCED';
    error.details = { total_debit: totalDebit, total_credit: totalCredit };
    throw error;
  }
  return { totalDebit, totalCredit };
};

// Exported (additive — P5 inventory posting, isolation-list touch approved by Kari
// 2026-07-12) so the gateway reuses the ONE period-lock date guard. Behaviour unchanged.
export const assertJournalDateNotLocked = async ({ client, firmId, clientId, journalDate }) => {
  const locked = await client.query(
    `select id, period_start, period_end
     from close_periods
     where firm_id = $1
       and client_id = $2
       and status = 'locked'
       and period_start <= $3
       and period_end >= $3
     limit 1`,
    [firmId, clientId, journalDate]
  );
  if (locked.rows.length) {
    const error = new Error('Adjustment journal date falls inside a locked period. Use a later open period date.');
    error.statusCode = 409;
    error.code = 'LEDGER_ADJUSTMENT_DATE_LOCKED';
    throw error;
  }
};

const insertLedgerCorrectionJournal = async ({
  client,
  firmId,
  clientId,
  sourceId,
  journalDate,
  currency,
  memo,
  lines = [],
  correctionType,
  correctionOfJournalId = null,
  reversalOfJournalId = null,
  correctionReason = null,
  actorId = 'system'
} = {}) => {
  await assertRetainedLedgerScope({ client, firmId, clientId, actorId, resourceId: `adjustment:${sourceId}` });
  const { totalDebit } = assertCorrectionLinesBalance(lines);
  const journalId = ledgerRecordId('journal', firmId, clientId, 'adjustment', sourceId);
  {
    const named = lines.map((line) => line.account || {});
    const resolved = await resolvePaletteAliasAccountsWithClient({ client, firmId, clientId, accounts: named });
    if (resolved !== named) lines = lines.map((line, index) => (resolved[index] === named[index] ? line : { ...line, account: resolved[index] }));
  }
  const accountIds = new Map();
  for (const line of lines) {
    const account = line.account || {};
    const key = `${account.code || ''}|${account.name || ''}|${account.xero_account_id || ''}`;
    accountIds.set(
      key,
      await upsertLedgerAccountForJournal({ client, firmId, clientId, account, currency: line.currency || currency })
    );
  }
  await client.query(
    `insert into ledger_journals (
       id, firm_id, client_id, source_type, source_id, journal_date, currency, status, memo, posted_at,
       correction_type, correction_of_journal_id, reversal_of_journal_id, correction_reason, payload
     )
     values ($1, $2, $3, 'adjustment', $4, $5, $6, 'posted', $7, now(), $8, $9, $10, $11, $12::jsonb)`,
    [
      journalId,
      firmId,
      clientId,
      sourceId,
      journalDate,
      currency,
      memo,
      correctionType,
      correctionOfJournalId,
      reversalOfJournalId,
      correctionReason,
      JSON.stringify({
        source: 'native_ledger_correction',
        correction_type: correctionType,
        correction_of_journal_id: correctionOfJournalId,
        reversal_of_journal_id: reversalOfJournalId,
        correction_reason: correctionReason,
        actor_id: actorId,
        amount: totalDebit
      })
    ]
  );
  for (const [index, line] of lines.entries()) {
    const account = line.account || {};
    const key = `${account.code || ''}|${account.name || ''}|${account.xero_account_id || ''}`;
    await client.query(
      `insert into ledger_lines (
         id, journal_id, firm_id, client_id, account_id, account_code, account_name, line_no,
         direction, debit, credit, amount, currency, tax_type, memo, payload
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)`,
      [
        ledgerRecordId('line', journalId, index + 1),
        journalId,
        firmId,
        clientId,
        accountIds.get(key),
        account.code || null,
        account.name || null,
        index + 1,
        line.direction,
        line.debit,
        line.credit,
        line.amount,
        line.currency || currency,
        account.tax_type || line.tax_type || null,
        line.memo || memo || null,
        JSON.stringify({
          account_label: account.label || null,
          role: account.role || null,
          correction_type: correctionType,
          correction_of_journal_id: correctionOfJournalId,
          reversal_of_journal_id: reversalOfJournalId
        })
      ]
    );
  }
  return {
    ledger_journal_id: journalId,
    correction_type: correctionType,
    correction_of_journal_id: correctionOfJournalId,
    reversal_of_journal_id: reversalOfJournalId,
    journal_date: journalDate,
    amount: totalDebit,
    currency,
    line_count: lines.length
  };
};

// H-1 test seam (the finlandAlvReturnFilingDb.test.js `__` idiom): the
// correction internals stay internal to the adjustment path; these aliases let
// the role-preservation regression drive them against a fake pg client — the
// property under test is that a split journal's role-marked control leg
// reverses WITH its role, so the ALV cross-check nets instead of wedging.
export {
  reverseLedgerLine as __reverseLedgerLine,
  insertLedgerCorrectionJournal as __insertLedgerCorrectionJournal
};

// The actors Donna's own callers post adjustments as: the late-bank-line
// reversal and the other system producers ('system'), and the autonomous
// coding correction ('coding_correction'). Neither acknowledges a filed VAT
// return or closes a case on a person's behalf.
const AUTOMATIC_ADJUSTMENT_ACTORS = new Set(['', 'system', 'coding_correction']);

export const postLedgerAdjustmentInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  originalJournalId,
  transactionId,
  journalDate,
  reason,
  lines = [],
  reverseOriginal = true,
  actorId = 'system',
  codingCorrection = null,
  filedReturnAcknowledgement = null
} = {}) => {
  if (!clientId) {
    const error = new Error('Client id is required for a ledger adjustment.');
    error.statusCode = 400;
    throw error;
  }
  const cleanReason = String(reason || '').trim();
  if (!cleanReason) {
    const error = new Error('A correction reason is required.');
    error.statusCode = 400;
    error.code = 'LEDGER_CORRECTION_REASON_REQUIRED';
    throw error;
  }
  const postedAt = new Date().toISOString();
  return withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      await requireClientInFirm({ client, firmId, clientId });
      await assertRetainedLedgerScope({ client, firmId, clientId, actorId, resourceId: `adjustment:${transactionId || originalJournalId || 'manual'}` });
      let recovery = null;
      if (codingCorrection) {
        const { prepareCodingCorrectionWithClient } = await import('./codingCorrection.js');
        recovery = await prepareCodingCorrectionWithClient({ client, firmId, clientId, transactionId,
          expectedDecisionDigest: codingCorrection.decision_digest });
        if (recovery.completed) {
          await client.query('commit');
          return { coding_correction: recovery.receipt };
        }
        originalJournalId = recovery.originalJournalId;
        actorId = recovery.actorId;
        lines = recovery.lines;
        reverseOriginal = false;
      }
      let originalJournal = null;
      let originalLines = [];
      if (originalJournalId || transactionId) {
        const originalResult = await client.query(
          `select *
           from ledger_journals
           where firm_id = $1
             and client_id = $2
             and ($3::text = '' or id = $3)
             and ($4::text = '' or source_id = $4)
           order by journal_date desc, created_at desc
           limit 1`,
          [firmId, clientId, String(originalJournalId || ''), String(transactionId || '')]
        );
        originalJournal = originalResult.rows[0] || null;
        if (!originalJournal) {
          const error = new Error('Original ledger journal was not found for correction.');
          error.statusCode = 404;
          error.code = 'LEDGER_ORIGINAL_JOURNAL_NOT_FOUND';
          throw error;
        }
        if (!['posted', 'closed'].includes(originalJournal.status)) {
          const error = new Error('Only posted or closed ledger journals can be corrected.');
          error.statusCode = 409;
          error.code = 'LEDGER_ORIGINAL_JOURNAL_NOT_POSTED';
          throw error;
        }
        const originalLinesResult = await client.query(
          `select ll.*, la.account_type, la.normal_balance
           from ledger_lines ll
           join ledger_accounts la on la.id = ll.account_id
           where ll.firm_id = $1
             and ll.client_id = $2
             and ll.journal_id = $3
           order by ll.line_no`,
          [firmId, clientId, originalJournal.id]
        );
        originalLines = originalLinesResult.rows.map(rowToLedgerLinePayload);
      }
      const resolvedDate = ledgerDateOnly(journalDate || new Date());
      if (!resolvedDate) {
        const error = new Error('A valid adjustment journal_date is required.');
        error.statusCode = 400;
        error.code = 'LEDGER_INVALID_ADJUSTMENT_DATE';
        throw error;
      }
      await assertJournalDateNotLocked({ client, firmId, clientId, journalDate: resolvedDate });
      // A manual entry needs explicit denomination. Corrections may inherit
      // the original journal, but its reversal always retains its own currency,
      // even when the replacement explicitly corrects that denomination.
      const originalCurrency = originalJournal ? requireLedgerCurrency(originalJournal.currency, 'original journal', { retained: true }) : null;
      const selectedCurrency = lines.find(line => Object.hasOwn(line, 'currency'))?.currency ?? originalCurrency;
      const currency = lines.length
        ? requireLedgerCurrency(selectedCurrency, 'adjustment', { retained: originalCurrency != null && String(selectedCurrency).trim().toUpperCase() === originalCurrency })
        : originalCurrency;
      const normalizedLines = lines.map((line) => normalizeCorrectionLine(line, currency, originalCurrency));
      for (const line of normalizedLines) assertLedgerCurrencyMatches(line.currency, currency, 'adjustment line', { retained: currency === originalCurrency });
      const reversalLines = originalJournal && reverseOriginal !== false ? originalLines.map(reverseLedgerLine) : [];
      // What a filed VAT return protects is the figures it read, not the
      // period's books: filing does not lock the close period, and entries
      // the return does not read (a year-end accrual or depreciation with no
      // tax code) are dated into it as on any open date. The period state of
      // the adjustment's own date and of the journal it corrects comes from
      // the one reader the correction consumer uses
      // (taxRegistrationPeriodState: a locked close period; a VAT return the
      // country records as filed, null where the country keeps no record).
      // What this adjustment moves in what a return reads is the reversal
      // plus the replacement (or the manual lines), netted by the country's
      // own read of a line (taxRegistration.returnLineKey, the return
      // builder's; else the tax code). Both rules below use that one
      // movement.
      const periodCompany = (await client.query('select jurisdiction, profile from clients where firm_id = $1 and id = $2', [firmId, clientId])).rows[0];
      const periodRule = taxRegistrationRuleFor(periodCompany?.jurisdiction || periodCompany?.profile?.jurisdiction);
      const taxMoved = correctionReturnMovement([...reversalLines, ...normalizedLines], periodRule?.returnLineKey || undefined);
      const datePeriod = await taxRegistrationPeriodState({ client, firmId, clientId, rule: periodRule, onDate: resolvedDate });
      // Dated inside a filed return and changing what it reads: refused, with
      // no acknowledgement path. The correction is dated in an open period
      // (and, for a journal in the filed return, acknowledged below).
      if (datePeriod.return_filed && taxMoved.length) {
        const error = new Error(`Adjustment journal date ${resolvedDate} falls inside the filed VAT return ${datePeriod.filed_return_period || datePeriod.filed_return_id}, and this adjustment changes what that return reads: `
          + `${taxMoved.map((row) => `${row.key} ${row.amount.toFixed(2)} ${row.currency}`.trim()).join(', ')}. `
          + 'Date it in an open period instead; a correction of a journal in the filed return is then posted with a person\'s acknowledgement.');
        error.statusCode = 409;
        error.code = 'LEDGER_ADJUSTMENT_DATE_IN_FILED_RETURN';
        error.details = { journal_date: resolvedDate, filed_return_id: datePeriod.filed_return_id,
          filed_return_period: datePeriod.filed_return_period, tax_moved: taxMoved };
        throw error;
      }
      const datedInFiledReturn = datePeriod.return_filed
        ? { filed_return_id: datePeriod.filed_return_id, filed_return_period: datePeriod.filed_return_period } : null;
      // The corrected journal's own period. An adjustment dated in an open
      // period moves its difference into the open period's return. When the
      // corrected journal sits in a filed VAT return and what that return
      // reads moves, whether it may be corrected in a later return is a
      // person's decision: the writer refuses and says what would move, and
      // posts only with an authenticated person's acknowledgement of exactly
      // that movement. Donna's own callers never carry one.
      let correctsPeriod = null;
      if (originalJournal) {
        const originalDate = ledgerDateOnly(originalJournal.journal_date);
        const period = await taxRegistrationPeriodState({ client, firmId, clientId, rule: periodRule, onDate: originalDate });
        correctsPeriod = { journal_date: originalDate, close_period_locked: period.locked, close_period_id: period.close_period_id,
          return_filed: period.return_filed, filed_return_id: period.filed_return_id, filed_return_period: period.filed_return_period,
          tax_moved: taxMoved };
        if (period.return_filed && taxMoved.length) {
          const acknowledgementDigest = hash({ original_journal_id: originalJournal.id, journal_date: originalDate,
            filed_return_id: period.filed_return_id, tax_moved: taxMoved });
          const offered = codingCorrection ? null : filedReturnAcknowledgement;
          const acknowledged = Boolean(offered) && offered.digest === acknowledgementDigest
            && offered.principal_type === 'firm_member' && Boolean(offered.acknowledged_by)
            && offered.acknowledged_by === actorId && !AUTOMATIC_ADJUSTMENT_ACTORS.has(actorId);
          if (!acknowledged) {
            const error = new Error(`The corrected journal (${originalDate}) is in the filed VAT return ${period.filed_return_period || period.filed_return_id}, and this adjustment changes what that return reads: `
              + `${taxMoved.map((row) => `${row.key} ${row.amount.toFixed(2)} ${row.currency}`.trim()).join(', ')}. `
              + `Dated ${resolvedDate}, the difference lands in that period's return. A person must acknowledge this before it posts.`);
            error.statusCode = 409;
            error.code = 'LEDGER_ADJUSTMENT_RESTATES_FILED_RETURN';
            error.details = { reason: offered ? 'acknowledgement_does_not_match' : 'acknowledgement_required',
              original_journal_id: originalJournal.id, original_journal_date: originalDate, journal_date: resolvedDate,
              filed_return_id: period.filed_return_id, filed_return_period: period.filed_return_period,
              close_period_locked: period.locked, close_period_id: period.close_period_id,
              tax_moved: taxMoved, acknowledgement_digest: acknowledgementDigest };
            throw error;
          }
          correctsPeriod.filed_return_acknowledgement = { acknowledged_by: offered.acknowledged_by,
            principal_type: offered.principal_type, digest: acknowledgementDigest, acknowledged_at: postedAt };
        }
      }
      const correctionKey = ledgerRecordId('correction', firmId, clientId, originalJournal?.id || transactionId || 'manual', postedAt);
      const journals = [];
      if (originalJournal && reverseOriginal !== false) {
        for (const line of reversalLines) assertLedgerCurrencyMatches(line.currency, originalCurrency, 'original journal line', { retained: true });
        journals.push(await insertLedgerCorrectionJournal({
          client,
          firmId,
          clientId,
          sourceId: `${correctionKey}-reversal`,
          journalDate: resolvedDate,
          currency: originalCurrency,
          memo: `Correction reversal: ${originalJournal.memo || originalJournal.id}`,
          lines: reversalLines,
          correctionType: 'reversal',
          correctionOfJournalId: originalJournal.id,
          reversalOfJournalId: originalJournal.id,
          correctionReason: cleanReason,
          actorId
        }));
      }
      if (lines.length) {
        journals.push(await insertLedgerCorrectionJournal({
          client,
          firmId,
          clientId,
          sourceId: `${correctionKey}-adjustment`,
          journalDate: resolvedDate,
          currency,
          memo: `Correction adjustment: ${cleanReason}`,
          lines: normalizedLines,
          correctionType: originalJournal ? 'replacement' : 'adjustment',
          correctionOfJournalId: originalJournal?.id || null,
          reversalOfJournalId: null,
          correctionReason: cleanReason,
          actorId
        }));
      }
      if (!journals.length && !recovery) {
        const error = new Error('Correction must create a reversal or adjustment journal.');
        error.statusCode = 400;
        error.code = 'LEDGER_CORRECTION_EMPTY';
        throw error;
      }
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', $3, 'ledger.adjustment_posted', 'ledger_journal', $4, $5::jsonb)`,
        [
          firmId,
          clientId,
          actorId,
          journals[0]?.ledger_journal_id || originalJournal.id,
          JSON.stringify({
            original_journal_id: originalJournal?.id || null,
            transaction_id: transactionId || originalJournal?.source_id || null,
            reason: cleanReason,
            journal_date: resolvedDate,
            correction_journal_ids: journals.map((journal) => journal.ledger_journal_id),
            ...(correctsPeriod ? { corrects_period: correctsPeriod } : {}),
            ...(datedInFiledReturn ? { dated_in_filed_return: datedInFiledReturn } : {}),
            ...(recovery ? { authority_basis: recovery.authority, model: recovery.suggestion.model,
              decision_digest: codingCorrection.decision_digest, verified_no_change: !lines.length } : {})
          })
        ]
      );
      if (recovery) {
        const { finishCodingCorrectionWithClient } = await import('./codingCorrection.js');
        await finishCodingCorrectionWithClient({ client, firmId, clientId, transactionId, recovery,
          journalIds: journals.map(journal => journal.ledger_journal_id) });
      } else if (originalJournal) {
        const {completeCodingEvidenceCorrectionWithClient} = await import('./codingEvidence.js');
        const closedByChat = await completeCodingEvidenceCorrectionWithClient({client,firmId,clientId,
          transactionId:transactionId || originalJournal.source_id,originalJournalId:originalJournal.id,
          correctionJournalIds:journals.map(journal=>journal.ledger_journal_id),actorId});
        // A person's full reversal and replacement of the journal a
        // registration case is about is the decision that case waits on.
        if (!closedByChat && reverseOriginal !== false && !AUTOMATIC_ADJUSTMENT_ACTORS.has(actorId)) {
          const { closeRegistrationCaseByPersonAdjustmentWithClient } = await import('./codingCorrection.js');
          await closeRegistrationCaseByPersonAdjustmentWithClient({ client, firmId, clientId,
            transactionId: transactionId || originalJournal.source_id, originalJournalId: originalJournal.id,
            correctionJournalIds: journals.map((journal) => journal.ledger_journal_id), actorId, reason: cleanReason });
        }
      }
      await client.query('commit');
      // INT-6 — auto-suspend-on-export-correction (producer side; plan §2
      // INT-6a: "auto-suspended on any export correction/reversal"). If the
      // corrected journal's entry had already been EXPORTED to the client's
      // accounting system (a synced QBO mirror row, or the source
      // transaction's Xero synced flags), a human just said that export was
      // wrong — suspend every ledger-sync authority grant for this client so
      // the auto-export drain fails closed before its next run. Post-commit +
      // no-throw (the 040 producer posture): a suspend failure must never
      // unwind a correction that already committed. The enforcement side is
      // ledgerSyncGrantIsLive (correction_count > 0 fails closed).
      if (originalJournal) {
        try {
          let exported = false;
          try {
            const mirror = await client.query(
              `select 1 from qbo_journal_mirrors where journal_id = $1 and status = 'synced' limit 1`,
              [originalJournal.id]
            );
            exported = mirror.rows.length > 0;
          } catch (mirrorErr) {
            // Pre-026 deploy: no mirror table → fall through to the Xero check.
            if (mirrorErr?.code !== '42P01' && mirrorErr?.code !== '42703') throw mirrorErr;
          }
          if (!exported && originalJournal.source_type === 'transaction') {
            const txResult = await client.query(
              `select * from transactions where firm_id = $1 and client_id = $2 and id = $3 limit 1`,
              [firmId, clientId, originalJournal.source_id]
            );
            const transaction = txResult.rows[0] ? rowToTransactionPayload(txResult.rows[0]) : null;
            exported = Boolean(transaction && isTransactionSyncedToXero(transaction));
          }
          if (exported) {
            await suspendLedgerSyncGrantsAfterExportCorrection({
              client,
              firmId,
              clientId,
              journalId: originalJournal.id,
              reason: 'export_correction'
            });
          }
        } catch (suspendErr) {
          console.warn(
            '[postLedgerAdjustmentInDb] ledger-sync grant auto-suspend failed (non-fatal)',
            { firmId, clientId, journalId: originalJournal.id, error: suspendErr?.message || suspendErr }
          );
        }
      }
      return {
        ledger_adjustment: {
          source: 'ledger_adjustment',
          client_id: clientId,
          original_journal_id: originalJournal?.id || null,
          transaction_id: transactionId || originalJournal?.source_id || null,
          journal_date: resolvedDate,
          reason: cleanReason,
          posted_at: postedAt,
          journals
        }
      };
    } catch (error) {
      await client.query('rollback');
      if (transactionId && error?.code === 'PROCESSING_SCOPE_ACCOUNTING_UNAVAILABLE') {
        await receiptPostingFailure({ client, firmId, clientId, transactionIds: [transactionId], error });
      }
      throw error;
    }
  });
};

// Resolve a posted ledger journal (by its id, or by the transaction that
// sourced it) plus its lines. source_type='transaction'/source_id keys the
// per-transaction operator action; adjustments are reachable by journal id.
export const loadLedgerJournalForMirror = async ({ client, firmId, clientId, journalId, transactionId }) => {
  const journalResult = transactionId
    ? await client.query(
        `select * from ledger_journals
         where firm_id = $1 and client_id = $2 and status = 'posted'
           and source_type = 'transaction' and source_id = $3
         order by created_at desc limit 1`,
        [firmId, clientId, transactionId]
      )
    : await client.query(
        "select * from ledger_journals where firm_id = $1 and client_id = $2 and id = $3 and status = 'posted'",
        [firmId, clientId, journalId]
      );
  const journal = journalResult.rows[0];
  if (!journal) {
    const error = new Error('No posted ledger journal found for QuickBooks writeback.');
    error.statusCode = 404;
    throw error;
  }
  const linesResult = await client.query(
    'select * from ledger_lines where journal_id = $1 order by line_no asc',
    [journal.id]
  );
  return { journal, lines: linesResult.rows };
};


export const openingBalanceWhatsAppFlagActsInDb = async ({ firmId = DEFAULT_FIRM_ID, clientId } = {}) => {
  if (!clientId) return false;
  return withFirmDbClient(async (client) => {
    const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
    const { policy } = await readPostingAdmissionWithClient({ client, firmId, clientId });
    return Boolean(policy?.openingBalanceActs?.({ snapshot }));
  });
};

export const gbOpeningBalanceFlagActsInDb = async ({ firmId = DEFAULT_FIRM_ID, clientId } = {}) => {
  if (!clientId) return false;
  return withFirmDbClient(async (client) => {
    const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
    return clientFlagActs({ flagKey: GB_OPENING_BALANCES_FLAG_KEY, snapshot, envFallback: () => false });
  });
};

export const createGbOpeningBalanceEvidenceRequestInDb = async ({ firmId = DEFAULT_FIRM_ID, clientId, question, requestPayload = {}, actorId = 'system' } = {}) => withFirmDbClient(async (client) => {
  const id = `gb-opening-balance-${randomUUID()}`;
  const result = await client.query(
    `insert into client_evidence_requests (id, firm_id, client_id, status, evidence_type, question, request_payload, created_by)
     values ($1, $2, $3, 'open', 'gb_opening_balance', $4, $5::jsonb, $6)
     on conflict (id) do update set status = 'open', question = excluded.question,
       request_payload = excluded.request_payload, response_payload = '{}'::jsonb,
       resolved_at = null, resolved_by = null, updated_at = now()
     returning *`,
    [id, firmId, clientId, question, JSON.stringify(requestPayload), actorId]
  );
  return result.rows[0];
});

export const createOpeningBalanceEvidenceRequestInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  question,
  requestPayload = {},
  actorId = 'system'
} = {}) => {
  const cleanClientId = String(clientId || '').trim();
  const cleanQuestion = String(question || '').trim();
  if (!cleanClientId || !cleanQuestion) {
    const error = new Error('Client id and question are required for an opening-balance ask.');
    error.statusCode = 400;
    throw error;
  }
  const requestId = `opening-balance-${firmId}-${cleanClientId}-${shortHash(`${Date.now()}:${cleanQuestion}`)}`;
  return withFirmDbClient(async (client) => {
    const result = await client.query(
      `insert into client_evidence_requests (
         id, firm_id, client_id, status, evidence_type, question, request_payload,
         first_sent_at, last_sent_at, send_count, created_by
       )
       values ($1, $2, $3, 'open', 'opening_balance', $4, $5::jsonb, now(), now(), 1, $6)
       returning *`,
      [
        requestId,
        firmId,
        cleanClientId,
        cleanQuestion,
        JSON.stringify({ kind: 'opening_balance', ...(requestPayload || {}) }),
        actorId
      ]
    );
    return rowToClientEvidenceRequestPayload(result.rows[0]);
  });
};
