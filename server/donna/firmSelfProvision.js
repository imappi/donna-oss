// Self-service FIRM workspace provisioning — the web signup's post-auth step
// for an accounting-firm identity (Kari, 2026-09-16: a new independent signup
// creates its own firm workspace with the signing-up user as administrator).
//
// Shape follows desktop/firstRunFirmMint.js (firm + admin member + audit in
// one transaction) and selfProvisionDb.js (verified Supabase identity,
// deterministic ids, idempotent per identity). Differences, deliberately:
//   - hosted only: the desktop appliance keeps its sole-firm first-run mint;
//   - NOT "first firm wins": every independent identity gets its own firm;
//   - an identity that already holds an active membership gets THAT firm
//     back (created:false) — retries and repeated logins never duplicate;
//   - the firm is born with a COMPLIMENTARY_ACCESS firm-default row
//     (complimentaryAccess.js) — explicit free access, no Stripe fiction.
// The member row is the workspace's first real principal: the client.create
// receipts of every company it creates name it, and readiness thereafter
// depends on CURRENT firm authority (entityCertificateB.js actorCheck), not on
// this member staying employed.
import { createHash } from 'node:crypto';
import { withFirmDbClient } from './firmDb.js';
import { setClientFlagStage } from './clientConfig.js';
import { isDesktopHostEnv } from './desktop/hostPlaneSeed.js';
import { COMPLIMENTARY_ACCESS_FLAG, COMPLIMENTARY_ACCESS_VERSION } from './complimentaryAccess.js';

export const FIRM_SELF_PROVISION_AUTHORITY_SOURCE = 'authenticated_firm_self_provision_route';
export const FIRM_SELF_PROVISION_VERSION = 'donna.firm-self-provision.v1';
// The hosted Finnish pilot's supported scope; the firm row's jurisdiction is
// informational (the pack contract governs per client), never an engine gate.
const FIRM_JURISDICTION = 'FI';
const FIRM_CURRENCY = 'EUR';

const clean = (value) => String(value ?? '').trim();
const typed = (message, code, statusCode) => Object.assign(new Error(message), { code, statusCode });
const digest = (value) => createHash('sha256').update(value).digest('hex');

export const slugifyFirmName = (name) => clean(name).toLowerCase().normalize('NFKD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export const normalizeFirmSelfProvisionInput = (body = {}) => {
  const firmName = clean(body.firm_name ?? body.firmName);
  const ownerName = clean(body.owner_name ?? body.ownerName);
  if (!firmName) throw typed('Firm name is required.', 'FIRM_PROVISION_INPUT_INVALID', 400);
  if (!ownerName) throw typed('Your name is required.', 'FIRM_PROVISION_INPUT_INVALID', 400);
  if (firmName.length > 120 || ownerName.length > 120) throw typed('Names must be 120 characters or fewer.', 'FIRM_PROVISION_INPUT_INVALID', 400);
  return { firmName, ownerName };
};

// Deterministic per verified identity: a retry converges on the same rows.
export const firmSelfProvisionIds = ({ userId, firmName }) => {
  const firmId = `firm-${digest(`firm-self|${userId}`).slice(0, 24)}`;
  return {
    firmId,
    memberId: `member-${digest(`${firmId}|${userId}`).slice(0, 24)}`,
    slug: `${slugifyFirmName(firmName) || 'firm'}-${firmId.slice(5, 13)}`
  };
};

const readExistingMembership = async (client, { userId, email }) => (await client.query(
  `select id, firm_id, user_id from firm_members
    where status = 'active' and (user_id = $1 or (user_id is null and lower(email) = $2))
    order by firm_id limit 2`,
  [userId, email]
)).rows;

