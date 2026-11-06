// Donna — the single convergence projection for a reconcile-feed row.
//
// The two-terminal-states principle (CLAUDE.md, the FIRST principle) is
// non-negotiable: at rest, every reconcile row must be in EXACTLY one of
//   'auto_reconciled' — Donna finished the line itself (coding APPLIED /
//                       posted, an auto-explained immaterial line, or a
//                       settled match whose account is coded), or
//   'on_owner'        — an open clarification only the business OWNER can
//                       answer; the ball is with the client.
// Anything else is 'hanging' — a VIOLATION (firm-side limbo): a SUGGESTED
// coding waiting on a firm click, a reviewer 'held' line, a material match
// held by the materiality ceiling with no covering grant
// (matched_pending_authority), a matched-but-uncoded row (Leak C), a
// bank-line disposition that opened a FIRM gap (needs_human / chase_receipt)
// or a chase_evidence whose owner ask has not landed yet, a needs_review with
// no owner ask, an auto-match whose CASCADE never landed (M1.3 — see
// CASCADE_APPLIED below), or a consolidated statement's listed settlement row
// that no bank line settles once its paid date has passed (RT-21d —
// `settlement_row:<n>:unsettled`; see classifySettlementRows).
//
// Retained processing scope (native chart books) rides the SAME derivation
// through its `processingScope` input: a verified review-only book can never
// read auto_reconciled (`processing_review_only`), and a book whose retained
// native marker cannot be verified (a partial/corrupt marker — the admission
// refusal `native_chart_lineage_invalid`) hangs on EVERY row under
// `native_chart_lineage_invalid`. That failure is isolated to its client: the
// firm-wide reads and the settle sweep project it, they never throw on it.
//
// WHY THIS MODULE EXISTS. Today the rule is enforced nowhere as a single
// invariant: coding, matching, authorization, and ask each render their own
// chip onto a row (see buildLiveRow), and a row can sit in a combination
// that is neither terminal — the "leaks" the firm sees in Reconcile. This is
// the ONE place the policy lives, so the rule becomes MACHINE-CHECKED: the
// convergence invariant test (reconcileConvergenceState.test.js) pins every
// modeled state to its terminal and FAILS CI if a known-leak state is ever
// silently reclassified as terminal. It is the stricter definition CLAUDE.md
// asks for ("lines_left_hanging ... still count a firm-side verdict as
// terminal — that is a known gap to close").
//
// The PROJECTION half (everything above the "Persisted convergence state"
// section) is pure, like reconciliationTerminalState.js and
// bankLineDispositionShape.js: it PROJECTS persisted state — never calls an
// LLM, never re-infers. Render the persisted verdict, not the legacy layer
// (CLAUDE.md).
//
// RT-13 (docs/plan-2026-09-01-runtime-refactor-slices.md; audit F-14 + the
// writer-side half of F-08): the verdict is now PERSISTED — migration 137
// adds `convergence_state` / `convergence_reason` / `convergence_as_of` to
// transactions and documents. `deriveConvergenceState` stays the ONE
// derivation; the persistence section at the bottom of this file gathers a
// row's inputs, runs that same derivation, and writes the columns inside the
// writer's own transaction (`applyConvergenceState`). The hand-mirrored SQL
// hanging count in parseDocumentsDb.js is DELETED — the reconcile stats read
// the column — so every "keep in LOCK-STEP" note below now names the
// persisted column, not a second implementation of the law.
//
// POLICY ANCHOR (2026-06-24 decision, E2 SHIPPED): a material, model-confident
// match with no standing grant AUTO-RECONCILES + FYIs the owner — it is NOT a
// firm-click state (the firm authorization ask is RETIRED). E2 ships that path
// (applyMaterialAutoFyi in reconciliationLlmCore.js) behind a DEDICATED
// fail-closed canary: a covered client's held match flips to band 'auto_matched',
// cascades to reconciliation_status 'explained', and is read as 'auto_reconciled'
// below. So matchHeldPendingAuthority is only ever true for a line the canary did
// NOT cover — which still counts 'hanging' here (SURFACED, never laundered behind
// a firm-ask), exactly as the strict metric requires.

import { assertVerdictTransactionBudgetActive, clearVerdictTransactionBudget } from './executionBudget.js';
import { bindConvergenceConnection, unbindConvergenceConnection, withConvergenceTransaction, isConvergencePool, convergenceConnectionRecord } from './convergenceConnection.js';

import {
  RECONCILED_CODING_STATES,
  HANGING_CODING_STATES,
  OWNER_CODING_STATE,
  codingStateReasonKey,
  codingStateFromLegacy,
  normalizeCodingState
} from './codingState.js';

export const CONVERGENCE_STATES = Object.freeze(['auto_reconciled', 'on_owner', 'hanging']);
export const CONVERGENCE_TERMINALS = Object.freeze(['auto_reconciled', 'on_owner']);

// ── Ask AUDIENCE (migration 122 — the two-terminal-states GENERALIZATION,
//    CLAUDE.md 2026-08-27; design-donna-universal-mentions §4) ──────────────
// Terminal 2 is "on a NAMED CUSTOMER-SIDE HUMAN via the ask primitive": a
// CLIENT ask (every pre-122 row) or a SEAT ask both rest on_owner — the
// bucket name is retained for API stability; the REASON attributes which
// human ('open_owner_ask' vs 'open_seat_ask') so the owner-interruption
// metric stays undiluted (prompts_per_100 counts owner-facing rows only;
// seat-directed volume reports as colleague_asks_per_100). An AGENT ask is
// NEVER terminal: Donna owes the answer, so an open agent ask projects
// hanging ('agent_ask_unanswered') AHEAD of any human-ask terminal — a human
// also being asked must not launder Donna-owed work as "at rest" (the same
// ordering rationale as the cascade check below).
//
// The audience reader here is deliberately inlined (this module stays
// dependency-free, like reconciliationTerminalState.js); askAudience.js is
// the writers' law and the convergence invariant test pins the two agree.
//
// (RT-13: the SQL hanging count that once mirrored this audience rule is
// gone; the reconcile stats count the persisted column this projection
// writes, so there is exactly one place the audience law lives.)
const ASK_AUDIENCES_LOCKSTEP = Object.freeze(['client', 'seat', 'agent']);
const askAudienceOf = (row = {}) => {
  const a = norm(row?.audience);
  return ASK_AUDIENCES_LOCKSTEP.includes(a) ? a : 'client';
};
export const __askAudiencesLockstep = () => [...ASK_AUDIENCES_LOCKSTEP];

// RT-16 — the ONE coding state (`transactions.coding_state`, migration 138;
// the machine is codingState.js). The three legacy vocabularies
// (transaction_review_queue.review_state, payload.review_state,
// payload.ai_suggestion_status) are gone. `applied` / `posted` / `synced` /
// `closed` settle the coding axis; `asked` is the owner-facing state (an
// owner ask is out — see closeDisposition.js); `held` is a firm-side
// reviewer hold (NOT terminal); `proposed` is the firm-side limbo the first
// principle forbids; NULL means nothing was proposed, decided or asked, so
// the line reads off its other axes. The sets are codingState.js's — one
// partition, pinned by the invariant test.
const RECONCILED_CODING = new Set(RECONCILED_CODING_STATES);
const HANGING_CODING = new Set(HANGING_CODING_STATES);

// transactions.reconciliation_status values that mean the line is settled in
// the books (mirrors bankLineAutoExplain RESOLVED_TX_STATUSES).
const SETTLED_RECON_STATUSES = new Set(['reconciled', 'posted', 'auto_reconciled']);

// bank_line_disposition verdicts (reconciliation_evaluations.payload->>'disposition',
// bankLineDispositionLlm.js). 'auto_explain' is the ONLY one that SETTLES the line
// (immaterial / recurring, no document, no human) → auto_reconciled. It is the sole
// disposition that terminalizes (and now ALSO stamps reconciliation_status='explained',
// the 2026-06-24 write-side settling stamp, so it is terminal off the bare tx too), so
// it is load-bearing here. Every OTHER disposition is non-terminal: 'needs_human' /
// 'chase_receipt' / 'chase_evidence' open an OWNER-owned gap (ownerType 'client' since
// the write-side reroute — evaluateReconciliationGoal), but a case BLOCKER is not an
// owner ASK, so the line is on_owner only once the ask pipeline lands an actual
// client_evidence_request (caught earlier by hasOpenOwnerAsk / review_state); until then
// it is hanging — surfaced, never laundered. (RT-13: the SQL hanging count that
// mirrored this policy — and diverged from it by the cascade case, M1.3 —
// is deleted; the reconcile stats read the persisted column, so the cascade
// check below now reaches the metric too.)
//
// RT-10 gave a needs_human verdict a LANE (`payload.lane.kind`: owner_ask /
// owner_ask_exhausted / machine_rerun / machine_rerun_exhausted). The lane
// never changes the STATE — a scheduled re-run is Donna's work in flight, an
// exhausted bound is a surfaced violation, and only a LANDED owner ask is
// terminal 2 — but it rides the reason key (`disposition:needs_human:<lane>`)
// so hanging_by_reason tells a bounded re-run from a resting limbo, and the
// period overview can render the re-run as processing rather than stalled.
// RT-26 (2026-09-09, deliberate — this set changes only in a named slice):
// 'statutory_payment' settles like 'auto_explain'. Its evidence is the filing
// (RT-24's law, spoken by the disposition lane); the coder names the liability
// and the post follows. The status stamp normally lands 'explained' (step 5);
// this is the verdict-only read when that best-effort stamp did not.
const SETTLING_DISPOSITIONS = new Set(['auto_explain', 'statutory_payment']);

// M1.3's last 10% (docs/donna-kernel-audit/cascade-convergence-design.md).
// #1131 made an auto-match's cascade outcome PERSISTED on
// `reconciliation_matches.payload.cascade.state` — 'applied' | 'failed' |
// 'exhausted'. A cascade that did not land leaves the row at status
// 'auto_matched' while the transaction reads unexplained and the document reads
// unpaid: not auto-reconciled, and not on the owner. That is a two-terminal-
// states violation, and until now it was receipted in the audit log but
// INVISIBLE to the one metric built to make firm-side limbo visible.
//
// It is NOT an owner ask. A cascade that throws is a SYSTEM failure, not a
// business fact only the owner can know; asking them produces a question they
// cannot discharge — the violation wearing the right label, and worse than
// counting it, because it would look terminal.
//
// BOTH non-applied states count, not just 'exhausted'. Verified in the tree
// (design note §1): the heal that increments the attempt count hangs off the
// blocked-upsert path, and every family orchestrator suppresses an already-
// auto_matched pair BEFORE the model is called, so that path is unreachable
// outside a race. A failed cascade therefore stops at attempts=1 permanently and
// 'exhausted' never occurs. Classifying only 'exhausted' would surface nothing.
// Distinct reason keys so hanging_by_reason tells them apart — and so the day
// the heal gets its own clock, the metric shows the shift instead of hiding it.
const CASCADE_APPLIED = 'applied';

const norm = (v) => (v == null ? '' : String(v).trim().toLowerCase());

// A coded account that is absent / 'Suspense' / 'unknown' is NOT coded — a
// matched line still parked at Suspense is the tri-state leak (matched but
// uncoded), and must never read as auto_reconciled on the match alone.
const isCoded = (codedAccount) => {
  const a = norm(codedAccount);
  return a !== '' && a !== 'suspense' && a !== 'unknown';
};

const result = (state, reason) => ({ state, reason });

