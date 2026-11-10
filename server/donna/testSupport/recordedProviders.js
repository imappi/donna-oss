// Recorded providers — the HTTP-boundary stub for every model lane (RT-06,
// docs/plan-2026-09-01-runtime-refactor-slices.md; audit F-20 / §9).
//
// What this is: a replacement for the process-global `fetch` that serves
// COMMITTED, REDACTED provider responses to any request bound for a host in
// the provider registry (providerEndpoints.js KNOWN_PROVIDER_HOSTS — the
// hosts are read from the registry, never named here, so the llmCall.test.js
// provider-URL ratchet and the modelLanes.test.js census both stay blind to
// this module by construction). Every other URL — the runtime's own
// parse-cron self-call over loopback foremost — passes through to the real
// fetch untouched.
//
// Why at the HTTP boundary and not at a module seam: the appliance path the
// harness proves (runtime server → local scheduler → HTTP self-call → drain →
// runParseInline → extractors → writers → matchers) crosses ~28 direct
// provider call sites plus the llmCall envelope. Stubbing each seam would
// re-create exactly the "tests validate helpers and mocks" problem F-20
// names. One stub at the wire keeps every production module unmodified and
// every lane's real request shaping, parsing, retry and receipt code on the
// path.
//
// Lanes. A request is classified into a LANE from what the production module
// itself puts on the wire — the OpenAI Responses `text.format.name` (each
// extractor / coder / drafter names its strict schema) and the Anthropic
// `system` prompt's opening words (each matcher / disposition producer opens
// with a fixed sentence). The ids reuse modelLanes.js where a registry lane
// exists (document_routing, transaction_coding, reconciliation_reasoning,
// bank_line_disposition, ask_drafting, unified_extraction, …); the legacy
// type extractors — one registry lane, five schemas — are keyed per schema
// (supplier_bill_extraction, receipt_extraction, …) because a test scripts
// them one at a time.
//
// Scripting. `providers.script(lane, steps)` queues per-call responses for a
// lane, in order: `{ status: 429, body }` then `{ recording: 'lane/name' }`
// is "429 once, then this body". A step with `times: Infinity` keeps serving.
// A lane that runs out of steps (or was never scripted) is REFUSED with a
// 418 — a status every caller treats as terminal, never retried with a real
// sleep — and the refusal lands in `providers.unscripted` so the test can
// assert the ledger is empty. Nothing ever falls through to the network.
//
// Receipts. Every served call is journaled (`providers.calls`) with the
// lane, the model the caller REQUESTED, the model the recording SERVED, the
// schema name and the status — "the model id is part of the receipt"
// (CLAUDE.md) holds in tests because the recordings carry the model id in
// the body and the journal shows both sides.
//
// Recordings live under server/donna/fixtures/recordings/<lane>/<name>.json.
// They are wire-shaped provider bodies: synthetic (authored from the
// production schemas, never a captured customer document) or, when captured
// from a real call, redacted. `provenance` on each file says which.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { KNOWN_PROVIDER_HOSTS } from '../providerEndpoints.js';

export const RECORDINGS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'recordings'
);

// OpenAI Responses / chat-completions strict-schema names → lane id. The
// left-hand side is what the production module puts in
// `text.format.name`; the right-hand side is the lane a test scripts.
export const OPENAI_SCHEMA_LANES = Object.freeze({
  document_routing: 'document_routing',
  // RT-12: the unified extractor on its OpenAI transport names its strict
  // schema `unified_extraction`; on Anthropic the same lane is recognised by
  // its system-prompt prefix below. One lane id either way.
  unified_extraction: 'unified_extraction',
  supplier_bill_extraction: 'supplier_bill_extraction',
  receipt_extraction: 'receipt_extraction',
  sales_invoice_extraction: 'sales_invoice_extraction',
  // RT-18: the payout / deposit-slip extractor (payoutStatement.js).
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
  document_chat_response: 'document_chat',
  // 2026-11-10: the remaining text lanes, so one lane id scripts a lane on
  // either provider (the Anthropic prefixes below use the same ids).
  owner_invoice_command_reading: 'owner_invoice_command_read',
  outbound_owner_reply_verdict: 'owner_reply_classification',
  marketing_nurture_draft: 'marketing_nurture_draft',
  marketing_reply_triage: 'marketing_reply_triage',
  marketing_reply_draft: 'marketing_reply_draft',
  prospect_dossier: 'prospect_dossier',
  marketing_social_posts: 'marketing_social_posts'
});

