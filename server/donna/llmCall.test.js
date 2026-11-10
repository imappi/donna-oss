// Tests for the shared model-call envelope (kernel-audit M3 / S1, gap G3).
// Design: docs/donna-kernel-audit/llm-call-envelope-design.md.
//
// The six rails in llmCall.js's header are the spec; each has a test here. Two
// of them (sections-are-sizes-only, raw-is-never-captured) are asserted by
// SERIALIZING the telemetry and searching it for the content — a structural
// check rather than a field-by-field one, because the failure mode is a field
// nobody thought to look at.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { resolve as resolvePath, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  llmCall,
  measureSections,
  normalizeUsage,
  telemetryFromParts,
  telemetryForDecision,
  PROMPT_SECTIONS
} from './llmCall.js';
import { providerUrlLintPattern } from './providerEndpoints.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolvePath(__dirname, '..', '..');

const okResponse = (payload, { status = 200 } = {}) => ({
  ok: true,
  status,
  headers: { get: (k) => (k === 'x-request-id' ? 'req-abc' : null) },
  json: async () => payload
});

const ROOT = { root: { type: 'owner_message', id: 'msg-1' } };

// ── RAIL 1 — sections are measured, never retained ──────────────────────────

await test('measureSections records sizes and nothing else', () => {
  const m = measureSections({ system: 'abcde', context: { a: 1 } });
  assert.equal(m.sections.system.bytes, 5);
  assert.equal(m.sections.system.chars, 5);
  assert.equal(m.total_bytes, 5 + JSON.stringify({ a: 1 }).length);
  // Multi-byte: bytes and chars must diverge, or we are measuring the wrong thing.
  const wide = measureSections({ system: 'äöü' });
  assert.equal(wide.sections.system.chars, 3);
  assert.equal(wide.sections.system.bytes, 6);
});

await test('measureSections NAMES an unknown section rather than dropping it', () => {
  // An unmeasured section is a hole in the accounting and must be visible as one.
  const m = measureSections({ system: 'x', smuggled: 'y' });
  assert.deepEqual(m.unknown_sections, ['smuggled']);
  assert.equal(m.sections.smuggled.bytes, 1, 'still measured, just flagged');
  assert.deepEqual(PROMPT_SECTIONS, ['system', 'tools', 'context', 'history', 'results']);
});

await test('RAIL 1: no section CONTENT is reachable anywhere in the telemetry', async () => {
  // G14's explicit mitigation: "the wrapper stores section SIZES, never section
  // contents". This is why a measurement slice does not re-widen the surface
  // migration 105's retention control just narrowed.
  const secrets = {
    system: 'SYSTEM_SECRET_ALPHA',
    tools: { name: 'TOOL_SECRET_BRAVO' },
    context: ['CONTEXT_SECRET_CHARLIE'],
    history: 'HISTORY_SECRET_DELTA',
    results: 'RESULTS_SECRET_ECHO'
  };
  const { telemetry } = await llmCall({
    provider: 'openai',
    url: 'https://example.invalid',
    body: { model: 'm' },
    sections: secrets,
    execution: ROOT,
    fetchImpl: async () => okResponse({ model: 'm', usage: { input_tokens: 1, output_tokens: 2 } })
  });
  const serialized = JSON.stringify(telemetry);
  for (const secret of ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO']) {
    assert.ok(!serialized.includes(secret), `section content leaked into telemetry: ${secret}`);
  }
  // ...and the sizes ARE there, so this is not passing by measuring nothing.
  assert.equal(telemetry.prompt_sections.sections.system.bytes, secrets.system.length);
  assert.ok(telemetry.prompt_sections.total_bytes > 0);
});

// ── RAIL 2 — the raw response is never captured ─────────────────────────────

