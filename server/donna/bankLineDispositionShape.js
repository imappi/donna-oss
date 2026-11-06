// Phase 7.2 — bank-line disposition shape (dependency-free leaf).
//
// The constants + the pure read-side summarizer live here, with NO imports,
// so BOTH the producer (`bankLineDispositionLlm.js`, which pulls in the
// reconciliation LLM core) AND the snapshot reader (`firmDb.js`) can use them
// without widening the existing firmDb ↔ reconciliationLlmCore import cycle.
// Keep this file import-free.

// reconciliation_evaluations key for a bank-line disposition verdict. The
// target is the bank line itself, so target_type is 'transaction' and the
// matcher_family is distinct from the document matchers.
export const BANK_LINE_DISPOSITION_FAMILY = 'bank_line_disposition';
export const BANK_LINE_DISPOSITION_TARGET_TYPE = 'transaction';
// RT-26 (2026-09-09): v2 — the ask kind follows what the lane knows. The
// money_out vocabulary gained 'statutory_payment', both prompts gained
// `line_identified` and the "never ask what you have named" rule, and the
// chase lanes mint a document ask. A prompt change is a policy change: the
// incremental guard re-evaluates lines stamped at v1 on the next sweep.
export const BANK_LINE_DISPOSITION_POLICY_VERSION = 'bank_line_disposition_v2';

// Pure read-model derivation (7.2b-ii): shape persisted bank-line disposition
// verdict rows (reconciliation_evaluations) into a Map keyed by transaction id
// for the feed to render. Renders the PERSISTED verdict — never a re-inference.
// INV-4: a live settling match outranks the verdict, so transactions with a
// confirmed/auto_matched match are dropped (the caller supplies that set from
// the reconciliation_matches it already loaded).
export const summarizeBankLineDispositions = (rows = [], { settledTransactionIds } = {}) => {
  const settled = settledTransactionIds instanceof Set
    ? settledTransactionIds
    : new Set(Array.isArray(settledTransactionIds) ? settledTransactionIds : []);
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.target_type !== BANK_LINE_DISPOSITION_TARGET_TYPE) continue;
    if (row.matcher_family !== BANK_LINE_DISPOSITION_FAMILY) continue;
    // Migration 131's verdict fence: a stamp a live document match superseded
    // is not a verdict to render — its prior content survives in the row's
    // payload and the supersede audit receipt, never on the feed.
    if (row.verdict === 'superseded') continue;
    const txId = row.target_id;
    if (!txId || settled.has(txId)) continue;
    const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
    map.set(txId, {
      verdict: row.verdict || null,
      disposition: payload.disposition || null,
      materiality: payload.materiality || null,
      expense_kind: payload.expense_kind || null,
      confidence: typeof payload.confidence === 'number' ? payload.confidence : null,
      // The model's one-sentence justification (7.2b chip/tooltip): render the
      // persisted "why", never a render-time re-inference.
      reasoning: typeof payload.reasoning === 'string' ? payload.reasoning : null,
      reason: row.unmatchable_reason || null,
      model: row.model || null,
      // RT-10 — the lane a needs_human verdict took ({ kind, … }); null when
      // the verdict has none. RT-13 carries `lane.kind` into the persisted
      // convergence reason key (reconcileConvergenceState.js), so every
      // projection site that reads this map agrees on the key.
      lane: payload.lane && typeof payload.lane === 'object' ? payload.lane : null
    });
  }
  return map;
};