// Project a reconcile row's full state onto exactly one convergence state.
// Inputs are the canonical persisted fields a feed row already carries; all
// are optional so single-axis callers (e.g. a queue-less doc-matched line
// with only reconciliation_status) work unchanged.
export const deriveConvergenceState = ({
  processingScope = null,
  // RT-16 — the persisted coding state (codingState.js machine). An
  // unmodeled value hangs under its own key; null reads off the other axes.
  codingState = null,
  reconciliationStatus = null,
  codedAccount = null,
  // A transaction still awaiting its first coding is work even if its bank
  // descriptor was explained. Document-only assessments do not set this axis.
  codingPending = false,
  // A material match the strong model authorized on the A–D gates but the
  // materiality ceiling (Gate E) holds, with NO covering delegated-authority
  // grant — the canonical #5 violation ("matched" yet resting on a firm
  // CONFIRM/DECLINE click).
  matchHeldPendingAuthority = false,
  hasCoveringAuthorityGrant = false,
  // RT-23 — the ledger post path REFUSED this applied coding (the auto-post
  // sweep's `payload.ledger_post_refusal`, the refusal's error code). An
  // applied coding whose post was refused is Donna's to resolve, not a
  // terminal: it projects `hanging / ledger_post_refused:<code>` until the
  // line posts (the commit clears the stamp) or is re-decided.
  ledgerPostRefused = null,
  codingCorrectionRequired = null,
  // An open owner clarification (client_evidence_request status draft/open,
  // audience 'client') exists for the line — the ball is genuinely with the
  // client.
  hasOpenOwnerAsk = false,
  // F-32 — a client ask exists (draft/open) that NOBODY can receive: never sent
  // and no active owner/seat assignment to receive it. The ball is not with
  // the client (no human was actually asked), so it is never terminal 2.
  hasUndeliverableOwnerAsk = false,
  // F8 — a clarification the owner already ANSWERED (status 'replied') that
  // the firm/system has not finished processing. The owner did their part;
  // what remains is Donna's (re-code / re-disposition) or a human's — so it
  // counts HANGING ('answered, processing'), never on_owner. The metric must
  // not flatter the wrong party.
  hasAnsweredOwnerAsk = false,
  // 122 — the seat audience: an open ask on a customer-side HUMAN principal
  // (a colleague seat). Terminal 2 under the generalized principle, with its
  // own reason so the owner-interruption metric stays honest.
  hasOpenSeatAsk = false,
  // A seat's reply awaiting processing — same F8 shape, own reason.
  hasAnsweredSeatAsk = false,
  // 122 — the agent audience: an open ask ON an agent. NEVER terminal.
  hasOpenAgentAsk = false,
  // The persisted bank_line_disposition verdict for a bare unmatched line
  // (reconciliation_evaluations.payload->>'disposition'), when one exists.
  disposition = null,
  // RT-10 — the lane that verdict took (payload.lane.kind), when it has one.
  // Reason-key only; see SETTLING_DISPOSITIONS.
  dispositionLane = null,
  // The persisted cascade outcome of this line's auto-match
  // (reconciliation_matches.payload.cascade.state), when one exists. null /
  // absent ⇒ no verdict to render ⇒ unchanged behaviour: every row written
  // before #1131 carries no `cascade` key, and absence is not a verdict.
  cascadeState = null,
} = {}) => {
  // A real owner ask/failure/held proposal retains precedence. A terminal
  // accounting verdict is unavailable under the verified retained scope.
  // An UNVERIFIABLE native lineage (scope reason 'native_chart_lineage_invalid',
  // the admission refusal's own key) is stricter: nothing on that book can rest
  // terminal — not even an owner ask, which cannot repair Donna's retained
  // chart — so every row hangs under the lineage reason until it is repaired.
  const result = (state, reason) => {
    if (!processingScope?.enforced) return { state, reason };
    if (processingScope.reason_code === 'native_chart_lineage_invalid') {
      return { state: 'hanging', reason: 'native_chart_lineage_invalid' };
    }
    // Any other typed native refusal (F-22): same law, the refusal's own reason key.
    if (processingScope.native_refusal === true) return { state: 'hanging', reason: processingScope.reason_code };
    return state === 'auto_reconciled' ? { state: 'hanging', reason: 'processing_review_only' } : { state, reason };
  };
  const cs = norm(codingState);
  const recon = norm(reconciliationStatus);
  const disp = norm(disposition);
  const lane = norm(dispositionLane);
  const cascade = norm(cascadeState);

  // 0. A recorded cascade that never landed. Checked FIRST — ahead of every
  //    other axis — because a cascade can fail HALF-WAY: cascadeAutoMatch may
  //    set the transaction to 'explained' and applyDocumentPaymentStatusAfterMatch
  //    then throw, leaving the tx reading terminal while the document still reads
  //    unpaid. Checked any later, such a row reads auto_reconciled off
  //    reconciliation_status at step 5 and the violation is masked by the very
  //    split it describes. First is the only position that survives a partial
  //    cascade — or an open owner ask, which must not launder a system failure
  //    as "with the client".
  if (cascade && cascade !== CASCADE_APPLIED) {
    return result('hanging', `cascade_${cascade}`);
  }

  // 0b. An open AGENT ask (122): Donna owes this answer, so the line is not
  //     at rest — whatever human asks are also open. Checked ahead of the
  //     human-ask terminals for the same reason the cascade is: a genuine
  //     owner/seat ask must not launder Donna-owed work as "with a human".
  if (hasOpenAgentAsk) {
    return result('hanging', 'agent_ask_unanswered');
  }

  // 1. Matched-pending-authority with no covering grant: a confident match
  //    parked on a firm click. Hanging until it auto-reconciles (a grant, or
  //    the auto+FYI path) or converts to an owner ask. Checked first because
  //    "matched" otherwise reads as settled.
  if (matchHeldPendingAuthority && !hasCoveringAuthorityGrant) {
    return result('hanging', 'matched_pending_authority_no_grant');
  }

  // 2. On a named customer-side human (terminal 2): an open clarification
  //    only that human can answer outranks any in-progress firm-side coding.
  //    The client ask keeps its reason ('open_owner_ask'); a seat ask lands
  //    the SAME terminal under 'open_seat_ask' (122 — the generalization),
  //    which the metrics count as a colleague ask, never an owner prompt.
  //    F8: the owner-facing coding state ('asked') stops counting on_owner
  //    once the owner has REPLIED — the post-reply 'asked' the recode/answer
  //    leg left behind is firm-side work.
  if (hasOpenOwnerAsk || (cs === OWNER_CODING_STATE && !hasAnsweredOwnerAsk && !hasUndeliverableOwnerAsk)) {
    return result('on_owner', hasOpenOwnerAsk ? 'open_owner_ask' : codingStateReasonKey(cs));
  }
  if (hasOpenSeatAsk) {
    return result('on_owner', 'open_seat_ask');
  }
  //     F-32: an owner ask nobody can receive rests on Donna (or nobody) — the
  //     forbidden state — so it is HANGING under its own reason until it is
  //     sent or an owner/seat exists to receive it. The audience stays in the
  //     key ('owner_' = client audience), so prompts_per_100 never counts it.
  if (hasUndeliverableOwnerAsk && !hasAnsweredOwnerAsk) {
    return result('hanging', 'owner_ask_undeliverable');
  }

  // 2b. Answered, processing (F8): the owner replied and nothing has driven
  //     the reply to a terminal yet (the answer leg failed, is flag-gated
  //     off, or the request flip was missed). Firm/system-side work —
  //     HANGING, surfaced under its own reason, checked before the terminal
  //     reads because an unresolved replied request means the processing
  //     that should have resolved it did not complete. A seat's reply rides
  //     the same shape under its own reason (122).
  if (hasAnsweredOwnerAsk) {
    return result('hanging', 'owner_answered_processing');
  }
  if (hasAnsweredSeatAsk) {
    return result('hanging', 'seat_answered_processing');
  }

  if (codingCorrectionRequired?.status === 'pending') {
    const recovery = codingCorrectionRequired.recovery;
    if (recovery?.code && ['blocked', 'failed'].includes(recovery.state)) {
      return result('hanging', `posted_evidence_correction_${recovery.state}:${recovery.code}`);
    }
    return result('hanging', 'posted_evidence_reconsideration_required');
  }

  // 3a. RT-23 — an APPLIED coding the ledger refused to post is not settled:
  //     the journal is the receipt of terminal 1, and there is none. Hanging
  //     under the refusal's own code so the repair inbox can name the cause.
  if (cs === 'applied' && ledgerPostRefused) {
    return result('hanging', `ledger_post_refused:${ledgerPostRefused}`);
  }

  // 3. Auto-reconciled (terminal 1) via the coding lifecycle: the coding was
  //    applied / posted / mirrored / closed and the row is settled.
  if (RECONCILED_CODING.has(cs)) {
    return result('auto_reconciled', codingStateReasonKey(cs));
  }

  // 4. A live PROPOSED coding (or a reviewer 'held' line) is firm-side limbo
  //    — even when a match settled the bank line, the account coding is not
  //    decided. This is the SUGGESTED leak (Leak B); it stays hanging
  //    regardless of reconciliation_status.
  if (HANGING_CODING.has(cs)) {
    return result('hanging', codingStateReasonKey(cs));
  }
  // 4b. A coding value the machine does not model (unreachable from the
  //     column — migration 138's CHECK — but an in-memory caller could pass a
  //     legacy label). Surface it under its own key BEFORE the settled-match
  //     axis can launder it: fail toward the leak, never toward terminal.
  if (cs) {
    return result('hanging', `coding_state:${cs}`);
  }

  if (codingPending && SETTLED_RECON_STATUSES.has(recon)) {
    return result('hanging', 'matched_but_uncoded');
  }
  if (codingPending && (recon === 'explained' || SETTLING_DISPOSITIONS.has(disp))) {
    return result('hanging', 'explained_but_uncoded');
  }

  // 5. Auto-reconciled via the reconciliation verdict, for lines that never
  //    got a queue row (their terminal lives on the transaction):
  //    - 'explained' is terminal on its own (auto-explained / immaterial);
  //    - a settled match is terminal ONLY when the account is also coded — a
  //      match that left the account at Suspense is the matched-but-uncoded
  //      leak (Leak C), hanging.
  if (recon === 'explained') {
    return result('auto_reconciled', 'reconciliation_status:explained');
  }
  if (SETTLED_RECON_STATUSES.has(recon)) {
    return isCoded(codedAccount)
      ? result('auto_reconciled', `reconciliation_status:${recon}`)
      : result('hanging', 'matched_but_uncoded');
  }

  // 6. A bare unmatched line's persisted bank-line disposition (the verdict
  //    never sets reconciliation_status, so it only surfaces here): only
  //    'auto_explain' settles it; 'needs_human'/'chase_receipt' opened a FIRM
  //    gap and 'chase_evidence' is an owner ask not yet landed (an open one
  //    already routed to on_owner above) — all hanging until they reach a
  //    terminal. The persisted column carries this verdict to the metric.
  if (disp) {
    return SETTLING_DISPOSITIONS.has(disp)
      ? result('auto_reconciled', `disposition:${disp}`)
      : result('hanging', lane ? `disposition:${disp}:${lane}` : `disposition:${disp}`);
  }

  // 7. Everything else (needs_review with no owner ask, unknown / unmodeled)
  //    is a firm-side limbo. Fail toward surfacing the leak — never silently
  //    terminal.
  return result('hanging', recon ? `reconciliation_status:${recon}` : 'unclassified');
};

export const isConvergenceTerminal = (stateOrResult) => {
  const s = typeof stateOrResult === 'string' ? stateOrResult : stateOrResult?.state;
  return CONVERGENCE_TERMINALS.includes(s);
};

// Project a row to {state, reason}, tolerating the three input shapes the
// metric helpers accept: a bare state string (no reason — it was never
// projected with one), an already-projected {state, reason} result, or a raw
// row input (re-projected here). A bare string yields a null reason → bucketed
// 'unspecified' downstream (an honest "can't attribute", never dropped).
const stateAndReasonOf = (r) => {
  if (typeof r === 'string') return { state: r, reason: null };
  if (r && typeof r.state === 'string') return { state: r.state, reason: r.reason ?? null };
  const p = deriveConvergenceState(r);
  return { state: p.state, reason: p.reason };
};

// Slice J — the convergence metrics backend. A PURE computation over the SAME
// projection summarizeConvergence partitions; it adds the actionable breakdowns
// the two-terminal-states metric needs, no DB / no LLM:
//   - hanging_by_reason — WHY each hanging line is a violation (keyed by the
//     projection's reason; bounded small enums), the breakdown the invariant
//     must drive to zero acts on;
//   - prompts_per_100 — owner-facing asks per 100 reconcile lines: the
//     ESCALATION RATE the DFY play lives or dies on (CLAUDE.md GOAL — "the ONE
//     metric that decides if it's real"). on_owner is the prompt bucket; lower
//     means Donna finished more itself;
//   - authority_misses — the #5 delegated-authority violation count: material
//     matches resting on a firm click (matched_pending_authority_no_grant),
//     surfaced distinctly because it is the doctrine's load-bearing leak;
//   - hanging_per_100 — the violation rate, the convergence target.
// Rates are per-100 with one decimal; an empty set is 0 (never NaN/divide-by-0).
// Shared shape + rate math for every metrics producer, so convergenceMetrics
// (count rows) and mergeConvergenceMetrics (sum sub-metrics) agree exactly.
//
// 122 — the on_owner bucket now holds TWO human audiences, so the
// owner-interruption decider metric must not read the bucket raw:
// prompts_per_100 counts only OWNER-facing rows (everything on_owner except
// reason 'open_seat_ask' — a bare/unattributed on_owner row keeps counting as
// an owner prompt, the historical reading); seat-directed volume reports
// separately as colleague_asks / colleague_asks_per_100. on_owner_by_reason
// is the attribution breakdown, the sibling of hanging_by_reason.
const finalizeConvergenceMetrics = (counts, hanging_by_reason, on_owner_by_reason = {}) => {
  const total = counts.auto_reconciled + counts.on_owner + counts.hanging;
  const per100 = (n) => (total === 0 ? 0 : Math.round((n / total) * 1000) / 10);
  const colleague_asks = on_owner_by_reason.open_seat_ask || 0;
  return {
    ...counts,
    total,
    converged: counts.hanging === 0,
    hanging_by_reason,
    on_owner_by_reason,
    authority_misses: hanging_by_reason.matched_pending_authority_no_grant || 0,
    colleague_asks,
    prompts_per_100: per100(counts.on_owner - colleague_asks),
    colleague_asks_per_100: per100(colleague_asks),
    hanging_per_100: per100(counts.hanging),
  };
};

export const convergenceMetrics = (rows = []) => {
  const counts = { auto_reconciled: 0, on_owner: 0, hanging: 0 };
  const hanging_by_reason = {};
  const on_owner_by_reason = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    const { state, reason } = stateAndReasonOf(r);
    if (counts[state] == null) continue;
    counts[state] += 1;
    if (state === 'hanging') {
      const key = reason || 'unspecified';
      hanging_by_reason[key] = (hanging_by_reason[key] || 0) + 1;
    }
    if (state === 'on_owner') {
      const key = reason || 'unspecified';
      on_owner_by_reason[key] = (on_owner_by_reason[key] || 0) + 1;
    }
  }
  return finalizeConvergenceMetrics(counts, hanging_by_reason, on_owner_by_reason);
};

// Merge already-computed convergenceMetrics objects into ONE roll-up by summing
// the (exact) count buckets + hanging_by_reason, then recomputing the rates. Used
// to re-derive `overall` after by_client has been SCOPED to a principal's allowed
// clients — so a scoped collaborator's roll-up never reflects a book they can't
// see (the client-scope substrate, CLAUDE.md GOAL). Lossless: it sums counts, not
// rates.
export const mergeConvergenceMetrics = (metricsList = []) => {
  const counts = { auto_reconciled: 0, on_owner: 0, hanging: 0 };
  const hanging_by_reason = {};
  const on_owner_by_reason = {};
  for (const m of Array.isArray(metricsList) ? metricsList : []) {
    if (!m) continue;
    counts.auto_reconciled += m.auto_reconciled || 0;
    counts.on_owner += m.on_owner || 0;
    counts.hanging += m.hanging || 0;
    for (const [k, v] of Object.entries(m.hanging_by_reason || {})) {
      hanging_by_reason[k] = (hanging_by_reason[k] || 0) + (v || 0);
    }
    for (const [k, v] of Object.entries(m.on_owner_by_reason || {})) {
      on_owner_by_reason[k] = (on_owner_by_reason[k] || 0) + (v || 0);
    }
  }
  return finalizeConvergenceMetrics(counts, hanging_by_reason, on_owner_by_reason);
};

// Partition projected rows into the three convergence buckets. `hanging` is the
// violation bucket the invariant must drive to zero. Accepts bare state strings,
// projection results, or raw row inputs (re-projected). The stable summary shape
// many callers depend on — a thin projection of convergenceMetrics (the Slice-J
// superset) so there is ONE counting path.
export const summarizeConvergence = (rows = []) => {
  const { auto_reconciled, on_owner, hanging, total, converged } = convergenceMetrics(rows);
  return { auto_reconciled, on_owner, hanging, total, converged };
};

// ── Feed-row adapters — read a snapshot row into the projection ─────────────
// The feed (firmDb.js snapshot assembly) MUST classify a reconcile row through
// this SAME module, so the Reconcile UI filters tab membership on the persisted
// convergence verdict — never re-deriving it from the legacy review_state sets
// (the split-brain the first principle forbids). These map the snapshot shapes
// onto deriveConvergenceState: a transaction_review_queue ITEM joined to its
// transaction, and a bare transaction. Pure; tolerate partial rows.

