alter table client_whatsapp_bindings
  add column if not exists channel text not null default 'whatsapp';

alter table client_whatsapp_bindings
  add constraint client_whatsapp_bindings_channel_check
  check (channel in ('whatsapp', 'sms'));

alter table client_whatsapp_bindings
  drop constraint if exists client_whatsapp_bindings_firm_id_client_id_collaborator_id_phone_hash_key;

alter table client_whatsapp_bindings
  add constraint client_whatsapp_bindings_firm_client_collab_phone_channel_key
  unique (firm_id, client_id, collaborator_id, phone_hash, channel);

create index if not exists client_whatsapp_bindings_sms_client_active_idx
  on client_whatsapp_bindings(firm_id, client_id)
  where revoked_at is null and channel = 'sms';

create index if not exists client_whatsapp_bindings_sms_phone_active_idx
  on client_whatsapp_bindings(phone_hash)
  where revoked_at is null and channel = 'sms';
