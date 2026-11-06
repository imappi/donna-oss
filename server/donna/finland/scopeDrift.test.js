// G-7 (FI-15) — scope-drift detection: closed verdict enum, trigger catalog,
// processor matching, and the DB caller (injection idiom).
//   node --test server/donna/finland/scopeDrift.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FINLAND_SCOPE_DRIFT_WATCH_FLAG_KEY,
  SCOPE_DRIFT_VERDICTS,
  SCOPE_DRIFT_TRIGGERS,
  EU_OR_IMPORT_TAX_CODES,
  REVERSE_CHARGE_TAX_CODES,
  PERSONNEL_ACCOUNT_CODES,
  SCOPE_DRIFT_STATED_EXCLUSIONS,
  OY_DROPPED_STATED_EXCLUSION_IDS,
  normalizeScopeDriftEntityAxis,
  matchProcessors,
  evaluateScopeDrift,
  FINLAND_SCOPE_DRIFT_POSTING_GATE_FLAG_KEY,
  SCOPE_DRIFT_EVIDENCE_TYPE,
  evaluateJournalScopeDrift,
  suggestionFiresReverseChargeDrift,
  scopeDriftAskId,
  buildScopeDriftEscalationQuestion
} from './scopeDrift.js';
import {
  getFinlandScopeDriftFromDb
} from '../statutoryRegistry.js';

test('pins: flag key, the closed verdict enum in severity order, the trigger catalog is closed', () => {
  assert.equal(FINLAND_SCOPE_DRIFT_WATCH_FLAG_KEY, 'FINLAND_SCOPE_DRIFT_WATCH');
  assert.deepEqual([...SCOPE_DRIFT_VERDICTS], ['supported', 'supported_with_review', 'migration_required', 'filing_blocked']);
  assert.deepEqual(SCOPE_DRIFT_TRIGGERS.map((t) => t.id), [
    'first_employee', 'payroll_activity', 'inventory_activity', 'cash_activity',
    'payment_processor', 'eu_or_import_activity', 'construction_reverse_charge'
  ]);
  for (const t of SCOPE_DRIFT_TRIGGERS) {
    assert.ok(SCOPE_DRIFT_VERDICTS.includes(t.severity), `${t.id} severity is in the closed enum`);
  }
  // Tax-code sets derive from the ALV vocabulary, never re-hardcoded.
  assert.ok(EU_OR_IMPORT_TAX_CODES.includes('ALV_EU_SUPPLY'));
  assert.ok(EU_OR_IMPORT_TAX_CODES.includes('ALV_IMPORT'));
  assert.ok(EU_OR_IMPORT_TAX_CODES.includes('ALV_0_OUTPUT'), 'zero-rated exports count as foreign sales');
  assert.deepEqual([...REVERSE_CHARGE_TAX_CODES].sort(), ['ALV_REVERSE_CHARGE_PURCHASE', 'ALV_REVERSE_CHARGE_SALES']);
  assert.deepEqual([...PERSONNEL_ACCOUNT_CODES], ['5000', '5300', '5400']);
});

test('no signals → supported with zero triggers; the evaluator never throws on garbage', () => {
  const clean = evaluateScopeDrift({ signals: {} });
  assert.equal(clean.verdict, 'supported');
  assert.deepEqual(clean.triggers, []);
  assert.equal(clean.provenance.deterministic, true);
  const garbage = evaluateScopeDrift({ signals: { personnelAccountMovements: 'NaN', processorsDetected: 'stripe' } });
  assert.equal(garbage.verdict, 'supported');
  assert.deepEqual(evaluateScopeDrift().verdict, 'supported');
});

