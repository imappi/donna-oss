import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, symlinkSync, mkdirSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { loadLocalQuantityCorpus, loadLocalQuantityLabels, MAX_IMAGE_BYTES } from './donna_quantity_corpus.js';
import { buildBlindQuantityRequest } from '../server/donna/inventory/quantityProposal.js';
import { makeLocalCorpus } from './testSupport/donnaQuantityCorpus.js';

test('local admission hashes actual bytes and keeps separate development/holdout labels out of blind input', () => {
  const f = makeLocalCorpus();
  try {
    const corpus = loadLocalQuantityCorpus(f.manifestPath);
    assert.equal(corpus.fixtures.length, 3);
    assert.equal(corpus.fixtures[0].media[0].bytes.length, f.manifest.cases[0].evidence[0].size);
    const blind = JSON.stringify(buildBlindQuantityRequest(corpus.fixtures[0].input).input);
    for (const secret of ['PRIVATE_SOURCE_REF', 'PRIVATE_AUTHORIZATION_REF', 'private-name', 'private-group', 'opaque-item', 'opaque-evidence', 'SYNTHETIC_LABEL']) assert.ok(!blind.includes(secret));
    const labelled = loadLocalQuantityLabels(corpus, f);
    assert.equal(labelled.fixtures[1].expected.quantity, 3);
    assert.ok(labelled.labelsDigest);
    // The recorder's corpus has no label dependency, even if both label files are unreadable JSON.
    writeFileSync(f.developmentLabels, 'LABEL_SECRET'); writeFileSync(f.holdoutLabels, 'LABEL_SECRET');
    assert.equal(loadLocalQuantityCorpus(f.manifestPath).manifestDigest, corpus.manifestDigest);
    assert.throws(() => loadLocalQuantityLabels(corpus, f), /CORPUS_JSON_INVALID/);
  } finally { f.cleanup(); }
});

test('closed manifest refuses expected counts, provider URLs, metadata smuggling and missing authorization', () => {
  for (const mutate of [m => { m.endpoint = 'http://127.0.0.1'; }, m => { m.cases[0].expectedQuantity = 3; },
    m => { m.cases[0].candidates[0].expectedQuantity = 3; }, m => { m.cases[0].evidence[0].url = 'https://example.invalid'; },
    m => { m.cases[0].evidence[0].authorizationRef = ''; }, m => { m.cases[0].evidence[0] = null; }]) {
    const f = makeLocalCorpus();
    try { mutate(f.manifest); f.saveManifest(); assert.throws(() => loadLocalQuantityCorpus(f.manifestPath)); }
    finally { f.cleanup(); }
  }
});

test('confinement refuses traversal, network/path schemes, absolute paths and symlink escapes; internal links work', () => {
  for (const path of ['../outside.png', 'https://example.invalid/x.png', 'file:private.png', '/etc/passwd', 'a\\b.png']) {
    const f = makeLocalCorpus();
    try { f.manifest.cases[0].evidence[0].path = path; f.saveManifest(); assert.throws(() => loadLocalQuantityCorpus(f.manifestPath), /CORPUS_PATH_REFUSED/); }
    finally { f.cleanup(); }
  }
  const f = makeLocalCorpus(), outside = makeLocalCorpus();
  try {
    symlinkSync(join(outside.root, 'private-name-0.png'), join(f.root, 'escape.png'));
    f.manifest.cases[0].evidence[0].path = 'escape.png'; f.saveManifest();
    assert.throws(() => loadLocalQuantityCorpus(f.manifestPath), /CORPUS_PATH_REFUSED/);
    symlinkSync(outside.root, join(f.root, 'escape-directory'));
    f.manifest.cases[0].evidence[0].path = 'escape-directory/private-name-0.png'; f.saveManifest();
    assert.throws(() => loadLocalQuantityCorpus(f.manifestPath), /CORPUS_PATH_REFUSED/);
    symlinkSync(join(f.root, 'private-name-0.png'), join(f.root, 'internal.png'));
    f.manifest.cases[0].evidence[0].path = 'internal.png'; f.saveManifest();
    assert.equal(loadLocalQuantityCorpus(f.manifestPath).fixtures.length, 3);
    symlinkSync(outside.manifestPath, join(f.root, 'escape-manifest.json'));
    assert.throws(() => loadLocalQuantityCorpus(join(f.root, 'escape-manifest.json')), /CORPUS_PATH_REFUSED/);
  } finally { f.cleanup(); outside.cleanup(); }
});

