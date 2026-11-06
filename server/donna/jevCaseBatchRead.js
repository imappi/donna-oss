// SQL transport for readJevCase's transaction batch. The projection remains in
// jevPreview; all rows and policy/audit dependencies share this ONE snapshot.
import pg from 'pg';
import { CANDIDATE_TX_STATUS_SQL } from './reconciliationLlmCore.js';

// Preserve PostgreSQL's scalar text before JSON transport: numeric precision,
// DATE local-calendar parsing and timestamptz Date objects must match pg.query.
const encoded = alias => `(select jsonb_object_agg(key,value) from jsonb_each_text(to_jsonb(${alias})))`;
const rows = (query, alias = 'r') => `(select coalesce(jsonb_agg(${encoded(alias)}),'[]'::jsonb) from (${query}) ${alias})`;
const txIds = `select w.id from tx_window w where w.focal_id=f.id and w.position<=64`;
const docIds = `select w.id from doc_window w where w.focal_id=f.id and w.position<=64`;
const tables = ['clients','transactions','documents','document_lines','reconciliation_matches',
  'client_evidence_requests','document_obligations','ledger_journals','ledger_accounts','audit_events'];

export const JEV_TRANSACTION_BATCH_SQL = `
with company as materialized (
  select c.*,to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') birth_created_at
    from clients c where firm_id=$1 and id=$2
), focals as materialized (
  select t.*,coalesce(transaction_date,$4::date) case_day from transactions t
    where firm_id=$1 and client_id=$2 and id=any($3::text[])
), tx_window as materialized (
  select f.id focal_id,w.* from focals f cross join lateral (
    select transactions.*,${CANDIDATE_TX_STATUS_SQL} eligible,
      row_number() over(order by (id=f.id) desc,abs(transaction_date-f.case_day),id) position
      from transactions where firm_id=$1 and client_id=$2
      order by (id=f.id) desc,abs(transaction_date-f.case_day),id limit 65
  ) w
), doc_window as materialized (
  select f.id focal_id,w.* from focals f cross join lateral (
    select d.*,row_number() over(order by exists(select 1 from reconciliation_matches m
      where m.firm_id=$1 and m.client_id=$2 and m.bank_transaction_id=f.id and m.matched_object_id=d.id) desc,
      abs(document_date-f.case_day) nulls last,id) position
    from documents d where firm_id=$1 and client_id=$2 and duplicate_of is null
    order by exists(select 1 from reconciliation_matches m where m.firm_id=$1 and m.client_id=$2
      and m.bank_transaction_id=f.id and m.matched_object_id=d.id) desc,
      abs(document_date-f.case_day) nulls last,id limit 65
  ) w
), selected_docs as materialized (
  select distinct id from doc_window where position<=64
), shared_lines as materialized (
  select l.* from document_lines l join selected_docs d on d.id=l.document_id
    where l.firm_id=$1 and l.client_id=$2 order by l.document_id,l.line_no,l.id
), lineage_audits as materialized (
  select id::text,firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata
    from audit_events where firm_id=$1 and resource_id=$2
      and action in ('client.create','client.delete','ledger.chart.palette_seeded') order by id::bigint
), last_life as (select coalesce(max(id::bigint) filter(where action='client.delete'),0) id from lineage_audits)
/* CONVERGENCE_CTE */
select
  /* CONVERGENCE_OUTPUT */
  (select ${encoded('c')} from company c) company,
  ${rows(`select * from ledger_accounts where firm_id=$1 and client_id=$2 order by id`)} accounts,
  ${rows('select * from lineage_audits order by id::bigint')} receipts,
  ${rows(`select id,firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata
    from audit_events where firm_id=$1 and client_id=$2 and id>(select id from last_life)
      and action='client.profile.update' and metadata ? 'native_registration' order by id limit 257`)} registration_revisions,
  (select ${encoded('d')} from documents d where firm_id=$1 and client_id=$2
    and id=(select profile->'gst_registration'->>'source_document_id' from company)) registration_source,
  ${rows(`select a.*,case when a.metadata->>'item_type'='transaction' and a.resource_id in (select id from focals) then a.resource_id
      else (select coalesce(nullif(q.payload->>'transaction_id',''),q.item_id) from transaction_review_queue q
        where q.firm_id=a.firm_id and q.client_id=a.client_id and q.id=a.resource_id
          and coalesce(nullif(q.item_type,''),'transaction')=a.metadata->>'item_type' and q.item_type is distinct from 'document_line'
          and (q.item_type='transaction' or nullif(q.payload->>'transaction_id','') is not null)) end as acceptance_transaction_id
    from audit_events a where a.firm_id=$1 and a.client_id=$2
    and a.id::text in (select payload->'review_scope'->'acceptance_audit'->>'id' from focals) order by a.id`)} decision_audits,
  (select count(distinct (target_type,target_id))::int from convergence_marks where firm_id=$1 and client_id=$2) pending_targets,
  -- A client-scoped mark (migration 158) means any source of this client changed
  -- since its last settle: every requested focal is pending until it is consumed.
  (select case when exists(select 1 from convergence_marks where firm_id=$1 and client_id=$2 and target_type='client')
    then to_jsonb($3::text[]) else (select coalesce(jsonb_agg(distinct target_id),'[]'::jsonb) from convergence_marks
    where firm_id=$1 and client_id=$2 and target_type='transaction' and target_id=any($3::text[])) end) pending_focals,
  ${rows('select * from shared_lines order by document_id,line_no,id')} lines,
  (select coalesce(jsonb_agg(jsonb_build_object(
    'transaction_id',f.id,'focal',${encoded('f')},
    'transactions',${rows(`select * from tx_window w where w.focal_id=f.id order by position`)},
    'documents',${rows(`select * from doc_window w where w.focal_id=f.id order by position`)},
    'matches',${rows(`select rm.*,t.currency from reconciliation_matches rm
      join transactions t on t.id=rm.bank_transaction_id and t.firm_id=rm.firm_id and t.client_id=rm.client_id
      where rm.firm_id=$1 and rm.client_id=$2 and (rm.matched_object_id in (${docIds}) or rm.bank_transaction_id in (${txIds}))
      order by rm.id limit 257`)},
    'replies',${rows(`select id,transaction_id,request_payload->>'document_id' as document_id,status,audience,evidence_type,question,
      response_payload,created_by,responded_at,resolved_by,request_payload from client_evidence_requests
      where firm_id=$1 and client_id=$2 and (transaction_id in (${txIds}) or request_payload->>'document_id' in (${docIds}))
      order by id limit 257`)},
    'obligations',${rows(`select * from document_obligations where firm_id=$1 and client_id=$2 and document_id in (${docIds}) order by id limit 257`)},
    'postings',${rows(`select id,source_id,source_type,status,correction_of_journal_id,reversal_of_journal_id from ledger_journals
      where firm_id=$1 and client_id=$2 and (source_id in (${txIds}) or source_id in (${docIds})
        or correction_of_journal_id in (select id from ledger_journals where firm_id=$1 and client_id=$2
          and (source_id in (${txIds}) or source_id in (${docIds})))) order by id limit 257`)}
  ) order by f.id),'[]'::jsonb) from focals f) focal_windows,
  (select jsonb_object_agg(relname,columns) from (
    select c.relname,jsonb_object_agg(a.attname,a.atttypid) columns
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
      where n.nspname='public' and c.relname=any($5::text[]) group by c.relname
  ) schema_types) schema_types
`;

