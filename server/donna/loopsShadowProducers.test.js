// Donna Loops — shadow producer + backfill unit tests. Load-bearing properties:
//   - LOOPS_SHADOW off → every hook is a zero-query no-op
//   - hooks are no-throw: a failed shadow write rolls back and is swallowed
//   - client reply records the at-least-once inbox event (inbox-only)
//   - backfill dryRun scans but writes nothing; idempotent by construction

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isLoopsShadowEnabled, onEvidenceRequestCreated, onAskBatchSent,
  onDocumentParseFailed, onDocumentParseCompleted, onClientReplyReceived,
  onReconciliationMatchConfirmed, onReconciliationMatchRejected,
  onReconciliationRunCompleted, onDocumentCorrected, backfillLoopsShadow,
  invalidateReconciliationForCorrectedDocument,
  PROPOSED_MATCH_GAP_REASON, __documentCoveredBySettledLine,
  onReconcileCompleteRequestAskDraft, askEscalationQuiescenceGateAllows,
  ASK_QUIESCENCE_GATE_FLAG_KEY,
  clientHasInFlightDocumentsForAskQuiescence
} from './loopsShadowProducers.js';
import { DOCUMENT_CORRECTION_SUPERSEDED_BY } from './reconciliationProviderFailure.js';
import { buildCaseId } from './caseManager.js';
import { cascadeOrder, hasCycle } from './caseDependency.js';
import { ASK_DRAFT_IDENTITY_CONTRACT } from './askPipeline.js';

const makeMockClient = (responders = [], { tablesPresent = true, goalTablesPresent = true } = {}) => {
  const calls = [];
  const queue = [...responders];
  let eventSeq = 0;
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const text = String(sql).toLowerCase();
      if (text === 'begin' || text === 'commit' || text === 'rollback') return { rows: [], rowCount: 0 };
      // Seeded responders (one-shot, substring match) always take precedence.
      const idx = queue.findIndex((r) => text.includes(r.match));
      if (idx !== -1) {
        const [r] = queue.splice(idx, 1);
        if (r.throw) throw r.throw;
        return { rows: r.rows || [], rowCount: (r.rows || []).length };
      }
      if (text.includes('to_regclass')) {
        // loop_goal_reports presence is its own switch (Step 3 goal layer, 037).
        const present = text.includes('loop_goal_reports')
          ? (goalTablesPresent ? 'loop_goal_reports' : null)
          : (tablesPresent ? 'bookkeeping_cases' : null);
        return { rows: [{ present }] };
      }
      // Every append-only case event returns a fresh id, so the §13.2 GoalReport
      // event pointer is non-null and the report write proceeds (realistic default).
      if (text.includes('insert into bookkeeping_case_events')) return { rows: [{ id: `case-event-${++eventSeq}` }] };
      if (text.includes('insert into loop_goal_specs')) return { rows: [{ inserted: true }] };
      if (text.includes('insert into loop_goal_reports')) return { rows: [{ inserted: true }] };
      return { rows: [], rowCount: 0 };
    }
  };
};

test('__documentCoveredBySettledLine: true when a SETTLED line matches the doc amount; false otherwise', async () => {
  // Shell Oil receipt $32.49, a settled bank line already covers $32.49 → covered.
  const covered = makeMockClient([
    { match: 'from documents', rows: [{ total_amount: 32.49, currency: 'USD' }] },
    { match: 'from transactions', rows: [{ ok: 1 }] }
  ]);
  assert.equal(
    await __documentCoveredBySettledLine({ client: covered, firmId: 'f', clientId: 'c', documentId: 'doc-shell' }),
    true
  );

  // Same doc, but no settled line matches the amount → a genuine firm gap (not covered).
  const uncovered = makeMockClient([
    { match: 'from documents', rows: [{ total_amount: 32.49, currency: 'USD' }] },
    { match: 'from transactions', rows: [] }
  ]);
  assert.equal(
    await __documentCoveredBySettledLine({ client: uncovered, firmId: 'f', clientId: 'c', documentId: 'doc-shell' }),
    false
  );

  // A doc with no amount can never be auto-covered (and never queries transactions).
  const noAmount = makeMockClient([
    { match: 'from documents', rows: [{ total_amount: null, currency: null }] }
  ]);
  assert.equal(
    await __documentCoveredBySettledLine({ client: noAmount, firmId: 'f', clientId: 'c', documentId: 'doc-x' }),
    false
  );
  assert.ok(!noAmount.calls.some((q) => q.sql.toLowerCase().includes('from transactions')),
    'no amount → never probes the ledger');
});

// Producers gate on the TIER master (isLoopSystemEnabled: LOOPS_TIER, with
// legacy LOOPS_SHADOW as globalLoopTier's fallback), so the helper manages
// BOTH vars: `tier` defaults to unset, keeping the legacy-var tests hermetic
// against an ambient LOOPS_TIER.
const withShadow = async (value, fn, { tier = undefined } = {}) => {
  const prev = process.env.LOOPS_SHADOW;
  const prevTier = process.env.LOOPS_TIER;
  process.env.LOOPS_SHADOW = value;
  if (tier === undefined) delete process.env.LOOPS_TIER;
  else process.env.LOOPS_TIER = tier;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.LOOPS_SHADOW;
    else process.env.LOOPS_SHADOW = prev;
    if (prevTier === undefined) delete process.env.LOOPS_TIER;
    else process.env.LOOPS_TIER = prevTier;
  }
};

test('isLoopsShadowEnabled reflects the env flag', async () => {
  await withShadow('true', () => assert.equal(isLoopsShadowEnabled(), true));
  await withShadow('on', () => assert.equal(isLoopsShadowEnabled(), true));
  await withShadow('off', () => assert.equal(isLoopsShadowEnabled(), false));
  await withShadow('', () => assert.equal(isLoopsShadowEnabled(), false));
});

test('LOOPS_SHADOW off → every producer is a no-op (zero queries)', async () => {
  await withShadow('false', async () => {
    const c = makeMockClient();
    await onAskBatchSent({ client: c, firmId: 'f', clientId: 'cl', batchId: 'ab-1', evidenceRequestIds: ['er-1'] });
    await onEvidenceRequestCreated({ client: c, firmId: 'f', clientId: 'cl', evidenceRequest: { id: 'er-1' } });
    await onDocumentParseFailed({ client: c, firmId: 'f', clientId: 'cl', documentId: 'doc-1' });
    await onDocumentParseCompleted({ client: c, firmId: 'f', clientId: 'cl', documentId: 'doc-1' });
    await onClientReplyReceived({ client: c, firmId: 'f', clientId: 'cl', evidenceRequestId: 'er-1', replyEventId: 'r-1' });
    await onReconciliationMatchConfirmed({ client: c, firmId: 'f', clientId: 'cl', matchedObjectType: 'document', matchedObjectId: 'doc-1', bankTransactionId: 't-1', status: 'confirmed' });
    await onReconciliationMatchRejected({ client: c, firmId: 'f', clientId: 'cl', matchId: 'm-1', matchedObjectType: 'document', matchedObjectId: 'doc-1', bankTransactionId: 't-1', status: 'rejected', wasSettled: true });
    await onReconciliationRunCompleted({ client: c, firmId: 'f', clientId: 'cl', targets: [{ targetType: 'document', targetId: 'doc-1' }] });
    assert.equal(c.calls.length, 0);
  });
});

test('every producer query references exactly its supplied parameters — the 2026-08-25 $3 regression', async () => {
  // An unreferenced parameter is a HARD pg error ("could not determine data
  // type of parameter $3") that the fake client cannot see — this walks every
  // recorded query for both target types and pins placeholder/param parity.
  await withShadow('on', async () => {
    const c = makeMockClient();
    await onReconciliationRunCompleted({ client: c, firmId: 'f', clientId: 'cl', targets: [
      { targetType: 'transaction', targetId: 't-1' },
      { targetType: 'document', targetId: 'doc-1' }
    ] });
    const matchStateCalls = c.calls.filter(({ sql }) => sql.includes('has_sticky_match'));
    assert.ok(matchStateCalls.length >= 2, 'both target types must read live match state');
    assert.ok(
      matchStateCalls.some(({ sql, params }) => sql.includes('bank_transaction_id = $3') && params.length === 3),
      'the transaction anchor uses $3 with exactly three params'
    );
    for (const { sql, params } of c.calls) {
      if (!Array.isArray(params) || params.length === 0) continue;
      const referenced = new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
      for (let n = 1; n <= params.length; n += 1) {
        assert.ok(referenced.has(n), `query must reference $${n}: ${sql.slice(0, 140)}`);
      }
      for (const n of referenced) {
        assert.ok(n <= params.length, `query references $${n} beyond its ${params.length} params: ${sql.slice(0, 140)}`);
      }
    }
  });
});

test('LOOPS_TIER=canary alone (the desktop posture) opens the producer gate — the 2026-08-24 regression', async () => {
  // The appliance ships LOOPS_TIER=canary and never sets LOOPS_SHADOW
  // (hostRuntimeDefaults.js). Under the old raw-env gate every producer
  // no-oped there — verdicts landed but no gap/ask ever followed. The gate
  // passing is observable as the runShadow tables-probe query landing.
  await withShadow('', async () => {
    const c = makeMockClient();
    await onEvidenceRequestCreated({ client: c, firmId: 'f', clientId: 'cl', evidenceRequest: { id: 'er-1' } });
    assert.ok(c.calls.length > 0, 'tier canary with no legacy var must open the producer gate');
  }, { tier: 'canary' });
});

test('onReconciliationMatchRejected: only a settled→rejected transition acts (no-op otherwise)', async () => {
  await withShadow('on', async () => {
    const c = makeMockClient();
    // a non-settled match being rejected never met a goal → nothing to regress
    await onReconciliationMatchRejected({ client: c, firmId: 'f', clientId: 'cl', matchId: 'm-1', matchedObjectType: 'document', matchedObjectId: 'doc-1', bankTransactionId: 't-1', status: 'rejected', wasSettled: false });
    // a settling/suggested patch is not a rejection
    await onReconciliationMatchRejected({ client: c, firmId: 'f', clientId: 'cl', matchId: 'm-1', matchedObjectType: 'document', matchedObjectId: 'doc-1', bankTransactionId: 't-1', status: 'confirmed', wasSettled: true });
    assert.equal(c.calls.length, 0);
  });
});

