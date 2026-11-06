// Read-only evidence preparation shared by the preview and automatic Jev lane.
// This module prepares facts; the execution adapter owns writer authority.
import { prepareEvidencePacketFromEligibility, VERSION, hash } from './jevEvidenceContract.js';
import { CANDIDATE_TX_STATUS_SQL, SUPPRESSION_STATUSES } from './reconciliationLlmCore.js';
import { remainingMinor } from './jevDirectAction.js';
import { toIsoDay, toUtcIsoDay } from './dates.js';
import { localEvidenceCandidatesByTransaction } from './localEvidenceInventory.js';
import { callJevDirect } from './jevProvider.js';

const TYPES = { sales_invoice: 'sales_invoice', issued_receipt: 'sales_invoice', supplier_bill: 'supplier_bill', receipt: 'supplier_bill', payment_confirmation: 'supplier_bill', payment_account_statement: 'supplier_bill', payout_statement: 'sales_invoice', deposit_slip: 'sales_invoice' };
const fail = (code, message, statusCode = 422) => { throw Object.assign(new Error(message), { code, statusCode }); };
const minor = value => {
  const n = Number(value || 0), rounded = Math.round(n * 100);
  if (!Number.isFinite(n) || n < 0 || !Number.isSafeInteger(rounded) || Math.abs(n * 100 - rounded) > 0.00001) fail('unsupported_amount', 'This preview supports positive amounts with two decimal places.');
  return rounded;
};
const documentLabel = d => ({ id: d.id, filename: d.filename, document_type: d.document_type,
  counterparty: d.customer_name || d.vendor_name, total_amount: Number(d.total_amount), currency: d.currency,
  date: toIsoDay(d.document_date), payment_status: d.payment_status });

// Keep extracted accounting fields; prior router/coder verdicts are not evidence
// for a new independent decision and needlessly repeat large runtime receipts.
const OPERATIONAL_SUMMARY_KEYS = new Set(['router', 'source', 'extractor', 'decision_lineage', 'validation_outcomes',
  'classification', 'confidence_envelope', 'extraction_confidence', 'document_type_guess', 'coded_line_count',
  'review_line_count', 'line_count', 'extraction_status', 'jev_exception', 'totals_reread', 'lane',
  'owner_ask_id', 'owner_asked_at']);
// Partial reads retain their extracted facts and failure qualification. Run identity
// and persistence time belong to the stored audit record, not semantic source evidence.
const PARTIAL_HEADER_OPERATIONAL_KEYS = new Set(['parse_run_id', 'persisted_at']);
export const evidenceSummary = summary => summary && typeof summary === 'object' && !Array.isArray(summary)
  ? Object.fromEntries(Object.entries(summary).filter(([key]) => !OPERATIONAL_SUMMARY_KEYS.has(key)).map(([key, value]) => [key,
    key === 'partial_header' && value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).filter(([field]) => !PARTIAL_HEADER_OPERATIONAL_KEYS.has(field))) : value])) : summary;

// A source record needs a date with stated meaning. An issue date is used as
// printed. A financing notice or instalment schedule may print only its due
// date: that is the obligation date, carried with its basis so the decision
// never reads it as an issue date. Nothing is inferred when neither exists.
export const sourceRecordDate = d => {
  const issued = toIsoDay(d?.document_date);
  if (issued) return { date: issued };
  const due = toIsoDay(d?.due_date);
  return due ? { date: due, date_basis: 'due_date' } : null;
};

