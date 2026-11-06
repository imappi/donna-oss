// FIK-2: the reviewed Finnish guidance variant ("v8") is rendered only through
// the existing resolver, replaces the clauses it covers, is byte-identical to
// the authored guidance ("v7") while no entry applies, and never lets a v7
// receipt pass as v8 (or the reverse). Old receipts keep their exact bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolveCodingPolicy, codingPolicyReceipt, assertCodingPolicyReceipt, requireCodingPolicyForClient,
  codingPolicyChatContext, codingPolicyReceiptForChatTransaction, CODING_POLICY_REGISTRY } from './codingPolicy.js';
import { FI_CODING_POLICY, FI_ALV_INSTRUCTIONS_NOTE, FI_DOCUMENT_POSTING_NOTE } from './finland/codingPolicy.js';
import { FI_POLICY_CLAUSES, FI_REVIEWED_GUIDANCE_ENTRIES, renderFiReviewedGuidance } from './finland/decisionGuidance.js';
import { FI_JEV_DECISION_GUIDANCE_FLAG, codingGuidanceVariantForSnapshot } from './codingGuidanceVariant.js';
import { AUTO_FORBIDDEN_FLAGS } from './clientConfig.js';
import { buildSettlementAccountUserPrompt } from './documentSettlementEntry.js';
import { assertRefundGroupPolicyWindow } from './transactionLlm.js';

const wave4 = JSON.parse(readFileSync(new URL('./testSupport/jurisdictionExtension/wave4-policy-receipts.json', import.meta.url)));
const fiCase = wave4.cases.find((row) => row.input.jurisdiction === 'fi');
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const contractSha = (p) => sha({ accountOptions: p.accountOptions, suspenseAccountName: p.suspenseAccountName,
  requiredAccountNames: p.requiredAccountNames, taxTreatmentOptions: p.taxTreatmentOptions,
  uncertainTaxTreatment: p.uncertainTaxTreatment, defaultTaxTreatment: p.defaultTaxTreatment,
  outOfScopeTaxTreatment: p.outOfScopeTaxTreatment, taxInstructions: p.taxInstructions });
// The digest of an empty reviewed selection, computed independently of the renderer.
const EMPTY_V8_DIGEST = sha({ entries: [], variant: 'reviewed' });

const source = { url: 'https://www.vero.fi/example-fixture', captured_on: '2026-09-23', effective_from: null, effective_to: null };
const reviewedEntry = (overrides = {}) => ({ id: 'FIK-TEST-RENT', status: 'reviewed', reviewer: 'Fixture Reviewer',
  reviewed_on: '2026-09-23', claim: 'TEST-ONLY REVIEWED RENT CLAIM.', covers: ['FI-ALV-23'], sources: [source], ...overrides });
const registryWith = (entries) => ({ ...CODING_POLICY_REGISTRY, fi: { ...FI_CODING_POLICY,
  reviewedGuidanceFor: (args) => renderFiReviewedGuidance({ alvNote: FI_ALV_INSTRUCTIONS_NOTE,
    postingNote: FI_DOCUMENT_POSTING_NOTE, ...args, entries }) } });
const v8 = (entries, input = fiCase.input) => resolveCodingPolicy({ ...input, guidanceVariant: 'reviewed' }, { registry: registryWith(entries) });

test('the clause table is the FIK-1 inventory: every id, verbatim in its block, covering both blocks without overlap', () => {
  const inventory = readFileSync(new URL('../../docs/fik-1-fi-policy-clause-inventory.md', import.meta.url), 'utf8');
  const rows = [...inventory.matchAll(/^\| (FI-(?:ALV|POST)-\d\d) \| "(.*?)" \|/gm)];
  assert.deepEqual(Object.keys(FI_POLICY_CLAUSES), rows.map(([, id]) => id), 'same ids, same order as the inventory');
  // The inventory quotes version 8; its §7 names the rows amended in versions 9 and 10.
  const amendedSinceVersion8 = ['FI-ALV-20', 'FI-ALV-28', 'FI-POST-20', 'FI-POST-28', // version 9
    'FI-ALV-25', 'FI-POST-06', 'FI-POST-10']; // version 10
  for (const [, id, quote] of rows) {
    if (!amendedSinceVersion8.includes(id)) assert.equal(FI_POLICY_CLAUSES[id].text, quote, id);
  }
  for (const [block, text] of [['alv', FI_ALV_INSTRUCTIONS_NOTE], ['posting', FI_DOCUMENT_POSTING_NOTE]]) {
    const cuts = Object.values(FI_POLICY_CLAUSES).filter((clause) => clause.block === block)
      .map((clause) => { const start = text.indexOf(clause.text); assert.ok(start >= 0, clause.id); return { start, end: start + clause.text.length, id: clause.id }; })
      .sort((a, b) => a.start - b.start);
    let pos = 0;
    for (const cut of cuts) {
      assert.ok(cut.start >= pos, `${cut.id} overlaps its neighbour`);
      assert.match(text.slice(pos, cut.start), /^[\s.,;:—()]*$/, `uncovered text before ${cut.id}`);
      pos = cut.end;
    }
    assert.match(text.slice(pos), /^[\s.,;:—()]*$/, `uncovered tail of the ${block} block`);
  }
});

