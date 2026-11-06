// Authority-envelope classifier — unit tests (Accounting Runtime Hardening, Slice G).
//
// Load-bearing properties (the FIRST principle + the no-third-spine GUARD, CLAUDE.md):
//   - every classification rests at exactly one of the two terminals (auto_reconcile /
//     escalate_to_owner) or surfaces a must-fix (blocked) — never a firm-limbo third state;
//   - fail-closed: any doubt (no verdict, unknown stay reason, first-use) escalates to the
//     owner, never to an unattended commit;
//   - a covering grant auto-reconciles ONLY when this classifier's own flag stage acts
//     (canary/auto) — off/dry_run/shadow classify but do not act;
//   - the per-scope materiality threshold derives from the most-conservative ACTIVE grant
//     ceiling, and a corrected / non-active / no grant yields null (→ honest unknown band);
//   - the classifier never re-implements the store's row guards: presence of coveringGrant
//     is trusted as proof they passed.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyAuthorityEnvelope,
  renderAuthorityEnvelopeFromAuthorization,
  matchVerdictFromAuthorization,
  materialityThresholdFromGrants,
  AUTHORITY_ENVELOPES,
  AUTHORITY_ENVELOPE_CHECK_STATUS,
  AUTHORITY_ENVELOPE_FLAG_KEY
} from './authorityEnvelope.js';

// A buildCommit-shaped verdict (accountingDiff.buildCommit output).
const commit = (over = {}) => ({
  status: 'pass',
  can_apply: true,
  can_auto_commit: true,
  disposition: 'commit',
  reason: 'all_checks_pass',
  ...over
});

const heldOnAuthority = () => ({
  status: 'requires_review',
  can_apply: true,
  can_auto_commit: false,
  disposition: 'stay_proposed',
  reason: 'requires_review_authority'
});

const activeGrant = (over = {}) => ({
  id: 'recon-grant-honeybee-rent-abc123',
  status: 'active',
  correction_count: 0,
  scope_kind: 'counterparty',
  scope_key: 'landlord:acme-properties',
  archetype: 'recurring_rent_lease',
  amount_ceiling: 5000,
  currency: 'USD',
  provenance: { secret: 'do-not-echo' },
  authorized_by_actor_id: 'should-not-echo',
  ...over
});

// ── two-terminal-states: every verdict is a sanctioned terminal or a surfaced must-fix ──

test('every envelope value is in the closed vocabulary', () => {
  assert.deepEqual(AUTHORITY_ENVELOPES, ['auto_reconcile', 'escalate_to_owner', 'blocked']);
});

test('checks-pass commit auto-reconciles without a grant (not authority-gated)', () => {
  const v = classifyAuthorityEnvelope({ commit: commit() });
  assert.equal(v.envelope, 'auto_reconcile');
  assert.equal(v.terminal_target, 'auto_reconciled');
  assert.equal(v.authority_source, null);
  assert.equal(v.can_act, true); // permitted by its own checks; classifier stage does not hold it
});

test('warnings-only commit auto-reconciles without a grant', () => {
  const v = classifyAuthorityEnvelope({
    commit: commit({ status: 'warning', reason: 'warnings_only' })
  });
  assert.equal(v.envelope, 'auto_reconcile');
  assert.equal(v.can_act, true);
  assert.equal(v.reason, 'warnings_only');
});

test('blocking check → blocked (a must-fix surface, never a resting terminal)', () => {
  const v = classifyAuthorityEnvelope({
    commit: commit({ status: 'fail', can_apply: false, can_auto_commit: false, disposition: 'stay_proposed', reason: 'blocking_check_failed' })
  });
  assert.equal(v.envelope, 'blocked');
  assert.equal(v.terminal_target, null);
  assert.equal(v.can_act, false);
});

// ── the materiality-held line: the authority envelope's whole job ──

