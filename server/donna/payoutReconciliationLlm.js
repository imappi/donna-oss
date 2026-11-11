// LLM-mode reconciliation matcher for payout statements and deposit slips —
// the SEVENTH matcher on the shared `reconciliationLlmCore` (RT-18,
// docs/plan-2026-09-01-runtime-refactor-slices.md; audit F-04 part 2 / F-23;
// the round-4 Desert Rose review §A2 and §D).
//
// A `payout_statement` is a processor / POS / marketplace / delivery-platform
// settlement: gross customer sales for a period, refunds and fees deducted,
// ONE net amount transferred to the firm's bank account under a payout
// reference. A `deposit_slip` is a cash / cheque deposit at a branch,
// counter or ATM: components deposited, ONE total credited. Both are the
// firm's own revenue ARRIVING — the money_in twin of a payment
// confirmation: the bank line IS the net transfer / the deposit credit. The
// job is to find the single money_in bank line that IS this settlement —
// matching the NET (never the gross), the payout reference and the date —
// with the same processor-name / settlement-lag reasoning the sibling
// matchers exist for.
//
// This module is the payout "spec": it supplies the system prompt, the
// payout/money_in user-prompt builder, and the direction descriptors.
// Everything direction-agnostic — window math, id derivation, response
// validation, the Anthropic call, the firm-context render, and the UPSERT +
// audit + cascade + authorizeMatch gate stack — lives in
// `reconciliationLlmCore.js` and is shared with the six sibling matchers.
// authorizeMatch's gates are UNCHANGED: a material payout above the ceiling
// rests `suggested` / matched_pending_authority exactly as a bill does until
// the material auto-FYI or a delegated grant lets it auto-reconcile.
//
// THE CODING CONSEQUENCE lives downstream of the match, not here: the
// extractor persisted the settlement breakdown as signed document lines,
// and the coder receives a matched document's lines as context
// (firmDb.loadMatchedDocumentsForTransactions → transactionLlm) — so a
// money_in line matched here is coded with "Gross sales 1,250.00 /
// Processing fees −36.25" in view. The gross-up split at posting time is
// named in the RT-18 handoff (ledger post path, not this slice's region).
//
// ── Settlement note (like receipts and confirmations, UNLIKE statements) ──
// A payout / deposit is "paid by construction": the money moved when the
// document was issued. So `paymentStatusIsSettlementSignal: false` — the
// settlement guard fires only on an ACTUAL prior matched bank line
// (settledCount > 0), never on the document's intrinsic 'paid' status.
//
// Import discipline: this module imports NO writer (no firmDb) — the
// challenger registry (reconciliationReasoningChallenger.js) imports its
// prompt builders for the reverse shadow, and the boundary test pins that
// registry's transitive imports writer-free. The wrapper that owns firmDb
// access (payoutReconciliation.js) resolves the policy, builds the hook and
// gates on PAYOUT_MATCHER_ENABLED.

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
  loadFirmContext,
  makeMatchId as coreMakeMatchId,
  CANDIDATE_TX_STATUS_SQL,
  CANDIDATE_TX_EXPLAIN_SELECT_SQL,
  formatCurrentExplanationLine,
  formatCurrentExplanationNote,
  formatCandidateContextLines,
  formatRicherCandidateNote,
  describeIndistinguishableGroups,
  candidateRefForIndex,
  applyMaterialAutoFyi,
  resolveSettlementRow,
  documentHasSettlementRows,
  DEFAULT_MODEL
} from './reconciliationLlmCore.js';
import { readClientConfigSnapshot, persistConfigSnapshot, clientFlagActs } from './clientConfig.js';
import { runJevReconciliationForDocument } from './jevReconciliation.js';
// Q8 (the model lab): the compatible endpoint for an experiment-seated
// deciding rung. Fail-loud — an active policy with no endpoint refuses the
// run; never a fallback to the strong model.
import { resolveOpenAiCompatibleEndpoint } from './providerEndpoints.js';

