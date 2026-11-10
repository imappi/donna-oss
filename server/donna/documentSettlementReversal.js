// The LATE-BANK-LINE REVERSAL GUARD, producer half
// (docs/donna-settlement-answer-and-ledger-entry-plan.md §3's named follow-up,
// built 2026-07-21; detection half: firmDb.applyDocumentPaymentStatusAfterMatch).
//
// THE POPULATION: documents the settlement lane booked as owner-funded
// (payload.settlement_entry.journal_id — DR expense / CR owner funds 901)
// that NOW carry a settled bank-line match (confirmed/auto_matched): the
// owner said "cash" and was wrong — the charge DID hit the feed. Left alone,
// the settlement entry plus the coded bank line double-count the expense.
//
// THE CORRECTION is a REVERSAL JOURNAL via the existing named writer
// postLedgerAdjustmentInDb (reverseOriginal: true — full lineage:
// reversal_of_journal_id / correction_reason). Never silently double-count,
// never auto-un-post (the reverseExecutor disposition precedent: deletion or
// mutation of posted journals is always wrong; reversal journals only).
//
// DETERMINISTIC, KEEP-LAYER: no model call anywhere in this module. The
// trigger is a persisted marker plus a settled match — arithmetic-grade
// evidence, no judgment to delegate. The gather DERIVES the condition from
// the documents × reconciliation_matches join (never from the detection
// marker alone), so confirm paths that bypass the payment-status funnel
// (e.g. the reply-evidence auto-link) are still covered.
//
// AUTHORITY (decide-and-notify): the owner's own bank statement outranks the
// owner's earlier word — the settled match IS the evidence the entry was
// wrong. authority_basis 'confirmed_bank_line_match' rides the card, the doc
// payload, and the audit. The owner FYI ("this receipt also appeared on your
// statement, so we reversed the paid-from-your-own-funds entry and booked it
// against the bank line - reply if that is wrong") rides the ask-batch digest
// off settlement_entry.reversal.owner_notified:false, the exact
// settlement-entry FYI pattern one lane further.
//
// GATING: rides DOCUMENT_SETTLEMENT_LEDGER_ENTRY, deliberately NOT its own
// flag (the 4a "one flag ⇒ the question and its answer are live together"
// precedent): an entry can only exist where that flag acted, and a
// separately-staged guard could lag the entry lane and re-open the silent
// double-count it exists to close. ∅/off ⇒ inert; shadow ⇒ cards minted,
// NO ledger write; canary/auto ⇒ reverse + FYI.
//
// IDEMPOTENCY is DERIVED, never marker-trusted: before any post, the guard
// checks ledger_journals for an existing reversal (reversal_of_journal_id =
// the settlement journal). postLedgerAdjustmentInDb's correction key is
// timestamped (NOT idempotent across calls), so a reversal that posted but
// whose doc-marker merge failed would otherwise double-reverse on the next
// sweep — instead it SELF-HEALS: merge the marker off the found journal and
// move on. The doc marker (settlement_entry.reversal) is the render surface
// and the FYI trigger; the ledger row is the source of truth.
//
// WIRING: called from loopsShadowProducers (runDocumentTerminalDrain +
// onReconciliationRunCompleted, after the settlement-entry producer) and
// post-commit from the two interactive match-confirm writers in firmDb
// (scoped to the confirmed doc, only when detection fired). NEVER throws;
// per-doc failures roll back that doc's txn and continue. firmDb is imported
// DYNAMICALLY at run time (cycle safety — the documentSettlementEntry
// precedent).
//
// NAMED EDGE (deliberately out of scope, do not lose): if the owner replies
// "that match is wrong" and the match is REJECTED after the reversal posted,
// the books are left with no expense entry for the doc (settlement entry
// reversed, bank line back to needs_review). The entry gather excludes docs
// whose settlement_entry.journal_id is set, so no re-entry mints. The
// reject path already regresses the goal and suspends covering grants; the
// re-entry loop for this rare double-correction is a follow-up slice.

