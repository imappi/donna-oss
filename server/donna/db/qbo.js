// server/donna/db/qbo.js — plane S mirror — the QuickBooks Online connection, reference sync and journal-entry writeback.
//
// RT-17 (2026-09-02): extracted from server/donna/firmDb.js as a pure move. Every public
// symbol keeps its old import path through firmDb.js, which re-exports it; helpers another
// plane needs are exported here and NOT re-exported by firmDb.js. Zero behaviour change.

// INT-4 — push failure + mirror drift onto the case spine (best-effort, no-throw
// by contract; gated on the LEDGER_SYNC_CASES config-plane flag inside the module).
import { applyMirrorVerificationToSyncCases, recordExternalSyncFailure, resolveExternalSyncCase } from '../ledgerSyncCases.js';
import { buildQboAuthorizeUrl, createQboState, exchangeQboCode, fetchQboAccounts, fetchQboClasses, fetchQboCustomers, fetchQboJournalEntry, fetchQboVendors, getQboConfig, isQboConfigured, normalizeQboAccount, normalizeQboClass, normalizeQboConnection, normalizeQboCustomer, normalizeQboJournalEntry, normalizeQboVendor, postQboJournalEntry, refreshQboToken, shouldRefreshQboToken, verifyQboState } from '../qboClient.js';
import { buildQboAccountResolver, buildQboJournalEntry, buildQboMirrorVerificationResult } from '../qboWriteback.js';
import { ACCOUNTING_AUDIT_ACTIONS } from '../accountingSystems/contract.js';

import { queryFirmDb, withFirmDbClient } from './pool.js';
import { shortHash, slugifyRulePart } from './shared.js';
import { DEFAULT_FIRM_ID, requireClientInFirm } from './clients.js';
import { loadLedgerJournalForMirror } from './ledger.js';
import { getFirmSnapshotFromDb } from './snapshot.js';

const qboConnectionIdForRealm = ({ clientId, realmId }) =>
  ['qbo-connection', slugifyRulePart(clientId), slugifyRulePart(realmId), shortHash(`${clientId}|${realmId}`)].join('-').slice(0, 140);

const qboRecordId = (...parts) => ['qbo', ...parts.map((part) => slugifyRulePart(String(part || 'unknown'))), shortHash(parts.join('|'))]
  .join('-')
  .slice(0, 140);

const requireQboConfigured = () => {
  if (!isQboConfigured()) {
    const error = new Error('QuickBooks Online OAuth is not configured. Set QBO_CLIENT_ID, QBO_CLIENT_SECRET, and QBO_REDIRECT_URI.');
    error.statusCode = 500;
    throw error;
  }
};

// ── QuickBooks Online connection lifecycle (Phase 2.1a) ────────────────────
// Mirrors the Xero start/complete/refresh writers above against the parallel
// qbo_connections table. The connect verb is dispatched through the
// accountingSystems qboAdapter; the callback (api.js /qbo/callback) calls
// completeQboConnectionInDb directly.

export const startQboConnectionInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  returnTo = '/firms?tab=accounting',
  redirectUri
} = {}) => {
  requireQboConfigured();
  if (!clientId) {
    const error = new Error('Client id is required to connect QuickBooks Online.');
    error.statusCode = 400;
    throw error;
  }

  await withFirmDbClient(async (client) => requireClientInFirm({ client, firmId, clientId }));
  // redirectUri is the host-derived callback URL the route resolved from the
  // serving request; embed it in the state and use it for the authorize URL so
  // the callback lands on this deployment (not a stale QBO_REDIRECT_URI).
  const state = createQboState({ firmId, clientId, returnTo, redirectUri });
  return {
    authorizeUrl: buildQboAuthorizeUrl({ state, redirectUri }),
    state,
    scopes: getQboConfig().scopes
  };
};

