import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTIVE_ASK_STATUSES,
  isActiveAskStatus,
  normalizeBlockerCode,
  DEFAULT_BLOCKER_CODE,
  buildDocumentCaseKey,
  buildCanonicalAnchor,
  askAffordances,
  renderAskAffordanceTail
} from './askIdentity.js';
import { planMerges } from '../../scripts/merge_duplicate_evidence_requests.js';

// ── active statuses ─────────────────────────────────────────────────────────

test('only live statuses occupy an anchor; terminal history may repeat', () => {
  assert.deepEqual(ACTIVE_ASK_STATUSES, ['draft', 'open', 'replied']);
  for (const s of ['draft', 'open', 'replied']) assert.equal(isActiveAskStatus(s), true);
  for (const s of ['resolved', 'cancelled', '', null]) assert.equal(isActiveAskStatus(s), false);
});

// ── blocker code ────────────────────────────────────────────────────────────

test('the blocker code is stable and normalised, never the question wording', () => {
  assert.equal(normalizeBlockerCode('business_purpose'), 'business_purpose');
  assert.equal(normalizeBlockerCode('Business Purpose'), 'business_purpose');
  assert.equal(normalizeBlockerCode('  bank-statement '), 'bank_statement');
  assert.equal(normalizeBlockerCode(''), DEFAULT_BLOCKER_CODE);
  assert.equal(normalizeBlockerCode(null), DEFAULT_BLOCKER_CODE);
});

test('one receipt blocked on two DIFFERENT things stays two asks', () => {
  assert.notEqual(normalizeBlockerCode('business_purpose'), normalizeBlockerCode('bank_statement'));
});

// ── the case key ────────────────────────────────────────────────────────────

test('the same receipt re-photographed yields the SAME case key', () => {
  const a = buildDocumentCaseKey({
    documentType: 'receipt', vendorName: 'KUILI BARBACOA',
    documentDate: '2026-07-28', totalAmount: 115.6, currency: 'EUR'
  });
  const b = buildDocumentCaseKey({
    documentType: 'Receipt', vendorName: '  kuili   barbacoa ',
    documentDate: '2026-07-28T00:00:00.000Z', totalAmount: '115.60', currency: 'eur'
  });
  assert.equal(a, b);
  assert.ok(a.includes('115.60'), 'money is normalised to 2dp');
});

test('different receipts do NOT collapse', () => {
  const base = { documentType: 'receipt', vendorName: 'KUILI BARBACOA', documentDate: '2026-07-28', currency: 'EUR' };
  assert.notEqual(
    buildDocumentCaseKey({ ...base, totalAmount: 115.6 }),
    buildDocumentCaseKey({ ...base, totalAmount: 118.0 })
  );
  assert.notEqual(
    buildDocumentCaseKey({ ...base, totalAmount: 115.6 }),
    buildDocumentCaseKey({ ...base, vendorName: 'CAFE BAR MAGIA', totalAmount: 115.6 })
  );
});

// Losing an owner question is worse than asking twice, so thin extraction must
// NOT produce a key that could collapse two unrelated receipts.
test('thin extraction yields no case key at all, so it fails towards asking', () => {
  assert.equal(buildDocumentCaseKey({ documentType: 'receipt', totalAmount: 115.6 }), '', 'no party');
  assert.equal(buildDocumentCaseKey({ documentType: 'receipt', vendorName: 'KUILI' }), '', 'no total');
  assert.equal(buildDocumentCaseKey({}), '');
});

test('the counterparty name stands in when there is no vendor name', () => {
  const key = buildDocumentCaseKey({ vendorName: '', counterpartyName: 'Kuili Barbacoa', totalAmount: 10 });
  assert.ok(key.includes('kuili barbacoa'));
});

// ── the anchor ──────────────────────────────────────────────────────────────

test('anchor precedence is strongest evidence first', () => {
  assert.equal(
    buildCanonicalAnchor({ transactionId: 'tx-1', reviewItemId: 'ri-1', canonicalDocumentId: 'doc-1', caseKey: 'k' }),
    'transaction:tx-1'
  );
  assert.equal(buildCanonicalAnchor({ reviewItemId: 'ri-1', canonicalDocumentId: 'doc-1' }), 'review_item:ri-1');
  assert.equal(buildCanonicalAnchor({ canonicalDocumentId: 'doc-1', caseKey: 'k' }), 'document:doc-1');
  assert.equal(buildCanonicalAnchor({ caseKey: 'receipt|kuili|2026-07-28|115.60|eur' }), 'case:receipt|kuili|2026-07-28|115.60|eur');
  assert.equal(buildCanonicalAnchor({}), '');
});

