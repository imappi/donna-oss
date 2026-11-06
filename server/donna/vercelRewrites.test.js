// Vercel rewrite ↔ handler parity guard.
//
// Production routes /api/donna/* through an EXPLICIT per-path rewrite
// allowlist in vercel.json (the SPA catch-all excludes /api/*), while
// the vite dev server mounts the same handlers by PREFIX. A route added
// to a handler without its rewrite therefore works in dev and 404s at
// the platform in prod — which is exactly how /bizfile/intake-draft
// shipped broken: the FE surfaced Vercel's keyless 404 body as a
// generic "could not read this document".
//
// This test extracts every literal `requestUrl.pathname === '/x'` route
// from the simple prefix handlers in api.js (bizfile, bank-statement)
// and asserts each has a matching rewrite. The /firms handler is out of
// scope here — its routes use dynamic regex matches that this literal
// scan can't enumerate.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
const apiSource = readFileSync(resolvePath(repoRoot, 'server', 'donna', 'api.js'), 'utf8');
const vercelConfig = JSON.parse(readFileSync(resolvePath(repoRoot, 'vercel.json'), 'utf8'));

const rewriteSources = new Set((vercelConfig.rewrites || []).map((rule) => rule.source));

test('runtime repair claim and retry actions are routed on the deployed surface', () => {
  assert.ok(rewriteSources.has('/api/donna/firms/runtime-policy-incidents/:id/:action'));
});

// Slice the handler function body out of api.js source: from its
// declaration to the next top-level `const` declaration.
const handlerBody = (name) => {
  const start = apiSource.indexOf(`const ${name} = async (req, res)`);
  assert.ok(start >= 0, `${name} found in api.js`);
  const rest = apiSource.slice(start + 1);
  const end = rest.search(/\nconst [A-Za-z]/);
  return end >= 0 ? rest.slice(0, end) : rest;
};

const literalRoutesIn = (body) =>
  [...body.matchAll(/requestUrl\.pathname === '(\/[^']*)'/g)].map((match) => match[1]);

const PREFIX_HANDLERS = [
  { name: 'donnaBizfileApiHandler', prefix: '/api/donna/bizfile' }
  // (donnaBankStatementApiHandler — the synchronous /bank-statement/extract
  // route — was deleted in RT-14 with its rewrite; the tray registers every
  // statement through /documents/register.)
  // NOTE: donnaBillingApiHandler is intentionally NOT scanned here. Its
  // declaration is followed by `export const handleDonnaApiRequest`, and this
  // file's body-slicer stops only at a top-level `const` (not `export const`),
  // so the slice would bleed into handleDonnaApiRequest and misread the
  // webhook's full-path literal. The billing rewrites (status/checkout/portal/
  // webhook) are maintained by hand in vercel.json.
];

for (const { name, prefix } of PREFIX_HANDLERS) {
  await test(`every literal route in ${name} has a vercel.json rewrite`, () => {
    const routes = literalRoutesIn(handlerBody(name));
    assert.ok(routes.length > 0, `${name} declares at least one literal route`);
    for (const route of routes) {
      const source = `${prefix}${route}`;
      assert.ok(
        rewriteSources.has(source),
        `vercel.json is missing a rewrite for ${source} — the route works in dev (prefix mount) but 404s in prod`
      );
    }
  });
}

// The /firms handler's DYNAMIC regex routes (/:id-style) can't be
// enumerated by this literal scan — those rewrites stay hand-pinned
// (see the ask-batches send pin below). But every literal
// `requestUrl.pathname === '/x'` route CAN be, and this bug class kept
// shipping through the firms handler precisely because it was scoped
// out here: transaction-intel/batch-suggest 404'd the moment a working
// "Run AI coding" button called it (#317-era), then ask-batches/draft
// 404'd on its first live validation (#328) — and the full scan also
// caught /reconciliation-matches (manual-link POST) and
// /transaction-chat/unread-summary 404ing in prod since they shipped.
// The root '/' alias is excluded — it rides the snapshot rewrite.
await test('every literal route in donnaFirmsApiHandler has a vercel.json rewrite', () => {
  const routes = literalRoutesIn(handlerBody('donnaFirmsApiHandler'))
    .filter((route) => route !== '/');
  assert.ok(routes.length >= 40, 'firms handler declares its literal routes');
  for (const route of routes) {
    const source = `/api/donna/firms${route}`;
    assert.ok(
      rewriteSources.has(source),
      `vercel.json is missing a rewrite for ${source} — works in dev (prefix mount), 404s in prod`
    );
  }
});

// Dynamic-route pins for the ask-batch send path (the literal scan
// above can't see regex-matched routes).
await test('the ask-batches send rewrite is pinned', () => {
  assert.ok(
    rewriteSources.has('/api/donna/firms/ask-batches/:id/send'),
    'vercel.json is missing the /api/donna/firms/ask-batches/:id/send rewrite'
  );
});

