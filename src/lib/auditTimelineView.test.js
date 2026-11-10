// Audit-timeline view model — unit tests (Slice 2 of
// docs/design-donna-line-audit-timeline.md).
//
// Properties: template prose only (every string derives from event.fields —
// nothing here calls out); the terminal verdict keeps hanging framed as a
// violation; density filtering hides debug events from the owner view but
// never drops them from the debug view; unknown kinds/actions render raw
// rather than being hidden; gaps always label.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAuditTimelineView,
  buildTerminalView,
  buildTimelineEventView,
  labelForTimelineActor,
  labelForTimelineGap,
  visibleTimelineEvents
} from './auditTimelineView.js';

test('terminal views: the three states map to their tones; hanging stays a violation', () => {
  assert.equal(buildTerminalView({ present: true, state: 'auto_reconciled', reason: 'review_state:accepted' }).tone, 'settled');
  assert.equal(buildTerminalView({ present: true, state: 'on_owner', reason: 'open_owner_ask' }).tone, 'owner');
  const hanging = buildTerminalView({ present: true, state: 'hanging', reason: 'review_state:suggested' });
  assert.equal(hanging.tone, 'violation');
  assert.match(hanging.headline, /neither terminal/);
  assert.equal(hanging.reason, 'review_state:suggested');
});

test('posted correction blockers name the recovery code in the visible terminal headline', () => {
  for (const [prefix,state,code] of [['posted_evidence','blocked','CODING_CORRECTION_AUTHORITY_REQUIRED'],['posted_evidence','failed','TRANSACTION_ALV_CODING_SOURCE_CONFLICT'],
    ['posted_tax_registration','blocked','CODING_CORRECTION_TAX_PERIOD_CLOSED']]) {
    const reason = `${prefix}_correction_${state}:${code}`;
    const view = buildTerminalView({ present: true, state: 'hanging', reason });
    assert.equal(view.tone, 'violation');
    assert.match(view.headline, new RegExp(code));
    assert.equal(view.reason, reason);
  }
});

test('terminal views: absent block and unknown state degrade visibly, never throw', () => {
  assert.equal(buildTerminalView(null).tone, 'unknown');
  assert.equal(buildTerminalView({ present: false, reason: 'no_focus_row' }).reason, 'no_focus_row');
  const odd = buildTerminalView({ present: true, state: 'someday_state' });
  assert.equal(odd.tone, 'unknown');
  assert.equal(odd.headline, 'someday_state');
});

test('match event: summary is the headline, authority and confidence become chips', () => {
  const view = buildTimelineEventView({
    at: '2026-08-01T10:00:00.000Z',
    kind: 'match',
    actor: 'donna',
    density: 'owner',
    fields: {
      summary: 'Land lease payment matched to the Sonoran bill',
      reasoning: 'Exact amount, right date window.',
      confidence: 0.94,
      authority: 'material_auto_fyi',
      status: 'settled'
    },
    receipt_ref: { table: 'reconciliation_matches', id: 'm1' }
  });
  assert.equal(view.headline, 'Land lease payment matched to the Sonoran bill');
  assert.equal(view.detail, 'Exact amount, right date window.');
  assert.ok(view.chips.includes('94% confidence'));
  assert.ok(view.chips.some((c) => /auto-approve limit/.test(c)));
  // settled status is the normal case — no chip noise for it
  assert.ok(!view.chips.includes('settled'));
  assert.equal(view.receiptRef.table, 'reconciliation_matches');
});

test('provenance events render the persisted filename and intake channel', () => {
  const evidence = buildTimelineEventView({
    at: '2026-08-01T09:10:11.000Z',
    kind: 'document_received',
    actor: 'owner',
    actor_id: 'owner-maya',
    actor_name: 'Maya Chen',
    density: 'owner',
    fields: { filename: 'invoice.pdf', source: 'client_portal' }
  });
  assert.equal(evidence.actorLabel, 'Maya Chen');
  assert.equal(evidence.headline, 'Evidence received: invoice.pdf.');
  assert.equal(evidence.detail, 'Received through client portal.');

  const imported = buildTimelineEventView({
    kind: 'transaction_imported',
    actor: 'donna',
    density: 'owner',
    fields: { source_filename: 'statement.csv', source: 'firm_upload' }
  });
  assert.equal(imported.actorLabel, 'Donna');
  assert.equal(imported.headline, 'Bank line imported from statement.csv.');
  assert.equal(imported.detail, 'Imported through firm upload.');
});

