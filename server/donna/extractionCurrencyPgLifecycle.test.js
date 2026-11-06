// Current evidence passes the actual worker extraction dispatcher and named
// transaction writer on disposable PostgreSQL. No provider or live book is used.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from './firmDb.js';
import { getExtractionContextInDb } from './extractionContextDb.js';
import { __test__extractDocument } from './inngest/parseDocument.js';
import { upsertParsedTransactionsInDb, markParseCompletedInDb } from './parseDocumentsDb.js';
import { settleCommittedConvergenceMarks } from './reconcileConvergenceState.js';
import { rowToTransactionPayload } from './db/transactions.js';
import { rowToDocumentPayload } from './db/documents.js';
import { getFeedChatRowsFromDb, getFeedChatAgreementDocsFromDb } from './db/snapshot.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;

test('real PG: current extraction keeps document currency separate from persisted identity through initial write and reparse', {
  skip: pgUrl ? false : 'DONNA_PG_TEST_URL not set — disposable extraction lifecycle not exercised'
}, async (t) => {
  const name = `donna_jn_extract_${Date.now().toString(36)}_${process.pid}`;
  const admin = new pg.Client({ connectionString: pgUrl });
  await admin.connect();
  await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  const connectionsClosed = [];
  pool.on('connect', (connection) => connectionsClosed.push(new Promise((resolve) => connection.once('end', resolve))));
  __setFirmDbPoolForTests(pool);
  t.after(async () => {
    __resetFirmDbPoolForTests();
    await pool.end();
    await Promise.all(connectionsClosed);
    await admin.query(`drop database "${name}"`);
    await admin.end();
  });
  let providerResponse = null;
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.ok(providerResponse, 'no provider invocation during deterministic extraction');
    return { ok: true, json: async () => ({ output: [{ content: [{ text: JSON.stringify(providerResponse) }] }] }) };
  });
  await pool.query(`create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb);`);
  const migrationRoot = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrationRoot)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(file, migrationRoot), 'utf8'));
  }
  const firmId = 'jn-extraction-firm';
  await pool.query("insert into firms (id,name,slug,jurisdiction) values ($1,'Extraction fixture','jn-extraction-firm','sg')", [firmId]);
  const fixtures = [
    ['sg', 'SGD'], ['fi', 'EUR'], ['gb', 'GBP'], ['ae', 'AED'], ['us', 'USD'], ['au', 'AUD'],
    ['nz', 'NZD'], [null, null]
  ];
  for (const [country, bookCurrency] of fixtures) {
    const clientId = `client-${country || 'missing'}`;
    const documentId = `doc-${clientId}`;
    await pool.query(`insert into clients (id,firm_id,company_name,jurisdiction,profile)
      values ($1,$2,'Extraction fixture',$3,$4::jsonb)`,
    [clientId, firmId, country, JSON.stringify({ ...(country ? { jurisdiction: country } : {}), ...(bookCurrency ? { accountingCurrency: bookCurrency } : {}) })]);
    await pool.query(`insert into documents (id,firm_id,client_id,filename,document_type)
      values ($1,$2,$3,'statement_SGD.csv','bank_statement')`, [documentId, firmId, clientId]);
    const document = { id: documentId, client_id: clientId, filename: 'statement_SGD.csv', document_type: 'bank_statement', payload: { mime_type: 'text/csv' } };
    const context = await getExtractionContextInDb({ firmId, clientId });
    assert.equal(context.jurisdiction, country, 'firm SG jurisdiction is not entity identity');
    assert.equal(context.ledger_currency || null, bookCurrency);
    const extract = (currency) => __test__extractDocument({
      document,
      bytes: Buffer.from(`Date,Description,Debit,Credit,Balance${currency ? ',Currency' : ''}\n01/09/2026,Service,10,,90${currency ? `,${currency}` : ''}`),
      clientIdentity: context,
      ledgerCurrency: context.ledger_currency
    });
    const first = await extract('CAD');
    assert.equal(first.kind, 'completed', JSON.stringify(first));
    assert.equal(first.summary.currency_resolution.currency, 'CAD');
    assert.deepEqual(first.summary.currency_resolution.filename_candidates, ['SGD']);
    const write = (extraction) => upsertParsedTransactionsInDb({ firmId, clientId, documentId, transactions: extraction.transactions });
    assert.deepEqual(await write(first), { written: 1, skipped: 0 });
    const transactionId = first.transactions[0].id;
    const read = async () => (await pool.query('select * from transactions where id=$1', [transactionId])).rows[0];
    let stored = await read();
    assert.equal(stored.currency, 'CAD');
    assert.equal(stored.payload.currency_resolution.ledger_currency, bookCurrency);
    assert.equal(stored.payload.account_currency, 'CAD');
    assert.equal(stored.payload.ledger_currency || null, bookCurrency);

    // Reparse an eligible row with genuinely absent printed currency. The
    // currency column and its payload receipt must change together, including
    // explicit nulls; a historical filename is only candidate provenance.
    const unknown = await extract(null);
    assert.equal(unknown.kind, 'completed', JSON.stringify(unknown));
    assert.equal(unknown.summary.currency_resolution.currency, null);
    assert.deepEqual(await write(unknown), { written: 1, skipped: 0 });
    stored = await read();
    assert.equal(stored.currency, null);
    assert.equal(stored.payload.currency, null);
    assert.equal(stored.payload.currency_resolution.currency, null);
    assert.equal(stored.payload.account_currency || null, null);
    assert.equal(stored.payload.ledger_conversion_status || null, null);
    assert.equal(stored.payload.currency_resolution.ledger_currency, bookCurrency);

    await pool.query("update transactions set status='posted', coding_state='posted' where id=$1", [transactionId]);
    const connection = await pool.connect();
    try { await settleCommittedConvergenceMarks(connection); } finally { connection.release(); }
    const postedBefore = await read();
    assert.deepEqual(await write(first), { written: 0, skipped: 1 });
    assert.deepEqual(await read(), postedBefore, 'posted rows remain byte-for-byte unchanged');
    const identity = (await pool.query('select jurisdiction,profile from clients where id=$1', [clientId])).rows[0];
    assert.equal(identity.jurisdiction, country, 'printed CAD does not change legal identity');
  }

  // Historical unreceipted rows remain readable, but their raw old candidates
  // cannot replace a persisted correction (including a canonical null). Drive
  // the real mounted feed readers without reparsing or manufacturing receipts.
  for (const country of ['sg', 'fi', 'gb', 'ae', 'us', 'au']) {
    for (const currency of [null, 'CAD']) {
      const id = `legacy-${country}-${currency || 'unknown'}`;
      const raw = { currency: 'SGD', account_currency: 'SGD', source_line: 'raw historical evidence',
        ai_suggestion: { proposed_account: 'Historical account', confidence: 'high' } };
      await pool.query(`insert into documents (id,firm_id,client_id,filename,document_type,currency,payload,parse_summary)
        values ($1,$2,$3,'historical_SGD.pdf','contract',$4,$5::jsonb,'{"obligations":[{"kind":"historical"}]}')`,
      [id, firmId, `client-${country}`, currency, JSON.stringify(raw)]);
      await pool.query(`insert into transactions (id,firm_id,client_id,document_id,transaction_date,money_out,currency,status,coding_state,payload)
        values ($1,$2,$3,$1,'2025-06-01',10,$4,'posted','posted',$5::jsonb)`,
      [id, firmId, `client-${country}`, currency, JSON.stringify(raw)]);
      const settled = await pool.connect();
      try { await settleCommittedConvergenceMarks(settled); } finally { settled.release(); }
      const before = (await pool.query('select * from transactions where id=$1', [id])).rows[0];
      const docBefore = (await pool.query('select * from documents where id=$1', [id])).rows[0];
      for (let replay = 0; replay < 2; replay += 1) {
        const mounted = (await getFeedChatRowsFromDb({ firmId, clientId: `client-${country}` })).rows.find((row) => row.id === id);
        assert.equal(mounted.currency, currency);
        assert.equal(mounted.account_currency, currency);
        assert.equal(mounted.currency_resolution, undefined, 'readers do not invent a historical extraction receipt');
        assert.deepEqual(mounted.ai_suggestion, raw.ai_suggestion);
        const document = (await getFeedChatAgreementDocsFromDb({ firmId, clientId: `client-${country}` })).find((row) => row.id === id);
        assert.equal(document.currency, currency);
        assert.equal(document.parse_summary.currency_resolution, undefined);
      }
      assert.deepEqual((await pool.query('select * from transactions where id=$1', [id])).rows[0], before);
      assert.deepEqual((await pool.query('select * from documents where id=$1', [id])).rows[0], docBefore);
    }
  }
  // Payload-only partial rows retain their original explicit historical value;
  // this does not supply a country, model receipt, filename inference or default.
  assert.equal(rowToTransactionPayload({ payload: { currency: 'USD' } }).currency, 'USD');
  assert.equal(rowToDocumentPayload({ payload: { currency: 'USD' } }).currency, 'USD');

  // Unlike CSV, the structured parser carries a model row's currency field.
  // Conflicting printed/header evidence must remain unknown through the SQL
  // writer AND the live transaction projection, while preserving that candidate.
  await pool.query(`insert into documents (id,firm_id,client_id,filename,document_type)
    values ('doc-structured',$1,'client-gb','statement.txt','bank_statement')`, [firmId]);
  const keyBefore = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'offline-extraction-fixture';
  t.after(() => { if (keyBefore === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = keyBefore; });
  providerResponse = {
    transactions: [{ date: '2026-09-01', description: 'Service', counterparty: 'Vendor', payment_method: null,
      message: null, reference: null, direction: 'out', amount: 10, currency: 'USD', balance: 90 }],
    statement_summary: { opening_balance: 100, closing_balance: 90, total_deposits: 0, total_payouts: 10,
      currency: 'USD', period_start: '2026-09-01', period_end: '2026-09-30', account_identifier: 'FX-FIXTURE' }
  };
  const structured = await __test__extractDocument({
    document: { id: 'doc-structured', client_id: 'client-gb', filename: 'statement.txt', document_type: 'bank_statement', payload: { mime_type: 'text/plain' } },
    bytes: Buffer.from('Account currency: EUR\nStatement September 2026\n01/09/2026 Service 10.00 90.00'),
    ledgerCurrency: 'GBP', configSnapshot: { BANK_STATEMENT_LLM_EXTRACTION: { stage: 'canary', source: 'client' } }
  });
  assert.equal(structured.kind, 'completed', JSON.stringify(structured));
  assert.equal(structured.summary.currency_resolution.currency, null);
  assert.equal(structured.transactions[0].currency_resolution.row_candidate, 'USD');
  assert.equal(structured.transactions[0].money_out, 10);
  await upsertParsedTransactionsInDb({ firmId, clientId: 'client-gb', documentId: 'doc-structured', transactions: structured.transactions });
  const structuredRow = (await pool.query('select * from transactions where document_id=$1', ['doc-structured'])).rows[0];
  assert.equal(structuredRow.currency, null);
  const projected = rowToTransactionPayload(structuredRow);
  assert.equal(projected.account_currency, null);
  assert.equal(projected.currency, null);
  assert.equal(projected.currency_resolution.row_candidate, 'USD');
  // Historical/current payload shapes can still retain a raw currency candidate;
  // the explicit unresolved receipt outranks it, while a persisted correction wins.
  assert.equal(rowToTransactionPayload({ ...structuredRow, payload: { ...structuredRow.payload, currency: 'USD' } }).account_currency, null);
  assert.equal(rowToTransactionPayload({ ...structuredRow, currency: 'CAD' }).account_currency, 'CAD');
  assert.equal(rowToTransactionPayload({ ...structuredRow, currency: null, payload: { currency_resolution: { currency: 'USD' } } }).account_currency, null,
    'explicit canonical clear outranks an earlier extraction receipt');

  const parseRunId = 'd26ad69b-c791-4913-b087-c11d142b89ca';
  await pool.query(`update documents set parse_run_id=$1, parse_status='processing',
    currency='SGD', payload=payload || '{"currency":"SGD"}'::jsonb where id='doc-structured'`, [parseRunId]);
  await markParseCompletedInDb({ firmId, documentId: 'doc-structured', parseRunId, summary: structured.summary, payloadPatch: structured.payloadPatch });
  const completedDocument = (await pool.query("select * from documents where id='doc-structured'")).rows[0];
  assert.equal(completedDocument.currency, null, 'current statement completion clears the old header currency');
  assert.equal(completedDocument.payload.currency, null);
  assert.equal(rowToDocumentPayload(completedDocument).currency, null);
  assert.equal(rowToDocumentPayload({ ...completedDocument, document_type: 'receipt', payload: { currency: 'SGD' } }).currency, null,
    'receipt/unified unknown currency never revives legacy payload currency');
  assert.equal(rowToDocumentPayload({ ...completedDocument, currency: 'CAD' }).currency, 'CAD', 'later canonical correction stays authoritative');
  assert.equal(rowToDocumentPayload({ currency: null, parse_summary: { currency_resolution: { currency: 'USD' } } }).currency, null,
    'explicit document currency clear outranks an earlier extraction receipt');
  assert.equal(rowToDocumentPayload({ currency: null, payload: { currency: 'SGD' } }).currency, null, 'canonical null also outranks unreceipted historical candidates');
  await pool.query("update documents set currency='CAD' where id='doc-structured'");
  const correctedDocument = (await pool.query("select * from documents where id='doc-structured'")).rows[0];
  const completionAudits = async () => (await pool.query("select * from audit_events where resource_id='doc-structured' and action='document.parse.completed' order by id")).rows;
  const auditBeforeReplay = await completionAudits();
  assert.equal(await markParseCompletedInDb({ firmId, documentId: 'doc-structured', parseRunId, summary: structured.summary, payloadPatch: structured.payloadPatch }), null);
  assert.deepEqual((await pool.query("select * from documents where id='doc-structured'")).rows[0], correctedDocument,
    'duplicate completion cannot overwrite a later correction');
  assert.deepEqual(await completionAudits(), auditBeforeReplay);

  await pool.query("update clients set profile=profile || '{\"jurisdiction\":\"gb\"}'::jsonb where id='client-ae'");
  const conflict = await getExtractionContextInDb({ firmId, clientId: 'client-ae' });
  assert.equal(conflict.jurisdiction, null);
  assert.equal(conflict.jurisdiction_status, 'jurisdiction_context_conflict');
  assert.equal(conflict.ledger_currency, 'AED', 'explicit currency stays a separate fact');
  const absent = await getExtractionContextInDb({ firmId: 'different-firm', clientId: 'client-ae' });
  assert.equal(absent.id, null, 'persisted entity context is scoped to the firm');
  assert.equal(absent.jurisdiction, null);
  assert.equal((await pool.query('select count(*)::int as n from ledger_journals')).rows[0].n, 0);
});
