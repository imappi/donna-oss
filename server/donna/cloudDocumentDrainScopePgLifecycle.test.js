// Actual clock + production producer/writers on disposable PostgreSQL. Only the
// provider wire is synthetic. No hosted account, model or customer book is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

const pgUrl = process.env.DONNA_SCHEMA_PROOF_PG17_URL || process.env.DONNA_PG_TEST_URL;
test('real PG: hosted document clock admits only current manual pilots; ordinary runtime retains existing scope', {
  skip: !pgUrl && 'INCOMPLETE: PostgreSQL required', timeout: 60000
}, async t => {
  const admin = new pg.Client({ connectionString: pgUrl }); await admin.connect();
  const name = `donna_cloud_drain_${process.pid}_${Date.now()}`;
  await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl); url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  const ended = []; pool.on('connect', c => ended.push(new Promise(resolve => c.once('end', resolve))));
  const env = { DATABASE_URL: url.toString(), DONNA_DEFAULT_FIRM_ID: 'drain-fixture',
    VERCEL: '1', VERCEL_PROJECT_ID: 'fixture', VERCEL_ENV: 'preview', DONNA_DESKTOP_BLOB_DIR: '',
    LOOPS_TIER: 'canary', LOOPS_SHADOW: 'true', ANTHROPIC_API_KEY: 'fixture-only', CLIENT_CONFIG_FORCE_DISABLE: '' };
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]])); Object.assign(process.env, env);
  const priorFetch = globalThis.fetch;
  const { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } = await import('./db/pool.js');
  __setFirmDbPoolForTests(pool);
  t.after(async () => {
    globalThis.fetch = priorFetch; __resetFirmDbPoolForTests();
    await pool.end(); await Promise.all(ended); await admin.query(`drop database "${name}"`); await admin.end();
    for (const [k,v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
  await pool.query(`create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)`);
  const dir = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(file,dir),'utf8'));
    await pool.query('insert into schema_migrations(version) values($1) on conflict do nothing',[file.slice(0,-4)]);
  }
  const firmId = 'drain-fixture';
  await pool.query("insert into firms(id,name,slug,metadata) values($1,'Synthetic drain firm',$1,$2)", [firmId,{loops:{tier:'canary'}}]);
  await pool.query("insert into firm_members(id,firm_id,email,name,role,status) values('fixture-operator',$1,'operator@fixture.invalid','Operator','admin','active')",[firmId]);
  const { selfProvisionClientWorkspace } = await import('./selfProvisionDb.js');
  const { prepareFinnishHostedPilotInDb } = await import('./hostedPilot.js');
  const { setClientFlagStage } = await import('./clientConfig.js');
  const { HOSTED_PILOT_VERSION } = await import('./internalPilotAccess.js');
  const { documentTerminalDrainFunction } = await import('./inngest/documentTerminalDrain.js');
  const { clientId: pilot } = await selfProvisionClientWorkspace({auth:{userId:'fixture-owner',email:'owner@fixture.invalid'},companyName:'Synthetic Pilot Oy',jurisdiction:'FI',entityType:'fi-oy'});
  await prepareFinnishHostedPilotInDb({firmId,clientId:pilot,actorId:'fixture-operator',profilePatch:{companyName:'Synthetic Pilot Oy',jurisdiction:'FI',entityType:'fi-oy',accountingCurrency:'EUR',accounting_system:'none',accounting_view:'management_books',accountingBasis:'accrual'}});
  const nonpilots = ['honeybee-like','wrong-reason','wrong-source','wrong-stage','expired','revoked','firm-default'];
  for (const id of nonpilots) await pool.query("insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile) values($1,$2,$1,'fi','fi-oy',$3)",[id,firmId,{jurisdiction:'fi',accounting_system:'none'}]);
  const flag = (clientId,flagKey,overrides={}) => setClientFlagStage(pool,{firmId,clientId,flagKey,stage:'canary',source:'manual',reason:HOSTED_PILOT_VERSION,actorType:'firm_member',actorId:'fixture-operator',...overrides});
  for (const id of [pilot,...nonpilots]) await flag(id,'DOCUMENT_NO_LINE_DISPOSITION');
  for (const id of nonpilots.filter(id => !['honeybee-like','firm-default'].includes(id))) await flag(id,'INTERNAL_PILOT_ACCESS',
    id==='wrong-reason'?{reason:'not-prepared'}:id==='wrong-source'?{source:'default'}:id==='wrong-stage'?{stage:'auto'}:{});
  await flag('revoked','INTERNAL_PILOT_ACCESS',{stage:'off'});
  await pool.query("update client_capability_config set valid_to=clock_timestamp()-interval '1 second' where client_id='expired' and flag_key='INTERNAL_PILOT_ACCESS'");
  await flag(null,'INTERNAL_PILOT_ACCESS');
  for (const id of [pilot,...nonpilots]) {
    await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,currency,document_date,vendor_name,payment_status,payload)
      values($1,$2,$3,'synthetic.pdf','receipt','completed',10,'EUR','2025-02-15','Synthetic fuel','paid','{}')`,[`doc-${id}`,firmId,id]);
    for (const date of ['2025-02-01','2025-02-28']) await pool.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,money_in,currency,status,payload)
      values($1,$2,$3,$4,'Synthetic unrelated bank line',100,0,'EUR','needs_review','{}')`,[`${id}-${date}`,firmId,id,date]);
  }
  const calls = [];
  globalThis.fetch = async (target,init) => {
    assert.match(String(target),/api\.anthropic\.com/,'no other external transport allowed');
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({content:[{type:'text',text:JSON.stringify({disposition:'auto_explain',materiality:'immaterial',expense_kind:'fuel',settlement_channel:'personal_card',confidence:0.98,reasoning:'Synthetic paid receipt and complete bank coverage.'})}],usage:{input_tokens:1,output_tokens:1}}));
  };
  const clock = (data=null) => documentTerminalDrainFunction.fn({event:data?{name:'donna/host.readiness.requested',data}:{name:'inngest/scheduled.timer',data:{}},step:{run:async(_name,work)=>work()},logger:{warn(){},error(){}}});
  const untouched = async () => {
    const rows = {};
    for (const table of ['documents','transactions','reconciliation_evaluations','audit_events','bookkeeping_cases','client_evidence_requests','ledger_journals','llm_decisions'])
      rows[table]=(await pool.query(`select to_jsonb(t) as row from ${table} t where client_id=any($1::text[]) order by id`,[nonpilots])).rows;
    return rows;
  };
  const before = await untouched();
  const first = await clock();
  assert.deepEqual(first.errors,[],JSON.stringify(first));
  assert.equal(first.clients_enrolled,1,JSON.stringify(first));
  assert.equal(first.documents_evaluated,1,JSON.stringify(first));
  assert.equal(calls.length,1);
  assert.ok(JSON.stringify(calls[0]).includes(`doc-${pilot}`));
  for (const id of nonpilots) assert.ok(!JSON.stringify(calls[0]).includes(`doc-${id}`));
  assert.deepEqual(await untouched(),before,'nonpilot documents, state projections, questions, decisions and audit/writer receipts stay byte-identical');
  for (const clientId of [...nonpilots,'nonexistent']) {
    const refused = await clock({firm_id:firmId,client_id:clientId});
    assert.equal(refused.errors[0]?.code,'INTERNAL_PILOT_ACCESS_REQUIRED');
    assert.equal(refused.clients_enrolled,0);
  }
  const forged = await clock({firm_id:'wrong-firm',client_id:pilot});
  assert.equal(forged.errors[0]?.code,'INTERNAL_PILOT_ACCESS_REQUIRED');
  assert.equal(calls.length,1,'scoped payloads cannot enroll themselves');
  assert.deepEqual(await untouched(),before);
  const healthy = await clock({firm_id:firmId,client_id:pilot});
  assert.deepEqual(healthy.errors,[]); assert.equal(healthy.clients_enrolled,1);
  const afterHealthy = calls.length;
  assert.ok(calls.every(call => JSON.stringify(call).includes(`doc-${pilot}`)), 'normal scoped readiness uses only the prepared client');
  await flag(pilot,'INTERNAL_PILOT_ACCESS',{stage:'off'});
  const revoked = await clock(); assert.equal(revoked.clients_enrolled,0); assert.equal(calls.length,afterHealthy);
  assert.equal((await clock({firm_id:firmId,client_id:pilot})).errors[0]?.code,'INTERNAL_PILOT_ACCESS_REQUIRED');
  // A broken pilot-provenance read cannot fall through to producer/readiness work.
  await pool.query('alter table client_capability_config rename column reason to unavailable_reason');
  await assert.rejects(clock(), error => error.code === 'DOCUMENT_DRAIN_SWEEP_FAILED' && error.summary.errors.length>0, 'a failed read fails the run'); assert.equal(calls.length,afterHealthy);
  await pool.query('alter table client_capability_config rename column unavailable_reason to reason');
  assert.deepEqual(await untouched(),before);
  for (const key of ['VERCEL','VERCEL_PROJECT_ID','VERCEL_ENV']) delete process.env[key];
  const ordinary = await clock({firm_id:firmId,client_id:'honeybee-like'});
  assert.deepEqual(ordinary.errors,[],JSON.stringify(ordinary));
  assert.equal(ordinary.clients_enrolled,1); assert.equal(ordinary.documents_evaluated,1);
  assert.equal(calls.length,afterHealthy+1,'non-Vercel runtime retains ordinary disposition enrollment');
  assert.ok(JSON.stringify(calls.at(-1)).includes('doc-honeybee-like'));
});
