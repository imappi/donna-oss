// buildCaseTimeline — pure-merge tests (Slice 1 of
// docs/design-donna-line-audit-timeline.md). Pins:
//   - one ascending time-ordered stream; receipts without a timestamp sort
//     LAST, never dropped (a visible §4 gap, not a silent one)
//   - the ask lifecycle expands into its four timestamped events
//   - densities: owner sees matches/settles/asks/coding; evaluations, raw
//     audit rows, drafts and failed cascades stay debug
//   - the owner-visible audit-action allowlist is the ONE extension point
//   - epoch-millis timestamps (ai_suggestion.suggested_at) convert to ISO
//   - a match with no triage receipt is a NAMED gap

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCaseTimeline,
  TIMELINE_EVENT_KINDS,
  OWNER_VISIBLE_AUDIT_ACTIONS
} from './caseTimeline.js';

const MATCH = {
  id: 'm-1',
  bank_transaction_id: 'tx-1',
  matched_object_type: 'supplier_bill',
  matched_object_id: 'doc-1',
  match_amount: 865.13,
  match_confidence: 0.92,
  status: 'auto_matched',
  created_at: '2026-08-06T12:55:08.000Z',
  updated_at: '2026-08-06T12:55:09.000Z',
  payload: {
    match_reason: { summary: 'Exact amount on the bill date.', reasoning: 'No competing candidate.' },
    authorization: {
      band: 'auto_matched',
      model: 'claude-opus-4-8',
      gates: { A: true, B: true, C: true, D: true, E: false },
      reasons: ['material_auto_fyi'],
      material_auto_fyi: { policy: 'material_auto_fyi', owner_notified: false }
    },
    cascade: { state: 'applied', at: '2026-08-06T12:55:10.000Z', attempts: 1 }
  }
};

const EVALUATION = {
  id: 'ev-1',
  target_type: 'document',
  target_id: 'doc-1',
  matcher_family: 'supplier_bill',
  matcher_mode: 'llm',
  verdict: 'proposed',
  model: 'claude-opus-4-8',
  proposal_count: 1,
  candidate_count: 4,
  eligible_count: 2,
  evaluated_at: '2026-08-06T12:55:05.000Z'
};

const ASK = {
  id: 'cer-1',
  question: 'What was this land lease payment for?',
  evidence_type: 'supporting_document',
  status: 'resolved',
  send_count: 1,
  created_at: '2026-08-06T12:55:04.000Z',
  first_sent_at: '2026-08-06T12:56:00.000Z',
  responded_at: null,
  resolved_at: '2026-08-06T12:58:00.000Z',
  resolved_by: 'system',
  response_payload: { auto_resolved_by_match: true, reconciliation_match_id: 'm-1' }
};

const TX = {
  id: 'tx-1',
  document_id: 'statement-1',
  created_at: '2026-08-06T12:55:03.000Z',
  payload: {
    ai_suggestion: {
      proposed_account: 'Rent',
      confidence: 'high',
      evidence_required: true,
      suggested_at: Date.parse('2026-08-06T12:55:06.000Z')
    }
  }
};

const DOCUMENTS = [
  {
    id: 'statement-1',
    filename: 'Wise Statement Aug.csv',
    document_type: 'bank_statement',
    source: 'firm_upload',
    payload: { actor_id: 'member-kari' },
    uploaded_at: '2026-08-06T12:55:01.000Z'
  },
  {
    id: 'doc-1',
    filename: 'Land Lease 865.13.pdf',
    document_type: 'supplier_bill',
    source: 'client_portal',
    payload: { actor_id: 'owner-maya' },
    uploaded_at: '2026-08-06T12:55:02.000Z'
  }
];

const ACTORS = [
  { id: 'member-kari', name: 'Kari Salonen', actor_type: 'firm' },
  { id: 'owner-maya', name: 'Maya Chen', actor_type: 'client' }
];

