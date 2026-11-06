import { clusterContactLabel, normalizeIntelText } from './transactionIntel.js';
import { enrichCodingWithXeroAccount } from './xeroAccountMatcher.js';
import { buildXeroCoaProvisionPlan } from './xeroCoaProvisioning.js';
import { toIsoDay, toLocalIsoDay } from './dates.js';

// Discriminator for the structured missing-account PROPOSE returned (instead of
// thrown) when `proposeProvisionOnUnmatched` is set — see below.
export const XERO_WRITEBACK_ACCOUNT_UNMATCHED = 'account_unmatched';

const trim = (value = '') => String(value || '').trim();

const numberValue = (value) => {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric : 0;
};

const roundedAmount = (value) => Math.round(numberValue(value) * 100) / 100;

const dateOnly = (value) => {
  if (!value) return '';
  if (value instanceof Date) return toIsoDay(value); // a pg `date`: local midnight
  const text = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  // Free text parses to host-local midnight, so the host-local day is the
  // day the text named (audit F-11).
  return toLocalIsoDay(new Date(text));
};

const validationError = (message, code = 'XERO_WRITEBACK_INVALID_PAYLOAD') => {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = code;
  return error;
};

const accountLabel = (account = {}) => {
  const code = trim(account.code || account.Code);
  const name = trim(account.name || account.Name);
  return code && name ? `${code} · ${name}` : name || code;
};

const accountId = (account = {}) =>
  trim(
    account.xero_account_id ||
      account.xeroAccountId ||
      account.account_id ||
      account.accountId ||
      account.AccountID ||
      account.payload?.AccountID
  );

const bankAccountSummary = (bankAccount = {}) => ({
  id: bankAccount.id || null,
  xero_account_id: accountId(bankAccount) || null,
  code: accountCode(bankAccount) || null,
  name: accountName(bankAccount) || null,
  account_label: accountLabel(bankAccount)
});

const accountCode = (account = {}) => trim(account.code || account.Code || account.account_code || account.xero_account_code);
const accountName = (account = {}) => trim(account.name || account.Name || account.account_name || account.xero_account_name);
const accountCurrency = (account = {}) =>
  trim(account.currency || account.CurrencyCode || account.account_currency || account.payload?.CurrencyCode || account.payload?.Currency);

const isActive = (account = {}) => {
  const status = normalizeIntelText(account.status || account.Status);
  return !status || status === 'active';
};

const isBankAccount = (account = {}) =>
  /bank/.test(normalizeIntelText(`${account.type || account.Type || ''} ${accountName(account)} ${account.payload?.Type || ''}`));

export const xeroTransactionDirection = (transaction = {}) => {
  if (numberValue(transaction.money_in) > 0) return 'RECEIVE';
  if (numberValue(transaction.money_out) > 0) return 'SPEND';
  return '';
};

export const xeroTransactionAmount = (transaction = {}) => {
  const amount = xeroTransactionDirection(transaction) === 'RECEIVE'
    ? transaction.money_in
    : xeroTransactionDirection(transaction) === 'SPEND'
      ? transaction.money_out
      : transaction.amount;
  return roundedAmount(Math.abs(numberValue(amount)));
};

const transactionCurrency = (transaction = {}) =>
  trim(transaction.account_currency || transaction.currency || transaction.CurrencyCode).toUpperCase();

const explicitBankKeys = (transaction = {}) =>
  [
    transaction.xero_bank_account_code,
    transaction.xeroBankAccountCode,
    transaction.bank_account_code,
    transaction.bankAccountCode,
    transaction.source_account_code,
    transaction.sourceAccountCode,
    transaction.xero_bank_account_id,
    transaction.xeroBankAccountId,
    transaction.bank_account_id,
    transaction.bankAccountId
  ]
    .map(trim)
    .filter(Boolean);

