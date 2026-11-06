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

// Reading an owner's sentence into the facts that become a real invoice to a
// real counterparty is the load-bearing call on this lane — strong model by
// default, OPENAI_MODEL stays the override knob. Same convention (and the same
// deliberate local resolver) as askPipeline.js and outbound/replyIngestion.js.
const DEFAULT_MODEL = 'gpt-5.4';

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

const getOpenAiConfig = () => {
  const dotEnv = readDotEnv();
  return {
    apiKey: process.env.OPENAI_API_KEY || dotEnv.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || dotEnv.OPENAI_MODEL || DEFAULT_MODEL
  };
};

export const isOwnerInvoiceCommandReaderConfigured = () => Boolean(getOpenAiConfig().apiKey);

const outputTextFromResponse = (payload) => {
  if (typeof payload?.output_text === 'string' && payload.output_text) return payload.output_text;
  const chunks = [];
  for (const item of payload?.output || []) {
    for (const part of item?.content || []) {
      if (typeof part?.text === 'string') chunks.push(part.text);
    }
  }
  return chunks.join('');
};

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
  const config = openAiConfig || getOpenAiConfig();
  if (!config.apiKey) throw new Error('OPENAI_API_KEY is not configured');

  const instructions = buildCommandInstructions();
  const input = buildCommandInput({ messageText, buyerCandidates, today });
  const schema = buildCommandSchema();

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
    // MEASURED, then dropped — the envelope keeps sizes, never contents.
    sections: { system: instructions, tools: schema, context: buyerCandidates, history: messageText },
    execution: { root: { type: 'owner_invoice_command_message', id: sourceMessageId || 'unattributed' } },
    parseResponse: (payload) => ({
      reading: JSON.parse(outputTextFromResponse(payload)),
      model: payload.model || config.model
    }),
    fetchImpl
  });

  return { ...result, telemetry };
};
