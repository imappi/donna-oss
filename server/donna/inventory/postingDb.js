// Donna Inventory I4·posting — P5 transaction-aware inventory executor (design §9/§11/§15).
//
// The one place inventory economics become LEDGER FACTS. It never begins/commits at the
// -WithinTransaction layer (the caller owns the txn so the journal insert, the attempt-log
// row, the ApplyReceipt, and the audit share ONE atomic unit — audit-as-precondition, §9
// step 9); the -FromDb wrappers open and close the transaction. Every ledger write routes
// through the ONE gateway (ledgerPostingGateway.js → __writeLedgerJournalRows); this module
// adds the inventory lifecycle AROUND that write (attempt event log, receipt, allocations,
// waiter routing), never a second accounting backend (INV-1).
//
// The §9 execution sequence, inside the caller's transaction:
//   1. Lock the posting key (advisory xact lock over firm+client+operation+kind) — two
//      workers must not build against the same stale state.
//   2. Idempotency re-fetch — a prior SUCCESSFUL attempt at this (operation, kind,
//      basis_version) is a replay: return it, never double-post (the partial-unique index
//      is the DB backstop; this is the fast path).
//   3. Verify input_hash — a valuation basis that moved since the dry-run refuses stale.
//   4. Compare proposal_hash — a stale dry-run proposal refuses.
//   5. Build is done by the PURE builder (posting.js) and handed in as `draft`; the executor
//      re-asserts it (applied? has a journal? balances?).
//   6. Deterministic preflight (journal_balances / period_not_locked) — a fail records a
//      refused/blocked attempt and writes NO journal.
//   7. Write the journal via the gateway (balance + locked-period guards + shared insert).
//   8. Persist the append-only inventory_posting_attempts row (§11) — receipt + audit ids
//      are written FIRST so the single append-only insert carries both (the row is never
//      updated).
//   9. Persist the canonical ApplyReceipt (proposalStore) + the inventory audit event, both
//      in this txn — audit-as-precondition (no record, no post).
//  10. Commit (the -FromDb wrapper).
// dryRun=true runs 1–6 and returns the preview + consequence diff, writing nothing.
//
// Reversal (§5-G) is EXECUTOR-owned: it reverses the PERSISTED ledger journal exactly (not a
// rebuild under today's code), rejects a second reversal, dates into an open period, and
// posts the kernel's downstream delta journals as a journal GROUP.

import { createHash } from 'node:crypto';

import { writeValidatedJournalWithinTransaction } from '../ledgerPostingGateway.js';
import { persistApplyReceipt } from '../proposalStore.js';
import { runDeterministicPreflight } from '../preflight.js';
import {
  INVENTORY_POSTING_KINDS,
  SUCCESSFUL_POSTING_OUTCOMES
} from './postingLog.js';
import { buildInventoryAllowanceReleaseDraft, computeAllowanceRelease, buildInventoryGrniRetranslationDraft } from './posting.js';
import { reconcileGrniToOpenReceipts } from './reconciliationEngines.js';
import { authorizeInventoryPosting } from './postingAuthorityDb.js';

// The provenance-preserving model sentinel (the-model-id-is-part-of-the-receipt rail): the
// posting path has no model call, but `model: null` loses provenance, so every inventory
// receipt records this deterministic-writer id; the UPSTREAM model receipt ids ride the
// audit metadata + candidate_ids_seen.
const POSTING_MODEL_ID = 'deterministic:inventory_posting/1';
const POSTING_WRITER = 'post_inventory_journal';

const stableStringify = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
};

// A deterministic proposal hash over the draft's ledger-material essence — the source id, the
// journal date/currency, and the sorted legs. Stable across process runs (§9 step 4). PURE.
export const inventoryProposalHash = (draft) => {
  const j = draft?.journal;
  const essence = j
    ? {
        source_id: j.source_id,
        journal_date: j.journal_date,
        currency: j.currency,
        lines: (j.lines || [])
          .map((l) => ({ role: l.account?.canonical_role ?? null, direction: l.direction, debit: l.debit, credit: l.credit }))
          .sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)))
      }
    : { no_journal_required: true, operation_id: draft?.operation_id ?? null, posting_kind: draft?.posting_kind ?? null };
  return createHash('sha256').update(stableStringify(essence)).digest('hex');
};

const advisoryLockKey = (firmId, clientId, operationId, postingKind) =>
  `inv:${firmId}:${clientId}:${operationId}:${postingKind}`;

// Assemble the §13 `proposed` envelope-fit input from the draft (kind / amount / currency / every
// touched account role) MERGED with the caller's authorization context (the model-judgment fields
// the ledger draft does not carry — confidence, evidence, first-use-account, unusual-count-variance,
// jurisdiction). PURE. The draft supplies the ledger facts; the caller supplies the judgment facts.
const assembleAuthorityProposed = (draft, context = {}) => {
  const journal = draft?.journal ?? null;
  const roles = journal
    ? [...new Set((journal.lines || []).map((l) => l.account?.canonical_role).filter(Boolean).map(String))]
    : [];
  return {
    postingKind: draft?.posting_kind ?? null,
    amount: draft?.detail?.journal?.debits ?? journal?.amount ?? null,
    currency: journal?.currency ?? null,
    accountRoles: roles,
    confidence: context.confidence ?? null,
    evidencePresent: context.evidencePresent ?? context.evidence_present ?? false,
    firstUseAccount: context.firstUseAccount ?? context.first_use_account ?? false,
    unusualCountVariance: context.unusualCountVariance ?? context.unusual_count_variance ?? false,
    jurisdiction: context.jurisdiction ?? null
  };
};

