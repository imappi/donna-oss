import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, createClientInDb,
  getClientEntityAxisFromDb, updateClientProfileInDb, resolveClientFiscalYearTx,
  registerFiscalPeriodWithClient, __writeLedgerJournalRows, runCloseChecksInDb,
  createCloseArchiveInDb, resolveClientEvidenceRequestInDb } from './firmDb.js';
import { __heldFiscalYearsForRetention } from './db/close.js';
import { seedGbDefaultChartIfEmpty } from './selfProvisionDb.js';
import { resolveProvisioningPolicy, resolveProvisioningCertificateChart } from './provisioningPolicyRegistry.js';
import { deriveRequiredRolesForClient } from './canonicalRoleResolutionDb.js';
import { loadCodingAutoPostCandidatesForTransaction, evaluateCodingAutoPost } from './codingAutoPost.js';
import { describeArchiveRetention } from './finland/retention.js';
import { resolveGbFiscalYearForEntity } from './gb/accountingPeriod.js';
import { readClosePolicyWithClient } from './closePolicyRegistry.js';
import { readPostingAdmissionWithClient } from './postingAdmissionRegistry.js';

const firmId = 'wave6-firm'; const actorId = 'wave6-owner';
const countries = [['fi','fi-toiminimi','EUR'], ['gb','gb-ltd','GBP'], ['sg','sg-pte','SGD'],
  ['ae','ae-llc','AED'], ['us','us-llc','USD'], ['au','au-pty-ltd','AUD']];