export function prepareJevPreview({ firmId, clientId, document, documents = [], transactions = [], matches = [], asOf, limits = {} }) {
  if (!document || document.firm_id !== firmId || document.client_id !== clientId) fail('document_not_found', 'Document not found in this company.', 404);
  if (!TYPES[document.document_type] || document.parse_status !== 'completed' || Number(document.total_amount) <= 0 || document.duplicate_of) fail('unsupported_document', 'Choose a parsed invoice, bill or receipt with a positive amount.');
  if (!sourceRecordDate(document) || !document.currency) fail('incomplete_document', 'The document needs an issue or due date and a currency before this preview can run.');
  // The research contract currently assumes two-decimal currencies. Do not turn
  // JPY/KWD (etc.) into fictitious two-decimal amounts at this boundary.
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency: document.currency }).resolvedOptions().maximumFractionDigits;
  if (digits !== 2) fail('unsupported_currency', 'This preview currently supports currencies with two decimal places.');
  const scope = { firm_id: firmId, client_id: clientId, generation: 'live-reconciliation-case' };
  const sources = [], clipped = [];
  const source = (id, kind, content, label) => {
    const full = JSON.stringify(content), version = hash(full);
    if (full.length > 12000) clipped.push(id);
    sources.push({ ...scope, id, kind, content: full.slice(0, 12000), version, current_version: version, provenance: 'source_observation', label });
    return id;
  };
  const invoiceRow = d => ({ id: d.id, source_id: source(`document:${d.id}`, TYPES[d.document_type] || d.document_type || 'document',
    { filename: d.filename, document_type: d.document_type, date: toIsoDay(d.document_date), due_date: toIsoDay(d.due_date),
      vendor_name: d.vendor_name, customer_name: d.customer_name, total_amount: d.total_amount, currency: d.currency,
      reference_number: d.reference_number, structured_reference: d.structured_reference, parse_status: d.parse_status, parse_summary: evidenceSummary(d.parse_summary) }, d.filename || d.id),
    document_type: TYPES[d.document_type], ...sourceRecordDate(d), due_date: toIsoDay(d.due_date) || null,
    amount_minor: minor(d.total_amount), minor_unit: 2, currency: d.currency, reference: d.reference_number || d.structured_reference || null,
    counterparty: d.customer_name || d.vendor_name || null });
  const invoice = invoiceRow(document);
  const related = [];
  for (const d of documents.filter(d => d.id !== document.id)) {
    if (d.firm_id !== firmId || d.client_id !== clientId) fail('foreign_evidence', 'Evidence scope mismatch.');
    if (TYPES[d.document_type] && sourceRecordDate(d) && Number(d.total_amount) > 0 && d.currency) related.push(invoiceRow(d));
    else source(`document:${d.id}`, d.document_type || 'document', { filename: d.filename, parse_status: d.parse_status, parse_summary: evidenceSummary(d.parse_summary) }, d.filename || d.id);
  }
  const txs = transactions.map(t => {
    if (t.firm_id !== firmId || t.client_id !== clientId) fail('foreign_evidence', 'Evidence scope mismatch.');
    return { id: t.id, source_id: source(`transaction:${t.id}`, 'bank_transaction', { date: toIsoDay(t.transaction_date), description: t.description,
      raw_description: t.raw_description, structured_reference: t.structured_reference, money_in: t.money_in, money_out: t.money_out, currency: t.currency }, t.description || t.id),
      date: toIsoDay(t.transaction_date), money_in_minor: minor(t.money_in), money_out_minor: minor(t.money_out), currency: t.currency,
      description: t.description || t.raw_description || '', contact: t.payload?.contact || null,
      ...(t.payload?.payment_instrument ? {instrument:t.payload.payment_instrument} : {}),
      lifecycle: t.reconciliation_status || 'unreconciled' };
  });
  const allocations = matches.map(m => {
    if (m.firm_id !== firmId || m.client_id !== clientId) fail('foreign_evidence', 'Evidence scope mismatch.');
    // Existing FX matches record bank-currency match_amount, not invoice allocation.
    // Refuse unknown conversion instead of silently subtracting the wrong currency.
    if (m.matched_object_id === document.id && m.status !== 'rejected' && m.currency !== document.currency) fail('existing_fx_allocation', 'This document has an existing foreign-currency settlement whose invoice allocation is not available to the preview.');
    const sid = source(`allocation:${m.id}`, 'allocation_record', {
      status: m.status, match_amount: m.match_amount, currency: m.currency,
      document: m.matched_object_id === document.id ? 'invoice_1' : 'another_document',
      candidate: transactions.findIndex(t => t.id === m.bank_transaction_id) >= 0
        ? `candidate_${[...transactions].sort((a, b) => a.id.localeCompare(b.id)).findIndex(t => t.id === m.bank_transaction_id) + 1}` : 'outside_preview'
    }, `Existing ${m.status} match`);
    return { ...scope, id: m.id, source_id: sid, version: sources.at(-1).version, transaction_id: m.bank_transaction_id,
      invoice_id: m.matched_object_id, object_type: TYPES[m.matched_object_type] || m.matched_object_type, amount_minor: minor(m.match_amount), currency: m.currency || document.currency, status: m.status };
  });
  const ids = sources.map(s => s.id), scopeId = `company:${clientId}:document:${document.id}`;
  const packet = { version: VERSION, id: scopeId, scope, as_of: asOf, invoice, related_invoices: related, transactions: txs, sources, allocations, links: [], missing_fact: null,
    work_item: { id: scopeId, kind: 'settle_invoice', target_id: document.id, admission: 'admitted', reason: 'Determine settlement of this persisted document from the supplied company evidence.', basis_source_ids: [invoice.source_id] },
    retrieval: { status: 'truncated', method: 'bounded_discovery', scope_id: scopeId, description: 'Bounded persisted company records; raw uploaded files and owner-only facts are not read.', required_source_ids: ids, covered_source_ids: ids },
    collision: { id: scopeId, scope_id: scopeId, status: 'truncated', transaction_ids: txs.map(t => t.id), invoice_ids: [invoice.id, ...related.map(i => i.id)] } };
  // Preserve the production pair suppression after the shared transaction
  // lifecycle query: a rejected invoice/payment pair must not be proposed again.
  const suppressed = new Set(allocations.filter(a => a.invoice_id === invoice.id
    && a.object_type === invoice.document_type && SUPPRESSION_STATUSES.has(a.status)).map(a => a.transaction_id));
  const prepared = prepareEvidencePacketFromEligibility(packet, transactions.filter(t => t.eligible && !suppressed.has(t.id)).map(t => t.id));
  if (prepared.error) fail(prepared.error, `This material cannot yet be represented by the Jev preview (${prepared.error}).`);
  if (remainingMinor(prepared) <= 0) fail('already_settled', 'This document is already fully settled by existing matches. Choose an unpaid document to try Jev.');
  return { prepared, document: documentLabel(document), limits: { ...limits, bounded_inventory: true, absence_proven: false, raw_files_read: false,
    unparsed_documents: documents.filter(d => d.parse_status !== 'completed').length, clipped_sources: clipped,
    document_type_mapping: TYPES[document.document_type] === document.document_type ? null : `${document.document_type} → ${TYPES[document.document_type]}` } };
}