test('onReconciliationMatchRejected (shadow on): enqueues goal.regressed for each EXISTING anchored case', async () => {
  await withShadow('on', async () => {
    const docCaseId = 'case-f-cl-reconciliation-document-doc-9';
    const c = makeMockClient([
      // both anchors are probed; only the document-anchored case exists here
      { match: 'from bookkeeping_cases where firm_id', rows: [{ id: docCaseId }] },
      { match: 'insert into loop_event_outbox', rows: [{ id: 'ob-regress-1' }] }
    ]);
    const out = await onReconciliationMatchRejected({
      client: c, firmId: 'f', clientId: 'cl', matchId: 'm-9',
      matchedObjectType: 'document', matchedObjectId: 'doc-9', bankTransactionId: 't-9',
      status: 'rejected', wasSettled: true
    });
    assert.equal(out.enqueued, 1);
    // one goal.regressed row, anchored on the existing case, with the §13.10 event
    const outbox = c.calls.find((q) => /insert into loop_event_outbox/.test(q.sql));
    assert.ok(outbox.params.includes('goal.regressed'), 'event_type goal.regressed');
    assert.ok(outbox.params.includes(docCaseId), 'anchored on the resolved case');
    const payload = outbox.params[6]; // the payload JSON string enqueueOutbox persists
    assert.match(payload, /"kind":"match_rejected"/);
    assert.match(payload, /"id":"match_rejected:m-9"/); // deterministic → idempotent reopen
    // existence is checked across BOTH the doc + bank-line anchors
    const lookup = c.calls.find((q) => /from bookkeeping_cases where firm_id/.test(q.sql));
    assert.equal(lookup.params[1].length, 2, 'both candidate anchors probed');
    // workflow-only: never an accounting write
    assert.ok(!c.calls.some((q) => /update documents|update transactions|reconciliation_matches/.test(q.sql)));
  });
});

test('onReconciliationMatchRejected: a rejection with no reconciliation case enqueues nothing', async () => {
  await withShadow('on', async () => {
    const c = makeMockClient([{ match: 'from bookkeeping_cases where firm_id', rows: [] }]);
    const out = await onReconciliationMatchRejected({
      client: c, firmId: 'f', clientId: 'cl', matchId: 'm-2',
      matchedObjectType: 'document', matchedObjectId: 'doc-2', bankTransactionId: 't-2',
      status: 'rejected', wasSettled: true
    });
    assert.equal(out.enqueued, 0);
    assert.ok(!c.calls.some((q) => /insert into loop_event_outbox/.test(q.sql)));
  });
});

test('onReconciliationMatchConfirmed: a non-settling status (rejected/suggested) is a no-op with no query', async () => {
  await withShadow('on', async () => {
    const c = makeMockClient();
    await onReconciliationMatchConfirmed({ client: c, firmId: 'f', clientId: 'cl', matchedObjectType: 'document', matchedObjectId: 'doc-1', bankTransactionId: 't-1', status: 'rejected' });
    await onReconciliationMatchConfirmed({ client: c, firmId: 'f', clientId: 'cl', matchedObjectType: 'document', matchedObjectId: 'doc-1', bankTransactionId: 't-1', status: 'suggested' });
    assert.equal(c.calls.length, 0); // only confirmed / auto_matched act
  });
});

test('onDocumentCorrected (shadow on): a material correction enqueues goal.regressed for the document and the bank lines it settled', async () => {
  await withShadow('on', async () => {
    const docCaseId = 'case-f-cl-reconciliation-document-doc-7';
    const c = makeMockClient([
      { match: 'from bookkeeping_cases where firm_id', rows: [{ id: docCaseId }] },
      { match: 'insert into loop_event_outbox', rows: [{ id: 'ob-doc-regress-1' }] }
    ]);
    const out = await onDocumentCorrected({
      client: c, firmId: 'f', clientId: 'cl', documentId: 'doc-7',
      fieldPath: 'total_amount', correctionId: 'corr-1',
      invalidatedMatchIds: ['m-1'], bankTransactionIds: ['t-1']
    });
    assert.equal(out.enqueued, 1);
    const outbox = c.calls.find((q) => /insert into loop_event_outbox/.test(q.sql));
    assert.ok(outbox.params.includes('goal.regressed'), 'event_type goal.regressed');
    assert.ok(outbox.params.includes(docCaseId), 'anchored on the document reconciliation case');
    const payload = outbox.params[6];
    assert.match(payload, /"kind":"document_corrected"/);
    assert.match(payload, /"id":"document_corrected:corr-1"/);       // deterministic event id
    assert.match(payload, /goal_regressed:document_corrected:corr-1/); // deterministic idempotency key
    assert.match(payload, /"fresh_evaluation_required":true/);
    assert.match(payload, /"invalidated_match_ids":\["m-1"\]/);       // the writer's in-transaction receipt rides along
    // the dual anchor: the document + the bank line the invalidated match settled
    const lookup = c.calls.find((q) => /from bookkeeping_cases where firm_id/.test(q.sql));
    assert.equal(lookup.params[1].length, 2, 'document + bank-line anchors');
    // FI-02: the invalidation is the correction WRITER's (in its transaction,
    // ungated) — the loop producer writes workflow rows only.
    assert.ok(!c.calls.some((q) => /update reconciliation_matches|update reconciliation_evaluations/.test(q.sql)));
    assert.ok(!c.calls.some((q) => /update documents|update transactions/.test(q.sql)));
  });
});

