import test from 'node:test';
import assert from 'node:assert/strict';

import { createApiSeamPool, requestDonnaApi } from './testSupport/apiSeamHarness.js';

const TOKEN = 'gb-coverage-sweep-3';
const auth = { authorization: `Bearer ${TOKEN}` };

const setEnv = () => {
  process.env.DONNA_ACCESS_TOKEN = TOKEN;
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
};

const closeResponders = ({ entityType = 'gb-ltd', flagStage = null } = {}) => [
  [/select jurisdiction, profile from clients/, { rows: [{ jurisdiction: 'GB', profile: {} }], rowCount: 1 }],
  [/select id from clients where firm_id = \$1 and id = \$2 and status/, { rows: [{ id: 'gb-1' }], rowCount: 1 }],
  [/select entity_type, incorporation_date, profile from clients/, {
    rows: [{ entity_type: entityType, incorporation_date: '2025-01-15', profile: {} }], rowCount: 1
  }],
  ...(flagStage ? [[/from client_capability_config/, {
    rows: [{ flag_key: 'GB_LTD_MONTHLY_CLOSE', stage: flagStage, source: 'test', client_id: 'gb-1' }], rowCount: 1
  }]] : [])
];

await test('gb-ltd-close: a canonical mixed-case Ltd stays dark when its config-plane flag is absent', async () => {
  setEnv();
  const pool = createApiSeamPool(closeResponders({ entityType: 'GB-Ltd' }));
  const response = await requestDonnaApi({
    url: '/api/donna/firms/reports/gb-ltd-close?firm_id=firm-1&client_id=gb-1', headers: auth, pool
  });

  assert.deepEqual(response, {
    statusCode: 403,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'GB_LTD_MONTHLY_CLOSE_DISABLED' }),
    json: { code: 'GB_LTD_MONTHLY_CLOSE_DISABLED' }
  });
  assert.ok(pool.matching(/from client_capability_config/).length >= 1, 'the config-plane flag gate ran');
  assert.equal(pool.matching(/select label, starts_on, ends_on from fiscal_years/).length, 0, 'the refusal preceded close evaluation');
  assert.equal(pool.matching(/insert into statutory_blockers/).length, 0, 'the refused GET minted nothing');
});

for (const [label, entityType] of [
  ['LLP', 'GB-LLP'],
  ['partnership', 'gb-partnership'],
  ['unknown entity', 'limited-ish']
]) {
  await test(`gb-ltd-close: a GB ${label} receives the complete Ltd-only entity refusal`, async () => {
    setEnv();
    const pool = createApiSeamPool(closeResponders({ entityType, flagStage: 'canary' }));
    const response = await requestDonnaApi({
      url: '/api/donna/firms/reports/gb-ltd-close?firm_id=firm-1&client_id=gb-1', headers: auth, pool
    });

    assert.deepEqual(response, {
      statusCode: 409,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'GB_LTD_MONTHLY_CLOSE_ENTITY_NOT_LTD' }),
      json: { code: 'GB_LTD_MONTHLY_CLOSE_ENTITY_NOT_LTD' }
    });
    assert.equal(pool.matching(/from client_capability_config/).length, 0, 'the entity refusal preceded the flag read');
    assert.equal(pool.matching(/insert into statutory_blockers/).length, 0, 'the refused GET minted nothing');
  });
}

await test('absent-jurisdiction profile clear preserves the complete neutral response envelope', async () => {
  setEnv();
  const pool = createApiSeamPool([
    [/select jurisdiction, profile from clients/, { rows: [{ jurisdiction: null, profile: {} }], rowCount: 1 }],
    [/update clients\s+set profile = case/, { rows: [{ id: 'jurisdiction-absent-1' }], rowCount: 1 }]
  ]);
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : ['2026-08-01T12:00:00.000Z'])); }
    static now() { return new RealDate('2026-08-01T12:00:00.000Z').valueOf(); }
  };
  let response;
  try {
    response = await requestDonnaApi({
      method: 'POST',
      url: '/api/donna/firms/clients/jurisdiction-absent-1/profile',
      headers: { ...auth, 'content-type': 'application/json' },
      body: { firm_id: 'firm-1', profile_patch: { jurisdiction: null, verokausi: null } },
      pool
    });
  } finally {
    globalThis.Date = RealDate;
  }

  const writes = pool.matching(/update clients\s+set profile = case/);
  assert.equal(writes.length, 1, 'the profile UPDATE ran');
  assert.deepEqual(writes[0].params, [
    'firm-1', 'jurisdiction-absent-1', JSON.stringify({
      jurisdiction: null,
      verokausi: null,
      jurisdiction_confirmed_by: null,
      jurisdiction_confirmed_at: null
    }), false
  ]);
  const snapshot = {
    source: 'database', firm: null,
    runtimeReadinessHost: {
      projection_version: 'donna.runtime-readiness-projection.v1',
      state: 'missing', mutation_ready: false, reason_code: 'host_readiness_missing',
      responsible_system: 'donna_runtime', retryable: true, checked_at: null,
      valid_until: null, receipt_ref: null
    },
    members: [], collaborators: [], assignments: [], clients: [], documents: [],
    recentUploadBatches: [], transactions: [], accountingRules: [], clientRules: [], merchants: [],
    xeroConnections: [], xeroAccounts: [], xeroContacts: [], xeroSyncRuns: [], ledgerAccounts: [],
    ledgerJournals: [], ledgerLines: [], closePeriods: [], closeChecks: [], closeArchives: [],
    clientEvidenceRequests: [], reconciliationMatches: [],
    convergenceMetrics: {
      overall: {
        auto_reconciled: 0, on_owner: 0, hanging: 0, total: 0, converged: true,
        // 122 — the audience-attribution keys joined the metric shape with the
        // ask-audience generalization.
        hanging_by_reason: {}, on_owner_by_reason: {}, authority_misses: 0, colleague_asks: 0,
        prompts_per_100: 0, colleague_asks_per_100: 0, hanging_per_100: 0
      },
      by_client: {}
    },
    transactionReviewQueue: [], queue: [], history: [], llmDecisions: []
  };
  assert.deepEqual(response, {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(snapshot),
    json: snapshot
  });
});

await test('absent-jurisdiction country facts refuse before a profile mutation', async () => {
  setEnv();
  const pool = createApiSeamPool([
    [/select jurisdiction, profile from clients/, { rows: [{ jurisdiction: null, profile: {} }], rowCount: 1 }]
  ]);
  const response = await requestDonnaApi({
    method: 'POST', url: '/api/donna/firms/clients/jurisdiction-absent-1/profile',
    headers: { ...auth, 'content-type': 'application/json' },
    body: { firm_id: 'firm-1', profile_patch: { jurisdiction: null, verokausi: 'quarter' } }, pool
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.json.code, 'profile_jurisdiction_unresolved');
  assert.equal(pool.matching(/update clients/).length, 0);
  assert.equal(pool.matching(/insert into audit_events/).length, 0);
});