// RT-16 — the coding state, off the TRANSACTION's column first (the DTO
// carries `coding_state`), then the review item's copy of it, then — for an
// in-memory consumer that only carries the projected legacy label
// (`review_state`, the DTO contract) or an applied receipt
// (`ai_suggestion_status`) — the ONE legacy mapping codingState.js keeps for
// the backfill. The label is a projection of the column, so mapping it back
// is lossless; it never resurrects a second copy of the state.
const codingStateOf = (item = {}, tx = {}) => {
  const payload = item.payload && typeof item.payload === 'object' ? item.payload : {};
  const column = normalizeCodingState(tx.coding_state) || normalizeCodingState(item.coding_state);
  if (column) return column;
  return codingStateFromLegacy({
    payloadReviewState: tx.review_state ?? tx.payload?.review_state ?? item.review_state ?? payload.review_state ?? null,
    aiSuggestionStatus: tx.ai_suggestion_status ?? tx.payload?.ai_suggestion_status ?? payload.ai_suggestion_status ?? item.ai_suggestion_status ?? null,
    hasProposal: true
  });
};

// The POSTED account that decides the matched-but-uncoded (Leak C) check.
const codedAccountOf = (payload = {}, tx = {}) =>
  tx.account_name || tx.account_code || payload.account_name || payload.account_code || null;

// RT-10 — the lane a persisted needs_human verdict took, off the summarized
// disposition (`lane` rides bankLineDispositionShape's map) or the raw
// verdict payload holder (`lane.kind`). null when the verdict has none.
const dispositionLaneOf = (holder) => {
  const lane = holder && typeof holder === 'object' ? holder.lane : null;
  if (!lane) return null;
  if (typeof lane === 'string') return norm(lane) || null;
  return typeof lane === 'object' && lane.kind ? norm(lane.kind) || null : null;
};

// The client_evidence_requests.status values that mean an owner ask is still
// OUTSTANDING — the line is on_owner (the ball is with the client). 'resolved'
// / 'cancelled' are closed and do NOT keep a line on the owner. F8: 'replied'
// is NOT on_owner — the owner did their part; an unprocessed reply is
// firm/system-side work, bucketed 'owner_answered_processing' (hanging) via
// ANSWERED_PROCESSING_ASK_STATUSES below. (RT-13: the SQL awaiting-ask clause
// that mirrored this set is gone; the persisted column is written from this
// module, so the feed verdict and the reconcile count cannot disagree on
// which lines are with the owner. 'draft' remains counted on_owner for now —
// a draft nobody saw is F8's named follow-up, not this slice.)
export const OPEN_OWNER_ASK_STATUSES = Object.freeze(['draft', 'open']);

// The CLOSED statuses — documentation of the complement, not a third bucket:
// a resolved / cancelled ask, and (RT-11 D4) an ask Donna RETRACTED because
// she auto-explained the line herself, no longer holds the line on the owner
// and is not answered-processing either. The line reads off its own axes.
export const CLOSED_ASK_STATUSES = Object.freeze(['resolved', 'cancelled', 'retracted']);

// F8 — the answered-but-unprocessed statuses: the owner replied and the
// firm/system owes the processing (re-code / re-disposition / request flip).
export const ANSWERED_PROCESSING_ASK_STATUSES = Object.freeze(['replied']);

// True iff any of a line's CLIENT-audience client_evidence_requests is still
// outstanding (122: a seat/agent ask must not read "the ball is with the
// client"). Pure row reader; tolerates raw DB rows or mapped payloads (both
// carry `status`; a row without `audience` is a pre-122 client ask).
export const hasOpenOwnerAskInRequests = (requests = []) =>
  (Array.isArray(requests) ? requests : []).some((r) =>
    askAudienceOf(r) === 'client' && OPEN_OWNER_ASK_STATUSES.includes(norm(r?.status))
      && ownerAskDeliverable(r));

// True iff any of a line's CLIENT-audience client_evidence_requests is
// answered-awaiting-processing (F8's 'answered, processing' bucket).
export const hasAnsweredOwnerAskInRequests = (requests = []) =>
  (Array.isArray(requests) ? requests : []).some((r) =>
    askAudienceOf(r) === 'client' && ANSWERED_PROCESSING_ASK_STATUSES.includes(norm(r?.status)));

// 122 — the seat/agent siblings, same shapes, same statuses.
export const hasOpenSeatAskInRequests = (requests = []) =>
  (Array.isArray(requests) ? requests : []).some((r) =>
    askAudienceOf(r) === 'seat' && OPEN_OWNER_ASK_STATUSES.includes(norm(r?.status)));

export const hasAnsweredSeatAskInRequests = (requests = []) =>
  (Array.isArray(requests) ? requests : []).some((r) =>
    askAudienceOf(r) === 'seat' && ANSWERED_PROCESSING_ASK_STATUSES.includes(norm(r?.status)));

// An agent ask is hanging at rest whichever side last spoke, so open covers
// draft/open/replied here (mirrors collectOwnerAskSets' agent routing).
export const hasOpenAgentAskInRequests = (requests = []) =>
  (Array.isArray(requests) ? requests : []).some((r) =>
    askAudienceOf(r) === 'agent'
      && (OPEN_OWNER_ASK_STATUSES.includes(norm(r?.status))
        || ANSWERED_PROCESSING_ASK_STATUSES.includes(norm(r?.status))));

// F-32 — is a client-audience ask actually with a human? A DRAFT nobody sent
// (no sent stamp — migration 147 refuses a stamp without a channel receipt),
// on a client whose sends are all held by hosted send containment
// (internalPilotAccess.js: INTERNAL_PILOT_SEND_DISABLED) and with no active
// owner/seat assignment to receive it, is terminal 2 resting on nobody — the
// F8 "draft nobody saw" follow-up. `undeliverable` is gathered in SQL
// (ASK_DELIVERY_SQL); a row without it (a mapped payload, a caller that never
// gathered it) is not judged — absence is not a verdict, and the persisted-
// column gather always supplies it. Ordinary clients (not send-contained) keep
// exactly the old reading: a draft awaiting the send producer is with the owner.
export const ownerAskDeliverable = (row = {}) => row?.undeliverable !== true;

// The four owner-ask id sets every feed projection keys off, built from raw
// client_evidence_requests rows in ONE pass. Factored out of
// getFirmSnapshotFromDb so its second consumer (the feed chat's context
// gather) builds the SAME sets from the SAME helper — the chat's convergence
// verdicts stay lock-step with the rendered feed by construction, not by
// parallel maintenance. Semantics preserved verbatim from the snapshot:
//   - open (OPEN_OWNER_ASK_STATUSES) vs answered-processing
//     (ANSWERED_PROCESSING_ASK_STATUSES, F8) route to separate sets;
//   - a consolidated statement request anchors EVERY line it references
//     (request_payload.anchor_transaction_ids), not just the minting row —
//     the persisted-column gather anchors the same way (RT-13);
//   - a doc-anchored ask (request_payload.document_id, transaction_id null —
//     the doc-first terminal drain) lands in the doc sets.
// Pure; tolerates raw DB rows or mapped payloads (both carry status /
// transaction_id / request_payload).
// 122 — the sets are AUDIENCE-ROUTED: the four original sets keep meaning
// CLIENT asks exactly (every pre-122 row has no audience column and buckets
// 'client', so existing callers are byte-stable); seat asks fill their own
// open/answered sets (terminal 2, reason 'open_seat_ask'); agent asks fill
// ONE open set covering draft/open/replied — an agent ask is hanging at rest
// whichever side last spoke, so the open/answered split buys nothing there.
// A caller that does not thread the new sets leaves seat/agent asks OUT of
// its projection inputs, which fails toward 'hanging' — surfaced, never
// silently terminal.
export const collectOwnerAskSets = (evidenceRequestRows = []) => {
  const openOwnerAskTxIds = new Set();
  const openOwnerAskDocIds = new Set();
  const undeliverableOwnerAskTxIds = new Set();
  const undeliverableOwnerAskDocIds = new Set();
  const answeredOwnerAskTxIds = new Set();
  const answeredOwnerAskDocIds = new Set();
  const openSeatAskTxIds = new Set();
  const openSeatAskDocIds = new Set();
  const answeredSeatAskTxIds = new Set();
  const answeredSeatAskDocIds = new Set();
  const openAgentAskTxIds = new Set();
  const openAgentAskDocIds = new Set();
  for (const row of Array.isArray(evidenceRequestRows) ? evidenceRequestRows : []) {
    const status = norm(row?.status);
    const open = OPEN_OWNER_ASK_STATUSES.includes(status);
    const answeredProcessing = ANSWERED_PROCESSING_ASK_STATUSES.includes(status);
    if (!open && !answeredProcessing) continue;
    const audience = askAudienceOf(row);
    let txIds;
    let docIds;
    if (audience === 'agent') {
      txIds = openAgentAskTxIds;
      docIds = openAgentAskDocIds;
    } else if (audience === 'seat') {
      txIds = open ? openSeatAskTxIds : answeredSeatAskTxIds;
      docIds = open ? openSeatAskDocIds : answeredSeatAskDocIds;
    } else if (open && !ownerAskDeliverable(row)) {
      txIds = undeliverableOwnerAskTxIds;
      docIds = undeliverableOwnerAskDocIds;
    } else {
      txIds = open ? openOwnerAskTxIds : answeredOwnerAskTxIds;
      docIds = open ? openOwnerAskDocIds : answeredOwnerAskDocIds;
    }
    if (row.transaction_id) txIds.add(row.transaction_id);
    const anchored = row.request_payload?.anchor_transaction_ids;
    if (Array.isArray(anchored)) {
      for (const txId of anchored) if (txId) txIds.add(txId);
    }
    if (row.request_payload?.document_id) docIds.add(row.request_payload.document_id);
  }
  return {
    openOwnerAskTxIds,
    openOwnerAskDocIds,
    undeliverableOwnerAskTxIds,
    undeliverableOwnerAskDocIds,
    answeredOwnerAskTxIds,
    answeredOwnerAskDocIds,
    openSeatAskTxIds,
    openSeatAskDocIds,
    answeredSeatAskTxIds,
    answeredSeatAskDocIds,
    openAgentAskTxIds,
    openAgentAskDocIds
  };
};

// M1.3 — the cascade verdict per bank line, built in ONE pass over raw
// `reconciliation_matches` rows. The sibling of collectOwnerAskSets, and used
// the same way: both projection sites (the snapshot and the feed chat) already
// have these rows loaded, so this adds no query and keeps the two lock-step.
//
// SCOPED TO 'auto_matched', mirroring healBlockedAutoMatch's own
// `if (!row || row.status !== 'auto_matched') return`:
//   - 'rejected'  — the match is not live; its cascade is moot.
//   - 'confirmed' — a human acted, and a confirmed row with a broken cascade
//                   leaves the transaction unexplained, which the tx's OWN axes
//                   already project as hanging. Nothing is lost by excluding it.
// An 'auto_matched' row is the one case that can read terminal on another axis
// while still being split, which is exactly why it needs its own check.
//
// Only a row carrying an explicit non-'applied' state is recorded — absence is
// not a verdict (every pre-#1131 row has no `cascade` key). Pure; tolerates raw
// DB rows or mapped payloads.
export const collectUnappliedCascadeTxIds = (reconciliationMatchRows = []) => {
  const byTxId = new Map();
  for (const row of Array.isArray(reconciliationMatchRows) ? reconciliationMatchRows : []) {
    if (norm(row?.status) !== 'auto_matched') continue;
    const state = norm(row?.payload?.cascade?.state);
    if (!state || state === CASCADE_APPLIED) continue;
    const txId = row.bank_transaction_id;
    if (txId != null && !byTxId.has(txId)) byTxId.set(txId, state);
  }
  return byTxId;
};

// NOTE ON THE SIGNATURE: `cascadeState` rides the EXISTING third-argument
// options object rather than becoming a fourth parameter. firmDb.test.js
// lint-pins the literal call `convergenceForReviewItem(item, tx, askContext)` at
// both projection sites so they cannot drift apart; threading through the same
// object keeps that pin intact instead of forcing it to be loosened.
// RT-23 — the auto-post sweep's refusal stamp on the transaction row
// (`payload.ledger_post_refusal`, flattened onto snapshot rows the same way
// every other payload key is). The error code is the reason's suffix; a
// stamp without a code still hangs, under 'unknown'.
const ledgerPostRefusedOf = (tx = {}) => {
  const holder = (tx.ledger_post_refusal && typeof tx.ledger_post_refusal === 'object')
    ? tx.ledger_post_refusal
    : (tx.payload?.ledger_post_refusal && typeof tx.payload.ledger_post_refusal === 'object')
      ? tx.payload.ledger_post_refusal
      : null;
  if (!holder) return null;
  return String(holder.code || '').trim() || 'unknown';
};

export const convergenceForReviewItem = (item = {}, tx = {}, { hasOpenOwnerAsk = false, hasUndeliverableOwnerAsk = false, hasAnsweredOwnerAsk = false, hasOpenSeatAsk = false, hasAnsweredSeatAsk = false, hasOpenAgentAsk = false, cascadeState = null, processingScope = null } = {}) => {
  const payload = item.payload || {};
  return deriveConvergenceState({
    processingScope,
    codingState: codingStateOf(item, tx),
    codingPending: norm(tx.status || tx.payload?.status) === 'needs_review',
    reconciliationStatus: tx.reconciliation_status || null,
    codedAccount: codedAccountOf(payload, tx),
    ledgerPostRefused: ledgerPostRefusedOf(tx),
    codingCorrectionRequired: tx.coding_correction_required || tx.payload?.coding_correction_required || null,
    disposition: tx.bank_line_disposition?.disposition || null,
    dispositionLane: dispositionLaneOf(tx.bank_line_disposition),
    hasOpenOwnerAsk,
    hasUndeliverableOwnerAsk,
    hasAnsweredOwnerAsk,
    hasOpenSeatAsk,
    hasAnsweredSeatAsk,
    hasOpenAgentAsk,
    cascadeState,
  });
};

export const convergenceForTransaction = (tx = {}, { hasOpenOwnerAsk = false, hasUndeliverableOwnerAsk = false, hasAnsweredOwnerAsk = false, hasOpenSeatAsk = false, hasAnsweredSeatAsk = false, hasOpenAgentAsk = false, cascadeState = null, processingScope = null } = {}) =>
  deriveConvergenceState({
    processingScope,
    codingState: codingStateOf({}, tx),
    codingPending: norm(tx.status || tx.payload?.status) === 'needs_review',
    reconciliationStatus: tx.reconciliation_status || null,
    codedAccount: codedAccountOf({}, tx),
    ledgerPostRefused: ledgerPostRefusedOf(tx),
    codingCorrectionRequired: tx.coding_correction_required || tx.payload?.coding_correction_required || null,
    disposition: tx.bank_line_disposition?.disposition || null,
    dispositionLane: dispositionLaneOf(tx.bank_line_disposition),
    hasOpenOwnerAsk,
    hasUndeliverableOwnerAsk,
    hasAnsweredOwnerAsk,
    hasOpenSeatAsk,
    hasAnsweredSeatAsk,
    hasOpenAgentAsk,
    cascadeState,
  });

