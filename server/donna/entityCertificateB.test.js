import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { GB_DEFAULT_CHART } from './gb/defaultChart.js';
import {
  HOST_CERTIFICATE_A_VERSION,
  HOST_COMPATIBILITY_CONTRACT_VERSION,
  buildHostCertificateFreshness,
  hostCompatibilityDigest,
  hostDigest
} from './hostCertificateA.js';
import { ENTITY_READINESS_ADMISSION_FLAG, MEMORY_LEGACY_AI_RULE_DEMOTION_FLAG } from './clientConfig.js';
import { DESKTOP_CLIENT_FLAG_SEEDS } from './desktop/hostPlaneSeed.js';
import { ENTITY_READINESS_NEW_CLIENT_REASON } from './runtimeReadinessEnrollment.js';
import {
  evaluateEntityCertificateB,
  loadAdmittedEntityProfileManifest,
  observeEntityCertificateB,
  resolveAdmittedEntityProfile,
  UndeclaredEntityProfileError,
  validateAdmittedEntityProfileManifest
} from './entityCertificateB.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const FIRM_ID = 'firm-cert-b';
const CLIENT_ID = 'client-cert-b';

// `failCheck` flips one required structural check to FAIL (a real host
// incompatibility); `status` alone models a host-level failure that leaves
// every required check PASS (a dirty renderer build). The model_routes check
// always carries a dark Anthropic lane: Host A v5 receipts that, and an entity
// must certify against it.
const hostCertificate = ({ mintedAt = '2026-08-29T09:55:00.000Z', status = 'PASS', failCheck = null } = {}) => {
  const checks = [
    { id: 'database_schema', status: 'PASS', detail: {} },
    { id: 'scheduler_worker_manifest', status: 'PASS', detail: {} },
    { id: 'evidence_storage', status: 'PASS', detail: { provider: 'local_blob' } },
    {
      id: 'model_routes',
      status: 'PASS',
      detail: {
        dark_providers: ['anthropic'],
        dark_lanes: ['unified_extraction'],
        lanes: [
          { lane_id: 'transaction_coding', kind: 'deciding', provider: 'openai', credential_present: true },
          { lane_id: 'unified_extraction', kind: 'deciding', provider: 'anthropic', credential_present: false }
        ]
      }
    },
    { id: 'policy_oracle_artifacts', status: 'PASS', detail: {} },
    {
      id: 'config_control_plane',
      status: 'PASS',
      // The real Host A declares DESKTOP_CLIENT_FLAG_SEEDS ∪ AUTO_FORBIDDEN_FLAGS ∪
      // SHADOW_CEILING_FLAGS; the mock names the admitted extensions the
      // contract declares (ENTITY_READINESS_ADMISSION; MEMORY_LEGACY_AI_RULE_DEMOTION — DMEM-R1 W1; MEMORY_MODEL_V2 — DMEM-R1 W2,
      // AUTO_FORBIDDEN until W6A).
      detail: { supported_keys: [...DESKTOP_CLIENT_FLAG_SEEDS, ENTITY_READINESS_ADMISSION_FLAG, MEMORY_LEGACY_AI_RULE_DEMOTION_FLAG, 'MEMORY_MODEL_V2', 'JEV_RECONCILIATION', 'JEV_HELD_PLAN_COMPLETION', 'CODING_CORRECTION_AUTO_APPLY', 'CODING_OWNER_TRANSFER_POST', 'INVENTORY_CORE', 'INVENTORY_ACCOUNTING', 'PHYSICAL_RECONCILIATION', 'PHYSICAL_INVENTORY_APPLY', 'PHYSICAL_CAPTURE_ACCESS'].sort() }
    },
    { id: 'accounting_adapter', status: 'PASS', detail: { registered_external_adapters: ['none', 'xero', 'qbo', 'procountor'] } }
  ];
  if (failCheck) checks.find(({ id }) => id === failCheck).status = 'FAIL';
  const body = {
    version: HOST_CERTIFICATE_A_VERSION,
    status,
    runtime_host: 'desktop',
    compatibility_contract_version: HOST_COMPATIBILITY_CONTRACT_VERSION,
    compatibility_digest: hostCompatibilityDigest({ runtimeHost: 'desktop', checks }),
    freshness: buildHostCertificateFreshness({ mintedAt }),
    checks
  };
  return { ...body, receipt_digest: hostDigest(body) };
};

const buildSnapshot = ({ capabilityContract }) => ({
  client: {
    id: CLIENT_ID,
    firm_id: FIRM_ID,
    company_name: 'Certificate Apiary Ltd',
    uen: 'CERT-B-001',
    entity_type: 'gb-ltd',
    jurisdiction: 'GB',
    status: 'active',
    default_currency: 'GBP',
    profile: {
      companyName: 'Certificate Apiary Ltd',
      entityType: 'gb-ltd',
      jurisdiction: 'GB',
      accounting_system: 'none',
      email: 'owner@certificate.example'
    }
  },
  creation_receipts: [{
    id: 'audit-create-cert-b',
    action: 'client.create',
    actor_type: 'supabase_user',
    actor_id: 'owner-cert-b',
    metadata: {
      authority_basis: {
        source: 'authenticated_self_provision_route',
        principal_type: 'supabase_user',
        principal_id: 'owner-cert-b'
      },
      executor: { actor_type: 'system', actor_id: 'createClientInDb' }
    }
  }],
  profile_receipts: [],
  authority_purge_receipts: [],
  live_flags: capabilityContract.required_baseline.map((row, index) => ({ id: `flag-${index}`, ...row })),
  ledger_accounts: GB_DEFAULT_CHART.map((account, index) => ({
    id: `account-${index}`,
    code: account.code,
    name: account.name_en,
    account_type: account.account_type,
    normal_balance: account.normal_balance,
    canonical_role: account.canonical_role,
    status: 'active',
    payload: { source: 'gb_default_chart' }
  })),
  assignments: [{
    id: 'assignment-cert-b',
    principal_type: 'firm_collaborator',
    principal_id: 'collaborator-cert-b',
    role: 'owner',
    access_level: 'client_scoped',
    assignment_kind: 'access',
    status: 'active'
  }],
  firm_members: [],
  firm_collaborators: [{
    id: 'collaborator-cert-b',
    user_id: 'owner-cert-b',
    email: 'owner@certificate.example',
    role: 'owner',
    status: 'active',
    access_level: 'client_scoped'
  }],
  reconciliation_authority_grants: [],
  action_authority_grants: [],
  client_table_counts: {
    audit_events: 12,
    client_assignments: 1,
    client_capability_config: capabilityContract.required_baseline.length,
    ledger_accounts: GB_DEFAULT_CHART.length,
    // The intake births the client WITH its initial work queue in the same
    // transaction — birth equipment, never prior residue.
    queue_items: 2,
    documents: 0,
    transactions: 0,
    client_evidence_requests: 0,
    ledger_journals: 0
  },
  special_residue: { firm_facts: 0, memories: 0, local_jobs: 0 },
  cross_firm_collisions: []
});

