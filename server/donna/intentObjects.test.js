// Tests for the proposed-intent-object contract (BizOS Slice 1b) — the hostile fixtures the
// addendum §9 demands: unknown kind, unregistered capability ids (discarded-and-recorded,
// never a rejection), dangling/self links, duplicate local_ids, model-computed timestamps
// inside a relative time_spec, authority-grant effectiveness claims, closed-envelope
// violations — plus the canonical birthday example and partial-success semantics.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  INTENT_COMPILE_CONTRACT_VERSION,
  INTENT_OBJECT_KINDS,
  INTENT_LINK_RELS,
  PARSE_CONFIDENCES,
  INTENT_VALIDATOR_VERSION,
  validateTimeSpec,
  validateProposedIntentObject,
  validateCompiledObjects,
  validateIntentCompileResult,
  intentCompileId
} from './intentObjects.js';
import { capabilityRegistryFingerprint } from './capabilityRegistry.js';

const ref = { message_id: 'msg-1', verbatim_span: 'remember Alex’s birthday is 14 July and remind me 18h before' };

// The canonical worked example (addendum §5): memory + commitment + automation. The
// commitment is Donna's accountable promise; the automation is the triggering mechanism.
const birthdayCandidates = () => ([
  {
    local_id: 'o1',
    kind: 'memory',
    summary: "Alex's birthday is 14 July (user-private)",
    payload: { statement: "Alex's birthday is 14 July", time_spec: { type: 'absolute', iso_date: '--07-14' } },
    links: [],
    // memory.remember.v1 IS registered (the Slice-2a memory pack) → retained;
    // crm.create_contact.v1 is not → unmet need, NOT a rejection.
    candidate_capabilities: ['memory.remember.v1', 'crm.create_contact.v1'],
    source_refs: [ref],
    parse_confidence: 'high'
  },
  {
    local_id: 'o2',
    kind: 'commitment',
    summary: 'Remind Kari 18h before the birthday',
    payload: { promise: 'Deliver a reminder 18 hours before the birthday' },
    links: [{ rel: 'reminds_about', local_id: 'o1' }],
    source_refs: [ref],
    parse_confidence: 'high'
  },
  {
    local_id: 'o3',
    kind: 'automation',
    summary: 'At T-18h, deliver the reminder',
    payload: {
      action_summary: 'Deliver an owner notification',
      // A structured offset the runtime resolves — never a model-computed instant.
      trigger: { time_spec: { type: 'relative', offset_amount: 18, offset_unit: 'hours', anchor: 'o1' } }
    },
    links: [{ rel: 'fulfills', local_id: 'o2' }],
    source_refs: [ref],
    parse_confidence: 'medium'
  }
]);

test('the taxonomy is exactly the nine amended kinds, commitment included', () => {
  assert.deepEqual([...INTENT_OBJECT_KINDS], [
    'memory', 'preference', 'policy', 'goal', 'commitment',
    'task', 'automation', 'workflow', 'authority_grant'
  ]);
  assert.equal(INTENT_COMPILE_CONTRACT_VERSION, 'intent_compile.v1');
});

test('the birthday example compiles: three linked candidates, unmet need recorded, none rejected', () => {
  const { objects, validationWarnings, unmetCapabilityNeeds } = validateCompiledObjects(birthdayCandidates());
  assert.equal(objects.length, 3);
  assert.equal(validationWarnings.length, 0);
  // The registered memory capability is RETAINED; the unregistered crm id is discarded + recorded.
  assert.deepEqual(unmetCapabilityNeeds, [{ local_id: 'o1', capability: 'crm.create_contact.v1' }]);
  assert.deepEqual([...objects.find((o) => o.local_id === 'o1').candidate_capabilities], ['memory.remember.v1']);
});

test('a registered capability id is RETAINED on the candidate', () => {
  const candidate = {
    ...birthdayCandidates()[0],
    candidate_capabilities: ['finance.apply_category.v1', 'made.up.v1']
  };
  const { sanitized, errors, unmetCapabilityNeeds } = validateProposedIntentObject(candidate);
  assert.deepEqual(errors, []);
  assert.deepEqual([...sanitized.candidate_capabilities], ['finance.apply_category.v1']);
  assert.deepEqual(unmetCapabilityNeeds, [{ local_id: 'o1', capability: 'made.up.v1' }]);
});