await test('one ascending stream: evaluation → match → cascade → coding → ask lifecycle, all present', () => {
  const { events, gaps } = buildCaseTimeline({
    transaction: TX,
    documents: DOCUMENTS,
    matches: [MATCH],
    evaluations: [EVALUATION],
    evidenceRequests: [ASK],
    auditEvents: [],
    actors: ACTORS
  });
  const kinds = events.map((e) => e.kind);
  assert.deepEqual(kinds, [
    'document_received', // 12:55:01 — statement provenance
    'document_received', // 12:55:02 — matching evidence provenance
    'transaction_imported', // 12:55:03
    'ask_drafted',        // 12:55:04
    'triage_evaluation',  // 12:55:05
    'coding_suggested',   // 12:55:06 (epoch millis → ISO)
    'match',              // 12:55:08
    'cascade',            // 12:55:10
    'ask_sent',           // 12:56:00
    'ask_resolved'        // 12:58:00
  ]);
  for (const e of events) assert.ok(TIMELINE_EVENT_KINDS.includes(e.kind), `unknown kind ${e.kind}`);
  // ascending, every event timestamped in this fixture
  const ats = events.map((e) => e.at);
  assert.deepEqual([...ats].sort(), ats);
  assert.deepEqual(gaps, []);
});

await test('document and bank-line provenance carry source, named actor, timestamp, and receipt', () => {
  const { events, gaps } = buildCaseTimeline({ transaction: TX, documents: DOCUMENTS, actors: ACTORS });
  const [statement, evidence, imported] = events;
  assert.equal(statement.kind, 'document_received');
  assert.equal(statement.actor, 'firm');
  assert.equal(statement.actor_name, 'Kari Salonen');
  assert.equal(statement.fields.filename, 'Wise Statement Aug.csv');
  assert.equal(evidence.actor, 'client');
  assert.equal(evidence.actor_name, 'Maya Chen');
  assert.equal(evidence.fields.source, 'client_portal');
  assert.equal(imported.kind, 'transaction_imported');
  assert.equal(imported.at, '2026-08-06T12:55:03.000Z');
  assert.equal(imported.fields.source_document_id, 'statement-1');
  assert.deepEqual(imported.receipt_ref, { table: 'transactions', id: 'tx-1', path: 'source_document' });
  assert.deepEqual(gaps, []);
});

await test('a human receipt with incomplete attribution surfaces an audit gap', () => {
  const { events, gaps } = buildCaseTimeline({
    documents: [{ id: 'doc-old', filename: 'old.pdf', source: 'client_portal', created_at: '2026-01-01T10:00:00Z' }]
  });
  assert.equal(events[0].actor, 'owner');
  assert.equal(events[0].actor_id, null);
  assert.deepEqual(gaps, [{
    kind: 'missing_actor_identity',
    event_kind: 'document_received',
    receipt_ref: { table: 'documents', id: 'doc-old' }
  }]);
});

await test('audit actor ids resolve to names without changing the persisted actor role', () => {
  const { events, gaps } = buildCaseTimeline({
    auditEvents: [{
      id: 'a-human', actor_type: 'firm', actor_id: 'kari@example.com',
      action: 'reconciliation.reject_match', created_at: '2026-08-06T13:02:00Z'
    }],
    actors: [{ id: 'member-kari', email: 'kari@example.com', name: 'Kari Salonen', actor_type: 'firm' }]
  });
  assert.equal(events[0].actor_name, 'Kari Salonen');
  assert.equal(events[0].actor_id, 'kari@example.com');
  assert.deepEqual(gaps, []);
});

await test('an automated receipt stays Donna even when it carries an initiating user id', () => {
  const { events } = buildCaseTimeline({
    auditEvents: [{
      id: 'a-auto', actor_type: 'system', actor_id: 'member-kari',
      action: 'reconciliation.auto_explain', created_at: '2026-08-06T13:02:00Z'
    }],
    actors: [{ id: 'member-kari', name: 'Kari Salonen', actor_type: 'firm' }]
  });
  assert.equal(events[0].actor, 'donna');
  assert.equal(events[0].actor_name, null);
});

