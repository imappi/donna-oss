// Birth equipment for the existing Finnish hosted firm-intake profile. Runs
// inside createClientInDb's transaction; never patches an existing book.
import { resolveRuntimeHostIdentity } from './runtimeHostIdentity.js';
import { setClientFlagStage, readClientConfigSnapshot, clientFlagActs } from './clientConfig.js';
import { seedPackPaletteChartWithClient } from './db/ledger.js';
import { SG_HOSTED_REVIEW_VERSION } from './internalPilotAccess.js';
import { CLOUD_PILOT_PROCESSING_FLAGS, CLOUD_PILOT_PROCESSING_VERSION, SG_HOSTED_REVIEW_STAGES, SG_NATIVE_PROCESSING_REVIEW_FLAG, HOSTED_MARKET_PROFILES } from './cloudPilotConfig.js';
import { readAccountingCurrency, readAccountingProfile } from '../../src/lib/accountingProfile.js';
import { readLaneDecidingPolicy, setLaneDecidingPolicy } from './modelLanePolicy.js';
import { DEFAULT_MODEL, getModel } from './reconciliationLlmCore.js';
import { resolveUnifiedProvider } from './unifiedExtractor.js';

export const nativeIntakeFailure = (code, message) => {
  throw Object.assign(new Error(message), { code, statusCode: 409 });
};

// Availability is descriptive. Birth repeats this read with the selector row
// locked in the creator's transaction; closing that row serializes revocation.
// The same firm-default selection read gates the US hosted birth
// (HOSTED_MARKET_PROFILES.US.birthSelectionFlag); flagKey names which.
export const readNativeProcessingSelectionWithClient = async (client, { firmId, lock = false, flagKey = SG_NATIVE_PROCESSING_REVIEW_FLAG } = {}) => {
  if (resolveRuntimeHostIdentity().runtime_host !== 'vercel') return { available: false };
  const args = [firmId, flagKey];
  const selected = (await (lock
    ? client.query(`select id,flag_key,stage,source,reason,set_by_actor_type,set_by_actor_id
        from client_capability_config where firm_id=$1 and client_id is null
          and flag_key=$2 and valid_to is null for share`, args)
    : client.query(`select id,flag_key,stage,source,reason,set_by_actor_type,set_by_actor_id
        from client_capability_config where firm_id=$1 and client_id is null
          and flag_key=$2 and valid_to is null`, args))).rows;
  const snapshot = await readClientConfigSnapshot(client, { firmId, clientId: null, strict: true });
  const row = selected.length === 1 ? selected[0] : null;
  const available = Boolean(row && clientFlagActs({ flagKey,
    snapshot, envFallback: () => false }) && clientFlagActs({ flagKey,
    snapshot: { [flagKey]: row }, envFallback: () => false }));
  return { available, ...(available ? { selection_id: row.id, receipt: row } : {}) };
};

export const validateNativeProcessingFacts = (facts, profile) => {
  const keys = 'accounting_system,accounting_view,bookkeeping_start_date,currency,selection_id';
  if (!facts || typeof facts !== 'object' || Array.isArray(facts) || Object.keys(facts).sort().join(',') !== keys
    || typeof facts.selection_id !== 'string' || !facts.selection_id
    || facts.currency !== 'SGD' || facts.accounting_view !== 'management_books' || facts.accounting_system !== 'none'
    || profile?.accounting_system !== facts.accounting_system
    || readAccountingProfile(profile).view.status !== 'stated'
    || readAccountingProfile(profile).view.value !== facts.accounting_view
    || readAccountingCurrency(profile).status !== 'stated' || readAccountingCurrency(profile).value !== facts.currency) {
    nativeIntakeFailure('SG_NATIVE_INTAKE_FACTS_REQUIRED', 'Confirm the bookkeeping start date, SGD, management books and Donna ledger for document processing and review.');
  }
};

