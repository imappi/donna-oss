// Donna Loops — Phase 2 proposal store. The Keep-layer persistence + validation
// for the Operator-Contract shapes that already exist in operatorContract.js:
// ProposalCard, CheckReport, ApplyReceipt. Shadow-only until wired (Phase 2.2);
// no LLM, no external calls, no accounting writes happen here.
//
// Invariants this module enforces:
//   INV-9  — a card's CONTENT is write-once. persistProposalCard inserts the card
//            (and its normalized targets + check report) exactly once, guarded by
//            ON CONFLICT (id) DO NOTHING. A *change* to a proposal is a NEW card via
//            supersedeProposalCard, which only transitions the OLD card's lifecycle
//            pointer (status / superseded_by_proposal_id) — never its content.
//            check_reports + apply_receipts rows are append-only.
//   INV-10 — apply is deterministic. The per-target apply lifecycle
//            (proposal_targets.apply_status) is version-bound via
//            object_version_at_proposal; persistApplyReceipt records the outcome.
//   INV-3  — the ApplyReceipt self-reported fields (facts_used etc.) are persisted
//            as telemetry/governance ONLY. No reader in this module gates on them.
//
// Every row is validated against the executable contract (operatorContract.js)
// before insert: a hallucinated key is refused, not ratified (the schema-validation
// half of the trust-the-strong-LLM principle).

import crypto from 'node:crypto';
import { assertMatchesOperatorContract } from './operatorContract.js';
import { linkObject, appendCaseEvent } from './caseManager.js';

const newId = (prefix) => `${prefix}-${crypto.randomUUID()}`;

// Persist a ProposalCard as an immutable row + normalized proposal_targets
// (targets[] joined to preconditions[] for the optimistic-concurrency token) +
// the check report (if preflight has run). Idempotent: a re-persist of the same
// proposal_id no-ops on the card and skips the children (the card is immutable,
// so its children never change either).
export const persistProposalCard = async ({
  client, firmId, clientId, card,
  caseId = null, objectType = null, snapshotId = null, triggerEventId = null,
  modelName = null, promptVersion = null, operatorWords = null, supersedesProposalId = null
} = {}) => {
  if (!client || !firmId || !clientId || !card) return null;
  // Contract gate — throws on a shape/key violation (the shadow wrapper swallows).
  assertMatchesOperatorContract('proposal_card', card);

  const checkStatus = card.checks?.status ?? null;
  const inserted = await client.query(
    `insert into proposal_cards
       (id, firm_id, client_id, case_id, proposal_type, triage_source, plan_id, writer,
        reversibility, review_mode, blast_radius, before_after, before_after_total, detail,
        warnings, check_status, status, supersedes_proposal_id, snapshot_id, trigger_event_id,
        model_name, prompt_version, operator_words, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14::jsonb,
        $15::jsonb, $16, 'proposed', $17, $18, $19, $20, $21, $22, now(), now())
     on conflict (id) do nothing
     returning id`,
    [card.proposal_id, firmId, clientId, caseId, card.type, card.triage_source, card.plan_id,
     card.writer, card.reversibility, card.review_mode, JSON.stringify(card.blast_radius || {}),
     JSON.stringify(card.before_after || []), card.before_after_total ?? 0,
     JSON.stringify(card.detail || {}), JSON.stringify(card.warnings || []), checkStatus,
     supersedesProposalId, snapshotId, triggerEventId, modelName, promptVersion, operatorWords]
  );
  // Card already persisted → it is immutable, so do not re-write its children.
  if (!inserted.rows[0]) return { id: card.proposal_id, created: false };

  // Normalize targets[] + preconditions[] into rows. The precondition's
  // expected_updated_at is the optimistic-concurrency token (= the object's
  // version at proposal time), so a later apply can detect a stale target.
  const preconditionByObject = new Map();
  for (const p of Array.isArray(card.preconditions) ? card.preconditions : []) {
    if (p && p.object != null) preconditionByObject.set(String(p.object), p);
  }
  for (const targetId of Array.isArray(card.targets) ? card.targets : []) {
    const pre = preconditionByObject.get(String(targetId)) || null;
    await client.query(
      `insert into proposal_targets
         (id, firm_id, client_id, proposal_id, object_type, object_id,
          object_version_at_proposal, pre_state_hash, post_state_hash, check_status,
          apply_status, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', now(), now())
       on conflict (proposal_id, object_type, object_id) do nothing`,
      [newId('ptarget'), firmId, clientId, card.proposal_id, objectType, String(targetId),
       pre?.expected_updated_at ?? null, null, null, checkStatus]
    );
  }

  // The check report (append-only). Present only once preflight has run.
  if (card.checks && Array.isArray(card.checks.checks)) {
    await client.query(
      `insert into check_reports
         (id, firm_id, client_id, proposal_id, status, checks, model_name, prompt_version, created_at)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, now())`,
      [newId('checkrep'), firmId, clientId, card.proposal_id, card.checks.status,
       JSON.stringify(card.checks.checks || []), modelName, promptVersion]
    );
  }

  // Proposal↔case link (Phase 3 fold-in of the Phase-2 deferral): when the card
  // belongs to a case, link it (role 'proposal') and record a proposal.created
  // event carrying the card's check_status — so the case renders the PERSISTED
  // verdict (rail #1), never a re-inference. Only on first persist (the card is
  // immutable); the link is idempotent.
  if (caseId) {
    await linkObject({
      client, firmId, clientId, caseId,
      objectType: 'proposal_card', objectId: card.proposal_id, role: 'proposal'
    });
    await appendCaseEvent({
      client, firmId, clientId, caseId,
      eventType: 'proposal.created', actorType: 'system',
      objectType: 'proposal_card', objectId: card.proposal_id,
      proposalId: card.proposal_id, triggerEventId, modelName, promptVersion,
      payload: { proposal_type: card.type, check_status: checkStatus, review_mode: card.review_mode }
    });
  }
  return { id: card.proposal_id, created: true };
};

