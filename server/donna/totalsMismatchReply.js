// The owner-reply consumer for the RT-10 totals lane (FI reliability pass row
// 5, register item FI-03). A document whose printed figures do not foot opens
// one `amount_mismatch` review row and one document-anchored
// `supporting_document` ask (`request_payload.lane = 'totals_mismatch'`,
// minted in parseDocumentsDb.js). This adapter is that ask's registered reply
// consumer: the shared owner-reply worker (ownerReplyRecovery.js →
// structuredOwnerReply.js) owns the lease, the bounded failures, the strong
// interpretation and the receipt; this module owns only the totals contract.
//
// The contract, kept deliberately narrow:
// - A corrected copy closes the question when the evidence settles it, with no
//   model call: the copy is the same document (counterparty, date and reference
//   agree), it foots (its own persisted totals verdict), and its total and tax
//   equal the figures the books already carry. Checked again under the commit
//   locks, never only at reply time.
// - Text alone may only CONFIRM the printed total the books carry, and only
//   when a live bank match settles that exact amount. It never authorizes a
//   different total, VAT or line split; those need the corrected source.
// - Anything else is exactly one bounded clarification. Past the bound the
//   question rests on the owner as a fixed request for the corrected source,
//   receipted on the review row; text replies are no longer re-interpreted.
// - No journal, match or extraction is written here. A corrected copy whose
//   figures DIFFER from the books is an accounting correction this lane does
//   not own: it is refused loudly (bounded failure receipts), never applied.
//
// No static database imports: the statutory registry imports this module and
// the firmDb chain is an import cycle.
import { toIsoDay } from './dates.js';

export const TOTALS_MISMATCH_LANE = 'totals_mismatch';
export const TOTALS_MISMATCH_EVIDENCE_TYPE = 'supporting_document';

const refuse = (code, message) => { throw Object.assign(new Error(message), { code }); };
const cents = value => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Math.round(Number(value) * 100));
const sameCents = (a, b) => cents(a) !== null && cents(a) === cents(b);
const norm = value => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
// A field both sides carry must agree; one side missing it is not a mismatch.
const agrees = (a, b) => !norm(a) || !norm(b) || norm(a) === norm(b);

const DOCUMENT_COLUMNS = `id, filename, parse_status, duplicate_of, vendor_name, customer_name, document_date,
  reference_number, total_amount, tax_amount, currency, parse_summary->'totals_validation' as totals_validation`;

const readOriginal = async (client, firmId, request) => {
  const documentId = String(request.request_payload?.document_id || '').trim();
  if (!documentId) refuse('TOTALS_REPLY_SOURCE_INVALID', 'The totals question names no document.');
  const original = (await client.query(`select ${DOCUMENT_COLUMNS} from documents where firm_id = $1 and client_id = $2 and id = $3`,
    [firmId, request.client_id, documentId])).rows[0];
  if (!original) refuse('TOTALS_REPLY_SOURCE_INVALID', 'The document behind the totals question no longer exists.');
  return original;
};

const copyVerdict = (original, copy) => {
  if (copy.id === original.id || copy.parse_status !== 'completed' || copy.duplicate_of) return 'not_a_parsed_copy';
  if (copy.totals_validation?.matches !== true) return 'copy_does_not_foot';
  if (!agrees(copy.vendor_name || copy.customer_name, original.vendor_name || original.customer_name)
    || !agrees(copy.reference_number, original.reference_number)
    || !agrees(copy.currency, original.currency)
    || (copy.document_date && original.document_date && toIsoDay(copy.document_date) !== toIsoDay(original.document_date))) return 'different_document';
  if (!sameCents(copy.total_amount, original.total_amount) || cents(copy.tax_amount) !== cents(original.tax_amount)) return 'figures_differ';
  return 'settles';
};

