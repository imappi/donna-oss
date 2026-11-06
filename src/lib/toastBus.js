// Minimal pub/sub for firm-wide toast notifications.
//
// Why a bus and not React context: the consumers (transaction-chat
// polling tick, evidence apply callbacks, batch sync results) live in
// deeply nested components. Threading a `setToast` ref through every
// prop chain is noise; a global bus is the lightest fit for a
// fire-and-forget surface.
//
// The bus is pure JS — testable without React. ToastHost
// (src/components/shared/toast-host.jsx) subscribes in a useEffect
// and renders queued toasts.

const listeners = new Set();

// Emit a toast. Callers pass a string message OR a structured object:
//   emitToast('Client replied');
//   emitToast({ message: 'Client replied', tone: 'intel', durationMs: 5000 });
//
// `tone` is a label the host maps to a colour — defaults to 'info'.
// `durationMs` defaults to 5000 in the host.
export const emitToast = (toast) => {
  if (toast == null) return;
  const payload = typeof toast === 'string' ? { message: toast } : toast;
  if (!payload || typeof payload.message !== 'string' || !payload.message.trim()) return;
  const normalized = {
    id: payload.id || `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    message: payload.message,
    tone: payload.tone || 'info',
    durationMs: typeof payload.durationMs === 'number' ? payload.durationMs : null,
    href: typeof payload.href === 'string' ? payload.href : null,
    onClick: typeof payload.onClick === 'function' ? payload.onClick : null
  };
  for (const listener of listeners) {
    try {
      listener(normalized);
    } catch (err) {
      // A misbehaving subscriber must not break sibling subscribers.
      // The error surfaces in the console; the bus stays healthy.
      console.error('[toastBus] subscriber threw', err);
    }
  }
};

// Subscribe to all future toasts. Returns an unsubscribe function.
// Idempotent — calling the unsubscriber twice is safe.
export const subscribeToToasts = (listener) => {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

// Test-only: clear all listeners. Production code never needs this;
// hot-reload or a stray subscriber can be torn down by its own
// unsubscribe. Exported so the toastBus test can run hermetically.
export const __resetToastBusForTests = () => {
  listeners.clear();
};
