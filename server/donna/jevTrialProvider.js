// Permanent desktop first-line policy, with legacy trial/shadow compatibility.
// The provider answer is unchanged; model choice confers no posting authority.
import { readJevExperiment } from './jevExperimentPolicy.js';
import { makeJevShadowHook } from './jevShadow.js';
import { createHash } from 'node:crypto';
import { callJevTyped, jevWireBody } from './jevProvider.js';
import { readClientConfigSnapshot, clientFlagActs } from './clientConfig.js';
import { experimentDigest } from './jevExperimentPolicy.js';
import { getLane } from './modelLanes.js';
import { isDesktopHostEnv } from './desktop/hostPlaneSeed.js';
import { resolveRuntimeHostIdentity } from './runtimeHostIdentity.js';
import { CLOUD_PILOT_PROCESSING_VERSION, HOSTED_ACCOUNTING_MARKETS, hostedJevDefaultBasisFor } from './cloudPilotConfig.js';
import { CodingPolicyError } from './codingPolicy.js';

export async function makeJevTrialProvider({ client, firmId, clientId, resourceType, resourceId,
  decisionKind, snapshot = null, withClient = null, env = process.env, provider = callJevTyped }) {
  let resolved;
  try { resolved = await readJevDecisionPolicy({ client, firmId, clientId, snapshot, env }); }
  catch (error) {
    // Coding's existing failure writer and recovery clock own unavailable
    // configuration. Preserve the precise provider-policy cause in its receipt.
    if (decisionKind === 'coding' && ['jev_experiment_not_authorized','jev_model_not_configured'].includes(error.code)) {
      throw new CodingPolicyError('coding_policy_unavailable', {details:{reason:error.code}});
    }
    throw error;
  }
  const { policy, config, permanent } = resolved;
  const connection = withClient || (await import('./firmDb.js')).withFirmDbClient;
  const hook = makeJevShadowHook({ firmId, clientId, policy, snapshot: config, withClient: connection, env });
  return async (request, options = {}) => {
    if (request.model !== policy.deciding_model || (!permanent && Date.parse(policy.experiment.expires_at) <= Date.now())) {
      throw Object.assign(new Error('Jev experimental authority no longer covers this model request'), { code: 'jev_experiment_not_authorized' });
    }
    const result = await provider(request, options);
    // Every answer carries the digest of the exact body sent (state, questions
    // and criteria, after representation compaction) and the resolved Jev
    // basis. Coding, disposition and reconciliation receipt them from here.
    const receipt = { request_sha256: createHash('sha256').update(jevWireBody(request)).digest('hex'), jev_basis: policy.basis };
    const selections = Object.values(result.answers || {}).filter(answer => answer.type === 'choice').map(answer => answer.choice);
    const resolved = selections.length > 0 && selections.every(choice =>
      !/^(?:no_settlement|needs_more_work|needs_reasoning|needs_evidence|reasoning|ask(?:_|$)|unsupported|escalate)/.test(choice));
    if (resolved) hook({ request, answers: result.answers, model: result.model, resolved,
      execution: { root: { type: resourceType, id: resourceId } }, decisionKind,
      evidencePacketSha256: request.state?.packet_sha256 || request.state?.evidence_packet_sha256 || experimentDigest(request.state) });
    return { ...result, ...receipt };
  };
}

// Normal desktop and hosted enrollment have no expiry and use sampled reverse shadow. Legacy scoped
// experiments retain their original authority and expiration checks.
export async function readJevDecisionPolicy({ client, firmId, clientId, snapshot = null, env = process.env }) {
  const config = snapshot || await readClientConfigSnapshot(client, { firmId, clientId, strict: true });
  const baseline = getLane('jev_reconciliation').desktopDefault;
  const row = config[baseline.flagKey];
  const desktopDefault = isDesktopHostEnv(env) && row?.source === 'default'
    && clientFlagActs({ flagKey: baseline.flagKey, snapshot: config, envFallback: () => false, env });
  // The existing reviewed FI pilot configuration owns hosted activation. A
  // generic flag, inherited firm row, foreign entity or desktop marker cannot
  // authorize this path. New firm clients receive the same scoped birth row.
  const identity = resolveRuntimeHostIdentity(env);
  let hostedDefault = false;
  let hostedMarket = null;
  if (identity.runtime_host === 'vercel' && !identity.reason
      && row?.source === 'manual'
      && clientFlagActs({ flagKey: baseline.flagKey, snapshot: config, envFallback: () => false, env })) {
    const target = (await client.query(`select c.jurisdiction,c.entity_type from clients c
      join client_capability_config f on f.firm_id=c.firm_id and f.client_id=c.id
      where c.firm_id=$1 and c.id=$2 and f.flag_key=$3 and f.valid_to is null
        and f.source='manual' and f.reason=$4 and f.stage in ('canary','auto')`,
    [firmId, clientId, baseline.flagKey, CLOUD_PILOT_PROCESSING_VERSION])).rows[0];
    hostedMarket = HOSTED_ACCOUNTING_MARKETS.find(market => market.jurisdiction === target?.jurisdiction?.toUpperCase()
      && market.entityType === target.entity_type) || null;
    hostedDefault = Boolean(hostedMarket);
  }
  const permanent = desktopDefault || hostedDefault;
  const model = String(env[baseline.modelEnvironmentKey] || '').trim();
  if (permanent && !model) throw Object.assign(new Error('Configure the first-line provider model for this host.'), { code: 'jev_model_not_configured' });
  const policy = permanent
    ? { deciding_model: model, basis: hostedDefault ? hostedJevDefaultBasisFor(hostedMarket.jurisdiction) : 'desktop_default', authority_basis: hostedDefault ? CLOUD_PILOT_PROCESSING_VERSION : baseline.authority }
    : await readJevExperiment({ client, firmId, clientId, model });
  if (!policy) throw Object.assign(new Error('Jev requires desktop default enrollment or active client-scoped authority'), { code: 'jev_experiment_not_authorized' });
  return { policy, config, permanent };
}
