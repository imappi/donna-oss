import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ASK_AUDIENCES,
  SEAT_ADDRESSEE_PRINCIPAL_TYPES,
  AGENT_ADDRESSEE_PRINCIPAL_TYPE,
  askAudienceOf,
  normalizeAskAudience,
  validateAskAddressee,
  partitionAskRowsByAudience
} from './askAudience.js';

test('the audience enum is pinned', () => {
  assert.deepEqual([...ASK_AUDIENCES], ['client', 'seat', 'agent']);
  assert.deepEqual([...SEAT_ADDRESSEE_PRINCIPAL_TYPES], ['firm_member', 'firm_collaborator']);
  assert.equal(AGENT_ADDRESSEE_PRINCIPAL_TYPE, 'ai_occupant');
});

test('absence is a client ask (every pre-122 row); unknown strings never silently downgrade', () => {
  assert.equal(askAudienceOf({}), 'client');
  assert.equal(askAudienceOf({ audience: 'SEAT ' }), 'seat');
  assert.equal(askAudienceOf({ audience: 'pod' }), 'client', 'a reader tolerates junk as client');
  assert.equal(normalizeAskAudience(undefined), 'client');
  assert.equal(normalizeAskAudience(''), 'client');
  assert.equal(normalizeAskAudience('agent'), 'agent');
  assert.equal(normalizeAskAudience('pod'), null, 'a WRITER refuses junk — never downgrades to the owner channel');
});

test('addressee shape law: client forbids, seat/agent require their principal types', () => {
  assert.equal(validateAskAddressee({ audience: 'client' }).ok, true);
  assert.equal(
    validateAskAddressee({ audience: 'client', addresseePrincipalType: 'firm_member', addresseePrincipalId: 'x' }).reason,
    'client_ask_forbids_addressee'
  );
  const seat = validateAskAddressee({ audience: 'seat', addresseePrincipalType: 'firm_collaborator', addresseePrincipalId: 'c-david' });
  assert.equal(seat.ok, true);
  assert.equal(seat.addresseePrincipalId, 'c-david');
  assert.equal(validateAskAddressee({ audience: 'seat' }).reason, 'seat_ask_requires_addressee');
  assert.equal(
    validateAskAddressee({ audience: 'seat', addresseePrincipalType: 'ai_occupant', addresseePrincipalId: 'clara' }).reason,
    'seat_addressee_principal_type_invalid'
  );
  const agent = validateAskAddressee({ audience: 'agent', addresseePrincipalType: 'ai_occupant', addresseePrincipalId: 'clara' });
  assert.equal(agent.ok, true);
  assert.equal(
    validateAskAddressee({ audience: 'agent', addresseePrincipalType: 'firm_member', addresseePrincipalId: 'm1' }).reason,
    'agent_addressee_principal_type_invalid'
  );
  assert.equal(validateAskAddressee({ audience: 'pod' }).reason, 'unknown_audience');
});

test('partition buckets by audience with junk tolerated as client', () => {
  const rows = [
    { id: 'a' },
    { id: 'b', audience: 'seat' },
    { id: 'c', audience: 'agent' },
    { id: 'd', audience: 'nonsense' }
  ];
  const p = partitionAskRowsByAudience(rows);
  assert.deepEqual(p.client.map((r) => r.id), ['a', 'd']);
  assert.deepEqual(p.seat.map((r) => r.id), ['b']);
  assert.deepEqual(p.agent.map((r) => r.id), ['c']);
});
