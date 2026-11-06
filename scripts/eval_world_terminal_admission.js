import {
  CHECK_REPORT_SCHEMA,
  OPERATOR_CONTRACT_INVARIANTS,
  validateOperatorContract,
} from '../server/donna/operatorContract.js';
import { runDeterministicPreflight } from '../server/donna/preflight.js';
import { grantRowAllowsAutoAccept } from '../server/donna/reconciliationAuthorityGrants.js';
import { assertJournalDateNotLocked } from '../server/donna/firmDb.js';
import { deriveConvergenceState } from '../server/donna/reconcileConvergenceState.js';

const REQUIRED_INVARIANTS = Object.freeze(['INV-1', 'INV-2', 'INV-3', 'INV-4', 'INV-5']);
const OPEN_ASK_STATUSES = new Set(['draft', 'open']);
const fail = (message) => { throw new Error(`terminal admission: ${message}`); };

const isRealOpenOwnerAsk = (ask, itemId) => Boolean(
  ask
  && typeof ask === 'object'
  && typeof ask.id === 'string'
  && ask.id.trim()
  && ask.owner_type === 'client'
  && OPEN_ASK_STATUSES.has(ask.status)
  && Array.isArray(ask.affected_item_ids)
  && ask.affected_item_ids.includes(itemId)
);

const assertProductionPeriodGuard = async ({ locked, journalDate }) => {
  let refused = false;
  try {
    await assertJournalDateNotLocked({
      client: { query: async () => ({ rows: locked ? [{ id: 'persisted-lock' }] : [] }) },
      firmId: 'snapshot-firm',
      clientId: 'snapshot-client',
      journalDate,
    });
  } catch (error) {
    if (error?.code !== 'LEDGER_ADJUSTMENT_DATE_LOCKED') throw error;
    refused = true;
  }
  return refused;
};

// Read-only EAW composition seam. It invokes the production checks and projections;
// it neither writes nor accepts a caller's T1/T2 label as evidence.
export const evaluateTerminalAdmission = async ({
  itemId,
  confidence,
  targetState = {},
  authorityGrant,
  authorityContext,
  period,
  ownerAsk = null,
  persisted = {},
} = {}) => {
  if (typeof itemId !== 'string' || !itemId.trim()) fail('itemId is required');
  if (!period || typeof period.locked !== 'boolean' || typeof period.journal_date !== 'string') {
    fail('authoritative period snapshot is required');
  }
  const invariantIds = OPERATOR_CONTRACT_INVARIANTS.map(({ id }) => id);
  if (JSON.stringify(invariantIds) !== JSON.stringify(REQUIRED_INVARIANTS)) fail('operator INV-1..5 contract drifted');

  const preflight = runDeterministicPreflight({
    card: { targets: [itemId], detail: { confidence } },
    targetStates: { [itemId]: targetState },
    period: { locked: period.locked, label: period.label },
  });
  const reportValidation = validateOperatorContract(CHECK_REPORT_SCHEMA, preflight);
  if (!reportValidation.ok) fail(`invalid production preflight report: ${reportValidation.errors.join('; ')}`);

  const locked = await assertProductionPeriodGuard({ locked: period.locked, journalDate: period.journal_date });
  const authorized = grantRowAllowsAutoAccept(authorityGrant, authorityContext);
  const realOwnerAsk = isRealOpenOwnerAsk(ownerAsk, itemId);
  const convergence = deriveConvergenceState({ ...persisted, hasOpenOwnerAsk: realOwnerAsk });
  const canAutoPost = preflight.status === 'pass' && authorized && !locked;

  if (canAutoPost) {
    if (convergence.state !== 'auto_reconciled') fail(`auto-post projection is ${convergence.state}`);
    return Object.freeze({
      admitted: true,
      verdict: 'auto_post',
      terminal_state: 'auto_reconciled',
      preflight,
      invariants_checked: REQUIRED_INVARIANTS,
      authority: 'authorized',
      period: 'open',
      convergence,
      production_proof: Object.freeze({ status: 'pending', dependency: 'Unit 40' }),
    });
  }

  if (!realOwnerAsk || convergence.state !== 'on_owner') {
    fail(`refusal cannot rest without a real open owner ask (projection=${convergence.state})`);
  }
  const verdict = locked ? 'locked_period_refusal' : !authorized ? 'authority_refusal' : 'owner_open';
  return Object.freeze({
    admitted: true,
    verdict,
    terminal_state: 'on_owner',
    preflight,
    invariants_checked: REQUIRED_INVARIANTS,
    authority: authorized ? 'authorized' : 'refused',
    period: locked ? 'locked' : 'open',
    convergence,
    owner_ask_id: ownerAsk.id,
    production_proof: Object.freeze({ status: 'pending', dependency: 'Unit 40' }),
  });
};
