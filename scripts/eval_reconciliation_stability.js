#!/usr/bin/env node
// Reconciliation reliability + split-metrics harness.
//
// The pass/fail eval (scripts/eval_reconciliation_matcher.js) answers
// "did the (id, status) set match?" in ONE shot. That bundles four very
// different questions and gives no run-to-run stability signal. This
// harness runs each fixture K times on the pinned model (same call path
// as the matcher eval) and reports:
//
//   SPLIT METRICS (the bundled pass/fail, unpacked):
//     - id-only candidate precision / recall  (target selection, status-agnostic)
//     - auto-match target precision           (of auto_matched proposals, fraction that
//                                               are a real expected target)
//     - false-auto-match rate                 (1 - auto-match target precision; the
//                                               dangerous one for UNATTENDED auto-match)
//     - suggestion recall                      (expected targets surfaced at ANY band)
//     - no-match accuracy                      (negative fixtures: correct abstention)
//     - authority-band accuracy                (where gold PINS a status: band agreement)
//
//   STABILITY (per fixture, across K runs):
//     - target-set agreement, status-pair agreement, confidence range,
//       latency range, malformed/provider-error count.
//
// Why: "confidence >= 0.85 => auto_matched" makes self-reported
// confidence the authorization layer. Before granting that authority
// unattended you want target precision AND auto-match precision AND
// run-to-run stability — not a single-shot pass rate. A case that passes
// once but selects three different targets across five runs is not
// production-ready.
//
// Usage:
//   ANTHROPIC_API_KEY=... RECONCILIATION_MATCHER_LLM_MODEL=claude-opus-4-8 \
//     node scripts/eval_reconciliation_stability.js --k=5 --print
//
// LLM-backed: costs real money (K * fixtures calls); NOT CI-safe. The
// pure metric/stability functions are unit-tested in
// scripts/eval_reconciliation_stability.test.js (no network).

import { loadFixtures } from '../server/donna/evalHarness.js';
import { proposeMatches as proposeAR } from '../server/donna/salesInvoiceReconciliationLlm.js';
import { proposeMatches as proposeAP } from '../server/donna/supplierBillReconciliationLlm.js';
import { authorizeMatch, getAutoMatchPolicy } from '../server/donna/reconciliationLlmCore.js';

const DEFAULT_AUTO_THRESHOLD = 0.85;

// ── Pure helpers (exported for tests) ──────────────────────────────

export const isBillFixture = (f) => f?.document?.document_type === 'supplier_bill';

export const expectedTargetIds = (expected) =>
  new Set((expected?.proposals || []).map((p) => p.bank_transaction_id).filter((x) => x != null).map(String));

// Map of expected id -> pinned status (only for proposals that pin one).
export const expectedPinnedStatus = (expected) => {
  const m = new Map();
  for (const p of expected?.proposals || []) {
    if (p?.bank_transaction_id != null && p.status != null && p.status !== '') {
      m.set(String(p.bank_transaction_id), p.status);
    }
  }
  return m;
};

export const isNegativeFixture = (expected) =>
  !expected?.proposals || expected.proposals.length === 0;

// One run's proposals: [{ bank_transaction_id, confidence, status }].
// Tally this run's contribution to the split metrics.
export const tallyRun = (expected, run, acc) => {
  const exp = expectedTargetIds(expected);
  const pinned = expectedPinnedStatus(expected);
  const negative = isNegativeFixture(expected);
  const proposals = run.proposals || [];
  const actualIds = new Set(proposals.map((p) => String(p.bank_transaction_id)));

  // id-only candidate precision/recall
  for (const id of actualIds) (exp.has(id) ? acc.idTP++ : acc.idFP++);
  for (const id of exp) if (!actualIds.has(id)) acc.idFN++;

  // auto-match target precision / false-auto-match
  for (const p of proposals) {
    if (p.status === 'auto_matched') {
      acc.autoTotal++;
      if (exp.has(String(p.bank_transaction_id))) acc.autoCorrect++;
    }
  }

  // suggestion recall — expected target surfaced at ANY band
  for (const id of exp) {
    acc.suggDenom++;
    if (actualIds.has(id)) acc.suggNum++;
  }

  // no-match accuracy — negative fixtures should abstain
  if (negative) {
    acc.negDenom++;
    if (proposals.length === 0) acc.negCorrect++;
  }

  // authority-band accuracy — only where gold pins a status
  for (const [id, band] of pinned) {
    acc.bandDenom++;
    const got = proposals.find((p) => String(p.bank_transaction_id) === id);
    if (got && got.status === band) acc.bandCorrect++;
  }
  return acc;
};

