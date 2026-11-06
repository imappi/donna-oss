import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
let api, directory, dom;
const oldWindow = globalThis.window, oldFetch = globalThis.fetch;
const session = (id) => ({ access_token: `synthetic-${id}`, refresh_token: `refresh-${id}`, user: null });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
before(async () => {
  dom = new JSDOM('', { url: 'https://synthetic.invalid/firms' });
  globalThis.window = dom.window;
  directory = await mkdtemp(resolve('.auth-lifecycle-test-'));
  await build({ stdin: { contents: `export * from './src/lib/supabaseAuth.js'; export * from './src/lib/accessToken.js'; export { firmFetch } from './src/lib/firmApi.js';`, resolveDir: process.cwd() }, outfile: `${directory}/auth.mjs`, bundle: true, format: 'esm', platform: 'node', define: { 'import.meta.env': JSON.stringify({ VITE_SUPABASE_URL: 'https://synthetic.invalid', VITE_SUPABASE_PUBLISHABLE_KEY: 'synthetic-public' }) }, logLevel: 'silent' });
  api = await import(pathToFileURL(`${directory}/auth.mjs`));
});
beforeEach(() => { window.localStorage.clear(); globalThis.fetch = () => { throw new Error('Unexpected request'); }; });
after(async () => { globalThis.fetch = oldFetch; globalThis.window = oldWindow; dom.window.close(); await rm(directory, { recursive: true, force: true }); });

