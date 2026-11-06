// Donna Inventory I4·posting — P7 §13 delegated-authority ceilings: the PURE check.
//   node --test server/donna/inventory/postingAuthority.test.js
//
// Covers the whole fail-closed ladder: event-class always-escalate (grant-independent), the
// allow-lists, currency / confidence / evidence gates, the per-journal + DAILY + PERIOD aggregate
// ceilings (the §13 hardening — a thousand small journals cannot bypass), the validity window, and
// jurisdiction. Every doubt → NOT authorized.

import assert from 'node:assert/strict';
import test from 'node:test';

import { checkInventoryPostingAuthority, ALWAYS_ESCALATE_POSTING_KINDS, POSTING_AUTHORITY_BREACHES } from './postingAuthority.js';

const NOW = Date.parse('2026-07-12T12:00:00Z');
const asOf = new Date(NOW);

const grant = (over = {}) => ({
  id: 'g1', status: 'active', correction_count: 0,
  allowed_posting_kinds: ['receipt', 'matched_supplier_bill', 'shipment_cogs'],
  allowed_accounts: ['asset.inventory', 'liability.grni', 'expense.cost_of_sales'],
  per_journal_ceiling: 1000, daily_aggregate_ceiling: 5000, period_aggregate_ceiling: 20000,
  currency: 'EUR', confidence_floor: null, evidence_required: false, jurisdiction: null,
  valid_from: '2026-01-01T00:00:00Z', expires_at: null, review_after: null,
  ...over
});
const proposed = (over = {}) => ({
  postingKind: 'receipt', amount: 400, currency: 'EUR',
  accountRoles: ['asset.inventory', 'liability.grni'], confidence: 0.9, evidencePresent: true,
  firstUseAccount: false, unusualCountVariance: false, jurisdiction: null,
  ...over
});

test('happy path: a covering active grant authorizes a within-envelope post', () => {
  const v = checkInventoryPostingAuthority({ grant: grant(), proposed: proposed(), aggregates: { dailyPosted: 0, periodPosted: 0 }, asOf });
  assert.equal(v.authorized, true);
  assert.equal(v.reason, null);
  assert.equal(v.detail.daily_headroom, 4600); // 5000 − (0 + 400)
  assert.equal(v.detail.period_headroom, 19600);
});

test('event-class: a write_down ALWAYS escalates, even with a covering grant', () => {
  const g = grant({ allowed_posting_kinds: ['write_down', 'receipt'] }); // even if allow-listed
  const v = checkInventoryPostingAuthority({ grant: g, proposed: proposed({ postingKind: 'write_down' }), aggregates: {}, asOf });
  assert.equal(v.authorized, false);
  assert.equal(v.reason, 'event_class_always_escalates');
  assert.equal(v.detail.class, 'kind');
});

test('event-class: private_use / first-use account / unusual count variance always escalate', () => {
  assert.equal(checkInventoryPostingAuthority({ grant: grant(), proposed: proposed({ postingKind: 'private_use' }), asOf }).reason, 'event_class_always_escalates');
  assert.equal(checkInventoryPostingAuthority({ grant: grant(), proposed: proposed({ firstUseAccount: true }), asOf }).detail.class, 'first_use_account');
  assert.equal(checkInventoryPostingAuthority({ grant: grant(), proposed: proposed({ unusualCountVariance: true }), asOf }).detail.class, 'unusual_count_variance');
});
assert.deepEqual([...ALWAYS_ESCALATE_POSTING_KINDS], ['write_down', 'private_use']);

test('no grant / inactive / corrected grant all deny', () => {
  assert.equal(checkInventoryPostingAuthority({ grant: null, proposed: proposed(), asOf }).reason, 'no_grant');
  assert.equal(checkInventoryPostingAuthority({ grant: grant({ status: 'suspended' }), proposed: proposed(), asOf }).reason, 'grant_inactive');
  assert.equal(checkInventoryPostingAuthority({ grant: grant({ correction_count: 1 }), proposed: proposed(), asOf }).reason, 'grant_corrected');
});

test('allow-lists: an unlisted kind or account denies (empty list authorizes nothing)', () => {
  assert.equal(checkInventoryPostingAuthority({ grant: grant(), proposed: proposed({ postingKind: 'landed_cost' }), asOf }).reason, 'kind_not_allowed');
  assert.equal(checkInventoryPostingAuthority({ grant: grant(), proposed: proposed({ accountRoles: ['asset.inventory', 'expense.fx'] }), asOf }).reason, 'account_not_allowed');
  assert.equal(checkInventoryPostingAuthority({ grant: grant({ allowed_posting_kinds: [] }), proposed: proposed(), asOf }).reason, 'kind_not_allowed');
});

