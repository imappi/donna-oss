import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getProcountorApiBaseUrl,
  getProcountorConfig,
  buildProcountorAuthorizeUrl,
  createProcountorState,
  verifyProcountorState,
  normalizeProcountorConnection,
  exchangeProcountorCode,
  refreshProcountorToken,
  decodeProcountorTokenClaims,
  resolveProcountorCompanyId,
  resolveProcountorRedirectUri,
  exchangeProcountorApiKey,
  fetchProcountorResource,
  fetchProcountorPagedResults,
  normalizeProcountorLedgerAccount,
  normalizeProcountorDimension,
  normalizeProcountorBusinessPartner,
  normalizeProcountorBankAccount
} from './procountorClient.js';

// Minimal unsigned JWT (header.payload.signature) carrying the given claims —
// mirrors a Procountor access token, whose `cid` claim is the company id.
const makeJwt = (claims) => {
  const seg = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${seg({ alg: 'RS256', typ: 'JWT' })}.${seg(claims)}.sig-not-checked`;
};

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

test.afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
});

// Capture the outbound token request so the body/header contract can be asserted
// without a live Procountor call. Returns the recorded { url, options } and the
// parsed form params.
const stubTokenFetch = (responseBody = {}) => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(responseBody)
    };
  };
  return calls;
};

await test('Procountor config defaults to test host, never production when env is unset', () => {
  delete process.env.PROCOUNTOR_ENVIRONMENT;
  delete process.env.PROCOUNTOR_API_BASE_URL;
  assert.equal(getProcountorConfig().environment, 'test');
  // PTS OAuth/API host is pts-api.procountor.com (pts-secure is the UI host, not
  // the OAuth API). An unset env must still never resolve to production.
  assert.equal(getProcountorApiBaseUrl(), 'https://pts-api.procountor.com');
  assert.equal(getProcountorApiBaseUrl('production'), 'https://api.procountor.com');
});

await test('PROCOUNTOR_API_BASE_URL pins the base host over the environment default (no code deploy on a PTS move)', () => {
  delete process.env.PROCOUNTOR_ENVIRONMENT;
  process.env.PROCOUNTOR_API_BASE_URL = 'https://pts-new-host.procountor.com/';
  // Override wins and its trailing slash is trimmed so `${base}/login` is clean.
  assert.equal(getProcountorApiBaseUrl(), 'https://pts-new-host.procountor.com');
  assert.equal(getProcountorApiBaseUrl('production'), 'https://pts-new-host.procountor.com');
});

await test('Procountor OAuth state is signed and carries host-derived redirect_uri', () => {
  process.env.PROCOUNTOR_CLIENT_ID = 'client-1';
  process.env.PROCOUNTOR_CLIENT_SECRET = 'secret-1';
  process.env.PROCOUNTOR_REDIRECT_URI = 'https://static.example/api/donna/firms/procountor/callback';
  process.env.PROCOUNTOR_STATE_SECRET = 'unit-secret';
  const redirectUri = 'https://branch.example/api/donna/firms/procountor/callback';
  const state = createProcountorState({ firmId: 'firm-1', clientId: 'client-1', redirectUri, issuedAt: 1000 });
  const payload = verifyProcountorState(state, { now: 1001 });
  assert.equal(payload.firm_id, 'firm-1');
  assert.equal(payload.client_id, 'client-1');
  assert.equal(payload.redirect_uri, redirectUri);
  const url = new URL(buildProcountorAuthorizeUrl({ state, redirectUri }));
  // dev.procountor.com/api-authentication/: authorize = <base>/login, keyed by
  // environment (default test → the pts host), and NO scope param by default.
  assert.equal(url.origin, 'https://pts-api.procountor.com');
  assert.equal(url.pathname, '/login');
  assert.equal(url.searchParams.get('scope'), null);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), redirectUri);
});

await test('Procountor state TTL survives a slow (20 min) 2FA login but rejects a 40 min one', () => {
  process.env.PROCOUNTOR_STATE_SECRET = 'unit-secret';
  const issuedAt = 1_000_000;
  const state = createProcountorState({ firmId: 'firm-1', clientId: 'client-1', issuedAt });
  // 20 minutes later — inside the 30-min window (the old 10-min TTL failed here).
  assert.equal(verifyProcountorState(state, { now: issuedAt + 20 * 60 * 1000 }).client_id, 'client-1');
  // 40 minutes later — genuinely stale.
  assert.throws(() => verifyProcountorState(state, { now: issuedAt + 40 * 60 * 1000 }), /Expired/);
});

await test('Procountor authorize URL follows PROCOUNTOR_ENVIRONMENT to the production host', () => {
  process.env.PROCOUNTOR_CLIENT_ID = 'client-1';
  process.env.PROCOUNTOR_CLIENT_SECRET = 'secret-1';
  process.env.PROCOUNTOR_REDIRECT_URI = 'https://static.example/api/donna/firms/procountor/callback';
  process.env.PROCOUNTOR_ENVIRONMENT = 'production';
  const url = new URL(buildProcountorAuthorizeUrl({ state: 's' }));
  assert.equal(url.origin, 'https://api.procountor.com');
  assert.equal(url.pathname, '/login');
});

await test('exchangeProcountorCode sends client credentials in the form body (docs contract), no Basic header', async () => {
  process.env.PROCOUNTOR_CLIENT_ID = 'DonnaTestClient';
  process.env.PROCOUNTOR_CLIENT_SECRET = 'secret-xyz';
  process.env.PROCOUNTOR_REDIRECT_URI = 'https://www.donnamail.example/api/donna/firms/procountor/callback';
  delete process.env.PROCOUNTOR_ENVIRONMENT; // default test host
  const calls = stubTokenFetch({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
  const token = await exchangeProcountorCode({ code: 'auth-code', redirectUri: process.env.PROCOUNTOR_REDIRECT_URI });
  assert.equal(token.accessToken, 'at');
  assert.equal(token.refreshToken, 'rt');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://pts-api.procountor.com/api/oauth/token');
  // No HTTP Basic — Procountor documents credentials as form fields only.
  assert.equal(calls[0].options.headers.Authorization, undefined);
  const params = new URLSearchParams(calls[0].options.body.toString());
  assert.equal(params.get('grant_type'), 'authorization_code');
  assert.equal(params.get('code'), 'auth-code');
  assert.equal(params.get('client_id'), 'DonnaTestClient');
  assert.equal(params.get('client_secret'), 'secret-xyz');
  assert.equal(params.get('redirect_uri'), 'https://www.donnamail.example/api/donna/firms/procountor/callback');
});

await test('refreshProcountorToken sends client credentials + refresh_token in the form body', async () => {
  process.env.PROCOUNTOR_CLIENT_ID = 'DonnaTestClient';
  process.env.PROCOUNTOR_CLIENT_SECRET = 'secret-xyz';
  delete process.env.PROCOUNTOR_ENVIRONMENT;
  const calls = stubTokenFetch({ access_token: 'at2', refresh_token: 'rt2', expires_in: 3600 });
  const token = await refreshProcountorToken({ refreshToken: 'old-rt' });
  assert.equal(token.accessToken, 'at2');
  assert.equal(calls[0].url, 'https://pts-api.procountor.com/api/oauth/token');
  assert.equal(calls[0].options.headers.Authorization, undefined);
  const params = new URLSearchParams(calls[0].options.body.toString());
  assert.equal(params.get('grant_type'), 'refresh_token');
  assert.equal(params.get('refresh_token'), 'old-rt');
  assert.equal(params.get('client_id'), 'DonnaTestClient');
  assert.equal(params.get('client_secret'), 'secret-xyz');
});

await test('getProcountorConfig trims whitespace off the credentials (paste-safety)', () => {
  process.env.PROCOUNTOR_CLIENT_ID = ' DonnaTestClient\n';
  process.env.PROCOUNTOR_CLIENT_SECRET = 'secret_abc \n';
  const config = getProcountorConfig();
  assert.equal(config.clientId, 'DonnaTestClient');
  assert.equal(config.clientSecret, 'secret_abc');
});

await test('exchangeProcountorCode surfaces the OAuth error code + description on client-auth failure', async () => {
  process.env.PROCOUNTOR_CLIENT_ID = 'DonnaTestClient';
  process.env.PROCOUNTOR_CLIENT_SECRET = 'wrong-secret';
  delete process.env.PROCOUNTOR_ENVIRONMENT;
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ error: 'invalid_client', error_description: 'Client authentication failed' })
  });
  await assert.rejects(
    exchangeProcountorCode({ code: 'c', redirectUri: 'https://www.donnamail.example/cb' }),
    /Client authentication failed \(invalid_client\) \[HTTP 401\]/
  );
});

await test('exchangeProcountorApiKey mints via client_credentials with the (trimmed) api key in the form body', async () => {
  process.env.PROCOUNTOR_CLIENT_ID = 'DonnaTestClient';
  process.env.PROCOUNTOR_CLIENT_SECRET = 'secret-xyz';
  process.env.PROCOUNTOR_REDIRECT_URI = 'https://www.donnamail.example/api/donna/firms/procountor/callback';
  delete process.env.PROCOUNTOR_ENVIRONMENT;
  const calls = stubTokenFetch({ access_token: 'm2m-at', expires_in: 3600, scope: 'm2m' });
  const token = await exchangeProcountorApiKey({ apiKey: ' the-api-key \n' });
  assert.equal(token.accessToken, 'm2m-at');
  assert.equal(calls[0].url, 'https://pts-api.procountor.com/api/oauth/token');
  assert.equal(calls[0].options.headers.Authorization, undefined);
  const params = new URLSearchParams(calls[0].options.body.toString());
  assert.equal(params.get('grant_type'), 'client_credentials');
  assert.equal(params.get('api_key'), 'the-api-key');
  assert.equal(params.get('client_id'), 'DonnaTestClient');
  assert.equal(params.get('client_secret'), 'secret-xyz');
  assert.equal(params.get('redirect_uri'), 'https://www.donnamail.example/api/donna/firms/procountor/callback');
});

await test('exchangeProcountorApiKey requires an api key', async () => {
  process.env.PROCOUNTOR_CLIENT_ID = 'DonnaTestClient';
  process.env.PROCOUNTOR_CLIENT_SECRET = 'secret-xyz';
  await assert.rejects(exchangeProcountorApiKey({ apiKey: '   ' }), /API key is required/);
});

await test('decodeProcountorTokenClaims reads the JWT payload, {} for opaque/garbage tokens', () => {
  assert.equal(decodeProcountorTokenClaims(makeJwt({ cid: '12345', sub: 'user-9' })).cid, '12345');
  assert.deepEqual(decodeProcountorTokenClaims(''), {});
  assert.deepEqual(decodeProcountorTokenClaims('opaque-non-jwt-token'), {});
  assert.deepEqual(decodeProcountorTokenClaims('a.!!notbase64!!.c'), {});
});

await test('resolveProcountorCompanyId falls back to the token cid (callback carries no company id)', () => {
  // The documented auth-code path: no callback company id, cid in the token.
  const viaToken = resolveProcountorCompanyId({ companyId: '', accessToken: makeJwt({ cid: '778899' }) });
  assert.equal(viaToken.companyId, '778899');
  // An explicit callback param (M2M / future-proofing) wins over the claim.
  const viaParam = resolveProcountorCompanyId({ companyId: 'PARAM-1', accessToken: makeJwt({ cid: '778899' }) });
  assert.equal(viaParam.companyId, 'PARAM-1');
  // Neither present → empty, which the writer surfaces as a hard 502.
  assert.equal(resolveProcountorCompanyId({ companyId: '', accessToken: 'opaque' }).companyId, '');
});

await test('resolveProcountorRedirectUri uses the single registered URI over the host-derived one', () => {
  // Procountor registers ONE redirect URI; a connect from a preview host must
  // still send the registered URI or the login code never redirects back.
  process.env.PROCOUNTOR_REDIRECT_URI = 'https://www.donnamail.example/api/donna/firms/procountor/callback';
  assert.equal(
    resolveProcountorRedirectUri('https://books-app.example/api/donna/firms/procountor/callback'),
    'https://www.donnamail.example/api/donna/firms/procountor/callback'
  );
  // Unset env → fall back to the host-derived value (local/dev).
  delete process.env.PROCOUNTOR_REDIRECT_URI;
  assert.equal(resolveProcountorRedirectUri('https://localhost:3000/cb'), 'https://localhost:3000/cb');
});

await test('normalizeProcountorConnection accepts callback company identifiers', () => {
  assert.deepEqual(normalizeProcountorConnection({ company_id: '123', organization_name: 'Oy Test Ab' }), {
    companyId: '123',
    organizationName: 'Oy Test Ab',
    payload: { company_id: '123', organization_name: 'Oy Test Ab' }
  });
});

// ── Reference-data reads (verb 2.1b) ───────────────────────────────────────

// Stub fetch keyed by URL substring so a single test can serve several
// reference endpoints. Returns the recorded requests for header/query assertions.
const stubResourceFetch = (byPath = {}) => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const key = Object.keys(byPath).find((fragment) => String(url).includes(fragment));
    const body = key ? byPath[key](String(url)) : {};
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return calls;
};

await test('fetchProcountorResource GETs <base>/api/<path> with the access token as a Bearer', async () => {
  delete process.env.PROCOUNTOR_ENVIRONMENT;
  const calls = stubResourceFetch({ '/api/coa': () => ({ ledgerAccounts: [] }) });
  await fetchProcountorResource({ accessToken: 'at-1', environment: 'test', path: 'coa' });
  assert.equal(calls[0].url, 'https://pts-api.procountor.com/api/coa');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer at-1');
});

await test('fetchProcountorResource requires an access token', async () => {
  await assert.rejects(fetchProcountorResource({ path: 'coa' }), /access token is required/);
});

await test('fetchProcountorPagedResults walks pages until resultCount is reached', async () => {
  const page0 = { results: [{ id: 1 }, { id: 2 }], meta: { pageNumber: 0, pageSize: 2, resultCount: 3 } };
  const page1 = { results: [{ id: 3 }], meta: { pageNumber: 1, pageSize: 2, resultCount: 3 } };
  const calls = stubResourceFetch({
    '/api/businesspartners': (url) => (url.includes('pageNumber=1') ? page1 : page0)
  });
  const rows = await fetchProcountorPagedResults({
    accessToken: 'at-1',
    environment: 'test',
    path: 'businesspartners',
    pageSize: 2
  });
  assert.deepEqual(rows.map((r) => r.id), [1, 2, 3]);
  // Two pages fetched (0 and 1), then stop — collected 3 >= resultCount 3.
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.includes('pageNumber=0'));
  assert.ok(calls[1].url.includes('pageNumber=1'));
});

await test('fetchProcountorPagedResults stops on a short/empty page without a resultCount', async () => {
  const calls = stubResourceFetch({
    '/api/bankaccounts': () => ({ results: [{ id: 15060 }], meta: { pageNumber: 0, pageSize: 100 } })
  });
  const rows = await fetchProcountorPagedResults({ accessToken: 'at-1', environment: 'test', path: 'bankaccounts' });
  assert.deepEqual(rows.map((r) => r.id), [15060]);
  assert.equal(calls.length, 1); // one short page (1 < pageSize 100) ends the walk
});

await test('normalizeProcountorLedgerAccount: code is the id; en/sv come off translations', () => {
  const account = normalizeProcountorLedgerAccount({
    ledgerAccountCode: '1020',
    name: 'Kehittämismenot',
    active: true,
    translations: [
      { languageCode: 'fi', translation: 'Kehittämismenot' },
      { languageCode: 'en', translation: 'Development expenses' },
      { languageCode: 'sv', translation: 'Utvecklingsutgifter' }
    ]
  });
  assert.equal(account.ledgerAccountCode, '1020');
  assert.equal(account.name, 'Kehittämismenot');
  assert.equal(account.nameEn, 'Development expenses');
  assert.equal(account.nameSv, 'Utvecklingsutgifter');
  assert.equal(account.active, true);
});

await test('normalizeProcountorLedgerAccount: missing translations degrade to empty strings, active defaults true', () => {
  const account = normalizeProcountorLedgerAccount({ ledgerAccountCode: '3000', name: 'Myynti' });
  assert.equal(account.nameEn, '');
  assert.equal(account.nameSv, '');
  assert.equal(account.active, true);
});

await test('normalizeProcountorBusinessPartner: carries the type enum and registryInfo.active', () => {
  const partner = normalizeProcountorBusinessPartner({
    id: 1700186,
    name: 'Test',
    type: 'PERSON',
    registryInfo: { active: true },
    version: '2026-07-08T08:31:14'
  });
  assert.equal(partner.partnerId, '1700186');
  assert.equal(partner.name, 'Test');
  assert.equal(partner.partnerType, 'PERSON');
  assert.equal(partner.active, true);
  assert.equal(partner.version, '2026-07-08T08:31:14');
});

await test('normalizeProcountorBankAccount: maps iban/bic/currency + the default flags', () => {
  const bankAccount = normalizeProcountorBankAccount({
    id: 15060,
    accountNumber: '998998-2070',
    iban: 'FI5999899800002070',
    bic: 'NDEAFIHH',
    bankName: 'Nordea',
    currency: 'EUR',
    defaultForInvoice: true,
    defaultForPayment: false,
    status: 'ACTIVE',
    orderNo: 1,
    version: '2026-07-08T08:32:00'
  });
  assert.equal(bankAccount.bankAccountId, '15060');
  assert.equal(bankAccount.iban, 'FI5999899800002070');
  assert.equal(bankAccount.bic, 'NDEAFIHH');
  assert.equal(bankAccount.currency, 'EUR');
  assert.equal(bankAccount.defaultForInvoice, true);
  assert.equal(bankAccount.defaultForPayment, false);
  assert.equal(bankAccount.orderNo, 1);
});

await test('normalizeProcountorDimension: keys on id, falls back to name, keeps raw payload', () => {
  assert.equal(normalizeProcountorDimension({ id: 42, name: 'Project A' }).dimensionId, '42');
  const byName = normalizeProcountorDimension({ name: 'Cost center 1', active: false });
  assert.equal(byName.dimensionId, 'Cost center 1');
  assert.equal(byName.active, false);
  assert.deepEqual(byName.payload, { name: 'Cost center 1', active: false });
});
