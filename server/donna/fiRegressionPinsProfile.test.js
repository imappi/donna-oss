import test from 'node:test';
import assert from 'node:assert/strict';

import { createApiSeamPool, requestDonnaApi } from './testSupport/apiSeamHarness.js';

await test('FI profile route preserves a GB-free write envelope', async () => {
  process.env.DONNA_ACCESS_TOKEN = 'fi-regression-profile-pin';
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  const pool = createApiSeamPool([
    [/select jurisdiction, profile from clients/, { rows: [{ jurisdiction: 'FI', profile: { jurisdiction: 'fi' } }], rowCount: 1 }],
    [/update clients\s+set profile = case/, { rows: [{ id: 'fi-1' }], rowCount: 1 }]
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
      url: '/api/donna/firms/clients/fi-1/profile',
      headers: { authorization: 'Bearer fi-regression-profile-pin', 'content-type': 'application/json' },
      body: { firm_id: 'firm-1', profile_patch: { jurisdiction: 'FI', verokausi: 'quarter' } },
      pool
    });
  } finally {
    globalThis.Date = RealDate;
  }
  const writes = pool.matching(/update clients\s+set profile = case/);
  assert.equal(writes.length, 1, 'the profile UPDATE ran');
  assert.deepEqual(writes[0].params, [
    'firm-1', 'fi-1', JSON.stringify({
      jurisdiction: 'fi', verokausi: 'quarter', jurisdiction_confirmed_by: 'access-token',
      jurisdiction_confirmed_at: '2026-08-01T12:00:00.000Z'
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
        // 122 — the audience-attribution keys (on_owner_by_reason, colleague_asks*)
        // joined the metric shape with the ask-audience generalization.
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
