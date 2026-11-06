import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLOSE_DISPOSITIONS,
  CLOSE_ACTORS,
  RISK_CLASSES,
  RISK_LEVELS,
  MATERIALITY,
  RULE_MATURITY,
  DEFAULT_MATERIALITY_BANDS,
  detectRiskClass,
  materialityFor,
  proposeAction,
  classifyReconciliationMatch,
  classifyReviewItem
} from './closeDisposition.js';

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

const makeMatch = (overrides = {}) => ({
  id: 'rm_test_1',
  bank_transaction_id: 'tx_test_1',
  matched_object_type: 'supplier_bill',
  matched_object_id: 'doc_test_1',
  match_amount: 50,
  match_confidence: 0.95,
  status: 'suggested',
  payload: {
    match_reason: { auto_match_passed: true, auto_match_blockers: [] },
    recommended_action: 'auto_match_candidate'
  },
  ...overrides
});

const makeTx = (overrides = {}) => ({
  id: 'tx_test_1',
  description: 'STAPLES OFFICE SUPPLIES',
  amount: 50,
  ...overrides
});

const makeReview = (overrides = {}) => ({
  id: 'rq_test_1',
  item_id: 'tx_test_1',
  item_type: 'transaction',
  coding_state: 'proposed',
  reason: 'category_needs_review',
  payload: {},
  ...overrides
});

// ─────────────────────────────────────────────────────────────────
// detectRiskClass — descriptor sniffer
// ─────────────────────────────────────────────────────────────────

await test('detectRiskClass: IRS USATAXPYMT is tax_sensitive', () => {
  assert.equal(detectRiskClass('IRS USATAXPYMT 04212026'), RISK_CLASSES.TAX_SENSITIVE);
});

await test('detectRiskClass: 1099-NEC contractor payment is contractor_classification', () => {
  // contractor pattern is checked before tax-sensitive so 1099-NEC
  // (which strictly is tax-sensitive too) lands in the more specific
  // bucket.
  assert.equal(detectRiskClass('1099-NEC contractor payment'), RISK_CLASSES.CONTRACTOR_CLASSIFICATION);
});

await test('detectRiskClass: owner draw is owner_personal', () => {
  assert.equal(detectRiskClass('OWNER DRAW 06/01'), RISK_CLASSES.OWNER_PERSONAL);
});

await test('detectRiskClass: generic merchant is general', () => {
  assert.equal(detectRiskClass('STAPLES OFFICE SUPPLIES'), RISK_CLASSES.GENERAL);
});

await test('detectRiskClass: empty / null descriptor is general (no false positives)', () => {
  assert.equal(detectRiskClass(''), RISK_CLASSES.GENERAL);
  assert.equal(detectRiskClass(null), RISK_CLASSES.GENERAL);
  assert.equal(detectRiskClass(undefined), RISK_CLASSES.GENERAL);
});

// ─────────────────────────────────────────────────────────────────
// materialityFor — parametrized bands
// ─────────────────────────────────────────────────────────────────

await test('materialityFor: defaults — $50 is LOW, $500 is MEDIUM, $5000 is HIGH', () => {
  assert.equal(materialityFor(50), MATERIALITY.LOW);
  assert.equal(materialityFor(500), MATERIALITY.MEDIUM);
  assert.equal(materialityFor(5000), MATERIALITY.HIGH);
});

await test('materialityFor: absolute value — negative amounts are sized by magnitude', () => {
  assert.equal(materialityFor(-50), MATERIALITY.LOW);
  assert.equal(materialityFor(-5000), MATERIALITY.HIGH);
});

await test('materialityFor: per-client override widens the bands for a larger client', () => {
  // Creator-economy client averaging $30k/mo revenue — defaults call
  // a $500 transaction MEDIUM, but with overridden bands it's LOW.
  const bands = { low_max: 1000, medium_max: 10000 };
  assert.equal(materialityFor(500, bands), MATERIALITY.LOW);
  assert.equal(materialityFor(5000, bands), MATERIALITY.MEDIUM);
  assert.equal(materialityFor(50000, bands), MATERIALITY.HIGH);
});

