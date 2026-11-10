-- 173 — A principal's name is optional.
--
-- A self-signed-up business owner was stored with the COMPANY's name as their
-- own (`firm_collaborators.name`), because the column was NOT NULL and the
-- sign-up often knows no person name (an email + password sign-up collects
-- none). Every reader that shows a person — the mention roster, the phone
-- app's principal, the owner list — already falls back to the email address
-- when the name is missing, so the honest value for an unknown name is NULL.
-- Existing rows are left as they are; this only stops new rows from needing
-- a made-up name.

alter table firm_collaborators alter column name drop not null;