// Build the §15 provenance bundle (rides the audit event metadata — jsonb, unconstrained —
// since the closed apply_receipt schema can't carry these; the receipt REFERENCES the audit).
const buildProvenanceBundle = ({ valuationIdentity = {}, provenance = {}, postingKind, postingBasisVersion, ledgerJournalId }) => ({
  valuation_identity: {
    valuation_run_id: valuationIdentity.valuationRunId ?? valuationIdentity.valuation_run_id ?? null,
    stream_version: valuationIdentity.streamVersion ?? valuationIdentity.stream_version ?? null,
    input_hash: valuationIdentity.inputHash ?? valuationIdentity.input_hash ?? null,
    kernel_version: valuationIdentity.kernelVersion ?? valuationIdentity.kernel_version ?? null,
    contract_version: valuationIdentity.contractVersion ?? valuationIdentity.contract_version ?? null,
    prior_posting_basis_version: valuationIdentity.priorPostingBasisVersion ?? null
  },
  upstream: {
    upstream_proposal_id: provenance.upstream_proposal_id ?? null,
    upstream_model_receipt_ids: provenance.upstream_model_receipt_ids ?? [],
    extraction_receipt_ids: provenance.extraction_receipt_ids ?? [],
    human_confirmation_ids: provenance.human_confirmation_ids ?? []
  },
  posting_kind: postingKind,
  posting_basis_version: postingBasisVersion,
  ledger_journal_id: ledgerJournalId ?? null
});

// Insert the append-only attempt row (§11). NEVER updated — receipt + audit ids are known
// before this call, so the single insert carries them.
const insertAttempt = async (tx, {
  firmId, clientId, operationId, postingKind, postingBasisVersion, valuationRunId,
  proposalHash, outcome, reasonCode = null, waiterType = null, waiterId = null,
  nextAction = null, retryAfter = null, journalGroupId = null, applyReceiptId = null,
  auditEventId = null, authorityGrantId = null, actorId, supersedesAttemptId = null
}) => {
  const res = await tx.query(
    `insert into inventory_posting_attempts (
       firm_id, client_id, operation_id, posting_kind, posting_basis_version, valuation_run_id,
       proposal_hash, outcome, reason_code, waiter_type, waiter_id, next_action, retry_after,
       journal_group_id, apply_receipt_id, audit_event_id, authority_grant_id, actor_id,
       supersedes_attempt_id
     )
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     returning id`,
    [
      firmId, clientId, String(operationId ?? 'unknown'), postingKind, postingBasisVersion,
      String(valuationRunId ?? 'unresolved'), proposalHash, outcome, reasonCode, waiterType,
      waiterId, nextAction, retryAfter, journalGroupId, applyReceiptId,
      auditEventId != null ? Number(auditEventId) : null, authorityGrantId, actorId, supersedesAttemptId
    ]
  );
  return res.rows[0]?.id ?? null;
};

const insertAuditEvent = async (tx, { firmId, clientId, actorId, action, resourceId, metadata }) => {
  const res = await tx.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'system', $3, $4, 'inventory_posting', $5, $6::jsonb)
     returning id`,
    [firmId, clientId, actorId, action, String(resourceId ?? ''), JSON.stringify(metadata || {})]
  );
  return res.rows[0]?.id != null ? String(res.rows[0].id) : null;
};

// Build the canonical ApplyReceipt (operator-contract shape, closed schema) for an inventory
// post. The §15 provenance rides the referenced audit event; the receipt threads the pieces
// the closed schema DOES carry.
const buildApplyReceipt = ({ provenance = {}, checks, auditEventId, ledgerJournalIds = [], operationId, applied }) => ({
  proposal_id: provenance.upstream_proposal_id ?? null,
  model: POSTING_MODEL_ID,
  prompt_version: null,
  context_snapshot_id: provenance.input_hash ?? null,
  candidate_ids_seen: [
    ...(provenance.upstream_model_receipt_ids ?? []),
    ...(provenance.extraction_receipt_ids ?? []),
    ...(provenance.human_confirmation_ids ?? [])
  ].map(String),
  candidate_ids_rejected: [],
  facts_available: [],
  facts_used: [],
  facts_conflicted: [],
  examples_available: [],
  examples_used: [],
  playbooks_used: [],
  policies_used: [],
  checks: checks ?? null,
  final_writer: POSTING_WRITER,
  audit_event_ids: auditEventId ? [String(auditEventId)] : [],
  rows_touched: ledgerJournalIds.map(String),
  per_target: [{ target: String(operationId ?? 'unknown'), applied: Boolean(applied), error: null }],
  operator_words: null
});

const persistAllocations = async (tx, { firmId, clientId, attemptId, ledgerJournalId, allocations = [] }) => {
  for (const a of allocations) {
    await tx.query(
      `insert into inventory_journal_allocations (
         firm_id, client_id, operation_id, ledger_journal_id, ledger_line_id, posting_attempt_id,
         allocated_amount, allocated_currency, allocated_quantity, valuation_run_id
       )
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        firmId, clientId, String(a.operationId ?? a.operation_id), ledgerJournalId,
        a.ledgerLineId ?? a.ledger_line_id ?? null, attemptId,
        a.allocatedAmount ?? a.allocated_amount, a.allocatedCurrency ?? a.allocated_currency,
        a.allocatedQuantity ?? a.allocated_quantity ?? null, String(a.valuationRunId ?? a.valuation_run_id ?? 'unresolved')
      ]
    );
  }
};

// Persist the §5-F allowance LOT that a write-down creates (the register 080 had no writer
// until now). The lot binds the allowance to specific SKU/group stock + its bound quantity, so
// derecognition can release it proportionally. Linked to the write-down's posting attempt; the
// register is mutable current-state (consumed_amount / remaining_quantity / status move over its
// life), NOT the append-only log. Returns the lot id.
const persistAllowanceLot = async (tx, { firmId, clientId, attemptId, lot = {}, valuationRunId = null }) => {
  const boundQty = lot.bound_quantity ?? lot.boundQuantity ?? null;
  const res = await tx.query(
    `insert into inventory_valuation_allowances (
       firm_id, client_id, scope_item_id, scope_group, valuation_date, allowance_amount, currency,
       max_reversible_amount, consumed_amount, bound_quantity, remaining_quantity, status,
       nrv_evidence, reviewer, posting_attempt_id, valuation_run_id
     )
     values ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$9,'active',$10::jsonb,$11,$12,$13)
     returning id`,
    [
      firmId, clientId, lot.scope_item_id ?? lot.scopeItemId ?? null, lot.scope_group ?? lot.scopeGroup ?? null,
      lot.valuation_date ?? lot.valuationDate ?? null, lot.allowance_amount ?? lot.allowanceAmount,
      lot.currency ?? null, lot.max_reversible_amount ?? lot.maxReversibleAmount ?? lot.allowance_amount ?? lot.allowanceAmount,
      boundQty, JSON.stringify(lot.nrv_evidence ?? lot.nrvEvidence ?? {}), lot.reviewer ?? null,
      attemptId, String(valuationRunId ?? lot.valuation_run_id ?? 'unresolved')
    ]
  );
  return res.rows[0]?.id ?? null;
};

