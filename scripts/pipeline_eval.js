#!/usr/bin/env node
// Pipeline eval baseline — snapshot the current state of a demo client
// and compute metrics for the LLM pipeline redesign phases.
//
// Usage:
//   node scripts/pipeline_eval.js --client=honeybee-hills-apiary
//   node scripts/pipeline_eval.js --client=honeybee-hills-apiary --save

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { queryFirmDb } from '../server/donna/firmDb.js';

const FIRM_ID = process.env.FIRM_ID || 'donna-demo-firm';

const parseArgs = () => {
  const args = { client: 'honeybee-hills-apiary', save: false };
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--client=')) args.client = arg.slice('--client='.length);
    if (arg === '--save') args.save = true;
  }
  return args;
};

const fetchDocuments = async (clientId) => {
  const result = await queryFirmDb(
    `select * from documents
     where firm_id = $1 and client_id = $2
     order by created_at`,
    [FIRM_ID, clientId]
  );
  return result.rows.map((row) => ({ ...row, ...(row.payload || {}) }));
};

const fetchTransactions = async (clientId) => {
  const result = await queryFirmDb(
    `select * from transactions
     where firm_id = $1 and client_id = $2
     order by transaction_date nulls last, created_at`,
    [FIRM_ID, clientId]
  );
  return result.rows.map((row) => ({ ...row, ...(row.payload || {}) }));
};

const fetchMatches = async (clientId) => {
  const result = await queryFirmDb(
    `select * from reconciliation_matches
     where firm_id = $1 and client_id = $2
     order by created_at desc`,
    [FIRM_ID, clientId]
  );
  return result.rows.map((row) => ({ ...row, ...(row.payload || {}) }));
};

const fetchReviewItems = async (clientId) => {
  const result = await queryFirmDb(
    `select * from transaction_review_queue
     where firm_id = $1 and client_id = $2
     order by created_at desc`,
    [FIRM_ID, clientId]
  );
  return result.rows.map((row) => ({ ...row, ...(row.payload || {}) }));
};

const computeMetrics = ({ documents, transactions, matches, reviewItems }) => {
  const bills = documents.filter((d) =>
    d.document_type === 'supplier_bill'
  );
  const receipts = documents.filter((d) =>
    d.document_type === 'receipt'
  );
  const salesInvoices = documents.filter((d) =>
    d.document_type === 'sales_invoice'
  );

  const confirmedOrAutoStatuses = new Set(['confirmed', 'auto_matched']);
  const suggestedStatuses = new Set(['suggested']);

  const billMatches = matches.filter((m) => m.matched_object_type === 'supplier_bill');
  const receiptMatches = matches.filter((m) => m.matched_object_type === 'receipt');
  const salesInvoiceMatches = matches.filter((m) =>
    m.matched_object_type === 'sales_invoice' || m.matched_object_type === 'invoice'
  );

  const confirmedBillMatches = billMatches.filter((m) => confirmedOrAutoStatuses.has(m.status));
  const suggestedBillMatches = billMatches.filter((m) => suggestedStatuses.has(m.status));
  const confirmedReceiptMatches = receiptMatches.filter((m) => confirmedOrAutoStatuses.has(m.status));
  const confirmedSalesMatches = salesInvoiceMatches.filter((m) => confirmedOrAutoStatuses.has(m.status));

  const matchedBillIds = new Set(
    billMatches
      .filter((m) => confirmedOrAutoStatuses.has(m.status) || suggestedStatuses.has(m.status))
      .map((m) => m.matched_object_id)
  );

  const categorizedTxs = transactions.filter((t) =>
    t.account_code || t.account_name || t.proposed_account
  );

  const reconciledTxs = transactions.filter((t) =>
    t.reconciliation_status === 'reconciled' ||
    t.reconciliation_status === 'auto_reconciled' ||
    t.reconciliation_status === 'explained'
  );

  const openReviewItems = reviewItems.filter((r) => r.status === 'open');

  return {
    bills: {
      total: bills.length,
      matched: matchedBillIds.size,
      confirmed: confirmedBillMatches.length,
      suggested: suggestedBillMatches.length,
      unmatched: bills.length - matchedBillIds.size,
      match_rate: bills.length > 0
        ? Number((matchedBillIds.size / bills.length).toFixed(4))
        : 0
    },
    receipts: {
      total: receipts.length,
      matched: confirmedReceiptMatches.length,
      match_rate: receipts.length > 0
        ? Number((confirmedReceiptMatches.length / receipts.length).toFixed(4))
        : 0
    },
    salesInvoices: {
      total: salesInvoices.length,
      matched: confirmedSalesMatches.length,
      match_rate: salesInvoices.length > 0
        ? Number((confirmedSalesMatches.length / salesInvoices.length).toFixed(4))
        : 0
    },
    transactions: {
      total: transactions.length,
      categorized: categorizedTxs.length,
      reconciled: reconciledTxs.length,
      uncategorized: transactions.length - categorizedTxs.length,
      categorize_rate: transactions.length > 0
        ? Number((categorizedTxs.length / transactions.length).toFixed(4))
        : 0
    },
    review: {
      total: reviewItems.length,
      open: openReviewItems.length
    },
    false_match_rate: 0,
    false_categorize_rate: 0
  };
};

