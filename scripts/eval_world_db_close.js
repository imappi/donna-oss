#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as firmDb from '../server/donna/firmDb.js';
import {
  OPEN_OWNER_ASK_STATUSES,
  hasAnsweredOwnerAskInRequests,
  hasAnsweredSeatAskInRequests,
  hasOpenAgentAskInRequests,
  hasOpenOwnerAskInRequests,
  hasOpenSeatAskInRequests,
} from '../server/donna/reconcileConvergenceState.js';
import { deriveSiblingWorld } from '../server/donna/world/siblingWorld.js';

export const RECEIPT_VERSION = 'eaw.db-close-receipt.v2';
export const RUN_RECEIPT_VERSION = 'eaw.db-close-run.v2';
export const LEGACY_RECEIPT_VERSION = 'eaw.db-close-receipt.v1';
export const LEGACY_RUN_RECEIPT_VERSION = 'eaw.db-close-run.v1';
export const CANONICAL_PROJECTION_RECEIPT = Object.freeze({
  classification: 'canonical',
  projector: 'reconcileConvergenceState',
  open_customer_human_ask_statuses: Object.freeze([...OPEN_OWNER_ASK_STATUSES]),
  replied_ask_state: 'hanging',
});

// World artifact kinds mapped into the documents.document_type CHECK
// vocabulary (migrations 020/021/023) — raw kinds violate the constraint.
export const DOC_TYPE_BY_KIND = Object.freeze({
  bank_line: 'bank_statement',
  card_line: 'payment_account_statement',
  processor_report: 'payment_account_statement',
  invoice_pdf: 'sales_invoice',
  receipt_pdf: 'receipt'
});
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FAMILY_PATHS = Object.freeze([
  'data/worlds/slice1-gross-to-net-single.json',
  'data/worlds/slice1-batched-fx-fee-netted.json',
  'data/worlds/slice1-director-purpose-close.json'
]);
const REQUIRED = Object.freeze(Object.values(firmDb.EAW_CLOSE_COMPOSITION_BOUNDARY).flatMap((v) => Array.isArray(v) ? v : []));

export function bindProductionOperations(module = firmDb) {
  const missing = REQUIRED.filter((name) => typeof module[name] !== 'function');
  if (missing.length) throw coded('EAW_BOUNDARY_INCOMPLETE', `Production close boundary is missing: ${missing.join(', ')}`);
  return Object.freeze(Object.fromEntries(REQUIRED.map((name) => [name, module[name]])));
}

export function assertRunIdentity({ firmId, clientId }) {
  if (!/^eaw-[a-z0-9-]+$/.test(firmId || '')) throw coded('EAW_FIRM_ID_REQUIRED', 'firmId must be a non-empty eaw- identifier.');
  if (!clientId || !clientId.startsWith(`${firmId}-client-`)) throw coded('EAW_CLIENT_ID_REQUIRED', 'clientId must belong uniquely to the firm created by this run.');
}

export function compileWorldInput(world, { firmId, clientId }) {
  if (!world?.worldId || !Array.isArray(world.events) || !Array.isArray(world.artifacts)) throw coded('EAW_WORLD_INVALID', 'World is malformed.');
  const ids = new Set();
  const documents = world.artifacts.map((artifact, index) => {
    if (!artifact?.id || ids.has(artifact.id)) throw coded('EAW_OBSERVATION_INVALID', 'Artifact identifiers must be present and unique.');
    ids.add(artifact.id);
    return { id: `${clientId}-doc-${index}`, client_id: clientId, filename: `${index}-${artifact.kind || 'artifact'}.json`, document_type: DOC_TYPE_BY_KIND[artifact.kind] || 'unknown', status: 'received', source: 'eaw_world', document_date: world.effectiveDate, payload: artifact };
  });
  const transactions = world.events.filter((event) => ['processor_settlement', 'director_paid_charge', 'cash_movement'].includes(event.type)).map((event, index) => {
    const effects = event.monetaryEffects || {};
    const amount = Number(effects.settled ?? effects.amount);
    if (!Number.isFinite(amount) || amount <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(event.occurredAt || '')) throw coded('EAW_EVENT_INVALID', `Event ${event.id || index} has an invalid date or amount.`);
    const expense = event.type === 'director_paid_charge';
    return { id: `${clientId}-tx-${index}`, client_id: clientId, document_id: documents[0]?.id, date: event.occurredAt, description: event.id, money_in: expense ? 0 : amount, money_out: expense ? amount : 0, account_currency: effects.currency || 'GBP', status: 'ready', reconciliation_status: 'explained', coding_state: 'applied', account_code: expense ? '493' : '200', category: expense ? 'Travel and meals' : 'Sales', payload: { proposed_account: expense ? '493' : '200', account_name: expense ? 'Travel and meals' : 'Sales', support_status: 'sufficient', source_event_id: event.id } };
  });
  if (!transactions.length) throw coded('EAW_WORLD_INVALID', 'World supplies no closeable production transaction.');
  return { documents, transactions };
}

