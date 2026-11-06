// server/donna/db/procountor.js — plane S mirror — the Procountor connection, reference sync and ledger-receipt writeback.
//
// RT-17 (2026-09-02): extracted from server/donna/firmDb.js as a pure move. Every public
// symbol keeps its old import path through firmDb.js, which re-exports it; helpers another
// plane needs are exported here and NOT re-exported by firmDb.js. Zero behaviour change.

// INT-4 — push failure + mirror drift onto the case spine (best-effort, no-throw
// by contract; gated on the LEDGER_SYNC_CASES config-plane flag inside the module).
import { applyMirrorVerificationToSyncCases, recordExternalSyncFailure, resolveExternalSyncCase } from '../ledgerSyncCases.js';
import { buildProcountorAuthorizeUrl, createProcountorState, exchangeProcountorApiKey, exchangeProcountorCode, fetchProcountorLedgerReceipt, fetchProcountorPagedResults, fetchProcountorResource, getProcountorConfig, isProcountorConfigured, normalizeProcountorBankAccount, normalizeProcountorBusinessPartner, normalizeProcountorConnection, normalizeProcountorDimension, normalizeProcountorLedgerAccount, normalizeProcountorLedgerReceipt, postProcountorLedgerReceipt, refreshProcountorToken, resolveProcountorCompanyId, resolveProcountorRedirectUri, shouldRefreshProcountorToken, updateProcountorLedgerReceipt, verifyProcountorState } from '../procountorClient.js';
import { buildProcountorLedgerAccountResolver, buildProcountorLedgerReceipt, buildProcountorMirrorVerificationResult } from '../procountorWriteback.js';
import { ACCOUNTING_AUDIT_ACTIONS } from '../accountingSystems/contract.js';

import { queryFirmDb, withFirmDbClient } from './pool.js';
import { shortHash, slugifyRulePart } from './shared.js';
import { DEFAULT_FIRM_ID, requireClientInFirm } from './clients.js';
import { loadLedgerJournalForMirror } from './ledger.js';
import { getFirmSnapshotFromDb } from './snapshot.js';

// ── Procountor connector (capability trial) ────────────────────────────────
// Born behind clientAxes.available=false. ONLY the connection lifecycle lives
// here (start/complete/refresh/disconnect — INT-1 honesty included); the push
// verbs are scaffolded in procountorAdapter.js until live API validation. When
// they land they follow the QBO convention: results ride the shared xero_*
// response envelopes with source:'procountor_*' marking the connector.
const requireProcountorConfigured = () => {
  if (!isProcountorConfigured()) {
    const error = new Error('Procountor OAuth is not configured. Set PROCOUNTOR_CLIENT_ID, PROCOUNTOR_CLIENT_SECRET, and PROCOUNTOR_REDIRECT_URI.');
    error.statusCode = 500;
    throw error;
  }
};

const procountorConnectionIdForCompany = ({ clientId, companyId }) =>
  ['procountor-connection', slugifyRulePart(clientId), slugifyRulePart(companyId), shortHash(`${clientId}|${companyId}`)].join('-').slice(0, 140);

// The id must stay unique per (parts) tuple even after length-capping. The old
// form appended shortHash then sliced the whole string to 140, which — for long
// inputs like a ~135-char ledger_journal id — chopped the hash (and the id's
// distinguishing suffix, since slugifyRulePart also caps each part at 64) right
// off the end, collapsing distinct journals to one id and colliding on
// procountor_journal_mirrors_pkey (23505). Pin the hash at the TAIL and truncate
// only the readable middle, so the disambiguator always survives. Byte-identical
// to the old output for short inputs (accounts/dimensions/…), which never reach
// the reserve length — so reference-sync ids and their upsert idempotency are
// unchanged.
export const procountorRecordId = (...parts) => {
  const hash = shortHash(parts.join('|'));
  const readable = ['procountor', ...parts.map((part) => slugifyRulePart(String(part || 'unknown')))].join('-');
  return `${readable.slice(0, 139 - hash.length)}-${hash}`;
};

export const startProcountorConnectionInDb = async ({ firmId = DEFAULT_FIRM_ID, clientId, returnTo = '/firms?tab=accounting', redirectUri } = {}) => {
  requireProcountorConfigured();
  if (!clientId) {
    const error = new Error('Client id is required to connect Procountor.');
    error.statusCode = 400;
    throw error;
  }
  await withFirmDbClient(async (client) => requireClientInFirm({ client, firmId, clientId }));
  // Procountor registers a SINGLE redirect URI per client, so ignore the host-
  // derived callback (right for Xero/QBO's multi-URI model, wrong here) and use
  // the one registered PROCOUNTOR_REDIRECT_URI — otherwise a connect started
  // from any other host (a Vercel preview) never gets redirected back after
  // login. The token exchange echoes the same URI (carried in the signed state),
  // so authorize + token stay consistent.
  const registeredRedirectUri = resolveProcountorRedirectUri(redirectUri);
  const state = createProcountorState({ firmId, clientId, returnTo, redirectUri: registeredRedirectUri });
  return { authorizeUrl: buildProcountorAuthorizeUrl({ state, redirectUri: registeredRedirectUri }), state, scopes: getProcountorConfig().scopes };
};

