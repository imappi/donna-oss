// Synthetic local fixture bytes only; no customer images, consent or labels.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { physicalHash } from '../../server/donna/inventory/physicalReconciliation.js';
import { LOCAL_CORPUS_VERSION, LOCAL_LABELS_VERSION } from '../donna_quantity_corpus.js';
export const makeLocalCorpus = (count = 3) => {
  const root = mkdtempSync(join(tmpdir(), 'donna-corpus-test-'));
  const manifestPath = join(root, 'manifest.json');
  const manifest = { version: LOCAL_CORPUS_VERSION, fixtureBasis: 'real_local_images', imageryStatus: 'supplied_local',
    cases: Array.from({ length: count }, (_, i) => {
      // One-pixel PNG plus a unique synthetic fixture marker. MIME admission is
      // byte sniffing, not a claim that these fixtures depict stock.
      const bytes = Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0l8AAAAASUVORK5CYII=', 'base64'), Buffer.from(`fixture-${i}`)]);
      writeFileSync(join(root, `private-name-${i}.png`), bytes);
      return { id: `case-${String(i + 1).padStart(3, '0')}`, split: i ? 'holdout' : 'development',
        condition: 'clear_count', candidates: [{ itemId: `opaque-item-${i}`, sku: 'FIXTURE-A', baseUom: 'EA' }],
        evidence: [{ id: `opaque-evidence-${i}`, path: `private-name-${i}.png`,
          sha256: createHash('sha256').update(bytes).digest('hex'), mime: 'image/png', size: bytes.length,
          sourceGroupId: `private-group-${i}`, sourceRef: 'PRIVATE_SOURCE_REF', authorizationRef: 'PRIVATE_AUTHORIZATION_REF' }] };
    }) };
  const saveManifest = () => writeFileSync(manifestPath, JSON.stringify(manifest));
  const developmentLabels = join(root, 'development-labels.json'), holdoutLabels = join(root, 'holdout-labels.json');
  const saveLabels = () => {
    for (const [split, file] of [['development', developmentLabels], ['holdout', holdoutLabels]]) {
      writeFileSync(file, JSON.stringify({ version: LOCAL_LABELS_VERSION, manifestDigest: physicalHash(manifest), split,
        labelBasis: 'independent_manual_observation', evaluatorRef: 'SYNTHETIC_LABEL_FIXTURE',
        cases: manifest.cases.filter(c => c.split === split).map(c => ({ id: c.id, candidateItemId: c.candidates[0].itemId,
          baseUom: 'EA', quantity: 3, mustAbstain: false, sourceRef: 'SYNTHETIC_LABEL_BASIS' })) }));
    }
  };
  saveManifest(); saveLabels();
  return { root, manifest, manifestPath, developmentLabels, holdoutLabels, saveManifest, saveLabels,
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
};
export const providerResponse = (result = null, extra = {}) => ({ ok: true, status: 200,
  url: 'https://api.openai.com/v1/responses', headers: new Headers({ 'x-request-id': 'req_mock' }),
  json: async () => ({ status: 'completed', model: 'response-model-fixture', id: 'resp_mock',
    usage: { input_tokens: 23, output_tokens: 12, total_tokens: 35, secret: 'PRIVATE_PROVIDER_BLOB' },
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result || {
      candidateItemId: 'candidate_1', alternativeItemIds: [], baseUom: 'EA',
      quantity: { kind: 'exact', value: 3, lower: null, upper: null },
      evidenceRefs: ['evidence_1'], limitations: [], ambiguity: '', confidence: .9 }) }] }], ...extra }) });
export const recordingOptions = fixture => ({ manifestPath: fixture.manifestPath, caseIds: ['case-001'],
  executeProvider: true, model: 'requested-model-fixture', maxCalls: 1, deadlineMs: 1000,
  maxAttempts: 1, output: join(fixture.root, 'recordings.json'), runId: 'fixture-run', apiKey: 'test-no-network',
  now: () => Date.parse('2026-10-08T00:00:00Z') });