const deepClone = (value) => structuredClone(value);

const fixture = async () => {
  const { manifest, digest } = await loadAdmittedEntityProfileManifest({ rootDir: ROOT });
  const admittedProfile = resolveAdmittedEntityProfile({
    manifest,
    profileId: 'gb-ltd.self-provision.desktop.none.management-books.v2'
  });
  const capabilityContract = manifest.capability_manifests[admittedProfile.capability_manifest_version];
  const chartContract = manifest.chart_contracts[admittedProfile.chart_contract_version];
  const packManifest = JSON.parse(await readFile(path.join(ROOT, 'packs', chartContract.pack_id, 'manifest.json'), 'utf8'));
  const snapshot = buildSnapshot({ capabilityContract });
  return { manifest, digest, admittedProfile, capabilityContract, packManifest, snapshot };
};

test('the admitted-profile manifest is exact, versioned, and reconciles Proof 0 uk_ltd to runtime gb-ltd', async () => {
  const { manifest } = await fixture();
  assert.deepEqual(validateAdmittedEntityProfileManifest(manifest), { valid: true, errors: [] });
  // 10 = the four GB shapes + the three FI shapes (self-provision, and the
  // firm-intake + generic-route pair declared 2026-09-08 when the first FI
  // entity created on the desktop certified ENTITY_PROFILE_UNDECLARED —
  // the retry leg falls back to generic_client_route, so both cells are
  // declared, as for GB and AE) + the US portability sentinel + the two AE
  // shapes declared 2026-08-31 when the first AE entity hit the same gate.
  assert.equal(manifest.profiles.filter(profile => profile.runtime_host === 'desktop').length, 10);
  assert.equal(manifest.profiles.length, 16, 'three FI cloud authority paths, distinct legacy/native SG review profiles and the US hosted pilot (2026-10-01), no desktop expansion');
  assert.equal(manifest.capability_manifests['desktop-runtime.v2'].admitted_extensions[0].flag_key,
    ENTITY_READINESS_ADMISSION_FLAG);
  const legacy = manifest.legacy_identity_contracts.find(({ legacy_legal_form }) => legacy_legal_form === 'uk_ltd');
  assert.equal(legacy.canonical_legal_form, 'gb-ltd');
  assert.throws(
    () => resolveAdmittedEntityProfile({
      manifest,
      coordinate: {
        jurisdiction: 'US', canonical_legal_form: 'us-s-corp', creation_path: 'self_provision',
        runtime_host: 'desktop', accounting_adapter: 'none', accounting_view: 'management_books',
        capability_manifest_version: 'desktop-runtime.v2'
      }
    }),
    (error) => error instanceof UndeclaredEntityProfileError && error.code === 'ENTITY_PROFILE_UNDECLARED'
  );
});

test('a healthy persisted self-provision birth produces a stable observe-only saga and immutable retry attempt', async () => {
  const { manifest, digest, admittedProfile, packManifest, snapshot } = await fixture();
  const firstHost = hostCertificate();
  const first = evaluateEntityCertificateB({
    manifest,
    manifestDigest: digest,
    admittedProfile,
    hostCertificate: firstHost,
    packManifest,
    snapshot,
    firmId: FIRM_ID,
    clientId: CLIENT_ID,
    observedAt: '2026-08-29T10:00:00.000Z'
  });
  assert.equal(first.status, 'PASS');
  assert.equal(first.mode, 'observe_only');
  assert.equal(first.enforcement, false);
  assert.equal(first.product_state_persisted, false);
  assert.equal(first.admission_authority, false);
  assert.equal(first.model_inference_calls, 0);
  assert.equal(first.model_spend_usd, 0);
  assert.equal(first.provisioning_saga.readiness_projection, 'ready_candidate_observed');
  assert.equal(first.provisioning_saga.initiating_principal.actor_id, 'owner-cert-b');
  assert.deepEqual(first.provisioning_saga.system_executor, { actor_type: 'system', actor_id: 'createClientInDb' });

  const renewedHost = hostCertificate({ mintedAt: '2026-08-29T10:00:00.000Z' });
  const second = evaluateEntityCertificateB({
    manifest,
    manifestDigest: digest,
    admittedProfile,
    hostCertificate: renewedHost,
    packManifest,
    snapshot: deepClone(snapshot),
    firmId: FIRM_ID,
    clientId: CLIENT_ID,
    observedAt: '2026-08-29T10:01:00.000Z',
    priorAttempts: first.provisioning_saga.attempts
  });
  assert.equal(second.status, 'PASS');
  assert.equal(second.provisioning_saga.saga_id, first.provisioning_saga.saga_id);
  assert.equal(second.provisioning_saga.idempotency_key, first.provisioning_saga.idempotency_key);
  assert.equal(second.entity_dependency_digest, first.entity_dependency_digest);
  assert.equal(second.generation_digest, first.generation_digest);
  assert.equal(second.current_host_observation.compatibility_digest, first.current_host_observation.compatibility_digest);
  assert.notEqual(second.current_host_observation.certificate_receipt_digest, first.current_host_observation.certificate_receipt_digest);
  assert.equal(second.provisioning_saga.attempts.length, 2);
  assert.notEqual(second.provisioning_saga.attempts[1].attempt_id, second.provisioning_saga.attempts[0].attempt_id);
});

test('home currency admission reads the client profile, never the firm default currency', async () => {
  const base = await fixture();
  const evaluate = (snapshot) => evaluateEntityCertificateB({
    manifest: base.manifest,
    manifestDigest: base.digest,
    admittedProfile: base.admittedProfile,
    hostCertificate: hostCertificate(),
    packManifest: base.packManifest,
    snapshot,
    firmId: FIRM_ID,
    clientId: CLIENT_ID,
    observedAt: '2026-08-29T10:00:00.000Z'
  });
  // The snapshot's default_currency is the FIRM's column (the snapshot join).
  // A firm keeping its books in another currency must not fail its client's
  // admission — the 2026-08-31 appliance regression: every client of the
  // demo firm failed home_currency_mismatch off the firm plane.
  const firmCurrency = deepClone(base.snapshot);
  firmCurrency.client.default_currency = 'EUR';
  const inherited = evaluate(firmCurrency);
  assert.equal(inherited.status, 'PASS');
  const posture = inherited.checks.find(({ id }) => id === 'accounting_posture');
  assert.equal(posture.detail.home_currency, 'GBP');
  assert.equal(posture.detail.home_currency_source, 'admitted_profile_contract');
  // The client's OWN persisted book currency still fails a true contradiction.
  const contradicted = deepClone(base.snapshot);
  contradicted.client.profile.defaultCurrency = 'usd';
  const failed = evaluate(contradicted);
  assert.equal(failed.status, 'FAIL');
  assert.deepEqual(
    failed.checks.find(({ id }) => id === 'accounting_posture').detail.failures,
    ['home_currency_mismatch']
  );
  // A matching persisted currency normalizes and is attributed to the profile.
  const matching = deepClone(base.snapshot);
  matching.client.profile.accountingCurrency = 'gbp';
  const ok = evaluate(matching);
  assert.equal(ok.status, 'PASS');
  assert.equal(
    ok.checks.find(({ id }) => id === 'accounting_posture').detail.home_currency_source,
    'persisted_profile'
  );
});

