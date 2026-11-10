// Entity Certificate B (Gate 1A).
//
// This is deliberately an OBSERVER. It re-reads one entity's persisted birth
// state, compares it with the versioned admitted-profile contract, and emits a
// deterministic PASS / FAIL / INCOMPLETE receipt. It does not persist
// readiness, change a client capability, or admit/block product work; those
// enforcement semantics belong to Gate 1B.

import { readAccountingProfile, readAccountingCurrency, accountingProfileFailures, ACCOUNTING_ADMISSION_CONTRACT } from '../../src/lib/accountingProfile.js';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { resolveProvisioningCertificateChart } from './provisioningPolicyRegistry.js';
import { nativeAccountProjection, nativeBirthAccounts, readNativeChartObservation, verifyNativeChartObservation, readNativeRegistrationEvidence } from './nativeChartLineage.js';
import {
  HOST_CERTIFICATE_A_VERSION,
  HOST_COMPATIBILITY_CONTRACT_VERSION,
  evaluateHostCertificateFreshness,
  hostCompatibilityDigest,
  hostDigest
} from './hostCertificateA.js';
import { CONFIG_STAGES, ENTITY_READINESS_ADMISSION_FLAG } from './clientConfig.js';
import { DESKTOP_CLIENT_FLAG_SEEDS, DESKTOP_SEED_REASON } from './desktop/hostPlaneSeed.js';
import { readConsumedOwnerAdoptionWithClient } from './existingOwnerRevalidation.js';
import { CLOUD_RUNTIME_HOST } from './runtimeHostIdentity.js';
import { US_HOSTED_PROFILE_ID, US_HOSTED_CAPABILITY_MANIFEST, US_HOSTED_PILOT_STAGES, hostedMarketProfileFor, SG_HOSTED_PROFILE_ID, SG_HOSTED_CAPABILITY_MANIFEST, SG_HOSTED_REVIEW_STAGES, SG_NATIVE_PROFILE_ID, SG_NATIVE_CAPABILITY_MANIFEST, SG_NATIVE_PROCESSING_REVIEW_FLAG } from './cloudPilotConfig.js';
import { SG_HOSTED_REVIEW_VERSION, US_HOSTED_PILOT_VERSION } from './internalPilotAccess.js';
import { fallbackAccountsForPack } from './outbound/packs.js';
import { __ledgerAccountMintShape } from './db/ledger.js';

export const ENTITY_CERTIFICATE_B_VERSION = 'donna.entity-certificate-b.v3';
export const ENTITY_DEPENDENCY_DIGEST_VERSION = 'donna.entity-dependency-digest.v2';
export const ADMITTED_ENTITY_PROFILE_MANIFEST_PATH = 'data/worlds/admitted-entity-profiles.json';
export const ENTITY_CERTIFICATE_STATUSES = Object.freeze(['PASS', 'FAIL', 'INCOMPLETE']);
export const ENTITY_COMPATIBILITY_SCOPES = Object.freeze([
  'birth_residue_proof',
  'current_generation_compatibility'
]);

const PROFILE_COORDINATE_FIELDS = Object.freeze([
  'jurisdiction',
  'canonical_legal_form',
  'creation_path',
  'runtime_host',
  'accounting_adapter',
  'accounting_view',
  'capability_manifest_version'
]);

const EXPECTED_CLIENT_TABLES = new Set([
  'audit_events',
  'client_assignments',
  'client_capability_config',
  // Gate 1B's own plane-S row is certification state, never prior business
  // residue. It exists on retry/reset observations by design.
  'entity_readiness_sagas',
  'ledger_accounts',
  // A desktop intake births the client WITH its initial work queue in the
  // same createClientInDb transaction, so queue rows are birth equipment.
  // Prior-generation queue residue cannot reach here: queue_items.client_id
  // cascades on client delete (001_firm_core.sql).
  'queue_items',
  // Finnish birth equipment (2026-09-08, the first FI entity on the desktop):
  // FI_CLIENT_LIFECYCLE (finland/clientLifecycle.js) identifies the legal form
  // at creation and mints the annual-return quarantine blocker for an Oy in
  // the same second the client is born, before the birth certificate runs.
  // A jurisdiction's own statutory duty record is what the pack requires, not
  // prior business residue — the engine follows the pack. Prior-generation
  // rows cannot reach here: statutory_blockers.client_id cascades on client
  // delete and the events cascade on the blocker (076_finland_statutory_blockers.sql).
  'statutory_blockers',
  'statutory_blocker_events'
]);
const NATIVE_ASSIGNMENT_CONTRACT_VERSION = 'sg-native-owner-capability.v1';
const NATIVE_ASSIGNMENT_CONTRACT = Object.freeze({
  birth_count: 0,
  current_generation: {
    assignment_kind: 'capability', principal_type: 'firm_collaborator', role: 'owner', access_level: 'client_scoped',
    statuses: ['proposed', 'active', 'suspended', 'ended'],
    principal_link: 'same_firm_human_collaborator', historical_rows: 'retain_without_authority'
  }
});
const CAPABILITY_SOURCES = new Set(['default', 'cohort', 'manual', 'emergency_override']);

const clean = (value) => String(value ?? '').trim();
const sorted = (values) => [...values].sort((a, b) => String(a).localeCompare(String(b)));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const check = (id, status, detail) => ({ id, status, detail });
const overallStatus = (checks) => {
  if (checks.some(({ status }) => status === 'FAIL')) return 'FAIL';
  if (checks.some(({ status }) => status === 'INCOMPLETE')) return 'INCOMPLETE';
  return 'PASS';
};

// Gate 1B persists one saga row per legal entity. Profile changes and retries
// are dependency changes inside that saga, not new identities; otherwise a
// correction could silently abandon the earlier attempt trail. The profile is
// still load-bearing in the dependency digest and every attempt receipt.
export const entityProvisioningSagaIdentity = ({ firmId, clientId } = {}) => {
  const cleanFirmId = clean(firmId);
  const cleanClientId = clean(clientId);
  if (!cleanFirmId || !cleanClientId) throw new Error('Entity provisioning saga identity needs firmId and clientId.');
  return {
    sagaId: `entity-saga-${sha256(`${cleanFirmId}|${cleanClientId}`).slice(0, 24)}`,
    idempotencyKey: `entity-birth:${cleanFirmId}:${cleanClientId}`
  };
};

const exactCoordinate = (profile) => Object.fromEntries(
  PROFILE_COORDINATE_FIELDS.map((field) => [field, profile?.[field] ?? null])
);

export class UndeclaredEntityProfileError extends Error {
  constructor(coordinate) {
    super(`Entity profile is not declared in the admitted-profile manifest: ${JSON.stringify(exactCoordinate(coordinate))}`);
    this.name = 'UndeclaredEntityProfileError';
    this.code = 'ENTITY_PROFILE_UNDECLARED';
    this.statusCode = 422;
    this.details = { coordinate: exactCoordinate(coordinate) };
  }
}

const validateRequiredString = (value, label, errors) => {
  if (!clean(value)) errors.push(`${label} must be a non-empty string`);
};

