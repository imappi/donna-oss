// Payout statement / deposit slip extraction — RT-18 of
// docs/plan-2026-09-01-runtime-refactor-slices.md (audit F-04 part 2 / F-23;
// the round-4 Desert Rose review §A2 and §D). Parallel to supplierBill.js —
// one strong-model Responses-API call with a strict JSON schema, the same
// writer-shape contract (header + summary + lines), the same error envelope
// and correlation-id PII discipline — but it rides the shared llmCall
// envelope (server/donna/llmCall.js) rather than a bare fetch, so the
// direct-provider ratchet in llmCall.test.js does not grow.
//
// THE FAMILY. Two shapes, one extractor, one document per settlement:
//   - payout_statement: a processor / card acquirer / POS provider /
//     marketplace / delivery platform settlement report — gross customer
//     sales for a period, refunds and fees (often with tax on the fee)
//     deducted, optional adjustments, ONE net amount paid to the firm's
//     bank account, a payout reference and a period or payout date.
//   - deposit_slip: a cash and/or cheque deposit at a branch, counter or
//     ATM — the components deposited and ONE total credited to the account.
// Both are the firm's own revenue ARRIVING (direction incoming); both were
// typed `unknown` before this slice, so the generic extractor invented
// totals (a Deliveroo 2,150 payout read as 308) and no matcher family
// scanned them. Market-neutral by construction: a Deliveroo AED payout and a
// Square USD payout are the same shape.
//
// THE EQUATION. gross − refunds − Σfees(incl. their tax) ± adjustments = net.
// It is checked through validateReceiptTotals's ONE formula (RT-04, F-05):
// the settlement components become SIGNED document lines (gross positive,
// refunds and fees negative, adjustments as signed) and the header total is
// the NET payout, so `expected = Σlines` and the persisted receipt at
// parse_summary.totals_validation carries {expected, total, drift, strategy,
// basis} exactly like a bill's — RT-10's re-read → owner-ask lane reads a
// payout without a special case. A non-footing statement (a deduction the
// provider never printed) rests as `amount_mismatch` with a signed drift,
// never as an invented total.
//
// WHY LINES. The breakdown persisted as document_lines is also how the
// strong coder receives the payout as context: the matched-document
// channel (firmDb.loadMatchedDocumentsForTransactions →
// transactionLlm.matchedDocumentInputFor) already hands the coder a matched
// document's lines, so a money_in bank line matched to this payout sees
// "Gross sales 1,250.00 / Processing fees −36.25" without a second seam.
//
// TAX REGISTRATION IDS. The provider's and the merchant's tax registration
// numbers (a TRN, a VAT number) are persisted on the summary when the
// statement prints them — RT-19 asked RT-12 for this on bills; a family
// born without it would be the next gap.
//
// PII policy mirrors supplierBill.js: never log free-text extracted fields.
// Hash a correlation id from the filename; surface only counts + confidence
// bands in logs.

import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { llmCall } from './llmCall.js';
import { validateReceiptTotals } from './totalsValidation.js';
import { buildClientIdentityPromptFragment } from './clientIdentityPrompt.js';
import { buildResponsesDocumentPart } from './responsesInputPart.js';
import { normalizeIsoCurrency, normalizeIsoOrDayFirstDate } from './parsePrimitives.js';
import { extractionFailureForStatus } from './inngest/parseErrors.js';
import {
  documentLaneRequestFromResponses,
  isProviderStopFailure,
  notConfiguredFailure,
  resolveDocumentLaneProvider,
  stopFailureCode,
  stopFailureReason,
  thrownReason
} from './documentLaneRequest.js';
import { classifyModelProvenance } from './providerEndpoints.js';

// The strong tier for the load-bearing extraction call (CLAUDE.md); the env
// override remains the per-deploy tuning knob.
const DEFAULT_MODEL = 'gpt-5.4';
// 2026-11-10 (the owner's decision that Donna runs on Claude): Anthropic
// first; claude-opus-5-5 reads the settlement document as a document/image
// block with structured output. Gross → fees → net arithmetic read off the
// page earns `high` effort.
const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';
const ANTHROPIC_EFFORT = 'high';
const ANTHROPIC_MAX_TOKENS = 64_000;
const ANTHROPIC_REQUEST_TIMEOUT_MS = 180_000;
// RT-12 (audit F-12): every extraction lane stamps its prompt version on
// the receipt. A string constant per module; bump when the prompt or the
// schema changes meaning.
export const PAYOUT_PROMPT_VERSION = 'payout-statement-extraction-v1';
const REQUEST_TIMEOUT_MS = 60_000;
const UNREADABLE_CONFIDENCE_FLOOR = 0.3;