test('birth residue accepts the intake queue but still fails on genuine prior business state', async () => {
  const base = await fixture();
  const evaluate = (snapshot) => evaluateEntityCertificateB({
    manifest: base.manifest,
    manifestDigest: base.digest,
    admittedProfile: base.admittedProfile,
    hostCertificate: hostCertificate(),
    packManifest: base.packManifest,
    snapshot,
    firmId: FIRM_ID,
    clientId: CLIENT_ID,
    observedAt: '2026-08-29T10:00:00.000Z'
  });
  // The healthy fixture already carries queue_items > 0 (the intake's own
  // rows); prove the check reads them as expected birth equipment.
  const seeded = evaluate(deepClone(base.snapshot));
  assert.equal(seeded.checks.find(({ id }) => id === 'birth_residue_proof').status, 'PASS');
  // A Finnish birth mints its statutory duty record in the same second the
  // client is born (FI_CLIENT_LIFECYCLE via the lifecycle registry): the
  // annual-return quarantine blocker for an Oy. Those rows are the pack's
  // own birth equipment, never prior residue (2026-09-08).
  const fiBirth = deepClone(base.snapshot);
  fiBirth.client_table_counts.statutory_blockers = 1;
  fiBirth.client_table_counts.statutory_blocker_events = 1;
  assert.equal(evaluate(fiBirth).checks.find(({ id }) => id === 'birth_residue_proof').status, 'PASS');
  // Real prior-generation state still refuses under birth scope.
  const residue = deepClone(base.snapshot);
  residue.client_table_counts.llm_decisions = 3;
  const failed = evaluate(residue);
  assert.equal(failed.status, 'FAIL');
  assert.deepEqual(
    failed.checks.find(({ id }) => id === 'birth_residue_proof').detail.failures,
    ['prior_client_residue:llm_decisions']
  );
});

test('the declared readiness extension coexists without changing the entity digest; unknown or over-ceiling flags fail closed', async () => {
  const base = await fixture();
  const evaluate = (snapshot) => evaluateEntityCertificateB({
    manifest: base.manifest,
    manifestDigest: base.digest,
    admittedProfile: base.admittedProfile,
    hostCertificate: hostCertificate(),
    packManifest: base.packManifest,
    snapshot,
    firmId: FIRM_ID,
    clientId: CLIENT_ID,
    observedAt: '2026-08-29T10:00:00.000Z'
  });
  const baseline = evaluate(deepClone(base.snapshot));
  const admittedSnapshot = deepClone(base.snapshot);
  admittedSnapshot.live_flags.push({
    id: 'flag-readiness',
    flag_key: ENTITY_READINESS_ADMISSION_FLAG,
    stage: 'canary',
    source: 'manual',
    reason: 'isolated EAW readiness canary'
  });
  admittedSnapshot.client_table_counts.client_capability_config += 1;
  const admitted = evaluate(admittedSnapshot);
  assert.equal(admitted.status, 'PASS');
  assert.equal(admitted.entity_dependency_digest, baseline.entity_dependency_digest,
    'the rollout extension is not part of stable entity dependencies');
  assert.equal(admitted.checks.find(({ id }) => id === 'client_capabilities').detail.live_admitted_extension_count, 1);

  const newClientSnapshot = deepClone(base.snapshot);
  newClientSnapshot.live_flags.push({
    id: 'flag-readiness-new-client',
    flag_key: ENTITY_READINESS_ADMISSION_FLAG,
    stage: 'canary',
    source: 'default',
    reason: ENTITY_READINESS_NEW_CLIENT_REASON
  });
  newClientSnapshot.client_table_counts.client_capability_config += 1;
  const newClient = evaluate(newClientSnapshot);
  assert.equal(newClient.status, 'PASS');
  assert.equal(newClient.entity_dependency_digest, baseline.entity_dependency_digest,
    'new-client enrollment is rollout posture, not an entity dependency');

  const foreignProfileSnapshot = deepClone(base.snapshot);
  foreignProfileSnapshot.live_flags.push({id:'foreign-fiscal-intake',flag_key:'FISCAL_PERIOD_INTAKE',stage:'canary',source:'manual',reason:'FI pilot only'});
  const foreignProfile=evaluate(foreignProfileSnapshot);
  assert.equal(foreignProfile.status,'FAIL');
  assert.ok(foreignProfile.checks.find(({id})=>id==='client_capabilities').detail.failures.includes('unexpected_live_capability:FISCAL_PERIOD_INTAKE'));

  const unknownSnapshot = deepClone(admittedSnapshot);
  unknownSnapshot.live_flags.at(-1).flag_key = 'UNDECLARED_RUNTIME_FLAG';
  const unknown = evaluate(unknownSnapshot);
  assert.equal(unknown.status, 'FAIL');
  assert.ok(unknown.checks.find(({ id }) => id === 'client_capabilities').detail.failures
    .includes('unexpected_live_capability:UNDECLARED_RUNTIME_FLAG'));

  const overCeilingSnapshot = deepClone(admittedSnapshot);
  overCeilingSnapshot.live_flags.at(-1).stage = 'auto';
  const overCeiling = evaluate(overCeilingSnapshot);
  assert.equal(overCeiling.status, 'FAIL');
  assert.ok(overCeiling.checks.find(({ id }) => id === 'client_capabilities').detail.failures
    .includes(`admitted_extension_posture_mismatch:${ENTITY_READINESS_ADMISSION_FLAG}`));
});

test('live business state passes current-generation compatibility while the same state fails the strict birth residue proof', async () => {
  const base = await fixture();
  const snapshot = deepClone(base.snapshot);
  snapshot.client_table_counts.documents = 4;
  snapshot.client_table_counts.transactions = 7;
  snapshot.client_table_counts.client_evidence_requests = 1;
  snapshot.client_table_counts.ledger_journals = 3;
  snapshot.special_residue.firm_facts = 2;
  snapshot.reconciliation_authority_grants.push({
    id: 'grant-current-generation',
    scope_kind: 'merchant',
    scope_key: 'apiary supplier',
    status: 'active',
    source: 'operator_one_click'
  });
  const common = {
    manifest: base.manifest,
    manifestDigest: base.digest,
    admittedProfile: base.admittedProfile,
    hostCertificate: hostCertificate(),
    packManifest: base.packManifest,
    snapshot,
    firmId: FIRM_ID,
    clientId: CLIENT_ID,
    observedAt: '2026-08-29T10:00:00.000Z'
  };
  const birth = evaluateEntityCertificateB(common);
  assert.equal(birth.status, 'FAIL');
  assert.equal(birth.checks.find(({ id }) => id === 'birth_residue_proof').status, 'FAIL');

  const current = evaluateEntityCertificateB({
    ...common,
    lifecycle: 'steady_state_observation',
    compatibilityScope: 'current_generation_compatibility'
  });
  assert.equal(current.status, 'PASS');
  assert.equal(current.checks.find(({ id }) => id === 'current_generation_compatibility').status, 'PASS');
  assert.equal(current.checks.find(({ id }) => id === 'authority_posture').status, 'PASS');
});