export const completeProcountorConnectionInDb = async ({ code, state, companyId } = {}) => {
  requireProcountorConfigured();
  const statePayload = verifyProcountorState(state);
  const firmId = statePayload.firm_id || DEFAULT_FIRM_ID;
  const clientId = statePayload.client_id;
  // The token exchange MUST come first: Procountor's auth-code callback carries
  // no company id (only code/state/expires_in) — the selected company lives in
  // the access token's `cid` claim, so we can't know it until the token is in
  // hand. resolveProcountorCompanyId prefers an explicit callback param (M2M /
  // future-proofing) and falls back to the token claim.
  const token = await exchangeProcountorCode({ code, redirectUri: statePayload.redirect_uri });
  const resolved = resolveProcountorCompanyId({ companyId, accessToken: token.accessToken });
  const connection = normalizeProcountorConnection({ companyId: resolved.companyId });
  if (!connection.companyId) {
    const error = new Error('Procountor authorized but no company id was found in the callback or the access token (cid claim).');
    error.statusCode = 502;
    throw error;
  }
  await withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      await requireClientInFirm({ client, firmId, clientId });
      const connectionId = procountorConnectionIdForCompany({ clientId, companyId: connection.companyId });
      await client.query(
        `insert into procountor_connections (
           id, firm_id, client_id, company_id, organization_name, status, scopes,
           access_token, refresh_token, id_token, token_type, expires_at, last_error, payload
         ) values ($1,$2,$3,$4,$5,'connected',$6::text[],$7,$8,$9,$10,$11::timestamptz,null,$12::jsonb)
         on conflict (firm_id, client_id, company_id) do update set
           organization_name = excluded.organization_name,
           status = 'connected', scopes = excluded.scopes, access_token = excluded.access_token,
           refresh_token = excluded.refresh_token, id_token = excluded.id_token, token_type = excluded.token_type,
           expires_at = excluded.expires_at, last_error = null,
           payload = procountor_connections.payload || excluded.payload, updated_at = now()`,
        [connectionId, firmId, clientId, connection.companyId, connection.organizationName || null, token.scopes,
          token.accessToken, token.refreshToken, token.idToken, token.tokenType, token.expiresAt,
          JSON.stringify({ connection: connection.payload, token: { scope: token.scopes, expires_at: token.expiresAt } })]
      );
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', '${ACCOUNTING_AUDIT_ACTIONS.connect}', 'accounting_system_connection', $2, $3::jsonb)`,
        [firmId, clientId, JSON.stringify({ accounting_system: 'procountor', company_id: connection.companyId })]
      );
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; }
  });
  return { state: statePayload, connection };
};

// M2M connect: the customer creates an API key in the Procountor UI (bound to
// their user+company+our client) and pastes it into Donna. We validate it by
// minting a client_credentials access token, read the company from the token's
// `cid`, and persist the API KEY as the durable credential (no refresh_token in
// M2M — getFreshProcountorConnectionForSync re-mints from it). No browser
// redirect, no signed state: the API key IS the authorization.
export const connectProcountorWithApiKeyInDb = async ({ firmId = DEFAULT_FIRM_ID, clientId, apiKey, actorId = null } = {}) => {
  requireProcountorConfigured();
  if (!clientId) {
    const error = new Error('Client id is required to connect Procountor.');
    error.statusCode = 400;
    throw error;
  }
  const cleanApiKey = String(apiKey || '').trim();
  if (!cleanApiKey) {
    const error = new Error('Procountor API key is required. Create one in Procountor (Basics → API client keys) and paste it here.');
    error.statusCode = 400;
    throw error;
  }
  // Minting the token both proves the key works and returns a company-scoped
  // access token. The company id is in the token's `cid`; the api_key JWT also
  // carries it, so fall back to the key if the token omits it.
  const token = await exchangeProcountorApiKey({ apiKey: cleanApiKey });
  const companyId =
    resolveProcountorCompanyId({ accessToken: token.accessToken }).companyId ||
    resolveProcountorCompanyId({ accessToken: cleanApiKey }).companyId;
  if (!companyId) {
    const error = new Error('Procountor API key was accepted but no company id (cid) was found in the access token.');
    error.statusCode = 502;
    throw error;
  }
  const connection = normalizeProcountorConnection({ companyId });
  await withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      await requireClientInFirm({ client, firmId, clientId });
      const connectionId = procountorConnectionIdForCompany({ clientId, companyId });
      await client.query(
        `insert into procountor_connections (
           id, firm_id, client_id, company_id, organization_name, status, scopes,
           access_token, refresh_token, api_key, id_token, token_type, expires_at, last_error, payload
         ) values ($1,$2,$3,$4,$5,'connected',$6::text[],$7,null,$8,null,$9,$10::timestamptz,null,$11::jsonb)
         on conflict (firm_id, client_id, company_id) do update set
           status = 'connected', scopes = excluded.scopes, access_token = excluded.access_token,
           refresh_token = null, api_key = excluded.api_key, token_type = excluded.token_type,
           expires_at = excluded.expires_at, last_error = null,
           payload = procountor_connections.payload || excluded.payload, updated_at = now()`,
        [connectionId, firmId, clientId, companyId, connection.organizationName || null, token.scopes,
          token.accessToken, cleanApiKey, token.tokenType, token.expiresAt,
          JSON.stringify({ auth: 'm2m', token: { scope: token.scopes, expires_at: token.expiresAt } })]
      );
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', $3, '${ACCOUNTING_AUDIT_ACTIONS.connect}', 'accounting_system_connection', $2, $4::jsonb)`,
        [firmId, clientId, actorId || 'system', JSON.stringify({ accounting_system: 'procountor', auth: 'm2m', company_id: companyId })]
      );
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; }
  });
  return { connection: { companyId, organizationName: connection.organizationName || null } };
};