test('G-14: the spouse exclusion is STATED on every evaluation, fired or clean (D-P2-1)', () => {
  // Closed list pin: spouse participation is the one undetectable boundary we state.
  assert.deepEqual(SCOPE_DRIFT_STATED_EXCLUSIONS.map((e) => e.id), ['spouse_participation']);
  const spouse = SCOPE_DRIFT_STATED_EXCLUSIONS[0];
  assert.ok(spouse.note_fi.includes('Puolison työpanos ei kuulu palvelun piiriin'));
  assert.ok(spouse.note_en.includes('outside the service scope'));
  // It rides the verdict regardless of whether anything fired — a boundary the
  // ledger cannot evidence must never be conditional on other signals.
  const clean = evaluateScopeDrift({ signals: {} });
  assert.deepEqual(clean.stated_exclusions, SCOPE_DRIFT_STATED_EXCLUSIONS);
  const drifted = evaluateScopeDrift({ signals: { personnelAccountMovements: 3 } });
  assert.deepEqual(drifted.stated_exclusions, SCOPE_DRIFT_STATED_EXCLUSIONS);
});

// ── FI-13 13.3A — the per-entity scope-drift fork (D-FI13-6 v2) ──────────────

test('entity axis normalises: only an explicit "oy" is oy; everything else is toiminimi', () => {
  assert.equal(normalizeScopeDriftEntityAxis('oy'), 'oy');
  assert.equal(normalizeScopeDriftEntityAxis('toiminimi'), 'toiminimi');
  assert.equal(normalizeScopeDriftEntityAxis(null), 'toiminimi');
  assert.equal(normalizeScopeDriftEntityAxis(undefined), 'toiminimi');
  assert.equal(normalizeScopeDriftEntityAxis('general'), 'toiminimi');
  assert.equal(normalizeScopeDriftEntityAxis('fi-oy'), 'toiminimi'); // the raw form, not the axis — not oy
});

test('fork: a toiminimi personnel line is first_employee (migration_required); an omitted axis is byte-identical', () => {
  const toiminimi = evaluateScopeDrift({ signals: { personnelAccountMovements: 2 } });
  assert.equal(toiminimi.entity_axis, 'toiminimi');
  assert.equal(toiminimi.verdict, 'migration_required');
  assert.deepEqual(toiminimi.triggers.map((t) => t.id), ['first_employee']);
  // Explicit toiminimi and omitted axis produce the identical envelope.
  assert.deepEqual(evaluateScopeDrift({ signals: { personnelAccountMovements: 2 }, entityAxis: 'toiminimi' }), toiminimi);
});

test('fork: an Oy personnel line is payroll_activity (supported_with_review), NOT first_employee', () => {
  const oy = evaluateScopeDrift({ signals: { personnelAccountMovements: 5 }, entityAxis: 'oy' });
  assert.equal(oy.entity_axis, 'oy');
  assert.equal(oy.verdict, 'supported_with_review');
  assert.deepEqual(oy.triggers.map((t) => t.id), ['payroll_activity']);
  const payroll = oy.triggers[0];
  assert.deepEqual(payroll.evidence, { ledger_lines: 5 });
  assert.ok(payroll.note_fi.includes('Ulkoistetun palkanlaskennan'), 'copy states booking external payroll is in scope');
  assert.ok(payroll.note_fi.includes('HALLINTA'), 'copy states payroll administration is out of scope');
  // first_employee never fires for an Oy, even with personnel movement.
  assert.equal(oy.triggers.some((t) => t.id === 'first_employee'), false);
});

test('fork: non-personnel triggers are entity-invariant (an Oy still escalates inventory / EU / reverse charge)', () => {
  const oy = evaluateScopeDrift({
    signals: { inventoryAccountMovements: 1, euRevenueAccountMovements: 2, reverseChargeTaxLines: 1 },
    entityAxis: 'oy'
  });
  assert.equal(oy.verdict, 'filing_blocked');
  assert.deepEqual(
    oy.triggers.map((t) => t.id).sort(),
    ['construction_reverse_charge', 'eu_or_import_activity', 'inventory_activity']
  );
});

