// G-6 (FI-15) — ennakkoperintärekisteri awareness: Y-tunnus validation, the
// check normalizer, own/supplier evaluators, the owner-ask copy, and the read
// DB caller (injection idiom). Invariants guarded here: checks are dated
// RECEIPTS (freshness evaluates at read time, never stored), 'ok' books stay
// quiet, and the copy flags/asks — it never claims Donna executes a
// withholding.
//   node --test server/donna/finland/prepaymentRegister.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FINLAND_PREPAYMENT_REGISTER_WATCH_FLAG_KEY,
  PREPAYMENT_REGISTER_STATUSES,
  PREPAYMENT_REGISTER_SOURCES,
  PREPAYMENT_REGISTER_SUBJECTS,
  OWN_REGISTER_VERDICTS,
  SUPPLIER_REGISTER_VERDICTS,
  PREPAYMENT_REGISTER_EVIDENCE_TYPE,
  PREPAYMENT_REGISTER_CHECK_TTL_DAYS,
  PREPAYMENT_REGISTER_SUPPLIER_LOOKBACK_DAYS,
  isValidBusinessId,
  counterpartyKey,
  normalizePrepaymentRegisterCheck,
  evaluateOwnPrepaymentRegister,
  evaluateSupplierPrepaymentRegister,
  buildPrepaymentRegisterEscalationQuestion
} from './prepaymentRegister.js';
import {
  getFinlandPrepaymentRegisterFromDb
} from '../statutoryRegistry.js';

test('pins: flag key, the closed vocabularies, evidence type, policy constants', () => {
  assert.equal(FINLAND_PREPAYMENT_REGISTER_WATCH_FLAG_KEY, 'FINLAND_PREPAYMENT_REGISTER_WATCH');
  assert.deepEqual([...PREPAYMENT_REGISTER_STATUSES], ['registered', 'not_registered', 'unknown']);
  assert.deepEqual([...PREPAYMENT_REGISTER_SOURCES], ['ytj_manual', 'ytj_open_data']);
  assert.deepEqual([...PREPAYMENT_REGISTER_SUBJECTS], ['self', 'supplier']);
  assert.deepEqual([...OWN_REGISTER_VERDICTS], ['registered', 'not_registered', 'check_due']);
  assert.deepEqual([...SUPPLIER_REGISTER_VERDICTS], ['ok', 'withholding_risk', 'check_needed']);
  assert.equal(PREPAYMENT_REGISTER_EVIDENCE_TYPE, 'prepayment_register_review');
  assert.equal(PREPAYMENT_REGISTER_CHECK_TTL_DAYS, 90);
  assert.equal(PREPAYMENT_REGISTER_SUPPLIER_LOOKBACK_DAYS, 180);
});

test('Y-tunnus validation: checksum holds, remainder-1 ids and bad shapes refuse', () => {
  assert.equal(isValidBusinessId('0112038-9'), true);
  assert.equal(isValidBusinessId('1572860-0'), true, 'remainder 0 → check digit 0');
  assert.equal(isValidBusinessId('1234567-1'), true);
  assert.equal(isValidBusinessId('1234567-8'), false, 'wrong check digit');
  assert.equal(isValidBusinessId('3000001-5'), false, 'remainder 1 → no valid check digit exists');
  assert.equal(isValidBusinessId('123456-7'), false, 'six digits is not a Y-tunnus');
  assert.equal(isValidBusinessId('ABC1234-5'), false);
  assert.equal(isValidBusinessId(''), false);
});

test('counterpartyKey: lower/trim/collapse — the join key for bills ↔ checks', () => {
  assert.equal(counterpartyKey('  Siivous  Palvelu   OY '), 'siivous palvelu oy');
  assert.equal(counterpartyKey('KONSULTTI Ky'), 'konsultti ky');
  assert.equal(counterpartyKey(''), '');
});

