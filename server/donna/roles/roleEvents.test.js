// roleEvents (S5) — cross-role events + narration substrate. Pins:
//   - INV-S5, the shape half: the role-event schema is a CLOSED field
//     allowlist — a conversational payload (message/body/text/prompt, or any
//     addressee field) cannot be expressed; validation refuses unknown keys.
//   - INV-S5, the channel half (static): no module in the roles layer, and
//     neither narration home, imports an LLM engine. The only model entry
//     point stays feedChat's ONE compile step; the bench layer is
//     deterministic Keep-layer code. Direct-edge assertions (the K1 allowlist
//     style — no transitive reachability, which this monolith cannot pass).
//   - the trigger-registry wiring: every role event type is REGISTERED in the
//     loop event registry (inbox channel, consumed-or-parked), and every
//     registry event_interest resolves — typed ids, never invented names.
//   - the producer laws: hired-only (the S4 tag law applied to events),
//     attribution by action_set claim, receipt + typed inbox row in the same
//     transaction, savepoint-soft failure (an event must never break an
//     approval), and the transition→shape mapping.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  ROLE_EVENT_TYPES, ROLE_EVENT_TYPE_LIST, ROLE_EVENT_FIELDS,
  ROLE_EVENT_ACTORS, ROLE_EVENT_NEXT_COMMITMENTS, ROLE_EVENT_OUTCOMES,
  validateRoleEvent, recordOutboundRoleTransition, readRoleTeamwork
} from './roleEvents.js';
import { ROLE_DEFINITIONS } from './roleRegistry.js';
import { LOOP_EVENT_REGISTRY, isParked } from '../loopEventRegistry.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// ── mock client (the actionStore.test.js harness style) ─────────────────────

const makeMockClient = (handlers = []) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const text = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      for (const h of handlers) {
        if (text.includes(h.match)) {
          if (h.throw) throw h.throw;
          const rows = typeof h.rows === 'function' ? h.rows({ sql: text, params }) : (h.rows || []);
          return { rows, rowCount: rows.length };
        }
      }
      return { rows: [], rowCount: 0 };
    }
  };
};

const ACTIVE_CLARA = {
  match: 'from client_assignments',
  rows: [{
    id: 'role-assign-1', role: 'invoicing_collections',
    principal_type: 'ai_occupant', principal_id: 'donna_ai',
    ai_profile: 'clara', status: 'active'
  }]
};

const BASE = { firmId: 'firm-1', clientId: 'client-1' };
const REMINDER = { id: 'act-1', action_type: 'send_receivable_reminder' };

const VALID_EVENT = Object.freeze({
  type: 'role.handed_to_owner',
  responsible_role: 'invoicing_collections',
  current_actor: 'owner',
  next_commitment: 'approve_or_decline_send',
  action_type: 'send_receivable_reminder',
  object_type: 'outbound_action',
  object_id: 'act-1',
  occupant: { principal_type: 'ai_occupant', principal_id: 'donna_ai', ai_profile: 'clara' },
  outcome: null,
  reasons: ['stage_below_auto']
});

// ── INV-S5: the shape law ───────────────────────────────────────────────────

test('a valid handoff event passes; a valid resume event passes', () => {
  assert.deepEqual(validateRoleEvent(VALID_EVENT), []);
  assert.deepEqual(validateRoleEvent({
    ...VALID_EVENT,
    type: 'role.resumed_from_owner',
    current_actor: 'ai_occupant',
    next_commitment: 'send_on_next_sweep',
    outcome: 'approved'
  }), []);
});

test('INV-S5: the event shape is CLOSED — conversational fields cannot be expressed', () => {
  for (const field of ['message', 'body', 'text', 'prompt', 'content', 'to_role', 'instruction']) {
    const problems = validateRoleEvent({ ...VALID_EVENT, [field]: 'hi Clara, please chase this' });
    assert.ok(
      problems.some((p) => p.includes('closed') && p.includes(field)),
      `field '${field}' must refuse: ${problems.join('; ')}`
    );
  }
});

test('the vocabulary is closed: type, actor, commitment, outcome, role all validate', () => {
  assert.ok(validateRoleEvent({ ...VALID_EVENT, type: 'role.chatted' }).length > 0);
  assert.ok(validateRoleEvent({ ...VALID_EVENT, responsible_role: 'nope' }).length > 0);
  assert.ok(validateRoleEvent({ ...VALID_EVENT, current_actor: 'assistant' }).length > 0);
  assert.ok(validateRoleEvent({ ...VALID_EVENT, next_commitment: 'whatever comes next' }).length > 0);
  // handed_to_owner carries no outcome; resumed REQUIRES one.
  assert.ok(validateRoleEvent({ ...VALID_EVENT, outcome: 'approved' }).length > 0);
  assert.ok(validateRoleEvent({
    ...VALID_EVENT, type: 'role.resumed_from_owner', outcome: null
  }).length > 0);
  // occupant attribution is mandatory (INV-S7).
  assert.ok(validateRoleEvent({ ...VALID_EVENT, occupant: null }).length > 0);
  assert.ok(validateRoleEvent({ ...VALID_EVENT, reasons: 'free text' }).length > 0);
});

