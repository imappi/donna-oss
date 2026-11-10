import { isProviderSpendLimit } from '../providerTransport.js';
// document/parse.requested handler — async document parsing worker.
//
// Run-token gated state machine described in
// docs/async-parsing-plan.md → "Worker". Every write threads the
// parse_run_id from the event payload, so a stale Inngest retry whose
// previous attempt was superseded by a manual /retry-parse (which mints
// a new id) can never clobber a row.
//
// Lifecycle (happy path):
//   pending → claim → fetching → extracting → writing → enriching →
//   finalizing → completed.
//
// On retryable error: release this run from processing back to pending,
// then throw — the queue backs off (Inngest in the cloud; the `parse-document`
// local job on the appliance, RT-08) and the next attempt takes a fresh
// exclusive claim. When the throwing attempt is the LAST one the queue will
// make (`attempt.count >= attempt.max`, threaded in by the job runner), the
// worker writes the honest terminal itself before throwing — retryable:false,
// the spent budget in the copy, a MANUAL owner — so a released row can never
// rest pending with nobody to retry it (audit F-02). On terminal error:
// markFailed with a categorized parse_error envelope (no raw provider output).

import crypto from 'node:crypto';

import { inngest } from './client.js';
import {
  buildProviderWaitHold,
  categorizeError,
  ParseError,
  parseRetriesExhaustedEnvelope,
  providerWaitAllowed,
  providerWaitFor
} from './parseErrors.js';
import {
  claimParseRunInDb,
  findOverlappingStatementInDb,
  getDocumentForParseInDb,
  markParseCompletedInDb,
  markParseDuplicatePendingInDb,
  markParseFailedInDb,
  markParseSkippedInDb,
  releaseParseRunForRetryInDb,
  setParseProgressInDb,
  setParseStageInDb,
  upsertParsedTransactionsInDb,
  writeParsedDocumentExtractionInDb,
  runReconciliationForBankStatementInDb,
  autoCategorizeMatchedTransactionsInDb,
  autoCategorizeUnmatchedTransactionsInDb,
  recordPostParseLegFailureInDb,
  persistPartialHeaderInDb
} from '../parseDocumentsDb.js';
import { fetchEvidenceObjectBytes } from '../evidenceStorage.js';
import { sendOwnerMediaParseSummary } from '../channels/ownerMediaParseSummary.js';
import { applyPostExtractionEnrichment } from '../filenameFallback.js';
import { extractBankStatementFromBase64 } from '../bankStatement.js';
import { extractReceiptFromBase64 } from '../receipt.js';
import { extractSupplierBillFromBase64 } from '../supplierBill.js';
import { extractSalesInvoiceFromBase64 } from '../salesInvoice.js';
import { extractPayoutStatementFromBase64 } from '../payoutStatement.js';
import { extractContractFromBase64 } from '../contract.js';
import { extractGenericDocumentFromBase64 } from '../genericDocument.js';
import {
  extractUnified,
  unifiedExtractorServes,
  UNIFIED_EXTRACTOR_PROMPT_VERSION
} from '../unifiedExtractor.js';
import { repairMissingFields } from '../parserRepair.js';
import { refreshTransactionIntelInDb, recordJurisdictionSignalInDb, batchSuggestTransactionCodingInDb, resumeEvidenceRecodeAfterParseInDb, readClientConfigSnapshotInDb, createClientEvidenceRequestInDb } from '../firmDb.js';
import { getRecentFirmCorrectionsFromDb } from '../documentCorrections.js';
import { dateFormatHintFor } from '../jurisdictionDate.js';
import { getExtractionContextInDb } from '../extractionContextDb.js';
import { detectJurisdictionFromBankStatement } from '../jurisdictionDetector.js';
import { validateReceiptTotals } from '../totalsValidation.js';
import { classifyReceipt } from '../receiptClassifier.js';
import { routeDocument } from '../documentRouter.js';
import { validateDocument, outcomesToLegacyWarnings, totalsReceiptFromOutcomes } from '../documentValidator.js';
import { calibrate } from '../confidenceCalibration.js';
import { legacyFlagEnabled } from '../loopExecutionGate.js';
import { clientFlagActs } from '../clientConfig.js';
import { FINLAND_EINVOICE_RECEIVE_FLAG_KEY, receiveEInvoiceDocument } from '../inboundCountryRegistry.js';

// Feature flag for the document-extractor wave (PR 1 of
// docs/invoice-receipt-parsing-plan.md). Receipts (and later
// supplier_bill / sales_invoice) stay on the existing skipped path
// when this is unset/false — i.e. the worker behaves exactly as it
// did pre-PR-1 and the firm sees "Saved (no parsing for this type)".
// Read as a function so flag flips at deploy time take effect on the
// next worker invocation without a module-cache restart.
// Step 6: the gate READ is centralized in loopExecutionGate.legacyFlagEnabled
// (one predicate for the whole *_ENABLED wave); the value is byte-identical.
// Batch-2 Slice B (docs/donna-batch2-extractor-cluster-plane-wiring-plan.md):
// DB-first — a client_capability_config row for the flag key (== the env var
// name, 0A.9 precedent) decides via the stage vocabulary; without a row the
// legacy env predicate decides byte-identically (false in prod, census
// 2026-07-05: the var is unset — a row is the only opener).
const isDocumentExtractorsEnabled = ({ configSnapshot = null } = {}) =>
  clientFlagActs({
    flagKey: 'DOCUMENT_EXTRACTORS_ENABLED',
    snapshot: configSnapshot,
    envFallback: () => legacyFlagEnabled('DOCUMENT_EXTRACTORS_ENABLED')
  });

// Inner gate for line writes (PR 2 of
// docs/invoice-receipt-parsing-plan.md). Strictly nested inside
// `DOCUMENT_EXTRACTORS_ENABLED`: if the parent is off, this flag is
// ignored and receipts still resolve as `skipped/extractor_unavailable`.
// With the parent on but this off, header extraction runs and writes
// but lines are dropped at the worker boundary — preserves PR 1's
// per-firm calibration loop while PR 2's line-extraction quality is
// being measured. With both on, the full PR 2 path runs.
// Batch-2 Slice B: same DB-first shim shape as the parent gate above. The
// nesting is STRUCTURAL, not re-encoded here — every read site sits inside a
// branch the parent gate already admitted (or inside the unified branch,
// whose own gate sits ahead of the wave), so a lines row can never write
// lines while the wave is off for that client.
const isDocumentLinesEnabled = ({ configSnapshot = null } = {}) =>
  clientFlagActs({
    flagKey: 'DOCUMENT_LINES_ENABLED',
    snapshot: configSnapshot,
    envFallback: () => legacyFlagEnabled('DOCUMENT_LINES_ENABLED')
  });

// LLM-first bank-statement extraction: the statement's text layer goes to
// the strong structured model (semantic line schema — counterparty /
// payment_method / message / reference) before the regex tiers, which
// stay as the fallback. Born plane-native per the flag rail: no env pair,
// `envFallback: () => false` — a config row is the only opener, and
// CLIENT_CONFIG_FORCE_DISABLE_* remains the kill switch.
const isBankStatementLlmFirstEnabled = ({ configSnapshot = null } = {}) =>
  clientFlagActs({
    flagKey: 'BANK_STATEMENT_LLM_EXTRACTION',
    snapshot: configSnapshot,
    envFallback: () => false
  });

// Inner gate for the receipt semantic classifier (Reconciliation PR 2
// of docs/reconciliation-pr1-handoff.md series). Strictly nested
// inside `DOCUMENT_EXTRACTORS_ENABLED`: when the parent is off,
// receipts skip extraction entirely and the classifier is moot. When
// the parent is on and this is on, the classifier runs after the
// extractor and writes its output to `summary.semantic`. When this is
// off, `summary.semantic` is never set; PR 3's auto-explain gate
// treats missing `summary.semantic` as "no classifier signal" and
// blocks auto-explain. Default OFF — flipped on per-firm once the
// classification quality clears the calibration bar.
const isReceiptClassifierEnabled = () => legacyFlagEnabled('RECEIPT_CLASSIFIER_ENABLED');

const isGenericDocumentExtractorEnabled = ({ configSnapshot = null } = {}) =>
  clientFlagActs({
    flagKey: 'GENERIC_DOCUMENT_EXTRACTOR_ENABLED',
    snapshot: configSnapshot,
    envFallback: () => legacyFlagEnabled('GENERIC_DOCUMENT_EXTRACTOR_ENABLED')
  });

const isDocumentRouterEnabled = ({ configSnapshot = null } = {}) =>
  clientFlagActs({
    flagKey: 'DOCUMENT_ROUTER_ENABLED',
    snapshot: configSnapshot,
    envFallback: () => legacyFlagEnabled('DOCUMENT_ROUTER_ENABLED')
  });

// RT-05 (2026-09-01, decision D6) — the router's shadow mode and its flag
// family (DOCUMENT_ROUTER_SHADOW_ONLY, DOCUMENT_ROUTER_PROMOTE_FAMILIES, the
// per-family DOCUMENT_ROUTER_PROMOTE_<FAMILY> plane keys) are DELETED for
// good under the zero-users rail: classification is not a ledger write.
// A routed family with a recommended extractor and confidence >=
// DOCUMENT_ROUTER_MIN_CONFIDENCE now overrides the upload-time type for
// EVERY family; the only things that still hold an override back are the
// two blast-radius guards in __buildClassification (perception_downgrade,
// transaction_writer_guard), which are unchanged. Before this, a confident
// classification of any family but invoice_or_bill was discarded as
// `shadow_only` on the appliance — no seed ever minted a promote row — so
// payouts, deposit slips and notices were typed `unknown` from birth and
// fell to the generic extractor (audit F-04). Deleted rather than seeded so
// the posture cannot drift back through an unset row.

// Minimum router confidence required to override the request-body
// document_type. Below this the router result is recorded in the
// classification audit but the original type is preserved. Default 0.65
// — picked to admit clear matches while leaving ambiguous documents to
// the request-body hint or the firm reviewer.
const DEFAULT_ROUTER_MIN_CONFIDENCE = 0.65;
const documentRouterMinConfidence = () => {
  const raw = String(process.env.DOCUMENT_ROUTER_MIN_CONFIDENCE ?? '').trim();
  if (!raw) return DEFAULT_ROUTER_MIN_CONFIDENCE;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return DEFAULT_ROUTER_MIN_CONFIDENCE;
  return n;
};

// ── Optional-context load timeouts (parse-stall guard) ─────────────────
// The pre-extraction context loads in the worker (firm identity, the
// jurisdiction date-hint, prior corrections, and the router
// classification) are all OPTIONAL: the extractor + router fall back
// cleanly when each is absent. Each is wrapped in a try/catch that
// degrades to null on a THROW — but a try/catch does NOT bound LATENCY.
// An await that HANGS (a separate-pool connection that never returns, a
// slow query on a freshly-created table, an LLM call with no transport
// timeout) would stall the whole parse with no escape; the Vercel
// function then dies at its 300s ceiling, the stuck-job cron flips the
// row to failed/retryable, and the retry hits the same hang — a silent,
// deterministic stall. Timeboxing each load turns that into a sub-second
// "degrade to null and keep parsing": the load-bearing extraction never
// waits on optional context. This is system-correctness scaffolding —
// it does not substitute for the model, it stops optional context from
// blocking it.
const OPTIONAL_CONTEXT_READ_TIMEOUT_MS = 8000; // DB reads: identity, jurisdiction, corrections
const ROUTER_CLASSIFY_TIMEOUT_MS = 45000; // router LLM classify call (generous; well under 300s)
// Post-extraction transaction-intel refresh. Recomputes client-wide
// signals from documents + transactions in one DB transaction; it's
// soft-degrade (a throw lands `enrichment_warning` on parse_summary),
// but the soft-degrade only catches a REJECTION, not a HANG. A slow
// refresh on a freshly-grown transaction set would otherwise hold the
// doc in "Reading" past Vercel's 300s ceiling — the same parse-stall
// class as the pre-extraction loads. Timeboxed at 45s; well under the
// function ceiling and longer than any healthy refresh observed.
const INTEL_REFRESH_TIMEOUT_MS = 45000;

// ── Load-bearing extraction timebox (the parse-stall guard's missing half) ──
// The optional context loads above are timeboxed; the ONE non-optional await
// in the worker — the strong-model vision extraction call — was not. A
// degraded/slow Responses API then HANGS it with no transport timeout and no
// rejection: the row sits in `extracting` until the Vercel 300s function
// ceiling kills the invocation, the stuck-job cron (`failStuckProcessingRows`)
// flips it to failed/STUCK, and the FE shows the "READING · 1 OF 1 → PARSE
// TIMED OUT" symptom — the exact 2026-06-30 Honeybee incident (5 of 6 demo docs
// reaped this way). Timeboxing it BELOW the 300s ceiling converts that silent
// external reap into a clean ContextLoadTimeoutError: the outer catch's
// `categorizeError` matches "timed out" → OCR_TIMEOUT (retryable) → heartbeat +
// throw → Inngest does a normal backoff/retry inside budget, instead of a
// 5-minute hang ending in STUCK. UNLIKE the optional loads this does NOT degrade
// to null — a missing extraction has nothing to fall back to, so the timeout
// MUST surface as the retryable failure (no try/catch at the call site).
// Env-overridable: the healthy-latency baseline of the vision call is the
// hardest of these to pin, and it is the only timebox where a false positive
// turns a WORKING parse into a retry — so prod keeps a no-deploy tuning knob.
// Default 180s leaves ~120s headroom under the 300s ceiling for the router +
// post-extraction intel/reconciliation/finalize stages that share the budget.
const EXTRACTION_TIMEOUT_MS = (() => {
  const raw = Number(process.env.PARSE_EXTRACTION_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 180000;
})();

export class ContextLoadTimeoutError extends Error {
  constructor(label, ms) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'ContextLoadTimeoutError';
    this.code = 'CONTEXT_LOAD_TIMEOUT';
  }
}

