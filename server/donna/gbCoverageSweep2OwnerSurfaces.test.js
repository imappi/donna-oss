import test from 'node:test';
import assert from 'node:assert/strict';

import { createApiSeamPool, requestDonnaApi } from './testSupport/apiSeamHarness.js';

const TOKEN = 'gb-coverage-sweep-2-owner';
const auth = { authorization: `Bearer ${TOKEN}` };
const setEnv = () => {
  process.env.DONNA_ACCESS_TOKEN = TOKEN;
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
};

await test('coverage sweep: VAT-threshold watch preserves the full persisted payload and reads no ledger', async () => {
  setEnv();
  const watch = { status: 'threshold_exceeded', turnover_gbp: 91_500, threshold_gbp: 90_000, measured_on: '2026-07-31' };
  const pool = createApiSeamPool([
    [/select jurisdiction, entity_type, profile from clients/, { rows: [{ jurisdiction: 'GB', entity_type: 'gb-ltd', profile: {} }], rowCount: 1 }],
    [/from client_evidence_requests/, { rows: [{ request_payload: { kind: 'vat_threshold_review', watch } }], rowCount: 1 }]
  ]);
  const response = await requestDonnaApi({ url: '/api/donna/firms/reports/gb-statutory?client_id=gb-1', headers: auth, pool });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json.thresholdWatch, watch);
  assert.equal(pool.matching(/from client_evidence_requests/).length, 1);
  assert.equal(pool.matching(/from ledger_/).length, 0);
});

await test('F-8C-JURISDICTION-PRECEDENCE: gb-ltd-close lets the FI column outrank a GB profile and GET mints nothing', async () => {
  setEnv();
  const pool = createApiSeamPool([
    [/select jurisdiction, profile from clients/, { rows: [{ jurisdiction: 'FI', profile: { jurisdiction: 'GB' } }], rowCount: 1 }],
    [/select id from clients where firm_id = \$1 and id = \$2 and status/, { rows: [{ id: 'gb-1' }], rowCount: 1 }],
    [/select entity_type, incorporation_date, profile from clients/, { rows: [{ entity_type: 'gb-ltd', incorporation_date: '2026-01-01', profile: {} }], rowCount: 1 }],
    [/from client_capability_config/, { rows: [{ flag_key: 'GB_LTD_MONTHLY_CLOSE', stage: 'canary', client_id: 'gb-1' }], rowCount: 1 }],
    [/select label, starts_on, ends_on from fiscal_years/, { rows: [{ label: 'FY26', starts_on: '2026-01-01', ends_on: '2026-12-31' }], rowCount: 1 }]
  ]);
  const response = await requestDonnaApi({ url: '/api/donna/firms/reports/gb-ltd-close?client_id=gb-1', headers: auth, pool });
  assert.equal(response.statusCode, 404, response.body);
  assert.deepEqual(response.json, { code: 'GB_LTD_CLOSE_SURFACE_NOT_AVAILABLE' });
  assert.equal(pool.matching(/select entity_type, incorporation_date, profile from clients/).length, 0);
  assert.equal(pool.matching(/insert into statutory_blockers/).length, 0);
});

for (const channel of ['sms', 'telegram']) {
  await test(`F-8C-${channel.toUpperCase()}-BINDING-STATE: channel query currently stays on the WhatsApp binding lane`, async () => {
    setEnv();
    const pool = createApiSeamPool([
      [/coalesce\(channel, 'whatsapp'\) = 'whatsapp'/, {
        rows: [{ id: 'wa-1', phone_e164: '+447700900123', created_at: '2026-08-01T00:00:00Z', channel: 'whatsapp' }], rowCount: 1
      }]
    ]);
    const response = await requestDonnaApi({
      url: `/api/donna/firms/whatsapp/binding-state?client_id=gb-1&channel=${channel}`, headers: auth, pool
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json.binding.id, 'wa-1');
    assert.equal(response.json.binding.masked_phone, '••••0123');
    assert.equal(pool.matching(/coalesce\(channel, 'whatsapp'\) = 'whatsapp'/).length, 1);
    assert.equal(pool.matching(new RegExp(`= '${channel}'`)).length, 0);
  });
}