// ── INV-S5: the channel does not exist (static, direct-edge) ────────────────

test('INV-S5: no roles-layer module or narration home imports an LLM engine', () => {
  const narrationHome = join(HERE, '..', '..', '..', 'src', 'lib', 'teamRosterView.js');
  const files = [
    ...readdirSync(HERE)
      .filter((name) => name.endsWith('.js') && !name.endsWith('.test.js'))
      .map((name) => join(HERE, name)),
    narrationHome
  ];
  assert.ok(files.length >= 6, `scan looks broken — only ${files.length} files`);
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const imports = [...source.matchAll(/^import\s[^;]*?from\s+['"]([^'"]+)['"]/gms)]
      .map((m) => m[1]);
    for (const specifier of imports) {
      assert.ok(
        !/transactionChat|anthropic|openai|Llm/i.test(specifier),
        `${file} imports '${specifier}' — the bench layer must never reach a model engine (INV-S5)`
      );
    }
  }
});

// ── the trigger-registry wiring ─────────────────────────────────────────────

test('every role event type is registered in the loop event registry (inbox, consumed-or-parked)', () => {
  for (const type of ROLE_EVENT_TYPE_LIST) {
    const entry = LOOP_EVENT_REGISTRY[type];
    assert.ok(entry, `${type} must be registered in loopEventRegistry`);
    assert.equal(entry.channel, 'inbox', `${type} is a trigger — inbox channel`);
    assert.ok(
      isParked(type) || entry.consumer,
      `${type} must be consumed or explicitly parked`
    );
  }
});

test('collections declares its own lane events as event_interests; registered ids only', () => {
  const collections = ROLE_DEFINITIONS.find((role) => role.id === 'invoicing_collections');
  assert.deepEqual(
    [...collections.event_interests].sort(),
    [...ROLE_EVENT_TYPE_LIST].sort()
  );
  for (const role of ROLE_DEFINITIONS) {
    for (const interest of role.event_interests) {
      assert.ok(LOOP_EVENT_REGISTRY[interest], `${role.id}: interest '${interest}' unregistered`);
    }
  }
});

// ── the producer ────────────────────────────────────────────────────────────

test('hired lane: a handoff records the audit receipt AND the typed inbox row in one flow', async () => {
  const client = makeMockClient([ACTIVE_CLARA]);
  const out = await recordOutboundRoleTransition(client, {
    ...BASE, action: REMINDER, transition: 'handed_to_owner', reasons: ['stage_below_auto']
  });
  assert.equal(out.recorded, true);
  assert.equal(out.type, ROLE_EVENT_TYPES.handedToOwner);
  const audit = client.calls.find((c) => c.sql.includes('insert into audit_events'));
  assert.ok(audit, 'receipt written');
  assert.ok(audit.params.includes('role.handed_to_owner'));
  const metadata = JSON.parse(audit.params[6]);
  assert.equal(metadata.responsible_role, 'invoicing_collections');
  assert.equal(metadata.current_actor, 'owner');
  assert.equal(metadata.next_commitment, 'approve_or_decline_send');
  assert.equal(metadata.occupant.ai_profile, 'clara');
  assert.equal(metadata.role_event_id, out.role_event_id);
  const inbox = client.calls.find((c) => c.sql.includes('insert into loop_event_inbox'));
  assert.ok(inbox, 'typed trigger row written');
  assert.ok(inbox.params.includes('role.handed_to_owner'));
  assert.ok(inbox.params.includes(out.role_event_id), 'receipt and trigger share the role_event_id');
  // savepoint discipline: opened and released.
  assert.ok(client.calls.some((c) => /^savepoint role_event/i.test(c.sql.trim())));
  assert.ok(client.calls.some((c) => /^release savepoint role_event/i.test(c.sql.trim())));
});

