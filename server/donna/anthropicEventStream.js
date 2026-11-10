// Donna — reassemble a streamed Messages API response (server-sent events)
// into the one Message object a non-streamed request returns.
//
// Why: the text lanes moved onto Claude (owner's decision, 2026-11-10) send
// long requests with `stream: true`, because a long request that stays
// silent until it finishes is cut by idle timeouts on the way. The lane
// still wants ONE payload to parse, so llmCall reads the stream to its end
// and hands this function the text; the result is shaped exactly like the
// non-streamed body (id, model, content, stop_reason, stop_details, usage),
// so `parseResponse`, the telemetry (model from the RESPONSE, usage) and the
// recorded-provider stubs see one shape either way.
//
// Pure: a string in, an object out. No network, no retention — the caller
// (llmCall) keeps its own rails.

const parseEvents = (raw) => {
  const events = [];
  for (const chunk of String(raw || '').split(/\r?\n\r?\n/)) {
    let event = null;
    const data = [];
    for (const line of chunk.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length) continue;
    try {
      const parsed = JSON.parse(data.join('\n'));
      events.push({ event: event || parsed?.type || null, data: parsed });
    } catch {
      // A partial trailing chunk (the socket closed mid-event) is skipped;
      // the missing message_stop below says the stream did not finish.
    }
  }
  return events;
};

// Returns `{ payload, error, complete }`. `error` is the stream's own
// `error` event ({ type, message }) when one arrived — an overload can
// surface mid-stream after a 200 — and `complete` says message_stop came.
export const assembleAnthropicEventStream = (raw) => {
  let message = null;
  let error = null;
  let complete = false;
  const partialJson = new Map();
  for (const { data } of parseEvents(raw)) {
    switch (data?.type) {
      case 'message_start':
        message = { ...(data.message || {}), content: [] };
        break;
      case 'content_block_start':
        if (message) message.content[data.index] = { ...(data.content_block || {}) };
        break;
      case 'content_block_delta': {
        const block = message?.content?.[data.index];
        const delta = data.delta || {};
        if (!block) break;
        if (delta.type === 'text_delta') block.text = `${block.text || ''}${delta.text || ''}`;
        else if (delta.type === 'thinking_delta') block.thinking = `${block.thinking || ''}${delta.thinking || ''}`;
        else if (delta.type === 'signature_delta') block.signature = delta.signature;
        else if (delta.type === 'input_json_delta') partialJson.set(data.index, `${partialJson.get(data.index) || ''}${delta.partial_json || ''}`);
        break;
      }
      case 'content_block_stop': {
        const block = message?.content?.[data.index];
        if (block && partialJson.has(data.index)) {
          try { block.input = JSON.parse(partialJson.get(data.index) || '{}'); } catch { block.input = null; }
        }
        break;
      }
      case 'message_delta':
        if (message) {
          for (const [key, value] of Object.entries(data.delta || {})) message[key] = value;
          if (data.usage) message.usage = { ...(message.usage || {}), ...data.usage };
        }
        break;
      case 'message_stop':
        complete = true;
        break;
      case 'error':
        error = { type: data.error?.type || 'error', message: data.error?.message || 'stream error' };
        break;
      default:
        break;
    }
  }
  if (message) message.content = message.content.filter(Boolean);
  return { payload: message, error, complete };
};

// The HTTP status a mid-stream error event stands for, so the caller's
// status classification (providerTransport.js) types it like the same
// error answered before the stream began.
export const statusForStreamError = (type) => ({
  overloaded_error: 529,
  rate_limit_error: 429,
  api_error: 500,
  authentication_error: 401,
  permission_error: 403,
  billing_error: 402,
  invalid_request_error: 400,
  request_too_large: 413,
  not_found_error: 404
}[type] || 500);
