// The unified extractor's ONE schema — RT-12 of
// docs/plan-2026-09-01-runtime-refactor-slices.md (decision D1; audit F-12 /
// F-15; docs/donna-llm-trust-strategy.md §3 Slice B).
//
// One prompt, one strict schema, every reconcilable document type. The
// per-type extractors each carried their own schema and re-taught the model
// what an invoice is; the unified call gives the strong model the document,
// the firm's anchor and THIS shape, and trusts its classification. The
// schema is the Keep layer's half of that bargain: hallucinated keys are
// refused, enums are pinned, and the two structurally different families
// (settlement documents, contracts) travel as always-present blocks the
// model leaves null / empty for every other type — no nullable objects, so
// OpenAI strict mode and the Anthropic post-parse check see the same shape.
//
// Provider symmetry: on OpenAI the schema rides `text.format` as
// json_schema/strict; on Anthropic the same object is checked AFTER
// extractJson by `validateStrictSchema` below — a deliberately small
// checker (types, enums, required, additionalProperties, items) so the two
// providers are held to one contract without a second dependency.

// ── vocabularies ────────────────────────────────────────────────────────

// Every type the unified extractor may classify a document as. `unknown`
// is a classification the model may return; it is NOT a type the appliance
// default serves (the generic extractor keeps unknown uploads).
export const UNIFIED_DOCUMENT_TYPES = Object.freeze([
  'receipt',
  'supplier_bill',
  'sales_invoice',
  'issued_receipt',
  'payment_confirmation',
  'payment_account_statement',
  'contract',
  'payout_statement',
  'deposit_slip',
  'unknown'
]);

// The reconcilable set the appliance default routes through the unified
// call. bank_statement keeps its own lane (multi-page line extraction);
// company_or_statutory_record keeps entity_facts; unknown keeps generic.
export const UNIFIED_EXTRACTOR_TYPES = Object.freeze(
  UNIFIED_DOCUMENT_TYPES.filter((type) => type !== 'unknown')
);

export const SETTLEMENT_DOCUMENT_TYPES = Object.freeze(['payout_statement', 'deposit_slip']);
export const LINE_BEARING_DOCUMENT_TYPES = Object.freeze(['receipt', 'supplier_bill', 'sales_invoice', 'issued_receipt']);

export const COUNTERPARTY_ROLE_VALUES = Object.freeze(['vendor', 'customer', 'processor', 'bank', 'unknown']);
export const PAYMENT_STATUS_VALUES = Object.freeze(['paid', 'unpaid', 'partial', 'unknown', 'void', 'credit_note']);
export const EXTRACTION_STATUS_VALUES = Object.freeze(['validated', 'partial', 'failed']);

// The union of the per-type reference vocabularies (receipt/bill/invoice +
// contract). The legacy `reference_number` column is picked by priority per
// type in the mapper.
export const REFERENCE_TYPE_VALUES = Object.freeze([
  'invoice_number',
  'receipt_number',
  'order_id',
  'transaction_id',
  'ticket_number',
  'tracking_number',
  'booking_reference',
  'contract_number',
  'agreement_number',
  'payout_reference',
  'deposit_reference',
  'other'
]);

// Contract vocabularies — value-identical to contract.js (the module this
// schema replaces); restated so the deletion PR can remove that file.
export const CONTRACT_TYPE_VALUES = Object.freeze([
  'service_subscription',
  'services_one_off',
  'goods_purchase',
  'employment',
  'loan',
  'lease',
  'nda',
  'other',
  // Not a contract: the block is present for every type; this value says
  // "ignore the block".
  'not_a_contract'
]);
export const RECURRING_FREQUENCY_VALUES = Object.freeze(['monthly', 'quarterly', 'semi_annual', 'annual', 'none']);
export const OBLIGATION_TYPE_VALUES = Object.freeze([
  'recurring_payment',
  'one_time_payment',
  'deposit',
  'revenue_commitment',
  'loan_repayment',
  'interest',
  'termination_fee',
  'rent',
  'service_fee',
  'insurance_premium'
]);
export const OBLIGATION_FREQUENCY_VALUES = Object.freeze(['monthly', 'quarterly', 'semi_annual', 'annual', 'one_time', 'on_demand']);
export const OBLIGATION_PARTY_ROLE_VALUES = Object.freeze([
  'provider', 'client', 'landlord', 'tenant', 'lender', 'borrower',
  'licensor', 'licensee', 'employer', 'employee', 'party'
]);

