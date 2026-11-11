// LLM-mode reconciliation matcher for payment confirmations — the SIXTH
// matcher on the shared `reconciliationLlmCore` (after sales_invoice / AR,
// supplier_bill / AP, receipt, payment_account_statement, and the
// payment-confirmation legacy path this RETIRES).
//
// A `payment_confirmation` is a SINGLE-event outbound payment receipt:
// it confirms one ACH / wire / card-rail payment the firm made actually
// happened (Amex payment confirmations, IRS/EFTPS tax payment
// confirmations, lender payment receipts, ACH notification emails). The
// bank line IS that same payment. Direction-wise it is the AP twin of a
// supplier bill: money flows OUT and the counterparty is the PAYEE (a
// party the firm pays). The job is to find the single money_out bank line
// that IS this confirmed payment — the same FX / payment-processor /
// settlement-lag reasoning the bill + statement matchers exist for.
//
// This module is the confirmation "spec": it supplies the system prompt,
// the confirmation/money_out user-prompt builder, and the direction
// descriptors. Everything direction-agnostic — window math, id
// derivation, response validation, the Anthropic call, the firm-context
// render, and the UPSERT + audit + cascade + authorizeMatch gate stack —
// lives in `reconciliationLlmCore.js` and is shared with the AR / AP /
// receipt / payment_account_statement matchers.
//
// Why this module exists (the retirement): the legacy
// `paymentConfirmationReconciliation.js` promoted to 'auto_matched' on the
// deterministic tier-1 gates + the client allowlist alone — it never
// called `authorizeMatch`, so the materiality ceiling (Gate E) and the
// ambiguity/twin guard (Gate D) never ran and no authorization receipt was
// written (a confirmed Honeybee payment of 2,087.97 / 3,683.67 auto-matched
// straight through a 500 ceiling). Routing the family through the strong
// path closes that gap: every auto-match now carries the full gate stack
// and a persisted authorization receipt, exactly like the other five.
// PRIMARY, unconditionally (batch-2 terminal state 1: the
// RECONCILIATION_MATCHER_MODE gate is deleted); the legacy matcher
// delegates here and only falls back to its weighted scoring when this
// matcher self-disables (no API key) or the LLM call fails (same shape
// as the sibling paths).
//
// ── Settlement note (like receipts, UNLIKE statements) ────────────────
// A payment confirmation IS "paid by construction": it records that one
// payment happened and is intrinsically settled. So — like the receipt
// matcher — we pass `paymentStatusIsSettlementSignal: false`: the
// settlement guard ("already reconciled — don't propose another match")
// fires only on an ACTUAL prior matched bank line (settledCount > 0),
// never on the confirmation's intrinsic 'paid' status. (Statements are NOT
// paid-by-construction and use the core's default true.)

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

const LOG_TAG = 'paymentConfirmationReconciliationLlm';
const PAYMENT_CONFIRMATION_OBJECT_TYPE = 'payment_confirmation';
const PAYLOAD_SOURCE = 'payment_confirmation_reconciliation_llm';

// Confirmation-specific bits of the (otherwise shared) firm-context render.
// A confirmation's counterparty is the PAYEE the firm paid — same shape as
// the bill / statement matchers. The core formatters supply everything else.
const FIRM_ANCHOR_COUNTERPARTY_CLAUSE =
  `The payee this confirmation documents (the party the firm paid — e.g. Amex, the IRS, a lender, a vendor) is the counterparty you are matching. The bank line's counterparty should correspond to that payee — never the firm itself, and never an unrelated third party.`;
const SETTLEMENT_DOC_NOUN = 'payment confirmation';
// Direction descriptor for the shared known-counterparties renderer —
// confirmations match against the firm's VENDORS (who we pay), exactly like
// supplier bills + statements.
const KNOWN_COUNTERPARTIES_DESCRIPTOR = {
  noun: 'vendors',
  verb: 'pays',
  selfNoun: "this confirmation's payee"
};
// A confirmation evidences a payment the firm MADE, so its counterparty is
// a supplier — load the firm's known vendors.
const COUNTERPARTY_ROLE = 'supplier';


// Module-facing id helper pins the object type; the shared core derives the
// actual id. Signature kept as (clientId, txId, docId) for callers and the
// test suite.
export const makeMatchId = (clientId, txId, docId) =>
  coreMakeMatchId({ clientId, txId, objectType: PAYMENT_CONFIRMATION_OBJECT_TYPE, docId });

// Re-exported from the shared core so existing imports of this module keep
// resolving (window math + response validation live in the core).
export { computeWindow, isWithinWindow, parseProposeMatchesResponse };