test('fork: spouse_participation is stated for a toiminimi and dropped for an Oy; evaluatedTriggerIds swap the personnel trigger', () => {
  assert.deepEqual([...OY_DROPPED_STATED_EXCLUSION_IDS], ['spouse_participation']);

  const toiminimi = evaluateScopeDrift({ signals: {}, entityAxis: 'toiminimi' });
  assert.deepEqual(toiminimi.stated_exclusions.map((e) => e.id), ['spouse_participation']);
  assert.ok(toiminimi.evaluatedTriggerIds.includes('first_employee'));
  assert.equal(toiminimi.evaluatedTriggerIds.includes('payroll_activity'), false);

  const oy = evaluateScopeDrift({ signals: {}, entityAxis: 'oy' });
  assert.deepEqual(oy.stated_exclusions, []); // the one undetectable boundary is toiminimi-only
  assert.ok(oy.evaluatedTriggerIds.includes('payroll_activity'));
  assert.equal(oy.evaluatedTriggerIds.includes('first_employee'), false);
});

test('fork: evaluateJournalScopeDrift threads the entity axis (5000 line → payroll_activity for an Oy)', () => {
  const lines = [{ account: { code: '5000', name: 'Palkat' } }, { account: { code: '1910' } }];
  const toiminimi = evaluateJournalScopeDrift({ lines });
  assert.deepEqual(toiminimi.triggers.map((t) => t.id), ['first_employee']);
  assert.equal(toiminimi.verdict, 'migration_required');

  const oy = evaluateJournalScopeDrift({ lines, entityAxis: 'oy' });
  assert.deepEqual(oy.triggers.map((t) => t.id), ['payroll_activity']);
  assert.equal(oy.verdict, 'supported_with_review');
});

test('each trigger fires on its signal; overall verdict is the MAX severity fired', () => {
  const review = evaluateScopeDrift({ signals: { inventoryAccountMovements: 2, cashAccountMovements: 1 } });
  assert.equal(review.verdict, 'supported_with_review');
  assert.deepEqual(review.triggers.map((t) => t.id), ['inventory_activity', 'cash_activity']);

  const migration = evaluateScopeDrift({ signals: { inventoryAccountMovements: 2, personnelAccountMovements: 3 } });
  assert.equal(migration.verdict, 'migration_required');
  const employee = migration.triggers.find((t) => t.id === 'first_employee');
  assert.deepEqual(employee.evidence, { ledger_lines: 3 });
  assert.match(employee.note_fi, /ei maksa itselleen palkkaa/);

  const blocked = evaluateScopeDrift({
    signals: { reverseChargeTaxLines: 1, processorsDetected: ['stripe'], euOrImportTaxLines: 4 }
  });
  assert.equal(blocked.verdict, 'filing_blocked');
  assert.deepEqual(blocked.triggers.map((t) => t.id).sort(), [
    'construction_reverse_charge', 'eu_or_import_activity', 'payment_processor'
  ]);

  // EU signal fires from EITHER tax lines or the 3200/3400 revenue accounts.
  const euByAccount = evaluateScopeDrift({ signals: { euRevenueAccountMovements: 1 } });
  assert.equal(euByAccount.triggers[0].id, 'eu_or_import_activity');
});

test('processor matching: closed list, case-insensitive, deduped + sorted', () => {
  assert.deepEqual(
    matchProcessors(['STRIPE PAYOUT 12345', 'PayPal transfer', 'stripe fee', 'K-Market Espoo', null]),
    ['paypal', 'stripe']
  );
  assert.deepEqual(matchProcessors(['iZettle settlement', 'Viva Wallet payout']), ['viva_wallet', 'zettle']);
  assert.deepEqual(matchProcessors(['ordinary invoice payment ref 12345']), []);
  assert.deepEqual(matchProcessors([]), []);
});

// ── The DB caller, driven with the alvRegistrationThreshold.test.js idiom ──

const fakeClient = ({ flags = {}, signalRow = {}, processorRows = [], entityType = null } = {}) => {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('select id from clients')) return { rows: [{ id: 'client-1' }] };
      // FI-13 13.3A — the entity read that forks the drift verdict.
      if (sql.includes('entity_type') && sql.includes('from clients')) {
        return { rows: [{ entity_type: entityType, profile: null }] };
      }
      if (sql.includes('from client_capability_config')) {
        return { rows: Object.entries(flags).map(([flag_key, stage]) => ({ flag_key, stage, source: 'test', client_id: 'client-1' })) };
      }
      if (sql.includes('from cohort_capability_config')) return { rows: [] };
      if (sql.includes('from ledger_lines')) {
        return { rows: [signalRow] };
      }
      if (sql.includes('from transactions')) return { rows: processorRows };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
};

