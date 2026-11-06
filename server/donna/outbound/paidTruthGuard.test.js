// Send-time paid-truth guard (M1, G4 — the long pole). Pins the composed
// verdict over BOTH settlement mechanisms, with the RISK-#1 FIXTURE first:
// a genuinely-paid parsed invoice resting at payment_status='unpaid' with a
// 'suggested' match awaiting a click must come back AMBIGUOUS (hold for the
// owner) — never 'unpaid' (which would chase a paid customer). Also pins:
//   - payment_status paid/void/credit_note → settled; partial/unknown/missing
//     → ambiguous; a decided match beside an 'unpaid' status → ambiguous
//     (cascade raced — trust neither side);
//   - an already_settled evaluation verdict → ambiguous;
//   - the clean unpaid lane: unpaid + no open signal → 'unpaid';
//   - issued lane: fresh evaluateIssuedInvoiceSettlement composition —
//     reference-matched money-in settles; partial holds; nothing matched
//     stays unpaid; credit notes net the due amount;
//   - fail-closed: unreadable inputs and absent tables → ambiguous, never
//     unpaid; non-reminder actions → null (no paid-truth question);
//   - the sweep-facing callback returns the bare verdict.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PAID_TRUTH_GUARD_VERDICTS, composeParsedInvoicePaidTruth,
  evaluatePaidTruthDetailed, paidTruthCheck
} from './paidTruthGuard.js';

const FIRM = 'firm-1';
const CLIENT = 'client-1';
const NOW = Date.parse('2026-07-24T00:00:00Z');

const reminderAction = (over = {}) => ({
  action_type: 'send_receivable_reminder',
  anchor_type: 'document', anchor_id: 'doc-1',
  ...over
});

const makeMockClient = (handlers = []) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const text = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      for (const h of handlers) {
        if (text.includes(h.match)) {
          if (h.throw) throw h.throw;
          const rows = typeof h.rows === 'function' ? h.rows({ sql: text, params }) : (h.rows || []);
          return { rows, rowCount: rows.length };
        }
      }
      return { rows: [], rowCount: 0 };
    }
  };
};

test('verdict vocabulary is closed and pinned', () => {
  assert.deepEqual([...PAID_TRUTH_GUARD_VERDICTS], ['unpaid', 'ambiguous', 'settled']);
});

// ── D4 (M2): the deterministic pay-link signal outranks both lanes ───────────

test('a settled pay-link is a deterministic SETTLED — even while payment_status still says unpaid', async () => {
  const client = makeMockClient([
    { match: 'from outbound_payment_links', rows: [
      { id: 'pl-1', status: 'settled', amount: 1250, settled_amount: 1250 }
    ] },
    // The heuristic lane would have said unpaid — the webhook-verified link wins.
    { match: 'select payment_status from documents', rows: [{ payment_status: 'unpaid' }] }
  ]);
  const result = await evaluatePaidTruthDetailed({
    client, firmId: FIRM, clientId: CLIENT, action: reminderAction(), now: NOW
  });
  assert.deepEqual(result, { verdict: 'settled', reason: 'payment_link_settled' });
});

test('a partially-settled pay-link degrades to ambiguous; an active link says nothing', async () => {
  const partial = await evaluatePaidTruthDetailed({
    client: makeMockClient([
      { match: 'from outbound_payment_links', rows: [
        { id: 'pl-1', status: 'settled', amount: 1250, settled_amount: 100 }
      ] }
    ]),
    firmId: FIRM, clientId: CLIENT, action: reminderAction(), now: NOW
  });
  assert.equal(partial.verdict, 'ambiguous');

  const active = await evaluatePaidTruthDetailed({
    client: makeMockClient([
      { match: 'from outbound_payment_links', rows: [
        { id: 'pl-1', status: 'active', amount: 1250 }
      ] },
      { match: 'select payment_status from documents', rows: [{ payment_status: 'unpaid' }] }
    ]),
    firmId: FIRM, clientId: CLIENT, action: reminderAction(), now: NOW
  });
  assert.equal(active.verdict, 'unpaid', 'an unsettled link falls through to the composed lanes');
});

// ── The risk-#1 fixture ──────────────────────────────────────────────────────

test('RISK #1: unpaid status + open SUGGESTED match → ambiguous (hold), never unpaid', async () => {
  const client = makeMockClient([
    { match: 'from documents', rows: [{ payment_status: 'unpaid' }] },
    { match: 'from reconciliation_matches', rows: [{ status: 'suggested' }] },
    { match: 'from reconciliation_evaluations', rows: [] }
  ]);
  const result = await evaluatePaidTruthDetailed({
    client, firmId: FIRM, clientId: CLIENT, action: reminderAction(), now: NOW
  });
  assert.equal(result.verdict, 'ambiguous');
  assert.equal(result.reason, 'open_suggested_match');
});

// ── Parsed lane (pure mapper) ────────────────────────────────────────────────