export const PAYOUT_DOCUMENT_TYPES = Object.freeze(['payout_statement', 'deposit_slip']);
export const PAYOUT_EXTRACTION_SCHEMA_NAME = 'payout_statement_extraction';

const PROVIDER_NAME_MAX = 200;
const DESCRIPTION_MAX = 200;
const REFERENCE_MAX = 80;
const TAX_ID_MAX = 40;
const FEE_LIST_MAX = 12;
const ADJUSTMENT_LIST_MAX = 12;
const COMPONENT_LIST_MAX = 24;
// A component list that does not sum to the printed gross within this
// tolerance is not trusted to replace the single gross line.
const COMPONENT_SUM_TOLERANCE = 0.01;

let dotEnvCache = null;

const readDotEnv = () => {
  if (dotEnvCache) return dotEnvCache;
  const vars = {};
  try {
    const envPath = resolvePath(process.cwd(), '.env');
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, 'utf8').split('\n')) {
        const match = line.match(/^(\w+)=(.*)$/);
        if (match) vars[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
      }
    }
  } catch {
    // best-effort dotenv fallback
  }
  dotEnvCache = vars;
  return vars;
};

// PAYOUT_EXTRACTOR_MODEL is the lane knob (its id pins the provider); no
// provider-wide knob.
const getOpenAiConfig = () => resolveDocumentLaneProvider({
  laneId: 'type_extractors_legacy',
  dotEnv: readDotEnv(),
  modelEnvKeys: ['PAYOUT_EXTRACTOR_MODEL'],
  defaultModels: { anthropic: DEFAULT_ANTHROPIC_MODEL, openai: DEFAULT_MODEL }
});

const outputTextFromResponse = (response = {}) => {
  if (typeof response.output_text === 'string') return response.output_text;
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === 'string') return content.text;
    }
  }
  return '';
};

const trimBase64 = (value = '') => String(value || '').replace(/[\r\n\s]/g, '');

const filenameCorrelationId = (filename = '') =>
  crypto.createHash('sha256').update(String(filename || 'unknown')).digest('hex').slice(0, 12);

const numberOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

// Money is carried at 2 dp on lines and the receipt — float noise from a
// provider's "36.250000001" must never reach document_lines.amount.
const round2 = (value) => (value == null ? null : Math.round((value + Number.EPSILON) * 100) / 100);

// Deductions are MAGNITUDES in the schema (a fee of 36.25, never −36.25);
// a model that returns the printed negative is read as the same magnitude.
const magnitudeOrNull = (value) => {
  const num = numberOrNull(value);
  return num == null ? null : Math.abs(num);
};

const integerOrNull = (value) => {
  const num = numberOrNull(value);
  return num == null ? null : Math.round(num);
};

const dayFirstHint = (hint) => /DD\/MM\/YYYY-convention/.test(String(hint || ''));
const isoDate = (value, hint) => normalizeIsoOrDayFirstDate(value, { allowDayFirst: dayFirstHint(hint) });

// Strip control chars + cap to a safe payload length. Used on every
// free-text field the LLM might emit.
const sanitizeText = (value, maxLength) => {
  if (value == null) return null;
  const cleaned = String(value).replace(/[\x00-\x1F\x7F]/g, '').trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLength);
};

const sanitizeLast4 = (value) => {
  const digits = String(value || '').replace(/\D/g, '');
  return digits ? digits.slice(-4) : null;
};

