import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MENTION_FLAVORS,
  MENTION_ACTOR_TYPES,
  OPERATOR_AGENT_ID,
  buildMentionRoster,
  filterMentionRoster,
  normalizeMentionFlavor,
  validateDirectAgentChatRef,
  validateMentionRefs,
  validateMentionSubmission
} from './mentionResolution.js';
import { AI_PROFILES } from '../roles/roleRegistry.js';

const NOW = new Date('2026-08-27T12:00:00Z');

const seat = (id, extra = {}) => ({
  principal_type: 'firm_collaborator', principal_id: id, ...extra
});
const hire = (profile, role, extra = {}) => ({
  principal_type: 'ai_occupant', ai_profile: profile, role, status: 'active', ...extra
});

const roster = () => buildMentionRoster({
  humanPrincipals: [
    { principal_type: 'firm_member', principal_id: 'm-kari', display: 'Kari', email: 'kari@books.example' },
    seat('c-david', { email: 'david@books.example' })
  ],
  specialistAssignments: [
    hire('clara', 'collections'),
    hire('vera', 'tax')
  ],
  now: NOW
});

test('enums are pinned', () => {
  assert.deepEqual([...MENTION_FLAVORS], ['mention', 'assign', 'ask']);
  assert.deepEqual([...MENTION_ACTOR_TYPES], ['seat', 'agent']);
});

test('the operator agent_id is reserved — never a bench profile id', () => {
  assert.equal(OPERATOR_AGENT_ID in AI_PROFILES, false);
});

test('roster: humans keep display, fall back to email local-part, and dedupe', () => {
  const r = buildMentionRoster({
    humanPrincipals: [
      { principal_type: 'firm_member', principal_id: 'm-kari', display: 'Kari', email: 'kari@books.example' },
      seat('c-david', { email: 'david@books.example' }),
      seat('c-david', { email: 'david@books.example' })
    ],
    now: NOW
  });
  const seats = r.filter((e) => e.actor_type === 'seat');
  assert.equal(seats.length, 2);
  assert.equal(seats[0].display, 'Kari');
  assert.equal(seats[1].display, 'david');
});

test('roster: seat entries carry the build-1 ladder vocabulary (role label + External badge source)', () => {
  const r = buildMentionRoster({
    humanPrincipals: [
      { principal_type: 'firm_member', principal_id: 'm-kari', display: 'Kari', seat_role: 'owner', affiliation: 'internal' },
      seat('c-david', { email: 'david@books.example', seat_role: 'junior', affiliation: 'external' }),
      // a legacy collaborator without seat vocabulary stays mentionable, unbadged
      seat('c-legacy', { email: 'legacy@books.example' })
    ],
    now: NOW
  });
  const byId = new Map(r.filter((e) => e.actor_type === 'seat').map((e) => [e.principal_id, e]));
  assert.equal(byId.get('m-kari').seat_role, 'owner');
  assert.equal(byId.get('m-kari').affiliation, 'internal');
  assert.equal(byId.get('c-david').seat_role, 'junior');
  assert.equal(byId.get('c-david').affiliation, 'external');
  assert.equal(byId.get('c-legacy').seat_role, null);
  // affiliation fail-closes to 'internal' — a missing value never renders an External badge
  assert.equal(byId.get('c-legacy').affiliation, 'internal');
});

test('roster: the operator is always present and precedes bench hires', () => {
  const agents = roster().filter((e) => e.actor_type === 'agent');
  assert.equal(agents[0].agent_id, OPERATOR_AGENT_ID);
  assert.equal(agents[0].display, 'Donna');
  assert.deepEqual(agents.slice(1).map((a) => a.agent_id).sort(), ['clara', 'vera']);
});

