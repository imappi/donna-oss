// Donna Inventory I4·posting — P5 ledger-posting gateway (design §9, D-POST-6 Option B).
//
// The ONE sanctioned route from a NEW domain writer to the shared ledger primitive, so a
// new module (inventory posting) never grows firmDb.js and never forks a second accounting
// backend (INV-1: the grammar is a router, never a second backend). It is a THIN ASSEMBLER
// of already-exported firmDb.js primitives — the balance guard, the period-lock guards, and
// the ONE journal-insert discipline every other post uses — plus a generic, opt-in ledger
// audit hook. It adds no accounting logic of its own; the Keep-layer guards refuse, they
// never shade.
//
// writeValidatedJournalWithinTransaction(tx, journal, context) NEVER begins/commits — the
// caller (the inventory executor's postInventoryJournalWithinTransaction) owns the
// transaction so the journal insert, the attempt row, the ApplyReceipt, and the audit all
// share one atomic unit (audit-as-precondition, §9 step 9). It is the same discipline as
// postDocumentSettlementJournalWithClient / postSupplierBillJournalWithClient, generalized:
//   1. assertCorrectionLinesBalance — Σdebit == Σcredit > 0, or refuse (LEDGER_CORRECTION_UNBALANCED).
//   2. Locked-period discipline (the "post a dated adjustment" 409s):
//      a. an EXISTING journal for this natural key that already sits inside a locked close
//         period is IMMUTABLE — refuse LEDGER_LOCKED_PERIOD_IMMUTABLE (never re-post over it).
//      b. a NEW journal_date inside a locked period refuses via assertJournalDateNotLocked
//         (LEDGER_ADJUSTMENT_DATE_LOCKED) — the reversal/adjustment must be dated into an
//         open period (§6).
//   3. __writeLedgerJournalRows — account persistence + the shared idempotent upsert on
//      (firm_id, client_id, source_type, source_id); a re-post reuses the existing row id.
//   4. (opt-in) a generic ledger audit event, audit-as-precondition in the SAME txn.
//
// The INVENTORY-specific receipt/attempt/audit (§11/§15) belong to the executor, which
// layers them ON this write — the gateway stays domain-agnostic.

import {
  assertCorrectionLinesBalance,
  assertJournalDateNotLocked,
  __writeLedgerJournalRows
} from './firmDb.js';

const lockedPeriodError = (message) => {
  const error = new Error(message);
  error.statusCode = 409;
  error.code = 'LEDGER_LOCKED_PERIOD_IMMUTABLE';
  return error;
};

// Refuse to mutate a journal that already lives inside a locked close period (repost
// immutability) — verbatim the SELECT the named writers use (firmDb.js template). Returns
// the existing journal id (if any) so the shared upsert reuses that stable surrogate.
const assertExistingJournalNotLocked = async ({ tx, firmId, clientId, sourceType, sourceId }) => {
  const existing = await tx.query(
    `select lj.id, cp.id as close_period_id
     from ledger_journals lj
     left join close_periods cp
       on cp.firm_id = lj.firm_id
      and cp.client_id = lj.client_id
      and cp.status = 'locked'
      and lj.journal_date >= cp.period_start
      and lj.journal_date <= cp.period_end
     where lj.firm_id = $1
       and lj.client_id = $2
       and lj.source_type = $3
       and lj.source_id = $4
     limit 1`,
    [firmId, clientId, sourceType, sourceId]
  );
  if (existing.rows[0]?.close_period_id) {
    throw lockedPeriodError('Ledger journal is in a locked close period. Post a dated adjustment journal instead of reposting.');
  }
  return existing.rows[0]?.id || null;
};

// writeValidatedJournalWithinTransaction — the narrow gateway. tx is the caller's pg client
// (mid-transaction); journal is the standard builder shape (source_type/source_id/journal_date/
// currency/memo/accounts/lines); context carries { firmId, clientId, actorId, payload,
// existingJournalId?, audit? }. Returns the __writeLedgerJournalRows result augmented with the
// resolved existing_journal_id and the (optional) audit_event_id.
export const writeValidatedJournalWithinTransaction = async (tx, journal, context = {}) => {
  if (!tx || typeof tx.query !== 'function') {
    throw new Error('ledgerPostingGateway: a transaction client (tx.query) is required — the gateway never begins/commits.');
  }
  const { firmId, clientId, actorId = 'system', payload = {}, existingJournalId = null, audit = null } = context;
  if (!firmId || !clientId) throw new Error('ledgerPostingGateway: firmId and clientId are required.');
  if (!journal || !Array.isArray(journal.lines) || journal.lines.length === 0) {
    throw new Error('ledgerPostingGateway: a journal with lines is required.');
  }
  if (!journal.source_type || !journal.source_id) {
    throw new Error('ledgerPostingGateway: journal.source_type and journal.source_id are required (natural-key idempotency).');
  }

  // 1. Balance (Keep-layer arithmetic gate — the same guard every ledger post uses).
  assertCorrectionLinesBalance(journal.lines);

  // 2a. Repost immutability + 2b. new-date-in-locked-period — the "post a dated adjustment"
  // 409s. The locked-existing check ALWAYS runs (a safety gate a caller hint can never skip);
  // a caller-supplied existingJournalId only overrides the insert's row id.
  const foundExistingId = await assertExistingJournalNotLocked({
    tx, firmId, clientId, sourceType: journal.source_type, sourceId: journal.source_id
  });
  const resolvedExistingId = existingJournalId || foundExistingId;
  await assertJournalDateNotLocked({ client: tx, firmId, clientId, journalDate: journal.journal_date });

  // 3. Account persistence + the ONE shared insert (INV-1 — routes through the same backend).
  const post = await __writeLedgerJournalRows({
    client: tx, firmId, clientId, journal, payload,
    existingJournalId: resolvedExistingId, actorId
  });

  // 4. Opt-in generic ledger audit hook, audit-as-precondition in the caller's txn (nothing
  //    silent). Domain callers that own their own precondition audit (the inventory executor)
  //    leave this null and emit theirs after they hold the journal id.
  let auditEventId = null;
  if (audit && audit.action) {
    const res = await tx.query(
      `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       values ($1, $2, 'system', $3, $4, $5, $6, $7::jsonb)
       returning id`,
      [
        firmId, clientId, actorId, audit.action,
        audit.resourceType || 'ledger_journal',
        audit.resourceId || post.ledger_journal_id,
        JSON.stringify(audit.metadata || {})
      ]
    );
    auditEventId = res.rows[0]?.id != null ? String(res.rows[0].id) : null;
  }

  return { ...post, existing_journal_id: resolvedExistingId, audit_event_id: auditEventId };
};
