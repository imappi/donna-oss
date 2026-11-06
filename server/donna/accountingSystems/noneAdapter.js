import { AccountingSystemNotAvailableError, ACCOUNTING_ADAPTER_VERBS } from './contract.js';

// 'None' adapter — the client keeps books in the Donna ledger only, with
// no external accounting system to sync. A 'none' client that reaches a
// connector route is a configuration mismatch (before this layer, those
// routes silently attempted Xero), so every verb reports it cleanly rather
// than performing a wrong write.
const NONE_MESSAGE =
  'This client uses the Donna ledger only — there is no external accounting system to sync or write back to.';

const noExternalSystem = (operation) => {
  throw new AccountingSystemNotAvailableError('none', operation, NONE_MESSAGE);
};

export const noneAdapter = {
  id: 'none',
  ...Object.fromEntries(ACCOUNTING_ADAPTER_VERBS.map((verb) => [verb, () => noExternalSystem(verb)]))
};
