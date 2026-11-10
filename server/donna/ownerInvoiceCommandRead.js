// The model transport for the owner-command adapter (kernel-audit M2, piece 3a).
//
// `ownerInvoiceCommand.js` deliberately owns the PROMPT, the SCHEMA and the Keep
// layer, and takes the model call as an injected `readCommandFn` so the whole
// lane stays unit-testable without a provider. This is the one production
// implementation of that function: HTTP, strict JSON schema, nothing else.
//
// It holds no judgment. It does not interpret the reading, does not fill a
// default, and does not decide whether a fact is good enough — every one of
// those lives behind `constrainCommandReading`. Keeping the transport here is
// what stops `ownerInvoiceCommand.js` from growing a network dependency.
//
// Shaped after `outbound/replyIngestion.js:classifyOwnerReply`, which is the
// tree's established Responses-API + strict-schema idiom.
//
// THE MODEL ID IS PART OF THE RECEIPT (CLAUDE.md). The id returned here is the
// one the API actually served, taken from the response payload rather than from
// the code default, and `runOwnerInvoiceCommand` persists it on the command row.
// A silent env downgrade is therefore visible in the data, not just in the code.

import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import {
  OWNER_COMMAND_SCHEMA_NAME,
  buildCommandInstructions,
  buildCommandInput,
  buildCommandSchema
} from './ownerInvoiceCommand.js';
import { llmCall } from './llmCall.js';
import { getLane } from './modelLanes.js';
import { missingKeyNameFor, resolveTextLaneProvider } from './providerEndpoints.js';
import { anthropicStructuredRequest, openAiResponsesText, typedLlmCallFailure } from './structuredRequest.js';

// Reading an owner's sentence into the facts that become a real invoice to a
// real counterparty is the load-bearing call on this lane — strong model by
// default, OPENAI_MODEL stays the override knob (it may pin a claude-* id).
// 2026-11-10 (owner's decision: Claude only): the lane is provider-agnostic —
// Anthropic (claude-opus-5-5) when its key is present, OpenAI (this default)
// only when no Anthropic key is configured. Effort `high`: one short owner
// sentence becomes an invoice to a real counterparty, so depth is cheap here
// and a misread is not.
const DEFAULT_MODEL = 'gpt-5.4';
const LANE_PROVIDERS = getLane('owner_invoice_command_read').providers;
const ANTHROPIC_EFFORT = 'high';

let dotEnvCache = null;
const readDotEnv = () => {
  if (dotEnvCache) return dotEnvCache;
  const vars = {};
  try {
    const envPath = resolvePath(process.cwd(), '.env');
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, 'utf8').split('\n')) {
        const match = line.match(/^(\w+)=(.*)$/);
        if (match) vars[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
      }
    }
  } catch {
    // Best-effort dotenv fallback for local development.
  }
  dotEnvCache = vars;
  return vars;
};

const resolveReader = ({ openAiConfig = null, env = process.env } = {}) => resolveTextLaneProvider({
  providers: LANE_PROVIDERS, openAiDefaultModel: DEFAULT_MODEL, env, dotEnv: readDotEnv(), openAiConfig
});

export const isOwnerInvoiceCommandReaderConfigured = () => resolveReader().ok;

const outputTextFromResponse = openAiResponsesText;

// One owner sentence → one strict-schema reading. Returns
// { reading, model, telemetry } with the RAW reading; the caller applies the
// Keep layer, so corroboration stays visible at the call site rather than
// hidden in the transport.
//
// M3 / S1 — this is one of the TWO sites G3 names for the first instrumentation
// pass ("the first loop + intent compiler first — NOT five guessed top
// spenders"). Before this, the call discarded `payload.usage` entirely and wrote
// no receipt of any kind: the load-bearing read on the owner-command lane cost
// an unknown number of tokens. It now goes through the shared envelope
// (`llmCall.js`), which owns model/usage/latency/attempt capture and the
// section byte accounting. `telemetry` is null when capture failed — never a
// reason for the read itself to fail (llmCall rail 4).
//
// THROWS on transport / parse failure, on purpose. `runOwnerInvoiceCommand`
// catches it and settles the command as REFUSED with a receipt — a read we could
// not perform is not a command we may guess at, and the owner's sentence never
// evaporates into a silent no-op.
export const readOwnerInvoiceCommand = async ({
  messageText, buyerCandidates = [], today = null,
  fetchImpl = fetch, openAiConfig = null,
  // The typed root execution ref (llmCall rail 3). The owner's source message
  // IS the execution root on this lane — it is the natural key the command row
  // is already built on (migration 104's source_message_id), so telemetry joins
  // to the command without inventing a second identity.
  sourceMessageId = null
} = {}) => {
  const resolved = resolveReader({ openAiConfig });
  if (!resolved.ok) {
    const { keyName } = missingKeyNameFor(resolved, LANE_PROVIDERS);
    throw new Error(`${keyName || 'ANTHROPIC_API_KEY'} is not configured`);
  }

  const instructions = buildCommandInstructions();
  const input = buildCommandInput({ messageText, buyerCandidates, today });
  const schema = buildCommandSchema();
  // MEASURED, then dropped — the envelope keeps sizes, never contents.
  const sections = { system: instructions, tools: schema, context: buyerCandidates, history: messageText };
  const execution = { root: { type: 'owner_invoice_command_message', id: sourceMessageId || 'unattributed' } };

  if (resolved.provider === 'anthropic') {
    let call;
    try {
      call = await llmCall(anthropicStructuredRequest({
        apiKey: resolved.apiKey,
        model: resolved.model,
        system: instructions,
        user: typeof input === 'string' ? input : JSON.stringify(input),
        schema,
        effort: ANTHROPIC_EFFORT,
        maxTokens: 16000,
        sections,
        execution,
        fetchImpl
      }));
    } catch (error) {
      // THROWS, as the OpenAI path does: runOwnerInvoiceCommand settles the
      // command REFUSED with this message as the receipt. The typed failure
      // (a refusal, an output cut at max_tokens, no credit, a bad key, a
      // rate limit) is named in it and rides along as `provider_failure`.
      const typed = typedLlmCallFailure('anthropic', error);
      if (!typed) throw error;
      throw Object.assign(new Error(typed.message), { provider_failure: typed.receipt(), telemetry: error?.telemetry || null });
    }
    return {
      reading: call.result.parsed,
      // The id the API served (llmCall rail 5), never the configured one.
      model: call.result.model || call.telemetry?.model || resolved.model,
      provider: 'anthropic',
      provider_source: resolved.source?.provider || null,
      telemetry: call.telemetry
    };
  }

  const config = { apiKey: resolved.apiKey, model: resolved.model };
  const { result, telemetry } = await llmCall({
    provider: 'openai',
    url: 'https://api.openai.com/v1/responses',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: {
      model: config.model,
      instructions,
      input,
      text: {
        format: {
          type: 'json_schema',
          name: OWNER_COMMAND_SCHEMA_NAME,
          strict: true,
          schema
        }
      }
    },
    sections,
    execution,
    parseResponse: (payload) => ({
      reading: JSON.parse(outputTextFromResponse(payload)),
      model: payload.model || config.model
    }),
    fetchImpl
  });

  return { ...result, provider: 'openai', provider_source: resolved.source?.provider || null, telemetry };
};