// One persisted evidence inventory, with thin projections for matching, coding
// and disposition. Operational receipts are deliberately not source revisions.
const sourceFields = (row, fields) => Object.fromEntries(fields.map(k => [k, row[k] ?? null]));
const presentFields = (row, fields) => Object.fromEntries(fields.filter(k => row?.[k] != null).map(k => [k,row[k]]));
// Persisted relationships are evidence; the model's earlier reasoning, authority
// envelope and recursively captured case are not new source observations.
export function matchRelationshipEvidence(payload = {}) {
  payload ||= {};
  const result = {};
  if (payload.settlement_row) result.settlement_row = presentFields(payload.settlement_row,['line_id','line_no','net','description']);
  if (payload.cross_entity) result.cross_entity = presentFields(payload.cross_entity,['detected','own_side','reason']);
  if (payload.reminder_obligation) result.reminder_obligation = presentFields(payload.reminder_obligation,
    ['status','invoice_document_id','reminder_document_id','bank_transaction_id','settlement_match_id','currency','references','invoice_date','reminder_date','principal_amount','principal_tax','charges_amount']);
  if (payload.authorization?.credit_notes) {
    const credits=payload.authorization.credit_notes;
    result.credit_notes={applied:(credits.applied||[]).map(c=>presentFields(c,['credit_document_id','amount','linkage'])),
      ...presentFields(credits,['applied_total'])};
  }
  if (payload.authorization?.refund_group || payload.refund_group) result.refund_group = presentFields(payload.refund_group || payload.authorization.refund_group,
    ['status','document_id','transaction_ids','purchase_transaction_id','duplicate_transaction_id','refund_transaction_id','amount','currency','allocation_basis']);
  return result;
}
const documentFields = ['id','firm_id','client_id','filename','document_type','parse_status','duplicate_of',
  'document_date','due_date','total_amount','tax_amount','currency','vendor_name','customer_name',
  'reference_number','structured_reference','payment_status'];
const bankFields = ['id','firm_id','client_id','document_id','transaction_date','description','raw_description',
  'structured_reference','money_in','money_out','currency','bank_account_id'];
export const projectJevBankSource = t => ({...sourceFields(t,bankFields),instrument:t.payload?.payment_instrument||null,
      payment_method:t.payload?.payment_method||null,message:t.payload?.message||null,
      reference:t.payload?.reference||null,counterparty:t.payload?.counterparty||null,
      ...(t.payload?.jev_refund_group ? {refund_group:t.payload.jev_refund_group} : {})});