import { clientFlagActs, clientFlagObserves, readClientConfigSnapshot } from './clientConfig.js';
import { summarizeCheckReport, proposalCardIsAppliable } from './operatorContract.js';
import { persistProposalCard, persistApplyReceipt } from './proposalStore.js';
import {
  DOCUMENT_SETTLEMENT_LEDGER_ENTRY_FLAG_KEY,
  DOCUMENT_SETTLEMENT_REVERSAL_PROPOSAL_TYPE,
  documentSettlementReversalProposalId
} from './documentDispositionShape.js';

export {
  DOCUMENT_SETTLEMENT_REVERSAL_PROPOSAL_TYPE,
  documentSettlementReversalProposalId
} from './documentDispositionShape.js';

const LOG_TAG = 'documentSettlementReversal';

// Bounded per sweep (re-entrant — the next sweep picks up the rest).
const REVERSAL_SWEEP_LIMIT = 20;

export const SETTLEMENT_REVERSAL_AUTHORITY_BASIS = 'confirmed_bank_line_match';

const ZERO_STATS = () => ({
  gathered: 0,
  cards_minted: 0,
  cards_existing: 0,
  reversed: 0,
  self_healed: 0,
  rested_proposed: 0,
  post_failures: 0,
  needs_person: 0,
  needs_person_document_ids: [],
  reversed_document_ids: [],
  mode: 'shadow',
  disabled: false,
  disabled_reason: null
});
const DISABLED_STATS = (reason) => ({ ...ZERO_STATS(), disabled: true, disabled_reason: reason });

// The gather: entry-settled docs (journal marker present, no reversal yet)
// that carry a settled bank-line match. DERIVED from the join — never from
// the detection marker — so every confirm path is covered (module header).
const GATHER_SQL = `
  select d.id, d.document_type, d.vendor_name, d.customer_name, d.filename,
         d.total_amount, d.currency, d.document_date, d.payment_status, d.updated_at,
         d.payload->'settlement_entry' as settlement_entry,
         m.id as match_id, m.bank_transaction_id, m.status as match_status
    from documents d
    join lateral (
      select m.id, m.bank_transaction_id, m.status
        from reconciliation_matches m
       where m.firm_id = d.firm_id
         and m.matched_object_id = d.id
         and m.matched_object_type <> 'bank_line'
         and m.status in ('confirmed', 'auto_matched')
       order by m.updated_at desc
       limit 1
    ) m on true
   where d.firm_id = $1 and d.client_id = $2
     and coalesce(d.payload->'settlement_entry'->>'journal_id', '') <> ''
     and d.payload->'settlement_entry'->'reversal' is null
     -- A refusal only a person can resolve leaves the sweep until a reversal
     -- of the settlement journal exists (then the self-heal below merges it).
     and (d.payload->'settlement_entry'->'reversal_refusal' is null
       or exists (select 1 from ledger_journals j where j.firm_id = d.firm_id and j.client_id = d.client_id
         and j.reversal_of_journal_id = d.payload->'settlement_entry'->>'journal_id' and j.status in ('posted', 'closed')))
     and ($3::text[] is null or d.id = any($3::text[]))
   order by d.document_date nulls last, d.id
   limit ${REVERSAL_SWEEP_LIMIT}`;

// The adjustment writer's refusals that only a person can resolve: the
// settlement journal sits in a filed VAT return and the reversal moves its tax
// codes, or the reversal's own date falls inside a filed return. Donna never
// acknowledges a filed return for herself. The refusal is recorded once on the
// document (settlement_entry.reversal_refusal, with
// late_bank_line.needs_ledger_adjustment true), on the card's target (a failed apply
// receipt) and in an audit row; later sweeps do not post again. A person's own
// reversal through the adjustment route is then found by the derived
// idempotency check above and self-heals the marker.
export const SETTLEMENT_REVERSAL_PERSON_REQUIRED_CODES = Object.freeze([
  'LEDGER_ADJUSTMENT_RESTATES_FILED_RETURN',
  'LEDGER_ADJUSTMENT_DATE_IN_FILED_RETURN'
]);

