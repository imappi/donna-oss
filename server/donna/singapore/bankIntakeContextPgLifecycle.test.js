// Synthetic fixtures only. No authentic DBS/OCBC/UOB statement or live model
// accuracy claim: this proves the existing intake/persistence/request wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from '../firmDb.js';
import { rowToTransactionPayload } from '../db/transactions.js';
import { resolveClientCodingPolicyWithClient, withClientCodingPolicy } from '../db/coding.js';
import { __test__extractDocument } from '../inngest/parseDocument.js';
import { upsertParsedTransactionsInDb } from '../parseDocumentsDb.js';
import { suggestTransactionCoding, suggestTransactionCodingBatch } from '../transactionLlm.js';
import { codingPolicyReceipt, resolveCodingPolicy } from '../codingPolicy.js';

const response = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const verdict = { proposed_account: 'Marketing', tax_treatment: 'No GST', contact: 'Model-selected party',
  confidence: 'high', materiality: 'normal', evidence_required: false, posting_requirement: 'single_account',
  ask_client_question: '', support_note: '', reasoning: 'Synthetic provider choice, not inferred from the rail.',
  warnings: [], alternatives: [], remember_candidate: false, merchant_pattern: '', auto_explain_limit: 0 };
const keys = (t) => {
  for (const key of ['OPENAI_API_KEY', 'TYPESAFE_API_KEY', 'TYPESAFE_MODEL']) {
    const before = process.env[key]; process.env[key] = 'synthetic-no-network';
    t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
  }
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('External network forbidden'); });
};
const capture = () => {
  const calls = [];
  return { calls, fetchImpl: async (url, init) => {
    const request = JSON.parse(init.body); calls.push(request);
    if (String(url).includes('typesafe')) {
      return response({ model: 'synthetic-served', usage: { input_tokens: 1, output_tokens: 1 }, answers: Object.fromEntries(Object.entries(request.questions).map(([key, question]) => {
        const choices = Object.keys(question.criteria);
        const choice = key === 'decision'
          ? choices.find(k => question.criteria[k].includes('to Marketing, tax treatment No GST;')) || choices[0]
          : key === 'materiality' ? 'normal' : choices[0];
        assert.ok(choices.includes(choice));
        return [key, { type: 'choice', choice, confidence: 0.9,
          probabilities: Object.fromEntries(choices.map(k => [k, k === choice ? 0.9 : 0.1 / (choices.length - 1)])) }];
      })) });
    }
    assert.equal(String(url), 'https://api.openai.com/v1/responses');
    const input = JSON.parse(request.input);
    return response({ id: 'synthetic-response', model: 'synthetic-served', output_text: JSON.stringify(input.transactions
      ? { suggestions: input.transactions.map(tx => ({ transaction_id: tx.id, ...verdict })), group_summary: [] }
      : verdict) });
  } };
};
const line = { id: 'synthetic-line', date: '2026-09-01', description: 'Payment', money_out: 10, currency: 'SGD' };

test('country evidence is bounded text; forged hooks cannot override registered ownership or receipts', async (t) => {
  keys(t);
  const io = capture();
  const policy = resolveCodingPolicy({ jurisdiction: 'sg', businessDate: line.date });
  const before = codingPolicyReceipt(policy);
  const transaction = { ...line, reference: 'PAYNOW 201812345K', details: { instruction: 'GIRO-IRAS' },
    narrative: ['PAYNOW'], source_line: 123, structured_reference: 'x'.repeat(2001) };
  await suggestTransactionCoding({ clientProfile: { jurisdiction: 'sg', codingPolicy: { ...policy,
    bankLineContextFor: () => { throw new Error('untrusted hook'); } } }, transaction, fetchImpl: io.fetchImpl });
  const evidence = JSON.parse(io.calls[0].input).transaction.bank_rail_evidence;
  assert.equal(evidence.source.reference, transaction.reference);
  assert.equal(evidence.source.structured_reference.length, 2000);
  assert.deepEqual(evidence.source_truncated_fields, ['structured_reference']);
  assert.equal(evidence.source.details, undefined);
  assert.equal(evidence.source.narrative, undefined);
  assert.equal(evidence.source.source_line, undefined);
  assert.equal(evidence.hints.sg_rail_proxy, '201812345K');
  assert.deepEqual(codingPolicyReceipt(policy), before);
  assert.equal(JSON.stringify(before).includes('bankLine'), false);
});

