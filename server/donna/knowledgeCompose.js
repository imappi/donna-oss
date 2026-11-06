// Donna — K1-5's `compose` dependency: the strong-model call that writes the
// prose of a GROUNDED knowledge answer (design-donna-knowledge-base.md §6;
// corpus spec design-donna-k1-uk-corpus-mvp.md §7 B3).
//
// This module is INJECTED into the answer seam by the owner surface
// (`clientPortalTurn.js`) — it is deliberately NOT imported by
// `knowledgeAnswerSeam.js`, so the seam's import set stays the four pure K1
// modules and the boundary allowlist (`knowledgeRetrievalBoundary.test.js`)
// is untouched. It imports NOTHING from server/donna: its only effect is one
// HTTPS call to the model API, so the grounding path still cannot write.
//
// The model here is NOT trusted with the outcome ladder — it proposes; the
// deterministic validator (`validateComposedKnowledgeAnswer`, floor-as-ceiling)
// disposes. Anything this call gets wrong degrades to the deterministic
// fallback, never to an ungrounded answer. That is why this file can be small:
// every guarantee lives downstream of it.
//
// Config: `ANTHROPIC_API_KEY` (secret) + `KNOWLEDGE_COMPOSE_MODEL` (tuning
// knob; env is legitimate for model ids per the config-plane rail). The
// default is the strong tier — this is a load-bearing composition call, and
// the trust-the-strong-LLM cost framing applies: the delta is fewer confident
// wrong answers, not a margin loss. The model id that actually answered is
// recorded on the receipt via `composedBy` (the surface passes
// `knowledgeComposeModelId()` only when this module is configured), never
// inferred from code defaults.

import { llmCall } from './llmCall.js';

const KNOWLEDGE_COMPOSE_DEFAULT_MODEL = 'claude-opus-4-8';
export const __KNOWLEDGE_COMPOSE_DEFAULT_MODEL = KNOWLEDGE_COMPOSE_DEFAULT_MODEL;

export const knowledgeComposeModelId = (env = process.env) =>
  env.KNOWLEDGE_COMPOSE_MODEL || KNOWLEDGE_COMPOSE_DEFAULT_MODEL;

export const knowledgeComposeConfigured = (env = process.env) =>
  Boolean(env.ANTHROPIC_API_KEY);

// The composed-answer envelope, enforced as a FORCED tool (the repo's
// structured-reply convention — a prompt instruction alone did not hold for
// the portal chat, and the same applies here).
const COMPOSED_ANSWER_TOOL = Object.freeze({
  name: 'submit_knowledge_answer',
  description:
    'Submit your composed knowledge answer. You MUST answer by calling this tool — never in free-form text.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      outcome: {
        type: 'string',
        enum: ['refusal', 'honest_partial', 'grounded_with_caveat', 'grounded'],
        description: 'At most the stated floor — you may downgrade, never upgrade.'
      },
      answer_text: {
        type: 'string',
        description: 'The answer for the business owner, in plain language.'
      },
      cited_passage_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Only passage_ids listed in the grounding block. Citing anything else voids the answer.'
      },
      named_variables: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            variable: { type: 'string' },
            question: { type: 'string' },
            is_business_fact: { type: 'boolean' }
          },
          required: ['variable', 'question', 'is_business_fact']
        },
        description:
          'For grounded_with_caveat: the specific variables that could change the answer. '
          + 'is_business_fact=true only for facts about THIS owner’s business that only they can know.'
      }
    },
    required: ['outcome', 'answer_text', 'cited_passage_ids', 'named_variables']
  }
});

