import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { AE_VAT_PERIOD_WORLD_VERSION, evaluateAeVatPeriodWorld } from './aeVatPeriod.js';
import { renderWorldArtifacts } from './worldRenderer.js';
import { validateWorldSpec } from './worldSchema.js';
import { validateCausalWorld } from './worldValidity.js';

const fixtureUrl = new URL('../../../data/worlds/ae/ae-vat-period-mainland.json', import.meta.url);

test('AE-2 world composes through schema, causal validity, entity facts, journal truth, and rendering', async () => {
  const world = await loadWorld();
  assert.deepEqual(validateWorldSpec(world), { ok: true, errors: [] });
  assert.deepEqual(validateCausalWorld(world), { ok: true, version: 'proof0.validity.v1', errors: [] });
  const result = evaluateAeVatPeriodWorld(world);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.version, AE_VAT_PERIOD_WORLD_VERSION);
  assert.equal(result.expectedJournalLines.length, 30);
  const rendered = await renderWorldArtifacts(world);
  assert.equal(rendered.ok, true, JSON.stringify(rendered.errors));
  assert.equal(rendered.artifacts.length, world.artifacts.length);
});

test('VAT201 semantic projection ties sales, imports, recoveries, emirate, and net VAT exactly in AED', async () => {
  const result = evaluateAeVatPeriodWorld(await loadWorld());
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.projection.fields.standard_rated_supplies.total, { amount: '10172.50', vat: '508.63' });
  assert.deepEqual(result.projection.fields.standard_rated_supplies.by_emirate.DXB, { amount: '10172.50', vat: '508.63' });
  assert.deepEqual(result.projection.fields.reverse_charge_supplies, { amount: '3672.50', vat: '183.63' });
  assert.deepEqual(result.projection.fields.goods_imports, { amount: '10000.00', vat: '500.00' });
  assert.deepEqual(result.projection.fields.standard_rated_expenses, { amount: '3000.00', recoverable_vat: '110.00' });
  assert.equal(result.projection.fields.reverse_charge_expenses.amount, '13672.50');
  assert.equal(result.projection.fields.reverse_charge_expenses.recoverable_vat, '683.63');
  assert.deepEqual(result.projection.totals, { output_vat: '1192.26', recoverable_vat: '793.63' });
  assert.equal(result.projection.net_vat, '398.63');
});

test('customs-declared goods and imported services cannot swap VAT201 lanes', async () => {
  const world = await loadWorld();
  world.vatDocuments.find(({ id }) => id === 'document/imported-service').lane = 'customs_declared_goods';
  world.vatDocuments.find(({ id }) => id === 'document/customs-goods').lane = 'imported_service_rcm';
  const found = codes(world);
  assert.ok(found.includes('AE_VAT_IMPORT_LANE_MISMATCH'));
});

test('foreign-currency VAT must use recorded CBUAE date-of-supply rate and remain in AED', async () => {
  const world = await loadWorld();
  const invoice = world.vatDocuments.find(({ id }) => id === 'document/usd-full-sale');
  invoice.exchangeRate.rateDate = '2026-03-31';
  assert.ok(codes(world).includes('AE_VAT_FX_RATE_EVIDENCE_REQUIRED'));

  const wrongAmount = await loadWorld();
  const changed = wrongAmount.vatDocuments.find(({ id }) => id === 'document/usd-full-sale');
  changed.taxableAmountAed = '3670.00';
  changed.vatAmountAed = '183.50';
  changed.grossAmountAed = '3853.50';
  changed.lines[0].unitPriceAed = '3670.00';
  replaceJournalAmounts(wrongAmount, changed.id, [
    ['counterparty', '3853.50', '0.00'],
    ['taxable_base', '0.00', '3670.00'],
    ['vat_output', '0.00', '183.50'],
  ]);
  assert.ok(codes(wrongAmount).includes('AE_VAT_FX_AED_MISMATCH'));
});

test('simplified invoice eligibility is inclusive at AED 10,000 and refuses one fils above', async () => {
  const exact = await loadWorld();
  const invoice = exact.vatDocuments.find(({ id }) => id === 'document/simplified-sale');
  invoice.taxableAmountAed = '9523.81';
  invoice.vatAmountAed = '476.19';
  invoice.grossAmountAed = '10000.00';
  replaceJournalAmounts(exact, invoice.id, [
    ['counterparty', '10000.00', '0.00'],
    ['taxable_base', '0.00', '9523.81'],
    ['vat_output', '0.00', '476.19'],
  ]);
  assert.equal(evaluateAeVatPeriodWorld(exact).ok, true);

  const above = clone(exact);
  above.vatDocuments.find(({ id }) => id === invoice.id).grossAmountAed = '10000.01';
  assert.ok(codes(above).includes('AE_VAT_SIMPLIFIED_INVOICE_NOT_PERMITTED'));
});

test('registered buyer and taxable seller TRNs are conditions, not optional decoration', async () => {
  const world = await loadWorld();
  const invoice = world.vatDocuments.find(({ id }) => id === 'document/simplified-sale');
  invoice.seller.trn = null;
  invoice.buyer.trn = '123';
  assertIncludesAll(codes(world), ['AE_VAT_SELLER_TRN_REQUIRED', 'AE_VAT_REGISTERED_BUYER_DETAILS_REQUIRED']);
});

