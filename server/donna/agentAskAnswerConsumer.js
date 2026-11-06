// Donna — the agent-ask ANSWER consumer (universal mentions slice 4;
// docs/design-donna-universal-mentions.md D7/§10, CLAUDE.md two-terminal
// generalization).
//
// An @agent ASK is a scoped runtime task on the artifact — NEVER a resting
// state: the mint opened the evidence case with a system-owned blocker and
// enqueued a durable `agent_answer.requested` outbox row (the producer,
// loopsShadowProducers.onAgentAskCreatedRequestAnswer). THIS consumer drains
// those rows and drives every one to a terminal that rests on a HUMAN or on
// nothing:
//
//   ANSWER   — the strong model answers the colleague's question from the
//              artifact's own data; the ask resolves, the answer lands as an
//              attributed agent comment on the artifact thread (audited, the
//              comment lane), and the ASKER gets an `ask_answered`
//              notification.
//   ESCALATE — the model cannot answer (or authority composition refuses, or
//              the request dead-letters on the retry bound): the ask resolves
//              as escalated, the artifact thread says so, and the INSTRUCTING
//              SEAT gets an `agent_escalation` notification — the ball
//              returns to the named human, never a parked hang.
//
// D7 — authority composition. Before any execution, the compiled task verb
// (`answer_evidence_request` — the routine-class verb the answer write IS)
// authorizes against min(rank(instructing seat's class), rank(agent's
// effective class)) via roleAuthority.decideInstructedAgentAction, from the
// provenance the mint PERSISTED on the ask (request_payload.instructed_by /
// .agent). Founder-only verbs never compose. The resolve receipt carries the
// full composition + both identities.
//
// Deliberate split from the CLIENT answer leg: resolveClientEvidenceRequestInDb
// is client-audience machinery end to end (review_state 'waiting' stamps,
// needs_review flips, client-reply resume + recode legs) — §5's law says each
// audience owns its delivery/resume leg, so the agent lane carries its own
// small resolve writer here (status → resolved + response_payload + audit in
// ONE transaction; NO transaction stamps, NO client-reply hooks — an agent's
// answer must never masquerade as a client reply).
//
// INVARIANTS (mirror askAutoDraftConsumer / reconciliationEvalConsumer):
//   INV-11  the model call runs OUTSIDE any txn.
//   F-19    the drain plans through planOutboxDispatch (stuck-window defer,
//           backoff, duplicate collapse, dead-letter) BEFORE claiming.
//   Step 6  decideLoopExecution re-gates per firm BEFORE spending tokens —
//           `proposal_creation` (canary+), INERT at shadow.
//   Model id is part of the receipt: the resolve audit records the RESPONSE
//           model id, never the requested one.

import {
  readDispatchableOutbox, claimOutboxRow, markOutboxDispatched,
  dropOutboxRow, failOutboxRow
} from './loopEventOutbox.js';
import { planOutboxDispatch } from './loopOutboxPlanner.js';
import { loopsTablesPresent } from './caseManager.js';
import {
  isLoopSystemEnabled, decideLoopExecution, readFirmExecutionContext
} from './loopExecutionGate.js';
import { decideInstructedAgentAction, agentEffectiveCapabilityClass } from './roles/roleAuthority.js';
import { proposeMatchesViaAnthropic, getApiKey, DEFAULT_MODEL } from './reconciliationLlmCore.js';
import { buildCommentPayload } from './mentions/commentEvents.js';
import { buildRuntimeNotificationRow } from './mentions/notificationEvents.js';
import { appendTransactionChatMessageInDb, appendDocumentChatMessageInDb } from './firmDb.js';
import { newMessageId } from './documentChat.js';
import { newTransactionChatMessageId } from './transactionChat.js';

const LOG_TAG = 'agentAskAnswerConsumer';

