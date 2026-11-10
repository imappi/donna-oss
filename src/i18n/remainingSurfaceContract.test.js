import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import en from './catalogs/en.js';
import { AR_AE_CATALOG_METADATA } from './catalogs/ar-AE.js';
import remainingSurfacesEn, {
  OPERATOR_ACTION_MESSAGES,
  OPERATOR_ACTION_TYPE_MESSAGE_IDS,
  PORTAL_DETAIL_MESSAGES,
  PORTAL_DOCUMENT_TYPE_MESSAGE_IDS,
  PORTAL_LEGAL_FORM_MESSAGE_IDS,
  REMAINING_SURFACE_CATALOG_GROUPS,
  REPORT_DRAFT_REASON_MESSAGE_IDS,
  REPORT_MESSAGES,
  TRANSACTION_REJECTION_MESSAGE_IDS
} from './catalogs/remainingSurfaces.en.js';
import mountedSurfacesEn from './catalogs/mountedSurfaces.en.js';
import {
  INTERFACE_CATALOG_VERSION,
  INTERFACE_CATALOGS,
  getInterfaceCatalog,
  validateInterfaceCatalog
} from './localeCatalog.js';
import { ENTITY_TYPE_LABEL } from '../lib/legalForms.js';
import { PROPOSAL_CARD_ACTION_TYPES } from '../lib/operatorProposalCards.js';
import { TRANSACTION_ACTION_TYPE_LABELS } from '../lib/transactionChat.js';

const flattenMessageIds = (value) => {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(flattenMessageIds);
};

test('AR-2 remaining surfaces retain their exact source contract under the current catalog version', () => {
  assert.equal(INTERFACE_CATALOG_VERSION, '2026-09-28.sg-native-intake.1');
  assert.equal(
    AR_AE_CATALOG_METADATA.sourceCatalogVersion,
    '2026-09-01.ar2-remaining-surfaces-contract'
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(REMAINING_SURFACE_CATALOG_GROUPS)
        .map(([group, messages]) => [group, Object.keys(messages).length])
    ),
    { report: 74, operatorAction: 255, portalDetail: 407 }
  );
  assert.equal(Object.keys(remainingSurfacesEn).length, 736);
  assert.equal(
    Object.values(REMAINING_SURFACE_CATALOG_GROUPS)
      .reduce((sum, messages) => sum + Object.keys(messages).length, 0),
    Object.keys(remainingSurfacesEn).length,
    'a duplicate key across reserved groups must not be silently overwritten'
  );
});

test('reserved groups use only their assigned namespaces and do not replace prior English keys', () => {
  assert.ok(Object.keys(REPORT_MESSAGES).every((key) => key.startsWith('report.')));
  assert.ok(
    Object.keys(OPERATOR_ACTION_MESSAGES)
      .every((key) => /^(operator|feed|transaction)\./.test(key))
  );
  assert.ok(Object.keys(PORTAL_DETAIL_MESSAGES).every((key) => key.startsWith('portal.')));

  const legacyCatalogSource = readFileSync(new URL('./catalogs/en.js', import.meta.url), 'utf8');
  const literalKeys = new Set(
    [...legacyCatalogSource.matchAll(/^\s*'([^']+)'\s*:/gm)].map((match) => match[1])
  );
  const overlap = Object.keys(remainingSurfacesEn).filter((key) => literalKeys.has(key));
  assert.deepEqual(overlap, [], 'the additive contract must not overwrite an earlier catalog message');
});

