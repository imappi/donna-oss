// Doc-first terminal drain — document disposition shape (dependency-free leaf).
//
// Constants live here with NO imports, mirroring bankLineDispositionShape.js
// and for the same reason: the producer (documentDispositionLlm.js) pulls in
// the reconciliation LLM core, which participates in the core ↔ firmDb ↔
// loopsShadowProducers import cycle — a module-init reference to these
// constants from inside that cycle (the gap-guard SQL fragment in
// loopsShadowProducers.js) would hit the TDZ. Keep this file import-free.

// reconciliation_evaluations key for a document no-line disposition verdict.
// target_type 'document' (migration 028's generic target), matcher_family
// distinct from every family matcher so the verdict rows never collide.
export const DOCUMENT_NO_LINE_DISPOSITION_FAMILY = 'document_no_line_disposition';
export const DOCUMENT_NO_LINE_DISPOSITION_TARGET_TYPE = 'document';
export const DOCUMENT_NO_LINE_DISPOSITION_POLICY_VERSION = 'document_no_line_disposition_v1';

// A negative bank match can leave an invoice obligation open. Settlement
// evidence (receipts, confirmations and payouts) still needs disposition.
// Jev source preparation (jevPreview.js) is versioned here, in this dependency-
// free module, because the recovery pool reads it at module initialisation.
// Bumped when source preparation changes what a Jev case can express. A pending
// evaluation from an earlier preparation re-enters once under the new one; the
// retry budget then counts afresh (the coding-contract pattern).
export const JEV_PREPARATION_CONTRACT = 'jev-preparation-v2';

export const NO_SETTLEMENT_OBLIGATION_TYPES = Object.freeze(['sales_invoice', 'supplier_bill']);

// The config-plane flag key (plan §5). Born on the plane: read via
// clientFlagActs / clientFlagObserves with envFallback () => false — NO env
// pair, ever. Kill switch: CLIENT_CONFIG_FORCE_DISABLE=DOCUMENT_NO_LINE_DISPOSITION.
export const DOCUMENT_NO_LINE_DISPOSITION_FLAG_KEY = 'DOCUMENT_NO_LINE_DISPOSITION';

// Slice 4b (docs/donna-settlement-answer-and-ledger-entry-plan.md §3/§6) — the
// settlement LEDGER ENTRY flag, same birth rules as above (plane-only,
// envFallback () => false; kill switch CLIENT_CONFIG_FORCE_DISABLE). Ladder:
// ∅ → shadow (proposal cards minted + sized, NO ledger write, NO
// payment_status touch) → canary (post + FYI) → auto.
export const DOCUMENT_SETTLEMENT_LEDGER_ENTRY_FLAG_KEY = 'DOCUMENT_SETTLEMENT_LEDGER_ENTRY';

// proposal_cards.proposal_type for the settlement-entry card (plan §3) and the
// deterministic one-card-per-doc id prefix (persistProposalCard is write-once).
export const DOCUMENT_SETTLEMENT_ENTRY_PROPOSAL_TYPE = 'document_settlement_entry';
export const documentSettlementProposalId = (documentId) =>
  `docsettle-${String(documentId || '').trim()}`;

// The late-bank-line reversal guard (plan §3's named follow-up, built
// 2026-07-21): the card that proposes reversing a document's owner-funds
// settlement journal after a bank line confirmed against the same document.
// Same birth rules: deterministic one-card-per-doc id, write-once. The guard
// deliberately rides DOCUMENT_SETTLEMENT_LEDGER_ENTRY (no flag of its own —
// the 4a "one flag ⇒ the entry and its correction are live together"
// precedent; a separately-staged guard could lag the entry lane and re-open
// the silent double-count it exists to close).
export const DOCUMENT_SETTLEMENT_REVERSAL_PROPOSAL_TYPE = 'document_settlement_reversal';
export const documentSettlementReversalProposalId = (documentId) =>
  `docsettlerev-${String(documentId || '').trim()}`;
