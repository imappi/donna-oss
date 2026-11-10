import { isProviderSpendLimit } from './providerTransport.js';
// Unified extractor — THE load-bearing extraction call (modelLanes.js
// `unified_extraction`), provider-agnostic since RT-12 of
// docs/plan-2026-09-01-runtime-refactor-slices.md (decision D1; audit F-12 /
// F-15; docs/donna-llm-trust-strategy.md §3 Slice B).
//
// One strong-model call that CLASSIFIES the document and EXTRACTS its fields
// in a single pass, for every reconcilable document type: receipt,
// supplier_bill, sales_invoice, issued_receipt, payment_confirmation,
// payment_account_statement, contract, payout_statement, deposit_slip. The
// model's `document_type` is the classification downstream trusts (the
// router picks which prompt hint to send; it does not decide AP vs AR).
//
// WHAT CHANGED IN RT-12 (and why):
//  - The EXTRACTOR_MODE / EXTRACTOR_FAMILIES / EXTRACTOR_CLIENTS env cluster
//    and the EXTRACTOR_UNIFIED_<TYPE> plane keys are DELETED. They gated a
//    lane nobody seeded on the appliance, so the "retirement candidates" were
//    the production extractors (audit F-15). On the appliance the unified
//    extractor is now the CODE DEFAULT (`unifiedExtractorServes`); the cloud
//    keeps the per-type path for one release. The only env left is the kill
//    switch (UNIFIED_EXTRACTOR_DISABLED=true) and two tuning knobs
//    (UNIFIED_EXTRACTOR_PROVIDER, UNIFIED_EXTRACTOR_MODEL) — the classes the
//    flags rail permits env to keep.
//  - The transport rides the shared llmCall envelope on BOTH providers:
//    OpenAI (Responses API, json_schema strict) and Anthropic (Messages API,
//    since 2026-11-10 the shared structured request, structuredRequest.js
//    anthropicStructuredRequest via documentLaneRequest.js — its schema is
//    past the grammar's limits, so the answer is the one `structured_answer`
//    tool call — then the SAME schema validated after parse, as before). The provider
//    is resolved from the keys present (anthropic preferred when both are);
//    the model id on every receipt is the one the RESPONSE named.
//  - A read below the confidence floor, or one the model self-reports as
//    failed, no longer loses the header the model DID return: the failure
//    envelope carries `partial_header`, which the worker persists on
//    parse_summary.partial_header before the parse rests failed (F-12).
//  - Every result stamps `prompt_version` (UNIFIED_EXTRACTOR_PROMPT_VERSION);
//    modelLanes.js records the same constant on the lane.
//
// Output envelope — the writer-shape the per-type extractors produced, so
// parseDocumentsDb.writeParsedDocumentExtractionInDb is unchanged:
//   { kind: 'completed_header', document_type, header, summary, lines,
//     provider, model, model_source, prompt_version }
//   { kind: 'failed', code, reason, retryable, provider, model, model_source,
//     prompt_version, partial_header }
// `code` is the parseErrors.js vocabulary (DOCUMENT_EXTRACTION_FAILED /
// _REJECTED / _UNREADABLE) so the worker can throw it as a ParseError;
// `retryable` says whether the queue should retry (a transport failure) or
// the read is final (unreadable, rejected, schema-invalid).

import { normalizeSourceBusinessUse } from './sourceBusinessUse.js';
import crypto from 'node:crypto';

import { llmCall } from './llmCall.js';
import {
  anthropicFileBlock,
  documentLaneAnthropicRequest,
  isProviderStopFailure,
  stopFailureReason,
  stopFailureRetryable
} from './documentLaneRequest.js';
import { extractJson } from './extractJson.js';
import { buildClientIdentityPromptFragment } from './clientIdentityPrompt.js';
import { buildCorrectionsPromptFragment } from './documentCorrections.js';
import { buildResponsesDocumentPart } from './responsesInputPart.js';
import { normalizeIsoOrDayFirstDate, normalizeValidIsoDate, normalizeIsoCurrency } from './parsePrimitives.js';
import { classifyModelProvenance, resolveLaneProvider } from './providerEndpoints.js';
import { validateReceiptTotals } from './totalsValidation.js';
import { extractionFailureForStatus } from './inngest/parseErrors.js';
import { isDesktopHostEnv } from './desktop/hostPlaneSeed.js';
import {
  UNIFIED_EXTRACTION_SCHEMA,
  UNIFIED_EXTRACTION_SCHEMA_NAME,
  UNIFIED_DOCUMENT_TYPES,
  UNIFIED_EXTRACTOR_TYPES,
  SETTLEMENT_DOCUMENT_TYPES,
  LINE_BEARING_DOCUMENT_TYPES,
  COUNTERPARTY_ROLE_VALUES,
  PAYMENT_STATUS_VALUES,
  EXTRACTION_STATUS_VALUES,
  REFERENCE_TYPE_VALUES,
  CONTRACT_TYPE_VALUES,
  RECURRING_FREQUENCY_VALUES,
  OBLIGATION_TYPE_VALUES,
  OBLIGATION_FREQUENCY_VALUES,
  OBLIGATION_PARTY_ROLE_VALUES,
  validateStrictSchema
} from './unifiedExtractorSchema.js';

export { UNIFIED_EXTRACTOR_TYPES, UNIFIED_DOCUMENT_TYPES } from './unifiedExtractorSchema.js';

// A string constant per module (audit F-12): bump when the prompt or the
// schema changes meaning. modelLanes.js pins the same value on the lane.
export const UNIFIED_EXTRACTOR_PROMPT_VERSION = 'unified-extraction-v8';

// The qualified providers, in preference order when more than one key is
// present. The lane's qualified MODEL set (modelLanes.js) is value-synced
// with these defaults by modelLanes.test.js.
export const UNIFIED_EXTRACTOR_PROVIDERS = Object.freeze(['anthropic', 'openai']);
// The Anthropic default stays claude-opus-4-8 (the owner's direction of
// 2026-11-10: the unified lane keeps its measured model; only its request
// moved onto the shared structured seam). UNIFIED_EXTRACTOR_MODEL may pin
// another id.
export const UNIFIED_EXTRACTOR_DEFAULT_MODELS = Object.freeze({
  anthropic: 'claude-opus-4-8',
  openai: 'gpt-5.4'
});
// Depth per call (adaptive thinking, on claude-opus-4-8 as on the 5.x
// models): a full classification + field extraction feeding the books is
// the work that repays depth, so `high`. Room for thinking plus a long
// line list.
export const UNIFIED_EXTRACTOR_ANTHROPIC_EFFORT = 'high';
const ANTHROPIC_MAX_TOKENS = 64_000;

// Env the module still reads — each in a class the flags rail permits:
//   - the kill switch (env may KILL a behaviour, never silently enable one);
//   - two tuning knobs (provider pin, model id), same class as *_MODEL.
export const UNIFIED_EXTRACTOR_KILL_SWITCH = 'UNIFIED_EXTRACTOR_DISABLED';
export const UNIFIED_EXTRACTOR_PROVIDER_ENV = 'UNIFIED_EXTRACTOR_PROVIDER';
export const UNIFIED_EXTRACTOR_MODEL_ENV = 'UNIFIED_EXTRACTOR_MODEL';

const REQUEST_TIMEOUT_MS = 120_000;
const UNREADABLE_CONFIDENCE_FLOOR = 0.3;
const NAME_MAX = 200;
const DESCRIPTION_MAX = 500;
const REFERENCE_VALUE_MAX = 80;
const REFERENCE_LIST_MAX = 8;
const TAX_ID_MAX = 40;
const FEE_LIST_MAX = 12;
const ADJUSTMENT_LIST_MAX = 12;
const COMPONENT_LIST_MAX = 24;
const COMPONENT_SUM_TOLERANCE = 0.01;
// RT-21b: settlement rows on a multi-settlement statement (a monthly
// koontilasku of weekly card payouts is 4–5 rows; a daily one is ≤ 31; the
// bound is a sanity cap, never a truncation that hides a row silently — the
// truncation is receipted as a warning).
const SETTLEMENT_ROW_LIST_MAX = 62;
// Per-row rounding: Σ row nets may drift from the printed statement net by
// one cent per row (each row's fee is rounded on the page).
const SETTLEMENT_ROW_SUM_TOLERANCE_PER_ROW = 0.01;
const OBLIGATIONS_MAX = 10;
const EVIDENCE_SNIPPET_MAX = 300;

// ── does the unified extractor serve this document on this host? ─────────
// The appliance default (D1): every reconcilable type, unless the kill
// switch is set. The cloud keeps the per-type path for ONE release (the
// plan's canary window), so a cloud parse resolves `unified:false` with the
// reason on the receipt. `hostClass` lets a caller state the host explicitly
// (tests); absent, the desktop host signal decides — the same convention
// hostPlaneSeed.js uses.
export const unifiedExtractorServes = ({ documentType, env = process.env, hostClass = null } = {}) => {
  if (!UNIFIED_EXTRACTOR_TYPES.includes(documentType)) {
    return { unified: false, reason: `type_not_unified:${documentType || 'unknown'}` };
  }
  if (String(env?.[UNIFIED_EXTRACTOR_KILL_SWITCH] || '').trim().toLowerCase() === 'true') {
    return { unified: false, reason: 'kill_switch' };
  }
  const desktop = hostClass ? hostClass === 'desktop' : isDesktopHostEnv(env);
  if (!desktop) return { unified: false, reason: 'cloud_per_type_release' };
  return { unified: true, reason: 'appliance_default' };
};

