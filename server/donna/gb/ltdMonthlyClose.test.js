import assert from 'node:assert/strict';
import test from 'node:test';
import { CLOSE_DISPOSITIONS } from '../closeDisposition.js';
import {
  BLOCKER_ASSIGNEES,
  BLOCKER_SEVERITIES
} from '../statutoryBlocker.js';
import {
  getGbLtdMonthlyCloseFromDb
} from '../statutoryRegistry.js';
import {
  GB_LTD_CLOSE_BLOCKER_SURFACE,
  GB_LTD_CLOSE_ITEM_IDS,
  GB_LTD_CLOSE_REASON_CODES,
  GB_LTD_CLOSE_TERMINALS,
  GB_LTD_MONTHLY_CLOSE_FLAG_KEY,
  gbLtdMonthlyCloseEnabled,
  evaluateGbLtdMonthlyClose
} from './ltdMonthlyClose.js';

const settledSignals = () => Object.fromEntries([
  'bank_and_processor_controls', 'ar_ap_reconciliation', 'vat_control',
  'corporation_tax_control', 'payroll_control', 'director_and_related_party_balances',
  'fixed_assets', 'accruals_and_prepayments', 'equity_and_reserves',
  'unresolved_judgment_items'
].map((id) => [id, { status: 'settled' }]));

const base = () => ({
  accountingPeriodEnd: '2025-12-31',
  confirmationReviewPeriodEnd: '2026-06-30',
  vatStagger: 1,
  asOf: '2026-07-01',
  genericCloseItems: [{ id: 'generic-1', disposition: CLOSE_DISPOSITIONS.AUTO_CLEARED, blocks_close: false }],
  itemSignals: settledSignals(),
  balanceSheetSignals: {},
  completionEvidence: { confirmationStatementFiled: true }
});

test('a fully reconciled Ltd pack closes with only the two allowed terminals', () => {
  const out = evaluateGbLtdMonthlyClose(base());
  assert.equal(out.closed, true);
  assert.equal(out.items.length, GB_LTD_CLOSE_ITEM_IDS.length);
  assert.deepEqual(out.items.map((item) => item.id), GB_LTD_CLOSE_ITEM_IDS);
  assert.ok(out.items.every((item) => GB_LTD_CLOSE_TERMINALS.includes(item.terminal)));
  assert.equal(out.deadlines.ct600Due.due_date, '2026-12-31');
  assert.ok(out.items.every((item) => item.blocker_surface === null && item.reason_code === null && item.severity === null && item.blockerAssignee === null));
});

test('blocking coordinates use the statutory-blocker vocabulary and owner maps to client', () => {
  const input = base();
  input.genericCloseItems = [];
  input.itemSignals = {};
  const out = evaluateGbLtdMonthlyClose(input);
  for (const item of out.items) {
    if (item.terminal === 'settled') {
      assert.equal(item.blocker_surface, null);
      assert.equal(item.reason_code, null);
      assert.equal(item.severity, null);
      assert.equal(item.blockerAssignee, null);
      continue;
    }
    assert.equal(item.blocker_surface, GB_LTD_CLOSE_BLOCKER_SURFACE);
    assert.ok(GB_LTD_CLOSE_REASON_CODES.includes(item.reason_code));
    assert.ok(BLOCKER_SEVERITIES.includes(item.severity));
    assert.ok(BLOCKER_ASSIGNEES.includes(item.blockerAssignee));
    assert.equal(item.terminal, 'on_owner');
    assert.equal(item.blockerAssignee, 'client');
    assert.notEqual(item.blockerAssignee, 'owner');
  }
});

test('a folded VAT watch retains the target close item blocker coordinates', () => {
  const out = evaluateGbLtdMonthlyClose({ ...base(), balanceSheetSignals: { vatControlDifference: 10 } });
  const item = out.items.find(({ id }) => id === 'vat_control');
  assert.equal(item.reason_code, 'gb_ltd_vat_control_unreconciled');
  assert.equal(item.blocker_surface, GB_LTD_CLOSE_BLOCKER_SURFACE);
  assert.equal(item.blockerAssignee, 'client');
});