// The outbox event the producer enqueues (STRING LITERAL there — the registry
// source-scan reads literals). Exported for the registry cross-check.
export const AGENT_ANSWER_REQUEST_EVENT = 'agent_answer.requested';

// Per-loop tier key. No LoopDefinition exists for this lane yet (the task is
// outbox-driven end to end, the PR-1b shape); the key exists so a firm can
// stage this lane's tier independently (loops['agent_ask_resolution'].tier).
export const AGENT_ASK_LOOP_KEY = 'agent_ask_resolution';

// The bounded action: the answer is a proposal-class execution (canary+) —
// inert at shadow. The MINT is gated on the same decision at the route, so a
// shadow firm never accrues held agent asks at all.
const REQUESTED_ACTION = 'proposal_creation';

// The compiled task verb the answer write IS — routine class; D7 composes on
// it. (An agent task that wanted a heavier verb would compose on that verb;
// the v1 task is exactly "answer the question".)
export const AGENT_ANSWER_ACTION_TYPE = 'answer_evidence_request';

const DEFAULT_LIMIT = 10;

const norm = (v) => (v == null ? '' : String(v).trim());

// ── The model call (INV-11: no open txn) ─────────────────────────────────────

const AGENT_ANSWER_SYSTEM_PROMPT = `You are a specialist bookkeeping agent answering a COLLEAGUE'S question about one work artifact (a bank transaction or a document). Answer ONLY from the artifact data provided. You are not talking to the client, and you must not invent facts: if the data does not answer the question, say so and escalate.

Respond with STRICT JSON, nothing else:
{"can_answer": true|false, "answer": "<your answer, plain prose, cite the data>", "confidence": 0.0-1.0, "escalation_reason": "<why you cannot answer — only when can_answer is false>"}`;

const parseAgentAnswer = (text) => {
  try {
    const raw = String(text || '');
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('no JSON object');
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return {
      can_answer: parsed.can_answer === true,
      answer: norm(parsed.answer) || null,
      confidence: Number.isFinite(Number(parsed.confidence)) ? Number(parsed.confidence) : null,
      escalation_reason: norm(parsed.escalation_reason) || null
    };
  } catch {
    // A reply we cannot parse falls toward the human — never a confident
    // fabrication (the model answered, badly).
    return { can_answer: false, answer: null, confidence: null, escalation_reason: 'invalid_model_response' };
  }
};

const buildAgentAnswerUserPrompt = ({ ask, artifact }) => {
  const lines = [
    `QUESTION (from a colleague): ${norm(ask.question)}`,
    '',
    'ARTIFACT DATA:'
  ];
  if (artifact?.kind === 'transaction') {
    const t = artifact.row;
    lines.push(JSON.stringify({
      type: 'bank_transaction',
      id: t.id,
      date: t.date || t.transaction_date || null,
      description: t.description || null,
      money_in: t.money_in ?? null,
      money_out: t.money_out ?? null,
      currency: t.currency || t.account_currency || null,
      status: t.status || null,
      reconciliation_status: t.reconciliation_status || null,
      account_code: t.account_code || null,
      account_name: t.account_name || null
    }, null, 2));
  } else if (artifact?.kind === 'document') {
    const d = artifact.row;
    lines.push(JSON.stringify({
      type: 'document',
      id: d.id,
      document_type: d.document_type || null,
      vendor_name: d.vendor_name || null,
      customer_name: d.customer_name || null,
      filename: d.filename || null,
      document_date: d.document_date || null,
      total_amount: d.total_amount ?? null,
      currency: d.currency || null,
      payment_status: d.payment_status || null,
      parse_summary: d.parse_summary || null
    }, null, 2));
  } else {
    lines.push('(the artifact row could not be loaded — if the question cannot be answered without it, escalate)');
  }
  return lines.join('\n');
};

