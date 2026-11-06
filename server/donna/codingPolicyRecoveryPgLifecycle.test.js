// Actual batch-coding and profile writers plus the existing convergence clock,
// on a freshly created database. Only provider HTTP is replaced; no live books.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import {
  __setFirmDbPoolForTests, __resetFirmDbPoolForTests,
  batchSuggestTransactionCodingInDb, suggestTransactionCodingInDb, updateClientProfileInDb, getFirmSnapshotFromDb
} from './firmDb.js';
import { runCodingConvergence } from './codingConvergence.js';
import { buildCaseHealth } from './caseHealth.js';
import { getOperatorCaseSnapshot } from './operatorCaseSnapshot.js';
import { settleCommittedConvergenceMarks } from './reconcileConvergenceState.js';
import { recordCodingPolicyFailure, CODING_POLICY_FAILED_ACTION, CODING_POLICY_RECOVERED_ACTION } from './codingPolicyRecovery.js';
import { jurisdictionCaptureState, entityTypeIdentityConflict } from '../../src/lib/onboardingSetup.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;

test('real PG: policy failure before provider/writes; profile correction and existing clock recover once while peers continue', {
  skip: pgUrl ? false : 'DONNA_PG_TEST_URL not set — disposable-PG coding lifecycle not exercised'
}, async (t) => {
  const name = `donna_jn_recovery_${Date.now().toString(36)}_${process.pid}`;
  const admin = new pg.Client({ connectionString: pgUrl });
  await admin.connect();
  await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  // pg-pool can finish end() after removing its clients but before their
  // sockets close. Await each protocol shutdown before dropping the database;
  // DROP ... FORCE can otherwise kill an idle socket still emitting errors.
  const connectionsClosed = [];
  pool.on('connect', (connection) => {
    connectionsClosed.push(new Promise((resolve) => connection.once('end', resolve)));
  });
  __setFirmDbPoolForTests(pool);
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-policy-key';
  t.after(async () => {
    __resetFirmDbPoolForTests();
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
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
  const firmId = 'jn-test-firm';
  await pool.query("insert into firms (id, name, slug) values ($1, 'Policy test firm', 'jn-test-firm')", [firmId]);
  for (const [id, jurisdiction] of [['missing', null], ['healthy', 'gb']]) {
    await pool.query(
      `insert into clients (id, firm_id, company_name, jurisdiction, profile)
       values ($1, $2, 'Policy fixture Ltd', $3, $4::jsonb)`,
      [id, firmId, jurisdiction, JSON.stringify({ companyName: 'Policy fixture Ltd', accounting_system: 'none', ...(jurisdiction ? { jurisdiction } : {}) })]
    );
    await pool.query(
      `insert into transactions (id, firm_id, client_id, transaction_date, description, money_in, money_out, currency, status)
       values ($1, $2, $3, '2026-06-01', 'SERVICE PAYMENT', 200, 0, 'GBP', 'needs_review')`,
      [`tx-${id}`, firmId, id]
    );
  }
  await pool.query(`insert into transactions (id, firm_id, client_id, transaction_date, description, currency, status, coding_state, payload)
    values ('tx-posted', $1, 'missing', '2026-06-01', 'ALREADY POSTED', 'GBP', 'posted', 'posted', '{"sentinel":"original"}')`, [firmId]);
  const seedConnection = await pool.connect();
  try { await settleCommittedConvergenceMarks(seedConnection); }
  finally { seedConnection.release(); }
  const postedBefore = (await pool.query("select * from transactions where id = 'tx-posted'")).rows[0];
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (endpoint, init) => {
    assert.equal(endpoint, 'https://api.openai.com/v1/responses', 'no unplanned external request');
    const body = JSON.parse(init.body);
    const input = JSON.parse(body.input);
    calls.push(input);
    const output = {
      suggestions: (input.transactions || [input.transaction]).map((transaction) => ({
        transaction_id: transaction.id, proposed_account: 'Sales', contact: 'Customer', tax_treatment: 'VAT 20%',
        support_note: 'Invoice details are required.', ask_client_question: 'What does this payment cover?',
        evidence_required: true, remember_candidate: false, merchant_pattern: '',
        missing_account_name: '', missing_account_type: '', missing_account_reason: '',
        auto_explain_limit: 0, confidence: 'high', materiality: 'normal',
        reasoning: 'Service payment; underlying invoice remains to be supplied.', warnings: [], alternatives: []
      })), group_summary: []
    };
    const responseOutput = input.transactions ? output : output.suggestions[0];
    return { ok: true, json: async () => ({ id: `test-response-${calls.length}`, output_text: JSON.stringify(responseOutput) }) };
  });
  const readFailure = async () => (await pool.query(
    "select * from audit_events where firm_id = $1 and resource_id = 'tx-missing' and action = any($2::text[]) order by id",
    [firmId, [CODING_POLICY_FAILED_ACTION, CODING_POLICY_RECOVERED_ACTION]]
  )).rows;
  const readMissing = async () => (await pool.query("select * from transactions where id = 'tx-missing'")).rows[0];
  const beforeAccounts = Number((await pool.query('select count(*)::int as n from ledger_accounts')).rows[0].n);
  const failed = await batchSuggestTransactionCodingInDb({ firmId, clientIds: ['missing'] });
  assert.equal(failed.transaction_ai_batch.summaries[0].policy_failure, true);
  assert.equal(calls.length, 0);
  assert.equal((await readMissing()).payload.ai_suggestion, undefined);
  assert.equal(Number((await pool.query('select count(*)::int as n from ledger_accounts')).rows[0].n), beforeAccounts);
  const incident = await readFailure();
  assert.equal(incident.length, 1);
  assert.equal(incident[0].metadata.reason_code, 'jurisdiction_unresolved');
  const failedHealth = buildCaseHealth({ transaction: await readMissing(), auditEvents: incident });
  assert.equal(failedHealth.phase, 'needs_owner', JSON.stringify(failedHealth));
  const addAuditNoise = () => pool.query(`insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
    select $1, 'missing', 'system', 'fixture.noise', 'transaction', 'tx-missing', '{}'::jsonb from generate_series(1, 205)`, [firmId]);
  const snapshot = () => getOperatorCaseSnapshot({ firmId, clientId: 'missing', focus: { type: 'transaction', id: 'tx-missing' }, include: ['case_health'] });
  await addAuditNoise();
  const visibleFailure = await snapshot();
  assert.equal(visibleFailure.case_health.phase, 'needs_owner', JSON.stringify(visibleFailure.case_health));
  assert.ok(visibleFailure.case_health.integration_failures.some((row) => row.system === 'coding_policy'), 'live assembler preserves incident beyond 200 events');

  const askClients = [];
  const tick = () => runCodingConvergence({
    firmId,
    // Actual discovery + batch + release are production defaults; unrelated
    // authority-controlled posting and outbound asks are outside this fixture.
    discoverSweepClientsFn: async () => [], discoverLedgerPostClientsFn: async () => [],
    recoverAskDraftFn: async () => [],
    requestAskDraftFn: async ({ clientId }) => { askClients.push(clientId); return { enqueued: 0 }; }
  });
  const firstTick = await tick();
  assert.ok(firstTick.coder.some((row) => row.client_id === 'missing' && row.policy_failure));
  assert.ok(firstTick.coder.some((row) => row.client_id === 'healthy' && row.suggested === 1));
  assert.equal(calls.length, 1);
  assert.ok(!askClients.includes('missing'));

  await updateClientProfileInDb({ firmId, clientId: 'missing', profilePatch: { jurisdiction: 'gb' }, actorId: 'fixture-owner' });
  const recoveredTick = await tick();
  assert.ok(recoveredTick.coder.some((row) => row.client_id === 'missing' && row.suggested === 1));
  assert.equal(calls.length, 2);
  const current = await readMissing();
  assert.equal(current.payload.ai_suggestion.tax_treatment, 'VAT 20%');
  const recovered = await readFailure();
  assert.equal(recovered.at(-1).action, CODING_POLICY_RECOVERED_ACTION);
  assert.ok(recovered.at(-1).metadata.policy_id);
  assert.ok(!buildCaseHealth({ transaction: current, auditEvents: recovered }).integration_failures.some((row) => row.system === 'coding_policy'));
  await addAuditNoise();
  const visibleRecovery = await snapshot();
  assert.ok(visibleRecovery.case_health.present, JSON.stringify(visibleRecovery.case_health));
  assert.ok(!visibleRecovery.case_health.integration_failures.some((row) => row.system === 'coding_policy'), 'live assembler preserves recovery beyond 200 events');
  await tick();
  assert.equal(calls.length, 2, 'no repeated decision after successful coding');
  assert.deepEqual((await pool.query("select * from transactions where id = 'tx-posted'")).rows[0], postedBefore);

  // Failure receipts use an autocommit connection after rollback, so the
  // accounting transaction cannot erase its own explanation.
  const connection = await pool.connect();
  try {
    await connection.query('begin');
    await connection.query("update transactions set description = 'ROLLED BACK' where id = 'tx-missing'");
    await connection.query('rollback');
    const error = Object.assign(new Error('configuration unavailable'), { code: 'coding_policy_unavailable' });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await recordCodingPolicyFailure({ client: connection, firmId, clientId: 'missing', transactionIds: ['tx-missing'], error });
    }
  } finally { connection.release(); }
  const escalation = (await readFailure()).at(-1);
  assert.equal(escalation.metadata.attempts, 3);
  assert.equal(escalation.metadata.escalation_required, true);
  assert.equal(escalation.metadata.owner_question, undefined);
  assert.equal((await readMissing()).description, current.description);
  const conflictConnection = await pool.connect();
  try {
    for (const reason of ['profile_jurisdiction_conflict', 'coding_policy_receipt_conflict', 'stamped_policy_context_conflict']) {
      const error = Object.assign(new Error('context changed'), { code: 'jurisdiction_context_conflict', details: { reason } });
      await recordCodingPolicyFailure({ client: conflictConnection, firmId, clientId: 'missing', transactionIds: ['tx-missing'], error });
      const receipt = (await readFailure()).at(-1);
      assert.equal(receipt.metadata.reason_detail, reason);
      assert.equal(receipt.metadata.attempts, 1, 'different conflict subtype starts a new episode');
      if (reason === 'profile_jurisdiction_conflict') {
        assert.equal(receipt.metadata.failure_kind, 'missing_owner_fact');
      } else {
        assert.equal(receipt.metadata.failure_kind, 'system_failure');
        assert.equal(receipt.metadata.owner_question, undefined);
        assert.equal(receipt.metadata.recovery_route, 'transaction_coding_retry');
      }
    }
  } finally { conflictConnection.release(); }
  // The mounted repair action uses this named single-transaction writer. It
  // recodes a stale proposal under current policy and clears its own incident.
  await suggestTransactionCodingInDb({ firmId, transactionId: 'tx-missing' });
  assert.equal(calls.length, 3);
  assert.equal((await readFailure()).at(-1).action, CODING_POLICY_RECOVERED_ACTION);
  assert.ok(!(await snapshot()).case_health.integration_failures.some((row) => row.system === 'coding_policy'));

  await pool.query(`insert into clients (id, firm_id, company_name, jurisdiction, profile)
    values ('config-failure', $1, 'Config failure Ltd', 'gb', '{"jurisdiction":"gb","accounting_system":"none"}')`, [firmId]);
  await pool.query(`insert into transactions (id, firm_id, client_id, transaction_date, description, currency, money_in, status)
    values ('tx-config', $1, 'config-failure', '2026-06-01', 'SERVICE PAYMENT', 'GBP', 200, 'needs_review')`, [firmId]);
  await pool.query('alter table client_capability_config rename to fixture_unavailable_config');
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const unavailable = await batchSuggestTransactionCodingInDb({ firmId, clientIds: ['config-failure'] });
      assert.equal(unavailable.transaction_ai_batch.summaries[0].policy_error.code, 'coding_policy_unavailable');
    }
    assert.equal(calls.length, 3, 'failed real configuration SQL cannot invoke the provider');
  } finally { await pool.query('alter table fixture_unavailable_config rename to client_capability_config'); }
  const configIncident = (await pool.query("select * from audit_events where resource_id = 'tx-config' and action = $1 order by id", [CODING_POLICY_FAILED_ACTION])).rows;
  assert.equal(configIncident.length, 3, 'repeated real failures stop appending audit receipts at the bound');
  const exhaustedConfigIncident = configIncident.at(-1);
  assert.equal(exhaustedConfigIncident.metadata.failure_kind, 'system_failure');
  assert.equal(exhaustedConfigIncident.metadata.owner_question, undefined);
  assert.equal(exhaustedConfigIncident.metadata.attempts, 3);
  assert.equal(exhaustedConfigIncident.metadata.escalation_required, true);
  assert.equal(exhaustedConfigIncident.metadata.recovery_route, 'runtime_policy_incident');
  const configSnapshot = () => getOperatorCaseSnapshot({
    firmId, clientId: 'config-failure', focus: { type: 'transaction', id: 'tx-config' }, include: ['case_health']
  });
  // Honest boundary: the existing snapshot exposes a stuck operational incident.
  // This is not proof that any person received or accepted a repair handoff.
  const exhaustedHealth = (await configSnapshot()).case_health;
  assert.equal(exhaustedHealth.phase, 'stuck');
  assert.equal(exhaustedHealth.recovery.class, null);
  assert.equal(exhaustedHealth.recovery.basis, 'coding_policy_incident_requires_repair');
  await tick();
  assert.equal(calls.length, 4, 'the same existing clock resumes after configuration is restored');
  const configRecoveries = () => pool.query("select * from audit_events where resource_id = 'tx-config' and action = $1 order by id", [CODING_POLICY_RECOVERED_ACTION]);
  const recoveredConfig = (await configRecoveries()).rows;
  assert.equal(recoveredConfig.length, 1);
  assert.equal(recoveredConfig[0].metadata.recovered_failure_id, String(exhaustedConfigIncident.id));
  assert.ok(!(await configSnapshot()).case_health.integration_failures.some((row) => row.system === 'coding_policy'));
  await tick();
  assert.equal(calls.length, 4, 'exhausted incident recovery does not repeat the decision');
  assert.deepEqual((await configRecoveries()).rows, recoveredConfig, 'the exact exhausted receipt closes once');

  // Reproduce the interleaving where a failed caller records its receipt AFTER
  // another caller has already committed a valid proposal. No review sidecar or
  // new upload is allowed to rescue discovery accidentally.
  await pool.query("delete from transaction_review_queue where firm_id = $1 and client_id = 'missing'", [firmId]);
  // A full ordinary round of owner-wait cases must not consume the batch limit
  // before the no-sidecar incident reaches the direct pool. These rows also
  // qualify for the matched pool, proving both earlier pools retain capacity.
  await pool.query(`insert into transactions
    (id, firm_id, client_id, transaction_date, description, currency, money_in, status, coding_state, reconciliation_status, payload)
    select 'tx-policy-wait-' || n, $1, 'missing', '2026-05-01', 'WAITING FOR OWNER', 'GBP', 200,
           'needs_review', 'proposed', 'explained', '{"sentinel":"waiting-owner"}'::jsonb
      from generate_series(1, 80) n`, [firmId]);
  await pool.query(`insert into transaction_review_queue
    (id, firm_id, client_id, item_type, item_id, reason, status)
    select 'review-policy-wait-' || n, $1, 'missing', 'transaction', 'tx-policy-wait-' || n,
           'owner_fact_required', 'open' from generate_series(1, 80) n`, [firmId]);
  await pool.query(`insert into client_evidence_requests
    (id, firm_id, client_id, transaction_id, review_item_id, status, audience, question)
    select 'ask-policy-wait-' || n, $1, 'missing', 'tx-policy-wait-' || n, 'review-policy-wait-' || n,
           case when n % 2 = 0 then 'draft' else 'open' end, 'client', 'What does this payment cover?'
      from generate_series(1, 80) n`, [firmId]);
  const waitingRowsBefore = (await pool.query("select id, coding_state, payload from transactions where id like 'tx-policy-wait-%' order by id")).rows;
  const proposalBeforeLateFailure = (await readMissing()).payload.ai_suggestion;
  const lateFailureConnection = await pool.connect();
  const lateFailure = (await recordCodingPolicyFailure({
    client: lateFailureConnection, firmId, clientId: 'missing', transactionIds: ['tx-missing'],
    error: Object.assign(new Error('delayed configuration failure'), { code: 'coding_policy_unavailable' })
  }))[0];
  lateFailureConnection.release();
  assert.deepEqual((await readMissing()).payload.ai_suggestion, proposalBeforeLateFailure, 'failure preserves the previous decision until a successful replacement');
  // Another operation must never supersede coding's failure.
  await pool.query(`insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
    values ($1, 'missing', 'system', $2, 'transaction', 'tx-missing', '{"operation":"other"}'),
           ($1, 'missing', 'system', $3, 'transaction', 'tx-posted', '{"operation":"coding"}')`,
  [firmId, CODING_POLICY_RECOVERED_ACTION, CODING_POLICY_FAILED_ACTION]);
  const lateRecoveryTick = await tick();
  assert.ok(lateRecoveryTick.coder.some((row) => row.client_id === 'missing' && row.suggested === 1));
  assert.equal(calls.length, 5, 'existing clock recodes a nonterminal proposal with a late policy failure');
  assert.equal(calls.at(-1).transactions.length, 1, 'owner-wait cases do not crowd out the policy repair or reach the provider');
  assert.deepEqual((await pool.query("select id, coding_state, payload from transactions where id like 'tx-policy-wait-%' order by id")).rows, waitingRowsBefore);
  assert.equal((await readFailure()).at(-1).action, CODING_POLICY_RECOVERED_ACTION);
  assert.equal((await readFailure()).at(-1).metadata.recovered_failure_id, String(lateFailure.id));
  assert.ok(!(await snapshot()).case_health.integration_failures.some((row) => row.system === 'coding_policy'));
  const quietLateRecoveryTick = await tick();
  assert.equal(quietLateRecoveryTick.coder.length, 0, 'no client is rediscovered after recovery, including the posted peer');
  assert.equal(calls.length, 5, 'superseded incident does not repeatedly re-pool its proposal');
  assert.deepEqual((await pool.query("select * from transactions where id = 'tx-posted'")).rows[0], postedBefore, 'even a stale policy incident cannot re-pool a posted peer');

  // The ordinary real configuration-read failure has the same recovery path
  // when it occurs on a previously suggested transaction.
  await pool.query("delete from transaction_review_queue where firm_id = $1 and client_id = 'config-failure'", [firmId]);
  await pool.query('alter table client_capability_config rename to fixture_unavailable_config');
  try {
    const unavailable = await batchSuggestTransactionCodingInDb({ firmId, clientIds: ['config-failure'] });
    assert.equal(unavailable.transaction_ai_batch.summaries[0].policy_error.code, 'coding_policy_unavailable');
    assert.equal(calls.length, 5);
  } finally { await pool.query('alter table fixture_unavailable_config rename to client_capability_config'); }
  await tick();
  assert.equal(calls.length, 6, 'restored configuration re-drives the already suggested transaction without new intake');
  const quietConfigRecoveryTick = await tick();
  assert.equal(quietConfigRecoveryTick.coder.length, 0);
  assert.equal(calls.length, 6);

  // Exercise the real browser DTO, which historically flattened profile over
  // the canonical identity and concealed the facts the owner needed to repair.
  await pool.query(`insert into clients (id, firm_id, company_name, jurisdiction, entity_type, profile)
    values ('identity-conflict', $1, 'Identity fixture', 'gb', 'gb-ltd',
      '{"jurisdiction":"sg","entityType":"sg-pte-ltd","accounting_system":"none"}')`, [firmId]);
  const identityClient = async () => (await getFirmSnapshotFromDb({ firmId })).clients.find((row) => row.id === 'identity-conflict');
  assert.equal(jurisdictionCaptureState(await identityClient()).conflict, true, 'real DTO exposes country disagreement');
  await updateClientProfileInDb({ firmId, clientId: 'identity-conflict', profilePatch: { jurisdiction: 'gb', entity_type: 'gb-ltd' }, actorId: 'owner-identity' });
  assert.equal(jurisdictionCaptureState(await identityClient()).show, false, 'named owner writer clears country repair');
  await pool.query(`update clients set profile = profile || '{"entityType":"gb-sole-trader"}'::jsonb where id = 'identity-conflict'`);
  assert.equal(entityTypeIdentityConflict(await identityClient()), true, 'real DTO retains same-country legal-form conflict');
  await updateClientProfileInDb({ firmId, clientId: 'identity-conflict', profilePatch: { entity_type: 'gb-ltd' }, actorId: 'owner-identity' });
  assert.equal(entityTypeIdentityConflict(await identityClient()), false, 'named owner writer clears legal-form repair');
});