// ─────────────────────────────────────────────────────────────────
// proposeAction — discriminated-union shape
// ─────────────────────────────────────────────────────────────────

await test('proposeAction.confirm_reconciliation_match carries all four ids', () => {
  const action = proposeAction.confirm_reconciliation_match({
    matchId: 'rm_1',
    bankTransactionId: 'tx_1',
    matchedObjectType: 'supplier_bill',
    matchedObjectId: 'doc_1'
  });
  assert.equal(action.type, 'confirm_reconciliation_match');
  assert.equal(action.match_id, 'rm_1');
  assert.equal(action.bank_transaction_id, 'tx_1');
  assert.equal(action.matched_object_type, 'supplier_bill');
  assert.equal(action.matched_object_id, 'doc_1');
});

await test('proposeAction.request_evidence has evidence_type + transaction_id', () => {
  const action = proposeAction.request_evidence({
    transactionId: 'tx_1',
    evidenceType: 'receipt',
    amount: 50
  });
  assert.equal(action.type, 'request_evidence');
  assert.equal(action.transaction_id, 'tx_1');
  assert.equal(action.evidence_type, 'receipt');
  assert.equal(action.amount, 50);
});

await test('proposeAction.none() is the empty discriminator', () => {
  assert.deepStrictEqual(proposeAction.none(), { type: 'none' });
});

// ─────────────────────────────────────────────────────────────────
// classifyReconciliationMatch — terminal states
// ─────────────────────────────────────────────────────────────────

await test('confirmed match → auto_cleared (system actor, does not block close)', () => {
  const verdict = classifyReconciliationMatch({
    match: makeMatch({ status: 'confirmed' }),
    transaction: makeTx()
  });
  assert.equal(verdict.disposition, CLOSE_DISPOSITIONS.AUTO_CLEARED);
  assert.equal(verdict.allowed_actor, CLOSE_ACTORS.SYSTEM);
  assert.equal(verdict.blocks_close, false);
  assert.equal(verdict.reason_code, 'match_confirmed');
});

await test('rejected match → operator_blocker, blocks close', () => {
  const verdict = classifyReconciliationMatch({
    match: makeMatch({ status: 'rejected' }),
    transaction: makeTx()
  });
  assert.equal(verdict.disposition, CLOSE_DISPOSITIONS.OPERATOR_BLOCKER);
  assert.equal(verdict.allowed_actor, CLOSE_ACTORS.OPERATOR);
  assert.equal(verdict.blocks_close, true);
});

// ─────────────────────────────────────────────────────────────────
// classifyReconciliationMatch — the conservative auto_matched override
// ─────────────────────────────────────────────────────────────────

await test('auto_matched WITHOUT rule maturity → confirmable, not auto_cleared (PHASE 1 OVERRIDE)', () => {
  // Spec mapping table says auto_matched → auto_cleared. v1 refuses
  // until rule maturity is a real signal. Until Phase 5, every
  // matched row gets a $15/hour eye on it. The IRS row case this
  // session demonstrated that the matcher's confidence is a
  // confidence proxy, not a rule-maturity proxy.
  const verdict = classifyReconciliationMatch({
    match: makeMatch({ status: 'auto_matched' }),
    transaction: makeTx()
  });
  assert.equal(verdict.disposition, CLOSE_DISPOSITIONS.CONFIRMABLE);
  assert.equal(verdict.allowed_actor, CLOSE_ACTORS.BACKUP);
  assert.equal(verdict.reason_code, 'auto_matched_needs_backup_confirmation');
  assert.equal(verdict.proposed_action.type, 'confirm_reconciliation_match');
});

await test('auto_matched WITH trusted rule + low materiality → auto_cleared (future Phase 5 path)', () => {
  const verdict = classifyReconciliationMatch({
    match: makeMatch({ status: 'auto_matched' }),
    transaction: makeTx(),
    ruleMaturity: RULE_MATURITY.TRUSTED
  });
  assert.equal(verdict.disposition, CLOSE_DISPOSITIONS.AUTO_CLEARED);
  assert.equal(verdict.reason_code, 'trusted_rule_auto_matched');
});