// ── provider resolution ────────────────────────────────────────────────
// Which provider answers the call, and with which model. Order of
// authority: an explicit `provider` argument, then the env pin, then the
// provider a pinned model id belongs to, then KEY PRESENCE in the registry's
// preference order. The model is the explicit argument, else the env knob
// (only when it belongs to the resolved provider — a claude id never goes
// to OpenAI), else the provider's strong default. Every choice is receipted
// (`source`) so a silent downgrade is readable from the data.
// The resolver itself is shared (providerEndpoints.js resolveLaneProvider,
// 2026-11-10): the text lanes moved onto both providers resolve by the same
// rule, so it has one owner. This lane keeps its own env knobs and defaults.
export const resolveUnifiedProvider = ({ env = process.env, provider = null, model = null, keys = null } = {}) =>
  resolveLaneProvider({
    providers: UNIFIED_EXTRACTOR_PROVIDERS,
    defaultModels: UNIFIED_EXTRACTOR_DEFAULT_MODELS,
    providerEnvKey: UNIFIED_EXTRACTOR_PROVIDER_ENV,
    modelEnvKeys: [UNIFIED_EXTRACTOR_MODEL_ENV],
    env,
    provider,
    model,
    keys
  });

// ── prompt ─────────────────────────────────────────────────────────────
// The system prompt's FIRST sentence is the lane signature the recorded
// providers stub keys on (testSupport/recordedProviders.js
// ANTHROPIC_SYSTEM_LANES) — keep it stable.
const buildSystemPrompt = () => `You are extracting fields from one financial document for a bookkeeping system that keeps the books of ONE firm (identified below as "the firm"). Classify the document and extract its fields in a single pass.

STEP 1 — CLASSIFY (document_type), exactly one of:
- "receipt": point-of-sale evidence the firm BOUGHT goods/services from a third-party vendor and (usually) paid on the spot. Money OUT.
- "supplier_bill": an invoice a supplier issued TO the firm — payment terms, due date, the firm in the "Bill to" / "Customer" position. Money OUT. This type ALSO covers the firm's payables that are not called invoices: an INSURANCE premium invoice or policy bill from an insurer; a LOAN installment notice, repayment schedule or lender statement (total_amount = the installment the firm pays THIS period — principal plus interest plus any fee — never the remaining loan balance; lines = the installment's components as printed); a PAYSLIP or payroll record for one employee (counterparty = the employee, counterparty_role "vendor", total_amount = the NET pay the firm transfers; lines = the pay components as printed with SIGNED amounts — gross pay and allowances positive, tax withheld and every other deduction negative — so that the lines sum to the net; employer-side contributions the firm pays elsewhere are NOT lines, mention them in warnings as "model:employer_contributions_<amount>").
- "sales_invoice": an invoice the FIRM issued to its customer — the firm's name in the "From" / "Issued by" position, a customer in "Bill to". Money IN, usually unpaid.
- "issued_receipt": a receipt or remittance acknowledgement the FIRM issued (or received from its customer) for money the firm has ALREADY received on its own sales. Money IN, paid.
- "payment_confirmation": a single-event confirmation that the firm PAID a third party (a card provider, a tax authority, a lender, a supplier) — an ACH/wire/transfer/direct-debit confirmation. Money OUT, paid.
- "payment_account_statement": a periodic statement for a payment account the firm holds with a card provider, fuel card, expense platform or similar (Amex, a fleet card, a spend platform): a period, charges, and one statement total / amount due. Not a bank statement.
- "contract": an agreement the firm is party to (service subscription, lease, loan, employment, NDA, purchase agreement) — obligations, terms, effective dates.
- "payout_statement": a settlement / payout / remittance report from a payment processor, card acquirer, POS provider, marketplace or delivery platform (Stripe, Square, Adyen, PayPal, Shopify Payments, SumUp, Deliveroo, Talabat, Uber Eats, Amazon, Etsy …): gross customer sales for a period, refunds and fees deducted, ONE net amount paid to the firm. Money IN. NEVER "receipt": the processor remits the firm's OWN revenue; it did not sell the firm anything. (A purchase FROM one of these brands — a card reader, a subscription fee — is a receipt or supplier_bill: direction of money decides, not the brand.)
- "deposit_slip": a cash and/or cheque deposit at a bank branch, counter or ATM — the components deposited and ONE total credited to the firm's account. Money IN.
- "unknown": not one of the above, unreadable, or not an accounting document.

THE FIRM-SIDE ANCHOR. The firm's identity is supplied below. Once you know which name on the page is the firm, the direction follows: the firm at the top / "From" / "Issued by" / "Vendor" position ⇒ sales_invoice or issued_receipt; the firm at "Bill to" / "Sold to" / "Customer" ⇒ supplier_bill or receipt; the firm as merchant / partner / account holder on a settlement ⇒ payout_statement or deposit_slip. The upload was ROUTED to a type (stated below) — verify it against the document and override it when the document says otherwise.

TABLE ALIGNMENT — scans may be rotated, skewed or perspectively distorted. Trace each printed row and its sloping baseline or ruling from its description to its amount; do not pair columns by horizontal page coordinates. Preserve every row exactly once. Verify quantity × unit price where printed and compare the component sum to the printed total; a failed check is a warning, never permission to shift a row, invent a component or change a printed amount. If an alignment remains ambiguous, retain that uncertainty instead of silently assigning a neighboring amount.

STEP 2 — EXTRACT the header:
- counterparty_name: the OTHER party, never the firm. The vendor (receipt, supplier_bill), the customer (sales_invoice, issued_receipt), the payee (payment_confirmation), the account issuer (payment_account_statement), the other contracting party (contract), the processor / platform (payout_statement), the bank (deposit_slip). Use the shortest recognisable brand name ("Amazon" not "Amazon.com Services LLC", "Lowe's" not "Lowe's Home Improvement"; keep apostrophes). Never a card brand as the vendor, never a "Bill to" recipient as the supplier, never a generic placeholder. null when you cannot identify it — never invent.
- counterparty_role: "vendor" (receipt, supplier_bill, payment_confirmation, payment_account_statement, a contract where the firm pays), "customer" (sales_invoice, issued_receipt, a contract where the firm is paid), "processor" (payout_statement), "bank" (deposit_slip), "unknown" only when the document type is unknown.
- counterparty_tax_id / own_tax_id: the tax registration numbers (VAT number, TRN, GST number, VAT-ID, Y-tunnus) printed for the counterparty and for the firm, exactly as printed; null when absent.
- own_name: the firm's name as the document prints it (the "Bill to" line, the merchant line, the account holder); null when absent.
- document_date: the date printed on the document (issue date, receipt date, payout/deposit date, signing date) in YYYY-MM-DD. due_date: an explicit payment deadline on a bill or invoice; null elsewhere.
- currency: the ISO-4217 code supported by document evidence. An explicit code or unambiguous symbol can establish it; a bare dollar sign, display locale, entity jurisdiction or book currency cannot. Return null and warn currency_unresolved when absent or ambiguous.
- Amounts are numbers: subtotal_amount, tax_amount, shipping_amount, discount_amount, rounding_amount, total_amount. total_amount is the grand total (a bill's amount owed, an invoice's total, a statement's total / amount due, a payment confirmation's amount paid as a positive magnitude, a payout's NET amount received, a deposit's total credited, a contract's one-off total or null). Report shipping / discount / rounding as 0 when not shown. tax_amount is the total tax (sum of itemised tax codes); subtotal_amount is the pre-tax total when visible.
- Tax is only an amount explicitly labelled as tax on the source. A demand charge, permit surcharge, commission or other fee is not tax merely because it is beside a tax row or calculated as a percentage. A combined "taxes and fees" amount is not a known pure-tax amount: preserve its label and amount as a line, keep unknown tax_amount null, and preserve the ambiguity in warnings. Do not turn exempt fees into tax or move an adjacent charge into tax_amount.
- SOURCE BUSINESS USE — preserve any explicit handwritten or printed statement of personal, business or mixed use in source_business_use. Copy its exact wording into source_quote (including a relevant dated annotation); classify its stated meaning, not the merchant or the firm's likely purpose. Use not_stated/null/null if the source does not explicitly state use. business_use_percent is 0 for personal, 100 for explicitly wholly business, or a printed percentage for mixed; otherwise null. This is the source's statement, never permission to deduct tax. Preserve contradictions in warnings.
- SOURCE TAX NOTES — read tax footnotes and annotations as well as the numeric table. Preserve each explicit clause about included/excluded tax, the printed rate, exemption, reverse charge, deductibility or its cited legal basis in a separate warnings entry beginning "source_tax:" followed by a short exact source quotation. Keep the clause's subject and scope (sales, a fee, a row, a period) so a sales rate cannot become a fee rate. These entries report source facts, not an accounting decision or a defect. Preserve conflicting source clauses separately; do not infer an absent rate from country, merchant, business type or date. Use lines[].tax_rate when a rate explicitly applies to that purchasable line; use source_tax notes for settlement gross sales and fees, whose net rows are not tax bases. Do not invent tax amounts from a rate-only note.
- line_amounts_include_tax: true when each line amount already includes tax; false when tax is a separate footer line.
- payment_status: "paid" / "unpaid" / "partial" / "unknown" / "void" / "credit_note" from the document's own evidence (a PAID stamp, a card slip, an outstanding balance). Defaults when the document is silent: receipt paid, supplier_bill unpaid, sales_invoice unpaid, issued_receipt paid, payment_confirmation paid, payout_statement paid, deposit_slip paid, otherwise unknown.
- payment_terms: the payment terms phrase exactly as printed ("Net 30", "Due on receipt"); null when absent.
- references: EVERY structured identifier on the document as { type, value }: invoice_number (bill / invoice numbers), receipt_number, order_id (purchase orders), transaction_id (processor / gateway ids), ticket_number, tracking_number, booking_reference, contract_number, agreement_number, payout_reference (the payout / settlement id a bank line will quote), deposit_reference (a deposit slip's slip number), other. Never card last-4, phone numbers, addresses, dates or amounts. No duplicates.

LINES — for receipt, supplier_bill, sales_invoice and issued_receipt return one entry per purchasable line item (description as printed; quantity defaults to 1; unit_price = amount / quantity when not printed; amount is the per-line total, inclusive of tax when line_amounts_include_tax is true; tax_rate as a decimal, 0.05 for 5%, null when not shown). Skip subtotal / tax / total rows. Return [] for every other type and for header-only documents.

SETTLEMENT — fill for payout_statement and deposit_slip ONLY (every field null / [] / 0 for other types): period_start, period_end, payout_date (YYYY-MM-DD), gross_sales (the gross before deductions; the total deposited for a slip), gross_components (how the gross is itemised — a slip's cash and each cheque, per-channel subtotals — each a positive magnitude summing to gross_sales, [] when only one gross figure is shown), refunds (a positive magnitude, 0 when none), fees (one entry per fee / commission line: amount EXCLUDING its tax, tax_amount = the tax on that fee when printed separately, both positive), adjustments (anything else that moves the payout — reserves, chargeback reversals, promotional co-funding, tips; amount SIGNED: positive adds, negative reduces), net_payout (THE amount that reached the firm's bank — the number a bank statement shows), transaction_count, payout_reference, deposit_reference, bank_last4 (digits only). Arithmetic discipline: gross − refunds − Σ(fee + its tax) + Σadjustments should equal net_payout. Report the figures AS PRINTED even when they do not foot — a deduction the provider did not print is exactly what downstream needs to see; never adjust a number or invent a line to balance the equation.

SETTLEMENT ROWS — when a payout_statement LISTS SEVERAL SETTLEMENTS (a monthly summary / koontilasku / batch report: one row per payout, each with its own period, gross, fee and net, and a total at the bottom), fill settlement.rows with ONE entry per listed settlement AS PRINTED: period_label (the row's own label exactly as printed, e.g. "VKO5 2025 (27.1.–2.2.)"), period_start / period_end (YYYY-MM-DD when the row's period is printed or unambiguous from the label and the statement's year), paid_on (the date THAT row was paid to the bank when printed — including a note that a period settles after the statement date), gross (that row's sales before deductions), fee (that row's fee / commission EXCLUDING its tax), fee_tax (the tax on that row's fee when printed separately, else 0), net (what THAT row paid to the bank — the number one bank credit shows), transaction_count, reference (the row's own payout / batch reference when printed). Each row is what ONE bank credit settles; the row nets must sum to net_payout. Keep gross_sales / fees / net_payout as the statement's TOTALS. Preserve explicit gross-sales VAT/GST and fee exemption/tax clauses in source_tax warnings even when no tax amount appears in the table. rows is [] for a statement that is one settlement.

CONTRACT — fill for contract ONLY (contract_type "not_a_contract" and every other field null / "none" / [] for other types): contract_type (service_subscription, services_one_off, goods_purchase, employment, loan, lease, nda, other), effective_start_date, effective_end_date, auto_renew, notice_period_days, recurring_amount, recurring_frequency (monthly, quarterly, semi_annual, annual, none), and obligations — every distinct financial obligation (rent, deposit, salary, loan repayment, service fee …) with obligation_type, payer / payee names and roles, amount, currency, frequency, start_date / end_date, due_day (1–31 or null), escalation_clause / tax_clause snippets, confidence and source_evidence. [] when the contract carries no financial obligation (an NDA).

CONFIDENCE — extraction_confidence is your 0–1 confidence the extracted values are usable. extraction_status is "validated" when every load-bearing field for the type was readable, "partial" when some were not, "failed" when the document is unreadable or not an accounting document. warnings: short machine-style notes on anything a bookkeeper should know (a date you could not read, a total that does not foot, two currencies on one page).

Return ONLY a JSON object with exactly these keys and no others:
{
  "document_type": "…", "extraction_status": "validated|partial|failed", "extraction_confidence": 0.0, "warnings": [],
  "source_business_use": {"classification":"not_stated|business|personal|mixed","source_quote":null,"business_use_percent":null},
  "header": { "counterparty_name": null, "counterparty_role": "vendor|customer|processor|bank|unknown", "counterparty_tax_id": null, "own_name": null, "own_tax_id": null, "document_date": null, "due_date": null, "currency": null, "subtotal_amount": null, "tax_amount": null, "shipping_amount": 0, "discount_amount": 0, "rounding_amount": 0, "total_amount": null, "line_amounts_include_tax": false, "payment_status": "unknown", "payment_terms": null, "references": [] },
  "lines": [ { "description": null, "quantity": null, "unit_price": null, "amount": null, "tax_rate": null } ],
  "settlement": { "period_start": null, "period_end": null, "payout_date": null, "gross_sales": null, "gross_components": [], "refunds": null, "fees": [], "adjustments": [], "net_payout": null, "transaction_count": null, "payout_reference": null, "deposit_reference": null, "bank_last4": null, "rows": [] },
  "contract": { "contract_type": "not_a_contract", "effective_start_date": null, "effective_end_date": null, "auto_renew": null, "notice_period_days": null, "recurring_amount": null, "recurring_frequency": "none", "obligations": [] }
}
No markdown, no commentary, no extra fields.`;

