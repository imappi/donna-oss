// LLM-mode reconciliation matcher for sales invoices — Slice E (AR).
//
// Replaces the weighted `scoreCandidate` matcher with a single
// strong-LLM call per unmatched sales_invoice. PRIMARY, unconditionally
// (batch-2 terminal state 1: the RECONCILIATION_MATCHER_MODE gate is
// deleted); falls back to the weighted matcher when this matcher
// self-disables (no API key) or the LLM call fails.
//
// Why LLM mode exists at all: the weighted matcher's signals
// (amount × 0.45 + date × 0.30 + vendor × 0.25, currency demoted to
// a warning) cannot bridge FX + payment-processor intermediation +
// no-separate-receipt in one hop. An invoice in GBP
// settled in EUR via a payment-link processor produced ZERO matches
// under the weighted matcher even though a human reviewer spots the
// link instantly. The hand-coded `scoreCandidate` is the canonical
// example of intelligence-substituting scaffolding from CLAUDE.md
// and `docs/donna-llm-trust-strategy.md` Failure B. The LLM matcher
// gives the strong model the document, the candidate bank lines,
// and the firm's context (recent confirmed matches as few-shot),
// and trusts what it says.
//
// This module is the AR "spec": it supplies the system prompt, the
// invoice/money_in user-prompt builder, and the four SQL queries.
// Everything direction-agnostic — window math, id derivation,
// response validation, the Anthropic call, and the UPSERT + audit +
// cascade block — lives in `reconciliationLlmCore.js` and is shared
// with the supplier-bill (AP) matcher.
//
// Output schema includes a `hops` array — categorical labels like
// `["fx_conversion_GBP_EUR", "processor:stripe", "settlement_lag_3d"]`
// — so the audit trail captures *why* a match was made, not just
// that it was. `hops` rides on `payload.match_reason.hops` (same
// shape as the weighted matcher's `hints`) and in the audit_events
// metadata.

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
  formatCandidateContextLines,
  formatRicherCandidateNote,
  describeIndistinguishableGroups,
  candidateRefForIndex,
  applyMaterialAutoFyi,
  clientAllowedToAutoMatch,
  DEFAULT_MODEL
} from './reconciliationLlmCore.js';
// RT-27 — credit notes in the AR matcher's context: the customer's eligible
// credit notes ride the prompt with call-local handles; the model selects,
// the runtime validates under the write lock and applies them atomically
// with the settlement (creditNoteApplications.js is the Keep layer).
import { isProviderFailure } from './providerTransport.js';
import {
  CREDIT_NOTE_PAYMENT_STATUS,
  CREDIT_REFUSAL_CODES,
  loadEligibleCreditNotes,
  formatCreditNotes,
  planCreditApplications,
  lockAndRevalidateCreditNotes,
  buildCreditReceipt,
  withCreditApplicationTransaction,
  applyCreditApplicationsWithClient,
  authorizeCreditOnlyApplication,
  loadInvoicesToReconsiderForCreditNote
} from './creditNoteApplications.js';
import { readClientConfigSnapshot, persistConfigSnapshot, clientFlagActs } from './clientConfig.js';
import { runJevReconciliationForDocument } from './jevReconciliation.js';
// Q7 (the model lab): the compatible endpoint for an experiment-seated
// deciding rung. Resolution is fail-loud — an active policy with no
// endpoint refuses the run; it never falls back to the strong model.
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

const LOG_TAG = 'salesInvoiceReconciliationLlm';
const SALES_INVOICE_OBJECT_TYPE = 'sales_invoice';
const PAYLOAD_SOURCE = 'sales_invoice_reconciliation_llm';

// AR-specific bits of the (otherwise shared) firm-context render. The
// firm anchor's one direction-specific sentence + the settlement noun;
// the core formatters supply everything else. See reconciliationLlmCore
// formatFirmAnchor / formatSettlement.
const FIRM_ANCHOR_COUNTERPARTY_CLAUSE =
  `The invoice's customer is the counterparty you are matching. The bank line's payer should correspond to that customer (or a processor settling on their behalf) — never the firm itself, and never an unrelated third party.`;
const SETTLEMENT_DOC_NOUN = 'invoice';
// Direction descriptor for the shared known-counterparties renderer —
// AR matches against the firm's CUSTOMERS (who pay us).
const KNOWN_COUNTERPARTIES_DESCRIPTOR = {
  noun: 'customers',
  verb: 'invoices',
  selfNoun: "this invoice's customer"
};
const COUNTERPARTY_ROLE = 'customer';