await test('RAIL 2: the raw provider payload is never reachable from telemetry', async () => {
  // #1133 finding 1: llm_raw_response is empty in production, and this slice is
  // the natural place it would start being filled. It deliberately does not.
  const { result, telemetry } = await llmCall({
    provider: 'openai',
    url: 'https://example.invalid',
    body: { model: 'm' },
    execution: ROOT,
    parseResponse: (p) => ({ answer: p.output_text }),
    fetchImpl: async () => okResponse({
      model: 'm',
      output_text: 'RAW_PAYLOAD_SECRET',
      internal: 'ANOTHER_RAW_SECRET'
    })
  });
  assert.equal(result.answer, 'RAW_PAYLOAD_SECRET', 'the CALLER still gets the content');
  const serialized = JSON.stringify(telemetry);
  assert.ok(!serialized.includes('RAW_PAYLOAD_SECRET'), 'raw output leaked into telemetry');
  assert.ok(!serialized.includes('ANOTHER_RAW_SECRET'), 'raw payload leaked into telemetry');
});

await test('RAIL 2: the decision mapper never produces a raw-response field', () => {
  const mapped = telemetryForDecision({
    usage: { input_tokens: 1 },
    root_execution: { type: 'owner_message', id: 'm1' },
    latency_ms: 5,
    attempt_count: 1,
    prompt_sections: { total_bytes: 9 }
  });
  assert.ok(!('llmRawResponse' in mapped) && !('raw' in mapped), 'the mapper must not carry a raw response');
  assert.equal(mapped.rootExecutionType, 'owner_message');
  assert.equal(mapped.rootExecutionId, 'm1');
  assert.equal(telemetryForDecision(null), null, 'no telemetry ⇒ null ⇒ byte-identical insert');
});

// ── RAIL 3 — ONE typed execution ref, never a nullable union ────────────────

await test('RAIL 3: a malformed or union-shaped execution ref is REFUSED, before the call', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return okResponse({}); };
  const attempt = (execution) => llmCall({
    provider: 'openai', url: 'https://example.invalid', body: {}, execution, fetchImpl
  });

  await assert.rejects(() => attempt(undefined), /typed root_execution ref/);
  await assert.rejects(() => attempt({}), /typed root_execution ref/);
  await assert.rejects(() => attempt({ root: { type: 'owner_message' } }), /non-empty type AND id/);
  await assert.rejects(() => attempt({ root: { id: 'm1' } }), /non-empty type AND id/);
  await assert.rejects(() => attempt({ root: { type: '  ', id: 'm1' } }), /non-empty type AND id/);
  // S1's stale 4-way nullable union shape — exactly what G3 revised away.
  await assert.rejects(
    () => attempt({ root: { work_ref: null, case_id: null, run_id: 'r1', action_id: null } }),
    /non-empty type AND id/
  );
  assert.equal(called, false, 'refused BEFORE spending a token');
});

await test('RAIL 3: the optional parent takes the same typed shape, and stays optional', async () => {
  const fetchImpl = async () => okResponse({ model: 'm' });
  const withParent = await llmCall({
    provider: 'openai', url: 'https://x.invalid', body: {}, fetchImpl,
    execution: { root: { type: 'owner_message', id: 'm1' }, parent: { type: 'loop_run', id: 'r9' } }
  });
  assert.deepEqual(withParent.telemetry.parent_execution, { type: 'loop_run', id: 'r9' });

  const noParent = await llmCall({
    provider: 'openai', url: 'https://x.invalid', body: {}, fetchImpl, execution: ROOT
  });
  assert.equal(noParent.telemetry.parent_execution, null);

  await assert.rejects(
    () => llmCall({
      provider: 'openai', url: 'https://x.invalid', body: {}, fetchImpl,
      execution: { root: { type: 'owner_message', id: 'm1' }, parent: { type: 'loop_run' } }
    }),
    /non-empty type AND id/
  );
});

// ── RAIL 4 — telemetry failure never changes the call result ────────────────

