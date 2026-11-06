// FI-13 13.3A PR3 — the Oy monthly-close checklist + terminal state (D-FI13-15).
// node --test server/donna/finland/oyMonthlyClose.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FINLAND_OY_MONTHLY_CLOSE_FLAG_KEY,
  OY_CLOSE_ITEM_TERMINALS,
  OY_CLOSE_ASSIGNEES,
  OY_CLOSE_CHECKLIST_ITEM_IDS,
  OY_CLOSE_BLOCKER_SURFACE,
  buildOyCloseReasonCode,
  evaluateOyMonthlyClose
} from './oyMonthlyClose.js';
import {
  getFinlandOyMonthlyCloseFromDb
} from '../statutoryRegistry.js';

const AT = '2026-07-12';
const STORE_ASSIGNEES = new Set(['firm', 'client', 'accountant', 'auditor', 'counsel']);

test('pins: flag key, the two terminals, the store-valid assignees, the closed 15-item catalog', () => {
  assert.equal(FINLAND_OY_MONTHLY_CLOSE_FLAG_KEY, 'FINLAND_OY_MONTHLY_CLOSE');
  assert.deepEqual([...OY_CLOSE_ITEM_TERMINALS], ['settled', 'on_human']);
  assert.deepEqual([...OY_CLOSE_ASSIGNEES], ['firm', 'accountant', 'counsel']);
  // The close names only store-valid assignees (no 'reviewer' — the store lacks it).
  assert.ok(OY_CLOSE_ASSIGNEES.every((a) => STORE_ASSIGNEES.has(a)));
  assert.equal(OY_CLOSE_CHECKLIST_ITEM_IDS.length, 15);
  assert.deepEqual([...OY_CLOSE_CHECKLIST_ITEM_IDS], [
    'bank_processor_reconciliation', 'ar_ap_reconciliation', 'alv_reconciliation',
    'payroll_journal_import', 'reimbursements', 'loan_principal_interest',
    'accruals_prepayments', 'fixed_assets_depreciation', 'tax_prepayments',
    'shareholder_related_party_balances', 'equity_roll_forward', 'negative_equity_check',
    'governance_evidence', 'period_locks', 'unresolved_judgment_items'
  ]);
  assert.equal(OY_CLOSE_BLOCKER_SURFACE, 'finland_oy_monthly_close');
  assert.equal(buildOyCloseReasonCode('negative_equity_check'), 'oy_close.negative_equity_check');
});

test('two-terminal-states: absence is NEVER settled — an empty close is fully blocked on named humans, never closed', () => {
  const out = evaluateOyMonthlyClose({});
  assert.equal(out.terminal, 'blocked');
  assert.equal(out.closed, false);
  assert.equal(out.on_human_count, 15);
  assert.equal(out.settled_count, 0);
  // Every item is one of exactly the two terminals — no third state at rest.
  for (const item of out.items) {
    assert.ok(OY_CLOSE_ITEM_TERMINALS.includes(item.terminal));
    if (item.terminal === 'on_human') {
      assert.equal(item.reason, 'pending_upstream');
      assert.ok(STORE_ASSIGNEES.has(item.assigned_to));
      assert.ok(item.blocker_directive);
    }
  }
  assert.doesNotThrow(() => evaluateOyMonthlyClose({ itemSignals: null, watches: 'nope', ownerTransactions: 5, openBlockers: {} }));
});

test('all items settled ⇒ the close reaches the closed terminal', () => {
  const itemSignals = {};
  for (const id of OY_CLOSE_CHECKLIST_ITEM_IDS) itemSignals[id] = { status: 'settled', reason: 'reconciled' };
  const out = evaluateOyMonthlyClose({ itemSignals, asOf: AT });
  assert.equal(out.terminal, 'closed');
  assert.equal(out.closed, true);
  assert.equal(out.settled_count, 15);
  assert.equal(out.on_human_count, 0);
  assert.deepEqual(out.blocking, []);
  assert.deepEqual(out.assigned_to, {});
  // A settled item carries no assignee/severity/directive.
  const settled = out.items.find((i) => i.id === 'ar_ap_reconciliation');
  assert.equal(settled.terminal, 'settled');
  assert.equal(settled.assigned_to, null);
  assert.equal(settled.blocker_directive, null);
});

