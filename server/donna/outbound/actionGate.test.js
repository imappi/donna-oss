// Outbound action gate (M0.4, G3 — plan A2). Pins:
//   - born OFF on the config plane: no snapshot row ⇒ mode off, blocked
//     'flag_off' (envFallback () => false — no legacy env predicate exists);
//   - hard blocks (suppression, do_not_contact, no recipient, settled anchor)
//     bind at EVERY stage — no stage and no approval overrides them;
//   - stage semantics are STRICTER than stageActs: canary still holds for
//     owner approval; only 'auto' reaches auto_execute (the earned terminal);
//   - a reminder without an explicit 'unpaid' paid-truth verdict never
//     auto-executes: missing/ambiguous ⇒ hold (ambiguity holds, never sends);
//   - the auto lane has a confidence floor;
//   - 'hold_for_internal_review' is reserved-unused (D1 open): the classifier
//     NEVER emits it, across the whole input matrix;
//   - the four flag keys sit in AUTO_FORBIDDEN_FLAGS and the guarded config
//     writer refuses to persist their 'auto' stage (the A2 guard).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyOutboundAction, outboundGateMode, outboundFlagKeyForAction,
  OUTBOUND_ACTION_FLAG_KEYS, OUTBOUND_ACTION_TYPES, OUTBOUND_GATE_VERDICTS,
  OUTBOUND_AUTO_CONFIDENCE_FLOOR
} from './actionGate.js';
import { AUTO_FORBIDDEN_FLAGS, assertStageAllowedForFlag } from '../clientConfig.js';

const ENV = {};
const snapshotAt = (stage, flagKey = 'OUTBOUND_DUNNING') => ({ [flagKey]: { stage, source: 'test' } });

test('born off: no snapshot row means mode off and blocked flag_off', () => {
  for (const actionType of OUTBOUND_ACTION_TYPES) {
    const verdict = classifyOutboundAction({ actionType, snapshot: {}, env: ENV, paidTruth: 'unpaid', confidence: 0.99 });
    assert.equal(verdict.mode, 'off', `${actionType} mode off`);
    assert.equal(verdict.verdict, 'blocked');
    assert.deepEqual(verdict.reasons, ['flag_off']);
  }
});

test('unknown action type is blocked', () => {
  const verdict = classifyOutboundAction({ actionType: 'send_marketing_blast', snapshot: snapshotAt('auto') });
  assert.equal(verdict.verdict, 'blocked');
  assert.deepEqual(verdict.reasons, ['unknown_action_type']);
});

test('hard blocks bind at every stage — no stage overrides them', () => {
  for (const stage of ['shadow', 'canary', 'auto']) {
    const suppressed = classifyOutboundAction({
      actionType: 'send_receivable_reminder', snapshot: snapshotAt(stage), env: ENV,
      suppressed: true, paidTruth: 'unpaid', confidence: 0.99
    });
    assert.equal(suppressed.verdict, 'blocked', `suppressed blocks at ${stage}`);
    assert.ok(suppressed.reasons.includes('recipient_suppressed'));

    const dnc = classifyOutboundAction({
      actionType: 'send_receivable_reminder', snapshot: snapshotAt(stage), env: ENV,
      doNotContact: true, paidTruth: 'unpaid', confidence: 0.99
    });
    assert.ok(dnc.reasons.includes('party_do_not_contact'));

    const settled = classifyOutboundAction({
      actionType: 'send_receivable_reminder', snapshot: snapshotAt(stage), env: ENV,
      paidTruth: 'settled', confidence: 0.99
    });
    assert.ok(settled.reasons.includes('already_settled'), `settled blocks at ${stage}`);

    const noChannel = classifyOutboundAction({
      actionType: 'send_receivable_reminder', snapshot: snapshotAt(stage), env: ENV,
      hasRecipient: false, paidTruth: 'unpaid', confidence: 0.99
    });
    assert.ok(noChannel.reasons.includes('no_recipient_channel'));
  }
});

test('canary holds for owner approval; only auto reaches auto_execute', () => {
  const canary = classifyOutboundAction({
    actionType: 'send_receivable_reminder', snapshot: snapshotAt('canary'), env: ENV,
    paidTruth: 'unpaid', confidence: 0.99
  });
  assert.equal(canary.mode, 'act');
  assert.equal(canary.verdict, 'hold_for_approval');
  assert.deepEqual(canary.reasons, ['stage_below_auto']);

  const auto = classifyOutboundAction({
    actionType: 'send_receivable_reminder', snapshot: snapshotAt('auto'), env: ENV,
    paidTruth: 'unpaid', confidence: 0.99
  });
  assert.equal(auto.verdict, 'auto_execute');
  assert.deepEqual(auto.reasons, []);
});

test('a reminder without explicit unpaid paid-truth never auto-executes', () => {
  const missing = classifyOutboundAction({
    actionType: 'send_receivable_reminder', snapshot: snapshotAt('auto'), env: ENV,
    paidTruth: null, confidence: 0.99
  });
  assert.equal(missing.verdict, 'hold_for_approval');
  assert.deepEqual(missing.reasons, ['paid_truth_missing']);

  const ambiguous = classifyOutboundAction({
    actionType: 'send_receivable_reminder', snapshot: snapshotAt('auto'), env: ENV,
    paidTruth: 'ambiguous', confidence: 0.99
  });
  assert.deepEqual(ambiguous.reasons, ['paid_truth_ambiguous']);
});