export const validateAdmittedEntityProfileManifest = (manifest) => {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { valid: false, errors: ['manifest must be an object'] };
  }
  validateRequiredString(manifest.version, 'version', errors);
  if (manifest.mode !== 'observe_only') errors.push('mode must be observe_only for Gate 1A');
  if (!manifest.capability_manifests || typeof manifest.capability_manifests !== 'object') {
    errors.push('capability_manifests must be an object');
  }
  if (!manifest.chart_contracts || typeof manifest.chart_contracts !== 'object') {
    errors.push('chart_contracts must be an object');
  }
  if (!Array.isArray(manifest.profiles) || !manifest.profiles.length) errors.push('profiles must be a non-empty array');

  for (const [version, contract] of Object.entries(manifest.capability_manifests || {})) {
    const required = contract?.required_baseline;
    const extensions = contract?.admitted_extensions;
    if (!Array.isArray(required) || !required.length) {
      errors.push(`${version}.required_baseline must be a non-empty array`);
    }
    if (!Array.isArray(extensions)) errors.push(`${version}.admitted_extensions must be an array`);
    const keys = new Set();
    for (const [index, row] of (required || []).entries()) {
      validateRequiredString(row?.flag_key, `${version}.required_baseline[${index}].flag_key`, errors);
      validateRequiredString(row?.stage, `${version}.required_baseline[${index}].stage`, errors);
      validateRequiredString(row?.source, `${version}.required_baseline[${index}].source`, errors);
      validateRequiredString(row?.reason, `${version}.required_baseline[${index}].reason`, errors);
      if (!CONFIG_STAGES.includes(row?.stage)) errors.push(`${version}.required_baseline[${index}] has an unknown stage`);
      if (!CAPABILITY_SOURCES.has(row?.source)) errors.push(`${version}.required_baseline[${index}] has an unknown source`);
      if (keys.has(row?.flag_key)) errors.push(`${version} repeats capability key ${row.flag_key}`);
      keys.add(row?.flag_key);
    }
    for (const [index, row] of (extensions || []).entries()) {
      validateRequiredString(row?.flag_key, `${version}.admitted_extensions[${index}].flag_key`, errors);
      if (!Array.isArray(row?.allowed_stages) || !row.allowed_stages.length
        || row.allowed_stages.some((stage) => !CONFIG_STAGES.includes(stage))) {
        errors.push(`${version}.admitted_extensions[${index}].allowed_stages must name known stages`);
      }
      if (!Array.isArray(row?.allowed_sources) || !row.allowed_sources.length
        || row.allowed_sources.some((source) => !CAPABILITY_SOURCES.has(source))) {
        errors.push(`${version}.admitted_extensions[${index}].allowed_sources must name known sources`);
      }
      if (row?.profile_scope && (Object.keys(row.profile_scope).sort().join(',') !== 'accounting_view,canonical_legal_form,jurisdiction'
          || Object.values(row.profile_scope).some((value) => !clean(value)))) errors.push(`${version} extension profile_scope must name an exact jurisdiction, legal form and accounting view`);
      if (row?.reason_required !== true) errors.push(`${version}.admitted_extensions[${index}].reason_required must be true`);
      if (keys.has(row?.flag_key)) errors.push(`${version} repeats capability key ${row.flag_key}`);
      keys.add(row?.flag_key);
    }
  }

  if (hostDigest(manifest.accounting_admission_contract) !== hostDigest(ACCOUNTING_ADMISSION_CONTRACT)) errors.push('accounting admission contract must match the reviewed technical birth contract');

  const sgReview = manifest.capability_manifests?.[SG_HOSTED_CAPABILITY_MANIFEST];
  if (sgReview) {
    const expected = Object.entries(SG_HOSTED_REVIEW_STAGES).map(([flag_key, stage]) => ({
      flag_key, stage, source: 'manual', reason: SG_HOSTED_REVIEW_VERSION
    })).sort((a, b) => a.flag_key.localeCompare(b.flag_key));
    const declared = [...(sgReview.required_baseline || [])].sort((a, b) => a.flag_key.localeCompare(b.flag_key));
    if (hostDigest(expected) !== hostDigest(declared) || sgReview.admitted_extensions?.length !== 0) {
      errors.push('Singapore document review must retain its exact non-posting capability baseline');
    }
    const chart = manifest.chart_contracts?.['sg-legacy-palette-v1'];
    if (chart?.pack_id !== 'sg' || chart?.home_currency !== 'SGD' || chart?.persisted_chart !== 'sg_legacy_palette.v1') {
      errors.push('Singapore document review requires its exact legacy palette chart contract');
    }
  }

  const sgNative = manifest.capability_manifests?.[SG_NATIVE_CAPABILITY_MANIFEST];
  if (sgNative) {
    const expected = Object.entries(SG_HOSTED_REVIEW_STAGES).map(([flag_key, stage]) => ({
      flag_key, stage, source: 'manual', reason: SG_HOSTED_REVIEW_VERSION
    })).sort((a, b) => a.flag_key.localeCompare(b.flag_key));
    const extensions = [{ flag_key: SG_NATIVE_PROCESSING_REVIEW_FLAG,
      allowed_stages: ['off', 'dry_run', 'shadow', 'canary', 'auto'],
      allowed_sources: ['manual', 'emergency_override'], reason_required: true }];
    const chart = manifest.chart_contracts?.['sg-native-processing-v1'];
    if (hostDigest(expected) !== hostDigest([...(sgNative.required_baseline || [])].sort((a, b) => a.flag_key.localeCompare(b.flag_key)))
      || hostDigest(extensions) !== hostDigest(sgNative.admitted_extensions)
      || chart?.pack_id !== 'sg' || chart?.home_currency !== 'SGD'
      || chart?.persisted_chart !== 'sg_pte_native.v1' || chart?.native_lineage_required !== true) {
      errors.push('Singapore native review requires its exact non-posting baseline and verified native chart contract');
    }
  }

  // US hosted pilot: its exact gross-only baseline, and exactly the Finnish
  // cloud processing extensions minus the Finnish fiscal-period intake.
  const usPilot = manifest.capability_manifests?.[US_HOSTED_CAPABILITY_MANIFEST];
  if (usPilot) {
    const expected = Object.entries(US_HOSTED_PILOT_STAGES).map(([flag_key, stage]) => ({
      flag_key, stage, source: 'manual', reason: US_HOSTED_PILOT_VERSION
    })).sort((a, b) => a.flag_key.localeCompare(b.flag_key));
    const declared = [...(usPilot.required_baseline || [])].sort((a, b) => a.flag_key.localeCompare(b.flag_key));
    const extensions = (manifest.capability_manifests?.['fi-cloud-pilot.v1']?.admitted_extensions || [])
      .filter(({ flag_key }) => flag_key !== 'FISCAL_PERIOD_INTAKE');
    if (hostDigest(expected) !== hostDigest(declared) || !extensions.length
      || hostDigest(extensions) !== hostDigest(usPilot.admitted_extensions)) {
      errors.push('US hosted pilot must retain its exact gross-only baseline and the cloud processing extensions');
    }
  }

  if ((sgNative || manifest.assignment_contracts) && hostDigest(manifest.assignment_contracts || null)
    !== hostDigest({ [NATIVE_ASSIGNMENT_CONTRACT_VERSION]: NATIVE_ASSIGNMENT_CONTRACT })) {
    errors.push('Singapore native review requires its exact owner assignment lifecycle contract');
  }

  const ids = new Set();
  const coordinates = new Set();
  for (const [index, profile] of (manifest.profiles || []).entries()) {
    const singaporeNativeReview = profile.profile_id === SG_NATIVE_PROFILE_ID
      && profile.runtime_host === CLOUD_RUNTIME_HOST
      && profile.jurisdiction === 'SG' && profile.canonical_legal_form === 'sg-pte'
      && profile.creation_path === 'desktop_firm_intake' && profile.principal_contract === 'firm_member'
      && profile.accounting_view === 'management_books' && profile.accounting_adapter === 'none'
      && profile.capability_manifest_version === SG_NATIVE_CAPABILITY_MANIFEST
      && profile.chart_contract_version === 'sg-native-processing-v1'
      && profile.admission_scope === 'document_processing_review_only'
      && hostDigest(profile.required_provider_classes || null) === hostDigest(['openai', 'anthropic']);
    if (!singaporeNativeReview && (profile.profile_id === SG_NATIVE_PROFILE_ID
      || profile.capability_manifest_version === SG_NATIVE_CAPABILITY_MANIFEST
      || profile.chart_contract_version === 'sg-native-processing-v1')) {
      errors.push('Singapore native review must retain its exact cloud profile coordinate');
    }
    if (singaporeNativeReview ? profile.assignment_contract_version !== NATIVE_ASSIGNMENT_CONTRACT_VERSION
      : Object.hasOwn(profile, 'assignment_contract_version')) {
      errors.push('Only the exact Singapore native review profile may bind its required assignment contract');
    }
    const singaporeReview = profile.profile_id === SG_HOSTED_PROFILE_ID
      && profile.runtime_host === CLOUD_RUNTIME_HOST
      && profile.jurisdiction === 'SG' && profile.canonical_legal_form === 'sg-pte'
      && profile.creation_path === 'desktop_firm_intake' && profile.principal_contract === 'firm_member'
      && profile.accounting_view === 'management_books' && profile.accounting_adapter === 'none'
      && profile.capability_manifest_version === SG_HOSTED_CAPABILITY_MANIFEST
      && profile.chart_contract_version === 'sg-legacy-palette-v1'
      && profile.admission_scope === 'document_processing_review_only'
      && hostDigest(profile.required_provider_classes || null) === hostDigest(['openai', 'anthropic']);
    if (!singaporeReview && (profile.profile_id === SG_HOSTED_PROFILE_ID
      || profile.capability_manifest_version === SG_HOSTED_CAPABILITY_MANIFEST
      || profile.chart_contract_version === 'sg-legacy-palette-v1')) {
      errors.push('Singapore document review must retain its exact cloud profile coordinate');
    }
    const usHostedPilot = profile.profile_id === US_HOSTED_PROFILE_ID
      && profile.runtime_host === CLOUD_RUNTIME_HOST
      && profile.jurisdiction === 'US' && profile.canonical_legal_form === 'us-llc'
      && profile.creation_path === 'desktop_firm_intake' && profile.principal_contract === 'firm_member'
      && profile.accounting_view === 'management_books' && profile.accounting_adapter === 'none'
      && profile.capability_manifest_version === US_HOSTED_CAPABILITY_MANIFEST
      && profile.chart_contract_version === 'us-pack-v6'
      && profile.admission_scope === 'technical_hosted_pilot_observation_only'
      && hostDigest(profile.required_provider_classes || null) === hostDigest(['openai', 'anthropic']);
    if (!usHostedPilot && (profile.profile_id === US_HOSTED_PROFILE_ID
      || profile.capability_manifest_version === US_HOSTED_CAPABILITY_MANIFEST)) {
      errors.push('US hosted pilot must retain its exact cloud profile coordinate');
    }
    if (profile.runtime_host === CLOUD_RUNTIME_HOST && !singaporeReview && !singaporeNativeReview && !usHostedPilot && (profile.jurisdiction !== 'FI'
      || profile.canonical_legal_form !== 'fi-oy'
      || !((profile.creation_path === 'self_provision' && profile.principal_contract === 'self_serve_owner')
        || (profile.creation_path === 'desktop_firm_intake' && profile.principal_contract === 'firm_member' && profile.accounting_view === 'management_books')
        || (profile.creation_path === 'existing_owner_adoption' && profile.principal_contract === 'revalidated_existing_owner' && profile.accounting_view === 'management_books'))
      || profile.accounting_adapter !== 'none' || profile.capability_manifest_version !== 'fi-cloud-pilot.v1'
      || hostDigest(profile.required_provider_classes || null) !== hostDigest(['openai', 'anthropic']))) {
      errors.push('cloud pilot profile must retain its exact technical scope and both required providers');
    }
    if ((profile.creation_path==='existing_owner_adoption' || profile.principal_contract==='revalidated_existing_owner')
      && !(profile.runtime_host===CLOUD_RUNTIME_HOST && profile.jurisdiction==='FI' && profile.canonical_legal_form==='fi-oy'
        && profile.creation_path==='existing_owner_adoption' && profile.principal_contract==='revalidated_existing_owner'
        && profile.accounting_adapter==='none' && profile.accounting_view==='management_books'
        && profile.capability_manifest_version==='fi-cloud-pilot.v1')) errors.push('owner adoption must retain its exact cloud profile pair');
    if (!ACCOUNTING_ADMISSION_CONTRACT.admitted_views.includes(profile?.accounting_view)) errors.push('unsupported accounting view cannot be admitted');
    validateRequiredString(profile?.profile_id, `profiles[${index}].profile_id`, errors);
    for (const field of PROFILE_COORDINATE_FIELDS) {
      validateRequiredString(profile?.[field], `profiles[${index}].${field}`, errors);
    }
    validateRequiredString(profile?.chart_contract_version, `profiles[${index}].chart_contract_version`, errors);
    validateRequiredString(profile?.principal_contract, `profiles[${index}].principal_contract`, errors);
    if (ids.has(profile?.profile_id)) errors.push(`duplicate profile_id ${profile.profile_id}`);
    ids.add(profile?.profile_id);
    const coordinate = hostDigest(exactCoordinate(profile));
    if (coordinates.has(coordinate)) errors.push(`duplicate admitted coordinate ${profile.profile_id}`);
    coordinates.add(coordinate);
    if (!manifest.capability_manifests?.[profile?.capability_manifest_version]) {
      errors.push(`${profile?.profile_id || index} references an unknown capability manifest`);
    }
    if (!manifest.chart_contracts?.[profile?.chart_contract_version]) {
      errors.push(`${profile?.profile_id || index} references an unknown chart contract`);
    }
  }

  const desktopContract = manifest.capability_manifests?.['desktop-runtime.v2'];
  if (desktopContract) {
    const declared = (desktopContract.required_baseline || [])
      .map((row) => `${row.flag_key}|${row.stage}|${row.source}|${row.reason}`)
      .sort();
    const runtime = DESKTOP_CLIENT_FLAG_SEEDS
      .map((flagKey) => `${flagKey}|auto|default|${DESKTOP_SEED_REASON}`)
      .sort();
    if (hostDigest(declared) !== hostDigest(runtime)) {
      errors.push('desktop-runtime.v2 required baseline does not match the production desktop seed contract');
    }
    const readinessExtension = (desktopContract.admitted_extensions || [])
      .find(({ flag_key }) => flag_key === ENTITY_READINESS_ADMISSION_FLAG);
    if (!readinessExtension
      || hostDigest(readinessExtension.allowed_stages || []) !== hostDigest(['off', 'dry_run', 'shadow', 'canary'])
      || hostDigest(readinessExtension.allowed_sources || []) !== hostDigest(['default', 'manual'])
      || readinessExtension.reason_required !== true) {
      errors.push('desktop-runtime.v2 must admit the client-scoped ENTITY_READINESS_ADMISSION canary postures');
    }
  }

  const legacy = (manifest.legacy_identity_contracts || []).find((entry) =>
    entry.jurisdiction === 'GB' && entry.legacy_legal_form === 'uk_ltd');
  if (!legacy || legacy.canonical_legal_form !== 'gb-ltd') {
    errors.push('Proof 0 uk_ltd must be explicitly reconciled to runtime gb-ltd');
  }
  return { valid: errors.length === 0, errors };
};

