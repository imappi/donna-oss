// askBatchView — pins the staleness rule and the message-markdown mini
// parser behind the firm-side "Client asks" surface.
//
// Staleness mirrors the server's verdicts_as_of contract: any verdict
// movement (new suggestion or applied coding) after the draft's
// verdicts_as_of means the message describes books that have moved —
// the panel must warn "re-draft, don't send".

import assert from 'node:assert/strict';

import {
  askBatchCountsLabel,
  askBatchCoveredSpanLabel,
  askBatchStaleness,
  evidenceRequestListItem,
  latestVerdictMovementMs,
  openClientEvidenceRequests,
  parseAskMessageMarkdown,
  parseInlineSpans
} from './askBatchView.js';

let passed = 0;
let failed = 0;

const test = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${err?.stack || err?.message || err}`);
  }
};

console.log('askBatchView:');

// ── staleness ───────────────────────────────────────────────────────────

const DRAFT_AT = '2026-06-11T12:00:00.000Z';
const DRAFT_AT_MS = Date.parse(DRAFT_AT);

test('fresh: no verdict movement after verdicts_as_of → not stale', () => {
  const result = askBatchStaleness({
    batch: { verdicts_as_of: DRAFT_AT },
    transactions: [{ ai_suggestion: { suggested_at: DRAFT_AT_MS - 60_000 } }]
  });
  assert.equal(result.stale, false);
});

test('stale: a NEWER suggestion stamp flips the warning', () => {
  const result = askBatchStaleness({
    batch: { verdicts_as_of: DRAFT_AT },
    transactions: [{ ai_suggestion: { suggested_at: DRAFT_AT_MS + 60_000 } }]
  });
  assert.equal(result.stale, true);
});

test('stale: an applied coding after the draft counts as movement', () => {
  const result = askBatchStaleness({
    batch: { verdicts_as_of: DRAFT_AT },
    transactions: [
      { ai_suggestion: { suggested_at: DRAFT_AT_MS - 60_000 }, ai_suggestion_applied_at: DRAFT_AT_MS + 1 }
    ]
  });
  assert.equal(result.stale, true);
});

test('payload-nested keys are read when the row is not hoisted', () => {
  assert.equal(
    latestVerdictMovementMs([{ payload: { ai_suggestion: { suggested_at: 1781000000000 } } }]),
    1781000000000
  );
});

test('ISO-string stamps coerce alongside epoch-ms stamps', () => {
  const iso = '2026-06-11T13:00:00.000Z';
  assert.equal(latestVerdictMovementMs([{ ai_suggestion: { suggested_at: iso } }]), Date.parse(iso));
});

test('no batch / no verdicts_as_of → never stale (nothing to compare)', () => {
  assert.equal(askBatchStaleness({ batch: null, transactions: [{ ai_suggestion_applied_at: 1 }] }).stale, false);
  assert.equal(askBatchStaleness({ batch: {}, transactions: [{ ai_suggestion_applied_at: 1 }] }).stale, false);
});

test('waiting lane lists only persisted open requests, newest sent first', () => {
  const requests = [
    { id: 'draft', status: 'draft', created_at: '2026-08-28T08:00:00Z' },
    { id: 'older-open', status: 'open', first_sent_at: '2026-08-27T08:00:00Z' },
    { id: 'replied', status: 'replied', first_sent_at: '2026-08-28T10:00:00Z' },
    { id: 'newer-open', status: 'OPEN', first_sent_at: '2026-08-28T09:00:00Z' },
    { id: 'resolved', status: 'resolved', first_sent_at: '2026-08-28T11:00:00Z' }
  ];
  assert.deepEqual(
    openClientEvidenceRequests(requests).map((request) => request.id),
    ['newer-open', 'older-open']
  );
  assert.deepEqual(openClientEvidenceRequests(null), []);
});

test('waiting-row fallback preserves the persisted Material artifact anchors', () => {
  const item = evidenceRequestListItem({
    request: {
      id: 'ask-1',
      client_id: 'client-1',
      status: 'open',
      transaction_id: 'tx-1',
      question: 'What was this payment for?',
      request_payload: { document_id: 'doc-1' },
      first_sent_at: '2026-08-28T10:00:00Z'
    },
    transaction: {
      id: 'tx-1',
      client_id: 'client-1',
      transaction_date: '2026-06-13',
      description: 'CHECKING · 1587782',
      money_in: 0,
      money_out: 1292.57,
      currency: 'USD'
    }
  });
  assert.equal(item.source_id, 'ask-1');
  assert.equal(item.transaction_id, 'tx-1');
  assert.equal(item.document_id, 'doc-1');
  assert.equal(item.descriptor, 'CHECKING · 1587782');
  assert.equal(item.amount, -1292.57);
  assert.equal(item.verdict.disposition, 'client_info_needed');
});

// ── markdown mini parser ────────────────────────────────────────────────

test('headings, numbered items, bullets, and paragraphs parse to blocks', () => {
  const blocks = parseAskMessageMarkdown(
    'Hi team — quick update.\n\n## Questions we need answered\n1. **2025-07-24 — $533.80** — `AMEX EPAYMENT`\n\n## Statements to send over\n- **Checking 1587782...**\n'
  );
  assert.deepEqual(
    blocks.map((block) => block.type),
    ['paragraph', 'heading', 'numbered', 'heading', 'bullet']
  );
  assert.equal(blocks[2].marker, '1');
});

test('bold and inline-code spans split correctly', () => {
  const spans = parseInlineSpans('Confirm **the treatment** for `AMEX EPAYMENT ACH 123` today.');
  assert.deepEqual(spans, [
    { text: 'Confirm ', bold: false, code: false },
    { text: 'the treatment', bold: true, code: false },
    { text: ' for ', bold: false, code: false },
    { text: 'AMEX EPAYMENT ACH 123', bold: false, code: true },
    { text: ' today.', bold: false, code: false }
  ]);
});

test('plain text yields a single span; empty input yields none', () => {
  assert.deepEqual(parseInlineSpans('plain'), [{ text: 'plain', bold: false, code: false }]);
  assert.deepEqual(parseInlineSpans(''), []);
});

test('indented FYI sub-bullets are marked nested', () => {
  const blocks = parseAskMessageMarkdown('- We recorded **3 owner draws**:\n  - 2025-06-18 — $3,339.14\n');
  assert.equal(blocks[0].nested, false);
  assert.equal(blocks[1].nested, true);
});

// ── counts label ────────────────────────────────────────────────────────

test('counts label reads like the draft summary strip', () => {
  assert.equal(
    askBatchCountsLabel({ ask: 3, notify: 1, skip: 0, statement_requests: 6 }),
    '3 questions · 6 statement requests · 1 FYI'
  );
  assert.equal(askBatchCountsLabel({ ask: 1 }), '1 question');
  assert.equal(askBatchCountsLabel({}), 'Nothing to ask');
});

// ── covered span ────────────────────────────────────────────────────────
//
// The draft row's date slot carries the ledger months the message covers,
// never the drafted-at wall clock (2026-09-01: auto-refresh makes
// created_at always "today", which read as fresh September data on a
// June/July book).

test('covered span labels the ledger months of the draft items, not created_at', () => {
  const batch = {
    created_at: '2026-09-01T12:20:00.000Z',
    draft: {
      items: [
        { transaction_id: 'tx-jun', disposition: 'ask' },
        { transaction_id: 'tx-jul', disposition: 'notify' }
      ]
    }
  };
  const transactions = [
    { id: 'tx-jun', date: '2025-06-30' },
    { id: 'tx-jul', transaction_date: '2025-07-16' }
  ];
  assert.equal(askBatchCoveredSpanLabel({ batch, transactions }), 'Jun–Jul');
  assert.equal(
    askBatchCoveredSpanLabel({ batch, transactions: [transactions[0]] }),
    'Jun',
    'unresolvable items are skipped; a single covered month renders alone'
  );
});

test('covered span is null when nothing resolves — the caller dashes, never fabricates', () => {
  assert.equal(askBatchCoveredSpanLabel({ batch: null, transactions: [] }), null);
  assert.equal(
    askBatchCoveredSpanLabel({
      batch: { draft: { items: [{ transaction_id: 'missing' }] } },
      transactions: []
    }),
    null
  );
});

console.log(`askBatchView: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
