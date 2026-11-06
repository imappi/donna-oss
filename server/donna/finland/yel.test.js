// G-4 (FI-15) — YEL track/remind/flag: profile normalizer, closed statuses,
// insurer detection, and the DB caller (injection idiom). The one invariant
// every test guards: Donna NEVER determines the income — no code path derives
// or suggests a work-income figure.
//   node --test server/donna/finland/yel.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FINLAND_YEL_WATCH_FLAG_KEY,
  YEL_INSURER_IDS,
  YEL_CADENCES,
  YEL_STATUSES,
  YEL_REVIEW_INTERVAL_DAYS,
  matchYelInsurers,
  normalizeYelProfile,
  evaluateYelStatus
} from './yel.js';
import {
  getFinlandYelStatusFromDb
} from '../statutoryRegistry.js';

test('pins: flag key, the closed insurer/cadence/status vocabularies', () => {
  assert.equal(FINLAND_YEL_WATCH_FLAG_KEY, 'FINLAND_YEL_WATCH');
  assert.deepEqual([...YEL_INSURER_IDS], ['ilmarinen', 'varma', 'elo', 'veritas']);
  assert.deepEqual([...YEL_CADENCES], ['monthly', 'quarterly', 'biannual', 'annual']);
  assert.deepEqual([...YEL_STATUSES], [
    'not_configured', 'premiums_detected_unconfigured', 'active', 'review_due', 'exempt'
  ]);
  assert.equal(YEL_REVIEW_INTERVAL_DAYS, 365);
});

test('normalizeYelProfile: stores what the owner said, refuses garbage, null clears', () => {
  assert.deepEqual(
    normalizeYelProfile({ insurer: 'Ilmarinen', confirmed_income_eur: 25000.456, confirmed_on: '2026-03-01', cadence: 'QUARTERLY' }),
    { insurer: 'ilmarinen', confirmed_income_eur: 25000.46, confirmed_on: '2026-03-01', cadence: 'quarterly' }
  );
  assert.deepEqual(normalizeYelProfile({ exempt: true, note: 'osa-aikainen, alle työtulorajan' }),
    { exempt: true, note: 'osa-aikainen, alle työtulorajan' });
  assert.equal(normalizeYelProfile(null), null);
  assert.equal(normalizeYelProfile({}), null, 'an empty patch stores nothing');
  assert.throws(() => normalizeYelProfile({ insurer: 'nordea' }), /Unknown YEL insurer/);
  assert.throws(() => normalizeYelProfile({ confirmed_income_eur: -5 }), /non-negative/);
  assert.throws(() => normalizeYelProfile({ confirmed_on: 'March 2026' }), /ISO date/);
  assert.throws(() => normalizeYelProfile({ cadence: 'weekly' }), /cadence/);
  assert.throws(() => normalizeYelProfile('yes'), /object/);
});

test('insurer matching is word-bounded — ordinary Finnish words do not fire', () => {
  assert.deepEqual(
    matchYelInsurers(['ILMARINEN TYEL/YEL 12345', 'Veritas Eläkevakuutus', 'Keskinäinen Työeläkevakuutusyhtiö Elo']),
    ['elo', 'ilmarinen', 'veritas']
  );
  // 'elokuu' (August) and 'varmasti' (surely) contain the insurer names as
  // prefixes — the word boundary keeps them out.
  assert.deepEqual(matchYelInsurers(['elokuun vuokra', 'varmasti maksettu', 'K-Market']), []);
  assert.deepEqual(matchYelInsurers(['Varma keskinäinen']), ['varma']);
});

test('statuses: track (unconfigured/detected), remind (stale), quiet (active/exempt)', () => {
  const at = '2026-07-11';
  assert.equal(evaluateYelStatus({ profile: null, onDate: at }).status, 'not_configured');
  assert.equal(
    evaluateYelStatus({ profile: null, premiumInsurersDetected: ['elo'], lastPremiumOn: '2026-06-01', onDate: at }).status,
    'premiums_detected_unconfigured'
  );

  const fresh = evaluateYelStatus({
    profile: { insurer: 'elo', confirmed_income_eur: 25000, confirmed_on: '2026-03-01' },
    premiumInsurersDetected: ['elo'],
    lastPremiumOn: '2026-06-15',
    onDate: at
  });
  assert.equal(fresh.status, 'active');
  assert.deepEqual(fresh.flags, []);
  assert.deepEqual(fresh.notes_fi, [], 'a healthy book gets NO nudge');

  const stale = evaluateYelStatus({
    profile: { insurer: 'elo', confirmed_income_eur: 25000, confirmed_on: '2025-05-01' },
    premiumInsurersDetected: ['elo'],
    lastPremiumOn: '2026-06-15',
    onDate: at
  });
  assert.equal(stale.status, 'review_due');
  assert.match(stale.notes_fi.join(' '), /Donna ei määritä työtuloa/, 'the remind copy states the boundary');

  const exempt = evaluateYelStatus({ profile: { exempt: true }, onDate: at });
  assert.equal(exempt.status, 'exempt');
  assert.deepEqual(exempt.flags, []);
});

