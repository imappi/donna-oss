import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApplianceForTest, applianceHarnessSkipReason } from './testSupport/applianceHarness.js';
import { FI_PROFILE, fiPdf, openAiFixture, fiDocumentDispositionFixture } from './testSupport/fiReliabilitySources.js';
import { handleParseEvent } from './inngest/parseDocument.js';
import { retryParseRunsInDb } from './parseDocumentsDb.js';
import { unifiedExtractorServes } from './unifiedExtractor.js';
import { SUPPLIER_BILL_PROMPT_VERSION } from './supplierBill.js';

// Invented source transcriptions at the provider boundary. These are not live
// model-quality evidence and contain no customer PDF, answer sheet or journal.
const header = (name, total, overrides = {}) => ({
  counterparty_name: name, counterparty_role: 'vendor', document_date: '2026-02-27', due_date: null,
  currency: 'EUR', subtotal_amount: null, tax_amount: 0, shipping_amount: 0, discount_amount: 0,
  rounding_amount: 0, total_amount: total, line_amounts_include_tax: true,
  reference_number: null, references: [], payment_status: 'unpaid', payment_terms_phrase: null, ...overrides
});
const line = (description, amount, taxRate = null) => ({ description, amount, quantity: 1, unit_price: amount, tax_rate: taxRate });
const examples = [
  { family: 'payroll', name: 'Employee Example', total: 2300,
    source: ['PALKKA 27.02.2026', 'Employer: Lumo Kahvila Oy', 'Employee: Employee Example',
      'Gross pay 3000 EUR', 'Tax withholding 500 EUR', 'Employee pension deduction 200 EUR',
      'Net transfer 2300 EUR', 'Employer contributions paid separately 600 EUR'],
    lines: [line('Gross pay', 3000), line('Tax withholding', -500), line('Employee pension deduction', -200)],
    warnings: ['model:employer_contributions_600'] },
  { family: 'financing', name: 'Lender Example', total: 500,
    source: ['LOAN PAYMENT NOTICE 27.02.2026', 'Lender: Lender Example', 'Borrower: Lumo Kahvila Oy',
      'Current installment 500 EUR', 'Principal repayment 450 EUR', 'Interest 40 EUR', 'Service fee 10 EUR', 'Outstanding principal 20000 EUR'],
    lines: [line('Principal repayment', 450), line('Interest', 40), line('Service fee', 10)] },
  { family: 'insurance', name: 'Insurer Example', total: 100,
    source: ['PREMIUM NOTICE 27.02.2026', 'Insurer: Insurer Example', 'Insured: Lumo Kahvila Oy',
      'Current premium installment 100 EUR', 'Annual premium 1200 EUR', 'Coverage limit 100000 EUR'],
    lines: [line('Current premium installment', 100)] },
  { family: 'invoice_or_bill', name: 'Supplier Example', total: 251,
    source: ['INVOICE 27.02.2026', 'Supplier: Supplier Example', 'Buyer: Lumo Kahvila Oy',
      'Supplies net 200 EUR', 'VAT 25.5% 51 EUR', 'Amount due 251 EUR'],
    header: { subtotal_amount: 200, tax_amount: 51, line_amounts_include_tax: false },
    lines: [line('Supplies', 200, 0.255)] }
];
const routing = family => openAiFixture({ document_family: family, confidence: 0.97, direction_hint: 'ap',
  candidate_families: [{ family, confidence: 0.97 }], language_hint: 'fi', reason: 'The readable source describes this payable family.' });
const extract = example => ({ extraction_status: 'validated', extraction_confidence: 0.97,
  header: header(example.name, example.total, example.header), lines: example.lines, warnings: example.warnings || [] });
const runParse = (app, uploaded) => handleParseEvent({ event: { data: { firm_id: app.firmId,
  document_id: uploaded.documentId, parse_run_id: uploaded.registered.parse_run_id } },
  step: { run: async (name, fn) => name === 'parse-and-write' ? fn() : {} }, logger: { info() {}, warn() {}, error() {} } });

