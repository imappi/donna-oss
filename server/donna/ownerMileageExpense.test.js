import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOwnerMileageComputation, buildOwnerMileageJournal, pickMileageAccounts, recordOwnerMileageExpenseInDb } from './ownerMileageExpense.js';

const accounts = [
  { id: 'acc-mileage', code: '6105', name: 'Mileage and vehicle expense', account_type: 'expense', status: 'active' },
  { id: 'acc-owner', code: '2300', name: 'Due to owner', account_type: 'liability', status: 'active' }
];

test('buildOwnerMileageComputation routes US mileage to IRS table', () => {
  const out = buildOwnerMileageComputation({ jurisdiction: 'US', miles: 120, date: '2026-07-15' });
  assert.equal(out.status, 'computed');
  assert.equal(out.rate, 0.725);
  assert.equal(out.deduction, 87);
  assert.equal(out.currency, 'USD');
});

test('GB mileage uses single-homed AMAP tiers in GBP with unconfirmed provenance', () => {
  const out = buildOwnerMileageComputation({ jurisdiction: 'GB', miles: 12000, date: '2026-07-15' });
  assert.equal(out.status, 'computed');
  assert.equal(out.deduction, 5000);
  assert.equal(out.currency, 'GBP');
  assert.equal(out.firstMiles, 10000);
  assert.equal(out.overMiles, 2000);
  assert.match(out.source, /AMAP/);
  assert.equal(out.confirmedAgainstPrimary, false);
  assert.equal(buildOwnerMileageComputation({ jurisdiction: 'XX', miles: 1 }).reason, 'unsupported_jurisdiction');
});

test('buildOwnerMileageJournal refuses low confidence, missing chart accounts, and above-ceiling mileage instead of guessing', () => {
  const low = buildOwnerMileageJournal({ action: { miles: 120, purpose: 'conference', date: '2026-07-15', confidence: 'medium' }, clientProfile: { jurisdiction: 'US' }, accounts });
  assert.equal(low.status, 'proposed');
  assert.equal(low.reason, 'low_confidence');
  const noChart = buildOwnerMileageJournal({ action: { miles: 120, purpose: 'conference', date: '2026-07-15', confidence: 'high' }, clientProfile: { jurisdiction: 'US' }, accounts: [] });
  assert.equal(noChart.status, 'proposed');
  assert.equal(noChart.reason, 'chart_account_resolution_required');
  const material = buildOwnerMileageJournal({ action: { miles: 1000, purpose: 'multi-day field work', date: '2026-07-15', confidence: 'high' }, clientProfile: { jurisdiction: 'US' }, accounts });
  assert.equal(material.status, 'proposed');
  assert.equal(material.reason, 'above_materiality_ceiling');
  assert.equal(material.materiality_ceiling, 500);
});

test('buildOwnerMileageJournal creates a balanced owner-stated mileage journal from resolved chart accounts', () => {
  const picked = pickMileageAccounts(accounts);
  assert.equal(picked.expense.id, 'acc-mileage');
  assert.equal(picked.offset.id, 'acc-owner');
  const built = buildOwnerMileageJournal({ action: { miles: 120, purpose: 'Sacramento beekeeping conference', date: '2026-07-15', confidence: 'high' }, clientProfile: { jurisdiction: 'US', accounting_currency: 'USD' }, accounts, actorId: 'owner-1', sourceMessageId: 'tg-1', model: 'model-x' });
  assert.equal(built.status, 'ready');
  assert.equal(built.journal.amount, 87);
  assert.equal(built.journal.lines[0].debit, 87);
  assert.equal(built.journal.lines[1].credit, 87);
  assert.match(built.consequence, /computed at the current mileage rate/);
});

test('recordOwnerMileageExpenseInDb posts through injected named writer, audit, and apply receipt', async () => {
  const calls = [];
  const client = { query: async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('from clients')) return { rows: [{ id: 'client-1', jurisdiction: 'US', accounting_currency: 'USD' }] };
    if (sql.includes('from ledger_accounts')) return { rows: accounts };
    if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [] };
    if (sql.includes('insert into audit_events')) return { rows: [{ id: 'audit-1' }] };
    if (sql.includes('insert into apply_receipts')) return { rows: [] };
    return { rows: [] };
  } };
  const out = await recordOwnerMileageExpenseInDb({
    firmId: 'firm-1', clientId: 'client-1', actorId: 'owner-1', sourceMessageId: 'tg-1', model: 'model-x',
    action: { type: 'record_mileage', miles: 120, purpose: 'conference', date: '2026-07-15', confidence: 'high' },
    deps: { withFirmDbClient: async (fn) => fn(client), writeValidatedJournal: async () => ({ ledger_journal_id: 'journal-1', ledger_status: 'posted', ledger_line_count: 2, ledger_amount: 87, ledger_currency: 'USD' }) }
  });
  assert.equal(out.status, 'booked');
  assert.equal(out.ledger_journal_id, 'journal-1');
  assert.ok(calls.some((c) => c.sql.includes('insert into audit_events')));
  assert.ok(calls.some((c) => c.sql.includes('insert into apply_receipts')));
});

