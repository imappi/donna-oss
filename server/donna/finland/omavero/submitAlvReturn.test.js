// FI-8 — the Verohallinto filing adapter: pure VSRALVKV renderer (pin-tested —
// the fixture is the F-FI8-R1 re-confirmation surface), typed refusal matrix,
// per-(client, period) idempotency, and the seam integration through FI-3's
// transmitAlvReturnFiling. No DB, no network, no model call.
// node --test server/donna/finland/omavero/submitAlvReturn.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALV_FILING_CHANNEL,
  VSRALVKV_RECORD_PROVENANCE,
  VSRALVKV_STRUCTURAL_FIELDS,
  alvFilingReference,
  apitamoPkiTransportPendingConfirmation,
  createIlmoitinSubmitAlvReturn,
  formatVsralvkvAmount,
  renderVsralvkvRecord,
  resolveVeroFilingConfigFromEnv
} from './submitAlvReturn.js';
import { transmitAlvReturnFiling } from '../alvReturnTransmit.js';
import { resolveAlvReturnInbound, ALV_RETURN_ASK_KIND } from '../alvReturnRoute.js';
import { SUOMIFI_MANDATE_SCOPE_TAX } from '../suomifiMandate.js';

// G-3: the transmit seam refuses without a valid Suomi.fi mandate — the
// chain fixtures carry one so these tests probe the CHANNEL, not the gate.
const MANDATE = {
  id: 'suomifi-mandate-1',
  scope: SUOMIFI_MANDATE_SCOPE_TAX,
  status: 'active',
  granted_on: '2026-01-15',
  expires_on: null
};

// 1234567-1: body 1234567 → weighted sum 153, 153 % 11 = 10 → check 1. Valid.
const FILER = { businessId: '1234567-1', name: 'Testi Oy' };
const PERIOD = { key: '2026-06', type: 'month', starts_on: '2026-06-01', ends_on: '2026-06-30' };
const BOXES = { 301: 2550, 307: 550, 308: 2000 };
const TS = '10072026120000';

const render = (overrides = {}) => renderVsralvkvRecord({
  period: PERIOD, boxes: BOXES, payable: 2000, nilReturn: false, filer: FILER, timestamp: TS, ...overrides
});

// ---------------------------------------------------------------------------------
// Renderer — pin-tests (any silent edit to the record layout trips CI; F-FI8-R1
// re-confirms these exact bytes against the primary spec and flips the flag).
// ---------------------------------------------------------------------------------

test('FI-8 pin: the VSRALVKV record for a plain monthly return, byte for byte', () => {
  const result = render();
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.equal(result.record.text, [
    '000:VSRALVKV',
    '198:10072026120000',
    '014:Donna',
    '010:1234567-1',
    '050:K',
    '052:6',
    '053:2026',
    '301:2550,00',
    '307:550,00',
    '308:2000,00',
    '999:1'
  ].join('\n'));
  assert.equal(result.record.reference, 'VSRALVKV/1234567-1/2026-06');
});

test('FI-8 pin: a nollailmoitus reports the no-activity flag and NO money fields', () => {
  const result = render({ boxes: { 308: 0 }, payable: 0, nilReturn: true });
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.equal(result.record.text, [
    '000:VSRALVKV',
    '198:10072026120000',
    '014:Donna',
    '010:1234567-1',
    '050:K',
    '052:6',
    '053:2026',
    '056:1',
    '999:1'
  ].join('\n'));
});

test('FI-8 pin: the structural field map (the F-FI8-R1 re-confirmation surface)', () => {
  assert.deepEqual(VSRALVKV_STRUCTURAL_FIELDS, {
    recordId: '000',
    timestamp: '198',
    softwareId: '014',
    businessId: '010',
    periodType: '050',
    periodNumber: '052',
    periodYear: '053',
    noActivity: '056',
    end: '999'
  });
  // The provenance contract exists and is honest: the flag flips ONLY in the
  // F-FI8-R1 commit that re-confirms the fixture against the primary spec.
  assert.equal(typeof VSRALVKV_RECORD_PROVENANCE.confirmedAgainstPrimary, 'boolean');
  assert.match(VSRALVKV_RECORD_PROVENANCE.source, /F-FI8-R1/);
});

test('quarter and year periods render their kausi fields; refunds carry the minus sign', () => {
  const quarter = render({ period: { key: '2026-Q2', type: 'quarter' } });
  assert.equal(quarter.ok, true);
  assert.ok(quarter.record.lines.includes('050:Q') && quarter.record.lines.includes('052:2'));

  const year = render({ period: { key: '2026', type: 'year' } });
  assert.equal(year.ok, true);
  assert.ok(year.record.lines.includes('050:V') && year.record.lines.includes('052:1') && year.record.lines.includes('053:2026'));

  const refund = render({ boxes: { 307: 100, 308: -100 }, payable: -100 });
  assert.equal(refund.ok, true);
  assert.ok(refund.record.lines.includes('308:-100,00'));

  assert.equal(formatVsralvkvAmount(2000), '2000,00');
  assert.equal(formatVsralvkvAmount(-100.5), '-100,50');
  assert.equal(formatVsralvkvAmount(0), '0,00');
});

