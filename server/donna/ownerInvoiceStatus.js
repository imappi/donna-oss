// The owner-status projection (kernel-audit M2, plane-C read side).
//
// "Where is the Acme invoice?" — answered from PERSISTED VERDICTS at every
// stage, joined on ONE root: the issued-invoice anchor.
//
// ── Why this is a read-only projection and NOT a work store ──────────────────
// The Codex review's accepted position (technical-plan "Codex review
// dispositions", claim 14) is that request-to-cash is ALREADY fully identified
// by the domain aggregates it crosses: the issued invoice (065), the outbound
// action (091), the receivable case (092), the settlement signal, the AR
// receipt. A writable `work_items` table would be a SECOND home for state that
// already has one, and the anti-overengineering rule binds: no abstraction on
// one speculative consumer. So this module OWNS NO STATE. It reads the five
// aggregates and composes one answer. If a second promise ever appears that has
// no domain aggregate, THAT is when a work store gets designed — from two real
// consumers, not one imagined one.
//
// ── Render the persisted verdict, not the legacy layer ───────────────────────
// Every field below comes from a row a pipeline wrote. There is no inference
// call here, no "second opinion" from a thinner model, and no derivation from
// the ABSENCE of data — an unknown stage reads as unknown, which is itself a
// pipeline gap to fix upstream rather than paper over here (the rail, and the
// #315 / buildLiveRow sightings behind it).
//
// ── Two terminal states, as a projection ─────────────────────────────────────
// `resting` is the whole point of the shape: every stage resolves to
//   'donna'  — Donna handled it or is actively carrying it, or
//   'owner'  — it is waiting on a business fact or a decision only they can give
// and a stage that can rest on NEITHER is a bug by definition. `restingOn`
// makes that assertable in a test instead of arguable in a review.

const clean = (v) => String(v ?? '').trim();

// Where a stage rests. 'donna' includes in-flight work: the owner is not
// waiting on anything, so it is not theirs.
export const RESTING_ON = Object.freeze(['donna', 'owner']);

export const STAGE_KEYS = Object.freeze([
  'command', 'invoice', 'send', 'chase', 'settlement', 'books'
]);

// ── Per-stage verdict readers (pure — row in, stage out) ─────────────────────

const commandStage = (command) => {
  if (!command) return null;
  const map = {
    reading: { state: 'reading', restingOn: 'donna', summary: 'Reading your message.' },
    drafted: { state: 'drafted', restingOn: 'donna', summary: 'I turned your message into an invoice.' },
    asked: { state: 'asked', restingOn: 'owner', summary: 'I asked you a question before raising it.' },
    refused: { state: 'refused', restingOn: 'owner', summary: 'I could not raise this one.' }
  };
  const stage = map[command.status];
  if (!stage) return null;
  return {
    ...stage,
    reason: command.status_reason || null,
    // (c) the receipt: who said it, on which bound channel.
    principal: {
      actorType: command.principal_actor_type || null,
      actorId: command.principal_actor_id || null,
      channel: command.source_channel || null
    },
    // (d) so a surface can show the owner which facts were THEIRS and which
    // Donna proposed — approving a consequence must not launder the difference.
    fieldProvenance: command.field_provenance || {},
    model: command.model || null
  };
};

const invoiceStage = (invoice) => {
  if (!invoice) return null;
  const map = {
    draft_pending_confirmation: {
      state: 'drafted', restingOn: 'owner',
      summary: 'Drafted and waiting for your approval.'
    },
    issued: { state: 'issued', restingOn: 'donna', summary: 'Issued.' },
    cancelled: { state: 'cancelled', restingOn: 'donna', summary: 'Cancelled.' }
  };
  const stage = map[invoice.status];
  if (!stage) return null;
  const doc = invoice.draft?.invoice || {};
  return {
    ...stage,
    invoiceNumber: doc.invoiceNumber || invoice.invoice_number || null,
    total: doc.total ?? null,
    currency: doc.currency || null,
    dueDate: doc.dueDate || null,
    buyer: doc.buyer?.name || invoice.buyer_name || null
  };
};