export const answerAgentAskViaModel = async ({
  ask, artifact, apiKey = getApiKey(), model = DEFAULT_MODEL, fetchImpl
} = {}) => {
  if (!apiKey) return { transport_failure: true, reason: 'no_api_key' };
  const result = await proposeMatchesViaAnthropic({
    systemPrompt: AGENT_ANSWER_SYSTEM_PROMPT,
    userPrompt: buildAgentAnswerUserPrompt({ ask, artifact }),
    candidateBankLines: [],
    model,
    apiKey,
    fetchImpl,
    parse: parseAgentAnswer,
    logTag: LOG_TAG
  });
  // The core short-circuits a NON-OK response to its match-shaped
  // { proposals: [], unmatchable_reason } WITHOUT calling our parser — a
  // transport failure (no model judgment existed), retried via the outbox.
  if (result && typeof result.can_answer === 'boolean') return result;
  return { transport_failure: true, reason: result?.unmatchable_reason || 'api_error' };
};

// ── The agent-lane resolve writer (ONE txn: update + audit) ─────────────────

const resolveAgentAskOnClient = async ({
  client, firmId, ask, outcome, reply = null, escalationReason = null,
  agent = {}, instructedBy = {}, composition = null, modelId = null
}) => {
  await client.query('begin');
  try {
    await client.query(
      `update client_evidence_requests
          set status = 'resolved',
              response_payload = response_payload || $3::jsonb,
              responded_at = coalesce(responded_at, now()),
              resolved_at = now(),
              resolved_by = $4,
              updated_at = now()
        where firm_id = $1 and id = $2`,
      [firmId, ask.id, JSON.stringify({
        reply: reply || null,
        outcome,
        ...(escalationReason ? { escalation_reason: escalationReason } : {}),
        answer_source: 'agent_runtime',
        answered_by_agent: agent.agent_id || null,
        ...(modelId ? { model: modelId } : {})
      }), agent.agent_id || 'donna']
    );
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       values ($1, $2, 'ai_occupant', $3, $4, 'client_evidence_request', $5, $6::jsonb)`,
      [
        firmId, ask.client_id, agent.agent_id || 'donna',
        outcome === 'answered' ? 'evidence_request.agent_answer' : 'evidence_request.agent_escalated',
        ask.id,
        JSON.stringify({
          transaction_id: ask.transaction_id || null,
          document_id: ask.request_payload?.document_id || null,
          // D7: BOTH identities on the receipt — the agent actor and the
          // instructing seat, with the composed classes.
          agent,
          instructed_by: instructedBy,
          ...(composition ? { authority_composition: composition } : {}),
          ...(escalationReason ? { escalation_reason: escalationReason } : {}),
          // the model id is part of the receipt (CLAUDE.md)
          model: modelId || null
        })
      ]
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  }
};

// Post the agent's answer (or escalation note) into the artifact thread as an
// attributed comment mentioning the ASKER, with the runtime notification row
// committed in the same appender transaction. Uses the appenders' own pool
// connections — called with no txn open on the drain's connection.
const postAgentComment = async ({
  firmId, ask, agent, instructedBy, text, notificationKind
}) => {
  const documentId = ask.request_payload?.document_id || null;
  const surface = ask.transaction_id ? 'transaction_chat' : (documentId ? 'document_chat' : null);
  if (!surface) return null; // standing-subject asks have no thread; the notification still lands via the resolve receipt readers
  const threadId = ask.transaction_id || documentId;
  const messageId = surface === 'document_chat'
    ? newMessageId({ documentId: threadId, kind: 'assistant' })
    : newTransactionChatMessageId({ transactionId: threadId, kind: 'assistant' });
  const askerRef = instructedBy?.principal_type && instructedBy?.principal_id
    ? [{
        actor_type: 'seat',
        principal_type: instructedBy.principal_type,
        principal_id: instructedBy.principal_id,
        display: instructedBy.display || null
      }]
    : [];
  const payload = buildCommentPayload({
    flavor: 'mention',
    mentions: askerRef,
    askId: ask.id
  });
  const notification = buildRuntimeNotificationRow({
    firmId,
    clientId: ask.client_id,
    kind: notificationKind,
    artifactType: surface === 'document_chat' ? 'document' : 'transaction',
    artifactId: threadId,
    principal: instructedBy,
    actorId: agent.agent_id || 'donna',
    actorDisplay: agent.display || agent.agent_id || 'Donna',
    text,
    askId: ask.id,
    messageId
  });
  const append = surface === 'document_chat' ? appendDocumentChatMessageInDb : appendTransactionChatMessageInDb;
  return append({
    firmId,
    clientId: ask.client_id,
    ...(surface === 'document_chat' ? { documentId: threadId } : { transactionId: threadId }),
    id: messageId,
    role: 'assistant',
    content: text,
    payload,
    actorType: 'llm',
    actorId: agent.agent_id || 'donna',
    notificationRows: notification ? [notification] : []
  });
};

// The escalation terminal, shared by the refused/can't-answer/dead-letter
// paths: resolve as escalated + tell the thread + notify the instructing
// seat. The ball is back with the named human.
export const escalateAgentAsk = async ({
  client, firmId, ask, agent, instructedBy, reason, composition = null, modelId = null,
  postCommentFn = postAgentComment
}) => {
  await resolveAgentAskOnClient({
    client, firmId, ask, outcome: 'escalated',
    escalationReason: reason, agent, instructedBy, composition, modelId
  });
  try {
    await postCommentFn({
      firmId, ask, agent, instructedBy,
      text: `I couldn't answer this one (${reason}) — handing it back to you.`,
      notificationKind: 'agent_escalation'
    });
  } catch (error) {
    // The resolve committed (the ask no longer rests on the agent); a failed
    // thread note must not resurrect the task. Loud, never silent.
    console.error(`[${LOG_TAG}] escalation comment failed for ask ${ask.id}: ${error?.message || error}`);
  }
  return { outcome: 'escalated', reason };
};