export const loadAdmittedEntityProfileManifest = async ({ rootDir = process.cwd() } = {}) => {
  const manifest = JSON.parse(await readFile(path.join(rootDir, ADMITTED_ENTITY_PROFILE_MANIFEST_PATH), 'utf8'));
  const validation = validateAdmittedEntityProfileManifest(manifest);
  if (!validation.valid) {
    const error = new Error(`Invalid admitted entity profile manifest: ${validation.errors.join('; ')}`);
    error.code = 'ENTITY_PROFILE_MANIFEST_INVALID';
    error.details = validation;
    throw error;
  }
  return { manifest, digest: hostDigest(manifest) };
};

export const resolveAdmittedEntityProfile = ({ manifest, profileId = null, coordinate = null } = {}) => {
  const profile = profileId
    ? manifest?.profiles?.find((entry) => entry.profile_id === profileId)
    : manifest?.profiles?.find((entry) => PROFILE_COORDINATE_FIELDS.every(
        (field) => entry[field] === coordinate?.[field]
      ));
  if (!profile) throw new UndeclaredEntityProfileError(coordinate || { profile_id: profileId });
  return profile;
};

const safeIdentifier = (value) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error(`Unsafe database identifier: ${value}`);
  return `"${value}"`;
};

const rows = (result) => Array.isArray(result?.rows) ? result.rows : [];

// A client id is deterministic (firm + registration identity), so a deleted
// company re-created with the same identity reuses the id, and audit_events
// keep the deleted life's receipts under the same resource_id. A life begins
// after the most recent client.delete of that id: only receipts written after
// it can speak for the current life. The delete writer receipts the authority
// purge AFTER client.delete in the same transaction, so that one purge (the
// bridge reset_recreate needs) stays inside the window, and no earlier life's
// create/profile receipt can satisfy a check the current life must pass on its
// own (stability lane 2026-09-23, Kari's go; the finding's §7 hazard).
const CURRENT_LIFE_RECEIPTS_SQL = `and id > coalesce((
            select max(d.id) from audit_events d
             where d.firm_id = $1 and d.resource_id = $2 and d.action = 'client.delete'), 0)`;

export const readEntityCertificateSnapshot = async ({ query, firmId, clientId, chartContract = null } = {}) => {
  if (typeof query !== 'function') {
    const error = new Error('Entity Certificate B requires a PostgreSQL query function.');
    error.code = 'ENTITY_DATABASE_UNAVAILABLE';
    throw error;
  }
  const [clientResult, createAuditResult, profileAuditResult, purgeAuditResult, flagResult,
    accountResult, assignmentResult, memberResult, collaboratorResult, grantResult,
    actionGrantResult, clientColumnResult, factResult, memoryResult, jobResult, collisionResult] = await Promise.all([
    query(
      `select c.id, c.firm_id, c.company_name, c.uen, c.entity_type, c.jurisdiction, c.status, c.profile,
              f.default_currency, f.metadata as firm_metadata
         from clients c join firms f on f.id = c.firm_id
        where c.firm_id = $1 and c.id = $2`,
      [firmId, clientId]
    ),
    query(
      `select id, actor_type, actor_id, action, resource_type, resource_id, metadata, created_at::text
         from audit_events
        where firm_id = $1 and resource_id = $2 and action = 'client.create'
          ${CURRENT_LIFE_RECEIPTS_SQL}
        order by created_at, id`,
      [firmId, clientId]
    ),
    query(
      `select id, actor_type, actor_id, action, resource_type, resource_id, metadata, created_at::text
         from audit_events
        where firm_id = $1 and resource_id = $2 and action = 'client.profile.update'
          ${CURRENT_LIFE_RECEIPTS_SQL}
        order by created_at, id`,
      [firmId, clientId]
    ),
    query(
      `select id, actor_type, actor_id, action, resource_type, resource_id, metadata, created_at::text
         from audit_events
        where firm_id = $1 and resource_id = $2 and action = 'client.authority_plane_purged'
          ${CURRENT_LIFE_RECEIPTS_SQL}
        order by created_at, id`,
      [firmId, clientId]
    ),
    query(
      `select id, flag_key, stage, source, reason, set_by_actor_type, set_by_actor_id, valid_from::text
         from client_capability_config
        where firm_id = $1 and client_id = $2 and valid_to is null
        order by flag_key`,
      [firmId, clientId]
    ),
    query(
      chartContract?.native_lineage_required === true
        ? `select id, code, name, account_type, normal_balance, canonical_role, status, payload, currency
         from ledger_accounts
        where firm_id = $1 and client_id = $2
        order by code nulls last, id`
        : `select id, code, name, account_type, normal_balance, canonical_role, status, payload
         from ledger_accounts
        where firm_id = $1 and client_id = $2
        order by code nulls last, id`,
      [firmId, clientId]
    ),
    query(
      chartContract?.native_lineage_required === true
        ? `select id, firm_id, client_id, principal_type, principal_id, role, access_level, assignment_kind, status,
                  starts_at::text, ends_at::text
             from client_assignments where client_id = $1 order by id`
        : `select id, principal_type, principal_id, role, access_level, assignment_kind, status
         from client_assignments
        where firm_id = $1 and client_id = $2
        order by id`,
      chartContract?.native_lineage_required === true ? [clientId] : [firmId, clientId]
    ),
    query(
      `select id, user_id, email, role, status, access_level
         from firm_members where firm_id = $1 order by id`,
      [firmId]
    ),
    query(
      chartContract?.native_lineage_required === true
        ? `select id, firm_id, user_id, email, role, status, access_level, starts_at::text, ends_at::text
             from firm_collaborators where firm_id = $1 order by id`
        : `select id, user_id, email, role, status, access_level
         from firm_collaborators where firm_id = $1 order by id`,
      [firmId]
    ),
    query(
      `select id, scope_kind, scope_key, archetype, action, amount_ceiling::text, currency, status, source
         from reconciliation_authority_grants
        where firm_id = $1 and client_id = $2 order by id`,
      [firmId, clientId]
    ),
    query(
      `select id, domain, action_type, scope_kind, scope_key, amount_ceiling::text, currency, status, source
         from action_authority_grants
        where firm_id = $1 and client_id = $2 order by id`,
      [firmId, clientId]
    ),
    query(
      `select c.table_name,
              exists (
                select 1 from information_schema.columns f
                 where f.table_schema = 'public' and f.table_name = c.table_name and f.column_name = 'firm_id'
              ) as has_firm_id
         from information_schema.columns c
        where c.table_schema = 'public' and c.column_name = 'client_id'
        order by c.table_name`
    ),
    query(
      `select count(*)::integer as count from firm_facts
        where firm_id = $1 and provenance->>'client_id' = $2`,
      [firmId, clientId]
    ),
    query(
      `select count(*)::integer as count from memories
        where tenant_id = $1 and owner_client_id = $2`,
      [firmId, clientId]
    ),
    query(
      `select count(*)::integer as count from local_jobs
        where payload->>'client_id' = $1 or payload->>'clientId' = $1`,
      [clientId]
    ),
    query(
      `select id, firm_id, uen, profile->>'email' as email
         from clients
        where firm_id <> $1 and (
          id = $2
          or ($3::text is not null and $3::text <> '' and upper(coalesce(uen, '')) = upper($3))
          or ($4::text is not null and $4::text <> '' and lower(coalesce(profile->>'email', '')) = lower($4))
        )
        order by firm_id, id`,
      [firmId, clientId, null, null]
    )
  ]);

  const client = rows(clientResult)[0] || null;
  // The collision probe needs persisted identity values, so repeat it after the
  // client read rather than trusting caller-supplied identity.
  const persistedEmail = clean(client?.profile?.email) || null;
  const persistedUen = clean(client?.uen) || null;
  const collisionRows = client
    ? rows(await query(
        `select id, firm_id, uen, profile->>'email' as email
           from clients
          where firm_id <> $1 and (
            id = $2
            or ($3::text is not null and upper(coalesce(uen, '')) = upper($3))
            or ($4::text is not null and lower(coalesce(profile->>'email', '')) = lower($4))
          )
          order by firm_id, id`,
        [firmId, clientId, persistedUen, persistedEmail]
      ))
    : rows(collisionResult);

  const clientTableCounts = {};
  const clientTables = rows(clientColumnResult);
  if (clientTables.length) {
    // One database roundtrip preserves the complete per-table inventory. The
    // old serial count loop consumed the cloud deadline on network latency.
    const countsSql = clientTables.map((row) => {
      const table = safeIdentifier(row.table_name);
      const scoped = row.has_firm_id ? ' and firm_id = $2' : '';
      return `select '${row.table_name}'::text as table_name, count(*)::integer as count from ${table} where client_id = $1${scoped}`;
    }).join(' union all ') + ' order by table_name';
    const countResult = await query(countsSql,
      clientTables.some(row => row.has_firm_id) ? [clientId, firmId] : [clientId]);
    const countsByTable = new Map(rows(countResult).map(row => [row.table_name, row.count]));
    // Keep the catalog's original ordering even if the text result alias has
    // a different database collation. Missing results cannot mean zero rows.
    for (const row of clientTables) {
      if (!countsByTable.has(row.table_name)) {
        throw Object.assign(new Error(`Missing entity row count for ${row.table_name}`),
          { code: 'ENTITY_SNAPSHOT_COUNT_INCOMPLETE' });
      }
      clientTableCounts[row.table_name] = Number(countsByTable.get(row.table_name));
    }
  }

  let ownerAdoption = null;
  try { ownerAdoption = await readConsumedOwnerAdoptionWithClient({query},{firmId,clientId}); }
  catch(error) {
    if(!String(error.code||'').startsWith('OWNER_REVALIDATION_')) throw error;
    ownerAdoption = {failure:error.code};
  }
  let nativeObservation, nativeRegistration;
  if (chartContract?.native_lineage_required === true) {
    nativeObservation = await readNativeChartObservation({ query, firmId, clientId });
    try {
      const lineage = verifyNativeChartObservation(nativeObservation);
      nativeRegistration = await readNativeRegistrationEvidence({ query, firmId, clientId, lineage, profile: client?.profile });
    } catch (error) {
      nativeRegistration = { failure: error.details?.reason || error.code || 'native_registration_unavailable' };
    }
  }
  return {
    client,
    ...(chartContract?.native_lineage_required === true ? {
      native_chart_observation: nativeObservation, native_registration_evidence: nativeRegistration
    } : {}),
    ...(clientTableCounts.model_lane_policy > 0 ? { model_policies: rows(await query(
      'select id,lane,deciding_model,basis,reason,valid_to,set_by_actor_type,set_by_actor_id from model_lane_policy where firm_id=$1 and client_id=$2',
      [firmId,clientId])) } : {}),
    ...(ownerAdoption ? {owner_adoption:ownerAdoption} : {}),
    creation_receipts: rows(createAuditResult),
    profile_receipts: rows(profileAuditResult),
    authority_purge_receipts: rows(purgeAuditResult),
    live_flags: rows(flagResult),
    ledger_accounts: rows(accountResult),
    assignments: rows(assignmentResult),
    firm_members: rows(memberResult),
    firm_collaborators: rows(collaboratorResult),
    reconciliation_authority_grants: rows(grantResult),
    action_authority_grants: rows(actionGrantResult),
    client_table_counts: clientTableCounts,
    special_residue: {
      firm_facts: Number(rows(factResult)[0]?.count || 0),
      memories: Number(rows(memoryResult)[0]?.count || 0),
      local_jobs: Number(rows(jobResult)[0]?.count || 0)
    },
    cross_firm_collisions: collisionRows
  };
};

