import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolveCodingPolicy, codingPolicyReceipt, assertCodingPolicyReceipt } from './codingPolicy.js';

// Captured by running the merged wave-4 implementation in an isolated checkout,
// before this retirement. Not generated from the implementation under test.
const original = JSON.parse(readFileSync(new URL('./testSupport/jurisdictionExtension/wave4-policy-receipts.json', import.meta.url)));
for (const { input, receipt, contractSha256 } of original.cases) {
  test(`${input.jurisdiction}: wave-4 policy content and historical receipt replay unchanged`, () => {
    const p = resolveCodingPolicy(input);
    assert.deepEqual(codingPolicyReceipt(p), receipt);
    assert.equal(assertCodingPolicyReceipt(p, receipt), p);
    const contract = { accountOptions: p.accountOptions, suspenseAccountName: p.suspenseAccountName,
      requiredAccountNames: p.requiredAccountNames, taxTreatmentOptions: p.taxTreatmentOptions,
      uncertainTaxTreatment: p.uncertainTaxTreatment, defaultTaxTreatment: p.defaultTaxTreatment,
      outOfScopeTaxTreatment: p.outOfScopeTaxTreatment, taxInstructions: p.taxInstructions };
    assert.equal(createHash('sha256').update(JSON.stringify(contract)).digest('hex'), contractSha256,
      'compatibility removal cannot silently change authored accounting policy');
    assert.throws(() => assertCodingPolicyReceipt(resolveCodingPolicy({ ...input, businessDate: '2026-09-06' }), receipt),
      { code: 'jurisdiction_context_conflict' });
    assert.throws(() => assertCodingPolicyReceipt(p, null), { code: 'jurisdiction_context_conflict' });
  });
}