// Supersede: persist the NEW card (carrying supersedes_proposal_id) and transition
// the OLD card's lifecycle pointer. The old card's content is never touched — the
// supersede chain is the audit trail of how the proposal changed (INV-9).
export const supersedeProposalCard = async ({
  client, firmId, clientId, oldProposalId, newCard, ...rest
} = {}) => {
  if (!client || !firmId || !clientId || !oldProposalId || !newCard) return null;
  const persisted = await persistProposalCard({
    client, firmId, clientId, card: newCard, supersedesProposalId: oldProposalId, ...rest
  });
  if (!persisted) return null;
  await client.query(
    `update proposal_cards
       set status = 'superseded', superseded_by_proposal_id = $2, updated_at = now()
     where id = $1 and status = 'proposed'`,
    [oldProposalId, newCard.proposal_id]
  );
  return persisted;
};

// Persist an ApplyReceipt (append-only) and record the per-target apply outcome
// onto the normalized targets (the controlled apply lifecycle — the card content
// stays immutable). A receipt with no proposal_id (a generation receipt) is
// persisted without touching any targets.
export const persistApplyReceipt = async ({ client, firmId, clientId, receipt, caseId = null } = {}) => {
  if (!client || !firmId || !clientId || !receipt) return null;
  assertMatchesOperatorContract('apply_receipt', receipt);
  const id = newId('receipt');
  await client.query(
    `insert into apply_receipts
       (id, firm_id, client_id, case_id, proposal_id, model, prompt_version, context_snapshot_id,
        candidate_ids_seen, candidate_ids_rejected, facts_available, facts_used, facts_conflicted,
        examples_available, examples_used, playbooks_used, policies_used, checks, final_writer,
        audit_event_ids, rows_touched, per_target, operator_words, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb,
        $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb, $18::jsonb, $19, $20::jsonb,
        $21::jsonb, $22::jsonb, $23, now())`,
    [id, firmId, clientId, caseId, receipt.proposal_id, receipt.model, receipt.prompt_version,
     receipt.context_snapshot_id, JSON.stringify(receipt.candidate_ids_seen || []),
     JSON.stringify(receipt.candidate_ids_rejected || []), JSON.stringify(receipt.facts_available || []),
     JSON.stringify(receipt.facts_used || []), JSON.stringify(receipt.facts_conflicted || []),
     JSON.stringify(receipt.examples_available || []), JSON.stringify(receipt.examples_used || []),
     JSON.stringify(receipt.playbooks_used || []), JSON.stringify(receipt.policies_used || []),
     receipt.checks ? JSON.stringify(receipt.checks) : null, receipt.final_writer,
     JSON.stringify(receipt.audit_event_ids || []), JSON.stringify(receipt.rows_touched || []),
     JSON.stringify(receipt.per_target || []), receipt.operator_words]
  );

  if (receipt.proposal_id) {
    let anyApplied = false;
    for (const pt of Array.isArray(receipt.per_target) ? receipt.per_target : []) {
      if (pt.applied) anyApplied = true;
      await client.query(
        `update proposal_targets
           set apply_status = $3, apply_error = $4, updated_at = now()
         where proposal_id = $1 and object_id = $2`,
        [receipt.proposal_id, String(pt.target), pt.applied ? 'applied' : 'failed', pt.error ?? null]
      );
    }
    if (anyApplied) {
      await client.query(
        `update proposal_cards set status = 'applied', updated_at = now()
         where id = $1 and status = 'proposed'`,
        [receipt.proposal_id]
      );
    }
  }
  return { id };
};

