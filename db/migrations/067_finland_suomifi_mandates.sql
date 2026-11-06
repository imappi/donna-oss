-- 067 — Finland G-3 (FI-15): Suomi.fi mandate tracking. ADDITIVE.
--
-- The Suomi.fi-valtuudet mandate ("veroasioiden hoito") is the LEGAL
-- authorization Verohallinto sees when Donna files for a client — distinct from
-- the owner's WhatsApp "kyllä", which is Donna's internal authority receipt
-- (D-FI8-1, docs/design-donna-finland-fi8-omavero-adapter.md). This table
-- tracks the grant so the filing path can refuse without one: no valid mandate
-- ⇒ transmitAlvReturnFiling refuses typed (ALV_FILING_MANDATE_REQUIRED) — a
-- statutory submission never rides an unverified authorization.
--
-- Status is a CLOSED two-state enum (two-terminal-states applied to a legal
-- grant): 'active' (valid until expires_on or revocation) or 'revoked'
-- (terminal-with-receipt: revoked_on + reason + audit event). Expiry needs no
-- third state — an active row past its expires_on evaluates invalid at READ
-- time (evaluateSuomifiMandate, server/donna/finland/suomifiMandate.js); the
-- date is the receipt. Recording/revocation are firm actions, audited
-- in-transaction (audit-as-precondition) with the acting member attributed.
-- Design: docs/design-donna-finland-production-readiness.md (gap G-3).

create table if not exists suomifi_mandates (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  -- Suomi.fi mandate theme. Free text keyed to Suomi.fi's own catalog (the
  -- authority's vocabulary, not ours); ALV filing looks up 'veroasioiden_hoito'.
  scope text not null default 'veroasioiden_hoito',
  status text not null default 'active' check (status in ('active', 'revoked')),
  granted_on date not null,
  -- Suomi.fi mandates are time-bounded (max 25 years); null = no recorded end.
  expires_on date,
  revoked_on date,
  revoke_reason text,
  -- Free-form pointer to the verification (e.g. the Suomi.fi valtuudet listing
  -- checked, a mandate reference code).
  reference text,
  -- How the grant was verified: who checked Suomi.fi, when, against what.
  provenance jsonb not null default '{}'::jsonb,
  recorded_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ONE active mandate per (firm, client, scope): re-recording requires revoking
-- the prior grant first — the trail stays honest, no silent replacement.
create unique index if not exists suomifi_mandates_active_scope_idx
  on suomifi_mandates(firm_id, client_id, scope)
  where status = 'active';

create index if not exists suomifi_mandates_client_idx
  on suomifi_mandates(firm_id, client_id);
