-- Donna CoA architecture — slice 2: ledger_accounts.canonical_role.
-- See docs/donna-coa-architecture.md (sequencing §2) and
-- server/donna/accountRoles.js (the role vocabulary, slice 1).
--
-- The canonical role is the STABLE semantic identity under a chart of accounts.
-- Until now coding / reporting / reconciliation / connector mapping all keyed off
-- the account NAME string ("Software" / "IT & software" / "SaaS" fragment); a
-- Finnish name, a Xero code, and the local name are three strings for one role.
-- This column gives every ledger account ONE machine-facing identity that
-- survives renames, languages, and jurisdictions. Names become VIEWS onto it.
--
-- Additive + nullable by design — three deliberate non-choices:
--
--   * NULLABLE, no default. A NULL role means "not yet resolved": an unknown
--     (model-proposed) business account whose role the STRONG MODEL assigns in a
--     later slice. NOT NULL — or a default — would force a guess at write time,
--     exactly the intelligence-substituting scaffolding the architecture retires.
--
--   * NO CHECK enumerating the role set. The vocabulary lives in accountRoles.js
--     (the keep-layer: coarse, ~30, human-owned). A DB CHECK would be a SECOND
--     source of truth that drifts the moment a role is added. Validity is enforced
--     in JS (isAccountRole / __canonicalRoleForAccount), not pinned in the schema.
--
--   * NO backfill here. The name -> role map is the explicit SEED_NAME_ROLES table
--     in accountRoles.js; mirroring it in SQL would duplicate it (the same drift
--     trap one level down). Existing rows are backfilled by
--     scripts/backfill_canonical_roles.js, which reads roleForSeedName directly.

alter table ledger_accounts add column if not exists canonical_role text;

-- Role lookup is by (firm, client, role); partial because rows without a resolved
-- role are never queried by role (an equality predicate on canonical_role already
-- implies NOT NULL, so the partial index stays usable for those lookups).
create index if not exists ledger_accounts_firm_client_role_idx
  on ledger_accounts (firm_id, client_id, canonical_role)
  where canonical_role is not null;
