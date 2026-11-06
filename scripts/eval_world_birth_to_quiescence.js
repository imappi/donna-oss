#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { drainAskDraftRequests } from '../server/donna/askAutoDraftConsumer.js';
import { drainAutoSendAskBatches } from '../server/donna/askAutoSendProducer.js';
import {
  DISCOVER_CODER_CLIENTS_SQL,
  DISCOVER_SWEEP_CLIENTS_SQL,
  runCodingConvergenceInDb,
} from '../server/donna/codingConvergence.js';
import { applyDesktopHostRuntimeDefaults } from '../server/donna/desktop/hostRuntimeDefaults.js';
import { seedDesktopFirmMetadataWithClient } from '../server/donna/desktop/hostPlaneSeed.js';
import { dispatchQueuedParseJobsOnce } from '../server/donna/desktop/parseDocumentJob.js';
import {
  getFirmSnapshotFromDb,
  isFirmDatabaseConfigured,
  queryFirmDb,
  resolveClientEvidenceRequestInDb,
  updateFirmLoopSettingsInDb,
  withFirmDbClient,
} from '../server/donna/firmDb.js';
import { DISCOVER_LEDGER_POST_CLIENTS_SQL } from '../server/donna/ledgerAutoPost.js';
import { drainLoopInbox } from '../server/donna/loopInboxWorker.js';
import { dispatchLoopOutbox } from '../server/donna/loopOutboxDispatcher.js';
import { runReconciliationForBankStatementInDb } from '../server/donna/parseDocumentsDb.js';
import {
  GATE2B_C1_RECEIPT_VERSION,
  GATE2B_PREDECLARED_K,
  GATE2B_WORLD_PATH,
  buildGate2bC1RunReceipt,
  evaluateGate2bOwnerCheckpoints,
  evaluateGate2bQuiescence,
  evaluateGate2bStability,
  validateGate2bWorld,
} from '../server/donna/world/gate2bConvergenceProof.js';
import { createGate2bProviderCapture } from './eval_world_gate2b_provider_capture.js';
import { evaluateCandidateClose, readProof0PolicyPack } from '../server/donna/world/oracleSuite.js';
import { createDecisionReceipt } from '../server/donna/world/traceReceipts.js';
import { canonicalJson } from '../server/donna/world/unitExecutionReceipt.js';
import { renderWorldArtifacts } from '../server/donna/world/worldRenderer.js';
import {
  bindProductionOperations as bindGate2aOperations,
  continueGate2aLifecycle,
  requestApi,
  uploadAndRegisterRawDocument,
} from './eval_world_birth_to_parse.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_PRE_ANSWER_EPOCHS = 8;
const MAX_POST_ANSWER_EPOCHS = 8;
const REPLIED_PROBE_LIMIT = 500;

export function bindGate2bProductionOperations(overrides = {}) {
  return Object.freeze({
    isFirmDatabaseConfigured,
    continueGate2aLifecycle,
    uploadAndRegisterRawDocument,
    requestApi,
    dispatchQueuedParseJobsOnce,
    renderWorldArtifacts,
    withFirmDbClient,
    seedDesktopFirmMetadataWithClient,
    updateFirmLoopSettingsInDb,
    runReconciliationForBankStatementInDb,
    runCodingConvergenceInDb,
    drainAskDraftRequests,
    drainAutoSendAskBatches,
    drainLoopInbox,
    dispatchLoopOutbox,
    resolveClientEvidenceRequestInDb,
    getFirmSnapshotFromDb,
    queryFirmDb,
    readProof0PolicyPack,
    ...overrides,
  });
}

export async function loadGate2bWorld({ readFile = fs.readFile, worldPath = GATE2B_WORLD_PATH } = {}) {
  const world = JSON.parse(await readFile(path.join(ROOT, worldPath), 'utf8'));
  const validation = validateGate2bWorld(world);
  if (!validation.ok) throw coded('EAW_GATE2B_WORLD_INVALID', validation.errors.join('; '));
  return world;
}

