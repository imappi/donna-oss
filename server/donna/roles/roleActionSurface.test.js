// roleActionSurface.test.js — S1 of the bench (docs/design-donna-specialist-roles.md
// §5): the coverage audit's machine checks, above all INV-S2(b) — role
// enforcement may not graduate past 'shadow' while the canonical action
// namespace does not cover R1's whole autonomous surface. Pure in-sandbox
// `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  R1_AUTONOMOUS_SURFACE,
  SURFACE_SEAMS,
  CONSEQUENCE_CLASSES,
  SURFACE_OPERATION_TYPES,
  SURFACE_OPERATION_CAPABILITY,
  roleSurfaceCoverageGaps
} from './roleActionSurface.js';
import {
  ROLE_DEFINITIONS, canonicalActionNamespace, findRoleDefinition, roleForActionIdentity
} from './roleRegistry.js';
import {
  requiredCapabilityForAction, REVERSE_ACTION_TYPE, CAPABILITY_CLASSES
} from '../operatorCapability.js';
import { SHADOW_CEILING_FLAGS, AUTO_FORBIDDEN_FLAGS } from '../clientConfig.js';
import { SPECIALIST_ROLE_FLAG_KEY } from './roleAuthority.js';
import { OUTBOUND_ACTION_FLAG_KEYS } from '../outbound/actionGate.js';
import { OUTBOUND_PAY_LINKS_FLAG_KEY } from '../outbound/payLinks.js';
import { REPLY_INGESTION_FLAG_KEY } from '../outbound/replyIngestionCore.js';
import { REFERENCE_CAPTURE_FLAG_KEY } from '../outbound/referenceCapture.js';

test('every surface entry speaks the controlled vocabularies', () => {
  const namespace = new Set(canonicalActionNamespace());
  for (const entry of R1_AUTONOMOUS_SURFACE) {
    assert.ok(SURFACE_SEAMS.includes(entry.seam), `${entry.operation}: seam`);
    assert.ok(Array.isArray(entry.consequences) && entry.consequences.length > 0, `${entry.operation}: consequences`);
    for (const c of entry.consequences) {
      assert.ok(CONSEQUENCE_CLASSES.includes(c), `${entry.operation}: consequence '${c}'`);
    }
    if (entry.identity) {
      assert.ok(namespace.has(entry.identity), `${entry.operation}: identity '${entry.identity}' must be canonical`);
    }
    if (entry.covered_by) {
      assert.ok(namespace.has(entry.covered_by), `${entry.operation}: covered_by '${entry.covered_by}' must be canonical`);
    }
    if (entry.role != null) {
      assert.ok(findRoleDefinition(entry.role), `${entry.operation}: unknown role '${entry.role}'`);
    }
  }
});

test('declared attribution matches the registry claim (roleForActionIdentity) for every identity-carrying entry', () => {
  for (const entry of R1_AUTONOMOUS_SURFACE) {
    if (!entry.identity) continue;
    assert.equal(
      roleForActionIdentity(entry.identity), entry.role,
      `${entry.operation}: inventory says role '${entry.role}', the action_set claim says '${roleForActionIdentity(entry.identity)}'`
    );
  }
});

test('the namespace closure carries exactly the audited non-S0 identities, reverse_apply pinned to the capability constant', () => {
  assert.deepEqual([...SURFACE_OPERATION_TYPES].sort(), [
    'capture_structured_reference', 'create_pay_link',
    'graduate_earned_auto', 'record_reply_correction', 'reverse_apply'
  ]);
  assert.ok(SURFACE_OPERATION_TYPES.includes(REVERSE_ACTION_TYPE));
});