const manifestCheck = ({ manifest, manifestDigest, admittedProfile }) => {
  const validation = validateAdmittedEntityProfileManifest(manifest);
  const expectedDigest = hostDigest(manifest);
  const failures = [...validation.errors];
  if (manifestDigest && manifestDigest !== expectedDigest) failures.push('manifest_digest_mismatch');
  return check('admitted_profile', failures.length ? 'FAIL' : 'PASS', {
    manifest_version: manifest?.version || null,
    manifest_digest: expectedDigest,
    profile_id: admittedProfile.profile_id,
    coordinate: exactCoordinate(admittedProfile),
    failures
  });
};

// The Host A checks an ENTITY is incompatible without. Host A v5 (RT-01): the
// certificate's overall status is NOT copied verbatim — a dark optional model
// lane or a dirty renderer build is the host admission predicates' business
// (hostReadinessIsMutationReady keeps mutations blocked while the entity stays
// certified); copying the status here is what parked every enrolled entity on
// host_certificate_not_pass for a missing Anthropic key the parse path never
// used. `source_build`, `model_routes` and `spend_meter` are deliberately not
// in this list.
export const REQUIRED_HOST_COMPATIBILITY_CHECKS = Object.freeze([
  'database_schema',
  'scheduler_worker_manifest',
  'evidence_storage',
  'policy_oracle_artifacts',
  'config_control_plane',
  'accounting_adapter'
]);

const hostCompatibilityCheck = ({ hostCertificate, admittedProfile, capabilityContract, snapshot, observedAt }) => {
  if (!hostCertificate) return check('host_compatibility', 'INCOMPLETE', { failures: ['host_certificate_missing'] });
  const failures = [];
  if (hostCertificate.version !== HOST_CERTIFICATE_A_VERSION) failures.push('host_certificate_version_mismatch');
  const byId = new Map((hostCertificate.checks || []).map((entry) => [entry.id, entry]));
  const requiredNotPass = REQUIRED_HOST_COMPATIBILITY_CHECKS.filter((id) => byId.get(id)?.status !== 'PASS');
  // Host A v7: provider_capability's STATUS is configuration and is already
  // inside hostCertificate.status; its response proof is monitoring, never an
  // entity input. The required provider classes stay a compatibility term.
  const cloudUnproven = admittedProfile.runtime_host === CLOUD_RUNTIME_HOST
    && (hostCertificate.status !== 'PASS'
      || byId.get('source_build')?.status !== 'PASS'
      || hostDigest(byId.get('provider_capability')?.detail?.required_provider_classes || []) !== hostDigest(admittedProfile.required_provider_classes)
      || byId.get('evidence_storage')?.detail?.provider !== 'supabase_storage');
  if (requiredNotPass.length || cloudUnproven) failures.push('host_certificate_not_pass');
  const { receipt_digest: receiptDigest, ...hostCertificateBody } = hostCertificate;
  const calculatedReceiptDigest = hostDigest(hostCertificateBody);
  if (!clean(receiptDigest)) failures.push('host_certificate_digest_missing');
  else if (receiptDigest !== calculatedReceiptDigest) failures.push('host_certificate_digest_mismatch');
  if (hostCertificate.compatibility_contract_version !== HOST_COMPATIBILITY_CONTRACT_VERSION) {
    failures.push('host_compatibility_contract_version_mismatch');
  }
  const calculatedCompatibilityDigest = hostCompatibilityDigest({
    runtimeHost: hostCertificate.runtime_host,
    checks: hostCertificate.checks || []
  });
  if (!clean(hostCertificate.compatibility_digest)) failures.push('host_compatibility_digest_missing');
  else if (hostCertificate.compatibility_digest !== calculatedCompatibilityDigest) failures.push('host_compatibility_digest_mismatch');
  const freshness = evaluateHostCertificateFreshness({ certificate: hostCertificate, asOf: observedAt });
  if (freshness.status !== 'fresh') failures.push(freshness.reason);
  if (hostCertificate.runtime_host !== admittedProfile.runtime_host) failures.push('runtime_host_mismatch');
  for (const id of requiredNotPass) failures.push(`host_${id}_not_pass`);
  if (admittedProfile.runtime_host === 'desktop' && byId.get('evidence_storage')?.detail?.provider !== 'local_blob') {
    failures.push('desktop_storage_provider_mismatch');
  }
  const adapters = byId.get('accounting_adapter')?.detail?.registered_external_adapters || [];
  if (!adapters.includes(admittedProfile.accounting_adapter)) failures.push('accounting_adapter_not_registered');
  const supportedCapabilityKeys = byId.get('config_control_plane')?.detail?.supported_keys || [];
  const profileCapabilityKeys = [
    ...(capabilityContract.required_baseline || []).map(({ flag_key }) => flag_key),
    ...(capabilityContract.admitted_extensions || []).filter((extension) => !extension.profile_scope || snapshot.live_flags.some(({ flag_key }) => flag_key === extension.flag_key)).map(({ flag_key }) => flag_key)
  ];
  for (const key of profileCapabilityKeys) {
    if (!supportedCapabilityKeys.includes(key)) failures.push(`host_capability_key_unsupported:${key}`);
  }
  return check('host_compatibility', failures.length ? (admittedProfile.runtime_host === CLOUD_RUNTIME_HOST ? 'INCOMPLETE' : 'FAIL') : 'PASS', {
    host_certificate_version: hostCertificate.version || null,
    host_certificate_digest: receiptDigest || null,
    calculated_host_certificate_digest: calculatedReceiptDigest,
    host_compatibility_contract_version: hostCertificate.compatibility_contract_version || null,
    host_compatibility_digest: hostCertificate.compatibility_digest || null,
    calculated_host_compatibility_digest: calculatedCompatibilityDigest,
    freshness,
    runtime_host: admittedProfile.runtime_host,
    accounting_adapter: admittedProfile.accounting_adapter,
    supported_capability_keys: supportedCapabilityKeys,
    failures
  });
};

