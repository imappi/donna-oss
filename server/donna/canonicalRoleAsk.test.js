import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCanonicalRoleAsk,
  buildCanonicalRoleAsks,
  ownerPhraseForRole,
  CANONICAL_ROLE_BLOCKER_CODES
} from './canonicalRoleAsk.js';
import { planCanonicalRoleResolution } from './canonicalRoleResolution.js';
import { buildCanonicalAnchor, askAffordances, renderAskAffordanceTail } from './askIdentity.js';

const GB_CHART = [
  { id: 'a-2220', code: '2220', name: 'VAT control', account_type: 'liability', normal_balance: 'credit', canonical_role: null },
  { id: 'a-2230', code: '2230', name: 'Corporation tax payable', account_type: 'liability', normal_balance: 'credit', canonical_role: null },
  { id: 'a-4000', code: '4000', name: 'Sales', account_type: 'revenue', normal_balance: 'credit', canonical_role: null }
];

// The voice rule (Kari, 2026-07-21). Applied to every owner-facing string this
// module emits, because a dash is the failure mode that keeps coming back.
const assertVoice = (text) => {
  assert.ok(!/[—–]/.test(text), `owner-facing copy must not contain an em or en dash: ${text}`);
};

await test('the role anchor is a first-class anchor kind and never collides with an artifact', () => {
  assert.equal(buildCanonicalAnchor({ accountRole: 'liability.sales_tax_payable' }), 'account_role:liability.sales_tax_payable');
  // A real artifact is always the firmer anchor.
  assert.equal(
    buildCanonicalAnchor({ transactionId: 'txn-1', accountRole: 'liability.sales_tax_payable' }),
    'transaction:txn-1'
  );
  assert.equal(
    buildCanonicalAnchor({ canonicalDocumentId: 'doc-1', accountRole: 'liability.sales_tax_payable' }),
    'document:doc-1'
  );
  assert.equal(buildCanonicalAnchor({}), '');
});

await test('a role-anchored ask never solicits a photo — Donna is holding the chart', () => {
  const affordances = askAffordances({
    anchor: 'account_role:liability.sales_tax_payable',
    evidenceType: 'account_role_ambiguous'
  });
  assert.equal(affordances.photo, false);
  assert.equal(affordances.words, true);
  assert.equal(affordances.not_sure, true);
  const tail = renderAskAffordanceTail(affordances);
  assert.ok(!/photo/.test(tail), tail);
  assertVoice(tail);
});

await test('a bank-statement ask still wants its file — the role branch did not widen', () => {
  assert.equal(askAffordances({ anchor: 'transaction:t1', evidenceType: 'bank_statement' }).photo, true);
  assert.equal(askAffordances({ anchor: 'document:d1', evidenceType: 'bank_statement' }).photo, true);
  assert.equal(askAffordances({ anchor: 'document:d1', evidenceType: 'business_purpose' }).photo, false);
  assert.equal(askAffordances({ anchor: 'transaction:t1', evidenceType: 'business_purpose' }).photo, true);
});

await test('a contended role asks the owner to choose, and admits Donna cannot tell', () => {
  const plan = planCanonicalRoleResolution({
    accounts: GB_CHART,
    proposals: [
      { account_id: 'a-2220', role: 'liability.sales_tax_payable', confidence: 0.9 },
      { account_id: 'a-2230', role: 'liability.sales_tax_payable', confidence: 0.9 }
    ]
  });
  const built = buildCanonicalRoleAsks({ plan });
  assert.equal(built.length, 1);
  const ask = built[0];
  assert.equal(ask.anchor, 'account_role:liability.sales_tax_payable');
  assert.equal(ask.blocker_code, 'account_role_ambiguous');
  assert.equal(ask.evidence_type, 'account_role_ambiguous');
  assert.match(ask.question, /VAT or sales tax account/);
  assert.match(ask.question, /2220 VAT control/);
  assert.match(ask.question, /2230 Corporation tax payable/);
  assert.match(ask.question, /I cannot tell which is which/);
  assert.match(ask.question, /do not want to guess on tax/);
  assertVoice(ask.question);
  assert.equal(ask.request_payload.canonical_role, 'liability.sales_tax_payable');
  assert.deepEqual(ask.request_payload.candidates.map((c) => c.code), ['2220', '2230']);
});

await test('contending against a STANDING assignment says so, rather than pretending it is a clean slate', () => {
  const plan = planCanonicalRoleResolution({
    accounts: [
      { id: 'held', code: '2220', name: 'VAT control', account_type: 'liability', normal_balance: 'credit', canonical_role: 'liability.sales_tax_payable' },
      { id: 'new', code: '2225', name: 'VAT suspense', account_type: 'liability', normal_balance: 'credit', canonical_role: null }
    ],
    proposals: [{ account_id: 'new', role: 'liability.sales_tax_payable', confidence: 0.99 }]
  });
  const [ask] = buildCanonicalRoleAsks({ plan });
  assert.match(ask.question, /I already have one account set as your VAT or sales tax account/);
  assert.match(ask.question, /2225 VAT suspense/);
  assert.equal(ask.request_payload.held_count, 1);
  assertVoice(ask.question);
});