// The deterministic half: does an attached document settle the question?
// Returns the answer the writer applies, null when no attachment bears on it.
export const settleTotalsMismatchFromEvidence = async ({ client, firmId, request }) => {
  const original = await readOriginal(client, firmId, request);
  const replyIds = [...new Set(request.response_payload?.document_ids || [])].filter(id => id && id !== original.id);
  if (!replyIds.length) return null;
  const copies = (await client.query(`select ${DOCUMENT_COLUMNS} from documents where firm_id = $1 and client_id = $2 and id = any($3::text[]) order by id`,
    [firmId, request.client_id, replyIds])).rows;
  const verdicts = copies.map(copy => ({ copy, verdict: copyVerdict(original, copy) }));
  const settling = verdicts.find(v => v.verdict === 'settles');
  if (settling) return { corrected_document_id: settling.copy.id };
  if (verdicts.some(v => v.verdict === 'figures_differ')) {
    refuse('TOTALS_CORRECTION_REQUIRES_ACCOUNTING_CHANGE',
      'The corrected copy foots at figures that differ from the books; applying it is a document correction this lane does not own.');
  }
  return null;
};

// The bank settlement that corroborates the printed total, if any.
const bankCorroboration = async (client, firmId, request, original) => (await client.query(
  `select m.id as match_id, m.bank_transaction_id
     from reconciliation_matches m
     join transactions t on t.firm_id = m.firm_id and t.client_id = m.client_id and t.id = m.bank_transaction_id
    where m.firm_id = $1 and m.client_id = $2 and m.matched_object_id = $3
      and m.status in ('auto_matched', 'confirmed')
      and abs(t.money_out - t.money_in) = abs($4::numeric)
    order by m.id limit 1`,
  [firmId, request.client_id, original.id, original.total_amount])).rows[0] || null;

const copyRequest = (original) => `Thanks. To close this we need a copy of ${original.filename || 'the receipt'} that adds up — could you ask ${original.vendor_name || 'the seller'} for a corrected receipt and upload it here?`;

