// Synthetic Finnish sources for the FI reliability pass (2026-09-12). Fictional
// parties, amounts and identities — never client material. Two separate
// things live here and must stay separate:
//   - SOURCES: what each fictional document SAYS (the world the assertions
//     read). Expected results are derived from these definitions in the tests,
//     never sent to a model.
//   - FIXTURES: synthetic provider transcriptions served at the HTTP boundary
//     (recordedProviders.js). They are what a strong model would plausibly
//     answer for the printed document; they carry no ids, no journals and no
//     expected outcome — the runtime decides everything downstream.
// Provider-stubbed lifecycle proofs prove wiring, ownership, idempotency and
// recovery; they do NOT prove live-model quality. Neither proves the other.
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { loadRecording } from './recordedProviders.js';
import { FI_OY_BIRTH_CHART } from '../finland/provisioningPolicy.js';

// FI_PROFILE is an Oy, so its book is born with the coded tilikartta (FI-21).
// The coder answers in pack-palette names (a source's `account`); posting
// lands on the coded row the birth chart binds to that name. Expected codes
// and names come from that binding, never from observed output.
export const fiBornAccount = (paletteName) => {
  const account = FI_OY_BIRTH_CHART.accounts.find((row) => row.palette_name === paletteName);
  if (!account) throw new Error(`FI Oy birth chart binds no row to palette name '${paletteName}'`);
  return account;
};

export const FI_PROFILE = Object.freeze({
  companyName: 'Lumo Kahvila Oy', jurisdiction: 'FI', entityType: 'fi-oy', currency: 'EUR',
  incorporationDate: '2021-05-03', accounting_system: 'none', accounting_basis: 'accrual',
  accounting_view: 'management_books', businessId: '3312244-7',
  // The business posts ALV, so it is ALV-registered on its record
  // (finland/postingPolicy.js refuses an ALV code without one).
  alv_registration: { status: 'registered', registered_from: '2021-05-03' }
});

// One March month. Amounts foot per document unless `misprint` says otherwise.
export const FI_SOURCES = Object.freeze([
  { key: 'rent', date: '2026-03-03', type: 'supplier_bill', reference: 'VL-2026-03', counterparty: 'Kiinteistö Oy Sinikello',
    description: 'Liiketilan vuokra maaliskuu 2026', net: 1200, vat: 0, total: 1200, vatRate: 0, exempt: true,
    bankText: 'TILISIIRTO VUOKRA MAALISKUU KIINTEISTO OY SINIKELLO VL-2026-03', account: 'Rent', treatment: 'Veroton toiminta (ALV-vapaa)' },
  { key: 'supplies', date: '2026-03-05', type: 'supplier_bill', reference: 'TT-88213', counterparty: 'Tarviketukku Oy',
    description: 'Kahvilatarvikkeet: suodatinpaperit, kupit, pesuaineet', net: 200, vat: 51, total: 251, vatRate: 0.255,
    bankText: 'KORTTIOSTO TARVIKETUKKU OY TT-88213', account: 'Operating supplies', treatment: 'ALV 25,5 %' },
  { key: 'sale', date: '2026-03-14', type: 'sales_invoice', reference: 'LK-2026-031', counterparty: 'Pohjola Design Oy',
    description: 'Catering kokoustarjoilut 12.3.2026', net: 1240, vat: 316.20, total: 1556.20, vatRate: 0.255,
    bankText: 'VIITESUORITUS POHJOLA DESIGN OY LK-2026-031', account: 'Sales', treatment: 'ALV 25,5 %' },
  // A retail receipt whose printed line items do not add up to the printed
  // total (a torn/misprinted till slip). The world says the TOTAL the bank
  // settled is 33.30; the printed lines sum to 35.30. The corrected receipt
  // (below) prints consistent figures.
  { key: 'receipt', date: '2026-03-11', type: 'receipt', reference: 'KH-4471', counterparty: 'Kahvila Helmi',
    description: 'Neuvottelulounas 2 hlö', net: 29.34, vat: 3.96, total: 33.30, vatRate: 0.135,
    misprint: { lines: [{ description: 'Lounas', amount: 12.00 }, { description: 'Lounas', amount: 12.00 }, { description: 'Kahvit ja jälkiruoka', amount: 11.30 }] },
    bankText: 'KORTTIOSTO KAHVILA HELMI', account: 'Meals and entertainment', treatment: 'ALV 13,5 %' }
]);

