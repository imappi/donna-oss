// Scripted stand-ins for the OpenAI lanes of the Kultalanka month, used only
// by a recording pass: `--record --stand-in=openai`, or a `--fill` pass for
// an OpenAI lane the recordings hold only as stand-ins (scripts/demo_fi.mjs),
// while a lane cannot be recorded live. Each answer is written from the pack's own files (the
// statement's printed rows, labels.json's documents and adjudicated lines) in
// the lane's own wire shape (an OpenAI Responses body whose output_text is
// the strict-schema JSON the module asked for), so the module's parser,
// schema checks and writers run on it as on a live answer. The recordings
// mark every such answer `provenance: "scripted_stand_in"`, and the answer
// names its own model, never the one asked for: `scripted-stand-in-for-
// <requested model>`, so a receipt built from the answer reads
// `scripted-stand-in-for-gpt-5.4+replayed`. One receipt does not: the
// document router's confidence envelope stores the configured model
// (documentRouter.js returns config.model), so routing receipts, and the
// coder prompts that quote them, say `gpt-5.4`. A live re-record replaces
// the stand-ins.
//
// A lane with no stand-in answers 418 (refused, never retried), so the
// recording run shows what is missing instead of inventing an answer.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseRequestBody } from '../server/donna/providerReplay.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACK = path.join(ROOT, 'data', 'evals', 'fixtures', 'fi-kultalanka-2025-02');
const labels = JSON.parse(readFileSync(path.join(PACK, 'labels.json'), 'utf8'));
const fileBySha = new Map(labels.sources.map((s) => [s.sha256, s.file]));

export const standInLedger = [];

