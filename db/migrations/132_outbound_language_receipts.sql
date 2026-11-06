-- 132 — AR-4E: deterministic outbound language delivery contract.
-- Arabic remains undeclared; these fields prove explicit fallback and exact delivery.

alter table client_parties
  add column if not exists fallback_language text;

alter table outbound_actions
  add column if not exists approved_delivery_contract_version integer,
  add column if not exists approved_delivery_contract_fingerprint text;

alter table outbound_action_receipts
  add column if not exists requested_language text,
  add column if not exists actual_language text,
  add column if not exists language_source text,
  add column if not exists language_fallback_basis text,
  add column if not exists correspondence_locale text,
  add column if not exists template_name text,
  add column if not exists template_catalog_id text,
  add column if not exists template_catalog_version integer,
  add column if not exists rendered_html text,
  add column if not exists attachment_manifest jsonb not null default '[]'::jsonb,
  add column if not exists content_fingerprint text,
  add column if not exists delivery_contract_version integer,
  add column if not exists delivery_contract_fingerprint text;