// JSON schema for the Responses-API strict mode. Every property listed in
// `required`, `additionalProperties: false` everywhere — the same discipline
// as BILL_EXTRACTION_SCHEMA. Magnitudes: gross_sales, refunds, fees[].amount,
// fees[].tax_amount and net_payout are positive numbers as printed;
// adjustments[].amount is SIGNED (positive adds to the payout, negative
// reduces it) because an adjustment can go either way.
const PAYOUT_EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'extraction_status',
    'extraction_confidence',
    'warnings',
    'document_kind',
    'provider_name',
    'provider_tax_id',
    'merchant_name',
    'merchant_tax_id',
    'period_start',
    'period_end',
    'payout_date',
    'currency',
    'gross_sales',
    'gross_components',
    'refunds',
    'fees',
    'adjustments',
    'net_payout',
    'transaction_count',
    'payout_reference',
    'deposit_reference',
    'bank_last4'
  ],
  properties: {
    extraction_status: { type: 'string', enum: ['validated', 'partial', 'failed'] },
    extraction_confidence: { type: 'number' },
    warnings: { type: 'array', items: { type: 'string' } },
    document_kind: { type: 'string', enum: [...PAYOUT_DOCUMENT_TYPES] },
    provider_name: { type: ['string', 'null'] },
    provider_tax_id: { type: ['string', 'null'] },
    merchant_name: { type: ['string', 'null'] },
    merchant_tax_id: { type: ['string', 'null'] },
    period_start: { type: ['string', 'null'] },
    period_end: { type: ['string', 'null'] },
    payout_date: { type: ['string', 'null'] },
    currency: { type: ['string', 'null'] },
    gross_sales: { type: ['number', 'null'] },
    gross_components: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['description', 'amount'],
        properties: {
          description: { type: ['string', 'null'] },
          amount: { type: ['number', 'null'] }
        }
      }
    },
    refunds: { type: ['number', 'null'] },
    fees: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['description', 'amount', 'tax_amount'],
        properties: {
          description: { type: ['string', 'null'] },
          amount: { type: ['number', 'null'] },
          tax_amount: { type: ['number', 'null'] }
        }
      }
    },
    adjustments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['description', 'amount'],
        properties: {
          description: { type: ['string', 'null'] },
          amount: { type: ['number', 'null'] }
        }
      }
    },
    net_payout: { type: ['number', 'null'] },
    transaction_count: { type: ['integer', 'null'] },
    payout_reference: { type: ['string', 'null'] },
    deposit_reference: { type: ['string', 'null'] },
    bank_last4: { type: ['string', 'null'] }
  }
};

const INSTRUCTIONS = `You are extracting fields from a single settlement document that records the firm's OWN sales proceeds arriving in its bank account. Two kinds exist:
  - "payout_statement": a settlement / payout / remittance report from a payment processor, card acquirer, POS provider, marketplace or delivery platform (Stripe, Square, Adyen, PayPal, Shopify Payments, Clover, SumUp, Toast, Deliveroo, Talabat, Uber Eats, Careem, DoorDash, Just Eat, Amazon, Etsy, …): gross customer sales for a period, refunds and fees deducted, optional adjustments, ONE net amount paid to the firm.
  - "deposit_slip": a cash and/or cheque deposit at a bank branch, counter or ATM (a paying-in slip, counter deposit receipt, ATM deposit receipt, cheque deposit advice): the notes, coins and cheques deposited and ONE total credited to the firm's account.
The firm is the MERCHANT / account holder; the provider (the processor, platform or bank) is the counterparty. The firm's identity is supplied separately — use it to tell the two apart. Never invent a value: return null for anything the document does not show.

Return only the requested structured object.

document_kind: "payout_statement" or "deposit_slip" per the definitions above.
provider_name: the processor / platform / bank that issued the document — the shortest recognisable brand name ("Stripe" not "Stripe Payments UK Ltd", "Deliveroo" not "Roofoods Ltd"; for a deposit slip, the bank).
provider_tax_id: the provider's tax registration number as printed (a VAT number, a TRN, a GST number), null if absent.
merchant_name: the firm as the provider names it (the merchant / partner / account holder line), null if absent.
merchant_tax_id: the firm's tax registration number as printed on the document, null if absent.
period_start / period_end: the settlement period in YYYY-MM-DD form, null when the document shows no period (a deposit slip usually has none).
payout_date: the date the money was paid or deposited into the firm's bank account (the payout / transfer / deposit date), YYYY-MM-DD. If the document shows only a period, leave payout_date null.
currency: the ISO-4217 code of the settlement; infer from the symbol or locale if not spelled out.
gross_sales: the gross amount BEFORE deductions — total customer sales / gross receipts / gross card volume for a payout; the total amount deposited for a deposit slip (the sum of cash and cheques). A positive magnitude.
gross_components: how the gross is made up when the document itemises it — a deposit slip's cash and each cheque (description = "Cash" / "Cheque 005521 Northgate Ltd"), a payout's per-channel or per-day sales subtotals. Each amount is a positive magnitude and the list must sum to gross_sales; return [] when the document shows only one gross figure.
refunds: refunds / returns / chargebacks deducted from the gross, as a positive magnitude; 0 when the document shows none.
fees: one entry per fee or commission line the provider deducted (processing fees, commission, service charge, delivery fee retained, platform fee, subscription retained). "amount" is the fee as printed EXCLUDING any tax on it; "tax_amount" is the tax (VAT / GST) charged on that fee when the document shows it separately, else 0. Both positive magnitudes. Return [] for a deposit slip with no bank charge.
adjustments: anything else that moves the payout and is not a refund or a fee — reserve holds and releases, chargeback reversals, promotional co-funding, tips paid out, corrections. "amount" is SIGNED: positive adds to the net payout, negative reduces it. Return [] when none.
net_payout: THE amount that actually reached (or will reach) the firm's bank account — the net payout / net settlement / amount transferred / total deposited. A positive magnitude. This is the number a bank statement will show.
transaction_count: the number of sales / orders / items the payout covers when printed, else null.
payout_reference: the payout / settlement / statement / transfer reference the provider prints — the identifier most likely to appear on the bank line (e.g. "PO-88121", "STRIPE PAYOUT po_1Nx…", a settlement id). Null if none.
deposit_reference: a deposit slip's slip / receipt / reference number. Null for a payout.
bank_last4: the last four digits of the firm's bank account the money went to, when printed; digits only.

Arithmetic discipline: gross_sales − refunds − Σ(fees.amount + fees.tax_amount) + Σadjustments.amount should equal net_payout. Report the figures AS PRINTED even when they do not foot — a deduction the provider did not print is exactly what downstream needs to see; never adjust a number to make the equation balance and never invent a line.

extraction_confidence is your 0–1 confidence the extracted values are usable. extraction_status is "validated" when every load-bearing field (provider, net_payout, currency, a date) was readable, "partial" when some were, "failed" if you could not read enough.`;