test('roster: only live ai_occupant hires are mentionable', () => {
  const r = buildMentionRoster({
    specialistAssignments: [
      hire('clara', 'collections'),
      hire('vera', 'tax', { status: 'ended', ends_at: '2026-08-01T00:00:00Z' }),
      hire('milo', 'inventory', { status: 'suspended' }),
      hire('vera', 'vat', { status: 'proposed' }),
      hire('milo', 'goods', { starts_at: '2026-09-01T00:00:00Z' }),
      hire('clara', 'chasing', { status: 'active', ends_at: '2026-08-20T00:00:00Z' }),
      // a HUMAN occupying a specialist role is a seat elsewhere, never an agent
      { principal_type: 'firm_collaborator', principal_id: 'c-x', role: 'tax', status: 'active' }
    ],
    now: NOW
  });
  const bench = r.filter((e) => e.actor_type === 'agent' && e.agent_id !== OPERATOR_AGENT_ID);
  assert.deepEqual(bench.map((a) => a.key), ['agent:clara:collections']);
  assert.equal(bench[0].display, 'Clara');
});

test('typeahead: prefix band first, substring band after, empty query returns all', () => {
  const r = roster();
  assert.equal(filterMentionRoster(r, '').length, r.length);
  const d = filterMentionRoster(r, 'd');
  assert.equal(d[0].display, 'david');
  assert.equal(d[1].display, 'Donna');
  const ka = filterMentionRoster(r, 'ka');
  assert.equal(ka[0].display, 'Kari');
  const sub = filterMentionRoster(r, 'avi');
  assert.deepEqual(sub.map((e) => e.display), ['david']);
});

test('typeahead: Arabic variants, diacritics, and code-switched names share one search key', () => {
  const r = buildMentionRoster({
    humanPrincipals: [
      { principal_type: 'firm_member', principal_id: 'm-ibrahim', display: 'إِبـرَاهِيم Finance' },
      { principal_type: 'firm_member', principal_id: 'm-fatima', display: 'فاطمة Operations' }
    ],
    now: NOW
  });
  assert.deepEqual(filterMentionRoster(r, 'ابراهيم fin').map((entry) => entry.principal_id), ['m-ibrahim']);
  assert.deepEqual(filterMentionRoster(r, 'فاطمة oper').map((entry) => entry.principal_id), ['m-fatima']);
});

test('typeahead: malformed bidi controls and oversized queries fail closed', () => {
  const r = buildMentionRoster({
    humanPrincipals: [{ principal_type: 'firm_member', principal_id: 'm-ae', display: 'دبي AE070331234567890123456' }],
    now: NOW
  });
  assert.deepEqual(filterMentionRoster(r, 'دب\u202Eي'), []);
  assert.deepEqual(filterMentionRoster(r, 'AE\u2066070331234567890123456\u2069'), []);
  assert.deepEqual(filterMentionRoster(r, 'x'.repeat(4097)), []);
});