await test('the match-authorization (confirm/grant/decline) rewrite is pinned', () => {
  // #5 Slice 3b — the AUTHORITY confirm-vs-grant action is a dynamic governance
  // route (regex match in donnaFirmsApiHandler), invisible to the literal scan,
  // so pin it here: without the rewrite it works in dev (prefix mount) yet 404s in
  // prod, stranding every materiality-held line on a firm click it can't deliver.
  assert.ok(
    rewriteSources.has('/api/donna/firms/reconciliation-matches/:id/authorization'),
    'vercel.json is missing the /api/donna/firms/reconciliation-matches/:id/authorization rewrite'
  );
});

await test('the firm-facts dismiss rewrite is pinned', () => {
  // Dynamic governance route — the literal scan can't see the regex match in
  // donnaFirmsApiHandler, so pin it here so the dismiss endpoint cannot work in
  // dev (prefix mount) yet 404 in prod for want of a rewrite.
  assert.ok(
    rewriteSources.has('/api/donna/firms/firm-facts/:id/dismiss'),
    'vercel.json is missing the /api/donna/firms/firm-facts/:id/dismiss rewrite'
  );
});

await test('the memory-candidate promote/dismiss rewrites are pinned', () => {
  // Donna Loops Phase 6.2 — the first Loops WRITE surface. Dynamic governance
  // routes the literal scan can't see (regex match in donnaFirmsApiHandler), so
  // pin them here so promote/dismiss cannot work in dev (prefix mount) yet 404 in
  // prod for want of a rewrite. (The literal GET /memory-candidates is caught by
  // the firms-handler literal scan above.)
  assert.ok(
    rewriteSources.has('/api/donna/firms/memory-candidates/:id/promote'),
    'vercel.json is missing the /api/donna/firms/memory-candidates/:id/promote rewrite'
  );
  assert.ok(
    rewriteSources.has('/api/donna/firms/memory-candidates/:id/dismiss'),
    'vercel.json is missing the /api/donna/firms/memory-candidates/:id/dismiss rewrite'
  );
});

// The marketing admin handler (marketingRoutes.js) routes on subPath
// literals under the /api/donna/marketing/admin prefix — same bug class as
// the firms handler: works in dev (prefix mount), 404s in prod without an
// explicit rewrite. Scan the literals; pin the dynamic (:id-style) routes.
await test('every literal marketing admin route has a vercel.json rewrite', () => {
  const marketingSource = readFileSync(
    resolvePath(repoRoot, 'server', 'donna', 'marketing', 'marketingRoutes.js'),
    'utf8'
  );
  const routes = [...marketingSource.matchAll(/subPath === '(\/[^']+)'/g)].map((match) => match[1]);
  assert.ok(routes.length >= 4, 'marketing admin handler declares its literal routes');
  for (const route of routes) {
    const source = `/api/donna/marketing/admin${route}`;
    assert.ok(
      rewriteSources.has(source),
      `vercel.json is missing a rewrite for ${source} — works in dev (prefix mount), 404s in prod`
    );
  }
});

await test('the dynamic marketing admin rewrites are pinned', () => {
  for (const source of [
    '/api/donna/marketing/admin/drafts/:draftId/approve-send',
    '/api/donna/marketing/admin/drafts/:draftId/reject',
    '/api/donna/marketing/admin/prospects/:prospectId/decide',
    '/api/donna/marketing/unsubscribe'
  ]) {
    assert.ok(rewriteSources.has(source), `vercel.json is missing a rewrite for ${source}`);
  }
});

await test('the intake-draft rewrite points at the donna router', () => {
  const rule = (vercelConfig.rewrites || []).find(
    (entry) => entry.source === '/api/donna/bizfile/intake-draft'
  );
  assert.ok(rule, 'intake-draft rewrite present');
  assert.equal(rule.destination, '/api/donna-router?path=bizfile/intake-draft');
});

await test('the public outbound + inbound-webhook rewrites are pinned', () => {
  // These handlers live in handleDonnaApiRequest (not the scanned prefix
  // handlers), so the literal scans above can't see them. Without a rewrite
  // each works in dev (prefix mount) and 404s in prod — for the unsubscribe
  // and approval links that means dead URLs in already-delivered email, and
  // for the webhooks a provider endpoint that can never be configured on the
  // pretty path.
  for (const source of [
    '/api/donna/outbound/unsubscribe',
    '/api/donna/outbound/approval',
    '/api/donna/outbound/paylink-webhook',
    '/api/donna/outbound/reply-webhook',
    '/api/donna/marketing/inbound-webhook'
  ]) {
    assert.ok(rewriteSources.has(source), `vercel.json is missing a rewrite for ${source}`);
  }
});

await test('the hosted MCP endpoint rewrites are pinned (never under /.well-known — Vercel reserves it)', () => {
  // docs/design-donna-chatgpt-app-build-brief.md §8: the remote transport,
  // its anonymous demo and its RFC 9728 metadata live in handleDonnaApiRequest
  // (not a scanned prefix handler), so pin them here. The metadata is served
  // under /api/donna/mcp/oauth-protected-resource/… and named in the 401
  // challenge; a /.well-known rewrite would be silently ignored by Vercel.
  for (const source of [
    '/api/donna/mcp/remote/:surface',
    '/api/donna/mcp/demo',
    '/api/donna/mcp/demo/:surface',
    '/api/donna/mcp/oauth-protected-resource/:path*'
  ]) {
    assert.ok(rewriteSources.has(source), `vercel.json is missing a rewrite for ${source}`);
  }
  assert.equal(
    [...rewriteSources].some((source) => source.startsWith('/.well-known')),
    false,
    'no rewrite may target /.well-known — Vercel reserves that path and the rule would be dead'
  );
});