const LOG_TAG = 'payoutReconciliationLlm';
// The FAMILY key (evaluation rows, the challenger seat, the log tag). The
// match row's matched_object_type is the document's OWN type
// (payout_statement | deposit_slip): the statement refresh's exact-reference
// tier (transactionIntel.js) writes its suggestion under the document type,
// and the core upsert conflicts on (bank line, object type, document) — so
// keying on the document type means this matcher REFRESHES that suggestion
// with its confidence, source and authorization receipt instead of leaving
// two rows for one pair (the harness caught the duplicate on the deposit
// slip: intel at 0.82 typed deposit_slip beside this matcher's 0.94 typed
// payout_statement).
const PAYOUT_MATCHER_FAMILY = 'payout_statement';
const PAYLOAD_SOURCE = 'payout_reconciliation_llm';
export const PAYOUT_MATCHER_DOCUMENT_TYPES = Object.freeze(['payout_statement', 'deposit_slip']);

// Payout-specific bits of the (otherwise shared) firm-context render. The
// counterparty is the PROVIDER that paid the firm — a processor, platform
// or (for a deposit slip) the firm's own bank crediting the deposit.
const FIRM_ANCHOR_COUNTERPARTY_CLAUSE =
  `The provider that paid this settlement in (the payment processor, POS provider, marketplace or delivery platform; for a deposit slip, the firm's own bank crediting the deposit) is the counterparty you are matching. The bank line's counterparty should correspond to that provider or its payment rail — never an individual customer, never the firm itself as a payer, and never an unrelated third party.`;
const SETTLEMENT_DOC_NOUN = 'settlement';

// Module-facing id helper pins the object type; the shared core derives the
// actual id. Signature kept as (clientId, txId, docId) for callers and the
// test suite.
export const makeMatchId = (clientId, txId, docId, objectType = PAYOUT_MATCHER_FAMILY) =>
  coreMakeMatchId({ clientId, txId, objectType, docId });

// Re-exported from the shared core so callers keep resolving (window math +
// response validation live in the core).
export { computeWindow, isWithinWindow, parseProposeMatchesResponse };

