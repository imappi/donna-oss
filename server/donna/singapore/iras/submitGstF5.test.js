// SG-8 — the IRAS adapter: the pure renderer's KEEP refusals, the pending
// default transport, the factory's typed refusal ladder.
// node --test server/donna/singapore/iras/submitGstF5.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GST_FILING_CHANNEL,
  GST_F5_SUBMISSION_PROVENANCE,
  gstFilingReference,
  renderGstF5Submission,
  resolveIrasFilingConfigFromEnv,
  irasApiTransportPendingConfirmation,
  createIrasSubmitGstF5
} from './submitGstF5.js';

const footedBoxes = () => ({ 1: 1000, 2: 0, 3: 0, 4: 1000, 5: 200, 6: 90, 7: 18, 8: 72, 9: 0, 13: 1000, 14: 0 });
const period = { key: '2026-Q2', type: 'quarter', starts_on: '2026-04-01', ends_on: '2026-06-30' };
const filer = { uen: '201812345K' };

test('the renderer produces a footed submission with the deterministic reference', () => {
  const rendered = renderGstF5Submission({ period, boxes: footedBoxes(), payable: 72, filer });
  assert.equal(rendered.ok, true);
  assert.equal(rendered.submission.reference, 'GSTF5/201812345K/2026-Q2');
  assert.equal(rendered.submission.payload.uen, '201812345K');
  assert.equal(rendered.submission.payload.gst_registration_number, '201812345K', 'defaults to the UEN');
  assert.equal(rendered.submission.payload.boxes['8'], 72);
  assert.equal(rendered.submission.payload.nil_return, false);
  assert.equal(gstFilingReference({ uen: '201812345K', periodKey: '2026-Q2' }), 'GSTF5/201812345K/2026-Q2');
  assert.equal(GST_F5_SUBMISSION_PROVENANCE.confirmedAgainstPrimary, false, 'primary unconfirmed until F-SG-2');
});

test('a nil return transmits all-zero boxes (the filing itself is still required)', () => {
  const rendered = renderGstF5Submission({ period, boxes: footedBoxes(), payable: 72, nilReturn: true, filer });
  assert.equal(rendered.ok, true);
  for (const value of Object.values(rendered.submission.payload.boxes)) assert.equal(value, 0);
  assert.equal(rendered.submission.payload.nil_return, true);
});

test('KEEP refusals: invalid UEN, unresolvable period, misfooted boxes, unknown box ids', () => {
  assert.equal(renderGstF5Submission({ period, boxes: footedBoxes(), payable: 72, filer: { uen: 'nope' } }).ok, false);
  assert.equal(renderGstF5Submission({ period: { key: '2026', type: 'year' }, boxes: footedBoxes(), payable: 72, filer }).ok, false);
  const misfooted = renderGstF5Submission({ period, boxes: { ...footedBoxes(), 4: 999 }, payable: 72, filer });
  assert.equal(misfooted.ok, false);
  assert.ok(misfooted.errors.some((e) => /box 4/.test(e)));
  const unknownBox = renderGstF5Submission({ period, boxes: { ...footedBoxes(), 55: 10 }, payable: 72, filer });
  assert.equal(unknownBox.ok, false);
  assert.ok(unknownBox.errors.some((e) => /unknown GST F5 box/.test(e)));
});

test('env config carries only secrets + tuning knobs — never enablement', () => {
  const config = resolveIrasFilingConfigFromEnv({
    IRAS_FILING_ENDPOINT: 'https://example.test/gst',
    IRAS_FILING_CLIENT_ID: 'id',
    IRAS_FILING_CLIENT_SECRET: 'secret'
  });
  assert.equal(config.endpoint, 'https://example.test/gst');
  assert.equal(config.softwareId, 'Donna');
  assert.equal(resolveIrasFilingConfigFromEnv({}).endpoint, null);
});

test('the default transport refuses typed + retryable until F-SG-2 confirms the protocol', async () => {
  await assert.rejects(irasApiTransportPendingConfirmation(), (e) => e.code === 'GST_FILING_CHANNEL_UNAVAILABLE');
});

test('the factory: no filer source → unavailable; missing UEN → rejected with owner-readable reason', async () => {
  const noSource = createIrasSubmitGstF5({});
  await assert.rejects(
    noSource({ period, boxes: footedBoxes(), payable: 72 }),
    (e) => e.code === 'GST_FILING_CHANNEL_UNAVAILABLE'
  );
  const noUen = createIrasSubmitGstF5({ resolveFiler: async () => ({}) });
  await assert.rejects(
    noUen({ period, boxes: footedBoxes(), payable: 72 }),
    (e) => e.code === 'GST_FILING_REJECTED' && /UEN is missing/.test(e.channelReason)
  );
});

test('missing endpoint/credentials → unavailable (retryable), BEFORE any transport call', async () => {
  const submit = createIrasSubmitGstF5({
    resolveFiler: async () => filer,
    resolveConfig: () => ({}),
    transport: async () => { throw new Error('must not be reached'); }
  });
  await assert.rejects(
    submit({ period, boxes: footedBoxes(), payable: 72 }),
    (e) => e.code === 'GST_FILING_CHANNEL_UNAVAILABLE' && /not configured/.test(e.message)
  );
});

test('a channel rejection carries the verbatim reason; an accepted ack returns the receipt fields', async () => {
  const config = () => ({ endpoint: 'https://example.test', clientId: 'id', clientSecret: 's', softwareId: 'Donna' });
  const rejecting = createIrasSubmitGstF5({
    resolveFiler: async () => filer,
    resolveConfig: config,
    transport: async () => ({ status: 'rejected', reason: 'duplicate period', ack: { code: 'DUP' } })
  });
  await assert.rejects(
    rejecting({ period, boxes: footedBoxes(), payable: 72 }),
    (e) => e.code === 'GST_FILING_REJECTED' && e.channelReason === 'duplicate period'
  );

  const accepting = createIrasSubmitGstF5({
    resolveFiler: async () => filer,
    resolveConfig: config,
    transport: async ({ reference }) => ({ status: 'accepted', submissionId: 'SUB-42', ack: { ref: reference } })
  });
  const result = await accepting({ period, boxes: footedBoxes(), payable: 72 });
  assert.equal(result.channel, GST_FILING_CHANNEL);
  assert.equal(result.submission_id, 'SUB-42');
  assert.equal(result.reference, 'GSTF5/201812345K/2026-Q2');
  assert.deepEqual(result.raw_ack, { ref: 'GSTF5/201812345K/2026-Q2' });
});

test('an unrecognised transport result is UNAVAILABLE — never a false receipt', async () => {
  const weird = createIrasSubmitGstF5({
    resolveFiler: async () => filer,
    resolveConfig: () => ({ endpoint: 'e', clientId: 'i', clientSecret: 's' }),
    transport: async () => ({ status: 'accepted' }) // no submission id
  });
  await assert.rejects(
    weird({ period, boxes: footedBoxes(), payable: 72 }),
    (e) => e.code === 'GST_FILING_CHANNEL_UNAVAILABLE' && /unrecognised/.test(e.message)
  );
});