// Read-only debug reader (NOT mounted in user UI — the proposal UI mounts on the
// live feed when it ships, rail #4). The card + its normalized targets, check
// reports, and apply receipts.
export const getProposalCardSnapshot = async ({ client, proposalId } = {}) => {
  if (!client || !proposalId) return null;
  const card = await client.query(`select * from proposal_cards where id = $1 limit 1`, [proposalId]);
  if (!card.rows[0]) return null;
  const targets = await client.query(
    `select object_type, object_id, object_version_at_proposal, check_status, apply_status, apply_error
       from proposal_targets where proposal_id = $1 order by created_at asc, id asc`,
    [proposalId]
  );
  const reports = await client.query(
    `select status, checks, model_name, prompt_version, created_at
       from check_reports where proposal_id = $1 order by created_at asc, id asc`,
    [proposalId]
  );
  const receipts = await client.query(
    `select id, model, final_writer, per_target, created_at
       from apply_receipts where proposal_id = $1 order by created_at asc, id asc`,
    [proposalId]
  );
  return {
    card: card.rows[0],
    targets: targets.rows,
    check_reports: reports.rows,
    apply_receipts: receipts.rows
  };
};

const ownerIntentCandidateFromRow = (row = {}, memoryCandidateByProposalId = new Map(), preflightByProposalId = new Map()) => {
  const detail = row.detail && typeof row.detail === 'object' ? row.detail : {};
  const object = detail.object && typeof detail.object === 'object' ? detail.object : {};
  const memoryCandidate = memoryCandidateByProposalId.get(row.id) || null;
  const preflight = preflightByProposalId.get(row.id) || null;
  return {
    proposal_id: row.id,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    intent_kind: object.kind || null,
    summary: object.summary || null,
    parse_confidence: object.parse_confidence || null,
    triage_source: row.triage_source || null,
    review_mode: row.review_mode || null,
    check_status: row.check_status || null,
    source_message_id: detail.source_message_id || detail.source_message?.id || null,
    compile_id: detail.compile_id || null,
    memory_candidate: memoryCandidate ? {
      id: memoryCandidate.id,
      status: memoryCandidate.status || null,
      target_contract: memoryCandidate.target_contract || 'firm_fact',
      candidate_type: memoryCandidate.candidate_type || null
    } : null,
    preflight,
    warnings: Array.isArray(row.warnings) ? row.warnings : [],
    unmet_capability_needs: Array.isArray(detail.unmet_capability_needs) ? detail.unmet_capability_needs : []
  };
};