const identityCheck = ({ snapshot, admittedProfile }) => {
  if (!snapshot?.client) return check('canonical_identity', 'INCOMPLETE', { failures: ['client_not_found'] });
  const client = snapshot.client;
  const failures = [];
  if (client.firm_id !== snapshot.expected_firm_id) failures.push('owning_firm_mismatch');
  if (clean(client.jurisdiction).toUpperCase() !== admittedProfile.jurisdiction) failures.push('jurisdiction_column_mismatch');
  if (clean(client.profile?.jurisdiction).toUpperCase() !== admittedProfile.jurisdiction) failures.push('jurisdiction_profile_mismatch');
  if (client.entity_type !== admittedProfile.canonical_legal_form) failures.push('legal_form_column_noncanonical');
  if (client.profile?.entityType !== admittedProfile.canonical_legal_form) failures.push('legal_form_profile_noncanonical');
  if (client.status !== 'active') failures.push('client_not_active');
  return check('canonical_identity', failures.length ? 'FAIL' : 'PASS', {
    jurisdiction: client.jurisdiction || null,
    profile_jurisdiction: client.profile?.jurisdiction || null,
    legal_form: client.entity_type || null,
    profile_legal_form: client.profile?.entityType || null,
    failures
  });
};

const actorCheck = ({ snapshot, admittedProfile, compatibilityScope }) => {
  const failures = [];
  let initiatingPrincipal = null;
  let authorityBasis = null;
  let executor = null;
  let currentFirmAuthority = null;
  let initiatingMemberStatus = null;
  if (admittedProfile.principal_contract === 'revalidated_existing_owner') {
    const adoption=snapshot.owner_adoption;
    if(compatibilityScope!=='current_generation_compatibility') failures.push('adoption_is_not_birth_evidence');
    if(!adoption || adoption.failure || !adoption.owner_id || !adoption.operator_id || !adoption.receipt_id || !adoption.preparation_receipt_id) failures.push('current_owner_adoption_invalid');
    if(!snapshot.live_flags.some(row=>row.flag_key===ENTITY_READINESS_ADMISSION_FLAG && row.stage==='canary' && row.source==='manual')) failures.push('adoption_manual_target_required');
    if(!failures.length) {
      initiatingPrincipal={actor_type:'supabase_user',actor_id:adoption.owner_id};
      authorityBasis={source:'current_authenticated_owner_adoption',principal_id:adoption.owner_id,
        owner_confirmation_receipt_id:adoption.receipt_id,operator_preparation_receipt_id:adoption.preparation_receipt_id,operator_id:adoption.operator_id};
      executor={actor_type:'system',actor_id:'prepareFinnishHostedPilotInDb'};
    }
  } else if (admittedProfile.principal_contract === 'legacy_heal_principal') {
    const receipt = snapshot.profile_receipts.at(-1) || null;
    if (!receipt) failures.push('legacy_heal_receipt_missing');
    else {
      const principalId = clean(receipt.actor_id);
      if (!principalId || principalId.toLowerCase() === 'system') failures.push('legacy_heal_principal_missing');
      initiatingPrincipal = principalId ? { actor_type: 'legacy_profile_principal', actor_id: principalId } : null;
      authorityBasis = principalId ? { source: 'client.profile.update', principal_id: principalId } : null;
      // The writer is the system executor whoever initiated the write: since
      // the profile audit row names the acting principal's type (not
      // 'system'), the executor is not read from the row's actor_type.
      executor = { actor_type: 'system', actor_id: 'updateClientProfileInDb' };
    }
  } else {
    const receipt = snapshot.creation_receipts.at(-1) || null;
    if (!receipt) failures.push('client_create_receipt_missing');
    else {
      const actorType = clean(receipt.actor_type);
      const actorId = clean(receipt.actor_id);
      if (!actorId || actorId.toLowerCase() === 'system' || actorType.toLowerCase() === 'system') failures.push('real_initiating_principal_missing');
      if (admittedProfile.principal_contract === 'firm_member') {
        if (actorType !== 'firm_member') failures.push('firm_member_actor_type_mismatch');
        const member = snapshot.firm_members.find((row) => row.id === actorId);
        // Birth proves the creator was an active member when the book was
        // born. CONTINUED operation depends on the firm's CURRENT authority —
        // any active member (every active member is unrestricted in this
        // tree) — never on the original creator staying employed
        // (2026-09-16: a removed creator stranded a hosted book behind an
        // indefinite "readiness recovery"). The creation receipt itself is
        // never rewritten; it stays the immutable history below.
        currentFirmAuthority = snapshot.firm_members
          .filter((row) => row.status === 'active')
          .map((row) => row.id)
          .sort();
        initiatingMemberStatus = member?.status || 'absent';
        if (compatibilityScope === 'birth_residue_proof') {
          if (!member || member.status !== 'active') failures.push('initiating_firm_member_not_active');
        } else if (!currentFirmAuthority.length) {
          failures.push('firm_authority_absent');
        }
      }
      if (admittedProfile.principal_contract === 'self_serve_owner') {
        if (actorType !== 'supabase_user') failures.push('self_serve_actor_type_mismatch');
        const collaborator = snapshot.firm_collaborators.find((row) => row.user_id === actorId && row.role === 'owner' && row.status === 'active');
        const assignment = collaborator && snapshot.assignments.find((row) =>
          row.principal_type === 'firm_collaborator' && row.principal_id === collaborator.id && row.role === 'owner');
        if (!collaborator) failures.push('self_serve_owner_not_visible');
        if (!assignment) failures.push('self_serve_owner_assignment_missing');
      }
      initiatingPrincipal = { actor_type: actorType || null, actor_id: actorId || null };
      authorityBasis = receipt.metadata?.authority_basis || null;
      executor = receipt.metadata?.executor || null;
      if (!authorityBasis?.source || authorityBasis?.principal_id !== actorId) failures.push('creation_authority_basis_mismatch');
      if (executor?.actor_type !== 'system' || executor?.actor_id !== 'createClientInDb') failures.push('system_executor_receipt_missing');
    }
  }
  return {
    check: check('ownership_actor', failures.length ? 'FAIL' : 'PASS', {
      principal_contract: admittedProfile.principal_contract,
      initiating_principal: initiatingPrincipal,
      authority_basis: authorityBasis,
      system_executor: executor,
      assignment_count: snapshot.assignments.length,
      ...(currentFirmAuthority ? {
        initiating_member_status: initiatingMemberStatus,
        current_firm_authority: { active_member_ids: currentFirmAuthority, basis: 'active_firm_members' }
      } : {}),
      failures
    }),
    initiatingPrincipal,
    authorityBasis,
    executor
  };
};

const accountingCheck = ({ snapshot, admittedProfile, chartContract }) => {
  const failures = [];
  const profile = snapshot.client?.profile || {};
  const accountingSystem = clean(profile.accounting_system).toLowerCase();
  if (accountingSystem !== admittedProfile.accounting_adapter) failures.push('accounting_system_stamp_mismatch');
  const accountingProfile = readAccountingProfile(profile);
  failures.push(...accountingProfileFailures(profile));
  if (accountingProfile.view.value !== admittedProfile.accounting_view) failures.push('accounting_view_mismatch');
  // The client's book currency lives on the CLIENT profile (the keys the tree
  // actually writes — the firmDb chat-profile read is the canonical chain).
  // The firm's default_currency is deliberately NOT a fallback: a firm in one
  // currency holding clients across jurisdictions is the normal shape, and the
  // firm plane must not fail a client-level admission.
  const currencyDeclaration = readAccountingCurrency(profile, { defaultCurrency: chartContract.home_currency });
  const currency = currencyDeclaration.value;
  if (currencyDeclaration.status === 'unknown') failures.push('home_currency_unknown');
  if (currencyDeclaration.status === 'conflicting') failures.push('home_currency_conflicting');
  if (currency !== chartContract.home_currency) failures.push('home_currency_mismatch');
  return check('accounting_posture', failures.length ? 'FAIL' : 'PASS', {
    accounting_system: accountingSystem || null,
    publication_adapter: admittedProfile.accounting_adapter,
    publication_posture: admittedProfile.accounting_adapter === 'none' ? 'internal_ledger' : 'external_adapter',
    accounting_view: admittedProfile.accounting_view,
    accounting_profile: accountingProfile,
    admission_contract: ACCOUNTING_ADMISSION_CONTRACT,
    home_currency: currency || null,
    home_currency_source: currencyDeclaration.sources.length ? 'persisted_profile' : 'admitted_profile_contract',
    failures
  });
};

const packCheck = ({ packManifest, chartContract }) => {
  if (!packManifest) return check('country_pack', 'INCOMPLETE', { failures: ['country_pack_missing'] });
  const failures = [];
  if (packManifest.pack?.id !== chartContract.pack_id) failures.push('country_pack_id_mismatch');
  if (Number(packManifest.pack?.version) !== Number(chartContract.pack_version)) failures.push('country_pack_version_mismatch');
  if (packManifest.currency?.home !== chartContract.home_currency) failures.push('country_pack_currency_mismatch');
  const accounts = packManifest.chart_of_accounts?.fallback_accounts || [];
  const roles = accounts.map(({ role }) => role);
  for (const role of chartContract.required_pack_roles || []) {
    if (!roles.includes(role)) failures.push(`country_pack_role_missing:${role}`);
  }
  if (accounts.some(({ name, role }) => !clean(name) || !clean(role))) failures.push('country_pack_account_name_or_role_missing');
  if (new Set(accounts.map(({ name }) => clean(name).toLowerCase())).size !== accounts.length) failures.push('country_pack_account_name_duplicate');
  return check('country_pack', failures.length ? 'FAIL' : 'PASS', {
    pack_id: packManifest.pack?.id || null,
    pack_version: packManifest.pack?.version ?? null,
    pack_digest: hostDigest(packManifest),
    fallback_account_count: accounts.length,
    required_roles: chartContract.required_pack_roles || [],
    failures
  });
};

const chartProjection = (row) => ({
  code: clean(row.code) || null,
  name: clean(row.name ?? row.name_en),
  account_type: row.account_type,
  normal_balance: row.normal_balance,
  canonical_role: row.canonical_role || null
});

// Only the exact SG legacy contract is name-keyed. Coded GB and existing FI
// projections retain their established bytes and code requirements.
const isSgLegacyChart = contract => contract.persisted_chart === 'sg_legacy_palette.v1' && contract.pack_id === 'sg';
const chartOrder = contract => isSgLegacyChart(contract)
  ? (a, b) => a.name.localeCompare(b.name) || clean(a.code).localeCompare(clean(b.code))
  : (a, b) => clean(a.code).localeCompare(clean(b.code));
