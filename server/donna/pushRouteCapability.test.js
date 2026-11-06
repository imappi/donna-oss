// INT-5 — the direct push routes carry the member + capability gate (source pin).
//
// The pure capability decision is tested in operatorCapability.test.js and the
// staged enforcement shell in firmDb; what NEITHER pins is that the five direct
// push route handlers actually CALL them — the exact gap #804 documented
// (/xero|qbo/writeback-* shipped with no requireMember on execute while
// /ledger/post-* had it). Same posture as inngest/serve.test.js's registration
// pin: a route edit that drops the gate fails here before it lands in prod.
//
// Pin shape: for each push pathname, slice its handler block out of api.js
// source (from its pathname literal to the next route's pathname check) and
// assert the block gates execute on BOTH requireMember and
// assertActionCapability('sync_to_accounting').

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = resolvePath(fileURLToPath(import.meta.url), '..');
const apiSource = readFileSync(resolvePath(__dirname, 'api.js'), 'utf8');

// The five direct push verbs (plan §2 INT-5). The /qbo/* aliases share each
// handler with the /xero/* literal, so pinning the xero literal covers both —
// but pin the alias literal's PRESENCE so a split into separate handlers
// re-triggers a review here.
const PUSH_ROUTES = [
  { path: '/xero/writeback-transaction', alias: '/qbo/writeback-transaction' },
  { path: '/xero/writeback-transactions', alias: '/qbo/writeback-transactions' },
  { path: '/xero/mirror-retry', alias: '/qbo/mirror-retry' },
  { path: '/ledger/post-transaction', alias: null },
  { path: '/ledger/post-period', alias: null }
];

const handlerBlockFor = (pathname) => {
  const marker = `requestUrl.pathname === '${pathname}'`;
  const start = apiSource.indexOf(marker);
  assert.ok(start >= 0, `route ${pathname} exists in api.js`);
  // A shared handler's condition holds TWO pathname literals (/xero + /qbo
  // alias), so the block ends at the next pathname check AFTER this route's
  // method check — not at the alias on the next line of the same condition.
  const methodAt = apiSource.indexOf("req.method === '", start);
  assert.ok(methodAt > start, `route ${pathname} has a method check`);
  const next = apiSource.indexOf('requestUrl.pathname ===', methodAt);
  return apiSource.slice(start, next > start ? next : apiSource.length);
};

for (const route of PUSH_ROUTES) {
  test(`${route.path}: execute is gated on requireMember AND sync_to_accounting capability`, () => {
    const block = handlerBlockFor(route.path);
    assert.match(
      block,
      /const executing = body\?\.dry_run === false \|\| body\?\.execute === true \|\| body\?\.force === true/,
      'derives the executing predicate from dry_run/execute/force'
    );
    assert.match(block, /requireMember:\s*executing/, 'requireMember rides the executing predicate');
    assert.match(
      block,
      /if \(executing\) \{\s*await assertActionCapability\(\{ firmId, clientId, principal: access\.principal, actionType: 'sync_to_accounting' \}\);/,
      'capability gate on the execute path'
    );
  });
}

test('the shared /qbo aliases still resolve inside the gated handlers (no split without a gate)', () => {
  for (const route of PUSH_ROUTES.filter((r) => r.alias)) {
    const block = handlerBlockFor(route.path);
    // The alias literal appears in the SAME condition as the xero literal —
    // the handler dispatches by accounting_system, so one gate covers both. A
    // split into separate handlers would drop the alias from this block and
    // land here for review (the new handler needs its own gate).
    assert.ok(
      block.includes(`requestUrl.pathname === '${route.alias}'`),
      `${route.alias} shares ${route.path}'s gated handler`
    );
  }
});
