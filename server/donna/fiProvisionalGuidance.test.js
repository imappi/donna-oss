// FIK-3 provisional arm (plan §8.8): unreviewed draft Finnish guidance renders
// through the FIK-2 renderer ONLY inside the offline harness scope. Outside it
// no call owner, flag or stamp can select it; inside it, its receipt carries its
// own variant and digest, so it never passes as v7 or v8 (nor they as it).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveCodingPolicy, codingPolicyReceipt, assertCodingPolicyReceipt, requireCodingPolicyForClient,
  codingPolicyChatContext, codingPolicyReceiptForChatTransaction } from './codingPolicy.js';
import { FI_POLICY_CLAUSES, FI_PROVISIONAL_GUIDANCE_VARIANT, renderFiProvisionalGuidance, validateFiProvisionalGuidanceEntries,
  __runWithFiProvisionalGuidanceForHarness, __setFiReviewedGuidanceEntriesForTests } from './finland/decisionGuidance.js';
import { FI_ALV_INSTRUCTIONS_NOTE, FI_DOCUMENT_POSTING_NOTE } from './finland/codingPolicy.js';
import { FI_JEV_DECISION_GUIDANCE_FLAG, codingGuidanceVariantForSnapshot } from './codingGuidanceVariant.js';

const wave4 = JSON.parse(readFileSync(new URL('./testSupport/jurisdictionExtension/wave4-policy-receipts.json', import.meta.url)));
const fiCase = wave4.cases.find((row) => row.input.jurisdiction === 'fi');
const input = { ...fiCase.input, businessDate: '2025-06-10' };
const CLAIM = 'TEST-ONLY PROVISIONAL PASSENGER TRANSPORT CLAIM.';
const provisionalEntry = (overrides = {}) => ({ id: 'FIK-P-TEST', status: 'provisional', author: 'Fixture Author', drafted_on: '2026-09-24',
  rationale: 'Fixture rationale.', claim: CLAIM, covers: ['FI-POST-16'],
  sources: [{ url: 'https://www.vero.fi/fik3-provisional-fixture', captured_on: null, snapshot_owed: true, effective_from: null, effective_to: null }], ...overrides });
const inScope = async (entries, fn) => (await __runWithFiProvisionalGuidanceForHarness(entries, fn)).result;
const clause = FI_POLICY_CLAUSES['FI-POST-16'].text;

test('inside the harness scope a provisional entry replaces its clause in place, under its own variant and digest', async () => {
  const v7 = resolveCodingPolicy(input);
  const { result: p, renderedEntryIds } = await __runWithFiProvisionalGuidanceForHarness([provisionalEntry()], async () => resolveCodingPolicy(input));
  assert.deepEqual(renderedEntryIds, ['FIK-P-TEST']);
  assert.equal(p.guidanceVariant, FI_PROVISIONAL_GUIDANCE_VARIANT);
  assert.equal(p.taxInstructions, v7.taxInstructions.replace(clause, CLAIM), 'replaced, never appended');
  assert.ok(!p.taxInstructions.includes(clause));
  assert.equal(p.taxInstructions.split(CLAIM).length, 2);
  assert.deepEqual(p.taxTreatmentOptions, v7.taxTreatmentOptions, 'guidance never changes the menu');
  assert.equal(p.policyVersion, v7.policyVersion);
  const receipt = codingPolicyReceipt(p);
  assert.deepEqual(receipt, { ...codingPolicyReceipt(v7), guidanceVariant: 'provisional', guidanceDigest: p.guidanceDigest });
  // A reviewed copy of the same claim is a different selection: another digest.
  const reviewed = __setFiReviewedGuidanceEntriesForTests([{ ...provisionalEntry({ status: 'reviewed', reviewer: 'Fixture Reviewer', reviewed_on: '2026-09-24' }),
    sources: [{ url: 'https://www.vero.fi/fik3-provisional-fixture', captured_on: '2026-09-24', effective_from: null, effective_to: null }] }]);
  try {
    const v8 = resolveCodingPolicy({ ...input, guidanceVariant: 'reviewed' });
    assert.equal(v8.taxInstructions, p.taxInstructions, 'the same text');
    assert.notEqual(v8.guidanceDigest, p.guidanceDigest, 'never the same receipt');
  } finally { reviewed(); }
  // An entry that does not apply on the date still leaves a provisional (never v7) selection.
  const dated = provisionalEntry({ sources: [{ ...provisionalEntry().sources[0], effective_from: '2026-01-01' }] });
  const { result: none, renderedEntryIds: noIds } = await __runWithFiProvisionalGuidanceForHarness([dated], async () => resolveCodingPolicy(input));
  assert.deepEqual(noIds, []);
  assert.equal(none.taxInstructions, v7.taxInstructions);
  assert.equal(none.guidanceVariant, 'provisional');
  assert.notEqual(none.guidanceDigest, p.guidanceDigest);
});

