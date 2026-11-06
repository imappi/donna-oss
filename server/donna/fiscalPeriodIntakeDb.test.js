import test from 'node:test';
import assert from 'node:assert/strict';
import { registerFiscalPeriodWithClient } from './firmDb.js';

// Asserts what is PERSISTED, not what the function returns — a green suite that
// only checks a return value is how a wire with no producer ships (#1134).
const fakeClient = ({
  jurisdiction = 'GB',
  entityType = null,
  existing = [],
  flags = { FISCAL_PERIOD_INTAKE: 'canary' }
} = {}) => {
  const writes = [];
  return {
    writes,
    async query(sql, params = []) {
      if (sql.includes('from client_capability_config')) {
        return { rows: Object.entries(flags).map(([flag_key, stage]) => ({ flag_key, stage, source: 'test', client_id: 'client-1' })) };
      }
      if (sql.includes('from cohort_capability_config')) return { rows: [] };
      if (sql.includes('select jurisdiction, entity_type, profile from clients')) {
        return { rows: jurisdiction === null ? [] : [{ jurisdiction, entity_type: entityType }] };
      }
      if (sql.includes('from fiscal_years') && sql.includes('limit 1')) {
        const row = existing.find((period) => period.starts_on === params[2]) || writes
          .filter((write) => write.sql.includes('insert into fiscal_years'))
          .map((write) => ({ id: write.params[0], label: write.params[3], starts_on: write.params[4], ends_on: write.params[5], status: 'open' }))
          .find((period) => period.starts_on === params[2]);
        return { rows: row ? [row] : [] };
      }
      if (sql.includes('from fiscal_years')) return { rows: existing };
      if (sql.includes('insert into fiscal_years')) { writes.push({ sql, params }); return { rows: [] }; }
      if (sql.includes('insert into audit_events')) { writes.push({ sql, params }); return { rows: [{ id: 'audit-1' }] }; }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
};

const call = (client, overrides = {}) => registerFiscalPeriodWithClient({
  client,
  firmId: 'firm-1',
  clientId: 'client-1',
  label: '2026/27',
  startsOn: '2026-04-01',
  endsOn: '2027-03-31',
  actorId: 'owner-1',
  authorityBasis: { source: 'owner_confirmation' },
  ...overrides
});

const inserted = (client) => client.writes.find((write) => write.sql.includes('insert into fiscal_years'));
const audited = (client) => client.writes.find((write) => write.sql.includes('insert into audit_events'));

test('a GB period is persisted open, with an owner-attributed receipt that records the UNENFORCED statutory bound', async () => {
  const client = fakeClient();
  const result = await call(client);

  const row = inserted(client);
  assert.ok(row, 'the period reaches an insert');
  assert.equal(row.params[1], 'firm-1');
  assert.equal(row.params[2], 'client-1');
  assert.equal(row.params[3], '2026/27');
  assert.equal(row.params[4], '2026-04-01');
  assert.equal(row.params[5], '2027-03-31');
  assert.match(row.sql, /on conflict \(firm_id, client_id, starts_on\) do nothing/, 'never fights the derive path');
  assert.match(row.sql, /'open'/, 'a registered period starts open');

  const audit = audited(client);
  assert.equal(audit.params[2], 'owner-1', 'the receipt carries the real actor, not system');
  assert.equal(audit.params[3], row.params[0], 'the receipt points at the row that was written');
  assert.match(audit.sql, /'fiscal_period\.registered'/);
  const metadata = JSON.parse(audit.params[4]);
  assert.equal(metadata.jurisdiction, 'GB');
  assert.equal(metadata.statutory_bound_enforced, false);
  assert.equal(metadata.authority_basis.source, 'owner_confirmation');
  assert.equal(metadata.source, 'explicit_intake');
  assert.match(metadata.statutory_bound_provenance, /not confirmed against primary source/i);

  assert.equal(result.created, true);
  assert.equal(result.audit_event_id, 'audit-1');
  assert.equal(result.fiscal_period.starts_on, '2026-04-01');
});

test('an FI period runs the tilikausi statute — an Oy gets the 18-month profile and an over-long year refuses', async () => {
  const oy = fakeClient({ jurisdiction: 'FI', entityType: 'fi-oy' });
  const result = await registerFiscalPeriodWithClient({
    client: oy, firmId: 'firm-1', clientId: 'client-1',
    label: '2026', startsOn: '2026-01-01', endsOn: '2027-03-31', actorId: 'owner-1'
  });
  assert.equal(result.created, true, '15 months is legal for an Oy');
  assert.equal(JSON.parse(audited(oy).params[4]).statutory_bound_enforced, true);

  // The same 15 months on a toiminimi exceeds its 12-month cap, and FI's own
  // named refusal — not a generic one — is what surfaces.
  const toiminimi = fakeClient({ jurisdiction: 'FI', entityType: null });
  await assert.rejects(
    registerFiscalPeriodWithClient({ client: toiminimi, firmId: 'firm-1', clientId: 'client-1', label: '2026', startsOn: '2026-01-01', endsOn: '2027-03-31' }),
    (error) => error.code === 'TILIKAUSI_TOO_LONG'
  );
  assert.equal(inserted(toiminimi), undefined, 'a refused period reaches no insert');

  // And an over-long Oy year still refuses — the profile is a different cap,
  // not an absent one.
  const longOy = fakeClient({ jurisdiction: 'FI', entityType: 'fi-oy' });
  await assert.rejects(
    registerFiscalPeriodWithClient({ client: longOy, firmId: 'firm-1', clientId: 'client-1', label: '2026', startsOn: '2026-01-01', endsOn: '2027-12-31' }),
    (error) => error.code === 'TILIKAUSI_TOO_LONG'
  );
});

test('every gate refuses before a write: flag off, no client, no jurisdiction, bad bounds, conflict, overlap', async () => {
  for (const [name, client, overrides, code] of [
    ['flag off', fakeClient({ flags: {} }), {}, 'FISCAL_PERIOD_INTAKE_DISABLED'],
    ['flag observe-only', fakeClient({ flags: { FISCAL_PERIOD_INTAKE: 'shadow' } }), {}, 'FISCAL_PERIOD_INTAKE_DISABLED'],
    ['no client id', fakeClient(), { clientId: null }, 'FISCAL_PERIOD_CLIENT_REQUIRED'],
    ['client missing', fakeClient({ jurisdiction: null }), {}, 'FISCAL_PERIOD_CLIENT_REQUIRED'],
    ['no jurisdiction', fakeClient({ jurisdiction: '  ' }), {}, 'FISCAL_PERIOD_JURISDICTION_REQUIRED'],
    ['unregistered country', fakeClient({ jurisdiction: 'ZZ' }), {}, 'FISCAL_YEAR_POLICY_UNAVAILABLE'],
    ['conflicting country/form', fakeClient({ jurisdiction: 'FI', entityType: 'gb-ltd' }), {}, 'FISCAL_YEAR_POLICY_UNAVAILABLE'],
    ['no label', fakeClient(), { label: null }, 'FISCAL_PERIOD_LABEL_REQUIRED'],
    ['bad bounds', fakeClient(), { endsOn: '2025-01-01' }, 'FISCAL_PERIOD_BAD_BOUNDS'],
    ['unparseable bounds', fakeClient(), { startsOn: 'whenever' }, 'FISCAL_PERIOD_BAD_BOUNDS'],
    ['same start, different end', fakeClient({ existing: [{ id: 'fy-1', label: '2026/27', starts_on: '2026-04-01', ends_on: '2027-03-31', status: 'open' }] }), { endsOn: '2027-06-30' }, 'FISCAL_PERIOD_CONFLICTS_EXISTING'],
    ['label taken', fakeClient({ existing: [{ id: 'fy-1', label: '2026/27', starts_on: '2025-04-01', ends_on: '2026-03-31', status: 'open' }] }), { startsOn: '2027-04-01', endsOn: '2028-03-31' }, 'FISCAL_PERIOD_LABEL_CONFLICT'],
    ['overlap', fakeClient({ existing: [{ id: 'fy-1', label: 'FY26', starts_on: '2026-01-01', ends_on: '2026-12-31', status: 'open' }] }), {}, 'FISCAL_PERIOD_OVERLAPS_EXISTING']
  ]) {
    await assert.rejects(call(client, overrides), (error) => error.code === code, name);
    assert.equal(inserted(client), undefined, `${name} reaches no fiscal_years insert`);
    assert.equal(audited(client), undefined, `${name} reaches no audit write`);
  }
});

test('re-registering the identical period writes nothing and emits no second receipt', async () => {
  const client = fakeClient({ existing: [{ id: 'fy-1', label: '2026/27', starts_on: '2026-04-01', ends_on: '2027-03-31', status: 'open' }] });
  const result = await call(client);
  assert.equal(result.created, false);
  assert.equal(result.audit_event_id, null);
  assert.equal(result.fiscal_period.id, 'fy-1');
  assert.equal(client.writes.length, 0, 'an idempotent retry is inert');
});

test('the client row is locked FOR UPDATE, which is what makes the overlap check sound', async () => {
  // No schema constraint catches a merely-overlapping period, so the check only
  // means something while intake is serialized per client.
  const seen = [];
  const client = fakeClient();
  const inner = client.query.bind(client);
  client.query = async (sql, params) => { seen.push(sql); return inner(sql, params); };
  await call(client);
  const clientRead = seen.find((sql) => sql.includes('select jurisdiction, entity_type, profile from clients'));
  assert.match(clientRead, /for update/);
});
