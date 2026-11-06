-- 104 — The owner-command trust cluster (kernel audit G13, P0 release-blocking
-- for the first loop). Substrate for `server/donna/ownerInvoiceCommand.js`: an
-- owner types "invoice Acme $1,500 for the May retainer and chase it until
-- paid" in their own channel, and that sentence becomes a real invoice to a
-- real counterparty. Four things the tree could not express before, each a
-- verified gap (evidence-index rows 56-57):
--
--   (a) SOURCE-MESSAGE IDEMPOTENCY. `outbound_actions.idempotency_key` keys on
--       the ANCHOR — which is the issued invoice, which does not exist until a
--       number has been allocated. So a replayed webhook or a retried turn
--       allocated a SECOND invoice number before anything could dedupe it.
--       `owner_invoice_commands.source_message_id` is the natural key that
--       exists BEFORE allocation: claim it first, then do the work.
--
--   (b) PRINCIPAL + CHANNEL BINDING on the command receipt. `audit_events`
--       `actor_id` is ~always 'system' (the F-26 attribution gap). A sentence
--       that causes an invoice must name WHO said it and on WHICH bound
--       channel, or the consequence has no author.
--
--   (c) FIELD PROVENANCE. Approving a consequence must not silently canonize a
--       fact the MODEL inferred as though the OWNER had stated it. Every field
--       on the draft records which of the two it came from.
--
--   (d) APPROVED-CONSEQUENCE FINGERPRINT (the column added to
--       `outbound_actions` below). The executor already re-checks anchor
--       lifecycle, suppression and paid-truth at send, but nothing detected the
--       draft's BUSINESS FACTS changing between approval and send. The
--       fingerprint is taken over what the owner actually approved and
--       re-computed at send; a mismatch refuses with a named reason and rests
--       the row ON THE OWNER.
--
-- Two-terminal-states for a command row: it RESTS only as
--   - 'drafted'  (Donna acted — a draft + a held action exist; the action's own
--                 lifecycle carries it on), or
--   - 'asked'    (on the OWNER — a business fact only they can supply), or
--   - 'refused'  (terminal, receipted with a named reason).
-- 'reading' is the transient hop between claiming the message and resolving it;
-- a row stuck there is a crash, and the retry re-claims it (see the partial
-- index below).

create table if not exists owner_invoice_commands (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,

  -- (a) The natural key. One command per inbound message, forever.
  source_message_id text not null,
  source_channel text not null
    check (source_channel in ('whatsapp', 'telegram', 'sms', 'email', 'web')),

  -- (b) WHO said it, and on which bound channel. Never 'system': a command is
  -- by definition something a human principal said.
  principal_actor_type text not null
    check (principal_actor_type <> 'system'),
  principal_actor_id text,
  channel_binding jsonb not null default '{}'::jsonb,

  status text not null default 'reading'
    check (status in ('reading', 'drafted', 'asked', 'refused')),
  -- Named, closed reason vocabulary lives in the runtime; free text here would
  -- be a silent third terminal.
  status_reason text,

  -- The outcome, once there is one. Deliberately NOT foreign keys to
  -- issued_invoices / outbound_actions: a command row is the RECEIPT of what
  -- was said, and it must survive the loss of what it produced (an invoice
  -- voided later does not un-say the sentence).
  issued_invoice_id text,
  outbound_action_id text,
  -- The owner question this command became, when it rests on the owner.
  evidence_request_id text,

  -- (c) Per-field { owner_supplied | model_proposed } for every fact on the
  -- draft, plus the model id that read the message (the model id is part of
  -- the receipt).
  field_provenance jsonb not null default '{}'::jsonb,
  model text,
  config_snapshot_id text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- (a) THE natural key. Scoped by client because the customer boundary is
-- client <-> client, and a message id is only unique within its channel.
create unique index if not exists owner_invoice_commands_source_idx
  on owner_invoice_commands (firm_id, client_id, source_channel, source_message_id);

create index if not exists owner_invoice_commands_client_status_idx
  on owner_invoice_commands (firm_id, client_id, status, created_at desc);

-- The status projection reads back from the issued invoice (the root anchor).
create index if not exists owner_invoice_commands_invoice_idx
  on owner_invoice_commands (firm_id, client_id, issued_invoice_id)
  where issued_invoice_id is not null;

-- (d) The approved-consequence fingerprint. Additive column; NULL on every
-- existing row and on every action that was never approved, so the executor's
-- check is a no-op for them (byte-identical to today).
alter table outbound_actions
  add column if not exists approved_consequence_fingerprint text;

-- ── RLS-native (mirror 090 / 091) ────────────────────────────────────────────
-- Server-owned data; the browser never queries this table. ENABLE (not FORCE)
-- so the RLS-exempt owner role stays exempt; revoke the Supabase browser roles.
-- Guarded so a dev DB without those roles applies cleanly.
alter table owner_invoice_commands enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on owner_invoice_commands from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on owner_invoice_commands from authenticated;
  end if;
end $$;
