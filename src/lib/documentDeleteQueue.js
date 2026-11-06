// Serialized, optimistic document deletion for the firm console.
//
// Why this exists (2026-07-21 multi-delete bug): each document DELETE
// round-trips a full firm snapshot, and the list view only dropped a row
// when that snapshot came back and wholesale-replaced the documents
// state. Deleting several documents one by one therefore (a) left every
// row visible for the many seconds its round-trip took, and (b) raced:
// with two deletes in flight, the earlier delete's returned snapshot
// still CONTAINS the later delete's document, so applying it resurrected
// a row the user had already deleted.
//
// The queue fixes both without touching the server contract:
//   - optimistic: the row leaves local state the moment the user acts
//     (removeDocument), and is restored if the server refuses the delete
//   - serialized: one DELETE in flight at a time, so each returned
//     snapshot is strictly fresher than the one before it
//   - guarded: isPending() lets the app's snapshot applier drop rows
//     whose delete is still queued or in flight, so NO snapshot source
//     (a delete response, a feed poll, a chat apply) can resurrect them
//
// Framework-free on purpose: the factory takes plain callbacks so the
// serialization + resurrection guarantees are unit-testable without
// React.
export const createDocumentDeleteQueue = ({
  deleteDocument,
  applySnapshot,
  removeDocument,
  restoreDocument,
  onError
} = {}) => {
  let chain = Promise.resolve();
  const pending = new Set();

  const isPending = (documentId) => pending.has(documentId);

  // Drop rows whose delete has not committed server-side yet. Exposed so
  // the app-level snapshot applier can run EVERY incoming snapshot
  // through it, whatever produced the snapshot.
  const filterSnapshotDocuments = (documents) => (
    Array.isArray(documents) ? documents.filter((doc) => !pending.has(doc?.id)) : documents
  );

  const request = (documentId, documentRow = null, { reportError = true } = {}) => {
    if (!documentId) return Promise.resolve({ ok: false, documentId, skipped: true });
    if (pending.has(documentId)) return Promise.resolve({ ok: false, documentId, skipped: true });
    pending.add(documentId);
    removeDocument?.(documentId);
    const run = chain.then(async () => {
      try {
        const snapshot = await deleteDocument(documentId);
        pending.delete(documentId);
        applySnapshot?.(snapshot);
        return { ok: true, documentId, snapshot };
      } catch (error) {
        // The server refused (retention hold, 404, outage): the
        // optimistic removal was wrong, put the row back and surface it.
        pending.delete(documentId);
        restoreDocument?.(documentId, documentRow);
        if (reportError) onError?.(error, documentId);
        return { ok: false, documentId, error };
      }
    });
    // The run above never rejects (both arms are handled), so the chain
    // stays alive for subsequent deletes regardless of outcome.
    chain = run;
    return run;
  };

  return { request, isPending, filterSnapshotDocuments };
};
