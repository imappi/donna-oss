import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from './firmDb.js';
import { writebackXeroTransactionInDb } from './db/xero.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;

test('U08-S1 real PG: actual Xero writeback refuses unsafe AE VAT before provider effects and mirrors safe native coding', async (t) => {
  assert.ok(pgUrl, 'INCOMPLETE: DONNA_PG_TEST_URL must name disposable PostgreSQL; actual Xero posting safety cannot skip.');
  const name = `donna_ae_xero_safety_${Date.now().toString(36)}_${process.pid}`;
  const admin = new pg.Client({ connectionString: pgUrl });
  await admin.connect();
  await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  const connectionsClosed = [];
  pool.on('connect', connection => connectionsClosed.push(new Promise(resolve => connection.once('end', resolve))));
  __setFirmDbPoolForTests(pool);
  const priorEnv = Object.fromEntries(['XERO_CLIENT_ID', 'XERO_CLIENT_SECRET', 'XERO_REDIRECT_URI'].map(key => [key, process.env[key]]));
  Object.assign(process.env, { XERO_CLIENT_ID: 'fixture-client', XERO_CLIENT_SECRET: 'fixture-secret', XERO_REDIRECT_URI: 'https://fixture.invalid/callback' });
  const priorFetch = globalThis.fetch;
  const providerCalls = [];
  let mutateOnRead = null;
  let providerExisting = null;
  let providerSequence = 0;
  globalThis.fetch = async (address, options = {}) => {
    const parsed = new URL(String(address));
    const method = options.method || 'GET';
    const call = { pathname: parsed.pathname, method, body: null };
    providerCalls.push(call);
    assert.equal(parsed.hostname, 'api.xero.com', 'test may never call an unexpected provider host');
    const body = options.body ? JSON.parse(options.body) : null;
    call.body = body;
    if (method === 'GET' && parsed.pathname.endsWith('/BankTransactions')) {
      if (mutateOnRead) {
        const mutation = mutateOnRead;
        mutateOnRead = null;
        await mutation();
      }
      return new Response(JSON.stringify({ BankTransactions: providerExisting ? [providerExisting] : [] }), { status: 200 });
    }
    if (method === 'POST' && parsed.pathname.endsWith('/BankTransactions')) {
      assert.equal(body.BankTransactions.length, 1);
      assert.equal(JSON.stringify(body).includes('AE_VAT_'), false, 'native ledger codes must never reach the provider wire');
      providerSequence += 1;
      return new Response(JSON.stringify({ Status: 'OK', BankTransactions: [{
        ...body.BankTransactions[0], BankTransactionID: `fixture-xero-${providerSequence}`, Status: 'AUTHORISED'
      }] }), { status: 200 });
    }
    if (method === 'POST' && /\/BankTransactions\/[^/]+\/History$/.test(parsed.pathname)) {
      return new Response(JSON.stringify({ HistoryRecords: [] }), { status: 200 });
    }
    assert.fail(`Unexpected provider call: ${method} ${parsed.pathname}`);
  };
  t.after(async () => {
    globalThis.fetch = priorFetch;
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
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
  for (const file of (await readdir(migrationRoot)).filter(file => file.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(file, migrationRoot), 'utf8'));
  }

  const firmId = 'ae-xero-safety-firm';
  const clientId = 'ae-xero-safety-client';
  const actorId = 'ae-xero-safety-owner';
  const connectionId = 'ae-xero-safety-connection';
  await pool.query("insert into firms (id,name,slug) values ($1,'Xero safety fixture','ae-xero-safety-fixture')", [firmId]);
  await pool.query("insert into firm_members(id,firm_id,name,email,status) values($1,$2,'Fixture owner','fixture@example.test','active')", [actorId, firmId]);
  await pool.query(`insert into clients(id,firm_id,company_name,jurisdiction,profile)
    values($1,$2,'Xero safety client','ae','{"jurisdiction":"ae","accounting_system":"xero"}')`, [clientId, firmId]);
  await pool.query(`insert into client_capability_config(id,firm_id,client_id,flag_key,stage)
    values('ae-xero-tax',$1,$2,'JURISDICTION_TAX_CODING','auto')`, [firmId, clientId]);
  await pool.query(`insert into xero_connections(id,firm_id,client_id,tenant_id,status,scopes,access_token,refresh_token,expires_at)
    values($1,$2,$3,'fixture-tenant','connected',array['accounting.banktransactions'],'fixture-access','fixture-refresh','2099-01-01T00:00:00Z')`,
  [connectionId, firmId, clientId]);
  for (const [code, label, type] of [['090', 'AED bank', 'BANK'], ['200', 'Sales', 'REVENUE'], ['400', 'Operating expenses', 'EXPENSE']]) {
    await pool.query(`insert into xero_accounts(id,connection_id,firm_id,client_id,xero_account_id,code,name,type,status,tax_type,payload)
      values($1,$2,$3,$4,$1,$5,$6,$7,'ACTIVE','NONE','{"currency":"AED"}')`,
    [`ae-xero-account-${code}`, connectionId, firmId, clientId, code, label, type]);
  }
  const seed = async (id, treatment, { out = false } = {}) => {
    await pool.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,coding_state,payload)
      values($1,$2,$3,'2026-09-09',$4,$5,$6,'AED','needs_review','applied',$7)`,
    [id, firmId, clientId, `Fixture ${id}`, out ? 0 : 105, out ? 105 : 0, {
      ai_suggestion: { proposed_account: out ? 'Operating expenses' : 'Sales', account_code: out ? '400' : '200',
        ...(treatment !== undefined ? { tax_treatment: treatment } : {}), confidence: 'high' }
    }]);
    // The case file deliberately disagrees: it cannot override current source treatment.
    await pool.query(`insert into transaction_review_queue(id,firm_id,client_id,item_type,item_id,reason,priority,status,payload)
      values($1,$2,$3,'transaction',$4,'fixture','normal','open',$5)`,
    [`review-${id}`, firmId, clientId, id, { transaction_id: id, tax_treatment: 'Out of scope of UAE VAT', xero_tax_type: 'NONE' }]);
  };
  const writeback = (transactionId, dryRun = false) => writebackXeroTransactionInDb({
    firmId, clientId, connectionId, transactionId, actorId, dryRun, skipSnapshot: true
  });
  const noEffects = async id => {
    const journals = await pool.query('select id from ledger_journals where firm_id=$1 and client_id=$2 and source_id=$3', [firmId, clientId, id]);
    assert.deepEqual(journals.rows, []);
    const lines = await pool.query(`select ll.id from ledger_lines ll join ledger_journals lj on lj.id=ll.journal_id
      where lj.firm_id=$1 and lj.client_id=$2 and lj.source_id=$3`, [firmId, clientId, id]);
    assert.deepEqual(lines.rows, []);
    const row = (await pool.query('select coding_state,payload from transactions where id=$1', [id])).rows[0];
    assert.equal(row.coding_state, 'applied');
    assert.ok(!row.payload.xero_bank_transaction_id);
    assert.notEqual(row.payload.xero_sync_status, 'synced');
  };
  const created = calls => calls.filter(call => call.method === 'POST' && call.pathname.endsWith('/BankTransactions'));
  const failureReceipt = async (id, code) => {
    const event = (await pool.query(`select action,metadata from audit_events where firm_id=$1 and client_id=$2
      and resource_id=$3 and metadata->>'operation'='posting'
      and action in ('transaction.coding.policy_failed','transaction.coding.policy_recovered') order by id desc limit 1`,
    [firmId, clientId, id])).rows[0];
    assert.equal(event?.action, 'transaction.coding.policy_failed');
    assert.equal(event.metadata.reason_code, code);
    assert.ok(event.metadata.recovery_route || event.metadata.recovery_path, 'a failure must retain its existing repair consumer');
    if (code.startsWith('TRANSACTION_AE_VAT_')) {
      const row = (await pool.query('select payload from transactions where id=$1', [id])).rows[0];
      assert.equal(row.payload.ledger_post_refusal.code, code);
      assert.ok(event.metadata.owner_question == null, 'software capability failure does not invent a missing owner fact');
    }
  };

  await t.test('unknown, absent, standard and reverse-charge VAT refuse before any provider call in preview and live paths', async (subtest) => {
    subtest.after(async () => {
      await pool.query("update xero_connections set status='connected',expires_at='2099-01-01T00:00:00Z' where id=$1", [connectionId]);
      await pool.query("update client_capability_config set stage='auto' where id='ae-xero-tax'");
    });
    // An expired connection would invoke OAuth HTTP if preparation refreshes
    // before checking the transaction. Even that provider call is premature.
    await pool.query("update xero_connections set expires_at='2000-01-01T00:00:00Z' where id=$1", [connectionId]);
    for (const stage of ['auto', 'off']) {
      await pool.query("update client_capability_config set stage=$1 where id='ae-xero-tax'", [stage]);
      for (const [key, treatment, out, code] of [
        ['absent', undefined, false, 'TRANSACTION_AE_VAT_TREATMENT_UNRESOLVED'],
        ['unsure', 'UAE VAT check', false, 'TRANSACTION_AE_VAT_TREATMENT_UNRESOLVED'],
        ['unknown', 'invented treatment', false, 'TRANSACTION_AE_VAT_TREATMENT_UNRESOLVED'],
        ['standard', 'VAT 5% (standard rated)', false, 'TRANSACTION_AE_VAT_POSTING_UNSUPPORTED'],
        ['standard-input', 'VAT 5% (standard rated)', true, 'TRANSACTION_AE_VAT_POSTING_UNSUPPORTED'],
        ['rcm', 'Reverse charge (RCM)', true, 'TRANSACTION_AE_VAT_POSTING_UNSUPPORTED']
      ]) {
        const id = `${stage}-${key}`;
        await seed(id, treatment, { out });
        for (const dryRun of [true, false]) {
          const before = providerCalls.length;
          await assert.rejects(writeback(id, dryRun), { code });
          assert.equal(providerCalls.length, before, `${id}: refusal must precede token refresh and provider lookup`);
          await noEffects(id);
          await failureReceipt(id, code);
        }
      }
    }
    assert.equal(Number((await pool.query('select count(*)::int n from client_evidence_requests where firm_id=$1 and client_id=$2', [firmId, clientId])).rows[0].n), 0);
  });

  const verifySafe = async (id, expectedNative, existingId = null) => {
    const source = (await pool.query('select payload from transactions where id=$1', [id])).rows[0].payload;
    const sourceTreatment = source.tax_treatment || source.ai_suggestion?.tax_treatment || '';
    const priorFailure = (await pool.query(`select action from audit_events where firm_id=$1 and client_id=$2
      and resource_id=$3 and metadata->>'operation'='posting'
      and action in ('transaction.coding.policy_failed','transaction.coding.policy_recovered') order by id desc limit 1`,
    [firmId, clientId, id])).rows[0]?.action === 'transaction.coding.policy_failed';
    const before = providerCalls.length;
    const preview = await writeback(id, true);
    assert.equal(providerCalls.length, before, 'a safe preview also needs no provider HTTP');
    const wire = preview.xero_writeback.bank_transaction;
    assert.equal(wire.LineItems[0].TaxType, 'NONE', 'the supported connector contract performs no provider tax calculation');
    assert.equal(wire.LineAmountTypes, 'NoTax');
    assert.equal(JSON.stringify(wire).includes('AE_VAT_'), false);
    assert.equal(wire.LineItems[0].UnitAmount, 105);
    const result = await writeback(id);
    assert.ok(result.xero_writeback.xero_bank_transaction_id);
    const creates = created(providerCalls.slice(before));
    if (existingId) {
      assert.equal(creates.length, 0, 'a valid existing provider transaction is adopted without a second create');
      assert.equal(result.xero_writeback.xero_bank_transaction_id, existingId);
      assert.equal(result.xero_writeback.xero_response.matched_existing, true);
    } else {
      assert.equal(creates.length, 1);
      assert.deepEqual(creates[0].body.BankTransactions[0], wire, 'the previewed connector request is the request actually sent');
    }
    const journalLines = (await pool.query(`select ll.tax_type,ll.debit,ll.credit,la.account_type from ledger_lines ll
      join ledger_journals lj on lj.id=ll.journal_id join ledger_accounts la on la.id=ll.account_id
      where lj.firm_id=$1 and lj.client_id=$2 and lj.source_id=$3`, [firmId, clientId, id])).rows;
    assert.equal(journalLines.length, 2);
    assert.equal(journalLines.find(line => ['revenue', 'expense'].includes(line.account_type)).tax_type, expectedNative);
    assert.equal(journalLines.reduce((sum, line) => sum + Number(line.debit), 0), 105);
    assert.equal(journalLines.reduce((sum, line) => sum + Number(line.credit), 0), 105);
    const row = (await pool.query('select coding_state,payload from transactions where id=$1', [id])).rows[0];
    assert.equal(row.coding_state, 'synced');
    assert.ok(row.payload.xero_bank_transaction_id);
    assert.deepEqual(row.payload.xero_writeback_payload, wire);
    assert.equal(row.payload.ledger_post_refusal, undefined, 'a successful recovery must clear its old refusal marker');
    assert.equal(row.payload.tax_treatment, sourceTreatment, 'connector enrichment must retain the authoritative source treatment');
    assert.equal(row.payload.tax_type, expectedNative);
    assert.equal(row.payload.xero_tax_type, 'NONE');
    if (priorFailure) {
      const latest = (await pool.query(`select action,metadata from audit_events where firm_id=$1 and client_id=$2
        and resource_id=$3 and metadata->>'operation'='posting'
        and action in ('transaction.coding.policy_failed','transaction.coding.policy_recovered') order by id desc limit 1`,
      [firmId, clientId, id])).rows[0];
      assert.equal(latest.action, 'transaction.coding.policy_recovered', 'the successful mirror must close its existing policy incident');
    }
  };
  await t.test('a native-only source code cannot leak onto the connector wire', async () => {
    const id = 'native-provider-code';
    await seed(id, undefined);
    await pool.query("update transactions set payload=payload || $2::jsonb where id=$1", [id, { xero_tax_type: 'AE_VAT_EXEMPT_OUTPUT' }]);
    for (const dryRun of [true, false]) {
      const before = providerCalls.length;
      await assert.rejects(writeback(id, dryRun), { code: 'posting_connector_tax_code_unmapped' });
      assert.equal(providerCalls.length, before);
      await noEffects(id);
      await failureReceipt(id, 'posting_connector_tax_code_unmapped');
    }
  });
  await t.test('non-NONE provider tax codes refuse before HTTP even when native source treatment is exempt', async (subtest) => {
    subtest.after(async () => {
      await pool.query("update xero_accounts set tax_type='NONE' where firm_id=$1 and client_id=$2 and code='200'", [firmId, clientId]);
      await pool.query("update xero_connections set status='connected',expires_at='2099-01-01T00:00:00Z' where id=$1", [connectionId]);
      await pool.query("update client_capability_config set stage='auto' where id='ae-xero-tax'");
    });
    await pool.query("update xero_connections set expires_at='2000-01-01T00:00:00Z' where id=$1", [connectionId]);
    for (const stage of ['auto', 'off']) {
      await pool.query("update client_capability_config set stage=$1 where id='ae-xero-tax'", [stage]);
      for (const [key, chartCode, explicitCode] of [
        ['chart-output', 'OUTPUT', null],
        ['explicit-output', 'NONE', 'OUTPUT'],
        ['explicit-exemptoutput', 'NONE', 'EXEMPTOUTPUT'],
        ['explicit-opaque', 'NONE', 'XERO_TAX_OPAQUE_FIXTURE']
      ]) {
        const id = `${stage}-${key}`;
        await pool.query("update xero_accounts set tax_type=$3 where firm_id=$1 and client_id=$2 and code='200'", [firmId, clientId, chartCode]);
        await seed(id, 'Exempt supply');
        if (explicitCode) {
          await pool.query("update transactions set payload=payload || $2::jsonb where id=$1", [id, {
            tax_type: 'AE_VAT_EXEMPT_OUTPUT', xero_tax_type: explicitCode
          }]);
        }
        for (const dryRun of [true, false]) {
          const before = providerCalls.length;
          await assert.rejects(writeback(id, dryRun), { code: 'TRANSACTION_AE_VAT_CONNECTOR_UNSUPPORTED' });
          assert.equal(providerCalls.length, before, `${id}: an unproven provider tax calculation must not reach OAuth or HTTP`);
          await noEffects(id);
          await failureReceipt(id, 'TRANSACTION_AE_VAT_CONNECTOR_UNSUPPORTED');
        }
      }
    }
    assert.equal(Number((await pool.query('select count(*)::int n from client_evidence_requests where firm_id=$1 and client_id=$2', [firmId, clientId])).rows[0].n), 0);
  });
  await t.test('safe exact treatment keeps connector tax vocabulary and creates the native local mirror', async (subtest) => {
    subtest.after(() => pool.query("update client_capability_config set stage='auto' where id='ae-xero-tax'"));
    for (const stage of ['auto', 'off']) {
      await pool.query("update client_capability_config set stage=$1 where id='ae-xero-tax'", [stage]);
      for (const [key, treatment, native, out] of [
        ['safe-exempt', 'Exempt supply', 'AE_VAT_EXEMPT_OUTPUT', false],
        ['safe-zero', 'Zero-rated supply', 'AE_VAT_ZR_OUTPUT', false],
        ['safe-outside', 'Out of scope of UAE VAT', 'AE_VAT_OUTSIDE_SCOPE_OUTPUT', false],
        ['safe-exempt-input', 'Exempt supply', 'AE_VAT_EXEMPT_INPUT', true]
      ]) {
        const id = `${stage}-${key}`;
        await seed(id, treatment, { out });
        await verifySafe(id, native);
      }
    }
    const mixed = 'native-local-provider-none';
    await seed(mixed, 'Exempt supply');
    await pool.query("update transactions set payload=payload || $2::jsonb where id=$1", [mixed, {
      tax_type: 'AE_VAT_EXEMPT_OUTPUT', xero_tax_type: 'NONE'
    }]);
    await verifySafe(mixed, 'AE_VAT_EXEMPT_OUTPUT');
    // Repair the persisted source of an actual earlier VAT refusal, retaining
    // that refusal marker until the real successful writeback clears it.
    const repaired = 'auto-unsure';
    await failureReceipt(repaired, 'TRANSACTION_AE_VAT_TREATMENT_UNRESOLVED');
    await pool.query("update transactions set payload=jsonb_set(payload,'{ai_suggestion,tax_treatment}','\"Exempt supply\"') where id=$1", [repaired]);
    await verifySafe(repaired, 'AE_VAT_EXEMPT_OUTPUT');
  });

  await t.test('existing reference match must satisfy the same no-tax provider contract before adoption', async (subtest) => {
    subtest.after(() => { providerExisting = null; });
    const id = 'existing-reference';
    await seed(id, 'Exempt supply');
    const wire = (await writeback(id, true)).xero_writeback.bank_transaction;
    const existingId = 'fixture-existing-reference';
    providerExisting = { ...wire, BankTransactionID: existingId, Status: 'AUTHORISED',
      LineAmountTypes: 'Inclusive', LineItems: wire.LineItems.map(line => ({ ...line, TaxType: 'OUTPUT' })) };
    const before = providerCalls.length;
    await assert.rejects(writeback(id), { code: 'TRANSACTION_AE_VAT_CONNECTOR_UNSUPPORTED' });
    assert.ok(providerCalls.length > before, 'the actual reference lookup must see the existing candidate');
    assert.equal(created(providerCalls.slice(before)).length, 0);
    await noEffects(id);
    await failureReceipt(id, 'TRANSACTION_AE_VAT_CONNECTOR_UNSUPPORTED');
    // The reference is unchanged. Only an actual provider row with the same
    // supported tax calculation contract can be adopted and close the refusal.
    providerExisting = { ...wire, BankTransactionID: existingId, Status: 'AUTHORISED' };
    await verifySafe(id, 'AE_VAT_EXEMPT_OUTPUT', existingId);
  });

  await t.test('treatment, config or chart changing during provider lookup refuses before create, then fresh safe work recovers', async () => {
    for (const kind of ['treatment', 'config', 'chart']) {
      const id = `race-${kind}`;
      await seed(id, 'Exempt supply');
      const before = providerCalls.length;
      mutateOnRead = {
        treatment: () => pool.query("update transactions set payload=jsonb_set(payload,'{ai_suggestion,tax_treatment}','\"VAT 5% (standard rated)\"') where id=$1", [id]),
        config: () => pool.query("update client_capability_config set stage='off' where id='ae-xero-tax'"),
        chart: () => pool.query("update xero_accounts set tax_type='OUTPUT' where firm_id=$1 and client_id=$2 and code='200'", [firmId, clientId])
      }[kind];
      await assert.rejects(writeback(id), error => error.code === 'jurisdiction_context_conflict'
        || error.code === 'TRANSACTION_AE_VAT_POSTING_UNSUPPORTED' || error.code === 'TRANSACTION_AE_VAT_CONNECTOR_UNSUPPORTED');
      assert.equal(mutateOnRead, null, 'fixture must reach the real provider lookup');
      assert.ok(providerCalls.length > before, 'a read-only provider lookup precedes the tested race');
      assert.equal(created(providerCalls.slice(before)).length, 0, 'freshness must be checked before the irreversible provider create');
      await noEffects(id);
      if (kind === 'treatment') {
        await pool.query("update transactions set payload=jsonb_set(payload,'{ai_suggestion,tax_treatment}','\"Exempt supply\"') where id=$1", [id]);
      } else if (kind === 'config') {
        await pool.query("update client_capability_config set stage='auto' where id='ae-xero-tax'");
      } else {
        await pool.query("update xero_accounts set tax_type='NONE' where firm_id=$1 and client_id=$2 and code='200'", [firmId, clientId]);
      }
      await verifySafe(id, 'AE_VAT_EXEMPT_OUTPUT');
    }
  });
});
