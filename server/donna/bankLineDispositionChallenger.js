// Donna — bank-line DISPOSITION lane challenger wiring, slice Q6a
// (descent ladder; the B3 re-hook).
//
// PILOT RE-HOOK (Kari, 2026-08-13): the Q4 pilot wired the challenger to
// the bank-line auto-explain sweep (B2) — which turned out to be the
// RETIRED predecessor of the disposition producer: on the appliance the
// sweep is dark (env kill switch off, no firm opt-in) while every bare
// bank line actually flows through `bankLineDispositionLlm.js` (the
// strong-model successor, via the hourly cron AND the loops terminal
// drain). A challenger that shadows a lane nobody runs produces no
// evidence — so the pilot moves to the lane that actually decides. The
// B2 wiring stays in the tree (any deployment that still enables the
// legacy sweep keeps its shadow); this module is the same contract for
// the live lane.
//
// REPLAY PARITY (the B2 criterion, satisfied even more cleanly here):
// the deciding call is text-only with PURE exported builders —
// `buildBankLineDispositionUserPrompt` + the per-direction system-prompt
// builders — and its own exported parser `parseDispositionResponse`,
// which applies the deterministic materiality-ceiling downgrades
// identically on both sides. The deciding prompt already demands a bare
// JSON object (no provider-side schema mode involved), so the challenger
// replays the EXACT deciding observation verbatim — no schema suffix, no
// transport-shape compromise. The sweep path never carries a client
// answer, so the §6 untrusted-content guard variant never applies here.
//
// ZERO DECIDING-PATH CHANGE: the deciding producer keeps its Anthropic
// transport and never-throws contract untouched; this module fires
// post-stamp (fire-and-forget, receipt-only) via the Q2 harness, which
// carries the flag gate, sampling, the fail-closed cap, and the no-throw
// contract. Config is the same env four as B2 (endpoint pair + candidate
// model + cap) — one rung, one candidate, shared per-client spend cap.

import { isUnqualifiedSeat } from './modelLanePolicy.js';
import { llmCall } from './llmCall.js';
import { dispatchChallengerRun } from './modelChallenger.js';
import { resolveOpenAiCompatibleEndpoint, shapeOpenAiCompatibleRequest } from './providerEndpoints.js';
import {
  buildBankLineDispositionUserPrompt,
  parseDispositionResponse,
  normalizeDirection,
  __buildMoneyOutSystemPrompt,
  __buildMoneyInSystemPrompt
} from './bankLineDispositionLlm.js';
import { getDispositionMaterialityPolicy } from './dispositionMateriality.js';
import { challengerEndpointConfigured, CHALLENGER_MODEL_ENV, CHALLENGER_CAP_ENV } from './modelChallenger.js';
import { getLane } from './modelLanes.js';
import {
  DEFAULT_MODEL as CORE_DEFAULT_MODEL,
  getApiKey as getAnthropicApiKey,
  proposeMatchesViaAnthropic
} from './reconciliationLlmCore.js';

export const BANK_LINE_DISPOSITION_CHALLENGER_LANE = 'bank_line_disposition';

// One rung, one config: the shared endpoint predicate (modelChallenger.js;
// it was the B2 wiring's until RT-14 retired that lane).
export const bankLineDispositionChallengerConfigured = challengerEndpointConfigured;

// ── The lane comparator ─────────────────────────────────────────────────
// Both sides come out of parseDispositionResponse, so every compared
// field is enum-or-sanitized. `disposition` IS the lane's verdict (it
// settles the line or routes it to a human/chase); `materiality` is the
// safety axis; `expense_kind` is sanitized snake_case analytics — a
// mismatch there alone is cosmetic. `reasoning` (free text) and
// `confidence` (continuous) are never compared and never recorded.
export const compareBankLineDispositionOutputs = ({ decidingResult, challengerResult } = {}) => {
  if (!challengerResult || typeof challengerResult !== 'object') {
    return { outcome: 'parse_failure', failure_class: null, summary: { reason: 'challenger output unparseable' } };
  }
  if (decidingResult?.disposition !== challengerResult.disposition) {
    return {
      outcome: 'divergence',
      failure_class: 'verdict_flip',
      summary: {
        field: 'disposition',
        deciding: decidingResult?.disposition ?? null,
        challenger: challengerResult.disposition ?? null
      }
    };
  }
  if (decidingResult?.materiality !== challengerResult.materiality) {
    return {
      outcome: 'divergence',
      failure_class: 'materiality_miss',
      summary: {
        field: 'materiality',
        deciding: decidingResult?.materiality ?? null,
        challenger: challengerResult.materiality ?? null
      }
    };
  }
  if ((decidingResult?.expense_kind || 'unknown') !== (challengerResult.expense_kind || 'unknown')) {
    // Verdict and materiality agree; the kind label differs — cosmetic.
    // Values are parser-sanitized snake_case, safe to record.
    return {
      outcome: 'divergence',
      failure_class: 'format_drift',
      summary: {
        field: 'expense_kind',
        deciding: decidingResult?.expense_kind ?? null,
        challenger: challengerResult.expense_kind ?? null
      }
    };
  }
  return { outcome: 'match', failure_class: null, summary: null };
};