const call = ({ client } = {}) => getFinlandScopeDriftFromDb({
  firmId: 'firm-1',
  clientId: 'client-1',
  readAt: '2026-07-11T00:00:00.000Z',
  withFirmDbClientFn: async (fn) => fn(client)
});

test('DB caller: dark flag is a typed 403 (the surface hides); canary computes the envelope', async () => {
  await assert.rejects(
    call({ client: fakeClient() }),
    (e) => e.statusCode === 403 && e.code === 'FINLAND_SCOPE_DRIFT_WATCH_DISABLED'
  );

  const clean = await call({
    client: fakeClient({ flags: { FINLAND_SCOPE_DRIFT_WATCH: 'canary' }, signalRow: {} })
  });
  assert.equal(clean.drift.verdict, 'supported');
  assert.equal(clean.provenance.deterministic, true);

  const drifted = await call({
    client: fakeClient({
      flags: { FINLAND_SCOPE_DRIFT_WATCH: 'canary' },
      signalRow: { personnel_moves: '2', inventory_moves: '0', cash_moves: '0', eu_revenue_moves: '0', eu_tax_lines: '0', reverse_charge_lines: '1' },
      processorRows: [{ description: 'STRIPE PAYOUT 9-8-7' }]
    })
  });
  assert.equal(drifted.drift.verdict, 'filing_blocked');
  assert.deepEqual(drifted.drift.triggers.map((t) => t.id).sort(), [
    'construction_reverse_charge', 'first_employee', 'payment_processor'
  ]);
  const processor = drifted.drift.triggers.find((t) => t.id === 'payment_processor');
  assert.deepEqual(processor.evidence.processors, ['stripe']);
});

test('DB caller: an fi-oy client forks the personnel signal to payroll_activity (review, not migration)', async () => {
  const oy = await call({
    client: fakeClient({
      flags: { FINLAND_SCOPE_DRIFT_WATCH: 'canary' },
      entityType: 'fi-oy',
      signalRow: { personnel_moves: '4', inventory_moves: '0', cash_moves: '0', eu_revenue_moves: '0', eu_tax_lines: '0', reverse_charge_lines: '0' },
      processorRows: []
    })
  });
  assert.equal(oy.drift.entity_axis, 'oy');
  assert.equal(oy.drift.verdict, 'supported_with_review');
  assert.deepEqual(oy.drift.triggers.map((t) => t.id), ['payroll_activity']);

  // The same ledger read on a toiminimi (unset form) stays first-employee drift.
  const toiminimi = await call({
    client: fakeClient({
      flags: { FINLAND_SCOPE_DRIFT_WATCH: 'canary' },
      entityType: null,
      signalRow: { personnel_moves: '4', inventory_moves: '0', cash_moves: '0', eu_revenue_moves: '0', eu_tax_lines: '0', reverse_charge_lines: '0' }
    })
  });
  assert.equal(toiminimi.drift.entity_axis, 'toiminimi');
  assert.equal(toiminimi.drift.verdict, 'migration_required');
  assert.deepEqual(toiminimi.drift.triggers.map((t) => t.id), ['first_employee']);
});

// ----- G-7P — detection before POSTING (the pure half) -----------------------------

test('G-7P: the posting-gate flag key is the config-plane constant (never an env pair)', () => {
  assert.equal(FINLAND_SCOPE_DRIFT_POSTING_GATE_FLAG_KEY, 'FINLAND_SCOPE_DRIFT_POSTING_GATE');
  assert.notEqual(FINLAND_SCOPE_DRIFT_POSTING_GATE_FLAG_KEY, FINLAND_SCOPE_DRIFT_WATCH_FLAG_KEY);
});

