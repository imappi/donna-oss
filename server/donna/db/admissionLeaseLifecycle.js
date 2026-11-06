// Process-local ownership of existing PostgreSQL session locks. This is cleanup
// bookkeeping, not admission authority or a durable lease backend.
const leasesByClient = new WeakMap();

const cleanupError = (code, message) => Object.assign(new Error(message), {
  code, responsible_system: 'donna_database_connection', retryable: true
});

// Same cancellation shape as the cloud readiness checkout: close and await
// this owned connection, never abandon a SQL promise or run a late retry.
export const ADMISSION_LEASE_CLEANUP_TIMEOUT_MS = 5000;
export const withAdmissionCleanupDeadline = async (client, work, timeoutMs = ADMISSION_LEASE_CLEANUP_TIMEOUT_MS) => {
  let expired = false, closePromise;
  const timer = setTimeout(() => {
    expired = true;
    closePromise = Promise.resolve().then(() => client.end()).catch(() => {});
  }, timeoutMs);
  try {
    const result = await work();
    if (expired) throw cleanupError('ADMISSION_LEASE_CLEANUP_TIMEOUT', 'The database connection closed because admission lock cleanup timed out.');
    return result;
  } catch (error) {
    if (expired) throw cleanupError('ADMISSION_LEASE_CLEANUP_TIMEOUT', 'The database connection closed because admission lock cleanup timed out.');
    throw error;
  } finally {
    clearTimeout(timer);
    if (closePromise) await closePromise;
  }
};

export const retainAdmissionCleanupCause = (error, cleanup) => {
  if (error && (typeof error === 'object' || typeof error === 'function')) {
    error.admission_lease_cleanup = [
      ...(error.admission_lease_cleanup || []),
      { code: cleanup?.code || 'ADMISSION_LEASE_CLEANUP_FAILED', responsible_system: 'donna_database_connection' }
    ];
  }
};

export const acquireSessionAdmissionLease = async (client, key) => {
  if (typeof client.end !== 'function') {
    throw cleanupError('ADMISSION_LEASE_CONNECTION_NOT_OWNED', 'Admission needs an owned database connection that can be closed if lock cleanup fails.');
  }
  let held = leasesByClient.get(client);
  if (!held) { held = new Set(); leasesByClient.set(client, held); }
  let released = false;
  let releasing = null;
  const lease = {
    release: async () => {
      if (released) return;
      if (releasing) return releasing;
      releasing = withAdmissionCleanupDeadline(client, async () => {
        const result = await client.query('select pg_advisory_unlock_shared(hashtextextended($1, 0)) as released', [key]);
        if (result.rows?.[0]?.released !== true) {
          throw cleanupError('ADMISSION_LEASE_RELEASE_MISMATCH', 'The database session did not own the admission lock. Check the database connection mode.');
        }
        released = true;
        held.delete(lease);
        if (!held.size) leasesByClient.delete(client);
      });
      try { await releasing; } finally { releasing = null; }
    }
  };
  // Retain uncertain acquisition too: a transport error does not prove that
  // PostgreSQL failed to take the lock before the connection stopped replying.
  held.add(lease);
  await client.query('select pg_advisory_lock_shared(hashtextextended($1, 0))', [key]);
  return lease;
};

export const releaseAdmissionLeasePreservingError = async (lease, firstError) => {
  try { await lease.release(); }
  catch (error) {
    if (!firstError) throw error;
    retainAdmissionCleanupCause(firstError, error);
  }
};

// Only the checkout owner calls this, AFTER the callback and its transaction
// owner have finished. Inner writers must never roll back somebody else's work.
export const cleanupAdmissionLeasesAtCheckoutEnd = async (client) => {
  const held = leasesByClient.get(client);
  if (!held?.size) return;
  return withAdmissionCleanupDeadline(client, async () => {
    await client.query('rollback');
    let firstError;
    for (const lease of [...held]) {
      try { await lease.release(); }
      catch (error) {
        if (!firstError) firstError = error;
        else retainAdmissionCleanupCause(firstError, error);
      }
    }
    if (firstError) throw firstError;
  });
};
