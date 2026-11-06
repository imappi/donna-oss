// server/donna/db/hmrc.js — plane S — the HMRC MTD VAT connection.
//
// RT-17 (2026-09-02): extracted from server/donna/firmDb.js as a pure move. Every public
// symbol keeps its old import path through firmDb.js, which re-exports it; helpers another
// plane needs are exported here and NOT re-exported by firmDb.js. Zero behaviour change.

import { clientFlagActs, readClientConfigSnapshot } from '../clientConfig.js';
import { buildHmrcAuthorizeUrl, createHmrcState, decryptHmrcToken, encryptHmrcToken, exchangeHmrcCode, getHmrcConfig, isHmrcInvalidGrantError, refreshHmrcToken, requireHmrcConfigured, shouldRefreshHmrcToken, verifyHmrcState } from '../taxAuthorities/hmrcClient.js';

import { queryFirmDb, withFirmDbClient } from './pool.js';
import { shortHash, slugifyRulePart } from './shared.js';
import { DEFAULT_FIRM_ID, requireClientInFirm } from './clients.js';

export const HMRC_MTD_VAT_FLAG_KEY = 'HMRC_MTD_VAT';

export const hmrcConnectionIdForClient = ({ clientId } = {}) =>
  `hmrc-${slugifyRulePart(clientId || 'client')}-${shortHash(String(clientId || ''))}`.slice(0, 140);

const rowToHmrcConnectionPayload = (row = {}) => ({
  id: row.id,
  firmId: row.firm_id,
  clientId: row.client_id,
  hmrcUserType: row.hmrc_user_type,
  vrn: row.vrn || null,
  status: row.status,
  scopes: row.scopes || [],
  tokenType: row.token_type || null,
  expiresAt: row.expires_at || null,
  grantCreatedAt: row.grant_created_at || null,
  lastSyncedAt: row.last_synced_at || null,
  lastError: row.last_error || null,
  payload: row.payload || {}
});

export const startHmrcConnectionInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  returnTo = '/client',
  redirectUri,
  hmrcUserType = 'organisation',
  principal = null
} = {}) => {
  requireHmrcConfigured();
  if (!clientId) {
    const error = new Error('Client id is required to connect HMRC.');
    error.statusCode = 400;
    throw error;
  }
  await withFirmDbClient(async (client) => {
    await requireClientInFirm({ client, firmId, clientId });
    const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
    const enabled = clientFlagActs({ flagKey: HMRC_MTD_VAT_FLAG_KEY, snapshot, envFallback: () => false });
    if (!enabled) {
      const error = new Error('HMRC MTD VAT is not enabled for this client.');
      error.statusCode = 403;
      error.code = 'HMRC_MTD_VAT_DISABLED';
      throw error;
    }
  });
  const state = createHmrcState({ firmId, clientId, returnTo, redirectUri, hmrcUserType });
  return {
    authorizeUrl: buildHmrcAuthorizeUrl({ state, redirectUri }),
    state,
    scopes: getHmrcConfig().scopes,
    access: { principal_type: principal?.principalType || null }
  };
};