const recordPersonRequiredRefusal = async ({ client, firmId, clientId, document, settlementEntry, proposalId, error }) => {
  const refusal = { code: error.code, message: error.message || null, details: error.details || null,
    refused_at: new Date().toISOString() };
  const updated = await client.query(
    `update documents
        set payload = jsonb_set(
              jsonb_set(payload, '{settlement_entry,reversal_refusal}', $4::jsonb, true),
              '{settlement_entry,late_bank_line}',
              coalesce(payload->'settlement_entry'->'late_bank_line', '{}'::jsonb) || '{"needs_ledger_adjustment": true}'::jsonb,
              true),
            updated_at = now()
      where id = $1 and firm_id = $2 and client_id = $3
        and payload->'settlement_entry'->'reversal' is null
        and payload->'settlement_entry'->'reversal_refusal' is null
      returning id`,
    [document.id, firmId, clientId, JSON.stringify(refusal)]
  );
  if (!updated.rows.length) return { recorded: false };
  const audit = await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
     values ($1, $2, 'system', 'ledger.document_settlement_reversal_refused', 'document', $3, $4::jsonb)
     returning id`,
    [firmId, clientId, document.id, JSON.stringify({
      original_journal_id: settlementEntry?.journal_id || null,
      needs_ledger_adjustment: true,
      refusal_code: refusal.code,
      refusal_details: refusal.details
    })]
  );
  await persistApplyReceipt({
    client, firmId, clientId,
    receipt: {
      proposal_id: proposalId,
      model: '',
      prompt_version: null,
      context_snapshot_id: null,
      candidate_ids_seen: [String(document.id)],
      candidate_ids_rejected: [],
      facts_available: [],
      facts_used: [],
      facts_conflicted: [],
      examples_available: [],
      examples_used: [],
      playbooks_used: [],
      policies_used: [],
      checks: null,
      final_writer: 'postLedgerAdjustmentInDb',
      audit_event_ids: audit.rows[0]?.id != null ? [String(audit.rows[0].id)] : [],
      rows_touched: [String(document.id)],
      per_target: [{ target: String(document.id), applied: false, error: refusal.code }],
      operator_words: null
    }
  });
  return { recorded: true };
};

const reversalReasonFor = (document, match) => {
  const counterparty = document?.vendor_name || document?.customer_name || 'this receipt';
  return `Late bank line: ${counterparty} also settled through the bank feed `
    + `(match ${match?.match_id || 'unknown'}, bank line ${match?.bank_transaction_id || 'unknown'}). `
    + `Reversing the owner-funds settlement entry so the expense books once, against the bank line.`;
};

const buildReversalChecks = ({ settlementJournalRow, match }) => summarizeCheckReport([
  {
    name: 'settlement_journal_posted',
    status: settlementJournalRow && ['posted', 'closed'].includes(settlementJournalRow.status) ? 'pass' : 'fail',
    detail: settlementJournalRow && ['posted', 'closed'].includes(settlementJournalRow.status)
      ? null
      : 'The settlement journal the document\'s marker names is missing or not posted.'
  },
  {
    name: 'settled_bank_line_match',
    status: match?.match_id ? 'pass' : 'fail',
    detail: match?.match_id ? null : 'No settled bank-line match found for this document.'
  }
]);

const buildReversalProposalCard = ({ document, settlementEntry, match, checks, reason }) => {
  const amount = Number(document?.total_amount || 0);
  return {
    proposal_id: documentSettlementReversalProposalId(document.id),
    type: DOCUMENT_SETTLEMENT_REVERSAL_PROPOSAL_TYPE,
    // Same intent home as the entry card: a system-produced correction of the
    // books' state, not an operator utterance.
    triage_source: 'state_correction',
    plan_id: null,
    targets: [String(document.id)],
    blast_radius: {
      transactions: 1,
      documents: 1,
      decided_rows: 0,
      client_visible: true,
      unattended_future_behavior: false
    },
    writer: 'postLedgerAdjustmentInDb',
    reversibility: 'reversible_via_adjustment',
    before_after: [{
      target: String(document.id),
      before: {
        settlement_journal_id: settlementEntry?.journal_id || null,
        settlement_reversal: null
      },
      after: {
        settlement_journal_id: settlementEntry?.journal_id || null,
        settlement_reversal: `Reversal journal of ${settlementEntry?.journal_id || 'the settlement entry'} `
          + `(DR ${settlementEntry?.owner_funds_account || 'owner funds'} / CR ${settlementEntry?.expense_account || 'expense'} `
          + `${amount} ${document.currency || ''})`.trim()
      }
    }],
    before_after_total: 1,
    checks,
    preconditions: [{
      object: String(document.id),
      expected_settlement_journal_id: settlementEntry?.journal_id || null,
      expected_updated_at: document.updated_at ? new Date(document.updated_at).toISOString() : null
    }],
    review_mode: 'accountant_approval',
    detail: {
      settlement_journal_id: settlementEntry?.journal_id || null,
      match_id: match?.match_id || null,
      bank_transaction_id: match?.bank_transaction_id || null,
      match_status: match?.match_status || null,
      amount,
      currency: document.currency || '',
      expense_account: settlementEntry?.expense_account || null,
      owner_funds_account: settlementEntry?.owner_funds_account || null,
      settlement_channel: settlementEntry?.settlement_channel || null,
      authority_basis: SETTLEMENT_REVERSAL_AUTHORITY_BASIS,
      reason
    },
    warnings: []
  };
};

// Merge the reversal marker onto the document + the doc-scoped audit, inside
// the caller's open transaction. The marker is the render surface and the
// FYI trigger (owner_notified: false → the digest gathers it); the guarded
// WHERE keeps it write-once. Returns the audit event id (audit-as-
// precondition: a failed audit aborts the caller's txn).
const mergeReversalMarker = async ({
  client, firmId, clientId, document, settlementEntry, match,
  reversalJournalId, reason, selfHealed = false
}) => {
  const reversal = {
    journal_id: reversalJournalId,
    posted_at: new Date().toISOString(),
    match_id: match?.match_id || null,
    bank_transaction_id: match?.bank_transaction_id || null,
    authority_basis: SETTLEMENT_REVERSAL_AUTHORITY_BASIS,
    reason: 'late_bank_line',
    // The decide-and-notify FYI marker: gathered by the ask-batch draft
    // while 'false', flipped true at the single send chokepoint.
    owner_notified: false
  };
  const updated = await client.query(
    `update documents
        set payload = jsonb_set(
              jsonb_set(payload, '{settlement_entry,reversal}', $4::jsonb, true),
              '{settlement_entry,late_bank_line}',
              coalesce(payload->'settlement_entry'->'late_bank_line', '{}'::jsonb) || $5::jsonb,
              true),
            updated_at = now()
      where id = $1 and firm_id = $2 and client_id = $3
        and coalesce(payload->'settlement_entry'->>'journal_id', '') <> ''
        and payload->'settlement_entry'->'reversal' is null
      returning id`,
    [
      document.id,
      firmId,
      clientId,
      JSON.stringify(reversal),
      JSON.stringify({ needs_ledger_adjustment: false, resolved_at: reversal.posted_at })
    ]
  );
  if (!updated.rows.length) return { auditEventId: null, merged: false };
  const audit = await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
     values ($1, $2, 'system', 'ledger.reverse_document_settlement', 'document', $3, $4::jsonb)
     returning id`,
    [firmId, clientId, document.id, JSON.stringify({
      reversal_journal_id: reversalJournalId,
      original_journal_id: settlementEntry?.journal_id || null,
      match_id: match?.match_id || null,
      bank_transaction_id: match?.bank_transaction_id || null,
      authority_basis: SETTLEMENT_REVERSAL_AUTHORITY_BASIS,
      self_healed: selfHealed,
      reason,
      before_state: { settlement_entry: settlementEntry || null }
    })]
  );
  return {
    auditEventId: audit.rows[0]?.id != null ? String(audit.rows[0].id) : null,
    merged: true
  };
};

