-- Document corrections — Slice C of the trust-the-strong-LLM strategy
-- (see CLAUDE.md + docs/donna-llm-trust-strategy.md).
--
-- The strategy has two halves: (1) give a strong LLM the document +
-- the firm's context + the schema, render what it says; (2) make
-- humans correct it cheaply and treat the correction as the source
-- of truth + a training signal. Slices A/B/E shipped half (1). This
-- table is the spine of half (2): every time a bookkeeper changes a
-- rendered field on a parsed document, we record what was there
-- before, what they corrected it to, and when. The recorded row
-- feeds two consumers:
--
--   - Few-shot context for the next parse of a SIMILAR document for
--     the same firm — the unified extractor's prompt grows a
--     "previously corrected on this firm" section that biases the
--     model toward the firm's actual conventions.
--   - Source of truth on a RE-PARSE of the SAME document (e.g.
--     after a model bump). The re-parse merge prefers the human's
--     correction over the fresh extraction; a diff surface lets the
--     bookkeeper re-decide field-by-field.
--
-- field_path uses dotted notation so the same table can carry
-- header-level columns ("vendor_name") and nested paths
-- ("header.payment_status", "lines[0].amount") without a schema
-- bump when line-level inline-edit lands in a follow-up. The
-- allowlist of accepted paths lives in code (documentCorrections.js)
-- so the DB stays permissive while the API enforces what each PR
-- considers stable.
--
-- prior_value / corrected_value are jsonb so a string column and a
-- number column round-trip through the same row without coercion.
-- The few-shot builder and the re-parse merge both read jsonb back
-- out preserving type.
--
-- (firm_id, document_id, field_path, corrected_at) is the natural
-- key but corrections are append-only (every blur on the same
-- field grows the history rather than overwriting), so we hash a
-- random suffix into id and rely on `corrected_at desc` for "most
-- recent value wins" reads.

-- Defensive prelude: a rare interrupted prior run of this migration
-- (Postgres DDL is normally transactional, but a process kill mid-
-- statement or a connection drop after DDL commit but before the
-- schema_migrations insert can leave inconsistent system-catalog
-- state) can leave an orphaned row type in pg_type with the same
-- name as the (uncreated) table. CREATE TABLE IF NOT EXISTS below
-- checks for the relation only, NOT the type, and so blows up with
-- `duplicate key value violates unique constraint
-- "pg_type_typname_nsp_index"`. Drop the orphan only when the
-- table truly doesn't exist; the no-op path is correct for both
-- fresh DBs and DBs where a previous successful create left both
-- the type and the relation in sync.
do $$
begin
  if exists (select 1 from pg_type where typname = 'document_corrections')
     and not exists (
       select 1 from pg_class
        where relname = 'document_corrections'
          and relkind = 'r'
     )
  then
    drop type document_corrections;
  end if;
end $$;

create table if not exists document_corrections (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text references clients(id) on delete set null,
  document_id text not null references documents(id) on delete cascade,
  field_path text not null,
  prior_value jsonb,
  corrected_value jsonb,
  source text not null default 'manual' check (source in ('manual', 'auto')),
  corrected_by text,
  document_type text,
  corrected_at timestamptz not null default now()
);

-- Per-document history: artifact panel reads the most-recent
-- correction per field_path to render edit history badges. Ordered
-- DESC on corrected_at so the "latest correction wins" read needs
-- no SORT.
create index if not exists document_corrections_doc_idx
  on document_corrections(firm_id, document_id, field_path, corrected_at desc);

-- Recent-firm scan for few-shot. The unified extractor's prompt
-- builder pulls the N most-recent corrections for the firm to bias
-- the model — usually capped at 20 so the prompt stays compact.
create index if not exists document_corrections_firm_recent_idx
  on document_corrections(firm_id, corrected_at desc);
