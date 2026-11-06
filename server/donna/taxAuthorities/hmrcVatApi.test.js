import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createHmrcVatSubmissionTransport,
  HMRC_VAT_BOX_FIELDS,
  retrieveObligations,
  submitReturn
} from './hmrcVatApi.js';
import { submitPreparedGbVatReturn } from '../gb/vatReturnRoute.js';

const response = (status, payload, correlationId = 'corr-1') => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers({ 'X-CorrelationId': correlationId }),
  text: async () => JSON.stringify(payload)
});

test('retrieveObligations preserves the documented authority shape and receipt', async () => {
  let url;
  const payload = { obligations: [{ start: '2026-01-01', end: '2026-03-31', due: '2026-05-07', status: 'O', periodKey: '26A1' }] };
  const result = await retrieveObligations({
    vrn: '123456789', from: '2026-01-01', to: '2026-03-31', accessToken: 'token', baseUrl: 'https://hmrc.test',
    fetchImpl: async (value) => { url = value; return response(200, payload); }
  });
  assert.match(url, /obligations\?from=2026-01-01&to=2026-03-31$/);
  assert.deepEqual(result.result.payload, payload);
  assert.deepEqual({ endpoint: result.receipt.endpoint, status: result.receipt.httpStatus, correlationId: result.receipt.correlationId },
    { endpoint: 'retrieveObligations', status: 200, correlationId: 'corr-1' });
  assert.equal(result.receipt.provenance.confirmedAgainstPrimary, false);
});

test('submission maps canonical digit boxes to HMRC field names with values verbatim', async () => {
  // The shape the route actually feeds: gb/vatReturn.js keys boxes "1".."9".
  const boxes = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [String(index + 1), index + 0.125]));
  const prepared = { period: { periodKey: '26A1' }, vatReturn: { boxes } };
  let sent;
  const transport = createHmrcVatSubmissionTransport({
    accessToken: 'token', vrn: '123456789', finalised: true, baseUrl: 'https://hmrc.test',
    fetchImpl: async (_url, options) => { sent = JSON.parse(options.body); return response(201, { processingDate: '2026-05-01' }); }
  });
  await submitPreparedGbVatReturn({ prepared, transport });
  const wireBoxes = Object.fromEntries(Object.entries(boxes).map(([key, value]) => [HMRC_VAT_BOX_FIELDS[key], value]));
  assert.deepEqual(sent, { periodKey: '26A1', ...wireBoxes, finalised: true });
  assert.equal(Object.keys(sent).includes('1'), false);
  assert.equal(sent.vatDueSales, 0.125);
  assert.equal(sent.totalAcquisitionsExVAT, 8.125);
});

test('a box key outside the canonical vocabulary refuses locally without touching the wire', async () => {
  let fetched = false;
  const output = await submitReturn({
    vrn: '123456789', periodKey: '26A1', accessToken: 'token', baseUrl: 'https://hmrc.test',
    boxes: { box1: 1 },
    fetchImpl: async () => { fetched = true; return response(201, {}); }
  });
  assert.equal(fetched, false);
  assert.equal(output.result.refusal, 'HMRC_VAT_BOX_VOCABULARY_UNKNOWN');
  assert.deepEqual(output.result.payload.unknownBoxKeys, ['box1']);
  assert.equal(output.receipt.httpStatus, null);
  assert.equal(output.receipt.provenance.confirmedAgainstPrimary, false);
});

test('non-2xx response is a named refusal retaining its correlation receipt', async () => {
  const output = await submitReturn({
    vrn: '123456789', periodKey: '26A1', boxes: {}, accessToken: 'token', baseUrl: 'https://hmrc.test',
    fetchImpl: async () => response(400, { code: 'INVALID_REQUEST' }, 'failure-correlation')
  });
  assert.equal(output.result.refusal, 'HMRC_VAT_API_REFUSED');
  assert.equal(output.receipt.correlationId, 'failure-correlation');
  assert.equal(output.receipt.httpStatus, 400);
});

test('route default still refuses rather than accidentally filing', async () => {
  const prepared = { vatReturn: { boxes: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [String(i + 1), 0])) } };
  await assert.rejects(submitPreparedGbVatReturn({ prepared }), (error) => error.code === 'GB_VAT_FILING_CHANNEL_UNAVAILABLE');
});
