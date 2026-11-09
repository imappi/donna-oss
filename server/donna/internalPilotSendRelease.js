// The explicit, receipted exit from internal-pilot send containment, one client
// at a time, by a firm member or a partner-and-up staff seat. It records a
// release; it never sends and never approves a draft. After release the
// client's ask batches go through the existing send writer and every gate it
// already applies (manual Send or the firm's standing auto-send authorization,
// suppression/freshness, each channel's own flag or binding, receipts).
//
// In the same act (owner decision 2026-11-09) it stages the two owner channels
// a released client gets, for this client only: email questions
// (OWNER_EMAIL_ASKS) and reminders (ASK_REASK_CADENCE, which escalates to the
// firm when the owner cannot be reached). Both are shown in the review, covered
// by its digest and receipted row by row. A flag that already resolves to a
// row for this client — at any stage, from any layer — is an earlier explicit
// choice and is left exactly as it is.
import { withFirmDbClient, assertActionCapability } from './firmDb.js';
import { readClientConfigSnapshot, clientFlagActs, setClientFlagStage } from './clientConfig.js';
import { hostDigest } from './hostCertificateA.js';
import { OWNER_EMAIL_ASKS_FLAG_KEY } from './db/channels.js';
import { REASK_CADENCE_FLAG_KEY } from './askReaskCadence.js';
import { readInternalPilotAccessWithClient, readInternalPilotSendContainmentWithClient,
  PILOT_SEND_RELEASE_ACTION, PILOT_SEND_RELEASE_VERSION, SG_HOSTED_REVIEW_VERSION, INTERNAL_PILOT_ACCESS_FLAG } from './internalPilotAccess.js';

const refuse = (code, message, statusCode = 409) => { throw Object.assign(new Error(message), { code, statusCode }); };
const DRAFT_BATCH_LIMIT = 50;

export const PILOT_SEND_RELEASE_VERB = 'release_pilot_send_containment';

// The owner channels a release switches on, at the stage that ACTS for one
// client (clientFlagActs: canary | auto act; canary is the single-client stage
// the hosted birth uses for its processing flags). No other flag is touched:
// invoicing, dunning and payment automation stay as birth left them.
export const PILOT_SEND_RELEASE_OWNER_CHANNELS = Object.freeze([
  Object.freeze({ flag_key: OWNER_EMAIL_ASKS_FLAG_KEY, stage: 'canary', effect: 'email_questions_to_owner' }),
  Object.freeze({ flag_key: REASK_CADENCE_FLAG_KEY, stage: 'canary', effect: 'remind_unanswered_questions_then_escalate_to_firm' })
]);
// The recipient OWNER_EMAIL_ASKS delivers to: the same profile ladder the
// email channel reads (db/channels.js deliverEmailEvidenceAsksAfterSend).
const ownerEmailOf = profile => {
  const p = profile && typeof profile === 'object' ? profile : {};
  return String(p.email || p.contact_email || p.owner_email || '').trim() || null;
};
const operatorRequired = () => refuse('PILOT_OPERATOR_REQUIRED',
  'An active firm member or a partner seat assigned to this client must release question sending.', 403);

// Who may review/release: a firm member, or a STAFF SEAT through the one
// capability resolver (policy_change → partner and up; a shortfall routes and
// is receipted there). A plain collaborator — including the client's own
// portal owner — never releases its own pilot containment.
export const authorizePilotSendRelease = async ({ firmId, clientId, principal }) => {
  if (principal?.principalType === 'firm_member') return;
  if (principal?.principalType !== 'firm_collaborator' || !principal.seatRole) operatorRequired();
  await assertActionCapability({ firmId, clientId, principal, actionType: PILOT_SEND_RELEASE_VERB });
};

// Re-read the actor inside the transaction: the receipt must name a principal
// that is active (and, for a seat, still assigned to this client) as it commits.
const activeActor = async (client, { firmId, clientId, principal }, lock) => {
  if (principal?.principalType === 'firm_member' && principal.principalId) {
    const member = (await client.query(lock
      ? "select id from firm_members where firm_id=$1 and id=$2 and status='active' for share"
      : "select id from firm_members where firm_id=$1 and id=$2 and status='active'",
    [firmId, principal.principalId])).rows[0];
    if (member) return { actorId: member.id, actorType: 'firm_member' };
  } else if (principal?.principalType === 'firm_collaborator' && principal.seatRole && principal.principalId) {
    const seat = (await client.query(lock
      ? `select fc.id, fc.seat_role from firm_collaborators fc join client_assignments ca
          on ca.firm_id=fc.firm_id and ca.principal_type='firm_collaborator' and ca.principal_id=fc.id
        where fc.firm_id=$1 and fc.id=$2 and ca.client_id=$3 and fc.status='active' and fc.seat_role is not null
          and ca.assignment_kind='capability' and ca.status='active' and (ca.starts_at is null or ca.starts_at <= now()) and (ca.ends_at is null or ca.ends_at > now())
        limit 1 for share of fc, ca`
      : `select fc.id, fc.seat_role from firm_collaborators fc join client_assignments ca
          on ca.firm_id=fc.firm_id and ca.principal_type='firm_collaborator' and ca.principal_id=fc.id
        where fc.firm_id=$1 and fc.id=$2 and ca.client_id=$3 and fc.status='active' and fc.seat_role is not null
          and ca.assignment_kind='capability' and ca.status='active' and (ca.starts_at is null or ca.starts_at <= now()) and (ca.ends_at is null or ca.ends_at > now())
        limit 1`,
    [firmId, principal.principalId, clientId])).rows[0];
    if (seat) return { actorId: seat.id, actorType: 'seat', seatRole: seat.seat_role };
  }
  return operatorRequired();
};