// Exercise the configured route through the actual deployed entrypoint, rather
// than merely pinning a second copy of its source string. The adapter models
// the literal/:parameter rewrite subset used by this API allowlist.
await test('configured readiness Retry rewrite reaches the real authenticated, scoped handler', {
  skip: !process.env.DONNA_PG_TEST_URL && 'INCOMPLETE: real PostgreSQL required'
}, async () => {
  const { createServer } = await import('node:http');
  const { bootApplianceForTest } = await import('./testSupport/applianceHarness.js');
  const { default: router } = await import('../../api/donna-router.js');
  const appliance = await bootApplianceForTest({ keys: { openai: true, anthropic: false } });
  const savedFetch = globalThis.fetch;
  const envKeys = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'DONNA_AUTH_ALLOWED_EMAILS'];
  const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  let server;
  try {
    const { clientId } = await appliance.createClient({ profile: {
      companyName: 'Reittitesti Oy', jurisdiction: 'FI', entityType: 'fi-oy', accountingCurrency: 'EUR'
    } });
    const member = (await appliance.query('select email from firm_members where id=$1', [appliance.memberId])).rows[0];
    await appliance.query("insert into firm_collaborators(id,firm_id,user_id,email,name,status) values($1,$2,'route-owner','owner@fixture.invalid','Synthetic owner','active')", [`${appliance.firmId}-owner`, appliance.firmId]);
    const foreignFirmId = `${appliance.firmId}-foreign`;
    await appliance.query("insert into firms(id,name,slug) values($1,'Synthetic other firm',$1)", [foreignFirmId]);
    process.env.SUPABASE_URL = 'https://route-auth.fixture.invalid';
    process.env.SUPABASE_PUBLISHABLE_KEY = 'synthetic-public-key';
    process.env.DONNA_AUTH_ALLOWED_EMAILS = member.email;
    globalThis.fetch = async (url, options) => {
      if (String(url) === 'https://route-auth.fixture.invalid/auth/v1/user') {
        const memberToken = options.headers.Authorization === 'Bearer synthetic-member';
        const ownerToken = options.headers.Authorization === 'Bearer synthetic-owner';
        return new Response(JSON.stringify({ id: memberToken ? 'route-member' : ownerToken ? 'route-owner' : 'route-outsider',
          email: memberToken ? member.email : ownerToken ? 'owner@fixture.invalid' : 'outsider@fixture.invalid' }), { status: 200 });
      }
      return savedFetch(url, options);
    };
    server = createServer((req, res) => {
      const pathname = new URL(req.url, 'http://fixture').pathname;
      const actual = pathname.split('/');
      for (const rule of vercelConfig.rewrites) {
        const template = rule.source.split('/');
        if (template.length !== actual.length) continue;
        const params = {};
        if (!template.every((part, index) => {
          if (/^:[A-Za-z]+$/.test(part)) { params[part] = actual[index]; return Boolean(actual[index]); }
          return part === actual[index];
        })) continue;
        req.url = rule.destination.replace(/:[A-Za-z]+/g, name => params[name]);
        router(req, res);
        return;
      }
      res.statusCode = 404; res.end('The page could not be found');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const path = `/api/donna/firms/clients/${encodeURIComponent(clientId)}/readiness/retry`;
    const post = async (token, body = {}) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ firm_id: appliance.firmId, ...body }), signal: AbortSignal.timeout(10000)
      });
      return { status: response.status, text: await response.text() };
    };
    const anonymous = await post();
    assert.equal(anonymous.status, 401, anonymous.text);
    assert.equal(JSON.parse(anonymous.text).code, 'AUTH_REQUIRED');
    const before = await appliance.read.readiness(clientId);
    const outsider = await post('synthetic-outsider');
    assert.ok([401, 403].includes(outsider.status), outsider.text);
    const owner = await post('synthetic-owner');
    assert.equal(owner.status, 403, owner.text);
    assert.match(JSON.parse(owner.text).error, /Firm member access is required/);
    const memberResult = await post('synthetic-member');
    assert.equal(memberResult.status, 200, memberResult.text);
    assert.ok(JSON.parse(memberResult.text).clients.some(client => client.id === clientId));
    const wrongFirm = await post('synthetic-member', { firm_id: foreignFirmId });
    assert.equal(wrongFirm.status, 403, wrongFirm.text);
    const after = await appliance.read.readiness(clientId);
    assert.equal(after.saga_id, before.saga_id, 'rewrite preserves the exact client and existing saga');
    assert.equal(after.latest_attempt_id, before.latest_attempt_id, 'ready retry is idempotent; denied callers do not mutate it');
  } finally {
    globalThis.fetch = savedFetch;
    for (const [key, value] of Object.entries(savedEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await appliance.stop();
  }
});
