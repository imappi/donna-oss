import assert from 'node:assert/strict';
import test from 'node:test';
import { bootApplianceForTest } from './testSupport/applianceHarness.js';
import { loadRecording } from './testSupport/recordedProviders.js';
import { withFirmDbClient, postLedgerTransactionInDb } from './firmDb.js';
import { __createClientEvidenceRequestWithClient } from './db/asks.js';
import { setClientFlagStage } from './clientConfig.js';
import { ensureAeVatPostingFactsInDb, recoverAeVatLegacyCodingInDb } from './db/coding.js';
import { aeVatDecisionSchemaValid, aeVatLegacyCodingNeedsRecovery, readAeVatReasoningContext, aeVatReasoningInput, reasonAeVatFacts } from './ae/vatPostingAutomation.js';
import { processOwnerReplyWithClient } from './ownerReplyRecovery.js';
import { recordAeVatPeriod } from './ae/vatPeriods.js';
import { prepareAeVatReturnFromDb } from './ae/vatReturnRoute.js';
import { MONTH_PROFILE, MONTH_SOURCES, monthInvoiceBytes, monthBankBytes, monthRoutingFixture, monthExtractionFixture,
  monthCodingFixture, monthMatchingFixture, monthDocumentDispositionFixture, monthBankDispositionFixture } from '../../scripts/eval_world_ae_month_sources.js';

const toolFixture = (name, input) => {
  const body = structuredClone(loadRecording('unified_extraction/ochre-discount-line').body);
  body.content = [{ type: 'tool_use', id: 'synthetic-tool', name, input }]; body.stop_reason = 'tool_use';
  return { status: 200, body };
};
const decision = (source, ref, ask = false) => ({ outcome: ask ? 'owner_business_use' : 'supported', document_ref: ref,
  explanation: 'Synthetic provider interpretation of the exact retained invoice, bank settlement and purchaser receiving record.',
  question: ask ? `What were the consumables on invoice ${source.reference} used for, and was any part for personal use?` : null,
  facts: ask ? null : { date_of_supply: source.date, reporting_date: source.date, taxable_amount: String(source.net), vat_amount: String(source.vat),
    supply_class: 'ordinary_domestic', payment_method: 'bank_transfer', fully_paid: true, invoice_validity: 'confirmed',
    direction: source.type === 'sales_invoice' ? 'out' : 'in', input_recovery: source.type === 'sales_invoice' ? null : {
      basis: 'direct_taxable', recovery_bps: 10000, blocked: false, personal_use: false, supply_integrity: 'verified', verification_evidence: source.verificationEvidence
    } } });

