-- One canonical document per (firm, client, bytes), enforced by the database.
--
-- /documents/register collapses a byte-identical re-upload onto the canonical
-- row it reads (registerDocumentInDb, Layer 2, RT-10). The index 011 gave that
-- read was not unique, so several SIMULTANEOUS first uploads of the same bytes
-- each read "no canonical" and each inserted one: one receipt became several
-- canonical documents, each able to parse, import, match and post.
--
-- The unique index covers exactly the collapse query's own notion of a canonical
-- row. Outside it: retained receipt rows (collapsed `skipped` re-uploads and
-- superseded `failed` rows carry duplicate_of), unsuperseded `failed` rows (a
-- fresh re-upload of the same bytes must be able to become the canonical) and
-- `duplicate_pending` placeholders (the owner's open question). The writer
-- turns a lost race on this index into the ordinary collapse.
--
-- Existing data is REFUSED, never rewritten: a duplicate canonical may already
-- have parsed, matched or posted, and repointing it in SQL would leave those
-- consequences live. The runner applies each file in one transaction, so a
-- refusal leaves nothing half-built.

do $$
declare
  duplicate_groups integer;
  sample text;
begin
  select count(*), string_agg(format('firm %s / client %s / checksum %s: %s rows (%s)',
                                     firm_id, client_id, checksum_sha256, rows, ids), E'\n  ')
           filter (where rank <= 5)
    into duplicate_groups, sample
    from (
      select firm_id, client_id, checksum_sha256, count(*) as rows,
             string_agg(id, ', ' order by created_at, id) as ids,
             row_number() over (order by firm_id, client_id, checksum_sha256) as rank
        from documents
       where checksum_sha256 is not null
         and duplicate_of is null
         and parse_status not in ('duplicate_pending', 'failed')
       group by firm_id, client_id, checksum_sha256
      having count(*) > 1
    ) groups;

  if duplicate_groups > 0 then
    -- scripts/migrate_firm_db.js prints only the message, so everything the
    -- operator needs is in it.
    raise exception '%', concat_ws(E'\n',
      format('Migration 164 refused: %s (firm, client, checksum) group(s) already hold more than one canonical document. Nothing was changed.', duplicate_groups),
      format(E'First groups (ids oldest first):\n  %s', sample),
      'Find them all with: select firm_id, client_id, checksum_sha256, array_agg(id order by created_at) from documents'
        || ' where checksum_sha256 is not null and duplicate_of is null and parse_status not in (''duplicate_pending'', ''failed'')'
        || ' group by 1, 2, 3 having count(*) > 1;',
      'Repair: keep the oldest document of each group and remove the rest through the normal document delete or replace path'
        || ' (it unwinds their matches and imported lines), then re-run the migration. Do not repoint them in SQL: a duplicate'
        || ' canonical may already have parsed, matched or posted.');
  end if;
end
$$;

-- The other by-checksum readers keep a non-unique lookup over every hashed row.
do $$
begin
  if exists (select 1 from pg_indexes where schemaname = current_schema()
               and tablename = 'documents' and indexname = 'documents_firm_client_checksum_idx'
               and indexdef not like 'CREATE UNIQUE INDEX%') then
    if exists (select 1 from pg_indexes where schemaname = current_schema()
                 and tablename = 'documents' and indexname = 'documents_firm_client_checksum_lookup_idx') then
      drop index documents_firm_client_checksum_idx;
    else
      alter index documents_firm_client_checksum_idx rename to documents_firm_client_checksum_lookup_idx;
    end if;
  end if;
end
$$;

create index if not exists documents_firm_client_checksum_lookup_idx
  on documents (firm_id, client_id, checksum_sha256)
  where checksum_sha256 is not null;

-- The registerDocumentInDb unique-violation handler names this index.
create unique index if not exists documents_firm_client_checksum_idx
  on documents (firm_id, client_id, checksum_sha256)
  where checksum_sha256 is not null
    and duplicate_of is null
    and parse_status not in ('duplicate_pending', 'failed');
