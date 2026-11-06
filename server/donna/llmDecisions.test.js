import assert from 'node:assert/strict';
import test from 'node:test';

import { recordLlmDecision, recordHumanOutcome, recordLouisVerdict } from './llmDecisions.js';

const makeMockClient = () => {
  const calls = [];
  return {
    calls,
    query: async (text, params = []) => {
      calls.push({ text, params });
      return { rows: [{ id: params[0] }], rowCount: 1 };
    }
  };
};

await test('recordLlmDecision inserts a row with all fields', async () => {
  const client = makeMockClient();
  const id = await recordLlmDecision({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    decisionType: 'match',
    targetType: 'transaction',
    targetId: 'tx-123',
    modelName: 'claude-haiku-4-5-20251001',
    promptVersion: 'abc123',
    deterministicSignals: { amount_exact: true, vendor_overlap: true },
    confidence: { score: 0.88, label: 'high' },
    lane: 'green',
    policyBlockers: [],
    llmReasoning: 'Amount and vendor match.',
    llmRawResponse: { verdict: 'match' },
    finalState: 'system_matched_pending_audit'
  });

  assert.ok(id.startsWith('llmd-'));
  assert.equal(client.calls.length, 1);

  const call = client.calls[0];
  assert.ok(call.text.includes('insert into llm_decisions'));
  assert.equal(call.params[1], 'firm-1');
  assert.equal(call.params[2], 'client-1');
  assert.equal(call.params[3], 'match');
  assert.equal(call.params[4], 'transaction');
  assert.equal(call.params[5], 'tx-123');
  assert.equal(call.params[6], 'claude-haiku-4-5-20251001');
  assert.equal(call.params[7], 'abc123');
  assert.equal(call.params[8], JSON.stringify({ amount_exact: true, vendor_overlap: true }));
  assert.equal(call.params[9], JSON.stringify({ score: 0.88, label: 'high' }));
  assert.equal(call.params[10], 'green');
  assert.deepEqual(call.params[11], []);
  assert.equal(call.params[12], 'Amount and vendor match.');
  assert.equal(call.params[13], JSON.stringify({ verdict: 'match' }));
  assert.equal(call.params[14], 'system_matched_pending_audit');
  assert.equal(call.params[15], null); // configSnapshotId defaults null
});

await test('recordLlmDecision stamps config_snapshot_id when provided', async () => {
  const client = makeMockClient();
  await recordLlmDecision({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    decisionType: 'categorize',
    targetType: 'transaction',
    targetId: 'tx-789',
    configSnapshotId: 'cfg-deadbeef'
  });
  const call = client.calls[0];
  assert.ok(call.text.includes('config_snapshot_id'));
  assert.equal(call.params[15], 'cfg-deadbeef');
});

await test('recordLlmDecision uses defaults for optional fields', async () => {
  const client = makeMockClient();
  const id = await recordLlmDecision({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    decisionType: 'categorize',
    targetType: 'transaction',
    targetId: 'tx-456'
  });

  assert.ok(id.startsWith('llmd-'));
  const call = client.calls[0];
  assert.equal(call.params[6], null); // modelName
  assert.equal(call.params[7], null); // promptVersion
  assert.equal(call.params[8], JSON.stringify({})); // deterministicSignals
  assert.equal(call.params[9], JSON.stringify({})); // confidence
  assert.equal(call.params[10], null); // lane
  assert.deepEqual(call.params[11], []); // policyBlockers
  assert.equal(call.params[12], null); // llmReasoning
  assert.equal(call.params[13], null); // llmRawResponse
  assert.equal(call.params[14], null); // finalState
  assert.equal(call.params[15], null); // configSnapshotId
});