export const findXeroBankAccount = ({ transaction = {}, xeroAccounts = [] } = {}) => {
  const bankAccounts = xeroAccounts.filter((account) => isActive(account) && isBankAccount(account));
  if (!bankAccounts.length) return null;

  const keys = explicitBankKeys(transaction).map(normalizeIntelText);
  const currency = transactionCurrency(transaction);
  const scored = bankAccounts.map((account) => {
    const code = accountCode(account);
    const id = accountId(account);
    const name = accountName(account);
    const candidateCurrency = accountCurrency(account).toUpperCase();
    let score = 0;
    if (keys.some((key) => key && [code, id, name].map(normalizeIntelText).includes(key))) score += 100;
    if (currency && candidateCurrency === currency) score += 40;
    if (currency && normalizeIntelText(name).includes(normalizeIntelText(currency))) score += 30;
    if (account.enable_payments_to_account || account.EnablePaymentsToAccount) score += 5;
    if (code) score += 3;
    return { account, score };
  });

  scored.sort((left, right) => right.score - left.score || accountLabel(left.account).localeCompare(accountLabel(right.account)));
  return scored[0]?.account || null;
};

// D2 (export surface, 2026-07-07): a KNOWN multi-payee cluster row resolves to
// its generic contact ("Taxi") from the row's OWN text — the persisted per-row
// `contact` may carry the old cascade's first-member lump ("TAXI LICENCIA
// 0000" stamped on every taxi in the city), so it must not decide. Live receipt:
// the first post-fix export still landed three different taxis under one
// licencia because only the rule mint/read were fixed, not this surface.
const clusterContactFor = (transaction = {}) =>
  clusterContactLabel(
    `${transaction.merchant_pattern || ''} ${trim(
      transaction.description || transaction.cleaned_description || transaction.raw_description
    )} ${transaction.contact || ''}`
  );

const merchantName = (transaction = {}) => {
  const generic = clusterContactFor(transaction);
  if (generic) return generic;
  const contact = trim(transaction.contact || transaction.merchant_name || transaction.merchantName);
  if (contact && !/^(customer|client|merchant|supplier|vendor|unknown)$/i.test(contact)) return contact.slice(0, 120);
  const description = trim(transaction.description || transaction.cleaned_description || transaction.raw_description);
  const candidate = description.split(/[|,]/)[0] || transaction.merchant_pattern || transaction.id || 'Donna transaction';
  return trim(candidate).slice(0, 120) || 'Donna transaction';
};

const findXeroContact = ({ name = '', xeroContacts = [], exact = false } = {}) => {
  const key = normalizeIntelText(name);
  if (!key) return null;
  return xeroContacts.find((contact) => {
    const contactName = normalizeIntelText(contact.name || contact.Name);
    if (!contactName) return false;
    // D2: a generic cluster contact matches by EXACT name only — the substring
    // arms would re-attach the org's old specific contact ("taxi" is a
    // substring of "taxi licencia 0000"), re-lumping via ContactID.
    if (exact) return contactName === key;
    return contactName === key || contactName.includes(key) || key.includes(contactName);
  }) || null;
};

const xeroContactPayload = ({ transaction = {}, xeroContacts = [] } = {}) => {
  const name = merchantName(transaction);
  const generic = Boolean(clusterContactFor(transaction));
  const contact = findXeroContact({ name, xeroContacts, exact: generic });
  const id = trim(contact?.xero_contact_id || contact?.xeroContactId || contact?.ContactID || contact?.payload?.ContactID);
  return id ? { ContactID: id } : { Name: name };
};

export const codingInputFromTransaction = (transaction = {}) => {
  const suggestion = transaction.ai_suggestion && typeof transaction.ai_suggestion === 'object' ? transaction.ai_suggestion : {};
  return {
    proposed_account:
      transaction.proposed_account ||
      transaction.account_name ||
      transaction.xero_account_name ||
      transaction.category ||
      suggestion.proposed_account ||
      suggestion.account_name ||
      suggestion.account ||
      '',
    account_code:
      transaction.xero_account_code ||
      transaction.account_code ||
      suggestion.xero_account_code ||
      suggestion.account_code ||
      suggestion.proposed_account ||
      '',
    account_name: transaction.account_name || transaction.xero_account_name || suggestion.account_name || '',
    account_label: transaction.account_label || suggestion.account_label || '',
    xero_account_id: transaction.xero_account_id || suggestion.xero_account_id || '',
    xero_account_code: transaction.xero_account_code || suggestion.xero_account_code || '',
    xero_account_name: transaction.xero_account_name || suggestion.xero_account_name || '',
    xero_tax_type: transaction.xero_tax_type || suggestion.xero_tax_type || '',
    tax_treatment: transaction.tax_treatment || suggestion.tax_treatment || ''
  };
};