test('renderer refuses (never shades): bad Y-tunnus, misfoot, unknown box, bad period, bad timestamp', () => {
  assert.equal(render({ filer: { businessId: '1234567-2' } }).ok, false, 'wrong check digit');
  assert.equal(render({ filer: {} }).ok, false, 'missing Y-tunnus');
  const misfoot = render({ boxes: { 301: 2550, 307: 550, 308: 1999 }, payable: 1999 });
  assert.equal(misfoot.ok, false);
  assert.match(misfoot.errors.join(' '), /re-foot/);
  assert.equal(render({ boxes: { ...BOXES, 317: 5 } }).ok, false, '317 abolished — unknown box');
  assert.equal(render({ period: { key: '2026-13', type: 'month' } }).ok, false, 'month 13');
  assert.equal(render({ period: { key: '2026-06', type: 'week' } }).ok, false, 'unknown period type');
  assert.equal(render({ timestamp: 'not-a-timestamp' }).ok, false);
});

test('the idempotency reference is deterministic per (filer, period) — no timestamp in it', () => {
  assert.equal(alvFilingReference({ businessId: '1234567-1', periodKey: '2026-06' }), 'VSRALVKV/1234567-1/2026-06');
  assert.equal(render().record.reference, render({ timestamp: '11072026093000' }).record.reference);
});

// ---------------------------------------------------------------------------------
// Adapter — typed refusal matrix + the accepted path.
// ---------------------------------------------------------------------------------

const CONFIG = { endpoint: 'https://vero-test.example/apitamo', cert: 'CERT', certKey: 'KEY', softwareId: 'Donna' };
const makeAdapter = ({ config = CONFIG, filer = FILER, transport } = {}) => createIlmoitinSubmitAlvReturn({
  resolveConfig: () => config,
  resolveFiler: async ({ firmId, clientId }) => {
    assert.equal(firmId, 'firm-1');
    assert.equal(clientId, 'client-1');
    return filer;
  },
  transport,
  now: () => new Date('2026-07-10T12:00:00Z')
});
const CALL = { period: PERIOD, boxes: BOXES, payable: 2000, nilReturn: false, firmId: 'firm-1', clientId: 'client-1' };

test('accepted: the transport sees the rendered record + reference; the receipt fields come back untrimmed', async () => {
  const seen = [];
  const adapter = makeAdapter({
    transport: async ({ endpoint, record, reference, credentials, softwareId }) => {
      seen.push({ endpoint, reference, text: record.text, credentials, softwareId });
      return { status: 'accepted', submissionId: 'VH-2026-001', ack: { raw: 'ACK BYTES' } };
    }
  });
  const result = await adapter(CALL);
  assert.deepEqual(result, {
    channel: ALV_FILING_CHANNEL,
    submission_id: 'VH-2026-001',
    reference: 'VSRALVKV/1234567-1/2026-06',
    raw_ack: { raw: 'ACK BYTES' }
  });
  assert.equal(seen[0].endpoint, CONFIG.endpoint);
  assert.match(seen[0].text, /^000:VSRALVKV\n198:10072026120000\n/);
  assert.deepEqual(seen[0].credentials, { cert: 'CERT', certKey: 'KEY' });

  // Idempotency: a duplicate submit carries the IDENTICAL reference — the
  // channel's duplicate handling can recognise the retry.
  await adapter(CALL);
  assert.equal(seen[0].reference, seen[1].reference);
});

test('channel rejection → ALV_FILING_REJECTED with the reason VERBATIM (never a paraphrase)', async () => {
  const adapter = makeAdapter({
    transport: async () => ({ status: 'rejected', reason: 'Virhe kentässä 052: kausi jo ilmoitettu', ack: 'NACK' })
  });
  await assert.rejects(adapter(CALL), (e) => {
    assert.equal(e.code, 'ALV_FILING_REJECTED');
    assert.equal(e.channelReason, 'Virhe kentässä 052: kausi jo ilmoitettu');
    assert.equal(e.rawAck, 'NACK');
    return true;
  });
});

test('missing Y-tunnus → REJECTED before any transport; missing config / transport failure / garbage → UNAVAILABLE (retryable)', async () => {
  let transportCalls = 0;
  const countingTransport = async () => { transportCalls += 1; return { status: 'accepted', submissionId: 'X' }; };

  await assert.rejects(
    makeAdapter({ filer: { businessId: null }, transport: countingTransport })(CALL),
    (e) => e.code === 'ALV_FILING_REJECTED' && /Y-tunnus/.test(e.channelReason)
  );
  await assert.rejects(
    makeAdapter({ config: { ...CONFIG, cert: null }, transport: countingTransport })(CALL),
    (e) => e.code === 'ALV_FILING_CHANNEL_UNAVAILABLE'
  );
  assert.equal(transportCalls, 0, 'nothing reaches the wire on a refusal upstream of it');

  await assert.rejects(
    makeAdapter({ transport: async () => { throw new Error('ECONNRESET'); } })(CALL),
    (e) => e.code === 'ALV_FILING_CHANNEL_UNAVAILABLE' && /ECONNRESET/.test(e.message)
  );
  await assert.rejects(
    makeAdapter({ transport: async () => ({ status: 'accepted' }) })(CALL),
    (e) => e.code === 'ALV_FILING_CHANNEL_UNAVAILABLE',
    'accepted without a submission id is NOT a filing'
  );
});

