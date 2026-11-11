// Donna — the provider record / replay seam (the zero-key demo).
//
// ONE SEAM, AT THE WIRE. Every model call in this tree leaves the process as
// a `fetch` to a host in the provider registry (providerEndpoints.js
// KNOWN_PROVIDER_HOSTS): the llmCall envelope (`fetchImpl = fetch`), the
// shared transport (`fetchImpl = globalThis.fetch`), and the call sites that
// keep their own socket (the provider-URL allowlist in llmCall.test.js). No
// module uses a provider SDK, `http(s).request` or a fetch captured at import
// time, so the process-global `fetch`, read at call time, is the one place
// every model call passes. This module wraps it — and only when a demo
// command installs it. Nothing imports it to change behaviour: with no
// install, `globalThis.fetch` is the platform's and every lane, transport
// and envelope runs byte-for-byte as before. The hosts are read from the
// registry and never named here, so the provider-URL ratchet and the lane
// census stay blind to this module by construction (as for
// testSupport/recordedProviders.js, whose lane table lives here now).
//
// Because it sits at the wire, a replayed answer passes through EVERYTHING a
// live answer passes through: each lane's own response parsing, schema
// validation, arithmetic checks, posting checks and receipts. Replay skips no
// check; it only answers the socket.
//
// THE REQUEST IDENTITY (donna.provider-request-identity.v1). The key is the
// SHA-256 of the canonical JSON (sorted keys) of { identity version,
// endpoint (host + path), the request body after normalization }. Never in
// the key: any header (keys, versions, beta flags), the query string, the
// order requests arrive in. Normalization, deliberately:
//   - file bytes (a base64 PDF or image, or a data: URL) → their SHA-256, so
//     the same fixture file is the same request on every machine, and the
//     recording does not carry the file;
//   - full timestamps (2026-11-10T09:15:02.123Z) → `<timestamp>`;
//   - the run's own calendar dates (today and three days either side, ISO
//     and Finnish d.m.yyyy) → `<run-date±k>`; the pack's own dates (2024,
//     2025) are content and stay;
//   - epoch-millisecond numbers within 30 days of now → `<epoch-ms>`;
//   - UUIDs and 64-hex digests → `<id:N>`, numbered by first appearance in
//     the canonical walk (a digest the code computes over a packet that
//     holds a timestamp — the coder's `packet_sha256` — moves every run; what
//     it digests is in the prompt beside it and is in the key);
//   - the replay marker itself (`<model>+replayed`, below) → `<model>`: a
//     later prompt that quotes a stored receipt quotes the marked id, and is
//     the same question it was when the receipt was live;
//   - after all of that, a string longer than 32 KiB (the coder's whole-book
//     input runs to 1.6 MB) → `<text sha256:… chars:N>`: the key still
//     covers every character of it, the file does not carry it, and the
//     entry keeps a short preview beside the request for the miss message.
// The response is stored with the SAME bindings applied (an id the request
// named becomes its `<id:N>`, a run date its `<run-date±k>`), and replay
// substitutes the current request's values back — so a recorded answer that
// names transaction <id:3> answers about this run's transaction, not the
// recording run's. Everything else — the system prompt, the schema, the
// model asked for, every amount, name and line of the document — is in the
// key verbatim: a changed prompt is a different request, never a near match.
//
// LOUD. In replay, a request with no recording throws
// ProviderReplayError(PROVIDER_REPLAY_UNRECORDED) naming the lane, the model,
// the schema, the key, and where the nearest recording of that lane first
// differs — and how to re-record. It never falls through to the network and
// never answers a generic reply. A non-provider, non-loopback request in
// replay is refused too (PROVIDER_REPLAY_NETWORK_REFUSED).
//
// MARKED. A replayed response names its model as `<recorded model>+replayed`
// and its id as `replay_<key prefix>`. Every receipt in this tree takes the
// model id from the RESPONSE (llmCall.js rail 5, providerEndpoints.js
// classifyModelProvenance), so every receipt a replayed answer touches
// carries both the recorded model and the marker, through the receipt code
// that is already there.
//
// SCOPED. Replay serves one demo book. Before serving each answer it calls
// the installer's `assertScope` (the demo passes a read of the book: no firm
// but the demo firm, no company but the demo company); a refusal is
// ProviderReplayError(PROVIDER_REPLAY_FOREIGN_BOOK) and nothing is served.