test('invalidateReconciliationForCorrectedDocument: marks settled matches, supersedes live verdicts, receipts each match — ungated', async () => {
  await withShadow('off', async () => {
    const c = makeMockClient([
      { match: 'update reconciliation_matches', rows: [{ id: 'm-1', bank_transaction_id: 't-1', status: 'auto_matched' }] },
      { match: 'update reconciliation_evaluations', rows: [{ id: 'e-1' }] }
    ]);
    const out = await invalidateReconciliationForCorrectedDocument({
      client: c, firmId: 'f', clientId: 'cl', documentId: 'doc-7', correctionId: 'corr-1', fieldPath: 'total_amount'
    });
    assert.deepEqual(out, { invalidated: ['m-1'], bank_transaction_ids: ['t-1'], superseded_evaluations: ['e-1'] });
    const invalidation = c.calls.find((q) => /update reconciliation_matches/.test(q.sql));
    assert.match(invalidation.sql, /status in \('confirmed', 'auto_matched'\)/);
    assert.ok(!/set status/.test(invalidation.sql), 'the marker never moves the match status — the named writer does');
    assert.ok(JSON.stringify(invalidation.params).includes('invalidated_by_correction'));
    const supersede = c.calls.find((q) => /update reconciliation_evaluations/.test(q.sql));
    assert.match(supersede.sql, /verdict = 'superseded'/);
    assert.match(supersede.sql, /matcher_mode' is distinct from 'shadow'/);
    assert.ok(supersede.params.includes(DOCUMENT_CORRECTION_SUPERSEDED_BY));
    assert.ok(c.calls.some((q) => /reconciliation_match\.invalidated_by_correction/.test(q.sql)), 'receipted per match');
    // a non-material field touches nothing
    const quiet = makeMockClient();
    assert.deepEqual(await invalidateReconciliationForCorrectedDocument({
      client: quiet, firmId: 'f', clientId: 'cl', documentId: 'doc-7', correctionId: 'corr-2', fieldPath: 'reference_number'
    }), { invalidated: [], bank_transaction_ids: [], superseded_evaluations: [] });
    assert.equal(quiet.calls.length, 0);
  });
});

test('onDocumentCorrected: a NON-material field (reference_number) is a no-op with no query', async () => {
  await withShadow('on', async () => {
    const c = makeMockClient();
    const out = await onDocumentCorrected({
      client: c, firmId: 'f', clientId: 'cl', documentId: 'doc-7',
      fieldPath: 'reference_number', correctionId: 'corr-2'
    });
    assert.equal(out, null);          // gated out before any DB work
    assert.equal(c.calls.length, 0);  // a free-text reference cleanup never reopens a match
  });
});

test('onDocumentCorrected: a material correction with no reconciliation case enqueues nothing', async () => {
  await withShadow('on', async () => {
    const c = makeMockClient([{ match: 'from bookkeeping_cases where firm_id', rows: [] }]);
    const out = await onDocumentCorrected({
      client: c, firmId: 'f', clientId: 'cl', documentId: 'doc-8',
      fieldPath: 'counterparty_role', correctionId: 'corr-3'
    });
    assert.equal(out.enqueued, 0);
    assert.ok(!c.calls.some((q) => /insert into loop_event_outbox/.test(q.sql)));
  });
});

test('onDocumentCorrected: LOOPS_SHADOW off → a zero-query no-op even on a material field', async () => {
  await withShadow('off', async () => {
    const c = makeMockClient();
    const out = await onDocumentCorrected({
      client: c, firmId: 'f', clientId: 'cl', documentId: 'doc-7',
      fieldPath: 'total_amount', correctionId: 'corr-1'
    });
    assert.equal(out, null);
    assert.equal(c.calls.length, 0);
  });
});

test('onReconciliationMatchConfirmed (shadow on): resolves the open unclear_match gap blocker → close half', async () => {
  await withShadow('on', async () => {
    const c = makeMockClient([
      // the open reconciliation-gap blocker on the (doc or tx) anchored case
      { match: 'select id from bookkeeping_case_blockers', rows: [{ id: 'case-blocker-9' }] },
      // resolveBlocker returns the row it cleared
      { match: "set status = 'resolved'", rows: [{ case_id: 'case-reconciliation-1', firm_id: 'f', client_id: 'cl', blocker_type: 'unclear_match', owner_type: 'firm' }] },
      // rebuildCaseStatus: no terminal verdict, no remaining open blockers → 'open'
      { match: 'select event_type from bookkeeping_case_events', rows: [] },
      { match: 'select blocker_type, owner_type from bookkeeping_case_blockers', rows: [] },
      // markCaseResolved appends the explicit terminal verdict, which now wins.
      { match: 'select event_type from bookkeeping_case_events', rows: [{ event_type: 'case.resolved' }] }
    ]);
    const out = await onReconciliationMatchConfirmed({
      client: c, firmId: 'f', clientId: 'cl',
      matchedObjectType: 'document', matchedObjectId: 'doc-9', bankTransactionId: 't-9', status: 'confirmed'
    });
    assert.equal(out.resolved, 1);
    // the gap blocker is looked up across BOTH anchors (doc case + tx case)
    const lookup = c.calls.find((q) => /select id from bookkeeping_case_blockers/.test(q.sql));
    assert.ok(lookup);
    assert.match(lookup.sql, /blocker_type = 'unclear_match'/);
    // closing the loop is workflow-only — never an accounting write
    assert.ok(!c.calls.some((q) => /update documents|update transactions|reconciliation_matches/.test(q.sql)));
  });
});

test('onDocumentParseCompleted (shadow on): resolves the upload case parse blocker → auto-resume', async () => {
  await withShadow('on', async () => {
    const c = makeMockClient([
      // the open parse blocker for this document's (deterministic) upload case
      { match: 'select id from bookkeeping_case_blockers', rows: [{ id: 'case-blocker-7' }] },
      // resolveBlocker returns the row it cleared
      { match: "set status = 'resolved'", rows: [{ case_id: 'case-upload-1', firm_id: 'f', client_id: 'cl', blocker_type: 'parse_failed', owner_type: 'system' }] },
      // rebuildCaseStatus: no terminal verdict, no remaining open blockers → 'open'
      { match: 'select event_type from bookkeeping_case_events', rows: [] },
      { match: 'select blocker_type, owner_type from bookkeeping_case_blockers', rows: [] },
      // The parse success is a verified terminal fact, not an ownerless open case.
      { match: 'select event_type from bookkeeping_case_events', rows: [{ event_type: 'case.resolved' }] }
    ]);
    const out = await onDocumentParseCompleted({
      client: c, firmId: 'f', clientId: 'cl', documentId: 'doc-1',
      parseRunId: 'run-1', summary: { transaction_count: 12 }
    });
    assert.equal(out.resolved, 1);
    assert.equal(out.status, 'resolved');
    assert.ok(c.calls.some((q) => q.sql === 'begin') && c.calls.some((q) => q.sql === 'commit'));
    // a document.parse_completed event is appended (the audit trail of the resume)
    assert.ok(c.calls.some((q) => /insert into bookkeeping_case_events/.test(q.sql) && JSON.stringify(q.params).includes('document.parse_completed')));
    // the blocker is resolved — never re-opened, never an accounting write
    assert.ok(c.calls.some((q) => /set status = 'resolved'/.test(q.sql)));
    assert.ok(!c.calls.some((q) => /insert into bookkeeping_case_blockers|update documents|update transactions/.test(q.sql)));
  });
});

test('onDocumentParseCompleted (shadow on): a healthy first-parse has no upload case → no-op', async () => {
  await withShadow('on', async () => {
    const c = makeMockClient([{ match: 'select id from bookkeeping_case_blockers', rows: [] }]);
    const out = await onDocumentParseCompleted({ client: c, firmId: 'f', clientId: 'cl', documentId: 'doc-1' });
    assert.equal(out, null);
    // looked for an open blocker, found none — resolved nothing, opened nothing
    assert.ok(c.calls.some((q) => /select id from bookkeeping_case_blockers/.test(q.sql)));
    assert.ok(!c.calls.some((q) => /set status = 'resolved'|insert into bookkeeping_case_events/.test(q.sql)));
  });
});

test('onAskBatchSent (shadow on): opens a coding case + client blocker in a mini-transaction', async () => {
  await withShadow('on', async () => {
    const c = makeMockClient([
      { match: 'insert into bookkeeping_cases', rows: [{ id: 'case-coding-1', status: 'open' }] },
      { match: 'select blocker_type, owner_type from bookkeeping_case_blockers', rows: [{ blocker_type: 'missing_client_answer', owner_type: 'client' }] }
    ]);
    const out = await onAskBatchSent({ client: c, firmId: 'f', clientId: 'cl', batchId: 'ab-1', evidenceRequestIds: [] });
    assert.ok(out);
    assert.ok(c.calls.some((q) => q.sql === 'begin'));
    assert.ok(c.calls.some((q) => q.sql === 'commit'));
    assert.ok(c.calls.some((q) => /insert into bookkeeping_cases/.test(q.sql)));
    assert.ok(c.calls.some((q) => /insert into bookkeeping_case_blockers/.test(q.sql)));
  });
});

test('onAskBatchSent (§6.2): records an "evidence blocks coding" edge per question', async () => {
  await withShadow('on', async () => {
    const c = makeMockClient([
      { match: 'insert into bookkeeping_cases', rows: [{ id: 'case-coding-ab1', status: 'open' }] },     // the coding case
      { match: 'insert into bookkeeping_cases', rows: [{ id: 'case-evidence-er1', status: 'open' }] },   // evidence case er-1
      { match: 'insert into bookkeeping_cases', rows: [{ id: 'case-evidence-er2', status: 'open' }] },   // evidence case er-2
      { match: 'insert into bookkeeping_case_dependencies', rows: [{ id: 'dep-1', inserted: true }] },
      { match: 'insert into bookkeeping_case_dependencies', rows: [{ id: 'dep-2', inserted: true }] }
    ]);
    const out = await onAskBatchSent({ client: c, firmId: 'f', clientId: 'cl', batchId: 'ab-1', evidenceRequestIds: ['er-1', 'er-2'] });
    assert.ok(out);
    const edges = c.calls.filter((q) => /insert into bookkeeping_case_dependencies/.test(q.sql));
    assert.equal(edges.length, 2, 'one edge per blocking question');
    // canonical direction: parent = evidence (blocker), child = coding (blocked), verb = blocks
    for (const e of edges) {
      assert.equal(e.params[4], 'case-coding-ab1', 'child is the coding case');
      assert.equal(e.params[5], 'blocks', 'verb is blocks');
    }
    const parents = edges.map((e) => e.params[3]).sort();
    assert.deepEqual(parents, ['case-evidence-er1', 'case-evidence-er2'], 'parents are the evidence cases');
  });
});

test('onAskBatchSent (§6.2 cross-type, ask-batch side): links the coding case to an EXISTING reconciliation case on a covered bank line', async () => {
  await withShadow('on', async () => {
    // evidenceRequestIds: [] isolates the cross-type edge from the evidence→coding edges.
    const c = makeMockClient([
      { match: 'insert into bookkeeping_cases', rows: [{ id: 'case-coding-ab1', status: 'open' }] }, // the coding case
      { match: 'select distinct transaction_id from client_evidence_requests', rows: [{ transaction_id: 't1' }] },
      { match: 'select 1 from bookkeeping_cases', rows: [{ exists: 1 }] }, // recon case on t1 already exists
      { match: 'insert into bookkeeping_case_dependencies', rows: [{ id: 'dep-cr-1', inserted: true }] }
    ]);
    const out = await onAskBatchSent({ client: c, firmId: 'f', clientId: 'cl', batchId: 'ab-1', evidenceRequestIds: [] });
    assert.ok(out);
    const edges = c.calls.filter((q) => /insert into bookkeeping_case_dependencies/.test(q.sql));
    assert.equal(edges.length, 1, 'one coding→reconciliation edge');
    const e = edges[0];
    // canonical direction: parent = coding (blocker), child = reconciliation (blocked), verb = blocks
    assert.equal(e.params[3], 'case-coding-ab1', 'parent is the coding case');
    assert.equal(
      e.params[4],
      buildCaseId({ firmId: 'f', clientId: 'cl', caseType: 'reconciliation', primaryObjectType: 'transaction', primaryObjectId: 't1' }),
      'child is the deterministic reconciliation case on the bank line'
    );
    assert.equal(e.params[5], 'blocks', 'verb is blocks');
  });
});

test('onAskBatchSent (§6.2 Trap 1): no cross-type edge when the reconciliation case does not exist yet', async () => {
  await withShadow('on', async () => {
    const c = makeMockClient([
      { match: 'insert into bookkeeping_cases', rows: [{ id: 'case-coding-ab1', status: 'open' }] },
      { match: 'select distinct transaction_id from client_evidence_requests', rows: [{ transaction_id: 't1' }] },
      { match: 'select 1 from bookkeeping_cases', rows: [] } // recon case absent → the recon-open side will link later
    ]);
    await onAskBatchSent({ client: c, firmId: 'f', clientId: 'cl', batchId: 'ab-1', evidenceRequestIds: [] });
    const edges = c.calls.filter((q) => /insert into bookkeeping_case_dependencies/.test(q.sql));
    assert.equal(edges.length, 0, 'no edge — deferred to the recon-open side (Trap 1)');
  });
});

test('onDocumentParseFailed (shadow on): opens an upload case', async () => {
  await withShadow('1', async () => {
    const c = makeMockClient([
      { match: 'insert into bookkeeping_cases', rows: [{ id: 'case-upload-1', status: 'open' }] },
      { match: 'select blocker_type, owner_type from bookkeeping_case_blockers', rows: [{ blocker_type: 'parse_failed', owner_type: 'system' }] }
    ]);
    const out = await onDocumentParseFailed({ client: c, firmId: 'f', clientId: 'cl', documentId: 'doc-1', parseError: { code: 'INTERNAL' } });
    assert.ok(out);
    assert.ok(c.calls.some((q) => /insert into bookkeeping_case_blockers/.test(q.sql)));
  });
});

test('producers are no-throw: a failed shadow write rolls back and is swallowed', async () => {
  await withShadow('on', async () => {
    const c = makeMockClient([{ match: 'insert into bookkeeping_cases', throw: new Error('boom') }]);
    const out = await onAskBatchSent({ client: c, firmId: 'f', clientId: 'cl', batchId: 'ab-1' });
    assert.equal(out, null);
    assert.ok(c.calls.some((q) => q.sql === 'rollback'));
  });
});

test('onClientReplyReceived (shadow on): records the at-least-once inbox event, inbox-only', async () => {
  await withShadow('on', async () => {
    const c = makeMockClient([
      { match: 'insert into loop_event_inbox', rows: [{ id: 'loop-inbox-1' }] },
      { match: 'insert into bookkeeping_cases', rows: [{ id: 'case-evidence-1', status: 'open' }] }
    ]);
    const out = await onClientReplyReceived({ client: c, firmId: 'f', clientId: 'cl', evidenceRequestId: 'er-1', replyEventId: 'er-1:ts' });
    assert.ok(out?.id);
    assert.ok(c.calls.some((q) => /insert into loop_event_inbox/.test(q.sql)));
    // inbox-only: no accounting writes, no evidence resolution
    assert.ok(!c.calls.some((q) => /update client_evidence_requests|update transactions/.test(q.sql)));
  });
});

test('backfillLoopsShadow: dryRun scans but writes nothing', async () => {
  const c = makeMockClient([
    { match: 'from client_evidence_requests', rows: [{ id: 'er-1', transaction_id: 't1', question: 'q' }] },
    { match: 'from client_ask_batches', rows: [{ id: 'ab-1' }] },
    { match: 'from documents', rows: [{ id: 'doc-1', parse_error: {}, parse_run_id: 'r1' }] }
  ]);
  const summary = await backfillLoopsShadow({ client: c, firmId: 'f', clientId: 'cl', dryRun: true, allowWhenDisabled: true });
  assert.equal(summary.scanned, 3);
  assert.equal(summary.dry_run, true);
  assert.ok(!c.calls.some((q) => /insert into bookkeeping_cases/.test(q.sql)));
});

test('backfillLoopsShadow: disabled without override → skips with no scan', async () => {
  await withShadow('false', async () => {
    const c = makeMockClient();
    const summary = await backfillLoopsShadow({ client: c, firmId: 'f', clientId: 'cl', dryRun: true });
    assert.equal(summary.skipped, -1);
    assert.equal(summary.scanned, 0);
  });
});

test('backfillLoopsShadow (sweep): dryRun counts stuck pending/processing uploads but writes nothing', async () => {
  const c = makeMockClient([
    // the stuck-upload scan (distinct from the FAILED-parse scan by its where clause)
    { match: "parse_status in ('pending', 'processing')", rows: [
      { id: 'doc-pending', parse_status: 'pending', parse_run_id: 'r1', parse_stage: null, parse_progress_current: null, parse_progress_total: null, last_activity_at: new Date(Date.now() - 540000).toISOString() },
      { id: 'doc-proc', parse_status: 'processing', parse_run_id: 'r2', parse_stage: 'ocr', parse_progress_current: 2, parse_progress_total: 6, last_activity_at: new Date(Date.now() - 410000).toISOString() }
    ] }
  ]);
  const summary = await backfillLoopsShadow({ client: c, firmId: 'f', clientId: 'cl', dryRun: true, allowWhenDisabled: true });
  assert.equal(summary.stuck_scanned, 2);
  assert.equal(summary.scanned, 2); // 0 evidence + 0 batches + 0 failed + 2 stuck
  assert.equal(summary.dry_run, true);
  // dryRun: scanned only, never opens a case/blocker
  assert.ok(!c.calls.some((q) => /insert into bookkeeping_cases|insert into bookkeeping_case_blockers/.test(q.sql)));
});

test('backfillLoopsShadow (sweep): a stale PENDING upload opens a parse_pending (waiting_system) blocker', async () => {
  const c = makeMockClient([
    { match: "parse_status in ('pending', 'processing')", rows: [
      { id: 'doc-pending', parse_status: 'pending', parse_run_id: 'r1', parse_stage: null, parse_progress_current: null, parse_progress_total: null, last_activity_at: new Date(Date.now() - 540000).toISOString() }
    ] },
    { match: 'select 1 from bookkeeping_cases', rows: [] }, // caseExists → not yet present
    { match: 'insert into bookkeeping_cases', rows: [{ id: 'case-upload-p', status: 'open' }] },
    { match: 'select blocker_type, owner_type from bookkeeping_case_blockers', rows: [{ blocker_type: 'parse_pending', owner_type: 'system' }] }
  ]);
  const summary = await backfillLoopsShadow({ client: c, firmId: 'f', clientId: 'cl', dryRun: false, allowWhenDisabled: true });
  assert.equal(summary.stuck_scanned, 1);
  assert.equal(summary.created_cases, 1);
  // a parse_pending blocker is opened (soft system wait, NOT a hard parse_failed)
  const blockerInsert = c.calls.find((q) => /insert into bookkeeping_case_blockers/.test(q.sql));
  assert.ok(blockerInsert);
  assert.ok(JSON.stringify(blockerInsert.params).includes('parse_pending'));
  // mechanical event, never an accounting write
  assert.ok(c.calls.some((q) => /insert into bookkeeping_case_events/.test(q.sql) && JSON.stringify(q.params).includes('document.parse_stuck')));
  assert.ok(!c.calls.some((q) => /update documents|update transactions/.test(q.sql)));
});

test('backfillLoopsShadow (sweep): a stalled PROCESSING upload opens a parse_stale blocker with stage diagnostics', async () => {
  const c = makeMockClient([
    { match: "parse_status in ('pending', 'processing')", rows: [
      { id: 'doc-proc', parse_status: 'processing', parse_run_id: 'r2', parse_stage: 'ocr', parse_progress_current: 2, parse_progress_total: 6, last_activity_at: new Date(Date.now() - 410000).toISOString() }
    ] },
    { match: 'select 1 from bookkeeping_cases', rows: [{ '?column?': 1 }] }, // caseExists → already present (idempotent re-sweep)
    { match: 'insert into bookkeeping_cases', rows: [] }, // on conflict do nothing → re-fetch
    { match: 'select * from bookkeeping_cases', rows: [{ id: 'case-upload-q', status: 'waiting_system' }] },
    { match: 'select blocker_type, owner_type from bookkeeping_case_blockers', rows: [{ blocker_type: 'parse_stale', owner_type: 'system' }] }
  ]);
  const summary = await backfillLoopsShadow({ client: c, firmId: 'f', clientId: 'cl', dryRun: false, allowWhenDisabled: true });
  assert.equal(summary.stuck_scanned, 1);
  assert.equal(summary.existing_cases, 1); // case already existed → idempotent
  const blockerInsert = c.calls.find((q) => /insert into bookkeeping_case_blockers/.test(q.sql));
  assert.ok(blockerInsert);
  assert.ok(JSON.stringify(blockerInsert.params).includes('parse_stale'));
  // rail #3: the blocker reason carries the OBSERVED stage so the dashboard explains the stall
  assert.ok(JSON.stringify(blockerInsert.params).includes("stage 'ocr'"));
});

test('backfillLoopsShadow (Phase 7 scan A): a persisted no_match verdict with no live match opens a reconciliation gap case (waiting_firm)', async () => {
  const c = makeMockClient([
    { match: "verdict in ('no_match'", rows: [
      { target_type: 'document', target_id: 'doc-inv-9', verdict: 'no_match', unmatchable_reason: 'no plausible bank line', model: 'claude-opus-4-7' }
    ] },
    { match: 'select 1 from bookkeeping_cases', rows: [] }, // caseExists → not yet present
    { match: 'insert into bookkeeping_cases', rows: [{ id: 'case-reconciliation-9', status: 'open' }] },
    { match: 'select blocker_type, owner_type from bookkeeping_case_blockers', rows: [{ blocker_type: 'unclear_match', owner_type: 'firm' }] }
  ]);
  const summary = await backfillLoopsShadow({ client: c, firmId: 'f', clientId: 'cl', dryRun: false, allowWhenDisabled: true });
  assert.equal(summary.recon_scanned, 1);
  assert.equal(summary.created_cases, 1);
  // an unclear_match blocker is opened, owned by the firm (a human reconciliation call)
  const blockerInsert = c.calls.find((q) => /insert into bookkeeping_case_blockers/.test(q.sql));
  assert.ok(blockerInsert);
  assert.ok(JSON.stringify(blockerInsert.params).includes('unclear_match'));
  assert.ok(JSON.stringify(blockerInsert.params).includes('firm'));
  // rail #1: the PERSISTED verdict + its model + reason ride the case event, not a re-run
  const gapEvent = c.calls.find((q) => /insert into bookkeeping_case_events/.test(q.sql) && JSON.stringify(q.params).includes('reconciliation.gap_detected'));
  assert.ok(gapEvent);
  assert.ok(JSON.stringify(gapEvent.params).includes('no_match'));
  assert.ok(JSON.stringify(gapEvent.params).includes('claude-opus-4-7'));
  // never an accounting/match WRITE — Loops is workflow-only (the scan only READS
  // reconciliation_matches/_evaluations to render the persisted verdict)
  assert.ok(!c.calls.some((q) => /update documents|update transactions|insert into reconciliation_matches|update reconciliation_matches/.test(q.sql)));
});

test('backfillLoopsShadow (Phase 7 scan B): an unpaid obligation with no evaluation opens an unevaluated_obligation gap case', async () => {
  const c = makeMockClient([
    { match: "payment_status = 'unpaid'", rows: [{ document_id: 'doc-bill-3' }] },
    { match: 'select 1 from bookkeeping_cases', rows: [] }, // caseExists → not yet present
    { match: 'insert into bookkeeping_cases', rows: [{ id: 'case-reconciliation-3', status: 'open' }] },
    { match: 'select blocker_type, owner_type from bookkeeping_case_blockers', rows: [{ blocker_type: 'unclear_match', owner_type: 'firm' }] }
  ]);
  const summary = await backfillLoopsShadow({ client: c, firmId: 'f', clientId: 'cl', dryRun: false, allowWhenDisabled: true });
  assert.equal(summary.recon_scanned, 1);
  assert.equal(summary.created_cases, 1);
  const gapEvent = c.calls.find((q) => /insert into bookkeeping_case_events/.test(q.sql) && JSON.stringify(q.params).includes('reconciliation.gap_detected'));
  assert.ok(gapEvent);
  assert.ok(JSON.stringify(gapEvent.params).includes('unevaluated_obligation'));
  const blockerInsert = c.calls.find((q) => /insert into bookkeeping_case_blockers/.test(q.sql));
  assert.ok(JSON.stringify(blockerInsert.params).includes('unclear_match'));
});

// ── Phase 7.2b — rendering the bank-line disposition verdict ─────────
// The disposition producer (bankLineDispositionLlm.js) stamps
// transaction-target verdicts: 'auto_explained' (immaterial recurring
// noise — must NOT open a case) and 'no_match' with a disposition reason
// (needs_human_review / receipt_needed — open a gap case, but rendered
// for a BARE bank line, not a missing document). WRITE-SIDE (2026-06-24):
// a disposition no_match is an OWNER question, so the gap is owner-owned
// (owner_type 'client' → waiting_client), never the firm limbo the
// two-terminal FIRST principle forbids.
test('backfillLoopsShadow (Phase 7.2b): a transaction-target needs_human disposition opens an OWNER-owned bank-line-framed gap case', async () => {
  const c = makeMockClient([
    { match: "verdict in ('no_match'", rows: [
      { target_type: 'transaction', target_id: 'tx-77', verdict: 'no_match', unmatchable_reason: 'needs_human_review', model: 'claude-opus-4-7' }
    ] },
    { match: 'select 1 from bookkeeping_cases', rows: [] },
    { match: 'insert into bookkeeping_cases', rows: [{ id: 'case-reconciliation-tx-77', status: 'open' }] },
    { match: 'select blocker_type, owner_type from bookkeeping_case_blockers', rows: [{ blocker_type: 'unclear_match', owner_type: 'client' }] }
  ]);
  const summary = await backfillLoopsShadow({ client: c, firmId: 'f', clientId: 'cl', dryRun: false, allowWhenDisabled: true });
  assert.equal(summary.recon_scanned, 1);
  assert.equal(summary.created_cases, 1);
  // The blocker reason is bank-line-framed, NOT "no matching bank line found" / "A document…".
  const blockerInsert = c.calls.find((q) => /insert into bookkeeping_case_blockers/.test(q.sql));
  const blockerStr = JSON.stringify(blockerInsert.params);
  // OWNER-owned now: unclear_match (close hook still resolves it on a match) + owner 'client'.
  assert.ok(blockerStr.includes('unclear_match') && blockerStr.includes('client'));
  assert.ok(!blockerStr.includes('"firm"'), 'disposition gap is no longer firm limbo');
  assert.ok(blockerStr.includes('clarify') || blockerStr.includes('owner'), 'owner-clarification reason rendered');
  assert.ok(!blockerStr.includes('No matching bank line found'), 'document framing dropped for a transaction target');
  // The case summary frames a bank line, not a document.
  const caseInsert = c.calls.find((q) => /insert into bookkeeping_cases/.test(q.sql));
  const caseStr = JSON.stringify(caseInsert.params);
  assert.ok(caseStr.includes('unexplained bank line') || caseStr.includes('bank line needs review'), 'bank-line summary');
  assert.ok(!caseStr.includes('A document could not be reconciled'), 'no document summary on a transaction target');
  // workflow-only — never an accounting/match WRITE
  assert.ok(!c.calls.some((q) => /update documents|update transactions|insert into reconciliation_matches|update reconciliation_matches/.test(q.sql)));
});

test('backfillLoopsShadow (Phase 7.2b): the gap scan NEVER sweeps an auto_explained verdict into a case', async () => {
  // Suppression is structural: scan A filters to no_match/no_candidates,
  // so an 'auto_explained' disposition verdict is invisible to it — the
  // immaterial-recurring-noise line does not nag a human.
  const c = makeMockClient([]); // no verdict rows seeded
  await backfillLoopsShadow({ client: c, firmId: 'f', clientId: 'cl', dryRun: false, allowWhenDisabled: true });
  const scanA = c.calls.find((q) => /from reconciliation_evaluations/.test(q.sql) && /verdict in/.test(q.sql));
  assert.ok(scanA, 'scan A query issued');
  assert.match(scanA.sql, /verdict in \('no_match', 'no_candidates'\)/);
  assert.ok(!scanA.sql.includes('auto_explained'), 'auto_explained is never selected by the gap scan');
});


// The complement of the scan-A backfill above: after a reconciliation run
// commits, open the gap case for a just-evaluated target immediately instead
// of waiting for the sweep. Same persisted-verdict read (rail #1) + INV-4
// sticky-match exclusion, scoped to one target, filtered to no_match.
test('onReconciliationRunCompleted (shadow on): a persisted no_match verdict with no live match opens the gap case in real time', async () => {
  await withShadow('on', async () => {
    const c = makeMockClient([
      { match: 'from reconciliation_evaluations', rows: [
        { verdict: 'no_match', unmatchable_reason: 'no plausible bank line', model: 'claude-opus-4-7' }
      ] },
      { match: 'insert into bookkeeping_cases', rows: [{ id: 'case-reconciliation-9', status: 'open' }] },
      { match: 'select blocker_type, owner_type from bookkeeping_case_blockers', rows: [{ blocker_type: 'unclear_match', owner_type: 'firm' }] }
    ]);
    const out = await onReconciliationRunCompleted({
      client: c, firmId: 'f', clientId: 'cl',
      targets: [{ targetType: 'document', targetId: 'doc-inv-9' }]
    });
    assert.equal(out.opened, 1);
    // the persisted-verdict read filters to no_match AND excludes a live sticky match (INV-4)
    const verdictRead = c.calls.find((q) => /from reconciliation_evaluations/.test(q.sql));
    assert.ok(verdictRead);
    assert.match(verdictRead.sql, /verdict = 'no_match'/);
    assert.match(verdictRead.sql, /not exists[\s\S]*reconciliation_matches/);
    // rail #1: the PERSISTED verdict + model ride the gap-case event, not a re-run
    const gapEvent = c.calls.find((q) => /insert into bookkeeping_case_events/.test(q.sql) && JSON.stringify(q.params).includes('reconciliation.gap_detected'));
    assert.ok(gapEvent);
    assert.ok(JSON.stringify(gapEvent.params).includes('no_match'));
    assert.ok(JSON.stringify(gapEvent.params).includes('claude-opus-4-7'));
    // an unclear_match blocker, owned by the firm (a human reconciliation call)
    const blockerInsert = c.calls.find((q) => /insert into bookkeeping_case_blockers/.test(q.sql));
    assert.ok(JSON.stringify(blockerInsert.params).includes('unclear_match'));
    assert.ok(JSON.stringify(blockerInsert.params).includes('firm'));
    // workflow-only — never an accounting/match WRITE
    assert.ok(!c.calls.some((q) => /update documents|update transactions|insert into reconciliation_matches|update reconciliation_matches/.test(q.sql)));
  });
});

test('onReconciliationRunCompleted (§6.2 cross-type, recon-open side): a bank-line gap links to an EXISTING coding case covering the line', async () => {
  await withShadow('on', async () => {
    const c = makeMockClient([
      { match: 'from reconciliation_evaluations', rows: [{ verdict: 'no_match', unmatchable_reason: null, model: 'm' }] },
      { match: 'insert into bookkeeping_cases', rows: [{ id: 'case-recon-t1', status: 'open' }] }, // the recon gap case on t1
      { match: "request_payload->>'ask_batch_id'", rows: [{ ask_batch_id: 'ab-1' }] }, // an evidence request on t1 belongs to batch ab-1
      { match: 'select 1 from bookkeeping_cases', rows: [{ exists: 1 }] }, // the coding case for ab-1 already exists
      { match: 'insert into bookkeeping_case_dependencies', rows: [{ id: 'dep-cr-2', inserted: true }] }
    ]);
    await onReconciliationRunCompleted({ client: c, firmId: 'f', clientId: 'cl', targets: [{ targetType: 'transaction', targetId: 't1' }] });
    const edges = c.calls.filter((q) => /insert into bookkeeping_case_dependencies/.test(q.sql));
    assert.equal(edges.length, 1, 'one coding→reconciliation edge');
    const e = edges[0];
    assert.equal(
      e.params[3],
      buildCaseId({ firmId: 'f', clientId: 'cl', caseType: 'coding', primaryObjectType: 'client_ask_batch', primaryObjectId: 'ab-1' }),
      'parent is the deterministic coding case for the batch'
    );
    assert.equal(e.params[4], 'case-recon-t1', 'child is the reconciliation gap case');
    assert.equal(e.params[5], 'blocks', 'verb is blocks');
  });
});

test('openReconciliationGapCase (§6.2): a DOCUMENT-anchored gap attempts no coding linkage (only bank lines can be coding-blocked)', async () => {
  await withShadow('on', async () => {
    const c = makeMockClient([
      { match: 'from reconciliation_evaluations', rows: [{ verdict: 'no_match', unmatchable_reason: null, model: 'm' }] },
      { match: 'insert into bookkeeping_cases', rows: [{ id: 'case-recon-doc1', status: 'open' }] }
    ]);
    await onReconciliationRunCompleted({ client: c, firmId: 'f', clientId: 'cl', targets: [{ targetType: 'document', targetId: 'doc-1' }] });
    assert.ok(!c.calls.some((q) => /ask_batch_id/.test(q.sql)), 'no evidence-request lookup for a document gap');
    assert.ok(!c.calls.some((q) => /insert into bookkeeping_case_dependencies/.test(q.sql)), 'no coding→reconciliation edge');
  });
});

test('§6.2 the evidence→coding→reconciliation chain is a DAG (no cycle over blocks)', () => {
  // The two edges this slice adds, plus the existing evidence→coding edge, compose
  // the design chain. Assert it stays acyclic so the cascade traversal terminates.
  const E = buildCaseId({ firmId: 'f', clientId: 'cl', caseType: 'evidence', primaryObjectType: 'client_evidence_request', primaryObjectId: 'er-1' });
  const C = buildCaseId({ firmId: 'f', clientId: 'cl', caseType: 'coding', primaryObjectType: 'client_ask_batch', primaryObjectId: 'ab-1' });
  const R = buildCaseId({ firmId: 'f', clientId: 'cl', caseType: 'reconciliation', primaryObjectType: 'transaction', primaryObjectId: 't1' });
  const edges = [
    { parent_case_id: E, child_case_id: C, relationship_type: 'blocks' }, // evidence blocks coding
    { parent_case_id: C, child_case_id: R, relationship_type: 'blocks' }  // coding blocks reconciliation
  ];
  assert.equal(hasCycle(edges, { types: ['blocks'] }), false, 'the chain is acyclic');
  // a resolved evidence case cascades down to both the coding and reconciliation cases
  assert.deepEqual(cascadeOrder(edges, E).sort(), [C, R].sort(), 'E resolution reaches C then R');
});

test('onReconciliationRunCompleted (shadow on): a matched / no_candidates / sticky-settled target opens nothing', async () => {
  await withShadow('on', async () => {
    // The SELECT encodes both the no_match filter and the sticky-match (INV-4)
    // exclusion, so a matched, already-settled, or no_candidates target returns
    // no row — and no_candidates is deliberately left to the sweep, not opened
    // in real time (a fresh invoice whose bank statement isn't in yet).
    const c = makeMockClient([{ match: 'from reconciliation_evaluations', rows: [] }]);
    const out = await onReconciliationRunCompleted({
      client: c, firmId: 'f', clientId: 'cl',
      targets: [{ targetType: 'document', targetId: 'doc-fresh-invoice' }]
    });
    assert.equal(out.opened, 0);
    assert.ok(c.calls.some((q) => /from reconciliation_evaluations/.test(q.sql)));
    assert.ok(!c.calls.some((q) => /insert into bookkeeping_cases/.test(q.sql)));
  });
});

// ── Step 3 — collapse onto the registry evaluator + persist a GoalReport ─────
// Each gap producer now asks loopGoalRegistry.evaluateReconciliationGoal for the
// verdict + typed desiredCase and persists a queryable, append-only GoalReport
// (with the mandatory §13.2 'goal_evaluated' event pointer) — the verdict Step 4's
// terminal-state read will render. Still workflow-only: no LLM, no accounting write.

test('backfillLoopsShadow (Step 3): a no_match scan persists an UNMET GoalReport via the evaluator', async () => {
  const c = makeMockClient([
    { match: "verdict in ('no_match'", rows: [
      { target_type: 'document', target_id: 'doc-inv-9', verdict: 'no_match', unmatchable_reason: 'no plausible bank line', model: 'claude-opus-4-8' }
    ] },
    { match: 'select 1 from bookkeeping_cases', rows: [] },
    { match: 'insert into bookkeeping_cases', rows: [{ id: 'case-reconciliation-9', status: 'open' }] },
    { match: 'select blocker_type, owner_type from bookkeeping_case_blockers', rows: [{ blocker_type: 'unclear_match', owner_type: 'firm' }] }
  ]);
  const summary = await backfillLoopsShadow({ client: c, firmId: 'f', clientId: 'cl', dryRun: false, allowWhenDisabled: true });
  assert.equal(summary.created_cases, 1);
  // §13.2 — a 'goal_evaluated' event is appended as the mandatory report pointer.
  const goalEvent = c.calls.find((q) => /insert into bookkeeping_case_events/.test(q.sql) && JSON.stringify(q.params).includes('goal_evaluated'));
  assert.ok(goalEvent, 'goal_evaluated event appended');
  // the resolved spec is content-addressed and the report persisted (status unmet — a real gap).
  assert.ok(c.calls.some((q) => /insert into loop_goal_specs/.test(q.sql)), 'spec persisted');
  const report = c.calls.find((q) => /insert into loop_goal_reports/.test(q.sql));
  assert.ok(report, 'GoalReport persisted');
  assert.ok(report.params.includes('unmet'), 'status is unmet'); // exact element, not substring
  assert.ok(report.params.includes('reconciliation_gap_resolved'), 'the registry goal key');
  // the denormalized pointer cache is refreshed — never read as truth (§13.3).
  assert.ok(c.calls.some((q) => /update bookkeeping_cases set latest_goal_report_id/.test(q.sql)));
  // workflow-only — never an accounting/match write.
  assert.ok(!c.calls.some((q) => /update documents|update transactions|insert into reconciliation_matches/.test(q.sql)));
});

test('backfillLoopsShadow (Step 3): no_candidates opens a TYPED missing_bank_statement blocker (the divergence dies)', async () => {
  const c = makeMockClient([
    { match: "verdict in ('no_match'", rows: [
      { target_type: 'document', target_id: 'doc-inv-5', verdict: 'no_candidates', unmatchable_reason: null, model: 'claude-opus-4-8' }
    ] },
    { match: 'select 1 from bookkeeping_cases', rows: [] },
    { match: 'insert into bookkeeping_cases', rows: [{ id: 'case-reconciliation-5', status: 'open' }] },
    { match: 'select blocker_type, owner_type from bookkeeping_case_blockers', rows: [{ blocker_type: 'missing_bank_statement', owner_type: 'firm' }] }
  ]);
  const summary = await backfillLoopsShadow({ client: c, firmId: 'f', clientId: 'cl', dryRun: false, allowWhenDisabled: true });
  assert.equal(summary.created_cases, 1);
  const blockerInsert = c.calls.find((q) => /insert into bookkeeping_case_blockers/.test(q.sql));
  const s = JSON.stringify(blockerInsert.params);
  assert.ok(s.includes('missing_bank_statement'), 'no_candidates → typed missing_bank_statement, not unclear_match');
  assert.ok(s.includes('Upload the bank statement'), 'reason guides uploading the covering statement');
  const report = c.calls.find((q) => /insert into loop_goal_reports/.test(q.sql));
  assert.ok(report.params.includes('unmet'), 'still an unmet gap until the statement arrives');
});

test('onReconciliationMatchConfirmed (Step 3): a settled match persists a MET GoalReport on the gap case', async () => {
  await withShadow('on', async () => {
    const canonicalDocumentCaseId = buildCaseId({
      firmId: 'f', clientId: 'cl', caseType: 'reconciliation',
      primaryObjectType: 'document', primaryObjectId: 'doc-9'
    });
    const legacyConcreteCaseId = buildCaseId({
      firmId: 'f', clientId: 'cl', caseType: 'reconciliation',
      primaryObjectType: 'supplier_bill', primaryObjectId: 'doc-9'
    });
    const c = makeMockClient([
      { match: 'select id from bookkeeping_case_blockers', rows: [{ id: 'case-blocker-9' }] },
      { match: "set status = 'resolved'", rows: [{ case_id: 'case-reconciliation-1', firm_id: 'f', client_id: 'cl', blocker_type: 'unclear_match', owner_type: 'firm' }] },
      { match: 'select event_type from bookkeeping_case_events', rows: [] },
      { match: 'select blocker_type, owner_type from bookkeeping_case_blockers', rows: [] }
    ]);
    const out = await onReconciliationMatchConfirmed({
      client: c, firmId: 'f', clientId: 'cl',
      matchedObjectType: 'supplier_bill', matchedObjectId: 'doc-9', bankTransactionId: 't-9', status: 'confirmed'
    });
    assert.equal(out.resolved, 1);
    const blockerRead = c.calls.find((q) => /select id from bookkeeping_case_blockers/.test(q.sql));
    assert.ok(blockerRead.params[0].includes(canonicalDocumentCaseId), 'concrete match type closes the canonical document workflow case');
    assert.ok(blockerRead.params[0].includes(legacyConcreteCaseId), 'legacy concrete-type cases remain healable');
    const goalEvent = c.calls.find((q) => /insert into bookkeeping_case_events/.test(q.sql) && JSON.stringify(q.params).includes('goal_evaluated'));
    assert.ok(goalEvent, 'a goal_evaluated event rides the settle');
    const report = c.calls.find((q) => /insert into loop_goal_reports/.test(q.sql));
    assert.ok(report, 'a met GoalReport is persisted on the settled case (INV-4 → goal met)');
    assert.ok(report.params.includes('met') && !report.params.includes('unmet'), 'status is met, not unmet');
    assert.ok(!c.calls.some((q) => /update documents|update transactions|reconciliation_matches/.test(q.sql)));
  });
});

test('onReconciliationRunCompleted (Step 3): the real-time gap open persists an UNMET GoalReport', async () => {
  await withShadow('on', async () => {
    const c = makeMockClient([
      { match: 'from reconciliation_evaluations', rows: [
        { verdict: 'no_match', unmatchable_reason: 'no plausible bank line', model: 'claude-opus-4-8' }
      ] },
      { match: 'insert into bookkeeping_cases', rows: [{ id: 'case-reconciliation-9', status: 'open' }] },
      { match: 'select blocker_type, owner_type from bookkeeping_case_blockers', rows: [{ blocker_type: 'unclear_match', owner_type: 'firm' }] }
    ]);
    const out = await onReconciliationRunCompleted({
      client: c, firmId: 'f', clientId: 'cl',
      targets: [{ targetType: 'document', targetId: 'doc-inv-9' }]
    });
    assert.equal(out.opened, 1);
    const report = c.calls.find((q) => /insert into loop_goal_reports/.test(q.sql));
    assert.ok(report, 'GoalReport persisted in real time');
    assert.ok(report.params.includes('unmet'));
  });
});

test('Step 3: a pre-037 deploy (no goal tables) opens the gap case but persists NO GoalReport', async () => {
  await withShadow('on', async () => {
    const c = makeMockClient([
      { match: 'from reconciliation_evaluations', rows: [
        { verdict: 'no_match', unmatchable_reason: 'x', model: 'm' }
      ] },
      { match: 'insert into bookkeeping_cases', rows: [{ id: 'case-r', status: 'open' }] },
      { match: 'select blocker_type, owner_type from bookkeeping_case_blockers', rows: [{ blocker_type: 'unclear_match', owner_type: 'firm' }] }
    ], { goalTablesPresent: false });
    const out = await onReconciliationRunCompleted({
      client: c, firmId: 'f', clientId: 'cl',
      targets: [{ targetType: 'document', targetId: 'doc-x' }]
    });
    assert.equal(out.opened, 1); // the 033 gap case still opens — goal layer is additive
    // the goal layer degrades to a clean no-op: no report, and no orphan goal_evaluated event.
    assert.ok(!c.calls.some((q) => /insert into loop_goal_reports/.test(q.sql)));
    assert.ok(!c.calls.some((q) => /insert into bookkeeping_case_events/.test(q.sql) && JSON.stringify(q.params).includes('goal_evaluated')));
  });
});

test('onReconciliationRunCompleted: empty targets is a zero-query no-op; duplicate targets are scanned once', async () => {
  await withShadow('on', async () => {
    const empty = makeMockClient();
    assert.equal(await onReconciliationRunCompleted({ client: empty, firmId: 'f', clientId: 'cl', targets: [] }), null);
    assert.equal(empty.calls.length, 0);

    const c = makeMockClient([
      { match: 'from reconciliation_evaluations', rows: [] },
      { match: 'from reconciliation_evaluations', rows: [] }
    ]);
    await onReconciliationRunCompleted({
      client: c, firmId: 'f', clientId: 'cl',
      targets: [{ targetType: 'document', targetId: 'doc-dupe' }, { targetType: 'document', targetId: 'doc-dupe' }]
    });
    const reads = c.calls.filter((q) => /from reconciliation_evaluations/.test(q.sql));
    assert.equal(reads.length, 1, 'duplicate targets are scanned once');
  });
});

// ── Slice 5 — reconcile each evaluated target's gap case to its FINAL state ───
// The open producer only ever OPENED a gap; the sweep never CLOSED or RELABELED one
// when a later run settled or proposed a match. These cover the two stale-blocker
// bugs the lifecycle fix closes (Gap 2 / sticky-close, Gap 1 / proposed-relabel), the
// no-gap no-op, and idempotency. Still workflow-only: no LLM, no accounting write.

test('onReconciliationRunCompleted (Slice 5): a sweep auto_matched target CLOSES the earlier-opened gap (Gap 2 / Dadant)', async () => {
  await withShadow('on', async () => {
    const docCaseId = buildCaseId({
      firmId: 'f', clientId: 'cl', caseType: 'reconciliation',
      primaryObjectType: 'document', primaryObjectId: 'doc-1'
    });
    const transactionCaseId = buildCaseId({
      firmId: 'f', clientId: 'cl', caseType: 'reconciliation',
      primaryObjectType: 'transaction', primaryObjectId: 't-1'
    });
    const c = makeMockClient([
      // a sticky (auto_matched) match now exists for the target → INV-4 outranks any verdict
      {
        match: 'from reconciliation_matches',
        rows: [{
          has_sticky_match: true,
          has_suggested_match: false,
          sticky_bank_transaction_ids: ['t-1'],
          suggested_bank_transaction_ids: []
        }]
      },
      // the open gap blocker on the document-anchored case is found + resolved
      { match: 'select id from bookkeeping_case_blockers', rows: [{ id: 'case-blocker-d1' }] },
      { match: "set status = 'resolved'", rows: [{ case_id: docCaseId, firm_id: 'f', client_id: 'cl', blocker_type: 'unclear_match', owner_type: 'firm' }] },
      { match: 'select event_type from bookkeeping_case_events', rows: [] },
      { match: 'select blocker_type, owner_type from bookkeeping_case_blockers', rows: [] },
      { match: 'select event_type from bookkeeping_case_events', rows: [{ event_type: 'case.resolved' }] },
      // The same match row names a bank-transaction workflow anchor. A
      // document-only sweep must settle that case too.
      { match: 'select id from bookkeeping_case_blockers', rows: [{ id: 'case-blocker-t1' }] },
      { match: "set status = 'resolved'", rows: [{ case_id: transactionCaseId, firm_id: 'f', client_id: 'cl', blocker_type: 'unclear_match', owner_type: 'firm' }] },
      { match: 'select event_type from bookkeeping_case_events', rows: [] },
      { match: 'select blocker_type, owner_type from bookkeeping_case_blockers', rows: [] },
      { match: 'select event_type from bookkeeping_case_events', rows: [{ event_type: 'case.resolved' }] }
    ]);
    const out = await onReconciliationRunCompleted({
      client: c, firmId: 'f', clientId: 'cl',
      targets: [{ targetType: 'document', targetId: 'doc-1' }]
    });
    assert.equal(out.resolved, 2);
    assert.equal(out.opened, 0);
    assert.equal(out.relabeled, 0);
    // a MET GoalReport is persisted on the now-settled case (INV-4 → goal met)
    const report = c.calls.find((q) => /insert into loop_goal_reports/.test(q.sql));
    assert.ok(report && report.params.includes('met') && !report.params.includes('unmet'), 'a met GoalReport is persisted');
    const blockerReads = c.calls.filter((q) => /select id from bookkeeping_case_blockers/.test(q.sql));
    assert.deepEqual(
      blockerReads.map((q) => q.params[0]),
      [[docCaseId], [transactionCaseId]],
      'a document-target sweep projects the sticky match to both workflow anchors'
    );
    const matchRead = c.calls.find((q) => /from reconciliation_matches/.test(q.sql));
    assert.match(matchRead.sql, /m\.matched_object_id = \$3/);
    assert.doesNotMatch(matchRead.sql, /m\.matched_object_type =/,
      'canonical workflow type document must not be compared with a concrete match subtype');
    assert.deepEqual(matchRead.params, ['f', 'cl', 'doc-1']);
    // no NEW gap opened; workflow-only (never an accounting/match write)
    assert.ok(!c.calls.some((q) => /insert into bookkeeping_cases/.test(q.sql)), 'no new case opened');
    assert.ok(!c.calls.some((q) => /update documents|update transactions|insert into reconciliation_matches|update reconciliation_matches/.test(q.sql)));
  });
});

test('onReconciliationRunCompleted (Slice 5): a sweep auto_matched BANK LINE closes the gap on the transaction anchor', async () => {
  await withShadow('on', async () => {
    const c = makeMockClient([
      { match: 'from reconciliation_matches', rows: [{ has_sticky_match: true, has_suggested_match: false }] },
      { match: 'select id from bookkeeping_case_blockers', rows: [{ id: 'case-blocker-t1' }] },
      { match: "set status = 'resolved'", rows: [{ case_id: 'case-reconciliation-t1', firm_id: 'f', client_id: 'cl', blocker_type: 'unclear_match', owner_type: 'firm' }] },
      { match: 'select event_type from bookkeeping_case_events', rows: [] },
      { match: 'select blocker_type, owner_type from bookkeeping_case_blockers', rows: [] }
    ]);
    const out = await onReconciliationRunCompleted({
      client: c, firmId: 'f', clientId: 'cl',
      targets: [{ targetType: 'transaction', targetId: 't-1' }]
    });
    assert.equal(out.resolved, 1);
    // the live-match read anchors on the bank line, not matched_object —
    // $3 with three params (the old $4 pin froze the unreferenced-$3 pg error)
    const matchRead = c.calls.find((q) => /from reconciliation_matches/.test(q.sql));
    assert.match(matchRead.sql, /bank_transaction_id = \$3/);
    assert.equal(matchRead.params.length, 3);
  });
});

test('onReconciliationRunCompleted (Slice 5): a later suggested (non-sticky) match RELABELS the open gap to "confirm the proposed match" (Gap 1)', async () => {
  await withShadow('on', async () => {
    const docCaseId = buildCaseId({
      firmId: 'f', clientId: 'cl', caseType: 'reconciliation',
      primaryObjectType: 'document', primaryObjectId: 'doc-2'
    });
    const transactionCaseId = buildCaseId({
      firmId: 'f', clientId: 'cl', caseType: 'reconciliation',
      primaryObjectType: 'transaction', primaryObjectId: 't-2'
    });
    const c = makeMockClient([
      {
        match: 'from reconciliation_matches',
        rows: [{
          has_sticky_match: false,
          has_suggested_match: true,
          sticky_bank_transaction_ids: [],
          suggested_bank_transaction_ids: ['t-2']
        }]
      },
      // an open unclear_match gap blocker (still carrying the stale no-match text) exists
      { match: 'select id, reason from bookkeeping_case_blockers', rows: [{ id: 'case-blocker-p1', reason: 'No matching bank line found.' }] },
      // the in-place reason update affects the one open blocker (rowCount 1)
      { match: 'set reason', rows: [{ id: 'case-blocker-p1' }] },
      // The transaction-side blocker carries the same stale no-match wording.
      { match: 'select id, reason from bookkeeping_case_blockers', rows: [{ id: 'case-blocker-p2', reason: 'No matching bank line found.' }] },
      { match: 'set reason', rows: [{ id: 'case-blocker-p2' }] }
    ]);
    const out = await onReconciliationRunCompleted({
      client: c, firmId: 'f', clientId: 'cl',
      targets: [{ targetType: 'document', targetId: 'doc-2' }]
    });
    assert.equal(out.relabeled, 2);
    assert.equal(out.opened, 0);
    assert.equal(out.resolved, 0);
    // the blocker stays OPEN but its reason is rewritten in place to the proposed-match prompt
    const upd = c.calls.find((q) => /update bookkeeping_case_blockers/.test(q.sql) && /set reason/.test(q.sql));
    assert.ok(upd, 'the gap blocker reason is updated in place');
    assert.equal(upd.params[1], PROPOSED_MATCH_GAP_REASON);
    assert.match(PROPOSED_MATCH_GAP_REASON, /confirm/i);
    const blockerReads = c.calls.filter((q) => /select id, reason from bookkeeping_case_blockers/.test(q.sql));
    assert.deepEqual(
      blockerReads.map((q) => q.params[0]),
      [docCaseId, transactionCaseId],
      'a document-target sweep projects the proposal to both workflow anchors'
    );
    // NOT resolved (the human has the last say) and no new gap opens
    assert.ok(!c.calls.some((q) => /set status = 'resolved'/.test(q.sql)), 'the blocker is not resolved');
    assert.ok(!c.calls.some((q) => /insert into bookkeeping_cases/.test(q.sql)), 'no new case opened');
    // the relabel is recorded on the append-only stream + a proposed (indeterminate) report
    assert.ok(c.calls.some((q) => /insert into bookkeeping_case_events/.test(q.sql) && JSON.stringify(q.params).includes('reconciliation.gap_relabeled')), 'relabel event appended');
    assert.ok(c.calls.some((q) => /insert into loop_goal_reports/.test(q.sql)), 'a proposed GoalReport is persisted');
    // workflow-only — no accounting/match write
    assert.ok(!c.calls.some((q) => /update documents|update transactions|insert into reconciliation_matches|update reconciliation_matches/.test(q.sql)));
  });
});

test('onReconciliationRunCompleted (Slice 5): a suggested match on a line that was never a gap is a clean no-op', async () => {
  await withShadow('on', async () => {
    const c = makeMockClient([
      { match: 'from reconciliation_matches', rows: [{ has_sticky_match: false, has_suggested_match: true }] },
      { match: 'select id, reason from bookkeeping_case_blockers', rows: [] } // no open gap blocker to relabel
    ]);
    const out = await onReconciliationRunCompleted({
      client: c, firmId: 'f', clientId: 'cl',
      targets: [{ targetType: 'document', targetId: 'doc-3' }]
    });
    assert.equal(out.relabeled, 0);
    assert.equal(out.opened, 0);
    // never opens a case, never relabels, never records a report
    assert.ok(!c.calls.some((q) => /update bookkeeping_case_blockers/.test(q.sql)));
    assert.ok(!c.calls.some((q) => /insert into loop_goal_reports/.test(q.sql)));
    assert.ok(!c.calls.some((q) => /insert into bookkeeping_cases/.test(q.sql)));
  });
});

test('onReconciliationRunCompleted (Slice 5): relabel is idempotent — a re-sweep with the reason already set writes nothing', async () => {
  await withShadow('on', async () => {
    const c = makeMockClient([
      { match: 'from reconciliation_matches', rows: [{ has_sticky_match: false, has_suggested_match: true }] },
      { match: 'select id, reason from bookkeeping_case_blockers', rows: [{ id: 'b1', reason: PROPOSED_MATCH_GAP_REASON }] }
    ]);
    const out = await onReconciliationRunCompleted({
      client: c, firmId: 'f', clientId: 'cl',
      targets: [{ targetType: 'document', targetId: 'doc-2' }]
    });
    assert.equal(out.relabeled, 0);
    // already-relabeled blocker → no reason update, no event, no report
    assert.ok(!c.calls.some((q) => /update bookkeeping_case_blockers/.test(q.sql)));
    assert.ok(!c.calls.some((q) => /insert into bookkeeping_case_events/.test(q.sql) && JSON.stringify(q.params).includes('reconciliation.gap_relabeled')));
    assert.ok(!c.calls.some((q) => /insert into loop_goal_reports/.test(q.sql)));
  });
});

test('onReconciliationRunCompleted (already_settled): a settled no_match RESOLVES the false gap instead of opening one', () => withShadow('on', async () => {
  // The strong matcher returned no_match + already_settled (the obligation is already
  // accounted for by other bank lines). The prior behaviour opened a firm "No matching
  // bank line found (already_settled)" gap; now the evaluator projects it as
  // resolve_gap, so the producer CLOSES the open unclear_match blocker instead.
  const c = makeMockClient([
    // no live match for the target → falls through to the verdict read
    { match: 'from reconciliation_matches', rows: [{ has_sticky_match: false, has_suggested_match: false }] },
    // the persisted verdict: no_match, reason already_settled
    { match: 'from reconciliation_evaluations', rows: [{ verdict: 'no_match', unmatchable_reason: 'already_settled', model: 'claude-opus-4-8' }] },
    // the open gap blocker on the target's case is found + resolved
    { match: 'select id from bookkeeping_case_blockers', rows: [{ id: 'case-blocker-as1' }] },
    { match: "set status = 'resolved'", rows: [{ case_id: 'case-reconciliation-as1', firm_id: 'f', client_id: 'cl', blocker_type: 'unclear_match', owner_type: 'firm' }] },
    { match: 'select event_type from bookkeeping_case_events', rows: [] },
    { match: 'select blocker_type, owner_type from bookkeeping_case_blockers', rows: [] }
  ]);
  const out = await onReconciliationRunCompleted({
    client: c, firmId: 'f', clientId: 'cl',
    targets: [{ targetType: 'document', targetId: 'doc-settled' }]
  });
  assert.equal(out.opened, 0, 'no new gap opened for a settled obligation');
  // the false gap blocker is RESOLVED, and a met GoalReport is persisted
  assert.ok(c.calls.some((q) => /set status = 'resolved'/.test(q.sql)), 'the unclear_match blocker is resolved');
  const report = c.calls.find((q) => /insert into loop_goal_reports/.test(q.sql));
  assert.ok(report && report.params.includes('met') && !report.params.includes('unmet'), 'a met GoalReport is persisted');
  // never opens a case, never an accounting/match write
  assert.ok(!c.calls.some((q) => /insert into bookkeeping_cases/.test(q.sql)), 'no new case opened');
  assert.ok(!c.calls.some((q) => /update documents|update transactions|insert into reconciliation_matches|update reconciliation_matches/.test(q.sql)));
}));

// ── Ask-escalation parse-quiescence gate (RECONCILIATION_ASK_QUIESCENCE_GATE) ──
// Root cause it guards: during a mass upload the bank-statement side races to a
// no_match disposition and escalates a bare line to an OWNER ASK while a still-
// parsing receipt that would auto-match the line sits in the parse queue (Honeybee
// Aug $26.83 POS CHEVRON — the receipt finished parsing 18s AFTER the owner reply
// had already explained the line). The gate DEFERS the ask draft while the client
// has documents in flight; the late doc's own parse-completion re-runs reconcile.

const withEnvVars = async (vars, fn) => {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return await fn(); } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
};

