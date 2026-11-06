import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from './db/pool.js';
import { postLedgerAdjustmentInDb, postDocumentSettlementJournalWithClient, upsertLedgerAccountForJournal } from './db/ledger.js';
import { runDocumentSettlementEntriesForClient } from './documentSettlementEntry.js';
import { recordDocumentCorrectionInDb } from './documentCorrections.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;

test('real PG: auxiliary journal currency follows source evidence, correction lineage and write-time locks', {
  skip: pgUrl ? false : 'DONNA_PG_TEST_URL not set — journal currency lifecycle proof incomplete'
}, async (t) => {
  const name = `donna_jn_currency_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: pgUrl });
  await admin.connect();
  await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  const closed = [];
  pool.on('connect', (connection) => closed.push(new Promise((resolve) => connection.once('end', resolve))));
  __setFirmDbPoolForTests(pool);
  t.after(async () => {
    __resetFirmDbPoolForTests();
    await pool.end();
    await Promise.all(closed);
    await admin.query(`drop database "${name}"`);
    await admin.end();
  });
  let providerCalls = 0;
  let mockProvider = null;
  t.mock.method(globalThis, 'fetch', async (...args) => {
    if (mockProvider) return mockProvider(...args);
    providerCalls += 1;
    throw new Error('Journal currency proofs must not call a provider');
  });
  await pool.query(`create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb);`);
  const migrations = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(file, migrations), 'utf8'));
  }
  const firmId = 'journal-currency-firm';
  const actorId = 'journal-currency-owner';
  await pool.query("insert into firms (id,name,slug) values ($1,'Currency fixture','journal-currency')", [firmId]);
  const seedClient = async (clientId) => {
    // Legacy unenrolled clients remain a supported population. The explicit
    // GBP book is context, never evidence of an absent document denomination.
    await pool.query(`insert into clients (id,firm_id,company_name,jurisdiction,profile)
      values ($1,$2,'Currency fixture','GB','{"jurisdiction":"GB","defaultCurrency":"GBP","accounting_system":"none"}')`, [clientId, firmId]);
  };
  const effects = async (clientId) => {
    const rows = {};
    for (const table of ['ledger_accounts', 'ledger_journals', 'ledger_lines', 'audit_events']) {
      rows[table] = (await pool.query(`select * from ${table} where firm_id=$1 and client_id=$2 order by id`, [firmId, clientId])).rows;
    }
    return rows;
  };
  const journal = async (id) => ({
    header: (await pool.query('select * from ledger_journals where id=$1', [id])).rows[0],
    lines: (await pool.query('select * from ledger_lines where journal_id=$1 order by line_no', [id])).rows
  });
  const checkCurrency = async (id, currency) => {
    const stored = await journal(id);
    assert.equal(stored.header.currency, currency);
    assert.equal(stored.header.status, 'posted');
    assert.equal(stored.lines.length, 2);
    assert.ok(stored.lines.every((line) => line.currency === currency));
    assert.equal(stored.lines.reduce((sum, line) => sum + Number(line.debit) - Number(line.credit), 0), 0);
    return stored;
  };
  const lines = (currency, creditCurrency = currency) => [
    { account_code: 'CUR-EXP', account_name: 'Currency expense', account_type: 'expense', debit: 10, ...(currency === undefined ? {} : { currency }) },
    { account_code: 'CUR-EQUITY', account_name: 'Owner funds', account_type: 'equity', credit: 10, ...(creditCurrency === undefined ? {} : { currency: creditCurrency }) }
  ];
  const adjustment = (clientId, patch = {}) => postLedgerAdjustmentInDb({
    firmId, clientId, journalDate: '2026-09-05', reason: 'Owner confirmed denomination',
    reverseOriginal: false, actorId, ...patch
  });
  const seedDocument = async (clientId, id, currency, documentDate = '2026-09-05') => {
    await pool.query(`insert into documents (id,firm_id,client_id,filename,document_type,document_date,total_amount,currency,payment_status,payload)
      values ($1,$2,$3,'source.pdf','receipt',$4,10,$5,'unpaid','{"currency":"USD","historical_note":"preserve source evidence"}')`,
    [id, firmId, clientId, documentDate, currency]);
    return (await pool.query('select * from documents where id=$1', [id])).rows[0];
  };
  const settlement = async (clientId, document) => {
    const connection = await pool.connect();
    try {
      await connection.query('begin');
      await connection.query("set local statement_timeout='3s'");
      const result = await postDocumentSettlementJournalWithClient({
        client: connection, firmId, clientId, document,
        expenseAccount: { code: 'CUR-EXP', name: 'Currency expense', type: 'expense' },
        ownerFundsAccount: { code: 'CUR-OWNER', name: 'Owner funds', type: 'liability' },
        settlement: { settlement_channel: 'personal_card', verdict_source: 'owner_reply' },
        authorityBasis: 'owner_reply', actorId
      });
      await connection.query('commit');
      return result;
    } catch (error) {
      await connection.query('rollback');
      throw error;
    } finally { connection.release(); }
  };

  await t.test('manual adjustment refuses absent, explicit null and mixed denomination without any ledger effects', async () => {
    const clientId = 'currency-manual-refusal';
    await seedClient(clientId);
    const before = await effects(clientId);
    for (const proposed of [lines(undefined), lines(null), lines('GBP', null), ...['UNK', 'XXX', 'ABC', 'VEF'].map((currency) => lines(currency))]) {
      await assert.rejects(adjustment(clientId, { lines: proposed }), { code: 'LEDGER_CURRENCY_UNRESOLVED', statusCode: 409 });
      assert.deepEqual(await effects(clientId), before);
    }
    await assert.rejects(adjustment(clientId, { lines: lines('GBP', 'CAD') }), { code: 'LEDGER_CURRENCY_CONFLICT', statusCode: 409 });
    assert.deepEqual(await effects(clientId), before);
    for (const currency of ['GBP', 'CAD']) {
      const result = await adjustment(clientId, { lines: lines(currency) });
      const stored = await checkCurrency(result.ledger_adjustment.journals[0].ledger_journal_id, currency);
      assert.equal(stored.header.payload.actor_id, actorId);
    }
  });

  await t.test('corrections inherit original denomination; a CAD replacement reverses GBP without rewriting human history', async () => {
    const clientId = 'currency-correction';
    await seedClient(clientId);
    const originalId = (await adjustment(clientId, { lines: lines('GBP') })).ledger_adjustment.journals[0].ledger_journal_id;
    const original = await journal(originalId);
    const originalAudit = (await pool.query('select * from audit_events where resource_id=$1 order by id', [originalId])).rows;
    const before = await effects(clientId);
    await assert.rejects(adjustment(clientId, { originalJournalId: originalId, lines: lines(null), reverseOriginal: true }), { code: 'LEDGER_CURRENCY_UNRESOLVED' });
    assert.deepEqual(await effects(clientId), before, 'a refused replacement must not leave its reversal posted');
    const inherited = await adjustment(clientId, { originalJournalId: originalId, lines: lines(undefined) });
    await checkCurrency(inherited.ledger_adjustment.journals[0].ledger_journal_id, 'GBP');
    const replacement = await adjustment(clientId, { originalJournalId: originalId, lines: lines('CAD'), reverseOriginal: true });
    assert.equal(replacement.ledger_adjustment.journals.length, 2);
    const reversalReceipt = replacement.ledger_adjustment.journals.find((row) => row.correction_type === 'reversal');
    const replacementReceipt = replacement.ledger_adjustment.journals.find((row) => row.correction_type === 'replacement');
    const reversed = await checkCurrency(reversalReceipt.ledger_journal_id, 'GBP');
    const replaced = await checkCurrency(replacementReceipt.ledger_journal_id, 'CAD');
    assert.equal(reversed.header.reversal_of_journal_id, originalId);
    assert.equal(replaced.header.correction_of_journal_id, originalId);
    for (let i = 0; i < original.lines.length; i += 1) {
      assert.equal(reversed.lines[i].debit, original.lines[i].credit);
      assert.equal(reversed.lines[i].credit, original.lines[i].debit);
    }
    assert.deepEqual(await journal(originalId), original);
    assert.deepEqual((await pool.query('select * from audit_events where resource_id=$1 order by id', [originalId])).rows, originalAudit);
  });

  await t.test('retained withdrawn currency remains reversible and inheritable without permitting a new manual denomination', async () => {
    const clientId = 'currency-retained-history';
    await seedClient(clientId);
    const originalId = (await adjustment(clientId, { lines: lines('GBP') })).ledger_adjustment.journals[0].ledger_journal_id;
    // Historical fixture only: model a journal written while VEF was current.
    // Production corrections below must leave every original byte unchanged.
    assert.equal(Intl.supportedValuesOf('currency').includes('VEF'), false);
    await pool.query("update ledger_journals set currency='VEF' where id=$1", [originalId]);
    await pool.query("update ledger_lines set currency='VEF' where journal_id=$1", [originalId]);
    const original = await journal(originalId);
    const originalAudit = (await pool.query('select * from audit_events where resource_id=$1 order by id', [originalId])).rows;
    const reversed = await adjustment(clientId, { originalJournalId: originalId, reverseOriginal: true, lines: [] });
    assert.equal(reversed.ledger_adjustment.journals.length, 1);
    const reversal = await checkCurrency(reversed.ledger_adjustment.journals[0].ledger_journal_id, 'VEF');
    assert.equal(reversal.header.reversal_of_journal_id, originalId);
    for (let i = 0; i < original.lines.length; i += 1) {
      assert.equal(reversal.lines[i].debit, original.lines[i].credit);
      assert.equal(reversal.lines[i].credit, original.lines[i].debit);
    }
    const inherited = await adjustment(clientId, { originalJournalId: originalId, reverseOriginal: false, lines: lines(undefined) });
    const replacement = await checkCurrency(inherited.ledger_adjustment.journals[0].ledger_journal_id, 'VEF');
    assert.equal(replacement.header.correction_of_journal_id, originalId);
    assert.deepEqual(await journal(originalId), original);
    assert.deepEqual((await pool.query('select * from audit_events where resource_id=$1 order by id', [originalId])).rows, originalAudit);
  });

  await t.test('settlement rereads canonical currency and refuses stale caller values before document or ledger effects', async () => {
    const clientId = 'currency-settlement-refusal';
    await seedClient(clientId);
    const unknown = await seedDocument(clientId, 'currency-unknown-doc', null);
    const explicit = await seedDocument(clientId, 'currency-explicit-doc', 'GBP');
    const before = await effects(clientId);
    for (const callerCurrency of [undefined, null, 'USD']) {
      const caller = { ...unknown, currency: callerCurrency };
      if (callerCurrency === undefined) delete caller.currency;
      await assert.rejects(settlement(clientId, caller), { code: 'LEDGER_CURRENCY_UNRESOLVED', statusCode: 409 });
      assert.deepEqual(await effects(clientId), before);
      assert.deepEqual((await pool.query('select * from documents where id=$1', [unknown.id])).rows[0], unknown);
    }
    await assert.rejects(settlement(clientId, { ...explicit, currency: 'USD' }), { code: 'LEDGER_CURRENCY_CONFLICT', statusCode: 409 });
    assert.deepEqual(await effects(clientId), before);
    assert.deepEqual((await pool.query('select * from documents where id=$1', [explicit.id])).rows[0], explicit);
    for (const currency of ['UNK', 'XXX', 'ABC', 'VEF']) {
      const document = await seedDocument(clientId, `currency-invalid-${currency}`, currency);
      await assert.rejects(settlement(clientId, document), { code: 'LEDGER_CURRENCY_UNRESOLVED', statusCode: 409 });
      assert.deepEqual(await effects(clientId), before);
      assert.deepEqual((await pool.query('select * from documents where id=$1', [document.id])).rows[0], document);
    }
    for (const currency of ['GBP', 'CAD']) {
      const document = await seedDocument(clientId, `currency-healthy-${currency}`, currency);
      const result = await settlement(clientId, document);
      await checkCurrency(result.journal_id, currency);
      const stored = (await pool.query('select * from documents where id=$1', [document.id])).rows[0];
      assert.equal(stored.payment_status, 'paid');
      assert.equal(stored.payload.settlement_entry.currency, currency);
      assert.equal(stored.payload.settlement_entry.authority_basis, 'owner_reply');
      assert.equal(stored.payload.historical_note, 'preserve source evidence');
      const receipt = (await pool.query('select * from audit_events where id=$1', [result.audit_event_id])).rows[0];
      assert.equal(receipt.actor_id, actorId);
      assert.equal(receipt.metadata.currency, currency);
    }
  });

  await t.test('settlement yields before effects while a currency correction owns the source, then retries against committed currency', async () => {
    const clientId = 'currency-settlement-race';
    await seedClient(clientId);
    const stale = await seedDocument(clientId, 'currency-race-doc', 'GBP');
    const before = await effects(clientId);
    const correction = await pool.connect();
    try {
      await correction.query('begin');
      await correction.query("update documents set currency='CAD' where id=$1", [stale.id]);
      await assert.rejects(settlement(clientId, stale), { code: '55P03' });
      assert.deepEqual(await effects(clientId), before);
      await correction.query('commit');
    } catch (error) {
      await correction.query('rollback');
      throw error;
    } finally { correction.release(); }
    await assert.rejects(settlement(clientId, stale), { code: 'LEDGER_CURRENCY_CONFLICT' });
    assert.deepEqual(await effects(clientId), before);
    const corrected = (await pool.query('select * from documents where id=$1', [stale.id])).rows[0];
    const result = await settlement(clientId, corrected);
    await checkCurrency(result.journal_id, 'CAD');
  });

  await t.test('actual currency correction drains a refused settlement into a fresh applied proposal without changing the original failed checks', async () => {
    const savedEnv = Object.fromEntries(['ANTHROPIC_API_KEY', 'LOOPS_TIER'].map((key) => [key, process.env[key]]));
    process.env.ANTHROPIC_API_KEY = 'offline-settlement-currency-test';
    process.env.LOOPS_TIER = 'off';
    const requests = [];
    mockProvider = async (url, options) => {
      assert.equal(url, 'https://api.anthropic.com/v1/messages');
      const body = JSON.parse(options.body);
      requests.push(body);
      assert.match(String(body.system), /You code ONE expense document/);
      const result = { account: 'Currency expense', confidence: 0.95, reasoning: 'Owner-paid business supplies.' };
      return { ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify(result) }] }) };
    };
    const clientId = 'currency-producer-repair';
    try {
      await seedClient(clientId);
      const document = await seedDocument(clientId, 'currency-producer-document', null);
      await pool.query(`update documents set parse_status='completed', payload=payload || $2::jsonb where id=$1`,
      [document.id, JSON.stringify({ no_line_disposition: {
        disposition: 'auto_explain', materiality: 'immaterial', expense_kind: 'supplies',
        settlement_channel: 'personal_card', confidence: 0.95, verdict_source: 'owner_reply', owner_notified: true
      } })]);
      await upsertLedgerAccountForJournal({ client: pool, firmId, clientId,
        account: { code: 'CUR-EXP', name: 'Currency expense', type: 'expense' }, currency: 'GBP' });
      await pool.query(`insert into client_capability_config (id,firm_id,client_id,flag_key,stage)
        values ($1,$2,$3,'DOCUMENT_SETTLEMENT_LEDGER_ENTRY','canary')`, [clientId, firmId, clientId]);
      const runProducer = async () => {
        const connection = await pool.connect();
        try {
          return await runDocumentSettlementEntriesForClient({ client: connection, firmId, clientId, documentIds: [document.id] });
        } finally { connection.release(); }
      };
      const cards = async () => (await pool.query('select * from proposal_cards where client_id=$1 order by created_at,id', [clientId])).rows;
      const checks = async (id) => (await pool.query('select * from check_reports where proposal_id=$1 order by id', [id])).rows;
      const first = await runProducer();
      assert.equal(first.cards_minted, 1, JSON.stringify(first));
      assert.equal(first.posted, 0);
      assert.equal(first.rested_proposed, 1);
      const [originalCard] = await cards();
      const originalChecks = await checks(originalCard.id);
      assert.equal(originalCard.status, 'proposed');
      assert.equal(originalCard.check_status, 'fail');
      assert.equal(originalCard.detail.currency, '');
      const currencyCheck = originalChecks[0].checks.find((check) => check.name === 'document_currency');
      assert.equal(currencyCheck.status, 'fail');
      assert.match(currencyCheck.detail, /Confirm the document currency/);
      assert.equal((await effects(clientId)).ledger_journals.length, 0);
      assert.equal(requests.length, 1);
      assert.match(requests[0].messages[0].content, /amount=10 \n/);

      // Drive the public source correction, including its real post-commit
      // hook and bounded settlement producer, even with unrelated Loops off.
      // No producer or writer is injected.
      const correction = await recordDocumentCorrectionInDb({
        firmId, clientId, documentId: document.id, fieldPath: 'currency',
        correctedValue: 'GBP', correctedBy: actorId
      });
      assert.equal(correction.prior_value, null);
      assert.equal(correction.corrected_value, 'GBP');
      assert.equal(correction.corrected_by, actorId);
      const repairedCards = await cards();
      assert.equal(repairedCards.length, 2, JSON.stringify(repairedCards));
      const prior = repairedCards.find((card) => card.id === originalCard.id);
      const fresh = repairedCards.find((card) => card.id !== originalCard.id);
      assert.equal(prior.status, 'superseded');
      assert.equal(prior.superseded_by_proposal_id, fresh.id);
      assert.equal(fresh.supersedes_proposal_id, prior.id);
      assert.equal(fresh.status, 'applied');
      assert.equal(fresh.check_status, 'pass');
      assert.equal(fresh.detail.currency, 'GBP');
      assert.deepEqual(prior.detail, originalCard.detail);
      assert.deepEqual(prior.before_after, originalCard.before_after);
      assert.deepEqual(await checks(prior.id), originalChecks, 'the original failed receipt remains immutable');
      const accountRequests = requests.filter((request) => String(request.system).includes('You code ONE expense document'));
      assert.equal(accountRequests.length, 2, 'repair creates a fresh account decision from current source currency');
      assert.match(accountRequests[1].messages[0].content, /amount=10 GBP/);
      const storedDocument = (await pool.query('select * from documents where id=$1', [document.id])).rows[0];
      assert.equal(storedDocument.payment_status, 'paid');
      await checkCurrency(storedDocument.payload.settlement_entry.journal_id, 'GBP');
      const applied = (await pool.query('select * from apply_receipts where proposal_id=$1', [fresh.id])).rows;
      assert.equal(applied.length, 1);
      const effectsBeforeReplay = await effects(clientId);
      const requestCount = requests.length;
      const replay = await runProducer();
      assert.equal(replay.gathered, 0);
      assert.equal(replay.posted, 0);
      assert.equal(requests.length, requestCount);
      assert.deepEqual(await cards(), repairedCards);
      assert.deepEqual(await effects(clientId), effectsBeforeReplay);
    } finally {
      mockProvider = null;
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  await t.test('valid currency does not bypass locked periods in either named writer', async () => {
    const clientId = 'currency-locked';
    await seedClient(clientId);
    const document = await seedDocument(clientId, 'currency-locked-doc', 'GBP');
    await pool.query(`insert into close_periods (id,firm_id,client_id,period_start,period_end,status)
      values ('currency-lock',$1,$2,'2026-09-01','2026-09-30','locked')`, [firmId, clientId]);
    const before = await effects(clientId);
    await assert.rejects(adjustment(clientId, { lines: lines('GBP') }), { code: 'LEDGER_ADJUSTMENT_DATE_LOCKED' });
    await assert.rejects(settlement(clientId, document), { code: 'LEDGER_LOCKED_PERIOD_IMMUTABLE' });
    assert.deepEqual(await effects(clientId), before);
    assert.deepEqual((await pool.query('select * from documents where id=$1', [document.id])).rows[0], document);
    const nextPeriod = await adjustment(clientId, { journalDate: '2026-10-01', lines: lines('GBP') });
    await checkCurrency(nextPeriod.ledger_adjustment.journals[0].ledger_journal_id, 'GBP');
  });

  await t.test('a denomination correction during model generation prevents stale posting and the next tick proposes from current currency', async () => {
    const clientId = 'currency-generation-race';
    await seedClient(clientId);
    const document = await seedDocument(clientId, 'currency-generation-document', 'GBP');
    await pool.query(`update documents set payload=payload || $2::jsonb where id=$1`,
    [document.id, JSON.stringify({ no_line_disposition: {
      disposition: 'auto_explain', materiality: 'immaterial', settlement_channel: 'personal_card',
      confidence: 0.95, verdict_source: 'owner_reply', owner_notified: true
    } })]);
    await upsertLedgerAccountForJournal({ client: pool, firmId, clientId,
      account: { code: 'CUR-EXP', name: 'Currency expense', type: 'expense' }, currency: 'GBP' });
    await pool.query(`insert into client_capability_config (id,firm_id,client_id,flag_key,stage)
      values ($1,$2,$3,'DOCUMENT_SETTLEMENT_LEDGER_ENTRY','canary')`, [clientId, firmId, clientId]);
    const requests = [];
    const fetchImpl = async (url, options) => {
      assert.equal(url, 'https://api.anthropic.com/v1/messages');
      requests.push(JSON.parse(options.body));
      // Model input was assembled from GBP. A separate connection commits
      // changed source evidence before the actual posting writer runs.
      if (requests.length === 1) await pool.query("update documents set currency='CAD' where id=$1", [document.id]);
      return { ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({
        account: 'Currency expense', confidence: 0.95, reasoning: 'Owner-paid supplies.'
      }) }] }) };
    };
    const run = async () => {
      const connection = await pool.connect();
      try {
        return await runDocumentSettlementEntriesForClient({
          client: connection, firmId, clientId, documentIds: [document.id],
          apiKeyOverride: 'offline-settlement-race', fetchImpl
        });
      } finally { connection.release(); }
    };
    const first = await run();
    assert.equal(first.post_failures, 1, JSON.stringify(first));
    assert.equal(first.posted, 0);
    const [oldCard] = (await pool.query('select * from proposal_cards where client_id=$1', [clientId])).rows;
    assert.equal(oldCard.status, 'proposed');
    assert.equal(oldCard.detail.currency, 'GBP');
    const firstEffects = await effects(clientId);
    assert.equal(firstEffects.ledger_journals.length, 0);
    assert.equal(firstEffects.ledger_lines.length, 0);
    assert.equal(firstEffects.audit_events.filter((row) => row.action === 'ledger.post_document_settlement').length, 0);
    const second = await run();
    assert.equal(second.posted, 1, JSON.stringify(second));
    assert.equal(second.post_failures, 0);
    assert.equal(requests.length, 2);
    assert.match(requests[0].messages[0].content, /amount=10 GBP/);
    assert.match(requests[1].messages[0].content, /amount=10 CAD/);
    const cards = (await pool.query('select * from proposal_cards where client_id=$1', [clientId])).rows;
    assert.equal(cards.length, 2);
    const prior = cards.find((card) => card.id === oldCard.id);
    const fresh = cards.find((card) => card.id !== oldCard.id);
    assert.equal(prior.status, 'superseded');
    assert.deepEqual(prior.detail, oldCard.detail);
    assert.equal(fresh.status, 'applied');
    assert.equal(fresh.supersedes_proposal_id, oldCard.id);
    const stored = (await pool.query('select * from documents where id=$1', [document.id])).rows[0];
    await checkCurrency(stored.payload.settlement_entry.journal_id, 'CAD');
    assert.equal((await run()).gathered, 0);
    assert.equal(requests.length, 2);
  });
  assert.equal(providerCalls, 0);
});
