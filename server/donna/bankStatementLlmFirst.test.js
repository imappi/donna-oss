import { Buffer } from 'node:buffer';

import {
  extractBankStatementFromBase64,
  repairStructuredDirectionsFromBalances,
  __visionSummaryFromHint
} from './bankStatement.js';
import { composeStatementLineDescription, extractStructuredFromStatementText } from './bankStatementVision.js';

// LLM-first bank-statement extraction (the BANK_STATEMENT_LLM_EXTRACTION
// path). Everything here runs against a mocked OpenAI endpoint — no
// network. The fixture is the failure this slice exists for: a Finnish
// tiliote whose per-line "Selitys" column (TILISIIRTO / KORTTIMAKSU /
// PALVELUMAKSU) is the payment METHOD, while the counterparty lives in
// its own Saaja/Maksaja field — the regex tiers shipped the method word
// as the whole description and starved the matcher of the vendor signal.

let passed = 0;
let failed = 0;

const assert = (label, condition, detail = '') => {
  if (condition) {
    passed += 1;
    return;
  }
  failed += 1;
  console.error(`FAIL: ${label}${detail ? `\n  ${detail}` : ''}`);
};

process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_VISION_CACHE_DISABLED = 'true';
delete process.env.OPENAI_VISION_MODEL;

const withMockedFetch = async (handler, fn) => {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
};

const jsonResponse = (body) => ({ ok: true, json: async () => body });

const structuredResponse = (payload) =>
  jsonResponse({ output: [{ content: [{ text: JSON.stringify(payload) }] }] });

// A footing tiliote: 10000.00 + 1250.00 − 245.60 − 12.50 = 10991.90.
const FINNISH_PAYLOAD = {
  transactions: [
    {
      date: '2026-05-04',
      counterparty: 'K-Rauta Espoo',
      payment_method: 'KORTTIMAKSU',
      message: null,
      reference: null,
      description: 'Korttimaksu',
      direction: 'out',
      amount: 245.6,
      currency: 'EUR',
      balance: 9754.4
    },
    {
      date: '2026-05-06',
      counterparty: 'Koneistamo Airaksinen Oy',
      payment_method: 'TILISIIRTO',
      message: 'Lasku 1042',
      reference: null,
      description: 'Tilisiirto',
      direction: 'in',
      amount: 1250,
      currency: 'EUR',
      balance: 11004.4
    },
    {
      date: '2026-05-10',
      counterparty: null,
      payment_method: 'PALVELUMAKSU',
      message: null,
      reference: null,
      description: 'PALVELUMAKSU',
      direction: 'out',
      amount: 12.5,
      currency: 'EUR',
      balance: 10991.9
    }
  ],
  statement_summary: {
    opening_balance: 10000,
    closing_balance: 10991.9,
    total_deposits: 1250,
    total_payouts: 258.1,
    currency: 'EUR',
    period_start: '2026-05-01',
    period_end: '2026-05-31',
    account_identifier: 'FI21 1234 5600 0007 85'
  }
};

const TILIOTE_TEXT = [
  'TILIOTE 5/2026',
  'Saldo 1.5.2026 10 000,00',
  '4.5. KORTTIMAKSU K-Rauta Espoo 245,60- 9 754,40',
  '6.5. TILISIIRTO Koneistamo Airaksinen Oy Lasku 1042 1 250,00+ 11 004,40',
  '10.5. PALVELUMAKSU 12,50- 10 991,90',
  'Saldo 31.5.2026 10 991,90'
].join('\n');

const extractTiliote = ({ payload = FINNISH_PAYLOAD, llmFirst = true, filename = 'tiliote-2026-05.txt' } = {}) =>
  extractBankStatementFromBase64({
    base64: Buffer.from(TILIOTE_TEXT, 'utf8').toString('base64'),
    filename,
    mimeType: 'text/plain',
    ledgerCurrency: 'EUR',
    llmFirst
  });

