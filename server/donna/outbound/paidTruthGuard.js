// Send-time paid-truth guard (M1, G4 — execution plan A3; the M1 long pole).
// ONE composed verdict over BOTH payment-truth mechanisms the tree runs
// (gap-6: they are disjoint, and reading either alone chases paid invoices):
//
//   Parsed-document lane (anchor_type 'document' — the US launch lane):
//     documents.payment_status flips only on a CONFIRMED or AUTO_MATCHED
//     reconciliation match, and unattended auto-match is off by default — so
//     a genuinely-paid invoice routinely rests at payment_status='unpaid'
//     with a 'suggested' match awaiting a click (risk #1, the
//     suggested-but-unconfirmed fixture). The guard therefore composes:
//       payment_status ∈ paid/void/credit_note      → settled  (cancel)
//       payment_status ∈ partial/unknown/missing    → ambiguous (hold)
//       open suggested match                        → ambiguous (hold)
//       open confirmed/auto_matched match while the
//         status still says unpaid (cascade raced)  → ambiguous (hold)
//       already_settled evaluation verdict          → ambiguous (hold)
//       else                                        → unpaid   (send lane)
//
//   Issued-invoice lane (anchor_type 'issued_invoice' — M2/M3): the same
//     hydration the read surface runs (issued invoice + ISSUED credit notes +
//     money-in bank lines matched by reference), evaluated FRESH through the
//     pure evaluateIssuedInvoiceSettlement:
//       paid/overpaid/credited → settled;  partially_paid → ambiguous;
//       unpaid → unpaid. A missing/uncomputable row → ambiguous.
//
// Verdict semantics downstream (the gate consumes this fail-closed): only an
// explicit 'unpaid' lets a reminder through; 'ambiguous'/null HOLDS for the
// owner; 'settled' auto-cancels with a receipt. The guard never guesses:
// every unreadable input degrades to 'ambiguous', never to 'unpaid'.
//
// US conservatism (D4): with no reference scheme, the parsed lane has no
// deterministic settlement signal — ambiguity always holds. Graduating US
// dunning toward auto is gated on the D4 pay-link webhook, not on loosening
// anything here.
//
// Keep-layer posture: deterministic reads + a pure state machine. No LLM.

// gap 8, edge 2 — CLOSED 2026-07-27. This arithmetic used to be imported from
// `finland/issuedInvoiceSettlement.js`, which put a country module upstream of
// the generic engine. The functions are unchanged; they now live in a
// jurisdiction-neutral home and `finland/` re-exports them for its own
// consumers. Nothing Finnish was moved and nothing was duplicated.
import {
  evaluateIssuedInvoiceSettlement, paymentMatchesInvoice
} from '../issuedInvoiceSettlementMath.js';
import { getActivePayLinkForAnchor, payLinkSettlementVerdict } from './payLinks.js';

export const PAID_TRUTH_GUARD_VERDICTS = Object.freeze(['unpaid', 'ambiguous', 'settled']);

const missingTables = (error) => error?.code === '42P01' || error?.code === '42703';

// Pure mapper for the parsed lane — exhaustively testable without SQL.
export const composeParsedInvoicePaidTruth = ({
  paymentStatus = null, openMatchStatuses = [], evaluationReasons = []
} = {}) => {
  const status = String(paymentStatus || '').trim().toLowerCase();
  if (['paid', 'void', 'credit_note'].includes(status)) return { verdict: 'settled', reason: `payment_status_${status}` };
  if (status !== 'unpaid') return { verdict: 'ambiguous', reason: status ? `payment_status_${status}` : 'payment_status_missing' };
  const matches = (Array.isArray(openMatchStatuses) ? openMatchStatuses : []).map((s) => String(s || '').toLowerCase());
  if (matches.includes('confirmed') || matches.includes('auto_matched')) {
    // A decided match should have flipped payment_status; seeing both at once
    // means the cascade raced or failed — hold, never trust either side.
    return { verdict: 'ambiguous', reason: 'decided_match_status_mismatch' };
  }
  if (matches.includes('suggested')) {
    return { verdict: 'ambiguous', reason: 'open_suggested_match' };
  }
  const reasons = (Array.isArray(evaluationReasons) ? evaluationReasons : []).map((r) => String(r || '').toLowerCase());
  if (reasons.includes('already_settled')) {
    return { verdict: 'ambiguous', reason: 'already_settled_evaluation' };
  }
  return { verdict: 'unpaid', reason: 'payment_status_unpaid_no_open_signal' };
};

