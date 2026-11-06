import { Buffer } from 'node:buffer';

import { PDFDocument, StandardFonts } from 'pdf-lib';

import {
  computeVisionCacheKey,
  computeChunkCacheKey,
  extractStructuredFromOpenAiVisionPaginated,
  splitPdfBase64
} from './bankStatementVision.js';

let passed = 0;
let failed = 0;

const assert = (label, condition, detail = '') => {
  if (condition) {
    passed += 1;
    return;
  }
  failed += 1;
  console.error(`FAIL: ${label}${detail ? `\n  ${detail}` : ''}`);
};

const buildPdfBase64 = async (pageCount, label = 'page') => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pageCount; index += 1) {
    const page = pdf.addPage([400, 200]);
    page.drawText(`${label} ${index + 1}`, { x: 50, y: 100, size: 14, font });
  }
  const bytes = await pdf.save();
  return Buffer.from(bytes).toString('base64');
};

const withMockedFetch = async (handler, fn) => {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
};

const jsonResponse = (body) => ({
  ok: true,
  json: async () => body
});

const mockChunkResponse = (transactions, statement_summary = null) =>
  jsonResponse({
    output: [
      {
        content: [
          {
            text: JSON.stringify({
              transactions,
              statement_summary
            })
          }
        ]
      }
    ]
  });

// Test 1: a small (sub-chunk) PDF returns one chunk with the original base64
{
  const base64 = await buildPdfBase64(2);
  const chunks = await splitPdfBase64(base64, 4);
  assert('split returns single chunk when total <= chunk size', chunks.length === 1);
  assert('single chunk preserves base64', chunks[0].base64 === base64);
  assert('single chunk reports total page count', chunks[0].totalPages === 2);
}

// Test 2: a larger PDF is split into the expected number of chunks
{
  const base64 = await buildPdfBase64(10);
  const chunks = await splitPdfBase64(base64, 4);
  assert('10 pages split into 3 chunks at 4 per chunk', chunks.length === 3, `got ${chunks.length}`);
  assert('first chunk pages 1-4', chunks[0].pageStart === 1 && chunks[0].pageEnd === 4);
  assert('middle chunk pages 5-8', chunks[1].pageStart === 5 && chunks[1].pageEnd === 8);
  assert('last chunk pages 9-10', chunks[2].pageStart === 9 && chunks[2].pageEnd === 10);
  assert('every chunk has its own base64 payload', chunks.every((c) => typeof c.base64 === 'string' && c.base64.length > 0));
}

// Test 3: paginated extraction fans out one call per chunk and merges results
{
  process.env.OPENAI_API_KEY = 'test-key';
  const base64 = await buildPdfBase64(8);
  const receivedRequests = [];

  await withMockedFetch(
    async (url, init) => {
      const body = JSON.parse(init.body);
      const promptItem = body.input[0].content.find((c) => c.type === 'input_text');
      receivedRequests.push(promptItem.text);
      const index = receivedRequests.length - 1;
      if (index === 0) {
        return mockChunkResponse(
          [
            { date: '2024-01-05', description: 'Coffee', direction: 'out', amount: 5.50, currency: 'SGD', balance: 100 },
            { date: '2024-01-10', description: 'Salary', direction: 'in', amount: 4000, currency: 'SGD', balance: 4100 }
          ],
          {
            opening_balance: 105.50,
            closing_balance: 4100,
            currency: 'SGD',
            period_start: '2024-01-01',
            period_end: '2024-02-29',
            account_identifier: 'ACC-001'
          }
        );
      }
      return mockChunkResponse([
        { date: '2024-02-15', description: 'Office rent', direction: 'out', amount: 1500, currency: 'SGD', balance: 2600 },
        // Equal values on a disjoint source page are a separate payment.
        { date: '2024-01-10', description: 'Salary', direction: 'in', amount: 4000, currency: 'SGD', balance: 4100 }
      ]);
    },
    async () => {
      const result = await extractStructuredFromOpenAiVisionPaginated({
        base64,
        filename: 'statement.pdf',
        periodHint: '2024-01-01 to 2024-02-29',
        pagesPerChunk: 4,
        concurrency: 2
      });

      assert(
        'paginated extraction issues one request per chunk',
        receivedRequests.length === 2,
        `got ${receivedRequests.length}`
      );
      assert(
        'each chunk prompt advertises its page range',
        receivedRequests.every((p) => /pages\s+\d+[\-–]\d+\s+of\s+8/i.test(p)),
        `prompts:\n  ${receivedRequests.join('\n  ')}`
      );
      assert(
        'period hint forwarded to chunk prompts',
        receivedRequests.every((p) => p.includes('2024-01-01 to 2024-02-29'))
      );
      assert(
        'merged transactions preserve equal source rows',
        result.transactions.length === 4,
        `got ${result.transactions.length}`
      );
      assert(
        'merged transactions sorted by date',
        result.transactions[0].date === '2024-01-05' &&
          result.transactions[1].date === '2024-01-10' &&
          result.transactions[2].date === '2024-01-10' &&
          result.transactions[3].date === '2024-02-15'
      );
      assert(
        'statement summary taken from first non-null chunk',
        result.statement_summary?.account_identifier === 'ACC-001'
      );
    }
  );
}