test('the capability ladder agrees with every declared surface requirement (one owner for "which class may invoke")', () => {
  for (const [verb, cls] of Object.entries(SURFACE_OPERATION_CAPABILITY)) {
    assert.ok(CAPABILITY_CLASSES.includes(cls), `${verb}: class '${cls}'`);
    assert.equal(requiredCapabilityForAction(verb), cls, verb);
  }
  // Authority promotion and the reverse executor stay founder-only.
  assert.equal(SURFACE_OPERATION_CAPABILITY.graduate_earned_auto, 'founder');
  assert.equal(SURFACE_OPERATION_CAPABILITY.reverse_apply, 'founder');
});

test('the surface flag keys are the real modules’ flag keys (no drift between audit and code)', () => {
  const byIdentity = Object.fromEntries(
    R1_AUTONOMOUS_SURFACE.filter((e) => e.identity).map((e) => [e.identity, e.flag_key])
  );
  assert.equal(byIdentity.issue_invoice, OUTBOUND_ACTION_FLAG_KEYS.issue_invoice);
  assert.equal(byIdentity.send_quote, OUTBOUND_ACTION_FLAG_KEYS.send_quote);
  assert.equal(byIdentity.send_receivable_reminder, OUTBOUND_ACTION_FLAG_KEYS.send_receivable_reminder);
  assert.equal(byIdentity.send_payable_notice, OUTBOUND_ACTION_FLAG_KEYS.send_payable_notice);
  assert.equal(byIdentity.create_pay_link, OUTBOUND_PAY_LINKS_FLAG_KEY);
  assert.equal(byIdentity.record_reply_correction, REPLY_INGESTION_FLAG_KEY);
  assert.equal(byIdentity.capture_structured_reference, REFERENCE_CAPTURE_FLAG_KEY);
});

test('no role may hold graduate_earned_auto, and send_payable_notice stays deliberately unclaimed', () => {
  for (const role of ROLE_DEFINITIONS) {
    assert.ok(!role.action_set.includes('graduate_earned_auto'), role.id);
    assert.ok(!role.action_set.includes('send_payable_notice'), role.id);
  }
});

test('INV-S2(b): coverage gaps hold the shadow ceiling down — and today the surface is covered', () => {
  const gaps = roleSurfaceCoverageGaps();
  // THE LAW: while any consequential operation lacks a canonical identity or
  // an unwired decision site, SPECIALIST_ROLE_ENFORCE must sit in
  // SHADOW_CEILING_FLAGS so no writer can stage it to canary/auto. Lifting
  // the ceiling (a deliberate, dated graduation PR editing that set) is only
  // legal once this list is empty AND the shadow observation window has run.
  if (gaps.length > 0) {
    assert.ok(
      SHADOW_CEILING_FLAGS.has(SPECIALIST_ROLE_FLAG_KEY),
      `coverage gaps exist (${gaps.map((g) => g.operation).join('; ')}) — the flag must stay shadow-ceilinged`
    );
  }
  // The S1 audit closed every gap it found; a regression here means a new
  // operation entered the surface without an identity/wiring — fix the
  // operation or record it honestly, never delete this assertion.
  assert.deepEqual(gaps, [], 'the audited surface is covered');
  // Current posture: the ceiling stays ON regardless (the observation window
  // has not run; graduation is Kari's dated call). Removing the flag from
  // SHADOW_CEILING_FLAGS must edit this line in the same PR — deliberately.
  assert.ok(SHADOW_CEILING_FLAGS.has(SPECIALIST_ROLE_FLAG_KEY));
  // And the flag is not (redundantly) in AUTO_FORBIDDEN — the ceiling subsumes it.
  assert.ok(!AUTO_FORBIDDEN_FLAGS.has(SPECIALIST_ROLE_FLAG_KEY));
});

test('every send identity in the surface is leash-checked at the executor; sweep identities at their module entries', () => {
  for (const entry of R1_AUTONOMOUS_SURFACE) {
    if (!entry.identity) continue;
    assert.equal(entry.wired, true, `${entry.operation}: decision site must be wired`);
    assert.ok(entry.decision_site && entry.decision_site.length > 0, entry.operation);
  }
});
