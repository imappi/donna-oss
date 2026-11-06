// Deliberate operator setup, not self-signup authority or a cloud certificate.
// All accounting/config mutations use the existing named writers.
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { withFirmDbClient, updateClientProfileInDb } from './firmDb.js';
import { readClientConfigSnapshot, forceDisabled, setClientFlagStage } from './clientConfig.js';
import { seedPackPaletteChartWithClient } from './db/ledger.js';
import { ledgerAutoPostAllows } from './ledgerAutoPost.js';
import { codingAutoPostAllows } from './codingAutoPost.js';
import { clientAllowedToAutoMatch, getAutoMatchPolicy } from './reconciliationLlmCore.js';
import { OUTBOUND_ACTION_FLAG_KEYS } from './outbound/actionGate.js';

import { INTERNAL_PILOT_ACCESS_FLAG, HOSTED_PILOT_VERSION, readInternalPilotAccessWithClient } from './internalPilotAccess.js';
import { FI_HOSTED_PILOT_STAGES } from './cloudPilotConfig.js';
import { assertPilotBookEmptyWithClient, readOwnerRevalidationForPilot, readConsumedOwnerAdoptionWithClient, ownerAdoptedProfileDigest, ownerAdoptedAdmissionDigest, OWNER_ADOPTION_ADMISSION_DIGEST_VERSION } from './existingOwnerRevalidation.js';
const refuse = (code, message) => { throw Object.assign(new Error(message), { code, statusCode: 409 }); };

