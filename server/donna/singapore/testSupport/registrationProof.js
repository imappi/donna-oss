import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveClientCodingPolicyWithClient, ensureTransactionReviewItemInDb, updateTransactionReviewItemInDb } from '../../db/coding.js';
import { updateClientProfileInDb } from '../../db/clients.js';
import { NATIVE_REGISTRATION_HISTORY_LIMIT } from '../../nativeChartLineage.js';

// Called by the full-schema hosted lifecycle test after real internal birth.
// Auth, profile/audit writers, providers and apply all remain production owners.
export async function proveDatedRegistration({ t, seed, pool, firmId, clientId, request, admit,
  makeTransaction, suggest, apply, read, requests, setProviderRace, assertAuditAppendOnly }) {
  const route = `/api/donna/firms/clients/${clientId}/profile`;
  const profile = async () => (await seed.query('select profile from clients where firm_id=$1 and id=$2', [firmId, clientId])).rows[0].profile;
  const audit = async () => (await seed.query(`select * from audit_events where firm_id=$1 and client_id=$2
    and action='client.profile.update' and metadata ? 'native_registration' order by id`, [firmId, clientId])).rows;
  const policy = date => resolveClientCodingPolicyWithClient({ client: seed, firmId, clientId, businessDate: date });
  const resolve = async date => (await policy(date)).nativeMenu.registrationEligibility;
  const write = async (record, token = 'a', extra = {}) => request(token, route,
    { firm_id: firmId, profile_patch: { gst_registration: record }, ...extra });
  const save = async (record, token = 'a') => {
    const result = await write(record, token);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return (await profile()).gst_registration_revision;
  };
  const record = { status: 'registered', registered_from: '2024-02-29', registered_until: '2026-12-31',
    verified_from: 'Synthetic registration notification, page 1', verified_at: '2026-09-01', source_document_id: 'native-registration-source' };
  const initialAccounts = (await seed.query('select * from ledger_accounts where client_id=$1 order by id', [clientId])).rows;
  const initialSeed = (await seed.query("select * from audit_events where client_id=$1 and action='ledger.chart.palette_seeded'", [clientId])).rows;
  // The preceding owner-reply probe temporarily assigned a portal owner.
  // This member-created certificate requires zero assignments. Exercise owner
  // writes only while an explicit temporary capability exists, then revoke it
  // before recertifying the original member-created processing fixture.
  await seed.query("delete from client_assignments where id='native-owner-assignment'");
  const assignOwner = status => seed.query(`insert into client_assignments(id,firm_id,client_id,principal_type,principal_id,role,status)
    values('native-owner-assignment',$1,$2,'firm_collaborator','native-owner','owner',$3)`, [firmId, clientId, status]);
  await seed.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,payload)
    values($1,$2,$3,'synthetic-registration.pdf','unknown','completed','2024-02-29','{"fixture":"registration-source"}')`,
  [record.source_document_id, firmId, clientId]);

  await t.test('native authenticated registration is dated, attributable, scoped and readiness-bound', async () => {
    assert.equal((await resolve('2026-09-01')).reason, 'record_missing');
    const original = await admit();
    const first = await save(record);
    assert.equal(first.actor_id, 'member-a'); assert.equal(first.actor_type, 'firm_member');
    assert.equal(first.authority_basis.source, 'authenticated_profile_update');
    assert.equal(first.before, null); assert.equal(first.source.document.id, record.source_document_id);
    const rows = await audit(); assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].metadata.native_registration, first);
    assert.notEqual((await seed.query('select state from entity_readiness_sagas where client_id=$1', [clientId])).rows[0].state, 'ready');
    const fresh = await admit();
    assert.notEqual(fresh.certificate.entity_dependency_digest, original.certificate.entity_dependency_digest);
    assert.equal(fresh.certificate.checks.find(c => c.id === 'persisted_chart').detail.accounting_ready, false);
    for (const date of ['2024-02-29','2026-12-31']) {
      const result = await resolve(date); assert.equal(result.status, 'registered', JSON.stringify(result));
    }
    for (const date of ['2024-02-28','2027-01-01']) assert.equal((await resolve(date)).registered, null);
    assert.equal((await resolve()).reason, 'business_date_missing');
    await assignOwner('active');
    const ownerRevision = await save({ ...record, status: 'deregistered', registered_until: '2026-08-31' }, 'native-owner');
    await seed.query("delete from client_assignments where id='native-owner-assignment'");
    assert.equal(ownerRevision.actor_id, 'native-owner'); assert.equal(ownerRevision.actor_type, 'firm_collaborator');
    assert.equal(ownerRevision.predecessor_digest, first.revision_digest);
    assert.equal((await resolve('2026-09-01')).reason, 'after_recorded_interval');
    const nonregistered = { status: 'not_registered', covered_from: '2026-09-01', covered_until: '2026-09-30',
      verified_from: record.verified_from, verified_at: record.verified_at, source_document_id: record.source_document_id };
    await save(nonregistered);
    assert.equal((await resolve('2026-09-01')).status, 'not_registered');
    assert.equal((await resolve('2026-08-31')).registered, null, 'historical gaps are not inferred from older revisions');
    for (const [patch, reason] of [[{ verified_at: null }, 'unverified'], [{ verified_from: null }, 'verification_source_missing'],
      [{ covered_until: null }, 'covered_interval_missing']]) {
      await save({ ...nonregistered, ...patch });
      const verdict = await resolve('2026-09-01'); assert.equal(verdict.status, 'unknown'); assert.equal(verdict.reason, reason);
      assert.equal(verdict.tax_authority, false);
    }
    const last = await save(null); assert.equal(last.source.kind, 'explicit_withdrawal');
    assert.equal((await resolve('2026-09-01')).reason, 'record_cleared');
    assert.notEqual((await seed.query('select state from entity_readiness_sagas where client_id=$1', [clientId])).rows[0].state, 'ready');
    assert.equal((await admit()).row.state, 'ready', 'unknown still admits processing-only');
    assert.equal((await audit()).length, 7);
  });

  await t.test('native current projection and certificate reject revision forgery and a different lifetime; audit remains append-only', async () => {
    await save(record); const saved = await profile();
    const revision = saved.gst_registration_revision;
    for (const changed of [{ ...revision, revision_digest: 'forged' },
      { ...revision, client_life: { ...revision.client_life, after_delete_id: '999999' } }, null]) {
      await seed.query("update clients set profile=jsonb_set(profile,'{gst_registration_revision}',$2::jsonb) where id=$1",[clientId,JSON.stringify(changed)]);
      await assert.rejects(() => policy('2026-09-01'), error => error.code==='coding_policy_unavailable'
        && error.details.cause==='SINGAPORE_NATIVE_REGISTRATION_INVALID');
      const certificate = (await admit({expected:'failed'})).certificate;
      assert.equal(certificate.checks.find(c=>c.id==='persisted_chart').status,'FAIL');
      await seed.query('update clients set profile=$2 where id=$1',[clientId,saved]);
      await admit();
    }
    await assertAuditAppendOnly();
  });

  await t.test('native profile refusals preserve projection and audit: invalid dates, forged revisions, foreign source/actor', async () => {
    const before = await profile(), receipts = await audit();
    for (const patch of [{ ...record, registered_from: '2023-02-29' }, { ...record, registered_until: '2024-02-28' },
      { ...record, covered_from: '2024-01-01' }, { ...record, revision_digest: 'forged' }]) {
      const result = await write(patch); assert.equal(result.status, 400, JSON.stringify(result.body));
    }
    const forged = await request('a', route, { firm_id: firmId, profile_patch: { gst_registration_revision: { revision_digest: 'forged' } } });
    assert.equal(forged.status, 400);
    assert.equal((await write({ ...record, source_document_id: 'missing-or-foreign-source' })).status, 403);
    const foreignSource = (await seed.query('select id from documents where client_id<>$1 order by id limit 1',[clientId])).rows[0];
    assert.ok(foreignSource);
    assert.equal((await write({ ...record, source_document_id: foreignSource.id })).status, 403);
    assert.equal((await write(record, 'b')).status, 403);
    await seed.query("update firm_members set status='inactive' where id='member-a'");
    try { assert.equal((await write(record)).status,403); }
    finally { await seed.query("update firm_members set status='active' where id='member-a'"); }
    await assert.rejects(() => updateClientProfileInDb({ firmId, clientId, profilePatch: { gst_registration: record }, actorId: 'system' }),
      { code: 'NATIVE_REGISTRATION_AUTHORITY_REQUIRED' });
    await assignOwner('suspended');
    try { assert.equal((await write(record, 'native-owner')).status, 403); }
    finally { await seed.query("delete from client_assignments where id='native-owner-assignment'"); }
    const revoker = await pool.connect();
    try {
      await revoker.query('begin'); await revoker.query("update firm_members set status='inactive' where id='member-a'");
      const refused = await write(record); assert.equal(refused.status, 500, JSON.stringify(refused.body));
      assert.match(JSON.stringify(refused.body), /lock|55P03/i);
    } finally { await revoker.query('rollback'); revoker.release(); }
    assert.deepEqual(await profile(), before); assert.deepEqual(await audit(), receipts);
    await admit();
  });

  await t.test('actual provider and named apply bind the registration revision; model-time and apply-time edits refuse', async () => {
    await save(record); await admit();
    const id = await makeTransaction('dated-registration'); await suggest(id);
    const suggestion = (await read(id)).payload.ai_suggestion;
    const receipt = suggestion.coding_policy.native_registration;
    assert.equal(receipt.status, 'registered'); assert.equal(receipt.business_date, '2026-09-01');
    assert.equal(receipt.revision_digest, (await profile()).gst_registration_revision.revision_digest);
    assert.match(JSON.stringify(requests.at(-1)), /evidenced_registered/);
    assert.match(JSON.stringify(requests.at(-1)), /2026-09-01/);
    await save({ ...record, registered_from: '2026-09-02' }); await admit();
    await assert.rejects(() => apply(id), error => ['jurisdiction_context_conflict','NATIVE_CODING_CHOICE_INVALID'].includes(error.code));
    assert.deepEqual((await read(id)).payload.ai_suggestion, suggestion);
    await suggest(id); assert.equal((await read(id)).payload.ai_suggestion.coding_policy.native_registration.reason, 'before_recorded_interval');
    await apply(id);
    const raceId = await makeTransaction('registration-generation-race');
    setProviderRace(async () => { await save(record); await admit(); });
    await suggest(raceId); // Existing generation race branch discards the stale answer without persisting it.
    assert.equal((await read(raceId)).payload.ai_suggestion, undefined);
    assert.equal((await read(raceId)).coding_state, null, 'still in the existing uncoded discovery pool');
    await suggest(raceId); await apply(raceId);
    const contentionId = await makeTransaction('registration-apply-contention'); await suggest(contentionId);
    const beforeContention = (await read(contentionId)).payload.ai_suggestion;
    const reviewItemId = await ensureTransactionReviewItemInDb({ firmId, clientId, transactionId: contentionId });
    const editor = await pool.connect();
    try {
      await editor.query('begin');
      await updateClientProfileInDb({ firmId, clientId, dbClient: editor, manageTransaction: false,
        actorId: 'member-a', principal: { principalType: 'firm_member', principalId: 'member-a', userId: 'user-a' },
        profilePatch: { gst_registration: { ...record, registered_from: '2026-09-02' } } });
      const acquiredApplyConnection = new Promise(resolve => pool.once('acquire', connection => resolve(connection.processID)));
      const refusal = assert.rejects(() => updateTransactionReviewItemInDb({ firmId, reviewItemId,
        actorId: 'member-a', returnSnapshot: false, distillFactsFn: async () => ({ candidates: [] }),
        patch: { status: 'resolved', review_state: 'accepted' } }),
      error => error.code === '55P03' && error.statusCode === 409 && error.retryable === true && !/could not obtain lock/.test(error.message));
      await acquiredApplyConnection;
      await refusal; // NOWAIT: refused immediately while the profile edit still holds its lock
      await editor.query('rollback');
      assert.equal((await seed.query("select count(*)::int n from audit_events where client_id=$1 and resource_id=$2 and action='transaction.coding.policy_failed'", [clientId, contentionId])).rows[0].n, 0,
        'F-31: a lock collision mints no runtime-policy incident receipt');
      assert.deepEqual((await read(contentionId)).payload.ai_suggestion,beforeContention);
    } finally { await editor.query('rollback'); editor.release(); }
    await apply(contentionId);
    await seed.query("update documents set filename='replaced-registration.pdf' where id=$1", [record.source_document_id]);
    assert.equal((await resolve('2026-09-01')).reason, 'source_document_changed');
    await save(record); assert.equal((await resolve('2026-09-01')).status, 'registered');
    await save(null); await admit();
    assert.deepEqual((await seed.query('select * from ledger_accounts where client_id=$1 order by id', [clientId])).rows, initialAccounts);
    assert.deepEqual((await seed.query("select * from audit_events where client_id=$1 and action='ledger.chart.palette_seeded'", [clientId])).rows, initialSeed);
  });

  await t.test('native registration capacity refuses the next append without stranding the last usable revision', async () => {
    const principal = { principalType: 'firm_member', principalId: 'member-a', userId: 'user-a' };
    for (let count = (await audit()).length; count < NATIVE_REGISTRATION_HISTORY_LIMIT - 1; count++) {
      await updateClientProfileInDb({ firmId, clientId, dbClient: seed, actorId: 'member-a', principal,
        profilePatch: { gst_registration: { ...record, verified_from: `Synthetic capacity revision ${count + 1}` } } });
    }
    const last = await save(record);
    assert.equal((await audit()).length, NATIVE_REGISTRATION_HISTORY_LIMIT);
    assert.equal((await resolve('2026-09-01')).revision_digest, last.revision_digest);
    assert.equal((await resolve('2026-09-01')).status, 'registered');
    await admit();
    const capture = async () => ({
      client: (await seed.query('select * from clients where id=$1', [clientId])).rows,
      audits: (await seed.query('select * from audit_events where client_id=$1 order by id', [clientId])).rows,
      accounts: (await seed.query('select * from ledger_accounts where client_id=$1 order by id', [clientId])).rows,
      readiness: (await seed.query('select * from entity_readiness_sagas where client_id=$1 order by saga_id', [clientId])).rows
    });
    const before = await capture();
    for (const after of [{ ...record, registered_from: '2026-09-02' }, null]) {
      await assert.rejects(() => updateClientProfileInDb({ firmId, clientId, dbClient: seed,
        actorId: 'member-a', principal, profilePatch: { gst_registration: after } }), error =>
        error.code === 'NATIVE_REGISTRATION_HISTORY_CAPACITY_REACHED' && error.statusCode === 409
        && error.details.limit === NATIVE_REGISTRATION_HISTORY_LIMIT);
      assert.deepEqual(await capture(), before, 'refused append changes no profile/audit/chart/readiness bytes');
    }
    assert.equal((await write(null)).status, 409, 'authenticated route exposes the same refusal');
    assert.deepEqual(await capture(), before);
    const id = await makeTransaction('registration-at-capacity');
    await suggest(id); await apply(id);
    assert.equal((await read(id)).payload.ai_suggestion.coding_policy.native_registration.revision_digest, last.revision_digest);
    assert.equal((await resolve('2026-09-01')).status, 'registered');
    assert.deepEqual((await seed.query('select * from ledger_accounts where client_id=$1 order by id', [clientId])).rows, initialAccounts);
    assert.deepEqual((await seed.query("select * from audit_events where client_id=$1 and action='ledger.chart.palette_seeded'", [clientId])).rows, initialSeed);
  });
}

// C4a deliberately does not qualify posted native registration recovery.
// Exercise the real profile writer against a saved review and prove that the
// immutable acceptance is historical while refreshed authority is invalidated.
export async function proveProcessingRegistrationInvalidation({ seed, firmId, clientId, request, admit, modelCalls }) {
  const { readNativeReviewContexts } = await import('../../db/codingEvidence.js');
  const { recoverPostedCodingCorrectionsInDb } = await import('../../db/codingCorrection.js');
  const transactionId = 'native-correction-batch';
  const read = () => readNativeReviewContexts({client:seed,firmId,clientId,transactionIds:[transactionId]});
  const before=(await seed.query('select * from transactions where id=$1',[transactionId])).rows[0];
  const stamp=before.payload.review_scope;
  assert.ok(stamp?.acceptance_audit?.id);
  const priorCalls=modelCalls();
  const record={status:'registered',registered_from:'2026-08-01',registered_until:'2026-12-31',
    verified_from:'Synthetic retrospective registration notification',verified_at:'2026-09-27'};
  for (const next of [record,{...record,registered_from:'2026-09-02'},null]) {
    const result=await request('a',`/api/donna/firms/clients/${clientId}/profile`,{firm_id:firmId,profile_patch:{gst_registration:next}});
    assert.equal(result.status,200,JSON.stringify(result.body)); await admit();
    const current=await read();
    assert.equal(current.contexts.get(transactionId).review_current,false);
    assert.equal(current.scope.accounting_ready,false);
    assert.deepEqual((await seed.query("select payload->'review_scope' stamp from transactions where id=$1",[transactionId])).rows[0].stamp,stamp);
    assert.equal((await recoverPostedCodingCorrectionsInDb({firmId,limit:50})).find(row=>row.transactionId===transactionId),undefined);
    assert.equal(modelCalls(),priorCalls);
    assert.equal((await seed.query('select count(*)::int n from ledger_journals where client_id=$1',[clientId])).rows[0].n,0);
  }
  console.log(JSON.stringify({qualification:'native-posted-registration-recovery',status:'unqualified',reason:'retained_processing_scope',journals:0}));
}
