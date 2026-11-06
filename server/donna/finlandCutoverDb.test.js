// G-10 (FI-15) — cutover-pack DB caller tests: flag gate + the read-time
// reconciliation against the posted avaava tase
// (docs/design-donna-finland-fi15-g10-g14-p2-batch.md, D-P2-5).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getFinlandCutoverPackFromDb
} from './statutoryRegistry.js';

const fakeClient = ({ flags = {}, profile = {}, balanceRows = [] } = {}) => ({
  async query(sql) {
    if (sql.includes('from client_capability_config')) {
      return { rows: Object.entries(flags).map(([flag_key, stage]) => ({ flag_key, stage, source: 'test', client_id: 'client-1' })) };
    }
    if (sql.includes('from cohort_capability_config')) return { rows: [] };
    if (sql.includes('select id from clients')) return { rows: [{ id: 'client-1' }] };
    if (sql.includes('select profile from clients')) return { rows: [{ profile }] };
    if (sql.includes('from ledger_lines')) return { rows: balanceRows };
    throw new Error(`Unexpected query: ${sql}`);
  }
});

const BOTH_FLAGS = { FINLAND_OPENING_BALANCES: 'auto', FINLAND_TILIKAUSI: 'auto' };

const call = ({ client } = {}) => getFinlandCutoverPackFromDb({
  firmId: 'firm-1',
  clientId: 'client-1',
  readAt: '2026-07-11T00:00:00.000Z',
  withFirmDbClientFn: async (fn) => fn(client)
});

test('dark flags are a typed 403 — the pack is a property of the opening-balances capability, no new flag', async () => {
  await assert.rejects(
    call({ client: fakeClient() }),
    (e) => e.statusCode === 403 && e.code === 'FINLAND_CUTOVER_PACK_DISABLED'
  );
  await assert.rejects(
    call({ client: fakeClient({ flags: { FINLAND_OPENING_BALANCES: 'auto' } }) }),
    (e) => e.code === 'FINLAND_CUTOVER_PACK_DISABLED',
    'FINLAND_TILIKAUSI is a dependency, not optional'
  );
});

test('no recorded pack → no_pack envelope with the posted flag honest', async () => {
  const out = await call({ client: fakeClient({ flags: BOTH_FLAGS }) });
  assert.equal(out.cutover, null);
  assert.equal(out.evaluation.status, 'no_pack');
  assert.equal(out.opening_journal.posted, false);
  assert.equal(out.provenance.deterministic, true);
});

test('recorded pack reconciles against the POSTED opening journal (signed net per code)', async () => {
  const out = await call({
    client: fakeClient({
      flags: BOTH_FLAGS,
      profile: {
        cutover: {
          as_of: '2026-01-01',
          open_receivables: [{ counterparty: 'Asiakas Oy', amount_eur: 1200 }],
          vat_opening: { payable_eur: 950 }
        }
      },
      balanceRows: [
        { code: '1700', net: '1200' },
        { code: '2939', net: '-950' },
        { code: '1910', net: '5000' },
        { code: '2050', net: '-5250' }
      ]
    })
  });
  assert.equal(out.opening_journal.posted, true);
  assert.equal(out.evaluation.status, 'reconciled');
  const byCode = Object.fromEntries(out.evaluation.checks.map((c) => [c.code, c]));
  assert.equal(byCode.open_receivables_vs_1700.severity, 'ok');
  assert.equal(byCode.vat_payable_vs_2939.severity, 'ok');
});

test('pack without a posted opening journal is UNVERIFIED — stated, never guessed', async () => {
  const out = await call({
    client: fakeClient({
      flags: BOTH_FLAGS,
      profile: { cutover: { as_of: '2026-01-01', open_payables: [{ counterparty: 'Tukku Oy', amount_eur: 350 }] } }
    })
  });
  assert.equal(out.evaluation.status, 'unverified');
  assert.equal(out.evaluation.checks[0].severity, 'unverified');
});

test('a mismatch surfaces with its delta — never auto-corrected, never blocking', async () => {
  const out = await call({
    client: fakeClient({
      flags: BOTH_FLAGS,
      profile: { cutover: { as_of: '2026-01-01', open_receivables: [{ counterparty: 'Asiakas Oy', amount_eur: 1200 }] } },
      balanceRows: [{ code: '1700', net: '900' }]
    })
  });
  assert.equal(out.evaluation.status, 'mismatches');
  const check = out.evaluation.checks[0];
  assert.equal(check.code, 'open_receivables_vs_1700');
  assert.equal(check.delta_eur, 300);
});