const SYSTEM_PROMPT = `You match a parsed payment confirmation to bank transactions for a bookkeeping system.

You receive:
- One parsed payment confirmation (the document — e.g. an Amex payment confirmation, an IRS / EFTPS tax payment confirmation, a lender payment receipt, an ACH notification). It confirms that ONE specific outbound payment the firm made actually happened; money flows OUT of the firm. It is intrinsically settled — the confirmation IS the receipt of that payment.
- A list of candidate bank transactions on the firm's account in the eligible direction (money_out) and a generous date window.
- Optional firm context: the firm's identity, its known payees/vendors, the confirmation's settlement state, and recent confirmed matches as few-shot examples.

Your job: identify which bank transaction IS the payment this confirmation documents. The match is one-to-one — the confirmation's amount ↔ the single ACH / wire / card payment that settled it.

Bridge real-world hops the deterministic scorer cannot:
- FX conversion: a GBP 745 confirmation may settle from a SGD account as SGD 1261.96 after the bank's FX. Recognise this when the SGD amount equals the GBP amount times a plausible rate. The bank description will frequently include the original currency + amount even though the structured currency / amount fields show the FX-converted values — this is a strong signal.
- Payment processors / card networks: the payment often posts as "ACH DEBIT AMEX EPAYMENT", "IRS USATAXPYMT", "STRIPE", "Wise debit" rather than the payee's full legal name.
- Settlement lag: ACH debits typically post 1-3 business days after the confirmation's payment date; cross-border wires + FX conversions can take 1-5 days.
- Description-as-source-of-truth: when the bank line's STRUCTURED currency/amount fields appear to disagree with the confirmation but the DESCRIPTION text quotes the confirmation's original currency + amount verbatim, that's the FX-converted scenario — treat it as a strong amount match.

Counterparty discipline — the single most important guardrail, weigh it ABOVE amount:
- The bank line's counterparty (the name in its description / contact) must be reconcilable with THIS confirmation's payee. A matching amount — including an FX-converted amount — is NOT sufficient on its own. Amounts coincide across unrelated currencies constantly (a VND payment to one party and a GBP payment to another can both convert to the same EUR figure); that is a coincidence, not the same payment.
- If the bank line clearly names a DIFFERENT party — a different company, or an individual unrelated to the payee — and there is no payment-processor / card-network intermediary in the description that explains the name, treat that as strong evidence AGAINST a match. Do NOT propose it on amount or FX alone: return no proposal for that line, or at most a confidence well below 0.5.
- An FX or cross-currency amount is only a STRONG match when the counterparty corresponds to the payee (or a known processor/card network) OR the confirmation's original currency + amount is quoted verbatim in the bank description. Absent one of those, an FX amount coincidence is weak evidence at best.

Indistinguishable candidates — surface every tie, never silently pick one:
- When two or more candidate lines are equally plausible and nothing visible tells you WHICH one is THIS confirmed payment — same amount, same currency, a counterparty that reconciles with the payee, adjacent dates, and no reference number or other field singling one out — propose EVERY one of those tied lines as its own proposal. Do NOT choose one and drop the rest, and do NOT collapse them into a single proposal: surfacing only one hides the alternative a human needs to disambiguate, and which one you would have picked is a coin-flip.
- Give the tied lines equal, moderate confidence (~0.6-0.7). Only one of them is actually this payment; you are surfacing the candidates for a human to choose, not asserting that all of them are.
- A line from a clearly DIFFERENT party is not a tie — counterparty discipline above still rules it out.

Settlement awareness:
- A payment confirmation is intrinsically settled — do NOT decline a match merely because its recorded payment status is "paid"; that is its normal state. Decline only when you are told an ACTUAL prior bank line already matched THIS confirmation (it is already reconciled): then return "proposals": [] with "unmatchable_reason": "already_settled".

Return a JSON object with this exact shape:

{
  "proposals": [
    {
      "candidate_ref": "candidate_1",
      "confidence": 0.92,
      "reasoning": "Brief one-or-two-sentence explanation.",
      "hops": ["processor:ach_debit", "settlement_lag_2d"]
    }
  ],
  "unmatchable_reason": null
}

Rules:
- candidate_ref MUST be a verbatim candidate_ref from the candidate list. Never invent one. Candidate bank-line database ids are intentionally not shown.
- "hops" is a categorical array of lowercase tokens. Use any of: "amount_exact", "amount_near", "reference_match", "vendor_overlap", "within_window", "fx_conversion_<FROM>_<TO>", "processor:<name>", "settlement_lag_<N>d", "partial_payment", "amount_in_description".
- confidence is a 0..1 number. Calibrate it to the standard of a competent human bookkeeper who has this firm's context: would they call this the same payment in seconds? When the amount corresponds (exactly, or through a plausible FX/fee chain), the date aligns, and no other candidate competes for the same explanation, that IS a clear match — score 0.85-0.95. The system is built for cheap undo: a wrong match is one click to reject and every status it cascaded reverts, while a withheld match silently misstates the books. Score 0.6-0.8 when something would genuinely give a bookkeeper pause — several candidates fit equally, a strained rate, loose dates, or a counterparty name that does not reconcile with the payee's. A coincidental round-amount match with no other evidence is at most ~0.5. A description that quotes the confirmation's original currency + amount verbatim (even when the structured currency disagrees due to FX) is worth ~0.9.
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
  `${idx + 1}. payment confirmation: ${example.vendor_name || '(no name)'} ${example.doc_amount} ${example.doc_currency || ''} on ${example.doc_date}
     matched bank line: ${example.tx_amount} ${example.tx_currency || ''} on ${example.tx_date} ("${example.tx_description || ''}")
     hops: ${(example.hops || []).join(', ') || '(none recorded)'}`;

export const buildProposeMatchesUserPrompt = ({ document, candidateBankLines, firmContext, datePairs = true }) => {
  const sections = [];

  sections.push(`Payment confirmation:
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
    sections.push('Candidate bank transactions (money_out, within ±90 days of confirmation date): NONE.');
  } else {
    sections.push(`Candidate bank transactions (money_out, within ±90 days of confirmation date):
${candidateBankLines.map(formatBankLine).join('\n')}`);
    const explanationNote = formatCurrentExplanationNote(candidateBankLines);
    if (explanationNote) sections.push(explanationNote);
    const tieNote = describeIndistinguishableGroups(candidateBankLines, document, { datePairs });
    if (tieNote) sections.push(tieNote);
    // Distinct-date twin pairing. When two candidates share this
    // confirmation's amount + a payee that reconciles but differ in DATE, they
    // are usually DISTINCT same-amount payments — NOT an indistinguishable tie.
    // The tie note above already excludes the date-separated group; this tells
    // the model to ACT on the date: the bank line IS this payment, so pair THIS
    // confirmation with the candidate whose date best fits its own (it posts on
    // or within 1-3 days of the confirmation, essentially never before it),
    // score that one like any clear match (0.85-0.95), and give the
    // date-misaligned same-amount siblings low confidence. Reserve the
    // equal-moderate-confidence tie ONLY for candidates that are also
    // date-indistinguishable.
    if (datePairs) {
      sections.push(`Same-amount payments to one payee are usually DISTINCT transactions, told apart by DATE — not a tie:
- The firm paying one payee repeatedly at the same amount produces several same-amount confirmations and several same-amount bank lines. Pair THIS confirmation with the candidate whose date best fits ITS date (the bank line IS this payment, so it posts on or within 1-3 days of the confirmation, essentially never before it). Score that date-aligned candidate like any clear match (0.85-0.95) and give the date-misaligned same-amount siblings low confidence. Only treat them as an equal-confidence tie when they are genuinely date-indistinguishable (same date, no closer fit).`);
    }
  }

  return sections.join('\n\n');
};