export const prepareFinnishHostedPilotInDb = async ({ firmId, clientId, actorId, profilePatch, expectedClientVersion = null } = {}) => {
  if (!firmId || !clientId || !actorId || actorId === 'system') refuse('PILOT_SCOPE_REQUIRED', 'Name the firm, client and real operator member.');
  if (profilePatch?.jurisdiction !== 'FI' || profilePatch?.accountingCurrency !== 'EUR'
    || profilePatch?.entityType !== 'fi-oy' || !String(profilePatch?.companyName || '').trim()
    || profilePatch?.accounting_system !== 'none'
    || profilePatch?.accounting_view !== 'management_books'
    || !['cash', 'accrual'].includes(profilePatch?.accountingBasis)) {
    refuse('PILOT_IDENTITY_REQUIRED', 'This pilot requires an explicit Finnish Oy, EUR, management books, accounting method and Donna ledger.');
  }
  const migrations = (await readdir(new URL('../../db/migrations/', import.meta.url)))
    .filter(name => name.endsWith('.sql')).map(name => name.slice(0, -4)).sort();
  return withFirmDbClient(async client => {
    await client.query('begin');
    try {
      await client.query("set local lock_timeout='5s'");
      await client.query("set local statement_timeout='5s'");
      const member = await client.query("select id from firm_members where firm_id = $1 and id = $2 and status = 'active' for share", [firmId, actorId]);
      if (!member.rowCount) refuse('PILOT_OPERATOR_REQUIRED', 'An active member of this firm must configure the pilot.');
      const applied = new Set((await client.query('select version from schema_migrations')).rows.map(row => row.version));
      const missing = migrations.filter(version => !applied.has(version));
      if (missing.length) refuse('PILOT_MIGRATIONS_REQUIRED', `Apply the current migration chain before pilot setup: ${missing.join(', ')}`);
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`entity-readiness:${firmId}:${clientId}`]);
      const target = (await client.query('select id, firm_id, jurisdiction, entity_type, status, profile, created_at, xmin::text as row_version from clients where firm_id = $1 and id = $2 for update nowait', [firmId, clientId])).rows[0];
      if (!target || target.jurisdiction !== 'FI' || target.entity_type !== 'fi-oy' || target.status !== 'active') refuse('PILOT_CLIENT_REQUIRED', 'Select an existing Finnish client created through owner provisioning.');
      const priorReceipt = await readPreparationReceipt(client, { firmId, clientId });
      const ownerProvenance = await assertOwnerProvisioned(client, { firmId, clientId, lock: true, prepared: priorReceipt });
      if (ownerProvenance.kind === 'existing_owner_revalidated' && expectedClientVersion === null) {
        refuse('PILOT_CONFIRMATION_REQUIRED', 'Review this existing owner confirmation before adopting the workspace.');
      }
      if (expectedClientVersion !== null && expectedClientVersion !== pilotClientVersion(target, ownerProvenance, actorId)) {
        refuse('PILOT_CLIENT_CHANGED', 'This client changed after review. Reload and confirm the current profile.');
      }
      const owners = await client.query(
        `select fc.id from firm_collaborators fc join client_assignments ca
           on ca.firm_id = fc.firm_id and ca.principal_type = 'firm_collaborator' and ca.principal_id = fc.id
         where fc.firm_id = $1 and ca.client_id = $2 and fc.role = 'owner'
           and fc.status = 'active' and fc.access_level = 'client_scoped' and fc.user_id is not null
           and (ca.starts_at is null or ca.starts_at <= now()) and (ca.ends_at is null or ca.ends_at > now()) for share of fc, ca nowait`, [firmId, clientId]);
      if (!owners.rowCount && ownerProvenance.kind !== 'authenticated_firm_creation') refuse('PILOT_OWNER_REQUIRED', 'The pilot needs an active client-scoped signed-in owner.');
      const alreadyPrepared = await readInternalPilotAccessWithClient(client, { firmId, clientId });
      if (alreadyPrepared) {
        if (ownerProvenance.kind === 'existing_owner_revalidated' && !priorReceipt?.metadata?.owner_provenance) {
          refuse('PILOT_ADOPTION_RECEIPT_REQUIRED', 'This workspace has no reviewed pilot adoption receipt.');
        }
        for (const [key, value] of Object.entries(profilePatch)) {
          if (JSON.stringify(key === 'jurisdiction' ? String(target.profile?.[key]).toUpperCase() : target.profile?.[key]) !== JSON.stringify(value)) refuse('PILOT_PROFILE_CHANGED', 'Pilot identity changed; review through the existing profile correction workflow.');
        }
        await client.query('commit');
        return { client_id: clientId, firm_id: firmId, actor_id: actorId, profile: profilePatch, already_prepared: true, processing_readiness: 'INCOMPLETE', reason: 'hosted_runtime_contract_required' };
      }
      await assertPilotBookEmptyWithClient(client, { firmId, clientId });
      await updateClientProfileInDb({ firmId, clientId, actorId, profilePatch, dbClient: client, manageTransaction: false });
      const stages = FI_HOSTED_PILOT_STAGES;
      for (const [flagKey, stage] of Object.entries(stages)) {
        await setClientFlagStage(client, { firmId, clientId, flagKey, stage, source: 'manual', reason: HOSTED_PILOT_VERSION, actorType: 'firm_member', actorId });
      }
      const chart = await seedPackPaletteChartWithClient(client, { firmId, clientId });
      if (!chart.seeded) refuse('PILOT_CHART_REQUIRED', `Finnish chart setup refused: ${chart.reason}`);
      const receipt = { version: HOSTED_PILOT_VERSION, client_id: clientId, firm_id: firmId, actor_id: actorId, profile: profilePatch, owner_count: owners.rowCount,
        migrations: migrations.length, chart, stages, processing_readiness: 'INCOMPLETE',
        reason: 'hosted_runtime_contract_required', authority_basis: 'explicit_internal_pilot_setup' };
      if (ownerProvenance.kind === 'authenticated_firm_creation') receipt.owner_provenance = ownerProvenance;
      if (ownerProvenance.kind === 'existing_owner_revalidated') {
        receipt.owner_provenance = ownerProvenance;
        const adopted = (await client.query('select company_name,jurisdiction,entity_type,profile from clients where firm_id=$1 and id=$2',[firmId,clientId])).rows[0];
        receipt.adopted_profile_digest = ownerAdoptedProfileDigest(adopted);
        receipt.adopted_admission_digest_version = OWNER_ADOPTION_ADMISSION_DIGEST_VERSION;
        receipt.adopted_admission_digest = ownerAdoptedAdmissionDigest(adopted);
      }
      await client.query(`insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
        values ($1, $2, 'firm_member', $3, 'pilot.prepared', 'client', $2, $4::jsonb)`, [firmId, clientId, actorId, JSON.stringify(receipt)]);
      if (ownerProvenance.kind === 'existing_owner_revalidated'
        && !await readOwnerRevalidationForPilot(client, { firmId, clientId, lock: true, prepared: { metadata: receipt }, requireFresh: true })) {
        refuse('PILOT_OWNER_REVALIDATION_CHANGED', 'The owner confirmation changed or expired during preparation. Review again.');
      }
      await client.query('commit');
      return receipt;
    } catch (error) { await client.query('rollback'); throw error; }
  });
};


const pilotClientVersion = (target, ownerProvenance, actorId) => createHash('sha256').update(JSON.stringify([
  target.firm_id, target.id, target.created_at, target.row_version,
  ...(ownerProvenance?.kind === 'existing_owner_revalidated' ? [ownerProvenance, actorId] : [])
])).digest('hex');

const readPreparationReceipt = async (client, { firmId, clientId }) => (await client.query(`select id, actor_id, created_at, metadata from audit_events
  where firm_id=$1 and client_id=$2 and action='pilot.prepared' order by id desc limit 1`, [firmId, clientId])).rows[0] || null;

