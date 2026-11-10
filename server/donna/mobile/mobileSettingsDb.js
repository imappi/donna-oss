// Scoped reads and the one writer behind the app's Settings resource. Every
// statement is pinned to (firm_id, client_id) of an entity the caller has
// ALREADY been admitted to (mobileAuth.ownerScopeForEntity), and to the
// owner's own principal where the row is the owner's.
//
// The VAT period is NOT written here: it is clients.profile.verokausi, whose
// writer is the client-profile route (updateClientProfileInDb); mobileSettings.js
// dispatches to that route. The only write in this file is the owner's
// notification preferences (migration 167), committed with its audit row.
import { queryFirmDb, withFirmDbClient } from '../firmDb.js';

// The persisted facts the settings page shows about the business itself.
export const readSettingsClientFacts = async ({ firmId, clientId }) => {
  const result = await queryFirmDb(
    `select jurisdiction, entity_type, incorporation_date::text as incorporation_date,
            profile->>'incorporation_date' as profile_incorporation_date,
            profile->>'verokausi' as verokausi,
            profile->'alv_registration'->>'tax_period' as alv_tax_period,
            profile->'gb'->>'vat_stagger' as gb_vat_stagger
       from clients where firm_id = $1 and id = $2`,
    [firmId, clientId]
  );
  return result.rows[0] || null;
};

// ALV returns that are pending the owner's confirmation or already filed. Each
// carries its own period bounds; the alv_returns_live_period_idx guard is per
// period_key, so a cadence change while one of these exists could let a
// differently-keyed return overlap a filed one.
export const readLiveAlvReturns = async ({ firmId, clientId }) => {
  const result = await queryFirmDb(
    `select period_key, period_type, status from alv_returns
      where firm_id = $1 and client_id = $2 and status in ('draft_pending_confirmation', 'filed')
      order by starts_on`,
    [firmId, clientId]
  );
  return result.rows;
};

// The owner's OWN verified phone number, in clear, from their active WhatsApp
// or SMS binding on this business. A Telegram binding stores a chat id in the
// same column, so it is excluded. Another collaborator's binding is never read.
export const readOwnerPhoneNumber = async ({ firmId, clientId, principalId }) => {
  const result = await queryFirmDb(
    `select phone_e164 from client_whatsapp_bindings
      where firm_id = $1 and client_id = $2 and collaborator_id = $3
        and revoked_at is null and coalesce(channel, 'whatsapp') in ('whatsapp', 'sms')
      order by verified_at desc limit 1`,
    [firmId, clientId, principalId]
  );
  return result.rows[0]?.phone_e164 || null;
};

export const readNotificationPreferences = async ({ firmId, clientId, principalId }) => {
  const result = await queryFirmDb(
    `select needs_you, due_dates, monthly_summary, every_receipt from mobile_notification_preferences
      where firm_id = $1 and client_id = $2 and principal_id = $3`,
    [firmId, clientId, principalId]
  );
  return result.rows[0] || null;
};

// The writer: upsert the owner's four switches and append the audit row in the
// same transaction. A save that changes nothing writes nothing and says so.
export const saveNotificationPreferences = async ({ firmId, clientId, principalId, preferences }) =>
  withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      const before = (await client.query(
        `select needs_you, due_dates, monthly_summary, every_receipt from mobile_notification_preferences
          where firm_id = $1 and client_id = $2 and principal_id = $3 for update`,
        [firmId, clientId, principalId]
      )).rows[0] || null;
      const keys = ['needs_you', 'due_dates', 'monthly_summary', 'every_receipt'];
      if (before && keys.every((key) => before[key] === preferences[key])) {
        await client.query('rollback');
        return { applied: false, auditRows: [] };
      }
      await client.query(
        `insert into mobile_notification_preferences
           (firm_id, client_id, principal_id, needs_you, due_dates, monthly_summary, every_receipt, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, $3)
         on conflict (firm_id, client_id, principal_id) do update
           set needs_you = excluded.needs_you, due_dates = excluded.due_dates,
               monthly_summary = excluded.monthly_summary, every_receipt = excluded.every_receipt,
               updated_by = excluded.updated_by, updated_at = now()`,
        [firmId, clientId, principalId, preferences.needs_you, preferences.due_dates,
          preferences.monthly_summary, preferences.every_receipt]
      );
      const audit = await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         values ($1, $2, 'owner', $3, 'mobile.notification_preferences.update', 'mobile_notification_preferences', $2, $4::jsonb)
         returning id::text as id, actor_type, actor_id, action, resource_type, resource_id, created_at`,
        [firmId, clientId, principalId, JSON.stringify({ terminal: 'mobile', before, after: preferences })]
      );
      await client.query('commit');
      return { applied: true, auditRows: audit.rows };
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