test('a fired balance-sheet watch OVERRIDES a settled signal — a detection verdict cannot be closed away', () => {
  const itemSignals = {};
  for (const id of OY_CLOSE_CHECKLIST_ITEM_IDS) itemSignals[id] = { status: 'settled' };
  const out = evaluateOyMonthlyClose({
    itemSignals,
    watches: { watches: [{ id: 'negative_equity', severity: 'legal_duty', assigned_to: 'firm' }] },
    asOf: AT
  });
  assert.equal(out.terminal, 'blocked');
  const neg = out.items.find((i) => i.id === 'negative_equity_check');
  assert.equal(neg.terminal, 'on_human');
  assert.equal(neg.assigned_to, 'firm');
  // 'legal_duty' is normalized to the store's 'legal_violation'.
  assert.equal(neg.severity, 'legal_violation');
  assert.equal(neg.reason, 'watch:negative_equity');
  assert.equal(neg.blocker_directive.reason_code, 'oy_close.negative_equity_check');
  assert.equal(neg.blocker_directive.severity, 'legal_violation');
});

test("a PR2 watch's 'reviewer' assignee is normalized to the store's 'accountant' when folded", () => {
  const out = evaluateOyMonthlyClose({
    watches: { watches: [{ id: 'unsupported_shareholder_debit', severity: 'review_required', assigned_to: 'reviewer' }] }
  });
  const sh = out.items.find((i) => i.id === 'shareholder_related_party_balances');
  assert.equal(sh.assigned_to, 'accountant');
  assert.equal(sh.blocker_directive.assigned_to, 'accountant');
  assert.ok(STORE_ASSIGNEES.has(sh.assigned_to));
});

test('overdue statutory liabilities split by kind onto the item that owns each', () => {
  const out = evaluateOyMonthlyClose({
    watches: { watches: [{
      id: 'overdue_statutory_liability', severity: 'review_required', assigned_to: 'accountant',
      evidence: { overdue: [{ kind: 'vat' }, { kind: 'employer_contribution' }, { kind: 'corporate_tax' }] }
    }] }
  });
  assert.equal(out.items.find((i) => i.id === 'alv_reconciliation').terminal, 'on_human');
  assert.equal(out.items.find((i) => i.id === 'payroll_journal_import').terminal, 'on_human');
  assert.equal(out.items.find((i) => i.id === 'tax_prepayments').terminal, 'on_human');
});

test('an ESCALATING owner transaction blocks its mapped item; a PROPOSAL does not hold the close', () => {
  const escalate = evaluateOyMonthlyClose({
    ownerTransactions: [{ terminal: 'escalate', type: 'dividend', reason: 'dividend_detect_and_escalate', missing_evidence: ['distribution_decision'] }]
  });
  const equity = escalate.items.find((i) => i.id === 'equity_roll_forward');
  assert.equal(equity.terminal, 'on_human');
  assert.ok(equity.reason.startsWith('owner_tx:dividend'));

  // A proposal-terminal owner tx over an otherwise-settled book does NOT block.
  const itemSignals = {};
  for (const id of OY_CLOSE_CHECKLIST_ITEM_IDS) itemSignals[id] = { status: 'settled' };
  const proposal = evaluateOyMonthlyClose({
    itemSignals,
    ownerTransactions: [{ terminal: 'proposal', type: 'expense_reimbursement' }]
  });
  assert.equal(proposal.terminal, 'closed');
});

test('an owner-transaction escalation maps a shareholder loan to the loan item and unknown to the catch-all', () => {
  const out = evaluateOyMonthlyClose({
    ownerTransactions: [
      { terminal: 'escalate', type: 'shareholder_loan_to_owner', reason: 'shareholder_loan_out_requires_review' },
      { terminal: 'escalate', type: 'unknown_owner_transfer', reason: 'owner_transfer_unresolved' }
    ]
  });
  assert.equal(out.items.find((i) => i.id === 'loan_principal_interest').terminal, 'on_human');
  const catchAll = out.items.find((i) => i.id === 'unresolved_judgment_items');
  assert.equal(catchAll.terminal, 'on_human');
  assert.ok(catchAll.reason.startsWith('owner_tx:unknown_owner_transfer'));
});

