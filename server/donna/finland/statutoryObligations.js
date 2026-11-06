// Country-owned statutory sweep registration. Lazy load avoids the firmDb cycle;
// invocation reaches the existing named handler and shared transaction substrate.
export const STATUTORY_OBLIGATION_BINDINGS = Object.freeze({
  fi_alv_threshold_escalation: Object.freeze({
    run: async (options = {}) => {
      const { withFirmDbClient } = await import('../db/pool.js');
      const { drainFinlandAlvThresholdEscalations } = await import('./statutoryDb.js');
      return withFirmDbClient((client) => drainFinlandAlvThresholdEscalations({ ...options, client }));
    }
  }),
  fi_scope_drift_ask_delivery: Object.freeze({
    run: async (options = {}) => {
      const { withFirmDbClient } = await import('../db/pool.js');
      const { deliverPendingFinlandScopeDriftAsks } = await import('./statutoryDb.js');
      return withFirmDbClient((client) => deliverPendingFinlandScopeDriftAsks({ ...options, client }));
    }
  }),
});