test('askEscalationQuiescenceGateAllows — fail-closed, client-scoped canary semantics', () => {
  const on = (clients) => ({
    RECONCILIATION_ASK_QUIESCENCE_GATE: 'true',
    ...(clients ? { RECONCILIATION_ASK_QUIESCENCE_GATE_CLIENTS: clients } : {})
  });
  assert.equal(askEscalationQuiescenceGateAllows('c', {}), false, 'flag unset → OFF (fail-closed)');
  assert.equal(askEscalationQuiescenceGateAllows('c', { RECONCILIATION_ASK_QUIESCENCE_GATE: 'false' }), false);
  assert.equal(askEscalationQuiescenceGateAllows('c', on()), true, 'flag on, no allowlist → every client');
  assert.equal(askEscalationQuiescenceGateAllows('honeybee', on('honeybee, other')), true, 'flag on + allowlisted');
  assert.equal(askEscalationQuiescenceGateAllows('stranger', on('honeybee')), false, 'flag on + NOT allowlisted → off');
  assert.equal(askEscalationQuiescenceGateAllows('', on('honeybee')), false, 'empty client id never matches an allowlist');
});

test('clientHasInFlightDocumentsForAskQuiescence — true iff a parsing doc is found; filters parse_status + backstop', async () => {
  const inflight = makeMockClient([{ match: 'parse_status = any', rows: [{ one: 1 }] }]);
  assert.equal(
    await clientHasInFlightDocumentsForAskQuiescence({ client: inflight, firmId: 'f', clientId: 'c' }),
    true, 'a pending/processing doc → client is non-quiescent'
  );
  const q = inflight.calls.find((c) => c.sql.includes('parse_status = any'));
  assert.deepEqual(q.params[2], ['pending', 'processing', 'duplicate_pending'], 'only genuinely in-flight parse states block');
  assert.equal(q.params[3], 60, 'backstop window (minutes) so a wedged doc cannot suppress asks forever');

  const quiescent = makeMockClient([{ match: 'parse_status = any', rows: [] }]);
  assert.equal(
    await clientHasInFlightDocumentsForAskQuiescence({ client: quiescent, firmId: 'f', clientId: 'c' }),
    false, 'no in-flight doc → quiescent'
  );
  assert.equal(
    await clientHasInFlightDocumentsForAskQuiescence({ firmId: 'f', clientId: 'c' }),
    false, 'missing client → false, never throws'
  );
});

