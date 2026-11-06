// Donna Loops — Phase 2.2 feed-chat proposal shadow wiring (apply-time).
//
// When the operator applies a feed-chat action, mirror it as the durable
// Operator-Contract artifacts — a ProposalCard (+ a deterministic preflight
// CheckReport) and its ApplyReceipt — via proposalStore. This is the first wiring
// of the Phase 2 tables into a live flow, and it is SHADOW-only:
//   - gated by LOOPS_SHADOW (default OFF — a no-op when unset)
//   - run in its OWN transaction on its OWN connection (withFirmDbClient, injected),
//     AFTER the apply has already committed, no-throw BY CONTRACT: a shadow failure
//     can never affect the apply or its response
//   - table-presence guarded (a 033-but-not-034 deploy is a no-op)
//
// The mapper consumes the ALREADY-SANITIZED action — feedChat.__sanitizeFeedChatActions
// dropped any out-of-context transaction id before the firm ever saw the proposal —
// so an untrusted/hallucinated target id can never reach a persisted card (INV-12,
// the untrusted-content beachhead). The receipt's model id is read from the
// generation message (rail #2: the model id is the receipt), never fabricated.

import { runDeterministicPreflight, classifyRemediation } from './preflight.js';
import { persistProposalCard, persistApplyReceipt } from './proposalStore.js';
import { proposalLoopsTablesPresent } from './caseManager.js';
import { isLoopsShadowEnabled } from './loopsShadowProducers.js';
import { findMutationEntry } from './accountingMutationRegistry.js';
import { buildAccountingDiff, toApplyReceiptFields } from './accountingDiff.js';
import { classifyAuthorityEnvelope, AUTHORITY_ENVELOPE_CHECK_STATUS } from './authorityEnvelope.js';
import { summarizeCheckReport } from './operatorContract.js';
import { clientFlagObserves } from './clientConfig.js';
import { resolveCodingPolicy } from './codingPolicy.js';
import { buildMemoryPacket, selfReportFromAction } from './memoryPacket.js';

// ─── Slice F — per-client config-stage gate for the shadow riskContext enrichment ──────────
//
// The shadow capture is globally gated by LOOPS_SHADOW; this flag decides, PER CLIENT, whether
// that capture is ENRICHED with the Slice-C/F/G riskContext (materiality band, first-use account,
// duplicate risk, the rendered match verdict) — so an operator can turn the enrichment on /
// observe per client through the config plane (client_capability_config, migration 042) instead
// of an all-or-nothing env switch. It is OBSERVE-only: the enrichment reads feed a SHADOW receipt
// and never touch live state, so it gates on stageObserves (shadow / canary / auto enrich;
// off / dry_run do not) — NOT stageActs, which would footgun the natural `shadow` choice into
// disabling the very observation it names. The reader (api.loadShadowCaseSnapshotWithRiskContext)
// resolves the client's config snapshot on the shared shadow connection and consults this gate
// before doing the four enrichment reads.
export const SHADOW_RISK_CONTEXT_FLAG_KEY = 'LOOPS_SHADOW_RISK_CONTEXT';

// Pure: given the per-client config snapshot, should the shadow capture do the riskContext
// enrichment reads for this client? Default (no row) is true via the env fallback — the
// enrichment ran unconditionally before this gate, so the gate is DORMANT (byte-identical) until
// an operator explicitly stages a client off / dry_run. A force-disable kills it for every client.
export const shadowRiskContextObserves = ({ snapshot = null, env = process.env } = {}) =>
  clientFlagObserves({ flagKey: SHADOW_RISK_CONTEXT_FLAG_KEY, snapshot, envFallback: () => true, env });

// The EXISTING named writer each verb routes through (INV-1: the grammar is a
// router onto the current writers, never a second accounting backend).
const VERB_WRITER = {
  apply_category: 'updateTransactionReviewItemInDb',
  sync_to_accounting: 'postLedgerTransactionInDb',
  ask_client: 'createClientEvidenceRequestInDb',
  mark_evidence_owed: 'setTransactionAiEvidenceRequiredInDb',
  leave_review_note: 'updateTransactionReviewItemInDb',
  remember_merchant: 'saveMerchantRuleForPayload',
  remember_fact: 'saveFirmFact',
  forget_fact: 'dismissFirmFact',
  retire_rule: 'updateClientRuleStatusInDb',
  retry_parse: 'retryParseRunsInDb'
};

// Reversibility (plan §3.2). Null for the verbs that touch workflow/memory rather
// than posted accounting state (ask / remember / retry).
const VERB_REVERSIBILITY = {
  apply_category: 'recode_before_posting',
  sync_to_accounting: 'irreversible_external',
  leave_review_note: 'reversible_via_adjustment',
  mark_evidence_owed: 'reversible_via_adjustment'
};

