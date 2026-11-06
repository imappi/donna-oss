// Initial identity intake only. This does not grant pilot, billing or processing
// access. All profile effects go through the existing audited profile writer.
import { withFirmDbClient, updateClientProfileInDb } from './firmDb.js';
import { assertPilotBookEmptyWithClient } from './existingOwnerRevalidation.js';
import { toUtcIsoDay } from './dates.js';

const refuse = message => { throw Object.assign(new Error(message), { code: 'OWNER_COMPANY_SETUP_REQUIRED', statusCode: 409 }); };
export const completeOwnerCompanySetup = async ({ firmId, clientId, auth, profilePatch }) => {
  const keys = ['companyName', 'jurisdiction', 'entityType', 'incorporation_date'];
  if (auth?.type !== 'supabase_user' || !auth.userId || !auth.email) refuse('Sign in as the workspace owner to complete company setup.');
  if (!profilePatch || Object.keys(profilePatch).length !== keys.length || keys.some(key => !Object.hasOwn(profilePatch, key))
    || profilePatch.jurisdiction !== 'FI' || profilePatch.entityType !== 'fi-oy'
    || typeof profilePatch.companyName !== 'string' || !profilePatch.companyName.trim() || profilePatch.companyName.trim().length > 200
    || !/^\d{4}-\d{2}-\d{2}$/.test(profilePatch.incorporation_date || '')
    || toUtcIsoDay(profilePatch.incorporation_date) !== profilePatch.incorporation_date) {
    refuse('Confirm the company name, Finland, Oy and its actual incorporation date.');
  }
  return withFirmDbClient(async client => {
    await client.query('begin');
    try {
      await client.query("set local lock_timeout='5s'");
      await client.query("set local statement_timeout='5s'");
      await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`entity-readiness:${firmId}:${clientId}`]);
      const row = (await client.query('select jurisdiction,entity_type,status,profile from clients where firm_id=$1 and id=$2 for update nowait', [firmId, clientId])).rows[0];
      // This is a completion path, never a country/legal-form correction on
      // an established book. Retry reads the saved profile through billing.
      if (!row || row.status !== 'active' || (row.jurisdiction && row.jurisdiction.toUpperCase() !== 'FI') || row.entity_type
        || row.profile?.entity_type || row.profile?.entityType) {
        refuse('This workspace already has a company type. Refresh its setup; existing company details require the ordinary profile workflow.');
      }
      const ownerSql = `select fc.id from firm_collaborators fc join client_assignments ca
        on ca.firm_id=fc.firm_id and ca.principal_type='firm_collaborator' and ca.principal_id=fc.id
        where fc.firm_id=$1 and ca.client_id=$2 and fc.user_id=$3 and lower(fc.email)=lower($4)
        and fc.role='owner' and fc.status='active' and fc.access_level='client_scoped'
        and (fc.starts_at is null or fc.starts_at<=clock_timestamp()) and (fc.ends_at is null or fc.ends_at>clock_timestamp())
        and ca.assignment_kind='capability' and ca.role='owner' and ca.status='active' and ca.access_level='client_scoped'
        and (ca.starts_at is null or ca.starts_at<=clock_timestamp()) and (ca.ends_at is null or ca.ends_at>clock_timestamp())
        for share of fc,ca nowait`;
      const owner = await client.query(ownerSql, [firmId, clientId, auth.userId, auth.email]);
      if (owner.rowCount !== 1) refuse('The active workspace owner must complete this setup.');
      const birth = await client.query(`select 1 from audit_events where firm_id=$1 and client_id=$2
        and action='client.create' and actor_type='supabase_user' and actor_id=$3
        and metadata->'authority_basis'->>'source'='authenticated_self_provision_route' limit 1`, [firmId, clientId, auth.userId]);
      if (!birth.rowCount) refuse('This initial setup is available only for your own newly created workspace.');
      await assertPilotBookEmptyWithClient(client, { firmId, clientId });
      const prepared = await client.query("select 1 from audit_events where firm_id=$1 and client_id=$2 and action='pilot.prepared' limit 1", [firmId, clientId]);
      if (prepared.rowCount) refuse('This pilot has already been prepared. Its company identity cannot be replaced here.');
      const { entityType, ...fields } = profilePatch;
      const result = await updateClientProfileInDb({ firmId, clientId, profilePatch: { ...fields, companyName: fields.companyName.trim(), entity_type: entityType }, actorId: auth.userId, dbClient: client, manageTransaction: false });
      await client.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
        values($1,$2,'supabase_user',$3,'client.owner_company_setup','client',$2,$4::jsonb)`,
      [firmId, clientId, auth.userId, JSON.stringify({ authority_basis: 'authenticated_initial_owner_company_confirmation',
        owner_principal_id: owner.rows[0].id, fields: keys, profile: { ...fields, companyName: fields.companyName.trim(), entityType },
        grants_changed: false, accounting_readiness_asserted: false })]);
      if ((await client.query(ownerSql, [firmId, clientId, auth.userId, auth.email])).rowCount !== 1) {
        refuse('The workspace owner assignment expired during setup. Refresh your access.');
      }
      await client.query('commit');
      return result;
    } catch (error) { await client.query('rollback'); throw error; }
  });
};
