import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TILIKARTTA,
  STATUTORY_GROUPS,
  STATUTORY_GROUP_KEYS,
  TOIMINIMI_EQUITY_ACCOUNTS,
  OY_EQUITY_ACCOUNTS,
  OY_ONLY_STATUTORY_GROUPS,
  ALV_ACCOUNT_CODES,
  buildToiminimiChart,
  buildOyChart,
  resolveAccount,
  resolveStatutoryGroup
} from './tilikartta.js';

test('every entry has a unique account code', () => {
  const codes = TILIKARTTA.map((e) => e.code);
  assert.equal(new Set(codes).size, codes.length, 'duplicate account code(s) in tilikartta');
});

test('every entry has a valid normal_balance', () => {
  for (const e of TILIKARTTA) {
    assert.ok(['debit', 'credit'].includes(e.normal_balance), `${e.code} normal_balance ${e.normal_balance} not debit|credit`);
  }
});

test('every entry has a non-empty account_type and both names', () => {
  for (const e of TILIKARTTA) {
    assert.ok(e.account_type && e.account_type.trim().length > 0, `${e.code} missing account_type`);
    assert.ok(e.name_fi && e.name_fi.trim().length > 0, `${e.code} missing name_fi`);
    assert.ok(e.name_en && e.name_en.trim().length > 0, `${e.code} missing name_en`);
  }
});

test('every entry maps to a known Kirjanpitoasetus statutory group', () => {
  for (const e of TILIKARTTA) {
    assert.ok(STATUTORY_GROUP_KEYS.has(e.statutory_group), `${e.code} statutory_group ${e.statutory_group} is not a known KPA line`);
  }
});

test('every statutory group declares a valid statement placement', () => {
  for (const [key, group] of Object.entries(STATUTORY_GROUPS)) {
    assert.ok(['balance_sheet', 'income_statement'].includes(group.statement), `${key} statement ${group.statement} invalid`);
    assert.ok(group.name_fi && group.name_en, `${key} missing bilingual name`);
    if (group.statement === 'balance_sheet') {
      assert.ok(['assets', 'equity', 'liabilities'].includes(group.side), `${key} balance-sheet side ${group.side} invalid`);
    }
  }
});

test('resolveAccount returns the entry for a known code, null otherwise', () => {
  const bank = resolveAccount('1910');
  assert.equal(bank.name_en, 'Bank account');
  assert.equal(bank.statutory_group, 'cash_and_bank');
  assert.equal(resolveAccount('9999999'), null);
  assert.equal(resolveAccount(null), null);
  assert.equal(resolveAccount(undefined), null);
});

test('resolveAccount trims and coerces the code', () => {
  assert.equal(resolveAccount('  1910  ').code, '1910');
  assert.equal(resolveAccount(1910).code, '1910');
});

test('canonical statutory accounts are present and correctly placed', () => {
  // Myyntisaamiset (trade receivables) — a balance-sheet asset, debit.
  const ar = resolveAccount('1700');
  assert.equal(ar.statutory_group, 'trade_receivables');
  assert.equal(ar.normal_balance, 'debit');
  assert.equal(resolveStatutoryGroup(ar.statutory_group).statement, 'balance_sheet');

  // Ostovelat (trade payables) — a balance-sheet liability, credit.
  const ap = resolveAccount('2870');
  assert.equal(ap.statutory_group, 'trade_payables');
  assert.equal(ap.normal_balance, 'credit');
  assert.equal(resolveStatutoryGroup(ap.statutory_group).side, 'liabilities');

  // Suoritettava ALV (VAT payable) — a liability.
  const vat = resolveAccount('2939');
  assert.equal(vat.statutory_group, 'vat_liability');
  assert.equal(vat.normal_balance, 'credit');

  // Myynti (sales / turnover) — an income-statement revenue line, credit.
  const sales = resolveAccount('3000');
  assert.equal(sales.statutory_group, 'turnover');
  assert.equal(sales.normal_balance, 'credit');
  assert.equal(resolveStatutoryGroup(sales.statutory_group).statement, 'income_statement');
});

test('resolveStatutoryGroup returns null for an unknown key', () => {
  assert.equal(resolveStatutoryGroup('not_a_group'), null);
});

// --- I4·posting P2: the FI statutory inventory rows (design §8) ---

