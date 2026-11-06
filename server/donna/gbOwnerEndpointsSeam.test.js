import test from 'node:test';
import assert from 'node:assert/strict';

import { getGbStatutoryReportFromDb } from './statutoryRegistry.js';
import { createApiSeamPool, requestDonnaApi } from './testSupport/apiSeamHarness.js';

const TOKEN = 'gb-endpoint-seam';
const priorToken = process.env.DONNA_ACCESS_TOKEN;
const priorDb = process.env.DATABASE_URL;
process.env.DONNA_ACCESS_TOKEN = TOKEN;
process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
const auth = { authorization: `Bearer ${TOKEN}` };

test.after(() => {
  if (priorToken === undefined) delete process.env.DONNA_ACCESS_TOKEN; else process.env.DONNA_ACCESS_TOKEN = priorToken;
  if (priorDb === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorDb;
});

await test('GB VAT route jurisdiction-gates an FI client through the real handler', async () => {
  process.env.DONNA_ACCESS_TOKEN = TOKEN;
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  const pool = createApiSeamPool([[/select jurisdiction from clients/, { rows: [{ jurisdiction: 'FI' }], rowCount: 1 }]]);
  const response = await requestDonnaApi({ url: '/api/donna/firms/reports/gb-vat-return?client_id=fi-1', headers: auth, pool });
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json, { code: 'GB_VAT_SURFACE_NOT_AVAILABLE' });
  assert.equal(pool.matching(/select jurisdiction from clients/).length, 1);
});

await test('GB statutory route jurisdiction-gates an FI client through its current client query', async () => {
  process.env.DONNA_ACCESS_TOKEN = TOKEN;
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  const query = /select jurisdiction, entity_type, profile from clients/;
  const pool = createApiSeamPool([[query, { rows: [{ jurisdiction: 'FI', entity_type: 'fi-oy', profile: {} }], rowCount: 1 }]]);
  const response = await requestDonnaApi({ url: '/api/donna/firms/reports/gb-statutory?client_id=fi-1', headers: auth, pool });
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json, { code: 'GB_STATUTORY_SURFACE_NOT_AVAILABLE' });
  assert.equal(pool.matching(query).length, 1, 'the current statutory client query must run');
});

await test('GB statutory route renders deadlines from persisted profile facts', async () => {
  process.env.DONNA_ACCESS_TOKEN = TOKEN;
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  const pool = createApiSeamPool([
    // vat_registration sits at the profile TOP level — its schema home
    // (clientProfileSchema.js KNOWN_KEYS), where updateClientProfileInDb
    // writes it — while vat_stagger and the filing dates live under gb.
    [/select jurisdiction, entity_type, profile from clients/, { rows: [{ jurisdiction: 'GB', entity_type: 'GB-Ltd', profile: { vat_registration: { status: 'registered', registered_from: '2025-01-01' }, gb: { vat_stagger: 2, confirmation_review_period_end: '2026-07-31', accounting_period_end: '2026-12-31' } } }], rowCount: 1 }],
    [/from client_evidence_requests/, { rows: [], rowCount: 0 }]
  ]);
  const response = await requestDonnaApi({ url: '/api/donna/firms/reports/gb-statutory?client_id=gb-1', headers: auth, pool });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json, {
    entity_type: 'gb-ltd', thresholdWatch: null,
    deadlines: [
      { key: 'accounts', label: 'Companies House accounts', due_date: '2027-09-30' },
      { key: 'confirmation', label: 'Confirmation statement', due_date: '2026-08-14' },
      { key: 'ct600', label: 'Company Tax Return', due_date: '2027-12-31' },
      { key: 'corporation_tax', label: 'Corporation Tax payment', due_date: '2027-10-01' },
      { key: 'vat_1', label: 'VAT return and payment (2026-01-31)', due_date: '2026-03-07', terminal: 'scheduled' },
      { key: 'vat_2', label: 'VAT return and payment (2026-04-30)', due_date: '2026-06-07', terminal: 'scheduled' },
      { key: 'vat_3', label: 'VAT return and payment (2026-07-31)', due_date: '2026-09-07', terminal: 'scheduled' },
      { key: 'vat_4', label: 'VAT return and payment (2026-10-31)', due_date: '2026-12-07', terminal: 'scheduled' }
    ],
    provenance: null
  });
});

