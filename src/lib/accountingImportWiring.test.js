import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { inspectFirmAccountingImport } from './firmApi.js';
import { MOUNTED_SURFACE_MESSAGES } from '../i18n/catalogs/mountedSurfaces.en.js';

const read = (url) => readFile(url, 'utf8');

test('mounted Settings Data surface and venture drop handoff reach the read-only accounting import route', async () => {
  const [app, settings, card, overlay, api] = await Promise.all([
    read(new URL('../App.jsx', import.meta.url)),
    read(new URL('../components/settings/SettingsPanel.jsx', import.meta.url)),
    read(new URL('../components/settings/AccountingImportCard.jsx', import.meta.url)),
    read(new URL('../components/FirmDropOverlay.jsx', import.meta.url)),
    read(new URL('../../server/donna/api.js', import.meta.url))
  ]);
  assert.match(app, /<SettingsPanel[\s\S]*clients=\{firmClients\}[\s\S]*selectedClientId=/);
  assert.match(settings, /<AccountingImportCard[\s\S]*clients=\{clients\}/);
  assert.match(card, /\.csv,\.tsv,\.xlsx,\.xls/);
  assert.match(card, /mounted\.import\.previewOnly/);
  assert.equal(MOUNTED_SURFACE_MESSAGES['mounted.import.previewOnly'], 'Preview only');
  assert.match(overlay, /partitionFirmDropFiles/);
  assert.match(overlay, /onAccountingImport\(\{ file: accountingImportFiles\[0\], clientId \}\)/);
  assert.match(app, /setAccountingImportRequest\(\{ file, clientId \}\)[\s\S]*setSettingsSection\('data'\)[\s\S]*setActiveTab\('settings'\)/);
  assert.match(settings, /accountingImportRequest=\{accountingImportRequest\}/);
  assert.match(card, /chooseFile\(selected, targetClientId\)/);
  assert.match(api, /requestUrl\.pathname === '\/imports\/inspect'/);
  assert.match(api, /await assertFirmAccess\([\s\S]*clientIds: collectClientIds\(clientId\)/);
  assert.match(api, /inspectAccountingImport\(\{/);
});

test('the browser client sends source bytes directly and preserves mapping inputs', async () => {
  const priorFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return new Response(JSON.stringify({ state: 'needs_kind' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  try {
    const file = new File(['A,B\n1,2\n'], 'data.csv', { type: 'text/csv' });
    await inspectFirmAccountingImport({
      file,
      firmId: 'firm-1',
      clientId: 'client-1',
      importKind: 'bank_transactions',
      sheetHandle: 'sheet_1',
      mapping: { date: 'column_1' },
      dateConvention: 'dmy',
      numberConvention: 'comma_decimal'
    });
    const url = new URL(captured.url, 'http://localhost');
    assert.equal(url.pathname, '/api/donna/firms/imports/inspect');
    assert.equal(url.searchParams.get('client_id'), 'client-1');
    assert.equal(url.searchParams.get('import_kind'), 'bank_transactions');
    assert.equal(url.searchParams.get('sheet_handle'), 'sheet_1');
    assert.deepEqual(JSON.parse(url.searchParams.get('mapping')), { date: 'column_1' });
    assert.equal(url.searchParams.get('date_convention'), 'dmy');
    assert.equal(url.searchParams.get('number_convention'), 'comma_decimal');
    assert.equal(captured.init.body, file);
    assert.equal(captured.init.headers['Content-Type'], 'text/csv');
  } finally {
    globalThis.fetch = priorFetch;
  }
});