// Doc-first terminal drain (docs/donna-doc-first-terminal-drain-plan.md,
// Slice 1) — project a parsed reconcilable DOCUMENT that has no bank line
// through the SAME core. Its persisted no-line disposition
// (`documents.payload.no_line_disposition`, flattened to the top level on
// snapshot docs by rowToDocumentPayload) plays the disposition role; an
// open doc-anchored owner ask plays hasOpenOwnerAsk. The core's policy is
// untouched: auto_explain settles, an open ask is on_owner, everything
// else hangs. The no-verdict case is relabelled from the core's generic
// 'unclassified' to a doc-specific reason so hanging_by_reason shows the
// doc-first population distinctly (it is the exact violation Kari named:
// "PARSED · AWAITING A BANK LINE" as a resting state).
// A complete no-settlement assessment finishes matching within its supplied
// scope. It never asserts payment, extinguishes the obligation, or covers asks.
const scopedNoSettlement = holder => holder?.decision_engine === 'jev'
  && holder.disposition === 'no_settlement' && holder.accounting_complete === false
  && typeof holder.evidence_packet_sha256 === 'string' && holder.evidence_packet_sha256.length > 0
  && Array.isArray(holder.scope?.transaction_ids) && holder.scope.absence_proven === false;
const projectScopedNoSettlement = (projection,holder) => scopedNoSettlement(holder)
  && projection.state === 'hanging' && projection.reason?.startsWith('disposition:no_settlement')
  ? result('hanging','no_settlement_in_scope') : projection;

export const convergenceForUnmatchedDocument = (doc = {}, { hasOpenOwnerAsk = false, hasUndeliverableOwnerAsk = false, hasAnsweredOwnerAsk = false, hasOpenSeatAsk = false, hasAnsweredSeatAsk = false, hasOpenAgentAsk = false } = {}) => {
  const holder = (doc.no_line_disposition && typeof doc.no_line_disposition === 'object')
    ? doc.no_line_disposition
    : (doc.payload?.no_line_disposition && typeof doc.payload.no_line_disposition === 'object')
      ? doc.payload.no_line_disposition
      : null;
  const settlement = doc.settlement_entry || doc.payload?.settlement_entry;
  const incompleteSettlement = holder?.disposition === 'auto_explain'
    && ['cash','personal_card','uncovered_account','unknown'].includes(holder?.settlement_channel)
    && (!settlement?.journal_id || settlement?.reversal);
  const p = deriveConvergenceState({
    disposition: incompleteSettlement ? 'needs_human' : holder?.disposition || null,
    dispositionLane: dispositionLaneOf(holder),
    hasOpenOwnerAsk,
    hasUndeliverableOwnerAsk,
    hasAnsweredOwnerAsk,
    hasOpenSeatAsk,
    hasAnsweredSeatAsk,
    hasOpenAgentAsk,
  });
  if (incompleteSettlement && p.state === 'hanging') return result('hanging','settlement_entry_missing');
  if (p.state === 'hanging' && p.reason === 'unclassified') {
    return result('hanging', 'doc_awaiting_line_no_verdict');
  }
  return projectScopedNoSettlement(p,holder);
};

// ── RT-13 — which DOCUMENTS are reconcile rows, and the doc-only rest states ──
//
// The reconcile feed's document population was defined in the FE-shared
// inbox lib (src/lib/documentsInbox.js selectNoLineReconcilableDocs: a
// parsed, amount-bearing reconcilable kind with no live document match).
// The persisted column needs the same membership rule at write time, plus
// the resting states wave 1 made honest and that population never saw:
//   - RT-02 `payload.parse_hold` — a pending row refused at parse_claim rests
//     on a readiness fact (RT-09: the host-wait codes land here);
//   - RT-08 the terminal parse failure — retryable false, retry_owner
//     'manual': a document resting on a human click, the audit's F-02 tail;
//   - RT-10 `duplicate_pending` — period overlap rests on the owner through
//     its statement_overlap ask, and on nobody without one; a byte collapse
//     is terminal and not a row at all.
// A row the classifier says is NOT a reconcile row keeps convergence_state
// NULL — never a fabricated terminal (an in-flight parse is the queue's, a
// matched document's verdict lives on its bank line, a statement's on its
// lines). Inlined vocabularies are pinned against documentsInbox.js by the
// invariant test (the askAudience precedent), so this module stays a leaf.
export const RECONCILABLE_DOCUMENT_KINDS_LOCKSTEP = Object.freeze([
  'receipt', 'supplier_bill', 'sales_invoice', 'issued_receipt', 'payment_confirmation'
]);
export const DOCUMENT_MATCH_TYPES_LOCKSTEP = Object.freeze([
  'document', 'receipt', 'supplier_bill', 'sales_invoice', 'payment_account_statement', 'payment_confirmation'
]);
const LIVE_MATCH_STATUSES = new Set(['suggested', 'auto_matched', 'confirmed']);
const DOCUMENT_MATCH_TYPE_SET = new Set(DOCUMENT_MATCH_TYPES_LOCKSTEP);

const holderOf = (doc = {}, key) => {
  if (doc?.[key] && typeof doc[key] === 'object') return doc[key];
  if (doc?.payload?.[key] && typeof doc.payload[key] === 'object') return doc.payload[key];
  return null;
};

// ── RT-21d — a consolidated statement converges row by row ──────────────────
// A koontilasku (RT-21b: one document line per listed settlement at its NET;
// RT-21c: a match names the row it settles through matched_line_id) is NOT
// "matched" the moment one bank line touches it. The document converges when
// EVERY row is settled; until then each open row rests on its OWN axis:
//   - settled  — an auto_matched / confirmed match names the row;
//   - proposed — a live 'suggested' match names the row: the bank line's axis
//                carries the verdict (a hold with its lane, or the RT-21a
//                owner ask), exactly as a suggested document match does today;
//   - future   — the row's printed paid date is after `now`: the credit has
//                not arrived yet, so the row is in flight on TIME, not resting
//                on a human — never hanging while it is future-dated;
//   - unsettled — no live match and the paid date has passed (or was not
//                printed): nobody holds it. That is the forbidden third state,
//                surfaced under the reason key `settlement_row:<line_no>:unsettled`
//                (the first such row by line_no names the document's verdict;
//                hanging_by_reason tells the rows apart from every other leak).
// A document-level match (matched_line_id NULL — the exact-reference tier's
// suggestion, a legacy row) never covers a listed row. The rows come from the
// gathered document_lines (`doc.settlement_lines`); a document without them is
// classified exactly as before.
export const SETTLEMENT_ROW_STATES = Object.freeze(['settled', 'proposed', 'future', 'unsettled']);
const SETTLED_MATCH_STATUSES = new Set(['auto_matched', 'confirmed']);

const settlementLinesOf = (doc = {}) =>
  (Array.isArray(doc?.settlement_lines) ? doc.settlement_lines : []).filter((l) => l && l.id != null);

