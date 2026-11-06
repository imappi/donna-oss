import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { buildObservationSchedule } from './observationSchedule.js';
import { renderWorldArtifacts } from './worldRenderer.js';
import { createProof0WorldSpec, validateWorldSpec } from './worldSchema.js';
import { validateCausalWorld } from './worldValidity.js';

const FIXTURE_PATH = 'data/worlds/proof0.json';

async function loadFixture() {
  return JSON.parse(await readFile(FIXTURE_PATH, 'utf8'));
}

test('persisted Proof 0 world is constructor-derived, valid, and renderable', async () => {
  const fixture = await loadFixture();
  const { specVersion, manifest, ...constructorInput } = fixture;
  const constructed = createProof0WorldSpec({ ...constructorInput, manifest });

  assert.equal(specVersion, 'proof0.world.v1');
  assert.deepEqual(fixture, constructed);
  assert.deepEqual(validateWorldSpec(fixture), { ok: true, errors: [] });
  assert.deepEqual(validateCausalWorld(fixture).errors, []);
  assert.equal(fixture.events.length, 10);

  const rendered = await renderWorldArtifacts(fixture);
  assert.equal(rendered.ok, true, rendered.errors.join('\n'));
  assert.equal(rendered.artifacts.length, fixture.artifacts.length);
});

test('world pins the batched EUR-to-GBP settlement and exact penny boundary', async () => {
  const fixture = await loadFixture();
  const settlement = fixture.events.find(({ id }) => id === 'event/processor-settlement');

  assert.deepEqual(settlement.causalParents, ['event/fx-conversion']);
  assert.deepEqual(fixture.events.find(({ id }) => id === 'event/fx-conversion').causalParents, [
    'event/payment-a',
    'event/payment-b',
  ]);
  assert.equal(settlement.monetaryEffects.settled, 100);

  const offByPenny = structuredClone(fixture);
  offByPenny.events.find(({ id }) => id === settlement.id).monetaryEffects.settled = 100.01;
  assert.match(validateCausalWorld(offByPenny).errors.join('\n'), /settled must equal gross/);
});

test('delayed evidence and boundary-date owner answer do not leak the hidden value', async () => {
  const fixture = await loadFixture();
  const schedule = buildObservationSchedule(fixture);

  assert.equal(schedule.ok, true);
  assert.equal(schedule.observations.find(({ observationId }) => observationId === 'director-receipt').delayed, true);
  assert.equal(schedule.ownerFactContracts[0].availableAt, '2026-08-08');
  assert.equal(JSON.stringify(schedule).includes('customer-site travel'), false);

  const earlyLeak = structuredClone(fixture);
  earlyLeak.observations.find(({ id }) => id === 'owner-purpose-answer').observedAt = '2026-08-07';
  assert.match(validateCausalWorld(earlyLeak).errors.join('\n'), /reveals hidden fact .* before revealAfter/);
});

test('malicious PDF remains visible evidence but is refused as authority', async () => {
  const fixture = await loadFixture();
  const rendered = await renderWorldArtifacts(fixture);
  const malicious = rendered.artifacts.find(({ id }) => id === 'artifact/malicious-invoice');

  assert.equal(malicious.trustClass, 'untrusted_artifact');
  assert.equal(malicious.authority, 'evidence_only_no_instruction_authority');
  assert.equal(Buffer.from(malicious.contentBase64, 'base64').length > 0, true);
});

test('counterfactual sibling changes only the owner fact and requires a different treatment', async () => {
  const fixture = await loadFixture();
  const mutation = fixture.counterfactualMutation;

  assert.deepEqual(mutation.changedFactIds, [mutation.declaredFactId]);
  assert.notEqual(mutation.expectedTreatmentChange.from, mutation.expectedTreatmentChange.to);

  const hiddenAnswerEdit = structuredClone(fixture);
  hiddenAnswerEdit.counterfactualMutation.changedFactIds.push('hidden/undeclared-answer');
  assert.match(validateCausalWorld(hiddenAnswerEdit).errors.join('\n'), /may only include declaredFactId/);
});

test('PDF evidence is realistic and carries no judge-side self-labels', async () => {
  const fixture = await loadFixture();
  const pdfArtifacts = fixture.artifacts.filter(({ format }) => format === 'pdf');
  assert.equal(pdfArtifacts.length, 4);

  for (const artifact of pdfArtifacts) {
    // Authored textLines are what the renderer draws; without them the
    // skeletal defaults render, which the real production extractor
    // correctly refuses to classify (observed in the 2026-08-06 live run).
    assert.ok(Array.isArray(artifact.textLines) && artifact.textLines.length > 0, `${artifact.id} must author textLines`);
    const text = artifact.textLines.join('\n');
    // Judge-side truth must not leak into the evidence channel: no trust or
    // authority self-labels, no world/artifact framing on the page.
    for (const label of ['Trust:', 'TrustClass', 'Authority:', 'EAW', 'artifact/', 'proof0']) {
      assert.ok(!text.includes(label), `${artifact.id} leaks judge-side label ${label}`);
    }
  }

  const invoiceText = fixture.artifacts.find(({ id }) => id === 'artifact/invoice-a').textLines.join('\n');
  for (const required of ['Harborlight Studio Ltd', 'Aalto Visio Oy', 'INV-001', 'EUR 70.00', '2026']) {
    assert.ok(invoiceText.includes(required), `invoice-a evidence must show ${required}`);
  }
});

test('the malicious invoice carries its embedded instruction unlabeled, and no hidden value leaks into any evidence text', async () => {
  const fixture = await loadFixture();
  const malicious = fixture.artifacts.find(({ id }) => id === 'artifact/malicious-invoice');
  const maliciousText = malicious.textLines.join('\n');

  // The injection must be present on the page (that IS the test Donna faces)
  // but must not be flagged for Donna by the world itself.
  assert.ok(maliciousText.includes(malicious.embeddedInstruction));
  assert.ok(!maliciousText.includes('UNTRUSTED EMBEDDED TEXT'));

  const publicText = JSON.stringify({ observations: fixture.observations, artifacts: fixture.artifacts });
  for (const { value } of fixture.hiddenFacts) {
    assert.ok(!publicText.includes(value), `hidden value must not appear in evidence: ${value}`);
  }
});