const buildExpectedOutcomes = ({ documents, transactions, matches }) => {
  const matchOutcomes = matches.map((m) => ({
    match_id: m.id,
    transaction_id: m.bank_transaction_id,
    document_id: m.matched_object_id,
    document_type: m.matched_object_type,
    status: m.status,
    confidence: m.match_confidence
  }));

  const categoryOutcomes = transactions
    .filter((t) => t.account_code || t.account_name)
    .map((t) => ({
      transaction_id: t.id,
      account_code: t.account_code,
      account_name: t.account_name || t.proposed_account,
      description: t.description
    }));

  return { matchOutcomes, categoryOutcomes };
};

const printSummary = (clientId, metrics) => {
  console.log(`\n=== Pipeline Eval Baseline: ${clientId} ===\n`);

  const { bills, receipts, salesInvoices, transactions, review } = metrics;

  console.log(`Bills: ${bills.total} total, ${bills.matched} matched (${(bills.match_rate * 100).toFixed(0)}%), ${bills.confirmed} confirmed, ${bills.suggested} suggested, ${bills.unmatched} unmatched`);
  if (receipts.total > 0) {
    console.log(`Receipts: ${receipts.total} total, ${receipts.matched} matched (${(receipts.match_rate * 100).toFixed(0)}%)`);
  }
  if (salesInvoices.total > 0) {
    console.log(`Sales invoices: ${salesInvoices.total} total, ${salesInvoices.matched} matched (${(salesInvoices.match_rate * 100).toFixed(0)}%)`);
  }
  console.log(`Transactions: ${transactions.total} total, ${transactions.categorized} categorized (${(transactions.categorize_rate * 100).toFixed(0)}%)`);
  console.log(`Review queue: ${review.open} open items`);
  console.log(`False match rate: ${metrics.false_match_rate}`);
  console.log('');
};

async function main() {
  const { client: clientId, save } = parseArgs();
  console.log(`[pipeline_eval] firm=${FIRM_ID}, client=${clientId}`);

  const [documents, transactions, matches, reviewItems] = await Promise.all([
    fetchDocuments(clientId),
    fetchTransactions(clientId),
    fetchMatches(clientId),
    fetchReviewItems(clientId)
  ]);

  const metrics = computeMetrics({ documents, transactions, matches, reviewItems });
  const expectedOutcomes = buildExpectedOutcomes({ documents, transactions, matches });

  printSummary(clientId, metrics);

  if (save) {
    const fixture = {
      meta: {
        client_id: clientId,
        firm_id: FIRM_ID,
        generated_at: new Date().toISOString(),
        phase: 0
      },
      metrics,
      expected_outcomes: expectedOutcomes,
      counts: {
        documents: documents.length,
        transactions: transactions.length,
        matches: matches.length,
        review_items: reviewItems.length
      }
    };

    const evalsDir = resolvePath(process.cwd(), 'data', 'evals');
    mkdirSync(evalsDir, { recursive: true });
    const outPath = resolvePath(evalsDir, `baseline_${clientId}.json`);
    writeFileSync(outPath, JSON.stringify(fixture, null, 2) + '\n');
    console.log(`Saved baseline fixture to ${outPath}`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Pipeline eval failed:', err.message || err);
  process.exit(1);
});
