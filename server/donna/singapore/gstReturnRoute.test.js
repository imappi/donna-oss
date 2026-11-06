// SG-3 slice P — the GST F5 owner route: ask detection, yes/no/nudge, the
// fail-closed CorpPass leg, stale-ask handling, two-terminal-states.
// node --test server/donna/singapore/gstReturnRoute.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GST_RETURN_ASK_KIND,
  isGstReturnAsk,
  buildGstFilingAuthorityBasis,
  summarizeGstF5Verdict,
  gstReturnConfirmQuestion,
  resolveGstReturnInbound
} from './gstReturnRoute.js';
import { CORPPASS_SCOPE_GST } from './corpPassMandate.js';

const pendingRow = (overrides = {}) => ({
  id: 'gst-return-1',
  period_key: '2026-Q2',
  period_type: 'quarter',
  starts_on: '2026-04-01',
  ends_on: '2026-06-30',
  status: 'draft_pending_confirmation',
  model: null,
  verdict: {
    gstReturn: {
      boxes: { 1: 1000, 2: 0, 3: 0, 4: 1000, 5: 200, 6: 90, 7: 18, 8: 72, 9: 0, 13: 1000, 14: 0 },
      payable: 72, refund: false, nilReturn: false
    },
    review: { status: 'ready', blockers: [] }
  },
  ...overrides
});

const askFor = (row) => ({
  id: 'ask-1',
  evidence_type: GST_RETURN_ASK_KIND,
  request_payload: { kind: GST_RETURN_ASK_KIND, gst_return: { gst_return_id: row.id } }
});

const mandate = { id: 'cp1', scope: CORPPASS_SCOPE_GST, status: 'active', granted_on: '2026-01-01', expires_on: null };
const message = { id: 'msg-1', timestamp: '2026-07-23T09:00:00Z' };

const harness = ({ row = pendingRow(), withMandate = true, submitResult } = {}) => {
  const state = { sent: [], resolved: [], filed: [], cancelled: [] };
  const deps = {
    firmId: 'firm-1',
    clientId: 'client-1',
    ask: askFor(row),
    message,
    phoneHash: 'hash-1',
    provider: 'telegram',
    actorId: 'owner-1',
    flagActs: true,
    getGstReturnImpl: async () => row,
    getMandateImpl: async ({ scope }) => (withMandate && scope === CORPPASS_SCOPE_GST ? mandate : null),
    markFiledImpl: async ({ gstReturnId, filingReceipt }) => {
      state.filed.push({ gstReturnId, filingReceipt });
      return { ...row, status: 'filed', filing_receipt: filingReceipt };
    },
    cancelImpl: async ({ gstReturnId, reason }) => {
      state.cancelled.push({ gstReturnId, reason });
      return { ...row, status: 'cancelled', cancel_reason: reason };
    },
    submitReturn: async () => submitResult || { channel: 'iras_mytax_api', submission_id: 'SUB-9' },
    resolveAsk: async ({ askId, resolutionNote }) => state.resolved.push({ askId, resolutionNote }),
    sendText: async ({ text }) => state.sent.push(text)
  };
  return { state, deps };
};

test('isGstReturnAsk recognises the kind on every carrier field and nothing else', () => {
  assert.equal(isGstReturnAsk({ kind: 'gst_return' }), true);
  assert.equal(isGstReturnAsk({ evidence_type: 'gst_return' }), true);
  assert.equal(isGstReturnAsk({ request_payload: { kind: 'gst_return' } }), true);
  assert.equal(isGstReturnAsk({ payload: { gst_return: {} } }), true);
  assert.equal(isGstReturnAsk({ evidence_type: 'alv_return' }), false);
  assert.equal(isGstReturnAsk(null), false);
});

test('the confirm summary renders the PERSISTED verdict in S$, payable/refund/nil variants', () => {
  const row = pendingRow();
  const summary = summarizeGstF5Verdict({ periodKey: row.period_key, verdict: row.verdict });
  assert.match(summary, /2026-Q2/);
  assert.match(summary, /payable to IRAS: S\$72\.00/);
  assert.match(summary, /Output tax S\$90\.00 · Input tax claimed S\$18\.00/);
  const refund = summarizeGstF5Verdict({
    periodKey: '2026-Q2',
    verdict: { gstReturn: { boxes: { 6: 10, 7: 100 }, payable: -90, refund: true, nilReturn: false } }
  });
  assert.match(refund, /claimable from IRAS: S\$90\.00/);
  const nil = summarizeGstF5Verdict({ periodKey: '2026-Q2', verdict: { gstReturn: { nilReturn: true, boxes: {} } } });
  assert.match(nil, /nil return/);
  assert.match(gstReturnConfirmQuestion({ periodKey: '2026-Q2', verdict: pendingRow().verdict }), /Reply "yes"/);
});