await test('auto_matched WITH trusted rule but HIGH materiality → still confirmable (QA backstop)', () => {
  const verdict = classifyReconciliationMatch({
    match: makeMatch({ status: 'auto_matched', match_amount: 5000 }),
    transaction: makeTx({ amount: 5000 }),
    ruleMaturity: RULE_MATURITY.TRUSTED
  });
  assert.equal(verdict.disposition, CLOSE_DISPOSITIONS.CONFIRMABLE);
});

await test('auto_matched WITH trusted rule but duplicate warning → still confirmable', () => {
  const verdict = classifyReconciliationMatch({
    match: makeMatch({
      status: 'auto_matched',
      payload: {
        match_reason: {
          auto_match_passed: true,
          auto_match_blockers: [],
          duplicate_warning: true
        }
      }
    }),
    transaction: makeTx(),
    ruleMaturity: RULE_MATURITY.TRUSTED
  });
  assert.equal(verdict.disposition, CLOSE_DISPOSITIONS.CONFIRMABLE);
});

// ─────────────────────────────────────────────────────────────────
// classifyReconciliationMatch — suggested
// ─────────────────────────────────────────────────────────────────

await test('suggested + auto_match_passed + empty blockers + high confidence → confirmable', () => {
  const verdict = classifyReconciliationMatch({
    match: makeMatch(),
    transaction: makeTx()
  });
  assert.equal(verdict.disposition, CLOSE_DISPOSITIONS.CONFIRMABLE);
  assert.equal(verdict.reason_code, 'auto_match_candidate_high_confidence');
  assert.equal(verdict.blocks_close, false);
});

await test('suggested + auto_match_blockers present → operator_blocker', () => {
  const verdict = classifyReconciliationMatch({
    match: makeMatch({
      payload: {
        match_reason: {
          auto_match_passed: false,
          auto_match_blockers: ['low_extraction_confidence']
        }
      }
    }),
    transaction: makeTx()
  });
  assert.equal(verdict.disposition, CLOSE_DISPOSITIONS.OPERATOR_BLOCKER);
  assert.equal(verdict.reason_code, 'auto_match_blockers_present');
});

await test('suggested below candidate threshold → operator_blocker', () => {
  const verdict = classifyReconciliationMatch({
    match: makeMatch({
      match_confidence: 0.6,
      payload: {
        match_reason: { auto_match_passed: false, auto_match_blockers: [] }
      }
    }),
    transaction: makeTx()
  });
  assert.equal(verdict.disposition, CLOSE_DISPOSITIONS.OPERATOR_BLOCKER);
});

await test('suggested + high materiality (>$1000) → operator_blocker even at high confidence', () => {
  const verdict = classifyReconciliationMatch({
    match: makeMatch({ match_amount: 5000 }),
    transaction: makeTx({ amount: 5000 })
  });
  assert.equal(verdict.disposition, CLOSE_DISPOSITIONS.OPERATOR_BLOCKER);
  assert.equal(verdict.reason_code, 'high_materiality_suggested_requires_operator');
  assert.equal(verdict.blocks_close, true);
});

await test('suggested + duplicate_warning → operator_blocker', () => {
  const verdict = classifyReconciliationMatch({
    match: makeMatch({
      payload: {
        match_reason: {
          auto_match_passed: true,
          auto_match_blockers: [],
          duplicate_warning: true
        }
      }
    }),
    transaction: makeTx()
  });
  assert.equal(verdict.disposition, CLOSE_DISPOSITIONS.OPERATOR_BLOCKER);
  assert.equal(verdict.reason_code, 'duplicate_warning_requires_operator');
});

await test('suggested + warnings array contains "duplicate" → operator_blocker', () => {
  const verdict = classifyReconciliationMatch({
    match: makeMatch({
      payload: {
        match_reason: {
          auto_match_passed: true,
          auto_match_blockers: [],
          warnings: ['possible duplicate document']
        }
      }
    }),
    transaction: makeTx()
  });
  assert.equal(verdict.disposition, CLOSE_DISPOSITIONS.OPERATOR_BLOCKER);
});

