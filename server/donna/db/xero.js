import { retainedXeroMirrorPreview, xeroMirrorReplayError } from '../xeroMirrorReplay.js';
import { resolvePostingContextWithClient, assertPostingContextReceipt, assertPostingSuggestionLineage, postingSourceReceipt, assertPostingSourceReceipt } from './postingPolicyContext.js';
// server/donna/db/xero.js — plane S mirror — the Xero connection, bank-transaction writeback, mirror retry / verify / clear, chart provisioning and reference sync.
//
// RT-17 (2026-09-02): extracted from server/donna/firmDb.js as a pure move. Every public
// symbol keeps its old import path through firmDb.js, which re-exports it; helpers another
// plane needs are exported here and NOT re-exported by firmDb.js. Zero behaviour change.

import { toLocalIsoDay, toUtcIsoDay } from '../dates.js';
// RT-16 — the ONE coding state (transactions.coding_state, migration 138):
// the machine, the legacy-input mapping, the DTO projection, the writer.
import { applyCodingTransition } from '../codingState.js';
// INT-4 — push failure + mirror drift onto the case spine (best-effort, no-throw
// by contract; gated on the LEDGER_SYNC_CASES config-plane flag inside the module).
import { applyMirrorVerificationToSyncCases, recordExternalSyncFailure, resolveExternalSyncCase } from '../ledgerSyncCases.js';
import { addXeroBankTransactionHistoryNote, buildXeroAuthorizeUrl, createXeroAccount, createXeroBankTransaction, createXeroState, deleteXeroConnection, exchangeXeroCode, fetchXeroAccounts, fetchXeroBankTransactionById, fetchXeroBankTransactionsByFingerprint, fetchXeroBankTransactionsByReference, fetchXeroConnections, fetchXeroContacts, getXeroConfig, isXeroConfigured, normalizeXeroAccount, normalizeXeroConnection, normalizeXeroContact, refreshXeroToken, shouldRefreshXeroToken, verifyXeroState, voidXeroBankTransaction } from '../xeroClient.js';
import { buildXeroCoaProvisionPlan } from '../xeroCoaProvisioning.js';
import { buildXeroBankTransactionWriteback, buildXeroHistoryNote, codingInputFromTransaction, codingModelForTransaction, isSuspenseParkedCoding, isXeroConnectionLevelError, isXeroIdempotencyCollision, summarizeHistoryNoteOutcome, xeroSyncedReceiptPatch } from '../xeroWriteback.js';
import { normalizeLedgerPeriod } from '../ledgerReadModel.js';
import { buildXeroMirrorVerificationResult } from '../xeroMirrorVerification.js';
import { ACCOUNTING_AUDIT_ACTIONS } from '../accountingSystems/contract.js';

import { queryFirmDb, queryOptionalFirmDb, withFirmDbClient } from './pool.js';
import { shortHash, slugifyRulePart } from './shared.js';
import { DEFAULT_FIRM_ID, requireClientInFirm, getClientJurisdictionForEnrichment } from './clients.js';
import { rowToTransactionPayload } from './transactions.js';
import { executePostingPolicyOperation, PostingPolicyError } from '../postingPolicy.js';
import { postLedgerJournalForTransaction, authoritativeTaxCoding, assertPostableTaxCoding, receiptPostingFailure } from './ledger.js';
import { getFirmSnapshotFromDb } from './snapshot.js';

export const rowToXeroConnectionPayload = (row = {}) => ({
  ...(row.payload || {}),
  id: row.id,
  firm_id: row.firm_id,
  client_id: row.client_id,
  tenant_id: row.tenant_id,
  tenant_name: row.tenant_name,
  tenant_type: row.tenant_type,
  auth_event_id: row.auth_event_id,
  status: row.status,
  scopes: Array.isArray(row.scopes) ? row.scopes : [],
  token_type: row.token_type,
  expires_at: row.expires_at ? new Date(row.expires_at).toISOString() : null,
  connected_at: row.connected_at ? new Date(row.connected_at).toISOString() : null,
  last_synced_at: row.last_synced_at ? new Date(row.last_synced_at).toISOString() : null,
  last_error: row.last_error,
  created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
  updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null
});

export const rowToXeroAccountPayload = (row = {}) => ({
  ...(row.payload || {}),
  id: row.id,
  connection_id: row.connection_id,
  firm_id: row.firm_id,
  client_id: row.client_id,
  xero_account_id: row.xero_account_id,
  code: row.code,
  name: row.name,
  type: row.type,
  status: row.status,
  tax_type: row.tax_type,
  class: row.class,
  system_account: row.system_account,
  enable_payments_to_account: Boolean(row.enable_payments_to_account),
  show_in_expense_claims: Boolean(row.show_in_expense_claims),
  account_label: row.code && row.name ? `${row.code} · ${row.name}` : row.name || row.code || ''
});

export const rowToXeroContactPayload = (row = {}) => ({
  ...(row.payload || {}),
  id: row.id,
  connection_id: row.connection_id,
  firm_id: row.firm_id,
  client_id: row.client_id,
  xero_contact_id: row.xero_contact_id,
  contact_number: row.contact_number,
  name: row.name,
  email_address: row.email_address,
  is_customer: Boolean(row.is_customer),
  is_supplier: Boolean(row.is_supplier),
  status: row.status
});

export const getXeroAccountsForClient = async ({ client, firmId, clientId }) => {
  if (!clientId) return [];
  const result = await client.query(
    'select * from xero_accounts where firm_id = $1 and client_id = $2 order by code nulls last, name',
    [firmId, clientId]
  ).catch((error) => {
    if (error?.code === '42P01' || error?.code === '42703') return { rows: [] };
    throw error;
  });
  return result.rows.map(rowToXeroAccountPayload);
};

const getXeroContactsForClient = async ({ client, firmId, clientId }) => {
  if (!clientId) return [];
  const result = await client.query(
    'select * from xero_contacts where firm_id = $1 and client_id = $2 order by name nulls last',
    [firmId, clientId]
  ).catch((error) => {
    if (error?.code === '42P01' || error?.code === '42703') return { rows: [] };
    throw error;
  });
  return result.rows.map(rowToXeroContactPayload);
};

const xeroConnectionIdForTenant = ({ clientId, tenantId }) =>
  ['xero-connection', slugifyRulePart(clientId), slugifyRulePart(tenantId), shortHash(`${clientId}|${tenantId}`)].join('-').slice(0, 140);

const xeroRecordId = (...parts) => ['xero', ...parts.map((part) => slugifyRulePart(String(part || 'unknown'))), shortHash(parts.join('|'))]
  .join('-')
  .slice(0, 140);

const requireXeroConfigured = () => {
  if (!isXeroConfigured()) {
    const error = new Error('Xero OAuth is not configured. Set XERO_CLIENT_ID, XERO_CLIENT_SECRET, and XERO_REDIRECT_URI.');
    error.statusCode = 500;
    throw error;
  }
};

export const startXeroConnectionInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  returnTo = '/firms?tab=accounting',
  redirectUri
} = {}) => {
  requireXeroConfigured();
  if (!clientId) {
    const error = new Error('Client id is required to connect Xero.');
    error.statusCode = 400;
    throw error;
  }

  await withFirmDbClient(async (client) => requireClientInFirm({ client, firmId, clientId }));
  // redirectUri is the host-derived callback URL the route resolved from the
  // serving request; embed it in the state and use it for the authorize URL so
  // the callback lands on this deployment (not a stale XERO_REDIRECT_URI).
  const state = createXeroState({ firmId, clientId, returnTo, redirectUri });
  return {
    authorizeUrl: buildXeroAuthorizeUrl({ state, redirectUri }),
    state,
    scopes: getXeroConfig().scopes
  };
};

export const completeXeroConnectionInDb = async ({ code, state } = {}) => {
  requireXeroConfigured();
  const statePayload = verifyXeroState(state);
  const firmId = statePayload.firm_id || DEFAULT_FIRM_ID;
  const clientId = statePayload.client_id;
  // Reuse the exact redirect_uri the authorize step sent (carried in the
  // signed state); falls back to the env inside exchangeXeroCode when absent.
  const token = await exchangeXeroCode({ code, redirectUri: statePayload.redirect_uri });
  const rawConnections = await fetchXeroConnections({ accessToken: token.accessToken });
  const connections = (Array.isArray(rawConnections) ? rawConnections : [])
    .map(normalizeXeroConnection)
    .filter((connection) => connection.tenantId);

  if (!connections.length) {
    const error = new Error('Xero authorized successfully but returned no connected organisations.');
    error.statusCode = 502;
    throw error;
  }

  await withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      await requireClientInFirm({ client, firmId, clientId });
      for (const connection of connections) {
        const connectionId = xeroConnectionIdForTenant({ clientId, tenantId: connection.tenantId });
        await client.query(
          `insert into xero_connections (
             id, firm_id, client_id, tenant_id, tenant_name, tenant_type, auth_event_id,
             status, scopes, access_token, refresh_token, id_token, token_type, expires_at, last_error, payload
           )
           values ($1, $2, $3, $4, $5, $6, $7, 'connected', $8::text[], $9, $10, $11, $12, $13::timestamptz, null, $14::jsonb)
           on conflict (firm_id, client_id, tenant_id) do update set
             tenant_name = excluded.tenant_name,
             tenant_type = excluded.tenant_type,
             auth_event_id = excluded.auth_event_id,
             status = 'connected',
             scopes = excluded.scopes,
             access_token = excluded.access_token,
             refresh_token = excluded.refresh_token,
             id_token = excluded.id_token,
             token_type = excluded.token_type,
             expires_at = excluded.expires_at,
             last_error = null,
             payload = xero_connections.payload || excluded.payload,
             updated_at = now()`,
          [
            connectionId,
            firmId,
            clientId,
            connection.tenantId,
            connection.tenantName || null,
            connection.tenantType || null,
            connection.authEventId || null,
            token.scopes,
            token.accessToken,
            token.refreshToken,
            token.idToken,
            token.tokenType,
            token.expiresAt,
            JSON.stringify({
              connection: connection.payload,
              token: {
                scope: token.scopes,
                expires_at: token.expiresAt
              }
            })
          ]
        );
      }
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', '${ACCOUNTING_AUDIT_ACTIONS.connect}', 'accounting_system_connection', $2, $3::jsonb)`,
        [firmId, clientId, JSON.stringify({ accounting_system: 'xero', tenant_count: connections.length })]
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });

  return {
    snapshot: await getFirmSnapshotFromDb({ firmId }),
    state: statePayload,
    connections
  };
};

// Exported for the refresh-honesty tests (fake client + stubbed fetch); all
// production callers are internal to this module.
export const getFreshXeroConnectionForSync = async ({ client, firmId, clientId, connectionId }) => {
  const params = [firmId, clientId];
  const result = await client.query(
    `select *
     from xero_connections
     where firm_id = $1
       and client_id = $2
       and status in ('connected', 'expired', 'error')
       ${connectionId ? 'and id = $3' : ''}
     order by connected_at desc
     limit 1`,
    connectionId ? [...params, connectionId] : params
  );
  const connection = result.rows[0];
  if (!connection) {
    const error = new Error('Xero connection not found.');
    error.statusCode = 404;
    throw error;
  }

  if (!shouldRefreshXeroToken(connection.expires_at)) return connection;

  let token;
  try {
    token = await refreshXeroToken({ refreshToken: connection.refresh_token });
  } catch (refreshError) {
    // Best-effort on a SEPARATE connection: the throw below may roll back the
    // caller's open transaction, and the honesty flip must survive it. The row
    // stays selectable ('expired' is in the status filter above), so a later
    // successful refresh or sync writes it back to 'connected'.
    await queryFirmDb(
      `update xero_connections
       set status = 'expired', last_error = $3, updated_at = now()
       where firm_id = $1 and id = $2`,
      [firmId, connection.id, refreshError.message || 'Xero token refresh failed.']
    ).catch(() => {});
    const error = new Error('Xero token refresh failed — reconnect Xero to continue.');
    error.statusCode = 401;
    error.code = 'XERO_CONNECTION_EXPIRED';
    error.cause = refreshError;
    throw error;
  }
  const payloadPatch = {
    refreshed_at: new Date().toISOString(),
    token: {
      scope: token.scopes,
      expires_at: token.expiresAt
    }
  };
  const updateResult = await client.query(
    `update xero_connections
     set status = 'connected',
         scopes = $3::text[],
         access_token = $4,
         refresh_token = $5,
         id_token = coalesce($6, id_token),
         token_type = $7,
         expires_at = $8::timestamptz,
         last_error = null,
         payload = payload || $9::jsonb,
         updated_at = now()
     where firm_id = $1 and id = $2
     returning *`,
    [
      firmId,
      connection.id,
      token.scopes,
      token.accessToken,
      token.refreshToken || connection.refresh_token,
      token.idToken || null,
      token.tokenType,
      token.expiresAt,
      JSON.stringify(payloadPatch)
    ]
  );
  return updateResult.rows[0] || connection;
};

// A fresh AbortSignal that trips after 8s, so a slow Xero call in the
// best-effort revoke path can never hang a disconnect/delete. Undefined on
// runtimes without AbortSignal.timeout (then the fetch is simply un-bounded).
const xeroRevokeTimeoutSignal = () =>
  typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(8000)
    : undefined;