export const completeQboConnectionInDb = async ({ code, state, realmId } = {}) => {
  requireQboConfigured();
  const statePayload = verifyQboState(state);
  const firmId = statePayload.firm_id || DEFAULT_FIRM_ID;
  const clientId = statePayload.client_id;
  const connection = normalizeQboConnection({ realmId });
  // Reuse the exact redirect_uri the authorize step sent (carried in the
  // signed state); falls back to the env inside exchangeQboCode when absent.
  const callbackRedirectUri = statePayload.redirect_uri;

  // QBO returns the realm_id as a callback query param — it IS the connection.
  // No realm means the authorize round-trip is unusable.
  if (!connection.realmId) {
    const error = new Error('QuickBooks Online authorized successfully but returned no realm id.');
    error.statusCode = 502;
    throw error;
  }

  const token = await exchangeQboCode({ code, redirectUri: callbackRedirectUri });

  await withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      await requireClientInFirm({ client, firmId, clientId });
      const connectionId = qboConnectionIdForRealm({ clientId, realmId: connection.realmId });
      await client.query(
        `insert into qbo_connections (
           id, firm_id, client_id, realm_id, company_name,
           status, scopes, access_token, refresh_token, id_token, token_type,
           expires_at, refresh_token_expires_at, last_error, payload
         )
         values ($1, $2, $3, $4, $5, 'connected', $6::text[], $7, $8, $9, $10, $11::timestamptz, $12::timestamptz, null, $13::jsonb)
         on conflict (firm_id, client_id, realm_id) do update set
           company_name = excluded.company_name,
           status = 'connected',
           scopes = excluded.scopes,
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           id_token = excluded.id_token,
           token_type = excluded.token_type,
           expires_at = excluded.expires_at,
           refresh_token_expires_at = excluded.refresh_token_expires_at,
           last_error = null,
           payload = qbo_connections.payload || excluded.payload,
           updated_at = now()`,
        [
          connectionId,
          firmId,
          clientId,
          connection.realmId,
          connection.companyName || null,
          token.scopes,
          token.accessToken,
          token.refreshToken,
          token.idToken,
          token.tokenType,
          token.expiresAt,
          token.refreshTokenExpiresAt,
          JSON.stringify({
            connection: connection.payload,
            token: {
              scope: token.scopes,
              expires_at: token.expiresAt,
              refresh_token_expires_at: token.refreshTokenExpiresAt
            }
          })
        ]
      );
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', '${ACCOUNTING_AUDIT_ACTIONS.connect}', 'accounting_system_connection', $2, $3::jsonb)`,
        [firmId, clientId, JSON.stringify({ accounting_system: 'qbo', realm_id: connection.realmId })]
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });

  return {
    state: statePayload,
    connection
  };
};

// Token refresh for QBO connections, ready for the reference-sync PR (2.1b).
// Exported (unlike the Xero equivalent, which has internal callers already)
// because no route wires it yet. The rotation handling is the load-bearing
// difference from Xero: QBO issues a NEW refresh_token on every refresh and
// invalidates the prior one, so we persist `token.refreshToken` and never
// reuse the value we sent.
export const getFreshQboConnectionForSync = async ({ client, firmId, clientId, connectionId }) => {
  const params = [firmId, clientId];
  const result = await client.query(
    `select *
     from qbo_connections
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
    const error = new Error('QuickBooks Online connection not found.');
    error.statusCode = 404;
    throw error;
  }

  if (!shouldRefreshQboToken(connection.expires_at)) return connection;

  let token;
  try {
    token = await refreshQboToken({ refreshToken: connection.refresh_token });
  } catch (refreshError) {
    // Same honesty flip as the Xero helper above; doubly load-bearing here
    // because QBO refresh tokens rotate AND hard-expire (~100 days), so a dead
    // grant is a normal lifecycle event, not an anomaly.
    await queryFirmDb(
      `update qbo_connections
       set status = 'expired', last_error = $3, updated_at = now()
       where firm_id = $1 and id = $2`,
      [firmId, connection.id, refreshError.message || 'QuickBooks Online token refresh failed.']
    ).catch(() => {});
    const error = new Error('QuickBooks Online token refresh failed — reconnect QuickBooks to continue.');
    error.statusCode = 401;
    error.code = 'QBO_CONNECTION_EXPIRED';
    error.cause = refreshError;
    throw error;
  }
  const payloadPatch = {
    refreshed_at: new Date().toISOString(),
    token: {
      scope: token.scopes,
      expires_at: token.expiresAt,
      refresh_token_expires_at: token.refreshTokenExpiresAt
    }
  };
  const updateResult = await client.query(
    `update qbo_connections
     set status = 'connected',
         scopes = $3::text[],
         access_token = $4,
         refresh_token = $5,
         id_token = coalesce($6, id_token),
         token_type = $7,
         expires_at = $8::timestamptz,
         refresh_token_expires_at = coalesce($9::timestamptz, refresh_token_expires_at),
         last_error = null,
         payload = payload || $10::jsonb,
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
      token.refreshTokenExpiresAt,
      JSON.stringify(payloadPatch)
    ]
  );
  return updateResult.rows[0] || connection;
};

// Disconnect a client's QBO connection. Marks the qbo_connections row(s)
// 'disconnected' so the snapshot-derived status flips and the operator card
// shows Connect again; reconnecting re-runs OAuth and upserts the row back to
// 'connected'. DB-only — it does not revoke the token at Intuit (a later
// follow-up can call the QBO revoke endpoint); no QBO creds are required to
// disconnect.
export const disconnectQboConnectionInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  connectionId
} = {}) => {
  if (!clientId) {
    const error = new Error('Client id is required to disconnect QuickBooks Online.');
    error.statusCode = 400;
    throw error;
  }

  return withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      await requireClientInFirm({ client, firmId, clientId });
      const result = await client.query(
        `update qbo_connections
         set status = 'disconnected', updated_at = now()
         where firm_id = $1 and client_id = $2
           ${connectionId ? 'and id = $3' : ''}`,
        connectionId ? [firmId, clientId, connectionId] : [firmId, clientId]
      );
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', '${ACCOUNTING_AUDIT_ACTIONS.disconnect}', 'accounting_system_connection', $2, $3::jsonb)`,
        [firmId, clientId, JSON.stringify({ accounting_system: 'qbo', disconnected: result.rowCount })]
      );
      await client.query('commit');
      return { disconnected: result.rowCount };
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
};

