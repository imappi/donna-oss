-- Telegram owner channel — reuses the client_whatsapp_bindings table via the
-- `channel` discriminator (added in 059, which admitted 'whatsapp' | 'sms').
-- This admits 'telegram' and adds the partial active indexes its lookups use.
-- No new tables: bindings, bind-tokens, and the delivery ledger are all shared;
-- for Telegram, phone_e164 carries the chat_id string and phone_hash =
-- hashPhoneE164(chat_id) so the inbound anchor and the binding agree.

alter table client_whatsapp_bindings
  drop constraint if exists client_whatsapp_bindings_channel_check;

alter table client_whatsapp_bindings
  add constraint client_whatsapp_bindings_channel_check
  check (channel in ('whatsapp', 'sms', 'telegram'));

create index if not exists client_whatsapp_bindings_telegram_client_active_idx
  on client_whatsapp_bindings(firm_id, client_id)
  where revoked_at is null and channel = 'telegram';

create index if not exists client_whatsapp_bindings_telegram_phone_active_idx
  on client_whatsapp_bindings(phone_hash)
  where revoked_at is null and channel = 'telegram';
