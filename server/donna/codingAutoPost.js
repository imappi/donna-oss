import { readRetainedProcessingScopeInDb } from './runtimeReadinessAdmission.js';
import { isDeepStrictEqual } from 'node:util';
import { readJevCase, codingCaseRevision } from './jevPreview.js';
import { __createClientEvidenceRequestWithClient } from './db/asks.js';
import { codingStatutoryEvidenceGap } from './codingStatutoryEvidence.js';
import { codingRevenueEvidenceGap } from './codingRevenueEvidence.js';
import { hasJevResolvedCoding, JEV_DOCUMENT_ASK_SELECTIONS } from './jevDecisionReceipt.js';
// Coding auto-post — the two-terminal convergence writer for confident
// strong-coder codings.
//
// THE GAP THIS CLOSES (CLAUDE.md FIRST principle, two-terminal-states).
// The strong coder proposes an account for every bank line and persists it at
// `coding_state='proposed'` (firmDb.js batch-coder path; RT-16). The ONLY auto-apply
// gate that could promote it — lanePolicy.classifyLane's GREEN lane — requires a
// deterministic `client_rule_match` (lanePolicy.js), so a high-confidence coding
// with no client rule can NEVER auto-post and rests permanently in firm limbo:
// a SUGGESTED coding waiting on a firm click, the exact violation the first
// principle forbids. That is intelligence-substituting scaffolding (demanding a
// hand-written rule before we trust the strong model) — the thing CLAUDE.md's
// trust-the-strong-LLM rail says to retire.
//
// WHAT IT DOES. A read-only sweep over a client's transaction-owned
// `suggested` coding receipts (with an optional review case joined as context)
// that routes each to its correct terminal, using ONLY existing named writers
// (never a second accounting backend — the runtime doctrine's INV-1):
//   - AUTO-POST  → the confident branch: high-confidence coding, the coder said
//                  no evidence is required, and the account is a P&L (not a
//                  balance-sheet / red account). Applied via
//                  updateTransactionReviewItemInDb exactly as a reviewer's
//                  "Apply" click would (coding_state='applied' → the convergence
//                  projection reads `auto_reconciled`), THEN posted to the
//                  internal Donna ledger via postLedgerTransactionInDb so the
//                  line lands as a POSTED journal — the state the client-portal
//                  reports (P&L / Balance Sheet) actually read. Without the post
//                  step the line was `auto_reconciled` in the reconcile view but
//                  invisible to the reports (which read only posted ledger
//                  journals, never the transactions table), so "accepted but
//                  unposted" was the two-terminal-states violation one step
//                  downstream — a line resting on a firm "post" click. The post
//                  runs ONLY for Donna-ledger clients (accounting_system='none'),
//                  mirroring the chat "Categorise & post" step (api.js) and the
//                  reply-confirmed auto-post loop (firmDb.js); a correction inside
//                  Donna is NOT a push to Xero/QBO, so connector clients keep the
//                  accept-only behaviour and their firm-gated writeback. Best-
//                  effort: a post failure leaves the line accepted (still shown
//                  reconciled), never rolls back the accept. Decide-and-notify:
//                  the owner can still be FYI'd; this is not a firm click queue.
//   - OWNER ASK  → the unsure branch: the coder flagged `evidence_required`, so
//                  the one thing only the OWNER can answer (send the document) is
//                  escalated via createClientEvidenceRequestInDb, which flips the
//                  line to `coding_state='asked'` → the `on_owner` terminal.
//                  Idempotent: the writer dedupes an open request per transaction.
//   - OWNER ASK (refusal flavor, rule 2.7 — Slice 4 of the case-health
//                  contract, 2026-08-17): the strong coder RAN and REFUSED to
//                  code (a Suspense/absent account carrying the model's own
//                  receipt) — "I cannot know this" is the persisted statement
//                  that a business FACT only the owner holds is missing
//                  (transfer counter-account ownership is the canonical §4
//                  case). Resting that refusal at `suggested` was the exact
//                  `no_open_ask_for_owner_fact` violation the case-health
//                  projection surfaces; the honest terminal is the owner ask.
//                  On reply the existing recode lane resumes the line and
//                  distills the learned fact into firm memory (the
//                  own-account roster's v1 substrate).
//   - SKIP       → everything else stays SURFACED at `suggested` (hanging), never
//                  silently terminal: a red / balance-sheet account (firm
//                  judgment — balance-sheet postings stay stubborn per the L1
//                  doctrine), a medium/low-confidence coding, or an un-coded
//                  suggestion with NO model refusal receipt (a rules_fallback
//                  template or a machine-resolvable missing_account park is
//                  not the model saying "only the owner knows"). Fail toward
//                  surfacing the leak.
//
// SAFETY. A DEDICATED, fail-closed canary (CODING_AUTO_POST + _CLIENTS), mirroring
// RECONCILIATION_MATERIAL_AUTO_FYI exactly: unattended posting of the strong
// model's account judgment is a consequential capability, so it gets its own
// explicit switch that is GUARANTEED unset in prod — merging this can never
// silently flip a live book into auto-posting (CLAUDE.md "do NOT flip prod
// silently / the model id is the receipt"). Off ⇒ the sweep is inert and every
// line stays `suggested`, byte-identical to today. Each line is its own writer
// call (its own BEGIN/COMMIT inside the writer) so a failure on one line never
// rolls back the rest — same isolation as bankLineAutoExplain's sweep.
//
// The eligibility gate is PURE and separately unit-tested; the sweep is the thin
// DB shell around it. It never calls an LLM and never re-infers — it reads the
// coder's persisted verdict (payload.ai_suggestion) and routes on it.

import {
  updateTransactionReviewItemInDb,
  createClientEvidenceRequestInDb,
  ensureTransactionReviewItemInDb,
  markCodingAutoPostFyiPendingInDb
} from './firmDb.js';
import { withFirmDbClient, postLedgerTransactionInDb, getClientAccountingSystemFromDb, readClientConfigSnapshotInDb, __descriptionOnlyAutoApplyCeiling } from './firmDb.js';
import { clientFlagActs } from './clientConfig.js';
import { isRedAccount } from './lanePolicy.js';
// G-7P (D-G7P-4) — the auto-lane demotion: a would-be AUTO-POSTED coding whose
// tax verdict resolves to a reverse-charge ALV code (the drift catalog's only
// filing_blocked severity) goes to the owner instead of posting unattended.
import { resolvePostingAdmission } from './postingAdmissionRegistry.js';
import { loadLocalEvidenceCandidatesWithClient, citableEvidenceCandidates } from './localEvidenceInventory.js';
import { suggestedMatchHasSettleLane } from './reconciliationTwinAging.js';

// ── Canary (dedicated, fail-closed — mirrors materialAutoFyiCanaryAllows) ─────
export const CODING_AUTO_POST_FLAG_KEY = 'CODING_AUTO_POST';