test('match event: duplicate receipt strings render once (the Land-lease sighting)', () => {
  // Writer persisted summary === reasoning and status === band === 'suggested';
  // the first render showed the sentence twice and two 'suggested' chips.
  const story = 'Exact amount 831.35 USD on the bill date. No other candidate competes.';
  const view = buildTimelineEventView({
    kind: 'match',
    density: 'owner',
    fields: { summary: story, reasoning: story, confidence: 0.94, authority: 'suggested', status: 'suggested' }
  });
  assert.equal(view.headline, story);
  assert.equal(view.detail, null);
  assert.deepEqual(view.chips, ['94% confidence', 'suggested']);
});

test('model-bearing events name their model in the chip row — the sole-model lab visibility rail', () => {
  // The model id is part of the receipt (CLAUDE.md): a coding or match
  // receipt that carries a model renders it as a chip, not only inside the
  // raw fields JSON — "which model did this" must be answerable at a glance.
  const coded = buildTimelineEventView({
    kind: 'coding_suggested',
    density: 'owner',
    fields: { proposed_account: 'Software subscriptions', confidence: 'high', model: 'qwen/qwen3.8-27b' }
  });
  assert.ok(coded.chips.includes('qwen/qwen3.8-27b'));
  const matched = buildTimelineEventView({
    kind: 'match',
    density: 'owner',
    fields: { summary: 's', confidence: 0.94, authority: 'suggested', model: 'qwen/qwen3.8-27b' }
  });
  assert.ok(matched.chips.includes('qwen/qwen3.8-27b'));
  // No model on the receipt ⇒ no chip (never a fabricated id).
  const bare = buildTimelineEventView({ kind: 'coding_suggested', density: 'owner', fields: { proposed_account: 'Rent' } });
  assert.ok(!bare.chips.some((c) => /qwen|gpt|claude/.test(String(c))));
});

test('coding_suggested renders as a suggestion, never as a completed coding', () => {
  // The 2026-08-25 SW Gas panel: "Coded to Utilities" over-claimed a
  // suggestion. A posting has its own receipt when it happens.
  const view = buildTimelineEventView({
    kind: 'coding_suggested',
    density: 'owner',
    fields: { proposed_account: 'Utilities', confidence: 'medium' }
  });
  assert.equal(view.headline, 'Suggested: Utilities');
});

test('cascade event: applied is prose, non-applied keeps its state and error class', () => {
  const applied = buildTimelineEventView({ kind: 'cascade', fields: { state: 'applied', attempts: 3 } });
  assert.equal(applied.headline, 'Settled in the books.');
  assert.equal(applied.detail, 'after 3 attempts');
  const failed = buildTimelineEventView({ kind: 'cascade', fields: { state: 'exhausted', error_class: 'coa_resolution' } });
  assert.equal(failed.headline, 'Settle exhausted');
  assert.equal(failed.detail, 'coa_resolution');
});

test('ask lifecycle: sent quotes the question, resolved names the auto-resolve receipt', () => {
  const sent = buildTimelineEventView({ kind: 'ask_sent', fields: { question: 'What was this for?', send_count: 2 } });
  assert.match(sent.headline, /Asked you: “What was this for\?”/);
  assert.deepEqual(sent.chips, ['sent 2×']);
  const auto = buildTimelineEventView({ kind: 'ask_resolved', fields: { auto_resolved_by_match: true, match_id: 'm1' } });
  assert.match(auto.headline, /the match answered it/);
  const manual = buildTimelineEventView({ kind: 'ask_resolved', fields: { auto_resolved_by_match: false, resolved_by: 'kari' } });
  assert.equal(manual.headline, 'Question closed.');
});

test('actor labels answer who: Donna for automation, a persisted human name, then an honest fallback', () => {
  assert.equal(labelForTimelineActor('system', { actorId: 'system' }), 'Donna');
  assert.equal(labelForTimelineActor('firm', { actorId: 'member-kari', actorName: 'Kari Salonen' }), 'Kari Salonen');
  assert.equal(labelForTimelineActor('client', { actorId: 'maya@example.com' }), 'maya@example.com');
  assert.equal(labelForTimelineActor('owner'), 'Owner · identity not recorded');
});

test('audit event: known actions get owner prose (prefix-matched), unknown render raw', () => {
  const known = buildTimelineEventView({ kind: 'audit', density: 'owner', fields: { action: 'client_rule.merchant_rule_saved' } });
  assert.match(known.headline, /merchant rule/);
  const sub = buildTimelineEventView({ kind: 'audit', density: 'owner', fields: { action: 'reconciliation.auto_explain.retry' } });
  assert.match(sub.headline, /Explained automatically/);
  const raw = buildTimelineEventView({ kind: 'audit', density: 'debug', fields: { action: 'transaction_review.waiting_released_after_settle', model: 'claude-opus-4-8' } });
  assert.equal(raw.headline, 'transaction_review.waiting_released_after_settle');
  assert.deepEqual(raw.chips, ['claude-opus-4-8']);
  const rejected = buildTimelineEventView({
    kind: 'audit',
    density: 'owner',
    fields: { action: 'reconciliation.reject_match', metadata: { reason: 'Wrong document' } }
  });
  assert.equal(rejected.headline, 'Match rejected.');
  assert.equal(rejected.detail, 'Wrong document');
});