test('the shipped reviewed set is empty: v8 renders the exact v7 bytes and only adds the guidance digest to the receipt', () => {
  assert.deepEqual(FI_REVIEWED_GUIDANCE_ENTRIES, []);
  const v7 = resolveCodingPolicy(fiCase.input);
  const reviewed = resolveCodingPolicy({ ...fiCase.input, guidanceVariant: 'reviewed' });
  assert.equal(reviewed.taxInstructions, v7.taxInstructions);
  assert.equal(Buffer.byteLength(reviewed.taxInstructions), Buffer.byteLength(v7.taxInstructions), 'request-size delta is zero');
  assert.equal(contractSha(reviewed), fiCase.contractSha256, 'the pinned version-10 contract, no version bump');
  assert.equal(reviewed.policyVersion, v7.policyVersion);
  assert.deepEqual(codingPolicyReceipt(v7), fiCase.receipt, 'flag off: the stored receipt bytes, no guidance key');
  assert.deepEqual(codingPolicyReceipt(reviewed), { ...fiCase.receipt, guidanceVariant: 'reviewed', guidanceDigest: EMPTY_V8_DIGEST });
  assert.equal(reviewed.guidanceDigest, EMPTY_V8_DIGEST);
});

test('receipt-key compatibility: old receipts replay under v7 in every market; v7 and v8 never pass as each other', () => {
  for (const { input, receipt } of wave4.cases) {
    const off = resolveCodingPolicy(input);
    assert.deepEqual(codingPolicyReceipt(off), receipt, input.jurisdiction);
    assert.equal(assertCodingPolicyReceipt(off, receipt), off);
    // A market without reviewed guidance ignores the variant entirely.
    const asked = resolveCodingPolicy({ ...input, guidanceVariant: 'reviewed' });
    if (input.jurisdiction !== 'fi') {
      assert.equal(asked.guidanceVariant, null);
      assert.deepEqual(codingPolicyReceipt(asked), receipt);
      assert.equal(asked.taxInstructions, off.taxInstructions);
    }
  }
  const v7 = resolveCodingPolicy(fiCase.input);
  const reviewed = resolveCodingPolicy({ ...fiCase.input, guidanceVariant: 'reviewed' });
  assert.throws(() => assertCodingPolicyReceipt(reviewed, fiCase.receipt), { code: 'jurisdiction_context_conflict' });
  assert.throws(() => assertCodingPolicyReceipt(v7, codingPolicyReceipt(reviewed)), { code: 'jurisdiction_context_conflict' });
  assert.equal(assertCodingPolicyReceipt(reviewed, codingPolicyReceipt(reviewed)), reviewed);
  // Different reviewed content is a different decision, even at the same version.
  const withEntry = v8([reviewedEntry()]);
  assert.throws(() => assertCodingPolicyReceipt(withEntry, codingPolicyReceipt(reviewed)), { code: 'jurisdiction_context_conflict' });
  assert.throws(() => resolveCodingPolicy({ ...fiCase.input, guidanceVariant: 'v8' }), { code: 'coding_policy_invalid' });
});

test('a reviewed fixture replaces exactly its covered clause, in place and deterministically', () => {
  const v7 = resolveCodingPolicy(fiCase.input);
  const clause = FI_POLICY_CLAUSES['FI-ALV-23'].text;
  const rendered = v8([reviewedEntry()]);
  assert.equal(rendered.taxInstructions, v7.taxInstructions.replace(clause, 'TEST-ONLY REVIEWED RENT CLAIM.'));
  assert.ok(!rendered.taxInstructions.includes(clause), 'the covered v7 clause is not sent beside it');
  assert.equal(rendered.taxInstructions.split('TEST-ONLY REVIEWED RENT CLAIM.').length, 2, 'the claim appears once');
  assert.notEqual(rendered.guidanceDigest, EMPTY_V8_DIGEST);
  assert.equal(rendered.policyVersion, v7.policyVersion);
  assert.deepEqual(rendered.taxTreatmentOptions, v7.taxTreatmentOptions, 'guidance never changes the menu');
  assert.deepEqual(rendered.accountOptions, v7.accountOptions);

  // One entry covering clauses in both blocks: the claim stands where the first
  // stood; every other covered clause is cut. Input order does not matter.
  const multi = reviewedEntry({ id: 'FIK-TEST-RATE', claim: 'TEST-ONLY RATE CLAIM.', covers: ['FI-POST-16', 'FI-ALV-06'] });
  const both = [reviewedEntry(), multi];
  const a = v8(both);
  const b = v8([...both].reverse());
  assert.equal(a.taxInstructions, b.taxInstructions);
  assert.equal(a.guidanceDigest, b.guidanceDigest);
  const expected = v7.taxInstructions.replace(FI_POLICY_CLAUSES['FI-ALV-06'].text, 'TEST-ONLY RATE CLAIM.')
    .replace(clause, 'TEST-ONLY REVIEWED RENT CLAIM.').replace(FI_POLICY_CLAUSES['FI-POST-16'].text, '');
  assert.equal(a.taxInstructions, expected);
  assert.equal(a.taxInstructions.split('TEST-ONLY RATE CLAIM.').length, 2);
});