test('a required host check failure or expiry blocks certification; a host-only failure does not — and neither changes the entity dependency digest', async () => {
  const base = await fixture();
  const common = {
    manifest: base.manifest,
    manifestDigest: base.digest,
    admittedProfile: base.admittedProfile,
    packManifest: base.packManifest,
    snapshot: base.snapshot,
    firmId: FIRM_ID,
    clientId: CLIENT_ID,
    observedAt: '2026-08-29T10:00:00.000Z'
  };
  const healthy = evaluateEntityCertificateB({ ...common, hostCertificate: hostCertificate() });
  // Host A v5 (RT-01): a FAIL that leaves every required structural check
  // PASS (a dirty renderer build; a dark optional lane is not even a FAIL)
  // is the host admission predicates' business — mutations stay blocked at
  // the host, the entity stays certified and its episode budget untouched.
  const hostOnlyFailure = evaluateEntityCertificateB({ ...common, hostCertificate: hostCertificate({ status: 'FAIL' }) });
  const failed = evaluateEntityCertificateB({
    ...common,
    hostCertificate: hostCertificate({ status: 'FAIL', failCheck: 'database_schema' })
  });
  const expired = evaluateEntityCertificateB({
    ...common,
    hostCertificate: hostCertificate({ mintedAt: '2026-08-29T09:30:00.000Z' })
  });
  assert.equal(healthy.status, 'PASS');
  assert.equal(hostOnlyFailure.status, 'PASS', 'a host-level failure with every required check PASS is not an entity incompatibility');
  assert.equal(hostOnlyFailure.current_host_observation.status, 'FAIL', 'the host observation still records the failed host');
  assert.equal(failed.status, 'FAIL');
  assert.deepEqual(
    failed.checks.find(({ id }) => id === 'host_compatibility').detail.failures,
    ['host_certificate_not_pass', 'host_database_schema_not_pass']
  );
  assert.equal(expired.status, 'FAIL');
  assert.equal(hostOnlyFailure.entity_dependency_digest, healthy.entity_dependency_digest);
  assert.equal(failed.entity_dependency_digest, healthy.entity_dependency_digest);
  assert.equal(expired.entity_dependency_digest, healthy.entity_dependency_digest);
  assert.ok(expired.checks.find(({ id }) => id === 'host_compatibility').detail.failures
    .includes('host_certificate_expired'));
});

test('registered Gate 1 mutations are rejected with a localized root-cause check', async (t) => {
  const base = await fixture();
  const mutations = [
    ['missing desktop seed', (state) => state.snapshot.live_flags.pop(), 'client_capabilities'],
    ['corrupt chart code', (state) => { state.snapshot.ledger_accounts[0].code = '9999'; }, 'persisted_chart'],
    ['lost initiating actor', (state) => { state.snapshot.creation_receipts[0].actor_id = 'system'; }, 'ownership_actor'],
    ['stale authority', (state) => state.snapshot.reconciliation_authority_grants.push({ id: 'grant-stale' }), 'authority_posture'],
    ['prior-client residue', (state) => { state.snapshot.client_table_counts.documents = 1; }, 'birth_residue_proof'],
    ['cross-firm identity', (state) => state.snapshot.cross_firm_collisions.push({ id: CLIENT_ID, firm_id: 'other-firm' }), 'firm_isolation'],
    ['disabled worker', (state) => {
      state.hostCertificate.checks.find(({ id }) => id === 'scheduler_worker_manifest').status = 'FAIL';
    }, 'host_compatibility'],
    ['migration mismatch', (state) => {
      state.hostCertificate.checks.find(({ id }) => id === 'database_schema').status = 'FAIL';
    }, 'host_compatibility']
  ];
  for (const [name, mutate, expectedCheck] of mutations) {
    await t.test(name, () => {
      const state = {
        ...base,
        snapshot: deepClone(base.snapshot),
        hostCertificate: hostCertificate()
      };
      mutate(state);
      const receipt = evaluateEntityCertificateB({
        manifest: state.manifest,
        manifestDigest: state.digest,
        admittedProfile: state.admittedProfile,
        hostCertificate: state.hostCertificate,
        packManifest: state.packManifest,
        snapshot: state.snapshot,
        firmId: FIRM_ID,
        clientId: CLIENT_ID,
        observedAt: '2026-08-29T10:02:00.000Z'
      });
      assert.equal(receipt.status, 'FAIL');
      assert.equal(receipt.checks.find(({ id }) => id === expectedCheck).status, 'FAIL');
      assert.equal(receipt.provisioning_saga.readiness_projection, 'failed_candidate_observed');
      assert.ok(receipt.provisioning_saga.earliest_failure);
    });
  }
});

test('missing PostgreSQL evidence is INCOMPLETE, never a skipped green certificate', async () => {
  const receipt = await observeEntityCertificateB({
    query: async () => { throw Object.assign(new Error('database unavailable'), { code: 'ECONNREFUSED' }); },
    rootDir: ROOT,
    profileId: 'gb-ltd.self-provision.desktop.none.management-books.v2',
    firmId: FIRM_ID,
    clientId: CLIENT_ID,
    hostCertificate: hostCertificate(),
    observedAt: '2026-08-29T10:03:00.000Z'
  });
  assert.equal(receipt.status, 'INCOMPLETE');
  assert.equal(receipt.checks[0].id, 'persisted_entity_snapshot');
  assert.ok(!JSON.stringify(receipt).includes('skipped'));
});