export async function readJevTransactionBatchRows({ client, firmId, clientId, transactionIds, asOf, includeConvergence = false }) {
  const ids = [...new Set(transactionIds)];
  if (ids.length > 200) throw new RangeError('A Jev transaction batch is limited to 200 focal rows.');
  let sql = JEV_TRANSACTION_BATCH_SQL;
  if (includeConvergence) {
    const { TRANSACTION_GATHER_SQL } = await import('./reconcileConvergenceState.js');
    const gather = TRANSACTION_GATHER_SQL.replace(/\$2/g,'$3') + ' and t.client_id=$2';
    sql = sql.replace('/* CONVERGENCE_CTE */',`, convergence_rows as materialized (${gather})`)
      .replace('/* CONVERGENCE_OUTPUT */',`${rows('select * from convergence_rows')} projection_rows,`);
  }
  const { rows: result } = await client.query(sql, [firmId, clientId, ids, asOf, tables]);
  const raw = result[0];
  const decode = (table, row) => row == null ? null : Object.fromEntries(Object.entries(row)
    .filter(([key]) => !['focal_id','position','case_day'].includes(key))
    .map(([key, value]) => {
      const oid = key === 'eligible' ? 16 : ['review_items','matches','evaluations','asks','goal_report','ledger_post_refusal'].includes(key) ? 3802 : Number(raw.schema_types[table]?.[key] || 25);
      const text = value != null && [1114,1184].includes(oid) ? value.replace('T',' ') : value;
      // The current source schema's SQL array is clients.legal_names (text[]).
      // JSON transport already preserves its string/null elements and escapes;
      // feeding JSON syntax to pg's PostgreSQL-array parser would drop names.
      return [key, value == null ? null : oid === 1009 ? JSON.parse(value) : pg.types.getTypeParser(oid)(text)];
    }));
  const list = (table, values) => (values || []).map(row => decode(table, row));
  return {
    company: decode('clients', raw.company), accounts: list('ledger_accounts', raw.accounts),
    receipts: list('audit_events', raw.receipts), registrationRevisions: list('audit_events', raw.registration_revisions),
    registrationSource: decode('documents', raw.registration_source), decisionAudits: list('audit_events', raw.decision_audits),
    pendingTargets: raw.pending_targets, pendingFocals: raw.pending_focals,
    lines: list('document_lines', raw.lines), projectionRows: list('transactions', raw.projection_rows),
    windows: raw.focal_windows.map(w => ({ transactionId: w.transaction_id, focal: decode('transactions',w.focal),
      transactions: list('transactions',w.transactions), documents: list('documents',w.documents),
      matches: list('reconciliation_matches',w.matches), replies: list('client_evidence_requests',w.replies),
      obligations: list('document_obligations',w.obligations), postings: list('ledger_journals',w.postings) }))
  };
}