const SYSTEM_PROMPT = `You match a parsed payout statement or deposit slip to bank transactions for a bookkeeping system.

You receive:
- One parsed settlement document. Either a PAYOUT STATEMENT — a payment processor, card acquirer, POS provider, marketplace or delivery platform (Stripe, Square, Adyen, PayPal, Shopify Payments, Clover, SumUp, Toast, Deliveroo, Talabat, Uber Eats, Careem, DoorDash, Just Eat, Amazon, Etsy, …) settling the firm's own customer sales: gross sales for a period, refunds and fees deducted, ONE net amount transferred to the firm's bank account under a payout reference — or a DEPOSIT SLIP: cash and/or cheques the firm paid into its own account at a branch, counter or ATM, ONE total credited. Money flows IN to the firm. It is intrinsically settled — the document IS the record of the money moving.
- A list of candidate bank transactions on the firm's account in the eligible direction (money_in) and a generous date window.
- Optional firm context: the firm's identity, the settlement state of this document, and recent confirmed matches as few-shot examples.

Your job: identify which bank transaction IS this settlement. The match is one-to-one — the document's NET amount ↔ the single credit that landed on the firm's account.

The NET is what the bank shows — never the gross:
- The bank line equals the document's net_payout (gross − refunds − fees ± adjustments), not its gross sales. A candidate equal to the GROSS is not this settlement.
- The document's own breakdown is supplied so you can see how the net was reached. When the net line on the statement does not foot to its printed components, the net is still the amount that was transferred — match on the net.
- A processor occasionally splits one statement's net across two transfers (a reserve release paid separately, a currency-split payout). Then the two credits together equal the net: propose both with "partial_payment" in hops and say so in the reasoning.

A CONSOLIDATED statement (a monthly summary / koontilasku / batch report) LISTS SEVERAL SETTLEMENTS — the breakdown below then carries numbered SETTLEMENT ROWS, each with its own period, gross, fee and NET, and each row was paid to the bank separately. Then the match is row-level, never statement-level:
- Propose ONE bank credit per row at THAT row's NET, and name the row with the hop "statement_row:<n>" (the row number as listed). Never propose the statement's total; never leave a proposal on such a statement without its row hop.
- A credit equal to a row's GROSS is not that row (the fee was deducted before the bank saw it).
- Never use "partial_payment" for a listed row: the row IS one full settlement. Proposals against DIFFERENT rows are not competing candidates — separation is judged among candidates for the same row only.
- A row marked as already settled is not open; do not propose against it. A row whose paid date lies after the bank feed's last day has simply not arrived yet — do not force a credit onto it.

Bridge real-world hops the deterministic scorer cannot:
- Provider naming: the credit posts under the provider's rail or legal name, not the brand on the statement — "STRIPE PAYMENTS UK", "ADYEN NV", "PAYPAL PTE", "ROOFOODS" (Deliveroo), "SQUAREUP", "CLOVER SETTLEMENT", "AMZN MKTP PAYOUT", "SUMUP PAYMENTS" — often with the payout reference, a batch id or a merchant id in the description.
- Reference discipline: the payout reference / settlement id / deposit slip number quoted verbatim in the bank description is the strongest possible signal, stronger than the date.
- Settlement lag: a payout credits on the payout date or 0-3 business days after it; a counter or ATM deposit credits the same day or the next business day; cross-border payouts (a marketplace paying in from abroad) can take 1-5 days and may arrive FX-converted — recognise the net converted at a plausible rate, and treat the original currency + amount quoted in the description as a strong signal.
- Deposit slips: the credit is described as a cash / counter / cheque / ATM deposit ("CASH DEP", "COUNTER CREDIT", "CHQ DEP", "ATM DEPOSIT", "PAYING IN") with the slip reference or branch, on or after the slip date; a cheque deposited may credit a day or two later than the cash.

Counterparty discipline — the single most important guardrail, weigh it ABOVE amount:
- The bank line's counterparty must be reconcilable with THIS document's provider (or its payment rail). A matching amount alone is NOT sufficient: a customer transfer, an owner injection or an unrelated refund can coincide on amount. A credit that clearly names a DIFFERENT party — an individual customer, another business, the owner — is strong evidence AGAINST a match; do not propose it on amount alone, or at most well below 0.5.
- For a deposit slip the counterparty is the firm's own bank's deposit channel, so the description's deposit wording + the slip reference / date carry the weight.

Indistinguishable candidates — surface every tie, never silently pick one:
- A provider paying the firm on a fixed cadence produces several same-amount payouts and several same-amount credits. Pair THIS document with the candidate whose date and reference fit ITS payout date and reference; give the date-misaligned same-amount siblings low confidence.
- When two or more candidates are genuinely indistinguishable (same amount, same provider wording, adjacent dates, no reference singling one out), propose EVERY tied line as its own proposal with equal, moderate confidence (~0.6-0.7) so a human can choose — never collapse them or drop one.

Settlement awareness:
- A payout statement or deposit slip is intrinsically settled — do NOT decline a match merely because its recorded payment status is "paid"; that is its normal state. Decline only when you are told an ACTUAL prior bank line already matched THIS document: then return "proposals": [] with "unmatchable_reason": "already_settled".

Return a JSON object with this exact shape:

{
  "proposals": [
    {
      "candidate_ref": "candidate_1",
      "confidence": 0.92,
      "reasoning": "Brief one-or-two-sentence explanation.",
      "hops": ["reference_match", "processor:stripe", "settlement_lag_1d"]
    }
  ],
  "unmatchable_reason": null
}

Rules:
- candidate_ref MUST be a verbatim candidate_ref from the candidate list. Never invent one. Candidate bank-line database ids are intentionally not shown.
- "hops" is a categorical array of lowercase tokens. Use any of: "amount_exact", "amount_near", "reference_match", "vendor_overlap", "within_window", "fx_conversion_<FROM>_<TO>", "processor:<name>", "settlement_lag_<N>d", "partial_payment", "amount_in_description", "deposit_channel", "statement_row:<n>" (a consolidated statement's listed row, required on every proposal against such a statement).
- confidence is a 0..1 number. Calibrate it to the standard of a competent human bookkeeper who has this firm's context: would they call this the same settlement in seconds? When the net corresponds (exactly, or through a plausible FX chain), the provider or reference is on the line, the date aligns, and no other candidate competes, that IS a clear match — score 0.85-0.95. The system is built for cheap undo: a wrong match is one click to reject and every status it cascaded reverts, while a withheld match leaves the firm's revenue unreconciled. Score 0.6-0.8 when something would give a bookkeeper pause — several candidates fit equally, loose dates, a provider name that does not reconcile. A coincidental round-amount credit with no provider or reference signal is at most ~0.5. A description quoting the payout reference or slip number verbatim is worth ~0.95.
- When NO bank line is a plausible match, return "proposals": [] and "unmatchable_reason": "no_plausible_match" (or a more specific reason).
- When the bank feed is missing or clearly truncated, return "unmatchable_reason": "insufficient_bank_feed".
- Return ONLY valid JSON. No markdown, no commentary.`;

