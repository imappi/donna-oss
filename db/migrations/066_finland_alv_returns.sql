-- 066 — Finland FI-3: ALV return lifecycle (compute-and-file lane, D3). ADDITIVE.
--
-- First-class persistence for the periodic ALV return (ALV-ilmoitus) Donna
-- computes and — with the owner's confirmed authority — files. The lifecycle is
-- a CLOSED enum whose resting states obey two-terminal-states:
--   • draft_pending_confirmation — ON THE OWNER: an open alv_return confirm ask
--     (client_evidence_requests) always accompanies it;
--   • filed — terminal-with-receipt: filing receipt (transmit channel +
--     submission id) + authority basis (the owner's "kyllä") + audit event;
--   • cancelled — terminal-with-receipt: the owner's explicit negative, audited.
-- No transient state is persistable; a needs_review compute never mints a row
-- (its blockers escalate as an owner clarification ask instead).
-- Design: docs/design-donna-finland-fi3-alv-return.md (slice P; D3 decided
-- compute-and-file, Kari 2026-07-10).
--
-- One LIVE return per (firm, client, period): the partial unique index spans
-- draft_pending_confirmation + filed, so a cancel frees the period for a fresh
-- compute while a pending or filed return blocks duplicates. A replacement
-- filing (korvaava ilmoitus) is FI-8 follow-up territory.

create table if not exists alv_returns (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  period_key text not null,
  period_type text not null check (period_type in ('month', 'quarter', 'year')),
  starts_on date not null,
  ends_on date not null,
  status text not null default 'draft_pending_confirmation'
    check (status in ('draft_pending_confirmation', 'filed', 'cancelled')),
  -- The persisted compute verdict: boxes + payable + review + provenance. The
  -- confirm summary renders THIS (render-the-persisted-verdict); the filing
  -- transmits THIS, re-footed (assertAlvReturnFoots), never a re-compute.
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

create unique index if not exists alv_returns_live_period_idx
  on alv_returns(firm_id, client_id, period_key)
  where status in ('draft_pending_confirmation', 'filed');

create index if not exists alv_returns_client_status_idx
  on alv_returns(firm_id, client_id, status);