const reviewWithClient = async (client, { firmId, clientId, principal }, { lock = false } = {}) => {
  const actor = await activeActor(client, { firmId, clientId, principal }, lock);
  const target = (await client.query(lock
    ? 'select id, company_name, status, profile from clients where firm_id=$1 and id=$2 for update'
    : 'select id, company_name, status, profile from clients where firm_id=$1 and id=$2', [firmId, clientId])).rows[0];
  if (!target || target.status !== 'active') refuse('PILOT_CLIENT_REQUIRED', 'Select an active client of this firm.');
  // This declared profile has no send-release extension. Enrollment history
  // remains binding after access revocation; a country label is not authority.
  // Both preview and the locked apply reread this before a release can be minted.
  const sgReview = await client.query(lock
    ? `select id from client_capability_config
        where firm_id=$1 and client_id=$2 and flag_key=$3 and source='manual' and reason=$4 limit 1 for share`
    : `select id from client_capability_config
        where firm_id=$1 and client_id=$2 and flag_key=$3 and source='manual' and reason=$4 limit 1`,
  [firmId, clientId, INTERNAL_PILOT_ACCESS_FLAG, SG_HOSTED_REVIEW_VERSION]);
  if (sgReview.rowCount) refuse('SG_PROCESSING_SCOPE_FIXED', 'Singapore document processing and review does not permit releasing external communication.');
  const containment = await readInternalPilotSendContainmentWithClient(client, { firmId, clientId });
  const batches = (await client.query(`select id, subject, created_at,
      jsonb_array_length(coalesce(payload->'draft'->'items', '[]'::jsonb)) as item_count,
      jsonb_array_length(coalesce(payload->'draft'->'document_asks', '[]'::jsonb)) as document_ask_count
    from client_ask_batches where firm_id=$1 and client_id=$2 and status='draft'
    order by created_at desc, id limit $3`, [firmId, clientId, DRAFT_BATCH_LIMIT + 1])).rows;
  const draftQuestions = (await client.query(`select count(*)::int as n from client_evidence_requests
    where firm_id=$1 and client_id=$2 and status='draft' and audience='client'`, [firmId, clientId])).rows[0].n;
  const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  // Which owner-channel rows already exist for this client (client-specific),
  // read under the client row lock on apply. A row on any layer is honoured.
  const ownedKeys = PILOT_SEND_RELEASE_OWNER_CHANNELS.map(row => row.flag_key);
  const clientRows = new Map((await client.query(`select flag_key, stage, source, reason from client_capability_config
    where firm_id=$1 and client_id=$2 and flag_key = any($3::text[]) and valid_to is null order by flag_key`,
  [firmId, clientId, ownedKeys])).rows.map(row => [row.flag_key, row]));
  const ownerChannels = PILOT_SEND_RELEASE_OWNER_CHANNELS.map(({ flag_key, stage, effect }) => {
    const existing = snapshot[flag_key];
    if (existing && typeof existing === 'object' && 'stage' in existing) {
      return { flag_key, effect, action: 'left_as_is', existing_stage: existing.stage, existing_source: existing.source,
        existing_scope: clientRows.has(flag_key) ? 'client' : 'firm_or_cohort',
        acts_after_release: clientFlagActs({ flagKey: flag_key, snapshot, envFallback: () => false }) };
    }
    return { flag_key, effect, action: 'stage', stage, source: 'manual', reason: PILOT_SEND_RELEASE_VERSION,
      acts_after_release: clientFlagActs({ flagKey: flag_key, snapshot: { [flag_key]: { stage, source: 'manual' } }, envFallback: () => false }) };
  });
  const actsAfter = key => ownerChannels.find(row => row.flag_key === key).acts_after_release;
  const ownerEmail = ownerEmailOf(target.profile);
  const autoSend = (await client.query(`select metadata->'loops'->>'auto_send_client_asks' as value from firms where id=$1`,
    [firmId])).rows[0]?.value === 'true';
  const review = {
    firm_id: firmId, client_id: clientId, actor_id: actor.actorId, actor_type: actor.actorType,
    ...(actor.seatRole ? { seat_role: actor.seatRole } : {}), company_name: target.company_name,
    enrolled: containment.enrolled, contained: containment.contained, release: containment.release,
    review_access_live: await readInternalPilotAccessWithClient(client, { firmId, clientId }),
    draft_batches: batches.slice(0, DRAFT_BATCH_LIMIT).map(row => ({ id: row.id, subject: row.subject,
      created_at: new Date(row.created_at).toISOString(), item_count: row.item_count, document_ask_count: row.document_ask_count })),
    draft_batches_truncated: batches.length > DRAFT_BATCH_LIMIT,
    draft_owner_questions: draftQuestions,
    // Shown so the operator knows exactly what a release turns on, and for
    // whom: the owner channels it stages (or leaves), and where email goes.
    after_release: {
      send_path: 'existing_ask_batch_send_writer',
      firm_auto_send_client_asks: autoSend,
      owner_email_asks: actsAfter(OWNER_EMAIL_ASKS_FLAG_KEY),
      reask_reminders: actsAfter(REASK_CADENCE_FLAG_KEY),
      owner_channels: ownerChannels,
      owner_email_recipient: ownerEmail,
      // Email questions would act but have nowhere to go. The release still
      // proceeds: the re-ask sweep escalates an unreachable owner to the firm.
      owner_email_missing: actsAfter(OWNER_EMAIL_ASKS_FLAG_KEY) && !ownerEmail,
      delivery_channels_changed: ownerChannels.some(row => row.action === 'stage')
    }
  };
  return { ...review, review_digest: hostDigest(review) };
};

