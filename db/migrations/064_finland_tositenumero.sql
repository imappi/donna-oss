-- 064 — Finland FI-5: tositenumero (gap-free sequential voucher number). ADDITIVE.
--
-- A tosite (voucher) carries a juokseva (running) number that is aukoton
-- (gap-free) PER tilikausi — the standard way to guarantee the kirjausketju
-- (audit trail): any voucher can be traced to how it was booked and how it flowed
-- into the financial statement, and back (Kirjanpitolaki / Taloushallintoliitto).
--
-- The counter itself lives on fiscal_years.next_tosite_no (migration 063, reserved
-- there for exactly this). Here we add the per-journal number + its tilikausi FK,
-- and a partial unique index that is the belt-and-braces backstop to the
-- row-locked allocation in firmDb.js __writeLedgerJournalRows.
--
-- Nullable + partial index ⇒ existing rows and flag-off (FINLAND_TOSITENUMERO)
-- clients are untouched: tosite_number stays null, no number is allocated, and the
-- unique index ignores null rows. See docs/design-donna-finland-tilikausi-tositenumero.md §2.

alter table ledger_journals add column if not exists fiscal_year_id text
  references fiscal_years(id) on delete restrict;

alter table ledger_journals add column if not exists tosite_number integer;

-- Gap-free, monotonic, unique PER (client, tilikausi). Partial so null (unnumbered)
-- journals never collide — only assigned numbers are constrained.
create unique index if not exists ledger_journals_tosite_uidx
  on ledger_journals(firm_id, client_id, fiscal_year_id, tosite_number)
  where tosite_number is not null;