test('the inventory GRNI + change-in-inventories statutory rows are present and placed', () => {
  // GRNI — the accrued uninvoiced purchase liability (design §5-A). Placed under
  // accrued liabilities (Siirtovelat); credit-normal. The Ostovelat-vs-Siirtovelat call
  // is FI-statutory-sensitive and confirmed by a Finnish accountant before FI canary.
  const grni = resolveAccount('2880');
  assert.ok(grni, 'GRNI account 2880 should exist');
  assert.equal(grni.normal_balance, 'credit');
  assert.equal(grni.account_type, 'liability');
  assert.equal(grni.statutory_group, 'accrued_liabilities');
  assert.equal(resolveStatutoryGroup(grni.statutory_group).side, 'liabilities');

  // Varastojen muutos — the periodic inventory-change presentation line under
  // Materiaalit ja palvelut. The PERPETUAL operational ledger never posts here; it is the
  // I6 statutory-reporting mapping target (design §8).
  const change = resolveAccount('4090');
  assert.ok(change, 'change-in-inventories account 4090 should exist');
  assert.equal(change.account_type, 'expense');
  assert.equal(change.statutory_group, 'materials_and_services');
  assert.equal(resolveStatutoryGroup(change.statutory_group).statement, 'income_statement');

  // The inventory BS asset (Aineet ja tarvikkeet) already rolls up to Vaihto-omaisuus.
  assert.equal(resolveAccount('1500').statutory_group, 'inventory');
});

// --- Toiminimi (sole-trader) profile ---

test('toiminimi equity accounts are private-account (oma pääoma) shaped', () => {
  const codes = TOIMINIMI_EQUITY_ACCOUNTS.map((e) => e.code);
  assert.deepEqual(codes, ['2050', '2051', '2052']);
  for (const e of TOIMINIMI_EQUITY_ACCOUNTS) {
    assert.equal(e.statutory_group, 'private_equity');
    assert.ok(STATUTORY_GROUP_KEYS.has(e.statutory_group));
  }
  // Withdrawals reduce equity (debit); deposits increase it (credit).
  assert.equal(TOIMINIMI_EQUITY_ACCOUNTS.find((e) => e.code === '2051').normal_balance, 'debit');
  assert.equal(TOIMINIMI_EQUITY_ACCOUNTS.find((e) => e.code === '2052').normal_balance, 'credit');
});

test('a non-ALV toiminimi chart drops share capital and the ALV accounts, adds the private account', () => {
  const chart = buildToiminimiChart({ alvRegistered: false });
  const codes = new Set(chart.map((e) => e.code));
  // Oy-only equity removed.
  assert.ok(!codes.has('2000'), 'share capital should be absent for a toiminimi');
  assert.ok(!codes.has('2251'), 'Oy retained earnings should be absent for a toiminimi');
  // ALV accounts dormant / absent for a non-ALV toiminimi.
  for (const c of ALV_ACCOUNT_CODES) assert.ok(!codes.has(c), `ALV account ${c} should be absent when not ALV-registered`);
  // Private account present.
  assert.ok(codes.has('2050') && codes.has('2051') && codes.has('2052'));
  // Ordinary trading accounts still present.
  assert.ok(codes.has('1910') && codes.has('3000') && codes.has('4000'));
});

test('an ALV-registered toiminimi chart keeps the ALV accounts but still has no share capital', () => {
  const chart = buildToiminimiChart({ alvRegistered: true });
  const codes = new Set(chart.map((e) => e.code));
  for (const c of ALV_ACCOUNT_CODES) assert.ok(codes.has(c), `ALV account ${c} should be present when ALV-registered`);
  assert.ok(!codes.has('2000'), 'share capital is still Oy-only');
  assert.ok(codes.has('2050'));
});

test('buildToiminimiChart never mutates the shared base chart', () => {
  const before = TILIKARTTA.length;
  buildToiminimiChart({ alvRegistered: false });
  buildToiminimiChart({ alvRegistered: true });
  assert.equal(TILIKARTTA.length, before);
  assert.ok(TILIKARTTA.some((e) => e.code === '2000'), 'base chart still has share capital');
});

// --- Oy chart (D-FI13-9 slice 13.2) ---------------------------------------

