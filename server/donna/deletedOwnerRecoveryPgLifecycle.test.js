import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Readable} from 'node:stream';
import pg from 'pg';
import donnaRouter from '../../api/donna-router.js';
import {selfProvisionClientWorkspace} from './selfProvisionDb.js';
import {createClientInDb,__setFirmDbPoolForTests,__resetFirmDbPoolForTests} from './firmDb.js';

const pgUrl=process.env.DONNA_SCHEMA_PROOF_PG17_URL;
test('PG17 real HTTP: deleted-subject recovery requires two current principals, closes its receipt and preserves scope',
  {skip:!pgUrl && 'INCOMPLETE: DONNA_SCHEMA_PROOF_PG17_URL is required'},async t=>{
  const name=`donna_owner_recovery_${process.pid}`;
  const admin=new pg.Client({connectionString:pgUrl});await admin.connect();
  assert.ok(Number((await admin.query('show server_version_num')).rows[0].server_version_num)>=170000);
  await admin.query(`create database "${name}"`);
  const url=new URL(pgUrl);url.pathname=`/${name}`;
  const seed=new pg.Client({connectionString:url.toString()});await seed.connect();
  const pool=new pg.Pool({connectionString:url.toString()});pool.on('error',()=>{});
  __setFirmDbPoolForTests(pool);
  const keys=['DATABASE_URL','DONNA_DEFAULT_FIRM_ID','DONNA_ACCESS_TOKEN','SUPABASE_URL','SUPABASE_PUBLISHABLE_KEY','DONNA_AUTH_ALLOWED_EMAILS','DONNA_DESKTOP_BLOB_DIR'];
  const env=Object.fromEntries(keys.map(key=>[key,process.env[key]])),fetch=globalThis.fetch;
  Object.assign(process.env,{DATABASE_URL:url.toString(),DONNA_DEFAULT_FIRM_ID:'recovery-firm',DONNA_ACCESS_TOKEN:'shared-not-owner',
    SUPABASE_URL:'https://recovery-auth.invalid',SUPABASE_PUBLISHABLE_KEY:'synthetic-public-key',DONNA_AUTH_ALLOWED_EMAILS:''});
  delete process.env.DONNA_DESKTOP_BLOB_DIR;
  let locker;
  t.after(async()=>{
    globalThis.fetch=fetch;for(const key of keys){if(env[key]===undefined)delete process.env[key];else process.env[key]=env[key];}
    if(locker){await locker.query('rollback').catch(()=>{});await locker.end();}
    __resetFirmDbPoolForTests();await pool.end();await seed.end();await admin.query(`drop database "${name}" with (force)`);await admin.end();
  });
  await seed.query(`create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,
    created_at timestamptz not null default now(),deleted_at timestamptz,banned_until timestamptz,is_anonymous boolean default false);
    create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)`);
  const root=new URL('../../db/migrations/',import.meta.url);
  for(const file of (await readdir(root)).filter(f=>f.endsWith('.sql')).sort()){
    await seed.query(await readFile(new URL(file,root),'utf8'));
    await seed.query('insert into schema_migrations(version) values($1) on conflict do nothing',[file.slice(0,-4)]);
  }
  const firmId='recovery-firm',operatorId='operator-member',operatorUser='00000000-0000-4000-8000-000000000001';
  await seed.query("insert into firms(id,name,slug,jurisdiction,default_currency) values($1,'Recovery proof',$1,'FI','EUR')",[firmId]);
  await seed.query("insert into auth.users(id,email,email_confirmed_at) values($1,'operator@proof.invalid',now())",[operatorUser]);
  await seed.query("insert into firm_members(id,firm_id,user_id,email,name,role,status) values($1,$2,$3,'operator@proof.invalid','Operator','admin','active')",[operatorId,firmId,operatorUser]);
  const tokens=new Map([['operator',{userId:operatorUser,email:'operator@proof.invalid'}]]);
  globalThis.fetch=async(address,init)=>{
    assert.equal(address,'https://recovery-auth.invalid/auth/v1/user','only provider authentication is mocked');
    const identity=tokens.get(init.headers.Authorization?.replace('Bearer ',''));
    return new Response(JSON.stringify(identity?{id:identity.userId,email:identity.email}:{}),{status:identity?200:401});
  };
  const http=async(token,path,body)=>{
    const req=Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]),route=new URL(path,'http://localhost');
    req.method=body?'POST':'GET';req.url=`/api/donna-router?path=${encodeURIComponent(`firms${route.pathname}`)}${route.search?`&${route.search.slice(1)}`:''}`;
    req.headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
    return new Promise((resolve,reject)=>{
      const res={statusCode:200,setHeader(){},end(value){resolve({status:this.statusCode,body:JSON.parse(String(value))});}};
      Promise.resolve(donnaRouter(req,res)).catch(reject);
    });
  };
  let serial=10;
  const make=async()=>{
    const index=serial++,uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
    const old=uuid(index*2),current=uuid(index*2+1),email=`owner${index}@proof.invalid`,token=`owner${index}`;
    await seed.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',[old,email]);
    const created=await selfProvisionClientWorkspace({deps:{createClient:({creationPrincipal,...args})=>createClientInDb(args)},
      auth:{userId:old,email},companyName:`Recovery ${index} Oy`,jurisdiction:'FI',entityType:'fi-oy'});
    await seed.query('delete from auth.users where id=$1',[old]);
    // Retain provider microsecond precision: converting to JS Date must not
    // silently make a valid confirmed identity fail the final SQL equality.
    await seed.query("insert into auth.users(id,email,email_confirmed_at,created_at) values($1,$2,'2026-07-14T16:04:12.258971Z','2026-07-14T16:04:12.258971Z')",[current,email]);
    tokens.set(token,{userId:current,email});
    const clientId=created.clientId;
    const collab=(await seed.query('select id from firm_collaborators where firm_id=$1 and email=$2',[firmId,email])).rows[0].id;
    const assignment=(await seed.query('select id from client_assignments where client_id=$1',[clientId])).rows[0].id;
    const owner=(action,digest)=>http(token,'/self-provision',{owner_revalidation:{action,...(digest?{confirmed:true,review_digest:digest}:{})}});
    const path=`/clients/${clientId}/finnish-pilot-setup`;
    const review=()=>http('operator',`${path}?firm_id=${firmId}&recovery=owner`);
    const approve=digest=>http('operator',path,{firm_id:firmId,owner_recovery:{action:'approve',confirmed:true,review_digest:digest}});
    const ask=async()=>{const r=await owner('recovery_review');assert.equal(r.status,200,JSON.stringify(r));
      const q=await owner('recovery_request',r.body.review_digest);assert.equal(q.status,200,JSON.stringify(q));return q;};
    const binding=async()=>(await seed.query('select user_id from firm_collaborators where id=$1',[collab])).rows[0].user_id;
    return {old,current,email,token,clientId,collab,assignment,owner,path,review,approve,ask,binding};
  };
  const snapshot=async x=>(await seed.query(`select
    (select row_to_json(c) from clients c where id=$1) as client,
    (select to_jsonb(c)-'user_id'-'updated_at' from firm_collaborators c where id=$2) as collaborator,
    (select count(*) from firm_members) as members,
    (select jsonb_agg(to_jsonb(a) order by id) from client_assignments a where principal_id=$2) as assignments,
    (select jsonb_agg(to_jsonb(e) order by id) from audit_events e where client_id=$1 and action='client.create') as creation,
    (select jsonb_agg(to_jsonb(c) order by flag_key) from client_capability_config c where client_id=$1) as config,
    (select count(*) from entity_readiness_sagas where client_id=$1) as readiness,
    (select count(*) from ledger_journals where client_id=$1) as journals`,[x.clientId,x.collab])).rows[0];
  await t.test('owner request, operator approval and normal adoption are separate real HTTP transitions',async()=>{
    const x=await make(),before=await snapshot(x);
    assert.equal((await x.owner('review')).body.code,'OWNER_REVALIDATION_IDENTITY_REQUIRED');
    const q=await x.ask();assert.equal(await x.binding(),x.old);
    assert.deepEqual(await snapshot(x),before);
    assert.equal((await x.owner('recovery_request',q.body.review_digest)).body.receipt_id,q.body.receipt_id);
    const r=await x.review();assert.equal(r.status,200,JSON.stringify(r));
    const applied=await x.approve(r.body.review_digest);assert.equal(applied.status,200,JSON.stringify(applied));
    assert.equal(await x.binding(),x.current);assert.deepEqual(await snapshot(x),before);
    const again=await x.approve(r.body.review_digest);assert.equal(again.status,200,JSON.stringify(again));assert.equal(again.body.receipt_id,applied.body.receipt_id);
    const audits=(await seed.query("select action,actor_id,metadata from audit_events where client_id=$1 and action like 'client.owner_%' order by id",[x.clientId])).rows;
    assert.deepEqual(audits.map(row=>row.action),['client.owner_recovery_requested','client.owner_identity_rebound']);
    assert.equal(audits[0].actor_id,x.current);assert.equal(audits[1].actor_id,operatorId);
    assert.equal(audits[1].metadata.binding.old_user_id,x.old);assert.equal(audits[1].metadata.owner_actor_id,x.current);
    assert.equal((await http('operator',`${x.path}?firm_id=${firmId}`)).body.code,'PILOT_SELF_PROVISION_REQUIRED');
    const regular=await x.owner('review');assert.equal(regular.status,200,JSON.stringify(regular));
    const confirmed=await x.owner('confirm',regular.body.review_digest);assert.equal(confirmed.status,200,JSON.stringify(confirmed));
    const setupReview=await http('operator',`${x.path}?firm_id=${firmId}`);assert.equal(setupReview.status,200,JSON.stringify(setupReview));
    const prepared=await http('operator',x.path,{firm_id:firmId,confirmed:true,client_version:setupReview.body.client_version,
      profile_patch:{companyName:`Recovery 10 Oy`,jurisdiction:'FI',entityType:'fi-oy',accountingCurrency:'EUR',accounting_system:'none',accounting_view:'management_books',accountingBasis:'accrual'}});
    assert.equal(prepared.status,200,JSON.stringify(prepared));assert.equal(prepared.body.processing_readiness,'INCOMPLETE');
    assert.deepEqual((await snapshot(x)).creation,before.creation);
  });
  const cases=[
    ['old subject still present',x=>seed.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',[x.old,x.email]),'OLD_PRESENT'],
    ['old soft-deleted subject remains',x=>seed.query('insert into auth.users(id,email,deleted_at) values($1,$2,now())',[x.old,x.email]),'OLD_PRESENT'],
    ['unconfirmed owner',x=>seed.query('update auth.users set email_confirmed_at=null where id=$1',[x.current]),'IDENTITY'],
    ['banned owner',x=>seed.query("update auth.users set banned_until=now()+interval '1 day' where id=$1",[x.current]),'IDENTITY'],
    ['anonymous owner',x=>seed.query('update auth.users set is_anonymous=true where id=$1',[x.current]),'IDENTITY'],
    ['deleted replacement',x=>seed.query('delete from auth.users where id=$1',[x.current]),'IDENTITY'],
    ['different authoritative email',x=>seed.query("update auth.users set email='different@proof.invalid' where id=$1",[x.current]),'IDENTITY'],
    ['revoked assignment',x=>seed.query("update client_assignments set status='suspended' where id=$1",[x.assignment]),'ASSIGNMENT'],
    ['future assignment',x=>seed.query("update client_assignments set starts_at=now()+interval '1 day' where id=$1",[x.assignment]),'ASSIGNMENT'],
    ['expired collaborator',x=>seed.query("update firm_collaborators set ends_at=now()-interval '1 second' where id=$1",[x.collab]),'OWNER'],
    ['staff seat',x=>seed.query("update firm_collaborators set seat_role='junior' where id=$1",[x.collab]),'OWNER'],
    ['external affiliation',x=>seed.query("update firm_collaborators set affiliation='external' where id=$1",[x.collab]),'OWNER'],
    ['new subject bound to suspended collaborator',x=>seed.query("insert into firm_collaborators(id,firm_id,user_id,email,name,role,status) values($1,$2,$3,$4,'Other','owner','suspended')",[`other-${x.collab}`,firmId,x.current,`other-${x.email}`]),'CONFLICT'],
    ['new subject bound to inactive member',x=>seed.query("insert into firm_members(id,firm_id,user_id,email,name,role,status) values($1,$2,$3,$4,'Other','admin','inactive')",[`other-${x.collab}`,firmId,x.current,`other-${x.email}`]),'CONFLICT'],
    ['second historical assignment',async x=>{const other=await make();await seed.query("insert into client_assignments(id,firm_id,client_id,principal_type,principal_id,role,ends_at) values($1,$2,$3,'firm_collaborator',$4,'owner',now()-interval '1 day')",[`extra-${x.assignment}`,firmId,other.clientId,x.collab]);},'ASSIGNMENT'],
    ['second future assignment',async x=>{const other=await make();await seed.query("insert into client_assignments(id,firm_id,client_id,principal_type,principal_id,role,starts_at) values($1,$2,$3,'firm_collaborator',$4,'owner',now()+interval '1 day')",[`extra-${x.assignment}`,firmId,other.clientId,x.collab]);},'ASSIGNMENT'],
    ['prior preparation even without current flag',x=>seed.query("insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata) values($1,$2,'firm_member',$3,'pilot.prepared','client',$2,'{}')",[firmId,x.clientId,operatorId]),'ALREADY_USED']
  ];
  for(const [title,mutate,code] of cases)await t.test(title,async()=>{
    const x=await make();await x.ask();const review=await x.review();assert.equal(review.status,200,JSON.stringify(review));
    await mutate(x);const result=await x.approve(review.body.review_digest);
    assert.equal(result.body.code,`OWNER_REVALIDATION_RECOVERY_${code}`,JSON.stringify(result));assert.equal(await x.binding(),x.old);
  });
  await t.test('strict operator cannot bind NULL ids or authorize through matching email; owner/shared token cannot approve',async()=>{
    const x=await make();await x.ask();
    for(const user of [null,'00000000-0000-4000-8000-999999999999']){
      await seed.query('update firm_members set user_id=$1 where id=$2',[user,operatorId]);
      assert.equal((await x.review()).body.code,'OWNER_REVALIDATION_RECOVERY_OPERATOR');
      assert.equal((await seed.query('select user_id from firm_members where id=$1',[operatorId])).rows[0].user_id,user);
    }
    await seed.query('update firm_members set user_id=$1 where id=$2',[operatorUser,operatorId]);
    for(const token of [x.token,'shared-not-owner'])assert.equal((await http(token,`${x.path}?firm_id=${firmId}&recovery=owner`)).body.code,'OWNER_REVALIDATION_RECOVERY_OPERATOR');
    for(const body of [{owner_revalidation:{action:'recovery_request',confirmed:true,review_digest:'a'.repeat(64),old_user_id:x.old}},
      {client_id:x.clientId,owner_revalidation:{action:'recovery_review'}}]) assert.notEqual((await http(x.token,'/self-provision',body)).status,200);
    assert.equal(await x.binding(),x.old);
  });
  await t.test('cancellation, stale profile, expiry and refreshed owner request retire earlier consent',async()=>{
    const x=await make();const q=await x.ask(),r=await x.review();
    assert.equal((await x.owner('recovery_cancel',q.body.review_digest)).status,200);
    assert.equal((await x.approve(r.body.review_digest)).body.code,'OWNER_REVALIDATION_RECOVERY_CLOSED');
    await x.ask();const newer=await x.review();
    await seed.query("update clients set company_name='Changed Oy' where id=$1",[x.clientId]);
    assert.equal((await x.approve(newer.body.review_digest)).body.code,'OWNER_REVALIDATION_RECOVERY_CHANGED');
    const q2=await x.ask();assert.notEqual(q2.body.receipt_id,q.body.receipt_id);
    const fact=(await seed.query('select metadata from audit_events where id=$1',[q2.body.receipt_id])).rows[0].metadata;
    const times=(await seed.query("select now()-interval '31 minutes' as created,now()-interval '1 minute' as expires")).rows[0];
    fact.expires_at=times.expires.toISOString();
    await seed.query("insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata,created_at) values($1,$2,'supabase_user',$3,'client.owner_recovery_requested','client',$2,$4,$5)",[firmId,x.clientId,x.current,fact,times.created]);
    assert.equal((await x.review()).body.code,'OWNER_REVALIDATION_RECOVERY_CHANGED');
    assert.equal(await x.binding(),x.old);
  });
  await t.test('audit failure rolls back binding; concurrent retry produces one repair',async()=>{
    const x=await make();await x.ask();const r=await x.review();
    await seed.query(`create function recovery_fail_audit() returns trigger language plpgsql as $$begin
      if new.action='client.owner_identity_rebound' then raise exception 'injected audit failure';end if;return new;end$$;
      create trigger recovery_fail_audit before insert on audit_events for each row execute function recovery_fail_audit()`);
    assert.equal((await x.approve(r.body.review_digest)).status,503);assert.equal(await x.binding(),x.old);
    await seed.query('drop trigger recovery_fail_audit on audit_events;drop function recovery_fail_audit()');
    // Review the still-current request again; the failed audit never counts
    // as a completed recovery or consumes owner consent.
    await x.ask();const fresh=await x.review();
    const results=await Promise.all([x.approve(fresh.body.review_digest),x.approve(fresh.body.review_digest)]);
    assert.ok(results.every(v=>v.status===200),JSON.stringify(results));assert.equal(results[0].body.receipt_id,results[1].body.receipt_id);
    assert.equal((await seed.query("select count(*)::int n from audit_events where client_id=$1 and action='client.owner_identity_rebound'",[x.clientId])).rows[0].n,1);
  });
  await t.test('identity and assignment changes during a real entity-lock wait win before binding',async()=>{
    for(const type of ['identity','assignment']){
      const x=await make();await x.ask();const r=await x.review();
      locker=new pg.Client({connectionString:url.toString()});await locker.connect();await locker.query('begin');
      await locker.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`entity-readiness:${firmId}:${x.clientId}`]);
      const pending=x.approve(r.body.review_digest);
      await new Promise(resolve=>setTimeout(resolve,100));
      if(type==='identity')await seed.query('insert into auth.users(id,email) values($1,$2)',[x.old,x.email]);
      else await seed.query("update client_assignments set ends_at=now()-interval '1 second' where id=$1",[x.assignment]);
      await locker.query('commit');await locker.end();locker=null;
      assert.notEqual((await pending).status,200);assert.equal(await x.binding(),x.old);
    }
  });
  await t.test('provider table contention refuses NOWAIT without holding up authentication',async()=>{
    const x=await make();await x.ask();const r=await x.review();
    locker=new pg.Client({connectionString:url.toString()});await locker.connect();await locker.query('begin');
    await locker.query('update auth.users set created_at=created_at where id=$1',[operatorUser]);
    const result=await x.approve(r.body.review_digest);assert.equal(result.status,503);assert.equal(await x.binding(),x.old);
    await locker.query('rollback');await locker.end();locker=null;
  });
  await t.test('missing auth SELECT or SHARE privilege refuses cleanly with zero recovery mutation',async()=>{
    const x=await make();await x.ask();const r=await x.review(),before=await snapshot(x);
    const role=`recovery_select_${process.pid}`;
    await seed.query(`create role ${role} bypassrls;grant usage on schema public,auth to ${role};grant all on all tables in schema public to ${role};grant all on all sequences in schema public to ${role}`);
    const restricted=new pg.Pool({connectionString:url.toString(),options:`-c role=${role}`});restricted.on('error',()=>{});
    try{
      __setFirmDbPoolForTests(restricted);
      const deniedRead=await x.owner('recovery_review');assert.equal(deniedRead.status,503);assert.doesNotMatch(deniedRead.body.error,/auth.users|permission denied|postgres/i);
      await seed.query(`grant select on auth.users to ${role}`);
      assert.equal((await x.review()).body.code,'OWNER_REVALIDATION_RECOVERY_PRIVILEGES','review reports the actual runtime lock-privilege gap');
      const deniedWrite=await x.approve(r.body.review_digest);assert.equal(deniedWrite.status,503);
      assert.equal(await x.binding(),x.old);assert.deepEqual(await snapshot(x),before);
      assert.equal((await seed.query("select count(*)::int n from audit_events where client_id=$1 and action='client.owner_identity_rebound'",[x.clientId])).rows[0].n,0);
    }finally{__setFirmDbPoolForTests(pool);await restricted.end();await seed.query(`drop owned by ${role};drop role ${role}`);}
  });
  await t.test('principal and assignment write contention refuses before mutation',async()=>{
    for(const relation of ['firm_collaborators','firm_members','client_assignments']){
      const x=await make();await x.ask();const r=await x.review();
      locker=new pg.Client({connectionString:url.toString()});await locker.connect();await locker.query('begin');
      await locker.query(`lock table ${relation} in row exclusive mode`);
      assert.equal((await x.approve(r.body.review_digest)).status,503);assert.equal(await x.binding(),x.old);
      await locker.query('rollback');await locker.end();locker=null;
    }
  });
  await t.test('client FOR UPDATE fences real document inserts while final recovery holds authority locks',async()=>{
    const x=await make();await x.ask();const r=await x.review();
    locker=new pg.Client({connectionString:url.toString()});await locker.connect();await locker.query('begin');
    await locker.query('select pg_advisory_xact_lock(782192)');
    await seed.query(`create function recovery_write_pause() returns trigger language plpgsql as $$begin
      perform pg_advisory_xact_lock(782192);return new;end$$;
      create trigger recovery_write_pause before update on firm_collaborators for each row execute function recovery_write_pause()`);
    const pending=x.approve(r.body.review_digest);
    let waiting=false;
    for(let n=0;n<50;n++){
      const found=await seed.query("select 1 from pg_stat_activity where datname=current_database() and wait_event='advisory' and query like 'update firm_collaborators fc%'");
      if(found.rowCount){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(waiting,true,'the actual writer reached the held final statement');
    const bookWriter=new pg.Client({connectionString:url.toString()});await bookWriter.connect();
    try{await bookWriter.query("set lock_timeout='100ms'");
      await assert.rejects(bookWriter.query("insert into documents(id,firm_id,client_id,filename) values('racing-document',$1,$2,'racing.pdf')",[firmId,x.clientId]),{code:'55P03'});
    }finally{await bookWriter.end();await locker.query('commit');await locker.end();locker=null;}
    const applied=await pending;assert.equal(applied.status,200,JSON.stringify(applied));
    await seed.query('drop trigger recovery_write_pause on firm_collaborators;drop function recovery_write_pause()');
    assert.equal((await seed.query("select count(*)::int n from documents where id='racing-document'")).rows[0].n,0);
  });
  await t.test('a document committed before final approval refuses the empty-book transition',async()=>{
    const x=await make();await x.ask();const r=await x.review();
    await seed.query("insert into documents(id,firm_id,client_id,filename) values('prior-document',$1,$2,'prior.pdf')",[firmId,x.clientId]);
    assert.equal((await x.approve(r.body.review_digest)).body.code,'PILOT_EMPTY_CLIENT_REQUIRED');assert.equal(await x.binding(),x.old);
  });
  await t.test('request expiry during the entity-lock wait refuses before mutation',async()=>{
    const x=await make();const q=await x.ask();
    const fact=(await seed.query('select metadata from audit_events where id=$1',[q.body.receipt_id])).rows[0].metadata;
    const times=(await seed.query("select now()-interval '30 minutes'+interval '400 milliseconds' as created,now()+interval '400 milliseconds' as expires")).rows[0];
    fact.expires_at=times.expires.toISOString();
    await seed.query("insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata,created_at) values($1,$2,'supabase_user',$3,'client.owner_recovery_requested','client',$2,$4,$5)",[firmId,x.clientId,x.current,fact,times.created]);
    const r=await x.review();assert.equal(r.status,200,JSON.stringify(r));
    locker=new pg.Client({connectionString:url.toString()});await locker.connect();await locker.query('begin');
    await locker.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`entity-readiness:${firmId}:${x.clientId}`]);
    const pending=x.approve(r.body.review_digest);await new Promise(resolve=>setTimeout(resolve,600));
    await locker.query('commit');await locker.end();locker=null;
    assert.equal((await pending).body.code,'OWNER_REVALIDATION_RECOVERY_CHANGED');assert.equal(await x.binding(),x.old);
  });
  await t.test('whole-transaction deadline rolls back binding and releases global locks',async()=>{
    const x=await make();await x.ask();const r=await x.review();
    await seed.query(`create function recovery_audit_timeout() returns trigger language plpgsql as $$begin
      if new.action='client.owner_identity_rebound' then perform pg_sleep(6);end if;return new;end$$;
      create trigger recovery_audit_timeout before insert on audit_events for each row execute function recovery_audit_timeout()`);
    const result=await x.approve(r.body.review_digest);assert.equal(result.status,503);assert.equal(await x.binding(),x.old);
    await seed.query('drop trigger recovery_audit_timeout on audit_events;drop function recovery_audit_timeout()');
    await seed.query("set lock_timeout='100ms'");await seed.query('update auth.users set email=email where id=$1',[operatorUser]);await seed.query('reset lock_timeout');
    assert.equal((await seed.query("select count(*)::int n from audit_events where client_id=$1 and action='client.owner_identity_rebound'",[x.clientId])).rows[0].n,0);
  });
  await t.test('request expiry while the audit inserts rolls back an otherwise valid binding',async()=>{
    const x=await make();const q=await x.ask();
    const fact=(await seed.query('select metadata from audit_events where id=$1',[q.body.receipt_id])).rows[0].metadata;
    const times=(await seed.query("select now()-interval '30 minutes'+interval '400 milliseconds' as created,now()+interval '400 milliseconds' as expires")).rows[0];
    fact.expires_at=times.expires.toISOString();
    await seed.query("insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata,created_at) values($1,$2,'supabase_user',$3,'client.owner_recovery_requested','client',$2,$4,$5)",[firmId,x.clientId,x.current,fact,times.created]);
    const r=await x.review();assert.equal(r.status,200,JSON.stringify(r));
    await seed.query(`create function recovery_late_audit() returns trigger language plpgsql as $$begin
      if new.action='client.owner_identity_rebound' then perform pg_sleep(0.6);end if;return new;end$$;
      create trigger recovery_late_audit before insert on audit_events for each row execute function recovery_late_audit()`);
    const result=await x.approve(r.body.review_digest);assert.equal(result.body.code,'OWNER_REVALIDATION_RECOVERY_CHANGED');assert.equal(await x.binding(),x.old);
    await seed.query('drop trigger recovery_late_audit on audit_events;drop function recovery_late_audit()');
    assert.equal((await seed.query("select count(*)::int n from audit_events where client_id=$1 and action='client.owner_identity_rebound'",[x.clientId])).rows[0].n,0);
  });
});