// Triage source (OPERATOR_INTENTS). The triage receipt rides the reply; the action
// alone doesn't carry it, so derive it deterministically from the verb.
const VERB_TRIAGE = {
  apply_category: 'state_correction',
  sync_to_accounting: 'state_correction',
  leave_review_note: 'state_correction',
  mark_evidence_owed: 'state_correction',
  ask_client: 'question',
  remember_merchant: 'memory_candidate',
  remember_fact: 'memory_candidate',
  forget_fact: 'memory_candidate',
  retire_rule: 'memory_candidate',
  retry_parse: 'diagnostic'
};

// Type-specific fields lifted into the card's open `detail` (the envelope stays
// closed; the verb payload lives here).
const DETAIL_KEYS = [
  'account_name', 'account_code', 'tax_treatment', 'contact_name', 'reason',
  'question', 'merchant_name', 'fact_text', 'evidence_owed', 'fact_id', 'rule_id', 'match_pairs'
];

// Deterministic, message-anchored id so a re-apply maps to the same card (the
// apply route's idempotent-replay guard means this normally runs once).
const proposalIdFor = ({ messageId, actionIndex }) => `prop-${messageId}-${actionIndex}`;

// Pod-safety #2 — only well-formed before/after rows reach a card: the contract
// requires target + before AND after objects; a malformed row is dropped, never a
// validation crash that would cost the whole receipt. Shared by every apply hook
// (feed / transaction / document chat) so the filter can't drift per surface.
export const sanitizeBeforeAfterRows = (beforeAfter) =>
  (Array.isArray(beforeAfter) ? beforeAfter : []).filter(
    (row) => row && typeof row.target === 'string'
      && row.before && typeof row.before === 'object'
      && row.after && typeof row.after === 'object'
  );

// Map a sanitized feed-chat action → a contract-valid ProposalCard. `checks` is
// attached by the caller after preflight runs (null here = preflight not yet run).
// Some feed verbs target an OBJECT rather than a row set — their card targets
// that object instead (the PR-8 document-object pattern: proposal_targets
// .object_type is free text, so the store carries it as-is). The
// memory-correction verbs (G1c) target a FACT or RULE; the ask-lifecycle verbs
// (G1b) target the owner ASK itself, which is the object whose state they
// change — carding them against the anchored transaction would attribute an
// ask's cancellation to a row that may carry several asks.
//
// Name kept from G1c (the memory verbs were the first non-row objects) — the
// resolver is the general one.
export const feedChatMemoryObjectTarget = (action = {}) => {
  if (action?.type === 'forget_fact' && action.fact_id) {
    return { objectType: 'firm_fact', target: String(action.fact_id) };
  }
  if (action?.type === 'retire_rule' && action.rule_id) {
    return { objectType: 'client_rule', target: String(action.rule_id) };
  }
  if ((action?.type === 'cancel_ask' || action?.type === 'resend_ask') && action.ask_id) {
    return { objectType: 'client_evidence_request', target: String(action.ask_id) };
  }
  return null;
};

export const mapFeedChatActionToProposalCard = ({ action = {}, actionIndex, messageId, checks = null } = {}) => {
  const memoryObject = feedChatMemoryObjectTarget(action);
  const targets = memoryObject
    ? [memoryObject.target]
    : [...new Set((Array.isArray(action.transaction_ids) ? action.transaction_ids : []).map(String))];
  const warnings = [];
  if (action.dropped_transaction_ids) {
    warnings.push(`${action.dropped_transaction_ids} out-of-context target id(s) dropped before apply`);
  }
  if (Array.isArray(action.excluded_conflicting_transaction_ids) && action.excluded_conflicting_transaction_ids.length) {
    warnings.push(`${action.excluded_conflicting_transaction_ids.length} conflicting row(s) excluded by the sanitizer`);
  }
  // capture_timing marks these as APPLY-time reconstructions, not generation-time
  // proposals: by the time this hook runs the action was already applied, so the row
  // is a receipt of the existing apply path — not the original card a human reviewed.
  // Generation-time capture (Phase 3) will write the same shape WITHOUT this marker.
  const detail = { capture_timing: 'apply_time_shadow' };
  for (const key of DETAIL_KEYS) if (action[key] != null) detail[key] = action[key];

  return {
    proposal_id: proposalIdFor({ messageId, actionIndex }),
    type: String(action.type),
    triage_source: VERB_TRIAGE[action.type] || 'state_correction',
    plan_id: null,
    targets,
    blast_radius: {
      // A memory-object card's target is a fact/rule, not a row set.
      transactions: memoryObject ? 0 : targets.length,
      documents: 0,
      decided_rows: 0,
      client_visible: action.type === 'ask_client',
      unattended_future_behavior: false
    },
    writer: VERB_WRITER[action.type] || null,
    reversibility: VERB_REVERSIBILITY[action.type] ?? null,
    before_after: [],
    before_after_total: 0,
    checks,
    preconditions: [],
    review_mode: 'operator_one_click',
    detail,
    warnings
  };
};