await test('RAIL 4: a throw inside telemetry capture leaves the result intact', async () => {
  // Injected via a `sections` value whose serialization throws — the one place
  // caller-supplied data reaches the measurement path.
  const circular = {};
  circular.self = circular;
  const { result, telemetry } = await llmCall({
    provider: 'openai',
    url: 'https://x.invalid',
    body: { model: 'm' },
    sections: { context: circular },
    execution: ROOT,
    parseResponse: (p) => ({ answer: p.model }),
    fetchImpl: async () => okResponse({ model: 'm' }),
    logger: { warn: () => {} }
  });
  assert.equal(result.answer, 'm', 'the call result survives a telemetry failure');
  assert.equal(telemetry, null, 'and the failure is reported honestly as null, not as zeros');
});

await test('RAIL 4: telemetryFromParts fails open too — a bad ref warns and yields null', () => {
  const logged = [];
  const t = telemetryFromParts({
    provider: 'anthropic', execution: { root: { type: 'x' } }, logger: { warn: (...a) => logged.push(a) }
  });
  assert.equal(t, null);
  assert.equal(logged.length, 1, 'null, but never silent');
});

// ── RAIL 5 — the model comes from the RESPONSE ──────────────────────────────

await test('RAIL 5: the served model wins over the requested one, and the source is recorded', async () => {
  // OPENAI_MODEL=gpt-5.4-nano sat in prod for a month silently overriding every
  // per-module strong default. The model id is part of the receipt.
  const served = await llmCall({
    provider: 'openai', url: 'https://x.invalid', body: { model: 'gpt-5.4' }, execution: ROOT,
    fetchImpl: async () => okResponse({ model: 'gpt-5.4-nano' })
  });
  assert.equal(served.telemetry.model, 'gpt-5.4-nano', 'the id the API actually served');
  assert.equal(served.telemetry.model_source, 'response');

  const fallback = await llmCall({
    provider: 'openai', url: 'https://x.invalid', body: { model: 'gpt-5.4' }, execution: ROOT,
    fetchImpl: async () => okResponse({})
  });
  assert.equal(fallback.telemetry.model, 'gpt-5.4');
  assert.equal(fallback.telemetry.model_source, 'request', 'the fallback is VISIBLE, never assumed');
});

// ── RAIL 6 — retries are a typed count ──────────────────────────────────────

await test('RAIL 6: attempts are counted, and a retried call reports its true cost', async () => {
  let calls = 0;
  const { telemetry } = await llmCall({
    provider: 'openai', url: 'https://x.invalid', body: {}, execution: ROOT, maxAttempts: 3,
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) };
      return okResponse({ model: 'm' });
    }
  });
  assert.equal(telemetry.attempt_count, 3, 'retry cost is answerable — G3s point');
  assert.equal(telemetry.ok, true);
});

await test('a call that never succeeds throws, and carries its telemetry with it', async () => {
  await assert.rejects(
    () => llmCall({
      provider: 'openai', url: 'https://x.invalid', body: {}, execution: ROOT, maxAttempts: 2,
      fetchImpl: async () => ({ ok: false, status: 429, headers: { get: () => null }, json: async () => ({ error: { message: 'rate limited' } }) })
    }),
    (err) => {
      assert.match(err.message, /rate limited/);
      assert.equal(err.telemetry.attempt_count, 2, 'a failed call is still measured');
      assert.equal(err.telemetry.ok, false);
      assert.equal(err.telemetry.status, 429);
      return true;
    }
  );
});

// ── Usage normalization ─────────────────────────────────────────────────────