// ── composeStatementLineDescription ─────────────────────────────────────
{
  assert(
    'counterparty leads, message follows',
    composeStatementLineDescription({
      counterparty: 'Koneistamo Airaksinen Oy',
      payment_method: 'TILISIIRTO',
      message: 'Lasku 1042'
    }) === 'Koneistamo Airaksinen Oy · Lasku 1042'
  );
  assert(
    'counterparty alone stands alone',
    composeStatementLineDescription({ counterparty: 'K-Rauta Espoo', payment_method: 'KORTTIMAKSU' }) ===
      'K-Rauta Espoo'
  );
  assert(
    'payment method is never the headline while a party exists',
    !composeStatementLineDescription({
      counterparty: 'K-Rauta Espoo',
      payment_method: 'KORTTIMAKSU'
    }).toLowerCase().includes('korttimaksu')
  );
  assert(
    'no party → message leads',
    composeStatementLineDescription({ message: 'Palkka toukokuu', payment_method: 'TILISIIRTO' }) ===
      'Palkka toukokuu'
  );
  assert(
    'no party, no message → reference leads',
    composeStatementLineDescription({ reference: 'RF18 5390 0754 7034', payment_method: 'VIITESIIRTO' }) ===
      'RF18 5390 0754 7034'
  );
  assert(
    'genuinely partyless fee line falls back to the method word once',
    composeStatementLineDescription({ payment_method: 'PALVELUMAKSU', model_description: 'PALVELUMAKSU' }) ===
      'PALVELUMAKSU'
  );
  assert(
    'model description survives when it says more than the method',
    composeStatementLineDescription({ payment_method: 'TILISIIRTO', model_description: 'SEPA transfer to landlord' }) ===
      'SEPA transfer to landlord'
  );
  assert(
    'duplicate detail collapses into the party',
    composeStatementLineDescription({ counterparty: 'Vero', message: 'vero' }) === 'Vero'
  );
}

// ── __visionSummaryFromHint carries the printed totals ──────────────────
{
  const summary = __visionSummaryFromHint(FINNISH_PAYLOAD.statement_summary);
  assert('hint totals map to deposits', summary.deposits === 1250, JSON.stringify(summary));
  assert('hint totals map to payouts', summary.payouts === 258.1);
  assert('hint balances map through', summary.starting_balance === 10000 && summary.ending_balance === 10991.9);
  assert('hint account identifier maps to account_number', summary.account_number === 'FI21 1234 5600 0007 85');
}

// ── text transport: schema on the wire + normalization ──────────────────
{
  let requestBody = null;
  const result = await withMockedFetch(
    async (url, init) => {
      requestBody = JSON.parse(init.body);
      return structuredResponse(FINNISH_PAYLOAD);
    },
    () => extractStructuredFromStatementText({ text: TILIOTE_TEXT, filename: 'tiliote-2026-05.txt' })
  );

  const schema = requestBody?.text?.format?.schema;
  const itemSchema = schema?.properties?.transactions?.items;
  assert('request uses strict json_schema', requestBody?.text?.format?.strict === true);
  assert(
    'line schema requires every semantic field (strict mode)',
    ['counterparty', 'payment_method', 'message', 'reference'].every(
      (key) => itemSchema?.properties?.[key] && itemSchema?.required?.includes(key)
    ),
    JSON.stringify(itemSchema?.required)
  );
  assert(
    'summary schema carries printed totals',
    ['total_deposits', 'total_payouts'].every(
      (key) => schema?.properties?.statement_summary?.required?.includes(key)
    )
  );
  assert(
    'strict mode invariant: required matches properties on line schema',
    JSON.stringify([...(itemSchema?.required || [])].sort()) ===
      JSON.stringify(Object.keys(itemSchema?.properties || {}).sort())
  );
  assert('model id returned for the receipt', result.model === 'gpt-5.4', result.model);
  assert('three rows normalized', result.transactions.length === 3);
  assert(
    'semantic fields survive normalization',
    result.transactions[1].counterparty === 'Koneistamo Airaksinen Oy' &&
      result.transactions[1].payment_method === 'TILISIIRTO' &&
      result.transactions[1].message === 'Lasku 1042',
    JSON.stringify(result.transactions[1])
  );
  assert(
    'description recomposed counterparty-first over the model\'s "Tilisiirto"',
    result.transactions[1].description === 'Koneistamo Airaksinen Oy · Lasku 1042',
    result.transactions[1].description
  );
  assert('text rows carry the openai_text parser flag', result.transactions[0].parser_flags.includes('openai_text'));
}

