import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadOutboundPack } from './packs.js';
import { buildOutboundInvoiceModel, createOutboundInvoiceDraft } from './issuance.js';
import { createParty, addPartyChannel, getPartyById, setPartyAttribute } from './partyStore.js';
import { approveOutboundAction } from './actionStore.js';
import { executeDueOutboundActions } from './actionExecutor.js';
import { stripBidiControls } from './bidiText.js';

const pack = loadOutboundPack('ae');
const fact = { status: 'registered', jurisdiction: 'ae', registrationId: '100987654321003',
  effectiveFrom: '2026-01-01', effectiveUntil: null, source: 'owner_statement' };
const seller = { name: 'Invoice Test LLC', businessId: null, address: 'Dubai',
  taxRegistered: true, taxRegistrationId: '100123456789003' };
const buyer = { name: 'Buyer LLC', address: 'Abu Dhabi', email: 'buyer@example.test', taxRegistration: fact };
const base = { pack, seller, buyer, invoiceNumber: '2026001', date: '2026-09-09',
  supplyDate: '2026-09-09', dueDate: '2026-09-23', currency: 'AED', taxTotal: 500,
  lines: [{ description: 'Services', quantity: 1, unit_price: 10000, tax_rate: 5, tax_amount: 500 }],
  paymentInstructionsResolved: true };

test('U15-S1 pure full floor: registered/unregistered, absent/unknown/foreign/stale and honest currency', () => {
  assert.equal(buildOutboundInvoiceModel(base).invoice.total, 10500);
  for (const value of [null, { ...fact, registrationId: null }, { ...fact, status: 'unknown', registrationId: null },
    { ...fact, jurisdiction: 'gb' }, { ...fact, source: 'model' }, { ...fact, effectiveFrom: '2026-10-01' },
    { ...fact, effectiveUntil: '2026-09-09' }, { ...fact, effectiveFrom: '2026-99-99' }]) {
    assert.equal(buildOutboundInvoiceModel({ ...base, buyer: { ...buyer, taxRegistration: value } }).ok, false, JSON.stringify(value));
  }
  assert.equal(buildOutboundInvoiceModel({ ...base, buyer: { ...buyer, taxRegistered: true, taxRegistration: undefined } }).ok, false);
  assert.equal(buildOutboundInvoiceModel({ ...base, buyer: { ...buyer,
    taxRegistration: { ...fact, status: 'not_registered', registrationId: null } } }).ok, true);
  assert.equal(buildOutboundInvoiceModel({ ...base, currency: 'USD' }).ok, false);
  assert.equal(buildOutboundInvoiceModel({ ...base, taxTotal: 0,
    lines: [{ description: 'Small zero-rated service', unit_price: 1, tax_rate: 0, tax_amount: 0 }],
    buyer: { ...buyer, taxRegistration: null } }).ok, false, 'full floor has no simplified threshold escape');
});

