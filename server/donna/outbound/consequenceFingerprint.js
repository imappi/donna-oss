// The approved-consequence fingerprint (kernel audit G13(b), M2).
//
// The executor already re-checks the anchor's lifecycle, suppression, and
// paid-truth at send time. What nothing detected was the draft's BUSINESS FACTS
// changing between the moment the owner approved and the moment the mail
// leaves: the recipient address moving, the invoice being re-drafted, a line or
// a total changing. The owner approved one consequence; a different one went
// out under that approval.
//
// So: fingerprint what the owner approved, at approval, on the action row; and
// re-compute it from live state at send. A mismatch is not a cancel — a cancel
// is a terminal Donna chose. It is a HOLD back onto the owner with a named
// reason, which is the correct second terminal (they re-approve or discard).
//
// WHAT IS IN THE FINGERPRINT is deliberately narrow: who receives it, which
// invoice, in what currency, for how much, when it is due, and what for. That
// is the consequence.
//
// WHAT IS DELIBERATELY OUT: the render cosmetics the owner is ALLOWED to edit
// on a held draft (`EDITABLE_DRAFT_RENDER_KEYS` — payment instructions, the
// business name). Including them would make the system's own sanctioned edit
// verb trip a stale-send refusal — a false alarm that teaches people to ignore
// the alarm. Also out: anything derived at render time (days_overdue,
// unsubscribe_url), which changes by the clock, not by anyone's decision.
//
// This module is pure — no I/O, no clock, no randomness — so the value is
// reproducible from a stored row during an audit, which is the point of a
// receipt.

import { createHash } from 'node:crypto';

const clean = (v) => String(v ?? '').trim();
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Canonical JSON, then sha256. Key order is fixed by construction (object
// literal order), amounts are fixed to 2dp strings so 1500 and 1500.0 agree,
// and the recipient is lower-cased so a casing change is not a false positive.
export const consequenceFingerprint = ({
  recipient = null, invoiceNumber = null, currency = null,
  total = null, dueDate = null, lines = [], statutoryFacts = undefined
} = {}) => {
  const canonical = JSON.stringify({
    recipient: clean(recipient).toLowerCase() || null,
    invoice_number: clean(invoiceNumber) || null,
    currency: clean(currency).toUpperCase() || null,
    total: total == null ? null : round2(total).toFixed(2),
    due_date: clean(dueDate) || null,
    lines: (lines || []).map((l) => ({
      description: clean(l?.description),
      quantity: round2(Number(l?.quantity ?? 1)),
      net: round2(Number(
        l?.net ?? (Number(l?.quantity ?? 1) * Number(l?.unitPrice ?? l?.unit_price ?? 0))
      ))
    })),
    ...(statutoryFacts === undefined ? {} : { statutory_facts: statutoryFacts })
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
};

// The fingerprint of an issuance anchor as it stands right now. Used at BOTH
// ends — stamped at approval, re-computed at send — so the two values can only
// differ if the underlying facts differ.
//
// `anchorRow` is the `issued_invoices` / `issued_quotes` row the executor
// already reads via checkIssuanceAnchorState; `recipient` is the address the
// party store resolves at that same moment.
export const fingerprintIssuanceConsequence = ({ recipient = null, anchorRow = null } = {}) => {
  const doc = anchorRow?.draft?.invoice || anchorRow?.draft?.quote || null;
  if (!doc) return null;
  return consequenceFingerprint({
    recipient,
    invoiceNumber: doc.invoiceNumber || doc.quoteNumber || null,
    currency: doc.currency,
    total: doc.total,
    dueDate: doc.dueDate || doc.validUntil || null,
    lines: doc.lines || [],
    // Opted-in invoices bind the statutory facts as well as the amount. Keep
    // older pack fingerprints byte-compatible when the new key is absent.
    ...(Object.hasOwn(doc.buyer || {}, 'taxRegistration') ? { statutoryFacts: {
      seller: doc.seller, buyer: doc.buyer, date: doc.date,
      supplyDate: doc.supplyDate, subtotal: doc.subtotal, taxTotal: doc.taxTotal,
      lines: (doc.lines || []).map((line) => ({ taxRate: line.taxRate, taxAmount: line.taxAmount }))
    } } : {})
  });
};

// The named reason a stale send refuses with. One value, in the receipt and in
// the hold — so "why did this come back to me?" has one answer everywhere.
export const STALE_CONSEQUENCE_REASON = 'approved_consequence_changed';
