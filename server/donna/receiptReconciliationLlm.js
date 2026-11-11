// LLM-mode reconciliation matcher for receipts — the THIRD matcher on
// the shared `reconciliationLlmCore` (after sales_invoice / AR and
// supplier_bill / AP).
//
// Direction-wise a receipt is the AP twin of a supplier bill: it
// evidences a payment the firm MADE, so money flows OUT and the
// counterparty is a VENDOR (someone the firm pays). The same FX /
// payment-processor / settlement-lag reasoning that the bill matcher
// exists for applies verbatim — a receipt for a GBP charge can settle
// on a SGD card account days later. The difference from a bill is
// semantic, not directional: a receipt is proof of an ALREADY-completed
// payment, so there should be a matching money_out bank line to find;
// it isn't an open obligation awaiting payment.
//
// This module is the receipt "spec": it supplies the system prompt, the
// receipt/money_out user-prompt builder, the four SQL queries, and three
// small direction descriptors. Everything direction-agnostic — window
// math, id derivation, response validation, the Anthropic call, the
// firm-context render (anchor / settlement / known counterparties), and
// the UPSERT + audit + cascade block — lives in
// `reconciliationLlmCore.js` and is shared with the AR + AP matchers.
//
// PRIMARY for the receipt family — the weighted `receiptReconciliation.js`
// matcher delegates here unconditionally (batch-2 terminal state 1: the
// RECONCILIATION_MATCHER_MODE gate is deleted) and falls back to its own
// deterministic scoring when this matcher self-disables (no API key) or
// the LLM call fails.
//
// ── The receipt-specific settlement subtlety ──────────────────────────
// A receipt is intrinsically `payment_status = 'paid'` the moment it is
// uploaded (see receipt.js — "paid" is the default when the charge was
// clearly settled). For bills/invoices a non-trivial payment_status is a
// reconciliation signal; for receipts it is NOT. So we call
// loadFirmContext with `paymentStatusIsSettlementSignal: false`: the
// settlement guard ("this doc is already settled — don't propose
// another match") fires only on an ACTUAL prior matched bank line
// (settledCount > 0), never on the receipt's intrinsic 'paid'. Without
// that, every fresh paid receipt would be told to return no proposals
// and its legitimate FIRST match would be suppressed.

import {
  MAX_BANK_LINES_PER_CALL,
  FEW_SHOT_LIMIT,
  SUPPRESSION_STATUSES,
  ZERO_STATS,
  DISABLED_STATS,
  pairKey,
  getApiKey,
  getModel,
  getAutoThreshold,
  computeWindow,
  isWithinWindow,
  parseProposeMatchesResponse,
  proposeMatchesViaAnthropic,
  upsertMatchAndCascade,
  authorizeMatch,
  getAutoMatchPolicy,
  recordReconciliationEvaluation,
  resolveSettledVerdictReason,
  formatFirmAnchor,
  formatSettlement,
  formatKnownCounterparties,
  loadFirmContext,
  makeMatchId as coreMakeMatchId,
  CANDIDATE_TX_STATUS_SQL,
  CANDIDATE_TX_EXPLAIN_SELECT_SQL,
  formatCurrentExplanationLine,
  formatCurrentExplanationNote,
  describeIndistinguishableGroups,
  candidateRefForIndex,
  applyMaterialAutoFyi,
  DEFAULT_MODEL
} from './reconciliationLlmCore.js';
import { readClientConfigSnapshot, persistConfigSnapshot, clientFlagActs } from './clientConfig.js';
import { runJevReconciliationForDocument } from './jevReconciliation.js';
// Q8 (the model lab, all-entities call 2026-08-16): the compatible endpoint
// for an experiment-seated deciding rung. Fail-loud — an active policy with
// no endpoint refuses the run; never a fallback to the strong model.
import { resolveOpenAiCompatibleEndpoint } from './providerEndpoints.js';
// #5 Slice 2 — delegated authority for materiality-held matches. The store
// imports core; the orchestrator imports both (acyclic DAG). Slice 4 (below)
// supplies the archetype + scope_key + first-use flag the lookup keys off.
import { applyDelegatedAuthority } from './reconciliationAuthorityGrants.js';
// E2 (2026-06-24 no-gate decision) — the firm-facing authorization ask that used
// to drive a still-held material match (requestMaterialMatchAuthorization) is
// RETIRED: a confident material match auto-reconciles + FYIs the owner via
// applyMaterialAutoFyi (imported from core above) instead of resting on a firm
// click. The producer module/table linger only to drain any in-flight asks.
// #5 Slice 4 — archetype gating. Pure, deterministic, fail-closed: classifies a
// materiality-held match into a V1-safe archetype + canonical scope_key (or
// null), feeding BOTH the grant lookup and the pattern-scoped authorization ask.
import { classifyReconciliationArchetype } from './reconciliationArchetype.js';