await test('GB statutory route keeps a persisted threshold watch when filing facts are absent', async () => {
  process.env.DONNA_ACCESS_TOKEN = TOKEN;
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  const watch = { status: 'watching', turnover_gbp: 42_000 };
  const pool = createApiSeamPool([
    [/select jurisdiction, entity_type, profile from clients/, { rows: [{ jurisdiction: 'GB', entity_type: 'gb-ltd', profile: {} }], rowCount: 1 }],
    [/from client_evidence_requests/, { rows: [{ request_payload: { watch } }], rowCount: 1 }]
  ]);
  const response = await requestDonnaApi({ url: '/api/donna/firms/reports/gb-statutory?client_id=gb-1', headers: auth, pool });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json.deadlines, [{
    key: 'vat_registration', label: 'VAT registration status', due_date: null, terminal: 'on_owner', reason_code: 'GB_LTD_VAT_REGISTRATION_NOT_ESTABLISHED'
  }]);
  assert.deepEqual(response.json.thresholdWatch, watch);
});

await test('GB statutory route renders a full-envelope owner row when legal form is unknown', async () => {
  const pool = createApiSeamPool([
    [/select jurisdiction, entity_type, profile from clients/, { rows: [{ jurisdiction: 'GB', entity_type: 'limited-ish', profile: {} }], rowCount: 1 }],
    [/from client_evidence_requests/, { rows: [], rowCount: 0 }]
  ]);
  const response = await requestDonnaApi({ url: '/api/donna/firms/reports/gb-statutory?client_id=gb-1', headers: auth, pool });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json, {
    entity_type: null, thresholdWatch: null,
    deadlines: [{
      key: 'entity_type', label: 'UK legal form', due_date: null,
      terminal: 'on_owner', reason_code: 'GB_ENTITY_TYPE_NOT_ESTABLISHED'
    }],
    provenance: null
  });
});

await test('GB statutory route dispatches LLPs to Companies House, SA800 and VAT duties — never company tax', async () => {
  const pool = createApiSeamPool([
    // vat_registration at the profile TOP level — its schema home
    // (clientProfileSchema.js KNOWN_KEYS); the filing dates live under gb.
    [/select jurisdiction, entity_type, profile from clients/, { rows: [{ jurisdiction: 'GB', entity_type: 'GB-LLP', profile: {
      vat_registration: { status: 'not_registered' },
      gb: { accounting_period_end: '2026-12-31', confirmation_review_period_end: '2026-07-31' }
    } }], rowCount: 1 }],
    [/from client_evidence_requests/, { rows: [], rowCount: 0 }]
  ]);
  const response = await requestDonnaApi({ url: '/api/donna/firms/reports/gb-statutory?client_id=gb-1', headers: auth, pool });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json.entity_type, 'gb-llp');
  assert.deepEqual(response.json.deadlines.map(({ key, due_date }) => [key, due_date]), [
    ['accounts', '2027-09-30'], ['confirmation', '2026-08-14'],
    ['partnership_return_online', '2028-01-31'], ['partnership_registration', null]
  ]);
  assert.equal(response.json.deadlines.some(({ key }) => key === 'ct600' || key === 'corporation_tax'), false);
  assert.equal(response.json.provenance.confirmedAgainstPrimary, false);
});