/** The refusal boundary executes before capture installation or Gate 2A birth. */
export function assertGate2bLivePreflight({ budget, env = process.env, ops = bindGate2bProductionOperations() } = {}) {
  const missing = [];
  if (budget?.status !== 'APPROVED' || budget?.first_live_call_allowed !== true) missing.push('approved measured hard cap');
  if (budget?.k !== GATE2B_PREDECLARED_K) missing.push(`predeclared K=${GATE2B_PREDECLARED_K} budget`);
  if (env.EAW_GATE2B_ISOLATED_DB !== '1') missing.push('EAW_GATE2B_ISOLATED_DB=1 acknowledgement');
  if (!ops.isFirmDatabaseConfigured()) missing.push('configured PostgreSQL boundary');
  if (!String(env.DONNA_DESKTOP_BLOB_DIR || '').trim()) missing.push('desktop local object store');
  if (!String(env.DONNA_ACCESS_TOKEN || '').trim()) missing.push('authenticated desktop access token');
  const providers = new Set((budget?.lanes || []).map((lane) => lane.provider));
  if (providers.has('openai') && !String(env.OPENAI_API_KEY || '').trim()) missing.push('OPENAI_API_KEY');
  if (providers.has('anthropic') && !String(env.ANTHROPIC_API_KEY || '').trim()) missing.push('ANTHROPIC_API_KEY');
  if (missing.length) {
    throw coded('EAW_GATE2B_INCOMPLETE', `Gate 2B refused before the first live call: missing ${missing.join(', ')}.`);
  }
  return Object.freeze({ status: 'READY', k: GATE2B_PREDECLARED_K, providers: [...providers].sort() });
}

/** One actual, scoped production convergence epoch; no test scheduler exists. */
export async function driveGate2bProductionEpoch({ ops, firmId, clientId, env = process.env, asOf = Date.now() } = {}) {
  const reconciliation = await ops.runReconciliationForBankStatementInDb({ firmId, clientId });
  const coding = await ops.runCodingConvergenceInDb({ firmId, env, asOf });
  const draft = await ops.withFirmDbClient((client) => ops.drainAskDraftRequests({ client, firmId, clientId, env, asOf }));
  const send = await ops.withFirmDbClient((client) => ops.drainAutoSendAskBatches({ client, firmId, clientId, env }));
  const inbox = await ops.withFirmDbClient((client) => ops.drainLoopInbox({ client, workerId: `gate2b-${firmId}`, limit: 200 }));
  const outbox = await ops.withFirmDbClient((client) => ops.dispatchLoopOutbox({ client, firmId, clientId, env, asOf, limit: 200 }));
  const resumedCoding = await ops.runCodingConvergenceInDb({ firmId, env, asOf: asOf + 1 });
  return Object.freeze({ reconciliation, coding, draft, send, inbox, outbox, resumed_coding: resumedCoding });
}

/**
 * Observe the durable `replied` checkpoint while the named reply writer is
 * awaiting its real model-backed processing. The loop yields on DB reads, not
 * sleeps; a response that never exposes `replied` fails the certificate.
 */
export async function captureRepliedCheckpoint({ startReply, readAskStatus, readInventory, askId, maxProbes = REPLIED_PROBE_LIMIT } = {}) {
  if (![startReply, readAskStatus, readInventory].every((value) => typeof value === 'function')) {
    throw coded('EAW_GATE2B_REPLY_OBSERVER_INVALID', 'Reply checkpoint capture requires the actual reply and persisted readers.');
  }
  let settled = false;
  let result;
  let failure;
  const replyPromise = Promise.resolve().then(startReply).then(
    (value) => { settled = true; result = value; },
    (error) => { settled = true; failure = error; },
  );
  let checkpoint = null;
  let probes = 0;
  while (!settled && probes < maxProbes && !checkpoint) {
    probes += 1;
    const status = await readAskStatus(askId);
    if (status === 'replied') checkpoint = await readInventory();
    else await immediate();
  }
  await replyPromise;
  if (failure) throw failure;
  if (!checkpoint) throw coded('EAW_GATE2B_REPLIED_NOT_OBSERVED', 'The actual reply path did not expose a durable replied/hanging checkpoint before processing completed.');
  return Object.freeze({ checkpoint, result, probes });
}