const LOG_TAG = 'receiptReconciliationLlm';
const RECEIPT_OBJECT_TYPE = 'receipt';
const PAYLOAD_SOURCE = 'receipt_reconciliation_llm';

// Receipt-specific bits of the (otherwise shared) firm-context render.
// A receipt's counterparty is the VENDOR the firm paid — same shape as
// the bill matcher. The core formatters supply everything else.
const FIRM_ANCHOR_COUNTERPARTY_CLAUSE =
  `The receipt's vendor (the merchant the firm paid) is the counterparty you are matching. The bank line's counterparty should correspond to that vendor — never the firm itself, and never an unrelated third party.`;
const SETTLEMENT_DOC_NOUN = 'receipt';
// Direction descriptor for the shared known-counterparties renderer —
// receipts match against the firm's VENDORS (who we pay), exactly like
// supplier bills.
const KNOWN_COUNTERPARTIES_DESCRIPTOR = {
  noun: 'vendors',
  verb: 'pays',
  selfNoun: "this receipt's vendor"
};
// A receipt evidences a payment the firm MADE, so its counterparty is a
// supplier — the roster to load is the firm's known vendors.
const COUNTERPARTY_ROLE = 'supplier';

// Module-facing id helper pins the object type; the shared core derives
// the actual id. Signature kept as (clientId, txId, docId) for callers
// and the test suite.
export const makeMatchId = (clientId, txId, docId) =>
  coreMakeMatchId({ clientId, txId, objectType: RECEIPT_OBJECT_TYPE, docId });

// Re-exported from the shared core so existing imports of this module
// keep resolving (window math + response validation live in the core).
export { computeWindow, isWithinWindow, parseProposeMatchesResponse };

