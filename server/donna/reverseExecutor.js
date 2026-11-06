// Donna — the reverse EXECUTOR planner (pod-safety #2, executor half).
//
// #727 landed the CAPTURE (opt-in before/after on the mutating chat verbs → proposal_cards.
// before_after) and the pure BUILDER (reversePatchFromBeforeAfter: one before_after row →
// the restoring patch + optimistic-concurrency precondition + a needs_ledger_adjustment hint).
// This is the planner that turns "select these N applies, reverse" into a concrete, SAFE plan:
// for each captured target it re-reads the CURRENT row and decides one disposition —
//
//   reverse                 — the row is still where the apply left it; restore the before-state
//                             through the SAME writer (with captureBeforeState, so the reverse is
//                             itself a captured, attributed mutation).
//   stale                   — the row MOVED since the apply being reversed (contract §13 / INV-10
//                             optimistic concurrency). Refuse — reversing would clobber a newer
//                             decision. Never applied.
//   needs_ledger_adjustment — the line POSTED to the ledger (current OR recorded-after
//                             reconciliation_status is terminal). Kari's call: SURFACE + stay
//                             proposed, NEVER silently un-post (the ledger path is on the isolation
//                             list; the correct fix is a dated adjustment journal). Never applied
//                             by this executor — reported for a human to post the adjustment.
//   skip                    — nothing to reverse (malformed/empty before_after, target gone,
//                             or the card's writer isn't one this executor can restore
//                             through — see REVERSE_SUPPORTED_WRITERS).
//
// G2 PR-14 widened the coverage from what an apply POSTED to what it TAUGHT and ASKED:
// the mint legs (firm_fact / client_rule / ask) plan a dismiss / retire / cancel through
// the object's own governed writer, an answered ask refuses, and side effects a reverse
// deliberately does NOT undo (a rule confirmation bump, a merchant-rule cascade) ride the
// entry as `surfaced` rows instead of quietly disappearing.
//
// The executor applies ONLY `reverse` entries. Fail-safe: any ambiguity routes to a
// non-applying disposition, never to a blind write. Pure leaf — imports only reversePatch.js
// (itself DB-free), so it loads in-sandbox under `node --test`. The DB orchestration (loading
// cards, re-reading rows, calling the writer, auditing) lives in firmDb.reverseAppliesInDb and
// passes the re-read current states in.

import {
  reversePatchFromBeforeAfter,
  matchReversePatchFromBeforeAfter,
  memoryMintReversePatchFromBeforeAfter,
  MEMORY_REVERSE_STATUS,
  LEDGER_TERMINAL_RECONCILIATION_STATUSES,
  MATCH_LEDGER_POSTED_STATUSES
} from './reversePatch.js';

// Dispositions the executor will actually WRITE (everything else is reported, not applied).
export const APPLICABLE_REVERSE_DISPOSITIONS = Object.freeze(new Set(['reverse']));

