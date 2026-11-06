-- Marketing Prospecting Lab spine — P0A of docs/design-donna-prospecting.md
-- (v4, approved 2026-07-05).
--
-- Doctrine: source-agnostic lab. A SOURCE is where a candidate came from
-- (Companies House scan, manual upload); a CAMPAIGN is the GTM hypothesis
-- being tested — stored separately so learning slices by campaign and
-- provenance reads from source. Dossiers are strong-model output with the
-- model id stamped (the receipt). Zero sends live in this slice: P0 mints
-- and reviews dossiers only; sending remains slice-1 machinery behind
-- per-send approval and (for cold) the P1 jurisdiction/deliverability gates.
--
-- Firm-agnostic (047's line): no FK into firms/clients; RLS server-owned.

-- ── Source runs — one receipt per scan/upload ────────────────────────────────
create table if not exists marketing_source_run (
  id text primary key,
  -- companies_house_overdue | companies_house_first_filing | manual_upload
  -- (writer-normalized; no CHECK so a new source module never rejects a run
  -- receipt — 047's posture for public-adjacent vocabularies).
  source text not null,
  -- Scan parameters (SIC codes, page bounds, upload filename…) for replay.
  params jsonb not null default '{}'::jsonb,
  candidates_found integer not null default 0,
  prospects_minted integer not null default 0,
  started_by text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  error text
);

create index if not exists marketing_source_run_source_idx
  on marketing_source_run(source, started_at desc);

-- ── Prospects — the lab's unit of work ───────────────────────────────────────
create table if not exists marketing_prospect (
  id text primary key,
  -- Identity. company_number is the registry key when the source has one;
  -- manual uploads may carry only a name/URL.
  company_name text not null,
  company_number text,
  jurisdiction text not null default 'UK',
  website text,
  -- Where this prospect CAME from (provenance).
  source text not null,
  source_run_id text references marketing_source_run(id),
  -- What is being TESTED on it (learning) — array of campaign tags, separate
  -- from source by design (campaign ≠ source).
  campaigns jsonb not null default '[]'::jsonb,
  -- Lifecycle (docs/design-donna-prospecting.md §5). research_only is the
  -- deliberate NON-terminal parking state for Red-tier segments.
  status text not null default 'candidate'
    check (status in (
      'candidate', 'investigating', 'on_kari', 'approved_for_draft',
      'approved_for_send', 'contacted_awaiting_reply', 'closed_no_reply',
      'converted', 'unfit', 'suppressed', 'research_only')),
  -- Green | yellow | red acceptance tier (§3C) — drives capability flags in
  -- the runtime (red: dossier yes, send/bill only with dated sign-off).
  tier text not null default 'green'
    check (tier in ('green', 'yellow', 'red')),
  -- The dossier: evidence, fit-vs-gates, disorder signal + citation,
  -- negative-evidence block, rubric scores, jurisdiction legality check,
  -- contact route + where published, why-now line, recommended action.
  dossier jsonb,
  -- Provider-RETURNED model id of the dossier drafter (the receipt).
  dossier_model text,
  contact_email text,
  -- Follow-up discipline: contacted_awaiting_reply must carry next_action_at
  -- (one follow-up then closed_no_reply) — nothing rests contacted forever.
  next_action_at timestamptz,
  -- Kari's decision trail (operator attribution).
  decided_by text,
  decided_at timestamptz,
  -- Machine-readable reject reasons (§10A taxonomy) — the lab's learning
  -- output; free text rides inside the array entries when needed.
  reject_reasons jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One live prospect per company per jurisdiction (registry-keyed when
-- possible; name-keyed manual uploads dedup at the writer).
create unique index if not exists marketing_prospect_company_number_uniq
  on marketing_prospect(jurisdiction, company_number)
  where company_number is not null;
create index if not exists marketing_prospect_status_idx
  on marketing_prospect(status);
create index if not exists marketing_prospect_email_idx
  on marketing_prospect(lower(contact_email))
  where contact_email is not null;

-- ── RLS-native (mirror 047/050) ──────────────────────────────────────────────
alter table marketing_source_run enable row level security;
alter table marketing_prospect enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on marketing_source_run from anon;
    revoke all on marketing_prospect from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on marketing_source_run from authenticated;
    revoke all on marketing_prospect from authenticated;
  end if;
end $$;