// ── QuickBooks Online reference sync (Phase 2.1b) ──────────────────────────
// Mirrors syncXeroReferenceDataInDb against the parallel qbo_* tables. Pulls
// four entities (Accounts + Classes + Vendors + Customers) through the QBO
// query endpoint, upserts each per connection, stamps last_synced_at, writes a
// qbo_sync_runs row, and emits the neutral accounting_system.sync_reference_data
// audit action with accounting_system:'qbo'. Dispatched through the
// qboAdapter.syncReferenceData verb (same route as Xero: /xero/sync-reference-data
// resolves the adapter by the client's accounting_system). This is the first
// caller of getFreshQboConnectionForSync — token refresh + rotation handling
// (the QBO-specific part) lives there.
export const syncQboReferenceDataInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  connectionId
} = {}) => {
  requireQboConfigured();
  if (!clientId) {
    const error = new Error('Client id is required to sync QuickBooks Online.');
    error.statusCode = 400;
    throw error;
  }

  const connection = await withFirmDbClient(async (client) => {
    await requireClientInFirm({ client, firmId, clientId });
    return getFreshQboConnectionForSync({ client, firmId, clientId, connectionId });
  });

  const environment = getQboConfig().environment;
  const fetchArgs = { accessToken: connection.access_token, realmId: connection.realm_id, environment };
  let accountsRaw;
  let classesRaw;
  let vendorsRaw;
  let customersRaw;
  try {
    [accountsRaw, classesRaw, vendorsRaw, customersRaw] = await Promise.all([
      fetchQboAccounts(fetchArgs),
      fetchQboClasses(fetchArgs),
      fetchQboVendors(fetchArgs),
      fetchQboCustomers(fetchArgs)
    ]);
  } catch (error) {
    // Mirror of the Xero sync's fetch-phase flip: the persist catch below
    // only wraps the DB transaction, so an Intuit API failure here would
    // otherwise leave the connection resting at 'connected'.
    await queryFirmDb(
      `update qbo_connections
       set status = 'error', last_error = $3, updated_at = now()
       where firm_id = $1 and id = $2`,
      [firmId, connection.id, error.message || 'QuickBooks Online sync failed.']
    ).catch(() => {});
    throw error;
  }
  const accounts = accountsRaw.map(normalizeQboAccount).filter((account) => account.qboAccountId);
  const classes = classesRaw.map(normalizeQboClass).filter((klass) => klass.qboClassId);
  const vendors = vendorsRaw.map(normalizeQboVendor).filter((vendor) => vendor.qboVendorId);
  const customers = customersRaw.map(normalizeQboCustomer).filter((customer) => customer.qboCustomerId);
  const runId = qboRecordId('sync-run', connection.id, Date.now());

  return withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      for (const account of accounts) {
        const accountId = qboRecordId('account', connection.id, account.qboAccountId);
        await client.query(
          `insert into qbo_accounts (
             id, connection_id, firm_id, client_id, qbo_account_id, name, fully_qualified_name,
             account_number, account_type, account_sub_type, classification, currency, active,
             current_balance, description, payload
           )
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)
           on conflict (connection_id, qbo_account_id) do update set
             name = excluded.name,
             fully_qualified_name = excluded.fully_qualified_name,
             account_number = excluded.account_number,
             account_type = excluded.account_type,
             account_sub_type = excluded.account_sub_type,
             classification = excluded.classification,
             currency = excluded.currency,
             active = excluded.active,
             current_balance = excluded.current_balance,
             description = excluded.description,
             payload = excluded.payload,
             updated_at = now()`,
          [
            accountId,
            connection.id,
            firmId,
            clientId,
            account.qboAccountId,
            account.name || null,
            account.fullyQualifiedName || null,
            account.accountNumber || null,
            account.accountType || null,
            account.accountSubType || null,
            account.classification || null,
            account.currency || null,
            account.active,
            account.currentBalance,
            account.description || null,
            JSON.stringify(account.payload)
          ]
        );
      }

      for (const klass of classes) {
        const classRecordId = qboRecordId('class', connection.id, klass.qboClassId);
        await client.query(
          `insert into qbo_classes (
             id, connection_id, firm_id, client_id, qbo_class_id, name, fully_qualified_name,
             parent_id, sub_class, active, payload
           )
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
           on conflict (connection_id, qbo_class_id) do update set
             name = excluded.name,
             fully_qualified_name = excluded.fully_qualified_name,
             parent_id = excluded.parent_id,
             sub_class = excluded.sub_class,
             active = excluded.active,
             payload = excluded.payload,
             updated_at = now()`,
          [
            classRecordId,
            connection.id,
            firmId,
            clientId,
            klass.qboClassId,
            klass.name || null,
            klass.fullyQualifiedName || null,
            klass.parentId || null,
            klass.subClass,
            klass.active,
            JSON.stringify(klass.payload)
          ]
        );
      }

      for (const vendor of vendors) {
        const vendorRecordId = qboRecordId('vendor', connection.id, vendor.qboVendorId);
        await client.query(
          `insert into qbo_vendors (
             id, connection_id, firm_id, client_id, qbo_vendor_id, display_name, company_name,
             email, active, balance, vendor_1099, payload
           )
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
           on conflict (connection_id, qbo_vendor_id) do update set
             display_name = excluded.display_name,
             company_name = excluded.company_name,
             email = excluded.email,
             active = excluded.active,
             balance = excluded.balance,
             vendor_1099 = excluded.vendor_1099,
             payload = excluded.payload,
             updated_at = now()`,
          [
            vendorRecordId,
            connection.id,
            firmId,
            clientId,
            vendor.qboVendorId,
            vendor.displayName || null,
            vendor.companyName || null,
            vendor.email || null,
            vendor.active,
            vendor.balance,
            vendor.vendor1099,
            JSON.stringify(vendor.payload)
          ]
        );
      }

      for (const customer of customers) {
        const customerRecordId = qboRecordId('customer', connection.id, customer.qboCustomerId);
        await client.query(
          `insert into qbo_customers (
             id, connection_id, firm_id, client_id, qbo_customer_id, display_name, company_name,
             email, active, balance, taxable, payload
           )
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
           on conflict (connection_id, qbo_customer_id) do update set
             display_name = excluded.display_name,
             company_name = excluded.company_name,
             email = excluded.email,
             active = excluded.active,
             balance = excluded.balance,
             taxable = excluded.taxable,
             payload = excluded.payload,
             updated_at = now()`,
          [
            customerRecordId,
            connection.id,
            firmId,
            clientId,
            customer.qboCustomerId,
            customer.displayName || null,
            customer.companyName || null,
            customer.email || null,
            customer.active,
            customer.balance,
            customer.taxable,
            JSON.stringify(customer.payload)
          ]
        );
      }

      const counts = {
        accounts: accounts.length,
        classes: classes.length,
        vendors: vendors.length,
        customers: customers.length
      };
      await client.query(
        `update qbo_connections
         set status = 'connected',
             last_synced_at = now(),
             last_error = null,
             updated_at = now()
         where firm_id = $1 and id = $2`,
        [firmId, connection.id]
      );
      await client.query(
        `insert into qbo_sync_runs (
           id, connection_id, firm_id, client_id, sync_type, status, finished_at, counts, payload
         )
         values ($1, $2, $3, $4, 'reference_data', 'completed', now(), $5::jsonb, $6::jsonb)`,
        [
          runId,
          connection.id,
          firmId,
          clientId,
          JSON.stringify(counts),
          JSON.stringify({ realm_id: connection.realm_id, company_name: connection.company_name })
        ]
      );
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', '${ACCOUNTING_AUDIT_ACTIONS.syncReferenceData}', 'accounting_system_connection', $3, $4::jsonb)`,
        [firmId, clientId, connection.id, JSON.stringify({ accounting_system: 'qbo', ...counts })]
      );
      await client.query('commit');
      return getFirmSnapshotFromDb({ firmId });
    } catch (error) {
      await client.query('rollback');
      await queryFirmDb(
        `update qbo_connections
         set status = 'error', last_error = $3, updated_at = now()
         where firm_id = $1 and id = $2`,
        [firmId, connection.id, error.message || 'QuickBooks Online sync failed.']
      );
      throw error;
    }
  });
};