test('ask-draft producer — gate ON + a doc still parsing → DEFERS the draft (no outbox enqueue)', async () => {
  await withEnvVars({
    LOOPS_SHADOW: 'true', LOOPS_TIER: 'canary',
    RECONCILIATION_ASK_QUIESCENCE_GATE: 'true',
    RECONCILIATION_ASK_QUIESCENCE_GATE_CLIENTS: 'client-1'
  }, async () => {
    const client = makeMockClient([
      { match: 'from firms where id', rows: [{ metadata: { loops: { tier: 'canary' } } }] },
      { match: 'parse_status = any', rows: [{ one: 1 }] } // a receipt still in the queue
    ]);
    const out = await onReconcileCompleteRequestAskDraft({ client, firmId: 'firm-1', clientId: 'client-1' });
    assert.equal(out.deferred, true);
    assert.equal(out.reason, 'deferred_pending_parse_quiescence');
    assert.equal(out.enqueued, 0);
    assert.ok(
      !client.calls.some((c) => c.sql.includes('insert into loop_event_outbox')),
      'no ask_draft.requested is enqueued while the client is still parsing'
    );
  });
});

test('ask-draft producer — gate ON but client is quiescent → enqueues the draft as normal', async () => {
  await withEnvVars({
    LOOPS_SHADOW: 'true', LOOPS_TIER: 'canary',
    RECONCILIATION_ASK_QUIESCENCE_GATE: 'true',
    RECONCILIATION_ASK_QUIESCENCE_GATE_CLIENTS: 'client-1'
  }, async () => {
    const client = makeMockClient([
      { match: 'from firms where id', rows: [{ metadata: { loops: { tier: 'canary' } } }] },
      { match: 'parse_status = any', rows: [] },             // nothing in flight
      { match: 'from loop_event_outbox', rows: [] },          // no in-flight request → coalesce passes
      { match: 'insert into loop_event_outbox', rows: [{ id: 'outbox-1' }] }
    ]);
    const out = await onReconcileCompleteRequestAskDraft({
      client,
      firmId: 'firm-1',
      clientId: 'client-1',
      source: 'identity_contract_recovery',
      requestedAt: '2026-08-28T16:45:00.000Z'
    });
    assert.equal(out.enqueued, 1, 'a quiescent client still gets its ask draft');
    assert.ok(!out.deferred);
    const enqueue = client.calls.find((call) => call.sql.includes('insert into loop_event_outbox'));
    assert.deepEqual(JSON.parse(enqueue.params[6]), {
      requested_at: '2026-08-28T16:45:00.000Z',
      source: 'identity_contract_recovery',
      identity_contract: ASK_DRAFT_IDENTITY_CONTRACT
    });
  });
});