export const completeHmrcConnectionInDb = async ({ code, state } = {}) => {
  requireHmrcConfigured();
  const statePayload = verifyHmrcState(state);
  const firmId = statePayload.firm_id || DEFAULT_FIRM_ID;
  const clientId = statePayload.client_id;
  const callbackRedirectUri = statePayload.redirect_uri;
  const token = await exchangeHmrcCode({ code, redirectUri: callbackRedirectUri });
  const connectionId = hmrcConnectionIdForClient({ clientId });

  let connectionRow = null;
  await withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      await requireClientInFirm({ client, firmId, clientId });
      const result = await client.query(
        `insert into hmrc_connections (
           id, firm_id, client_id, hmrc_user_type, status, scopes,
           access_token_encrypted, refresh_token_encrypted, token_type, expires_at,
           grant_created_at, last_error, payload
         )
         values ($1, $2, $3, $4, 'active', $5::text[], $6, $7, $8, $9::timestamptz, now(), null, $10::jsonb)
         on conflict (firm_id, client_id) do update set
           hmrc_user_type = excluded.hmrc_user_type,
           status = 'active',
           scopes = excluded.scopes,
           access_token_encrypted = excluded.access_token_encrypted,
           refresh_token_encrypted = excluded.refresh_token_encrypted,
           token_type = excluded.token_type,
           expires_at = excluded.expires_at,
           grant_created_at = now(),
           last_error = null,
           payload = hmrc_connections.payload || excluded.payload,
           updated_at = now()
         returning *`,
        [
          connectionId,
          firmId,
          clientId,
          statePayload.hmrc_user_type,
          token.scopes,
          encryptHmrcToken(token.accessToken),
          encryptHmrcToken(token.refreshToken),
          token.tokenType,
          token.expiresAt,
          JSON.stringify({ token: { scope: token.scopes, expires_at: token.expiresAt }, hmrc_user_type: statePayload.hmrc_user_type })
        ]
      );
      connectionRow = result.rows[0];
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'client', 'hmrc.connection_granted', 'hmrc_connection', $3, $4::jsonb)`,
        [firmId, clientId, connectionRow.id, JSON.stringify({ scopes: token.scopes, hmrc_user_type: statePayload.hmrc_user_type })]
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });

  return { state: statePayload, connection: rowToHmrcConnectionPayload(connectionRow) };
};

export const getFreshHmrcConnectionForSync = async ({ client, firmId, clientId, connectionId } = {}) => {
  const params = [firmId, clientId];
  const result = await client.query(
    `select *
       from hmrc_connections
      where firm_id = $1
        and client_id = $2
        and status in ('active', 'expired', 'error')
        ${connectionId ? 'and id = $3' : ''}
      order by grant_created_at desc
      limit 1`,
    connectionId ? [...params, connectionId] : params
  );
  const connection = result.rows[0];
  if (!connection) {
    const error = new Error('HMRC connection not found.');
    error.statusCode = 404;
    throw error;
  }
  if (!shouldRefreshHmrcToken(connection.expires_at)) {
    return { ...connection, access_token: decryptHmrcToken(connection.access_token_encrypted), refresh_token: decryptHmrcToken(connection.refresh_token_encrypted) };
  }

  let refreshToken;
  try {
    refreshToken = decryptHmrcToken(connection.refresh_token_encrypted);
  } catch (decryptError) {
    decryptError.statusCode = decryptError.statusCode || 500;
    throw decryptError;
  }

  let token;
  try {
    token = await refreshHmrcToken({ refreshToken });
  } catch (refreshError) {
    const expired = isHmrcInvalidGrantError(refreshError);
    await queryFirmDb(
      `update hmrc_connections
          set status = $3, last_error = $4, updated_at = now()
        where firm_id = $1 and id = $2`,
      [firmId, connection.id, expired ? 'expired' : 'error', refreshError.message || 'HMRC token refresh failed.']
    ).catch(() => {});
    const error = new Error(expired
      ? 'HMRC token refresh failed — reconnect HMRC to continue.'
      : 'HMRC token refresh failed.');
    error.statusCode = expired ? 401 : (refreshError.statusCode || 502);
    error.code = expired ? 'HMRC_CONNECTION_EXPIRED' : 'HMRC_CONNECTION_REFRESH_FAILED';
    error.cause = refreshError;
    throw error;
  }

  const payloadPatch = {
    refreshed_at: new Date().toISOString(),
    token: { scope: token.scopes, expires_at: token.expiresAt }
  };
  const updateResult = await client.query(
    `update hmrc_connections
        set status = 'active',
            scopes = $3::text[],
            access_token_encrypted = $4,
            refresh_token_encrypted = $5,
            token_type = $6,
            expires_at = $7::timestamptz,
            last_error = null,
            payload = payload || $8::jsonb,
            updated_at = now()
      where firm_id = $1 and id = $2
      returning *`,
    [
      firmId,
      connection.id,
      token.scopes,
      encryptHmrcToken(token.accessToken),
      encryptHmrcToken(token.refreshToken || refreshToken),
      token.tokenType,
      token.expiresAt,
      JSON.stringify(payloadPatch)
    ]
  );
  const row = updateResult.rows[0] || connection;
  return { ...row, access_token: token.accessToken, refresh_token: token.refreshToken || refreshToken };
};
