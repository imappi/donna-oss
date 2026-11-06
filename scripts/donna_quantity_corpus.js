// Local evaluation admission only. This is not production evidence/custody admission.
import { constants, existsSync, openSync, closeSync, fstatSync, readSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { __sniffMimeFromBase64 } from '../server/donna/responsesInputPart.js';
import { physicalHash } from '../server/donna/inventory/physicalReconciliation.js';
import { validateBlindQuantityInput, QUANTITY_PROTOCOL_VERSION, QUANTITY_LIMITATIONS } from '../server/donna/inventory/quantityProposal.js';

export const LOCAL_CORPUS_VERSION = 'donna-quantity-real-local-corpus.v1';
export const LOCAL_LABELS_VERSION = 'donna-quantity-independent-labels.v1';
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_CORPUS_BYTES = 100 * 1024 * 1024;
const REPO = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const mimes = ['image/jpeg', 'image/png', 'image/webp'];
export const corpusError = code => { throw Object.assign(new Error(code), { code }); };
export const closedFields = (v, names) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
const text = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 500 && !/[\x00-\x1f]/.test(v);
const inside = (root, path) => { const r = relative(root, path); return r === '' || (!isAbsolute(r) && r !== '..' && !r.startsWith(`..${sep}`)); };
export const requireExternalPath = path => {
  if (inside(REPO, path)) corpusError('CORPUS_EXTERNAL_PATH_REQUIRED');
  // Also refuse the saved source checkout and any other Git repository.
  for (let parent = dirname(path); parent !== dirname(parent); parent = dirname(parent)) {
    if (existsSync(resolve(parent, '.git'))) corpusError('CORPUS_EXTERNAL_PATH_REQUIRED');
  }
  return path;
};

// Bound reads before allocating. Resolve and check symlinks, then open the resolved
// regular file without following a final symlink and recheck identity after reading.
export const readConfinedBytes = (root, name, maxBytes) => {
  if (!text(name) || isAbsolute(name) || name.includes('\\') || name.includes(':')
    || name.split('/').some(p => p === '..' || p === '' || p === '.')) corpusError('CORPUS_PATH_REFUSED');
  const requested = resolve(root, name);
  let actual, fd;
  try {
    actual = realpathSync(requested);
    if (!inside(root, actual)) corpusError('CORPUS_PATH_REFUSED');
    requireExternalPath(actual);
    fd = openSync(actual, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile() || before.size < 1 || before.size > maxBytes) corpusError('CORPUS_FILE_BOUNDS');
    // A file can grow after fstat. Allocate only the admitted size plus one
    // overflow byte; never let a concurrent writer turn a bounded read into OOM.
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const n = readSync(fd, buffer, length, buffer.length - length, length);
      if (n === 0) break;
      length += n;
    }
    const bytes = buffer.subarray(0, length);
    const after = fstatSync(fd), current = statSync(realpathSync(requested));
    if (realpathSync(requested) !== actual || after.dev !== current.dev || after.ino !== current.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || bytes.length !== before.size || bytes.length > maxBytes) corpusError('CORPUS_FILE_CHANGED');
    return bytes;
  } catch (error) {
    if (error.code?.startsWith('CORPUS_')) throw error;
    corpusError('CORPUS_FILE_UNAVAILABLE'); // No filenames or raw I/O errors in receipts.
  } finally { if (fd !== undefined) closeSync(fd); }
};
export const readExternalJson = path => {
  let actual;
  try { actual = requireExternalPath(realpathSync(resolve(path))); }
  catch (error) { if (error.code?.startsWith('CORPUS_')) throw error; corpusError('CORPUS_FILE_UNAVAILABLE'); }
  try { return JSON.parse(readConfinedBytes(dirname(actual), actual.slice(dirname(actual).length + 1), MAX_JSON_BYTES)); }
  catch (error) { if (error.code?.startsWith('CORPUS_')) throw error; corpusError('CORPUS_JSON_INVALID'); }
};