test('registered client, admission and close operations preserve real PostgreSQL lifecycles', {
  skip: process.env.DONNA_PG_TEST_URL ? false : 'DONNA_PG_TEST_URL not set — country lifecycle proof INCOMPLETE'
}, async (t) => {
  const name = `donna_wave6_${process.pid}_${Date.now().toString(36)}`;
  const admin = new pg.Client({ connectionString: process.env.DONNA_PG_TEST_URL });
  await admin.connect(); await admin.query(`create database "${name}"`);
  const url = new URL(process.env.DONNA_PG_TEST_URL); url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  const ended = []; pool.on('connect', c => ended.push(new Promise(resolve => c.once('end', resolve))));
  __setFirmDbPoolForTests(pool);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('No provider HTTP is authorized in lifecycle fixtures'); });
  t.after(async () => {
    __resetFirmDbPoolForTests(); await pool.end(); await Promise.all(ended);
    await admin.query(`drop database "${name}"`); await admin.end();
  });
  await pool.query(`create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb);`);
  const migrations = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(f => f.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(file, migrations), 'utf8'));
  }
  await pool.query("insert into firms (id,name,slug) values ($1,'Wave 6 fixture','wave6-fixture')", [firmId]);
  const profiles = new Map();
  for (const [country, entityType, currency] of countries) {
    const profile = { id: `wave6-${country}`, companyName: `Wave 6 ${country}`, jurisdiction: country,
      entityType, incorporationDate: '2025-05-10', accountingCurrency: currency, accounting_system: 'none' };
    profiles.set(country, profile);
    await createClientInDb({ firmId, profile, creationPrincipal: { principalId: actorId, principalType: 'owner', authoritySource: 'fixture_owner' } });
  }
  const flag = async (clientId, key) => pool.query(`insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source)
    values ($2 || ':' || $3,$1,$2,$3,'auto','manual') on conflict (firm_id,client_id,flag_key) where client_id is not null and valid_to is null do update set stage='auto'`, [firmId, clientId, key]);
  const tx = async fn => {
    const client = await pool.connect(); await client.query('begin');
    try { const result = await fn(client); await client.query('commit'); return result; }
    catch (e) { await client.query('rollback'); throw e; } finally { client.release(); }
  };
  const journal = (source, currency = 'EUR', drift = false) => {
    const expense = { role: 'counterparty', code: '4999', name: 'Fixture expense', type: 'expense',
      ...(drift ? { tax_type: 'ALV_REVERSE_CHARGE_PURCHASE' } : {}) };
    const bank = { role: 'bank', code: '1910', name: 'Fixture bank', type: 'bank' };
    return { source_type: 'fixture', source_id: source, journal_date: '2026-05-14', currency,
      memo: 'Original evidence', accounts: [expense, bank], lines: [
        { account: expense, direction: 'debit', debit: 100, credit: 0, amount: 100, currency },
        { account: bank, direction: 'credit', debit: 0, credit: 100, amount: 100, currency }
      ] };
  };
  const write = (clientId, model) => tx(client => __writeLedgerJournalRows({ client, firmId, clientId, journal: model, actorId, payload: { retained: 'historical-evidence' } }));

  await t.test('context reads preserve the readiness fence lock order during a concurrent identity update', async () => {
    const reader = await pool.connect(); const updater = await pool.connect();
    let update;
    try {
      await reader.query('begin'); await updater.query('begin');
      // The named admission takes this existing key before country context is read.
      // The dependency trigger on the other connection must wait for that generation.
      await reader.query('select pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [`entity-readiness:${firmId}:wave6-fi`]);
      const pid = (await updater.query('select pg_backend_pid() as pid')).rows[0].pid;
      update = updater.query("update clients set jurisdiction='SG' where id='wave6-fi'").then(() => null, error => error);
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const locks = await pool.query("select 1 from pg_locks where pid=$1 and locktype='advisory' and not granted", [pid]);
        if (locks.rows.length) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(waiting, true, 'the real dependency trigger waits behind the admitted generation');
      await reader.query("set local lock_timeout='250ms'");
      for (const read of [readClosePolicyWithClient, readPostingAdmissionWithClient]) {
        const context = await read({ client: reader, firmId, clientId:'wave6-fi' });
        assert.equal(context.row.jurisdiction, 'FI'); assert.ok(context.policy);
      }
    } finally {
      await reader.query('rollback');
      const error = update ? await update : null;
      await updater.query('rollback'); reader.release(); updater.release();
      if (error) throw error;
    }
  });

  await t.test('FI transition preserves blocker identity, replay audit and post-conversion refusal', async () => {
    assert.equal(await getClientEntityAxisFromDb({ firmId, clientId: 'wave6-fi' }), 'toiminimi');
    assert.equal(await getClientEntityAxisFromDb({ firmId, clientId: 'wave6-sg' }), 'pte_ltd');
    const before = (await pool.query("select * from audit_events where client_id='wave6-fi' order by id")).rows;
    await createClientInDb({ firmId, profile: { ...profiles.get('fi'), entityType: 'fi-oy' } });
    const blockers = (await pool.query("select * from statutory_blockers where client_id='wave6-fi'")).rows;
    assert.equal(blockers.length, 1); assert.match(JSON.stringify(blockers), /form5/);
    await createClientInDb({ firmId, profile: { ...profiles.get('fi'), entityType: 'fi-oy' } });
    assert.deepEqual((await pool.query("select * from statutory_blockers where client_id='wave6-fi'")).rows, blockers);
    assert.ok((await pool.query("select * from audit_events where client_id='wave6-fi' order by id")).rows.length > before.length);
    await createClientInDb({ firmId, profile: profiles.get('fi') });
    await write('wave6-fi', journal('before-conversion'));
    const old = (await pool.query("select * from ledger_journals where client_id='wave6-fi' order by id")).rows;
    await assert.rejects(createClientInDb({ firmId, profile: { ...profiles.get('fi'), entityType: 'fi-oy' } }), { code: 'FINLAND_ENTITY_TYPE_IMMUTABLE' });
    assert.deepEqual((await pool.query("select * from ledger_journals where client_id='wave6-fi' order by id")).rows, old);
  });

  await t.test('GB seed and certificate share the exact chart; dated VAT roles keep tri-state', async () => {
    const options = { firmId, clientId: 'wave6-gb', entityType: 'gb-ltd' };
    const seeded = await seedGbDefaultChartIfEmpty(options);
    const chart = resolveProvisioningCertificateChart('gb_default_chart.v1');
    assert.equal(seeded.count, chart.length);
    const stored = (await pool.query("select code,name,account_type,normal_balance,canonical_role from ledger_accounts where client_id='wave6-gb' order by code")).rows;
    assert.deepEqual(stored, chart.map(({ name_en, ...rest }) => ({ ...rest, name: name_en })).sort((a,b)=>a.code.localeCompare(b.code)));
    assert.deepEqual(await seedGbDefaultChartIfEmpty(options), { seeded: false, count: 0 });
    const sole = resolveProvisioningPolicy('gb').defaultChart('gb-sole-trader');
    assert.ok(sole.some(a=>a.canonical_role==='equity.owner_drawings'));
    assert.ok(!sole.some(a=>a.canonical_role==='liability.director_loan'));
    for (const profile of [{}, { vat_registration: { status: 'not_registered' } }]) {
      assert.deepEqual(deriveRequiredRolesForClient({ jurisdiction:'gb', profile, onDate:'2026-05-14' }).roles, []);
    }
  });

  await t.test('all six fiscal projections and unavailable/current identity are independent of caller hints', async () => {
    for (const [country, entityType] of countries) {
      const fy = await tx(client => resolveClientFiscalYearTx({ client, firmId, clientId: `wave6-${country}`, date:'2026-05-14' }));
      const expected = country==='gb' ? resolveGbFiscalYearForEntity({ date:'2026-05-14', entityAxis:'ltd', incorporationDate:'2025-05-10' })
        : { label:'2026', starts_on:'2026-01-01', ends_on:'2026-12-31' };
      assert.deepEqual(fy, expected, entityType);
      if (country !== 'gb') {
        const first = await tx(client => resolveClientFiscalYearTx({ client, firmId, clientId: `wave6-${country}`, date:'2025-06-01' }));
        assert.deepEqual(first, { label:'2025', starts_on:'2025-05-10', ends_on:'2025-12-31' }, 'persisted PostgreSQL DATE preserves the short first calendar year');
      }
    }
    const oldJournal = (await pool.query("select * from ledger_journals where client_id='wave6-fi'")).rows;
    await updateClientProfileInDb({ firmId, clientId:'wave6-fi', actorId, profilePatch:{ jurisdiction:null } });
    assert.equal(await getClientEntityAxisFromDb({ firmId, clientId:'wave6-fi' }), null);
    await assert.rejects(tx(client => resolveClientFiscalYearTx({ client,firmId,clientId:'wave6-fi',date:'2026-05-14',entityType:'fi-toiminimi' })), { code:'FISCAL_YEAR_POLICY_UNAVAILABLE' });
    await updateClientProfileInDb({ firmId, clientId:'wave6-fi',actorId,profilePatch:{ jurisdiction:'fi', entity_type:'fi-toiminimi' } });
    assert.deepEqual((await pool.query("select * from ledger_journals where client_id='wave6-fi'")).rows,oldJournal);
  });

  await t.test('scope-drift owner receipt is idempotent, country isolated and present in real candidate wiring', async () => {
    for (const [country,,currency] of countries) {
      const clientId=`wave6-${country}`;
      await flag(clientId,'FINLAND_SCOPE_DRIFT_POSTING_GATE');
      await write(clientId,journal(`drift-${country}`,currency,true));
      const asks=(await pool.query('select * from client_evidence_requests where client_id=$1 and evidence_type=$2',[clientId,'scope_drift_review'])).rows;
      assert.equal(asks.length,country==='fi'?1:0);
      if(country==='fi') {
        assert.equal(asks[0].created_by,actorId);
        await write(clientId,journal('drift-repeat',currency,true));
        assert.deepEqual((await pool.query('select * from client_evidence_requests where id=$1',[asks[0].id])).rows,[asks[0]]);
        await resolveClientEvidenceRequestInDb({ firmId, evidenceRequestId: asks[0].id, reply: 'Confirmed business activity', actorId, actorType: 'owner' });
        const answered = (await pool.query('select * from client_evidence_requests where id=$1',[asks[0].id])).rows[0];
        assert.equal(answered.status,'replied'); assert.equal(answered.response_payload.reply,'Confirmed business activity');
        await write(clientId,journal('drift-after-answer',currency,true));
        assert.deepEqual((await pool.query('select * from client_evidence_requests where id=$1',[asks[0].id])).rows,[answered], 'historical response is not reopened by repeated drift');

      }
      await pool.query(`insert into transactions(id,firm_id,client_id,transaction_date,money_out,description,currency,coding_state,payload)
        values($1,$2,$3,'2026-05-14',20,'Fixture reverse charge',$4,'proposed',$5::jsonb)`, [`candidate-${country}`,firmId,clientId,currency,JSON.stringify({ ai_suggestion:{ proposed_account:'Fixture expense',confidence:'high',evidence_required:false,xero_account_type:'EXPENSE',tax_type:'ALV_REVERSE_CHARGE_PURCHASE' } })]);
      const [candidate]=await loadCodingAutoPostCandidatesForTransaction({firmId,clientId,transactionId:`candidate-${country}`});
      assert.equal(candidate.client_context.jurisdiction,country.toUpperCase());
      const result=evaluateCodingAutoPost({suggestion:candidate.ai_suggestion,clientContext:candidate.client_context,scopeDriftPostingGateActs:true});
      assert.equal(result.action,country==='fi'?'owner_ask':'auto_post');
    }
  });

  await t.test('explicit fiscal intake, close refusals and archive retention use the same persisted period',async()=>{
    const clientId='wave6-fi';
    await flag(clientId,'FISCAL_PERIOD_INTAKE'); await flag(clientId,'FINLAND_TILIKAUSI');
    const args={firmId,clientId,label:'2026',startsOn:'2026-01-01',endsOn:'2026-12-31',actorId,authorityBasis:'owner_supplied_fact'};
    const beforeIntake = (await pool.query('select * from fiscal_years where client_id=$1',[clientId])).rows;
    await pool.query("update clients set profile=jsonb_set(profile,'{entityType}','\"gb-ltd\"'::jsonb) where id=$1",[clientId]);
    await assert.rejects(tx(client=>registerFiscalPeriodWithClient({client,...args})),{code:'FISCAL_YEAR_POLICY_UNAVAILABLE'});
    assert.deepEqual((await pool.query('select * from fiscal_years where client_id=$1',[clientId])).rows,beforeIntake, 'conflicting profile cannot omit the statutory bound and register a period');
    await updateClientProfileInDb({ firmId, clientId, actorId, profilePatch:{ jurisdiction:'fi', entity_type:'fi-toiminimi', entityType:'fi-toiminimi' } });
    const registered=await tx(client=>registerFiscalPeriodWithClient({client,...args}));
    assert.equal(registered.created,true); assert.equal(registered.statutory.bound_enforced,true);
    assert.equal((await tx(client=>registerFiscalPeriodWithClient({client,...args}))).created,false);
    await assert.rejects(tx(client=>registerFiscalPeriodWithClient({client,...args,label:'2027',startsOn:'2027-01-01',endsOn:'2028-01-31'})),{code:'TILIKAUSI_TOO_LONG'});
    await assert.rejects(runCloseChecksInDb({firmId,clientId,periodStart:'2026-12-01',periodEnd:'2027-01-31',actorId}),{code:'CLOSE_PERIOD_STRADDLES_TILIKAUSI'});
    await flag(clientId,'FINLAND_TOSITENUMERO');
    await write(clientId,journal('voucher-first')); await write(clientId,journal('voucher-first'));
    await write(clientId,journal('voucher-second'));
    const vouchers=(await pool.query('select tosite_number from ledger_journals where client_id=$1 and tosite_number is not null order by tosite_number',[clientId])).rows;
    assert.deepEqual(vouchers,[{tosite_number:1},{tosite_number:2}]);
    await pool.query('update ledger_journals set tosite_number=3 where client_id=$1 and tosite_number=2',[clientId]);
    await assert.rejects(runCloseChecksInDb({firmId,clientId,periodStart:'2026-01-01',periodEnd:'2026-12-31',actorId}),{code:'TOSITE_SEQUENCE_GAP'});
    await pool.query('update ledger_journals set tosite_number=2 where client_id=$1 and tosite_number=3',[clientId]);
    await pool.query("update fiscal_years set status='closed' where client_id=$1",[clientId]);
    const held=await tx(client=>__heldFiscalYearsForRetention(client,{firmId,clientId,retentionClass:'kirjanpitokirja'}));
    assert.equal(held.length,1); assert.equal(held[0].hold.retain_until,'2036-12-31');
    const result=await createCloseArchiveInDb({firmId,clientId,periodStart:'2026-01-01',periodEnd:'2026-12-31',actorId});
    const archive=(await pool.query('select * from close_archives where client_id=$1',[clientId])).rows[0];
    assert.ok(archive.manifest_checksum);
    assert.deepEqual(archive.payload.sections.period.retention,describeArchiveRetention({fiscalYear:{label:'2026',starts_on:'2026-01-01',ends_on:'2026-12-31',status:'closed'}}));
    assert.equal(result.close_archive.manifest_checksum_sha256,archive.manifest_checksum);
    const foreignHold=await tx(client=>__heldFiscalYearsForRetention(client,{firmId,clientId:'wave6-gb',retentionClass:'kirjanpitokirja'}));
    assert.equal(foreignHold,null);
    await updateClientProfileInDb({ firmId, clientId, actorId, profilePatch:{ jurisdiction:null } });
    assert.equal((await tx(client=>__heldFiscalYearsForRetention(client,{firmId,clientId,retentionClass:'kirjanpitokirja'}))).length,1, 'retained archive keeps its original country hold after identity clearing');
    await updateClientProfileInDb({ firmId, clientId, actorId, profilePatch:{ jurisdiction:'sg', entity_type:'sg-pte' } });
    assert.equal((await tx(client=>__heldFiscalYearsForRetention(client,{firmId,clientId,retentionClass:'kirjanpitokirja'}))).length,1, 'a newly selected country cannot erase the historical archive retention commitment');
    assert.deepEqual((await pool.query('select * from close_archives where id=$1',[archive.id])).rows,[archive], 'identity repair preserves the full archived evidence bytes');

  });
});