// Race `promise` against a timeout. On timeout the returned promise
// REJECTS with a ContextLoadTimeoutError so the call site's EXISTING
// try/catch degrades to its null fallback and logs, exactly as it
// already does for a thrown error — no call-site fallback logic changes,
// we only stop a hang from blocking forever. The original promise gets a
// no-op catch so a late rejection (after the race already settled) never
// surfaces as an unhandledRejection; its eventual result is discarded.
export const withTimeout = (promise, ms, label = 'operation') => {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    // NOTE: deliberately NOT unref()'d. While we're awaiting, the timer
    // must keep the event loop alive so the timeout can actually fire and
    // reject (an unref'd timer lets the process exit early when the raced
    // promise has no active handle of its own). The `.finally` below
    // always clears it once the race settles, so it never dangles.
    timer = setTimeout(() => reject(new ContextLoadTimeoutError(label, ms)), ms);
  });
  Promise.resolve(promise).catch(() => {});
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
};

// Unlike identity / jurisdiction / correction context, the capability
// snapshot is not optional: it decides whether perception is allowed to run.
// A timeout must therefore retry the parse, never degrade to `{}` and turn a
// supported receipt or bill into `skipped/extractor_unavailable`.
export const loadRequiredConfigSnapshot = async ({ load, timeoutMs = OPTIONAL_CONTEXT_READ_TIMEOUT_MS } = {}) => {
  if (typeof load !== 'function') {
    throw new ParseError('CONFIG_SNAPSHOT_UNAVAILABLE', {
      message: 'Client config snapshot loader is unavailable.',
      provider: 'internal',
      reason: 'config_loader_unavailable'
    });
  }
  try {
    return (await withTimeout(
      Promise.resolve().then(load),
      timeoutMs,
      'client config snapshot read'
    )) || {};
  } catch (error) {
    throw new ParseError('CONFIG_SNAPSHOT_UNAVAILABLE', {
      message: error?.message || 'Client config snapshot read failed.',
      provider: 'internal',
      reason: 'client_config_snapshot_read_failed'
    });
  }
};

// Type → direction lookup. Receipts and supplier bills are money
// OUT of the firm; sales invoices and issued receipts are money IN;
// bank statements and payment_account_statements are internal
// (settlement artifacts — neither AP nor AR cleanly: the underlying
// merchant charges on a card statement are individually AP, but the
// document itself is a periodic statement bridging them to a single
// bank-account settlement). payment_confirmation is outgoing — it's
// a receipt for an outbound ACH/wire (the firm paying a card provider,
// tax authority, lender). Anything else (contract, unknown) lands
// 'unknown' until the router learns to emit direction for those
// families.
export const directionForDocumentType = (documentType) => {
  switch (documentType) {
    case 'receipt':
    case 'supplier_bill':
    case 'payment_confirmation':
      return 'outgoing';
    case 'sales_invoice':
    case 'issued_receipt':
    // RT-18: a payout statement / deposit slip is the firm's own revenue
    // arriving — money in, the same direction as an issued receipt.
    case 'payout_statement':
    case 'deposit_slip':
      return 'incoming';
    case 'bank_statement':
    case 'payment_account_statement':
      return 'internal';
    default:
      return 'unknown';
  }
};

// Pure computation: turn a router result + the original (request-body)
// document type into a (classification audit payload, effective type)
// pair. Exported as `__buildClassification` so it can be unit-tested
// without spinning up the whole worker. The classification payload is
// the durable audit trail of "why is this doc typed the way it is" and
// lands on `parse_summary.classification`.
//
// Decision matrix:
//   router_disabled     → original type, fallback_used=true, reason='router_disabled'
//   router not routed   → original type, fallback_used=true, reason='router_unconfigured'|'router_error'
//   no recommended ext  → original type, fallback_used=true, reason='no_recommended_extractor'
//   confidence < min    → original type, fallback_used=true, reason='low_confidence'
//   dedicated → generic → original type, fallback_used=true, reason='perception_downgrade'
//   dedicated → bank_statement → original type, fallback_used=true,
//                         reason='transaction_writer_guard'
//   otherwise           → router type,  fallback_used=false
//
// There is no shadow gate (RT-05): every family the router can name is
// eligible to override once it clears the floor and the two guards. The
// receipt always carries `family` + `recommended_extractor` — what the
// router SAW and what it WANTED — on every path, including the ones that
// keep the original type (no_recommended_extractor, low_confidence, the
// guards), so a document that rests `unknown` because its family has no
// extractor still carries the family for the inbox and the payout lane
// (RT-18) to read from `parse_summary.classification` alone.
export const __buildClassification = ({
  routerResult,
  originalType,
  minConfidence,
  routerModel = null,
  pickExtractorImpl = pickExtractor
} = {}) => {
  const normalizedOriginal = originalType || 'unknown';

  if (!routerResult) {
    return {
      classification: {
        source: 'user_hint',
        model: null,
        confidence: null,
        original_type: normalizedOriginal,
        final_type: normalizedOriginal,
        family: null,
        recommended_extractor: null,
        direction_hint: null,
        candidate_families: [],
        reason: null,
        fallback_used: true,
        fallback_reason: 'router_disabled'
      },
      finalType: normalizedOriginal
    };
  }

  const base = {
    source: 'router_v1',
    model: routerModel,
    confidence: typeof routerResult.confidence === 'number' ? routerResult.confidence : null,
    original_type: normalizedOriginal,
    family: routerResult.family || null,
    recommended_extractor: routerResult.recommended_extractor || null,
    direction_hint: routerResult.direction_hint || null,
    candidate_families: Array.isArray(routerResult.candidate_families)
      ? routerResult.candidate_families
      : [],
    reason: routerResult.reason || null
  };

  if (!routerResult.routed) {
    const fallbackReason =
      routerResult.reason === 'api_key_missing' ? 'router_unconfigured' : 'router_error';
    return {
      classification: {
        ...base,
        confidence: null,
        final_type: normalizedOriginal,
        fallback_used: true,
        fallback_reason: fallbackReason
      },
      finalType: normalizedOriginal
    };
  }

  const recommended = routerResult.recommended_extractor || null;
  if (!recommended) {
    return {
      classification: {
        ...base,
        final_type: normalizedOriginal,
        fallback_used: true,
        fallback_reason: 'no_recommended_extractor'
      },
      finalType: normalizedOriginal
    };
  }

  if (Number(routerResult.confidence || 0) < minConfidence) {
    return {
      classification: {
        ...base,
        final_type: normalizedOriginal,
        fallback_used: true,
        fallback_reason: 'low_confidence'
      },
      finalType: normalizedOriginal
    };
  }

  // Perception-downgrade guard (June 2026 — the fifth pilot-client Airwallex
  // stall). The router can be MORE precise than the upload-time type
  // and still route the doc to a WEAKER perception path:
  // `bank_statement` → `payment_account_statement` is semantically
  // right for an Airwallex wallet statement, but
  // payment_account_statement is served by the generic single-shot
  // extractor (60s budget) while bank_statement has the dedicated
  // chunked vision extractor — the override traded a capable extractor
  // for an incapable one and the doc looped to timeout on every
  // Inngest retry. Never downgrade: when the original type has a
  // dedicated extractor and the recommended type would land on the
  // generic extractor (or none), keep the original type and record
  // what the router wanted in the audit. Upgrades (generic → dedicated)
  // and dedicated → dedicated corrections still apply.
  const fromExtractorType = pickExtractorImpl(normalizedOriginal)?.type || null;
  const toExtractorType = pickExtractorImpl(recommended)?.type || null;
  const fromIsDedicated = Boolean(fromExtractorType) && fromExtractorType !== 'generic_document';
  const toIsDedicated = Boolean(toExtractorType) && toExtractorType !== 'generic_document';
  if (recommended !== normalizedOriginal && fromIsDedicated && !toIsDedicated) {
    return {
      classification: {
        ...base,
        final_type: normalizedOriginal,
        suppressed_type: recommended,
        fallback_used: true,
        fallback_reason: 'perception_downgrade'
      },
      finalType: normalizedOriginal
    };
  }

  // Blast-radius guard (June 2026 — the Honeybee Bank_Fee phantom
  // import). bank_statement is the one dispatch target that WRITES
  // TRANSACTIONS, and it bypasses the unified extractor entirely — so
  // a wrong nano-router flip INTO it is both unreviewable by the
  // strong model and maximally destructive. Observed live: a June fee
  // NOTICE uploaded with a confident supplier_bill type was re-typed
  // to bank_statement, the statement extractor read OCR garbage, and
  // two phantom SGD transactions landed on a USD client's feed — while
  // the byte-identical July twin stayed a bill and matched cleanly.
  // Every other dedicated → dedicated correction gets a second opinion
  // downstream (the unified extractor's type decision); this one does
  // not. The router may still rescue weak types (unknown / generic →
  // bank_statement, the common case), but it may not overrule a
  // confident upload-time DEDICATED type into the transaction-writing
  // path on its own nano authority. The suppressed recommendation is
  // recorded for the disagreement-rate evidence base.
  if (
    recommended === 'bank_statement' &&
    normalizedOriginal !== 'bank_statement' &&
    fromIsDedicated
  ) {
    return {
      classification: {
        ...base,
        final_type: normalizedOriginal,
        suppressed_type: recommended,
        fallback_used: true,
        fallback_reason: 'transaction_writer_guard'
      },
      finalType: normalizedOriginal
    };
  }

  return {
    classification: {
      ...base,
      final_type: recommended,
      fallback_used: false,
      fallback_reason: null
    },
    finalType: recommended
  };
};

// Slice B closure — when the unified extractor ran, ITS document_type
// is the classification we trust: it's the strong model, it sees the
// firm anchor + prior corrections, and a completed unified extraction
// always carries a valid pilot type (the mapper rejects 'unknown').
// The router is a nano-class model whose job is picking which
// extractor to invoke — not deciding AP vs AR.
//
// Until this function existed, the unified type only ever landed on
// parse_summary.document_type while the ROW kept the router's type.
// Production proof (June 2026, Honeybee): a Mann Lake supplier bill
// was uploaded as supplier_bill (correct), the nano router flipped it
// to sales_invoice with self-contradicting reasoning ("direction
// chosen as ap when the firm is the buyer" in prose, direction_hint=
// 'ar' in the structured fields), the Opus unified extraction came
// back AP-shaped (vendor_name populated, customer null) — and the row
// stayed sales_invoice, so the AR matcher auto-matched a supplies
// purchase to a deposit.
//
// Audit contract: `final_type` is always what gets written.
// `final_type_source` records which model made the final call —
// 'unified_extractor' on an override (the router's choice is
// preserved as `router_final_type`), 'unified_extractor_agreed' when
// the two models agree (queryable disagreement rate is the evidence
// base for retiring the router's type authority entirely — see
// CLAUDE.md, "which files can we delete now").
export const __applyUnifiedTypeDecision = ({
  classification,
  finalType,
  modelDocumentType
} = {}) => {
  if (!modelDocumentType) {
    return { finalType, classification };
  }
  if (modelDocumentType === finalType) {
    return {
      finalType,
      classification: {
        ...classification,
        final_type_source: 'unified_extractor_agreed'
      }
    };
  }
  return {
    finalType: modelDocumentType,
    classification: {
      ...classification,
      router_final_type: classification?.final_type ?? null,
      final_type: modelDocumentType,
      final_type_source: 'unified_extractor'
    }
  };
};

// The extractor-path receipt on parse_summary.extractor (Slice-B Step 0,
// re-shaped by RT-12). Records which extractor actually ran, on which
// provider, with which RESPONSE-named model id and prompt version — and,
// when the unified extractor was the default for this document but did not
// serve it, why the per-type extractor served instead (`fallback_used`,
// `fallback_reason` = the unified failure code/reason). The fall-through is
// ONE release deep (the plan's canary window); the deletion PR removes the
// per-type extractors and this receipt stops carrying a fallback. Ground
// truth for "unified ran" is `result.model_document_type` — ONLY the unified
// branch sets it; the attempt record (`result.unified_attempt`) is what
// extractDocument's wrapper stamps on every outcome.
export const buildExtractorReceipt = ({ documentType, result } = {}) => {
  const attempt = result?.unified_attempt || null;
  const ranUnified = Boolean(result?.model_document_type);
  const unifiedDefault = Boolean(attempt?.unified_default);
  const fellBack = unifiedDefault && attempt?.attempted && !ranUnified;
  return {
    path: ranUnified ? 'unified' : 'type_specific',
    provider: ranUnified ? (attempt?.provider || null) : (result?.extractor_provider || null),
    model: ranUnified ? (attempt?.model || result?.extractor_model || null) : (result?.extractor_model || null),
    model_source: ranUnified ? (attempt?.model_source || null) : (result?.extractor_model_source || (result?.extractor_model ? 'configured_fallback' : null)),
    prompt_version: ranUnified ? UNIFIED_EXTRACTOR_PROMPT_VERSION : (result?.summary?.prompt_version || null),
    unified_default: unifiedDefault,
    unified_default_reason: attempt?.unified_default_reason || null,
    fallback_used: Boolean(fellBack),
    fallback_reason: fellBack ? (attempt?.failure?.code || 'unified_fallback') : null,
    fallback_detail: fellBack ? (attempt?.failure?.reason || null) : null,
    document_type_hint: documentType || null
  };
};