test('evaluateJournalScopeDrift: a healthy journal fires nothing', () => {
  const { verdict, triggers } = evaluateJournalScopeDrift({
    lines: [
      { account: { code: '4000', name: 'Ostot' }, direction: 'debit' },
      { account: { code: '1910', name: 'Pankkitili' }, direction: 'credit' }
    ]
  });
  assert.equal(verdict, 'supported');
  assert.deepEqual(triggers, []);
});

test('evaluateJournalScopeDrift: account-code and tax-code signals fire from the journal alone', () => {
  const personnel = evaluateJournalScopeDrift({
    lines: [{ account: { code: '5000', name: 'Palkat' } }, { account: { code: '1910' } }]
  });
  assert.equal(personnel.verdict, 'migration_required');
  assert.deepEqual(personnel.triggers.map((t) => t.id), ['first_employee']);

  const reverseCharge = evaluateJournalScopeDrift({
    lines: [{ account: { code: '4000', tax_type: REVERSE_CHARGE_TAX_CODES[0] } }, { account: { code: '2870' } }]
  });
  assert.equal(reverseCharge.verdict, 'filing_blocked');
  assert.deepEqual(reverseCharge.triggers.map((t) => t.id), ['construction_reverse_charge']);

  const eu = evaluateJournalScopeDrift({
    lines: [{ account: { code: '3200' } }, { account: { code: '1700', tax_type: EU_OR_IMPORT_TAX_CODES[0] } }]
  });
  assert.deepEqual(eu.triggers.map((t) => t.id), ['eu_or_import_activity']);
  assert.equal(eu.triggers[0].evidence.ledger_lines, 2); // account signal + tax signal fold into one trigger
});

test('evaluateJournalScopeDrift: tax_type reads the ACCOUNT slot (the writer persists account.tax_type)', () => {
  const viaAccount = evaluateJournalScopeDrift({
    lines: [{ account: { code: '4000', tax_type: REVERSE_CHARGE_TAX_CODES[1] } }]
  });
  assert.equal(viaAccount.triggers.length, 1);
  const viaLineFallback = evaluateJournalScopeDrift({
    lines: [{ account: { code: '4000' }, tax_type: REVERSE_CHARGE_TAX_CODES[1] }]
  });
  assert.equal(viaLineFallback.triggers.length, 1);
});

test('evaluateJournalScopeDrift: the processor trigger can never fire from a journal, and empty input is safe', () => {
  assert.deepEqual(evaluateJournalScopeDrift({}).triggers, []);
  assert.deepEqual(evaluateJournalScopeDrift({ lines: null }).triggers, []);
  const all = evaluateJournalScopeDrift({
    lines: [{ account: { code: '5000' } }, { account: { code: '1900' } }, { account: { code: '1500' } }]
  });
  assert.equal(all.triggers.some((t) => t.id === 'payment_processor'), false);
});

test('suggestionFiresReverseChargeDrift: resolves through the SAME resolver the posting preview uses', () => {
  assert.equal(suggestionFiresReverseChargeDrift({ taxType: REVERSE_CHARGE_TAX_CODES[0] }), true);
  assert.equal(suggestionFiresReverseChargeDrift({ taxTreatment: 'rakentamispalvelun käännetty verovelvollisuus' }), true);
  assert.equal(suggestionFiresReverseChargeDrift({ taxTreatment: 'ALV 25,5 %' }), false);
  assert.equal(suggestionFiresReverseChargeDrift({}), false);
});

test('G-7P: deterministic ask id + owner-readable Finnish question', () => {
  assert.equal(
    scopeDriftAskId({ firmId: 'f1', clientId: 'c1', triggerId: 'first_employee' }),
    'scope-drift-f1-c1-first_employee'
  );
  assert.equal(SCOPE_DRIFT_EVIDENCE_TYPE, 'scope_drift_review');
  const trigger = SCOPE_DRIFT_TRIGGERS.find((t) => t.id === 'construction_reverse_charge');
  const question = buildScopeDriftEscalationQuestion({ trigger });
  assert.match(question, /käännetyn verovelvollisuuden/);
  assert.match(question, /Kerro lyhyesti/);
  assert.match(buildScopeDriftEscalationQuestion({}), /Kerro lyhyesti/); // never blank
});
