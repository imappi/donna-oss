#!/usr/bin/env node
// Proof 0 production-path adapter: the concrete solveWorldClose that
// scripts/eval_world_close.js loads via --solver-module. It wires the runner's
// observation/artifact envelope into Donna's REAL extraction and matching
// modules and reports their output unmodified. It never imports
// server/donna/world/** — privileged world truth stays on the judge side, and
// this module sees only what the runner hands it.

import { createHash } from 'node:crypto';

import { proposeMatches } from '../server/donna/salesInvoiceReconciliationLlm.js';
import { extractUnified } from '../server/donna/unifiedExtractor.js';

const RECEIPT_VERSION = 'proof0.traceReceipts.v1';
const monotonicMilliseconds = () => Number(process.hrtime.bigint() / 1_000_000n);

export function createProof0ProductionAdapter({ env = process.env, fetchImpl, clock = monotonicMilliseconds, priceSource = null } = {}) {
  return async function solveWorldClose({ worldId, capability, observations, artifacts, runtime = {} } = {}) {
    if (typeof worldId !== 'string' || worldId.trim() === '') throw new Error('runner input requires worldId');
    if (!capability || typeof capability.capabilityId !== 'string') throw new Error('runner input requires capability.capabilityId');
    if (!Array.isArray(observations) || !Array.isArray(artifacts)) throw new Error('runner input requires observations and artifacts arrays');

    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY must be set — this adapter runs Donna's real extraction and matching, never a stand-in");
    const metered = createUsageCapturingFetch(fetchImpl || fetch, {
      clock,
      priceSource: priceSource ?? env.EAW_MODEL_PRICE_SOURCE_JSON ?? null,
    });
    try {
      // Donna reads every invoice-family PDF as EVIDENCE, trusted or untrusted;
      // trust decides only what may AUTHORIZE actions below.
      const invoicePdfs = artifacts.filter((artifact) => artifact.format === 'pdf' && String(artifact.kind).includes('invoice'));
      const extractions = [];
      for (const artifact of invoicePdfs) {
        const extraction = await extractUnified({
          base64: artifact.contentBase64,
          filename: `${artifact.id.replaceAll('/', '_')}.pdf`,
          mimeType: 'application/pdf',
          apiKey,
          fetchImpl: metered.fetch,
        });
        // RT-12: the extractor returns a typed envelope for every transport
        // outcome instead of throwing. This adapter's contract is the throw —
        // a provider that is unreachable is a run that did not happen, with
        // the spend evidence attached below — so re-raise the transport
        // failure by its own message.
        if (extraction?.kind === 'failed' && extraction.retryable && ['network_error', 'timeout'].includes(extraction.reason)) {
          throw new Error(extraction.detail || `provider ${extraction.reason}`);
        }
        extractions.push({ artifact, extraction });
      }

      const completed = extractions.filter(({ extraction }) => extraction.kind === 'completed_header');
      const extractionModels = [...new Set(completed.map(({ extraction }) => extraction.model).filter(Boolean))];
      if (completed.length === 0 || extractionModels.length === 0) {
        const codes = extractions.map(({ extraction }) => extraction.code ?? extraction.kind).join(', ');
        throw new Error(`extraction produced no provider-receipted documents (${codes || 'no invoice_pdf artifacts'})`);
      }

      // AR matching candidates are money-in bank lines. The card line is
      // expense-side evidence for the close stages this adapter declares as
      // offline gaps below; it is not an AR settlement candidate.
      const candidateBankLines = artifacts
        .filter((artifact) => artifact.format === 'json' && artifact.kind === 'bank_line')
        .map(decodeBankLine)
        .filter(Boolean);
      const { firmContext, evidenceRefs: firmContextEvidenceRefs } = decodeFirmContext(artifacts);

      const matchModels = [];
      const matchingOutcomes = [];
      const actions = [];
      for (const { artifact, extraction } of completed.filter(({ extraction }) => extraction.document_type === 'sales_invoice')) {
        const result = await proposeMatches({
          document: { id: artifact.id, ...extraction.header },
          candidateBankLines,
          firmContext,
          apiKey,
          fetchImpl: metered.fetch,
        });
        if (result.model) matchModels.push(result.model);
        matchingOutcomes.push({
          invoiceArtifactId: artifact.id,
          expectedToSettle: artifact.authority === 'evidence_source',
          outcome: result.proposals.length > 0 ? 'matches_proposed' : (result.unmatchable_reason ?? 'no_plausible_match'),
          proposedBankArtifactIds: result.proposals.map(({ bank_transaction_id }) => bank_transaction_id),
          modelId: result.model ?? null,
          evidenceRefs: [
            artifact.id,
            ...candidateBankLines.map(({ id }) => id),
            ...firmContextEvidenceRefs,
          ],
        });
        for (const proposal of result.proposals) {
          actions.push({
            type: 'propose_reconciliation_match',
            documentArtifactId: artifact.id,
            bankArtifactId: proposal.bank_transaction_id,
            confidence: proposal.confidence,
            hops: proposal.hops,
            reasoning: proposal.reasoning,
            // Cite what production ACTUALLY relied on, unfiltered — the source
            // document and the matched bank line. Sanitizing untrusted ids out
            // here would blind the oracle's authority check by construction
            // (an injection-influenced action could never be caught). The
            // oracle, not the adapter, judges whether untrusted evidence
            // authorized an effect.
            authorityArtifactIds: [
              artifact.id,
              ...artifacts.filter(({ id }) => id === proposal.bank_transaction_id).map(({ id }) => id),
            ],
          });
        }
      }

      // The model id the provider RETURNED, never the requested string. Matching
      // is the final decision stage; extraction's id is the fallback when no
      // sales invoice reached matching.
      const resolvedModelId = matchModels.at(-1) ?? extractionModels.at(-1);
      const missedExpectedMatches = matchingOutcomes
        .filter(({ expectedToSettle, proposedBankArtifactIds }) => expectedToSettle && proposedBankArtifactIds.length === 0)
        .map(({ invoiceArtifactId }) => invoiceArtifactId);
      const matchingState = missedExpectedMatches.length === 0
        ? 'all_expected_invoice_matches_proposed'
        : `expected_invoice_matches_missing:${missedExpectedMatches.join(',')}`;

      const receiptBase = {
        receiptVersion: RECEIPT_VERSION,
        worldId,
        capabilityId: capability.capabilityId,
        obligationIds: [],
        retrievedMemoryRefs: [],
        policyRefs: [],
        admissibleBranches: [],
        oracleFailureIds: [],
        externalConsequence: 'none',
        reversibility: 'no_mutation',
        runtimeSnapshot: {},
      };
      const traceReceipts = [
        {
          ...receiptBase,
          decisionId: `decision/${worldId}/extraction`,
          stage: 'extracted_structured_state',
          evidenceRefs: invoicePdfs.map(({ id }) => id),
          selectedAction: 'extract_documents_via_production_extractor',
          authorityBasis: 'offline_eval_read_only',
          sourceTrust: 'mixed_trusted_and_untrusted_evidence',
          nextState: 'documents_extracted',
          modelId: extractionModels.at(-1),
          expectedState: 'documents_extracted',
          observedState: completed.length === invoicePdfs.length
            ? 'documents_extracted'
            : `documents_extracted_partial_${completed.length}_of_${invoicePdfs.length}`,
          confidence: 'high',
          sequence: 1,
          runtimeSnapshot: { extractedDocuments: completed.length },
        },
        {
          ...receiptBase,
          decisionId: `decision/${worldId}/matching`,
          stage: 'candidate_state_alternatives',
          evidenceRefs: [
            ...invoicePdfs,
            ...artifacts.filter(({ kind }) => kind === 'bank_line'),
          ].map(({ id }) => id).concat(firmContextEvidenceRefs),
          selectedAction: actions.length ? 'propose_reconciliation_matches' : 'no_reconciliation_match_proposed',
          authorityBasis: 'offline_eval_read_only',
          sourceTrust: 'mixed_evidence_with_declared_authority',
          nextState: actions.length ? 'matching_candidates_proposed' : 'matching_candidates_exhausted',
          modelId: matchModels.at(-1) ?? resolvedModelId,
          expectedState: 'all_expected_invoice_matches_proposed',
          observedState: matchingState,
          confidence: 'high',
          sequence: 2,
          runtimeSnapshot: { perInvoiceOutcomes: matchingOutcomes },
        },
        {
          ...receiptBase,
          decisionId: `decision/${worldId}/owner-ask`,
          stage: 'owner_ask_and_response',
          evidenceRefs: [],
          selectedAction: 'no_owner_ask_channel_offline',
          authorityBasis: 'offline_eval_no_owner_channel',
          sourceTrust: 'not_applicable',
          nextState: 'owner_fact_unanswered',
          modelId: resolvedModelId,
          expectedState: 'owner_only_facts_asked_and_answered',
          observedState: 'owner_ask_path_not_wired_offline',
          confidence: 'high',
          sequence: 3,
        },
        {
          ...receiptBase,
          decisionId: `decision/${worldId}/close`,
          stage: 'posting_reconciliation_or_blocked_obligation',
          evidenceRefs: [
            ...invoicePdfs,
            ...artifacts.filter(({ kind }) => kind === 'bank_line'),
          ].map(({ id }) => id).concat(firmContextEvidenceRefs),
          selectedAction: actions.length ? 'propose_reconciliation_matches_then_stop' : 'stop_before_db_backed_close',
          authorityBasis: 'offline_eval_no_write_authority',
          sourceTrust: 'evidence_source_only_for_authority',
          nextState: 'blocked_on_database_runtime',
          modelId: resolvedModelId,
          expectedState: 'production_close_completed',
          observedState: actions.length ? 'reconciliation_proposed_db_close_not_run' : 'no_match_proposed_db_close_not_run',
          confidence: 'high',
          sequence: 4,
          runtimeSnapshot: {
            proposedMatches: actions.length,
            donnaCommit: runtime.donnaCommit ?? null,
            firmContext: firmContext
              ? { settlement: { ...firmContext.settlement }, evidenceRefs: [...firmContextEvidenceRefs] }
              : null,
          },
        },
      ];

      return {
        resolvedModelId,
        candidateClose: {
          candidateId: `donna-production-path/${worldId}`,
          // The DB-backed posting loop and the owner-ask channel are not
          // reachable offline. Empty entries/ownerFacts is the honest
          // representation of that declared gap — never a stand-in close.
          entries: [],
          ownerFacts: [],
          actions,
        },
        traceReceipts,
        failureClass: 'production_close_path_incomplete',
        consequence: { extractedDocuments: completed.length, proposedMatches: actions.length },
        permittedPatchSurfaces: [],
        usage: metered.receipt(),
      };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      failure.modelUsage = metered.receipt();
      throw failure;
    }
  };
}

