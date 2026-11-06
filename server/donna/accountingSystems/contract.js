// Shared contract for the accountingSystems adapter layer: the error the
// scaffolded adapters throw, the neutral audit-action constants that are
// the forward convention for events emitted through this layer, and the
// canonical verb set every adapter implements.
//
// Kept dependency-free so both the registry (index.js) and the individual
// adapters can import it without an import cycle.

// Thrown when a route dispatches an operation to an accounting system that
// can't service it — QBO is a scaffold (coming soon) and 'none' means the
// client keeps books in the Donna ledger only. The api.js top-level
// handler surfaces statusCode / code / details verbatim, so the FE gets a
// clean, typed response instead of an operation silently hitting Xero.
export class AccountingSystemNotAvailableError extends Error {
  constructor(systemId, operation, message) {
    super(message || `The "${systemId}" accounting system can't "${operation}" yet.`);
    this.name = 'AccountingSystemNotAvailableError';
    // 409 Conflict: the client's configured accounting_system conflicts
    // with the requested operation's capability.
    this.statusCode = 409;
    this.code = 'ACCOUNTING_SYSTEM_NOT_AVAILABLE';
    this.details = { accounting_system: systemId, operation };
  }
}

// Neutral audit-action shape — every event emitted through this layer
// (Xero today, QBO next) uses these action strings and carries
// `accounting_system` in metadata so downstream consumers can split by
// connector. Historical `xero.*` rows pre-dating this neutralization are
// never migrated; they coexist with the neutral stream.
export const ACCOUNTING_AUDIT_ACTIONS = {
  connect: 'accounting_system.connect',
  disconnect: 'accounting_system.disconnect',
  syncReferenceData: 'accounting_system.sync_reference_data',
  provisionChartOfAccounts: 'accounting_system.provision_coa',
  writebackTransaction: 'accounting_system.writeback_transaction',
  writebackBatch: 'accounting_system.writeback_batch',
  retryMirror: 'accounting_system.mirror_retry',
  verifyMirror: 'accounting_system.mirror_verify'
};

// Every adapter implements exactly these verbs; PR 1 wires the route layer
// to dispatch them. Connection-lifecycle verbs (completeConnection,
// refreshConnection, disconnect, getConnectionStatus) are reserved for the
// follow-up PRs that build the real QBO OAuth path.
export const ACCOUNTING_ADAPTER_VERBS = [
  'startConnection',
  'syncReferenceData',
  'provisionChartOfAccounts',
  'writebackTransaction',
  'writebackBatch',
  'retryMirror',
  'verifyMirror'
];