// This is the KUILI bug in one assertion: two uploads, two document ids, ONE
// canonical document, therefore one anchor.
test('two uploads of one receipt collapse onto one anchor via the canonical document', () => {
  const upload1 = buildCanonicalAnchor({ canonicalDocumentId: 'msg_doc_tg_1001' });
  const upload2 = buildCanonicalAnchor({ canonicalDocumentId: 'msg_doc_tg_1001' }); // dup resolved to the canonical
  assert.equal(upload1, upload2);
  // …and would NOT have collapsed under the old per-upload rule:
  assert.notEqual(
    buildCanonicalAnchor({ canonicalDocumentId: 'msg_doc_tg_1001' }),
    buildCanonicalAnchor({ canonicalDocumentId: 'msg_doc_tg_2002' })
  );
});

// ── reply affordances ───────────────────────────────────────────────────────

test('a document-anchored ask never solicits the photo Donna already holds', () => {
  const aff = askAffordances({ anchor: 'document:doc-1', evidenceType: 'business_purpose' });
  assert.equal(aff.photo, false);
  assert.equal(aff.words, true);
  const tail = renderAskAffordanceTail(aff);
  assert.ok(!/photo/i.test(tail), `tail still asks for a photo: ${tail}`);
  assert.match(tail, /just reply in words/);
});

test('a case-anchored ask behaves the same as a document-anchored one', () => {
  assert.equal(askAffordances({ anchor: 'case:receipt|kuili|x', evidenceType: 'business_purpose' }).photo, false);
});

test('a transaction-anchored ask still asks for a photo, because Donna has nothing', () => {
  const aff = askAffordances({ anchor: 'transaction:tx-1', evidenceType: 'business_purpose' });
  assert.equal(aff.photo, true);
  assert.match(renderAskAffordanceTail(aff), /reply with a photo/);
});

// The one document-shaped ask that genuinely wants a file.
test('a bank-statement ask still wants a document even when doc-anchored', () => {
  assert.equal(askAffordances({ anchor: 'document:doc-1', evidenceType: 'bank_statement' }).photo, true);
});

test('an unknown anchor defaults to asking for a photo, never to silently dropping it', () => {
  assert.equal(askAffordances({ anchor: '', evidenceType: 'business_purpose' }).photo, true);
  assert.equal(askAffordances({}).photo, true);
});

test('the affordance tail carries no em or en dash', () => {
  for (const anchor of ['document:d', 'transaction:t', '']) {
    const tail = renderAskAffordanceTail(askAffordances({ anchor, evidenceType: 'business_purpose' }));
    assert.ok(!tail.includes('—') && !tail.includes('–'), `dash in: ${tail}`);
  }
});

// ── the merge plan ──────────────────────────────────────────────────────────

const askRow = (over = {}) => ({
  id: 'evidence-request-f-c-aaaaaa', firm_id: 'f', client_id: 'c',
  canonical_anchor: 'document:doc-1', blocker_code: 'business_purpose', generation: 0,
  status: 'open', created_at: '2026-07-29T10:02:30Z', question: 'What was this for?', ...over
});

test('the OLDEST active ask survives, because its Ref is the one the owner saw first', () => {
  const plans = planMerges([
    askRow({ id: 'ask-new', created_at: '2026-07-29T11:20:11Z' }),
    askRow({ id: 'ask-old', created_at: '2026-07-29T10:02:30Z' })
  ]);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].survivor.id, 'ask-old');
  assert.deepEqual(plans[0].losers.map((l) => l.id), ['ask-new']);
});

test('a single ask on an anchor is not a merge candidate', () => {
  assert.equal(planMerges([askRow()]).length, 0);
});

test('different blocker codes on one document are NOT merged', () => {
  const plans = planMerges([
    askRow({ id: 'a1', blocker_code: 'business_purpose' }),
    askRow({ id: 'a2', blocker_code: 'bank_statement' })
  ]);
  assert.equal(plans.length, 0, 'two distinct blockers are two legitimate asks');
});

test('different generations are NOT merged, so a legitimate re-ask survives', () => {
  const plans = planMerges([
    askRow({ id: 'a1', generation: 0 }),
    askRow({ id: 'a2', generation: 1 })
  ]);
  assert.equal(plans.length, 0);
});

test('resolved rows are never merge candidates, and rows with no anchor are skipped', () => {
  assert.equal(planMerges([askRow({ id: 'a1' }), askRow({ id: 'a2', status: 'resolved' })]).length, 0);
  assert.equal(planMerges([askRow({ id: 'a1', canonical_anchor: null }), askRow({ id: 'a2', canonical_anchor: null })]).length, 0);
});

test('three duplicates collapse to one survivor and two losers', () => {
  const plans = planMerges([
    askRow({ id: 'a', created_at: '2026-07-29T10:00:00Z' }),
    askRow({ id: 'b', created_at: '2026-07-29T11:00:00Z' }),
    askRow({ id: 'c', created_at: '2026-07-29T12:00:00Z' })
  ]);
  assert.equal(plans[0].survivor.id, 'a');
  assert.equal(plans[0].losers.length, 2);
});
