// Nothing-silent at the chart plane: the posting-time mint-by-name path
// (upsertLedgerAccountForJournal — the union-menu ledger auto-creating its
// chart at posting time) must leave an audit receipt when it genuinely mints
// a NEW account, and stay quiet on the routine upsert of an existing row.
// Sibling of ensureLedgerAccountFromVerdict's created_from_verdict event;
// earned by the 2026-08-25 SW Gas panel (a brand-new "Utilities" account
// would have appeared in the chart with no receipt anywhere).

import assert from 'node:assert/strict';
import test from 'node:test';

import { upsertLedgerAccountForJournal } from './firmDb.js';

const makeMockClient = ({ inserted }) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      if (String(sql).includes('insert into ledger_accounts')) {
        return { rows: [{ inserted }] };
      }
      return { rows: [] };
    }
  };
};

test('a fresh mint at posting time writes the audit receipt in the same transaction', async () => {
  const client = makeMockClient({ inserted: true });
  const accountId = await upsertLedgerAccountForJournal({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    account: { name: 'Utilities', role: 'counterparty' },
    currency: 'USD'
  });
  assert.ok(accountId, 'mint returns the account id');
  const audit = client.calls.find((c) => c.sql.includes('insert into audit_events'));
  assert.ok(audit, 'the mint leaves an audit receipt');
  assert.equal(audit.params[2], accountId, 'receipt names the minted account');
  assert.ok(audit.sql.includes('ledger.account.created_at_posting'), 'receipt action names the posting mint');
  const metadata = JSON.parse(audit.params[3]);
  assert.equal(metadata.name, 'Utilities');
  assert.equal(metadata.source, 'journal_posting');
});

test('the routine upsert of an existing account stays quiet — no receipt spam', async () => {
  const client = makeMockClient({ inserted: false });
  await upsertLedgerAccountForJournal({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    account: { name: 'Utilities', role: 'counterparty' },
    currency: 'USD'
  });
  assert.ok(
    !client.calls.some((c) => c.sql.includes('insert into audit_events')),
    'an existing row upsert writes no audit event'
  );
});
