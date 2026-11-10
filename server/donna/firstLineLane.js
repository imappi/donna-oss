// THE answer to "is the first-line lane deciding for this client on this
// host": the client's JEV_RECONCILIATION flag acts AND this host has the
// lane's provider configured (TYPESAFE_API_KEY and TYPESAFE_MODEL). Every
// reader of the flag asks this question here; none re-derives it.
//
// A provider that is not configured is a DARK lane, decided before any call:
// the lines are decided by the lanes that are configured, exactly as they are
// under CLIENT_CONFIG_FORCE_DISABLE=JEV_RECONCILIATION. A configured provider
// whose call fails, is refused or times out is not dark — that stays the
// named failure of the caller that made it. A missing key never switches
// anything on: it can only make this answer false.
//
// Leaf module (clientConfig + modelLanes only), so the pure readers
// (reconciliationLlmCore, transactions intel, the boot receipt, the host
// certificate) can import it without the firmDb cycle.
import { clientFlagActs } from './clientConfig.js';
import { getLane } from './modelLanes.js';

const LANE = getLane('jev_reconciliation');
export const FIRST_LINE_LANE_ID = LANE.id;
export const FIRST_LINE_FLAG = LANE.desktopDefault.flagKey;
export const FIRST_LINE_PROVIDER = LANE.endpointClass;
// Both rows are needed before a request can be sent (jevProvider.callJevTyped
// refuses without either). Names only; no value is ever returned.
export const FIRST_LINE_PROVIDER_ENV = Object.freeze(['TYPESAFE_API_KEY', LANE.desktopDefault.modelEnvironmentKey]);

const present = (value) => typeof value === 'string' && value.trim().length > 0;

export const firstLineProviderMissing = (env = process.env) =>
  FIRST_LINE_PROVIDER_ENV.filter((name) => !present(env?.[name]));

export const firstLineProviderConfigured = (env = process.env) => firstLineProviderMissing(env).length === 0;

// The full posture, for receipts: whether the flag acts, which rows are
// missing, and the answer. `dark` = the flag acts but the provider is absent.
export const firstLineLanePosture = ({ snapshot = null, env = process.env } = {}) => {
  const flagActs = clientFlagActs({ flagKey: FIRST_LINE_FLAG, snapshot, envFallback: () => false, env });
  const missing = firstLineProviderMissing(env);
  return { decides: flagActs && missing.length === 0, flag_acts: flagActs, dark: flagActs && missing.length > 0, missing_env: missing };
};

export const firstLineLaneDecides = ({ snapshot = null, env = process.env } = {}) =>
  firstLineLanePosture({ snapshot, env }).decides;

// The receipt of a dark first-line lane: one audit row per client (the unique
// index of migration 204), on the asking writer's connection — inside its
// transaction when it holds one. It names the lane, why it is dark and which
// lane decides instead, so a host that loses its configuration has a dated
// record of the change. The decision itself still carries the model that
// actually answered, from the response.
export const FIRST_LINE_LANE_DARK_ACTION = 'model_lane.first_line_dark';

export const receiptFirstLineLaneDarkWithClient = async (client, { firmId, clientId, decidedBy = null, missingEnv = [] } = {}) => {
  if (!client?.query || !firmId || !clientId) return null;
  const prior = await client.query(
    'select 1 from audit_events where firm_id = $1 and client_id = $2 and action = $3 limit 1',
    [firmId, clientId, FIRST_LINE_LANE_DARK_ACTION]
  );
  if (prior?.rowCount) return null;
  const metadata = {
    lane_id: FIRST_LINE_LANE_ID,
    flag_key: FIRST_LINE_FLAG,
    provider: FIRST_LINE_PROVIDER,
    reason: 'provider_not_configured',
    missing_env: [...missingEnv],
    decided_by: decidedBy || null
  };
  const inserted = await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'system', 'first_line_lane', $3, 'client', $2, $4::jsonb)
     on conflict (firm_id, client_id) where action = 'model_lane.first_line_dark' do nothing
     returning id`,
    [firmId, clientId, FIRST_LINE_LANE_DARK_ACTION, JSON.stringify(metadata)]
  );
  return inserted?.rows?.[0] ? { id: inserted.rows[0].id, ...metadata } : null;
};

// The writer-side form of the same question: the answer, plus the receipt
// when this client's flag acts and the lane is dark. `decidedBy` is the lane
// that decides instead (a modelLanes id).
export const firstLineLaneDecidesWithClient = async (client, { firmId, clientId, snapshot = null, decidedBy = null, env = process.env } = {}) => {
  const posture = firstLineLanePosture({ snapshot, env });
  if (posture.dark) await receiptFirstLineLaneDarkWithClient(client, { firmId, clientId, decidedBy, missingEnv: posture.missing_env });
  return posture.decides;
};