test('credit notes must cite a prior original and carry negative adjustment economics', async () => {
  const world = await loadWorld();
  const note = world.vatDocuments.find(({ id }) => id === 'document/sale-credit');
  note.originalDocumentId = 'document/missing';
  note.taxableAmountAed = '500.00';
  note.vatAmountAed = '25.00';
  note.grossAmountAed = '525.00';
  assertIncludesAll(codes(world), ['AE_VAT_DOCUMENT_SIGN_INVALID', 'AE_VAT_CREDIT_NOTE_ORIGINAL_REQUIRED']);
});

test('deposit tax point follows the recorded receipt date and cannot drift to final invoicing', async () => {
  const world = await loadWorld();
  world.vatDocuments.find(({ id }) => id === 'document/deposit-sale').dateOfSupply = '2026-08-20';
  assert.ok(codes(world).includes('AE_VAT_DEPOSIT_TAX_POINT_INVALID'));
});

test('blocked VAT remains irrecoverable and residual input recovery is exact', async () => {
  const blocked = await loadWorld();
  const entertainment = blocked.vatDocuments.find(({ id }) => id === 'document/blocked-entertainment');
  entertainment.inputRecovery.recoveryBps = 10000;
  entertainment.inputRecovery.recoverableVatAed = '20.00';
  assert.ok(codes(blocked).includes('AE_VAT_APPORTIONMENT_RATE_MISMATCH'));

  const residual = await loadWorld();
  residual.vatDocuments.find(({ id }) => id === 'document/residual-purchase').inputRecovery.recoveryBps = 5999;
  assert.ok(codes(residual).includes('AE_VAT_APPORTIONMENT_RATE_MISMATCH'));
});

test('VAT return due date is consumed from the exact FTA period rather than recomputed', async () => {
  const world = await loadWorld();
  world.returnDueOn = '2026-07-29';
  assert.ok(codes(world).includes('AE_VAT_DUE_DATE_NOT_RECORDED'));
});

test('missing policy, future observation, and artifact identity fail closed', async () => {
  const world = await loadWorld();
  const invoice = world.vatDocuments.find(({ id }) => id === 'document/usd-full-sale');
  invoice.policySourceId = 'policy/missing';
  world.observations.find(({ artifactId }) => artifactId === invoice.sourceArtifactId).observedAt = '2026-09-01';
  world.artifacts.find(({ id }) => id === invoice.sourceArtifactId).fields.documentId = 'document/sibling';
  assertIncludesAll(codes(world), ['AE_VAT_DOCUMENT_POLICY_REQUIRED', 'AE_VAT_DOCUMENT_NOT_OBSERVED', 'AE_VAT_DOCUMENT_IDENTITY_MISMATCH']);
});

test('a source that is not effective at the document tax point refuses instead of silently applying current policy backwards', async () => {
  const world = await loadWorld();
  world.policySources.find(({ id }) => id === 'policy/ae-vat-invoices').effectiveFrom = '2026-05-01';
  assert.ok(codes(world).includes('AE_VAT_POLICY_NOT_EFFECTIVE'));
});

test('candidate journals must balance and must agree with independent document economics', async () => {
  const world = await loadWorld();
  world.candidateJournalLines.find(({ id }) => id === 'jl-003').creditAed = '183.62';
  assertIncludesAll(codes(world), ['AE_VAT_JOURNAL_MISMATCH', 'AE_VAT_JOURNAL_UNBALANCED']);
});

test('irrelevant artifact layout metadata does not change canonical economics', async () => {
  const original = evaluateAeVatPeriodWorld(await loadWorld());
  const mutated = await loadWorld();
  for (const artifact of mutated.artifacts) {
    artifact.fields.layoutNoise = { page: 99, x: 13, font: 'synthetic' };
  }
  const result = evaluateAeVatPeriodWorld(mutated);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.projection, original.projection);
  assert.deepEqual(result.expectedJournalLines, original.expectedJournalLines);
});

test('period tax outcomes remain forbidden on the entity profile in an AE-2 world', async () => {
  const world = await loadWorld();
  world.entities[0].facts.vatReturnOutcome = 'payable';
  assert.ok(codes(world).includes('AE_PROFILE_PERIOD_OUTCOME_FORBIDDEN'));
});

test('primary source registry pins current FTA return, invoice, FX and apportionment authorities', async () => {
  const world = await loadWorld();
  const ids = new Set(world.policySources.map(({ id }) => id));
  assertIncludesAll([...ids], ['policy/ae-vat-invoices', 'policy/ae-vat-return', 'policy/ae-vat-fx', 'policy/ae-vat-apportionment']);
  assert.ok(world.policySources.every(({ authority, url, effectiveFrom, asOf }) => authority && url.startsWith('https://') && effectiveFrom && asOf));
});

test('malformed document and journal rows return typed errors instead of throwing', async () => {
  const world = await loadWorld();
  world.vatDocuments.push(null);
  world.candidateJournalLines.push(null);
  const result = evaluateAeVatPeriodWorld(world);
  assert.equal(result.ok, false);
  assertIncludesAll(result.errors.map(({ code }) => code), ['AE_VAT_DOCUMENT_INVALID', 'AE_VAT_JOURNAL_LINE_INVALID']);
});

async function loadWorld() { return JSON.parse(await readFile(fixtureUrl, 'utf8')); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function codes(world) { return evaluateAeVatPeriodWorld(world).errors.map(({ code }) => code); }
function assertIncludesAll(actual, expected) { for (const value of expected) assert.ok(actual.includes(value), `${value}: ${actual}`); }
function replaceJournalAmounts(world, documentId, replacements) {
  for (const [kind, debitAed, creditAed] of replacements) {
    const line = world.candidateJournalLines.find((candidate) => candidate.documentId === documentId && candidate.lineKind === kind);
    line.debitAed = debitAed;
    line.creditAed = creditAed;
  }
}