const extractedLine = l => ({ id: l.id, document_id: l.document_id, line_no: l.line_no,
  description: l.description || '', amount: l.amount == null ? null : Number(l.amount),
  tax_rate: l.tax_rate == null ? null : Number(l.tax_rate),
  raw_extraction: l.payload?.raw_extraction || {},
  tax_amount: l.payload?.raw_extraction?.tax_amount ?? null,
  amount_kind: l.payload?.raw_extraction?.amount_kind ?? null,
  settlement_row: l.payload?.raw_extraction?.settlement_row || null });

// A request is workflow history, not an answer. Preserve the content while
// distinguishing actual attributed replies from unanswered machine questions.
export function caseReplyProvenance(row) {
  const response=row.response_payload || {};
  const hasAnswer=Boolean(String(response.reply || '').trim() || response.document_ids?.length);
  if (!hasAnswer) return 'unanswered_question';
  const actor=response.reply_processing?.actor_id || response.answer_recorded_by || (row.responded_at && row.resolved_by);
  return row.audience==='client' && ['replied','resolved'].includes(row.status) && actor && actor!=='system'
    ? 'attributable_owner_reply' : 'unverified_reply';
}

export function projectMatchedDocument(evidence, transactionId) {
  const rank = {confirmed:0,auto_matched:1,suggested:2};
  const m = evidence.matches.filter(m => m.bank_transaction_id === transactionId && rank[m.status] != null)
    .sort((a,b) => rank[a.status]-rank[b.status] || a.id.localeCompare(b.id))[0];
  const d = evidence.documents.find(d => d.id === m?.matched_object_id);
  return d ? { document_id: d.id, document_type:d.document_type, ...(d.source_family ? {source_family:d.source_family} : {}), filename:d.filename || '',
    vendor_name:d.vendor_name, customer_name:d.customer_name, document_date:toIsoDay(d.document_date),
    currency:d.currency, total_amount:d.total_amount == null ? null : Number(d.total_amount),
    tax_amount:d.tax_amount == null ? null : Number(d.tax_amount), parse_summary:d.parse_summary,
    match_status:m.status, matched_at:m.created_at || null, matched_line_id:m.matched_line_id || null,
    matched_line:d.lines.find(l => l.id === m.matched_line_id) || null, lines:d.lines } : null;
}

// The coder sees the matched source twice: as matched_document (line_N) and in
// case_evidence (document_K_line_N). Both name the same persisted line, so the
// saved allocation uses the matched-document handle the allocation writer
// binds. A handle on any other document is left untouched and the writer
// refuses it: a candidate document never becomes posting authority.
export function matchedAllocationHandles(evidence, matchedDocument, allocations) {
  if (!Array.isArray(allocations) || !matchedDocument?.document_id) return allocations;
  const index = evidence.documents.findIndex(d => d.id === matchedDocument.document_id);
  if (index < 0) return allocations;
  const prefix = `document_${index + 1}_line_`;
  return allocations.map(item => {
    const handle = typeof item?.line_handle === 'string' ? item.line_handle : '';
    return handle.startsWith(prefix) && /^[1-9]\d*$/.test(handle.slice(prefix.length))
      ? { ...item, line_handle: `line_${handle.slice(prefix.length)}` } : item;
  });
}

