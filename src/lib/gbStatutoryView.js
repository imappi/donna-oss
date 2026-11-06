export const buildGbStatutoryViewModel = (envelope) => {
  if (!envelope || typeof envelope !== 'object') return null;
  const watch = envelope.thresholdWatch || null;
  return {
    entityType: envelope.entity_type || null,
    threshold: watch ? { status: watch.status || 'unknown', note: watch.note || null } : null,
    deadlines: (Array.isArray(envelope.deadlines) ? envelope.deadlines : []).map((deadline) => ({
      key: deadline.key, label: deadline.label, dueDate: deadline.due_date || deadline.dueDate || null,
      terminal: deadline.terminal || null, reasonCode: deadline.reason_code || null
    }))
  };
};

// The feed shows the UK watch only when it asks something of someone (Kari,
// 2026-10-02: a far-off calendar above the work list is noise). A row stays
// when it rests on the owner or has no date, when its due date is within
// `windowDays` or already past, and the threshold line stays when a review
// was asked. Nothing left means no section at all.
export const GB_STATUTORY_ATTENTION_DAYS = 30;

export const selectGbStatutoryAttention = (view, { today = new Date(), windowDays = GB_STATUTORY_ATTENTION_DAYS } = {}) => {
  if (!view) return null;
  const now = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const horizon = now + windowDays * 86400000;
  const deadlines = (view.deadlines || []).filter((deadline) => {
    if (deadline.terminal === 'on_owner' || !deadline.dueDate) return true;
    const due = Date.parse(`${String(deadline.dueDate).slice(0, 10)}T00:00:00Z`);
    return Number.isNaN(due) || due <= horizon;
  });
  if (!deadlines.length && !view.threshold) return null;
  return { ...view, deadlines };
};