// Best-effort revoke of the app<->org grant at Xero (DELETE /connections/{id})
// for a single loaded xero_connections ROW. Donna's disconnect + client-delete
// used to be DB-only, so after tearing down our rows Xero kept listing the org
// as connected to the app — a re-connect after a client reset then hit "already
// connected" and the operator was stuck (the connection sibling of the
// mirror-clear gap in docs/xero-writeback-idempotency-across-reset.md). This
// makes the local teardown a clean slate at Xero too.
//
// It NEVER throws: a revoke failure (no Xero config, stale/expired token, a
// network blip) must not block the local disconnect/delete, which remain the
// operator's source of truth. Returns a small summary for the audit trail.
const revokeXeroGrantBestEffort = async (connection = {}) => {
  const tenantId = connection.tenant_id || null;
  if (!isXeroConfigured()) return { revoked: false, reason: 'not_configured', tenant_id: tenantId };
  try {
    let accessToken = connection.access_token || '';
    if ((!accessToken || shouldRefreshXeroToken(connection.expires_at)) && connection.refresh_token) {
      const token = await refreshXeroToken({ refreshToken: connection.refresh_token });
      accessToken = token.accessToken || accessToken;
    }
    if (!accessToken) return { revoked: false, reason: 'no_access_token', tenant_id: tenantId };

    // Resolve Xero's own connection id authoritatively (live GET /connections,
    // matched by tenant); fall back to the id we persisted in payload at
    // connect time. The persisted xero_connections.id is OUR deterministic id,
    // not Xero's, so it can't be used for the DELETE.
    let xeroConnectionId = '';
    try {
      const raw = await fetchXeroConnections({ accessToken, signal: xeroRevokeTimeoutSignal() });
      const list = Array.isArray(raw) ? raw : [];
      const match = list.find((entry) => (entry.tenantId || entry.tenant_id) === tenantId);
      xeroConnectionId = match?.id || '';
    } catch {
      // ignore — fall back to the stored id below
    }
    if (!xeroConnectionId) {
      const payload = connection.payload || {};
      xeroConnectionId = payload.connection?.id || payload.id || '';
    }
    if (!xeroConnectionId) return { revoked: false, reason: 'no_connection_id', tenant_id: tenantId };

    await deleteXeroConnection({ accessToken, connectionId: xeroConnectionId, signal: xeroRevokeTimeoutSignal() });
    return { revoked: true, connection_id: xeroConnectionId, tenant_id: tenantId };
  } catch (error) {
    return { revoked: false, reason: error?.message || 'revoke_failed', tenant_id: tenantId };
  }
};

// Best-effort revoke of EVERY Xero grant for a (firm, client) — optionally a
// single connection. Loads the rows (with tokens) then revokes each. Network is
// done OUTSIDE any DB transaction so it never holds a pooled connection. Never
// throws; returns the per-row summaries.
export const revokeXeroGrantsForClientBestEffort = async ({ firmId, clientId, connectionId } = {}) => {
  if (!isXeroConfigured()) return [];
  try {
    const existing = await queryOptionalFirmDb(
      `select * from xero_connections
       where firm_id = $1 and client_id = $2
         ${connectionId ? 'and id = $3' : ''}`,
      connectionId ? [firmId, clientId, connectionId] : [firmId, clientId]
    );
    const rows = existing?.rows || [];
    const results = [];
    for (const row of rows) {
      results.push(await revokeXeroGrantBestEffort(row));
    }
    return results;
  } catch {
    // best-effort — never block the caller on a Xero revoke
    return [];
  }
};

// Disconnect a client's Xero connection. The symmetric mirror of
// disconnectQboConnectionInDb: marks the xero_connections row(s) 'disconnected'
// so the snapshot-derived status flips and the operator card shows Connect
// again; reconnecting re-runs OAuth and upserts the row back to 'connected'.
// Now also revokes the grant at Xero (best-effort, BEFORE the status flip while
// a usable token is still present) so the org stops showing as "already
// connected" to the app. The Xero call is done outside the DB transaction and
// never blocks the local disconnect; pass `revokeAtProvider: false` to skip it.
export const disconnectXeroConnectionInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  connectionId,
  revokeAtProvider = true,
  clearXeroMirrorAtProvider = false
} = {}) => {
  if (!clientId) {
    const error = new Error('Client id is required to disconnect Xero.');
    error.statusCode = 400;
    throw error;
  }

  // Best-effort teardown at Xero BEFORE the status flip, while a token is still
  // usable. Clear the BankTransaction MIRROR first (a void, if enabled, needs the
  // grant), THEN revoke the grant. clearXeroMirrorAtProvider defaults FALSE —
  // DB-clear / hand-over only: keep the client's valid books in their org and
  // just drop our back-references (G1's stable reference re-matches them on any
  // later reconnect, so no duplicate). Pass true to also VOID the untouched Donna
  // mirrors (G6-guarded). See G2 in docs/donna-xero-clean-offboarding.md.
  const mirrorClear = await clearXeroMirrorForClientBestEffort({ firmId, clientId, connectionId, voidAtProvider: clearXeroMirrorAtProvider });
  const revocations = revokeAtProvider
    ? await revokeXeroGrantsForClientBestEffort({ firmId, clientId, connectionId })
    : [];

  return withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      await requireClientInFirm({ client, firmId, clientId });
      const result = await client.query(
        `update xero_connections
         set status = 'disconnected', updated_at = now()
         where firm_id = $1 and client_id = $2
           ${connectionId ? 'and id = $3' : ''}`,
        connectionId ? [firmId, clientId, connectionId] : [firmId, clientId]
      );
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', '${ACCOUNTING_AUDIT_ACTIONS.disconnect}', 'accounting_system_connection', $2, $3::jsonb)`,
        [firmId, clientId, JSON.stringify({ accounting_system: 'xero', disconnected: result.rowCount, xero_revocations: revocations, xero_mirror_clear: mirrorClear })]
      );
      await client.query('commit');
      return { disconnected: result.rowCount, revocations, mirror_clear: mirrorClear };
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
};

const requireXeroBankTransactionScope = (connection = {}) => {
  const scopes = Array.isArray(connection.scopes) ? connection.scopes : [];
  if (scopes.includes('accounting.banktransactions')) return;
  const error = new Error('Xero connection is missing accounting.banktransactions scope. Reconnect Xero before writeback.');
  error.statusCode = 400;
  error.code = 'XERO_SCOPE_REQUIRED';
  throw error;
};

const requireXeroSettingsScope = (connection = {}) => {
  const scopes = Array.isArray(connection.scopes) ? connection.scopes : [];
  if (scopes.includes('accounting.settings')) return;
  const error = new Error('Xero connection is missing accounting.settings scope. Reconnect Xero before CoA provisioning.');
  error.statusCode = 400;
  error.code = 'XERO_SCOPE_REQUIRED';
  throw error;
};

const xeroBankTransactionIdFromResponse = (response = {}) => {
  const transaction = response?.BankTransactions?.[0] ||
    response?.bankTransactions?.[0] ||
    response?.BankTransaction ||
    response?.bankTransaction ||
    {};
  return transaction.BankTransactionID ||
    transaction.BankTransactionId ||
    transaction.bankTransactionID ||
    transaction.bankTransactionId ||
    transaction.bank_transaction_id ||
    transaction.ID ||
    transaction.id ||
    '';
};

const xeroDateOnly = (value = '') => {
  const text = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const match = text.match(/Date\((\d+)/);
  if (match) {
    // UTC on purpose: Xero's `/Date(ms)/` is the UTC-midnight epoch of the
    // day it names — the host zone must not move it.
    return toUtcIsoDay(new Date(Number(match[1])));
  }
  // Free text parses to host-local midnight, so the host-local day is the
  // day the text named (audit F-11).
  return toLocalIsoDay(new Date(text));
};

const xeroMoney = (value = 0) => {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) / 100 : 0;
};

const xeroBankAccountMatches = (candidate = {}, expected = {}) => {
  const expectedCode = String(expected.Code || expected.code || '').trim();
  const expectedId = String(expected.AccountID || expected.accountId || expected.xero_account_id || '').trim();
  const candidateAccount = candidate.BankAccount || candidate.bankAccount || {};
  const candidateCode = String(candidateAccount.Code || candidateAccount.code || '').trim();
  const candidateId = String(candidateAccount.AccountID || candidateAccount.accountId || '').trim();
  if (expectedCode && candidateCode) return expectedCode === candidateCode;
  if (expectedId && candidateId) return expectedId === candidateId;
  return true;
};

const xeroBankTransactionLineTotal = (bankTransaction = {}) =>
  xeroMoney((bankTransaction.LineItems || []).reduce((sum, line) => sum + xeroMoney(line.UnitAmount || line.LineAmount), 0));

export const matchingXeroBankTransactions = ({ response = {}, bankTransaction = {} } = {}) => {
  const expectedDate = xeroDateOnly(bankTransaction.Date || bankTransaction.DateString);
  const expectedType = String(bankTransaction.Type || '').trim().toUpperCase();
  const expectedTotal = xeroBankTransactionLineTotal(bankTransaction);
  const expectedReference = String(bankTransaction.Reference || '').trim();
  const candidates = Array.isArray(response?.BankTransactions) ? response.BankTransactions : [];
  return candidates.filter((candidate) => {
    const status = String(candidate.Status || candidate.status || '').trim().toUpperCase();
    if (status === 'DELETED' || status === 'VOIDED') return false;
    if (expectedReference && String(candidate.Reference || '').trim() === expectedReference) return true;
    const candidateDate = xeroDateOnly(candidate.DateString || candidate.Date);
    const candidateType = String(candidate.Type || '').trim().toUpperCase();
    const candidateTotal = xeroMoney(candidate.Total);
    return candidateDate === expectedDate &&
      candidateType === expectedType &&
      candidateTotal === expectedTotal &&
      xeroBankAccountMatches(candidate, bankTransaction.BankAccount || {});
  });
};

const xeroWritebackErrorPayload = (error = {}) => ({
  xero_writeback_status: 'error',
  xero_writeback_error: error.message || 'Xero writeback failed.',
  xero_writeback_error_at: new Date().toISOString()
});

// ── G2: clear / void the Xero BankTransaction mirror on teardown ─────────────
// docs/xero-writeback-idempotency-across-reset.md (Option B) +
// docs/donna-xero-clean-offboarding.md (G2). On a client reset/delete the source
// rows are hard-deleted while their mirrored Xero BankTransactions live on, now
// unreferenceable -> orphans (Kari hand-deleted 37 from a pilot client). This is the
// BankTransaction-mirror half of teardown; the OAuth-grant half already ships via
// revokeXeroGrant...BestEffort, and this mirrors that best-effort pattern
// exactly: NEVER throws, gated on isXeroConfigured(), network OUTSIDE the DB
// transaction, each Xero call 8s-abort-bounded (xeroRevokeTimeoutSignal) so a
// slow call can't hang a disconnect/delete.

// The payload patch that drops a transaction's Xero back-reference. Whether we
// voided the mirror or handed it over, the back-reference must NOT survive
// teardown (else a re-upload can't cleanly re-evaluate the row). Keeps
// xero_writeback_payload/_response (the audit of what we posted — the G5 export
// still reads them) and stamps xero_mirror_cleared_at as the teardown receipt.
export const xeroMirrorClearColumnsPatch = ({ clearedAt = new Date().toISOString() } = {}) => ({
  xero_bank_transaction_id: null,
  xero_sync_status: null,
  xero_writeback_status: null,
  xero_synced_at: null,
  synced_at: null,
  xero_mirror_cleared_at: clearedAt
});

// A minimal expected BankTransaction (date + type + amount) for the G6 guard when
// no posted payload was persisted (older cycles / orphans). buildXeroMirror
// VerificationResult is lenient on account/tax when expected omits them, so this
// reduces the guard to the reset-stable date+type+amount fingerprint.
const minimalExpectedBankTransactionForGuard = (transaction = {}) => {
  const moneyIn = Number(transaction.money_in || 0);
  const moneyOut = Number(transaction.money_out || 0);
  return {
    Date: xeroDateOnly(transaction.date || transaction.transaction_date),
    Type: moneyIn > 0 ? 'RECEIVE' : moneyOut > 0 ? 'SPEND' : '',
    LineItems: [{ UnitAmount: xeroMoney(Math.abs(moneyIn > 0 ? moneyIn : moneyOut)) }]
  };
};

// G6 guard — decide whether a mirrored row may be voided. Only an UNTOUCHED Donna
// mirror (the live Xero row still matches what we posted — date/amount/account/
// tax, and not already DELETED) is voided; a human-edited row (mirror_drift), an
// already-gone row (mirror_missing) or an unreadable one is HANDED OVER, never
// clobbered. (We still clear our DB back-reference afterwards regardless.) Reuses
// the exact comparator the verify endpoint uses (xeroMirrorVerification.js).
export const shouldVoidXeroMirrorRow = ({ transaction = {}, expectedBankTransaction = {}, xeroResponse = null } = {}) => {
  const expected = expectedBankTransaction && Object.keys(expectedBankTransaction).length
    ? expectedBankTransaction
    : minimalExpectedBankTransactionForGuard(transaction);
  const verdict = buildXeroMirrorVerificationResult({ transaction, expectedBankTransaction: expected, xeroResponse });
  return {
    void: verdict.status === 'mirror_ok',
    status: verdict.status,
    reason: verdict.status === 'mirror_ok' ? 'untouched_mirror' : `guard_${verdict.status}`
  };
};