// Module-facing id helper pins the object type; the shared core
// derives the actual id. Signature kept as (clientId, txId, docId)
// for callers and the test suite.
// Twin-date pairing is foundational. Keep one exported resolution seam so the
// deciding call and reverse-shadow replay stay byte-identical.
export const resolveSalesInvoiceDatePairs = () => true;

export const makeMatchId = (clientId, txId, docId) =>
  coreMakeMatchId({ clientId, txId, objectType: SALES_INVOICE_OBJECT_TYPE, docId });

// Re-exported from the shared core so existing imports of this module
// keep resolving (window math + response validation moved to the core
// during the Slice E cleanup pass).
export { computeWindow, isWithinWindow, parseProposeMatchesResponse };

const SYSTEM_PROMPT = `You match a parsed sales invoice to bank transactions for a bookkeeping system.

You receive:
- One parsed sales invoice (the document).
- A list of candidate bank transactions on the firm's account in the eligible direction (money_in) and a generous date window.
- Optional firm context: the firm's identity, its known customers, the invoice's settlement state, and recent confirmed matches as few-shot examples.

Your job: identify which bank transaction(s), if any, settled this invoice. The match may be one-to-one, or one-to-many when a payment-processor payout bundles several invoices into a single bank line.

Bridge real-world hops the deterministic scorer cannot:
- FX conversion: a GBP 745 invoice may settle in EUR after the bank's FX. Recognise this when the EUR amount equals the GBP amount times a plausible rate.
- Payment processors: Stripe, iDEAL, PayPal, Adyen, Klarna, GoCardless, Mollie etc. settle on the firm's bank as a single payout that aggregates many invoices and clears days after the customer paid. The bank description will read like "Stripe payout" or "iDEAL settlement", NOT the customer's name.
- Settlement lag: processor payouts typically land 1-7 days after the customer paid; FX-converted wires can take 1-3 days.
- Partial payments: an invoice may be paid across several bank lines.

Counterparty discipline — the single most important guardrail, weigh it ABOVE amount:
- The bank line's payer (the name in its description / contact) must be reconcilable with THIS invoice's customer, OR be a payment processor that settles on the customer's behalf. A matching amount — including an FX-converted amount — is NOT sufficient on its own. Amounts coincide across unrelated currencies constantly; that is a coincidence, not a settlement.
- If the bank line clearly comes from a DIFFERENT party — a different company, or an individual unrelated to the customer — and there is no payment-processor payout that explains the name, treat that as strong evidence AGAINST a match. Do NOT propose it on amount or FX alone: return no proposal for that line, or at most a confidence well below 0.5.
- An FX or cross-currency amount is only a STRONG match when the payer corresponds to the customer (or a known processor) OR the invoice's original currency + amount is quoted verbatim in the bank description. Absent one of those, an FX amount coincidence is weak evidence at best.

Indistinguishable candidates — surface every tie, never silently pick one:
- When two or more candidate lines are equally plausible and nothing visible tells you WHICH one settled THIS invoice — same amount, same currency, a payer that reconciles with the customer, adjacent dates, and no reference number or other field singling one out — propose EVERY one of those tied lines as its own proposal. Do NOT choose one and drop the rest, and do NOT collapse them into a single proposal: surfacing only one hides the alternative a human needs to disambiguate, and which one you would have picked is a coin-flip.
- Give the tied lines equal, moderate confidence (~0.6-0.7). Only one of them actually settled the invoice; you are surfacing the candidates for a human to choose, not asserting that all of them did.
- This is NOT the one-to-many case: a processor payout or installment plan is several lines that TOGETHER settle one invoice, whereas a tie is several lines any ONE of which alone could be the settlement. A line from a clearly DIFFERENT party is not a tie — counterparty discipline above still rules it out.

Settlement awareness:
- You may be told this invoice is already partially or fully settled by other bank lines. If it is FULLY settled, only propose a further match when there is unambiguous evidence of a separate, additional payment for this same invoice; otherwise return "proposals": [] with "unmatchable_reason": "already_settled".
- You may be told the remaining due after prior settlements and applied credit notes. Match the bank line against the REMAINING due, not the printed total, when prior settlement exists.

Customer credit notes:
- You may be shown this customer's open credit notes (credit_ref handles). A credit note reduces what the customer owes on an invoice and never appears as a bank line: a customer who was invoiced 2 008,00 and credited 376,50 pays 1 631,50. When a bank line equals the invoice's remaining due minus one or more of those credits, propose the line AND name the credits it consumes in "applied_credits". Score such a settlement like any clear match — the arithmetic closing to the cent with the customer's own credit note is strong evidence.
- Select a credit only when this invoice consumes it (the arithmetic closes, or the credit cites this invoice's number). Never subtract a credit merely because the customer has one.
- When the credit note(s) alone settle the remaining due and no bank line is involved, return "proposals": [] and name them in "credit_applications".

Return a JSON object with this exact shape:

{
  "proposals": [
    {
      "candidate_ref": "candidate_1",
      "confidence": 0.92,
      "reasoning": "Brief one-or-two-sentence explanation.",
      "hops": ["fx_conversion_GBP_EUR", "processor:stripe", "settlement_lag_3d"],
      "applied_credits": ["credit_1"]
    }
  ],
  "credit_applications": [],
  "unmatchable_reason": null
}

Rules:
- candidate_ref MUST be a verbatim candidate_ref from the candidate list. Never invent one. Candidate bank-line database ids are intentionally not shown.
- "applied_credits" lists the credit_ref handles of the customer credit notes this settlement consumes (omit or [] when none were shown or none apply). "credit_applications" is for credits that settle the remaining due WITHOUT a bank line: [{"credit_ref": "credit_1", "confidence": 0.9, "reasoning": "..."}]; otherwise []. credit_ref MUST be a verbatim credit_ref from the credit-note list; credit-note database ids are intentionally not shown.
- "hops" is a categorical array of lowercase tokens. Use any of: "amount_exact", "amount_near", "reference_match", "customer_overlap", "within_window", "fx_conversion_<FROM>_<TO>", "processor:<name>", "settlement_lag_<N>d", "partial_payment".
- confidence is a 0..1 number. Calibrate it to the standard of a competent human bookkeeper who has this firm's context: would they call this settled in seconds? When the amount corresponds (exactly, or through a plausible FX/fee chain), the date aligns, and no other candidate competes for the same explanation, that IS a clear match — score 0.85-0.95. The system is built for cheap undo: a wrong match is one click to reject and every status it cascaded reverts, while a withheld match silently misstates the books. Score 0.6-0.8 when something would genuinely give a bookkeeper pause — several candidates fit equally, a strained rate, loose dates, or a counterparty name that does not reconcile with the invoice's. A coincidental round-amount match with no other evidence is at most ~0.5. A description that quotes the invoice's original currency + amount verbatim (even when the structured currency disagrees due to FX) is worth ~0.9.
- When NO bank line is a plausible match, return "proposals": [] and "unmatchable_reason": "no_plausible_match" (or a more specific reason).
- When the bank feed is missing or clearly truncated, return "unmatchable_reason": "insufficient_bank_feed".
- Return ONLY valid JSON. No markdown, no commentary.`;