import { createHash } from 'node:crypto';

import { toUtcIsoDay } from './dates.js';
import { KNOWN_PROVIDER_HOSTS } from './providerEndpoints.js';

export const PROVIDER_REPLAY_FORMAT = 'donna.provider-replay.v1';
export const PROVIDER_REQUEST_IDENTITY_VERSION = 'donna.provider-request-identity.v1';
export const REPLAYED_MODEL_SUFFIX = '+replayed';
// The value a demo puts where a provider key would be, so every lane goes on
// to the wire (each one refuses before the call when its key is absent). It is
// not a key: Host A and the boot line read it as "no credential, replayed".
export const REPLAY_PLACEHOLDER_KEY = 'donna-demo-replay-not-a-key';
export const REPLAY_PROVIDER_KEY_ENV = Object.freeze(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']);
export const DEFAULT_RERECORD_HINT = 'npm run demo:fi:record';

export const PROVIDER_REPLAY_CODES = Object.freeze({
  UNRECORDED: 'PROVIDER_REPLAY_UNRECORDED',
  FOREIGN_BOOK: 'PROVIDER_REPLAY_FOREIGN_BOOK',
  NETWORK_REFUSED: 'PROVIDER_REPLAY_NETWORK_REFUSED',
  BAD_RECORDINGS: 'PROVIDER_REPLAY_BAD_RECORDINGS',
  SECRET_IN_RECORDING: 'PROVIDER_REPLAY_SECRET_IN_RECORDING'
});

export class ProviderReplayError extends Error {
  constructor({ code, message, lane = null, provider = null, model = null, schema = null, key = null, detail = null }) {
    super(message);
    this.name = 'ProviderReplayError';
    this.code = code;
    this.lane = lane;
    this.provider = provider;
    this.model = model;
    this.schema = schema;
    this.key = key;
    this.detail = detail;
    // Not a provider failure: a replay miss is a defect of the recordings or
    // the code, never "the provider did not answer, retry later".
    this.replayFailure = true;
  }
}

// ── Lanes (moved from testSupport/recordedProviders.js, which re-exports) ──
// A request is classified into a LANE from what the production module itself
// puts on the wire — the OpenAI Responses `text.format.name` (each extractor
// / coder / drafter names its strict schema) and the Anthropic `system`
// prompt's opening words (each matcher / disposition producer opens with a
// fixed sentence).
export const OPENAI_SCHEMA_LANES = Object.freeze({
  document_routing: 'document_routing',
  unified_extraction: 'unified_extraction',
  supplier_bill_extraction: 'supplier_bill_extraction',
  receipt_extraction: 'receipt_extraction',
  sales_invoice_extraction: 'sales_invoice_extraction',
  payout_statement_extraction: 'payout_statement_extraction',
  contract_extraction: 'contract_extraction',
  generic_document_extraction: 'generic_document_extraction',
  bank_statement_extraction: 'bank_statement_extraction',
  transaction_coding_batch_suggestion: 'transaction_coding',
  transaction_coding_suggestion: 'transaction_coding',
  client_ask_message_draft: 'ask_drafting',
  receipt_semantic_classifier: 'receipt_classification',
  parser_repair: 'parser_repair',
  firm_fact_distillation: 'memory_extraction',
  document_chat_response: 'document_chat'
});

export const ANTHROPIC_SYSTEM_LANES = Object.freeze([
  Object.freeze({ lane: 'ae_vat_facts', prefix: 'Assess the exact settled invoice' }),
  Object.freeze({ lane: 'owner_reply', prefix: 'Read the persisted ask and exact owner reply' }),
  Object.freeze({ lane: 'chat_engine', prefix: 'You are Donna, the bookkeeper for the business named in the client block' }),
  Object.freeze({ lane: 'reconciliation_reasoning', prefix: 'You match a parsed ' }),
  Object.freeze({ lane: 'bank_line_disposition', prefix: 'You triage a single unmatched bank ' }),
  Object.freeze({ lane: 'document_disposition', prefix: 'You triage a single parsed evidence DOCUMENT' }),
  // documentSettlementEntry.js — the expense account of a document settled outside the bank feed.
  Object.freeze({ lane: 'settlement_account', prefix: 'You code ONE expense document' }),
  Object.freeze({ lane: 'reconciliation_triage', prefix: 'You evaluate low-confidence ' }),
  Object.freeze({ lane: 'unified_extraction', prefix: 'You are extracting fields from one financial document' })
]);

const hostRegistry = () => new Map(KNOWN_PROVIDER_HOSTS.map(({ host, endpointClass }) => [host, endpointClass]));

const systemTextOf = (body) => {
  if (typeof body?.system === 'string') return body.system;
  if (Array.isArray(body?.system)) {
    return body.system.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('\n');
  }
  if (Array.isArray(body?.messages)) {
    const system = body.messages.find((message) => message?.role === 'system');
    if (typeof system?.content === 'string') return system.content;
  }
  return '';
};

const schemaNameOf = (body) =>
  body?.text?.format?.name
  || body?.response_format?.json_schema?.name
  || null;

const requestText = (init) => {
  const raw = init?.body;
  if (raw == null) return null;
  return typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
};

export const parseRequestBody = (init) => {
  const text = requestText(init);
  if (text == null) return null;
  try { return JSON.parse(text); } catch { return null; }
};

const urlOf = (url) => {
  try {
    return new URL(typeof url === 'string' ? url : url?.url || String(url));
  } catch {
    return null;
  }
};

// Pure: what lane does this outbound request belong to? Null for a host that
// is not in the provider registry.
export const classifyProviderRequest = ({ url, init = {} } = {}) => {
  const parsed = urlOf(url);
  if (!parsed) return null;
  const endpointClass = hostRegistry().get(parsed.host) || null;
  if (!endpointClass) return null;
  const body = parseRequestBody(init);
  const schemaName = schemaNameOf(body);
  const systemText = systemTextOf(body);
  let lane = null;
  if (schemaName && OPENAI_SCHEMA_LANES[schemaName]) {
    lane = OPENAI_SCHEMA_LANES[schemaName];
  } else if (systemText) {
    lane = ANTHROPIC_SYSTEM_LANES.find(({ prefix }) => systemText.startsWith(prefix))?.lane || null;
  }
  if (!lane) {
    lane = `${endpointClass}:${schemaName || (systemText ? systemText.slice(0, 40).trim() : parsed.pathname)}`;
  }
  const text = requestText(init);
  return {
    lane,
    host: parsed.host,
    endpoint_class: endpointClass,
    pathname: parsed.pathname,
    method: String(init?.method || 'GET').toUpperCase(),
    schema_name: schemaName,
    system_prefix: systemText ? systemText.slice(0, 60) : null,
    model_requested: typeof body?.model === 'string' ? body.model : null,
    body_bytes: text == null ? 0 : Buffer.byteLength(text)
  };
};

// ── Canonical JSON + digests ───────────────────────────────────────────────
export const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
};
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

