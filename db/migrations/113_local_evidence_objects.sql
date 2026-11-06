-- Desktop M1 — the content-addressed local blob store's index (technical
-- plan §6). On desktop, evidence bytes live on disk keyed by sha256 content
-- hash (immutable, atomic-write, dedupe by identity); this table maps the
-- pipeline's (bucket, key) namespace — unchanged for every caller of
-- evidenceStorage.js — onto that hash, and carries the metadata the plan
-- names (MIME, byte length, original filename as metadata only). The backup
-- package's manifest reads hashes from here. In cloud deployments the table
-- is inert (evidenceStorage stays on Supabase unless local mode is on).

create table if not exists local_evidence_objects (
  bucket text not null,
  key text not null,
  content_hash text not null,
  byte_length bigint not null,
  content_type text,
  original_filename text,
  created_at timestamptz not null default now(),
  primary key (bucket, key)
);

-- The GC query: "is this hash still referenced by any key?"
create index if not exists local_evidence_objects_hash_idx
  on local_evidence_objects (content_hash);

-- Server-only table: RLS on with no policies (deny-all for browser roles;
-- the service connection is unaffected). On desktop the local principal owns
-- the database and the Supabase roles simply don't exist.
alter table local_evidence_objects enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on local_evidence_objects from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on local_evidence_objects from authenticated;
  end if;
end $$;