export function createUsageCapturingFetch(fetcher, { clock = monotonicMilliseconds, priceSource = null } = {}) {
  if (typeof fetcher !== 'function') throw new TypeError('fetcher must be a function');
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  const calls = [];
  const attemptsByRequest = new Map();
  const wrapped = async (url, options = {}) => {
    const body = typeof options.body === 'string' ? options.body : '';
    const requestDigest = digestProviderRequest(url, options, body);
    const retryIndex = attemptsByRequest.get(requestDigest) ?? 0;
    attemptsByRequest.set(requestDigest, retryIndex + 1);
    const started = clock();
    const call = {
      provider: 'anthropic',
      response_id: null,
      model_id: null,
      input_tokens: null,
      output_tokens: null,
      wall_time_ms: null,
      request_digest: requestDigest,
      http_status: null,
      retry_index: retryIndex,
      retry_disposition: retryIndex > 0 ? 'retry' : 'initial_attempt',
      cache_disposition: 'provider_live',
      outcome: 'pending_response',
    };
    calls.push(call);
    let response;
    try {
      response = await fetcher(url, options);
      call.http_status = Number.isInteger(response?.status) ? response.status : null;
    } catch (error) {
      call.wall_time_ms = Math.max(0, Math.round(clock() - started));
      call.outcome = 'transport_error';
      throw error;
    }
    const originalJson = response?.json;
    if (typeof originalJson !== 'function') {
      call.wall_time_ms = Math.max(0, Math.round(clock() - started));
      call.outcome = 'invalid_response';
      throw new TypeError('provider response must expose json()');
    }
    let recorded = false;
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      json: async () => {
        let raw;
        try {
          raw = await originalJson.call(response);
        } catch (error) {
          if (!recorded) {
            recorded = true;
            call.wall_time_ms = Math.max(0, Math.round(clock() - started));
            call.outcome = 'response_body_error';
          }
          throw error;
        }
        if (!recorded) {
          recorded = true;
          call.response_id = nonempty(raw?.id);
          call.model_id = nonempty(raw?.model);
          call.input_tokens = nonnegativeInteger(raw?.usage?.input_tokens);
          call.output_tokens = nonnegativeInteger(raw?.usage?.output_tokens);
          call.wall_time_ms = Math.max(0, Math.round(clock() - started));
          call.outcome = 'provider_response';
        }
        return raw;
      },
    };
  };
  return Object.freeze({
    fetch: wrapped,
    receipt: () => {
      const snapshot = calls.map((call) => Object.freeze({ ...call }));
      const incompleteFields = [];
      snapshot.forEach((call, index) => {
        for (const field of ['provider', 'response_id', 'model_id', 'input_tokens', 'output_tokens', 'wall_time_ms', 'request_digest', 'http_status', 'retry_index', 'retry_disposition', 'cache_disposition', 'outcome']) {
          if (call[field] == null) incompleteFields.push(`calls[${index}].${field}`);
        }
      });
      const cash = calculateCash(snapshot, priceSource);
      if (cash.status !== 'calculated') incompleteFields.push('cash');
      return Object.freeze({
        version: 'eaw.model-usage.v1',
        status: incompleteFields.length ? 'incomplete' : 'measured',
        calls: Object.freeze(snapshot),
        incomplete_fields: Object.freeze(incompleteFields),
        cash: Object.freeze(cash),
      });
    },
  });
}