const SYSTEM_PROMPT = `You match a parsed receipt to bank transactions for a bookkeeping system.

You receive:
- One parsed receipt (the document — it is PROOF that the firm already PAID this vendor; money flowed OUT of the firm).
- A list of candidate bank transactions on the firm's account in the eligible direction (money_out) and a generous date window.
- Optional firm context: the firm's identity, its known vendors, the receipt's settlement state, and recent confirmed matches as few-shot examples.

Your job: identify which bank transaction(s), if any, settled this receipt. Because a receipt is evidence of a completed payment, a matching money_out line usually exists — but only propose one when the evidence actually fits. The match may be one-to-one, or one-to-many when a charge is split across cards.

Bridge real-world hops the deterministic scorer cannot:
- FX conversion: a GBP 745 receipt may be charged to a SGD card account and settle as SGD 1261.96 after the bank's FX. Recognise this when the SGD amount equals the GBP amount times a plausible rate. The bank description will frequently include the original currency + amount even though the structured currency / amount fields show the FX-converted values — this is a strong signal.
- Payment processors / card networks: card-network settlements (Visa, Mastercard, Amex), payment platforms (Wise, Revolut, Stripe, PayPal) settle on the firm's bank as a single posting that may aggregate several charges and clear days after the swipe / online charge. The bank description often reads like "Card 1234 OXBRIDGE LONDON GBR" or "Wise debit" rather than the vendor's full legal name.
- Settlement lag: card postings typically land 1-3 days after the swipe; cross-border wires + FX conversions can take 1-5 days. A receipt is usually dated on or very close to the payment.
- Partial payments: a charge may be split across several bank lines (e.g. two cards).
- Description-as-source-of-truth: when the bank line's STRUCTURED currency/amount fields appear to disagree with the receipt but the DESCRIPTION text quotes the receipt's original currency + amount verbatim, that's the FX-converted-card scenario — treat it as a strong amount match.

Counterparty discipline — the single most important guardrail, weigh it ABOVE amount:
- The bank line's counterparty (the name in its description / contact) must be reconcilable with THIS receipt's vendor. A matching amount — including an FX-converted amount — is NOT sufficient on its own. Amounts coincide across unrelated currencies constantly (a VND payment to one party and a GBP receipt from another can both convert to the same EUR figure); that is a coincidence, not a settlement.
- If the bank line clearly names a DIFFERENT party — a different company, or an individual unrelated to the vendor — and there is no payment-processor / card-network intermediary in the description that explains the name, treat that as strong evidence AGAINST a match. Do NOT propose it on amount or FX alone: return no proposal for that line, or at most a confidence well below 0.5.
- An FX or cross-currency amount is only a STRONG match when the counterparty corresponds to the vendor (or a known processor/card network) OR the receipt's original currency + amount is quoted verbatim in the bank description. Absent one of those, an FX amount coincidence is weak evidence at best.

Indistinguishable candidates — surface every tie, never silently pick one:
- When two or more candidate lines are equally plausible and nothing visible tells you WHICH one settled THIS receipt — same amount, same currency, a counterparty that reconciles with the vendor, adjacent dates, and no reference number or other field singling one out — propose EVERY one of those tied lines as its own proposal. Do NOT choose one and drop the rest, and do NOT collapse them into a single proposal: surfacing only one hides the alternative a human needs to disambiguate, and which one you would have picked is a coin-flip.
- Give the tied lines equal, moderate confidence (~0.6-0.7). Only one of them actually settled the receipt; you are surfacing the candidates for a human to choose, not asserting that all of them did.
- This is NOT the one-to-many case: a charge split across cards is several lines that TOGETHER settle one receipt, whereas a tie is several lines any ONE of which alone could be the settlement. A line from a clearly DIFFERENT party is not a tie — counterparty discipline above still rules it out.

Settlement awareness:
- You may be told this receipt is already matched by other bank lines. If it is FULLY settled, only propose a further match when there is unambiguous evidence of a separate, additional payment for this same receipt; otherwise return "proposals": [] with "unmatchable_reason": "already_settled".

Return a JSON object with this exact shape:

{
  "proposals": [
    {
      "candidate_ref": "candidate_1",
      "confidence": 0.92,
      "reasoning": "Brief one-or-two-sentence explanation.",
      "hops": ["fx_conversion_GBP_SGD", "processor:card_settlement", "settlement_lag_1d"]
    }
  ],
  "unmatchable_reason": null
}

Rules:
- candidate_ref MUST be a verbatim candidate_ref from the candidate list. Never invent one. Candidate bank-line database ids are intentionally not shown.
- "hops" is a categorical array of lowercase tokens. Use any of: "amount_exact", "amount_near", "reference_match", "vendor_overlap", "within_window", "fx_conversion_<FROM>_<TO>", "processor:<name>", "settlement_lag_<N>d", "partial_payment", "amount_in_description".
- confidence is a 0..1 number. Calibrate it to the standard of a competent human bookkeeper who has this firm's context: would they call this settled in seconds? When the amount corresponds (exactly, or through a plausible FX/fee chain), the date aligns, and no other candidate competes for the same explanation, that IS a clear match — score 0.85-0.95. The system is built for cheap undo: a wrong match is one click to reject and every status it cascaded reverts, while a withheld match silently misstates the books. Score 0.6-0.8 when something would genuinely give a bookkeeper pause — several candidates fit equally, a strained rate, loose dates, or a counterparty name that does not reconcile with the receipt's. A coincidental round-amount match with no other evidence is at most ~0.5. A description that quotes the receipt's original currency + amount verbatim (even when the structured currency disagrees due to FX) is worth ~0.9.
- When NO bank line is a plausible match, return "proposals": [] and "unmatchable_reason": "no_plausible_match" (or a more specific reason).
- When the bank feed is missing or clearly truncated, return "unmatchable_reason": "insufficient_bank_feed".
- Return ONLY valid JSON. No markdown, no commentary.`;

const formatBankLine = (line, idx) => {
  const amount = line.money_out ?? 0;
  return `  ${idx + 1}. candidate_ref=${candidateRefForIndex(idx)}
     date=${line.date || 'unknown'}
     money_out=${amount} ${line.currency || ''}
     description="${line.description || ''}"
     raw_description="${line.raw_description || ''}"
     contact="${line.contact || ''}"${formatCurrentExplanationLine(line)}`;
};

const formatFewShot = (example, idx) =>
  `${idx + 1}. receipt: ${example.vendor_name || '(no name)'} ${example.doc_amount} ${example.doc_currency || ''} on ${example.doc_date}
     matched bank line: ${example.tx_amount} ${example.tx_currency || ''} on ${example.tx_date} ("${example.tx_description || ''}")
     hops: ${(example.hops || []).join(', ') || '(none recorded)'}`;