const formatBankLine = (line, idx) => {
  const amount = line.money_in ?? 0;
  return `  ${idx + 1}. candidate_ref=${candidateRefForIndex(idx)}
     date=${line.date || 'unknown'}
     money_in=${amount} ${line.currency || ''}${formatCandidateContextLines(line, 'money_in')}
     description="${line.description || ''}"
     raw_description="${line.raw_description || ''}"
     contact="${line.contact || ''}"${formatCurrentExplanationLine(line)}`;
};

const formatFewShot = (example, idx) =>
  `${idx + 1}. invoice: ${example.customer_name || '(no name)'} ${example.doc_amount} ${example.doc_currency || ''} on ${example.doc_date}
     matched bank line: ${example.tx_amount} ${example.tx_currency || ''} on ${example.tx_date} ("${example.tx_description || ''}")
     hops: ${(example.hops || []).join(', ') || '(none recorded)'}`;

export const buildProposeMatchesUserPrompt = ({ document, candidateBankLines, firmContext, datePairs = true }) => {
  const sections = [];

  sections.push(`Invoice:
  id=${document.id}
  customer_name="${document.customer_name || ''}"
  total_amount=${document.total_amount} ${document.currency || ''}
  document_date=${document.document_date || 'unknown'}
  due_date=${document.due_date || 'unknown'}
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

  // RT-27 — the customer's eligible credit notes, call-local handles only.
  const creditNotesNote = formatCreditNotes(firmContext?.creditNotes, { docNoun: SETTLEMENT_DOC_NOUN, invoice: document });
  if (creditNotesNote) sections.push(creditNotesNote);

  if (firmContext?.recentConfirmedMatches?.length) {
    sections.push(`Recent confirmed matches for this client (few-shot):
${firmContext.recentConfirmedMatches.slice(0, FEW_SHOT_LIMIT).map(formatFewShot).join('\n')}`);
  }

  if (!candidateBankLines || candidateBankLines.length === 0) {
    sections.push('Candidate bank transactions (money_in, within ±90 days of invoice date): NONE.');
  } else {
    sections.push(`Candidate bank transactions (money_in, within ±90 days of invoice date):
${candidateBankLines.map(formatBankLine).join('\n')}`);
    const explanationNote = formatCurrentExplanationNote(candidateBankLines);
    if (explanationNote) sections.push(explanationNote);
    const richerNote = formatRicherCandidateNote(candidateBankLines, 'money_in');
    if (richerNote) sections.push(richerNote);
    const tieNote = describeIndistinguishableGroups(candidateBankLines, document, { datePairs });
    if (tieNote) sections.push(tieNote);
    // Distinct-date twin pairing. When two candidates share this
    // invoice's amount + a payer that reconciles but differ in DATE, they are
    // usually settlements of DISTINCT same-price invoices — NOT an
    // indistinguishable tie. The tie note above already excludes the
    // date-separated group; this tells the model to ACT on the date: pair THIS
    // invoice with the deposit whose date best fits its own (a settlement lands
    // on or after the invoice date — days to weeks later, essentially never
    // before it), score that one like any clear match (0.85-0.95), and give the
    // date-misaligned same-amount siblings low confidence. Reserve the
    // equal-moderate-confidence tie ONLY for candidates that are also
    // date-indistinguishable.
    if (datePairs) {
      sections.push(`Same-amount deposits from one customer are usually DISTINCT settlements, told apart by DATE — not a tie:
- A customer the firm invoices repeatedly at the same price produces several same-amount invoices and several same-amount deposits. Pair THIS invoice with the candidate deposit whose date best fits ITS date (a settlement lands on or after the invoice date — typically days to a few weeks later, essentially never before it). Score that date-aligned candidate like any clear match (0.85-0.95) and give the date-misaligned same-amount siblings low confidence. Only treat them as an equal-confidence tie when they are genuinely date-indistinguishable (same date, no closer fit).`);
    }
  }

  return sections.join('\n\n');
};

// One LLM call. Returns `{ proposals, unmatchable_reason }`. Throws
// only on transport errors — schema parsing returns empty proposals
// + explicit `unmatchable_reason` so the caller can decide whether
// to fall through to the weighted matcher. Thin wrapper over the
// shared core: supplies the AR system prompt + invoice user-prompt.
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
  // Q7 (the model lab): optional deciding transport (openai_compatible).
  // Built by the orchestrator from the lane's active experiment policy;
  // threaded to the shared core, which runs the SAME parser + guards on
  // the rung's reply. Absent ⇒ the anthropic path, byte-identical.
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
  const datePairs = resolveSalesInvoiceDatePairs({ clientId, configSnapshot });
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
    // RT-27 — the credit handles the parser maps back to persisted ids.
    parseOptions: Array.isArray(firmContext?.creditNotes) && firmContext.creditNotes.length
      ? { creditNotes: firmContext.creditNotes }
      : null,
    transport
  });
};

// Orchestrator. Same caller signature as the weighted matcher so
// salesInvoiceReconciliation.js can swap entry points without
// re-wiring. Returns ZERO_STATS-shape stats so `accumulate(stats)`
// in the cron rollup works unchanged regardless of which matcher
// mode ran.
//
// On any failure inside this function the caller (the weighted
// matcher's orchestrator, when delegating) catches and falls
// through. This function therefore prefers throwing on infrastructure
// problems (DB errors, etc.) to returning bogus stats — fail loud,
// fall back cheap.
export const runSalesInvoiceReconciliationLlmForDocument = async ({
  client,
  firmId,
  clientId,
  documentId,
  apiKeyOverride,
  modelOverride,
  fetchImpl,
  // Q7 (the model lab): the lane's active model-policy row, resolved by
  // the WRAPPER (salesInvoiceReconciliation) per (firm, client). A
  // non-claude qualified rung decides this document over the
  // openai_compatible endpoint — same prompts, parser, gates, cascade.
  // An active policy with no endpoint fails LOUD (nothing stamped),
  // never silently back to the strong model or the weighted matcher.
  decidingPolicy = null,
  // Q7: the reverse-shadow hook (built by the wrapper, which owns firmDb
  // access). Fired post-stamp, fire-and-forget, throw-guarded.
  challengerHook = null
} = {}) => {
  if (!client || !firmId || !clientId || !documentId) return ZERO_STATS();
  const jevConfig = await readClientConfigSnapshot(client, { firmId, clientId, strict: true });
  if (clientFlagActs({ flagKey: 'JEV_RECONCILIATION', snapshot: jevConfig, envFallback: () => false })) {
    const first = await runJevReconciliationForDocument({ client, firmId, clientId, documentId, configSnapshot: jevConfig, fetchImpl, family: 'sales_invoice' });
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
    `select id, firm_id, client_id, document_type, vendor_name, customer_name, document_date,
            due_date, total_amount, currency, extraction_confidence, parse_summary,
            duplicate_of, reference_number, structured_reference, filename, payment_status, parse_status
       from documents
      where firm_id = $1
        and client_id = $2
        and id = $3
        and document_type in ('sales_invoice', 'issued_receipt')
        and parse_status = 'completed'
        and total_amount is not null
        and duplicate_of is null`,
    [firmId, clientId, documentId]
  );
  if (!docResult.rows.length) return ZERO_STATS();
  const document = docResult.rows[0];

  // RT-27 — a customer CREDIT NOTE has no bank line to match; its arrival
  // wakes the customer's invoices that still owe something, so both orders
  // (credit-before-payment, payment-before-credit) converge through the
  // existing clock without re-uploading anything.
  if (String(document.payment_status || '') === CREDIT_NOTE_PAYMENT_STATUS) {
    return runCreditNoteArrival({
      client, firmId, clientId, creditNote: document, apiKeyOverride, modelOverride, fetchImpl, decidingPolicy, challengerHook
    });
  }

  const window = computeWindow(document);

  // money_in only, not already resolved — except bank-line-only
  // explains, which stay visible so document evidence can outrank them
  // (CANDIDATE_TX_STATUS_SQL in the core). Window-narrowing happens
  // post-query in JS so the SQL stays simple (and exactly mirrors
  // the weighted matcher's tx query — easier to keep aligned).
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
            status, match_amount, match_confidence, payload
       from reconciliation_matches
      where firm_id = $1
        and client_id = $2
        and matched_object_type = 'sales_invoice'
        and matched_object_id = $3`,
    [firmId, clientId, documentId]
  );

  const suppressed = {
    rejected: new Set(),
    confirmed: new Set(),
    auto_matched: new Set()
  };
  // Settlement-to-date: how many bank lines already settle THIS invoice.
  // Threaded into the prompt so the model can decline a phantom second
  // match against an already-settled invoice (e.g. a fully-settled invoice
  // re-offered to an unrelated receipt that merely FX-coincides on amount).
  let settledCount = 0;
  // RT-27 — the settled AMOUNT (Gate C's prior-settled term) rides with the
  // count, and the credit notes already applied to this invoice join it.
  let settledAmount = 0;
  for (const row of existingResult.rows) {
    const key = pairKey(row.bank_transaction_id, row.matched_object_id);
    if (SUPPRESSION_STATUSES.has(row.status)) {
      suppressed[row.status].add(key);
    }
    if (row.status === 'confirmed' || row.status === 'auto_matched') {
      settledCount += 1;
      const amt = Number(row.match_amount);
      if (Number.isFinite(amt)) settledAmount += amt;
    }
  }
  settledAmount = Math.round(settledAmount * 100) / 100;
  const appliedCreditsResult = await client.query(
    `select coalesce(sum(amount), 0) as applied
       from document_credit_applications
      where firm_id = $1 and invoice_document_id = $2 and status = 'applied'`,
    [firmId, documentId]
  );
  const appliedCredits = Math.round(Number(appliedCreditsResult.rows?.[0]?.applied || 0) * 100) / 100;
  const priorSettledAmount = Math.round((settledAmount + appliedCredits) * 100) / 100;
  const creditNotesGathered = await loadEligibleCreditNotes({ client, firmId, clientId, invoice: document });
  const eligibleCreditNotes = creditNotesGathered.eligible;

  // Few-shot examples: last N confirmed/auto-matched for this client.
  // Stays optional — when the table is empty we just call without it.
  const fewShotResult = await client.query(
    `select m.match_amount, m.payload,
            t.description as tx_description,
            t.transaction_date as tx_date,
            t.money_in as tx_amount,
            t.currency as tx_currency,
            d.customer_name,
            d.total_amount as doc_amount,
            d.currency as doc_currency,
            d.document_date as doc_date
       from reconciliation_matches m
       join transactions t on t.id = m.bank_transaction_id
       join documents d on d.id = m.matched_object_id
      where m.firm_id = $1
        and m.client_id = $2
        and m.matched_object_type = 'sales_invoice'
        and m.status in ('confirmed', 'auto_matched')
      order by m.created_at desc
      limit $3`,
    [firmId, clientId, FEW_SHOT_LIMIT]
  );

  // Firm identity ("who we are", so the model can rule out a bank-line
  // payer that is clearly a different party from the customer) +
  // settlement state. Shared wiring lives in the core; settledCount comes
  // from the existing-match loop above.
  const { clientIdentity, settlement, knownCounterparties } = await loadFirmContext({
    client,
    firmId,
    clientId,
    document,
    settledCount,
    counterpartyRole: COUNTERPARTY_ROLE,
    settledAmount,
    appliedCredits
  });

  const firmContext = {
    clientIdentity,
    settlement,
    knownCounterparties,
    // RT-27 — the eligible credit notes, in the handle order the prompt renders.
    creditNotes: eligibleCreditNotes,
    recentConfirmedMatches: fewShotResult.rows.map((r) => ({
      customer_name: r.customer_name,
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

  // Drop suppressed pairs BEFORE the LLM call — we'd discard the
  // proposal anyway and the model would have spent tokens on it.
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

  if (eligibleBankLines.length === 0 && !eligibleCreditNotes.length) {
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
      matcherFamily: SALES_INVOICE_OBJECT_TYPE,
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

  // Q7 — a claude-family policy rides the existing anthropic transport as
  // a model override; a non-claude rung rides the compatible transport.
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

  const creditOutcome = { applied: 0, refused: 0 };
  for (const proposal of llmResult.proposals) {
    const bankLine = linesById.get(proposal.bank_transaction_id);
    if (!bankLine) continue;

    const matchAmount = Number(bankLine.money_in || 0);
    // RT-27 — the credits this proposal names, planned to exact amounts (pure)
    // and then revalidated under the write lock inside ONE transaction with the
    // match upsert + cascade. A refusal never shades an amount: the credits
    // stand down (receipted by code) and Gate C judges the bank line alone.
    const creditPlan = planCreditApplications({
      invoice: document,
      priorSettled: priorSettledAmount,
      bankAmount: matchAmount,
      bankCurrency: bankLine.currency,
      selectedIds: proposal.applied_credit_document_ids || [],
      creditNotes: eligibleCreditNotes,
      policy
    });
    await withCreditApplicationTransaction(client, async () => {
    const live = creditPlan.applications.length
      ? await lockAndRevalidateCreditNotes({ client, firmId, invoice: document, plan: creditPlan })
      : { ok: true, applications: [], refusals: [] };
    const ridingApplications = live.ok ? live.applications : [];
    const creditApplied = ridingApplications.reduce((sum, a) => sum + a.amount, 0);
    const creditReceipt = (proposal.applied_credit_document_ids || []).length || creditPlan.refusals.length
      ? buildCreditReceipt({ plan: creditPlan, live, eligibleCount: eligibleCreditNotes.length })
      : null;
    if (creditReceipt?.refused?.length) creditOutcome.refused += creditReceipt.refused.length;
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
      priorSettled: priorSettledAmount,
      creditApplied,
      creditReceipt
    });

    if (live.invoice_fresh === false) {
      authorization.band = 'suggested';
      authorization.gates.C = false;
      authorization.reasons = [...new Set([...authorization.reasons, CREDIT_REFUSAL_CODES.STALE])];
    }

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
      objectType: SALES_INVOICE_OBJECT_TYPE,
      matchAmount,
      autoThreshold,
      authorization: effectiveAuthorization,
      returnedModel: llmResult.model || model,
      source: PAYLOAD_SOURCE,
      matchKind: 'sales_invoice',
      unmatchableReason: llmResult.unmatchable_reason || null,
      logTag: LOG_TAG,
      configSnapshotId: runConfigSnapshotId,
      stats,
      creditApplications: ridingApplications.length
        ? { invoice: document, applications: ridingApplications, actorId: 'system', model: llmResult.model || model, authority: { band: effectiveAuthorization.band, reasons: effectiveAuthorization.reasons } }
        : null
    });
    });
  }

  // RT-27 — credits that settle the remaining due WITHOUT a bank line (the
  // payment-before-credit order: the invoice is partially paid, the credit
  // note arrives later and completes it; or an invoice credited in full).
  // Same gate law over the applied credit total; a held material application
  // takes the D2 material auto-FYI path. Refused applications retain their
  // source state and unresolved receipt for the existing generic workflow;
  // this slice offers no credit-specific owner reply action.
  const creditOnlySelections = Array.isArray(llmResult.credit_applications) ? llmResult.credit_applications : [];
  if (creditOnlySelections.length) {
    const creditPlan = planCreditApplications({
      invoice: document,
      priorSettled: priorSettledAmount,
      bankAmount: 0,
      selectedIds: creditOnlySelections.map((c) => c.credit_document_id),
      creditNotes: eligibleCreditNotes,
      policy
    });
    const confidence = Math.min(...creditOnlySelections.map((c) => (Number.isFinite(Number(c.confidence)) ? Number(c.confidence) : 0)));
    const outcome = await withCreditApplicationTransaction(client, async () => {
      const live = creditPlan.ok
        ? await lockAndRevalidateCreditNotes({ client, firmId, invoice: document, plan: creditPlan })
        : { ok: false, applications: [], refusals: [] };
      const livePlan = { ...creditPlan, ok: creditPlan.ok && live.ok, applications: live.ok ? live.applications : [], refusals: [...creditPlan.refusals, ...live.refusals] };
      const authorization = applyMaterialAutoFyi(
        authorizeCreditOnlyApplication({
          confidence,
          plan: livePlan,
          policy,
          clientAllowed: clientAllowedToAutoMatch(clientId, policy, { configSnapshot })
        }),
        { clientId, configSnapshot }
      );
      const receipt = buildCreditReceipt({ plan: livePlan, live, eligibleCount: eligibleCreditNotes.length });
      if (authorization.band === 'auto_matched' && livePlan.applications.length) {
        const applied = await applyCreditApplicationsWithClient({
          client, firmId, clientId, invoice: document,
          applications: livePlan.applications,
          settlementMatchId: null,
          actorId: 'system',
          model: llmResult.model || model,
          authority: { band: authorization.band, reasons: authorization.reasons, gates: authorization.gates, material_auto_fyi: authorization.material_auto_fyi || null }
        });
        return { authorization, receipt, applied: applied.applied.length + applied.already_applied.length, held: false };
      }
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', 'reconciliation.credit_note_application_held', 'document', $3, $4::jsonb)`,
        [firmId, clientId, documentId, JSON.stringify({ authorization, credit_notes: receipt, model: llmResult.model || model, unresolved: true, owner_reply_supported: false, workflow: 'existing_document_workflow' })]
      );
      return { authorization, receipt, applied: 0, held: livePlan.applications.length > 0 || creditPlan.ambiguity != null };
    });
    creditOutcome.applied += outcome.applied;
    creditOutcome.refused += outcome.receipt.refused.length;
    stats.credit_notes_applied = (stats.credit_notes_applied || 0) + outcome.applied;
  }
  stats.credit_note_refusals = (stats.credit_note_refusals || 0) + creditOutcome.refused;

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

  // Verdict stamp — persists the model's no-proposal reason (or the
  // fact that proposals were written), so "no match" is a recorded
  // verdict rather than an absence of rows.
  await recordReconciliationEvaluation({
    client,
    firmId,
    clientId,
    targetId: documentId,
    matcherFamily: SALES_INVOICE_OBJECT_TYPE,
    verdict: llmResult.proposals.length || creditOutcome.applied ? 'proposed' : 'no_match',
    unmatchableReason: creditOutcome.applied ? null : recordedReason,
    proposalCount: llmResult.proposals.length + (creditOutcome.applied ? 1 : 0),
    candidateCount: candidateBankLines.length,
    eligibleCount: eligibleBankLines.length,
    // The verdict stamp carries the provider-RETURNED model id (the
    // receipt), not the requested string — same as the match payload's
    // returnedModel above. See CLAUDE.md "the model id is part of the receipt".
    model: llmResult.model || model,
    // Q7 — which policy basis (if any) put the deciding model in charge,
    // and how the model id was sourced. Null on the default path, so the
    // model-lab comparison can slice experiment rows from baseline rows.
    payload: policyBasis
      ? { policy_basis: policyBasis, model_source: llmResult.model_source || null }
      : null,
    // Phase 0B no-match coverage — record the model's no_match DECISION (skipped when
    // 'proposed'; #650 covers that per-proposal), stamped with the run's config snapshot.
    recordDecision: true,
    configSnapshotId: runConfigSnapshotId,
    logTag: LOG_TAG
  });

  // Q7 — POST-STAMP reverse shadow: every persisted decision above ran on
  // the bare client (no wrapping transaction — F5), so by here the match
  // rows and the verdict stamp are committed. The hook replays the exact
  // observation against the strong default, evidence + receipt only.
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

// RT-27 — the credit-note arrival. The credit note itself proposes nothing
// (no bank line ever carries it); each open invoice of the same customer the
// credit could reduce re-runs its OWN pass with the credit in context. The
// credit note's evaluation stamp records the wake — a verdict, not an absence.
const runCreditNoteArrival = async ({
  client, firmId, clientId, creditNote, apiKeyOverride, modelOverride, fetchImpl, decidingPolicy, challengerHook
}) => {
  const stats = ZERO_STATS();
  const appliedResult = await client.query(
    `select coalesce(sum(amount), 0) as applied
       from document_credit_applications
      where firm_id = $1 and credit_document_id = $2 and status = 'applied'`,
    [firmId, creditNote.id]
  );
  const applied = Number(appliedResult.rows?.[0]?.applied || 0);
  const remaining = Math.round((Math.abs(Number(creditNote.total_amount)) - applied) * 100) / 100;
  const invoices = remaining > 0.01
    ? await loadInvoicesToReconsiderForCreditNote({ client, firmId, clientId, creditNote: { ...creditNote, applied_total: applied } })
    : [];
  const reconsidered = [];
  const failures = [];
  for (const invoice of invoices) {
    try {
      const r = await runSalesInvoiceReconciliationLlmForDocument({
        client, firmId, clientId, documentId: invoice.id, apiKeyOverride, modelOverride, fetchImpl, decidingPolicy, challengerHook
      });
      reconsidered.push({ invoice_document_id: invoice.id, linkage: invoice.linkage, credit_notes_applied: r?.credit_notes_applied || 0 });
      for (const key of Object.keys(stats)) {
        if (typeof stats[key] === 'number' && typeof r?.[key] === 'number') stats[key] += r[key];
      }
      stats.credit_notes_applied = (stats.credit_notes_applied || 0) + (r?.credit_notes_applied || 0);
    } catch (error) {
      // The outer family wrapper owns the provider-failure receipt and retry.
      // A failed child has no verdict; never stamp the credit as evaluated.
      if (isProviderFailure(error)) throw error;
      failures.push({invoice_document_id:invoice.id,code:error?.code || 'CREDIT_INVOICE_EXECUTION_FAILED',message:error?.message || String(error)});
      console.error(`[${LOG_TAG}] invoice re-run on credit-note arrival failed`, {
        credit_document_id: creditNote.id, invoice_document_id: invoice.id, error: error?.message || String(error)
      });
    }
  }
  stats.credit_note_invoices_reconsidered = reconsidered.length;
  const previous = failures.length ? (await client.query(`select payload from reconciliation_evaluations
    where firm_id=$1 and client_id=$2 and target_id=$3 and matcher_family=$4`,
  [firmId,clientId,creditNote.id,SALES_INVOICE_OBJECT_TYPE])).rows[0]?.payload : null;
  await recordReconciliationEvaluation({
    client,
    firmId,
    clientId,
    targetId: creditNote.id,
    matcherFamily: SALES_INVOICE_OBJECT_TYPE,
    verdict: failures.length ? 'failed' : 'no_candidates',
    unmatchableReason: failures.length ? 'credit_note_write_failed' : 'credit_note_no_bank_line',
    candidateCount: 0,
    eligibleCount: 0,
    payload: { credit_note: true, remaining_available: remaining, invoices_reconsidered: reconsidered,
      ...(failures.length ? {failures,next_action:'retry_writer',execution:'not_applied',
        attempt_count:Number(previous?.attempt_count || 0)+1} : {}) },
    logTag: LOG_TAG
  });
  return stats;
};

// Re-exports for tests. The threshold/window constants are re-exported
// straight from the core (not copied into a local const) so they are
// not read during this module's evaluation — core ↔ firmDb ↔
// parseDocumentsDb form an import cycle and an init-time read would hit
// the core binding's temporal dead zone.
export const __SALES_INVOICE_OBJECT_TYPE = SALES_INVOICE_OBJECT_TYPE;
// Q7 — the exact deciding system prompt, exported for the reverse-shadow
// replay (reconciliationReasoningChallenger.js). Same-string parity is the
// apples-to-apples requirement; never fork this text at the call site.
export const __SALES_INVOICE_SYSTEM_PROMPT = SYSTEM_PROMPT;
export {
  WINDOW_DAYS as __WINDOW_DAYS,
  DEFAULT_AUTO_THRESHOLD as __DEFAULT_AUTO_THRESHOLD
} from './reconciliationLlmCore.js';