export async function runGate2b({
  runToken,
  actor,
  budget,
  world = null,
  worldPath = GATE2B_WORLD_PATH,
  ops = bindGate2bProductionOperations(),
  env = process.env,
  observedAt = new Date().toISOString(),
} = {}) {
  assertBaseRunToken(runToken);
  if (!actor?.type || !actor?.id) throw coded('EAW_ACTOR_REQUIRED', 'Gate 2B needs the real approving operator actor type and id.');
  assertGate2bLivePreflight({ budget, env, ops });
  const declaredWorld = world || await loadGate2bWorld({ worldPath });
  const rendering = await ops.renderWorldArtifacts(declaredWorld);
  if (!rendering?.ok) throw coded('EAW_GATE2B_RENDER_FAILED', (rendering?.errors || []).join('; '));
  const artifactDigests = rawArtifactDigests(rendering);
  const capture = createGate2bProviderCapture({ budget });
  const runReceipts = [];
  const gate2aReceipts = [];
  const appliedDefaults = applyDesktopHostRuntimeDefaults(env).applied;
  capture.install();
  try {
    for (let index = 0; index < GATE2B_PREDECLARED_K; index += 1) {
      const childToken = `${runToken}-k${index + 1}`;
      capture.setRunToken(childToken);
      const result = await ops.continueGate2aLifecycle({
        runToken: childToken,
        actor,
        world: declaredWorld,
        worldPath,
        ops: bindGate2aOperations(ops.gate2aOverrides || {}),
        observedAt,
        continuation: (context) => runOneGate2bContinuation({
          context, ops, capture, budget, runToken: childToken,
          world: declaredWorld, rendering, artifactDigests, env,
        }),
      });
      gate2aReceipts.push(result.receipt);
      runReceipts.push(result.continuationResult);
    }
  } catch (error) {
    error.gate2bProviderCalls = capture.calls();
    error.gate2bPartialRuns = runReceipts;
    error.gate2aPartialReceipts = gate2aReceipts;
    throw error;
  } finally {
    capture.restore();
    for (const key of appliedDefaults) delete env[key];
  }
  const stability = evaluateGate2bStability({ runs: runReceipts, k: GATE2B_PREDECLARED_K });
  return Object.freeze({
    version: 'eaw.gate2b.k-schedule.v1',
    status: stability.status,
    world_id: declaredWorld.worldId,
    k: GATE2B_PREDECLARED_K,
    budget_receipt_digest: budget.receipt_digest || null,
    gate2a_receipts: gate2aReceipts,
    runs: runReceipts,
    stability,
  });
}

