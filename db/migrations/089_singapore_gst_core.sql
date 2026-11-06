-- 089 — Singapore vertical core: GST return lifecycle + CorpPass mandate
-- tracking. ADDITIVE. Mirrors the Finland pair (066 alv_returns + 067
-- suomifi_mandates) in ONE migration file — the parallel-session migration-
-- numbering discipline (high-water was 088; the sibling Finland CS session also
-- mints numbers) favors consuming one number for one cohesive vertical core.
--
-- gst_returns — first-class persistence for the periodic GST F5 Donna computes
-- and — with the owner's confirmed authority — files to IRAS. The lifecycle is
-- a CLOSED enum whose resting states obey two-terminal-states:
--   • draft_pending_confirmation — ON THE OWNER: an open gst_return confirm ask
--     (client_evidence_requests) always accompanies it;
--   • filed — terminal-with-receipt: filing receipt (transmit channel +
--     submission id) + authority basis (the owner's "yes") + audit event;
--   • cancelled — terminal-with-receipt: the owner's explicit negative, audited.
-- No transient state is persistable; a needs_review compute never mints a row
-- (its blockers escalate as owner clarification asks instead).
--
-- One LIVE return per (firm, client, period): the partial unique index spans
-- draft_pending_confirmation + filed, so a cancel frees the period for a fresh
-- compute while a pending or filed return blocks duplicates.

create table if not exists gst_returns (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  period_key text not null,
  -- Singapore prescribed accounting periods are monthly or quarterly only —
  -- there is no annual GST period (the deliberate difference from alv_returns).
  period_type text not null check (period_type in ('month', 'quarter')),
  starts_on date not null,
  ends_on date not null,
  status text not null default 'draft_pending_confirmation'
    check (status in ('draft_pending_confirmation', 'filed', 'cancelled')),
  -- The persisted compute verdict: boxes + payable + review + provenance. The
  -- confirm summary renders THIS (render-the-persisted-verdict); the filing
  -- transmits THIS, re-footed (assertGstF5Foots), never a re-compute.
  verdict jsonb not null default '{}'::jsonb,
  -- Deterministic compute → null; stamped if a model ever informs the verdict.
  model text,
  -- Filing receipts (null until filed):
  filing_receipt jsonb,
  authority_basis jsonb,
  filed_at timestamptz,
  filed_by text,
  cancelled_at timestamptz,
  cancel_reason text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists gst_returns_live_period_idx
  on gst_returns(firm_id, client_id, period_key)
  where status in ('draft_pending_confirmation', 'filed');

create index if not exists gst_returns_client_status_idx
  on gst_returns(firm_id, client_id, status);

-- corppass_mandates — the CorpPass authorization (the Suomi.fi-mandate
-- analogue): the entity assigning the filer digital-service access to the
-- relevant IRAS/ACRA e-Services is the LEGAL authorization the authority sees
-- when Donna files for a client — distinct from the owner's chat "yes", which
-- is Donna's internal authority receipt. The filing path refuses without one:
-- no valid mandate ⇒ transmitGstReturnFiling refuses typed
-- (SG_FILING_CORPPASS_REQUIRED) — a statutory submission never rides an
-- unverified authorization.
--
-- Status is a CLOSED two-state enum (two-terminal-states applied to a legal
-- grant): 'active' or 'revoked' (terminal-with-receipt: revoked_on + reason +
-- audit event). Expiry needs no third state — an active row past its
-- expires_on evaluates invalid at READ time (evaluateCorpPassMandate,
-- server/donna/singapore/corpPassMandate.js); the date is the receipt.

create table if not exists corppass_mandates (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  -- CorpPass digital-service scope, keyed to the authority's e-Service
  -- vocabulary (corpPassMandate.js CORPPASS_SCOPES): the GST filing gate looks
  -- up 'iras_gst'; corporate tax 'iras_cit'; ACRA 'acra_filing'. Free text —
  -- the authority's catalog, not ours.
  scope text not null default 'iras_gst',
  status text not null default 'active' check (status in ('active', 'revoked')),
  granted_on date not null,
  expires_on date,
  revoked_on date,
  revoke_reason text,
  -- Free-form pointer to the verification (e.g. the CorpPass digital-service
  -- assignment checked, an authorization reference).
  reference text,
  -- How the grant was verified: who checked CorpPass, when, against what.
  provenance jsonb not null default '{}'::jsonb,
  recorded_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ONE active mandate per (firm, client, scope): re-recording requires revoking
-- the prior grant first — the trail stays honest, no silent replacement.
create unique index if not exists corppass_mandates_active_scope_idx
  on corppass_mandates(firm_id, client_id, scope)
  where status = 'active';

create index if not exists corppass_mandates_client_idx
  on corppass_mandates(firm_id, client_id);
