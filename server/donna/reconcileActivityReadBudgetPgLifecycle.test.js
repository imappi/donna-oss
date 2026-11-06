import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { readReconcileActivityWithClient } from './db/reconcileActivity.js';
import { getFirmSnapshotFromDb } from './db/snapshot.js';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from './db/pool.js';
import { currentCodingEvidence, codingEvidenceDigest, hasPendingCodingReconsiderationWithClient, pendingMatchedCodingReconsiderationIdsWithClient } from './db/codingEvidence.js';
import { hasPendingPostingRecoveryWithClient, pendingPostingRecoveryIdsWithClient } from './db/codingRefusalRecovery.js';
import { CODING_RECONSIDERATION_CONTRACT } from './codingPolicyRecovery.js';
import { installConvergenceSettleOnPool, settleCommittedConvergenceMarks } from './reconcileConvergenceState.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
test('real PG: a populated Finnish snapshot uses bounded activity reads on the two-connection pool', {
  skip: !pgUrl && 'INCOMPLETE: DONNA_PG_TEST_URL required', timeout: 60000
}, async t => {
  const name = `donna_activity_budget_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: pgUrl });
  await admin.connect(); await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl); url.pathname = `/${name}`;
  const seed = new pg.Client({ connectionString: url.toString() }); await seed.connect();
  const pool = new pg.Pool({ connectionString: url.toString(), max: 2, connectionTimeoutMillis: 2000 });
  const closed = [];
  pool.on('connect', c => closed.push(new Promise(resolve => c.once('end', resolve))));
  installConvergenceSettleOnPool(pool);
  __setFirmDbPoolForTests(pool);
  t.after(async () => {
    __resetFirmDbPoolForTests(); await pool.end(); await Promise.all(closed);
    await seed.end(); await admin.query(`drop database "${name}"`); await admin.end();
  });
  await seed.query(`create schema storage;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)`);
  const migrations = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(f => f.endsWith('.sql')).sort()) {
    await seed.query(await readFile(new URL(file, migrations), 'utf8'));
  }
  await seed.query("insert into firms(id,name,slug) values('loading','Loading proof','loading')");
  for (const clientId of ['salon-a', 'salon-b']) {
    await seed.query(`insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile)
      values($1,'loading',$1,'FI','fi-oy','{"accounting_system":"none"}')`, [clientId]);
    await seed.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,created_at)
      values($1,'loading',$2,'Statement.pdf','bank_statement','completed',now()-interval '1 day')`, [`doc-${clientId}`, clientId]);
    await seed.query(`insert into transactions(id,firm_id,client_id,document_id,transaction_date,money_out,currency,status,coding_state,payload,created_at)
      select $1 || '-' || n,'loading',$1,$2,'2025-02-06',13.60,'EUR','needs_review','applied',
        '{"ai_suggestion":{"suggested_at":1},"ai_suggestion_status":"auto_applied"}',now()-interval '1 day'
      from generate_series(1,36) n`, [clientId, `doc-${clientId}`]);
  }
  const transactions = (await seed.query("select * from transactions where firm_id='loading' order by id")).rows;
  const documents = (await seed.query("select * from documents where firm_id='loading'")).rows;
  const observedAt = new Date().toISOString();
  let calls = 0;
  const reader = { query: (...args) => { calls++; return seed.query(...args); } };
  const activity = await readReconcileActivityWithClient(reader, { firmId: 'loading', transactions, documents, observedAt });
  assert.ok(calls <= 24, `72 lines must not perform per-line recovery queries: got ${calls}`);
  assert.equal(activity.size, 0, 'no artificial processing owner for unchanged completed source');
  // The seed wrote through a raw client, so its convergence marks are still
  // unsettled. Settle them first: otherwise whichever snapshot releases first
  // persists convergence_state while the other has already read null, and the
  // equality below races (it failed intermittently, mostly under TZ=Asia/Dubai).
  const settled = await settleCommittedConvergenceMarks(seed, { logger: null });
  assert.equal(settled.error, undefined);
  assert.equal(settled.skipped, undefined);
  assert.ok(settled.claimed > 0, 'the physical seed connection settled its committed marks');
  const persisted = (await seed.query("select id,convergence_state,convergence_reason from transactions where firm_id='loading'")).rows;
  assert.equal(persisted.length, 72);
  assert.ok(persisted.every(row => row.convergence_state === 'auto_reconciled' && row.convergence_reason === 'coding_state:applied'));
  assert.equal((await seed.query("select count(*)::int AS n from convergence_marks where firm_id='loading'")).rows[0].n, 0);
  // Drive the real snapshot and installed release hook concurrently, not only
  // the batched helper. No pool expansion or borrowed-client test double.
  const [first, second] = await Promise.all([
    getFirmSnapshotFromDb({ firmId: 'loading', observedAt }),
    getFirmSnapshotFromDb({ firmId: 'loading', observedAt })
  ]);
  assert.equal(pool.options.max, 2);
  assert.equal(first.transactions.length, 72);
  assert.deepEqual(first.transactions, second.transactions);
  // Mixed neighbors must retain the scalar reader's actual eligibility, match
  // precedence, source digest and retry budget. Mere resemblance is not a wake.
  for (const flag of ['FINLAND_ALV_CODING', 'CODING_AUTO_POST', 'LEDGER_AUTO_POST']) {
    await seed.query(`insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source)
      values($1,'loading','salon-a',$1,'auto','manual')`, [flag]);
  }
  await seed.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,tax_amount,currency,document_date)
    values('source','loading','salon-a','Receipt.pdf','receipt','completed',13.60,2.76,'EUR','2025-02-06'),
          ('unrelated','loading','salon-a','Same amount.pdf','receipt','completed',13.60,2.76,'EUR','2025-02-06')`);
  await seed.query(`insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount)
    values('source-line','loading','salon-a','source',1,'Subscription',13.60)`);
  for (const n of [1, 2, 3, 4, 5, 9]) {
    await seed.query(`insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,status)
      values($1,'loading','salon-a',$2,'receipt','source','auto_matched')`, [`match-${n}`, `salon-a-${n}`]);
  }
  const document = await currentCodingEvidence({client: seed, firmId:'loading',clientId:'salon-a',transactionId:'salon-a-1'});
  const digest = codingEvidenceDigest(document);
  const payload = (evidenceDigest, extra = {}) => ({ai_suggestion:{evidence_digest:evidenceDigest},ai_suggestion_status:'auto_applied',...extra});
  const setPayload = (n, value) => seed.query('update transactions set payload=$1 where id=$2', [value, `salon-a-${n}`]);
  await setPayload(1, payload('old-source'));
  await setPayload(2, payload(digest));
  await setPayload(3, payload('old-source', {reviewed_by:'human-member'}));
  await setPayload(4, payload('old-source', {ledger_journal_id:'prior-4',coding_correction_required:{current_evidence_digest:digest}}));
  await setPayload(5, payload('old-source', {ledger_journal_id:'prior-5'}));
  for (const [n, attempts] of [[6,3], [7,2]]) {
    await setPayload(n, payload(codingEvidenceDigest(null), {
      ledger_post_refusal:{code:'TRANSACTION_ALV_TREATMENT_UNRESOLVED'},
      coding_evidence_reconsideration:{contract:CODING_RECONSIDERATION_CONTRACT,attempts}
    }));
  }
  await setPayload(9, payload(digest, {ledger_post_refusal:{code:'TRANSACTION_ALV_TREATMENT_UNRESOLVED'}}));
  const ids = Array.from({length:9}, (_,i) => `salon-a-${i+1}`);
  const expected = ['salon-a-1','salon-a-5','salon-a-7'];
  assert.deepEqual([...(await pendingMatchedCodingReconsiderationIdsWithClient(seed,'loading','salon-a',ids))].sort(), expected);
  const scalar = [];
  for (const id of ids) if (await hasPendingCodingReconsiderationWithClient(seed,'loading','salon-a',id,{matchedOnly:true})) scalar.push(id);
  assert.deepEqual(scalar, expected);
  assert.deepEqual([...(await pendingMatchedCodingReconsiderationIdsWithClient(seed,'loading','salon-b',ids))], [], 'client scope is preserved');
  const posting = await pendingPostingRecoveryIdsWithClient(seed,'loading',ids);
  assert.deepEqual([...posting], ['salon-a-9'], 'only the held completed source enters posting recovery');
  for (const id of ids) assert.equal(posting.has(id), await hasPendingPostingRecoveryWithClient(seed,'loading',id));
  await seed.query("update client_capability_config set stage='off' where flag_key='LEDGER_AUTO_POST'");
  assert.deepEqual([...(await pendingPostingRecoveryIdsWithClient(seed,'loading',ids))], [], 'disabled recovery cannot claim processing');
  assert.equal((await seed.query('select count(*)::int n from ledger_journals')).rows[0].n, 0);
});