export const emptyAcc = () => ({
  idTP: 0, idFP: 0, idFN: 0,
  autoTotal: 0, autoCorrect: 0,
  suggNum: 0, suggDenom: 0,
  negCorrect: 0, negDenom: 0,
  bandCorrect: 0, bandDenom: 0
});

const ratio = (num, den) => (den === 0 ? null : num / den);

export const splitMetrics = (acc) => ({
  id_precision: ratio(acc.idTP, acc.idTP + acc.idFP),
  id_recall: ratio(acc.idTP, acc.idTP + acc.idFN),
  auto_match_target_precision: ratio(acc.autoCorrect, acc.autoTotal),
  false_auto_match_rate: acc.autoTotal === 0 ? null : 1 - acc.autoCorrect / acc.autoTotal,
  suggestion_recall: ratio(acc.suggNum, acc.suggDenom),
  no_match_accuracy: ratio(acc.negCorrect, acc.negDenom),
  authority_band_accuracy: ratio(acc.bandCorrect, acc.bandDenom),
  auto_match_count: acc.autoTotal,
  authority_pinned_count: acc.bandDenom
});

// Per-fixture stability across runs.
export const fixtureStability = (runs) => {
  const ok = runs.filter((r) => r.ok);
  const targetSig = (r) => [...new Set((r.proposals || []).map((p) => String(p.bank_transaction_id)))].sort().join('+') || '<none>';
  const statusSig = (r) => (r.proposals || []).map((p) => `${p.bank_transaction_id}|${p.status}`).sort().join(',') || '<none>';
  const confs = ok.flatMap((r) => (r.proposals || []).map((p) => p.confidence)).filter((x) => typeof x === 'number');
  const lats = runs.map((r) => r.ms).filter((x) => typeof x === 'number');
  return {
    runs: runs.length,
    errors: runs.length - ok.length,
    target_variants: new Set(ok.map(targetSig)).size,
    status_variants: new Set(ok.map(statusSig)).size,
    confidence_min: confs.length ? Math.min(...confs) : null,
    confidence_max: confs.length ? Math.max(...confs) : null,
    latency_min_ms: lats.length ? Math.min(...lats) : null,
    latency_max_ms: lats.length ? Math.max(...lats) : null
  };
};

// ── Live runner ────────────────────────────────────────────────────

// Forward BOTH money directions and reconciliation_status verbatim. The
// old harness zeroed the opposite side (AR→money_in, AP→money_out),
// which made refunds (opposite-direction lines) and already-settled /
// duplicate lines impossible to express. The prompt builders now render
// these additively, so the model sees the full candidate view the SQL
// optimization used to hide. (`forBill` is no longer needed here.)
const mapBankLines = (fixture) =>
  (fixture.candidate_bank_lines || []).map((l) => ({
    id: l.id,
    money_in: Number(l.money_in ?? 0),
    money_out: Number(l.money_out ?? 0),
    currency: l.currency,
    date: l.date,
    description: l.description,
    raw_description: l.raw_description,
    contact: l.contact || '',
    reconciliation_status: l.reconciliation_status ?? null
  }));

// Band the proposal lands in. POST-GATE (default): run authorizeMatch so
// the harness scores the AUTHORITY POLICY, not raw confidence — fixture
// 012 should drop to 'suggested' (below the 0.90 floor) while the 009/013
// decoys still 'auto_matched'. RAW (--raw): the legacy
// `confidence >= threshold` mapping, kept for before/after comparison.
const bandFor = (p, { raw, threshold, allProposals, bankLine, candidateBankLines, document, forBill, policy }) => {
  if (raw) return p.confidence >= threshold ? 'auto_matched' : 'suggested';
  const matchAmount = forBill ? Number(bankLine?.money_out || 0) : Number(bankLine?.money_in || 0);
  return authorizeMatch({
    proposal: p,
    allProposals,
    bankLine,
    candidateBankLines,
    document,
    matchAmount,
    policy
  }).band;
};

const runOnce = async (fixture, { apiKey, model, threshold, raw, policy }) => {
  const forBill = isBillFixture(fixture);
  const propose = forBill ? proposeAP : proposeAR;
  const candidateBankLines = mapBankLines(fixture);
  const byId = new Map(candidateBankLines.map((l) => [String(l.id), l]));
  const t0 = Date.now();
  try {
    const r = await propose({ document: fixture.document, candidateBankLines, firmContext: fixture.firm_context || null, apiKey, model });
    return {
      ok: true,
      ms: Date.now() - t0,
      unmatchable_reason: r.unmatchable_reason || null,
      proposals: (r.proposals || []).map((p) => ({
        bank_transaction_id: p.bank_transaction_id,
        confidence: p.confidence,
        status: bandFor(p, {
          raw,
          threshold,
          allProposals: r.proposals,
          bankLine: byId.get(String(p.bank_transaction_id)),
          candidateBankLines,
          document: fixture.document,
          forBill,
          policy
        })
      }))
    };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: e?.message || String(e), proposals: [] };
  }
};