const sendStage = (action) => {
  if (!action) return null;
  // The action's OWN status vocabulary, mapped to who is waiting. This is the
  // 091 header's two-terminal claim, read rather than re-derived.
  const map = {
    hold_for_approval: { state: 'awaiting_approval', restingOn: 'owner', summary: 'Waiting for you to approve the send.' },
    scheduled: { state: 'scheduled', restingOn: 'donna', summary: 'Queued to send.' },
    approved: { state: 'approved', restingOn: 'donna', summary: 'Approved — sending shortly.' },
    executing: { state: 'sending', restingOn: 'donna', summary: 'Sending now.' },
    executed: { state: 'sent', restingOn: 'donna', summary: 'Sent.' },
    cancelled: { state: 'cancelled', restingOn: 'donna', summary: 'Not sent.' },
    // A provider refusal is deliberately NEVER auto-retried (091): it is a real
    // decision, and the only person who can make it is the owner.
    failed: { state: 'failed', restingOn: 'owner', summary: 'The send failed and needs your call.' }
  };
  const stage = map[action.status];
  if (!stage) return null;
  const heldAtSend = action.gate_basis?.held_at_send || [];
  return {
    ...stage,
    reason: action.cancel_reason || action.send_error || heldAtSend[0] || null,
    // The G13(b) interlock, made visible: "why is this back with me?"
    staleConsequence: heldAtSend.includes('approved_consequence_changed'),
    approvedBy: action.approved_by_actor_id || action.approved_by_actor_type || null,
    sentAt: action.updated_at || null
  };
};

const chaseStage = (caseRow) => {
  if (!caseRow) return null;
  const map = {
    open: { state: 'chasing', restingOn: 'donna', summary: 'Chasing payment on schedule.' },
    escalated: { state: 'escalated', restingOn: 'owner', summary: 'The cadence ran out — over to you.' },
    disputed: { state: 'disputed', restingOn: 'owner', summary: 'They disputed it.' },
    paused: { state: 'paused', restingOn: 'owner', summary: 'You paused the chase.' },
    settled: { state: 'settled', restingOn: 'donna', summary: 'Paid.' },
    stopped: { state: 'stopped', restingOn: 'donna', summary: 'Chase stopped.' }
  };
  const stage = map[caseRow.status];
  if (!stage) return null;
  // An OPEN case carrying a named gap is not Donna working — it is Donna
  // waiting on the owner for a business fact (the G9 digest surface). Reading
  // that as 'chasing' would hide a row that is actually resting on them.
  const gap = clean(caseRow.status_reason);
  const restingOn = caseRow.status === 'open' && gap ? 'owner' : stage.restingOn;
  return {
    ...stage,
    restingOn,
    reason: gap || null,
    currentStep: caseRow.current_step ?? null,
    nextDueAt: caseRow.next_due_at || null,
    summary: restingOn === 'owner' && gap
      ? 'I need something from you before I can chase this.'
      : stage.summary
  };
};

const settlementStage = ({ paidTruth = null, caseRow = null } = {}) => {
  const verdict = clean(paidTruth).toLowerCase();
  if (verdict === 'settled' || caseRow?.status === 'settled') {
    return { state: 'settled', restingOn: 'donna', summary: 'Payment matched.', verdict: verdict || 'settled' };
  }
  if (verdict === 'unpaid') {
    return { state: 'unpaid', restingOn: 'donna', summary: 'No payment seen yet.', verdict };
  }
  // No persisted verdict. NOT "unpaid" — absence of data is not a verdict, and
  // reporting it as one is exactly the failure this rail exists to stop
  // (Failure B: the panel rendered a default column as settled truth).
  return { state: 'unknown', restingOn: 'donna', summary: 'No settlement verdict recorded yet.', verdict: null };
};

// The AR outcome is recorded by the executor as an `ar_ledger_post` entry in
// the send receipt's `checks` array (actionExecutor's finalize) — `pass` with
// the journal id, or `skipped` with a NAMED reason. Read that verdict; do not
// re-derive it from the ledger, and do not treat its absence as a failure.
export const arLedgerCheckFrom = (receiptChecks) =>
  (Array.isArray(receiptChecks) ? receiptChecks : [])
    .find((c) => c?.check === 'ar_ledger_post') || null;

const booksStage = (arCheck) => {
  if (!arCheck) {
    return { state: 'not_posted', restingOn: 'donna', summary: 'Nothing posted to the books yet.', reason: null };
  }
  if (arCheck.status === 'pass') {
    return {
      state: 'posted', restingOn: 'donna',
      summary: 'Posted to your books.', reason: null, journalId: arCheck.detail || null
    };
  }
  // A SKIP is a real, named outcome — a cash-basis book posts income at
  // settlement, not at issuance, and that is correct rather than missing.
  // Rendering a named skip as a gap would manufacture work that does not exist.
  return {
    state: 'skipped', restingOn: 'donna',
    summary: 'Not posted at issuance, for a recorded reason.',
    reason: arCheck.detail || null
  };
};

// ── The projection ───────────────────────────────────────────────────────────