await test('receipt fields ride verbatim: authority provenance, gates, model id, resolving match', () => {
  const { events } = buildCaseTimeline({ transaction: TX, matches: [MATCH], evaluations: [EVALUATION], evidenceRequests: [ASK] });
  const match = events.find((e) => e.kind === 'match');
  assert.equal(match.fields.authority, 'material_auto_fyi');
  assert.equal(match.fields.model, 'claude-opus-4-8');
  assert.equal(match.fields.gates.E, false);
  assert.equal(match.fields.owner_notified, false);
  assert.deepEqual(match.receipt_ref, { table: 'reconciliation_matches', id: 'm-1' });
  const coding = events.find((e) => e.kind === 'coding_suggested');
  assert.equal(coding.at, '2026-08-06T12:55:06.000Z');
  assert.equal(coding.fields.proposed_account, 'Rent');
  const resolved = events.find((e) => e.kind === 'ask_resolved');
  assert.equal(resolved.fields.auto_resolved_by_match, true);
  assert.equal(resolved.fields.match_id, 'm-1');
});

await test('densities: owner sees the story, debug sees the machinery', () => {
  const { events } = buildCaseTimeline({
    transaction: TX,
    matches: [MATCH],
    evaluations: [EVALUATION],
    evidenceRequests: [ASK],
    auditEvents: [
      { id: 'a-1', actor_type: 'system', action: 'reconciliation.auto_explain', metadata: {}, created_at: '2026-08-06T13:00:00Z' },
      { id: 'a-2', actor_type: 'system', action: 'transaction_review.waiting_released_after_settle', metadata: {}, created_at: '2026-08-06T13:01:00Z' },
      { id: 'a-3', actor_type: 'firm', action: 'reconciliation.reject_match', metadata: { reason: 'Wrong document' }, created_at: '2026-08-06T13:02:00Z' }
    ]
  });
  const density = Object.fromEntries(events.map((e) => [`${e.kind}:${e.receipt_ref?.id}`, e.density]));
  assert.equal(density['triage_evaluation:ev-1'], 'debug');
  assert.equal(density['match:m-1'], 'owner');
  assert.equal(density['cascade:m-1'], 'owner', 'an applied cascade is the owner-visible settle moment');
  assert.equal(density['coding_suggested:tx-1'], 'owner');
  assert.equal(density['ask_drafted:cer-1'], 'debug', 'a draft is not owner-visible until sent');
  assert.equal(density['ask_sent:cer-1'], 'owner');
  assert.equal(density['audit:a-1'], 'owner', 'auto_explain is on the owner allowlist');
  assert.equal(density['audit:a-2'], 'debug', 'internal release stays debug');
  assert.equal(density['audit:a-3'], 'owner', 'a chat-guided rejection and its reason belong in the visible story');
  assert.ok(OWNER_VISIBLE_AUDIT_ACTIONS.includes('reconciliation.auto_explain'));
  assert.ok(OWNER_VISIBLE_AUDIT_ACTIONS.includes('reconciliation.reject_match'));
});

await test('a failed cascade is debug; the terminal verdict, not retry noise, is the owner story', () => {
  const failed = {
    ...MATCH,
    payload: { ...MATCH.payload, cascade: { state: 'failed', at: '2026-08-06T12:55:10.000Z', attempts: 2, error_class: 'DeadlockDetected' } }
  };
  const { events } = buildCaseTimeline({ matches: [failed] });
  const cascade = events.find((e) => e.kind === 'cascade');
  assert.equal(cascade.density, 'debug');
  assert.equal(cascade.fields.error_class, 'DeadlockDetected');
});

await test('a receipt without a timestamp sorts LAST and is never dropped', () => {
  const untimedTx = { id: 'tx-1', payload: { ai_suggestion: { proposed_account: 'Rent' } } }; // no suggested_at
  const { events } = buildCaseTimeline({ transaction: untimedTx, matches: [MATCH] });
  const last = events[events.length - 1];
  assert.equal(last.kind, 'coding_suggested');
  assert.equal(last.at, null);
});

await test('a match with no triage receipt is a NAMED gap, not silence', () => {
  const { gaps } = buildCaseTimeline({ matches: [MATCH], evaluations: [] });
  assert.deepEqual(gaps, [{ kind: 'no_triage_receipt_for_match', match_id: 'm-1', matched_object_id: 'doc-1' }]);
});