// Map the apply outcome → a contract-valid ApplyReceipt. The per-target outcome
// is the writer's real per-row result; the self-reported telemetry arrays are
// empty (feed-chat apply doesn't surface them) — and they would be telemetry-only
// anyway (INV-3, never gated).
export const mapFeedChatOutcomeToApplyReceipt = ({
  proposalId, action = {}, outcome = {}, model = null, promptVersion = null, operatorWords = null, checks = null,
  factsAvailable = null, legacyUnionReceipt = false
} = {}) => {
  const results = Array.isArray(outcome?.result?.results) ? outcome.result.results : [];
  const memoryObject = feedChatMemoryObjectTarget(action);
  const perTarget = results.length
    ? results.map((r) => ({
        target: String(r.transaction_id),
        applied: Boolean(r.applied),
        error: r.applied ? null : (r.error || 'apply_failed')
      }))
    // A memory-correction apply (G1c) has no per-row results — its single
    // fact/rule target is the receipt's honest per_target row.
    : (memoryObject
        ? [{
            target: memoryObject.target,
            applied: (outcome?.result?.applied || 0) > 0,
            error: (outcome?.result?.applied || 0) > 0 ? null : (outcome?.result?.skipped_reason || 'apply_failed')
          }]
        : []);
  // Slice H (feed leg) — the deferred "per-target packet shape" decision,
  // resolved as: BATCH-level, no per-target split. The feed prompt is ONE
  // context for the whole turn (one known_facts list), so the honest record
  // is one packet at the prompt's own granularity — a per-target attribution
  // would be fabricated (#497). factsAvailable is the mint-time
  // payload.facts_available stamp (what the prompt actually carried, threaded
  // by the caller — never re-retrieved here); the action's facts_used/
  // facts_conflicted self-report is sanitized against it (ids ∩ available).
  // No stamp (pre-slice message / factless prompt) ⇒ null packet ⇒ bare [].
  const memoryPacket = buildMemoryPacket({
    facts: Array.isArray(factsAvailable) ? factsAvailable : null,
    selfReport: selfReportFromAction(action)
  });
  // G0.1 (build-spec PR-5): a legacy pre-bundle firm message's packet is a
  // CROSS-VENTURE UNION, not the apply venture's own bundle — record that
  // honestly as a WARNING check on the receipt (the contract's CheckReport
  // is the consequence-diff's warning lane; the closed ApplyReceipt
  // envelope needs no new field). summarizeCheckReport re-rolls the
  // report status so the warning is visible at the rollup, never buried.
  const receiptChecks = legacyUnionReceipt
    ? summarizeCheckReport([
        ...(Array.isArray(checks?.checks) ? checks.checks : []),
        {
          name: 'legacy_union_receipt',
          status: 'warning',
          detail: 'facts_available is a pre-G0.1 cross-venture union stamp, not this venture\'s own bundle'
        }
      ])
    : checks;
  return {
    proposal_id: proposalId,
    model: model || 'unknown',
    prompt_version: promptVersion ?? null,
    context_snapshot_id: null,
    candidate_ids_seen: perTarget.map((p) => p.target),
    candidate_ids_rejected: [],
    facts_available: memoryPacket ? memoryPacket.facts_available : [],
    facts_used: memoryPacket ? memoryPacket.facts_used : [],
    facts_conflicted: memoryPacket ? memoryPacket.facts_conflicted : [],
    examples_available: [],
    examples_used: [],
    playbooks_used: [],
    policies_used: [],
    checks: receiptChecks,
    final_writer: VERB_WRITER[action.type] || null,
    audit_event_ids: [],
    rows_touched: perTarget.filter((p) => p.applied).map((p) => p.target),
    per_target: perTarget,
    operator_words: operatorWords ?? (action.reason || null)
  };
};

// Warn at most once per process when the flag is ON but the Phase 2 tables are
// missing (a 033-but-not-034 deploy). The presence guard keeps mixed deploys safe,
// but a SILENT forever-skip would hide a real misconfiguration — so surface it once.
let warnedMissingProposalTables = false;