test('a verdict-minted code-less account is the sanctioned shape — it fails certification only under a pinned coded chart', async () => {
  const { manifest, digest, admittedProfile, packManifest, snapshot } = await fixture();
  const verdictAccount = {
    id: 'account-verdict-amex',
    code: null,
    name: 'Credit card payable - American Express',
    account_type: 'liability',
    normal_balance: 'credit',
    canonical_role: null,
    status: 'active',
    payload: { source: 'missing_account_verdict' }
  };
  const chartCheckOf = (receipt) => receipt.checks.find(({ id }) => id === 'persisted_chart');

  // Non-pinned contract (persisted_chart 'none', the GB firm-intake shape —
  // also every FI/US/AE book): code-less verdict accounts, even two of them,
  // are NOT residue and NOT duplicates. This is the Honeybee 2026-08-31 case.
  const unpinnedProfile = resolveAdmittedEntityProfile({
    manifest,
    profileId: 'gb-ltd.desktop-firm-intake.desktop.none.management-books.v2'
  });
  const secondVerdictAccount = {
    ...verdictAccount, id: 'account-verdict-visa', name: 'Credit card payable - Visa'
  };
  const unpinned = evaluateEntityCertificateB({
    manifest,
    manifestDigest: digest,
    admittedProfile: unpinnedProfile,
    hostCertificate: hostCertificate(),
    packManifest,
    snapshot: {
      ...deepClone(snapshot),
      ledger_accounts: [...deepClone(snapshot).ledger_accounts, verdictAccount, secondVerdictAccount]
    },
    firmId: FIRM_ID,
    clientId: CLIENT_ID,
    observedAt: '2026-08-29T10:00:00.000Z'
  });
  assert.deepEqual(chartCheckOf(unpinned).detail.failures, []);
  assert.equal(chartCheckOf(unpinned).status, 'PASS');

  // A NAMELESS account stays a defect everywhere.
  const nameless = evaluateEntityCertificateB({
    manifest,
    manifestDigest: digest,
    admittedProfile: unpinnedProfile,
    hostCertificate: hostCertificate(),
    packManifest,
    snapshot: {
      ...deepClone(snapshot),
      ledger_accounts: [...deepClone(snapshot).ledger_accounts, { ...verdictAccount, name: '' }]
    },
    firmId: FIRM_ID,
    clientId: CLIENT_ID,
    observedAt: '2026-08-29T10:00:00.000Z'
  });
  assert.ok(chartCheckOf(nameless).detail.failures.includes('persisted_chart_name_missing'));

  // Duplicate REAL codes are still a defect.
  const cloned = deepClone(snapshot);
  const dupCoded = evaluateEntityCertificateB({
    manifest,
    manifestDigest: digest,
    admittedProfile: unpinnedProfile,
    hostCertificate: hostCertificate(),
    packManifest,
    snapshot: {
      ...cloned,
      ledger_accounts: [...cloned.ledger_accounts, { ...cloned.ledger_accounts[0], id: 'account-dup' }]
    },
    firmId: FIRM_ID,
    clientId: CLIENT_ID,
    observedAt: '2026-08-29T10:00:00.000Z'
  });
  assert.ok(chartCheckOf(dupCoded).detail.failures.includes('persisted_chart_code_duplicate'));

  // The pinned coded chart (gb_default_chart.v1) still requires codes.
  const pinned = evaluateEntityCertificateB({
    manifest,
    manifestDigest: digest,
    admittedProfile,
    hostCertificate: hostCertificate(),
    packManifest,
    snapshot: {
      ...deepClone(snapshot),
      ledger_accounts: [...deepClone(snapshot).ledger_accounts, verdictAccount]
    },
    firmId: FIRM_ID,
    clientId: CLIENT_ID,
    observedAt: '2026-08-29T10:00:00.000Z'
  });
  assert.ok(chartCheckOf(pinned).detail.failures.includes('persisted_chart_code_missing'));
  assert.ok(chartCheckOf(pinned).detail.failures.includes('persisted_chart_contract_mismatch'));
});


test('an unavailable registered coded chart cannot certify as an unpinned chart', async () => {
  const { manifest, digest, admittedProfile, packManifest, snapshot } = await fixture();
  const changed = deepClone(manifest);
  changed.chart_contracts[admittedProfile.chart_contract_version].persisted_chart = 'fixture-missing-chart.v1';
  const receipt = evaluateEntityCertificateB({
    manifest: changed, manifestDigest: digest, admittedProfile,
    hostCertificate: hostCertificate(), packManifest, snapshot,
    firmId: FIRM_ID, clientId: CLIENT_ID, observedAt: '2026-08-29T10:00:00.000Z'
  });
  assert.equal(receipt.status, 'FAIL');
  assert.ok(receipt.checks.find(({ id }) => id === 'persisted_chart').detail.failures.includes('persisted_chart_contract_unavailable'));
});

// ── 2026-09-08: every chart contract pins the pack that is actually on disk ──
// The FI pack went to version 7 in RT-11b (2026-09-02) and its contract stayed
// at 6, so the first FI entity certified country_pack_version_mismatch after
// its profile had been declared. This is the drift check that was missing.

test('every chart contract matches its country pack on disk: id, version, home currency, required roles', async () => {
  const { manifest } = await fixture();
  for (const [contractId, contract] of Object.entries(manifest.chart_contracts)) {
    const pack = JSON.parse(await readFile(path.join(ROOT, 'packs', contract.pack_id, 'manifest.json'), 'utf8'));
    assert.equal(pack.pack?.id, contract.pack_id, `${contractId}: pack id`);
    assert.equal(Number(pack.pack?.version), Number(contract.pack_version), `${contractId}: pack version drifted — bump the contract by declaration`);
    assert.equal(pack.currency?.home, contract.home_currency, `${contractId}: home currency`);
    const roles = (pack.chart_of_accounts?.fallback_accounts || []).map(({ role }) => role);
    for (const role of contract.required_pack_roles || []) {
      assert.ok(roles.includes(role), `${contractId}: required role ${role} is in the pack`);
    }
  }
  for (const profile of manifest.profiles) {
    assert.ok(manifest.chart_contracts[profile.chart_contract_version], `${profile.profile_id} names a declared chart contract`);
  }
});


test('cloud adoption is one exact paired path and principal contract', async () => {
  const {manifest}=await loadAdmittedEntityProfileManifest({rootDir:ROOT});
  const adoption=manifest.profiles.find(p=>p.creation_path==='existing_owner_adoption');
  assert.equal(adoption.principal_contract,'revalidated_existing_owner');
  for(const patch of [{runtime_host:'desktop'},{principal_contract:'self_serve_owner'},{creation_path:'self_provision'},{jurisdiction:'GB'},{accounting_view:'statutory_books'}]) {
    const changed=structuredClone(manifest);Object.assign(changed.profiles.find(p=>p.profile_id===adoption.profile_id),patch);
    assert.equal(validateAdmittedEntityProfileManifest(changed).valid,false,JSON.stringify(patch));
  }
});

test('the Finnish cloud firm-intake member contract remains exact', async () => {
  const {manifest}=await loadAdmittedEntityProfileManifest({rootDir:ROOT});
  const profile=manifest.profiles.find(p=>p.runtime_host==='vercel'&&p.creation_path==='desktop_firm_intake'
    &&p.jurisdiction==='FI'&&p.canonical_legal_form==='fi-oy');
  assert.equal(profile.jurisdiction,'FI');
  assert.equal(profile.canonical_legal_form,'fi-oy');
  assert.equal(profile.principal_contract,'firm_member');
  assert.equal(validateAdmittedEntityProfileManifest(manifest).valid,true);
  for(const patch of [{principal_contract:'self_serve_owner'},{jurisdiction:'GB'},{accounting_view:'statutory_books'},{required_provider_classes:['openai']}]) {
    const changed=structuredClone(manifest);Object.assign(changed.profiles.find(p=>p.profile_id===profile.profile_id),patch);
    assert.equal(validateAdmittedEntityProfileManifest(changed).valid,false,JSON.stringify(patch));
  }
});