test('a provisional receipt never passes as v7 or v8, and neither passes as it; old receipts keep their bytes', async () => {
  const v7 = resolveCodingPolicy(input);
  const v8 = resolveCodingPolicy({ ...input, guidanceVariant: 'reviewed' });
  const p = await inScope([provisionalEntry()], async () => resolveCodingPolicy(input));
  const rp = codingPolicyReceipt(p);
  for (const policy of [v7, v8]) assert.throws(() => assertCodingPolicyReceipt(policy, rp), { code: 'jurisdiction_context_conflict' });
  for (const receipt of [codingPolicyReceipt(v7), codingPolicyReceipt(v8)]) assert.throws(() => assertCodingPolicyReceipt(p, receipt), { code: 'jurisdiction_context_conflict' });
  assert.equal(assertCodingPolicyReceipt(p, rp), p);
  // Every market's stored receipt still replays byte-for-byte (FIK-2's pin).
  for (const { input: i, receipt } of wave4.cases) assert.deepEqual(codingPolicyReceipt(resolveCodingPolicy(i)), receipt, i.jurisdiction);
  // A stamp carrying the provisional variant re-resolves only inside the scope:
  // outside it the lineage refuses at every stamp-reading owner.
  const profile = { jurisdiction: 'fi', profileJurisdiction: 'fi', accountingSystem: 'none', codingPolicy: p };
  const chat = { client: { jurisdiction: 'fi', accounting_system: 'none' }, coding_policy: p };
  for (const owner of [() => requireCodingPolicyForClient(profile, { businessDate: input.businessDate }),
    () => codingPolicyChatContext(profile, { businessDate: input.businessDate }),
    () => codingPolicyReceiptForChatTransaction(chat, { date: input.businessDate })]) {
    assert.throws(owner, (error) => error.code === 'coding_policy_invalid' && error.details?.reason === 'provisional_guidance_out_of_scope');
  }
  assert.throws(() => resolveCodingPolicy({ ...input, guidanceVariant: 'provisional' }), (error) => error.details?.reason === 'provisional_guidance_out_of_scope');
  await inScope([provisionalEntry()], async () => {
    assert.equal(requireCodingPolicyForClient(profile, { businessDate: input.businessDate }).guidanceDigest, p.guidanceDigest, 'the harness arm keeps its own lineage');
    assert.deepEqual(codingPolicyReceiptForChatTransaction(chat, { date: input.businessDate }), rp);
  });
});

test('outside the scope nothing selects provisional content: not the flag, not the reviewed set, not a stamp', async () => {
  assert.equal(renderFiProvisionalGuidance({ alvNote: FI_ALV_INSTRUCTIONS_NOTE, postingNote: FI_DOCUMENT_POSTING_NOTE }), null);
  // The flag's only answers are the reviewed variant and none.
  const snapshot = (stage) => ({ [FI_JEV_DECISION_GUIDANCE_FLAG]: { stage } });
  assert.equal(codingGuidanceVariantForSnapshot(snapshot('canary')), 'reviewed');
  for (const stage of ['off', 'shadow', 'canary', 'auto', 'provisional']) assert.ok([null, 'reviewed'].includes(codingGuidanceVariantForSnapshot(snapshot(stage))), stage);
  // A draft entry misplaced in the reviewed set is inert there: v8 renders the v7 bytes.
  const v7 = resolveCodingPolicy(input);
  const restore = __setFiReviewedGuidanceEntriesForTests([provisionalEntry()]);
  try {
    const v8 = resolveCodingPolicy({ ...input, guidanceVariant: 'reviewed' });
    assert.equal(v8.taxInstructions, v7.taxInstructions);
    assert.equal(v8.guidanceVariant, 'reviewed');
    assert.ok(!v8.taxInstructions.includes(CLAIM));
  } finally { restore(); }
  // The scope is an async context, not process state: a resolve in a concurrent
  // flow sees v7 while a harness arm is mid-flight.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const arm = inScope([provisionalEntry()], async () => { await gate; return resolveCodingPolicy(input); });
  const outside = resolveCodingPolicy(input);
  release();
  assert.equal(outside.guidanceVariant, null);
  assert.equal(outside.taxInstructions, v7.taxInstructions);
  assert.equal((await arm).guidanceVariant, 'provisional');
  assert.equal(resolveCodingPolicy(input).guidanceVariant, null, 'nothing lingers after the scope closes');
  // Inside the scope a reviewed selection is a configuration conflict, never a mix.
  await inScope([provisionalEntry()], async () => assert.throws(() => resolveCodingPolicy({ ...input, guidanceVariant: 'reviewed' }),
    (error) => error.details?.reason === 'guidance_variant_conflict'));
  // Other markets have no provisional hook: the scope changes nothing there.
  const gb = wave4.cases.find((row) => row.input.jurisdiction === 'gb');
  await inScope([provisionalEntry()], async () => assert.deepEqual(codingPolicyReceipt(resolveCodingPolicy(gb.input)), gb.receipt));
});

