// Tests for the model-text retention sweep and the client-deletion purge.
// Policy: docs/donna-data-lifecycle-policy.md (Kari, 2026-07-28).
//
// THE THREE TIERS are the spec:
//   1. structured decision receipt — RETAINED firm-side; its deleted-client
//      link is nulled and stamped while prediction fields remain untouched.
//   2. curated model reasoning (llm_reasoning) — 90 days. The POPULATED column.
//   3. raw provider envelope (llm_raw_response) — not captured; its clock is a
//      prospective control.
//
// Three layers, and the middle one is the point:
//   1. the pure cutoff math;
//   2. the SWEEP-vs-TRIGGER conformance check — each tier's UPDATE is parsed out
//      of this module and checked against migration 107's per-column predicate
//      parsed out of the SQL. This is the real integration risk: an UPDATE whose
//      shape drifts from its four-clause predicate is refused by the database at
//      runtime and would otherwise surface only in production;
//   3. the writer's behaviour against a mock client.
//
// Not claimed here: these tests do not execute PostgreSQL, so they do not prove
// the trigger fires. The trigger's text is pinned clause by clause in
// migrations.test.js ('107 …'), and layer 2 ties this module's SQL to that text.
// Between them, a drift on either side fails a test.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LLM_RAW_RESPONSE_RETENTION_DAYS,
  LLM_REASONING_RETENTION_DAYS,
  LLM_RAW_RESPONSE_RETENTION_PROVENANCE,
  DEFAULT_SWEEP_LIMIT,
  PROSE_TIERS,
  retentionCutoff,
  sweepLlmProseRetention,
  archiveLlmDecisionsForDeletedClient
} from './llmDecisionRetention.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolvePath(__dirname, '..', '..');
const moduleSource = readFileSync(resolvePath(__dirname, 'llmDecisionRetention.js'), 'utf8');
const migrationSql = readFileSync(
  resolvePath(repoRoot, 'db', 'migrations', '107_llm_reasoning_retention.sql'),
  'utf8'
);
const detachmentMigrationSql = readFileSync(
  resolvePath(repoRoot, 'db', 'migrations', '129_llm_decision_client_detachment.sql'),
  'utf8'
);

