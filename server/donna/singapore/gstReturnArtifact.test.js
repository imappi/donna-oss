import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGstF5FromLedgerLines, gstF5BoxMapProvenance } from './gstReturn.js';
import { buildSingaporeGstDraftArtifact, getSingaporeGstDraftArtifactFromDb } from './gstReturnArtifact.js';

const sourceReadiness = { status: 'no_unfinished_local_sources', concerns: [] };
const args = { firmId: 'firm', clientId: 'client', period: '2026-Q2', readAt: '2026-09-24T12:00:00.000Z' };

test('draft serialization is deterministic, preserves an unready verdict and never mutates its source', () => {
  const computed = { ...buildGstF5FromLedgerLines({ period: args.period, lines: [
    { journal_id: 'source', line_no: 1, account_type: 'revenue', credit: 100, debit: 0 }
  ] }), provenance: { source: 'ledger_read_model', readAt: args.readAt, deterministic: true, boxMap: gstF5BoxMapProvenance() } };
  const before = structuredClone(computed);
  const artifact = buildSingaporeGstDraftArtifact({ ...args, computed, sourceReadiness });
  assert.equal(artifact.review.status, 'needs_review');
  assert.deepEqual(artifact.review.blockers, ['uncoded_revenue_lines']);
  assert.deepEqual(artifact.gstReturn, before.gstReturn);
  assert.deepEqual(artifact.provenance, before.provenance);
  assert.equal(artifact.as_of, args.readAt);
  assert.equal(artifact.scope, 'draft_for_firm_review');
  assert.deepEqual(computed, before);
  assert.equal(JSON.stringify(artifact), JSON.stringify(buildSingaporeGstDraftArtifact({ ...args, computed, sourceReadiness })));
});

test('artifact reader rolls back and retains source failure; no partial artifact escapes', async () => {
  const queries = [];
  const cause = Object.assign(new Error('fixture read failed'), { code: 'SG6_READ_FAILURE' });
  const client = { query: async sql => {
    queries.push(sql);
    if (sql.startsWith('begin') || sql === 'rollback') return { rows: [] };
    if (sql.startsWith('select id from clients')) return { rows: [{ id: args.clientId }] };
    throw cause;
  } };
  await assert.rejects(getSingaporeGstDraftArtifactFromDb({ ...args, withFirmDbClientFn: fn => fn(client) }), error => error === cause);
  assert.equal(queries[0], 'begin isolation level repeatable read read only');
  assert.equal(queries.at(-1), 'rollback');
  assert.ok(!queries.includes('commit'));
});


test('serializer preserves both unconfirmed and confirmed source provenance verbatim', () => {
  for (const boxMap of [
    { confirmedAgainstPrimary: false, source: 'Synthetic unconfirmed fixture' },
    { confirmedAgainstPrimary: true, source: 'Synthetic confirmed fixture',
      url: 'https://primary-source.example.invalid/gst-f5', as_of: '2026-09-24' }
  ]) {
    const computed = { ...buildGstF5FromLedgerLines({ period: args.period }),
      provenance: { source: 'ledger_read_model', readAt: args.readAt, deterministic: true, boxMap } };
    const artifact = buildSingaporeGstDraftArtifact({ ...args, computed, sourceReadiness });
    assert.deepEqual(JSON.parse(JSON.stringify(artifact)).provenance.boxMap, boxMap);
    assert.equal(artifact.scope, 'draft_for_firm_review');
    assert.equal(artifact.filing.submitted, false, 'source confirmation is never filing authority');
    assert.equal(artifact.as_of, args.readAt, 'read timestamp is distinct from source as_of');
  }
});

 test('missing source observation cannot inherit calculation readiness', () => {
  const computed = { ...buildGstF5FromLedgerLines({ period: args.period }), provenance: { readAt: args.readAt } };
  const artifact = buildSingaporeGstDraftArtifact({ ...args, computed });
  assert.equal(artifact.calculation_review.status, 'ready');
  assert.equal(artifact.review.status, 'needs_review');
  assert.ok(artifact.review.blockers.includes('local_source:observation_missing'));
});

test('artifact carries the not-coded-at-posting blocker and limitation; fixed labels cannot be overridden by compute keys', () => {
  const computed = { ...buildGstF5FromLedgerLines({ period: args.period, lines: [
    { account_code: '7000', account_type: 'expense', debit: 1090, credit: 0, tax_type: 'INPUTY24' }
  ] }), currency: 'EUR', scope: 'filed', provenance: { readAt: args.readAt } };
  const artifact = buildSingaporeGstDraftArtifact({ ...args, computed, sourceReadiness });
  assert.equal(artifact.review.status, 'needs_review');
  assert.ok(artifact.review.blockers.includes('gst_not_coded_at_posting'));
  assert.equal(artifact.currency, 'SGD');
  assert.equal(artifact.scope, 'draft_for_firm_review');
  const text = artifact.limitations.join(' ');
  assert.match(text, /not yet coded or split at posting/);
  assert.doesNotMatch(text, /SG-2 source corrections/);
});
