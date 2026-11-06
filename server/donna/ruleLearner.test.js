// Reconciliation PR 5 — rule learner. Test harness.
//
// RT-14 (2026-09-02) deleted the learner's CRON path (`learnClientRulesForFirm`
// and the audit-row aggregation behind it — env-dark on every host), so the
// numbered tests 1–15 / 25 and the PR15 aggregation cases went with it. What
// this file still pins:
//   Data integrity / API wiring (16–17)
//    16. updateClientRuleStatusInDb accepts active from proposed
//    17. updateClientRuleStatusInDb accepts retired from proposed
//   The pure evaluator (21–24)
//    21. Empty canonical pattern → PATTERN_EMPTY
//    22. Account code missing on transaction → ACCOUNT_CODE_MISSING
//    23. Cautious expense_kind → EXPENSE_KIND_UNSAFE
//    24. All observations pre-window → OBSERVATIONS_TOO_OLD
//   resolveRuleLearningConfig (defaults + per-firm override)
//
// Mock-client harness mirrors receiptAutoExplain.test.js — substring SQL
// matching, canned responses for SELECTs, mutations recorded in
// `client.calls`.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LEARNER_BLOCKERS,
  LEARNER_DEFAULT_CONFIG,
  RULE_LEARNER_POLICY_VERSION,
  evaluateLearnedRuleCandidate,
  resolveRuleLearningConfig
} from './ruleLearner.js';

// ── Mock pg-style client (mirrors PR 3 harness) ──────────────────────
const makeMockClient = (responses = []) => {
  const calls = [];
  const reserved = [...responses];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const text = String(sql).trim().toLowerCase();
      if (text === 'begin' || text === 'commit' || text === 'rollback') {
        return { rows: [], rowCount: 0 };
      }
      const idx = reserved.findIndex((r) => text.includes(r.match));
      if (idx !== -1) {
        const [response] = reserved.splice(idx, 1);
        if (response.throw) throw response.throw;
        const rows = response.rows || [];
        const rowCount = response.rowCount != null ? response.rowCount : rows.length;
        return { rows, rowCount };
      }
      // Default for UPDATEs: rowCount=1 so the retire-gate fires unless
      // the test explicitly canned a 0-row response.
      if (text.startsWith('update ')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
  };
};

// ── Fixtures ─────────────────────────────────────────────────────────
const FIRM_ID = 'firm-1';
const CLIENT_ID = 'client-1';

// =====================================================================
// 16-17. updateClientRuleStatusInDb endpoint behavior.
// =====================================================================
//
// updateClientRuleStatusInDb is exercised via the firmDb.js function
// directly. Mock client mirrors PR 4's transaction shape:
//   begin → SELECT existing → UPDATE → audit emit → commit
// Tests assert the prior-state guard rejects non-proposed sources.

await test('16. updateClientRuleStatusInDb accepts active from proposed', async () => {
  const { updateClientRuleStatusInDb } = await import('./firmDb.js');
  const ruleRow = {
    id: 'rule-1', firm_id: FIRM_ID, client_id: CLIENT_ID, status: 'proposed', account_code: '6420'
  };
  const client = makeMockClient([
    { match: 'select * from client_rules where firm_id', rows: [ruleRow] }
  ]);
  const result = await updateClientRuleStatusInDb({
    firmId: FIRM_ID,
    ruleId: 'rule-1',
    nextStatus: 'active',
    dbClient: client
  });
  assert.equal(result.next_status, 'active');
  assert.equal(result.prior_status, 'proposed');

  const updates = client.calls.filter((c) =>
    c.sql.toLowerCase().includes('update client_rules') && c.sql.toLowerCase().includes('set status')
  );
  assert.equal(updates.length, 1);
  const audits = client.calls.filter((c) => c.sql.toLowerCase().includes(`'client_rule.firm_decided'`));
  assert.equal(audits.length, 1);
});