async function runOneGate2bContinuation({ context, ops, capture, runToken, world, rendering, artifactDigests, env }) {
  const { firmId, clientId, actor, registerStorageRef } = context;
  await ops.withFirmDbClient((client) => ops.seedDesktopFirmMetadataWithClient(client, { firmId }));
  await ops.updateFirmLoopSettingsInDb({
    firmId, autoSendClientAsks: true, actorId: actor.id, actorType: actor.type,
  });
  const configurationBefore = await readGate2bConfiguration({ ops, firmId, clientId, env });

  for (const [index, document] of world.gate2b.documents.slice(1).entries()) {
    const artifact = rendering.artifacts.find((item) => item.id === document.artifactId);
    if (!artifact) throw coded('EAW_GATE2B_ARTIFACT_MISSING', `Rendered artifact ${document.artifactId} is missing.`);
    const documentId = documentIdentity(clientId, document.artifactId);
    const uploaded = await ops.uploadAndRegisterRawDocument({
      ops,
      firmId,
      clientId,
      documentId,
      filename: document.filename,
      mimeType: document.mimeType,
      documentType: document.documentType,
      bytes: Buffer.from(artifact.contentBase64, 'base64'),
      uploadedAt: Date.parse(`${document.observedAt}T00:00:00.000Z`),
      batchId: `${runToken}-support-${index + 1}`,
      note: 'Gate 2B supporting evidence routed through the mounted raw-byte product contract.',
    });
    registerStorageRef(uploaded.storageRef);
  }
  // RT-08: the supporting documents' parses are `parse-document` local jobs
  // enqueued by the register route; dispatch that queue once (the real
  // handler over the real durable steps) instead of the drain backstop, which
  // no longer touches a row the queue owns.
  const dispatched = await ops.dispatchQueuedParseJobsOnce({
    client: { query: (text, params) => ops.queryFirmDb(text, params) },
    logger: { log: () => {}, info: () => {}, warn: (...args) => console.error(...args), error: (...args) => console.error(...args) },
  });
  if (!dispatched?.settled?.length) {
    throw coded('EAW_GATE2B_PARSE_JOB_MISSING', 'No parse-document job was dispatched for the supporting documents.');
  }

  const pre = await driveUntil({
    maxEpochs: MAX_PRE_ANSWER_EPOCHS,
    read: () => readGate2bInventory({ ops, world, firmId, clientId }),
    drive: (epoch) => driveGate2bProductionEpoch({ ops, firmId, clientId, env, asOf: Date.parse(world.gate2b.periodEnd) + epoch }),
    done: (inventory) => Boolean(selectOwnerAsk(inventory, world)),
  });
  const ownerAsk = selectOwnerAsk(pre.inventory, world);
  if (!ownerAsk) throw coded('EAW_GATE2B_OWNER_ASK_MISSING', 'The declared owner-only business-purpose fact did not reach a grounded owner ask.');
  assertLocalEvidenceWasNotReasked({ inventory: pre.inventory, world, ownerAsk });

  const hiddenFact = world.hiddenFacts.find((fact) => fact.id === world.gate2b.ownerHiddenFactId);
  const replied = await captureRepliedCheckpoint({
    askId: ownerAsk.id,
    startReply: () => ops.resolveClientEvidenceRequestInDb({
      firmId,
      evidenceRequestId: ownerAsk.id,
      reply: String(hiddenFact.value),
      actorId: actor.id,
      actorType: 'firm',
      answerSource: 'in_person',
    }),
    readAskStatus: async (askId) => {
      const result = await ops.queryFirmDb('select status from client_evidence_requests where firm_id = $1 and id = $2', [firmId, askId]);
      return result.rows?.[0]?.status || null;
    },
    readInventory: () => readGate2bInventory({ ops, world, firmId, clientId }),
  });

  const post = await driveUntil({
    maxEpochs: MAX_POST_ANSWER_EPOCHS,
    read: () => readGate2bInventory({ ops, world, firmId, clientId }),
    drive: (epoch) => driveGate2bProductionEpoch({ ops, firmId, clientId, env, asOf: Date.parse(world.gate2b.periodEnd) + 100 + epoch }),
    done: (inventory) => ownerAnswerReachedTerminal(inventory, ownerAsk),
  });
  const beforeEpoch = post.inventory;
  const epochReceipt = await driveGate2bProductionEpoch({
    ops, firmId, clientId, env, asOf: Date.parse(world.gate2b.periodEnd) + 1_000,
  });
  const afterEpoch = await readGate2bInventory({ ops, world, firmId, clientId });
  const configurationAfter = await readGate2bConfiguration({ ops, firmId, clientId, env });
  if (configurationAfter.digest !== configurationBefore.digest) {
    throw coded('EAW_GATE2B_CONFIGURATION_DRIFT', 'The model/configuration plane changed during the certified run.');
  }

  const quiescence = evaluateGate2bQuiescence({ before_epoch: beforeEpoch, after_epoch: afterEpoch });
  const answer = {
    ask_id: ownerAsk.id,
    hidden_fact_id: hiddenFact.id,
    fact_class: hiddenFact.kind,
    obligation_id: ownerAsk.obligation_id,
  };
  const ownerCheckpoints = evaluateGate2bOwnerCheckpoints({
    declared_hidden_facts: world.hiddenFacts,
    pre_answer: pre.inventory,
    replied: replied.checkpoint,
    post_resume: afterEpoch,
    answer,
  });
  const candidate = await projectCandidateClose({ ops, world, inventory: afterEpoch, firmId, clientId, hiddenFact });
  const oracle = evaluateCandidateClose(world, await ops.readProof0PolicyPack(), candidate.candidateClose);
  const isolation = await readGate2bIsolation({ ops, firmId, clientId });
  const spend = capture.receipt({ runToken, configurationDigest: configurationBefore.digest, artifactDigests });
  const providerCalls = capture.calls().filter((call) => call.run_token === runToken && call.outcome === 'success');
  const modelReceipts = providerCalls.map((call, index) => providerDecisionReceipt({
    call, index, world, configurationDigest: configurationBefore.digest, artifactDigests,
  }));
  return buildGate2bC1RunReceipt({
    world,
    run_token: runToken,
    model_receipts: modelReceipts,
    spend,
    quiescence,
    owner_checkpoints: ownerCheckpoints,
    oracle,
    isolation,
    accounting_entries: candidate.accountingEntries,
    terminal_inventory: afterEpoch.obligations.map((item) => ({
      canonical_identity: item.canonical_identity,
      source_item_id: item.source_item_id,
      state: item.state,
      responsible_actor: item.responsible_actor || null,
      fact_class: item.fact_class || null,
    })),
    ask_inventory: afterEpoch.asks.map((item) => ({
      canonical_identity: item.canonical_identity,
      obligation_id: item.obligation_id,
      fact_class: item.fact_class,
      audience: item.audience,
      terminal_status: item.status,
    })),
    artifact_digests: artifactDigests,
    configuration_digest: configurationBefore.digest,
    complete_epoch_receipt: JSON.parse(JSON.stringify(epochReceipt)),
  });
}

