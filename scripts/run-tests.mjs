#!/usr/bin/env node

import { constants } from 'node:fs';
import { access, readdir, stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { planShards, parseShard, inventoryDigest, verifyShardReceipts } from './test-shards.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MINIMUM_EXPECTED_TEST_FILES = 400;

// These legacy tests intentionally own their harness and print assertions outside
// node:test's headline count. Keep them as plain scripts until each is deliberately migrated.
const SCRIPT_STYLE_TESTS = new Set([
  'server/donna/routing.test.js',
  'server/donna/auto-promote.test.js',
  'server/donna/bizfilePdf.test.js',
  'server/donna/bankStatement.test.js',
  'server/donna/bankStatementVision.test.js',
  'server/donna/bankStatementLlmFirst.test.js',
  'server/donna/firmAccounting.test.js',
  'server/donna/xeroClient.test.js',
  'server/donna/qboClient.test.js',
  'server/donna/qboWriteback.test.js',
  'server/donna/xeroAccountMatcher.test.js',
  'server/donna/xeroCoaProvisioning.test.js',
  'server/donna/xeroWriteback.test.js',
  'server/donna/donnaLedgerWriteback.test.js',
  'server/donna/xeroMirrorVerification.test.js',
  'server/donna/xeroMirrorClear.test.js',
  'scripts/export_xero_mirror.test.js',
  'server/donna/ledger.test.js',
  'server/donna/ledgerReadModel.test.js',
  'server/donna/financialReportExport.test.js',
  'server/donna/ledgerAuditTrail.test.js',
  'server/donna/ledgerDiagnostics.test.js',
  'server/donna/closeArchive.test.js',
  'server/donna/transactionReviewStates.test.js',
  'server/donna/transactionIntel.test.js',
  'server/donna/transactionLlm.test.js',
  'server/donna/jevCoding.test.js',
  'server/donna/receipt.test.js',
  'server/donna/supplierBill.test.js',
  'server/donna/salesInvoice.test.js',
  'server/donna/contract.test.js',
  'server/donna/lineFingerprint.test.js',
  'server/donna/totalsValidation.test.js',
  'server/donna/migrations.test.js',
  'server/donna/inngest/parseErrors.test.js',
  'server/donna/inngest/parseDocument.test.js',
  'server/donna/parseDocumentsDb.test.js',
  'server/donna/parseCronStabilization.test.js',
  'src/lib/uploadTray.test.js',
  'src/lib/intakeUpload.test.js',
  'src/lib/receiptReview.test.js',
  'src/lib/documentsInbox.test.js',
  'src/lib/arAging.test.js',
  'src/lib/apAging.test.js',
  'src/lib/firmDocuments.test.js',
  'src/lib/manualLinkPicker.test.js',
  'src/lib/transactionMatchHero.test.js',
  'src/lib/documentArtifactSuggestions.test.js',
  'src/lib/documentChat.test.js',
  'src/lib/clientPortalChat.test.js',
  'src/lib/chatLastSeen.test.js',
  'src/lib/transactionChat.test.js',
  'src/lib/toastBus.test.js',
  'src/lib/ruleProposals.test.js',
  'src/lib/oauthRedirect.test.js',
  'src/lib/askBatchView.test.js',
  'scripts/backfill_alex_morgan_classification.test.js',
  'scripts/mark_alex_morgan_duplicates.test.js',
  'scripts/repair_orphaned_reconciled_transactions.test.js',
  'scripts/repair_stale_suspense_xero_mirror.test.js',
  'scripts/add_taxes_and_licenses_account.test.js',
  'scripts/migrate_client_to_firm.test.js',
  'scripts/delete_client.test.js',
]);

// Quarantines are visible, narrow, and reasoned: discovery still counts and reports them.
const QUARANTINED_TESTS = new Map([
]);


// DMEM-R1 W0 — EXPECTED-FAILURE fixtures (docs/audit-2026-09-04-memory-re-baseline.md §7;
// plan v1.0 §7 W0 "locked executed expected-failure tests with an exact failure
// fingerprint"). These files RUN on every CI pass and are REQUIRED to fail, with
// exactly the fingerprinted marker lines below on their output — never a skip. The
// registry is append-only: a slice that closes a finding FLIPS its fixture here
// (removes the file from this map so the ordinary pass rule applies) in the same
// PR that makes it pass; it never edits the fixture into passing prose. Three
// refusals, all hard failures of `npm test`:
//   - the file exits 0 → either it was SKIPPED (no DONNA_PG_TEST_URL: a failure in CI
//     and whenever the URL is set; a loud warning otherwise) or it now PASSES (the
//     fixture must be flipped, not left registered);
//   - a registered marker is missing, or a `DMEM_EXPECTED_FAILURE_NOW_PASSES` /
//     `DMEM_UNEXPECTED_FAILURE` marker appears → the fingerprint drifted or a
//     different layer broke first.
// Markers are emitted by server/donna/testSupport/dmemFixtureSupport.js as
// `[dmem] DMEM_EXPECTED_FAILURE <id> :: <fingerprint>` (or DMEM_REGISTERED_GAP).
const EXPECTED_FAILURE_TESTS = new Map([
  ['server/donna/dmemS05EffectiveDatePgLifecycle.test.js', {
    wave: 'W3 (W2 flipped the L1 schema layer 2026-09-04 — migration 142; the mint persisting the value is W3); L3/L4 flipped by W1 (the bounded cascade + its receipt)',
    acceptance: 'ACC-F09, ACC-C08',
    marks: [
      'DMEM_EXPECTED_FAILURE S05/L1 :: S05/L1: a client_rules row carries a business-effective interval (valid_from, valid_until) and its jurisdiction applicability',
    ]
  }],
  ['server/donna/dmemS06AuthorityConflictPgLifecycle.test.js', {
    wave: 'W3 (L1) · W4 (L2, L3) — W2 flipped L1b (evidence links, migration 142) 2026-09-04',
    acceptance: 'ACC-F13, ACC-F15, ACC-C10, ACC-C11',
    marks: [
      'DMEM_EXPECTED_FAILURE S06/L2 :: S06/L2: contradicting active facts on one subject surface as an explicit conflict, not as two authoritative facts',
      'DMEM_EXPECTED_FAILURE S06/L1 :: S06/L1: re-asserting a fact from the same source does not refresh its recency (updated_at unchanged)',
      "DMEM_EXPECTED_FAILURE S06/L3 :: S06/L3: known_facts carry each fact's asserting origin and authority class, not only text and confidence",
    ]
  }],
  ['server/donna/dmemS07EntitySettlementPgLifecycle.test.js', {
    wave: 'W3 (L1) · W2 (L4 gap)',
    acceptance: 'ACC-C09, ACC-C12',
    marks: [
      'DMEM_EXPECTED_FAILURE S07/L1 :: S07/L1: a second party with the same name and no shared business id is a separate party or a merge suggestion, never an auto-enrichment of the first',
      'DMEM_REGISTERED_GAP S07/L4 :: no store links a payout to its underlying sales evidence on this tree (RT-18 proves payout <-> bank credit only); double booking cannot be asserted until W2 evidence links exist',
    ]
  }],
  ['server/donna/dmemS08LifecycleReplayForgetPgLifecycle.test.js', {
    wave: 'W2-wiring (identity — W2 laid the substrate, migration 141, 2026-09-04; the memoryCandidates.js wiring follows W1) · W4 (L2, L3) · W5 (replay, erase) — L1-posture flipped by W1',
    acceptance: 'ACC-F02, ACC-F04, ACC-F06, ACC-F10, ACC-F14, ACC-F15, ACC-C14, ACC-C15',
    marks: [
      "DMEM_EXPECTED_FAILURE S08/L2 :: S08/L2: the owner prompt packet preserves each fact's origin, trust and epistemic state labels",
      "DMEM_EXPECTED_FAILURE S08/L3 :: S08/L3: the prompt-time retrieval set is persisted as an immutable pre-action receipt before the owner turn's model call",
      'DMEM_REGISTERED_GAP S08/L3-replay :: no replay entry point re-executes an owner turn against its recorded pre-action set on this tree (the artifact script re-queries live rows and its classifier throws); exact replay is a W5 deliverable over the W4 envelope',
      "DMEM_EXPECTED_FAILURE S08/L1-erase :: S08/L1: erasure reaches every content-bearing copy: the promoted candidate's subject, fact and contract_payload are scrubbed",
    ]
  }],
  ['server/donna/dmemS09LegacyAiRulesPgLifecycle.test.js', {
    wave: 'W4 (L3 — the coding decision receipt, N-01) — L1/L2/L4 flipped by W1 (+ LR-1)',
    acceptance: 'ACC-F01 (contained), LR-1',
    marks: [
      "DMEM_EXPECTED_FAILURE S09/L3 :: S09/L3: the batch coder's coding decision is receipted in llm_decisions for the line it coded",
    ]
  }],
  ['server/donna/dmemS12IncompleteDecisionsPgLifecycle.test.js', {
    wave: 'W4 (L1/L3) · W5 (replay) (+ LR-4) — W2 added the envelope tables + llm_decisions reference columns (migration 145) 2026-09-04',
    acceptance: 'ACC-F06, LR-4',
    marks: [
      'DMEM_EXPECTED_FAILURE S12/L1 :: S12/L1: the retained match decision names the prompt version that produced it (prompt_version is null on every llm_decisions match row)',
      'DMEM_EXPECTED_FAILURE S12/L3 :: S12/L3: the decision receipt references an immutable pre-action envelope (its digest) and the claim, rule and source generations the decision used',
      'DMEM_REGISTERED_GAP S12/L3-replay :: no replay entry point exists for an accounting decision on this tree; a decision retained without its pre-action envelope can only be classified historical_context_unavailable (LR-4), never replayed or reconstructed',
    ]
  }],
  ['server/donna/dmemCompatibilityRollbackOraclePgLifecycle.test.js', {
    wave: 'W3 (the projection) — the rollback legs span the W2 stores since 2026-09-04',
    acceptance: 'CR-01 (INV-23 rollback oracle)',
    marks: [
      'DMEM_EXPECTED_FAILURE CR-01/L1 :: CR-01/L1: after a canonical claim is written, the compatibility projection (firm_facts) carries its projected row for the legacy readers',
    ]
  }],
]);

// Markets on hold. Kari, 2026-11-05: "UAE is completely on hold right now ...
// It's on hold and may remain so." A market's dedicated test files stay in the
// tree but are not run by default, so CI minutes go to the markets being built
// (Finland and the UK). This is a scope decision recorded in CLAUDE.md, never a
// way to turn a red run green: shared tests that cover the market still run and
// still fail. Restore a market by deleting its entry; run its files on demand
// with --include-on-hold=<market>.
const ON_HOLD_MARKETS = new Map([
  ['ae', {
    since: '2026-11-05',
    reason: 'the UAE is on hold (Kari, 2026-11-05)',
    matches: (file) => /(^|\/)ae\//.test(file)
      || /(^|\/)(ae|arabic)[A-Z][^/]*\.test\.js$/.test(file)
      || /(^|\/)eval_world_ae_[^/]*\.test\.js$/.test(file)
      || /(^|\/)arAeCatalog\.test\.js$/.test(file),
  }],
]);

const DMEM_MARK_PREFIX = '[dmem] ';
const DMEM_FORBIDDEN_MARKS = ['DMEM_EXPECTED_FAILURE_NOW_PASSES', 'DMEM_UNEXPECTED_FAILURE'];

async function discoverTests(directory, relative = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const tests = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const childRelative = path.posix.join(relative, entry.name);
    const childAbsolute = path.join(directory, entry.name);
    if (entry.isDirectory()) tests.push(...await discoverTests(childAbsolute, childRelative));
    else if (entry.isFile() && entry.name.endsWith('.test.js')) tests.push(childRelative);
  }
  return tests;
}

