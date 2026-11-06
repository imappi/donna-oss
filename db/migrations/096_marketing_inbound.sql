-- Marketing inbound — M3 of the closed-commercial-loop arc (reply ingestion).
-- Every inbound email event becomes a RECEIPTED interaction row: what arrived,
-- how it was classified (deterministically — semantic triage is M4), which
-- lead/prospect it matched, and exactly what the writer did about it
-- (suppression, forward). Nothing silent: the row IS the receipt.
--
-- Firm-agnostic (047's line): lead-facing transport data, no firm/client FK.
-- Provider events outside the handled set are acknowledged and NOT stored —
-- the CHECK below pins the stored vocabulary, the route filters upstream.

create table if not exists marketing_inbound_message (
  id text primary key,
  provider text not null default 'resend',
  event_type text not null
    check (event_type in ('email.received', 'email.bounced', 'email.complained')),
  -- Provider's id for the email (Resend email_id). Dedupe key for webhook
  -- redelivery — Svix retries until it sees a 2xx.
  provider_email_id text,
  from_email text,
  to_email text,
  subject text,
  text_body text,
  html_body text,
  -- Raw headers as retrieved (jsonb, shape provider-defined) plus the parsed
  -- threading fields the reply loop needs.
  headers jsonb,
  message_id text,
  in_reply_to text,
  references_header text,
  -- Deterministic classification (M3 vocabulary; writer-enforced + CHECK):
  -- 'reply' = matched human mail awaiting the human/M4 layer.
  classification text not null
    check (classification in (
      'reply', 'unsubscribe_request', 'bounce', 'complaint',
      'out_of_office', 'auto_reply', 'unmatched'
    )),
  matched_lead_email text,
  matched_prospect_id text,
  -- What the writer DID: e.g. [{"action":"suppress","email":"...","reason":"bounced"}]
  handled_actions jsonb not null default '[]'::jsonb,
  forwarded_to text,
  error text,
  raw_payload jsonb,
  received_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists marketing_inbound_dedupe_uniq
  on marketing_inbound_message(provider, event_type, provider_email_id)
  where provider_email_id is not null;

create index if not exists marketing_inbound_classification_idx
  on marketing_inbound_message(classification, created_at desc);

create index if not exists marketing_inbound_from_idx
  on marketing_inbound_message(lower(from_email));

-- ── RLS-native (mirror 050/051) ─────────────────────────────────────────────
alter table marketing_inbound_message enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on marketing_inbound_message from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on marketing_inbound_message from authenticated;
  end if;
end $$;