const expectedCertificateChart = (chartContract, packManifest, snapshot = {}) => {
  if (chartContract.native_lineage_required === true) {
    try { return nativeBirthAccounts({ contractId: chartContract.persisted_chart, firmId: snapshot.client?.firm_id, clientId: snapshot.client?.id }); }
    catch { return null; }
  }
  if (!isSgLegacyChart(chartContract)) return resolveProvisioningCertificateChart(chartContract.persisted_chart);
  if (packManifest?.pack?.id !== 'sg') return null;
  return fallbackAccountsForPack(packManifest).map(({ name, role }) => ({
    code: null, name: clean(name), canonical_role: role,
    ...__ledgerAccountMintShape({ account: {}, canonicalRole: role })
  }));
};

const chartCheck = ({ snapshot, chartContract, packManifest }) => {
  if (chartContract.native_lineage_required === true) {
    const failures = [];
    let lineage;
    try {
      // Bind the same snapshot rows this certificate actually observes, not a
      // precomputed pass or an independently editable profile choice.
      lineage = verifyNativeChartObservation({ ...snapshot.native_chart_observation,
        accounts: snapshot.ledger_accounts }, { expectedContract: chartContract.persisted_chart });
    } catch (error) { failures.push(error.details?.reason || 'native_lineage_unavailable'); }
    if (!snapshot.native_registration_evidence || snapshot.native_registration_evidence.failure) {
      failures.push(snapshot.native_registration_evidence?.failure || 'native_registration_unavailable');
    }
    return check('persisted_chart', failures.length ? 'FAIL' : 'PASS', {
      chart_contract: chartContract.persisted_chart, expected_account_count: lineage?.accounts.length ?? null,
      actual_account_count: snapshot.ledger_accounts.length,
      birth_receipt_id: lineage?.receipt.id ?? null,
      birth_receipt_digest: lineage?.receipt.metadata.receipt_digest ?? null,
      processing_scope: 'document_processing_review_only', accounting_ready: false, failures
    });
  }
  const actual = snapshot.ledger_accounts.map(chartProjection).sort(chartOrder(chartContract));
  const failures = [];
  let expected = null;
  const certificateChart = expectedCertificateChart(chartContract, packManifest);
  if (!certificateChart && chartContract.persisted_chart !== 'none') failures.push('persisted_chart_contract_unavailable');
  if (certificateChart) {
    expected = certificateChart.map(chartProjection).sort(chartOrder(chartContract));
    if (hostDigest(actual) !== hostDigest(expected)) failures.push('persisted_chart_contract_mismatch');
  }
  if (actual.some(({ name }) => !name)) failures.push('persisted_chart_name_missing');
  // Verdict-minted accounts are BORN code-less by design
  // (ensureLedgerAccountFromVerdict and the journal upserter's code-less
  // scheme: name-keyed id, code resolved by a later slice, first posting
  // human-glanced). A missing code therefore fails certification ONLY where
  // the chart contract pins a fully-coded chart; judging the sanctioned shape
  // as a defect exhausted Honeybee's saga on 2026-08-31.
  if (expected && !isSgLegacyChart(chartContract) && actual.some(({ code }) => !code)) failures.push('persisted_chart_code_missing');
  const codes = actual.map(({ code }) => code).filter(Boolean);
  if (new Set(codes).size !== codes.length) failures.push('persisted_chart_code_duplicate');
  if (isSgLegacyChart(chartContract) && snapshot.ledger_accounts.some(row => row.status !== 'active')) failures.push('persisted_chart_account_inactive');
  return check('persisted_chart', failures.length ? 'FAIL' : 'PASS', {
    chart_contract: chartContract.persisted_chart,
    expected_account_count: expected?.length ?? null,
    actual_account_count: actual.length,
    expected_digest: expected ? hostDigest(expected) : null,
    actual_digest: hostDigest(actual),
    failures
  });
};

const capabilityCheck = ({ snapshot, capabilityContract }) => {
  const required = (capabilityContract.required_baseline || [])
    .map(({ flag_key, stage, source, reason }) => ({ flag_key, stage, source, reason }))
    .sort((a, b) => a.flag_key.localeCompare(b.flag_key));
  const admittedExtensions = (capabilityContract.admitted_extensions || [])
    .map(({ flag_key, allowed_stages, allowed_sources, reason_required }) => ({
      flag_key,
      allowed_stages: [...(allowed_stages || [])],
      allowed_sources: [...(allowed_sources || [])],
      reason_required
    }))
    .sort((a, b) => a.flag_key.localeCompare(b.flag_key));
  const actual = snapshot.live_flags
    .map(({ flag_key, stage, source, reason }) => ({ flag_key, stage, source, reason }))
    .sort((a, b) => a.flag_key.localeCompare(b.flag_key));
  const failures = [];
  const actualByKey = new Map(actual.map((row) => [row.flag_key, row]));
  if (actualByKey.size !== actual.length) failures.push('duplicate_live_capability');
  for (const row of required) {
    const observed = actualByKey.get(row.flag_key);
    if (!observed) failures.push(`required_capability_missing:${row.flag_key}`);
    else if (hostDigest(observed) !== hostDigest(row)) failures.push(`required_capability_posture_mismatch:${row.flag_key}`);
  }
  const extensionByKey = new Map(admittedExtensions.map((row) => [row.flag_key, row]));
  const liveExtensions = [];
  for (const row of actual) {
    if (required.some(({ flag_key }) => flag_key === row.flag_key)) continue;
    const contract = extensionByKey.get(row.flag_key);
    if (!contract) {
      failures.push(`unexpected_live_capability:${row.flag_key}`);
      continue;
    }
    liveExtensions.push(row);
    if (!contract.allowed_stages.includes(row.stage)
      || !contract.allowed_sources.includes(row.source)
      || (contract.reason_required && !clean(row.reason))) {
      failures.push(`admitted_extension_posture_mismatch:${row.flag_key}`);
    }
  }
  return check('client_capabilities', failures.length ? 'FAIL' : 'PASS', {
    required_baseline_count: required.length,
    admitted_extension_contract_count: admittedExtensions.length,
    live_admitted_extension_count: liveExtensions.length,
    actual_count: actual.length,
    required_baseline_digest: hostDigest(required),
    admitted_extension_contract_digest: hostDigest(admittedExtensions),
    live_admitted_extension_digest: hostDigest(liveExtensions),
    actual_digest: hostDigest(actual),
    failures
  });
};

const authorityCheck = ({ snapshot, lifecycle, compatibilityScope }) => {
  const failures = [];
  const birthBoundary = compatibilityScope === 'birth_residue_proof';
  if (birthBoundary && snapshot.reconciliation_authority_grants.length) failures.push('reconciliation_authority_survived_birth');
  if (birthBoundary && snapshot.action_authority_grants.length) failures.push('action_authority_survived_birth');
  const purgeReceipt = snapshot.authority_purge_receipts.at(-1) || null;
  if (birthBoundary && lifecycle === 'reset_recreate' && !purgeReceipt) failures.push('reset_authority_purge_receipt_missing');
  const metadata = purgeReceipt?.metadata || {};
  const reauthorizationChecklist = [
    ...(metadata.flags || [])
      .filter(({ source }) => source !== 'default')
      .map((row) => ({ kind: 'client_capability', flag_key: row.flag_key, prior_stage: row.stage, disposition: 'purged_reauthorize_deliberately' })),
    ...(metadata.grants || []).map((row) => ({ kind: 'reconciliation_authority_grant', grant_id: row.id, disposition: 'purged_reauthorize_deliberately' })),
    ...(metadata.action_grants || []).map((row) => ({ kind: 'action_authority_grant', grant_id: row.id, disposition: 'purged_reauthorize_deliberately' }))
  ];
  return {
    check: check('authority_posture', failures.length ? 'FAIL' : 'PASS', {
      lifecycle,
      compatibility_scope: compatibilityScope,
      live_reconciliation_grants: snapshot.reconciliation_authority_grants.length,
      live_action_grants: snapshot.action_authority_grants.length,
      purge_receipt_id: purgeReceipt?.id || null,
      reauthorization_checklist: reauthorizationChecklist,
      failures
    }),
    reauthorizationChecklist
  };
};

const birthResidueCheck = ({ snapshot, admittedProfile }) => {
  const creation = snapshot.creation_receipts.at(-1);
  const policies = snapshot.model_policies || [];
  // Only the exact policy receipted in this firm's create transaction is
  // birth equipment. Arbitrary or surviving model policies remain residue.
  const policyBornHere = admittedProfile?.runtime_host === 'vercel'
    && admittedProfile.creation_path === 'desktop_firm_intake'
    && hostedMarketProfileFor(admittedProfile.jurisdiction)?.processing === 'accounting'
    && creation?.actor_type === 'firm_member' && policies.length === 1
    && policies[0].id === creation.metadata?.hosted_birth_model_policy?.id
    && policies[0].deciding_model === creation.metadata.hosted_birth_model_policy.deciding_model
    && policies[0].set_by_actor_id === creation.actor_id && policies[0].set_by_actor_type === 'firm_member'
    && policies[0].lane === 'reconciliation_reasoning' && policies[0].basis === 'experiment'
    && policies[0].reason === hostedMarketProfileFor(admittedProfile.jurisdiction).birthPolicyReason && policies[0].valid_to === null;
  const unexpected = Object.entries(snapshot.client_table_counts || {})
    .filter(([table, count]) => !EXPECTED_CLIENT_TABLES.has(table)
      && !(table === 'model_lane_policy' && policyBornHere && Number(count) === 1) && Number(count) > 0)
    .map(([table, count]) => ({ table, count: Number(count) }));
  const special = Object.entries(snapshot.special_residue || {})
    .filter(([, count]) => Number(count) > 0)
    .map(([store, count]) => ({ store, count: Number(count) }));
  const failures = [
    ...unexpected.map(({ table }) => `prior_client_residue:${table}`),
    ...special.map(({ store }) => `prior_client_residue:${store}`)
  ];
  return check('birth_residue_proof', failures.length ? 'FAIL' : 'PASS', {
    unexpected_client_tables: unexpected,
    special_residue: special,
    failures
  });
};

