// Donna — FE convergence-metrics view aggregator (Slice J consumer, display side).
//
// The reconcile feed's rows already carry a PERSISTED per-row convergence verdict
// (`convergence_state` + `convergence_reason`), attached by the backend's single
// projection module (server/donna/reconcileConvergenceState.js, via
// getFirmSnapshotFromDb). This helper TALLIES those persisted verdicts for display
// in the Reconcile workbench — it never re-derives convergence in the FE (the
// established FE rule: read `convergence_state` off the row, never recompute it;
// see donna-financials-panel partitionBareReconcileTxs). It is the display twin of
// the backend's `convergenceMetrics` and produces the SAME shape; the two agree by
// construction because they tally the same per-row verdicts with the same dedup.
//
// Dedup: ONE projection per transaction — the review-queue item's verdict wins
// over the bare transaction's (the same tab-membership rule the feed/FE use; most
// doc-matched bank lines never get a queue row). Rows without an attached state are
// ignored (no verdict to render).
//
// Pure / dependency-free so it unit-tests under node --test.

const per100 = (n, total) => (total === 0 ? 0 : Math.round((n / total) * 1000) / 10);

export const buildConvergenceMetricsView = ({ transactions = [], reviewItems = [] } = {}) => {
  // tx id -> { state, reason }; bare tx first, review item overrides (wins).
  const byTx = new Map();
  const put = (txId, row) => {
    if (txId == null || !row) return;
    const state = row.convergence_state;
    if (!state) return; // no attached verdict → nothing to render
    byTx.set(txId, { state, reason: row.convergence_reason ?? null });
  };
  for (const tx of Array.isArray(transactions) ? transactions : []) put(tx?.id, tx);
  for (const item of Array.isArray(reviewItems) ? reviewItems : []) {
    put(item?.payload?.transaction_id ?? item?.item_id, item);
  }

  const counts = { auto_reconciled: 0, on_owner: 0, hanging: 0 };
  const hanging_by_reason = {};
  for (const { state, reason } of byTx.values()) {
    if (counts[state] == null) continue;
    counts[state] += 1;
    if (state === 'hanging') {
      const key = reason || 'unspecified';
      hanging_by_reason[key] = (hanging_by_reason[key] || 0) + 1;
    }
  }
  const total = counts.auto_reconciled + counts.on_owner + counts.hanging;
  return {
    ...counts,
    total,
    converged: counts.hanging === 0,
    hanging_by_reason,
    authority_misses: hanging_by_reason.matched_pending_authority_no_grant || 0,
    prompts_per_100: per100(counts.on_owner, total),
    hanging_per_100: per100(counts.hanging, total),
  };
};

// Human label for a hanging reason key (the projection emits machine reasons like
// `coding_state:proposed` / `matched_pending_authority_no_grant`). Kept small and
// non-exhaustive — an unmapped reason falls back to a tidied version of the key so a
// new backend reason still renders legibly instead of disappearing.
const REASON_LABELS = {
  matched_pending_authority_no_grant: 'Awaiting authority',
  matched_but_uncoded: 'Matched, not coded',
  unclassified: 'Unclassified',
  unspecified: 'Unspecified',
  'coding_state:proposed': 'Proposed, not decided',
  'coding_state:held': 'Reviewer held',
  'reconciliation_status:needs_review': 'Needs review',
  'disposition:needs_human': 'Needs a human',
  'disposition:chase_receipt': 'Chasing receipt',
  'disposition:chase_evidence': 'Awaiting evidence ask',
};

export const labelForHangingReason = (key = '') => {
  if (REASON_LABELS[key]) return REASON_LABELS[key];
  // `prefix:value` → "Value"; bare snake_case → "Bare words".
  const tail = String(key).includes(':') ? String(key).split(':').slice(1).join(':') : String(key);
  const words = tail.replace(/_/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Other';
};