test('flags: premiums while exempt, insurer mismatch, premium gap — flags, never allegations', () => {
  const at = '2026-07-11';
  const surprising = evaluateYelStatus({
    profile: { exempt: true },
    premiumInsurersDetected: ['varma'],
    lastPremiumOn: '2026-06-20',
    onDate: at
  });
  assert.equal(surprising.status, 'exempt');
  assert.deepEqual(surprising.flags, ['premiums_while_exempt']);

  const mismatch = evaluateYelStatus({
    profile: { insurer: 'elo', confirmed_income_eur: 20000, confirmed_on: '2026-05-01' },
    premiumInsurersDetected: ['ilmarinen'],
    lastPremiumOn: '2026-06-01',
    onDate: at
  });
  assert.ok(mismatch.flags.includes('insurer_mismatch'));

  const gap = evaluateYelStatus({
    profile: { insurer: 'elo', confirmed_income_eur: 20000, confirmed_on: '2026-05-01' },
    premiumInsurersDetected: [],
    lastPremiumOn: null,
    onDate: at
  });
  assert.ok(gap.flags.includes('premium_gap'));
  assert.match(gap.notes_fi.join(' '), /henkilökohtaiselta tililtä/, 'the gap note offers the innocent explanation first');
  assert.equal(gap.status, 'active', 'a premium gap alone never downgrades the status');
});

test('the evaluator refuses to run undated; NO output ever carries a derived income figure', () => {
  assert.throws(() => evaluateYelStatus({ profile: null }), /onDate/);
  const out = evaluateYelStatus({
    profile: { insurer: 'elo', confirmed_income_eur: 25000, confirmed_on: '2026-03-01' },
    onDate: '2026-07-11'
  });
  // The only income figure anywhere in the envelope is the OWNER's recorded one.
  assert.equal(out.profile.confirmed_income_eur, 25000);
  assert.ok(!('suggested_income_eur' in out), 'no derived income, ever');
});

// ── The DB caller, driven with the alvRegistrationThreshold.test.js idiom ──

const fakeClient = ({ flags = {}, profile = null, premiumRows = [] } = {}) => ({
  async query(sql) {
    if (sql.includes('select id from clients')) return { rows: [{ id: 'client-1' }] };
    if (sql.includes('from client_capability_config')) {
      return { rows: Object.entries(flags).map(([flag_key, stage]) => ({ flag_key, stage, source: 'test', client_id: 'client-1' })) };
    }
    if (sql.includes('from cohort_capability_config')) return { rows: [] };
    if (sql.includes('select profile from clients')) return { rows: [{ profile: profile ? { yel: profile } : {} }] };
    if (sql.includes('from transactions')) return { rows: premiumRows };
    throw new Error(`Unexpected query: ${sql}`);
  }
});

const call = ({ client } = {}) => getFinlandYelStatusFromDb({
  firmId: 'firm-1',
  clientId: 'client-1',
  readAt: '2026-07-11T00:00:00.000Z',
  withFirmDbClientFn: async (fn) => fn(client)
});

test('DB caller: dark flag is a typed 403; canary reads profile + premium debits and evaluates', async () => {
  await assert.rejects(
    call({ client: fakeClient() }),
    (e) => e.statusCode === 403 && e.code === 'FINLAND_YEL_WATCH_DISABLED'
  );

  const envelope = await call({
    client: fakeClient({
      flags: { FINLAND_YEL_WATCH: 'canary' },
      profile: { insurer: 'elo', confirmed_income_eur: 25000, confirmed_on: '2026-03-01' },
      premiumRows: [{ description: 'TYÖELÄKEVAKUUTUSYHTIÖ ELO YEL', transaction_date: '2026-06-15' }]
    })
  });
  assert.equal(envelope.yel.status, 'active');
  assert.deepEqual(envelope.yel.insurersDetected, ['elo']);
  assert.equal(envelope.yel.lastPremiumOn, '2026-06-15');
  assert.equal(envelope.provenance.deterministic, true);
});