const dayMs = (value) => {
  if (!value) return null;
  const ms = Date.parse(`${String(value).slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
};

export const classifySettlementRows = (doc = {}, { liveMatches = [], now = Date.now() } = {}) => {
  const lines = settlementLinesOf(doc);
  if (!lines.length) return [];
  const settledBy = new Map();
  const proposedBy = new Map();
  for (const m of Array.isArray(liveMatches) ? liveMatches : []) {
    if (!m || m.matched_object_id !== doc.id || !m.matched_line_id) continue;
    const st = norm(m.status);
    if (SETTLED_MATCH_STATUSES.has(st)) settledBy.set(String(m.matched_line_id), m.bank_transaction_id ?? null);
    else if (st === 'suggested') proposedBy.set(String(m.matched_line_id), m.bank_transaction_id ?? null);
  }
  return [...lines]
    .sort((a, b) => Number(a.line_no) - Number(b.line_no))
    .map((line) => {
      const id = String(line.id);
      const paidOn = line.paid_on ?? line.settlement_row?.paid_on ?? null;
      const paidMs = dayMs(paidOn);
      let state;
      if (settledBy.has(id)) state = 'settled';
      else if (proposedBy.has(id)) state = 'proposed';
      else if (paidMs != null && paidMs > now) state = 'future';
      else state = 'unsettled';
      return {
        line_id: id,
        line_no: Number(line.line_no),
        state,
        paid_on: paidOn || null,
        bank_transaction_id: settledBy.get(id) ?? proposedBy.get(id) ?? null
      };
    });
};

export const hasLiveDocumentMatch = (documentId, matches = []) =>
  (Array.isArray(matches) ? matches : []).some((m) =>
    m && m.matched_object_id === documentId
      && DOCUMENT_MATCH_TYPE_SET.has(m.matched_object_type)
      && LIVE_MATCH_STATUSES.has(norm(m.status)));

const notARow = (kind) => ({ reconcileRow: false, kind, reason: null });
const aRow = (kind, reason) => ({ reconcileRow: true, kind, reason });

export const classifyDocumentRest = (doc = {}, { liveMatches = [], now = Date.now() } = {}) => {
  if (!doc || doc.id == null) return notARow('not_reconcilable');
  const parseStatus = norm(doc.parse_status);
  const type = String(doc.document_type || '').trim();
  if (parseStatus === 'pending' || parseStatus === 'processing') {
    const hold = holderOf(doc, 'parse_hold');
    if (parseStatus === 'pending' && hold) return aRow('parse_hold', `parse_hold:${norm(hold.reason_code) || 'unknown'}`);
    return notARow('in_flight');
  }
  if (parseStatus === 'duplicate_pending') return aRow('duplicate_pending', 'duplicate_pending_no_ask');
  const collapsed = (parseStatus === 'skipped' && (doc.duplicate_of || norm(doc.parse_summary?.reason) === 'duplicate_auto_collapsed'))
    || (parseStatus === 'failed' && doc.duplicate_of);
  if (collapsed) return notARow('collapsed');
  if (parseStatus === 'failed') {
    const err = doc.parse_error && typeof doc.parse_error === 'object' ? doc.parse_error : {};
    // The queue still owes a retry: in flight, not at rest.
    if (err.retryable === true) return notARow('in_flight');
    const owner = err.retry_owner
      ? norm(err.retry_owner)
      : (err.retryable === false || err.retry_exhausted ? 'exhausted' : 'unowned');
    return aRow('parse_failed_terminal', `parse_failed:${owner}`);
  }
  // RT-21d: a parsed statement WITH settlement rows (a koontilasku) is a
  // reconcile row by virtue of its rows, ahead of the kind list — a
  // payout_statement / deposit_slip is not in RECONCILABLE_DOCUMENT_KINDS (the
  // doc-first population is the AP/AR + confirmation set), yet its listed
  // settlements are exactly the rows the first principle must see. The law:
  // converged when every row is settled (the bank lines carry the verdict);
  // hanging under the first unsettled past-due row; in flight while every open
  // row is future-dated. A statement without rows is classified as before.
  if (parseStatus === 'completed' && doc.total_amount != null) {
    const rows = classifySettlementRows(doc, { liveMatches, now });
    if (rows.length) {
      const unsettled = rows.find((r) => r.state === 'unsettled');
      if (unsettled) return aRow('settlement_rows_unsettled', `settlement_row:${unsettled.line_no}:unsettled`);
      if (rows.every((r) => r.state === 'settled' || r.state === 'proposed')) return notARow('matched');
      return notARow('settlement_row_future');
    }
  }
  if (type === 'bank_statement') return notARow('statement');
  if (!RECONCILABLE_DOCUMENT_KINDS_LOCKSTEP.includes(type)) return notARow('not_reconcilable');
  // payment_confirmation is stored `skipped` by design (no extraction) and
  // still reconciles; any other skipped kind is not a reconcile row.
  if (parseStatus === 'skipped' && type !== 'payment_confirmation') return notARow('not_reconcilable');
  if (parseStatus !== 'completed' && parseStatus !== 'skipped') return notARow('not_reconcilable');
  if (doc.total_amount == null) return notARow('not_reconcilable');
  if (hasLiveDocumentMatch(doc.id, liveMatches)) return notARow('matched');
  return aRow('no_line', null);
};

// The persisted DOCUMENT verdict (RT-13): null when the document is not a
// reconcile row, else the same core the feed's doc adapter runs, extended
// with the doc-only rest states. The persisted no-line verdict is read
// HOLDER-first (documents.payload.no_line_disposition — what the inbox
// renders, and the only holder a settlement journal can be posted off) and
// then the document_no_line_disposition evaluation row (a chase / needs_human
// verdict never writes the holder; a `superseded` row is not a verdict). The
// human-ask axes outrank every doc-only rest state exactly as they outrank
// the disposition: a hold or a terminal failure with an open owner ask on the
// document is on the owner.
export const convergenceForDocumentRow = (doc = {}, {
  liveMatches = [],
  evaluation = null,
  hasOpenOwnerAsk = false,
  hasUndeliverableOwnerAsk = false,
  hasAnsweredOwnerAsk = false,
  hasOpenSeatAsk = false,
  hasAnsweredSeatAsk = false,
  hasOpenAgentAsk = false,
  now = Date.now()
} = {}) => {
  const rest = classifyDocumentRest(doc, { liveMatches, now });
  if (!rest.reconcileRow) return null;
  const askAxes = { hasOpenOwnerAsk, hasUndeliverableOwnerAsk, hasAnsweredOwnerAsk, hasOpenSeatAsk, hasAnsweredSeatAsk, hasOpenAgentAsk };
  if (rest.kind === 'no_line') {
    const holder = holderOf(doc, 'no_line_disposition');
    const verdictPayload = evaluation && norm(evaluation.verdict) !== 'superseded'
      && evaluation.payload && typeof evaluation.payload === 'object'
      ? evaluation.payload
      : null;
    const source = holder?.disposition ? holder : (verdictPayload?.disposition ? verdictPayload : null);
    const p = deriveConvergenceState({
      disposition: source?.disposition || null,
      dispositionLane: dispositionLaneOf(source),
      ...askAxes
    });
    return p.state === 'hanging' && p.reason === 'unclassified'
      ? result('hanging', 'doc_awaiting_line_no_verdict')
      : projectScopedNoSettlement(p,source);
  }
  const p = deriveConvergenceState(askAxes);
  if (p.state !== 'hanging' || p.reason !== 'unclassified') return p;
  return result('hanging', rest.reason);
};

// ── Slice J consumer support: aggregate a reconcile FEED into metrics ────────
// Turn the feed's two row sets (bare transactions + their review-queue items)
// into convergenceMetrics, DEDUPED to exactly ONE projection per transaction: a
// transaction is represented by its review-queue item when it has one (the
// firm-side coding lifecycle owns that verdict), else by the bare transaction —
// the SAME tab-membership rule the feed/FE use (most doc-matched bank lines never
// get a queue row). Projects through the SAME adapters the live feed does, so the
// metric and the rendered chips can never disagree. Pure; no DB, no LLM.
//
//   transactions: [{ id, client_id, reconciliation_status, ... }]
//   reviewItems:  [{ payload:{transaction_id}, item_id, review_state, ... }]
//   openOwnerAskTxIds: Set (or iterable) of tx ids with an outstanding owner ask
//
// Returns { overall, by_client: { [client_id]: metrics } } — per-client because
// the escalation rate (prompts_per_100) is a per-book number (CLAUDE.md GOAL),
// with the firm-wide roll-up alongside. A row whose client is unknown buckets
// under '__unknown__' (surfaced, never dropped).
export const convergenceMetricsForFeed = ({
  transactions = [], reviewItems = [], openOwnerAskTxIds = new Set(),
  // F8 — tx/doc ids whose ask the owner already ANSWERED (status 'replied');
  // they project 'owner_answered_processing' (hanging), never on_owner.
  answeredOwnerAskTxIds = new Set(),
  // Doc-first terminal drain (Slice 1): parsed reconcilable documents with
  // no bank line (selectNoLineReconcilableDocs' population — violation AND
  // terminal rows, so a terminalized doc keeps counting). Each is one more
  // reconcile row in the metric, projected via convergenceForUnmatchedDocument.
  // Doc ids live in a different id space than tx ids — no dedupe across the
  // two sets, only within the doc set itself.
  unmatchedDocuments = [], openOwnerAskDocIds = new Set(),
  answeredOwnerAskDocIds = new Set(),
  // 122 — the seat/agent audience sets from collectOwnerAskSets. Absent sets
  // mean their asks are invisible here, which fails toward hanging.
  openSeatAskTxIds = new Set(), openSeatAskDocIds = new Set(),
  answeredSeatAskTxIds = new Set(), answeredSeatAskDocIds = new Set(),
  openAgentAskTxIds = new Set(), openAgentAskDocIds = new Set(),
  // M1.3 — Map<bank_transaction_id, cascadeState> from collectUnappliedCascadeTxIds.
  // Documents are unaffected: a no-line document has no match row and therefore
  // no cascade.
  unappliedCascadeByTxId = new Map()
} = {}) => {
  const ask = openOwnerAskTxIds instanceof Set ? openOwnerAskTxIds : new Set(openOwnerAskTxIds || []);
  const answered = answeredOwnerAskTxIds instanceof Set ? answeredOwnerAskTxIds : new Set(answeredOwnerAskTxIds || []);
  const docAsk = openOwnerAskDocIds instanceof Set ? openOwnerAskDocIds : new Set(openOwnerAskDocIds || []);
  const docAnswered = answeredOwnerAskDocIds instanceof Set ? answeredOwnerAskDocIds : new Set(answeredOwnerAskDocIds || []);
  const asSet = (v) => (v instanceof Set ? v : new Set(v || []));
  const seatAsk = asSet(openSeatAskTxIds);
  const seatDocAsk = asSet(openSeatAskDocIds);
  const seatAnswered = asSet(answeredSeatAskTxIds);
  const seatDocAnswered = asSet(answeredSeatAskDocIds);
  const agentAsk = asSet(openAgentAskTxIds);
  const agentDocAsk = asSet(openAgentAskDocIds);
  const cascades = unappliedCascadeByTxId instanceof Map
    ? unappliedCascadeByTxId
    : new Map(unappliedCascadeByTxId || []);
  const txById = new Map();
  for (const tx of Array.isArray(transactions) ? transactions : []) {
    if (tx && tx.id != null) txById.set(tx.id, tx);
  }
  // One projection per tx; the review item wins when present.
  const projectedByTx = new Map();
  for (const item of Array.isArray(reviewItems) ? reviewItems : []) {
    const txId = item?.payload?.transaction_id ?? item?.item_id;
    if (txId == null) continue;
    const tx = txById.get(txId) || {};
    const p = convergenceForReviewItem(item, tx, {
      hasOpenOwnerAsk: ask.has(txId),
      hasAnsweredOwnerAsk: answered.has(txId),
      hasOpenSeatAsk: seatAsk.has(txId),
      hasAnsweredSeatAsk: seatAnswered.has(txId),
      hasOpenAgentAsk: agentAsk.has(txId),
      cascadeState: cascades.get(txId) || null
    });
    projectedByTx.set(txId, { state: p.state, reason: p.reason, client_id: tx.client_id ?? item?.client_id ?? null });
  }
  for (const tx of txById.values()) {
    if (projectedByTx.has(tx.id)) continue;
    const p = convergenceForTransaction(tx, {
      hasOpenOwnerAsk: ask.has(tx.id),
      hasAnsweredOwnerAsk: answered.has(tx.id),
      hasOpenSeatAsk: seatAsk.has(tx.id),
      hasAnsweredSeatAsk: seatAnswered.has(tx.id),
      hasOpenAgentAsk: agentAsk.has(tx.id),
      cascadeState: cascades.get(tx.id) || null
    });
    projectedByTx.set(tx.id, { state: p.state, reason: p.reason, client_id: tx.client_id ?? null });
  }
  // One projection per no-line document (deduped by doc id within the set).
  const projectedByDoc = new Map();
  for (const doc of Array.isArray(unmatchedDocuments) ? unmatchedDocuments : []) {
    if (!doc || doc.id == null || projectedByDoc.has(doc.id)) continue;
    const p = convergenceForUnmatchedDocument(doc, {
      hasOpenOwnerAsk: docAsk.has(doc.id),
      hasAnsweredOwnerAsk: docAnswered.has(doc.id),
      hasOpenSeatAsk: seatDocAsk.has(doc.id),
      hasAnsweredSeatAsk: seatDocAnswered.has(doc.id),
      hasOpenAgentAsk: agentDocAsk.has(doc.id)
    });
    projectedByDoc.set(doc.id, { state: p.state, reason: p.reason, client_id: doc.client_id ?? null });
  }
  const all = [...projectedByTx.values(), ...projectedByDoc.values()];
  const byClientRows = new Map();
  for (const row of all) {
    const k = row.client_id == null ? '__unknown__' : row.client_id;
    if (!byClientRows.has(k)) byClientRows.set(k, []);
    byClientRows.get(k).push(row);
  }
  const by_client = {};
  for (const [k, rows] of byClientRows) by_client[k] = convergenceMetrics(rows);
  return { overall: convergenceMetrics(all), by_client };
};

// ═══════════════════════════════════════════════════════════════════════════
// ── Persisted convergence state (RT-13) ──────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
//
// Migration 137 persists the verdict: `convergence_state` ('auto_reconciled'
// | 'on_owner' | 'hanging'), `convergence_reason` and `convergence_as_of` on
// transactions and documents. This section is the ONLY writer of those
// columns, and it writes nothing but the projection above run over the row's
// CURRENT inputs, read back from the tables in one gather:
//
//   transactions: the row (coding_state — RT-16's one column —,
//     reconciliation_status, account_code, payload.account_name), its newest
//     OPEN review-queue item (a case file: its payload, never a coding
//     state), its reconciliation_matches (cascade verdict + the
//     INV-4 settled set), its bank_line_disposition evaluation (+ RT-10 lane),
//     its client_evidence_requests (own + anchored, by audience), and the
//     latest reconciliation GoalReport (the loop verdict outranks the legacy
//     column, exactly as the feed applies deriveReconciliationTerminalState).
//   documents: the row (parse_status / parse_error / parse_hold / duplicate
//     / total / no_line_disposition holder), its live document matches, its
//     document_no_line_disposition evaluation, and its doc-anchored asks.
//
// HOW WRITERS REACH IT (the one-derivation, many-writers problem — audit
// F-08: "every writer independently decides whether the row rests"). The
// inputs are written from ~40 sites across ~20 modules, and this slice is
// authorized for exactly ONE call in firmDb.js / reconciliationTriage.js /
// reconciliationLlmCore.js. So the write-through is structural, not per-site:
//   1. Migration 137's AFTER triggers on the six input tables record a MARK
//      (`convergence_marks`: firm, client, target, source, the writing xid)
//      whenever an input changes. The triggers compute NOTHING — the law
//      stays in JS; a mark is the write plane's receipt that a re-derivation
//      is owed (the 131 fence's shape: SQL records the fact, JS keeps the
//      policy).
//   2. `installConvergenceSettleOnPool` — the ONE call in firmDb.js
//      (loadPgPool), the seam every firm-database access passes through.
//      A checked-out client settles the current transaction's marks right
//      before its COMMIT (under a savepoint, so a settle failure can never
//      poison the writer's transaction) and sweeps committed marks on
//      release; a write-shaped pool.query is followed by the same sweep.
//      Column and inputs therefore change in the SAME transaction for every
//      transactional writer, and within the same call for the rest
//      (autocommit writers, a settle the savepoint rolled back).
//   3. `applyConvergenceState` is the explicit, direct write-through — the
//      two authorized writer calls (the match cascade, the match upsert) and
//      any caller that wants the column settled before its own reads.
//   4. The nightly `convergence-drift-nightly` manifest function recomputes
//      every row and reports drift + unsettled marks as a RECEIPT; it never
//      rewrites (`recomputeConvergenceDrift`).
//
// Env can only KILL this behaviour (DONNA_CONVERGENCE_SETTLE_DISABLED=1 makes
// the hook a pass-through; marks accumulate and the nightly names them) —
// never enable it, per the config-plane rail.

import { deriveReconciliationTerminalState } from './reconciliationTerminalState.js';
import { summarizeBankLineDispositions } from './bankLineDispositionShape.js';

export const CONVERGENCE_TARGET_TYPES = Object.freeze(['transaction', 'document']);
export const CONVERGENCE_SETTLE_SAVEPOINT = 'donna_convergence_settle';
export const CONVERGENCE_SETTLE_DISABLED_ENV = 'DONNA_CONVERGENCE_SETTLE_DISABLED';
const DEFAULT_SETTLE_LIMIT = 500;
const COMPUTE_BATCH = 200;
// Wall-clock budget of one global release sweep (F-23): checked between firms.
const DEFAULT_SETTLE_BUDGET_MS = 4000;

export const convergenceSettleDisabled = (env = process.env) => {
  const raw = env?.[CONVERGENCE_SETTLE_DISABLED_ENV];
  return raw != null && ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
};

// The reconciliation case id, computed in SQL so the goal-report join rides
// the same gather. MUST equal caseManager.buildCaseId({ caseType:
// 'reconciliation', primaryObjectType: 'transaction' }) — pinned on real PG by
// reconcileConvergencePersistencePgLifecycle.test.js.
export const RECONCILIATION_CASE_ID_SQL = (alias = 't') =>
  `'case-reconciliation-' || left(encode(sha256(convert_to(${alias}.firm_id || '|' || coalesce(${alias}.client_id, '') || '|reconciliation|transaction|' || ${alias}.id, 'UTF8')), 'hex'), 16)`;

// F-32 — the delivery fact of an ask, gathered with it: `undeliverable` = a
// never-sent draft on a send-contained client with nobody to receive it.
//   - "never sent": status 'draft' with no send stamp.
//   - "send-contained": donna_client_send_contained (migration 159), the SQL twin
//     of readInternalPilotSendContainmentWithClient (internalPilotAccess.js) — an
//     exact manual INTERNAL_PILOT_ACCESS enrollment not covered by a later
//     receipted release. Pinned equal to the JS reader by
//     convergenceUndeliverableAskPgLifecycle.test.js.
//   - "nobody to receive it": no ACTIVE owner/seat assignment (a
//     firm_collaborators row that is the self-serve owner or a seat) on the
//     client. Staff firm_members are not recipients of an owner ask.
export const ASK_DELIVERY_SQL = (alias = 'c') => `
                   'undeliverable', (case when ${alias}.status = 'draft' and ${alias}.send_count = 0
                       and ${alias}.first_sent_at is null and ${alias}.last_sent_at is null
                     -- CASE, not AND: evaluation order is only guaranteed here, and the
                     -- function must run for a never-sent draft alone.
                     then (donna_client_send_contained(${alias}.firm_id, ${alias}.client_id)
                     and not exists (
                       select 1 from client_assignments ca
                         join firm_collaborators fc on fc.id = ca.principal_id and fc.firm_id = ca.firm_id
                        where ca.firm_id = ${alias}.firm_id and ca.client_id = ${alias}.client_id
                          and ca.principal_type = 'firm_collaborator'
                          and (ca.starts_at is null or ca.starts_at <= now())
                          and (ca.ends_at is null or ca.ends_at > now())
                          and fc.status = 'active'
                          and (fc.seat_role is not null or fc.role = 'owner')))
                     else false end)`;

export const TRANSACTION_GATHER_SQL = `
  select t.id, t.client_id, t.status, t.reconciliation_status, t.account_code, t.payload, t.coding_state,
         t.convergence_state, t.convergence_reason, t.convergence_as_of,
         -- RT-25 (2026-09-09): the auto-post sweep's refusal RECEIPT (audit_events,
         -- durable) is the input, not the payload stamp — the Kampaamo re-run showed
         -- six receipts and zero stamps, a full-payload writer having rewritten the
         -- rows after the sweep. Same predicate as the sweep's retry damping
         -- (ledgerAutoPost.js ELIGIBLE_LINES_SQL: created_at > t.updated_at): the row
         -- hangs exactly while the sweep holds the refusal as current; a later write
         -- re-arms the sweep and a fresh receipt (or a journal) follows. A posted
         -- line outranks a stale receipt in the derivation (step 3a is applied-only).
         (select row_to_json(a) from (
            select a.metadata->>'code' as code, a.created_at
              from audit_events a
             where a.firm_id = t.firm_id and a.client_id = t.client_id
               and a.action = 'ledger.auto_post_refused'
               and a.resource_type = 'transaction' and a.resource_id = t.id
               and a.created_at > t.updated_at
             order by a.created_at desc, a.id desc
             limit 1) a) as ledger_post_refusal,
         (select coalesce(json_agg(json_build_object(
                   'id', q.id, 'item_type', q.item_type, 'item_id', q.item_id, 'status', q.status,
                   'payload', q.payload, 'created_at', q.created_at)
                 order by q.created_at desc, q.id desc), '[]'::json)
            from transaction_review_queue q
           where q.firm_id = t.firm_id and q.client_id = t.client_id and q.status = 'open'
             and q.item_type is distinct from 'document_line'
             and coalesce(q.payload->>'transaction_id', q.item_id) = t.id) as review_items,
         (select coalesce(json_agg(json_build_object(
                   'id', m.id, 'status', m.status, 'bank_transaction_id', m.bank_transaction_id,
                   'matched_object_type', m.matched_object_type, 'matched_object_id', m.matched_object_id,
                   'payload', m.payload)), '[]'::json)
            from reconciliation_matches m
           where m.firm_id = t.firm_id and m.bank_transaction_id = t.id) as matches,
         (select coalesce(json_agg(json_build_object(
                   'id', e.id, 'target_type', e.target_type, 'target_id', e.target_id, 'matcher_family', e.matcher_family,
                   'verdict', e.verdict, 'unmatchable_reason', e.unmatchable_reason, 'model', e.model, 'payload', e.payload)), '[]'::json)
            from reconciliation_evaluations e
           where e.firm_id = t.firm_id and e.client_id = t.client_id
             and e.target_type = 'transaction' and e.target_id = t.id
             and e.matcher_family = 'bank_line_disposition') as evaluations,
         (select coalesce(json_agg(json_build_object(
                   'id', c.id, 'status', c.status, 'audience', c.audience, 'evidence_type', c.evidence_type,
                   'transaction_id', c.transaction_id, 'request_payload', c.request_payload,
                   ${ASK_DELIVERY_SQL('c')})), '[]'::json)
            from client_evidence_requests c
           where c.firm_id = t.firm_id and c.client_id = t.client_id
             and (c.transaction_id = t.id or (c.request_payload->'anchor_transaction_ids') ? t.id)) as asks,
         (select row_to_json(g) from (
            select g.status, g.criteria, g.next_unmet_conditions
              from loop_goal_reports g
             where g.firm_id = t.firm_id and g.case_id = ${RECONCILIATION_CASE_ID_SQL('t')}
             order by g.created_at desc, g.id desc
             limit 1) g) as goal_report
    from transactions t
   where t.firm_id = $1 and t.id = any($2::text[])`;

const DOCUMENT_GATHER_SQL = `
  select d.id, d.client_id, d.document_type, d.parse_status, d.parse_error, d.parse_summary,
         d.duplicate_of, d.total_amount, d.payload,
         d.convergence_state, d.convergence_reason, d.convergence_as_of,
         (select coalesce(json_agg(json_build_object(
                   'id', m.id, 'status', m.status, 'bank_transaction_id', m.bank_transaction_id,
                   'matched_object_type', m.matched_object_type, 'matched_object_id', m.matched_object_id,
                   'matched_line_id', m.matched_line_id)), '[]'::json)
            from reconciliation_matches m
           where m.firm_id = d.firm_id and m.matched_object_id = d.id) as matches,
         (select coalesce(json_agg(json_build_object(
                   'id', dl.id, 'line_no', dl.line_no, 'amount', dl.amount,
                   'paid_on', dl.payload->'raw_extraction'->'settlement_row'->>'paid_on')
                 order by dl.line_no asc), '[]'::json)
            from document_lines dl
           where dl.firm_id = d.firm_id and dl.document_id = d.id
             and dl.payload->'raw_extraction'->'settlement_row' is not null) as settlement_lines,
         (select row_to_json(e) from (
            select e.id, e.verdict, e.unmatchable_reason, e.model, e.payload
              from reconciliation_evaluations e
             where e.firm_id = d.firm_id and e.client_id = d.client_id
               and e.target_type = 'document' and e.target_id = d.id
               and e.matcher_family = 'document_no_line_disposition'
             limit 1) e) as evaluation,
         (select coalesce(json_agg(json_build_object(
                   'id', c.id, 'status', c.status, 'audience', c.audience, 'evidence_type', c.evidence_type,
                   'transaction_id', c.transaction_id, 'request_payload', c.request_payload,
                   ${ASK_DELIVERY_SQL('c')})), '[]'::json)
            from client_evidence_requests c
           where c.firm_id = d.firm_id and c.client_id = d.client_id
             and c.request_payload->>'document_id' = d.id) as asks
    from documents d
   where d.firm_id = $1 and d.id = any($2::text[])`;

const asArray = (v) => (Array.isArray(v) ? v : []);
const chunk = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

// One gathered transaction row → the feed-shaped inputs → the ONE derivation.
// Exported so the consistency tests and the drift check compute exactly what
// the writer writes.
export const projectGatheredTransaction = (row = {}, { processingScope = null } = {}) => {
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  const tx = {
    ...payload,
    id: row.id,
    client_id: row.client_id,
    status: row.status || payload.status || null,
    coding_state: row.coding_state ?? null,
    account_code: row.account_code || payload.account_code || null,
    reconciliation_status: row.reconciliation_status || payload.reconciliation_status || null,
    // RT-25: the durable refusal receipt outranks the (erasable) payload stamp.
    ledger_post_refusal: (row.ledger_post_refusal && typeof row.ledger_post_refusal === 'object')
      ? row.ledger_post_refusal
      : (payload.ledger_post_refusal && typeof payload.ledger_post_refusal === 'object' ? payload.ledger_post_refusal : null)
  };
  // The loop verdict outranks the legacy column when present (design §10
  // Step 4) — the feed applies the same derivation before projecting.
  const terminal = deriveReconciliationTerminalState(row.goal_report || null, { legacyStatus: tx.reconciliation_status });
  if (terminal.verdict_present && terminal.reconciliation_status) tx.reconciliation_status = terminal.reconciliation_status;
  const matches = asArray(row.matches);
  // INV-4: a live settling match outranks the disposition verdict (the feed
  // drops the verdict for confirmed/auto_matched lines).
  const settled = new Set(matches
    .filter((m) => m.status === 'confirmed' || m.status === 'auto_matched')
    .map((m) => m.bank_transaction_id)
    .filter(Boolean));
  const evaluations = asArray(row.evaluations);
  const disposition = summarizeBankLineDispositions(evaluations, { settledTransactionIds: settled }).get(tx.id) || null;
  if (disposition) {
    const raw = evaluations.find((e) => e.matcher_family === 'bank_line_disposition' && e.verdict !== 'superseded');
    tx.bank_line_disposition = { ...disposition, lane: raw?.payload?.lane ?? disposition.lane ?? null };
  }
  const sets = collectOwnerAskSets(asArray(row.asks));
  const askContext = {
    processingScope,
    hasOpenOwnerAsk: sets.openOwnerAskTxIds.has(tx.id),
    hasUndeliverableOwnerAsk: sets.undeliverableOwnerAskTxIds.has(tx.id),
    hasAnsweredOwnerAsk: sets.answeredOwnerAskTxIds.has(tx.id),
    hasOpenSeatAsk: sets.openSeatAskTxIds.has(tx.id),
    hasAnsweredSeatAsk: sets.answeredSeatAskTxIds.has(tx.id),
    hasOpenAgentAsk: sets.openAgentAskTxIds.has(tx.id),
    cascadeState: collectUnappliedCascadeTxIds(matches).get(tx.id) || null
  };
  const items = asArray(row.review_items);
  const item = items.length
    ? { ...(items[0].payload || {}), payload: items[0].payload || {} }
    : null;
  return item ? convergenceForReviewItem(item, tx, askContext) : convergenceForTransaction(tx, askContext);
};

export const projectGatheredDocument = (row = {}, { now = Date.now() } = {}) => {
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  const doc = {
    ...payload,
    id: row.id,
    client_id: row.client_id,
    document_type: row.document_type,
    parse_status: row.parse_status,
    parse_error: row.parse_error,
    parse_summary: row.parse_summary,
    duplicate_of: row.duplicate_of,
    total_amount: row.total_amount,
    // RT-21d: the persisted settlement rows (document_lines with a
    // settlement_row payload) — the axis a koontilasku converges on.
    settlement_lines: asArray(row.settlement_lines),
    payload
  };
  const sets = collectOwnerAskSets(asArray(row.asks));
  return convergenceForDocumentRow(doc, {
    now,
    liveMatches: asArray(row.matches),
    evaluation: row.evaluation || null,
    hasOpenOwnerAsk: sets.openOwnerAskDocIds.has(doc.id),
    hasUndeliverableOwnerAsk: sets.undeliverableOwnerAskDocIds.has(doc.id),
    hasAnsweredOwnerAsk: sets.answeredOwnerAskDocIds.has(doc.id),
    hasOpenSeatAsk: sets.openSeatAskDocIds.has(doc.id),
    hasAnsweredSeatAsk: sets.answeredSeatAskDocIds.has(doc.id),
    hasOpenAgentAsk: sets.openAgentAskDocIds.has(doc.id)
  });
};

const persistedOf = (row) => ({
  state: row.convergence_state ?? null,
  reason: row.convergence_reason ?? null,
  as_of: row.convergence_as_of ?? null
});

// Gather + derive for a set of targets, WITHOUT writing. Returns one entry
// per row that exists: { target_type, target_id, client_id, derived:
// {state, reason} | null, persisted: {state, reason, as_of} }. A document the
// classifier says is not a reconcile row derives to null (the column stays
// NULL).
// Conservative marker discovery only; verified lineage in the batch reader
// owns scope. Current-life audits and partial account markers cannot be hidden
// by country/config edits. Unmarked rows keep the existing projector.
const nativeConvergenceTargets = async (client,firmId,ids) => {
  if (!ids.length) return [];
  const { retainedNativeMarkerSql } = await import('./nativeChartLineage.js');
  const sql = `with targets as materialized (select id,firm_id,client_id from transactions
    where firm_id=$1 and id=any($2::text[])), scopes as materialized (
      select distinct firm_id,client_id from targets
    ), marked as materialized (select * from scopes t where ${retainedNativeMarkerSql('t')})
    select t.id,t.client_id from targets t join marked m on m.firm_id=t.firm_id and m.client_id=t.client_id order by t.id`;
  return (await client.query(sql,[firmId,ids])).rows;
};

// A client whose native review evidence cannot be verified (an unverifiable
// retained marker, a registration revision chain that does not verify, a
// coding-choice/policy refusal) projects through the SAME gather + derivation
// as every other row, under that refusal's scope: every row hangs, visibly,
// under the refusal's own reason key, and no current review authority is
// granted. The caller writes that verdict and consumes the marks like any
// other settle — the violation rests on the persisted column (and the nightly
// drift names a stale one) instead of re-failing every sweep of the firm.
const projectNativeReviewRefusal = async (client,{firmId,transactionIds,error}) => {
  const { nativeReviewRefusalDecision } = await import('./runtimeReadinessAdmission.js');
  const scope = nativeReviewRefusalDecision(error,{ boundary:'review_projection' });
  const processingScope = { ...scope, review_current:false, review_reason:scope.reason_code, pending:false };
  const result = await client.query(TRANSACTION_GATHER_SQL,[firmId,transactionIds]);
  return (result.rows || []).map(row => ({ target_type:'transaction',target_id:row.id,client_id:row.client_id,
    derived:projectGatheredTransaction(row,{processingScope}),persisted:persistedOf(row),
    processing_scope:processingScope,
    projection_freshness:{ status:'incomplete',reason:scope.reason_code,pending_targets:0 } }));
};

// verdictOnly (the PERSIST paths: settle, write-through, nightly drift): the
// column is derived from the client-level processing scope alone, so a native
// client's scope is read once from one snapshot (readNativeVerdictScope) and
// its rows are gathered like any other; the per-focal 65-row review windows
// (review_current, pending, projection_freshness) are read-path concerns only.
export const computeConvergenceForTransactions = async (client, { firmId, transactionIds = [], verdictOnly = false } = {}) => {
  const ids = [...new Set(asArray(transactionIds).filter(Boolean))];
  const out = [];
  for (const batch of chunk(ids, COMPUTE_BATCH)) {
    const native = await nativeConvergenceTargets(client,firmId,batch);
    const nativeIds = new Set(native.map(row=>row.id));
    const legacyIds = batch.filter(id=>!nativeIds.has(id));
    if (legacyIds.length) {
      const result = await client.query(TRANSACTION_GATHER_SQL, [firmId, legacyIds]);
      for (const row of result.rows || []) out.push({ target_type: 'transaction', target_id: row.id,
        client_id: row.client_id, derived: projectGatheredTransaction(row), persisted: persistedOf(row) });
    }
    const byClient = new Map();
    for (const row of native) {
      if (!byClient.has(row.client_id)) byClient.set(row.client_id,[]);
      byClient.get(row.client_id).push(row.id);
    }
    if (byClient.size) {
      const { readNativeReviewContexts, readNativeVerdictScope } = await import('./db/codingEvidence.js');
      for (const [clientId,transactionIds] of byClient) {
        let current;
        try {
          if (verdictOnly) {
            const scope = await readNativeVerdictScope({ client,firmId,clientId,transactionId:transactionIds[0] });
            const processingScope = { ...scope, review_current:false, review_reason:scope.reason_code, pending:false };
            const result = await client.query(TRANSACTION_GATHER_SQL,[firmId,transactionIds]);
            out.push(...(result.rows || []).map(row => ({ target_type:'transaction',target_id:row.id,client_id:row.client_id,
              derived:projectGatheredTransaction(row,{processingScope}),persisted:persistedOf(row),processing_scope:processingScope })));
            continue;
          }
          current = await readNativeReviewContexts({ client,firmId,clientId,transactionIds });
        }
        catch (error) {
          // Only this client's typed native refusal is isolated (F-22); SQL,
          // NOWAIT and every other failure keep their original semantics.
          const { isNativeReviewRefusal } = await import('./runtimeReadinessAdmission.js');
          if (!isNativeReviewRefusal(error)) throw error;
          out.push(...await projectNativeReviewRefusal(client,{firmId,transactionIds,error}));
          continue;
        }
        for (const row of current.snapshot.projectionRows) {
          const processingScope = current.contexts.get(row.id) || current.scope;
          out.push({ target_type:'transaction',target_id:row.id,client_id:row.client_id,
            derived:projectGatheredTransaction(row,{processingScope}),persisted:persistedOf(row),
            processing_scope: processingScope,
            current_transaction: current.snapshot.windows.find(window=>window.transactionId===row.id)?.focal,
            projection_freshness: { status: current.snapshot.pendingTargets ? 'incomplete' : 'current',
              reason: current.snapshot.pendingTargets ? 'pending_convergence' : null,
              pending_targets: current.snapshot.pendingTargets } });
        }
      }
    }
  }
  return out;
};

// A read refreshes only a bounded requested subset. Remaining native rows
// cannot inherit current review authority from stored payload or old columns.
export const readNativeConvergenceProjectionForRows = async (client, {firmId,rows=[]}={}) => {
  const targets = await nativeConvergenceTargets(client,firmId,rows.map(row=>row.id).filter(Boolean));
  if (!targets.length) return null;
  const byId = new Map(rows.map(row=>[row.id,row]));
  const ordered = [...targets].sort((a,b)=>Number(Boolean(byId.get(b.id)?.review_scope || byId.get(b.id)?.payload?.review_scope))
    - Number(Boolean(byId.get(a.id)?.review_scope || byId.get(a.id)?.payload?.review_scope)));
  // F-33: the client-level processing scope is read from the rows refreshed here,
  // so every native client contributes at least one row before the batch fills;
  // the rows left over render their persisted verdict (snapshot.js).
  const seenClients = new Set();
  const representatives = ordered.filter(row=>!seenClients.has(row.client_id) && seenClients.add(row.client_id));
  const chosen = [...new Map([...representatives,...ordered].map(row=>[row.id,row])).values()].slice(0,Math.max(COMPUTE_BATCH,representatives.length));
  const current = await computeConvergenceForTransactions(client,{firmId,transactionIds:chosen.map(row=>row.id)});
  return { targets,current,capped:targets.length>COMPUTE_BATCH };
};

export const computeConvergenceForDocuments = async (client, { firmId, documentIds = [], now = Date.now() } = {}) => {
  const ids = [...new Set(asArray(documentIds).filter(Boolean))];
  const out = [];
  for (const batch of chunk(ids, COMPUTE_BATCH)) {
    const result = await client.query(DOCUMENT_GATHER_SQL, [firmId, batch]);
    for (const row of result.rows || []) {
      out.push({ target_type: 'document', target_id: row.id, client_id: row.client_id, derived: projectGatheredDocument(row, { now }), persisted: persistedOf(row) });
    }
  }
  return out;
};

export const computeConvergenceForTarget = async (client, { firmId, transactionId = null, documentId = null } = {}) => {
  if (transactionId) return (await computeConvergenceForTransactions(client, { firmId, transactionIds: [transactionId] }))[0] || null;
  if (documentId) return (await computeConvergenceForDocuments(client, { firmId, documentIds: [documentId] }))[0] || null;
  return null;
};

const WRITE_SQL = {
  transaction: `
    update transactions t
       set convergence_state = v.state, convergence_reason = v.reason, convergence_as_of = now()
      from unnest($2::text[], $3::text[], $4::text[]) as v(id, state, reason)
     where t.firm_id = $1 and t.id = v.id
       and (t.convergence_state is distinct from v.state
            or t.convergence_reason is distinct from v.reason
            or t.convergence_as_of is null)
     returning t.id`,
  document: `
    update documents d
       set convergence_state = v.state, convergence_reason = v.reason, convergence_as_of = now()
      from unnest($2::text[], $3::text[], $4::text[]) as v(id, state, reason)
     where d.firm_id = $1 and d.id = v.id
       and (d.convergence_state is distinct from v.state
            or d.convergence_reason is distinct from v.reason
            or d.convergence_as_of is null)
     returning d.id`
};

const writeDerived = async (client, { firmId, targetType, computed }) => {
  if (!computed.length) return [];
  const result = await client.query(WRITE_SQL[targetType], [
    firmId,
    computed.map((c) => c.target_id),
    computed.map((c) => c.derived?.state ?? null),
    computed.map((c) => c.derived?.reason ?? null)
  ]);
  return (result.rows || []).map((r) => r.id);
};

// Re-derive the named rows from their CURRENT inputs and write the columns
// inside the caller's transaction (or as one autocommit statement per table
// when the caller is not in one). Idempotent; writes only rows whose verdict
// changed (or was never derived). Marks the current transaction recorded for
// these targets are consumed, so the commit-time settle does not repeat the
// work. Returns { transactions: [...computed], documents: [...computed],
// changed: [ids] }.
export const applyConvergenceState = async (client, options = {}) => {
  // Scope discovery and the guarded projection share the same checkout. A
  // pool.query preflight would otherwise borrow once before the real work.
  // Legacy direct apply keeps its existing autocommit behavior.
  if (isConvergencePool(client)) {
    const connection = await client.connect();
    let failure;
    try { return await applyConvergenceStateOnConnection(connection,options,'pool_owned'); }
    catch (error) { failure=error; throw error; }
    finally { connection.release(failure); }
  }
  return applyConvergenceStateOnConnection(client,options);
};

const applyConvergenceStateOnConnection = async (client, options, connectionKind) => {
  const ids = [...new Set([options.transactionId,...asArray(options.transactionIds)].filter(Boolean))];
  if (!client || !options.firmId || !ids.length) return applyConvergenceStateWithClient(client,options);
  const native = await nativeConvergenceTargets(client,options.firmId,ids);
  if (!native.length) return applyConvergenceStateWithClient(client,options);
  return withConvergenceTransaction(client, async (raw, {physicalClient}) => {
    try {
      await raw.query('select id from transactions where firm_id=$1 and id=any($2::text[]) order by id for update nowait',
        [options.firmId,native.map(row=>row.id)]);
    } catch (error) {
      if (error.code==='55P03') error.nativeProjectionContention = true;
      throw error;
    }
    assertVerdictTransactionBudgetActive(physicalClient);
    return applyConvergenceStateWithClient(raw,options);
  },{connectionKind});
};

// F-22: an isolated native refusal is a violation to surface, so the verdict
// that first writes it leaves a durable receipt (one audit row per client and
// reason, only when the persisted verdict actually changed — a re-derivation
// that finds the same refusal writes nothing). Audit-as-precondition: it rides
// the verdict's own transaction. Cheap no-op for every non-refused row.
const receiptNativeReviewRefusals = async (client, { firmId, computed, changed }) => {
  const changedIds = new Set(changed);
  const byKey = new Map();
  for (const c of computed) {
    const scope = c.processing_scope;
    if (!scope?.enforced || !changedIds.has(c.target_id) || !c.client_id) continue;
    if (scope.reason_code !== 'native_chart_lineage_invalid' && scope.native_refusal !== true) continue;
    const key = `${c.client_id}\u0000${scope.reason_code}`;
    if (!byKey.has(key)) byKey.set(key, { client_id: c.client_id, reason: scope.reason_code,
      refusal: scope.refusal_error ?? scope.lineage_error ?? null, ids: [] });
    byKey.get(key).ids.push(c.target_id);
  }
  if (!byKey.size) return;
  const rows = [...byKey.values()];
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     select $1, r.client_id, 'system', 'convergence', 'convergence.native_review_refused', 'client', r.client_id,
            jsonb_build_object('reason', r.reason, 'refusal', r.refusal, 'transactions_hanging', jsonb_array_length(r.ids),
                               'sample_transaction_ids', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (select jsonb_array_elements_text(r.ids) x limit 20) q))
       from jsonb_to_recordset($2::jsonb) as r(client_id text, reason text, refusal jsonb, ids jsonb)`,
    [firmId, JSON.stringify(rows)]);
};