await test('16b. updateClientRuleStatusInDb: allowActiveRetire (G1c retire_rule) permits active→retired with its own audit; default callers stay locked out', async () => {
  const { updateClientRuleStatusInDb } = await import('./firmDb.js');
  const activeRow = { id: 'r-live', firm_id: FIRM_ID, client_id: CLIENT_ID, status: 'active', account_code: '6420' };
  const okClient = makeMockClient([
    { match: 'select * from client_rules where firm_id', rows: [activeRow] }
  ]);
  const ok = await updateClientRuleStatusInDb({
    firmId: FIRM_ID, ruleId: 'r-live', nextStatus: 'retired',
    allowActiveRetire: true, actorId: 'kari@books.example', decidedBy: 'kari@books.example',
    dbClient: okClient
  });
  assert.equal(ok.prior_status, 'active');
  assert.equal(ok.next_status, 'retired');
  const retireAudits = okClient.calls.filter((c) => c.sql.includes(`'client_rule.retired'`));
  assert.equal(retireAudits.length, 1, 'the retire leg emits its own distinct audit action');
  assert.equal(retireAudits[0].params[2], 'kari@books.example', 'actor threaded onto the audit row');
  assert.equal(okClient.calls.filter((c) => c.sql.includes(`'client_rule.firm_decided'`)).length, 0);

  // allowActiveRetire does NOT widen anything else: an already-retired rule
  // still 409s, and active→ACTIVE stays locked to the proposed-only path.
  const retiredRow = { id: 'r-done', firm_id: FIRM_ID, client_id: CLIENT_ID, status: 'retired', account_code: '6420' };
  await assert.rejects(
    () => updateClientRuleStatusInDb({
      firmId: FIRM_ID, ruleId: 'r-done', nextStatus: 'retired', allowActiveRetire: true,
      dbClient: makeMockClient([{ match: 'select * from client_rules where firm_id', rows: [retiredRow] }])
    }),
    (err) => err.statusCode === 409
  );
  await assert.rejects(
    () => updateClientRuleStatusInDb({
      firmId: FIRM_ID, ruleId: 'r-live', nextStatus: 'active', allowActiveRetire: true,
      dbClient: makeMockClient([{ match: 'select * from client_rules where firm_id', rows: [{ ...activeRow }] }])
    }),
    (err) => err.statusCode === 409,
    'allowActiveRetire only opens active→retired, never active→active'
  );
});

await test('17. updateClientRuleStatusInDb accepts retired from proposed; rejects non-proposed', async () => {
  const { updateClientRuleStatusInDb } = await import('./firmDb.js');

  // retired from proposed → ok
  const proposedRow = { id: 'r1', firm_id: FIRM_ID, client_id: CLIENT_ID, status: 'proposed', account_code: '6420' };
  const okClient = makeMockClient([
    { match: 'select * from client_rules where firm_id', rows: [proposedRow] }
  ]);
  const ok = await updateClientRuleStatusInDb({
    firmId: FIRM_ID, ruleId: 'r1', nextStatus: 'retired', dbClient: okClient
  });
  assert.equal(ok.next_status, 'retired');

  // active → retired via this endpoint → 409
  const activeRow = { id: 'r2', firm_id: FIRM_ID, client_id: CLIENT_ID, status: 'active', account_code: '6420' };
  const badClient = makeMockClient([
    { match: 'select * from client_rules where firm_id', rows: [activeRow] }
  ]);
  await assert.rejects(
    () => updateClientRuleStatusInDb({
      firmId: FIRM_ID, ruleId: 'r2', nextStatus: 'retired', dbClient: badClient
    }),
    (err) => err.statusCode === 409
  );

  // Invalid nextStatus → 400
  await assert.rejects(
    () => updateClientRuleStatusInDb({
      firmId: FIRM_ID, ruleId: 'r1', nextStatus: 'suggested', dbClient: makeMockClient([])
    }),
    (err) => err.statusCode === 400
  );

  // Missing rule → 404
  const missing = makeMockClient([
    { match: 'select * from client_rules where firm_id', rows: [] }
  ]);
  await assert.rejects(
    () => updateClientRuleStatusInDb({
      firmId: FIRM_ID, ruleId: 'r-missing', nextStatus: 'active', dbClient: missing
    }),
    (err) => err.statusCode === 404
  );
});

// =====================================================================
// 21. Empty canonical pattern → PATTERN_EMPTY.
// =====================================================================
await test('21. unparseable vendor name (canonical pattern empty) → PATTERN_EMPTY', async () => {
  const verdict = evaluateLearnedRuleCandidate({
    candidate: {
      firm_id: FIRM_ID,
      client_id: CLIENT_ID,
      canonical_pattern: '',
      expense_kind: 'taxi',
      account_code: '6420',
      confirmed_observations: 3,
      aged_auto_explained: 0,
      in_window_observations: 3,
      confidence_avg: 0.9,
      pattern_has_competing_signal: false
    },
    config: { ...LEARNER_DEFAULT_CONFIG, enabled: true }
  });
  assert.equal(verdict.verdict, 'skip');
  assert.ok(verdict.blockers.includes(LEARNER_BLOCKERS.PATTERN_EMPTY));
});