const envFlag = (name, env = process?.env) => {
  const v = String(env?.[name] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
};

// Comma-separated client-id allowlist. null when unset/empty (= no restriction).
const envClientAllowlist = (name, env = process?.env) => {
  const raw = env?.[name];
  if (!raw) return null;
  const items = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  return items.length ? items : null;
};

// Whether `clientId` may receive UNATTENDED coding auto-posts. GATES THE WHOLE
// feature (like the material auto-FYI canary, unlike the auto-match canary which
// only narrows an already-on policy): true ONLY when the flag is on AND (no
// allowlist OR the client is on it). Fail-closed by default. NEVER widen by
// deleting CODING_AUTO_POST_CLIENTS while the flag is on — that silently turns
// the per-client canary into a global flip.
export const codingAutoPostCanaryAllows = (clientId, env = process.env) => {
  if (!envFlag(CODING_AUTO_POST_FLAG_KEY, env)) return false;
  const allow = envClientAllowlist(`${CODING_AUTO_POST_FLAG_KEY}_CLIENTS`, env);
  if (!allow) return true; // flag on, no allowlist → every client (the full un-gate)
  const id = clientId == null ? '' : String(clientId).trim();
  return !!id && allow.includes(id);
};

// The env-state half of the auto-post receipt: true ⇒ a SET allowlist scoped
// this run; false ⇒ the flag was on globally. Paired with the client_id it
// reconstructs "auto-posted under the <client>-only canary" from the data alone.
export const codingAutoPostClientScoped = (env = process.env) => {
  const allow = envClientAllowlist(`${CODING_AUTO_POST_FLAG_KEY}_CLIENTS`, env);
  return Array.isArray(allow) && allow.length > 0;
};

// ── Control-plane resolver (CLAUDE.md "rollout flags are born on the config
// control plane") ─────────────────────────────────────────────────────────────
// DB-first, env-fallback: a client_capability_config row for CODING_AUTO_POST
// decides via the stage vocabulary (canary/auto act; off/dry_run/shadow do
// not; fail-closed on unknown). Without a row, the legacy env canary above is
// the byte-identical fallback — this flag was born as an env pair (#753,
// pre-rail) and this shim is its graduation on-ramp. CLIENT_CONFIG_FORCE_DISABLE
// wins over everything (env can kill, never enable).
export const codingAutoPostAllows = ({ clientId, snapshot = null, env = process.env } = {}) =>
  clientFlagActs({
    flagKey: CODING_AUTO_POST_FLAG_KEY,
    snapshot,
    envFallback: () => codingAutoPostCanaryAllows(clientId, env),
    env
  });

// ── Owner-transfer decide-and-notify flag (born on the control plane) ─────────
// Terminal A of docs/design-coding-skip-class-terminals.md (signed off
// 2026-07-05, PR #764): a coded, high-confidence OWNER-EQUITY posting
// auto-posts with an owner FYI instead of resting at `suggested` as a
// red-account skip. Born as a control-plane flag key per the CLAUDE.md rail —
// there is deliberately NO env pair and the env fallback is a constant false
// (fail-closed everywhere until a DB stage row exists).
export const CODING_OWNER_TRANSFER_POST_FLAG_KEY = 'CODING_OWNER_TRANSFER_POST';

export const codingOwnerTransferPostAllows = ({ snapshot = null, env = process.env } = {}) =>
  clientFlagActs({
    flagKey: CODING_OWNER_TRANSFER_POST_FLAG_KEY,
    snapshot,
    envFallback: () => false,
    env
  });

// ── Pure eligibility gate ─────────────────────────────────────────────────────
export const CODING_AUTO_POST_ACTIONS = Object.freeze(['auto_post', 'owner_ask', 'skip']);

// Xero account Types that are unambiguously P&L (safe to auto-post). When the
// coder's suggestion carries an explicit type (only present with a connected
// chart), it is trusted over the name heuristic.
const PNL_XERO_ACCOUNT_TYPES = new Set([
  'EXPENSE', 'OVERHEADS', 'DIRECTCOSTS', 'REVENUE', 'SALES', 'OTHERINCOME'
]);

// Name patterns that mark a BALANCE-SHEET account (liability / asset / equity /
// tax / bank). Auto-posting these is a stubborn, firm-judgment move per the L1
// doctrine, so the sweep never does it unattended — even when the red-account
// pattern (which targets equity/director/tax) doesn't fire (e.g. "credit card
// payable"). The denylist is the fallback used only when no explicit P&L type is
// present; it fails toward NOT auto-posting.
const BALANCE_SHEET_NAME_PATTERN = /\b(payable|receivable|liabilit|asset|capital|equit|loan|credit\s*card|overdraft|accrual|accrued|prepay|prepaid|deferred|reserve|provision|deposit|retained|dividend|drawings?|director|shareholder|owner|hire\s*purchase|lease\s*liab|vat|gst|paye|payroll|withholding|duty|bank\s*account|cash\s*at|petty\s*cash|suspense)\b/i;

const norm = (v) => (v == null ? '' : String(v).trim());

const isCodedAccount = (name) => {
  const a = norm(name).toLowerCase();
  return a !== '' && a !== 'suspense' && a !== 'unknown';
};

// A P&L (safe-to-auto-post) account: trust an explicit P&L Xero type when
// present, else fall back to the balance-sheet name denylist (must NOT look
// balance-sheet-ish). Red accounts are excluded separately by the caller.
const isPnlSafeAccount = ({ xeroType, name }) => {
  const t = norm(xeroType).toUpperCase();
  if (t) return PNL_XERO_ACCOUNT_TYPES.has(t);
  return !BALANCE_SHEET_NAME_PATTERN.test(norm(name));
};

// OWNER-EQUITY account classes eligible for the Terminal-A decide-and-notify
// posting: movements between the business and its owner, nothing else.
// Deliberately NARROW — tax/VAT/GST/PAYE/payroll red accounts, provisions,
// retained earnings, and dividends all stay stubborn skips (a dividend is a
// declared distribution with legal formalities, not a casual owner movement).
// Same Keep-layer shape as isRedAccount / isPnlSafeAccount: deterministic
// account-class POLICY over the coder's persisted verdict — the model picks
// the account, this predicate only decides the authority treatment.
const OWNER_EQUITY_NAME_PATTERN = /\b(drawings?|owner'?s?\s+(draw|drawing|capital|contribution|funds?|investment)|capital\s+(introduced|contribution)|director'?s?\s+loan)\b/i;

export const isOwnerEquityAccount = ({ xeroType, name }) => {
  const label = norm(name);
  if (!label) return false;
  const t = norm(xeroType).toUpperCase();
  if (t === 'EQUITY') return OWNER_EQUITY_NAME_PATTERN.test(label) || /\bcurrent\s+account\b/i.test(label);
  return OWNER_EQUITY_NAME_PATTERN.test(label);
};

// RT-26 (2026-09-09, Kari's word) — the OWNER-SIDE equity classes whose
// treatment stays an owner question even when a document is matched: the
// owner-equity movements above plus declared distributions and capital
// (a dividend is a distribution with legal formalities; retained earnings and
// share capital are not "which liability does this settle"). Every OTHER
// balance-sheet payable the coder names against a matched notice or a
// statutory filing — payroll and withholding taxes, VAT/GST payable, pension
// and insurance payables, loans, credit cards, accruals — is a KNOWLEDGE
// decision the coder makes and the Keep layer posts; it never reaches the
// owner as "what balance does this settle?" (the second run's two
// account_treatment asks on payroll liabilities).
const OWNER_SIDE_EQUITY_PATTERN = /\b(dividends?|retained\s+earnings?|shareholders?|share\s+capital|equity|owners?'?s?|directors?'?s?\s+(?:loan|current)|loans?\s+to\s+(?:a\s+|the\s+)?(?:director|shareholder|owner)s?)\b/i;
export const isOwnerSideEquityAccount = ({ xeroType, name }) => {
  if (isOwnerEquityAccount({ xeroType, name })) return true;
  if (norm(xeroType).toUpperCase() === 'EQUITY') return true;
  return OWNER_SIDE_EQUITY_PATTERN.test(norm(name));
};

// transactions.reconciliation_status values that mean the bank line is already
// settled by a match (mirrors reconcileConvergenceState.SETTLED_RECON_STATUSES).
const SETTLED_RECON_STATUSES = new Set(['explained', 'reconciled', 'auto_reconciled', 'posted']);

// Route one coder suggestion to its terminal. `suggestion` is the transaction's
// persisted `payload.ai_suggestion`; `reconciliationStatus` / `hasDocMatch`
// describe whether the bank line is already matched to a DOCUMENT (the receipt
// IS the evidence); `hasPendingEvidenceRequest` is true when the line already
// carries a client_evidence_request in ('draft','open','replied') — the owner
// was already asked and/or has already answered. Returns { action, reason,
// blockers }.
//
// Order matters:
//  1. A doc-matched line's coding auto-posts regardless of the coder's
//     evidence_required flag — the match already supplied the evidence, so
//     owner-asking for it again is wrong (the live Shopify case: MATCHED·AUTO
//     but the coding sat SUGGESTED, holding the line in the Reconcile view).
//     Still gated to a real P&L (non-red, non-balance-sheet) account. A
//     matched liability/tax posting needs an owner treatment fact; leaving it
//     as a silent red-account skip is neither posted nor on the owner.
//  2. evidence_required (unmatched) ⇒ the OWNER holds the missing document ⇒
//     owner_ask — UNLESS the owner was already asked / already replied
//     (hasPendingEvidenceRequest), in which case re-asking is a bug: it flips a
//     `replied` line back to `waiting` and asks for a document the client
//     already sent (the §B Shopify regression). Surface it instead; the
//     evidence-reply recode (parse-time anchor settle) or batch ask pipeline
//     owns that line — this sweep must not double-ask it.
//  3. The strict confident branch (unmatched, high confidence, no evidence
//     needed, P&L).
// Everything else is surfaced (skip), never laundered terminal.
const evaluateCodingAutoPostCore = ({ suggestion = {}, reconciliationStatus = null, hasDocMatch = false, correctionOwnerReply = false, hasSuggestedDocMatch = false, suggestedDocMatchHasSettleLane = true, crossEntity = null, hasPendingEvidenceRequest = false, ownerTransferAllowed = false, amount = null, unevidencedCap = null, statutorySettlement = false, bankLineDisposition = null, moneyIn = 0, moneyOut = 0, revenueDocument = null, statutoryDocument = null } = {}) => {
  // The held-evidence suppression below is only honest when the suggested
  // match can actually still reach a terminal. A hold with no lane
  // (below_floor — reconciliationTwinAging.suggestedMatchHasSettleLane) settles
  // nothing and asks nothing, so suppressing the owner ask on it strands the
  // line on nobody (Desert Rose tx-10, 2026-09-01). Defaults true, so a caller
  // that does not know stays byte-identical to the pre-2026-09-01 behaviour.
  const suggestedMatchSuppressesAsk = hasSuggestedDocMatch && suggestedDocMatchHasSettleLane !== false;
  const s = suggestion && typeof suggestion === 'object' ? suggestion : {};
  const proposed = s.proposed_account || s.account_name || s.account_code || '';
  const confidence = norm(s.confidence).toLowerCase();
  const evidenceRequired = s.evidence_required;
  const xeroType = s.xero_account_type || s.account_type || '';

  const coded = isCodedAccount(proposed);
  const red = isRedAccount(xeroType, proposed);
  const pnlSafe = isPnlSafeAccount({ xeroType, name: proposed });
  const ownerEquity = isOwnerEquityAccount({ xeroType, name: proposed });
  const ownerSideEquity = isOwnerSideEquityAccount({ xeroType, name: proposed });
  const semanticDecision = confidence === 'high' || hasJevResolvedCoding(s);
  const evidenceSatisfiedByMatch = hasDocMatch === true || SETTLED_RECON_STATUSES.has(norm(reconciliationStatus).toLowerCase());
  const crossEntityOwnSide = crossEntity && typeof crossEntity === 'object' ? norm(crossEntity.own_side) : '';

  // Ownership is a prerequisite for every posting branch, including an
  // independently recognized statutory description and already explained line.
  if (crossEntityOwnSide) {
    return hasPendingEvidenceRequest
      ? { action:'skip', reason:'evidence_request_pending', blockers:['cross_entity_relation'] }
      : { action:'owner_ask', reason:'cross_entity_relation', blockers:[] };
  }
  // A match supplies a document, not the owner's use fact or a complete payroll package.
  if (['owner_fact', 'payroll_package', 'document_discrepancy'].includes(s.posting_requirement)) {
    if (hasPendingEvidenceRequest) return { action: 'skip', reason: 'evidence_request_pending', blockers: ['evidence_request_pending'] };
    return { action: 'owner_ask', reason: `coding_${s.posting_requirement}`, blockers: [] };
  }

  // A statutory descriptor identifies a payment, not its supporting filing.
  // Keep the missing source in the document lifecycle so its later match can
  // answer this ask; an account-treatment ask would falsely claim it is held.
  if (codingStatutoryEvidenceGap({transaction:{money_in:moneyIn,money_out:moneyOut},suggestion:s,matchedDocument:statutoryDocument,identifiedObligation:statutorySettlement})
      || (coded && (red || !pnlSafe) && bankLineDisposition === 'statutory_payment'
      && !hasDocMatch && statutorySettlement !== true)) {
    if (hasPendingEvidenceRequest) return { action: 'skip', reason: 'evidence_request_pending', blockers: ['evidence_request_pending'] };
    if (suggestedMatchSuppressesAsk) return { action: 'skip', reason: 'doc_match_pending', blockers: ['doc_match_pending'] };
    return { action: 'owner_ask', reason: 'statutory_evidence_required', blockers: [] };
  }

  if (codingRevenueEvidenceGap({transaction:{money_in:moneyIn},suggestion:s,matchedDocument:revenueDocument})) {
    if (hasPendingEvidenceRequest) return {action:'skip',reason:'evidence_request_pending',blockers:['evidence_request_pending']};
    if (suggestedMatchSuppressesAsk) return {action:'skip',reason:'doc_match_pending',blockers:['doc_match_pending']};
    return {action:'owner_ask',reason:'revenue_source_required',blockers:[]};
  }

  // 1. Doc-matched line — the receipt is the evidence; auto-post the coding so
  //    a settled bank line stops resting on a SUGGESTED coding chip.
  if (evidenceSatisfiedByMatch && coded && !red && pnlSafe) {
    return { action: 'auto_post', reason: 'matched_document_evidence', blockers: [] };
  }

  // A matched receipt does not remove the existing explicit owner-transfer grant.
  if (evidenceSatisfiedByMatch && ownerTransferAllowed && coded && semanticDecision && evidenceRequired === false && ownerEquity) {
    return { action: 'auto_post', reason: 'owner_transfer_decide_and_notify', fyi_owner: true, blockers: [] };
  }

  // Historical correction has a separate live grant and a fresh semantic solve
  // of the recorded owner answer. The caller verifies that scoped receipt; the
  // source-specific gates above and the final posting planner still apply.
  if (correctionOwnerReply && coded && semanticDecision && evidenceRequired === false && !ownerSideEquity) {
    return {action:'auto_post',reason:'correction_owner_reply',blockers:[]};
  }

  // 1.1. A settled/document-matched balance-sheet coding is evidenced but it
  //      is not authorised for unattended posting. Route the smallest missing
  //      treatment fact to the owner instead of returning a permanent
  //      red-account skip (the Cactus Gusto-tax line). The live-request guard
  //      keeps this exactly-once. Unmatched balance-sheet suggestions retain
  //      the existing skip/owner-transfer rules below.
  if (coded && (red || !pnlSafe) && (evidenceSatisfiedByMatch || statutorySettlement === true)) {
    // RT-26 (2): the red gate YIELDS when the payable is evidenced by a matched
    // notice (the payslip, the loan notice, the tax notice — hasDocMatch) or by
    // a statutory filing (the disposition lane's 'statutory_payment' verdict —
    // read off the row's stamp OR the persisted verdict, so a best-effort
    // status stamp that never landed cannot strand the line). Which liability
    // a withholding settles is the coder's decision — a knowledge question,
    // never the owner's. Owner-side equity (drawings, the director's loan,
    // dividends, capital) keeps the treatment ask: that IS an owner fact.
    if ((hasDocMatch === true || statutorySettlement === true) && !ownerSideEquity) {
      return { action: 'auto_post', reason: 'evidenced_liability_settlement', blockers: [] };
    }
    if (evidenceSatisfiedByMatch) {
      if (hasPendingEvidenceRequest) {
        return { action: 'skip', reason: 'evidence_request_pending', blockers: ['evidence_request_pending'] };
      }
      return { action: 'owner_ask', reason: 'settled_balance_sheet_treatment', blockers: [] };
    }
  }

  // 1.7. Cross-entity FACT ask (the #1316 follow-up). The guard capped this
  //      line's match at 'suggested' because the matched document's OWN-SIDE
  //      identity confidently mismatches this book — the missing piece is the
  //      RELATIONSHIP, a business fact only the owner holds. Without this rule
  //      the line rests in firm limbo: match capped, no ask, no terminal (the
  //      Honeybee Amex three, 2026-08-06). Fires regardless of any suggested
  //      doc match — the capped match IS the cross-entity evidence, and it
  //      cannot settle until the owner answers. Settled lines never ask
  //      (evidenceSatisfiedByMatch above); the §B re-ask guard applies as
  //      everywhere else.
  if (crossEntityOwnSide && !evidenceSatisfiedByMatch) {
    if (hasPendingEvidenceRequest) {
      return { action: 'skip', reason: 'evidence_request_pending', blockers: ['evidence_request_pending'] };
    }
    return { action: 'owner_ask', reason: 'cross_entity_relation', blockers: [] };
  }

  // 2. Owner ask — the coder wants evidence before posting and none is on the
  //    line yet. Only the owner can supply it. (Requires a real coded account to
  //    ask about; a bare Suspense suggestion is too thin to form a question.)
  //    Idempotency guard: if the owner was ALREADY asked or has ALREADY replied
  //    (an open/draft/replied evidence request exists), do NOT re-ask — that is
  //    the §B bug (a replied line flipped back to 'waiting', re-asking for a
  //    document the client already provided). Surface it; the reply-recode /
  //    ask pipeline settles it. The line is already on the owner (open request)
  //    or transitioning off the reply (replied) — either way not a re-ask.
  // RT-26's chase verdict may arrive after an existing coding that said
  // evidence_required=false. The disposition supplies the evidence need;
  // the existing coder supplies the account. Neither fact requires erasing
  // the other verdict or another model call before the document handoff.
  const dispositionNeedsEvidence = !evidenceSatisfiedByMatch
    && ['chase_receipt','chase_evidence'].includes(bankLineDisposition);
  if ((evidenceRequired === true || dispositionNeedsEvidence) && coded) {
    if (hasPendingEvidenceRequest) {
      return { action: 'skip', reason: 'evidence_request_pending', blockers: ['evidence_request_pending'] };
    }
    // Don't ask the owner for a document the matcher ALREADY found. A
    // 'suggested' doc match means the evidence is in the system awaiting the
    // settle lane (triage / auto-explain / authority) — the resolution is
    // machine-side, not another owner message. This is the ask-batch gather's
    // existing law (ASK_BATCH_CANDIDATE_SQL excludes matched lines for exactly
    // this reason); the per-line sweep was the one factory still minting asks
    // for receipts already held (the Honeybee Mann Lake / land-lease / IRS
    // seven, 2026-08-06). Surface, never ask.
    if (suggestedMatchSuppressesAsk) {
      return { action: 'skip', reason: 'doc_match_pending', blockers: ['doc_match_pending'] };
    }
    return { action: 'owner_ask', reason: 'evidence_required', blockers: [] };
  }

  // 2.5. Owner-transfer decide-and-notify (Terminal A, flag-gated). A coded,
  //      HIGH-confidence owner-equity posting (drawings / owner's capital /
  //      director's loan) is the one posting the OWNER already knows about —
  //      the correct terminal is auto-post + a courtesy FYI riding the next
  //      client message, not a firm click and not a question. Requires an
  //      EXPLICIT evidence_required === false (an unknown flag stays surfaced,
  //      same strictness as rule 3; a true already routed to rule 2 above).
  //      Flag off ⇒ this branch is inert and the line skips exactly as before
  //      (red_account / balance_sheet_account), byte-identical.
  if (ownerTransferAllowed && coded && semanticDecision && evidenceRequired === false && ownerEquity) {
    return { action: 'auto_post', reason: 'owner_transfer_decide_and_notify', fyi_owner: true, blockers: [] };
  }

  // 2.6. Owner-fact ask (Kari's dated call, 2026-08-04 — reverses the June
  //      own-money auto-apply exemption now that the ask lane runs). An
  //      UNMATCHED owner-equity line is a business FACT only the owner
  //      holds — draw, repayment, capital, personal? — regardless of the
  //      coder's confidence or its evidence_required flag: the coding may
  //      be confident while the fact is still missing, and no external
  //      document will ever exist to settle it. Sits BELOW rule 2.5 on
  //      purpose: a firm that flipped CODING_OWNER_TRANSFER_POST chose
  //      decide-and-notify for this class, and that explicit plane stage
  //      outranks the ask default. A matched line never lands here (the
  //      doc IS the evidence); the §B re-ask guard applies the same as
  //      rule 2.
  if (coded && ownerEquity && !evidenceSatisfiedByMatch) {
    if (hasPendingEvidenceRequest) {
      return { action: 'skip', reason: 'evidence_request_pending', blockers: ['evidence_request_pending'] };
    }
    // Same held-evidence suppression as rule 2: a suggested doc match on the
    // line means the machine is mid-settle — don't cross-question the owner.
    if (suggestedMatchSuppressesAsk) {
      return { action: 'skip', reason: 'doc_match_pending', blockers: ['doc_match_pending'] };
    }
    return { action: 'owner_ask', reason: 'owner_fact_required', blockers: [] };
  }

  // 2.7. Coding-refusal owner-fact ask (Slice 4 of the case-health contract,
  //      2026-08-17 — closes the §4 writer gap). The coder produced a verdict
  //      and REFUSED to name an account: proposed_account absent/Suspense with
  //      the MODEL's own receipt on it (model id or reasoning). That refusal
  //      is the persisted statement that a business fact only the owner holds
  //      is missing — the canonical case is a bank transfer whose counter-
  //      account ownership Donna cannot know. Receipt-shaped exclusions keep
  //      this narrow: a `rules_fallback` template's Suspense is not a model
  //      refusal (the strong coder never looked), and a `missing_account`
  //      park resolves mechanically (ensureLedgerAccountFromVerdict) — neither
  //      may interrupt the owner. A settled/doc-matched line never lands here
  //      (the match is machine-side context; its uncoded state is Leak C, a
  //      system gap, not an owner question). Same §B re-ask and held-evidence
  //      guards as every ask rule.
  const modelRefusal = !coded
    && !s.missing_account
    && norm(s.source).toLowerCase() !== 'rules_fallback'
    && Boolean(norm(s.model) || norm(s.reasoning));
  if (modelRefusal && !evidenceSatisfiedByMatch) {
    if (hasPendingEvidenceRequest) {
      return { action: 'skip', reason: 'evidence_request_pending', blockers: ['evidence_request_pending'] };
    }
    if (suggestedMatchSuppressesAsk) {
      return { action: 'skip', reason: 'doc_match_pending', blockers: ['doc_match_pending'] };
    }
    return { action: 'owner_ask', reason: 'coding_refusal_owner_fact', blockers: [] };
  }

  // 3. Auto-post — confident, no evidence needed, real P&L (non-red) account.
  //    BOUNDED (2026-08-04, §4b-xv): an UNMATCHED line here is a
  //    description-only posting — the coder's evidence_required flag is a
  //    model verdict that has been observed to flip between identical runs
  //    (true → the ask lane; false → this branch), and with no amount bound
  //    that flip silently auto-posted a $2,283 Shopify payout and a $2,219
  //    lease payment with NO document. The Keep layer's own line is
  //    "anything unevidenced above a materiality threshold stays proposed"
  //    (CLAUDE.md L1) — so this branch binds to the SAME description-only
  //    ceiling the batch-apply lane already obeys
  //    (__descriptionOnlyAutoApplyCeiling, default 50): micro-spend
  //    auto-posts; anything material goes to the owner as a DOCUMENT ask
  //    (the payout report / invoice exists — the owner holds it). Amount
  //    unknown (pure-gate callers that don't thread it) keeps the legacy
  //    behavior; both production loaders select it, pinned by test.
  if (coded && evidenceRequired === false && semanticDecision && !red && pnlSafe) {
    const boundedAmount = Number(amount);
    const cap = Number(unevidencedCap);
    if (Number.isFinite(boundedAmount) && Number.isFinite(cap) && boundedAmount > cap) {
      if (hasPendingEvidenceRequest) {
        return { action: 'skip', reason: 'evidence_request_pending', blockers: ['evidence_request_pending'] };
      }
      // Held-evidence suppression, rule-3 flavor: the document the ask would
      // chase is already matched at 'suggested' — surface, never ask.
      if (suggestedMatchSuppressesAsk) {
        return { action: 'skip', reason: 'doc_match_pending', blockers: ['doc_match_pending'] };
      }
      return { action: 'owner_ask', reason: 'unevidenced_material', blockers: [] };
    }
    return { action: 'auto_post', reason: 'confident_no_evidence_pnl', blockers: [] };
  }

  // 3.5. Laneless-match owner ask (Desert Rose Jan-10, round-4 review
  //      2026-09-01 §C). The matcher named a document for this line but held
  //      it below the floor — a 'suggested' match with NO settle lane (no
  //      material/authority hold, no ambiguity, so no gather will ever pick
  //      it up), and the coding is medium confidence with no evidence flag
  //      (or a balance-sheet/red account), so none of the rules above fire.
  //      #1945 closed this hole only for `evidence_required === true`; a
  //      coded line with `evidence_required === false` fell through to the
  //      skip below with `[doc_match_pending, confidence_below_high]` and
  //      rested on NOBODY — the forbidden third state. The persisted answer
  //      to "which file?" is the matcher's own candidate, so the sweep cites
  //      it (the suggested_doc_match.filename branch) and asks the owner to
  //      confirm the document, exactly as the evidence_required flavour
  //      does. Gated the same way as every ask rule: never on a settled
  //      line, never a re-ask while a request is live. A hold WITH a lane is
  //      untouched — the Mann Lake law (never chase a document the matcher
  //      already found) stays byte-identical there.
  const lanelessSuggestedMatch = hasSuggestedDocMatch && suggestedDocMatchHasSettleLane === false;
  if (lanelessSuggestedMatch && coded && !evidenceSatisfiedByMatch) {
    if (hasPendingEvidenceRequest) {
      return { action: 'skip', reason: 'evidence_request_pending', blockers: ['evidence_request_pending'] };
    }
    return { action: 'owner_ask', reason: 'laneless_match_evidence', blockers: [] };
  }

  // Skip — surfaced at 'suggested', never silently terminal. Report why.
  // A live evidence request outranks every other blocker label: the line is
  // ALREADY on the owner (the sanctioned terminal), so reporting it as
  // not_coded/confidence_below_high over-counts the firm-limbo pile in the
  // sweep receipt (the Honeybee not_coded:10 read — 7 of the 10 had live
  // asks). Label only; the action stays skip either way.
  const blockers = [];
  if (hasPendingEvidenceRequest) blockers.push('evidence_request_pending');
  if (hasSuggestedDocMatch) blockers.push('doc_match_pending');
  if (!coded) blockers.push('not_coded');
  if (evidenceRequired === true) blockers.push('evidence_required_uncoded');
  else if (evidenceRequired !== false) blockers.push('evidence_flag_unknown');
  if (!semanticDecision && !evidenceSatisfiedByMatch) blockers.push('confidence_below_high');
  if (red) blockers.push('red_account');
  if (!pnlSafe) blockers.push('balance_sheet_account');
  return { action: 'skip', reason: blockers[0] || 'ineligible', blockers };
};

// G-7P (D-G7P-4) — the demotion wrapper. ONLY a would-be auto_post demotes:
// lines already headed to owner_ask or skip keep their verdicts untouched (the
// design's exact scope — "a would-be auto-posted journal ... demotes", nothing
// broader). Gate off ⇒ byte-identical to the core. Uses the SAME resolver the
// posting preview uses, so this decision and the code that would actually
// reach ledger_lines.tax_type can never disagree.
export const evaluateCodingAutoPost = (args = {}) => {
  const verdict = evaluateCodingAutoPostCore(args);
  // Execution limits are not evidence that a fact is missing. Preserve
  // Jev's explicit resolution and expose the refusal instead of inventing
  // an owner question from an account type, amount or model floor.
  if (verdict.action === 'owner_ask' && hasJevResolvedCoding(args.suggestion)
    && !['cross_entity_relation','revenue_source_required','statutory_evidence_required'].includes(verdict.reason)
    && !['chase_receipt', 'chase_evidence'].includes(args.bankLineDisposition)) {
    return { action: 'skip', reason: 'jev_execution_refused', blockers: [verdict.reason] };
  }
  const policy = resolvePostingAdmission(args.clientContext || { jurisdiction: args.jurisdiction });
  return policy?.codingAutoPostVerdict?.({ ...args, verdict }) ?? verdict;
};

// Deterministic client-facing LINE CONTEXT (the ① legibility fix, 2026-08-06):
// date + amount + description snippet from the transaction row the sweep
// already loads, so ten asks stop rendering as four indistinguishable "Sales"
// questions. Pure string assembly — no LLM, no locale machinery.
const ASK_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const formatAskDate = (value) => {
  // The production PostgreSQL client may hydrate DATE as a local-midnight
  // Date object. Preserve that calendar date with local getters; ISO
  // conversion can move it to the prior day in positive-offset timezones.
  const source = value instanceof Date && !Number.isNaN(value.getTime())
    ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
    : norm(value).slice(0, 10);
  const m = source.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const monthIndex = Number(m[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) return '';
  return `${Number(m[3])} ${ASK_MONTHS[monthIndex]} ${m[1]}`;
};

export const formatAskLineContext = (line = {}) => {
  if (!line || typeof line !== 'object') return '';
  const description = norm(line.description).slice(0, 80);
  const date = formatAskDate(line.transaction_date ?? line.date);
  const outAmount = Math.abs(Number(line.money_out)) || 0;
  const inAmount = Math.abs(Number(line.money_in)) || 0;
  const amount = outAmount || inAmount;
  const currency = norm(line.currency).toUpperCase();
  const amountLabel = amount
    ? `${currency ? `${currency} ` : ''}${amount.toFixed(2)} ${outAmount ? 'paid' : 'received'}`
    : '';
  const head = [amountLabel, date ? `on ${date}` : ''].filter(Boolean).join(' ');
  if (!head) return description ? `“${description}”` : '';
  return description ? `${head} — “${description}”` : head;
};

// Templated owner-ask question (no LLM in the sweep — the batch ask pipeline
// refines wording later; this reaches the on_owner terminal now). Kept generic
// so it reads sensibly for income and expense lines alike. `line` is optional
// (older callers/tests omit it → the original wording, byte-identical).
export const buildOwnerAskQuestion = (suggestion = {}, line = null, onFileCandidates = []) => {
  const account = norm(suggestion?.proposed_account || suggestion?.account_name || suggestion?.account_code) || 'this account';
  const context = formatAskLineContext(line);
  const lead = context
    ? `About ${context}: can you confirm what this transaction was for?`
    : 'Can you confirm what this transaction was for?';
  // Ask honesty (2026-09-01, Desert Rose): a document already on Donna's side
  // must never be described as missing (the local-evidence inventory's own
  // contract — the batch drafter already honours it; this per-line template
  // was the one factory still claiming absence with the artifact on file).
  // Name at most two candidates; more than that is noise, not identification.
  const files = (Array.isArray(onFileCandidates) ? onFileCandidates : [])
    .map((candidate) => String(candidate?.filename || '').trim())
    .filter(Boolean)
    .slice(0, 2);
  if (files.length) {
    return `${lead} We've coded it as "${account}" and we already have ${files.join(' and ')} on file — if that covers it, a one-line confirmation is enough; if not, tell us what this was for or send the right document.`;
  }
  return `${lead} We've coded it as "${account}" but need a supporting document (invoice or receipt) to finalise it.`;
};

// The owner-FACT flavor (rule 2.6): no document will ever exist for an
// owner-equity movement, so asking for one is a dead end — the missing piece
// is what the movement WAS, which only the owner knows.
export const buildOwnerFactQuestion = (suggestion = {}, line = null) => {
  const account = norm(suggestion?.proposed_account || suggestion?.account_name || suggestion?.account_code) || 'an owner transfer';
  const context = formatAskLineContext(line);
  const lead = context
    ? `About ${context}: this looks like a transfer to or from you`
    : 'This looks like a transfer to or from you';
  return `${lead} — we've provisionally coded it as "${account}". Can you confirm what it was: a personal draw, a capital contribution or repayment, or something else? A one-line reply is enough; we'll record it accordingly.`;
};

// A matched liability/asset line already has its document; the missing input
// is which balance the payment settles. Never ask for another receipt here.
export const buildBalanceSheetTreatmentQuestion = (suggestion = {}, line = null) => {
  const account = norm(suggestion?.proposed_account || suggestion?.account_name || suggestion?.account_code) || 'a balance-sheet account';
  const context = formatAskLineContext(line);
  const lead = context ? `About ${context}` : 'About this transaction';
  return `${lead}: we have the supporting document and provisionally coded it as "${account}". Can you confirm what balance this settles (for example payroll taxes, a card, a loan, or an owner account), or tell us the correct treatment? A one-line reply is enough.`;
};

// The coding-refusal flavor (rule 2.7): the coder could not name an account
// at all, so there is no account to mention and no document to chase — the
// smallest unlocking question is "what was this?", with the own-account
// transfer named as the canonical option (the §4 case). Deterministic
// template, no LLM in the sweep — same division of labor as the other
// builders (the batch ask pipeline refines wording later); the reply feeds
// the recode lane, which distills the learned fact (e.g. "account NNNN is
// ours") into firm memory.
export const buildCodingRefusalQuestion = (suggestion = {}, line = null) => {
  const context = formatAskLineContext(line);
  const lead = context
    ? `About ${context}: we couldn't tell what this was from the bank line alone.`
    : "We couldn't tell what this transaction was from the bank line alone.";
  return `${lead} Can you tell us what it was — for example a transfer between your own accounts (and if so, which account), a payment to someone, or something personal? A one-line reply is enough; we'll record it accordingly.`;
};

// The cross-entity FACT flavor (rule 1.7): the matched document's own side is
// a DIFFERENT entity than this book — the ask names the relation from the
// guard's persisted stamp (crossEntityGuard.crossEntityPayload.own_side;
// render the persisted verdict, never re-infer at the surface).
export const buildCrossEntityFactQuestion = ({ suggestion = {}, crossEntity = {}, line = null } = {}) => {
  const ownSide = norm(crossEntity?.own_side) || 'someone other than your business';
  const context = formatAskLineContext(line);
  const lead = context ? `About ${context}: the supporting material` : 'The supporting material';
  return `${lead} names ${ownSide} rather than your business. How does this payment relate to your business, and whose purchase or obligation does it settle? Please explain the relationship; you do not need to upload the same material again.`;
};

// The FACT each owner ask needs (RT-11 item 5, audit F-17), named at MINT time
// so evidence_type is honest — because evidence_type is now the lifecycle law:
// a 'supporting_document' ask is answered by a document arriving
// (resolve-on-match, D3) and by Donna's own immaterial auto_explain (D4); a
// purpose / account ask is answered only by the owner and survives both.
//   purpose  — what the movement WAS (an owner-equity movement, a coding
//              refusal, a cross-entity relation): 'business_purpose', the
//              drafter's own word for it (askPipeline ASK_EVIDENCE_TYPES).
//   account  — WHICH balance a matched payment settles: 'account_treatment'.
//   document — the plain evidence ask: 'supporting_document'.
// The Finnish scope-drift demotion keeps its own lane ('scope_drift_review').
export const OWNER_ASK_FACTS = Object.freeze({
  purpose: 'business_purpose',
  account: 'account_treatment',
  document: 'supporting_document',
  payroll: 'payroll_package',
  discrepancy: 'document_discrepancy'
});

export const ownerAskFactForReason = (reason) => {
  switch (String(reason || '')) {
    case 'owner_fact_required':
    case 'coding_owner_fact':
    case 'coding_refusal_owner_fact':
    case 'cross_entity_relation':
      return 'purpose';
    case 'coding_document_discrepancy':
      return 'discrepancy';
    case 'coding_payroll_package':
      return 'payroll';
    case 'settled_balance_sheet_treatment':
      return 'account';
    default:
      return 'document';
  }
};

// One entry point over the builders above: the question AND the fact it needs,
// from one place, so the mint can never pair a fact question with a document
// evidence_type (the pre-RT-11 shape: every fact flavor minted as 'owner_fact').
export const buildOwnerAsk = ({ reason, suggestion = {}, line = null, crossEntity = {}, onFileCandidates = [] } = {}) => {
  const fact = reason === 'coding_owner_fact' && JEV_DOCUMENT_ASK_SELECTIONS.includes(suggestion.jev_decision?.selected)
    ? 'document' : ownerAskFactForReason(reason);
  const key = String(reason || '');
  // A Jev source-document ask names the document it needs; keep that wording.
  // The shared contract's unsure-treatment guard (transactionLlm.js) asks the
  // same question for the strong coder's coding; keep that wording too.
  const jevDocumentQuestion = key === 'evidence_required'
    && (suggestion.jev_decision?.selected === 'ask_source_document' || suggestion.jev_decision?.tax_evidence_required === true
      || suggestion.tax_unresolved_guard?.constraint === 'unsure_treatment_statement_only')
    ? norm(suggestion.ask_client_question) : '';
  const question = jevDocumentQuestion || (['coding_owner_fact', 'coding_payroll_package', 'coding_document_discrepancy'].includes(key)
    ? (norm(suggestion.ask_client_question) || (key === 'coding_payroll_package'
      ? `About ${formatAskLineContext(line)}: please provide the balanced external payroll journal, including gross pay, withholding, employer contributions and liability accounts. A payslip alone does not contain the complete payroll posting.`
      : `About ${formatAskLineContext(line)}: what was the business purpose, and was any part personal? We will use your answer to book it.`))
    : key === 'revenue_source_required'
      ? (onFileCandidates.length ? buildOwnerAskQuestion(suggestion,line,onFileCandidates) : `About ${formatAskLineContext(line)}: please provide or identify the sales or settlement record supporting this receipt, including gross sales, tax, deductions and whether those sales were already recorded. For a cash deposit, the cashbook or till reconciliation is needed; the bank deposit alone does not establish new sales.`)
    : key === 'statutory_evidence_required'
      ? `About ${formatAskLineContext(line)}: please provide the filing or notice identifying the liability and period this payment settles. The bank description identifies the payment but does not supply that supporting source.`
    : key === 'cross_entity_relation'
    ? buildCrossEntityFactQuestion({ suggestion, crossEntity, line })
    : key === 'settled_balance_sheet_treatment'
      ? buildBalanceSheetTreatmentQuestion(suggestion, line)
      : key === 'coding_refusal_owner_fact'
        ? buildCodingRefusalQuestion(suggestion, line)
        : key === 'owner_fact_required'
          ? buildOwnerFactQuestion(suggestion, line)
          : buildOwnerAskQuestion(suggestion, line, onFileCandidates));
  return { fact, evidence_type: OWNER_ASK_FACTS[fact], question };
};

// Source-of-truth candidate pool. A persisted suggested coding belongs to the
// transaction; a transaction_review_queue row is useful case-file context but
// is not an admission ticket. This matters when coding wins the race against a
// later document match: the batch coder writes the verdict directly on the
// transaction, the match then settles it, and no queue row may ever exist.
// Reading from q made that exact order permanently invisible to both this
// sweep and its near-realtime wrapper.
export const CODING_AUTO_POST_CANDIDATES_SQL = `
  select q.id                                      as review_item_id,
         t.id                                      as transaction_id,
         t.reconciliation_status,
         (select json_build_object('jurisdiction', c.jurisdiction, 'entity_type', c.entity_type, 'profile', c.profile)
            from clients c where c.id = t.client_id and c.firm_id = t.firm_id) as client_context,
         greatest(coalesce(t.money_in, 0), coalesce(t.money_out, 0)) as line_amount,
         t.description                             as line_description,
         t.transaction_date                        as line_date,
         t.money_in                                as line_money_in,
         t.money_out                               as line_money_out,
         t.currency                                as line_currency,
         t.payload->'ai_suggestion'                as ai_suggestion,
         (select json_build_object('document_type',d.document_type,'match_status',m.status)
            from reconciliation_matches m join documents d on d.id=m.matched_object_id and d.firm_id=m.firm_id and d.client_id=m.client_id
           where m.firm_id=t.firm_id and m.client_id=t.client_id and m.bank_transaction_id=t.id
             and m.status in ('confirmed','auto_matched') and d.parse_status='completed'
             and d.document_type in ('sales_invoice','issued_receipt','payout_statement')
           order by m.id limit 1) as revenue_document,
         (select json_build_object('document_type',d.document_type,'match_status',m.status)
            from reconciliation_matches m join documents d on d.id=m.matched_object_id and d.firm_id=m.firm_id and d.client_id=m.client_id
           where m.firm_id=t.firm_id and m.client_id=t.client_id and m.bank_transaction_id=t.id
             and m.status in ('confirmed','auto_matched') and d.parse_status='completed'
             and d.document_type in ('supplier_bill','payment_confirmation','tax_notice','tax_return','statutory_notice')
           order by m.id limit 1) as statutory_document,
         coalesce(
           t.payload->>'bank_line_disposition',
           (select e.payload->>'disposition'
              from reconciliation_evaluations e
             where e.firm_id = t.firm_id
               and e.client_id = t.client_id
               and e.target_type = 'transaction'
               and e.target_id = t.id
               and e.matcher_family = 'bank_line_disposition'
               and not (e.payload ? 'superseded_by_match_id')
             order by e.created_at desc nulls last
             limit 1)
         )                                         as bank_line_disposition,
         exists (
           select 1 from reconciliation_matches m
            where m.firm_id = t.firm_id
              and m.client_id = t.client_id
              and m.bank_transaction_id = t.id
              and m.matched_object_type <> 'bank_line'
              and m.status in ('auto_matched', 'confirmed')
         )                                         as has_doc_match,
         exists (
           select 1 from reconciliation_matches m
            where m.firm_id = t.firm_id
              and m.client_id = t.client_id
              and m.bank_transaction_id = t.id
              and m.matched_object_type <> 'bank_line'
              and m.status = 'suggested'
         )                                         as has_suggested_doc_match,
         (
           select json_build_object(
             'reasons', coalesce(m.payload->'authorization'->'reasons', '[]'::jsonb),
             'document_id', coalesce(m.matched_object_id, ''),
             'filename', coalesce(d.filename, '')
           )
             from reconciliation_matches m
             left join documents d
               on d.id = m.matched_object_id and d.firm_id = m.firm_id
            where m.firm_id = t.firm_id
              and m.client_id = t.client_id
              and m.bank_transaction_id = t.id
              and m.matched_object_type <> 'bank_line'
              and m.status = 'suggested'
            order by m.updated_at desc nulls last
            limit 1
         )                                         as suggested_doc_match,
         (
           select m.payload->'cross_entity'
             from reconciliation_matches m
            where m.firm_id = t.firm_id
              and m.client_id = t.client_id
              and m.bank_transaction_id = t.id
              and m.status in ('suggested', 'auto_matched', 'confirmed')
              and (m.payload ? 'cross_entity')
            order by m.created_at desc nulls last
            limit 1
         )                                         as cross_entity,
         exists (
           select 1 from client_evidence_requests r
            where r.firm_id = t.firm_id
              and r.client_id = t.client_id
              and r.transaction_id = t.id
              and lower(r.status) in ('draft', 'open', 'replied')
         )                                         as has_pending_evidence_request
    from transactions t
    left join lateral (
      select candidate.id
        from transaction_review_queue candidate
       where candidate.firm_id = t.firm_id
         and candidate.client_id = t.client_id
         and candidate.status = 'open'
         and candidate.item_type <> 'document_line'
         and coalesce(candidate.payload->>'transaction_id', candidate.item_id) = t.id
       order by candidate.updated_at desc nulls last, candidate.id
       limit 1
    ) q on true
   where t.firm_id = $1
     and t.client_id = $2
     and ($3::text is null or t.id = $3)
     and (t.payload->'ai_suggestion') is not null
     and (t.coding_state = 'proposed' or (t.coding_state = 'asked'
       and t.payload->'ai_suggestion'->>'posting_requirement' = 'owner_fact'))
   order by t.transaction_date nulls last, t.created_at, t.id
`;

const loadCodingAutoPostCandidates = async ({ firmId, clientId, transactionId = null } = {}) => {
  if (!firmId || !clientId) return [];
  return withFirmDbClient(async (client) => {
    const result = await client.query(CODING_AUTO_POST_CANDIDATES_SQL, [firmId, clientId, transactionId]);
    return result.rows || [];
  });
};

export const loadCodingAutoPostCandidatesForTransaction = async ({ firmId, clientId, transactionId } = {}) => {
  if (!transactionId) return [];
  return loadCodingAutoPostCandidates({ firmId, clientId, transactionId });
};

// Compose the existing ask writer under the same source fence as coding.
// No model call, send, new question identity, or authority over another producer.
const refreshCodingOwnerDraft = async ({firmId, clientId, row, evaluateRow}) => withFirmDbClient(async client => {
  await client.query('begin');
  try {
    await client.query('select id from clients where firm_id=$1 and id=$2 for update', [firmId,clientId]);
    await client.query('select id from transactions where firm_id=$1 and client_id=$2 and id=$3 for update', [firmId,clientId,row.transaction_id]);
    const asks = (await client.query(`select ask.*,
      (select a.actor_id from audit_events a where a.firm_id=ask.firm_id and a.client_id=ask.client_id
        and a.resource_id=ask.id and a.action='evidence_request.create' order by a.id desc limit 1) as last_mint_actor_id
      from client_evidence_requests ask where firm_id=$1 and client_id=$2 and transaction_id=$3
        and audience='client' and status in ('draft','open','replied') order by id for update`,
    [firmId,clientId,row.transaction_id])).rows;
    const prior = asks[0];
    const codingOwned = prior?.created_by === 'coding_auto_post' && prior?.last_mint_actor_id === 'coding_auto_post';
    // Current coding may refine the earlier disposition stage's machine ask.
    // A generic system actor alone never authorizes rewriting another producer.
    const dispositionOwned = prior?.created_by === 'system'
      && (prior?.last_mint_actor_id === 'system' || (prior?.last_mint_actor_id === 'coding_auto_post'
        && prior?.request_payload?.coding_draft_refresh?.authority_basis === 'current_source_backed_coding_draft_refresh'))
      && prior?.request_payload?.lane === 'needs_human_disposition'
      && prior?.request_payload?.disposition === 'needs_human';
    const safe = asks.length === 1 && prior.status === 'draft' && Number(prior.send_count) === 0
      && !prior.first_sent_at && !prior.last_sent_at && !prior.responded_at
      && !Object.keys(prior.response_payload || {}).length && !prior.request_payload?.amendments?.length
      && (codingOwned || dispositionOwned)
      && prior.request_payload?.authority_basis !== 'persisted_match_requires_owner_confirmation';
    if (!safe) { await client.query('rollback'); return false; }
    const {caseEvidence} = await readJevCase({client,firmId,clientId,transactionId:row.transaction_id,evidenceOnly:true,lockEvidence:true});
    const current = (await client.query(CODING_AUTO_POST_CANDIDATES_SQL,[firmId,clientId,row.transaction_id])).rows[0];
    const digest = codingCaseRevision(caseEvidence);
    if (!current || !isDeepStrictEqual(current.ai_suggestion,row.ai_suggestion)
      || current.ai_suggestion.case_evidence_digest !== digest
      || caseEvidence.coverage.status !== 'complete_within_scope') {
      await client.query('rollback'); return false;
    }
    const verdict = evaluateRow(current,false);
    if (verdict.action !== 'owner_ask' || !['cross_entity_relation','coding_owner_fact','coding_payroll_package',
      'coding_document_discrepancy','statutory_evidence_required','revenue_source_required'].includes(verdict.reason)) {
      await client.query('rollback'); return false;
    }
    const inventory = await loadLocalEvidenceCandidatesWithClient({client,firmId,clientId,transactionIds:[row.transaction_id]});
    const onFileCandidates = citableEvidenceCandidates(inventory.get(String(row.transaction_id)) || []);
    const ask = buildOwnerAsk({reason:verdict.reason,suggestion:current.ai_suggestion,crossEntity:current.cross_entity || {},
      line:{description:current.line_description,transaction_date:current.line_date,money_in:current.line_money_in,
        money_out:current.line_money_out,currency:current.line_currency},onFileCandidates});
    if (prior.question === ask.question && prior.evidence_type === ask.evidence_type) { await client.query('rollback'); return false; }
    const receipt = {authority_basis:'current_source_backed_coding_draft_refresh',source_digest:digest,
      previous_question:prior.question,previous_evidence_type:prior.evidence_type,question:ask.question,
      evidence_type:ask.evidence_type,model:current.ai_suggestion.model || null};
    const request = await __createClientEvidenceRequestWithClient({client,firmId,clientId,transactionId:row.transaction_id,
      reviewItemId:current.review_item_id,question:ask.question,evidenceType:ask.evidence_type,actorId:'coding_auto_post',
      requestContext:{coding_draft_refresh:receipt,citable_local_evidence:onFileCandidates.map(item=>({document_id:item.document_id || item.id,filename:item.filename}))}});
    if (request.id !== prior.id) throw new Error('coding_draft_refresh_identity_changed');
    await client.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
      values($1,$2,'system','coding_auto_post','coding.owner_draft_refreshed','client_evidence_request',$3,$4::jsonb)`,
    [firmId,clientId,prior.id,JSON.stringify(receipt)]);
    await client.query('commit'); return true;
  } catch(error) { await client.query('rollback'); throw error; }
});

// ── The sweep ─────────────────────────────────────────────────────────────────
// Loads the client's transaction-owned `suggested` codings, joins an existing
// review case when present, evaluates each through the pure gate, and routes it
// to the matching writer. A missing case is minted only before a writer that
// requires one. Canary-gated + fail-closed. Each
// writer call is its own transaction, so one failure isolates. Pure-friendly:
// the DB access and both writers are injectable for tests.
export const sweepCodingAutoPost = async ({
  firmId,
  clientId,
  env = process.env,
  // Config control plane: pass a pre-read snapshot (codingConvergence does) to
  // skip the read here; `undefined` means "read it yourself". Soft-fails to
  // null ⇒ the env-canary fallback, never a throw into the sweep.
  configSnapshot = undefined,
  readConfigSnapshotFn = readClientConfigSnapshotInDb,
  loadCandidatesFn = null,
  ensureReviewItemFn = ensureTransactionReviewItemInDb,
  updateReviewItemFn = updateTransactionReviewItemInDb,
  createEvidenceRequestFn = createClientEvidenceRequestInDb,
  loadLocalEvidenceFn = null,
  postLedgerFn = postLedgerTransactionInDb,
  getAccountingSystemFn = getClientAccountingSystemFromDb,
  processingScopeFn = readRetainedProcessingScopeInDb,
  markCodingFyiPendingFn = markCodingAutoPostFyiPendingInDb,
  // §4b-xv — the unevidenced-material bound on rule 3: the SAME
  // description-only ceiling the batch-apply lane obeys (default 50,
  // DONNA_AUTO_APPLY_CEILING). Injectable for tests.
  descriptionOnlyCeilingFn = __descriptionOnlyAutoApplyCeiling
} = {}) => {
  const zero = {
    evaluated: 0, auto_posted: 0, owner_asked: 0, skipped: 0, errors: 0,
    case_files_minted: 0,
    // ledger_posted counts auto-posts that also landed a posted ledger journal
    // (the state the reports read); ledger_post_errors are accepts whose post
    // step soft-failed (line stays accepted). Both only move for Donna-ledger
    // clients — connector clients (Xero/QBO) are accept-only here by design.
    ledger_posted: 0, ledger_post_errors: 0,
    // Terminal A (owner-transfer decide-and-notify): subset of auto_posted that
    // went through the owner-equity branch; fyi_marked counts the FYI receipt
    // markers written (the owner FYI rides the next ask batch); fyi_mark_errors
    // are marker writes that soft-failed (posting stands, FYI re-attempted on
    // the next sweep pass over... nothing — the marker IS the gather key, so a
    // failed mark means no FYI; it is counted, never silent).
    owner_transfer_posted: 0, fyi_marked: 0, fyi_mark_errors: 0,
    skip_reasons: {}, gated: false
  };
  if (!firmId || !clientId) return { ...zero, reason: 'missing_ids' };
  let snapshot = configSnapshot;
  if (snapshot === undefined) {
    try {
      snapshot = await readConfigSnapshotFn({ firmId, clientId });
    } catch {
      snapshot = null;
    }
  }
  if (!codingAutoPostAllows({ clientId, snapshot, env })) {
    return { ...zero, gated: true, reason: 'canary_closed' };
  }

  // Terminal A gate, resolved ONCE per sweep off the same snapshot (zero extra
  // reads). Off ⇒ the owner-equity branch in the pure gate is inert and every
  // owner-transfer line skips exactly as before. The stage/source pair is
  // stamped into each posting's FYI receipt so "under which authority did this
  // post" is answerable from the data alone.
  const ownerTransferAllowed = codingOwnerTransferPostAllows({ snapshot, env });
  const unevidencedCap = descriptionOnlyCeilingFn();
  const ownerTransferFlagRow = snapshot && typeof snapshot === 'object'
    ? snapshot[CODING_OWNER_TRANSFER_POST_FLAG_KEY] || null
    : null;

  // Post to the internal Donna ledger ONLY for clients whose books ARE the Donna
  // ledger (accounting_system='none'). Connector clients (Xero/QBO) keep the
  // accept-only behaviour — pushing their books is a separate, firm-gated
  // writeback (CLAUDE.md: a correction inside Donna is not a push to Xero/QBO).
  // Fetched once per sweep (not per line); a lookup failure fails safe to
  // accept-only (postToLedger=false), never blocks the accepts.
  let postToLedger = false;
  try {
    postToLedger = String((await getAccountingSystemFn({ firmId, clientId })) || 'none') === 'none';
  } catch {
    postToLedger = false;
  }

  const processingScope = await processingScopeFn({ firmId,clientId });
  const reviewOnly = processingScope.enforced === true;
  if (reviewOnly) postToLedger = false;

  const loadCandidates = loadCandidatesFn || (() =>
    loadCodingAutoPostCandidates({ firmId, clientId }));

  const candidates = await loadCandidates();
  const stats = { ...zero, ...(reviewOnly ? { review_saved: 0, accounting_ready: false } : {}) };
  const bump = (reason) => { stats.skip_reasons[reason] = (stats.skip_reasons[reason] || 0) + 1; };

  // Ask honesty (2026-09-01, Desert Rose): before a generic evidence ask
  // claims a document is missing, consult the SAME bounded local-evidence
  // inventory the batch pipeline uses at draft and send. Lazy + memoized —
  // one bounded read per sweep, and only when a generic ask is actually
  // about to mint — and soft-fail: an unavailable inventory yields an empty
  // map and the original wording. It never changes a verdict, only wording.
  const loadLocalEvidence = loadLocalEvidenceFn || ((transactionIds) =>
    withFirmDbClient((dbClient) => loadLocalEvidenceCandidatesWithClient({
      client: dbClient, firmId, clientId, transactionIds
    })));
  let localEvidencePromise = null;
  const localEvidenceForSweep = () => {
    if (!localEvidencePromise) {
      const transactionIds = (Array.isArray(candidates) ? candidates : [])
        .map((row) => row?.transaction_id)
        .filter(Boolean);
      localEvidencePromise = Promise.resolve()
        .then(() => loadLocalEvidence(transactionIds))
        .catch(() => new Map());
    }
    return localEvidencePromise;
  };

  const evaluateRow = (row, hasPending = row?.has_pending_evidence_request === true) => evaluateCodingAutoPost({
      suggestion: row?.ai_suggestion || {},
      moneyOut:row?.line_money_out || 0, statutoryDocument:row?.statutory_document || null,
      moneyIn:row?.line_money_in || 0, revenueDocument:row?.revenue_document || null,
      reconciliationStatus: row?.reconciliation_status || null,
      hasDocMatch: row?.has_doc_match === true,
      hasSuggestedDocMatch: row?.has_suggested_doc_match === true,
      // Whether that suggested match's hold can still reach a terminal on its
      // own (a material/authority hold or an ambiguity — each has a gather).
      // A hold with no lane (below_floor) must NOT silence the owner ask.
      // Absent/empty reasons (a legacy match row, or a caller with no match
      // data) must read as "assume a lane" — the conservative direction, which
      // keeps the Mann Lake law intact and mints no new asks. Only a match that
      // actually STATES its hold reasons can be judged laneless.
      suggestedDocMatchHasSettleLane:
        Array.isArray(row?.suggested_doc_match?.reasons) && row.suggested_doc_match.reasons.length
          ? suggestedMatchHasSettleLane(row.suggested_doc_match.reasons)
          : true,
      crossEntity: row?.cross_entity && typeof row.cross_entity === 'object' ? row.cross_entity : null,
      hasPendingEvidenceRequest: hasPending,
      // RT-26 (2): the disposition lane's statutory settle on the row — the
      // filing is the evidence, so a liability coding posts (rule 1.1).
      statutorySettlement: false,
      bankLineDisposition: row?.bank_line_disposition || null,
      ownerTransferAllowed,
      clientContext: row?.client_context,
      snapshot,
      env,
      amount: row?.line_amount == null ? null : Number(row.line_amount),
      unevidencedCap
    });
  for (const row of Array.isArray(candidates) ? candidates : []) {
    stats.evaluated += 1;
    const suggestion = row?.ai_suggestion && typeof row.ai_suggestion === 'object' ? row.ai_suggestion : {};
    const verdict = evaluateRow(row);
    // The ① legibility context — every ask names its line (date + amount +
    // description) so the portal and the batch message read right.
    const askLine = {
      description: row?.line_description,
      transaction_date: row?.line_date,
      money_in: row?.line_money_in,
      money_out: row?.line_money_out,
      currency: row?.line_currency
    };
    try {
      if (verdict.action === 'auto_post') {
        let reviewItemId = row.review_item_id || null;
        if (!reviewItemId) {
          reviewItemId = await ensureReviewItemFn({
            firmId,
            clientId,
            transactionId: row.transaction_id,
            source: 'coding_auto_post:settled_suggestion',
            caseReason: 'coding_convergence_bare_line',
            caseIdSuffix: 'coding-convergence'
          });
          if (!reviewItemId) throw new Error('coding_auto_post_case_file_missing');
          stats.case_files_minted += 1;
        }
        const isOwnerTransfer = verdict.reason === 'owner_transfer_decide_and_notify';
        // RT-26 (2): the note names the evidence the liability posting rests on.
        const isEvidencedLiability = verdict.reason === 'evidenced_liability_settlement';
        await updateReviewItemFn({
          firmId,
          reviewItemId,
          patch: {
            // RT-16: the machine vocabulary straight to the writer — applied.
            coding_state: 'applied',
            account_code: suggestion.account_code || suggestion.proposed_account || undefined,
            account_name: suggestion.account_name || undefined,
            account_label: suggestion.account_label || undefined,
            category: suggestion.category || suggestion.proposed_account || undefined,
            proposed_account: suggestion.proposed_account || undefined,
            xero_account_id: suggestion.xero_account_id || undefined,
            xero_account_code: suggestion.xero_account_code || undefined,
            xero_account_name: suggestion.xero_account_name || undefined,
            xero_tax_type: suggestion.xero_tax_type || undefined,
            tax_treatment: suggestion.tax_treatment || undefined,
            // The named review writer owns both the account mutation and the
            // coding lifecycle receipt. Leaving this at `suggested` after an
            // unattended accept makes the owner-ask gather re-ask settled
            // work and hides a later document from the posted-line matcher.
            ai_suggestion_status: 'auto_applied',
            ai_suggestion_applied_via: 'coding_auto_post',
            support_note: reviewOnly ? 'Coding review saved. Accounting posting is unavailable for this workspace.' : isOwnerTransfer
              ? `Auto-posted by Donna — transfer to/from the owner, coded to "${suggestion.proposed_account || suggestion.account_name || 'owner equity'}". FYI'd to the owner; a reply corrects it.`
              : isEvidencedLiability
                ? `Auto-posted by Donna — settles "${suggestion.proposed_account || suggestion.account_name || 'the liability'}"; evidenced by ${row?.has_doc_match === true ? 'the matched document' : 'the identified obligation'}.`
                : 'Auto-posted by Donna — high-confidence coding, no supporting evidence required.'
          },
          returnSnapshot: false,
          actorId: 'coding_auto_post',
          reviewAcceptanceBasis: `existing_coding_auto_post:${verdict.reason}`
        });
        if (reviewOnly) stats.review_saved += 1; else stats.auto_posted += 1;
        if (isOwnerTransfer && !reviewOnly) stats.owner_transfer_posted += 1;
        // Post the accepted line to the internal Donna ledger so it becomes a
        // POSTED journal — the state the client-portal P&L / Balance Sheet read
        // (they read ledger_journals/ledger_lines, never the transactions
        // table). Without this the line was auto_reconciled in the reconcile
        // view but zero in the reports. Best-effort + isolated: a post failure
        // leaves the line accepted (still shown reconciled) and never aborts
        // the sweep. Only for Donna-ledger clients (see postToLedger above).
        if (postToLedger) {
          try {
            const result = await postLedgerFn({ firmId, clientId, transactionId: row.transaction_id, dryRun: false });
            if (result?.ledger_posting?.state === 'waiting_on_owner') {
              stats.waiting_on_owner = (stats.waiting_on_owner || 0) + 1;
              continue;
            }
            stats.ledger_posted += 1;
          } catch (postErr) {
            stats.ledger_post_errors += 1;
            console.warn('[coding_auto_post] accept posted but ledger post failed (line stays accepted)', {
              review_item_id: row?.review_item_id,
              transaction_id: row?.transaction_id,
              error_name: postErr?.name || 'Error',
              error_message: postErr?.message || ''
            });
          }
        }
        // Terminal A receipt + FYI cursor. The marker on the transaction
        // payload is BOTH the authority receipt (which flag stage/source
        // authorised the unattended equity posting) and the exactly-once FYI
        // gather key: the ask-batch drafter picks up owner_notified=false rows
        // into its "already posted" courtesy section and the single send
        // chokepoint flips them true. Best-effort: a marker failure never
        // undoes the accept — it is counted (fyi_mark_errors), never silent.
        if (isOwnerTransfer && !reviewOnly) {
          try {
            await markCodingFyiPendingFn({
              firmId,
              clientId,
              transactionId: row.transaction_id,
              receipt: {
                policy: 'owner_transfer_decide_and_notify',
                owner_notified: false,
                flag_key: CODING_OWNER_TRANSFER_POST_FLAG_KEY,
                flag_stage: ownerTransferFlagRow?.stage || null,
                flag_source: ownerTransferFlagRow?.source || null,
                proposed_account: suggestion.proposed_account || suggestion.account_name || null,
                posted_at: new Date().toISOString()
              }
            });
            stats.fyi_marked += 1;
          } catch (markErr) {
            stats.fyi_mark_errors += 1;
            console.warn('[coding_auto_post] owner-transfer posted but FYI marker failed (no FYI will send)', {
              review_item_id: row?.review_item_id,
              transaction_id: row?.transaction_id,
              error_name: markErr?.name || 'Error',
              error_message: markErr?.message || ''
            });
          }
        }
      } else if (verdict.action === 'owner_ask') {
        let reviewItemId = row.review_item_id || null;
        if (!reviewItemId) {
          reviewItemId = await ensureReviewItemFn({
            firmId,
            clientId,
            transactionId: row.transaction_id,
            source: 'coding_auto_post:owner_terminal',
            caseReason: 'coding_convergence_bare_line',
            caseIdSuffix: 'coding-convergence'
          });
          if (!reviewItemId) throw new Error('coding_auto_post_case_file_missing');
          stats.case_files_minted += 1;
        }
        // G-7P demotions ask about the TREATMENT (Finnish, the drift ask
        // family), not for a supporting document — the coding is confident;
        // the reverse-charge handling is what needs the owner's word.
        const isScopeDriftDemotion = verdict.reason === 'scope_drift_reverse_charge';
        // Every other flavor names the FACT it needs at mint time (RT-11 —
        // buildOwnerAsk): purpose (rule 2.6 owner-equity movement, rule 2.7
        // coding refusal, rule 1.7 cross-entity relation), account (which
        // balance a matched payment settles) or document (the plain evidence
        // ask). Only the document flavor consults the inventory — the fact
        // flavors deliberately chase no paper.
        const ownerAskFact = isScopeDriftDemotion ? null : ownerAskFactForReason(verdict.reason);
        const isPlainEvidenceAsk = ownerAskFact === 'document';
        let onFileCandidates = [];
        if (isPlainEvidenceAsk) {
          // A laneless suggested match IS the persisted answer to "which file?"
          // — the matcher named this document and simply lacked the confidence
          // to settle on it. Cite it directly (render the persisted verdict,
          // never re-infer); the inventory is the fallback where no match
          // exists, filtered to what is honest to name out loud.
          const matchedFilename = String(row?.suggested_doc_match?.filename || '').trim();
          if (row?.has_suggested_doc_match === true && matchedFilename) {
            onFileCandidates = [{
              document_id: String(row?.suggested_doc_match?.document_id || '').trim(),
              filename: matchedFilename
            }];
          } else {
            const inventory = await localEvidenceForSweep();
            const found = (inventory instanceof Map ? inventory.get(String(row.transaction_id)) : null) || [];
            onFileCandidates = citableEvidenceCandidates(found);
          }
        }
        const ownerAsk = isScopeDriftDemotion
          ? null
          : buildOwnerAsk({
            reason: verdict.reason,
            suggestion,
            line: askLine,
            crossEntity: row?.cross_entity || {},
            onFileCandidates
          });
        await createEvidenceRequestFn({
          firmId,
          clientId,
          transactionId: row.transaction_id,
          reviewItemId,
          question: isScopeDriftDemotion
            ? 'Tässä tapahtumassa näyttää olevan rakennusalan käännetty ALV. Kerro lyhyesti, mistä on kyse — tarkistan käsittelyn kanssasi ennen kirjaamista.'
            : ownerAsk.question,
          evidenceType: isScopeDriftDemotion ? 'scope_drift_review' : ownerAsk.evidence_type,
          // The stale-ask law's once-guard (reconciliationTwinAging.js): a
          // generic evidence ask records WHICH citable candidates it named, so
          // a later draft can tell "candidates changed since this ask spoke"
          // from "nothing new" without re-prompting the owner. Only the plain
          // evidence flavor — the fact/relationship/treatment asks chase no
          // document and are never superseded by evidence arriving.
          ...(isPlainEvidenceAsk
            ? {
                requestContext: {
                  citable_local_evidence: onFileCandidates.map((candidate) => ({
                    document_id: String(candidate?.document_id || candidate?.id || ''),
                    filename: String(candidate?.filename || '')
                  }))
                }
              }
            : {}),
          returnSnapshot: false,
          actorId: 'coding_auto_post'
        });
        stats.owner_asked += 1;
      } else {
        // A newer source-backed verdict may replace only this producer's own
        // never-delivered draft. Sent questions and human edits keep ownership.
        const refreshed = verdict.reason === 'evidence_request_pending' && suggestion.case_evidence_digest
          && createEvidenceRequestFn === createClientEvidenceRequestInDb
          ? await refreshCodingOwnerDraft({firmId, clientId, row, evaluateRow}) : false;
        stats.skipped += 1;
        bump(refreshed ? 'owner_draft_refreshed' : verdict.reason);
      }
    } catch (err) {
      stats.errors += 1;
      bump(`error:${verdict.action}`);
      // Non-fatal — isolate to this line and continue the sweep.
      console.warn('[coding_auto_post] line failed; skipped', {
        review_item_id: row?.review_item_id,
        action: verdict.action,
        error_name: err?.name || 'Error',
        error_message: err?.message || ''
      });
    }
  }

  return stats;
};

// Near-realtime trigger: run the exact same canary, pure eligibility gate, and
// named writers as the backstop sweep, but scoped to the transaction that just
// reached `review_state='suggested'`. This is deliberately a trigger wrapper,
// not a second posting backend; idempotency comes from the candidate query
// requiring the still-open suggested review row plus the ledger writer's
// deterministic transaction posting semantics.
export const runCodingAutoPostForTransaction = async ({
  firmId,
  clientId,
  transactionId,
  loadCandidatesFn = loadCodingAutoPostCandidatesForTransaction,
  ...rest
} = {}) => sweepCodingAutoPost({
  firmId,
  clientId,
  loadCandidatesFn: () => loadCandidatesFn({ firmId, clientId, transactionId }),
  ...rest
});