// ── Normalization ──────────────────────────────────────────────────────────
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const DIGEST_PATTERN = /(?<![0-9a-f:])[0-9a-f]{64}(?![0-9a-f])/g;
const TIMESTAMP_PATTERN = /\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?|\s\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?)(?:Z|[+-]\d{2}:?\d{2})?/g;
const BASE64_PATTERN = /^[A-Za-z0-9+/\r\n]+={0,2}$/;
const DATA_URL_PATTERN = /^data:([^;,]+);base64,(.*)$/s;
const EPOCH_MS_WINDOW = 30 * 24 * 3600 * 1000;
export const LONG_TEXT_CHARS = 32 * 1024;
const LONG_TEXT_TOKEN = /^<text sha256:[0-9a-f]{64} chars:\d+>$/;
const RUN_DATE_SPAN_DAYS = 3;

const bytesToken = (base64) => {
  const bytes = Buffer.from(base64.replace(/[\r\n]/g, ''), 'base64');
  return `<bytes sha256:${sha256(bytes)}>`;
};

const isoDay = (ms) => toUtcIsoDay(new Date(ms));
// The run's own calendar: today and RUN_DATE_SPAN_DAYS either side, in the
// forms the prompts print dates in. Longest form first so 10.11.2026 is not
// half-replaced by a shorter match.
export const runDateTokens = (nowMs) => {
  const tokens = [];
  for (let k = -RUN_DATE_SPAN_DAYS; k <= RUN_DATE_SPAN_DAYS; k += 1) {
    const day = isoDay(nowMs + k * 86_400_000);
    const [y, m, d] = day.split('-');
    const label = `<run-date${k < 0 ? k : `+${k}`}>`;
    tokens.push({ value: day, label });
    tokens.push({ value: `${Number(d)}.${Number(m)}.${y}`, label });
    tokens.push({ value: `${d}.${m}.${y}`, label });
  }
  return tokens.sort((a, b) => b.value.length - a.value.length);
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const makeNormalizer = ({ nowMs }) => {
  const bindings = new Map(); // original → placeholder
  const previews = {};
  const longTexts = {};
  const dates = runDateTokens(nowMs);
  const dateRegex = new RegExp(`(?<![0-9.])(${dates.map((t) => escapeRegex(t.value)).join('|')})(?![0-9])`, 'g');
  const dateLabel = new Map(dates.map((t) => [t.value, t.label]));
  const bind = (original) => {
    if (!bindings.has(original)) bindings.set(original, `<id:${bindings.size + 1}>`);
    return bindings.get(original);
  };
  const text = (value) => {
    const data = DATA_URL_PATTERN.exec(value);
    if (data && BASE64_PATTERN.test(data[2]) && data[2].length >= 64) return `data:${data[1]};base64,${bytesToken(data[2])}`;
    if (value.length >= 256 && BASE64_PATTERN.test(value)) return bytesToken(value);
    if (LONG_TEXT_TOKEN.test(value)) return value;
    const normalized = value
      .split(REPLAYED_MODEL_SUFFIX).join('')
      .replace(TIMESTAMP_PATTERN, '<timestamp>')
      .replace(UUID_PATTERN, (match) => bind(match.toLowerCase()))
      .replace(DIGEST_PATTERN, (match) => bind(match))
      .replace(dateRegex, (match) => dateLabel.get(match) || match);
    if (normalized.length <= LONG_TEXT_CHARS) return normalized;
    const digest = sha256(normalized);
    previews[digest] = normalized.slice(0, 600);
    longTexts[digest] = normalized;
    return `<text sha256:${digest} chars:${normalized.length}>`;
  };
  const number = (value) => (Number.isInteger(value) && Math.abs(value - nowMs) <= EPOCH_MS_WINDOW ? '<epoch-ms>' : value);
  const walk = (value) => {
    if (typeof value === 'string') return text(value);
    if (typeof value === 'number') return number(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      const out = {};
      for (const key of Object.keys(value).sort()) out[key] = walk(value[key]);
      return out;
    }
    return value;
  };
  return { walk, bindings, dates, previews, longTexts };
};

// The identity of one outbound provider request. `bindings` is the run's own
// id ↔ placeholder map, used to move a response between runs.
export const providerRequestIdentity = ({ url, init = {}, now = Date.now } = {}) => {
  const parsed = urlOf(url);
  if (!parsed) return null;
  const body = parseRequestBody(init);
  if (body == null) return null;
  const nowMs = typeof now === 'function' ? now() : Number(now);
  const normalizer = makeNormalizer({ nowMs });
  const normalized = normalizer.walk(body);
  const endpoint = `${parsed.host}${parsed.pathname}`;
  const key = sha256(canonicalJson({ v: PROVIDER_REQUEST_IDENTITY_VERSION, endpoint, body: normalized }));
  return { key, endpoint, request: normalized, bindings: normalizer.bindings, dates: normalizer.dates, previews: normalizer.previews, longTexts: normalizer.longTexts };
};

// Apply a request's bindings to a response (record) or undo them (replay).
const mapStrings = (value, fn) => {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((entry) => mapStrings(entry, fn));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
  }
  return value;
};