// DB read (default seam): the client's mirrored transaction rows + (only when a
// provider-side void will run) a usable connection (token + tenant), refreshed if
// stale. Token refresh is the only network here; the per-row Xero reads/voids
// happen in the orchestrator. When `needsConnection` is false (DB-clear-only /
// hand-over) we skip the connection load entirely — no token, no network.
const defaultLoadXeroMirrorContext = async ({ firmId, clientId, connectionId, needsConnection = true } = {}) => {
  const txResult = await queryOptionalFirmDb(
    `select id, transaction_date, money_in, money_out, currency, payload
       from transactions
      where firm_id = $1 and client_id = $2
        and coalesce(payload->>'xero_bank_transaction_id', '') <> ''`,
    [firmId, clientId]
  );
  const rows = (txResult?.rows || [])
    .map((row) => {
      const transaction = rowToTransactionPayload(row);
      return {
        id: row.id,
        xero_bank_transaction_id: transaction.xero_bank_transaction_id || null,
        expectedBankTransaction:
          transaction.xero_writeback_payload || transaction.xero_mirror_retry_payload || {},
        transaction
      };
    })
    .filter((row) => row.xero_bank_transaction_id);
  if (!rows.length || !needsConnection) return { accessToken: '', tenantId: '', connectionId: null, rows };

  const connResult = await queryOptionalFirmDb(
    `select * from xero_connections
      where firm_id = $1 and client_id = $2
        ${connectionId ? 'and id = $3' : ''}
      order by (status = 'connected') desc, connected_at desc nulls last`,
    connectionId ? [firmId, clientId, connectionId] : [firmId, clientId]
  );
  const connection = (connResult?.rows || [])[0] || null;
  let accessToken = connection?.access_token || '';
  const tenantId = connection?.tenant_id || '';
  if (connection && (!accessToken || shouldRefreshXeroToken(connection.expires_at)) && connection.refresh_token) {
    try {
      const token = await refreshXeroToken({ refreshToken: connection.refresh_token });
      accessToken = token.accessToken || accessToken;
    } catch {
      // best-effort — proceed DB-only if the token can't be refreshed
    }
  }
  return { accessToken, tenantId, connectionId: connection?.id || null, rows };
};

// DB write (default seam): drop the Xero back-reference on the handled rows.
const defaultClearXeroMirrorColumns = async ({ firmId, clientId, rows = [], clearedAt } = {}) => {
  const ids = rows.map((row) => row.id).filter(Boolean);
  if (!ids.length) return 0;
  const patch = JSON.stringify(xeroMirrorClearColumnsPatch({ clearedAt }));
  const result = await queryFirmDb(
    `update transactions
        set payload = payload || $4::jsonb,
            updated_at = now()
      where firm_id = $1 and client_id = $2 and id = any($3)`,
    [firmId, clientId, ids, patch]
  );
  // D5: the review-queue carries a SECOND copy of the Xero mirror markers (the
  // writeback success path writes both). Clear it symmetrically so a later
  // per-row writeback can't merge a ghost `xero_bank_transaction_id` back in and
  // falsely refuse the row as "already written back". Matches on either the
  // review item_id or the payload's transaction_id (the same join the writeback
  // uses). Best-effort like the whole teardown — never throws.
  await queryFirmDb(
    `update transaction_review_queue
        set payload = payload || $4::jsonb,
            updated_at = now()
      where firm_id = $1 and client_id = $2
        and (item_id = any($3) or payload->>'transaction_id' = any($3))`,
    [firmId, clientId, ids, patch]
  ).catch(() => {});
  return result?.rowCount || 0;
};

// Best-effort clear of a client's Xero BankTransaction mirror, for the teardown
// paths (client reset/delete and disconnect). Voids each UNTOUCHED mirror in Xero
// (G6-guarded), THEN clears the DB back-references — voids BEFORE the column
// clear, and the whole call runs BEFORE the caller's DB teardown (cascade /
// status flip) while a token is still usable. Mirrors revokeXeroGrant...
// BestEffort: NEVER throws, gated on isXeroConfigured(), network outside the DB
// transaction. `voidAtProvider:false` does the DB-side clear only (hand-over) —
// the safe cut for a plain disconnect and the spec's "ship the DB-side half
// first" option. The seams (loadMirrorContext / fetchById / voidBankTransaction /
// clearMirrorColumns / now) default to the real DB+Xero impls; the unit test
// overrides them with a mocked Xero client and no DB.
export const clearXeroMirrorForClientBestEffort = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  connectionId,
  voidAtProvider = true,
  loadMirrorContext = defaultLoadXeroMirrorContext,
  fetchById = fetchXeroBankTransactionById,
  voidBankTransaction = voidXeroBankTransaction,
  clearMirrorColumns = defaultClearXeroMirrorColumns,
  now = () => new Date()
} = {}) => {
  if (!clientId) return { ok: false, reason: 'no_client', voided: 0, cleared: 0, rows: [] };
  if (!isXeroConfigured()) return { ok: false, reason: 'not_configured', voided: 0, cleared: 0, rows: [] };
  try {
    const context = await loadMirrorContext({ firmId, clientId, connectionId, needsConnection: voidAtProvider });
    const mirrorRows = context?.rows || [];
    if (!mirrorRows.length) return { ok: true, reason: 'no_mirror', voided: 0, cleared: 0, rows: [] };

    const canVoid = voidAtProvider && Boolean(context.accessToken && context.tenantId);
    const rows = [];
    for (const row of mirrorRows) {
      const xeroBankTransactionId = row.xero_bank_transaction_id;
      let voided = false;
      let status;
      let reason;
      if (!voidAtProvider) {
        status = 'db_clear_only';
        reason = 'hand_over';
      } else if (!canVoid) {
        status = 'no_connection';
        reason = 'token_unavailable';
      } else if (!xeroBankTransactionId) {
        status = 'no_xero_id';
        reason = 'missing_id';
      } else {
        try {
          const xeroResponse = await fetchById({
            accessToken: context.accessToken,
            tenantId: context.tenantId,
            bankTransactionId: xeroBankTransactionId,
            signal: xeroRevokeTimeoutSignal()
          });
          const decision = shouldVoidXeroMirrorRow({
            transaction: row.transaction || { id: row.id },
            expectedBankTransaction: row.expectedBankTransaction || {},
            xeroResponse
          });
          status = decision.status;
          reason = decision.reason;
          if (decision.void) {
            await voidBankTransaction({
              accessToken: context.accessToken,
              tenantId: context.tenantId,
              bankTransactionId: xeroBankTransactionId,
              idempotencyKey: `donna:${firmId}:${clientId}:mirror-clear:${xeroBankTransactionId}`.slice(0, 128),
              signal: xeroRevokeTimeoutSignal()
            });
            voided = true;
          }
        } catch (error) {
          status = 'void_error';
          reason = error?.message || 'void_failed';
        }
      }
      rows.push({ transaction_id: row.id, xero_bank_transaction_id: xeroBankTransactionId, voided, status, reason });
    }

    // Always clear the DB back-references AFTER the Xero voids (voided OR handed
    // over) — the back-reference must not survive teardown.
    const cleared = await clearMirrorColumns({ firmId, clientId, rows: mirrorRows, clearedAt: now().toISOString() });
    return { ok: true, reason: 'ok', voided: rows.filter((entry) => entry.voided).length, cleared, rows };
  } catch (error) {
    // best-effort — never block the caller's disconnect/delete on a mirror clear
    return { ok: false, reason: error?.message || 'clear_failed', voided: 0, cleared: 0, rows: [] };
  }
};

// ─── G7: human-readable provenance in Xero (History & Notes) ───────────────
// Append Donna's coding verdict + provenance to a posted BankTransaction's
// History & Notes, so the CPA who inherits the org reads WHY each line is coded
// the way it is. Pure audit enrichment: every caller posts it best-effort and a
// failed note NEVER fails or rolls back a successful posting (mirrors
// revokeXeroGrant... / clearXeroMirror...BestEffort — gated on isXeroConfigured,
// network outside any DB txn, 8s abort, swallows errors).
const appendXeroHistoryNoteBestEffort = async ({
  accessToken,
  tenantId,
  xeroBankTransactionId,
  transaction = null,
  coding = null,
  note = ''
} = {}) => {
  try {
    if (!isXeroConfigured()) return { ok: false, skipped: 'not_configured' };
    const bankTransactionId = String(xeroBankTransactionId || '').trim();
    if (!bankTransactionId) return { ok: false, skipped: 'no_bank_transaction_id' };
    if (!accessToken || !tenantId) return { ok: false, skipped: 'no_connection' };
    const details = String(note || '').trim() || buildXeroHistoryNote(transaction || {}, { coding });
    if (!details) return { ok: false, skipped: 'empty_note' };
    await addXeroBankTransactionHistoryNote({
      accessToken,
      tenantId,
      bankTransactionId,
      details,
      signal: xeroRevokeTimeoutSignal()
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || 'history_note_failed' };
  }
};

// Post-hoc variant: append a History note to an ALREADY-SYNCED transaction (after
// a firm note, or a recode that did not re-post). Loads the row's
// xero_bank_transaction_id and the client's connection (refreshing the token
// best-effort), then posts. No-op — NOT an error — when the row was never synced
// (nothing in Xero to annotate) or Xero is not configured.
export const appendXeroHistoryNoteForTransactionInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  transactionId,
  note = ''
} = {}) => {
  try {
    if (!isXeroConfigured()) return { ok: false, skipped: 'not_configured' };
    if (!clientId || !transactionId) return { ok: false, skipped: 'missing_args' };
    const txResult = await queryOptionalFirmDb(
      'select * from transactions where firm_id = $1 and client_id = $2 and id = $3 limit 1',
      [firmId, clientId, transactionId]
    );
    const row = (txResult?.rows || [])[0];
    if (!row) return { ok: false, skipped: 'not_found' };
    const transaction = rowToTransactionPayload(row);
    const xeroBankTransactionId = transaction.xero_bank_transaction_id || null;
    if (!xeroBankTransactionId) return { ok: false, skipped: 'not_synced' };

    const connResult = await queryOptionalFirmDb(
      `select * from xero_connections
        where firm_id = $1 and client_id = $2
        order by (status = 'connected') desc, connected_at desc nulls last
        limit 1`,
      [firmId, clientId]
    );
    const connection = (connResult?.rows || [])[0] || null;
    if (!connection) return { ok: false, skipped: 'no_connection' };
    let accessToken = connection.access_token || '';
    const tenantId = connection.tenant_id || '';
    if ((!accessToken || shouldRefreshXeroToken(connection.expires_at)) && connection.refresh_token) {
      try {
        const token = await refreshXeroToken({ refreshToken: connection.refresh_token });
        accessToken = token.accessToken || accessToken;
      } catch {
        // best-effort — if the token can't refresh, the note simply isn't posted
      }
    }
    return appendXeroHistoryNoteBestEffort({ accessToken, tenantId, xeroBankTransactionId, transaction, note });
  } catch (error) {
    return { ok: false, error: error?.message || 'history_note_failed' };
  }
};

const isTransactionPostedToDonnaLedger = (transaction = {}) =>
  Boolean(
    transaction.ledger_journal_id ||
      transaction.ledger_status === 'posted' ||
      transaction.ledger_status === 'closed' ||
      transaction.review_state === 'posted' ||
      transaction.review_state === 'closed'
  );

export const isTransactionSyncedToXero = (transaction = {}) =>
  transaction.xero_sync_status === 'synced' ||
  transaction.xero_writeback_status === 'synced' ||
  transaction.xero_bank_transaction_id ||
  transaction.xero_synced_at ||
  transaction.synced_at;

// D5 (2026-07-07): the per-row writeback merges the review-queue row for its
// FRESHER review_state + coding, but the review queue is a SECOND copy of the
// Xero mirror markers and a teardown (disconnect / client reset) clears them on
// `transactions` ONLY (defaultClearXeroMirrorColumns) — leaving the review queue
// with a ghost `xero_bank_transaction_id`. The `transactions` row is
// authoritative for sync state (it is what the candidate query filters on and
// what the success path pre-stamps first), so the sync markers must survive the
// merge unchanged — else the ghost resurrects the "already written back" guard
// and a re-export after emptying Xero is impossible without `force`. Mutates and
// returns `transaction`; a null review row is a no-op. Self-heals existing ghosts
// (no backfill needed). Pure + exported for tests.
export const mergeReviewRowIntoTransaction = (transaction = {}, reviewRow = null) => {
  if (!reviewRow) return transaction;
  const authoritativeSyncMarkers = {
    xero_bank_transaction_id: transaction.xero_bank_transaction_id || null,
    xero_sync_status: transaction.xero_sync_status || null,
    xero_writeback_status: transaction.xero_writeback_status || null,
    xero_synced_at: transaction.xero_synced_at || null,
    synced_at: transaction.synced_at || null
  };
  return Object.assign(
    transaction,
    reviewRow.payload || {},
    { review_state: reviewRow.review_state || reviewRow.payload?.review_state || transaction.review_state },
    authoritativeSyncMarkers
  );
};