function calculateCash(calls, input) {
  let source = input;
  if (typeof input === 'string') {
    try { source = JSON.parse(input); } catch { return { status: 'unknown', reason: 'price_source_invalid_json' }; }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return { status: 'unknown', reason: 'versioned_provider_price_source_not_recorded' };
  if (typeof source.version !== 'string' || !source.version.trim()
    || source.currency !== 'USD'
    || source.unit !== 'per_million_tokens'
    || !source.prices
    || typeof source.prices !== 'object'
    || Array.isArray(source.prices)) {
    return { status: 'unknown', reason: 'price_source_invalid' };
  }
  let usd = 0;
  for (const call of calls) {
    const price = source.prices[call.model_id];
    if (!price
      || !Number.isFinite(price.input_usd_per_million)
      || price.input_usd_per_million < 0
      || !Number.isFinite(price.output_usd_per_million)
      || price.output_usd_per_million < 0
      || !Number.isSafeInteger(call.input_tokens)
      || !Number.isSafeInteger(call.output_tokens)) {
      return { status: 'unknown', reason: 'response_model_price_missing' };
    }
    usd += ((call.input_tokens * price.input_usd_per_million)
      + (call.output_tokens * price.output_usd_per_million)) / 1_000_000;
  }
  const canonicalSource = JSON.stringify(canonicalize(source));
  return {
    status: 'calculated',
    usd: Number(usd.toFixed(12)),
    price_source: {
      version: source.version,
      currency: source.currency,
      unit: source.unit,
      sha256: createHash('sha256').update(canonicalSource).digest('hex'),
    },
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function digestProviderRequest(url, options, body) {
  let headerEntries = [];
  if (typeof Headers !== 'undefined' && options.headers instanceof Headers) headerEntries = [...options.headers.entries()];
  else if (Array.isArray(options.headers)) headerEntries = options.headers;
  else if (options.headers && typeof options.headers === 'object') headerEntries = Object.entries(options.headers);
  const headers = headerEntries
    .map(([key, value]) => [String(key).toLowerCase(), String(value)])
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash('sha256').update(JSON.stringify({
    url: String(url),
    method: String(options.method || 'GET').toUpperCase(),
    headers,
    body,
  })).digest('hex');
}

function nonempty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// Production's AR matcher accepts firmContext.settlement and renders it through
// formatSettlement. Proof 0 has no DB context loader, so derive the same narrow
// shape from the processor statement that production would have available. The
// status is deliberately factual context, not a proposed crosswalk: it says
// nothing about which invoice (if any) belongs to this batch.
export function decodeFirmContext(artifacts) {
  const reports = artifacts
    .filter((artifact) => artifact.kind === 'processor_report' && artifact.authority === 'evidence_source')
    .map(decodeProcessorReport)
    .filter(Boolean);
  if (reports.length === 0) return { firmContext: null, evidenceRefs: [] };

  const paymentStatus = reports.map(({ fields }) =>
    `unknown; the client settles card/online payments via a payment processor; ` +
    `processor settlement report batch ${fields.batch}: gross ${fields.gross}, fees ${fields.fee}, ` +
    `FX ${fields.fx}, net ${fields.net}`
  ).join('; ');
  return {
    firmContext: { settlement: { settledCount: 0, paymentStatus } },
    evidenceRefs: reports.map(({ id }) => id),
  };
}

function decodeProcessorReport(artifact) {
  try {
    const payload = JSON.parse(Buffer.from(artifact.contentBase64, 'base64').toString('utf8'));
    const fields = payload?.fields;
    if (!fields || !['batch', 'gross', 'fee', 'fx', 'net'].every((key) => typeof fields[key] === 'string' && fields[key].trim())) {
      return null;
    }
    return { id: artifact.id, fields };
  } catch {
    return null;
  }
}

export const solveWorldClose = createProof0ProductionAdapter();

function decodeBankLine(artifact) {
  try {
    const payload = JSON.parse(Buffer.from(artifact.contentBase64, 'base64').toString('utf8'));
    const fields = payload?.fields ?? {};
    const money = parseMoney(fields.amount);
    if (!money) return null;
    return {
      id: artifact.id,
      date: fields.postedAt ?? null,
      money_in: money.amount,
      money_out: 0,
      currency: money.currency,
      description: `${payload.kind ?? artifact.kind} ${fields.postedAt ?? ''}`.trim(),
      raw_description: JSON.stringify(fields),
      reconciliation_status: null,
    };
  } catch {
    return null;
  }
}

function parseMoney(value) {
  const match = /^([A-Z]{3})\s+(-?\d+(?:\.\d+)?)$/.exec(String(value ?? '').trim());
  return match ? { currency: match[1], amount: Number(match[2]) } : null;
}
