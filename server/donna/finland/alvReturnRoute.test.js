// FI-3 slice P — the ALV filing owner route: kyllä → file with receipt + the
// answered ask resolves; ei → cancel; ambiguous → nudge (ask stays open); a
// failed filing leg leaves the row pending and the ask OPEN (still on the
// owner). Pure, I/O-injected — a tiny in-memory store drives the REAL
// transitions (Lesson C), no DB/WhatsApp/channel.
// node --test server/donna/finland/alvReturnRoute.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALV_RETURN_ASK_KIND,
  alvReturnConfirmQuestion,
  buildAlvFilingAuthorityBasis,
  isAlvReturnAsk,
  resolveAlvReturnInbound,
  summarizeAlvReturnVerdict
} from './alvReturnRoute.js';
import { SUOMIFI_MANDATE_SCOPE_TAX } from './suomifiMandate.js';

const footedVerdict = ({ payable = 102, nil = false } = {}) => ({
  alvReturn: {
    boxes: nil ? { 308: 0 } : { 301: 127.5, 307: 25.5, 308: payable },
    payable: nil ? 0 : payable,
    refund: payable < 0,
    nilReturn: nil,
    selfAssessedFullyDeductible: true
  },
  review: { status: 'ready', blockers: [] }
});

// A tiny in-memory lifecycle store: the route's impls drive REAL state, so the
// tests assert end state (row status + open asks), not just return values.
const makeStore = () => {
  const row = {
    id: 'alv-1',
    status: 'draft_pending_confirmation',
    period_key: '2026-06',
    period_type: 'month',
    starts_on: '2026-06-01',
    ends_on: '2026-06-30',
    verdict: footedVerdict(),
    model: null
  };
  const openAsks = new Map([['ask-1', { id: 'ask-1', kind: ALV_RETURN_ASK_KIND }]]);
  const sent = [];
  // G-3: a valid Suomi.fi mandate by default — the transmit gate refuses
  // without one, so the store carries it; tests null it out to probe the gate.
  const store = {
    row,
    openAsks,
    sent,
    mandate: {
      id: 'suomifi-mandate-1',
      scope: SUOMIFI_MANDATE_SCOPE_TAX,
      status: 'active',
      granted_on: '2026-01-15',
      expires_on: null
    }
  };
  store.overlapping = [];
  store.deps = {
      // The overlap check before transmit: refuses while store.overlapping is non-empty.
      assertFileableImpl: async ({ alvReturnId }) => {
        assert.equal(alvReturnId, row.id);
        if (store.overlapping.length) {
          throw Object.assign(new Error('overlap'), { code: 'ALV_RETURN_FILING_OVERLAP', statusCode: 409, details: { overlapping: store.overlapping } });
        }
        return { ...row };
      },
      getMandateImpl: async ({ scope }) => (scope === SUOMIFI_MANDATE_SCOPE_TAX ? store.mandate : null),
      getAlvReturnImpl: async ({ alvReturnId }) => (alvReturnId === row.id ? { ...row } : null),
      markFiledImpl: async ({ alvReturnId, filingReceipt, authorityBasis, actorId }) => {
        assert.equal(alvReturnId, row.id);
        if (!authorityBasis?.source) throw Object.assign(new Error('no authority'), { code: 'ALV_RETURN_AUTHORITY_REQUIRED' });
        if (row.status !== 'draft_pending_confirmation') throw Object.assign(new Error('not pending'), { code: 'ALV_RETURN_NOT_PENDING' });
        Object.assign(row, { status: 'filed', filing_receipt: filingReceipt, authority_basis: authorityBasis, filed_by: actorId });
        return { ...row };
      },
      cancelImpl: async ({ alvReturnId, reason, authorityBasis }) => {
        assert.equal(alvReturnId, row.id);
        Object.assign(row, { status: 'cancelled', cancel_reason: reason, authority_basis: authorityBasis });
        return { ...row };
      },
      resolveAsk: async ({ askId, resolutionNote }) => {
        openAsks.delete(askId);
        openAsks.lastResolution = resolutionNote;
      },
      sendText: async ({ text }) => sent.push(text)
  };
  return store;
};

