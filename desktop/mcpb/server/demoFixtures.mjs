// Donna MCPB shim — DEMO fixtures (docs/design-donna-mcp-surface.md §8 item
// 2; Kari's 2026-08-20 call: the demo lives in the shim as canned content).
//
// Purpose: a Claude directory browser installs the extension with NO Donna on
// the machine, asks "what's blocking the close?", and gets a real-feeling
// answer in thirty seconds — from a clearly labeled sample company, before
// connecting anything.
//
// THE THIN-SHIM RULE still holds: this file is CONTENT, not logic — the one
// sanctioned exception, recorded in the design doc. The fixtures mirror the
// REAL executor result shapes in server/donna/mcp/mcpReadSurface.js
// (demoFixtures.test.js pins the key parity), and demoResultFor() below is a
// static lookup + page slice, nothing more. No accounting, policy, or
// authorization decision is made here; the fixtures never mix with a live
// Donna answer (shimCore.mjs consults them ONLY when no endpoint file
// exists at all).
//
// HONESTY RULES (non-negotiable, pinned by tests):
//   - every demo response carries demo: true and a demo_notice naming the
//     data as fake and Donna as not running;
//   - the sample company is unmistakably labeled in its id and name;
//   - no custody slogans (the 2026-08-11 copy register — bridge-era copy
//     never claims books stay on the machine).

export const DEMO_ENTITY_ID = 'demo-harbor-lane';
export const DEMO_ENTITY_NAME = 'Harbor Lane Coffee Ltd (demo)';

export const DEMO_NOTICE =
  'DEMO DATA — nothing here is real. Donna is not running on this machine, '
  + 'so this answer comes from the bundled sample company, Harbor Lane Coffee '
  + 'Ltd. Install or open the Donna desktop app and expose a business under '
  + 'Settings → Claude access to see real books.';

// A July close, almost done: Donna cleared 126 items herself overnight; four
// items block the close — two waiting on the owner (a missing receipt and an
// unexplained transfer), one payout mismatch, one suspected duplicate bill.
const TOTALS = Object.freeze({
  auto_cleared: 126,
  confirmable: 3,
  operator_blocker: 2,
  client_info_needed: 2,
  blocks_close: 4
});

const GENERATED_AT = '2026-08-01T06:10:00.000Z';

// Shape: compactFeedItem in mcpReadSurface.js — keep the keys identical.
const ITEM_RECEIPT_MISSING = Object.freeze({
  kind: 'client_evidence_request',
  disposition: 'chase_receipt',
  blocks_close: true,
  entity_id: DEMO_ENTITY_ID,
  transaction_id: 'demo-txn-0143',
  document_id: null,
  date: '2026-07-18',
  amount: -184.2,
  currency: 'GBP',
  descriptor: 'AMZN MKTP UK*RT4527XQ',
  counterparty: 'Amazon Marketplace',
  reason: 'No receipt on file; Donna asked the owner what this purchase was and is waiting for the answer.'
});

const ITEM_UNEXPLAINED_TRANSFER = Object.freeze({
  kind: 'client_evidence_request',
  disposition: 'needs_human',
  blocks_close: true,
  entity_id: DEMO_ENTITY_ID,
  transaction_id: 'demo-txn-0151',
  document_id: null,
  date: '2026-07-24',
  amount: -950,
  currency: 'GBP',
  descriptor: 'FPS TRANSFER J HARTLEY',
  counterparty: 'J Hartley',
  reason: 'Bank transfer with no invoice or note; only the owner knows what it was for — asked 2026-07-31.'
});

const ITEM_PAYOUT_MISMATCH = Object.freeze({
  kind: 'transaction',
  disposition: 'needs_human',
  blocks_close: true,
  entity_id: DEMO_ENTITY_ID,
  transaction_id: 'demo-txn-0160',
  document_id: null,
  date: '2026-07-28',
  amount: 1912.44,
  currency: 'GBP',
  descriptor: 'STRIPE PAYOUT ST-K7Q2',
  counterparty: 'Stripe',
  reason: 'Payout is £26.10 short of the invoices it should settle; Donna suspects a fee line and wants the July fee report.'
});