const routedTypeHint = (documentType) => {
  if (!documentType || documentType === 'unknown') return 'The upload was not routed to a type; classify it from the document alone.';
  return `The upload was routed as "${documentType}". Verify against the document; override the type if the document says otherwise.`;
};

const buildUserPrompt = ({ filename, documentType, dateFormatHint, hint, clientIdentity, priorCorrections }) => {
  const sections = [];
  sections.push(`Filename: ${filename || 'unknown'}`);
  sections.push(routedTypeHint(documentType));
  // The free-text hint seam: the jurisdiction's date note travels here, and
  // RT-10's totals re-read appends its request to the same string. Verbatim,
  // date note first (the day-first regex below must still bind).
  if (dateFormatHint) sections.push(`Date format hint: ${dateFormatHint}`);
  if (hint) sections.push(String(hint));
  const identityFragment = buildClientIdentityPromptFragment(clientIdentity);
  if (identityFragment) sections.push(identityFragment.trim());
  // Slice C — prior corrections as few-shot; the fragment renders nothing
  // for null / [].
  // W1 (INV-12): the routed class filters the examples too (the read is
  // already entity-scoped; this keeps a receipt example off a bill prompt).
  const correctionsFragment = buildCorrectionsPromptFragment(priorCorrections || [], { documentType: documentType && documentType !== 'unknown' ? documentType : null });
  if (correctionsFragment) sections.push(correctionsFragment.trim());
  sections.push('Classify and extract this document. Return ONLY the JSON object as specified.');
  return sections.join('\n\n');
};

// ── document parts ─────────────────────────────────────────────────────
// A base64 PDF starts with 'JVBERi' ('%PDF'). The bytes outrank upload
// metadata: some upload paths deliver an empty / octet-stream mime for a
// perfectly good PDF, which once sent a PDF as an image block and the
// provider rejected it. (The OpenAI part builder sniffs the same way.)
// (documentLaneRequest.js owns the block shape; the OpenAI part builder
// sniffs the same way.)
const buildContentBlock = ({ base64, mimeType, filename }) => anthropicFileBlock({ base64, mimeType, filename });

// ── normalisation helpers ──────────────────────────────────────────────
const trimBase64 = (value = '') => String(value || '').replace(/[\r\n\s]/g, '');

