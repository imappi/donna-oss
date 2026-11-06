-- 079 — FI-13 slice 13.0A-2b: the Oy authority role model (D-FI13-11 v2). ADDITIVE.
--
-- "Authority is a role model; the pilot is one person holding all roles
-- EXPLICITLY." An authority is never inferred from a checkbox: each distinct
-- authority a person holds over the company is its own stored row —
-- {authority_basis, verified_at, verified_from, valid_from/until, scope} — so
-- "who may sign the FS", "who may file 6B", "who approves the bookkeeping" are
-- FACTS the runtime can read, not assumptions baked into a boolean. The pilot's
-- single bound person holds all roles; multi-principal flows are a named
-- follow-up, but the MODEL already distinguishes the roles.
--
-- Built on the existing scoped/auditable GRANT pattern (migrations 040 / 054 —
-- do NOT invent a third grant substrate): deterministic id, closed CHECK
-- vocabularies pinned to authority.js by migrations.test.js, status governance
-- (active/revoked), effective-dated validity window (the 078 shareholding
-- convention: a holding active on D satisfies valid_from <= D and
-- (valid_until is null or D < valid_until)).
--
-- The BASIS vocabulary is the point (D-FI13-11): a checkbox
-- ('owner_attestation') is NOT an authority basis for tax filing or published
-- statements, and prokura alone is insufficient for FS signing / PRH filing
-- (FS are signed by the board + CEO; PRH filings by a board member / CEO /
-- authorized person — provenance-pending). That sufficiency policy lives in
-- authority.js (authorityBasisSufficient), deterministic and testable; the
-- schema stores the basis honestly so the gap is VISIBLE, it does not refuse
-- the row (an insufficient basis is an onboarding gap to surface, resting on
-- the owner to evidence — two-terminal-states — not a write error).
--
-- AML / PII posture (mirror 078, counsel-gated §8): holder_ref is a REFERENCE
-- (a pointer to a verified document / an external token), NEVER a raw hetu /
-- Y-tunnus. shareholder_id links the holder to the ownership model when they
-- are also a shareholder (the pilot's owner-manager) — SET NULL on delete:
-- authority is a fact about the person and the company, not about the
-- shareholding row.
--
-- Everything dies with its client via the client_id FK cascade
-- (firm-memory-dies-with-its-client; the 040 / 063 / 076 / 078 convention).
-- RLS-native.

create table if not exists finland_authority_roles (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  holder_display_name text not null,
  -- A REFERENCE to a verified identity (document pointer / external token) —
  -- NEVER a raw hetu / Y-tunnus (AML/PII posture, see header).
  holder_ref text,
  -- Optional link into the D-FI13-14 ownership model when the holder is also a
  -- shareholder (the pilot's owner-manager). SET NULL, not cascade: the
  -- authority row outlives a shareholder-row correction.
  shareholder_id text references finland_shareholders(id) on delete set null,
  -- The distinct authorities of D-FI13-11 v2 — pinned to authority.js
  -- FINLAND_AUTHORITY_ROLES.
  role text not null check (role in (
    'workspace_access', 'bookkeeping_approval', 'tax_filing', 'board_membership',
    'fs_signatory', 'shareholder_decision', 'company_representation', 'prh_filing'
  )),
  -- WHY the holder has this authority — pinned to authority.js
  -- FINLAND_AUTHORITY_BASES. 'owner_attestation' is the checkbox-grade basis;
  -- authorityBasisSufficient() says where it is and is not enough.
  authority_basis text not null check (authority_basis in (
    'trade_register', 'articles_of_association', 'board_resolution',
    'shareholder_resolution', 'suomifi_mandate', 'prokura',
    'engagement_letter', 'owner_attestation'
  )),
  -- When and from WHAT the basis was verified (a register extract date, a
  -- mandate check, a document pointer). Null = recorded but not yet verified.
  verified_at timestamptz,
  verified_from text,
  -- Narrowing scope for the authority (e.g. tax filing limited to ALV), the
  -- D-FI13-11 shape. '{}' = the role's full pilot scope.
  scope jsonb not null default '{}'::jsonb,
  valid_from date not null,
  valid_until date,
  -- Governance mirror of the 040 grant statuses, reduced to what an authority
  -- needs: revoked is a recorded human "no", never a silent delete.
  status text not null default 'active' check (status in ('active', 'revoked')),
  revoked_reason text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The as-of lookup: a client's authority rows by role and validity window.
create index if not exists finland_authority_roles_lookup_idx
  on finland_authority_roles(firm_id, client_id, role, status);
create index if not exists finland_authority_roles_asof_idx
  on finland_authority_roles(firm_id, client_id, valid_from, valid_until);

-- ── RLS-native (mirror 040 / 063 / 076 / 078) ───────────────────────────────
-- Governance data: the server connects as the RLS-exempt owner role; the
-- browser never queries this table. ENABLE (not FORCE) so the owner stays
-- exempt; revoke the Supabase browser roles. Guarded so a dev DB without those
-- roles still applies cleanly.
alter table finland_authority_roles enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on finland_authority_roles from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on finland_authority_roles from authenticated;
  end if;
end $$;
