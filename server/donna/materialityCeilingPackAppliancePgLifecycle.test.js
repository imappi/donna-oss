// The pack materiality ceiling reaches the matchers (RT-11b — the RT-11
// follow-up named in docs/session-handoff-2026-09-02-runtime-refactor-orchestrator-2.md
// §4). RT-11 declared `reconciliation.materiality_ceiling` in every pack and
// taught getAutoMatchPolicy({ jurisdiction }) to read it, but the family
// matchers called authorizeMatch without a policy and the desktop host stamped
// RECONCILIATION_AUTO_MATCH_MATERIALITY_CEILING=500 into env at boot, so on the
// appliance the env value governed every client whatever its pack said. This
// fixture runs the real desktop path on the RT-06 harness for a FRESH AE
// client and pins the three things RT-11b changes:
//
//   - the host no longer supplies either ceiling through env (env stays the
//     operator's kill/override switch, never the appliance's default);
//   - Gate E reads the AE pack's ceiling (500, in AED) and the persisted
//     authorization receipt names WHERE the number came from
//     (`materiality_ceiling_source: 'pack:ae'`, currency AED);
//   - the disposition side reads the same pack section
//     (`reconciliation.disposition_ceiling`) and its receipt names the source.
//
// The documents are the fixture world's GBP set (there is no AE-rendered
// world yet); the ceiling compare is deliberately currency-blind on both
// sides (the bank line's own amount against the pack's home-currency number,
// exactly as Gate E always compared), so 550 against the AED 500 line is the
// over-the-ceiling case and the 42.99 Screwfix receipt the under case.

import test from 'node:test';
import assert from 'node:assert/strict';

import { bootApplianceForTest, applianceHarnessSkipReason } from './testSupport/applianceHarness.js';
import { loadRecording } from './testSupport/recordedProviders.js';

const AE_CLIENT_PROFILE = { companyName: 'Saffron Court Café LLC', entityType: 'ae-llc', jurisdiction: 'AE' };