export function jevCasePrompt(evidence, {bankHandles = null} = {}) {
  // Opaque identities stay on the trusted side of the boundary. All references
  // in source prose and structured relationships share the same call-local map.
  const handles = new Map();
  for (const [kind, rows] of Object.entries({ document:evidence.documents, candidate:evidence.transactions,
    match:evidence.matches, reply:evidence.owner_replies, obligation:evidence.obligations, posting:evidence.postings }))
    rows.forEach((r,i) => { if(r.id) handles.set(r.id, kind === 'candidate' && bankHandles?.[r.id] || `${kind}_${i+1}`); });
  evidence.documents.forEach(d => d.lines.forEach((l,i) => handles.set(l.id, `${handles.get(d.id)}_line_${i+1}`)));
  handles.set(evidence.scope.firm_id,'current_firm'); handles.set(evidence.scope.client_id,'current_company');
  const ordered = [...handles].filter(([id])=>typeof id==='string' && id.length>=8).sort((a,b)=>b[0].length-a[0].length);
  const project = value => {
    if (typeof value==='string') {
      if(handles.has(value))return handles.get(value);
      for(const [id,handle] of ordered)value=value.split(id).join(handle);
      return value;
    }
    if(Array.isArray(value))return value.map(project);
    if(value instanceof Date)return toIsoDay(value);
    return value && typeof value==='object' ? Object.fromEntries(Object.entries(value).map(([k,v])=>[k,project(v)])) : value;
  };
  const projected=project(evidence);
  // Compact only duplicate representations, never the candidate universe or
  // source annotations. The full canonical packet still guards apply freshness.
  for (const d of projected.documents) {
    delete d.firm_id; delete d.client_id;
    delete d.relationship_status; // Identical document/bank/status facts live in matches.
    const summary=d.parse_summary;
    if(summary && typeof summary==='object') {
      for(const key of Object.keys(summary)) if(key in d && JSON.stringify(summary[key])===JSON.stringify(d[key])) delete summary[key];
      for(const key of ['total_amount','tax_amount']) if(summary[key]!=null && d[key]!=null && Number(summary[key])===Number(d[key])) delete summary[key];
      for(const [key,field] of Object.entries({date_candidates:'document_date',amount_candidates:'total_amount',vendor_candidates:'vendor_name',customer_candidates:'customer_name'})) {
        const candidates=summary[key];
        if(candidates?.length===1 && (String(candidates[0]?.value)===String(d[field])
          || field==='total_amount' && candidates[0]?.value!=null && d[field]!=null && Number(candidates[0].value)===Number(d[field]))) delete summary[key];
      }
      delete summary.prompt_version;
      if(summary.currency_resolution?.currency===d.currency && (!summary.currency_resolution.candidate || summary.currency_resolution.candidate===d.currency)) delete summary.currency_resolution;
      if(summary.totals_validation?.matches===true) {
        const validation=summary.totals_validation;
        for(const [key,sourceValue] of Object.entries({tax:d.tax_amount,total:d.total_amount,expected:d.total_amount,
          subtotal:summary.subtotal_amount,discount:summary.discount_amount,rounding:summary.rounding_amount,shipping:summary.shipping_amount}))
          if(validation[key]!=null && sourceValue!=null && Number(validation[key])===Number(sourceValue))delete validation[key];
      }
      const settlementRows=d.lines.filter(l=>l.settlement_row).map(l=>l.settlement_row);
      if(summary.settlement?.rows?.length && JSON.stringify(summary.settlement.rows)===JSON.stringify(settlementRows))delete summary.settlement.rows;
    }
    for(const line of d.lines) {
      delete line.document_id;
      for(const key of Object.keys(line.raw_extraction||{})) if(key in line && JSON.stringify(line.raw_extraction[key])===JSON.stringify(line[key])) delete line.raw_extraction[key];
    }
  }
  for(const t of projected.transactions) {delete t.firm_id;delete t.client_id;if(t.raw_description===t.description)delete t.raw_description;}
  // Null and empty containers add no supplied source values. State that meaning
  // explicitly; never collapse false/zero or remove the inventory arrays.
  const compact = value => {
    if(Array.isArray(value))return value.map(compact);
    if(!value || typeof value!=='object')return value;
    return Object.fromEntries(Object.entries(value).flatMap(([key,raw])=>{
      const v=compact(raw);
      return v==null || typeof v==='object' && Object.keys(v).length===0 ? [] : [[key,v]];
    }));
  };
  const result=compact(projected);
  for(const key of ['documents','transactions','matches','owner_replies','obligations','postings'])result[key] ||= [];
  // Readiness consumers use these arrays even when no sources are outstanding.
  result.coverage={...result.coverage,unread_sources:projected.coverage?.unread_sources||[],omitted_source_ids:projected.coverage?.omitted_source_ids||[]};
  result.representation='Omitted nullable fields are unknown. Omitted empty containers contain no supplied values. Zero and false are retained. Repeated fields are represented once; settlement rows are in document lines.';
  return result;
}

