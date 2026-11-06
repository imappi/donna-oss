import {
  startXeroConnectionInDb,
  syncXeroReferenceDataInDb,
  provisionXeroChartOfAccountsInDb,
  writebackXeroTransactionInDb,
  writebackXeroTransactionsBatchInDb,
  retryXeroMirrorInDb,
  verifyXeroMirrorInDb
} from '../firmDb.js';

// Xero adapter — thin, 1:1 delegation to the existing *XeroInDb writers.
// The underlying functions emit the neutral `accounting_system.*` audit
// actions (with `accounting_system: 'xero'` in metadata) and return their
// existing payload shape. The adapter exists so the route layer can
// dispatch by accounting_system and a QBO adapter can slot behind the
// same verbs and the same audit stream.
//
// Each method forwards its args object straight through, so a route's call
// site is identical to calling the function directly.
export const xeroAdapter = {
  id: 'xero',
  startConnection: (args) => startXeroConnectionInDb(args),
  syncReferenceData: (args) => syncXeroReferenceDataInDb(args),
  provisionChartOfAccounts: (args) => provisionXeroChartOfAccountsInDb(args),
  writebackTransaction: (args) => writebackXeroTransactionInDb(args),
  writebackBatch: (args) => writebackXeroTransactionsBatchInDb(args),
  retryMirror: (args) => retryXeroMirrorInDb(args),
  verifyMirror: (args) => verifyXeroMirrorInDb(args)
};