test('actual hash, MIME, size, regular-file and byte caps refuse forged admission', () => {
  for (const [mutate, code] of [
    [f => { f.manifest.cases[0].evidence[0].sha256 = 'a'.repeat(64); }, 'CORPUS_HASH_MISMATCH'],
    [f => { f.manifest.cases[0].evidence[0].mime = 'image/jpeg'; }, 'CORPUS_MIME_MISMATCH'],
    [f => { f.manifest.cases[0].evidence[0].mime = 'image/gif'; }, 'CORPUS_MEDIA_INVALID'],
    [f => { f.manifest.cases[0].evidence[0].size += 1; }, 'CORPUS_SIZE_MISMATCH'],
    [f => { truncateSync(join(f.root, 'private-name-0.png'), MAX_IMAGE_BYTES + 1); }, 'CORPUS_FILE_BOUNDS'],
    [f => { mkdirSync(join(f.root, 'directory.png')); f.manifest.cases[0].evidence[0].path = 'directory.png'; }, 'CORPUS_FILE_BOUNDS']]) {
    const f = makeLocalCorpus();
    try { mutate(f); f.saveManifest(); assert.throws(() => loadLocalQuantityCorpus(f.manifestPath), new RegExp(code)); }
    finally { f.cleanup(); }
  }
});

test('source groups and byte identity prevent split leakage and fabricated independence', () => {
  const f = makeLocalCorpus();
  try {
    f.manifest.cases[1].evidence[0].sourceGroupId = f.manifest.cases[0].evidence[0].sourceGroupId; f.saveManifest();
    assert.throws(() => loadLocalQuantityCorpus(f.manifestPath), /CORPUS_SPLIT_LEAKAGE/);
    f.manifest.cases[1].evidence[0] = { ...f.manifest.cases[0].evidence[0], id: 'another-id', sourceGroupId: 'another-group' }; f.saveManifest();
    assert.throws(() => loadLocalQuantityCorpus(f.manifestPath), /CORPUS_SOURCE_GROUP_CONFLICT/);
    f.manifest.cases[1].split = 'development'; f.manifest.cases[1].evidence[0].sourceGroupId = f.manifest.cases[0].evidence[0].sourceGroupId; f.saveManifest();
    assert.equal(loadLocalQuantityCorpus(f.manifestPath).fixtures.length, 3);
  } finally { f.cleanup(); }
});

test('independent labels bind the full fixed manifest and require each split without duplicates', () => {
  const f = makeLocalCorpus();
  try {
    const corpus = loadLocalQuantityCorpus(f.manifestPath);
    assert.throws(() => loadLocalQuantityLabels(corpus, { developmentLabels: f.holdoutLabels, holdoutLabels: f.developmentLabels }), /CORPUS_LABELS_INVALID/);
    const labels = JSON.parse(readFileSync(f.holdoutLabels)); labels.cases.pop(); writeFileSync(f.holdoutLabels, JSON.stringify(labels));
    assert.throws(() => loadLocalQuantityLabels(corpus, f), /CORPUS_LABELS_INVALID/);
    f.saveLabels(); const stale = JSON.parse(readFileSync(f.holdoutLabels)); stale.manifestDigest = 'a'.repeat(64); writeFileSync(f.holdoutLabels, JSON.stringify(stale));
    assert.throws(() => loadLocalQuantityLabels(corpus, f), /CORPUS_LABELS_INVALID/);
  } finally { f.cleanup(); }
});

test('a file growing during the read cannot allocate beyond its admitted byte bound', () => {
  const f = makeLocalCorpus(), originalRead = fs.readSync;
  const admittedSize = f.manifest.cases[0].evidence[0].size;
  let grew = false;
  try {
    fs.readSync = (fd, buffer, ...args) => {
      if (!grew && fs.fstatSync(fd).size === admittedSize) {
        grew = true;
        assert.equal(buffer.length, admittedSize + 1);
        truncateSync(join(f.root, 'private-name-0.png'), MAX_IMAGE_BYTES + 1);
      }
      return originalRead(fd, buffer, ...args);
    };
    syncBuiltinESMExports();
    assert.throws(() => loadLocalQuantityCorpus(f.manifestPath), /CORPUS_FILE_CHANGED/);
    assert.equal(grew, true);
  } finally { fs.readSync = originalRead; syncBuiltinESMExports(); f.cleanup(); }
});