const applyConvergenceStateWithClient = async (client, {
  firmId,
  transactionId = null,
  documentId = null,
  transactionIds = [],
  documentIds = []
} = {}) => {
  if (!client || !firmId) return { transactions: [], documents: [], changed: [] };
  const txIds = [...new Set([transactionId, ...asArray(transactionIds)].filter(Boolean))];
  const docIds = [...new Set([documentId, ...asArray(documentIds)].filter(Boolean))];
  const transactions = txIds.length ? await computeConvergenceForTransactions(client, { firmId, transactionIds: txIds, verdictOnly: true }) : [];
  const documents = docIds.length ? await computeConvergenceForDocuments(client, { firmId, documentIds: docIds }) : [];
  const changed = [
    ...await writeDerived(client, { firmId, targetType: 'transaction', computed: transactions }),
    ...await writeDerived(client, { firmId, targetType: 'document', computed: documents })
  ];
  await receiptNativeReviewRefusals(client, { firmId, computed: transactions, changed });
  if (txIds.length || docIds.length) {
    await client.query(
      `delete from convergence_marks
        where firm_id = $1 and marked_xid = pg_current_xact_id()
          and ((target_type = 'transaction' and target_id = any($2::text[]))
               or (target_type = 'document' and target_id = any($3::text[])))`,
      [firmId, txIds, docIds]
    ).catch(softFailMissingRelation);
  }
  return { transactions, documents, changed };
};