export function projectJevCaseRows({ firmId, clientId, transactionId = null, documentId = null,
  focal = null, company, transactions, documents, lines, matches, replies, obligations, postings }) {
  const selectedTransactions = transactions.slice(0,64), selectedDocuments = documents.slice(0,64);
  const evidence = {version:'jev-case-v2',scope:{firm_id:firmId,client_id:clientId},company,
    focal:{kind:transactionId?'bank_transaction':documentId?'document':'company',id:transactionId||documentId||clientId},
    documents:selectedDocuments.map(d => ({...sourceFields(d,documentFields),...((d.parse_summary?.classification?.family || d.parse_summary?.router?.family) ? {source_family:d.parse_summary?.classification?.family || d.parse_summary?.router?.family} : {}),parse_summary:evidenceSummary(d.parse_summary),
      lines:lines.filter(l=>l.document_id===d.id),relationship_status:matches.filter(m=>m.matched_object_id===d.id).map(m=>({transaction_id:m.bank_transaction_id,status:m.status}))})),
    transactions:selectedTransactions.map(projectJevBankSource),
    matches:matches.slice(0,256).map(m=>({...sourceFields(m,['id','bank_transaction_id','matched_object_id','matched_object_type','matched_line_id','status','match_amount','currency']),payload:matchRelationshipEvidence(m.payload)})),
    owner_replies:replies.slice(0,256).map(r=>({...r,provenance:caseReplyProvenance(r),request_payload:undefined})),
    obligations:obligations.slice(0,256).map(o=>({...o,created_at:undefined,updated_at:undefined})),postings:postings.slice(0,256),
    coverage:{status:transactions.length>64||documents.length>64||matches.length>256||replies.length>256||obligations.length>256||postings.length>256?'truncated':'complete_within_scope',
      raw_files_read:false,unread_sources:selectedDocuments.filter(d=>d.parse_status!=='completed').map(d=>({id:d.id,status:d.parse_status})),
      omitted_source_ids:[...transactions.slice(64),...documents.slice(64),...matches.slice(256)].map(r=>r.id),absence_proven:false}};
  evidence.packet_sha256=hash(evidence);
  const base = {caseEvidence:evidence,matchedDocument:transactionId?projectMatchedDocument(evidence,transactionId):null,
    sourceDocument:documentId?focal:null,candidates:selectedTransactions,limits:evidence.coverage};
  return base;
}

