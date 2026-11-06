-- 150 — RT-21c (docs/prompt-2026-09-08-rt-21-koontilasku-settlement-rows.md
-- §2, §4 RT-21c): the row-level settlement on `reconciliation_matches`.
--
-- A koontilasku (a consolidated settlement statement: one document listing
-- several settlements, each with its own gross, fee and net) is settled ROW
-- by row — bank line ↔ statement row, full settlement at that row's NET,
-- exact. RT-21b persists each listed row as a `document_lines` row at its
-- net (the printed breakdown under payload.raw_extraction.settlement_row);
-- this column is the match's pointer to the row it settles. NULL for every
-- document-level match (the one-to-one contract every other family keeps).
--
-- The law the index carries: a statement row is settled by exactly ONE bank
-- line. Two suggestions against one row may coexist (the matcher surfaces
-- ties, never hides them); two SETTLED matches on one row cannot. The other
-- direction — one bank line settles one row of a given document — is already
-- the table's natural key (bank_transaction_id, matched_object_type,
-- matched_object_id), unchanged.
--
-- on delete cascade: the row match lives and dies with its document line
-- (a re-parse that drops a needs_review line drops the match it carried;
-- a settled line is re-consumed by fingerprint and keeps its match).
-- ADDITIVE and dark: no writer sets the column until the RT-21c code ships.

alter table reconciliation_matches
  add column if not exists matched_line_id text references document_lines(id) on delete cascade;

create index if not exists reconciliation_matches_matched_line_idx
  on reconciliation_matches (matched_line_id)
  where matched_line_id is not null;

create unique index if not exists reconciliation_matches_settled_line_uidx
  on reconciliation_matches (matched_line_id)
  where matched_line_id is not null
    and status in ('auto_matched', 'confirmed');
