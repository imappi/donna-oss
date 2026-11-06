// Attributed transaction facts use the existing review writer and audit. This
// module reads/binds evidence; it neither chooses tax treatment nor writes rows.
import { createHash } from 'node:crypto';
import { paymentMatchesInvoice } from '../issuedInvoiceSettlementMath.js';
import { toIsoDay } from '../dates.js';

export const loadClientTaxFactAutomation = async ({ client, firmId, clientId }) => {
  const { loadPostingTaxFactAutomation } = await import('../postingPolicy.js');
  const row = (await client.query('select jurisdiction from clients where firm_id=$1 and id=$2', [firmId, clientId])).rows[0];
  return loadPostingTaxFactAutomation({ jurisdiction: row?.jurisdiction });
};

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const taxFactsDigest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const taxFactsSource = transaction => ({ id: transaction.id, client_id: transaction.client_id,
  date: toIsoDay(transaction.date || transaction.transaction_date), currency: transaction.currency,
  account_currency: transaction.account_currency ?? null,
  money_in: Number(transaction.money_in || 0), money_out: Number(transaction.money_out || 0) });
export const taxFactsDocument = row => ({ id: row.id, client_id: row.client_id,
  document_type: row.document_type, document_date: toIsoDay(row.document_date),
  currency: row.currency, total_amount: row.total_amount, tax_amount: row.tax_amount,
  duplicate_of: row.duplicate_of, parse_status: row.parse_status, parse_summary: row.parse_summary, extracted_data: row.extracted_data,
  filename: row.filename, checksum_sha256: row.checksum_sha256,
  storage_bucket: row.storage_bucket, storage_object_key: row.storage_object_key,
  payload: row.payload, original_filename: row.original_filename });
export const readTaxPostingEvidence = async ({ client, firmId, clientId, documentId, lock = false }) => {
  const params = [firmId, clientId, documentId];
  const result = lock
    ? await client.query('select * from documents where firm_id=$1 and client_id=$2 and id=$3 for update', params)
    : await client.query('select * from documents where firm_id=$1 and client_id=$2 and id=$3', params);
  const row = result.rows[0];
  return row ? taxFactsDocument(row) : null;
};
export const bindTaxPostingFactsWithClient = async ({ client, firmId, clientId, transaction, facts, actorId, runtime = null }) => {
  const fail = message => { throw Object.assign(new Error(message), { code: 'TAX_POSTING_FACTS_INVALID', statusCode: 409 }); };
  if (!facts || typeof facts !== 'object' || Array.isArray(facts) || !facts.document_id
    || typeof facts.explanation !== 'string' || !facts.explanation.trim()) fail('Tax posting facts require exact retained evidence and an explanation.');
  if (runtime) {
    const automation = await loadClientTaxFactAutomation({ client, firmId, clientId });
    const { readClientConfigSnapshot } = await import('../clientConfig.js');
    if ((!automation || actorId !== automation.actorId || runtime.authority_basis !== automation.authorityBasis) || !runtime.model
      || !runtime.context_digest || !automation.enabled(await readClientConfigSnapshot(client, { firmId, clientId, strict: true }))) {
      throw Object.assign(new Error('Automatic VAT facts require current configuration authority and a source-bound model receipt.'), { code: 'TAX_POSTING_FACTS_AUTHORITY_REQUIRED', statusCode: 403 });
    }
  } else if (!actorId || actorId === 'system' || !(await client.query(
    "select id from firm_members where firm_id=$1 and id=$2 and status='active' and coalesce(role,'') <> 'viewer' and coalesce(access_level,'') not in ('viewer','read_only') for share", [firmId, actorId])).rows.length) {
    throw Object.assign(new Error('Tax posting facts require an active initiating member with accounting write authority.'),
      { code:'TAX_POSTING_FACTS_AUTHORITY_REQUIRED',statusCode:403 });
  }
  const evidence = await readTaxPostingEvidence({ client, firmId, clientId, documentId: facts.document_id, lock: true });
  if (!evidence) fail('The tax evidence must belong to this transaction’s client.');
  // Attribution and identity are server-owned; input cannot impersonate them.
  return { ...facts, version: 1, actor_id: actorId, authority_basis: runtime?.authority_basis || 'transaction_review_correction',
    ...(runtime ? { model: runtime.model, context_digest: runtime.context_digest } : {}),
    source: taxFactsSource(transaction), evidence_digest: taxFactsDigest(evidence) };
};

export const loadTaxPostingContext = async ({ client, firmId, clientId, transaction, postingContext, ledgerAccounts, lock = false }) => {
  const facts = transaction.tax_posting_facts;
  if (!facts) return null;
  const runtime = facts.authority_basis === 'config_plane:AE_VAT_FACT_AUTOMATION';
  let runtimeAuthority = false;
  if (runtime) {
    const automation = await loadClientTaxFactAutomation({ client, firmId, clientId });
    const current = await automation?.readContext({ client, firmId, clientId, transactionId: transaction.id, lock });
    runtimeAuthority = Boolean(current && current.digest === facts.context_digest);
  }
  const evidence = await readTaxPostingEvidence({ client, firmId, clientId, documentId: facts.document_id, lock });
  const authority = (await client.query(`select id from audit_events where firm_id=$1 and client_id=$2
    and actor_id=$3 and action=$6
    and metadata->>'transaction_id'=$4 and metadata->>'tax_posting_facts_digest'=$5 limit 1`,
    [firmId, clientId, facts.actor_id, transaction.id, taxFactsDigest(facts), runtime ? 'transaction.tax_facts_generated' : 'transaction_review.update'])).rows.length === 1;
  const priorPost = (await client.query(`select id from ledger_journals where firm_id=$1 and client_id=$2 and status in ('posted','closed')
    and ((source_type <> 'transaction' and source_id=$3) or (source_type='transaction' and source_id<>$4 and payload->'tax_point'->>'document_id'=$3)) limit 1`,
    [firmId, clientId, facts.document_id, transaction.id])).rows.length > 0;
  const issued = (await client.query(`select draft from issued_invoices where firm_id=$1 and client_id=$2 and status='issued'`, [firmId, clientId])).rows;
  const issuedSettlement = issued.some(({ draft }) => paymentMatchesInvoice({ invoiceNumber: draft?.invoice?.invoiceNumber,
    referenceNumber: draft?.finvoice?.invoiceDetails?.referenceNumber || draft?.finvoice?.paymentDetails?.referenceNumber }, transaction));
  return { facts, evidence, authority, runtimeAuthority, priorPost, issuedSettlement, source: taxFactsSource(transaction),
    evidenceCurrent: Boolean(evidence && taxFactsDigest(evidence) === facts.evidence_digest
      && taxFactsDigest(taxFactsSource(transaction)) === taxFactsDigest(facts.source)),
    profile: postingContext.row.profile || {}, ledgerAccounts };
};