// ── QuickBooks Online writeback: ledger journals → JournalEntry (2.1c) ─────
// Mirrors a posted Donna ledger_journal (double-entry) to a QBO JournalEntry,
// line-for-line. Unlike the Xero path (which mirrors bank TRANSACTIONS to
// BankTransactions and dedups via reference/fingerprint), this mirrors the GL
// itself and dedups via the qbo_journal_mirrors table: the (connection_id,
// journal_id) row stores the QBO Id + SyncToken, so a re-sync is an UPDATE, not
// a duplicate. Account mapping is resolve-at-writeback (buildQboAccountResolver
// against synced qbo_accounts) — an unmapped line fails loudly.
//
// The single/batch/retry verbs return their result under the route's existing
// `xero_writeback*` / `xero_mirror_retry` envelope keys (the shared /xero/*
// action routes dispatch by accounting_system and spread those exact keys); the
// inner `source: 'qbo_*'` marks the connector. verifyMirror returns its own
// `qbo_mirror_verification` key (its route returns the result verbatim).

const getQboAccountsForClient = async ({ client, firmId, clientId }) => {
  const result = await client.query(
    'select * from qbo_accounts where firm_id = $1 and client_id = $2 order by account_number nulls last, name',
    [firmId, clientId]
  );
  return result.rows;
};

const loadQboJournalMirror = async ({ client, connectionId, journalId }) => {
  const result = await client.query(
    'select * from qbo_journal_mirrors where connection_id = $1 and journal_id = $2',
    [connectionId, journalId]
  );
  return result.rows[0] || null;
};

