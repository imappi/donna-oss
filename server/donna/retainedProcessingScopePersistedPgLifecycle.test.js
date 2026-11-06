import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { evaluateRetainedProcessingScopeWithClient, PROCESSING_REVIEW_ONLY } from './runtimeReadinessAdmission.js';

// F-2: the retained-scope owner enforces the PERSISTED birth scope for the SG
// hosted-review (legacy26) profile, not only native lineage. Neighbours that
// must keep posting carry no such receipt: FI hosted pilot, ordinary books.
test('real PG: persisted pilot.prepared review-only scope refuses ledger_write; neighbours stay admitted', async t => {
  assert.ok(process.env.DONNA_PG_TEST_URL, 'INCOMPLETE: disposable PostgreSQL is required');
  const admin = new pg.Client({ connectionString: process.env.DONNA_PG_TEST_URL });
  await admin.connect();
  const name = `retained_scope_${process.pid}_${Date.now()}`;
  await admin.query(`create database "${name}"`);
  const url = new URL(process.env.DONNA_PG_TEST_URL); url.pathname = `/${name}`;
  const db = new pg.Client({ connectionString: url.toString() }); await db.connect();
  t.after(async () => { await db.end(); await admin.query(`drop database "${name}"`); await admin.end(); });
  await db.query(`create schema storage;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)`);
  const dir = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()) {
    await db.query(await readFile(new URL(file, dir), 'utf8'));
    await db.query('insert into schema_migrations(version) values($1) on conflict do nothing', [file.slice(0, -4)]);
  }
  await db.query(`insert into firms(id,name,slug) values('f','f','f')`);
  for (const id of ['sg-scoped', 'sg-legacy-receipt', 'fi-pilot', 'ordinary', 'sg-recreated']) {
    await db.query(`insert into clients(id,firm_id,company_name) values($1,'f',$1)`, [id]);
  }
  const prepare = (clientId, metadata) => db.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
    values('f',$1,'firm_member','m','pilot.prepared','client',$1,$2::jsonb)`, [clientId, JSON.stringify(metadata)]);
  await prepare('sg-scoped', { version: 'donna.sg-hosted-review.v1', authority_basis: 'authenticated_singapore_firm_creation',
    processing_scope: 'document_processing_review_only', accounting_ready: false, automatic_posting: false });
  // A hosted-SG receipt from before the scope field existed fails closed via its authority basis.
  await prepare('sg-legacy-receipt', { version: 'donna.sg-hosted-review.v1', authority_basis: 'authenticated_singapore_firm_creation' });
  await prepare('fi-pilot', { version: 'donna.hosted-pilot.v1', authority_basis: 'authenticated_finnish_firm_creation',
    material_authority_granted: false, external_sends: false, filing: false });
  // A previous life's receipt does not bind a recreated client.
  await prepare('sg-recreated', { authority_basis: 'authenticated_singapore_firm_creation', processing_scope: 'document_processing_review_only' });
  await db.query(`insert into audit_events(firm_id,action,resource_type,resource_id) values('f','client.delete','client','sg-recreated')`);

  const decide = clientId => evaluateRetainedProcessingScopeWithClient({ client: db, firmId: 'f', clientId, lock: false });
  for (const id of ['sg-scoped', 'sg-legacy-receipt']) {
    const decision = await decide(id);
    assert.equal(decision.allowed, false, id);
    assert.equal(decision.enforced, true);
    assert.equal(decision.reason_code, PROCESSING_REVIEW_ONLY);
    assert.equal(decision.retryable, false);
    assert.equal(decision.entity_receipt_ref.store, 'audit_events');
  }
  for (const id of ['fi-pilot', 'ordinary', 'sg-recreated']) {
    const decision = await decide(id);
    assert.deepEqual([decision.allowed, decision.enforced, decision.reason_code], [true, false, null], id);
  }
});