await test('recordLlmDecision generates unique ids', async () => {
  const client = makeMockClient();
  const id1 = await recordLlmDecision({
    client,
    firmId: 'f',
    clientId: 'c',
    decisionType: 'match',
    targetType: 'transaction',
    targetId: 'tx-1'
  });
  const id2 = await recordLlmDecision({
    client,
    firmId: 'f',
    clientId: 'c',
    decisionType: 'match',
    targetType: 'transaction',
    targetId: 'tx-1'
  });
  assert.notEqual(id1, id2);
});

await test('recordHumanOutcome updates the row', async () => {
  const client = makeMockClient();
  const updated = await recordHumanOutcome({
    client,
    decisionId: 'llmd-abc',
    outcome: 'confirmed',
    metadata: null
  });

  assert.equal(updated, true);
  assert.equal(client.calls.length, 1);
  const call = client.calls[0];
  assert.ok(call.text.includes('update llm_decisions'));
  assert.ok(call.text.includes('human_outcome'));
  assert.match(call.text, /client_id\s+is\s+not\s+null/i, 'detached archival receipts cannot receive a later outcome');
  assert.equal(call.params[0], 'confirmed');
  assert.equal(call.params[1], null);
  assert.equal(call.params[2], 'llmd-abc');
});

await test('recordHumanOutcome with edit metadata', async () => {
  const client = makeMockClient();
  await recordHumanOutcome({
    client,
    decisionId: 'llmd-xyz',
    outcome: 'edited',
    metadata: { original_account: 'Fuel', new_account: 'Travel' }
  });

  const call = client.calls[0];
  assert.equal(call.params[0], 'edited');
  assert.equal(call.params[1], JSON.stringify({ original_account: 'Fuel', new_account: 'Travel' }));
});

await test('recordHumanOutcome returns false when row not found', async () => {
  const client = {
    query: async () => ({ rows: [], rowCount: 0 })
  };
  const updated = await recordHumanOutcome({
    client,
    decisionId: 'llmd-nonexistent',
    outcome: 'rejected'
  });
  assert.equal(updated, false);
});

// Phase 0C — correction chain (§4). A mock that returns the prediction identity on the
// UPDATE … RETURNING (so a superseding receipt can be linked), and {id} otherwise.
const makeChainMock = (original) => {
  const calls = [];
  return {
    calls,
    query: async (text, params = []) => {
      calls.push({ text, params });
      if (/returning\s+id,\s*firm_id/i.test(text)) {
        return { rows: [original], rowCount: 1 };
      }
      return { rows: [{ id: params[0] }], rowCount: 1 };
    }
  };
};

await test('recordLlmDecision stamps the correction-chain link when provided', async () => {
  const client = makeMockClient();
  await recordLlmDecision({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    decisionType: 'categorize',
    targetType: 'transaction',
    targetId: 'tx-1',
    finalState: 'Travel',
    previousDecisionId: 'llmd-original',
    correctionReason: 'human_edited'
  });
  const call = client.calls[0];
  assert.ok(call.text.includes('previous_decision_id'));
  assert.ok(call.text.includes('correction_reason'));
  assert.equal(call.params[16], 'llmd-original');
  assert.equal(call.params[17], 'human_edited');
});

await test('recordLlmDecision leaves the chain link null by default', async () => {
  const client = makeMockClient();
  await recordLlmDecision({
    client,
    firmId: 'f',
    clientId: 'c',
    decisionType: 'match',
    targetType: 'transaction',
    targetId: 'tx-1'
  });
  const call = client.calls[0];
  assert.equal(call.params[16], null); // previousDecisionId
  assert.equal(call.params[17], null); // correctionReason
});

await test('recordHumanOutcome confirmed does NOT write a superseding receipt', async () => {
  const client = makeChainMock({
    id: 'llmd-orig', firm_id: 'f', client_id: 'c',
    decision_type: 'categorize', target_type: 'transaction', target_id: 'tx-1'
  });
  const ok = await recordHumanOutcome({ client, decisionId: 'llmd-orig', outcome: 'confirmed' });
  assert.equal(ok, true);
  assert.equal(client.calls.length, 1); // only the in-place annotation; agreement is not a correction
});