await test('an evaluation targeting the TRANSACTION (disposition producer) also satisfies the gap check', () => {
  const dispositionEval = { ...EVALUATION, id: 'ev-2', target_type: 'transaction', target_id: 'tx-1' };
  const { gaps } = buildCaseTimeline({ matches: [MATCH], evaluations: [dispositionEval] });
  assert.deepEqual(gaps, []);
});

await test('empty inputs produce the empty_timeline gap and a stable shape', () => {
  const { events, gaps } = buildCaseTimeline({});
  assert.deepEqual(events, []);
  assert.deepEqual(gaps, [{ kind: 'empty_timeline' }]);
});

// ── Universal mentions (slice 3): comments join the same timeline ───────────

await test('comment rows: verbatim text, human attribution, thread_resolution; plain chat never maps', () => {
  const { events, gaps } = buildCaseTimeline({
    chatMessages: [
      {
        id: 'msg-1', created_at: '2026-08-27T10:00:00Z', role: 'user', actor_type: 'firm',
        actor_id: 'kari@books.example', content: '@Clara take a look',
        chat_table: 'transaction_chat_messages',
        payload: { kind: 'comment', flavor: 'mention', mentions: [{ actor_type: 'agent', agent_id: 'clara', display: 'Clara' }] }
      },
      {
        id: 'msg-2', created_at: '2026-08-27T11:00:00Z', role: 'user', actor_type: 'firm',
        actor_id: 'kari@books.example', content: 'resolved — director loan',
        payload: { kind: 'thread_resolution', outcome_note: 'director loan', policy_memory_candidate: true }
      },
      // plain conversation stays OUT of the timeline
      { id: 'msg-3', created_at: '2026-08-27T12:00:00Z', role: 'user', actor_type: 'firm', content: 'hello', payload: {} }
    ],
    actors: [{ id: 'kari@books.example', email: 'kari@books.example', name: 'Kari', actor_type: 'firm' }]
  });
  const comments = events.filter((e) => e.kind === 'comment');
  assert.equal(comments.length, 2);
  assert.equal(comments[0].actor, 'firm');
  assert.equal(comments[0].actor_id, 'kari@books.example');
  assert.equal(comments[0].actor_name, 'Kari');
  assert.equal(comments[0].density, 'owner');
  assert.equal(comments[0].fields.text, '@Clara take a look');
  assert.deepEqual(comments[0].fields.mentions, ['Clara']);
  assert.deepEqual(comments[0].receipt_ref, { table: 'transaction_chat_messages', id: 'msg-1' });
  assert.equal(comments[1].fields.kind, 'thread_resolution');
  assert.equal(comments[1].fields.policy_memory_candidate, true);
  // Attributed events never trip the missing-identity gap.
  assert.equal(gaps.some((g) => g.kind === 'missing_actor_identity' && g.event_kind === 'comment'), false);
});

test('Jev coding and disposition handoffs stay visible with both returned model receipts', async () => {
  const { buildTimelineEventView, visibleTimelineEvents } = await import('../../src/lib/auditTimelineView.js');
  const first = { model: 'jev-returned', selected: 'needs_reasoning', probability: 0.43, handed_off: true };
  const timeline = buildCaseTimeline({
    transaction: { ...TX, payload: { ai_suggestion: { proposed_account: 'Marketing', model: 'strong-returned',
      decision_engine: 'strong_after_jev', jev_handoff: { ...first, terminal: 'needs_reasoning' } } } },
    evaluations: [{ ...EVALUATION, model: 'strong-returned', payload: { decision_engine: 'jev_then_reasoning', jev_first: first } }]
  });
  const views = visibleTimelineEvents(timeline.events.map(event => buildTimelineEventView(event)));
  for (const kind of ['coding_suggested', 'triage_evaluation']) {
    const view = views.find(v => v.kind === kind);
    assert.ok(view, `${kind} is owner visible`);
    assert.ok(view.chips.includes('Jev requested reasoning'));
    assert.ok(view.chips.includes('jev-returned'));
    assert.ok(view.chips.includes('strong-returned'));
    assert.ok(view.chips.includes('Jev choice probability 43%'));
  }
});
