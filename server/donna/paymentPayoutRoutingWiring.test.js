import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { routeDocument } from './documentRouter.js';
import {
  __buildClassification,
  directionForDocumentType,
  pickExtractor
} from './inngest/parseDocument.js';
import { DESKTOP_CLIENT_FLAG_SEEDS } from './desktop/hostPlaneSeed.js';

const responseFor = (output) => ({
  ok: true,
  status: 200,
  json: async () => ({ output_text: JSON.stringify(output) })
});

// The desktop seed posture, nothing else: every DESKTOP_CLIENT_FLAG_SEEDS key
// at `auto`, no promotion row (RT-05 deleted per-family promotion — a
// confident payout classification routes on the seed alone).
const configSnapshot = Object.fromEntries(
  DESKTOP_CLIENT_FLAG_SEEDS.map((key) => [key, { stage: 'auto', source: 'desktop_baseline' }])
);

let priorApiKey;
before(() => {
  priorApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
});
after(() => {
  if (priorApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = priorApiKey;
});

test('production wiring sends an inbound processor payout through the payout-statement extractor (RT-18)', async () => {
  // Before RT-18 the router carried a payout as payment_confirmation/ar ⇒
  // issued_receipt, and the sales-invoice extractor projected ONE net figure
  // through an invoice-shaped schema. The family now has its own type and
  // extractor: the breakdown (gross → fees → net) is read, the NET is the
  // header total, and the matcher scans money_in.
  const routerResult = await routeDocument({
    base64: Buffer.from('synthetic-payout').toString('base64'),
    filename: 'processor-settlement.pdf',
    mimeType: 'application/pdf',
    clientIdentity: { display_name: 'Example Merchant Ltd', legal_names: [] },
    __callOpenAi: async () => responseFor({
      document_family: 'payout_statement',
      confidence: 0.98,
      direction_hint: 'ar',
      candidate_families: [
        { family: 'payout_statement', confidence: 0.98 },
        { family: 'payment_confirmation', confidence: 0.02 }
      ],
      language_hint: 'en',
      reason: 'A processor remitted one net settlement of the firm\'s sales proceeds.'
    })
  });

  const routed = __buildClassification({
    routerResult,
    originalType: 'unknown',
    minConfidence: 0.65,
    routerModel: routerResult.model,
    pickExtractorImpl: (type) => pickExtractor(type, { configSnapshot })
  });
  const extractor = pickExtractor(routed.finalType, { configSnapshot });

  assert.equal(routerResult.recommended_extractor, 'payout_statement');
  assert.equal(routed.classification.family, 'payout_statement', 'the receipt carries the family');
  assert.equal(routed.finalType, 'payout_statement');
  assert.equal(routed.classification.direction_hint, 'ar');
  assert.equal(routed.classification.fallback_used, false);
  assert.equal(extractor?.type, 'payout_statement');
  assert.equal(directionForDocumentType(routed.finalType), 'incoming');

  const extracted = await extractor.extract({
    base64: Buffer.from('synthetic-payout').toString('base64'),
    filename: 'processor-settlement.pdf',
    mimeType: 'application/pdf',
    clientIdentity: { display_name: 'Example Merchant Ltd', legal_names: [] },
    documentType: routed.finalType,
    fetchImpl: async () => responseFor({
      extraction_status: 'validated',
      extraction_confidence: 0.99,
      warnings: [],
      document_kind: 'payout_statement',
      provider_name: 'Square',
      provider_tax_id: null,
      merchant_name: 'Example Merchant Ltd',
      merchant_tax_id: null,
      period_start: '2024-12-30',
      period_end: '2024-12-31',
      payout_date: '2025-01-01',
      currency: 'USD',
      gross_sales: 6041.3,
      gross_components: [],
      refunds: 0,
      fees: [{ description: 'Square processing fees', amount: 118.17, tax_amount: 0 }],
      adjustments: [],
      net_payout: 5923.13,
      transaction_count: 57,
      payout_reference: 'SETTLEMENT-1',
      deposit_reference: null,
      bank_last4: '1234'
    })
  });
  assert.equal(extracted.kind, 'completed');
  assert.equal(extracted.header.vendor_name, 'Square', 'the processor is the counterparty the bank line names');
  assert.equal(extracted.header.customer_name, null);
  assert.equal(extracted.header.total_amount, 5923.13, 'the NET settlement reaches the writer as the header total');
  assert.equal(extracted.header.payment_status, 'paid');
  assert.equal(extracted.header.reference_number, 'SETTLEMENT-1');
  assert.deepEqual(extracted.lines.map((line) => line.amount), [6041.3, -118.17], 'the breakdown reaches the writer as signed lines');
  assert.equal(extracted.summary.totals_validation.matches, true, 'gross − fees = net, through THE totals formula');
  assert.equal(extracted.summary.settlement.gross_sales, 6041.3);
});

test('the same family keeps outbound confirmations on the existing payment matcher lane', async () => {
  const routerResult = await routeDocument({
    base64: Buffer.from('synthetic-payment').toString('base64'),
    filename: 'tax-payment-confirmation.pdf',
    mimeType: 'application/pdf',
    clientIdentity: { display_name: 'Example Merchant Ltd', legal_names: [] },
    __callOpenAi: async () => responseFor({
      document_family: 'payment_confirmation',
      confidence: 0.97,
      direction_hint: 'ap',
      candidate_families: [{ family: 'payment_confirmation', confidence: 0.97 }],
      language_hint: 'en',
      reason: 'The firm paid one tax settlement from its bank account.'
    })
  });

  assert.equal(routerResult.recommended_extractor, 'payment_confirmation');
  assert.equal(pickExtractor(routerResult.recommended_extractor, { configSnapshot })?.type, 'generic_document');
  assert.equal(directionForDocumentType(routerResult.recommended_extractor), 'outgoing');
});