await test('normalizeUsage folds both provider shapes into one, keeping the raw blob', () => {
  const openai = normalizeUsage({ usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } }, 'openai');
  assert.equal(openai.input_tokens, 10);
  assert.equal(openai.total_tokens, 14);
  // The older prompt/completion naming.
  const legacy = normalizeUsage({ usage: { prompt_tokens: 7, completion_tokens: 3 } }, 'openai');
  assert.equal(legacy.input_tokens, 7);
  assert.equal(legacy.output_tokens, 3);
  assert.equal(legacy.total_tokens, 10, 'derived when the provider omits it');
  // The untouched blob rides along so a normalization bug stays diagnosable
  // rather than silently producing plausible wrong numbers.
  assert.deepEqual(legacy.provider_usage, { prompt_tokens: 7, completion_tokens: 3 });
  assert.equal(normalizeUsage({}, 'openai'), null, 'no usage ⇒ null, never zeros');
});

// ── The anti-fragmentation lint ─────────────────────────────────────────────
// G3's whole complaint is 31 modules calling providers with no shared envelope.
// A lint that only listed them would be a list of exceptions that grows quietly;
// the MAXIMUM is what makes it a ratchet.

// Derived from KNOWN_PROVIDER_HOSTS in providerEndpoints.js — adding a host
// there (e.g. an OpenAI-compatible base URL for the descent ladder's Qwen
// rung) automatically extends this ratchet's reach. A hand-written regex
// here would go blind on exactly the hosts the ladder introduces
// (descent-ladder spec §1.4).
const PROVIDER_URL = providerUrlLintPattern();

// Every non-test module that still calls a provider directly. Migrating one is a
// deletion HERE plus a lowered MAX_DIRECT_PROVIDER_CALL_SITES below — so the
// number can only go down.
const DIRECT_PROVIDER_CALL_ALLOWLIST = new Set([
  // Explicit typed-choice lane: llmCall's generative-text parser
  // cannot consume TypeSafe's choice/noul distributions. Uses the same deadline
  // transport and typed failures, strict response validation and no internal retries.
  'server/donna/jevProvider.js',
  'server/donna/bankStatementVision.js',
  'server/donna/clientIntakeDraft.js',
  'server/donna/contract.js',
  'server/donna/documentRouter.js',
  'server/donna/genericDocument.js',
  // Instrumented (M3 pass 1) but keeps its structured __callAnthropic seam, so
  // it still holds a direct fetch. Partial adoption, recorded as partial.
  'server/donna/intentCompiler.js',
  'server/donna/louisPipeline.js',
  'server/donna/merchantLookup.js',
  'server/donna/parserRepair.js',
  'server/donna/receipt.js',
  'server/donna/receiptClassifier.js',
  // reconciliationLlmCore.js left this list at Q7 (2026-08-16): its
  // compatible deciding path rides llmCall, which is what this lint's
  // predicate keys on. Its ANTHROPIC deciding transport is still a direct
  // fetch — migrating that onto the envelope is its own slice, not a Q7
  // side effect (isolation-list file).
  'server/donna/reconciliationTriage.js',
  'server/donna/salesInvoice.js',
  'server/donna/supplierBill.js',
  // transactionLlm.js left this list at Q9 (2026-08-16): its compatible
  // deciding path rides llmCall, which is what this lint's predicate keys
  // on. Its OPENAI Responses-API deciding transport is still a direct
  // fetch — migrating that onto the envelope is its own slice, not a Q9
  // side effect (the reconciliationLlmCore precedent, same shape).
  'server/donna/transactionChat.js'
]);

// The ratchet. 31 sites at the start of M3; ownerInvoiceCommandRead.js moved
// onto the envelope, leaving 30; reconciliationLlmCore.js adopted llmCall for
// its Q7 compatible deciding path (2026-08-16), leaving 29; transactionLlm.js
// adopted it for the Q9 compatible coding path (2026-08-16), leaving 28;
// unifiedExtractor.js moved BOTH of its provider transports onto the
// envelope (RT-12, 2026-09-02), leaving 27.
// The retired support-resolution lab took runtime.js and louis.js with it
// (2026-11-05), leaving 24.
// The Claude-only text lanes (owner's decision, 2026-11-10) moved
// askPipeline.js (its new Anthropic path; the OpenAI path stays on the
// deadline transport, but the module now routes through the envelope),
// documentChat.js, firmFacts.js, the four marketing drafters and
// outbound/replyIngestion.js onto the envelope, leaving 16.
// LOWER this when a site migrates; never raise it.
const MAX_DIRECT_PROVIDER_CALL_SITES = 16; // Typed Jev preview added; generic callers still migrate to llmCall.