export const getFreshProcountorConnectionForSync = async ({ client, firmId, clientId, connectionId }) => {
  const params = [firmId, clientId];
  const result = await client.query(
    `select * from procountor_connections where firm_id = $1 and client_id = $2 and status in ('connected','expired','error') ${connectionId ? 'and id = $3' : ''} order by connected_at desc limit 1`,
    connectionId ? [...params, connectionId] : params
  );
  const connection = result.rows[0];
  if (!connection) { const error = new Error('Procountor connection not found.'); error.statusCode = 404; throw error; }
  if (!shouldRefreshProcountorToken(connection.expires_at)) return connection;
  try {
    // M2M connections (api_key present) have no refresh_token — re-mint a fresh
    // access token from the stored API key via client_credentials. Legacy
    // auth-code rows fall back to the refresh_token grant.
    const token = connection.api_key
      ? await exchangeProcountorApiKey({ apiKey: connection.api_key })
      : await refreshProcountorToken({ refreshToken: connection.refresh_token });
    const updated = await client.query(
      `update procountor_connections set status='connected', scopes=$3::text[], access_token=$4, refresh_token=$5, id_token=coalesce($6,id_token), token_type=$7, expires_at=$8::timestamptz, last_error=null, payload=payload || $9::jsonb, updated_at=now() where firm_id=$1 and id=$2 returning *`,
      [firmId, connection.id, token.scopes, token.accessToken, token.refreshToken || connection.refresh_token, token.idToken || null, token.tokenType, token.expiresAt, JSON.stringify({ refreshed_at: new Date().toISOString() })]
    );
    return updated.rows[0] || connection;
  } catch (refreshError) {
    await queryFirmDb(`update procountor_connections set status='expired', last_error=$3, updated_at=now() where firm_id=$1 and id=$2`, [firmId, connection.id, refreshError.message || 'Procountor token refresh failed.']).catch(() => {});
    const error = new Error(connection.api_key
      ? 'Procountor API key rejected — the key may have been revoked. Reconnect with a new key.'
      : 'Procountor token refresh failed — reconnect Procountor to continue.');
    error.statusCode = 401; error.code = 'PROCOUNTOR_CONNECTION_EXPIRED'; error.cause = refreshError; throw error;
  }
};

export const disconnectProcountorConnectionInDb = async ({ firmId = DEFAULT_FIRM_ID, clientId, connectionId } = {}) => {
  requireProcountorConfigured();
  await queryFirmDb(`update procountor_connections set status='disconnected', updated_at=now() where firm_id=$1 and client_id=$2 ${connectionId ? 'and id=$3' : ''}`, connectionId ? [firmId, clientId, connectionId] : [firmId, clientId]);
  return { disconnected: true };
};