test('non-SG request bytes stay identical with optional rail fields; unresolved/conflicting identity refuses before transport', async (t) => {
  keys(t);
  for (const jurisdiction of ['fi', 'gb', 'ae', 'us', 'au']) {
    for (const mode of ['single', 'batch', 'jev']) {
      const io = capture();
      const run = transaction => mode === 'batch'
        ? suggestTransactionCodingBatch({ clientProfile: { jurisdiction }, transactions: [transaction], fetchImpl: io.fetchImpl })
        : suggestTransactionCoding({ clientProfile: { jurisdiction }, transaction, jevEnabled: mode === 'jev', fetchImpl: io.fetchImpl });
      // Jev already forwards reference in the established input contract.
      await run(mode === 'jev' ? { ...line, reference: 'PAYNOW 201812345K' } : line);
      await run({ ...line, reference: 'PAYNOW 201812345K', narrative: 'GIRO-IRAS', details: 'FAST', structured_reference: 'PAYNOW +65 9123 4567' });
      assert.equal(JSON.stringify(io.calls[1]), JSON.stringify(io.calls[0]), jurisdiction);
      assert.equal(JSON.stringify(io.calls).includes('bank_rail_evidence'), false);
    }
  }
  for (const clientProfile of [{}, { jurisdiction: 'sg', profileJurisdiction: 'gb' },
    { jurisdiction: 'sg', entityType: 'fi-oy' }, { jurisdiction: null, profile: { jurisdiction: 'sg' } }]) {
    const io = capture();
    await assert.rejects(suggestTransactionCoding({ clientProfile, transaction: { ...line, reference: 'PAYNOW' }, fetchImpl: io.fetchImpl }),
      error => ['jurisdiction_unresolved', 'jurisdiction_context_conflict'].includes(error.code));
    await assert.rejects(suggestTransactionCodingBatch({ clientProfile, transactions: [line], fetchImpl: io.fetchImpl }));
    assert.equal(io.calls.length, 0);
  }
});

