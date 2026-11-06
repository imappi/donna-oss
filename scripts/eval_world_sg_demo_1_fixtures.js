#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  SG_DEMO_1_EVIDENCE_RECEIPT_VERSION,
  buildSgDemo1Book,
  buildSgDemo1EvidenceWorld,
  buildSgDemo1SourceManifest,
  canonicalJson,
  sha256,
} from '../server/donna/testSupport/sgDemo1Definition.js';
import { evaluateSgDemo1 } from '../server/donna/testSupport/sgDemo1Goldset.js';
import { renderWorldArtifacts } from '../server/donna/world/worldRenderer.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOOK_PATH = path.join(ROOT, 'data/worlds/sg/sg-demo-1-book-v1.json');
const SOURCE_PATH = path.join(ROOT, 'data/worlds/sg/sg-demo-1-source-manifest-v1.json');
const RECEIPT_PATH = path.join(ROOT, 'data/worlds/sg/receipts/sg-demo-1-goldset-v1.json');
const EVIDENCE_DIR = path.join(ROOT, 'server/donna/fixtures/sg-demo-1');
const WORLD_PATH = path.join(EVIDENCE_DIR, 'world.json');
const EVIDENCE_RECEIPTS_PATH = path.join(EVIDENCE_DIR, 'receipts.json');

if (!process.argv.includes('--write')) {
  console.error('Refusing to write without --write. This script only regenerates checked-in SG-Demo-1 fixtures.');
  process.exit(2);
}

const book = buildSgDemo1Book();
const sourceManifest = buildSgDemo1SourceManifest();
const world = buildSgDemo1EvidenceWorld(book);
const bookText = `${canonicalJson(book)}\n`;
const sourceManifestText = `${canonicalJson(sourceManifest)}\n`;
const worldText = `${canonicalJson(world)}\n`;

await mkdir(path.dirname(BOOK_PATH), { recursive: true });
await mkdir(path.dirname(RECEIPT_PATH), { recursive: true });
await mkdir(EVIDENCE_DIR, { recursive: true });
await writeFile(BOOK_PATH, bookText, 'utf8');
await writeFile(SOURCE_PATH, sourceManifestText, 'utf8');
await writeFile(WORLD_PATH, worldText, 'utf8');

const rendered = await renderWorldArtifacts(world);
if (!rendered.ok) throw new Error(`SG-Demo-1 evidence world did not render: ${rendered.errors.join('; ')}`);
const artifactDefinitionById = new Map(world.artifacts.map((artifact) => [artifact.id, artifact]));
const artifactRows = [];
for (const artifact of rendered.artifacts) {
  const definition = artifactDefinitionById.get(artifact.id);
  if (!definition?.fixtureFile) throw new Error(`No fixtureFile declared for ${artifact.id}`);
  const bytes = Buffer.from(artifact.contentBase64, 'base64');
  await writeFile(path.join(EVIDENCE_DIR, definition.fixtureFile), bytes);
  artifactRows.push({
    id: artifact.id,
    file: definition.fixtureFile,
    frozen_date: artifact.frozenDate,
    sha256: sha256(bytes),
    byte_length: bytes.length,
    terminal: 'auto_reconciled',
  });
}
artifactRows.sort((left, right) => left.id.localeCompare(right.id));
const evidenceReceipts = {
  schema_version: SG_DEMO_1_EVIDENCE_RECEIPT_VERSION,
  world_id: world.worldId,
  world_seed: world.seed,
  renderer_version: rendered.version,
  artifacts: artifactRows,
};
const evidenceReceiptsText = `${canonicalJson(evidenceReceipts)}\n`;
await writeFile(EVIDENCE_RECEIPTS_PATH, evidenceReceiptsText, 'utf8');

const evaluation = evaluateSgDemo1({
  book,
  bookText,
  sourceManifest,
  sourceManifestText,
  evidenceReceipts,
  evidenceReceiptsText,
  evidenceDir: EVIDENCE_DIR,
});
if (!evaluation.ok) throw new Error(`SG-Demo-1 evaluation failed: ${evaluation.errors.map(({ code, path: errorPath }) => `${code}@${errorPath}`).join(', ')}`);
await writeFile(RECEIPT_PATH, `${canonicalJson(evaluation.receipt)}\n`, 'utf8');

console.log(canonicalJson({
  status: 'pass',
  world_id: book.world_id,
  book: path.relative(ROOT, BOOK_PATH),
  source_manifest: path.relative(ROOT, SOURCE_PATH),
  evidence_artifacts: artifactRows.length,
  receipt: path.relative(ROOT, RECEIPT_PATH),
  receipt_sha256: evaluation.receipt.receipt_sha256,
}));
