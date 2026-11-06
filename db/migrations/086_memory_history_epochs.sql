-- Donna — BizOS Slice 2c-iii (sub-PR 5): the HARD MEMORY-HISTORY FENCE
-- (design-donna-bizos-slice-2c-iii-canary.md §F / §N-D, DECIDED Kari 2026-07-13).
--
-- `known_facts = null` is necessary but far from sufficient to prove legacy left
-- the prompt: legacy facts re-enter through prior user/assistant turns and
-- summaries in the conversation history. Example — a shadow-era assistant turn
-- said "your VAT registration date is 4 May"; the client enters canary, v2 now
-- excludes that fact, but the old assistant message is still in live history, so
-- the model still receives the legacy fact.
--
-- The DECIDED mechanism is a HARD FENCE (the one straightforward-to-prove-correct
-- option): on a memory-mode transition we open a NEW epoch and exclude ALL
-- pre-epoch user messages, assistant messages, AND summaries from the MODEL
-- payload. The transcript is PRESERVED for the owner UI + audit (nothing deleted
-- or hidden) — only the model's view is fenced. The fence applies BOTH ways: a new
-- epoch on canary entry AND on rollback to legacy (v2-derived facts must not
-- linger into a legacy prompt).
--
-- Activation unit is the FULL §N-C tuple `client × audience × purpose` — an epoch
-- for portal_owner_context/owner does not fence a future bookkeeping-action or
-- professional-handoff audience. The lever (sub-PR 8) opens epochs; the seam
-- (sub-PR 7) reads the active epoch and filters history against its boundary
-- (buildHistoryForMemoryEpoch in memoryHistoryEpoch.js).
--
-- Plain columns (the firm_facts / memories pattern) — no clients FK. Tenant
-- boundary cascades from firms; per-client epoch death is the explicit client
-- purge, never a silent cascade.

create table if not exists memory_history_epochs (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        text not null references firms(id) on delete cascade,
  client_id        text not null,
  audience         text not null,
  purpose          text not null,
  -- Monotonic per (tenant, client, audience, purpose). epoch_seq = 0 is the
  -- implicit pre-fence baseline; the first real fence is epoch_seq = 1.
  epoch_seq        integer not null,
  -- The mode this epoch BEGINS ('v2' on canary entry, 'legacy' on rollback).
  mode_entered     text not null check (mode_entered in ('v2', 'legacy')),
  -- The boundary: messages with created_at STRICTLY BEFORE this instant are
  -- pre-epoch → excluded from the model payload. Set to the transition time.
  boundary_at      timestamptz not null default now(),
  -- Optional id of the turn the transition was stamped at (provenance only; the
  -- boundary_at timestamp is the authoritative cutoff the reader uses).
  boundary_message_id text,
  reason           text,
  set_by_actor_type text not null default 'system',
  set_by_actor_id  text,
  created_at       timestamptz not null default now()
);

-- One row per (tuple, epoch_seq) — a transition can never mint two epochs at the
-- same sequence.
create unique index if not exists memory_history_epochs_tuple_seq_idx
  on memory_history_epochs (tenant_id, client_id, audience, purpose, epoch_seq);

-- Latest-epoch lookup for the seam: newest by epoch_seq within the tuple.
create index if not exists memory_history_epochs_active_idx
  on memory_history_epochs (tenant_id, client_id, audience, purpose, epoch_seq desc);

alter table memory_history_epochs enable row level security;
