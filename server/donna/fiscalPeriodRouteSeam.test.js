// Route-seam tests for the owner fiscal-period step (row 17):
//   GET  /clients/:clientId/fiscal-periods — persisted periods + the server's
//        FISCAL_PERIOD_INTAKE verdict (the FE never guesses a flag)
//   POST /clients/:clientId/fiscal-periods — explicit owner-stated bounds
//        through registerFiscalPeriodFromDb (flag-gated, audit-as-precondition)
//
// The pure planner and the DB writer have their own pins
// (fiscalPeriodIntake.test.js / fiscalPeriodIntakeDb.test.js) — these tests
// cover the ROUTE seam: auth wiring, the flag verdict surfacing, label
// derivation from the end year, and named refusals reaching the response as
// { error, code }.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createApiSeamPool, requestDonnaApi } from './testSupport/apiSeamHarness.js';

const TOKEN = 'fiscal-period-seam';
const priorToken = process.env.DONNA_ACCESS_TOKEN;
const priorDb = process.env.DATABASE_URL;
process.env.DONNA_ACCESS_TOKEN = TOKEN;
process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
const auth = { authorization: `Bearer ${TOKEN}` };

test.after(() => {
  if (priorToken === undefined) delete process.env.DONNA_ACCESS_TOKEN; else process.env.DONNA_ACCESS_TOKEN = priorToken;
  if (priorDb === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorDb;
});

const CLIENT_ROW = [/select id from clients where firm_id = \$1 and id = \$2 and status <> \$3/, { rows: [{ id: 'c-1' }], rowCount: 1 }];
const CANARY_ROW = [/from client_capability_config/, { rows: [{ flag_key: 'FISCAL_PERIOD_INTAKE', stage: 'canary', source: 'test', client_id: 'c-1' }], rowCount: 1 }];

await test('GET fiscal-periods: flag dark → intake_acts false, periods still rendered', async () => {
  process.env.DONNA_ACCESS_TOKEN = TOKEN;
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  const pool = createApiSeamPool([
    CLIENT_ROW,
    [/select id, label, starts_on, ends_on, status from fiscal_years/, { rows: [{ id: 'fy-1', label: '2026', starts_on: '2026-01-01', ends_on: '2026-12-31', status: 'open' }], rowCount: 1 }]
  ]);
  const response = await requestDonnaApi({ url: '/api/donna/firms/clients/c-1/fiscal-periods', headers: auth, pool });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json, {
    intake_acts: false,
    periods: [{ id: 'fy-1', label: '2026', starts_on: '2026-01-01', ends_on: '2026-12-31', status: 'open' }]
  });
});

await test('GET fiscal-periods: canary row → intake_acts true', async () => {
  process.env.DONNA_ACCESS_TOKEN = TOKEN;
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  const pool = createApiSeamPool([CLIENT_ROW, CANARY_ROW]);
  const response = await requestDonnaApi({ url: '/api/donna/firms/clients/c-1/fiscal-periods', headers: auth, pool });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json, { intake_acts: true, periods: [] });
});

await test('GET fiscal-periods: unknown client refuses 404 before any period read', async () => {
  process.env.DONNA_ACCESS_TOKEN = TOKEN;
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  const pool = createApiSeamPool([]);
  const response = await requestDonnaApi({ url: '/api/donna/firms/clients/nope/fiscal-periods', headers: auth, pool });
  assert.equal(response.statusCode, 404, response.body);
  assert.equal(pool.matching(/from fiscal_years/).length, 0, 'no period read for an unknown client');
});

