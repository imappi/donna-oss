// Donna — reconciliation_reasoning lane challenger wiring, slice Q7
// (the model lab: the Honeybee lab seat, Kari's dated call 2026-08-16).
//
// THE REVERSE SHADOW ONLY. This lane becomes challenger-eligible for one
// purpose: when an EXPERIMENT policy seats a non-claude qualified rung as
// the deciding model for document-backed reconciliation (supplier bills /
// sales invoices on the lab book), the FORMER deciding model — the core's
// strong default (Opus) — replays the exact deciding observation as the
// challenger and the agreement/divergence is receipted. There is no
// forward mode here (no policy ⇒ no hook ⇒ no receipts): the lab question
// is "what happens when the rung actually decides", and the strong model
// is the comparator, not the subject.
//
// REPLAY PARITY: the deciding call is text-only with PURE exported
// builders — each family's SYSTEM_PROMPT + buildProposeMatchesUserPrompt
// — and the shared core parser (parseProposeMatchesResponse + the
// tie-expansion, both applied identically inside
// proposeMatchesViaAnthropic). The hook receives the SAME truncated
// candidate list, firm context and config snapshot the deciding call used,
// and re-derives the prompts with the same builders + the same datePairs
// resolver — byte-identical observation, different model. No second
// reconciliation implementation exists here.
//
// THE SHADOW CONTRACT (the Q2 harness carries it): post-decision (the
// orchestrator fires the hook only after the verdict stamp), own
// connection (withClient injected by the wrapper), no-throw,
// receipt-only. This module imports NO writer — the boundary test pins
// both its imports and its right to import the harness.
//
// COST: the reverse challenger runs on the core's anthropic transport;
// usage is null (that transport predates llmCall telemetry), so reverse
// runs do not draw down the compatible-rung spend cap — the strong
// model's cost here is the deciding budget it just vacated. The cap env
// still gates dispatch fail-closed, same as every challenger.

import { isUnqualifiedSeat } from './modelLanePolicy.js';
import { CHALLENGER_CAP_ENV, dispatchChallengerRun } from './modelChallenger.js';
import { getLane } from './modelLanes.js';
import {
  DEFAULT_MODEL as CORE_DEFAULT_MODEL,
  getApiKey as getAnthropicApiKey,
  proposeMatchesViaAnthropic
} from './reconciliationLlmCore.js';
import {
  __SUPPLIER_BILL_SYSTEM_PROMPT,
  buildProposeMatchesUserPrompt as buildSupplierBillUserPrompt,
  resolveSupplierBillDatePairs
} from './supplierBillReconciliationLlm.js';
import {
  __SALES_INVOICE_SYSTEM_PROMPT,
  buildProposeMatchesUserPrompt as buildSalesInvoiceUserPrompt,
  resolveSalesInvoiceDatePairs
} from './salesInvoiceReconciliationLlm.js';
import {
  __RECEIPT_SYSTEM_PROMPT,
  buildProposeMatchesUserPrompt as buildReceiptUserPrompt,
  resolveReceiptDatePairs
} from './receiptReconciliationLlm.js';
import {
  __PAYMENT_CONFIRMATION_SYSTEM_PROMPT,
  buildProposeMatchesUserPrompt as buildPaymentConfirmationUserPrompt,
  resolvePaymentConfirmationDatePairs
} from './paymentConfirmationReconciliationLlm.js';
import {
  __PAYMENT_ACCOUNT_STATEMENT_SYSTEM_PROMPT,
  buildProposeMatchesUserPrompt as buildPaymentAccountStatementUserPrompt,
  resolvePaymentAccountStatementDatePairs
} from './paymentAccountStatementReconciliationLlm.js';
import {
  __PAYOUT_SYSTEM_PROMPT,
  buildProposeMatchesUserPrompt as buildPayoutUserPrompt,
  resolvePayoutDatePairs
} from './payoutReconciliationLlm.js';

export const RECONCILIATION_REASONING_LANE = 'reconciliation_reasoning';