test('ask-draft producer — gate OFF → in-flight docs do NOT defer (byte-identical, never queries parse state)', async () => {
  await withEnvVars({
    LOOPS_SHADOW: 'true', LOOPS_TIER: 'canary',
    RECONCILIATION_ASK_QUIESCENCE_GATE: undefined // gate off
  }, async () => {
    const client = makeMockClient([
      { match: 'from firms where id', rows: [{ metadata: { loops: { tier: 'canary' } } }] },
      { match: 'from loop_event_outbox', rows: [] },
      { match: 'insert into loop_event_outbox', rows: [{ id: 'outbox-1' }] }
    ]);
    const out = await onReconcileCompleteRequestAskDraft({ client, firmId: 'firm-1', clientId: 'client-1' });
    assert.equal(out.enqueued, 1);
    assert.ok(
      !client.calls.some((c) => c.sql.includes('parse_status = any')),
      'gate off → the quiescence query is never even issued'
    );
  });
});

// ── 0A.6c config control plane: the two DB-path quadrants ─────────────
// Completes the 4-quadrant matrix with the env-only quadrants above (ON + in-flight →
// defers; OFF → never queries parse state). A present client_capability_config row
// decides (empty=∅, fail-closed); no row ⇒ the env canary (the env-only tests, where the
// mock returns empty for the config queries). The config snapshot is read on the
// post-actionAllowed path, so a canned 'from client_capability_config' row drives the gate.