test('the DEFAULT transport refuses, naming F-FI8-R1 — no statutory bytes on an unconfirmed protocol', async () => {
  await assert.rejects(apitamoPkiTransportPendingConfirmation(), (e) => {
    assert.equal(e.code, 'ALV_FILING_CHANNEL_UNAVAILABLE');
    assert.match(e.message, /F-FI8-R1/);
    return true;
  });
  // And the factory's defaults compose to the same retryable refusal.
  const adapter = createIlmoitinSubmitAlvReturn({
    resolveConfig: () => CONFIG,
    resolveFiler: async () => FILER
  });
  await assert.rejects(adapter(CALL), (e) => e.code === 'ALV_FILING_CHANNEL_UNAVAILABLE');
});

test('env config: endpoint knob + cert secrets + software id default (enablement is NOT here)', () => {
  assert.deepEqual(resolveVeroFilingConfigFromEnv({}), { endpoint: null, cert: null, certKey: null, softwareId: 'Donna' });
  assert.deepEqual(
    resolveVeroFilingConfigFromEnv({ VERO_FILING_ENDPOINT: ' https://e ', VERO_FILING_CERT: 'C', VERO_FILING_CERT_KEY: 'K', VERO_FILING_SOFTWARE_ID: 'Donna-Donna' }),
    { endpoint: 'https://e', cert: 'C', certKey: 'K', softwareId: 'Donna-Donna' }
  );
});

// ---------------------------------------------------------------------------------
// Seam integration — the adapter behind FI-3's transmit + the owner route.
// ---------------------------------------------------------------------------------

const VERDICT = {
  alvReturn: { boxes: { 301: 2550, 307: 550, 308: 2000 }, payable: 2000, nilReturn: false },
  review: { status: 'ready', blockers: [] }
};

test('through transmitAlvReturnFiling: the receipt carries the channel, submission id, and raw ack', async () => {
  const adapter = makeAdapter({
    transport: async () => ({ status: 'accepted', submissionId: 'VH-2026-777', ack: 'RAW' })
  });
  const { receipt } = await transmitAlvReturnFiling({
    verdict: VERDICT,
    period: PERIOD,
    authorityBasis: { source: 'owner_whatsapp_alv_filing_confirmation' },
    actorId: 'owner-1',
    mandate: MANDATE,
    // The inboundCore wiring binds client identity into the seam call.
    submitReturn: (payload) => adapter({ ...payload, firmId: 'firm-1', clientId: 'client-1' })
  });
  assert.equal(receipt.channel, ALV_FILING_CHANNEL);
  assert.equal(receipt.submission_id, 'VH-2026-777');
  assert.equal(receipt.provider_result.raw_ack, 'RAW');
  assert.equal(receipt.provider_result.reference, 'VSRALVKV/1234567-1/2026-06');
});

test('a channel REJECTION surfaces its reason verbatim in the owner text; the row stays pending, the ask open', async () => {
  const row = {
    id: 'alv-1', status: 'draft_pending_confirmation', period_key: '2026-06', period_type: 'month',
    starts_on: '2026-06-01', ends_on: '2026-06-30', verdict: VERDICT, model: null
  };
  const sent = [];
  const openAsks = new Set(['ask-1']);
  const adapter = makeAdapter({
    transport: async () => ({ status: 'rejected', reason: 'Virheellinen kausi' })
  });
  const result = await resolveAlvReturnInbound({
    firmId: 'firm-1',
    clientId: 'client-1',
    ask: { id: 'ask-1', evidence_type: ALV_RETURN_ASK_KIND, request_payload: { kind: ALV_RETURN_ASK_KIND, alv_return: { alv_return_id: 'alv-1' } } },
    replyText: 'kyllä',
    message: { id: 'wamid.r1', timestamp: '2026-07-12T09:00:00Z' },
    phoneHash: 'ph-1',
    actorId: 'owner-1',
    flagActs: true,
    getAlvReturnImpl: async () => ({ ...row }),
    getMandateImpl: async () => MANDATE,
    markFiledImpl: async () => { throw new Error('must not mark filed on a rejection'); },
    cancelImpl: async () => { throw new Error('must not cancel'); },
    submitReturn: (payload) => adapter({ ...payload, firmId: 'firm-1', clientId: 'client-1' }),
    resolveAsk: async ({ askId }) => openAsks.delete(askId),
    sendText: async ({ text }) => sent.push(text)
  });
  assert.equal(result.action, 'file_failed');
  assert.equal(result.error, 'ALV_FILING_REJECTED');
  assert.match(sent.at(-1), /Virheellinen kausi/, 'the channel reason reaches the owner verbatim');
  assert.match(sent.at(-1), /yritän uudelleen/, 'and the retry instruction stays');
  assert.equal(openAsks.size, 1, 'the ask stays open — still on the owner');
});