const CLOSED_PERIOD_STATUSES = Object.freeze(['locked', 'closed', 'archived', 'final']);

export function projectTerminalState({ preview, exceptions, evidenceRequests }) {
  const requests = Array.isArray(evidenceRequests?.requests) ? evidenceRequests.requests : [];
  const openRequests = requests.filter((request) =>
    hasOpenOwnerAskInRequests([request]) || hasOpenSeatAskInRequests([request]));
  const answeredRequests = requests.filter((request) =>
    hasAnsweredOwnerAskInRequests([request]) || hasAnsweredSeatAskInRequests([request]));
  const agentRequests = requests.filter((request) => hasOpenAgentAskInRequests([request]));
  const blockers = (exceptions?.exceptions || []).filter((e) => e.severity === 'blocker' || e.blocking === true);
  // A LOCKED period is the strongest production terminal signal (the close is
  // done and immutable); lockable is the pre-lock form of the same T1.
  const periodStatus = preview?.ledger_period?.status || preview?.close_preview?.status || null;
  const locked = CLOSED_PERIOD_STATUSES.includes(periodStatus);
  const lockable = preview?.close_preview?.lockable === true;
  if ((lockable || locked) && (openRequests.length || answeredRequests.length || agentRequests.length || blockers.length)) {
    throw coded('EAW_TERMINAL_CONTRADICTION', 'Production projections disagree: lockable/locked close has owner, agent, or blocker work outstanding.');
  }
  const limbo = [
    ...answeredRequests.map((request) => ({ source: 'getClientEvidenceRequestsFromDb', id: request.id, reason: 'answered_customer_ask_awaiting_processing' })),
    ...agentRequests.map((request) => ({ source: 'getClientEvidenceRequestsFromDb', id: request.id, reason: 'agent_ask_unanswered' })),
    ...blockers.map((exception) => ({ source: 'getCloseExceptionsFromDb', id: exception.id || exception.transaction_id, reason: 'blocker_without_customer_human_ask' })),
  ];
  if (!locked && !lockable && openRequests.length === 0 && blockers.length === 0 && limbo.length === 0) {
    limbo.push({ reason: 'no exclusive production terminal projection' });
  }
  return Object.freeze({
    t1: locked ? [{ source: 'close_period_status', status: periodStatus }]
      : lockable ? [{ source: 'getLedgerPeriodPreviewFromDb', period: `${preview.close_preview.period_start || ''}/${preview.close_preview.period_end || ''}` }] : [],
    locked,
    t2: openRequests.map((r) => ({ source: 'getClientEvidenceRequestsFromDb', id: r.id, responsible_actor: r.audience === 'seat' ? 'seat' : 'owner' })),
    limbo,
  });
}

export function classifyDbCloseProjectionReceipt(value) {
  const receipt = value?.receipt && typeof value.receipt === 'object' ? value.receipt : value;
  if (receipt?.version === LEGACY_RUN_RECEIPT_VERSION) {
    return Object.freeze({
      classification: 'legacy_unproven',
      reason: `${LEGACY_RUN_RECEIPT_VERSION} used the broader replied-ask terminal projection`,
    });
  }
  if (receipt?.version === LEGACY_RECEIPT_VERSION || value?.receipt?.version === LEGACY_RECEIPT_VERSION) {
    return Object.freeze({
      classification: 'legacy_unproven',
      reason: `${LEGACY_RECEIPT_VERSION} used the broader replied-ask terminal projection`,
    });
  }
  if (receipt?.version === RUN_RECEIPT_VERSION) {
    const children = Array.isArray(receipt.receipts) ? receipt.receipts : [];
    const canonical = children.length > 0 && children.every((child) => child?.projection?.classification === 'canonical');
    return Object.freeze(canonical
      ? { classification: 'canonical', projector: 'reconcileConvergenceState' }
      : { classification: 'unproven', reason: 'current run receipt lacks a canonical child projection receipt' });
  }
  if (receipt?.version === RECEIPT_VERSION && receipt?.projection?.classification === 'canonical') {
    return Object.freeze({ classification: 'canonical', projector: 'reconcileConvergenceState' });
  }
  return Object.freeze({ classification: 'unproven', reason: 'unrecognized DB-close projection receipt' });
}

