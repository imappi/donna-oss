import test from 'node:test';
import assert from 'node:assert/strict';

import { createApiSeamPool, requestDonnaApi } from './testSupport/apiSeamHarness.js';

// CSV statement intake — the upload-mint gate pins
// (docs/design-donna-csv-statement-intake.md §5). /documents/upload-url is a
// METADATA-ONLY gate (mime + size from the JSON body; bytes go straight to
// signed storage), so the Windows/Excel `.csv`-as-vnd.ms-excel trap is
// normalized here by extension — and ONLY here: a vnd.ms-excel without a
// .csv filename must stay refused so a true .xls cannot ride the trap fix.

const TOKEN = 'evidence-upload-csv-gate';
const auth = { authorization: `Bearer ${TOKEN}` };

const ownedClientPool = () => ({
  ...createApiSeamPool([
    [/select id from clients where firm_id/i, ({ params }) => ({
      rows: params[0] === 'firm-1' && params[1] === 'client-1' ? [{ id: 'client-1' }] : []
    })],
    [/select current_setting/, { rows: [{ statement: '0', lock: '0' }] }]
  ]),
  options: { connectionTimeoutMillis: 2000 }
});

const setFirmEnv = () => {
  process.env.DONNA_ACCESS_TOKEN = TOKEN;
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  process.env.SUPABASE_URL = 'http://storage.seam.invalid';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'seam-service-key';
};

const uploadUrlBody = (overrides = {}) => ({
  firm_id: 'firm-1',
  client_id: 'client-1',
  filename: 'statement.csv',
  mime_type: 'text/csv',
  size: 1024,
  ...overrides
});

// The one network call on the 200 path is the storage sign POST; stub it and
// count invocations so refusal pins can assert the gate stopped BEFORE it.
const withStorageFetchStub = async (run) => {
  const priorFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ url: '/object/upload/sign/donna-evidence/seam-key', token: 'seam-token' })
    };
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = priorFetch;
  }
};

test('text/csv mints an upload URL (the 400→200 pin)', async () => {
  setFirmEnv();
  await withStorageFetchStub(async (calls) => {
    const response = await requestDonnaApi({
      method: 'POST',
      url: '/api/donna/firms/documents/upload-url',
      headers: auth,
      body: uploadUrlBody(),
      pool: ownedClientPool()
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json.source, 'evidence_upload_url');
    assert.equal(response.json.content_type, 'text/csv');
    assert.equal(calls.length, 1, 'the storage sign call ran');
    assert.match(calls[0].url, /storage\.seam\.invalid.*upload\/sign/);
  });
});

test('vnd.ms-excel with a .csv filename normalizes to text/csv (the Windows/Excel trap pin)', async () => {
  setFirmEnv();
  await withStorageFetchStub(async (calls) => {
    const response = await requestDonnaApi({
      method: 'POST',
      url: '/api/donna/firms/documents/upload-url',
      headers: auth,
      body: uploadUrlBody({ mime_type: 'application/vnd.ms-excel', filename: 'Bank Export.CSV' }),
      pool: ownedClientPool()
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json.content_type, 'text/csv', 'the normalized mime rides the receipt, not the declared one');
    assert.equal(calls.length, 1);
  });
});

test('an empty declared mime with a .csv filename also normalizes', async () => {
  setFirmEnv();
  await withStorageFetchStub(async () => {
    const response = await requestDonnaApi({
      method: 'POST',
      url: '/api/donna/firms/documents/upload-url',
      headers: auth,
      body: uploadUrlBody({ mime_type: '', filename: 'export.csv' }),
      pool: ownedClientPool()
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json.content_type, 'text/csv');
  });
});

test('vnd.ms-excel WITHOUT a .csv filename stays refused (a true .xls must not ride the trap fix)', async () => {
  setFirmEnv();
  await withStorageFetchStub(async (calls) => {
    const response = await requestDonnaApi({
      method: 'POST',
      url: '/api/donna/firms/documents/upload-url',
      headers: auth,
      body: uploadUrlBody({ mime_type: 'application/vnd.ms-excel', filename: 'report.xls' }),
      pool: ownedClientPool()
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json.code, 'EVIDENCE_FILE_TYPE_UNSUPPORTED');
    assert.equal(calls.length, 0, 'refused before any storage call');
  });
});

test('XLSX stays out of evidence upload because the separate Import data workflow owns it', async () => {
  setFirmEnv();
  await withStorageFetchStub(async (calls) => {
    const response = await requestDonnaApi({
      method: 'POST',
      url: '/api/donna/firms/documents/upload-url',
      headers: auth,
      body: uploadUrlBody({
        mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        filename: 'report.xlsx'
      }),
      pool: ownedClientPool()
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json.code, 'EVIDENCE_FILE_TYPE_UNSUPPORTED');
    assert.equal(calls.length, 0);
  });
});

test('application/pdf keeps minting unchanged (regression pin)', async () => {
  setFirmEnv();
  await withStorageFetchStub(async () => {
    const response = await requestDonnaApi({
      method: 'POST',
      url: '/api/donna/firms/documents/upload-url',
      headers: auth,
      body: uploadUrlBody({ mime_type: 'application/pdf', filename: 'statement.pdf' }),
      pool: ownedClientPool()
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json.content_type, 'application/pdf');
  });
});

test('a normalized CSV still meets the size gate after the mime gate', async () => {
  setFirmEnv();
  await withStorageFetchStub(async (calls) => {
    const response = await requestDonnaApi({
      method: 'POST',
      url: '/api/donna/firms/documents/upload-url',
      headers: auth,
      body: uploadUrlBody({ mime_type: 'application/vnd.ms-excel', filename: 'export.csv', size: 11 * 1024 * 1024 }),
      pool: ownedClientPool()
    });
    assert.equal(response.statusCode, 413, 'mime gate passed (not 400), size gate refused');
    assert.equal(response.json.code, 'EVIDENCE_FILE_SIZE_INVALID');
    assert.equal(calls.length, 0);
  });
});
