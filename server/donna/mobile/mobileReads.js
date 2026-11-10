// Scoped reads the mobile projection needs where no firm route serves exactly
// one owner's rows without loading the whole firm snapshot. Every query here is
// a plain SELECT pinned to (firm_id, client_id) of an entity the caller has
// ALREADY been admitted to (mobileAuth.ownerScopeForEntity); none writes.
import { queryFirmDb } from '../firmDb.js';

export const readEntities = async ({ firmId, clientIds }) => {
  if (!clientIds.length) return [];
  const result = await queryFirmDb(
    `select c.id, c.company_name, c.entity_type, c.jurisdiction,
            c.profile->>'defaultCurrency' as profile_currency,
            f.jurisdiction as firm_jurisdiction, f.default_currency as firm_currency,
            bp.facts as business_profile_facts
       from clients c join firms f on f.id = c.firm_id
       left join client_business_profiles bp on bp.firm_id = c.firm_id and bp.client_id = c.id
      where c.firm_id = $1 and c.id = any($2::text[])
      order by c.company_name nulls last, c.id`,
    [firmId, clientIds]
  );
  return result.rows;
};

const DOCUMENT_COLUMNS = `id, firm_id, client_id, filename, document_type, uploaded_at, created_at,
  document_date, total_amount, currency, vendor_name, customer_name, parse_status, parse_stage,
  parse_progress_current, parse_progress_total, parse_error, parse_summary, parse_completed_at,
  duplicate_of, payload->>'captured_at' as captured_at`;

// Newest first; the cursor is the last row's (uploaded_at, id), opaque to the app.
export const readDocuments = async ({ firmId, clientId, limit = 30, cursor = null }) => {
  const result = await queryFirmDb(
    `select ${DOCUMENT_COLUMNS} from documents
      where firm_id = $1 and client_id = $2
        and ($4::timestamptz is null or (uploaded_at, id) < ($4::timestamptz, $5::text))
      order by uploaded_at desc, id desc limit $3`,
    [firmId, clientId, limit + 1, cursor?.uploadedAt ?? null, cursor?.id ?? null]
  );
  return result.rows;
};

export const readDocumentsById = async ({ firmId, clientId, ids }) => {
  if (!ids.length) return [];
  const result = await queryFirmDb(
    `select ${DOCUMENT_COLUMNS} from documents where firm_id = $1 and client_id = $2 and id = any($3::text[])`,
    [firmId, clientId, ids]
  );
  return result.rows;
};

// Open OWNER asks anchored on a document (request_payload.document_id — the
// anchor the ask writer persists) — what makes a document `needs_info`.
export const readOpenDocumentAsks = async ({ firmId, clientId }) => {
  const result = await queryFirmDb(
    `select id, request_payload->>'document_id' as document_id from client_evidence_requests
      where firm_id = $1 and client_id = $2 and status = 'open'
        and coalesce(audience, 'client') = 'client'
        and coalesce(request_payload->>'document_id', '') <> ''
      order by created_at`,
    [firmId, clientId]
  );
  return result.rows;
};

// The persisted close read model: period rows (lifecycle + the last checks
// run's verdict in payload.close_status) and their check rows.
export const readClosePeriods = async ({ firmId, clientId, limit = 12 }) => {
  const periods = await queryFirmDb(
    `select id, period_start::text as period_start, period_end::text as period_end, status, payload, updated_at
       from close_periods where firm_id = $1 and client_id = $2
      order by period_start desc limit $3`,
    [firmId, clientId, limit]
  );
  const ids = periods.rows.map((row) => row.id);
  const checks = ids.length
    ? await queryFirmDb(
      `select close_period_id, check_type, status, summary, payload from close_checks
        where firm_id = $1 and client_id = $2 and close_period_id = any($3::text[])
        order by check_type`,
      [firmId, clientId, ids]
    )
    : { rows: [] };
  return { periods: periods.rows, checks: checks.rows };
};

// Audit watermark + the rows a writer committed after it, for the targets a
// decision touched. These rows ARE the receipt: written by the writer in its
// own transaction, attributed to the acting principal; the adapter writes none.
export const readAuditWatermark = async ({ firmId }) => {
  const result = await queryFirmDb('select coalesce(max(id), 0)::text as id from audit_events where firm_id = $1', [firmId]);
  return result.rows[0].id;
};

export const readAuditRowsSince = async ({ firmId, clientId, watermark, resourceIds }) => {
  const result = await queryFirmDb(
    `select id::text as id, actor_type, actor_id, action, resource_type, resource_id, created_at
       from audit_events
      where firm_id = $1 and (client_id = $2 or client_id is null) and id > $3::bigint
        and (resource_id = any($4::text[]) or metadata->>'evidence_request_id' = any($4::text[]))
      order by id`,
    [firmId, clientId, watermark, resourceIds]
  );
  return result.rows;
};

// One outbound action of this entity, in the same shape the owner digest
// gathers it (party name joined), so an already-decided approval re-renders
// from its own row. Null when it is not this entity's.
export const readOutboundAction = async ({ firmId, clientId, actionId }) => {
  const result = await queryFirmDb(
    `select a.*, p.display_name as party_name
       from outbound_actions a left join client_parties p on p.id = a.target_party_id
      where a.firm_id = $1 and a.client_id = $2 and a.id = $3`,
    [firmId, clientId, actionId]
  );
  return result.rows[0] || null;
};

export const readOwnerName = async ({ firmId, principalId }) => {
  const result = await queryFirmDb('select name from firm_collaborators where firm_id = $1 and id = $2', [firmId, principalId]);
  return result.rows[0]?.name || null;
};