export const fiSource = (key) => FI_SOURCES.find((source) => source.key === key);

export async function fiPdf(lines) {
  const pdf = await PDFDocument.create();
  pdf.setCreationDate(new Date('2026-03-31T00:00:00Z')); pdf.setModificationDate(new Date('2026-03-31T00:00:00Z'));
  const page = pdf.addPage(); const font = await pdf.embedFont(StandardFonts.Helvetica);
  lines.forEach((text, index) => page.drawText(text, { x: 40, y: 780 - index * 22, size: 11, font }));
  return Buffer.from(await pdf.save());
}

const money = (n) => Number(n).toFixed(2).replace('.', ',');

// Reply-attachment variant for the totals lane (the receipt source only):
//   corrected — the same receipt, printed consistently (foots at 33,30). Used by
//   the registered expected-failure reproduction of the unresolved totals-reply
//   completion (fiTotalsReplyCompletionPgLifecycle.test.js).
export const RECEIPT_VARIANTS = Object.freeze({
  corrected: { reference: 'KH-4471', counterparty: 'Kahvila Helmi', date: '2026-03-11', lines: [{ description: 'Lounas', amount: 12.00 }, { description: 'Lounas', amount: 12.00 }, { description: 'Kahvit ja jälkiruoka', amount: 9.30 }], total: 33.30, vat: 3.96, foots: true }
});
const variantOf = (options = {}) => (options.variant ? RECEIPT_VARIANTS[options.variant] : options.corrected ? RECEIPT_VARIANTS.corrected : null);

export function fiDocumentBytes(source, options = {}) {
  const sale = source.type === 'sales_invoice';
  const variant = variantOf(options);
  const title = source.type === 'receipt' ? 'KUITTI' : sale ? 'LASKU' : 'LASKU';
  const lines = [`${title} ${variant ? variant.reference : source.reference}${variant ? ' (korjattu)' : ''}`,
    `Myyja: ${sale ? FI_PROFILE.companyName : (variant ? variant.counterparty : source.counterparty)}`,
    `Ostaja: ${sale ? source.counterparty : FI_PROFILE.companyName}`,
    `Y-tunnus: ${sale ? FI_PROFILE.businessId : '2200011-9'}`,
    `Paivays: ${variant ? variant.date : source.date}`, source.description];
  if (variant) {
    for (const line of variant.lines) lines.push(`${line.description} ${money(line.amount)}`);
    lines.push(`Yhteensa EUR ${money(variant.total)} sis. ALV ${money(variant.vat)}`);
  } else if (source.misprint) {
    for (const line of source.misprint.lines) lines.push(`${line.description} ${money(line.amount)}`);
    lines.push(`Yhteensa EUR ${money(source.total)} sis. ALV ${money(source.vat)}`);
  } else {
    lines.push(`Veroton EUR ${money(source.net)}; ALV ${source.exempt ? '0 % (veroton toiminta)' : `${money(source.vatRate * 100)} %`} EUR ${money(source.vat)}; Yhteensa EUR ${money(source.total)}`);
  }
  lines.push(sale ? 'Maksuehto 14 pv netto' : `Maksettu ${source.date}`);
  return fiPdf(lines);
}

export function fiBankCsv(sources = FI_SOURCES) {
  const rows = [...sources].sort((a, b) => a.date.localeCompare(b.date));
  let balance = 5000;
  const lines = ['Date,Description,Money In,Money Out,Balance,Currency'];
  for (const source of rows) {
    const income = source.type === 'sales_invoice';
    balance = Number((balance + (income ? source.total : -source.total)).toFixed(2));
    const [y, m, d] = source.date.split('-');
    lines.push(`${d}.${m}.${y},${source.bankText},${income ? source.total.toFixed(2) : ''},${income ? '' : source.total.toFixed(2)},${balance.toFixed(2)},EUR`);
  }
  return Buffer.from(`${lines.join('\n')}\n`);
}