// pickExtractor — per-document-type dispatch. Returns a descriptor
// the worker switches on, or null when no extractor is currently
// available (the worker then marks the doc skipped with
// `extractor_unavailable`). Bank statements are always served by
// their long-standing extractor; the DOCUMENT_EXTRACTORS_ENABLED
// flag only gates the new doc-type wave. `configSnapshot` (batch-2 Slice B)
// is the per-run config control plane snapshot — optional, so callers
// without one (tests, the perception-downgrade guard when uninjected) keep
// the env-fallback behaviour unchanged.
export const pickExtractor = (documentType, { configSnapshot = null } = {}) => {
  if (documentType === 'bank_statement') {
    return { type: 'bank_statement', extract: extractBankStatementFromBase64 };
  }
  if (!isDocumentExtractorsEnabled({ configSnapshot })) return null;
  if (documentType === 'receipt') {
    return { type: 'receipt', extract: extractReceiptFromBase64 };
  }
  // PR 6 of docs/invoice-receipt-parsing-plan.md — supplier bills land
  // through the same dispatch + writer machinery as receipts. The
  // bill extractor's output shape matches receipt's writer contract
  // (header + summary + lines), so the worker treats the resulting
  // descriptor as a `completed_header` outcome below — the bill-vs-
  // receipt discriminator lives entirely in `summary.document_type`.
  if (documentType === 'supplier_bill') {
    return { type: 'supplier_bill', extract: extractSupplierBillFromBase64 };
  }
  // PR 7 of docs/invoice-receipt-parsing-plan.md — sales invoices land
  // through the same dispatch + writer machinery as supplier bills.
  // The direction discriminator (`vendor_name=null`,
  // `counterparty_role='customer'`) lives inside the extractor's
  // `mapExtractionToWriterShape`; the worker treats the descriptor
  // identically to the bill case.
  if (documentType === 'sales_invoice') {
    return { type: 'sales_invoice', extract: extractSalesInvoiceFromBase64 };
  }
  // `issued_receipt` is a receipt the firm ISSUED (rent receipts,
  // paid-payment acknowledgements). Structurally the same fields a
  // sales invoice carries — counterparty is a customer, amount is the
  // receipt total — so it reuses the sales_invoice extractor + the
  // sales_invoice reconciliation matcher. The distinct document_type
  // lets accounting templates render "Receipt issued" instead of
  // "Sales invoice / paid" and keeps payment_status semantics honest
  // (issued receipts are paid by construction).
  if (documentType === 'issued_receipt') {
    return { type: 'issued_receipt', extract: extractSalesInvoiceFromBase64 };
  }
  // RT-18 — the payout / deposit-slip family (audit F-04 part 2, F-23).
  // Both document types are served by ONE extractor (payoutStatement.js),
  // which reads the gross → refunds → fees ± adjustments = net breakdown
  // and returns the writer-shape contract (header with the NET as
  // total_amount + summary + signed breakdown lines). One descriptor type
  // for both so the classification guards read either as a DEDICATED
  // extractor (an `unknown` upload routed here is an upgrade, never a
  // perception downgrade). The dispatched document type is threaded to
  // the extractor in the `payout_statement` branch of extractDocument.
  if (documentType === 'payout_statement' || documentType === 'deposit_slip') {
    return { type: 'payout_statement', extract: extractPayoutStatementFromBase64 };
  }
  // PR 18 — contracts join the doc-type wave. The extractor returns
  // the same writer-shape contract (header + summary + lines, where
  // lines is always []). The worker's `completed_header` outcome
  // branch handles both with/without lines uniformly.
  if (documentType === 'contract') {
    return { type: 'contract', extract: extractContractFromBase64 };
  }
  // payment_account_statement (Amex / fuel-card / expense-platform
  // statements) is served by the generic perception extractor for now —
  // LLM-first at the perception layer per the architectural note in
  // docs/. The matcher (Stage 2) reads parse_summary.router.family +
  // the generic extractor's amounts/parties/dates to match the
  // statement total against the settlement ACH. A dedicated
  // statement-with-underlying-charges extractor is deferred until we
  // see what the generic perception misses on real firm uploads.
  if (documentType === 'payment_account_statement') {
    return { type: 'generic_document', extract: extractGenericDocumentFromBase64 };
  }
  // payment_confirmation — single-event ACH/wire receipts (the firm
  // paying a card provider, tax authority, lender). These previously
  // had no extractor (FAMILY_TO_EXTRACTOR.payment_confirmation = null),
  // so the worker marked them skipped with extractor_unavailable and
  // the documents row's vendor/amount/date stayed filename-derived
  // only — no real perception happened. Route through the generic
  // extractor so the PDF body actually gets read; the matcher
  // (Stage 2.5) then sees a real total_amount/vendor_name/document_date
  // and can match against the outbound bank ACH.
  if (documentType === 'payment_confirmation') {
    return { type: 'generic_document', extract: extractGenericDocumentFromBase64 };
  }
  if (isGenericDocumentExtractorEnabled({ configSnapshot })) {
    return { type: 'generic_document', extract: extractGenericDocumentFromBase64 };
  }
  return null;
};

const sha256Hex = (bytes) =>
  crypto.createHash('sha256').update(bytes).digest('hex');

const STATEMENT_TRANSACTION_THRESHOLD = 1;

const normalizeTextForFingerprint = (value = '') =>
  String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

// account_fingerprint = hash(bank_name_normalized || iban_last4 ||
// currency). Statement-only; PR 3's period-overlap dup check will read
// it back. PR 2 just computes & stores it so the data is ready.
const computeAccountFingerprint = ({ bank_name, account_number, currency }) => {
  const parts = [
    normalizeTextForFingerprint(bank_name || ''),
    String(account_number || '').replace(/\s+/g, '').slice(-4),
    String(currency || '').toUpperCase()
  ];
  if (!parts.some(Boolean)) return null;
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
};

// Structured period bounds for PR 3's overlap duplicate check. The
// extractor returns a string `period_label` ("YYYY-MM" or
// "YYYY-MM-DD to YYYY-MM-DD") which is fragile to compare; the
// transaction date list, however, is structured. Take min/max over the
// `transaction_date` (or legacy `date`) fields. Returns nulls when no
// valid dates are present — the overlap check skips in that case.
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const computeStatementPeriodBounds = (transactions = []) => {
  let minDate = null;
  let maxDate = null;
  for (const tx of transactions) {
    const raw = tx?.transaction_date || tx?.date || null;
    if (!raw) continue;
    const str = String(raw).slice(0, 10);
    if (!isoDatePattern.test(str)) continue;
    if (minDate === null || str < minDate) minDate = str;
    if (maxDate === null || str > maxDate) maxDate = str;
  }
  return { start: minDate, end: maxDate };
};

// Map the extractor's structured output to what we want in
// `parse_summary`. The legacy /documents/sync writer writes
// `{source: 'documents_sync', transaction_count}` — we preserve
// `transaction_count` so the FE tray's "47 transactions imported" copy
// works across both writers (see PR 1 heads-up #3 in the task brief).
//
// PR 3 augmentation: structured `period_start_date` / `period_end_date`
// computed from the transaction list. PR 3's
// `findOverlappingStatementInDb` reads these back; the legacy
// `statement_period` string label is kept for FE display + as a
// fallback parsing target in `extractPeriodBoundsFromSummary`.
const buildStatementSummary = (extraction, fingerprint) => {
  const bounds = computeStatementPeriodBounds(extraction?.transactions || []);
  return {
    source: 'async_parse',
    document_type: 'bank_statement',
    transaction_count: Number(extraction?.transactions?.length || 0),
    statement_period: extraction?.period_label || null,
    period_start_date: bounds.start,
    period_end_date: bounds.end,
    statement_currency: extraction?.statement_currency || null,
    ledger_currency: extraction?.ledger_currency || null,
    currency_resolution: extraction?.currency_resolution || null,
    extraction_status: extraction?.extraction_status || 'unknown',
    // Which tier decided, and — the model id is part of the receipt —
    // which model, when a structured LLM tier did (null on regex paths).
    extraction_source: extraction?.extraction_source || null,
    extraction_model: extraction?.extraction_model || null,
    extraction_provider: extraction?.extraction_provider || null,
    warnings: Array.isArray(extraction?.warnings) ? extraction.warnings.slice(0, 6) : [],
    account_fingerprint: fingerprint || null
  };
};

// Statement-header keys for `documents.payload`. The ask-pipeline's
// coverage gather (ASK_BATCH_COVERAGE_SQL) and the legacy readers
// (sourceImportCompleteness, transactionIntel) consume
// `payload.statement_summary` / `payload.period_label` /
// `payload.statement_currency` — keys only the legacy /documents/sync
// writer ever wrote. The async worker used the extractor's header
// transiently (fingerprint hash, jurisdiction detector) and dropped it,
// leaving every async-parsed statement with a null coverage identity:
// the ask drafter couldn't tell which counterpart accounts the firm
// already holds statements for. Persisted at parse completion via
// markParseCompletedInDb's payload merge. Key-name variants are
// normalized here so readers can rely on the canonical
// bank_name / account_number / iban shape.
export const buildStatementPayloadPatch = (extraction) => {
  const summary = extraction?.statement_summary;
  const patch = {};
  if (summary && typeof summary === 'object') {
    patch.statement_summary = {
      ...summary,
      bank_name: summary.bank_name || summary.bank || null,
      account_number: summary.account_number || summary.account_identifier || null,
      iban: summary.iban || null
    };
  }
  if (extraction?.period_label) patch.period_label = extraction.period_label;
  if (extraction?.currency_resolution) patch.statement_currency = extraction.statement_currency || null;
  else if (extraction?.statement_currency) patch.statement_currency = extraction.statement_currency;
  return Object.keys(patch).length ? patch : null;
};

// Phase 2b.1 — turn a parsed bank statement's detector inputs into the
// signal object the server-side recorder consumes, or null when nothing
// fires. Pure (no DB, no env): the worker's success branch calls this
// and only touches the recorder when it returns non-null. Kept as its
// own function so the detector→signal mapping is unit-testable without
// standing up the whole worker. The detector NEVER writes the
// authoritative `jurisdiction` field — this only feeds the
// jurisdiction_detected / jurisdiction_signals server-owned keys, and
// the operator still confirms via the Profile card.
export const buildJurisdictionSignalFromStatement = (detectorInput, documentId = null) => {
  if (!detectorInput) return null;
  const detection = detectJurisdictionFromBankStatement(detectorInput);
  if (!detection) return null;
  return {
    source: 'bank_statement',
    jurisdiction: detection.jurisdiction,
    confidence: detection.confidence,
    evidence: detection.evidence,
    document_id: documentId
  };
};