// ── the schema ──────────────────────────────────────────────────────────

const nullable = (type) => ({ type: [type, 'null'] });
const str = { type: 'string' };
const nullableStr = nullable('string');
const nullableNum = nullable('number');
const stringArray = { type: 'array', items: str };
const objectOf = (properties) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties
});
const arrayOf = (properties) => ({ type: 'array', items: objectOf(properties) });

const HEADER_SCHEMA = objectOf({
  counterparty_name: nullableStr,
  counterparty_role: { type: 'string', enum: [...COUNTERPARTY_ROLE_VALUES] },
  counterparty_tax_id: nullableStr,
  own_name: nullableStr,
  own_tax_id: nullableStr,
  document_date: nullableStr,
  due_date: nullableStr,
  currency: nullableStr,
  subtotal_amount: nullableNum,
  tax_amount: nullableNum,
  shipping_amount: nullableNum,
  discount_amount: nullableNum,
  rounding_amount: nullableNum,
  total_amount: nullableNum,
  line_amounts_include_tax: { type: 'boolean' },
  payment_status: { type: 'string', enum: [...PAYMENT_STATUS_VALUES] },
  payment_terms: nullableStr,
  references: arrayOf({
    type: { type: 'string', enum: [...REFERENCE_TYPE_VALUES] },
    value: str
  })
});

const LINES_SCHEMA = arrayOf({
  description: nullableStr,
  quantity: nullableNum,
  unit_price: nullableNum,
  amount: nullableNum,
  tax_rate: nullableNum
});

const SETTLEMENT_SCHEMA = objectOf({
  period_start: nullableStr,
  period_end: nullableStr,
  payout_date: nullableStr,
  gross_sales: nullableNum,
  gross_components: arrayOf({ description: nullableStr, amount: nullableNum }),
  refunds: nullableNum,
  fees: arrayOf({ description: nullableStr, amount: nullableNum, tax_amount: nullableNum }),
  adjustments: arrayOf({ description: nullableStr, amount: nullableNum }),
  net_payout: nullableNum,
  transaction_count: nullable('integer'),
  payout_reference: nullableStr,
  deposit_reference: nullableStr,
  bank_last4: nullableStr,
  // RT-21b (2026-09-08): a statement that LISTS several settlements (a
  // monthly summary / koontilasku — one row per payout, each with its own
  // gross, fee and net) carries every listed row AS PRINTED. [] for a
  // single-settlement statement. Each row is what ONE bank credit settles
  // (RT-21's contract: bank line ↔ statement row at the row's NET).
  rows: arrayOf({
    period_label: nullableStr,
    period_start: nullableStr,
    period_end: nullableStr,
    paid_on: nullableStr,
    gross: nullableNum,
    fee: nullableNum,
    fee_tax: nullableNum,
    net: nullableNum,
    transaction_count: nullable('integer'),
    reference: nullableStr
  })
});

const OBLIGATION_SCHEMA = objectOf({
  obligation_type: { type: 'string', enum: [...OBLIGATION_TYPE_VALUES] },
  payer: nullableStr,
  payee: nullableStr,
  payer_role: { type: 'string', enum: [...OBLIGATION_PARTY_ROLE_VALUES] },
  payee_role: { type: 'string', enum: [...OBLIGATION_PARTY_ROLE_VALUES] },
  amount: nullableNum,
  currency: nullableStr,
  frequency: { type: 'string', enum: [...OBLIGATION_FREQUENCY_VALUES] },
  start_date: nullableStr,
  end_date: nullableStr,
  due_day: nullableNum,
  escalation_clause: nullableStr,
  tax_clause: nullableStr,
  confidence: { type: 'number' },
  source_evidence: nullableStr
});