test('recordOwnerMileageExpenseInDb refuses a locked posting period before any ledger write', async () => {
  const calls = [];
  const client = { query: async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('from clients')) return { rows: [{ id: 'client-1', jurisdiction: 'US', profile: { currency: 'USD' } }] };
    if (sql.includes('from ledger_accounts')) return { rows: accounts };
    if (sql === 'begin' || sql === 'rollback') return { rows: [] };
    if (sql.includes('from ledger_journals j\n')) return { rows: [] };
    if (sql.includes('from ledger_journals lj')) return { rows: [] };
    if (sql.includes('from close_periods')) return { rows: [{ id: 'cp-1' }] };
    assert.fail(`unexpected query after locked-period refusal: ${sql}`);
  } };
  await assert.rejects(
    recordOwnerMileageExpenseInDb({
      firmId: 'firm-1', clientId: 'client-1', actorId: 'owner-1', sourceMessageId: 'tg-locked', model: 'model-x',
      action: { type: 'record_mileage', miles: 120, purpose: 'conference', date: '2026-07-15', confidence: 'high' },
      deps: { withFirmDbClient: async (fn) => fn(client) }
    }),
    (error) => error.code === 'LEDGER_ADJUSTMENT_DATE_LOCKED' && error.statusCode === 409
  );
  assert.ok(calls.some((c) => c.sql.includes('from close_periods')));
  assert.ok(calls.some((c) => c.sql === 'rollback'));
  assert.equal(calls.some((c) => c.sql.includes('insert into audit_events')), false);
  assert.equal(calls.some((c) => c.sql.includes('insert into apply_receipts')), false);
});

test('recordOwnerMileageExpenseInDb refuses reposting an owner-mileage journal already in a locked period', async () => {
  const calls = [];
  const client = { query: async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('from clients')) return { rows: [{ id: 'client-1', jurisdiction: 'US', profile: { currency: 'USD' } }] };
    if (sql.includes('from ledger_accounts')) return { rows: accounts };
    if (sql === 'begin' || sql === 'rollback') return { rows: [] };
    if (sql.includes('from ledger_journals j\n')) return { rows: [] };
    if (sql.includes('from ledger_journals lj')) return { rows: [{ id: 'journal-existing', close_period_id: 'cp-1' }] };
    assert.fail(`unexpected query after locked-existing refusal: ${sql}`);
  } };
  await assert.rejects(
    recordOwnerMileageExpenseInDb({
      firmId: 'firm-1', clientId: 'client-1', actorId: 'owner-1', sourceMessageId: 'tg-locked-existing', model: 'model-x',
      action: { type: 'record_mileage', miles: 120, purpose: 'conference', date: '2026-07-15', confidence: 'high' },
      deps: { withFirmDbClient: async (fn) => fn(client) }
    }),
    (error) => error.code === 'LEDGER_LOCKED_PERIOD_IMMUTABLE' && error.statusCode === 409
  );
  assert.ok(calls.some((c) => c.sql.includes('from ledger_journals lj')));
  assert.equal(calls.some((c) => c.sql.includes('from close_periods')), false);
  assert.equal(calls.some((c) => c.sql.includes('insert into audit_events')), false);
  assert.equal(calls.some((c) => c.sql.includes('insert into apply_receipts')), false);
});

test('a reversed or voided historical mileage claim cannot be booked again by replay', async () => {
  for (const existing of [{ status: 'voided' }, { status: 'posted', reversed_at: '2026-09-05T12:00:00Z' }]) {
    const client = { query: async (sql) => {
      if (['begin', 'commit', 'rollback'].includes(sql)) return { rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('from clients')) return { rows: [{ id: 'client', jurisdiction: 'us' }] };
      if (sql.includes('from ledger_journals j\n')) return { rows: [{ id: 'retained', ...existing }] };
      assert.fail(`replay must not reach accounts, audit or writes: ${sql}`);
    } };
    const result = await recordOwnerMileageExpenseInDb({ firmId: 'firm',clientId: 'client',sourceMessageId: 'original',action: {},
      deps: { withFirmDbClient: fn => fn(client),writeValidatedJournal: () => assert.fail('must preserve correction') } });
    assert.equal(result.status, 'preserved');
    assert.equal(result.reason, 'historical_mileage_corrected');
  }
});