const respond = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
export const STAND_IN_MODEL_PREFIX = 'scripted-stand-in-for-';
const responsesBody = (model, value) => ({
  id: 'resp_stand_in',
  object: 'response',
  // A fixed time (the end of the pack's month), so a refill does not
  // rewrite every stand-in answer.
  created_at: 1740787200,
  status: 'completed',
  model: `${STAND_IN_MODEL_PREFIX}${model || 'unnamed-model'}`,
  output: [{ id: 'msg_stand_in', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', annotations: [], text: typeof value === 'string' ? value : JSON.stringify(value) }] }],
  usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
});

// Which pack file does a request carry? The base64 bytes, hashed.
const fileOfRequest = (body) => {
  let found = null;
  const walk = (value) => {
    if (found) return;
    if (typeof value === 'string') {
      const m = /^data:[^;,]+;base64,(.+)$/s.exec(value);
      const b64 = m ? m[1] : (value.length > 512 && /^[A-Za-z0-9+/=\r\n]+$/.test(value) ? value : null);
      if (b64) found = fileBySha.get(createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex')) || null;
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(body);
  return found;
};

const FAMILY_BY_PREFIX = [
  [/^01 /, 'bank_statement', 'unknown'],
  [/^02 /, 'financing', 'ap'],
  [/^1[0-3] /, 'invoice_or_bill', 'ar'],
  [/^14 /, 'payout_statement', 'ar'],
  [/^2\d /, 'invoice_or_bill', 'ap'],
  [/^30 /, 'payroll', 'ap'],
  [/^4\d /, 'receipt', 'ap']
];

const routing = (body) => {
  const file = fileOfRequest(body);
  const hit = file && FAMILY_BY_PREFIX.find(([re]) => re.test(file));
  if (!hit) return null;
  return {
    document_family: hit[1],
    confidence: 0.95,
    direction_hint: hit[2],
    candidate_families: [{ family: hit[1], confidence: 0.95 }],
    language_hint: 'fi',
    reason: `Scripted stand-in from the pack: ${file}.`
  };
};

// The statement's printed rows (labels.json `lines[].bank`) with running
// balances from the printed opening balance.
const OPENING = 8136.99;
const statement = (body) => {
  if (fileOfRequest(body) !== '01 OP Tiliote 02-2025.pdf') return null;
  let balance = OPENING;
  const transactions = labels.lines.filter((line) => line.bank).sort((a, b) => a.bank.statement_row - b.bank.statement_row).map((line) => {
    const { date, amount, direction, counterparty, message, kind } = line.bank;
    balance = Math.round((balance + (direction === 'in' ? amount : -amount)) * 100) / 100;
    return { date, counterparty, payment_method: kind, message, reference: null, description: `${kind} ${counterparty} ${message}`.trim(), direction, amount, currency: 'EUR', balance };
  });
  const deposits = transactions.filter((t) => t.direction === 'in').reduce((s, t) => s + t.amount, 0);
  const payouts = transactions.filter((t) => t.direction === 'out').reduce((s, t) => s + t.amount, 0);
  return {
    transactions,
    statement_summary: {
      opening_balance: OPENING,
      closing_balance: balance,
      total_deposits: Math.round(deposits * 100) / 100,
      total_payouts: Math.round(payouts * 100) / 100,
      currency: 'EUR',
      period_start: '2025-02-01',
      period_end: '2025-02-28',
      account_identifier: 'FI03 5000 9420 0012 34'
    }
  };
};

// The statement's OCR transcription pass (no schema: the lane is named by
// its endpoint): the printed rows, one per line, single-spaced, as the
// prompt asks — date, type, payee, message, amount, balance, currency.
const transcription = (body) => {
  if (fileOfRequest(body) !== '01 OP Tiliote 02-2025.pdf') return null;
  let balance = OPENING;
  const rows = labels.lines.filter((line) => line.bank).sort((a, b) => a.bank.statement_row - b.bank.statement_row).map(({ bank }) => {
    balance = Math.round((balance + (bank.direction === 'in' ? bank.amount : -bank.amount)) * 100) / 100;
    const [y, m, d] = bank.date.split('-');
    return `${d}.${m}.${y} ${bank.kind} ${bank.counterparty} ${bank.message} ${bank.direction === 'in' ? '' : '-'}${bank.amount.toFixed(2)} ${balance.toFixed(2)} EUR`;
  });
  return ['OP Tiliote 02/2025', 'Tilinumero FI03 5000 9420 0012 34', 'Tilinomistaja Kampaamo Kultalanka Oy', 'Kausi 01.02.2025 - 28.02.2025',
    `Alkusaldo 31.01.2025 ${OPENING.toFixed(2)} EUR`, ...rows].join('\n');
};


// The coder (transaction_coding_batch_suggestion): one suggestion per
// transaction in the batch, from the pack line it is (date + amount +
// direction) and that line's decision class. A coarse, single-account reading
// of the adjudicated answer — enough to drive the posting, VAT and ask paths;
// a live recording replaces it.
const CODING_BY_CLASS = {
  processor_settlement: ['Sales', 'ALV 25,5 %'],
  cash_sales_deposit: ['Sales', 'ALV 25,5 %'],
  multi_rate_receipt: ['Operating supplies', 'ALV 14 %'],
  refund_group: ['Operating supplies', 'ALV 25,5 %'],
  meal_refreshment: ['Meals and entertainment', 'Vähennyskelvoton ALV (osto)'],
  ar_settlement: ['Myyntisaamiset', 'Ei ALV-käsittelyä'],
  loan_split: ['Loan payable', 'Ei ALV-käsittelyä'],
  payroll: ['Payroll', 'Ei ALV-käsittelyä'],
  bank_fee: ['Bank fees', 'Veroton toiminta (ALV-vapaa)']
};
const CODING_BY_PARTY = [
  [/HÄMEEN SALI/, 'Rent', 'Veroton toiminta (ALV-vapaa)'],
  [/TURVA/, 'Insurance', 'Veroton toiminta (ALV-vapaa)'],
  [/TAMPERE ENERGIA/, 'Utilities', 'ALV 25,5 %'],
  [/TELEYHTYMÄ/, 'Telecommunications', 'ALV 25,5 %'],
  [/P-TAMPERE/, 'Travel', 'ALV 25,5 %'],
  [/HIUS-TUKKU/, 'Cost of sales', 'ALV 25,5 %'],
  [/GOOGLE/, 'Software subscriptions', 'EU-palveluosto'],
  [/META/, 'Marketing', 'EU-palveluosto'],
  [/WELLA/, 'Cost of sales', 'EU-tavaraosto'],
  [/TYÖLLISYYSRAHASTO|ILMARINEN/, 'TyEL and payroll contributions payable', 'Ei ALV-käsittelyä']
];
const ASK_CLASSES = {
  private_spend: ['owner_fact', 'Was the St1 fuel purchase on 14.2. for the business, or a private expense paid from the company account?'],
  dated_rate: ['owner_fact', 'When was this purchase made and the service or goods received? The receipt shows a VAT rate that changed on 1.1.2025.'],
  combined_charge: ['owner_fact', 'This payment is more than invoice 1002. What does the extra amount cover?'],
  missing_receipt: ['owner_fact', 'Please send the receipt for this payment and say what it was for.']
};
const lineOf = (tx) => {
  const amount = Number(tx.money_out || 0) > 0 ? Number(tx.money_out) : Number(tx.money_in || 0);
  const direction = Number(tx.money_out || 0) > 0 ? 'out' : 'in';
  return labels.lines.find((line) => line.bank && line.bank.date === tx.date && line.bank.direction === direction && Math.abs(line.bank.amount - amount) < 0.005) || null;
};
const suggestionFor = (tx) => {
  const line = lineOf(tx);
  const base = {
    transaction_id: tx.id, posting_requirement: 'single_account', document_allocations: [], contact: line?.bank.counterparty || '',
    processor_fee_tax_treatment: '', source_business_use_resolution: '', source_identity_resolution: '', historical_rate_basis: '',
    support_note: 'Scripted stand-in from the pack labels.', ask_client_question: '', evidence_required: false, remember_candidate: false,
    merchant_pattern: '', missing_account_name: '', missing_account_type: '', missing_account_reason: '', auto_explain_limit: 0,
    confidence: 'high', materiality: 'normal', reasoning: `Scripted stand-in: ${line ? `${line.id} ${line.decision_class}` : 'no pack line'}.`, warnings: [], alternatives: []
  };
  if (!line) return { ...base, proposed_account: 'Suspense', tax_treatment: 'Ei ALV-käsittelyä', confidence: 'low' };
  const ask = ASK_CLASSES[line.decision_class];
  if (ask) return { ...base, proposed_account: 'Suspense', tax_treatment: 'Ei ALV-käsittelyä', posting_requirement: ask[0], ask_client_question: ask[1], evidence_required: true, confidence: 'medium' };
  const vero = /VEROHALLINTO/.test(line.bank.counterparty)
    ? (line.bank.amount === 1245 ? ['Suoritettava arvonlisävero', 'Ei ALV-käsittelyä'] : ['Payroll withholding and employer health-insurance payable', 'Ei ALV-käsittelyä'])
    : null;
  const party = CODING_BY_PARTY.find(([re]) => re.test(line.bank.counterparty));
  const [account, tax] = vero || (party ? [party[1], party[2]] : CODING_BY_CLASS[line.decision_class] || ['Suspense', 'Ei ALV-käsittelyä']);
  return { ...base, proposed_account: account, tax_treatment: tax };
};
const coding = (body) => {
  let input;
  try { input = JSON.parse(typeof body?.input === 'string' ? body.input : ''); } catch { return null; }
  if (!Array.isArray(input?.transactions)) return null;
  return { suggestions: input.transactions.map(suggestionFor), group_summary: [] };
};

// The ask drafter (client_ask_message_draft): one question per coding item
// whose verdict asks the owner, in Finnish, with the verdict's own question.
const askDraft = (body) => {
  let input;
  try { input = JSON.parse(typeof body?.input === 'string' ? body.input : ''); } catch { return null; }
  if (!Array.isArray(input?.coding_items)) return null;
  const items = input.coding_items
    .filter((item) => item?.verdict?.evidence_required || item?.verdict?.ask_client_question)
    .map((item) => ({
      transaction_ref: item.transaction_ref,
      disposition: 'ask',
      question: item.verdict.ask_client_question || `Mihin maksu ${item.description} (${item.date}) liittyi?`,
      evidence_type: /kuitti|receipt/i.test(item.verdict.ask_client_question || '') ? 'supporting_document' : 'business_purpose',
      fyi_note: '',
      skip_reason: '',
      local_document_refs: []
    }));
  return {
    subject: 'Kysymyksiä helmikuun 2025 kirjanpidosta',
    message_markdown: `Hei,\n\nkirjanpidosta jäi ${items.length} kysymystä. Vastaathan alla.\n`,
    summary: `${items.length} questions about February 2025.`,
    items,
    statement_requests: [],
    document_asks: []
  };
};

// The single-line coder (transaction_coding_suggestion): the same reading,
// shaped to the schema the request names (its required fields, in order).
const defaultFor = (schema) => {
  const type = Array.isArray(schema?.type) ? schema.type[0] : schema?.type;
  if (schema?.enum) return schema.enum.includes('') ? '' : schema.enum[0];
  if (type === 'string') return '';
  if (type === 'number' || type === 'integer') return 0;
  if (type === 'boolean') return false;
  if (type === 'array') return [];
  if (type === 'object') return {};
  return null;
};
const codingSingle = (body) => {
  let input;
  try { input = JSON.parse(typeof body?.input === 'string' ? body.input : ''); } catch { return null; }
  const schema = body?.text?.format?.schema;
  if (!input?.transaction || !schema?.properties) return null;
  const suggestion = suggestionFor(input.transaction);
  return Object.fromEntries((schema.required || Object.keys(schema.properties)).map((key) => {
    const allowed = schema.properties[key]?.enum;
    const value = key in suggestion ? suggestion[key] : defaultFor(schema.properties[key]);
    return [key, allowed && !allowed.includes(value) ? defaultFor(schema.properties[key]) : value];
  }));
};

const LANES = { document_routing: routing, bank_statement_extraction: statement, 'openai:/v1/responses': transcription, transaction_coding: (body) => (body?.text?.format?.name === 'transaction_coding_suggestion' ? codingSingle(body) : coding(body)), ask_drafting: askDraft,
  // Firm-fact distillation after an owner answer: nothing new to remember.
  memory_extraction: (body) => (body?.text?.format?.name === 'firm_fact_distillation' ? { facts: [] } : null) };

export const answerOpenAiStandIn = async ({ init, classified }) => {
  const body = parseRequestBody(init);
  const make = LANES[classified.lane];
  const value = make ? make(body) : null;
  standInLedger.push({ lane: classified.lane, answered: Boolean(value) });
  if (!value) {
    return respond(418, { error: { type: 'stand_in_missing', message: `no scripted stand-in for lane ${classified.lane}` } });
  }
  return respond(200, responsesBody(body?.model, value));
};
