-- Ask-pipeline batches — ONE drafted client message per (client, period),
-- drafted by a strong model FROM the persisted coding verdicts
-- (payload.ai_suggestion) and the statement-coverage picture. The batch
-- is the message unit; the individual blocking questions ride the
-- existing client_evidence_requests loop when the batch is SENT, so
-- replies keep flowing through the resolve/chat bridge that already
-- exists. Notify-only items (decide-and-notify: owner draws, internal
-- transfers the firm recorded on the client's behalf) live only in the
-- message body — their appeal path is the correction loop, not an
-- evidence request.
--
-- status vocabulary:
--   'draft'      — drafted, awaiting firm review; the only sendable state
--   'sent'       — evidence requests created, message considered delivered
--   'superseded' — a newer draft replaced it before it was sent
--   'cancelled'  — firm discarded it
--
-- verdicts_as_of is the staleness anchor: the max of the coding
-- verdicts' suggested_at and reconciliation_evaluations.evaluated_at at
-- draft time. A sweep or coding run newer than this means the draft no
-- longer reflects the books — re-draft, don't send.
create table if not exists client_ask_batches (
  id               text primary key,
  firm_id          text not null references firms(id) on delete cascade,
  client_id        text not null references clients(id) on delete cascade,
  period_start     date,
  period_end       date,
  status           text not null default 'draft'
                     check (status in ('draft', 'sent', 'superseded', 'cancelled')),
  subject          text,
  message_markdown text,
  payload          jsonb not null default '{}'::jsonb,
  verdicts_as_of   timestamptz,
  model            text,
  created_by       text,
  sent_at          timestamptz,
  sent_by          text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists client_ask_batches_firm_client_idx
  on client_ask_batches (firm_id, client_id, status, created_at desc);
