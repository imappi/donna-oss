// PUT /entities/{entityId}/onboarding/profile — the owner confirms the facts on
// the phone's Business page (and the onboarding review screen). The contract
// makes this the only onboarding-profile writer.
//
// Where each fact lives, and who owns it:
//   owner_name   → firm_collaborators.name of the acting owner principal (the
//                  row Principal.display_name is read from). Donna had no
//                  writer for it — only the provisioning/invite inserts — so
//                  the update below is that writer, scoped to the owner's own
//                  non-seat 'owner' row.
//   business_name → clients.company_name (what Entity.display_name shows). NOT
//                  written here. company_name is also the seller name on
//                  issued invoices (finland/invoiceIssuance.js,
//                  ownerInvoiceSellerContext.js), the close archive heading
//                  (closeArchive.js), the client identity anchor in the
//                  extraction/coding prompts (extractionContextDb.js,
//                  crossEntityGuard.js, transactionLlm.js via
//                  profile.companyName) and the owner-adoption digest. A
//                  phone edit must not change what statutory output reads as
//                  the business's name, and these facts must not feed coding,
//                  so a changed business_name is refused (400
//                  BUSINESS_NAME_CHANGE_NOT_AVAILABLE) until a separate home
//                  for the trading name is decided (GAPS.md, the PR).
//   the rest     → client_business_profiles (migration 168): read by nothing
//                  but the mobile projection. Why not clients.profile: see the
//                  migration header.
//
// Every applied change commits with its audit_events receipt in the same
// transaction, attributed to the acting owner, carrying the previous and the
// new value. Identity and assignment are re-checked on the writing connection
// with the same named check the other writers use (assertFirmAccess with a
// resolved principal), after the same entitlement gate the web profile route
// applies (assertClientEntitled).
import { assertClientEntitled } from '../clientSubscriptionDb.js';
import { assertFirmAccess, withFirmDbClient } from '../firmDb.js';
import { isBillingEnabled } from '../stripeBilling.js';
import { mobileError } from './mobileAuth.js';
import { isEmptyFacts, parseProfileConfirmation, projectBusinessProfile, sameFacts } from './mobileBusinessProfileFacts.js';
import { projectEntity, projectPrincipal, projectReceipt } from './mobileProjection.js';
import { readEntities } from './mobileReads.js';

export const BUSINESS_PROFILE_AUDIT_ACTION = 'client.business_profile.declared';
export const OWNER_NAME_AUDIT_ACTION = 'owner.name.declared';

const clean = (value) => String(value ?? '').trim();

// Lock contention (NOWAIT identity re-check) or a deadlock between two
// overlapping saves: nothing has been applied, so the whole transaction is
// retried; after the last attempt the save is refused as contended.
const CONTENDED = new Set(['55P03', '40P01']);
const ATTEMPTS = 3;

// The one transaction. Returns what changed plus the receipt rows.
export const declareBusinessProfileInDb = async (input) => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await declareOnce(input);
    } catch (error) {
      if (!CONTENDED.has(error?.code)) throw error;
      if (attempt >= ATTEMPTS) throw mobileError(409, 'PROFILE_SAVE_CONTENDED', 'Another save of these details is in progress. Try again.');
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
};

