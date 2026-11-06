import { Readable } from 'node:stream';

import { handleDonnaApiRequest } from '../api.js';
import { __resetFirmDbPoolForTests, __setFirmDbPoolForTests } from '../firmDb.js';

export const createApiSeamPool = (responders = []) => {
  const queries = [];
  const clients = new Map();
  const readinessSagas = new Map();
  let auditSequence = 900_000;
  const respond = async (sql, params = []) => {
    queries.push({ sql, params });
    if (/insert into clients \(/i.test(sql) && params[0] && params[1]) {
      let profile = {};
      try { profile = JSON.parse(params[8] || '{}'); } catch { /* malformed input stays an empty seam profile */ }
      clients.set(`${params[1]}:${params[0]}`, {
        id: params[0], firm_id: params[1], company_name: params[2] || null,
        uen: params[3] || null, entity_type: params[4] || null,
        jurisdiction: params[10] || null, status: 'active', profile
      });
    }
    for (const [pattern, response] of responders) {
      if (pattern.test(sql)) {
        const resolved = typeof response === 'function'
          ? await response({ sql, params, queries })
          : response;
        if (/from firm_collaborators fc/i.test(sql) && resolved?.rows?.[0]?.client_id) {
          const clientId = resolved.rows[0].client_id;
          clients.set(`${params[0]}:${clientId}`, {
            id: clientId, firm_id: params[0], company_name: null, uen: null,
            entity_type: null, jurisdiction: null, status: 'active',
            profile: { accounting_system: 'none' }
          });
        }
        return resolved;
      }
    }
    // Gate 1B.1 route composition. These generic seam rows keep older route
    // pins focused on their product envelope while allowing the production
    // post-writer readiness observer to execute honestly. Real PostgreSQL
    // lifecycle tests remain the authority for the certificate/read-model SQL.
    if (/select id, firm_id, jurisdiction, entity_type, profile\s+from clients/i.test(sql)) {
      const row = clients.get(`${params[0]}:${params[1]}`);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (/select c\.id, c\.firm_id, c\.company_name[\s\S]+from clients c join firms f/i.test(sql)) {
      const row = clients.get(`${params[0]}:${params[1]}`);
      return {
        rows: row ? [{ ...row, default_currency: 'GBP', firm_metadata: {} }] : [],
        rowCount: row ? 1 : 0
      };
    }
    if (/select \* from entity_readiness_sagas/i.test(sql)) {
      const row = readinessSagas.get(`${params[0]}:${params[1]}`);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (/insert into audit_events[\s\S]+'entity\.provisioning\.attempt'/i.test(sql)) {
      auditSequence += 1;
      return {
        rows: [{ id: auditSequence, created_at: '2026-08-30T00:00:00.000Z' }],
        rowCount: 1
      };
    }
    if (/insert into entity_readiness_sagas/i.test(sql)) {
      const row = {
        firm_id: params[0], client_id: params[1], saga_id: params[2],
        idempotency_key: params[3], state: params[4], admitted_profile_id: params[5],
        certificate_version: params[6], manifest_version: params[7],
        ready_dependency_digest: params[8], observed_dependency_digest: params[9],
        host_compatibility_digest: params[10], latest_attempt_id: params[11],
        root_cause_receipt_id: params[12], attempt_count: params[13],
        max_attempts: params[14], retry_state: params[15], reason_code: params[16],
        responsible_system: params[17], next_retry_at: params[18], ready_at: params[19],
        failed_at: params[20], created_at: '2026-08-30T00:00:00.000Z',
        updated_at: '2026-08-30T00:00:00.000Z'
      };
      readinessSagas.set(`${params[0]}:${params[1]}`, row);
      return { rows: [row], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  // Model physical checkout and transaction-control state, not PostgreSQL data
  // semantics. Responders still own fixture rows; real PG proofs own isolation.
  const checkouts = [];
  const states = new WeakMap();
  const pgError = (code, message) => Object.assign(new Error(message), { code });
  const execute = async (client, sql, params = []) => {
    const state = states.get(client);
    if (state.released) throw new Error('Query after checkout release');
    const text = String(sql).trim().replace(/;$/, '');
    const savepoint = /^(savepoint|release(?: savepoint)?|rollback(?: work| transaction)? to(?: savepoint)?)\s+(\w+)$/i.exec(text);
    const begin = /^(begin|start transaction)\b/i.test(text);
    const commit = /^(commit|end)\b/i.test(text);
    const rollback = /^rollback(?: work| transaction)?$/i.test(text);
    if (savepoint || begin || commit || rollback) {
      queries.push({ sql, params });
      const verb = savepoint?.[1].toLowerCase(), name = savepoint?.[2];
      if (savepoint && !state.transaction) throw pgError('25P01', 'No transaction in progress');
      if (rollback || commit) {
        state.transaction = false; state.failed = false; state.savepoints = [];
      } else if (verb?.startsWith('rollback')) {
        const index = state.savepoints.lastIndexOf(name);
        if (index < 0) { state.failed = true; throw pgError('3B001', 'Savepoint does not exist'); }
        state.savepoints.length = index + 1; state.failed = false;
      } else {
        if (state.failed) throw pgError('25P02', 'Transaction is aborted');
        if (begin) state.transaction = true;
        else if (verb === 'savepoint') state.savepoints.push(name);
        else {
          const index = state.savepoints.lastIndexOf(name);
          if (index < 0) { state.failed = true; throw pgError('3B001', 'Savepoint does not exist'); }
          state.savepoints.length = index;
        }
      }
      return { rows: [], rowCount: 0 };
    }
    if (state.failed) {
      queries.push({ sql, params });
      throw pgError('25P02', 'Transaction is aborted');
    }
    try { return await respond(sql, params); }
    catch (error) { if (state.transaction) state.failed = true; throw error; }
  };
  const connect = async () => {
    const state = { transaction: false, failed: false, savepoints: [], released: false };
    const client = {
      connection: {},
      query: (sql, params) => execute(client, sql, params),
      release: () => {
        if (state.released) throw new Error('Checkout released twice');
        state.released = true;
      }
    };
    states.set(client, state); checkouts.push(client);
    return client;
  };
  return {
    queries, checkouts,
    matching: (pattern) => queries.filter(({ sql }) => pattern.test(sql)),
    get totalCount() { return checkouts.filter(client => !states.get(client).released).length; },
    get idleCount() { return 0; },
    get waitingCount() { return 0; },
    // Each root call uses a fresh checkout, so pool.query cannot own a session.
    query: async (sql, params) => {
      const client = await connect();
      try { return await execute(client, sql, params); }
      finally { client.release(); }
    },
    connect
  };
};

const createResponse = (resolve) => {
  const headers = new Map();
  const chunks = [];
  const response = {
    statusCode: 200,
    setHeader: (name, value) => headers.set(String(name).toLowerCase(), value),
    getHeader: (name) => headers.get(String(name).toLowerCase()),
    write: (chunk) => { chunks.push(Buffer.from(String(chunk))); },
    end: (chunk) => {
      if (chunk !== undefined) chunks.push(Buffer.from(String(chunk)));
      const body = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try { json = body ? JSON.parse(body) : null; } catch { /* non-JSON response */ }
      resolve({ statusCode: response.statusCode, headers: Object.fromEntries(headers), body, json });
    }
  };
  return response;
};

export const requestDonnaApi = async ({
  method = 'GET',
  url,
  headers = {},
  body,
  pool = createApiSeamPool()
}) => {
  __setFirmDbPoolForTests(pool);
  const payload = body === undefined
    ? []
    : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  const req = Readable.from(payload);
  req.method = method;
  req.url = url;
  req.headers = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
  );

  try {
    return await new Promise((resolve, reject) => {
      const res = createResponse(resolve);
      Promise.resolve(handleDonnaApiRequest(req, res)).catch(reject);
    });
  } finally {
    __resetFirmDbPoolForTests();
  }
};
