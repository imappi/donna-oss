// The boot-time MODEL-LANE receipt (2026-08-06). Every LLM consumer in the
// runtime is written to fail SOFT when its provider key is absent — correct
// resilience in the cloud, but on the appliance it converts a provisioning gap
// into SILENT feature loss: the OpenAI-only S1 bridge shipped with the entire
// Anthropic-keyed lane dark (reconciliation triage + the delegated-authority
// grants it consumes, the bank-line disposition producer, merchant lookup,
// chat, knowledge composition, the unified extractor) and nothing said so —
// the gap surfaced weeks later as a leak-audit session instead of one boot
// line. Same discipline as "the model id is part of the receipt": deployed
// reality must be readable from the data — here, from the boot log.
//
// Pure string assembly over key PRESENCE — never key values, never a network
// call. The lane lists are maintained BY HAND against the grep
// `ANTHROPIC_API_KEY|OPENAI_API_KEY` over server/ — update them when a lane
// gains or loses a provider (the test pins the shape, not the census).

import { FIRST_LINE_PROVIDER_ENV, firstLineProviderMissing } from '../firstLineLane.js';

const present = (value) => typeof value === 'string' && value.trim().length > 0;

export const MODEL_LANES = Object.freeze({
  openai: Object.freeze([
    'document extraction',
    'coding (batch coder)',
    'ask drafting',
    'auto-explain classifier',
    'bank-statement parse'
  ]),
  anthropic: Object.freeze([
    'reconciliation LLM triage + authority grants',
    'bank-line disposition producer',
    'merchant lookup',
    'transaction/feed chat',
    'knowledge answers (K1 compose)',
    'unified extractor'
  ]),
  // Evidence-only: the shadow-challenger rung (descent ladder). Dispatch
  // additionally needs the MODEL_CHALLENGER config-plane stage; this line
  // receipts the ENV half so a provisioning gap is one boot line, not a
  // weeks-later "why are there no receipts" session.
  openai_compatible: Object.freeze([
    'shadow challenger — bank-line classification (evidence-only)'
  ]),
  // The first-line lane (firstLineLane.js). Optional: dark, the lanes above
  // decide every line, as under the JEV_RECONCILIATION kill switch.
  typesafe: Object.freeze([
    'first-line decisions (matching, bank/document disposition, coding) where the client flag is on'
  ])
});

// The model-OVERRIDE knob per provider. LIT/DARK alone is not enough: a
// blanket env override (OPENAI_MODEL / LOUIS_MODEL) silently replaces every
// module's strong default, and a downgraded value is invisible at boot — the
// exact May-June cloud incident (OPENAI_MODEL=gpt-5.4-nano overriding a month
// of "strong coder" runs), replayed on the appliance 2026-08-08 when a dev
// .env carried the same row into the drill launch shell. The model id is part
// of the receipt; when the knob is set, the boot line says so. Model ids are
// not secrets — values are printed; key material still never is.
const MODEL_OVERRIDE_KNOBS = Object.freeze({ openai: 'OPENAI_MODEL', anthropic: 'LOUIS_MODEL' });

// One provider → one receipt line: "openai LIT (…)",
// "openai LIT — OPENAI_MODEL override: gpt-5.4-nano (…)" or
// "anthropic DARK — no ANTHROPIC_API_KEY (…)".
const providerLine = (provider, keyName, env) => {
  const lanes = MODEL_LANES[provider].join(', ');
  if (!present(env?.[keyName])) return `${provider} DARK — no ${keyName} (${lanes})`;
  const knob = MODEL_OVERRIDE_KNOBS[provider];
  const override = present(env?.[knob]) ? env[knob].trim() : null;
  return override
    ? `${provider} LIT — ${knob} override: ${override} (${lanes})`
    : `${provider} LIT (${lanes})`;
};

// The openai_compatible challenger endpoint needs FOUR env rows to
// dispatch (key + base URL + candidate model + token cap — the last two
// per §9.2/§9.5, Kari 2026-08-12); any absent row leaves it dark,
// fail-closed. The receipt names exactly which rows are missing, prints
// the host and candidate when lit (model ids and hosts are not secrets;
// key material never prints), and never claims dispatch — that also needs
// the MODEL_CHALLENGER stage row on the config plane.
const compatibleLine = (env) => {
  const lanes = MODEL_LANES.openai_compatible.join(', ');
  const missing = [
    ['OPENAI_COMPATIBLE_API_KEY', env?.OPENAI_COMPATIBLE_API_KEY],
    ['OPENAI_COMPATIBLE_BASE_URL', env?.OPENAI_COMPATIBLE_BASE_URL],
    ['OPENAI_COMPATIBLE_MODEL', env?.OPENAI_COMPATIBLE_MODEL],
    ['MODEL_CHALLENGER_CAP_TOKENS', env?.MODEL_CHALLENGER_CAP_TOKENS]
  ].filter(([, value]) => !present(value)).map(([name]) => name);
  if (missing.length) return `openai_compatible DARK — no ${missing.join(', no ')} (${lanes})`;
  let host = env.OPENAI_COMPATIBLE_BASE_URL.trim();
  try { host = new URL(host).host; } catch { /* print the raw value when unparseable — still not a secret */ }
  return `openai_compatible LIT — host ${host}, candidate ${env.OPENAI_COMPATIBLE_MODEL.trim()}, `
    + `cap ${env.MODEL_CHALLENGER_CAP_TOKENS.trim()} tokens/client/mo (${lanes})`;
};

// Both rows are needed (firstLineLane.FIRST_LINE_PROVIDER_ENV); the receipt
// names each missing one and, lit, prints the model id (not a secret).
const firstLineLine = (env) => {
  const lanes = MODEL_LANES.typesafe.join(', ');
  const missing = firstLineProviderMissing(env);
  if (missing.length) return `typesafe DARK — no ${missing.join(', no ')} (${lanes}; the other lit lanes decide)`;
  return `typesafe LIT — ${FIRST_LINE_PROVIDER_ENV[1]}: ${env[FIRST_LINE_PROVIDER_ENV[1]].trim()} (${lanes})`;
};

export const buildModelLaneReceipt = (env = process.env) => {
  const openaiLit = present(env?.OPENAI_API_KEY);
  const anthropicLit = present(env?.ANTHROPIC_API_KEY);
  const compatibleLit = present(env?.OPENAI_COMPATIBLE_API_KEY)
    && present(env?.OPENAI_COMPATIBLE_BASE_URL)
    && present(env?.OPENAI_COMPATIBLE_MODEL)
    && present(env?.MODEL_CHALLENGER_CAP_TOKENS);
  return {
    openai: openaiLit,
    anthropic: anthropicLit,
    openai_compatible: compatibleLit,
    typesafe: firstLineProviderMissing(env).length === 0,
    line: `model lanes: ${providerLine('openai', 'OPENAI_API_KEY', env)}; `
      + `${providerLine('anthropic', 'ANTHROPIC_API_KEY', env)}; ${compatibleLine(env)}; ${firstLineLine(env)}`
  };
};