test('U08-S3 raw provider-fixture VAT facts, exact journals, source races and ordinary owner-answer continuation', async t => {
  assert.ok(process.env.DONNA_PG_TEST_URL, 'INCOMPLETE: isolated full-schema PostgreSQL is required');
  for (const order of ['document_first','bank_first','later_evidence','owner_source_changed']) await t.test(order, async () => {
    const app = await bootApplianceForTest({ runToken: `vat-auto-${order.replaceAll('_','-')}-${process.pid}`, firm: { jurisdiction: 'AE', currency: 'AED' }, env: { DATABASE_POOL_MAX: '2' } });
    try {
      const { clientId } = await app.createClient({ profile: MONTH_PROFILE });
      const firmId = app.firmId, actorId = app.memberId, q = app.query, common = { firmId, clientId };
      const api = async (path, body) => {
        const response = await app.api.request({ method: 'POST', path, auth: true, body: { firm_id: firmId, ...body } });
        assert.ok(response.status >= 200 && response.status < 300, response.text); return response.json;
      };
      const stage = flagKey => withFirmDbClient(client => setClientFlagStage(client, { ...common, flagKey, stage: 'auto', source: 'manual', reason: 'Synthetic U08-S3 provider fixture proof', actorType: 'firm_member', actorId }));
      for (const key of ['AE_OPENING_BALANCES','FISCAL_PERIOD_INTAKE']) await stage(key);
      await api(`/api/donna/firms/clients/${clientId}/fiscal-periods`, { starts_on: '2026-01-01', ends_on: '2026-12-31' });
      const accounts = {};
      for (const [key, role, code, name] of [['bank','asset.cash','BANK','Business Checking'],['sales','revenue.operating','SALES','Operating revenue'],['cost','expense.operating_supplies','COST','Operating supplies'],['vat','liability.sales_tax_payable','VAT','VAT control']]) {
        const existing = (await q('select * from ledger_accounts where firm_id=$1 and client_id=$2 order by id', [firmId, clientId])).rows.find(row => row.canonical_role === role && row.status === 'active');
        const result = await api(`/api/donna/firms/clients/${clientId}/ae-opening-balances`, { action: 'setup_account', intake: { as_of: '2026-01-01', account: existing ? { account_id: existing.id, currency: 'AED' } : { code, name, canonical_role: role, currency: 'AED' } } });
        accounts[key] = (await q('select * from ledger_accounts where id=$1', [result.account_id])).rows[0];
      }
      app.providers.script('document_disposition', [{ ...monthDocumentDispositionFixture(), times: Infinity }]);
      app.providers.script('bank_line_disposition', [{ respond: monthBankDispositionFixture, times: Infinity }]);
      const uploads = {};
      const documents = async () => {
        for (const source of MONTH_SOURCES) {
          app.providers.script('document_routing', [monthRoutingFixture(source)]);
          app.providers.script('unified_extraction', [monthExtractionFixture(source)]);
          app.providers.script('reconciliation_reasoning', [monthMatchingFixture(source)]);
          uploads[source.key] = (await app.uploadDocument({ clientId, bytes: await monthInvoiceBytes(source), filename: `${source.reference}.pdf`, mimeType: 'application/pdf', documentType: source.type })).documentId;
          await app.tick({ functions: ['parse-document'] });
        }
      };
      let bank;
      const banking = async () => {
        app.providers.script('document_routing', [monthRoutingFixture('bank')]);
        bank = (await app.uploadDocument({ clientId, bytes: monthBankBytes(), filename: 'September-bank.csv', mimeType: 'text/csv', documentType: 'bank_statement' })).documentId;
        app.providers.script('transaction_coding', [monthCodingFixture(bank, accounts)]);
        await app.tick({ functions: ['parse-document'] });
      };
      if (order !== 'bank_first') { await documents(); await banking(); } else { await banking(); await documents(); }
      app.providers.script('transaction_coding', [{ ...monthCodingFixture(bank, accounts), times: Infinity }]);
      await app.tick({ functions: ['parse-cron:coding_convergence'] });
      await app.tick({ functions: ['parse-cron:coding_convergence'] });
      assert.equal((await q('select count(*)::int n from ledger_journals where client_id=$1', [clientId])).rows[0].n, 0);
      await stage('AE_VAT_FACT_AUTOMATION');
      await q("update entity_readiness_sagas set next_retry_at=now()-interval '1 second' where firm_id=$1 and client_id=$2 and state='failed'", [firmId, clientId]);
      const ready = await api(`/api/donna/firms/clients/${clientId}/readiness/retry`, { reopen_exhausted: true });
      assert.equal((await app.read.readiness(clientId)).state, 'ready', JSON.stringify(ready));
      // The existing clock heals the already-applied bank-first source, using
      // the real coder. This initial provider refusal keeps the later write-race
      // probe unposted without manufacturing an accepted tax fact.
      if (order === 'bank_first') {
        // Current evidence recovery already refreshes these bank-first labels.
        // Reconstruct the pre-U08 no-tax-label state only for the separate
        // legacy migration/starvation proof below; no accepted fact or journal
        // is manufactured, and the ordinary coder must rebuild the tax label.
        const refreshed = (await q('select * from transactions where client_id=$1 order by id', [clientId])).rows;
        assert.equal(refreshed.length, 3);
        assert.ok(refreshed.every(row => row.payload.tax_treatment === 'VAT 5% (standard rated)'),
          'late-source recovery has already supplied the current recorded VAT labels');
        await q("update transactions set payload=payload - 'tax_treatment' where client_id=$1", [clientId]);
        assert.ok((await q('select * from transactions where client_id=$1', [clientId])).rows.every(aeVatLegacyCodingNeedsRecovery),
          'the migration probe begins with exactly the named unprotected legacy shape');
        const protectedRow = (await q('select * from transactions where id=$1', [`${bank}-tx-0`])).rows[0];
        await q("update transactions set payload=payload || '{\"accepted_coding_policy\":{\"test_guard\":true}}'::jsonb where id=$1", [protectedRow.id]);
        const healed = await recoverAeVatLegacyCodingInDb({ firmId, limit: 1 });
        assert.equal(healed.length, 2, 'protected earlier row must not starve later eligible rows');
        assert.equal((await q('select coding_state from transactions where id=$1', [protectedRow.id])).rows[0].coding_state, 'applied');
        await q('update transactions set payload=$2::jsonb where id=$1', [protectedRow.id, JSON.stringify({ ...protectedRow.payload, tax_type: null, accepted_coding_policy: null })]);
        app.providers.script('ae_vat_facts', [{ times: 3, respond: request => {
          const input = JSON.parse(request.messages[0].content);
          return toolFixture('assess_ae_vat_facts', { outcome: 'unsupported', document_ref: input.settled_document_ref,
            explanation: 'Synthetic refusal for the source-race preflight.', question: null, facts: null });
        } }]);
        await app.tick({ functions: ['parse-cron:coding_convergence'], advanceMs: 300_000 });
        await app.tick({ functions: ['parse-cron:coding_convergence'], advanceMs: 300_000 });
        assert.equal((await q("select count(*)::int n from audit_events where client_id=$1 and action='transaction.ae_vat_legacy_coding_reopened'", [clientId])).rows[0].n, 3, JSON.stringify(await app.read.jobs()));
        app.providers.script('ae_vat_facts', []);
      }
      const transactionId = i => `${bank}-tx-${i}`;
      const context = id => withFirmDbClient(client => readAeVatReasoningContext({ client, ...common, transactionId: id }));
      const script = async (i, ask = false) => {
        const ctx = await context(transactionId(i)); assert.ok(ctx && !ctx.pendingMatch, JSON.stringify({ ctx,
          transactions: (await q('select id,coding_state,payload from transactions where client_id=$1 order by id', [clientId])).rows,
          calls: app.providers.calls.map(call => call.lane), jobs: await app.read.jobs() }));
        const input = aeVatReasoningInput(ctx);
        assert.ok(!JSON.stringify(input).includes(clientId), 'opaque ids must not reach reasoning');
        app.providers.script('ae_vat_facts', [toolFixture('assess_ae_vat_facts', decision(MONTH_SOURCES[i], input.settled_document_ref, ask))]);
        return ctx;
      };
      await script(0);
      await assert.rejects(ensureAeVatPostingFactsInDb({ ...common, transactionId: transactionId(0), reasonFn: async args => {
        const value = await reasonAeVatFacts(args);
        await q("update documents set payload=payload || '{\"source_revision\":1}'::jsonb where id=$1", [uploads.sale]);
        return value;
      } }), { code: 'AE_VAT_SOURCE_CHANGED' });
      assert.equal((await q('select payload->\'tax_posting_facts\' facts from transactions where id=$1', [transactionId(0)])).rows[0].facts, null);
      await script(0); assert.equal((await ensureAeVatPostingFactsInDb({ ...common, transactionId: transactionId(0) })).generated, true);
      await q("update documents set payload=payload || '{\"source_revision\":2}'::jsonb where id=$1", [uploads.sale]);
      await script(0);
      await postLedgerTransactionInDb({ ...common, transactionId: transactionId(0), dryRun: false, actorId: 'ledger_auto_post', skipSnapshot: true });
      await script(1);
      await postLedgerTransactionInDb({ ...common, transactionId: transactionId(1), dryRun: false, actorId: 'ledger_auto_post', skipSnapshot: true });
      const unrelated = await withFirmDbClient(client => __createClientEvidenceRequestWithClient({ client, ...common,
        documentId: uploads.purpose, evidenceType: 'invoice_discrepancy', question: 'Please explain the separate invoice discrepancy.', actorId, markTransactionNeedsClient: false }));
      const unrelatedBefore = (await q('select * from client_evidence_requests where id=$1', [unrelated.id])).rows[0];
      if (order === 'document_first') {
        await script(2);
        await assert.rejects(ensureAeVatPostingFactsInDb({ ...common, transactionId: transactionId(2), reasonFn: async args => {
          const supported = await reasonAeVatFacts(args);
          await script(2, true);
          await ensureAeVatPostingFactsInDb({ ...common, transactionId: transactionId(2) });
          return supported;
        } }), { code: 'AE_VAT_SOURCE_CHANGED' });
        assert.equal((await q("select payload->'tax_posting_facts' fact from transactions where id=$1", [transactionId(2)])).rows[0].fact, null);
      } else await script(2, true);
      const waiting = await postLedgerTransactionInDb({ ...common, transactionId: transactionId(2), dryRun: false, actorId: 'ledger_auto_post', skipSnapshot: true });
      assert.equal(waiting.ledger_posting.state, 'waiting_on_owner');
      const askId = waiting.ledger_posting.evidence_request_id;
      assert.notEqual(askId, unrelated.id);
      assert.deepEqual((await q('select * from client_evidence_requests where id=$1', [unrelated.id])).rows[0], unrelatedBefore);
      const callsBefore = app.providers.calls.length;
      assert.equal((await postLedgerTransactionInDb({ ...common, transactionId: transactionId(2), dryRun: false, skipSnapshot: true })).ledger_posting.evidence_request_id, askId);
      assert.equal(app.providers.calls.length, callsBefore);
      assert.equal((await q("select count(*)::int n from client_evidence_requests where client_id=$1 and evidence_type='ae_vat_business_use' and status in ('draft','open')", [clientId])).rows[0].n, 1);
      if (order === 'later_evidence') {
        await q("update documents set payload=payload || $2::jsonb where id=$1", [uploads.purpose,
          JSON.stringify({ purchaser_receiving_addendum: 'The consumables were all consumed in taxable design services; no personal or blocked use.' })]);
        await script(2);
        await ensureAeVatPostingFactsInDb({ ...common, transactionId: transactionId(2) });
        assert.equal((await q('select status from client_evidence_requests where id=$1', [askId])).rows[0].status, 'resolved');
        assert.equal((await q("select payload->'ae_vat_business_use' fact from transactions where id=$1", [transactionId(2)])).rows[0].fact, null, 'new document evidence is not a fabricated owner answer');
      } else {
      // Actual ordinary text reply ingress and registered interpreter; no
      // accepted tax fact or final journal is inserted by this fixture.
      const answered = toolFixture('interpret_owner_reply', { answer: { business_purpose: 'Consumables used only for our taxable design work', exclusively_taxable_business_use: true, personal_use: false }, confidence: 0.99, clarification: null });
      app.providers.script('owner_reply', [{ respond: async () => {
        await q("update firm_members set role='viewer' where id=$1", [actorId]);
        return answered;
      } }]);
      await api(`/api/donna/firms/evidence/requests/${askId}/resolve`, { reply: 'All these consumables were used for our taxable design work. None was for personal use.' });
      assert.equal((await q('select status from client_evidence_requests where id=$1', [askId])).rows[0].status, 'replied', 'revoked interpretation must not be resolved by the existing invoice match');
      assert.equal((await q("select payload->'ae_vat_business_use' fact from transactions where id=$1", [transactionId(2)])).rows[0].fact, null);
      await q("update firm_members set role='owner' where id=$1", [actorId]);
      // Unrelated evidence changes cannot erase the meaning of an exact
      // invoice-use answer. The actual selected source is still unchanged.
      await q("update documents set payload=payload || '{\"unrelated_annotation\":true}'::jsonb where id=$1", [uploads.sale]);
      app.providers.script('owner_reply', [answered]);
      const outcome = await withFirmDbClient(client => processOwnerReplyWithClient({ client, ...common, evidenceRequestId: askId }));
      assert.ok(outcome.applied || outcome.skipped === 'no_pending_reply', JSON.stringify(outcome));
      const ask = (await q('select status from client_evidence_requests where id=$1', [askId])).rows[0]; assert.equal(ask.status, 'resolved');
      assert.equal((await q("select count(*)::int n from local_jobs where function_id='parse-cron:coding_convergence' and payload->>'evidence_request_id'=$1", [askId])).rows[0].n, 1);
      }
      if (order === 'owner_source_changed') {
        await q("update documents set payload=payload || '{\"source_revision\":3}'::jsonb where id=$1", [uploads.purpose]);
        const changedContext = await script(2, true);
        assert.equal(changedContext.ownerFact, null, 'the earlier owner fact cannot authorize changed invoice evidence');
        const reasked = await postLedgerTransactionInDb({ ...common, transactionId: transactionId(2), dryRun: false, skipSnapshot: true });
        assert.notEqual(reasked.ledger_posting.evidence_request_id, askId);
        assert.equal((await q('select status from client_evidence_requests where id=$1', [askId])).rows[0].status, 'resolved');
        app.providers.script('owner_reply', [toolFixture('interpret_owner_reply', { answer: { business_purpose: 'These revised invoice consumables were used for taxable design services', exclusively_taxable_business_use: true, personal_use: false }, confidence: 0.99, clarification: null })]);
        await api(`/api/donna/firms/evidence/requests/${reasked.ledger_posting.evidence_request_id}/resolve`, { reply: 'These revised invoice consumables were all for taxable design services, with no personal use.' });
        assert.equal((await q('select status from client_evidence_requests where id=$1', [reasked.ledger_posting.evidence_request_id])).rows[0].status, 'resolved');
      }
      if (order !== 'later_evidence') await script(2);
      await postLedgerTransactionInDb({ ...common, transactionId: transactionId(2), dryRun: false, actorId: 'ledger_auto_post', skipSnapshot: true });
      const journal = (await q('select * from ledger_journals where source_id=$1', [transactionId(2)])).rows[0];
      assert.ok(journal); assert.equal(journal.payload.tax_point.actor_id, 'ae_vat_fact_automation');
      const lines = (await q('select * from ledger_lines where journal_id=$1 order by line_no', [journal.id])).rows;
      assert.equal(lines.length, 3); assert.equal(Number(lines.find(line => line.account_id === accounts.cost.id).debit), 100);
      assert.equal(Number(lines.find(line => line.account_id === accounts.vat.id).debit), 5);
      assert.equal(Number(lines.find(line => line.account_id === accounts.bank.id).credit), 105);
      const before = JSON.stringify(journal);
      assert.equal(await ensureAeVatPostingFactsInDb({ ...common, transactionId: transactionId(2), reasonFn: () => { throw Error('posted rows cannot re-reason'); } }), null);
      assert.equal(JSON.stringify((await q('select * from ledger_journals where id=$1', [journal.id])).rows[0]), before);
      await withFirmDbClient(client => recordAeVatPeriod({ client, ...common, registration: MONTH_PROFILE.vat_registration,
        periodKey: '2026-Q3', startDate: '2026-07-01', endDate: '2026-09-30', dueDate: '2026-10-28', recordedBy: actorId, source: 'Synthetic FTA-assigned period setup' }));
      const returned = await prepareAeVatReturnFromDb({ ...common, periodKey: '2026-Q3' });
      assert.deepEqual(returned.vatReturn.fields.standard_rated_supplies.total, { amount: 1000, vat: 50 });
      assert.deepEqual(returned.vatReturn.fields.standard_rated_expenses, { amount: 300, recoverable_vat: 15 });
      await q("update ledger_journals set payload=jsonb_set(payload,'{tax_point,facts_digest}','\"spoofed\"') where id=$1", [journal.id]);
      await assert.rejects(prepareAeVatReturnFromDb({ ...common, periodKey: '2026-Q3' }), { code: 'AE_VAT_POSTED_TAX_POINT_UNSUPPORTED' });
      await q('update ledger_journals set payload=$2::jsonb where id=$1', [journal.id, JSON.stringify(journal.payload)]);
      assert.equal((await prepareAeVatReturnFromDb({ ...common, periodKey: '2026-Q3' })).vatReturn.netVat, 35);
      assert.deepEqual(app.providers.unscripted, []);
    } finally { await app.stop(); }
  });
});