test('an unsupported request still compiles — a task with only unmet needs is valid', () => {
  const { objects, unmetCapabilityNeeds } = validateCompiledObjects([{
    local_id: 't1',
    kind: 'task',
    summary: 'Send Alex the signed contract',
    payload: { outcome: 'Alex has received the signed contract by email' },
    links: [],
    candidate_capabilities: ['communications.send_email.v1'],
    source_refs: [ref],
    parse_confidence: 'medium'
  }]);
  assert.equal(objects.length, 1, 'the intent must be preserved even when Donna cannot yet execute it');
  assert.equal(unmetCapabilityNeeds.length, 1);
});

test('partial success: one malformed candidate never destroys the valid ones', () => {
  const bad = { local_id: 'oX', kind: 'operational_fact', summary: 'the rejected A1 shape', payload: {}, source_refs: [ref], parse_confidence: 'low' };
  const { objects, validationWarnings } = validateCompiledObjects([...birthdayCandidates(), bad]);
  assert.equal(objects.length, 3);
  assert.equal(validationWarnings.length, 1);
  assert.equal(validationWarnings[0].local_id, 'oX');
  assert.ok(validationWarnings[0].errors.some((e) => e.includes('operational_fact')));
});

test('a relative time_spec carrying a resolved instant is refused (the runtime owns time arithmetic)', () => {
  assert.deepEqual(validateTimeSpec({ type: 'relative', offset_amount: 18, offset_unit: 'hours', anchor: 'o1' }), []);
  const poisoned = validateTimeSpec({
    type: 'relative', offset_amount: 18, offset_unit: 'hours', anchor: 'o1',
    iso_datetime: '2026-07-13T18:00:00Z'
  });
  assert.ok(poisoned.some((e) => e.includes('resolved instant')));
  assert.ok(validateTimeSpec({ type: 'sometime' }).length > 0);
  assert.ok(validateTimeSpec({ type: 'relative', offset_amount: -3, offset_unit: 'hours', anchor: 'o1' }).length > 0);
});

test('a compiled authority_grant claiming effectiveness is refused; a grant REQUEST passes', () => {
  const base = {
    local_id: 'g1',
    kind: 'authority_grant',
    summary: 'Reorder from approved suppliers up to €500',
    payload: { requested_scope: 'place POs with approved suppliers, ≤ €500 each' },
    links: [],
    source_refs: [ref],
    parse_confidence: 'medium'
  };
  assert.deepEqual(validateProposedIntentObject(base).errors, []);
  for (const field of ['effective', 'granted', 'active', 'approved']) {
    const claimed = { ...base, payload: { ...base.payload, [field]: true } };
    const { errors } = validateProposedIntentObject(claimed);
    assert.ok(errors.some((e) => e.includes('grant REQUEST')), `"${field}" must be refused`);
  }
});

test('dangling links strand transitively (fixpoint), and a self-link dangles', () => {
  const candidates = birthdayCandidates();
  candidates[0].links = [{ rel: 'depends_on', local_id: 'missing' }]; // o1 dangles →
  const { objects, validationWarnings } = validateCompiledObjects(candidates);
  // o2 linked o1, o3 linked o2 — the strand cascades to all three.
  assert.equal(objects.length, 0);
  assert.equal(validationWarnings.length, 3);

  const selfLinked = [{
    ...birthdayCandidates()[0],
    links: [{ rel: 'supersedes', local_id: 'o1' }]
  }];
  const res = validateCompiledObjects(selfLinked);
  assert.equal(res.objects.length, 0);
  assert.ok(res.validationWarnings[0].errors[0].includes('dangling'));
});

test('a duplicate local_id rejects the later occurrence only', () => {
  const [memory] = birthdayCandidates();
  const dupe = { ...memory, summary: 'a second o1' };
  const { objects, validationWarnings } = validateCompiledObjects([memory, dupe]);
  assert.equal(objects.length, 1);
  assert.equal(validationWarnings.length, 1);
  assert.ok(validationWarnings[0].errors[0].includes('duplicates'));
});