// ── end-to-end: llmFirst on a Finnish text statement ────────────────────
{
  const result = await withMockedFetch(
    async () => structuredResponse(FINNISH_PAYLOAD),
    () => extractTiliote()
  );

  assert('source is openai_text_structured', result.extraction_source === 'openai_text_structured', result.extraction_source);
  assert('footing statement is validated', result.extraction_status === 'validated', JSON.stringify(result.warnings));
  assert('all rows flow', result.transactions.length === 3);
  assert(
    'list line reads the counterparty, not "Korttimaksu"',
    result.transactions[0].description === 'K-Rauta Espoo',
    result.transactions[0].description
  );
  assert(
    'counterparty persists on the row for the matcher/coder',
    result.transactions[0].counterparty === 'K-Rauta Espoo' && result.transactions[0].payment_method === 'KORTTIMAKSU'
  );
  assert(
    'partyless fee line keeps its honest method word',
    result.transactions[2].description === 'PALVELUMAKSU'
  );
  assert('statement summary carries printed totals', result.statement_summary?.deposits === 1250);
  assert('hint currency backstops statement currency', result.statement_currency === 'EUR', result.statement_currency);
  assert(
    'EUR statement on EUR ledger is native',
    result.transactions.every((t) => t.account_currency === 'EUR' && t.ledger_conversion_status === 'native')
  );
  assert('extraction model is on the receipt', result.extraction_model === 'gpt-5.4', String(result.extraction_model));
}

// ── Keep layer: the balance equation withholds a non-footing extraction ──
{
  const broken = {
    ...FINNISH_PAYLOAD,
    statement_summary: { ...FINNISH_PAYLOAD.statement_summary, closing_balance: 10000, total_deposits: null, total_payouts: null }
  };
  const result = await withMockedFetch(
    async () => structuredResponse(broken),
    () => extractTiliote({ payload: broken })
  );

  assert('non-footing extraction is withheld', result.transactions.length === 0, JSON.stringify(result.transactions.length));
  assert('withheld extraction needs review', result.extraction_status === 'needs_review', result.extraction_status);
  assert(
    'the warning names the balance equation',
    result.warnings.some((w) => w.includes('do not reconcile with statement balances')),
    JSON.stringify(result.warnings)
  );
  assert(
    'withheld candidates still show the counterparty',
    result.candidate_transactions.length === 3 && result.candidate_transactions[0].counterparty === 'K-Rauta Espoo',
    JSON.stringify(result.candidate_transactions[0] || null)
  );
}

// ── Keep layer repair: printed balances prove a model-flipped direction ──
// Cactus Blossom regression (2026-08-28): every amount was read correctly,
// but one credit was emitted as a debit. The discrepancy was exactly twice
// that row and the all-or-nothing equation withheld all 42 rows. Adjacent
// printed balances are stronger arithmetic evidence than the model's column
// choice, so the direction is corrected before the gate runs.
{
  const wrongDirection = {
    ...FINNISH_PAYLOAD,
    transactions: FINNISH_PAYLOAD.transactions.map((transaction, index) =>
      index === 0
        ? { ...transaction, direction: 'in' }
        : transaction
    )
  };
  const result = await withMockedFetch(
    async () => structuredResponse(wrongDirection),
    () => extractTiliote({ payload: wrongDirection })
  );

  assert('balance-proven direction repair lets the complete statement flow', result.transactions.length === 3);
  assert('balance-proven direction repair keeps extraction validated', result.extraction_status === 'validated', JSON.stringify(result.warnings));
  assert(
    'the flipped first row is restored to money out without changing its amount',
    result.transactions[0].money_in === 0 && result.transactions[0].money_out === 245.6,
    JSON.stringify(result.transactions[0])
  );
  assert(
    'the repair is durable on the extraction receipt',
    result.transactions[0].parser_flags.includes('direction_from_balance'),
    JSON.stringify(result.transactions[0].parser_flags)
  );
}

// Exact arithmetic from the production regression, reduced from 42 rows to
// three while preserving every relevant total. The bad model response put the
// 5,923.13 opening credit in money_out, yielding the observed 29,064.93 /
// 35,316.17 movement totals instead of 34,988.06 / 29,393.04.
{
  const regressionPayload = {
    transactions: [
      {
        date: '2025-06-02', counterparty: 'Opening credit', payment_method: 'ACH',
        message: null, reference: null, description: 'Opening credit',
        direction: 'out', amount: 5923.13, currency: 'USD', balance: 22733.06
      },
      {
        date: '2025-06-15', counterparty: 'Remaining credits', payment_method: 'ACH',
        message: null, reference: null, description: 'Remaining credits',
        direction: 'in', amount: 29064.93, currency: 'USD', balance: 51797.99
      },
      {
        date: '2025-06-30', counterparty: 'Period debits', payment_method: 'ACH',
        message: null, reference: null, description: 'Period debits',
        direction: 'out', amount: 29393.04, currency: 'USD', balance: 22404.95
      }
    ],
    statement_summary: {
      opening_balance: 16809.93,
      closing_balance: 22404.95,
      total_deposits: 34988.06,
      total_payouts: 29393.04,
      currency: 'USD',
      period_start: '2025-06-01',
      period_end: '2025-06-30',
      account_identifier: 'regression-fixture'
    }
  };
  const result = await withMockedFetch(
    async () => structuredResponse(regressionPayload),
    () => extractTiliote({ payload: regressionPayload, filename: 'statement-2025-06.txt' })
  );
  assert('exact 5,923.13 flip regression validates after balance repair', result.extraction_status === 'validated', JSON.stringify(result.warnings));
  assert('exact flip regression preserves all statement rows', result.transactions.length === 3);
  assert(
    'exact flip regression restores the opening credit',
    result.transactions[0].money_in === 5923.13 && result.transactions[0].money_out === 0,
    JSON.stringify(result.transactions[0])
  );
}