const linkJournal = async (tx, { firmId, clientId, attemptId, ledgerJournalId, relationship, journalGroupId }) => {
  await tx.query(
    `insert into inventory_posting_journals (firm_id, client_id, posting_attempt_id, ledger_journal_id, relationship, journal_group_id)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (posting_attempt_id, ledger_journal_id) do nothing`,
    [firmId, clientId, attemptId, ledgerJournalId, relationship, journalGroupId ?? null]
  );
};

// Locked-period / balance refusal codes the gateway throws — a KNOWN accounting refusal we
// record as a tracked attempt (never a poisoned transaction: these are app-level throws that
// fire AFTER their SELECTs succeed, so the txn stays usable).
const LOCKED_PERIOD_CODES = new Set(['LEDGER_LOCKED_PERIOD_IMMUTABLE', 'LEDGER_ADJUSTMENT_DATE_LOCKED']);
const BALANCE_CODE = 'LEDGER_CORRECTION_UNBALANCED';

// ── The core executor (§9) ─────────────────────────────────────────────────────
export const postInventoryJournalWithinTransaction = async (tx, params = {}) => {
  const {
    firmId, clientId, actorId = 'system',
    draft,
    postingBasisVersion = 1,
    valuationIdentity = {},
    expectedInputHash = null,
    expectedProposalHash = null,
    provenance = {},
    authorityGrantId = null,
    allocations = [],
    journalGroupId = null,
    relationship = 'primary',
    period = null,
    accountingReady = true,
    allowanceLot = null,
    authorization = null,
    dryRun = false
  } = params;

  if (!tx || typeof tx.query !== 'function') throw new Error('postInventoryJournal: a transaction client is required.');
  if (!firmId || !clientId) throw new Error('postInventoryJournal: firmId and clientId are required.');
  if (!draft || typeof draft !== 'object') throw new Error('postInventoryJournal: a draft (pure-builder output) is required.');

  const operationId = draft.operation_id ?? null;
  const postingKind = draft.posting_kind ?? null;
  const valuationRunId = valuationIdentity.valuationRunId ?? valuationIdentity.valuation_run_id ?? draft.valuation_run_id ?? null;
  const proposalHash = inventoryProposalHash(draft);
  const provenanceForReceipt = { ...provenance, input_hash: valuationIdentity.inputHash ?? valuationIdentity.input_hash ?? null };

  // 1. Lock the posting key (no-op shape in fake-pg; real serialization in Postgres).
  await tx.query('select pg_advisory_xact_lock(hashtext($1)) as locked', [advisoryLockKey(firmId, clientId, operationId, postingKind)]);

  // 2. Idempotency re-fetch — a prior successful application at this basis version is a replay.
  const prior = await tx.query(
    `select id, outcome, apply_receipt_id, audit_event_id, proposal_hash
       from inventory_posting_attempts
      where firm_id = $1 and client_id = $2 and operation_id = $3 and posting_kind = $4
        and posting_basis_version = $5 and outcome = any($6)
      order by id desc limit 1`,
    [firmId, clientId, String(operationId ?? 'unknown'), postingKind, postingBasisVersion, SUCCESSFUL_POSTING_OUTCOMES]
  );
  if (prior.rows[0]) {
    // Idempotent replay. If the incoming draft hashes DIFFERENTLY from the recorded one at the
    // same (op, kind, basis_version), surface it: a genuinely different draft at an unchanged
    // basis version means the caller forgot to bump posting_basis_version — a no-op is correct
    // (one success per basis), but the divergence must not be silent (nothing-silent rail).
    const priorHash = prior.rows[0].proposal_hash ?? null;
    const basisMismatch = priorHash != null && String(priorHash) !== String(proposalHash);
    return {
      status: 'replayed', replayed: true, attempt_id: prior.rows[0].id, outcome: prior.rows[0].outcome,
      apply_receipt_id: prior.rows[0].apply_receipt_id ?? null, proposal_hash: proposalHash,
      suspicious: basisMismatch ? ['draft differs from the recorded success at the same basis version — bump posting_basis_version to re-post'] : [],
      consequence: { changed: 'nothing (idempotent replay)', invariant_checked: 'one_success_per_basis', commit: 'already_applied' }
    };
  }

  // 3. Verify input_hash (§9.3) — a moved valuation basis refuses stale.
  const actualInputHash = valuationIdentity.inputHash ?? valuationIdentity.input_hash ?? null;
  if (expectedInputHash && actualInputHash && String(expectedInputHash) !== String(actualInputHash)) {
    return recordRefusal(tx, {
      firmId, clientId, actorId, operationId, postingKind, postingBasisVersion, valuationRunId, proposalHash,
      reasonCode: 'stale_valuation_run', waiterType: 'integration_system_retry',
      nextAction: 'recompute valuation and re-propose', dryRun, detail: { expectedInputHash, actualInputHash }
    });
  }

  // 4. Compare proposal_hash (§9.4) — a stale dry-run proposal refuses.
  if (expectedProposalHash && String(expectedProposalHash) !== String(proposalHash)) {
    return recordRefusal(tx, {
      firmId, clientId, actorId, operationId, postingKind, postingBasisVersion, valuationRunId, proposalHash,
      reasonCode: 'stale_proposal', waiterType: 'integration_system_retry',
      nextAction: 're-run the dry-run and re-propose', dryRun, detail: { expectedProposalHash, actualProposalHash: proposalHash }
    });
  }

  // 5a. A REFUSAL draft — the pure builder already routed it to a waiter (§12). Record it.
  if (draft.applied === false) {
    return recordRefusal(tx, {
      firmId, clientId, actorId, operationId, postingKind: postingKind ?? 'value_neutral', postingBasisVersion, valuationRunId, proposalHash,
      reasonCode: draft.reason ?? 'unsupported_operation', waiterType: draft.waiter_type ?? 'accountant_operator',
      nextAction: draft.detail?.next_action ?? null, dryRun, detail: draft.detail ?? {}
    });
  }

  // 5b. Evidence gate (§14) — the executor NEVER infers readiness from numbers.
  if (!accountingReady) {
    return recordRefusal(tx, {
      firmId, clientId, actorId, operationId, postingKind, postingBasisVersion, valuationRunId, proposalHash,
      reasonCode: 'not_accounting_ready', waiterType: 'accountant_operator',
      nextAction: 'mark the upstream operation accounting_ready with its evidence', dryRun, detail: {}
    });
  }

  // 5c/6. Preflight — journal_balances / period_not_locked (render the persisted verdict).
  const checks = runDeterministicPreflight({
    card: { detail: draft.detail, targets: [String(operationId ?? 'unknown')], preconditions: [] },
    targetStates: { [String(operationId ?? 'unknown')]: {} },
    period
  });
  if (checks.status === 'fail') {
    return recordRefusal(tx, {
      firmId, clientId, actorId, operationId, postingKind, postingBasisVersion, valuationRunId, proposalHash,
      reasonCode: 'preflight_failed', waiterType: 'engineering_incident',
      nextAction: 'inspect the failing check', dryRun, detail: { checks }
    });
  }

  // 5d. Value-neutral terminal (§11 D-POST-14) — a RECORDED terminal, no journal.
  if (draft.no_journal_required) {
    if (dryRun) return { status: 'dry_run', dry_run: true, outcome: 'no_journal_required', preview: draft, checks, proposal_hash: proposalHash };
    const auditEventId = await insertAuditEvent(tx, {
      firmId, clientId, actorId, action: 'inventory.value_neutral', resourceId: operationId,
      metadata: buildProvenanceBundle({ valuationIdentity, provenance, postingKind: 'value_neutral', postingBasisVersion, ledgerJournalId: null })
    });
    const receipt = buildApplyReceipt({ provenance: provenanceForReceipt, checks: null, auditEventId, ledgerJournalIds: [], operationId, applied: true });
    const receiptRow = await persistApplyReceipt({ client: tx, firmId, clientId, receipt });
    const attemptId = await insertAttempt(tx, {
      firmId, clientId, operationId, postingKind: 'value_neutral', postingBasisVersion, valuationRunId, proposalHash,
      outcome: 'no_journal_required', applyReceiptId: receiptRow?.id ?? null, auditEventId, authorityGrantId, actorId
    });
    return {
      status: 'no_journal_required', outcome: 'no_journal_required', attempt_id: attemptId,
      apply_receipt_id: receiptRow?.id ?? null, audit_event_id: auditEventId, proposal_hash: proposalHash,
      consequence: draft.consequence
    };
  }

  // 6a. Delegated-authority gate (§13) — OPT-IN. Enforced only when the caller marks this an
  //     UNATTENDED post (authorization.enforce). The proposal must fit a human-minted grant
  //     envelope (allowed kind/account, per-journal + daily + period ceilings, currency, confidence,
  //     evidence, validity, jurisdiction; write-down/private-use/first-use/unusual-variance ALWAYS
  //     escalate). A denial records a TRACKED accountant/operator refusal and posts NOTHING — the
  //     material line escalates to the human who can post it or extend the grant, never a silent
  //     over-authorized post. An attended post (no authorization) is unchanged. The verdict runs
  //     even in dryRun (a preview shows whether it WOULD be authorized). The check adds this
  //     proposal's amount to the already-posted-under-this-grant aggregate before the ceiling test,
  //     so the grant bounds cumulative unattended posting, not just one journal.
  let effectiveAuthorityGrantId = authorityGrantId;
  if (authorization?.enforce === true) {
    const verdict = await authorizeInventoryPosting({
      client: tx, firmId, clientId,
      proposed: assembleAuthorityProposed(draft, authorization.context ?? {}),
      journalDate: draft.journal?.journal_date ?? null,
      periodStart: authorization.periodStart ?? null,
      periodEnd: authorization.periodEnd ?? null,
      asOf: authorization.asOf ?? null
    });
    if (!verdict.authorized) {
      return recordRefusal(tx, {
        firmId, clientId, actorId, operationId, postingKind, postingBasisVersion, valuationRunId, proposalHash,
        reasonCode: `authority_${verdict.reason}`, waiterType: 'accountant_operator',
        nextAction: 'review and post manually, or extend the inventory posting-authority grant',
        authorityGrantId: verdict.grant?.id ?? null, dryRun, detail: { authority: verdict.detail ?? {}, breach: verdict.reason, grant_id: verdict.grant?.id ?? null }
      });
    }
    // Authorized — attribute the post to the covering grant so the aggregate reader can sum it.
    effectiveAuthorityGrantId = verdict.grant?.id ?? authorityGrantId;
  }

  // 6b. dryRun — everything above ran; write nothing.
  if (dryRun) {
    return { status: 'dry_run', dry_run: true, outcome: 'proposed', preview: draft, checks, proposal_hash: proposalHash, consequence: draft.consequence, authority_grant_id: effectiveAuthorityGrantId };
  }

  // 7. Write the journal via the ONE gateway. A known accounting refusal (locked period /
  //    unbalanced) is recorded as a tracked attempt; anything else poisons the txn (rethrow).
  let post;
  try {
    post = await writeValidatedJournalWithinTransaction(tx, draft.journal, {
      firmId, clientId, actorId,
      payload: {
        source: 'inventory_posting',
        posting_kind: postingKind,
        valuation_run_id: valuationRunId,
        valuation_identity: valuationIdentity,
        provenance
      }
    });
  } catch (err) {
    if (LOCKED_PERIOD_CODES.has(err?.code)) {
      return recordRefusal(tx, {
        firmId, clientId, actorId, operationId, postingKind, postingBasisVersion, valuationRunId, proposalHash,
        outcome: 'blocked_locked_period', reasonCode: err.code, waiterType: 'accountant_operator',
        nextAction: 'post a dated adjustment journal into an open period', dryRun: false, detail: { message: err.message }
      });
    }
    if (err?.code === BALANCE_CODE) {
      return recordRefusal(tx, {
        firmId, clientId, actorId, operationId, postingKind, postingBasisVersion, valuationRunId, proposalHash,
        reasonCode: err.code, waiterType: 'engineering_incident', nextAction: 'inspect the unbalanced draft', dryRun: false, detail: { message: err.message }
      });
    }
    throw err;
  }

  // 8+9. Audit-as-precondition → receipt → the single append-only attempt row (carries both
  //      ids) → journal link → allocations. Order matters: the append-only row is inserted
  //      ONCE with the receipt + audit ids already known.
  const auditEventId = await insertAuditEvent(tx, {
    firmId, clientId, actorId, action: 'inventory.journal_posted', resourceId: post.ledger_journal_id,
    metadata: buildProvenanceBundle({ valuationIdentity, provenance, postingKind, postingBasisVersion, ledgerJournalId: post.ledger_journal_id })
  });
  const receipt = buildApplyReceipt({
    provenance: provenanceForReceipt, checks, auditEventId, ledgerJournalIds: [post.ledger_journal_id], operationId, applied: true
  });
  const receiptRow = await persistApplyReceipt({ client: tx, firmId, clientId, receipt });
  const attemptId = await insertAttempt(tx, {
    firmId, clientId, operationId, postingKind, postingBasisVersion, valuationRunId, proposalHash,
    outcome: 'posted', journalGroupId, applyReceiptId: receiptRow?.id ?? null, auditEventId, authorityGrantId: effectiveAuthorityGrantId, actorId
  });
  await linkJournal(tx, { firmId, clientId, attemptId, ledgerJournalId: post.ledger_journal_id, relationship, journalGroupId });
  await persistAllocations(tx, { firmId, clientId, attemptId, ledgerJournalId: post.ledger_journal_id, allocations });

  // §5-F register writer: a write-down persists its allowance LOT (bound to the SKU/group stock)
  // atomically with the journal, so the §16 allowance-integrity engine ties the GL contra to a
  // real register and derecognition can later consume it. Only for write_down posts.
  let allowanceLotId = null;
  if (postingKind === 'write_down' && allowanceLot) {
    allowanceLotId = await persistAllowanceLot(tx, { firmId, clientId, attemptId, lot: allowanceLot, valuationRunId });
  }

  return {
    status: 'posted', outcome: 'posted', attempt_id: attemptId, ledger_journal_id: post.ledger_journal_id,
    apply_receipt_id: receiptRow?.id ?? null, audit_event_id: auditEventId, proposal_hash: proposalHash,
    allowance_lot_id: allowanceLotId,
    consequence: draft.consequence
  };
};