// The writer-side call (the cascade, the match upsert): a derivation failure
// must never fail the writer — the match / cascade already happened, and a
// matcher running autocommit has already committed it. Log loudly, leave the
// marks (the pool hook's next sweep re-tries them; the nightly names what
// rests), return null.
export const applyConvergenceStateBestEffort = async (client, args = {}, { logger = console, logTag = 'reconcileConvergenceState' } = {}) => {
  try {
    return await applyConvergenceState(client, args);
  } catch (error) {
    logger?.error?.(`[${logTag}] convergence write-through failed — marks left for the sweep`, {
      firm_id: args.firmId ?? null,
      transaction_id: args.transactionId ?? null,
      document_id: args.documentId ?? null,
      error: error?.message || String(error)
    });
    return null;
  }
};

const softFailMissingRelation = (error) => {
  // A pre-137 database (the marks table is not there yet): nothing to settle.
  if (error?.code === '42P01' || error?.code === '42703') return { rows: [] };
  throw error;
};

// Claim marks and settle their targets. scope:
//   'transaction' — only marks this transaction wrote (pg_current_xact_id());
//                   the commit-time settle;
//   'committed'   — only marks other (committed) transactions wrote, claimed
//                   with SKIP LOCKED so two settlers never fight; the
//                   post-callback sweep;
//   'all'         — both, for an explicit caller (the reconcile stats read).
// firmId / clientId narrow the claim. Returns { claimed, targets, firms,
// changed } — marks whose row no longer exists are consumed silently.
export const settleConvergenceMarks = (client, options = {}) =>
  withConvergenceTransaction(client, raw => settleConvergenceMarksWithClient(raw, options));

// Only our native target NOWAIT fence permits an incomplete read. Other SQL,
// lineage and projection failures retain their original failure semantics.
export const settleConvergenceForRead = async (client, options={}) => {
  try { return await settleConvergenceMarks(client,options); }
  catch (error) {
    if (!error.nativeProjectionContention || error.convergenceConnectionDiscarded) throw error;
    return { claimed:0,projection_freshness:{status:'incomplete',reason:'pending_convergence'} };
  }
};

const REQUEUE_MARKS_SQL = `insert into convergence_marks (firm_id, client_id, target_type, target_id, source, marked_xid)
  select firm_id, client_id, target_type, target_id, source, marked_xid
    from jsonb_to_recordset($1::jsonb) as m(firm_id text, client_id text, target_type text, target_id text, source text, marked_xid xid8)
  order by target_type, target_id
  on conflict do nothing`;

const settleConvergenceMarksWithClient = async (client, {
  firmId = null,
  clientId = null,
  scope = 'all',
  limit = DEFAULT_SETTLE_LIMIT,
  budgetMs = DEFAULT_SETTLE_BUDGET_MS,
  clock = () => performance.now()
} = {}) => {
  const where = ['($1::text is null or firm_id = $1)', '($2::text is null or client_id = $2)'];
  if (scope === 'transaction') {
    where.push('marked_xid = pg_current_xact_id()');
    // F-30: a scope mark re-derives the client's whole book. That work never
    // runs inside the writer's own transaction (which may hold the native
    // source fence): the committed mark survives the commit and the time-budgeted
    // release sweep expands it right after. The cheap source mark still settles here.
    where.push("not (target_type = 'client' and source = 'native_review_scope')");
  }
  if (scope === 'committed') where.push('marked_xid <> pg_current_xact_id()');
  const claimed = await client.query(
    `with claimed as materialized (select id from convergence_marks
                    where ${where.join(' and ')}
                    order by id
                    limit $3
                    for update skip locked)
      delete from convergence_marks using claimed
      where convergence_marks.id = claimed.id
      returning convergence_marks.firm_id, convergence_marks.client_id, convergence_marks.target_type,
        convergence_marks.target_id, convergence_marks.source, convergence_marks.marked_xid`,
    [firmId, clientId, limit]
  ).catch(softFailMissingRelation);
  const rows = claimed.rows || [];
  const byFirm = new Map();
  for (const row of rows) {
    if (!byFirm.has(row.firm_id)) byFirm.set(row.firm_id, { transactionIds: new Set(), documentIds: new Set(), marks: [] });
    const bucket = byFirm.get(row.firm_id);
    bucket.marks.push(row);
    if (row.target_type === 'transaction') bucket.transactionIds.add(row.target_id);
    else if (row.target_type === 'document') bucket.documentIds.add(row.target_id);
    // A CLIENT mark (migration 158) is one native client's dependency mark. A
    // scope mark (lineage / registration / chart change) re-derives every row of
    // the client verdict-only; a source mark only kept the projection pending and
    // is consumed by the claim itself — row-level inputs ride the 137 marks.
    else if (row.target_type === 'client' && row.source === 'native_review_scope') {
      (bucket.scopeClients ||= new Set()).add(row.client_id);
    }
  }
  const changed = [];
  const failedFirms = [];
  const deferredFirms = [];
  let targets = 0;
  // The global release sweep (no firm/client narrowing) serves EVERY firm from
  // one FIFO. One firm whose settle fails must not pin the head for all of
  // them (F-22): under a per-firm savepoint its work is undone, its claimed
  // marks go back to the TAIL of the queue (new ids), and the sweep carries on
  // with the other firms. A firm- or xid-narrowed settle keeps its original
  // fail-the-caller semantics (the commit-time savepoint, the read fence).
  const isolate = scope === 'committed' && firmId == null && clientId == null;
  const started = clock();
  let processed = 0;
  for (const [firm, bucket] of byFirm) {
    // F-23: the release sweep is time-budgeted as well as count-budgeted. A firm
    // reached after the budget is spent is requeued untouched (never partially
    // applied); the first firm always runs, so every sweep makes progress.
    if (isolate && processed && clock() - started > budgetMs) {
      await client.query(REQUEUE_MARKS_SQL, [JSON.stringify(bucket.marks)]);
      deferredFirms.push({ firm_id: firm, marks: bucket.marks.length });
      continue;
    }
    processed++;
    for (const scopedClient of bucket.scopeClients || []) {
      const ids = await client.query('select id from transactions where firm_id=$1 and client_id=$2 order by id', [firm, scopedClient]);
      for (const r of ids.rows || []) bucket.transactionIds.add(r.id);
    }
    targets += bucket.transactionIds.size + bucket.documentIds.size;
    const args = { firmId: firm, transactionIds: [...bucket.transactionIds], documentIds: [...bucket.documentIds] };
    if (!isolate) { changed.push(...(await applyConvergenceState(client, args)).changed); continue; }
    await client.query('savepoint donna_convergence_firm');
    try {
      changed.push(...(await applyConvergenceState(client, args)).changed);
      await client.query('release savepoint donna_convergence_firm');
    } catch (error) {
      await client.query('rollback to savepoint donna_convergence_firm');
      await client.query('release savepoint donna_convergence_firm');
      await client.query(REQUEUE_MARKS_SQL, [JSON.stringify(bucket.marks)]);
      failedFirms.push({ firm_id: firm, marks: bucket.marks.length, error: error?.message || String(error) });
    }
  }
  return { claimed: rows.length, targets, firms: byFirm.size, changed,
    ...(failedFirms.length ? { failed_firms: failedFirms } : {}), ...(deferredFirms.length ? { deferred_firms: deferredFirms } : {}) };
};

const queryTextOf = (arg) => {
  if (typeof arg === 'string') return arg;
  if (arg && typeof arg === 'object' && typeof arg.text === 'string') return arg.text;
  return null;
};
const TXN_VERB = /^\s*(begin|start\s+transaction|commit|end|rollback|abort)\b/i;