export async function readGate2bInventory({ ops, world, firmId, clientId } = {}) {
  const [snapshot, jobs, inbox, outbox, drafts, coder, sweeps, ledgerCandidates, journals] = await Promise.all([
    ops.getFirmSnapshotFromDb({ firmId }),
    ops.queryFirmDb(
      `select id::text, function_id, status, run_at, attempt_count, max_attempts, last_error
         from local_jobs
        where payload->>'firmId' = $1 or payload->>'firm_id' = $1
        order by id`,
      [firmId],
    ),
    ops.queryFirmDb('select id, event_type, object_id, status, attempts, last_error from loop_event_inbox where firm_id = $1 and client_id = $2 order by id', [firmId, clientId]),
    ops.queryFirmDb('select id, event_type, object_id, status, attempts, last_error from loop_event_outbox where firm_id = $1 and client_id = $2 order by id', [firmId, clientId]),
    ops.queryFirmDb("select id, status from client_ask_batches where firm_id = $1 and client_id = $2 and status = 'draft' order by id", [firmId, clientId]),
    ops.queryFirmDb(DISCOVER_CODER_CLIENTS_SQL, [firmId, 100]),
    ops.queryFirmDb(DISCOVER_SWEEP_CLIENTS_SQL, [firmId, 100]),
    ops.queryFirmDb(DISCOVER_LEDGER_POST_CLIENTS_SQL, [firmId, 100]),
    ops.queryFirmDb(
      `select j.id as journal_id, j.source_id, j.source_type, j.currency,
              l.id as line_id, l.direction, l.amount, l.account_code, l.account_name,
              a.canonical_role
         from ledger_journals j
         join ledger_lines l on l.journal_id = j.id
         join ledger_accounts a on a.id = l.account_id
        where j.firm_id = $1 and j.client_id = $2 and j.status <> 'voided'
        order by j.id, l.line_no`,
      [firmId, clientId],
    ),
  ]);
  const documents = (snapshot.documents || []).filter((row) => row.client_id === clientId);
  const transactions = (snapshot.transactions || []).filter((row) => row.client_id === clientId);
  const asks = (snapshot.clientEvidenceRequests || []).filter((row) => row.client_id === clientId);
  const eventByTransaction = mapTransactionsToWorldEvents({ transactions, world });
  const journalIdsBySource = new Map();
  for (const row of journals.rows || []) journalIdsBySource.set(row.source_id, [...(journalIdsBySource.get(row.source_id) || []), row.journal_id]);
  const askByTransaction = new Map();
  for (const ask of asks) if (ask.transaction_id) askByTransaction.set(ask.transaction_id, [...(askByTransaction.get(ask.transaction_id) || []), ask]);

  const obligationRows = transactions.map((transaction) => {
    const eventId = eventByTransaction.get(transaction.id) || `unmapped/${transaction.id}`;
    const openAsk = (askByTransaction.get(transaction.id) || []).find((ask) => ['draft', 'open'].includes(ask.status));
    return {
      id: `obligation/${eventId}`,
      canonical_identity: `terminal/${eventId}`,
      source_item_id: `source/${eventId}`,
      state: transaction.convergence_state || 'hanging',
      reason: transaction.convergence_reason || null,
      ask_id: openAsk?.id || null,
      responsible_actor: openAsk ? 'owner' : null,
      fact_class: openAsk?.evidence_type || null,
    };
  });
  const obligationByTransaction = new Map(transactions.map((row, index) => [row.id, obligationRows[index].id]));
  const askRows = asks.map((ask) => ({
    id: ask.id,
    canonical_identity: `ask/${eventByTransaction.get(ask.transaction_id) || ask.request_payload?.document_id || ask.id}/${ask.evidence_type || 'unknown'}`,
    transaction_id: ask.transaction_id || null,
    obligation_id: obligationByTransaction.get(ask.transaction_id) || `obligation/document/${ask.request_payload?.document_id || ask.id}`,
    status: ask.status,
    fact_class: ask.evidence_type || null,
    audience: ask.audience || 'client',
    question: ask.question || '',
  }));

  const workRows = [
    ...(drafts.rows || []).map((row) => ({ id: `ask_batch:${row.id}`, status: row.status })),
    ...(inbox.rows || []).filter((row) => ['pending', 'processing', 'failed'].includes(row.status)).map((row) => ({ id: `inbox:${row.id}`, status: row.status, event_type: row.event_type })),
    ...(outbox.rows || []).filter((row) => ['pending', 'dispatching', 'failed'].includes(row.status)).map((row) => ({ id: `outbox:${row.id}`, status: row.status, event_type: row.event_type })),
  ];
  const codingRows = [
    ...(coder.rows || []).map((row) => ({ id: `coder:${row.client_id}`, unseen_lines: row.unseen_lines })),
    ...(sweeps.rows || []).map((row) => ({ id: `coding_sweep:${row.client_id}` })),
    ...(ledgerCandidates.rows || []).map((row) => ({ id: `ledger_sweep:${row.client_id}`, unposted_lines: row.unposted_lines })),
  ];
  return {
    projector: 'reconcileConvergenceState',
    source_items: obligationRows.map((row) => ({ id: row.source_item_id })),
    documents: documents.map((row) => ({ id: row.id, status: normalizeDocumentStatus(row.parse_status) })),
    jobs: (jobs.rows || []).map((row) => ({ id: `local_job:${row.id}`, status: row.status, still_eligible: row.status === 'dead' })),
    reconciliation_candidates: (snapshot.reconciliationMatches || [])
      .filter((row) => row.client_id === clientId && ['pending', 'suggested'].includes(row.status))
      .map((row) => ({ id: row.id, status: row.status })),
    coding_candidates: codingRows,
    draft_send_work: workRows,
    asks: askRows,
    transactions: transactions.map((row) => ({
      id: row.id,
      event_id: eventByTransaction.get(row.id) || null,
      state: row.coding_state || row.status,
      journal_ids: [...new Set(journalIdsBySource.get(row.id) || [])].sort(),
    })),
    obligations: obligationRows,
    accounting_rows: journals.rows || [],
  };
}