// Per-column row counts, so a test can tell the two tiers' statements apart.
const makeMockClient = ({
  reasoningRows = 0,
  rawRows = 0,
  detachedRows = 0,
  undated = 0,
  failAudit = false,
  missingColumn = null
} = {}) => {
  const calls = [];
  return {
    calls,
    query: async (text, params = []) => {
      calls.push({ text, params });
      if (/update\s+llm_decisions/i.test(text) && /client_id\s*=\s*null/i.test(text)) {
        if (missingColumn && text.includes(missingColumn)) {
          throw Object.assign(new Error(`column "${missingColumn}" does not exist`), { code: '42703' });
        }
        return { rows: Array.from({ length: detachedRows }, (_, i) => ({ id: `detached-${i}` })), rowCount: detachedRows };
      }
      if (/update\s+llm_decisions/i.test(text)) {
        const column = /llm_reasoning\s*=\s*null/i.test(text) ? 'llm_reasoning' : 'llm_raw_response';
        if (missingColumn && text.includes(missingColumn)) {
          throw Object.assign(new Error(`column "${missingColumn}" does not exist`), { code: '42703' });
        }
        const n = column === 'llm_reasoning' ? reasoningRows : rawRows;
        return { rows: Array.from({ length: n }, (_, i) => ({ id: `llmd-${i}` })), rowCount: n };
      }
      if (/count\(\*\)/i.test(text)) return { rows: [{ undated }], rowCount: 1 };
      if (/insert\s+into\s+audit_events/i.test(text)) {
        if (failAudit) throw new Error('audit boom');
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
  };
};

const updateCalls = (client) => client.calls.filter((c) => /update\s+llm_decisions/i.test(c.text));
const proseUpdateCalls = (client) => updateCalls(client).filter((c) => !/client_id\s*=\s*null/i.test(c.text));
const detachmentCalls = (client) => updateCalls(client).filter((c) => /client_id\s*=\s*null/i.test(c.text));
const updateFor = (client, column) => proseUpdateCalls(client).find((c) => new RegExp(`${column}\\s*=\\s*null`, 'i').test(c.text));
const auditCalls = (client) => client.calls.filter((c) => /insert\s+into\s+audit_events/i.test(c.text));

// ── 1. Policy constants + cutoff math ───────────────────────────────────────

await test('both prose tiers are 90 days, as CONSTANTS — never env vars', () => {
  assert.equal(LLM_REASONING_RETENTION_DAYS, 90, 'tier 2 — the populated column');
  assert.equal(LLM_RAW_RESPONSE_RETENTION_DAYS, 90, 'tier 3 — the prospective one');
  // SEPARATE constants on purpose: the tiers have independent lifecycles, and
  // policy permits tier 3 to be SHORTER but never longer. One shared constant
  // would silently couple them.
  assert.equal(PROSE_TIERS.length, 2);
  assert.deepEqual(PROSE_TIERS.map((t) => t.column).sort(), ['llm_raw_response', 'llm_reasoning']);
  // The rollout-flag rail: env carries secrets, tuning knobs and kill switches.
  // A retention window a stray env var can WIDEN is the "client name in an env
  // var" anti-pattern wearing a different hat.
  assert.doesNotMatch(moduleSource, /process\.env/, 'the policy module reads no env at all');
  assert.equal(LLM_RAW_RESPONSE_RETENTION_PROVENANCE.decidedBy, 'Kari');
  // Both first-class markets, not one — the standing parallel-build question.
  assert.match(LLM_RAW_RESPONSE_RETENTION_PROVENANCE.basis, /UK GDPR/);
  assert.match(LLM_RAW_RESPONSE_RETENTION_PROVENANCE.basis, /Finland/);
});

await test('retentionCutoff is pure, UTC, and honours a per-tier window', () => {
  const now = Date.parse('2026-07-28T12:00:00.000Z');
  assert.equal(retentionCutoff(now), '2026-04-29T12:00:00.000Z');
  assert.equal(retentionCutoff(now, { days: 30 }), '2026-06-28T12:00:00.000Z', 'per-tier days');
  const d = new Date(now);
  assert.equal(retentionCutoff(d), '2026-04-29T12:00:00.000Z');
  assert.equal(d.getTime(), now, 'the input Date is untouched');
  assert.equal(retentionCutoff(now), retentionCutoff(now), 'deterministic');
});

await test('retentionCutoff REFUSES an unusable instant rather than silently computing 1970', () => {
  // The failure mode this guards: a cutoff that matches every row, i.e.
  // redacting the whole table.
  assert.throws(() => retentionCutoff(Number.NaN), /finite instant/);
  assert.throws(() => retentionCutoff('not-a-date'), /finite instant/);
  assert.throws(() => retentionCutoff(Date.now(), { days: -1 }), /non-negative window/);
});

// ── 2. Sweep ↔ trigger conformance, per tier ────────────────────────────────

await test('migration 107 carries BOTH four-clause predicates, independently gated', () => {
  for (const column of ['llm_reasoning', 'llm_raw_response']) {
    assert.match(migrationSql, new RegExp(`old\\.${column}\\s+is\\s+not\\s+null`, 'i'), `${column} clause 1`);
    assert.match(migrationSql, new RegExp(`new\\.${column}\\s+is\\s+null`, 'i'), `${column} clause 2`);
    assert.match(migrationSql, new RegExp(`old\\.${column}_redacted_at\\s+is\\s+null`, 'i'), `${column} clause 3 (write-once)`);
    assert.match(migrationSql, new RegExp(`new\\.${column}_redacted_at\\s+is\\s+not\\s+null`, 'i'), `${column} clause 4 (mandatory stamp)`);
  }
  // Independently gated — each tier appends only its OWN pair to `exempt`, so a
  // correctly-shaped reasoning redaction cannot smuggle a raw edit through.
  assert.match(migrationSql, /if\s+raw_redaction\s+then\s*\n\s*exempt\s*:=\s*exempt\s*\|\|\s*array\['llm_raw_response',\s*'llm_raw_response_redacted_at'\]/i);
  assert.match(migrationSql, /if\s+reasoning_redaction\s+then\s*\n\s*exempt\s*:=\s*exempt\s*\|\|\s*array\['llm_reasoning',\s*'llm_reasoning_redacted_at'\]/i);
});

await test('each tier issues ONE UPDATE assigning EXACTLY its own two columns', async () => {
  // A combined statement would be REFUSED on a row carrying reasoning but no raw
  // — which is every row today: the raw stamp would change while raw_redaction
  // was false, and the diff would catch it. That is the trigger working.
  const client = makeMockClient({ reasoningRows: 2, rawRows: 0 });
  await sweepLlmProseRetention({ client, firmId: 'firm-1', now: Date.now() });
  const updates = proseUpdateCalls(client);
  assert.equal(updates.length, 2, 'one statement per tier, never one combined');

  for (const [column, stamp] of [['llm_reasoning', 'llm_reasoning_redacted_at'], ['llm_raw_response', 'llm_raw_response_redacted_at']]) {
    const call = updateFor(client, column);
    assert.ok(call, `${column} has its own UPDATE`);
    const setBlock = call.text.slice(call.text.indexOf('set '), call.text.indexOf('where'));
    const assigned = (setBlock.match(/(?:set|,)\s+([a-z_]+)\s*=/gi) || [])
      .map((m) => m.replace(/^(?:set|,)\s+/i, '').replace(/\s*=$/, ''));
    assert.deepEqual(
      assigned.sort(),
      [column, stamp].sort(),
      `${column}'s UPDATE assigns exactly its own pair — anything else is refused by the trigger`
    );
    // Clause 1+3: only rows that HAVE something to redact, which is also what
    // makes it idempotent — a redacted row stops matching.
    assert.match(call.text, new RegExp(`${column}\\s+is\\s+not\\s+null`, 'i'), `${column} clause 1/3`);
  }
});

await test('TIER 1 IS NEVER TOUCHED — the structured receipt and correction chain survive', () => {
  // The whole point of the three-tier split: what a dispute is answered from
  // (verdict, model id, prompt version, confidence, signals, blockers, final
  // state, config snapshot, correction lineage) is retained.
  for (const col of [
    'final_state', 'previous_decision_id', 'correction_reason', 'model_name',
    'prompt_version', 'confidence', 'deterministic_signals', 'policy_blockers',
    'config_snapshot_id', 'lane'
  ]) {
    assert.doesNotMatch(moduleSource, new RegExp(`set[^;]*\\b${col}\\s*=`, 'i'), `never assigns ${col}`);
  }
  assert.doesNotMatch(moduleSource, /delete\s+from\s+llm_decisions/i, 'no hard DELETE — it would break the correction chain');
});

// ── 3. The sweep's behaviour ────────────────────────────────────────────────

await test('each tier scopes to the firm, its OWN cutoff, and a bounded limit', async () => {
  const client = makeMockClient({ reasoningRows: 3, rawRows: 0 });
  const now = Date.parse('2026-07-28T12:00:00.000Z');
  const summary = await sweepLlmProseRetention({ client, firmId: 'firm-1', now, limit: 100 });

  const call = updateFor(client, 'llm_reasoning');
  assert.deepEqual(call.params, ['firm-1', '2026-04-29T12:00:00.000Z', 100]);
  assert.match(call.text, /firm_id\s*=\s*\$1/i, 'scoped to one firm');
  assert.match(call.text, /created_at\s*<\s*\$2/i, 'strictly older than the cutoff');
  assert.doesNotMatch(call.text, /created_at\s*<=/i, 'strict — a row exactly at the boundary is kept');
  assert.match(call.text, /limit\s+\$3/i, 'bounded per run');
  assert.match(call.text, /order\s+by\s+created_at/i, 'oldest first, so a capped run drains the tail deterministically');

  assert.equal(summary.reasoning_redacted, 3);
  assert.equal(summary.raw_redacted, 0, 'tier 3 stays prospective — nothing writes it');
  assert.equal(summary.redacted, 3);
  assert.equal(summary.more_remaining, false, '3 of a 100 cap is convergence');
});

await test('the sweep is idempotent: a converged firm redacts zero and audits nothing', async () => {
  const client = makeMockClient({ reasoningRows: 0, rawRows: 0 });
  const summary = await sweepLlmProseRetention({ client, firmId: 'firm-1', now: Date.now() });
  assert.equal(summary.redacted, 0);
  assert.equal(auditCalls(client).length, 0, 'a converged firm stays quiet — no audit noise');
});

await test('a run that redacted rows emits ONE roll-up audit, split by tier', async () => {
  const client = makeMockClient({ reasoningRows: 7, rawRows: 2 });
  const now = Date.parse('2026-07-28T12:00:00.000Z');
  await sweepLlmProseRetention({ client, firmId: 'firm-1', now, limit: 500 });

  const audits = auditCalls(client);
  assert.equal(audits.length, 1, 'per RUN, not per row — the per-row receipt is the tier stamp');
  assert.match(audits[0].text, /'llm_decision\.prose_redacted'/);
  const metadata = JSON.parse(audits[0].params[2]);
  assert.equal(metadata.reasoning_redacted, 7);
  assert.equal(metadata.raw_redacted, 2);
  assert.equal(metadata.redacted, 9);
  assert.equal(metadata.tiers.length, 2, 'the per-tier breakdown rides the receipt');
});

await test('a failed roll-up audit does not fail the sweep — the durable receipt is on the row', async () => {
  // Best-effort BY DESIGN and safe to be: migration 107 makes the per-row stamp
  // mandatory and write-once, so a lost roll-up loses no evidence.
  const client = makeMockClient({ reasoningRows: 2, failAudit: true });
  const logged = [];
  const summary = await sweepLlmProseRetention({
    client, firmId: 'firm-1', now: Date.now(), logger: { error: (...a) => logged.push(a) }
  });
  assert.equal(summary.redacted, 2, 'the redaction stands');
  assert.equal(logged.length, 1, 'and the failure is loud, not swallowed');
});

await test('un-ageable rows (prose, no created_at) are COUNTED, never silently swept', async () => {
  // migration 018 declares created_at `default now()`, not `not null`.
  const client = makeMockClient({ reasoningRows: 1, undated: 4 });
  const summary = await sweepLlmProseRetention({ client, firmId: 'firm-1', now: Date.now() });
  assert.equal(summary.undated, 8, 'counted per tier and summed');
  assert.match(updateFor(client, 'llm_reasoning').text, /created_at\s+is\s+not\s+null/i, 'excluded from the UPDATE');
  assert.ok(client.calls.some((c) => /count\(\*\)/i.test(c.text) && /created_at\s+is\s+null/i.test(c.text)), 'and surfaced by a count');
});

await test('more_remaining is true when ANY tier hit its cap', async () => {
  const capped = makeMockClient({ reasoningRows: 50, rawRows: 0 });
  assert.equal((await sweepLlmProseRetention({ client: capped, firmId: 'f', now: Date.now(), limit: 50 })).more_remaining, true);
  const drained = makeMockClient({ reasoningRows: 49, rawRows: 0 });
  assert.equal((await sweepLlmProseRetention({ client: drained, firmId: 'f', now: Date.now(), limit: 50 })).more_remaining, false);
});

await test('the sweep refuses to run unscoped, and an unusable limit falls back to bounded', async () => {
  await assert.rejects(() => sweepLlmProseRetention({ firmId: 'f' }), /db client/);
  await assert.rejects(() => sweepLlmProseRetention({ client: makeMockClient() }), /firmId/);
  for (const limit of [0, -5, Number.NaN, null, undefined]) {
    const client = makeMockClient();
    await sweepLlmProseRetention({ client, firmId: 'f', now: Date.now(), limit });
    assert.equal(updateFor(client, 'llm_reasoning').params[2], DEFAULT_SWEEP_LIMIT, `limit=${String(limit)} falls back`);
  }
});

// ── 4. Client deletion (policy §4) ──────────────────────────────────────────

await test('client deletion redacts both prose tiers and de-links retained receipts, with no age filter', async () => {
  // Retention by AGE and lifecycle by OWNING SCOPE are different questions.
  // llm_decisions.client_id has no clients FK, so the delete cascade misses it
  // entirely — receipts survived by SCHEMA OMISSION, not by decision.
  const client = makeMockClient({ reasoningRows: 5, rawRows: 0, detachedRows: 8 });
  const result = await archiveLlmDecisionsForDeletedClient({ client, firmId: 'firm-1', clientId: 'client-a' });

  assert.equal(result.redacted, 5);
  assert.equal(result.detached, 8, 'all structured receipts detach, including rows that never held prose');
  assert.equal(proseUpdateCalls(client).length, 2, 'one statement per tier, same as the sweep');
  for (const column of ['llm_reasoning', 'llm_raw_response']) {
    const call = updateFor(client, column);
    assert.deepEqual(call.params, ['firm-1', 'client-a'], 'scoped to firm AND client');
    assert.match(call.text, /client_id\s*=\s*\$2/i);
    // Deletion is not expiry: no cutoff, no limit, no ordering.
    assert.doesNotMatch(call.text, /created_at/i, `${column}: deletion must not be age-filtered`);
    assert.doesNotMatch(call.text, /\blimit\b/i, `${column}: deletion must not be capped`);
  }
  const detach = detachmentCalls(client)[0];
  assert.deepEqual(detach.params, ['firm-1', 'client-a']);
  assert.match(detach.text, /client_id\s*=\s*null/i);
  assert.match(detach.text, /client_detached_at\s*=\s*now\(\)/i);
  assert.match(detach.text, /llm_reasoning\s+is\s+null/i, 'prose destruction precedes the de-link');
  assert.match(detach.text, /llm_raw_response\s+is\s+null/i, 'raw destruction precedes the de-link');
  const receipt = auditCalls(client).find((call) => call.text.includes('llm_decision.client_detached'));
  assert.ok(receipt, 'the archival transition carries a roll-up receipt');
  assert.deepEqual(JSON.parse(receipt.params[2]), {
    contract_version: 'donna.llm-decision-client-detachment.v1',
    detached_receipts: 8,
    prose_redactions: 5,
    authority_basis: 'client_delete_transaction'
  });
});

await test('client deletion retains tier 1 only in the stamped de-linked archival shape', () => {
  assert.doesNotMatch(moduleSource, /delete\s+from\s+llm_decisions/i, 'no row deletion without a dated decision');
  assert.match(detachmentMigrationSql, /alter\s+column\s+client_id\s+drop\s+not\s+null/i);
  assert.match(detachmentMigrationSql, /old\.client_id\s+is\s+not\s+null[\s\S]*new\.client_id\s+is\s+null/i);
  assert.match(detachmentMigrationSql, /old\.client_detached_at\s+is\s+null[\s\S]*new\.client_detached_at\s+is\s+not\s+null/i);
  assert.match(detachmentMigrationSql, /current_setting\('donna\.allow_llm_decision_client_detachment'/i,
    'ordinary writers cannot use the de-link exemption');
});

await test('client deletion is presence-guarded — a pre-107 deploy can never block a delete', async () => {
  // The firm_facts posture: a retention column that does not exist yet must not
  // make a client undeletable.
  const client = makeMockClient({ reasoningRows: 0, rawRows: 0, missingColumn: 'llm_reasoning_redacted_at' });
  const result = await archiveLlmDecisionsForDeletedClient({ client, firmId: 'firm-1', clientId: 'client-a' });
  assert.equal(result.tiers.find((t) => t.column === 'llm_reasoning').skipped, 'column_absent');
  assert.equal(result.redacted, 0, 'skipped, not crashed');
});

await test('client deletion presence-guards the migration 129 detachment column too', async () => {
  const client = makeMockClient({ missingColumn: 'client_detached_at' });
  const result = await archiveLlmDecisionsForDeletedClient({ client, firmId: 'firm-1', clientId: 'client-a' });
  assert.equal(result.detached, 0);
  assert.equal(result.detachment_skipped, 'migration_129_absent');
});

await test('client deletion re-raises a REAL error rather than swallowing it', async () => {
  // Only the missing-column case (42703) is tolerated. A permissions or
  // constraint failure must abort the delete transaction, not be papered over.
  const client = {
    query: async () => { throw Object.assign(new Error('permission denied'), { code: '42501' }); }
  };
  await assert.rejects(
    () => archiveLlmDecisionsForDeletedClient({ client, firmId: 'f', clientId: 'c' }),
    /permission denied/
  );
});

await test('client deletion no-ops safely on missing arguments', async () => {
  for (const args of [{}, { firmId: 'f' }, { clientId: 'c' }, { client: makeMockClient(), firmId: 'f' }]) {
    const result = await archiveLlmDecisionsForDeletedClient(args);
    assert.equal(result.redacted, 0);
    assert.equal(result.detached, 0);
  }
});