test('refs: an eligible seat resolves; an ineligible seat must not', () => {
  const ok = validateMentionRefs({
    refs: [{ actor_type: 'seat', principal_type: 'firm_collaborator', principal_id: 'c-david' }],
    roster: roster()
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.resolved[0].display, 'david');

  const out = validateMentionRefs({
    refs: [{ actor_type: 'seat', principal_type: 'firm_collaborator', principal_id: 'c-outsider' }],
    roster: roster()
  });
  assert.equal(out.ok, false);
  assert.equal(out.refusals[0].reason, 'seat_not_eligible');
});

test('refs: a hired persona resolves; an un-hired persona must not', () => {
  const ok = validateMentionRefs({
    refs: [{ actor_type: 'agent', agent_id: 'clara' }],
    roster: roster()
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.resolved[0].role, 'collections');

  const miss = validateMentionRefs({
    refs: [{ actor_type: 'agent', agent_id: 'milo' }],
    roster: roster()
  });
  assert.equal(miss.ok, false);
  assert.equal(miss.refusals[0].reason, 'agent_not_hired');
});

test('refs: same profile in two roles is ambiguous without a role, exact with one', () => {
  const r = buildMentionRoster({
    specialistAssignments: [hire('clara', 'collections'), hire('clara', 'chasing')],
    now: NOW
  });
  const ambiguous = validateMentionRefs({ refs: [{ actor_type: 'agent', agent_id: 'clara' }], roster: r });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.refusals[0].reason, 'ambiguous_agent');

  const exact = validateMentionRefs({
    refs: [{ actor_type: 'agent', agent_id: 'clara', role: 'chasing' }], roster: r
  });
  assert.equal(exact.ok, true);
  assert.equal(exact.resolved[0].key, 'agent:clara:chasing');
});

test('refs: one bad ref refuses the whole set (fail-closed), and dupes dedupe', () => {
  const mixed = validateMentionRefs({
    refs: [
      { actor_type: 'agent', agent_id: 'clara' },
      { actor_type: 'agent', agent_id: 'clara' },
      { actor_type: 'seat', principal_type: 'firm_collaborator', principal_id: 'c-outsider' },
      { actor_type: 'channel', agent_id: 'general' }
    ],
    roster: roster()
  });
  assert.equal(mixed.ok, false);
  assert.equal(mixed.resolved.length, 1);
  assert.deepEqual(mixed.refusals.map((r) => r.reason), ['seat_not_eligible', 'unknown_actor_type']);
});

test('flavor normalization is fail-closed', () => {
  assert.equal(normalizeMentionFlavor('ask'), 'ask');
  assert.equal(normalizeMentionFlavor(' MENTION '), 'mention');
  assert.equal(normalizeMentionFlavor(undefined), 'mention');
  assert.equal(normalizeMentionFlavor('dm'), null);
});

test('submission: assign/ask take exactly one addressee; human mentions take several', () => {
  const r = roster();
  const twoHumans = [
    { actor_type: 'seat', principal_type: 'firm_member', principal_id: 'm-kari' },
    { actor_type: 'seat', principal_type: 'firm_collaborator', principal_id: 'c-david' }
  ];
  assert.equal(validateMentionSubmission({ flavor: 'mention', refs: twoHumans, roster: r }).ok, true);
  const ask2 = validateMentionSubmission({ flavor: 'ask', refs: twoHumans, roster: r });
  assert.equal(ask2.ok, false);
  assert.equal(ask2.refusals[0].reason, 'ask_requires_single_addressee');
  assert.equal(validateMentionSubmission({ flavor: 'assign', refs: [twoHumans[1]], roster: r }).ok, true);
  const none = validateMentionSubmission({ flavor: 'ask', refs: [], roster: r });
  assert.equal(none.ok, false);
  assert.equal(none.refusals[0].reason, 'no_addressee');
  const bad = validateMentionSubmission({ flavor: 'dm', refs: [twoHumans[0]], roster: r });
  assert.equal(bad.ok, false);
  assert.equal(bad.refusals[0].reason, 'unknown_flavor');
});

test('submission: an agent FYI is refused instead of becoming a silent no-op', () => {
  const out = validateMentionSubmission({
    flavor: 'mention',
    refs: [{ actor_type: 'agent', agent_id: 'donna', role: 'operator' }],
    roster: roster()
  });
  assert.equal(out.ok, false);
  assert.equal(out.refusals[0].reason, 'agent_requires_ask');
});

test('direct agent chat is structured, eligible, and Donna-only', () => {
  const r = roster();
  const donna = validateDirectAgentChatRef({
    ref: { actor_type: 'agent', agent_id: 'donna', role: 'operator' },
    roster: r
  });
  assert.equal(donna.ok, true);
  assert.equal(donna.resolved[0].agent_id, 'donna');

  const specialist = validateDirectAgentChatRef({
    ref: { actor_type: 'agent', agent_id: 'clara', role: 'collections' },
    roster: r
  });
  assert.equal(specialist.ok, false);
  assert.equal(specialist.refusals[0].reason, 'direct_chat_requires_donna');
});