// The behavioural rules. The SHAPE is guaranteed by the forced tool; the
// validator downstream re-checks every one of these mechanically — this prompt
// exists so the model rarely needs rejecting, not because rejection depends
// on it.
const COMPOSE_SYSTEM_PROMPT = `You compose Donna's answer to a business owner's tax/accounting question, grounded ONLY in the retrieved passages provided.

Hard rules — the runtime enforces every one of these; violations are rejected, not repaired:
- The grounding block states the strongest outcome the sources permit. You may answer with that outcome or any weaker one. Never stronger.
- Cite only the passage_ids listed in the grounding block. Every rate, threshold, date or rule you state must be present in a cited passage's excerpt or curated proposition — never from your own recollection.
- Jurisdiction fidelity is absolute: answer only from the passages' jurisdiction. If the passages do not fit the question's jurisdiction, refuse.
- 'grounded_with_caveat' means: state the general rule, then NAME the specific variable(s) that could change it in named_variables. Mark is_business_fact=true only for facts about this owner's specific business (what a purchase was for, hours worked from home, whether a trip was business). Knowledge questions are never business facts.
- Provenance markers (staleness, unconfirmed-against-primary, translation) are attached by the runtime — do not restate or soften them.
- Plain language for a working business owner: short sentences, no statutory prose, no hedging filler. State the answer, then the source attribution will follow.
- If the passages do not actually answer the question, say what they DO support ('honest_partial') or refuse ('refusal'). A refusal is a correct answer, not a failure.`;

// composeKnowledgeAnswerWithModel — the injected `compose` implementation.
// Receives what `answerKnowledgeQuestion` passes ({ grounding_block, floor,
// retrieval }) plus `questionText`, threaded by the surface via a closure
// (the retrieval receipt deliberately does not echo the question text).
//
// The provider call routes through `llmCall` — the repo's ONE telemetry
// envelope (the llmCall.test.js ratchet: no new module calls a provider
// directly) — with the K1 retrieval id as its root execution ref, so the
// compose call's telemetry joins the same spine as the retrieval and answer
// receipts. Tests inject `fetchImpl`, llmCall's own seam.
//
// Returns the composed envelope, or null on any failure — the answer contract
// treats a null/invalid composition as its deterministic fallback, so the
// failure mode of this call is an honest degraded answer, never a broken turn
// and never an ungrounded one.
export const KNOWLEDGE_COMPOSE_PROMPT_VERSION = 'knowledge-compose.v1';

export const composeKnowledgeAnswerWithModel = async ({
  grounding_block: groundingBlock = '',
  floor = null,
  retrieval = null,
  questionText = '',
  env = process.env,
  fetchImpl
} = {}) => {
  if (!knowledgeComposeConfigured(env)) return null;
  const question = String(questionText || '').trim();
  if (!question) return null;

  const userMessage = [
    'OWNER QUESTION:',
    question,
    '',
    String(groundingBlock || ''),
    '',
    `Compose the answer now. Strongest permitted outcome: ${floor || 'refusal'}.`
  ].join('\n');

  try {
    const { result } = await llmCall({
      provider: 'anthropic',
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: {
        model: knowledgeComposeModelId(env),
        // A grounded answer is a few paragraphs at most; a cap, not a target.
        max_tokens: 2048,
        system: COMPOSE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
        tools: [COMPOSED_ANSWER_TOOL],
        tool_choice: { type: 'tool', name: COMPOSED_ANSWER_TOOL.name }
      },
      sections: {
        system: COMPOSE_SYSTEM_PROMPT,
        tools: JSON.stringify(COMPOSED_ANSWER_TOOL),
        context: String(groundingBlock || ''),
        history: '',
        results: ''
      },
      execution: {
        root: { type: 'knowledge_retrieval', id: retrieval?.receipt?.retrieval_id || 'unanchored' }
      },
      promptVersion: KNOWLEDGE_COMPOSE_PROMPT_VERSION,
      configSnapshotId: retrieval?.receipt?.config_snapshot_id ?? null,
      parseResponse: (payload) => {
        const blocks = Array.isArray(payload?.content) ? payload.content : [];
        const toolUse = blocks.find((b) => b?.type === 'tool_use');
        return toolUse && toolUse.input && typeof toolUse.input === 'object' ? toolUse.input : null;
      },
      ...(fetchImpl ? { fetchImpl } : {})
    });
    return result;
  } catch {
    return null;
  }
};