test('ask-draft producer — DB stage=canary + env OFF + a doc still parsing → DEFERS (config plane overrides env-off) (0A.6c)', async () => {
  await withEnvVars({
    LOOPS_SHADOW: 'true', LOOPS_TIER: 'canary',
    RECONCILIATION_ASK_QUIESCENCE_GATE: undefined // env gate OFF — only the DB row is on
  }, async () => {
    const client = makeMockClient([
      { match: 'from firms where id', rows: [{ metadata: { loops: { tier: 'canary' } } }] },
      { match: 'from client_capability_config', rows: [{ flag_key: ASK_QUIESCENCE_GATE_FLAG_KEY, stage: 'canary', source: 'manual', client_id: 'client-1' }] },
      { match: 'parse_status = any', rows: [{ one: 1 }] } // a receipt still in the queue
    ]);
    const out = await onReconcileCompleteRequestAskDraft({ client, firmId: 'firm-1', clientId: 'client-1' });
    assert.equal(out.deferred, true, 'DB canary stage drove the quiescence defer with the env flag unset');
    assert.equal(out.reason, 'deferred_pending_parse_quiescence');
    assert.equal(out.enqueued, 0);
  });
});

test('ask-draft producer — DB stage=off + env ON + a doc still parsing → enqueues (present DB row ∅ overrides env-on) (0A.6c)', async () => {
  await withEnvVars({
    LOOPS_SHADOW: 'true', LOOPS_TIER: 'canary',
    RECONCILIATION_ASK_QUIESCENCE_GATE: 'true',
    RECONCILIATION_ASK_QUIESCENCE_GATE_CLIENTS: 'client-1'
  }, async () => {
    const client = makeMockClient([
      { match: 'from firms where id', rows: [{ metadata: { loops: { tier: 'canary' } } }] },
      { match: 'from client_capability_config', rows: [{ flag_key: ASK_QUIESCENCE_GATE_FLAG_KEY, stage: 'off', source: 'manual', client_id: 'client-1' }] },
      { match: 'from loop_event_outbox', rows: [] },          // no in-flight request → coalesce passes
      { match: 'insert into loop_event_outbox', rows: [{ id: 'outbox-1' }] }
    ]);
    const out = await onReconcileCompleteRequestAskDraft({ client, firmId: 'firm-1', clientId: 'client-1' });
    assert.equal(out.enqueued, 1, 'present DB off row ⇒ ∅ overrides env-on → no defer, enqueues normally');
    assert.ok(!out.deferred);
    assert.ok(
      !client.calls.some((c) => c.sql.includes('parse_status = any')),
      'DB off ⇒ gate ∅ → the quiescence query is never even issued (short-circuit preserved)'
    );
  });
});
