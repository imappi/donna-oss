// Xero connection module for the Financials workbench.
//
// Surface contract is owned by the BE — this component only orchestrates the
// three published endpoints via src/lib/firmApi.js:
//   GET  /api/donna/firms/xero/connect            → authorize redirect URL
//   GET  /api/donna/firms/xero/status             → connections / accounts / contacts / syncRuns
//   POST /api/donna/firms/xero/sync-reference-data → refreshes local CoA + contacts from Xero
//   POST /api/donna/firms/xero/provision-coa       → creates missing Donna CoA accounts in Xero
//
// States rendered (per the FE brief):
//   1. not-connected — restrained "Connect Xero" pill
//   2. connected (no sync yet) — tenant + "Refresh Xero data"
//   3. synced — tenant, account/contact counts, last sync, "Refresh data" + "Provision CoA"
//   4. error — alert-tinted band with Retry sync
//
// Visual style is consistent with the rest of the Donna Financials surface
// (light-oatmeal card, mono micro-labels, accent indigo for the primary
// action). Keeps the workbench tone — no marketing copy.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { T } from '../shared/design-tokens.js';
import {
  connectXero,
  fetchXeroStatus,
  provisionXeroChartOfAccounts,
  syncXeroReferenceData
} from '../../lib/firmApi.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const RELATIVE_THRESHOLDS = [
  { ms: 60_000, label: 'just now' },
  { ms: 3_600_000, divisor: 60_000, suffix: 'm ago' },
  { ms: 86_400_000, divisor: 3_600_000, suffix: 'h ago' },
  { ms: 30 * 86_400_000, divisor: 86_400_000, suffix: 'd ago' }
];

const formatRelative = (input) => {
  if (!input) return null;
  const ts = typeof input === 'number' ? input : Date.parse(input);
  if (Number.isNaN(ts)) return null;
  const diff = Date.now() - ts;
  if (diff < 0) return new Date(ts).toLocaleString();
  for (const rule of RELATIVE_THRESHOLDS) {
    if (diff < rule.ms) {
      if (!rule.divisor) return rule.label;
      return `${Math.max(1, Math.round(diff / rule.divisor))}${rule.suffix}`;
    }
  }
  return new Date(ts).toLocaleDateString();
};

const formatCount = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US') : '—');

const pickPrimaryConnection = (connections = []) => {
  if (!Array.isArray(connections) || connections.length === 0) return null;
  // Prefer a non-disconnected, non-error connection. Otherwise return the first.
  return (
    connections.find((c) => c?.status === 'connected') ||
    connections.find((c) => c?.status && c.status !== 'disconnected' && c.status !== 'error') ||
    connections[0]
  );
};

const findLatestSyncRun = (syncRuns = [], connectionId) => {
  if (!Array.isArray(syncRuns) || syncRuns.length === 0) return null;
  const candidates = connectionId
    ? syncRuns.filter((r) => r?.connection_id === connectionId)
    : syncRuns;
  if (candidates.length === 0) return null;
  return candidates
    .slice()
    .sort((a, b) => {
      const ta = Date.parse(a?.completed_at || a?.started_at || a?.created_at || 0) || 0;
      const tb = Date.parse(b?.completed_at || b?.started_at || b?.created_at || 0) || 0;
      return tb - ta;
    })[0];
};

const URL_FLAG = 'xero';
const stripXeroFlag = () => {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has(URL_FLAG) && !url.searchParams.has('xero_tenants')) return;
  url.searchParams.delete(URL_FLAG);
  url.searchParams.delete('xero_tenants');
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
};

const readXeroFlag = () => {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const flag = params.get(URL_FLAG);
  if (!flag) return null;
  return { flag, tenants: Number(params.get('xero_tenants')) || null };
};

// ── Visual primitives ────────────────────────────────────────────────────────

const microLabel = {
  fontFamily: T.mono,
  fontSize: 10.5,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: T.muted
};

function PrimaryButton({ children, busy, disabled, onClick, accent = T.ink }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      style={{
        font: 'inherit',
        fontSize: 12.5,
        padding: '7px 14px',
        borderRadius: 999,
        border: 'none',
        background: accent,
        color: T.paper,
        cursor: disabled || busy ? 'default' : 'pointer',
        opacity: disabled || busy ? 0.6 : 1,
        fontWeight: 500
      }}
    >
      {busy ? 'Working…' : children}
    </button>
  );
}

function GhostButton({ children, onClick, disabled, busy }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      style={{
        font: 'inherit',
        fontSize: 12.5,
        padding: '7px 14px',
        borderRadius: 999,
        border: `1px solid ${T.rule}`,
        background: T.card,
        color: T.inkSoft,
        cursor: disabled || busy ? 'default' : 'pointer',
        opacity: disabled || busy ? 0.6 : 1
      }}
    >
      {busy ? 'Working…' : children}
    </button>
  );
}

