// The one owner of "did this parse-cron summary fail?". A pure helper with no
// imports, so both the cloud route (api.js, `/documents/parse-cron`) and the
// desktop scheduler's manifest (desktop/handlerManifest.js, which must not load
// the router eagerly) read the same rule.
// The failures a parse-cron summary carries. Several tasks catch their own
// error into the summary so one failing task (or firm, or obligation) cannot
// stop the next; that is a receipt, not a success. On 2026-10-14 the hosted
// tasks answered 200 while the database refused every connection, because the
// route serialised such a summary as if it were done.
//
// The test for every shape: would recording the RUN as failed tell an operator
// something they cannot otherwise see and can act on? A failure of the run is
// work the sweep could not do whose only record is this summary (a refused
// query, a refused write, an unreachable transport). An item-level outcome
// that already has its own durable receipt and owner (a failed outbox row
// with a retry clock and a dead-letter, a provider rejection with a failed
// ledger entry, a typed incident, a refusal receipt) is not: failing every
// later run on it would bury the real failures.
//
// Read as failures of the run (verified against an unreachable database, a
// refused query, a failing delete and a failing send):
//   - a task entry with an `error` (coding_convergence, the loops stages,
//     evidence_topic_reminders, canonical_role_resolution, reconcile,
//     coding_auto_post, owner_media_terminal_summaries), or an owner-media
//     sweep whose gather read failed (`gather_failed`) or whose per-document
//     work threw (`skipped.threw`, logged only);
//   - a firm or bucket inside a task with an `error` (coding_convergence,
//     convergence_snapshot, storage_orphans);
//   - coding_convergence, per firm: a whole step that threw (every
//     `<step>_error` key: a discovery query, the waiting release, a recovery
//     worker), and a client whose coder / auto-post / ledger-post work threw
//     (`coder[]`, `swept[]`, `ledger_posted[]` with an `error`, and a coder
//     receipt's `ask_draft_error`);
//   - outbox: a row the requeue could not hand to the local queue (`failed[]`,
//     local-job path) or whose Inngest send failed (`failed` count, cloud);
//   - storage_orphans, per bucket: deletes the store refused (`delete_errors`)
//     and audit receipts the database refused (`audit_failures`);
//   - a statutory sweep whose obligation binding threw (`outcome: 'error'`),
//     whose binding counted per-candidate errors it records nowhere else
//     (`summary.errors > 0`), or whose pack would not load (`unloadable[]`);
//   - canonical_role_resolution: a client whose run threw and rolled back
//     (`clients[].status === 'error'`).
//
// Deliberately NOT read (item-level, each with its own receipt and owner):
//   - coding_convergence's `errors` sum (top level and per firm): it also
//     counts a posted correction whose reconsiderations are exhausted (state
//     'failed' on its own row, returned on every rotation), recovery-worker
//     item outcomes, and a coder policy failure whose typed incident the DB
//     boundary already persisted; a client refused by entity-readiness
//     admission is receipted as `runtime.readiness_admission_blocked`;
//   - the loops stages' `failed` / `deadLettered` / `reclaimed` counters: each
//     row is marked failed (retry with backoff) or cancelled on its own outbox
//     or inbox row; a database that refuses the stage surfaces as its `error`;
//   - drain `errors[]` / `worker_failed` / `exhausted`: each row is marked on
//     its own document with its retry owner;
//   - owner-media `skipped.send_failed`: one provider send, typed and logged,
//     the claim burned so it never repeats;
//   - storage_orphans `refused`: a key outside the book, kept and receipted,
//     refused again every day by design;
//   - canonical_role_resolution `model_error` / `refused`, evidence-topic
//     reminders `failed` (it also counts unbound / dark-channel skips, and a
//     provider rejection has its failed ledger row), reconcile `errors` and
//     coding_auto_post's per-line counters (operator-invoked, per-line receipts).
// Tasks that throw (stuck, drain …) already fail the request. The read-only
// diagnostics task reports its own read errors and is left alone.
const ADMISSION_REFUSAL_CODES = new Set([
  // runtimeReadinessAdmission.js ENTITY_READINESS_ADMISSION_ERROR /
  // PROCESSING_SCOPE_ADMISSION_ERROR: receipted, owned by entity readiness.
  'ENTITY_READINESS_ADMISSION_BLOCKED',
  'PROCESSING_SCOPE_ACCOUNTING_UNAVAILABLE'
]);