await test('GB statutory route dispatches a sole trader and renders named owner refusals', async () => {
  const pool = createApiSeamPool([
    [/select jurisdiction, entity_type, profile from clients/, { rows: [{ jurisdiction: 'GB', entity_type: 'gb-sole-trader', profile: { gb: { accounting_period_end: '2026-04-05' } } }], rowCount: 1 }],
    [/from client_evidence_requests/, { rows: [], rowCount: 0 }]
  ]);
  const response = await requestDonnaApi({ url: '/api/donna/firms/reports/gb-statutory?client_id=gb-1', headers: auth, pool });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json.entity_type, 'gb-sole-trader');
  assert.ok(response.json.deadlines.some((x) => x.due_date === '2027-01-31'));
  assert.deepEqual(response.json.deadlines.filter((x) => x.terminal === 'on_owner').map((x) => x.reason_code), [
    'GB_SOLE_TRADER_TRADING_START_NOT_ESTABLISHED', 'GB_SOLE_TRADER_PAYMENTS_ON_ACCOUNT_NOT_ESTABLISHED',
    'GB_SOLE_TRADER_VAT_REGISTRATION_NOT_ESTABLISHED'
  ]);
});

for (const [label, client] of [
  ['mixed-case top-level entity type', { jurisdiction: 'GB', entity_type: 'GB-Sole-Trader', profile: { gb: { accounting_period_end: '2026-04-05' } } }],
  ['profile-home entity type', { jurisdiction: 'GB', entity_type: null, profile: { entity_type: 'gb-sole-trader', gb: { accounting_period_end: '2026-04-05' } } }]
]) {
  await test(`GB statutory route dispatches the canonical sole-trader axis from ${label}`, async () => {
    const pool = createApiSeamPool([
      [/select jurisdiction, entity_type, profile from clients/, { rows: [client], rowCount: 1 }],
      [/from client_evidence_requests/, { rows: [], rowCount: 0 }]
    ]);
    const response = await requestDonnaApi({ url: '/api/donna/firms/reports/gb-statutory?client_id=gb-1', headers: auth, pool });
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(response.json.deadlines.some(({ key }) => key === 'self_assessment_online'));
    assert.equal(response.json.entity_type, 'gb-sole-trader');
  });
}

await test('GB statutory route dispatches a mixed-case partnership with a canonical envelope', async () => {
  const pool = createApiSeamPool([
    [/select jurisdiction, entity_type, profile from clients/, { rows: [{ jurisdiction: 'GB', entity_type: 'GB-Partnership', profile: { gb: { accounting_period_end: '2026-04-05' } } }], rowCount: 1 }],
    [/from client_evidence_requests/, { rows: [], rowCount: 0 }]
  ]);
  const response = await requestDonnaApi({ url: '/api/donna/firms/reports/gb-statutory?client_id=gb-1', headers: auth, pool });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json.entity_type, 'gb-partnership');
  assert.ok(response.json.deadlines.some(({ key, due_date }) => key === 'partnership_return_online' && due_date === '2027-01-31'));
  assert.equal(response.json.deadlines.some(({ key }) => key.includes('payment_on_account')), false);
});

await test('GB statutory route honors explicit Ltd VAT non-registration as silence', async () => {
  const pool = createApiSeamPool([
    [/select jurisdiction, entity_type, profile from clients/, { rows: [{ jurisdiction: 'GB', entity_type: 'gb-ltd', profile: { gb: { vat_registration: { status: 'not_registered' } } } }], rowCount: 1 }],
    [/from client_evidence_requests/, { rows: [], rowCount: 0 }]
  ]);
  const response = await requestDonnaApi({ url: '/api/donna/firms/reports/gb-statutory?client_id=gb-1', headers: auth, pool });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json.deadlines, []);
});

await test('GB statutory route renders registered sole-trader VAT deadlines for the persisted stagger', async () => {
  const pool = createApiSeamPool([
    [/select jurisdiction, entity_type, profile from clients/, { rows: [{
      jurisdiction: 'GB', entity_type: 'gb-sole-trader', profile: { gb: {
        accounting_period_end: '2026-04-05', vat_stagger: 2,
        vat_registration: { status: 'registered', registered_from: '2025-01-01' }
      } }
    }], rowCount: 1 }],
    [/from client_evidence_requests/, { rows: [], rowCount: 0 }]
  ]);
  const response = await requestDonnaApi({ url: '/api/donna/firms/reports/gb-statutory?client_id=gb-1', headers: auth, pool });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json.deadlines.filter(({ key }) => key.startsWith('vat_')).map(({ label, due_date }) => [label, due_date]), [
    ['VAT return and payment (2026-01-31)', '2026-03-07'],
    ['VAT return and payment (2026-04-30)', '2026-06-07'],
    ['VAT return and payment (2026-07-31)', '2026-09-07'],
    ['VAT return and payment (2026-10-31)', '2026-12-07']
  ]);
});