test('real PG: generic intake and canonical persisted evidence reach batch, single and Jev classifier requests', async (t) => {
  assert.ok(process.env.DONNA_PG_TEST_URL, 'INCOMPLETE: DONNA_PG_TEST_URL missing; real persisted bank intake not exercised');
  keys(t);
  const dbName = `donna_sg5_${process.pid}_${Date.now().toString(36)}`;
  const admin = new pg.Client({ connectionString: process.env.DONNA_PG_TEST_URL });
  await admin.connect(); await admin.query(`create database "${dbName}"`);
  const url = new URL(process.env.DONNA_PG_TEST_URL); url.pathname = `/${dbName}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  const closed = [];
  pool.on('connect', connection => closed.push(new Promise(resolve => connection.once('end', resolve))));
  __setFirmDbPoolForTests(pool);
  t.after(async () => {
    __resetFirmDbPoolForTests(); await pool.end(); await Promise.all(closed);
    await admin.query(`drop database "${dbName}"`); await admin.end();
  });
  await pool.query(`create schema storage;
    create table storage.buckets (id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb);`);
  const migrations = new URL('../../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(f => f.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(file, migrations), 'utf8'));
  }
  const firmId = 'synthetic-sg5-firm', clientId = 'synthetic-sg5-client', documentId = 'synthetic-sg5-statement';
  await pool.query("insert into firms(id,name,slug) values($1,'Synthetic bank context',$1)", [firmId]);
  await pool.query("insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile) values($1,$2,'Synthetic SG entity','SG','sg-pte','{}')", [clientId, firmId]);
  await pool.query("insert into documents(id,firm_id,client_id,filename,document_type) values($1,$2,$3,'synthetic.csv','bank_statement')", [documentId, firmId, clientId]);
  const extracted = await __test__extractDocument({ document: { id: documentId, client_id: clientId,
    filename: 'synthetic.csv', document_type: 'bank_statement', payload: { mime_type: 'text/csv' } },
    bytes: Buffer.from('Date,Description,Debit,Credit,Balance,Currency\n01/09/2026,PAYNOW 201812345K,10,,90,SGD'),
    clientIdentity: { jurisdiction: 'sg', ledger_currency: 'SGD' }, ledgerCurrency: 'SGD' });
  assert.equal(extracted.kind, 'completed');
  assert.equal(extracted.transactions.length, 1);
  // Optional-field rows are explicit synthetic extractor-shaped inputs, not
  // a claim that the CSV/PDF parser extracted these separate fields.
  const optional = [
    ['mobile', { reference: 'PayNow +65 9123 4567' }],
    ['giro', { narrative: 'GIRO-IRAS' }],
    ['fast', { details: 'FAST TRANSFER' }],
    ['unknown', {}],
    ['structured', { structured_reference: 'stale PAYNOW 53012345A' }],
    ['raw', { raw_description: 'PAYNOW 201812345K' }],
    ['source', { source_line: 'PAYNOW +65 9123 4567' }]
  ].map(([id, fields]) => ({ ...line, id, ...fields }));
  const transactions = [...extracted.transactions, ...optional];
  assert.deepEqual(await upsertParsedTransactionsInDb({ firmId, clientId, documentId, transactions }), { written: 8, skipped: 0 });
  // Migration 098's canonical column, deliberately different from payload.
  await pool.query("update transactions set structured_reference='PAYNOW 201812345K' where id='structured'");
  const persisted = (await pool.query('select * from transactions order by id')).rows;
  const rows = persisted.map(rowToTransactionPayload);
  const policy = await resolveClientCodingPolicyWithClient({ client: pool, firmId, clientId });
  const clientProfile = withClientCodingPolicy({ companyName: 'Synthetic SG entity' }, policy);
  const io = capture();
  const batch = await suggestTransactionCodingBatch({ clientProfile, transactions: rows, fetchImpl: io.fetchImpl });
  assert.equal(batch.suggestions.length, 8);
  assert.ok(batch.suggestions.every(s => s.proposed_account === 'Marketing' && s.tax_treatment === 'No GST'));
  const inputs = JSON.parse(io.calls[0].input).transactions;
  for (const tx of inputs) {
    const row = rows.find(r => r.id === tx.id);
    const source = tx.bank_rail_evidence.source;
    for (const field of ['description', 'raw_description', 'reference', 'narrative', 'details', 'structured_reference', 'source_line']) {
      if (typeof row[field] === 'string') assert.equal(source[field], row[field], `${tx.id}.${field}`);
    }
    assert.equal(tx.money_in, row.money_in); assert.equal(tx.money_out, row.money_out);
    assert.match(tx.bank_rail_evidence.interpretation, /do not establish counterparty identity/);
  }
  const hints = id => inputs.find(tx => tx.id === id).bank_rail_evidence.hints;
  assert.equal(hints(extracted.transactions[0].id).sg_rail_proxy, '201812345K');
  assert.equal(hints('mobile').sg_rail_proxy, '6591234567');
  assert.equal(hints('giro').sg_rail_counterparty_hint, 'IRAS');
  assert.equal(hints('fast').sg_rail, 'fast');
  assert.deepEqual(hints('unknown'), {});
  assert.equal(hints('structured').sg_rail_proxy, '201812345K');
  assert.equal(hints('raw').sg_rail, 'paynow'); assert.equal(hints('source').sg_rail, 'paynow');
  const structured = rows.find(row => row.id === 'structured');
  await suggestTransactionCoding({ clientProfile, transaction: structured, fetchImpl: io.fetchImpl });
  const singleEvidence = JSON.parse(io.calls[1].input).transaction.bank_rail_evidence;
  assert.deepEqual(singleEvidence, inputs.find(tx => tx.id === 'structured').bank_rail_evidence);
  const jev = await suggestTransactionCoding({ clientProfile, transaction: structured, jevEnabled: true, fetchImpl: io.fetchImpl });
  assert.equal(jev.proposed_account, 'Marketing', JSON.stringify(jev)); assert.equal(jev.tax_treatment, 'No GST');
  assert.deepEqual(io.calls[2].state.transaction.bank_rail_evidence, singleEvidence);
  assert.deepEqual((await pool.query('select * from transactions order by id')).rows, persisted, 'context/model calls never rewrite source rows');
  assert.equal((await pool.query('select count(*)::int as n from ledger_journals')).rows[0].n, 0);
  await pool.query("update transactions set structured_reference=null where id='structured'");
  const cleared = rowToTransactionPayload((await pool.query("select * from transactions where id='structured'")).rows[0]);
  assert.equal(cleared.structured_reference, null);
  await suggestTransactionCoding({ clientProfile, transaction: cleared, fetchImpl: io.fetchImpl });
  assert.deepEqual(JSON.parse(io.calls.at(-1).input).transaction.bank_rail_evidence.hints, {});
  assert.equal(rowToTransactionPayload({ payload: { structured_reference: 'legacy' } }).structured_reference, 'legacy');
  for (const [country, profile, entity, expected] of [
    [null, {}, null, 'jurisdiction_unresolved'], ['SG', { jurisdiction: 'gb' }, 'sg-pte', 'jurisdiction_context_conflict'],
    ['SG', {}, 'fi-oy', 'jurisdiction_context_conflict']
  ]) {
    await pool.query('update clients set jurisdiction=$1, profile=$2, entity_type=$3 where id=$4', [country, profile, entity, clientId]);
    await assert.rejects(resolveClientCodingPolicyWithClient({ client: pool, firmId, clientId }), { code: expected });
  }
});