// JS mirror of transactionWritebackCandidateQuery's settled filter + the
// suspense-parked exclusion — the operator card's pending-export count MUST
// promise exactly what the export batch will accept (live receipt 2026-07-07:
// the card said "Export 4" while the batch had 25 candidates — the old count
// only looked at ledger-posted rows). Keep the arms in lockstep with the SQL;
// firmDb.test.js pins both.
// RT-16: the settled arm reads the ONE coding state (the DTO's projected
// `review_state` label is accepted for a row that only carries the label).
const XERO_SETTLED_CODING_STATES = new Set(['applied', 'posted', 'closed']);
const XERO_SETTLED_REVIEW_STATES = new Set(['accepted', 'resolved', 'posted', 'closed']);
export const __isXeroExportCandidateTransaction = (transaction = {}) => {
  if (isTransactionSyncedToXero(transaction)) return false;
  if (isSuspenseParkedCoding(codingInputFromTransaction(transaction))) return false;
  return (
    transaction.status === 'approved' ||
    XERO_SETTLED_CODING_STATES.has(String(transaction.coding_state || '')) ||
    XERO_SETTLED_REVIEW_STATES.has(String(transaction.review_state || '')) ||
    isTransactionPostedToDonnaLedger(transaction)
  );
};

const hasXeroMirrorError = (transaction = {}) =>
  Boolean(transaction.xero_writeback_error || transaction.xero_sync_error || transaction.xero_error);

const mirrorRetryAmountFor = (transaction = {}) => {
  const value = Number(transaction.ledger_amount || transaction.money_in || transaction.money_out || transaction.amount || 0);
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
};

const xeroMirrorDriftIssueFor = (transaction = {}) => {
  const ledgerAccount = String(transaction.account_code || transaction.proposed_account || '').trim();
  const xeroAccount = String(transaction.xero_account_code || transaction.payload?.xero_account_code || '').trim();
  if (ledgerAccount && xeroAccount && ledgerAccount !== xeroAccount) return 'account_drift';
  const ledgerAmount = mirrorRetryAmountFor(transaction);
  const xeroAmountRaw = transaction.xero_amount || transaction.xero_total;
  if (xeroAmountRaw == null || xeroAmountRaw === '') return '';
  const xeroAmount = mirrorRetryAmountFor({ amount: xeroAmountRaw });
  return Math.abs(ledgerAmount - xeroAmount) >= 0.01 ? 'amount_drift' : '';
};

export const classifyXeroMirrorRetryTransaction = ({
  transaction = {},
  selected = false,
  force = false
} = {}) => {
  if (!isTransactionPostedToDonnaLedger(transaction)) {
    return {
      eligible: false,
      issue: 'ledger_not_posted',
      reason: 'Donna ledger row is not posted. Post to Donna before repairing the Xero mirror.'
    };
  }
  if (hasXeroMirrorError(transaction)) {
    return {
      eligible: true,
      issue: 'xero_mirror_error',
      reason: 'Xero mirror export errored and can be retried from the posted Donna ledger row.'
    };
  }
  if (!isTransactionSyncedToXero(transaction)) {
    return {
      eligible: true,
      issue: 'missing_in_xero',
      reason: 'Posted Donna ledger row is missing from the Xero mirror.'
    };
  }
  const driftIssue = xeroMirrorDriftIssueFor(transaction);
  if (selected && driftIssue && force) {
    return {
      eligible: true,
      issue: driftIssue,
      reason: 'Selected Xero mirror drift row will be retried from Donna ledger truth.'
    };
  }
  if (selected && driftIssue) {
    return {
      eligible: false,
      issue: driftIssue,
      reason: 'Xero mirror drift needs an explicit force retry or live verification before repair.'
    };
  }
  if (force) {
    return {
      eligible: true,
      issue: 'force_retry',
      reason: 'Force retry requested for a posted Donna ledger row.'
    };
  }
  return {
    eligible: false,
    issue: 'already_exported',
    reason: 'Posted Donna ledger row already has a Xero mirror export.'
  };
};

// Settled-verdict export filter (docs/xero-writeback-idempotency-across-reset.md
// §8.5): the settled clause applies UNCONDITIONALLY — include_all and explicit
// ids scope WHICH settled rows are considered, they no longer bypass the filter.
// The operator card's Export button sends include_all, and the bypass is how
// the pilot client's Suspense-parked statement lines were exported into a live org as
// meaningless `Account: Suspense` entries. Two-terminal-states applied to
// export: only a row with a settled verdict — operator-approved, review
// accepted/resolved, an applied AI suggestion, or (the strongest receipt) a
// posted/closed Donna ledger journal — may leave Donna; a parked row is still
// Donna's problem, not the accountant's. The ledger-receipt arm keeps this
// aligned with the operator card's pending-export count
// (isTransactionPostedToDonnaLedger) so the button never promises rows the
// batch then refuses. Unsettled rows requested explicitly are skipped, visible
// as counts.requested vs counts.candidates in the batch payload.
const transactionWritebackCandidateQuery = ({ explicitIds = false, includeAll = false } = {}) => `
  select *
  from transactions
  where firm_id = $1
    and client_id = $2
    ${explicitIds ? 'and id = any($3)' : ''}
    and coalesce(payload->>'xero_sync_status', '') <> 'synced'
    and coalesce(payload->>'xero_writeback_status', '') <> 'synced'
    and coalesce(payload->>'xero_bank_transaction_id', '') = ''
    and (
      status = 'approved'
      or coding_state in ('applied', 'posted', 'closed')
      or coalesce(payload->>'ledger_journal_id', '') <> ''
      or payload->>'ledger_status' in ('posted', 'closed')
    )
    ${explicitIds ? '' : `
    order by transaction_date nulls last, created_at
    limit $3`}
`;
export const __transactionWritebackCandidateQuery = transactionWritebackCandidateQuery;

const compactWritebackResult = ({ transactionId, result, dryRun }) => {
  const writeback = result?.xero_writeback || {};
  return {
    transaction_id: transactionId,
    status: dryRun ? 'preview' : 'synced',
    dry_run: Boolean(dryRun),
    coding: writeback.coding || null,
    bank_account: writeback.bank_account || null,
    bank_transaction: writeback.bank_transaction || null,
    xero_bank_transaction_id: writeback.xero_bank_transaction_id || null,
    matched_existing: Boolean(writeback.xero_response?.matched_existing),
    match_strategy: writeback.xero_response?.match_strategy || null,
    // D3: the History & Notes append outcome, so a silent note failure is
    // visible in the batch result instead of vanishing.
    history_note: writeback.history_note || null,
    synced_at: writeback.synced_at || null
  };
};

const compactMirrorRetryResult = ({ transactionId, result, dryRun, issue }) => {
  const retry = result?.xero_mirror_retry || {};
  return {
    transaction_id: transactionId,
    status: dryRun ? 'ready' : 'retried',
    dry_run: Boolean(dryRun),
    issue,
    coding: retry.coding || null,
    bank_account: retry.bank_account || null,
    bank_transaction: retry.bank_transaction || null,
    xero_bank_transaction_id: retry.xero_bank_transaction_id || null,
    matched_existing: Boolean(retry.xero_response?.matched_existing),
    match_strategy: retry.xero_response?.match_strategy || null,
    history_note: retry.history_note || null,
    retried_at: retry.retried_at || null
  };
};

const exportXeroMirrorRetryTransactionInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  transactionId,
  connectionId,
  dryRun = true,
  force = false,
  actorId = null
} = {}) => {
  const prepared = await withFirmDbClient(async (client) => {
    await requireClientInFirm({ client, firmId, clientId });
    const connection = await getFreshXeroConnectionForSync({ client, firmId, clientId, connectionId });
    requireXeroBankTransactionScope(connection);
    const transactionResult = await client.query(
      'select * from transactions where firm_id = $1 and client_id = $2 and id = $3',
      [firmId, clientId, transactionId]
    );
    const transactionRow = transactionResult.rows[0];
    if (!transactionRow) {
      const error = new Error('Transaction not found for Xero mirror retry.');
      error.statusCode = 404;
      throw error;
    }
    const transaction = rowToTransactionPayload(transactionRow);
    const classification = classifyXeroMirrorRetryTransaction({ transaction, selected: true, force });
    if (!classification.eligible) {
      const error = new Error(classification.reason || 'Transaction is not eligible for Xero mirror retry.');
      error.statusCode = 409;
      error.code = `XERO_MIRROR_RETRY_${String(classification.issue || 'INELIGIBLE').toUpperCase()}`;
      throw error;
    }
    const retained = retainedXeroMirrorPreview(transaction);
    if (retained) return { connection, transaction, preview: retained, classification };
    const postingContext = await resolvePostingContextWithClient({ client, firmId, clientId, businessDate: transaction.date });
    const original = (await client.query(
      `select payload from ledger_journals where firm_id = $1 and client_id = $2
        and source_type = 'transaction' and source_id = $3 and status in ('posted', 'closed')
        order by created_at desc limit 1`, [firmId, clientId, transactionId]
    )).rows[0]?.payload?.posting_policy;
    const coding = codingInputFromTransaction(transaction);
    const explicitTaxCode = String(coding.xero_tax_type || coding.tax_type || '').trim();
    if (original) assertPostingContextReceipt(postingContext, original);
    else if (!explicitTaxCode) throw xeroMirrorReplayError('XERO_MIRROR_RETRY_LINEAGE_MISSING',
      'Restore the original Xero payload or posting policy receipt before retrying this historical transaction.');
    assertPostingSuggestionLineage(postingContext, transaction);
    const [xeroAccounts, xeroContacts] = await Promise.all([
      getXeroAccountsForClient({ client, firmId, clientId }),
      getXeroContactsForClient({ client, firmId, clientId })
    ]);
    const preview = buildXeroBankTransactionWriteback({ transaction, xeroAccounts, xeroContacts, jurisdiction: postingContext.policy.jurisdiction });
    if (!original && preview.coding.xero_tax_type !== explicitTaxCode) {
      throw xeroMirrorReplayError('XERO_MIRROR_RETRY_LINEAGE_MISSING',
        'Current translation would change the recorded connector tax code; restore the original accounting receipt.');
    }
    return { connection, transaction, preview, classification };
  });

  const idempotencyKey = [
    'donna',
    firmId,
    clientId,
    'xero-mirror-retry',
    shortHash(transactionId),
    shortHash(JSON.stringify(prepared.preview.bank_transaction))
  ].join(':');
  const previewPayload = {
    source: 'xero_mirror_retry_preview',
    dry_run: true,
    client_id: clientId,
    transaction_id: transactionId,
    issue: prepared.classification.issue,
    connection_id: prepared.connection.id,
    tenant_id: prepared.connection.tenant_id,
    tenant_name: prepared.connection.tenant_name,
    idempotency_key: idempotencyKey,
    ...prepared.preview
  };
  if (dryRun) return { xero_mirror_retry: previewPayload };

  let xeroResponse;
  try {
    const existingByReference = prepared.preview.bank_transaction?.Reference
      ? await fetchXeroBankTransactionsByReference({
          accessToken: prepared.connection.access_token,
          tenantId: prepared.connection.tenant_id,
          reference: prepared.preview.bank_transaction.Reference
        })
      : null;
    let existingTransactions = matchingXeroBankTransactions({
      response: existingByReference,
      bankTransaction: prepared.preview.bank_transaction
    });
    let matchStrategy = existingTransactions.length ? 'reference' : '';

    if (!existingTransactions.length) {
      const fingerprint = await fetchXeroBankTransactionsByFingerprint({
        accessToken: prepared.connection.access_token,
        tenantId: prepared.connection.tenant_id,
        bankTransaction: prepared.preview.bank_transaction
      });
      existingTransactions = matchingXeroBankTransactions({
        response: fingerprint,
        bankTransaction: prepared.preview.bank_transaction
      });
      matchStrategy = existingTransactions.length ? 'fingerprint' : '';
    }

    if (existingTransactions.length > 1) {
      const error = new Error('Multiple existing Xero bank transactions match this Donna transaction. Skipping mirror retry to avoid a duplicate.');
      error.statusCode = 409;
      error.code = 'XERO_MIRROR_RETRY_AMBIGUOUS_MATCH';
      error.details = {
        transaction_id: transactionId,
        xero_bank_transaction_ids: existingTransactions.map((transaction) => xeroBankTransactionIdFromResponse({ BankTransactions: [transaction] })).filter(Boolean)
      };
      throw error;
    }

    xeroResponse = existingTransactions.length
      ? {
          Id: existingByReference?.Id || null,
          Status: 'OK',
          BankTransactions: [existingTransactions[0]],
          ProviderName: existingByReference?.ProviderName || 'Xero',
          matched_existing: true,
          match_strategy: matchStrategy
        }
      : await createXeroBankTransaction({
          accessToken: prepared.connection.access_token,
          tenantId: prepared.connection.tenant_id,
          bankTransaction: prepared.preview.bank_transaction,
          idempotencyKey
        });
  } catch (error) {
    // D-bonus: only flip the connection to 'error' when the failure indicts the
    // link itself (auth/transport). A row-level validation reject leaves the
    // connection 'connected' — else a single bad row spuriously surfaces
    // "Connect Xero".
    if (isXeroConnectionLevelError(error)) {
      await queryFirmDb(
        `update xero_connections
         set status = 'error',
             last_error = $3,
             updated_at = now()
         where firm_id = $1 and id = $2`,
        [firmId, prepared.connection.id, error.message || 'Xero mirror retry failed.']
      ).catch(() => {});
    }
    await queryFirmDb(
      `update transactions
       set payload = payload || $4::jsonb,
           updated_at = now()
       where firm_id = $1 and client_id = $2 and id = $3`,
      [firmId, clientId, transactionId, JSON.stringify(xeroWritebackErrorPayload(error))]
    ).catch(() => {});
    // INT-4a: a failed mirror retry is a failed push — same case surface
    // (best-effort; never masks the original throw below).
    await withFirmDbClient((caseClient) => recordExternalSyncFailure({
      client: caseClient, firmId, clientId, accountingSystem: 'xero',
      transactionId,
      errorMessage: error.message || 'Xero mirror retry failed.',
      errorCode: error.code || null,
      source: 'xero_mirror_retry'
    })).catch(() => {});
    throw error;
  }

  const xeroBankTransactionId = xeroBankTransactionIdFromResponse(xeroResponse);
  const retriedAt = new Date().toISOString();
  const payloadPatch = {
    xero_sync_status: 'synced',
    xero_writeback_status: 'synced',
    xero_writeback_error: null,
    xero_writeback_error_at: null,
    xero_writeback_type: 'bank_transaction',
    xero_bank_transaction_id: xeroBankTransactionId || null,
    xero_bank_account: prepared.preview.bank_account,
    xero_synced_at: retriedAt,
    xero_mirror_retry_issue: prepared.classification.issue,
    xero_mirror_retried_at: retriedAt,
    xero_writeback_payload: prepared.preview.bank_transaction,
    xero_writeback_response: xeroResponse
  };

  await withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      await client.query(
        `update transactions
         set payload = payload || $4::jsonb,
             updated_at = now()
         where firm_id = $1 and client_id = $2 and id = $3`,
        [firmId, clientId, transactionId, JSON.stringify(payloadPatch)]
      );
      await client.query(
        `update ledger_journals
         set payload = payload || $4::jsonb,
             updated_at = now()
         where firm_id = $1
           and client_id = $2
           and source_type = 'transaction'
           and source_id = $3
           and status in ('posted', 'closed')`,
        [
          firmId,
          clientId,
          transactionId,
          JSON.stringify({
            xero_bank_transaction_id: xeroBankTransactionId || null,
            xero_match_strategy: xeroResponse?.match_strategy || null,
            xero_mirror_retried_at: retriedAt
          })
        ]
      );
      await client.query(
        `update xero_connections
         set status = 'connected',
             last_synced_at = now(),
             last_error = null,
             updated_at = now()
         where firm_id = $1 and id = $2`,
        [firmId, prepared.connection.id]
      );
      await client.query(
        `insert into xero_sync_runs (
           id, connection_id, firm_id, client_id, sync_type, status, finished_at, counts, payload
         )
         values ($1, $2, $3, $4, 'mirror_retry', 'completed', now(), $5::jsonb, $6::jsonb)`,
        [
          xeroRecordId('mirror-retry-run', prepared.connection.id, shortHash(transactionId), Date.now()),
          prepared.connection.id,
          firmId,
          clientId,
          JSON.stringify({ transactions: 1 }),
          JSON.stringify({
            transaction_id: transactionId,
            issue: prepared.classification.issue,
            xero_bank_transaction_id: xeroBankTransactionId || null,
            tenant_id: prepared.connection.tenant_id
          })
        ]
      );
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', $3, '${ACCOUNTING_AUDIT_ACTIONS.retryMirror}', 'transaction', $4, $5::jsonb)`,
        [
          firmId,
          clientId,
          actorId || 'system',
          transactionId,
          JSON.stringify({
            accounting_system: 'xero',
            issue: prepared.classification.issue,
            xero_bank_transaction_id: xeroBankTransactionId || null,
            matched_existing: Boolean(xeroResponse?.matched_existing)
          })
        ]
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });

  // INT-4: a successful retry resolves the sync case — both the failed-push and
  // the drift/missing blockers this retry exists to fix (best-effort).
  await withFirmDbClient((caseClient) => resolveExternalSyncCase({
    client: caseClient, firmId, clientId, transactionId,
    reason: 'Xero mirror retry succeeded.'
  })).catch(() => {});

  // G7: best-effort, post-commit — annotate the (re-)posted BankTransaction with
  // Donna's coding rationale + provenance, on a fresh create only.
  // D3: capture + record the append outcome (see writebackXeroTransactionInDb).
  let historyNote = null;
  if (xeroBankTransactionId && !xeroResponse?.matched_existing) {
    historyNote = summarizeHistoryNoteOutcome(
      await appendXeroHistoryNoteBestEffort({
        accessToken: prepared.connection.access_token,
        tenantId: prepared.connection.tenant_id,
        xeroBankTransactionId,
        transaction: prepared.transaction,
        coding: prepared.preview.coding
      }),
      retriedAt
    );
    await queryFirmDb(
      `update transactions
       set payload = payload || $4::jsonb,
           updated_at = now()
       where firm_id = $1 and client_id = $2 and id = $3`,
      [firmId, clientId, transactionId, JSON.stringify({ xero_history_note: historyNote })]
    ).catch(() => {});
  }

  return {
    xero_mirror_retry: {
      ...previewPayload,
      source: 'xero_mirror_retry',
      dry_run: false,
      xero_bank_transaction_id: xeroBankTransactionId || null,
      xero_response: xeroResponse,
      history_note: historyNote,
      retried_at: retriedAt
    }
  };
};