// Read-only owner-intent inbox projection. These rows are staged by
// ownerIntentRuntime behind INTENT_OBJECT_ROUTING and remain proposals: this reader
// exposes what Donna understood without applying, promoting, or materializing any
// candidate. It soft-fails on pre-034 stores so the owner-chat GET keeps its
// existing availability posture during staged deploys.
export const listOwnerIntentProposalCards = async ({
  client, firmId, clientId, status = 'proposed', limit = 20
} = {}) => {
  if (!client || !firmId || !clientId) return [];
  const statuses = ['proposed', 'applied', 'superseded', 'withdrawn', 'expired'];
  if (status != null && !statuses.includes(status)) return [];
  const bounded = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const params = [firmId, clientId];
  let statusFilter = '';
  if (status) {
    params.push(status);
    statusFilter = ` and status = $${params.length}`;
  }
  params.push(bounded);
  const result = await client.query(
    `select id, status, proposal_type, triage_source, review_mode, check_status,
            detail, warnings, created_at, updated_at
       from proposal_cards
      where firm_id = $1 and client_id = $2
        and proposal_type = 'owner_intent_candidate'${statusFilter}
      order by created_at desc, id desc
      limit $${params.length}`,
    params
  ).catch((error) => {
    if (error?.code === '42P01' || error?.code === '42703') return { rows: [] };
    throw error;
  });
  const proposalIds = result.rows.map((row) => row.id).filter(Boolean);
  let memoryCandidateByProposalId = new Map();
  if (proposalIds.length) {
    const memoryRows = await client.query(
      `select id, status, candidate_type, target_contract, provenance->>'proposal_id' as proposal_id
         from memory_candidates
        where firm_id = $1 and client_id = $2
          and provenance->>'proposal_id' = any($3::text[])
        order by created_at desc, id desc`,
      [firmId, clientId, proposalIds]
    ).catch((error) => {
      if (error?.code === '42P01' || error?.code === '42703') return { rows: [] };
      throw error;
    });
    for (const row of memoryRows.rows) {
      if (row?.proposal_id && !memoryCandidateByProposalId.has(row.proposal_id)) {
        memoryCandidateByProposalId.set(row.proposal_id, row);
      }
    }
  }
  let preflightByProposalId = new Map();
  if (proposalIds.length) {
    const preflightRows = await client.query(
      `select distinct on (proposal_id) proposal_id, status, checks, created_at
         from check_reports
        where firm_id = $1 and client_id = $2
          and proposal_id = any($3::text[])
          and checks @> $4::jsonb
        order by proposal_id, created_at desc, id desc`,
      [firmId, clientId, proposalIds, JSON.stringify([{ name: 'owner_intent_accept_preflight' }])]
    ).catch((error) => {
      if (error?.code === '42P01' || error?.code === '42703') return { rows: [] };
      throw error;
    });
    for (const row of preflightRows.rows) {
      const checks = Array.isArray(row.checks) ? row.checks : [];
      const check = checks.find((entry) => entry?.name === 'owner_intent_accept_preflight') || null;
      if (row?.proposal_id && check) {
        preflightByProposalId.set(row.proposal_id, {
          status: row.status || check.status || null,
          blockers: Array.isArray(check.blockers) ? check.blockers : [],
          required_capabilities: Array.isArray(check.required_capabilities) ? check.required_capabilities : [],
          authority: check.authority || null,
          consequence_diff: check.consequence_diff || null,
          apply_plan: check.apply_plan || null,
          execution_gate: check.execution_gate || null,
          actor: check.actor || null,
          created_at: row.created_at || null
        });
      }
    }
  }
  return result.rows.map((row) => ownerIntentCandidateFromRow(row, memoryCandidateByProposalId, preflightByProposalId));
};

export const getOwnerIntentProposalCardForPreflight = async ({
  client, firmId, clientId, proposalId
} = {}) => {
  if (!client || !firmId || !clientId || !proposalId) return null;
  const result = await client.query(
    `select id, firm_id, client_id, status, proposal_type, triage_source, review_mode,
            check_status, detail, warnings, before_after, before_after_total, created_at, updated_at
       from proposal_cards
      where firm_id = $1 and client_id = $2 and id = $3
      limit 1`,
    [firmId, clientId, proposalId]
  ).catch((error) => {
    if (error?.code === '42P01' || error?.code === '42703') return { rows: [] };
    throw error;
  });
  return result.rows[0] || null;
};