const filenameCorrelationId = (filename = '') =>
  crypto.createHash('sha256').update(String(filename || 'unknown')).digest('hex').slice(0, 12);

const numberOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const round2 = (value) => (value == null ? null : Math.round((value + Number.EPSILON) * 100) / 100);

const magnitudeOrNull = (value) => {
  const n = numberOrNull(value);
  return n == null ? null : Math.abs(n);
};

const integerOrNull = (value) => {
  const n = numberOrNull(value);
  return n == null ? null : Math.round(n);
};

const dayFirstHint = (hint) => /DD\/MM\/YYYY-convention/.test(String(hint || ''));
// Shape-normalised by the shared primitive, then CALENDAR-checked: a
// "2026-13-40" the model emits is not a date, and a date column would
// refuse it at the write — refuse it here, as null, with the rest of the
// header intact.
const isoDate = (value, hint) =>
  normalizeValidIsoDate(normalizeIsoOrDayFirstDate(value, { allowDayFirst: dayFirstHint(hint) }));

// Strip control chars + cap to a safe payload length — on every free-text
// field the model might emit.
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

const sum = (values) => round2(values.reduce((acc, value) => acc + (Number(value) || 0), 0));
const formatMoney = (value) => (value == null ? '' : Number(value).toFixed(2));

// Payment-terms parser (the supplierBill.js contract, re-homed here so the
// deletion PR can remove that module): `{ phrase, days }`.
export const normalizePaymentTerms = (rawPhrase) => {
  if (rawPhrase == null) return { phrase: null, days: null };
  const phrase = String(rawPhrase).trim();
  if (!phrase) return { phrase: null, days: null };
  const safePhrase = phrase.slice(0, 120);
  const lower = phrase.toLowerCase();
  if (/(^|\b)(due on receipt|due immediately|payable on receipt|on receipt|immediate)\b/i.test(lower)) {
    return { phrase: safePhrase, days: 0 };
  }
  const netMatch = lower.match(/\bnet[\s-]*(\d{1,3})\b/);
  if (netMatch) return { phrase: safePhrase, days: Number(netMatch[1]) };
  const daysMatch = lower.match(/\b(\d{1,3})\s*(?:calendar\s+)?days?\b/);
  if (daysMatch) return { phrase: safePhrase, days: Number(daysMatch[1]) };
  if (/\b(one|1)\s*(week|wk)s?\b/.test(lower)) return { phrase: safePhrase, days: 7 };
  if (/\b(two|2)\s*(week|wk)s?\b/.test(lower)) return { phrase: safePhrase, days: 14 };
  if (/\b(three|3)\s*(week|wk)s?\b/.test(lower)) return { phrase: safePhrase, days: 21 };
  if (/\b(four|4)\s*(week|wk)s?\b/.test(lower)) return { phrase: safePhrase, days: 28 };
  if (/\b(one|1)\s*month\b/.test(lower)) return { phrase: safePhrase, days: 30 };
  if (/\b(two|2)\s*months?\b/.test(lower)) return { phrase: safePhrase, days: 60 };
  if (/\b(three|3)\s*months?\b/.test(lower)) return { phrase: safePhrase, days: 90 };
  if (/\b(eom|end of month|end of next month)\b/.test(lower)) return { phrase: safePhrase, days: null };
  return { phrase: safePhrase, days: null };
};

const REFERENCE_TYPE_SET = new Set(REFERENCE_TYPE_VALUES);

