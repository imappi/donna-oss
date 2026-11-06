import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { compareAeVatWorldWithProduction } from './eval_world_ae_vat_period.js';

const fixtureUrl = new URL('../data/worlds/ae/ae-vat-period-mainland.json', import.meta.url);

test('AE-2 runner proves production parity where its posting vocabulary carries the required facts', async () => {
  const comparison = compareAeVatWorldWithProduction(await loadWorld());
  assert.equal(comparison.status, 'pass_with_named_gaps');
  assert.equal(comparison.supportedParity.status, 'pass');
  assert.deepEqual(comparison.supportedParity.observed, comparison.supportedParity.expected);
  assert.equal(comparison.supportedParity.observed.netVat, '458.63');
});

test('AE-2 runner exposes customs Box 6 and residual recovery as named production gaps', async () => {
  const comparison = compareAeVatWorldWithProduction(await loadWorld());
  assert.deepEqual(comparison.gaps.map(({ gapId, status, observedCode }) => ({ gapId, status, observedCode })), [
    { gapId: 'partial_input_recovery_not_representable_by_posting_code', status: 'production_incomplete', observedCode: 'AE_VAT_CONTROL_ACCOUNT_MISMATCH' },
    { gapId: 'customs_goods_box6_not_consumed_by_production_return', status: 'production_incomplete', observedCode: 'AE_VAT_TREATMENT_NOT_ESTABLISHED' },
  ]);
  assert.deepEqual(comparison.gaps[1].expectedProjection.goodsImports, { amount: '10000.00', vat: '500.00' });
  assert.deepEqual(comparison.gaps[1].expectedProjection.reverseChargeSupplies, { amount: '0.00', vat: '0.00' });
});

test('an invalid world never reaches production comparison', async () => {
  const world = await loadWorld();
  world.returnDueOn = '2026-07-29';
  const comparison = compareAeVatWorldWithProduction(world);
  assert.equal(comparison.status, 'invalid_world');
  assert.equal(comparison.supportedParity, null);
  assert.ok(comparison.oracle.errors.some(({ code }) => code === 'AE_VAT_DUE_DATE_NOT_RECORDED'));
});

async function loadWorld() { return JSON.parse(await readFile(fixtureUrl, 'utf8')); }
