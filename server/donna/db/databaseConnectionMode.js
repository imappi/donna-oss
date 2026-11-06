// Diagnostic projection only. Never return a hostname, database, user or URL.
// Endpoint names describe configured pooling; they do not empirically prove
// backend affinity, and an unknown endpoint must remain unknown.
export const describeDatabaseConnection = (connection) => {
  let host = '', port = null;
  try {
    if (typeof connection === 'string' && connection) {
      const parsed = new URL(connection);
      if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) return { port, inferred_pool_mode: 'unknown' };
      host = decodeURIComponent(parsed.searchParams.get('host') || parsed.hostname).toLowerCase();
      port = Number(parsed.searchParams.get('port') || parsed.port || 5432);
    } else if (connection && typeof connection === 'object') {
      host = String(connection.host || '').toLowerCase();
      port = Number(connection.port || 5432);
    }
  } catch { return { port: null, inferred_pool_mode: 'unknown' }; }
  if (!Number.isInteger(port) || port < 1 || port > 65535) port = null;
  const sharedPooler = host.endsWith('.pooler.supabase.com');
  const dedicated = /^db\.[a-z0-9-]+\.supabase\.co$/.test(host);
  const mode = (sharedPooler || dedicated) && port === 6543 ? 'supabase_transaction'
    : sharedPooler && port === 5432 ? 'supabase_session'
    : dedicated && port === 5432 ? 'supabase_direct'
    : 'unknown';
  return { port, inferred_pool_mode: mode };
};
