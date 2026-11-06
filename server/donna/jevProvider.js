// Typed Jev transport shared by preview and the config-scoped matching lane.
// This module never writes accounting state and performs no fallback or retries.
import { performance } from 'node:perf_hooks';
import { fetchProviderJson, providerKeyMissing, providerInvalidOutput, classifyProviderStatus } from './providerTransport.js';
import { generateMenu, directRequest, decideDirectAction } from './jevDirectAction.js';
import { stateWithFacts } from './jevMechanicalFacts.js';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const probability = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
const sameKeys = (a, b) => a && typeof a === 'object' && !Array.isArray(a)
  && JSON.stringify(Object.keys(a).sort()) === JSON.stringify(Object.keys(b).sort());
const invalid = () => { throw new Error('jev_invalid_response'); };

export function readJevAnswers(raw, questions) {
  if (typeof raw?.model !== 'string' || !raw.model.trim()
      || !['input_tokens', 'output_tokens'].every(k => Number.isSafeInteger(raw.usage?.[k]) && raw.usage[k] >= 0)
      || !sameKeys(raw.answers, questions)) invalid();
  return Object.fromEntries(Object.entries(questions).map(([key, question]) => {
    const a = raw.answers[key];
    if (question.type === 'noul') {
      if (a?.type !== 'noul' || !probability(a.noul)) invalid();
      return [key, { type: 'noul', noul: a.noul }];
    }
    if (a?.type !== 'choice' || !sameKeys(a.probabilities, question.criteria)
        || !Object.values(a.probabilities).every(probability) || !probability(a.confidence)) invalid();
    const values = Object.values(a.probabilities);
    const rounded = values.every(n => Math.abs(n * 100 - Math.round(n * 100)) < 1e-8);
    if (!Object.hasOwn(question.criteria, a.choice) || a.probabilities[a.choice] !== Math.max(...values)
        || Math.abs(values.reduce((s, n) => s + n, 0) - 1) > (rounded ? values.length * 0.005 + 1e-8 : 0.000001)) invalid();
    return [key, { type: 'choice', choice: a.choice, probability: a.probabilities[a.choice],
      probabilities: { ...a.probabilities }, provider_confidence: a.confidence }];
  }));
}

export async function callJevDirect(prepared, {
  model = process.env.TYPESAFE_MODEL, apiKey = process.env.TYPESAFE_API_KEY, fetchImpl = globalThis.fetch
} = {}) {
  if (!apiKey?.trim() || !model?.trim()) throw new Error('jev_not_configured');
  if (prepared?.error || !prepared?.state) throw new Error(prepared?.error || 'jev_invalid_packet');
  const menu = generateMenu(prepared);
  const request = directRequest(prepared, model, stateWithFacts(prepared), menu);
  const result = await callJevTyped(request, { apiKey, fetchImpl });
  return { ...result, decision: decideDirectAction(prepared, menu, result.answers), menu };
}

// The exact request body sent to the provider. The API also accepts text
// state. Preserve the complete JSON value in a compact text representation for
// large cases instead of leaving its layout to provider-side object rendering.
// This is not a token-limit estimate: actual provider limits still fail
// visibly, with no truncation or fallback. The Jev provider wrapper digests
// this same body, so a decision receipt names the bytes that were sent.
export function jevWireBody(request) {
  const serializedState = JSON.stringify(request.state);
  const wireRequest = request.state && typeof request.state === 'object'
    && Buffer.byteLength(serializedState) > 60_000
    ? { ...request, state: serializedState } : request;
  return JSON.stringify(wireRequest);
}

export async function callJevTyped(request, { apiKey = process.env.TYPESAFE_API_KEY, fetchImpl = globalThis.fetch } = {}) {
  if (!apiKey?.trim() || !request.model?.trim()) throw providerKeyMissing('typesafe', { keyName: 'TYPESAFE_API_KEY / TYPESAFE_MODEL' });
  // UI cases include surrounding persisted records, unlike the small authored
  // evaluation packets. Keep a byte bound; provider context refusal stays visible.
  if (Buffer.byteLength(JSON.stringify(request)) > 160_000) throw classifyProviderStatus({ provider: 'typesafe', status: 413, payload: { error: { code: 'request_too_large' } } });
  const body = jevWireBody(request);
  const start = performance.now();
  const response = await fetchProviderJson({ provider: 'typesafe', url: ENDPOINT, fetchImpl, timeoutMs: 30_000,
    init: { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body } });
  if (!response.ok) throw classifyProviderStatus({ provider: 'typesafe', status: response.status,
    payload: { error: { code: response.payload?.detail?.error_type || response.payload?.error?.code,
      message: typeof response.payload?.detail === 'string' ? response.payload.detail.slice(0, 500) : response.payload?.error?.message } } });
  const raw = response.payload;
  let answers;
  try { answers = readJevAnswers(raw, request.questions); }
  catch { throw providerInvalidOutput('typesafe', { detail: 'invalid typed answers' }); }
  return { answers, model: raw.model,
    usage: { input_tokens: raw.usage.input_tokens, output_tokens: raw.usage.output_tokens },
    latency_ms: Math.round(performance.now() - start) };
}