// Test 4: paginated extraction skips chunking for small PDFs
{
  process.env.OPENAI_API_KEY = 'test-key';
  const base64 = await buildPdfBase64(2);
  let calls = 0;
  await withMockedFetch(
    async () => {
      calls += 1;
      return mockChunkResponse(
        [{ date: '2024-03-01', description: 'X', direction: 'out', amount: 1, currency: 'SGD', balance: 0 }],
        null
      );
    },
    async () => {
      await extractStructuredFromOpenAiVisionPaginated({
        base64,
        filename: 'small.pdf',
        pagesPerChunk: 4
      });
      assert('small PDF skips chunking — exactly one request', calls === 1);
    }
  );
}

// Test 5: size guardrail rejects oversized PDFs before any OpenAI call
{
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_VISION_MAX_PDF_BYTES = '4096'; // 4 KB
  const base64 = await buildPdfBase64(2); // generated PDFs are ~1-2 KB but we use a smaller cap to force the rejection
  // Pad the base64 to clearly exceed 4 KB
  const padded = base64 + 'A'.repeat(8192);
  let openAiCalls = 0;
  let thrown = null;
  await withMockedFetch(
    async () => {
      openAiCalls += 1;
      return mockChunkResponse([], null);
    },
    async () => {
      try {
        await extractStructuredFromOpenAiVisionPaginated({
          base64: padded,
          filename: 'too-big.pdf',
          pagesPerChunk: 4
        });
      } catch (error) {
        thrown = error;
      }
    }
  );
  assert('oversized PDF throws PDF_TOO_LARGE', thrown?.code === 'OPENAI_VISION_PDF_TOO_LARGE');
  assert('oversized PDF never reaches OpenAI', openAiCalls === 0);
  assert('size error carries byte/max details', Number.isFinite(thrown?.byteSize) && Number.isFinite(thrown?.maxBytes));
  delete process.env.OPENAI_VISION_MAX_PDF_BYTES;
}

// Test 6: cache hit short-circuits OpenAI entirely
{
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_test';
  const base64 = await buildPdfBase64(8);
  const sha = computeVisionCacheKey(base64);
  let openAiCalls = 0;
  let cacheLookups = 0;
  await withMockedFetch(
    async (url, init) => {
      if (String(url).includes('supabase.co')) {
        if ((init?.method || 'GET') === 'GET') {
          cacheLookups += 1;
          return jsonResponse({
            cached_at: '2024-04-01T00:00:00Z',
            model: 'gpt-5.4',
            transactions: [
              { date: '2024-04-01', description: 'Cached row', money_in: 0, money_out: 9.99, balance: null, currency: 'SGD', confidence: 'medium', parser_flags: ['openai_vision'], source_line: '' }
            ],
            statement_summary: { account_identifier: 'CACHED-ACC' }
          });
        }
        return jsonResponse({});
      }
      openAiCalls += 1;
      return mockChunkResponse([], null);
    },
    async () => {
      const result = await extractStructuredFromOpenAiVisionPaginated({
        base64,
        filename: 'cached.pdf',
        pagesPerChunk: 4
      });
      assert('cache hit returns cached transactions', result.transactions.length === 1 && result.transactions[0].description === 'Cached row');
      assert('cache hit marked on result', result.cache_hit === true);
      assert('cache hit cache_sha matches computed key', result.cache_sha === sha);
      assert('cache hit triggered cache lookup', cacheLookups === 1);
      assert('cache hit avoids OpenAI call', openAiCalls === 0);
    }
  );
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
}