// A deciding result produced by the producer's safe fallback (no key /
// transport error / unparseable) carries a reason and zero confidence —
// nothing was reasoned, so there is nothing to challenge. A genuine parse
// may carry a model-supplied unmatchable_reason but real confidence.
const isSafeFallbackDisposition = (semantic) =>
  Boolean(semantic?.unmatchable_reason) && !(Number(semantic?.confidence) > 0);

// ── The challenger transport ────────────────────────────────────────────
// The exact deciding observation: same system prompt (per direction +
// jurisdiction), same user prompt, same parser with the same deterministic
// ceiling. A non-JSON reply parses to the safe fallback → surfaced as a
// null result → parse_failure (a transport/HTTP error still propagates →
// challenger_error). Both are honest rung evidence.
const buildCallChallenger = ({ transaction, firmContext, direction, endpoint, model, execution, fetchImpl }) => async () => {
  const dir = normalizeDirection(direction);
  const system = (dir === 'money_in' ? __buildMoneyInSystemPrompt : __buildMoneyOutSystemPrompt)(
    firmContext?.clientIdentity?.jurisdiction ?? null
  );
  const user = buildBankLineDispositionUserPrompt({ transaction, firmContext, clientAnswer: null, direction: dir });
  const amount = Number(dir === 'money_in' ? transaction?.money_in : transaction?.money_out);
  // RT-11b — the same pack ceiling the deciding path applies (the experiment
  // swaps the judgment, never the guardrails).
  const materialityPolicy = getDispositionMaterialityPolicy({ jurisdiction: firmContext?.clientIdentity?.jurisdiction ?? null });
  const { result, telemetry } = await llmCall({
    provider: 'openai_compatible',
    url: endpoint.url,
    headers: endpoint.headers,
    body: shapeOpenAiCompatibleRequest({
      model,
      system,
      messages: [{ role: 'user', content: user }]
    }),
    sections: { system, context: user },
    execution,
    promptVersion: null,
    parseResponse: (payload) => {
      const text = payload?.choices?.[0]?.message?.content ?? '';
      const parsed = parseDispositionResponse(text, dir, {
        amount: Number.isFinite(amount) ? amount : null,
        materialityCeiling: materialityPolicy.ceiling,
        materialityCeilingSource: materialityPolicy.source
      });
      return isSafeFallbackDisposition(parsed) ? null : parsed; // → parse_failure at the comparator, receipt kept
    },
    ...(fetchImpl ? { fetchImpl } : {})
  });
  return { result, telemetry };
};

// ── The REVERSE-shadow transport (Q6c, the model lab) ───────────────────
// When an experiment policy puts a rung in the DECIDING seat, the forward
// shadow (rung challengering itself) is noise — the §5.3 shape applies
// instead: the FORMER deciding model (the core's strong default) runs as
// the challenger against the rung's decisions, over the core's own
// Anthropic transport. Same observation, same parser+ceiling, same
// comparator — so the agreement data keeps flowing while the rung decides,
// and the demotion tripwire has receipts to read. proposeMatchesViaAnthropic
// absorbs HTTP errors into a safe-fallback shape rather than throwing, so
// a failed reverse call receipts as parse_failure (not challenger_error) —
// acceptable rung-side honesty for the lab. Usage is null (the core
// transport predates llmCall telemetry), so reverse runs do not draw down
// the compatible-rung spend cap — the strong model's cost here is the
// deciding budget it just vacated.
const buildCallReverseChallenger = ({ transaction, firmContext, direction, apiKey, fetchImpl }) => async () => {
  const dir = normalizeDirection(direction);
  const system = (dir === 'money_in' ? __buildMoneyInSystemPrompt : __buildMoneyOutSystemPrompt)(
    firmContext?.clientIdentity?.jurisdiction ?? null
  );
  const user = buildBankLineDispositionUserPrompt({ transaction, firmContext, clientAnswer: null, direction: dir });
  const amount = Number(dir === 'money_in' ? transaction?.money_in : transaction?.money_out);
  // RT-11b — the same pack ceiling the deciding path applies (the experiment
  // swaps the judgment, never the guardrails).
  const materialityPolicy = getDispositionMaterialityPolicy({ jurisdiction: firmContext?.clientIdentity?.jurisdiction ?? null });
  const semantic = await proposeMatchesViaAnthropic({
    systemPrompt: system,
    userPrompt: user,
    candidateBankLines: [],
    model: CORE_DEFAULT_MODEL,
    apiKey,
    fetchImpl,
    parse: (text) => parseDispositionResponse(text, dir, {
      amount: Number.isFinite(amount) ? amount : null,
      materialityCeiling: materialityPolicy.ceiling,
      materialityCeilingSource: materialityPolicy.source
    }),
    logTag: 'bankLineDispositionReverseShadow'
  });
  const usable = semantic && typeof semantic.disposition === 'string' && !isSafeFallbackDisposition(semantic);
  return {
    result: usable ? semantic : null,
    telemetry: {
      model: semantic?.model ?? null,
      model_source: semantic?.model ? 'response' : 'configured_fallback',
      usage: null
    }
  };
};