// 2026-09-16: continued operation depends on CURRENT firm authority, never on
// the original creator staying employed. The immutable client.create receipt
// still proves birth; the birth scope still requires the creator to have been
// an active member; the current-generation scope requires that SOME active
// member exists — a removed creator with another active member is fine, a
// firm with no active member is not. Receipts are never rewritten.
test('firm_member contract: a removed creator does not strand the book while another active member remains', async () => {
  const { manifest, digest, packManifest, snapshot } = await fixture();
  const admittedProfile = resolveAdmittedEntityProfile({
    manifest,
    profileId: 'gb-ltd.desktop-firm-intake.desktop.none.management-books.v2'
  });
  const withMembers = (members, { creatorId = 'member-creator' } = {}) => {
    const state = deepClone(snapshot);
    state.creation_receipts[0].actor_type = 'firm_member';
    state.creation_receipts[0].actor_id = creatorId;
    state.creation_receipts[0].metadata.authority_basis = {
      source: 'authenticated_firm_create_route', principal_type: 'firm_member', principal_id: creatorId
    };
    state.firm_members = members;
    return state;
  };
  const evaluate = (state, compatibilityScope) => evaluateEntityCertificateB({
    manifest, manifestDigest: digest, admittedProfile, hostCertificate: hostCertificate(), packManifest,
    snapshot: state, firmId: FIRM_ID, clientId: CLIENT_ID, compatibilityScope,
    lifecycle: compatibilityScope === 'birth_residue_proof' ? 'cold_create' : 'retry',
    observedAt: '2026-08-29T10:00:00.000Z'
  });
  const ownership = (certificate) => certificate.checks.find(({ id }) => id === 'ownership_actor');
  const creator = { id: 'member-creator', user_id: 'u-creator', email: 'creator@firm.example', role: 'admin', status: 'active', access_level: 'owner' };
  const colleague = { id: 'member-colleague', user_id: 'u-colleague', email: 'colleague@firm.example', role: 'admin', status: 'active', access_level: 'owner' };

  // Birth: the creator must be active at birth, whoever else exists.
  assert.equal(ownership(evaluate(withMembers([creator]), 'birth_residue_proof')).status, 'PASS');
  const birthWithoutCreator = ownership(evaluate(withMembers([{ ...creator, status: 'inactive' }, colleague]), 'birth_residue_proof'));
  assert.equal(birthWithoutCreator.status, 'FAIL');
  assert.deepEqual(birthWithoutCreator.detail.failures, ['initiating_firm_member_not_active']);

  // Current generation: the creator leaving is fine while a colleague remains…
  const survived = ownership(evaluate(withMembers([{ ...creator, status: 'inactive' }, colleague]), 'current_generation_compatibility'));
  assert.equal(survived.status, 'PASS', JSON.stringify(survived.detail));
  assert.equal(survived.detail.initiating_member_status, 'inactive');
  assert.deepEqual(survived.detail.current_firm_authority, { active_member_ids: ['member-colleague'], basis: 'active_firm_members' });
  assert.deepEqual(survived.detail.initiating_principal, { actor_type: 'firm_member', actor_id: 'member-creator' }, 'the historical creator receipt is preserved, not rewritten');
  // …and a deleted creator row is the same case.
  assert.equal(ownership(evaluate(withMembers([colleague]), 'current_generation_compatibility')).status, 'PASS');
  // …but a firm with no active member at all has no current authority.
  const orphaned = ownership(evaluate(withMembers([{ ...creator, status: 'inactive' }, { ...colleague, status: 'inactive' }]), 'current_generation_compatibility'));
  assert.equal(orphaned.status, 'FAIL');
  assert.deepEqual(orphaned.detail.failures, ['firm_authority_absent']);
  // The receipt itself is still validated: a laundered actor still fails.
  const laundered = withMembers([colleague]);
  laundered.creation_receipts[0].metadata.authority_basis.principal_id = 'member-colleague';
  assert.ok(ownership(evaluate(laundered, 'current_generation_compatibility')).detail.failures.includes('creation_authority_basis_mismatch'));
});


test('firm-owned books allow shared legal identity across firms but never a shared book id', async () => {
  const base = await fixture();
  const memberProfile = resolveAdmittedEntityProfile({ manifest: base.manifest,
    profileId: 'gb-ltd.desktop-firm-intake.desktop.none.management-books.v2' });
  const evaluate = (admittedProfile, collision) => {
    const snapshot = deepClone(base.snapshot);
    snapshot.cross_firm_collisions = [collision];
    return evaluateEntityCertificateB({ manifest: base.manifest, manifestDigest: base.digest, admittedProfile,
      hostCertificate: hostCertificate(), packManifest: base.packManifest, snapshot,
      firmId: FIRM_ID, clientId: CLIENT_ID, observedAt: '2026-08-29T10:00:00.000Z'
    }).checks.find(({ id }) => id === 'firm_isolation');
  };
  const sharedCompany = { id: 'another-firms-book', firm_id: 'another-firm',
    uen: base.snapshot.client.uen, email: base.snapshot.client.profile.email };
  assert.equal(evaluate(memberProfile, sharedCompany).status, 'PASS');
  assert.equal(evaluate(memberProfile, { ...sharedCompany, id: CLIENT_ID }).status, 'FAIL');
  assert.equal(evaluate(base.admittedProfile, sharedCompany).status, 'FAIL', 'owner-adoption isolation remains strict');
});


test('permanent Jev desktop enrollment is a required baseline dependency', async () => {
  const base = await fixture();
  const evaluate = snapshot => evaluateEntityCertificateB({manifest:base.manifest,manifestDigest:base.digest,
    admittedProfile:base.admittedProfile,hostCertificate:hostCertificate(),packManifest:base.packManifest,
    snapshot,firmId:FIRM_ID,clientId:CLIENT_ID,observedAt:'2026-08-29T10:00:00.000Z'});
  assert.equal(evaluate(deepClone(base.snapshot)).status, 'PASS');
  const missing = deepClone(base.snapshot);
  missing.live_flags = missing.live_flags.filter(row => row.flag_key !== 'JEV_RECONCILIATION');
  const result = evaluate(missing);
  assert.equal(result.status, 'FAIL');
  assert.ok(result.checks.find(({id}) => id === 'client_capabilities').detail.failures
    .includes('required_capability_missing:JEV_RECONCILIATION'));
});