const sanitizeComponents = (raw, max) => {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const amount = numberOrNull(entry.amount);
    if (amount == null) continue;
    out.push({
      description: sanitizeText(entry.description, DESCRIPTION_MAX),
      amount: round2(amount)
    });
    if (out.length >= max) break;
  }
  return out;
};

const sanitizeFees = (raw) => {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const amount = magnitudeOrNull(entry.amount);
    const taxAmount = magnitudeOrNull(entry.tax_amount) ?? 0;
    if (amount == null && !(taxAmount > 0)) continue;
    out.push({
      description: sanitizeText(entry.description, DESCRIPTION_MAX),
      amount: round2(amount ?? 0),
      tax_amount: round2(taxAmount)
    });
    if (out.length >= FEE_LIST_MAX) break;
  }
  return out;
};

const sum = (values) => round2(values.reduce((acc, value) => acc + (Number(value) || 0), 0));

const formatMoney = (value) => (value == null ? '' : Number(value).toFixed(2));

// The settlement breakdown as SIGNED document lines — the writer persists
// them as document_lines and validateReceiptTotals sums them against the
// NET header total. Gross first (one line, or the itemised components when
// they foot to the gross), then refunds, each fee (incl. its tax), each
// adjustment as signed.
const buildSettlementLines = ({ kind, gross, components, refunds, fees, adjustments, transactionCount, warnings }) => {
  const lines = [];
  const line = (description, amount) => ({
    description,
    quantity: 1,
    unit_price: round2(amount),
    amount: round2(amount),
    tax_rate: null
  });
  const grossLabel = kind === 'deposit_slip' ? 'Deposit total' : 'Gross sales';
  if (gross != null) {
    const componentSum = components.length ? sum(components.map((c) => c.amount)) : null;
    if (components.length && componentSum != null && Math.abs(componentSum - gross) <= COMPONENT_SUM_TOLERANCE) {
      for (const component of components) {
        lines.push(line(component.description || grossLabel, component.amount));
      }
    } else {
      if (components.length && !warnings.includes('gross_components_mismatch')) {
        warnings.push('gross_components_mismatch');
      }
      const countNote = transactionCount != null ? ` (${transactionCount} ${kind === 'deposit_slip' ? 'items' : 'transactions'})` : '';
      lines.push(line(`${grossLabel}${countNote}`, gross));
    }
  }
  if (refunds != null && refunds > 0) {
    lines.push(line('Refunds', -refunds));
  }
  for (const fee of fees) {
    const deducted = round2((fee.amount || 0) + (fee.tax_amount || 0));
    if (!(deducted > 0)) continue;
    const taxNote = fee.tax_amount > 0 ? ` (incl. tax ${formatMoney(fee.tax_amount)})` : '';
    lines.push(line(`${fee.description || 'Fees'}${taxNote}`, -deducted));
  }
  for (const adjustment of adjustments) {
    if (adjustment.amount == null || adjustment.amount === 0) continue;
    lines.push(line(adjustment.description || 'Adjustment', adjustment.amount));
  }
  return lines;
};