const stable = (value) => JSON.stringify(value);
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function runOneWorld({ world, index, runToken, ops, actor }) {
  const firmId = `eaw-${runToken}-${index}`;
  const clientId = `${firmId}-client-1`;
  assertRunIdentity({ firmId, clientId });
  let created = false;
  let deletion = null;
  let residue = null;
  let cleanupError = null;
  let failure = null;
  let candidate = null;
  try {
    await ops.createFirmInDb({ firmId, name: `EAW ${world.worldId}`, jurisdiction: 'GB', currency: 'GBP', actor });
    created = true;
    await ops.createClientInDb({ firmId, profile: { id: clientId, companyName: `EAW ${world.worldId}`, entityType: 'uk_ltd', stage: 'active', jurisdiction: 'GB' } });
    const input = compileWorldInput(world, { firmId, clientId });
    await ops.syncDocumentsAndTransactionsInDb({ firmId, ...input });
    const periodStart = world.events.map((e) => e.occurredAt).sort()[0];
    const periodEnd = world.events.map((e) => e.occurredAt).sort().at(-1);
    // Pass 1 drives the close (lock + archive on a lockable terminal); pass 2
    // is a pure REPLAY PROBE: it re-posts (production skips/refuses already-
    // posted lines) and re-projects, but never locks or archives again. Raw
    // projections legitimately differ after a lock (locked status, timestamps),
    // so divergence is judged on normalized terminals and new postings only.
    const pass = async ({ close }) => {
      const posting = await ops.postLedgerPeriodInDb({ firmId, clientId, periodStart, periodEnd, dryRun: false, actorId: actor.id });
      const [preview, exceptions, requests, diagnostics] = await Promise.all([
        ops.getLedgerPeriodPreviewFromDb({ firmId, clientId, periodStart, periodEnd }),
        ops.getCloseExceptionsFromDb({ firmId, clientId, periodStart, periodEnd }),
        ops.getClientEvidenceRequestsFromDb({ firmId, clientId }),
        ops.getCloseDiagnosticsFromDb({ firmId, clientId, periodStart, periodEnd })
      ]);
      const terminal = projectTerminalState({ preview, exceptions, evidenceRequests: requests });
      let closeReceipt = null;
      if (close && terminal.t1.length && !terminal.locked) {
        const lock = await ops.lockClosePeriodInDb({ firmId, clientId, periodStart, periodEnd, actorId: actor.id });
        const archive = await ops.createCloseArchiveInDb({ firmId, clientId, periodStart, periodEnd, actorId: actor.id });
        const archiveId = archive?.close_archive?.archive_id;
        if (!archiveId) throw coded('EAW_CLOSE_RECEIPT_INCOMPLETE', 'Production close archive returned no archive identity.');
        const exported = await ops.getCloseArchiveExportFromDb({ firmId, clientId, archiveId, actorId: actor.id });
        closeReceipt = { lock: lock.close_lock, archive: archive.close_archive, export_checksum: exported.bundle_checksum_sha256 || null };
      }
      return { posting: posting.ledger_period_posting, terminal, close: closeReceipt, projection_digest: digest({ preview, exceptions, requests, diagnostics }) };
    };
    const first = await pass({ close: true });
    const second = await pass({ close: false });
    const replayPosted = ((second.posting?.results) || []).filter((r) => r.status === 'posted');
    if (replayPosted.length) throw coded('EAW_SECOND_PASS_DIVERGED', `Second pass posted ${replayPosted.length} new journals.`);
    if (stable(first.terminal.t2) !== stable(second.terminal.t2)) throw coded('EAW_SECOND_PASS_DIVERGED', 'Owner-side T2 projection changed on replay.');
    if (first.terminal.t1.length) {
      if (!second.terminal.t1.length) throw coded('EAW_SECOND_PASS_DIVERGED', 'Pass 1 closed the period but pass 2 no longer projects a terminal close.');
    } else if (stable(first.terminal) !== stable(second.terminal)) {
      throw coded('EAW_SECOND_PASS_DIVERGED', 'Replay changed the terminal projection of a non-closing world.');
    }
    candidate = { world_id: world.worldId, firm_id: firmId, client_id: clientId, actor, authority_basis: 'eaw_isolated_firm_operator', passes: [first, second], idempotent: true, terminal: second.terminal };
  } catch (error) {
    failure = error;
  } finally {
    if (created) {
      try { deletion = await ops.deleteFirmInDb({ firmId, actor }); } catch (error) { cleanupError = error; failure ||= error; }
      try { residue = await ops.countFirmResidueInDb({ firmId, clientIds: [clientId] }); } catch (error) { cleanupError ||= error; failure ||= error; }
    }
  }
  if (created && (!deletion?.residue_verified || residue?.residue_rows !== 0)) failure ||= coded('EAW_CLEANUP_RESIDUE', `Cleanup did not prove zero residue (${residue?.residue_rows ?? 'unknown'} rows; the retired firms row and audit trail are retained by design).`);
  const receipt = { version: RECEIPT_VERSION, status: failure ? 'failed' : 'passed', world_id: world.worldId, projection: CANONICAL_PROJECTION_RECEIPT, candidate_close: candidate, cleanup: { delete_receipt: deletion, post_delete_residue: residue, cleanup_error: cleanupError ? { code: cleanupError.code || 'EAW_CLEANUP_FAILED', message: cleanupError.message } : null }, failure: failure ? { code: failure.code || 'EAW_RUN_FAILED', message: failure.message } : null };
  if (failure) throw Object.assign(failure, { receipt });
  return receipt;
}