const walkJsFiles = (dir, acc = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = resolvePath(dir, entry.name);
    if (entry.isDirectory()) walkJsFiles(full, acc);
    else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) acc.push(full);
  }
  return acc;
};

// A module is an OFFENDER when it names a provider URL and does NOT route
// through the envelope. Naming the URL is not itself the problem — llmCall takes
// the url from its caller, so an adopted site still contains the string. What
// matters is whether the call goes through the envelope.
const directProviderCallSites = () => walkJsFiles(resolvePath(repoRoot, 'server'))
  .map((file) => ({ rel: relative(repoRoot, file).split('\\').join('/'), source: readFileSync(file, 'utf8') }))
  .filter(({ rel, source }) =>
    PROVIDER_URL.test(source)
    && rel !== 'server/donna/llmCall.js'
    // The host registry NAMES the hosts (that is its job) and makes no
    // calls — it exports strings, holds no fetch, and the lane-coverage
    // test in modelLanes.test.js exempts it for the same reason.
    && rel !== 'server/donna/providerEndpoints.js'
    && !source.includes('llmCall('))
  .map(({ rel }) => rel);

await test('lint: no NEW module calls a provider directly — the allowlist only shrinks', () => {
  // Guard the guard: a registry regression must not silently neuter the
  // ratchet by narrowing the derived pattern.
  assert.ok(PROVIDER_URL.test('https://api.openai.com/v1/chat/completions'));
  assert.ok(PROVIDER_URL.test('https://api.anthropic.com/v1/messages'));

  const offenders = directProviderCallSites();

  const unlisted = offenders.filter((rel) => !DIRECT_PROVIDER_CALL_ALLOWLIST.has(rel));
  assert.deepEqual(
    unlisted,
    [],
    'these modules call a provider directly instead of through llmCall(): '
      + `${unlisted.join(', ')} — route the call through server/donna/llmCall.js, `
      + 'or (only with a reason) add it to DIRECT_PROVIDER_CALL_ALLOWLIST and RAISE the max'
  );

  assert.ok(
    offenders.length <= MAX_DIRECT_PROVIDER_CALL_SITES,
    `direct provider call sites grew to ${offenders.length} (max ${MAX_DIRECT_PROVIDER_CALL_SITES}) — the allowlist is a ratchet, not a parking lot`
  );

  // A stale allowlist entry is also a failure: it hides that a site already
  // migrated and lets the max stay too high.
  const stale = [...DIRECT_PROVIDER_CALL_ALLOWLIST].filter((rel) => !offenders.includes(rel));
  assert.deepEqual(stale, [], `these allowlist entries no longer call a provider — delete them and LOWER the max: ${stale.join(', ')}`);
});

await test('lint: the first loops read call is OFF the allowlist — pass 1 actually moved something', () => {
  // G3: "instrument the first loop + intent compiler first". Without this, a
  // refactor that reverted ownerInvoiceCommandRead.js to a bare fetch would
  // still pass the max at 30 while adoption had gone backwards.
  assert.ok(
    !directProviderCallSites().includes('server/donna/ownerInvoiceCommandRead.js'),
    'the first loops read call must route through the envelope, not a bare fetch'
  );
  assert.ok(!DIRECT_PROVIDER_CALL_ALLOWLIST.has('server/donna/ownerInvoiceCommandRead.js'));
  const source = readFileSync(resolvePath(repoRoot, 'server/donna/ownerInvoiceCommandRead.js'), 'utf8');
  assert.ok(source.includes('llmCall('), 'and it does so by calling llmCall');
});