// The apply-time hook. `withClient` is injected (= withFirmDbClient) so this module
// stays firmDb-free and unit-testable. Returns { proposal_id } or null (no-op /
// swallowed error).
export const onFeedChatActionApplied = async ({
  firmId, clientId, action, actionIndex, messageId,
  model = null, promptVersion = null, outcome, operatorWords = null,
  factsAvailable = null, legacyUnionReceipt = false, withClient
} = {}) => {
  if (!isLoopsShadowEnabled()) return null;
  if (!firmId || !clientId || !action || messageId == null || actionIndex == null || !outcome) return null;
  if (typeof withClient !== 'function') return null;
  try {
    return await withClient(async (client) => {
      if (!(await proposalLoopsTablesPresent(client))) {
        if (!warnedMissingProposalTables) {
          warnedMissingProposalTables = true;
          console.warn('[loops-shadow] LOOPS_SHADOW=on but the Phase 2 tables (migration 034) are absent — apply-time capture is skipped until db:migrate runs');
        }
        return null;
      }
      await client.query('begin');
      try {
        const targetStates = {};
        for (const r of (Array.isArray(outcome?.result?.results) ? outcome.result.results : [])) {
          targetStates[String(r.transaction_id)] = { applied: Boolean(r.applied) };
        }
        const baseCard = mapFeedChatActionToProposalCard({ action, actionIndex, messageId });
        const checks = runDeterministicPreflight({ card: baseCard, targetStates });
        // Pod-safety #2 (feed-chat leg): the batch dispatcher returns the writer-
        // captured pairs as outcome.before_after (sibling of result — never on the
        // persisted per-row receipt). Lift the well-formed rows onto the card so the
        // reverse executor can plan from feed-chat mass applies too.
        const beforeAfterRows = sanitizeBeforeAfterRows(outcome?.before_after);
        const card = {
          ...baseCard,
          checks,
          ...(beforeAfterRows.length
            ? { before_after: beforeAfterRows, before_after_total: beforeAfterRows.length }
            : {})
        };
        const words = operatorWords ?? (action.reason || null);
        // Memory-correction verbs (G1c) card their FACT/RULE object; every
        // other feed verb keeps the transaction-object card unchanged.
        const memoryObject = feedChatMemoryObjectTarget(action);
        await persistProposalCard({
          client, firmId, clientId, card, objectType: memoryObject ? memoryObject.objectType : 'transaction',
          modelName: model, promptVersion, operatorWords: words
        });
        const receipt = mapFeedChatOutcomeToApplyReceipt({
          proposalId: card.proposal_id, action, outcome, model, promptVersion, operatorWords: words, checks,
          factsAvailable, legacyUnionReceipt
        });
        await persistApplyReceipt({ client, firmId, clientId, receipt });
        await client.query('commit');
        return { proposal_id: card.proposal_id };
      } catch (error) {
        try { await client.query('rollback'); } catch { /* best-effort */ }
        throw error;
      }
    });
  } catch (error) {
    try {
      // Observable but ids/verb only — never raw client/document text (INV-12).
      console.warn(
        '[loops-shadow] feed-chat apply hook swallowed error '
        + `(firm=${firmId} client=${clientId} msg=${messageId} action#${actionIndex} type=${action?.type ?? '?'}): `
        + `${error?.message || error}`
      );
    } catch { /* never throw from the logger */ }
    return null;
  }
};

// ─── Slice F — generalize the apply-time shadow wiring to the other chat surfaces ──
//
// Accounting Runtime Hardening, Slice F (the FIRST live-wiring slice). The feed-chat
// hook above was the "first wiring"; this section GENERALIZES it to the transaction-
// chat and document-chat apply paths so all three surfaces emit the same durable
// Operator-Contract triple — ProposalCard + CheckReport + ApplyReceipt — in shadow,
// now assembling this session's earlier slices end to end:
//   Slice A registry  → verb→writer / reversibility / triage (the ONE verified map,
//                        never a per-surface copy)
//   Slice D preflight → runDeterministicPreflight({ riskFlags, matchVerdict })
//   Slice E diff      → buildAccountingDiff → toApplyReceiptFields → the EXISTING
//                        apply_receipts home (no new table, no second receipt type)
//
// SAME safety contract as the feed-chat hook: LOOPS_SHADOW-gated (no-op when unset),
// own connection, post-commit, no-throw BY CONTRACT, table-presence guarded. It does
// NOT edit anything inside the live apply transaction — it reconstructs the artifacts
// AFTER the apply has already committed.
//
// The Slice-C reasoning inputs (riskFlags / matchVerdict / convergence) are OPTIONAL
// and PRE-COMPUTED by the caller — the established "caller fetches the state, passes
// it in" contract that preflight.js follows. Omitted ⇒ those checks simply don't emit
// (shadow-safe, the documented boundary in preflight.js). The first cut passes them
// null with a visible `riskcontext_not_wired_v1` caveat; supplying the snapshot-derived
// riskContext is the named immediate fast-follow (the Slice-C seam this slice opens).

