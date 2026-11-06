import { AccountingSystemNotAvailableError, ACCOUNTING_ADAPTER_VERBS } from './contract.js';
import {
  startQboConnectionInDb,
  syncQboReferenceDataInDb,
  writebackQboTransactionInDb,
  writebackQboTransactionsBatchInDb,
  retryQboMirrorInDb,
  verifyQboMirrorInDb
} from '../firmDb.js';

// QBO adapter — six of seven verbs live as of Phase 2.1c. Connect (2.1a) and
// reference sync (2.1b) shipped earlier; this phase wires the writeback surface
// that mirrors posted Donna ledger journals to QBO JournalEntry, plus retry +
// verify. Only provisionChartOfAccounts stays scaffolded — account mapping is
// resolve-at-writeback (no CoA push into QBO), so there is nothing to provision.
// Every live path emits the neutral `accounting_system.*` audit stream with
// `accounting_system: 'qbo'` in metadata, same as Xero.
const QBO_MESSAGE =
  "QuickBooks Online chart-of-accounts provisioning isn't wired — account mapping is resolve-at-writeback against the synced accounts.";

const notAvailable = (operation) => {
  throw new AccountingSystemNotAvailableError('qbo', operation, QBO_MESSAGE);
};

// The live verbs delegate to their firmDb writers; the remainder are scaffolded.
// SCAFFOLDED_VERBS is derived from the canonical verb list minus the live set so
// the surface can never silently drift from the interface every adapter implements.
const LIVE = {
  startConnection: (args) => startQboConnectionInDb(args),
  syncReferenceData: (args) => syncQboReferenceDataInDb(args),
  writebackTransaction: (args) => writebackQboTransactionInDb(args),
  writebackBatch: (args) => writebackQboTransactionsBatchInDb(args),
  retryMirror: (args) => retryQboMirrorInDb(args),
  verifyMirror: (args) => verifyQboMirrorInDb(args)
};
const SCAFFOLDED_VERBS = ACCOUNTING_ADAPTER_VERBS.filter((verb) => !(verb in LIVE));

export const qboAdapter = {
  id: 'qbo',
  ...LIVE,
  ...Object.fromEntries(SCAFFOLDED_VERBS.map((verb) => [verb, () => notAvailable(verb)]))
};