test('config-plane gate is born off and recognizes an auto snapshot', () => {
  assert.equal(GB_LTD_MONTHLY_CLOSE_FLAG_KEY, 'GB_LTD_MONTHLY_CLOSE');
  assert.equal(gbLtdMonthlyCloseEnabled({ env: {} }), false);
  assert.equal(gbLtdMonthlyCloseEnabled({ snapshot: { GB_LTD_MONTHLY_CLOSE: { stage: 'auto' } }, env: {} }), true);
});

test('absence never silently closes: every missing operational signal rests on the owner', () => {
  const input = base();
  input.genericCloseItems = [];
  input.itemSignals = {};
  const out = evaluateGbLtdMonthlyClose(input);
  assert.equal(out.terminal, 'blocked');
  assert.ok(out.onOwnerCount >= 11);
  assert.ok(out.items.filter((item) => item.terminal === 'on_owner').every((item) => item.assignedTo === 'owner'));
});

test('generic close blockers and balance-sheet watches override settled inputs', () => {
  const input = base();
  input.genericCloseItems = [{ id: 'x', disposition: CLOSE_DISPOSITIONS.OPERATOR_BLOCKER, blocks_close: true }];
  input.balanceSheetSignals = { vatControlDifference: 10, suspenseBalance: 4 };
  const out = evaluateGbLtdMonthlyClose(input);
  assert.deepEqual(out.blocking.filter((id) => ['generic_reconciliation', 'vat_control', 'unresolved_judgment_items'].includes(id)),
    ['generic_reconciliation', 'vat_control', 'unresolved_judgment_items']);
  assert.ok(out.items.filter((item) => out.blocking.includes(item.id)).every((item) => item.assignedTo === 'owner'));
});

test('overdue statutory windows block unless completion evidence is explicit', () => {
  const input = base();
  input.asOf = '2027-01-02';
  input.completionEvidence = {};
  const out = evaluateGbLtdMonthlyClose(input);
  assert.ok(out.blocking.includes('companies_house_accounts_window'));
  assert.ok(out.blocking.includes('confirmation_statement_window'));
  assert.ok(out.blocking.includes('ct600_window'));
  assert.ok(out.blocking.includes('corporation_tax_payment_window'));
});

test('asOf and VAT stagger are required facts, never inferred', () => {
  assert.throws(() => evaluateGbLtdMonthlyClose({ ...base(), asOf: null }), (error) => error.code === 'GB_LTD_CLOSE_AS_OF_NOT_ESTABLISHED');
  assert.throws(() => evaluateGbLtdMonthlyClose({ ...base(), vatStagger: null }), (error) => error.code === 'GB_LTD_VAT_STAGGER_NOT_ESTABLISHED');
});

// ── The firmDb consumer seam (UK audit ④ — the FI twin's mount pattern) ──────

const FIRM_ID = 'firm-1';
const CLIENT_ID = 'client-gb-ltd';

const makeDbHarness = ({
  entityType = 'gb-ltd',
  profile = { gb: { confirmation_review_period_end: '2026-06-30', vat_stagger: 1 } },
  flagRows = [{ flag_key: 'GB_LTD_MONTHLY_CLOSE', stage: 'auto', source: 'test', client_id: CLIENT_ID }],
  fiscalYears = [{ label: '2026', starts_on: '2026-01-01', ends_on: '2026-12-31' }],
  transactions = [],
  accountTypeRows = [],
  roleRows = [],
  convergenceState = 'auto_reconciled'
} = {}) => {
  const queried = [];
  const mints = [];
  const client = {
    query: async (sql, params = []) => {
      queried.push(String(sql));
      const text = String(sql);
      if (text.includes('select id from clients')) return { rows: [{ id: CLIENT_ID }] };
      if (text.includes('select jurisdiction, entity_type, incorporation_date, profile from clients')) {
        return { rows: [{ jurisdiction: 'GB', entity_type: entityType, incorporation_date: '2024-03-01', profile }] };
      }
      if (text.includes('select entity_type, incorporation_date, profile from clients')) {
        return { rows: [{ entity_type: entityType, incorporation_date: '2024-03-01', profile }] };
      }
      if (text.includes('client_capability_config')) return { rows: flagRows };
      if (text.includes('cohort_capability_config')) return { rows: [] };
      if (text.includes('from fiscal_years')) return { rows: fiscalYears };
      if (text.includes('from transactions')) return { rows: transactions };
      if (text.includes('la.account_type')) return { rows: accountTypeRows };
      if (text.includes('la.canonical_role')) return { rows: roleRows };
      if (text.includes('select * from statutory_blockers')) return { rows: [] };
      if (text.includes('insert into statutory_blockers')) {
        mints.push({ id: params[0], surface: params[4], reason_code: params[5], severity: params[6], assigned_to: params[7], entity_type: params[13] });
        return { rows: [{ id: params[0], inserted: true, status: 'open', maybe_reopened: false }] };
      }
      if (text.includes('insert into statutory_blocker_events')) return { rows: [] };
      throw new Error(`Unexpected query: ${text.slice(0, 80)}`);
    }
  };
  const run = (overrides = {}) => getGbLtdMonthlyCloseFromDb({
    firmId: FIRM_ID,
    clientId: CLIENT_ID,
    readAt: '2026-07-01',
    withFirmDbClientFn: async (fn) => fn(client),
    attachConvergenceFn: async ({ rows }) => {
      for (const row of rows) row.convergence_state = convergenceState;
    },
    ...overrides
  });
  return { run, queried, mints };
};