const extractDocumentInner = async ({
  document,
  bytes,
  log,
  onProgress,
  // RT-12 — the partial-header sink: called with the header the unified
  // extractor DID return when its read was unusable (F-12), before the
  // per-type fall-through runs, so a parse that rests failed still carries
  // parse_summary.partial_header. Optional (tests, the eval script).
  onPartialHeader = null,
  // RT-12 — the attempt record the wrapper below stamps on every outcome
  // (completed or thrown) so the extractor receipt can say what happened.
  trace = null,
  dateFormatHint = '',
  // Client identity for the firm-side anchor in the extractor prompt.
  // Optional — when null, the extractors fall back to the un-anchored
  // prompt (still correct, but the model has to guess which name on
  // the page is "us"). See clientIdentityPrompt.js.
  clientIdentity = null,
  // Slice C — recent corrections recorded on prior documents for
  // this firm, threaded as few-shot in the unified extractor's
  // prompt. Optional: null/[] → unchanged prompt. Currently only
  // wired into the unified path; the type-specific extractors
  // don't yet consume corrections (deferred to the per-type
  // retirement pass).
  priorCorrections = null,
  // 0A.9 — per-client config control plane snapshot, resolved once per parse run
  // by the worker (handleParseEvent). Governs the extractor wave and line
  // gates (DOCUMENT_EXTRACTORS_ENABLED / DOCUMENT_LINES_ENABLED); the unified
  // default itself is code, not a plane key (RT-12). null ⇒ env fallback.
  configSnapshot = null,
  // Audit L2 — the client's book currency (pack home currency for the
  // client's jurisdiction), consumed by the bank-statement extractor.
  // Empty ⇒ the extractor's legacy 'SGD' default.
  ledgerCurrency = '',
  pickExtractorImpl = pickExtractor,
  extractUnifiedImpl = extractUnified
}) => {
  const documentType = document.document_type || 'unknown';
  const filename = document.filename || document.id;
  const mimeType = document.payload?.mime_type || document.payload?.file_storage?.mime_type || '';

  // FI-9 (R) — structured e-invoice receive lane (design:
  // docs/design-donna-finland-fi9-receive-and-ap-post.md §R). Content-sniff,
  // never extension/MIME: a recognised Finvoice/UBL e-invoice is structured
  // data — it gets read deterministically (no OCR, no model call) and lands
  // through the SAME completed_header writer path as the supplier-bill
  // extractor, so matching/coding/close engage unchanged. The lane commits
  // only once the format is recognised: `not_einvoice` falls through
  // byte-identically (today an XML upload goes to a vision extractor or
  // parks as extractor_unavailable). A recognised-but-wrong e-invoice
  // (numbers don't foot) is `einvoice_escalated` — an OWNER question, not a
  // firm parse_error (two-terminal-states). Flag-off ⇒ this block is inert.
  const einvoiceReceiveActs = clientFlagActs({
    flagKey: FINLAND_EINVOICE_RECEIVE_FLAG_KEY,
    snapshot: configSnapshot,
    envFallback: () => false
  });
  if (einvoiceReceiveActs) {
    const received = receiveEInvoiceDocument({ bytes });
    if (received.lane === 'proposal') {
      await onProgress?.({ current: 1, total: 1 });
      const linesEnabled = isDocumentLinesEnabled({ configSnapshot });
      const lines = linesEnabled && Array.isArray(received.extraction.lines) ? received.extraction.lines : [];
      const summary = { ...received.extraction.summary };
      summary.line_count = lines.length;
      return {
        kind: 'completed_header',
        summary,
        header: received.extraction.header,
        lines,
        // The XML content is the authoritative classification — ride the same
        // strong-decision override the unified extractor uses so a mis-typed
        // upload (e.g. 'receipt') still writes document_type='supplier_bill'.
        // The completed_header write path re-attributes the receipt to this
        // lane (summary.einvoice) — no model ran and the receipt says so.
        model_document_type: 'supplier_bill'
      };
    }
    if (received.lane === 'escalate') {
      return {
        kind: 'einvoice_escalated',
        format: received.format,
        escalation: received.escalation,
        summary: received.summary
      };
    }
    // lane === 'not_einvoice' → fall through to the existing pipeline.
  }

  // RT-12 (decision D1) — the unified strong-model call is the APPLIANCE
  // DEFAULT for every reconcilable type: one call that classifies AND
  // extracts, the model's document_type trusted downstream (see
  // docs/donna-llm-trust-strategy.md §3 Slice B). The cloud keeps the
  // per-type path for ONE release; `unifiedExtractorServes` says which and
  // why, and the receipt carries the reason. The DOCUMENT_EXTRACTORS_ENABLED
  // wave gate still governs (a kill switch the plane seeds 'auto').
  //
  // Failure semantics this release: a RETRYABLE unified failure (429 / 5xx /
  // timeout / network) throws so the queue retries the same call — falling
  // through to a per-type extractor on the same provider would double the
  // spend on an outage and hide the retry from the receipt. A FINAL unified
  // outcome (unreadable, rejected, schema-invalid, no key) falls through to
  // the per-type extractor, receipted on parse_summary.extractor
  // (fallback_used / fallback_reason), after the partial header the model
  // DID return is persisted (F-12). The deletion PR removes the fall-through.
  const serves = unifiedExtractorServes({ documentType });
  if (trace) {
    trace.unified = {
      unified_default: serves.unified,
      unified_default_reason: serves.reason,
      attempted: false,
      provider: null,
      model: null,
      model_source: null,
      prompt_version: UNIFIED_EXTRACTOR_PROMPT_VERSION,
      failure: null,
      partial_header: null
    };
  }
  if (serves.unified && isDocumentExtractorsEnabled({ configSnapshot })) {
    await onProgress?.({ current: 0, total: 1 });
    let unified;
    try {
      unified = await extractUnifiedImpl({
        base64: bytes.toString('base64'),
        filename,
        mimeType,
        documentType,
        documentId: document.id,
        dateFormatHint,
        clientIdentity,
        priorCorrections
      });
    } catch (error) {
      if (isProviderSpendLimit(error)) throw error;
      // The extractor maps every transport outcome to its envelope; a throw
      // here is a programming error in this process, not a provider verdict.
      console.error('[unifiedExtractor] threw', {
        documentId: document.id,
        documentType,
        error: error?.message || String(error)
      });
      unified = { kind: 'failed', code: 'DOCUMENT_EXTRACTION_FAILED', reason: 'unified_extractor_threw', retryable: false };
    }
    if (trace?.unified) {
      Object.assign(trace.unified, {
        attempted: true,
        provider: unified?.provider || null,
        model: unified?.model || null,
        model_source: unified?.model_source || null,
        prompt_version: unified?.prompt_version || UNIFIED_EXTRACTOR_PROMPT_VERSION,
        failure: unified?.kind === 'failed' ? { code: unified.code || null, reason: unified.reason || null } : null,
        partial_header: unified?.partial_header || null
      });
    }
    if (unified?.kind === 'completed_header') {
      await onProgress?.({ current: 1, total: 1 });

      const linesEnabled = isDocumentLinesEnabled({ configSnapshot });
      const lines = linesEnabled && Array.isArray(unified.lines) ? unified.lines : [];
      const summary = { ...unified.summary };

      // Pin line_count to what we'll actually write; arithmetic
      // invariants are NOT intelligence-substituting scaffolding,
      // they stay.
      summary.line_count = lines.length;
      if (!Number.isInteger(summary.coded_line_count)) summary.coded_line_count = 0;
      if (!Number.isInteger(summary.review_line_count)) summary.review_line_count = 0;
      summary.document_type = unified.document_type;

      // System-correctness check — flag amount_mismatch when
      // subtotal+tax+modifiers ≠ total. Mirrors the receipt branch
      // below. Runs across all four pilot types when lines exist.
      if (linesEnabled && lines.length > 0) {
        const validation = validateReceiptTotals({ summary, lines });
        // RT-04 (F-05): persist the receipt — expected / total / drift /
        // strategy — not just the boolean. The post-repair validation
        // pass in handleParseEvent re-judges the same formula on the
        // final header and supersedes this copy.
        summary.totals_validation = validation;
        if (!validation.matches) {
          summary.warnings = Array.isArray(summary.warnings) ? [...summary.warnings] : [];
          if (!summary.warnings.includes('amount_mismatch')) {
            summary.warnings.push('amount_mismatch');
          }
          summary.review_line_count = lines.length;
        }
      }

      // issued_receipt coercion — same rule as the per-type branch:
      // an issued_receipt is "paid by construction"; the model's
      // 'unpaid' / 'unknown' defaults get overridden.
      if (unified.document_type === 'issued_receipt') {
        const current = unified.header?.payment_status;
        if (!current || current === 'unpaid' || current === 'unknown') {
          unified.header.payment_status = 'paid';
        }
      }

      return {
        kind: 'completed_header',
        summary,
        header: unified.header,
        lines,
        // The strong model's classification, surfaced so the worker
        // can write it to documents.document_type. Only the unified
        // branch sets this — type-specific extractors echo the
        // dispatched type, which is not a decision.
        model_document_type: unified.document_type,
        // The PROVIDER-RETURNED unified model id (Slice-B extractor
        // receipt). Only the unified branch sets this; the worker reads
        // it into parse_summary.extractor.model.
        extractor_model: unified.model || null,
        extractor_provider: unified.provider || null
      };
    }
    // A read the model could not finish still carries the header it DID
    // return: persist it now, before any fall-through, so the row keeps it
    // whether the per-type extractor completes or the parse rests failed.
    if (unified?.partial_header && typeof onPartialHeader === 'function') {
      try {
        await onPartialHeader({
          ...unified.partial_header,
          provider: unified.provider || null,
          model: unified.model || null,
          model_source: unified.model_source || null,
          prompt_version: unified.prompt_version || UNIFIED_EXTRACTOR_PROMPT_VERSION,
          code: unified.code || null,
          reason: unified.reason || null
        });
      } catch (persistError) {
        log?.warn?.('parse-document: partial header persist failed (continuing)', {
          documentId: document.id,
          error: persistError?.message || String(persistError)
        });
      }
    }
    if (unified?.kind === 'failed' && unified.retryable) {
      // The queue's to retry (RT-08): same call, same provider, receipted
      // attempts — never a silent second extractor on an outage.
      throw new ParseError(unified.code || 'DOCUMENT_EXTRACTION_FAILED', {
        message: `Unified extraction failed: ${unified.reason || unified.code}`,
        provider: unified.provider || 'unified',
        retryable: true,
        reason: unified.reason || null,
        model: unified.model || null
      });
    }
    if (unified?.kind === 'failed') {
      console.warn('[unifiedExtractor] final failure — falling through to the type-specific extractor (one release)', {
        documentId: document.id,
        documentType,
        provider: unified.provider || null,
        code: unified.code,
        reason: unified.reason
      });
    }
  }

  const extractor = pickExtractorImpl(documentType, { configSnapshot });
  if (!extractor) {
    // No extractor wired up for this document type — either
    // genuinely unsupported (e.g. unknown_document), or the
    // DOCUMENT_EXTRACTORS_ENABLED kill switch is off and this is a
    // type behind it (e.g. receipt). Mark `skipped` (not `failed`)
    // so the firm still sees the file, but we don't produce phantom
    // header fields.
    return {
      kind: 'skipped',
      reason: 'extractor_unavailable',
      summary: {
        source: 'async_parse',
        document_type: documentType,
        skipped_reason: 'extractor_unavailable'
      }
    };
  }

  if (extractor.type === 'receipt') {
    // Receipt extraction. PR 1 shipped header-only; PR 2 adds
    // first-class line items + totals validation. Coding (PR 4/5)
    // and re-parse merge (PR 3) are still out of scope. Single LLM
    // call; no per-page progress.
    await onProgress?.({ current: 0, total: 1 });
    const base64 = bytes.toString('base64');
    const extraction = await extractor.extract({ base64, filename, mimeType, dateFormatHint, clientIdentity });
    await onProgress?.({ current: 1, total: 1 });

    if (extraction.kind === 'failed') {
      // Convert the extractor's discriminated-union failure into a
      // ParseError so the outer worker catch dispatches it through
      // categorizeError → markParseFailedInDb (terminal) or Inngest
      // retry (retryable). The error code is the source of truth
      // for retryability; no string-message inference involved.
      throw new ParseError(extraction.code, {
        message: `Receipt extraction failed: ${extraction.reason || extraction.code}`,
        // The provider the lane resolved (Anthropic first since 2026-11-10);
        // with no key, the provider whose key is missing (its reason reads
        // `<provider>_not_configured`, #71's wait vocabulary).
        provider: extraction.provider || null,
        reason: extraction.reason || null,
        model: extraction.model || null
      });
    }

    // Gate line writes behind DOCUMENT_LINES_ENABLED. The header
    // still lands; lines are dropped at the worker boundary so the
    // writer wipes any stale rows and inserts none. Calibration
    // gate per the runbook — flip on once a firm's line-extraction
    // quality clears ≥ 80% sane lines on a pilot batch.
    const linesEnabled = isDocumentLinesEnabled({ configSnapshot });
    const lines = linesEnabled && Array.isArray(extraction.lines) ? extraction.lines : [];

    // Totals validation (plan §"Totals validation"). Runs only when
    // we actually intend to write lines — otherwise there's nothing
    // to reconcile against. Drift > $1 → 'amount_mismatch' warning
    // and every line gets review_status='needs_review' at the
    // writer. parse_status stays 'completed' regardless: the firm
    // uploaded a usable doc.
    const summary = { ...extraction.summary };
    if (linesEnabled && lines.length > 0) {
      const validation = validateReceiptTotals({ summary, lines });
      // RT-04 (F-05): persist the receipt, not just the boolean (same
      // note as the unified branch above).
      summary.totals_validation = validation;
      if (!validation.matches) {
        summary.warnings = Array.isArray(summary.warnings) ? [...summary.warnings] : [];
        if (!summary.warnings.includes('amount_mismatch')) {
          summary.warnings.push('amount_mismatch');
        }
        // Force every line into review until the firm can eyeball
        // the mismatch. PR 3 will surface these in the review queue.
        summary.review_line_count = lines.length;
      }
    }

    // Pin line_count to the actual number we're about to write. The
    // extractor's pre-validation `summary.line_count` reflects what
    // it returned; if the flag is off, the writer drops lines and
    // the user-visible count must be 0.
    summary.line_count = lines.length;
    if (!Number.isInteger(summary.coded_line_count)) summary.coded_line_count = 0;
    if (!Number.isInteger(summary.review_line_count)) summary.review_line_count = 0;

    // Reconciliation PR 2 — receipt semantic classifier. Runs OUTSIDE
    // the writer transaction because it's an outbound HTTP call.
    // `classifyReceipt` never throws — provider failures convert to a
    // deterministic fallback `SemanticOutput`. The writer reads
    // `summary.semantic` to persist it via the existing
    // `parse_summary=$14::jsonb` path and to emit the
    // `document.classifier.completed` audit. With the flag off,
    // `summary.semantic` stays undefined and PR 3 treats that as "no
    // classifier signal".
    if (isReceiptClassifierEnabled()) {
      summary.semantic = await classifyReceipt({
        header: extraction.header,
        summary,
        lines,
        filename
      });
    }

    return {
      kind: 'completed_header',
      summary,
      header: extraction.header,
      lines,
      extractor_model: extraction.model || null,
      // response_proven / configured_fallback, as the extractor classified it.
      extractor_model_source: extraction.model_source || null,
      extractor_provider: extraction.provider || null
    };
  }

  if (extractor.type === 'supplier_bill') {
    // Supplier bill extraction. PR 6 of
    // docs/invoice-receipt-parsing-plan.md. Same writer-shape contract
    // as receipts — header + summary + lines, all going through
    // writeParsedDocumentExtractionInDb. The extractor itself adds
    // `no_lines_detected` and `amount_mismatch` to summary.warnings
    // when applicable (per the brief's "lines aren't optional" and
    // "totals validation" anchors), so the worker doesn't redo that
    // work. No receipt classifier — bills don't have one in v1.
    await onProgress?.({ current: 0, total: 1 });
    const base64 = bytes.toString('base64');
    const extraction = await extractor.extract({ base64, filename, mimeType, dateFormatHint, clientIdentity });
    await onProgress?.({ current: 1, total: 1 });

    if (extraction.kind === 'failed') {
      throw new ParseError(extraction.code, {
        message: `Supplier bill extraction failed: ${extraction.reason || extraction.code}`,
        // The provider the lane resolved (Anthropic first since 2026-11-10);
        // with no key, the provider whose key is missing (its reason reads
        // `<provider>_not_configured`, #71's wait vocabulary).
        provider: extraction.provider || null,
        reason: extraction.reason || null,
        model: extraction.model || null
      });
    }

    // Mirror the receipt branch's DOCUMENT_LINES_ENABLED gate: lines
    // get dropped at the worker boundary when the calibration flag is
    // off. The header + payment_terms still land in parse_summary so
    // the firm sees the bill metadata regardless. line_count gets
    // re-pinned to what we're actually about to write.
    const linesEnabled = isDocumentLinesEnabled({ configSnapshot });
    const lines = linesEnabled && Array.isArray(extraction.lines) ? extraction.lines : [];
    const summary = { ...extraction.summary };
    summary.line_count = lines.length;
    if (!Number.isInteger(summary.coded_line_count)) summary.coded_line_count = 0;
    if (!Number.isInteger(summary.review_line_count)) summary.review_line_count = 0;

    // When lines are present and the extractor flagged amount_mismatch,
    // force every line into review. Mirrors the receipt worker's
    // behaviour so PR 3's review queue treats both doc types the same.
    if (lines.length > 0 && Array.isArray(summary.warnings) && summary.warnings.includes('amount_mismatch')) {
      summary.review_line_count = lines.length;
    }

    return {
      kind: 'completed_header',
      summary,
      header: extraction.header,
      lines,
      extractor_model: extraction.model || null,
      // response_proven / configured_fallback, as the extractor classified it.
      extractor_model_source: extraction.model_source || null,
      extractor_provider: extraction.provider || null
    };
  }

  if (extractor.type === 'payout_statement') {
    // RT-18 — payout statement / deposit slip extraction. Same writer-shape
    // contract as supplier bills (header + summary + lines through
    // writeParsedDocumentExtractionInDb). The extractor itself runs the
    // settlement equation through validateReceiptTotals and adds
    // `amount_mismatch` (with the persisted totals receipt) when the
    // printed figures do not foot, so the worker only re-pins line_count
    // and forces the lines into review on a mismatch — the bill precedent.
    // The dispatched type rides along so one extractor serves both types.
    await onProgress?.({ current: 0, total: 1 });
    const base64 = bytes.toString('base64');
    const extraction = await extractor.extract({
      base64,
      filename,
      mimeType,
      dateFormatHint,
      clientIdentity,
      documentType,
      documentId: document.id
    });
    await onProgress?.({ current: 1, total: 1 });

    if (extraction.kind === 'failed') {
      throw new ParseError(extraction.code, {
        message: `${documentType === 'deposit_slip' ? 'Deposit slip' : 'Payout statement'} extraction failed: ${extraction.reason || extraction.code}`,
        // The provider the lane resolved (Anthropic first since 2026-11-10);
        // with no key, the provider whose key is missing (its reason reads
        // `<provider>_not_configured`, #71's wait vocabulary).
        provider: extraction.provider || null,
        reason: extraction.reason || null,
        model: extraction.model || null
      });
    }

    const linesEnabled = isDocumentLinesEnabled({ configSnapshot });
    const lines = linesEnabled && Array.isArray(extraction.lines) ? extraction.lines : [];
    const summary = { ...extraction.summary };
    summary.line_count = lines.length;
    if (!Number.isInteger(summary.coded_line_count)) summary.coded_line_count = 0;
    if (!Number.isInteger(summary.review_line_count)) summary.review_line_count = 0;
    if (lines.length > 0 && Array.isArray(summary.warnings) && summary.warnings.includes('amount_mismatch')) {
      summary.review_line_count = lines.length;
    }

    return {
      kind: 'completed_header',
      summary,
      header: extraction.header,
      lines,
      extractor_model: extraction.model || null,
      // response_proven / configured_fallback, as the extractor classified it.
      extractor_model_source: extraction.model_source || null,
      extractor_provider: extraction.provider || null
    };
  }

  if (extractor.type === 'sales_invoice' || extractor.type === 'issued_receipt') {
    // Sales invoice + issued receipt extraction. Both share the
    // sales_invoice extractor (writer-shape: header + summary + lines).
    // The direction flip (vendor_name=null, customer_name=<buyer>,
    // counterparty_role='customer') lives inside the extractor.
    //
    // The distinction between sales_invoice (unpaid AR) and
    // issued_receipt (acknowledgement of cash already received) is
    // expressed by `document_type` on the row and one downstream
    // tweak: issued_receipt rows whose LLM extraction didn't surface
    // an explicit payment_status get coerced to 'paid' — a receipt is
    // paid by construction.
    await onProgress?.({ current: 0, total: 1 });
    const base64 = bytes.toString('base64');
    const extraction = await extractor.extract({ base64, filename, mimeType, dateFormatHint, clientIdentity });
    await onProgress?.({ current: 1, total: 1 });

    if (extraction.kind === 'failed') {
      throw new ParseError(extraction.code, {
        message: `${extractor.type === 'issued_receipt' ? 'Issued receipt' : 'Sales invoice'} extraction failed: ${extraction.reason || extraction.code}`,
        // The provider the lane resolved (Anthropic first since 2026-11-10);
        // with no key, the provider whose key is missing (its reason reads
        // `<provider>_not_configured`, #71's wait vocabulary).
        provider: extraction.provider || null,
        reason: extraction.reason || null,
        model: extraction.model || null
      });
    }

    const linesEnabled = isDocumentLinesEnabled({ configSnapshot });
    const lines = linesEnabled && Array.isArray(extraction.lines) ? extraction.lines : [];
    const summary = { ...extraction.summary };
    summary.line_count = lines.length;
    if (!Number.isInteger(summary.coded_line_count)) summary.coded_line_count = 0;
    if (!Number.isInteger(summary.review_line_count)) summary.review_line_count = 0;

    if (lines.length > 0 && Array.isArray(summary.warnings) && summary.warnings.includes('amount_mismatch')) {
      summary.review_line_count = lines.length;
    }

    // issued_receipt is "paid by construction" — the document
    // acknowledges money already received. If the LLM left
    // payment_status ambiguous or marked it 'unpaid' (the
    // sales_invoice prompt's default), override to 'paid' so
    // payment_status downstream is honest. An LLM-extracted 'partial'
    // / 'void' / 'credit_note' is preserved because those reflect
    // explicit signals on the document that override the receipt
    // semantic.
    if (extractor.type === 'issued_receipt') {
      summary.document_type = 'issued_receipt';
      const current = extraction.header?.payment_status;
      if (!current || current === 'unpaid' || current === 'unknown') {
        extraction.header.payment_status = 'paid';
      }
    }

    return {
      kind: 'completed_header',
      summary,
      header: extraction.header,
      lines,
      extractor_model: extraction.model || null,
      extractor_model_source: extraction.model_source || null,
      extractor_provider: extraction.provider || null
    };
  }

  if (extractor.type === 'generic_document') {
    await onProgress?.({ current: 0, total: 1 });
    const base64 = bytes.toString('base64');
    const extraction = await extractor.extract({ base64, filename, mimeType });
    await onProgress?.({ current: 1, total: 1 });

    if (extraction.kind === 'failed') {
      throw new ParseError(extraction.code, {
        message: `Generic document extraction failed: ${extraction.reason || extraction.code}`,
        provider: extraction.provider || null,
        reason: extraction.reason || null,
        model: extraction.model || null
      });
    }

    const summary = { ...extraction.summary };
    summary.line_count = 0;
    summary.coded_line_count = 0;
    summary.review_line_count = 0;

    return {
      kind: 'completed_header',
      summary,
      header: extraction.header,
      lines: []
    };
  }

  // Bank statement path. The existing extractor is single-shot — no
  // per-page progress callback. We emit a 0/1→1/1 progress so the tray
  // shows "Reading…" with a determinate total once we know the LLM
  // returned, instead of staying indeterminate.
  await onProgress?.({ current: 0, total: 1 });
  const base64 = bytes.toString('base64');
  let extraction = await extractor.extract({
    base64,
    filename,
    mimeType,
    ledgerCurrency,
    llmFirst: isBankStatementLlmFirstEnabled({ configSnapshot }),
    ...(Number(document.parse_attempts) > 1 ? { bypassCache: true } : {})
  });
  const visionSkipped = extraction?.extraction_diagnostics?.vision_skipped;
  if (visionSkipped === 'not_configured' || visionSkipped === 'provider_fault') {
    // The statement has no text layer and cloud OCR could not be used — no
    // key, a refused key, or no credit on the account. It was never read: a
    // provider wait (parseErrors.providerWaitFor), never `skipped /
    // no_transactions_detected`, which reads as a fact about the statement.
    // The provider and the fault come from the extractor's record.
    const details = extraction.extraction_diagnostics.vision_skipped_details || {};
    const provider = details.provider || 'openai';
    const fault = visionSkipped === 'not_configured' ? 'not_configured' : details.fault;
    const unauthorized = fault === 'unauthorized';
    throw new ParseError(unauthorized ? 'DOCUMENT_EXTRACTION_UNAUTHORIZED' : 'DOCUMENT_EXTRACTION_FAILED', {
      provider,
      retryable: !unauthorized,
      reason: unauthorized ? `${provider}_${details.status === 403 ? 403 : 401}` : `${provider}_${fault}`,
      message: `Bank statement extraction failed: ${provider} ${fault} (no text layer; cloud OCR unavailable)`
    });
  }
  // Re-read the original PDF once when the text layer produced inconsistent
  // rows. Never repair amounts or weaken balance checks. Bypass failed cached
  // extractions so the existing bounded queue retry can make fresh progress.
  const recoveringValidation = extraction?.extraction_status === 'needs_review' &&
      extraction?.extraction_source !== 'openai_vision_structured' &&
      (mimeType === 'application/pdf' || /\.pdf$/i.test(filename));
  if (recoveringValidation) {
    extraction = await extractor.extract({ base64, filename, mimeType, ledgerCurrency,
      preferVision: true, bypassCache: true });
  }
  await onProgress?.({ current: 1, total: 1 });

  if (extraction?.extraction_status === 'needs_review' ||
      (recoveringValidation && extraction?.extraction_status !== 'validated')) {
    throw new ParseError('STATEMENT_VALIDATION_FAILED', {
      provider: extraction.extraction_provider || null, reason: 'statement_totals_mismatch', model: extraction.extraction_model,
      message: 'Statement extraction failed balance validation; no transactions were imported.'
    });
  }

  const candidates = Array.isArray(extraction?.transactions) ? extraction.transactions : [];
  const looksLikeStatement =
    extraction?.extraction_status === 'validated' &&
    candidates.length >= STATEMENT_TRANSACTION_THRESHOLD;

  if (!looksLikeStatement) {
    // Same heuristic the client portal used inline: a few date+amount
    // lines on a one-pager don't make a statement. Mark `skipped`
    // (not `failed`) so the firm still sees the file, but we don't
    // produce phantom transactions.
    return {
      kind: 'skipped',
      reason:
        candidates.length === 0
          ? 'no_transactions_detected'
          : 'extraction_below_statement_threshold',
      summary: {
        source: 'async_parse',
        document_type: 'bank_statement',
        transaction_count: candidates.length,
        statement_period: extraction?.period_label || null,
        statement_currency: extraction?.statement_currency || null,
        ledger_currency: extraction?.ledger_currency || null,
        currency_resolution: extraction?.currency_resolution || null,
        candidate_transaction_count: extraction?.candidate_transaction_count || 0,
        candidate_transactions: extraction?.candidate_transactions || [],
        extraction_status: extraction?.extraction_status || 'unknown',
        warnings: Array.isArray(extraction?.warnings) ? extraction.warnings.slice(0, 6) : []
      }
    };
  }

  const fingerprint = computeAccountFingerprint({
    bank_name:
      extraction?.statement_summary?.bank_name ||
      extraction?.statement_summary?.bank ||
      filename,
    account_number:
      extraction?.statement_summary?.account_number ||
      extraction?.statement_summary?.iban,
    currency: extraction?.statement_currency || ''
  });

  const transactionRows = candidates.map((tx, idx) => ({
    ...tx,
    id: tx.id || `${document.id}-tx-${idx}`,
    client_id: document.client_id,
    document_id: document.id,
    source_document_id: document.id,
    source: 'async_parse',
    status: 'needs_review'
  }));

  return {
    kind: 'completed',
    summary: buildStatementSummary(extraction, fingerprint),
    payloadPatch: buildStatementPayloadPatch(extraction),
    transactions: transactionRows,
    accountFingerprint: fingerprint,
    // Phase 2b.1 — inputs for the bank-statement jurisdiction detector,
    // consumed in the worker's success branch. Sourced the same way as
    // the account fingerprint above: bank name falls back to filename
    // (a "DBS-Jan.pdf" upload is itself a signal), currency comes from
    // the statement, the account number (or IBAN) is read off the
    // statement header, and the text snippet feeds the tax-id pattern
    // scan inside the detector (UEN / VAT / ABN / EIN / …).
    detectorInput: {
      bankName:
        extraction?.statement_summary?.bank_name ||
        extraction?.statement_summary?.bank ||
        filename,
      currency: extraction?.statement_currency || '',
      accountNumber:
        extraction?.statement_summary?.iban ||
        extraction?.statement_summary?.account_number ||
        '',
      text: extraction?.text_snippet || ''
    }
  };
};