const ask = { id: 'ask-1', evidence_type: ALV_RETURN_ASK_KIND, request_payload: { kind: ALV_RETURN_ASK_KIND, alv_return: { phase: 'confirm_request', alv_return_id: 'alv-1', period_key: '2026-06' } } };
const message = { id: 'wamid.reply-1', timestamp: '2026-07-12T09:00:00Z' };

test('isAlvReturnAsk keys off kind / evidence_type / payload', () => {
  assert.equal(isAlvReturnAsk(ask), true);
  assert.equal(isAlvReturnAsk({ request_payload: { alv_return: {} } }), true);
  assert.equal(isAlvReturnAsk({ evidence_type: 'invoice_issuance' }), false);
  assert.equal(isAlvReturnAsk(null), false);
});

test('the confirm summary renders the PERSISTED verdict — payable, refund, and nil variants', () => {
  assert.match(summarizeAlvReturnVerdict({ periodKey: '2026-06', verdict: footedVerdict() }), /Maksettava vero 102,00 €/);
  assert.match(summarizeAlvReturnVerdict({ periodKey: '2026-06', verdict: footedVerdict({ payable: -50 }) }), /Palautukseen oikeuttava vero 50,00 €/);
  assert.match(summarizeAlvReturnVerdict({ periodKey: '2026-06', verdict: footedVerdict({ nil: true }) }), /nollailmoitus/);
  assert.match(alvReturnConfirmQuestion({ periodKey: '2026-06', verdict: footedVerdict() }), /Vahvista vastaamalla/);
});

test('kyllä files: transmit → filed-with-receipt → the ANSWERED ask resolves (two-terminal E2E)', async () => {
  const store = makeStore();
  const result = await resolveAlvReturnInbound({
    firmId: 'firm-1',
    clientId: 'client-1',
    ask,
    replyText: 'kyllä',
    message,
    phoneHash: 'ph-1',
    actorId: 'owner-1',
    flagActs: true,
    submitReturn: async () => ({ channel: 'omavero_test', submission_id: 'SUB-9' }),
    ...store.deps
  });
  assert.equal(result.action, 'confirm_and_file');
  // The row reached the receipted terminal…
  assert.equal(store.row.status, 'filed');
  assert.equal(store.row.filing_receipt.submission_id, 'SUB-9');
  assert.equal(store.row.filing_receipt.authority_basis.providerMessageId, 'wamid.reply-1');
  assert.equal(store.row.filing_receipt.mandate.id, 'suomifi-mandate-1', 'the mandate rides the receipt (G-3)');
  assert.equal(store.row.filed_by, 'owner-1');
  // …and the answered ask is RESOLVED — nothing rests open on a filed return.
  assert.equal(store.openAsks.size, 0, 'exactly zero open alv_return asks after filing');
  assert.equal(store.openAsks.lastResolution, 'alv_return_filed');
  assert.match(store.sent.at(-1), /lähetetty Verohallinnolle/);
});

test('a failed filing leg leaves the row PENDING and the ask OPEN — the next kyllä retries', async () => {
  const store = makeStore();
  const result = await resolveAlvReturnInbound({
    firmId: 'firm-1',
    clientId: 'client-1',
    ask,
    replyText: 'kyllä',
    message,
    phoneHash: 'ph-1',
    actorId: 'owner-1',
    flagActs: true,
    // No submitReturn injected: the transmit seam refuses (ALV_FILING_NO_CHANNEL
    // — FI-8 not wired) and that refusal must surface as a retryable failure.
    ...store.deps
  });
  assert.equal(result.action, 'file_failed');
  assert.equal(result.error, 'ALV_FILING_NO_CHANNEL');
  assert.equal(store.row.status, 'draft_pending_confirmation', 'no false filing');
  assert.equal(store.openAsks.size, 1, 'the ask stays open — still on the owner');
  assert.match(store.sent.at(-1), /ei onnistunut/);
});

