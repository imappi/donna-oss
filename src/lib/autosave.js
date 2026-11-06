// Serialized, coalescing autosave for full-value PATCH fields.
//
// The bug this exists for (June 2026, services_engaged): a card that
// autosaves a FULL array on every checkbox toggle fired one PATCH per
// click with no serialization. Three quick clicks → three concurrent
// writes racing to commit (last commit wins with whatever array it
// carried), while each returned snapshot reset the optimistic UI to a
// stale echo — boxes 2 and 3 visibly unticked themselves.
//
// Contract: push(value) records the latest desired value. At most one
// write is in flight; pushes during a write coalesce into exactly one
// follow-up write carrying the LATEST value. onSuccess fires only for
// the final settled write (intermediate snapshots are stale by
// definition); onError fires when a write fails after which the queue
// is drained (caller reverts to persisted truth).
export const createCoalescedAutosave = ({ write, onSuccess, onError } = {}) => {
  let inFlight = false;
  let queued = false;
  let latest;

  const flush = () => {
    inFlight = true;
    const value = latest;
    Promise.resolve()
      .then(() => write(value))
      .then((result) => {
        if (queued) {
          queued = false;
          flush();
          return;
        }
        inFlight = false;
        if (typeof onSuccess === 'function') onSuccess(result, value);
      })
      .catch((error) => {
        inFlight = false;
        queued = false;
        if (typeof onError === 'function') onError(error, value);
      });
  };

  return {
    push: (value) => {
      latest = value;
      if (inFlight) {
        queued = true;
        return;
      }
      flush();
    },
    isBusy: () => inFlight || queued
  };
};
