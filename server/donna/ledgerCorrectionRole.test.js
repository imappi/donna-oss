// H-1 regression — a correction/reversal of a SPLIT journal must carry the
// split legs' payload.role through to the correction's ledger_lines. The ALV
// return engine's control cross-check (alvReturn.js, D-FI3-S5) nets output /
// deductible sums on that role: a role-less reversal leaves the original leg
// counted but its reversal invisible (it falls into the unmarked-movement INFO
// lane instead), wedging the period in a permanent control_account_mismatch
// blocker no surface can clear.
//   node --test server/donna/ledgerCorrectionRole.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  __insertLedgerCorrectionJournal,
  __reverseLedgerLine
} from './firmDb.js';

// A posted split-sale journal's lines, as rowToLedgerLinePayload returns them
// (payload spread onto the line — role rides at top level).
const splitSaleLines = [
  {
    account_code: '1910', account_name: 'Pankkitili', account_type: 'bank', normal_balance: 'debit',
    tax_type: null, debit: 251, credit: 0, amount: 251, currency: 'EUR', memo: 'Myynti', role: 'bank'
  },
  {
    account_code: '3000', account_name: 'Myynti', account_type: 'revenue', normal_balance: 'credit',
    tax_type: 'ALV_25_5_OUTPUT', debit: 0, credit: 200, amount: 200, currency: 'EUR', memo: 'Myynti', role: 'counterparty'
  },
  {
    account_code: '2939', account_name: 'Suoritettava arvonlisävero', account_type: 'liability', normal_balance: 'credit',
    tax_type: 'NONE', debit: 0, credit: 51, amount: 51, currency: 'EUR', memo: 'Myynti', role: 'alv_output'
  }
];

test('reverseLedgerLine preserves the line role (incl. the ALV control legs)', () => {
  const reversed = splitSaleLines.map(__reverseLedgerLine);
  assert.deepEqual(reversed.map((line) => line.account.role), ['bank', 'counterparty', 'alv_output']);
  // Debit/credit flipped, code/tax_type kept.
  assert.equal(reversed[2].debit, 51);
  assert.equal(reversed[2].credit, 0);
  assert.equal(reversed[2].account.code, '2939');
  assert.equal(reversed[1].account.tax_type, 'ALV_25_5_OUTPUT');
  // A role read from payload (a line NOT flattened by the reader) also carries.
  const fromPayload = __reverseLedgerLine({
    account_code: '2940', account_name: 'Vähennettävä arvonlisävero', account_type: 'liability',
    debit: 25.5, credit: 0, amount: 25.5, currency: 'EUR', payload: { role: 'alv_input_deductible' }
  });
  assert.equal(fromPayload.account.role, 'alv_input_deductible');
  // Role-less legacy lines stay role-less — never an invented marker.
  const legacy = __reverseLedgerLine({
    account_code: '4400', account_name: 'Ulkopuoliset palvelut', account_type: 'expense',
    debit: 100, credit: 0, amount: 100, currency: 'EUR'
  });
  assert.equal(legacy.account.role, null);
});

test('insertLedgerCorrectionJournal persists role on the correction ledger_lines payload', async () => {
  const lineInserts = [];
  const fakeClient = {
    async query(sql, params = []) {
      if (sql.includes('as birth_created_at') || sql.includes('select id,code,name,account_type,normal_balance,canonical_role,status,currency,payload')
        || sql.includes('from audit_events where firm_id=$1 and resource_id=$2')
        // The readiness admission's flag read (the book is not enrolled).
        || sql.includes('from client_capability_config')) return { rows: [] };
      if (sql.includes('insert into ledger_accounts')) return { rows: [] };
      if (sql.includes('insert into ledger_journals')) return { rows: [] };
      if (sql.includes('insert into ledger_lines')) {
        lineInserts.push(params);
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
  await __insertLedgerCorrectionJournal({
    client: fakeClient,
    firmId: 'firm-1',
    clientId: 'client-1',
    sourceId: 'corr-1-reversal',
    journalDate: '2026-08-31',
    currency: 'EUR',
    memo: 'Correction reversal: Myynti',
    lines: splitSaleLines.map(__reverseLedgerLine),
    correctionType: 'reversal',
    correctionOfJournalId: 'jrnl-1',
    reversalOfJournalId: 'jrnl-1',
    correctionReason: 'recode',
    actorId: 'operator-1'
  });
  assert.equal(lineInserts.length, 3);
  // ledger_lines params: [5]=account_code, [13]=tax_type, [15]=payload JSON.
  const payloads = lineInserts.map((params) => JSON.parse(params[15]));
  assert.deepEqual(payloads.map((p) => p.role), ['bank', 'counterparty', 'alv_output']);
  const controlLeg = lineInserts[2];
  assert.equal(controlLeg[5], '2939');
  assert.equal(controlLeg[13], 'NONE');
  // The reversed control leg, read back the way the return engine reads lines
  // (payload spread onto the line), NETS against the original in the
  // cross-check: original credit 51 (+51 alv_output) + reversal debit 51 (−51).
  assert.equal(payloads[2].correction_of_journal_id, 'jrnl-1');
});
