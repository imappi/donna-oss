// Country-owned statutory sweep registration. Lazy load avoids the firmDb cycle;
// invocation reaches the existing named handler and shared transaction substrate.
export const STATUTORY_OBLIGATION_BINDINGS = Object.freeze({
  ae_vat_threshold_escalation: Object.freeze({
    run: async (options = {}) => {
      const { withFirmDbClient } = await import('../db/pool.js');
      const { drainAeVatThresholdEscalations } = await import('./statutoryDb.js');
      return withFirmDbClient((client) => drainAeVatThresholdEscalations({ ...options, client }));
    }
  }),
  ae_vat_return_deadline_escalation: Object.freeze({
    run: async (options = {}) => {
      const { withFirmDbClient } = await import('../db/pool.js');
      const { drainAeVatReturnDeadlineEscalations } = await import('./statutoryDb.js');
      return withFirmDbClient((client) => drainAeVatReturnDeadlineEscalations({ ...options, client }));
    }
  }),
  ae_ct_registration_escalation: Object.freeze({
    run: async (options = {}) => {
      const { withFirmDbClient } = await import('../db/pool.js');
      const { drainAeCtRegistrationEscalations } = await import('./statutoryDb.js');
      return withFirmDbClient((client) => drainAeCtRegistrationEscalations({ ...options, client }));
    }
  }),
  ae_vat_registration_escalation: Object.freeze({
    run: async (options = {}) => {
      const { withFirmDbClient } = await import('../db/pool.js');
      const { drainAeVatRegistrationEscalations } = await import('./statutoryDb.js');
      return withFirmDbClient((client) => drainAeVatRegistrationEscalations({ ...options, client }));
    },
    // Onboarding duty: retain the existing hourly as well as daily cadence.
    hourly: true
  }),
});