await test('a required role with candidates offers the menu the Keep layer would accept', () => {
  const plan = planCanonicalRoleResolution({
    accounts: GB_CHART,
    requiredRoles: ['liability.sales_tax_payable']
  });
  const [ask] = buildCanonicalRoleAsks({ plan });
  assert.equal(ask.blocker_code, 'account_role_missing');
  assert.match(ask.question, /I need to know which account is your VAT or sales tax account/);
  assert.match(ask.question, /2220 VAT control, or 2230 Corporation tax payable/);
  assert.match(ask.question, /tell me if it is not one of these/);
  // The revenue account is not offered: it could not legally carry the role.
  assert.ok(!/4000 Sales/.test(ask.question), ask.question);
  assertVoice(ask.question);
});

await test('a required role with NO legal candidate asks whether to add one, not to pick one', () => {
  const plan = planCanonicalRoleResolution({
    accounts: [{ id: 'r', code: '4000', name: 'Sales', account_type: 'revenue', normal_balance: 'credit', canonical_role: null }],
    requiredRoles: ['liability.sales_tax_payable']
  });
  const [ask] = buildCanonicalRoleAsks({ plan });
  assert.equal(ask.blocker_code, 'account_role_missing');
  assert.match(ask.question, /I cannot find an account in your books/);
  assert.match(ask.question, /Should I add one/);
  assert.ok(!/Reply with the code/.test(ask.question), 'there is nothing to pick from');
  assert.deepEqual(ask.request_payload.candidates, []);
  assertVoice(ask.question);
});

await test('owner phrasing beats ledger jargon, and falls back rather than inventing', () => {
  assert.equal(ownerPhraseForRole('liability.sales_tax_payable'), 'VAT or sales tax account');
  assert.equal(ownerPhraseForRole('liability.director_loan'), "director's loan account");
  // Not in the phrase table: falls back to the ACCOUNT_ROLES label.
  assert.equal(ownerPhraseForRole('clearing.payment_processor'), 'Payment-processor clearing');
  assert.equal(ownerPhraseForRole('not.a.role'), 'not.a.role');
});

await test('an unknown refusal mints nothing rather than a mis-identified ask', () => {
  assert.equal(buildCanonicalRoleAsk({ ask: { role: 'liability.sales_tax_payable', refusal: 'invented' } }), null);
  assert.equal(buildCanonicalRoleAsk({ ask: { role: 'not.a.role', refusal: 'no_candidate' } }), null);
  assert.equal(buildCanonicalRoleAsk({ ask: {} }), null);
  assert.equal(buildCanonicalRoleAsk({}), null);
  assert.deepEqual(buildCanonicalRoleAsks({ plan: { asks: [{ refusal: 'invented' }] } }), []);
  assert.deepEqual(buildCanonicalRoleAsks({}), []);
});

await test('the blocker codes distinguish the two questions, and both survive normalization', () => {
  assert.equal(CANONICAL_ROLE_BLOCKER_CODES.singleton_contended, 'account_role_ambiguous');
  assert.equal(CANONICAL_ROLE_BLOCKER_CODES.no_candidate, 'account_role_missing');
  // Already lower_snake, so normalizeBlockerCode maps them onto themselves and
  // the migration 108 unique index keys on exactly these strings.
  assert.notEqual(CANONICAL_ROLE_BLOCKER_CODES.singleton_contended, CANONICAL_ROLE_BLOCKER_CODES.no_candidate);
});

await test('two asks on one chart are stable and distinct per role', () => {
  const plan = planCanonicalRoleResolution({
    accounts: GB_CHART,
    requiredRoles: ['liability.sales_tax_payable', 'asset.cash']
  });
  const built = buildCanonicalRoleAsks({ plan });
  assert.equal(built.length, 2);
  const anchors = built.map((a) => a.anchor);
  assert.equal(new Set(anchors).size, 2, 'one anchor per role, never a shared one');
  assert.deepEqual(anchors, [...anchors].sort(), 'ordering is deterministic');
  for (const ask of built) assertVoice(ask.question);
});

await test('one standing question, one anchor: the same role asked twice is the same ask', () => {
  // The point of anchoring on the role rather than the invoice that tripped it.
  const first = buildCanonicalRoleAsk({
    ask: { role: 'liability.sales_tax_payable', refusal: 'no_candidate', candidates: [{ account_id: 'a', code: '2220', name: 'VAT control' }] }
  });
  const second = buildCanonicalRoleAsk({
    ask: { role: 'liability.sales_tax_payable', refusal: 'no_candidate', candidates: [{ account_id: 'a', code: '2220', name: 'VAT control' }] }
  });
  assert.equal(first.anchor, second.anchor);
  assert.equal(first.blocker_code, second.blocker_code);
});