const CONTRACT_SCHEMA = objectOf({
  contract_type: { type: 'string', enum: [...CONTRACT_TYPE_VALUES] },
  effective_start_date: nullableStr,
  effective_end_date: nullableStr,
  auto_renew: nullable('boolean'),
  notice_period_days: nullableNum,
  recurring_amount: nullableNum,
  recurring_frequency: { type: 'string', enum: [...RECURRING_FREQUENCY_VALUES] },
  obligations: { type: 'array', items: OBLIGATION_SCHEMA }
});

export const UNIFIED_EXTRACTION_SCHEMA = Object.freeze(objectOf({
  document_type: { type: 'string', enum: [...UNIFIED_DOCUMENT_TYPES] },
  extraction_status: { type: 'string', enum: [...EXTRACTION_STATUS_VALUES] },
  extraction_confidence: { type: 'number' },
  warnings: { ...stringArray, description: 'Extraction concerns and exact source tax clauses. Use source_tax: followed by a short literal clause preserving subject, rate, tax inclusion, exemption, deductibility and cited legal basis. Do not infer missing tax facts.' },
  source_business_use: objectOf({
    classification: {type:'string',enum:['not_stated','business','personal','mixed']},
    source_quote: nullableStr,
    business_use_percent: nullableNum
  }),
  header: HEADER_SCHEMA,
  lines: LINES_SCHEMA,
  settlement: SETTLEMENT_SCHEMA,
  contract: CONTRACT_SCHEMA
}));

// The name the OpenAI request carries in `text.format.name`; the recorded
// providers stub (testSupport/recordedProviders.js) classifies the wire by
// it, so a rename here is a rename there.
export const UNIFIED_EXTRACTION_SCHEMA_NAME = 'unified_extraction';

// ── the lite validator ─────────────────────────────────────────────────
// Exactly the subset the schema above uses: `type` (string or list, incl.
// 'null' and 'integer'), `enum`, `required`, `additionalProperties: false`,
// `properties`, `items`. Returns a list of violations (empty = valid); the
// caller decides what a violation means. Never throws on the value.

const typeOf = (value) => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isFinite(value) ? 'number' : 'invalid_number';
  return typeof value;
};

const matchesType = (value, expected) => {
  const actual = typeOf(value);
  if (expected === 'integer') return actual === 'number' && Number.isInteger(value);
  if (expected === 'number') return actual === 'number';
  return actual === expected;
};

export const validateStrictSchema = (schema, value, path = '$', out = []) => {
  if (!schema || typeof schema !== 'object') return out;
  // anyOf (2026-11-10: the document lanes' schemas are validated here when a
  // reply arrives through a non-strict tool): valid when ANY branch is.
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf.map((branch) => validateStrictSchema(branch, value, path, []));
    if (!branches.some((violations) => violations.length === 0)) {
      out.push(...(branches.find((violations) => violations.length) || [`${path}: matches no anyOf branch`]));
    }
    return out;
  }
  const allowed = Array.isArray(schema.type) ? schema.type : (schema.type ? [schema.type] : null);
  if (allowed && !allowed.some((type) => matchesType(value, type))) {
    out.push(`${path}: expected ${allowed.join('|')}, got ${typeOf(value)}`);
    return out;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    out.push(`${path}: ${JSON.stringify(value)} not in enum`);
    return out;
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && schema.properties) {
    for (const key of schema.required || []) {
      if (!(key in value)) out.push(`${path}.${key}: required`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (!(key in schema.properties)) {
        if (schema.additionalProperties === false) out.push(`${path}.${key}: not in schema`);
        continue;
      }
      validateStrictSchema(schema.properties[key], child, `${path}.${key}`, out);
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => validateStrictSchema(schema.items, item, `${path}[${index}]`, out));
  }
  return out;
};