test('"yes" files: transmit → mark filed → resolve ask → owner receipt text', async () => {
  const { state, deps } = harness();
  const result = await resolveGstReturnInbound({ ...deps, replyText: 'yes' });
  assert.equal(result.action, 'confirm_and_file');
  assert.equal(state.filed.length, 1);
  assert.equal(state.filed[0].filingReceipt.submission_id, 'SUB-9');
  assert.equal(state.filed[0].filingReceipt.mandate.id, 'cp1');
  assert.deepEqual(state.resolved, [{ askId: 'ask-1', resolutionNote: 'gst_return_filed' }]);
  assert.match(state.sent[0], /filed with IRAS/);
  assert.match(state.sent[0], /S\$72\.00/);
  assert.equal(result.authorityBasis.provider, 'telegram');
  assert.equal(result.authorityBasis.source, 'owner_messaging_gst_filing_confirmation');
});

test('a missing CorpPass grant fails the leg CLOSED: row pending, ask open, owner told what to fix', async () => {
  const { state, deps } = harness({ withMandate: false });
  const result = await resolveGstReturnInbound({ ...deps, replyText: 'yes' });
  assert.equal(result.action, 'file_failed');
  assert.equal(result.error, 'SG_FILING_CORPPASS_REQUIRED');
  assert.equal(state.filed.length, 0, 'nothing marked filed');
  assert.equal(state.resolved.length, 0, 'the ask stays open — still on the owner');
  assert.match(state.sent[0], /CorpPass/);
  assert.match(state.sent[0], /reply "yes" again/);
});

test('an IRAS rejection carries the channel reason verbatim; the ask stays open for the retry', async () => {
  const { state, deps } = harness();
  deps.submitReturn = async () => {
    const error = new Error('IRAS rejected the GST F5: period already filed');
    error.code = 'GST_FILING_REJECTED';
    error.channelReason = 'period already filed';
    throw error;
  };
  const result = await resolveGstReturnInbound({ ...deps, replyText: 'yes' });
  assert.equal(result.action, 'file_failed');
  assert.match(state.sent[0], /period already filed/);
  assert.equal(state.resolved.length, 0);
});

test('"no" cancels with the owner receipt and resolves the ask', async () => {
  const { state, deps } = harness();
  const result = await resolveGstReturnInbound({ ...deps, replyText: 'no' });
  assert.equal(result.action, 'cancelled');
  assert.deepEqual(state.cancelled, [{ gstReturnId: 'gst-return-1', reason: 'owner_declined' }]);
  assert.deepEqual(state.resolved, [{ askId: 'ask-1', resolutionNote: 'gst_return_cancelled' }]);
  assert.match(state.sent[0], /cancelled/);
});

test('anything else nudges — a statutory filing takes only an explicit answer', async () => {
  const { state, deps } = harness();
  const result = await resolveGstReturnInbound({ ...deps, replyText: 'looks about right I think' });
  assert.equal(result.action, 'nudge');
  assert.match(state.sent[0], /Reply "yes"/);
  assert.equal(state.resolved.length, 0);
});

test('a stale ask (row already filed/cancelled) resolves itself and tells the owner', async () => {
  const { state, deps } = harness({ row: pendingRow({ status: 'filed' }) });
  const result = await resolveGstReturnInbound({ ...deps, replyText: 'yes' });
  assert.equal(result.action, 'stale');
  assert.deepEqual(state.resolved, [{ askId: 'ask-1', resolutionNote: 'gst_return_stale_ask' }]);
  assert.match(state.sent[0], /already been handled/);
});

test('the flag gate: flag off → skipped, nothing sent, nothing touched', async () => {
  const { state, deps } = harness();
  const result = await resolveGstReturnInbound({ ...deps, flagActs: false, replyText: 'yes' });
  assert.deepEqual(result, { action: 'skipped', reason: 'flag_off' });
  assert.equal(state.sent.length, 0);
});

test('a "yes" without the full authority receipt (message id / phone hash / actor) throws typed', async () => {
  const { deps } = harness();
  await assert.rejects(
    resolveGstReturnInbound({ ...deps, replyText: 'yes', message: {}, phoneHash: null }),
    (e) => e.code === 'GST_FILING_AUTHORITY_REQUIRED'
  );
});

test('buildGstFilingAuthorityBasis stamps the provider and message receipt', () => {
  const basis = buildGstFilingAuthorityBasis({ message, phoneHash: 'h', provider: 'whatsapp' });
  assert.equal(basis.provider, 'whatsapp');
  assert.equal(basis.providerMessageId, 'msg-1');
  assert.equal(basis.phoneHash, 'h');
  assert.equal(buildGstFilingAuthorityBasis({}).provider, 'messaging');
});
