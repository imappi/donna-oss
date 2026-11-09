// The one owner of "did this parse-cron summary fail?". A pure helper with no
// imports, so both the cloud route (api.js, `/documents/parse-cron`) and the
// desktop scheduler's manifest (desktop/handlerManifest.js, which must not load
// the router eagerly) read the same rule.
// The failures a parse-cron summary carries. Several tasks catch their own
// error into the summary so one failing task (or firm, or obligation) cannot
// stop the next; that is a receipt, not a success. On 2026-10-14 the hosted
// tasks answered 200 while the database refused every connection, because the
// route serialised such a summary as if it were done. These are the shapes the
// task family writes on failure (verified against an unreachable database):
//   - a task entry with an `error` (coding_convergence, the loops stages,
//     evidence_topic_reminders, canonical_role_resolution, reconcile,
//     coding_auto_post, owner_media_terminal_summaries), or an owner-media
//     sweep whose gather read failed (`gather_failed`);
//   - a firm or bucket inside a task with an `error` (coding_convergence,
//     convergence_snapshot, storage_orphans);
//   - a statutory sweep whose obligations threw (`errors > 0`).
// Tasks that throw (outbox, stuck, drain …) already fail the request. The
// read-only diagnostics task reports its own read errors and is left alone.
export const parseCronSummaryFailures = (summary) => {
  const failures = [];
  for (const [task, value] of Object.entries(summary || {})) {
    if (task === 'diagnostics' || !value || typeof value !== 'object') continue;
    if (value.error) failures.push({ task, error: String(value.error) });
    else if (value.gather_failed === true) failures.push({ task, error: 'gather_failed' });
    for (const key of ['firms', 'buckets']) {
      for (const item of Array.isArray(value[key]) ? value[key] : []) {
        if (item?.error) failures.push({ task, ...(item.firm_id ? { firm_id: item.firm_id } : {}), ...(item.bucket ? { bucket: item.bucket } : {}), error: String(item.error) });
      }
    }
    if (/^statutory_watches/.test(task) && Number(value.errors) > 0) {
      for (const item of Array.isArray(value.obligations) ? value.obligations : []) {
        if (item?.outcome === 'error') failures.push({ task, obligation_id: item.obligationId || null, error: String(item.error) });
      }
    }
  }
  return failures;
};
