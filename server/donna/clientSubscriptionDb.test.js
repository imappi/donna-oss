// Client subscription mirror — unit coverage for the pure entitlement rule the
// portal gate depends on. The DB read/write paths need a live connection and are
// exercised by integration; here we pin only the logic that decides whether a
// client may open the portal.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isEntitledStatus,
  isWithinPaidWindow,
  computeEntitled,
  assertClientEntitled
} from './clientSubscriptionDb.js';

const future = () => new Date(Date.now() + 7 * 86400 * 1000).toISOString();
const past = () => new Date(Date.now() - 7 * 86400 * 1000).toISOString();

test('isWithinPaidWindow: a one-off window entitles until it lapses', () => {
  assert.equal(isWithinPaidWindow(future()), true);
  assert.equal(isWithinPaidWindow(past()), false);
  assert.equal(isWithinPaidWindow(null), false);
  assert.equal(isWithinPaidWindow(''), false);
  assert.equal(isWithinPaidWindow('not-a-date'), false);
});

test('computeEntitled: an active/trialing subscription opens the portal (status-driven)', () => {
  assert.equal(computeEntitled({ status: 'active', accessPaidThrough: null }), true);
  assert.equal(computeEntitled({ status: 'trialing', accessPaidThrough: null }), true);
  // A subscription's entitlement does NOT depend on the period end — so the gap
  // before a renewal webhook never locks a paying subscriber out.
  assert.equal(computeEntitled({ status: 'active', accessPaidThrough: past() }), true);
});

test('computeEntitled: a paid one-off window opens the portal even with no subscription', () => {
  // one_month / catch_up have no subscription status, only a paid-through window.
  assert.equal(computeEntitled({ status: null, accessPaidThrough: future() }), true);
  assert.equal(computeEntitled({ status: null, accessPaidThrough: past() }), false);
  // A lapsed/canceled subscription with an unexpired one-off window is STILL in.
  assert.equal(computeEntitled({ status: 'canceled', accessPaidThrough: future() }), true);
});

test('computeEntitled: nothing paid → not entitled', () => {
  assert.equal(computeEntitled({ status: null, accessPaidThrough: null }), false);
  assert.equal(computeEntitled({ status: 'past_due', accessPaidThrough: null }), false);
  assert.equal(computeEntitled({}), false);
});

test('isEntitledStatus stays subscription-only (one-off access is the window, not a status)', () => {
  assert.equal(isEntitledStatus('active'), true);
  assert.equal(isEntitledStatus('canceled'), false);
});

// assertClientEntitled — the SERVER-SIDE portal paywall backstop. A loader stub
// stands in for the DB so we pin only the gating logic. `throws()` asserts the
// no-throw exemptions never even reach the loader (the loader throws if called).
const member = { principalType: 'firm_member', unrestricted: true };
const accessToken = { principalType: 'access_token', unrestricted: true };
const owner = { principalType: 'firm_collaborator', unrestricted: false };
const loaderThatMustNotRun = () => { throw new Error('loader should not be called'); };
const stubLoader = (entitled) => async () => ({ clientId: 'c1', entitled });

test('assertClientEntitled: no-op when billing is disabled (fail open, never hits the loader)', async () => {
  await assert.doesNotReject(assertClientEntitled({
    clientId: 'c1', principal: owner, billingEnabled: false, loadBillingContext: loaderThatMustNotRun
  }));
});

test('assertClientEntitled: firm members and the access token are never gated', async () => {
  await assert.doesNotReject(assertClientEntitled({
    clientId: 'c1', principal: member, billingEnabled: true, loadBillingContext: loaderThatMustNotRun
  }));
  await assert.doesNotReject(assertClientEntitled({
    clientId: 'c1', principal: accessToken, billingEnabled: true, loadBillingContext: loaderThatMustNotRun
  }));
});

test('assertClientEntitled: no client id to check is a no-op (loader untouched)', async () => {
  await assert.doesNotReject(assertClientEntitled({
    principal: owner, billingEnabled: true, loadBillingContext: loaderThatMustNotRun
  }));
});

test('assertClientEntitled: an entitled client passes for a client-scoped caller', async () => {
  await assert.doesNotReject(assertClientEntitled({
    clientId: 'c1', principal: owner, billingEnabled: true, loadBillingContext: stubLoader(true)
  }));
});

test('assertClientEntitled: a non-entitled client throws 402 CLIENT_NOT_ENTITLED', async () => {
  await assert.rejects(
    assertClientEntitled({
      clientId: 'c1', principal: owner, billingEnabled: true, loadBillingContext: stubLoader(false)
    }),
    (err) => err.statusCode === 402 && err.code === 'CLIENT_NOT_ENTITLED'
  );
});

test('assertClientEntitled: an unknown client is left for the handler to 404 (not masked as 402)', async () => {
  await assert.doesNotReject(assertClientEntitled({
    clientId: 'ghost', principal: owner, billingEnabled: true, loadBillingContext: async () => null
  }));
});

test('assertClientEntitled: a multi-client register throws if ANY referenced client is inactive', async () => {
  const byId = { paid: { entitled: true }, lapsed: { entitled: false } };
  await assert.rejects(
    assertClientEntitled({
      clientIds: ['paid', 'lapsed'],
      principal: owner,
      billingEnabled: true,
      loadBillingContext: async ({ clientId }) => byId[clientId]
    }),
    (err) => err.code === 'CLIENT_NOT_ENTITLED'
  );
});