const closeTotalsQuestion = async ({ client, firmId, request, actorId, actorType, original, resolution }) => {
  const now = new Date().toISOString();
  const closed = await client.query(
    `update client_evidence_requests
        set status = 'resolved', resolved_at = now(), resolved_by = $4,
            request_payload = jsonb_set(request_payload, '{evidence_request,status}', '"resolved"'::jsonb, true),
            response_payload = response_payload || jsonb_build_object('totals_resolution', $5::jsonb),
            updated_at = now()
      where firm_id = $1 and client_id = $2 and id = $3 and status = 'replied'`,
    [firmId, request.client_id, request.id, actorId, JSON.stringify(resolution)]);
  if (closed.rowCount !== 1) refuse('OWNER_REPLY_SUPERSEDED', 'The totals question changed before it could close.');
  if (request.review_item_id) {
    await client.query(
      `update transaction_review_queue
          set status = 'resolved', updated_at = now(),
              payload = payload || jsonb_build_object('lane', coalesce(payload->'lane', '{}'::jsonb)
                || jsonb_build_object('status', 'resolved', 'resolution', $4::jsonb, 'resolved_at', $5::text))
        where firm_id = $1 and client_id = $2 and id = $3 and reason = 'amount_mismatch' and status = 'open'`,
      [firmId, request.client_id, request.review_item_id, JSON.stringify(resolution), now]);
  }
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, $3, $4, 'document.totals_mismatch.resolved', 'document', $5, $6::jsonb)`,
    [firmId, request.client_id, actorType || 'client', actorId, original.id, JSON.stringify({
      evidence_request_id: request.id, review_item_id: request.review_item_id || null, resolution, journal_changed: false
    })]);
  return { resolved: true, resolution };
};

const answerSchema = { type: 'object', additionalProperties: false, required: ['printed_total_confirmed', 'explanation'], properties: {
  printed_total_confirmed: { type: 'boolean', enum: [true] },
  explanation: { type: 'string', minLength: 1, maxLength: 600 }
} };

export const totalsMismatchReplyAdapter = Object.freeze({
  lane: TOTALS_MISMATCH_LANE,
  evidenceType: TOTALS_MISMATCH_EVIDENCE_TYPE,
  action: 'close_totals_mismatch',
  maxClarifications: 1,
  answerSchema,
  instructions: `This ask is about a document whose printed figures do not add up (fact_at_mint.totals_validation: the printed total, the line sum and the drift). The books carry the printed total and tax. Answer only when the owner clearly confirms that the printed total is the amount actually paid and explains the difference (for example a misprinted or torn line); then return {printed_total_confirmed:true, explanation} in the owner's own terms. The owner cannot change a total, a VAT amount or a line split by text: when the reply states different figures, says they do not know, asks someone else, or is unclear, return one specific clarification that asks for a corrected copy of the named document or for the exact amount they paid. Never invent figures.`,
  validateAnswer: answer => Boolean(answer && typeof answer === 'object' && !Array.isArray(answer)
    && Object.keys(answer).length === 2 && answer.printed_total_confirmed === true
    && typeof answer.explanation === 'string' && answer.explanation.trim().length > 0 && answer.explanation.length <= 600),
  contextDocumentIds: request => [request.request_payload?.document_id].filter(Boolean),
  settle: settleTotalsMismatchFromEvidence,
  exhaustedQuestion: async ({ client, firmId, request }) => copyRequest(await readOriginal(client, firmId, request)),
  exhaust: async ({ client, firmId, request, actorId, actorType }) => {
    const original = await readOriginal(client, firmId, request);
    const now = new Date().toISOString();
    if (request.review_item_id) {
      await client.query(
        `update transaction_review_queue
            set updated_at = now(),
                payload = payload || jsonb_build_object('lane', coalesce(payload->'lane', '{}'::jsonb)
                  || jsonb_build_object('status', 'open', 'clarification_exhausted', true, 'exhausted_at', $4::text))
          where firm_id = $1 and client_id = $2 and id = $3 and reason = 'amount_mismatch' and status = 'open'`,
        [firmId, request.client_id, request.review_item_id, now]);
    }
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       values ($1, $2, $3, $4, 'document.totals_mismatch.clarification_exhausted', 'document', $5, $6::jsonb)`,
      [firmId, request.client_id, actorType || 'client', actorId, original.id, JSON.stringify({
        evidence_request_id: request.id, review_item_id: request.review_item_id || null, rests_on: 'owner', next_need: 'corrected_source_document'
      })]);
  },
  // Commit-time: re-validate the evidence under the worker's locks, then close.
  apply: async ({ client, firmId, request, actorId, actorType, answer }) => {
    const original = await readOriginal(client, firmId, request);
    if (answer?.corrected_document_id) {
      const settled = await settleTotalsMismatchFromEvidence({ client, firmId, request });
      if (settled?.corrected_document_id !== answer.corrected_document_id) refuse('OWNER_REPLY_SUPERSEDED', 'The corrected copy no longer settles the totals question.');
      const copy = (await client.query(`select ${DOCUMENT_COLUMNS} from documents where firm_id = $1 and client_id = $2 and id = $3`,
        [firmId, request.client_id, answer.corrected_document_id])).rows[0];
      return closeTotalsQuestion({ client, firmId, request, actorId, actorType, original, resolution: {
        kind: 'corrected_copy_foots', corrected_document_id: copy.id, total: Number(copy.total_amount), tax: Number(copy.tax_amount),
        totals_validation: copy.totals_validation
      } });
    }
    const corroboration = await bankCorroboration(client, firmId, request, original);
    if (!corroboration) return { needsClarification: true, clarification: copyRequest(original) };
    return closeTotalsQuestion({ client, firmId, request, actorId, actorType, original, resolution: {
      kind: 'owner_confirmed_printed_total', explanation: answer.explanation.trim(), total: Number(original.total_amount),
      tax: Number(original.tax_amount), bank_transaction_id: corroboration.bank_transaction_id, match_id: corroboration.match_id
    } });
  }
});
