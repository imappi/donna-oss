// Bounded-concurrency mapper for the upload paths. A multi-file drop used
// to fire every storage PUT at once via Promise.all — 40 simultaneous
// requests against the desktop runtime is a burst with no upside (the
// browser caps sockets anyway and the runtime serializes on its DB pool),
// and it was the trigger for the 2026-08-31 pool-deadlock freeze. Uploads
// now run a few at a time; results keep input order, and per-item error
// handling stays the caller's job exactly as it was under Promise.all.

export const UPLOAD_CONCURRENCY = 4;

// Maps `items` through `mapper(item, index)` with at most `limit` calls in
// flight. Resolves to results in input order. A mapper rejection rejects
// the whole map (same contract as Promise.all) — upload callers catch
// per-item and return null, so a single failed file never aborts a batch.
export const mapWithConcurrency = async (items = [], limit = UPLOAD_CONCURRENCY, mapper) => {
  const list = Array.from(items);
  if (typeof mapper !== 'function') throw new Error('mapWithConcurrency needs a mapper function.');
  const results = new Array(list.length);
  if (!list.length) return results;
  const laneCount = Math.max(1, Math.min(Math.floor(limit) || 1, list.length));
  let nextIndex = 0;
  const lanes = Array.from({ length: laneCount }, async () => {
    while (nextIndex < list.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(list[index], index);
    }
  });
  await Promise.all(lanes);
  return results;
};
