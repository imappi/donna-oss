alter table ledger_journals add column if not exists correction_type text;
alter table ledger_journals add column if not exists correction_of_journal_id text;
alter table ledger_journals add column if not exists reversal_of_journal_id text;
alter table ledger_journals add column if not exists correction_reason text;

create index if not exists ledger_journals_correction_idx
  on ledger_journals(firm_id, client_id, correction_type, correction_of_journal_id);

create index if not exists ledger_journals_reversal_idx
  on ledger_journals(firm_id, client_id, reversal_of_journal_id);