test('the closed envelope refuses unknown fields, and every field is validated', () => {
  const smuggled = { ...birthdayCandidates()[0], execute_now: true };
  assert.ok(validateProposedIntentObject(smuggled).errors.some((e) => e.includes('closed envelope')));
  assert.ok(validateProposedIntentObject({ ...birthdayCandidates()[0], source_refs: [] }).errors.length > 0);
  assert.ok(validateProposedIntentObject({ ...birthdayCandidates()[0], parse_confidence: 0.97 }).errors.length > 0);
  assert.ok(PARSE_CONFIDENCES.includes('medium'));
  assert.ok(INTENT_LINK_RELS.includes('reminds_about'));
});

test('per-kind payload floors hold (no vaguely-typed blob compiles)', () => {
  const cases = [
    ['memory', {}], ['preference', {}], ['policy', {}], ['goal', {}],
    ['commitment', {}], ['task', {}], ['workflow', { steps: [] }],
    ['automation', { action_summary: 'x', trigger: {} }]
  ];
  for (const [kind, payload] of cases) {
    const { errors } = validateProposedIntentObject({
      local_id: 'k1', kind, summary: 's', payload, links: [], source_refs: [ref], parse_confidence: 'low'
    });
    assert.ok(errors.length > 0, `${kind} accepted an empty payload`);
  }
});

test('intentCompileId is deterministic over the five key inputs and refuses partial keys', () => {
  const key = {
    sourceMessageId: 'msg-1',
    promptVersion: 'p1',
    modelId: 'claude-opus-4-8',
    registryFingerprint: capabilityRegistryFingerprint()
  };
  const id1 = intentCompileId(key);
  assert.equal(id1, intentCompileId({ ...key }));
  assert.match(id1, /^ic-[0-9a-f]{64}$/);
  assert.notEqual(id1, intentCompileId({ ...key, promptVersion: 'p2' }));
  assert.notEqual(id1, intentCompileId({ ...key, modelId: 'other-model' }));
  assert.throws(() => intentCompileId({ sourceMessageId: 'msg-1' }));
});

test('the compile-result envelope validates end to end (the proto-receipt is reconstructible)', () => {
  const fingerprint = capabilityRegistryFingerprint();
  const { objects, validationWarnings, unmetCapabilityNeeds } = validateCompiledObjects(birthdayCandidates());
  const result = {
    contract_version: INTENT_COMPILE_CONTRACT_VERSION,
    compile_id: intentCompileId({
      sourceMessageId: 'msg-1', promptVersion: 'p1', modelId: 'claude-opus-4-8', registryFingerprint: fingerprint
    }),
    source_message_id: 'msg-1',
    objects,
    clarification_requests: [{ question: 'Which Alex — Alex Chen or Alex Morgan?', affected_local_ids: ['o1'] }],
    unsupported_spans: [],
    unmet_capability_needs: unmetCapabilityNeeds,
    validation_warnings: validationWarnings,
    model_id: 'claude-opus-4-8',
    prompt_version: 'p1',
    validator_version: INTENT_VALIDATOR_VERSION,
    registry_fingerprint: fingerprint,
    config_snapshot_id: 'cfg-abc',
    token_usage: { input: 1200, output: 400 },
    latency_ms: 2100,
    failure_category: null
  };
  assert.deepEqual(validateIntentCompileResult(result), []);
  // Missing receipt fields, wrong version, foreign clarification ids, smuggled fields: refused.
  assert.ok(validateIntentCompileResult({ ...result, model_id: '' }).length > 0);
  assert.ok(validateIntentCompileResult({ ...result, contract_version: 'intent_compile.v2' }).length > 0);
  assert.ok(validateIntentCompileResult({
    ...result,
    clarification_requests: [{ question: 'q?', affected_local_ids: ['not-in-this-compile'] }]
  }).some((e) => e.includes('not from this compile')));
  assert.ok(validateIntentCompileResult({ ...result, auto_execute: true }).some((e) => e.includes('closed envelope')));
});