// Provider envelopes reuse committed wire shapes; only the schema payload is synthetic.
export function openAiFixture(payload) {
  const body = structuredClone(loadRecording('document_routing/ochre-supplier-bill').body);
  body.output[0].content[0].text = JSON.stringify(payload); return { status: 200, body };
}
// `recording_template` names the committed recording whose wire shape the
// fixture reuses: the recorded-providers stub treats it as recording-authored
// (a text JSON answer is delivered as the structured_answer call when the
// request carries that tool, 2026-11-10).
export function anthropicFixture(payload) {
  const body = structuredClone(loadRecording('unified_extraction/ochre-discount-line').body);
  body.content[0].text = JSON.stringify(payload); return { status: 200, body, recording_template: 'unified_extraction/ochre-discount-line' };
}

export function fiRoutingFixture(kind) {
  const family = kind === 'bank' ? 'bank_statement' : kind === 'receipt' ? 'receipt' : 'invoice_or_bill';
  const hint = kind === 'sales_invoice' ? 'ar' : kind === 'supplier_bill' ? 'ap' : 'unknown';
  return openAiFixture({ document_family: family, confidence: 0.97, direction_hint: hint, candidate_families: [{ family, confidence: 0.97 }],
    language_hint: 'fi', reason: 'Synthetic classification of the printed Finnish document.' });
}

export function fiExtractionFixture(source, options = {}) {
  const template = JSON.parse(loadRecording('unified_extraction/ochre-discount-line').body.content[0].text);
  const sale = source.type === 'sales_invoice';
  const variant = variantOf(options);
  template.document_type = source.type;
  const misprinted = variant ? !variant.foots : Boolean(source.misprint);
  const printedLines = variant ? variant.lines : source.misprint?.lines || null;
  Object.assign(template.header, {
    counterparty_name: variant ? variant.counterparty : source.counterparty, counterparty_role: sale ? 'customer' : 'vendor', counterparty_tax_id: sale ? null : '2200011-9',
    own_name: FI_PROFILE.companyName, own_tax_id: FI_PROFILE.businessId, document_date: variant ? variant.date : source.date, due_date: sale ? '2026-03-28' : source.date,
    currency: 'EUR', subtotal_amount: printedLines ? null : source.net, tax_amount: variant ? variant.vat : source.vat, shipping_amount: 0, discount_amount: 0, rounding_amount: 0,
    total_amount: variant ? variant.total : source.total, line_amounts_include_tax: Boolean(printedLines), payment_status: sale ? 'unpaid' : 'paid',
    payment_terms: sale ? '14 päivää netto' : 'Maksettu', references: [{ type: source.type === 'receipt' ? 'receipt_number' : 'invoice_number', value: variant ? variant.reference : source.reference }]
  });
  template.lines = printedLines
    ? printedLines.map((line) => ({ description: line.description, quantity: 1, unit_price: line.amount, amount: line.amount, tax_rate: source.vatRate }))
    : [{ description: source.description, quantity: 1, unit_price: source.net, amount: source.net, tax_rate: source.exempt ? 0 : source.vatRate }];
  template.warnings = misprinted ? ['printed line items do not add up to the printed total'] : [];
  return anthropicFixture(template);
}

const amountsIn = (text) => [...String(text).matchAll(/money_(?:out|in)=([0-9.]+)/g)].map((m) => Number(m[1]));
const refsIn = (text) => [...String(text).matchAll(/candidate_ref=(candidate_\d+)/g)].map((m) => m[1]);

// The matcher answers from the prompt it was given: the candidate whose bank
// amount equals the document total. Handles are call-local by contract.
export function fiMatchingResponder(request) {
  const content = String(request?.messages?.[0]?.content || '');
  const total = Number((/total_amount=([0-9.]+)/.exec(content) || [])[1]);
  const refs = refsIn(content); const amounts = amountsIn(content);
  const index = amounts.findIndex((amount) => Number.isFinite(total) && Math.abs(amount - total) < 0.005);
  if (index < 0 || !refs[index]) return anthropicFixture({ proposals: [], unmatchable_reason: 'no_plausible_match' });
  return anthropicFixture({ proposals: [{ candidate_ref: refs[index], confidence: 0.96,
    reasoning: `The EUR ${total} movement quotes the same counterparty and amount as the document.`, hops: ['amount_exact', 'within_window'] }], unmatchable_reason: null });
}