// ─────────────────────────────────────────────────────────────────
// classifyReconciliationMatch — risk class overrides
// ─────────────────────────────────────────────────────────────────

await test('IRS USATAXPYMT regression: high-confidence Taxes & Licenses match → operator_blocker', () => {
  // The defining test for this session. Even with a perfect Taxes &
  // Licenses match on the document side, an IRS federal-tax-payment
  // transaction descriptor must route to Kari — auto-confirming via
  // a backup bookkeeper would put a tax filing at risk.
  const verdict = classifyReconciliationMatch({
    match: makeMatch({
      match_confidence: 0.99,
      payload: {
        match_reason: { auto_match_passed: true, auto_match_blockers: [] },
        recommended_action: 'auto_match_candidate'
      }
    }),
    transaction: makeTx({ description: 'IRS USATAXPYMT 04212026' })
  });
  assert.equal(verdict.disposition, CLOSE_DISPOSITIONS.OPERATOR_BLOCKER);
  assert.equal(verdict.allowed_actor, CLOSE_ACTORS.OPERATOR);
  assert.equal(verdict.risk_class, RISK_CLASSES.TAX_SENSITIVE);
  assert.equal(verdict.reason_code, 'risk_class_tax_sensitive_routes_to_operator');
  assert.equal(verdict.blocks_close, true);
});

await test('owner draw descriptor → operator_blocker (owner_personal)', () => {
  const verdict = classifyReconciliationMatch({
    match: makeMatch(),
    transaction: makeTx({ description: 'OWNER DRAW 06/01' })
  });
  assert.equal(verdict.disposition, CLOSE_DISPOSITIONS.OPERATOR_BLOCKER);
  assert.equal(verdict.risk_class, RISK_CLASSES.OWNER_PERSONAL);
});

await test('1099 contractor descriptor → operator_blocker (contractor_classification)', () => {
  const verdict = classifyReconciliationMatch({
    match: makeMatch(),
    transaction: makeTx({ description: '1099-NEC ACME LLC' })
  });
  assert.equal(verdict.disposition, CLOSE_DISPOSITIONS.OPERATOR_BLOCKER);
  assert.equal(verdict.risk_class, RISK_CLASSES.CONTRACTOR_CLASSIFICATION);
});

await test('tax-sensitive risk_class with trusted rule maturity → CAN route to confirmable (future)', () => {
  // The escape valve: a mature, scoped rule that the operator
  // explicitly trusts (Phase 5) can route a tax-sensitive item
  // lower. v1 callers never pass ruleMaturity=TRUSTED so this path
  // is dormant — pinned here to lock the contract.
  const verdict = classifyReconciliationMatch({
    match: makeMatch(),
    transaction: makeTx({ description: 'IRS USATAXPYMT' }),
    ruleMaturity: RULE_MATURITY.TRUSTED
  });
  // Note: even with trusted rule, the IRS descriptor at suggested
  // status still flows through the normal suggested → confirmable
  // path; what's interesting is that it's NOT short-circuited to
  // operator_blocker.
  assert.notEqual(verdict.disposition, CLOSE_DISPOSITIONS.OPERATOR_BLOCKER);
});

// ─────────────────────────────────────────────────────────────────
// classifyReviewItem — terminal states
// ─────────────────────────────────────────────────────────────────

await test('coding_state=applied → auto_cleared', () => {
  const verdict = classifyReviewItem({
    reviewItem: makeReview({ coding_state: 'applied' }),
    transaction: makeTx()
  });
  assert.equal(verdict.disposition, CLOSE_DISPOSITIONS.AUTO_CLEARED);
});

await test('coding_state=applied (a resolved case) → auto_cleared', () => {
  const verdict = classifyReviewItem({
    reviewItem: makeReview({ coding_state: 'applied' }),
    transaction: makeTx()
  });
  assert.equal(verdict.disposition, CLOSE_DISPOSITIONS.AUTO_CLEARED);
});

