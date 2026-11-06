-- Layer 2: the firm's cross-entity memory.
--
-- Facts are identity-keyed (canonical merchant pattern, client
-- UEN/registration number, jurisdiction code) — NEVER clients.id row
-- ids — so a fact's IDENTITY survives a client rename and transfers
-- across clients. (Superseded 2026-06-15: a fact's LIFE now ends with
-- its minting client — deleting/resetting a client PURGES its facts by
-- provenance.client_id; see firmFacts.js + the CLAUDE.md "Firm memory
-- dies with its client" rail.) They are distilled from corrections and client
-- replies by a strong model (the distiller's model id is part of the
-- receipt), carry mandatory provenance, and are human-dismissible:
-- readers honour status='active' only, same discipline as
-- client_rules. General bookkeeping knowledge must never land here —
-- that is the model's layer (see CLAUDE.md / the 06-11 late-night
-- handoff §6).

create table if not exists firm_facts (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  scope text not null check (scope in ('merchant', 'client', 'jurisdiction', 'firm')),
  subject text not null,
  fact text not null,
  provenance jsonb not null default '{}'::jsonb,
  confidence text not null default 'medium' check (confidence in ('low', 'medium', 'high')),
  model text,
  status text not null default 'active' check (status in ('active', 'dismissed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists firm_facts_lookup_idx
  on firm_facts(firm_id, scope, subject, status);
