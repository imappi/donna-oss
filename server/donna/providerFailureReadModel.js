// Read the existing failure receipts, never a second recovery or accounting state.
// One statement gives the operator a consistent client-scoped view of all lanes.
import { queryFirmDb } from './db/pool.js';

export const PROVIDER_FAILURE_SURFACE_SQL = `
  with ask_requests as (
    select id, status, attempts, created_at, last_error,
           coalesce(last_error #> '{details,provider_failure}',
                    last_error #> '{previous_error,details,provider_failure}') as receipt
      from loop_event_outbox
     where firm_id = $1 and client_id = $2 and event_type = 'ask_draft.requested'
  ), latest_request as (
    select * from ask_requests order by created_at desc, id desc limit 1
  ), latest_failure as (
    select * from ask_requests where receipt is not null
     order by created_at desc, id desc limit 1
  )
  select id, 'matching' as lane, filename as label,
         payload->'reconciliation_provider_failure' as receipt,
         'awaiting_retry' as recovery_status, null::text as recovery_request_id,
         null::text as queue_status, null::integer as queue_attempts,
         null::text as failure_at, null::text as recovery_error_code
    from documents
   where firm_id = $1 and client_id = $2
     and jsonb_typeof(payload->'reconciliation_provider_failure') = 'object'
  union all
  select id, 'extraction', filename,
         parse_error || jsonb_build_object('owner', 'operator', 'retryable', false),
         'awaiting_retry', null, null, null, parse_error->>'occurred_at', null
    from documents
   where firm_id = $1 and client_id = $2 and parse_status = 'failed'
     and parse_error->>'code' = 'DOCUMENT_SPEND_LIMIT'
  union all
  select id, 'coding', description, payload->'coding_provider_failure',
         'awaiting_retry', null, null, null, null, null
    from transactions
   where firm_id = $1 and client_id = $2
     and jsonb_typeof(payload->'coding_provider_failure') = 'object'
  union all
  select f.id, 'ask_draft', null, f.receipt,
         case when r.id <> f.id and r.status in ('failed', 'cancelled') then 'recovery_failed'
              else case r.status when 'dispatching' then 'retry_in_progress'
                       when 'pending' then 'retry_pending'
                       when 'cancelled' then 'recovery_wait'
                       else 'awaiting_retry' end end,
         r.id, r.status, r.attempts,
         coalesce(f.last_error #>> '{previous_error,at}', f.last_error->>'at', f.created_at::text),
         case when r.id <> f.id then coalesce(r.last_error #>> '{previous_error,code}', r.last_error->>'code') end
    from latest_failure f cross join latest_request r
   where r.status in ('pending', 'dispatching', 'failed', 'cancelled')
     and not exists (
       select 1 from client_ask_batches b
        where b.firm_id = $1 and b.client_id = $2
          and b.created_at > coalesce(nullif(f.last_error #>> '{previous_error,at}', '')::timestamptz,
                                     nullif(f.last_error->>'at', '')::timestamptz, f.created_at)
     )
  order by lane, id
`;

const machineValue = (value) => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value) ? value : null;
const timestamp = (value) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

export const readProviderFailuresWithClient = async ({ client, firmId, clientId } = {}) => {
  if (!client || !firmId || !clientId) throw new Error('Provider failure reads require firm and client identity.');
  const { rows } = await client.query(PROVIDER_FAILURE_SURFACE_SQL, [firmId, clientId]);
  return rows.map((row) => {
    const receipt = row.receipt || {};
    return {
      id: `${row.lane}:${row.id}`, source_id: row.id, client_id: clientId,
      lane: row.lane, label: row.label || null,
      code: machineValue(receipt.code), provider: machineValue(receipt.provider),
      status: Number(receipt.status) || null, reason: machineValue(receipt.reason),
      owner: receipt.owner === 'operator' ? 'operator' : 'queue',
      retryable: receipt.retryable !== false,
      attempts: Number(receipt.attempts) || null,
      // 0 is a real count (no request was made), never "no failure".
      request_attempts: receipt.request_attempts === 0 ? 0 : Number(receipt.request_attempts) || Number(receipt.attempts) || null,
      last_failed_at: timestamp(receipt.last_failed_at || row.failure_at),
      recovery_status: row.recovery_status, recovery_request_id: row.recovery_request_id,
      recovery_error_code: machineValue(row.recovery_error_code),
      queue_status: row.queue_status, queue_attempts: row.queue_attempts
    };
  });
};

export const getProviderFailuresFromDb = (args) => readProviderFailuresWithClient({
  ...args, client: { query: queryFirmDb }
});