// Repo-standard short hash (byte-for-byte the same impl as firmDb.js /
// transactionIntel.js). Kept LOCAL on purpose: firmDb.js imports THIS module,
// so importing shortHash back from firmDb would be a circular import.
const shortHash = (value = '') => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
};

// Signed economic amount as a stable 2dp string: money-in is a credit (+),
// money-out a debit (-). Same convention as the transaction-listing script, so the
// dry-run preview reference and the orphan-inspection lister read the same
// number. Reset-stable — it is the economic fact of the line, not a row id.
const signedTransactionAmount = (transaction = {}) => {
  const moneyOut = numberValue(transaction.money_out);
  const moneyIn = numberValue(transaction.money_in);
  const signed = moneyOut > 0 ? -moneyOut : moneyIn;
  return roundedAmount(signed).toFixed(2);
};

// G1 (clean-offboarding guarantee) — derive the Xero idempotency `Reference`
// from the transaction's STABLE economic identity instead of the volatile row
// id.
//
// Why: a Xero bank-feed line carries no external_transaction_id / reference, so
// the old `... || transaction.id` fallback keyed the Reference on
// transaction.id — which is hard-deleted and re-minted on every client
// reset/re-upload (deleteClientInDb / scripts/delete_client.js). The fast
// exact-match idempotency gate (fetchXeroBankTransactionsByReference) therefore
// ALWAYS missed across a reset and fell onto the amount-fragile date+type+total
// fingerprint — which is how the pilot client's org accumulated duplicate/orphan
// BankTransactions (37 hand-deleted). See
// docs/xero-writeback-idempotency-across-reset.md (Option A) +
// docs/donna-xero-clean-offboarding.md (G1).
//
// The fix keys the fallback on [clientId, date, signedAmount, currency,
// normalizedDescription] — all reset-stable economic facts. client_id is
// deterministic from name + registration number (src/lib/intakeDraft.js), so a
// delete + re-upload of the same identity yields the SAME client_id; only
// transaction.id is volatile, which is exactly what we stop keying on. A real
// external id, when the source carries one, is already stable and authoritative
// — keep honouring it first; only the id-fallback is replaced (which also keeps
// the references of already-synced external-id rows unchanged).
//
// KNOWN LIMIT: signedAmount is in the key, so this still misses on amount / FX
// drift (a re-OCR or payment-processor settlement that lands a different
// amount). That residual is closed by G2 (void the stale mirror on reset so
// there is nothing to drift against). Documented in xeroWriteback.test.js.
export const xeroWritebackReference = (transaction = {}) => {
  const explicit = trim(transaction.external_transaction_id || transaction.reference);
  if (explicit) return explicit.slice(0, 255);
  const clientId = trim(transaction.client_id || transaction.clientId);
  const date = dateOnly(transaction.date || transaction.transaction_date || transaction.transactionDate);
  const currency = transactionCurrency(transaction);
  const normalizedDescription = normalizeIntelText(
    transaction.description || transaction.cleaned_description || transaction.raw_description || ''
  );
  const identity = [clientId, date, signedTransactionAmount(transaction), currency, normalizedDescription].join('|');
  return `donna:${shortHash(identity)}`.slice(0, 255);
};

// Recording fix (docs/xero-writeback-idempotency-across-reset.md §8.2/§8.7) —
// recognize Xero's idempotency-conflict rejection. Xero caches an Idempotency-Key
// server-side (~24h) even when the run that sent it was never recorded on our
// side (a mid-batch kill, a rolled-back recording transaction), and rejects the
// retry with a 400 whose Detail reads "Idempotency Key: ... is used with a
// different request." — live-org receipt quoted in §8.2. The caller treats this
// as "Xero already saw this post": re-check the org by stable reference and adopt
// the existing row instead of surfacing an error the operator can't act on.
export const isXeroIdempotencyCollision = (error) => {
  const message = String(error?.message || error?.payload?.Detail || '');
  return /idempotency\s*key/i.test(message);
};

