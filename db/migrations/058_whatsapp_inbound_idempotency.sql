-- WhatsApp slice 2: inbound webhook idempotency.
-- No new pipeline/table: this pins the existing delivery ledger so a Meta
-- redelivery of the same inbound wamid cannot resolve/register twice.

create unique index if not exists message_delivery_ledger_inbound_reply_id_uidx
  on message_delivery_ledger (inbound_reply_id)
  where inbound_reply_id is not null;