test('manual correction and owner-transfer grants are optional desktop capabilities with closed postures', async () => {
  const base = await fixture();
  const evaluate = snapshot => evaluateEntityCertificateB({manifest:base.manifest,manifestDigest:base.digest,
    admittedProfile:base.admittedProfile,hostCertificate:hostCertificate(),packManifest:base.packManifest,
    snapshot,firmId:FIRM_ID,clientId:CLIENT_ID,observedAt:'2026-08-29T10:00:00.000Z'});
  const baseline = evaluate(deepClone(base.snapshot));
  for (const flagKey of ['CODING_CORRECTION_AUTO_APPLY','CODING_OWNER_TRANSFER_POST']) {
    assert.ok(!DESKTOP_CLIENT_FLAG_SEEDS.includes(flagKey));
    assert.ok(!base.manifest.capability_manifests['desktop-runtime.v2'].required_baseline.some(row=>row.flag_key===flagKey));
    const enrolled = (stage,source='manual',reason='Synthetic exact-client correction authority') => {
      const snapshot = deepClone(base.snapshot);
      snapshot.live_flags.push({id:`flag-${flagKey}`,flag_key:flagKey,stage,source,reason});
      snapshot.client_table_counts.client_capability_config += 1;
      return evaluate(snapshot);
    };
    for (const stage of ['off','dry_run','shadow','canary','auto']) {
      const result = enrolled(stage);
      assert.equal(result.status,'PASS',`${flagKey}/${stage}: ${JSON.stringify(result.checks)}`);
      assert.equal(result.entity_dependency_digest,baseline.entity_dependency_digest);
    }
    for (const args of [['canary','default'],['canary','manual',''],['unknown']]) {
      const result = enrolled(...args);
      assert.equal(result.status,'FAIL');
      assert.ok(result.checks.find(({id})=>id==='client_capabilities').detail.failures
        .includes(`admitted_extension_posture_mismatch:${flagKey}`));
    }
  }
});

test('SG cloud review admits only its exact firm-member profile and closed non-posting baseline', async () => {
  const { manifest } = await loadAdmittedEntityProfileManifest({ rootDir: ROOT });
  const profile = manifest.profiles.find(p => p.capability_manifest_version === 'sg-cloud-review.v1');
  assert.equal(profile.runtime_host, 'vercel');
  assert.equal(profile.jurisdiction, 'SG');
  assert.equal(profile.canonical_legal_form, 'sg-pte');
  assert.equal(profile.admission_scope, 'document_processing_review_only');
  for (const patch of [{ runtime_host: 'desktop' }, { jurisdiction: 'FI' },
    { profile_id: 'sg-review-renamed' }, { capability_manifest_version: 'desktop-runtime.v2' },
    { runtime_host: 'desktop', profile_id: 'sg-review-renamed' },
    { runtime_host: 'desktop', capability_manifest_version: 'desktop-runtime.v2', chart_contract_version: 'fi-pack-v8' },
    { canonical_legal_form: 'sg-llp' }, { creation_path: 'self_provision' },
    { principal_contract: 'self_serve_owner' }, { accounting_adapter: 'xero' }, { chart_contract_version: 'fi-pack-v8' }]) {
    const changed = structuredClone(manifest);
    Object.assign(changed.profiles.find(p => p.profile_id === profile.profile_id), patch);
    assert.equal(validateAdmittedEntityProfileManifest(changed).valid, false, JSON.stringify(patch));
  }
  for (const flag of ['CODING_AUTO_POST', 'LEDGER_AUTO_POST', 'OUTBOUND_INVOICING', 'JEV_RECONCILIATION']) {
    const changed = structuredClone(manifest);
    changed.capability_manifests['sg-cloud-review.v1'].required_baseline.find(row => row.flag_key === flag).stage = 'canary';
    assert.equal(validateAdmittedEntityProfileManifest(changed).valid, false, flag);
  }
  const bypass = structuredClone(manifest); bypass.chart_contracts['sg-legacy-palette-v1'].persisted_chart = 'none';
  assert.equal(validateAdmittedEntityProfileManifest(bypass).valid, false);
});


test('native SG profile is a separate verified 58-row processing contract with unchanged non-posting stages', async () => {
  const { manifest } = await fixture();
  const native = manifest.profiles.find(p => p.capability_manifest_version === 'sg-native-cloud-review.v1');
  const legacy = manifest.profiles.find(p => p.capability_manifest_version === 'sg-cloud-review.v1');
  assert.equal(native.chart_contract_version, 'sg-native-processing-v1');
  assert.equal(legacy.chart_contract_version, 'sg-legacy-palette-v1');
  assert.deepEqual(manifest.capability_manifests[native.capability_manifest_version].required_baseline,
    manifest.capability_manifests[legacy.capability_manifest_version].required_baseline);
  for (const mutate of [
    m => { m.chart_contracts['sg-native-processing-v1'].native_lineage_required = false; },
    m => { m.chart_contracts['sg-native-processing-v1'].persisted_chart = 'sg_legacy_palette.v1'; },
    m => { m.capability_manifests['sg-native-cloud-review.v1'].required_baseline.find(r => r.flag_key === 'LEDGER_AUTO_POST').stage = 'canary'; },
    m => { m.profiles.find(p => p.profile_id === native.profile_id).admission_scope = 'accounting'; },
    m => { delete m.assignment_contracts; },
    m => { delete m.profiles.find(p => p.profile_id === native.profile_id).assignment_contract_version; },
    m => { m.profiles.find(p => p.profile_id === legacy.profile_id).assignment_contract_version = native.assignment_contract_version; },
    m => { m.assignment_contracts[native.assignment_contract_version].current_generation.role = 'viewer'; },
    m => { m.assignment_contracts.extra = m.assignment_contracts[native.assignment_contract_version]; }
  ]) {
    const changed = structuredClone(manifest); mutate(changed);
    assert.equal(validateAdmittedEntityProfileManifest(changed).valid, false);
  }
});

