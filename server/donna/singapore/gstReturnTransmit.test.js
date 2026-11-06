// SG-3 — the GST filing transmit seam: typed refusals (authority, CorpPass,
// channel, readiness), the re-foot, the receipt shape.
// node --test server/donna/singapore/gstReturnTransmit.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import { transmitGstReturnFiling } from './gstReturnTransmit.js';
import { CORPPASS_SCOPE_GST } from './corpPassMandate.js';

const footedVerdict = () => ({
  gstReturn: {
    boxes: { 1: 1000, 2: 0, 3: 0, 4: 1000, 5: 200, 6: 90, 7: 18, 8: 72, 9: 0, 13: 1000, 14: 0 },
    payable: 72,
    refund: false,
    nilReturn: false
  },
  review: { status: 'ready', blockers: [] }
});

const period = { key: '2026-Q2', type: 'quarter', starts_on: '2026-04-01', ends_on: '2026-06-30' };
const authorityBasis = { source: 'owner_messaging_gst_filing_confirmation', provider: 'telegram', providerMessageId: 'm1', phoneHash: 'h1' };
const mandate = { id: 'cp1', scope: CORPPASS_SCOPE_GST, status: 'active', granted_on: '2026-01-01', expires_on: null };

test('no authority basis / actor → GST_FILING_AUTHORITY_REQUIRED before anything else', async () => {
  await assert.rejects(
    transmitGstReturnFiling({ verdict: footedVerdict(), period, mandate, submitReturn: async () => ({}) }),
    (e) => e.code === 'GST_FILING_AUTHORITY_REQUIRED'
  );
});

test('no valid CorpPass grant → SG_FILING_CORPPASS_REQUIRED (fail-closed, before channel mechanics)', async () => {
  await assert.rejects(
    transmitGstReturnFiling({
      verdict: footedVerdict(), period, authorityBasis, actorId: 'owner-1',
      mandate: null,
      submitReturn: async () => { throw new Error('must not be reached'); }
    }),
    (e) => e.code === 'SG_FILING_CORPPASS_REQUIRED' && e.mandateReason === 'no_mandate'
  );
});

test('no injected channel → GST_FILING_NO_CHANNEL', async () => {
  await assert.rejects(
    transmitGstReturnFiling({ verdict: footedVerdict(), period, authorityBasis, actorId: 'owner-1', mandate }),
    (e) => e.code === 'GST_FILING_NO_CHANNEL'
  );
});

test('a needs_review verdict and a misfooted box set both refuse as NOT_READY', async () => {
  const blocked = footedVerdict();
  blocked.review = { status: 'needs_review', blockers: ['uncoded_revenue_lines'] };
  await assert.rejects(
    transmitGstReturnFiling({ verdict: blocked, period, authorityBasis, actorId: 'owner-1', mandate, submitReturn: async () => ({}) }),
    (e) => e.code === 'GST_FILING_NOT_READY' && /uncoded_revenue_lines/.test(e.message)
  );
  const misfooted = footedVerdict();
  misfooted.gstReturn.boxes['8'] = 999;
  await assert.rejects(
    transmitGstReturnFiling({ verdict: misfooted, period, authorityBasis, actorId: 'owner-1', mandate, submitReturn: async () => ({}) }),
    (e) => e.code === 'GST_FILING_NOT_READY' && /re-foot/.test(e.message)
  );
});

test('a successful transmit returns the receipt with mandate + model + authority riding it', async () => {
  const calls = [];
  const { receipt } = await transmitGstReturnFiling({
    verdict: footedVerdict(),
    period,
    authorityBasis,
    actorId: 'owner-1',
    model: null,
    mandate,
    submitReturn: async (payload) => { calls.push(payload); return { channel: 'iras_mytax_api', submission_id: 'SUB-1' }; },
    now: () => '2026-07-23T10:00:00.000Z'
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].period.key, '2026-Q2');
  assert.equal(calls[0].payable, 72);
  assert.equal(calls[0].nilReturn, false);
  assert.equal(receipt.channel, 'iras_mytax_api');
  assert.equal(receipt.submission_id, 'SUB-1');
  assert.equal(receipt.period_key, '2026-Q2');
  assert.equal(receipt.transmitted_at, '2026-07-23T10:00:00.000Z');
  assert.equal(receipt.actor_id, 'owner-1');
  assert.deepEqual(receipt.mandate, { id: 'cp1', scope: 'iras_gst', granted_on: '2026-01-01', expires_on: null });
  assert.equal(receipt.model, null, 'the model id is part of the receipt (null for a deterministic compute)');
});