export const selfProvisionFirmWorkspace = async ({
  auth,
  input,
  withFirmDbClientFn = withFirmDbClient,
  isDesktopHost = isDesktopHostEnv
} = {}) => {
  if (isDesktopHost()) throw typed('Firm self-provisioning is a hosted signup path; the desktop uses first-run setup.', 'FIRM_PROVISION_HOST_UNSUPPORTED', 403);
  const userId = clean(auth?.userId);
  const email = clean(auth?.email).toLowerCase();
  if (auth?.type !== 'supabase_user' || !userId || !email) throw typed('A verified sign-in is required to set up a workspace.', 'PROVISION_AUTH_REQUIRED', 401);
  const { firmName, ownerName } = normalizeFirmSelfProvisionInput(input);
  const ids = firmSelfProvisionIds({ userId, firmName });
  return withFirmDbClientFn(async (client) => {
    await client.query('begin');
    try {
      // One provisioning attempt per identity at a time: a double submit or a
      // second tab waits, then finds the membership the first one committed.
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`firm-self-provision:${userId}`]);
      const existing = await readExistingMembership(client, { userId, email });
      if (existing.length > 1) throw typed('This sign-in belongs to more than one firm; open the console with an explicit firm.', 'FIRM_MEMBERSHIP_AMBIGUOUS', 409);
      if (existing.length === 1) {
        if (!existing[0].user_id) await client.query('update firm_members set user_id = $1, updated_at = now() where id = $2', [userId, existing[0].id]);
        await client.query('commit');
        return { firmId: existing[0].firm_id, memberId: existing[0].id, created: false };
      }
      // An identity that is already authorized somewhere — a business owner in
      // the portal flow, or a seat invited into an existing firm — continues
      // into THAT workspace; it never silently acquires a firm of its own.
      const authorized = (await client.query(
        `select firm_id, role, status from firm_collaborators
          where status in ('active', 'invited') and (user_id = $1 or lower(email) = $2)
          order by status, firm_id limit 1`,
        [userId, email]
      )).rows[0];
      if (authorized?.role === 'owner') throw typed('This sign-in already owns a business workspace. Open it from the start page.', 'WORKSPACE_IS_OWNER_PORTAL', 409);
      if (authorized) throw typed('This sign-in is already invited into a firm. Open that workspace instead.', 'WORKSPACE_ALREADY_AUTHORIZED', 409);
      await client.query(
        `insert into firms (id, name, slug, jurisdiction, default_currency, metadata)
         values ($1, $2, $3, $4, $5, $6::jsonb)`,
        [ids.firmId, firmName, ids.slug, FIRM_JURISDICTION, FIRM_CURRENCY,
          JSON.stringify({ created_via: 'web_self_provision', provisioning_version: FIRM_SELF_PROVISION_VERSION })]
      );
      await client.query(
        `insert into firm_members (id, firm_id, user_id, email, name, role, status, access_level, metadata)
         values ($1, $2, $3, $4, $5, 'admin', 'active', 'owner', $6::jsonb)`,
        [ids.memberId, ids.firmId, userId, email, ownerName, JSON.stringify({ created_via: 'web_self_provision' })]
      );
      // The immutable creation receipt: the signer-up is the actor, the route
      // is the authority basis, the writer is the system executor.
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         values ($1, null, 'firm_member', $2, 'firm.self_provisioned', 'firm', $1, $3::jsonb)`,
        [ids.firmId, ids.memberId, JSON.stringify({
          member_id: ids.memberId, user_id: userId, email, firm_name: firmName,
          jurisdiction: FIRM_JURISDICTION, currency: FIRM_CURRENCY, version: FIRM_SELF_PROVISION_VERSION,
          authority_basis: { source: FIRM_SELF_PROVISION_AUTHORITY_SOURCE, principal_type: 'supabase_user', principal_id: userId },
          executor: { actor_type: 'system', actor_id: 'selfProvisionFirmWorkspace' }
        })]
      );
      const complimentary = await setClientFlagStage(client, {
        firmId: ids.firmId, clientId: null, flagKey: COMPLIMENTARY_ACCESS_FLAG, stage: 'canary',
        source: 'default', reason: COMPLIMENTARY_ACCESS_VERSION, actorType: 'firm_member', actorId: ids.memberId
      });
      await client.query('commit');
      return { firmId: ids.firmId, memberId: ids.memberId, created: true, complimentaryAccessRowId: complimentary.id };
    } catch (error) {
      try { await client.query('rollback'); } catch {}
      throw error;
    }
  });
};