// Map the raw LLM response to the writer-shape contract shared with the
// bill / receipt / invoice extractors:
//   - `header` lands on the documents row (vendor_name = the provider — the
//     name the bank line quotes; total_amount = the NET payout — the amount
//     the matcher looks for on the money_in feed; payment_status = paid, a
//     payout is settled by construction; reference_number = the payout or
//     deposit reference).
//   - `summary` is the parse_summary jsonb: document_type = the dispatched
//     type (the row's type — the model's own reading is kept at
//     settlement.kind and a disagreement is a warning), the settlement
//     breakdown under `settlement`, the tax ids under
//     `tax_registration_ids`, the parties with roles, and the RT-04 totals
//     receipt under `totals_validation`.
//   - `lines` is the signed settlement breakdown (see buildSettlementLines).
const mapExtractionToWriterShape = (parsed, { dateFormatHint = '', documentType = null } = {}) => {
  const modelKind = PAYOUT_DOCUMENT_TYPES.includes(parsed?.document_kind) ? parsed.document_kind : null;
  const kind = PAYOUT_DOCUMENT_TYPES.includes(documentType) ? documentType : (modelKind || 'payout_statement');

  const warnings = Array.isArray(parsed?.warnings)
    ? parsed.warnings.map((w) => String(w).slice(0, 200)).slice(0, 6)
    : [];
  if (modelKind && modelKind !== kind && !warnings.includes('settlement_kind_disagrees')) {
    warnings.push('settlement_kind_disagrees');
  }

  const providerName = sanitizeText(parsed?.provider_name, PROVIDER_NAME_MAX);
  const merchantName = sanitizeText(parsed?.merchant_name, PROVIDER_NAME_MAX);
  const providerTaxId = sanitizeText(parsed?.provider_tax_id, TAX_ID_MAX);
  const merchantTaxId = sanitizeText(parsed?.merchant_tax_id, TAX_ID_MAX);
  const periodStart = isoDate(parsed?.period_start, dateFormatHint);
  const periodEnd = isoDate(parsed?.period_end, dateFormatHint);
  const payoutDate = isoDate(parsed?.payout_date, dateFormatHint);
  const currency = normalizeIsoCurrency(parsed?.currency);
  const gross = round2(magnitudeOrNull(parsed?.gross_sales));
  const components = sanitizeComponents(parsed?.gross_components, COMPONENT_LIST_MAX)
    .map((c) => ({ ...c, amount: Math.abs(c.amount) }));
  const refunds = round2(magnitudeOrNull(parsed?.refunds)) ?? 0;
  const fees = sanitizeFees(parsed?.fees);
  const adjustments = sanitizeComponents(parsed?.adjustments, ADJUSTMENT_LIST_MAX);
  const net = round2(magnitudeOrNull(parsed?.net_payout));
  const transactionCount = integerOrNull(parsed?.transaction_count);
  const payoutReference = sanitizeText(parsed?.payout_reference, REFERENCE_MAX);
  const depositReference = sanitizeText(parsed?.deposit_reference, REFERENCE_MAX);
  const bankLast4 = sanitizeLast4(parsed?.bank_last4);
  const extractionConfidence = numberOrNull(parsed?.extraction_confidence);

  const lines = buildSettlementLines({ kind, gross, components, refunds, fees, adjustments, transactionCount, warnings });

  if (net == null && !warnings.includes('net_payout_missing')) warnings.push('net_payout_missing');
  if (lines.length === 0 && !warnings.includes('no_settlement_breakdown')) warnings.push('no_settlement_breakdown');

  const feeTotal = sum(fees.map((fee) => fee.amount));
  const feeTaxTotal = sum(fees.map((fee) => fee.tax_amount));
  const adjustmentTotal = sum(adjustments.map((adjustment) => adjustment.amount));

  // The provider is the counterparty the bank line names ("PAYLINK PAYOUT
  // PO-88121", "DELIVEROO"), so it rides vendor_name exactly as a bill's
  // supplier does; the firm's own name is never written into its own row.
  const header = {
    vendor_name: providerName,
    customer_name: null,
    document_date: payoutDate || periodEnd || null,
    due_date: null,
    total_amount: net,
    currency,
    // No document-level tax: the tax on a fee is the fee's, kept on the
    // settlement block — putting it here would hand validateReceiptTotals a
    // second roll-up to prefer.
    tax_amount: null,
    reference_number: payoutReference || depositReference || null,
    // Settled by construction — the money moved when the document was
    // issued. The matcher's settlement guard keys on an ACTUAL prior matched
    // bank line, never on this status (the payment_confirmation precedent).
    payment_status: 'paid',
    extraction_confidence: extractionConfidence
  };

  const parties = [];
  if (merchantName) parties.push({ role: 'merchant', name: merchantName });
  if (providerName) parties.push({ role: kind === 'deposit_slip' ? 'bank' : 'processor', name: providerName });

  const summary = {
    source: 'async_parse',
    prompt_version: PAYOUT_PROMPT_VERSION,
    document_type: kind,
    counterparty_name: providerName,
    counterparty_role: kind === 'deposit_slip' ? 'bank' : 'processor',
    document_date: header.document_date,
    period_start_date: periodStart,
    period_end_date: periodEnd,
    currency,
    // Deliberately no subtotal / tax on the summary (see header.tax_amount):
    // the ONE roll-up validateReceiptTotals may try is Σlines = net.
    subtotal_amount: null,
    tax_amount: null,
    shipping_amount: null,
    discount_amount: null,
    rounding_amount: null,
    total_amount: net,
    line_amounts_include_tax: true,
    settlement: {
      kind: modelKind || kind,
      provider_name: providerName,
      provider_tax_id: providerTaxId,
      merchant_name: merchantName,
      merchant_tax_id: merchantTaxId,
      period_start: periodStart,
      period_end: periodEnd,
      payout_date: payoutDate,
      currency,
      gross_sales: gross,
      gross_components: components,
      refunds,
      fees,
      fee_total: feeTotal,
      fee_tax_total: feeTaxTotal,
      adjustments,
      adjustment_total: adjustmentTotal,
      net_payout: net,
      transaction_count: transactionCount,
      payout_reference: payoutReference,
      deposit_reference: depositReference,
      bank_last4: bankLast4
    },
    tax_registration_ids: {
      seller: providerTaxId,
      buyer: merchantTaxId
    },
    parties,
    references: [
      ...(payoutReference ? [{ type: 'transaction_id', value: payoutReference }] : []),
      ...(depositReference ? [{ type: 'receipt_number', value: depositReference }] : [])
    ],
    line_count: lines.length,
    coded_line_count: 0,
    review_line_count: 0,
    extraction_status: parsed?.extraction_status,
    extraction_confidence: extractionConfidence,
    warnings
  };

  // THE equation, through THE formula (RT-04): Σ(signed lines) = net. The
  // receipt is persisted whole so a mismatch can be read from parse_summary
  // with its numbers; a non-footing statement adds 'amount_mismatch', which
  // the worker turns into review rows for every line (the bill precedent).
  if (lines.length > 0 && net != null) {
    const totals = validateReceiptTotals({ summary, lines });
    summary.totals_validation = totals;
    if (!totals.matches && !summary.warnings.includes('amount_mismatch')) {
      summary.warnings.push('amount_mismatch');
    }
  }

  return { header, summary, lines };
};

