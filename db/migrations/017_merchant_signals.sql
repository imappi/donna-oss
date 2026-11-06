-- Cross-client / cross-firm merchant categorisation signals.
--
-- When a firm clicks Apply on a `remember_merchant` action card in the
-- transaction chat (or applies a category to a transaction), we
-- capture an anonymised aggregate signal here so the LLM can use it
-- as a prior on future categorisation calls — for the same client,
-- for other clients of the same firm, and for entirely different
-- firms. Until this table exists every "the bookkeeper teaches Donna
-- a merchant" moment is locked inside one client's books.
--
-- Two tables:
--
--   merchant_signal_events  Append-only event log with full
--                           provenance. Holds firm_id and client_id
--                           so we can audit, investigate abuse, and
--                           re-derive the rollup if it drifts. NOT
--                           queried by any LLM context builder —
--                           treated as PII-adjacent.
--
--   merchant_signal_rollup  Aggregated counts keyed on the normalised
--                           merchant pattern + account + jurisdiction.
--                           No firm/client identifiers — safe to feed
--                           to the LLM. Cross-tenant leakage is
--                           structurally impossible here.
--
-- Two signal kinds, weighted differently:
--
--   remember_merchant  Firm explicitly asked Donna to remember this
--                      merchant. Strong, intentional signal. Weight 3.
--
--   apply_category     Firm applied a category to a transaction. Less
--                      intentional but still real-world evidence.
--                      Weight 1.
--
-- Negative signals (firm rejected / edited a proposal) are NOT
-- captured in v1 — needs a "reject" UI surface that doesn't exist yet.
--
-- Defensive note (mirrors migration 016): production Postgres rejected
-- the migration that included `references transactions(id)` on
-- transaction_chat_messages. The source-row columns below
-- (source_transaction_id, source_chat_message_id) are intentionally
-- plain text columns — orphans are tolerable in an audit log, and we
-- don't want a deleted transaction to silently delete its signals.

create table if not exists merchant_signal_events (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  source_transaction_id text,
  source_chat_message_id text,
  source_action_index integer,
  merchant_key text not null,
  raw_merchant text not null,
  account_name text not null,
  account_code text,
  tax_treatment text,
  contact_name text,
  jurisdiction text not null default '',
  signal_kind text not null
    check (signal_kind in ('remember_merchant', 'apply_category')),
  weight integer not null default 1 check (weight > 0),
  created_at timestamptz not null default now()
);

create index if not exists merchant_signal_events_key_idx
  on merchant_signal_events(merchant_key, account_name);
create index if not exists merchant_signal_events_firm_client_idx
  on merchant_signal_events(firm_id, client_id, created_at desc);

create table if not exists merchant_signal_rollup (
  merchant_key text not null,
  account_name text not null,
  jurisdiction text not null default '',
  occurrence_weight integer not null default 0,
  occurrence_count integer not null default 0,
  last_seen_at timestamptz not null default now(),
  primary key (merchant_key, account_name, jurisdiction)
);

create index if not exists merchant_signal_rollup_key_idx
  on merchant_signal_rollup(merchant_key, jurisdiction, occurrence_weight desc);
