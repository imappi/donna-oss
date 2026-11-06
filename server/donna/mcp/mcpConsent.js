// MCP consent surface — the OWNER's per-entity "expose this venture to the
// chat surfaces" read + write (docs/design-donna-mcp-surface.md §8 item 1:
// the settings screen replaces scripts/enable_mcp_entity_expose.js, not the
// flag). ONE consent per entity covers every surface in MCP_SURFACES (the
// Claude Desktop extension, the ChatGPT app, the Claude connector — the
// settings "AI chat access" screen lists them from here, never a client-side
// copy); the flag stays MCP_ENTITY_EXPOSE, per entity, off by default.
//
// Posture (deliberately different from mcpApi.js, same module family):
//   - mcpApi.js serves the EXTERNAL MODEL: fail-closed auth, per-entity
//     consent gate, no existence leak — a non-exposed entity answers like a
//     nonexistent one.
//   - THIS module serves the OWNER deciding that consent inside Donna's
//     settings. It is authenticated as the owner (the standard firm-API
//     chain: requireDonnaAccess → assertFirmAccess), so it MAY list every
//     entity the principal can see, with each one's exposure state — that is
//     the whole point of a consent screen. The no-existence-leak rule binds
//     the external surface, never this one.
//
// Both read and write go through the ONE config plane:
//   - read: readClientConfigSnapshot + clientFlagActs with a hard-false env
//     fallback — the SAME resolution listExposedEntities uses, so the screen
//     can never disagree with the enforcement funnel about who is exposed.
//     CLIENT_CONFIG_FORCE_DISABLE is surfaced (force_disabled) so the UI
//     renders the kill switch honestly instead of showing a live-looking
//     toggle that does nothing.
//   - write: setClientFlagStage — the audited, history-preserving writer the
//     enable script uses. Client-specific row only; the boolean API maps
//     expose→'canary', revoke→'off', so 'auto' (AUTO_FORBIDDEN by design) is
//     not even expressible from this surface. Actor attribution is the
//     authenticated principal, actor_type 'owner' (self-service doctrine —
//     the S3 roles routes pattern), never 'system'.

import {
  DEFAULT_FIRM_ID,
  withFirmDbClient
} from '../firmDb.js';
import {
  readClientConfigSnapshot,
  clientFlagActs,
  forceDisabled,
  setClientFlagStage
} from '../clientConfig.js';
import { MCP_ENTITY_EXPOSE_FLAG_KEY, MCP_SURFACES } from './mcpReadSurface.js';

// The surfaces one consent covers, as the settings screen lists them:
// id + label + transport, straight from the registry's MCP_SURFACES.
export const MCP_CONSENT_SURFACES = Object.freeze(
  Object.values(MCP_SURFACES).map((s) => Object.freeze({ id: s.id, label: s.label, transport: s.transport }))
);

// The only two stages this surface can write. Consent is per entity at
// 'canary' (the sanctioned shape); revocation is 'off'. There is no path to
// 'auto' from here — the writer would refuse it anyway (AUTO_FORBIDDEN_FLAGS),
// this mapping just makes it unexpressible.
export const MCP_EXPOSE_STAGE = 'canary';
export const MCP_REVOKE_STAGE = 'off';

const httpError = (statusCode, code, message) =>
  Object.assign(new Error(message), { statusCode, code });

