#!/usr/bin/env node
import {
  bindProductionOperations,
  projectTerminalState,
  runHarness,
  runOneWorld
} from './eval_world_db_close.js';

export const WRITER_BOUNDARIES = Object.freeze([
  Object.freeze({ boundary: 'post', operation: 'postLedgerPeriodInDb' }),
  Object.freeze({ boundary: 'lock', operation: 'lockClosePeriodInDb' }),
  Object.freeze({ boundary: 'archive', operation: 'createCloseArchiveInDb' }),
  Object.freeze({ boundary: 'export', operation: 'getCloseArchiveExportFromDb' }),
  Object.freeze({ boundary: 'retire', operation: 'deleteFirmInDb' })
]);

const operationByBoundary = new Map(WRITER_BOUNDARIES.map((row) => [row.boundary, row.operation]));
const terminalOperations = new Set(WRITER_BOUNDARIES.slice(1, 4).map((row) => row.operation));

function coded(code, message) { return Object.assign(new Error(message), { code }); }
function stable(value) { return JSON.stringify(value); }
function journalCount(value) { return Number.isInteger(value) ? value : value?.count; }

function requireProbeOps(ops) {
  for (const name of ['countPersistedJournalsInDb', 'readTerminalInventoryInDb']) {
    if (typeof ops?.[name] !== 'function') throw coded('EAW_RESUME_PROBE_INCOMPLETE', `Crash-resume ops seam is missing ${name}.`);
  }
}

function assertToken(checkpoint, runToken) {
  if (!checkpoint || checkpoint.run_token !== runToken) {
    throw coded('EAW_RESUME_TOKEN_MISMATCH', 'Resume token does not identify the crashed run.');
  }
}

function wrapCrashOps(ops, checkpoint, { crashMode }) {
  const target = operationByBoundary.get(checkpoint.boundary);
  const wrapped = Object.create(ops);
  for (const { operation } of WRITER_BOUNDARIES) {
    wrapped[operation] = async (args) => {
      if (operation !== target || checkpoint.crashed) {
        const result = await ops[operation](args);
        if (terminalOperations.has(operation)) checkpoint.completed.set(operation, structuredClone(result));
        return result;
      }
      checkpoint.crashed = true;
      checkpoint.writer_args = structuredClone(args);
      if (crashMode === 'before') throw coded('EAW_INJECTED_CRASH', `Injected crash before ${checkpoint.boundary}.`);
      if (operation === 'deleteFirmInDb') {
        checkpoint.pre_retire_inventory = await ops.readTerminalInventoryInDb(args);
        checkpoint.pre_retire_journals = await ops.countPersistedJournalsInDb(args);
      }
      const result = await ops[operation](args);
      checkpoint.completed.set(operation, structuredClone(result));
      throw coded('EAW_INJECTED_CRASH', `Injected crash inside ${checkpoint.boundary}, after its persisted effect.`);
    };
  }
  // runOneWorld's finally is correct for an ordinary failure. A process crash,
  // however, cannot execute cleanup; suppress that synthetic finally call so
  // the same persisted run can be resumed.
  if (target !== 'deleteFirmInDb') {
    wrapped.deleteFirmInDb = async () => ({ residue_verified: true, crash_cleanup_suppressed: true });
  }
  wrapped.countFirmResidueInDb = async (args) => checkpoint.crashed
    ? ({ residue_rows: 0, crash_cleanup_suppressed: true })
    : ops.countFirmResidueInDb(args);
  return wrapped;
}

function wrapResumeOps(ops, checkpoint) {
  const wrapped = Object.create(ops);
  for (const operation of terminalOperations) {
    wrapped[operation] = async (args) => {
      if (checkpoint.completed.has(operation)) return structuredClone(checkpoint.completed.get(operation));
      const result = await ops[operation](args);
      checkpoint.completed.set(operation, structuredClone(result));
      return result;
    };
  }
  wrapped.deleteFirmInDb = async (args) => {
    checkpoint.pre_retire_inventory = await ops.readTerminalInventoryInDb(args);
    checkpoint.pre_retire_journals = await ops.countPersistedJournalsInDb(args);
    if (checkpoint.completed.has('deleteFirmInDb')) return structuredClone(checkpoint.completed.get('deleteFirmInDb'));
    const result = await ops.deleteFirmInDb(args);
    checkpoint.completed.set('deleteFirmInDb', structuredClone(result));
    return result;
  };
  return wrapped;
}