await test('coding_state=synced → auto_cleared', () => {
  const verdict = classifyReviewItem({
    reviewItem: makeReview({ coding_state: 'synced' }),
    transaction: makeTx()
  });
  assert.equal(verdict.disposition, CLOSE_DISPOSITIONS.AUTO_CLEARED);
});

// ─────────────────────────────────────────────────────────────────
// classifyReviewItem — client-waiting
// ─────────────────────────────────────────────────────────────────

await test('coding_state=asked with low materiality → client_info_needed, blocks_close=false, disclosure_reason set', () => {
  const verdict = classifyReviewItem({
    reviewItem: makeReview({
      coding_state: 'asked',
      payload: { evidence_request: { status: 'open', evidence_type: 'receipt' } }
    }),
    transaction: makeTx({ amount: 30 })
  });
  assert.equal(verdict.disposition, CLOSE_DISPOSITIONS.CLIENT_INFO_NEEDED);
  assert.equal(verdict.allowed_actor, CLOSE_ACTORS.CLIENT);
  assert.equal(verdict.blocks_close, false);
  assert.equal(verdict.materiality, MATERIALITY.LOW);
  assert.ok(verdict.disclosure_reason, 'low-materiality unanswered client item must carry a disclosure_reason');
  assert.equal(verdict.proposed_action.type, 'request_evidence');
  assert.equal(verdict.proposed_action.evidence_type, 'receipt');
});

await test('coding_state=asked with HIGH materiality → blocks_close=true, no disclosure', () => {
  const verdict = classifyReviewItem({
    reviewItem: makeReview({
      coding_state: 'asked',
      payload: { evidence_request: { status: 'open', evidence_type: 'receipt' } }
    }),
    transaction: makeTx({ amount: 5000 })
  });
  assert.equal(verdict.disposition, CLOSE_DISPOSITIONS.CLIENT_INFO_NEEDED);
  assert.equal(verdict.blocks_close, true);
  assert.equal(verdict.disclosure_reason, null);
});

await test('coding_state=asked via the legacy waiting label routes the same', () => {
  const verdict = classifyReviewItem({
    reviewItem: makeReview({ coding_state: 'asked' }),
    transaction: makeTx({ amount: 30 })
  });
  assert.equal(verdict.disposition, CLOSE_DISPOSITIONS.CLIENT_INFO_NEEDED);
});

// ─────────────────────────────────────────────────────────────────
// classifyReviewItem — suggested
// ─────────────────────────────────────────────────────────────────

await test('coding_state=proposed with explicit proposed_action + low materiality → confirmable', () => {
  const verdict = classifyReviewItem({
    reviewItem: makeReview({
      payload: {
        proposed_action: { type: 'apply_category', account_id: 'acc_office' },
        suggestion_confidence: 0.9
      }
    }),
    transaction: makeTx()
  });
  assert.equal(verdict.disposition, CLOSE_DISPOSITIONS.CONFIRMABLE);
  assert.equal(verdict.proposed_action.type, 'apply_category');
});

await test('coding_state=proposed WITHOUT proposed_action → operator_blocker', () => {
  const verdict = classifyReviewItem({
    reviewItem: makeReview({ payload: {} }),
    transaction: makeTx()
  });
  assert.equal(verdict.disposition, CLOSE_DISPOSITIONS.OPERATOR_BLOCKER);
  assert.equal(verdict.reason_code, 'review_suggestion_without_proposed_action');
});

await test('coding_state=proposed + high materiality → operator_blocker (even with action)', () => {
  const verdict = classifyReviewItem({
    reviewItem: makeReview({
      payload: {
        proposed_action: { type: 'apply_category', account_id: 'acc_office' }
      }
    }),
    transaction: makeTx({ amount: 5000 })
  });
  assert.equal(verdict.disposition, CLOSE_DISPOSITIONS.OPERATOR_BLOCKER);
  assert.equal(verdict.reason_code, 'high_materiality_review_requires_operator');
});