test('U15-S1 real PG: party facts → draft → approval → current-fact guard → fake mail and immutable receipt', async () => {
  const url = process.env.DONNA_PG_TEST_URL;
  assert.ok(url, 'INCOMPLETE: DONNA_PG_TEST_URL required for real invoice lifecycle');
  const database = `u15_invoice_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`create database "${database}"`);
  const scratch = new URL(url); scratch.pathname = `/${database}`;
  const client = new pg.Client({ connectionString: scratch.toString() });
  await client.connect();
  const cleanConfig = await mkdtemp(path.join(tmpdir(), 'donna-u15-invoice-config-'));
  const cwd = process.cwd(); process.chdir(cleanConfig);
  try {
    await client.query(`create schema storage;
      create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
      create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb);`);
    const migrations = new URL('../../../db/migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).filter((name) => name.endsWith('.sql')).sort()) {
      await client.query(await readFile(new URL(name, migrations), 'utf8'));
    }
    await client.query("insert into firms (id,name,slug) values ('u15-firm','Test','u15')");
    const profile = { address: seller.address, accounting_basis: 'cash', payment_instructions: 'Bank transfer',
      email: 'owner@example.test', vat_registration: { status: 'registered', registered_from: '2026-01-01',
        vat_registration_number: seller.taxRegistrationId } };
    await client.query("insert into clients (id,firm_id,company_name,jurisdiction,profile) values ('u15-client','u15-firm',$1,'ae',$2)",
      [seller.name, profile]);
    await client.query("insert into client_capability_config (id,firm_id,client_id,flag_key,stage,source) values ('u15-config','u15-firm','u15-client','OUTBOUND_INVOICING','canary','manual')");
    const scope = { firmId: 'u15-firm', clientId: 'u15-client' };
    const party = await createParty(client, { ...scope, displayName: buyer.name, isCustomer: true,
      actorType: 'owner', actorId: 'u15-owner' });
    await addPartyChannel(client, { ...scope, partyId: party.id, channelKind: 'email', channelValue: buyer.email,
      isPrimary: true, actorType: 'owner', actorId: 'u15-owner' });
    const writeFact = async (value) => {
      await client.query('begin');
      try { await setPartyAttribute(client, { ...scope, partyId: party.id, attribute: 'tax_registration',
        value, source: 'owner_statement', actorType: 'owner', actorId: 'u15-owner' });
        await client.query('commit'); } catch (error) { await client.query('rollback'); throw error; }
    };
    const draft = async (changes = {}) => {
      await client.query('begin');
      try {
        const result = await createOutboundInvoiceDraft(client, { ...base, ...scope,
          buyer: { ...buyer, partyId: party.id, taxRegistration: undefined },
          issueDate: base.date, paymentInstructions: 'Bank transfer', actorId: 'u15-owner',
          now: Date.parse('2026-09-09T12:00:00Z'), env: {}, ...changes });
        await client.query('commit'); return result;
      } catch (error) { await client.query('rollback'); throw error; }
    };
    const count = async (table) => Number((await client.query(`select count(*) as n from ${table}`)).rows[0].n);
    await assert.rejects(draft(), { code: 'OUTBOUND_INVOICE_BUYER_FACTS_REQUIRED' });
    assert.equal(await count('issued_invoice_counters'), 0, 'missing fact allocates no invoice number');
    await writeFact(fact);
    const persisted = await getPartyById(client, { ...scope, partyId: party.id });
    assert.equal(persisted.detail.tax_registration.actorId, 'u15-owner');
    assert.equal(await count('party_attributes'), 1);
    await assert.rejects(draft({ currency: 'USD' }), { code: 'OUTBOUND_INVOICE_INVALID' });
    await assert.rejects(draft({ pack: loadOutboundPack('gb'), currency: 'GBP' }), { code: 'OUTBOUND_INVOICE_INVALID' });
    await assert.rejects(draft({ buyer: { ...buyer, partyId: party.id }, actorId: 'owner' }), { code: 'OUTBOUND_INVOICE_INVALID' });
    assert.equal(await count('issued_invoice_counters'), 0, 'foreign currency never allocates');
    const sends = [];
    const execute = () => executeDueOutboundActions({ client, ...scope,
      env: { OUTBOUND_PUBLIC_BASE_URL: 'https://donna.test' }, now: Date.parse('2026-09-09T12:00:00Z'),
      roleDecisionFn: () => ({ allowed: true, reasons: [] }),
      deliverers: { email: async (message) => { sends.push(message); return { providerMessageId: `fake-${sends.length}` }; } } });
    const approve = async (created) => {
      await client.query('begin');
      try {
        const approved = await approveOutboundAction(client, { ...scope, actionId: created.action.id,
          actorType: 'owner', actorId: 'u15-owner' });
        assert.equal(approved.status, 'approved');
        assert.match(approved.approved_consequence_fingerprint, /^sha256:/);
        await client.query('commit');
      } catch (error) { await client.query('rollback'); throw error; }
    };
    const cancel = (created) => client.query("update outbound_actions set status='cancelled' where id=$1", [created.action.id]);
    for (const changed of [{ ...fact, registrationId: '100111111111003' },
      { ...fact, status: 'not_registered', registrationId: null },
      { ...fact, effectiveUntil: '2026-09-09' }, { ...fact, jurisdiction: 'gb' }]) {
      await writeFact(fact);
      const created = await draft(); await approve(created); await writeFact(changed);
      const stats = await execute();
      assert.equal(stats.sent, 0, JSON.stringify(stats));
      assert.equal(stats.held_stale_consequence, 1, JSON.stringify(stats));
      const held = (await client.query('select status from outbound_actions where id=$1', [created.action.id])).rows[0];
      assert.equal(held.status, 'hold_for_approval');
      assert.equal((await client.query('select status from issued_invoices where id=$1', [created.draft.id])).rows[0].status, 'draft_pending_confirmation');
      await cancel(created);
    }
    assert.equal(sends.length, 0);
    await writeFact(fact);
    const beforeApproval = await draft();
    await writeFact({ ...fact, registrationId: '100111111111003' });
    await approve(beforeApproval);
    assert.equal((await execute()).held_stale_consequence, 1, 'a fact changed between draft and approval cannot be laundered by approval');
    await cancel(beforeApproval);
    await writeFact(fact);
    const identityChanged = await draft(); await approve(identityChanged);
    await client.query("update client_parties set display_name='Different buyer' where id=$1", [party.id]);
    assert.equal((await execute()).held_stale_consequence, 1, 'party rename cannot change invoice addressee under old approval');
    await cancel(identityChanged);
    await client.query('update client_parties set display_name=$2 where id=$1', [party.id, buyer.name]);
    const recurrenceChanged = await draft(); await approve(recurrenceChanged);
    await client.query("update outbound_actions set payload=jsonb_set(payload,'{recurrence}','{\"interval\":\"monthly\"}') where id=$1", [recurrenceChanged.action.id]);
    assert.equal((await execute()).held_stale_consequence, 1, 'retained recurrence refuses before mail, never poisons finalize');
    await cancel(recurrenceChanged);
    await client.query("update clients set jurisdiction='gb' where id='u15-client'");
    const priorCountry = await draft({ pack: loadOutboundPack('gb'), currency: 'GBP' });
    await approve(priorCountry);
    await client.query("update clients set jurisdiction='ae' where id='u15-client'");
    assert.equal((await execute()).held_stale_consequence, 1, 'old foreign-country action cannot bypass current UAE floor');
    await cancel(priorCountry);
    await client.query("update clients set jurisdiction='gb' where id='u15-client'");
    const conflictingCountry = await draft({ pack: loadOutboundPack('gb'), currency: 'GBP' });
    await approve(conflictingCountry);
    await client.query("update clients set jurisdiction='ae', profile=jsonb_set(profile,'{jurisdiction}','\"gb\"') where id='u15-client'");
    await assert.rejects(draft({ pack: loadOutboundPack('gb'), currency: 'GBP' }), { code: 'OUTBOUND_INVOICE_INVALID' });
    assert.equal((await execute()).held_stale_consequence, 1, 'unresolved conflicting seller identity cannot hide the canonical buyer floor');
    assert.equal(sends.length, 0);
    await cancel(conflictingCountry);
    await client.query("update clients set profile=$1 where id='u15-client'", [profile]);
    // Denormalized detail cannot impersonate the attributed fact history.
    await client.query("update client_parties set detail=jsonb_set(detail,'{tax_registration,actorId}','\"impostor\"') where id=$1", [party.id]);
    await assert.rejects(draft(), { code: 'OUTBOUND_INVOICE_BUYER_FACTS_REQUIRED' });
    await writeFact(fact);
    const sellerChanged = await draft(); await approve(sellerChanged);
    await client.query("update clients set profile=jsonb_set(profile,'{vat_registration,vat_registration_number}','\"100222222222003\"') where id='u15-client'");
    assert.equal((await execute()).held_stale_consequence, 1);
    await cancel(sellerChanged);
    await client.query("update clients set profile=$1 where id='u15-client'", [profile]);
    for (const language of ['en', 'ar']) {
      await setPartyAttribute(client, { ...scope, partyId: party.id, attribute: 'preferred_language',
        value: language, actorType: 'owner', actorId: 'u15-owner' });
      const created = await draft(); await approve(created);
      const stats = await execute(); assert.equal(stats.sent, 1, JSON.stringify(stats));
      const sent = sends.at(-1);
      assert.ok(stripBidiControls(sent.text).includes(fact.registrationId));
      assert.ok(sent.attachments[0].content.subarray(0, 5).toString() === '%PDF-');
      const issued = (await client.query('select * from issued_invoices where id=$1', [created.draft.id])).rows[0];
      assert.equal(issued.status, 'issued');
      assert.equal(issued.cash_basis_skip, true, 'actual accounting writer receipts the cash-basis scope');
      assert.equal(issued.draft.invoice.buyer.taxRegistrationId, fact.registrationId);
      const before = (await client.query("select * from outbound_action_receipts where action_id=$1 and outcome='sent'", [created.action.id])).rows[0];
      assert.equal(before.actual_language, language);
      assert.equal(before.provider_message_id, `fake-${sends.length}`);
      await writeFact({ ...fact, registrationId: '100333333333003' });
      const after = (await client.query('select * from outbound_action_receipts where id=$1', [before.id])).rows[0];
      assert.deepEqual(after, before, 'later party amendment never rewrites sent receipt');
      await writeFact(fact);
    }
    await writeFact({ ...fact, status: 'not_registered', registrationId: null });
    const unregistered = await draft(); await approve(unregistered);
    assert.equal((await execute()).sent, 1, 'explicit unregistered buyer works');
    assert.ok(!stripBidiControls(sends.at(-1).text).includes(fact.registrationId));
  } finally {
    process.chdir(cwd);
    await client.end();
    await admin.query(`drop database "${database}"`);
    await admin.end();
    await rm(cleanConfig, { recursive: true, force: true });
  }
});
