import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadEnv } from 'vite';

import { handleDonnaApiRequest } from './donna/api.js';
import { handleInngestServeRequest } from './donna/inngest/serve.js';

const env = loadEnv(process.env.NODE_ENV || 'development', process.cwd(), '');

if (!process.env.OPENAI_API_KEY && env.OPENAI_API_KEY) {
  process.env.OPENAI_API_KEY = env.OPENAI_API_KEY;
}
if (!process.env.OPENAI_MODEL && env.OPENAI_MODEL) {
  process.env.OPENAI_MODEL = env.OPENAI_MODEL;
}
if (!process.env.TYPESAFE_API_KEY && env.TYPESAFE_API_KEY) {
  process.env.TYPESAFE_API_KEY = env.TYPESAFE_API_KEY;
}
if (!process.env.TYPESAFE_MODEL && env.TYPESAFE_MODEL) {
  process.env.TYPESAFE_MODEL = env.TYPESAFE_MODEL;
}
if (!process.env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY) {
  process.env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
}
if (!process.env.LOUIS_MODEL && env.LOUIS_MODEL) {
  process.env.LOUIS_MODEL = env.LOUIS_MODEL;
}
// The openai_compatible endpoint pair (descent ladder Q3) — kept in
// lockstep with desktop/providerKeyDotEnv.js PROVIDER_ENV_KEYS.
if (!process.env.OPENAI_COMPATIBLE_API_KEY && env.OPENAI_COMPATIBLE_API_KEY) {
  process.env.OPENAI_COMPATIBLE_API_KEY = env.OPENAI_COMPATIBLE_API_KEY;
}
if (!process.env.OPENAI_COMPATIBLE_BASE_URL && env.OPENAI_COMPATIBLE_BASE_URL) {
  process.env.OPENAI_COMPATIBLE_BASE_URL = env.OPENAI_COMPATIBLE_BASE_URL;
}
// The challenger's two dispatch knobs (§9.2/§9.5 decided 2026-08-12): the
// candidate model id and the per-client monthly token cap. Without this
// copy a .env row for either would silently leave the challenger dark
// (challengerEndpointConfigured reads process.env only) — fail-closed but
// unreceipted, the class of silent link the boot receipt exists to name.
if (!process.env.OPENAI_COMPATIBLE_MODEL && env.OPENAI_COMPATIBLE_MODEL) {
  process.env.OPENAI_COMPATIBLE_MODEL = env.OPENAI_COMPATIBLE_MODEL;
}
if (!process.env.MODEL_CHALLENGER_CAP_TOKENS && env.MODEL_CHALLENGER_CAP_TOKENS) {
  process.env.MODEL_CHALLENGER_CAP_TOKENS = env.MODEL_CHALLENGER_CAP_TOKENS;
}
if (!process.env.JEV_SHADOW_SAMPLE_FRACTION && env.JEV_SHADOW_SAMPLE_FRACTION) {
  process.env.JEV_SHADOW_SAMPLE_FRACTION = env.JEV_SHADOW_SAMPLE_FRACTION;
}

const port = Number(process.env.DONNA_API_PORT || process.env.PORT || env.DONNA_API_PORT || 8787);
const host = process.env.DONNA_API_HOST || env.DONNA_API_HOST || '127.0.0.1';

const applyCors = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Donna-Access-Token');
};

const server = http.createServer((req, res) => {
  applyCors(res);

  // The mobile adapter answers its own preflight (it also allows PUT/DELETE).
  if (req.method === 'OPTIONS' && !(req.url || '').startsWith('/api/donna/mobile/')) {
    res.statusCode = 204;
    res.end();
    return;
  }

  if ((req.url || '').startsWith('/api/donna/')) {
    handleDonnaApiRequest(req, res);
    return;
  }

  // Inngest serve route. Local dev hits this directly when `npx
  // inngest-cli dev` is running alongside; Vercel routes the same
  // path through api/inngest.js instead. The serve handler reads
  // req.url internally to compute the introspection / sync URL, so
  // don't strip the prefix.
  if ((req.url || '').startsWith('/api/inngest')) {
    handleInngestServeRequest(req, res);
    return;
  }

  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: 'Not found.' }));
});

export const startDonnaServer = () =>
  server.listen(port, host, () => {
    console.log(`Donna API listening on http://${host}:${port}`);
  });

const isDirectRun =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isDirectRun) {
  startDonnaServer();
}