// ── One request ──────────────────────────────────────────────────────────────

export const runAgentAnswerRequest = async ({
  client, row, env = process.env, asOf = Date.now(), answerFn = answerAgentAskViaModel,
  postCommentFn = postAgentComment, fetchImpl
} = {}) => {
  if (!client || !row?.id) return { status: 'skipped', reason: 'no_row' };
  if (row.event_type !== AGENT_ANSWER_REQUEST_EVENT) {
    return { status: 'skipped', reason: 'wrong_event_type' };
  }
  const firmId = row.firm_id;
  const clientId = row.client_id;
  const askId = row.object_id;
  if (!firmId || !clientId || !askId) {
    await dropOutboxRow({ client, id: row.id, reason: 'malformed_request', expectedStatus: row.status, asOf });
    return { status: 'dropped', reason: 'malformed_request' };
  }

  // RE-GATE before claiming (a tier drop after enqueue still stops the spend).
  const { firmMetadata } = await readFirmExecutionContext(client, firmId);
  const gate = decideLoopExecution({
    loopKey: AGENT_ASK_LOOP_KEY, firmMetadata, requestedAction: REQUESTED_ACTION, env
  });
  if (!gate.allowed || gate.actionAllowed === false) {
    return { status: 'held', reason: gate.actionBlockedReason || gate.blockedReason };
  }

  // Load the ask. Gone/answered/cancelled → the request is satisfied.
  const askRes = await client.query(
    `select * from client_evidence_requests where firm_id = $1 and id = $2 limit 1`,
    [firmId, askId]
  );
  const ask = askRes.rows[0];
  if (!ask || ask.audience !== 'agent') {
    await dropOutboxRow({ client, id: row.id, reason: 'ask_absent_or_not_agent', expectedStatus: row.status, asOf });
    return { status: 'dropped', reason: 'ask_absent_or_not_agent' };
  }
  if (!['draft', 'open'].includes(String(ask.status || '').toLowerCase())) {
    await markOutboxDispatched({ client, id: row.id });
    return { status: 'dispatched', reason: 'ask_already_terminal' };
  }

  // Claim (optimistic single-flight).
  const claimed = await claimOutboxRow({
    client, id: row.id, expectedStatus: row.status, expectedAttempts: row.attempts || 0, asOf
  });
  if (!claimed) return { status: 'lost' };

  const instructedBy = ask.request_payload?.instructed_by || {};
  const agent = ask.request_payload?.agent || { agent_id: ask.addressee_principal_id || 'donna', role: null };
  agent.agent_id = agent.agent_id || ask.addressee_principal_id || 'donna';

  // D7 — compose BEFORE any execution, from the persisted provenance (the
  // instruction's authority at instruction time) + the agent's current class.
  const composition = decideInstructedAgentAction({
    actionType: AGENT_ANSWER_ACTION_TYPE,
    instructingClass: instructedBy.capability_class || null,
    agentClass: agentEffectiveCapabilityClass({ agentId: agent.agent_id, roleId: agent.role })
  });
  if (!composition.allowed) {
    const out = await escalateAgentAsk({
      client, firmId, ask, agent, instructedBy,
      reason: `authority composition refused: ${composition.reason}`, composition, postCommentFn
    });
    await markOutboxDispatched({ client, id: row.id });
    return { status: 'dispatched', ...out };
  }

  // Load the artifact for context (read-only, small).
  let artifact = null;
  if (ask.transaction_id) {
    const t = await client.query(
      `select * from transactions where firm_id = $1 and client_id = $2 and id = $3 limit 1`,
      [firmId, clientId, ask.transaction_id]
    );
    if (t.rows[0]) artifact = { kind: 'transaction', row: t.rows[0] };
  } else if (ask.request_payload?.document_id) {
    const d = await client.query(
      `select * from documents where firm_id = $1 and client_id = $2 and id = $3 limit 1`,
      [firmId, clientId, ask.request_payload.document_id]
    );
    if (d.rows[0]) artifact = { kind: 'document', row: d.rows[0] };
  }

  // THE ANSWER — strong model, NO open txn (INV-11). NEVER throws to caller.
  let verdict;
  try {
    verdict = await answerFn({ ask, artifact, fetchImpl });
  } catch (error) {
    await failOutboxRow({ client, id: row.id, error, asOf });
    return { status: 'failed', reason: error?.message || 'answer_threw' };
  }
  if (verdict?.transport_failure) {
    // No model judgment existed — retry via the outbox backoff; the
    // dead-letter bound converts an exhausted retry into an escalation.
    await failOutboxRow({ client, id: row.id, error: new Error(verdict.reason || 'transport_failure'), asOf });
    return { status: 'failed', reason: verdict.reason || 'transport_failure' };
  }

  const modelId = verdict.model || null;
  if (verdict.can_answer && verdict.answer) {
    await resolveAgentAskOnClient({
      client, firmId, ask, outcome: 'answered', reply: verdict.answer,
      agent, instructedBy, composition, modelId
    });
    try {
      await postCommentFn({
        firmId, ask, agent, instructedBy,
        text: verdict.answer,
        notificationKind: 'ask_answered'
      });
    } catch (error) {
      console.error(`[${LOG_TAG}] answer comment failed for ask ${ask.id}: ${error?.message || error}`);
    }
    await markOutboxDispatched({ client, id: row.id });
    return { status: 'dispatched', outcome: 'answered' };
  }

  const out = await escalateAgentAsk({
    client, firmId, ask, agent, instructedBy,
    reason: verdict.escalation_reason || 'model_could_not_answer', composition, modelId, postCommentFn
  });
  await markOutboxDispatched({ client, id: row.id });
  return { status: 'dispatched', ...out };
};

