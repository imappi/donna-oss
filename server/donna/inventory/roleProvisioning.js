// Donna Inventory I4·posting — P2 capability-enablement role→account provisioning.
//
// PURE planning layer (no DB, no I/O, no Date.now/Math.random/new Date). Design §8:
// account resolution happens at CAPABILITY ENABLEMENT, before the INVENTORY_ACCOUNTING
// flag turns on — NEVER minted mid-post. The flow is:
//
//   resolve roles against the client's live chart → propose missing accounts →
//   accountant/operator approves/maps → validate external mappings (§17) → enable
//
// This module owns the deterministic RESOLVE / PROPOSE / VALIDATE decision surface.
// Persisting the approved mappings + their provenance is P3 (migration 078); rendering
// the proposal as an operator ProposalCard and flipping the flag is P5. At post time an
// unresolved role is a hard `unmapped_account` refusal (the builder's job, §9), not a
// mint — this module is what makes sure that never happens for an enabled client.
//
// Two brutal invariants from §8, enforced here, not by arithmetic:
//   - EXACTLY ONE active account per canonical role per client. A duplicate role
//     mapping REFUSES (`duplicate_role_mapping`) — never silently picks one.
//   - Every mapping carries provenance (who mapped/approved, when, evidence, version).
//     An incomplete provenance REFUSES (`missing_mapping_provenance`).
//
// Every non-ready outcome names a waiter (design §12) so nothing rests without an owner
// (the FIRST principle applied to the enablement funnel).

import { isAccountRole, normalBalanceForRole } from '../accountRoles.js';

export const INVENTORY_ENABLEMENT_CONTRACT_VERSION = 'inventory-enablement/1';

// The canonical roles inventory posting REQUIRES resolved before it may act for a
// client (design §5 event map + §8). Private-use roles are NOT here — see below.
export const INVENTORY_CORE_ROLES = Object.freeze([
  'asset.inventory',
  'liability.grni',
  'liability.accounts_payable',
  'expense.cost_of_sales',
  'expense.cost_of_sales_adjustment',
  'expense.purchase_price_variance',
  'expense.inventory_write_down',
  'contra_asset.inventory_valuation_allowance',
  'pnl.inventory_count_variance'
]);

// Owner private-use roles (design §5-E). I6-GATED: v1 DETECTS AND ESCALATES private use
// and posts NOTHING until a jurisdiction pack certifies the treatment, so these are NOT
// required to enable the core capability. They are validated for uniqueness/provenance
// only when a client has already mapped them (ahead of an I6 pack).
export const INVENTORY_PRIVATE_USE_ROLES = Object.freeze([
  'equity.owner_drawings',
  'asset.receivable_from_owner'
]);

// The account a missing role proposes. account_type is the STATEMENT-facing type the
// provisioned ledger_accounts row carries (design §8 — no mint-on-post, so the type is
// explicit here, never a class fallback). Note the two off-diagonal types: the contra
// allowance provisions as `asset` (an asset-section line at a credit normal balance,
// reducing net inventory) and the P&L count variance provisions as `expense`. `name`
// matches accountRoles SEED_NAME_ROLES so a provisioned account resolves back by name.
const ROLE_ACCOUNT_TEMPLATE = Object.freeze({
  'asset.inventory': { name: 'Inventory', account_type: 'asset' },
  'liability.grni': { name: 'Goods received not invoiced', account_type: 'liability' },
  'liability.accounts_payable': { name: 'Accounts payable', account_type: 'liability' },
  'expense.cost_of_sales': { name: 'Cost of sales', account_type: 'expense' },
  'expense.cost_of_sales_adjustment': { name: 'Cost of sales adjustment', account_type: 'expense' },
  'expense.purchase_price_variance': { name: 'Purchase price variance', account_type: 'expense' },
  'expense.inventory_write_down': { name: 'Inventory write-down', account_type: 'expense' },
  'contra_asset.inventory_valuation_allowance': { name: 'Inventory valuation allowance', account_type: 'asset' },
  'pnl.inventory_count_variance': { name: 'Inventory count variance', account_type: 'expense' },
  'equity.owner_drawings': { name: 'Owner drawings', account_type: 'equity' },
  'asset.receivable_from_owner': { name: 'Receivable from owner', account_type: 'asset' }
});