export const loadLocalQuantityCorpus = manifestPath => {
  const root = requireExternalPath(realpathSync(dirname(resolve(manifestPath))));
  let manifest;
  try { manifest = JSON.parse(readConfinedBytes(root, resolve(manifestPath).slice(dirname(resolve(manifestPath)).length + 1), MAX_JSON_BYTES)); }
  catch (error) { if (error.code?.startsWith('CORPUS_')) throw error; corpusError('CORPUS_JSON_INVALID'); }
  if (!closedFields(manifest, ['version', 'fixtureBasis', 'imageryStatus', 'cases'])
    || manifest.version !== LOCAL_CORPUS_VERSION || manifest.fixtureBasis !== 'real_local_images'
    || manifest.imageryStatus !== 'supplied_local' || !Array.isArray(manifest.cases)
    || !manifest.cases.length || manifest.cases.length > 100) corpusError('CORPUS_MANIFEST_INVALID');
  const ids = new Set(), groups = new Map(), hashes = new Map();
  let totalBytes = 0;
  const fixtures = manifest.cases.map((c, index) => {
    if (!closedFields(c, ['id', 'split', 'condition', 'candidates', 'evidence']) || !/^case-\d{3}$/.test(c.id)
      || ids.has(c.id) || !['development', 'holdout'].includes(c.split)
      || !['clear_count', ...QUANTITY_LIMITATIONS].includes(c.condition)
      || !Array.isArray(c.evidence) || !c.evidence.length || c.evidence.length > 10) corpusError('CORPUS_CASE_INVALID');
    ids.add(c.id);
    if (c.evidence.some(e => !closedFields(e, ['id', 'path', 'sha256', 'mime', 'size', 'sourceGroupId', 'sourceRef', 'authorizationRef']))) corpusError('CORPUS_MEDIA_INVALID');
    const input = validateBlindQuantityInput({ scope: { firmId: 'offline-local', clientId: `observation-${index + 1}`, locationId: 'local-scene' },
      protocolVersion: QUANTITY_PROTOCOL_VERSION, candidates: c.candidates,
      evidence: c.evidence.map(e => ({ id: e.id, checksum: e.sha256, sourceGroupId: e.sourceGroupId })) });
    const media = c.evidence.map(e => {
      if (!closedFields(e, ['id', 'path', 'sha256', 'mime', 'size', 'sourceGroupId', 'sourceRef', 'authorizationRef'])
        || !text(e.sourceRef) || !text(e.authorizationRef) || !mimes.includes(e.mime)
        || !Number.isSafeInteger(e.size) || e.size < 32 || e.size > MAX_IMAGE_BYTES) corpusError('CORPUS_MEDIA_INVALID');
      // A dependent group and identical bytes cannot leak between fixed splits.
      if (groups.has(e.sourceGroupId) && groups.get(e.sourceGroupId) !== c.split) corpusError('CORPUS_SPLIT_LEAKAGE');
      groups.set(e.sourceGroupId, c.split);
      if (hashes.has(e.sha256) && (hashes.get(e.sha256).split !== c.split
        || hashes.get(e.sha256).group !== e.sourceGroupId)) corpusError('CORPUS_SOURCE_GROUP_CONFLICT');
      hashes.set(e.sha256, { split: c.split, group: e.sourceGroupId });
      totalBytes += e.size;
      if (totalBytes > MAX_CORPUS_BYTES) corpusError('CORPUS_TOTAL_BOUNDS');
      const bytes = readConfinedBytes(root, e.path, MAX_IMAGE_BYTES);
      if (bytes.length !== e.size) corpusError('CORPUS_SIZE_MISMATCH');
      if (createHash('sha256').update(bytes).digest('hex') !== e.sha256) corpusError('CORPUS_HASH_MISMATCH');
      if (__sniffMimeFromBase64(bytes.subarray(0, 32).toString('base64')) !== e.mime) corpusError('CORPUS_MIME_MISMATCH');
      return { id: e.id, mime: e.mime, bytes };
    });
    return { id: c.id, split: c.split, condition: c.condition, input, media };
  });
  if (!fixtures.some(f => f.split === 'holdout') || !fixtures.some(f => f.split === 'development')) corpusError('CORPUS_SPLITS_REQUIRED');
  return { manifest, manifestDigest: physicalHash(manifest), fixtures };
};

// Only the scorer imports this path. Recorder admission never opens label files.
export const loadLocalQuantityLabels = (corpus, { developmentLabels, holdoutLabels }) => {
  const labels = [developmentLabels, holdoutLabels].map((path, index) => {
    const split = index === 0 ? 'development' : 'holdout';
    const doc = readExternalJson(path);
    if (!closedFields(doc, ['version', 'manifestDigest', 'split', 'labelBasis', 'evaluatorRef', 'cases'])
      || doc.version !== LOCAL_LABELS_VERSION || doc.manifestDigest !== corpus.manifestDigest
      || doc.split !== split || doc.labelBasis !== 'independent_manual_observation' || !text(doc.evaluatorRef)
      || !Array.isArray(doc.cases) || doc.cases.length !== corpus.fixtures.filter(f => f.split === split).length
      || new Set(doc.cases.map(c => c.id)).size !== doc.cases.length) corpusError('CORPUS_LABELS_INVALID');
    for (const label of doc.cases) {
      const f = corpus.fixtures.find(f => f.id === label.id && f.split === split);
      if (!f || !closedFields(label, ['id', 'candidateItemId', 'baseUom', 'quantity', 'mustAbstain', 'sourceRef'])
        || !text(label.sourceRef) || typeof label.mustAbstain !== 'boolean'
        || (label.mustAbstain ? label.quantity !== null : typeof label.quantity !== 'number'
          || !Number.isFinite(label.quantity) || label.quantity < 0 || label.quantity > 1e12)
        || !f.input.candidates.some(c => c.itemId === label.candidateItemId && c.baseUom === label.baseUom)) corpusError('CORPUS_LABELS_INVALID');
    }
    return doc;
  });
  return { ...corpus, labelsDigest: physicalHash(labels), fixtures: corpus.fixtures.map(f => {
    const label = labels.flatMap(d => d.cases).find(l => l.id === f.id);
    return { id: f.id, split: f.split, condition: f.condition, input: f.input,
      expected: { candidateItemId: label.candidateItemId, baseUom: label.baseUom, quantity: label.quantity,
        mustAbstain: label.mustAbstain, labelBasis: 'independent_manual_observation' } };
  }) };
};