// Record a refused / blocked attempt (a TRACKED waiter state, §12 — never a silent gap). In
// dryRun, return the preview without writing.
async function recordRefusal(tx, {
  firmId, clientId, actorId, operationId, postingKind, postingBasisVersion, valuationRunId, proposalHash,
  reasonCode, waiterType, waiterId = null, nextAction = null, outcome = 'refused', authorityGrantId = null, dryRun, detail = {}
}) {
  if (dryRun) {
    return { status: 'dry_run', dry_run: true, outcome, refused: true, reason_code: reasonCode, waiter_type: waiterType, next_action: nextAction, detail, proposal_hash: proposalHash };
  }
  const auditEventId = await insertAuditEvent(tx, {
    firmId, clientId, actorId, action: 'inventory.posting_refused', resourceId: operationId,
    metadata: { reason_code: reasonCode, waiter_type: waiterType, next_action: nextAction, posting_kind: postingKind, detail }
  });
  const attemptId = await insertAttempt(tx, {
    firmId, clientId, operationId, postingKind: postingKind ?? 'value_neutral', postingBasisVersion, valuationRunId, proposalHash,
    outcome, reasonCode, waiterType, waiterId, nextAction, authorityGrantId, auditEventId, actorId
  });
  return {
    status: outcome, outcome, refused: true, attempt_id: attemptId, audit_event_id: auditEventId,
    reason_code: reasonCode, waiter_type: waiterType, next_action: nextAction, proposal_hash: proposalHash, detail
  };
}