const currentGenerationCompatibilityCheck = ({ snapshot }) => {
  const currentClientTables = Object.entries(snapshot.client_table_counts || {})
    .filter(([, count]) => Number(count) > 0)
    .map(([table, count]) => ({ table, count: Number(count) }))
    .sort((a, b) => a.table.localeCompare(b.table));
  const currentSpecialState = Object.entries(snapshot.special_residue || {})
    .filter(([, count]) => Number(count) > 0)
    .map(([store, count]) => ({ store, count: Number(count) }))
    .sort((a, b) => a.store.localeCompare(b.store));
  return check('current_generation_compatibility', 'PASS', {
    current_client_tables: currentClientTables,
    current_special_state: currentSpecialState,
    treatment: 'current_generation_business_state_not_birth_residue',
    failures: []
  });
};

const lifecycleCompatibilityCheck = ({ snapshot, compatibilityScope, admittedProfile }) =>
  compatibilityScope === 'current_generation_compatibility'
    ? currentGenerationCompatibilityCheck({ snapshot })
    : birthResidueCheck({ snapshot, admittedProfile });

const isolationCheck = ({ snapshot, admittedProfile }) => {
  // A firm owns its book, not an exclusive registration number or owner email.
  // Independent firms may keep separate books for the same legal company.
  // Owner self-provision/adoption retains its stricter identity protection.
  const collisions = (snapshot.cross_firm_collisions || []).filter((row) =>
    admittedProfile.principal_contract !== 'firm_member' || row.id === snapshot.client?.id);
  return check('firm_isolation', collisions.length ? 'FAIL' : 'PASS', {
    collision_count: collisions.length,
    collision_kinds: collisions.map((row) => ({
      same_id: row.id === snapshot.client?.id,
      same_registration_number: Boolean(snapshot.client?.uen && clean(row.uen).toUpperCase() === clean(snapshot.client.uen).toUpperCase()),
      same_owner_email: Boolean(snapshot.client?.profile?.email && clean(row.email).toLowerCase() === clean(snapshot.client.profile.email).toLowerCase())
    })),
    failures: collisions.length ? ['cross_firm_identity_collision'] : []
  });
};

// Structural lifecycle observation only. Runtime authority remains in authority.js.
const nativeAssignmentCounts = ({ snapshot, compatibilityScope, observedAt, contract }) => {
  const failures = [];
  const observed = typeof observedAt === 'string' && observedAt.trim() ? Date.parse(observedAt) : NaN;
  if (!Number.isFinite(observed)) failures.push('assignment_observation_time_invalid');
  const window = (row) => {
    const start = row.starts_at == null ? null : Date.parse(row.starts_at);
    const end = row.ends_at == null ? null : Date.parse(row.ends_at);
    const valid = (start === null || Number.isFinite(start)) && (end === null || Number.isFinite(end))
      && (start === null || end === null || start < end);
    return { valid, current: valid && Number.isFinite(observed)
      && (start === null || start <= observed) && (end === null || end > observed) };
  };
  const rowIds = new Set(), principalIds = new Set();
  let current = 0, historical = 0;
  for (const row of snapshot.assignments) {
    const principalRows = snapshot.firm_collaborators.filter(principal => principal.id === row.principal_id);
    const principal = principalRows[0];
    const rowWindow = window(row), principalWindow = principal ? window(principal) : { valid: false, current: false };
    const shape = contract?.current_generation;
    const invalid = !shape || !clean(row.id) || rowIds.has(row.id) || !clean(row.principal_id)
      || principalIds.has(row.principal_id) || row.firm_id !== snapshot.expected_firm_id || row.client_id !== snapshot.client?.id
      || ['assignment_kind', 'principal_type', 'role', 'access_level'].some(key => row[key] !== shape[key])
      || !Array.isArray(shape.statuses) || !shape.statuses.includes(row.status) || !rowWindow.valid || !principalWindow.valid
      || principalRows.length !== 1 || principal?.firm_id !== snapshot.expected_firm_id
      || !clean(principal?.id) || !(clean(principal?.user_id) || clean(principal?.email));
    rowIds.add(row.id); principalIds.add(row.principal_id);
    if (invalid) { failures.push('assignment_lifecycle_shape_invalid'); continue; }
    if (row.status === 'active' && principal.status === 'active' && rowWindow.current && principalWindow.current) current++;
    else historical++;
  }
  if (compatibilityScope === 'birth_residue_proof' && snapshot.assignments.length !== contract?.birth_count) {
    failures.push('assignment_count_mismatch');
  }
  return { failures: [...new Set(failures)], detail: {
    contract_version: NATIVE_ASSIGNMENT_CONTRACT_VERSION, scope: compatibilityScope,
    ...(compatibilityScope === 'birth_residue_proof' ? { expected: contract?.birth_count ?? null } : {}),
    actual: snapshot.assignments.length, validated_current: current, validated_historical: historical,
    invalid: snapshot.assignments.length - current - historical
  } };
};

const rowCountCheck = ({ snapshot, capabilityContract, chartContract, admittedProfile, packManifest,
  assignmentContract, compatibilityScope, observedAt }) => {
  const expectedAssignments = ['self_serve_owner','revalidated_existing_owner'].includes(admittedProfile.principal_contract) ? 1 : 0;
  const expectedAccounts = expectedCertificateChart(chartContract, packManifest, snapshot)?.length ?? null;
  const requiredBaseline = capabilityContract.required_baseline || [];
  const extensionKeys = new Set((capabilityContract.admitted_extensions || []).map(({ flag_key }) => flag_key));
  const liveAdmittedExtensions = snapshot.live_flags.filter(({ flag_key }) => extensionKeys.has(flag_key));
  const expectedCapabilityRows = requiredBaseline.length + liveAdmittedExtensions.length;
  const failures = [];
  const nativeAssignments = admittedProfile.assignment_contract_version === NATIVE_ASSIGNMENT_CONTRACT_VERSION
    ? nativeAssignmentCounts({ snapshot, compatibilityScope, observedAt, contract: assignmentContract }) : null;
  if (nativeAssignments) failures.push(...nativeAssignments.failures);
  else if (snapshot.assignments.length !== expectedAssignments) failures.push('assignment_count_mismatch');
  if (snapshot.live_flags.length !== expectedCapabilityRows) failures.push('live_capability_count_mismatch');
  if (expectedAccounts != null && snapshot.ledger_accounts.length !== expectedAccounts) failures.push('ledger_account_count_mismatch');
  return check('expected_row_counts', failures.length ? 'FAIL' : 'PASS', {
    clients: snapshot.client ? 1 : 0,
    creation_receipts: snapshot.creation_receipts.length,
    assignments: nativeAssignments?.detail || { expected: expectedAssignments, actual: snapshot.assignments.length },
    live_capabilities: {
      required_baseline: requiredBaseline.length,
      admitted_extensions_present: liveAdmittedExtensions.length,
      expected: expectedCapabilityRows,
      actual: snapshot.live_flags.length
    },
    ledger_accounts: { expected: expectedAccounts, actual: snapshot.ledger_accounts.length },
    failures
  });
};

const entityDependencyProjection = ({
  snapshot,
  admittedProfile,
  chartContract,
  capabilityContract,
  packManifest,
  initiatingPrincipal,
  authorityBasis,
  assignmentContract
}) => {
  const requiredKeys = new Set((capabilityContract.required_baseline || []).map(({ flag_key }) => flag_key));
  const requiredBaseline = snapshot.live_flags
    .filter(({ flag_key }) => requiredKeys.has(flag_key))
    .map(({ flag_key, stage, source, reason }) => ({ flag_key, stage, source, reason }))
    .sort((a, b) => a.flag_key.localeCompare(b.flag_key));
  const authorityProjection = (rows) => rows.map((row) => ({ ...row }))
    .sort((a, b) => hostDigest(a).localeCompare(hostDigest(b)));
  return {
    digest_version: ENTITY_DEPENDENCY_DIGEST_VERSION,
    profile_id: admittedProfile.profile_id,
    profile_coordinate: exactCoordinate(admittedProfile),
    identity: snapshot.client ? {
      firm_id: snapshot.client.firm_id,
      client_id: snapshot.client.id,
      jurisdiction: snapshot.client.jurisdiction,
      legal_form: snapshot.client.entity_type,
      accounting_system: snapshot.client.profile?.accounting_system || null,
      accounting_view: admittedProfile.accounting_view,
      accounting_profile: readAccountingProfile(snapshot.client.profile),
      home_currency_declarations: Object.fromEntries(['currency', 'accountingCurrency', 'baseCurrency', 'defaultCurrency', 'default_currency'].filter((key) => Object.prototype.hasOwnProperty.call(snapshot.client.profile || {}, key)).map((key) => [key, snapshot.client.profile[key]]))
    } : null,
    initiating_principal: initiatingPrincipal,
    creation_authority_basis: authorityBasis,
    ...(admittedProfile.principal_contract==='revalidated_existing_owner' ? {owner_adoption:snapshot.owner_adoption||null} : {}),
    ownership: snapshot.assignments
      .map(({ principal_type, principal_id, role, access_level, status }) => ({ principal_type, principal_id, role, access_level, status }))
      .sort((a, b) => hostDigest(a).localeCompare(hostDigest(b))),
    ...(admittedProfile.assignment_contract_version === NATIVE_ASSIGNMENT_CONTRACT_VERSION ? {
      assignment_lifecycle: {
        contract_version: admittedProfile.assignment_contract_version, contract: assignmentContract,
        assignments: authorityProjection(snapshot.assignments.map(({ id, firm_id, client_id, principal_type, principal_id,
          assignment_kind, role, access_level, status, starts_at, ends_at }) => ({ id, firm_id, client_id, principal_type,
          principal_id, assignment_kind, role, access_level, status, starts_at, ends_at }))),
        principals: authorityProjection(snapshot.firm_collaborators.filter(row => snapshot.assignments.some(assignment =>
          assignment.principal_type === 'firm_collaborator' && assignment.principal_id === row.id))
          .map(({ id, firm_id, user_id, email, status, access_level, starts_at, ends_at }) =>
            ({ id, firm_id, user_id, email, status, access_level, starts_at, ends_at })))
      }
    } : {}),
    chart_contract: chartContract,
    country_pack_digest: packManifest ? hostDigest(packManifest) : null,
    ...(chartContract.native_lineage_required === true ? { native_chart_lineage: snapshot.native_chart_observation ? {
      client_life_created_at: snapshot.native_chart_observation.client?.birth_created_at,
      receipts: snapshot.native_chart_observation.receipts,
      registration: snapshot.client?.profile?.gst_registration ?? null,
      registration_revision: snapshot.client?.profile?.gst_registration_revision ?? null,
      registration_evidence: snapshot.native_registration_evidence
    } : null } : {}),
    chart: snapshot.ledger_accounts.map(row => chartContract.native_lineage_required === true ? nativeAccountProjection(row) : ({ ...chartProjection(row),
      ...(isSgLegacyChart(chartContract) ? { status: row.status } : {})
    })).sort(chartOrder(chartContract)),
    capabilities: {
      capability_manifest_version: admittedProfile.capability_manifest_version,
      required_baseline_contract: capabilityContract.required_baseline || [],
      persisted_required_baseline: requiredBaseline,
      scoped_extension_contracts: (capabilityContract.admitted_extensions || []).filter(({ profile_scope }) => profile_scope),
      persisted_scoped_extensions: snapshot.live_flags.filter(({ flag_key }) => (capabilityContract.admitted_extensions || []).some((extension) => extension.profile_scope && extension.flag_key === flag_key)).map(({ flag_key, stage, source, reason }) => ({ flag_key, stage, source, reason })).sort((a, b) => a.flag_key.localeCompare(b.flag_key))
    },
    authority: {
      reconciliation_grants: authorityProjection(snapshot.reconciliation_authority_grants),
      action_grants: authorityProjection(snapshot.action_authority_grants)
    }
  };
};

