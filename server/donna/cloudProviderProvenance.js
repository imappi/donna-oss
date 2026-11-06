import { makeDependencyFact } from './cloudDependencyEvidence.js';

import { CLOUD_VERIFIABLE_PROVIDER_ENDPOINTS } from './providerEndpoints.js';
// The actual HTTPS response URL and credential used must match the configured
// provider. Request metadata, injected telemetry and key presence cannot mint it.
export const captureCloudProviderProvenance = ({ url, headers, response, payload, error, observedAt, env = process.env }) => {
  const kind = CLOUD_VERIFIABLE_PROVIDER_ENDPOINTS[String(url)];
  if (!kind || (response && response.url !== String(url))) return null;
  const requestHeaders = new Headers(headers);
  const credential = kind === 'openai' ? requestHeaders.get('authorization')?.replace(/^Bearer /, '') : requestHeaders.get('x-api-key');
  const configured = kind === 'openai' ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY;
  if (!configured || credential !== configured) return null;
  const input = payload?.usage?.input_tokens ?? payload?.usage?.prompt_tokens;
  const output = payload?.usage?.output_tokens ?? payload?.usage?.completion_tokens;
  const success = !error && response?.ok && typeof payload?.id === 'string' && payload.id.length > 0
    && typeof payload?.model === 'string' && payload.model.length > 0
    && Number.isFinite(input) && input >= 0 && Number.isFinite(output) && output > 0;
  return makeDependencyFact({ kind, observedAt, env, detail: {
    outcome: success ? 'response_received' : 'provider_failed', endpoint: String(url),
    response_id: success ? payload.id : null, response_model: success ? payload.model : null,
    response_status: response?.status ?? null, error_code: success ? null : error?.code || 'CLOUD_PROVIDER_RESPONSE_UNPROVEN',
    input_tokens: success ? payload.usage.input_tokens ?? payload.usage.prompt_tokens : null,
    output_tokens: success ? payload.usage.output_tokens ?? payload.usage.completion_tokens : null
  } });
};