// The writers this executor knows how to restore THROUGH, by leg:
//   - review_item — rows captured by updateTransactionReviewItemInDb; the apply phase
//     restores them through that same writer (coding/status patches).
//   - match — rows captured by the match writers (updateReconciliationMatchInDb /
//     createManualReconciliationMatchInDb, the __matchBeforeAfter shape). BOTH restore
//     through updateReconciliationMatchInDb — the PATCH-path writer the FE uses (INV-1):
//     re-confirm a rejected match, reject a manual link. The row a fresh link INSERTED
//     exists now, so its reverse is a PATCH too; there is no delete verb.
//   - firm_fact / client_rule / ask — G2 PR-14: the MINT legs. A card whose apply
//     TAUGHT something (saveFirmFact, saveMerchantRuleForPayload) or ASKED the owner
//     (createClientEvidenceRequestInDb) carries one capture row per minted object;
//     the restore routes through that object's EXISTING governed retire writer
//     (dismissFirmFact / updateClientRuleStatusInDb+allowActiveRetire /
//     cancelClientEvidenceRequestInDb — INV-1, never a memory mutation of its own).
// A card's rows are shaped for its own writer, so the planner dispatches per-writer and
// fail-closes on anything else: a missing or unknown writer on the card ⇒ every row plans
// to skip (writer_not_supported) — never a blind write through the wrong writer.
export const REVIEW_ITEM_REVERSE_WRITER = 'updateTransactionReviewItemInDb';
export const MATCH_REVERSE_WRITERS = Object.freeze(new Set(['updateReconciliationMatchInDb', 'createManualReconciliationMatchInDb']));
export const FIRM_FACT_MINT_WRITER = 'saveFirmFact';
export const CLIENT_RULE_MINT_WRITER = 'saveMerchantRuleForPayload';
export const ASK_MINT_WRITER = 'createClientEvidenceRequestInDb';
export const MEMORY_MINT_WRITERS = Object.freeze(new Set([FIRM_FACT_MINT_WRITER, CLIENT_RULE_MINT_WRITER, ASK_MINT_WRITER]));
export const REVERSE_SUPPORTED_WRITERS = Object.freeze(new Set([
  REVIEW_ITEM_REVERSE_WRITER, ...MATCH_REVERSE_WRITERS, ...MEMORY_MINT_WRITERS
]));

// The ask-LIFECYCLE writers (G1b): a card that cancelled, amended or resent an ask
// is reported with the reason its reverse is not planned — never a generic
// "writer not supported", and never an automatic re-open. Reopening a cancelled ask
// re-asks the owner, and a resend is OUTBOUND: outbound is never auto-fired by a
// reverse (the marketing rail's rule, applied to the owner channel). These rows
// SURFACE so a founder reading the plan knows the ask moved and can act deliberately.
export const SURFACED_ONLY_WRITER_REASONS = Object.freeze({
  cancelClientEvidenceRequestInDb: 'ask_reopen_not_auto_planned',
  amendClientEvidenceRequestInDb: 'ask_amendment_not_auto_reverted',
  deliverEvidenceAsksOnAllChannels: 'outbound_never_auto_fired'
});

// The kinds whose current row is fetched per leg (the executor's re-read shape).
export const MEMORY_LEG_FOR_WRITER = Object.freeze({
  [FIRM_FACT_MINT_WRITER]: 'firm_fact',
  [CLIENT_RULE_MINT_WRITER]: 'client_rule',
  [ASK_MINT_WRITER]: 'ask'
});

// An ask the OWNER has answered is never clobbered by a reverse: the answer is a
// fact about the business that arrived after the action being reversed, and
// cancelling on top of it would erase the one thing only the owner could give.
export const ANSWERED_ASK_STATUSES = Object.freeze(new Set(['replied', 'resolved']));

// Which restore leg a card's writer belongs to (null = unsupported, fail-closed).
export const reverseLegForWriter = (writer) => {
  const name = String(writer ?? '');
  if (name === REVIEW_ITEM_REVERSE_WRITER) return 'review_item';
  if (MATCH_REVERSE_WRITERS.has(name)) return 'match';
  if (MEMORY_MINT_WRITERS.has(name)) return MEMORY_LEG_FOR_WRITER[name];
  return null;
};

// The current-state lookup key for a captured row. Review-item rows re-read by target
// (the bank transaction id); match rows re-read the MATCH row itself, keyed by the
// captured match_id — the target is the tx, but the row being restored is the match.
export const matchReverseKeyForRow = (row) => {
  const id = row?.after?.match_id ?? row?.before?.match_id ?? null;
  return id == null || id === '' ? null : String(id);
};