await test('POST fiscal-periods: flag dark → 409 FISCAL_PERIOD_INTAKE_DISABLED, nothing written', async () => {
  process.env.DONNA_ACCESS_TOKEN = TOKEN;
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  const pool = createApiSeamPool([CLIENT_ROW]);
  const response = await requestDonnaApi({
    method: 'POST',
    url: '/api/donna/firms/clients/c-1/fiscal-periods',
    headers: auth,
    body: { starts_on: '2026-01-01', ends_on: '2026-12-31' },
    pool
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json.code, 'FISCAL_PERIOD_INTAKE_DISABLED');
  assert.equal(pool.matching(/insert into fiscal_years/).length, 0);
  assert.equal(pool.matching(/insert into audit_events/).length, 0);
});

await test('POST fiscal-periods: happy path inserts, audits, derives the label from the end year', async () => {
  process.env.DONNA_ACCESS_TOKEN = TOKEN;
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  const saved = { id: 'fy-new', label: '2027', starts_on: '2026-04-01', ends_on: '2027-03-31', status: 'open' };
  const pool = createApiSeamPool([
    CLIENT_ROW,
    CANARY_ROW,
    [/select jurisdiction, entity_type, profile from clients/, { rows: [{ jurisdiction: 'GB', entity_type: 'gb-ltd' }], rowCount: 1 }],
    [/select id, label, starts_on, ends_on, status from fiscal_years/, { rows: [], rowCount: 0 }],
    [/insert into audit_events/, { rows: [{ id: 41 }], rowCount: 1 }],
    [/select \* from fiscal_years/, { rows: [saved], rowCount: 1 }]
  ]);
  const response = await requestDonnaApi({
    method: 'POST',
    url: '/api/donna/firms/clients/c-1/fiscal-periods',
    headers: auth,
    body: { starts_on: '2026-04-01', ends_on: '2027-03-31' },
    pool
  });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json.created, true);
  assert.deepEqual(response.json.fiscal_period, saved);
  // GB: the statutory bound is honestly unenforced (gov.uk 403s through the
  // egress proxy) — the receipt must say so, never imply a clean check.
  assert.equal(response.json.statutory.bound_enforced, false);

  const inserts = pool.matching(/insert into fiscal_years/);
  assert.equal(inserts.length, 1);
  // params: [id, firmId, clientId, label, starts_on, ends_on]
  assert.equal(inserts[0].params[3], '2027', 'label derives from the end year when the caller omits it');
  assert.equal(inserts[0].params[4], '2026-04-01');
  assert.equal(inserts[0].params[5], '2027-03-31');

  const audits = pool.matching(/insert into audit_events/);
  assert.equal(audits.length, 1);
  const meta = JSON.parse(audits[0].params[4]);
  assert.equal(meta.source, 'explicit_intake');
  assert.equal(meta.authority_basis, 'owner_portal_intake');
  assert.equal(meta.statutory_bound_enforced, false);
});

await test('POST fiscal-periods: overlap refuses by name and rolls back', async () => {
  process.env.DONNA_ACCESS_TOKEN = TOKEN;
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  const pool = createApiSeamPool([
    CLIENT_ROW,
    CANARY_ROW,
    [/select jurisdiction, entity_type, profile from clients/, { rows: [{ jurisdiction: 'GB', entity_type: 'gb-ltd' }], rowCount: 1 }],
    [/select id, label, starts_on, ends_on, status from fiscal_years/, { rows: [{ id: 'fy-1', label: '2026', starts_on: '2026-01-01', ends_on: '2026-12-31', status: 'open' }], rowCount: 1 }]
  ]);
  const response = await requestDonnaApi({
    method: 'POST',
    url: '/api/donna/firms/clients/c-1/fiscal-periods',
    headers: auth,
    body: { starts_on: '2026-06-01', ends_on: '2027-05-31' },
    pool
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json.code, 'FISCAL_PERIOD_OVERLAPS_EXISTING');
  assert.equal(pool.matching(/insert into fiscal_years/).length, 0);
});

await test('POST fiscal-periods: FI Oy over 18 months refuses with the Finnish statute, not a neutral bound', async () => {
  process.env.DONNA_ACCESS_TOKEN = TOKEN;
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  const pool = createApiSeamPool([
    CLIENT_ROW,
    CANARY_ROW,
    [/select jurisdiction, entity_type, profile from clients/, { rows: [{ jurisdiction: 'FI', entity_type: 'fi-oy' }], rowCount: 1 }],
    [/select id, label, starts_on, ends_on, status from fiscal_years/, { rows: [], rowCount: 0 }]
  ]);
  const response = await requestDonnaApi({
    method: 'POST',
    url: '/api/donna/firms/clients/c-1/fiscal-periods',
    headers: auth,
    body: { starts_on: '2026-01-01', ends_on: '2027-12-31' },
    pool
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json.code, 'TILIKAUSI_TOO_LONG');
  assert.equal(pool.matching(/insert into fiscal_years/).length, 0);
});