test('parsed mapper: the full verdict matrix', () => {
  assert.deepEqual(composeParsedInvoicePaidTruth({ paymentStatus: 'paid' }).verdict, 'settled');
  assert.deepEqual(composeParsedInvoicePaidTruth({ paymentStatus: 'void' }).verdict, 'settled');
  assert.deepEqual(composeParsedInvoicePaidTruth({ paymentStatus: 'credit_note' }).verdict, 'settled');
  assert.deepEqual(composeParsedInvoicePaidTruth({ paymentStatus: 'partial' }).verdict, 'ambiguous');
  assert.deepEqual(composeParsedInvoicePaidTruth({ paymentStatus: 'unknown' }).verdict, 'ambiguous');
  assert.deepEqual(composeParsedInvoicePaidTruth({ paymentStatus: null }).verdict, 'ambiguous');
  // A decided match beside an unpaid status: the cascade raced — hold.
  const raced = composeParsedInvoicePaidTruth({
    paymentStatus: 'unpaid', openMatchStatuses: ['auto_matched']
  });
  assert.equal(raced.verdict, 'ambiguous');
  assert.equal(raced.reason, 'decided_match_status_mismatch');
  assert.equal(composeParsedInvoicePaidTruth({
    paymentStatus: 'unpaid', openMatchStatuses: ['confirmed']
  }).verdict, 'ambiguous');
  // already_settled evaluation without a match row: the model's honest
  // no-match claim of settlement — hold for the owner.
  const evaluated = composeParsedInvoicePaidTruth({
    paymentStatus: 'unpaid', evaluationReasons: ['already_settled']
  });
  assert.equal(evaluated.verdict, 'ambiguous');
  assert.equal(evaluated.reason, 'already_settled_evaluation');
  // The clean send lane.
  const clean = composeParsedInvoicePaidTruth({ paymentStatus: 'unpaid' });
  assert.equal(clean.verdict, 'unpaid');
});

test('parsed lane: a paid document settles (auto-cancel lane); a missing document holds', async () => {
  const paid = makeMockClient([
    { match: 'from documents', rows: [{ payment_status: 'paid' }] }
  ]);
  assert.equal((await evaluatePaidTruthDetailed({
    client: paid, firmId: FIRM, clientId: CLIENT, action: reminderAction(), now: NOW
  })).verdict, 'settled');

  const missing = makeMockClient([
    { match: 'from documents', rows: [] }
  ]);
  const gone = await evaluatePaidTruthDetailed({
    client: missing, firmId: FIRM, clientId: CLIENT, action: reminderAction(), now: NOW
  });
  assert.equal(gone.verdict, 'ambiguous');
  assert.equal(gone.reason, 'document_missing');
});

test('parsed lane: clean unpaid with no open signal is the only send lane', async () => {
  const client = makeMockClient([
    { match: 'from documents', rows: [{ payment_status: 'unpaid' }] },
    { match: 'from reconciliation_matches', rows: [] },
    { match: 'from reconciliation_evaluations', rows: [] }
  ]);
  const result = await evaluatePaidTruthDetailed({
    client, firmId: FIRM, clientId: CLIENT, action: reminderAction(), now: NOW
  });
  assert.equal(result.verdict, 'unpaid');
});

// ── Issued lane ──────────────────────────────────────────────────────────────

const issuedInvoiceRow = (over = {}) => ({
  id: 'inv-1', status: 'issued', kind: 'invoice',
  draft: {
    invoice: {
      invoiceNumber: '10042', total: 745, date: '2026-06-01', dueDate: '2026-06-15',
      ...(over.invoice || {})
    },
    finvoice: { invoiceDetails: { referenceNumber: '1234567894' } }
  },
  ...over.row
});

const issuedClient = ({ invoice = issuedInvoiceRow(), credited = 0, transactions = [] } = {}) =>
  makeMockClient([
    { match: 'from issued_invoices where firm_id = $1 and client_id = $2 and id = $3', rows: invoice ? [invoice] : [] },
    { match: "kind = 'credit_note'", rows: [{ credited }] },
    { match: 'from transactions', rows: transactions }
  ]);

test('issued lane: a reference-matched money-in settles; partial holds; unmatched stays unpaid', async () => {
  const action = reminderAction({ anchor_type: 'issued_invoice', anchor_id: 'inv-1' });

  const paid = await evaluatePaidTruthDetailed({
    client: issuedClient({
      transactions: [{ id: 'tx-1', description: 'SEPA RF 1234567894', money_in: '745', transaction_date: '2026-06-20' }]
    }),
    firmId: FIRM, clientId: CLIENT, action, now: NOW
  });
  assert.equal(paid.verdict, 'settled');
  assert.equal(paid.reason, 'settlement_paid');

  const partial = await evaluatePaidTruthDetailed({
    client: issuedClient({
      transactions: [{ id: 'tx-1', description: 'viite 1234567894 osasuoritus', money_in: '300', transaction_date: '2026-06-20' }]
    }),
    firmId: FIRM, clientId: CLIENT, action, now: NOW
  });
  assert.equal(partial.verdict, 'ambiguous');
  assert.equal(partial.reason, 'settlement_partially_paid');

  const unpaid = await evaluatePaidTruthDetailed({
    client: issuedClient({
      transactions: [{ id: 'tx-1', description: 'unrelated transfer', money_in: '745', transaction_date: '2026-06-20' }]
    }),
    firmId: FIRM, clientId: CLIENT, action, now: NOW
  });
  assert.equal(unpaid.verdict, 'unpaid');
});