// Upsert the mirror row and (on a successful post) emit the neutral
// accounting_system.writeback_transaction audit. qbo_journal_entry_id / sync_token
// coalesce so an error persist doesn't wipe a prior successful id.
const persistQboMirror = async ({
  firmId,
  clientId,
  connection,
  journal,
  status,
  qboJournalEntryId = null,
  syncToken = null,
  docNumber = null,
  postedAt = null,
  lastError = null,
  request = {},
  response = {},
  audit = false,
  actorId = null
}) => {
  const mirrorId = qboRecordId('journal-mirror', connection.id, journal.id);
  await withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      await client.query(
        `insert into qbo_journal_mirrors (
           id, connection_id, firm_id, client_id, journal_id, qbo_journal_entry_id, sync_token,
           doc_number, status, source_type, source_id, posted_at, last_error, request_payload, response_payload
         )
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $13, $14::jsonb, $15::jsonb)
         on conflict (connection_id, journal_id) do update set
           qbo_journal_entry_id = coalesce(excluded.qbo_journal_entry_id, qbo_journal_mirrors.qbo_journal_entry_id),
           sync_token = coalesce(excluded.sync_token, qbo_journal_mirrors.sync_token),
           doc_number = excluded.doc_number,
           status = excluded.status,
           source_type = excluded.source_type,
           source_id = excluded.source_id,
           posted_at = coalesce(excluded.posted_at, qbo_journal_mirrors.posted_at),
           last_error = excluded.last_error,
           request_payload = excluded.request_payload,
           response_payload = excluded.response_payload,
           updated_at = now()`,
        [
          mirrorId,
          connection.id,
          firmId,
          clientId,
          journal.id,
          qboJournalEntryId,
          syncToken,
          docNumber,
          status,
          journal.source_type || null,
          journal.source_id || null,
          postedAt,
          lastError,
          JSON.stringify(request || {}),
          JSON.stringify(response || {})
        ]
      );
      if (audit) {
        // INT-3 (receipts): actor_id = the authenticated operator who drove
        // the push (adjustment-audit idiom). No coding_model here — the QBO
        // path mirrors a posted ledger JOURNAL; the coding model rides the
        // upstream ledger.post_transaction audit for its source transaction.
        await client.query(
          `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
           values ($1, $2, 'system', $3, '${ACCOUNTING_AUDIT_ACTIONS.writebackTransaction}', 'accounting_system_connection', $4, $5::jsonb)`,
          [
            firmId,
            clientId,
            actorId || 'system',
            connection.id,
            JSON.stringify({
              accounting_system: 'qbo',
              journal_id: journal.id,
              qbo_journal_entry_id: qboJournalEntryId,
              source_type: journal.source_type || null,
              source_id: journal.source_id || null
            })
          ]
        );
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
};

// Journal-level core shared by writeback/batch/retry. Loads the journal + lines
// + any existing mirror, builds the JournalEntry preview, and (unless dryRun)
// posts to QBO and persists. Network I/O sits OUTSIDE the DB transaction.
const writebackQboJournalCore = async ({
  firmId,
  clientId,
  connection,
  resolver,
  environment,
  journalId,
  transactionId,
  dryRun,
  force,
  actorId = null
}) => {
  const prepared = await withFirmDbClient(async (client) => {
    const { journal, lines } = await loadLedgerJournalForMirror({ client, firmId, clientId, journalId, transactionId });
    const existing = await loadQboJournalMirror({ client, connectionId: connection.id, journalId: journal.id });
    return { journal, lines, existing };
  });

  const docNumber = `W-${shortHash(prepared.journal.id)}`;
  const built = buildQboJournalEntry({
    journal: prepared.journal,
    lines: prepared.lines,
    resolver,
    docNumber,
    existing: prepared.existing?.qbo_journal_entry_id
      ? { qboJournalEntryId: prepared.existing.qbo_journal_entry_id, syncToken: prepared.existing.sync_token }
      : null
  });

  const transactionIdForJournal = prepared.journal.source_type === 'transaction' ? prepared.journal.source_id : null;
  const previewPayload = {
    source: 'qbo_writeback_preview',
    dry_run: true,
    connection_id: connection.id,
    realm_id: connection.realm_id,
    journal_id: prepared.journal.id,
    transaction_id: transactionIdForJournal,
    source_type: prepared.journal.source_type || null,
    source_id: prepared.journal.source_id || null,
    journal_entry: built.journal_entry,
    summary: built.summary,
    update: built.summary.update,
    already_synced: prepared.existing?.status === 'synced'
  };

  if (dryRun) {
    return { status: 'preview', journal: prepared.journal, transaction_id: transactionIdForJournal, preview: previewPayload };
  }

  // Idempotent: a synced mirror with a QBO id is left alone unless forced.
  if (prepared.existing?.status === 'synced' && prepared.existing.qbo_journal_entry_id && !force) {
    return {
      status: 'synced',
      skipped: true,
      journal: prepared.journal,
      transaction_id: transactionIdForJournal,
      qbo_journal_entry_id: prepared.existing.qbo_journal_entry_id,
      preview: { ...previewPayload, dry_run: false }
    };
  }

  let response;
  let normalized;
  try {
    response = await postQboJournalEntry({
      accessToken: connection.access_token,
      realmId: connection.realm_id,
      environment,
      journalEntry: built.journal_entry
    });
    normalized = normalizeQboJournalEntry(response);
  } catch (error) {
    await persistQboMirror({
      firmId,
      clientId,
      connection,
      journal: prepared.journal,
      status: 'error',
      docNumber: built.summary.doc_number,
      lastError: error.message || 'QuickBooks Online writeback failed.',
      request: built.journal_entry,
      response: error.payload || {}
    });
    // Parity with the Xero writeback catch: a failed live post also flips the
    // connection row, so the operator card surfaces the failure instead of a
    // stale 'connected'. Next successful sync/writeback writes it back.
    await queryFirmDb(
      `update qbo_connections
       set status = 'error', last_error = $3, updated_at = now()
       where firm_id = $1 and id = $2`,
      [firmId, connection.id, error.message || 'QuickBooks Online writeback failed.']
    ).catch(() => {});
    // INT-4a: surface the failed push as a 'sync' case + external_sync_failed
    // blocker (best-effort; never masks the original throw below). Anchored on
    // the source transaction when the journal is transaction-sourced, else the
    // journal itself (adjustments).
    await withFirmDbClient((caseClient) => recordExternalSyncFailure({
      client: caseClient, firmId, clientId, accountingSystem: 'qbo',
      transactionId: transactionIdForJournal,
      journalId: prepared.journal.id,
      errorMessage: error.message || 'QuickBooks Online writeback failed.',
      errorCode: error.code || null,
      source: 'qbo_writeback'
    })).catch(() => {});
    error.journalId = prepared.journal.id;
    throw error;
  }

  const syncedAt = new Date().toISOString();
  await persistQboMirror({
    firmId,
    clientId,
    connection,
    journal: prepared.journal,
    status: 'synced',
    qboJournalEntryId: normalized.id,
    syncToken: normalized.syncToken,
    docNumber: built.summary.doc_number,
    postedAt: syncedAt,
    lastError: null,
    request: built.journal_entry,
    response,
    audit: true,
    actorId
  });
  // Parity with the Xero writeback success path: a good live post clears any
  // prior 'error'/'expired' so the connection status can't stick stale.
  await queryFirmDb(
    `update qbo_connections
     set status = 'connected', last_synced_at = now(), last_error = null, updated_at = now()
     where firm_id = $1 and id = $2`,
    [firmId, connection.id]
  ).catch(() => {});

  // INT-4a: a successful push resolves any open sync case for this journal /
  // its source transaction (best-effort — the two-terminal close).
  await withFirmDbClient((caseClient) => resolveExternalSyncCase({
    client: caseClient, firmId, clientId,
    transactionId: transactionIdForJournal,
    journalId: prepared.journal.id,
    reason: 'QuickBooks writeback succeeded.'
  })).catch(() => {});

  return {
    status: 'synced',
    journal: prepared.journal,
    transaction_id: transactionIdForJournal,
    qbo_journal_entry_id: normalized.id,
    response,
    synced_at: syncedAt,
    preview: { ...previewPayload, dry_run: false }
  };
};

// Load the fresh connection + an account resolver in one client checkout.
const prepareQboWritebackContext = async ({ firmId, clientId, connectionId }) =>
  withFirmDbClient(async (client) => {
    await requireClientInFirm({ client, firmId, clientId });
    const connection = await getFreshQboConnectionForSync({ client, firmId, clientId, connectionId });
    const resolver = buildQboAccountResolver(await getQboAccountsForClient({ client, firmId, clientId }));
    return { connection, resolver };
  });

export const writebackQboTransactionInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  transactionId,
  connectionId,
  dryRun = true,
  force = false,
  actorId = null
} = {}) => {
  requireQboConfigured();
  if (!clientId) {
    const error = new Error('Client id is required for QuickBooks writeback.');
    error.statusCode = 400;
    throw error;
  }
  if (!transactionId) {
    const error = new Error('Transaction id is required for QuickBooks writeback.');
    error.statusCode = 400;
    throw error;
  }

  const environment = getQboConfig().environment;
  const { connection, resolver } = await prepareQboWritebackContext({ firmId, clientId, connectionId });
  const outcome = await writebackQboJournalCore({
    firmId,
    clientId,
    connection,
    resolver,
    environment,
    transactionId,
    dryRun,
    force,
    actorId
  });

  if (dryRun) return { xero_writeback: outcome.preview };
  return {
    snapshot: await getFirmSnapshotFromDb({ firmId }),
    xero_writeback: {
      ...outcome.preview,
      dry_run: false,
      status: outcome.status,
      skipped: Boolean(outcome.skipped),
      qbo_journal_entry_id: outcome.qbo_journal_entry_id || null,
      qbo_response: outcome.response || null,
      synced_at: outcome.synced_at || null
    }
  };
};