const assertOwnerProvisioned = async (client, { firmId, clientId, lock = false, prepared = null }) => {
  const result = await client.query(`select 1 from audit_events where firm_id=$1 and client_id=$2
    and action='client.create' and actor_type='supabase_user'
    and metadata->'authority_basis'->>'source'='authenticated_self_provision_route' limit 1`, [firmId, clientId]);
  if (result.rowCount) return { kind: 'authenticated_creation' };
  const firmCreation = (await client.query(`select a.id, a.actor_id from audit_events a
    join firm_members m on m.id=a.actor_id and m.firm_id=a.firm_id and m.status='active'
    where a.firm_id=$1 and a.client_id=$2 and a.action='client.create' and a.actor_type='firm_member'
      and a.metadata->'authority_basis'->>'source'='authenticated_firm_create_route'
      and a.metadata->'authority_basis'->>'principal_id'=a.actor_id
    order by a.id desc limit 1`, [firmId,clientId])).rows[0];
  if (firmCreation) {
    if (lock && !(await client.query("select id from firm_members where firm_id=$1 and id=$2 and status='active' for share",[firmId,firmCreation.actor_id])).rowCount) {
      refuse('PILOT_OPERATOR_REQUIRED','The creating firm member is no longer active.');
    }
    return {kind:'authenticated_firm_creation',receipt_id:Number(firmCreation.id),actor_id:firmCreation.actor_id};
  }
  const revalidated = prepared?.metadata?.owner_provenance?.kind === 'existing_owner_revalidated'
    ? await readConsumedOwnerAdoptionWithClient(client, {firmId, clientId, lock})
    : await readOwnerRevalidationForPilot(client, { firmId, clientId, lock, prepared });
  if (revalidated) return revalidated;
  refuse('PILOT_SELF_PROVISION_REQUIRED', 'The owner must confirm this existing empty workspace at /start?revalidate=pilot before operator review.');
};

export const reviewFinnishHostedPilotInDb = async ({ firmId, clientId, actorId }) => withFirmDbClient(async client => {
  await client.query('begin isolation level repeatable read read only');
  try {
    const member = await client.query("select id from firm_members where firm_id=$1 and id=$2 and status='active'", [firmId, actorId]);
    if (!member.rowCount) refuse('PILOT_OPERATOR_REQUIRED', 'An active member of this firm must review the pilot.');
    const target = (await client.query(`select id, firm_id, company_name, jurisdiction, entity_type, status,
      profile, created_at, xmin::text as row_version from clients where firm_id=$1 and id=$2`, [firmId, clientId])).rows[0];
    if (!target || target.jurisdiction !== 'FI' || target.entity_type !== 'fi-oy' || target.status !== 'active') {
      refuse('PILOT_CLIENT_REQUIRED', 'Select an existing active Finnish Oy client.');
    }
    const receipt = await readPreparationReceipt(client, { firmId, clientId });
    const ownerProvenance = await assertOwnerProvisioned(client, { firmId, clientId, prepared: receipt });
    const config = await readClientConfigSnapshot(client, { firmId, clientId, strict: true });
    const flags = ['JURISDICTION_ACCOUNT_PALETTE', 'JURISDICTION_TAX_CODING', 'FINLAND_ALV_CODING',
      'FINLAND_ALV_RETURN', 'CODING_AUTO_POST', 'LEDGER_AUTO_POST', 'RECONCILIATION_AUTO_MATCH',
      'RECONCILIATION_MATERIAL_AUTO_FYI', 'RECONCILIATION_DELEGATED_AUTHORITY',
      'ENTITY_READINESS_ADMISSION', 'FINLAND_ALV_FILING', 'RECONCILE_RETRACTION_AUTOSEND',
      ...Object.values(OUTBOUND_ACTION_FLAG_KEYS), INTERNAL_PILOT_ACCESS_FLAG];
    const result = { firm_id: firmId, client_id: clientId, actor_id: actorId,
      client_version: pilotClientVersion(target, ownerProvenance, actorId),
      owner_provenance: ownerProvenance,
      profile: { companyName: target.company_name, jurisdiction: target.jurisdiction, entityType: target.entity_type,
        accountingCurrency: target.profile?.accountingCurrency || '', accounting_system: target.profile?.accounting_system || '',
        accounting_view: target.profile?.accounting_view || '', accountingBasis: target.profile?.accountingBasis || '' },
      receipt, processing_readiness: 'INCOMPLETE', reason: 'hosted_runtime_contract_required',
      configuration: flags.map(flag_key => ({ flag_key, stage: config[flag_key]?.stage || null,
        source: config[flag_key]?.source || null, force_disabled: forceDisabled(flag_key) })),
      pipeline: {
        coding_auto_post: codingAutoPostAllows({ clientId, snapshot: config }),
        ledger_auto_post: ledgerAutoPostAllows({ snapshot: config }),
        reconciliation_auto_match: clientAllowedToAutoMatch(clientId, getAutoMatchPolicy({ jurisdiction: 'FI' }), { configSnapshot: config }),
        scope: 'configuration_only_not_runtime_or_material_authority',
        parser_router_readiness: 'INCOMPLETE',
      }
    };
    await client.query('commit');
    return result;
  } catch (error) { await client.query('rollback'); throw error; }
});