// The families threaded so far. A family joins by exporting its pure
// builders + datePairs resolver and wiring its wrapper — never by a
// second prompt implementation living here.
//
// LAZY on purpose: the family modules sit in the core ↔ firmDb ↔
// parseDocumentsDb import cycle, and their own re-export comments warn
// that reading a cycle member's bindings at module-eval time hits the
// temporal dead zone. Resolving at hook-build time (runtime, graph long
// settled) sidesteps that entirely.
const familyConfigFor = (family) => {
  if (family === 'supplier_bill') {
    return {
      systemPrompt: __SUPPLIER_BILL_SYSTEM_PROMPT,
      buildUserPrompt: buildSupplierBillUserPrompt,
      resolveDatePairs: resolveSupplierBillDatePairs
    };
  }
  if (family === 'sales_invoice') {
    return {
      systemPrompt: __SALES_INVOICE_SYSTEM_PROMPT,
      buildUserPrompt: buildSalesInvoiceUserPrompt,
      resolveDatePairs: resolveSalesInvoiceDatePairs
    };
  }
  // Q8 (all-entities call, 2026-08-16): the remaining document-match
  // families joined the seat in the same pattern.
  if (family === 'receipt') {
    return {
      systemPrompt: __RECEIPT_SYSTEM_PROMPT,
      buildUserPrompt: buildReceiptUserPrompt,
      resolveDatePairs: resolveReceiptDatePairs
    };
  }
  if (family === 'payment_confirmation') {
    return {
      systemPrompt: __PAYMENT_CONFIRMATION_SYSTEM_PROMPT,
      buildUserPrompt: buildPaymentConfirmationUserPrompt,
      resolveDatePairs: resolvePaymentConfirmationDatePairs
    };
  }
  if (family === 'payment_account_statement') {
    return {
      systemPrompt: __PAYMENT_ACCOUNT_STATEMENT_SYSTEM_PROMPT,
      buildUserPrompt: buildPaymentAccountStatementUserPrompt,
      resolveDatePairs: resolvePaymentAccountStatementDatePairs
    };
  }
  // RT-18 (2026-09-02): the payout / deposit-slip family — same pattern,
  // one seat for both document types (one evaluation family, one prompt).
  if (family === 'payout_statement') {
    return {
      systemPrompt: __PAYOUT_SYSTEM_PROMPT,
      buildUserPrompt: buildPayoutUserPrompt,
      resolveDatePairs: resolvePayoutDatePairs
    };
  }
  return null;
};

export const REASONING_CHALLENGER_FAMILIES = Object.freeze([
  'supplier_bill',
  'sales_invoice',
  'receipt',
  'payment_confirmation',
  'payment_account_statement',
  'payout_statement'
]);

// ── The lane comparator ─────────────────────────────────────────────────
// Both sides come out of parseProposeMatchesResponse + tie expansion, so
// proposals carry validated candidate ids only. The lane's verdict IS the
// proposed target set: which bank line(s), if any, settle this document.
// Ids-only in summaries (the retention posture — ids are joinable keys,
// never content); confidences and free-text reasoning are never compared
// and never recorded.
export const compareReconciliationReasoningOutputs = ({ decidingResult, challengerResult } = {}) => {
  if (!challengerResult || typeof challengerResult !== 'object') {
    return { outcome: 'parse_failure', failure_class: null, summary: { reason: 'challenger output unparseable' } };
  }
  const proposedIds = (r) => [...new Set((r?.proposals || []).map((p) => String(p.bank_transaction_id)))].sort();
  const deciding = proposedIds(decidingResult);
  const challenger = proposedIds(challengerResult);
  if (deciding.join('|') === challenger.join('|')) {
    if (!deciding.length) {
      // Both said no-match; a differing machine reason is cosmetic drift,
      // recorded because reason strings feed the goal evaluator downstream.
      const decidingReason = decidingResult?.unmatchable_reason || null;
      const challengerReason = challengerResult?.unmatchable_reason || null;
      if (decidingReason !== challengerReason) {
        return {
          outcome: 'divergence',
          failure_class: 'format_drift',
          summary: { field: 'unmatchable_reason', deciding: decidingReason, challenger: challengerReason }
        };
      }
    }
    return { outcome: 'match', failure_class: null, summary: null };
  }
  return {
    outcome: 'divergence',
    // One side proposed, the other declined → omission; both proposed but
    // different targets → verdict_flip. Either way the settling line the
    // book would carry differs — the lane's load-bearing failure mode.
    failure_class: !deciding.length || !challenger.length ? 'omission' : 'verdict_flip',
    summary: { field: 'proposed_bank_transaction_ids', deciding, challenger }
  };
};

