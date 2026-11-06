// FI production-readiness P0 — the ALV registration-threshold watch.
//   node --test server/donna/finland/alvRegistrationThreshold.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALV_REGISTRATION_THRESHOLD_EUR,
  ALV_THRESHOLD_APPROACH_FRACTION,
  ALV_THRESHOLD_EVIDENCE_TYPE,
  ALV_THRESHOLD_PROVENANCE,
  ALV_THRESHOLD_STATUSES,
  FINLAND_ALV_THRESHOLD_WATCH_FLAG_KEY,
  buildAlvRegistrationWatch,
  buildAlvThresholdEscalationQuestion
} from './alvRegistrationThreshold.js';
import {
  getFinlandAlvThresholdWatchFromDb
} from '../statutoryRegistry.js';

test('pins: flag key, threshold amount, statuses, provenance stays unconfirmed until the primary pass', () => {
  assert.equal(FINLAND_ALV_THRESHOLD_WATCH_FLAG_KEY, 'FINLAND_ALV_THRESHOLD_WATCH');
  assert.equal(ALV_REGISTRATION_THRESHOLD_EUR, 20000);
  assert.equal(ALV_THRESHOLD_APPROACH_FRACTION, 0.8);
  assert.deepEqual([...ALV_THRESHOLD_STATUSES], ['ok', 'approaching', 'exceeded']);
  // The crossing mechanics are secondary-sourced; the F-FI8-R1/F-FI3-1 pass
  // flips this in the same commit that confirms them. A silent flip trips here.
  assert.equal(ALV_THRESHOLD_PROVENANCE.confirmedAgainstPrimary, false);
});

test('statuses: ok under 80 %, approaching at 80 %, exceeded at the threshold — driven by the WORSE year', () => {
  const ok = buildAlvRegistrationWatch({ year: 2026, currentYearTurnover: 12000, priorYearTurnover: 9000 });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.note, null);
  assert.equal(ok.headroomEur, 8000);

  const approaching = buildAlvRegistrationWatch({ year: 2026, currentYearTurnover: 16000, priorYearTurnover: 0 });
  assert.equal(approaching.status, 'approaching');
  assert.match(approaching.note, /lähestyy ALV-rekisteröinnin rajaa/);
  assert.match(approaching.note, /80 %/);

  // Prior-year turnover alone can drive the warning (conservative under the
  // 2025 scheme's prior-year condition).
  const priorDriven = buildAlvRegistrationWatch({ year: 2026, currentYearTurnover: 3000, priorYearTurnover: 21000 });
  assert.equal(priorDriven.status, 'exceeded');
  assert.equal(priorDriven.drivingTurnover, 21000);
  assert.match(priorDriven.note, /ylittää ALV-rekisteröinnin rajan/);
  assert.match(priorDriven.note, /ei saa lisätä ALV:tä/);

  const exact = buildAlvRegistrationWatch({ year: 2026, currentYearTurnover: 20000, priorYearTurnover: 0 });
  assert.equal(exact.status, 'exceeded');
  assert.equal(exact.headroomEur, 0);
});

test('edges: negative turnover clamps to 0, garbage inputs never throw', () => {
  const negative = buildAlvRegistrationWatch({ year: 2026, currentYearTurnover: -500, priorYearTurnover: 'NaN' });
  assert.equal(negative.status, 'ok');
  assert.equal(negative.currentYearTurnover, 0);
  assert.equal(negative.priorYearTurnover, 0);
  const empty = buildAlvRegistrationWatch();
  assert.equal(empty.status, 'ok');
  assert.equal(empty.applicable, true);
});

// ── The escalation question (G-2 follow-up, D-G2E-4) ──────────────────────────

