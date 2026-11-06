import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildSgDemo1Book,
  buildSgDemo1EvidenceWorld,
  buildSgDemo1SourceManifest,
  canonicalJson,
} from './testSupport/sgDemo1Definition.js';
import {
  SG_DEMO_1_DEFAULT_PATHS,
  evaluateSgDemo1,
  loadSgDemo1Inputs,
} from './testSupport/sgDemo1Goldset.js';
import { renderWorldArtifacts } from './world/worldRenderer.js';

const inputs = loadSgDemo1Inputs();
const clone = (value) => JSON.parse(JSON.stringify(value));
const codes = (result) => new Set(result.errors.map(({ code }) => code));

test('SG-Demo-1 generated definitions equal the committed canonical book, source manifest, and world bytes', () => {
  assert.equal(inputs.bookText, `${canonicalJson(buildSgDemo1Book())}\n`);
  assert.equal(inputs.sourceManifestText, `${canonicalJson(buildSgDemo1SourceManifest())}\n`);
  const worldText = readFileSync(new URL('./fixtures/sg-demo-1/world.json', import.meta.url), 'utf8');
  assert.equal(worldText, `${canonicalJson(buildSgDemo1EvidenceWorld(inputs.book))}\n`);
});
test('SG-Demo-1 healthy book passes every invariant and equals the checked-in concise receipt', () => {
  const result = evaluateSgDemo1(inputs);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.receipt.status, 'pass');
  assert.deepEqual(result.receipt.counts, {
    bank_lines: 31,
    statements: 12,
    primary_evidence: 21,
    rendered_evidence: 33,
    event_groups: 21,
    journals: 21,
    owner_cases: 8,
    bank_lines_auto_reconciled: 23,
    bank_lines_on_owner: 8,
    owner_evidence_placeholders: 8,
  });
  assert.deepEqual(result.receipt.totals, {
    debit: '38004.80',
    credit: '38004.80',
    statement_closing_sgd: '25463.30',
    posted_bank_control_sgd: '30449.30',
    owner_pending_movement_sgd: '-4986.00',
    gst_payable_sgd: '13.50',
    profit_sgd: '3865.80',
  });
  assert.ok(result.receipt.invariants.every(({ status }) => status === 'pass'));
  assert.equal(readFileSync(SG_DEMO_1_DEFAULT_PATHS.committedReceipt, 'utf8'), `${canonicalJson(result.receipt)}\n`);
});

test('all 33 evidence artifacts re-render byte-identically twice and match committed byte receipts', async () => {
  const world = buildSgDemo1EvidenceWorld(inputs.book);
  const [first, second] = await Promise.all([renderWorldArtifacts(world), renderWorldArtifacts(world)]);
  assert.equal(first.ok, true, first.errors.join('; '));
  assert.equal(second.ok, true, second.errors.join('; '));
  assert.equal(first.artifacts.length, 33);
  const receipts = new Map(inputs.evidenceReceipts.artifacts.map((row) => [row.id, row]));
  for (let index = 0; index < first.artifacts.length; index += 1) {
    const left = first.artifacts[index];
    const right = second.artifacts[index];
    assert.equal(left.id, right.id);
    assert.equal(left.contentBase64, right.contentBase64, left.id);
    const bytes = Buffer.from(left.contentBase64, 'base64');
    const receipt = receipts.get(left.id);
    assert.ok(receipt, left.id);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), receipt.sha256, left.id);
    assert.equal(bytes.length, receipt.byte_length, left.id);
    assert.deepEqual(bytes, readFileSync(new URL(`./fixtures/sg-demo-1/${receipt.file}`, import.meta.url)), left.id);
  }
});

test('strict schema rejects an unknown field even when the mutated bytes are canonical', () => {
  const book = clone(inputs.book);
  book.entity.unreviewed_guess = 'director_loan';
  const result = evaluateSgDemo1({ ...inputs, book, bookText: `${canonicalJson(book)}\n`, verifyEvidenceBytes: false });
  assert.equal(result.ok, false);
  assert.ok(codes(result).has('SG_SCHEMA_UNSUPPORTED_FIELD'));
});