// ── The drain ────────────────────────────────────────────────────────────────

export const drainAgentAskAnswers = async ({
  client, firmId = null, clientId = null, limit = DEFAULT_LIMIT,
  env = process.env, asOf = Date.now(), policy, answerFn = answerAgentAskViaModel,
  postCommentFn = postAgentComment, fetchImpl
} = {}) => {
  if (!isLoopSystemEnabled(env)) return { skipped: true, reason: 'loops_off' };
  if (!client) return { skipped: true, reason: 'no_client' };
  if (!(await loopsTablesPresent(client))) return { skipped: true, reason: 'tables_absent' };

  const rows = await readDispatchableOutbox({ client, firmId, clientId, limit });
  const candidates = rows.filter((r) => r.event_type === AGENT_ANSWER_REQUEST_EVENT);
  const stats = {
    skipped: false, considered: rows.length, planned: candidates.length,
    dispatched: 0, dropped: 0, held: 0, failed: 0, lost: 0,
    deferred: 0, duplicates: 0, deadLettered: 0, escalated: 0
  };
  if (!candidates.length) return stats;

  const byId = new Map(candidates.map((r) => [String(r.id), r]));
  const plan = planOutboxDispatch({ rows: candidates, asOf, policy });
  stats.deferred = plan.deferred.length;

  for (const dup of plan.duplicates) {
    const raw = byId.get(String(dup.id));
    if (raw && await dropOutboxRow({ client, id: dup.id, reason: 'duplicate', expectedStatus: raw.status, asOf })) {
      stats.duplicates += 1;
    }
  }
  // THE BOUND (CLAUDE.md: "the agent answers or escalates on a bound"): a
  // dead-lettered request does not park the ask — it escalates it to the
  // instructing seat before the row is dropped.
  for (const dl of plan.deadLettered) {
    const raw = byId.get(String(dl.id));
    if (!raw) continue;
    if (await dropOutboxRow({ client, id: dl.id, reason: 'max_attempts', expectedStatus: raw.status, asOf })) {
      stats.deadLettered += 1;
      try {
        const askRes = await client.query(
          `select * from client_evidence_requests where firm_id = $1 and id = $2 limit 1`,
          [raw.firm_id, raw.object_id]
        );
        const ask = askRes.rows[0];
        if (ask && ask.audience === 'agent' && ['draft', 'open'].includes(String(ask.status || '').toLowerCase())) {
          const instructedBy = ask.request_payload?.instructed_by || {};
          const agent = ask.request_payload?.agent || { agent_id: ask.addressee_principal_id || 'donna', role: null };
          await escalateAgentAsk({
            client, firmId: raw.firm_id, ask, agent, instructedBy,
            reason: 'answer retries exhausted', postCommentFn
          });
          stats.escalated += 1;
        }
      } catch (error) {
        console.error(`[${LOG_TAG}] dead-letter escalation failed for outbox ${dl.id}: ${error?.message || error}`);
      }
    }
  }

  for (const planned of plan.ready) {
    const row = byId.get(String(planned.id));
    if (!row) continue;
    let out;
    try {
      out = await runAgentAnswerRequest({ client, row, env, asOf, answerFn, postCommentFn, fetchImpl });
    } catch (error) {
      try { await failOutboxRow({ client, id: row.id, error, asOf }); } catch { /* best-effort */ }
      try { console.warn(`[${LOG_TAG}] row ${row.id} threw: ${error?.message || error}`); } catch { /* never throw from logger */ }
      stats.failed += 1;
      continue;
    }
    if (out.status === 'dispatched') {
      stats.dispatched += 1;
      if (out.outcome === 'escalated') stats.escalated += 1;
    } else if (out.status === 'dropped') stats.dropped += 1;
    else if (out.status === 'held') stats.held += 1;
    else if (out.status === 'failed') stats.failed += 1;
    else if (out.status === 'lost') stats.lost += 1;
  }

  return stats;
};