// ── The reverse transport ───────────────────────────────────────────────
// The strong default replays the EXACT deciding observation over the
// core's own anthropic transport. An API failure here throws and the Q2
// harness receipts it as challenger_error — honest comparator downtime,
// never a swallowed gap.
const buildCallReverseChallenger = ({ familyConfig, observation, clientId, apiKey, fetchImpl }) => async () => {
  const datePairs = familyConfig.resolveDatePairs({
    clientId,
    configSnapshot: observation.configSnapshot ?? null
  });
  const userPrompt = familyConfig.buildUserPrompt({
    document: observation.document,
    candidateBankLines: observation.candidateBankLines,
    firmContext: observation.firmContext ?? null,
    datePairs
  });
  const semantic = await proposeMatchesViaAnthropic({
    systemPrompt: familyConfig.systemPrompt,
    userPrompt,
    candidateBankLines: observation.candidateBankLines,
    document: observation.document,
    model: CORE_DEFAULT_MODEL,
    apiKey,
    fetchImpl,
    datePairs,
    logTag: 'reconciliationReasoningReverseShadow'
  });
  return {
    result: { proposals: semantic.proposals, unmatchable_reason: semantic.unmatchable_reason ?? null },
    telemetry: {
      model: semantic.model ?? null,
      model_source: semantic.model_source === 'response_proven' ? 'response' : 'configured_fallback',
      usage: null
    }
  };
};

// ── The hook builder ────────────────────────────────────────────────────
// Called by a family WRAPPER (billReconciliation / salesInvoiceReconciliation
// — they own firmDb access and the per-run policy read; the Llm
// orchestrators, which cannot import firmDb, only FIRE the hook
// post-stamp). Returns `(observation) => void` or null when the reverse
// shadow cannot run. The observation is the orchestrator's exact deciding
// input + result:
//   { document, candidateBankLines (truncated as sent), firmContext,
//     configSnapshot, decidingResult, decidingModel, executionRoot }
export const makeReconciliationReasoningChallengerHook = ({
  family,
  firmId,
  clientId,
  snapshot = null,
  withClient,
  env = process.env,
  sample = null,
  fetchImpl = null,
  anthropicApiKey = null,
  // 2026-11-10 (modelLanes.js SELF_HOSTED_DECISION): the seat the hook would
  // shadow. A self-hosted, unqualified seat gets NO reverse shadow: the
  // company chose a local model, so no cloud model is called about its
  // documents for this lane (and no comparison is evidence for promotion).
  decidingPolicy = null
} = {}) => {
  if (isUnqualifiedSeat(decidingPolicy)) return null;
  const familyConfig = familyConfigFor(family);
  if (!familyConfig || !firmId || !clientId || typeof withClient !== 'function') return null;
  const lane = getLane(RECONCILIATION_REASONING_LANE);
  if (!lane?.challenger?.eligible) return null;

  const apiKey = anthropicApiKey ?? getAnthropicApiKey();
  if (!apiKey) return null;
  const cap = Number(env[CHALLENGER_CAP_ENV]);
  if (!Number.isFinite(cap) || cap <= 0) return null; // fail-closed, same as every challenger

  const fraction = Number(lane.challenger.sampling?.fraction);
  const effectiveSample = sample
    || (() => Math.random() < (Number.isFinite(fraction) ? fraction : 0));

  return (observation) => {
    if (!observation?.document?.id || !observation?.decidingResult) return;
    const rootId = observation.executionRoot?.id ?? observation.document.id;
    void dispatchChallengerRun({
      firmId,
      clientId,
      laneId: RECONCILIATION_REASONING_LANE,
      snapshot,
      // Model keys stay off the compared/persisted deciding blob — the
      // receipt's `deciding` column carries them separately below.
      decidingResult: {
        proposals: observation.decidingResult.proposals || [],
        unmatchable_reason: observation.decidingResult.unmatchable_reason ?? null
      },
      decidingModel: {
        model: observation.decidingModel?.model ?? null,
        model_source: observation.decidingModel?.model_source ?? null
      },
      execution: { root: { type: RECONCILIATION_REASONING_LANE, id: rootId } },
      callChallenger: buildCallReverseChallenger({
        familyConfig,
        observation,
        clientId,
        apiKey,
        fetchImpl
      }),
      capTokensPerClientMonth: cap,
      comparator: compareReconciliationReasoningOutputs,
      sample: effectiveSample,
      withClient,
      env
    }).catch(() => { /* dispatch is no-throw by contract; this guards the contract itself */ });
  };
};
