// DMEM-R1 W0 — S12, the LR-4 before-state: a consequential decision retained
// without the inputs that would make it replayable
// (docs/audit-2026-09-04-memory-re-baseline.md §1 F-06, §6.3, §7 S12; ACC-F06).
//
// EXPECTED FAILURE + REGISTERED GAP on the current tree (registered in
// scripts/run-tests.mjs). The real desktop path: the statement parses, the bill
// parses and the strong matcher settles it — the matcher records its decision in
// `llm_decisions` (decision_type `match`, the REAL writer `recordLlmDecision`).
// The doctrine (INV-10 / INV-28): a consequential decision references a separate
// immutable pre-action envelope (the canonical outbound payload + its digest,
// build / configuration / scope / as-of metadata) and names the claim, rule and
// source generations it used. The retained row carries a model name, a prompt
// version, telemetry and a raw response — and none of that. Every decision on
// the appliance (the 73) is this row; LR-4 classifies them
// `historical_context_unavailable`, never fabricated (§6.3).

import test from 'node:test';
import assert from 'node:assert/strict';

import { bootApplianceForTest, applianceHarnessSkipReason } from './testSupport/applianceHarness.js';
import { canonicalDigest, expectedFailure, layerMessage, registeredGap } from './testSupport/dmemFixtureSupport.js';

const S = 'S12';
export const S12_FINGERPRINTS = Object.freeze({
  L1: layerMessage(S, 1, 'the retained match decision names the prompt version that produced it (prompt_version is null on every llm_decisions match row)'),
  L3: layerMessage(S, 3, 'the decision receipt references an immutable pre-action envelope (its digest) and the claim, rule and source generations the decision used'),
  GAP: 'no replay entry point exists for an accounting decision on this tree; a decision retained without its pre-action envelope can only be classified historical_context_unavailable (LR-4), never replayed or reconstructed'
});

