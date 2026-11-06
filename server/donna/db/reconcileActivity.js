// One display owner set and one source-owned deadline. This never changes the
// accounting verdict, admits a worker, or turns a match into a posted journal.
import { pendingMatchedCodingReconsiderationIdsWithClient } from './codingEvidence.js';
import { pendingPostingRecoveryIdsWithClient } from './codingRefusalRecovery.js';
import { ACTIVE_CODING_POLICY_FAILURE_SQL, unsettledTreatmentOnClearSource, refusedCrossWindowGroup } from '../codingPolicyRecovery.js';
import { clientFlagActs, ENTITY_READINESS_ADMISSION_FLAG, readClientConfigSnapshot } from '../clientConfig.js';
import { DEFAULT_DISPATCH_POLICY } from '../loopOutboxPlanner.js';

const CODING_JOB = 'parse-cron:coding_convergence';
const UPLOAD_QUIET_MS = 60_000;
const CYCLE_MS = 30 * 60_000;
const ms = value => value == null ? NaN : new Date(value).getTime();
const batchOf = doc => doc?.batch_id || doc?.payload?.batch_id;
const pendingJob = job => ['pending','running'].includes(job?.status)
  && (job.status === 'running' || job.attempt_count < job.max_attempts);
const terminal = row => ['auto_reconciled','on_owner'].includes(row.convergence_state);
// Evidence the posting writer is waiting on (codingEvidence.js). The line is
// owed, but what it is doing is waiting, not coding.
const EVIDENCE_WAIT = 'TRANSACTION_CODING_EVIDENCE_PENDING';

// A global cron receipt is not this client's receipt. The latest firm tick may
// omit a client because of the cap; omission never means running or failed.
const clientAttempt = (jobs, firmId, clientId) => {
  const tick = jobs.find(job => job.function_id === CODING_JOB && job.result?.coding_convergence);
  const envelope = tick?.result?.coding_convergence;
  const summary = envelope?.firms ? envelope.firms.find(firm => firm.firm_id === firmId)?.result : envelope;
  const result = summary?.coder?.find(row => row.client_id === clientId);
  return result ? { ...result, job_id: tick.id, at: tick.completed_at || tick.created_at } : null;
};

