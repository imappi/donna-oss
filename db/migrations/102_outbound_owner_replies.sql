-- 102: owner email replies to outbound-actions mail (reply_if_wrong v2 —
-- email-reply ingestion; outbound-actions plan §4 D1's named v2 follow-up).
--
-- The owner digest says "reply if anything looks wrong" / "reply to this
-- email and Donna will take it from there". v1 wired the workspace click
-- verb (markExecutedOutboundActionWrong); this table is the email channel's
-- substrate: the reply webhook stores each ATTRIBUTED owner reply here, and
-- the hourly outbound sweep classifies it (strong model, extraction trust
-- level — reply text is untrusted DATA, never instructions) and routes a
-- confident "this send was wrong" THROUGH the same writer — never around it.
--
-- Lifecycle (closed enum; resting states are terminal-with-receipt or
-- on-the-owner — two-terminal-states applied to the reply lane):
--   stored         transition: awaiting the classification sweep.
--   marked_wrong   terminal: routed through markExecutedOutboundActionWrong
--                  (the D1 correction + audit event are the receipt).
--   already_marked terminal: the target action was already marked (the
--                  writer's idempotency guard matched zero rows).
--   no_action      terminal: acknowledgement/other — the persisted
--                  classification verdict is the receipt. Also the shadow
--                  stage's terminal (shadow classifies + receipts
--                  would-mark counts, but never marks and never surfaces
--                  an owner line).
--   needs_owner    terminal ON THE OWNER: a wrong-claim without a single
--                  confident target, a question Donna cannot act on by
--                  email, or a reply whose classification kept failing —
--                  surfaced once in the next owner digest
--                  (owner_notified_at is the notified-once stamp) and on
--                  the workspace Actions tab.
--
-- The webhook stores ONLY sender-attributed rows (threading match against
-- outbound_digests.provider_message_id, else a UNIQUE owner-email match
-- across clients); unattributed mail is acked and left to the monitored
-- mailbox — never a guessed binding.

create table if not exists outbound_owner_replies (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  provider text not null default 'resend',
  event_type text not null,
  provider_email_id text,
  from_email text not null,
  to_email text,
  subject text,
  text_body text,
  html_body text,
  headers jsonb,
  message_id text,
  in_reply_to text,
  references_header text,
  -- How the reply was bound to (firm, client): the digest thread id or a
  -- unique owner-email match. Attribution provenance, part of the receipt.
  matched_via text not null check (matched_via in ('digest_thread', 'owner_email')),
  status text not null default 'stored'
    check (status in ('stored', 'marked_wrong', 'already_marked', 'no_action', 'needs_owner')),
  -- The persisted classification verdict (render the persisted verdict —
  -- never re-infer): intent, target action id, reason, and the
  -- provider-returned model id (the model id is part of the receipt).
  classification jsonb,
  classified_at timestamptz,
  marked_action_id text,
  -- Classification attempt counter: a row that keeps failing goes to
  -- needs_owner (fail toward the owner), never retries forever and never
  -- dies silently.
  attempts integer not null default 0,
  -- Notified-once stamp for the digest's "about your replies" line.
  owner_notified_at timestamptz,
  -- Human-mailbox backstop: where the webhook forwarded a copy (env
  -- OUTBOUND_REPLY_FORWARD_TO), when configured.
  forwarded_to text,
  forwarded_at timestamptz,
  raw_payload jsonb,
  received_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Webhook redelivery dedupe (the marketing inbound shape): one row per
-- provider event; a redelivered event is a receipted no-op.
create unique index if not exists outbound_owner_replies_dedupe_idx
  on outbound_owner_replies (provider, event_type, provider_email_id)
  where provider_email_id is not null;

-- The sweep's work queue: stored rows per client.
create index if not exists outbound_owner_replies_work_idx
  on outbound_owner_replies (firm_id, client_id)
  where status = 'stored';

-- The digest's "about your replies" gather: un-notified needs_owner rows.
create index if not exists outbound_owner_replies_needs_owner_idx
  on outbound_owner_replies (firm_id, client_id)
  where status = 'needs_owner' and owner_notified_at is null;

-- ── RLS-native (mirror 090/091/092/093) ──────────────────────────────────────
alter table outbound_owner_replies enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on outbound_owner_replies from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on outbound_owner_replies from authenticated;
  end if;
end $$;