const ITEM_DUPLICATE_BILL = Object.freeze({
  kind: 'document',
  disposition: 'needs_human',
  blocks_close: true,
  entity_id: DEMO_ENTITY_ID,
  transaction_id: null,
  document_id: 'demo-doc-0077',
  date: '2026-07-30',
  amount: -412.5,
  currency: 'GBP',
  descriptor: 'Fairfield Roasters invoice FR-2214',
  counterparty: 'Fairfield Roasters',
  reason: 'Looks like a duplicate of bill FR-2209, already matched and paid on 2026-07-12; held so it is not paid twice.'
});

const ITEMS_CONFIRMABLE = Object.freeze([
  Object.freeze({
    kind: 'transaction',
    disposition: 'auto_explain',
    blocks_close: false,
    entity_id: DEMO_ENTITY_ID,
    transaction_id: 'demo-txn-0139',
    document_id: null,
    date: '2026-07-15',
    amount: -12,
    currency: 'GBP',
    descriptor: 'NOTION LABS',
    counterparty: 'Notion',
    reason: 'Monthly software subscription, matches the standing rule; posting with the close.'
  }),
  Object.freeze({
    kind: 'transaction',
    disposition: 'auto_explain',
    blocks_close: false,
    entity_id: DEMO_ENTITY_ID,
    transaction_id: 'demo-txn-0147',
    document_id: null,
    date: '2026-07-21',
    amount: -46.8,
    currency: 'GBP',
    descriptor: 'TFL TRAVEL CH',
    counterparty: 'Transport for London',
    reason: 'Staff travel, consistent with prior months; posting with the close.'
  }),
  Object.freeze({
    kind: 'transaction',
    disposition: 'auto_explain',
    blocks_close: false,
    entity_id: DEMO_ENTITY_ID,
    transaction_id: 'demo-txn-0155',
    document_id: null,
    date: '2026-07-26',
    amount: -89,
    currency: 'GBP',
    descriptor: 'BRITISH GAS BUSINESS',
    counterparty: 'British Gas',
    reason: 'Utilities direct debit, matches the July bill; posting with the close.'
  })
]);

const BLOCKERS = Object.freeze([
  ITEM_RECEIPT_MISSING,
  ITEM_UNEXPLAINED_TRANSFER,
  ITEM_PAYOUT_MISMATCH,
  ITEM_DUPLICATE_BILL
]);