// The provenance a mapping MUST carry (design §8 "Account-mapping provenance"). Every
// posting receipt (§15) later references the mapping_provenance_id it resolved through,
// so an incomplete provenance is refused at enablement, never post time.
export const MAPPING_PROVENANCE_FIELDS = Object.freeze([
  'mapping_provenance_id',
  'mapped_by',
  'approved_by',
  'mapped_at',
  'evidence',
  'mapping_version'
]);

export const INVENTORY_ENABLEMENT_REFUSALS = Object.freeze([
  'duplicate_role_mapping',
  'missing_mapping_provenance'
]);

// Ownership modes (design §17). Set at enablement, never inferred.
export const INVENTORY_OWNERSHIP_MODES = Object.freeze(['donna_local', 'external_owns_inventory']);

// Accounting systems that maintain an external chart Donna mirrors into. 'none'
// (or null) is a local-ledger-only client — the first-canary shape (§17).
const CONNECTED_EXTERNAL_SYSTEMS = new Set(['xero', 'qbo', 'procountor']);

// The account a role proposes when it is missing from the client's chart. Pure.
export const inventoryRoleAccountTemplate = (role) => {
  const tpl = ROLE_ACCOUNT_TEMPLATE[String(role || '')];
  if (!tpl) return null;
  return { role, name: tpl.name, account_type: tpl.account_type, normal_balance: normalBalanceForRole(role) };
};

const isActiveMapping = (m) => m && m.active !== false;

// Which provenance fields a mapping is missing (empty ⇒ complete). A field counts as
// present only when it is a non-empty value.
const provenanceGaps = (mapping = {}) => {
  const p = mapping.provenance || {};
  return MAPPING_PROVENANCE_FIELDS.filter((field) => {
    const value = p[field];
    return value === undefined || value === null || value === '';
  });
};

// resolveInventoryRoleMappings — group the client's mappings by role and classify each
// required role as resolved / missing / duplicate / provenance-gap. Pure; deterministic
// ordering (requiredRoles order, then refusal kind). Only inventory roles are considered;
// mappings to unrelated roles are ignored.
export const resolveInventoryRoleMappings = ({
  existingMappings = [],
  includePrivateUseRoles = false
} = {}) => {
  const requiredRoles = [...INVENTORY_CORE_ROLES];
  const consideredRoles = includePrivateUseRoles
    ? [...INVENTORY_CORE_ROLES, ...INVENTORY_PRIVATE_USE_ROLES]
    : requiredRoles;
  const consideredSet = new Set(consideredRoles);

  // Bucket active mappings by role (only roles we care about).
  const byRole = new Map();
  for (const mapping of Array.isArray(existingMappings) ? existingMappings : []) {
    const role = String(mapping?.role || '');
    if (!consideredSet.has(role)) continue;
    if (!isActiveMapping(mapping)) continue;
    if (!byRole.has(role)) byRole.set(role, []);
    byRole.get(role).push(mapping);
  }

  const resolved = [];
  const missing = [];
  const refusals = [];

  for (const role of consideredRoles) {
    const mappings = byRole.get(role) || [];
    if (mappings.length === 0) {
      missing.push(role);
      continue;
    }
    if (mappings.length > 1) {
      // Ambiguous: more than one active account claims this role. Refuse — never guess.
      refusals.push({
        reason: 'duplicate_role_mapping',
        role,
        detail: { account_codes: mappings.map((m) => m.account_code ?? m.account_id ?? null) }
      });
      continue;
    }
    const mapping = mappings[0];
    const gaps = provenanceGaps(mapping);
    if (gaps.length > 0) {
      refusals.push({ reason: 'missing_mapping_provenance', role, detail: { missing_fields: gaps } });
      continue;
    }
    resolved.push({
      role,
      account_code: mapping.account_code ?? null,
      account_id: mapping.account_id ?? null,
      mapping_provenance_id: mapping.provenance.mapping_provenance_id,
      mapping_version: mapping.provenance.mapping_version,
      external_account_mapping_id: mapping.external_account_mapping_id ?? null
    });
  }

  return { requiredRoles, consideredRoles, resolved, missing, refusals };
};