const replaceAllTokens = (text, pairs) => {
  if (!pairs.length) return text;
  const regex = new RegExp(pairs.map(([from]) => escapeRegex(from)).join('|'), 'gi');
  const lookup = new Map(pairs.map(([from, to]) => [from.toLowerCase(), to]));
  return text.replace(regex, (match) => lookup.get(match.toLowerCase()) ?? match);
};

export const bindResponse = (body, identity) => {
  const pairs = [...identity.bindings.entries()].sort((a, b) => b[0].length - a[0].length);
  const datePairs = identity.dates.map((t) => [t.value, t.label]);
  return mapStrings(body, (text) => {
    const ids = replaceAllTokens(text, pairs);
    return ids.replace(new RegExp(`(?<![0-9.])(${datePairs.map(([v]) => escapeRegex(v)).join('|')})(?![0-9])`, 'g'),
      (match) => datePairs.find(([v]) => v === match)?.[1] || match);
  });
};

export const unbindResponse = (body, identity) => {
  const reverse = new Map([...identity.bindings.entries()].map(([original, placeholder]) => [placeholder, original]));
  // A <run-date±k> comes back as this run's ISO day for that offset.
  const isoByLabel = new Map(identity.dates.filter((t) => /^\d{4}-/.test(t.value)).map((t) => [t.label, t.value]));
  return mapStrings(body, (text) => text
    .replace(/<id:\d+>/g, (match) => reverse.get(match) ?? match)
    .replace(/<run-date[+-]\d+>/g, (match) => isoByLabel.get(match) ?? match));
};