test('every reserved English message is valid ICU and reaches both runtime catalogs', () => {
  assert.deepEqual(validateInterfaceCatalog(remainingSurfacesEn, { locale: 'en-contract' }), []);
  for (const key of Object.keys(remainingSurfacesEn)) {
    assert.equal(en[key], remainingSurfacesEn[key], `English catalog omitted ${key}`);
    assert.equal(typeof INTERFACE_CATALOGS['ar-XB'][key], 'string', `pseudo catalog omitted ${key}`);
  }
  assert.equal(Object.keys(en).length, 1810 + Object.keys(mountedSurfacesEn).length); // includes 83 reconciliation-authority messages, 129 interface-value labels (tray document types, ask-client phrases and owner-language previews, journal and chat-action statuses, team grant/seat/invite-email labels, hosted-pilot check labels, portal-chat intent labels, audit-load errors), 35 owner-portal-access messages, 15 FI-05 customer-failure messages less 6 retired raw-reason tray labels, 40 pilot setup, 29 provider-failure receipt, 3 scoped-assessment, 3 refused-upload tray, 1 FI first-fill 15 working-phase/batch-summary and 8 direct processing-review messages
  assert.equal(
    Object.keys(getInterfaceCatalog('ar-AE')).length,
    Object.keys(en).length,
    'the source contract must reach the installed Arabic catalog'
  );
});

test('report reason codes have typed ICU contracts and an isolated unknown-detail fallback', () => {
  assert.deepEqual(REPORT_DRAFT_REASON_MESSAGE_IDS, {
    ledger_imbalance: 'report.reason.ledgerImbalance',
    balance_sheet_imbalance: 'report.reason.balanceSheetImbalance',
    unclassified_accounts: 'report.reason.unclassifiedAccounts',
    unposted_transactions: 'report.reason.unpostedTransactions',
    pending_questions: 'report.reason.pendingQuestions'
  });
  assert.equal(en['report.reason.unknown'], '{detail}');
  assert.match(en['report.reason.unclassifiedAccounts'], /\{count, plural,/);
  assert.match(en['report.currency.mixed'], /\{currencies\}/);
});

test('operator and transaction closed enums resolve only to reserved message ids', () => {
  for (const actionType of PROPOSAL_CARD_ACTION_TYPES) {
    assert.equal(typeof OPERATOR_ACTION_TYPE_MESSAGE_IDS[actionType], 'string', actionType);
  }
  for (const actionType of Object.keys(TRANSACTION_ACTION_TYPE_LABELS)) {
    assert.equal(typeof OPERATOR_ACTION_TYPE_MESSAGE_IDS[actionType], 'string', actionType);
  }
  for (const messageId of Object.values(OPERATOR_ACTION_TYPE_MESSAGE_IDS)) {
    assert.equal(typeof remainingSurfacesEn[messageId], 'string', messageId);
  }
  assert.deepEqual(Object.keys(TRANSACTION_REJECTION_MESSAGE_IDS), [
    'wrong_document',
    'wrong_transaction',
    'already_settled',
    'never_match',
    'other'
  ]);
  for (const messageId of flattenMessageIds(TRANSACTION_REJECTION_MESSAGE_IDS)) {
    assert.equal(typeof remainingSurfacesEn[messageId], 'string', messageId);
  }
});

test('portal presentation bridges cover every canonical legal form and current document type', () => {
  assert.deepEqual(
    Object.keys(PORTAL_LEGAL_FORM_MESSAGE_IDS).sort(),
    Object.keys(ENTITY_TYPE_LABEL).sort()
  );
  for (const messageId of Object.values(PORTAL_LEGAL_FORM_MESSAGE_IDS)) {
    assert.equal(typeof remainingSurfacesEn[messageId], 'string', messageId);
  }
  assert.deepEqual(Object.keys(PORTAL_DOCUMENT_TYPE_MESSAGE_IDS), [
    'bank_statement',
    'sales_invoice',
    'issued_receipt',
    'supplier_bill',
    'receipt',
    'payroll_cpf',
    'financing',
    'payment_account_statement',
    'xero_setup',
    'chart_of_accounts',
    'statutory_record',
    'unknown'
  ]);
  for (const messageId of Object.values(PORTAL_DOCUMENT_TYPE_MESSAGE_IDS)) {
    assert.equal(typeof remainingSurfacesEn[messageId], 'string', messageId);
  }
});
