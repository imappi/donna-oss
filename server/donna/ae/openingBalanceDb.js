import { randomUUID } from 'node:crypto';
import { withFirmDbClient } from '../db/pool.js';
import { lockClientCloseBoundaryWithClient } from '../db/closeSerialization.js';
import { DEFAULT_FIRM_ID } from '../db/clients.js';
import { roleMeta, rolesForClass } from '../accountRoles.js';
import { provisionEntityReadiness } from '../runtimeReadiness.js';
import { assertActionCapability } from '../db/authority.js';
import { clientFlagActs, readClientConfigSnapshot } from '../clientConfig.js';
import { AE_OPENING_ASK_KIND, AE_OPENING_BALANCES_FLAG_KEY, AE_OPENING_LIMITATIONS, AE_OPENING_SUPPORTED_ROLES, aeOpeningDay, aeOpeningDigest, aeOpeningError, assertAeOpeningIdentity, normalizeAeOpeningTrialBalance } from './openingBalances.js';

// Rehydrate authority under the mutation transaction. A readable assignment,
// stale auth object or opaque desktop token is not journal authority.
const assertActor = async ({client,firmId,clientId,actorId,authorityBasis}) => {
  const deny = () => { throw Object.assign(aeOpeningError('AE_OPENING_AUTHORITY_REQUIRED', 'Opening intake requires a currently authorized owner or accounting approver.'), {statusCode:403}); };
  if (!actorId || ['system','unknown','workspace','access-token'].includes(actorId)
    || !['owner_portal_intake','owner_channel_confirmation'].includes(authorityBasis?.source)) deny();
  const members = (await client.query(`select * from firm_members where firm_id=$1
    and (id=$2 or lower(email)=lower($2)) for share`, [firmId,actorId])).rows;
  let principal;
  if (members.length === 1) {
    const row=members[0];
    if (row.status !== 'active' || ['viewer','read_only'].includes(row.access_level) || row.role === 'viewer') deny();
    principal={principalType:'firm_member',principalId:row.id,role:row.role,accessLevel:row.access_level,unrestricted:true};
  } else {
    if (members.length) deny();
    const collaborators=(await client.query(`select *, (ends_at is null or ends_at > now()) as within_engagement
      from firm_collaborators where firm_id=$1 and (id=$2 or lower(email)=lower($2)) for share`, [firmId,actorId])).rows;
    if (collaborators.length !== 1 || collaborators[0].status !== 'active' || !collaborators[0].within_engagement) deny();
    const row=collaborators[0];
    principal={principalType:'firm_collaborator',principalId:row.id,role:row.role,accessLevel:row.access_level,
      unrestricted:false,seatRole:row.seat_role,affiliation:row.affiliation};
    const assignments=(await client.query(`select * from client_assignments where firm_id=$1 and client_id=$2
      and principal_type='firm_collaborator' and principal_id=$3
      and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now()) for share`,
      [firmId,clientId,row.id])).rows;
    if (!assignments.some(a=>a.assignment_kind === 'capability' && a.status === 'active')) deny();
  }
  const capability=await assertActionCapability({firmId,clientId,principal,actionType:'sync_to_accounting',dbClient:client});
  // This new lane is born enforced, including the legacy gate's observe/error paths.
  if (!capability.allowed || !capability.decision || capability.error) deny();
  return {actorId:principal.principalId,actorType:principal.principalType};
};
const audit = async (client, { firmId, clientId, actorId, action, id, metadata }) => {
  await client.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
    values($1,$2,'client',$3,$4,'client_evidence_request',$5,$6::jsonb)`, [firmId,clientId,actorId,action,id,JSON.stringify(metadata)]);
};

export const readAeOpeningContextWithClient = async ({ client, firmId, clientId, asOf, sourceDocumentId = null }) => {
  await lockClientCloseBoundaryWithClient({client,firmId,clientId});
  // The readiness key comes before the identity row; NOWAIT yields before effects if a profile
  // writer already owns the row and is waiting on that key (Lesson AQ).
  await client.query('select pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [`entity-readiness:${firmId}:${clientId}`]);
  const row = (await client.query(`select id,firm_id,jurisdiction,entity_type,incorporation_date,profile,created_at
    from clients where firm_id=$1 and id=$2 and status='active' for no key update nowait`, [firmId,clientId])).rows[0];
  if (!row) throw aeOpeningError('AE_OPENING_CLIENT_REQUIRED', 'Current client identity was not found.');
  assertAeOpeningIdentity(row);
  const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  if (!clientFlagActs({ flagKey: AE_OPENING_BALANCES_FLAG_KEY, snapshot, envFallback: () => false })) throw aeOpeningError('AE_OPENING_DISABLED', 'AED opening intake is disabled for this client.');
  const day = aeOpeningDay(asOf);
  const periods = (await client.query(`select id,label,starts_on,ends_on,status from fiscal_years
    where firm_id=$1 and client_id=$2 and starts_on <= $3::date and ends_on >= $3::date for update`, [firmId,clientId,day])).rows;
  if (periods.length !== 1 || periods[0].status !== 'open') throw aeOpeningError('AE_OPENING_OPEN_PERIOD_REQUIRED', 'Record exactly one open fiscal period covering the opening date.');
  const period = { ...periods[0], starts_on: aeOpeningDay(periods[0].starts_on), ends_on: aeOpeningDay(periods[0].ends_on) };
  if (day !== period.starts_on) throw aeOpeningError('AE_OPENING_PERIOD_START_REQUIRED', 'Opening date must equal the recorded fiscal-period start.');
  if (!row.incorporation_date || aeOpeningDay(row.incorporation_date) >= day) throw aeOpeningError('OPENING_BALANCE_GREENFIELD_NO_SEED', 'An opening trial balance requires an existing business incorporated before the opening date.');
  const locked = await client.query(`select id from close_periods where firm_id=$1 and client_id=$2
    and (status='locked' or locked_at is not null) and period_start <= $3::date and period_end >= $3::date`, [firmId,clientId,day]);
  if (locked.rows.length) throw aeOpeningError('LEDGER_LOCKED_PERIOD_IMMUTABLE', 'Opening balances in a locked period are immutable.');
  const chart = (await client.query(`select id,code,name,account_type,normal_balance,canonical_role,currency,status from ledger_accounts
    where firm_id=$1 and client_id=$2 order by id for share`, [firmId,clientId])).rows;
  let source = null;
  if (sourceDocumentId) {
    source = (await client.query(`select id,firm_id,client_id,document_type,document_date,currency,payload,parse_status,checksum_sha256,storage_bucket,storage_object_key
      from documents where firm_id=$1 and client_id=$2 and id=$3 for share`, [firmId,clientId,sourceDocumentId])).rows[0];
    if (!source) throw aeOpeningError('AE_OPENING_SOURCE_REQUIRED', 'Select a current source document belonging to this client.');
    if (source.currency !== 'AED') throw aeOpeningError('AE_OPENING_SOURCE_CURRENCY_REQUIRED', 'The persisted source document must explicitly record AED.');
    if (['bank_statement','payment_account_statement'].includes(source.document_type)) throw aeOpeningError('AE_OPENING_FULL_TB_REQUIRED', 'A bank statement is not a complete opening trial balance.');
  }
  const existing = (await client.query(`select id,status,payload,journal_date from ledger_journals
    where firm_id=$1 and client_id=$2 and source_type='opening_balance' and source_id=$3 for update`, [firmId,clientId,`AE:${period.id}`])).rows[0] || null;
  if (existing && existing.status !== 'posted') throw aeOpeningError('LEDGER_LOCKED_PERIOD_IMMUTABLE', 'Only an open posted opening journal can be reconfirmed.');
  const identity = { ...row, incorporation_date: aeOpeningDay(row.incorporation_date) };
  const fingerprint = aeOpeningDigest({ identity, period, chart, source });
  return { row, period, chart, source, existing, fingerprint };
};
const closeAsk = async ({ client, firmId, clientId, ask, actorId, action, response }) => {
  const updated = await client.query(`update client_evidence_requests set status='resolved', responded_at=now(), resolved_at=now(), resolved_by=$4,
    response_payload=$5::jsonb, updated_at=now() where firm_id=$1 and client_id=$2 and id=$3 returning *`,
  [firmId,clientId,ask.id,actorId,JSON.stringify({ ...response, action, actor_id: actorId })]);
  await audit(client, { firmId,clientId,actorId,action:'ae.opening.ask_resolved',id:ask.id,metadata:{ action, ...response } });
  return updated.rows[0];
};
const createAsk = async ({ client, firmId, clientId, actorId, state, question, authorityBasis }) => {
  const id = `ae-opening-${randomUUID()}`;
  const result = await client.query(`insert into client_evidence_requests(id,firm_id,client_id,status,evidence_type,question,request_payload,created_by)
    values($1,$2,$3,'open','ae_opening_balance',$4,$5::jsonb,$6) returning *`,
  [id,firmId,clientId,question,JSON.stringify({ kind:AE_OPENING_ASK_KIND, ae_opening_balance:state }),actorId]);
  await audit(client, { firmId,clientId,actorId,action:'ae.opening.ask_created',id,metadata:{ phase:state.phase, proposal_digest:state.proposal_digest || null, authority_basis:authorityBasis } });
  return result.rows[0];
};
const currentAsks = async (client, firmId, clientId) => (await client.query(`select * from client_evidence_requests
  where firm_id=$1 and client_id=$2 and evidence_type='ae_opening_balance' and status in ('open','replied','draft') order by created_at for update`, [firmId,clientId])).rows;

export const submitAeOpeningIntakeWithClient = async ({ client, firmId, clientId, intake = {}, actorId, authorityBasis }) => {
  const actor = await assertActor({client,firmId,clientId,actorId,authorityBasis});
  actorId = actor.actorId;
  const context = await readAeOpeningContextWithClient({ client,firmId,clientId,asOf:intake.as_of,sourceDocumentId:intake.source_document_id });
  const verdict = normalizeAeOpeningTrialBalance({ intake,chart:context.chart,period:context.period,clientRow:context.row });
  if (verdict.terminal === 'proposal' && !context.source) throw aeOpeningError('AE_OPENING_SOURCE_REQUIRED', 'Select the source document for the complete trial balance.');
  if (verdict.terminal === 'proposal' && context.existing?.payload?.opening_source?.intake_digest === aeOpeningDigest(intake)) {
    const posted = (await client.query(`select * from client_evidence_requests where firm_id=$1 and client_id=$2
      and evidence_type='ae_opening_balance' and status='resolved'
      and response_payload->>'proposal_digest'=$3 order by resolved_at desc limit 1`,
      [firmId,clientId,context.existing.payload.opening_source.proposal_digest])).rows[0];
    if (posted?.response_payload?.post_context_fingerprint === context.fingerprint) return {action:'posted',receipt:posted.response_payload.receipt,replay:true};
  }
  const state = verdict.terminal === 'proposal' ? {
    phase:'confirm_request', intake, proposal:verdict.proposal, context_fingerprint:context.fingerprint,
    prior_opening_digest:context.existing?.payload?.opening_source?.proposal_digest || null,
    prior_journal_id:context.existing?.id || null
  } : { phase:'intake', as_of:intake.as_of, code:verdict.code };
  state.proposal_digest = aeOpeningDigest(state);
  const asks = await currentAsks(client,firmId,clientId);
  const identical = asks.find(a => a.request_payload.ae_opening_balance?.proposal_digest === state.proposal_digest);
  if (identical && asks.length === 1) return { action:state.phase === 'intake' ? 'missing' : 'request_confirmation', ask:identical, replay:true };
  for (const ask of asks) await closeAsk({client,firmId,clientId,ask,actorId,action:'superseded',response:{ authority_basis:authorityBasis }});
  const question = verdict.terminal === 'proposal'
    ? `Confirm the complete AED trial balance at ${intake.as_of}: debits ${verdict.proposal.totals.debit.toFixed(2)}, credits ${verdict.proposal.totals.credit.toFixed(2)}. Reply “confirm” to post these exact balances, or “cancel”.${context.existing ? ' This replaces your previous open-period opening after explicit reconfirmation.' : ''}`
    : verdict.question;
  const ask = await createAsk({client,firmId,clientId,actorId,state,question,authorityBasis});
  return { action:verdict.terminal === 'proposal' ? 'request_confirmation' : 'missing', ask };
};

// This is validation/receipt preparation, not a journal writer. The only caller
// that posts is the thin AE adapter beside FI/GB in db/ledger.js.
export const prepareAeOpeningPostWithClient = async ({client,firmId,clientId,askId,proposalDigest,actorId,authorityBasis}) => {
  const actor = await assertActor({client,firmId,clientId,actorId,authorityBasis});
  actorId = actor.actorId;
  const hint = (await client.query(`select request_payload from client_evidence_requests where firm_id=$1 and client_id=$2 and id=$3 and evidence_type='ae_opening_balance'`, [firmId,clientId,askId])).rows[0];
  if (!hint) throw aeOpeningError('AE_OPENING_ASK_REQUIRED', 'The current opening confirmation was not found.');
  const saved = hint.request_payload.ae_opening_balance;
  const context = await readAeOpeningContextWithClient({client,firmId,clientId,asOf:saved.intake?.as_of || saved.as_of,sourceDocumentId:saved.intake?.source_document_id});
  const ask = (await client.query(`select * from client_evidence_requests where firm_id=$1 and client_id=$2 and id=$3 for update`,[firmId,clientId,askId])).rows[0];
  const state = ask.request_payload.ae_opening_balance;
  if (state.phase !== 'confirm_request' || !proposalDigest || state.proposal_digest !== proposalDigest) throw aeOpeningError('AE_OPENING_CONFIRMATION_REQUIRED', 'Confirm the exact current trial-balance proposal.');
  const {proposal_digest: savedDigest, ...signedState} = state;
  if (aeOpeningDigest(signedState) !== savedDigest) throw aeOpeningError('AE_OPENING_CONFIRMATION_STALE', 'The saved proposal changed after confirmation was requested.');
  if (ask.status === 'resolved') {
    if (ask.response_payload.action === 'posted' && ask.response_payload.proposal_digest === proposalDigest
      && context.existing?.payload?.opening_source?.proposal_digest === proposalDigest) return { replay:ask.response_payload.receipt };
    throw aeOpeningError('AE_OPENING_CONFIRMATION_STALE', 'This opening proposal has already been superseded or cancelled.');
  }
  if (context.fingerprint !== state.context_fingerprint
    || (context.existing?.id || null) !== state.prior_journal_id
    || (context.existing?.payload?.opening_source?.proposal_digest || null) !== state.prior_opening_digest) throw aeOpeningError('AE_OPENING_CONFIRMATION_STALE', 'The client, chart, period, source or prior opening changed. Submit and confirm a fresh complete trial balance.');
  const verdict = normalizeAeOpeningTrialBalance({intake:state.intake,chart:context.chart,period:context.period,clientRow:context.row});
  if (verdict.terminal !== 'proposal' || aeOpeningDigest(verdict.proposal) !== aeOpeningDigest(state.proposal)) throw aeOpeningError('AE_OPENING_CONFIRMATION_STALE', 'The saved balances no longer agree with the current source context.');
  return { context,ask,state,actorId,proposal:verdict.proposal };
};
export const finishAeOpeningPostWithClient = async ({client,firmId,clientId,actorId,authorityBasis,prepared,receipt}) => {
  const after = await readAeOpeningContextWithClient({client,firmId,clientId,asOf:prepared.state.intake.as_of,sourceDocumentId:prepared.state.intake.source_document_id});
  await closeAsk({client,firmId,clientId,ask:prepared.ask,actorId,action:'posted',response:{receipt,proposal_digest:prepared.state.proposal_digest,post_context_fingerprint:after.fingerprint,authority_basis:authorityBasis}});
  return receipt;
};

// Account setup uses the existing chart writer and requires an explicit role
// choice. It neither interprets a trial balance nor seeds an opening journal.
const setupRoles = [...AE_OPENING_SUPPORTED_ROLES,'liability.sales_tax_payable',...rolesForClass('revenue'),...rolesForClass('expense')];
const setupAccount = async ({client,firmId,clientId,actorId,actorType,authorityBasis,intake={}}) => {
  const context=await readAeOpeningContextWithClient({client,firmId,clientId,asOf:intake.as_of});
  if (intake.account?.currency !== 'AED') throw aeOpeningError('AE_OPENING_CURRENCY_REQUIRED','Confirm AED explicitly for the selected account.');
  const selected=intake.account.account_id ? context.chart.find(a=>a.id === intake.account.account_id && a.status === 'active') : null;
  if (intake.account.account_id && !selected) throw aeOpeningError('AE_OPENING_ACCOUNT_REQUIRED','Select a current account belonging to this client.');
  const {canonical_role:role,name,code}=selected || intake.account;
  const meta=roleMeta(role);
  if (!setupRoles.includes(role) || typeof name !== 'string' || !name.trim() || name.length > 120
    || (!selected && (typeof code !== 'string' || !/^[A-Za-z0-9_-]{1,30}$/.test(code)))) throw aeOpeningError('AE_OPENING_ACCOUNT_REQUIRED','Choose a supported account role, name and unique code.');
  if (selected && (selected.currency && selected.currency !== 'AED'
    || selected.account_type !== meta.class || selected.normal_balance !== meta.normal_balance)) throw aeOpeningError('AE_OPENING_ACCOUNT_CLASS_CONFLICT','Existing account denomination or class conflicts with the requested setup.');
  const byRole=context.chart.filter(a=>a.canonical_role === role && a.status === 'active');
  if (meta.control && byRole.length > 1) throw aeOpeningError('AE_OPENING_ACCOUNT_CONFLICT','Repair ambiguous control accounts before confirming denomination.');
  if (!selected && byRole.length === 1 && byRole[0].code === code && byRole[0].name === name.trim() && byRole[0].currency === 'AED') return {action:'account_ready',account_id:byRole[0].id,actor_id:actorId,actor_type:actorType};
  if (!selected && (byRole.length || context.chart.some(a=>a.code === code || a.name === name.trim()))) throw aeOpeningError('AE_OPENING_ACCOUNT_CONFLICT','Use the existing account for this role or choose a unique code and name.');
  if (selected) {
    const foreign=(await client.query(`select ll.id from ledger_lines ll join ledger_journals lj on lj.id=ll.journal_id
      where ll.firm_id=$1 and ll.client_id=$2 and ll.account_id=$3 and lj.currency <> 'AED' limit 1`,[firmId,clientId,selected.id])).rows;
    if (foreign.length) throw aeOpeningError('AE_OPENING_CURRENCY_REQUIRED','An account with foreign-currency journal history cannot be redenominated.');
  }
  const {upsertLedgerAccountForJournal}=await import('../db/ledger.js');
  const accountId=await upsertLedgerAccountForJournal({client,firmId,clientId,currency:'AED',
    account:{code,name:name.trim(),canonical_role:role,type:meta.class,normal_balance:meta.normal_balance}});
  if (selected && accountId !== selected.id) throw aeOpeningError('AE_OPENING_ACCOUNT_CONFLICT','The current account identity does not match the existing named account writer.');
  await audit(client,{firmId,clientId,actorId,action:'ae.opening.account_setup',id:accountId,metadata:{canonical_role:role,currency:'AED',authority_basis:authorityBasis}});
  return {action:'account_ready',account_id:accountId,actor_id:actorId,actor_type:actorType};
};

export const actAeOpeningWithClient = async ({client,firmId,clientId,actorId,authorityBasis,action,intake,askId,proposalDigest,reply}) => {
  const actor = await assertActor({client,firmId,clientId,actorId,authorityBasis});
  actorId = actor.actorId;
  if (action === 'setup_account') return setupAccount({client,firmId,clientId,actorId,actorType:actor.actorType,authorityBasis,intake});
  if (action === 'submit') return submitAeOpeningIntakeWithClient({client,firmId,clientId,actorId,authorityBasis,intake});
  const hint = (await client.query(`select * from client_evidence_requests where firm_id=$1 and client_id=$2 and id=$3 and evidence_type='ae_opening_balance'`,[firmId,clientId,askId])).rows[0];
  if (!hint) throw aeOpeningError('AE_OPENING_ASK_REQUIRED','The opening ask was not found for this client.');
  const state = hint.request_payload.ae_opening_balance;
  await readAeOpeningContextWithClient({client,firmId,clientId,asOf:state.intake?.as_of || state.as_of});
  const ask = (await client.query(`select * from client_evidence_requests where firm_id=$1 and client_id=$2 and id=$3 for update`,[firmId,clientId,askId])).rows[0];
  const text = String(reply || '').trim().toLowerCase();
  if (action === 'cancel' || (action === 'reply' && ['cancel','no'].includes(text))) {
    if (ask.status !== 'resolved') await closeAsk({client,firmId,clientId,ask,actorId,action:'cancelled',response:{authority_basis:authorityBasis}});
    return {action:'cancelled',ask_id:ask.id};
  }
  if (action === 'confirm' || (action === 'reply' && ['yes','confirm','confirmed'].includes(text))) {
    const { postAeOpeningBalanceJournalWithClient } = await import('../db/ledger.js');
    try {
      const receipt = await postAeOpeningBalanceJournalWithClient({client,firmId,clientId,askId,proposalDigest:proposalDigest || (action === 'reply' ? state.proposal_digest : null),actorId,authorityBasis});
      return {action:'posted',receipt};
    } catch (error) {
      if (error.code !== 'AE_OPENING_CONFIRMATION_STALE' || ask.status === 'resolved') throw error;
      await closeAsk({client,firmId,clientId,ask,actorId,action:'stale',response:{code:error.code,authority_basis:authorityBasis}});
      const next = await createAsk({client,firmId,clientId,actorId,authorityBasis,
        state:{phase:'intake',as_of:state.intake.as_of,code:error.code},
        question:'The source or accounting context changed after this opening proposal. Review the current complete trial balance and submit it again for confirmation.'});
      return {action:'stale',code:error.code,error:error.message,ask:next};
    }
  }
  return {action:'missing',ask,limitations:AE_OPENING_LIMITATIONS};
};
export const actAeOpeningFromDb = async ({firmId=DEFAULT_FIRM_ID,...args}) => {
  const result = await withFirmDbClient(async client => {
  for (let attempt=0; attempt<3; attempt+=1) {
    await client.query('begin');
    try {
      const result = await actAeOpeningWithClient({client,firmId,...args});
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      if (error.code !== '55P03' || attempt === 2) throw error;
      // Wait without retaining readiness/ask/source locks, then rehydrate all
      // authority. Concurrent replay and a profile update can both complete.
      await client.query('select id from clients where firm_id=$1 and id=$2 for share', [firmId,args.clientId]);
    }
  }
  });
  // The source transaction must release its pool slot before the named
  // readiness lifecycle obtains its own connection (production pool size two).
      if (result.action === 'account_ready') {
        const readiness=await provisionEntityReadiness({withFirmDbClientFn:withFirmDbClient,firmId,clientId:args.clientId,
          creationPath:'generic_client_route',retry:true,lifecycle:'retry',compatibilityScope:'current_generation_compatibility',
          initiatingPrincipal:{actor_type:result.actor_type,actor_id:result.actor_id},authorityBasis:args.authorityBasis});
        result.readiness=readiness.row?.state || 'unknown';
      }
  return result;
};
export const readAeOpeningFromDb = async ({firmId=DEFAULT_FIRM_ID,clientId}) => withFirmDbClient(async client => {
  const snapshot=await readClientConfigSnapshot(client,{firmId,clientId});
  const enabled=clientFlagActs({flagKey:AE_OPENING_BALANCES_FLAG_KEY,snapshot,envFallback:()=>false});
  if (!enabled) return {enabled:false};
  const asks=(await client.query(`select * from client_evidence_requests where firm_id=$1 and client_id=$2 and evidence_type='ae_opening_balance' order by created_at desc limit 20`,[firmId,clientId])).rows;
  const accounts=(await client.query(`select id,code,name,canonical_role,currency from ledger_accounts where firm_id=$1 and client_id=$2 and status='active' order by code`,[firmId,clientId])).rows;
  const sources=(await client.query(`select id,filename,currency,document_type from documents where firm_id=$1 and client_id=$2 order by created_at desc limit 100`,[firmId,clientId])).rows;
  return {enabled:true,asks,accounts,sources,supported_roles:setupRoles,role_labels:Object.fromEntries(setupRoles.map(role=>[role,roleMeta(role).label])),limitations:AE_OPENING_LIMITATIONS};
});
