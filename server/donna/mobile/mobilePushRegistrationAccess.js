// The lifetime half of mobile_push_registrations (migration 170; owner:
// mobilePushRegistrations.js, whose header states the rules). Import-free on
// purpose: db/clients.js (deleteClientInDb) and clientOwnerInvitesDb.js
// (removeClientOwnerAccessInDb) call it on their own transaction's client.
//
// Called by the access writers INSIDE their transaction, before they write
// their own receipt: removes the registration rows of every principal in the
// firm that has no current client assignment to a client other than
// `exceptClientId` (the client being deleted, whose assignments the cascade is
// about to take). Returns the ended rows for that receipt — ids only, never a
// token. Table-presence guarded (the deleteClientInDb purge pattern) so a
// pre-170 database can never block a removal or a client delete.
export const endPushRegistrationsWithoutCurrentAccess = async (db, { firmId, exceptClientId = null }) => {
  const present = (await db.query(`select to_regclass('public.mobile_push_registrations') is not null as present`)).rows[0]?.present;
  if (!present) return [];
  const ended = (await db.query(
    `delete from mobile_push_registrations r
      where r.firm_id = $1
        and not exists (
          select 1 from client_assignments ca
           where ca.firm_id = r.firm_id and ca.principal_type = 'firm_collaborator' and ca.principal_id = r.collaborator_id
             and ca.status = 'active'
             and (ca.starts_at is null or ca.starts_at <= statement_timestamp())
             and (ca.ends_at is null or ca.ends_at > statement_timestamp())
             and ($2::text is null or ca.client_id <> $2::text))
      returning r.registration_id, r.collaborator_id`,
    [firmId, exceptClientId]
  )).rows;
  return ended.map((row) => ({ registration_id: row.registration_id, collaborator_id: row.collaborator_id }));
};
