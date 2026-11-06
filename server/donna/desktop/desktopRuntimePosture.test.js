// The load-bearing posture test (design-donna-desktop-runtime-on.md §4):
// with the desktop host signal present and the S1 defaults applied to a
// virgin env, every gate in the spec's inventory resolves to its Desktop
// posture — asserted as BEHAVIOUR where the behaviour is reachable without
// a database (RT-14, audit F-20: the host-class fence answers a request; the
// manifest schedules functions; the env map alone is not the posture).
// Where a gate's predicate is EXPORTED we call it directly; the
// family matchers and parseDocumentsDb keep their predicates private (and
// are isolation-listed, so exporting them is not this slice's call) — for
// those we assert the map's value against the truthy set every one of
// those gates parses with (['1','true','yes','on'], verified at
// salesInvoiceReconciliation.js:52, billReconciliation.js:56,
// paymentConfirmationReconciliation.js:55,
// paymentAccountStatementReconciliation.js:45, parseDocumentsDb.js:1854).
// A future gate that invents new parsing breaks the direct-predicate
// calls, not this convention — add it to the map AND here.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DESKTOP_RUNTIME_ENV_DEFAULTS,
  applyDesktopHostRuntimeDefaults
} from './hostRuntimeDefaults.js';
import { DESKTOP_CLIENT_FLAG_SEEDS } from './hostPlaneSeed.js';
import { clientFlagActs } from '../clientConfig.js';
import { isLocalOcrEnabled } from '../bankStatement.js';
import { isLoopSystemEnabled, globalLoopTier } from '../loopExecutionGate.js';
import { UNIFIED_EXTRACTOR_TYPES, resolveUnifiedProvider, unifiedExtractorServes } from '../unifiedExtractor.js';
import { isDesktopHostEnv } from './hostPlaneSeed.js';
import { CLOUD_ONLY_DONNA_PATHS, handleDonnaApiRequest, isCloudOnlyDonnaPath } from '../api.js';
import { CLOUD_ONLY_PARSE_CRON_TASKS, NONE_ADAPTER_FUNCTION_IDS, buildDesktopHandlerManifest } from './handlerManifest.js';

const desktopEnv = () => {
  const env = { DONNA_DESKTOP_BLOB_DIR: '/tmp/donna-test-blobs' };
  applyDesktopHostRuntimeDefaults(env);
  return env;
};

const ENV_TRUTHY = ['1', 'true', 'yes', 'on'];

// Every key the assertions below cover, by name. The straggler test pins
// this set === the map's key set, so a future gate added to the map without
// posture coverage (or covered here but silently dropped from the map)
// fails loudly — the spec's §3 Phase-3 promise, and the §4b-v bug's tripwire.
const COVERED_KEYS = [
  'DATABASE_POOL_MAX',
  'SALES_INVOICE_MATCHER_ENABLED',
  'BILL_MATCHER_ENABLED',
  'PAYMENT_CONFIRMATION_MATCHER_ENABLED',
  'PAYMENT_ACCOUNT_STATEMENT_MATCHER_ENABLED',
  'PAYOUT_MATCHER_ENABLED',
  'BANK_STATEMENT_MATCHER_ENABLED',
  'SALES_INVOICE_AUTO_EXPLAIN_ENABLED',
  'BILL_AUTO_EXPLAIN_ENABLED',
  'RECONCILIATION_AUTO_MATCH_POLICY',
  'BILL_MATCHER_AUTO_PROMOTE_TIER_1',
  'LOOPS_TIER',
  'BANK_LINE_DISPOSITION_MODE',
  'RECONCILIATION_DISPOSITION_DRIVEN_ASK'
];

test('no stragglers: the env map and the posture coverage are the same set (S4)', () => {
  const mapKeys = Object.keys(DESKTOP_RUNTIME_ENV_DEFAULTS).sort();
  assert.deepEqual(
    mapKeys,
    [...COVERED_KEYS].sort(),
    'a map key without posture coverage (or coverage for a dropped key) — update both together'
  );
});