// ── Recordings: the file format ────────────────────────────────────────────
// Long strings (system prompts, schemas) repeat across calls; the file keeps
// each once in `texts` and refers to it as { "$text": sha256 }.
const TEXT_DEDUPE_MIN = 400;
export const packRecordings = (recordings) => {
  const texts = {};
  const pack = (value) => {
    if (typeof value === 'string' && value.length >= TEXT_DEDUPE_MIN) {
      const id = sha256(value).slice(0, 24);
      texts[id] = value;
      return { $text: id };
    }
    if (Array.isArray(value)) return value.map(pack);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, pack(v)]));
    return value;
  };
  const entries = recordings.entries.map((entry) => ({ ...entry, request: pack(entry.request), responses: pack(entry.responses) }));
  return { ...recordings, entries, texts: Object.fromEntries(Object.keys(texts).sort().map((k) => [k, texts[k]])) };
};

export const unpackRecordings = (file) => {
  if (!file || file.format !== PROVIDER_REPLAY_FORMAT || !Array.isArray(file.entries)) {
    throw new ProviderReplayError({ code: PROVIDER_REPLAY_CODES.BAD_RECORDINGS, message: `provider replay: not a ${PROVIDER_REPLAY_FORMAT} recordings file` });
  }
  if (file.identity !== PROVIDER_REQUEST_IDENTITY_VERSION) {
    throw new ProviderReplayError({
      code: PROVIDER_REPLAY_CODES.BAD_RECORDINGS,
      message: `provider replay: the recordings use request identity ${file.identity}, this code computes ${PROVIDER_REQUEST_IDENTITY_VERSION}; re-record with \`${DEFAULT_RERECORD_HINT}\``
    });
  }
  const texts = file.texts || {};
  const unpack = (value) => {
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && typeof value.$text === 'string') {
      if (!(value.$text in texts)) throw new ProviderReplayError({ code: PROVIDER_REPLAY_CODES.BAD_RECORDINGS, message: `provider replay: text ${value.$text} missing from the recordings` });
      return texts[value.$text];
    }
    if (Array.isArray(value)) return value.map(unpack);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unpack(v)]));
    return value;
  };
  const entries = file.entries.map((entry) => ({ ...entry, request: unpack(entry.request), responses: unpack(entry.responses) }));
  for (const entry of entries) {
    const key = sha256(canonicalJson({ v: PROVIDER_REQUEST_IDENTITY_VERSION, endpoint: entry.endpoint, body: entry.request }));
    if (key !== entry.key || !Array.isArray(entry.responses) || !entry.responses.length) {
      throw new ProviderReplayError({ code: PROVIDER_REPLAY_CODES.BAD_RECORDINGS, lane: entry.lane, key: entry.key, message: `provider replay: recording ${entry.key} (${entry.lane}) does not hash to its key or has no response` });
    }
  }
  const { texts: _texts, ...rest } = file;
  return { ...rest, entries };
};