// The text lanes' input on either provider (2026-11-10, Claude first): the
// OpenAI Responses `input`, or the Anthropic Messages user turn. The answer
// stays OpenAI-shaped; the recorded-providers stub serves it in the Messages
// shape to an Anthropic request.
const textLaneInput = (request) => {
  if (typeof request?.input === 'string') return JSON.parse(request.input);
  const turn = (request?.messages || []).filter((message) => message?.role === 'user').at(-1);
  const content = typeof turn?.content === 'string' ? turn.content
    : (turn?.content || []).filter((block) => block?.type === 'text').map((block) => block.text).join('');
  return JSON.parse(content);
};

export function fiCodingResponder(request, overrides = {}) {
  const input = textLaneInput(request);
  const base = JSON.parse(loadRecording('transaction_coding/kestrel-two-lines-coded').body.output[0].content[0].text).suggestions[1];
  const rows = input.transactions || [input.transaction];
  const suggestions = rows.map((row) => {
    const text = `${row.description || ''} ${row.raw_description || ''}`.toUpperCase();
    const source = FI_SOURCES.find((s) => text.includes(s.bankText.split(' ').slice(-2).join(' ').toUpperCase()) || text.includes(s.counterparty.toUpperCase()))
      || FI_SOURCES.find((s) => Math.abs(Number(row.money_out || row.money_in || 0) - s.total) < 0.005);
    const suggestion = { ...base, transaction_id: row.id, proposed_account: source?.account || 'Suspense', contact: source?.counterparty || '',
      tax_treatment: source?.treatment || 'ALV-tarkistus', support_note: source?.description || '', ask_client_question: '', evidence_required: false,
      merchant_pattern: (source?.counterparty || '').toLowerCase(), confidence: source ? 'high' : 'low', materiality: 'normal',
      posting_requirement: 'single_account', document_allocations: [],
      reasoning: 'Synthetic strong-coder verdict grounded in the matched Finnish document and bank text.', warnings: [], alternatives: [] };
    const override = typeof overrides === 'function' ? overrides(row, source, suggestion) : overrides[source?.key];
    return override ? { ...suggestion, ...override } : suggestion;
  });
  return openAiFixture(input.transactions ? { suggestions, group_summary: [] } : suggestions[0]);
}

export const fiDocumentDispositionFixture = () => anthropicFixture({ disposition: 'chase_evidence', materiality: 'material', expense_kind: 'documented_bank_transfer',
  settlement_channel: 'uncovered_account', confidence: 0.98, reasoning: 'The document states a bank settlement that has not arrived yet.' });
export function fiBankDispositionResponder(request) {
  const system = typeof request?.system === 'string' ? request.system : '';
  const debit = system.startsWith('You triage a single unmatched bank DEBIT');
  const credit = system.startsWith('You triage a single unmatched bank CREDIT');
  if (!debit && !credit) throw new Error('Synthetic disposition received no exact bank direction.');
  return anthropicFixture({ disposition: debit ? 'chase_receipt' : 'chase_evidence', materiality: 'material', expense_kind: 'bank_transfer',
    confidence: 0.98, reasoning: 'The bank text names a counterparty whose document has not arrived yet.' });
}
// Ask drafting: one grounded question per admitted item, handles copied
// verbatim from the prompt (call-local by contract, never database ids).
export function fiAskDraftResponder(request) {
  const input = textLaneInput(request);
  const items = (input.coding_items || []).map((item) => ({ transaction_ref: item.transaction_ref, disposition: 'ask',
    question: `What was the payment "${item.description}" on ${item.date} for, and is it a business expense?`,
    evidence_type: 'business_purpose', fyi_note: '', skip_reason: '', local_document_refs: [] }));
  const documentAsks = (input.document_items || []).map((item) => ({ document_ref: item.document_ref, disposition: 'ask',
    question: `The receipt ${item.filename || item.document_ref} prints figures that do not add up. Could you send a corrected copy or explain the difference?`,
    evidence_type: 'supporting_document', skip_reason: '' }));
  return openAiFixture({ subject: 'Muutama kysymys kirjanpitoon', message_markdown: 'Hei,\n\nmuutama kysymys maaliskuun kirjanpitoon.', summary: 'Synthetic ask draft.',
    items, statement_requests: [], document_asks: documentAsks });
}