test('an unreviewed entry never renders; a malformed or conflicting entry fails loudly', () => {
  const empty = v8([]);
  for (const unreviewed of [
    reviewedEntry({ status: 'unreviewed', reviewer: null, reviewed_on: null }),
    reviewedEntry({ status: 'superseded' })
  ]) {
    const rendered = v8([unreviewed]);
    assert.equal(rendered.taxInstructions, empty.taxInstructions);
    assert.equal(rendered.guidanceDigest, EMPTY_V8_DIGEST, 'an unrendered entry is not part of the selection');
  }
  for (const [entries, reason] of [
    [[reviewedEntry({ reviewer: null })], 'reviewer_missing'],
    [[reviewedEntry({ reviewed_on: null })], 'reviewer_missing'],
    [[reviewedEntry({ covers: ['FI-ALV-99'] })], 'covers_invalid'],
    [[reviewedEntry({ sources: [] })], 'sources_invalid'],
    [[reviewedEntry({ sources: [{ ...source, url: 'http://insecure.example' }] })], 'sources_invalid'],
    [[reviewedEntry({ status: 'active' })], 'status_invalid'],
    [[reviewedEntry(), reviewedEntry({ id: 'FIK-TEST-OTHER' })], 'clause_covered_twice'],
    [[reviewedEntry(), reviewedEntry()], 'entry_id_duplicate']
  ]) {
    assert.throws(() => renderFiReviewedGuidance({ alvNote: FI_ALV_INSTRUCTIONS_NOTE, postingNote: FI_DOCUMENT_POSTING_NOTE, entries }),
      (error) => error.reason === reason, reason);
    // Through the resolver the same failure refuses the policy; it never falls back to v7.
    assert.throws(() => v8(entries), { code: 'coding_policy_unavailable' });
  }
  // A covered clause whose text is no longer in the block cannot silently miss.
  assert.throws(() => renderFiReviewedGuidance({ alvNote: 'edited block', postingNote: FI_DOCUMENT_POSTING_NOTE,
    entries: [reviewedEntry()] }), (error) => error.reason === 'clause_text_absent');
});

test('applicability is deterministic on business date and entity type', () => {
  const dated = reviewedEntry({ sources: [{ ...source, effective_from: '2026-01-01', effective_to: null }] });
  const v7Text = resolveCodingPolicy(fiCase.input).taxInstructions;
  const at = (businessDate, entityType = null) => v8([dated], { jurisdiction: 'fi', businessDate, entityType, accountingSystem: 'none' });
  assert.notEqual(at('2026-01-01').taxInstructions, v7Text);
  assert.equal(at('2025-12-31').taxInstructions, v7Text);
  assert.equal(at(null).taxInstructions, v7Text, 'an interval that cannot be checked is not assumed');
  assert.equal(at('2025-12-31').guidanceDigest, EMPTY_V8_DIGEST);
  // A refund group whose lines select different reviewed content needs a
  // group-level decision, exactly as one spanning policy windows does.
  const group = { transaction_ids: ['a', 'b', 'c'], source_digest: 'fixture' };
  assert.throws(() => assertRefundGroupPolicyWindow(group, [at('2026-01-01'), at('2025-12-31'), at('2026-01-01')]),
    { code: 'REFUND_GROUP_POLICY_WINDOW_UNSUPPORTED' });
  assert.doesNotThrow(() => assertRefundGroupPolicyWindow(group, [at('2026-01-02'), at('2026-01-01'), at('2026-01-03')]));
  const oyOnly = reviewedEntry({ entity_types: ['fi-oy'] });
  const scoped = (entityType) => v8([oyOnly], { ...fiCase.input, entityType });
  assert.notEqual(scoped('fi-oy').taxInstructions, v7Text);
  assert.equal(scoped('fi-toiminimi').taxInstructions, v7Text);
});