const evaluateParsedLane = async (client, { firmId, clientId, documentId }) => {
  const doc = await client.query(
    `select payment_status from documents
      where firm_id = $1 and client_id = $2 and id = $3`,
    [firmId, clientId, documentId]
  ).then((r) => r.rows[0] || null);
  if (!doc) return { verdict: 'ambiguous', reason: 'document_missing' };

  // matched_object_type carries the document's OWN type ('sales_invoice',
  // falling back to 'document' — the firmDb manual-link convention), so match
  // on the id across both spellings.
  const matches = await client.query(
    `select status from reconciliation_matches
      where firm_id = $1 and client_id = $2
        and matched_object_type in ('sales_invoice', 'document')
        and matched_object_id = $3
        and status in ('suggested', 'confirmed', 'auto_matched')`,
    [firmId, clientId, documentId]
  ).then((r) => r.rows.map((row) => row.status)).catch((error) => {
    if (missingTables(error)) return [];
    throw error;
  });

  const evaluations = await client.query(
    `select unmatchable_reason from reconciliation_evaluations
      where firm_id = $1 and client_id = $2
        and target_type = 'document' and target_id = $3`,
    [firmId, clientId, documentId]
  ).then((r) => r.rows.map((row) => row.unmatchable_reason).filter(Boolean)).catch((error) => {
    if (missingTables(error)) return [];
    throw error;
  });

  return composeParsedInvoicePaidTruth({
    paymentStatus: doc.payment_status,
    openMatchStatuses: matches,
    evaluationReasons: evaluations
  });
};

