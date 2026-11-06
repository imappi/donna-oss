// The owner-status projection (kernel-audit M2). Pins:
//   - every stage is read from a PERSISTED verdict; no stage is inferred from
//     the ABSENCE of data (the render-the-persisted-verdict rail, and Failure B
//     behind it — a default column rendered as settled truth);
//   - every stage resolves to exactly one of the two terminals, so the
//     first-principle question ("can a row rest somewhere else?") is a test,
//     not an argument;
//   - the root reference is the ISSUED-INVOICE anchor;
//   - it owns no state — the whole projection is pure over rows.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RESTING_ON, STAGE_KEYS, projectOwnerInvoiceStatus, arLedgerCheckFrom,
  readOwnerInvoiceStatus
} from './ownerInvoiceStatus.js';

const FIRM = 'firm-1';
const CLIENT = 'client-1';

const command = (over = {}) => ({
  id: 'cmd-1', status: 'drafted', status_reason: null,
  principal_actor_type: 'owner', principal_actor_id: 'kari', source_channel: 'whatsapp',
  field_provenance: { buyer: 'owner_supplied', amount: 'owner_supplied' },
  model: 'test-model', issued_invoice_id: 'inv-1', ...over
});

const invoice = (over = {}) => ({
  id: 'inv-1', status: 'issued',
  draft: { invoice: {
    invoiceNumber: 'INV-2026-0001', currency: 'USD', total: 1500,
    dueDate: '2026-08-10', buyer: { name: 'Acme' }
  } },
  ...over
});

const action = (over = {}) => ({
  id: 'act-1', status: 'executed', gate_basis: {},
  approved_by_actor_type: 'owner', approved_by_actor_id: 'kari',
  cancel_reason: null, send_error: null, updated_at: '2026-07-27T10:00:00Z',
  ...over
});

const caseRow = (over = {}) => ({
  id: 'case-1', status: 'open', status_reason: null,
  current_step: 1, next_due_at: '2026-08-17T00:00:00Z', ...over
});

test('the stage list and terminal vocabulary are closed', () => {
  assert.deepEqual([...RESTING_ON], ['donna', 'owner']);
  assert.deepEqual([...STAGE_KEYS], ['command', 'invoice', 'send', 'chase', 'settlement', 'books']);
});

test('the root reference is the ISSUED-INVOICE anchor', () => {
  const p = projectOwnerInvoiceStatus({ command: command(), invoice: invoice() });
  assert.deepEqual(p.rootRef, { type: 'issued_invoice', id: 'inv-1' });
});

test('before an invoice exists the root falls back to the command, never to nothing', () => {
  const p = projectOwnerInvoiceStatus({ command: command({ status: 'asked', issued_invoice_id: null }) });
  assert.deepEqual(p.rootRef, { type: 'owner_invoice_command', id: 'cmd-1' });
  assert.equal(p.restingOn, 'owner', 'an open question rests on the owner');
});

// ── THE FIRST PRINCIPLE, as a test ───────────────────────────────────────────

test('EVERY reachable state of EVERY stage rests on exactly one of the two terminals', () => {
  const commandStatuses = ['reading', 'drafted', 'asked', 'refused'];
  const invoiceStatuses = ['draft_pending_confirmation', 'issued', 'cancelled'];
  const actionStatuses = [
    'hold_for_approval', 'scheduled', 'approved', 'executing', 'executed', 'cancelled', 'failed'
  ];
  const caseStatuses = ['open', 'paused', 'disputed', 'escalated', 'settled', 'stopped'];

  const seen = [];
  for (const cs of commandStatuses) {
    for (const is of invoiceStatuses) {
      for (const as of actionStatuses) {
        for (const ks of caseStatuses) {
          const p = projectOwnerInvoiceStatus({
            command: command({ status: cs }),
            invoice: invoice({ status: is }),
            action: action({ status: as }),
            caseRow: caseRow({ status: ks }),
            paidTruth: 'unpaid'
          });
          for (const [key, stage] of Object.entries(p.stages)) {
            if (!stage) continue;
            assert.ok(RESTING_ON.includes(stage.restingOn),
              `${key} in (${cs}/${is}/${as}/${ks}) rests on '${stage.restingOn}' — neither terminal`);
            seen.push(stage.restingOn);
          }
          assert.ok(RESTING_ON.includes(p.restingOn));
        }
      }
    }
  }
  assert.ok(seen.length > 0);
});

