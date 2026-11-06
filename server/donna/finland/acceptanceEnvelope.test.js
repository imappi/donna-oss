import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACCEPTANCE_VERDICTS,
  ACCEPTANCE_ESCALATION_PARTIES,
  ACCEPTANCE_CRITERIA,
  ACCEPTANCE_STATED_ATTESTATIONS,
  evaluateAcceptanceEnvelope,
  criterionById
} from './acceptanceEnvelope.js';

// A fully in-envelope Finnish owner-managed service Oy — every gate affirmatively
// cleared. Individual tests override one attribute to drive a single criterion.
const ACCEPTED_ATTRIBUTES = Object.freeze({
  entityType: 'fi-oy',
  taxResidentFinland: true,
  businessKind: 'service',
  singleShareholderFullOwnership: true,
  shareholdersAllFinnishResidentNaturalPersons: true,
  shareClassCount: 1,
  singleDecisionMakerWithAuthority: true,
  hasSubsidiariesOrGroup: false,
  hasForeignPermanentEstablishment: false,
  hasInventoryOrCogs: false,
  hasPropertySecuritiesOrCrypto: false,
  hasShareholderLoans: false,
  wantsAutomatedDividends: false,
  employeesBeyondOwner: false,
  alvStatus: 'standard',
  auditRequired: false,
  fiscalPeriodChangeInProgress: false,
  openingBalancesCleanWithEvidence: true,
  modestVolume: true,
  tilikausiCrossesRateBoundary: false,
  ownershipChangeInProgress: false
});

const evalWith = (overrides = {}) => evaluateAcceptanceEnvelope({ attributes: { ...ACCEPTED_ATTRIBUTES, ...overrides } });
const failure = (result, id) => result.failures.find((f) => f.id === id);

test('verdict enum is the closed severity-ranked set; assignees are the named parties', () => {
  assert.deepEqual(ACCEPTANCE_VERDICTS, ['accepted', 'review_required', 'out_of_segment']);
  assert.deepEqual(ACCEPTANCE_ESCALATION_PARTIES, ['firm', 'accountant', 'counsel', 'owner']);
});

test('a fully in-envelope Oy is accepted with no failures', () => {
  const out = evaluateAcceptanceEnvelope({ attributes: ACCEPTED_ATTRIBUTES });
  assert.equal(out.verdict, 'accepted');
  assert.equal(out.accepted, true);
  assert.deepEqual(out.failures, []);
  // Every catalog criterion was evaluated.
  assert.deepEqual(out.evaluatedCriterionIds, ACCEPTANCE_CRITERIA.map((c) => c.id));
});

test('fail-closed: empty attributes never accept — every gate fires as unconfirmed→review, on the owner', () => {
  const out = evaluateAcceptanceEnvelope({ attributes: {} });
  assert.equal(out.verdict, 'review_required', 'a bare "nothing disqualifying seen" is NOT acceptance');
  assert.equal(out.accepted, false);
  assert.equal(out.failures.length, ACCEPTANCE_CRITERIA.length, 'all gates unanswered');
  assert.ok(out.failures.every((f) => f.reason === 'unconfirmed'), 'each is unconfirmed, not disqualified');
  assert.ok(out.failures.every((f) => f.severity === 'review_required'), 'an unanswered gate is at most review_required');
  assert.ok(out.failures.every((f) => f.escalates_to === 'owner'), 'the owner holds the missing answers');
});

test('an out_of_segment disqualifier dominates and rests on the firm', () => {
  const out = evalWith({ hasSubsidiariesOrGroup: true });
  assert.equal(out.verdict, 'out_of_segment');
  const f = failure(out, 'no_group_structure');
  assert.equal(f.reason, 'disqualified');
  assert.equal(f.severity, 'out_of_segment');
  assert.equal(f.escalates_to, 'firm', 'a different segment is Kari’s dated call');
  // No other criterion fired — the rest of the envelope was clean.
  assert.equal(out.failures.length, 1);
});

test('a non-Oy legal form is out_of_segment (not silently absorbed)', () => {
  assert.equal(evalWith({ entityType: 'fi-toiminimi' }).verdict, 'out_of_segment');
  assert.equal(evalWith({ entityType: 'gb-ltd' }).verdict, 'out_of_segment');
  assert.equal(failure(evalWith({ entityType: 'fi-toiminimi' }), 'finnish_private_limited').reason, 'disqualified');
});

test('a soft gate alone yields review_required, escalating to the accountant', () => {
  const out = evalWith({ auditRequired: true });
  assert.equal(out.verdict, 'review_required');
  const f = failure(out, 'no_audit_requirement');
  assert.equal(f.reason, 'disqualified');
  assert.equal(f.severity, 'review_required');
  assert.equal(f.escalates_to, 'accountant');
});

