import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { setClientFlagStage } from '../clientConfig.js';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { writeValidatedJournalWithinTransaction } from '../ledgerPostingGateway.js';
import { valueInventoryOperations } from './valuation.js';
import { buildInventoryJournalDraft } from './posting.js';
import { upsertLedgerAccountForJournal } from '../db/ledger.js';
import { applyInventoryOperation, applyInventoryOperationWithinTransaction } from './db.js';
import { openPhysicalReconciliation, observePhysicalReconciliation, resolvePhysicalReconciliation, getPhysicalReconciliation } from './physicalReconciliationDb.js';

const options = {};
let testUrl, admin, databaseName;
before(async () => {
  assert.ok(process.env.DONNA_PG_TEST_URL, 'INCOMPLETE: DONNA_PG_TEST_URL required for physical PostgreSQL lifecycle');
  admin = new pg.Client({ connectionString: process.env.DONNA_PG_TEST_URL }); await admin.connect();
  databaseName = `inventory_physical_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`create database "${databaseName}"`);
  const url = new URL(process.env.DONNA_PG_TEST_URL); url.pathname = `/${databaseName}`; testUrl = url.toString();
  const db = new pg.Client({ connectionString: testUrl }); await db.connect();
  try {
    await db.query('create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]); create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)');
    const root = new URL('../../../db/migrations/', import.meta.url);
    for (const file of (await readdir(root)).filter(f => f.endsWith('.sql')).sort()) await db.query(await readFile(new URL(file, root), 'utf8'));
  } finally { await db.end(); }
});
after(async () => {
  if (admin) { try { if (databaseName) await admin.query(`drop database if exists "${databaseName}" with (force)`); } finally { await admin.end(); } }
});
async function fixture(fn) {
  const client = new pg.Client({ connectionString: testUrl });
  await client.connect();
  const id = `physical-${randomUUID()}`;
  const a = { client, firmId: `${id}-firm`, clientId: `${id}-client`, actorId: `${id}-owner`, actorType: 'firm_member' };
  try {
    await client.query('insert into firms(id,name,slug) values($1,$1,$1)', [a.firmId]);
    for (const actorId of [a.actorId, `${id}-reviewer`]) await client.query("insert into firm_members(id,firm_id,email,name,status,access_level) values($1,$2,$3,$1,'active','owner')", [actorId, a.firmId, `${actorId}@example.invalid`]);
    await client.query('insert into clients(id,firm_id,company_name) values($1,$2,$1)', [a.clientId, a.firmId]);
    for (const flag of ['INVENTORY_CORE', 'PHYSICAL_RECONCILIATION', 'PHYSICAL_INVENTORY_APPLY']) await setClientFlagStage(client, { ...a, flagKey: flag, stage: 'canary' });
    await client.query('update clients set profile=$2::jsonb where id=$1', [a.clientId, JSON.stringify({ physical_reconciliation: { reviewer: { principalType: 'firm_member', principalId: a.actorId }, senior: { principalType: 'firm_member', principalId: `${id}-reviewer` }, calendar: { timeZone: 'Europe/London', workingDays: [1,2,3,4,5], holidays: [] }, variancePolicy: { maxAbsoluteValue: 100, maxPercentage: 30, currency: 'GBP' } } })]);
    const uomId = `${id}-each`, itemId = `${id}-item`, locationId = `${id}-location`, documentId = `${id}-photo`;
    await client.query("insert into inventory_units_of_measure(id,firm_id,client_id,code,name,kind) values($1,$2,$3,'EA','Each','count')", [uomId, a.firmId, a.clientId]);
    await client.query("insert into inventory_items(id,firm_id,client_id,sku,name,base_uom_id) values($1,$2,$3,'SKU','Known SKU',$4)", [itemId, a.firmId, a.clientId, uomId]);
    await client.query("insert into inventory_locations(id,firm_id,client_id,code,name) values($1,$2,$3,'A','Shelf A')", [locationId, a.firmId, a.clientId]);
    const checksum = 'a'.repeat(64);
    await client.query("insert into documents(id,firm_id,client_id,filename,checksum_sha256,storage_object_key,payload) values($1,$2,$3,'count.jpg',$4,$5,jsonb_build_object('mime_type','image/jpeg','file_size',42))", [documentId, a.firmId, a.clientId, checksum, `${a.clientId}/count.jpg`]);
    const seed = await applyInventoryOperation({ ...a, itemId, locationId, uomId, idempotencyKey: `${id}-seed`, operationType: 'opening_balance', quantity: 10, unitCostAmount: 5, unitCostCurrency: 'GBP', occurredAt: '2026-01-01T00:00:00Z' });
    assert.equal(seed.applied, true, JSON.stringify(seed));
    let n = 0;
    const cmd = () => `${id}:command-${++n}`;
    const open = async () => {
      const r = await openPhysicalReconciliation({ ...a, locationId, itemIds: [itemId], idempotencyKey: cmd() });
      assert.equal(r.applied, true, JSON.stringify(r));
      return r;
    };
    const observe = async (session, quantity = 8, extra = {}) => {
      const r = await observePhysicalReconciliation({ ...a, sessionId: session.session.id, lineId: session.lines[0].id, idempotencyKey: cmd(),
        observedQuantity: quantity, evidenceRefs: [{ documentId, checksum }], observedAt: new Date().toISOString(), humanConfirmed: true, confidence: 1, ...extra });
      return r;
    };
    const resolve = async (session, extra = {}) => {
      const current = await getPhysicalReconciliation({ ...a, sessionId: session.session.id });
      return resolvePhysicalReconciliation({ ...a, actorId: `${id}-reviewer`, sessionId: session.session.id, lineId: session.lines[0].id,
      expectedObservationDigest: current.lines[0].physical_observation?.inputDigest,
      idempotencyKey: cmd(), action: 'confirmed_shortage', reason: 'Independent manual recount confirms missing units.', ...extra });
    };
    const level = async () => Number((await client.query('select on_hand from inventory_item_levels where client_id=$1', [a.clientId])).rows[0].on_hand);
    const accountingOn = async ({ priorUse = true } = {}) => {
      await setClientFlagStage(client, { ...a, flagKey: 'INVENTORY_ACCOUNTING', stage: 'canary' });
      for (const [i, role] of ['asset.inventory', 'pnl.inventory_count_variance'].entries()) await upsertLedgerAccountForJournal({ ...a, account: { code: `100${i}`, name: role, type: i ? 'expense' : 'asset', canonical_role: role }, currency: 'GBP' });
      if (priorUse) {
        // Legitimate earlier receipt + shrinkage through the real stock and journal writers
        // establish account use without fabricating a policy flag. Net current stock stays 10.
        const roles = { 'asset.inventory': { code:'1000',name:'asset.inventory',type:'asset',canonical_role:'asset.inventory' },
          'pnl.inventory_count_variance': { code:'1001',name:'pnl.inventory_count_variance',type:'expense',canonical_role:'pnl.inventory_count_variance' },
          'liability.grni': { code:'2000',name:'Goods received not invoiced',type:'liability',canonical_role:'liability.grni' } };
        for (const [i, movement] of [{ operationType:'receipt', quantity:2, unitCostAmount:5, unitCostCurrency:'GBP' },{ operationType:'count_correction', quantity:-2 }].entries()) {
          const posted = await applyInventoryOperation({ ...a,itemId,locationId,uomId,idempotencyKey:cmd(),occurredAt:`2026-02-0${i+1}T00:00:00Z`,...movement });
          assert.equal(posted.applied,true,JSON.stringify(posted));
          const ops = (await client.query('select * from inventory_operations where client_id=$1 order by occurred_at,id',[a.clientId])).rows;
          const valuation = valueInventoryOperations({operations:ops});
          const effect = valuation.receipt.operationEffects.find(e=>String(e.operationId)===String(posted.receipt.operationId));
          const draft = buildInventoryJournalDraft({ effect,roleAccounts:roles,valuationRunId:valuation.receipt.valuationRunId });
          await client.query('begin');
          try { await writeValidatedJournalWithinTransaction(client,draft.journal,a); await client.query('commit'); }
          catch(e) {await client.query('rollback');throw e;}
        }
      }

    };
    const grant = async () => client.query(`insert into inventory_posting_authority_grants(id,firm_id,client_id,allowed_posting_kinds,allowed_accounts,per_journal_ceiling,currency,evidence_required,authorized_by_actor_type,authorized_by_actor_id,source,status,valid_from)
      values($1,$2,$3,ARRAY['count_adjustment'],ARRAY['asset.inventory','pnl.inventory_count_variance'],1000,'GBP',true,'user',$4,'accountant_approval','active','2026-01-01')`, [`${id}-grant`, a.firmId, a.clientId, a.actorId]);
    await fn({ a, client, itemId, locationId, uomId, documentId, checksum, open, observe, resolve, level, accountingOn, grant, cmd });
  } finally {
    await client.query('rollback').catch(() => {});
    // Audit remains immutable until the test-owned database is dropped.
    await client.end();
  }
}

test('physical: blind matched observation is no-op with durable source provenance', options, async () => fixture(async ({ a, client, open, observe, level }) => {
  const s = await open();
  assert.equal(s.lines[0].expected_quantity, null);
  const r = await observe(s, 10);
  assert.equal(r.applied, true, JSON.stringify(r));
  assert.equal(r.lines[0].physical_status, 'matched');
  assert.equal(r.session.state, 'closed');
  assert.equal(await level(), 10);
  assert.equal((await client.query('select count(*)::int n from inventory_operations where client_id=$1', [a.clientId])).rows[0].n, 1);
  assert.equal(r.lines[0].physical_observation.assurance.professionalAssurance, 'absent');
  assert.equal(r.lines[0].physical_observation.modelStatus, 'not_used');
  assert.equal((await client.query('select status from bookkeeping_cases where id=$1', [r.lines[0].case_id])).rows[0].status, 'resolved');
}));

test('physical: shortage applies exactly once, retains evidence, case and structured exception history', options, async () => fixture(async ({ a, client, open, observe, resolve, level }) => {
  const s = await open();
  const observed = await observe(s);
  assert.equal(observed.applied, true, JSON.stringify(observed));
  assert.equal(await level(), 10);
  const r = await resolve(s, { idempotencyKey: 'retry' });
  assert.equal(r.applied, true, JSON.stringify(r));
  assert.equal(await level(), 8);
  assert.equal(r.receipt.accounting.status, 'disabled');
  assert.equal(r.lines[0].physical_resolution.learning.laterOutcome.status, 'unknown');
  assert.equal(r.lines[0].payload.versions.length, 2);
  assert.equal((await resolve(s, { idempotencyKey: 'retry' })).receipt.replayed, true);
  assert.equal((await resolve(s, { idempotencyKey: 'retry', reason: 'Different input' })).reason, 'idempotency_conflict');
  assert.equal((await client.query("select count(*)::int n from inventory_operations where client_id=$1 and operation_type='count_correction'", [a.clientId])).rows[0].n, 1);
  const correction = (await client.query('select payload from inventory_operations where id=$1', [r.receipt.operationId])).rows[0];
  assert.equal(correction.payload.evidence[0].documentId, observed.lines[0].physical_observation.evidenceRefs[0].documentId);
  assert.equal((await client.query('select status from inventory_anomalies where id=$1', [r.lines[0].anomaly_id])).rows[0].status, 'resolved');
}));

test('physical: stale/backdated movement refuses adjustment; recount preserves prior versions', options, async () => fixture(async ({ a, itemId, locationId, uomId, open, observe, resolve, level }) => {
  const s = await open(); await observe(s);
  assert.equal((await applyInventoryOperation({ ...a, itemId, locationId, uomId, idempotencyKey: `${a.clientId}-move`, operationType: 'receipt', quantity: 2, unitCostAmount: 5, unitCostCurrency: 'GBP', occurredAt: '2026-02-01' })).applied, true);
  assert.equal((await resolve(s)).reason, 'stale_expectation');
  assert.equal(await level(), 12);
  const recount = await resolve(s, { action: 'recount_required' });
  assert.equal(recount.applied, true, JSON.stringify(recount));
  assert.equal(recount.lines[0].physical_observation, null);
  assert.equal(recount.lines[0].payload.blindCount, true);
  const second = await observe(s, 12);
  assert.equal(second.applied, true, JSON.stringify(second));
  assert.equal(second.lines[0].physical_status, 'matched');
  assert.equal(second.lines[0].payload.versions.length, 3);
}));

test('physical: uncertainty is explicitly owned; no adjustment or implicit zero', options, async () => fixture(async ({ a, client, open, observe, resolve, level }) => {
  const s = await open();
  const r = await observe(s, 8, { uncertain: true });
  assert.equal(r.applied, true, JSON.stringify(r));
  assert.equal(r.lines[0].physical_status, 'uncertain');
  assert.equal(r.lines[0].payload.owner.actorId, a.actorId);
  assert.ok(r.lines[0].payload.owner.dueAt);
  assert.equal((await resolve(s)).reason, 'human_confirmation_required');
  assert.equal(await level(), 10);
  assert.equal((await client.query('select status from bookkeeping_cases where id=$1', [r.lines[0].case_id])).rows[0].status, 'waiting_client');
  assert.equal((await observe(s, null)).reason, 'invalid_quantity');
}));

test('physical: unexplained positive stock stays in review', options, async () => fixture(async ({ open, observe, resolve, level }) => {
  const s = await open(); await observe(s, 12);
  assert.equal((await resolve(s, { action: 'confirmed_found_stock' })).reason, 'found_stock_requires_cause_review');
  assert.equal(await level(), 10);
}));

test('physical: evidence tenant, digest, future time and stale source refusal', options, async () => fixture(async ({ a, client, open, observe, resolve, checksum }) => {
  const s = await open();
  assert.equal((await observe(s, 8, { evidenceRefs: [{ documentId: 'foreign-document', checksum }] })).reason, 'evidence_scope_or_checksum_refused');
  assert.equal((await observe(s, 8, { observedAt: '2099-01-01' })).reason, 'observation_outside_basis');
  const observed = await observe(s);
  assert.equal(observed.applied, true, JSON.stringify(observed));
  await client.query("update documents set checksum_sha256=$2 where client_id=$1", [a.clientId, 'b'.repeat(64)]);
  assert.equal((await resolve(s)).reason, 'evidence_scope_or_checksum_refused');
}));

test('physical: authorization rechecked after lock, feature/apply gates default deny', options, async () => fixture(async ({ a, client, open, observe, resolve, level }) => {
  const s = await open(); await observe(s);
  await assert.rejects(resolve(s, { authorize: async () => { throw new Error('seat_revoked'); } }), /seat_revoked/);
  assert.equal(await level(), 10);
  await client.query("update client_capability_config set stage='off' where client_id=$1 and flag_key='PHYSICAL_INVENTORY_APPLY'", [a.clientId]);
  assert.equal((await resolve(s)).reason, 'stale_expectation');
  assert.equal((await getPhysicalReconciliation({ ...a, firmId: 'wrong-firm', sessionId: s.session.id })).reason, 'scope_refused');
}));

test('physical: priced shortage posts existing gateway journal with enforced grant', options, async () => fixture(async ({ a, client, open, observe, resolve, accountingOn, grant, level }) => {
  await accountingOn(); await grant();
  const s = await open(); await observe(s);
  const r = await resolve(s);
  assert.equal(r.applied, true, JSON.stringify(r));
  assert.equal(r.receipt.accounting.status, 'posted');
  assert.equal(await level(), 8);
  const totals = (await client.query('select sum(debit)::numeric d,sum(credit)::numeric c from ledger_lines where journal_id=$1', [r.receipt.accounting.ledger_journal_id])).rows[0];
  assert.equal(Number(totals.d), 10); assert.equal(Number(totals.c), 10);
  const link = (await client.query('select * from inventory_journal_allocations where operation_id=$1 and client_id=$2', [String(r.receipt.operationId), a.clientId])).rows[0];
  assert.equal(Number(link.allocated_amount), 10);
  assert.equal(r.receipt.consequence.serviceSignoff, 'not_issued');
}));

test('physical: absent posting authority rolls correction, evidence resolution and case back atomically', options, async () => fixture(async ({ a, client, open, observe, resolve, accountingOn, level }) => {
  await accountingOn();
  const s = await open(); const observed = await observe(s);
  const r = await resolve(s);
  assert.equal(r.reason, 'accounting_refused', JSON.stringify(r));
  assert.equal(r.detail.posting.reason_code, 'authority_no_grant');
  assert.equal(await level(), 10);
  const after = await getPhysicalReconciliation({ ...a, sessionId: s.session.id });
  assert.equal(after.lines[0].physical_status, 'variance');
  assert.equal(after.lines[0].physical_resolution, null);
  assert.deepEqual(after.lines[0].physical_observation, observed.lines[0].physical_observation);
  assert.equal((await client.query("select count(*)::int n from inventory_operations where client_id=$1 and operation_type='count_correction' and reference_type='count_session'", [a.clientId])).rows[0].n, 0);
  assert.equal((await client.query('select status from inventory_anomalies where id=$1', [after.lines[0].anomaly_id])).rows[0].status, 'open');
}));

test('physical: audit failure after correction rolls the entire resolution back', options, async () => fixture(async ({ a, open, observe, resolve, level }) => {
  const s = await open(); await observe(s);
  const original = a.client.query.bind(a.client);
  a.client.query = (sql, args) => String(sql).includes('insert into audit_events') && args?.[3] === 'inventory.physical.resolve' ? Promise.reject(new Error('audit unavailable')) : original(sql, args);
  await assert.rejects(resolve(s), /audit unavailable/);
  a.client.query = original;
  assert.equal(await level(), 10);
  const after = await getPhysicalReconciliation({ ...a, sessionId: s.session.id });
  assert.equal(after.lines[0].physical_resolution, null);
  assert.equal(after.lines[0].physical_status, 'variance');
}));

test('physical: every resolution binds the reviewed observation and uses an independent accepting actor', options, async () => fixture(async ({ a, open, observe, resolve, level }) => {
  const s = await open(); const first = await observe(s, 8); await observe(s, 7);
  for (const action of ['confirmed_shortage', 'dismissed', 'uncertain', 'recount_required']) {
    const r = await resolve(s, { action, expectedObservationDigest: first.lines[0].physical_observation.inputDigest });
    assert.equal(r.reason, 'stale_observation', JSON.stringify(r));
  }
  assert.equal((await resolve(s, { actorId: a.actorId })).reason, 'second_reviewer_required');
  assert.equal(await level(), 10);
}));

test('physical: unknown/occluded quantity is null, never inferred zero', options, async () => fixture(async ({ open, observe, resolve, level }) => {
  const s = await open(); const r = await observe(s, null, { uncertain: true, notes: { visibility: 'occluded' } });
  assert.equal(r.applied, true, JSON.stringify(r));
  assert.equal(r.lines[0].counted_quantity, null);
  assert.equal(r.lines[0].physical_observation.variance, null);
  assert.equal((await resolve(s)).reason, 'human_confirmation_required');
  assert.equal(await level(), 10);
}));

test('physical: changed UOM or configuration invalidates prior observation basis', options, async () => fixture(async ({ a, client, uomId, open, observe, resolve }) => {
  const s = await open(); await observe(s);
  await client.query("update inventory_units_of_measure set name='Changed package identity' where id=$1", [uomId]);
  assert.equal((await resolve(s)).reason, 'stale_expectation');
  await client.query("update inventory_units_of_measure set name='Each' where id=$1", [uomId]);
  await client.query("update clients set profile=jsonb_set(profile,'{physical_reconciliation,calendar,timeZone}','\"Asia/Singapore\"'::jsonb) where id=$1", [a.clientId]);
  assert.equal((await resolve(s)).reason, 'stale_expectation');
}));

test('physical: corrupted existing projection is refused before asking for a count', options, async () => fixture(async ({ a, client, itemId, locationId, cmd }) => {
  await client.query('update inventory_item_levels set on_hand=2 where client_id=$1', [a.clientId]);
  const r = await openPhysicalReconciliation({ ...a, itemIds: [itemId], locationId, idempotencyKey: cmd() });
  assert.equal(r.reason, 'inventory_projection_mismatch');
  assert.equal((await client.query('select count(*)::int n from inventory_count_sessions where client_id=$1', [a.clientId])).rows[0].n, 0);
}));

test('physical: locked accounting period preserves observation, open exception and stock', options, async () => fixture(async ({ a, client, open, observe, resolve, accountingOn, grant, level }) => {
  await accountingOn(); await grant();
  const s = await open(); await observe(s);
  await client.query("insert into close_periods(id,firm_id,client_id,period_start,period_end,status) values($1,$2,$3,'2020-01-01','2099-12-31','locked')", [`${a.clientId}-locked`, a.firmId, a.clientId]);
  const r = await resolve(s);
  assert.equal(r.reason, 'accounting_refused', JSON.stringify(r));
  assert.match(r.detail.posting.reason_code, /LOCKED/);
  assert.equal(await level(), 10);
  assert.equal((await client.query('select count(*)::int n from ledger_journals where client_id=$1', [a.clientId])).rows[0].n, 2);
}));

test('physical: jurisdiction-scoped grant cannot authorize another or unknown jurisdiction', options, async () => fixture(async ({ a, client, open, observe, resolve, accountingOn, grant, level }) => {
  await accountingOn(); await grant();
  await client.query("update clients set jurisdiction='United Kingdom' where id=$1", [a.clientId]);
  await client.query("update inventory_posting_authority_grants set jurisdiction='finland' where client_id=$1", [a.clientId]);
  const s = await open(); await observe(s);
  const r = await resolve(s);
  assert.equal(r.reason, 'accounting_refused', JSON.stringify(r));
  assert.equal(r.detail.posting.reason_code, 'authority_jurisdiction_mismatch');
  assert.equal(await level(), 10);
}));

test('physical: evidenced zero carrying value produces existing no-journal terminal', options, async () => fixture(async ({ a, client, open, observe, resolve, accountingOn, level }) => {
  await accountingOn();
  await client.query('update inventory_operations set unit_cost_amount=0 where client_id=$1 and unit_cost_amount is not null', [a.clientId]);
  const s = await open(); await observe(s);
  const r = await resolve(s);
  assert.equal(r.applied, true, JSON.stringify(r));
  assert.equal(r.receipt.accounting.status, 'no_journal_required');
  assert.equal(await level(), 8);
  assert.equal((await client.query('select count(*)::int n from ledger_journals where client_id=$1', [a.clientId])).rows[0].n, 2);
}));

test('physical: missing cost stays explicit and cannot become monetary variance', options, async () => fixture(async ({ a, client, open, observe, resolve, level }) => {
  await client.query('update inventory_operations set unit_cost_amount=null,unit_cost_currency=null where client_id=$1', [a.clientId]);
  const s = await open(); const observed = await observe(s);
  assert.equal(observed.lines[0].physical_basis.valuation.status, 'insufficient_evidence');
  assert.equal((await resolve(s)).reason, 'missing_valuation_basis');
  assert.equal(await level(), 10);
}));

test('physical: concurrent duplicate resolutions yield one correction and one receipt', options, async () => fixture(async ({ a, client, open, observe, level }) => {
  const s = await open(); const observed = await observe(s);
  const other = new pg.Client({ connectionString: testUrl }); await other.connect();
  try {
    const args = { ...a, actorId: a.actorId.replace(/-owner$/, '-reviewer'), sessionId: s.session.id, lineId: s.lines[0].id,
      idempotencyKey: 'concurrent-apply', expectedObservationDigest: observed.lines[0].physical_observation.inputDigest,
      action: 'confirmed_shortage', reason: 'Two verified missing units.' };
    const results = await Promise.all([resolvePhysicalReconciliation(args), resolvePhysicalReconciliation({ ...args, client: other })]);
    assert.ok(results.every((r) => r.applied), JSON.stringify(results));
    assert.equal(results.filter((r) => r.receipt.replayed).length, 1);
    assert.equal(await level(), 8);
    assert.equal((await client.query("select count(*)::int n from inventory_operations where client_id=$1 and operation_type='count_correction'", [a.clientId])).rows[0].n, 1);
  } finally { await other.end(); }
}));

test('physical: prior shrinkage evidence is mandatory and cannot be restored twice', options, async () => fixture(async ({ a, open, observe, resolve, level }) => {
  const s = await open(); await observe(s); const shortage = await resolve(s);
  const found = await open(); await observe(found, 10);
  assert.equal((await resolve(found, { action: 'confirmed_found_stock', countCause: 'reversal_of_shrinkage' })).reason, 'found_stock_shrinkage_source_required');
  const restored = await resolve(found, { action: 'confirmed_found_stock', countCause: 'reversal_of_shrinkage', reversesCountOperationId: shortage.receipt.operationId });
  assert.equal(restored.applied, true, JSON.stringify(restored)); assert.equal(await level(), 10);
  const again = await open(); await observe(again, 12);
  assert.equal((await resolve(again, { action: 'confirmed_found_stock', countCause: 'reversal_of_shrinkage', reversesCountOperationId: shortage.receipt.operationId })).reason, 'found_stock_exceeds_prior_shrinkage');
  assert.equal(await level(), 10);
}));

test('physical: canonical asks are answered atomically and scope erasure removes operational history', options, async () => fixture(async ({ a, client, open, observe, resolve }) => {
  const s = await open();
  const initial = s.lines[0].payload.owner.ask;
  assert.equal(initial.status, 'draft'); assert.equal(initial.deliveryStatus, 'not_delivered');
  const counted = await observe(s);
  const after = (await client.query('select status from client_evidence_requests where id=$1', [initial.id])).rows[0];
  assert.equal(after.status, 'resolved');
  assert.equal((await client.query("select count(*)::int n from client_evidence_requests where client_id=$1 and status in ('draft','open','responded')", [a.clientId])).rows[0].n, 1);
  const dismissed = await resolve(s, { action: 'dismissed', reason: 'Evidence unusable; assertion explicitly limited.' });
  assert.equal(dismissed.applied, true, JSON.stringify(dismissed));
  assert.equal((await client.query("select count(*)::int n from client_evidence_requests where client_id=$1 and status in ('draft','open','responded')", [a.clientId])).rows[0].n, 0);
  const { purgeLoopsShadowForDeletedClient } = await import('../caseManager.js');
  await client.query('begin');
  try {
    // Existing deletion owner performs this cascade, then its governed case purge.
    await client.query('delete from clients where firm_id=$1 and id=$2', [a.firmId, a.clientId]);
    await purgeLoopsShadowForDeletedClient(a);
    await client.query('commit');
  } catch (e) { await client.query('rollback'); throw e; }
  for (const table of ['inventory_count_sessions','inventory_count_lines','inventory_anomalies','inventory_command_receipts','documents','client_evidence_requests','bookkeeping_cases','client_capability_config']) {
    assert.equal((await client.query(`select count(*)::int n from ${table} where client_id=$1`, [a.clientId])).rows[0].n, 0, table);
  }
  assert.ok((await client.query("select count(*)::int n from audit_events where firm_id=$1 and action='inventory.physical.resolve' and client_id is null", [a.firmId])).rows[0].n > 0, 'governed audit retained with erased client link');
}));

test('physical: first-use mappings retain existing mandatory review even with grant', options, async () => fixture(async ({ open, observe, resolve, accountingOn, grant, level }) => {
  await accountingOn({ priorUse: false }); await grant();
  const s = await open(); await observe(s);
  const r = await resolve(s);
  assert.equal(r.reason, 'accounting_refused', JSON.stringify(r));
  assert.equal(r.detail.posting.reason_code, 'authority_event_class_always_escalates');
  assert.equal(r.detail.posting.detail.authority.class, 'first_use_account');
  assert.equal(await level(), 10);
}));

test('physical: missing or exceeded ratified variance policy cannot be silently granted', options, async () => fixture(async ({ a, client, open, observe, resolve, accountingOn, grant, level }) => {
  await accountingOn(); await grant();
  await client.query("update clients set profile=profile #- '{physical_reconciliation,variancePolicy}' where id=$1", [a.clientId]);
  const s = await open(); await observe(s);
  assert.equal((await resolve(s)).reason, 'variance_policy_required');
  await client.query("update clients set profile=jsonb_set(profile,'{physical_reconciliation,variancePolicy}',$2::jsonb) where id=$1", [a.clientId, JSON.stringify({ maxAbsoluteValue: 5, maxPercentage: 10, currency: 'GBP' })]);
  await resolve(s, { action: 'recount_required' }); await observe(s);
  const unusual = await resolve(s);
  assert.equal(unusual.detail.posting.reason_code, 'authority_event_class_always_escalates');
  assert.equal(unusual.detail.posting.detail.authority.class, 'unusual_count_variance');
  assert.equal(await level(), 10);
}));

test('physical: explicit uncertainty cannot be cleared by an adjustment without a new observation', options, async () => fixture(async ({ open, observe, resolve, level }) => {
  const s = await open(); await observe(s);
  assert.equal((await resolve(s, { action: 'uncertain' })).applied, true);
  assert.equal((await resolve(s)).reason, 'human_confirmation_required');
  assert.equal(await level(), 10);
}));

test('physical: accepted resolution waits for a real concurrent movement then refuses its stale proposal', options, async () => fixture(async ({ a, client, itemId, locationId, uomId, open, observe, level, cmd }) => {
  const s = await open(); const observed = await observe(s);
  const other = new pg.Client({ connectionString: testUrl }); await other.connect();
  let resolving;
  try {
    await client.query('begin');
    const moved = await applyInventoryOperationWithinTransaction({ ...a, itemId, locationId, uomId, idempotencyKey: cmd(),
      operationType: 'receipt', quantity: 1, unitCostAmount: 5, unitCostCurrency: 'GBP', occurredAt: new Date().toISOString() });
    assert.equal(moved.applied, true);
    resolving = resolvePhysicalReconciliation({ ...a, client: other, actorId: a.actorId.replace(/-owner$/, '-reviewer'),
      sessionId: s.session.id, lineId: s.lines[0].id, expectedObservationDigest: observed.lines[0].physical_observation.inputDigest,
      idempotencyKey: cmd(), action: 'confirmed_shortage', reason: 'The two counted units were absent.' });
    let waiting = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      const state = (await client.query('select wait_event_type from pg_stat_activity where pid=$1', [other.processID])).rows[0];
      if (state?.wait_event_type === 'Lock') { waiting = true; break; }
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(waiting, true, 'the real apply connection waits on the shared inventory movement lock');
    await client.query('commit');
    assert.equal((await resolving).reason, 'stale_expectation');
    assert.equal(await level(), 11);
  } finally {
    await client.query('rollback');
    if (resolving) await resolving;
    await other.end();
  }
}));