test('currency / confidence-floor / evidence gates', () => {
  assert.equal(checkInventoryPostingAuthority({ grant: grant(), proposed: proposed({ currency: 'GBP' }), asOf }).reason, 'currency_mismatch');
  assert.equal(checkInventoryPostingAuthority({ grant: grant({ confidence_floor: 0.8 }), proposed: proposed({ confidence: 0.7 }), asOf }).reason, 'confidence_below_floor');
  assert.equal(checkInventoryPostingAuthority({ grant: grant({ confidence_floor: 0.8 }), proposed: proposed({ confidence: null }), asOf }).reason, 'confidence_below_floor');
  assert.equal(checkInventoryPostingAuthority({ grant: grant({ evidence_required: true }), proposed: proposed({ evidencePresent: false }), asOf }).reason, 'evidence_required');
});

test('per-journal ceiling: over the cap, or a non-positive amount, denies', () => {
  assert.equal(checkInventoryPostingAuthority({ grant: grant(), proposed: proposed({ amount: 1200 }), asOf }).reason, 'per_journal_ceiling');
  assert.equal(checkInventoryPostingAuthority({ grant: grant(), proposed: proposed({ amount: 0 }), asOf }).reason, 'per_journal_ceiling');
  assert.equal(checkInventoryPostingAuthority({ grant: grant(), proposed: proposed({ amount: 1000 }), asOf }).authorized, true); // exactly at the cap is allowed
});

test('DAILY aggregate ceiling: many small posts that each clear per-journal still breach the day cap', () => {
  // Each post is 400 (well under the 1000 per-journal cap), but 4800 already posted today → the
  // 5th 400 would make 5200 > 5000 daily ceiling. The §13 "thousand small journals" defense.
  const v = checkInventoryPostingAuthority({ grant: grant(), proposed: proposed({ amount: 400 }), aggregates: { dailyPosted: 4800, periodPosted: 4800 }, asOf });
  assert.equal(v.authorized, false);
  assert.equal(v.reason, 'daily_aggregate_ceiling');
  assert.equal(v.detail.daily_posted, 4800);
});

test('PERIOD aggregate ceiling: within the day cap but over the period cap denies', () => {
  const v = checkInventoryPostingAuthority({ grant: grant(), proposed: proposed({ amount: 400 }), aggregates: { dailyPosted: 0, periodPosted: 19800 }, asOf });
  assert.equal(v.authorized, false);
  assert.equal(v.reason, 'period_aggregate_ceiling');
});

test('a null aggregate ceiling is unbounded on that axis (per-journal still binds)', () => {
  const g = grant({ daily_aggregate_ceiling: null, period_aggregate_ceiling: null });
  const v = checkInventoryPostingAuthority({ grant: g, proposed: proposed({ amount: 400 }), aggregates: { dailyPosted: 999999, periodPosted: 999999 }, asOf });
  assert.equal(v.authorized, true);
  assert.equal(v.detail.daily_headroom, null);
});

test('validity window: not-yet-valid, expired, review-due all deny; a null asOf fails closed', () => {
  assert.equal(checkInventoryPostingAuthority({ grant: grant({ valid_from: '2026-08-01T00:00:00Z' }), proposed: proposed(), asOf }).reason, 'not_yet_valid');
  assert.equal(checkInventoryPostingAuthority({ grant: grant({ expires_at: '2026-07-01T00:00:00Z' }), proposed: proposed(), asOf }).reason, 'expired');
  assert.equal(checkInventoryPostingAuthority({ grant: grant({ review_after: '2026-07-01T00:00:00Z' }), proposed: proposed(), asOf }).reason, 'review_due');
  assert.equal(checkInventoryPostingAuthority({ grant: grant(), proposed: proposed(), asOf: null }).reason, 'review_due');
});

test('jurisdiction: a scoped grant denies a mismatched jurisdiction, allows a match', () => {
  assert.equal(checkInventoryPostingAuthority({ grant: grant({ jurisdiction: 'FI' }), proposed: proposed({ jurisdiction: 'SG' }), asOf }).reason, 'jurisdiction_mismatch');
  assert.equal(checkInventoryPostingAuthority({ grant: grant({ jurisdiction: 'FI' }), proposed: proposed({ jurisdiction: 'FI' }), asOf }).authorized, true);
});

test('every deny reason is in the closed breach vocabulary', () => {
  const reasons = ['no_grant', 'grant_inactive', 'grant_corrected', 'event_class_always_escalates', 'kind_not_allowed',
    'account_not_allowed', 'currency_mismatch', 'confidence_below_floor', 'evidence_required', 'per_journal_ceiling',
    'daily_aggregate_ceiling', 'period_aggregate_ceiling', 'not_yet_valid', 'expired', 'review_due', 'jurisdiction_mismatch'];
  for (const r of reasons) assert.ok(POSTING_AUTHORITY_BREACHES.includes(r), `${r} is a declared breach`);
});