async function assertReadable(file) {
  const absolute = path.join(ROOT, file);
  const metadata = await stat(absolute);
  if ((metadata.mode & 0o444) === 0) throw new Error(`Discovered test is unreadable: ${file}`);
  await access(absolute, constants.R_OK);
}

const tests = (await discoverTests(ROOT)).sort();
console.log(`Discovered ${tests.length} test files.`);
if (tests.length < MINIMUM_EXPECTED_TEST_FILES) {
  throw new Error(`Implausibly low test count: found ${tests.length}, expected at least ${MINIMUM_EXPECTED_TEST_FILES}.`);
}
await Promise.all(tests.map(assertReadable));

for (const [file, reason] of QUARANTINED_TESTS) {
  if (!tests.includes(file)) throw new Error(`Quarantined test was not discovered: ${file}`);
  console.warn(`QUARANTINED ${file}: ${reason}`);
}

for (const file of EXPECTED_FAILURE_TESTS.keys()) {
  if (!tests.includes(file)) throw new Error(`Expected-failure fixture was not discovered: ${file}`);
  if (QUARANTINED_TESTS.has(file)) throw new Error(`Expected-failure fixture may not be quarantined: ${file}`);
}

// node:test re-emits the fixture's stderr lines as TAP comments (`# [dmem] …`),
// so a marker is matched with or without the comment prefix.
const dmemMarkerLines = (text) => String(text || '')
  .split(/\r?\n/)
  .map((line) => line.trim().replace(/^#\s*/, ''))
  .filter((line) => line.startsWith(DMEM_MARK_PREFIX))
  .map((line) => line.slice(DMEM_MARK_PREFIX.length));

// A registered expected-failure fixture must FAIL with exactly its fingerprints.
const runExpectedFailureFixture = (file, entry) => {
  const args = ['--test', file];
  console.log(`\n=== ${process.execPath} ${args.join(' ')}  [expected failure: ${entry.marks.length} fingerprint(s)] ===`);
  const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: ['inherit', 'pipe', 'pipe'], env: process.env, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  const stdout = result.stdout ? result.stdout.toString('utf8') : '';
  const stderr = result.stderr ? result.stderr.toString('utf8') : '';
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  const markers = dmemMarkerLines(`${stdout}\n${stderr}`);
  const problems = [];
  if (result.status === 0) {
    const skipped = /^# skip(?:ped)?\s+([1-9]\d*)/m.exec(stdout);
    const passed = /^# pass\s+(\d+)/m.exec(stdout);
    const notExercised = skipped && (!passed || passed[1] === '0');
    if (notExercised) {
      const message = `expected-failure fixture was SKIPPED, not exercised (${file}) — INV-20: a required skip is a failure`;
      if (process.env.CI || process.env.DONNA_PG_TEST_URL) problems.push(message);
      else console.warn(`WARNING (local, no DONNA_PG_TEST_URL): ${message}`);
    } else {
      problems.push(`expected-failure fixture PASSED (${file}) — the tree now satisfies it; flip it out of EXPECTED_FAILURE_TESTS in the slice that closed it`);
    }
  } else {
    for (const mark of entry.marks) {
      if (!markers.includes(mark)) problems.push(`missing fingerprint: ${mark}`);
    }
    for (const marker of markers) {
      if (DMEM_FORBIDDEN_MARKS.some((forbidden) => marker.startsWith(forbidden))) problems.push(`refused marker: ${marker}`);
    }
  }
  if (problems.length) {
    console.error(`\nEXPECTED-FAILURE CONTRACT BROKEN for ${file}:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }
  console.log(`EXPECTED FAILURE OK — ${file}: ${entry.marks.length} fingerprint(s) matched${entry.wave ? ` (closes in ${entry.wave})` : ''}`);
  return markers.length;
};

const options = {};
for (const arg of process.argv.slice(2)) {
  const match = /^--(shard|receipt|verify-receipts|include-on-hold)=(.+)$/.exec(arg);
  if (!match || options[match[1]]) throw new Error(`Unknown or duplicate option: ${arg}`);
  options[match[1]] = match[2];
}
const includeOnHold = new Set(String(options['include-on-hold'] || '').split(',').map((market) => market.trim()).filter(Boolean));
for (const market of includeOnHold) {
  if (!ON_HOLD_MARKETS.has(market)) throw new Error(`Unknown on-hold market: ${market} (known: ${[...ON_HOLD_MARKETS.keys()].join(', ')})`);
}
const onHold = new Map();
for (const [market, hold] of ON_HOLD_MARKETS) {
  if (includeOnHold.has(market)) continue;
  const files = tests.filter(hold.matches);
  if (!files.length) throw new Error(`On-hold market ${market} matched no test files; update ON_HOLD_MARKETS`);
  for (const file of files) {
    if (EXPECTED_FAILURE_TESTS.has(file) || QUARANTINED_TESTS.has(file)) {
      throw new Error(`An expected-failure or quarantined test may not be on hold: ${file}`);
    }
  }
  onHold.set(market, files);
  console.log(`ON HOLD (${hold.since}) ${market}: ${files.length} test files not run, because ${hold.reason}. Run them with --include-on-hold=${market}.`);
}
const onHoldFiles = new Set([...onHold.values()].flat());
const runnable = tests.filter((file) => !QUARANTINED_TESTS.has(file) && !onHoldFiles.has(file));
const shard = parseShard(options.shard);
const { durationsMs } = JSON.parse(await readFile(path.join(ROOT, 'scripts/test-durations.json'), 'utf8'));
const plan = planShards(runnable, durationsMs, shard.count);
if (options['verify-receipts']) {
  const directory = options['verify-receipts'];
  const receipts = await Promise.all((await readdir(directory)).filter(name => name.endsWith('.json')).map(async name => JSON.parse(await readFile(path.join(directory, name), 'utf8'))));
  if (!process.env.GITHUB_SHA || !process.env.TZ) throw new Error('Receipt verification requires revision and timezone');
  const total = verifyShardReceipts(plan, receipts, { revision: process.env.GITHUB_SHA, timezone: process.env.TZ });
  console.log(`Verified all ${total} files exactly once across ${shard.count} successful shards (${process.env.TZ}).`);
  process.exit(0);
}
const selected = shard.count === 1 ? runnable : plan[shard.index - 1].files;
console.log(`Shard ${shard.index}/${shard.count}: ${selected.length} files, estimated ${(plan[shard.index - 1].estimatedMs / 60000).toFixed(1)} minutes.`);
// A receipt appears only after every selected file has completed successfully.
const receipt = { status: 'passed', revision: process.env.GITHUB_SHA || null, timezone: process.env.TZ || null, shard, inventoryDigest: inventoryDigest(runnable), files: [] };
let expectedFailureFiles = 0;
for (const file of selected) {
  const started = performance.now();
  const expected = EXPECTED_FAILURE_TESTS.get(file);
  if (expected) {
    runExpectedFailureFixture(file, expected);
    expectedFailureFiles += 1;
  } else {
    const args = SCRIPT_STYLE_TESTS.has(file) ? [file] : ['--test', file];
    console.log(`\n=== ${process.execPath} ${args.join(' ')} ===`);
    const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  receipt.files.push({ file, outcome: expected ? 'expected_failure_matched' : 'passed', durationMs: Math.round(performance.now() - started) });
}
if (options.receipt) {
  await mkdir(path.dirname(options.receipt), { recursive: true });
  await writeFile(options.receipt, JSON.stringify(receipt, null, 2) + '\n');
}
console.log(`\nPassed ${selected.length - expectedFailureFiles} test files; expected-failure fixtures ${expectedFailureFiles} (every fingerprint matched); quarantined ${QUARANTINED_TESTS.size}; on hold ${onHoldFiles.size}.`);