const compactQboMirrorResult = (journal, outcome, dryRun) => ({
  journal_id: journal.id,
  transaction_id: journal.source_type === 'transaction' ? journal.source_id : null,
  status: outcome.status,
  skipped: Boolean(outcome.skipped),
  qbo_journal_entry_id: outcome.qbo_journal_entry_id || null,
  dry_run: Boolean(dryRun)
});

export const writebackQboTransactionsBatchInDb = async ({
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
  requireQboConfigured();
  if (!clientId) {
    const error = new Error('Client id is required for QuickBooks writeback.');
    error.statusCode = 400;
    throw error;
  }

  const environment = getQboConfig().environment;
  const cleanTransactionIds = Array.from(
    new Set((Array.isArray(transactionIds) ? transactionIds : []).map((id) => String(id || '').trim()).filter(Boolean))
  );
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), includeAll ? 250 : 100);

  const { connection, resolver } = await prepareQboWritebackContext({ firmId, clientId, connectionId });
  const journals = await withFirmDbClient(async (client) => {
    if (cleanTransactionIds.length) {
      const result = await client.query(
        `select * from ledger_journals
         where firm_id = $1 and client_id = $2 and status = 'posted'
           and source_type = 'transaction' and source_id = any($3)`,
        [firmId, clientId, cleanTransactionIds]
      );
      return result.rows;
    }
    // include_all → every posted journal (transactions AND adjustments) not yet
    // synced for this connection; otherwise just transaction-sourced journals.
    const result = await client.query(
      `select j.* from ledger_journals j
       left join qbo_journal_mirrors m
         on m.connection_id = $3 and m.journal_id = j.id and m.status = 'synced'
       where j.firm_id = $1 and j.client_id = $2 and j.status = 'posted'
         ${includeAll ? '' : "and j.source_type = 'transaction'"}
         and m.id is null
       order by j.journal_date asc, j.created_at asc
       limit $4`,
      [firmId, clientId, connection.id, safeLimit]
    );
    return result.rows;
  });

  const results = [];
  for (const journal of journals) {
    try {
      const outcome = await writebackQboJournalCore({
        firmId,
        clientId,
        connection,
        resolver,
        environment,
        journalId: journal.id,
        dryRun,
        force,
        actorId
      });
      results.push(compactQboMirrorResult(journal, outcome, dryRun));
    } catch (error) {
      results.push({
        journal_id: journal.id,
        transaction_id: journal.source_type === 'transaction' ? journal.source_id : null,
        status: 'error',
        dry_run: Boolean(dryRun),
        error: error.message || 'QuickBooks writeback failed.',
        error_code: error.code || null
      });
    }
  }

  const counts = {
    candidates: journals.length,
    previewed: results.filter((item) => item.status === 'preview').length,
    synced: results.filter((item) => item.status === 'synced').length,
    errors: results.filter((item) => item.status === 'error').length
  };
  const payload = {
    source: dryRun ? 'qbo_writeback_batch_preview' : 'qbo_writeback_batch',
    dry_run: Boolean(dryRun),
    client_id: clientId,
    transaction_ids: cleanTransactionIds,
    include_all: Boolean(includeAll),
    limit: cleanTransactionIds.length ? cleanTransactionIds.length : safeLimit,
    counts,
    results
  };

  if (dryRun) return { xero_writeback_batch: payload };
  return { snapshot: await getFirmSnapshotFromDb({ firmId }), xero_writeback_batch: payload };
};