const buildUserContent = ({ dataUrl, filename, dateFormatHint, documentType }) => {
  const hint = documentType === 'deposit_slip'
    ? 'The upload was routed as a deposit slip.'
    : documentType === 'payout_statement'
      ? 'The upload was routed as a payout statement.'
      : '';
  const userContent = [
    buildResponsesDocumentPart({ dataUrl, filename, fallbackFilename: 'payout-statement.pdf' }),
    { type: 'input_text', text: `Extract the settlement document per the schema.${hint ? ` ${hint}` : ''}` }
  ];
  if (dateFormatHint) {
    userContent.push({ type: 'input_text', text: dateFormatHint });
  }
  return userContent;
};

// Public extractor — same `{ base64, filename, mimeType, dateFormatHint,
// clientIdentity }` in → discriminated-union out as supplierBill.js, plus
// `documentType` (which of the two types the router dispatched) and
// `documentId` (the typed execution root for the llmCall receipt).
//
//   { kind: 'completed', model, header, summary, lines }
//   { kind: 'failed', code: 'DOCUMENT_EXTRACTION_FAILED' }     // retryable (5xx/timeout/429/network)
//   { kind: 'failed', code: 'DOCUMENT_EXTRACTION_REJECTED' }   // terminal (deterministic 4xx)
//   { kind: 'failed', code: 'DOCUMENT_EXTRACTION_UNREADABLE' } // terminal
export const extractPayoutStatementFromBase64 = async ({
  base64,
  filename = '',
  mimeType = '',
  dateFormatHint = '',
  clientIdentity = null,
  documentType = 'payout_statement',
  documentId = null,
  // Transport seam: the llmCall envelope's fetch. Resolved at call time so
  // the recorded-providers stub (globalThis.fetch) serves the appliance
  // fixtures without a module seam.
  fetchImpl = null
} = {}) => {
  const startedAt = Date.now();
  const correlationId = filenameCorrelationId(filename);
  const config = getOpenAiConfig();
  const kind = PAYOUT_DOCUMENT_TYPES.includes(documentType) ? documentType : 'payout_statement';

  if (!config.ok) {
    // No key: the failure names the provider whose key is missing (the
    // lane's first, Anthropic, unless a pinned model id chose another).
    const { provider: missing, reason: notConfigured } = notConfiguredFailure(config, 'type_extractors_legacy');
    console.warn('[payout-statement] no model provider key configured', { correlation_id: correlationId, reason: notConfigured });
    return {
      kind: 'failed',
      model: null,
      provider: missing,
      code: 'DOCUMENT_EXTRACTION_FAILED',
      reason: notConfigured
    };
  }

  const clean = trimBase64(base64);
  if (!clean) {
    return {
      kind: 'failed',
      model: config.model,
      code: 'DOCUMENT_EXTRACTION_UNREADABLE',
      reason: 'empty_input'
    };
  }

  const dataUrl = `data:${mimeType || 'application/pdf'};base64,${clean}`;
  const instructions = `${INSTRUCTIONS}${buildClientIdentityPromptFragment(clientIdentity)}`;
  const userContent = buildUserContent({ dataUrl, filename, dateFormatHint, documentType: kind });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.provider === 'anthropic' ? ANTHROPIC_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
  const transport = (...args) => (fetchImpl || globalThis.fetch)(...args);
  // The request body, built once; the Anthropic transport carries it over
  // unchanged (instructions → system, the file part → a document/image
  // block, the strict schema → structured output).
  const body = {
    model: config.model,
    store: false,
    instructions,
    input: [{ role: 'user', content: userContent }],
    text: {
      format: {
        type: 'json_schema',
        name: PAYOUT_EXTRACTION_SCHEMA_NAME,
        strict: true,
        schema: PAYOUT_EXTRACTION_SCHEMA
      }
    }
  };
  const execution = { root: { type: 'document_extraction', id: documentId || correlationId } };
  const parseText = (text, servedModel) => {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw Object.assign(new Error('structured response was not valid JSON'), { code: 'PAYOUT_STRUCTURED_BAD_JSON', servedModel });
    }
    return { parsed, servedModel };
  };
  const stamp = (servedModel) => {
    const provenance = classifyModelProvenance({ responseModel: servedModel, requestedModel: config.model });
    return { model: provenance.model, model_source: provenance.model_source, provider: config.provider };
  };

  let result;
  try {
    if (config.provider === 'anthropic') {
      // The shared structured request (structuredRequest.js, via
      // documentLaneRequest.js): the answer is already parsed and held to
      // the schema; the model is the response's.
      const { result: answer } = await llmCall(documentLaneRequestFromResponses({
        apiKey: config.apiKey,
        body,
        effort: ANTHROPIC_EFFORT,
        maxTokens: ANTHROPIC_MAX_TOKENS,
        execution,
        promptVersion: PAYOUT_PROMPT_VERSION,
        signal: controller.signal,
        timeoutMs: ANTHROPIC_REQUEST_TIMEOUT_MS,
        fetchImpl: transport
      }));
      result = { parsed: answer.parsed, servedModel: answer.model || null };
    } else ({ result } = await llmCall({
      provider: 'openai',
      // The lane's own wall, honoured inside a worker too (llmCall hands it to
      // the deadline transport, bounded by the job's remaining budget).
      timeoutMs: REQUEST_TIMEOUT_MS,
      url: 'https://api.openai.com/v1/responses',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`
      },
      body,
      // Sizes only (llmCall rail 1). The document bytes are deliberately not
      // measured as a section — the envelope would stringify megabytes for a
      // number the body length already carries.
      sections: {
        system: instructions,
        tools: PAYOUT_EXTRACTION_SCHEMA,
        context: userContent.filter((part) => part.type === 'input_text')
      },
      execution,
      promptVersion: PAYOUT_PROMPT_VERSION,
      parseResponse: (payload) => parseText(outputTextFromResponse(payload), typeof payload?.model === 'string' && payload.model ? payload.model : null),
      fetchImpl: (url, init) => transport(url, { ...init, signal: controller.signal })
    }));
  } catch (err) {
    if (err?.code === 'LLM_CALL_PROVIDER_ERROR') {
      console.error('[payout-statement] provider returned non-OK', {
        correlation_id: correlationId,
        provider: config.provider,
        status: err.status,
        elapsed_ms: Date.now() - startedAt
      });
      return { ...extractionFailureForStatus(Number(err.status || 0), { provider: config.provider, providerError: err.providerError || null }), ...stamp(null) };
    }
    if (isProviderStopFailure(err)) {
      // A refusal or a cut-off reply will not clear with a retry of the same
      // request: terminal, named, receipted with the model that gave it. An
      // answer that is not the structured answer is retryable (stopFailureCode).
      console.error('[payout-statement] provider stopped without a usable reply', {
        correlation_id: correlationId, provider: config.provider, failure: err.code, reason: err.reason, elapsed_ms: Date.now() - startedAt
      });
      return { kind: 'failed', ...stamp(err.servedModel), code: stopFailureCode(err), reason: stopFailureReason(err) };
    }
    if (err?.code === 'PAYOUT_STRUCTURED_BAD_JSON') {
      console.error('[payout-statement] structured response was not valid JSON', {
        correlation_id: correlationId,
        elapsed_ms: Date.now() - startedAt
      });
      return {
        kind: 'failed',
        ...stamp(err.servedModel || null),
        code: 'DOCUMENT_EXTRACTION_FAILED',
        reason: 'structured_bad_json'
      };
    }
    if (['trial_spend_cap_refused', 'PROVIDER_SPEND_LIMIT'].includes(err?.code)) throw err;
    console.error('[payout-statement] provider request threw', {
      correlation_id: correlationId,
      provider: config.provider,
      error_code: err?.code || null,
      error_name: err?.name || null,
      elapsed_ms: Date.now() - startedAt
    });
    return {
      kind: 'failed',
      ...stamp(null),
      code: 'DOCUMENT_EXTRACTION_FAILED',
      reason: thrownReason(err)
    };
  } finally {
    clearTimeout(timeout);
  }

  const { parsed } = result;
  const served = stamp(result.servedModel);
  const { model } = served;
  const confidence = Number(parsed?.extraction_confidence || 0);
  if (parsed?.extraction_status === 'failed' || confidence < UNREADABLE_CONFIDENCE_FLOOR) {
    console.warn('[payout-statement] extraction below floor', {
      correlation_id: correlationId,
      extraction_status: parsed?.extraction_status || null,
      confidence_band: confidence < 0.1 ? '<0.1' : confidence < 0.3 ? '0.1-0.3' : '>=0.3',
      elapsed_ms: Date.now() - startedAt
    });
    return {
      kind: 'failed',
      ...served,
      code: 'DOCUMENT_EXTRACTION_UNREADABLE',
      reason: parsed?.extraction_status === 'failed' ? 'extractor_status_failed' : 'low_confidence'
    };
  }

  const { header, summary, lines } = mapExtractionToWriterShape(parsed, { dateFormatHint, documentType: kind });

  console.log('[payout-statement] extraction complete', {
    correlation_id: correlationId,
    document_type: kind,
    extraction_status: summary.extraction_status,
    has_provider: Boolean(header.vendor_name),
    has_date: Boolean(header.document_date),
    has_net: header.total_amount != null,
    has_currency: Boolean(header.currency),
    has_reference: Boolean(header.reference_number),
    line_count: lines.length,
    fee_count: summary.settlement.fees.length,
    totals_match: summary.totals_validation ? summary.totals_validation.matches : null,
    confidence_band: confidence < 0.5 ? '<0.5' : confidence < 0.8 ? '0.5-0.8' : '>=0.8',
    warning_count: summary.warnings.length,
    elapsed_ms: Date.now() - startedAt
  });

  return { kind: 'completed', ...served, header, summary, lines };
};

// Test seams.
export const __PAYOUT_EXTRACTION_SCHEMA = PAYOUT_EXTRACTION_SCHEMA;
export const __PAYOUT_INSTRUCTIONS = INSTRUCTIONS;
export const __mapExtractionToWriterShape = mapExtractionToWriterShape;
export const __buildSettlementLines = buildSettlementLines;