// ── W6: the GB Ltd close read (review-fix round) ─────────────────────────────
// The consumer owns every gate; the route translates its NAMED verdicts. These
// tests pin the four terminals and THE critical invariant: a GET never mints.

const gbLtdCloseResponders = ({ jurisdiction = 'GB', entityType = 'gb-ltd', gbFacts, flagStage = 'canary' } = {}) => [
  [/select jurisdiction, profile from clients/, { rows: [{ jurisdiction, profile: gbFacts ? { gb: gbFacts } : {} }], rowCount: 1 }],
  [/select id from clients where firm_id = \$1 and id = \$2 and status/, { rows: [{ id: 'gb-1' }], rowCount: 1 }],
  [/select jurisdiction, entity_type, incorporation_date, profile from clients/, {
    rows: [{ jurisdiction, entity_type: entityType, incorporation_date: '2025-01-15', profile: gbFacts ? { gb: gbFacts } : {} }], rowCount: 1
  }],
  [/select entity_type, incorporation_date, profile from clients/, {
    rows: [{ entity_type: entityType, incorporation_date: '2025-01-15', profile: gbFacts ? { gb: gbFacts } : {} }], rowCount: 1
  }],
  ...(flagStage ? [[/from client_capability_config/, {
    rows: [{ flag_key: 'GB_LTD_MONTHLY_CLOSE', stage: flagStage, source: 'manual', client_id: 'gb-1' }], rowCount: 1
  }]] : []),
  [/select label, starts_on, ends_on from fiscal_years/, {
    rows: [{ label: 'FY26', starts_on: '2026-01-01', ends_on: '2026-12-31' }], rowCount: 1
  }]
];

const GB_CLOSE_FACTS = { vat_stagger: 2, confirmation_review_period_end: '2026-08-31', accounting_period_end: '2026-12-31' };

await test('gb-ltd-close: an FI client 404s at the route jurisdiction gate', async () => {
  const pool = createApiSeamPool([[/select jurisdiction, profile from clients/, { rows: [{ jurisdiction: 'FI', profile: {} }], rowCount: 1 }]]);
  const response = await requestDonnaApi({ url: '/api/donna/firms/reports/gb-ltd-close?client_id=fi-1', headers: auth, pool });
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json, { code: 'GB_LTD_CLOSE_SURFACE_NOT_AVAILABLE' });
});

await test('gb-ltd-close: a sole trader gets the consumer\'s named 409, not a broken evaluation', async () => {
  const pool = createApiSeamPool(gbLtdCloseResponders({ entityType: 'gb-sole-trader', gbFacts: GB_CLOSE_FACTS }));
  const response = await requestDonnaApi({ url: '/api/donna/firms/reports/gb-ltd-close?client_id=gb-1', headers: auth, pool });
  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.json, { code: 'GB_LTD_MONTHLY_CLOSE_ENTITY_NOT_LTD' });
});

await test('gb-ltd-close: the surface stays DARK for an un-staged client on every path, and the config plane was genuinely consulted', async () => {
  const pool = createApiSeamPool(gbLtdCloseResponders({ gbFacts: null, flagStage: null }));
  const response = await requestDonnaApi({ url: '/api/donna/firms/reports/gb-ltd-close?client_id=gb-1', headers: auth, pool });
  assert.equal(response.statusCode, 403, response.body);
  assert.deepEqual(response.json, { code: 'GB_LTD_MONTHLY_CLOSE_DISABLED' });
  // The trap: the missing-facts client must NOT get a synthesized envelope
  // while the flag is dark — and "dark" must come from asking the plane.
  assert.ok(pool.matching(/from client_capability_config/).length >= 1, 'the config-plane read must actually run');
});