// Test 7: cache miss falls through to OpenAI and writes cache
{
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_test';
  const base64 = await buildPdfBase64(8);
  let openAiCalls = 0;
  let cacheWrites = 0;
  let writtenBody = null;
  await withMockedFetch(
    async (url, init) => {
      if (String(url).includes('supabase.co')) {
        const method = (init?.method || 'GET').toUpperCase();
        if (method === 'GET') {
          return { ok: false, status: 404, json: async () => ({}) };
        }
        if (method === 'POST') {
          cacheWrites += 1;
          writtenBody = JSON.parse(init.body);
          return jsonResponse({});
        }
        return jsonResponse({});
      }
      openAiCalls += 1;
      return mockChunkResponse(
        [{ date: '2024-05-01', description: 'Fresh', direction: 'in', amount: 10, currency: 'SGD', balance: 100 }],
        { account_identifier: 'FRESH-ACC' }
      );
    },
    async () => {
      const result = await extractStructuredFromOpenAiVisionPaginated({
        base64,
        filename: 'miss.pdf',
        pagesPerChunk: 4
      });
      assert('cache miss runs OpenAI for every chunk', openAiCalls === 2);
      // 2 chunk writes + 1 full-PDF write = 3. Chunk-level caching is the
      // retry safety net: if extraction times out partway, the chunks
      // that finished are persisted so the next attempt skips them.
      assert('cache miss writes per-chunk + full-PDF caches', cacheWrites === 3, `got ${cacheWrites}`);
      // The LAST POST is the full-PDF write (chunk writes happen during
      // fan-out, full-PDF write happens after merge). Its merged shape
      // is what the next identical re-upload short-circuits on.
      assert('full-PDF cache write contains merged transactions', Array.isArray(writtenBody?.transactions) && writtenBody.transactions.length === 2);
      assert('full-PDF cache write tags the model', typeof writtenBody?.model === 'string' && writtenBody.model.length > 0);
      assert('full-PDF cache write tags the timestamp', /^\d{4}-\d{2}-\d{2}T/.test(writtenBody?.cached_at || ''));
      assert('cache miss marked on result', result.cache_hit === false);
    }
  );
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
}

// Test 8: partial chunk-cache hit on retry — the retry safety net.
// Simulates a previous extraction that finished chunk #1 (cached) but
// died before chunk #2. On retry, chunk #1 loads from cache, chunk #2
// runs OpenAI. This is the path that converts a 300s burn into a fast
// retry for 16-month statements.
{
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_test';
  const base64 = await buildPdfBase64(8); // 8 pages → 2 chunks at pagesPerChunk=4
  const chunks = await splitPdfBase64(base64, 4);
  const cachedChunkSha = computeVisionCacheKey(chunks[0].base64);
  const uncachedChunkSha = computeVisionCacheKey(chunks[1].base64);
  let openAiCalls = 0;
  let cacheLookups = 0;
  let chunkCacheLookups = 0;
  await withMockedFetch(
    async (url, init) => {
      const urlStr = String(url);
      if (urlStr.includes('supabase.co')) {
        const method = (init?.method || 'GET').toUpperCase();
        if (method === 'GET') {
          // Full-PDF cache lookup → 404 so we fall through to chunks.
          // Chunk #1 cache lookup → 200 with a cached payload.
          // Chunk #2 cache lookup → 404 so it runs OpenAI.
          if (urlStr.includes(encodeURIComponent(cachedChunkSha))) {
            chunkCacheLookups += 1;
            return jsonResponse({
              cached_at: '2024-04-01T00:00:00Z',
              model: 'gpt-5.4',
              filename: 'partial.pdf',
              page_start: 1,
              page_end: 4,
              total_pages: 8,
              transactions: [
                { date: '2024-04-01', description: 'From chunk cache', direction: 'in', amount: 5, currency: 'SGD', balance: null }
              ],
              statement_summary: { account_identifier: 'PARTIAL-ACC' }
            });
          }
          if (urlStr.includes(encodeURIComponent(uncachedChunkSha))) {
            chunkCacheLookups += 1;
            return { ok: false, status: 404, json: async () => ({}) };
          }
          cacheLookups += 1; // full-PDF lookup
          return { ok: false, status: 404, json: async () => ({}) };
        }
        return jsonResponse({}); // POST writes — no-op
      }
      openAiCalls += 1;
      return mockChunkResponse(
        [{ date: '2024-05-01', description: 'Fresh from OpenAI', direction: 'in', amount: 7, currency: 'SGD', balance: null }],
        null
      );
    },
    async () => {
      const result = await extractStructuredFromOpenAiVisionPaginated({
        base64,
        filename: 'partial.pdf',
        pagesPerChunk: 4
      });
      assert('partial chunk cache: full-PDF lookup attempted', cacheLookups === 1);
      assert('partial chunk cache: both chunks looked up', chunkCacheLookups === 2);
      assert('partial chunk cache: only the uncached chunk hits OpenAI', openAiCalls === 1, `got ${openAiCalls}`);
      // Merged result has BOTH transactions: one from cache, one fresh.
      assert('partial chunk cache: merged result includes the cached row', result.transactions.some((tx) => tx.description === 'From chunk cache'));
      assert('partial chunk cache: merged result includes the fresh row', result.transactions.some((tx) => tx.description === 'Fresh from OpenAI'));
    }
  );
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
}