test('VAT decision schema and legacy recovery preserve authority boundaries', () => {
  const valid = decision(MONTH_SOURCES[1], 'document_1');
  assert.equal(aeVatDecisionSchemaValid(valid), true);
  for (const mutated of [
    { ...valid, extra: true }, { ...valid, facts: { ...valid.facts, invented: true } },
    { ...valid, facts: { ...valid.facts, taxable_amount: 200 } },
    { ...valid, facts: { ...valid.facts, input_recovery: { ...valid.facts.input_recovery, owner_attested: true } } },
    { ...valid, facts: { ...valid.facts, input_recovery: null } }
  ]) assert.equal(aeVatDecisionSchemaValid(mutated), false);
  const row = { coding_state: 'applied', status: 'needs_review', payload: { auto_categorize_source: 'word_overlap' } };
  assert.equal(aeVatLegacyCodingNeedsRecovery(row), true);
  assert.equal(aeVatLegacyCodingNeedsRecovery({ ...row, payload: { ...row.payload, tax_type: null, accepted_coding_policy: null } }), true);
  for (const field of ['ledger_journal_id','tax_posting_facts','accepted_coding_policy','tax_treatment','tax_type','xero_tax_type','tax_code','matched_client_rule_id','reviewed_by','approved_by','ai_suggestion_applied_by','coding_actor_id'])
    assert.equal(aeVatLegacyCodingNeedsRecovery({ ...row, payload: { ...row.payload, [field]: 'protected' } }), false, field);
  for (const state of ['posted','closed','synced','held']) assert.equal(aeVatLegacyCodingNeedsRecovery({ ...row, coding_state: state }), false);
  for (const source of ['client_rule','merchant_lookup','human']) assert.equal(aeVatLegacyCodingNeedsRecovery({ ...row, payload: { auto_categorize_source: source } }), false);
});