test('material hold + covering grant + stage auto → auto-reconcile via delegated authority', () => {
  const v = classifyAuthorityEnvelope({
    commit: heldOnAuthority(),
    coveringGrant: activeGrant(),
    configStage: 'auto'
  });
  assert.equal(v.envelope, 'auto_reconcile');
  assert.equal(v.terminal_target, 'auto_reconciled');
  assert.equal(v.authority_source, 'delegated_grant');
  assert.equal(v.can_act, true);
  assert.equal(v.reason, 'delegated_authority_grant');
  assert.equal(v.materiality_threshold, 5000);
  assert.equal(v.grant.id, 'recon-grant-honeybee-rent-abc123');
});

test('material hold + covering grant but stage shadow → classify but DO NOT act', () => {
  const v = classifyAuthorityEnvelope({
    commit: heldOnAuthority(),
    coveringGrant: activeGrant(),
    configStage: 'shadow'
  });
  assert.equal(v.envelope, 'auto_reconcile');
  assert.equal(v.authority_source, 'delegated_grant');
  assert.equal(v.can_act, false); // fail-closed: the classifier's flag isn't live yet
  assert.equal(v.reason, 'delegated_authority_grant_stage_observe');
});

test('material hold + covering grant but stage off → does not act', () => {
  const v = classifyAuthorityEnvelope({
    commit: heldOnAuthority(),
    coveringGrant: activeGrant(),
    configStage: 'off'
  });
  assert.equal(v.can_act, false);
  assert.equal(v.stage_acts, false);
});

test('material hold, NO covering grant → escalate to owner (terminal 2)', () => {
  const v = classifyAuthorityEnvelope({
    commit: heldOnAuthority(),
    coveringGrant: null,
    configStage: 'auto'
  });
  assert.equal(v.envelope, 'escalate_to_owner');
  assert.equal(v.terminal_target, 'owner_clarification');
  assert.equal(v.authority_source, null);
  assert.equal(v.can_act, false);
  assert.equal(v.reason, 'no_covering_grant');
});

test('first-use account is never auto-reconciled even with a covering grant', () => {
  const v = classifyAuthorityEnvelope({
    commit: heldOnAuthority(),
    coveringGrant: activeGrant(),
    configStage: 'auto',
    firstUseAccountInvolved: true
  });
  assert.equal(v.envelope, 'escalate_to_owner');
  assert.equal(v.reason, 'first_use_account');
  assert.equal(v.can_act, false);
});

// ── fail-closed defaults ──

test('no commit verdict → escalate to owner, never auto', () => {
  const v = classifyAuthorityEnvelope({});
  assert.equal(v.envelope, 'escalate_to_owner');
  assert.equal(v.reason, 'no_commit_verdict');
  assert.equal(v.can_act, false);
});

test('stay_proposed for a non-authority reason is not ours to auto-clear → owner', () => {
  const v = classifyAuthorityEnvelope({
    commit: { status: 'requires_review', can_auto_commit: false, disposition: 'stay_proposed', reason: 'some_other_hold' },
    coveringGrant: activeGrant(),
    configStage: 'auto'
  });
  assert.equal(v.envelope, 'escalate_to_owner');
  assert.equal(v.reason, 'stay_proposed:some_other_hold');
  assert.equal(v.can_act, false);
});

test('two-terminal-states ON COMMIT: a would_leave_row_hanging commit (checks pass) escalates to owner', () => {
  // The Slice-E commit verdict now holds a clean-checks apply that would leave the
  // row hanging. Even at configStage 'auto' and with a covering grant, this is NOT
  // the materiality hold the envelope may auto-clear — nothing may rest hanging, so
  // it routes to the owner terminal (never silently auto-reconciles into limbo).
  const v = classifyAuthorityEnvelope({
    commit: { status: 'pass', can_auto_commit: false, disposition: 'stay_proposed', reason: 'would_leave_row_hanging', leaves_row_hanging: true },
    coveringGrant: activeGrant(),
    configStage: 'auto'
  });
  assert.equal(v.envelope, 'escalate_to_owner');
  assert.equal(v.reason, 'stay_proposed:would_leave_row_hanging');
  assert.equal(v.can_act, false);
});