test('seam: a gb-ltd client receives the statutory verdict and only concrete blockers are minted', async () => {
  const { run, mints } = makeDbHarness({
    transactions: [{ id: 'tx-1', transaction_date: '2026-03-04' }],
    // Liabilities exceed assets: negative net assets fires the watch, which
    // folds into equity_and_reserves with evidence — the one concrete item.
    accountTypeRows: [
      { account_type: 'bank', net: '100' },
      { account_type: 'liability', net: '-250' }
    ]
  });
  const out = await run();
  assert.equal(out.close.terminal, 'blocked');
  assert.equal(out.close.deadlines.accountingPeriodEnd, '2026-12-31');
  assert.ok(out.close.deadlines.ct600Due.due_date);
  const equity = out.close.items.find(({ id }) => id === 'equity_and_reserves');
  assert.equal(equity.terminal, 'on_owner');
  assert.equal(equity.evidence.watchId, 'negative_net_assets');
  // The reconciled feed row keeps generic_reconciliation settled.
  assert.equal(out.close.items.find(({ id }) => id === 'generic_reconciliation').terminal, 'settled');
  // Absent-signal items rest on the owner but are NOT minted (coverage gaps,
  // not judgment items): exactly one durable blocker, the fired watch's.
  assert.equal(out.minted.length, 1);
  assert.equal(out.minted[0].item, 'equity_and_reserves');
  assert.deepEqual(mints.map((m) => ({ surface: m.surface, entity_type: m.entity_type, assigned_to: m.assigned_to })),
    [{ surface: GB_LTD_CLOSE_BLOCKER_SURFACE, entity_type: 'ltd', assigned_to: 'client' }]);
  assert.ok(out.close.items.filter((i) => i.terminal === 'on_owner' && i.evidence == null).length > 0);
});

test('seam: a hanging feed row blocks the generic item through the convergence projection and is minted', async () => {
  const { run } = makeDbHarness({
    transactions: [{ id: 'tx-hang', transaction_date: '2026-02-01' }],
    convergenceState: 'hanging'
  });
  const out = await run();
  const generic = out.close.items.find(({ id }) => id === 'generic_reconciliation');
  assert.equal(generic.terminal, 'on_owner');
  assert.deepEqual(generic.evidence, ['tx-hang']);
  assert.ok(out.minted.some((m) => m.item === 'generic_reconciliation'));
});

test('seam: flag darkness refuses AND the config query actually ran', async () => {
  const { run, queried } = makeDbHarness({ flagRows: [] });
  await assert.rejects(run(), (error) => error.code === 'GB_LTD_MONTHLY_CLOSE_DISABLED' && error.statusCode === 403);
  assert.ok(queried.some((sql) => sql.includes('client_capability_config')), 'flag-off must come from a real config read, not a silent mock default');
});

test('seam: a non-ltd entity is refused before any close work', async () => {
  const { run } = makeDbHarness({ entityType: 'fi-oy' });
  await assert.rejects(run(), (error) => error.code === 'GB_LTD_MONTHLY_CLOSE_ENTITY_NOT_LTD' && error.statusCode === 409);
});

test('seam: missing owner facts refuse with the named deadline code, never a guessed window', async () => {
  const { run } = makeDbHarness({ profile: {} });
  await assert.rejects(run(), (error) => error.code === 'GB_LTD_CONFIRMATION_REVIEW_END_NOT_ESTABLISHED');
});
