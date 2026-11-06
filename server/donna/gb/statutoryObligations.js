// Country-owned statutory sweep registration. Lazy load avoids the firmDb cycle;
// invocation reaches the existing named handler and shared transaction substrate.
export const STATUTORY_OBLIGATION_BINDINGS = Object.freeze({
  gb_vat_threshold_escalation: Object.freeze({
    run: async (options = {}) => {
      const { withFirmDbClient } = await import('../db/pool.js');
      const { drainGbVatThresholdEscalations } = await import('./statutoryDb.js');
      return withFirmDbClient((client) => drainGbVatThresholdEscalations({ ...options, client }));
    }
  }),
});