export const buildProposeMatchesUserPrompt = ({ document, candidateBankLines, firmContext, datePairs = true }) => {
  const sections = [];

  sections.push(`Receipt:
  id=${document.id}
  vendor_name="${document.vendor_name || ''}"
  total_amount=${document.total_amount} ${document.currency || ''}
  document_date=${document.document_date || 'unknown'}
  reference_number="${document.reference_number || ''}"
  payment_status=${document.payment_status || 'unknown'}`);

  const firmAnchor = formatFirmAnchor(firmContext?.clientIdentity, FIRM_ANCHOR_COUNTERPARTY_CLAUSE);
  if (firmAnchor) sections.push(firmAnchor);

  const knownCounterparties = formatKnownCounterparties(
    firmContext?.knownCounterparties,
    KNOWN_COUNTERPARTIES_DESCRIPTOR
  );
  if (knownCounterparties) sections.push(knownCounterparties);

  const settlementNote = formatSettlement(firmContext?.settlement, SETTLEMENT_DOC_NOUN);
  if (settlementNote) sections.push(settlementNote);

  if (firmContext?.recentConfirmedMatches?.length) {
    sections.push(`Recent confirmed matches for this client (few-shot):
${firmContext.recentConfirmedMatches.slice(0, FEW_SHOT_LIMIT).map(formatFewShot).join('\n')}`);
  }

  if (!candidateBankLines || candidateBankLines.length === 0) {
    sections.push('Candidate bank transactions (money_out, within ±90 days of receipt date): NONE.');
  } else {
    sections.push(`Candidate bank transactions (money_out, within ±90 days of receipt date):
${candidateBankLines.map(formatBankLine).join('\n')}`);
    const explanationNote = formatCurrentExplanationNote(candidateBankLines);
    if (explanationNote) sections.push(explanationNote);
    const tieNote = describeIndistinguishableGroups(candidateBankLines, document, { datePairs });
    if (tieNote) sections.push(tieNote);
    // Distinct-date twin pairing. When two candidates share the
    // receipt's amount + a counterparty that reconciles but differ in DATE, they
    // are usually DISTINCT transactions (a daily fuel stop, the morning coffee,
    // a fixed-price subscription) — NOT an indistinguishable tie. The tie note
    // above already excludes the date-separated group; this tells the model to
    // ACT on the date rather than hedge: pair THIS receipt with the candidate
    // whose date best fits its own date (settlement lag above — a posting lands
    // on or 1-3 days AFTER the receipt, essentially never before it), score that
    // one like any clear match (0.85-0.95), and give the date-misaligned
    // same-amount siblings low confidence. Reserve the equal-moderate-confidence
    // tie ONLY for candidates that are also date-indistinguishable (same date,
    // or no closer fit).
    if (datePairs) {
      sections.push(`Same-amount charges to one vendor are usually DISTINCT transactions, told apart by DATE — not a tie:
- A vendor the firm pays repeatedly at the same price produces several same-amount receipts and several same-amount bank lines. Pair THIS receipt with the candidate whose date best fits ITS date (a posting lands on or 1-3 days after the receipt, essentially never before it). Score that date-aligned candidate like any clear match (0.85-0.95) and give the date-misaligned same-amount siblings low confidence. Only treat them as an equal-confidence tie when they are genuinely date-indistinguishable (same date, no closer fit).`);
    }
  }

  return sections.join('\n\n');
};

// One LLM call. Returns `{ proposals, unmatchable_reason }`. Throws only
// on transport errors — schema parsing returns empty proposals + explicit
// `unmatchable_reason` so the caller can decide whether to fall through to
// the weighted matcher. Thin wrapper over the shared core: supplies the
// receipt system prompt + receipt user-prompt.
// Twin-date pairing is foundational. Keep one exported resolution seam so the
// deciding call and reverse-shadow replay stay byte-identical.
export const resolveReceiptDatePairs = () => true;