test(
  'real PG (appliance, DMEM S12): the matcher\'s decision is receipted without a pre-action envelope or the memory inputs it used',
  { skip: applianceHarnessSkipReason() },
  async (t) => {
    const appliance = await bootApplianceForTest({ now: new Date('2026-08-31T09:00:00.000Z') });
    try {
      const { firmId } = appliance;
      const { clientId } = await appliance.createClient();
      appliance.providers.script('document_routing', ['document_routing/kestrel-bank-statement', 'document_routing/ochre-supplier-bill']);
      appliance.providers.script('bank_statement_extraction', ['bank_statement_extraction/kestrel-barclays-two-lines']);
      appliance.providers.script('unified_extraction', ['unified_extraction/ochre-discount-line']);
      appliance.providers.script('reconciliation_reasoning', ['reconciliation_reasoning/ochre-bill-settled-by-candidate-1']);
      appliance.providers.script('transaction_coding', [{ status: 418, body: { error: { type: 'fixture_lane_dark', message: 'coding is not what this fixture proves' } }, times: Infinity }]);
      appliance.providers.script('bank_line_disposition', ['bank_line_disposition/kestrel-ochre-debit-chase-receipt', 'bank_line_disposition/kestrel-paylink-credit-chase-evidence']);
      appliance.providers.script('ask_drafting', [{ status: 503, times: Infinity }]);
      const statement = await appliance.uploadDocument({ clientId, fixture: 'bank_statement_two_lines' });
      await appliance.tick();
      assert.equal((await appliance.read.document(statement.documentId)).parse_status, 'completed');
      const bill = await appliance.uploadDocument({ clientId, fixture: 'supplier_bill_discount' });
      const billTick = await appliance.tick();
      const billDoc = await appliance.read.document(bill.documentId);
      assert.equal(billDoc.parse_status, 'completed', JSON.stringify({ parse: billDoc.parse_error, jobs: billTick.jobs.map((j) => [j.function_id, j.status, j.last_error]) }));
      const decisions = (await appliance.query(
        "select * from llm_decisions where firm_id = $1 and client_id = $2 and decision_type = 'match' order by created_at",
        [firmId, clientId]
      )).rows;
      assert.ok(decisions.length >= 1, `the matcher recorded its decision: ${JSON.stringify((await appliance.query('select decision_type, target_type, target_id from llm_decisions where firm_id = $1', [firmId])).rows)}`);
      const decision = decisions[decisions.length - 1];

      await t.test('L1a database state — the retained receipt names its model and target (the LR-4 census breakdown, §5.4)', async () => {
        assert.ok(decision.model_name, layerMessage(S, 1, 'the receipt names the model'));
        // The matcher receipts against the reconciliation_matches row it minted,
        // not the document: the row must exist and link the bill it settled.
        assert.equal(decision.target_type, 'reconciliation_match', layerMessage(S, 1, 'the receipt targets the match row'));
        const match = (await appliance.query(
          'select id, matched_object_type, matched_object_id, status from reconciliation_matches where firm_id = $1 and client_id = $2 and id = $3',
          [firmId, clientId, decision.target_id]
        )).rows[0];
        assert.ok(match, layerMessage(S, 1, `the receipt's target match row exists (${decision.target_id})`));
        assert.equal(match.matched_object_type, 'supplier_bill', layerMessage(S, 1, 'the match row links a supplier bill'));
        assert.equal(match.matched_object_id, bill.documentId, layerMessage(S, 1, 'the match row links the bill the matcher settled'));
      });

      await t.test('L1 database state — the retained receipt names its prompt version', () => expectedFailure({ id: `${S}/L1`, fingerprint: S12_FINGERPRINTS.L1 }, () => {
        // The matcher's llm_decisions row carries model_name but prompt_version
        // is null on this tree — an LR-4 census fact: the row cannot be tied to
        // the prompt that produced it, so it is not replayable even in principle.
        assert.ok(decision.prompt_version, S12_FINGERPRINTS.L1);
      }));

      // DMEM-R1 W2 (migration 145): the envelope TABLE layer — decision_envelopes /
      // decision_results exist, are immutable in the database, and llm_decisions
      // carries the two reference columns. Plain assertions. The matcher writing an
      // envelope BEFORE its call (and the row referencing it) is W4's — L3 below stays
      // registered until then.
      await t.test('L3 envelope table (W2) — decision_envelopes + decision_results exist, bind, and refuse mutation; llm_decisions carries the reference columns', async () => {
        const columns = Object.keys(decision);
        assert.ok(columns.includes('envelope_id') && columns.includes('pre_action_envelope_digest'), layerMessage(S, 3, 'llm_decisions.envelope_id / pre_action_envelope_digest exist (migration 145)'));
        assert.equal(decision.envelope_id ?? null, null, layerMessage(S, 3, 'W2 backfills nothing and wires no writer: the retained decision carries no envelope reference yet'));
        const inputDigest = canonicalDigest({ prompt: 'match the bill', candidates: [decision.target_id] });
        const envelope = {
          envelope_id: `env-${decision.id}`, firm_id: firmId, client_id: clientId, decision_kind: 'match', target_type: 'reconciliation_match', target_id: decision.target_id,
          purpose: 'reconciliation', principal_type: 'system', principal_id: 'dmem-w2', scope: { jurisdiction: 'GB' }, as_of: '2026-08-31T09:00:00.000Z',
          model_lane: 'reconciliation_reasoning', model_id: decision.model_name, claim_generations: {}, memory_refs: [], input_kind: 'outbound_payload', input_digest: inputDigest
        };
        const envelopeDigest = canonicalDigest(envelope);
        await appliance.query(
          `insert into decision_envelopes (envelope_id, firm_id, client_id, decision_kind, target_type, target_id, purpose, principal_type, principal_id, scope, as_of, model_lane, model_id, claim_generations, memory_refs, input_kind, input_payload, input_digest, envelope_digest)
           values ($1, $2, $3, 'match', $4, $5, 'reconciliation', 'system', 'dmem-w2', $6::jsonb, $7::timestamptz, 'reconciliation_reasoning', $8, '{}'::jsonb, '[]'::jsonb, 'outbound_payload', $9::jsonb, $10, $11)`,
          [envelope.envelope_id, firmId, clientId, envelope.target_type, envelope.target_id, JSON.stringify(envelope.scope), envelope.as_of, decision.model_name, JSON.stringify({ prompt: 'match the bill', candidates: [decision.target_id] }), inputDigest, envelopeDigest]
        );
        await assert.rejects(() => appliance.query('update decision_envelopes set purpose = $2 where envelope_id = $1', [envelope.envelope_id, 'rewritten']), /decision_envelopes_immutable/, layerMessage(S, 3, 'the envelope is immutable'));
        await assert.rejects(() => appliance.query('delete from decision_envelopes where envelope_id = $1', [envelope.envelope_id]), /decision_envelopes_immutable/);
        await assert.rejects(
          () => appliance.query(
            `insert into decision_results (result_id, firm_id, envelope_id, ordinal, result_kind, adapter_input_digest) values ($1, $2, $3, 1, 'attempt', $4)`,
            [`res-${decision.id}-forged`, firmId, envelope.envelope_id, canonicalDigest({ prompt: 'something else' })]
          ),
          /adapter input digest .* does not equal the envelope input digest/,
          layerMessage(S, 3, 'a result whose captured input differs from the envelope is refused (INV-28)')
        );
        await appliance.query(
          `insert into decision_results (result_id, firm_id, envelope_id, ordinal, result_kind, adapter_input_digest, provider, outcome, decision_ref)
           values ($1, $2, $3, 1, 'attempt', $4, 'openai', 'responded', $5::jsonb)`,
          [`res-${decision.id}-1`, firmId, envelope.envelope_id, inputDigest, JSON.stringify({ llm_decision_id: decision.id })]
        );
        await assert.rejects(() => appliance.query('update decision_results set outcome = $2 where result_id = $1', [`res-${decision.id}-1`, 'rewritten']), /decision_results_immutable/);
        // The erasure scrub is the ONE admitted update shape (doctrine §2.7: exact
        // replay then answers historical_input_erased, never a fabrication).
        await appliance.query('update decision_envelopes set input_payload = null, erased_at = now() where envelope_id = $1', [envelope.envelope_id]);
        const scrubbed = (await appliance.query('select input_payload, erased_at, input_digest from decision_envelopes where envelope_id = $1', [envelope.envelope_id])).rows[0];
        assert.equal(scrubbed.input_payload, null);
        assert.ok(scrubbed.erased_at && scrubbed.input_digest === inputDigest, layerMessage(S, 3, 'the digest survives the scrub; the content does not'));
      });

      await t.test('L3 decision receipt — the envelope and the memory inputs are referenced', () => expectedFailure({ id: `${S}/L3`, fingerprint: S12_FINGERPRINTS.L3 }, () => {
        const columns = Object.keys(decision);
        assert.ok(columns.includes('envelope_id') || columns.includes('pre_action_envelope_digest'), S12_FINGERPRINTS.L3);
        assert.ok(decision.envelope_id || decision.pre_action_envelope_digest, S12_FINGERPRINTS.L3);
      }));

      await t.test('L3 replay — the retained decision can be replayed against its recorded inputs', () => registeredGap({ id: `${S}/L3-replay`, reason: S12_FINGERPRINTS.GAP }));

      await t.test('L4 accounting outcome — the decision\'s effect is on the line, read from the persisted column', async () => {
        const line = (await appliance.read.transactions(clientId)).find((tx) => Number(tx.money_out) === 550);
        assert.equal(line.reconciliation_status, 'explained', layerMessage(S, 4, 'the decision settled the line'));
        assert.ok(['auto_reconciled', 'on_owner', 'hanging'].includes(line.convergence_state), layerMessage(S, 4, `the persisted column carries a verdict: ${line.convergence_state} / ${line.convergence_reason}`));
      });
    } finally {
      await appliance.stop();
    }
  }
);
