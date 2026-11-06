import test from 'node:test';
import assert from 'node:assert/strict';

import { createApiSeamPool, requestDonnaApi } from './testSupport/apiSeamHarness.js';

const TOKEN = 'fi-regression-route-pin';
const auth = { authorization: `Bearer ${TOKEN}` };

const setRouteEnv = () => {
  process.env.DONNA_ACCESS_TOKEN = TOKEN;
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
};

for (const jurisdiction of ['FI', null]) {
  const label = jurisdiction || 'absent jurisdiction';
  const profile = jurisdiction ? {} : {};
  const reportPins = [
    {
      path: 'gb-vat-return',
      query: /select jurisdiction from clients/,
      row: { jurisdiction },
      expected: { code: 'GB_VAT_SURFACE_NOT_AVAILABLE' }
    },
    {
      path: 'gb-statutory',
      query: /select jurisdiction, entity_type, profile from clients/,
      row: { jurisdiction, entity_type: 'fi-oy', profile },
      expected: { code: 'GB_STATUTORY_SURFACE_NOT_AVAILABLE' }
    },
    {
      path: 'gb-ltd-close',
      query: /select jurisdiction, profile from clients/,
      row: { jurisdiction, profile },
      expected: { code: 'GB_LTD_CLOSE_SURFACE_NOT_AVAILABLE' }
    }
  ];

  for (const pin of reportPins) {
    await test(`${label}: /reports/${pin.path} preserves the complete non-GB envelope`, async () => {
      setRouteEnv();
      const pool = createApiSeamPool([[pin.query, { rows: [pin.row], rowCount: 1 }]]);
      const response = await requestDonnaApi({
        url: `/api/donna/firms/reports/${pin.path}?firm_id=firm-1&client_id=fi-1`,
        headers: auth,
        pool
      });

      assert.deepEqual(response, {
        statusCode: 404,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(pin.expected),
        json: pin.expected
      });
      assert.equal(pool.matching(pin.query).length, 1, 'the jurisdiction gate query ran');
    });
  }
}

for (const clientId of ['fi-1', 'jurisdiction-absent-1']) {
  await test(`${clientId}: WhatsApp binding-state preserves its complete jurisdiction-neutral envelope`, async () => {
    setRouteEnv();
    const pool = createApiSeamPool([]);
    const response = await requestDonnaApi({
      url: `/api/donna/firms/whatsapp/binding-state?firm_id=firm-1&client_id=${clientId}`,
      headers: auth,
      pool
    });
    const expected = { channel_acts: false, binding: null };
    assert.deepEqual(response, {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(expected),
      json: expected
    });
    assert.equal(pool.matching(/from client_whatsapp_bindings/).length, 1, 'the binding read ran');
    assert.ok(pool.matching(/from client_capability_config/).length >= 1, 'the config-plane read ran');
  });
}