test('an unknown status yields NO stage rather than a guessed one', () => {
  const p = projectOwnerInvoiceStatus({
    command: command({ status: 'something_new' }),
    invoice: invoice({ status: 'something_new' }),
    action: action({ status: 'something_new' }),
    caseRow: caseRow({ status: 'something_new' })
  });
  assert.equal(p.stages.command, null);
  assert.equal(p.stages.invoice, null);
  assert.equal(p.stages.send, null);
  assert.equal(p.stages.chase, null);
  assert.equal(p.state, 'unknown', 'an unreadable row reads as unknown, never as fine');
});

// ── Render the persisted verdict ─────────────────────────────────────────────

test('NO settlement verdict reads as unknown — never as "unpaid"', () => {
  // This is Failure B in miniature: the panel rendered a column default as
  // settled truth. Absence of a verdict is not a verdict.
  const p = projectOwnerInvoiceStatus({
    command: command(), invoice: invoice(), action: action(),
    caseRow: caseRow(), paidTruth: null
  });
  assert.equal(p.stages.settlement.state, 'unknown');
  assert.equal(p.stages.settlement.verdict, null);
});

test('a persisted settlement verdict is rendered as-is', () => {
  const unpaid = projectOwnerInvoiceStatus({
    invoice: invoice(), action: action(), caseRow: caseRow(), paidTruth: 'unpaid'
  });
  assert.equal(unpaid.stages.settlement.state, 'unpaid');

  const settled = projectOwnerInvoiceStatus({
    invoice: invoice(), action: action(), caseRow: caseRow({ status: 'settled' }), paidTruth: 'settled'
  });
  assert.equal(settled.stages.settlement.state, 'settled');
});

test('settlement and books are not projected before the invoice is ISSUED', () => {
  const p = projectOwnerInvoiceStatus({
    command: command(), invoice: invoice({ status: 'draft_pending_confirmation' }),
    action: action({ status: 'hold_for_approval' }), paidTruth: 'unpaid'
  });
  assert.equal(p.stages.settlement, null, 'an unissued invoice has no settlement question yet');
  assert.equal(p.stages.books, null);
});

test('the AR verdict is read from the send receipt\'s checks, and a NAMED skip is not a gap', () => {
  const posted = projectOwnerInvoiceStatus({
    invoice: invoice(), action: action(), paidTruth: 'unpaid',
    receiptChecks: [{ check: 'authority', status: 'pass' }, { check: 'ar_ledger_post', status: 'pass', detail: 'jrn-9' }]
  });
  assert.equal(posted.stages.books.state, 'posted');
  assert.equal(posted.stages.books.journalId, 'jrn-9');

  // A cash-basis book posts income at SETTLEMENT, not at issuance. That is
  // correct, not missing — rendering it as a gap would manufacture work.
  const skipped = projectOwnerInvoiceStatus({
    invoice: invoice(), action: action(), paidTruth: 'unpaid',
    receiptChecks: [{ check: 'ar_ledger_post', status: 'skipped', detail: 'cash_basis_no_ar_post' }]
  });
  assert.equal(skipped.stages.books.state, 'skipped');
  assert.equal(skipped.stages.books.reason, 'cash_basis_no_ar_post');
  assert.equal(skipped.stages.books.restingOn, 'donna', 'a named skip is not the owner\'s problem');

  assert.equal(arLedgerCheckFrom(null), null);
  assert.equal(arLedgerCheckFrom([{ check: 'authority', status: 'pass' }]), null);
});

// ── Who is actually waiting ──────────────────────────────────────────────────

test('an OPEN case carrying a named gap rests on the OWNER, not on Donna', () => {
  // "open" alone reads as Donna chasing. Open WITH a gap means Donna cannot
  // chase until the owner supplies something — reading that as 'chasing' would
  // hide a row that is really theirs.
  const p = projectOwnerInvoiceStatus({
    invoice: invoice(), action: action(),
    caseRow: caseRow({ status: 'open', status_reason: 'missing_payment_instructions' }),
    paidTruth: 'unpaid'
  });
  assert.equal(p.stages.chase.restingOn, 'owner');
  assert.equal(p.stages.chase.reason, 'missing_payment_instructions');
  assert.equal(p.restingOn, 'owner');
  assert.ok(p.waitingOnOwnerFor.includes('chase'));
});

test('one stage waiting on the owner makes the whole row theirs', () => {
  const p = projectOwnerInvoiceStatus({
    command: command(), invoice: invoice(),
    action: action({ status: 'hold_for_approval' }),
    caseRow: caseRow(), paidTruth: 'unpaid'
  });
  assert.equal(p.restingOn, 'owner');
  assert.deepEqual(p.waitingOnOwnerFor, ['send']);
});