test('native assignment lifecycle keeps birth zero, classifies history and binds persisted windows without widening legacy counts', async () => {
  const base = await fixture();
  const { manifest } = base;
  const native = manifest.profiles.find(p => p.capability_manifest_version === 'sg-native-cloud-review.v1');
  const assignment = { id: 'native-owner-assignment', firm_id: FIRM_ID, client_id: CLIENT_ID,
    principal_type: 'firm_collaborator', principal_id: 'native-owner', assignment_kind: 'capability', role: 'owner',
    access_level: 'client_scoped', status: 'active', starts_at: null, ends_at: null };
  const principal = { id: 'native-owner', firm_id: FIRM_ID, user_id: 'native-owner-user', email: 'owner@fixture.invalid',
    status: 'active', access_level: 'client_scoped', starts_at: null, ends_at: null };
  const snapshot = { ...base.snapshot, assignments: [assignment], firm_collaborators: [principal],
    live_flags: manifest.capability_manifests[native.capability_manifest_version].required_baseline,
    ledger_accounts: [] };
  const evaluate = (overrides = {}) => evaluateEntityCertificateB({ ...base, admittedProfile: native, snapshot,
    firmId: FIRM_ID, clientId: CLIENT_ID, hostCertificate: hostCertificate(),
    compatibilityScope: 'current_generation_compatibility', observedAt: '2026-08-29T10:00:00.000Z', ...overrides });
  const count = certificate => certificate.checks.find(row => row.id === 'expected_row_counts').detail;
  // Other checks deliberately reject this non-native chart fixture. Only the
  // structural assignment contract is under unit test; real-PG proves whole PASS.
  const initial = evaluate(), healthy = count(initial);
  assert.deepEqual(healthy.assignments, { contract_version: native.assignment_contract_version,
    scope: 'current_generation_compatibility', actual: 1, validated_current: 1, validated_historical: 0, invalid: 0 });
  assert.ok(!healthy.failures.some(code => code.startsWith('assignment_')));
  const birth = count(evaluate({ compatibilityScope: 'birth_residue_proof' }));
  assert.equal(birth.assignments.expected, 0);
  assert.ok(birth.failures.includes('assignment_count_mismatch'));
  assert.equal(count(evaluate({ snapshot: { ...snapshot, assignments: [] } })).assignments.actual, 0);
  for (const mutate of [
    s => { s.assignments[0].status = 'proposed'; },
    s => { s.assignments[0].status = 'suspended'; },
    s => { s.assignments[0].status = 'ended'; },
    s => { s.assignments[0].starts_at = '2026-08-30T00:00:00Z'; },
    s => { s.assignments[0].ends_at = '2026-08-28T00:00:00Z'; },
    s => { s.firm_collaborators[0].status = 'inactive'; },
    s => { s.firm_collaborators[0].ends_at = '2026-08-28T00:00:00Z'; }
  ]) {
    const changed = structuredClone(snapshot); mutate(changed); const receipt = evaluate({ snapshot: changed });
    assert.equal(count(receipt).assignments.validated_current, 0);
    assert.equal(count(receipt).assignments.validated_historical, 1);
    assert.ok(!count(receipt).failures.some(code => code.startsWith('assignment_')));
    assert.notEqual(receipt.entity_dependency_digest, initial.entity_dependency_digest);
  }
  for (const mutate of [
    s => { s.assignments[0].firm_id = 'foreign'; },
    s => { s.assignments[0].client_id = 'foreign'; },
    s => { s.assignments[0].principal_type = 'agent'; },
    s => { s.assignments[0].assignment_kind = 'specialist_role'; },
    s => { s.assignments[0].role = 'viewer'; },
    s => { s.assignments[0].access_level = 'all'; },
    s => { s.assignments[0].status = 'unknown'; },
    s => { s.assignments[0].id = ''; },
    s => { s.assignments[0].starts_at = 'not-a-time'; },
    s => { s.assignments[0].starts_at = '2026-08-30'; s.assignments[0].ends_at = '2026-08-29'; },
    s => { s.assignments.push({ ...s.assignments[0], id: 'duplicate-principal' }); },
    s => { s.firm_collaborators = []; },
    s => { s.firm_collaborators[0].firm_id = 'foreign'; },
    s => { s.firm_collaborators[0].user_id = ''; s.firm_collaborators[0].email = ''; },
    s => { s.firm_collaborators[0].ends_at = 'not-a-time'; },
    s => { s.firm_collaborators[0].starts_at = '2026-08-30'; s.firm_collaborators[0].ends_at = '2026-08-29'; }
  ]) {
    const changed = structuredClone(snapshot); mutate(changed);
    assert.ok(count(evaluate({ snapshot: changed })).failures.includes('assignment_lifecycle_shape_invalid'));
  }
  for (const observedAt of ['', 'invalid', 'Infinity']) {
    assert.ok(count(evaluate({ observedAt })).failures.includes('assignment_observation_time_invalid'));
  }
  const legacy = manifest.profiles.find(p => p.profile_id.includes('sg-pte') && p.capability_manifest_version === 'sg-cloud-review.v1');
  assert.deepEqual(count(evaluate({ admittedProfile: legacy })).assignments, { expected: 0, actual: 1 });
  assert.deepEqual(count(evaluate({ admittedProfile: base.admittedProfile })).assignments, { expected: 1, actual: 1 });
  const legacyBefore = evaluate({ admittedProfile: base.admittedProfile });
  const timeChanged = structuredClone(snapshot); timeChanged.assignments[0].ends_at = '2026-08-28T00:00:00Z';
  assert.equal(evaluate({ admittedProfile: base.admittedProfile, snapshot: timeChanged }).entity_dependency_digest,
    legacyBefore.entity_dependency_digest, 'legacy dependency bytes do not gain native-only windows');
});

test('US hosted pilot: one exact cloud profile and an exact gross-only manifest (2026-10-01)', async () => {
  const { manifest } = await fixture();
  const us = manifest.profiles.filter(profile => profile.jurisdiction === 'US' && profile.runtime_host === 'vercel');
  assert.deepEqual(us.map(profile => profile.profile_id), ['us-llc.firm-intake.vercel.none.management-books.us-cloud-pilot-v1']);
  const baseline = manifest.capability_manifests['us-cloud-pilot.v1'].required_baseline;
  assert.equal(baseline.find(row => row.flag_key === 'JURISDICTION_TAX_CODING').stage, 'off', 'US books are gross-only');
  assert.ok(baseline.every(row => row.reason === 'donna.us-hosted-pilot.v1' && row.source === 'manual'));
  assert.ok(!baseline.some(row => /^FINLAND_|FISCAL_PERIOD_INTAKE/.test(row.flag_key)), 'no Finnish flag rides the US baseline');

  const loosened = structuredClone(manifest);
  loosened.capability_manifests['us-cloud-pilot.v1'].required_baseline
    .find(row => row.flag_key === 'JURISDICTION_TAX_CODING').stage = 'auto';
  assert.match(validateAdmittedEntityProfileManifest(loosened).errors.join('|'), /US hosted pilot must retain its exact gross-only baseline/);

  const widened = structuredClone(manifest);
  widened.capability_manifests['us-cloud-pilot.v1'].admitted_extensions.push(
    { flag_key: 'FISCAL_PERIOD_INTAKE', allowed_stages: ['canary'], allowed_sources: ['manual'], reason_required: true });
  assert.match(validateAdmittedEntityProfileManifest(widened).errors.join('|'), /US hosted pilot must retain/);

  const moved = structuredClone(manifest);
  Object.assign(moved.profiles.find(profile => profile.profile_id === us[0].profile_id), { canonical_legal_form: 'us-c-corp' });
  assert.match(validateAdmittedEntityProfileManifest(moved).errors.join('|'), /US hosted pilot must retain its exact cloud profile coordinate/);

  const resolved = resolveAdmittedEntityProfile({ manifest, coordinate: {
    jurisdiction: 'US', canonical_legal_form: 'us-llc', creation_path: 'desktop_firm_intake', runtime_host: 'vercel',
    accounting_adapter: 'none', accounting_view: 'management_books', capability_manifest_version: 'us-cloud-pilot.v1' } });
  assert.equal(resolved.profile_id ?? resolved.profile?.profile_id, us[0].profile_id);
});