// =====================================================================
// 22. Account code missing → ACCOUNT_CODE_MISSING.
// =====================================================================
await test('22. transaction has no account_code → ACCOUNT_CODE_MISSING', async () => {
  const verdict = evaluateLearnedRuleCandidate({
    candidate: {
      firm_id: FIRM_ID,
      client_id: CLIENT_ID,
      canonical_pattern: 'taxi',
      expense_kind: 'taxi',
      account_code: '',
      confirmed_observations: 3,
      aged_auto_explained: 0,
      in_window_observations: 3,
      confidence_avg: 0.9,
      pattern_has_competing_signal: false
    },
    config: { ...LEARNER_DEFAULT_CONFIG, enabled: true }
  });
  assert.equal(verdict.verdict, 'skip');
  assert.ok(verdict.blockers.includes(LEARNER_BLOCKERS.ACCOUNT_CODE_MISSING));
});

// =====================================================================
// 23. Cautious expense_kind → EXPENSE_KIND_UNSAFE.
// =====================================================================
await test('23. cautious-list expense_kind (restaurant_cafe) → EXPENSE_KIND_UNSAFE', async () => {
  const verdict = evaluateLearnedRuleCandidate({
    candidate: {
      firm_id: FIRM_ID,
      client_id: CLIENT_ID,
      canonical_pattern: 'cafe-bistro-x',
      expense_kind: 'restaurant_cafe',
      account_code: '6450',
      confirmed_observations: 5,
      aged_auto_explained: 0,
      in_window_observations: 5,
      confidence_avg: 0.95,
      pattern_has_competing_signal: false
    },
    config: { ...LEARNER_DEFAULT_CONFIG, enabled: true }
  });
  assert.equal(verdict.verdict, 'skip');
  assert.ok(verdict.blockers.includes(LEARNER_BLOCKERS.EXPENSE_KIND_UNSAFE));
});

// =====================================================================
// 24. All observations pre-window → OBSERVATIONS_TOO_OLD.
// =====================================================================
await test('24. zero in-window observations → OBSERVATIONS_TOO_OLD', async () => {
  const verdict = evaluateLearnedRuleCandidate({
    candidate: {
      firm_id: FIRM_ID,
      client_id: CLIENT_ID,
      canonical_pattern: 'taxi',
      expense_kind: 'taxi',
      account_code: '6420',
      confirmed_observations: 0,
      aged_auto_explained: 0,
      in_window_observations: 0,
      confidence_avg: 0.9,
      pattern_has_competing_signal: false
    },
    config: { ...LEARNER_DEFAULT_CONFIG, enabled: true }
  });
  assert.equal(verdict.verdict, 'skip');
  assert.ok(verdict.blockers.includes(LEARNER_BLOCKERS.OBSERVATIONS_TOO_OLD));
});

// =====================================================================
// 25. Retire path emits rule_learning.retired once per cron run.
// =====================================================================
await test('resolveRuleLearningConfig: empty firm → disabled with defaults', () => {
  const cfg = resolveRuleLearningConfig({});
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.min_observations, 3);
  assert.equal(cfg.window_days, 90);
  assert.equal(cfg.confidence_floor, 0.8);
});

await test('resolveRuleLearningConfig: per-firm override', () => {
  const cfg = resolveRuleLearningConfig({
    metadata: {
      rule_learning: {
        enabled: true,
        min_observations: 5,
        window_days: 60,
        confidence_floor: 0.9
      }
    }
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.min_observations, 5);
  assert.equal(cfg.window_days, 60);
  assert.equal(cfg.confidence_floor, 0.9);
});

// =====================================================================
// PR 15 — matched_object_type predicate widening.
//
// The original PR 5 predicate was `= 'document'` (legacy). PR 15
// widens it to include 'receipt' and 'supplier_bill' so the AP-side
// learner consumes the receipt-matcher (PR 1) + bill-matcher (PR 9
// + PR 6 manual-link) confirmed rows. 'sales_invoice' is
// deliberately excluded (AR side has no per-customer account-code
// learning value).
// =====================================================================