test('an open blocker on a close item keeps that item on_human; a blocker ELSEWHERE feeds the catch-all', () => {
  const itemSignals = {};
  for (const id of OY_CLOSE_CHECKLIST_ITEM_IDS) itemSignals[id] = { status: 'settled' };
  const out = evaluateOyMonthlyClose({
    itemSignals,
    openBlockers: [
      { id: 'b-close', reason_code: buildOyCloseReasonCode('alv_reconciliation'), severity: 'review_required', assigned_to: 'accountant', status: 'open' },
      { id: 'b-else', reason_code: 'incomplete_oy_cutover_document_set', severity: 'review_required', assigned_to: 'accountant', status: 'open' },
      { id: 'b-done', reason_code: 'anything', severity: 'review_required', assigned_to: 'firm', status: 'resolved' } // resolved ⇒ ignored
    ]
  });
  assert.equal(out.terminal, 'blocked');
  assert.equal(out.items.find((i) => i.id === 'alv_reconciliation').terminal, 'on_human');
  const catchAll = out.items.find((i) => i.id === 'unresolved_judgment_items');
  assert.equal(catchAll.terminal, 'on_human');
  assert.equal(catchAll.reason, 'open_blocker_elsewhere');
  // The resolved blocker did not resurrect the catch-all beyond the one open elsewhere.
  assert.ok(catchAll.evidence.some((e) => e.blocker_id === 'b-else'));
});

test('assigned_to groups the open close by named human; every named human is store-valid', () => {
  const out = evaluateOyMonthlyClose({
    watches: { watches: [{ id: 'negative_equity', severity: 'legal_duty', assigned_to: 'firm' }] }
  });
  for (const human of Object.keys(out.assigned_to)) assert.ok(STORE_ASSIGNEES.has(human));
  assert.ok(out.assigned_to.firm.includes('negative_equity_check'));
  assert.equal(out.confirmedAgainstPrimary, false);
});

// ---- DB caller ---------------------------------------------------------------

