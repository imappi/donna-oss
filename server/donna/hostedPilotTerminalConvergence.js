// Hosted processing already owns these workers, but a firm without a loop tier
// never reached bank disposition or material-held portal questions. Discover
// only the existing explicit client pilot grants; keep firm tiers, accounting
// authority and all external-send restrictions untouched.
import { withFirmDbClient } from './firmDb.js';
import { clientFlagActs, readClientConfigSnapshot, setClientFlagStage } from './clientConfig.js';
import { BANK_LINE_DISPOSITION_FLAG, CLOUD_PILOT_PROCESSING_FLAGS, CLOUD_PILOT_PROCESSING_VERSION, HOSTED_ACCOUNTING_MARKETS } from './cloudPilotConfig.js';
import { readInternalPilotAccessWithClient } from './internalPilotAccess.js';
import { resolveRuntimeHostIdentity } from './runtimeHostIdentity.js';
import { entityReadinessExhaustedRestSql } from './runtimeReadinessAdmission.js';
import { resolveFirmSuspension } from './loopExecutionGate.js';
import { runBankLineDispositionForClient } from './bankLineDispositionLlm.js';
import { readLaneDecidingPolicy } from './modelLanePolicy.js';
import { __createHeldMatchPortalAsksWithClient } from './db/asks.js';

// Every hosted market whose pilot rows run the accounting pipeline: the pilot
// row's reason, the jurisdiction and the legal form must all match one row.
const HOSTED_ACCOUNTING_MARKET_TRIPLES = JSON.stringify(HOSTED_ACCOUNTING_MARKETS
  .map(({ jurisdiction, entityType, version }) => ({ jurisdiction, legal_form: entityType, version })));

const CLIENT_SCAN_LIMIT = 25;
const MODEL_CALL_LIMIT = 2;

const acts = (snapshot, flagKey) => clientFlagActs({flagKey, snapshot, envFallback: () => false});