// triage_source (OPERATOR_INTENTS) derived from the registry's autonomy class — the
// generalization of the feed-chat VERB_TRIAGE table, so a new verb inherits its triage
// from its registry entry instead of a second hand-written map drifting out of sync.
const TRIAGE_BY_AUTONOMY = Object.freeze({
  accounting: 'state_correction',
  owner_ask: 'question',
  memory: 'memory_candidate',
  remedial: 'diagnostic',
  workflow: 'state_correction'
});

const triageForVerb = (verb) => {
  const entry = findMutationEntry(verb);
  return (entry && TRIAGE_BY_AUTONOMY[entry.autonomyClass]) || 'state_correction';
};

// Map a single-target chat-apply action (transaction-chat / document-chat) → a
// contract-valid ProposalCard, driven by the Slice-A registry so the writer +
// reversibility routing is the ONE verified map (INV-1), never re-derived per surface.
// Like the feed-chat mapper this is an APPLY-TIME reconstruction (capture_timing) — the
// row receipts the existing apply path, it is not the card a human reviewed pre-apply.
export const mapChatApplyActionToProposalCard = ({
  surface, action = {}, actionIndex, messageId,
  targets = [], documents = 0, clientVisible = false, detail = {}, checks = null
} = {}) => {
  const verb = String(action.type);
  const entry = findMutationEntry(verb);
  const normTargets = [...new Set(targets.map(String))];
  return {
    proposal_id: `prop-${surface}-${messageId}-${actionIndex}`,
    type: verb,
    triage_source: triageForVerb(verb),
    plan_id: null,
    targets: normTargets,
    blast_radius: {
      transactions: normTargets.length,
      documents,
      decided_rows: 0,
      client_visible: clientVisible,
      unattended_future_behavior: false
    },
    writer: entry?.writer || null,
    reversibility: entry?.reversibility ?? null,
    before_after: [],
    before_after_total: 0,
    checks,
    preconditions: [],
    review_mode: 'operator_one_click',
    detail: { capture_timing: 'apply_time_shadow', surface, ...detail },
    warnings: []
  };
};

// Assemble + persist the shadow artifacts for a single-target chat apply, wiring
// Slice D → Slice E. All DB work is on the injected `client`; all reasoning inputs are
// pre-computed and passed in. The apply route returns early on writer failure, so the
// hook fires only on success → the single target is `applied: true`. beforeAfter
// (pod-safety #2) is the writer-captured pre/post state of exactly the fields the
// write mutated — [{target, before, after}] per the contract's BEFORE_AFTER_SCHEMA.
// Callers that don't capture it yet pass nothing and the card keeps the honest
// empty array; buildAccountingDiff surfaces the write from per_target regardless,
// so the receipt never hides the mutation.
// Shadow receipts use the same explicit policy as generation and live Apply.
// A shadow failure remains a failed check in the receipt, never an SG default.
const loadTaxGateContextForShadow = async (client, firmId, clientId) => {
  try {
    const res = await client.query(
      'select jurisdiction, entity_type, profile from clients where firm_id = $1 and id = $2 limit 1',
      [firmId, clientId]
    );
    const row = res.rows[0] || {};
    const codingPolicy = resolveCodingPolicy({ jurisdiction: row.jurisdiction, profileJurisdiction: row.profile?.jurisdiction, entityType: row.entity_type || row.profile?.entityType });
    return { jurisdiction: codingPolicy.jurisdiction, codingPolicy };
  } catch (error) {
    return { jurisdiction: null, policyError: { code: error.code || 'coding_policy_unavailable' } };
  }
};

