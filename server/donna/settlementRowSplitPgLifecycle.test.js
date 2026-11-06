// RT-21f acceptance on a disposable real Postgres (the postingPolicyPgLifecycle
// harness): the Kultalanka NETS row end to end through the NAMED writer —
// document + settlement row (RT-21b shape) + the decided row match (RT-21c,
// migration 150) + an applied Sales coding under FINLAND_ALV_CODING → ONE
// four-leg journal footing to the bank amount, the ALV code on the sales leg
// (finland/alvReturn.js reads ledger_lines.tax_type), the row on the
// transaction receipt. Skips without DONNA_PG_TEST_URL.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, postLedgerTransactionInDb } from './firmDb.js';
import { ledgerRecordId } from './db/ledger.js';
import { readClientConfigSnapshot } from './clientConfig.js';
import { sweepLedgerAutoPost } from './ledgerAutoPost.js';
import { installConvergenceSettleOnPool, applyConvergenceState } from './reconcileConvergenceState.js';
import { resolveCodingPolicy, codingPolicyReceipt } from './codingPolicy.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
// A rejects-validator that NAMES the error it got when the code is not the one expected.
const refusesWith = (code) => (e) => {
  if (e?.code === code) return true;
  console.error(`expected refusal ${code}, got ${e?.code || '(no code)'}: ${e?.message || e}`);
  return false;
};

