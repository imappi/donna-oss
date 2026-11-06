// Named profile writer against disposable PostgreSQL, including a change between
// initial validation and its locked write. No provider or production data access.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { updateClientProfileInDb, getOwnerInvoiceSellerContextInDb } from './firmDb.js';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from './db/pool.js';
import { resolveOwnerInvoiceSellerContext } from './ownerInvoiceSellerContext.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;

test('real PG: country profile validation uses persisted identity and rechecks under the named writer lock', {
  skip: pgUrl ? false : 'DONNA_PG_TEST_URL not set — disposable-PG profile lifecycle not exercised'
}, async (t) => {
  const name = `donna_jn_profile_${Date.now().toString(36)}_${process.pid}`;
  const admin = new pg.Client({ connectionString: pgUrl });
  await admin.connect();
  await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  __setFirmDbPoolForTests(pool);
  const connectionsClosed = [];
  pool.on('connect', (connection) => connectionsClosed.push(new Promise((resolve) => connection.once('end', resolve))));
  let client;
  t.after(async () => {
    __resetFirmDbPoolForTests();
    client?.release();
    await pool.end();
    await Promise.all(connectionsClosed);
    await admin.query(`drop database "${name}"`);
    await admin.end();
  });
  await pool.query(`create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb);`);
  const migrationRoot = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrationRoot)).filter((name) => name.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(file, migrationRoot), 'utf8'));
  }
  const firmId = 'profile-fixture-firm';
  await pool.query("insert into firms (id, name, slug) values ($1, 'Profile fixture', 'profile-fixture')", [firmId]);
  for (const jurisdiction of ['sg', 'fi', 'gb', 'ae', 'us', 'au', null, 'zz']) {
    const id = jurisdiction || 'missing';
    await pool.query(`insert into clients (id, firm_id, company_name, jurisdiction, profile)
      values ($1, $2, 'Profile fixture', $3, $4::jsonb)`,
    [id, firmId, jurisdiction?.toUpperCase() || null, JSON.stringify(jurisdiction ? { jurisdiction } : {})]);
  }
  client = await pool.connect();
  const write = (clientId, profilePatch, dbClient = client) => updateClientProfileInDb({ firmId, clientId, profilePatch, actorId: 'fixture-owner', dbClient });
  const row = async (id) => (await pool.query('select * from clients where id = $1', [id])).rows[0];
  const seller = (clientId, onDate = '2026-06-01') => getOwnerInvoiceSellerContextInDb({ firmId, clientId, onDate });
  const audits = async () => (await pool.query("select * from audit_events where action = 'client.profile.update' order by id")).rows;
  const trn = { status: 'registered', registered_from: '2026-01-01', vat_registration_number: '100123456789012', vat_return_period: 'quarterly' };

  await write('ae', { vat_registration: trn, ct_registration: { status: 'not_registered' } });
  assert.equal((await row('ae')).profile.vat_registration.vat_return_period, 'quarter');
  assert.equal((await row('ae')).profile.vat_registration.vat_registration_number, trn.vat_registration_number);
  assert.equal((await row('ae')).profile.ct_registration.status, 'not_registered');
  await write('gb', { vat_registration: { status: 'not_registered' }, gb: { vat_stagger: 2, completion_evidence: { keep: true } } });
  await write('gb', { gb: { vat_stagger: null } });
  assert.deepEqual((await row('gb')).profile.gb, { vat_stagger: null, completion_evidence: { keep: true } });
  await write('fi', { yel: { exempt: true }, alv_registration: { status: 'not_registered' }, verokausi: 'annual' });
  assert.equal((await row('fi')).profile.verokausi, 'year');
  await write('sg', { gst_registration: { status: 'not_registered' }, gst_period: 'Quarterly', uen: ' 202000001a ' });
  assert.equal((await row('sg')).profile.uen, '202000001A');
  for (const id of ['us', 'au', 'missing', 'zz']) {
    await write(id, { future_field: { preserved: true } });
    assert.deepEqual((await row(id)).profile.future_field, { preserved: true });
    const before = await row(id);
    const receipts = await audits();
    await assert.rejects(write(id, { vat_registration: { status: 'not_registered' } }), (error) => error.statusCode === 400 && error.code.startsWith('profile_'));
    assert.deepEqual(await row(id), before, 'refusal changes no client bytes');
    assert.deepEqual(await audits(), receipts, 'refusal mints no successful update receipt');
    await write(id, { vat_registration: null });
    assert.equal((await row(id)).profile.vat_registration, null, 'a clear needs no invented country');
  }
  for (const id of ['sg', 'fi', 'gb', 'ae', 'us', 'au']) {
    assert.equal((await row(id)).entity_type, null, 'country and tax facts never infer legal form');
  }
  for (const id of ['sg', 'fi', 'gb', 'ae', 'us', 'au', 'missing', 'zz']) {
    assert.deepEqual(await seller(id), resolveOwnerInvoiceSellerContext(await row(id), { onDate: '2026-06-01' }), 'real seller loader consumes the persisted row for every country');
  }
  assert.equal(await seller('does-not-exist'), null);
  assert.equal(await getOwnerInvoiceSellerContextInDb({ firmId: 'other-firm', clientId: 'ae', onDate: '2026-06-01' }), null, 'seller lookup preserves firm isolation');
  assert.equal((await seller('ae', new Date(2026, 5, 1))).seller.taxRegistered, true, 'local PostgreSQL date representation preserves registration date');
  assert.ok((await audits()).every((receipt) => receipt.actor_id === 'fixture-owner'));

  await pool.query("update clients set profile = profile || '{\"jurisdiction\":\"gb\"}'::jsonb where id = 'ae'");
  const conflicted = await row('ae');
  assert.equal((await seller('ae')).pack, null, 'conflicting identity cannot load a pack');
  assert.equal((await seller('ae')).taxRegistration.reason, 'jurisdiction_context_conflict');
  const receipts = await audits();
  await assert.rejects(write('ae', { vat_registration: trn }), (error) => error.code === 'jurisdiction_context_conflict');
  assert.deepEqual(await row('ae'), conflicted);
  assert.deepEqual(await audits(), receipts);
  await write('ae', { jurisdiction: 'ae', vat_registration: trn });
  assert.equal((await row('ae')).jurisdiction, 'AE');
  assert.equal((await row('ae')).profile.jurisdiction, 'ae');
  assert.equal((await row('ae')).profile.jurisdiction_confirmed_by, 'fixture-owner');

  // A historical profile country is evidence, not authority after the canonical
  // column was cleared. The explicit named repair supplies destination identity.
  await pool.query("update clients set jurisdiction=null where id='ae'");
  const legacyCountry = await row('ae');
  assert.equal((await seller('ae')).jurisdiction, null);
  const legacyAudits = await audits();
  await assert.rejects(write('ae', { vat_registration: trn }), { code: 'profile_jurisdiction_unresolved' });
  assert.deepEqual(await row('ae'), legacyCountry);
  assert.deepEqual(await audits(), legacyAudits);
  await write('ae', { jurisdiction: 'ae', vat_registration: trn });
  assert.equal((await row('ae')).jurisdiction, 'AE');
  assert.equal((await seller('ae')).seller.taxRegistered, true);

  await pool.query("update clients set jurisdiction=null where id='gb'");
  const absentLegalCountry = await row('gb');
  for (const entity_type of ['Limited company', 'gb-ltd']) await assert.rejects(write('gb', { entity_type }));
  assert.deepEqual(await row('gb'), absentLegalCountry, 'legal-form-only correction cannot revive the historical profile country');
  await write('gb', { accounting_system: 'procountor' });
  assert.equal((await row('gb')).jurisdiction, null, 'undecidable setup preference cannot revive profile jurisdiction');
  assert.equal((await row('gb')).profile.jurisdiction, 'gb', 'historical country evidence is preserved');
  assert.equal((await pool.query("select count(*)::int n from ledger_accounts where client_id='gb'")).rows[0].n, 0, 'setup preference creates no inferred country chart');
  await assert.rejects(write('gb', { jurisdiction: 'gb', accounting_system: 'procountor' }), { statusCode: 400 });
  await write('gb', { jurisdiction: 'gb', entity_type: 'gb-ltd' });
  assert.equal((await row('gb')).jurisdiction, 'GB');
  assert.equal((await row('gb')).entity_type, 'gb-ltd');

  for (const cleared of [null, '', 'unknown']) {
    await write('ae', { jurisdiction: cleared });
    const clearedRow = await row('ae');
    assert.equal(clearedRow.jurisdiction, null);
    assert.equal(clearedRow.profile.jurisdiction, cleared === '' ? null : cleared);
    assert.equal(clearedRow.profile.vat_registration, null, 'clearing identity disarms the old tax fact too');
    const clearReceipts = await audits();
    await assert.rejects(write('ae', { vat_registration: trn }), (error) => error.code === 'profile_jurisdiction_unresolved');
    assert.deepEqual(await row('ae'), clearedRow);
    assert.deepEqual(await audits(), clearReceipts);
    await write('ae', { jurisdiction: 'ae' });
  }

  // The mounted setup shape changes only country and clears legal form. It
  // must disarm old tax facts itself, never require unsupported UI tax clears.
  for (const previousVat of [
    { status: 'not_registered' },
    { status: 'registered', registered_from: '2026-01-01', vat_registration_number: 'GB123456789' }
  ]) {
    await write('gb', { jurisdiction: 'gb', vat_registration: previousVat, gb: { vat_stagger: 1 }, future_field: 'keep me' });
    const previousRow = await row('gb');
    await write('gb', { jurisdiction: 'UK' });
    assert.deepEqual((await row('gb')).profile.vat_registration, previousRow.profile.vat_registration, 'same canonical country preserves recorded facts');
    assert.equal((await audits()).at(-1).metadata.country_facts_invalidated, undefined);
    await write('gb', { jurisdiction: 'ae', entity_type: null });
    const destination = await row('gb');
    assert.equal(destination.jurisdiction, 'AE');
    assert.equal(destination.profile.vat_registration, null);
    assert.equal(destination.profile.gb, null);
    assert.equal(destination.profile.future_field, 'keep me');
    assert.equal((await seller('gb')).seller.taxRegistered, null, 'actual seller resolver cannot reinterpret previous VAT');
    const invalidated = (await audits()).at(-1).metadata.country_facts_invalidated;
    assert.equal(invalidated.reason, 'jurisdiction_changed');
    assert.equal(invalidated.previous_identity.jurisdiction, 'GB');
    assert.deepEqual(invalidated.previous_values.vat_registration, previousRow.profile.vat_registration);
    assert.deepEqual(invalidated.previous_values.gb, previousRow.profile.gb);
    await write('gb', { vat_registration: trn });
    assert.equal((await seller('gb')).seller.taxRegistered, true, 'fresh destination facts recover through same writer');
  }
  await write('gb', { jurisdiction: 'gb', vat_registration: { status: 'not_registered' }, gb: { vat_stagger: 3 } });
  assert.equal((await row('gb')).profile.vat_registration.status, 'not_registered', 'explicit destination replacement is validated and retained');

  // A legacy conflicting identity can carry an old nested country object.
  // Explicit destination replacement must not deep-merge those old siblings.
  await pool.query("update clients set jurisdiction = 'AE', profile = profile || '{\"gb\":{\"vat_stagger\":1,\"completion_evidence\":{\"old\":true}}}'::jsonb where id = 'gb'");
  await write('gb', { jurisdiction: 'gb', gb: { vat_stagger: 2 } });
  assert.deepEqual((await row('gb')).profile.gb, { vat_stagger: 2 });
  assert.deepEqual((await audits()).at(-1).metadata.country_facts_invalidated.previous_values.gb,
    { vat_stagger: 1, completion_evidence: { old: true } });

  // Another transaction changes the actual identity after initial validation.
  // Revalidation must invoke the new country's validator, refusing the old TRN.
  let changed = false;
  let afterIdentityAudit;
  const racingClient = { query: async (sql, values) => {
    const result = await client.query(sql, values);
    if (!changed && String(sql).startsWith('select jurisdiction, profile') && !String(sql).includes('for update')) {
      changed = true;
      const concurrent = await pool.connect();
      try { await write('ae', { jurisdiction: 'gb', entity_type: null }, concurrent); }
      finally { concurrent.release(); }
      afterIdentityAudit = await audits();
    }
    return result;
  } };
  const beforeRaceAudit = await audits();
  await assert.rejects(write('ae', { vat_registration: trn }, racingClient), (error) => error.statusCode === 400 && /vat_registration_number/.test(error.message));
  assert.equal(changed, true);
  assert.equal((await row('ae')).profile.vat_registration, null);
  assert.equal(afterIdentityAudit.length, beforeRaceAudit.length + 1, 'only the concurrent identity correction receipts a write');
  assert.deepEqual(await audits(), afterIdentityAudit);
  assert.equal((await pool.query('select count(*)::int as n from ledger_journals')).rows[0].n, 0);
});