const codingConvergenceFailures = (task, firmId, result) => {
  const failures = [];
  if (!result || typeof result !== 'object') return failures;
  const scope = firmId ? { firm_id: firmId } : {};
  for (const [key, value] of Object.entries(result)) {
    if (key.endsWith('_error') && value) failures.push({ task, ...scope, step: key.slice(0, -'_error'.length), error: String(value) });
  }
  for (const key of ['coder', 'swept', 'ledger_posted']) {
    for (const item of Array.isArray(result[key]) ? result[key] : []) {
      if (!item || typeof item !== 'object') continue;
      const client = item.client_id ? { client_id: item.client_id } : {};
      if (item.error && !item.policy_failure && !ADMISSION_REFUSAL_CODES.has(item.code)) {
        failures.push({ task, ...scope, step: key, ...client, error: String(item.error) });
      }
      if (item.ask_draft_error) failures.push({ task, ...scope, step: 'ask_draft', ...client, error: String(item.ask_draft_error) });
    }
  }
  return failures;
};

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
    if (task === 'coding_convergence') {
      const firms = Array.isArray(value.firms) ? value.firms : null;
      if (firms) for (const item of firms) failures.push(...codingConvergenceFailures(task, item?.firm_id, item?.result));
      else failures.push(...codingConvergenceFailures(task, null, value));
    }
    if (task === 'owner_media_terminal_summaries' && Number(value.skipped?.threw) > 0) {
      failures.push({ task, error: `${Number(value.skipped.threw)} terminal summary attempt(s) threw` });
    }
    if (task === 'outbox') {
      if (Array.isArray(value.failed)) {
        for (const item of value.failed) failures.push({ task, ...(item?.document_id ? { document_id: item.document_id } : {}), ...(item?.parse_run_id ? { parse_run_id: item.parse_run_id } : {}), error: String(item?.error || 'requeue_failed') });
      } else if (Number(value.failed) > 0) {
        failures.push({ task, error: `${Number(value.failed)} of ${Number(value.picked) || 0} outbox resend(s) failed` });
      }
    }
    if (task === 'storage_orphans') {
      for (const item of Array.isArray(value.buckets) ? value.buckets : []) {
        if (Number(item?.delete_errors) > 0) {
          const first = Array.isArray(item.delete_failures) ? item.delete_failures[0] : null;
          failures.push({ task, bucket: item.bucket, error: `${Number(item.delete_errors)} orphan delete(s) failed${first?.error ? `: ${first.error}` : ''}` });
        }
        if (Number(item?.audit_failures) > 0) failures.push({ task, bucket: item.bucket, error: `${Number(item.audit_failures)} cleanup audit receipt(s) failed` });
      }
    }
    if (task === 'canonical_role_resolution') {
      for (const item of Array.isArray(value.clients) ? value.clients : []) {
        if (item?.status === 'error') failures.push({ task, ...(item.client_id ? { client_id: item.client_id } : {}), error: String(item.reason || 'error') });
      }
    }
    if (/^statutory_watches/.test(task)) {
      for (const item of Array.isArray(value.obligations) ? value.obligations : []) {
        if (item?.outcome === 'error') failures.push({ task, obligation_id: item.obligationId || null, error: String(item.error) });
        else if (Number(item?.summary?.errors) > 0) failures.push({ task, obligation_id: item.obligationId || null, error: `${Number(item.summary.errors)} candidate error(s)` });
      }
      for (const item of Array.isArray(value.unloadable) ? value.unloadable : []) {
        failures.push({ task, pack_id: item?.packId || null, error: String(item?.error || 'pack_unloadable') });
      }
    }
  }
  return failures;
};
