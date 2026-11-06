// Shared mechanical observation for the measured Jev contract and UI preview.
import { candidateMechanicalChecks, linkArithmetic } from './jevEvidenceContract.js';
import { paymentMatchesInvoice } from './issuedInvoiceSettlementMath.js';
const directionOf = p => p.invoice.document_type === 'sales_invoice' ? 'money_in_minor' : 'money_out_minor';
export function mechanicalFacts(prepared) {
  const p = prepared.packet, direction = directionOf(p);
  const active = p.allocations.filter(a => a.status !== 'rejected');
  const prior = active.filter(a => a.invoice_id === p.invoice.id && a.object_type === p.invoice.document_type).reduce((n, a) => n + a.amount_minor, 0);
  const remaining = p.invoice.amount_minor - prior;
  const rel = i => prepared.state.relationships[i];
  return {
    direction: direction === 'money_in_minor' ? 'money_in' : 'money_out',
    invoice_amount_minor: p.invoice.amount_minor, prior_allocated_minor: prior, remaining_minor: remaining,
    repeated_reference_among_competitors: p.related_invoices.some(i => i.reference && i.reference === p.invoice.reference),
    candidates: Object.fromEntries(p.transactions.map(t => [prepared.bank_handles[t.id], {
      eligible: prepared.eligible_ids.includes(t.id), direction_compatible: t[direction] > 0, bank_amount_minor: t[direction],
      same_currency_as_invoice: t.currency === p.invoice.currency,
      reference_present: paymentMatchesInvoice({ referenceNumber: p.invoice.reference }, t),
      already_allocated: active.some(a => a.transaction_id === t.id),
      instrument: t.instrument ?? null, reversed_by: (() => { const r = candidateMechanicalChecks(prepared, t, remaining).reversal; return r ? prepared.bank_handles[r.transaction_id] : null; })(),
      relationships: p.links.map((l, i) => l.transaction_id === t.id ? { handle: rel(i).handle, kind: l.kind, invoice: rel(i).invoice,
        arithmetic_consistent: l.kind === 'different_obligation' ? null : linkArithmetic(p, l, t, remaining) } : null).filter(Boolean)
    }]))
  };
}
export const stateWithFacts = prepared => ({ ...prepared.state, mechanical_facts: mechanicalFacts(prepared) });

