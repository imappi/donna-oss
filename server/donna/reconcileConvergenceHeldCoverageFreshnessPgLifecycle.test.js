// A covered held match stays covered only while the cover holds — proven on
// real PostgreSQL through the real writers.
//
// The held-match projection (#38) reads a held material match as covered only
// if a standing grant would act on it RIGHT NOW: the grant is inside its
// validity window, the client's delegated-authority switch acts, and the
// client's readiness admission admits. Each of those can end without any
// convergence input row changing. This file proves that the PERSISTED column
// follows each one, and that the nightly recompute agrees with it afterwards:
//
//   A. The grant passes its review_after date. Time passing changes no row, so
//      the scheduled coding-convergence tick (the existing 5-minute sweep)
//      re-derives covered held lines.
//   B. The delegated-authority switch is staged off for the client
//      (client_capability_config): the line is re-derived in the switch
//      writer's own transaction.
//   C. The client's readiness admission changes:
//      C1. a certified entity's dependency changes (an unrelated flag stage —
//          migration 127 invalidates the entity_readiness_sagas row);
//      C2. readiness admission is staged on for a client with no certified
//          entity (client_capability_config, the readiness flag row).
//      Both re-derive the line in the writer's own transaction.
//   D. A coding_state-only change re-derives the line (migration 138 already
//      lists coding_state on the 137 mark trigger; pinned here).
//
// Synthetic world: fictional studios pay quarterly rent to a fictional landlord,
// 1 200 GBP against a 500 GBP materiality ceiling; every bank line is already
// coded (coding_state 'applied'), so the coding axis alone reads it finished.
// The real supplier-bill evaluation (scripted model at fetchImpl) holds the
// match on the ceiling; a partner mints a covering grant from the example.
// Skips without DONNA_PG_TEST_URL.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { __endFirmDbPoolForTests, createClientInDb, queryFirmDb, withFirmDbClient } from './firmDb.js';
import { runSupplierBillReconciliationLlmForDocument } from './supplierBillReconciliationLlm.js';
import { computeConvergenceForTransactions, recomputeConvergenceDrift } from './reconcileConvergenceState.js';
import { mintAuthorityGrant } from './reconciliationAuthorityGrants.js';
import { deriveGrantPreview } from './reconciliationAuthorityRoutes.js';
import { ENTITY_READINESS_ADMISSION_FLAG, setClientCohortMembership, setClientFlagStage, setCohortFlagStage } from './clientConfig.js';
import { DELEGATED_AUTHORITY_FLAG_KEY } from './reconciliationLlmCore.js';
import { runCodingConvergenceInDb } from './codingConvergence.js';
import { buildDesktopHandlerManifest } from './desktop/handlerManifest.js';
import { createLocalScheduler } from './desktop/localScheduler.js';
import { observeHostCertificateA } from './hostCertificateA.js';
import { persistHostReadinessAttempt, provisionEntityReadiness } from './runtimeReadiness.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIRM = 'firm-held-fresh';
const MEMBER = 'member-held-fresh';
const VENDOR = 'Harbour Lane Properties Ltd';
const PARTNER = 'partner@ledgerlight.example';
const COVERED = Object.freeze({ state: 'auto_reconciled', reason: 'coding_state:applied' });
const HELD = Object.freeze({ state: 'hanging', reason: 'matched_pending_authority_no_grant' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchImpl = async (_url, init) => {
  const request = JSON.parse(init.body);
  const prompt = String(request.messages?.[0]?.content || '');
  const total = Number(/total_amount=([\d.]+)/.exec(prompt)?.[1] ?? /total=([\d.]+)/.exec(prompt)?.[1]);
  const candidates = [...prompt.matchAll(/candidate_ref=(candidate_\d+)\n\s*date=[^\n]*\n\s*money_out=([\d.]+)/g)]
    .map((m) => ({ ref: m[1], amount: Number(m[2]) }));
  const hit = candidates.find((c) => Math.abs(c.amount - total) < 0.005) || candidates[0];
  const reply = hit
    ? { proposals: [{ candidate_ref: hit.ref, confidence: 0.95, reasoning: 'The quarterly rent paid to the landlord; amount and payee agree.', hops: ['amount_exact', 'vendor_overlap'] }], unmatchable_reason: null }
    : { proposals: [], unmatchable_reason: 'no_plausible_match' };
  return { ok: true, status: 200, json: async () => ({ model: 'scripted-strong-model', content: [{ text: JSON.stringify(reply) }] }) };
};

test('real PG: the persisted verdict of a covered held match follows the cover when it lapses by date, by the switch and by readiness', {
  skip: process.env.DONNA_PG_TEST_URL ? false : 'DONNA_PG_TEST_URL required',
  timeout: 300_000
}, async (t) => {
  const admin = new pg.Client({ connectionString: process.env.DONNA_PG_TEST_URL });
  await admin.connect();
  const name = `donna_held_fresh_${Date.now().toString(36)}_${process.pid}`;
  await admin.query(`create database "${name}"`);
  const url = new URL(process.env.DONNA_PG_TEST_URL);
  url.pathname = `/${name}`;
  const seed = new pg.Client({ connectionString: url.toString() });
  await seed.connect();
  const blobDir = await mkdtemp(path.join(os.tmpdir(), 'donna-held-fresh-blobs-'));
  const env = {
    DATABASE_URL: url.toString(),
    DATABASE_POOL_MAX: '4',
    DONNA_DEFAULT_FIRM_ID: FIRM,
    DONNA_DESKTOP_BLOB_DIR: blobDir,
    DONNA_BUILD_COMMIT_SHA: 'held-fresh-real-pg-build',
    DONNA_BUILD_DIRTY: 'false',
    DONNA_DESKTOP_SCHEDULER: 'on',
    OPENAI_API_KEY: 'test-only-no-network', ANTHROPIC_API_KEY: 'test-only-no-network',
    RECONCILIATION_AUTO_MATCH_POLICY: 'true',
    RECONCILIATION_AUTO_MATCH_MATERIALITY_CEILING: '500',
    RECONCILIATION_DELEGATED_AUTHORITY: '',
    RECONCILIATION_MATERIAL_AUTO_FYI: ''
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(async () => {
    await __endFirmDbPoolForTests().catch(() => {});
    await seed.end().catch(() => {});
    await admin.query(`drop database if exists "${name}" with (force)`);
    await admin.end();
    await rm(blobDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  await seed.query(`create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb);`);
  const root = path.join(ROOT, 'db', 'migrations');
  for (const file of (await readdir(root)).filter((entry) => entry.endsWith('.sql')).sort()) {
    await seed.query(await readFile(path.join(root, file), 'utf8'));
    await seed.query('insert into schema_migrations (version) values ($1) on conflict (version) do nothing', [file.replace(/\.sql$/, '')]);
  }
  await seed.query("insert into firms(id,name,slug,jurisdiction,default_currency) values($1,'Ledgerlight Partners','ledgerlight','GB','GBP')", [FIRM]);
  await seed.query(`insert into firm_members (id, firm_id, email, name, role, status)
    values ($1, $2, 'founder@ledgerlight.example', 'Ledgerlight Founder', 'admin', 'active')`, [MEMBER, FIRM]);

  const persisted = async (txId) => {
    const row = (await seed.query('select convergence_state, convergence_reason from transactions where firm_id=$1 and id=$2', [FIRM, txId])).rows[0];
    return { state: row.convergence_state, reason: row.convergence_reason };
  };
  const marks = async (txId) => Number((await seed.query('select count(*)::int n from convergence_marks where firm_id=$1 and target_id=$2', [FIRM, txId])).rows[0].n);
  // Column == expected == a fresh derivation, no mark resting, nightly agrees.
  const expectRest = async (clientId, txId, expected, label) => {
    assert.deepEqual(await persisted(txId), expected, `${label}: the persisted column`);
    const fresh = (await computeConvergenceForTransactions(seed, { firmId: FIRM, transactionIds: [txId], verdictOnly: true }))[0].derived;
    assert.deepEqual({ state: fresh.state, reason: fresh.reason }, expected, `${label}: a fresh derivation`);
    assert.equal(await marks(txId), 0, `${label}: no unsettled mark rests on the line`);
    const drift = await recomputeConvergenceDrift(seed, { firmId: FIRM, clientId });
    assert.equal(drift.drift_count, 0, `${label}: the nightly recompute agrees ${JSON.stringify(drift.drifted_sample)}`);
  };

  // A settled prior quarter (the recurring-vendor evidence the archetype needs),
  // the coded line under test and its bill; the real evaluation holds the match.
  const seedHeldLine = async (clientId) => {
    const s = clientId;
    await seed.query(`insert into documents (id, firm_id, client_id, filename, document_type, status, parse_status, vendor_name, total_amount, currency,
        document_date, reference_number, payment_status, extraction_confidence, parse_summary, payload)
      values ($4,$1,$2,'bill-prior.pdf','supplier_bill','received','completed',$3,1200,'GBP','2024-10-01','RENT-0','paid',0.97,$5::jsonb,'{}'::jsonb)`,
      [FIRM, clientId, VENDOR, `bill-prior-${s}`, JSON.stringify({ summary: 'Quarterly rent for the studio premises', warnings: [] })]);
    await seed.query(`insert into transactions (id, firm_id, client_id, transaction_date, description, raw_description, money_in, money_out, currency, status, account_code, reconciliation_status, payload, coding_state)
      values ($4,$1,$2,'2024-10-01',$3,$3,0,1200,'GBP','categorized','7100','reconciled','{}'::jsonb,'applied')`, [FIRM, clientId, `${VENDOR.toUpperCase()} RENT`, `tx-prior-${s}`]);
    await seed.query(`insert into reconciliation_matches (id, firm_id, client_id, bank_transaction_id, matched_object_type, matched_object_id, status, match_amount, payload)
      values ($3,$1,$2,$4,'supplier_bill',$5,'confirmed',1200,'{}'::jsonb)`, [FIRM, clientId, `m-prior-${s}`, `tx-prior-${s}`, `bill-prior-${s}`]);
    const txId = `tx-q1-${s}`;
    await withFirmDbClient((client) => client.query(`insert into transactions (id, firm_id, client_id, transaction_date, description, raw_description, money_in, money_out, currency, status, account_code, payload, coding_state)
      values ($4,$1,$2,'2025-01-06',$3,$3,0,1200,'GBP','categorized','7100','{}'::jsonb,'applied')`, [FIRM, clientId, `${VENDOR.toUpperCase()} RENT`, txId]));
    await withFirmDbClient((client) => client.query(`insert into documents (id, firm_id, client_id, filename, document_type, status, parse_status, vendor_name, total_amount, currency,
        document_date, reference_number, payment_status, extraction_confidence, parse_summary, payload)
      values ($4,$1,$2,'bill-q1.pdf','supplier_bill','received','completed',$3,1200,'GBP','2025-01-06','RENT-1','unpaid',0.97,$5::jsonb,'{}'::jsonb)`,
      [FIRM, clientId, VENDOR, `bill-q1-${s}`, JSON.stringify({ summary: 'Quarterly rent for the studio premises', warnings: [] })]));
    await withFirmDbClient((client) => runSupplierBillReconciliationLlmForDocument({
      client, firmId: FIRM, clientId, documentId: `bill-q1-${s}`, apiKeyOverride: 'sk-test', fetchImpl
    }));
    const match = (await seed.query('select * from reconciliation_matches where matched_object_id=$1', [`bill-q1-${s}`])).rows[0];
    assert.equal(match?.status, 'suggested', JSON.stringify(match?.payload?.authorization));
    assert.deepEqual(match.payload.authorization.reasons, ['above_materiality_ceiling']);
    assert.equal(match.bank_transaction_id, txId);
    await expectRest(clientId, txId, HELD, `${clientId}: held, no grant`);
    return { txId, match };
  };
  const mintCovering = async (clientId, match, { reviewAfter = new Date(Date.now() + 90 * 86_400_000).toISOString() } = {}) => {
    const preview = await deriveGrantPreview(seed, { firmId: FIRM, clientId, matchId: match.id });
    assert.equal(preview.eligible, true, JSON.stringify(preview));
    return withFirmDbClient((client) => mintAuthorityGrant({
      client, firmId: FIRM, clientId, scopeKind: preview.scope_kind, scopeKey: preview.scope_key,
      archetype: preview.archetype, amountCeiling: 1500, currency: 'GBP', authorizedByActorType: 'accountant',
      authorizedByActorId: PARTNER, source: 'accountant_approval', status: 'active', reviewAfter,
      provenance: { granted_by: { actor_id: PARTNER }, example: { match_id: match.id } }
    }));
  };
  const insertClient = (clientId, company) => seed.query(
    `insert into clients(id,firm_id,company_name,jurisdiction,status,profile) values($1,$2,$3,'gb','active',$4)`,
    [clientId, FIRM, company, { jurisdiction: 'gb', accounting_system: 'none' }]);
  const stage = (clientId, flagKey, value, reason) => withFirmDbClient(async (client) => {
    await client.query('begin');
    await setClientFlagStage(client, { firmId: FIRM, clientId, flagKey, stage: value, source: 'manual', reason, actorType: 'firm_member', actorId: MEMBER });
    await client.query('commit');
  });

  // ── A. The grant passes its review date ─────────────────────────────────────
  await t.test('A. a grant passing its review_after date: the scheduled coding-convergence tick re-derives the line', async () => {
    const clientId = 'client-fresh-date';
    await insertClient(clientId, 'Pierpoint Date Studio Ltd');
    await stage(clientId, DELEGATED_AUTHORITY_FLAG_KEY, 'auto', 'held-match freshness world');
    const { txId, match } = await seedHeldLine(clientId);
    const reviewAt = Date.now() + 4_000;
    await mintCovering(clientId, match, { reviewAfter: new Date(reviewAt).toISOString() });
    await expectRest(clientId, txId, COVERED, 'A: covered by a grant inside its window');
    // Only the clock moves: no row changes.
    await sleep(Math.max(0, reviewAt - Date.now()) + 500);
    assert.deepEqual(await persisted(txId), COVERED, 'A: no row changed, so the column still reads the covered verdict');
    const fresh = (await computeConvergenceForTransactions(seed, { firmId: FIRM, transactionIds: [txId], verdictOnly: true }))[0].derived;
    assert.deepEqual({ state: fresh.state, reason: fresh.reason }, HELD, 'A: a fresh derivation already reads the lapse');
    // The real scheduled tick. Only the steps that would call a model or
    // rewrite this synthetic line (the coder re-drive and the changed-evidence
    // recovery) are stubbed, so the date is the only thing that moved.
    const summary = await runCodingConvergenceInDb({
      firmId: FIRM,
      discoverCoderClientsFn: async () => [],
      recoverChangedEvidenceFn: async () => [],
      recoverReconciliationProviderFailuresFn: async () => [],
      recoverMaterialExceptionsFn: async () => [],
      recoverOwnerRepliesFn: async () => [],
      recoverRefusedEvidenceFn: async () => [],
      recoverPostedCorrectionsFn: async () => [],
      hostedPilotTerminalConvergenceFn: async () => [],
      recoverAeVatLegacyCodingFn: async () => []
    });
    assert.equal(summary.errors, 0, JSON.stringify(summary));
    assert.ok(summary.held_match_coverage?.changed?.includes(txId), JSON.stringify(summary.held_match_coverage ?? null));
    await expectRest(clientId, txId, HELD, `A: grant past review_after, after the scheduled tick ${JSON.stringify(summary.held_match_coverage ?? null)}`);
  });

  // ── B. The delegated-authority switch is staged off ────────────────────────
  await t.test('B. the delegated-authority switch staged off: the line is re-derived in the switch writer’s transaction', async () => {
    const clientId = 'client-fresh-switch';
    await insertClient(clientId, 'Pierpoint Switch Studio Ltd');
    await stage(clientId, DELEGATED_AUTHORITY_FLAG_KEY, 'auto', 'held-match freshness world');
    const { txId, match } = await seedHeldLine(clientId);
    await mintCovering(clientId, match);
    await expectRest(clientId, txId, COVERED, 'B: covered by an active grant');
    await stage(clientId, DELEGATED_AUTHORITY_FLAG_KEY, 'off', 'A partner pauses standing authority');
    await expectRest(clientId, txId, HELD, 'B: switch staged off');
    // One direction only: the sources this file proves never re-derive a line
    // already resting on matched_pending_authority_no_grant, so staging the
    // switch back on leaves the line hanging (more cautious) until its next
    // ordinary mark — here, a person confirming the match.
    await stage(clientId, DELEGATED_AUTHORITY_FLAG_KEY, 'auto', 'A partner resumes standing authority');
    assert.deepEqual(await persisted(txId), HELD, 'B: re-staged on, the line stays hanging');
    const fresh = (await computeConvergenceForTransactions(seed, { firmId: FIRM, transactionIds: [txId], verdictOnly: true }))[0].derived;
    assert.deepEqual({ state: fresh.state, reason: fresh.reason }, COVERED, 'B: a fresh derivation reads covered again');
  });

  // ── C1. A certified entity's readiness changes ─────────────────────────────
  await t.test('C1. a certified entity losing readiness: the line is re-derived in the dependency writer’s transaction', async (st) => {
    const clientId = 'client-fresh-ready';
    const manifest = buildDesktopHandlerManifest({ rootDir: ROOT });
    await createLocalScheduler({ manifest, client: seed, pollIntervalMs: 60 * 60 * 1000 }).initialize();
    const observedAt = new Date().toISOString();
    const hostCertificate = await observeHostCertificateA({
      env: process.env, rootDir: ROOT, observedAt, manifest, schedulerEnabled: true,
      query: (text, params) => queryFirmDb(text, params)
    });
    assert.equal(hostCertificate.status, 'PASS', JSON.stringify(hostCertificate.checks, null, 2));
    await persistHostReadinessAttempt({ withFirmDbClientFn: withFirmDbClient, certificate: hostCertificate, eventType: 'boot' });
    await createClientInDb({
      firmId: FIRM,
      profile: { id: clientId, companyName: 'Pierpoint Ready Studio Ltd', jurisdiction: 'GB', entityType: 'gb-ltd' },
      creationPrincipal: { principalType: 'firm_member', principalId: MEMBER, authoritySource: 'held_fresh_real_pg' }
    });
    const provision = (retry) => provisionEntityReadiness({
      withFirmDbClientFn: withFirmDbClient, firmId: FIRM, clientId, creationPath: 'desktop_firm_intake',
      ...(retry ? { retry: true, lifecycle: 'retry', compatibilityScope: 'current_generation_compatibility' } : {}),
      observedAt: new Date().toISOString(),
      initiatingPrincipal: { actor_type: 'firm_member', actor_id: MEMBER },
      authorityBasis: { source: 'held_fresh_real_pg', principal_id: MEMBER }
    });
    assert.equal((await provision(false)).row.state, 'ready', 'certified at birth');
    // A new desktop client is enrolled in readiness admission at birth. Pause
    // enforcement while the world is built (the flag row is not a certified
    // dependency), then certify the complete baseline and enforce again.
    await stage(clientId, ENTITY_READINESS_ADMISSION_FLAG, 'off', 'held-match freshness: building the world');
    // The desktop birth default routes reconciliation to the first-line engine,
    // which needs a configured model; this world scripts the reasoning matcher.
    await stage(clientId, 'JEV_RECONCILIATION', 'off', 'held-match freshness: scripted reasoning matcher');
    // The desktop birth default also auto-accepts a confident material match
    // with an owner FYI; turned off, the ceiling holds it for authority.
    await stage(clientId, 'RECONCILIATION_MATERIAL_AUTO_FYI', 'off', 'held-match freshness: the ceiling holds');
    // A certified desktop entity admits no live delegated-authority row
    // (entityCertificateB: unexpected_live_capability), so its switch acts
    // through the env canary allowlist alone.
    const priorSwitch = [process.env[DELEGATED_AUTHORITY_FLAG_KEY], process.env[`${DELEGATED_AUTHORITY_FLAG_KEY}_CLIENTS`]];
    process.env[DELEGATED_AUTHORITY_FLAG_KEY] = 'true';
    process.env[`${DELEGATED_AUTHORITY_FLAG_KEY}_CLIENTS`] = clientId;
    st.after(() => {
      if (priorSwitch[0] === undefined) delete process.env[DELEGATED_AUTHORITY_FLAG_KEY]; else process.env[DELEGATED_AUTHORITY_FLAG_KEY] = priorSwitch[0];
      if (priorSwitch[1] === undefined) delete process.env[`${DELEGATED_AUTHORITY_FLAG_KEY}_CLIENTS`]; else process.env[`${DELEGATED_AUTHORITY_FLAG_KEY}_CLIENTS`] = priorSwitch[1];
    });
    const { txId, match } = await seedHeldLine(clientId);
    await mintCovering(clientId, match);
    await expectRest(clientId, txId, COVERED, 'C1: covered, readiness not enforced');
    // Restore the certified desktop baseline before certifying.
    const restore = (flagKey) => withFirmDbClient(async (client) => {
      await client.query('begin');
      await setClientFlagStage(client, { firmId: FIRM, clientId, flagKey, stage: 'auto', source: 'default', reason: 'desktop_host_default' });
      await client.query('commit');
    });
    await restore('JEV_RECONCILIATION');
    await restore('RECONCILIATION_MATERIAL_AUTO_FYI');
    // Re-certify the current baseline, the grant included (the retry path).
    const ready = await provision(true);
    assert.equal(ready.row.state, 'ready', JSON.stringify(ready.row));
    await stage(clientId, ENTITY_READINESS_ADMISSION_FLAG, 'canary', 'held-match freshness: readiness enforced');
    assert.equal((await seed.query('select state from entity_readiness_sagas where firm_id=$1 and client_id=$2', [FIRM, clientId])).rows[0].state, 'ready');
    await expectRest(clientId, txId, COVERED, 'C1: covered, readiness enforced and admitting');
    // A load-bearing dependency changes (an unrelated flag): migration 127
    // fails the saga, so the readiness admission refuses from now on.
    await stage(clientId, 'CODING_AUTO_POST', 'off', 'An unrelated configuration change');
    assert.equal((await seed.query('select state from entity_readiness_sagas where firm_id=$1 and client_id=$2', [FIRM, clientId])).rows[0].state, 'failed');
    await expectRest(clientId, txId, HELD, 'C1: readiness no longer admits');
  });

  // ── C2. Readiness admission staged on for an uncertified client ────────────
  await t.test('C2. readiness admission staged on for an uncertified client: the line is re-derived in the flag writer’s transaction', async () => {
    const clientId = 'client-fresh-enrol';
    await insertClient(clientId, 'Pierpoint Enrol Studio Ltd');
    await stage(clientId, DELEGATED_AUTHORITY_FLAG_KEY, 'auto', 'held-match freshness world');
    const { txId, match } = await seedHeldLine(clientId);
    await mintCovering(clientId, match);
    await expectRest(clientId, txId, COVERED, 'C2: covered, readiness not enrolled');
    await stage(clientId, ENTITY_READINESS_ADMISSION_FLAG, 'canary', 'held-match freshness: readiness enforced');
    await expectRest(clientId, txId, HELD, 'C2: enrolled with no certified entity');
  });

  // ── E. The switch from a cohort row, cohort membership, the firm default ───
  await t.test('E. the switch inherited from a cohort or the firm default: each row change re-derives the line', async () => {
    const cohortWriter = (fn) => withFirmDbClient(async (client) => { await client.query('begin'); await fn(client); await client.query('commit'); });
    const viaCohort = 'client-fresh-cohort';
    const leaver = 'client-fresh-leaver';
    for (const [clientId, company] of [[viaCohort, 'Pierpoint Cohort Studio Ltd'], [leaver, 'Pierpoint Leaver Studio Ltd']]) {
      await insertClient(clientId, company);
      await cohortWriter((client) => setClientCohortMembership(client, { firmId: FIRM, cohortKey: 'rent-pilot', clientId, reason: 'held-match freshness world' }));
    }
    await cohortWriter((client) => setCohortFlagStage(client, { firmId: FIRM, cohortKey: 'rent-pilot', flagKey: DELEGATED_AUTHORITY_FLAG_KEY, stage: 'auto', reason: 'held-match freshness world' }));
    const lines = {};
    for (const clientId of [viaCohort, leaver]) {
      const { txId, match } = await seedHeldLine(clientId);
      await mintCovering(clientId, match);
      await expectRest(clientId, txId, COVERED, `E: ${clientId} covered through the cohort switch`);
      lines[clientId] = txId;
    }
    // Leaving the cohort drops the inherited switch.
    await cohortWriter((client) => setClientCohortMembership(client, { firmId: FIRM, cohortKey: 'rent-pilot', clientId: leaver, active: false, reason: 'Left the pilot' }));
    await expectRest(leaver, lines[leaver], HELD, 'E: left the cohort');
    // The cohort's switch staged off.
    await cohortWriter((client) => setCohortFlagStage(client, { firmId: FIRM, cohortKey: 'rent-pilot', flagKey: DELEGATED_AUTHORITY_FLAG_KEY, stage: 'off', reason: 'Pilot paused' }));
    await expectRest(viaCohort, lines[viaCohort], HELD, 'E: cohort switch staged off');
    // The firm default row (client_id null) for a client with no row of its own.
    const viaFirm = 'client-fresh-firm-default';
    await insertClient(viaFirm, 'Pierpoint Firm Default Studio Ltd');
    await stage(null, DELEGATED_AUTHORITY_FLAG_KEY, 'auto', 'held-match freshness: firm default');
    const { txId, match } = await seedHeldLine(viaFirm);
    await mintCovering(viaFirm, match);
    await expectRest(viaFirm, txId, COVERED, 'E: covered through the firm default');
    await stage(null, DELEGATED_AUTHORITY_FLAG_KEY, 'off', 'Firm default paused');
    await expectRest(viaFirm, txId, HELD, 'E: firm default staged off');
  });

  // ── D. coding_state alone re-derives the line ──────────────────────────────
  await t.test('D. a coding_state-only change is a convergence mark', async () => {
    const clientId = 'client-fresh-coding';
    await insertClient(clientId, 'Pierpoint Coding Studio Ltd');
    await withFirmDbClient((client) => client.query(`insert into transactions (id, firm_id, client_id, transaction_date, description, raw_description, money_in, money_out, currency, status, account_code, payload, coding_state)
      values ('tx-coding',$1,$2,'2025-01-06','STATIONERY','STATIONERY',0,40,'GBP','categorized','7500','{}'::jsonb,'proposed')`, [FIRM, clientId]));
    await expectRest(clientId, 'tx-coding', { state: 'hanging', reason: 'coding_state:proposed' }, 'D: proposed');
    await withFirmDbClient((client) => client.query("update transactions set coding_state='applied' where firm_id=$1 and id='tx-coding'", [FIRM]));
    await expectRest(clientId, 'tx-coding', COVERED, 'D: applied by a coding_state-only update');
  });
});