await test('gb-ltd-close: missing owner facts render the pack\'s NAMED refusal as an on_owner row, and the GET mints nothing', async () => {
  const pool = createApiSeamPool(gbLtdCloseResponders({ gbFacts: {} }));
  const response = await requestDonnaApi({ url: '/api/donna/firms/reports/gb-ltd-close?client_id=gb-1', headers: auth, pool });
  assert.equal(response.statusCode, 200, response.body);
  const [item] = response.json.close.items;
  assert.equal(item.terminal, 'on_owner');
  assert.match(item.reason_code, /^GB_LTD_.*_NOT_ESTABLISHED$/);
  assert.equal(response.json.provenance.persisted, false);
  assert.equal(pool.matching(/insert into statutory_blockers/).length, 0, 'a GET never mints');
});

await test('gb-ltd-close: facts + staged flag return the consumer\'s real envelope with persist: false pinned', async () => {
  const pool = createApiSeamPool(gbLtdCloseResponders({ gbFacts: GB_CLOSE_FACTS }));
  const response = await requestDonnaApi({ url: '/api/donna/firms/reports/gb-ltd-close?client_id=gb-1', headers: auth, pool });
  assert.equal(response.statusCode, 200, response.body);
  assert.ok(Array.isArray(response.json.close.items));
  assert.equal(response.json.provenance.persisted, false);
  assert.equal(response.json.provenance.deterministic, true, 'the real consumer envelope, not a route synthesis');
  // THE critical pin (queue doc W6): the consumer's persist default is TRUE
  // and mints statutory blockers — the GET path must never reach that SQL.
  assert.equal(pool.matching(/insert into statutory_blockers/).length, 0, 'a GET never mints');
});

// ── W3: WhatsApp binding-state read + revoke round-trip (review-fix round) ──

await test('binding-state: a bound client gets masked last-4 only — never the full number, never a token value', async () => {
  const pool = createApiSeamPool([
    [/from client_whatsapp_bindings/, {
      rows: [{ id: 'wab-1', phone_e164: '+447700900123', phone_hash: 'hash-1', bind_token: 'SECRET-TOKEN-VALUE', verified_at: '2026-07-30T10:00:00Z', created_at: '2026-07-30T09:59:00Z' }],
      rowCount: 1
    }]
  ]);
  const response = await requestDonnaApi({ url: '/api/donna/firms/whatsapp/binding-state?client_id=gb-1', headers: auth, pool });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json.binding.masked_phone, '••••0123');
  assert.equal(typeof response.json.channel_acts, 'boolean');
  assert.ok(!response.body.includes('447700900123'), 'full phone number must never leave the route');
  assert.ok(!response.body.includes('SECRET-TOKEN-VALUE'), 'token values must never leave the route');
  assert.ok(!response.body.includes('hash-1'), 'the phone hash stays server-side');
});

await test('binding-state: an unbound client reads null binding with an honest channel_acts', async () => {
  const pool = createApiSeamPool([]);
  const response = await requestDonnaApi({ url: '/api/donna/firms/whatsapp/binding-state?client_id=gb-1', headers: auth, pool });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json.binding, null);
  assert.equal(response.json.channel_acts, false, 'no flag row and a dark env fallback read as NOT acting');
});

