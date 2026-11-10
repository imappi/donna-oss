-- 186 — Documents that rest stalled only because a model provider had no key
-- are read again, once, without a new upload.
--
-- Before this release a parse whose extractor reported that the installation
-- had no provider key (or whose provider refused the key) spent the document's four automatic attempts on that
-- fact and rested `failed` (retry_exhausted, retry_owner 'manual'); a scanned
-- bank statement read without a cloud OCR key rested `skipped /
-- no_transactions_detected`, which reads as a fact about the statement. From
-- this release such a failure is a provider wait (parseErrors.providerWaitFor):
-- the row stays `pending` with its typed `payload.parse_hold`, no attempt is
-- spent, and it is read once the provider answers. This migration gives the
-- rows the old code already rested the same treatment, exactly as the manual
-- retry writer would (parseDocumentsDb.__retryParseRunsWithClient): a NEW
-- parse run, a fresh attempt budget, the failure cleared, an audit row per
-- document. `parse_event_sent_at` is left null, so the outbox (both hosts,
-- every minute) gives each run its job or its event — the one producer path.
-- On the appliance the superseded run's dead parse job is settled `cancelled`
-- (below), or Host A would keep refusing the new run's claim.
--
-- Selected, narrowly, by the stored receipt — never by a label:
--   (a) `failed` rows whose parse_error.reason is a missing-key reason
--       (`openai_not_configured`, `no_provider_key`, `no_api_key`,
--       `api_key_missing`), or whose code says the provider refused the key
--       (`DOCUMENT_EXTRACTION_UNAUTHORIZED`), or that spent all four
--       attempts on 429s (`<provider>_429` + retry_exhausted): an empty
--       account was stored exactly like a rate limit, and one more read of a
--       rate-limited document costs one request. Not re-admitted: an
--       unreachable-provider failure (`network_error`), which storage alone
--       cannot tell apart from a request the document itself breaks.
--   (b) `skipped` bank statements whose summary says the router ran without
--       an OpenAI key (`classification.reason = 'api_key_missing'`), nothing
--       was read (`extraction_status = 'failed'`, no transactions, the "No
--       readable text layer" warning) and no bank line exists for them.
-- Both exclude superseded rows (duplicate_of) and any row whose bytes already
-- have another live canonical document (migration 164's unique index).
-- If the key is still missing when the run starts, the row waits on its
-- provider hold, now visibly and without spending attempts.

with eligible as (
  select d.id, d.firm_id, d.client_id, d.checksum_sha256, d.created_at,
         d.parse_status as previous_status, d.parse_run_id as previous_run_id
    from documents d
   where d.duplicate_of is null
     and d.parse_run_id is not null
     and (
       (d.parse_status = 'failed'
         and (d.parse_error->>'reason' in ('openai_not_configured', 'no_provider_key', 'no_api_key', 'api_key_missing')
           or d.parse_error->>'code' = 'DOCUMENT_EXTRACTION_UNAUTHORIZED'
           or (d.parse_error->>'reason' ~ '^[a-z_]+_429$' and d.parse_error ? 'retry_exhausted')))
       or (d.parse_status = 'skipped'
         and d.document_type = 'bank_statement'
         and d.parse_summary->>'reason' = 'no_transactions_detected'
         and d.parse_summary->>'extraction_status' = 'failed'
         and d.parse_summary->'classification'->>'reason' = 'api_key_missing'
         and coalesce(d.parse_summary->'warnings', '[]'::jsonb) ? 'No readable text layer was detected in the uploaded statement.'
         and not exists (select 1 from transactions t where t.firm_id = d.firm_id and t.document_id = d.id))
     )
     and (d.checksum_sha256 is null or not exists (
       select 1 from documents other
        where other.firm_id = d.firm_id and other.client_id = d.client_id
          and other.checksum_sha256 = d.checksum_sha256 and other.id <> d.id
          and other.duplicate_of is null
          and other.parse_status not in ('duplicate_pending', 'failed')))
),
-- Two stalled uploads of the same bytes: only the oldest becomes the canonical
-- again (the index admits one); the other stays as it was.
candidates as (
  select * from eligible e
   where e.checksum_sha256 is null
      or e.id = (select e2.id from eligible e2
                  where e2.firm_id = e.firm_id and e2.client_id = e.client_id
                    and e2.checksum_sha256 = e.checksum_sha256
                  order by e2.created_at, e2.id limit 1)
),
readmitted as (
  update documents d
     set parse_status = 'pending',
         parse_run_id = gen_random_uuid(),
         parse_attempts = 0,
         parse_stage = null,
         parse_progress_current = null,
         parse_progress_total = null,
         parse_error = null,
         parse_enqueued_at = now(),
         parse_event_sent_at = null,
         parse_started_at = null,
         parse_heartbeat_at = null,
         parse_completed_at = null,
         updated_at = now()
    from candidates c
   where d.firm_id = c.firm_id and d.id = c.id
  returning d.id, d.firm_id, d.client_id, d.parse_run_id, c.previous_status, c.previous_run_id
),
-- The superseded run's dead `parse-document` job (the appliance's queue): the
-- document's work now belongs to the new run, so the dead job is settled
-- `cancelled`, visibly, its last_error kept and its id named in the audit.
-- Left dead it would keep Host A at work_queue_needs_recovery, which refuses
-- the new run's own claim — the re-admission could never finish.
cancelled as (
  update local_jobs j
     set status = 'cancelled', cancelled_at = now()
    from readmitted r
   where j.function_id = 'parse-document'
     and j.status = 'dead'
     and j.payload->>'firm_id' = r.firm_id
     and j.payload->>'document_id' = r.id
  returning j.id, r.firm_id, r.id as document_id
)
insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
select r.firm_id, r.client_id, 'system', 'migration_186', 'document.parse.retry', 'document', r.id,
       jsonb_build_object(
         'parse_run_id', r.parse_run_id,
         'previous_status', r.previous_status,
         'previous_run_id', r.previous_run_id,
         'source', 'provider_wait_readmission',
         'cancelled_dead_job_ids', coalesce((select jsonb_agg(c.id order by c.id) from cancelled c
                                              where c.firm_id = r.firm_id and c.document_id = r.id), '[]'::jsonb)
       )
  from readmitted r;