export async function loadDeclaredWorlds(readFile = fs.readFile) {
  const sources = await Promise.all(FAMILY_PATHS.map(async (name) => JSON.parse(await readFile(path.join(ROOT, name), 'utf8'))));
  const derived = deriveSiblingWorld(sources[2]);
  if (!derived.ok || !derived.world) throw coded('EAW_SIBLING_MISSING', `F3 sibling derivation refused: ${derived.errors.join('; ')}`);
  return [...sources, derived.world];
}

const monotonicMilliseconds = () => Number(process.hrtime.bigint() / 1_000_000n);

const buildZeroModelSpend = ({ startedAt, endedAt, declared = [] }) => ({
  status: 'known_zero_model',
  solveCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  modelSpendUsd: 0,
  wallTimeMs: Math.max(0, Math.round(endedAt - startedAt)),
  providerResponses: [],
  modelIds: [],
  pricingSource: { status: 'not_applicable', reason: 'zero_model_db_close_path' },
  configurationDigest: digest({ boundary_version: firmDb.EAW_CLOSE_COMPOSITION_BOUNDARY.version, projection: CANONICAL_PROJECTION_RECEIPT }),
  artifactDigests: [digest(declared)],
});

export async function runHarness({ ops = bindProductionOperations(), worlds, runToken, actor = { type: 'operator', id: 'eaw-unit-39-operator' }, clock = monotonicMilliseconds } = {}) {
  const startedAt = clock();
  let declared = worlds || [];
  try {
    if (!ops.isFirmDatabaseConfigured()) throw coded('EAW_DB_UNCONFIGURED', 'Firm database is not configured; DB-backed evidence is required and will not be simulated.');
    if (!/^[a-z0-9-]+$/.test(runToken || '')) throw coded('EAW_RUN_TOKEN_REQUIRED', 'A deterministic lowercase --run-token is required.');
    declared = worlds || await loadDeclaredWorlds();
    if (declared.length !== 4 || !declared[3]?.worldId?.includes('::sibling::')) throw coded('EAW_SIBLING_MISSING', 'All three families and the declared F3 sibling are required.');
    const receipts = [];
    for (let i = 0; i < declared.length; i += 1) receipts.push(await runOneWorld({ world: declared[i], index: i + 1, runToken, ops, actor }));
    return {
      version: RUN_RECEIPT_VERSION,
      status: 'passed',
      boundary_version: firmDb.EAW_CLOSE_COMPOSITION_BOUNDARY.version,
      projection: CANONICAL_PROJECTION_RECEIPT,
      spend: buildZeroModelSpend({ startedAt, endedAt: clock(), declared }),
      receipts,
    };
  } catch (error) {
    const failure = error instanceof Error ? error : coded('EAW_RUN_FAILED', String(error));
    failure.spend = buildZeroModelSpend({ startedAt, endedAt: clock(), declared });
    throw failure;
  }
}

function coded(code, message) { return Object.assign(new Error(message), { code }); }

async function main() {
  const args = process.argv.slice(2); const value = (flag) => { const i = args.indexOf(flag); return i < 0 ? null : args[i + 1]; };
  const output = value('--output');
  try {
    // Unit 40 is an OPERATOR checkpoint: the credentialed run must attribute
    // its mutations to the human running it, never a synthetic default.
    const actorId = value('--actor-id');
    const result = await runHarness({
      runToken: value('--run-token'),
      ...(actorId ? { actor: { type: value('--actor-type') || 'operator', id: actorId } } : {})
    });
    const text = `${JSON.stringify(result, null, 2)}\n`;
    if (output) await fs.writeFile(output, text, { flag: 'wx' }); else process.stdout.write(text);
  } catch (error) {
    const body = { version: RUN_RECEIPT_VERSION, status: 'failed', projection: CANONICAL_PROJECTION_RECEIPT, spend: error.spend || null, failure: { code: error.code || 'EAW_RUN_FAILED', message: error.message }, receipt: error.receipt || null };
    const text = `${JSON.stringify(body, null, 2)}\n`;
    if (output) await fs.writeFile(output, text, { flag: 'wx' }); else process.stderr.write(text);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