const sanitizeReferences = (raw) => {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const type = String(entry.type || '').toLowerCase();
    const value = sanitizeText(entry.value, REFERENCE_VALUE_MAX);
    if (!REFERENCE_TYPE_SET.has(type) || !value) continue;
    const key = `${type}::${value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type, value });
    if (out.length >= REFERENCE_LIST_MAX) break;
  }
  return out;
};

// The legacy single `reference_number` column — the highest-priority
// structured reference for the type (receipt.js REFERENCE_TYPE_PRIORITY /
// contract.js CONTRACT_REFERENCE_TYPE_PRIORITY, restated).
const GENERAL_REFERENCE_PRIORITY = Object.freeze([
  'ticket_number', 'tracking_number', 'invoice_number', 'order_id', 'transaction_id',
  'receipt_number', 'booking_reference', 'payout_reference', 'deposit_reference',
  'contract_number', 'agreement_number', 'other'
]);
const CONTRACT_REFERENCE_PRIORITY = Object.freeze([
  'contract_number', 'agreement_number', 'order_id', 'invoice_number',
  ...GENERAL_REFERENCE_PRIORITY.filter((t) => !['contract_number', 'agreement_number', 'order_id', 'invoice_number'].includes(t))
]);
export const referencePriorityFor = (documentType) =>
  (documentType === 'contract' ? CONTRACT_REFERENCE_PRIORITY : GENERAL_REFERENCE_PRIORITY);

const pickPrimaryReference = (references, documentType) => {
  for (const type of referencePriorityFor(documentType)) {
    const hit = references.find((r) => r.type === type);
    if (hit) return hit.value;
  }
  return null;
};

const normalizeLines = (raw) => {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const line of raw) {
    if (!line || typeof line !== 'object') continue;
    out.push({
      description: line.description == null ? null : sanitizeText(line.description, DESCRIPTION_MAX),
      quantity: numberOrNull(line.quantity),
      unit_price: numberOrNull(line.unit_price),
      amount: numberOrNull(line.amount),
      tax_rate: numberOrNull(line.tax_rate)
    });
  }
  return out;
};

// Model-emitted warnings are advisory — namespaced so they can never
// impersonate a SYSTEM token ('amount_mismatch' gates auto-match, seeds
// review rows and trips the FE banner; only OUR arithmetic may raise it).
const namespaceWarnings = (raw) => (Array.isArray(raw)
  ? raw.map((w) => sanitizeText(w, 200)).filter(Boolean).slice(0, 16).map((w) => (w.startsWith('model:') ? w : `model:${w}`))
  : []);

const PAYMENT_STATUS_DEFAULTS = Object.freeze({
  receipt: 'unknown',
  supplier_bill: 'unpaid',
  sales_invoice: 'unpaid',
  issued_receipt: 'paid',
  payment_confirmation: 'paid',
  payment_account_statement: 'unknown',
  contract: 'unknown',
  payout_statement: 'paid',
  deposit_slip: 'paid'
});

const normalizePaymentStatus = (value, documentType) => {
  const str = String(value || '').toLowerCase();
  if (PAYMENT_STATUS_VALUES.includes(str)) return str;
  return PAYMENT_STATUS_DEFAULTS[documentType] || 'unknown';
};

// The role the mapper trusts: the model's when it fits the type, else the
// type's own. Direction is a property of the TYPE the model chose; the role
// field only refines who the counterparty is.
const ROLE_FOR_TYPE = Object.freeze({
  receipt: 'vendor',
  supplier_bill: 'vendor',
  sales_invoice: 'customer',
  issued_receipt: 'customer',
  payment_confirmation: 'vendor',
  payment_account_statement: 'vendor',
  payout_statement: 'processor',
  deposit_slip: 'bank'
});
const resolveRole = (raw, documentType) => {
  const role = COUNTERPARTY_ROLE_VALUES.includes(raw) ? raw : null;
  if (documentType === 'contract') return role === 'customer' ? 'customer' : 'vendor';
  return ROLE_FOR_TYPE[documentType] || role || 'unknown';
};

// ── the header the model returned, normalised (partial or complete) ──────
const normalizeHeaderFields = (headerRaw, { documentType, dateFormatHint }) => {
  const h = headerRaw && typeof headerRaw === 'object' ? headerRaw : {};
  const references = sanitizeReferences(h.references);
  return {
    counterparty_name: sanitizeText(h.counterparty_name, NAME_MAX),
    counterparty_role: resolveRole(h.counterparty_role, documentType),
    counterparty_tax_id: sanitizeText(h.counterparty_tax_id, TAX_ID_MAX),
    own_name: sanitizeText(h.own_name, NAME_MAX),
    own_tax_id: sanitizeText(h.own_tax_id, TAX_ID_MAX),
    document_date: isoDate(h.document_date, dateFormatHint),
    due_date: isoDate(h.due_date, dateFormatHint),
    currency: normalizeIsoCurrency(h.currency),
    subtotal_amount: numberOrNull(h.subtotal_amount),
    tax_amount: numberOrNull(h.tax_amount),
    shipping_amount: numberOrNull(h.shipping_amount) ?? 0,
    discount_amount: numberOrNull(h.discount_amount) ?? 0,
    rounding_amount: numberOrNull(h.rounding_amount) ?? 0,
    total_amount: numberOrNull(h.total_amount),
    line_amounts_include_tax: Boolean(h.line_amounts_include_tax),
    payment_status: normalizePaymentStatus(h.payment_status, documentType),
    payment_terms: sanitizeText(h.payment_terms, 120),
    references,
    reference_number: pickPrimaryReference(references, documentType)
  };
};

// What the failure envelope carries (F-12): the header the model DID return,
// its own classification, status and confidence — enough for the review
// surfaces to show "vendor + total read, date unreadable" and for the
// re-read lane to start from, never a replay from nothing.
const buildPartialHeader = ({ documentType, extractionStatus, confidence, header, lines, warnings }) => ({
  document_type: documentType,
  extraction_status: extractionStatus,
  extraction_confidence: confidence,
  header,
  line_count: Array.isArray(lines) ? lines.length : 0,
  warnings
});

// ── settlement (payout_statement / deposit_slip) ───────────────────────
const sanitizeComponents = (raw, max) => {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const amount = numberOrNull(entry.amount);
    if (amount == null) continue;
    out.push({ description: sanitizeText(entry.description, NAME_MAX), amount: round2(amount) });
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
    out.push({ description: sanitizeText(entry.description, NAME_MAX), amount: round2(amount ?? 0), tax_amount: round2(taxAmount) });
    if (out.length >= FEE_LIST_MAX) break;
  }
  return out;
};

// The settlement breakdown as SIGNED document lines (RT-18's contract,
// folded in): gross first (one line, or the itemised components when they
// foot to the gross), then refunds, each fee incl. its tax, each adjustment
// as signed. validateReceiptTotals sums them against the NET header total.
const buildSettlementLines = ({ kind, gross, components, refunds, fees, adjustments, transactionCount, warnings }) => {
  const lines = [];
  const line = (description, amount) => ({ description, quantity: 1, unit_price: round2(amount), amount: round2(amount), tax_rate: null });
  const grossLabel = kind === 'deposit_slip' ? 'Deposit total' : 'Gross sales';
  if (gross != null) {
    const componentSum = components.length ? sum(components.map((c) => c.amount)) : null;
    if (components.length && componentSum != null && Math.abs(componentSum - gross) <= COMPONENT_SUM_TOLERANCE) {
      for (const component of components) lines.push(line(component.description || grossLabel, component.amount));
    } else {
      if (components.length && !warnings.includes('gross_components_mismatch')) warnings.push('gross_components_mismatch');
      const countNote = transactionCount != null ? ` (${transactionCount} ${kind === 'deposit_slip' ? 'items' : 'transactions'})` : '';
      lines.push(line(`${grossLabel}${countNote}`, gross));
    }
  }
  if (refunds != null && refunds > 0) lines.push(line('Refunds', -refunds));
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

// RT-21b — settlement rows (the koontilasku contract, prompt
// docs/prompt-2026-09-08-rt-21-koontilasku-settlement-rows.md §2). Every
// listed settlement is kept AS PRINTED (gross / fee / fee_tax / net / paid
// date / reference); the only arithmetic the Keep layer does is (i) derive a
// row's net from gross − fee − fee_tax when the page printed no net but did
// print both (receipted on the row as net_derived), and (ii) check the rows
// foot: every row has a net and Σ nets = the statement net within one cent
// per row. Nothing is adjusted to balance.
const sanitizeSettlementRows = (raw, { dateFormatHint, warnings }) => {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const gross = round2(magnitudeOrNull(entry.gross));
    const fee = round2(magnitudeOrNull(entry.fee));
    const feeTax = round2(magnitudeOrNull(entry.fee_tax)) ?? 0;
    let net = round2(magnitudeOrNull(entry.net));
    let netDerived = false;
    if (net == null && gross != null && fee != null) {
      net = round2(gross - fee - feeTax);
      netDerived = true;
    }
    if (gross == null && net == null) continue;
    if (out.length >= SETTLEMENT_ROW_LIST_MAX) {
      if (!warnings.includes('settlement_rows_truncated')) warnings.push('settlement_rows_truncated');
      break;
    }
    out.push({
      row_no: out.length + 1,
      period_label: sanitizeText(entry.period_label, NAME_MAX),
      period_start: isoDate(entry.period_start, dateFormatHint),
      period_end: isoDate(entry.period_end, dateFormatHint),
      paid_on: isoDate(entry.paid_on, dateFormatHint),
      gross,
      fee,
      fee_tax: feeTax,
      net,
      net_derived: netDerived,
      transaction_count: integerOrNull(entry.transaction_count),
      reference: sanitizeText(entry.reference, REFERENCE_VALUE_MAX)
    });
  }
  return out;
};

// Do the rows foot to the statement net? The receipt shape mirrors the
// totals receipt (expected / total / drift / matches) so the validator's
// outcome and the matcher's prompt can read one thing.
export const settlementRowsFoot = (rows, net) => {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return null;
  const missingNet = list.filter((row) => row.net == null).length;
  const rowSum = round2(sum(list.map((row) => row.net ?? 0)));
  const expected = net == null ? null : round2(net);
  const tolerance = round2(Math.max(SETTLEMENT_ROW_SUM_TOLERANCE_PER_ROW, SETTLEMENT_ROW_SUM_TOLERANCE_PER_ROW * list.length));
  const drift = expected == null ? null : round2(rowSum - expected);
  const matches = missingNet === 0 && expected != null && Math.abs(drift) <= tolerance;
  return {
    matches,
    row_count: list.length,
    rows_missing_net: missingNet,
    expected,
    total: rowSum,
    drift,
    tolerance,
    reason: missingNet > 0 ? 'row_net_missing' : expected == null ? 'statement_net_missing' : matches ? null : 'rows_do_not_foot'
  };
};

// The rows as document lines — ONE line per settlement row at that row's
// NET (what one bank credit settles), the printed breakdown riding on the
// line under `settlement_row` so the writer persists it in
// document_lines.payload.raw_extraction and RT-21c's row match / RT-21f's
// split read it from the row they name. Σ lines = Σ nets = the statement
// net, so validateReceiptTotals foots on the same formula as before.
const buildSettlementRowLines = (rows) => rows.map((row) => ({
  description: row.period_label || (row.period_start && row.period_end ? `Settlement ${row.period_start} – ${row.period_end}` : `Settlement row ${row.row_no}`),
  quantity: 1,
  unit_price: row.net,
  amount: row.net,
  tax_rate: null,
  settlement_row: { ...row }
}));

const mapSettlement = ({ raw, header, documentType, dateFormatHint, warnings }) => {
  const s = raw && typeof raw === 'object' ? raw : {};
  const kind = documentType;
  const periodStart = isoDate(s.period_start, dateFormatHint);
  const periodEnd = isoDate(s.period_end, dateFormatHint);
  const payoutDate = isoDate(s.payout_date, dateFormatHint);
  const gross = round2(magnitudeOrNull(s.gross_sales));
  const components = sanitizeComponents(s.gross_components, COMPONENT_LIST_MAX).map((c) => ({ ...c, amount: Math.abs(c.amount) }));
  const refunds = round2(magnitudeOrNull(s.refunds)) ?? 0;
  const fees = sanitizeFees(s.fees);
  const adjustments = sanitizeComponents(s.adjustments, ADJUSTMENT_LIST_MAX);
  const net = round2(magnitudeOrNull(s.net_payout)) ?? round2(magnitudeOrNull(header.total_amount));
  const transactionCount = integerOrNull(s.transaction_count);
  const payoutReference = sanitizeText(s.payout_reference, REFERENCE_VALUE_MAX)
    || header.references.find((r) => r.type === 'payout_reference')?.value
    || null;
  const depositReference = sanitizeText(s.deposit_reference, REFERENCE_VALUE_MAX)
    || header.references.find((r) => r.type === 'deposit_reference')?.value
    || null;
  const bankLast4 = sanitizeLast4(s.bank_last4);

  // RT-21b: listed settlement rows (payout statements only — a deposit
  // slip's components are its gross_components, never rows).
  const rows = kind === 'payout_statement' ? sanitizeSettlementRows(s.rows, { dateFormatHint, warnings }) : [];
  const rowsValidation = settlementRowsFoot(rows, net);

  // Rows that foot ARE the document lines (one per row at its net). Rows
  // that do not foot stay on the summary as evidence, the breakdown lines
  // stand as before, and the statement is `partial` (the caller reads
  // rows_validation) — never promoted to a row the matcher could settle.
  const breakdownLines = buildSettlementLines({ kind, gross, components, refunds, fees, adjustments, transactionCount, warnings });
  const lines = rowsValidation?.matches ? buildSettlementRowLines(rows) : breakdownLines;
  if (rowsValidation && !rowsValidation.matches && !warnings.includes('settlement_rows_mismatch')) warnings.push('settlement_rows_mismatch');
  if (net == null && !warnings.includes('net_payout_missing')) warnings.push('net_payout_missing');
  if (lines.length === 0 && !warnings.includes('no_settlement_breakdown')) warnings.push('no_settlement_breakdown');

  const settlement = {
    kind,
    provider_name: header.counterparty_name,
    provider_tax_id: header.counterparty_tax_id,
    merchant_name: header.own_name,
    merchant_tax_id: header.own_tax_id,
    period_start: periodStart,
    period_end: periodEnd,
    payout_date: payoutDate,
    currency: header.currency,
    gross_sales: gross,
    gross_components: components,
    refunds,
    fees,
    fee_total: sum(fees.map((fee) => fee.amount)),
    fee_tax_total: sum(fees.map((fee) => fee.tax_amount)),
    adjustments,
    adjustment_total: sum(adjustments.map((a) => a.amount)),
    net_payout: net,
    transaction_count: transactionCount,
    payout_reference: payoutReference,
    deposit_reference: depositReference,
    bank_last4: bankLast4,
    rows,
    rows_validation: rowsValidation
  };
  return { settlement, lines, net, payoutDate, periodStart, periodEnd, payoutReference, depositReference, rowsValidation };
};

// ── contract ───────────────────────────────────────────────────────────
const OBLIGATION_TYPE_SET = new Set(OBLIGATION_TYPE_VALUES);
const OBLIGATION_FREQUENCY_SET = new Set(OBLIGATION_FREQUENCY_VALUES);
const OBLIGATION_PARTY_ROLE_SET = new Set(OBLIGATION_PARTY_ROLE_VALUES);

// contract.js's env gate, kept for parity this release (a legacy env-only
// gate F-15 names for deletion; the deletion PR decides it).
const isContractObligationsEnabled = (env = process.env) =>
  String(env?.CONTRACT_OBLIGATIONS_ENABLED || '').toLowerCase() === 'true';

const sanitizeObligations = (raw, dateFormatHint) => {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    if (!OBLIGATION_TYPE_SET.has(entry.obligation_type)) continue;
    const dueDay = numberOrNull(entry.due_day);
    out.push({
      obligation_type: entry.obligation_type,
      payer: sanitizeText(entry.payer, NAME_MAX),
      payee: sanitizeText(entry.payee, NAME_MAX),
      payer_role: OBLIGATION_PARTY_ROLE_SET.has(entry.payer_role) ? entry.payer_role : 'party',
      payee_role: OBLIGATION_PARTY_ROLE_SET.has(entry.payee_role) ? entry.payee_role : 'party',
      amount: numberOrNull(entry.amount),
      currency: normalizeIsoCurrency(entry.currency),
      frequency: OBLIGATION_FREQUENCY_SET.has(entry.frequency) ? entry.frequency : 'one_time',
      start_date: isoDate(entry.start_date, dateFormatHint),
      end_date: isoDate(entry.end_date, dateFormatHint),
      due_day: dueDay !== null && Number.isInteger(dueDay) && dueDay >= 1 && dueDay <= 31 ? dueDay : null,
      escalation_clause: sanitizeText(entry.escalation_clause, EVIDENCE_SNIPPET_MAX),
      tax_clause: sanitizeText(entry.tax_clause, EVIDENCE_SNIPPET_MAX),
      confidence: Math.max(0, Math.min(1, numberOrNull(entry.confidence) ?? 0)),
      source_evidence: sanitizeText(entry.source_evidence, EVIDENCE_SNIPPET_MAX)
    });
    if (out.length >= OBLIGATIONS_MAX) break;
  }
  return out;
};

const mapContract = ({ raw, dateFormatHint, env }) => {
  const c = raw && typeof raw === 'object' ? raw : {};
  const contractType = CONTRACT_TYPE_VALUES.includes(c.contract_type) && c.contract_type !== 'not_a_contract'
    ? c.contract_type
    : 'other';
  const recurringFrequency = RECURRING_FREQUENCY_VALUES.includes(c.recurring_frequency) ? c.recurring_frequency : 'none';
  const obligations = isContractObligationsEnabled(env) ? sanitizeObligations(c.obligations, dateFormatHint) : [];
  return {
    contract_type: contractType,
    effective_start_date: isoDate(c.effective_start_date, dateFormatHint),
    effective_end_date: isoDate(c.effective_end_date, dateFormatHint),
    auto_renew: typeof c.auto_renew === 'boolean' ? c.auto_renew : null,
    notice_period_days: numberOrNull(c.notice_period_days),
    recurring_amount: numberOrNull(c.recurring_amount),
    recurring_frequency: recurringFrequency,
    obligations
  };
};

// ── the mapper ─────────────────────────────────────────────────────────
// Raw model output → the writer-shape envelope. Pure: no network, no env
// beyond the contract-obligations gate (injectable). `documentType` is the
// ROUTED type (the hint the prompt carried); the model's own classification
// wins and is what `document_type` reports.
export const normalizeUnifiedExtraction = (raw, { documentType: routedType = null, dateFormatHint = '', env = process.env } = {}) => {
  const fail = (code, reason, extra = {}) => ({ kind: 'failed', code, reason, retryable: false, ...extra });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('DOCUMENT_EXTRACTION_FAILED', 'model_response_not_object', { schema_violations: ['$: expected object'] });
  }
  const modelType = String(raw.document_type || '').toLowerCase();
  if (!UNIFIED_DOCUMENT_TYPES.includes(modelType)) {
    return fail('DOCUMENT_EXTRACTION_FAILED', `unknown_document_type:${modelType || '(missing)'}`);
  }
  const documentType = modelType;
  const extractionStatus = EXTRACTION_STATUS_VALUES.includes(raw.extraction_status) ? raw.extraction_status : 'failed';
  const confidence = numberOrNull(raw.extraction_confidence);
  const warnings = namespaceWarnings(raw.warnings);
  const headerFields = normalizeHeaderFields(raw.header, { documentType, dateFormatHint });
  const linesRaw = normalizeLines(raw.lines);

  // The Keep layer's floor: a self-reported failure, an unknown type, or a
  // read below the floor is UNREADABLE — but the header the model returned
  // travels on the envelope (F-12) instead of being dropped.
  const partial = buildPartialHeader({
    documentType, extractionStatus, confidence, header: headerFields, lines: linesRaw, warnings
  });
  if (extractionStatus === 'failed' || documentType === 'unknown' || (confidence ?? 0) < UNREADABLE_CONFIDENCE_FLOOR) {
    const reason = extractionStatus === 'failed'
      ? 'model_self_reported_failure'
      : documentType === 'unknown'
        ? 'model_returned_unknown_type'
        : 'low_confidence';
    return fail('DOCUMENT_EXTRACTION_UNREADABLE', reason, { partial_header: partial });
  }

  const role = headerFields.counterparty_role;
  const isAr = role === 'customer';
  const isSettlement = SETTLEMENT_DOCUMENT_TYPES.includes(documentType);
  const lineBearing = LINE_BEARING_DOCUMENT_TYPES.includes(documentType);
  const paymentTerms = ['supplier_bill', 'sales_invoice'].includes(documentType)
    ? normalizePaymentTerms(headerFields.payment_terms)
    : { phrase: headerFields.payment_terms, days: null };

  // Direction-correct writer header: the firm's own name is never written on
  // its own row; the counterparty lands on the side the type's direction
  // names. The unified extractor TRUSTS the model's role — no forcing.
  const header = {
    vendor_name: isAr ? null : headerFields.counterparty_name,
    customer_name: isAr ? headerFields.counterparty_name : null,
    document_date: headerFields.document_date,
    due_date: documentType === 'contract' ? null : headerFields.due_date,
    total_amount: headerFields.total_amount,
    currency: headerFields.currency,
    tax_amount: isSettlement || documentType === 'contract' ? null : headerFields.tax_amount,
    reference_number: headerFields.reference_number,
    payment_status: headerFields.payment_status,
    extraction_confidence: confidence,
    // Carried on the header as the unified extractor always has (the AE
    // evidence evals and the eval runner read them here); the writer lands
    // only the column fields above.
    counterparty_role: role,
    references: headerFields.references,
    payment_terms: paymentTerms.phrase,
    subtotal_amount: isSettlement ? null : headerFields.subtotal_amount,
    shipping_amount: isSettlement ? null : headerFields.shipping_amount,
    discount_amount: isSettlement ? null : headerFields.discount_amount,
    rounding_amount: isSettlement ? null : headerFields.rounding_amount,
    line_amounts_include_tax: isSettlement ? true : headerFields.line_amounts_include_tax
  };
  if (documentType === 'payment_confirmation' && header.total_amount != null) {
    header.total_amount = Math.abs(header.total_amount);
  }
  if (documentType === 'issued_receipt' && ['unpaid', 'unknown'].includes(header.payment_status)) {
    // Paid by construction — the document acknowledges money already received.
    header.payment_status = 'paid';
  }
  if (documentType === 'payment_confirmation') {
    // The document IS the proof of payment (the generic extractor wrote
    // 'unknown' here; the matcher's settlement guard keys on an actual
    // matched bank line, never on this status).
    header.payment_status = 'paid';
  }
  if (documentType === 'contract') {
    // A contract carries no payment status (contract.js's contract).
    header.payment_status = 'unknown';
  }

  const sellerIsCounterparty = !isAr;
  const taxRegistrationIds = {
    seller: sellerIsCounterparty ? headerFields.counterparty_tax_id : headerFields.own_tax_id,
    buyer: sellerIsCounterparty ? headerFields.own_tax_id : headerFields.counterparty_tax_id
  };

  // Parties with roles — crossEntityGuard's own-side vocabulary (merchant /
  // supplier on AR docs; company / payer / customer on AP docs) and RT-18's
  // processor / bank.
  const parties = [];
  const ownRole = isSettlement ? 'merchant' : (isAr ? 'merchant' : 'company');
  const counterpartyRole = isSettlement
    ? (documentType === 'deposit_slip' ? 'bank' : 'processor')
    : (documentType === 'payment_confirmation' ? 'payee' : (isAr ? 'customer' : 'vendor'));
  if (headerFields.own_name) parties.push({ role: ownRole, name: headerFields.own_name });
  if (headerFields.counterparty_name) parties.push({ role: counterpartyRole, name: headerFields.counterparty_name });

  const summary = {
    source: 'unified_extractor',
    source_business_use: normalizeSourceBusinessUse(raw.source_business_use),
    currency_resolution: { version: 1, currency: header.currency, source: header.currency ? 'model_document_evidence' : 'unresolved', candidate: raw.header?.currency ?? null },
    prompt_version: UNIFIED_EXTRACTOR_PROMPT_VERSION,
    document_type: documentType,
    counterparty_name: headerFields.counterparty_name,
    counterparty_role: role,
    document_date: header.document_date,
    due_date: header.due_date,
    currency: header.currency,
    subtotal_amount: isSettlement ? null : headerFields.subtotal_amount,
    tax_amount: header.tax_amount,
    shipping_amount: isSettlement ? null : headerFields.shipping_amount,
    discount_amount: isSettlement ? null : headerFields.discount_amount,
    rounding_amount: isSettlement ? null : headerFields.rounding_amount,
    total_amount: header.total_amount,
    line_amounts_include_tax: isSettlement ? true : headerFields.line_amounts_include_tax,
    payment_status: header.payment_status,
    payment_terms: paymentTerms.phrase,
    payment_terms_phrase: paymentTerms.phrase,
    payment_terms_days: paymentTerms.days,
    references: headerFields.references,
    tax_registration_ids: taxRegistrationIds,
    parties,
    line_count: 0,
    coded_line_count: 0,
    review_line_count: 0,
    extraction_status: extractionStatus,
    extraction_confidence: confidence,
    warnings
  };

  let lines = [];
  if (lineBearing) {
    lines = linesRaw;
    if (lines.length === 0 && ['supplier_bill', 'sales_invoice'].includes(documentType) && !warnings.includes('no_lines_detected')) {
      warnings.push('no_lines_detected');
    }
  } else if (isSettlement) {
    const mapped = mapSettlement({ raw: raw.settlement, header: headerFields, documentType, dateFormatHint, warnings });
    lines = mapped.lines;
    header.total_amount = mapped.net;
    header.document_date = header.document_date || mapped.payoutDate || mapped.periodEnd || null;
    header.reference_number = mapped.payoutReference || mapped.depositReference || header.reference_number;
    // Settled by construction — the money moved when the document was
    // issued; no due date on a settlement (RT-18's contract).
    header.payment_status = 'paid';
    header.due_date = null;
    summary.payment_status = 'paid';
    summary.due_date = null;
    summary.total_amount = mapped.net;
    summary.document_date = header.document_date;
    summary.period_start_date = mapped.periodStart;
    summary.period_end_date = mapped.periodEnd;
    summary.settlement = mapped.settlement;
    // RT-21b: a statement whose listed rows do not foot to its net is a
    // PARTIAL read — the rows are evidence, not yet a contract the matcher
    // may settle row by row (the Keep layer's "stays proposed" posture).
    if (mapped.rowsValidation && !mapped.rowsValidation.matches && summary.extraction_status === 'validated') {
      summary.extraction_status = 'partial';
    }
    summary.references = [
      ...(mapped.payoutReference ? [{ type: 'transaction_id', value: mapped.payoutReference }] : []),
      ...(mapped.depositReference ? [{ type: 'receipt_number', value: mapped.depositReference }] : []),
      ...headerFields.references.filter((r) => !['payout_reference', 'deposit_reference'].includes(r.type))
    ].slice(0, REFERENCE_LIST_MAX);
    header.references = summary.references;
  } else if (documentType === 'contract') {
    const contract = mapContract({ raw: raw.contract, dateFormatHint, env });
    header.total_amount = headerFields.total_amount ?? contract.recurring_amount;
    summary.total_amount = headerFields.total_amount;
    Object.assign(summary, {
      contract_type: contract.contract_type,
      effective_start_date: contract.effective_start_date,
      effective_end_date: contract.effective_end_date,
      auto_renew: contract.auto_renew,
      notice_period_days: contract.notice_period_days,
      recurring_amount: contract.recurring_amount,
      recurring_frequency: contract.recurring_frequency,
      obligations: contract.obligations,
      obligation_count: contract.obligations.length
    });
  } else if (documentType === 'payment_account_statement') {
    const s = raw.settlement && typeof raw.settlement === 'object' ? raw.settlement : {};
    summary.period_start_date = isoDate(s.period_start, dateFormatHint);
    summary.period_end_date = isoDate(s.period_end, dateFormatHint);
  }
  summary.line_count = lines.length;

  // THE arithmetic (RT-04, one formula): Σlines against the declared roll-up
  // for the line-bearing types, Σsigned lines = net for a settlement. The
  // receipt is persisted whole; a mismatch adds OUR 'amount_mismatch'.
  if (lines.length > 0 && (lineBearing || (isSettlement && header.total_amount != null))) {
    const totals = validateReceiptTotals({ summary, lines });
    summary.totals_validation = totals;
    if (!totals.matches && !summary.warnings.includes('amount_mismatch')) summary.warnings.push('amount_mismatch');
  }

  return { kind: 'completed_header', document_type: documentType, header, summary, lines };
};

// ── transport ──────────────────────────────────────────────────────────
const outputTextFromResponse = (payload = {}) => {
  if (typeof payload.output_text === 'string') return payload.output_text;
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === 'string') return content.text;
    }
  }
  return '';
};

const servedModelOf = (payload) => (typeof payload?.model === 'string' && payload.model ? payload.model : null);

// One call, either provider, through the envelope. Returns
// `{ text, servedModel }` or throws (LLM_CALL_PROVIDER_ERROR with status,
// AbortError, or a network error) — the caller maps throws to the typed
// failure envelope.
const callProvider = async ({ provider, apiKey, model, system, userText, base64, mimeType, filename, executionId, fetcher, signal }) => {
  const fetchImpl = (url, init) => fetcher(url, {
    ...init,
    // llmCall's owning deadline and this extractor's local timeout must both
    // reach the socket. Replacing init.signal strands the hosted request.
    signal: init?.signal && signal ? AbortSignal.any([init.signal, signal]) : init?.signal || signal
  });
  const execution = { root: { type: 'document_extraction', id: executionId } };
  if (provider === 'openai') {
    const dataUrl = `data:${mimeType || 'application/pdf'};base64,${base64}`;
    const userContent = [
      buildResponsesDocumentPart({ dataUrl, filename, fallbackFilename: 'document.pdf' }),
      { type: 'input_text', text: userText }
    ];
    const { result } = await llmCall({
      provider: 'openai',
      // The lane's own wall, honoured inside a worker too (llmCall hands it to
      // the deadline transport, bounded by the job's remaining budget).
      timeoutMs: REQUEST_TIMEOUT_MS,
      url: 'https://api.openai.com/v1/responses',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: {
        model,
        store: false,
        instructions: system,
        input: [{ role: 'user', content: userContent }],
        text: { format: { type: 'json_schema', name: UNIFIED_EXTRACTION_SCHEMA_NAME, strict: true, schema: UNIFIED_EXTRACTION_SCHEMA } }
      },
      // Sizes only (llmCall rail 1); the document bytes are not measured as
      // a section — the body length already carries them.
      sections: { system, tools: UNIFIED_EXTRACTION_SCHEMA, context: userText },
      execution,
      promptVersion: UNIFIED_EXTRACTOR_PROMPT_VERSION,
      parseResponse: (payload) => ({ text: outputTextFromResponse(payload), servedModel: servedModelOf(payload) }),
      fetchImpl
    });
    return result;
  }
  const { result } = await llmCall(documentLaneAnthropicRequest({
    apiKey,
    model,
    system,
    content: [buildContentBlock({ base64, mimeType, filename }), { type: 'text', text: userText }],
    schema: UNIFIED_EXTRACTION_SCHEMA,
    effort: UNIFIED_EXTRACTOR_ANTHROPIC_EFFORT,
    maxTokens: ANTHROPIC_MAX_TOKENS,
    sections: { system, tools: UNIFIED_EXTRACTION_SCHEMA, context: userText },
    execution,
    promptVersion: UNIFIED_EXTRACTOR_PROMPT_VERSION,
    // This module holds the reply to the schema itself (and keeps the
    // partial header of a violating reply), as on both providers before;
    // the stop_reason checks and the one-tool-call rule still apply.
    validate: false,
    fetchImpl,
    timeoutMs: REQUEST_TIMEOUT_MS
  }));
  return { text: JSON.stringify(result.parsed), servedModel: result.model || null };
};

// ── the public call ────────────────────────────────────────────────────
// Transport failures never throw out of here: every outcome is the typed
// envelope (the worker decides retry vs fall-through from `retryable`).
export const extractUnified = async ({
  base64,
  filename = '',
  mimeType = '',
  // The routed type — a HINT the prompt carries; the model's classification
  // wins. Also the type the mapper defaults against when the model agrees.
  documentType = null,
  documentId = null,
  // The free-text seam (jurisdiction date note; RT-10 appends its re-read
  // request here). `hint` is the same seam under its own name.
  dateFormatHint = '',
  hint = '',
  clientIdentity = null,
  priorCorrections = null,
  // Provider / model pins (tests, the eval script). Absent ⇒ resolved from
  // the env: pin, model id, then key presence.
  provider = null,
  model = null,
  keys = null,
  // Legacy: the Anthropic key by name (the AE evidence eval passes it).
  apiKey = null,
  env = process.env,
  fetchImpl = null
} = {}) => {
  const startedAt = Date.now();
  const correlationId = filenameCorrelationId(filename);
  const resolved = resolveUnifiedProvider({
    env,
    provider,
    model,
    keys: apiKey ? { ...(keys || {}), anthropic: keys?.anthropic || apiKey } : keys
  });
  const receipt = (fields) => ({
    provider: resolved.provider || null,
    model: resolved.model || null,
    model_source: 'configured_fallback',
    prompt_version: UNIFIED_EXTRACTOR_PROMPT_VERSION,
    provider_source: resolved.source?.provider || null,
    ...fields
  });
  if (!resolved.ok) {
    console.warn('[unifiedExtractor] no qualified provider key', { correlation_id: correlationId, reason: resolved.reason });
    return receipt({ kind: 'failed', code: 'DOCUMENT_EXTRACTION_FAILED', reason: resolved.reason, retryable: false });
  }
  const clean = trimBase64(base64);
  if (!clean) {
    return receipt({ kind: 'failed', code: 'DOCUMENT_EXTRACTION_UNREADABLE', reason: 'empty_input', retryable: false });
  }

  const system = buildSystemPrompt();
  const userText = buildUserPrompt({ filename, documentType, dateFormatHint, hint, clientIdentity, priorCorrections });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const fetcher = fetchImpl || fetch;

  let text = '';
  let servedModel = null;
  try {
    ({ text, servedModel } = await callProvider({
      provider: resolved.provider,
      apiKey: resolved.apiKey,
      model: resolved.model,
      system,
      userText,
      base64: clean,
      mimeType,
      filename,
      executionId: documentId || correlationId,
      fetcher,
      signal: controller.signal
    }));
  } catch (error) {
    if (isProviderSpendLimit(error)) throw error;
    const elapsed = Date.now() - startedAt;
    if (isProviderStopFailure(error)) {
      // A refusal, a cut-off reply or an answer that is not the structured
      // call is the provider's named answer, not a transport hiccup:
      // receipted with the model that gave it. Refusal and the output limit
      // are final; an answer that is not the structured call may be re-asked
      // (stopFailureRetryable, the same rule as every document lane).
      const provenance = classifyModelProvenance({ responseModel: error.servedModel, requestedModel: resolved.model });
      console.error('[unifiedExtractor] provider stopped without a usable reply', {
        correlation_id: correlationId, provider: resolved.provider, failure: error.code, reason: error.reason, elapsed_ms: elapsed
      });
      return receipt({
        kind: 'failed', code: 'DOCUMENT_EXTRACTION_FAILED', reason: stopFailureReason(error), retryable: stopFailureRetryable(error),
        model: provenance.model, model_source: provenance.model_source, provider_failure: error.reason || null
      });
    }
    if (error?.code === 'LLM_CALL_PROVIDER_ERROR') {
      const status = Number(error.status || 0);
      const failure = extractionFailureForStatus(status, { provider: resolved.provider, providerError: error.providerError || null });
      console.error('[unifiedExtractor] provider returned non-OK', {
        correlation_id: correlationId, provider: resolved.provider, status, elapsed_ms: elapsed
      });
      return receipt({ ...failure, retryable: failure.code === 'DOCUMENT_EXTRACTION_FAILED', http_status: status });
    }
    console.error('[unifiedExtractor] provider request threw', {
      correlation_id: correlationId,
      provider: resolved.provider,
      error_code: error?.code || null,
      error_name: error?.name || null,
      elapsed_ms: elapsed
    });
    return receipt({
      kind: 'failed',
      code: 'DOCUMENT_EXTRACTION_FAILED',
      reason: error?.name === 'AbortError' || error?.code === 'PROVIDER_TIMEOUT' ? 'timeout' : 'network_error',
      retryable: true,
      // The transport's own message (never document content) — a caller
      // that owns a throw contract (the world runner's spend-evidence path)
      // re-raises it from here.
      detail: error?.message || null
    });
  } finally {
    clearTimeout(timeout);
  }

  // The model id on the receipt is the one the RESPONSE named (CLAUDE.md
  // "the model id is part of the receipt"); the configured id is a fallback
  // the provenance field admits to.
  const provenance = classifyModelProvenance({ responseModel: servedModel, requestedModel: resolved.model });
  const stamped = (fields) => receipt({ model: provenance.model, model_source: provenance.model_source, ...fields });

  let parsed;
  try {
    parsed = extractJson(text);
  } catch (error) {
    console.error('[unifiedExtractor] model response was not JSON', { correlation_id: correlationId, provider: resolved.provider });
    return stamped({ kind: 'failed', code: 'DOCUMENT_EXTRACTION_FAILED', reason: 'invalid_json', retryable: false, detail: error?.message || null });
  }
  // ONE contract for both providers: OpenAI enforced the schema at the
  // request; the Anthropic reply is held to the same schema here.
  const violations = validateStrictSchema(UNIFIED_EXTRACTION_SCHEMA, parsed);
  if (violations.length) {
    console.error('[unifiedExtractor] model response violates the schema', {
      correlation_id: correlationId, provider: resolved.provider, violation_count: violations.length, first: violations[0]
    });
    return stamped({
      kind: 'failed',
      code: 'DOCUMENT_EXTRACTION_FAILED',
      reason: 'invalid_schema',
      retryable: false,
      schema_violations: violations.slice(0, 12),
      partial_header: buildPartialHeader({
        documentType: String(parsed?.document_type || 'unknown'),
        extractionStatus: EXTRACTION_STATUS_VALUES.includes(parsed?.extraction_status) ? parsed.extraction_status : 'failed',
        confidence: numberOrNull(parsed?.extraction_confidence),
        header: normalizeHeaderFields(parsed?.header, { documentType: String(parsed?.document_type || 'unknown'), dateFormatHint }),
        lines: Array.isArray(parsed?.lines) ? parsed.lines : [],
        warnings: namespaceWarnings(parsed?.warnings)
      })
    });
  }

  const result = normalizeUnifiedExtraction(parsed, { documentType, dateFormatHint, env });
  const confidence = Number(parsed?.extraction_confidence || 0);
  if (result.kind === 'failed') {
    console.warn('[unifiedExtractor] extraction unusable', {
      correlation_id: correlationId,
      provider: resolved.provider,
      reason: result.reason,
      model_document_type: result.partial_header?.document_type || null,
      confidence_band: confidence < 0.1 ? '<0.1' : confidence < 0.3 ? '0.1-0.3' : '>=0.3',
      elapsed_ms: Date.now() - startedAt
    });
    return stamped(result);
  }
  console.log('[unifiedExtractor] extraction complete', {
    correlation_id: correlationId,
    provider: resolved.provider,
    model: provenance.model,
    model_source: provenance.model_source,
    routed_type: documentType || null,
    document_type: result.document_type,
    extraction_status: result.summary.extraction_status,
    has_counterparty: Boolean(result.summary.counterparty_name),
    has_date: Boolean(result.header.document_date),
    has_total: result.header.total_amount != null,
    has_currency: Boolean(result.header.currency),
    line_count: result.lines.length,
    totals_match: result.summary.totals_validation ? result.summary.totals_validation.matches : null,
    confidence_band: confidence < 0.5 ? '<0.5' : confidence < 0.8 ? '0.5-0.8' : '>=0.8',
    warning_count: result.summary.warnings.length,
    elapsed_ms: Date.now() - startedAt
  });
  return stamped(result);
};

// Test seams.
export const __buildContentBlock = buildContentBlock;
export const __buildSystemPrompt = buildSystemPrompt;
export const __buildUserPrompt = buildUserPrompt;
export const __buildSettlementLines = buildSettlementLines;
export const __DEFAULT_MODEL = UNIFIED_EXTRACTOR_DEFAULT_MODELS.anthropic;
export const __PAYMENT_STATUS_VALUES = PAYMENT_STATUS_VALUES;
export const __UNREADABLE_CONFIDENCE_FLOOR = UNREADABLE_CONFIDENCE_FLOOR;