// The models a recordings file answers with, per provider — what the boot
// line, Host A, the health route and the screens name.
export const recordedModels = (recordings) => {
  const byProvider = {};
  for (const entry of recordings.entries || []) {
    for (const response of entry.responses || []) {
      const model = typeof response?.body?.model === 'string' ? response.body.model : null;
      if (!model) continue;
      const list = byProvider[entry.provider] ||= [];
      const label = entry.provenance === 'live' ? model : `${model} (${entry.provenance})`;
      if (!list.includes(label)) list.push(label);
    }
  }
  for (const list of Object.values(byProvider)) list.sort();
  return byProvider;
};

export const recordingsDigest = (file) => sha256(canonicalJson(file));

// A recorded answer as the response it was (no replay marker): what a
// re-recording pass hands its own recorder for a request it already holds,
// so the pass keeps it under this run's ids without calling the provider.
export const recordedResponseFor = (entry, identity, served = 0) => {
  const recorded = entry.responses[Math.min(served, entry.responses.length - 1)];
  return new Response(JSON.stringify(unbindResponse(recorded.body, identity)), {
    status: recorded.status,
    headers: { 'content-type': recorded.content_type || 'application/json' }
  });
};

// ── Secret hygiene ─────────────────────────────────────────────────────────
// Nothing in a recording may look like a key, a header, or an account or
// request identifier. The recorder refuses to write one; a test scans the
// committed file with the same list.
export const SECRET_PATTERNS = Object.freeze([
  Object.freeze({ name: 'openai_key', pattern: /sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/ }),
  Object.freeze({ name: 'anthropic_key', pattern: /sk-ant-[A-Za-z0-9_-]{10,}/ }),
  Object.freeze({ name: 'bearer_header', pattern: /bearer\s+[A-Za-z0-9._~+/-]{12,}/i }),
  Object.freeze({ name: 'api_key_header', pattern: /x-api-key|"authorization"\s*:/i }),
  Object.freeze({ name: 'openai_org_or_project', pattern: /\b(?:org|proj)[-_][A-Za-z0-9]{16,}\b/ }),
  Object.freeze({ name: 'provider_request_id', pattern: /\breq_[A-Za-z0-9]{16,}\b/ }),
  Object.freeze({ name: 'anthropic_message_id', pattern: /\bmsg_0[A-Za-z0-9]{16,}\b/ }),
  Object.freeze({ name: 'openai_response_id', pattern: /\bresp_[a-f0-9]{32,}\b/ }),
  Object.freeze({ name: 'organization_field', pattern: /"(?:organization|openai-organization|anthropic-organization-id|user_id|safety_identifier)"\s*:\s*"[^"]+"/i })
]);

export const findSecretShapes = (text, { extraValues = [] } = {}) => {
  const found = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    const match = pattern.exec(text);
    if (match) found.push({ name, at: match.index });
  }
  for (const value of extraValues) {
    if (typeof value === 'string' && value.trim().length >= 8 && value !== REPLAY_PLACEHOLDER_KEY && text.includes(value.trim())) {
      found.push({ name: 'configured_key_value', at: text.indexOf(value.trim()) });
    }
  }
  return found;
};

// A provider response as it may be kept: provider-side ids replaced by one
// derived from the request key; nothing else touched.
const scrubResponseBody = (body, key) => {
  if (!body || typeof body !== 'object') return body;
  const out = { ...body };
  if (typeof out.id === 'string') out.id = `recorded_${key.slice(0, 24)}`;
  for (const field of ['user', 'safety_identifier', 'prompt_cache_key', 'organization', 'metadata']) delete out[field];
  if (Array.isArray(out.output)) {
    out.output = out.output.map((item, index) => (item && typeof item === 'object' && typeof item.id === 'string'
      ? { ...item, id: `recorded_${key.slice(0, 16)}_${index}` } : item));
  }
  return out;
};

// ── The active replay, for receipts ────────────────────────────────────────
let activeReplay = null;
export const currentProviderReplay = () => activeReplay;