// ── The begins→commits wrapper ──────────────────────────────────────────────────
export const postInventoryJournalFromDb = async (db, params = {}) => {
  if (!db || typeof db.connect !== 'function') throw new Error('postInventoryJournalFromDb: a pg pool (db.connect) is required.');
  const client = await db.connect();
  try {
    await client.query('begin');
    const result = await postInventoryJournalWithinTransaction(client, params);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

// ── §5-G reversal — exact persisted-journal reversal + downstream deltas (a journal GROUP) ──
export const reverseInventoryJournalWithinTransaction = async (tx, params = {}) => {
  const {
    firmId, clientId, actorId = 'system',
    targetJournalId, reversalDate, journalGroupId = null,
    downstreamDeltaDrafts = [], provenance = {}, valuationIdentity = {},
    reason = null, authorityGrantId = null, postingBasisVersion = 1, dryRun = false
  } = params;
  if (!tx || typeof tx.query !== 'function') throw new Error('reverseInventoryJournal: a transaction client is required.');
  if (!firmId || !clientId || !targetJournalId) throw new Error('reverseInventoryJournal: firmId, clientId, targetJournalId are required.');
  if (!reversalDate) throw new Error('reverseInventoryJournal: reversalDate (an open period) is required.');

  const group = journalGroupId || `invrev:${targetJournalId}`;
  await tx.query('select pg_advisory_xact_lock(hashtext($1)) as locked', [`invrev:${firmId}:${clientId}:${targetJournalId}`]);

  // 1. Load the ORIGINAL persisted journal + lines (never a rebuild under today's code).
  const orig = await tx.query(
    `select id, currency, journal_date, memo, reversed_at, source_type, source_id
       from ledger_journals where id = $1 and firm_id = $2 and client_id = $3 limit 1`,
    [targetJournalId, firmId, clientId]
  );
  if (!orig.rows[0]) {
    const e = new Error('Inventory reversal target journal not found.'); e.statusCode = 404; e.code = 'INVENTORY_REVERSAL_TARGET_NOT_FOUND'; throw e;
  }
  // 3. Reject a SECOND reversal.
  if (orig.rows[0].reversed_at) {
    const e = new Error('Ledger journal has already been reversed.'); e.statusCode = 409; e.code = 'INVENTORY_ALREADY_REVERSED'; throw e;
  }
  const lineRows = await tx.query(
    `select account_id, account_code, account_name, line_no, direction, debit, credit, amount, currency, tax_type, memo, payload
       from ledger_lines where journal_id = $1 order by line_no asc`,
    [targetJournalId]
  );
  if (!lineRows.rows.length) {
    const e = new Error('Inventory reversal target journal has no lines.'); e.statusCode = 409; e.code = 'INVENTORY_REVERSAL_NO_LINES'; throw e;
  }

  // 2. Build the EXACT reversal: copy lines, swap debit/credit.
  const currency = orig.rows[0].currency;
  const accountsByKey = new Map();
  const reversedLines = lineRows.rows.map((l) => {
    const role = l.payload?.role ?? null;
    const account = {
      role: role ? `inventory_${String(role).replace(/\./g, '_')}` : (l.account_code || l.account_name || 'unknown'),
      code: l.account_code || '',
      name: l.account_name || l.account_code || '',
      canonical_role: role,
      tax_type: l.tax_type || 'NONE',
      label: l.payload?.account_label || l.account_name || l.account_code || ''
    };
    const key = `${account.role}|${account.code}|${account.name}`;
    if (!accountsByKey.has(key)) accountsByKey.set(key, account);
    const debit = Number(l.credit || 0); // swapped
    const credit = Number(l.debit || 0);
    return {
      account, direction: debit > 0 ? 'debit' : 'credit', debit, credit, amount: Number(l.amount || 0),
      currency: l.currency || currency, memo: `Reversal of ${l.memo || ''}`.trim(), reverses_line_no: l.line_no
    };
  });
  const reversalJournal = {
    source_type: 'inventory_posting',
    source_id: `reversal:${targetJournalId}:${reversalDate}`,
    journal_date: reversalDate,
    currency,
    status: 'proposed',
    memo: `Reversal of ${orig.rows[0].memo || targetJournalId}${reason ? ` · ${reason}` : ''}`,
    direction: 'internal',
    amount: reversedLines.reduce((s, l) => s + l.debit, 0),
    accounts: [...accountsByKey.values()],
    lines: reversedLines
  };

  if (dryRun) {
    return { status: 'dry_run', dry_run: true, outcome: 'proposed', preview: { reversalJournal }, downstream_delta_count: downstreamDeltaDrafts.length };
  }

  // 4. Write the reversal via the gateway (dates into an OPEN period — the guard enforces).
  const post = await writeValidatedJournalWithinTransaction(tx, reversalJournal, {
    firmId, clientId, actorId,
    payload: { source: 'inventory_posting', posting_kind: 'reversal', reverses_journal_id: targetJournalId, reason, provenance }
  });
  // Stamp the reversal linkage columns (007) + mark the original reversed — both this txn.
  await tx.query(`update ledger_journals set reversal_of_journal_id = $2, updated_at = now() where id = $1`, [post.ledger_journal_id, targetJournalId]);
  await tx.query(`update ledger_journals set reversed_at = now(), updated_at = now() where id = $1 and reversed_at is null`, [targetJournalId]);

  // 8+9. Attempt + receipt + audit for the reversal leg.
  const proposalHash = inventoryProposalHash({ journal: reversalJournal, operation_id: targetJournalId, posting_kind: 'reversal' });
  const auditEventId = await insertAuditEvent(tx, {
    firmId, clientId, actorId, action: 'inventory.journal_reversed', resourceId: post.ledger_journal_id,
    metadata: { reverses_journal_id: targetJournalId, journal_group_id: group, reason, ...buildProvenanceBundle({ valuationIdentity, provenance, postingKind: 'reversal', postingBasisVersion, ledgerJournalId: post.ledger_journal_id }) }
  });
  const receipt = buildApplyReceipt({ provenance: { ...provenance, input_hash: valuationIdentity.inputHash ?? null }, checks: null, auditEventId, ledgerJournalIds: [post.ledger_journal_id], operationId: targetJournalId, applied: true });
  const receiptRow = await persistApplyReceipt({ client: tx, firmId, clientId, receipt });
  const attemptId = await insertAttempt(tx, {
    firmId, clientId, operationId: targetJournalId, postingKind: 'reversal', postingBasisVersion, valuationRunId: valuationIdentity.valuationRunId ?? 'reversal',
    proposalHash, outcome: 'posted', journalGroupId: group, applyReceiptId: receiptRow?.id ?? null, auditEventId, authorityGrantId, actorId
  });
  await linkJournal(tx, { firmId, clientId, attemptId, ledgerJournalId: post.ledger_journal_id, relationship: 'reversal', journalGroupId: group });

  // 5. Separately post the kernel's downstream delta journals — same GROUP (§5-G).
  const deltas = [];
  for (const deltaDraft of downstreamDeltaDrafts) {
    const r = await postInventoryJournalWithinTransaction(tx, {
      firmId, clientId, actorId, draft: deltaDraft, postingBasisVersion, valuationIdentity, provenance,
      journalGroupId: group, relationship: 'delta_adjustment', authorityGrantId
    });
    deltas.push(r);
  }

  return {
    status: 'reversed', outcome: 'posted', journal_group_id: group, reversal_journal_id: post.ledger_journal_id,
    attempt_id: attemptId, apply_receipt_id: receiptRow?.id ?? null, audit_event_id: auditEventId,
    reversed_journal_id: targetJournalId, downstream_deltas: deltas
  };
};

export const reverseInventoryJournalFromDb = async (db, params = {}) => {
  if (!db || typeof db.connect !== 'function') throw new Error('reverseInventoryJournalFromDb: a pg pool is required.');
  const client = await db.connect();
  try {
    await client.query('begin');
    const result = await reverseInventoryJournalWithinTransaction(client, params);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

// ── §5-F derecognition consumption — release the bound allowance when the stock leaves ─────
//
// When written-down stock is DERECOGNIZED (sold / scrapped / damaged / wasted), the bound
// allowance is RELEASED in the SAME transaction (§5-F redline) so it never strands against stock
// that no longer exists. Consumption is proportional to the derecognized quantity and walks the
// active lots FIFO (oldest valuation_date first). Every release POSTS through the P5 executor
// (never a new backend) as a journal-GROUP delta_adjustment, and the register lot is then moved
// (consumed_amount / remaining_quantity / status). Idempotent: each lot's release is keyed on
// (allowance_release:<derecognition op>:<lot id>), so a replay returns the prior success and does
// NOT re-decrement the lot. This is UNCAPPED (distinct from a market-recovery reversal): it is
// the release of an allowance whose stock is gone.
export const consumeInventoryAllowanceWithinTransaction = async (tx, params = {}) => {
  const {
    firmId, clientId, actorId = 'system',
    scopeItemId = null, scopeGroup = null,
    derecognizedQty, reason, roleAccounts = {},
    derecognitionOperationId, date = null, currency = null, valuationRunId = null,
    journalGroupId = null, authorityGrantId = null, dryRun = false
  } = params;
  if (!tx || typeof tx.query !== 'function') throw new Error('consumeInventoryAllowance: a transaction client is required.');
  if (!firmId || !clientId) throw new Error('consumeInventoryAllowance: firmId and clientId are required.');
  if (!derecognitionOperationId) throw new Error('consumeInventoryAllowance: derecognitionOperationId is required.');
  if (!(Number(derecognizedQty) > 0)) throw new Error('consumeInventoryAllowance: a positive derecognizedQty is required.');
  if (scopeItemId == null && scopeGroup == null) throw new Error('consumeInventoryAllowance: a scope (scopeItemId or scopeGroup) is required.');

  const group = journalGroupId || `invcons:${derecognitionOperationId}`;
  // Build the scope predicate from ONLY the provided scope(s) — a missing scope must NOT widen
  // the match (an "$x is null → true" disjunct would match EVERY lot). At least one scope is
  // asserted above, so scopeConds is never empty.
  const scopeConds = [];
  const scopeParams = [];
  if (scopeItemId != null) { scopeConds.push(`scope_item_id = $${3 + scopeParams.length}`); scopeParams.push(scopeItemId); }
  if (scopeGroup != null) { scopeConds.push(`scope_group = $${3 + scopeParams.length}`); scopeParams.push(scopeGroup); }
  // Read the active bound lots for this scope, FIFO by valuation_date. FOR UPDATE serializes
  // concurrent consumption of the same lot (dryRun skips the lock — it writes nothing).
  const lots = await tx.query(
    `select id, scope_item_id, scope_group, allowance_amount, consumed_amount, remaining_quantity, currency, valuation_date
       from inventory_valuation_allowances
      where firm_id = $1 and client_id = $2 and status = 'active'
        and (${scopeConds.join(' or ')})
        and coalesce(remaining_quantity, 0) > 0
      order by valuation_date asc, id asc${dryRun ? '' : ' for update'}`,
    [firmId, clientId, ...scopeParams]
  );

  let qtyLeft = Number(derecognizedQty);
  let releasedTotal = 0;
  const consumed = [];
  for (const lotRow of lots.rows) {
    if (qtyLeft <= 1e-9) break;
    const { releaseAmount, releaseQuantity, fullyConsumed } = computeAllowanceRelease({ lot: lotRow, derecognizedQty: qtyLeft });
    if (!(releaseAmount > 0) || !(releaseQuantity > 0)) continue;
    qtyLeft -= releaseQuantity;

    const releaseOpId = `allowance_release:${derecognitionOperationId}:${lotRow.id}`;
    const draft = buildInventoryAllowanceReleaseDraft({
      lot: lotRow, releaseAmount, reason, roleAccounts,
      operationId: releaseOpId, date, currency: currency || lotRow.currency, valuationRunId
    });
    // A refusal draft (unmapped role / unsupported reason) is recorded as a tracked attempt by
    // the executor — it never silently drops a release.
    const post = await postInventoryJournalWithinTransaction(tx, {
      firmId, clientId, actorId, draft,
      journalGroupId: group, relationship: 'delta_adjustment',
      valuationIdentity: { valuationRunId }, authorityGrantId, dryRun
    });

    // Move the register lot ONLY on a genuine fresh post (not a replay — the prior run already
    // moved it) and never in dryRun.
    if (!dryRun && post.status === 'posted') {
      await tx.query(
        `update inventory_valuation_allowances
            set consumed_amount = consumed_amount + $2,
                remaining_quantity = greatest(coalesce(remaining_quantity, 0) - $3, 0),
                status = case when coalesce(remaining_quantity, 0) - $3 <= 0.00000001 then 'released' else status end,
                updated_at = now()
          where id = $1`,
        [lotRow.id, releaseAmount, releaseQuantity]
      );
    }
    releasedTotal += releaseAmount;
    consumed.push({ lot_id: lotRow.id, release_amount: releaseAmount, release_quantity: releaseQuantity, fully_consumed: fullyConsumed, outcome: post.status, ledger_journal_id: post.ledger_journal_id ?? null });
  }

  return {
    status: dryRun ? 'dry_run' : 'consumed',
    journal_group_id: group,
    released_total: Math.round((releasedTotal + Number.EPSILON) * 100) / 100,
    lots_consumed: consumed.length,
    unbound_quantity: Math.max(qtyLeft, 0), // derecognized stock that carried no allowance (never written down)
    consumed
  };
};

export const consumeInventoryAllowanceFromDb = async (db, params = {}) => {
  if (!db || typeof db.connect !== 'function') throw new Error('consumeInventoryAllowanceFromDb: a pg pool is required.');
  const client = await db.connect();
  try {
    await client.query('begin');
    const result = await consumeInventoryAllowanceWithinTransaction(client, params);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

// ── §10 FX retranslation of open GRNI at close — the WRITE side (P6c) ────────────────────────────
// Open foreign-currency GRNI is a MONETARY liability retranslated at period-end (IAS 21). The §16
// GRNI engine (reconcileGrniToOpenReceipts) already COMPUTES the per-currency delta and surfaces it
// as an `obligation`; this is the executor that POSTS it. For each foreign currency with an open
// GRNI balance:
//   • rate present  → post the incremental delta (DR/CR liability.grni vs expense.fx) through the P5
//     executor (postInventoryJournalWithinTransaction, never a new backend) as a journal-GROUP
//     delta_adjustment;
//   • zero delta     → a recorded no_journal_required terminal (the builder returns it);
//   • rate MISSING   → the builder refuses `missing_close_fx_rate`; the executor records a tracked
//     integration_system_retry attempt (await_fx_fact) — NEVER a guessed rate (§10).
// Idempotent per (closePeriod, currency): the operation id is `grni_retranslation:<closePeriod>:
// <currency>`, so re-running the SAME close is a replay (no double-post), while a NEW period posts
// its own incremental delta from the last-booked rate. The FX math is NOT re-derived here — the
// pure §16 engine owns it and this executor consumes its verdict (render-the-persisted-verdict).
export const retranslateOpenGrniWithinTransaction = async (tx, params = {}) => {
  const {
    firmId, clientId, actorId = 'system',
    closePeriod,
    grniByCurrency = [],
    functionalCurrency = null,
    roleAccounts = {},
    journalDate = null,
    valuationRunId = null,
    authorityGrantId = null,
    journalGroupId = null,
    period = null,
    postingBasisVersion = 1,
    tolerance = undefined,
    dryRun = false
  } = params;
  if (!tx || typeof tx.query !== 'function') throw new Error('retranslateOpenGrni: a transaction client is required.');
  if (!firmId || !clientId) throw new Error('retranslateOpenGrni: firmId and clientId are required.');
  if (!closePeriod) throw new Error('retranslateOpenGrni: a closePeriod identifier is required.');

  // Run the PURE §16 engine to classify each currency's retranslation obligation. Consume its
  // computed delta — never a second FX conversion here (§10: the kernel/engine owns the math).
  const engine = reconcileGrniToOpenReceipts({
    byCurrency: grniByCurrency, functionalCurrency, ...(tolerance != null ? { tolerance } : {})
  });
  const engineRows = engine.detail?.by_currency ?? [];
  // Index the caller's input by currency for provenance the engine row doesn't echo (source open).
  const sourceOpenByCcy = new Map(
    (Array.isArray(grniByCurrency) ? grniByCurrency : []).map((r) => [
      String(r?.currency ?? '').toUpperCase(),
      r?.sourceOpenAmount ?? r?.source_open_amount ?? null
    ])
  );

  const group = journalGroupId || `grniretr:${closePeriod}`;
  const results = [];
  let postedCount = 0;
  let rateMissing = 0;
  let neutralCount = 0;
  for (const row of engineRows) {
    const r = row.retranslation;
    if (!r || !r.required) continue; // functional-currency or fully-closed GRNI — nothing to retranslate
    const operationId = `grni_retranslation:${closePeriod}:${row.currency}`;
    const draft = buildInventoryGrniRetranslationDraft({
      currency: row.currency, functionalCurrency,
      delta: r.rate_available ? r.delta : null,
      closeRate: r.rate_available ? r.close_rate : null,
      bookedRate: r.booked_rate ?? null,
      sourceOpenAmount: sourceOpenByCcy.get(String(row.currency).toUpperCase()) ?? null,
      roleAccounts, operationId, date: journalDate, valuationRunId
    });
    const post = await postInventoryJournalWithinTransaction(tx, {
      firmId, clientId, actorId, draft,
      postingBasisVersion,
      journalGroupId: group, relationship: 'delta_adjustment',
      valuationIdentity: { valuationRunId }, authorityGrantId, period, dryRun
    });
    if (post.status === 'posted') postedCount += 1;
    else if (post.outcome === 'no_journal_required') neutralCount += 1;
    else if (post.refused && post.reason_code === 'missing_close_fx_rate') rateMissing += 1;
    results.push({
      currency: row.currency, operation_id: operationId,
      delta: r.rate_available ? r.delta : null, rate_available: r.rate_available,
      status: post.status, outcome: post.outcome ?? post.status,
      waiter_type: post.waiter_type ?? null, ledger_journal_id: post.ledger_journal_id ?? null
    });
  }
  return {
    status: dryRun ? 'dry_run' : 'retranslated',
    journal_group_id: group,
    close_period: closePeriod,
    functional_currency: functionalCurrency,
    engine_status: engine.status,
    posted_count: postedCount,
    neutral_count: neutralCount,
    rate_missing: rateMissing,
    retranslations: results
  };
};

export const retranslateOpenGrniFromDb = async (db, params = {}) => {
  if (!db || typeof db.connect !== 'function') throw new Error('retranslateOpenGrniFromDb: a pg pool is required.');
  const client = await db.connect();
  try {
    await client.query('begin');
    const result = await retranslateOpenGrniWithinTransaction(client, params);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

export { INVENTORY_POSTING_KINDS };