// Connector coding and native journal coding are separate representations of
// the same persisted verdict. Validate the native consequence before any HTTP;
// never substitute Donna's native codes into the provider's TaxType field.
const xeroConnectorTaxCoding = (bankTransaction = {}) => ({ provider: 'xero',
  lineAmountTypes: bankTransaction.LineAmountTypes,
  taxTypes: (bankTransaction.LineItems || []).map(line => line.TaxType || '') });
const xeroPostingCoding = ({ transaction, preview, postingContext }) => {
  const { policy, taxCodingEnabled } = postingContext;
  const input = { coding: preview.coding || codingInputFromTransaction(transaction),
    sourceCoding: authoritativeTaxCoding(transaction), transaction, taxCodingEnabled, profile: postingContext.profile };
  const coding = policy.capabilities.enrichCoding
    ? executePostingPolicyOperation(policy, 'enrichCoding', input) : input.coding;
  assertPostableTaxCoding(policy, { ...input, coding });
  for (const line of preview.bank_transaction?.LineItems || []) {
    const code = String(line.TaxType || '').trim().toUpperCase();
    if (code && policy.nativeTaxCodeOwnership.some(({ prefixes, codes }) =>
      prefixes.some(prefix => code.startsWith(prefix)) || codes.includes(code))) {
      throw new PostingPolicyError('posting_connector_tax_code_unmapped', {
        jurisdiction: policy.jurisdiction, details: { reason: 'native_code_is_not_provider_tax_type', code }
      });
    }
  }
  if (preview.bank_transaction) assertPostableTaxCoding(policy, { ...input, coding,
    connectorTaxCoding: xeroConnectorTaxCoding(preview.bank_transaction) });
  return coding;
};