// Plan the reverse of ONE before_after row against the target's CURRENT re-read state.
//   row     — { target, before, after } (the captured proposal_cards.before_after entry)
//   current — { present, status, review_state, reconciliation_status } | null|undefined
export const planReverseForRow = ({ row = null, current = null } = {}) => {
  const built = reversePatchFromBeforeAfter(row || {});
  const target = built.target ?? (row && row.target) ?? null;
  if (!built.reversible) {
    return { target, disposition: 'skip', reason: built.reason || 'not_reversible' };
  }
  if (!current || current.present === false) {
    return { target, disposition: 'skip', reason: 'target_missing' };
  }
  // Optimistic concurrency: the row must still be in the AFTER-state the apply left it in.
  // If it moved (status or review_state differs), a newer decision superseded the one being
  // reversed — refuse rather than clobber it.
  const pre = built.preconditions || {};
  if (pre.expected_status != null && String(current.status ?? '') !== String(pre.expected_status)) {
    return { target, disposition: 'stale', reason: 'status_moved', expected: pre.expected_status, actual: current.status ?? null };
  }
  if (pre.expected_review_state != null && String(current.review_state ?? '') !== String(pre.expected_review_state)) {
    return { target, disposition: 'stale', reason: 'review_state_moved', expected: pre.expected_review_state, actual: current.review_state ?? null };
  }
  // Ledger-terminal: either the recorded after (builder hint) OR the CURRENT reconciliation
  // status shows the line posted. The current read wins if it escalated since capture — the
  // hint can only escalate, never clear, this check.
  const currentReconTerminal = LEDGER_TERMINAL_RECONCILIATION_STATUSES.has(String(current.reconciliation_status ?? ''));
  if (built.needs_ledger_adjustment || currentReconTerminal) {
    return {
      target,
      disposition: 'needs_ledger_adjustment',
      reason: 'posted_to_ledger',
      patch: built.patch,
      preconditions: built.preconditions
    };
  }
  return { target, disposition: 'reverse', patch: built.patch, preconditions: built.preconditions };
};

// Plan the reverse of ONE match-writer before_after row (__matchBeforeAfter shape) against
// the MATCH row's re-read current state.
//   row     — { target: bank tx id, before, after } with match_id/match_status on each side
//   current — { present, match_status, reconciliation_status, ledger_posted } | null
// Dispositions mirror the review-item leg, with match-shaped semantics:
//   - the match row must still hold the recorded after status (else stale — a newer
//     decision superseded the one being reversed);
//   - a tx that POSTED to the ledger since ('posted' / a ledger_journal_id on the row)
//     surfaces needs_ledger_adjustment — moving its match would strand the journal
//     (Kari's call: report, never auto-un-post);
//   - the tx reconciliation_status must still be where the apply's cascade left it
//     (else stale — some other pipeline re-decided the line);
//   - a restore whose cascade can't reproduce the recorded before state fail-closes in
//     the pure builder (cascade_cannot_restore → skip).
export const planMatchReverseForRow = ({ row = null, current = null } = {}) => {
  const built = matchReversePatchFromBeforeAfter(row || {});
  const target = built.target ?? (row && row.target) ?? null;
  const matchId = built.match_id ?? null;
  if (!built.reversible) {
    return { target, match_id: matchId, disposition: 'skip', reason: built.reason || 'not_reversible' };
  }
  if (!current || current.present === false) {
    return { target, match_id: matchId, disposition: 'skip', reason: 'target_missing' };
  }
  const pre = built.preconditions || {};
  if (String(current.match_status ?? '') !== String(pre.expected_match_status ?? '')) {
    return { target, match_id: matchId, disposition: 'stale', reason: 'match_status_moved', expected: pre.expected_match_status ?? null, actual: current.match_status ?? null };
  }
  if (MATCH_LEDGER_POSTED_STATUSES.has(String(current.reconciliation_status ?? '')) || current.ledger_posted === true) {
    return { target, match_id: matchId, disposition: 'needs_ledger_adjustment', reason: 'posted_to_ledger', patch: built.patch, preconditions: built.preconditions };
  }
  if (String(current.reconciliation_status ?? '') !== String(pre.expected_reconciliation_status ?? '')) {
    return { target, match_id: matchId, disposition: 'stale', reason: 'reconciliation_status_moved', expected: pre.expected_reconciliation_status ?? null, actual: current.reconciliation_status ?? null };
  }
  return { target, match_id: matchId, disposition: 'reverse', patch: built.patch, preconditions: built.preconditions };
};