test('unknown config stage fails closed (does not act)', () => {
  const v = classifyAuthorityEnvelope({
    commit: heldOnAuthority(),
    coveringGrant: activeGrant(),
    configStage: 'totally-bogus'
  });
  assert.equal(v.stage_acts, false);
  assert.equal(v.can_act, false);
});

// ── the receipt must not leak grant secrets ──

test('echoed grant carries only reconstructable fields, never provenance/actor', () => {
  const v = classifyAuthorityEnvelope({
    commit: heldOnAuthority(),
    coveringGrant: activeGrant(),
    configStage: 'auto'
  });
  assert.deepEqual(Object.keys(v.grant).sort(), ['amount_ceiling', 'archetype', 'currency', 'id', 'scope_key', 'scope_kind']);
  assert.equal('provenance' in v.grant, false);
  assert.equal('authorized_by_actor_id' in v.grant, false);
});

// ── materialityThresholdFromGrants: the riskContext source for the case snapshot ──

test('threshold is the most-conservative active grant ceiling', () => {
  const grants = [activeGrant({ amount_ceiling: 5000 }), activeGrant({ id: 'g2', amount_ceiling: 1200 })];
  assert.equal(materialityThresholdFromGrants(grants), 1200);
});

test('corrected / non-active / non-positive grants are ignored', () => {
  assert.equal(materialityThresholdFromGrants([activeGrant({ correction_count: 1 })]), null);
  assert.equal(materialityThresholdFromGrants([activeGrant({ status: 'suspended' })]), null);
  assert.equal(materialityThresholdFromGrants([activeGrant({ amount_ceiling: 0 })]), null);
  assert.equal(materialityThresholdFromGrants([activeGrant({ amount_ceiling: -10 })]), null);
});

test('no grants → null threshold (snapshot keeps honest unknown band)', () => {
  assert.equal(materialityThresholdFromGrants([]), null);
  assert.equal(materialityThresholdFromGrants(null), null);
  assert.equal(materialityThresholdFromGrants(undefined), null);
});

test('a single grant (not an array) is accepted', () => {
  assert.equal(materialityThresholdFromGrants(activeGrant({ amount_ceiling: 750 })), 750);
});

test('the capability flag key is the plan §7 key', () => {
  assert.equal(AUTHORITY_ENVELOPE_FLAG_KEY, 'AUTHORITY_ENVELOPE_CLASSIFIER');
});

test('AUTHORITY_ENVELOPE_CHECK_STATUS maps every envelope to a valid CHECK status', () => {
  assert.equal(AUTHORITY_ENVELOPE_CHECK_STATUS.auto_reconcile, 'pass');
  assert.equal(AUTHORITY_ENVELOPE_CHECK_STATUS.escalate_to_owner, 'requires_review');
  assert.equal(AUTHORITY_ENVELOPE_CHECK_STATUS.blocked, 'fail');
  // every modeled envelope has a mapping; every mapping is a real operator-contract check status
  const validStatuses = new Set(['pass', 'warning', 'requires_review', 'fail']);
  for (const env of AUTHORITY_ENVELOPES) {
    assert.ok(AUTHORITY_ENVELOPE_CHECK_STATUS[env], `${env} has a check status`);
    assert.ok(validStatuses.has(AUTHORITY_ENVELOPE_CHECK_STATUS[env]), `${env} maps to a valid status`);
  }
});

// ── renderAuthorityEnvelopeFromAuthorization: render the matcher's PERSISTED verdict ──

test('render: grant-backed auto_matched → auto_reconcile / delegated_grant', () => {
  const v = renderAuthorityEnvelopeFromAuthorization({ band: 'auto_matched', reasons: ['delegated_authority'] });
  assert.equal(v.envelope, 'auto_reconcile');
  assert.equal(v.terminal_target, 'auto_reconciled');
  assert.equal(v.authority_source, 'delegated_grant');
  assert.equal(v.rendered, true);
});

test('render: material-auto-fyi auto_matched → auto_reconcile / material_auto_fyi', () => {
  const v = renderAuthorityEnvelopeFromAuthorization({ band: 'auto_matched', reasons: ['material_auto_fyi'] });
  assert.equal(v.envelope, 'auto_reconcile');
  assert.equal(v.authority_source, 'material_auto_fyi');
});

