// Closed vocabulary for two read routes. Error strings may contain credentials,
// SQL and customer facts: inspect only exact known messages, never serialize them.
const CODES = new Map([
  ['ECONNRESET', 'transport_reset'], ['EPIPE', 'transport_closed'],
  ['ETIMEDOUT', 'transport_timeout'], ['ECONNREFUSED', 'connection_refused'],
  ['ENOTFOUND', 'dns_failed'], ['EAI_AGAIN', 'dns_temporary_failure'],
  ['08000', 'connection_exception'], ['08003', 'connection_missing'],
  ['08006', 'connection_failure'], ['53300', 'database_connections_exhausted'],
  ['57014', 'database_query_cancelled'], ['40P01', 'database_deadlock'],
  ['40001', 'database_serialization_failure'], ['57P01', 'database_shutdown'],
  ['57P02', 'database_crash_shutdown'], ['57P03', 'database_not_ready']
]);
const NAMES = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'AbortError', 'TimeoutError']);
export const buildFirmReadFailureDiagnostic = ({ method, pathname, status, error, elapsedMs, pool = null }) => {
  if (method !== 'GET' || !Number.isInteger(status) || status < 500 || status > 599) return null;
  const route = ['/snapshot', '/', ''].includes(pathname) ? 'snapshot'
    : pathname === '/reports/financial-statements' ? 'financial_statements' : null;
  if (!route) return null;
  const errorCode = CODES.has(error?.code) ? error.code : 'UNKNOWN';
  let classification = CODES.get(errorCode) || 'unclassified';
  if (errorCode === 'UNKNOWN') {
    if (error?.message === 'timeout exceeded when trying to connect') classification = 'pool_acquire_timeout';
    else if (error?.message === 'Connection terminated due to connection timeout') classification = 'db_connect_timeout';
    else if (error?.message === 'Connection terminated unexpectedly' || error?.message === 'Connection terminated') classification = 'transport_closed';
  }
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return { route, status, error_code: errorCode, error_name: NAMES.has(error?.name) ? error.name : 'Error',
    classification, elapsed_ms: Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs)) : null,
    pool: pool ? { total: count(pool.total), idle: count(pool.idle), waiting: count(pool.waiting), max: count(pool.max) } : null };
};