const fakeClient = ({ entityType = 'fi-oy', flags = {}, balances = [], calendarNet = 0, registry = null, extent = {}, blockers = [] } = {}) => {
  const minted = [];
  const events = [];
  return {
    minted, events,
    async query(sql, params) {
      if (sql.includes('select id from clients')) return { rows: [{ id: 'client-1' }] };
      if (sql.includes('entity_type') && sql.includes('from clients')) return { rows: [{ entity_type: entityType, profile: null }] };
      if (sql.includes('from client_capability_config')) {
        return { rows: Object.entries(flags).map(([flag_key, stage]) => ({ flag_key, stage, source: 'test', client_id: 'client-1' })) };
      }
      if (sql.includes('from cohort_capability_config')) return { rows: [] };
      if (sql.includes('from fiscal_years')) return { rows: registry ? [registry] : [] };
      if (sql.includes('from ledger_journals') && sql.includes('max(journal_date)')) return { rows: [{ min_date: extent.min || null, max_date: extent.max || null }] };
      if (sql.includes('from ledger_lines') && sql.includes('group by la.code')) return { rows: balances };
      if (sql.includes('from ledger_lines')) return { rows: [{ net: calendarNet }] };
      if (sql.includes('from statutory_blockers')) return { rows: blockers };
      if (sql.includes('insert into statutory_blockers')) {
        minted.push({ id: params[0], reason_code: params[5], severity: params[6], assigned_to: params[7] });
        return { rows: [{ id: params[0], inserted: true, status: 'open', maybe_reopened: false }] };
      }
      if (sql.includes('insert into statutory_blocker_events')) { events.push({ type: params[3] }); return { rows: [] }; }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
};

const callClose = (opts, args = {}) => {
  const client = fakeClient(opts);
  return getFinlandOyMonthlyCloseFromDb({
    firmId: 'firm-1', clientId: 'client-1', readAt: '2026-07-12T00:00:00.000Z', ...args,
    withFirmDbClientFn: async (fn) => fn(client)
  }).then((res) => ({ res, client }));
};

test('DB caller: a non-oy client is refused (409); a dark flag is a typed 403', async () => {
  await assert.rejects(
    callClose({ entityType: 'fi-toiminimi', flags: { FINLAND_OY_MONTHLY_CLOSE: 'canary' } }),
    (e) => e.statusCode === 409 && e.code === 'FINLAND_OY_MONTHLY_CLOSE_ENTITY_NOT_OY'
  );
  await assert.rejects(
    callClose({ entityType: 'fi-oy', flags: {} }),
    (e) => e.statusCode === 403 && e.code === 'FINLAND_OY_MONTHLY_CLOSE_DISABLED'
  );
});

test('DB caller: a fired watch drives its close item to a durable minted blocker; pending_upstream items are NOT minted', async () => {
  const { res, client } = await callClose({
    entityType: 'fi-oy',
    flags: { FINLAND_OY_MONTHLY_CLOSE: 'canary' },
    // 2000 share capital net +12000 (debit) ⇒ equity value −12000 (negative equity fires).
    balances: [{ code: '2000', net: '12000', min_date: '2026-01-01' }],
    registry: { starts_on: '2026-01-01', ends_on: '2026-12-31' },
    extent: { min: '2026-01-01', max: '2026-06-30' }
  });
  assert.equal(res.close.terminal, 'blocked');
  // negative_equity_check is minted (concrete detection); it is on the firm as legal_violation.
  const negMint = client.minted.find((m) => m.reason_code === 'oy_close.negative_equity_check');
  assert.ok(negMint, 'negative-equity blocker minted');
  assert.equal(negMint.severity, 'legal_violation');
  assert.equal(negMint.assigned_to, 'firm');
  // pending_upstream items (e.g. bank recon, no signal) are surfaced but not minted.
  assert.equal(client.minted.some((m) => m.reason_code === 'oy_close.bank_processor_reconciliation'), false);
  assert.ok(res.minted.some((m) => m.item === 'negative_equity_check'));
  // Every minted blocker carries a store-valid assignee.
  for (const m of client.minted) assert.ok(STORE_ASSIGNEES.has(m.assigned_to));
  assert.equal(res.provenance.persisted, true);
});

test('DB caller: persist=false computes the verdict without minting anything', async () => {
  const { res, client } = await callClose(
    {
      entityType: 'fi-oy',
      flags: { FINLAND_OY_MONTHLY_CLOSE: 'canary' },
      balances: [{ code: '2000', net: '12000', min_date: '2026-01-01' }],
      registry: { starts_on: '2026-01-01', ends_on: '2026-12-31' },
      extent: { min: '2026-01-01', max: '2026-06-30' }
    },
    { persist: false }
  );
  assert.equal(res.close.terminal, 'blocked');
  assert.equal(client.minted.length, 0);
  assert.deepEqual(res.minted, []);
  assert.equal(res.provenance.persisted, false);
});

test('DB caller: an open blocker elsewhere on the client surfaces in the close via the catch-all', async () => {
  const { res } = await callClose({
    entityType: 'fi-oy',
    flags: { FINLAND_OY_MONTHLY_CLOSE: 'canary' },
    balances: [],
    registry: { starts_on: '2026-01-01', ends_on: '2026-12-31' },
    extent: { min: '2026-01-01', max: '2026-06-30' },
    blockers: [{ id: 'stat-blocker-x', surface: 'finland_annual_return', reason_code: 'entity_unsupported_annual_return', severity: 'legal_violation', assigned_to: 'firm', status: 'open' }]
  });
  const catchAll = res.close.items.find((i) => i.id === 'unresolved_judgment_items');
  assert.equal(catchAll.terminal, 'on_human');
  assert.ok(res.open_blockers.some((b) => b.id === 'stat-blocker-x'));
});
