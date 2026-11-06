// The runtime liveness probe body (task_44a5069a) — what the desktop shell's
// watchdog calls over the private socket to tell a WEDGED runtime from a
// live one. Answering at all proves the event loop still serves; the bounded
// `select 1` proves the shared pg pool can still hand out a connection —
// the EPIPE-incident deadlock (PR #1921) starved exactly that, and a
// starved pool is a whole-runtime outage even while the process looks fine.
//
// Contract: ALWAYS answers fast (the DB probe is raced against its own
// timeout, never awaited unbounded), carries no book data, and never
// mutates. 200 {ok:true} is the only healthy shape; everything else is a
// probe failure for the watchdog to count.

const DEFAULT_DB_PROBE_TIMEOUT_MS = 5000;

export const runtimeLivenessProbe = async ({
  queryFn,
  databaseConfigured = true,
  timeoutMs = Number(process.env.DONNA_RUNTIME_LIVENESS_DB_TIMEOUT_MS) || DEFAULT_DB_PROBE_TIMEOUT_MS
} = {}) => {
  if (!databaseConfigured) {
    // No DB is a configuration state, not a wedge — never invite a kill
    // over it. (The desktop shell always configures one; this arm exists
    // for the cloud dev shapes that share the router.)
    return { status: 200, body: { ok: true, db_ok: null, reason: 'db_not_configured' } };
  }
  const startedAt = process.hrtime.bigint();
  let timer = null;
  try {
    await Promise.race([
      queryFn('select 1'),
      new Promise((_, reject) => {
        // Deliberately NOT unref'd: this timer is what bounds a hung pool
        // probe — the exact wedge this route exists to expose (the
        // localScheduler timeout race carries the same note).
        timer = setTimeout(() => reject(new Error('db_probe_timeout')), timeoutMs);
      })
    ]);
    const dbMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    return { status: 200, body: { ok: true, db_ok: true, db_ms: Math.round(dbMs) } };
  } catch (error) {
    const timedOut = error?.message === 'db_probe_timeout';
    return {
      status: 503,
      body: {
        ok: false,
        db_ok: false,
        reason: timedOut ? 'db_timeout' : 'db_error',
        detail: timedOut ? `no pool connection within ${timeoutMs}ms` : String(error?.message || error).slice(0, 200)
      }
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
};
