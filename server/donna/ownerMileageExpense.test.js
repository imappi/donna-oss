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

test('the booked line follows the owner language; English and the receipt wording stay byte-identical', () => {
  const action = { miles: 50, purpose: 'asiakaskäynti Tampereella', date: '2026-07-15', confidence: 'high' };
  const fi = buildOwnerMileageJournal({ action, clientProfile: { jurisdiction: 'FI' }, accounts, language: 'fi' });
  assert.equal(fi.status, 'ready');
  // A Finnish owner was sent the English line before this change.
  assert.equal(fi.ownerConsequence, 'Kirjasin 80,47 km (asiakaskäynti Tampereella): 44,26 EUR nykyisellä kilometrikorvauksella.');
  // The receipt's operator_words stay English whatever the owner reads.
  assert.equal(fi.consequence, 'Booked: 80.47 kms for asiakaskäynti Tampereella, EUR 44.26 computed at the current mileage rate.');
  const en = buildOwnerMileageJournal({ action, clientProfile: { jurisdiction: 'FI' }, accounts });
  assert.equal(en.ownerConsequence, en.consequence, 'English owner: the line is the historical one');
  const gb = buildOwnerMileageJournal({ action: { ...action, miles: 1, purpose: 'bank' }, clientProfile: { jurisdiction: 'GB' }, accounts });
  assert.equal(gb.ownerConsequence, 'Booked: 1 mile for bank, GBP 0.45 computed at the current mileage rate.');
  const gbFi = buildOwnerMileageJournal({ action: { ...action, miles: 1, purpose: 'pankki' }, clientProfile: { jurisdiction: 'GB' }, accounts, language: 'fi' });
  assert.equal(gbFi.ownerConsequence, 'Kirjasin 1 maili (pankki): 0,45 GBP nykyisellä mailikorvauksella.');
  // The journal itself does not depend on the language.
  assert.deepEqual(fi.journal, en.journal);
});

test('recordOwnerMileageExpenseInDb returns the owner-language line and keeps the receipt English', async () => {
  const receipts = [];
  const client = { query: async (sql, params = []) => {
    if (sql.includes('from clients')) return { rows: [{ id: 'client-1', jurisdiction: 'FI', profile: {} }] };
    if (sql.includes('from ledger_accounts')) return { rows: accounts };
    if (sql.includes('insert into audit_events')) return { rows: [{ id: 'audit-1' }] };
    if (sql.includes('insert into apply_receipts')) { receipts.push(params); return { rows: [] }; }
    return { rows: [] };
  } };
  const run = (language) => recordOwnerMileageExpenseInDb({
    firmId: 'firm-1', clientId: 'client-1', actorId: 'owner-1', sourceMessageId: `tg-${language}`, model: 'model-x', language,
    action: { type: 'record_mileage', miles: 50, purpose: 'asiakaskäynti', date: '2026-07-15', confidence: 'high' },
    deps: { withFirmDbClient: async (fn) => fn(client), writeValidatedJournal: async () => ({ ledger_journal_id: 'journal-1', ledger_status: 'posted', ledger_line_count: 2, ledger_amount: 44.26, ledger_currency: 'EUR' }) }
  });
  const fi = await run('fi');
  assert.equal(fi.consequence, 'Kirjasin 80,47 km (asiakaskäynti): 44,26 EUR nykyisellä kilometrikorvauksella.');
  const en = await run('en');
  assert.equal(en.consequence, 'Booked: 80.47 kms for asiakaskäynti, EUR 44.26 computed at the current mileage rate.');
  const operatorWords = receipts.map((params) => JSON.stringify(params)).map((raw) => raw.includes('Booked: 80.47 kms'));
  assert.deepEqual(operatorWords, [true, true], 'both receipts carry the English operator words');
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

// A repeated owner message (a replay) finds its retained journal. The owner is
// told the trip is already recorded, in their language, never sent an empty line.
const replayClient = (retained) => ({ query: async (sql) => {
  if (['begin', 'commit', 'rollback'].includes(sql)) return { rows: [] };
  if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
  if (sql.includes('from clients')) return { rows: [{ id: 'client', jurisdiction: 'fi' }] };
  if (sql.includes('from ledger_journals j\n')) return { rows: [retained] };
  assert.fail(`replay must not reach accounts, audit or writes: ${sql}`);
} });

test('a replayed mileage message tells the owner the trip is already recorded, in the owner language', async () => {
  const retained = { id: 'retained', status: 'posted', reversed_at: null, currency: 'EUR', amount: '44.26', payload: { computation: { km: 80.47, unit: 'km' } } };
  const replay = (language) => recordOwnerMileageExpenseInDb({ firmId: 'firm', clientId: 'client', sourceMessageId: 'tg-original', language,
    action: { type: 'record_mileage', miles: 50, purpose: 'asiakaskäynti', confidence: 'high' },
    deps: { withFirmDbClient: (fn) => fn(replayClient(retained)), writeValidatedJournal: () => assert.fail('a replay must not write') } });
  const fi = await replay('fi');
  assert.equal(fi.status, 'booked');
  assert.equal(fi.replay, true);
  assert.equal(fi.consequence, 'Tämä matka on jo kirjattu (44,26 EUR). En kirjannut sitä uudelleen.');
  const en = await replay('en');
  assert.equal(en.consequence, "That trip is already recorded (EUR 44.26). I haven't booked it again.");
  const noAmount = await recordOwnerMileageExpenseInDb({ firmId: 'firm', clientId: 'client', sourceMessageId: 'tg-original', language: 'fi', action: {},
    deps: { withFirmDbClient: (fn) => fn(replayClient({ id: 'retained', status: 'closed', reversed_at: null, currency: null, amount: null, payload: null })) } });
  assert.equal(noAmount.consequence, 'Tämä matka on jo kirjattu. En kirjannut sitä uudelleen.');
  assert.doesNotMatch(noAmount.consequence, /undefined|null|NaN/);
});