// Reference sync (verb 2.1b): pull Procountor's chart of accounts, dimensions,
// business partners, and bank accounts into the procountor_* reference tables so
// coding + writeback can resolve real accounts/partners. Mirrors
// syncXeroReferenceDataInDb / syncQboReferenceDataInDb: fetch phase first (flip
// the connection to 'error' on failure since the DB transaction isn't open yet),
// then a single transaction upserts each entity, stamps last_synced_at, writes a
// procountor_sync_runs row, and emits the neutral accounting_system.sync_reference_data
// audit action. Field shapes were validated against the live PTS API (see
// db/migrations/061). Dispatched through procountorAdapter.syncReferenceData.
export const syncProcountorReferenceDataInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  connectionId
} = {}) => {
  requireProcountorConfigured();
  if (!clientId) {
    const error = new Error('Client id is required to sync Procountor.');
    error.statusCode = 400;
    throw error;
  }

  const connection = await withFirmDbClient(async (client) => {
    await requireClientInFirm({ client, firmId, clientId });
    return getFreshProcountorConnectionForSync({ client, firmId, clientId, connectionId });
  });

  const environment = getProcountorConfig().environment;
  const accessToken = connection.access_token;

  let accounts;
  let dimensions;
  let businessPartners;
  let bankAccounts;
  try {
    const [coaPayload, dimensionsPayload, partnerRows, bankRows] = await Promise.all([
      fetchProcountorResource({ accessToken, environment, path: 'coa' }),
      fetchProcountorResource({ accessToken, environment, path: 'dimensions' }),
      fetchProcountorPagedResults({ accessToken, environment, path: 'businesspartners' }),
      fetchProcountorPagedResults({ accessToken, environment, path: 'bankaccounts' })
    ]);
    accounts = (coaPayload?.ledgerAccounts || [])
      .map(normalizeProcountorLedgerAccount)
      .filter((account) => account.ledgerAccountCode);
    // /api/dimensions returns a bare array (empty on a pilot client); tolerate a
    // {dimensions:[…]} envelope too so a future API shape doesn't silently drop rows.
    const dimensionItems = Array.isArray(dimensionsPayload)
      ? dimensionsPayload
      : dimensionsPayload?.dimensions || [];
    dimensions = dimensionItems
      .map(normalizeProcountorDimension)
      .filter((dimension) => dimension.dimensionId);
    businessPartners = partnerRows
      .map(normalizeProcountorBusinessPartner)
      .filter((partner) => partner.partnerId);
    bankAccounts = bankRows
      .map(normalizeProcountorBankAccount)
      .filter((bankAccount) => bankAccount.bankAccountId);
  } catch (error) {
    // The persist catch below can't see fetch failures (the fetch phase runs
    // before the DB transaction opens) — flip the connection here too so an API
    // failure never leaves a stale 'connected'.
    await queryFirmDb(
      `update procountor_connections set status = 'error', last_error = $3, updated_at = now() where firm_id = $1 and id = $2`,
      [firmId, connection.id, error.message || 'Procountor sync failed.']
    ).catch(() => {});
    throw error;
  }

  const runId = procountorRecordId('sync-run', connection.id, Date.now());

  return withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      for (const account of accounts) {
        await client.query(
          `insert into procountor_accounts (
             id, connection_id, firm_id, client_id, ledger_account_code, name, name_en, name_sv, active, payload
           )
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
           on conflict (connection_id, ledger_account_code) do update set
             name = excluded.name,
             name_en = excluded.name_en,
             name_sv = excluded.name_sv,
             active = excluded.active,
             payload = excluded.payload,
             updated_at = now()`,
          [
            procountorRecordId('account', connection.id, account.ledgerAccountCode),
            connection.id,
            firmId,
            clientId,
            account.ledgerAccountCode,
            account.name || null,
            account.nameEn || null,
            account.nameSv || null,
            account.active,
            JSON.stringify(account.payload)
          ]
        );
      }

      for (const dimension of dimensions) {
        await client.query(
          `insert into procountor_dimensions (
             id, connection_id, firm_id, client_id, procountor_dimension_id, name, active, payload
           )
           values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
           on conflict (connection_id, procountor_dimension_id) do update set
             name = excluded.name,
             active = excluded.active,
             payload = excluded.payload,
             updated_at = now()`,
          [
            procountorRecordId('dimension', connection.id, dimension.dimensionId),
            connection.id,
            firmId,
            clientId,
            dimension.dimensionId,
            dimension.name || null,
            dimension.active,
            JSON.stringify(dimension.payload)
          ]
        );
      }

      for (const partner of businessPartners) {
        await client.query(
          `insert into procountor_business_partners (
             id, connection_id, firm_id, client_id, procountor_partner_id, name, partner_type, email, active, version, payload
           )
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
           on conflict (connection_id, procountor_partner_id) do update set
             name = excluded.name,
             partner_type = excluded.partner_type,
             email = excluded.email,
             active = excluded.active,
             version = excluded.version,
             payload = excluded.payload,
             updated_at = now()`,
          [
            procountorRecordId('partner', connection.id, partner.partnerId),
            connection.id,
            firmId,
            clientId,
            partner.partnerId,
            partner.name || null,
            partner.partnerType || null,
            partner.email || null,
            partner.active,
            partner.version || null,
            JSON.stringify(partner.payload)
          ]
        );
      }

      for (const bankAccount of bankAccounts) {
        await client.query(
          `insert into procountor_bank_accounts (
             id, connection_id, firm_id, client_id, procountor_bank_account_id, account_number, iban, bic,
             bank_name, currency, default_for_invoice, default_for_payment, status, order_no, version, payload
           )
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)
           on conflict (connection_id, procountor_bank_account_id) do update set
             account_number = excluded.account_number,
             iban = excluded.iban,
             bic = excluded.bic,
             bank_name = excluded.bank_name,
             currency = excluded.currency,
             default_for_invoice = excluded.default_for_invoice,
             default_for_payment = excluded.default_for_payment,
             status = excluded.status,
             order_no = excluded.order_no,
             version = excluded.version,
             payload = excluded.payload,
             updated_at = now()`,
          [
            procountorRecordId('bankaccount', connection.id, bankAccount.bankAccountId),
            connection.id,
            firmId,
            clientId,
            bankAccount.bankAccountId,
            bankAccount.accountNumber || null,
            bankAccount.iban || null,
            bankAccount.bic || null,
            bankAccount.bankName || null,
            bankAccount.currency || null,
            bankAccount.defaultForInvoice,
            bankAccount.defaultForPayment,
            bankAccount.status || null,
            bankAccount.orderNo,
            bankAccount.version || null,
            JSON.stringify(bankAccount.payload)
          ]
        );
      }

      await client.query(
        `update procountor_connections
         set status = 'connected', last_synced_at = now(), last_error = null, updated_at = now()
         where firm_id = $1 and id = $2`,
        [firmId, connection.id]
      );

      const counts = {
        accounts: accounts.length,
        dimensions: dimensions.length,
        business_partners: businessPartners.length,
        bank_accounts: bankAccounts.length
      };
      await client.query(
        `insert into procountor_sync_runs (
           id, connection_id, firm_id, client_id, sync_type, status, finished_at, counts, payload
         )
         values ($1, $2, $3, $4, 'reference_data', 'completed', now(), $5::jsonb, $6::jsonb)`,
        [runId, connection.id, firmId, clientId, JSON.stringify(counts), JSON.stringify({ company_id: connection.company_id })]
      );
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', '${ACCOUNTING_AUDIT_ACTIONS.syncReferenceData}', 'accounting_system_connection', $3, $4::jsonb)`,
        [firmId, clientId, connection.id, JSON.stringify({ accounting_system: 'procountor', ...counts })]
      );
      await client.query('commit');
      return getFirmSnapshotFromDb({ firmId });
    } catch (error) {
      await client.query('rollback');
      await queryFirmDb(
        `update procountor_connections set status = 'error', last_error = $3, updated_at = now() where firm_id = $1 and id = $2`,
        [firmId, connection.id, error.message || 'Procountor sync failed.']
      );
      throw error;
    }
  });
};