// Shape: runEntityList / runCloseStatus / runUnmatchedItems /
// runDocumentStatus / runAuditRecent results in mcpReadSurface.js.
export const DEMO_FIXTURES = Object.freeze({
  entity_list: Object.freeze({
    entities: [
      {
        id: DEMO_ENTITY_ID,
        name: DEMO_ENTITY_NAME,
        status: 'active',
        jurisdiction: 'GB',
        accounting_basis: 'accrual',
        close: TOTALS
      }
    ],
    count: 1
  }),
  close_status: Object.freeze({
    entity: { id: DEMO_ENTITY_ID, name: DEMO_ENTITY_NAME },
    totals: TOTALS,
    open_owner_asks: 2,
    blockers: BLOCKERS,
    blockers_truncated: false,
    generated_at: GENERATED_AT
  }),
  unmatched_items: Object.freeze({
    entity: { id: DEMO_ENTITY_ID, name: DEMO_ENTITY_NAME },
    items: Object.freeze([...BLOCKERS, ...ITEMS_CONFIRMABLE])
  }),
  document_status: Object.freeze({
    entities: [
      {
        entity: { id: DEMO_ENTITY_ID, name: DEMO_ENTITY_NAME },
        requests: [
          {
            id: 'demo-ask-0009',
            transaction_id: 'demo-txn-0143',
            evidence_type: 'receipt',
            question:
              'What was the £184.20 Amazon Marketplace purchase on 18 July? A receipt or a one-line answer is enough.',
            first_sent_at: '2026-07-29T08:00:00.000Z',
            last_sent_at: '2026-07-31T08:00:00.000Z',
            send_count: 2,
            due_at: '2026-08-05T00:00:00.000Z',
            created_at: '2026-07-29T07:55:00.000Z'
          },
          {
            id: 'demo-ask-0010',
            transaction_id: 'demo-txn-0151',
            evidence_type: 'explanation',
            question:
              'What was the £950.00 transfer to J Hartley on 24 July for? There is no invoice or note attached.',
            first_sent_at: '2026-07-31T08:00:00.000Z',
            last_sent_at: '2026-07-31T08:00:00.000Z',
            send_count: 1,
            due_at: '2026-08-07T00:00:00.000Z',
            created_at: '2026-07-31T07:55:00.000Z'
          }
        ]
      }
    ],
    open_requests: 2
  }),
  audit_recent: Object.freeze({
    events: Object.freeze([
      { entity_id: DEMO_ENTITY_ID, actor_type: 'system', actor_id: 'donna', action: 'reconciliation.auto_explain', resource_type: 'transaction', resource_id: 'demo-txn-0158', created_at: '2026-08-01T05:42:00.000Z' },
      { entity_id: DEMO_ENTITY_ID, actor_type: 'system', actor_id: 'donna', action: 'reconciliation.auto_explain', resource_type: 'transaction', resource_id: 'demo-txn-0157', created_at: '2026-08-01T05:41:00.000Z' },
      { entity_id: DEMO_ENTITY_ID, actor_type: 'system', actor_id: 'donna', action: 'document.parse.completed', resource_type: 'document', resource_id: 'demo-doc-0077', created_at: '2026-07-30T22:12:00.000Z' },
      { entity_id: DEMO_ENTITY_ID, actor_type: 'system', actor_id: 'donna', action: 'document.disposition.evaluated', resource_type: 'document', resource_id: 'demo-doc-0077', created_at: '2026-07-30T22:13:00.000Z' },
      { entity_id: DEMO_ENTITY_ID, actor_type: 'system', actor_id: 'donna', action: 'evidence_request.created', resource_type: 'client_evidence_request', resource_id: 'demo-ask-0010', created_at: '2026-07-31T07:55:00.000Z' },
      { entity_id: DEMO_ENTITY_ID, actor_type: 'system', actor_id: 'donna', action: 'ask_batch.send', resource_type: 'ask_batch', resource_id: 'demo-batch-0004', created_at: '2026-07-31T08:00:00.000Z' },
      { entity_id: DEMO_ENTITY_ID, actor_type: 'system', actor_id: 'donna', action: 'client_rule.merchant_rule_saved', resource_type: 'client_rule', resource_id: 'demo-rule-0021', created_at: '2026-07-28T09:30:00.000Z' },
      { entity_id: DEMO_ENTITY_ID, actor_type: 'system', actor_id: 'donna', action: 'reconciliation.auto_explain', resource_type: 'transaction', resource_id: 'demo-txn-0150', created_at: '2026-07-28T05:40:00.000Z' }
    ]),
    count: 8
  })
});

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

// Static lookup: fixture for the tool, entity-id checked, paginated where the
// real tool paginates, demo-labeled on every answer. Returns:
//   { result }            — the demo answer (always carries demo/demo_notice)
//   { notFound: true }    — entity_id given but not the demo entity
//   null                  — tool has no fixture (unknown tool)
export const demoResultFor = (toolName, args = {}) => {
  const fixture = DEMO_FIXTURES[toolName];
  if (!fixture) return null;
  if (args.entity_id && args.entity_id !== DEMO_ENTITY_ID) return { notFound: true };

  let result = fixture;
  if (toolName === 'unmatched_items') {
    const page = Math.max(1, Number.parseInt(args.page, 10) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(args.page_size, 10) || DEFAULT_PAGE_SIZE));
    const start = (page - 1) * pageSize;
    result = {
      entity: fixture.entity,
      total: fixture.items.length,
      page,
      page_size: pageSize,
      has_more: start + pageSize < fixture.items.length,
      items: fixture.items.slice(start, start + pageSize)
    };
  }
  return { result: { demo: true, demo_notice: DEMO_NOTICE, ...result } };
};