export const proposeMatches = async ({
  document,
  candidateBankLines,
  firmContext = null,
  apiKey,
  model = DEFAULT_MODEL,
  fetchImpl,
  clientId = null,
  // The run snapshot still feeds the remaining config-governed policy gates.
  configSnapshot = null,
  // Q8: optional deciding transport (openai_compatible) from the lane's
  // active experiment policy. Absent => the anthropic path, byte-identical.
  transport = null
} = {}) => {
  if (!apiKey && transport?.provider !== 'openai_compatible') {
    return { proposals: [], unmatchable_reason: 'no_api_key' };
  }
  if (!document || !document.id) {
    return { proposals: [], unmatchable_reason: 'no_document' };
  }

  // Distinct-date twin pairing. Resolved once here and
  // threaded into BOTH the prompt (date-pair guidance + tie-note suppression)
  // and the output mirroring, so the model's date-pick is not re-tied downstream.
  const datePairs = resolveReceiptDatePairs({ clientId, configSnapshot });
  const truncated = (candidateBankLines || []).slice(0, MAX_BANK_LINES_PER_CALL);
  const userPrompt = buildProposeMatchesUserPrompt({
    document,
    candidateBankLines: truncated,
    firmContext,
    datePairs
  });

  return proposeMatchesViaAnthropic({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    candidateBankLines: truncated,
    document,
    model,
    apiKey,
    fetchImpl,
    logTag: LOG_TAG,
    datePairs,
    transport
  });
};

