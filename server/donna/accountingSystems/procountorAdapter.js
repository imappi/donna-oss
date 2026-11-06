import { AccountingSystemNotAvailableError, ACCOUNTING_ADAPTER_VERBS } from './contract.js';
import {
  startProcountorConnectionInDb, syncProcountorReferenceDataInDb,
  writebackProcountorTransactionInDb, writebackProcountorTransactionsBatchInDb,
  retryProcountorMirrorInDb, verifyProcountorMirrorInDb
} from '../firmDb.js';

// Procountor adapter — CAPABILITY TRIAL (clientAxes.available=false). The live
// verbs graduated one at a time, mirroring QBO (2.1a→c): startConnection (the
// M2M api-key connect hand-off, 2.1a), syncReferenceData (2.1b — coa/dimensions/
// business partners/bank accounts, shapes validated against the live PTS API,
// db/migrations/061), and now the WRITEBACK surface (2.1c — writebackTransaction/
// writebackBatch/retryMirror/verifyMirror): a posted Donna ledger journal → a
// Procountor ledger receipt (type JOURNAL), field mapping + the debit=+/credit=−
// sign convention validated against the live API (docs/procountor-live-writeback-
// runbook.md §0e). A created receipt lands UNFINISHED (a draft the firm verifies
// in Procountor — the API exposes no journal-verify endpoint), which IS Donna's
// terminal state. The lone remaining scaffold is provisionChartOfAccounts.
const PROCOUNTOR_MESSAGE =
  'Procountor is a capability-trial connector: connect, reference sync, and ledger writeback are wired; this verb lands after live validation (see docs/procountor-live-writeback-runbook.md).';

const notAvailable = (operation) => {
  throw new AccountingSystemNotAvailableError('procountor', operation, PROCOUNTOR_MESSAGE);
};

// Only genuinely-live verbs belong in LIVE; SCAFFOLDED_VERBS derives the rest
// from the canonical list so the surface can never silently drift from the
// interface every adapter implements.
const LIVE = {
  startConnection: (args) => startProcountorConnectionInDb(args),
  syncReferenceData: (args) => syncProcountorReferenceDataInDb(args),
  writebackTransaction: (args) => writebackProcountorTransactionInDb(args),
  writebackBatch: (args) => writebackProcountorTransactionsBatchInDb(args),
  retryMirror: (args) => retryProcountorMirrorInDb(args),
  verifyMirror: (args) => verifyProcountorMirrorInDb(args)
};
const SCAFFOLDED_VERBS = ACCOUNTING_ADAPTER_VERBS.filter((verb) => !(verb in LIVE));

export const procountorAdapter = {
  id: 'procountor',
  ...LIVE,
  ...Object.fromEntries(SCAFFOLDED_VERBS.map((verb) => [verb, () => notAvailable(verb)]))
};