// Birth uses CLOUD_PILOT_PROCESSING_FLAGS. Heal only the one missing extension
// on a client that already has the complete, explicitly reviewed baseline.
// Any historical configuration for this key proves a deliberate choice;
// never resurrect revoked enrollment or override a firm/cohort pause.
export const healHostedPilotDispositionEnrollmentWithClient = async (client, {firmId, clientId} = {}) => {
  await client.query('select id from clients where firm_id=$1 and id=$2 for update', [firmId, clientId]);
  if (!await readInternalPilotAccessWithClient(client, {firmId, clientId})) return false;
  const snapshot = await readClientConfigSnapshot(client, {firmId, clientId, strict:true});
  if (snapshot?.[BANK_LINE_DISPOSITION_FLAG]) return false;
  const history = await client.query(`select 1 from client_capability_config
    where firm_id=$1 and client_id=$2 and flag_key=$3 limit 1`, [firmId, clientId, BANK_LINE_DISPOSITION_FLAG]);
  if (history.rowCount) return false;
  const rows = (await client.query(`select flag_key,stage,source,reason from client_capability_config
    where firm_id=$1 and client_id=$2 and valid_to is null`, [firmId, clientId])).rows;
  // Jev was added after this extension; old clients need not already have it.
  const prior = CLOUD_PILOT_PROCESSING_FLAGS.filter(key => ![BANK_LINE_DISPOSITION_FLAG,'JEV_RECONCILIATION'].includes(key));
  if (!prior.every(key => rows.some(row => row.flag_key === key && row.source === 'manual'
    && row.reason === CLOUD_PILOT_PROCESSING_VERSION && acts({[key]: row}, key)))) return false;
  await setClientFlagStage(client, {firmId, clientId, flagKey:BANK_LINE_DISPOSITION_FLAG,
    stage:'canary', source:'manual', reason:CLOUD_PILOT_PROCESSING_VERSION,
    actorType:'system', actorId:'hosted_pilot_terminal_convergence'});
  await client.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
    values($1,$2,'system','hosted_pilot_terminal_convergence','pilot.processing.extension_healed','client',$2,$3::jsonb)`,
  [firmId, clientId, JSON.stringify({flag_key:BANK_LINE_DISPOSITION_FLAG,
    authority_basis:'existing_explicit_client_processing_baseline', version:CLOUD_PILOT_PROCESSING_VERSION,
    material_authority_granted:false, external_sends:false})]);
  return true;
};

export const runHostedPilotTerminalConvergenceInDb = async ({firmId,
  runWorkerAdmissionFn = async ({work}) => work(), withClient = withFirmDbClient,
  runDispositionFn = runBankLineDispositionForClient
} = {}) => {
  if (resolveRuntimeHostIdentity().runtime_host !== 'vercel') return [];
  const candidates = await withClient(client => client.query(`select c.id as client_id,f.metadata
    from clients c join firms f on f.id=c.firm_id
    join client_capability_config p on p.firm_id=c.firm_id and p.client_id=c.id
      and p.flag_key='INTERNAL_PILOT_ACCESS' and p.source='manual'
      and p.stage='canary' and p.valid_to is null
    join jsonb_to_recordset($2::jsonb) as m(jurisdiction text, legal_form text, version text)
      on p.reason=m.version and upper(c.jurisdiction)=m.jurisdiction and c.entity_type=m.legal_form
    where c.firm_id=$1
      and not ${entityReadinessExhaustedRestSql('c.firm_id','c.id')}
      and exists (select 1 from transactions t where t.firm_id=c.firm_id and t.client_id=c.id
        and coalesce(t.coding_state,'') not in ('applied','posted','synced','closed')
        and coalesce(t.reconciliation_status,'') not in ('reconciled','explained')
        and (not exists (select 1 from client_evidence_requests ask where ask.firm_id=t.firm_id
          and ask.client_id=t.client_id and ask.transaction_id=t.id and ask.audience='client'
          and ask.status in ('draft','open','replied'))
          or exists (select 1 from client_evidence_requests ask where ask.firm_id=t.firm_id
            and ask.client_id=t.client_id and ask.transaction_id=t.id and ask.audience='client'
            and ask.status='draft' and ask.send_count=0 and ask.first_sent_at is null
            and ask.created_by='coding_auto_post'
            and ask.evidence_type='business_purpose' and ask.request_payload->>'channel'='portal'
            and ask.request_payload->>'authority_basis'='persisted_match_requires_owner_confirmation')))
    order by (select max(a.created_at) from audit_events a
      where a.firm_id=c.firm_id and a.client_id=c.id
        and a.action='pilot.processing.terminal_scan') asc nulls first,
      c.id limit $3`, [firmId, HOSTED_ACCOUNTING_MARKET_TRIPLES, CLIENT_SCAN_LIMIT]));
  const results = [];
  let remainingModelCalls = MODEL_CALL_LIMIT;
  for (const row of candidates.rows) {
    if (remainingModelCalls === 0) break;
    if (resolveFirmSuspension({firmMetadata:row.metadata})) continue;
    const scope = {firmId, clientId:row.client_id};
    try {
      // Rotate discovery independently of model verdicts. A denied or paused
      // client may never get one; a held-only client does not need one. Persist
      // the scan before admission so even a failed attempt yields its place
      // on the next tick, including firms larger than the bounded scan.
      await withClient(client => client.query(`insert into audit_events
        (firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
        values($1,$2,'system','hosted_pilot_terminal_convergence',
          'pilot.processing.terminal_scan','client',$2,'{"purpose":"bounded_discovery_rotation"}'::jsonb)`,
      [firmId,scope.clientId]));
      await withClient(async client => {
        await client.query('begin');
        try { await healHostedPilotDispositionEnrollmentWithClient(client, scope); await client.query('commit'); }
        catch (error) { await client.query('rollback'); throw error; }
      });
      await runWorkerAdmissionFn({...scope, work: () => withClient(async client => {
        if (!await readInternalPilotAccessWithClient(client, scope)) return;
        const snapshot = await readClientConfigSnapshot(client, {...scope, strict:true});
        const result = {client_id:scope.clientId};
        if (remainingModelCalls > 0 && acts(snapshot, BANK_LINE_DISPOSITION_FLAG)) {
          const decidingPolicy = await readLaneDecidingPolicy({client, ...scope, laneId:'bank_line_disposition'});
          result.bank_disposition = [];
          for (const direction of ['money_out','money_in']) {
            if (remainingModelCalls === 0) break;
            // Reserve before calling: an unexpected throw may occur after a
            // provider call. Only the worker's explicit zero-evaluation receipt
            // can refund the slot; held matches and disabled lanes cost none.
            remainingModelCalls -= 1;
            const stats = await runDispositionFn({client, ...scope, direction, maxTransactions:1, enabledOverride:true, decidingPolicy});
            if (stats.evaluated === 0) remainingModelCalls += 1;
            result.bank_disposition.push({direction, ...stats});
            if (stats.transport_failures || stats.disabled) break;
          }
        }
        if (acts(snapshot, 'CODING_AUTO_POST')) {
          result.portal_asks = await __createHeldMatchPortalAsksWithClient({client, ...scope});
        }
        results.push(result);
      })});
    } catch (error) {
      results.push({client_id:scope.clientId, outcome:'error', code:error?.code || null, error:error?.message || String(error)});
    }
  }
  return results;
};