// Issued lane: the getFinlandIssuedInvoicesFromDb hydration, scoped to ONE
// invoice, evaluated fresh through the pure module. Read-only.
const evaluateIssuedLane = async (client, { firmId, clientId, invoiceId, now }) => {
  const invoice = await client.query(
    `select * from issued_invoices
      where firm_id = $1 and client_id = $2 and id = $3
        and status = 'issued' and coalesce(kind, 'invoice') = 'invoice'`,
    [firmId, clientId, invoiceId]
  ).then((r) => r.rows[0] || null).catch((error) => {
    if (missingTables(error)) return null;
    throw error;
  });
  if (!invoice) return { verdict: 'ambiguous', reason: 'issued_invoice_missing' };

  const draftInvoice = invoice.draft?.invoice || {};
  const referenceNumber = invoice.draft?.finvoice?.invoiceDetails?.referenceNumber
    || invoice.draft?.finvoice?.paymentDetails?.referenceNumber
    || null;
  const total = Number(draftInvoice.total) || 0;
  if (!(total > 0)) return { verdict: 'ambiguous', reason: 'issued_invoice_total_unreadable' };

  const credited = await client.query(
    `select coalesce(sum((draft->'invoice'->>'total')::numeric), 0) as credited
       from issued_invoices
      where firm_id = $1 and client_id = $2
        and kind = 'credit_note' and status = 'issued'
        and credits_invoice_id = $3`,
    [firmId, clientId, invoiceId]
  ).then((r) => Number(r.rows[0]?.credited) || 0).catch((error) => {
    if (missingTables(error)) return 0;
    throw error;
  });

  const sinceDate = String(draftInvoice.date || '').slice(0, 10);
  // G12: structured_reference (migration 098) joins the settlement read. On a
  // pre-098 database the column-bearing select 42703s — RETRY without the
  // column rather than degrading to an empty read (an empty read would flip
  // genuinely-paid invoices to 'unpaid' and un-cancel their reminders).
  const txSelect = (withStructured) =>
    `select id, description, raw_description${withStructured ? ', structured_reference' : ''}, money_in, transaction_date
       from transactions
      where firm_id = $1 and client_id = $2
        and money_in > 0
        and (transaction_date is null or transaction_date >= $3)
      order by transaction_date nulls last
      limit 5000`;
  const txParams = [firmId, clientId, /^\d{4}-\d{2}-\d{2}$/.test(sinceDate) ? sinceDate : '1970-01-01'];
  const txRows = await client.query(txSelect(true), txParams)
    .then((r) => r.rows)
    .catch(async (error) => {
      if (!missingTables(error)) throw error;
      return client.query(txSelect(false), txParams).then((r) => r.rows).catch((legacyError) => {
        if (missingTables(legacyError)) return [];
        throw legacyError;
      });
    });
  const payments = txRows
    .filter((tx) => paymentMatchesInvoice(
      { referenceNumber, invoiceNumber: draftInvoice.invoiceNumber }, tx
    ))
    .map((tx) => ({ amount: Number(tx.money_in) || 0, date: tx.transaction_date || null }));

  const settlement = evaluateIssuedInvoiceSettlement({
    total,
    dueDate: draftInvoice.dueDate || null,
    creditedTotal: credited,
    payments,
    onDate: new Date(now).toISOString()
  });
  if (['paid', 'overpaid', 'credited'].includes(settlement.payment_state)) {
    return { verdict: 'settled', reason: `settlement_${settlement.payment_state}` };
  }
  if (settlement.payment_state === 'partially_paid') {
    return { verdict: 'ambiguous', reason: 'settlement_partially_paid' };
  }
  return { verdict: 'unpaid', reason: 'settlement_unpaid' };
};

// The composed guard. Returns 'unpaid' | 'ambiguous' | 'settled' (never
// null, never a throw for the expected failure modes — an unreadable lane is
// 'ambiguous'). Detail lives on evaluatePaidTruthDetailed for receipts/tests.
export const evaluatePaidTruthDetailed = async ({
  client, firmId, clientId, action, now = Date.now()
} = {}) => {
  if (!client || !firmId || !clientId || !action) {
    return { verdict: 'ambiguous', reason: 'guard_inputs_missing' };
  }
  if (action.action_type && action.action_type !== 'send_receivable_reminder') {
    // Only receivable reminders carry a paid-truth question.
    return { verdict: null, reason: 'not_a_receivable_reminder' };
  }
  try {
    // D4 first: a settled pay-link is the DETERMINISTIC settlement signal
    // (the webhook is signature-verified) — it outranks both heuristic lanes
    // in either direction of doubt. A partial/odd link state degrades to
    // 'ambiguous'; an active-unsettled link says nothing and falls through.
    const link = await getActivePayLinkForAnchor(client, {
      firmId, clientId, anchorType: action.anchor_type, anchorId: action.anchor_id
    });
    const linkVerdict = payLinkSettlementVerdict(link);
    if (linkVerdict) return linkVerdict;

    if (action.anchor_type === 'document') {
      return await evaluateParsedLane(client, { firmId, clientId, documentId: action.anchor_id });
    }
    if (action.anchor_type === 'issued_invoice') {
      return await evaluateIssuedLane(client, { firmId, clientId, invoiceId: action.anchor_id, now });
    }
    return { verdict: 'ambiguous', reason: `unknown_anchor_type_${action.anchor_type}` };
  } catch (error) {
    if (missingTables(error)) return { verdict: 'ambiguous', reason: 'tables_absent' };
    throw error;
  }
};

// The sweep-facing callback (executeDueOutboundActions({ paidTruthCheck })).
export const paidTruthCheck = async (args) => {
  const { verdict } = await evaluatePaidTruthDetailed(args);
  return verdict;
};