async function readGate2bConfiguration({ ops, firmId, clientId, env }) {
  const [firm, flags, policies] = await Promise.all([
    ops.queryFirmDb('select metadata from firms where id = $1', [firmId]),
    ops.queryFirmDb(
      `select flag_key, stage, source, reason, valid_from, valid_to
         from client_capability_config
        where firm_id = $1 and client_id = $2 and valid_to is null
        order by flag_key`,
      [firmId, clientId],
    ),
    ops.queryFirmDb(
      `select lane, deciding_model, basis, reason, set_by_actor_type, set_by_actor_id, valid_from, valid_to
         from model_lane_policy
        where firm_id = $1 and (client_id = $2 or client_id is null) and valid_to is null
        order by lane, client_id nulls first`,
      [firmId, clientId],
    ).catch(() => ({ rows: [] })),
  ]);
  const body = {
    firm_metadata: firm.rows?.[0]?.metadata || {},
    client_flags: flags.rows || [],
    model_lane_policies: policies.rows || [],
    environment: Object.fromEntries(Object.keys(env)
      .filter((key) => /(?:MODEL|MATCHER|LOOPS|DISPOSITION|AUTO_POST|EXTRACTOR)/.test(key) && !/(?:KEY|TOKEN|SECRET)/.test(key))
      .sort()
      .map((key) => [key, String(env[key])])),
  };
  return { body, digest: digestCanonical(body) };
}

async function readGate2bIsolation({ ops, firmId, clientId }) {
  const result = await ops.queryFirmDb(
    `select
       (select count(*)::int from xero_connections where firm_id = $1 and client_id = $2) as xero,
       (select count(*)::int from qbo_connections where firm_id = $1 and client_id = $2) as qbo,
       (select count(*)::int from procountor_connections where firm_id = $1 and client_id = $2) as procountor,
       (select count(*)::int from hmrc_connections where firm_id = $1 and client_id = $2) as hmrc,
       (select count(*)::int from message_delivery_ledger where client_id = $2) as deliveries,
       (select count(*)::int from outbound_actions where firm_id = $1 and client_id = $2) as outbound_actions`,
    [firmId, clientId],
  );
  const counts = result.rows?.[0] || {};
  const external = ['xero', 'qbo', 'procountor', 'hmrc', 'deliveries', 'outbound_actions'].every((key) => Number(counts[key] || 0) === 0);
  return { status: external ? 'PASS' : 'FAIL', external_destinations: external ? 'isolated' : 'not_isolated', counts };
}

async function projectCandidateClose({ world, inventory, hiddenFact }) {
  const eventBySource = new Map(inventory.transactions.map((row) => [row.id, row.event_id]));
  const accountingEntries = inventory.accounting_rows.map((row) => ({
    canonical_identity: `entry/${eventBySource.get(row.source_id) || row.source_id}/${row.canonical_role || row.account_code}/${row.direction}`,
    id: row.line_id,
    event_id: eventBySource.get(row.source_id) || null,
    eventId: eventBySource.get(row.source_id) || null,
    obligation_id: `obligation/${eventBySource.get(row.source_id) || row.source_id}`,
    account_role: row.canonical_role || null,
    accountRole: row.canonical_role || null,
    amount: Number(row.amount || 0),
    currency: row.currency,
    authorityArtifactIds: [],
    artifactUses: [],
  }));
  const ownerEvent = world.events.find((event) => event.id === hiddenFact.eventId)
    || world.events.find((event) => (event.hiddenFactRefs || []).includes(hiddenFact.id));
  return {
    accountingEntries,
    candidateClose: {
      candidateId: `candidate/${world.worldId}`,
      entries: accountingEntries,
      actions: [],
      ownerFacts: [{ eventId: ownerEvent?.id || hiddenFact.eventId, kind: hiddenFact.kind }],
      causalOutcomes: [],
    },
  };
}

