import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutionBudget, runWithExecutionBudget, assertExecutionBudgetActive } from './executionBudget.js';
import { hookPooledClient, withConvergenceSettle } from './reconcileConvergenceState.js';

for (const mode of ['pooled', 'callback', 'nested']) {
  for (const failedSettle of [false, true]) {
    test(`${mode}: expiry during ${failedSettle ? 'failed' : 'successful'} commit settlement rolls back verdict, permits failure receipt`, async () => {
      const budget = createExecutionBudget({ timeoutMs: 10000 });
      const calls = [];
      let expireAtSettle = true;
      const client = {
        query: async (text) => {
          calls.push(text);
          if (/delete from convergence_marks/.test(text) && expireAtSettle) {
            budget.abort('expired_during_commit_settle');
            if (failedSettle) throw new Error('settlement failed');
          }
          return { rows: [] };
        },
        release() {}
      };
      const logger = { error() {}, warn() {} };
      if (mode !== 'callback') hookPooledClient(client, { logger });
      const run = async () => runWithExecutionBudget(budget, async () => {
        await client.query('begin');
        assertExecutionBudgetActive({ client });
        await assert.rejects(client.query('commit'), { code: 'EXECUTION_BUDGET_EXHAUSTED' });
        assert.equal(calls.filter((q) => q === 'commit').length, 0, 'expired verdict never sends COMMIT');
        await client.query('rollback');
        expireAtSettle = false;
        // The expired worker still owns time to write its technical failure.
        await client.query('begin');
        await client.query('commit');
        assert.equal(calls.filter((q) => q === 'commit').length, 1);
      });
      if (mode === 'pooled') await run();
      else await withConvergenceSettle(client, run, { logger });
      if (mode !== 'callback') await client.release();
    });
  }
}