test('ledger post + refusal receipts get owner words', () => {
  const posted = buildTimelineEventView({ kind: 'audit', density: 'owner', fields: { action: 'ledger.post_transaction' } });
  assert.equal(posted.headline, 'Posted to the ledger.');
  const refused = buildTimelineEventView({ kind: 'audit', density: 'debug', fields: { action: 'ledger.auto_post_refused' } });
  assert.match(refused.headline, /Ledger post refused/);
});

test('unknown kind renders its raw kind — drift surfaces, never hides', () => {
  const view = buildTimelineEventView({ kind: 'someday_kind', fields: {} });
  assert.equal(view.headline, 'someday_kind');
  assert.equal(view.density, 'debug');
});

test('actor labels: automation is Donna, unnamed humans expose the identity gap, unknown actors pass through', () => {
  assert.equal(labelForTimelineActor('donna'), 'Donna');
  assert.equal(labelForTimelineActor('owner'), 'Owner · identity not recorded');
  assert.equal(labelForTimelineActor(null), 'Donna');
  assert.equal(labelForTimelineActor('maya'), 'maya');
});

test('density filter: owner view hides debug events, debug view shows everything', () => {
  const views = [
    buildTimelineEventView({ kind: 'triage_evaluation', density: 'debug', fields: {} }),
    buildTimelineEventView({ kind: 'match', density: 'owner', fields: { summary: 's' } })
  ];
  assert.equal(visibleTimelineEvents(views).length, 1);
  assert.equal(visibleTimelineEvents(views)[0].kind, 'match');
  assert.equal(visibleTimelineEvents(views, { debug: true }).length, 2);
});

test('gaps label; unknown gap kinds stay visible', () => {
  assert.match(labelForTimelineGap({ kind: 'no_triage_receipt_for_match' }), /No triage receipt/);
  assert.match(labelForTimelineGap({ kind: 'empty_timeline' }), /No receipts recorded/);
  assert.equal(labelForTimelineGap({ kind: 'someday_gap' }), 'Missing receipt: someday_gap');
});

test('buildAuditTimelineView: absent block passes its reason through; present block maps all three parts', () => {
  assert.deepEqual(buildAuditTimelineView({ present: false, reason: 'timeline_focus_not_yet_supported' }), {
    present: false,
    reason: 'timeline_focus_not_yet_supported'
  });
  const view = buildAuditTimelineView({
    present: true,
    terminal: { present: true, state: 'auto_reconciled', reason: 'review_state:accepted' },
    events: [{ kind: 'match', density: 'owner', fields: { summary: 's' } }],
    gaps: [{ kind: 'empty_timeline' }]
  });
  assert.equal(view.present, true);
  assert.equal(view.terminal.tone, 'settled');
  assert.equal(view.events.length, 1);
  assert.match(view.gaps[0], /No receipts recorded/);
});

// ── Universal mentions (slice 3): the comment template ──────────────────────

test('comment events: verbatim detail, mention chips, redacted body suppressed, resolution note', () => {
  const view = buildTimelineEventView({
    at: '2026-08-27T10:00:00Z',
    kind: 'comment',
    actor: 'firm',
    actor_id: 'kari@books.example',
    actor_name: 'Kari',
    density: 'owner',
    fields: { kind: 'comment', text: '@Clara chase this one', flavor: 'ask', mentions: ['Clara'] },
    receipt_ref: { table: 'transaction_chat_messages', id: 'msg-1' }
  });
  assert.equal(view.headline, 'Comment');
  assert.equal(view.detail, '@Clara chase this one');
  assert.deepEqual(view.chips, ['ask', '@Clara']);

  const redacted = buildTimelineEventView({
    kind: 'comment',
    fields: { kind: 'comment', text: '[redacted]', content_redacted: true, mentions: [] }
  });
  assert.equal(redacted.headline, 'Comment (redacted).');
  assert.equal(redacted.detail, null);

  const resolved = buildTimelineEventView({
    kind: 'comment',
    fields: { kind: 'thread_resolution', outcome_note: 'director loan', policy_memory_candidate: true }
  });
  assert.equal(resolved.headline, 'Thread resolved.');
  assert.equal(resolved.detail, 'director loan');
  assert.deepEqual(resolved.chips, ['policy-memory candidate']);
});