test('canonicalized input still fails when a declared array order changes', () => {
  const book = clone(inputs.book);
  [book.bank_lines[0], book.bank_lines[1]] = [book.bank_lines[1], book.bank_lines[0]];
  const result = evaluateSgDemo1({ ...inputs, book, bookText: `${canonicalJson(book)}\n`, verifyEvidenceBytes: false });
  assert.equal(result.ok, false);
  assert.ok(codes(result).has('SG_ARRAY_ORDER'));
});

test('statement drift cannot hide behind an otherwise plausible bank line', () => {
  const book = clone(inputs.book);
  book.bank_lines.find(({ id }) => id === 'b001').amount = '1091.00';
  const result = evaluateSgDemo1({ ...inputs, book, bookText: `${canonicalJson(book)}\n`, verifyEvidenceBytes: false });
  assert.equal(result.ok, false);
  assert.ok(codes(result).has('SG_STATEMENT_FOOTING'));
});

test('foreign VAT moved into Singapore input GST fails the journal and economic oracle', () => {
  const book = clone(inputs.book);
  book.events.find(({ id }) => id === 'E06').journal.lines.find(({ id }) => id === 'journal_e06_l01').account_code = '2951';
  const result = evaluateSgDemo1({ ...inputs, book, bookText: `${canonicalJson(book)}\n`, verifyEvidenceBytes: false });
  assert.equal(result.ok, false);
  assert.ok(codes(result).has('SG_FOREIGN_VAT_OR_FX'));
  assert.ok(codes(result).has('SG_TRIAL_BALANCE_ACCOUNT'));
});

test('removing an owner case leaves a named non-terminal coverage failure', () => {
  const book = clone(inputs.book);
  book.owner_cases = book.owner_cases.filter(({ id }) => id !== 'U08');
  const result = evaluateSgDemo1({ ...inputs, book, bookText: `${canonicalJson(book)}\n`, verifyEvidenceBytes: false });
  assert.equal(result.ok, false);
  assert.ok(codes(result).has('SG_BANK_LINE_COVERAGE'));
  assert.ok(codes(result).has('SG_OWNER_CASE_COUNT'));
});

test('reverse-charge owner ask may request facts but cannot ask the owner for a tax conclusion', () => {
  const book = clone(inputs.book);
  book.owner_cases.find(({ id }) => id === 'U02').question = 'Should we apply reverse charge?';
  const result = evaluateSgDemo1({ ...inputs, book, bookText: `${canonicalJson(book)}\n`, verifyEvidenceBytes: false });
  assert.equal(result.ok, false);
  assert.ok(codes(result).has('SG_OWNER_TAX_CONCLUSION'));
});

test('the exact sibling collision stays unmatched and entity-isolated', () => {
  const book = clone(inputs.book);
  book.cross_entity_decoys[0].expected_match_id = 'match_e01_b001';
  const result = evaluateSgDemo1({ ...inputs, book, bookText: `${canonicalJson(book)}\n`, verifyEvidenceBytes: false });
  assert.equal(result.ok, false);
  assert.ok(codes(result).has('SG_CROSS_ENTITY_MATCH'));
});

test('a changed committed evidence byte fails even when its receipt keeps a valid SHA shape', () => {
  const evidenceReceipts = clone(inputs.evidenceReceipts);
  evidenceReceipts.artifacts[0].sha256 = '0'.repeat(64);
  const result = evaluateSgDemo1({
    ...inputs,
    evidenceReceipts,
    evidenceReceiptsText: `${canonicalJson(evidenceReceipts)}\n`,
  });
  assert.equal(result.ok, false);
  assert.ok(codes(result).has('SG_EVIDENCE_BYTE_DRIFT'));
});

test('replay is independent of host timezone, locale, and unrelated environment values', () => {
  const first = `${canonicalJson(evaluateSgDemo1(inputs).receipt)}\n`;
  const prior = { TZ: process.env.TZ, LANG: process.env.LANG, SG_DEMO_NOISE: process.env.SG_DEMO_NOISE };
  process.env.TZ = 'Pacific/Honolulu';
  process.env.LANG = 'ar_AE.UTF-8';
  process.env.SG_DEMO_NOISE = 'must-not-enter-the-receipt';
  try {
    const second = `${canonicalJson(evaluateSgDemo1(inputs).receipt)}\n`;
    assert.equal(second, first);
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