const persistChatApplyShadow = async ({
  client, firmId, clientId, objectType, baseCard, appliedTargets,
  model = null, promptVersion = null, operatorWords = null,
  riskFlags = null, matchVerdict = null, convergenceBefore = null, convergenceAfter = null,
  beforeAfter = null, memoryPacket = null, playbooksUsed = null
}) => {
  const targetStates = {};
  for (const t of appliedTargets) targetStates[String(t)] = { applied: true };
  // Tax-code ↔ jurisdiction gate: only fetch the jurisdiction + coder-routing
  // state when the card carries a tax code (otherwise the check is undecidable
  // regardless).
  const taxContext = baseCard?.detail?.tax_treatment != null
    ? await loadTaxGateContextForShadow(client, firmId, clientId)
    : {};
  const checks = runDeterministicPreflight({ card: baseCard, targetStates, riskFlags, matchVerdict, ...taxContext });
  const beforeAfterRows = sanitizeBeforeAfterRows(beforeAfter);
  const card = {
    ...baseCard,
    checks,
    ...(beforeAfterRows.length
      ? { before_after: beforeAfterRows, before_after_total: beforeAfterRows.length }
      : {})
  };
  await persistProposalCard({
    client, firmId, clientId, card, objectType,
    modelName: model, promptVersion, operatorWords
  });
  const perTarget = appliedTargets.map((t) => ({ target: String(t), applied: true, error: null }));
  const diff = buildAccountingDiff({
    card, checkReport: checks, perTarget,
    convergenceBefore, convergenceAfter, remediation: classifyRemediation(riskFlags)
  });
  // Slice G: classify THIS apply's authority disposition from the Slice-E commit verdict and
  // record it on the receipt's check report — the classifier's first LIVE (shadow) consumer.
  // coveringGrant is null on the chat-apply path (a chat correction is not a reconciliation
  // match — grant-backed material auto-commit is the matcher's domain), so the classification is
  // the diff's own two-terminal resolution: pass/warning → auto_reconcile, a non-authority hold or
  // fail → escalate_to_owner / blocked, a first-use account never auto-reconciles. configStage is
  // 'shadow' here (classify-only, never acts — the live act path is the matcher, greenlight-gated).
  // Appended (non-mutating) to the receipt's checks (status via AUTHORITY_ENVELOPE_CHECK_STATUS).
  // It USUALLY mirrors the base report's worst status — EXCEPT the two-terminal-states hold: a
  // clean-checks apply that would leave the row hanging (Slice-E `would_leave_row_hanging`) now
  // classifies escalate_to_owner → requires_review, deliberately lifting an otherwise all-pass
  // report so the firm-side-limbo violation surfaces instead of reading as a clean auto-commit.
  const firstUseAccountInvolved = riskFlags?.flags?.first_use_account?.status === 'flagged';
  const envelope = classifyAuthorityEnvelope({
    commit: diff.commit, coveringGrant: null, configStage: 'shadow', firstUseAccountInvolved
  });
  const authorityCheck = {
    name: 'authority_envelope',
    status: AUTHORITY_ENVELOPE_CHECK_STATUS[envelope.envelope] || 'requires_review',
    detail: `${envelope.envelope}${envelope.terminal_target ? `→${envelope.terminal_target}` : ''}: ${envelope.reason}`
  };
  // Re-summarise so the receipt's rolled-up status reflects the appended authority
  // check — a spread would keep the base status and hide a requires_review/fail the
  // envelope just added (e.g. the two-terminal-states hold on an otherwise all-pass
  // report). worst-of, same discipline as the base report.
  const receiptChecks = checks
    ? summarizeCheckReport([...(Array.isArray(checks.checks) ? checks.checks : []), authorityCheck])
    : checks;
  const receipt = {
    proposal_id: card.proposal_id,
    model: model || 'unknown',
    prompt_version: promptVersion ?? null,
    context_snapshot_id: null,
    candidate_ids_seen: appliedTargets.map(String),
    candidate_ids_rejected: [],
    // Slice H (memory packet v1): the pure-built {facts_available, facts_used,
    // facts_conflicted} overlays the bare defaults when the caller loaded the
    // case's facts (null packet ⇒ fields stay [] — "no memory recorded", which a
    // governance reader can tell apart from a recorded-empty [] only via the
    // packet's presence upstream; the receipt schema is unchanged either way).
    facts_available: [], facts_used: [], facts_conflicted: [],
    ...(memoryPacket || {}),
    examples_available: [], examples_used: [],
    // Slice I: the playbooks the runtime INJECTED into the prompt that minted
    // this proposal — rendered from the message's persisted mint-time stamp
    // (payload.playbooks_injected), not a model self-report. null (no stamp:
    // gate off, no match, pre-slice message, doc-/feed-chat surface) keeps the
    // bare [] — same absent-vs-recorded discipline as the memory packet.
    playbooks_used: Array.isArray(playbooksUsed) ? playbooksUsed : [],
    policies_used: [],
    audit_event_ids: [],
    operator_words: operatorWords ?? null,
    // Slice-E projection fills checks / final_writer / rows_touched / per_target; the receipt's
    // check report carries the appended Slice-G authority_envelope check.
    ...toApplyReceiptFields(diff, { checkReport: receiptChecks })
  };
  await persistApplyReceipt({ client, firmId, clientId, receipt });
  return { proposal_id: card.proposal_id };
};