test('G-3: kyllä without a valid Suomi.fi mandate refuses — row pending, ask open, owner told to grant the valtuutus', async () => {
  const store = makeStore();
  store.mandate = null; // nothing recorded for this client
  const result = await resolveAlvReturnInbound({
    firmId: 'firm-1',
    clientId: 'client-1',
    ask,
    replyText: 'kyllä',
    message,
    phoneHash: 'ph-1',
    actorId: 'owner-1',
    flagActs: true,
    submitReturn: async () => { throw new Error('must never reach the channel without a mandate'); },
    ...store.deps
  });
  assert.equal(result.action, 'file_failed');
  assert.equal(result.error, 'ALV_FILING_MANDATE_REQUIRED');
  assert.equal(store.row.status, 'draft_pending_confirmation', 'no false filing');
  assert.equal(store.openAsks.size, 1, 'the ask stays open — granting the mandate is an OWNER action');
  assert.match(store.sent.at(-1), /Suomi\.fi-valtuutus/);
  assert.match(store.sent.at(-1), /veroasioiden hoito/);
});

test('ei cancels with the owner receipt and resolves the answered ask', async () => {
  const store = makeStore();
  const result = await resolveAlvReturnInbound({
    firmId: 'firm-1', clientId: 'client-1', ask, replyText: 'ei', message,
    phoneHash: 'ph-1', actorId: 'owner-1', flagActs: true, ...store.deps
  });
  assert.equal(result.action, 'cancelled');
  assert.equal(store.row.status, 'cancelled');
  assert.equal(store.row.authority_basis.providerMessageId, 'wamid.reply-1');
  assert.equal(store.openAsks.size, 0);
  assert.equal(store.openAsks.lastResolution, 'alv_return_cancelled');
});

test('an ambiguous reply nudges and leaves the ask open — a statutory filing takes only an explicit answer', async () => {
  const store = makeStore();
  const result = await resolveAlvReturnInbound({
    firmId: 'firm-1', clientId: 'client-1', ask, replyText: 'ehkä huomenna?', message,
    phoneHash: 'ph-1', actorId: 'owner-1', flagActs: true, ...store.deps
  });
  assert.equal(result.action, 'nudge');
  assert.equal(store.row.status, 'draft_pending_confirmation');
  assert.equal(store.openAsks.size, 1);
});

test('a stale ask (row already terminal) resolves itself instead of resting open', async () => {
  const store = makeStore();
  store.row.status = 'filed';
  const result = await resolveAlvReturnInbound({
    firmId: 'firm-1', clientId: 'client-1', ask, replyText: 'kyllä', message,
    phoneHash: 'ph-1', actorId: 'owner-1', flagActs: true, ...store.deps
  });
  assert.equal(result.action, 'stale');
  assert.equal(store.openAsks.size, 0);
  assert.equal(store.openAsks.lastResolution, 'alv_return_stale_ask');
});

test('kyllä without a provider message id / phone hash / actor throws — the authority basis is not optional', async () => {
  const store = makeStore();
  await assert.rejects(
    resolveAlvReturnInbound({
      firmId: 'firm-1', clientId: 'client-1', ask, replyText: 'kyllä', message: {},
      phoneHash: null, actorId: 'owner-1', flagActs: true, ...store.deps
    }),
    (e) => e.code === 'ALV_FILING_AUTHORITY_REQUIRED'
  );
  assert.equal(store.row.status, 'draft_pending_confirmation');
});

test('flag off → skipped; the basis builder stamps the owner-confirmation source', async () => {
  const store = makeStore();
  const result = await resolveAlvReturnInbound({ ask, replyText: 'kyllä', flagActs: false, ...store.deps });
  assert.deepEqual(result, { action: 'skipped', reason: 'flag_off' });
  const basis = buildAlvFilingAuthorityBasis({ message, phoneHash: 'ph-1' });
  assert.equal(basis.source, 'owner_whatsapp_alv_filing_confirmation');
  assert.equal(basis.providerMessageId, 'wamid.reply-1');
  assert.equal(basis.phoneHash, 'ph-1');
});