const nearestDifference = (requested, candidates) => {
  const want = canonicalJson(requested);
  let best = null;
  for (const entry of candidates) {
    const have = canonicalJson(entry.request);
    let i = 0;
    while (i < want.length && i < have.length && want[i] === have[i]) i += 1;
    if (!best || i > best.common) best = { entry, common: i, have };
  }
  if (!best) return null;
  const from = Math.max(0, best.common - 80);
  return {
    nearest_key: best.entry.key,
    common_prefix_chars: best.common,
    requested: want.slice(from, best.common + 160),
    recorded: best.have.slice(from, best.common + 160)
  };
};

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1', 'local-runtime']);
const isLoopback = (parsed) => Boolean(parsed) && (LOOPBACK_HOSTS.has(parsed.hostname) || parsed.protocol === 'file:');

const jsonResponse = (status, body, contentType = 'application/json') =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': contentType } });

// Install REPLAY on `target.fetch`. `recordings` is an unpacked file.
// `assertScope()` runs before each answer and throws to refuse. Returns a
// controller with the served/missed ledger and `restore()`.
export const installProviderReplay = ({
  recordings,
  target = globalThis,
  assertScope = null,
  now = Date.now,
  rerecordHint = DEFAULT_RERECORD_HINT,
  logger = null,
  // Diagnosis only: called with every normalized request and whether it was
  // served (scripts/demo_fi.mjs --trace).
  onRequest = null
} = {}) => {
  if (!recordings || !Array.isArray(recordings.entries)) throw new ProviderReplayError({ code: PROVIDER_REPLAY_CODES.BAD_RECORDINGS, message: 'provider replay: no recordings' });
  if (activeReplay) throw new Error('provider replay: already installed in this process');
  const realFetch = target.fetch;
  const byKey = new Map(recordings.entries.map((entry) => [entry.key, { entry, served: 0 }]));
  const served = [];
  const missed = [];
  const refusedNetwork = [];
  const models = recordedModels(recordings);

  const wrapper = async (input, init = {}) => {
    const parsed = urlOf(input);
    const classified = classifyProviderRequest({ url: input, init });
    if (!classified) {
      if (isLoopback(parsed)) return realFetch(input, init);
      const error = new ProviderReplayError({
        code: PROVIDER_REPLAY_CODES.NETWORK_REFUSED,
        message: `provider replay: refused a request to ${parsed?.host || String(input)} — the demo makes no network call`
      });
      refusedNetwork.push({ host: parsed?.host || null, path: parsed?.pathname || null });
      throw error;
    }
    const identity = providerRequestIdentity({ url: input, init, now });
    const slot = identity ? byKey.get(identity.key) : null;
    try { onRequest?.({ lane: classified.lane, key: identity?.key || null, served: Boolean(slot), request: identity?.request || null, long_texts: identity?.longTexts || {} }); } catch { /* diagnosis never changes the answer */ }
    if (!slot) {
      const sameLane = recordings.entries.filter((entry) => entry.lane === classified.lane);
      const diff = identity ? nearestDifference(identity.request, sameLane) : null;
      const ledger = { lane: classified.lane, provider: classified.endpoint_class, model: classified.model_requested, schema: classified.schema_name, key: identity?.key || null, diff };
      const error = new ProviderReplayError({
        code: PROVIDER_REPLAY_CODES.UNRECORDED,
        lane: classified.lane,
        provider: classified.endpoint_class,
        model: classified.model_requested,
        schema: classified.schema_name,
        key: identity?.key || null,
        detail: diff,
        message: `provider replay: no recording for lane "${classified.lane}" (${classified.endpoint_class} ${classified.model_requested || 'model ?'}`
          + `${classified.schema_name ? `, schema ${classified.schema_name}` : ''}${classified.system_prefix && !classified.schema_name ? `, system "${classified.system_prefix.slice(0, 48)}…"` : ''}; request ${identity?.key?.slice(0, 16) || 'unreadable'}). `
          + (diff ? `Nearest recording of this lane (${diff.nearest_key.slice(0, 16)}) first differs after ${diff.common_prefix_chars} chars: asked …${diff.requested.slice(60, 200)}… recorded …${diff.recorded.slice(60, 200)}…. ` : `No recording of lane "${classified.lane}" exists. `)
          + `The code asks for something the recordings do not hold; re-record with \`${rerecordHint}\`.`
      });
      // The normalized request (and the full text of any digested long
      // string) stays in memory for the caller's diagnosis file; it is the
      // same synthetic content the code sent, never a header.
      missed.push({ ...ledger, message: error.message, error, request: identity?.request || null, long_texts: identity?.longTexts || {} });
      logger?.error?.(`[provider-replay] ${error.message}`);
      throw error;
    }
    if (assertScope) await assertScope({ lane: classified.lane });
    const index = Math.min(slot.served, slot.entry.responses.length - 1);
    slot.served += 1;
    const recorded = slot.entry.responses[index];
    let body = unbindResponse(recorded.body, identity);
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      body = {
        ...body,
        ...(typeof body.model === 'string' ? { model: `${body.model}${REPLAYED_MODEL_SUFFIX}` } : {}),
        ...(typeof body.id === 'string' ? { id: `replay_${identity.key.slice(0, 24)}` } : {})
      };
    }
    served.push({ lane: classified.lane, provider: classified.endpoint_class, key: identity.key, status: recorded.status, model: body?.model || null });
    return jsonResponse(recorded.status, body, recorded.content_type || 'application/json');
  };

  target.fetch = wrapper;
  activeReplay = Object.freeze({
    mode: 'replay',
    pack: recordings.pack || null,
    recorded_at: recordings.recorded_at || null,
    recordings_digest: recordings.digest || null,
    models,
    entries: recordings.entries.length
  });
  return {
    served,
    missed,
    refusedNetwork,
    state: activeReplay,
    restore() {
      if (target.fetch === wrapper) target.fetch = realFetch;
      activeReplay = null;
    }
  };
};