// Compose the six stages into one answer. PURE: every input is a persisted row
// the caller read. `readOwnerInvoiceStatus` below is the thin I/O wrapper.
export const projectOwnerInvoiceStatus = ({
  command = null, invoice = null, action = null,
  caseRow = null, paidTruth = null, receiptChecks = null
} = {}) => {
  const stages = {
    command: commandStage(command),
    invoice: invoiceStage(invoice),
    send: sendStage(action),
    chase: chaseStage(caseRow),
    settlement: invoice?.status === 'issued' ? settlementStage({ paidTruth, caseRow }) : null,
    books: invoice?.status === 'issued' ? booksStage(arLedgerCheckFrom(receiptChecks)) : null
  };

  // The headline is the FURTHEST stage that has a verdict — the owner asks
  // "where is it", and the answer is where it actually is, not where it began.
  const ordered = STAGE_KEYS.map((key) => [key, stages[key]]).filter(([, s]) => s);
  const [headlineKey, headline] = ordered.length ? ordered[ordered.length - 1] : [null, null];

  // Two-terminal-states, projected: it rests on the owner if ANY live stage
  // does. One stage waiting on them is the whole row waiting on them.
  const ownerStages = ordered.filter(([, s]) => s.restingOn === 'owner').map(([k]) => k);

  return {
    rootRef: invoice?.id
      ? { type: 'issued_invoice', id: invoice.id }
      : (command?.id ? { type: 'owner_invoice_command', id: command.id } : null),
    stage: headlineKey,
    state: headline?.state || 'unknown',
    restingOn: ownerStages.length ? 'owner' : 'donna',
    waitingOnOwnerFor: ownerStages,
    summary: headline?.summary || 'Nothing recorded for this yet.',
    stages
  };
};

// The I/O half: read the five aggregates for one issued-invoice root, then
// project. Client-scoped on every read (the customer boundary is
// client <-> client — the F-1 lesson applied to a new read path).
export const readOwnerInvoiceStatus = async (client, {
  firmId, clientId, issuedInvoiceId = null, commandId = null, paidTruthCheck = null
} = {}) => {
  if (!firmId || !clientId) throw new Error('readOwnerInvoiceStatus requires firmId and clientId');
  if (!issuedInvoiceId && !commandId) {
    throw new Error('readOwnerInvoiceStatus requires an issuedInvoiceId or a commandId');
  }

  let command = null;
  if (commandId) {
    command = await client.query(
      `select * from owner_invoice_commands
        where firm_id = $1 and client_id = $2 and id = $3`,
      [firmId, clientId, commandId]
    ).then((r) => r.rows[0] || null);
  }
  const invoiceId = issuedInvoiceId || command?.issued_invoice_id || null;
  if (!invoiceId) return projectOwnerInvoiceStatus({ command });

  if (!command) {
    command = await client.query(
      `select * from owner_invoice_commands
        where firm_id = $1 and client_id = $2 and issued_invoice_id = $3
        order by created_at asc limit 1`,
      [firmId, clientId, invoiceId]
    ).then((r) => r.rows[0] || null).catch(() => null);
  }

  const invoice = await client.query(
    `select * from issued_invoices where firm_id = $1 and client_id = $2 and id = $3`,
    [firmId, clientId, invoiceId]
  ).then((r) => r.rows[0] || null);

  const action = await client.query(
    `select * from outbound_actions
      where firm_id = $1 and client_id = $2
        and anchor_type = 'issued_invoice' and anchor_id = $3
        and action_type = 'issue_invoice'
      order by created_at desc limit 1`,
    [firmId, clientId, invoiceId]
  ).then((r) => r.rows[0] || null);

  const caseRow = await client.query(
    `select * from receivable_cases
      where firm_id = $1 and client_id = $2
        and anchor_type = 'issued_invoice' and anchor_id = $3
      order by created_at desc limit 1`,
    [firmId, clientId, invoiceId]
  ).then((r) => r.rows[0] || null);

  // The AR outcome rides the SEND receipt's checks, where the executor put it —
  // `pass` with a journal id, or `skipped` with a named reason. Read the
  // verdict; never re-derive it from the ledger.
  const receiptChecks = action
    ? await client.query(
      `select checks from outbound_action_receipts
        where firm_id = $1 and client_id = $2 and action_id = $3 and outcome = 'sent'
        order by created_at desc limit 1`,
      [firmId, clientId, action.id]
    ).then((r) => r.rows[0]?.checks || null).catch(() => null)
    : null;

  const paidTruth = typeof paidTruthCheck === 'function' && action
    ? await paidTruthCheck({ client, firmId, clientId, action })
    : null;

  return projectOwnerInvoiceStatus({ command, invoice, action, caseRow, paidTruth, receiptChecks });
};