// Test 9: cache fetch AbortController fires when Supabase hangs.
// A wedged Storage endpoint must not extend the parse budget. The
// previous code had no AbortController on these fetches, so a hang
// would silently consume the whole 300s function ceiling.
{
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_test';
  // Pin the cache timeout to 50ms so the test runs in <1s. Production
  // default is 8s; this just makes the abort fire fast for CI.
  process.env.BANK_STATEMENT_CACHE_FETCH_TIMEOUT_MS = '50';
  const base64 = await buildPdfBase64(4);
  let openAiCalls = 0;
  let abortedCalls = 0;
  await withMockedFetch(
    async (url, init) => {
      const urlStr = String(url);
      if (urlStr.includes('supabase.co')) {
        // Simulate a hung Supabase: never resolve, but respect
        // AbortController so the AbortError surfaces.
        return await new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            abortedCalls += 1;
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }
      openAiCalls += 1;
      return mockChunkResponse(
        [{ date: '2024-05-01', description: 'After abort', direction: 'in', amount: 1, currency: 'SGD', balance: null }],
        null
      );
    },
    async () => {
      const start = Date.now();
      const result = await extractStructuredFromOpenAiVisionPaginated({
        base64,
        filename: 'hung-cache.pdf',
        pagesPerChunk: 4
      });
      const elapsed = Date.now() - start;
      assert('hung cache: AbortController fired at least once', abortedCalls >= 1, `aborted=${abortedCalls}`);
      assert('hung cache: parse still completes (degrades to no cache)', openAiCalls === 1, `got openAi=${openAiCalls}`);
      assert('hung cache: returns the fresh transaction', result.transactions.some((tx) => tx.description === 'After abort'));
      // With 50ms timeout × 4 cache touches (full-PDF lookup + chunk
      // lookup + chunk write + full-PDF write) the worst case is ~200ms.
      // We give 5s headroom for CI variance — the point is to pin that
      // the cache hangs don't push past the 300s function ceiling.
      assert('hung cache: elapsed time is bounded (parse exits fast)', elapsed < 5_000, `elapsed=${elapsed}ms`);
    }
  );
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.BANK_STATEMENT_CACHE_FETCH_TIMEOUT_MS;
}

// Test 10: chunk bytes are DETERMINISTIC — the property the whole chunk cache
// rests on, and the reason test 8 above used to flake under a loaded suite.
//
// pdf-lib stamps a new document's Info dictionary from the clock, so the same
// source PDF split twice produced two different chunk SHAs. That silently broke
// the retry promise in computeChunkCacheKey's own comment ("a retry sees the
// same chunk bytes -> the same SHA -> the cached result skips OpenAI"): every
// retry re-ran every chunk, in production as well as in the test. splitPdfBase64
// now pins the chunk metadata; this pins that it stays pinned.
{
  const base64 = await buildPdfBase64(8);
  const first = await splitPdfBase64(base64, 4);
  // Cross a whole-second boundary — the granularity a PDF date carries. This is
  // exactly what a loaded CI run did by accident.
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const second = await splitPdfBase64(base64, 4);

  assert('determinism: same chunk count', first.length === second.length && first.length === 2,
    `got ${first.length} and ${second.length}`);
  assert(
    'determinism: chunk SHAs are identical across a clock tick',
    first.every((chunk, i) => computeChunkCacheKey(chunk.base64) === computeChunkCacheKey(second[i].base64)),
    `first=${first.map((c) => computeChunkCacheKey(c.base64).slice(0, 12)).join(',')} second=${second.map((c) => computeChunkCacheKey(c.base64).slice(0, 12)).join(',')}`
  );
  assert('determinism: page ranges preserved',
    JSON.stringify(first.map((c) => [c.pageStart, c.pageEnd])) === '[[1,4],[5,8]]');
  // Determinism must not collapse into "every chunk looks the same", which
  // would serve one statement's cached extraction for another's pages. Chunks
  // carrying DIFFERENT pages must still hash differently.
  assert('determinism: different pages still yield different SHAs',
    computeChunkCacheKey(first[0].base64) !== computeChunkCacheKey(first[1].base64));
  const differentContent = await splitPdfBase64(await buildPdfBase64(8, 'statement B'), 4);
  assert('determinism: different page CONTENT yields a different SHA',
    computeChunkCacheKey(differentContent[0].base64) !== computeChunkCacheKey(first[0].base64));

  // ...and the converse is a FEATURE, not a collision: the cache is content-
  // addressed, so four byte-identical pages hash the same however long the
  // document they came from was. Re-uploading a statement with a page appended
  // therefore re-extracts only the new chunk — which is the whole point.
  const longerDoc = await splitPdfBase64(await buildPdfBase64(9), 4);
  assert('determinism: identical pages hash identically across differing documents',
    computeChunkCacheKey(longerDoc[0].base64) === computeChunkCacheKey(first[0].base64));
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed out of ${passed + failed}.`);
  process.exit(1);
} else {
  console.log(`\nAll ${passed} bankStatementVision tests passed.`);
}