// RT-12 — the wrapper every caller uses: runs the dispatch above with an
// attempt record and stamps it on the outcome (`result.unified_attempt`) or
// on the thrown error (`error.unified_attempt`), so buildExtractorReceipt
// can say what the unified extractor did whichever branch returned. When
// the unified read was unusable but the per-type extractor completed, the
// unified partial header rides the completed summary too — the strong
// model's read next to the one that landed is evidence, not noise.
const extractDocument = async (args = {}) => {
  const trace = { unified: null };
  let result;
  try {
    result = await extractDocumentInner({ ...args, trace });
  } catch (error) {
    if (error && typeof error === 'object' && trace.unified) error.unified_attempt = trace.unified;
    throw error;
  }
  if (result && typeof result === 'object' && trace.unified && !result.unified_attempt) {
    result.unified_attempt = trace.unified;
    if (result.kind === 'completed_header' && !result.model_document_type && trace.unified.partial_header && result.summary && typeof result.summary === 'object') {
      result.summary.partial_header = {
        ...trace.unified.partial_header,
        provider: trace.unified.provider,
        model: trace.unified.model,
        model_source: trace.unified.model_source,
        prompt_version: trace.unified.prompt_version,
        code: trace.unified.failure?.code || null,
        reason: trace.unified.failure?.reason || null
      };
    }
  }
  return result;
};

// ── Step A — 'parse-and-write' (everything through the terminal parse write) ──
// Runs as ONE step on purpose: `bytes` is a Buffer and cannot cross an
// Inngest step boundary (step output is memoized as JSON), and the
// fetch → route → extract → write chain is already internally timeboxed
// well under the 300s invocation budget (router 45s, optional context
// reads 8s, extraction 180s, intel refresh 45s). Splitting it further
// would re-fetch bytes / re-charge the OCR call per retry for no budget
// win. Inngest retries the whole step on transient throws — the same
// semantics the single-step worker had.
//
// Returns the worker's public result shape PLUS a `post_parse` plan —
// compact JSON only (ids, counts, the bounded detector input; never
// bytes or extraction payloads) — that handleParseEvent strips off and
// feeds to the post-parse leg steps below.
// The queue's attempt budget, threaded in by the local job runner (RT-08):
// `{ count, max }` from the claimed local_jobs row. Absent on the Inngest and
// inline paths, where the worker never writes the exhausted terminal itself
// (Inngest's dashboard / the drain's decision table own that there).
const attemptsExhausted = (attempt) =>
  Boolean(attempt)
  && Number.isFinite(Number(attempt.count))
  && Number.isFinite(Number(attempt.max))
  && Number(attempt.count) >= Number(attempt.max);

