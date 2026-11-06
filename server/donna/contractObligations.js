// Contract obligations — DB write helpers and non-posting guardrail.
//
// Obligations extracted from contracts represent EXPECTED future events.
// They must never auto-book as if they were actual invoices.
//
// Non-posting policy: any reconciliation match derived from an obligation
// MUST stay in status='suggested' or 'suggested_pending_audit'.
// Transition to 'auto_matched' is prohibited. Transition to 'confirmed'
// requires explicit human action.

import crypto from 'node:crypto';

export const OBLIGATION_NON_POSTING_POLICY = Object.freeze({
  allowed_statuses: ['suggested', 'suggested_pending_audit'],
  auto_match_passed: false,
  blocker: 'obligation_derived_requires_human_confirm'
});

export const isObligationDerived = (match) =>
  match?.payload?.source === 'contract_obligation_reconciliation';

export const enforceNonPostingPolicy = (match) => {
  if (!isObligationDerived(match)) return match;
  return {
    ...match,
    status: 'suggested_pending_audit',
    payload: {
      ...match.payload,
      auto_match_passed: OBLIGATION_NON_POSTING_POLICY.auto_match_passed,
      blocker: OBLIGATION_NON_POSTING_POLICY.blocker
    }
  };
};

const generateObligationId = (documentId, index) =>
  crypto.createHash('sha256')
    .update(`${documentId}:obligation:${index}`)
    .digest('hex')
    .slice(0, 32);

export const buildObligationRows = ({
  firmId,
  clientId,
  documentId,
  obligations = []
}) => {
  if (!Array.isArray(obligations) || obligations.length === 0) return [];
  return obligations.map((ob, idx) => ({
    id: generateObligationId(documentId, idx),
    firm_id: firmId,
    client_id: clientId,
    document_id: documentId,
    obligation_type: ob.obligation_type,
    payer: ob.payer || null,
    payee: ob.payee || null,
    payer_role: ob.payer_role || 'party',
    payee_role: ob.payee_role || 'party',
    amount: ob.amount,
    currency: ob.currency || null,
    frequency: ob.frequency || 'one_time',
    start_date: ob.start_date || null,
    end_date: ob.end_date || null,
    due_day: ob.due_day || null,
    escalation_clause: ob.escalation_clause || null,
    tax_clause: ob.tax_clause || null,
    confidence: ob.confidence ?? 0,
    source_evidence: ob.source_evidence ? { snippet: ob.source_evidence } : {},
    payload: {}
  }));
};

export const writeObligationsForContractSql = ({
  firmId,
  clientId,
  documentId,
  obligations = []
}) => {
  const rows = buildObligationRows({ firmId, clientId, documentId, obligations });
  if (rows.length === 0) return { sql: null, params: [], rows: [] };

  const deleteSql = `DELETE FROM document_obligations WHERE firm_id = $1 AND document_id = $2`;
  const deleteParams = [firmId, documentId];

  const insertPlaceholders = [];
  const insertParams = [firmId, clientId, documentId];
  let paramIdx = 4;

  for (const row of rows) {
    const placeholders = [
      `$${paramIdx++}`,     // id
      '$1',                 // firm_id
      '$2',                 // client_id
      '$3',                 // document_id
      `$${paramIdx++}`,     // obligation_type
      `$${paramIdx++}`,     // payer
      `$${paramIdx++}`,     // payee
      `$${paramIdx++}`,     // payer_role
      `$${paramIdx++}`,     // payee_role
      `$${paramIdx++}`,     // amount
      `$${paramIdx++}`,     // currency
      `$${paramIdx++}`,     // frequency
      `$${paramIdx++}`,     // start_date
      `$${paramIdx++}`,     // end_date
      `$${paramIdx++}`,     // due_day
      `$${paramIdx++}`,     // escalation_clause
      `$${paramIdx++}`,     // tax_clause
      `$${paramIdx++}`,     // confidence
      `$${paramIdx++}`,     // source_evidence
      `$${paramIdx++}`      // payload
    ];
    insertPlaceholders.push(`(${placeholders.join(', ')})`);
    insertParams.push(
      row.id,
      row.obligation_type,
      row.payer,
      row.payee,
      row.payer_role,
      row.payee_role,
      row.amount,
      row.currency,
      row.frequency,
      row.start_date,
      row.end_date,
      row.due_day,
      row.escalation_clause,
      row.tax_clause,
      row.confidence,
      JSON.stringify(row.source_evidence),
      JSON.stringify(row.payload)
    );
  }

  const insertSql = `INSERT INTO document_obligations (
    id, firm_id, client_id, document_id,
    obligation_type, payer, payee, payer_role, payee_role,
    amount, currency, frequency, start_date, end_date, due_day,
    escalation_clause, tax_clause, confidence, source_evidence, payload
  ) VALUES ${insertPlaceholders.join(', ')}
  ON CONFLICT (id) DO UPDATE SET
    obligation_type = EXCLUDED.obligation_type,
    payer = EXCLUDED.payer,
    payee = EXCLUDED.payee,
    payer_role = EXCLUDED.payer_role,
    payee_role = EXCLUDED.payee_role,
    amount = EXCLUDED.amount,
    currency = EXCLUDED.currency,
    frequency = EXCLUDED.frequency,
    start_date = EXCLUDED.start_date,
    end_date = EXCLUDED.end_date,
    due_day = EXCLUDED.due_day,
    escalation_clause = EXCLUDED.escalation_clause,
    tax_clause = EXCLUDED.tax_clause,
    confidence = EXCLUDED.confidence,
    source_evidence = EXCLUDED.source_evidence,
    payload = EXCLUDED.payload,
    updated_at = now()`;

  return {
    deleteSql,
    deleteParams,
    insertSql,
    insertParams,
    rows
  };
};