// D-bonus (2026-07-07): only an AUTH/TRANSPORT failure indicts the Xero
// CONNECTION itself and should flip xero_connections.status to 'error' (which
// surfaces the alarming "Connect Xero" re-auth prompt). A row-level validation
// reject — a Xero 400/404/409/422, or a Donna-side 4xx thrown before the API
// call (e.g. an unmatched account, an ineligible-for-retry classification) — is
// about THIS transaction's data, NOT the link, so it must leave the connection
// 'connected'. Rate-limit (429) and Xero 5xx are transient server faults, not a
// re-auth situation, so they don't flip either. A throw with NO HTTP status is a
// network/transport failure (DNS, timeout, abort) → connection-level.
export const isXeroConnectionLevelError = (error = {}) => {
  const status = Number(error?.statusCode ?? error?.status ?? 0);
  if (status === 401 || status === 403) return true; // auth/permission → reconnect
  if (status >= 400 && status < 600) return false; // any other HTTP response is about the row, not the link
  return true; // no HTTP status ⇒ network/transport throw
};

// D3 (2026-07-07): the Xero History & Notes append is best-effort and its
// outcome was previously DISCARDED at both call sites — a built-but-failed note
// left no trace, so the "why is there no rationale in Xero?" report could not be
// diagnosed. This compresses the append result into a durable, machine-readable
// receipt recorded on the transaction payload and surfaced in the batch results,
// making the failure observable BEFORE we chase its root cause.
export const summarizeHistoryNoteOutcome = (outcome = null, at = null) => ({
  ok: Boolean(outcome?.ok),
  skipped: outcome?.skipped || null,
  error: outcome?.error || null,
  at: at || null
});

// Recording fix (§8.3) — the MINIMAL durable receipt stamped onto the
// transaction payload the moment Xero accepts the create, BEFORE the composite
// recording transaction (ledger post + review queue + sync runs) runs. Must
// cover every column the writeback candidate query
// (transactionWritebackCandidateQuery, firmDb.js) checks, so a row whose
// composite recording fails is still never re-offered to the next batch (which
// would burn its idempotency key at Xero). The composite commit re-applies a
// superset of this patch.
export const xeroSyncedReceiptPatch = ({ xeroBankTransactionId = null, bankAccount = null, syncedAt } = {}) => ({
  xero_sync_status: 'synced',
  xero_writeback_status: 'synced',
  xero_writeback_error: null,
  xero_writeback_error_at: null,
  xero_writeback_type: 'bank_transaction',
  xero_bank_transaction_id: xeroBankTransactionId || null,
  xero_bank_account: bankAccount || null,
  xero_synced_at: syncedAt
});

// Suspense-parked exclusion (idempotency doc §8.5 follow-up; live receipt: three
// the pilot client's rows previewed as `850 · Suspense` despite carrying settled markers) — a
// row whose coding rests at Suspense/unknown is PARKED, not settled: it must
// never export to the client's accounting org regardless of status flags, the
// same rule the auto-post path applies (codingAutoPost isCodedAccount). Checks
// the NAME fields only (an account CODE like '850' carries no meaning by
// itself); empty coding is not "parked" — the unmatched-account validation owns
// that dead-end.
export const XERO_WRITEBACK_SUSPENSE_PARKED = 'suspense_parked';
const PARKED_ACCOUNT_NAMES = new Set(['suspense', 'unknown']);
export const isSuspenseParkedCoding = (coding = {}) => {
  const names = [
    coding.xero_account_name,
    coding.account_name,
    coding.proposed_account,
    // account_label is `CODE · NAME` — compare the name segment.
    String(coding.account_label || '').split('·').pop()
  ]
    .map((value) => String(value == null ? '' : value).trim().toLowerCase())
    .filter(Boolean);
  return names.some((name) => PARKED_ACCOUNT_NAMES.has(name));
};