// Sweep one client's entry-settled-then-bank-matched documents. Flag-gated on
// the plane (∅ inert); `documentIds` scopes to a confirm's target (null =
// full backlog sweep). Each doc's marker merge (+ receipt) commits atomically
// per doc; the reversal post itself runs through the pooled named writer
// (its own transaction — the ledger row, not the doc marker, is the
// idempotency source of truth). NEVER throws.
export const runDocumentSettlementReversalsForClient = async ({
  client,
  firmId,
  clientId,
  documentIds = null,
  env = process.env,
  // Test seam; defaults to the dynamically-imported firmDb writer (cycle safety).
  postAdjustmentFn = null
} = {}) => {
  const stats = ZERO_STATS();
  try {
    if (!client || !firmId || !clientId) return DISABLED_STATS('missing_ids');

    const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
    const flag = {
      flagKey: DOCUMENT_SETTLEMENT_LEDGER_ENTRY_FLAG_KEY,
      snapshot,
      envFallback: () => false, // born on the plane — a DB stage row is the ONLY on
      env
    };
    if (!clientFlagObserves(flag)) return DISABLED_STATS('flag_off');
    stats.mode = clientFlagActs(flag) ? 'act' : 'shadow';

    const scoped = Array.isArray(documentIds)
      ? documentIds.map((id) => String(id)).filter(Boolean)
      : null;
    if (scoped && !scoped.length) return stats;

    const gathered = await client.query(GATHER_SQL, [firmId, clientId, scoped]);
    const candidates = gathered.rows || [];
    stats.gathered = candidates.length;
    if (!candidates.length) return stats;

    const postFn = postAdjustmentFn
      || (async (args) => (await import('./firmDb.js')).postLedgerAdjustmentInDb(args));

    for (const document of candidates) {
      const settlementEntry = document.settlement_entry || {};
      const settlementJournalId = settlementEntry.journal_id || null;
      const match = {
        match_id: document.match_id || null,
        bank_transaction_id: document.bank_transaction_id || null,
        match_status: document.match_status || null
      };
      const proposalId = documentSettlementReversalProposalId(document.id);
      const reason = reversalReasonFor(document, match);
      try {
        // Derived idempotency FIRST (module header): an already-posted
        // reversal of this settlement journal means only the doc marker is
        // missing — self-heal it, never post twice.
        const existingReversal = await client.query(
          `select id from ledger_journals
            where firm_id = $1 and client_id = $2
              and reversal_of_journal_id = $3
              and status in ('posted', 'closed')
            order by created_at desc
            limit 1`,
          [firmId, clientId, settlementJournalId]
        );
        const existingReversalId = existingReversal.rows[0]?.id || null;
        if (existingReversalId) {
          await client.query('begin');
          try {
            await mergeReversalMarker({
              client, firmId, clientId, document, settlementEntry, match,
              reversalJournalId: existingReversalId, reason, selfHealed: true
            });
            await client.query('commit');
            stats.self_healed += 1;
          } catch (error) {
            await client.query('rollback');
            stats.post_failures += 1;
            console.warn(`[${LOG_TAG}] self-heal marker merge failed`, {
              document_id: document.id,
              error: error?.message || String(error)
            });
          }
          continue;
        }

        // The settlement journal must actually exist and be posted before a
        // reversal can reference it (a missing journal is a broken marker —
        // surfaced by the failed check on the card, never guessed around).
        const journalResult = await client.query(
          `select id, status from ledger_journals
            where firm_id = $1 and client_id = $2 and id = $3
            limit 1`,
          [firmId, clientId, settlementJournalId]
        );
        const settlementJournalRow = journalResult.rows[0] || null;
        const checks = buildReversalChecks({ settlementJournalRow, match });
        const card = buildReversalProposalCard({ document, settlementEntry, match, checks, reason });

        // Card idempotency: an existing card is the persisted proposal.
        const existingCard = await client.query(
          `select id, status, check_status, detail
             from proposal_cards
            where id = $1 and firm_id = $2 and client_id = $3
            limit 1`,
          [proposalId, firmId, clientId]
        );
        const existing = existingCard.rows[0] || null;
        if (existing) {
          stats.cards_existing += 1;
        } else {
          // The card commits in its OWN transaction BEFORE any post: it is
          // the durable receipt, so a failed post leaves a visible proposed
          // card and the next sweep retries off the persisted state.
          await client.query('begin');
          try {
            const minted = await persistProposalCard({
              client, firmId, clientId, card, objectType: 'document', modelName: null
            });
            if (minted?.created) stats.cards_minted += 1;
            await client.query('commit');
          } catch (error) {
            await client.query('rollback');
            stats.post_failures += 1;
            console.warn(`[${LOG_TAG}] card mint failed`, {
              document_id: document.id,
              error: error?.message || String(error)
            });
            continue;
          }
        }

        if (stats.mode !== 'act') continue;
        // A recorded person-required refusal: a person posts this reversal.
        if (SETTLEMENT_REVERSAL_PERSON_REQUIRED_CODES.includes(settlementEntry.reversal_refusal?.code)) {
          stats.needs_person += 1;
          stats.needs_person_document_ids.push(String(document.id));
          continue;
        }
        const appliable = checks.status === 'pass' && proposalCardIsAppliable(card);
        if (!appliable) {
          stats.rested_proposed += 1;
          continue;
        }

        // The reversal post — the pooled named writer owns its transaction
        // (locked-period assert, lineage columns, ledger.adjustment_posted
        // audit, export-correction grant suspension all inside it).
        let adjustment = null;
        try {
          adjustment = await postFn({
            firmId,
            clientId,
            originalJournalId: settlementJournalId,
            reason,
            lines: [],
            reverseOriginal: true,
            actorId: 'system'
          });
        } catch (error) {
          if (SETTLEMENT_REVERSAL_PERSON_REQUIRED_CODES.includes(error?.code)) {
            await client.query('begin');
            try {
              await recordPersonRequiredRefusal({ client, firmId, clientId, document, settlementEntry, proposalId, error });
              await client.query('commit');
              stats.needs_person += 1;
              stats.needs_person_document_ids.push(String(document.id));
            } catch (recordError) {
              await client.query('rollback');
              stats.post_failures += 1;
              console.warn(`[${LOG_TAG}] person-required refusal record failed`, {
                document_id: document.id,
                error: recordError?.message || String(recordError)
              });
            }
            continue;
          }
          stats.post_failures += 1;
          console.warn(`[${LOG_TAG}] reversal post failed (card rests proposed)`, {
            document_id: document.id,
            settlement_journal_id: settlementJournalId,
            error: error?.message || String(error)
          });
          continue;
        }
        const reversalJournalId = adjustment?.ledger_adjustment?.journals?.[0]?.ledger_journal_id || null;
        if (!reversalJournalId) {
          stats.post_failures += 1;
          console.warn(`[${LOG_TAG}] reversal post returned no journal id`, { document_id: document.id });
          continue;
        }

        // Marker merge + doc audit + apply receipt, atomic per doc. If this
        // fails after the post committed, the NEXT sweep's derived
        // idempotency check self-heals off the ledger row (module header).
        await client.query('begin');
        try {
          const { auditEventId } = await mergeReversalMarker({
            client, firmId, clientId, document, settlementEntry, match,
            reversalJournalId, reason
          });
          await persistApplyReceipt({
            client, firmId, clientId,
            receipt: {
              proposal_id: proposalId,
              model: '',
              prompt_version: null,
              context_snapshot_id: null,
              candidate_ids_seen: [String(document.id)],
              candidate_ids_rejected: [],
              facts_available: [],
              facts_used: [],
              facts_conflicted: [],
              examples_available: [],
              examples_used: [],
              playbooks_used: [],
              policies_used: [],
              checks,
              final_writer: 'postLedgerAdjustmentInDb',
              audit_event_ids: auditEventId ? [auditEventId] : [],
              rows_touched: [reversalJournalId, String(document.id)].filter(Boolean),
              per_target: [{ target: String(document.id), applied: true, error: null }],
              operator_words: null
            }
          });
          await client.query('commit');
          stats.reversed += 1;
          stats.reversed_document_ids.push(String(document.id));
        } catch (error) {
          await client.query('rollback');
          stats.post_failures += 1;
          console.warn(`[${LOG_TAG}] reversal marker merge failed (self-heals next sweep)`, {
            document_id: document.id,
            reversal_journal_id: reversalJournalId,
            error: error?.message || String(error)
          });
        }
      } catch (error) {
        stats.post_failures += 1;
        console.warn(`[${LOG_TAG}] reversal failed; doc left as-is`, {
          document_id: document.id,
          error: error?.message || String(error)
        });
      }
    }

    return stats;
  } catch (error) {
    console.warn(`[${LOG_TAG}] sweep failed (no-throw contract)`, {
      firm_id: firmId,
      client_id: clientId,
      error: error?.message || String(error)
    });
    return { ...stats, disabled: true, disabled_reason: 'producer_error' };
  }
};

// Test-only exports.
export const __GATHER_SQL = GATHER_SQL;
export const __buildReversalProposalCard = buildReversalProposalCard;
export const __buildReversalChecks = buildReversalChecks;
export const __reversalReasonFor = reversalReasonFor;