export const writebackXeroTransactionInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  transactionId,
  connectionId,
  dryRun = true,
  force = false,
  actorId = null,
  // Batch callers pass true: the per-row full-firm snapshot is discarded by the
  // batch anyway, and 25+ of them per Export click is a serverless-timeout
  // mechanism (idempotency doc §8.3 live validation).
  skipSnapshot = false
} = {}) => {
  requireXeroConfigured();
  if (!clientId) {
    const error = new Error('Client id is required for Xero transaction writeback.');
    error.statusCode = 400;
    throw error;
  }
  if (!transactionId) {
    const error = new Error('Transaction id is required for Xero transaction writeback.');
    error.statusCode = 400;
    throw error;
  }

  const prepared = await withFirmDbClient(async (client) => {
    await requireClientInFirm({ client, firmId, clientId });
    const transactionResult = await client.query(
      'select * from transactions where firm_id = $1 and client_id = $2 and id = $3',
      [firmId, clientId, transactionId]
    );
    const transactionRow = transactionResult.rows[0];
    if (!transactionRow) {
      const error = new Error('Transaction not found for Xero writeback.');
      error.statusCode = 404;
      throw error;
    }
    const transaction = rowToTransactionPayload(transactionRow);
    const sourceReceipt = postingSourceReceipt(transaction);
    const persistedSuggestion = transaction.ai_suggestion;
    const acceptedPolicy = transaction.accepted_coding_policy;
    const reviewResult = await client.query(
      `select payload
       from transaction_review_queue
       where firm_id = $1
         and client_id = $2
         and (
           item_id = $3
           or payload->>'transaction_id' = $3
         )
       order by updated_at desc
       limit 1`,
      [firmId, clientId, transactionId]
    );
    transaction.reviewer_note ||= reviewResult.rows[0]?.payload?.reviewer_note || null;
    transaction.ai_suggestion = persistedSuggestion;
    transaction.accepted_coding_policy = acceptedPolicy;
    const postingContext = await resolvePostingContextWithClient({ client, firmId, clientId, businessDate: transaction.date });
    assertPostingSuggestionLineage(postingContext, transaction);
    if (!dryRun && !force && transaction.xero_bank_transaction_id) {
      const error = new Error('Transaction has already been written back to Xero.');
      error.statusCode = 409;
      error.code = 'XERO_WRITEBACK_ALREADY_SYNCED';
      throw error;
    }
    const [xeroAccounts, xeroContacts] = await Promise.all([
      getXeroAccountsForClient({ client, firmId, clientId }),
      getXeroContactsForClient({ client, firmId, clientId })
    ]);
    const preview = buildXeroBankTransactionWriteback({
      transaction,
      xeroAccounts,
      xeroContacts,
      // On the dry-run pre-flight, a coded account with no Xero match returns a
      // structured PROPOSE (the unmatched account + a provision plan) instead of
      // throwing. The live path keeps the throw (operator must provision first).
      jurisdiction: postingContext.policy.jurisdiction,
      proposeProvisionOnUnmatched: dryRun
    });
    const postingCoding = xeroPostingCoding({ transaction, preview, postingContext });
    const connection = await getFreshXeroConnectionForSync({ client, firmId, clientId, connectionId });
    requireXeroBankTransactionScope(connection);
    return { connection, transaction, preview, postingCoding, postingContext, sourceReceipt };
  }).catch(async error => {
    await withFirmDbClient(client => receiptPostingFailure({ client, firmId, clientId, transactionIds: [transactionId], error }));
    throw error;
  });

  // account_unmatched on the dry-run path is the most likely first-run dead-end.
  // Surface it as a PROPOSE — the unmatched account plus a chart-of-accounts
  // provision plan the operator can apply (POST /xero/provision-coa) — instead
  // of a bare throw. Applying it stays an operator decision (trust strategy);
  // the live path (dryRun:false) still refuses inside buildXeroBankTransactionWriteback.
  if (prepared.preview?.blocker === 'account_unmatched') {
    return {
      xero_writeback: {
        source: 'xero_writeback_preview',
        dry_run: true,
        ready: false,
        blocker: 'account_unmatched',
        connection_id: prepared.connection.id,
        tenant_id: prepared.connection.tenant_id,
        tenant_name: prepared.connection.tenant_name,
        unmatched: prepared.preview.unmatched,
        provision_plan: prepared.preview.provision_plan,
        bank_account: prepared.preview.bank_account
      }
    };
  }

  const idempotencyKey = [
    'donna',
    firmId,
    clientId,
    'bank-transaction',
    shortHash(transactionId),
    shortHash(JSON.stringify(prepared.preview.bank_transaction))
  ].join(':');
  const previewPayload = {
    source: 'xero_writeback_preview',
    dry_run: true,
    connection_id: prepared.connection.id,
    tenant_id: prepared.connection.tenant_id,
    tenant_name: prepared.connection.tenant_name,
    idempotency_key: idempotencyKey,
    ...prepared.preview
  };
  if (dryRun) return { xero_writeback: previewPayload };

  let xeroResponse;
  try {
    const existingByReference = prepared.preview.bank_transaction?.Reference
      ? await fetchXeroBankTransactionsByReference({
          accessToken: prepared.connection.access_token,
          tenantId: prepared.connection.tenant_id,
          reference: prepared.preview.bank_transaction.Reference
        })
      : null;
    let existingTransactions = matchingXeroBankTransactions({
      response: existingByReference,
      bankTransaction: prepared.preview.bank_transaction
    });
    let matchStrategy = existingTransactions.length ? 'reference' : '';

    if (!existingTransactions.length) {
      const fingerprint = await fetchXeroBankTransactionsByFingerprint({
        accessToken: prepared.connection.access_token,
        tenantId: prepared.connection.tenant_id,
        bankTransaction: prepared.preview.bank_transaction
      });
      existingTransactions = matchingXeroBankTransactions({
        response: fingerprint,
        bankTransaction: prepared.preview.bank_transaction
      });
      matchStrategy = existingTransactions.length ? 'fingerprint' : '';
    }

    if (existingTransactions.length > 1) {
      const error = new Error('Multiple existing Xero bank transactions match this Donna transaction. Skipping writeback to avoid a duplicate.');
      error.statusCode = 409;
      error.code = 'XERO_WRITEBACK_AMBIGUOUS_MATCH';
      error.details = {
        transaction_id: transactionId,
        xero_bank_transaction_ids: existingTransactions.map((transaction) => xeroBankTransactionIdFromResponse({ BankTransactions: [transaction] })).filter(Boolean)
      };
      throw error;
    }

    xeroResponse = await withFirmDbClient(async client => {
      await client.query('begin');
      try {
        const currentRow = (await client.query(
          'select * from transactions where firm_id = $1 and client_id = $2 and id = $3 for update',
          [firmId, clientId, transactionId])).rows[0];
        const transaction = rowToTransactionPayload(currentRow || {});
        assertPostingSourceReceipt(transaction, prepared.sourceReceipt);
        const postingContext = await resolvePostingContextWithClient({ client, firmId, clientId,
          businessDate: transaction.date, lockContext: true });
        assertPostingContextReceipt(postingContext, prepared.postingContext.receipt);
        assertPostingSuggestionLineage(postingContext, transaction);
        // Chart defaults are part of the provider request, so refresh and hold
        // their rows too. A changed provider request needs a fresh preparation.
        const xeroAccounts = (await client.query(
          'select * from xero_accounts where firm_id = $1 and client_id = $2 order by code nulls last, name for share',
          [firmId, clientId])).rows.map(rowToXeroAccountPayload);
        const xeroContacts = await getXeroContactsForClient({ client, firmId, clientId });
        const preview = buildXeroBankTransactionWriteback({ transaction, xeroAccounts, xeroContacts,
          jurisdiction: postingContext.policy.jurisdiction });
        xeroPostingCoding({ transaction, preview, postingContext });
        if (JSON.stringify(preview.bank_transaction) !== JSON.stringify(prepared.preview.bank_transaction)
          || JSON.stringify(preview.coding) !== JSON.stringify(prepared.preview.coding)) {
          throw new PostingPolicyError('posting_connector_context_changed', {
            jurisdiction: postingContext.policy.jurisdiction, details: { reason: 'connector_preview_changed' }
          });
        }
        if (existingTransactions.length) {
          assertPostableTaxCoding(postingContext.policy, { transaction, coding: prepared.postingCoding,
            taxCodingEnabled: postingContext.taxCodingEnabled, profile: postingContext.profile,
            connectorTaxCoding: xeroConnectorTaxCoding(existingTransactions[0]) });
          xeroResponse = {
            Id: existingByReference?.Id || null,
            Status: 'OK',
            BankTransactions: [existingTransactions[0]],
            ProviderName: existingByReference?.ProviderName || 'Xero',
            matched_existing: true,
            match_strategy: matchStrategy
          };
        } else {
          try {
            xeroResponse = await createXeroBankTransaction({
              accessToken: prepared.connection.access_token,
              tenantId: prepared.connection.tenant_id,
              bankTransaction: prepared.preview.bank_transaction,
              idempotencyKey
            });
          } catch (createError) {
            // Recording fix (idempotency doc §8.2): a burned idempotency key means
            // Xero already saw this exact post from a run whose success was never
            // recorded here. Re-check the org by the stable reference and adopt the
            // existing row; only if the org genuinely has no single match does the
            // original error stand.
            if (!isXeroIdempotencyCollision(createError)) throw createError;
            const recovered = prepared.preview.bank_transaction.Reference
              ? await fetchXeroBankTransactionsByReference({
                  accessToken: prepared.connection.access_token,
                  tenantId: prepared.connection.tenant_id,
                  reference: prepared.preview.bank_transaction.Reference
                })
              : null;
            const recoveredMatches = matchingXeroBankTransactions({
              response: recovered,
              bankTransaction: prepared.preview.bank_transaction
            });
            if (recoveredMatches.length !== 1) throw createError;
            assertPostableTaxCoding(postingContext.policy, { transaction, coding: prepared.postingCoding,
              taxCodingEnabled: postingContext.taxCodingEnabled, profile: postingContext.profile,
              connectorTaxCoding: xeroConnectorTaxCoding(recoveredMatches[0]) });
            xeroResponse = {
              Id: recovered?.Id || null,
              Status: 'OK',
              BankTransactions: [recoveredMatches[0]],
              ProviderName: recovered?.ProviderName || 'Xero',
              matched_existing: true,
              match_strategy: 'idempotency_recovery'
            };
          }
        }
        await client.query('commit');
        return xeroResponse;
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    });
  } catch (error) {
    await withFirmDbClient(client => receiptPostingFailure({ client, firmId, clientId, transactionIds: [transactionId], error }));
    // D-bonus: only flip the connection to 'error' when the failure indicts the
    // link itself (auth/transport). A row-level validation reject leaves the
    // connection 'connected' — else a single bad row spuriously surfaces
    // "Connect Xero" (live receipt: a pilot client's export with 2 row-level errors flipped
    // the whole connection, 2026-07-07).
    if (isXeroConnectionLevelError(error)) {
      await queryFirmDb(
        `update xero_connections
         set status = 'error',
             last_error = $3,
             updated_at = now()
         where firm_id = $1 and id = $2`,
        [firmId, prepared.connection.id, error.message || 'Xero writeback failed.']
      ).catch(() => {});
    }
    await queryFirmDb(
      `update transactions
       set payload = payload || $4::jsonb,
           updated_at = now()
       where firm_id = $1 and client_id = $2 and id = $3`,
      [firmId, clientId, transactionId, JSON.stringify(xeroWritebackErrorPayload(error))]
    ).catch(() => {});
    await queryFirmDb(
      `insert into xero_sync_runs (
         id, connection_id, firm_id, client_id, sync_type, status, finished_at, counts, error, payload
       )
       values ($1, $2, $3, $4, 'transaction_writeback', 'failed', now(), $5::jsonb, $6, $7::jsonb)`,
      [
        xeroRecordId('writeback-run', prepared.connection.id, shortHash(transactionId), Date.now()),
        prepared.connection.id,
        firmId,
        clientId,
        JSON.stringify({ transactions: 0 }),
        error.message || 'Xero writeback failed.',
        JSON.stringify({ transaction_id: transactionId, tenant_id: prepared.connection.tenant_id })
      ]
    ).catch(() => {});
    // INT-4a: surface the failed push as a 'sync' case + external_sync_failed
    // blocker (best-effort; never masks the original throw below).
    await withFirmDbClient((caseClient) => recordExternalSyncFailure({
      client: caseClient, firmId, clientId, accountingSystem: 'xero',
      transactionId,
      errorMessage: error.message || 'Xero writeback failed.',
      errorCode: error.code || null,
      source: 'xero_writeback'
    })).catch(() => {});
    throw error;
  }

  const xeroBankTransactionId = xeroBankTransactionIdFromResponse(xeroResponse);
  const syncedAt = new Date().toISOString();
  const payloadPatch = {
    ...prepared.preview.coding,
    tax_treatment: authoritativeTaxCoding(prepared.transaction).tax_treatment || '',
    tax_type: prepared.postingCoding.tax_type || prepared.postingCoding.xero_tax_type || '',
    review_status: 'resolved',
    xero_sync_status: 'synced',
    xero_writeback_status: 'synced',
    xero_writeback_error: null,
    xero_writeback_error_at: null,
    xero_writeback_type: 'bank_transaction',
    xero_bank_transaction_id: xeroBankTransactionId || null,
    xero_bank_account: prepared.preview.bank_account,
    xero_synced_at: syncedAt,
    synced_at: syncedAt,
    xero_writeback_payload: prepared.preview.bank_transaction,
    xero_writeback_response: xeroResponse
  };

  // Recording fix (idempotency doc §8.3): stamp the MINIMAL Xero receipt
  // durably BEFORE the composite recording transaction below.
  // postLedgerJournalForTransaction runs inside that transaction; if it throws,
  // the rollback must not erase the fact that Xero accepted the create — an
  // unrecorded success re-offers the row to the next batch, which then burns
  // its idempotency key at Xero (§8.2, live-org receipt). The composite commit
  // re-applies a superset of this patch; a later `force` re-run adopts the
  // existing row via the reference gate, so this pre-stamp can never cause a
  // duplicate post. Live validation: the pilot client's run posted 22 rows while only
  // 15 were recorded — this closes that gap at the writer.
  await queryFirmDb(
    `update transactions
     set payload = payload || $4::jsonb,
         updated_at = now()
     where firm_id = $1 and client_id = $2 and id = $3`,
    [
      firmId,
      clientId,
      transactionId,
      JSON.stringify(xeroSyncedReceiptPatch({
        xeroBankTransactionId,
        bankAccount: prepared.preview.bank_account,
        syncedAt
      }))
    ]
  );

  let ledgerPostResult = null;
  const snapshot = await withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      const ledgerPost = await postLedgerJournalForTransaction({
        client,
        firmId,
        clientId,
        transaction: prepared.transaction,
        coding: prepared.postingCoding,
        actorId: actorId || 'system',
        bankAccount: prepared.preview.bank_account,
        xeroBankTransactionId: xeroBankTransactionId || null,
        xeroMatchStrategy: xeroResponse?.match_strategy || null,
        postingPolicyReceipt: prepared.postingContext.receipt,
        sourceReceipt: prepared.sourceReceipt
      });
      ledgerPostResult = ledgerPost;
      const transactionPayloadPatch = {
        ...payloadPatch,
        ...ledgerPost
      };
      await client.query(
        `update transactions
         set status = 'synced',
             reconciliation_status = 'synced',
             account_code = coalesce($4, account_code),
             category = coalesce($5, category),
             payload = (payload - 'ledger_post_refusal') || $6::jsonb,
             updated_at = now()
         where firm_id = $1 and client_id = $2 and id = $3`,
        [
          firmId,
          clientId,
          transactionId,
          prepared.preview.coding.account_code || null,
          prepared.preview.coding.account_label || prepared.preview.coding.account_name || null,
          JSON.stringify(transactionPayloadPatch)
        ]
      );
      // RT-16: mirrored — a ledger fact.
      await applyCodingTransition(client, { firmId, clientId, transactionId, to: 'synced' });
      await client.query(
        `update transaction_review_queue
         set status = 'resolved',
             payload = payload || $4::jsonb,
             updated_at = now()
         where firm_id = $1
           and client_id = $2
           and (
             item_id = $3
             or payload->>'transaction_id' = $3
           )`,
        [
          firmId,
          clientId,
          transactionId,
          JSON.stringify({
            xero_sync_status: 'synced',
            xero_writeback_status: 'synced',
              xero_writeback_error: null,
              xero_writeback_error_at: null,
              xero_bank_transaction_id: xeroBankTransactionId || null,
              ledger_journal_id: ledgerPost.ledger_journal_id,
              ledger_status: ledgerPost.ledger_status,
              ledger_posted_at: ledgerPost.ledger_posted_at,
              synced_at: syncedAt
            })
        ]
      );
      await client.query(
        `update xero_connections
         set status = 'connected',
             last_synced_at = now(),
             last_error = null,
             updated_at = now()
         where firm_id = $1 and id = $2`,
        [firmId, prepared.connection.id]
      );
      await client.query(
        `insert into xero_sync_runs (
           id, connection_id, firm_id, client_id, sync_type, status, finished_at, counts, payload
         )
         values ($1, $2, $3, $4, 'transaction_writeback', 'completed', now(), $5::jsonb, $6::jsonb)`,
        [
          xeroRecordId('writeback-run', prepared.connection.id, shortHash(transactionId), Date.now()),
          prepared.connection.id,
          firmId,
          clientId,
          JSON.stringify({ transactions: 1 }),
          JSON.stringify({
            transaction_id: transactionId,
            xero_bank_transaction_id: xeroBankTransactionId || null,
            tenant_id: prepared.connection.tenant_id
          })
        ]
      );
      // INT-3 (receipts): actor_id = the authenticated operator who drove the
      // push (adjustment-audit idiom); coding_model = the persisted verdict's
      // model id (same source the Xero History note renders).
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', $3, '${ACCOUNTING_AUDIT_ACTIONS.writebackTransaction}', 'transaction', $4, $5::jsonb)`,
        [
          firmId,
          clientId,
          actorId || 'system',
          transactionId,
          JSON.stringify({
            accounting_system: 'xero',
            xero_bank_transaction_id: xeroBankTransactionId || null,
            ledger_journal_id: ledgerPost.ledger_journal_id,
            account_code: prepared.preview.coding.account_code || null,
            bank_account: prepared.preview.bank_account?.account_label || null,
            coding_model: codingModelForTransaction(prepared.transaction)
          })
        ]
      );
      await client.query('commit');
      // Batch callers skip the per-row snapshot: 25+ sequential full-firm
      // snapshots per Export click is what pushed the batch past the serverless
      // duration limit (the operator-visible hung "Mirroring…" spinner) — the
      // batch builds ONE snapshot at the end instead.
      return skipSnapshot ? null : getFirmSnapshotFromDb({ firmId });
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });

  // INT-4a: a successful push resolves any open sync case for this transaction
  // (best-effort, post-commit — the two-terminal close of the failure surface).
  await withFirmDbClient((caseClient) => resolveExternalSyncCase({
    client: caseClient, firmId, clientId, transactionId,
    reason: 'Xero writeback succeeded.'
  })).catch(() => {});

  // G7: best-effort, post-commit — annotate the freshly-posted BankTransaction
  // with Donna's coding rationale + provenance. A matched_existing row was already
  // annotated on its first post, so skip it to avoid duplicate notes.
  // D3: the append outcome was previously discarded — a built-but-failed note
  // left no trace. Capture it, record it durably on the transaction payload, and
  // surface it in the result so a silent failure is observable.
  let historyNote = null;
  if (xeroBankTransactionId && !xeroResponse?.matched_existing) {
    historyNote = summarizeHistoryNoteOutcome(
      await appendXeroHistoryNoteBestEffort({
        accessToken: prepared.connection.access_token,
        tenantId: prepared.connection.tenant_id,
        xeroBankTransactionId,
        transaction: prepared.transaction,
        coding: prepared.preview.coding
      }),
      syncedAt
    );
    await queryFirmDb(
      `update transactions
       set payload = payload || $4::jsonb,
           updated_at = now()
       where firm_id = $1 and client_id = $2 and id = $3`,
      [firmId, clientId, transactionId, JSON.stringify({ xero_history_note: historyNote })]
    ).catch(() => {});
  }

  return {
    snapshot,
    xero_writeback: {
      ...previewPayload,
      source: 'xero_writeback',
      dry_run: false,
      xero_bank_transaction_id: xeroBankTransactionId || null,
      ledger: ledgerPostResult,
      xero_response: xeroResponse,
      history_note: historyNote,
      synced_at: syncedAt
    }
  };
};

export const writebackXeroTransactionsBatchInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  transactionIds = [],
  connectionId,
  dryRun = true,
  force = false,
  limit = 25,
  includeAll = false,
  actorId = null
} = {}) => {
  requireXeroConfigured();
  if (!clientId) {
    const error = new Error('Client id is required for Xero transaction writeback.');
    error.statusCode = 400;
    throw error;
  }

  const cleanTransactionIds = Array.from(
    new Set((Array.isArray(transactionIds) ? transactionIds : []).map((id) => String(id || '').trim()).filter(Boolean))
  );
  // Batch-window fix (2026-07-07): with include_all and no explicit limit — the
  // operator "Export N" button (firmApi sends `{ include_all: true }`, no limit)
  // — default to the full cap, not 25. At 25 the batch fetched only the first 25
  // settled rows by date and Suspense-parked rows ate most of the window, so
  // "Export 42" drained ~8 real rows per click. An explicit limit still wins
  // (capped). include_all only ever WIDENS scope, never narrows it.
  const safeLimit = Math.min(Math.max(Number(limit) || (includeAll ? 250 : 25), 1), includeAll ? 250 : 100);

  const candidates = await withFirmDbClient(async (client) => {
    await requireClientInFirm({ client, firmId, clientId });
    const result = cleanTransactionIds.length
      ? await client.query(transactionWritebackCandidateQuery({ explicitIds: true }), [firmId, clientId, cleanTransactionIds])
      : await client.query(transactionWritebackCandidateQuery({ includeAll }), [firmId, clientId, safeLimit]);
    const byInputOrder = new Map(cleanTransactionIds.map((id, index) => [id, index]));
    return result.rows
      .map(rowToTransactionPayload)
      .filter((transaction) => force || !isTransactionSyncedToXero(transaction))
      .sort((left, right) => {
        if (!cleanTransactionIds.length) return 0;
        return (byInputOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (byInputOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER);
      });
  });

  const results = [];
  // Suspense-parked exclusion (idempotency doc §8.5 follow-up): a row whose
  // coding rests at Suspense/unknown is parked, not settled — it never reaches
  // the writer, and it is reported as a visible 'skipped' bucket instead of
  // silently dropping. The SQL settled filter can't see this: the settled
  // markers are status flags, and a parked row can carry them (live receipt:
  // three of the pilot client's rows previewed `850 · Suspense` with settled markers,
  // 2026-07-07).
  const exportable = [];
  for (const transaction of candidates) {
    if (isSuspenseParkedCoding(codingInputFromTransaction(transaction))) {
      results.push({
        transaction_id: transaction.id,
        status: 'skipped',
        reason: 'suspense_parked',
        dry_run: Boolean(dryRun)
      });
    } else {
      exportable.push(transaction);
    }
  }
  for (const transaction of exportable) {
    try {
      const result = await writebackXeroTransactionInDb({
        firmId,
        clientId,
        transactionId: transaction.id,
        connectionId,
        dryRun,
        force,
        actorId,
        skipSnapshot: true
      });
      results.push(compactWritebackResult({ transactionId: transaction.id, result, dryRun }));
    } catch (error) {
      results.push({
        transaction_id: transaction.id,
        status: 'error',
        dry_run: Boolean(dryRun),
        error: error.message || 'Xero writeback failed.',
        error_code: error.code || null
      });
    }
  }

  const counts = {
    requested: cleanTransactionIds.length || candidates.length,
    candidates: candidates.length,
    previewed: results.filter((item) => item.status === 'preview').length,
    synced: results.filter((item) => item.status === 'synced').length,
    errors: results.filter((item) => item.status === 'error').length,
    skipped_parked: results.filter((item) => item.status === 'skipped' && item.reason === 'suspense_parked').length
  };

  const payload = {
    source: dryRun ? 'xero_writeback_batch_preview' : 'xero_writeback_batch',
    dry_run: Boolean(dryRun),
    client_id: clientId,
    transaction_ids: cleanTransactionIds,
    include_all: Boolean(includeAll),
    limit: cleanTransactionIds.length ? cleanTransactionIds.length : safeLimit,
    counts,
    results
  };

  if (dryRun) return { xero_writeback_batch: payload };
  return {
    snapshot: await getFirmSnapshotFromDb({ firmId }),
    xero_writeback_batch: payload
  };
};

export const retryXeroMirrorInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  transactionIds = [],
  connectionId,
  periodStart,
  periodEnd,
  dryRun = true,
  force = false,
  limit = 100,
  actorId = null
} = {}) => {
  requireXeroConfigured();
  if (!clientId) {
    const error = new Error('Client id is required for Xero mirror retry.');
    error.statusCode = 400;
    throw error;
  }
  const period = normalizeLedgerPeriod({ periodStart, periodEnd });
  const cleanTransactionIds = Array.from(
    new Set((Array.isArray(transactionIds) ? transactionIds : []).map((id) => String(id || '').trim()).filter(Boolean))
  );
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 250);

  const transactions = await withFirmDbClient(async (client) => {
    await requireClientInFirm({ client, firmId, clientId });
    const params = [firmId, clientId, period.period_start, period.period_end];
    const explicitSql = cleanTransactionIds.length ? 'and id = any($5)' : '';
    if (cleanTransactionIds.length) params.push(cleanTransactionIds);
    else params.push(safeLimit);
    const result = await client.query(
      `select *
       from transactions
       where firm_id = $1
         and client_id = $2
         and transaction_date >= $3
         and transaction_date <= $4
         ${explicitSql}
       order by transaction_date, created_at
       ${cleanTransactionIds.length ? '' : 'limit $5'}`,
      params
    );
    const byInputOrder = new Map(cleanTransactionIds.map((id, index) => [id, index]));
    return result.rows
      .map(rowToTransactionPayload)
      .sort((left, right) => {
        if (!cleanTransactionIds.length) return 0;
        return (byInputOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (byInputOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER);
      });
  });

  const selected = cleanTransactionIds.length > 0;
  const foundIds = new Set(transactions.map((transaction) => transaction.id));
  const results = cleanTransactionIds
    .filter((id) => !foundIds.has(id))
    .map((id) => ({
      transaction_id: id,
      status: 'skipped',
      dry_run: Boolean(dryRun),
      issue: 'not_found',
      reason: 'Transaction was not found in the requested close period.'
    }));

  for (const transaction of transactions) {
    const classification = classifyXeroMirrorRetryTransaction({ transaction, selected, force });
    const base = {
      transaction_id: transaction.id,
      date: transaction.date,
      description: transaction.description,
      amount: Number(transaction.money_in || transaction.money_out || transaction.amount || 0),
      currency: transaction.account_currency || transaction.currency || null,
      issue: classification.issue
    };
    if (!classification.eligible) {
      results.push({
        ...base,
        status: 'skipped',
        dry_run: Boolean(dryRun),
        reason: classification.reason
      });
      continue;
    }
    try {
      const result = await exportXeroMirrorRetryTransactionInDb({
        firmId,
        clientId,
        transactionId: transaction.id,
        connectionId,
        dryRun,
        force,
        actorId
      });
      results.push({
        ...base,
        ...compactMirrorRetryResult({
          transactionId: transaction.id,
          result,
          dryRun,
          issue: classification.issue
        }),
        reason: classification.reason
      });
    } catch (error) {
      results.push({
        ...base,
        status: 'error',
        dry_run: Boolean(dryRun),
        reason: classification.reason,
        error: error.message || 'Xero mirror retry failed.',
        error_code: error.code || null
      });
    }
  }

  const counts = {
    requested: cleanTransactionIds.length || transactions.length,
    scanned: transactions.length,
    eligible: results.filter((item) => item.status === 'ready' || item.status === 'retried').length,
    ready: results.filter((item) => item.status === 'ready').length,
    retried: results.filter((item) => item.status === 'retried').length,
    skipped: results.filter((item) => item.status === 'skipped').length,
    errors: results.filter((item) => item.status === 'error').length
  };

  const payload = {
    source: dryRun ? 'xero_mirror_retry_preview' : 'xero_mirror_retry',
    dry_run: Boolean(dryRun),
    client_id: clientId,
    period_start: period.period_start,
    period_end: period.period_end,
    transaction_ids: cleanTransactionIds,
    force: Boolean(force),
    limit: cleanTransactionIds.length ? cleanTransactionIds.length : safeLimit,
    counts,
    results
  };

  if (dryRun) return { xero_mirror_retry: payload };
  return {
    snapshot: await getFirmSnapshotFromDb({ firmId }),
    xero_mirror_retry: payload
  };
};

