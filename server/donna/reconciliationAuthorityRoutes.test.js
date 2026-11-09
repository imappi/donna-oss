// The pure authority decision behind the reconciliation-authority routes, and
// the deployed-surface rewrites for them. The end-to-end proof on PostgreSQL is
// reconciliationAuthorityGrantsPgLifecycle.test.js.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  RECONCILIATION_AUTHORITY_ROUTES,
  RECONCILIATION_AUTHORITY_VERBS,
  decideGrantAuthority,
  describeScopeKey
} from './reconciliationAuthorityRoutes.js';
import { RUNTIME_MINT_ACTOR_TYPES } from './reconciliationAuthorityGrants.js';
import { requiredCapabilityForAction } from './operatorCapability.js';

const member = (extra = {}) => ({ principalType: 'firm_member', principalId: 'm1', email: 'operator@ledgerlight.example', role: 'member', accessLevel: 'staff', unrestricted: true, ...extra });
const seat = (seatRole, extra = {}) => ({ principalType: 'firm_collaborator', principalId: `c-${seatRole}`, email: `${seatRole}@ledgerlight.example`, role: 'bookkeeper', seatRole, affiliation: 'internal', unrestricted: false, ...extra });
const portalOwner = { principalType: 'firm_collaborator', principalId: 'c-owner', email: 'owner@pierpoint-studio.example', role: 'owner', unrestricted: false };
const writeVerbs = Object.values(RECONCILIATION_AUTHORITY_VERBS);

test('every governance verb requires partner capability through the one resolver', () => {
  for (const verb of writeVerbs) assert.equal(requiredCapabilityForAction(verb), 'partner', verb);
});

test('firm members act as firm_operator, or admin when they own the firm', () => {
  for (const verb of writeVerbs) {
    assert.deepEqual(
      [decideGrantAuthority({ principal: member(), actionType: verb }).actorType, decideGrantAuthority({ principal: member({ accessLevel: 'owner' }), actionType: verb }).actorType],
      ['firm_operator', 'admin']
    );
  }
});

test('an internal partner seat acts as accountant; a per-entity partner assignment lifts a senior seat', () => {
  const partner = decideGrantAuthority({ principal: seat('partner'), actionType: RECONCILIATION_AUTHORITY_VERBS.mint });
  assert.deepEqual([partner.allowed, partner.actorType], [true, 'accountant']);
  assert.equal(decideGrantAuthority({ principal: seat('senior'), assignmentRole: 'partner', actionType: RECONCILIATION_AUTHORITY_VERBS.mint }).allowed, true);
  for (const actorType of new Set(writeVerbs.map((verb) => decideGrantAuthority({ principal: seat('partner'), actionType: verb }).actorType))) {
    assert.ok(RUNTIME_MINT_ACTOR_TYPES.includes(actorType), actorType);
  }
});

test('refused for every write: junior and senior seats, external seats, the portal owner, legacy collaborators, bare tokens, unnamed members', () => {
  const cases = [
    [seat('junior'), null, 'CAPABILITY_REQUIRED'],
    [seat('senior'), null, 'CAPABILITY_REQUIRED'],
    [seat('senior'), 'owner', 'CAPABILITY_REQUIRED'], // an 'owner' assignment row never lifts a seat
    [seat('partner', { affiliation: 'external' }), null, 'EXTERNAL_SEAT'],
    [portalOwner, 'owner', 'CLIENT_SIDE_PRINCIPAL'],
    [{ ...portalOwner, role: 'accountant' }, 'owner', 'NOT_A_SEAT'], // legacy collaborator: never via an assignment row
    [{ principalType: 'access_token', principalId: 'access-token', unrestricted: true }, null, 'UNNAMED_PRINCIPAL'],
    [member({ email: null, userId: null, principalId: null }), null, 'UNNAMED_PRINCIPAL'],
    [null, null, 'NO_PRINCIPAL']
  ];
  for (const verb of writeVerbs) {
    for (const [principal, assignmentRole, code] of cases) {
      const decision = decideGrantAuthority({ principal, assignmentRole, actionType: verb });
      assert.deepEqual([decision.allowed, decision.code], [false, code], `${verb} ${principal?.principalId} ${assignmentRole}`);
    }
  }
});

test('reads: firm-side principals may list; the portal owner may not', () => {
  assert.equal(decideGrantAuthority({ principal: seat('junior') }).allowed, true);
  assert.equal(decideGrantAuthority({ principal: member() }).allowed, true);
  assert.equal(decideGrantAuthority({ principal: portalOwner }).code, 'CLIENT_SIDE_PRINCIPAL');
});

test('the scope key reads back as merchant, document type and account', () => {
  assert.deepEqual(describeScopeKey('merchant:harbour-lane-properties|doc:supplier-bill|acct:7100'),
    { merchant: 'harbour-lane-properties', document_type: 'supplier-bill', account: '7100' });
  assert.deepEqual(describeScopeKey(null), { merchant: null, document_type: null, account: null });
});

test('every route has a vercel.json rewrite (works in dev, would 404 in prod without one)', () => {
  const vercel = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'));
  const sources = new Set(vercel.rewrites.map((rule) => rule.source));
  for (const route of Object.values(RECONCILIATION_AUTHORITY_ROUTES)) {
    assert.ok(sources.has(`/api/donna/firms${route}`), route);
  }
});