// G7 (clean-offboarding guarantee) — compose the human-readable History note for
// a posted BankTransaction from Donna's PERSISTED coding verdict (account, tax,
// contact, rationale) plus provenance (source id, the model that coded it). This
// RENDERS THE PERSISTED VERDICT — it invents nothing, it just reads what the
// coder already wrote and formats it for the CPA who inherits the org. Returns ''
// when there is nothing meaningful to say (the caller then posts no note).
// Defensive about field names: the rationale lives under a few aliases across the
// coding writers, so we check them all and OMIT what is absent rather than
// printing blank labels. See docs/donna-xero-clean-offboarding.md (G7).
//
// Also folds in the firm's reviewer note (`reviewer_note`) when present: a note the
// firm leaves on a row BEFORE it posts is a no-op against Xero at the time (there is
// nothing to annotate yet), but the main writeback merges the review-queue payload
// onto the transaction, so the note rides on `tx` here and lands in the at-sync
// History note instead of being lost. A note left AFTER the row is synced is mirrored
// directly by the post-hoc path (firmDb.appendXeroHistoryNoteForTransactionInDb),
// which passes an explicit `note` and bypasses this composer — so there is no
// double-post.
const HISTORY_NOTE_MAX = 900;

// The coding model id for the receipt trail (the model id is part of the
// receipt): the SAME persisted-verdict source the History note renders below —
// never a code default. Null when the row carries no model provenance.
export const codingModelForTransaction = (transaction = {}) => {
  const tx = transaction || {};
  const suggestion = tx.ai_suggestion && typeof tx.ai_suggestion === 'object' ? tx.ai_suggestion : {};
  return trim(suggestion.model || tx.coding_model) || null;
};

export const buildXeroHistoryNote = (transaction = {}, { coding = null } = {}) => {
  const tx = transaction || {};
  const suggestion = tx.ai_suggestion && typeof tx.ai_suggestion === 'object' ? tx.ai_suggestion : {};
  const code = coding || {};
  const account = trim(
    code.account_label || code.account_name || code.xero_account_name ||
    tx.account_label || tx.account_name || tx.xero_account_name ||
    suggestion.proposed_account || suggestion.account_name || tx.category
  );
  const tax = trim(code.xero_tax_type || tx.xero_tax_type || suggestion.xero_tax_type);
  const contact = trim(
    tx.counterparty || tx.contact_name || tx.vendor_name || tx.merchant_name || suggestion.contact_name
  );
  const rationale = trim(
    suggestion.rationale || suggestion.reason || suggestion.explanation || suggestion.narrative ||
    tx.coding_rationale || tx.match_explanation || tx.matchExplanation
  );
  // The firm's own reviewer note. Present here when it was left before the row
  // posted (the writeback merges the review-queue payload onto the transaction), so
  // a pre-post note folds into the at-sync note rather than being permanently lost.
  const firmNote = trim(tx.reviewer_note || code.reviewer_note);
  const model = trim(suggestion.model || tx.coding_model);
  const sourceId = trim(tx.id || tx.transaction_id);

  const head = [];
  if (account) head.push(`Coded to ${account}${tax ? ` (${tax})` : ''}`);
  else if (tax) head.push(`Tax: ${tax}`);
  if (contact) head.push(`Contact: ${contact}`);

  const segments = [];
  if (head.length) segments.push(`Donna · ${head.join(' · ')}.`);
  if (rationale) segments.push(`Rationale: ${rationale}`);
  if (firmNote) segments.push(`Firm note: ${firmNote}`);
  const provenance = [sourceId ? `Donna txn ${sourceId}` : '', model ? `coded ${model}` : '']
    .filter(Boolean)
    .join(', ');
  if (provenance) segments.push(`Provenance: ${provenance}.`);

  return segments.join(' ').replace(/\s+/g, ' ').trim().slice(0, HISTORY_NOTE_MAX);
};