// Surface-agnostic no-throw wrapper: own transaction on the injected connection,
// table-presence guarded, errors swallowed (ids/verb only in the log — INV-12).
let warnedMissingTablesGeneralized = false;
const runChatApplyShadowCapture = async ({
  firmId, clientId, withClient, objectType, baseCard, appliedTargets,
  model, promptVersion, operatorWords, riskFlags = null, matchVerdict = null,
  convergenceBefore = null, convergenceAfter = null, beforeAfter = null,
  memoryPacket = null, playbooksUsed = null, logContext
}) => {
  try {
    return await withClient(async (client) => {
      if (!(await proposalLoopsTablesPresent(client))) {
        if (!warnedMissingTablesGeneralized) {
          warnedMissingTablesGeneralized = true;
          console.warn('[loops-shadow] LOOPS_SHADOW=on but the Phase 2 tables (migration 034) are absent — chat-apply capture is skipped until db:migrate runs');
        }
        return null;
      }
      await client.query('begin');
      try {
        const result = await persistChatApplyShadow({
          client, firmId, clientId, objectType, baseCard, appliedTargets,
          model, promptVersion, operatorWords, riskFlags, matchVerdict,
          convergenceBefore, convergenceAfter, beforeAfter, memoryPacket, playbooksUsed
        });
        await client.query('commit');
        return result;
      } catch (error) {
        try { await client.query('rollback'); } catch { /* best-effort */ }
        throw error;
      }
    });
  } catch (error) {
    try { console.warn(`[loops-shadow] ${logContext} swallowed error: ${error?.message || error}`); } catch { /* never throw from the logger */ }
    return null;
  }
};

// Resolve the Slice-C/G signal (risk flags + convergence + the rendered match verdict)
// from an injected snapshot loader. Called ONLY after the shadow gate (so no read happens
// when shadow is off), and best-effort: a snapshot failure degrades to the deterministic-only
// checks — it never loses the receipt. Explicitly-passed inputs (the unit tests) win over the
// load. The Slice-G loader attaches `match_verdict` (the persisted reconciliation authorization,
// RENDERED via renderAuthorityEnvelopeFromAuthorization → preflight's match_reconciles check);
// absent ⇒ no match check, exactly as before.
const resolveSnapshotSignal = async ({ loadCaseSnapshot, riskFlags, matchVerdict = null, convergenceAfter, memoryFacts = null, playbooksInjected = null }) => {
  if (riskFlags != null || typeof loadCaseSnapshot !== 'function') {
    return { riskFlags, matchVerdict, convergenceAfter, memoryFacts, playbooksInjected };
  }
  try {
    const snap = await loadCaseSnapshot();
    return {
      riskFlags: snap?.risk_flags ?? null,
      matchVerdict: matchVerdict ?? snap?.match_verdict ?? null,
      convergenceAfter: convergenceAfter ?? snap?.convergence ?? null,
      // Slice H: the loader attaches the case's retrieved fact rows (or null when
      // the gate was off / the read could not answer) — same additive seam as
      // match_verdict, so the memory packet needs no per-call-site edit.
      memoryFacts: memoryFacts ?? snap?.memory_facts ?? null,
      // Slice I: the mint-time playbook stamp (payload.playbooks_injected on the
      // persisted assistant message, already sanitized to ids by the loader) —
      // RENDERED onto the receipt's playbooks_used, never re-derived here. null
      // (no stamp) keeps the receipt's bare [].
      playbooksInjected: playbooksInjected ?? snap?.playbooks_injected ?? null
    };
  } catch {
    return { riskFlags: null, matchVerdict, convergenceAfter, memoryFacts, playbooksInjected };
  }
};