// ── Procountor writeback (verb 2.1c) ───────────────────────────────────────
// Mirror a posted Donna ledger journal to a Procountor ledger receipt (type
// JOURNAL, POST /api/ledgerreceipts), line-for-line, dedup'd via the
// (connection_id, journal_id) row in procountor_journal_mirrors so a re-export
// is a PUT update (echoing `version`) rather than a duplicate create. Account
// mapping is resolve-at-writeback (buildProcountorLedgerAccountResolver over
// synced procountor_accounts by ledger_account_code) — an unmapped line fails
// loudly. Field shapes + the debit=+ / credit=− sign convention were validated
// against the live PTS API (see docs/procountor-live-writeback-runbook.md §0e).
//
// A created receipt lands status UNFINISHED (a draft the firm verifies in
// Procountor) — there is NO API endpoint to verify a journal, so writeback
// stops at the draft; that IS Donna's terminal state (mirror synced). The
// single/batch/retry verbs ride the shared xero_writeback* / xero_mirror_retry
// response envelopes with an inner source:'procountor_*' marking the connector
// (the QBO convention); verifyMirror returns its own procountor_mirror_verification
// key. Results dispatch through procountorAdapter's now-live writeback verbs.

const getProcountorAccountsForClient = async ({ client, firmId, clientId }) => {
  const result = await client.query(
    'select * from procountor_accounts where firm_id = $1 and client_id = $2 order by ledger_account_code',
    [firmId, clientId]
  );
  return result.rows;
};

const loadProcountorJournalMirror = async ({ client, connectionId, journalId }) => {
  const result = await client.query(
    'select * from procountor_journal_mirrors where connection_id = $1 and journal_id = $2',
    [connectionId, journalId]
  );
  return result.rows[0] || null;
};