const parseArgs = (argv) => {
  const out = { k: 5, filter: null, raw: false };
  for (const t of argv) {
    if (t.startsWith('--k=')) out.k = Number(t.slice('--k='.length)) || 5;
    else if (t.startsWith('--filter=')) out.filter = t.slice('--filter='.length);
    else if (t === '--raw') out.raw = true;
  }
  return out;
};

const fmt = (x) => (x == null ? 'n/a' : x.toFixed(3));

const main = async () => {
  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set — cannot run the stability harness');
  const model = process.env.RECONCILIATION_MATCHER_LLM_MODEL || 'claude-opus-4-8';
  const threshold = Number(process.env.RECONCILIATION_LLM_AUTO_THRESHOLD) || DEFAULT_AUTO_THRESHOLD;
  const { k, filter, raw } = parseArgs(process.argv.slice(2));
  // Score the AUTHORITY POLICY by default (force-enabled so the gates run
  // even when the prod flag is off); --raw falls back to the legacy
  // confidence>=threshold band for before/after comparison. clientAllowlist
  // is forced null: the harness scores gates A–E over synthetic fixtures
  // (no real client id), so a RECONCILIATION_AUTO_MATCH_CLIENTS set on the
  // box must NOT fail-close every fixture to 'suggested'.
  const policy = { ...getAutoMatchPolicy(), enabled: true, clientAllowlist: null };
  let fixtures = loadFixtures('reconciliation');
  if (filter) {
    const terms = filter.split(',').map((s) => s.trim()).filter(Boolean);
    fixtures = fixtures.filter((f) => terms.some((t) => f.id.includes(t)));
  }

  const bandMode = raw
    ? `raw(confidence>=${threshold})`
    : `policy(floor=${policy.floor} sep=${policy.separation} ceiling=${Number.isFinite(policy.materialityCeiling) ? policy.materialityCeiling : 'none'})`;
  console.log(`model=${model} band=${bandMode} K=${k} fixtures=${fixtures.length}\n`);
  const acc = emptyAcc();
  for (const f of fixtures) {
    const runs = await Promise.all(Array.from({ length: k }, () => runOnce(f, { apiKey, model, threshold, raw, policy })));
    for (const r of runs) if (r.ok) tallyRun(f.expected || {}, r, acc);
    const s = fixtureStability(runs);
    const expStr = (f.expected?.proposals || []).map((p) => `${p.bank_transaction_id}${p.status ? '|' + p.status : ''}`).join(', ')
      || `unmatchable(${f.expected?.unmatchable_reason || 'null'})`;
    console.log(`■ ${f.id}  [${(f.tags || []).join(',')}]`);
    console.log(`   expected: ${expStr}`);
    console.log(`   targets stable: ${s.target_variants === 1 ? 'YES' : 'NO (' + s.target_variants + ' variants)'}` +
      ` | bands stable: ${s.status_variants === 1 ? 'YES' : 'NO (' + s.status_variants + ')'}` +
      ` | conf ${s.confidence_min ?? 'n/a'}-${s.confidence_max ?? 'n/a'}` +
      ` | latency ${s.latency_min_ms}-${s.latency_max_ms}ms | errors ${s.errors}\n`);
  }
  const m = splitMetrics(acc);
  console.log('── SPLIT METRICS (aggregate over all runs) ──');
  console.log(`  id-only candidate precision : ${fmt(m.id_precision)}`);
  console.log(`  id-only candidate recall    : ${fmt(m.id_recall)}`);
  console.log(`  suggestion recall (any band): ${fmt(m.suggestion_recall)}`);
  console.log(`  auto-match target precision : ${fmt(m.auto_match_target_precision)}   (${m.auto_match_count} auto_matched proposals)`);
  console.log(`  FALSE-auto-match rate       : ${fmt(m.false_auto_match_rate)}   <- the unattended-authority risk`);
  console.log(`  no-match accuracy           : ${fmt(m.no_match_accuracy)}`);
  console.log(`  authority-band accuracy     : ${fmt(m.authority_band_accuracy)}   (${m.authority_pinned_count} gold-pinned targets)`);
};

// Only run main when invoked directly (not when imported by the test).
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('eval_reconciliation_stability.js');
if (invokedDirectly) {
  main().catch((e) => { console.error(e?.stack || e); process.exit(1); });
}