test('escalation question: exceeded only, carries the numbers + the honesty boundary', () => {
  assert.equal(ALV_THRESHOLD_EVIDENCE_TYPE, 'alv_threshold_review');
  const watch = buildAlvRegistrationWatch({ year: 2026, currentYearTurnover: 21500.5, priorYearTurnover: 0 });
  const question = buildAlvThresholdEscalationQuestion({ watch });
  assert.match(question, /21500,50 €/);
  assert.match(question, /20000,00 €/);
  assert.match(question, /OmaVero/);
  assert.match(question, /Donna ei voi rekisteröidä/);
  assert.match(question, /saa lisätä ALV:tä ennen rekisteröintiä/);
  // Non-exceeded watches never produce a question — the caller must not ask.
  for (const w of [
    buildAlvRegistrationWatch({ year: 2026, currentYearTurnover: 17000 }),
    buildAlvRegistrationWatch({ year: 2026, currentYearTurnover: 100 }),
    null
  ]) {
    assert.equal(buildAlvThresholdEscalationQuestion({ watch: w }), null);
  }
});

// ── The DB caller, driven with the finlandAlvReturnDb.test.js injection idiom ──

const fakeClient = ({ flags = {}, turnoverRows = [], askRows = [] } = {}) => ({
  async query(sql) {
    if (sql.includes('select id from clients')) return { rows: [{ id: 'client-1' }] };
    if (sql.includes('from client_capability_config')) {
      return { rows: Object.entries(flags).map(([flag_key, stage]) => ({ flag_key, stage, source: 'test', client_id: 'client-1' })) };
    }
    if (sql.includes('from cohort_capability_config')) return { rows: [] };
    if (sql.includes('from ledger_lines')) return { rows: turnoverRows };
    if (sql.includes('from client_evidence_requests')) return { rows: askRows };
    throw new Error(`Unexpected query: ${sql}`);
  }
});

const call = ({ client, ...opts } = {}) => getFinlandAlvThresholdWatchFromDb({
  firmId: 'firm-1',
  clientId: 'client-1',
  year: 2026,
  readAt: '2026-07-10T00:00:00.000Z',
  withFirmDbClientFn: async (fn) => fn(client),
  ...opts
});

test('db: flag off refuses typed 403 — the surface hides', async () => {
  await assert.rejects(
    call({ client: fakeClient({ flags: {} }) }),
    (e) => e.statusCode === 403 && e.code === 'FINLAND_ALV_THRESHOLD_WATCH_DISABLED'
  );
});

test('db: an ALV-registered client (FINLAND_ALV_CODING acts) is not applicable — the return engine owns it', async () => {
  const envelope = await call({
    client: fakeClient({ flags: { FINLAND_ALV_THRESHOLD_WATCH: 'auto', FINLAND_ALV_CODING: 'auto' } })
  });
  assert.deepEqual(envelope.watch, { applicable: false, reason: 'alv_registered' });
  assert.equal(envelope.provenance.deterministic, true);
});

test('db: turnover sums by calendar year feed the pure watch', async () => {
  const envelope = await call({
    client: fakeClient({
      flags: { FINLAND_ALV_THRESHOLD_WATCH: 'auto' },
      turnoverRows: [
        { year: '2026', turnover: '17250.40' },
        { year: '2025', turnover: '4000.00' }
      ]
    })
  });
  assert.equal(envelope.watch.applicable, true);
  assert.equal(envelope.watch.status, 'approaching');
  assert.equal(envelope.watch.currentYearTurnover, 17250.4);
  assert.equal(envelope.watch.priorYearTurnover, 4000);
  assert.equal(envelope.watch.provenance.confirmedAgainstPrimary, false);
  assert.equal(envelope.provenance.readAt, '2026-07-10T00:00:00.000Z');
  // No escalation ask row → the envelope says so (render-the-persisted-verdict).
  assert.equal(envelope.escalation, null);
});

test('db: a persisted escalation ask rides the envelope (D-G2E-6)', async () => {
  const envelope = await call({
    client: fakeClient({
      flags: { FINLAND_ALV_THRESHOLD_WATCH: 'auto' },
      turnoverRows: [{ year: '2026', turnover: '25000.00' }],
      askRows: [{ id: 'alv-threshold-firm-1-client-1-2026', status: 'open', first_sent_at: '2026-07-11T04:15:00.000Z' }]
    })
  });
  assert.equal(envelope.watch.status, 'exceeded');
  assert.deepEqual(envelope.escalation, {
    ask_id: 'alv-threshold-firm-1-client-1-2026',
    status: 'open',
    first_sent_at: '2026-07-11T04:15:00.000Z'
  });
});