export const retryQboMirrorInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  transactionIds = [],
  connectionId,
  dryRun = true,
  limit = 25,
  actorId = null
} = {}) => {
  requireQboConfigured();
  if (!clientId) {
    const error = new Error('Client id is required for QuickBooks mirror retry.');
    error.statusCode = 400;
    throw error;
  }

  const environment = getQboConfig().environment;
  const cleanTransactionIds = Array.from(
    new Set((Array.isArray(transactionIds) ? transactionIds : []).map((id) => String(id || '').trim()).filter(Boolean))
  );
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);

  const { connection, resolver } = await prepareQboWritebackContext({ firmId, clientId, connectionId });
  const journals = await withFirmDbClient(async (client) => {
    const params = [firmId, clientId, connection.id];
    let query = `select j.* from qbo_journal_mirrors m
       join ledger_journals j on j.id = m.journal_id
       where m.firm_id = $1 and m.client_id = $2 and m.connection_id = $3 and m.status = 'error'`;
    if (cleanTransactionIds.length) {
      query += ` and m.source_type = 'transaction' and m.source_id = any($4)`;
      params.push(cleanTransactionIds);
    } else {
      query += ` order by m.updated_at asc limit $4`;
      params.push(safeLimit);
    }
    const result = await client.query(query, params);
    return result.rows;
  });

  const results = [];
  for (const journal of journals) {
    try {
      // force so a prior error row re-posts (create or update as appropriate).
      const outcome = await writebackQboJournalCore({
        firmId,
        clientId,
        connection,
        resolver,
        environment,
        journalId: journal.id,
        dryRun,
        force: true,
        actorId
      });
      results.push(compactQboMirrorResult(journal, outcome, dryRun));
    } catch (error) {
      results.push({
        journal_id: journal.id,
        transaction_id: journal.source_type === 'transaction' ? journal.source_id : null,
        status: 'error',
        dry_run: Boolean(dryRun),
        error: error.message || 'QuickBooks writeback failed.',
        error_code: error.code || null
      });
    }
  }

  const counts = {
    candidates: journals.length,
    previewed: results.filter((item) => item.status === 'preview').length,
    synced: results.filter((item) => item.status === 'synced').length,
    errors: results.filter((item) => item.status === 'error').length
  };
  const payload = {
    source: dryRun ? 'qbo_mirror_retry_preview' : 'qbo_mirror_retry',
    dry_run: Boolean(dryRun),
    client_id: clientId,
    transaction_ids: cleanTransactionIds,
    limit: safeLimit,
    counts,
    results
  };

  if (dryRun) return { xero_mirror_retry: payload };
  return { snapshot: await getFirmSnapshotFromDb({ firmId }), xero_mirror_retry: payload };
};