export async function readJevCase({ client, firmId, clientId, documentId = null, transactionId = null,
  asOf = toUtcIsoDay(new Date()), allowUnsupported = false, evidenceOnly = false, lockEvidence = false, includePostingLines = false }) {
  // lockEvidence: true waits for share locks; 'nowait' refuses (55P03) instead.
  const lock = lockEvidence ? ` for share${lockEvidence === 'nowait' ? ' nowait' : ''}` : '';
  const company = (await client.query(`select id,company_name,uen,jurisdiction,entity_type,profile from clients where firm_id=$1 and id=$2${lock}`, [firmId,clientId])).rows[0];
  if (!company) fail('client_not_found','Company not found.',404);
  let focal = null;
  if (transactionId) focal = (await client.query('select * from transactions where firm_id=$1 and client_id=$2 and id=$3',[firmId,clientId,transactionId])).rows[0];
  if (documentId) focal = (await client.query('select * from documents where firm_id=$1 and client_id=$2 and id=$3',[firmId,clientId,documentId])).rows[0];
  if ((documentId || transactionId) && !focal) fail('case_not_found','Case not found in this company.',404);
  const day = sourceRecordDate(focal)?.date || toIsoDay(focal?.transaction_date) || asOf;
  const transactions = (await client.query(`select *, ${CANDIDATE_TX_STATUS_SQL} as eligible from transactions
    where firm_id=$1 and client_id=$2 order by (id=$3) desc, abs(transaction_date-$4::date),id limit 65${lock}`,
    [firmId,clientId,transactionId,day])).rows;
  const documents = (await client.query(`select * from documents where firm_id=$1 and client_id=$2 and (duplicate_of is null or id=$3)
    order by (id=$3) desc nulls last, exists(select 1 from reconciliation_matches m where m.firm_id=$1 and m.client_id=$2
      and m.bank_transaction_id=$4 and m.matched_object_id=documents.id) desc,
      abs(document_date-$5::date) nulls last,id limit 65${lock}`,[firmId,clientId,documentId,transactionId,day])).rows;
  const selectedTransactions = transactions.slice(0,64), selectedDocuments = documents.slice(0,64);
  const docIds = selectedDocuments.map(d => d.id), txIds = selectedTransactions.map(t => t.id);
  const lines = docIds.length ? (await client.query(`select * from document_lines where firm_id=$1 and client_id=$2
    and document_id=any($3::text[]) order by document_id,line_no,id${lock}`,[firmId,clientId,docIds])).rows.map(extractedLine) : [];
  const matches = (await client.query(`select rm.*,t.currency from reconciliation_matches rm
    join transactions t on t.id=rm.bank_transaction_id and t.firm_id=rm.firm_id and t.client_id=rm.client_id
    where rm.firm_id=$1 and rm.client_id=$2 and (rm.matched_object_id=any($3::text[]) or rm.bank_transaction_id=any($4::text[]))
    order by rm.id limit 257${lock.replace(' for share',' for share of rm')}`,[firmId,clientId,docIds,txIds])).rows;
  const replies = (await client.query(`select id,transaction_id,request_payload->>'document_id' as document_id,status,audience,evidence_type,question,response_payload,created_by,responded_at,resolved_by,request_payload
    from client_evidence_requests where firm_id=$1 and client_id=$2
    and (transaction_id=any($3::text[]) or request_payload->>'document_id'=any($4::text[])) order by id limit 257${lock}`,[firmId,clientId,txIds,docIds])).rows;
  const obligations = (await client.query(`select * from document_obligations where firm_id=$1 and client_id=$2
    and document_id=any($3::text[]) order by id limit 257${lock}`,[firmId,clientId,docIds])).rows;
  const postings = (await client.query(`select id,source_id,source_type,status,correction_of_journal_id,reversal_of_journal_id from ledger_journals
    where firm_id=$1 and client_id=$2 and (source_id=any($3::text[]) or source_id=any($4::text[])
      or correction_of_journal_id in (select id from ledger_journals where firm_id=$1 and client_id=$2
        and (source_id=any($3::text[]) or source_id=any($4::text[])))) order by id limit 257${lock}`,[firmId,clientId,txIds,docIds])).rows;
  // Optional detail uses the same scoped inventory. Chat must not infer a
  // component's posted account from the transaction's summary suggestion.
  if (includePostingLines && transactionId) {
    for (const posting of postings.filter(row => row.source_id === transactionId || postings.some(original=>original.source_id===transactionId && row.correction_of_journal_id===original.id))) {
      posting.lines = (await client.query(`select line_no,account_code,account_name,debit,credit,currency,tax_type,memo
        from ledger_lines where firm_id=$1 and client_id=$2 and journal_id=$3 order by line_no`,
        [firmId,clientId,posting.id])).rows;
    }
  }
  const base = projectJevCaseRows({ firmId, clientId, transactionId, documentId, focal, company,
    transactions, documents, lines, matches, replies, obligations, postings });
  const evidence = base.caseEvidence;
  if (evidenceOnly || transactionId || !documentId) return base;
  const limits={transactions_capped:transactions.length>64,documents_capped:documents.length>64};
  try {
    const mapped=prepareJevPreview({firmId,clientId,document:focal,documents:selectedDocuments,
      transactions:selectedTransactions,matches:matches.filter(m=>['confirmed','auto_matched','rejected'].includes(m.status)),asOf,limits});
    mapped.prepared.state.case_evidence=jevCasePrompt(evidence,{bankHandles:mapped.prepared.bank_handles});
    return {...base,...mapped};
  } catch(error) {
    if(!allowUnsupported || !['unsupported_document','unsupported_amount','unsupported_currency','existing_fx_allocation','already_settled'].includes(error.code)) throw error;
    return {...base,document:documentLabel(focal),unsupportedState:jevCasePrompt(evidence),limits:{...limits,contract_limit:error.code,absence_proven:false}};
  }
}

// Read-only transaction batch: same logical windows/projection as readJevCase,
// shared document lines physically fetched once, and one MVCC snapshot.
export async function readJevTransactionCases({ client, firmId, clientId, transactionIds = [],
  asOf = toUtcIsoDay(new Date()), includeConvergence = false }) {
  const { readJevTransactionBatchRows } = await import('./jevCaseBatchRead.js');
  const snapshot = await readJevTransactionBatchRows({ client, firmId, clientId, transactionIds, asOf, includeConvergence });
  if (!snapshot.company) fail('client_not_found','Company not found.',404);
  const company = sourceFields(snapshot.company,['id','company_name','uen','jurisdiction','entity_type','profile']);
  const lines = snapshot.lines.map(extractedLine);
  const cases = new Map(snapshot.windows.map(window => {
    const documentIds = new Set(window.documents.slice(0,64).map(row => row.id));
    return [window.transactionId, projectJevCaseRows({ ...window, firmId, clientId, company,
      lines: lines.filter(row => documentIds.has(row.document_id)) })];
  }));
  return { ...snapshot, cases };
}