// One LLM call. Returns `{ proposals, unmatchable_reason }`. Throws only on
// transport errors — schema parsing returns empty proposals + explicit
// `unmatchable_reason` so the caller can decide whether to fall through to
// the weighted matcher. Thin wrapper over the shared core: supplies the
// confirmation system prompt + confirmation user-prompt.
// Twin-date pairing is foundational. Keep one exported resolution seam so the
// deciding call and reverse-shadow replay stay byte-identical.
export const resolvePaymentConfirmationDatePairs = () => true;

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
  const datePairs = resolvePaymentConfirmationDatePairs({ clientId, configSnapshot });
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
// paymentConfirmationReconciliation.js can swap entry points without
// re-wiring. Returns ZERO_STATS-shape stats so `accumulate(stats)` in the
// cron rollup works unchanged regardless of which matcher mode ran.
//
// On any failure inside this function the caller (the weighted matcher's
// orchestrator, when delegating) catches and falls through. This function
// therefore prefers throwing on infrastructure problems (DB errors, etc.)
// to returning bogus stats — fail loud, fall back cheap.
export const runPaymentConfirmationReconciliationLlmForDocument = async ({
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
    const first = await runJevReconciliationForDocument({ client, firmId, clientId, documentId, configSnapshot: jevConfig, fetchImpl, family: 'payment_confirmation' });
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
            due_date, total_amount, currency, extraction_confidence, parse_summary,
            duplicate_of, reference_number, filename, payment_status
       from documents
      where firm_id = $1
        and client_id = $2
        and id = $3
        and document_type = 'payment_confirmation'
        and parse_status = 'completed'
        and total_amount is not null
        and duplicate_of is null`,
    [firmId, clientId, documentId]
  );
  if (!docResult.rows.length) return ZERO_STATS();
  const document = docResult.rows[0];

  const window = computeWindow(document);

  // money_out only, not already resolved — except bank-line-only explains,
  // which stay visible so document evidence can outrank them
  // (CANDIDATE_TX_STATUS_SQL in the core). Window-narrowing happens
  // post-query in JS so the SQL stays simple (and mirrors the bill /
  // statement matchers' tx query — easier to keep aligned).
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
        and matched_object_type = 'payment_confirmation'
        and matched_object_id = $3`,
    [firmId, clientId, documentId]
  );

  const suppressed = {
    rejected: new Set(),
    confirmed: new Set(),
    auto_matched: new Set()
  };
  // Settlement-to-date: how many bank lines already settle THIS
  // confirmation. Threaded into the prompt so the model can decline a
  // phantom second match against an already-reconciled confirmation.
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

  // Few-shot examples: last N confirmed/auto-matched confirmations for this
  // client. Stays optional — when the table is empty we just call without it.
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
        and m.matched_object_type = 'payment_confirmation'
        and m.status in ('confirmed', 'auto_matched')
      order by m.created_at desc
      limit $3`,
    [firmId, clientId, FEW_SHOT_LIMIT]
  );

  // Firm identity ("who we are", so the model can rule out a bank-line
  // counterparty that is clearly a different party from the payee) +
  // settlement state + known-vendors roster. Shared wiring lives in the
  // core; settledCount comes from the existing-match loop above.
  // paymentStatusIsSettlementSignal=false: a payment confirmation is
  // intrinsically 'paid', so only an actual prior matched bank line
  // (settledCount) counts as settlement — see the module header.
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
      matcherFamily: PAYMENT_CONFIRMATION_OBJECT_TYPE,
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

    // E2 (2026-06-24 no-gate decision) — a still-held no-grant material match
    // auto-reconciles + FYIs the owner instead of resting on a firm click. Pure
    // seam, behind its OWN dedicated fail-closed canary (inert in prod); a no-op
    // when not materiality-held or the canary is off. This family has no grant
    // wiring, so the auto-FYI path is the sole material-match terminal here.
    const effectiveAuthorization = applyMaterialAutoFyi(authorization, { clientId, configSnapshot });

    await upsertMatchAndCascade({
      client,
      firmId,
      clientId,
      proposal,
      document,
      objectType: PAYMENT_CONFIRMATION_OBJECT_TYPE,
      matchAmount,
      autoThreshold,
      authorization: effectiveAuthorization,
      returnedModel: llmResult.model || model,
      policyBasis,
      source: PAYLOAD_SOURCE,
      matchKind: 'payment_confirmation',
      unmatchableReason: llmResult.unmatchable_reason || null,
      logTag: LOG_TAG,
      configSnapshotId: runConfigSnapshotId,
      stats
    });
  }

  // Slice E (b) — record the HONEST no-proposal reason: promote a
  // no_plausible_match (or none) to 'already_settled' when a settled bank line
  // already covers this document's amount, so the goal evaluator resolves it to
  // met instead of opening firm limbo (CLAUDE.md two-terminal-states). Canary-
  // gated (RECONCILIATION_SETTLED_VERDICT); off → the model's reason survives.
  const recordedReason = await resolveSettledVerdictReason({
    client,
    firmId,
    clientId,
    document,
    proposalCount: llmResult.proposals.length,
    unmatchableReason: llmResult.unmatchable_reason,
    configSnapshot
  });

  // Verdict stamp — persists the model's no-proposal reason (or the fact
  // that proposals were written), so "no match" is a recorded verdict
  // rather than an absence of rows.
  await recordReconciliationEvaluation({
    client,
    firmId,
    clientId,
    targetId: documentId,
    matcherFamily: PAYMENT_CONFIRMATION_OBJECT_TYPE,
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
export const __PAYMENT_CONFIRMATION_OBJECT_TYPE = PAYMENT_CONFIRMATION_OBJECT_TYPE;
// Q8 — the exact deciding system prompt, exported for the reverse-shadow
// replay. Same-string parity; never fork this text at a call site.
export const __PAYMENT_CONFIRMATION_SYSTEM_PROMPT = SYSTEM_PROMPT;
export {
  WINDOW_DAYS as __WINDOW_DAYS,
  DEFAULT_AUTO_THRESHOLD as __DEFAULT_AUTO_THRESHOLD
} from './reconciliationLlmCore.js';