export async function resumeCrashedWorld({ world, index = 1, runToken, ops, actor = { type: 'operator', id: 'eaw-unit-52-operator' }, checkpoint }) {
  requireProbeOps(ops);
  assertToken(checkpoint, runToken);
  const journalsBefore = journalCount(await ops.countPersistedJournalsInDb({ firmId: checkpoint.firm_id, clientId: checkpoint.client_id }));
  if (checkpoint.completed.has('deleteFirmInDb')) {
    const journals = journalCount(checkpoint.pre_retire_journals);
    const ids = checkpoint.pre_retire_inventory?.journal_ids || [];
    if (ids.length !== journals || new Set(ids).size !== ids.length || checkpoint.pre_retire_inventory?.limbo?.length) {
      throw coded('EAW_RESUME_DIVERGED', 'Persisted pre-retirement inventory is duplicate, incomplete, or in limbo.');
    }
    return Object.freeze({ receipt: { status: 'passed', recovered_retire_receipt: checkpoint.completed.get('deleteFirmInDb') }, terminal_inventory: checkpoint.pre_retire_inventory, persisted_journal_count: journals, replay_new_journals: 0 });
  }
  // If the period lock persisted before the process died, finish only the
  // missing downstream writers. Never call the lock writer a second time.
  if (checkpoint.completed.has('lockClosePeriodInDb')) {
    const common = checkpoint.writer_args;
    if (!checkpoint.completed.has('createCloseArchiveInDb')) {
      checkpoint.completed.set('createCloseArchiveInDb', await ops.createCloseArchiveInDb(common));
    }
    if (!checkpoint.completed.has('getCloseArchiveExportFromDb')) {
      const archive = checkpoint.completed.get('createCloseArchiveInDb');
      checkpoint.completed.set('getCloseArchiveExportFromDb', await ops.getCloseArchiveExportFromDb({ ...common, archiveId: archive?.close_archive?.archive_id }));
    }
  }
  const receipt = await runOneWorld({ world, index, runToken, ops: wrapResumeOps(ops, checkpoint), actor });
  const replay = receipt.candidate_close.passes[1];
  const replayPosted = (replay.posting?.results || []).filter((row) => row.status === 'posted');
  if (replayPosted.length) throw coded('EAW_RESUME_DIVERGED', 'Replay probe created new postings.');
  const journalsAfter = journalCount(checkpoint.pre_retire_journals);
  const journalIds = checkpoint.pre_retire_inventory?.journal_ids || [];
  if (!Number.isInteger(journalsBefore) || !Number.isInteger(journalsAfter) || journalIds.length !== journalsAfter) throw coded('EAW_RESUME_DIVERGED', 'Persisted journal count and identifiers disagree.');
  if (new Set(journalIds).size !== journalIds.length) throw coded('EAW_RESUME_DIVERGED', 'Persisted duplicate journal detected.');
  if (journalsAfter < journalsBefore) throw coded('EAW_RESUME_DIVERGED', 'Persisted journal inventory was lost during resume.');
  if (journalsAfter > journalsBefore && checkpoint.boundary !== 'post') throw coded('EAW_RESUME_DIVERGED', 'Resume created a duplicate journal.');
  if (checkpoint.pre_retire_inventory?.limbo?.length) throw coded('EAW_RESUME_DIVERGED', 'Resume left terminal inventory in limbo.');
  if (stable(checkpoint.pre_retire_inventory?.terminal) !== stable(receipt.candidate_close.terminal)) {
    throw coded('EAW_RESUME_DIVERGED', 'Persisted terminal inventory differs from the harness projection.');
  }
  return Object.freeze({ receipt, terminal_inventory: checkpoint.pre_retire_inventory, persisted_journal_count: journalsAfter, replay_new_journals: 0 });
}

export async function runCrashResume({ world, index = 1, runToken, ops, actor = { type: 'operator', id: 'eaw-unit-52-operator' }, boundary, crashMode = 'inside' }) {
  requireProbeOps(ops);
  if (!operationByBoundary.has(boundary)) throw coded('EAW_CRASH_BOUNDARY_UNKNOWN', `Unknown writer boundary: ${boundary}.`);
  if (!['before', 'inside'].includes(crashMode)) throw coded('EAW_CRASH_MODE_UNKNOWN', `Unknown crash mode: ${crashMode}.`);
  const firmId = `eaw-${runToken}-${index}`;
  const checkpoint = { boundary, run_token: runToken, firm_id: firmId, client_id: `${firmId}-client-1`, crashed: false, completed: new Map() };
  try {
    await runOneWorld({ world, index, runToken, ops: wrapCrashOps(ops, checkpoint, { crashMode }), actor });
    throw coded('EAW_CRASH_NOT_REACHED', `Writer boundary ${boundary} was not reached.`);
  } catch (error) {
    if (error.code !== 'EAW_INJECTED_CRASH') throw error;
  }
  let resumed;
  try {
    resumed = await resumeCrashedWorld({ world, index, runToken, ops, actor, checkpoint });
  } catch (error) {
    throw Object.assign(error, { checkpoint });
  }
  return Object.freeze({ version: 'eaw.crash-resume.v1', boundary, crash_mode: crashMode, checkpoint, ...resumed });
}

// These references deliberately pin all four Unit 39 extension seams. The
// production binder is used by an operator caller; CI supplies fake operations.
export const UNIT_39_IMPORTS = Object.freeze({ bindProductionOperations, projectTerminalState, runHarness, runOneWorld });