// Plan the reverse of ONE memory/ask MINT row (memoryMintBeforeAfterRow shape) against
// the minted object's re-read current state (G2 PR-14).
//   row     — { target: the fact/rule/ask id, before, after } with kind + present + status
//   current — { present, status } | null
// Dispositions, in the four-word vocabulary the other legs speak:
//   - the object still rests where the mint left it → 'reverse' (dismiss / retire / cancel);
//   - it already carries the reverse's own target status → 'skip' (already_reversed —
//     nothing to do, and re-running the writer would be a second tombstone);
//   - an ASK the owner has ANSWERED → 'stale' (ask_answered): refused and surfaced,
//     never clobbered — the owner's answer superseded the action being reversed;
//   - any other status move → 'stale' (optimistic concurrency, same as every leg);
//   - a mint that landed on a PRE-EXISTING object, a vanished object, or a malformed
//     row → 'skip' with the honest reason. Fail-closed by construction.
// No ledger disposition here on purpose: a fact, a rule and an ask post nothing.
export const planMemoryReverseForRow = ({ row = null, current = null } = {}) => {
  const built = memoryMintReversePatchFromBeforeAfter(row || {});
  const target = built.target ?? (row && row.target) ?? null;
  const kind = built.kind ?? null;
  if (!built.reversible) {
    return { target, kind, disposition: 'skip', reason: built.reason || 'not_reversible' };
  }
  if (!current || current.present === false) {
    return { target, kind, disposition: 'skip', reason: 'target_missing' };
  }
  const currentStatus = String(current.status ?? '');
  if (currentStatus === MEMORY_REVERSE_STATUS[kind]) {
    return { target, kind, disposition: 'skip', reason: 'already_reversed' };
  }
  const expected = String(built.preconditions?.expected_status ?? '');
  if (currentStatus !== expected) {
    return {
      target,
      kind,
      disposition: 'stale',
      reason: kind === 'client_evidence_request' && ANSWERED_ASK_STATUSES.has(currentStatus)
        ? 'ask_answered'
        : 'status_moved',
      expected: built.preconditions?.expected_status ?? null,
      actual: current.status ?? null
    };
  }
  return { target, kind, disposition: 'reverse', patch: built.patch, preconditions: built.preconditions };
};

// What a reversed apply TAUGHT that the reverse deliberately does NOT un-teach.
// A rule confirmation bump is EVIDENCE OF A PAST CONFIRM — the operator did confirm
// that coding at that moment, and reversing the coding does not un-happen it. So the
// bump is reported on the entry and never patched (the plan says WHICH review item
// drove it, from PR-13's `last_confirmed_review_item_id` stamp). Same posture as the
// cascade a merchant-rule mint already ran: retiring the rule stops FUTURE matches,
// it does not un-code the rows the cascade already touched — say so, don't pretend.
export const surfacedSideEffectsForRow = (row = null) => {
  const after = row && typeof row.after === 'object' ? row.after : null;
  if (!after) return [];
  const surfaced = [];
  const bump = after.rule_confirmation_bump;
  if (bump && typeof bump === 'object') {
    surfaced.push({
      kind: 'rule_confirmation_bump',
      reversed: false,
      reason: 'a confirmation is evidence of a past confirm — a reverse does not rewrite history',
      rule_id: bump.rule_id ?? null,
      review_item_id: bump.review_item_id ?? null,
      prior_count: bump.prior_count ?? null,
      confirmation_count: bump.confirmation_count ?? null,
      confidence: bump.confidence ?? null
    });
  }
  if (Number(after.cascade_matched || 0) > 0) {
    surfaced.push({
      kind: 'rule_cascade_not_unwound',
      reversed: false,
      reason: 'retiring the rule stops future matches; rows the cascade already coded are reversed on their own cards',
      matched: Number(after.cascade_matched)
    });
  }
  return surfaced;
};