// The external-export precondition (design §17 / §8 step 4). STRUCTURAL only in P2 — full
// adapter-capability, tax-code, dimension, and duplicate-external-subledger preflight is
// P7. Here: a connected external system with Donna as book of record (donna_local) must
// carry an external_account_mapping_id on every resolved role before export is ready;
// external_owns_inventory suppresses the inventory/COGS export entirely (no double-post);
// a local-only client needs nothing.
const evaluateExternalExport = ({ ownershipMode, accountingSystem, resolved }) => {
  const system = String(accountingSystem || 'none').trim().toLowerCase() || 'none';
  const connected = CONNECTED_EXTERNAL_SYSTEMS.has(system);

  if (ownershipMode === 'external_owns_inventory') {
    // The external system owns its own inventory/COGS subledger — Donna must NOT export
    // inventory/COGS journals into it (that double-posts). Suppressed, so nothing gates.
    return { ownershipMode, accountingSystem: system, connected, required: false, suppressed: true, gaps: [], ready: true };
  }
  if (!connected) {
    // Local-ledger-only client (accounting_system 'none'/donna_local) — first-canary shape.
    return { ownershipMode, accountingSystem: system, connected: false, required: false, suppressed: false, gaps: [], ready: true };
  }
  // Donna is book of record but mirrors out to a connected system: every resolved role
  // needs a validated external account mapping (§17). Missing ones are export gaps.
  const gaps = resolved.filter((r) => !r.external_account_mapping_id).map((r) => r.role);
  return { ownershipMode, accountingSystem: system, connected: true, required: true, suppressed: false, gaps, ready: gaps.length === 0 };
};

// The waiter that owns a non-ready plan (design §12). Config regressions (duplicate /
// unmapped / missing-provenance roles) rest on the accountant/operator queue; an external
// export gap rests on the integration/operator queue. A ready plan has no waiter.
const waiterForStatus = (status) => {
  switch (status) {
    case 'refused':
    case 'needs_mapping':
      return { waiter_type: 'accountant_operator', next_action: 'map_or_approve_inventory_accounts' };
    case 'needs_external_mapping':
      return { waiter_type: 'integration_operator', next_action: 'map_external_inventory_accounts' };
    default:
      return null;
  }
};

// buildInventoryEnablementPlan — the P2 decision surface. Given the client's current
// role→account mappings, ownership mode, and accounting system, produce the resolve /
// propose / validate plan and a single enablement status with its waiter. PURE.
//
// status:
//   'refused'               — a config regression (duplicate role / incomplete provenance).
//   'needs_mapping'         — required roles unmapped; propose the accounts, get approval.
//   'needs_external_mapping'— all local roles resolved but a connected client is missing
//                             external account mappings (export precondition, §17).
//   'ready'                 — every required role resolved (+ external ok / local-only /
//                             suppressed). The client may have INVENTORY_ACCOUNTING enabled.
export const buildInventoryEnablementPlan = ({
  existingMappings = [],
  ownershipMode = 'donna_local',
  accountingSystem = 'none',
  includePrivateUseRoles = false
} = {}) => {
  const mode = INVENTORY_OWNERSHIP_MODES.includes(ownershipMode) ? ownershipMode : 'donna_local';
  const { requiredRoles, resolved, missing, refusals } = resolveInventoryRoleMappings({
    existingMappings,
    includePrivateUseRoles
  });

  const proposedAccounts = missing.map((role) => inventoryRoleAccountTemplate(role)).filter(Boolean);
  const externalExport = evaluateExternalExport({ ownershipMode: mode, accountingSystem, resolved });

  // Local enablement is ready iff every required role is uniquely, provenance-fully mapped.
  const localEnablementReady = refusals.length === 0 && missing.length === 0;

  let status;
  if (refusals.length > 0) status = 'refused';
  else if (missing.length > 0) status = 'needs_mapping';
  else if (externalExport.required && !externalExport.ready) status = 'needs_external_mapping';
  else status = 'ready';

  return {
    contract_version: INVENTORY_ENABLEMENT_CONTRACT_VERSION,
    flag_key: 'INVENTORY_ACCOUNTING',
    ownership_mode: mode,
    required_roles: requiredRoles,
    include_private_use_roles: Boolean(includePrivateUseRoles),
    resolved,
    missing,
    proposed_accounts: proposedAccounts,
    refusals,
    external_export: externalExport,
    local_enablement_ready: localEnablementReady,
    status,
    waiter: waiterForStatus(status),
    can_enable: status === 'ready'
  };
};

// Guard exported for tests / callers: is this string a role inventory posting knows?
export const isInventoryRole = (role) =>
  isAccountRole(role) && Object.prototype.hasOwnProperty.call(ROLE_ACCOUNT_TEMPLATE, String(role || ''));
