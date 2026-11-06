import {
  CONVERGENCE_STATES,
  deriveConvergenceState,
  summarizeConvergence,
} from '../server/donna/reconcileConvergenceState.js';
import {
  entityOwnerCounts,
  projectEntityOwnerInventory,
} from '../src/components/shared/entity-owner-inventory.js';

const OWNER_TO_TERMINAL = Object.freeze({
  done: 'auto_reconciled',
  waiting: 'on_owner',
  for_you: 'on_owner',
  donna: 'hanging',
});

const fail = (message) => { throw new Error(`projection parity: ${message}`); };

const inventory = (entries, surface) => {
  const out = new Map();
  for (const entry of entries) {
    const id = entry?.canonical_identity;
    if (typeof id !== 'string' || !id.trim()) fail(`${surface} row lacks canonical identity`);
    if (!CONVERGENCE_STATES.includes(entry.terminal_state)) fail(`${surface} ${id} has invalid terminal state`);
    if (out.has(id)) fail(`${surface} duplicates ${id}`);
    out.set(id, entry.terminal_state);
  }
  return out;
};

// The DB surface is an injected read shape, never a caller-supplied T1/T2 label.
// Its two persisted predicates must be exclusive; neither means firm-side limbo.
const dbInventory = (rows = []) => inventory(rows.map((row) => {
  if (typeof row?.is_auto_reconciled !== 'boolean' || typeof row?.is_on_owner !== 'boolean') {
    fail('DB predicates must be booleans');
  }
  if (row.is_auto_reconciled && row.is_on_owner) fail(`${row.canonical_identity} is in both DB terminals`);
  return {
    canonical_identity: row.canonical_identity,
    terminal_state: row.is_auto_reconciled ? 'auto_reconciled' : row.is_on_owner ? 'on_owner' : 'hanging',
  };
}), 'DB');

const convergenceInventory = (rows = []) => {
  const projected = rows.map(({ canonical_identity, persisted = {} }) => ({
    canonical_identity,
    ...deriveConvergenceState(persisted),
  }));
  // Exercise the real aggregate as well as the real row projection.
  const summary = summarizeConvergence(projected);
  return { values: inventory(projected.map((row) => ({
    canonical_identity: row.canonical_identity,
    terminal_state: row.state,
  })), 'convergence'), summary };
};

const ownerInventory = (feed, clientId) => {
  const projected = projectEntityOwnerInventory(feed, clientId);
  const counts = entityOwnerCounts(feed, clientId);
  const mapped = projected.map((row) => ({
    canonical_identity: row.canonical_identity,
    terminal_state: OWNER_TO_TERMINAL[row.owner_state],
  }));
  return { values: inventory(mapped, 'owner'), counts };
};

const compare = (leftName, left, rightName, right) => {
  const ids = [...new Set([...left.keys(), ...right.keys()])].sort();
  for (const id of ids) {
    if (!left.has(id) || !right.has(id)) fail(`${id} is missing from ${left.has(id) ? rightName : leftName}`);
    if (left.get(id) !== right.get(id)) {
      fail(`${id} disagrees: ${leftName}=${left.get(id)}, ${rightName}=${right.get(id)}`);
    }
  }
};

export const validateProjectionParity = ({ dbRows = [], convergenceRows = [], ownerFeed, clientId = null } = {}) => {
  const db = dbInventory(dbRows);
  const convergence = convergenceInventory(convergenceRows);
  const owner = ownerInventory(ownerFeed, clientId);
  compare('DB', db, 'convergence', convergence.values);
  compare('DB', db, 'owner', owner.values);
  if (convergence.summary.hanging > 0) fail(`hanging inventory is a terminal-state violation (${convergence.summary.hanging})`);
  return Object.freeze({
    ok: true,
    total: db.size,
    terminal_inventory: Object.freeze([...db].sort(([a], [b]) => a.localeCompare(b)).map(([canonical_identity, terminal_state]) => Object.freeze({ canonical_identity, terminal_state }))),
    convergence: Object.freeze(convergence.summary),
    owner_counts: Object.freeze(owner.counts),
    projection_receipt: Object.freeze({
      status: 'contract_proven',
      projector: 'reconcileConvergenceState',
      compared_surfaces: Object.freeze(['DB', 'convergence', 'owner']),
      historical_db_close_authority: 'legacy_unproven',
    }),
  });
};