// Transaction-chat apply hook. Mirrors onFeedChatActionApplied: post-commit, no-throw,
// shadow-gated. The thread key (transactionId) is the single target. `withClient` is
// injected (= withFirmDbClient) so this module stays firmDb-free and unit-testable.
// `loadCaseSnapshot` (optional) is a thunk returning a getOperatorCaseSnapshot result
// with `risk_flags`/`convergence` — invoked only inside the shadow gate.
export const onTransactionChatActionApplied = async ({
  firmId, clientId, transactionId, action, actionIndex, messageId,
  model = null, promptVersion = null, operatorWords = null,
  riskFlags = null, matchVerdict = null, convergenceBefore = null, convergenceAfter = null,
  beforeAfter = null, memoryFacts = null, loadCaseSnapshot = null, withClient
} = {}) => {
  if (!isLoopsShadowEnabled()) return null;
  if (!firmId || !clientId || !transactionId || !action || messageId == null || actionIndex == null) return null;
  if (typeof withClient !== 'function') return null;
  const signal = await resolveSnapshotSignal({ loadCaseSnapshot, riskFlags, matchVerdict, convergenceAfter, memoryFacts });
  const groupTargets = action.type === 'resolve_match_group'
    ? [...new Set((Array.isArray(action.match_pairs) ? action.match_pairs : [])
        .map((pair) => pair?.transaction_id)
        .filter(Boolean)
        .map(String))]
    : [];
  const appliedTargets = groupTargets.length ? groupTargets : [transactionId];
  const detail = {};
  for (const key of DETAIL_KEYS) if (action[key] != null) detail[key] = action[key];
  const baseCard = mapChatApplyActionToProposalCard({
    surface: 'transaction_chat', action, actionIndex, messageId,
    targets: appliedTargets, clientVisible: action.type === 'ask_client', detail
  });
  return runChatApplyShadowCapture({
    firmId, clientId, withClient, objectType: 'transaction', baseCard,
    appliedTargets, model, promptVersion,
    operatorWords: operatorWords ?? (action.reason || null),
    riskFlags: signal.riskFlags, matchVerdict: signal.matchVerdict, convergenceBefore, convergenceAfter: signal.convergenceAfter,
    beforeAfter,
    // Slice H: pure set-arithmetic on fact ids — loaded facts + the action's
    // (future-contract) self-report; null when nothing was loaded.
    memoryPacket: buildMemoryPacket({ facts: signal.memoryFacts, selfReport: selfReportFromAction(action) }),
    // Slice I: the mint-time playbook stamp, threaded via the same loader seam.
    playbooksUsed: signal.playbooksInjected,
    logContext: `transaction-chat apply hook (firm=${firmId} client=${clientId} txn=${transactionId} msg=${messageId} action#${actionIndex} type=${action?.type ?? '?'})`
  });
};

// Document-chat apply hook (link_transaction is the only wired verb today). The bank
// transaction being linked is the single target; the focus document rides in `detail`
// and as a blast_radius document. matchVerdict, when the caller read the persisted
// reconciliation verdict, is RENDERED by preflight (never re-checked). beforeAfter
// (pod-safety #2) is the match writer's captured pre/post state, same contract as the
// transaction-chat hook.
// `transactionId` is OPTIONAL since G1(a) (godmode build-spec PR-8): the
// link_transaction verb targets the transaction it links (objectType
// 'transaction', the original shape), while the doc-only verbs
// (draft_evidence_request / leave_review_note / mark_immaterial) have no
// bank line — their card targets the DOCUMENT itself (objectType
// 'document'; proposal_targets.object_type is free text, so the store
// carries it as-is).
export const onDocumentChatActionApplied = async ({
  firmId, clientId, documentId, transactionId = null, action, actionIndex, messageId,
  model = null, promptVersion = null, operatorWords = null,
  riskFlags = null, matchVerdict = null, convergenceAfter = null,
  beforeAfter = null, memoryFacts = null, loadCaseSnapshot = null, withClient
} = {}) => {
  if (!isLoopsShadowEnabled()) return null;
  if (!firmId || !clientId || !documentId || !action || messageId == null || actionIndex == null) return null;
  if (typeof withClient !== 'function') return null;
  const signal = await resolveSnapshotSignal({ loadCaseSnapshot, riskFlags, matchVerdict, convergenceAfter, memoryFacts });
  const detail = { document_id: String(documentId) };
  for (const key of DETAIL_KEYS) if (action[key] != null) detail[key] = action[key];
  const objectType = transactionId ? 'transaction' : 'document';
  const targetId = transactionId || documentId;
  const baseCard = mapChatApplyActionToProposalCard({
    surface: 'document_chat', action, actionIndex, messageId,
    targets: [targetId], documents: 1, detail
  });
  return runChatApplyShadowCapture({
    firmId, clientId, withClient, objectType, baseCard,
    appliedTargets: [targetId], model, promptVersion,
    operatorWords: operatorWords ?? (action.reason || null),
    riskFlags: signal.riskFlags, matchVerdict: signal.matchVerdict, convergenceAfter: signal.convergenceAfter,
    beforeAfter,
    memoryPacket: buildMemoryPacket({ facts: signal.memoryFacts, selfReport: selfReportFromAction(action) }),
    logContext: `document-chat apply hook (firm=${firmId} client=${clientId} doc=${documentId} msg=${messageId} action#${actionIndex} type=${action?.type ?? '?'})`
  });
};
