import { useCallback, useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import ProviderFailurePanel from './provider-failure-panel.jsx';
import { fetchFirmAskBatches } from '../../lib/firmApi.js';

// FI-05 (2026-10-15): the operator-owned view of the provider-failure read
// model (server/donna/providerFailureReadModel.js, served on /ask-batches).
// Mounted on /firms/operator beside the hosted readiness card — runtime
// operation, not customer work — so diagnostic detail and exhausted retries
// (provider, code, status, reason, recovery state, attempts) live here while
// the firm's Actions view shows only "saved, taking longer" and a reference.
// Read-only: observing never retries a job or writes anything.
export default function OperatorProviderFailures({ clientId }) {
  const intl = useIntl();
  const [state, setState] = useState({ clientId: null, failures: null });
  const [refreshing, setRefreshing] = useState(false);
  const [stale, setStale] = useState(false);
  const pending = useRef(null);

  const load = useCallback(async () => {
    if (!clientId) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setRefreshing(true);
    try {
      const payload = await fetchFirmAskBatches({ clientId, signal: controller.signal });
      if (pending.current !== controller) return;
      const failures = Array.isArray(payload?.provider_failures)
        ? payload.provider_failures.filter((row) => row.client_id === clientId)
        : [];
      setState({ clientId, failures });
      setStale(false);
    } catch {
      if (pending.current === controller) setStale(true);
    } finally {
      if (pending.current === controller) { pending.current = null; setRefreshing(false); }
    }
  }, [clientId]);

  useEffect(() => {
    load();
    return () => { pending.current?.abort(); pending.current = null; };
  }, [load]);

  if (!clientId) return null;
  const failures = state.clientId === clientId ? state.failures : null;
  return (
    <section aria-label={intl.formatMessage({ id: 'operator.providerFailure.title' })} style={{ marginBlockStart: 24 }}>
      <ProviderFailurePanel audience="operator" failures={failures} refreshing={refreshing} stale={stale} onRefresh={load} />
      {failures && failures.length === 0 && (
        <p role="status">{intl.formatMessage({ id: stale ? 'operator.providerFailure.unavailable' : 'operator.providerFailure.empty' })}</p>
      )}
      {!failures && stale && <p role="status">{intl.formatMessage({ id: 'operator.providerFailure.unavailable' })}</p>}
    </section>
  );
}