export const reviewInternalPilotSendRelease = scope => withFirmDbClient(async client => {
  await client.query('begin isolation level repeatable read read only');
  try { const review = await reviewWithClient(client, scope); await client.query('commit'); return review; }
  catch (error) { await client.query('rollback'); throw error; }
});

export const releaseInternalPilotSendContainment = async (scope, { reviewDigest, confirmed } = {}) => {
  if (confirmed !== true || !/^[a-f0-9]{64}$/.test(String(reviewDigest || ''))) {
    refuse('PILOT_SEND_RELEASE_REVIEW_REQUIRED', 'Review the retained questions and confirm before releasing question sending.', 400);
  }
  return withFirmDbClient(async client => {
    await client.query('begin');
    try {
      await client.query("set local lock_timeout='5s'");
      const review = await reviewWithClient(client, scope, { lock: true });
      if (review.review_digest !== reviewDigest) refuse('PILOT_SEND_RELEASE_REVIEW_STALE', 'This client changed after review. Refresh the review.');
      if (!review.contained) refuse('PILOT_SEND_NOT_CONTAINED', 'Question sending is not contained for this client.');
      // Stage exactly the reviewed owner-channel rows, in this transaction,
      // through the one config-plane writer (row history + its own audit).
      const stagedRows = [];
      for (const change of review.after_release.owner_channels.filter(row => row.action === 'stage')) {
        const written = await setClientFlagStage(client, { firmId: scope.firmId, clientId: scope.clientId, flagKey: change.flag_key,
          stage: change.stage, source: change.source, reason: change.reason, actorType: review.actor_type, actorId: review.actor_id });
        stagedRows.push({ config_row_id: written.id, flag_key: change.flag_key, stage: change.stage, source: change.source, reason: change.reason });
      }
      const receipt = { version: PILOT_SEND_RELEASE_VERSION, firm_id: scope.firmId, client_id: scope.clientId, actor_id: review.actor_id,
        actor_type: review.actor_type, ...(review.seat_role ? { seat_role: review.seat_role } : {}),
        review_digest: reviewDigest, retained_draft_batch_ids: review.draft_batches.map(batch => batch.id),
        retained_draft_batches_truncated: review.draft_batches_truncated, retained_draft_owner_questions: review.draft_owner_questions,
        review_access_live: review.review_access_live, after_release: review.after_release,
        authority_basis: review.actor_type === 'seat' ? 'partner_seat_confirmed_pilot_send_release' : 'active_member_confirmed_pilot_send_release',
        owner_channel_stage_rows: stagedRows,
        owner_channels_left_as_is: review.after_release.owner_channels.filter(row => row.action === 'left_as_is')
          .map(({ flag_key, existing_stage, existing_source, existing_scope }) => ({ flag_key, existing_stage, existing_source, existing_scope })),
        sends_performed: false, drafts_approved: false, delivery_channels_changed: stagedRows.length > 0 };
      const row = (await client.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
        values($1,$2,$3,$4,$5,'client',$2,$6::jsonb) returning id, created_at`,
      [scope.firmId, scope.clientId, review.actor_type, review.actor_id, PILOT_SEND_RELEASE_ACTION, JSON.stringify(receipt)])).rows[0];
      if ((await readInternalPilotSendContainmentWithClient(client, scope)).contained) {
        refuse('PILOT_SEND_RELEASE_INCOMPLETE', 'The release did not cover this client’s enrollment. Nothing was changed.');
      }
      await client.query('commit');
      return { ...receipt, receipt_id: Number(row.id), released_at: new Date(row.created_at).toISOString(), contained: false };
    } catch (error) { await client.query('rollback'); throw error; }
  });
};