test('the full D-FI13-9 Oy equity + related-party statutory groups are present and placed', () => {
  const expected = {
    invested_unrestricted_equity: 'equity',
    capital_loans: 'liabilities',
    shareholder_loan_receivable: 'assets',
    shareholder_loan_payable: 'liabilities',
    dividends_payable: 'liabilities',
    shareholder_reimbursements_payable: 'liabilities'
  };
  for (const [key, side] of Object.entries(expected)) {
    const g = STATUTORY_GROUPS[key];
    assert.ok(g, `${key} statutory group should exist`);
    assert.equal(g.statement, 'balance_sheet', `${key} is a balance-sheet line`);
    assert.equal(g.side, side, `${key} should be on the ${side} side`);
    assert.ok(g.name_fi && g.name_en, `${key} needs both names`);
  }
});

test('OY_EQUITY_ACCOUNTS carry the D-FI13-9 owner accounts and never collapse equity', () => {
  const byCode = new Map(OY_EQUITY_ACCOUNTS.map((e) => [e.code, e]));
  // SVOP is its own equity line, never folded into share capital.
  assert.equal(byCode.get('2110').statutory_group, 'invested_unrestricted_equity');
  assert.equal(byCode.get('2110').normal_balance, 'credit');
  // Shareholder loan receivable is an asset (debit-normal); the payable a credit.
  assert.equal(byCode.get('1760').statutory_group, 'shareholder_loan_receivable');
  assert.equal(byCode.get('1760').normal_balance, 'debit');
  assert.equal(byCode.get('2762').statutory_group, 'shareholder_loan_payable');
  assert.equal(byCode.get('2764').statutory_group, 'dividends_payable');
  assert.equal(byCode.get('2766').statutory_group, 'shareholder_reimbursements_payable');
  assert.equal(byCode.get('2760').statutory_group, 'capital_loans');
  // Every Oy account maps to a known statutory group.
  for (const e of OY_EQUITY_ACCOUNTS) assert.ok(STATUTORY_GROUP_KEYS.has(e.statutory_group), `${e.code} group unknown`);
});

test('OY_EQUITY_ACCOUNTS codes do not collide with the base chart or the private account', () => {
  const baseCodes = new Set([...TILIKARTTA, ...TOIMINIMI_EQUITY_ACCOUNTS].map((e) => e.code));
  for (const e of OY_EQUITY_ACCOUNTS) assert.ok(!baseCodes.has(e.code), `${e.code} collides with an existing account`);
  const oyCodes = OY_EQUITY_ACCOUNTS.map((e) => e.code);
  assert.equal(new Set(oyCodes).size, oyCodes.length, 'duplicate code in OY_EQUITY_ACCOUNTS');
});

test('buildOyChart keeps share capital + retained earnings and adds the full Oy equity model', () => {
  const chart = buildOyChart({ alvRegistered: true });
  const codes = new Set(chart.map((e) => e.code));
  // Core Oy equity kept (unlike a toiminimi chart).
  assert.ok(codes.has('2000') && codes.has('2251') && codes.has('2371'));
  // The full D-FI13-9 additions present.
  for (const e of OY_EQUITY_ACCOUNTS) assert.ok(codes.has(e.code), `${e.code} should be in the Oy chart`);
  // No toiminimi private account leaks in.
  assert.ok(!codes.has('2050') && !codes.has('2051') && !codes.has('2052'));
  // ALV accounts present when registered.
  for (const c of ALV_ACCOUNT_CODES) assert.ok(codes.has(c));
});

test('a non-ALV Oy chart drops the dormant ALV accounts but keeps the Oy equity', () => {
  const chart = buildOyChart({ alvRegistered: false });
  const codes = new Set(chart.map((e) => e.code));
  for (const c of ALV_ACCOUNT_CODES) assert.ok(!codes.has(c), `ALV account ${c} should be absent`);
  assert.ok(codes.has('2000') && codes.has('2110'));
});

test('a toiminimi chart never contains any Oy-only account or group', () => {
  const chart = buildToiminimiChart({ alvRegistered: true });
  const codes = new Set(chart.map((e) => e.code));
  for (const e of OY_EQUITY_ACCOUNTS) assert.ok(!codes.has(e.code), `Oy account ${e.code} leaked into the toiminimi chart`);
  for (const e of chart) assert.ok(!OY_ONLY_STATUTORY_GROUPS.has(e.statutory_group),
    `toiminimi chart line ${e.code} carries an Oy-only group ${e.statutory_group}`);
});

test('buildOyChart never mutates the shared base chart', () => {
  const before = TILIKARTTA.length;
  buildOyChart({ alvRegistered: true });
  buildOyChart({ alvRegistered: false });
  assert.equal(TILIKARTTA.length, before);
});
