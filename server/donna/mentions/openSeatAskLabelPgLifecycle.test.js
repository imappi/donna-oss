// A staff question about a standing subject is labelled for what it is.
//
// Real PostgreSQL. A physical stock count opens through the real
// openPhysicalReconciliation, which mints a seat ask addressed to the counter,
// anchored on the count line (no transaction, no document). The Mentions lane
// read (listOpenSeatAsksForPrincipal) and its digest must not call it a
// document: it is a physical count line, with that line's id.
// Synthetic world only. Skips without DONNA_PG_TEST_URL.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';

import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from '../firmDb.js';
import { setClientFlagStage } from '../clientConfig.js';
import { applyInventoryOperation } from '../inventory/db.js';
import { openPhysicalReconciliation } from '../inventory/physicalReconciliationDb.js';
import { listOpenSeatAsksForPrincipal } from './notificationsDb.js';
import { buildMentionDigest } from './notificationEvents.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;

test('real PG: an open seat ask about a physical count line is labelled physical_count_line, never document', {
  skip: !pgUrl && 'DONNA_PG_TEST_URL required', timeout: 300_000
}, async (t) => {
  const admin = new pg.Client({ connectionString: pgUrl });
  await admin.connect();
  const name = `seat_ask_label_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl); url.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  const pool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  __setFirmDbPoolForTests(pool);
  t.after(async () => {
    __resetFirmDbPoolForTests();
    await pool.end();
    await client.end();
    await admin.query(`drop database "${name}" with (force)`);
    await admin.end();
  });
  await client.query('create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)');
  const root = new URL('../../../db/migrations/', import.meta.url);
  for (const f of (await readdir(root)).filter((f) => f.endsWith('.sql')).sort()) await client.query(await readFile(new URL(f, root), 'utf8'));

  const firmId = 'firm-count', clientId = 'client-count';
  const seats = { counter: 'seat-counter', reviewer: 'seat-reviewer', senior: 'seat-senior' };
  const calendar = { timeZone: 'Europe/Helsinki', workingDays: [1, 2, 3, 4, 5], holidays: [] };
  const coverage = {
    reviewer: { principalType: 'firm_collaborator', principalId: seats.reviewer },
    senior: { principalType: 'firm_collaborator', principalId: seats.senior },
    calendar
  };
  const a = { client, firmId, clientId, actorId: seats.counter, actorType: 'firm_collaborator' };
  await client.query("insert into firms(id,name,slug) values($1,'Synthetic Count Firm',$1)", [firmId]);
  await client.query("insert into clients(id,firm_id,company_name,profile) values($1,$2,'Synthetic Varasto Oy',$3::jsonb)",
    [clientId, firmId, JSON.stringify({ physical_reconciliation: coverage })]);
  for (const [key, id] of Object.entries(seats)) {
    await client.query("insert into firm_collaborators(id,firm_id,email,name,status) values($1,$2,$3,$1,'active')", [id, firmId, `${id}@count.invalid`]);
    await client.query("insert into client_assignments(id,firm_id,client_id,principal_type,principal_id,role) values($1,$2,$3,'firm_collaborator',$4,$5)",
      [`${id}-assignment`, firmId, clientId, id, key === 'counter' ? 'owner' : 'senior']);
  }
  for (const flagKey of ['INVENTORY_CORE', 'PHYSICAL_RECONCILIATION', 'PHYSICAL_INVENTORY_APPLY']) await setClientFlagStage(client, { ...a, flagKey, stage: 'canary' });
  await client.query("insert into inventory_units_of_measure(id,firm_id,client_id,code,name,kind) values('uom-each',$1,$2,'EA','Each','count')", [firmId, clientId]);
  await client.query("insert into inventory_items(id,firm_id,client_id,sku,name,base_uom_id) values('item-shelf',$1,$2,'SKU-1','Synthetic item','uom-each')", [firmId, clientId]);
  await client.query("insert into inventory_locations(id,firm_id,client_id,code,name) values('loc-a',$1,$2,'A','Shelf A')", [firmId, clientId]);
  const opened = await applyInventoryOperation({ ...a, itemId: 'item-shelf', locationId: 'loc-a', uomId: 'uom-each', idempotencyKey: 'opening-1',
    operationType: 'opening_balance', quantity: 10, unitCostAmount: 5, unitCostCurrency: 'EUR', occurredAt: '2026-01-01' });
  assert.equal(opened.applied, true);
  const session = await openPhysicalReconciliation({ ...a, locationId: 'loc-a', itemIds: ['item-shelf'], idempotencyKey: 'count-1' });
  assert.equal(session.applied, true, JSON.stringify(session));
  const lineId = String(session.lines[0].id);

  const asks = await listOpenSeatAsksForPrincipal({ firmId, principal: { principalType: 'firm_collaborator', principalId: seats.counter } });
  assert.equal(asks.length, 1, JSON.stringify(asks));
  const [ask] = asks;
  assert.equal(ask.transaction_id, null);
  assert.equal(ask.document_id, null);
  assert.notEqual(ask.artifact_type, 'document', 'a count-line question is not a document');
  assert.equal(ask.artifact_type, 'physical_count_line');
  assert.equal(ask.artifact_id, lineId);

  const digest = buildMentionDigest({ openAsks: asks, notifications: [] });
  assert.equal(digest.ask_count, 1);
  assert.doesNotMatch(digest.items[0], /asked on document/);
  assert.match(digest.items[0], new RegExp(`asked on physical_count_line ${lineId}:`));
});
