// Donna — reassembling an Anthropic Messages event stream into one Message.
//
// A long request (a statement extraction can run minutes) is streamed so the
// connection carries bytes the whole time instead of sitting silent until an
// idle timeout cuts it. The envelope still hands the caller ONE payload: the
// stream is reassembled into exactly the Message object a non-streaming
// request returns (id, model, content blocks, stop_reason, stop_details,
// usage), so rail 5 (the model from the response), the usage normalizer and
// every parseResponse see the same shape either way. An `error` event inside
// a 200 stream is a provider failure, typed like a non-OK status.
export const STREAM_ERROR_STATUS = Object.freeze({
  invalid_request_error: 400,
  authentication_error: 401,
  billing_error: 402,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  timeout_error: 504,
  overloaded_error: 529
});

export const assembleAnthropicStream = (raw) => {
  const text = String(raw || '');
  const trimmed = text.trimStart();
  // A body that is already a JSON document (an error response, or a
  // recorded non-streaming reply in tests) is returned as it is.
  if (trimmed.startsWith('{')) {
    try { return { payload: JSON.parse(trimmed), streamError: null }; } catch { return { payload: {}, streamError: null }; }
  }
  let message = null;
  const blocks = [];
  let streamError = null;
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!data) continue;
    let event;
    try { event = JSON.parse(data); } catch { continue; }
    switch (event?.type) {
      case 'message_start':
        message = { ...(event.message || {}), content: [] };
        break;
      case 'content_block_start':
        blocks[event.index] = { ...(event.content_block || {}) };
        break;
      case 'content_block_delta': {
        const block = blocks[event.index] || (blocks[event.index] = {});
        const delta = event.delta || {};
        if (delta.type === 'text_delta') block.text = (block.text || '') + (delta.text || '');
        else if (delta.type === 'thinking_delta') block.thinking = (block.thinking || '') + (delta.thinking || '');
        else if (delta.type === 'signature_delta') block.signature = (block.signature || '') + (delta.signature || '');
        else if (delta.type === 'input_json_delta') block.partial_json = (block.partial_json || '') + (delta.partial_json || '');
        break;
      }
      case 'message_delta':
        if (!message) message = { content: [] };
        if (event.delta && 'stop_reason' in event.delta) message.stop_reason = event.delta.stop_reason;
        if (event.delta && 'stop_sequence' in event.delta) message.stop_sequence = event.delta.stop_sequence;
        if (event.delta && 'stop_details' in event.delta) message.stop_details = event.delta.stop_details;
        if (event.usage) message.usage = { ...(message.usage || {}), ...event.usage };
        break;
      case 'error':
        streamError = event.error || { type: 'api_error', message: 'stream error' };
        break;
      default:
        break;
    }
  }
  const payload = message || {};
  payload.content = blocks.filter(Boolean).map((block) => {
    if (block.type === 'tool_use' && typeof block.partial_json === 'string') {
      const { partial_json: partial, ...rest } = block;
      try { return { ...rest, input: partial ? JSON.parse(partial) : {} }; } catch { return { ...rest, input: null }; }
    }
    return block;
  });
  if (streamError) payload.error = streamError;
  return { payload, streamError };
};

export const streamErrorStatus = (error) => STREAM_ERROR_STATUS[error?.type] || 500;