test('normalizePrepaymentRegisterCheck: dated receipts only, refuses garbage', () => {
  assert.deepEqual(
    normalizePrepaymentRegisterCheck({
      subjectType: 'supplier', counterpartyName: ' Siivous  Palvelu OY ', businessId: '0112038-9',
      status: 'NOT_REGISTERED', checkedOn: '2026-07-11', reference: 'ytj.fi haku'
    }),
    {
      subject_type: 'supplier', business_id: '0112038-9',
      counterparty_name: 'Siivous  Palvelu OY', counterparty_key: 'siivous palvelu oy',
      status: 'not_registered', checked_on: '2026-07-11', source: 'ytj_manual',
      reference: 'ytj.fi haku', note: null
    }
  );
  const self = normalizePrepaymentRegisterCheck({ subjectType: 'self', status: 'registered', checkedOn: '2026-07-11' });
  assert.equal(self.subject_type, 'self');
  assert.equal(self.counterparty_name, null);
  assert.equal(self.counterparty_key, null);

  assert.throws(() => normalizePrepaymentRegisterCheck({ subjectType: 'customer', status: 'registered', checkedOn: '2026-07-11' }), /subject_type/);
  assert.throws(() => normalizePrepaymentRegisterCheck({ subjectType: 'self', status: 'maybe', checkedOn: '2026-07-11' }), /status/);
  assert.throws(() => normalizePrepaymentRegisterCheck({ subjectType: 'self', status: 'registered', checkedOn: 'heinäkuu' }), /ISO date/);
  assert.throws(() => normalizePrepaymentRegisterCheck({ subjectType: 'self', status: 'registered', checkedOn: '2026-07-11', source: 'phone_call' }), /source/);
  assert.throws(() => normalizePrepaymentRegisterCheck({ subjectType: 'self', status: 'registered', checkedOn: '2026-07-11', businessId: '1234567-8' }), /Y-tunnus/);
  assert.throws(() => normalizePrepaymentRegisterCheck({ subjectType: 'supplier', status: 'registered', checkedOn: '2026-07-11' }), /counterparty_name/);
});

test('own status: quiet when registered+fresh; nudges on missing/stale/negative', () => {
  const at = '2026-07-11';
  const missing = evaluateOwnPrepaymentRegister({ latestCheck: null, onDate: at });
  assert.equal(missing.verdict, 'check_due');
  assert.match(missing.notes_fi.join(' '), /YTJ/);

  const fresh = evaluateOwnPrepaymentRegister({
    latestCheck: { status: 'registered', checked_on: '2026-06-01' }, onDate: at
  });
  assert.equal(fresh.verdict, 'registered');
  assert.deepEqual(fresh.notes_fi, [], 'a healthy book gets NO nudge');

  const stale = evaluateOwnPrepaymentRegister({
    latestCheck: { status: 'registered', checked_on: '2026-01-02' }, onDate: at
  });
  assert.equal(stale.verdict, 'check_due', 'a 190-day-old check is stale (TTL 90)');

  const negative = evaluateOwnPrepaymentRegister({
    latestCheck: { status: 'not_registered', checked_on: '2026-07-01' }, onDate: at
  });
  assert.equal(negative.verdict, 'not_registered');
  assert.match(negative.notes_fi.join(' '), /ennakonpidätyksen/);

  const unknown = evaluateOwnPrepaymentRegister({
    latestCheck: { status: 'unknown', checked_on: '2026-07-01' }, onDate: at
  });
  assert.equal(unknown.verdict, 'check_due');

  assert.throws(() => evaluateOwnPrepaymentRegister({}), /onDate/);
});

test('supplier verdicts: ok is quiet, not-registered escalates, unchecked/stale converge later', () => {
  const at = '2026-07-11';
  const ok = evaluateSupplierPrepaymentRegister({
    name: 'Siivous Palvelu OY', billCount: 3, lastBillOn: '2026-06-20',
    latestCheck: { status: 'registered', checked_on: '2026-06-01' }, onDate: at
  });
  assert.equal(ok.verdict, 'ok');
  assert.deepEqual(ok.notes_fi, []);

  const risk = evaluateSupplierPrepaymentRegister({
    name: 'Konsultti Ky', billCount: 2, lastBillOn: '2026-07-01',
    latestCheck: { status: 'not_registered', checked_on: '2026-07-10' }, onDate: at
  });
  assert.equal(risk.verdict, 'withholding_risk');
  assert.match(risk.notes_fi.join(' '), /ennakonpidätys/);
  assert.match(risk.notes_fi.join(' '), /tavaraostoissa/, 'the goods-purchase carve-out is stated, never an allegation');

  const unchecked = evaluateSupplierPrepaymentRegister({ name: 'Uusi Toimittaja', billCount: 1, onDate: at });
  assert.equal(unchecked.verdict, 'check_needed');

  const staleCheck = evaluateSupplierPrepaymentRegister({
    name: 'Vanha Kumppani', billCount: 5,
    latestCheck: { status: 'registered', checked_on: '2025-12-01' }, onDate: at
  });
  assert.equal(staleCheck.verdict, 'check_needed', 'a stale registered check is re-checked, not trusted');
});