test('issued lane G12: a structured capture decides — equality settles noisy text, a differing capture keeps the line off this invoice', async () => {
  const action = reminderAction({ anchor_type: 'issued_invoice', anchor_id: 'inv-1' });

  // Free text carries nothing recognizable; the captured reference settles.
  const structured = await evaluatePaidTruthDetailed({
    client: issuedClient({
      transactions: [{ id: 'tx-1', description: 'SEPA IN', structured_reference: '1234567894', money_in: '745', transaction_date: '2026-06-20' }]
    }),
    firmId: FIRM, clientId: CLIENT, action, now: NOW
  });
  assert.equal(structured.verdict, 'settled');

  // The line is viite-addressed to ANOTHER invoice whose digit run embeds
  // this one's viite — the substring lane alone would falsely settle; the
  // structured decision keeps the verdict honestly 'unpaid'.
  const other = await evaluatePaidTruthDetailed({
    client: issuedClient({
      transactions: [{ id: 'tx-1', description: 'REF 12345678945', structured_reference: '12345678945', money_in: '745', transaction_date: '2026-06-20' }]
    }),
    firmId: FIRM, clientId: CLIENT, action, now: NOW
  });
  assert.equal(other.verdict, 'unpaid');
});

test('issued lane: an issued credit note nets the due amount to settled', async () => {
  const action = reminderAction({ anchor_type: 'issued_invoice', anchor_id: 'inv-1' });
  const result = await evaluatePaidTruthDetailed({
    client: issuedClient({ credited: 745 }),
    firmId: FIRM, clientId: CLIENT, action, now: NOW
  });
  assert.equal(result.verdict, 'settled');
  assert.equal(result.reason, 'settlement_credited');
});

test('issued lane: a missing or unreadable invoice holds', async () => {
  const action = reminderAction({ anchor_type: 'issued_invoice', anchor_id: 'inv-404' });
  const missing = await evaluatePaidTruthDetailed({
    client: issuedClient({ invoice: null }),
    firmId: FIRM, clientId: CLIENT, action, now: NOW
  });
  assert.equal(missing.verdict, 'ambiguous');
  assert.equal(missing.reason, 'issued_invoice_missing');

  const unreadable = await evaluatePaidTruthDetailed({
    client: issuedClient({ invoice: issuedInvoiceRow({ invoice: { total: 0 } }) }),
    firmId: FIRM, clientId: CLIENT, action, now: NOW
  });
  assert.equal(unreadable.verdict, 'ambiguous');
});

// ── Fail-closed edges ────────────────────────────────────────────────────────

test('fail-closed: absent tables, unknown anchors, missing inputs → ambiguous; other actions → null', async () => {
  const absent = makeMockClient([
    { match: 'from documents', throw: Object.assign(new Error('missing'), { code: '42P01' }) }
  ]);
  assert.equal((await evaluatePaidTruthDetailed({
    client: absent, firmId: FIRM, clientId: CLIENT, action: reminderAction(), now: NOW
  })).verdict, 'ambiguous');

  assert.equal((await evaluatePaidTruthDetailed({
    client: makeMockClient([]), firmId: FIRM, clientId: CLIENT,
    action: reminderAction({ anchor_type: 'mystery' }), now: NOW
  })).verdict, 'ambiguous');

  assert.equal((await evaluatePaidTruthDetailed({})).verdict, 'ambiguous');

  assert.equal((await evaluatePaidTruthDetailed({
    client: makeMockClient([]), firmId: FIRM, clientId: CLIENT,
    action: { action_type: 'issue_invoice', anchor_type: 'document', anchor_id: 'd' }, now: NOW
  })).verdict, null, 'non-reminder actions carry no paid-truth question');
});

test('the sweep-facing callback returns the bare verdict', async () => {
  const client = makeMockClient([
    { match: 'from documents', rows: [{ payment_status: 'unpaid' }] },
    { match: 'from reconciliation_matches', rows: [{ status: 'suggested' }] },
    { match: 'from reconciliation_evaluations', rows: [] }
  ]);
  assert.equal(
    await paidTruthCheck({ client, firmId: FIRM, clientId: CLIENT, action: reminderAction(), now: NOW }),
    'ambiguous'
  );
});