const formatBankLine = (line, idx) => {
  const amount = line.money_in ?? 0;
  return `  ${idx + 1}. candidate_ref=${candidateRefForIndex(idx)}
     date=${line.date || 'unknown'}
     money_in=${amount} ${line.currency || ''}
     description="${line.description || ''}"
     raw_description="${line.raw_description || ''}"
     contact="${line.contact || ''}"${formatCandidateContextLines(line, 'money_in')}${formatCurrentExplanationLine(line)}`;
};

const formatFewShot = (example, idx) =>
  `${idx + 1}. settlement: ${example.vendor_name || '(no provider)'} net ${example.doc_amount} ${example.doc_currency || ''} on ${example.doc_date}
     matched bank line: ${example.tx_amount} ${example.tx_currency || ''} on ${example.tx_date} ("${example.tx_description || ''}")
     hops: ${(example.hops || []).join(', ') || '(none recorded)'}`;

const money = (value) => (value == null ? 'unknown' : String(value));

// The settlement breakdown the extractor persisted (parse_summary.settlement)
// rendered for the model — so the NET on the bank feed can be read against
// the gross it came from, and a non-footing statement is visible as such.
const formatSettlementBreakdown = (document) => {
  const settlement = document?.parse_summary?.settlement;
  if (!settlement || typeof settlement !== 'object') return null;
  const lines = [];
  if (settlement.gross_sales != null) lines.push(`  gross_sales=${settlement.gross_sales} ${settlement.currency || document.currency || ''}`);
  if (settlement.refunds) lines.push(`  refunds=${settlement.refunds}`);
  if (Array.isArray(settlement.fees) && settlement.fees.length) {
    for (const fee of settlement.fees) {
      const tax = fee.tax_amount ? ` (tax on fee ${fee.tax_amount})` : '';
      lines.push(`  fee: ${fee.description || 'fee'} ${money(fee.amount)}${tax}`);
    }
  }
  if (Array.isArray(settlement.adjustments) && settlement.adjustments.length) {
    for (const adjustment of settlement.adjustments) {
      lines.push(`  adjustment: ${adjustment.description || 'adjustment'} ${money(adjustment.amount)}`);
    }
  }
  if (settlement.net_payout != null) lines.push(`  net_payout=${settlement.net_payout} ${settlement.currency || document.currency || ''}`);
  if (settlement.transaction_count != null) lines.push(`  transaction_count=${settlement.transaction_count}`);
  // RT-21c: the listed settlement rows (RT-21b persisted them as document
  // lines at their NET; the runner loads them as document.settlement_lines).
  // Each is what ONE bank credit settles; a settled row says so.
  const rowLines = Array.isArray(document?.settlement_lines) ? document.settlement_lines : [];
  if (rowLines.length) {
    lines.push(`  SETTLEMENT ROWS (${rowLines.length} listed settlements — match ONE credit per open row at the row's NET, hop statement_row:<n>):`);
    for (const line of rowLines) {
      const r = line.settlement_row || {};
      const bits = [
        `statement_row:${line.line_no}`,
        line.description || r.period_label || `row ${line.line_no}`,
        r.period_start && r.period_end ? `period ${r.period_start}..${r.period_end}` : null,
        r.gross != null ? `gross ${money(r.gross)}` : null,
        r.fee != null ? `fee ${money(r.fee)}${r.fee_tax ? ` (+tax ${money(r.fee_tax)})` : ''}` : null,
        `NET ${money(line.amount)} ${settlement.currency || document.currency || ''}`,
        r.paid_on ? `paid ${r.paid_on}` : null,
        r.transaction_count != null ? `${r.transaction_count} transactions` : null,
        r.reference ? `reference "${r.reference}"` : null,
        line.settled_by_bank_transaction_id ? 'ALREADY SETTLED by a prior matched bank line — not open' : 'open'
      ].filter(Boolean);
      lines.push(`    - ${bits.join(' · ')}`);
    }
  }
  if (settlement.bank_last4) lines.push(`  paid_to_bank_account_ending=${settlement.bank_last4}`);
  const totals = document?.parse_summary?.totals_validation;
  if (totals && totals.matches === false) {
    lines.push(`  NOTE: the printed components do not foot to the net (expected ${totals.expected}, printed net ${totals.total}, drift ${totals.drift}) — the net is still what was transferred.`);
  }
  return lines.length ? `Settlement breakdown (from the document):\n${lines.join('\n')}` : null;
};

