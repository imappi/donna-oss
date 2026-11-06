// FI-02 — the family re-drive's correction leg, unit-level. The real-PG
// lifecycle (one fresh evaluation, the retirement, the neighbour untouched) is
// documentCorrectionReopenAppliancePgLifecycle.test.js; this pins the two
// orderings the appliance run does not reach: a corrected document whose fresh
// evaluation ANOTHER path already ran is retired without a second evaluation,
// and a still-owed one is reopened before it is evaluated and retired after.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  recoverReconciliationProviderFailures,
  CORRECTION_REEVALUATION_PENDING_CODE
} from './reconciliationProviderFailure.js';

const discovered = (documentId) => ({
  document_id: documentId, client_id: 'cl', document_type: 'supplier_bill',
  receipt: { code: CORRECTION_REEVALUATION_PENDING_CODE }
});

const harness = ({ owed, receiptedAfter = false }) => {
  const order = [];
  const client = {
    query: async (sql) => {
      if (/limit \$2/.test(sql)) return { rows: [discovered('doc-1')] };
      if (/as pending from documents d/.test(sql)) return { rows: [{ pending: owed }] };
      if (/as receipted/.test(sql)) return { rows: [{ receipted: receiptedAfter }] };
      return { rows: [] };
    }
  };
  return {
    order,
    run: () => recoverReconciliationProviderFailures({
      client, firmId: 'f', withClient: (fn) => fn(client), onRunCompletedFn: null,
      runFamilyFn: async () => { order.push('evaluate'); return {}; },
      reopenCorrectedFn: async () => { order.push('reopen'); return []; },
      retireUnrefreshedFn: async () => { order.push('retire'); return ['m-1']; }
    })
  };
};

test('a corrected document whose fresh evaluation already ran is retired, never evaluated twice', async () => {
  const { order, run } = harness({ owed: false });
  const results = await run();
  assert.deepEqual(order, ['retire', 'reopen']);
  assert.equal(results[0].outcome, 'recovered');
  assert.deepEqual(results[0].retired_match_ids, ['m-1']);
});

test('a corrected document still owed its evaluation is reopened, evaluated once, then retired', async () => {
  const { order, run } = harness({ owed: true });
  const results = await run();
  assert.deepEqual(order, ['retire', 'reopen', 'evaluate', 'retire']);
  assert.equal(results[0].outcome, 'recovered');
});

test('an evaluation that left the document owed (provider still down) is not followed by a retirement', async () => {
  const { order, run } = harness({ owed: true, receiptedAfter: true });
  const results = await run();
  assert.deepEqual(order, ['retire', 'reopen', 'evaluate']);
  assert.equal(results[0].outcome, 'unchanged');
});
