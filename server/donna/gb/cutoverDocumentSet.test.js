import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GB_CUTOVER_BLOCKER_REASON_CODE,
  GB_CUTOVER_BLOCKER_SURFACE,
  GB_CUTOVER_DOCUMENT_SET_FLAG_KEY,
  GB_CUTOVER_DOCUMENT_SET_PROVENANCE,
  GB_CUTOVER_DOCUMENTS,
  GB_CUTOVER_PHASES,
  evaluateGbCutoverIntake,
  gbCutoverDocumentSetEnabled,
  labelForGbCutoverDocument
} from './cutoverDocumentSet.js';

const allKeys = GB_CUTOVER_DOCUMENTS.map(({ key }) => key);
const materialKeys = GB_CUTOVER_DOCUMENTS.filter(({ materiality }) => materiality === 'material').map(({ key }) => key);
const alwaysKeys = GB_CUTOVER_DOCUMENTS.filter(({ applicability }) => applicability === 'always').map(({ key }) => key);
const conditionalMaterialKeys = GB_CUTOVER_DOCUMENTS
  .filter(({ materiality, applicability }) => materiality === 'material' && applicability === 'conditional')
  .map(({ key }) => key);

test('catalog has 17 unique, well-formed entries', () => {
  assert.equal(GB_CUTOVER_DOCUMENTS.length, 17);
  assert.equal(new Set(allKeys).size, 17);
  for (const document of GB_CUTOVER_DOCUMENTS) {
    assert.ok(document.key);
    assert.ok(GB_CUTOVER_PHASES.includes(document.phase));
    assert.ok(['material', 'recommended'].includes(document.materiality));
    assert.ok(['always', 'conditional'].includes(document.applicability));
    assert.ok(document.name_en);
  }
});

test('empty intake reports every material document missing', () => {
  const verdict = evaluateGbCutoverIntake({});
  assert.equal(verdict.opening_balance_ready, false);
  assert.deepEqual(verdict.missing_material, materialKeys);
  assert.equal(verdict.blocker.assigned_to, 'owner');
  assert.equal(verdict.blocker.surface, GB_CUTOVER_BLOCKER_SURFACE);
  assert.equal(verdict.blocker.reason_code, GB_CUTOVER_BLOCKER_REASON_CODE);
});

test('blocker rests on the owner, never an accountant', () => {
  assert.equal(evaluateGbCutoverIntake({}).blocker.assigned_to, 'owner');
  assert.notEqual(evaluateGbCutoverIntake({}).blocker.assigned_to, 'accountant');
});

test('fully provided catalog is ready with every phase complete', () => {
  const verdict = evaluateGbCutoverIntake({ provided: allKeys });
  assert.equal(verdict.opening_balance_ready, true);
  assert.equal(verdict.blocker, null);
  assert.deepEqual(verdict.missing_material, []);
  assert.ok(verdict.phases.every(({ complete }) => complete));
});

test('one missing material tax document blocks only its phase', () => {
  const verdict = evaluateGbCutoverIntake({ provided: allKeys.filter((key) => key !== 'latest_ct600_and_computation') });
  assert.equal(verdict.opening_balance_ready, false);
  assert.deepEqual(verdict.missing_material, ['latest_ct600_and_computation']);
  assert.equal(verdict.phases.find(({ phase }) => phase === 'tax_foundation').complete, false);
  assert.equal(verdict.phases.find(({ phase }) => phase === 'essential').complete, true);
});

test('explicit not-applicable marks satisfy conditional material documents', () => {
  const verdict = evaluateGbCutoverIntake({ provided: alwaysKeys, notApplicable: conditionalMaterialKeys });
  assert.equal(verdict.opening_balance_ready, true);
  assert.deepEqual(verdict.not_applicable, conditionalMaterialKeys);
  assert.deepEqual(verdict.missing_material, []);
});

test('not-applicable is ignored for an always document', () => {
  const verdict = evaluateGbCutoverIntake({ notApplicable: ['prior_filed_accounts'] });
  assert.ok(verdict.missing_material.includes('prior_filed_accounts'));
  const document = verdict.phases.flatMap(({ documents }) => documents).find(({ key }) => key === 'prior_filed_accounts');
  assert.equal(document.status, 'missing');
});

test('a missing recommended document does not block', () => {
  const verdict = evaluateGbCutoverIntake({ provided: materialKeys });
  assert.equal(verdict.opening_balance_ready, true);
  assert.equal(verdict.blocker, null);
  assert.ok(verdict.missing_recommended.includes('prepayments_accruals'));
});

test('provided evidence accepts a truthy-key object', () => {
  const verdict = evaluateGbCutoverIntake({ provided: { prior_filed_accounts: true } });
  const document = verdict.phases.flatMap(({ documents }) => documents).find(({ key }) => key === 'prior_filed_accounts');
  assert.equal(document.status, 'provided');
});

test('essential phase exposes its documents and material total', () => {
  const essential = evaluateGbCutoverIntake({}).phases.find(({ phase }) => phase === 'essential');
  assert.equal(essential.material_total, 4);
  assert.deepEqual(essential.documents.map(({ key }) => key), allKeys.slice(0, 4));
  assert.ok(essential.documents.every(({ status }) => status));
});

test('evaluation renders provided, not-applicable, and missing statuses', () => {
  const verdict = evaluateGbCutoverIntake({
    provided: ['prior_filed_accounts'],
    notApplicable: ['fixed_asset_register']
  });
  const statuses = Object.fromEntries(verdict.phases.flatMap(({ documents }) => documents).map(({ key, status }) => [key, status]));
  assert.equal(statuses.prior_filed_accounts, 'provided');
  assert.equal(statuses.fixed_asset_register, 'not_applicable');
  assert.equal(statuses.latest_ct600_and_computation, 'missing');
});

test('label helper returns English copy for known keys and null otherwise', () => {
  assert.deepEqual(labelForGbCutoverDocument('prior_filed_accounts'), { name_en: 'Prior filed statutory accounts' });
  assert.equal(labelForGbCutoverDocument('unknown'), null);
});

test("director's loan and CS01 documents occupy their expected phases", () => {
  assert.equal(GB_CUTOVER_DOCUMENTS.find(({ key }) => key === 'directors_loan_account_balance').phase, 'reconciliation');
  assert.equal(GB_CUTOVER_DOCUMENTS.find(({ key }) => key === 'confirmation_statement_status').phase, 'governance');
});

test('config-plane flag is born off and acts only at auto stage', () => {
  assert.equal(GB_CUTOVER_DOCUMENT_SET_FLAG_KEY, 'GB_CUTOVER_DOCUMENT_SET');
  assert.equal(gbCutoverDocumentSetEnabled({}), false);
  assert.equal(gbCutoverDocumentSetEnabled({ snapshot: { GB_CUTOVER_DOCUMENT_SET: { stage: 'auto' } } }), true);
});

test('provenance is explicitly unverified and carries curation notes', () => {
  assert.equal(GB_CUTOVER_DOCUMENT_SET_PROVENANCE.confirmedAgainstPrimary, false);
  assert.ok(GB_CUTOVER_DOCUMENT_SET_PROVENANCE.note);
  assert.ok(GB_CUTOVER_DOCUMENT_SET_PROVENANCE.verificationNote);
});

test('junk evidence inputs normalize to empty and never throw', () => {
  assert.doesNotThrow(() => evaluateGbCutoverIntake({ provided: 'nope', notApplicable: 42 }));
  const verdict = evaluateGbCutoverIntake({ provided: 'nope', notApplicable: 42 });
  assert.deepEqual(verdict.missing_material, materialKeys);
});