function providerDecisionReceipt({ call, index, world, configurationDigest, artifactDigests }) {
  const unknown = (reason) => ({ status: 'unknown', reason });
  const na = () => ({ status: 'not_applicable' });
  return createDecisionReceipt({
    decisionId: `decision/provider/${call.response_id}`,
    worldId: world.worldId,
    capabilityId: call.lane,
    stage: laneStage(call.lane),
    evidenceRefs: artifactDigests.map((digest) => `sha256:${digest}`),
    selectedAction: 'production_lane_response_persisted',
    authorityBasis: 'production_worker_plus_persisted_configuration',
    sourceTrust: 'declared_raw_artifact_and_owner_fact_boundary',
    reversibility: 'isolated_eaw_lifecycle',
    externalConsequence: 'isolated_bookkeeping_state',
    nextState: 'production_worker_continued',
    modelId: call.model_id,
    model_source: 'provider_response',
    model_artifact: {
      provider: call.provider,
      base_model_id: call.model_id,
      base_model_digest: unknown('provider does not publish an artifact digest'),
      adapter_id: na(), adapter_digest: na(),
      quantization: unknown('provider does not disclose serving quantization'),
      runtime: 'provider-managed',
      runtime_version: unknown('provider does not disclose runtime version'),
      vision_projector_digest: na(),
      tool_protocol_version: unknown('lane-specific protocol recorded in configuration digest'),
      prompt_snapshot_id: unknown('prompt content is not retained by the provider capture'),
      retrieval_snapshot_id: na(),
      routing_snapshot_id: configurationDigest,
      hardware_profile: unknown('provider-managed hardware is undisclosed'),
      execution_mode: 'frontier',
      model_id_source: 'provider_response', network_egress: true, fallback_occurred: false,
    },
    runtimeSnapshot: { response_id: call.response_id, request_digest: call.request_digest, configuration_digest: configurationDigest },
    expectedState: 'provider_response_recorded', observedState: 'provider_response_recorded',
    confidence: 'receipt', sequence: index + 1,
  });
}

async function driveUntil({ maxEpochs, read, drive, done }) {
  let inventory = await read();
  const epochs = [];
  for (let epoch = 0; epoch < maxEpochs && !done(inventory); epoch += 1) {
    epochs.push(await drive(epoch));
    inventory = await read();
  }
  return { inventory, epochs };
}