await test('binding-state: revoke round-trips through the real route', async () => {
  const pool = createApiSeamPool([
    [/update client_whatsapp_bindings set revoked_at/, { rows: [{ id: 'wab-1', revoked_at: '2026-07-31T12:00:00Z' }], rowCount: 1 }]
  ]);
  const response = await requestDonnaApi({
    method: 'POST',
    url: '/api/donna/firms/whatsapp/bindings/revoke',
    headers: { ...auth, 'content-type': 'application/json' },
    body: { client_id: 'gb-1', binding_id: 'wab-1' },
    pool
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json.revoked, true);
  assert.equal(pool.matching(/update client_whatsapp_bindings set revoked_at/).length, 1);
});

// ── W5: the profile writer deep-merges gb (review-fix round) ─────────────────
// The validator preserves unknown inner keys, but the top-level jsonb || is
// shallow — without the deep branch, { gb: { vat_stagger: null } } (the clear
// case) would wipe the sibling dates and the close engine's completion_evidence
// at MERGE time, one layer below the schema tests.

await test('a partial gb patch takes the deep-merge SQL branch; gb: null still clears through the shallow branch', async () => {
  const { updateClientProfileInDb } = await import('./firmDb.js');
  const runPatch = async (profilePatch) => {
    const queries = [];
    const dbClient = {
      query: async (sql, params = []) => {
        queries.push({ sql, params });
        if (/^select jurisdiction, profile/.test(sql.trim())) return { rows: [{ jurisdiction: 'GB', profile: { jurisdiction: 'gb' } }], rowCount: 1 };
        if (/^update clients/.test(sql.trim())) return { rows: [{ id: 'gb-1' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }
    };
    await updateClientProfileInDb({ firmId: 'firm-1', clientId: 'gb-1', profilePatch, actorId: 'test', dbClient });
    return queries.find((entry) => /^update clients/.test(entry.sql.trim()));
  };

  const deep = await runPatch({ gb: { vat_stagger: 2 } });
  assert.match(deep.sql, /jsonb_set/);
  assert.match(deep.sql, /profile->'gb'/);
  assert.equal(deep.params[3], true, 'a gb OBJECT patch selects the deep-merge branch');

  const clear = await runPatch({ gb: null });
  assert.equal(clear.params[3], false, 'gb: null clears the whole key through the shallow branch');

  const unrelated = await runPatch({ companyName: 'Brix Ltd' });
  assert.equal(unrelated.params[3], false, 'a patch without gb never touches the deep branch');
});

await test('GB statutory route renders DLA attention rows when the taxonomy flag acts', async () => {
  process.env.DONNA_ACCESS_TOKEN = TOKEN;
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  const pool = createApiSeamPool([
    [/select jurisdiction, entity_type, profile from clients/, { rows: [{ jurisdiction: 'GB', entity_type: 'gb-ltd', profile: {} }], rowCount: 1 }],
    [/from client_capability_config/, { rows: [{ flag_key: 'GB_OWNER_TRANSACTION_TAXONOMY', stage: 'canary', source: 'seam', client_id: 'gb-1' }], rowCount: 1 }],
    [/group by la\.canonical_role/, { rows: [
      { canonical_role: 'liability.director_loan', account_type: 'liability', debit_total: 12000, credit_total: 1000 }
    ], rowCount: 1 }],
    [/from client_evidence_requests/, { rows: [], rowCount: 0 }]
  ]);
  const response = await requestDonnaApi({ url: '/api/donna/firms/reports/gb-statutory?client_id=gb-1', headers: auth, pool });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json.deadlines, [
    { key: 'vat_registration', label: 'VAT registration status', due_date: null, terminal: 'on_owner', reason_code: 'GB_LTD_VAT_REGISTRATION_NOT_ESTABLISHED' },
    { key: 'dla_s455', label: "Director's loan account", due_date: null, terminal: 'on_owner', reason_code: 'GB_DLA_S455_ATTENTION' },
    { key: 'dla_beneficial_loan', label: "Director's loan account", due_date: null, terminal: 'on_owner', reason_code: 'GB_DLA_BENEFICIAL_LOAN_ATTENTION' }
  ]);
  assert.equal(pool.matching(/group by la\.canonical_role/).length, 1, 'the role-balance read ran once');
});

await test('GB statutory route stays byte-identical with the taxonomy flag dark — no balance read', async () => {
  process.env.DONNA_ACCESS_TOKEN = TOKEN;
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  const pool = createApiSeamPool([
    [/select jurisdiction, entity_type, profile from clients/, { rows: [{ jurisdiction: 'GB', entity_type: 'gb-ltd', profile: {} }], rowCount: 1 }],
    [/from client_evidence_requests/, { rows: [], rowCount: 0 }]
  ]);
  const response = await requestDonnaApi({ url: '/api/donna/firms/reports/gb-statutory?client_id=gb-1', headers: auth, pool });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json.deadlines, [
    { key: 'vat_registration', label: 'VAT registration status', due_date: null, terminal: 'on_owner', reason_code: 'GB_LTD_VAT_REGISTRATION_NOT_ESTABLISHED' }
  ]);
  assert.equal(pool.matching(/group by la\.canonical_role/).length, 0, 'no stage row means no balance read');
});

await test('GB statutory route renders the sole-trader negative-equity advisory when the flag acts', async () => {
  process.env.DONNA_ACCESS_TOKEN = TOKEN;
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  const pool = createApiSeamPool([
    [/select jurisdiction, entity_type, profile from clients/, { rows: [{ jurisdiction: 'GB', entity_type: 'gb-sole-trader', profile: { gb: { accounting_period_end: '2026-04-05' } } }], rowCount: 1 }],
    [/from client_capability_config/, { rows: [{ flag_key: 'GB_OWNER_TRANSACTION_TAXONOMY', stage: 'canary', source: 'seam', client_id: 'gb-1' }], rowCount: 1 }],
    [/group by la\.canonical_role/, { rows: [
      { canonical_role: 'equity.owner_drawings', account_type: 'equity', debit_total: 9000, credit_total: 0 },
      { canonical_role: 'revenue.sales', account_type: 'revenue', debit_total: 0, credit_total: 4000 }
    ], rowCount: 2 }],
    [/from client_evidence_requests/, { rows: [], rowCount: 0 }]
  ]);
  const response = await requestDonnaApi({ url: '/api/donna/firms/reports/gb-statutory?client_id=gb-1', headers: auth, pool });
  assert.equal(response.statusCode, 200, response.body);
  const last = response.json.deadlines[response.json.deadlines.length - 1];
  assert.deepEqual(last, { key: 'owner_equity', label: 'Owner equity', due_date: null, terminal: 'on_owner', reason_code: 'GB_ST_NEGATIVE_OWNER_EQUITY_ATTENTION' });
});

await test('GB statutory report refuses missing, aliased, or conflicting persisted identity before report reads', async () => {
  for (const clientRecord of [
    { jurisdiction: null, entity_type: 'gb-ltd', profile: { jurisdiction: 'GB' } },
    { jurisdiction: 'GB', entity_type: 'gb-ltd', profile: { jurisdiction: 'AE' } },
    { jurisdiction: 'UK', entity_type: 'gb-ltd', profile: {} },
    { jurisdiction: 'GB', entity_type: 'fi-oy', profile: {} },
    { jurisdiction: 'GB', entity_type: 'gb-ltd', profile: { entity_type: 'gb-llp' } }
  ]) {
    const pool = createApiSeamPool([[/select jurisdiction, entity_type, profile from clients/,
      { rows: [clientRecord], rowCount: 1 }]]);
    const response = await requestDonnaApi({ url: '/api/donna/firms/reports/gb-statutory?client_id=gb-1', headers: auth, pool });
    assert.equal(response.statusCode, 404, JSON.stringify(clientRecord));
    assert.deepEqual(response.json, { code: 'GB_STATUTORY_SURFACE_NOT_AVAILABLE' });
    assert.equal(pool.matching(/client_capability_config|ledger_lines|client_evidence_requests/).length, 0);
    await assert.rejects(getGbStatutoryReportFromDb({ firmId: 'firm', clientId: 'client', clientRecord,
      query: async () => assert.fail('an inadmissible report must not read country data') }),
    { code: 'GB_STATUTORY_SURFACE_NOT_AVAILABLE', statusCode: 404 });
  }
});
