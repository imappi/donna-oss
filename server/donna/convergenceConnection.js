// Connection ownership for the existing convergence writer. Never infer a
// transaction from an xid, and never let a pool distribute its statements.
import { assertVerdictTransactionBudgetActive } from './executionBudget.js';

const connections = new WeakMap();
// The server's own transaction status ('I' idle, 'T' in a transaction, 'E' failed),
// read from ReadyForQuery — the driver does not expose it. It lets a settle in
// autocommit begin its own transaction instead of issuing a SAVEPOINT that the
// server must refuse (each refusal is an ERROR line in the PostgreSQL log: F-28c).
const txStatusOf = physicalClient => {
  const connection = physicalClient?.connection;
  if (!connection || typeof connection.on !== 'function') return null;
  if (!connection.__donnaTxStatus) {
    const box = { status: null };
    connection.on('readyForQuery', message => { box.status = message?.status ?? null; });
    connection.__donnaTxStatus = box;
  }
  return connection.__donnaTxStatus;
};
let sequence = 0;
export const isConvergencePool = value => typeof value?.connect === 'function'
  && ['totalCount', 'idleCount', 'waitingCount'].every(key => Number.isInteger(value[key]));

export const bindConvergenceConnection = (physicalClient, {
  rawQuery = physicalClient.query.bind(physicalClient),
  setInTransaction = () => {},
  release = typeof physicalClient.release === 'function' ? physicalClient.release.bind(physicalClient) : null
} = {}) => {
  const existing = connections.get(physicalClient);
  if (existing) return existing;
  const record = { physicalClient, rawQuery, setInTransaction, release, depth: 0, discarded: false, txStatus: txStatusOf(physicalClient) };
  record.raw = { query: (...args) => rawQuery(...args) };
  connections.set(physicalClient, record); connections.set(record.raw, record);
  return record;
};
export const convergenceConnectionRecord = value => connections.get(value);
export const unbindConvergenceConnection = record => {
  connections.delete(record.physicalClient); connections.delete(record.raw);
};

const discard = async (record, primary, cleanup = null) => {
  if (cleanup) primary.convergenceCleanupError = cleanup;
  primary.convergenceConnectionDiscarded = true;
  if (record.discarded) return;
  record.discarded = true;
  // The owner may still execute its finally/release after this rejection.
  record.physicalClient.release = () => {};
  try {
    if (record.release) await record.release(primary);
    else await record.physicalClient.end();
  } catch (error) { primary.convergenceDiscardError = error; }
};

export const withConvergenceTransaction = async (receiver, callback, { connectionKind } = {}) => {
  const borrowed = connectionKind === 'pool' || isConvergencePool(receiver);
  const poolOwned = borrowed || connectionKind === 'pool_owned';
  const physical = borrowed ? await receiver.connect() : (connections.get(receiver)?.physicalClient || receiver);
  let record = connections.get(physical);
  const boundHere = !record;
  if (!record) {
    // pg Client.connection is the transport identity. A query-only facade must
    // be explicitly bound to its physical client by the wrapper that owns it.
    if (!physical?.connection || typeof physical.query !== 'function') {
      if (borrowed) physical?.release?.(new Error('Convergence connection identity unavailable'));
      throw Object.assign(new TypeError('Convergence requires a physical connection or registered raw facade.'),
        { code: 'CONVERGENCE_CONNECTION_IDENTITY_REQUIRED' });
    }
    record = bindConvergenceConnection(physical);
  }
  if (record.discarded) throw Object.assign(new Error('Convergence connection was discarded.'),
    { code: 'CONVERGENCE_CONNECTION_DISCARDED' });
  const savepoint = `donna_convergence_${++sequence}`;
  let mode = null;
  record.depth++;
  try {
    assertVerdictTransactionBudgetActive(physical);
    try {
      // First use of this connection: learn the server's status once (ReadyForQuery
      // carries it) instead of learning it from a refused SAVEPOINT.
      if (record.txStatus && record.txStatus.status === null) await record.rawQuery('select 1');
      // Idle per the server: no transaction to nest in, so own one directly.
      if (record.txStatus?.status === 'I') throw Object.assign(new Error('idle'), { code: '25P01' });
      await record.rawQuery(`savepoint ${savepoint}`);
      mode = 'nested';
    } catch (error) {
      if (error?.code !== '25P01') {
        if (poolOwned) await discard(record, error);
        throw error;
      }
      await record.rawQuery('begin');
      record.setInTransaction(true);
      mode = 'owned';
    }
    if (poolOwned && mode === 'nested') {
      const error = Object.assign(new Error('Pool checkout contained an unowned open transaction.'),
        { code: 'CONVERGENCE_POOL_OWNERSHIP_VIOLATION' });
      await discard(record, error);
      throw error;
    }
    const result = await callback(record.raw, { physicalClient: physical, record });
    assertVerdictTransactionBudgetActive(physical);
    if (mode === 'owned') {
      await record.rawQuery('commit'); record.setInTransaction(false);
    } else await record.rawQuery(`release savepoint ${savepoint}`);
    return result;
  } catch (error) {
    if (mode && !record.discarded) {
      try {
        if (mode === 'owned') {
          await record.rawQuery('rollback'); record.setInTransaction(false);
        } else {
          await record.rawQuery(`rollback to savepoint ${savepoint}`);
          await record.rawQuery(`release savepoint ${savepoint}`);
        }
      } catch (cleanup) { await discard(record, error, cleanup); }
    }
    throw error;
  } finally {
    // Hook release sees the internal depth and must not initiate a second
    // settle. A discarded connection has already been released exactly once.
    if (borrowed && !record.discarded) physical.release();
    record.depth--;
    if (boundHere || record.discarded) unbindConvergenceConnection(record);
  }
};