// A newest-first array must never be interpreted as a forward running-balance
// sequence. The opening balance does not lead into its first row, so the same
// helper refuses to flip directions and the equation still catches the bad
// extraction.
{
  const newestFirst = {
    ...FINNISH_PAYLOAD,
    transactions: [...FINNISH_PAYLOAD.transactions].reverse()
  };
  const normalized = newestFirst.transactions.map((transaction) => ({
    ...transaction,
    money_in: transaction.direction === 'in' ? transaction.amount : 0,
    money_out: transaction.direction === 'out' ? transaction.amount : 0,
    parser_flags: []
  }));
  const result = repairStructuredDirectionsFromBalances(
    normalized,
    __visionSummaryFromHint(newestFirst.statement_summary)
  );
  assert(
    'newest-first rows are not direction-repaired without chronological proof',
    result.every((transaction) => !transaction.parser_flags.includes('direction_from_balance')),
    JSON.stringify(result)
  );
}

// ── Keep layer: a printed-summary self-contradiction warns, never vetoes ──
// The 2026-08-25 Honeybee regression shape: rows foot to the cent against
// the extracted opening/closing balances, but the statement's own printed
// payouts total is off by 29.80 against its own balances. The balance
// equation proves the rows; the summary mismatch rides the receipt as
// warnings instead of withholding the extraction.
{
  const decorativeMismatch = {
    ...FINNISH_PAYLOAD,
    statement_summary: { ...FINNISH_PAYLOAD.statement_summary, total_payouts: 287.9 }
  };
  const result = await withMockedFetch(
    async () => structuredResponse(decorativeMismatch),
    () => extractTiliote({ payload: decorativeMismatch })
  );

  assert('rows that foot with the balances commit', result.transactions.length === 3, String(result.transactions.length));
  assert('the extraction validates', result.extraction_status === 'validated', result.extraction_status);
  assert(
    'the summary self-contradiction still warns',
    result.warnings.some((w) => w.includes('Statement summary does not reconcile')),
    JSON.stringify(result.warnings)
  );
  assert(
    'the movement mismatch still warns',
    result.warnings.some((w) => w.includes('Parsed movement does not match statement summary')),
    JSON.stringify(result.warnings)
  );
}

// ── fallback: a model failure degrades to the regex tiers, not to a parse failure ──
{
  const viaFailure = await withMockedFetch(
    async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }) }),
    () => extractTiliote()
  );
  const viaFlagOff = await extractTiliote({ llmFirst: false });

  assert('fallback drops to the regex result', JSON.stringify(viaFailure.transactions) === JSON.stringify(viaFlagOff.transactions));
  assert('fallback status matches the regex path', viaFailure.extraction_status === viaFlagOff.extraction_status);
  assert('fallback carries no model id', viaFailure.extraction_model === null);
}

// ── scope pins: CSV stays deterministic; flag off never calls the model ──
{
  let calls = 0;
  const countingFetch = async () => {
    calls += 1;
    return structuredResponse(FINNISH_PAYLOAD);
  };
  const csv = ['Date,Description,Debit,Credit,Balance', '01/09/2025,Software subscription,S$1000.00,,S$9000.00', '02/09/2025,Client receipt,,2500.00,11500.00'].join('\n');

  const csvResult = await withMockedFetch(countingFetch, () =>
    extractBankStatementFromBase64({
      base64: Buffer.from(csv, 'utf8').toString('base64'),
      filename: 'statement-2025.csv',
      mimeType: 'text/csv',
      llmFirst: true
    })
  );
  assert('CSV upload never reaches the model even with llmFirst on', calls === 0, String(calls));
  assert('CSV rows still parse deterministically', csvResult.transactions.length === 2);

  await withMockedFetch(countingFetch, () => extractTiliote({ llmFirst: false }));
  assert('llmFirst=false never calls the model', calls === 0, String(calls));
}

console.log(`bankStatementLlmFirst tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