export const verifyQboMirrorInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  transactionIds = [],
  connectionId,
  limit = 25
} = {}) => {
  requireQboConfigured();
  if (!clientId) {
    const error = new Error('Client id is required for QuickBooks mirror verification.');
    error.statusCode = 400;
    throw error;
  }

  const environment = getQboConfig().environment;
  const cleanTransactionIds = Array.from(
    new Set((Array.isArray(transactionIds) ? transactionIds : []).map((id) => String(id || '').trim()).filter(Boolean))
  );
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);

  const { connection } = await prepareQboWritebackContext({ firmId, clientId, connectionId });
  const mirrors = await withFirmDbClient(async (client) => {
    const params = [firmId, clientId, connection.id];
    let query = `select * from qbo_journal_mirrors
       where firm_id = $1 and client_id = $2 and connection_id = $3
         and status in ('synced', 'stale') and qbo_journal_entry_id is not null`;
    if (cleanTransactionIds.length) {
      query += ` and source_type = 'transaction' and source_id = any($4)`;
      params.push(cleanTransactionIds);
    } else {
      query += ` order by updated_at desc limit $4`;
      params.push(safeLimit);
    }
    const result = await client.query(query, params);
    return result.rows;
  });

  const results = [];
  const syncCaseEntries = [];
  for (const mirror of mirrors) {
    let fetched = null;
    let fetchError = null;
    try {
      const response = await fetchQboJournalEntry({
        accessToken: connection.access_token,
        realmId: connection.realm_id,
        environment,
        journalEntryId: mirror.qbo_journal_entry_id
      });
      fetched = normalizeQboJournalEntry(response);
    } catch (error) {
      fetchError = error;
    }
    const expectedNorm = normalizeQboJournalEntry({ JournalEntry: mirror.request_payload || {} });
    const verification = buildQboMirrorVerificationResult({
      journalId: mirror.journal_id,
      expected: {
        qboJournalEntryId: mirror.qbo_journal_entry_id,
        lineCount: expectedNorm.lineCount,
        total: expectedNorm.total,
        txnDate: expectedNorm.txnDate
      },
      fetched,
      error: fetchError
    });
    results.push(verification);
    syncCaseEntries.push({
      transactionId: mirror.source_type === 'transaction' ? mirror.source_id : null,
      journalId: mirror.journal_id,
      status: verification.status,
      detail: verification.error || null
    });

    // Persist the verification outcome: ok stays synced, drift/missing → stale,
    // a fetch error leaves status but records last_error.
    const nextStatus = verification.status === 'mirror_ok' ? 'synced'
      : verification.status === 'mirror_error' ? mirror.status
      : 'stale';
    await queryFirmDb(
      `update qbo_journal_mirrors
       set status = $4, verified_at = now(),
           last_error = $5,
           updated_at = now()
       where connection_id = $1 and journal_id = $2 and firm_id = $3`,
      [
        connection.id,
        mirror.journal_id,
        firmId,
        nextStatus,
        verification.status === 'mirror_error' ? verification.error : null
      ]
    );
  }

  const counts = {
    checked: results.length,
    ok: results.filter((item) => item.status === 'mirror_ok').length,
    drift: results.filter((item) => item.status === 'mirror_drift').length,
    missing: results.filter((item) => item.status === 'mirror_missing').length,
    errors: results.filter((item) => item.status === 'mirror_error').length
  };
  await queryFirmDb(
    `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
     values ($1, $2, 'system', '${ACCOUNTING_AUDIT_ACTIONS.verifyMirror}', 'accounting_system_connection', $3, $4::jsonb)`,
    [firmId, clientId, connection.id, JSON.stringify({ accounting_system: 'qbo', ...counts })]
  );

  // INT-4b: drift/missing → external_sync_pending sync case; clean verify
  // resolves. Best-effort — never breaks the verify result (Xero parity).
  await withFirmDbClient((caseClient) => applyMirrorVerificationToSyncCases({
    client: caseClient, firmId, clientId, accountingSystem: 'qbo',
    entries: syncCaseEntries
  })).catch(() => {});

  return {
    qbo_mirror_verification: {
      source: 'qbo_mirror_verification',
      client_id: clientId,
      counts,
      results
    }
  };
};