// Install the RECORDER on `target.fetch`: provider requests go to
// `answer(input, init, classified)` (the live network by default, or a
// scripted stand-in) and each answer is kept with the identity of the request
// it answered. Loopback passes through; anything else is refused.
export const installProviderRecorder = ({
  target = globalThis,
  answer = null,
  now = Date.now,
  secretValues = [],
  logger = null
} = {}) => {
  const realFetch = target.fetch;
  const entries = new Map();
  const ledger = [];
  const refusedNetwork = [];
  const forward = answer || (async (input, init) => ({ response: await realFetch(input, init), provenance: 'live' }));

  const wrapper = async (input, init = {}) => {
    const parsed = urlOf(input);
    const classified = classifyProviderRequest({ url: input, init });
    if (!classified) {
      if (isLoopback(parsed)) return realFetch(input, init);
      refusedNetwork.push({ host: parsed?.host || null, path: parsed?.pathname || null });
      throw new TypeError(`provider recorder: refused a non-provider request to ${parsed?.host}`);
    }
    const identity = providerRequestIdentity({ url: input, init, now });
    const started = Date.now();
    const { response, provenance } = await forward(input, init, classified, identity);
    const contentType = response.headers.get('content-type') || 'application/json';
    const text = await response.clone().text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    ledger.push({ lane: classified.lane, provider: classified.endpoint_class, status: response.status, model: body?.model || null, usage: body?.usage || null, provenance, ms: Date.now() - started });
    if (identity && response.status === 200) {
      const kept = { status: response.status, content_type: contentType.split(';')[0], body: bindResponse(scrubResponseBody(body, identity.key), identity) };
      const scan = findSecretShapes(JSON.stringify({ request: identity.request, response: kept }), { extraValues: secretValues });
      if (scan.length) {
        logger?.error?.(`[provider-recorder] refused to keep a ${classified.lane} answer: secret-shaped ${scan.map((s) => s.name).join(', ')}`);
      } else {
        const existing = entries.get(identity.key);
        if (existing) existing.responses.push(kept);
        else {
          entries.set(identity.key, {
            key: identity.key,
            lane: classified.lane,
            provider: classified.endpoint_class,
            endpoint: identity.endpoint,
            model_requested: classified.model_requested,
            schema: classified.schema_name,
            provenance,
            request: identity.request,
            ...(Object.keys(identity.previews).length ? { previews: identity.previews } : {}),
            responses: [kept]
          });
        }
      }
    }
    return response;
  };
  target.fetch = wrapper;
  return {
    ledger,
    refusedNetwork,
    entries: () => [...entries.values()].sort((a, b) => (a.lane === b.lane ? a.key.localeCompare(b.key) : a.lane.localeCompare(b.lane))),
    restore() { if (target.fetch === wrapper) target.fetch = realFetch; }
  };
};