test('actual implicit OAuth capture retires legacy operator credentials and hydrates verified user', async () => {
  api.saveAccessToken('synthetic-operator');
  dom.reconfigure({ url: 'https://synthetic.invalid/firms#access_token=synthetic-oauth&refresh_token=synthetic-refresh&expires_in=3600' });
  assert.equal(api.consumeOAuthRedirect().session, true);
  assert.equal(api.getAuthSession().user, null);
  assert.equal(api.getAccessToken(), '');
  assert.equal(window.location.hash, '');
  const user = { id: 'verified-a', email: 'a@synthetic.invalid' };
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://synthetic.invalid/auth/v1/user');
    assert.equal(options.headers.Authorization, 'Bearer synthetic-oauth');
    return response(user);
  };
  assert.deepEqual(await api.hydrateAuthUser(), user);
  assert.deepEqual(api.getAuthSession().user, user);
});
test('Google OAuth always requests account selection without changing redirect', () => {
  let destination;
  globalThis.window = { location: { origin: 'https://synthetic.invalid', assign: (url) => { destination = new URL(url); } } };
  try { api.startGoogleSignIn('/start'); } finally { globalThis.window = dom.window; }
  assert.equal(destination.searchParams.get('provider'), 'google');
  assert.equal(destination.searchParams.get('prompt'), 'select_account');
  assert.equal(destination.searchParams.get('redirect_to'), 'https://synthetic.invalid/start');
});
test('legacy dual storage sends one Supabase identity in both headers and successful credential switches are exclusive', () => {
  api.saveAuthSession(session('a'));
  window.localStorage.setItem('donna.access_token.v1', 'stale-operator');
  assert.deepEqual(api.withAccessHeaders(), { Authorization: 'Bearer synthetic-a', 'X-Donna-Access-Token': 'synthetic-a' });
  api.saveAuthSession(session('b'));
  assert.equal(api.getAccessToken(), '');
  api.saveAccessToken('chosen-operator');
  assert.equal(api.getAuthSession(), null);
  assert.equal(api.withAccessHeaders()['X-Donna-Access-Token'], 'chosen-operator');
});
for (const action of ['logout', 'swap']) {
  for (const result of ['success', 'rejected', 'late body']) {
    test(`refresh ${result} cannot overwrite ${action}`, async () => {
      api.saveAuthSession(session('a'));
      const pending = deferred();
      globalThis.fetch = () => result === 'late body' ? Promise.resolve({ ok: true, json: () => pending.promise }) : pending.promise;
      const work = api.refreshAuthSession();
      await Promise.resolve();
      api.clearFirmAccess();
      if (action === 'swap') api.saveAuthSession(session('b'));
      const expected = api.getAuthSession();
      pending.resolve(result === 'late body' ? session('stale') : response(session('stale'), result === 'rejected' ? 401 : 200));
      assert.equal(await work, null);
      assert.deepEqual(api.getAuthSession(), expected);
    });
  }
  test(`verified identity response cannot resurrect ${action}`, async () => {
    api.saveAuthSession(session('a'));
    const pending = deferred();
    globalThis.fetch = () => pending.promise;
    const work = api.hydrateAuthUser();
    api.clearFirmAccess();
    if (action === 'swap') api.saveAuthSession(session('b'));
    const expected = api.getAuthSession();
    pending.resolve(response({ id: 'a', email: 'a@synthetic.invalid' }));
    assert.equal(await work, null);
    assert.deepEqual(api.getAuthSession(), expected);
  });
}
test('new account refresh is not coalesced with obsolete account request', async () => {
  const a = deferred(), b = deferred();
  api.saveAuthSession(session('a'));
  globalThis.fetch = (url, options) => JSON.parse(options.body).refresh_token === 'refresh-a' ? a.promise : b.promise;
  const first = api.refreshAuthSession();
  api.saveAuthSession(session('b'));
  const second = api.refreshAuthSession();
  a.resolve(response(session('stale')));
  assert.equal(await first, null);
  b.resolve(response(session('b-fresh')));
  assert.ok(await second);
  assert.equal(api.getAuthSession().access_token, 'synthetic-b-fresh');
});
test('password sign-in in flight cannot undo logout', async () => {
  const pending = deferred();
  globalThis.fetch = () => pending.promise;
  const work = api.signInWithPassword({ email: 'a@synthetic.invalid', password: 'synthetic-password' });
  api.clearFirmAccess();
  pending.resolve(response(session('late')));
  await assert.rejects(work, /superseded/);
  assert.equal(api.getAuthSession(), null);
});
for (const first of ['identity', 'refresh']) {
  test(`concurrent identity hydration and token refresh preserve the rotated session (${first} first)`, async () => {
    api.saveAuthSession(session('a'));
    const identity = deferred(), refresh = deferred();
    const user = { id: 'a', email: 'a@synthetic.invalid' };
    globalThis.fetch = (url) => String(url).endsWith('/user') ? identity.promise : refresh.promise;
    const identityWork = api.hydrateAuthUser(), refreshWork = api.refreshAuthSession();
    if (first === 'identity') { identity.resolve(response(user)); await identityWork; }
    refresh.resolve(response({ ...session('rotated'), user }));
    assert.ok(await refreshWork);
    if (first === 'refresh') { identity.resolve(response(user)); assert.equal(await identityWork, null); }
    assert.equal(api.getAuthSession().access_token, 'synthetic-rotated');
    assert.deepEqual(api.getAuthSession().user, user);
  });
}
test('rejected Supabase refresh cannot reveal a historical operator credential', async () => {
  api.saveAuthSession(session('a'));
  window.localStorage.setItem('donna.access_token.v1', 'historical-operator');
  globalThis.fetch = async () => response({}, 401);
  assert.equal(await api.refreshAuthSession(), null);
  assert.equal(api.hasStoredAuth(), false);
  assert.deepEqual(api.withAccessHeaders(), {});
});
test('cross-tab account replacement invalidates a late user response', async () => {
  api.saveAuthSession(session('a'));
  const pending = deferred();
  globalThis.fetch = () => pending.promise;
  const work = api.hydrateAuthUser();
  // Other tabs bypass this module's revision counter.
  window.localStorage.setItem('donna.auth_session.v1', JSON.stringify(session('b')));
  pending.resolve(response({ id: 'a', email: 'a@synthetic.invalid' }));
  assert.equal(await work, null);
  assert.equal(api.getAuthSession().access_token, 'synthetic-b');
});
for (const status of [200, 401]) {
  test(`actual firmFetch drops an old account's delayed ${status} without refreshing or replaying under the new account`, async () => {
    api.saveAuthSession({ ...session('a'), user: { id: 'a' } });
    const pending = deferred(), calls = [];
    globalThis.fetch = (url, options) => { calls.push({ url, options }); return pending.promise; };
    const work = api.firmFetch('/api/donna/firms/clients/a/profile', { method: 'POST', body: JSON.stringify({ company_name: 'A only' }) });
    api.saveAuthSession({ ...session('b'), user: { id: 'b' } });
    pending.resolve(response({}, status));
    await assert.rejects(work, { code: 'AUTH_SESSION_CHANGED' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.headers.Authorization, 'Bearer synthetic-a');
    assert.equal(api.getAuthSession().access_token, 'synthetic-b');
  });
}
test('actual firmFetch refreshes and retries the same account under its rotated token', async () => {
  api.saveAuthSession({ ...session('a'), user: { id: 'a' } });
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (String(url).includes('/auth/v1/token')) return response({ ...session('rotated'), user: { id: 'a' } });
    return response({}, calls.length === 1 ? 401 : 200);
  };
  assert.equal((await api.firmFetch('/api/donna/firms/clients/a/profile', { method: 'POST', body: 'same-body' })).status, 200);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].options.headers.Authorization, 'Bearer synthetic-rotated');
  assert.equal(calls[2].options.body, 'same-body');
});
for (const otherTab of [false, true]) {
test(`same-user explicit re-login cannot inherit an old request refresh failure (other tab: ${otherTab})`, async () => {
  api.saveAuthSession({ ...session('a'), user: { id: 'a' } });
  const refresh = deferred();
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  globalThis.fetch = (url) => {
    if (String(url).includes('/auth/v1/token')) { started(); return refresh.promise; }
    return Promise.resolve(response({}, 401));
  };
  const work = api.firmFetch('/api/donna/firms/snapshot');
  await startedPromise;
  const next = { ...session('a-new-login'), user: { id: 'a' } };
  if (otherTab) window.localStorage.setItem('donna.auth_session.v1', JSON.stringify(next));
  else api.saveAuthSession(next);
  refresh.resolve(response({}, 401));
  await assert.rejects(work, { code: 'AUTH_SESSION_CHANGED' });
  assert.equal(api.getAuthSession().access_token, 'synthetic-a-new-login');
});

}
