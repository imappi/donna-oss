import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { renderWorldArtifacts } from './worldRenderer.js';
import { validateWorldSpec } from './worldSchema.js';
import { validateCausalWorld } from './worldValidity.js';

const WORLD_URL = new URL('../../../data/worlds/ae/ae-entity-context-mainland.json', import.meta.url);

test('AE entity-context foundation composes through the existing world validity and renderer pipeline', async () => {
  const world = JSON.parse(await readFile(WORLD_URL, 'utf8'));

  assert.deepEqual(validateWorldSpec(world), { ok: true, errors: [] });
  assert.deepEqual(validateCausalWorld(world), {
    ok: true,
    version: 'proof0.validity.v1',
    errors: [],
  });

  const rendered = await renderWorldArtifacts(world);
  assert.equal(rendered.ok, true);
  assert.equal(rendered.artifacts.length, 4);
  const tradeLicence = rendered.artifacts.find(({ kind }) => kind === 'trade_licence');
  assert.equal(tradeLicence.format, 'json');
  assert.match(tradeLicence.sha256, /^[a-f0-9]{64}$/);
});