await test('coding_state=proposed + tax-sensitive descriptor → operator_blocker (risk_class override)', () => {
  const verdict = classifyReviewItem({
    reviewItem: makeReview({
      reason: 'category_needs_review_irs_payment',
      payload: {
        proposed_action: { type: 'apply_category', account_id: 'acc_taxes_licenses' }
      }
    }),
    transaction: makeTx({ description: 'IRS USATAXPYMT 04212026' })
  });
  assert.equal(verdict.disposition, CLOSE_DISPOSITIONS.OPERATOR_BLOCKER);
  assert.equal(verdict.risk_class, RISK_CLASSES.TAX_SENSITIVE);
});

// ─────────────────────────────────────────────────────────────────
// Verdict envelope invariants
// ─────────────────────────────────────────────────────────────────

await test('verdict shape: every disposition resolves to exactly one allowed_actor', () => {
  const seen = new Set();
  for (const disposition of Object.values(CLOSE_DISPOSITIONS)) {
    let verdict;
    if (disposition === CLOSE_DISPOSITIONS.AUTO_CLEARED) {
      verdict = classifyReconciliationMatch({
        match: makeMatch({ status: 'confirmed' }),
        transaction: makeTx()
      });
    } else if (disposition === CLOSE_DISPOSITIONS.CONFIRMABLE) {
      verdict = classifyReconciliationMatch({
        match: makeMatch(),
        transaction: makeTx()
      });
    } else if (disposition === CLOSE_DISPOSITIONS.OPERATOR_BLOCKER) {
      verdict = classifyReconciliationMatch({
        match: makeMatch({ status: 'rejected' }),
        transaction: makeTx()
      });
    } else {
      verdict = classifyReviewItem({
        reviewItem: makeReview({ coding_state: 'asked' }),
        transaction: makeTx({ amount: 30 })
      });
    }
    assert.ok(verdict.allowed_actor, `disposition ${disposition} resolved to no allowed_actor`);
    seen.add(verdict.allowed_actor);
  }
  assert.equal(seen.size, 4, 'all four actors should appear across the four dispositions');
});

await test('verdict shape: every verdict carries context echoed back from input', () => {
  const ctx = { firm_id: 'firm_x', client_id: 'client_y', jurisdiction: 'US-CA' };
  const verdict = classifyReconciliationMatch({
    match: makeMatch(),
    transaction: makeTx(),
    context: ctx
  });
  assert.deepStrictEqual(verdict.context, ctx);
});

await test('verdict shape: evidence carries the underlying match payload fields', () => {
  const verdict = classifyReconciliationMatch({
    match: makeMatch({
      payload: {
        match_reason: { auto_match_passed: true, auto_match_blockers: [], score: 0.97 },
        recommended_action: 'auto_match_candidate'
      }
    }),
    transaction: makeTx()
  });
  assert.equal(verdict.evidence.auto_match_passed, true);
  assert.deepStrictEqual(verdict.evidence.auto_match_blockers, []);
  assert.equal(verdict.evidence.recommended_action, 'auto_match_candidate');
  assert.equal(verdict.evidence.match_id, 'rm_test_1');
});

await test('verdict shape: parametrized materiality bands flow through to verdict.materiality', () => {
  const verdict = classifyReconciliationMatch({
    match: makeMatch({ match_amount: 500 }),
    transaction: makeTx({ amount: 500 }),
    materialityBands: { low_max: 1000, medium_max: 10000 }
  });
  assert.equal(verdict.materiality, MATERIALITY.LOW);
});

await test('risk_level is HIGH whenever risk_class is not general', () => {
  const verdict = classifyReconciliationMatch({
    match: makeMatch(),
    transaction: makeTx({ description: 'IRS USATAXPYMT' })
  });
  assert.equal(verdict.risk_level, RISK_LEVELS.HIGH);
});

await test('risk_level is LOW only when general + low materiality + high confidence', () => {
  const verdict = classifyReconciliationMatch({
    match: makeMatch({ match_confidence: 0.95 }),
    transaction: makeTx({ amount: 50 })
  });
  assert.equal(verdict.risk_level, RISK_LEVELS.LOW);
});