function selectOwnerAsk(inventory, world) {
  const hidden = world.hiddenFacts.find((fact) => fact.id === world.gate2b.ownerHiddenFactId);
  const expectedEventId = hidden?.eventId || world.events.find((event) => event.type === 'director_paid_charge')?.id;
  const transaction = inventory.transactions.find((row) => row.event_id === expectedEventId);
  if (!transaction) return null;
  const ask = inventory.asks.find((row) => row.transaction_id === transaction.id && ['draft', 'open'].includes(row.status) && row.fact_class === hidden.kind);
  return ask ? { ...ask, obligation_id: `obligation/${expectedEventId}` } : null;
}
function assertLocalEvidenceWasNotReasked({ inventory, world, ownerAsk }) {
  const localReceipt = world.gate2b.documents.find((doc) => doc.documentType === 'receipt');
  const localCompleted = inventory.documents.some((doc) => doc.id.endsWith(slug(localReceipt.artifactId)) && doc.status === 'completed');
  if (!localCompleted) throw coded('EAW_GATE2B_LOCAL_EVIDENCE_NOT_COMPLETED', 'The declared local receipt was not completed before the owner ask.');
  if (ownerAsk.fact_class !== 'business_purpose') throw coded('EAW_GATE2B_LOCAL_EVIDENCE_REASKED', 'The owner ask requested evidence that the isolated world already supplied.');
}
function ownerAnswerReachedTerminal(inventory, ownerAsk) {
  const ask = inventory.asks.find((row) => row.id === ownerAsk.id);
  const obligation = inventory.obligations.find((row) => row.id === ownerAsk.obligation_id);
  return ask?.status === 'resolved' && (obligation?.state === 'auto_reconciled' || (obligation?.state === 'on_owner' && obligation.ask_id !== ownerAsk.id));
}
export function mapTransactionsToWorldEvents({ transactions, world }) {
  const out = new Map();
  const used = new Set();
  for (const transaction of transactions) {
    // getFirmSnapshotFromDb intentionally projects PostgreSQL DATE as `date`
    // (a calendar string) so browser/runtime consumers never inherit timezone
    // drift. Keep the raw column fallback for bounded runner fixtures and direct
    // query shapes, but consume the mounted snapshot contract first.
    const date = calendarDate(transaction.date ?? transaction.transaction_date);
    const amountIn = Number(transaction.money_in || 0);
    const amountOut = Number(transaction.money_out || 0);
    const matches = world.events.filter((event) => {
      if (used.has(event.id) || calendarDate(event.occurredAt) !== date) return false;
      const effects = event.monetaryEffects || {};
      const expectedIn = Number(effects.settled || effects.moneyIn || effects.money_in || 0);
      const expectedOut = Number(effects.amount || effects.moneyOut || effects.money_out || 0);
      return (amountIn > 0 && Math.abs(amountIn - expectedIn) < 0.005)
        || (amountOut > 0 && Math.abs(amountOut - expectedOut) < 0.005);
    });
    if (matches.length === 1) { out.set(transaction.id, matches[0].id); used.add(matches[0].id); }
  }
  return out;
}
function rawArtifactDigests(rendering) {
  return rendering.artifacts.map((artifact) => sha256(Buffer.from(artifact.contentBase64, 'base64'))).sort();
}
function normalizeDocumentStatus(status) {
  if (status === 'completed' || status === 'skipped') return 'completed';
  return status || 'missing';
}
function documentIdentity(clientId, artifactId) { return `${clientId}-${slug(artifactId)}`; }
function slug(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function laneStage(lane) {
  if (/extract|router|classif/.test(lane)) return 'extracted_structured_state';
  if (/ask|owner/.test(lane)) return 'owner_ask_and_response';
  if (/recon|coding|disposition/.test(lane)) return 'authority_decision';
  return 'posting_reconciliation_or_blocked_obligation';
}
function assertBaseRunToken(value) {
  if (!/^[a-z0-9-]+$/.test(value || '')) throw coded('EAW_RUN_TOKEN_REQUIRED', 'A deterministic lowercase --run-token is required.');
}
function assertApi(response, expected, code) {
  if (response?.statusCode !== expected) throw coded(code, response?.json?.error || response?.body || `Expected HTTP ${expected}.`);
}
function calendarDate(value) {
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  return '';
}
function digestCanonical(value) { return createHash('sha256').update(canonicalJson(JSON.parse(JSON.stringify(value)))).digest('hex'); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function immediate() { return new Promise((resolve) => setImmediate(resolve)); }
function coded(code, message) { return Object.assign(new Error(message), { code }); }

export function parseArgs(argv) {
  const args = { runToken: null, actorType: 'firm_operator', actorId: null, budgetPath: null, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    if (token === '--run-token') { args.runToken = value; index += 1; }
    else if (token === '--actor-type') { args.actorType = value; index += 1; }
    else if (token === '--actor-id') { args.actorId = value; index += 1; }
    else if (token === '--budget') { args.budgetPath = value; index += 1; }
    else if (token === '--output') { args.output = value; index += 1; }
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    const budget = args.budgetPath ? JSON.parse(await fs.readFile(args.budgetPath, 'utf8')) : null;
    const receipt = await runGate2b({
      runToken: args.runToken,
      actor: { type: args.actorType, id: args.actorId },
      budget,
    });
    const text = `${JSON.stringify(receipt, null, 2)}\n`;
    if (args.output) await fs.writeFile(args.output, text, { flag: 'wx' });
    else process.stdout.write(text);
  } catch (error) {
    const body = {
      version: GATE2B_C1_RECEIPT_VERSION,
      status: error.code === 'EAW_GATE2B_INCOMPLETE' ? 'INCOMPLETE' : 'FAIL',
      failure: { code: error.code || 'EAW_GATE2B_FAILED', message: error.message },
      first_live_call_made: Array.isArray(error.gate2bProviderCalls) && error.gate2bProviderCalls.length > 0,
      provider_attempts: Array.isArray(error.gate2bProviderCalls) ? error.gate2bProviderCalls.length : 0,
      partial_runs: error.gate2bPartialRuns || [],
    };
    const text = `${JSON.stringify(body, null, 2)}\n`;
    if (args.output) await fs.writeFile(args.output, text, { flag: 'wx' });
    else process.stderr.write(text);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