const runParseAndWrite = async ({ firmId, documentId, parseRunId, log, attempt = null }) => {
  // Typed claim outcome (RT-02, audit F-07): `claimed` is the thin row when
  // this run owns it; otherwise `outcome` says WHY not, and the caller (the
  // drain, Inngest, the retry script) reports it instead of a generic skip.
  const claimResult = await claimParseRunInDb({ firmId, documentId, parseRunId });
  const claim = claimResult?.claimed || null;
  if (!claim) {
    const outcome = claimResult?.outcome || 'not_pending';
    if (outcome === 'admission_refused') {
      // Entity readiness refused parse_claim. The row stays pending and now
      // carries payload.parse_hold; nothing here is a failure.
      log.warn?.('parse-document: claim refused by entity readiness', {
        firmId,
        documentId,
        parseRunId,
        reason_code: claimResult?.decision?.reason_code || null,
        receipt_id: claimResult?.hold?.receipt_id ?? null
      });
      return {
        handled: false,
        reason: 'admission_refused',
        claim_outcome: outcome,
        reason_code: claimResult?.decision?.reason_code || null,
        hold: claimResult?.hold || null,
        document_id: documentId
      };
    }
    // stale_run: a newer manual retry minted a new parse_run_id and this
    // event is stale. not_pending: the same run already moved on (terminal
    // writer or concurrent claim won). Either way, swallow — no FE effects.
    log.info?.('parse-document: no claim', {
      firmId,
      documentId,
      parseRunId,
      outcome
    });
    return { handled: false, reason: outcome, claim_outcome: outcome, document_id: documentId };
  }

  try {
    // ── fetching ──
    const bytes = await (async () => {
      try {
        return await fetchEvidenceObjectBytes({
          bucket: claim.storage_bucket,
          key: claim.storage_object_key
        });
      } catch (err) {
        throw new ParseError('STORAGE_FETCH_FAILED', {
          message: err?.message || 'Failed to fetch storage object.',
          provider: 'supabase',
          details: { bucket: claim.storage_bucket, key: claim.storage_object_key }
        });
      }
    })();

    // Verify checksum against fetched bytes. Client-supplied checksum
    // is a UX optimisation; the worker can't trust it. A mismatch is
    // retryable — could be a re-upload race; Inngest backoff lets a
    // settled re-upload land before we try again.
    if (claim.checksum_sha256) {
      const actual = sha256Hex(bytes);
      if (actual !== claim.checksum_sha256) {
        throw new ParseError('CHECKSUM_MISMATCH', {
          message: 'Stored bytes do not match registered checksum.',
          details: { expected: claim.checksum_sha256, actual }
        });
      }
    }

    // ── routing ──
    // Runs whenever DOCUMENT_ROUTER_ENABLED acts. The router's output
    // becomes authoritative for extractor dispatch when:
    //   - the router returned `routed: true` with a recommended extractor,
    //   - `confidence >= DOCUMENT_ROUTER_MIN_CONFIDENCE` (default 0.65), AND
    //   - neither blast-radius guard in __buildClassification fires.
    // Below the threshold, or when a guard holds, the request-body type
    // survives but the router output is captured in
    // `summary.classification` for audit. There is no shadow gate and no
    // per-family promotion any more (RT-05, decision D6).
    let routerResult = null;
    const originalDocumentType = claim.document_type || 'unknown';
    const minConfidence = documentRouterMinConfidence();

    // Client identity is loaded once per parse and reused for BOTH
    // the router's direction inference AND the extractor's firm-side
    // anchor prompt. Soft-fail — if the read throws or returns null,
    // the router falls back to direction='unknown' (preserving the
    // request-body type) and the extractor falls back to the
    // un-anchored prompt. Strictly an improvement when present;
    // never a regression when absent.
    let clientIdentity = null;
    try {
      clientIdentity = await withTimeout(
        getExtractionContextInDb({
          firmId,
          clientId: claim.client_id
        }),
        OPTIONAL_CONTEXT_READ_TIMEOUT_MS,
        'client identity read'
      );
    } catch (identityErr) {
      log.warn?.('parse-document: client identity read failed (soft-degrade)', {
        documentId,
        clientId: claim.client_id,
        error: identityErr?.message || String(identityErr)
      });
    }

    // 0A.9 + batch-2 — resolve the per-client config control plane snapshot
    // ONCE for this parse run (firmId + claim.client_id in scope). Read ABOVE
    // the routing block so ONE snapshot feeds, in order: the router's
    // enabled gate, the perception-downgrade guard's extractor probe, the
    // unified-extractor routing gate (extractDocument), and the extractor-path
    // receipt (buildExtractorReceipt) — all gates in a run read the SAME
    // verdict and can never disagree (#760 invariant). This read is
    // REQUIRED: the desktop's plane-native extractor flags intentionally
    // have no env fallback, so degrading a pool timeout to `{}` would turn a
    // supported bill into a false `extractor_unavailable` skip.
    const configSnapshot = await loadRequiredConfigSnapshot({
      load: () => readClientConfigSnapshotInDb({ firmId, clientId: claim.client_id })
    });

    if (isDocumentRouterEnabled({ configSnapshot })) {
      try {
        const mimeType = claim.payload?.mime_type || claim.payload?.file_storage?.mime_type || '';
        routerResult = await withTimeout(
          routeDocument({
            base64: bytes.toString('base64'),
            filename: claim.filename || claim.id,
            mimeType,
            clientIdentity
          }),
          ROUTER_CLASSIFY_TIMEOUT_MS,
          'document router classify'
        );
        if (routerResult?.routed) {
          log.info?.('parse-document: router classified document', {
            documentId,
            family: routerResult.family,
            confidence: routerResult.confidence,
            direction_hint: routerResult.direction_hint,
            recommended_extractor: routerResult.recommended_extractor,
            current_type: originalDocumentType,
            min_confidence: minConfidence
          });
        } else if (routerResult) {
          log.info?.('parse-document: router did not classify', {
            documentId,
            reason: routerResult.reason || 'unknown'
          });
        }
      } catch (routerErr) {
        if (isProviderSpendLimit(routerErr)) throw routerErr;
        // Treat any synchronous throw the same as a `routed: false`
        // result so the classification audit captures the failure
        // and the parse continues with the request-body type.
        routerResult = { routed: false, reason: 'llm_error' };
        log.warn?.('parse-document: router failed (soft-degrade)', {
          documentId,
          error: routerErr?.message || String(routerErr)
        });
      }
    }

    const { classification, finalType: effectiveDocumentType } = __buildClassification({
      routerResult,
      originalType: originalDocumentType,
      minConfidence,
      // The router result carries the model that actually ran —
      // re-deriving it here from env (with a hardcoded fallback)
      // produced a receipt that lies whenever the router's resolved
      // model differs (CLAUDE.md: the model id is part of the receipt).
      routerModel: routerResult?.routed ? (routerResult.model || null) : null,
      // Batch-2 Slice B — thread the run's config snapshot into the
      // perception-downgrade guard's dedicated-extractor probe, so the
      // guard's view of "which types have a dedicated extractor" matches
      // the routing gate when a DB row (not env) drives the wave.
      pickExtractorImpl: (type) => pickExtractor(type, { configSnapshot })
    });

    if (classification.fallback_reason === 'perception_downgrade') {
      log.info?.('parse-document: router override suppressed (perception downgrade)', {
        documentId,
        original_type: originalDocumentType,
        router_type: classification.suppressed_type,
        confidence: classification.confidence
      });
    }

    // Direction (the AP/AR/internal axis) is denormalized onto the
    // documents row at the header write below — derived from the
    // FINAL type, which the unified extractor may still correct
    // after extraction, so it can't be computed here.
    if (effectiveDocumentType !== originalDocumentType) {
      log.info?.('parse-document: router override applied', {
        documentId,
        original_type: originalDocumentType,
        final_type: effectiveDocumentType,
        confidence: classification.confidence
      });
      claim.document_type = effectiveDocumentType;
    }

    // ── extracting ──
    // Locale-aware date hint for the extractor prompts. Reads the
    // the persisted client context already read for the router. Country and
    // book currency are separate facts; neither inherits from the firm or file.
    // Missing context leaves evidence intake available without a country hint.
    const dateFormatHint = dateFormatHintFor(clientIdentity?.jurisdiction);
    const ledgerCurrency = clientIdentity?.ledger_currency || '';

    // Slice C — load the firm's recent corrections so the unified
    // extractor can use them as few-shot. Soft-fail: a missing
    // table (pre-027 environments) or a slow query degrades to
    // priorCorrections=null and the un-augmented prompt — strictly
    // an improvement when present, never a regression when absent.
    let priorCorrections = null;
    try {
      // DMEM-R1 W1 (INV-12, audit F-07): the read is scoped to THIS legal
      // entity, the routed class, and the document's own lineage — never the
      // firm's whole history. Without a client the read returns nothing.
      priorCorrections = await withTimeout(
        getRecentFirmCorrectionsFromDb({
          firmId,
          clientId: claim.client_id || null,
          documentType: effectiveDocumentType && effectiveDocumentType !== 'unknown' ? effectiveDocumentType : null,
          lineage: { documentId, duplicateOf: claim.duplicate_of || null },
          limit: 20
        }),
        OPTIONAL_CONTEXT_READ_TIMEOUT_MS,
        'prior corrections read'
      );
    } catch (correctionsErr) {
      log.warn?.('parse-document: prior corrections read failed (soft-degrade)', {
        documentId,
        error: correctionsErr?.message || String(correctionsErr)
      });
    }

    await setParseStageInDb({ firmId, documentId, parseRunId, stage: 'extracting' });
    // Timeboxed (EXTRACTION_TIMEOUT_MS) so a hung provider fails fast and
    // retryable rather than stalling to the 300s ceiling + STUCK reap. No
    // call-site try/catch on purpose: the timeout MUST propagate to the
    // outer catch (→ OCR_TIMEOUT, retryable), not degrade to null — there is
    // no sensible "extraction = null" fallback. A late-completing extraction
    // after the race is abandoned; its writes are parse_run_id-gated, and its
    // onProgress updates are cosmetic, so a discarded run is harmless.
    const result = await withTimeout(
      extractDocument({
        document: claim,
        bytes,
        log,
        dateFormatHint,
        ledgerCurrency,
        configSnapshot,
        // clientIdentity may already have been loaded for the router
        // (see the `routing` block above). Reuse it; if the router was
        // disabled, the variable is null and the extractors fall back
        // to the un-anchored prompt — strictly an improvement, never a
        // regression.
        clientIdentity,
        priorCorrections,
        onProgress: ({ current, total }) =>
          setParseProgressInDb({
            firmId,
            documentId,
            parseRunId,
            current,
            total
          }),
        // RT-12 (F-12): the header the unified model DID return on an
        // unusable read lands on parse_summary.partial_header, gated by this
        // run id, before the parse either falls through or rests failed.
        onPartialHeader: (partial) =>
          persistPartialHeaderInDb({ firmId, documentId, parseRunId, partial })
      }),
      EXTRACTION_TIMEOUT_MS,
      'document extraction'
    );

    if (result.kind === 'skipped') {
      // Pass the extractor's summary through to the DB so context
      // like `vision_skipped='timeout'`, transaction_count, warnings,
      // statement_period, and statement_currency survive into
      // `documents.parse_summary`. Without this the skipped row was
      // flattened to just `{reason, document_type}` — the firm-side
      // tray then had no signal beyond "skipped" for triage.
      //
      // `classification` rides along so the router's receipt survives
      // the SKIP case too — the completed paths persist it via
      // result.summary.classification below, and a skipped row is
      // exactly where triage needs "why does this doc have this type"
      // (a router_error fallback that terminal-skipped as `unknown`
      // was previously unprovable from the DB).
      await markParseSkippedInDb({
        firmId,
        documentId,
        parseRunId,
        reason: result.reason || 'unsupported_document_type',
        summary: { ...(result.summary || {}), classification }
      });
      return {
        handled: true,
        outcome: 'skipped',
        reason: result.reason,
        document_id: documentId
      };
    }

    if (result.kind === 'einvoice_escalated') {
      // FI-9 (R) — a RECOGNISED e-invoice whose numbers don't foot (or whose
      // fields wouldn't normalise). Two-terminal-states: the OWNER ask is the
      // terminal state, so mint it FIRST — createClientEvidenceRequestWithClient
      // dedups on an open ask per document_id, so an Inngest retry after a
      // partial failure re-uses the same ask instead of double-asking. Then the
      // parse is marked skipped with the persisted einvoice verdict
      // (summary.einvoice.terminal='escalate'), never a bare parse_error the
      // firm has to triage.
      await createClientEvidenceRequestInDb({
        firmId,
        clientId: claim.client_id,
        documentId,
        question: result.escalation?.question || 'We received an e-invoice we could not read — can you check the file?',
        evidenceType: 'supporting_document',
        actorId: 'system',
        returnSnapshot: false
      });
      await markParseSkippedInDb({
        firmId,
        documentId,
        parseRunId,
        reason: 'einvoice_escalated',
        // Same rule as the plain-skip path above: the classification
        // receipt survives every terminal skip.
        summary: { ...(result.summary || {}), classification }
      });
      log.info?.('parse-document: e-invoice escalated to owner', {
        documentId,
        format: result.format,
        reason: result.escalation?.reason
      });
      return {
        handled: true,
        outcome: 'einvoice_escalated',
        reason: result.escalation?.reason,
        document_id: documentId
      };
    }

    if (result.kind === 'completed_header') {
      // Receipt extraction path (PR 1 + PR 2 of
      // docs/invoice-receipt-parsing-plan.md). Single transactional
      // write — the helper sets header fields, parse_status,
      // parse_summary, parse_completed_at, and (PR 2)
      // document_lines in one go, all gated by parse_run_id. No
      // transaction-intel refresh and no duplicate detection.
      //
      // Unified type decision FIRST — repair, validation, and the
      // header write below all key on the document type, so the
      // strong model's classification must be applied before any of
      // them run. See __applyUnifiedTypeDecision for the contract.
      const unifiedDecision = __applyUnifiedTypeDecision({
        classification,
        finalType: effectiveDocumentType,
        modelDocumentType: result.model_document_type || null
      });
      const finalDocumentType = unifiedDecision.finalType;
      const finalDirection = directionForDocumentType(finalDocumentType);
      if (finalDocumentType !== claim.document_type) {
        log.info?.('parse-document: unified extractor type decision overrides router', {
          documentId,
          routed_type: claim.document_type,
          unified_type: finalDocumentType,
          router_confidence: classification.confidence
        });
        claim.document_type = finalDocumentType;
      }
      const filename = claim.filename || claim.id;
      applyPostExtractionEnrichment({
        header: result.header,
        summary: result.summary,
        filename
      });
      await repairMissingFields({
        base64: bytes.toString('base64'),
        filename,
        mimeType: claim.payload?.mime_type || claim.payload?.file_storage?.mime_type || '',
        header: result.header,
        summary: result.summary,
        documentType: claim.document_type,
        configSnapshot
      });
      const validationOutcomes = validateDocument({
        documentType: claim.document_type,
        header: result.header,
        summary: result.summary,
        lines: result.lines || []
      });
      result.summary.validation_outcomes = validationOutcomes;
      // Slice-B Step 0 — stamp the extractor-path receipt. Keyed on the
      // ORIGINAL claim type (what extractDocument's unified gate checked),
      // not the post-decision finalDocumentType.
      //
      // FI-9 (R): the e-invoice lane sets model_document_type (to ride the
      // strong-decision type override) but NO model ran — buildExtractorReceipt
      // would misread that marker as "unified ran" and stamp path:'unified',
      // model:null. The receipt must say what actually happened (the model id —
      // and its absence — is part of the receipt), so the deterministic lane
      // stamps its own.
      result.summary.extractor = result.summary?.einvoice
        ? { path: 'einvoice_receive', provider: null, model: null, model_source: null, prompt_version: null, unified_default: false, fallback_used: false, fallback_reason: null }
        : buildExtractorReceipt({
            documentType: claim.document_type,
            result
          });
      if (result.summary?.einvoice && String(unifiedDecision.classification?.final_type_source || '').startsWith('unified_extractor')) {
        // Same honesty for the type decision's provenance: the override came
        // from reading the XML, not from the unified extractor.
        unifiedDecision.classification.final_type_source = 'einvoice_receive';
      }
      const legacyWarnings = outcomesToLegacyWarnings(validationOutcomes);
      if (!Array.isArray(result.summary.warnings)) result.summary.warnings = [];
      for (const w of legacyWarnings) {
        if (!result.summary.warnings.includes(w)) result.summary.warnings.push(w);
      }
      // RT-04 (F-05): the post-repair totals verdict is the receipt of
      // record — same formula as the extractor-time copy, but this one saw
      // the repaired header. It is what the review-row writer copies next
      // to reason_details. When the validators held no opinion, the
      // extractor-time receipt (if any) stands.
      const totalsReceipt = totalsReceiptFromOutcomes(validationOutcomes);
      if (totalsReceipt) result.summary.totals_validation = totalsReceipt;
      if (routerResult?.routed) {
        result.summary.router = {
          family: routerResult.family,
          confidence: routerResult.confidence,
          direction_hint: routerResult.direction_hint,
          recommended_extractor: routerResult.recommended_extractor,
          candidate_families: routerResult.candidate_families,
          language_hint: routerResult.language_hint,
          reason: routerResult.reason,
          confidence_envelope: calibrate(routerResult.confidence, {
            model: routerResult.model || 'unknown',
            source: 'router'
          })
        };
      }
      // Classification audit — always present, even when the router
      // was disabled (in which case source='user_hint',
      // fallback_used=true, fallback_reason='router_disabled'). This
      // is the durable record of why the document has the type it
      // does; downstream investigations (Why is this bill classified
      // as a receipt?) start here. Carries the unified decision's
      // final_type_source / router_final_type fields when the
      // unified extractor ran.
      result.summary.classification = unifiedDecision.classification;
      await setParseStageInDb({ firmId, documentId, parseRunId, stage: 'writing' });
      const writeOutcome = await writeParsedDocumentExtractionInDb({
        firmId,
        documentId,
        parseRunId,
        header: result.header,
        summary: result.summary,
        lines: result.lines || [],
        documentType: finalDocumentType,
        direction: finalDirection
      });
      if (!writeOutcome.handled) {
        // Row moved to a different parse_run_id since we started.
        // Same outcome the bank-statement worker gets when its
        // markParseCompletedInDb returns null — log and exit; the
        // newer run owns the write.
        log.info?.('parse-document: header write skipped (stale parse_run_id)', {
          documentId,
          parseRunId,
          reason: writeOutcome.reason
        });
        return {
          handled: false,
          reason: writeOutcome.reason,
          document_id: documentId
        };
      }

      // Post-parse legs (evidence-reply recode resume + owner summary)
      // run as their OWN steps in handleParseEvent. The type-scoped
      // matcher already ran in the transactional writer; a second
      // client-wide scan here would duplicate the whole-book work.
      return {
        handled: true,
        outcome: 'completed',
        document_id: documentId,
        document_type: claim.document_type,
        post_parse: {
          path: 'header',
          client_id: claim.client_id,
          document_type: claim.document_type
        }
      };
    }

    // ── duplicate detection (statements only, BEFORE any writes) ──
    // Plan v4 explicitly demands "extract → check → write" ordering:
    // we cannot upsert transactions and then roll back if a duplicate
    // is detected, because the upsert touches firm-visible state. The
    // overlap query reads from existing `parse_summary.period_start
    // _date / period_end_date` keys written by past completed parses
    // (PR 3 onward) with a fallback to parsing the legacy
    // `statement_period` string label.
    if (claim.document_type === 'bank_statement' && result.accountFingerprint) {
      const periodStart = result.summary?.period_start_date || null;
      const periodEnd = result.summary?.period_end_date || null;
      if (periodStart && periodEnd) {
        const overlap = await findOverlappingStatementInDb({
          firmId,
          clientId: claim.client_id,
          accountFingerprint: result.accountFingerprint,
          periodStart,
          periodEnd,
          excludeDocumentId: documentId
        });
        if (overlap) {
          await markParseDuplicatePendingInDb({
            firmId,
            documentId,
            parseRunId,
            duplicateOf: overlap.id,
            reason: 'period_overlap',
            existingFilename: overlap.filename,
            existingSummary: overlap.parse_summary,
            existingUploadedAt: overlap.uploaded_at
          });
          return {
            handled: true,
            outcome: 'duplicate_pending',
            document_id: documentId,
            duplicate_of: overlap.id,
            reason: 'period_overlap'
          };
        }
      }
    }

    // ── writing ──
    await setParseStageInDb({ firmId, documentId, parseRunId, stage: 'writing' });
    let writeStats = { written: 0, skipped: 0 };
    if (Array.isArray(result.transactions) && result.transactions.length) {
      writeStats = await upsertParsedTransactionsInDb({
        firmId,
        clientId: claim.client_id,
        documentId,
        transactions: result.transactions
      });
    }

    // ── enriching (soft-degrade) ──
    await setParseStageInDb({ firmId, documentId, parseRunId, stage: 'enriching' });
    try {
      await withTimeout(
        refreshTransactionIntelInDb({ firmId, clientIds: [claim.client_id] }),
        INTEL_REFRESH_TIMEOUT_MS,
        'transaction intel refresh'
      );
    } catch (enrichmentErr) {
      log.warn?.('parse-document: intel refresh failed', {
        documentId,
        error: enrichmentErr?.message || String(enrichmentErr)
      });
      result.summary = result.summary || {};
      result.summary.enrichment_warning = enrichmentErr?.message || 'Intel refresh failed.';
    }

    // ── validating (bank statements) ──
    const bsValidationOutcomes = validateDocument({
      documentType: 'bank_statement',
      summary: result.summary,
      transactions: result.transactions || []
    });
    result.summary.validation_outcomes = bsValidationOutcomes;

    // ── finalizing ──
    await setParseStageInDb({ firmId, documentId, parseRunId, stage: 'finalizing' });
    const finalSummary = {
      ...result.summary,
      transactions_written: writeStats.written,
      transactions_skipped_due_to_review_state: writeStats.skipped,
      classification: {
        ...classification,
        ...(classification.final_type !== 'bank_statement' ? { router_final_type: classification.final_type } : {}),
        final_type: 'bank_statement',
        final_type_source: 'validated_statement_extractor'
      }
    };
    await markParseCompletedInDb({
      firmId,
      documentId,
      parseRunId,
      summary: finalSummary,
      documentType: 'bank_statement',
      accountFingerprint: result.accountFingerprint || null,
      payloadPatch: result.payloadPatch || null
    });

    // Post-parse legs (evidence-reply recode resume, jurisdiction
    // signal, the order-agnostic reconciliation scan, the two
    // auto-categorizers, and the strong-model batch coder) run as
    // their OWN steps in handleParseEvent — see buildPostParseLegPlan
    // below for the gates and ordering contract. The parse is already
    // durably `completed` above, so nothing a leg does can undo it.
    return {
      handled: true,
      outcome: 'completed',
      document_id: documentId,
      transactions_written: writeStats.written,
      transactions_skipped_due_to_review_state: writeStats.skipped,
      post_parse: {
        path: 'statement',
        client_id: claim.client_id,
        document_type: 'bank_statement',
        transactions_written: writeStats.written,
        detector_input: result.detectorInput || null
      }
    };
  } catch (err) {
    const categorized = categorizeError(err);
    // A provider wait: the installation has no key for the provider this
    // document needs, or the provider could not be reached at all
    // (parseErrors.providerWaitFor). Not the document's failure, so not one
    // of its attempts: release the run with the typed hold as its persisted
    // reason (the attempt the claim counted is handed back) and report the
    // wait instead of throwing. The desktop job defers on it without spending
    // an attempt (desktop/parseDocumentJob.js); on the cloud the drain
    // re-checks a held row after PARSE_HOLD_RECHECK_SECONDS. The next claim
    // that finds the provider answering reads the document under this run id.
    const wait = providerWaitFor(categorized);
    const priorHold = claimResult?.prior_hold || null;
    if (wait && providerWaitAllowed({ wait, prior: priorHold })) {
      const hold = buildProviderWaitHold({ wait, categorized, prior: priorHold, parseRunId });
      let released = null;
      let releaseThrew = false;
      try {
        released = await releaseParseRunForRetryInDb({ firmId, documentId, parseRunId, providerHold: hold });
      } catch (releaseError) {
        releaseThrew = true;
        log.error?.('parse-document: provider-wait release failed; the ordinary retry path keeps the run', {
          documentId,
          parseRunId,
          error: releaseError?.message || String(releaseError)
        });
      }
      if (released) {
        log.warn?.('parse-document: waiting for the model provider; no attempt spent', {
          documentId,
          parseRunId,
          reason_code: hold.reason_code,
          provider: hold.provider,
          key_name: hold.key_name,
          waits: hold.waits,
          code: categorized.code,
          reason: categorized.reason || null
        });
        return {
          handled: false,
          reason: 'provider_wait',
          claim_outcome: 'provider_wait',
          reason_code: hold.reason_code,
          hold,
          document_id: documentId
        };
      }
      if (!releaseThrew) {
        // The row is no longer this run's `processing` (a newer manual run,
        // or a terminal writer won): nothing of ours to hold.
        return { handled: false, reason: 'not_pending', claim_outcome: 'not_pending', document_id: documentId };
      }
    }
    if (categorized.retryable) {
      // `processing` is exclusive ownership. Release this exact run before
      // throwing so Inngest's next attempt can claim it from pending; a
      // duplicate delivery arriving while this attempt is active cannot join
      // the work. The compare-and-set writer refuses a superseded/terminal
      // row, so this cannot move a newer run backwards.
      try {
        await releaseParseRunForRetryInDb({ firmId, documentId, parseRunId });
      } catch (releaseError) {
        // Preserve the original provider/storage failure for Inngest. If the
        // release itself fails, the stuck-run sweeper remains the recovery
        // path and this log makes that degraded hand-off observable.
        log.error?.('parse-document: retry release failed', {
          documentId,
          parseRunId,
          error: releaseError?.message || String(releaseError)
        });
      }
      // RT-08 — the exhausted-attempts branch. On the local queue this was
      // the LAST attempt: the released row would rest `pending` with no job
      // left to claim it — the exact limbo F-02 named. So the worker writes
      // the honest terminal here, through RT-02's status-fenced writer
      // (pending|processing, this run id): retryable:false, the spent budget
      // in the copy, and a MANUAL owner so the row rests on the human with
      // the retry button, never on nobody. The throw still follows — the
      // queue dead-letters the job, which is the receipt of the spent budget.
      if (attemptsExhausted(attempt)) {
        const exhausted = {
          ...parseRetriesExhaustedEnvelope(categorized, { attempts: attempt.count, maxAttempts: attempt.max }),
          retry_owner: 'manual'
        };
        try {
          await markParseFailedInDb({ firmId, documentId, parseRunId, parseError: exhausted });
        } catch (markErr) {
          log.error?.('parse-document: exhausted-attempts terminal write failed; the stuck-run sweep is the recovery path', {
            documentId,
            parseRunId,
            error: markErr?.message || String(markErr)
          });
        }
        log.error?.('parse-document: automatic attempts exhausted; row rests terminal on the human', {
          documentId,
          parseRunId,
          code: categorized.code,
          provider: categorized.provider,
          attempts: attempt.count,
          max_attempts: attempt.max,
          internal_message: categorized.message
        });
        throw err;
      }
      log.warn?.('parse-document: retryable error, throwing for the queue backoff', {
        documentId,
        parseRunId,
        code: categorized.code,
        provider: categorized.provider,
        internal_message: categorized.message,
        ...(attempt ? { attempts: attempt.count, max_attempts: attempt.max } : {})
      });
      throw err;
    }

    log.error?.('parse-document: terminal failure', {
      documentId,
      parseRunId,
      code: categorized.code,
      provider: categorized.provider,
      internal_message: categorized.message
    });

    await markParseFailedInDb({
      firmId,
      documentId,
      parseRunId,
      parseError: {
        code: categorized.code,
        safe_user_message: categorized.safe_user_message,
        retryable: categorized.retryable,
        provider: categorized.provider,
        occurred_at: categorized.occurred_at,
        ...(categorized.reason ? { reason: categorized.reason } : {}),
        ...(categorized.model ? { model: categorized.model } : {}),
        // A terminal class with a designated human owner (a credential
        // failure) names it; every other terminal envelope stays byte-identical.
        ...(categorized.retry_owner ? { retry_owner: categorized.retry_owner } : {})
        // NB: `message` (internal) deliberately not surfaced here —
        // parse_error is FE-visible and may otherwise leak document
        // text / provider response bodies pulled into err.message.
      }
    });

    return {
      handled: true,
      outcome: 'failed',
      document_id: documentId,
      code: categorized.code
    };
  }
};