// Anthropic lanes open their system prompt with a fixed sentence; the
// prefix is the signature. Order matters only for readability — the
// prefixes are disjoint.
export const ANTHROPIC_SYSTEM_LANES = Object.freeze([
  Object.freeze({ lane: 'ae_vat_facts', prefix: 'Assess the exact settled invoice' }),
  Object.freeze({ lane: 'owner_reply', prefix: 'Read the persisted ask and exact owner reply' }),
  Object.freeze({ lane: 'chat_engine', prefix: 'You are Donna, the bookkeeper for the business named in the client block' }),
  Object.freeze({ lane: 'reconciliation_reasoning', prefix: 'You match a parsed ' }),
  Object.freeze({ lane: 'bank_line_disposition', prefix: 'You triage a single unmatched bank ' }),
  Object.freeze({ lane: 'document_disposition', prefix: 'You triage a single parsed evidence DOCUMENT' }),
  Object.freeze({ lane: 'reconciliation_triage', prefix: 'You evaluate low-confidence ' }),
  Object.freeze({ lane: 'unified_extraction', prefix: 'You are extracting fields from one financial document' }),
  // 2026-11-10 (Claude only): the text lanes on their Anthropic transport.
  // Same lane ids as their OpenAI schema names map to above; the system
  // prompt is each lane's own instructions, unchanged.
  Object.freeze({ lane: 'transaction_coding', prefix: 'You code bank transactions for a bookkeeping firm\'s client.' }),
  Object.freeze({ lane: 'ask_drafting', prefix: 'You draft the bookkeeping firm\'s periodic message to its client.' }),
  Object.freeze({ lane: 'memory_extraction', prefix: 'You distill durable LOCAL knowledge for a bookkeeping firm' }),
  Object.freeze({ lane: 'owner_invoice_command_read', prefix: 'You read a message a business OWNER sent to Donna' }),
  Object.freeze({ lane: 'owner_reply_classification', prefix: 'You classify an email reply from a business OWNER to Donna' }),
  Object.freeze({ lane: 'document_chat', prefix: 'You are Donna, an accounting assistant embedded in a document' }),
  Object.freeze({ lane: 'marketing_nurture_draft', prefix: 'You write short nurture emails for Donna' }),
  Object.freeze({ lane: 'marketing_reply_triage', prefix: 'You triage inbound email for Donna' }),
  Object.freeze({ lane: 'marketing_reply_draft', prefix: 'You draft Donna\'s reply to an email she received.' }),
  Object.freeze({ lane: 'prospect_dossier', prefix: 'You are the investigator for Donna' }),
  Object.freeze({ lane: 'marketing_social_posts', prefix: 'You write public posts for ' })
]);

export const UNSCRIPTED_STATUS = 418;

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

const parseBody = (init) => {
  const raw = init?.body;
  if (raw == null) return null;
  try {
    return JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'));
  } catch {
    return null;
  }
};

// Pure: what lane does this outbound request belong to? Returns null for a
// non-provider host (the caller passes the request through). Exported so the
// classification itself is testable without a fetch.
export const classifyProviderRequest = ({ url, init = {} } = {}) => {
  let parsed;
  try {
    parsed = new URL(typeof url === 'string' ? url : url?.url || String(url));
  } catch {
    return null;
  }
  const endpointClass = hostRegistry().get(parsed.host) || null;
  if (!endpointClass) return null;
  const body = parseBody(init);
  const schemaName = schemaNameOf(body);
  const systemText = systemTextOf(body);
  let lane = null;
  if (schemaName && OPENAI_SCHEMA_LANES[schemaName]) {
    lane = OPENAI_SCHEMA_LANES[schemaName];
  } else if (systemText) {
    // Leading whitespace is not part of a signature (document chat's prompt
    // opens with a newline).
    const opening = systemText.trimStart();
    lane = ANTHROPIC_SYSTEM_LANES.find(({ prefix }) => opening.startsWith(prefix))?.lane || null;
  }
  if (!lane) {
    // Unknown lane: still refused, still journaled — but named by what the
    // wire carried so the test author sees what to add.
    lane = `${endpointClass}:${schemaName || (systemText ? systemText.slice(0, 40).trim() : parsed.pathname)}`;
  }
  return {
    lane,
    host: parsed.host,
    endpoint_class: endpointClass,
    pathname: parsed.pathname,
    method: String(init?.method || 'GET').toUpperCase(),
    schema_name: schemaName,
    system_prefix: systemText ? systemText.slice(0, 60) : null,
    model_requested: typeof body?.model === 'string' ? body.model : null,
    // Sizes only — never the payload (a Responses body carries the document).
    body_bytes: init?.body == null ? 0 : Buffer.byteLength(typeof init.body === 'string' ? init.body : Buffer.from(init.body))
  };
};

export const recordingPath = (name) => path.join(RECORDINGS_DIR, `${String(name).replace(/\.json$/, '')}.json`);

// Load a committed recording. `name` is '<lane>/<file>'; the file's own
// `lane` must agree so a recording cannot be scripted onto the wrong lane.
export const loadRecording = (name) => {
  const file = recordingPath(name);
  const recording = JSON.parse(readFileSync(file, 'utf8'));
  const [laneFromName] = String(name).split('/');
  if (!recording.lane || recording.lane !== laneFromName) {
    throw new Error(`recording ${name} declares lane "${recording.lane}" but lives under "${laneFromName}"`);
  }
  if (!Number.isInteger(recording.status) || !recording.body || typeof recording.body !== 'object') {
    throw new Error(`recording ${name} needs an integer status and an object body`);
  }
  return { ...recording, name };
};

