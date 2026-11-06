import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { runOwnerInvoiceCommandTurn } from './db/issuance.js';
import { createParty, addPartyChannel } from './outbound/partyStore.js';

// Current complete schema, disposable database, mocked model transport only.
// Neither the app database nor a mail/model provider is used by this proof.
test('real PG: owner invoice input → missing buyer ask → attributed reply → draft, with exactly one terminal ask', async (t) => {
  const pgUrl = process.env.DONNA_PG_TEST_URL;
  assert.ok(pgUrl, 'INCOMPLETE: DONNA_PG_TEST_URL must identify an isolated test PostgreSQL cluster');
  const database = `donna_u15_owner_${Date.now().toString(36)}_${process.pid}`;
  const admin = new pg.Client({ connectionString: pgUrl });
  await admin.connect();
  await admin.query(`create database "${database}"`);
  const scratchUrl = new URL(pgUrl); scratchUrl.pathname = `/${database}`;
  const client = new pg.Client({ connectionString: scratchUrl.toString() });
  await client.connect();
  const cleanConfig = await mkdtemp(path.join(tmpdir(), 'donna-u15-owner-config-'));
  const originalCwd = process.cwd();
  const priorKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'fixture-key-never-sent';
  process.chdir(cleanConfig);
  t.after(async () => {
    process.chdir(originalCwd);
    if (priorKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = priorKey;
    await client.end();
    await admin.query(`drop database "${database}"`);
    await admin.end();
    await rm(cleanConfig, { recursive: true, force: true });
  });
  await client.query(`create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb);`);
  const migrations = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter((f) => f.endsWith('.sql')).sort()) {
    await client.query(await readFile(new URL(file, migrations), 'utf8'));
  }
  const firmId = 'u15-owner-firm'; const clientId = 'u15-owner-client'; const actorId = 'fixture-owner';
  await client.query("insert into firms (id,name,slug) values ($1,'Owner invoice test','u15-owner')", [firmId]);
  await client.query(`insert into clients (id,firm_id,company_name,jurisdiction,profile)
    values ($1,$2,'Fixture Seller','ae',$3::jsonb)`, [clientId, firmId, JSON.stringify({
      jurisdiction: 'ae', address: '10 Seller Street Dubai', payment_instructions: 'Bank transfer to fixture account',
      vat_registration: { status: 'registered', registered_from: '2026-01-01', vat_registration_number: '100123456789001' }
    })]);
  for (const flag of ['OWNER_INVOICE_COMMAND', 'OUTBOUND_INVOICING']) {
    await client.query(`insert into client_capability_config (id,firm_id,client_id,flag_key,stage,source)
      values ($1,$2,$3,$4,'canary','manual')`, [flag, firmId, clientId, flag]);
  }
  const party = await createParty(client, { firmId, clientId, displayName: 'Acme', isCustomer: true, actorType: 'owner', actorId });
  await addPartyChannel(client, { firmId, clientId, partyId: party.id, channelKind: 'email', channelValue: 'billing@acme.invalid', isPrimary: true, actorType: 'owner', actorId });
  const originalMessage = 'Invoice Acme AED 10000 for consulting, quantity 1, tax rate 5%, line VAT 500, total VAT 500. Buyer address 20 Buyer Street Dubai. Supply date 2026-09-09.';
  const initialReading = {
    is_invoice_command: true, buyer_party_id: party.id, buyer_name_stated: null, buyer_email_stated: null,
    buyer_address_stated: '20 Buyer Street Dubai', buyer_tax_registration: null,
    supply_date_stated: '2026-09-09', supply_date_evidence: '2026-09-09',
    lines: [{ description: 'consulting', quantity: 1, unit_price: 10000, tax_rate: 5, tax_amount: 500 }],
    currency_code: 'AED', currency_evidence: 'AED', due_date: null, payment_terms_days: null,
    tax_amount_stated: 500, chase_until_paid: false, ambiguities: [], reason: 'Explicit invoice instruction'
  };
  let transportCalls = 0;
  const mockedRead = (reading, expectedMessage) => async (url, init) => {
    transportCalls++;
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const body = JSON.parse(init.body);
    assert.equal(body.text.format.strict, true);
    assert.equal(body.text.format.schema.properties.buyer_tax_registration.additionalProperties, false);
    assert.ok(body.input.includes(expectedMessage));
    return new Response(JSON.stringify({ output_text: JSON.stringify(reading), usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const base = { firmId, clientId, principalActorType: 'firm_collaborator', principalActorId: actorId,
    sourceChannel: 'whatsapp', channelBinding: { phone_hash: 'fixture-binding' },
    env: {}, now: Date.parse('2026-09-09T12:00:00Z') };
  const turn = async (args) => {
    await client.query('begin');
    try {
      const result = await runOwnerInvoiceCommandTurn(client, { ...base, ...args });
      await client.query('commit'); return result;
    } catch (error) { await client.query('rollback'); throw error; }
  };
  const first = await turn({ sourceMessageId: 'owner-original', messageText: originalMessage,
    fetchImpl: mockedRead(initialReading, originalMessage) });
  assert.equal(first.status, 'asked', JSON.stringify(first));
  assert.ok(first.missing.includes('buyer_registration_unknown'));
  assert.equal((await client.query('select count(*)::int as n from issued_invoices')).rows[0].n, 0);
  const firstAsk = (await client.query('select * from client_evidence_requests where id=$1', [first.evidenceRequestId])).rows[0];
  assert.equal(firstAsk.status, 'open');
  assert.equal(firstAsk.request_payload.command_message, originalMessage);

  const partialReply = 'Acme is currently UAE VAT registered from 2026-09-01.';
  const partial = await turn({ sourceMessageId: 'owner-partial', continuationAskId: firstAsk.id,
    messageText: partialReply, fetchImpl: mockedRead({ ...initialReading, buyer_tax_registration: {
      status: 'registered', jurisdiction: 'ae', registration_id: null,
      effective_from: '2026-09-01', effective_until: null, statement_evidence: 'Acme is currently UAE VAT registered'
    } }, partialReply) });
  assert.equal(partial.status, 'asked', JSON.stringify(partial));
  assert.ok(partial.missing.includes('buyer_registration_id_required'));
  const retired = (await client.query('select * from client_evidence_requests where id=$1', [firstAsk.id])).rows[0];
  assert.equal(retired.status, 'resolved');
  assert.equal(retired.response_payload.invoice_continuation.successor_evidence_request_id, partial.evidenceRequestId);
  assert.equal((await client.query("select count(*)::int as n from client_evidence_requests where evidence_type='owner_invoice_command' and status='open'")).rows[0].n, 1);
  assert.equal((await client.query('select count(*)::int as n from issued_invoices')).rows[0].n, 0);
  const activeAskId = partial.evidenceRequestId;

  const reply = 'Acme is currently UAE VAT registered from 2026-09-01, TRN 100123456789003.';
  const reading = { ...initialReading, buyer_tax_registration: {
    status: 'registered', jurisdiction: 'ae', registration_id: '100123456789003',
    effective_from: '2026-09-01', effective_until: null, statement_evidence: 'Acme is currently UAE VAT registered'
  } };
  const denied = await turn({ sourceMessageId: 'wrong-owner', principalActorId: 'another-owner',
    continuationAskId: activeAskId, messageText: reply, fetchImpl: () => assert.fail('wrong owner may not invoke model') });
  assert.equal(denied.status, 'refused');
  assert.equal((await client.query('select status from client_evidence_requests where id=$1', [activeAskId])).rows[0].status, 'open');
  const second = await turn({ sourceMessageId: 'owner-reply', continuationAskId: activeAskId,
    messageText: reply, fetchImpl: mockedRead(reading, reply) });
  assert.equal(second.status, 'drafted', JSON.stringify(second));
  assert.equal(second.draft.draft.invoice.total, 10500);
  assert.equal(second.draft.draft.invoice.currency, 'AED');
  assert.equal(second.draft.draft.invoice.buyer.taxRegistrationId, '100123456789003');
  assert.equal(second.draft.draft.invoice.lines[0].taxRate, 5);
  assert.equal(second.draft.draft.invoice.lines[0].taxAmount, 500);
  const closed = (await client.query('select * from client_evidence_requests where id=$1', [activeAskId])).rows[0];
  assert.equal(closed.status, 'resolved');
  assert.equal(closed.resolved_by, actorId);
  assert.equal(closed.response_payload.invoice_continuation.issued_invoice_id, second.draft.id);
  assert.equal((await client.query("select count(*)::int as n from client_evidence_requests where evidence_type='owner_invoice_command' and status='open'")).rows[0].n, 0);
  const persistedParty = (await client.query('select * from client_parties where id=$1', [party.id])).rows[0];
  assert.equal(persistedParty.detail.tax_registration.status, 'registered');
  assert.equal(persistedParty.detail.tax_registration.registrationId, '100123456789003');
  assert.equal(persistedParty.detail.tax_registration.effectiveFrom, '2026-09-01');
  const attributedFact = (await client.query(
    "select set_by_actor_type,set_by_actor_id from party_attributes where party_id=$1 and attribute='tax_registration' and valid_until is null", [party.id]
  )).rows[0];
  assert.equal(attributedFact.set_by_actor_type, 'firm_collaborator', 'creator preserves the authenticated member type');
  assert.equal(attributedFact.set_by_actor_id, actorId, 'creator preserves the real member identity');

  const duplicate = await turn({ sourceMessageId: 'owner-reply', continuationAskId: activeAskId,
    messageText: reply, fetchImpl: () => assert.fail('duplicate must not spend a model call') });
  assert.equal(duplicate.status, 'duplicate');
  assert.equal((await client.query('select count(*)::int as n from issued_invoices')).rows[0].n, 1);
  assert.equal(transportCalls, 3);
  assert.equal((await client.query('select count(*)::int as n from outbound_action_receipts where outcome=\'sent\'')).rows[0].n, 0, 'no mail effect');
});
