#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

import { ENTITY_READINESS_ADMISSION_FLAG, setClientFlagStage } from '../server/donna/clientConfig.js';
import {
  ENTITY_CERTIFICATE_B_VERSION,
  observeEntityCertificateB
} from '../server/donna/entityCertificateB.js';
import {
  __endFirmDbPoolForTests,
  closeFirmDbPool,
  createClientInDb,
  deleteClientInDb,
  updateClientProfileInDb,
  withFirmDbClient
} from '../server/donna/firmDb.js';
import { mintAuthorityGrant } from '../server/donna/reconciliationAuthorityGrants.js';
import { selfProvisionClientWorkspace } from '../server/donna/selfProvisionDb.js';
import { backfillDesktopRuntimePlane } from '../server/donna/desktop/hostPlaneSeed.js';
import { hostDigest } from '../server/donna/hostCertificateA.js';

export const ENTITY_CERTIFICATE_B_SUITE_VERSION = 'donna.entity-certificate-b-suite.v2';

const SUPABASE_ONLY_MIGRATIONS = new Set([
  '010_evidence_object_storage.sql',
  '032_lock_down_public_rls.sql',
  '060_procountor_api_key.sql'
]);

const restoreEnv = (key, value) => {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

export const parseEntityCertificateArgs = (argv = []) => {
  const args = { output: null, hostCertificate: null, requirePass: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--require-pass') args.requirePass = true;
    else if (token === '--output') args.output = argv[++index] || null;
    else if (token.startsWith('--output=')) args.output = token.slice('--output='.length);
    else if (token === '--host-certificate') args.hostCertificate = argv[++index] || null;
    else if (token.startsWith('--host-certificate=')) args.hostCertificate = token.slice('--host-certificate='.length);
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (argv.includes('--output') && !args.output) throw new Error('--output requires a path.');
  if (argv.includes('--host-certificate') && !args.hostCertificate) throw new Error('--host-certificate requires a path.');
  return args;
};

const certificateSummary = (receipt) => ({
  profile_id: receipt.admitted_profile?.profile_id || null,
  lifecycle: receipt.lifecycle,
  status: receipt.status,
  receipt_digest: receipt.receipt_digest,
  entity_dependency_digest: receipt.entity_dependency_digest || null,
  generation_digest: receipt.generation_digest || null,
  saga_id: receipt.provisioning_saga?.saga_id || null,
  idempotency_key: receipt.provisioning_saga?.idempotency_key || null,
  attempts: receipt.provisioning_saga?.attempts?.length || 0,
  earliest_failure: receipt.provisioning_saga?.earliest_failure || null,
  writer_receipts: receipt.provisioning_saga?.writer_receipts || [],
  reauthorization_checklist: receipt.provisioning_saga?.reauthorization_checklist || []
});

const mutationProbe = ({ id, receipt = null, expectedCheck = null, extraDetected = null, detail = null }) => {
  const localized = expectedCheck ? receipt?.checks?.find(({ id: checkId }) => checkId === expectedCheck) : null;
  const detected = extraDetected == null
    ? Boolean(receipt?.status === 'FAIL' && localized?.status === 'FAIL')
    : Boolean(extraDetected);
  return {
    mutation_id: id,
    expected_outcome: 'detected',
    observed_certificate_status: receipt?.status || null,
    expected_failure_check: expectedCheck,
    observed_failure_reasons: localized?.detail?.failures || [],
    detected,
    detail
  };
};

const incompleteSuite = ({ observedAt, reason, detail = null }) => ({
  version: ENTITY_CERTIFICATE_B_SUITE_VERSION,
  certificate_version: ENTITY_CERTIFICATE_B_VERSION,
  mode: 'observe_only',
  enforcement: false,
  product_state_persisted: false,
  observed_at: observedAt,
  status: 'INCOMPLETE',
  model_inference_calls: 0,
  model_spend_usd: 0,
  reason,
  detail,
  certificates: [],
  mutation_probes: []
});

const finalizeSuite = (body) => ({ ...body, receipt_digest: hostDigest(body) });

const applyMigrations = async ({ client, rootDir }) => {
  const files = (await readdir(path.join(rootDir, 'db', 'migrations')))
    .filter((file) => file.endsWith('.sql') && !SUPABASE_ONLY_MIGRATIONS.has(file))
    .sort();
  for (const file of files) {
    await client.query(await readFile(path.join(rootDir, 'db', 'migrations', file), 'utf8'));
  }
  return files;
};

export const runEntityCertificateBRealPg = async ({
  pgUrl = process.env.DONNA_PG_TEST_URL || '',
  hostCertificate,
  rootDir = process.cwd(),
  observedAt = new Date().toISOString()
} = {}) => {
  if (!pgUrl) return finalizeSuite(incompleteSuite({ observedAt, reason: 'postgresql_test_role_missing' }));
  if (!hostCertificate) return finalizeSuite(incompleteSuite({ observedAt, reason: 'host_certificate_a_missing' }));
  if (hostCertificate.status !== 'PASS') {
    return finalizeSuite(incompleteSuite({ observedAt, reason: 'host_certificate_a_not_pass', detail: { status: hostCertificate.status } }));
  }

  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  const dbName = `donna_cert_b_${suffix}`;
  const admin = new pg.Client({ connectionString: pgUrl });
  let seed = null;
  const envKeys = ['DATABASE_URL', 'DATABASE_POOL_MAX', 'DONNA_DESKTOP_BLOB_DIR', 'DONNA_DEFAULT_FIRM_ID'];
  const priorEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const FIRM_ID = 'firm-cert-b-primary';
  const OTHER_FIRM_ID = 'firm-cert-b-other';
  const MEMBER_ID = 'member-cert-b';
  const GENERIC_ID = 'client-cert-b-generic';
  const DESKTOP_ID = 'client-cert-b-desktop';
  const LEGACY_ID = 'client-cert-b-legacy';
  const BOOT_ID = 'client-cert-b-boot-heal';
  const ALIAS_ID = 'client-cert-b-us-alias';
  const SEED_FAILURE_ID = 'client-cert-b-seed-failure';
  const OWNER_ID = 'owner-cert-b';
  const OWNER_EMAIL = 'owner-cert-b@example.test';

  const certificates = [];
  const mutationProbes = [];
  try {
    await admin.connect();
    await admin.query(`create database "${dbName}"`);
    const scratchUrl = new URL(pgUrl);
    scratchUrl.pathname = `/${dbName}`;
    seed = new pg.Client({ connectionString: scratchUrl.toString() });
    await seed.connect();
    const migrations = await applyMigrations({ client: seed, rootDir });

    await seed.query(
      `insert into firms (id, name, slug, jurisdiction, default_currency)
       values
         ($1, 'Certificate B Primary Firm', 'certificate-b-primary', 'GB', 'GBP'),
         ($2, 'Certificate B Other Firm', 'certificate-b-other', 'GB', 'GBP')`,
      [FIRM_ID, OTHER_FIRM_ID]
    );
    await seed.query(
      `insert into firm_members (id, firm_id, user_id, email, name, role, status, access_level)
       values ($1, $2, 'user-cert-b-member', 'member-cert-b@example.test', 'Certificate Member', 'owner', 'active', 'staff')`,
      [MEMBER_ID, FIRM_ID]
    );

    process.env.DATABASE_URL = scratchUrl.toString();
    process.env.DATABASE_POOL_MAX = '2';
    process.env.DONNA_DESKTOP_BLOB_DIR = path.join('/tmp', `donna-cert-b-blobs-${suffix}`);
    process.env.DONNA_DEFAULT_FIRM_ID = FIRM_ID;
    // readEntityCertificateSnapshot may fan independent reads out. A pg.Client
    // is a single connection, so serialize its query adapter (production may
    // pass a Pool and run them concurrently).
    let queryTail = Promise.resolve();
    const query = (text, params) => {
      const pending = queryTail.then(() => seed.query(text, params));
      queryTail = pending.then(() => undefined, () => undefined);
      return pending;
    };
    const memberPrincipal = {
      principalType: 'firm_member',
      principalId: MEMBER_ID,
      authoritySource: 'authenticated_firm_create_route'
    };

    // The generic route and desktop intake surface converge on the same
    // production writer, but remain separate admitted coordinates so a later
    // surface-specific change cannot disappear inside that implementation fact.
    await createClientInDb({
      firmId: FIRM_ID,
      creationPrincipal: memberPrincipal,
      profile: {
        id: GENERIC_ID,
        companyName: 'Certificate Generic Ltd',
        jurisdiction: 'UK',
        entityType: 'Limited company',
        accounting_system: 'none'
      }
    });
    const genericFirst = await observeEntityCertificateB({
      query,
      rootDir,
      profileId: 'gb-ltd.generic-client-route.desktop.none.management-books.v2',
      firmId: FIRM_ID,
      clientId: GENERIC_ID,
      hostCertificate,
      observedAt
    });
    await createClientInDb({
      firmId: FIRM_ID,
      creationPrincipal: memberPrincipal,
      profile: {
        id: GENERIC_ID,
        companyName: 'Certificate Generic Ltd',
        jurisdiction: 'GB',
        entityType: 'gb-ltd',
        accounting_system: 'none'
      }
    });
    const genericReplay = await observeEntityCertificateB({
      query,
      rootDir,
      profileId: 'gb-ltd.generic-client-route.desktop.none.management-books.v2',
      firmId: FIRM_ID,
      clientId: GENERIC_ID,
      hostCertificate,
      lifecycle: 'duplicate_retry',
      observedAt,
      priorAttempts: genericFirst.provisioning_saga?.attempts || []
    });
    certificates.push(certificateSummary(genericFirst), certificateSummary(genericReplay));

    await createClientInDb({
      firmId: FIRM_ID,
      creationPrincipal: memberPrincipal,
      profile: {
        id: DESKTOP_ID,
        companyName: 'Certificate Desktop Intake Ltd',
        jurisdiction: 'GB',
        entityType: 'gb-ltd',
        accounting_system: 'none'
      }
    });
    const desktop = await observeEntityCertificateB({
      query,
      rootDir,
      profileId: 'gb-ltd.desktop-firm-intake.desktop.none.management-books.v2',
      firmId: FIRM_ID,
      clientId: DESKTOP_ID,
      hostCertificate,
      observedAt
    });
    certificates.push(certificateSummary(desktop));

    // US is a portability sentinel only. The alias travels through the same
    // production canonicalizer and must rest as us-llc with the US pack.
    await createClientInDb({
      firmId: FIRM_ID,
      creationPrincipal: memberPrincipal,
      profile: {
        id: ALIAS_ID,
        companyName: 'Certificate Portability LLC',
        jurisdiction: 'US',
        entityType: 'Limited liability company',
        accounting_system: 'none',
        currency: 'USD'
      }
    });
    const alias = await observeEntityCertificateB({
      query,
      rootDir,
      profileId: 'us-llc.generic-client-route.desktop.none.management-books.v2',
      firmId: FIRM_ID,
      clientId: ALIAS_ID,
      hostCertificate,
      observedAt
    });
    certificates.push(certificateSummary(alias));

    const selfProvision = await selfProvisionClientWorkspace({
      auth: { type: 'supabase_user', userId: OWNER_ID, email: OWNER_EMAIL },
      companyName: 'Certificate Owner Apiary Ltd',
      jurisdiction: 'GB',
      entityType: 'ltd'
    });
    const selfFirst = await observeEntityCertificateB({
      query,
      rootDir,
      profileId: 'gb-ltd.self-provision.desktop.none.management-books.v2',
      firmId: FIRM_ID,
      clientId: selfProvision.clientId,
      hostCertificate,
      observedAt
    });
    certificates.push(certificateSummary(selfFirst));

    // A reset must receipt and purge deliberate authority, remove prior work,
    // and restore baseline defaults only on deterministic recreate.
    await withFirmDbClient(async (client) => {
      await setClientFlagStage(client, {
        firmId: FIRM_ID,
        clientId: selfProvision.clientId,
        flagKey: 'RECONCILIATION_MATERIAL_AUTO_FYI',
        stage: 'canary',
        source: 'manual',
        reason: 'certificate_b_reset_canary',
        actorType: 'firm_member',
        actorId: MEMBER_ID
      });
      await mintAuthorityGrant({
        client,
        firmId: FIRM_ID,
        clientId: selfProvision.clientId,
        scopeKind: 'merchant',
        scopeKey: 'certificate supplier',
        archetype: 'recurring_rent_lease',
        amountCeiling: 500,
        currency: 'GBP',
        authorizedByActorType: 'firm_operator',
        authorizedByActorId: MEMBER_ID,
        source: 'operator_one_click',
        status: 'active'
      });
    });
    await seed.query(
      `insert into queue_items (id, firm_id, client_id, queue_label, status, payload)
       values ('queue-cert-b-prior-generation', $1, $2, 'Prior generation work', 'open', '{}'::jsonb)`,
      [FIRM_ID, selfProvision.clientId]
    );
    await seed.query(
      `insert into firm_facts (id, firm_id, scope, subject, fact, provenance, confidence, status)
       values ('fact-cert-b-prior-generation', $1, 'client', 'prior generation', 'must die on reset', $2::jsonb, 'high', 'active')`,
      [FIRM_ID, JSON.stringify({ client_id: selfProvision.clientId })]
    );
    await deleteClientInDb({
      firmId: FIRM_ID,
      clientId: selfProvision.clientId,
      revokeAtProvider: false,
      clearXeroMirrorAtProvider: false
    });
    const recreated = await selfProvisionClientWorkspace({
      auth: { type: 'supabase_user', userId: OWNER_ID, email: OWNER_EMAIL },
      companyName: 'Certificate Owner Apiary Ltd',
      jurisdiction: 'GB',
      entityType: 'gb-ltd'
    });
    const reset = await observeEntityCertificateB({
      query,
      rootDir,
      profileId: 'gb-ltd.self-provision.desktop.none.management-books.v2',
      firmId: FIRM_ID,
      clientId: recreated.clientId,
      hostCertificate,
      lifecycle: 'reset_recreate',
      observedAt,
      priorAttempts: selfFirst.provisioning_saga?.attempts || []
    });
    certificates.push(certificateSummary(reset));

    // Legacy legal-form correction and boot healing use their real recovery
    // writers. The observer reads only the committed result.
    await seed.query(
      `insert into clients
        (id, firm_id, company_name, entity_type, jurisdiction, status, profile, legal_names)
       values ($1, $2, 'Certificate Legacy Limited', 'Limited company', 'GB', 'active', $3::jsonb, array['Certificate Legacy Limited'])`,
      [LEGACY_ID, FIRM_ID, JSON.stringify({
        companyName: 'Certificate Legacy Limited',
        entityType: 'Limited company',
        jurisdiction: 'GB',
        accounting_system: 'none'
      })]
    );
    await updateClientProfileInDb({
      firmId: FIRM_ID,
      clientId: LEGACY_ID,
      profilePatch: { entity_type: 'gb-ltd' },
      actorId: MEMBER_ID
    });
    await backfillDesktopRuntimePlane({ withFirmDbClientFn: withFirmDbClient, logger: { log: () => {} } });
    const legacy = await observeEntityCertificateB({
      query,
      rootDir,
      profileId: 'gb-ltd.legacy-heal.desktop.none.management-books.v2',
      firmId: FIRM_ID,
      clientId: LEGACY_ID,
      hostCertificate,
      lifecycle: 'legacy_upgrade',
      observedAt
    });
    certificates.push(certificateSummary(legacy));

    // A boot-heal write failure rolls back the whole recovery transaction and
    // the observer reports the entity as failed, never apparently healthy.
    delete process.env.DONNA_DESKTOP_BLOB_DIR;
    await createClientInDb({
      firmId: FIRM_ID,
      creationPrincipal: memberPrincipal,
      profile: {
        id: BOOT_ID,
        companyName: 'Certificate Boot Heal Ltd',
        jurisdiction: 'GB',
        entityType: 'gb-ltd',
        accounting_system: 'none'
      }
    });
    process.env.DONNA_DESKTOP_BLOB_DIR = path.join('/tmp', `donna-cert-b-blobs-${suffix}`);
    await seed.query(`
      create function cert_b_refuse_plane_seed() returns trigger
      language plpgsql as $$
      begin
        raise exception 'Certificate B injected plane seed failure' using errcode = 'P0001';
      end;
      $$;
      create trigger cert_b_refuse_plane_seed
        before insert on client_capability_config
        for each row execute function cert_b_refuse_plane_seed();
    `);
    let bootFailure = null;
    try {
      await backfillDesktopRuntimePlane({ withFirmDbClientFn: withFirmDbClient, logger: { log: () => {} } });
    } catch (error) {
      bootFailure = error;
    }
    const bootFailedReceipt = await observeEntityCertificateB({
      query,
      rootDir,
      profileId: 'gb-ltd.generic-client-route.desktop.none.management-books.v2',
      firmId: FIRM_ID,
      clientId: BOOT_ID,
      hostCertificate,
      lifecycle: 'boot_heal',
      observedAt
    });
    mutationProbes.push(mutationProbe({
      id: 'gate1/boot-heal-failure',
      receipt: bootFailedReceipt,
      expectedCheck: 'client_capabilities',
      extraDetected: Boolean(bootFailure && bootFailedReceipt.status === 'FAIL'
        && bootFailedReceipt.checks.find(({ id }) => id === 'client_capabilities')?.status === 'FAIL'),
      detail: { root_error_code: bootFailure?.code || null }
    }));
    await seed.query('drop trigger cert_b_refuse_plane_seed on client_capability_config');
    await seed.query('drop function cert_b_refuse_plane_seed()');
    await backfillDesktopRuntimePlane({ withFirmDbClientFn: withFirmDbClient, logger: { log: () => {} } });
    const bootHealed = await observeEntityCertificateB({
      query,
      rootDir,
      profileId: 'gb-ltd.generic-client-route.desktop.none.management-books.v2',
      firmId: FIRM_ID,
      clientId: BOOT_ID,
      hostCertificate,
      lifecycle: 'boot_heal_retry',
      observedAt,
      priorAttempts: bootFailedReceipt.provisioning_saga?.attempts || []
    });
    certificates.push(certificateSummary(bootHealed));

    // BF-1: a creation-time baseline seed failure leaves no client or sidecars.
    await seed.query(`
      create function cert_b_refuse_create_seed() returns trigger
      language plpgsql as $$
      begin
        if new.client_id = '${SEED_FAILURE_ID}' then
          raise exception 'Certificate B injected create seed failure' using errcode = 'P0001';
        end if;
        return new;
      end;
      $$;
      create trigger cert_b_refuse_create_seed
        before insert on client_capability_config
        for each row execute function cert_b_refuse_create_seed();
    `);
    let createFailure = null;
    const priorConsoleError = console.error;
    console.error = () => {};
    try {
      await createClientInDb({
        firmId: FIRM_ID,
        creationPrincipal: memberPrincipal,
        profile: {
          id: SEED_FAILURE_ID,
          companyName: 'Certificate Seed Failure Ltd',
          jurisdiction: 'GB',
          entityType: 'gb-ltd',
          accounting_system: 'none'
        }
      });
    } catch (error) {
      createFailure = error;
    } finally {
      console.error = priorConsoleError;
    }
    const rejectedCounts = (await seed.query(
      `select
         (select count(*)::integer from clients where id = $1) as clients,
         (select count(*)::integer from client_capability_config where client_id = $1) as flags,
         (select count(*)::integer from audit_events where resource_id = $1) as audits`,
      [SEED_FAILURE_ID]
    )).rows[0];
    mutationProbes.push(mutationProbe({
      id: 'bf-1/baseline-seed-failure',
      extraDetected: createFailure?.code === 'CLIENT_RUNTIME_INITIALIZATION_FAILED'
        && rejectedCounts.clients === 0 && rejectedCounts.flags === 0 && rejectedCounts.audits === 0,
      detail: { error_code: createFailure?.code || null, rejected_counts: rejectedCounts }
    }));
    await seed.query('drop trigger cert_b_refuse_create_seed on client_capability_config');
    await seed.query('drop function cert_b_refuse_create_seed()');

    // Remaining mutations act on the real committed self-provision entity.
    const baselineFlag = 'DOCUMENT_ROUTER_ENABLED';
    await seed.query(
      `delete from client_capability_config
        where firm_id = $1 and client_id = $2 and flag_key = $3 and valid_to is null`,
      [FIRM_ID, recreated.clientId, baselineFlag]
    );
    const missingSeed = await observeEntityCertificateB({
      query, rootDir, profileId: 'gb-ltd.self-provision.desktop.none.management-books.v2',
      firmId: FIRM_ID, clientId: recreated.clientId, hostCertificate, observedAt
    });
    mutationProbes.push(mutationProbe({ id: 'gate1/missing-seed', receipt: missingSeed, expectedCheck: 'client_capabilities' }));
    await backfillDesktopRuntimePlane({ withFirmDbClientFn: withFirmDbClient, logger: { log: () => {} } });

    await withFirmDbClient((client) => setClientFlagStage(client, {
      firmId: FIRM_ID,
      clientId: recreated.clientId,
      flagKey: ENTITY_READINESS_ADMISSION_FLAG,
      stage: 'canary',
      source: 'manual',
      reason: 'Gate 1B.0 admitted-extension real-PG proof',
      actorType: 'firm_member',
      actorId: MEMBER_ID
    }));
    const admittedExtension = await observeEntityCertificateB({
      query, rootDir, profileId: 'gb-ltd.self-provision.desktop.none.management-books.v2',
      firmId: FIRM_ID, clientId: recreated.clientId, hostCertificate, observedAt
    });
    mutationProbes.push(mutationProbe({
      id: 'gate1b0/admitted-readiness-extension',
      extraDetected: admittedExtension.status === 'PASS'
        && admittedExtension.checks.find(({ id }) => id === 'client_capabilities')?.detail?.live_admitted_extension_count === 1
        && admittedExtension.entity_dependency_digest === reset.entity_dependency_digest,
      detail: {
        certificate_status: admittedExtension.status,
        entity_dependency_digest: admittedExtension.entity_dependency_digest
      }
    }));

    await seed.query(
      `update ledger_accounts set name = 'Corrupted cash account'
        where firm_id = $1 and client_id = $2 and code = '1400'`,
      [FIRM_ID, recreated.clientId]
    );
    const corruptChart = await observeEntityCertificateB({
      query, rootDir, profileId: 'gb-ltd.self-provision.desktop.none.management-books.v2',
      firmId: FIRM_ID, clientId: recreated.clientId, hostCertificate, observedAt
    });
    mutationProbes.push(mutationProbe({ id: 'gate1/jurisdiction-palette-mutation', receipt: corruptChart, expectedCheck: 'persisted_chart' }));
    await seed.query(
      `update ledger_accounts set name = 'Bank account'
        where firm_id = $1 and client_id = $2 and code = '1400'`,
      [FIRM_ID, recreated.clientId]
    );

    await withFirmDbClient((client) => mintAuthorityGrant({
      client,
      firmId: FIRM_ID,
      clientId: recreated.clientId,
      scopeKind: 'merchant',
      scopeKey: 'stale certificate authority',
      archetype: 'recurring_rent_lease',
      amountCeiling: 100,
      currency: 'GBP',
      authorizedByActorType: 'firm_operator',
      authorizedByActorId: MEMBER_ID,
      source: 'operator_one_click',
      status: 'active'
    }));
    const staleAuthority = await observeEntityCertificateB({
      query, rootDir, profileId: 'gb-ltd.self-provision.desktop.none.management-books.v2',
      firmId: FIRM_ID, clientId: recreated.clientId, hostCertificate, observedAt
    });
    mutationProbes.push(mutationProbe({ id: 'gate1/stale-authority', receipt: staleAuthority, expectedCheck: 'authority_posture' }));
    await seed.query('delete from reconciliation_authority_grants where firm_id = $1 and client_id = $2', [FIRM_ID, recreated.clientId]);

    // queue_items is birth equipment (the intake creates a client WITH its
    // initial queue, and client deletion cascades it), so it can no longer
    // stand in for cross-client residue. history_items is written by no
    // server path at all — a row there for a fresh client is unambiguous.
    await seed.query(
      `insert into history_items (id, firm_id, client_id, payload)
       values ('history-cert-b-residue-mutation', $1, $2, '{"label": "Injected residue"}'::jsonb)`,
      [FIRM_ID, recreated.clientId]
    );
    const currentGeneration = await observeEntityCertificateB({
      query, rootDir, profileId: 'gb-ltd.self-provision.desktop.none.management-books.v2',
      firmId: FIRM_ID, clientId: recreated.clientId, hostCertificate,
      lifecycle: 'steady_state_observation',
      compatibilityScope: 'current_generation_compatibility',
      observedAt
    });
    mutationProbes.push(mutationProbe({
      id: 'gate1b0/current-generation-business-state',
      extraDetected: currentGeneration.status === 'PASS'
        && currentGeneration.checks.find(({ id }) => id === 'current_generation_compatibility')?.status === 'PASS',
      detail: { certificate_status: currentGeneration.status }
    }));
    const residue = await observeEntityCertificateB({
      query, rootDir, profileId: 'gb-ltd.self-provision.desktop.none.management-books.v2',
      firmId: FIRM_ID, clientId: recreated.clientId, hostCertificate, observedAt
    });
    mutationProbes.push(mutationProbe({ id: 'gate1/cross-client-residue', receipt: residue, expectedCheck: 'birth_residue_proof' }));
    await seed.query("delete from history_items where id = 'history-cert-b-residue-mutation'");

    const disabledHost = structuredClone(hostCertificate);
    disabledHost.checks.find(({ id }) => id === 'scheduler_worker_manifest').status = 'FAIL';
    const disabledWorker = await observeEntityCertificateB({
      query, rootDir, profileId: 'gb-ltd.self-provision.desktop.none.management-books.v2',
      firmId: FIRM_ID, clientId: recreated.clientId, hostCertificate: disabledHost, observedAt
    });
    mutationProbes.push(mutationProbe({ id: 'gate1/disabled-worker', receipt: disabledWorker, expectedCheck: 'host_compatibility' }));

    const migrationHost = structuredClone(hostCertificate);
    migrationHost.checks.find(({ id }) => id === 'database_schema').status = 'FAIL';
    const migrationMismatch = await observeEntityCertificateB({
      query, rootDir, profileId: 'gb-ltd.self-provision.desktop.none.management-books.v2',
      firmId: FIRM_ID, clientId: recreated.clientId, hostCertificate: migrationHost, observedAt
    });
    mutationProbes.push(mutationProbe({ id: 'gate1/migration-mismatch', receipt: migrationMismatch, expectedCheck: 'host_compatibility' }));

    let crossFirmError = null;
    try {
      await createClientInDb({
        firmId: OTHER_FIRM_ID,
        creationPrincipal: { ...memberPrincipal, principalId: 'member-cert-b-other' },
        profile: {
          id: GENERIC_ID,
          companyName: 'Attempted Cross-Firm Transfer Ltd',
          jurisdiction: 'GB',
          entityType: 'gb-ltd',
          accounting_system: 'none'
        }
      });
    } catch (error) {
      crossFirmError = error;
    }
    const originalAfterCollision = await observeEntityCertificateB({
      query, rootDir, profileId: 'gb-ltd.generic-client-route.desktop.none.management-books.v2',
      firmId: FIRM_ID, clientId: GENERIC_ID, hostCertificate, observedAt
    });
    mutationProbes.push(mutationProbe({
      id: 'bf-3/cross-firm-derived-id',
      extraDetected: crossFirmError?.code === 'CLIENT_ID_FIRM_CONFLICT' && originalAfterCollision.status === 'PASS',
      detail: { error_code: crossFirmError?.code || null, original_certificate_status: originalAfterCollision.status }
    }));

    const resetSummary = certificates.find(({ lifecycle }) => lifecycle === 'reset_recreate');
    mutationProbes.push(mutationProbe({
      id: 'gate1/reset-authority-equivalence',
      extraDetected: resetSummary?.status === 'PASS'
        && resetSummary.reauthorization_checklist.some(({ kind }) => kind === 'client_capability')
        && resetSummary.reauthorization_checklist.some(({ kind }) => kind === 'reconciliation_authority_grant'),
      detail: { reauthorization_checklist: resetSummary?.reauthorization_checklist || [] }
    }));

    const positivePass = certificates.every(({ status }) => status === 'PASS');
    const mutationsDetected = mutationProbes.every(({ detected }) => detected);
    return finalizeSuite({
      version: ENTITY_CERTIFICATE_B_SUITE_VERSION,
      certificate_version: ENTITY_CERTIFICATE_B_VERSION,
      mode: 'observe_only',
      enforcement: false,
      product_state_persisted: false,
      admission_authority: false,
      observed_at: observedAt,
      status: positivePass && mutationsDetected ? 'PASS' : 'FAIL',
      model_inference_calls: 0,
      model_spend_usd: 0,
      host_certificate_digest: hostCertificate.receipt_digest,
      migration_count: migrations.length,
      admitted_creation_paths_exercised: ['generic_client_route', 'desktop_firm_intake', 'self_provision', 'legacy_heal'],
      lifecycle_paths_exercised: ['cold_create', 'duplicate_retry', 'reset_recreate', 'legacy_upgrade', 'boot_heal', 'boot_heal_retry'],
      protected_bf_invariants: [
        'BF1_REAL_PG_SEED_FAILURE',
        'BF2_REAL_PG_LEGAL_FORM',
        'BF3_REAL_PG_FIRM_ISOLATION',
        'BF4_REAL_PG_ACTOR_ATTRIBUTION'
      ],
      certificates,
      mutation_probes: mutationProbes
    });
  } catch (error) {
    return finalizeSuite({
      ...incompleteSuite({
        observedAt,
        reason: 'entity_certificate_b_runner_failed',
        detail: { code: error?.code || 'ENTITY_CERTIFICATE_B_RUNNER_FAILED', message: error?.message || String(error) }
      }),
      status: 'FAIL',
      certificates,
      mutation_probes: mutationProbes
    });
  } finally {
    await __endFirmDbPoolForTests().catch(() => {});
    for (const key of envKeys) restoreEnv(key, priorEnv[key]);
    await seed?.end().catch(() => {});
    if (admin._connected) {
      await admin.query(
        'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
        [dbName]
      ).catch(() => {});
      await admin.query(`drop database if exists "${dbName}"`).catch(() => {});
      await admin.end().catch(() => {});
    }
  }
};

export const runEntityCertificateB = async ({ argv = process.argv.slice(2), env = process.env } = {}) => {
  const args = parseEntityCertificateArgs(argv);
  const observedAt = new Date().toISOString();
  let hostCertificate = null;
  if (args.hostCertificate) {
    hostCertificate = JSON.parse(await readFile(path.resolve(args.hostCertificate), 'utf8'));
  }
  const receipt = await runEntityCertificateBRealPg({
    pgUrl: env.DONNA_PG_TEST_URL || '',
    hostCertificate,
    rootDir: process.cwd(),
    observedAt
  });
  const json = `${JSON.stringify(receipt, null, 2)}\n`;
  if (args.output) {
    const target = path.resolve(args.output);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, json, 'utf8');
  } else {
    process.stdout.write(json);
  }
  if (args.requirePass && receipt.status !== 'PASS') {
    const error = new Error(`Entity Certificate B suite is ${receipt.status}, not PASS.`);
    error.exitCode = receipt.status === 'INCOMPLETE' ? 2 : 1;
    error.receipt = receipt;
    throw error;
  }
  return receipt;
};

const main = async () => {
  try {
    const receipt = await runEntityCertificateB();
    if (process.argv.some((arg) => arg === '--output' || arg.startsWith('--output='))) {
      console.log(`Entity Certificate B: ${receipt.status}`);
    }
  } catch (error) {
    console.error(error?.message || error);
    process.exitCode = error?.exitCode || 1;
  } finally {
    await closeFirmDbPool();
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