export const verifyXeroMirrorInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  transactionIds = [],
  connectionId,
  periodStart,
  periodEnd,
  limit = 50
} = {}) => {
  requireXeroConfigured();
  if (!clientId) {
    const error = new Error('Client id is required for Xero mirror verification.');
    error.statusCode = 400;
    throw error;
  }
  const period = normalizeLedgerPeriod({ periodStart, periodEnd });
  const cleanTransactionIds = Array.from(
    new Set((Array.isArray(transactionIds) ? transactionIds : []).map((id) => String(id || '').trim()).filter(Boolean))
  );
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);

  const prepared = await withFirmDbClient(async (client) => {
    await requireClientInFirm({ client, firmId, clientId });
    const connection = await getFreshXeroConnectionForSync({ client, firmId, clientId, connectionId });
    requireXeroBankTransactionScope(connection);
    const params = [firmId, clientId, period.period_start, period.period_end];
    const explicitSql = cleanTransactionIds.length ? 'and id = any($5)' : '';
    if (cleanTransactionIds.length) params.push(cleanTransactionIds);
    else params.push(safeLimit);
    const transactionsResult = await client.query(
      `select *
       from transactions
       where firm_id = $1
         and client_id = $2
         and transaction_date >= $3
         and transaction_date <= $4
         ${explicitSql}
       order by transaction_date, created_at
       ${cleanTransactionIds.length ? '' : 'limit $5'}`,
      params
    );
    const xeroAccounts = await getXeroAccountsForClient({ client, firmId, clientId });
    const xeroContacts = await getXeroContactsForClient({ client, firmId, clientId });
    const jurisdiction = await getClientJurisdictionForEnrichment({ client, firmId, clientId });
    const byInputOrder = new Map(cleanTransactionIds.map((id, index) => [id, index]));
    return {
      connection,
      xeroAccounts,
      xeroContacts,
      jurisdiction,
      transactions: transactionsResult.rows
        .map(rowToTransactionPayload)
        .sort((left, right) => {
          if (!cleanTransactionIds.length) return 0;
          return (byInputOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (byInputOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER);
        })
    };
  });

  const foundIds = new Set(prepared.transactions.map((transaction) => transaction.id));
  const results = cleanTransactionIds
    .filter((id) => !foundIds.has(id))
    .map((id) => ({
      transaction_id: id,
      status: 'mirror_error',
      severity: 'warning',
      error: 'Transaction was not found in the requested close period.',
      checks: {}
    }));

  for (const transaction of prepared.transactions) {
    const xeroBankTransactionId =
      transaction.xero_bank_transaction_id ||
      transaction.xeroBankTransactionId ||
      transaction.xero_writeback_response?.xero_bank_transaction_id ||
      null;
    const expectedBankTransaction = transaction.xero_writeback_payload ||
      transaction.xero_mirror_retry_payload ||
      null;

    if (!isTransactionPostedToDonnaLedger(transaction)) {
      results.push({
        transaction_id: transaction.id,
        xero_bank_transaction_id: xeroBankTransactionId,
        status: 'mirror_error',
        severity: 'warning',
        error: 'Donna ledger row is not posted. Mirror verification only applies after Donna posting.',
        checks: {}
      });
      continue;
    }

    if (!xeroBankTransactionId) {
      results.push(buildXeroMirrorVerificationResult({
        transaction,
        expectedBankTransaction: expectedBankTransaction || {},
        xeroResponse: { BankTransactions: [] }
      }));
      continue;
    }

    let expected = expectedBankTransaction;
    try {
      if (!expected) {
        expected = buildXeroBankTransactionWriteback({
          transaction,
          jurisdiction: prepared.jurisdiction,
          xeroAccounts: prepared.xeroAccounts,
          xeroContacts: prepared.xeroContacts
        }).bank_transaction;
      }
      const xeroResponse = await fetchXeroBankTransactionById({
        accessToken: prepared.connection.access_token,
        tenantId: prepared.connection.tenant_id,
        bankTransactionId: xeroBankTransactionId
      });
      results.push(buildXeroMirrorVerificationResult({
        transaction,
        expectedBankTransaction: expected,
        xeroResponse
      }));
    } catch (error) {
      results.push(buildXeroMirrorVerificationResult({
        transaction: {
          ...transaction,
          xero_bank_transaction_id: xeroBankTransactionId
        },
        expectedBankTransaction: expected || {},
        error
      }));
    }
  }

  const counts = {
    requested: cleanTransactionIds.length || prepared.transactions.length,
    scanned: prepared.transactions.length,
    mirror_ok: results.filter((item) => item.status === 'mirror_ok').length,
    mirror_missing: results.filter((item) => item.status === 'mirror_missing').length,
    mirror_drift: results.filter((item) => item.status === 'mirror_drift').length,
    mirror_error: results.filter((item) => item.status === 'mirror_error').length
  };

  // INT-4b: drift/missing → external_sync_pending sync case; a clean verify
  // resolves any prior pending blocker. Best-effort — a case-spine hiccup never
  // breaks the verify result. Only rows that reached a real verdict feed the
  // spine (mirror_error is a fetch problem, owned by connection health), and a
  // mirror_missing row with NO xero_bank_transaction_id is a never-exported
  // entry — that is the posted-not-exported COUNT surface (INT-4d) and the
  // INT-6 auto-drain queue, not a drift case; minting one pending case per
  // unexported entry would drown the surface in noise.
  await withFirmDbClient((caseClient) => applyMirrorVerificationToSyncCases({
    client: caseClient, firmId, clientId, accountingSystem: 'xero',
    entries: results
      .filter((item) => item.transaction_id)
      .filter((item) => item.status !== 'mirror_missing' || item.xero_bank_transaction_id)
      .map((item) => ({
        transactionId: item.transaction_id,
        status: item.status,
        detail: item.status === 'mirror_drift' && item.checks
          ? `failed checks: ${Object.keys(item.checks).filter((k) => item.checks[k] === false).join(', ')}`
          : item.error || null
      }))
  })).catch(() => {});

  return {
    xero_mirror_verification: {
      source: 'xero_mirror_verification',
      client_id: clientId,
      period_start: period.period_start,
      period_end: period.period_end,
      connection_id: prepared.connection.id,
      tenant_id: prepared.connection.tenant_id,
      tenant_name: prepared.connection.tenant_name,
      transaction_ids: cleanTransactionIds,
      limit: cleanTransactionIds.length ? cleanTransactionIds.length : safeLimit,
      counts,
      results,
      source_of_truth: false,
      note: 'Live Xero verification is mirror maintenance only. Donna ledger remains the source of accounting truth.'
    }
  };
};

export const provisionXeroChartOfAccountsInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  connectionId,
  dryRun = true
} = {}) => {
  requireXeroConfigured();
  if (!clientId) {
    const error = new Error('Client id is required for Xero CoA provisioning.');
    error.statusCode = 400;
    throw error;
  }

  const prepared = await withFirmDbClient(async (client) => {
    await requireClientInFirm({ client, firmId, clientId });
    const connection = await getFreshXeroConnectionForSync({ client, firmId, clientId, connectionId });
    requireXeroSettingsScope(connection);
    const accountsPayload = await fetchXeroAccounts({ accessToken: connection.access_token, tenantId: connection.tenant_id });
    const xeroAccounts = (accountsPayload?.Accounts || [])
      .map(normalizeXeroAccount)
      .map((account) => ({
        xero_account_id: account.xeroAccountId,
        code: account.code,
        name: account.name,
        type: account.type,
        status: account.status,
        tax_type: account.taxType,
        payload: account.payload
      }));
    const plan = buildXeroCoaProvisionPlan({ xeroAccounts });
    return { connection, plan };
  });

  const previewPayload = {
    source: 'xero_coa_provision_preview',
    dry_run: true,
    connection_id: prepared.connection.id,
    tenant_id: prepared.connection.tenant_id,
    tenant_name: prepared.connection.tenant_name,
    ...prepared.plan
  };
  if (dryRun) return { xero_coa_provision: previewPayload };

  const blocked = prepared.plan.actions.filter((item) => item.action === 'blocked');
  if (blocked.length) {
    const error = new Error('Xero CoA provisioning is blocked by account code conflicts.');
    error.statusCode = 409;
    error.code = 'XERO_COA_CODE_CONFLICT';
    error.payload = { blocked };
    throw error;
  }

  const toCreate = prepared.plan.actions.filter((item) => item.action === 'create');
  const created = [];
  try {
    for (const action of toCreate) {
      const response = await createXeroAccount({
        accessToken: prepared.connection.access_token,
        tenantId: prepared.connection.tenant_id,
        account: action.payload,
        idempotencyKey: [
          'donna',
          firmId,
          clientId,
          'coa',
          action.desired.code,
          shortHash(JSON.stringify(action.payload))
        ].join(':')
      });
      created.push({ desired: action.desired, response });
    }
  } catch (error) {
    await queryFirmDb(
      `update xero_connections
       set status = 'error',
           last_error = $3,
           updated_at = now()
       where firm_id = $1 and id = $2`,
      [firmId, prepared.connection.id, error.message || 'Xero CoA provisioning failed.']
    ).catch(() => {});
    await queryFirmDb(
      `insert into xero_sync_runs (
         id, connection_id, firm_id, client_id, sync_type, status, finished_at, counts, error, payload
       )
       values ($1, $2, $3, $4, 'coa_provision', 'failed', now(), $5::jsonb, $6, $7::jsonb)`,
      [
        xeroRecordId('coa-provision-run', prepared.connection.id, Date.now()),
        prepared.connection.id,
        firmId,
        clientId,
        JSON.stringify({ accounts_created: created.length, accounts_requested: toCreate.length }),
        error.message || 'Xero CoA provisioning failed.',
        JSON.stringify({ tenant_id: prepared.connection.tenant_id, created })
      ]
    ).catch(() => {});
    throw error;
  }

  await queryFirmDb(
    `insert into xero_sync_runs (
       id, connection_id, firm_id, client_id, sync_type, status, finished_at, counts, payload
     )
     values ($1, $2, $3, $4, 'coa_provision', 'completed', now(), $5::jsonb, $6::jsonb)`,
    [
      xeroRecordId('coa-provision-run', prepared.connection.id, Date.now()),
      prepared.connection.id,
      firmId,
      clientId,
      JSON.stringify({ accounts_created: created.length, accounts_requested: toCreate.length }),
      JSON.stringify({
        tenant_id: prepared.connection.tenant_id,
        tenant_name: prepared.connection.tenant_name,
        created: created.map((item) => item.desired)
      })
    ]
  );
  await queryFirmDb(
    `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
     values ($1, $2, 'system', '${ACCOUNTING_AUDIT_ACTIONS.provisionChartOfAccounts}', 'accounting_system_connection', $3, $4::jsonb)`,
    [
      firmId,
      clientId,
      prepared.connection.id,
      JSON.stringify({ accounting_system: 'xero', accounts_created: created.length, accounts_requested: toCreate.length })
    ]
  );

  const snapshot = await syncXeroReferenceDataInDb({ firmId, clientId, connectionId: prepared.connection.id });
  return {
    snapshot,
    xero_coa_provision: {
      ...previewPayload,
      source: 'xero_coa_provision',
      dry_run: false,
      created: created.map((item) => item.desired),
      counts: {
        ...prepared.plan.counts,
        created: created.length
      }
    }
  };
};

export const syncXeroReferenceDataInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  connectionId
} = {}) => {
  requireXeroConfigured();
  if (!clientId) {
    const error = new Error('Client id is required to sync Xero.');
    error.statusCode = 400;
    throw error;
  }

  const connection = await withFirmDbClient(async (client) => {
    await requireClientInFirm({ client, firmId, clientId });
    return getFreshXeroConnectionForSync({ client, firmId, clientId, connectionId });
  });

  let accountsPayload;
  let contactsPayload;
  try {
    [accountsPayload, contactsPayload] = await Promise.all([
      fetchXeroAccounts({ accessToken: connection.access_token, tenantId: connection.tenant_id }),
      fetchXeroContacts({ accessToken: connection.access_token, tenantId: connection.tenant_id })
    ]);
  } catch (error) {
    // The persist catch below can't see fetch failures (the fetch phase runs
    // before the DB transaction opens) — flip the connection here too so an
    // API failure never leaves a stale 'connected'.
    await queryFirmDb(
      `update xero_connections
       set status = 'error', last_error = $3, updated_at = now()
       where firm_id = $1 and id = $2`,
      [firmId, connection.id, error.message || 'Xero sync failed.']
    ).catch(() => {});
    throw error;
  }
  const accounts = (accountsPayload?.Accounts || []).map(normalizeXeroAccount).filter((account) => account.xeroAccountId);
  const contacts = (contactsPayload?.Contacts || []).map(normalizeXeroContact).filter((contact) => contact.xeroContactId);
  const runId = xeroRecordId('sync-run', connection.id, Date.now());

  return withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      for (const account of accounts) {
        const accountId = xeroRecordId('account', connection.id, account.xeroAccountId);
        await client.query(
          `insert into xero_accounts (
             id, connection_id, firm_id, client_id, xero_account_id, code, name, type,
             status, tax_type, class, system_account, enable_payments_to_account, show_in_expense_claims, payload
           )
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)
           on conflict (connection_id, xero_account_id) do update set
             code = excluded.code,
             name = excluded.name,
             type = excluded.type,
             status = excluded.status,
             tax_type = excluded.tax_type,
             class = excluded.class,
             system_account = excluded.system_account,
             enable_payments_to_account = excluded.enable_payments_to_account,
             show_in_expense_claims = excluded.show_in_expense_claims,
             payload = excluded.payload,
             updated_at = now()`,
          [
            accountId,
            connection.id,
            firmId,
            clientId,
            account.xeroAccountId,
            account.code || null,
            account.name || null,
            account.type || null,
            account.status || null,
            account.taxType || null,
            account.class || null,
            account.systemAccount || null,
            account.enablePaymentsToAccount,
            account.showInExpenseClaims,
            JSON.stringify(account.payload)
          ]
        );
      }

      for (const contact of contacts) {
        const contactId = xeroRecordId('contact', connection.id, contact.xeroContactId);
        await client.query(
          `insert into xero_contacts (
             id, connection_id, firm_id, client_id, xero_contact_id, contact_number,
             name, email_address, is_customer, is_supplier, status, payload
           )
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
           on conflict (connection_id, xero_contact_id) do update set
             contact_number = excluded.contact_number,
             name = excluded.name,
             email_address = excluded.email_address,
             is_customer = excluded.is_customer,
             is_supplier = excluded.is_supplier,
             status = excluded.status,
             payload = excluded.payload,
             updated_at = now()`,
          [
            contactId,
            connection.id,
            firmId,
            clientId,
            contact.xeroContactId,
            contact.contactNumber || null,
            contact.name || null,
            contact.emailAddress || null,
            contact.isCustomer,
            contact.isSupplier,
            contact.status || null,
            JSON.stringify(contact.payload)
          ]
        );
      }

      await client.query(
        `update xero_connections
         set status = 'connected',
             last_synced_at = now(),
             last_error = null,
             updated_at = now()
         where firm_id = $1 and id = $2`,
        [firmId, connection.id]
      );
      await client.query(
        `insert into xero_sync_runs (
           id, connection_id, firm_id, client_id, sync_type, status, finished_at, counts, payload
         )
         values ($1, $2, $3, $4, 'reference_data', 'completed', now(), $5::jsonb, $6::jsonb)`,
        [
          runId,
          connection.id,
          firmId,
          clientId,
          JSON.stringify({ accounts: accounts.length, contacts: contacts.length }),
          JSON.stringify({ tenant_id: connection.tenant_id, tenant_name: connection.tenant_name })
        ]
      );
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', '${ACCOUNTING_AUDIT_ACTIONS.syncReferenceData}', 'accounting_system_connection', $3, $4::jsonb)`,
        [firmId, clientId, connection.id, JSON.stringify({ accounting_system: 'xero', accounts: accounts.length, contacts: contacts.length })]
      );
      await client.query('commit');
      return getFirmSnapshotFromDb({ firmId });
    } catch (error) {
      await client.query('rollback');
      await queryFirmDb(
        `update xero_connections
         set status = 'error', last_error = $3, updated_at = now()
         where firm_id = $1 and id = $2`,
        [firmId, connection.id, error.message || 'Xero sync failed.']
      );
      throw error;
    }
  });
};
