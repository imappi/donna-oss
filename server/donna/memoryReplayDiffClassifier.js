// Donna — BizOS 2c-iii producer: the strong-model diff CLASSIFIER adapter
// (design-donna-bizos-slice-2c-iii-replay-producer.md §7).
//
// The model returns BOUNDED semantic judgments ONLY (equivalence, purpose-fit,
// whether a fact is materially reflected in the recorded answer, evidence spans) —
// never authorization, governance eligibility, or a gate category. This module:
//   - builds a TURN-LEVEL prompt (the model sees the full legacy + v2 sets +
//     question + answer + candidate pairs, §6 — never isolated per-item calls);
//   - strictly validates the structured output (bad → fail closed);
//   - runs N INDEPENDENT passes and treats disagreement as unclassified (§7: a second
//     independent verifier; disagreement blocks; never retry for a friendlier verdict);
//   - hands validated judgments + SYSTEM receipts to the deterministic policy, which
//     owns the category. Missing/invalid/low-confidence/disagreement → unclassified.
//
// The model call is INJECTED (`callModel`) so this unit-tests with a mock and the
// live CLI wires the real strong-model call. The model id used is recorded on every
// classified item (the model-id-is-the-receipt rail).

import { createHash } from 'node:crypto';
import { deriveDiffCategory, judgmentAssertable, UNCLASSIFIED } from './memoryReplayPolicy.js';

export const DIFF_JUDGMENT_SCHEMA = 'memret.diff.judgment.v1';
export const DEFAULT_VERIFY_PASSES = 2;

const sha = (v) => `sha256:${createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v ?? null)).digest('hex')}`;

// Give every diff item a stable id the model echoes back.
export const diffItemId = (item, index) =>
  item?.item_id || `di-${createHash('sha256').update(JSON.stringify([item?.kind ?? null, item?.subject_key ?? null, item?.v2?.memory_id ?? null, item?.legacy?.id ?? null, index])).digest('hex').slice(0, 16)}`;

// Turn-level prompt: the model sees EVERYTHING so it can spot compensating facts and
// equivalent replacements. Kept compact; the CLI passes the real answer text.
export const buildClassifierPrompt = ({ question = '', answer = '', legacy = [], v2 = [], items = [] } = {}) => ({
  schema: DIFF_JUDGMENT_SCHEMA,
  instruction:
    'For each diff item return ONLY a bounded judgment: semantic_relation '
    + '(equivalent|changed|distinct|uncertain), answer_material_use '
    + '(materially_reflected|not_materially_reflected|uncertain), purpose_fit '
    + '(in_scope|out_of_scope|uncertain), evidence spans into the ANSWER, and a '
    + 'confidence. Do NOT decide authorization, eligibility, or any gate category. '
    + 'Preserve negation / uncertainty / temporal qualification when judging equivalence '
    + '("may be" != "is"). If unsure, say uncertain.',
  owner_question: question,
  recorded_answer: answer,
  legacy_facts: legacy,
  v2_facts: v2,
  items: items.map((it, i) => ({ item_id: diffItemId(it, i), kind: it.kind, subject_key: it.subject_key, legacy: it.legacy ?? null, v2: it.v2 ?? null }))
});

// Strict validation: returns a Map<item_id, judgment> of ONLY structurally-valid,
// assertable judgments, or null if the whole response is malformed.
export const parseAndValidateJudgments = (raw, expectedIds = []) => {
  let parsed = raw;
  if (typeof raw === 'string') { try { parsed = JSON.parse(raw); } catch { return null; } }
  const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.judgments) ? parsed.judgments : null);
  if (!arr) return null;
  const idSet = new Set(expectedIds);
  const map = new Map();
  for (const j of arr) {
    if (!j || typeof j !== 'object' || !idSet.has(j.item_id)) continue;
    // judgmentAssertable enforces the enums + confidence floor + evidence spans.
    if (!judgmentAssertable(j)) continue;
    map.set(j.item_id, j);
  }
  return map;
};

// One classifier judgment per item = the MAJORITY-AGREED bounded judgment across
// independent passes, or none if they disagree / are unassertable.
const agreeJudgment = (perPass, itemId) => {
  const js = perPass.map((m) => m?.get(itemId)).filter(Boolean);
  if (js.length !== perPass.length) return null; // some pass failed to assert → block
  // Agreement key: the three bounded dimensions (evidence/confidence may vary).
  const key = (j) => `${j.semantic_relation}|${j.answer_material_use}|${j.purpose_fit}`;
  const first = key(js[0]);
  if (!js.every((j) => key(j) === first)) return null; // disagreement → block
  return js[0];
};

// Classify one turn's diff. receiptsByItemId: { [itemId]: { authorization, governedReason } }.
export const classifyDiffTurn = async ({
  turnContext = {}, diff = { items: [] }, receiptsByItemId = {},
  callModel, modelId = null, verifyPasses = DEFAULT_VERIFY_PASSES
} = {}) => {
  const items = Array.isArray(diff.items) ? diff.items : [];
  const ids = items.map((it, i) => diffItemId(it, i));
  const prompt = buildClassifierPrompt({
    question: turnContext.question, answer: turnContext.answer,
    legacy: turnContext.legacy, v2: turnContext.v2, items
  });

  let perPass = [];
  try {
    for (let pass = 0; pass < Math.max(1, verifyPasses); pass += 1) {
      // eslint-disable-next-line no-await-in-loop
      const raw = await callModel({ prompt, pass });
      perPass.push(parseAndValidateJudgments(raw, ids));
    }
  } catch {
    perPass = [null]; // transport failure → fail closed for the whole turn
  }
  const modelFailed = perPass.some((m) => m == null);

  const classified = items.map((item, i) => {
    const itemId = ids[i];
    const judgment = modelFailed ? null : agreeJudgment(perPass, itemId);
    const receipts = receiptsByItemId[itemId] || {};
    const category = judgment ? deriveDiffCategory({ item, receipts, judgment }) : UNCLASSIFIED;
    return {
      item_id: itemId,
      kind: item.kind,
      category,
      // memory_id / turn linkage for the gate's diff_items + provenance.
      memory_id: item.v2?.memory_id ?? item.legacy?.id ?? null,
      classifier: judgment
        ? { model_id: modelId, confidence: judgment.confidence, semantic_relation: judgment.semantic_relation, answer_material_use: judgment.answer_material_use, purpose_fit: judgment.purpose_fit, evidence_hash: sha(judgment.evidence) }
        : { model_id: modelId, failure: modelFailed ? 'model_unassertable_or_transport' : 'pass_disagreement' }
    };
  });

  // A turn is a classification failure if the model itself failed (transport / all
  // passes unassertable) — distinct from individual items landing `unclassified`.
  return { classified, classificationFailure: modelFailed };
};
