import assert from 'node:assert/strict';
import test from 'node:test';

import {
  QUARANTINE_SPEC_VERSION,
  buildQuarantineCandidate,
  exportChallengerDivergences
} from './export_challenger_divergences.js';

const RUN = {
  id: 'mcr-1',
  firm_id: 'firm-1',
  client_id: 'client-1',
  lane: 'bank_line_classification',
  root_execution_type: 'bank_line_auto_explain',
  root_execution_id: 'tx-77',
  deciding: { model: 'gpt-5.4', model_source: 'configured_fallback' },
  challenger: { model: 'qwen-3.8-served', model_source: 'response_proven', model_artifact: {} },
  outcome: 'divergence',
  failure_class: 'verdict_flip',
  divergence_summary: { field: 'expense_kind', deciding: 'software_subscription', challenger: 'travel' },
  created_at: '2026-08-12T10:00:00Z'
};

const makeMockClient = ({ runs = [RUN], tx = { description: 'AWS EMEA', raw_description: null, money_out: 42.5, currency: 'EUR' } } = {}) => {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes('from model_challenger_runs')) return { rows: runs };
      if (sql.includes('from transactions')) return { rows: tx ? [tx] : [] };
      return { rows: [] };
    }
  };
};

await test('candidate shape: §14.2 privacy block, quarantined-unadjudicated, verdict and models carried whole', () => {
  const candidate = buildQuarantineCandidate({ run: RUN, observation: { kind: 'bank_line', description: 'AWS EMEA', amount: 42.5, currency: 'EUR' } });
  assert.equal(candidate.specVersion, QUARANTINE_SPEC_VERSION);
  assert.equal(candidate.candidateId, 'mcr-1');
  assert.deepEqual(candidate.source.rootExecution, { type: 'bank_line_auto_explain', id: 'tx-77' });
  assert.equal(candidate.models.challenger.model, 'qwen-3.8-served');
  assert.equal(candidate.verdict.failureClass, 'verdict_flip');
  assert.equal(candidate.privacy.use, 'private_client_pack_only_until_adjudicated');
  assert.equal(candidate.adjudication.status, 'quarantined_unadjudicated');
  assert.equal(candidate.adjudication.quarantineClass, null, 'the §14 class is the EAW lane\'s adjudication, never pre-filled');
  assert.equal(candidate.observationNote, null);
});

await test('export: reconstructs the bank-line observation from the transaction behind the execution ref', async () => {
  const client = makeMockClient();
  const candidates = await exportChallengerDivergences({ client });
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].observation, {
    kind: 'bank_line',
    description: 'AWS EMEA',
    amount: 42.5,
    currency: 'EUR'
  });
  const txQuery = client.queries.find((q) => q.sql.includes('from transactions'));
  assert.deepEqual(txQuery.params, ['tx-77', 'firm-1', 'client-1'], 'the lookup is scoped to the run\'s firm+client');
});

await test('export: a deleted domain object still exports — observation null, note recorded', async () => {
  const client = makeMockClient({ tx: null });
  const candidates = await exportChallengerDivergences({ client });
  assert.equal(candidates[0].observation, null);
  assert.match(candidates[0].observationNote, /unavailable/);
});

await test('export: default outcome filter excludes matches; --include-matches lifts it; filters compose', async () => {
  const client = makeMockClient();
  await exportChallengerDivergences({ client, firmId: 'firm-1', lane: 'bank_line_classification', since: '2026-08-01' });
  const runQuery = client.queries.find((q) => q.sql.includes('from model_challenger_runs'));
  assert.match(runQuery.sql, /outcome = any/);
  assert.deepEqual(runQuery.params[0], ['divergence', 'parse_failure', 'challenger_error']);
  assert.deepEqual(runQuery.params.slice(1), ['firm-1', 'bank_line_classification', '2026-08-01']);

  const clientAll = makeMockClient();
  await exportChallengerDivergences({ client: clientAll, includeMatches: true });
  const allQuery = clientAll.queries.find((q) => q.sql.includes('from model_challenger_runs'));
  assert.doesNotMatch(allQuery.sql, /outcome = any/);
});

await test('export: an unknown lane execution type exports refs-only rather than failing', async () => {
  const client = makeMockClient({
    runs: [{ ...RUN, id: 'mcr-2', lane: 'merchant_lookup', root_execution_type: 'merchant_lookup_case' }]
  });
  const candidates = await exportChallengerDivergences({ client });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].observation, null);
});