// FI-3 slice P — the ALV filing transmit seam: typed refusals (authority,
// mandate, channel, readiness, re-foot) and the receipt shape.
// node --test server/donna/finland/alvReturnTransmit.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import { transmitAlvReturnFiling } from './alvReturnTransmit.js';
import { SUOMIFI_MANDATE_SCOPE_TAX } from './suomifiMandate.js';

const footedVerdict = () => ({
  alvReturn: {
    boxes: { 301: 127.5, 307: 25.5, 308: 102 },
    payable: 102,
    refund: false,
    nilReturn: false,
    selfAssessedFullyDeductible: true
  },
  review: { status: 'ready', blockers: [] }
});

const period = { key: '2026-06', type: 'month', starts_on: '2026-06-01', ends_on: '2026-06-30' };
const authorityBasis = { source: 'owner_whatsapp_alv_filing_confirmation', providerMessageId: 'wamid.1', phoneHash: 'ph' };
// G-3: the transmit seam refuses without a valid Suomi.fi mandate — every
// happy-path fixture carries one.
const mandate = {
  id: 'suomifi-mandate-1',
  scope: SUOMIFI_MANDATE_SCOPE_TAX,
  status: 'active',
  granted_on: '2026-01-15',
  expires_on: null
};

test('refuses without an authority basis or actor — a statutory send never goes out bare', async () => {
  await assert.rejects(
    transmitAlvReturnFiling({ verdict: footedVerdict(), period, actorId: 'owner-1', submitReturn: async () => ({}) }),
    (e) => e.code === 'ALV_FILING_AUTHORITY_REQUIRED'
  );
  await assert.rejects(
    transmitAlvReturnFiling({ verdict: footedVerdict(), period, authorityBasis, submitReturn: async () => ({}) }),
    (e) => e.code === 'ALV_FILING_AUTHORITY_REQUIRED'
  );
});

test('refuses without an injected channel — the OmaVero/Ilmoitin adapter is FI-8, never a silent no-op', async () => {
  await assert.rejects(
    transmitAlvReturnFiling({ verdict: footedVerdict(), period, authorityBasis, actorId: 'owner-1', mandate }),
    (e) => e.code === 'ALV_FILING_NO_CHANNEL'
  );
});

test('refuses a needs_review or misfooting verdict — the 308 identity re-checks before anything leaves', async () => {
  const blocked = footedVerdict();
  blocked.review = { status: 'needs_review', blockers: ['uncoded_revenue_lines'] };
  await assert.rejects(
    transmitAlvReturnFiling({ verdict: blocked, period, authorityBasis, actorId: 'owner-1', mandate, submitReturn: async () => ({}) }),
    (e) => e.code === 'ALV_FILING_NOT_READY' && /uncoded_revenue_lines/.test(e.message)
  );
  const misfoot = footedVerdict();
  misfoot.alvReturn.boxes['308'] = 999; // tampered stored verdict
  await assert.rejects(
    transmitAlvReturnFiling({ verdict: misfoot, period, authorityBasis, actorId: 'owner-1', mandate, submitReturn: async () => ({}) }),
    (e) => e.code === 'ALV_FILING_NOT_READY' && /re-foot/.test(e.message)
  );
});

test('a successful transmit returns the full receipt: channel, period, payable, authority, actor, model', async () => {
  const sent = [];
  const { receipt } = await transmitAlvReturnFiling({
    verdict: footedVerdict(),
    period,
    authorityBasis,
    actorId: 'owner-1',
    model: null,
    mandate,
    now: () => '2026-07-12T09:00:00.000Z',
    submitReturn: async (payload) => {
      sent.push(payload);
      return { channel: 'omavero_test', submission_id: 'SUB-1' };
    }
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].period.key, '2026-06');
  assert.equal(sent[0].payable, 102);
  assert.equal(sent[0].boxes['301'], 127.5);
  assert.equal(receipt.channel, 'omavero_test');
  assert.equal(receipt.submission_id, 'SUB-1');
  assert.equal(receipt.period_key, '2026-06');
  assert.equal(receipt.payable, 102);
  assert.equal(receipt.transmitted_at, '2026-07-12T09:00:00.000Z');
  assert.equal(receipt.authority_basis.source, 'owner_whatsapp_alv_filing_confirmation');
  assert.equal(receipt.actor_id, 'owner-1');
  assert.equal(receipt.model, null); // deterministic compute → no model id, honestly
  // G-3: the mandate is part of the receipt — which legal authorization the
  // filing rode, reproducible after the fact.
  assert.deepEqual(receipt.mandate, {
    id: 'suomifi-mandate-1',
    scope: SUOMIFI_MANDATE_SCOPE_TAX,
    granted_on: '2026-01-15',
    expires_on: null
  });
});

test('G-3: refuses without a valid Suomi.fi mandate — missing, revoked, or expired at the filing moment', async () => {
  const args = (m) => ({
    verdict: footedVerdict(),
    period,
    authorityBasis,
    actorId: 'owner-1',
    mandate: m,
    now: () => '2026-07-12T09:00:00.000Z',
    submitReturn: async () => { throw new Error('must never reach the channel without a mandate'); }
  });
  await assert.rejects(
    transmitAlvReturnFiling(args(null)),
    (e) => e.code === 'ALV_FILING_MANDATE_REQUIRED' && e.mandateReason === 'no_mandate'
  );
  await assert.rejects(
    transmitAlvReturnFiling(args({ ...mandate, status: 'revoked' })),
    (e) => e.code === 'ALV_FILING_MANDATE_REQUIRED' && e.mandateReason === 'revoked'
  );
  await assert.rejects(
    transmitAlvReturnFiling(args({ ...mandate, expires_on: '2026-06-30' })),
    (e) => e.code === 'ALV_FILING_MANDATE_REQUIRED' && e.mandateReason === 'expired'
  );
  await assert.rejects(
    transmitAlvReturnFiling(args({ ...mandate, scope: 'muu_asia' })),
    (e) => e.code === 'ALV_FILING_MANDATE_REQUIRED' && e.mandateReason === 'wrong_scope'
  );
});