test(
  'real PG (appliance): a fresh AE client is authorized against the AED pack ceiling — no env ceiling from the host, and both receipts name the pack',
  { skip: applianceHarnessSkipReason() },
  async () => {
    const appliance = await bootApplianceForTest({ now: new Date('2026-08-31T09:00:00.000Z') });
    try {
      // The host boot stamped the desktop runtime defaults into process.env
      // (runtimeServer.js → applyDesktopHostRuntimeDefaults). Neither ceiling
      // may be among them: a value here would override every pack.
      assert.equal(process.env.RECONCILIATION_AUTO_MATCH_MATERIALITY_CEILING, undefined,
        'the desktop host must not stamp the Gate E ceiling into env — env overrides the pack for every client');
      assert.equal(process.env.DISPOSITION_MATERIALITY_CEILING, undefined,
        'the desktop host must not stamp the disposition ceiling into env either');

      const { clientId } = await appliance.createClient({ profile: AE_CLIENT_PROFILE });
      const stored = await appliance.query('select jurisdiction from clients where firm_id = $1 and id = $2', [appliance.firmId, clientId]);
      assert.equal(String(stored.rows[0].jurisdiction).toLowerCase(), 'ae',
        'the client carries the AE jurisdiction the pack resolver normalizes (raw case is the create route\'s, the resolver lowercases)');

      // ── The statement: the 550 payment and the PayLink payout, both disposed
      // as owner-bound gaps on the drain tick (the RT-11 fixture's shape). ──
      appliance.providers.script('document_routing', ['document_routing/kestrel-bank-statement']);
      appliance.providers.script('bank_statement_extraction', ['bank_statement_extraction/kestrel-barclays-two-lines']);
      appliance.providers.script('transaction_coding', [{
        status: 418,
        body: { error: { type: 'fixture_lane_dark', message: 'transaction_coding is scripted dark for this fixture' } }
      }]);
      appliance.providers.script('bank_line_disposition', [
        'bank_line_disposition/kestrel-ochre-debit-chase-receipt',
        'bank_line_disposition/kestrel-paylink-credit-chase-evidence'
      ]);
      const statement = await appliance.uploadDocument({ clientId, fixture: 'bank_statement_two_lines' });
      const statementTick = await appliance.tick();
      const statementDoc = await appliance.read.document(statement.documentId);
      assert.equal(statementDoc.parse_status, 'completed', JSON.stringify({ parse: statementDoc.parse_error, jobs: statementTick.jobs.map((j) => [j.function_id, j.status, j.last_error]), calls: appliance.providers.calls.map((c) => [c.lane, c.status]) }));
      const transactions = await appliance.read.transactions(clientId);
      const ochreLine = transactions.find((tx) => Number(tx.money_out) === 550);
      assert.ok(ochreLine, `the 550 payment is on the feed: ${JSON.stringify(transactions.map((tx) => [tx.description, tx.money_in, tx.money_out]))}`);

      // The two owner asks the RT-11 recordings were drafted against (the
      // drafter's recorded replies fit this ask set; the asks themselves are
      // not what this fixture proves).
      for (const [id, evidenceType, question] of [
        ['ask-purpose', 'business_purpose', 'Was the Ochre Lighting payment wholly for the café rather than personal?'],
        ['ask-doc', 'supporting_document', 'Please send the Ochre Lighting invoice.']
      ]) {
        await appliance.query(
          `insert into client_evidence_requests
             (id, firm_id, client_id, transaction_id, status, evidence_type, question, request_payload, created_by, audience)
           values ($1, $2, $3, $4, 'open', $5, $6, '{}'::jsonb, 'ask_batch', 'client')`,
          [`${clientId}-${id}`, appliance.firmId, clientId, ochreLine.id, evidenceType, question]
        );
      }

      // ── The bill: 550, matched at 0.94 to the 550 line — ABOVE the AE pack's
      // ceiling of 500, so Gate E holds and the seeded material-FYI lever
      // auto-reconciles it. The receipt must say the 500 came from the pack. ──
      appliance.providers.script('ask_drafting', [
        'ask_drafting/kestrel-payout-report-only',
        'ask_drafting/kestrel-material-fyi-and-payout-ask'
      ]);
      appliance.providers.script('document_routing', ['document_routing/ochre-supplier-bill']);
      appliance.providers.script('supplier_bill_extraction', ['supplier_bill_extraction/ochre-discount-line']);
      appliance.providers.script('reconciliation_reasoning', ['reconciliation_reasoning/ochre-bill-settled-by-candidate-1']);
      const bill = await appliance.uploadDocument({ clientId, fixture: 'supplier_bill_discount' });
      const billTick = await appliance.tick();
      const billDoc = await appliance.read.document(bill.documentId);
      assert.equal(billDoc.parse_status, 'completed', JSON.stringify({ parse: billDoc.parse_error, jobs: billTick.jobs.map((j) => [j.function_id, j.status, j.last_error]), calls: appliance.providers.calls.map((c) => [c.lane, c.status]), unscripted: appliance.providers.unscripted }));

      const matches = await appliance.read.matches(clientId);
      const match = matches.find((row) => row.matched_object_id === bill.documentId);
      assert.ok(match, `the bill matcher settled the bill on a bank line: ${JSON.stringify(matches.map((m) => [m.matched_object_type, m.status, m.match_confidence]))}`);
      assert.equal(match.bank_transaction_id, ochreLine.id);
      assert.equal(match.status, 'auto_matched', JSON.stringify(match.payload?.authorization));
      const authorization = match.payload?.authorization || {};
      assert.deepEqual(authorization.reasons, ['material_auto_fyi'], 'held ONLY by the ceiling, then auto-reconciled under the seeded policy');
      assert.equal(authorization.gates?.E, false, '550 is above the AE pack ceiling of 500 — E held');
      assert.equal(authorization.policy?.materiality_ceiling, 500, 'Gate E read the pack value');
      assert.equal(authorization.policy?.materiality_ceiling_unset, false);
      assert.equal(authorization.policy?.materiality_ceiling_source, 'pack:ae',
        'the persisted receipt names WHY 500 was the line: the AE pack, not the host env');
      assert.equal(authorization.policy?.materiality_ceiling_currency, 'AED', 'the pack declares its ceiling in its home currency');
      assert.equal(authorization.material_auto_fyi?.materiality_ceiling, 500);
      assert.equal(authorization.model, loadRecording('reconciliation_reasoning/ochre-bill-settled-by-candidate-1').body.model, 'the model id is part of the receipt');

      // ── The disposition side: the 42.99 Screwfix receipt has no bank line;
      // the doc-first disposition auto-explains it UNDER the same pack's
      // disposition ceiling, and that receipt names the pack too. ──
      appliance.providers.script('document_routing', ['document_routing/screwfix-receipt']);
      appliance.providers.script('receipt_extraction', ['receipt_extraction/screwfix']);
      appliance.providers.script('document_disposition', ['document_disposition/screwfix-receipt-immaterial-auto-explain']);
      const receipt = await appliance.uploadDocument({ clientId, fixture: 'receipt_screwfix' });
      const receiptTick = await appliance.tick();
      const receiptDoc = await appliance.read.document(receipt.documentId);
      assert.equal(receiptDoc.parse_status, 'completed', JSON.stringify({ parse: receiptDoc.parse_error, jobs: receiptTick.jobs.map((j) => [j.function_id, j.status, j.last_error]), unscripted: appliance.providers.unscripted }));
      const disposition = receiptDoc.payload?.no_line_disposition;
      assert.equal(disposition?.disposition, 'auto_explain', JSON.stringify(disposition));
      assert.equal(disposition?.downgraded_from, null, '42.99 is under the ceiling — the model keeps its judgment');
      assert.equal(disposition?.materiality_ceiling, 500, 'the disposition ceiling in force came from the pack');
      assert.equal(disposition?.materiality_ceiling_source, 'pack:ae', 'and the receipt says so');
    } finally {
      await appliance.stop();
    }
  }
);