// Every entity the principal may see, each with its MCP exposure state.
// `allowedClientIds` is assertFirmAccess's scoping result: null = unrestricted
// (firm member / access token), an array = a client-scoped owner — the list is
// filtered to it so an owner only ever sees their own ventures.
export const listEntityExposure = async ({
  firmId = DEFAULT_FIRM_ID,
  allowedClientIds = null,
  deps = {}
} = {}) => {
  const d = {
    withFirmDbClient,
    readClientConfigSnapshot,
    clientFlagActs,
    forceDisabled,
    env: process.env,
    ...deps
  };
  return d.withFirmDbClient(async (dbClient) => {
    const res = await dbClient.query(
      `select id, company_name, status
         from clients
        where firm_id = $1
        order by company_name asc, id asc`,
      [firmId]
    );
    let rows = res.rows || [];
    if (Array.isArray(allowedClientIds)) {
      const allowed = new Set(allowedClientIds);
      rows = rows.filter((row) => allowed.has(row.id));
    }
    const entities = [];
    for (const row of rows) {
      const snapshot = await d.readClientConfigSnapshot(dbClient, { firmId, clientId: row.id });
      entities.push({
        id: row.id,
        name: row.company_name || row.id,
        status: row.status || null,
        // The recorded stage (null = no row = never consented), and whether
        // exposure ACTS right now — they differ under the kill switch, and the
        // UI must render that difference, not paper over it.
        stage: snapshot?.[MCP_ENTITY_EXPOSE_FLAG_KEY]?.stage ?? null,
        exposed: d.clientFlagActs({
          flagKey: MCP_ENTITY_EXPOSE_FLAG_KEY,
          snapshot,
          envFallback: () => false,
          env: d.env
        })
      });
    }
    return {
      flag_key: MCP_ENTITY_EXPOSE_FLAG_KEY,
      force_disabled: d.forceDisabled(MCP_ENTITY_EXPOSE_FLAG_KEY, d.env),
      surfaces: MCP_CONSENT_SURFACES.map((s) => ({ ...s })),
      entities
    };
  });
};

// The consent write: one client-specific row at canary (expose) or off
// (revoke), audited by the writer itself. Verifies the client exists in the
// firm first — a consent grant must name a real entity, and an access-token
// principal is unrestricted so assertFirmAccess alone would not catch a
// bogus id. Returns the fresh persisted state so the UI re-renders from what
// was actually written (render the persisted verdict, not optimism).
export const setEntityExposure = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  expose,
  reason = null,
  actorId = null,
  deps = {}
} = {}) => {
  const d = {
    withFirmDbClient,
    readClientConfigSnapshot,
    clientFlagActs,
    setClientFlagStage,
    env: process.env,
    ...deps
  };
  if (!clientId) {
    throw httpError(400, 'CLIENT_REQUIRED', 'client_id is required — a data-exposure decision must name its entity.');
  }
  if (typeof expose !== 'boolean') {
    throw httpError(400, 'EXPOSE_REQUIRED', 'expose must be true (grant) or false (revoke).');
  }
  const stage = expose ? MCP_EXPOSE_STAGE : MCP_REVOKE_STAGE;
  return d.withFirmDbClient(async (dbClient) => {
    const clientRes = await dbClient.query(
      'select id, company_name from clients where firm_id = $1 and id = $2',
      [firmId, clientId]
    );
    const clientRow = clientRes.rows?.[0];
    if (!clientRow) {
      throw httpError(404, 'CLIENT_NOT_FOUND', `No venture '${clientId}' in this firm.`);
    }
    await dbClient.query('begin');
    let written;
    try {
      written = await d.setClientFlagStage(dbClient, {
        firmId,
        clientId,
        flagKey: MCP_ENTITY_EXPOSE_FLAG_KEY,
        stage,
        source: 'manual',
        reason: reason
          || (expose
            ? 'per-entity MCP exposure consent via the settings consent screen'
            : 'MCP exposure revoked via the settings consent screen'),
        actorType: 'owner',
        actorId
      });
      await dbClient.query('commit');
    } catch (error) {
      await dbClient.query('rollback');
      throw error;
    }
    // Re-read through the one resolver so the answer reflects persisted state
    // AND the kill switch, exactly as the enforcement funnel would see it.
    const snapshot = await d.readClientConfigSnapshot(dbClient, { firmId, clientId });
    return {
      entity: { id: clientRow.id, name: clientRow.company_name || clientRow.id },
      stage: snapshot?.[MCP_ENTITY_EXPOSE_FLAG_KEY]?.stage ?? written.stage,
      exposed: d.clientFlagActs({
        flagKey: MCP_ENTITY_EXPOSE_FLAG_KEY,
        snapshot,
        envFallback: () => false,
        env: d.env
      }),
      config_row_id: written.id
    };
  });
};