test('a fully-handled invoice rests on DONNA at every stage', () => {
  const p = projectOwnerInvoiceStatus({
    command: command(), invoice: invoice(), action: action({ status: 'executed' }),
    caseRow: caseRow({ status: 'settled' }), paidTruth: 'settled',
    receiptChecks: [{ check: 'ar_ledger_post', status: 'pass', detail: 'jrn-9' }]
  });
  assert.equal(p.restingOn, 'donna');
  assert.deepEqual(p.waitingOnOwnerFor, []);
  assert.equal(p.stage, 'books');
});

test('a provider failure rests on the OWNER — it is never silently auto-retried', () => {
  const p = projectOwnerInvoiceStatus({
    invoice: invoice(), action: action({ status: 'failed', send_error: 'mailbox full' })
  });
  assert.equal(p.stages.send.restingOn, 'owner');
  assert.equal(p.stages.send.reason, 'mailbox full');
});

test('the G13(b) stale-consequence hold is visible in the projection', () => {
  const p = projectOwnerInvoiceStatus({
    invoice: invoice(),
    action: action({
      status: 'hold_for_approval',
      gate_basis: { held_at_send: ['approved_consequence_changed'] }
    })
  });
  assert.equal(p.stages.send.staleConsequence, true);
  assert.equal(p.stages.send.reason, 'approved_consequence_changed');
  assert.equal(p.stages.send.restingOn, 'owner', 'the re-decision is theirs');
});

test('the command stage carries the principal and the field provenance', () => {
  const p = projectOwnerInvoiceStatus({ command: command(), invoice: invoice() });
  assert.deepEqual(p.stages.command.principal, {
    actorType: 'owner', actorId: 'kari', channel: 'whatsapp'
  });
  assert.equal(p.stages.command.fieldProvenance.buyer, 'owner_supplied');
  assert.equal(p.stages.command.model, 'test-model', 'the model id is part of the receipt');
});

// ── The I/O half is client-scoped and reads only ─────────────────────────────

test('every read is client-scoped, and the projection writes nothing', async () => {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const t = String(sql).replace(/\s+/g, ' ').toLowerCase();
      if (t.includes('from issued_invoices')) return { rows: [invoice()] };
      if (t.includes('from outbound_actions')) return { rows: [action()] };
      if (t.includes('from receivable_cases')) return { rows: [caseRow({ status: 'settled' })] };
      if (t.includes('from owner_invoice_commands')) return { rows: [command()] };
      if (t.includes('from outbound_action_receipts')) {
        return { rows: [{ checks: [{ check: 'ar_ledger_post', status: 'pass', detail: 'jrn-9' }] }] };
      }
      return { rows: [] };
    }
  };
  const status = await readOwnerInvoiceStatus(client, {
    firmId: FIRM, clientId: CLIENT, issuedInvoiceId: 'inv-1',
    paidTruthCheck: async () => 'settled'
  });
  assert.equal(status.state, 'posted');
  assert.equal(status.restingOn, 'donna');

  for (const call of calls) {
    const t = call.sql.replace(/\s+/g, ' ').toLowerCase();
    assert.ok(/^\s*select/.test(t), `the projection only reads: ${t.slice(0, 60)}`);
    assert.ok(t.includes('firm_id = $1') && t.includes('client_id = $2'),
      `client-scoped: ${t.slice(0, 80)}`);
  }
});

test('the reader refuses an unscoped or unrooted request', async () => {
  const client = { query: async () => ({ rows: [] }) };
  await assert.rejects(
    () => readOwnerInvoiceStatus(client, { clientId: CLIENT, issuedInvoiceId: 'inv-1' }),
    /requires firmId and clientId/
  );
  await assert.rejects(
    () => readOwnerInvoiceStatus(client, { firmId: FIRM, clientId: CLIENT }),
    /issuedInvoiceId or a commandId/
  );
});

test('a command with no invoice yet projects the command stage alone', async () => {
  const client = {
    query: async (sql) => {
      const t = String(sql).toLowerCase();
      if (t.includes('from owner_invoice_commands')) {
        return { rows: [command({ status: 'asked', issued_invoice_id: null })] };
      }
      return { rows: [] };
    }
  };
  const status = await readOwnerInvoiceStatus(client, {
    firmId: FIRM, clientId: CLIENT, commandId: 'cmd-1'
  });
  assert.equal(status.state, 'asked');
  assert.equal(status.restingOn, 'owner');
  assert.equal(status.stages.invoice, null);
});