// Plan the reverse of a whole card. `currentByTarget` maps lookup key → the re-read
// current state: review-item cards key by row target (planReverseForRow's shape), match
// cards key by matchReverseKeyForRow (planMatchReverseForRow's shape). Returns the
// per-row entries + a summary breakdown, and echoes the card's writer + leg so the
// apply phase dispatches to the right writer. Writer-aware (fail-closed): a card whose
// `writer` has no leg plans every row to skip — its before_after rows are shaped for a
// writer this executor's apply phase doesn't speak, so applying them would be a blind write.
export const planReverseForCard = ({ card = null, currentByTarget = {} } = {}) => {
  const rows = Array.isArray(card?.before_after) ? card.before_after : [];
  const proposalId = card?.proposal_id ?? card?.id ?? null;
  const writer = card?.writer ?? null;
  // Echoed so the plan says WHICH apply each card was (G2 PR-15 renders a
  // multi-select over these plans; a founder cannot honestly select "an apply"
  // from a writer name alone). Read-only echo of what loadReversibleProposalCards
  // already returns — never computed here.
  const cardMeta = {
    ...(card?.proposal_type != null ? { proposal_type: card.proposal_type } : {}),
    ...(card?.status != null ? { status: card.status } : {}),
    ...(card?.created_at != null ? { created_at: card.created_at } : {})
  };
  const leg = reverseLegForWriter(writer);
  if (!leg) {
    // A NAMED surfaced-only writer reports WHY its reverse isn't planned (an ask
    // re-open is a fresh question to the owner; a resend is outbound). Everything
    // else keeps the generic fail-closed reason.
    const reason = SURFACED_ONLY_WRITER_REASONS[String(writer ?? '')] || 'writer_not_supported';
    const entries = rows.map((row) => ({
      target: row?.target ?? null,
      disposition: 'skip',
      reason,
      writer,
      ...(surfacedSideEffectsForRow(row).length ? { surfaced: surfacedSideEffectsForRow(row) } : {})
    }));
    return { proposal_id: proposalId, ...cardMeta, writer, leg: null, entries, summary: summarizeReversePlan(entries) };
  }
  const entries = rows.map((row) => {
    const entry = (() => {
      if (leg === 'match') {
        const key = matchReverseKeyForRow(row);
        return planMatchReverseForRow({ row, current: key ? currentByTarget[key] ?? null : null });
      }
      if (leg === 'firm_fact' || leg === 'client_rule' || leg === 'ask') {
        return planMemoryReverseForRow({ row, current: currentByTarget[String(row?.target)] ?? null });
      }
      return planReverseForRow({ row, current: currentByTarget[String(row?.target)] ?? null });
    })();
    const surfaced = surfacedSideEffectsForRow(row);
    return surfaced.length ? { ...entry, surfaced } : entry;
  });
  return {
    proposal_id: proposalId,
    ...cardMeta,
    writer,
    leg,
    entries,
    summary: summarizeReversePlan(entries)
  };
};

// `surfaced` counts entries carrying a side effect the reverse deliberately does NOT
// undo (a confirmation bump, a rule cascade). It is a REPORT count, not a fifth
// disposition — every such entry still carries one of the four.
export const summarizeReversePlan = (entries = []) => {
  const summary = { total: 0, reverse: 0, stale: 0, needs_ledger_adjustment: 0, skip: 0, surfaced: 0 };
  for (const e of Array.isArray(entries) ? entries : []) {
    summary.total += 1;
    if (e && e.disposition in summary) summary[e.disposition] += 1;
    if (e && Array.isArray(e.surfaced) && e.surfaced.length) summary.surfaced += 1;
  }
  return summary;
};

// The targets an executor would actually write for a planned card (disposition 'reverse').
export const applicableReverseEntries = (plan) =>
  (plan?.entries || []).filter((e) => APPLICABLE_REVERSE_DISPOSITIONS.has(e?.disposition));