await test('recordHumanOutcome edited writes a linked superseding receipt with the corrected state', async () => {
  const client = makeChainMock({
    id: 'llmd-orig', firm_id: 'f', client_id: 'c',
    decision_type: 'categorize', target_type: 'transaction', target_id: 'tx-1'
  });
  await recordHumanOutcome({
    client,
    decisionId: 'llmd-orig',
    outcome: 'edited',
    metadata: { firm_account_code: '6000-Travel', llm_account_code: '5000-Fuel' }
  });
  assert.equal(client.calls.length, 2); // annotation + superseding insert
  const insert = client.calls[1];
  assert.ok(insert.text.includes('insert into llm_decisions'));
  assert.equal(insert.params[1], 'f');               // firm_id carried from original
  assert.equal(insert.params[3], 'categorize');      // decision_type carried
  assert.equal(insert.params[5], 'tx-1');            // target_id carried
  assert.equal(insert.params[6], null);              // model_name null — human-authored
  assert.equal(insert.params[14], '6000-Travel');    // final_state = the human's code
  assert.equal(insert.params[15], null);             // config_snapshot_id null
  assert.equal(insert.params[16], 'llmd-orig');      // previous_decision_id → original
  assert.equal(insert.params[17], 'human_edited');   // correction_reason
});

await test('recordHumanOutcome rejected writes a superseding receipt with final_state=rejected', async () => {
  const client = makeChainMock({
    id: 'llmd-orig', firm_id: 'f', client_id: 'c',
    decision_type: 'categorize', target_type: 'transaction', target_id: 'tx-1'
  });
  await recordHumanOutcome({ client, decisionId: 'llmd-orig', outcome: 'rejected' });
  assert.equal(client.calls.length, 2);
  const insert = client.calls[1];
  assert.equal(insert.params[14], 'rejected');       // final_state
  assert.equal(insert.params[16], 'llmd-orig');      // chain link
  assert.equal(insert.params[17], 'human_rejected'); // correction_reason
});

await test('recordHumanOutcome writes no superseding receipt when the original is missing', async () => {
  const client = {
    calls: [],
    query: async (text, params = []) => {
      client.calls.push({ text, params });
      return { rows: [], rowCount: 0 };
    }
  };
  const ok = await recordHumanOutcome({ client, decisionId: 'llmd-missing', outcome: 'edited' });
  assert.equal(ok, false);
  assert.equal(client.calls.length, 1); // the UPDATE only; no chain insert on a no-op
});

await test('recordLouisVerdict updates the row', async () => {
  const client = makeMockClient();
  const updated = await recordLouisVerdict({
    client,
    decisionId: 'llmd-abc',
    verdict: { verdict: 'pass', scores: { amount_validity: 5 }, reasoning: 'Looks good.' }
  });

  assert.equal(updated, true);
  assert.equal(client.calls.length, 1);
  const call = client.calls[0];
  assert.ok(call.text.includes('update llm_decisions'));
  assert.ok(call.text.includes('louis_verdict'));
  assert.ok(call.text.includes('louis_evaluated_at'));
  assert.match(call.text, /client_id\s+is\s+not\s+null/i, 'detached archival receipts cannot receive a later verdict');
  const verdictJson = JSON.parse(call.params[0]);
  assert.equal(verdictJson.verdict, 'pass');
  assert.equal(verdictJson.reasoning, 'Looks good.');
  assert.equal(call.params[1], 'llmd-abc');
});

await test('recordLouisVerdict returns false when row not found', async () => {
  const client = {
    query: async () => ({ rows: [], rowCount: 0 })
  };
  const updated = await recordLouisVerdict({
    client,
    decisionId: 'llmd-nonexistent',
    verdict: { verdict: 'fail', scores: {}, reasoning: 'N/A' }
  });
  assert.equal(updated, false);
});