test('matcher wave + sweep + auto-explain env values parse as enabled', () => {
  const env = desktopEnv();
  for (const key of [
    'SALES_INVOICE_MATCHER_ENABLED',
    'BILL_MATCHER_ENABLED',
    'PAYMENT_CONFIRMATION_MATCHER_ENABLED',
    'PAYMENT_ACCOUNT_STATEMENT_MATCHER_ENABLED',
    'PAYOUT_MATCHER_ENABLED',
    'BANK_STATEMENT_MATCHER_ENABLED',
    'SALES_INVOICE_AUTO_EXPLAIN_ENABLED',
    'BILL_AUTO_EXPLAIN_ENABLED',
    'RECONCILIATION_AUTO_MATCH_POLICY',
    // Stage 2.7 deterministic promote (billReconciliation.js:69, same
    // truthy set) — without it the OpenAI-only appliance has NO path from
    // a clean bill match to auto_matched (§4b-xiii).
    'BILL_MATCHER_AUTO_PROMOTE_TIER_1'
  ]) {
    assert.ok(
      ENV_TRUTHY.includes(String(env[key]).trim().toLowerCase()),
      `${key} must resolve enabled on the desktop host (got ${env[key]})`
    );
  }
});

test('materiality ceilings are NOT in the env map: the pack governs, and the host would override every pack (RT-11b)', () => {
  // Until RT-11b the map stamped RECONCILIATION_AUTO_MATCH_MATERIALITY_CEILING=500
  // so Gate E could decide at all (§4b-xx). Since RT-11 the ceiling is declared
  // by every authored pack (reconciliation.materiality_ceiling, home currency)
  // and getAutoMatchPolicy({ jurisdiction }) reads it with env as the ONLY
  // override — so a value in this map would silently override every client's
  // pack. The same holds for the disposition ceiling (reconciliation.
  // disposition_ceiling). Both stay out; env remains the operator's override.
  for (const key of ['RECONCILIATION_AUTO_MATCH_MATERIALITY_CEILING', 'DISPOSITION_MATERIALITY_CEILING']) {
    assert.ok(!(key in DESKTOP_RUNTIME_ENV_DEFAULTS), `${key} must not be a desktop env default — the pack declares it`);
    assert.equal(desktopEnv()[key], undefined, `${key} is not stamped into env by the host`);
  }
});

