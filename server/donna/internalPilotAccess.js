import { clientFlagActs } from './clientConfig.js';

export const INTERNAL_PILOT_ACCESS_FLAG = 'INTERNAL_PILOT_ACCESS';
export const HOSTED_PILOT_VERSION = 'donna.fi-hosted-pilot.v1';
export const SG_HOSTED_REVIEW_VERSION = 'donna.sg-hosted-review.v1';
export const US_HOSTED_PILOT_VERSION = 'donna.us-hosted-pilot.v1';
// Every hosted market's pilot-row reason. HOSTED_MARKET_PROFILES
// (cloudPilotConfig.js) names the same versions; the test pins the two equal.
export const HOSTED_PILOT_VERSIONS = Object.freeze([HOSTED_PILOT_VERSION, SG_HOSTED_REVIEW_VERSION, US_HOSTED_PILOT_VERSION]);

// Only an exact, live manual client grant opens review access. A firm/cohort
// default can never turn every customer into an internal tester.
export const isInternalPilotRestrictionRow = (row) => Boolean(row?.client_id
  && row.flag_key === INTERNAL_PILOT_ACCESS_FLAG
  && row.source === 'manual' && HOSTED_PILOT_VERSIONS.includes(row.reason));

export const isInternalPilotRow = (row) => Boolean(isInternalPilotRestrictionRow(row) && !row.valid_to && row.stage === 'canary'
  && clientFlagActs({ flagKey: INTERNAL_PILOT_ACCESS_FLAG,
    snapshot: { [INTERNAL_PILOT_ACCESS_FLAG]: row }, envFallback: () => false }));

const readPilotRows = async (client, { firmId, clientId }, { includeHistory = false } = {}) => {
  if (!firmId || !clientId) return [];
  const result = await client.query(
    `select client_id, flag_key, stage, source, reason, valid_to
       from client_capability_config
      where firm_id = $1 and client_id = $2 and flag_key = $3
        and ($4::boolean or valid_to is null)`,
    [firmId, clientId, INTERNAL_PILOT_ACCESS_FLAG, includeHistory]
  );
  return result.rows;
};

export const readInternalPilotAccessWithClient = async (client, scope) =>
  (await readPilotRows(client, scope)).some(isInternalPilotRow);

// Removing review access (stage off or a global kill switch) must NEVER release
// old drafts for sending. The config writer preserves the enrollment receipt
// when any ordinary or emergency override replaces the active grant. Retain the
// hold from that history, independently of access, current reason or source.
// This answers "was this client ever enrolled" — cloud evidence intake keys on
// it too, so it deliberately ignores the send release below.
export const readInternalPilotSendRestrictionWithClient = async (client, scope) =>
  (await readPilotRows(client, scope, { includeHistory: true })).some(isInternalPilotRestrictionRow);

// The explicit exit: an active firm member's or partner-seat's receipted release
// (internalPilotSendRelease.js). Changing configuration text is never one.
export const PILOT_SEND_RELEASE_ACTION = 'pilot.send_containment_released';
export const PILOT_SEND_RELEASE_VERSION = 'donna.fi-hosted-pilot-send-release.v1';

// Send containment = enrollment history not covered by a valid release. A
// release covers every enrollment row that existed when it committed; revoking
// or restoring access with any other posture after it never re-contains asks.
// Only a later live enrollment (a recreated client, or an explicit re-grant of
// pilot access) is new containment and needs its own release.
export const readInternalPilotSendContainmentWithClient = async (client, { firmId, clientId } = {}) => {
  if (!firmId || !clientId) return { contained: false, enrolled: false, release: null };
  const release = (await client.query(
    `select id, actor_id, created_at, metadata from audit_events
      where firm_id = $1 and client_id = $2 and action = $3 and actor_type in ('firm_member', 'seat')
        and resource_type = 'client' and resource_id = $2
        and metadata->>'version' = $4 and metadata->>'firm_id' = $1 and metadata->>'client_id' = $2
        and metadata->>'actor_id' = actor_id
      order by id desc limit 1`,
    [firmId, clientId, PILOT_SEND_RELEASE_ACTION, PILOT_SEND_RELEASE_VERSION]
  )).rows[0] || null;
  const rows = (await client.query(
    `select client_id, flag_key, stage, source, reason, valid_to,
            ($4::timestamptz is not null and valid_from <= $4::timestamptz) as released
       from client_capability_config
      where firm_id = $1 and client_id = $2 and flag_key = $3`,
    [firmId, clientId, INTERNAL_PILOT_ACCESS_FLAG, release?.created_at || null]
  )).rows;
  const enrollment = rows.filter(isInternalPilotRestrictionRow);
  const contained = enrollment.some(row => !release || (!row.released && row.stage === 'canary'));
  return {
    contained,
    enrolled: enrollment.length > 0,
    release: release && enrollment.some(row => row.released) ? {
      receipt_id: Number(release.id), actor_id: release.actor_id,
      released_at: new Date(release.created_at).toISOString()
    } : null
  };
};