// ── The owner's language on the ALV lane ─────────────────────────────────────
// A Finnish company whose owner chose English read every line of this lane in
// Finnish. The language is the one resolver's (passed in); absent ⇒ Finnish.
test('ALV lane: a Finnish company whose owner chose English reads the confirm question and every reply in English', async () => {
  assert.equal(alvReturnConfirmQuestion({ periodKey: '2026-06', verdict: footedVerdict(), language: 'en' }),
    'VAT return, tax period 2026-06\nVAT payable 102.00 €.\nVAT on sales 127.50 € · Deductible VAT 25.50 €.\n\n'
    + 'Reply “yes” to confirm and I will file the return with the Finnish Tax Administration. Reply “no” to cancel.');
  assert.equal(summarizeAlvReturnVerdict({ periodKey: '2026-06', verdict: footedVerdict({ payable: -50 }), language: 'en' }).split('\n')[1], 'VAT to be refunded 50.00 €.');
  assert.equal(summarizeAlvReturnVerdict({ periodKey: '2026-06', verdict: footedVerdict({ nil: true }), language: 'en' }),
    'VAT return, tax period 2026-06\nNo VAT activity in the period, so this is a nil return.');

  const run = async (store, replyText, extra = {}) => resolveAlvReturnInbound({
    firmId: 'firm-1', clientId: 'client-1', ask, replyText, message, phoneHash: 'ph-1', actorId: 'owner-1', flagActs: true,
    language: 'en', ...store.deps, ...extra
  });
  // The invited words are ones the route reads: "yes" files, "no" cancels.
  const filed = makeStore();
  assert.equal((await run(filed, 'yes', { submitReturn: async () => ({ channel: 'omavero_test', submission_id: 'SUB-1' }) })).action, 'confirm_and_file');
  assert.deepEqual(filed.sent, ['VAT return (2026-06) filed with the Finnish Tax Administration. 102.00 € to pay. The payment instructions are in OmaVero.']);
  const cancelled = makeStore();
  assert.equal((await run(cancelled, 'no')).action, 'cancelled');
  assert.deepEqual(cancelled.sent, ["VAT return (2026-06) cancelled. Let's fix the books and I will calculate it again."]);
  const nudged = makeStore();
  await run(nudged, 'maybe later');
  assert.deepEqual(nudged.sent, ['Reply “yes” and I will file the VAT return with the Finnish Tax Administration, or “no” and I will cancel it.']);
  const failed = makeStore();
  await run(failed, 'yes');
  assert.deepEqual(failed.sent, ['Filing the VAT return did not go through. Reply “yes” and I will try again, or “no” and I will cancel the return.']);
  const noMandate = makeStore();
  noMandate.mandate = null;
  await run(noMandate, 'yes', { submitReturn: async () => ({ channel: 'omavero_test', submission_id: 'SUB-2' }) });
  assert.match(noMandate.sent[0], /^I can't file the VAT return yet: the Suomi\.fi authorisation/);
  const stale = makeStore();
  stale.row.status = 'filed';
  await run(stale, 'yes');
  assert.deepEqual(stale.sent, ['This VAT return has already been handled.']);
  for (const store of [filed, cancelled, nudged, failed, noMandate, stale]) {
    assert.doesNotMatch(store.sent.join(' '), /[äö]|Vastaa|ALV-ilmoitus/, 'no Finnish reaches the English owner');
  }

  // Absent a language the lane keeps its Finnish copy, unchanged.
  const fi = makeStore();
  await resolveAlvReturnInbound({ firmId: 'firm-1', clientId: 'client-1', ask, replyText: 'hmm', message, phoneHash: 'ph-1', actorId: 'owner-1', flagActs: true, ...fi.deps });
  assert.deepEqual(fi.sent, ['Vastaa “kyllä” niin lähetän ALV-ilmoituksen Verohallinnolle, tai “ei” niin perun sen.']);
});

test('kyllä over dates another live return covers: NOTHING is transmitted — row pending, ask open, owner told which return', async () => {
  const store = makeStore();
  store.overlapping = [{ id: 'alv-q2', period_key: '2026-Q2', starts_on: '2026-04-01', ends_on: '2026-06-30', status: 'filed' }];
  let transmitted = 0;
  const result = await resolveAlvReturnInbound({
    firmId: 'firm-1', clientId: 'client-1', ask, replyText: 'kyllä', message, phoneHash: 'ph-1', actorId: 'owner-1', flagActs: true,
    submitReturn: async () => { transmitted += 1; return { channel: 'omavero_test', submission_id: 'SUB-X' }; },
    ...store.deps
  });
  assert.equal(result.action, 'file_failed');
  assert.equal(result.error, 'ALV_RETURN_FILING_OVERLAP');
  assert.equal(transmitted, 0, 'the filing channel is never reached');
  assert.equal(store.row.status, 'draft_pending_confirmation');
  assert.equal(store.openAsks.size, 1, 'the ask stays open: the owner can answer "ei"');
  assert.match(store.sent.at(-1), /ALV-ilmoitusta \(2026-06\) ei lähetetty: ilmoitus 2026-Q2 \(lähetetty\) kattaa jo/);
  assert.match(store.sent.at(-1), /Lähetetty ilmoitus pysyy ennallaan/);

  // Both waiting: neither is sent until one is cancelled.
  store.overlapping = [{ id: 'alv-q2', period_key: '2026-Q2', status: 'draft_pending_confirmation' }];
  await resolveAlvReturnInbound({
    firmId: 'firm-1', clientId: 'client-1', ask, replyText: 'kyllä', message, phoneHash: 'ph-1', actorId: 'owner-1', flagActs: true,
    submitReturn: async () => { transmitted += 1; return {}; }, ...store.deps
  });
  assert.equal(transmitted, 0);
  assert.match(store.sent.at(-1), /2026-Q2 \(odottaa vahvistusta\).*Kumpaakaan ei lähetetä/);
});

test('kyllä with no overlap check wired is fail-closed: nothing is transmitted', async () => {
  const store = makeStore();
  let transmitted = 0;
  const { assertFileableImpl, ...unwired } = store.deps;
  assert.equal(typeof assertFileableImpl, 'function');
  const result = await resolveAlvReturnInbound({
    firmId: 'firm-1', clientId: 'client-1', ask, replyText: 'kyllä', message, phoneHash: 'ph-1', actorId: 'owner-1', flagActs: true,
    submitReturn: async () => { transmitted += 1; return {}; }, ...unwired
  });
  assert.equal(result.action, 'file_failed');
  assert.equal(result.error, 'ALV_FILING_OVERLAP_CHECK_REQUIRED');
  assert.equal(transmitted, 0);
  assert.equal(store.row.status, 'draft_pending_confirmation');
});

test('ALV overlap refusal: an owner who chose English reads it in English; nothing is transmitted', async () => {
  const store = makeStore();
  store.overlapping = [{ id: 'alv-q2', period_key: '2026-Q2', status: 'filed' }];
  let transmitted = 0;
  const run = () => resolveAlvReturnInbound({
    firmId: 'firm-1', clientId: 'client-1', ask, replyText: 'yes', message, phoneHash: 'ph-1', actorId: 'owner-1', flagActs: true,
    submitReturn: async () => { transmitted += 1; return {}; }, language: 'en', ...store.deps
  });
  assert.equal((await run()).error, 'ALV_RETURN_FILING_OVERLAP');
  assert.equal(store.sent.at(-1), "The VAT return (2026-06) was not filed: the return 2026-Q2 (filed) already covers some of the same days. "
    + "The same sales and purchases can't be reported twice. The filed return stays as it is. Reply “no” to cancel this return.");
  store.overlapping = [{ id: 'alv-q2', period_key: '2026-Q2', status: 'draft_pending_confirmation' }];
  await run();
  assert.equal(store.sent.at(-1), "The VAT return (2026-06) was not filed: the return 2026-Q2 (waiting for confirmation) already covers some of the same days. "
    + "The same sales and purchases can't be reported twice. Neither is filed until one of them is cancelled. Reply “no” to cancel this return.");
  assert.equal(transmitted, 0);
  assert.equal(store.openAsks.size, 1);
});