test('out_of_segment outranks review_required when both fire', () => {
  const out = evalWith({ auditRequired: true, hasForeignPermanentEstablishment: true });
  assert.equal(out.verdict, 'out_of_segment', 'the strongest severity wins');
  assert.equal(failure(out, 'no_audit_requirement').severity, 'review_required');
  assert.equal(failure(out, 'no_foreign_pe').severity, 'out_of_segment');
});

test('the shareholder criterion is composite: either sub-answer disqualifies, either missing is unconfirmed', () => {
  // A corporate/second owner → fail.
  assert.equal(failure(evalWith({ singleShareholderFullOwnership: false }), 'single_resident_natural_shareholder').reason, 'disqualified');
  // A foreign owner → fail.
  assert.equal(failure(evalWith({ shareholdersAllFinnishResidentNaturalPersons: false }), 'single_resident_natural_shareholder').reason, 'disqualified');
  // One sub-answer missing (and none contrary) → unconfirmed, not a false accept.
  const missing = evalWith({ shareholdersAllFinnishResidentNaturalPersons: undefined });
  assert.equal(failure(missing, 'single_resident_natural_shareholder').reason, 'unconfirmed');
  // A contrary answer beats a missing one.
  const both = evalWith({ singleShareholderFullOwnership: false, shareholdersAllFinnishResidentNaturalPersons: undefined });
  assert.equal(failure(both, 'single_resident_natural_shareholder').reason, 'disqualified');
});

test('complex cross-border ALV disqualifies; a verified non-ALV position passes', () => {
  assert.equal(failure(evalWith({ alvStatus: 'complex_cross_border' }), 'standard_or_verified_non_alv').reason, 'disqualified');
  assert.equal(evalWith({ alvStatus: 'verified_non_alv' }).verdict, 'accepted');
});

test('multiple share classes disqualify; exactly one passes', () => {
  assert.equal(failure(evalWith({ shareClassCount: 2 }), 'single_share_class').reason, 'disqualified');
  assert.equal(evalWith({ shareClassCount: 1 }).verdict, 'accepted');
  // Missing count → unconfirmed.
  assert.equal(failure(evalWith({ shareClassCount: undefined }), 'single_share_class').reason, 'unconfirmed');
});

test('a non-boolean answer is treated as unknown, never coerced', () => {
  // A stray string for a boolean gate must not read as truthy-pass.
  const out = evalWith({ hasShareholderLoans: 'no' });
  assert.equal(failure(out, 'no_shareholder_loans').reason, 'unconfirmed');
});

test('an ownership change in progress re-qualifies (review_required, accountant)', () => {
  const out = evalWith({ ownershipChangeInProgress: true });
  assert.equal(out.verdict, 'review_required');
  const f = failure(out, 'no_ownership_change_in_progress');
  assert.equal(f.reason, 'disqualified');
  assert.equal(f.escalates_to, 'accountant');
});

test('stated attestations ride every evaluation and reference real criteria', () => {
  const accepted = evaluateAcceptanceEnvelope({ attributes: ACCEPTED_ATTRIBUTES });
  const empty = evaluateAcceptanceEnvelope({ attributes: {} });
  assert.deepEqual(accepted.stated_attestations, ACCEPTANCE_STATED_ATTESTATIONS);
  assert.deepEqual(empty.stated_attestations, ACCEPTANCE_STATED_ATTESTATIONS);
  // Each attestation names a criterion that actually exists in the catalog.
  for (const att of ACCEPTANCE_STATED_ATTESTATIONS) {
    assert.ok(criterionById(att.id), `attestation ${att.id} maps to a real criterion`);
    assert.ok(att.note_en && att.note_fi, 'bilingual copy present');
  }
});

test('every criterion carries bilingual copy and a valid severity + escalation party', () => {
  for (const c of ACCEPTANCE_CRITERIA) {
    assert.ok(c.requirement_en && c.requirement_fi, `${c.id} has bilingual requirement copy`);
    assert.ok(c.note_en && c.note_fi, `${c.id} has bilingual note copy`);
    assert.ok(ACCEPTANCE_VERDICTS.includes(c.severity) && c.severity !== 'accepted', `${c.id} severity is a real disqualified severity`);
    assert.ok(ACCEPTANCE_ESCALATION_PARTIES.includes(c.escalates_to), `${c.id} escalates to a named party`);
  }
});

test('provenance is deterministic and cites the policy source', () => {
  const out = evaluateAcceptanceEnvelope({ attributes: {} });
  assert.equal(out.provenance.deterministic, true);
  assert.match(out.provenance.policy, /D-FI13-13/);
});

test('the evaluator never throws on junk input and defaults to review_required', () => {
  assert.doesNotThrow(() => evaluateAcceptanceEnvelope());
  assert.doesNotThrow(() => evaluateAcceptanceEnvelope({}));
  assert.equal(evaluateAcceptanceEnvelope().verdict, 'review_required');
  assert.equal(criterionById('does-not-exist'), null);
});