test('render: non-material all_gates_passed auto_matched → auto_reconcile / gates_passed', () => {
  const v = renderAuthorityEnvelopeFromAuthorization({ band: 'auto_matched', reasons: ['all_gates_passed'] });
  assert.equal(v.envelope, 'auto_reconcile');
  assert.equal(v.authority_source, 'gates_passed');
});

test('render: materiality-held suggested → escalate_to_owner (the violation surface)', () => {
  const v = renderAuthorityEnvelopeFromAuthorization({ band: 'suggested', reasons: ['above_materiality_ceiling'] });
  assert.equal(v.envelope, 'escalate_to_owner');
  assert.equal(v.terminal_target, 'owner_clarification');
  assert.equal(v.reason, 'materiality_held_no_authority');
});

test('render: a non-materiality suggested is a review case → owner', () => {
  const v = renderAuthorityEnvelopeFromAuthorization({ band: 'suggested', reasons: ['ambiguous_candidate', 'above_materiality_ceiling'] });
  assert.equal(v.envelope, 'escalate_to_owner');
  assert.equal(v.reason, 'suggested_under_review'); // not SOLELY materiality → genuine review
});

test('render: rejected / unknown / missing band → escalate, never a fabricated auto-accept', () => {
  assert.equal(renderAuthorityEnvelopeFromAuthorization({ band: 'rejected', reasons: [] }).envelope, 'escalate_to_owner');
  assert.equal(renderAuthorityEnvelopeFromAuthorization(null).reason, 'no_authorization_receipt');
  assert.equal(renderAuthorityEnvelopeFromAuthorization({}).reason, 'no_band');
  assert.equal(renderAuthorityEnvelopeFromAuthorization('nope').authority_source, null);
});

test('render: auto_matched with an unrecognized reason → auto_reconcile but authority_source null', () => {
  const v = renderAuthorityEnvelopeFromAuthorization({ band: 'auto_matched', reasons: ['something_new'] });
  assert.equal(v.envelope, 'auto_reconcile');
  assert.equal(v.authority_source, null); // honest: terminal-1 but the lineage isn't a known source
});

// ── matchVerdictFromAuthorization: the render → preflight bridge ───────────────

test('matchVerdict: auto_matched authorization → reconciles:true (preflight pass)', () => {
  const v = matchVerdictFromAuthorization({ band: 'auto_matched', reasons: ['delegated_authority'] });
  assert.equal(v.reconciles, true);
  assert.equal(v.authority_source, 'delegated_grant');
  assert.equal(v.band, 'auto_matched');
});

test('matchVerdict: materiality-held suggested → reconciles:false with the rendered reason (requires_review)', () => {
  const v = matchVerdictFromAuthorization({ band: 'suggested', reasons: ['above_materiality_ceiling'] });
  assert.equal(v.reconciles, false);
  assert.equal(v.reason, 'materiality_held_no_authority');
  assert.equal(v.band, 'suggested');
});

test('matchVerdict: rejected band → reconciles:false (surfaced, never a fabricated reconcile)', () => {
  assert.equal(matchVerdictFromAuthorization({ band: 'rejected', reasons: [] }).reconciles, false);
});

test('matchVerdict: no persisted authorization → null (caller emits NO match check)', () => {
  assert.equal(matchVerdictFromAuthorization(null), null);
  assert.equal(matchVerdictFromAuthorization(undefined), null);
  assert.equal(matchVerdictFromAuthorization('nope'), null);
});

test('matchVerdict is consistent with the envelope render (one render path)', () => {
  for (const auth of [
    { band: 'auto_matched', reasons: ['material_auto_fyi'] },
    { band: 'suggested', reasons: ['above_materiality_ceiling'] },
    { band: 'rejected', reasons: [] }
  ]) {
    const env = renderAuthorityEnvelopeFromAuthorization(auth);
    const mv = matchVerdictFromAuthorization(auth);
    assert.equal(mv.reconciles, env.envelope === 'auto_reconcile');
    assert.equal(mv.reason, env.reason || null);
  }
});