export const buildXeroBankTransactionWriteback = ({
  transaction = {},
  xeroAccounts = [],
  xeroContacts = [],
  jurisdiction = null,
  // When set, the "coded account has no Xero match" dead-end returns a
  // STRUCTURED missing-account PROPOSE (the unmatched account + a
  // chart-of-accounts provision plan) instead of throwing, so a dry-run
  // pre-flight can surface "this account isn't in Xero — here's the plan" in
  // one view. A PROPOSE, not a silent auto-create: the operator confirms the
  // chart-of-accounts change (trust strategy). Default off — every other
  // (live / preview) caller keeps the throw. Only this case is structured; all
  // other build-time validations still throw.
  proposeProvisionOnUnmatched = false
} = {}) => {
  const direction = xeroTransactionDirection(transaction);
  if (!direction) throw validationError('Transaction must have either money_in or money_out before Xero writeback.');

  const amount = xeroTransactionAmount(transaction);
  if (!(amount > 0)) throw validationError('Transaction amount must be greater than zero before Xero writeback.');

  const date = dateOnly(transaction.date || transaction.transaction_date || transaction.transactionDate);
  if (!date) throw validationError('Transaction date is required before Xero writeback.');

  const bankAccount = findXeroBankAccount({ transaction, xeroAccounts });
  if (!bankAccount) throw validationError('No Xero bank account is synced for this transaction currency.');

  const coding = enrichCodingWithXeroAccount({
    coding: codingInputFromTransaction(transaction),
    transaction,
    xeroAccounts,
    jurisdiction
  });
  // Suspense-parked rows never export — even when the org's chart has a
  // matching Suspense account for the code to resolve against. The batch
  // prefilters these into a visible 'skipped' bucket; this throw is the
  // backstop for the single-row route.
  if (isSuspenseParkedCoding(coding)) {
    throw validationError(
      'Transaction coding rests at Suspense/unknown — parked rows are not exported to Xero. Code the transaction first.',
      XERO_WRITEBACK_SUSPENSE_PARKED
    );
  }
  const lineAccountCode = trim(coding.xero_account_code || (coding.xero_account_match_status === 'matched' ? coding.account_code : ''));
  if (!lineAccountCode) {
    if (proposeProvisionOnUnmatched) {
      return {
        ok: false,
        blocker: XERO_WRITEBACK_ACCOUNT_UNMATCHED,
        transaction_id: transaction.id || null,
        unmatched: {
          proposed_account: trim(coding.proposed_account || coding.account_name) || null,
          account_code: trim(coding.account_code) || null,
          account_name: trim(coding.account_name || coding.xero_account_name) || null,
          match_status: coding.xero_account_match_status || 'unmatched'
        },
        // PROPOSE the standard Donna chart of accounts (POST /xero/provision-coa
        // applies it). Surfacing the plan is the remediation; applying it stays
        // an operator decision.
        provision_plan: buildXeroCoaProvisionPlan({ xeroAccounts }),
        bank_account: bankAccountSummary(bankAccount)
      };
    }
    throw validationError('A matched Xero account code is required before Xero writeback.');
  }

  const bankCode = accountCode(bankAccount);
  const bankId = accountId(bankAccount);
  if (!bankCode && !bankId) throw validationError('The selected Xero bank account is missing both Code and AccountID.');
  if ((bankCode && bankCode === lineAccountCode) || (bankId && bankId === trim(coding.xero_account_id))) {
    throw validationError('Xero line item account cannot be the same as the bank account.');
  }

  const taxType = trim(coding.xero_tax_type || '').toUpperCase();
  const lineAmountTypes = taxType === 'NONE' || !taxType ? 'NoTax' : 'Inclusive';
  const reference = xeroWritebackReference(transaction);
  const description = trim(transaction.description || transaction.cleaned_description || transaction.raw_description || reference).slice(0, 4000);
  const bankAccountPayload = bankCode ? { Code: bankCode } : { AccountID: bankId };
  const lineItem = {
    Description: description || reference || 'Donna transaction',
    Quantity: 1,
    UnitAmount: amount,
    AccountCode: lineAccountCode,
    ...(taxType ? { TaxType: taxType } : {})
  };
  const bankTransaction = {
    Type: direction,
    Contact: xeroContactPayload({ transaction, xeroContacts }),
    Date: date,
    Status: 'AUTHORISED',
    LineAmountTypes: lineAmountTypes,
    BankAccount: bankAccountPayload,
    LineItems: [lineItem],
    ...(reference ? { Reference: reference } : {})
  };

  return {
    transaction_id: transaction.id || null,
    bank_transaction: bankTransaction,
    coding: {
      ...coding,
      account_code: lineAccountCode,
      account_label: coding.account_label || accountLabel({ code: lineAccountCode, name: coding.xero_account_name || coding.account_name })
    },
    bank_account: bankAccountSummary(bankAccount)
  };
};