test('paid-truth does not gate non-reminder actions', () => {
  const invoice = classifyOutboundAction({
    actionType: 'issue_invoice', snapshot: snapshotAt('auto', 'OUTBOUND_INVOICING'), env: ENV,
    paidTruth: null, confidence: 0.99
  });
  assert.equal(invoice.verdict, 'auto_execute');
});

test('the auto lane has a confidence floor — satisfied by a deterministic paid-truth verdict (D1)', () => {
  // D1's confidence clause (§4, RESOLVED 2026-07-24): an explicit 'unpaid'
  // from the guard IS the auto confidence — the detector's null-confidence
  // reminder mints must not hold a graduated client.
  const deterministic = classifyOutboundAction({
    actionType: 'send_receivable_reminder', snapshot: snapshotAt('auto'), env: ENV,
    paidTruth: 'unpaid', confidence: null
  });
  assert.equal(deterministic.verdict, 'auto_execute');
  const lowButDeterministic = classifyOutboundAction({
    actionType: 'send_receivable_reminder', snapshot: snapshotAt('auto'), env: ENV,
    paidTruth: 'unpaid', confidence: OUTBOUND_AUTO_CONFIDENCE_FLOOR - 0.01
  });
  assert.equal(lowButDeterministic.verdict, 'auto_execute');
  // The numeric floor still binds action types WITHOUT a deterministic
  // verdict: an issuance at auto with low or missing confidence holds.
  for (const confidence of [OUTBOUND_AUTO_CONFIDENCE_FLOOR - 0.01, null]) {
    const held = classifyOutboundAction({
      actionType: 'issue_invoice', snapshot: snapshotAt('auto', 'OUTBOUND_INVOICING'), env: ENV,
      paidTruth: null, confidence
    });
    assert.equal(held.verdict, 'hold_for_approval');
    assert.deepEqual(held.reasons, ['confidence_below_auto_floor']);
  }
});

test('shadow observes without acting; off and dry_run stay dark (plane semantics)', () => {
  assert.equal(outboundGateMode({
    actionType: 'send_receivable_reminder', snapshot: snapshotAt('shadow'), env: ENV
  }).mode, 'shadow');
  for (const stage of ['off', 'dry_run']) {
    assert.equal(outboundGateMode({
      actionType: 'send_receivable_reminder', snapshot: snapshotAt(stage), env: ENV
    }).mode, 'off', `${stage} stays dark`);
  }
});

test('CLIENT_CONFIG_FORCE_DISABLE kills the gate (env can kill, never enable)', () => {
  const verdict = classifyOutboundAction({
    actionType: 'send_receivable_reminder', snapshot: snapshotAt('auto'),
    env: { CLIENT_CONFIG_FORCE_DISABLE: 'OUTBOUND_DUNNING' },
    paidTruth: 'unpaid', confidence: 0.99
  });
  assert.equal(verdict.mode, 'off');
  assert.equal(verdict.verdict, 'blocked');
});

test('hold_for_internal_review is reserved-unused: never emitted across the matrix (D1 open)', () => {
  assert.ok(OUTBOUND_GATE_VERDICTS.includes('hold_for_internal_review'), 'value reserved in the vocabulary');
  const stages = [null, 'off', 'dry_run', 'shadow', 'canary', 'auto'];
  const bools = [true, false];
  const truths = [null, 'unpaid', 'ambiguous', 'settled'];
  for (const actionType of [...OUTBOUND_ACTION_TYPES, 'bogus']) {
    for (const stage of stages) {
      for (const suppressed of bools) {
        for (const doNotContact of bools) {
          for (const hasRecipient of bools) {
            for (const paidTruth of truths) {
              for (const confidence of [null, 0.5, 0.99]) {
                const verdict = classifyOutboundAction({
                  actionType, env: ENV,
                  snapshot: stage ? snapshotAt(stage, outboundFlagKeyForAction(actionType) || 'X') : {},
                  suppressed, doNotContact, hasRecipient, paidTruth, confidence
                });
                assert.notEqual(verdict.verdict, 'hold_for_internal_review');
                assert.ok(OUTBOUND_GATE_VERDICTS.includes(verdict.verdict));
              }
            }
          }
        }
      }
    }
  }
});

test('all four flag keys are auto-forbidden and the guarded writer refuses their auto stage', () => {
  for (const flagKey of Object.values(OUTBOUND_ACTION_FLAG_KEYS)) {
    assert.ok(AUTO_FORBIDDEN_FLAGS.has(flagKey), `${flagKey} in AUTO_FORBIDDEN_FLAGS`);
    assert.throws(() => assertStageAllowedForFlag(flagKey, 'auto'), /not approved/);
    assert.doesNotThrow(() => assertStageAllowedForFlag(flagKey, 'canary'));
  }
});