export const recordOwnerIntentPreflightReport = async ({
  client, firmId, clientId, proposalId, report, modelName = null, promptVersion = null
} = {}) => {
  if (!client || !firmId || !clientId || !proposalId || !report) return null;
  await client.query(
    `insert into check_reports
       (id, firm_id, client_id, proposal_id, status, checks, model_name, prompt_version, created_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, now())`,
    [newId('checkrep'), firmId, clientId, proposalId, report.status, JSON.stringify(report.checks || []), modelName, promptVersion]
  );
  await client.query(
    `update proposal_cards
        set check_status = $4, updated_at = now()
      where firm_id = $1 and client_id = $2 and id = $3
        and proposal_type = 'owner_intent_candidate'
        and status = 'proposed'`,
    [firmId, clientId, proposalId, report.status]
  );
  return { proposal_id: proposalId, status: report.status };
};

export const withdrawOwnerIntentProposalCard = async ({
  client,
  firmId,
  clientId,
  proposalId,
  actor = null,
  reason = 'owner_skipped'
} = {}) => {
  if (!client || !firmId || !clientId || !proposalId) {
    return { status: 'refused', reason: 'missing_inputs', statusCode: 400 };
  }
  const updated = await client.query(
    `update proposal_cards
        set status = 'withdrawn',
            check_status = 'requires_review',
            updated_at = now()
      where firm_id = $1 and client_id = $2 and id = $3
        and proposal_type = 'owner_intent_candidate'
        and status = 'proposed'
      returning id, status`,
    [firmId, clientId, proposalId]
  ).catch((error) => {
    if (error?.code === '42P01' || error?.code === '42703') return { rows: [] };
    throw error;
  });
  if (!updated.rows.length) {
    return { status: 'refused', reason: 'proposal_not_reviewable', statusCode: 404 };
  }
  const normalizedReason = String(reason || 'owner_skipped').slice(0, 200);
  await client.query(
    `insert into check_reports
       (id, firm_id, client_id, proposal_id, status, checks, created_at)
     values ($1, $2, $3, $4, 'requires_review', $5::jsonb, now())`,
    [newId('checkrep'), firmId, clientId, proposalId, JSON.stringify([{
      name: 'owner_intent_owner_withdrawn',
      status: 'requires_review',
      detail: 'Owner skipped this staged owner-intent proposal; no mutation, authority grant, or memory promotion was applied.',
      reason: normalizedReason,
      actor: actor ? {
        actor_id: actor.actor_id || null,
        actor_type: actor.actor_type || 'owner',
        basis: actor.basis || null,
        unknown: Boolean(actor.unknown)
      } : null
    }])]
  );
  return { status: 'withdrawn', proposal_id: proposalId, reason: normalizedReason };
};

// Bulk reader for the reverse EXECUTOR (pod-safety #2): the cards that carry a captured
// before_after (before_after_total > 0) — the only ones a reverse can restore from — scoped
// to the firm + client. `proposalIds` (when given) restricts to those explicit cards; without
// it, returns the most recent reversible cards up to `limit`. firm_id + client_id are always
// bound so a reverse can never reach across a scope boundary. Returns the minimal shape the
// planner needs: { proposal_id, writer, before_after, status, proposal_type, created_at } —
// `writer` is the named writer the apply routed through; the planner fail-closes on any
// writer it can't restore through (reverseExecutor.REVERSE_SUPPORTED_WRITERS).
export const loadReversibleProposalCards = async ({
  client, firmId, clientId, proposalIds = null, limit = 100
} = {}) => {
  if (!client || !firmId || !clientId) return [];
  const params = [firmId, clientId];
  let idFilter = '';
  if (Array.isArray(proposalIds) && proposalIds.length) {
    params.push(proposalIds.map(String));
    idFilter = ` and id = any($${params.length}::text[])`;
  }
  params.push(Math.max(1, Math.min(Number(limit) || 100, 500)));
  const result = await client.query(
    `select id, proposal_type, status, writer, before_after, before_after_total, created_at
       from proposal_cards
      where firm_id = $1 and client_id = $2
        and before_after_total > 0${idFilter}
      order by created_at desc, id desc
      limit $${params.length}`,
    params
  );
  return result.rows.map((row) => ({
    proposal_id: row.id,
    proposal_type: row.proposal_type,
    status: row.status,
    writer: row.writer ?? null,
    before_after: Array.isArray(row.before_after) ? row.before_after : [],
    before_after_total: row.before_after_total,
    created_at: row.created_at
  }));
};