const modelServedOf = (body) => (typeof body?.model === 'string' && body.model ? body.model : null);

const jsonResponse = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });

// Normalize a script step into { status, body, headers, times, recording }.
const normalizeStep = (lane, step) => {
  if (typeof step === 'string') step = { recording: step };
  if (!step || typeof step !== 'object') throw new Error(`recorded-providers: bad script step for lane ${lane}`);
  if (typeof step.respond === 'function') return { respond: step.respond, times: step.times ?? 1, recording: null };
  if (step.recording) {
    const recording = loadRecording(step.recording);
    if (recording.lane !== lane) {
      throw new Error(`recorded-providers: recording ${step.recording} is for lane ${recording.lane}, scripted on ${lane}`);
    }
    return {
      status: step.status ?? recording.status,
      body: step.body ?? recording.body,
      headers: step.headers ?? recording.headers ?? {},
      times: step.times ?? 1,
      recording: recording.name
    };
  }
  if (!Number.isInteger(step.status)) throw new Error(`recorded-providers: script step for lane ${lane} needs a status`);
  return {
    status: step.status,
    body: step.body ?? { error: { type: 'recorded_providers_scripted_error', message: `scripted ${step.status} for ${lane}` } },
    headers: step.headers ?? {},
    times: step.times ?? 1,
    recording: null
  };
};

// Install the stub on globalThis.fetch (or on the `target` object given).
// Returns the controller; call `restore()` in the test's finally.
export const installRecordedProviders = ({
  target = globalThis,
  realFetch = target.fetch,
  now = () => new Date()
} = {}) => {
  if (typeof realFetch !== 'function') throw new Error('recorded-providers: no real fetch to wrap');
  const scripts = new Map(); // lane -> [normalized step]
  const calls = [];
  const unscripted = [];
  let seq = 0;
  let installed = true;

  const takeStep = (lane) => {
    const queue = scripts.get(lane);
    if (!queue?.length) return null;
    const step = queue[0];
    if (step.times !== Infinity) {
      step.times -= 1;
      if (step.times <= 0) queue.shift();
    }
    return step;
  };

  const stub = async (input, init = {}) => {
    const classified = classifyProviderRequest({ url: input, init });
    if (!classified) return realFetch(input, init);
    seq += 1;
    let step = takeStep(classified.lane);
    if (step?.respond) {
      const response = await step.respond(parseBody(init), classified);
      step = normalizeStep(classified.lane, response);
    }
    const at = now().toISOString();
    if (!step) {
      const entry = { seq, at, ...classified, status: UNSCRIPTED_STATUS, model_served: null, recording: null, refused: true };
      calls.push(entry);
      unscripted.push(entry);
      return jsonResponse(UNSCRIPTED_STATUS, {
        error: {
          type: 'recorded_providers_unscripted',
          message: `recorded-providers: no script for lane "${classified.lane}" (schema ${classified.schema_name || 'n/a'}); `
            + 'script it with providers.script(lane, steps)'
        }
      });
    }
    calls.push({
      seq,
      at,
      ...classified,
      status: step.status,
      model_served: modelServedOf(step.body),
      recording: step.recording,
      refused: false
    });
    return jsonResponse(step.status, step.body, step.headers);
  };

  target.fetch = stub;

  return {
    calls,
    unscripted,
    // Queue responses for a lane. Steps: { status, body?, headers?, times? }
    // or { recording: '<lane>/<name>', status?, times? } or the bare
    // recording name. Appends to any script already queued.
    script(lane, steps) {
      const list = Array.isArray(steps) ? steps : [steps];
      const queue = scripts.get(lane) || [];
      for (const step of list) queue.push(normalizeStep(lane, step));
      scripts.set(lane, queue);
      return this;
    },
    // Steps still queued per lane — a test asserts a script was consumed.
    remaining(lane) {
      const queue = scripts.get(lane) || [];
      return queue.reduce((sum, step) => sum + (step.times === Infinity ? 0 : step.times), 0);
    },
    callsFor(lane) {
      return calls.filter((entry) => entry.lane === lane);
    },
    reset() {
      scripts.clear();
      calls.length = 0;
      unscripted.length = 0;
    },
    // Throws with the ledger when any lane was hit without a script — the
    // shape a fixture's finally block wants.
    assertNoUnscripted() {
      if (!unscripted.length) return;
      const lines = unscripted.map((entry) => `${entry.lane} (${entry.schema_name || entry.system_prefix || entry.pathname}) model=${entry.model_requested || '?'}`);
      throw new Error(`recorded-providers: ${unscripted.length} unscripted provider call(s):\n  ${lines.join('\n  ')}`);
    },
    installed: () => installed,
    restore() {
      if (!installed) return;
      installed = false;
      if (target.fetch === stub) target.fetch = realFetch;
    }
  };
};