test('real PG: shared cloud parse worker uses per-type payable extraction and preserves source components, validation and retry ownership',
  { skip: applianceHarnessSkipReason(), timeout: 120000 }, async () => {
    const app = await bootApplianceForTest({ firm: { jurisdiction: 'FI', currency: 'EUR' }, env: { UNIFIED_EXTRACTOR_DISABLED: 'true' } });
    try {
      const { clientId } = await app.createClient({ profile: FI_PROFILE });
      // Cloud selects the specialist path by host class. The isolated
      // appliance storage harness reaches that same worker dispatch through
      // its existing unified-extractor kill switch; no admission flag changes.
      assert.deepEqual(unifiedExtractorServes({ documentType: 'supplier_bill', env: {} }), { unified: false, reason: 'cloud_per_type_release' });
      app.providers.script('document_disposition', [{ ...fiDocumentDispositionFixture(), times: Infinity }]);
      const requests = [];
      for (const [index, example] of examples.entries()) {
        app.providers.script('document_routing', [routing(example.family)]);
        app.providers.script('supplier_bill_extraction', [{ respond: request => { requests.push(request); return openAiFixture(extract(example)); } }]);
        const uploaded = await app.uploadDocument({ clientId, bytes: await fiPdf(example.source), filename: `document-${index + 1}.pdf`, documentType: 'unknown' });
        const result = await runParse(app, uploaded);
        assert.equal(result.outcome, 'completed', JSON.stringify(result));
        const doc = await app.read.document(uploaded.documentId);
        const lines = (await app.query("select description,amount,tax_rate from document_lines where document_id=$1 order by line_no, id", [uploaded.documentId])).rows;
        assert.equal(doc.document_type, 'supplier_bill'); assert.equal(doc.parse_status, 'completed');
        assert.equal(doc.vendor_name, example.name); assert.equal(doc.customer_name, null);
        assert.equal(Number(doc.total_amount), example.total); assert.equal(doc.currency, 'EUR');
        assert.equal(doc.parse_summary.router.family, example.family);
        assert.equal(doc.parse_summary.classification.final_type, 'supplier_bill');
        assert.equal(doc.parse_summary.extractor.path, 'type_specific');
        assert.equal(doc.parse_summary.prompt_version, SUPPLIER_BILL_PROMPT_VERSION);
        assert.deepEqual(lines.map(l => Number(l.amount)), example.lines.map(l => l.amount));
        assert.equal(doc.parse_summary.totals_validation.matches, true);
        assert.equal(doc.parse_summary.totals_validation.drift, 0);
        if (example.family === 'payroll') {
          assert.equal(doc.parse_summary.line_count, 3);
          assert.ok(lines.every(l => l.tax_rate == null));
          assert.equal(Number(doc.tax_amount), 0);
          assert.ok(doc.parse_summary.warnings.includes('model:employer_contributions_600'));
        }
        const audit = await app.read.audit({ clientId, action: 'document.parse.completed' });
        assert.equal(audit.filter(row => row.resource_id === uploaded.documentId).length, 1);
        const before = JSON.stringify(doc);
        await runParse(app, uploaded);
        assert.equal(JSON.stringify(await app.read.document(uploaded.documentId)), before, 'repeated event cannot replace the completed read');
      }
      assert.equal(app.providers.callsFor('unified_extraction').length, 0);
      assert.equal(app.providers.callsFor('supplier_bill_extraction').length, examples.length);

      const mismatch = { ...examples[0], lines: [line('Gross pay', 3000), line('Tax withholding', -500), line('Employee pension deduction', -100)] };
      app.providers.script('document_routing', [routing('payroll')]);
      app.providers.script('supplier_bill_extraction', [openAiFixture(extract(mismatch))]);
      const bad = await app.uploadDocument({ clientId, bytes: await fiPdf([...examples[0].source, 'Printed deduction inconsistency']), filename: 'document-5.pdf', documentType: 'unknown' });
      assert.equal((await runParse(app, bad)).outcome, 'completed');
      const badDoc = await app.read.document(bad.documentId);
      assert.equal(badDoc.parse_summary.totals_validation.matches, false);
      assert.equal(badDoc.parse_summary.totals_validation.drift, -100);
      assert.ok(badDoc.parse_summary.warnings.includes('amount_mismatch'));
      assert.ok((await app.query("select id from transaction_review_queue where payload->>'document_id'=$1 and reason='amount_mismatch'", [bad.documentId])).rowCount > 0);

      app.providers.script('document_routing', [routing('payroll'), routing('payroll')]);
      app.providers.script('supplier_bill_extraction', [openAiFixture({ ...extract(examples[0]), extraction_status: 'failed', extraction_confidence: 0.2 }), openAiFixture(extract(examples[0]))]);
      const unreadable = await app.uploadDocument({ clientId, bytes: await fiPdf(['Unusable scan of an employee payment record']), filename: 'document-6.pdf', documentType: 'unknown' });
      await runParse(app, unreadable);
      const failed = await app.read.document(unreadable.documentId);
      assert.equal(failed.parse_status, 'failed');
      assert.equal(failed.parse_error.code, 'DOCUMENT_EXTRACTION_UNREADABLE');
      assert.equal(failed.parse_error.reason, 'extractor_status_failed');
      assert.equal(failed.parse_error.retryable, false);
      assert.equal((await app.query('select count(*)::int n from document_lines where document_id=$1', [unreadable.documentId])).rows[0].n, 0);
      assert.equal((await app.query("select count(*)::int n from client_evidence_requests where client_id=$1 and request_payload->>'document_id'=$2", [clientId, unreadable.documentId])).rows[0].n, 0, 'parse failure never fabricates a business-owner accounting question');
      const retried = await retryParseRunsInDb({ firmId: app.firmId, documentIds: [unreadable.documentId] });
      assert.equal(retried.retried.length, 1);
      const pending = await app.read.document(unreadable.documentId);
      assert.notEqual(pending.parse_run_id, failed.parse_run_id);
      assert.equal((await runParse(app, { documentId: unreadable.documentId, registered: { parse_run_id: pending.parse_run_id } })).outcome, 'completed');
      assert.equal((await app.read.document(unreadable.documentId)).parse_status, 'completed');
      assert.equal((await app.query('select count(*)::int n from ledger_journals where client_id=$1', [clientId])).rows[0].n, 0, 'extraction is not accounting authority');
      app.providers.assertNoUnscripted();

      // Inspect the actual request delivered to the provider, not an exported
      // prompt constant. This fails on v1; the wire response fixtures above
      // independently pin signed-line persistence and totals validation.
      // Both keys are lit, so the lane resolves Anthropic first (2026-11-10):
      // the instructions ride as `system`, the schema as the structured-result
      // tool's input schema (past the structured-output limits). On OpenAI the
      // same instructions and schema ride `instructions` / `text.format`.
      for (const sent of requests) {
        const request = { ...sent, instructions: sent.instructions ?? sent.system };
        const schema = sent.text?.format?.schema ?? sent.tools?.find((tool) => tool.name === 'structured_answer')?.input_schema;
        if (sent.text?.format) assert.equal(sent.text.format.strict, true);
        else assert.deepEqual([sent.model, sent.tool_choice], ['claude-opus-5-5', { type: 'auto' }]);
        assert.match(request.instructions, /PAYSLIP \/ PAYROLL RECORD/);
        assert.match(request.instructions, /counterparty_name is the EMPLOYEE/);
        assert.match(request.instructions, /NET pay transferred/);
        assert.match(request.instructions, /deduction NEGATIVE/);
        assert.match(request.instructions, /Employer-side contributions.*NOT lines/);
        assert.match(request.instructions, /LOAN \/ FINANCING NOTICE/);
        assert.match(request.instructions, /Never substitute outstanding principal/);
        assert.match(request.instructions, /INSURANCE PREMIUM INVOICE/);
        assert.equal(schema.properties.lines.items.properties.amount.minimum, undefined, 'signed amounts remain representable');
      }
    } finally { await app.stop(); }
  });
