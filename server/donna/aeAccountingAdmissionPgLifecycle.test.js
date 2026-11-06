import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { setClientFlagStage } from './clientConfig.js';
import { bootApplianceForTest } from './testSupport/applianceHarness.js';
import { evaluateEntityReadinessAdmissionWithClient } from './runtimeReadinessAdmission.js';
import { updateClientProfileInDb, createClientInDb, clientAccountingBasisFromProfile } from './db/clients.js';
import { observeEntityCertificateB } from './entityCertificateB.js';
import { readCurrentHostCertificateWithClient } from './runtimeReadiness.js';

// Required dependency, deliberately not a successful skip. CI and the tournament
// supply a disposable local cluster; the appliance harness refuses app clusters.
test('real PG: AE accounting declarations create, repair, retry, fence and recreate through named consumers', { timeout: 120000 }, async () => {
  assert.ok(process.env.DONNA_PG_TEST_URL, 'INCOMPLETE: DONNA_PG_TEST_URL is required');
  const app = await bootApplianceForTest({ runToken: `u01-${process.pid}-${Date.now()}`, firm: { jurisdiction: 'AE', currency: 'AED' } });
  const sql = new pg.Client({ connectionString: app.databaseUrl });
  await sql.connect();
  let queryTail = Promise.resolve();
  const query = (text, values) => {
    const pending = queryTail.then(() => sql.query(text, values));
    queryTail = pending.then(() => undefined, () => undefined);
    return pending;
  };
  const firmId = app.firmId;
  const api = async (clientId, suffix, body) => app.api.request({ method: 'POST', path: `/api/donna/firms/clients/${clientId}/${suffix}`, auth: true, body: { firm_id: firmId, ...body } });
  const row = async (clientId) => (await query('select * from clients where firm_id=$1 and id=$2', [firmId, clientId])).rows[0];
  const readiness = async (clientId) => (await query('select * from entity_readiness_sagas where firm_id=$1 and client_id=$2', [firmId, clientId])).rows[0];
  const retry = async (clientId) => {
    // Advance only the existing recovery clock, never certificate/final state.
    await query("update entity_readiness_sagas set next_retry_at=now()-interval '1 second' where firm_id=$1 and client_id=$2 and state='failed'", [firmId, clientId]);
    const response = await api(clientId, 'readiness/retry', { reopen_exhausted: true });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    return readiness(clientId);
  };
  const patch = async (clientId, profile_patch) => {
    const response = await api(clientId, 'profile', { profile_patch });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    return row(clientId);
  };
  const admit = async (clientId, expectedDependencyDigest = null) => {
    await query('begin');
    try { return await evaluateEntityReadinessAdmissionWithClient({ client: sql, firmId, clientId, boundary: 'upload_sign', expectedDependencyDigest }); }
    finally { await query('rollback'); }
  };
  try {
    assert.equal(app.runtime.hostReadiness?.status || app.runtime.hostCertificate?.status || (await query('select status from runtime_host_readiness')).rows[0].status, 'PASS');
    const opening = { as_of: '2026-01-01', currency: 'AED', source: 'owner-declaration-only' };
    const base = { jurisdiction: 'AE', entityType: 'ae-llc', currency: 'AED', opening_balance: opening };
    let first;
    for (const declaration of [{}, { accountingBasis: 'cash' }, { accounting_basis: 'accrual' }]) {
      const born = await app.createClient({ profile: { ...base, ...declaration } });
      const id = born.clientId;
      first ||= id;
      assert.equal((await readiness(id)).state, 'ready');
      assert.equal((await admit(id)).allowed, true);
      const source = await row(id);
      assert.equal(source.jurisdiction, 'AE');
      assert.equal(source.entity_type, 'ae-llc');
      assert.equal(source.firm_id, firmId);
      assert.deepEqual(source.profile.opening_balance, opening);
      assert.equal(clientAccountingBasisFromProfile(source), declaration.accountingBasis || declaration.accounting_basis || 'accrual');
      const cert = await observeEntityCertificateB({ query, firmId, clientId: id, profileId: 'ae-llc.desktop-firm-intake.desktop.none.management-books.v2', hostCertificate: await readCurrentHostCertificateWithClient(sql) });
      assert.equal(cert.status, 'PASS', JSON.stringify(cert.checks));
      const posture = cert.checks.find((c) => c.id === 'accounting_posture').detail;
      assert.equal(posture.admission_contract.certifies_statutory_service, false);
      assert.equal(posture.accounting_profile.method.value, declaration.accountingBasis || declaration.accounting_basis || null);
      assert.equal((await retry(id)).state, 'ready');
    }
    const before = await readiness(first);
    await patch(first, { accounting_view: 'management_books', accountingBasis: 'cash' });
    assert.equal((await admit(first)).allowed, false);
    const repaired = await retry(first);
    assert.equal(repaired.state, 'ready');
    assert.equal(repaired.saga_id, before.saga_id);
    assert.notEqual(repaired.ready_dependency_digest, before.ready_dependency_digest);
    assert.equal((await admit(first, before.ready_dependency_digest)).allowed, false);
    const audit = (await query("select actor_id,metadata from audit_events where firm_id=$1 and client_id=$2 and action='client.profile.update' order by id desc limit 1", [firmId, first])).rows[0];
    assert.ok(audit.actor_id && audit.actor_id !== 'system');
    assert.equal(audit.metadata.accounting_profile.authority_basis.principal_id, audit.actor_id);
    assert.equal(audit.metadata.accounting_profile.after.method.value, 'cash');
    // Repeated generic creation must not drop an earlier explicit method.
    await app.createClient({ id: first, profile: { ...base } });
    assert.equal(clientAccountingBasisFromProfile(await row(first)), 'cash');
    // Same source choice is a no-op; absent -> explicit null is not.
    await patch(first, { accountingBasis: 'cash' });
    assert.equal((await readiness(first)).state, 'ready');
    await patch(first, { accounting_view: null });
    assert.equal((await retry(first)).reason_code, 'accounting_view_unknown');
    assert.equal((await admit(first)).allowed, false);
    await patch(first, { accounting_view: 'management_books', accountingBasis: null });
    assert.equal((await retry(first)).reason_code, 'accounting_method_unknown');
    await patch(first, { accountingBasis: 'accrual' });
    assert.equal((await retry(first)).state, 'ready');
    // Conflicting input cannot change either authoritative home.
    const unchanged = (await row(first)).profile;
    const conflict = await api(first, 'profile', { profile_patch: { accountingBasis: 'cash', accounting_basis: 'accrual' } });
    assert.equal(conflict.status, 422);
    assert.deepEqual((await row(first)).profile, unchanged);
    const unknownBirth = await app.createClient({ profile: { ...base, accounting_view: null } });
    assert.equal((await readiness(unknownBirth.clientId)).reason_code, 'accounting_view_unknown');
    await patch(unknownBirth.clientId, { accounting_view: 'management_books', accountingBasis: 'cash' });
    assert.equal((await retry(unknownBirth.clientId)).state, 'ready');
    for (const method of ['cash', 'accrual']) {
      const statutory = await app.createClient({ profile: { ...base, accounting_view: 'statutory_books', accountingBasis: method } });
      const id = statutory.clientId;
      assert.equal((await readiness(id)).reason_code, 'accounting_view_unsupported');
      assert.equal((await admit(id)).allowed, false);
      assert.equal((await row(id)).profile.accounting_view, 'statutory_books');
      assert.equal((await retry(id)).reason_code, 'accounting_view_unsupported');
      await patch(id, { accounting_view: 'management_books' });
      assert.equal((await retry(id)).state, 'ready');
    }
    // Legacy-slot changes cannot silently turn a statutory request into management.
    const legacy = await app.createClient({ profile: { ...base, accounting_basis: 'statutory_books' } });
    await patch(legacy.clientId, { accounting_basis: 'cash' });
    assert.equal((await row(legacy.clientId)).profile.accounting_view, 'statutory_books');
    assert.equal((await retry(legacy.clientId)).reason_code, 'accounting_view_unsupported');
    const clearedLegacy = await app.createClient({ profile: { ...base, accounting_basis: 'statutory_books' } });
    await patch(clearedLegacy.clientId, { accounting_basis: null });
    assert.equal((await retry(clearedLegacy.clientId)).reason_code, 'accounting_view_unknown');
    const methodFirst = await app.createClient({ profile: { ...base, accounting_basis: 'cash' } });
    await patch(methodFirst.clientId, { accounting_basis: 'statutory_books' });
    assert.equal((await row(methodFirst.clientId)).profile.accountingBasis, 'cash');
    assert.equal((await retry(methodFirst.clientId)).reason_code, 'accounting_view_unsupported');
    // Historical source mutations exercise the ambiguous old homes, not a
    // pre-seeded successful certificate. The named correction must refuse.
    for (const bookBasis of ['statutory_books', null]) {
      const historic = await app.createClient({ profile: base });
      await query("update clients set profile=profile || $3::jsonb where firm_id=$1 and id=$2", [firmId, historic.clientId, JSON.stringify({ accounting_basis: 'management_books', bookBasis })]);
      assert.equal((await retry(historic.clientId)).state, 'failed');
      const refusal = await api(historic.clientId, 'profile', { profile_patch: { accounting_basis: 'cash' } });
      assert.equal(refusal.status, 422);
      assert.equal((await row(historic.clientId)).profile.accounting_view, undefined);
      await patch(historic.clientId, { accounting_basis: 'cash', accounting_view: 'statutory_books' });
      assert.equal((await retry(historic.clientId)).reason_code, 'accounting_view_unsupported');
    }
    // These keys admit optional setup configuration only. The opening lane
    // independently proves its own writer; no unmerged writer is called here.
    const optional = await app.createClient({ profile: base });
    for (const flagKey of ['AE_OPENING_BALANCES', 'FISCAL_PERIOD_INTAKE']) {
      await query('begin');
      await setClientFlagStage(sql, { firmId, clientId: optional.clientId, flagKey, stage: 'canary', source: 'manual', reason: 'Synthetic U01 scoped setup declaration', actorType: 'firm_member', actorId: app.memberId });
      await query('commit');
    }
    assert.equal((await retry(optional.clientId)).state, 'ready');
    assert.equal((await admit(optional.clientId)).allowed, true);
    const gbOptional = await app.createClient({ profile: { jurisdiction: 'GB', entityType: 'gb-ltd', currency: 'GBP' } });
    await query('begin');
    await setClientFlagStage(sql, { firmId, clientId: gbOptional.clientId, flagKey: 'AE_OPENING_BALANCES', stage: 'canary', source: 'manual', reason: 'Synthetic wrong-country admission probe', actorType: 'firm_member', actorId: app.memberId });
    await query('commit');
    assert.equal((await retry(gbOptional.clientId)).state, 'failed');
    assert.equal((await admit(gbOptional.clientId)).allowed, false);
    await query('begin');
    await setClientFlagStage(sql, { firmId, clientId: optional.clientId, flagKey: 'AE_OPENING_BALANCES', stage: 'canary', source: 'default', reason: 'Synthetic wrong-source admission probe', actorType: 'firm_member', actorId: app.memberId });
    await query('commit');
    assert.equal((await retry(optional.clientId)).reason_code, 'admitted_extension_posture_mismatch:AE_OPENING_BALANCES');

    await patch(optional.clientId, { accounting_view: 'statutory_books' });
    assert.equal((await retry(optional.clientId)).reason_code, 'accounting_view_unsupported');
    // Correction of a formerly admitted entity must resolve current view, not old id.
    await patch(first, { accounting_view: 'statutory_books' });
    assert.equal((await retry(first)).reason_code, 'accounting_view_unsupported');
    await patch(first, { accounting_view: 'management_books' });
    assert.equal((await retry(first)).state, 'ready');
    // Cleared country cannot be resurrected from the old admitted id/profile.
    await patch(first, { jurisdiction: null });
    assert.equal((await row(first)).jurisdiction, null);
    assert.equal((await retry(first)).state, 'failed');
    await patch(first, { jurisdiction: 'AE', entity_type: 'ae-llc' });
    assert.equal((await retry(first)).state, 'ready');
    await patch(first, { currency: null });
    assert.equal((await retry(first)).reason_code, 'home_currency_unknown');
    assert.equal((await admit(first)).allowed, false);
    await patch(first, { currency: 'AED' });
    assert.equal((await retry(first)).state, 'ready');
    // Wrong tenant and deleted source cannot be updated/observed as this entity.
    await assert.rejects(updateClientProfileInDb({ firmId: 'missing-firm', clientId: first, actorId: audit.actor_id, profilePatch: { accountingBasis: 'cash' }, dbClient: sql }), /Client not found/);
    await assert.rejects(createClientInDb({ firmId: 'missing-firm', profile: { ...(await row(first)).profile, id: first }, dbClient: sql }), { code: 'CLIENT_ID_FIRM_CONFLICT' });
    const immutableBefore = await row(first);
    // Full named update waits on an in-flight admitted generation, then invalidates.
    await query('begin');
    assert.equal((await evaluateEntityReadinessAdmissionWithClient({ client: sql, firmId, clientId: first, boundary: 'upload_sign' })).allowed, true);
    const updater = new pg.Client({ connectionString: app.databaseUrl });
    await updater.connect();
    const updatePid = (await updater.query('select pg_backend_pid() as pid')).rows[0].pid;
    let update;
    try {
      update = updateClientProfileInDb({ firmId, clientId: first, actorId: audit.actor_id, profilePatch: { accountingBasis: 'cash' }, dbClient: updater });
      const observer = new pg.Client({ connectionString: app.databaseUrl });
      await observer.connect();
      try {
        const deadline = Date.now() + 5000;
        let blocked = false;
        while (Date.now() < deadline) {
          blocked = (await observer.query("select wait_event_type='Lock' as blocked from pg_stat_activity where pid=$1", [updatePid])).rows[0]?.blocked;
          if (blocked) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(blocked, true, 'named profile writer waits on the admitted generation');
      } finally { await observer.end(); }
      await query('commit');
      await update;
    } finally { await query('rollback'); await update?.catch(() => {}); await updater.end(); }
    assert.equal((await admit(first)).allowed, false);
    assert.equal((await retry(first)).state, 'ready');
    assert.deepEqual((await row(first)).profile.opening_balance, immutableBefore.profile.opening_balance);
    const deleted = await app.api.request({ method: 'DELETE', path: `/api/donna/firms/clients/${first}?firm_id=${firmId}`, auth: true });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.json));
    assert.equal(await row(first), undefined);
    assert.equal(await readiness(first), undefined);
    await assert.rejects(updateClientProfileInDb({ firmId, clientId: first, actorId: audit.actor_id, profilePatch: { accounting_view: 'management_books' }, dbClient: sql }), /Client not found/);
    const reborn = await app.createClient({ id: first, profile: { ...base, accountingBasis: 'accrual' } });
    assert.equal(reborn.readiness.state, 'ready');
    assert.equal((await row(first)).profile.accounting_view, undefined);
    assert.equal(clientAccountingBasisFromProfile(await row(first)), 'accrual');
  } finally { await sql.end(); await app.stop(); }
});