export async function runJevPreview({ client, firmId, clientId, documentId, asOf = toUtcIsoDay(new Date()), provider = callJevDirect }) {
  const mapped = await readJevCase({ client, firmId, clientId, documentId, asOf });
  const result = await provider(mapped.prepared);
  const direct = result.decision.direct;
  const plan = result.menu.plans.find(p => p.id === direct.selected) || result.menu.abstain;
  return { read_only: true, document: mapped.document, outcome: direct.terminal, selected_plan: plan, plan_text: plan?.text || 'No offered plan is supported.',
    accepted: direct.validation.accepted, refusals: direct.validation.refusals, probability: direct.probability,
    model: result.model, usage: result.usage, latency_ms: result.latency_ms, decision: result.decision, limits: mapped.limits,
    evidence: mapped.prepared.packet.sources.map(s => ({ id: s.id, kind: s.kind, label: s.label || s.id,
      handle: mapped.prepared.source_handles[s.id], cited: direct.citation?.cited?.includes(mapped.prepared.source_handles[s.id]) || false })),
    candidates: mapped.prepared.packet.transactions.map(t => ({ ...t, handle: mapped.prepared.bank_handles[t.id], payload: undefined })),
    menu: { size: result.menu.plans.length, truncated: result.menu.truncated, provenance_omitted: result.menu.provenance_omitted } };
}

export function codingCaseRevision(evidence, { completeSources = false } = {}) {
  const tx = evidence.transactions.find(t=>t.id===evidence.focal.id);
  const groupIds=new Set(tx?.refund_group?.transaction_ids || [tx?.id]);
  const matches = evidence.matches.filter(m=>groupIds.has(m.bank_transaction_id));
  const candidates = localEvidenceCandidatesByTransaction({transactions:tx?[tx]:[],documents:evidence.documents}).get(tx?.id)||[];
  const ids = new Set([...matches.map(m=>m.matched_object_id),...candidates.map(d=>d.id)]);
  // Reconsider unresolved decisions made before question/answer provenance was
  // separated. A fixed contract revision wakes them once; creating or closing
  // unanswered requests still cannot change the revision or feed a retry loop.
  return hash({case_contract:'attributed-replies-source-questions-v2',company:evidence.company,bank:tx,
    ...(completeSources ? { supplied_sources: {
      transactions: evidence.transactions,
      documents: evidence.documents.map(({payment_status,relationship_status,source_family,...document}) => document),
      matches: evidence.matches, obligations: evidence.obligations, postings: evidence.postings,
      replies: evidence.owner_replies.filter(row => row.provenance === 'attributable_owner_reply').map(row => ({
        id: row.id, transaction_id: row.transaction_id, question: row.question,
        actor_id: row.response_payload?.reply_processing?.actor_id || row.response_payload?.answer_recorded_by || row.resolved_by,
        reply: row.response_payload?.reply, document_ids: row.response_payload?.document_ids,
        responded_at: row.response_payload?.responded_at
      }))
    } } : {}),
    ...(groupIds.size>1?{group_bank_sources:evidence.transactions.filter(t=>groupIds.has(t.id))}:{}),
    documents:evidence.documents.filter(d=>ids.has(d.id)).map(({payment_status,relationship_status,source_family,...d})=>d),
    matches:matches.map(({payload,...m})=>m),
    // Asking and processing are operational receipts, not new owner evidence.
    owner_replies:evidence.owner_replies.filter(r=>groupIds.has(r.transaction_id) && !r.response_payload?.auto_resolved_by_match
      && (String(r.response_payload?.reply || '').trim() || r.response_payload?.document_ids?.length))
      .map(r=>({id:r.id,question:r.question,evidence_type:r.evidence_type,
        response_payload:sourceFields(r.response_payload,['reply','document_ids','responded_at','answer_source','answer_recorded_by'])})),
    obligations:evidence.obligations.filter(o=>ids.has(o.document_id)),
    coverage:{status:evidence.coverage.status,unread_sources:evidence.coverage.unread_sources.filter(s=>ids.has(s.id))}});
}