// ── Post-parse legs (steps B1…Bn) ─────────────────────────────────────
// Each leg that used to run as an untimeboxed fire-once try/catch tail
// inside the single worker step is now its OWN `step.run`, consuming
// only step A's compact `post_parse` JSON. On the Inngest path each leg
// gets its own invocation budget and its own retry/backoff, and Inngest
// memoizes completed steps — a killed coder leg retries alone instead
// of losing (and re-running) the whole parse. That tail death was the
// §1 convergence-incident mechanism; see
// docs/diagnostic-2026-07-04-parse-cron-504-saturation.md §4.
//
// Failure semantics (deliberate change): on the Inngest path a leg
// throw propagates — Inngest retries the leg, and retry exhaustion
// marks the run failed in the dashboard while `parse_status` stays
// `completed` (legs never touch it). Silence was the incident's
// enabler; losing it is the point. On the INLINE drain path
// (`runParseInline`) the historical per-leg soft-degrade is preserved,
// so drain behavior is byte-identical to the single-step worker. The
// coding_convergence cron (#753) stays as the belt-and-braces re-drive
// net either way.
//
// LOCKSTEP (pinned by parseDocumentStepSplit.test.js): every post-parse
// leg writer is called ONLY from the runner registry below — adding a
// new post-parse call inside runParseAndWrite (outside a step) is the
// regression the test forbids.

