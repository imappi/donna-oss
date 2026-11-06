import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  compareAeArabicWithEnglish,
  evaluateAeEvidenceCase,
  evaluateAeOwnerChatCase,
  validateAeArabicEvidenceWorld
} from './aeArabicEvidenceEvaluation.js';

const world = JSON.parse(readFileSync(new URL('../../../data/worlds/ae/ae-arabic-evidence-evals.json', import.meta.url), 'utf8'));

test('AR-5B corpus is attributable, bounded, and paired to exact English-AE controls', () => {
  assert.deepEqual(validateAeArabicEvidenceWorld(world), { ok: true, errors: [] });
  assert.equal(world.provenance.customer_data, false);
  assert.equal(world.evidence_pairs.length, 5);
  assert.equal(world.owner_chat_pairs.length, 3);
  assert.equal(world.limits.max_provider_calls_per_run, 16);
  for (const pair of [...world.evidence_pairs, ...world.owner_chat_pairs]) {
    assert.equal(pair.cases[0].presentation, 'english');
    assert.ok(['arabic', 'bilingual'].includes(pair.cases[1].presentation));
  }
});

test('the comparator treats material and correction deltas as exact failures', () => {
  const evidenceResults = world.evidence_pairs.flatMap((pair) => pair.cases.map((item) =>
    evaluateAeEvidenceCase({ pair, item, actual: structuredClone(pair.expected) })
  ));
  const ownerChatResults = world.owner_chat_pairs.flatMap((pair) => pair.cases.map((item) => {
    const actionTypes = pair.expected.action_types;
    return evaluateAeOwnerChatCase({
      pair,
      item,
      actual: {
        text: item.presentation === 'english'
          ? `${[...(pair.expected.required_text || []), ...(item.required_text || [])].join(' ')} English response`
          : `${[...(pair.expected.required_text || []), ...(item.required_text || [])].join(' ')} إجابة عربية`,
        actions: actionTypes.map((type) => ({
          type,
          evidence_request_id: pair.expected.evidence_request_id || null,
          status: 'proposed'
        }))
      }
    });
  }));
  const pass = compareAeArabicWithEnglish({ world, evidenceResults, ownerChatResults, runMode: 'replay' });
  assert.equal(pass.status, 'PASS');
  assert.equal(pass.promotion_status, 'INCOMPLETE', 'synthetic replay cannot become measured language-quality evidence');
  assert.equal(pass.language_quality_claim_allowed, false);

  const unreceiptedLive = compareAeArabicWithEnglish({ world, evidenceResults, ownerChatResults, runMode: 'live' });
  assert.equal(unreceiptedLive.status, 'PASS');
  assert.equal(unreceiptedLive.promotion_status, 'INCOMPLETE', 'a pure comparison cannot self-authorize a live claim');
  assert.equal(unreceiptedLive.language_quality_claim_allowed, false);

  const corrupted = evidenceResults.map((row) => ({ ...row }));
  const arabic = corrupted.find((row) => row.id === 'receipt-native-ar');
  arabic.material_error = true;
  arabic.correction_required = true;
  const fail = compareAeArabicWithEnglish({ world, evidenceResults: corrupted, ownerChatResults, runMode: 'live' });
  assert.equal(fail.status, 'FAIL');
  assert.ok(fail.deltas.material_error_rate > 0);
  assert.ok(fail.deltas.correction_required_rate > 0);
  assert.equal(fail.language_quality_claim_allowed, false);
});

test('document and owner scorers reject arithmetic drift, opaque ask drift, and false side-effect claims', () => {
  const receipt = world.evidence_pairs.find((pair) => pair.id === 'receipt-native');
  const badReceipt = structuredClone(receipt.expected);
  badReceipt.header.total_amount = 316;
  const evidence = evaluateAeEvidenceCase({ pair: receipt, item: receipt.cases[1], actual: badReceipt });
  assert.equal(evidence.arithmetic_valid, false);
  assert.equal(evidence.material_error, true);

  const ask = world.owner_chat_pairs.find((pair) => pair.id === 'open-ask-answer');
  const chat = evaluateAeOwnerChatCase({
    pair: ask,
    item: ask.cases[1],
    actual: {
      text: 'لقد حدّثت السجلات، أكد أدناه.',
      actions: [{ type: 'answer_evidence_request', evidence_request_id: 'ask-from-another-client', status: 'applied' }]
    }
  });
  assert.equal(chat.material_error, true);
  assert.ok(chat.errors.some((error) => error.includes('scoped evidence request id')));
  assert.ok(chat.errors.some((error) => error.includes('confirmation-gated')));
});