const declareOnce = async ({
  firmId, clientId, principal, auth, ownerName, businessName, facts, confirmed, terminal = 'mobile'
}) => withFirmDbClient(async (client) => {
  await client.query('begin');
  try {
    // Saves of one business's profile serialize here, before any row lock.
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`mobile-business-profile:${firmId}:${clientId}`]);
    await assertFirmAccess({ firmId, auth, clientIds: [clientId], resolvedPrincipal: principal, dbClient: client });

    const entity = (await client.query(
      'select id, company_name from clients where firm_id = $1 and id = $2 for update',
      [firmId, clientId]
    )).rows[0];
    if (!entity) throw mobileError(404, 'NOT_FOUND', 'No such business in this account.');
    // Entity.display_name is company_name, or the id when none is persisted —
    // sending back what is shown is "unchanged".
    const shownName = clean(entity.company_name) || entity.id;
    if (businessName !== shownName) {
      throw mobileError(400, 'BUSINESS_NAME_CHANGE_NOT_AVAILABLE',
        'The business name can’t be changed in the app yet: Donna uses it on your invoices. Nothing was saved.');
    }

    const owner = (await client.query(
      `select id, name from firm_collaborators
        where firm_id = $1 and id = $2 and role = 'owner' and seat_role is null
        for update`,
      [firmId, principal.principalId]
    )).rows[0];
    if (!owner) throw mobileError(403, 'MOBILE_OWNER_ONLY', 'Only the business owner can change these details.');

    const stored = (await client.query(
      'select facts, revision from client_business_profiles where firm_id = $1 and client_id = $2 for update',
      [firmId, clientId]
    )).rows[0] || null;

    const ownerChanged = clean(owner.name) !== ownerName;
    // A first confirmation that states no fact at all creates nothing:
    // business_profile stays null rather than an empty declaration.
    const factsChanged = stored ? !sameFacts(stored.facts, facts) : !isEmptyFacts(facts);
    const declaredBy = { principal_type: principal.principalType, principal_id: principal.principalId };
    const auditRows = [];

    if (ownerChanged) {
      await client.query(
        `update firm_collaborators set name = $3, updated_at = now()
          where firm_id = $1 and id = $2 and role = 'owner' and seat_role is null`,
        [firmId, owner.id, ownerName]
      );
      auditRows.push((await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         values ($1, $2, $3, $4, 'owner.name.declared', 'firm_collaborator', $4, $5::jsonb)
         returning id::text as id, created_at`,
        [firmId, clientId, principal.principalType, principal.principalId, JSON.stringify({
          terminal, declared_by: declaredBy, confirmed_exact_fields: confirmed,
          previous: { name: owner.name ?? null }, next: { name: ownerName }
        })]
      )).rows[0]);
    }

    let revision = stored?.revision ?? 0;
    if (factsChanged) {
      revision = (await client.query(
        `insert into client_business_profiles (firm_id, client_id, facts, revision, declared_by_type, declared_by_id)
         values ($1, $2, $3::jsonb, 1, $4, $5)
         on conflict (firm_id, client_id) do update
           set facts = excluded.facts,
               revision = client_business_profiles.revision + 1,
               declared_by_type = excluded.declared_by_type,
               declared_by_id = excluded.declared_by_id,
               declared_at = now(),
               updated_at = now()
         returning revision`,
        [firmId, clientId, JSON.stringify(facts), principal.principalType, principal.principalId]
      )).rows[0].revision;
      auditRows.push((await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         values ($1, $2, $3, $4, 'client.business_profile.declared', 'client', $2, $5::jsonb)
         returning id::text as id, created_at`,
        [firmId, clientId, principal.principalType, principal.principalId, JSON.stringify({
          terminal, declared_by: declaredBy, confirmed_exact_fields: confirmed, revision,
          previous: stored ? projectBusinessProfile(stored.facts) : null, next: projectBusinessProfile(facts)
        })]
      )).rows[0]);
    }

    await client.query('commit');
    return { ownerChanged, factsChanged, revision, auditRows };
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  }
});

const summaryFor = ({ ownerChanged, factsChanged }) => {
  if (ownerChanged && factsChanged) return 'Your name and your business details are saved.';
  if (ownerChanged) return 'Your name is saved.';
  if (factsChanged) return 'Your business details are saved.';
  return 'Nothing changed: these details were already saved.';
};

// The route handler. ctx carries the owner scope (firmId, clientId,
// principal), the verified auth and the identity, as the router builds it.
export const confirmBusinessProfile = async (ctx, body, { declare = declareBusinessProfileInDb, read = readEntities } = {}) => {
  const input = parseProfileConfirmation(body);
  await assertClientEntitled({ firmId: ctx.firmId, clientId: ctx.clientId, principal: ctx.principal, billingEnabled: isBillingEnabled() });
  const result = await declare({ firmId: ctx.firmId, clientId: ctx.clientId, principal: ctx.principal, auth: ctx.auth, ...input });
  const [row] = await read({ firmId: ctx.firmId, clientIds: [ctx.clientId] });
  return {
    principal: projectPrincipal({ principal: { ...ctx.principal, name: input.ownerName }, identity: ctx.identity }),
    entity: projectEntity(row),
    receipt: projectReceipt({
      summary: summaryFor(result),
      targets: [
        { target: `principal:${ctx.principal.principalId}`, applied: result.ownerChanged },
        { target: `entity:${ctx.clientId}`, applied: result.factsChanged }
      ],
      auditRows: result.auditRows
    })
  };
};