// Upsert the mirror row and (on a successful post) emit the neutral
// accounting_system.writeback_transaction audit. procountor_journal_entry_id /
// sync_token coalesce so an error persist doesn't wipe a prior successful id.
const persistProcountorMirror = async ({
  firmId, clientId, connection, journal, status,
  procountorReceiptId = null, version = null, docNumber = null, postedAt = null,
  lastError = null, request = {}, response = {}, audit = false, actorId = null
}) => {
  const mirrorId = procountorRecordId('journal-mirror', connection.id, journal.id);
  await withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      await client.query(
        `insert into procountor_journal_mirrors (
           id, connection_id, firm_id, client_id, journal_id, procountor_journal_entry_id, sync_token,
           doc_number, status, source_type, source_id, posted_at, last_error, request_payload, response_payload
         )
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $13, $14::jsonb, $15::jsonb)
         on conflict (connection_id, journal_id) do update set
           procountor_journal_entry_id = coalesce(excluded.procountor_journal_entry_id, procountor_journal_mirrors.procountor_journal_entry_id),
           sync_token = coalesce(excluded.sync_token, procountor_journal_mirrors.sync_token),
           doc_number = excluded.doc_number,
           status = excluded.status,
           source_type = excluded.source_type,
           source_id = excluded.source_id,
           posted_at = coalesce(excluded.posted_at, procountor_journal_mirrors.posted_at),
           last_error = excluded.last_error,
           request_payload = excluded.request_payload,
           response_payload = excluded.response_payload,
           updated_at = now()`,
        [
          mirrorId, connection.id, firmId, clientId, journal.id, procountorReceiptId, version,
          docNumber, status, journal.source_type || null, journal.source_id || null, postedAt, lastError,
          JSON.stringify(request || {}), JSON.stringify(response || {})
        ]
      );
      if (audit) {
        // INT-3 (receipts): actor_id = the authenticated operator who drove the
        // push. No coding_model — the coding model rides the upstream
        // ledger.post_transaction audit for the source transaction.
        await client.query(
          `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
           values ($1, $2, 'system', $3, '${ACCOUNTING_AUDIT_ACTIONS.writebackTransaction}', 'accounting_system_connection', $4, $5::jsonb)`,
          [
            firmId, clientId, actorId || 'system', connection.id,
            JSON.stringify({
              accounting_system: 'procountor',
              journal_id: journal.id,
              procountor_journal_entry_id: procountorReceiptId,
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

// Pure: the annotated last_error for a two-layer persist failure — carries BOTH
// the original API error and WHY the full persist failed, capped so an oversized
// message can't be the reason the fallback row itself 400s. Exported for tests.
export const __procountorMirrorFailureAnnotation = (baseError, persistError) =>
  `${baseError || 'Procountor writeback failed.'} [mirror persist failed: ${(persistError && persistError.message) || persistError}]`.slice(0, 4000);

// §E-2 observability hardening. A writeback FAILURE must always leave a durable,
// queryable trace — otherwise a mirror-insert that itself throws swallows the
// real API error into the HTTP response and writes NOTHING (the "no DB trace"
// hunt that cost six probes on 2026-07-09; the #875 pkey collision was exactly
// such a throw). This wrapper NEVER throws — the caller re-throws the ORIGINAL
// API error, which must survive — and degrades in two steps:
//   1. the full error-status mirror upsert (keeps request/response payloads, the
//      richest signal for diagnosing the failure), and if THAT throws
//   2. a stripped minimal-row upsert (keys + status + last_error only, dropping
//      the JSON payloads + audit that are the likeliest failure surface),
//      annotated with WHY the full persist failed so the two-layer failure is
//      itself diagnosable rather than silent.
// `deps` is a test seam only (inject persist/query stubs); production always uses
// the real writers. Keeping it here — rather than a bare closure over module
// state — is what lets the never-throw + fall-back guarantee be unit-tested
// without a live DB, matching this file's pure-helper test convention.
const persistProcountorMirrorFailure = async ({
  firmId, clientId, connection, journal, docNumber = null, lastError = null, request = {}, response = {},
  deps = {}
}) => {
  const persist = deps.persist || persistProcountorMirror;
  const query = deps.query || queryFirmDb;
  const recordId = deps.recordId || procountorRecordId;
  const baseError = lastError || 'Procountor writeback failed.';
  try {
    await persist({
      firmId, clientId, connection, journal, status: 'error',
      docNumber, lastError: baseError, request, response
    });
    return;
  } catch (persistError) {
    // Full persist failed — fall through to the minimal row, recording why so
    // the two-layer failure is itself diagnosable rather than silent. Never
    // overwrites procountor_journal_entry_id / sync_token (untouched columns),
    // so a prior successful id survives an error re-persist.
    const annotated = __procountorMirrorFailureAnnotation(baseError, persistError);
    try {
      await query(
        `insert into procountor_journal_mirrors (
           id, connection_id, firm_id, client_id, journal_id, status, source_type, source_id, last_error
         )
         values ($1, $2, $3, $4, $5, 'error', $6, $7, $8)
         on conflict (connection_id, journal_id) do update set
           status = 'error', last_error = excluded.last_error, updated_at = now()`,
        [
          recordId('journal-mirror', connection.id, journal.id),
          connection.id, firmId, clientId, journal.id,
          journal.source_type || null, journal.source_id || null, annotated
        ]
      );
    } catch {
      // Nothing more we can safely do; the original API error still propagates.
    }
  }
};

export const __persistProcountorMirrorFailure = persistProcountorMirrorFailure;

// Journal-level core shared by writeback/batch/retry. Loads the journal + lines
// + any existing mirror, builds the ledger-receipt preview, and (unless dryRun)
// creates/updates the Procountor receipt and persists. Network I/O sits OUTSIDE
// the DB transaction.
const writebackProcountorJournalCore = async ({
  firmId, clientId, connection, resolver, environment, journalId, transactionId, dryRun, force, actorId = null
}) => {
  const prepared = await withFirmDbClient(async (client) => {
    const { journal, lines } = await loadLedgerJournalForMirror({ client, firmId, clientId, journalId, transactionId });
    const existing = await loadProcountorJournalMirror({ client, connectionId: connection.id, journalId: journal.id });
    return { journal, lines, existing };
  });

  const docNumber = `W-${shortHash(prepared.journal.id)}`;
  // Re-export as a PUT update only when a prior post left BOTH a receipt id and
  // its version (the concurrency token) — otherwise create.
  const existingRef = prepared.existing?.procountor_journal_entry_id && prepared.existing?.sync_token
    ? { procountorReceiptId: prepared.existing.procountor_journal_entry_id, version: prepared.existing.sync_token }
    : null;
  const built = buildProcountorLedgerReceipt({
    journal: prepared.journal, lines: prepared.lines, resolver, docNumber, existing: existingRef
  });

  const transactionIdForJournal = prepared.journal.source_type === 'transaction' ? prepared.journal.source_id : null;
  const previewPayload = {
    source: 'procountor_writeback_preview',
    dry_run: true,
    connection_id: connection.id,
    company_id: connection.company_id,
    journal_id: prepared.journal.id,
    transaction_id: transactionIdForJournal,
    source_type: prepared.journal.source_type || null,
    source_id: prepared.journal.source_id || null,
    ledger_receipt: built.ledger_receipt,
    summary: built.summary,
    update: built.summary.update,
    already_synced: prepared.existing?.status === 'synced'
  };

  if (dryRun) {
    return { status: 'preview', journal: prepared.journal, transaction_id: transactionIdForJournal, preview: previewPayload };
  }

  // Idempotent: a synced mirror with a receipt id is left alone unless forced.
  if (prepared.existing?.status === 'synced' && prepared.existing.procountor_journal_entry_id && !force) {
    return {
      status: 'synced',
      skipped: true,
      journal: prepared.journal,
      transaction_id: transactionIdForJournal,
      procountor_journal_entry_id: prepared.existing.procountor_journal_entry_id,
      preview: { ...previewPayload, dry_run: false }
    };
  }

  let response;
  let normalized;
  try {
    response = existingRef
      ? await updateProcountorLedgerReceipt({ accessToken: connection.access_token, environment, receiptId: existingRef.procountorReceiptId, ledgerReceipt: built.ledger_receipt })
      : await postProcountorLedgerReceipt({ accessToken: connection.access_token, environment, ledgerReceipt: built.ledger_receipt });
    normalized = normalizeProcountorLedgerReceipt(response);
  } catch (error) {
    // §E-2: resilient failure trace — this NEVER throws, so the original API
    // error below always propagates and a mirror-insert throw can no longer
    // swallow it (or leave no DB row behind).
    await persistProcountorMirrorFailure({
      firmId, clientId, connection, journal: prepared.journal,
      docNumber, lastError: error.message || 'Procountor writeback failed.',
      request: built.ledger_receipt, response: error.payload || {}
    });
    // Parity with the Xero/QBO writeback catch: a failed live post also flips
    // the connection row so the operator card surfaces the failure instead of a
    // stale 'connected'. Next successful sync/writeback writes it back.
    await queryFirmDb(
      `update procountor_connections set status = 'error', last_error = $3, updated_at = now() where firm_id = $1 and id = $2`,
      [firmId, connection.id, error.message || 'Procountor writeback failed.']
    ).catch(() => {});
    // INT-4a: surface the failed push as a 'sync' case + external_sync_failed
    // blocker (best-effort; never masks the original throw below).
    await withFirmDbClient((caseClient) => recordExternalSyncFailure({
      client: caseClient, firmId, clientId, accountingSystem: 'procountor',
      transactionId: transactionIdForJournal, journalId: prepared.journal.id,
      errorMessage: error.message || 'Procountor writeback failed.', errorCode: error.code || null,
      source: 'procountor_writeback'
    })).catch(() => {});
    error.journalId = prepared.journal.id;
    throw error;
  }

  const syncedAt = new Date().toISOString();
  await persistProcountorMirror({
    firmId, clientId, connection, journal: prepared.journal, status: 'synced',
    procountorReceiptId: normalized.id, version: normalized.version, docNumber,
    postedAt: syncedAt, lastError: null, request: built.ledger_receipt, response, audit: true, actorId
  });
  // Parity with the Xero/QBO success path: a good post clears any prior
  // 'error'/'expired' so the connection status can't stick stale.
  await queryFirmDb(
    `update procountor_connections set status = 'connected', last_synced_at = now(), last_error = null, updated_at = now() where firm_id = $1 and id = $2`,
    [firmId, connection.id]
  ).catch(() => {});
  // INT-4a: a successful push resolves any open sync case for this journal / its
  // source transaction (best-effort — the two-terminal close).
  await withFirmDbClient((caseClient) => resolveExternalSyncCase({
    client: caseClient, firmId, clientId, transactionId: transactionIdForJournal, journalId: prepared.journal.id,
    reason: 'Procountor writeback succeeded.'
  })).catch(() => {});

  return {
    status: 'synced',
    journal: prepared.journal,
    transaction_id: transactionIdForJournal,
    procountor_journal_entry_id: normalized.id,
    procountor_status: normalized.status,
    response,
    synced_at: syncedAt,
    preview: { ...previewPayload, dry_run: false }
  };
};

// Load the fresh connection + an account resolver in one client checkout.
const prepareProcountorWritebackContext = async ({ firmId, clientId, connectionId }) =>
  withFirmDbClient(async (client) => {
    await requireClientInFirm({ client, firmId, clientId });
    const connection = await getFreshProcountorConnectionForSync({ client, firmId, clientId, connectionId });
    const resolver = buildProcountorLedgerAccountResolver(await getProcountorAccountsForClient({ client, firmId, clientId }));
    return { connection, resolver };
  });

export const writebackProcountorTransactionInDb = async ({
  firmId = DEFAULT_FIRM_ID, clientId, transactionId, connectionId, dryRun = true, force = false, actorId = null
} = {}) => {
  requireProcountorConfigured();
  if (!clientId) {
    const error = new Error('Client id is required for Procountor writeback.');
    error.statusCode = 400;
    throw error;
  }
  if (!transactionId) {
    const error = new Error('Transaction id is required for Procountor writeback.');
    error.statusCode = 400;
    throw error;
  }

  const environment = getProcountorConfig().environment;
  const { connection, resolver } = await prepareProcountorWritebackContext({ firmId, clientId, connectionId });
  const outcome = await writebackProcountorJournalCore({
    firmId, clientId, connection, resolver, environment, transactionId, dryRun, force, actorId
  });

  if (dryRun) return { xero_writeback: outcome.preview };
  return {
    snapshot: await getFirmSnapshotFromDb({ firmId }),
    xero_writeback: {
      ...outcome.preview,
      dry_run: false,
      status: outcome.status,
      skipped: Boolean(outcome.skipped),
      procountor_journal_entry_id: outcome.procountor_journal_entry_id || null,
      procountor_status: outcome.procountor_status || null,
      procountor_response: outcome.response || null,
      synced_at: outcome.synced_at || null
    }
  };
};

const compactProcountorMirrorResult = (journal, outcome, dryRun) => ({
  journal_id: journal.id,
  transaction_id: journal.source_type === 'transaction' ? journal.source_id : null,
  status: outcome.status,
  skipped: Boolean(outcome.skipped),
  procountor_journal_entry_id: outcome.procountor_journal_entry_id || null,
  procountor_status: outcome.procountor_status || null,
  dry_run: Boolean(dryRun)
});

export const writebackProcountorTransactionsBatchInDb = async ({
  firmId = DEFAULT_FIRM_ID, clientId, transactionIds = [], connectionId,
  dryRun = true, force = false, limit = 25, includeAll = false, actorId = null
} = {}) => {
  requireProcountorConfigured();
  if (!clientId) {
    const error = new Error('Client id is required for Procountor writeback.');
    error.statusCode = 400;
    throw error;
  }

  const environment = getProcountorConfig().environment;
  const cleanTransactionIds = Array.from(
    new Set((Array.isArray(transactionIds) ? transactionIds : []).map((id) => String(id || '').trim()).filter(Boolean))
  );
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), includeAll ? 250 : 100);

  const { connection, resolver } = await prepareProcountorWritebackContext({ firmId, clientId, connectionId });
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
       left join procountor_journal_mirrors m
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
      const outcome = await writebackProcountorJournalCore({
        firmId, clientId, connection, resolver, environment, journalId: journal.id, dryRun, force, actorId
      });
      results.push(compactProcountorMirrorResult(journal, outcome, dryRun));
    } catch (error) {
      results.push({
        journal_id: journal.id,
        transaction_id: journal.source_type === 'transaction' ? journal.source_id : null,
        status: 'error',
        dry_run: Boolean(dryRun),
        error: error.message || 'Procountor writeback failed.',
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
    source: dryRun ? 'procountor_writeback_batch_preview' : 'procountor_writeback_batch',
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

export const retryProcountorMirrorInDb = async ({
  firmId = DEFAULT_FIRM_ID, clientId, transactionIds = [], connectionId, dryRun = true, limit = 25, actorId = null
} = {}) => {
  requireProcountorConfigured();
  if (!clientId) {
    const error = new Error('Client id is required for Procountor mirror retry.');
    error.statusCode = 400;
    throw error;
  }

  const environment = getProcountorConfig().environment;
  const cleanTransactionIds = Array.from(
    new Set((Array.isArray(transactionIds) ? transactionIds : []).map((id) => String(id || '').trim()).filter(Boolean))
  );
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);

  const { connection, resolver } = await prepareProcountorWritebackContext({ firmId, clientId, connectionId });
  const journals = await withFirmDbClient(async (client) => {
    const params = [firmId, clientId, connection.id];
    let query = `select j.* from procountor_journal_mirrors m
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
      const outcome = await writebackProcountorJournalCore({
        firmId, clientId, connection, resolver, environment, journalId: journal.id, dryRun, force: true, actorId
      });
      results.push(compactProcountorMirrorResult(journal, outcome, dryRun));
    } catch (error) {
      results.push({
        journal_id: journal.id,
        transaction_id: journal.source_type === 'transaction' ? journal.source_id : null,
        status: 'error',
        dry_run: Boolean(dryRun),
        error: error.message || 'Procountor writeback failed.',
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
    source: dryRun ? 'procountor_mirror_retry_preview' : 'procountor_mirror_retry',
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

export const verifyProcountorMirrorInDb = async ({
  firmId = DEFAULT_FIRM_ID, clientId, transactionIds = [], connectionId, limit = 25
} = {}) => {
  requireProcountorConfigured();
  if (!clientId) {
    const error = new Error('Client id is required for Procountor mirror verification.');
    error.statusCode = 400;
    throw error;
  }

  const environment = getProcountorConfig().environment;
  const cleanTransactionIds = Array.from(
    new Set((Array.isArray(transactionIds) ? transactionIds : []).map((id) => String(id || '').trim()).filter(Boolean))
  );
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);

  const { connection } = await prepareProcountorWritebackContext({ firmId, clientId, connectionId });
  const mirrors = await withFirmDbClient(async (client) => {
    const params = [firmId, clientId, connection.id];
    let query = `select * from procountor_journal_mirrors
       where firm_id = $1 and client_id = $2 and connection_id = $3
         and status in ('synced', 'stale') and procountor_journal_entry_id is not null`;
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
      const response = await fetchProcountorLedgerReceipt({
        accessToken: connection.access_token, environment, receiptId: mirror.procountor_journal_entry_id
      });
      fetched = normalizeProcountorLedgerReceipt(response);
    } catch (error) {
      fetchError = error;
    }
    const expectedNorm = normalizeProcountorLedgerReceipt(mirror.request_payload || {});
    const verification = buildProcountorMirrorVerificationResult({
      journalId: mirror.journal_id,
      expected: {
        procountorReceiptId: mirror.procountor_journal_entry_id,
        lineCount: expectedNorm.lineCount,
        total: expectedNorm.total,
        receiptDate: expectedNorm.receiptDate
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
      `update procountor_journal_mirrors
       set status = $4, verified_at = now(), last_error = $5, updated_at = now()
       where connection_id = $1 and journal_id = $2 and firm_id = $3`,
      [connection.id, mirror.journal_id, firmId, nextStatus, verification.status === 'mirror_error' ? verification.error : null]
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
    [firmId, clientId, connection.id, JSON.stringify({ accounting_system: 'procountor', ...counts })]
  );

  // INT-4b: drift/missing → external_sync_pending sync case; clean verify
  // resolves. Best-effort — never breaks the verify result (Xero/QBO parity).
  await withFirmDbClient((caseClient) => applyMirrorVerificationToSyncCases({
    client: caseClient, firmId, clientId, accountingSystem: 'procountor', entries: syncCaseEntries
  })).catch(() => {});

  return {
    procountor_mirror_verification: {
      source: 'procountor_mirror_verification',
      client_id: clientId,
      counts,
      results
    }
  };
};