test('a provisional entry carries its draft receipt; a malformed one refuses the scope', async () => {
  for (const [entry, reason] of [
    [provisionalEntry({ status: 'reviewed' }), 'provisional_status_required'],
    [provisionalEntry({ author: '' }), 'author_missing'],
    [provisionalEntry({ drafted_on: '24.9.2026' }), 'drafted_on_invalid'],
    [provisionalEntry({ rationale: undefined }), 'rationale_missing'],
    [provisionalEntry({ reviewer: 'Someone' }), 'provisional_entry_carries_review'],
    [provisionalEntry({ covers: ['FI-POST-99'] }), 'covers_invalid'],
    [provisionalEntry({ sources: [{ url: 'https://www.vero.fi/x', captured_on: null, effective_from: null, effective_to: null }] }), 'sources_invalid']
  ]) {
    assert.throws(() => validateFiProvisionalGuidanceEntries([entry]), (error) => error.reason === reason, reason);
    await assert.rejects(__runWithFiProvisionalGuidanceForHarness([entry], async () => {}), (error) => error.reason === reason);
  }
  assert.throws(() => validateFiProvisionalGuidanceEntries([]), (error) => error.reason === 'provisional_entries_empty');
  // The draft file shipped in the tree: unreviewed entries, every source snapshot owed.
  const file = JSON.parse(readFileSync(new URL('../../data/evals/fik-provisional-guidance/fi.json', import.meta.url)));
  assert.match(file.note, /UNREVIEWED DRAFT GUIDANCE/);
  validateFiProvisionalGuidanceEntries(file.entries);
  assert.deepEqual(file.entries.map((e) => [e.id, e.covers, e.status, e.entity_types ?? null]), [
    ['FIK-P-001-PASSENGER-TRANSPORT-2025', ['FI-POST-16'], 'provisional', null],
    ['FIK-P-002-OY-PRIVATE-EXPENDITURE', ['FI-POST-08', 'FI-POST-09'], 'provisional', ['fi-oy']],
    ['FIK-P-003-REDUCED-RATE-SCOPE-2025', ['FI-ALV-09'], 'provisional', null]
  ]);
  assert.ok(file.entries.every((e) => e.sources.every((s) => s.captured_on === null && s.snapshot_owed === true)));
  // The Kultalanka drafts say their score on that corpus is contaminated evidence.
  for (const e of file.entries.slice(1)) assert.match(e.rationale, /Kultalanka .*contaminated evidence/);
  // Together they render in place on a 2025 Oy line: each covered clause is gone,
  // each claim appears once, and a toiminimi keeps FI-POST-08/09 as written.
  const at = { ...input, businessDate: '2025-02-18' };
  const v7 = resolveCodingPolicy({ ...at, entityType: 'fi-oy' });
  for (const [entityType, expected] of [['fi-oy', file.entries], ['fi-toiminimi', [file.entries[0], file.entries[2]]]]) {
    const { result, renderedEntryIds } = await __runWithFiProvisionalGuidanceForHarness(file.entries, async () => resolveCodingPolicy({ ...at, entityType }));
    assert.deepEqual(renderedEntryIds, expected.map((e) => e.id), entityType);
    for (const e of expected) {
      assert.equal(result.taxInstructions.split(e.claim).length, 2, e.id);
      // A claim may restate a covered guard (FIK-P-002 keeps FI-POST-09's), so look outside the claims.
      const rest = expected.reduce((text, x) => text.split(x.claim).join(''), result.taxInstructions);
      for (const id of e.covers) assert.ok(v7.taxInstructions.includes(FI_POLICY_CLAUSES[id].text) && !rest.includes(FI_POLICY_CLAUSES[id].text), id);
    }
    if (entityType === 'fi-toiminimi') assert.ok(result.taxInstructions.includes(FI_POLICY_CLAUSES['FI-POST-08'].text));
  }
});