export const buildProposeMatchesUserPrompt = ({ document, candidateBankLines, firmContext, datePairs = true }) => {
  const sections = [];
  const settlement = document?.parse_summary?.settlement || {};
  const kind = document.document_type === 'deposit_slip' ? 'Deposit slip' : 'Payout statement';

  sections.push(`${kind}:
  id=${document.id}
  document_type=${document.document_type || 'payout_statement'}
  provider="${document.vendor_name || ''}"
  net_amount=${document.total_amount} ${document.currency || ''}
  payout_date=${document.document_date || 'unknown'}
  settlement_period=${settlement.period_start || 'unknown'} to ${settlement.period_end || 'unknown'}
  payout_reference="${document.reference_number || ''}"
  payment_status=${document.payment_status || 'unknown'}`);

  const breakdown = formatSettlementBreakdown(document);
  if (breakdown) sections.push(breakdown);

  const firmAnchor = formatFirmAnchor(firmContext?.clientIdentity, FIRM_ANCHOR_COUNTERPARTY_CLAUSE);
  if (firmAnchor) sections.push(firmAnchor);

  const settlementNote = formatSettlement(firmContext?.settlement, SETTLEMENT_DOC_NOUN);
  if (settlementNote) sections.push(settlementNote);

  if (firmContext?.recentConfirmedMatches?.length) {
    sections.push(`Recent confirmed matches for this client (few-shot):
${firmContext.recentConfirmedMatches.slice(0, FEW_SHOT_LIMIT).map(formatFewShot).join('\n')}`);
  }

  if (!candidateBankLines || candidateBankLines.length === 0) {
    sections.push('Candidate bank transactions (money_in, within ±90 days of the payout date): NONE.');
  } else {
    sections.push(`Candidate bank transactions (money_in, within ±90 days of the payout date):
${candidateBankLines.map(formatBankLine).join('\n')}`);
    const richerNote = formatRicherCandidateNote(candidateBankLines, 'money_in');
    if (richerNote) sections.push(richerNote);
    const explanationNote = formatCurrentExplanationNote(candidateBankLines);
    if (explanationNote) sections.push(explanationNote);
    const tieNote = describeIndistinguishableGroups(candidateBankLines, document, { datePairs });
    if (tieNote) sections.push(tieNote);
    // Distinct-date twin pairing: a provider on a fixed payout cadence
    // produces same-amount credits told apart by DATE and REFERENCE — not
    // a tie. The tie note above already excludes the date-separated group.
    if (datePairs) {
      sections.push(`Same-amount payouts from one provider are usually DISTINCT settlements, told apart by DATE and REFERENCE — not a tie:
- A provider paying the firm on a fixed cadence produces several same-amount statements and several same-amount credits. Pair THIS document with the candidate whose date best fits ITS payout date (the credit lands on or within 0-3 business days after the payout date, essentially never before it) and whose description quotes ITS reference when one is shown. Score that candidate like any clear match (0.85-0.95) and give the date-misaligned same-amount siblings low confidence. Only treat them as an equal-confidence tie when they are genuinely date-indistinguishable (same date, no reference, no closer fit).`);
    }
  }

  return sections.join('\n\n');
};

