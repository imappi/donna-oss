// A Messages API answer for tests that stub `fetch` themselves (2026-11-10:
// the text lanes run on Claude whenever an Anthropic key is present). The
// same answer object a test used to wrap as an OpenAI Responses body, in the
// shape the lane's Anthropic request expects: a text block for a structured-
// output request, the one `structured_answer` tool call for a request over
// the grammar limits (structuredRequest.js schemaDeliveryFor). Synthetic.

export const ANTHROPIC_MESSAGES_TEST_URL = 'https://api.anthropic.com/v1/messages';

export const claudeMessageBody = (answer, { request = null, model = 'claude-opus-5-5', id = 'msg_fixture' } = {}) => {
  const toolDelivery = Array.isArray(request?.tools) && request.tools.some((tool) => tool?.name === 'structured_answer');
  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content: toolDelivery
      ? [{ type: 'tool_use', id: 'toolu_fixture', name: 'structured_answer', input: answer }]
      : [{ type: 'text', text: typeof answer === 'string' ? answer : JSON.stringify(answer) }],
    stop_reason: toolDelivery ? 'tool_use' : 'end_turn',
    stop_details: null,
    usage: { input_tokens: 1, output_tokens: 1 }
  };
};

export const claudeMessageResponse = (answer, options = {}) =>
  new Response(JSON.stringify(claudeMessageBody(answer, options)), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });

// The text lane's input from an Anthropic request body (the last user turn).
export const claudeRequestInput = (request) => {
  const turn = (request?.messages || []).filter((message) => message?.role === 'user').at(-1);
  const content = typeof turn?.content === 'string' ? turn.content
    : (turn?.content || []).filter((block) => block?.type === 'text').map((block) => block.text).join('');
  return content;
};

// The system prompt text of an Anthropic request (a string or cached blocks).
export const claudeRequestSystem = (request) => (typeof request?.system === 'string'
  ? request.system
  : (request?.system || []).map((block) => block?.text || '').join('\n'));