export const projectReconcileActivity = ({ transactions, documents, jobs, clock, observedAt,
  codingIds = new Set(), postingIds = new Set(), recoveryIds = new Set(), failureIds = new Map(),
  blockedClients = new Map(), hostWaitClients = new Set(), replyIds = new Set(), asks = [], matches = [], ownerQuestions = [],
  currentNativeReviewRows = new Set() }) => {
  const now = ms(observedAt), activity = new Map(), batches = new Map();
  const docs = new Map(documents.filter(doc => !doc.duplicate_of).map(doc => [doc.id,doc]));
  const orderedJobs = [...jobs].sort((a,b) => ms(b.created_at)-ms(a.created_at));
  const parseJob = doc => orderedJobs.find(job => job.function_id === 'parse-document'
    && job.payload?.firm_id === doc.firm_id && job.payload?.document_id === doc.id
    && job.payload?.parse_run_id === doc.parse_run_id);
  const receipt = (state, source, id, deadline, details = {}) => ({ state, source, receipt_id:String(id),
    observed_at:observedAt, valid_until:new Date(deadline).toISOString(), ...details });
  const group = (key, clientId) => {
    if (!batches.has(key)) batches.set(key,{key,clientId,documents:new Map(),transactions:[],events:[]});
    return batches.get(key);
  };
  // An answer reaches every row its question anchors, the same routing the
  // convergence law uses (collectOwnerAskSets): the minting line, each
  // statement-request anchor, and a document-anchored ask's document. The
  // reply-recovery worker's eligible IDs are the only owner of that work.
  const repliedAt = ask => ask?.response_payload?.responded_at || ask?.responded_at;
  const replyFor = anchors => ownerQuestions.filter(ask => replyIds.has(ask.id) && anchors(ask))
    .sort((a,b) => ms(repliedAt(b))-ms(repliedAt(a)))[0];
  const answersLine = id => ask => ask.transaction_id===id
    || (Array.isArray(ask.anchor_transaction_ids) && ask.anchor_transaction_ids.includes(id));
  const answersDocument = id => ask => ask.document_id===id;
  // Initial upload batches include all their sources. A later source joins an
  // existing case only through an actual match. Discovery resemblance is never
  // a display relationship; the recovery worker remains free to investigate it.
  for (const doc of docs.values()) {
    const reply = replyFor(answersDocument(doc.id));
    if (reply && ms(repliedAt(reply))>ms(doc.created_at)) {
      const cycle = group(`${doc.client_id}:reply:${reply.id}:${repliedAt(reply)}`,doc.client_id);
      cycle.documents.set(doc.id,doc);cycle.events.push(repliedAt(reply));
      continue;
    }
    const key = `${doc.client_id}:${batchOf(doc) || `document:${doc.id}`}`;
    group(key,doc.client_id).documents.set(doc.id,doc);
  }
  for (const tx of transactions) {
    const related = matches.filter(match => match.bank_transaction_id === tx.id
      && ['confirmed','auto_matched','suggested'].includes(match.status))
      .map(match => docs.get(match.matched_object_id)).filter(doc => doc?.client_id === tx.client_id);
    const source = docs.get(tx.document_id);
    const newest = [source,...related].filter(Boolean).sort((a,b) => ms(b.created_at)-ms(a.created_at))[0];
    const reply = replyFor(answersLine(tx.id));
    const replyAt = repliedAt(reply);
    if (replyAt && (!newest || ms(replyAt)>ms(newest.created_at))) {
      const cycle = group(`${tx.client_id}:reply:${reply.id}:${replyAt}`,tx.client_id);
      cycle.transactions.push(tx);cycle.events.push(replyAt);
      continue;
    }
    const key = `${tx.client_id}:${batchOf(newest) || (newest ? `document:${newest.id}` : `transaction:${tx.id}`)}`;
    group(key,tx.client_id).transactions.push(tx);
  }
  for (const batch of batches.values()) {
    const sources = [...batch.documents.values()];
    const times = (batch.events.length ? batch.events : sources.length ? sources.map(doc=>doc.created_at) : batch.transactions.map(tx=>tx.created_at))
      .map(ms).filter(Number.isFinite);
    if (!times.length) continue;
    // Every source gets its full arrival allowance. Publication is shared, so
    // the batch closes by the latest of those fixed source deadlines. Worker
    // heartbeats, polls and cron ticks cannot extend it.
    const started = Math.min(...times), deadline = Math.max(...times)+CYCLE_MS;
    const quietUntil = Math.min(deadline,Math.max(...times)+UPLOAD_QUIET_MS);
    let pending = now < quietUntil, running = false;
    const failures = new Map(), unfinishedSources = new Set(), refusedLines = new Set();
    // Rows that still owe work, each with its own phase. Only these carry
    // activity; a persisted terminal renders its verdict whatever the batch
    // is doing (2026-09-23: 7 posted lines and 17 owner questions read
    // "Processing" while 12 lines were still owed).
    const owed = new Map();
    for (const doc of sources) {
      const job = parseJob(doc);
      const unfinished = ['pending','processing'].includes(doc.parse_status) || pendingJob(job);
      if (unfinished) {
        pending = true; unfinishedSources.add(doc.id); owed.set(`document:${doc.id}`,'reading');
        running ||= job?.status === 'running' && ms(job.lease_expires_at)>now;
      }
      if (job?.status === 'dead' || (doc.parse_status === 'failed' && doc.parse_error?.retryable !== true)) {
        failures.set(`document:${doc.id}`,{code:'source_processing_failed',receipt_id:job?.id || doc.id});
      }
      const matched = matches.some(match=>match.matched_object_id===doc.id
        && ['suggested','confirmed','auto_matched'].includes(match.status));
      const question = ownerQuestions.some(ask => ask.document_id===doc.id && ['draft','open'].includes(ask.status));
      const replyWork = Boolean(replyFor(answersDocument(doc.id)));
      // The persisted document convergence owner covers the no-bank-line lane.
      if (replyWork || (!matched && !question && doc.convergence_state === 'hanging'
        && doc.convergence_reason !== 'no_settlement_in_scope')) {
        pending = true; unfinishedSources.add(doc.id);
        if (!owed.has(`document:${doc.id}`)) owed.set(`document:${doc.id}`,replyWork ? 'applying_reply' : 'matching');
      }
    }
    for (const tx of batch.transactions) {
      const attempt = clientAttempt(orderedJobs,tx.firm_id,tx.client_id);
      const failure = failureIds.get(tx.id);
      if (failure) failures.set(tx.id,failure);
      const currentAttempt = attempt && ms(attempt.at)>=started;
      const draft = ownerQuestions.some(ask=>ask.transaction_id===tx.id && ask.status==='draft' && ms(ask.created_at)>=started);
      const askWork = asks.find(ask=>ask.client_id===tx.client_id && ms(ask.created_at)>=started
        && ['pending','dispatching','failed'].includes(ask.status) && (!terminal(tx) || draft));
      if (askWork?.attempts>=DEFAULT_DISPATCH_POLICY.maxAttempts) failures.set(tx.id,{code:'ask_draft_exhausted',receipt_id:askWork.id});
      const replyWork = Boolean(replyFor(answersLine(tx.id)));
      const lineOwed = codingIds.has(tx.id) || postingIds.has(tx.id) || recoveryIds.has(tx.id) || replyWork || Boolean(askWork);
      if (lineOwed) pending = true;
      if ((!terminal(tx) || lineOwed) && hostWaitClients.has(tx.client_id)) pending = true;
      // A host that is booting or unavailable stops every owner below it, so
      // the wait outranks what the line would otherwise be doing.
      // This set contains the exact current row objects paired with the
      // snapshot's verified native projection, never ids or persisted stamps.
      // Accounting remains hanging. Quiet time alone is not new processing;
      // actual work and host waits still own their ordinary visible phase.
      const idleCurrentReview = currentNativeReviewRows.has(tx) && !lineOwed && !hostWaitClients.has(tx.client_id);
      if (!terminal(tx) && !idleCurrentReview) owed.set(tx.id, hostWaitClients.has(tx.client_id) ? 'waiting_for_host'
        : replyWork ? 'applying_reply'
        : tx.payload?.ledger_post_refusal?.code===EVIDENCE_WAIT ? 'awaiting_evidence'
        : postingIds.has(tx.id) ? 'posting'
        : codingIds.has(tx.id) ? 'coding'
        : askWork ? 'drafting_question'
        : recoveryIds.has(tx.id) ? 'rechecking'
        : 'in_progress');
      // A coder tick this client was refused admission to is that client's
      // receipt on the work the coder owed — never on a settled line.
      if ((!terminal(tx) || lineOwed) && currentAttempt && attempt.code==='ENTITY_READINESS_ADMISSION_BLOCKED' && !hostWaitClients.has(tx.client_id)) {
        failures.set(tx.id,{code:attempt.code || attempt.error,receipt_id:attempt.job_id});
      }
      // A refused client never borrows liveness from another client's cron.
      if ((!terminal(tx) || lineOwed) && blockedClients.has(tx.client_id)) refusedLines.add(tx.id);
      // Already-persisted correction refusals retain their honest cause. No
      // automatic correction grant is inferred from an activity projection.
      const correction = tx.payload?.coding_correction_required;
      if (correction?.status==='pending' && correction.recovery?.code) failures.set(tx.id,{code:correction.recovery.code,receipt_id:tx.id});
      // H-5a: no worker owns an unsure treatment the verified source's clear
      // printed tax should have settled. It carries its named cause at once,
      // never "in progress" and never the anonymous cycle expiry.
      const unsettled = !terminal(tx) && unsettledTreatmentOnClearSource(tx);
      if (unsettled) failures.set(tx.id,{code:unsettled.cause,refusal_code:unsettled.refusal_code,receipt_id:tx.id});
      // H-7b: a refund group refused for spanning policy windows rests out of
      // coder admission until its evidence changes; its persisted refusal is
      // the named cause.
      const crossWindow = !terminal(tx) && refusedCrossWindowGroup(tx);
      if (crossWindow) failures.set(tx.id,{code:crossWindow.code,refusal_code:crossWindow.code,receipt_id:tx.id});
    }
    // A refused client's receipt belongs to the work the refusal actually
    // stops — unfinished sources and pending or owed lines — and it outranks
    // the cycle expiry because it names the cause. A settled line or an open
    // owner question keeps its persisted terminal (2026-09-21: one shared host
    // refusal used to stamp all 36 rows of a batch Stalled, 26 of them already
    // auto-reconciled or on the owner).
    if (blockedClients.has(batch.clientId)) {
      const refusal = blockedClients.get(batch.clientId);
      for (const id of unfinishedSources) failures.set(`document:${id}`,refusal);
      for (const id of refusedLines) failures.set(id,refusal);
    }
    // During batch quiescence every OWED row uses the same publication
    // boundary. Inner leases affect only running/queued detail. They cannot
    // flash Stalled. Settled rows and owner questions are never stamped; the
    // batch speaks for its owed rows in one summary they all carry.
    if (pending && now>=started && now<deadline) {
      const reading = sources.filter(doc=>owed.get(`document:${doc.id}`)==='reading').map(doc=>doc.filename || doc.id);
      const summary = { batch_id:batch.key, reading,
        done:batch.transactions.filter(tx=>tx.convergence_state==='auto_reconciled').length,
        on_owner:batch.transactions.filter(tx=>tx.convergence_state==='on_owner').length,
        in_progress:[...owed].filter(([id,phase])=>phase!=='reading' && !failures.has(id)).length };
      for (const [id,phase] of owed) activity.set(id,receipt(running?'running':'queued','upload_batch',batch.key,deadline,
        {quiet_until:new Date(quietUntil).toISOString(),batch_id:batch.key,phase,batch:summary}));
    } else if (pending && now>=deadline) {
      // Expiry is the receipt for work nobody explained. A named failure (a
      // failed upload, an exhausted draft, a policy refusal) is the truthful
      // cause and outranks it. A settled line keeps its verdict even while a
      // recovery owner reconsiders it; the recovery changes the verdict or
      // nothing does.
      for (const tx of batch.transactions) if (owed.has(tx.id) && !failures.has(tx.id)) {
        failures.set(tx.id,{code:'processing_cycle_expired',receipt_id:batch.key});
      }
      for (const doc of sources) if ((['pending','processing'].includes(doc.parse_status) || doc.convergence_state==='hanging') && !failures.has(`document:${doc.id}`)) {
        failures.set(`document:${doc.id}`,{code:'processing_cycle_expired',receipt_id:batch.key});
      }
    }
    for (const [id,failure] of failures) activity.set(id,receipt('failed','persisted_refusal',failure.receipt_id,deadline,
      {reason_code:failure.code,...(failure.refusal_code?{refusal_code:failure.refusal_code}:{})}));
  }
  return activity;
};