// Twin-date pairing is foundational. One exported resolution seam so the
// deciding call and the reverse-shadow replay stay byte-identical.
export const resolvePayoutDatePairs = () => true;

// One LLM call. Returns `{ proposals, unmatchable_reason }`. Throws only on
// transport errors — schema parsing returns empty proposals + an explicit
// `unmatchable_reason`. Thin wrapper over the shared core: supplies the
// payout system prompt + user prompt.
export const proposeMatches = async ({
  document,
  candidateBankLines,
  firmContext = null,
  apiKey,
  model = DEFAULT_MODEL,
  fetchImpl,
  clientId = null,
  configSnapshot = null,
  transport = null
} = {}) => {
  if (!apiKey && transport?.provider !== 'openai_compatible') {
    return { proposals: [], unmatchable_reason: 'no_api_key' };
  }
  if (!document || !document.id) {
    return { proposals: [], unmatchable_reason: 'no_document' };
  }

  const datePairs = resolvePayoutDatePairs({ clientId, configSnapshot });
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

// Orchestrator. Same stats shape as the sibling matchers so the statement-
// side orchestrator's `accumulate(stats)` works unchanged. Prefers throwing
// on infrastructure problems (DB errors) to returning bogus stats — fail
// loud; the caller's per-document try/catch counts the error.
export const runPayoutReconciliationLlmForDocument = async ({
  client,
  firmId,
  clientId,
  documentId,
  apiKeyOverride,
  modelOverride,
  fetchImpl,
  // Q8 (the model lab): the lane's active model-policy row, resolved by the
  // WRAPPER per (firm, client). A non-claude qualified rung decides over
  // the openai_compatible endpoint — same prompts, parser, gates, cascade.
  decidingPolicy = null,
  // Q8: the reverse-shadow hook (built by the wrapper). Fired post-stamp,
  // fire-and-forget, throw-guarded.
  challengerHook = null
} = {}) => {
  if (!client || !firmId || !clientId || !documentId) return ZERO_STATS();
  const jevConfig = await readClientConfigSnapshot(client, { firmId, clientId, strict: true });
  if (clientFlagActs({ flagKey: 'JEV_RECONCILIATION', snapshot: jevConfig, envFallback: () => false })) {
    const first = await runJevReconciliationForDocument({ client, firmId, clientId, documentId, configSnapshot: jevConfig, fetchImpl, family: 'payout_statement' });
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
  // Anthropic-decided path (the sibling precedent).
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
        and document_type in ('payout_statement', 'deposit_slip')
        and parse_status = 'completed'
        and total_amount is not null
        and duplicate_of is null`,
    [firmId, clientId, documentId]
  );
  if (!docResult.rows.length) return ZERO_STATS();
  const document = docResult.rows[0];
  const objectType = PAYOUT_MATCHER_DOCUMENT_TYPES.includes(document.document_type)
    ? document.document_type
    : PAYOUT_MATCHER_FAMILY;

  const window = computeWindow(document);

  // money_in only, not already resolved — except bank-line-only explains,
  // which stay visible so document evidence can outrank them
  // (CANDIDATE_TX_STATUS_SQL in the core). Window-narrowing happens
  // post-query in JS so the SQL mirrors the AR matcher's tx query.
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
        and money_in > 0
        and (money_out is null or money_out = 0)
        and ${CANDIDATE_TX_STATUS_SQL}
      order by transaction_date asc, id asc`,
    [firmId, clientId]
  );

  const candidateBankLines = window
    ? txResult.rows.filter((tx) => isWithinWindow(tx, window))
    : txResult.rows;

  const existingResult = await client.query(
    `select id, bank_transaction_id, matched_object_type, matched_object_id,
            status, match_amount, match_confidence, payload, matched_line_id
       from reconciliation_matches
      where firm_id = $1
        and client_id = $2
        and matched_object_type in ('payout_statement', 'deposit_slip')
        and matched_object_id = $3`,
    [firmId, clientId, documentId]
  );

  // RT-21c: the statement's settlement rows (RT-21b — one document line per
  // listed settlement at its NET, the printed breakdown under
  // payload.raw_extraction.settlement_row). A row already settled by an
  // auto_matched / confirmed bank line is closed; the model is told so and
  // the gates refuse a second settlement of it. Missing table/column
  // (pre-migration) reads as "no rows" — the one-to-one contract, unchanged.
  const settlementLinesResult = await client.query(
    `select id, line_no, description, amount,
            payload->'raw_extraction'->'settlement_row' as settlement_row
       from document_lines
      where firm_id = $1
        and document_id = $2
        and payload->'raw_extraction'->'settlement_row' is not null
      order by line_no asc`,
    [firmId, documentId]
  ).catch((error) => {
    if (error?.code === '42P01' || error?.code === '42703') return { rows: [] };
    throw error;
  });
  const settledLineBy = new Map();
  for (const row of existingResult.rows) {
    if (row.matched_line_id && (row.status === 'confirmed' || row.status === 'auto_matched')) {
      settledLineBy.set(String(row.matched_line_id), row.bank_transaction_id);
    }
  }
  document.settlement_lines = (settlementLinesResult.rows || []).map((line) => ({
    id: line.id,
    line_no: Number(line.line_no),
    description: line.description || null,
    amount: line.amount == null ? null : Number(line.amount),
    settlement_row: line.settlement_row && typeof line.settlement_row === 'object' ? line.settlement_row : null,
    settled_by_bank_transaction_id: settledLineBy.get(String(line.id)) || null
  }));
  const rowDocument = documentHasSettlementRows(document);
  const openRows = document.settlement_lines.filter((line) => !line.settled_by_bank_transaction_id);

  const suppressed = {
    rejected: new Set(),
    confirmed: new Set(),
    auto_matched: new Set()
  };
  // Settlement-to-date: how many bank lines already settle THIS document.
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

  // Few-shot examples: last N confirmed/auto-matched payouts for this client.
  const fewShotResult = await client.query(
    `select m.match_amount, m.payload,
            t.description as tx_description,
            t.transaction_date as tx_date,
            t.money_in as tx_amount,
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
        and m.matched_object_type in ('payout_statement', 'deposit_slip')
        and m.status in ('confirmed', 'auto_matched')
      order by m.created_at desc
      limit $3`,
    [firmId, clientId, FEW_SHOT_LIMIT]
  );

  // Firm identity + settlement state. No known-counterparty roster: the
  // firm's customers are not who pays a payout in (the provider is), and
  // the provider is on the document. paymentStatusIsSettlementSignal=false:
  // a payout is intrinsically 'paid', so only an actual prior matched bank
  // line (settledCount) counts as settlement — see the module header.
  const { clientIdentity, settlement } = await loadFirmContext({
    client,
    firmId,
    clientId,
    document,
    // On a row document the settlement state is PER ROW (rendered in the
    // breakdown); the document-level "already matched, only propose a
    // further match on unambiguous evidence" note would wrongly discourage
    // the open rows. It applies only once every row is settled.
    settledCount: rowDocument ? (openRows.length === 0 ? settledCount : 0) : settledCount,
    counterpartyRole: null,
    paymentStatusIsSettlementSignal: false
  });

  const firmContext = {
    clientIdentity,
    settlement,
    knownCounterparties: [],
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

  // Drop suppressed pairs BEFORE the LLM call.
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

  // RT-21c: every listed row already settled ⇒ the statement is settled; no
  // model call, the honest already_settled verdict on the record.
  if (rowDocument && openRows.length === 0) {
    console.log(`[${LOG_TAG}] every settlement row already settled`, {
      document_id: documentId,
      row_count: document.settlement_lines.length
    });
    await recordReconciliationEvaluation({
      client,
      firmId,
      clientId,
      targetId: documentId,
      matcherFamily: PAYOUT_MATCHER_FAMILY,
      verdict: 'no_match',
      unmatchableReason: 'already_settled',
      candidateCount: candidateBankLines.length,
      eligibleCount: eligibleBankLines.length,
      logTag: LOG_TAG
    });
    return stats;
  }

  if (eligibleBankLines.length === 0) {
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
      matcherFamily: PAYOUT_MATCHER_FAMILY,
      verdict: 'no_candidates',
      candidateCount: candidateBankLines.length,
      eligibleCount: 0,
      logTag: LOG_TAG
    });
    return stats;
  }

  // Resolve + persist the per-client config snapshot ONCE per run so each
  // auto-match decision recorded below references the config it ran under.
  const configSnapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  const runConfigSnapshotId = await persistConfigSnapshot(client, { firmId, clientId, snapshot: configSnapshot });

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

    const matchAmount = Number(bankLine.money_in || 0);
    // authorizeMatch — UNCHANGED gates: the model chose the line; the Keep
    // layer decides only whether that judgment executes unattended
    // (materiality ceiling, ambiguity/twin guard, amount reconciliation,
    // currency parity, the client allowlist).

    // RT-21c: the row this proposal names (null on a one-to-one statement, or
    // when the hop names no / an unknown row — authorizeMatch then refuses
    // with statement_row_required / unknown_statement_row).
    const settlementRow = resolveSettlementRow({ document, hops: proposal.hops });
    const authorization = authorizeMatch({
      proposal,
      allProposals: llmResult.proposals,
      bankLine,
      candidateBankLines: eligibleBankLines,
      document,
      matchAmount,
      clientId,
      policy,
      configSnapshot,
      settlementRow
    });

    // A still-held no-grant material match auto-reconciles + FYIs the owner
    // instead of resting on a firm click, behind its own plane flag; a no-op
    // when not materiality-held or the flag is off.
    const effectiveAuthorization = applyMaterialAutoFyi(authorization, { clientId, configSnapshot });

    await upsertMatchAndCascade({
      client,
      firmId,
      clientId,
      proposal,
      document,
      objectType,
      matchAmount,
      autoThreshold,
      authorization: effectiveAuthorization,
      returnedModel: llmResult.model || model,
      policyBasis,
      source: PAYLOAD_SOURCE,
      matchKind: objectType,
      unmatchableReason: llmResult.unmatchable_reason || null,
      logTag: LOG_TAG,
      configSnapshotId: runConfigSnapshotId,
      stats,
      settlementRow
    });
  }

  // Record the HONEST no-proposal reason: promote a no_plausible_match (or
  // none) to 'already_settled' when a settled bank line already covers this
  // document's amount (the sibling precedent).
  const recordedReason = await resolveSettledVerdictReason({
    client,
    firmId,
    clientId,
    document,
    proposalCount: llmResult.proposals.length,
    unmatchableReason: llmResult.unmatchable_reason,
    configSnapshot
  });

  // Verdict stamp — "no match" is a recorded verdict, never an absence of
  // rows. Carries the provider-RETURNED model id (the receipt).
  await recordReconciliationEvaluation({
    client,
    firmId,
    clientId,
    targetId: documentId,
    matcherFamily: PAYOUT_MATCHER_FAMILY,
    verdict: llmResult.proposals.length ? 'proposed' : 'no_match',
    unmatchableReason: recordedReason,
    proposalCount: llmResult.proposals.length,
    candidateCount: candidateBankLines.length,
    eligibleCount: eligibleBankLines.length,
    model: llmResult.model || model,
    payload: policyBasis
      ? { policy_basis: policyBasis, model_source: llmResult.model_source || null }
      : null,
    recordDecision: true,
    configSnapshotId: runConfigSnapshotId,
    logTag: LOG_TAG
  });

  // POST-STAMP reverse shadow (evidence + receipt only).
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

// Re-exports for tests. Threshold/window constants are re-exported straight
// from the core (not copied into a local const) so they are not read during
// this module's evaluation — core ↔ firmDb ↔ parseDocumentsDb form an import
// cycle and an init-time read would hit the core binding's temporal dead zone.
export const __PAYOUT_MATCHER_FAMILY = PAYOUT_MATCHER_FAMILY;
export const __PAYOUT_PAYLOAD_SOURCE = PAYLOAD_SOURCE;
// The exact deciding system prompt, exported for the reverse-shadow replay.
// Same-string parity; never fork this text at a call site.
export const __PAYOUT_SYSTEM_PROMPT = SYSTEM_PROMPT;
export {
  WINDOW_DAYS as __WINDOW_DAYS,
  DEFAULT_AUTO_THRESHOLD as __DEFAULT_AUTO_THRESHOLD
} from './reconciliationLlmCore.js';