test('the owner ask: names the supplier, the dated check, the fork — and the honesty boundary', () => {
  const question = buildPrepaymentRegisterEscalationQuestion({
    name: 'Konsultti Ky', checkedOn: '2026-07-10', billCount: 2
  });
  assert.match(question, /Konsultti Ky/);
  assert.match(question, /2026-07-10/);
  assert.match(question, /2 laskua/);
  assert.match(question, /palvelusta vai tavarasta/, 'goods vs services is the owner\'s fork');
  assert.match(question, /Donna ei toimita ennakonpidätystä/, 'Donna flags, never executes');
  assert.doesNotMatch(question, /hoidettu|handled/i);
});

// ── The read DB caller, driven with the yel.test.js idiom ──

const fakeClient = ({ flags = {}, selfCheckRows = [], supplierCheckRows = [], vendorRows = [] } = {}) => ({
  async query(sql) {
    if (sql.includes('select id from clients')) return { rows: [{ id: 'client-1' }] };
    if (sql.includes('from client_capability_config')) {
      return { rows: Object.entries(flags).map(([flag_key, stage]) => ({ flag_key, stage, source: 'test', client_id: 'client-1' })) };
    }
    if (sql.includes('from cohort_capability_config')) return { rows: [] };
    if (sql.includes("subject_type = 'self'")) return { rows: selfCheckRows };
    if (sql.includes("subject_type = 'supplier'")) return { rows: supplierCheckRows };
    if (sql.includes('from documents')) return { rows: vendorRows };
    throw new Error(`Unexpected query: ${sql}`);
  }
});

const call = ({ client } = {}) => getFinlandPrepaymentRegisterFromDb({
  firmId: 'firm-1',
  clientId: 'client-1',
  readAt: '2026-07-11T00:00:00.000Z',
  withFirmDbClientFn: async (fn) => fn(client)
});

test('DB caller: dark flag is a typed 403; canary joins checks to vendors and evaluates', async () => {
  await assert.rejects(
    call({ client: fakeClient() }),
    (e) => e.statusCode === 403 && e.code === 'FINLAND_PREPAYMENT_REGISTER_WATCH_DISABLED'
  );

  const envelope = await call({
    client: fakeClient({
      flags: { FINLAND_PREPAYMENT_REGISTER_WATCH: 'canary' },
      selfCheckRows: [{ subject_type: 'self', status: 'registered', checked_on: '2026-06-01', source: 'ytj_manual' }],
      supplierCheckRows: [
        { subject_type: 'supplier', counterparty_name: 'Konsultti Ky', counterparty_key: 'konsultti ky', status: 'not_registered', checked_on: '2026-07-10', source: 'ytj_manual' },
        // A not-registered check whose bills aged out of the lookback — the
        // recorded fact must outlive the window.
        { subject_type: 'supplier', counterparty_name: 'Vanha Paja', counterparty_key: 'vanha paja', status: 'not_registered', checked_on: '2026-05-01', source: 'ytj_manual' }
      ],
      vendorRows: [
        { vendor_key: 'konsultti ky', vendor_name: 'Konsultti Ky', bill_count: 2, last_bill_on: '2026-07-01' },
        { vendor_key: 'uusi toimittaja', vendor_name: 'Uusi Toimittaja', bill_count: 1, last_bill_on: '2026-06-15' }
      ]
    })
  });
  assert.equal(envelope.register.own.verdict, 'registered');
  const byName = new Map(envelope.register.suppliers.map((s) => [s.name, s.verdict]));
  assert.equal(byName.get('Konsultti Ky'), 'withholding_risk');
  assert.equal(byName.get('Uusi Toimittaja'), 'check_needed');
  assert.equal(byName.get('Vanha Paja'), 'withholding_risk', 'recorded not-registered outlives the bill lookback');
  assert.deepEqual(envelope.register.summary, { suppliers_total: 3, ok: 0, withholding_risk: 2, check_needed: 1 });
  assert.equal(envelope.provenance.deterministic, true);
});