export const evaluateEntityCertificateB = ({
  manifest,
  manifestDigest = null,
  admittedProfile,
  hostCertificate,
  packManifest,
  snapshot,
  firmId,
  clientId,
  lifecycle = 'cold_create',
  compatibilityScope = 'birth_residue_proof',
  observedAt = new Date().toISOString(),
  priorAttempts = []
} = {}) => {
  if (!ENTITY_COMPATIBILITY_SCOPES.includes(compatibilityScope)) {
    throw new Error(`Unknown Entity Certificate B compatibility scope: ${compatibilityScope}`);
  }
  const declaredCapabilityContract = manifest?.capability_manifests?.[admittedProfile.capability_manifest_version]
    || { required_baseline: [], admitted_extensions: [] };
  const capabilityContract = {
    ...declaredCapabilityContract,
    admitted_extensions: (declaredCapabilityContract.admitted_extensions || []).filter(({ profile_scope }) => !profile_scope
      || Object.entries(profile_scope).every(([key, value]) => admittedProfile[key] === value))
  };
  const chartContract = manifest?.chart_contracts?.[admittedProfile.chart_contract_version] || {};
  const assignmentContract = manifest?.assignment_contracts?.[admittedProfile.assignment_contract_version];
  const scopedSnapshot = { ...snapshot, expected_firm_id: firmId };
  const actor = actorCheck({ snapshot: scopedSnapshot, admittedProfile, compatibilityScope });
  const authority = authorityCheck({ snapshot: scopedSnapshot, lifecycle, compatibilityScope });
  const checks = [
    manifestCheck({ manifest, manifestDigest, admittedProfile }),
    hostCompatibilityCheck({ hostCertificate, admittedProfile, capabilityContract, snapshot: scopedSnapshot, observedAt }),
    identityCheck({ snapshot: scopedSnapshot, admittedProfile }),
    actor.check,
    accountingCheck({ snapshot: scopedSnapshot, admittedProfile, chartContract }),
    packCheck({ packManifest, chartContract }),
    chartCheck({ snapshot: scopedSnapshot, chartContract, packManifest }),
    capabilityCheck({ snapshot: scopedSnapshot, capabilityContract }),
    authority.check,
    lifecycleCompatibilityCheck({ snapshot: scopedSnapshot, compatibilityScope, admittedProfile }),
    isolationCheck({ snapshot: scopedSnapshot, admittedProfile }),
    rowCountCheck({ snapshot: scopedSnapshot, capabilityContract, chartContract, admittedProfile, packManifest,
      assignmentContract, compatibilityScope, observedAt })
  ];
  const status = overallStatus(checks);
  const first = checks.find(({ status: checkStatus }) => checkStatus !== 'PASS') || null;
  const { sagaId, idempotencyKey } = entityProvisioningSagaIdentity({ firmId, clientId });
  const entityDependencyDigest = hostDigest(entityDependencyProjection({
    snapshot: scopedSnapshot,
    admittedProfile,
    chartContract,
    capabilityContract,
    packManifest,
    initiatingPrincipal: actor.initiatingPrincipal,
    authorityBasis: actor.authorityBasis,
    assignmentContract
  }));
  const writerReceipts = [
    ...(admittedProfile.principal_contract==='revalidated_existing_owner' && scopedSnapshot.owner_adoption?.receipt_id ? [
      {receipt_id:scopedSnapshot.owner_adoption.receipt_id,action:'client.owner_revalidated'},
      {receipt_id:scopedSnapshot.owner_adoption.preparation_receipt_id,action:'pilot.prepared'}
    ] : []),
    ...scopedSnapshot.creation_receipts.map(({ id, action }) => ({ receipt_id: id, action })),
    ...scopedSnapshot.profile_receipts.map(({ id, action }) => ({ receipt_id: id, action })),
    ...scopedSnapshot.authority_purge_receipts.map(({ id, action }) => ({ receipt_id: id, action }))
  ].sort((a, b) => clean(a.receipt_id).localeCompare(clean(b.receipt_id)));
  const sequence = priorAttempts.length + 1;
  const attemptBody = {
    attempt_sequence: sequence,
    observed_at: observedAt,
    status,
    entity_dependency_digest: entityDependencyDigest,
    // Compatibility alias retained for the Gate 1A suite/receipt reader. In
    // v2 its semantics are the stable entity dependency digest above.
    generation_digest: entityDependencyDigest,
    first_failure: first ? {
      check_id: first.id,
      status: first.status,
      reason_code: first.detail?.failures?.[0] || 'certificate_check_incomplete'
    } : null,
    writer_receipts: writerReceipts
  };
  const attempt = {
    attempt_id: `entity-attempt-${sha256(`${sagaId}|${sequence}|${hostDigest(attemptBody)}`).slice(0, 24)}`,
    ...attemptBody
  };
  const body = {
    version: ENTITY_CERTIFICATE_B_VERSION,
    certificate: 'B',
    mode: 'observe_only',
    enforcement: false,
    product_state_persisted: false,
    admission_authority: false,
    observed_at: observedAt,
    status,
    model_inference_calls: 0,
    model_spend_usd: 0,
    admitted_profile: {
      profile_id: admittedProfile.profile_id,
      coordinate: exactCoordinate(admittedProfile),
      admission_scope: admittedProfile.admission_scope
    },
    lifecycle,
    compatibility_scope: compatibilityScope,
    entity_dependency_digest_version: ENTITY_DEPENDENCY_DIGEST_VERSION,
    entity_dependency_digest: entityDependencyDigest,
    generation_digest: entityDependencyDigest,
    current_host_observation: hostCertificate ? {
      certificate_receipt_digest: hostCertificate.receipt_digest || null,
      compatibility_digest: hostCertificate.compatibility_digest || null,
      status: hostCertificate.status || null,
      freshness: hostCertificate.freshness || null
    } : null,
    checks,
    provisioning_saga: {
      saga_id: sagaId,
      idempotency_key: idempotencyKey,
      readiness_projection: status === 'PASS' ? 'ready_candidate_observed' : 'failed_candidate_observed',
      initiating_principal: actor.initiatingPrincipal,
      system_executor: actor.executor,
      authority_basis: actor.authorityBasis,
      earliest_failure: attempt.first_failure,
      reauthorization_checklist: authority.reauthorizationChecklist,
      writer_receipts: writerReceipts,
      attempts: [...priorAttempts, attempt]
    }
  };
  return { ...body, receipt_digest: hostDigest(body) };
};

export const observeEntityCertificateB = async ({
  query,
  rootDir = process.cwd(),
  profileId = null,
  coordinate = null,
  firmId,
  clientId,
  hostCertificate,
  lifecycle = 'cold_create',
  compatibilityScope = 'birth_residue_proof',
  observedAt = new Date().toISOString(),
  priorAttempts = []
} = {}) => {
  const { manifest, digest } = await loadAdmittedEntityProfileManifest({ rootDir });
  const admittedProfile = resolveAdmittedEntityProfile({ manifest, profileId, coordinate });
  const chartContract = manifest.chart_contracts[admittedProfile.chart_contract_version];
  const packManifest = JSON.parse(await readFile(path.join(rootDir, 'packs', chartContract.pack_id, 'manifest.json'), 'utf8'));
  let snapshot;
  try {
    snapshot = await readEntityCertificateSnapshot({ query, firmId, clientId, chartContract });
  } catch (error) {
    const body = {
      version: ENTITY_CERTIFICATE_B_VERSION,
      certificate: 'B',
      mode: 'observe_only',
      enforcement: false,
      product_state_persisted: false,
      admission_authority: false,
      observed_at: observedAt,
      status: 'INCOMPLETE',
      model_inference_calls: 0,
      model_spend_usd: 0,
      admitted_profile: { profile_id: admittedProfile.profile_id, coordinate: exactCoordinate(admittedProfile) },
      lifecycle,
      compatibility_scope: compatibilityScope,
      checks: [check('persisted_entity_snapshot', 'INCOMPLETE', {
        failures: ['entity_snapshot_read_failed'],
        error: { code: clean(error?.code) || 'ENTITY_SNAPSHOT_FAILED', message: clean(error?.message || error) }
      })]
    };
    return { ...body, receipt_digest: hostDigest(body) };
  }
  return evaluateEntityCertificateB({
    manifest,
    manifestDigest: digest,
    admittedProfile,
    hostCertificate,
    packManifest,
    snapshot,
    firmId,
    clientId,
    lifecycle,
    compatibilityScope,
    observedAt,
    priorAttempts
  });
};