// ── Public component ─────────────────────────────────────────────────────────

export default function DonnaXeroPanel({ clientId }) {
  const [status, setStatus] = useState(null);
  const [loadStatus, setLoadStatus] = useState('idle'); // idle | loading | ready | error
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(null); // 'connect' | 'sync' | 'provision' | null
  const [transientError, setTransientError] = useState(null);
  const [transientNotice, setTransientNotice] = useState(null);
  const [justConnected, setJustConnected] = useState(null); // { tenants } | null
  const reqId = useRef(0);

  const refresh = useCallback(
    async ({ silent } = {}) => {
      if (!clientId) return;
      const id = ++reqId.current;
      if (!silent) setLoadStatus('loading');
      try {
        const data = await fetchXeroStatus({ clientId });
        if (id !== reqId.current) return;
        setStatus(data || {});
        setLoadStatus('ready');
        setLoadError(null);
      } catch (err) {
        if (id !== reqId.current) return;
        setLoadStatus('error');
        setLoadError(err?.message || 'Could not load Xero status');
      }
    },
    [clientId]
  );

  // Initial / clientId-changed status load.
  useEffect(() => {
    setStatus(null);
    setLoadStatus('idle');
    if (clientId) refresh();
  }, [clientId, refresh]);

  // Pick up ?xero=connected redirect (Xero callback returns the user here).
  useEffect(() => {
    const flag = readXeroFlag();
    if (!flag) return;
    if (flag.flag === 'connected') setJustConnected({ tenants: flag.tenants });
    stripXeroFlag();
    if (flag.flag === 'connected') refresh({ silent: true });
  }, [refresh]);

  const connections = status?.connections || [];
  const accounts = status?.accounts || [];
  const contacts = status?.contacts || [];
  const syncRuns = status?.syncRuns || [];

  const primary = useMemo(() => pickPrimaryConnection(connections), [connections]);
  const latestRun = useMemo(
    () => findLatestSyncRun(syncRuns, primary?.id),
    [syncRuns, primary?.id]
  );
  const latestRunError = latestRun?.last_error || latestRun?.error || null;
  const connectionLastError = primary?.last_error || null;
  const errorMessage = transientError || latestRunError || connectionLastError;

  const tenantName =
    primary?.tenant_name ||
    primary?.tenant?.tenantName ||
    primary?.tenant?.name ||
    primary?.organisation_name ||
    'Xero tenant';

  const connectionStatus = primary?.status || (primary ? 'connected' : 'disconnected');
  const isConnected =
    connectionStatus &&
    connectionStatus !== 'disconnected' &&
    connectionStatus !== 'error';
  // Token refresh failed server-side (status flipped to 'expired'): the row is
  // still the client's connection, but every sync/push will fail until the
  // operator re-runs OAuth — surface Reconnect instead of hiding it.
  const needsReauth = connectionStatus === 'expired';
  const hasSynced =
    isConnected && (accounts.length > 0 || contacts.length > 0 || latestRun?.completed_at);

  const lastSyncedAt =
    latestRun?.completed_at ||
    latestRun?.finished_at ||
    primary?.last_synced_at ||
    primary?.last_sync_at;

  const handleConnect = useCallback(async () => {
    if (!clientId) return;
    setBusy('connect');
    setTransientError(null);
    setTransientNotice(null);
    try {
      const returnTo =
        typeof window !== 'undefined'
          ? `${window.location.pathname}${window.location.search}`
          : undefined;
      const data = await connectXero({ clientId, returnTo });
      if (!data?.authorizeUrl) {
        throw new Error('Xero connect did not return an authorize URL.');
      }
      window.location.assign(data.authorizeUrl);
    } catch (err) {
      setTransientError(err?.message || 'Could not start Xero connect.');
      setBusy(null);
    }
  }, [clientId]);

  const handleSync = useCallback(async () => {
    if (!clientId) return;
    setBusy('sync');
    setTransientError(null);
    setTransientNotice(null);
    try {
      await syncXeroReferenceData({ clientId, connectionId: primary?.id });
      await refresh({ silent: true });
      // After a successful sync the "just connected" hint becomes redundant.
      setJustConnected(null);
      setTransientNotice('Xero data refreshed.');
    } catch (err) {
      setTransientError(err?.message || 'Sync failed.');
    } finally {
      setBusy(null);
    }
  }, [clientId, primary?.id, refresh]);

  const handleProvisionCoa = useCallback(async () => {
    if (!clientId) return;
    setBusy('provision');
    setTransientError(null);
    setTransientNotice(null);
    try {
      const result = await provisionXeroChartOfAccounts({
        clientId,
        connectionId: primary?.id,
        dryRun: false
      });
      const counts = result?.xero_coa_provision?.counts || {};
      const created = Number(counts.created || 0);
      const alreadyExists = Number(counts.already_exists || 0);
      await refresh({ silent: true });
      setTransientNotice(
        created > 0
          ? `Provisioned ${created} CoA account${created === 1 ? '' : 's'} in Xero.`
          : `Donna CoA already provisioned${alreadyExists ? ` · ${alreadyExists} accounts` : ''}.`
      );
    } catch (err) {
      setTransientError(err?.message || 'CoA provisioning failed.');
    } finally {
      setBusy(null);
    }
  }, [clientId, primary?.id, refresh]);

  // ── Render ────────────────────────────────────────────────────────────────

  if (!clientId) return null;

  return (
    <section
      aria-label="Xero connection"
      style={{
        margin: '0 48px 8px',
        background: T.card,
        border: `1px solid ${T.rule}`,
        borderRadius: 12,
        padding: '14px 18px',
        display: 'flex',
        alignItems: 'center',
        gap: 18,
        flexWrap: 'wrap'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: 1 }}>
        <span
          aria-hidden="true"
          style={{
            width: 10,
            height: 10,
            borderRadius: 999,
            background: errorMessage
              ? T.alert
              : isConnected
                ? T.ok
                : T.mutedSoft,
            flex: '0 0 auto'
          }}
        />
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <span style={microLabel}>Xero</span>
            {loadStatus === 'loading' && !status && (
              <span style={{ fontSize: 12, color: T.muted }}>Checking status…</span>
            )}
            {loadStatus === 'error' && (
              <span style={{ fontSize: 12, color: T.alert }}>{loadError}</span>
            )}
          </div>
          {loadStatus !== 'error' && (
            <div style={{ fontSize: 13.5, color: T.ink, lineHeight: 1.4 }}>
              {!isConnected && <span>Xero not connected</span>}
              {isConnected && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 500 }}>{tenantName}</span>
                  {connections.length > 1 && (
                    <span style={{ fontSize: 11.5, color: T.muted }}>
                      +{connections.length - 1} more tenant{connections.length - 1 === 1 ? '' : 's'}
                    </span>
                  )}
                </span>
              )}
            </div>
          )}
          {isConnected && (
            <div
              style={{
                fontFamily: T.mono,
                fontSize: 11,
                color: T.mutedSoft,
                letterSpacing: '0.02em',
                display: 'flex',
                gap: 12,
                flexWrap: 'wrap'
              }}
            >
              {hasSynced ? (
                <>
                  <span>{formatCount(accounts.length)} accounts</span>
                  <span>{formatCount(contacts.length)} contacts</span>
                  {lastSyncedAt && <span>synced {formatRelative(lastSyncedAt)}</span>}
                </>
              ) : justConnected ? (
                <span>
                  Connected
                  {justConnected.tenants ? ` · ${justConnected.tenants} tenant${justConnected.tenants === 1 ? '' : 's'}` : ''} · chart of accounts not synced
                </span>
              ) : (
                <span>Connected · chart of accounts not synced</span>
              )}
            </div>
          )}
          {errorMessage && (
            <div
              style={{
                fontSize: 12,
                color: T.alert,
                lineHeight: 1.45,
                marginTop: 4,
                maxWidth: 540
              }}
            >
              {errorMessage}
            </div>
          )}
          {!errorMessage && transientNotice && (
            <div
              style={{
                fontSize: 12,
                color: T.ok,
                lineHeight: 1.45,
                marginTop: 4,
                maxWidth: 540
              }}
            >
              {transientNotice}
            </div>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {(!isConnected || needsReauth) && (
          <PrimaryButton
            onClick={handleConnect}
            busy={busy === 'connect'}
            disabled={loadStatus === 'loading' || loadStatus === 'error'}
            accent={T.accent}
          >
            {needsReauth ? 'Reconnect Xero' : 'Connect Xero'}
          </PrimaryButton>
        )}
        {isConnected && !hasSynced && (
          <PrimaryButton
            onClick={handleSync}
            busy={busy === 'sync'}
            disabled={busy === 'provision'}
            accent={T.accent}
          >
            Refresh Xero data
          </PrimaryButton>
        )}
        {isConnected && hasSynced && !errorMessage && (
          <GhostButton onClick={handleSync} busy={busy === 'sync'} disabled={busy === 'provision'}>
            Refresh data
          </GhostButton>
        )}
        {isConnected && hasSynced && !errorMessage && (
          <PrimaryButton
            onClick={handleProvisionCoa}
            busy={busy === 'provision'}
            disabled={busy === 'sync'}
            accent={T.accent}
          >
            Provision CoA
          </PrimaryButton>
        )}
        {isConnected && !hasSynced && !errorMessage && (
          <GhostButton
            onClick={handleProvisionCoa}
            busy={busy === 'provision'}
            disabled={busy === 'sync'}
          >
            Provision CoA
          </GhostButton>
        )}
        {errorMessage && isConnected && (
          <GhostButton onClick={handleSync} busy={busy === 'sync'}>
            Retry sync
          </GhostButton>
        )}
      </div>
    </section>
  );
}