// Orchestrator. Same caller signature as the weighted matcher so
// receiptReconciliation.js can swap entry points without re-wiring.
// Returns ZERO_STATS-shape stats so `accumulate(stats)` in the cron
// rollup works unchanged regardless of which matcher mode ran.
//
// On any failure inside this function the caller (the weighted matcher's
// orchestrator, when delegating) catches and falls through. This function
// therefore prefers throwing on infrastructure problems (DB errors, etc.)
// to returning bogus stats — fail loud, fall back cheap.
export const runReceiptReconciliationLlmForDocument = async ({
  client,
  firmId,
  clientId,
  documentId,
  apiKeyOverride,
  modelOverride,
  fetchImpl,
  // Q8 (the model lab): the lane's active model-policy row, resolved by the
  // WRAPPER per (firm, client). A non-claude qualified rung decides over the
  // openai_compatible endpoint — same prompts, parser, gates, cascade. An
  // active policy with no endpoint fails LOUD, never silently back to the
  // strong model or the weighted matcher.
  decidingPolicy = null,
  // Q8: the reverse-shadow hook (built by the wrapper). Fired post-stamp,
  // fire-and-forget, throw-guarded.
  challengerHook = null
} = {}) => {
  if (!client || !firmId || !clientId || !documentId) return ZERO_STATS();
  const jevConfig = await readClientConfigSnapshot(client, { firmId, clientId, strict: true });
  if (clientFlagActs({ flagKey: 'JEV_RECONCILIATION', snapshot: jevConfig, envFallback: () => false })) {
    const first = await runJevReconciliationForDocument({ client, firmId, clientId, documentId, configSnapshot: jevConfig, fetchImpl, family: 'receipt' });
    if (!first.jev_handoff) return first;
  }
  const policyModel = typeof decidingPolicy?.deciding_model === 'string' && decidingPolicy.deciding_model.trim()
    ? decidingPolicy.deciding_model.trim()
    : null;
  let decidingTransport = null;
  if (policyModel && !policyModel.startsWith('claude')) {
    try {
      decidingTransport = {
        provider: 'openai_compatible',
        endpoint: resolveOpenAiCompatibleEndpoint({}),
        model: policyModel,
        execution: { root: { type: 'reconciliation_reasoning', id: documentId } }
      };
    } catch {
      return DISABLED_STATS('policy_endpoint_unconfigured');
    }
  }
  // Key-gate AFTER transport resolution: the Anthropic key gates only the
  // Anthropic-decided path — a seated non-claude rung rides the compatible
  // endpoint above and must not require the key (Kari, 2026-08-19). The
  // reverse shadow still self-disables without it, receipted, deciding nothing.
  const apiKey = apiKeyOverride ?? getApiKey();
  if (!apiKey && !decidingTransport) return DISABLED_STATS('no_anthropic_api_key');
  const policyBasis = policyModel ? (decidingPolicy?.basis || 'experiment') : null;

  const docResult = await client.query(
    `select id, firm_id, client_id, document_type, vendor_name, document_date,
            total_amount, currency, extraction_confidence, parse_summary,
            duplicate_of, reference_number, filename, payment_status
       from documents
      where firm_id = $1
        and client_id = $2
        and id = $3
        and document_type = 'receipt'
        and parse_status = 'completed'
        and total_amount is not null
        and duplicate_of is null`,
    [firmId, clientId, documentId]
  );
  if (!docResult.rows.length) return ZERO_STATS();
  const document = docResult.rows[0];

  const window = computeWindow(document);

  // money_out only, not already resolved — except bank-line-only
  // explains, which stay visible so document evidence can outrank them
  // (CANDIDATE_TX_STATUS_SQL in the core). Window-narrowing happens
  // post-query in JS so the SQL stays simple (and exactly mirrors the
  // bill matcher's tx query — easier to keep aligned).
  const txResult = await client.query(
    `select id, firm_id, client_id, money_in, money_out, currency,
            transaction_date as date,
            description, raw_description,
            payload->>'contact' as contact,
            payload->>'source_line' as source_line,
            ${CANDIDATE_TX_EXPLAIN_SELECT_SQL},
            reconciliation_status, account_code, status
       from transactions
      where firm_id = $1
        and client_id = $2
        and money_out > 0
        and (money_in is null or money_in = 0)
        and ${CANDIDATE_TX_STATUS_SQL}
      order by transaction_date asc, id asc`,
    [firmId, clientId]
  );

  const candidateBankLines = window
    ? txResult.rows.filter((tx) => isWithinWindow(tx, window))
    : txResult.rows;

  const existingResult = await client.query(
    `select id, bank_transaction_id, matched_object_type, matched_object_id,
            status, match_amount, match_confidence, payload
       from reconciliation_matches
      where firm_id = $1
        and client_id = $2
        and matched_object_type = 'receipt'
        and matched_object_id = $3`,
    [firmId, clientId, documentId]
  );

  const suppressed = {
    rejected: new Set(),
    confirmed: new Set(),
    auto_matched: new Set()
  };
  // Settlement-to-date: how many bank lines already settle THIS receipt.
  // Threaded into the prompt so the model can decline a phantom second
  // match against an already-matched receipt. For receipts this is the
  // ONLY settlement signal — the receipt's intrinsic payment_status='paid'
  // is deliberately NOT treated as one (see paymentStatusIsSettlementSignal
  // below).
  let settledCount = 0;
  for (const row of existingResult.rows) {
    const key = pairKey(row.bank_transaction_id, row.matched_object_id);
    if (SUPPRESSION_STATUSES.has(row.status)) {
      suppressed[row.status].add(key);
    }
    if (row.status === 'confirmed' || row.status === 'auto_matched') {
      settledCount += 1;
    }
  }

  // Few-shot examples: last N confirmed/auto-matched receipts for this
  // client. Stays optional — when the table is empty we just call without
  // it.
  const fewShotResult = await client.query(
    `select m.match_amount, m.payload,
            t.description as tx_description,
            t.transaction_date as tx_date,
            t.money_out as tx_amount,
            t.currency as tx_currency,
            d.vendor_name,
            d.total_amount as doc_amount,
            d.currency as doc_currency,
            d.document_date as doc_date
       from reconciliation_matches m
       join transactions t on t.id = m.bank_transaction_id
       join documents d on d.id = m.matched_object_id
      where m.firm_id = $1
        and m.client_id = $2
        and m.matched_object_type = 'receipt'
        and m.status in ('confirmed', 'auto_matched')
      order by m.created_at desc
      limit $3`,
    [firmId, clientId, FEW_SHOT_LIMIT]
  );

  // Firm identity ("who we are", so the model can rule out a bank-line
  // counterparty that is clearly a different party from the vendor) +
  // settlement state + known-vendors roster. Shared wiring lives in the
  // core; settledCount comes from the existing-match loop above.
  // paymentStatusIsSettlementSignal=false: a receipt is intrinsically
  // 'paid', so only an actual prior matched bank line (settledCount)
  // counts as settlement — see the module header.
  const { clientIdentity, settlement, knownCounterparties } = await loadFirmContext({
    client,
    firmId,
    clientId,
    document,
    settledCount,
    counterpartyRole: COUNTERPARTY_ROLE,
    paymentStatusIsSettlementSignal: false
  });

  const firmContext = {
    clientIdentity,
    settlement,
    knownCounterparties,
    recentConfirmedMatches: fewShotResult.rows.map((r) => ({
      vendor_name: r.vendor_name,
      doc_amount: r.doc_amount,
      doc_currency: r.doc_currency,
      doc_date: r.doc_date,
      tx_amount: r.tx_amount,
      tx_currency: r.tx_currency,
      tx_date: r.tx_date,
      tx_description: r.tx_description,
      hops: r.payload?.match_reason?.hops || []
    }))
  };

  // Drop suppressed pairs BEFORE the LLM call — we'd discard the proposal
  // anyway and the model would have spent tokens on it.
  const eligibleBankLines = candidateBankLines.filter((tx) => {
    const key = pairKey(tx.id, documentId);
    return !(
      suppressed.rejected.has(key) ||
      suppressed.confirmed.has(key) ||
      suppressed.auto_matched.has(key)
    );
  });

  const stats = ZERO_STATS();
  stats.skipped_rejected = suppressed.rejected.size;
  stats.skipped_confirmed = suppressed.confirmed.size;
  stats.skipped_auto_matched = suppressed.auto_matched.size;

  if (eligibleBankLines.length === 0) {
    // Without this line a doc whose every candidate was suppressed is
    // indistinguishable from a clean no-match in the cron rollup.
    console.log(`[${LOG_TAG}] no eligible bank lines after suppression`, {
      document_id: documentId,
      candidate_count: candidateBankLines.length,
      skipped_rejected: stats.skipped_rejected,
      skipped_confirmed: stats.skipped_confirmed,
      skipped_auto_matched: stats.skipped_auto_matched
    });
    await recordReconciliationEvaluation({
      client,
      firmId,
      clientId,
      targetId: documentId,
      matcherFamily: RECEIPT_OBJECT_TYPE,
      verdict: 'no_candidates',
      candidateCount: candidateBankLines.length,
      eligibleCount: 0,
      logTag: LOG_TAG
    });
    return stats;
  }

  // Resolve the per-client config snapshot once for the remaining governed
  // policy gates and for the persisted run receipt.
  const configSnapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  // Phase 0B family-matcher coverage — resolve + persist the config snapshot ONCE per run
  // so each auto-match decision recorded below references the config it ran under. Soft-
  // fails to null (un-stamped), behaviour-neutral. Mirrors the coder (parseDocumentsDb.js).
  const runConfigSnapshotId = await persistConfigSnapshot(client, { firmId, clientId, snapshot: configSnapshot });

  // Q8 — a claude-family policy is a model override on the anthropic path;
  // a non-claude rung rides the compatible transport.
  const model = modelOverride ?? policyModel ?? getModel();
  const llmResult = await proposeMatches({
    document,
    candidateBankLines: eligibleBankLines,
    firmContext,
    apiKey,
    model,
    fetchImpl,
    clientId,
    configSnapshot,
    transport: decidingTransport
  });

  const autoThreshold = getAutoThreshold();
  const linesById = new Map(eligibleBankLines.map((tx) => [String(tx.id), tx]));
  // RT-11b — Gate E's ceiling follows the client's pack (home currency);
  // resolved once per run from the identity loadFirmContext already read.
  const policy = getAutoMatchPolicy({ jurisdiction: clientIdentity?.jurisdiction ?? null });

  for (const proposal of llmResult.proposals) {
    const bankLine = linesById.get(proposal.bank_transaction_id);
    if (!bankLine) continue;

    const matchAmount = Number(bankLine.money_out || 0);
    const authorization = authorizeMatch({
      proposal,
      allProposals: llmResult.proposals,
      bankLine,
      candidateBankLines: eligibleBankLines,
      document,
      matchAmount,
      clientId,
      policy,
      configSnapshot
    });

    // #5 Slice 4 — classify this match ONCE into a V1-safe archetype + canonical
    // scope_key (or null, fail-closed). Pure + deterministic, so the value used
    // for the grant lookup below and the authorization ask further down can never
    // diverge. It NEVER re-scores the match — the model's A–D judgment stands.
    const archetypeClassification = classifyReconciliationArchetype({
      proposal,
      bankLine,
      document,
      firmContext
    });

    // #5 — a covering delegated-authority grant upgrades a materiality-held
    // match (A–D passed, only Gate E held) to auto_matched so it auto-reconciles
    // instead of resting on a firm click. No grant (or no archetype) → unchanged.
    // E2 (2026-06-24 no-gate decision): a still-held no-grant material match then
    // auto-reconciles + FYIs the owner via applyMaterialAutoFyi (behind its OWN
    // dedicated fail-closed canary, inert in prod) rather than opening the now-
    // retired firm authorization ask. Both seams no-op off their canaries, so a
    // held line passes through 'suggested' and is SURFACED as hanging — never
    // laundered behind a firm click.
    const effectiveAuthorization = applyMaterialAutoFyi(
      await applyDelegatedAuthority({
        client,
        firmId,
        clientId,
        authorization,
        proposal,
        document,
        matchAmount,
        currency: bankLine.currency,
        archetype: archetypeClassification.archetype,
        scopeKey: archetypeClassification.scopeKey,
        firstUseAccountInvolved: archetypeClassification.firstUseAccountInvolved,
        // 0A.8 — thread the per-run config snapshot so the delegated-authority gate
        // is config-plane-aware (no new db read; resolved once above).
        configSnapshot
      }),
      { clientId, configSnapshot }
    );

    await upsertMatchAndCascade({
      client,
      firmId,
      clientId,
      proposal,
      document,
      objectType: RECEIPT_OBJECT_TYPE,
      matchAmount,
      autoThreshold,
      authorization: effectiveAuthorization,
      returnedModel: llmResult.model || model,
      policyBasis,
      source: PAYLOAD_SOURCE,
      matchKind: 'receipt',
      unmatchableReason: llmResult.unmatchable_reason || null,
      logTag: LOG_TAG,
      configSnapshotId: runConfigSnapshotId,
      stats
    });
  }

  // Slice E (b) — record the HONEST no-proposal reason. A receipt whose amount
  // a SETTLED bank line already covers is not unmatchable, it is already
  // accounted for: promote 'no_plausible_match' (or none) to 'already_settled'
  // so the goal evaluator resolves it to met instead of opening firm limbo
  // (CLAUDE.md two-terminal-states). Canary-gated (RECONCILIATION_SETTLED_VERDICT);
  // off → the model's stated reason survives verbatim.
  const recordedReason = await resolveSettledVerdictReason({
    client,
    firmId,
    clientId,
    document,
    proposalCount: llmResult.proposals.length,
    unmatchableReason: llmResult.unmatchable_reason,
    configSnapshot
  });

  // Verdict stamp — persists the model's no-proposal reason (or the
  // fact that proposals were written), so "no match" is a recorded
  // verdict rather than an absence of rows.
  await recordReconciliationEvaluation({
    client,
    firmId,
    clientId,
    targetId: documentId,
    matcherFamily: RECEIPT_OBJECT_TYPE,
    verdict: llmResult.proposals.length ? 'proposed' : 'no_match',
    unmatchableReason: recordedReason,
    proposalCount: llmResult.proposals.length,
    candidateCount: candidateBankLines.length,
    eligibleCount: eligibleBankLines.length,
    // The verdict stamp carries the provider-RETURNED model id (the
    // receipt), not the requested string — same as the match payload's
    // returnedModel above. See CLAUDE.md "the model id is part of the receipt".
    model: llmResult.model || model,
    // Q8 — which policy basis (if any) put the deciding model in charge.
    payload: policyBasis
      ? { policy_basis: policyBasis, model_source: llmResult.model_source || null }
      : null,
    // Phase 0B no-match coverage — record the model's no_match DECISION (skipped when
    // 'proposed'; #650 covers that per-proposal), stamped with the run's config snapshot.
    recordDecision: true,
    configSnapshotId: runConfigSnapshotId,
    logTag: LOG_TAG
  });

  // Q8 — POST-STAMP reverse shadow (bare client, per-statement commits, so
  // everything above is committed). Evidence + receipt only.
  if (challengerHook) {
    try {
      challengerHook({
        document,
        candidateBankLines: eligibleBankLines.slice(0, MAX_BANK_LINES_PER_CALL),
        firmContext,
        configSnapshot,
        decidingResult: llmResult,
        decidingModel: { model: llmResult.model || model, model_source: llmResult.model_source || null },
        executionRoot: { type: 'reconciliation_reasoning', id: documentId }
      });
    } catch { /* the hook never affects the matcher */ }
  }

  return stats;
};

// Re-exports for tests. The threshold/window constants are re-exported
// straight from the core (not copied into a local const) so they are not
// read during this module's evaluation — core ↔ firmDb ↔ parseDocumentsDb
// form an import cycle and an init-time read would hit the core binding's
// temporal dead zone.
export const __RECEIPT_OBJECT_TYPE = RECEIPT_OBJECT_TYPE;
// Q8 — the exact deciding system prompt, exported for the reverse-shadow
// replay. Same-string parity; never fork this text at a call site.
export const __RECEIPT_SYSTEM_PROMPT = SYSTEM_PROMPT;
export {
  WINDOW_DAYS as __WINDOW_DAYS,
  DEFAULT_AUTO_THRESHOLD as __DEFAULT_AUTO_THRESHOLD
} from './reconciliationLlmCore.js';