test('with the host env applied, every authored pack still gives Gate E a finite ceiling (§4b-xx, re-homed on the pack)', async () => {
  const { getAutoMatchPolicy } = await import('../reconciliationLlmCore.js');
  const { listAvailablePackIds } = await import('../outbound/packs.js');
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, desktopEnv());
    for (const packId of listAvailablePackIds()) {
      const policy = getAutoMatchPolicy({ jurisdiction: packId });
      assert.ok(Number.isFinite(policy.materialityCeiling) && policy.materialityCeiling > 0,
        `${packId}: Gate E can decide on the appliance (got ${policy.materialityCeiling})`);
      assert.equal(policy.materialityCeilingSource, `pack:${packId}`, `${packId}: the pack is the source, not env`);
    }
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('desktop database pool leaves foreground headroom during reconciliation', () => {
  const env = desktopEnv();
  assert.equal(Number(env.DATABASE_POOL_MAX), 6,
    'the appliance must not inherit the two-connection cloud fallback');
});

test('extractor wave + coding auto-post arrive via plane rows, not env (S2)', () => {
  // The env map must NOT carry the plane-keyed flags — re-adding them would
  // mask a broken seed (the map dropped them when hostPlaneSeed.js landed).
  for (const key of [
    'DOCUMENT_EXTRACTORS_ENABLED',
    'DOCUMENT_LINES_ENABLED',
    'GENERIC_DOCUMENT_EXTRACTOR_ENABLED',
    'DOCUMENT_ROUTER_ENABLED',
    'CODING_AUTO_POST',
    'LEDGER_AUTO_POST'
  ]) {
    assert.ok(
      !(key in DESKTOP_RUNTIME_ENV_DEFAULTS),
      `${key} must not be in the env map — it is plane-seeded`
    );
    assert.ok(
      DESKTOP_CLIENT_FLAG_SEEDS.includes(key),
      `${key} must be in the client plane seed list`
    );
  }
  // A seeded client acts through the REAL predicate: a snapshot row at the
  // seed's stage ('auto') decides regardless of env fallback.
  const seededSnapshot = Object.fromEntries(
    DESKTOP_CLIENT_FLAG_SEEDS.map((key) => [key, { stage: 'auto', source: 'default' }])
  );
  for (const key of DESKTOP_CLIENT_FLAG_SEEDS) {
    assert.equal(
      clientFlagActs({ flagKey: key, snapshot: seededSnapshot, envFallback: () => false, env: {} }),
      true,
      `${key} must act for a seeded client with no env at all`
    );
  }
});

test('capability enforcement is the desktop default via plane row, not env (G2 PR-17)', () => {
  // Enforcement arrives as a seeded plane row (auditable, per-client,
  // reset-survivable) — never via env, which can KILL a behaviour but must
  // never silently enable one (the config-plane rail).
  assert.ok(
    !('OPERATOR_CAPABILITY_ENFORCE' in DESKTOP_RUNTIME_ENV_DEFAULTS),
    'OPERATOR_CAPABILITY_ENFORCE must not be in the env map — it is plane-seeded'
  );
  assert.ok(
    DESKTOP_CLIENT_FLAG_SEEDS.includes('OPERATOR_CAPABILITY_ENFORCE'),
    'OPERATOR_CAPABILITY_ENFORCE must be in the client plane seed list'
  );
  assert.equal(
    clientFlagActs({
      flagKey: 'OPERATOR_CAPABILITY_ENFORCE',
      snapshot: { OPERATOR_CAPABILITY_ENFORCE: { stage: 'auto', source: 'default' } },
      envFallback: () => false,
      env: {}
    }),
    true,
    'a seeded desktop client enforces capability classes with no env at all'
  );
});

test('country-pack account palette is a desktop plane default, never an env switch', () => {
  const flagKey = 'JURISDICTION_ACCOUNT_PALETTE';
  assert.ok(
    !(flagKey in DESKTOP_RUNTIME_ENV_DEFAULTS),
    `${flagKey} must not be in the env map — it is plane-seeded`
  );
  assert.ok(
    DESKTOP_CLIENT_FLAG_SEEDS.includes(flagKey),
    'desktop clients must code against the authored chart for their stored jurisdiction'
  );
  assert.equal(
    clientFlagActs({
      flagKey,
      snapshot: { [flagKey]: { stage: 'auto', source: 'default' } },
      envFallback: () => false,
      env: {}
    }),
    true
  );
});

test('receipt matcher stays on: the map must not carry an entry for it', () => {
  // RECEIPT_MATCHER_ENABLED defaults ON when unset (receiptReconciliation.js:51)
  // — an entry here would be redundant and could mask a default regression.
  assert.ok(!('RECEIPT_MATCHER_ENABLED' in DESKTOP_RUNTIME_ENV_DEFAULTS));
});

test('loop system: global ceiling canary, system enabled', () => {
  const env = desktopEnv();
  assert.equal(globalLoopTier(env), 'canary');
  assert.equal(isLoopSystemEnabled(env), true);
});

test('uncoded-residue ask lane: disposition producer mode + gather flag (2026-08-06)', () => {
  const env = desktopEnv();
  // The producer's predicate (isBankLineDispositionEnabled,
  // bankLineDispositionLlm.js:179) reads global process.env and parses
  // strictly `=== 'llm'` — assert the map's value against that exact parse,
  // same convention as the private family-matcher gates above.
  assert.equal(String(env.BANK_LINE_DISPOSITION_MODE).trim().toLowerCase(), 'llm');
  // The gather half (dispositionDrivenAskAllows, firmDb.js) parses the same
  // truthy set as the matcher wave.
  assert.ok(ENV_TRUTHY.includes(String(env.RECONCILIATION_DISPOSITION_DRIVEN_ASK).trim().toLowerCase()));
  // And deliberately NO _CLIENTS allowlist — flag on with no allowlist means
  // every client, which is exactly right on a single-firm appliance (the
  // RECONCILIATION_AUTO_MATCH_CLIENTS precedent above).
  assert.equal(env.RECONCILIATION_DISPOSITION_DRIVEN_ASK_CLIENTS, undefined);
});

test('local Swift OCR stays OFF on the desktop host (the §4b-vii gate)', () => {
  const env = desktopEnv();
  assert.equal(isLocalOcrEnabled(env), false);
});

test('the unified extractor is the desktop CODE DEFAULT for every reconcilable type — no plane row, no env, any one provider key (RT-12 closes spec row 2)', () => {
  const env = { ...desktopEnv(), DONNA_DESKTOP_BLOB_DIR: '/tmp/appliance-blobs' };
  for (const type of UNIFIED_EXTRACTOR_TYPES) {
    assert.deepEqual(unifiedExtractorServes({ documentType: type, env }), { unified: true, reason: 'appliance_default' }, type);
  }
  // bank_statement keeps its own lane; unknown keeps the generic extractor.
  assert.equal(unifiedExtractorServes({ documentType: 'bank_statement', env }).unified, false);
  assert.equal(unifiedExtractorServes({ documentType: 'unknown', env }).unified, false);
  // The map never touches the unified switches: only the kill switch closes it.
  assert.ok(!('UNIFIED_EXTRACTOR_DISABLED' in DESKTOP_RUNTIME_ENV_DEFAULTS));
  assert.deepEqual(unifiedExtractorServes({ documentType: 'receipt', env: { ...env, UNIFIED_EXTRACTOR_DISABLED: 'true' } }), { unified: false, reason: 'kill_switch' });
  // The cloud (no desktop host signal) keeps the per-type path for one release.
  assert.deepEqual(unifiedExtractorServes({ documentType: 'receipt', env: { OPENAI_API_KEY: 'sk-openai' } }), { unified: false, reason: 'cloud_per_type_release' });
  // Provider: any one key lights the lane — the OpenAI-only bridge included.
  assert.equal(resolveUnifiedProvider({ env: { OPENAI_API_KEY: 'sk-openai' } }).provider, 'openai');
  assert.equal(resolveUnifiedProvider({ env: { ANTHROPIC_API_KEY: 'sk-ant' } }).provider, 'anthropic');
  assert.equal(resolveUnifiedProvider({ env: { OPENAI_API_KEY: 'sk-openai', ANTHROPIC_API_KEY: 'sk-ant' } }).provider, 'anthropic', 'anthropic preferred when both are present');
});

test('the runtime assembly APPLIES the defaults — the map alone is not the posture', async () => {
  // S1 first shipped as the map + this posture file, with the apply call
  // left to the boot scripts — and neither called it, so every appliance
  // boot ran with the waves off and supplier bills skipped as
  // extractor_unavailable (the 2026-08-04 Honeybee rebuild, twice). Both
  // launch paths funnel through createDonnaRuntimeServer, so the call
  // lives there. Source-level tripwire because booting the assembly for
  // real needs a DB; the call must sit before the dynamic imports so env
  // is final before any config-reading module loads.
  const source = await readFile(new URL('./runtimeServer.js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('export const createDonnaRuntimeServer'));
  const callAt = body.indexOf('applyDesktopRuntimeEnvDefaults(');
  const importAt = body.indexOf("await import(");
  assert.ok(callAt !== -1, 'createDonnaRuntimeServer must apply the desktop runtime env defaults');
  assert.ok(importAt !== -1 && callAt < importAt, 'defaults must be applied before the config-reading dynamic imports');
});

test('the loop cron tasks gate on the TIER master, not the legacy shadow env (S3)', async () => {
  // S1 ships LOOPS_TIER=canary and never sets LOOPS_SHADOW, so a route gate
  // reading the raw env skipped the drain before the worker it gates ever ran
  // — the loop workers themselves already resolve the tier internally
  // (loopInboxWorker.js, loopOutboxDispatcher.js, reconciliationEvalConsumer.js),
  // so the route was strictly stricter than the thing it fronted. Source-level
  // for the same reason as the tripwire above: exercising the route needs a DB.
  const source = await readFile(new URL('../api.js', import.meta.url), 'utf8');
  // (`loops_outbox` — unscheduled since birth — was deleted in RT-14; the
  // inbox tick dispatches the outbox inline.)
  for (const task of ['loops_inbox', 'loops_recon_eval']) {
    const at = source.indexOf(`if (task === '${task}') {`);
    assert.ok(at !== -1, `the parse-cron ${task} task must exist`);
    const gate = source.slice(at, at + 220);
    assert.ok(
      gate.includes('isLoopSystemEnabled()'),
      `${task} must gate on isLoopSystemEnabled (the tier master)`
    );
    assert.ok(
      !gate.includes('isLoopsShadowEnabled()'),
      `${task} must not gate on the legacy raw-env predicate`
    );
  }
});

test('cloud env (no desktop signal, no application) is untouched by this module', () => {
  // The module only runs from the desktop boot; this asserts the obvious
  // for the record — importing it must not mutate process.env.
  assert.equal(process.env.BANK_STATEMENT_MATCHER_ENABLED, undefined);
  assert.equal(process.env.LOOPS_TIER, undefined);
});

// ── RT-14: posture as behaviour ──────────────────────────────────────────

// A request/response pair the router can answer without a socket or a DB.
const fakeExchange = ({ method = 'GET', url }) => {
  const headers = {};
  let body = '';
  const res = {
    statusCode: 200,
    setHeader: (name, value) => { headers[name.toLowerCase()] = value; },
    getHeader: (name) => headers[name.toLowerCase()],
    end: (chunk) => { body = chunk == null ? '' : String(chunk); res.ended = true; },
    ended: false
  };
  const req = { method, url, headers: {}, on: () => req, once: () => req, removeListener: () => req, socket: { remoteAddress: '127.0.0.1' } };
  return { req, res, body: () => body, json: () => JSON.parse(body || 'null') };
};

test('the host-class fence: cloud-only routes answer 404 CLOUD_ONLY_ROUTE on the desktop host, before any auth or webhook gate (RT-14, F-19)', async () => {
  const saved = process.env.DONNA_DESKTOP_BLOB_DIR;
  process.env.DONNA_DESKTOP_BLOB_DIR = '/tmp/donna-test-blobs';
  try {
    assert.equal(isDesktopHostEnv(), true);
    for (const path of [...CLOUD_ONLY_DONNA_PATHS, '/api/donna/marketing/admin/drafts', '/api/donna/billing/status', '/api/donna/billing/webhook', '/api/donna/mcp/remote/chatgpt', '/api/donna/mcp/demo', '/api/donna/mcp/oauth-protected-resource/api/donna/mcp/remote/claude']) {
      assert.equal(isCloudOnlyDonnaPath(path), true, `${path} is cloud-only`);
      const method = path.includes('webhook') || path.includes('hook') || path.includes('provision') ? 'POST' : 'GET';
      const { req, res, json } = fakeExchange({ method, url: `${path}?token=x&code=y&state=z` });
      await handleDonnaApiRequest(req, res);
      assert.equal(res.ended, true, `${path}: answered`);
      assert.equal(res.statusCode, 404, `${path}: not mounted on the desktop host`);
      assert.equal(json().code, 'CLOUD_ONLY_ROUTE', `${path}: the fence names itself`);
    }
    // The appliance's own surfaces are not fenced.
    for (const path of ['/api/donna/firms/health', '/api/donna/firms/snapshot', '/api/donna/firms/documents/register', '/api/donna/evidence-local', '/api/donna/telegram/webhook', '/api/donna/firms/hmrc/callback', '/api/donna/mcp/tools', '/api/donna/mcp/v1/tools', '/api/donna/mcp/v1/call']) {
      assert.equal(isCloudOnlyDonnaPath(path), false, `${path} stays mounted on the appliance`);
    }
  } finally {
    if (saved === undefined) delete process.env.DONNA_DESKTOP_BLOB_DIR;
    else process.env.DONNA_DESKTOP_BLOB_DIR = saved;
  }
});

test('the host-class fence is a DESKTOP posture: without the host signal the same path reaches its handler (the cloud build keeps every route)', async () => {
  const saved = process.env.DONNA_DESKTOP_BLOB_DIR;
  delete process.env.DONNA_DESKTOP_BLOB_DIR;
  try {
    assert.equal(isDesktopHostEnv(), false);
    // The public marketing unsubscribe: token-authenticated by its own random
    // token, so a GET without one is refused by the HANDLER (4xx with its own
    // error), never by the fence — and it needs no DB or session to say so.
    const { req, res, body } = fakeExchange({ method: 'GET', url: '/api/donna/marketing/unsubscribe' });
    await handleDonnaApiRequest(req, res);
    assert.equal(res.ended, true);
    assert.ok(!body().includes('CLOUD_ONLY_ROUTE'), `the cloud host mounts the route: ${body().slice(0, 120)}`);
  } finally {
    if (saved === undefined) delete process.env.DONNA_DESKTOP_BLOB_DIR;
    else process.env.DONNA_DESKTOP_BLOB_DIR = saved;
  }
});

test('the desktop manifest schedules no cloud-only work (RT-14, F-09/F-10/F-19)', () => {
  const manifest = buildDesktopHandlerManifest({ ledgerAdapterConnected: false });
  const ids = manifest.map((entry) => entry.functionId);
  assert.ok(!manifest.some((entry) => entry.kind === 'http-cron'), 'no HTTP self-call entry');
  for (const task of Object.keys(CLOUD_ONLY_PARSE_CRON_TASKS)) {
    assert.ok(!ids.includes(`parse-cron:${task}`), `parse-cron:${task} is cloud-only`);
  }
  for (const id of ['marketing-prospects-due', 'marketing-reply-triage', ...NONE_ADAPTER_FUNCTION_IDS]) {
    assert.ok(!ids.includes(id), `${id} is not scheduled on a desktop 'none' book`);
  }
  for (const id of ['parse-document', 'parse-cron:stuck', 'parse-cron:loops_inbox', 'bank-line-disposition', 'document-terminal-drain', 'desktop-backup-daily']) {
    assert.ok(ids.includes(id), `${id} is scheduled`);
  }
  for (const entry of manifest) assert.equal(typeof entry.run, 'function', `${entry.functionId}: a callable closure`);
});