test('a stamped policy carries its variant to every downstream re-resolve, and refuses a conflicting one', () => {
  const profile = { jurisdiction: 'fi', accounting_system: 'none' };
  const reviewed = resolveCodingPolicy({ jurisdiction: 'fi', accountingSystem: 'none', guidanceVariant: 'reviewed' });
  const again = requireCodingPolicyForClient({ ...profile, codingPolicy: reviewed }, { businessDate: '2026-09-05' });
  assert.equal(again.guidanceVariant, 'reviewed');
  assert.equal(again.guidanceDigest, EMPTY_V8_DIGEST);
  const v7 = requireCodingPolicyForClient({ ...profile, codingPolicy: resolveCodingPolicy({ jurisdiction: 'fi', accountingSystem: 'none' }) }, { businessDate: '2026-09-05' });
  assert.equal(v7.guidanceVariant, null);
  assert.equal(v7.guidanceDigest, null);
  // Chat: the context carries the variant; the action receipt it mints is v8.
  const chat = codingPolicyChatContext({ ...profile, codingPolicy: reviewed });
  assert.equal(chat.guidanceVariant, 'reviewed');
  const receipt = codingPolicyReceiptForChatTransaction({ client: profile, coding_policy: chat }, { date: '2026-09-05' });
  assert.equal(receipt.guidanceDigest, EMPTY_V8_DIGEST);
  assert.equal(chat.tax_instructions, codingPolicyChatContext({ ...profile, codingPolicy: resolveCodingPolicy({ jurisdiction: 'fi', accountingSystem: 'none' }) }).tax_instructions);
  // A stamp whose selected guidance disagrees with the re-resolve on its own
  // business date is a lineage conflict, never a silent re-selection.
  const dated = resolveCodingPolicy({ jurisdiction: 'fi', accountingSystem: 'none', businessDate: '2026-09-05', guidanceVariant: 'reviewed' });
  assert.throws(() => requireCodingPolicyForClient({ ...profile, codingPolicy: { ...dated, guidanceDigest: 'f'.repeat(64) } }),
    { code: 'jurisdiction_context_conflict' });
  assert.throws(() => requireCodingPolicyForClient({ ...profile, codingPolicy: { ...dated, guidanceVariant: null } }),
    { code: 'jurisdiction_context_conflict' });
});

test('the settlement-entry prompt renders the selected variant; with no entries its bytes are unchanged', () => {
  const args = { document: { document_type: 'receipt', total_amount: 10 }, disposition: {}, accountOptions: ['Office expenses'] };
  const off = buildSettlementAccountUserPrompt({ ...args, firmContext: { clientIdentity: { jurisdiction: 'fi' } } });
  const on = buildSettlementAccountUserPrompt({ ...args, firmContext: { clientIdentity: { jurisdiction: 'fi' }, codingGuidanceVariant: 'reviewed' } });
  assert.equal(on, off);
  assert.ok(off.includes(FI_ALV_INSTRUCTIONS_NOTE));
});

test('FI_JEV_DECISION_GUIDANCE lives on the config plane: off without a row, never env-enabled, never firm-auto', () => {
  assert.equal(FI_JEV_DECISION_GUIDANCE_FLAG, 'FI_JEV_DECISION_GUIDANCE');
  assert.equal(codingGuidanceVariantForSnapshot({}), null);
  assert.equal(codingGuidanceVariantForSnapshot(null), null);
  assert.equal(codingGuidanceVariantForSnapshot({ FI_JEV_DECISION_GUIDANCE: { stage: 'off', source: 'client' } }), null);
  assert.equal(codingGuidanceVariantForSnapshot({ FI_JEV_DECISION_GUIDANCE: { stage: 'canary', source: 'client' } }), 'reviewed');
  const killed = { ...process.env, CLIENT_CONFIG_FORCE_DISABLE: 'FI_JEV_DECISION_GUIDANCE' };
  const saved = process.env.CLIENT_CONFIG_FORCE_DISABLE;
  process.env.CLIENT_CONFIG_FORCE_DISABLE = killed.CLIENT_CONFIG_FORCE_DISABLE;
  try { assert.equal(codingGuidanceVariantForSnapshot({ FI_JEV_DECISION_GUIDANCE: { stage: 'canary', source: 'client' } }), null); }
  finally { if (saved === undefined) delete process.env.CLIENT_CONFIG_FORCE_DISABLE; else process.env.CLIENT_CONFIG_FORCE_DISABLE = saved; }
  assert.ok(AUTO_FORBIDDEN_FLAGS.has('FI_JEV_DECISION_GUIDANCE'));
});
