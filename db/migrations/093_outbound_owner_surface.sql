-- 093 — Outbound owner surface (M1, G8 + G9): per-action capability tokens
-- and the owner-digest ledger.
--
-- Tokens (G8/G9, the marketing unsubscribe-token shape — a random bearer
-- capability that lands in an inbox, resolved by a public endpoint):
--   - unsubscribe_token: the counterparty's one-click out. The public
--     endpoint suppresses the recipient (outbound_suppression, reason
--     'unsubscribed') — the next send attempt gate-blocks and the chase
--     stops honestly. Unsubscribe must never require auth (marketing rail).
--   - approval_token: the OWNER's approve/decline tap from the G9 digest
--     email (D10: email is the US workbench; approve links are the M1
--     approval surface until the G15 workspace lands). Approve flips
--     hold_for_approval → approved through approveOutboundAction (non-system
--     principal); decline cancels with a receipt and stops the case.
--
-- outbound_digests (G9): one row per digest actually delivered to the owner
-- — content hash for change-detection (an unchanged digest is not re-sent
-- daily; a stale one re-surfaces), counts for the metrics rollup, and the
-- provider message id. Not a receipt for a third-party send (those live in
-- outbound_action_receipts); this is the owner-channel delivery ledger.

alter table outbound_actions
  add column if not exists approval_token text,
  add column if not exists unsubscribe_token text;

create unique index if not exists outbound_actions_approval_token_idx
  on outbound_actions(approval_token) where approval_token is not null;
create unique index if not exists outbound_actions_unsubscribe_token_idx
  on outbound_actions(unsubscribe_token) where unsubscribe_token is not null;

create table if not exists outbound_digests (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  channel text not null default 'email',
  recipient text,
  -- Deterministic hash of the digest's content set (pending action ids +
  -- statuses + must-review ids) — the re-send guard.
  content_hash text not null,
  pending_count integer not null default 0,
  must_review_count integer not null default 0,
  needs_input_count integer not null default 0,
  provider_message_id text,
  payload jsonb not null default '{}'::jsonb,
  sent_at timestamptz not null default now()
);

create index if not exists outbound_digests_client_idx
  on outbound_digests(firm_id, client_id, sent_at desc);

-- ── RLS-native (mirror 090/091/092) ──────────────────────────────────────────
alter table outbound_digests enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on outbound_digests from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on outbound_digests from authenticated;
  end if;
end $$;