test('real PG: a NETS credit settled by a koontilasku row posts bank net · fee · sales gross (base + output ALV) — one journal, footing, the row receipted; the gross decoy refuses by name', {
  skip: pgUrl ? false : 'DONNA_PG_TEST_URL not set — disposable-PG settlement-row lifecycle not exercised'
}, async (t) => {
  const name = `donna_rt21f_${Date.now().toString(36)}_${process.pid}`;
  const admin = new pg.Client({ connectionString: pgUrl });
  await admin.connect();
  await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  // RT-23: the production settle seam (loadPgPool installs it) — the persisted
  // convergence verdict is part of this proof.
  installConvergenceSettleOnPool(pool);
  const connectionsClosed = [];
  pool.on('connect', (connection) => { connectionsClosed.push(new Promise((resolve) => connection.once('end', resolve))); });
  __setFirmDbPoolForTests(pool);
  t.after(async () => {
    __resetFirmDbPoolForTests();
    await pool.end();
    await Promise.all(connectionsClosed);
    await admin.query(`drop database "${name}"`);
    await admin.end();
  });
  await pool.query(`create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb);`);
  const migrationRoot = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrationRoot)).filter((n) => n.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(file, migrationRoot), 'utf8'));
  }

  const firmId = 'rt21f-firm';
  const clientId = 'kultalanka';
  await pool.query("insert into firms (id, name, slug) values ($1, 'RT-21f', 'rt21f')", [firmId]);
  await pool.query(`insert into clients (id, firm_id, company_name, jurisdiction, profile) values ($1, $2, 'Kampaamo Kultalanka Oy', 'fi', $3)`,
    [clientId, firmId, { jurisdiction: 'fi', accounting_system: 'none', accounting_basis: 'cash' }]);
  // The seed PR #2065 posture: FINLAND_ALV_CODING acts, so the sales leg carries the code.
  await pool.query(`insert into client_capability_config (id, firm_id, client_id, flag_key, stage, source) values ($1, $2, $3, 'FINLAND_ALV_CODING', 'auto', 'manual')`,
    [`${firmId}:${clientId}:FINLAND_ALV_CODING`, firmId, clientId]);
  const account = (code, name, type, normalBalance, role) => pool.query(
    `insert into ledger_accounts (id, firm_id, client_id, code, name, account_type, normal_balance, currency, tax_type, canonical_role, status)
     values ($1, $2, $3, $4, $5, $6, $7, 'EUR', null, $8, 'active')`,
    [ledgerRecordId('account', firmId, clientId, code), firmId, clientId, code, name, type, normalBalance, role]);
  await account('1910', 'Pankkitili', 'bank', 'debit', 'asset.cash');
  await account('3000', 'Sales', 'revenue', 'credit', 'revenue.operating');
  await account('4550', 'Platform and processor fees', 'expense', 'debit', 'expense.platform_fees');

  // The koontilasku (RT-21b shape) and its VKO5 row.
  const documentId = 'doc-nets-02-2025';
  const lineId = `${documentId}-ln-1-abc123`;
  await pool.query(`insert into documents (id, firm_id, client_id, filename, document_type, status, parse_status, total_amount, currency, document_date, payment_status, parse_summary, payload)
    values ($1, $2, $3, '14 Nets kuukausiraportti 02-2025.pdf', 'payout_statement', 'received', 'completed', 10206.48, 'EUR', '2025-02-28', 'paid', $4, '{}')`,
    [documentId, firmId, clientId, { settlement: { kind: 'payout_statement', net_payout: 10206.48, rows_validation: { matches: true } } }]);
  const settlementRow = { row_no: 1, period_label: 'VKO5 2025 (27.1.–2.2.)', period_start: '2025-01-27', period_end: '2025-02-02', paid_on: '2025-02-03', gross: 2480, fee: 27.28, fee_tax: 0, net: 2452.72, net_derived: false, transaction_count: 31, reference: null };
  await pool.query(`insert into document_lines (id, firm_id, client_id, document_id, description, quantity, unit_price, amount, line_no, review_status, payload)
    values ($1, $2, $3, $4, 'VKO5 2025 (27.1.–2.2.)', 1, 2452.72, 2452.72, 1, 'needs_review', $5)`,
    [lineId, firmId, clientId, documentId, { raw_extraction: { description: 'VKO5 2025 (27.1.–2.2.)', quantity: 1, unit_price: 2452.72, amount: 2452.72, tax_rate: null, settlement_row: settlementRow } }]);

  const policy = resolveCodingPolicy({ jurisdiction: 'fi', businessDate: '2025-02-03', accountingSystem: 'none' });
  const suggestion = { proposed_account: 'Sales', tax_treatment: 'ALV 25,5 %', confidence: 'high', model: 'fixture-coder', coding_policy: codingPolicyReceipt(policy) };
  const insertTx = (id, moneyIn) => pool.query(
    `insert into transactions (id, firm_id, client_id, transaction_date, description, money_in, money_out, currency, status, coding_state, payload)
     values ($1, $2, $3, '2025-02-03', 'NETS FINLAND OY', $4, 0, 'EUR', 'needs_review', 'applied', $5)`,
    [id, firmId, clientId, moneyIn, { ai_suggestion: suggestion }]);
  await insertTx('tx-nets-5', 2452.72);
  // The decided row match (RT-21c).
  await pool.query(`insert into reconciliation_matches (id, firm_id, client_id, bank_transaction_id, matched_object_type, matched_object_id, matched_line_id, match_amount, match_confidence, match_reason, status, created_by, payload)
    values ('recon-nets-row1', $1, $2, 'tx-nets-5', 'payout_statement', $3, $4, 2452.72, 0.93, 'row 1', 'auto_matched', 'system', $5)`,
    [firmId, clientId, documentId, lineId, { source: 'payout_reconciliation_llm', settlement_row: { line_id: lineId, line_no: 1, net: 2452.72 } }]);

  // RT-24: a matcher-minted clarification that arrived AFTER the coding was applied
  // — the Kampaamo Lumikki / Ilmarinen shape (posted, matched, still ASKED).
  await pool.query(`insert into client_evidence_requests (id, firm_id, client_id, transaction_id, status, evidence_type, question, request_payload)
    values ('ask-nets-5', $1, $2, 'tx-nets-5', 'draft', 'business_purpose', 'We matched the EUR 2452.72 to the Nets report — anything unusual about this week?', $3)`,
    [firmId, clientId, { audience: 'client' }]);
  const preview = await postLedgerTransactionInDb({ firmId, clientId, transactionId: 'tx-nets-5', dryRun: true });
  assert.equal(preview.ledger_posting.settlement_split.line_no, 1);
  assert.equal(preview.ledger_posting.settlement_split.gross, 2480);
  await postLedgerTransactionInDb({ firmId, clientId, transactionId: 'tx-nets-5', dryRun: false, skipSnapshot: true, actorId: 'fixture-owner' });

  const journals = (await pool.query("select id from ledger_journals where client_id = $1 and source_type = 'transaction' and source_id = 'tx-nets-5'", [clientId])).rows;
  assert.equal(journals.length, 1, 'ONE journal');
  const lines = (await pool.query('select account_code, direction, debit, credit, tax_type from ledger_lines where journal_id = $1 order by line_no', [journals[0].id])).rows
    .map((l) => ({ account_code: l.account_code, direction: l.direction, debit: Number(l.debit), credit: Number(l.credit), tax_type: l.tax_type }));
  assert.deepEqual(lines, [
    { account_code: '1910', direction: 'debit', debit: 2452.72, credit: 0, tax_type: 'NONE' },
    { account_code: '4550', direction: 'debit', debit: 27.28, credit: 0, tax_type: 'NONE' },
    { account_code: '3000', direction: 'credit', debit: 0, credit: 1976.1, tax_type: 'ALV_25_5_OUTPUT' },
    { account_code: '2939', direction: 'credit', debit: 0, credit: 503.9, tax_type: 'NONE' }
  ]);
  const tx = (await pool.query("select coding_state, reconciliation_status, payload from transactions where id = 'tx-nets-5'")).rows[0];
  assert.equal(tx.coding_state, 'posted');
  assert.equal(tx.reconciliation_status, 'posted');
  assert.equal(tx.payload.settlement_split.line_id, lineId);
  assert.equal(tx.payload.settlement_split.fee, 27.28);
  const audit = (await pool.query("select metadata from audit_events where action = 'ledger.post_transaction' and resource_id = 'tx-nets-5'")).rows[0];
  assert.equal(audit.metadata.settlement_split.line_no, 1);
  const ask = (await pool.query("select status, resolved_by, response_payload->>'resolution_note' as note from client_evidence_requests where id = 'ask-nets-5'")).rows[0];
  assert.deepEqual(ask, { status: 'resolved', resolved_by: 'fixture-owner', note: `Superseded by ledger post (journal ${journals[0].id}).` }, 'the post resolved the open ask');
  assert.equal((await pool.query("select count(*)::int n from audit_events where action = 'evidence_request.superseded_by_coding' and resource_id = 'tx-nets-5'")).rows[0].n, 1);
  assert.deepEqual((await pool.query("select convergence_state, convergence_reason from transactions where id = 'tx-nets-5'")).rows[0],
    { convergence_state: 'auto_reconciled', convergence_reason: 'coding_state:posted' }, 'terminal 1, not on_owner');

  // The gross decoy matched to a row (a wrong match) refuses by name — never a shaded post.
  await insertTx('tx-decoy-gross', 2480);
  await pool.query(`insert into document_lines (id, firm_id, client_id, document_id, description, quantity, unit_price, amount, line_no, review_status, payload)
    values ($1, $2, $3, $4, 'VKO6 2025 (3.2.–9.2.)', 1, 2581.29, 2581.29, 2, 'needs_review', $5)`,
    [`${documentId}-ln-2-def456`, firmId, clientId, documentId, { raw_extraction: { amount: 2581.29, settlement_row: { ...settlementRow, row_no: 2, gross: 2610, fee: 28.71, net: 2581.29 } } }]);
  await pool.query(`insert into reconciliation_matches (id, firm_id, client_id, bank_transaction_id, matched_object_type, matched_object_id, matched_line_id, match_amount, match_confidence, match_reason, status, created_by, payload)
    values ('recon-decoy', $1, $2, 'tx-decoy-gross', 'payout_statement', $3, $4, 2480, 0.9, 'wrong', 'confirmed', 'firm', '{}')`,
    [firmId, clientId, documentId, `${documentId}-ln-2-def456`]);
  await assert.rejects(postLedgerTransactionInDb({ firmId, clientId, transactionId: 'tx-decoy-gross', dryRun: true }), refusesWith('SETTLEMENT_SPLIT_BANK_AMOUNT_MISMATCH'));

  // RT-23 — the VKO6 row under the coder's own unsure marker: the post REFUSES
  // by name (never Cr Sales gross with tax_type null, the Kampaamo 2026-09-09
  // shape), the auto-post sweep receipts the refusal on the row, and the
  // persisted convergence verdict hangs under the refusal code instead of
  // laundering the applied coding as auto_reconciled. Resolving the treatment
  // posts, clears the stamp, and the row settles.
  const lineId6 = `${documentId}-ln-3-ghi789`;
  await pool.query(`insert into document_lines (id, firm_id, client_id, document_id, description, quantity, unit_price, amount, line_no, review_status, payload)
    values ($1, $2, $3, $4, 'VKO6 2025 (3.2.–9.2.)', 1, 2625.79, 2625.79, 3, 'needs_review', $5)`,
    [lineId6, firmId, clientId, documentId, { raw_extraction: { amount: 2625.79, settlement_row: { ...settlementRow, row_no: 3, period_label: 'VKO6 2025 (3.2.–9.2.)', paid_on: '2025-02-10', gross: 2655, fee: 29.21, net: 2625.79 } } }]);
  await pool.query(
    `insert into transactions (id, firm_id, client_id, transaction_date, description, money_in, money_out, currency, status, coding_state, payload)
     values ('tx-nets-6', $1, $2, '2025-02-10', 'NETS FINLAND OY', 2625.79, 0, 'EUR', 'needs_review', 'applied', $3)`,
    [firmId, clientId, { ai_suggestion: { ...suggestion, tax_treatment: 'ALV-tarkistus',
      coding_policy: codingPolicyReceipt(resolveCodingPolicy({ jurisdiction: 'fi', businessDate: '2025-02-10', accountingSystem: 'none' })) } }]);
  await pool.query(`insert into reconciliation_matches (id, firm_id, client_id, bank_transaction_id, matched_object_type, matched_object_id, matched_line_id, match_amount, match_confidence, match_reason, status, created_by, payload)
    values ('recon-nets-row3', $1, $2, 'tx-nets-6', 'payout_statement', $3, $4, 2625.79, 0.93, 'row 3', 'auto_matched', 'system', $5)`,
    [firmId, clientId, documentId, lineId6, { source: 'payout_reconciliation_llm', settlement_row: { line_id: lineId6, line_no: 3, net: 2625.79 } }]);
  await assert.rejects(postLedgerTransactionInDb({ firmId, clientId, transactionId: 'tx-nets-6', dryRun: true }), refusesWith('TRANSACTION_ALV_TREATMENT_UNRESOLVED'));
  await assert.rejects(postLedgerTransactionInDb({ firmId, clientId, transactionId: 'tx-nets-6', dryRun: false, skipSnapshot: true, actorId: 'fixture-owner' }), refusesWith('TRANSACTION_ALV_TREATMENT_UNRESOLVED'));
  assert.equal((await pool.query("select count(*)::int n from ledger_journals where source_id = 'tx-nets-6'")).rows[0].n, 0, 'no journal for the unresolved leg');
  const before = (await pool.query("select convergence_state, convergence_reason from transactions where id = 'tx-nets-6'")).rows[0];
  assert.deepEqual(before, { convergence_state: 'hanging', convergence_reason: 'ledger_post_refused:TRANSACTION_ALV_TREATMENT_UNRESOLVED' }, 'the public posting writer persists the refusal immediately, before the sweep');
  await pool.query(`insert into client_capability_config (id, firm_id, client_id, flag_key, stage, source) values ($1, $2, $3, 'LEDGER_AUTO_POST', 'auto', 'manual')`,
    [`${firmId}:${clientId}:LEDGER_AUTO_POST`, firmId, clientId]);
  const configSnapshot = await readClientConfigSnapshot(pool, { firmId, clientId });
  const sweep = await sweepLedgerAutoPost({ firmId, clientId, configSnapshot, transactionId: 'tx-nets-6' });
  assert.deepEqual({ eligible: sweep.eligible, posted: sweep.posted, refused: sweep.refused, refusal_receipts: sweep.refusal_receipts }, { eligible: 1, posted: 0, refused: 1, refusal_receipts: 1 }, JSON.stringify(sweep));
  const refused = (await pool.query("select coding_state, convergence_state, convergence_reason, payload->'ledger_post_refusal' as refusal from transactions where id = 'tx-nets-6'")).rows[0];
  assert.equal(refused.coding_state, 'applied', 'the coding decision stands; only the post is refused');
  assert.equal(refused.refusal.code, 'TRANSACTION_ALV_TREATMENT_UNRESOLVED');
  assert.equal(refused.refusal.source, 'ledger_auto_post_sweep');
  assert.deepEqual([refused.convergence_state, refused.convergence_reason], ['hanging', 'ledger_post_refused:TRANSACTION_ALV_TREATMENT_UNRESOLVED'], 'the refused post is visible to convergence');
  assert.equal((await sweepLedgerAutoPost({ firmId, clientId, configSnapshot, transactionId: 'tx-nets-6' })).eligible, 0, 'the refusal damps the next tick');
  // RT-25 — the receipt is the input, the stamp is second. On the mini a
  // full-payload writer erased the stamp after the sweep (six receipts, zero
  // stamps, every refused row reading auto_reconciled). Strip the stamp with
  // updated_at untouched, as that writer did: the re-derivation reads the
  // sweep's audit receipt and the row still hangs under the refusal code.
  await pool.query("update transactions set payload = payload - 'ledger_post_refusal' where id = 'tx-nets-6'");
  await applyConvergenceState(pool, { firmId, transactionId: 'tx-nets-6' });
  const unstamped = (await pool.query("select convergence_state, convergence_reason, payload ? 'ledger_post_refusal' as stamped from transactions where id = 'tx-nets-6'")).rows[0];
  assert.deepEqual(unstamped, { convergence_state: 'hanging', convergence_reason: 'ledger_post_refused:TRANSACTION_ALV_TREATMENT_UNRESOLVED', stamped: false },
    'the durable receipt, not the erased stamp, is what convergence reads');
  // The treatment resolved (a recode, a rule, an owner answer): the post lands and the stamp goes.
  await pool.query(`update transactions set payload = jsonb_set(payload, '{ai_suggestion,tax_treatment}', '"ALV 25,5 %"') where id = 'tx-nets-6'`);
  await postLedgerTransactionInDb({ firmId, clientId, transactionId: 'tx-nets-6', dryRun: false, skipSnapshot: true, actorId: 'fixture-owner' });
  const settled = (await pool.query("select coding_state, convergence_state, convergence_reason, payload ? 'ledger_post_refusal' as stamped from transactions where id = 'tx-nets-6'")).rows[0];
  assert.deepEqual(settled, { coding_state: 'posted', convergence_state: 'auto_reconciled', convergence_reason: 'coding_state:posted', stamped: false });
  const lines6 = (await pool.query("select l.account_code, l.credit, l.tax_type from ledger_lines l join ledger_journals j on j.id = l.journal_id where j.source_id = 'tx-nets-6' and l.account_code = '3000'")).rows;
  assert.deepEqual(lines6.map((l) => ({ account_code: l.account_code, credit: Number(l.credit), tax_type: l.tax_type })), [{ account_code: '3000', credit: 2115.54, tax_type: 'ALV_25_5_OUTPUT' }]);
});
