import test from 'node:test';
import assert from 'node:assert/strict';
import { postGbOpeningBalanceJournalWithClient, postOpeningBalanceJournalWithClient } from './firmDb.js';

const lines = [
  { account: { code: 'B1', name: 'Bank', type: 'bank', normal_balance: 'debit', canonical_role: 'asset.cash' }, debit: 100, credit: 0 },
  { account: { code: 'E1', name: 'Retained earnings', type: 'equity', normal_balance: 'credit', canonical_role: 'equity.retained_earnings' }, debit: 0, credit: 100 }
];

const fakeClient = ({ jurisdiction = 'GB', incorporationDate = '2020-01-01', period = { id: 'fy-gb-1', label: '2026', starts_on: '2026-04-01', ends_on: '2027-03-31', status: 'open' }, existingLocked = false, targetLocked = false, flags = { GB_OPENING_BALANCES: 'canary' } } = {}) => {
  const writes = [];
  return {
    writes,
    async query(sql, params = []) {
      if (sql === 'select id from ledger_accounts where firm_id=$1 and client_id=$2 order by id for update') {
        assert.deepEqual(params, ['firm-1', 'client-1']);
        return { rows: [] };
      }
      // The mint's existing-row lookup (2026-11-10): an empty chart, so it mints.
      if (sql.startsWith('select id, code from ledger_accounts') || sql.startsWith('select 1 from ledger_accounts where firm_id=$1 and client_id=$2 and id=$3')) return { rows: [] };
      if (sql.includes('from client_capability_config')) return { rows: Object.entries(flags).map(([flag_key, stage]) => ({ flag_key, stage, source: 'test', client_id: 'client-1' })) };
      // Canonical lineage observes the same unmarked client and empty initial chart.
      if (sql.includes('as birth_created_at') && sql.includes('from clients')) return { rows: [{ id: params[1], firm_id: params[0], birth_created_at: null, jurisdiction, incorporation_date: incorporationDate }] };
      if (sql.includes('from audit_events where firm_id=$1 and resource_id=$2')) return { rows: [] };
      if (sql === 'select id,code,name,account_type,normal_balance,canonical_role,status,currency,payload\n    from ledger_accounts where firm_id=$1 and client_id=$2 order by id') return { rows: [] };
      if (sql.includes('select jurisdiction, entity_type, profile from clients')) return { rows: [{ jurisdiction, incorporation_date: incorporationDate }] };
      if (sql.includes('from cohort_capability_config')) return { rows: [] };
      if (sql.includes('select jurisdiction, incorporation_date')) return { rows: [{ jurisdiction, incorporation_date: incorporationDate }] };
      if (sql.includes('select incorporation_date, entity_type, jurisdiction')) return { rows: [{ jurisdiction, incorporation_date: incorporationDate, entity_type: 'fi-oy' }] };
      if (sql.includes('from fiscal_years') && sql.includes('for update')) return { rows: period ? [period] : [] };
      if (sql.includes('from ledger_journals lj')) return { rows: existingLocked ? [{ id: 'journal-1', close_period_id: 'lock-1' }] : [] };
      if (sql.includes('from close_periods')) return { rows: targetLocked ? [{ id: 'lock-2' }] : [] };
      if (/insert into (ledger_accounts|ledger_journals|ledger_lines|audit_events)/.test(sql)) {
        writes.push({ sql, params });
        if (sql.includes('ledger_journals')) return { rows: [{ id: 'journal-1' }] };
        if (sql.includes("'ledger.post_opening_balance'")) return { rows: [{ id: 'audit-opening-1' }] };
        return { rows: [] };
      }
      if (sql.includes('delete from ledger_lines')) { writes.push({ sql, params }); return { rows: [] }; }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
};

const callGb = (client, overrides = {}) => postGbOpeningBalanceJournalWithClient({ client, firmId: 'firm-1', clientId: 'client-1', asOf: '2026-04-01', openingLines: lines, actorId: 'owner-1', authorityBasis: { source: 'owner_confirmation' }, ...overrides });

test('GB adapter persists one market-tagged journal, its lines, and opening audit receipt', async () => {
  const client = fakeClient();
  const result = await callGb(client);
  assert.equal(result.journal_id, 'journal-1');
  assert.equal(result.audit_event_id, 'audit-opening-1');
  const journal = client.writes.find((write) => write.sql.includes('insert into ledger_journals'));
  assert.equal(journal.params[4], 'GB:fy-gb-1');
  assert.equal(client.writes.filter((write) => write.sql.includes('insert into ledger_lines')).length, 2);
  const audit = client.writes.find((write) => write.sql.includes("'ledger.post_opening_balance'"));
  assert.equal(audit.params[2], 'owner-1');
  assert.equal(JSON.parse(audit.params[4]).authority_basis.source, 'owner_confirmation');
});

test('jurisdiction, balanced-lines, greenfield, open-period and both lock guards refuse before a post', async () => {
  for (const [name, client, overrides, code] of [
    ['jurisdiction', fakeClient({ jurisdiction: 'FI' }), {}, 'GB_OPENING_BALANCE_JURISDICTION_REQUIRED'],
    ['balanced', fakeClient(), { openingLines: [lines[0]] }, 'OPENING_BALANCE_UNBALANCED'],
    ['greenfield', fakeClient({ incorporationDate: '2026-04-01' }), {}, 'OPENING_BALANCE_GREENFIELD_NO_SEED'],
    ['open period', fakeClient({ period: { id: 'fy', starts_on: '2026-04-01', ends_on: '2027-03-31', status: 'closed' } }), {}, 'GB_OPENING_BALANCE_OPEN_PERIOD_REQUIRED'],
    ['existing lock', fakeClient({ existingLocked: true }), {}, 'LEDGER_LOCKED_PERIOD_IMMUTABLE'],
    ['target lock', fakeClient({ targetLocked: true }), {}, 'LEDGER_LOCKED_PERIOD_IMMUTABLE']
  ]) {
    await assert.rejects(callGb(client, overrides), (error) => error.code === code, name);
    assert.equal(client.writes.some((write) => write.sql.includes('insert into ledger_journals')), false, `${name} reaches no journal call site`);
  }
});

test('FI and GB adapters reject the opposite persisted jurisdiction before journal construction', async () => {
  const gb = fakeClient({ jurisdiction: 'FI' });
  await assert.rejects(callGb(gb), (error) => error.code === 'GB_OPENING_BALANCE_JURISDICTION_REQUIRED');
  const fi = fakeClient({ jurisdiction: 'GB', flags: { FINLAND_OPENING_BALANCES: 'auto', FINLAND_TILIKAUSI: 'auto' } });
  await assert.rejects(postOpeningBalanceJournalWithClient({ client: fi, firmId: 'firm-1', clientId: 'client-1', asOf: '2026-01-01', openingLines: lines }), (error) => error.code === 'FINLAND_OPENING_BALANCE_JURISDICTION_REQUIRED');
  assert.equal(fi.writes.length, 0);
});

// The FI natural key. buildOpeningBalanceJournal produces the BARE tilikausi id
// (`ledger.js`: source_id = trim(fiscalYear.id)) and ledger.test.js pins it as
// "one avaava tase per year" — but that pins the BUILDER, and the writer now
// assigns journal.source_id after the builder returns. Nothing asserted the
// PERSISTED value, so market-tagging it to `FI:<id>` passed the whole suite while
// silently changing the idempotent upsert key AND the lookup behind the
// locked-period immutability check: a pre-existing opening journal would no longer
// be found, so the lock guard would not fire and a reseed would append a SECOND
// avaava tase instead of replacing the first. This test is the wire.
const fakeFiClient = ({ incorporationDate = '2020-01-01', fiscalYearId = 'fy-fi-1' } = {}) => {
  const writes = [];
  return {
    writes,
    async query(sql, params = []) {
      if (sql === 'select id from ledger_accounts where firm_id=$1 and client_id=$2 order by id for update') {
        assert.deepEqual(params, ['firm-1', 'client-1']);
        return { rows: [] };
      }
      if (sql.includes('from client_capability_config')) return { rows: [{ flag_key: 'FINLAND_OPENING_BALANCES', stage: 'auto', source: 'test', client_id: 'client-1' }, { flag_key: 'FINLAND_TILIKAUSI', stage: 'auto', source: 'test', client_id: 'client-1' }] };
      // Canonical lineage observes the same unmarked client and empty initial chart.
      if (sql.includes('as birth_created_at') && sql.includes('from clients')) return { rows: [{ id: params[1], firm_id: params[0], birth_created_at: null, jurisdiction: 'FI', incorporation_date: incorporationDate, entity_type: 'fi-toiminimi' }] };
      if (sql.includes('from audit_events where firm_id=$1 and resource_id=$2')) return { rows: [] };
      if (sql === 'select id,code,name,account_type,normal_balance,canonical_role,status,currency,payload\n    from ledger_accounts where firm_id=$1 and client_id=$2 order by id') return { rows: [] };
      if (sql.includes('select jurisdiction, entity_type,')) return { rows: [{ jurisdiction: 'FI', incorporation_date: incorporationDate, entity_type: 'fi-toiminimi' }] };
      if (sql.includes('from cohort_capability_config')) return { rows: [] };
      if (sql.includes('select incorporation_date, entity_type, jurisdiction')) return { rows: [{ jurisdiction: 'FI', incorporation_date: incorporationDate, entity_type: null }] };
      if (sql.includes('insert into fiscal_years')) { writes.push({ sql, params }); return { rows: [] }; }
      if (sql.includes('from fiscal_years')) return { rows: [{ id: fiscalYearId, label: '2026', starts_on: '2026-01-01', ends_on: '2026-12-31', status: 'open' }] };
      if (sql.includes('from ledger_journals lj')) return { rows: [] };
      if (sql.includes('from close_periods')) return { rows: [] };
      if (sql.startsWith('select id, code from ledger_accounts') || sql.startsWith('select 1 from ledger_accounts where firm_id=$1 and client_id=$2 and id=$3')) return { rows: [] };
      if (/insert into (ledger_accounts|ledger_journals|ledger_lines|audit_events)/.test(sql)) {
        writes.push({ sql, params });
        if (sql.includes('ledger_journals')) return { rows: [{ id: 'journal-fi-1' }] };
        if (sql.includes("'ledger.post_opening_balance'")) return { rows: [{ id: 'audit-fi-1' }] };
        return { rows: [] };
      }
      if (sql.includes('delete from ledger_lines')) { writes.push({ sql, params }); return { rows: [] }; }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
};

test('FI persists the BARE tilikausi id as source_id — never a market-tagged key', async () => {
  const client = fakeFiClient();
  await postOpeningBalanceJournalWithClient({ client, firmId: 'firm-1', clientId: 'client-1', asOf: '2026-06-01', openingLines: lines, actorId: 'owner-1' });
  const journal = client.writes.find((write) => write.sql.includes('insert into ledger_journals'));
  assert.equal(journal.params[4], 'fy-fi-1', 'FI source_id is the bare tilikausi id (one avaava tase per tilikausi)');
  assert.equal(journal.params[4].includes(':'), false, 'FI source_id carries no market tag — it is the idempotency + lock-lookup key');
});
