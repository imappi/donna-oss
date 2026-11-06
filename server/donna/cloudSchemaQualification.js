// Structural equality is exhaustive over the exported authored public schema.
// Hosted infrastructure differences are named and receipted, never elided by count.
import { hostDigest } from './hostCertificateA.js';
export const CLOUD_SCHEMA_CATALOG_VERSION = 'donna.cloud-schema-catalog.v3';
export const CLOUD_SCHEMA_QUALIFICATION_VERSION = 'donna.cloud-schema-qualification.v3';
export const CLOUD_HISTORICAL_MIGRATIONS = Object.freeze([
  '035_donna_loops_memory_candidates', '117_firm_facts_erased_status',
  '112_legacy_rls_group_a_statutory', '113_legacy_rls_group_b_communications'
]);
const hostedExtensions = { pg_stat_statements: ['extensions', '1.11'], pgcrypto: ['extensions', '1.3'],
  supabase_vault: ['vault', '0.3.1'], 'uuid-ossp': ['extensions', '1.1'] };
const trusted = new Set(['postgres', 'supabase_admin', 'service_role', 'pg_database_owner']);
const browser = new Set(['PUBLIC', 'anon', 'authenticated']);
export const cloudSchemaCatalogDigest = catalog => hostDigest({ version: catalog.version,
  server_major: Math.floor(catalog.server_version_num / 10000), migrations: catalog.migrations,
  private_storage: catalog.private_storage, storage_security: catalog.storage_security, browser_roles:catalog.browser_roles, objects: catalog.objects });
export const compareCloudSchemaCatalogs = ({ actual, reference, referenceOwner }) => {
  const failures = [], classified = [];
  const fail = (code, object = null) => failures.push({ code, object });
  for (const [label, c] of [['actual', actual], ['reference', reference]]) {
    if (c?.version !== CLOUD_SCHEMA_CATALOG_VERSION || Math.floor(c?.server_version_num / 10000) !== 17) fail('PG17_CATALOG_REQUIRED', label);
    const keys = c?.objects?.map(o => `${o.kind}:${o.name}`) || [];
    if (!keys.length || new Set(keys).size !== keys.length) fail('LOSSLESS_UNIQUE_CATALOG_REQUIRED', label);
  }
  if (failures.some(f => f.code === 'LOSSLESS_UNIQUE_CATALOG_REQUIRED')) return { status: 'FAIL', failures, classified };
  if (actual.browser_roles?.length !== 2 || new Set(actual.browser_roles?.map(r=>r.name)).size !== 2 || actual.browser_roles.some(r=>!['anon','authenticated'].includes(r.name)
    || !Array.isArray(r.memberships) || r.memberships.length || r.superuser || r.bypass_rls || r.create_role || r.create_database || r.privileged_membership)) fail('BROWSER_ROLE_ISOLATION_REQUIRED');
  const expectedMigrations = new Set(reference.migrations);
  for (const name of expectedMigrations) if (!actual.migrations.includes(name)) fail('MIGRATION_MISSING', name);
  for (const name of actual.migrations) if (!expectedMigrations.has(name)) {
    if (CLOUD_HISTORICAL_MIGRATIONS.includes(name)) classified.push({ kind: 'historical_migration_alias', name });
    else fail('MIGRATION_UNEXPECTED', name);
  }
  if (actual.private_storage?.length !== 1 || actual.private_storage[0].id !== 'donna-evidence'
    || actual.private_storage[0].public !== false) fail('PRIVATE_EVIDENCE_BUCKET_REQUIRED');
  // The reviewed hosted posture is service-only: RLS enabled, no browser
  // ownership and no policies. A private bucket flag alone does not deny reads.
  if (!Array.isArray(actual.storage_security) || actual.storage_security.length !== 2
    || new Set(actual.storage_security.map(r => r.name)).size !== 2
    || actual.storage_security.some(r => !['objects', 'buckets'].includes(r.name) || r.kind !== 'r'
      || r.rls !== true || typeof r.force_rls !== 'boolean' || r.browser_owner !== false
      || !Array.isArray(r.policies) || r.policies.length)) fail('PRIVATE_STORAGE_DEFAULT_DENY_REQUIRED');
  else classified.push({ kind: 'managed_private_storage_default_deny', definition: actual.storage_security });
  const normalize = (catalog, isReference) => catalog.objects.flatMap(object => {
    const o = structuredClone(object), d = o.definition;
    if (o.kind === 'public_extension_member') fail('UNREVIEWED_PUBLIC_EXTENSION_MEMBER', o.name);
    if (['grant', 'column_grant', 'function_grant', 'schema_grant'].includes(o.kind)) {
      const { privilege, grantee: role } = d;
      if (!role || !privilege || !d.object || typeof d.grantable !== 'boolean') fail('ACL_IDENTITY_REQUIRED', o.name);
      const grantorTrusted = trusted.has(d.grantor) || (isReference && d.grantor === referenceOwner);
      if (!grantorTrusted) fail('UNREVIEWED_GRANTOR', o.name);
      if (browser.has(role)) {
        if (o.kind === 'schema_grant' && privilege === 'USAGE' && !d.grantable) {
          classified.push({ kind: 'browser_schema_usage', name: o.name });
        } else if (o.kind === 'function_grant' && privilege === 'EXECUTE' && !d.grantable) {
          const fn = catalog.objects.find(f => f.kind === 'function' && f.name === d.object);
          const triggerOnly = ['trigger', 'event_trigger'].includes(fn?.definition?.return_type);
          if (!fn || (fn.definition.security_definer && !triggerOnly)) fail('BROWSER_DEFINER_EXECUTE', o.name);
          else classified.push({ kind: triggerOnly ? 'trigger_only_execute' : 'invoker_execute_table_permissions_apply', name: o.name });
        } else fail(o.kind === 'column_grant' ? 'BROWSER_COLUMN_PRIVILEGE' : 'BROWSER_SCHEMA_OR_RELATION_PRIVILEGE', o.name);
      } else if (!trusted.has(role) && !(isReference && role === referenceOwner)) fail('UNREVIEWED_GRANTEE', o.name);
      else classified.push({ kind: 'trusted_server_role_privilege', name: o.name });
      return [];
    }
    if (o.kind === 'extension' && o.name !== 'plpgsql') {
      const reviewed = hostedExtensions[o.name];
      if (!reviewed || d.schema !== reviewed[0] || d.version !== reviewed[1]) fail('UNREVIEWED_HOST_EXTENSION', o.name);
      else classified.push({ kind: 'host_infrastructure_extension', name: o.name });
      return [];
    }
    if (o.kind === 'function' || o.kind === 'event_trigger') {
      if (d.owner !== (isReference ? referenceOwner : 'postgres')) fail('UNREVIEWED_AUTHORED_OBJECT_OWNER', o.name);
      d.owner = 'database_owner';
    }
    return [o];
  });
  const a = new Map(normalize(actual, false).map(o => [`${o.kind}:${o.name}`, o]));
  const r = new Map(normalize(reference, true).map(o => [`${o.kind}:${o.name}`, o]));
  for (const key of new Set([...a.keys(), ...r.keys()])) if (hostDigest(a.get(key) ?? null) !== hostDigest(r.get(key) ?? null)) fail('PHYSICAL_SCHEMA_MISMATCH', key);
  return { status: failures.length ? 'FAIL' : 'PASS', failures, classified,
    actual_catalog_digest: cloudSchemaCatalogDigest(actual), reference_catalog_digest: cloudSchemaCatalogDigest(reference),
    compared_objects: a.size, classification_digest: hostDigest(classified) };
};