// ── The hook builder ────────────────────────────────────────────────────
// Called once per (firm, client) by a sweep OWNER (the disposition cron,
// or the loops terminal drain via an injected connection provider — never
// the producer itself, which by design cannot import firmDb). Returns a
// fire-and-forget hook `(transaction, semantic, { firmContext, direction,
// model }) => void`, or null when the challenger cannot run. The hook
// never returns a promise the sweep could await and never throws.
//
// Q6c: `decidingPolicy` (the lane's active model-policy row) selects the
// MODE — no policy / the strong default deciding ⇒ the forward shadow
// (env-configured rung challengers the strong decider, as at Q6a); a
// non-default rung deciding ⇒ the REVERSE shadow (the strong default
// challengers the rung). Either way: evidence + receipt only, post-stamp,
// never a decision.
export const makeBankLineDispositionChallengerHook = ({
  firmId,
  clientId,
  snapshot = null,
  withClient,
  env = process.env,
  sample = null,
  fetchImpl = null,
  decidingPolicy = null,
  anthropicApiKey = null
} = {}) => {
  if (!firmId || !clientId || typeof withClient !== 'function') return null;
  // 2026-11-10 (modelLanes.js SELF_HOSTED_DECISION): a self-hosted,
  // unqualified seat gets neither shadow — no cloud model is called about
  // this company's lines for this lane, and nothing here is promotion
  // evidence.
  if (isUnqualifiedSeat(decidingPolicy)) return null;
  const lane = getLane(BANK_LINE_DISPOSITION_CHALLENGER_LANE);
  if (!lane?.challenger?.eligible) return null;

  const fraction = Number(lane.challenger.sampling?.fraction);
  const effectiveSample = sample
    || (() => Math.random() < (Number.isFinite(fraction) ? fraction : 0));
  const cap = Number(env[CHALLENGER_CAP_ENV]);

  const policyModel = typeof decidingPolicy?.deciding_model === 'string' && decidingPolicy.deciding_model.trim()
    ? decidingPolicy.deciding_model.trim()
    : null;
  const reverse = Boolean(policyModel) && policyModel !== CORE_DEFAULT_MODEL;

  if (reverse) {
    const apiKey = anthropicApiKey ?? getAnthropicApiKey();
    if (!apiKey) return null;
    if (!Number.isFinite(cap) || cap <= 0) return null; // same fail-closed cap gate as forward
    return (transaction, semantic, context = {}) => {
      if (!transaction?.id || !semantic || isSafeFallbackDisposition(semantic)) return;
      const execution = { root: { type: 'bank_line_disposition', id: transaction.id } };
      void dispatchChallengerRun({
        firmId,
        clientId,
        laneId: BANK_LINE_DISPOSITION_CHALLENGER_LANE,
        snapshot,
        decidingResult: semantic,
        // The compatible deciding path stamps the provider-RESPONSE id on
        // the semantic; fall back honestly when it is absent.
        decidingModel: {
          model: semantic.model ?? context.model ?? null,
          model_source: semantic.model_source ?? (semantic.model ? 'response' : 'configured_fallback')
        },
        execution,
        callChallenger: buildCallReverseChallenger({
          transaction,
          firmContext: context.firmContext ?? null,
          direction: context.direction,
          apiKey,
          fetchImpl
        }),
        capTokensPerClientMonth: cap,
        comparator: compareBankLineDispositionOutputs,
        sample: effectiveSample,
        withClient,
        env
      }).catch(() => { /* dispatch is no-throw by contract; this guards the contract itself */ });
    };
  }

  if (!bankLineDispositionChallengerConfigured(env)) return null;

  let endpoint;
  try {
    endpoint = resolveOpenAiCompatibleEndpoint({ env });
  } catch {
    return null; // configured-check raced an env change; fail closed
  }
  const model = String(env[CHALLENGER_MODEL_ENV]).trim();

  return (transaction, semantic, context = {}) => {
    if (!transaction?.id || !semantic || isSafeFallbackDisposition(semantic)) return;
    const execution = { root: { type: 'bank_line_disposition', id: transaction.id } };
    void dispatchChallengerRun({
      firmId,
      clientId,
      laneId: BANK_LINE_DISPOSITION_CHALLENGER_LANE,
      snapshot,
      decidingResult: semantic,
      // The deciding producer stamps the CONFIGURED model id (its Anthropic
      // transport predates the seam), so the deciding side is honestly
      // configured_fallback until the core migrates onto llmCall.
      decidingModel: { model: context.model ?? null, model_source: 'configured_fallback' },
      execution,
      callChallenger: buildCallChallenger({
        transaction,
        firmContext: context.firmContext ?? null,
        direction: context.direction,
        endpoint,
        model,
        execution,
        fetchImpl
      }),
      capTokensPerClientMonth: cap,
      comparator: compareBankLineDispositionOutputs,
      sample: effectiveSample,
      withClient,
      env
    }).catch(() => { /* dispatch is no-throw by contract; this guards the contract itself */ });
  };
};