export const seedHostedFirmClientWithClient = async (client, { firmId, clientId, creationAudit, birthContext = null } = {}) => {
  if (resolveRuntimeHostIdentity().runtime_host !== 'vercel'
    || creationAudit?.actorType !== 'firm_member'
    || creationAudit?.authorityBasis?.source !== 'authenticated_firm_create_route') return null;
  const target = (await client.query('select jurisdiction,entity_type,profile from clients where firm_id=$1 and id=$2 for update', [firmId, clientId])).rows[0];
  const singapore = target?.jurisdiction?.toUpperCase() === 'SG';
  const unitedStates = target?.jurisdiction?.toUpperCase() === 'US';
  if (unitedStates) {
    // US hosted pilot (docs/design-donna-us-hosted-lane.md): born ONLY when
    // the firm-default US_HOSTED_PILOT row acts — no row, and a US create is
    // exactly what it was before (the generic route, no stages, no chart).
    const market = HOSTED_MARKET_PROFILES.US;
    const selection = await readNativeProcessingSelectionWithClient(client, { firmId, lock: true, flagKey: market.birthSelectionFlag });
    if (!selection.available) return null;
    if (target.entity_type !== market.entityType) {
      throw Object.assign(new Error('The hosted US pilot currently supports limited liability companies (LLC).'), {code:'US_HOSTED_LEGAL_FORM_UNSUPPORTED',statusCode:422});
    }
    if (readAccountingCurrency(target.profile).value !== market.currency
      || target.profile?.accounting_system !== 'none'
      || readAccountingProfile(target.profile).view.value !== 'management_books') {
      throw Object.assign(new Error('The hosted US pilot requires explicit USD management books on the Donna ledger.'), {code:'US_HOSTED_IDENTITY_REQUIRED',statusCode:422});
    }
  }
  if (!singapore && !unitedStates && target?.jurisdiction?.toUpperCase() !== 'FI') return null;
  // Other SG forms retain their existing generic creation path. This profile
  // neither adopts an existing book nor infers identity from uploaded filenames.
  if (singapore && target.entity_type !== 'sg-pte') return null;
  if (!singapore && !unitedStates && target.entity_type !== 'fi-oy') throw Object.assign(new Error('The hosted Finnish pilot currently supports osakeyhtiö (Oy) companies.'), {code:'FI_HOSTED_LEGAL_FORM_UNSUPPORTED',statusCode:422});
  if (singapore && (readAccountingCurrency(target.profile).value !== 'SGD'
    || target.profile?.accounting_system !== 'none'
    || readAccountingProfile(target.profile).view.value !== 'management_books')) {
    throw Object.assign(new Error('Singapore document review requires explicit SGD management books on the Donna ledger.'), {code:'SG_HOSTED_REVIEW_IDENTITY_REQUIRED',statusCode:422});
  }
  const member = (await client.query("select id from firm_members where firm_id=$1 and id=$2 and status='active' for share", [firmId, creationAudit.actorId])).rows[0];
  if (!member) throw Object.assign(new Error('An active member must create the workspace.'), {code:'FIRM_ACCESS_DENIED',statusCode:403});
  const existing = (await client.query('select flag_key from client_capability_config where firm_id=$1 and client_id=$2 and valid_to is null', [firmId, clientId])).rows;
  const have = new Set(existing.map(row => row.flag_key));
  // FI and US: the accounting row of the one hosted-market table.
  const accounting = HOSTED_MARKET_PROFILES[unitedStates ? 'US' : 'FI'];
  const stages = singapore ? SG_HOSTED_REVIEW_STAGES : { ...accounting.baselineStages, ...Object.fromEntries(CLOUD_PILOT_PROCESSING_FLAGS.map(key => [key, 'canary'])) };
  for (const [flagKey, stage] of Object.entries(stages)) {
    if (have.has(flagKey)) continue;
    await setClientFlagStage(client, {firmId,clientId,flagKey,stage,source:'manual',
      reason:singapore ? SG_HOSTED_REVIEW_VERSION : CLOUD_PILOT_PROCESSING_FLAGS.includes(flagKey) ? CLOUD_PILOT_PROCESSING_VERSION : accounting.version,
      actorType:'firm_member',actorId:member.id});
  }
  // Birth only ever runs for a client this request created: a market that
  // declares a coded birth chart (FI Oy, FI-21) is born with it.
  const chart = await seedPackPaletteChartWithClient(client, {firmId,clientId,newBook:true, ...(birthContext ? {birthContext} : {})});
  if (!chart.seeded) throw Object.assign(new Error('Chart initialization failed; retry company creation.'), {code:singapore ? 'SG_HOSTED_CHART_REQUIRED' : unitedStates ? 'US_HOSTED_CHART_REQUIRED' : 'FI_HOSTED_CHART_REQUIRED',statusCode:503});
  if (singapore) {
    const receipt = {version:SG_HOSTED_REVIEW_VERSION,authority_basis:'authenticated_singapore_firm_creation',
      owner_provenance:{kind:'authenticated_firm_creation',actor_id:member.id},chart,stages,
      processing_scope:'document_processing_review_only',accounting_ready:false,
      material_authority_granted:false,automatic_posting:false,external_sends:false,filing:false};
    await client.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
      values($1,$2,'firm_member',$3,'pilot.prepared','client',$2,$4::jsonb)`, [firmId,clientId,member.id,JSON.stringify(receipt)]);
    return receipt;
  }
  // The governed matcher must own its lane before any worker can race it with
  // legacy transaction-intelligence suggestions. Preserve an inherited seat.
  await client.query('lock table model_lane_policy in share row exclusive mode');
  const inherited = await readLaneDecidingPolicy({client,firmId,clientId,laneId:'reconciliation_reasoning'});
  let birthPolicy = null;
  if (!inherited) {
    if (getModel() !== DEFAULT_MODEL || resolveUnifiedProvider({provider:'anthropic'})?.model !== DEFAULT_MODEL) {
      throw Object.assign(new Error('The configured reconciliation model needs operator review before company creation.'), {code:unitedStates ? 'US_HOSTED_MODEL_DEFAULT_CHANGED' : 'FI_HOSTED_MODEL_DEFAULT_CHANGED',statusCode:503});
    }
    birthPolicy = await setLaneDecidingPolicy({client,firmId,clientId,laneId:'reconciliation_reasoning',decidingModel:DEFAULT_MODEL,
      basis:'experiment',reason:accounting.birthPolicyReason,actorType:'firm_member',actorId:member.id,manageTransaction:false});
  }
  const receipt = {version:accounting.version,authority_basis:unitedStates ? 'authenticated_us_firm_creation' : 'authenticated_finnish_firm_creation',
    owner_provenance:{kind:'authenticated_firm_creation',actor_id:member.id},chart,stages,
    birth_model_policy_id:birthPolicy?.id || null,
    birth_model_policy:birthPolicy,
    ...(unitedStates ? {tax_posting:'gross_only'} : {}),
    material_authority_granted:false,external_sends:false,filing:false};
  await client.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
    values($1,$2,'firm_member',$3,'pilot.prepared','client',$2,$4::jsonb)`, [firmId,clientId,member.id,JSON.stringify(receipt)]);
  return receipt;
};