export const buildPostParseLegPlan = (postParse) => {
  if (!postParse || !postParse.path) return [];
  if (postParse.path === 'header') {
    // Header documents already run their TYPE-SCOPED matcher in
    // writeParsedDocumentExtractionInDb. Running the client-wide bank-
    // statement scan again here made every receipt re-match the whole book
    // (39 remote calls on the Honeybee sample) after its own match had
    // already run. Keep only the anchored evidence resume + owner summary.
    return [
      {
        name: 'evidence-recode',
        retrySafe: true,
        failMessage: 'parse-document: evidence reply recode after header parse failed (soft-degrade)'
      },
      {
        name: 'owner-media-summary',
        retrySafe: true,
        failMessage: 'parse-document: owner media summary failed (soft-degrade)'
      }
    ];
  }
  // Statement path. Same recode-first ordering contract as above; the
  // scan, categorizers, and coder only fire when the parse actually
  // wrote transactions (writeStats.written > 0 — unchanged gate).
  // `retrySafe` is each leg's declared retry contract, carried into the
  // failure receipt (every current runner is idempotent across retries —
  // see the per-runner notes in POST_PARSE_LEG_RUNNERS). A new leg must
  // declare its own.
  const legs = [
    {
      name: 'evidence-recode',
      retrySafe: true,
      failMessage: 'parse-document: evidence reply recode after parse failed (soft-degrade)'
    }
  ];
  if (postParse.document_type === 'bank_statement') {
    legs.push({
      name: 'jurisdiction-signal',
      retrySafe: true,
      failMessage: 'parse-document: jurisdiction detection failed (soft-degrade)'
    });
  }
  if ((postParse.transactions_written || 0) > 0) {
    legs.push({
      name: 'reconciliation-scan',
      retrySafe: true,
      failMessage: 'parse-document: bank-statement reconciliation failed (soft-degrade)'
    });
    legs.push({
      name: 'auto-categorize-matched',
      retrySafe: true,
      failMessage: 'parse-document: auto-categorize failed (soft-degrade)'
    });
    legs.push({
      name: 'auto-categorize-unmatched',
      retrySafe: true,
      failMessage: 'parse-document: auto-categorize-unmatched failed (soft-degrade)'
    });
    // Kill switch unchanged: AUTO_AI_CODING_ENABLED='0' disables the
    // strong-model batch coder leg (defaults on).
    if (String(process.env.AUTO_AI_CODING_ENABLED ?? '1') !== '0') {
      legs.push({
        name: 'ai-coding',
        retrySafe: true,
        failMessage: 'parse-document: auto AI coding failed (soft-degrade)'
      });
    }
  }
  legs.push({
    name: 'owner-media-summary',
    retrySafe: true,
    failMessage: 'parse-document: owner media summary failed (soft-degrade)'
  });
  return legs;
};

// Leg runners return compact JSON receipts (step outputs are memoized)
// — never raw writer results.
const POST_PARSE_LEG_RUNNERS = {
  // Evidence-reply recode RESUME. A client answer that uploads the
  // requested document runs the reply-recode synchronously at reply
  // time — BEFORE this async parse finished — so it saw no extracted
  // content and could not settle the line (the stranded "Shopify
  // settlement" case). Now that the doc is parsed, re-run the recode
  // for the anchored transaction (documents.transaction_id +
  // evidence_request_id make the doc↔line match CERTAIN — no fuzzy
  // scoring) so the client's answer actually reconciles the line: an
  // auto_matched doc↔tx match at confidence 1.0, posted — the correct
  // auto-reconciled terminal. No-op for non-evidence docs and
  // already-settled lines; idempotent across retries.
  'evidence-recode': async ({ firmId, documentId, postParse, log }) => {
    const resumed = await resumeEvidenceRecodeAfterParseInDb({ firmId, documentId });
    if (resumed?.applied) {
      log.info?.(
        postParse.path === 'header'
          ? 'parse-document: evidence reply recode applied after header parse'
          : 'parse-document: evidence reply recode applied after parse',
        {
          documentId,
          transactionId: resumed.transactionId,
          posted: resumed.posted === true
        }
      );
    }
    return { applied: resumed?.applied === true };
  },
  // Phase 2b.1 — bank-statement jurisdiction detector. Records any
  // inference as a server-side signal (jurisdiction_detected + the
  // jurisdiction_signals ring buffer). The recorder is idempotent
  // against retries (it skips a replayed same-document/same-value
  // signal); see firmDb.js.
  'jurisdiction-signal': async ({ firmId, clientId, documentId, postParse }) => {
    const signal = buildJurisdictionSignalFromStatement(postParse.detector_input, documentId);
    if (!signal) return { recorded: false };
    await recordJurisdictionSignalInDb({ firmId, clientId, signal });
    return { recorded: true };
  },
  // Order-agnostic reconciliation scan — whichever side (document or
  // bank line) arrives second triggers the scan. Same matcher, same
  // BANK_STATEMENT_MATCHER_ENABLED gate as before (a no-op when
  // disabled).
  'reconciliation-scan': async ({ firmId, clientId, parseRunId }) => {
    await runReconciliationForBankStatementInDb({ firmId, clientId, parseRunId });
    return { ran: true };
  },
  // Vendor → CoA mapping over matched transactions. Runs after the
  // reconciliation scan so matches exist before accounts are assigned.
  'auto-categorize-matched': async ({ firmId, clientId }) => {
    await autoCategorizeMatchedTransactionsInDb({ firmId, clientId });
    return { ran: true };
  },
  // Bank-description patterns over transactions that didn't get a
  // document match but have recognizable vendors in the description.
  'auto-categorize-unmatched': async ({ firmId, clientId }) => {
    await autoCategorizeUnmatchedTransactionsInDb({ firmId, clientId });
    return { ran: true };
  },
  // Strong-model batch coder — the SAME coder the firm UI exposes, so a
  // fresh upload codes itself (autonomous, no manual trigger). Pool is
  // incremental (only uncoded lines) and skips confident auto-sources,
  // so retries are cheap.
  'ai-coding': async ({ firmId, clientId }) => {
    await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
    return { ran: true };
  },
  // Owner-media parse summary: the chat-side consequence line for an
  // owner-initiated Telegram photo ("Read it: Exxon, 42.17 USD, 12 Jul").
  // No-ops for every other document (typed skip reasons), born dark behind
  // OWNER_MEDIA_PARSE_SUMMARY on the config plane, exactly-once via a
  // delivery-ledger claim. Runs LAST so future enrichment can read match
  // state; the send renders the PERSISTED parse verdict only.
  'owner-media-summary': async ({ firmId, documentId }) => {
    const outcome = await sendOwnerMediaParseSummary({ firmId, documentId });
    return { sent: outcome?.sent === true, skipped: outcome?.skipped || null };
  }
};

export const runPostParseLegs = async ({
  step,
  inline,
  log,
  firmId,
  documentId,
  parseRunId,
  postParse,
  runners = POST_PARSE_LEG_RUNNERS,
  recordLegFailure = recordPostParseLegFailureInDb,
  attempt = null
}) => {
  const plan = buildPostParseLegPlan(postParse);
  const ctx = {
    firmId,
    clientId: postParse?.client_id || null,
    documentId,
    parseRunId,
    postParse,
    log
  };
  const receipts = {};
  for (const leg of plan) {
    const runner = runners[leg.name];
    if (typeof runner !== 'function') {
      throw new Error(`parse-document: no runner for post-parse leg "${leg.name}"`);
    }
    if (inline) {
      // Inline drain path: preserve the historical per-leg soft-degrade
      // (warn + continue) so drain behavior is byte-identical to the
      // single-step worker — the cron owns retry semantics there.
      try {
        receipts[leg.name] = await step.run(leg.name, () => runner(ctx));
      } catch (legErr) {
        log.warn?.(leg.failMessage, {
          documentId,
          error: legErr?.message || String(legErr)
        });
        // Durable typed receipt (2026-08-19 side-lab finding): the drain
        // only picks PENDING docs, so a leg that dies here is never
        // retried — this row is the failure's only DB trace, and what
        // lets caseHealth render the real reason instead of
        // "stuck for a reason that was not recorded". Control flow is
        // unchanged (still warn + continue); a receipt-write failure
        // degrades to the error log below — when both writes fail the DB
        // itself is usually down, and the leg failure and its receipt
        // share that fate.
        try {
          await recordLegFailure({
            firmId,
            clientId: ctx.clientId,
            documentId,
            parseRunId,
            leg: leg.name,
            retrySafe: leg.retrySafe === true,
            error: legErr?.message || String(legErr)
          });
        } catch (receiptErr) {
          log.error?.('parse-document: post-parse leg failure receipt write failed', {
            documentId,
            leg: leg.name,
            error: receiptErr?.message || String(receiptErr)
          });
        }
      }
      continue;
    }
    // Inngest / local-job path: let the throw propagate. The queue retries
    // the leg alone (earlier steps are memoized); on Inngest, retry
    // exhaustion marks the run failed in the dashboard while parse_status
    // stays completed. On the local queue (RT-08) there is no dashboard, so
    // on the FINAL attempt the durable typed receipt the inline path has
    // always written is written here too — exactly once, when no retry is
    // left — and the throw still dead-letters the job. Earlier attempts
    // write nothing: a receipt for a leg the queue is about to retry would
    // read as a failure that a later success never clears.
    try {
      receipts[leg.name] = await step.run(leg.name, () => runner(ctx));
    } catch (legErr) {
      if (attemptsExhausted(attempt)) {
        try {
          await recordLegFailure({
            firmId,
            clientId: ctx.clientId,
            documentId,
            parseRunId,
            leg: leg.name,
            retrySafe: leg.retrySafe === true,
            error: legErr?.message || String(legErr)
          });
        } catch (receiptErr) {
          log.error?.('parse-document: post-parse leg failure receipt write failed', {
            documentId,
            leg: leg.name,
            error: receiptErr?.message || String(receiptErr)
          });
        }
        log.error?.('parse-document: post-parse leg failed on the final attempt; parse stays completed, leg rests unrun', {
          documentId,
          parseRunId,
          leg: leg.name,
          attempts: attempt.count,
          max_attempts: attempt.max,
          error: legErr?.message || String(legErr)
        });
      }
      throw legErr;
    }
  }
  return receipts;
};

// The handler, exported (RT-08) so the desktop manifest can run the SAME
// function the Inngest registration below wraps — over the local durable
// step shim instead of Inngest's. `attempt` ({ count, max }) is the queue's
// attempt budget for this invocation; only the local job runner passes it
// (desktop/parseDocumentJob.js), and it changes exactly one thing: on the
// final attempt the worker writes the honest terminal (parse) or the typed
// leg-failure receipt (legs) before rethrowing. Cloud and inline callers
// pass nothing and behave as before.
export const handleParseEvent = async ({ event, step, logger, attempt = null }) => {
  const log = logger || console;
  const data = event?.data || {};
  const firmId = data.firm_id;
  const documentId = data.document_id;
  const parseRunId = data.parse_run_id;

  if (!firmId || !documentId || !parseRunId) {
    log.warn?.('parse-document: missing required event fields', { firmId, documentId, parseRunId });
    return { handled: false, reason: 'missing_event_fields' };
  }

  const stepResult = await step.run('parse-and-write', () =>
    runParseAndWrite({ firmId, documentId, parseRunId, log, attempt })
  );

  // `post_parse` is the step-boundary leg plan, not part of the
  // worker's public result — strip it before returning.
  const { post_parse: postParse, ...result } = stepResult || {};
  if (postParse) {
    await runPostParseLegs({
      step,
      inline: step?.__inline === true,
      log,
      firmId,
      documentId,
      parseRunId,
      postParse,
      attempt
    });
  }
  return result;
};

export const parseDocumentFunction = inngest.createFunction(
  {
    id: 'parse-document',
    name: 'Parse uploaded document',
    concurrency: { limit: Number(process.env.INNGEST_PARSE_CONCURRENCY || 8) },
    retries: 3,
    // The actual invocation cap is enforced by the serve execution budget
    // within api/inngest.js's 300s limit. A run-wide timeouts.finish would
    // also cancel durable retries; the obsolete `timeout` option did neither.
    triggers: [{ event: 'document/parse.requested' }]
  },
  handleParseEvent
);

// Optional helper that the API layer uses for snapshot lookup in tests
// (worker writes are async, so tests assert against DB state, not the
// returned object).
export const parseDocumentFunctions = [parseDocumentFunction];

// Re-export for tests that want to drive the handler without going
// through Inngest's runtime (the test harness builds its own `step`).
export const __test__handleParseEvent = handleParseEvent;
export const __test__extractDocument = extractDocument;
export const __test__POST_PARSE_LEG_RUNNERS = POST_PARSE_LEG_RUNNERS;

// Inline runner that drives the worker WITHOUT Inngest. Used by the
// `/documents/parse-cron?task=drain` branch so the cron itself can
// process pending docs when Inngest is unconfigured (no event key),
// not delivering (cloud outage / webhook drift), or running behind.
// The step.run shim collapses to a plain `await`, since the cron
// already owns retry semantics — failures here just leave the row
// in pending for the next tick, gated by parse_run_id so a late
// Inngest delivery can't double-process. `__inline` marks the shim so
// the post-parse legs keep their historical per-leg soft-degrade here
// instead of the Inngest path's throw-to-retry semantics (see
// runPostParseLegs).
export const runParseInline = async ({ firmId, documentId, parseRunId, logger } = {}) => {
  if (!firmId || !documentId || !parseRunId) {
    return { handled: false, reason: 'missing_event_fields' };
  }
  const fakeEvent = {
    id: parseRunId,
    name: 'document/parse.requested',
    data: { firm_id: firmId, document_id: documentId, parse_run_id: parseRunId }
  };
  const fakeStep = {
    __inline: true,
    run: async (_label, fn) => fn()
  };
  return handleParseEvent({ event: fakeEvent, step: fakeStep, logger: logger || console });
};

// Helper to send the Inngest event with the parse_run_id as the event
// id. Inngest natively dedupes by id, which is what makes outbox
// re-sends safe.
export const sendParseDocumentEvent = async ({ firmId, documentId, parseRunId, clientId, documentType }) => {
  if (!firmId || !documentId || !parseRunId) {
    throw new Error('sendParseDocumentEvent requires firm_id, document_id, parse_run_id');
  }
  await inngest.send({
    id: parseRunId,
    name: 'document/parse.requested',
    data: {
      firm_id: firmId,
      document_id: documentId,
      parse_run_id: parseRunId,
      client_id: clientId || null,
      document_type: documentType || null
    }
  });
};