// The pool hook — the ONE call in firmDb.js (loadPgPool). Every firm-database
// access goes through that pool, two ways, and both are covered:
//   - pool.connect(): the checked-out client is hooked (hookPooledClient) —
//     a COMMIT issued inside a transaction first settles the marks that
//     transaction wrote, under a savepoint; and release() sweeps committed
//     marks before handing the client back;
//   - pool.query(): a write-shaped statement (insert / update / delete /
//     with) is followed by a sweep on a checked-out client — the writers
//     that never borrow a client (firmDb's own pool.query updates, the parse
//     hold writer) settle within the same call.
// Idempotent per pool. Pass-through when the kill switch is set.
export const installConvergenceSettleOnPool = (pool, { logger = console, limit = DEFAULT_SETTLE_LIMIT } = {}) => {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') return pool;
  if (pool.__donnaConvergenceSettle) return pool;
  const originalConnect = pool.connect.bind(pool);
  const originalQuery = pool.query.bind(pool);
  const sweepWithClient = async () => {
    if (convergenceSettleDisabled()) return;
    let client;
    try {
      client = await originalConnect();
    } catch {
      return;
    }
    try {
      await settleCommittedConvergenceMarks(client, { logger, limit });
    } finally {
      client.release();
    }
  };
  pool.connect = function convergenceSettlingConnect(...args) {
    // Callback-style checkouts pass through unhooked (none in this tree).
    if (typeof args[args.length - 1] === 'function') return originalConnect(...args);
    return originalConnect(...args).then((client) => hookPooledClient(client, { logger, limit }));
  };
  pool.query = function convergenceSettlingPoolQuery(...args) {
    if (typeof args[args.length - 1] === 'function') return originalQuery(...args);
    const result = originalQuery(...args);
    const text = queryTextOf(args[0]);
    if (!text || !WRITE_SHAPE.test(text) || convergenceSettleDisabled()) return result;
    return result.then(async (r) => {
      await sweepWithClient().catch((error) => {
        logger?.warn?.('[reconcileConvergenceState] post-write sweep failed', { error: error?.message || String(error) });
      });
      return r;
    });
  };
  pool.__donnaConvergenceSettle = true;
  return pool;
};
const WRITE_SHAPE = /^\s*(insert|update|delete|with|merge)\b/i;

// A checked-out pooled client: `query` intercepts the transaction verbs so a
// COMMIT settles its own marks first (under a savepoint — a settle failure
// rolls back to it, is logged, and the writer's commit proceeds unharmed);
// `release` sweeps committed marks before the pool gets the client back.
// Both patches are undone on release, so the pool always recycles a clean
// client. Pass-through when the kill switch is set.
export const hookPooledClient = (client, { logger = console, limit = DEFAULT_SETTLE_LIMIT } = {}) => {
  if (!client || typeof client.query !== 'function' || convergenceSettleDisabled()) return client;
  if (client.__donnaConvergenceHooked) return client;
  const ownQuery = Object.prototype.hasOwnProperty.call(client, 'query');
  const originalQuery = client.query;
  const originalRelease = client.release;
  let inTransaction = false;
  const connection = bindConvergenceConnection(client, {
    rawQuery: (...args) => originalQuery.apply(client, args),
    setInTransaction: value => { inTransaction = value; }
  });
  const raw = connection.raw;
  const restore = () => {
    if (ownQuery) client.query = originalQuery;
    else delete client.query;
    client.release = originalRelease;
    delete client.__donnaConvergenceHooked;
  };
  const settleAtCommit = () => settleCurrentTransactionMarks(raw, { logger, limit });
  client.query = function convergenceSettlingQuery(...args) {
    if (connection.depth) return originalQuery.apply(client, args);
    const text = queryTextOf(args[0]);
    const verb = text ? (TXN_VERB.exec(text)?.[1] || '').toLowerCase() : '';
    if (!verb) {
      // An autocommit WRITE (no transaction open): its marks are committed the
      // moment the statement returns, so sweep before handing the result back
      // — the caller awaits this statement, and callers never await release().
      if (!inTransaction && text && WRITE_SHAPE.test(text) && typeof args[args.length - 1] !== 'function') {
        return Promise.resolve(originalQuery.apply(client, args)).then(async (result) => {
          await settleCommittedConvergenceMarks(raw, { logger, limit }).catch(() => {});
          return result;
        });
      }
      return originalQuery.apply(client, args);
    }
    // A savepoint rollback keeps the enclosing verdict transaction alive.
    if (verb === 'rollback' && /^\s*rollback\s+(?:(?:work|transaction)\s+)?to\b/i.test(text)) {
      return originalQuery.apply(client, args);
    }
    if (verb === 'begin' || verb.startsWith('start')) {
      inTransaction = true;
      return originalQuery.apply(client, args);
    }
    if (verb === 'commit' || verb === 'end') {
      if (!inTransaction) return originalQuery.apply(client, args);
      return settleAtCommit()
        .then(() => {
          assertVerdictTransactionBudgetActive(client);
          return originalQuery.apply(client, args);
        })
        .then((result) => {
          inTransaction = false;
          clearVerdictTransactionBudget(client);
          return result;
        });
    }
    return Promise.resolve(originalQuery.apply(client, args)).finally(() => {
      inTransaction = false;
      clearVerdictTransactionBudget(client);
    });
  };
  // Release: the best-effort net for marks a FOREIGN connection left (a
  // script, a psql edit, a test's scratch client) — callers do not await
  // release(), so this is eventually consistent by design; a hooked write
  // or commit settles synchronously.
  client.release = function convergenceSettlingRelease(err) {
    if (connection.discarded) return;
    if (connection.depth) { restore(); unbindConvergenceConnection(connection); return originalRelease.call(client, err); }
    const openTransaction = inTransaction;
    clearVerdictTransactionBudget(client);
    restore();
    if (err || openTransaction) { unbindConvergenceConnection(connection); return originalRelease.call(client, err); }
    return settleCommittedConvergenceMarks(raw, { logger, limit })
      .catch(() => {})
      .then(() => {
        unbindConvergenceConnection(connection);
        if (!connection.discarded) return originalRelease.call(client);
      });
  };
  client.__donnaConvergenceHooked = true;
  return client;
};

// The commit-time settle, factored so the client hook and the callback
// wrapper below share it.
// F-28: the marks table is probed with to_regclass (a catalog lookup that cannot
// abort the writer's transaction — a failing statement here would poison it, as
// the pre-137 `delete from convergence_marks` did once per migration 001..136),
// and a positive answer is remembered per physical connection. Contention (another
// session holding FOR SHARE on the client's rows, a native refusal) is an expected,
// bounded condition: logged at warn with its cause, the marks are retained, and the
// nightly drift receipt counts them as unsettled_marks.
const marksTableKnown = new WeakSet();
const settleCurrentTransactionMarks = async (raw, { logger, limit }) => {
  const physical = convergenceConnectionRecord(raw)?.physicalClient;
  try {
    if (!physical || !marksTableKnown.has(physical)) {
      const probe = await raw.query("select to_regclass('convergence_marks') is not null as present");
      if (probe.rows?.[0]?.present === false) return;
      if (physical) marksTableKnown.add(physical);
    }
    await settleConvergenceMarks(raw, { scope: 'transaction', limit });
  } catch (error) {
    const contended = error?.code === '55P03' || error?.nativeProjectionContention === true;
    (contended ? logger?.warn : logger?.error)?.call(logger, '[reconcileConvergenceState] settle at commit failed — marks retained', {
      error: error?.message || String(error), code: error?.code || null,
      cause: contended ? 'lock_contention' : 'unexpected'
    });
    if (error.convergenceConnectionDiscarded) throw error;
  }
};

// The callback form of the same hook, for a caller that holds a client the
// pool did not hand out (a test's scratch connection, a script): wraps
// `client` for the duration of `callback`, settling at commit and sweeping
// once the callback has returned in autocommit state.
//   - a COMMIT issued inside a transaction first settles the marks that
//     transaction wrote, under a savepoint: a settle failure rolls back to the
//     savepoint, is logged loudly, leaves the marks for the sweep, and the
//     writer's commit proceeds unharmed (a projection bug must never poison a
//     ledger write — and must never be silent either);
//   - after the callback returns in autocommit state, committed marks are
//     claimed (SKIP LOCKED, a bounded lock_timeout) and settled in a
//     transaction of their own, so autocommit writers and a rolled-back
//     commit-time settle converge within the same connection use.
// The client's `query` is restored before the pool gets it back. Pass-through
// when the kill switch is set or the client has no query function.
export const withConvergenceSettle = async (client, callback, { logger = console, limit = DEFAULT_SETTLE_LIMIT } = {}) => {
  if (!client || typeof client.query !== 'function' || convergenceSettleDisabled()) return callback(client);
  const ownQuery = Object.prototype.hasOwnProperty.call(client, 'query');
  const originalQuery = client.query;
  let inTransaction = false;
  const connection = bindConvergenceConnection(client, {
    rawQuery: (...args) => originalQuery.apply(client, args),
    setInTransaction: value => { inTransaction = value; }
  });
  const raw = connection.raw;
  const restore = () => {
    if (ownQuery) client.query = originalQuery;
    else delete client.query;
  };
  const settleAtCommit = () => settleCurrentTransactionMarks(raw, { logger, limit });
  client.query = function convergenceSettlingQuery(...args) {
    if (connection.depth) return originalQuery.apply(client, args);
    const text = queryTextOf(args[0]);
    const verb = text ? (TXN_VERB.exec(text)?.[1] || '').toLowerCase() : '';
    if (!verb) return originalQuery.apply(client, args);
    // A savepoint rollback keeps the enclosing verdict transaction alive.
    if (verb === 'rollback' && /^\s*rollback\s+(?:(?:work|transaction)\s+)?to\b/i.test(text)) {
      return originalQuery.apply(client, args);
    }
    if (verb === 'begin' || verb.startsWith('start')) {
      inTransaction = true;
      return originalQuery.apply(client, args);
    }
    if (verb === 'commit' || verb === 'end') {
      if (!inTransaction) return originalQuery.apply(client, args);
      return settleAtCommit()
        .then(() => {
          assertVerdictTransactionBudgetActive(client);
          return originalQuery.apply(client, args);
        })
        .then((result) => {
          inTransaction = false;
          clearVerdictTransactionBudget(client);
          return result;
        });
    }
    return Promise.resolve(originalQuery.apply(client, args)).finally(() => {
      inTransaction = false;
      clearVerdictTransactionBudget(client);
    });
  };
  let result;
  try {
    result = await callback(client);
  } catch (error) {
    restore();
    unbindConvergenceConnection(connection);
    throw error;
  }
  restore();
  try {
    if (!inTransaction) await settleCommittedConvergenceMarks(raw, { logger, limit });
    return result;
  } finally { unbindConvergenceConnection(connection); }
};

// The post-callback sweep: claim committed marks and settle them in a
// transaction of this connection's own. Never throws — a failure is logged and
// the marks stay for the next connection use (and the nightly names them).
export const settleCommittedConvergenceMarks = async (client, { logger = console, limit = DEFAULT_SETTLE_LIMIT } = {}) => {
  let pending;
  try {
    pending = await client.query('select 1 from convergence_marks limit 1');
  } catch (error) {
    if (error?.code === '42P01') return { claimed: 0, skipped: 'marks_table_missing' };
    logger?.warn?.('[reconcileConvergenceState] marks probe failed', { error: error?.message || String(error) });
    return { claimed: 0, skipped: 'probe_failed' };
  }
  if (!(pending.rows || []).length) return { claimed: 0 };
  try {
    const result = await withConvergenceTransaction(client, async raw => {
      await raw.query("set local lock_timeout = '2000ms'");
      return settleConvergenceMarksWithClient(raw, { scope: 'committed', limit });
    });
    if (result?.failed_firms?.length) logger?.warn?.('[reconcileConvergenceState] post-commit settle failed for a firm — its marks were requeued', { failed_firms: result.failed_firms });
    return result;
  } catch (error) {
    logger?.warn?.('[reconcileConvergenceState] post-commit settle failed — marks left for the next sweep', { error: error?.message || String(error) });
    return { claimed: 0, error: error?.message || String(error) };
  }
};

// The nightly recompute: derive every row again and REPORT where the column
// disagrees. Never writes a column — drift is a coverage bug to fix at the
// writer (a missing trigger, a settle that could not run), not a value to
// paper over. Returns counts plus a bounded sample of the drifted rows and
// the unsettled marks for the firm.
export const recomputeConvergenceDrift = async (client, { firmId, clientId = null, sampleLimit = 50 } = {}) => {
  if (!client || !firmId) return null;
  const txIds = (await client.query(
    'select id from transactions where firm_id = $1 and ($2::text is null or client_id = $2) order by id',
    [firmId, clientId]
  )).rows.map((r) => r.id);
  const docIds = (await client.query(
    'select id from documents where firm_id = $1 and ($2::text is null or client_id = $2) order by id',
    [firmId, clientId]
  )).rows.map((r) => r.id);
  const computed = [
    ...await computeConvergenceForTransactions(client, { firmId, transactionIds: txIds, verdictOnly: true }),
    ...await computeConvergenceForDocuments(client, { firmId, documentIds: docIds })
  ];
  const drifted = [];
  const byReason = {};
  const persistedCounts = { auto_reconciled: 0, on_owner: 0, hanging: 0, null: 0 };
  let neverDerived = 0;
  for (const c of computed) {
    const derivedState = c.derived?.state ?? null;
    const derivedReason = c.derived?.reason ?? null;
    persistedCounts[c.persisted.state ?? 'null'] = (persistedCounts[c.persisted.state ?? 'null'] || 0) + 1;
    if (c.persisted.as_of == null && derivedState != null) neverDerived += 1;
    if (c.persisted.state !== derivedState || c.persisted.reason !== derivedReason) {
      const key = `${c.persisted.state ?? 'null'}->${derivedState ?? 'null'}`;
      byReason[key] = (byReason[key] || 0) + 1;
      if (drifted.length < sampleLimit) {
        drifted.push({
          target_type: c.target_type, target_id: c.target_id, client_id: c.client_id,
          persisted: { state: c.persisted.state, reason: c.persisted.reason, as_of: c.persisted.as_of },
          derived: { state: derivedState, reason: derivedReason }
        });
      }
    }
  }
  const marks = await client.query(
    `select count(*)::int as n, min(marked_at) as oldest
       from convergence_marks where firm_id = $1 and ($2::text is null or client_id = $2)`,
    [firmId, clientId]
  ).catch(softFailMissingRelation);
  const driftCount = Object.values(byReason).reduce((a, b) => a + b, 0);
  return {
    firm_id: firmId,
    client_id: clientId,
    rows_checked: computed.length,
    transactions_checked: txIds.length,
    documents_checked: docIds.length,
    persisted: persistedCounts,
    never_derived: neverDerived,
    drift_count: driftCount,
    drift_by_transition: byReason,
    drifted_sample: drifted,
    unsettled_marks: Number(marks.rows?.[0]?.n || 0),
    oldest_unsettled_mark_at: marks.rows?.[0]?.oldest || null,
    converged: driftCount === 0 && Number(marks.rows?.[0]?.n || 0) === 0
  };
};