test('resume shapes: approved resumes the lane; declined/withdrawn close the item', async () => {
  const approved = makeMockClient([ACTIVE_CLARA]);
  await recordOutboundRoleTransition(approved, {
    ...BASE, action: REMINDER, transition: 'resumed_from_owner',
    outcome: 'approved', actorType: 'owner', actorId: 'kari'
  });
  const approvedMeta = JSON.parse(
    approved.calls.find((c) => c.sql.includes('insert into audit_events')).params[6]
  );
  assert.equal(approvedMeta.type, 'role.resumed_from_owner');
  assert.equal(approvedMeta.current_actor, 'ai_occupant');
  assert.equal(approvedMeta.next_commitment, 'send_on_next_sweep');
  assert.equal(approvedMeta.outcome, 'approved');

  const declined = makeMockClient([ACTIVE_CLARA]);
  await recordOutboundRoleTransition(declined, {
    ...BASE, action: REMINDER, transition: 'resumed_from_owner',
    outcome: 'declined', actorType: 'owner', actorId: 'kari'
  });
  const declinedMeta = JSON.parse(
    declined.calls.find((c) => c.sql.includes('insert into audit_events')).params[6]
  );
  assert.equal(declinedMeta.next_commitment, 'closed');
});

test('unclaimed verb: Donna-core work mints NO role event (no queries at all)', async () => {
  const client = makeMockClient([ACTIVE_CLARA]);
  const out = await recordOutboundRoleTransition(client, {
    ...BASE, action: { id: 'act-2', action_type: 'send_payable_notice' },
    transition: 'handed_to_owner'
  });
  assert.equal(out.recorded, false);
  assert.equal(out.reason, 'unclaimed_action_type');
  assert.equal(client.calls.length, 0);
});

test('un-hired role: no event (the S4 never-invent-a-teammate law), no writes', async () => {
  const client = makeMockClient([]);
  const out = await recordOutboundRoleTransition(client, {
    ...BASE, action: REMINDER, transition: 'handed_to_owner'
  });
  assert.equal(out.recorded, false);
  assert.equal(out.reason, 'role_not_hired');
  assert.ok(!client.calls.some((c) => c.sql.includes('insert into audit_events')));
  assert.ok(!client.calls.some((c) => c.sql.includes('insert into loop_event_inbox')));
});

test('soft failure: a DB error rolls back to the savepoint and reports skipped', async () => {
  const client = makeMockClient([
    ACTIVE_CLARA,
    { match: 'insert into audit_events', throw: new Error('relation is on fire') }
  ]);
  const warnings = [];
  const out = await recordOutboundRoleTransition(client, {
    ...BASE, action: REMINDER, transition: 'handed_to_owner',
    warn: (msg) => warnings.push(msg)
  });
  assert.equal(out.recorded, false);
  assert.equal(out.reason, 'role_event_failed');
  assert.ok(client.calls.some((c) => /^rollback to savepoint role_event/i.test(c.sql.trim())));
  assert.equal(warnings.length, 1);
});

test('an unknown transition is a programming error and throws', async () => {
  const client = makeMockClient([ACTIVE_CLARA]);
  await assert.rejects(
    () => recordOutboundRoleTransition(client, {
      ...BASE, action: REMINDER, transition: 'chat_with_vera'
    }),
    /unknown transition/
  );
});

// ── the narration read ──────────────────────────────────────────────────────

test('readRoleTeamwork renders from the receipts: typed rows, newest first, bounded', async () => {
  const client = makeMockClient([{
    match: 'from audit_events',
    rows: [{
      id: 41, action: 'role.handed_to_owner', actor_type: 'system', actor_id: null,
      metadata: { ...VALID_EVENT, role_event_id: 're-1' }, created_at: 't2'
    }]
  }]);
  const rows = await readRoleTeamwork(client, { ...BASE, limit: 500 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, '41');
  assert.equal(rows[0].type, 'role.handed_to_owner');
  assert.equal(rows[0].at, 't2');
  assert.equal(rows[0].responsible_role, 'invoicing_collections');
  const call = client.calls.find((c) => c.sql.includes('from audit_events'));
  assert.deepEqual(call.params[2], [...ROLE_EVENT_TYPE_LIST]);
  assert.equal(call.params[3], 50, 'limit clamps at 50');
});

// ── vocabulary drift pins ───────────────────────────────────────────────────

test('the closed vocabularies stay closed (growing one is a deliberate edit here)', () => {
  assert.deepEqual([...ROLE_EVENT_TYPE_LIST].sort(),
    ['role.handed_to_owner', 'role.resumed_from_owner']);
  assert.deepEqual([...ROLE_EVENT_ACTORS], ['owner', 'ai_occupant', 'human_occupant']);
  assert.deepEqual([...ROLE_EVENT_NEXT_COMMITMENTS],
    ['approve_or_decline_send', 'decide_collection_next_step', 'send_on_next_sweep', 'closed']);
  assert.deepEqual([...ROLE_EVENT_OUTCOMES], ['approved', 'declined', 'withdrawn']);
  assert.ok(ROLE_EVENT_FIELDS.includes('occupant'), 'occupant attribution stays in the shape (INV-S7)');
});