export const readReconcileActivityWithClient = async (client, { firmId, transactions, documents, observedAt,
  matches = [], readinessByClient = new Map(), currentNativeReviewRows = new Set() }) => {
  const jobs = (await client.query(`select id,function_id,payload,status,attempt_count,max_attempts,
      run_at,locked_at,lease_expires_at,created_at,completed_at,result from local_jobs
    where function_id in ('parse-document','parse-cron:coding_convergence')
      and created_at > $1::timestamptz - interval '1 day'
      and (function_id='parse-cron:coding_convergence' or payload->>'firm_id'=$2)
    order by created_at desc limit 1000`,[observedAt,firmId])).rows;
  const clock = (await client.query(`select last_enqueued_tick from local_job_cron_state where function_id=$1`,[CODING_JOB])).rows[0];
  // Source-owned work exists on both hosts. Cloud cron does not populate the
  // desktop queue; absence of that sidecar must not publish an unfinished batch.
  const asks = (await client.query(`select id,client_id,status,attempts,created_at from loop_event_outbox
    where firm_id=$1 and event_type='ask_draft.requested' and status in ('pending','dispatching','failed')`,[firmId])).rows;
  const ownerQuestions = (await client.query(`select id,transaction_id,request_payload->>'document_id' as document_id,
      request_payload->'anchor_transaction_ids' as anchor_transaction_ids,status,created_at,responded_at,response_payload from client_evidence_requests
    where firm_id=$1 and status in ('draft','open','replied') and audience='client'`,[firmId])).rows;
  const replyIds = new Set();
  if (ownerQuestions.some(ask=>ask.status==='replied')) {
    const { DISCOVER_OWNER_REPLIES_SQL } = await import('../ownerReplyRecovery.js');
    const { listStructuredOwnerReplyEvidenceTypes } = await import('../statutoryRegistry.js');
    for (const row of (await client.query(DISCOVER_OWNER_REPLIES_SQL,[firmId,2147483647,listStructuredOwnerReplyEvidenceTypes()])).rows) replyIds.add(row.id);
  }
  // These are the worker's actual source-row admission predicates, without its
  // per-tick client cap. A waiting fourth client is queued, never "running".
  // Load the worker predicate after database modules initialize; importing the
  // worker here statically would cycle through firmDb and transactionChat.
  const codingIds = new Set((await client.query((await import('../codingConvergence.js')).CODING_CONVERGENCE_ITEMS_SQL,[firmId])).rows.map(row=>row.id));
  const activeFailures = (await client.query(`select t.id from transactions t where t.firm_id=$1 and (${ACTIVE_CODING_POLICY_FAILURE_SQL})`,[firmId])).rows;
  const failureIds = new Map(activeFailures.map(row=>[row.id,{code:'coding_policy_failed',receipt_id:row.id}]));
  const configs = new Map();
  const blockedClients = new Map(), hostWaitClients = new Set(), postingIds = new Set(), recoveryIds = new Set();
  const recoveryCandidates = new Map();
  for (const tx of transactions) {
    if (!configs.has(tx.client_id)) {
      try { configs.set(tx.client_id,await readClientConfigSnapshot(client,{firmId,clientId:tx.client_id,strict:true})); }
      catch {
        // A broken config plane must remain visible in the snapshot that carries
        // its repair receipt, rather than making that entire snapshot fail.
        configs.set(tx.client_id,null);
        blockedClients.set(tx.client_id,{code:'coding_policy_unavailable',receipt_id:tx.client_id});
      }
    }
    const config = configs.get(tx.client_id);
    if (!config) continue;
    const readiness = readinessByClient.get(tx.client_id);
    if (readiness && !readiness.mutation_ready && clientFlagActs({flagKey:ENTITY_READINESS_ADMISSION_FLAG,snapshot:config,envFallback:()=>false})) {
      // A host that is booting, renewing or unavailable is a shared, bounded
      // wait whose runner is the host renewal itself — for a ready entity
      // (host_unavailable) exactly as for a saga waiting on the host. Only an
      // ENTITY-side refusal is this client's own immediate failure.
      if (readiness.waiting_for_host || readiness.effective_state==='host_unavailable' || readiness.reason_code==='host_readiness_missing') hostWaitClients.add(tx.client_id);
      else blockedClients.set(tx.client_id,{code:readiness.reason_code || 'readiness_refused',receipt_id:readiness.receipt_ref?.id || tx.client_id});
      continue;
    }
    if (tx.coding_state==='proposed' && tx.payload?.ai_suggestion && !terminal(tx)
      && clientFlagActs({flagKey:'CODING_AUTO_POST',snapshot:config,envFallback:()=>false})) postingIds.add(tx.id);
    if (tx.coding_state==='applied' && !tx.payload?.ledger_journal_id && !tx.payload?.ledger_post_refusal
      && clientFlagActs({flagKey:'LEDGER_AUTO_POST',snapshot:config,envFallback:()=>false})) postingIds.add(tx.id);
    if (!tx.payload?.ai_suggestion && !tx.payload?.ledger_post_refusal) continue;
    if (!recoveryCandidates.has(tx.client_id)) recoveryCandidates.set(tx.client_id, []);
    recoveryCandidates.get(tx.client_id).push(tx.id);
  }
  for (const [clientId, ids] of recoveryCandidates) {
    const posting = await pendingPostingRecoveryIdsWithClient(client, firmId, ids).catch(() => new Set());
    const coding = await pendingMatchedCodingReconsiderationIdsWithClient(client, firmId, clientId,
      ids.filter(id => !posting.has(id))).catch(() => new Set());
    for (const id of [...posting, ...coding]) recoveryIds.add(id);
  }
  return projectReconcileActivity({transactions,documents,jobs,clock,observedAt,codingIds,postingIds,recoveryIds,
    failureIds,blockedClients,hostWaitClients,replyIds,asks,matches,ownerQuestions,currentNativeReviewRows});
};
