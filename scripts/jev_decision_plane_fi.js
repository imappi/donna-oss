// FIK-3 — the Finnish coding lane of the Jev decision-plane harness (offline
// research only; plan: docs/plan-2026-09-22-fi-jev-decision-knowledge.md §7,
// §8.6). Pure functions: the frozen corpus and its split, the frozen labels,
// the pre-registration, the one-shot holdout ledger and the operational-
// consequence scorer over what the REAL coder and writer did on a disposable
// book (`jev_decision_plane_fi_run.js`). The spend ledger, reservation,
// resume, replay and checkpoints stay the runner's own (`jev_decision_plane.js`).
// Nothing here is writer authority or a production terminal.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadFixtures } from '../server/donna/evalHarness.js';
import { hash } from '../server/donna/jevEvidenceContract.js';
import { FI_GUIDANCE_VARIANT, FI_PROVISIONAL_GUIDANCE_VARIANT, validateFiProvisionalGuidanceEntries } from '../server/donna/finland/decisionGuidance.js';
import { ALV_CODES as FI_ALV_CODES } from '../server/donna/finland/alvCodes.js';
import { ROOT, CONSEQUENCES, ERROR_CLASSES, ATTRIBUTED_TO, CONFIDENCE_BANDS, bandOf, usdFor, priceFor, estimateTokens, TYPESAFE_OUTPUT_PER_QUESTION } from './jev_decision_plane_protocol.js';

export const FI_VERSION = 'jev-decision-plane-fi-coding-v1';
export const FI_LANE = 'fi-coding';
export const FI_CORPUS = 'fik3-fi-coding';
export const FI_SPLITS = Object.freeze(['development', 'holdout']);
// The two holdout arms differ ONLY in the policy variant handed to the FIK-2
// resolver: A is the authored v7 guidance (variant null), D the reviewed v8
// replacement (variant 'reviewed'). The strong comparator is the ordinary
// strong coder on the same book (Jev off), run only where the case says that
// route is a real alternative; it keeps today's authored policy.
export const FI_ARMS = Object.freeze(['fi_v7', 'fi_v8']);
export const FI_COMPARATOR_ARM = 'fi_strong';
// The provisional DEVELOPMENT arm (plan §8.8): v7 with unreviewed draft
// entries replacing the clauses they cover, so a draft can be measured before
// a reviewer exists. Never a holdout arm and never a pre-registered candidate;
// its entries come only from an explicit --provisional file frozen in the plan.
export const FI_PROVISIONAL_ARM = 'fi_v8p';
export const FI_ALL_ARMS = Object.freeze([...FI_ARMS, FI_COMPARATOR_ARM, FI_PROVISIONAL_ARM]);
export const ARM_SPEC = Object.freeze({
  fi_v7: Object.freeze({ label: 'A', guidanceVariant: null, engine: 'jev' }),
  fi_v8: Object.freeze({ label: 'D', guidanceVariant: FI_GUIDANCE_VARIANT, engine: 'jev' }),
  fi_strong: Object.freeze({ label: 'strong_comparator', guidanceVariant: null, engine: 'strong' }),
  fi_v8p: Object.freeze({ label: 'P', guidanceVariant: FI_PROVISIONAL_GUIDANCE_VARIANT, engine: 'jev' })
});
// The frozen plan binds these bytes: the runner and scorer, and every server
// module that shapes the request, the decision, the admission or the writer.
export const FI_CODE_FILES = Object.freeze(['scripts/jev_decision_plane.js', 'scripts/jev_decision_plane_protocol.js', 'scripts/jev_decision_plane_fi.js',
  'scripts/jev_decision_plane_fi_run.js', 'server/donna/evalHarness.js', 'server/donna/providerTransport.js', 'server/donna/transactionLlm.js', 'server/donna/jevCoding.js',
  'server/donna/jevProvider.js', 'server/donna/jevTrialProvider.js', 'server/donna/codingPolicy.js', 'server/donna/codingGuidanceVariant.js',
  'server/donna/finland/decisionGuidance.js', 'server/donna/finland/codingPolicy.js', 'server/donna/finland/alvCodes.js', 'server/donna/finland/postingPolicy.js',
  'server/donna/postingPolicy.js', 'server/donna/db/coding.js', 'server/donna/firmFacts.js', 'server/donna/codingAutoPost.js', 'server/donna/reconcileConvergenceState.js']);
export const fiCodeHashes = () => Object.fromEntries(FI_CODE_FILES.map(f => [f, hash(readFileSync(resolve(ROOT, f), 'utf8'))]));
export const loadFiCorpus = (name = FI_CORPUS) => loadFixtures(name, { root: resolve(ROOT, 'data/evals/fixtures') });
export const fiCorpusDigest = fixtures => hash(fixtures.map(({ __file, ...f }) => f));

const fail = code => { throw new Error(code); };
const str = v => typeof v === 'string' && v.trim().length > 0;
const iso = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const money = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const hex64 = v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

// ── Provisional guidance (development only) ─────────────────────────────────
// Loaded only from an explicit path. The plan records the file digest, every
// entry whole, and per entry its id, covers, claim-text digest and status; the
// live run renders the frozen entries, never the file again.
export function provisionalRecord(entries, fileSha256) {
  validateFiProvisionalGuidanceEntries(entries);
  return { status: FI_PROVISIONAL_GUIDANCE_VARIANT, file_sha256: fileSha256, entries_sha256: hash(entries), entries: structuredClone(entries),
    index: entries.map(e => ({ id: e.id, covers: [...e.covers], status: e.status, text_sha256: hash(e.claim) })) };
}
export function loadFiProvisionalGuidance(path) {
  const text = readFileSync(path, 'utf8');
  const file = JSON.parse(text);
  if (!file || typeof file !== 'object' || !Array.isArray(file.entries)) fail('invalid_provisional_guidance_file');
  return provisionalRecord(file.entries, hash(text));
}
function verifyProvisionalRecord(record) {
  if (!record || record.status !== FI_PROVISIONAL_GUIDANCE_VARIANT || !hex64(record.file_sha256) || hash(record.entries) !== record.entries_sha256
    || hash(provisionalRecord(record.entries, record.file_sha256)) !== hash(record)) fail('provisional_guidance_record_mismatch');
}

// ── Frozen labels ───────────────────────────────────────────────────────────
// A label is the consequence, not an account name: the terminal the line must
// reach (a posted journal, or an owner ask of a named evidence type), the
// complete journal including its tax legs and ALV codes, any reconciliation
// it may create, and — for adversarial sentinels — what must never post and
// which existing writer refusal must fire if it is tried. The original label
// is never edited; an adjudication adds the adjudicated label beside it.
export const GOLD_TERMINALS = Object.freeze(['posted', 'ask_owner']);
export const LABEL_STATUSES = Object.freeze(['agreed', 'adjudicated', 'disputed']);
const LINE_KEYS = ['role', 'account', 'direction', 'amount', 'tax_code'];
function validGold(g) {
  if (!g || typeof g !== 'object' || !GOLD_TERMINALS.includes(g.terminal)) return false;
  if (!Array.isArray(g.journal) || (g.terminal === 'posted') !== (g.journal.length > 0)) return false;
  for (const l of g.journal) if (!l || !str(l.role) || !str(l.account) || !['debit', 'credit'].includes(l.direction) || !money(l.amount) || !str(l.tax_code)
    || Object.keys(l).some(k => !LINE_KEYS.includes(k))) return false;
  if ((g.terminal === 'ask_owner') !== Boolean(g.ask)) return false;
  if (g.ask && (!str(g.ask.evidence_type) || (g.ask.kind !== undefined && !/^ask_[a-z_]+$/.test(g.ask.kind)) || Object.keys(g.ask).some(k => !['evidence_type', 'kind'].includes(k)))) return false;
  if (g.reconciliation !== undefined && !(Array.isArray(g.reconciliation) && g.reconciliation.every(str))) return false;
  if (g.handoff_expected !== undefined && typeof g.handoff_expected !== 'boolean') return false;
  if (g.forbidden !== undefined && !(g.forbidden && [g.forbidden.tax_codes, g.forbidden.tax_treatments].every(xs => Array.isArray(xs) && xs.length && xs.every(str))
    && (g.forbidden.refusal_code === undefined || str(g.forbidden.refusal_code)))) return false;
  return true;
}
const validFact = f => f && ['client', 'merchant', 'firm', 'jurisdiction'].includes(f.scope) && str(f.subject) && str(f.fact)
  && (f.asserted_by === undefined || (Array.isArray(f.asserted_by) && f.asserted_by.every(str))) && (f.entity === undefined || str(f.entity));
export function validateFiCase(f) {
  const bad = why => fail(`invalid_fi_case:${f?.id ?? '?'}:${why}`);
  if (!str(f?.id) || !FI_SPLITS.includes(f.split)) bad('id_or_split');
  if (!str(f.family) || !str(f.entity) || !/^\d{4}-\d{2}$/.test(f.period ?? '') || !str(f.decision_class) || typeof f.strong_is_alternative !== 'boolean') bad('design_axes');
  if (!f.book || !['fi-oy', 'toiminimi'].includes(f.book.entity_type) || !str(f.book.company_name)) bad('book');
  if (f.sibling_entities !== undefined && !(Array.isArray(f.sibling_entities) && f.sibling_entities.every(str))) bad('siblings');
  const t = f.transaction;
  if (!t || !iso(t.date) || !str(t.description) || !money(t.money_in) || !money(t.money_out) || (t.money_in > 0) === (t.money_out > 0) || t.currency !== 'EUR') bad('transaction');
  if (t.date.slice(0, 7) !== f.period) bad('period_is_not_the_business_month');
  const d = f.document;
  if (d !== null && (!d || !['supplier_bill', 'sales_invoice', 'receipt'].includes(d.document_type) || !money(d.total_amount) || !money(d.tax_amount) || !Array.isArray(d.lines) || !d.lines.length
    || d.lines.some(l => !str(l.description) || !money(l.amount) || !(l.tax_rate === null || money(l.tax_rate))) || !['auto_matched', 'confirmed', 'suggested'].includes(d.match_status))) bad('document');
  if (!Array.isArray(f.facts) || !f.facts.every(validFact)) bad('facts');
  const L = f.labels;
  if (!L || !validGold(L.original) || !(L.adjudicated === null || validGold(L.adjudicated)) || !LABEL_STATUSES.includes(L.adjudication?.status)) bad('labels');
  if ((L.adjudication.status === 'adjudicated') !== (L.adjudicated !== null)) bad('adjudication_status');
  if (L.adjudication.status === 'adjudicated' && (!str(L.adjudication.reviewer) || !iso(L.adjudication.date))) bad('adjudication_receipt');
  const e = f.expressible;
  if (!e || !(e.status === 'expressible' || (e.status === 'gap' && ['vocabulary', 'source'].includes(e.gap) && str(e.detail)))) bad('expressible');
  return f;
}
// The gold a run is scored against: the adjudicated label when there is one,
// else the original; a disputed label has no gold (excluded, and reported).
export const goldOf = planCase => planCase.labels.adjudication.status === 'disputed' ? null : (planCase.labels.adjudicated ?? planCase.labels.original);

// ── The split: whole families, entities and periods ─────────────────────────
// A holdout case may not share a case family, a legal entity (its own or a
// sibling entity it names) or a business month with any development case.
const entitiesOf = c => [c.entity, ...(c.sibling_entities || [])];
export function checkSplit(cases) {
  const dev = cases.filter(c => c.split === 'development'), hold = cases.filter(c => c.split === 'holdout');
  for (const [axis, of] of [['family', c => [c.family]], ['entity', entitiesOf], ['period', c => [c.period]]]) {
    const seen = new Set(dev.flatMap(of));
    const shared = [...new Set(hold.flatMap(of).filter(v => seen.has(v)))].sort();
    if (shared.length) fail(`split_leakage:${axis}:${shared.join(',')}`);
  }
  return true;
}

// ── Pre-registration (recorded BEFORE any holdout answer exists) ────────────
// Numeric targets for D against A, written after the read-only development
// baseline. The safety gate is not a target and cannot be loosened: no new
// material wrong autonomous action, and every existing refusal still fires.
export const PREREG_VERSION = 'fik3-preregistration-v1';
export const TARGETS = Object.freeze({
  min_correct_complete_delta: 'D − A correct complete outcomes on the holdout (count, ≥)',
  max_avoidable_interruption_delta: 'D − A avoidable owner interruptions (count, ≤)',
  max_strong_handoff_delta: 'D − A strong handoffs (count, ≤)',
  max_p95_latency_ratio: 'D ÷ A p95 end-to-end latency (≤)',
  max_usd_ratio: 'D ÷ A actual money (≤; not evaluable when A spent nothing)',
  max_input_token_ratio: 'D ÷ A input tokens (≤)'
});
export function verifyPreregistration(p, { corpus = FI_CORPUS, corpusSha256 } = {}) {
  const bad = why => fail(`invalid_preregistration:${why}`);
  if (!p || p.version !== PREREG_VERSION) bad('version');
  if (!str(p.recorded_by) || !Number.isFinite(Date.parse(p.recorded_at))) bad('recorded');
  if (p.corpus !== corpus || p.corpus_sha256 !== corpusSha256) bad('corpus');
  if (!hex64(p.baseline?.development_summary_sha256) || !hex64(p.baseline?.development_plan_sha256)) bad('baseline');
  if ([p.comparison?.baseline, p.comparison?.candidate].includes(FI_PROVISIONAL_ARM)) bad('provisional_arm_not_allowed');
  if (p.comparison?.baseline !== 'fi_v7' || p.comparison?.candidate !== 'fi_v8') bad('comparison');
  if (p.safety_gate?.max_new_material_wrong_autonomous_actions !== 0 || p.safety_gate?.existing_refusals_must_fire !== true
    || Object.keys(p.safety_gate).length !== 2) bad('safety_gate');
  const keys = Object.keys(p.targets || {});
  if (keys.length !== Object.keys(TARGETS).length || keys.some(k => !(k in TARGETS) || typeof p.targets[k] !== 'number' || !Number.isFinite(p.targets[k]))) bad('targets');
  const allowed = ['version', 'recorded_by', 'recorded_at', 'corpus', 'corpus_sha256', 'baseline', 'comparison', 'safety_gate', 'targets', 'notes'];
  if (Object.keys(p).some(k => !allowed.includes(k)) || (p.notes !== undefined && typeof p.notes !== 'string')) bad('keys');
  return structuredClone(p);
}
// The development baseline the targets were written from: a complete public
// summary of THIS lane, development only, whose digest the pre-registration names.
export function verifyBaselineSummary(summary, prereg) {
  if (hash(summary) !== prereg.baseline.development_summary_sha256 || summary?.plan_sha256 !== prereg.baseline.development_plan_sha256) fail('baseline_summary_mismatch');
  if (summary.version !== FI_VERSION || summary.completion !== 'complete' || !Array.isArray(summary.outcomes) || !summary.outcomes.length
    || summary.outcomes.some(o => o.split !== 'development')) fail('baseline_not_development');
  return true;
}

// ── One-shot holdout ledger ─────────────────────────────────────────────────
// A holdout case id is read under ONE frozen plan, ever: the first live run
// records the read before its first request, an interrupted run resumes under
// the same plan, a replay re-reads only what that plan recorded, and any other
// plan naming the case is refused. Keyed by corpus name and case id, so an
// edited corpus cannot re-open a consumed case under the same id.
export const HOLDOUT_LEDGER_VERSION = 'fik3-holdout-ledger-v1';
export const emptyHoldoutLedger = () => ({ version: HOLDOUT_LEDGER_VERSION, reads: [] });
const verifyLedger = l => { if (l?.version !== HOLDOUT_LEDGER_VERSION || !Array.isArray(l.reads)) fail('invalid_holdout_ledger'); return l; };
const holdoutIds = plan => plan.cases.filter(c => c.split === 'holdout').map(c => c.id);
export function assertHoldoutUnread(ledger, corpus, caseIds) {
  const read = verifyLedger(ledger).reads.filter(r => r.corpus === corpus && caseIds.includes(r.case_id)).map(r => r.case_id);
  if (read.length) fail(`holdout_already_read:${[...new Set(read)].sort().join(',')}`);
}
export function consumeHoldout(ledger, plan, { at, resuming = false }) {
  const ids = holdoutIds(plan);
  verifyLedger(ledger);
  if (!ids.length) return ledger;
  // Only the interrupted run itself may continue under the same plan; a fresh
  // run of an already-read plan would be a second look at new answers.
  const other = ledger.reads.filter(r => r.corpus === plan.corpus && ids.includes(r.case_id) && (r.plan_sha256 !== plan.plan_sha256 || !resuming)).map(r => r.case_id);
  if (other.length) fail(`holdout_already_read:${[...new Set(other)].sort().join(',')}`);
  if (resuming && ids.some(id => !ledger.reads.some(r => r.corpus === plan.corpus && r.case_id === id))) fail('holdout_resume_without_read');
  const fresh = ids.filter(id => !ledger.reads.some(r => r.corpus === plan.corpus && r.case_id === id));
  return { ...ledger, reads: [...ledger.reads, ...fresh.map(case_id => ({ corpus: plan.corpus, case_id, plan_sha256: plan.plan_sha256, read_at: at }))] };
}
export function assertHoldoutReadBy(ledger, plan) {
  const ids = holdoutIds(plan);
  if (ids.some(id => !verifyLedger(ledger).reads.some(r => r.corpus === plan.corpus && r.case_id === id && r.plan_sha256 === plan.plan_sha256))) fail('holdout_read_not_recorded');
}

// ── Plan verification ───────────────────────────────────────────────────────
export function verifyFiPlan(plan) {
  const { plan_sha256, ...body } = plan;
  if (plan.version !== FI_VERSION || plan.lane !== FI_LANE || hash(body) !== plan_sha256 || hash(plan.code_hashes) !== hash(fiCodeHashes())
      || plan.corpus_sha256 !== fiCorpusDigest(loadFiCorpus(plan.corpus)) || new Set(plan.jobs.map(j => j.id)).size !== plan.jobs.length
      || plan.jobs.some(j => hash(j.request) !== j.request_sha256)) fail('frozen_plan_mismatch');
  // The provisional arm is development-only and exists only with its frozen entries.
  const provisional = plan.arms.includes(FI_PROVISIONAL_ARM);
  if (provisional || plan.jobs.some(j => j.arm === FI_PROVISIONAL_ARM) || plan.provisional_guidance !== undefined) {
    if (plan.cases.some(c => c.split === 'holdout')) fail('provisional_arm_not_allowed_on_holdout');
    if (!provisional) fail('frozen_plan_mismatch');
    verifyProvisionalRecord(plan.provisional_guidance);
  }
  // A holdout plan exists only under a pre-registration bound into its digest.
  if (plan.cases.some(c => c.split === 'holdout')) {
    if (!plan.preregistration || hash(plan.preregistration) !== plan.preregistration_sha256) fail('preregistration_required');
    verifyPreregistration(plan.preregistration, { corpus: plan.corpus, corpusSha256: plan.corpus_sha256 });
  }
  return true;
}

// ── Arms differ only in the policy ──────────────────────────────────────────
// The two captured first requests must be byte-identical once each arm's own
// rendered policy text is replaced by one placeholder, and the two policy
// receipts must differ only in the FIK-2 variant keys. Anything else (a fact
// admitted on one arm, a menu or source difference) refuses the plan.
export const POLICY_PLACEHOLDER = '\u0000fik3-policy\u0000';
export function policyNeutral(request, taxInstructions) {
  const policy = request?.state?.accounting_policy;
  if (typeof policy !== 'string' || !str(taxInstructions) || policy.split(taxInstructions).length !== 2) fail('policy_text_not_located');
  return { ...request, state: { ...request.state, accounting_policy: policy.replace(taxInstructions, POLICY_PLACEHOLDER) } };
}
const withoutVariant = receipt => { const { guidanceVariant, guidanceDigest, ...rest } = receipt || {}; return rest; };
// With the provisional arm present, A vs P and D vs P are held to the same rule.
export function assertArmsDifferOnlyInPolicy(caseId, captured) {
  const arms = [...FI_ARMS, ...(captured[FI_PROVISIONAL_ARM] ? [FI_PROVISIONAL_ARM] : [])];
  const [a, d] = FI_ARMS.map(arm => captured[arm]);
  if (!a || !d) fail(`arms_differ_beyond_policy:${caseId}:capture_missing`);
  for (const arm of arms.slice(1)) {
    const x = captured[arm], suffix = arm === 'fi_v8' ? '' : `:${arm}`;
    if (hash(policyNeutral(a.request, a.policy.taxInstructions)) !== hash(policyNeutral(x.request, x.policy.taxInstructions))) fail(`arms_differ_beyond_policy:${caseId}:request${suffix}`);
    if (hash(withoutVariant(a.policy.receipt)) !== hash(withoutVariant(x.policy.receipt))) fail(`arms_differ_beyond_policy:${caseId}:receipt${suffix}`);
    if (hash(a.delivered_facts) !== hash(x.delivered_facts)) fail(`arms_differ_beyond_policy:${caseId}:facts${suffix}`);
  }
  for (const arm of arms) if ((captured[arm].policy.receipt.guidanceVariant ?? null) !== ARM_SPEC[arm].guidanceVariant) fail(`arm_variant_not_selected:${caseId}:${arm}`);
  const p = captured[FI_PROVISIONAL_ARM];
  return { common_request_sha256: hash(policyNeutral(a.request, a.policy.taxInstructions)), policy_text_identical: a.policy.taxInstructions === d.policy.taxInstructions,
    ...(p ? { provisional_text_identical: a.policy.taxInstructions === p.policy.taxInstructions } : {}) };
}

// ── Estimates for the shared spend ledger ───────────────────────────────────
// The strong coder's OpenAI request carries no output ceiling; the estimate
// reserves a fixed allowance and the ledger reconciles to actual usage after.
export const OPENAI_OUTPUT_ESTIMATE = 8192;
export function estimateFiRequest(request, provider) {
  const input = estimateTokens(JSON.stringify(request));
  if (provider === 'typesafe') return { input_tokens: input, output_tokens: TYPESAFE_OUTPUT_PER_QUESTION * Object.keys(request.questions || {}).length };
  if (provider === 'openai') return { input_tokens: input, output_tokens: Number.isSafeInteger(request.max_output_tokens) ? request.max_output_tokens : OPENAI_OUTPUT_ESTIMATE };
  fail('unknown_provider');
}
// Every model the lane may pay for must be priced by name (the strong coder is
// neither of the runner's two provider rates).
export function verifyFiBudget(bounds, plan) {
  for (const model of [plan.models.jev, plan.models.strong]) if (!bounds.prices.models?.[model]) fail('invalid_budget');
}

// ── The operational consequence of one arm on one case ──────────────────────
// Read from the snapshot of the disposable book AFTER the real coder, the
// auto-post writer and the ask sweep ran: never from the model's label choice.
const OPEN_ASK = ['draft', 'open'];
const cents = n => Math.round(Number(n) * 100);
const lineKey = l => `${l.role}|${l.account}|${l.direction}|${cents(l.amount)}|${l.tax_code}`;
const boxesOf = code => FI_ALV_CODES.find(c => c.code === code)?.return_boxes ?? null;
export const alvBoxes = lines => [...new Set(lines.filter(l => l.tax_code && l.tax_code !== 'NONE')
  .flatMap(l => Object.entries(boxesOf(l.tax_code) || {}).map(([k, v]) => `${k}:${v}`)))].sort();
const TAX_ROLES = /^alv_|tax/;
export function journalDifferences(actual, gold) {
  const a = actual.map(lineKey).sort(), g = gold.map(lineKey).sort();
  if (hash(a) === hash(g)) return [];
  const diffs = new Set();
  const byRole = (ls, pred) => ls.filter(l => pred(l.role)).map(lineKey).sort();
  if (hash(byRole(actual, r => TAX_ROLES.test(r))) !== hash(byRole(gold, r => TAX_ROLES.test(r)))) diffs.add('tax_leg');
  if (hash(actual.map(l => l.tax_code).filter(c => c && c !== 'NONE').sort()) !== hash(gold.map(l => l.tax_code).filter(c => c && c !== 'NONE').sort())) diffs.add('alv_code');
  if (hash(alvBoxes(actual)) !== hash(alvBoxes(gold))) diffs.add('alv_box');
  if (hash(byRole(actual, r => !TAX_ROLES.test(r)).map(k => k.split('|').slice(0, 2).join('|'))) !== hash(byRole(gold, r => !TAX_ROLES.test(r)).map(k => k.split('|').slice(0, 2).join('|')))) diffs.add('account');
  if (hash(actual.map(l => `${l.direction}|${cents(l.amount)}`).sort()) !== hash(gold.map(l => `${l.direction}|${cents(l.amount)}`).sort())) diffs.add('amount');
  if (!diffs.size) diffs.add('line');
  return [...diffs].sort();
}
// Why an avoidable interruption happened. A fact/document ask claims a fact is
// missing; an unresolved tax becoming an ask, or a reasoning handoff, is a
// judgment the arm did not finish; a vocabulary handoff is a menu gap.
const FACT_ASKS = /^ask_(?!tax)/;
export function interruptionClass(snapshot, kind) {
  const d = snapshot.decision || {};
  if (kind === 'handoff') return d.handoff_cause === 'vocabulary_gap' ? 'vocabulary_gap' : 'unresolved_judgment';
  if (d.tax_unresolved || d.posting_requirement === 'document_discrepancy' && !FACT_ASKS.test(d.selected || '')) return 'unresolved_judgment';
  return 'missing_fact';
}
export function actualTerminal(snapshot) {
  if (snapshot.provider_failure) return 'failed';
  if (snapshot.journals.some(j => j.status === 'posted')) return 'posted';
  if (snapshot.asks.some(a => OPEN_ASK.includes(a.status))) return 'ask_owner';
  return 'unresolved';
}
const CONSEQUENCE_OF = { posted: 'RESOLVED_AUTONOMOUSLY', ask_owner: 'ASK_OWNER', failed: 'BLOCK', unresolved: 'BLOCK' };
export function scoreFiOutcome(planCase, snapshot) {
  const gold = goldOf(planCase);
  const terminal = actualTerminal(snapshot);
  const posted = snapshot.journals.filter(j => j.status === 'posted');
  const lines = posted.flatMap(j => j.lines);
  const asks = snapshot.asks.filter(a => OPEN_ASK.includes(a.status));
  const expressible = planCase.expressible.status === 'expressible';
  const out = { terminal, consequence: CONSEQUENCE_OF[terminal], label: gold ? CONSEQUENCE_OF[gold.terminal] : null, gold_scored: Boolean(gold) && expressible,
    excluded_from_gold: !gold ? 'disputed_label' : !expressible ? `gap:${planCase.expressible.gap}` : null,
    journal_differences: [], material_wrong_autonomous_action: false, material_kinds: [], wrong_owner_ask: false, missing_owner_ask: false, avoidable_interruption: null,
    avoidable_handoff: null, strong_handoff: Boolean(snapshot.decision?.strong_handoff), duplicate_journals: Math.max(0, posted.length - 1),
    false_reconciliations: 0, terminal_state: snapshot.convergence?.state ?? null, terminal_reached: ['auto_reconciled', 'on_owner'].includes(snapshot.convergence?.state),
    convergence_drift: Boolean(snapshot.convergence?.drift), refusal: null, correct_complete: false };
  if (!gold) return out;
  const material = kind => { out.material_wrong_autonomous_action = true; if (!out.material_kinds.includes(kind)) out.material_kinds.push(kind); };
  if (terminal === 'posted') {
    if (gold.terminal !== 'posted') material('posted_where_label_asks');
    else { out.journal_differences = journalDifferences(lines, gold.journal); if (out.journal_differences.length) material(out.journal_differences.some(d => d.startsWith('alv') || d === 'tax_leg') ? 'tax' : 'journal'); }
  }
  if (out.duplicate_journals) material('duplicate_journal');
  const matched = (snapshot.reconciliation || []).filter(m => ['auto_matched', 'confirmed'].includes(m.status) && !m.seeded);
  out.false_reconciliations = matched.filter(m => !(gold.reconciliation || []).includes(m.matched_object_id)).length;
  if (out.false_reconciliations) material('false_reconciliation');
  const forbidden = gold.forbidden;
  if (forbidden) {
    // A sentinel: the forbidden treatment must never post, and where an existing
    // writer refusal covers it, that refusal must fire when an arm tries it.
    const tried = forbidden.tax_treatments.includes(snapshot.decision?.tax_treatment);
    if (lines.some(l => forbidden.tax_codes.includes(l.tax_code))) material('forbidden_code_posted');
    const expected = forbidden.refusal_code ?? null;
    out.refusal = { expected, tried, fired: tried && expected ? snapshot.refusal === expected : null, missing: Boolean(tried && expected && snapshot.refusal !== expected) };
  }
  if (gold.terminal === 'ask_owner') {
    if (terminal !== 'ask_owner') out.missing_owner_ask = true;
    // The drafted request's type, and — when the label names it and the arm is
    // Jev — the precise owner question selected (several share one type).
    else if (!asks.some(a => a.evidence_type === gold.ask.evidence_type)
      || (gold.ask.kind && /^ask_/.test(snapshot.decision?.selected || '') && snapshot.decision.selected !== gold.ask.kind)) out.wrong_owner_ask = true;
  } else if (terminal === 'ask_owner') out.avoidable_interruption = interruptionClass(snapshot, 'ask');
  if (out.strong_handoff && !gold.handoff_expected) out.avoidable_handoff = interruptionClass(snapshot, 'handoff');
  out.correct_complete = out.gold_scored && !out.material_wrong_autonomous_action && terminal === gold.terminal && out.terminal_reached
    && !out.wrong_owner_ask && !out.missing_owner_ask && !(out.refusal?.missing);
  return out;
}

// Mechanical attribution onto the harness's existing classes. The writer or a
// label gap deciding it is the contract's; an ask the policy routed on is the
// routing policy's; a model choice is the model's.
export function attributeFiError(planCase, snapshot, score) {
  if (score.correct_complete || !goldOf(planCase)) return null;
  if (!score.gold_scored) return { class: planCase.expressible.gap === 'vocabulary' ? 'accounting_policy_interpretation' : 'missing_evidence', basis: `representation:${planCase.expressible.gap}`, attributed_to: 'contract_rule' };
  if (score.terminal === 'failed') return { class: 'other', basis: `provider_failure:${snapshot.provider_failure}`, attributed_to: 'contract_rule' };
  if (score.refusal?.missing) return { class: 'tax_interpretation', basis: 'refusal_missing', attributed_to: 'contract_rule' };
  if (score.duplicate_journals) return { class: 'duplicate_reversal_handling', basis: 'duplicate_journal', attributed_to: 'contract_rule' };
  if (score.material_kinds.includes('tax') || score.material_kinds.includes('forbidden_code_posted')) return { class: 'tax_interpretation', basis: `journal:${score.journal_differences.join('+') || 'forbidden_code'}`, attributed_to: 'model' };
  if (score.material_kinds.includes('journal')) return { class: score.journal_differences.includes('amount') ? 'amount_selection' : 'accounting_policy_interpretation', basis: `journal:${score.journal_differences.join('+')}`, attributed_to: 'model' };
  if (score.material_kinds.includes('posted_where_label_asks')) return { class: 'owner_intent', basis: 'posted_where_label_asks', attributed_to: 'model' };
  if (score.missing_owner_ask || score.wrong_owner_ask) return { class: 'owner_intent', basis: score.missing_owner_ask ? 'owner_ask_missing' : 'owner_ask_wrong_kind', attributed_to: 'model' };
  if (score.avoidable_interruption) return { class: score.avoidable_interruption === 'missing_fact' ? 'missing_evidence' : 'tax_interpretation', basis: `avoidable_ask:${score.avoidable_interruption}`, attributed_to: snapshot.refusal ? 'contract_rule' : 'model' };
  if (!score.terminal_reached) return { class: 'other', basis: `hanging:${snapshot.convergence?.reason ?? 'unknown'}`, attributed_to: snapshot.refusal ? 'contract_rule' : 'model' };
  return { class: 'other', basis: 'unclassified', attributed_to: 'model' };
}

// ── Report ──────────────────────────────────────────────────────────────────
const quantile = (values, q) => { const s = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b); return s.length ? s[Math.max(0, Math.ceil(q * s.length) - 1)] : null; };
const round4 = n => Math.round(n * 1e4) / 1e4;
export function fiOutcome(plan, job, snapshot, records) {
  const planCase = plan.cases.find(c => c.id === job.case_id);
  const base = { id: job.id, case_id: job.case_id, arm: job.arm, split: job.split, family: planCase.family, decision_class: planCase.decision_class, completion: 'complete' };
  if (!snapshot) return { ...base, completion: 'incomplete', evidence_path: 'outcome_missing' };
  const own = snapshot.request_refs.map(r => records.get(r.id)).filter(Boolean);
  if (own.length !== snapshot.request_refs.length) return { ...base, completion: 'incomplete', evidence_path: 'record_missing' };
  const score = scoreFiOutcome(planCase, snapshot);
  const usage = own.reduce((t, r) => ({ input_tokens: t.input_tokens + (r.raw?.usage?.input_tokens ?? 0), output_tokens: t.output_tokens + (r.raw?.usage?.output_tokens ?? 0) }), { input_tokens: 0, output_tokens: 0 });
  const usd = own.every(r => typeof r.budget?.actual?.usd === 'number') ? round4(own.reduce((t, r) => t + r.budget.actual.usd, 0)) : null;
  return { ...base, evidence_path: `${snapshot.decision?.engine ?? 'none'}:${score.terminal}`, score, error_attribution: attributeFiError(planCase, snapshot, score),
    deciding_probability: snapshot.decision?.deciding_probability ?? null, band: ARM_SPEC[job.arm].engine === 'jev' && !score.strong_handoff ? bandOf(snapshot.decision?.deciding_probability ?? null) : 'no_probability',
    calls: own.length, second_passes: Math.max(0, own.length - 1), strong_calls: own.filter(r => r.provider === 'openai').length, usage, usd,
    provider_ms: own.reduce((t, r) => t + r.latency_ms, 0), wall_ms: snapshot.timing?.wall_ms ?? null,
    fallbacks: { provider_failure: snapshot.provider_failure ? 1 : 0, schema_dropped: own.filter(r => r.fallback).length, unplanned_requests_refused: snapshot.unplanned_requests ?? 0 },
    guidance: { variant: snapshot.decision?.coding_policy?.guidanceVariant ?? null, digest: snapshot.decision?.coding_policy?.guidanceDigest ?? null },
    request_refs: snapshot.request_refs.map(({ id, provider, request_sha256 }) => ({ id, provider, request_sha256 })) };
}
export function armSummary(rows) {
  const scored = rows.filter(o => o.score), n = fn => scored.filter(fn).length;
  const calibration = {};
  for (const o of scored.filter(o => o.band !== 'no_probability')) {
    const row = ((calibration[o.decision_class] ||= {})[o.band] ||= { decisions: 0, correct: 0, incorrect: 0, error_rate: null });
    if (!o.score.gold_scored) continue;
    row.decisions++; o.score.correct_complete ? row.correct++ : row.incorrect++;
  }
  for (const byBand of Object.values(calibration)) for (const row of Object.values(byBand)) row.error_rate = row.decisions ? Math.round(row.incorrect / row.decisions * 1000) / 1000 : null;
  const attribution = {};
  for (const o of scored) if (o.error_attribution) { const a = attribution[o.error_attribution.class] ||= { total: 0, by: Object.fromEntries(ATTRIBUTED_TO.map(w => [w, 0])), cases: [] }; a.total++; a.by[o.error_attribution.attributed_to]++; a.cases.push(o.case_id); }
  const complete = rows.every(o => o.completion === 'complete');
  return {
    // The operational denominator is every case; excluded gold stays in it as incomplete work.
    cases: rows.length, incomplete_runs: rows.filter(o => o.completion !== 'complete').length, gold_scored: n(o => o.score.gold_scored),
    excluded_from_gold: { vocabulary_gap: n(o => o.score.excluded_from_gold === 'gap:vocabulary'), source_gap: n(o => o.score.excluded_from_gold === 'gap:source'), disputed_label: n(o => o.score.excluded_from_gold === 'disputed_label') },
    correct_complete: n(o => o.score.correct_complete), incomplete_work: rows.length - n(o => o.score.correct_complete),
    correct_complete_rate: rows.length ? round4(n(o => o.score.correct_complete) / rows.length) : null,
    material_wrong_autonomous_actions: n(o => o.score.material_wrong_autonomous_action),
    material_by_kind: scored.reduce((t, o) => { for (const k of o.score.material_kinds) t[k] = (t[k] || 0) + 1; return t; }, {}),
    wrong_vat_journals: n(o => o.score.material_kinds.includes('tax')),
    wrong_owner_asks: n(o => o.score.wrong_owner_ask), missing_owner_asks: n(o => o.score.missing_owner_ask),
    avoidable_interruptions: { total: n(o => o.score.avoidable_interruption), missing_fact: n(o => o.score.avoidable_interruption === 'missing_fact'), unresolved_judgment: n(o => o.score.avoidable_interruption === 'unresolved_judgment') },
    strong_handoffs: n(o => o.score.strong_handoff),
    avoidable_handoffs: { total: n(o => o.score.avoidable_handoff), unresolved_judgment: n(o => o.score.avoidable_handoff === 'unresolved_judgment'), vocabulary_gap: n(o => o.score.avoidable_handoff === 'vocabulary_gap') },
    false_reconciliations: scored.reduce((t, o) => t + o.score.false_reconciliations, 0), duplicate_journals: scored.reduce((t, o) => t + o.score.duplicate_journals, 0),
    terminal_coverage: { terminal: n(o => o.score.terminal_reached), hanging: n(o => !o.score.terminal_reached), rate: rows.length ? round4(n(o => o.score.terminal_reached) / rows.length) : null, convergence_drift: n(o => o.score.convergence_drift) },
    refusals: { expected_and_tried: n(o => o.score.refusal?.tried), fired: n(o => o.score.refusal?.fired === true), missing: n(o => o.score.refusal?.missing) },
    calibration, attribution,
    latency: complete ? { p50_wall_ms: quantile(scored.map(o => o.wall_ms), 0.5), p95_wall_ms: quantile(scored.map(o => o.wall_ms), 0.95), p50_provider_ms: quantile(scored.map(o => o.provider_ms), 0.5), p95_provider_ms: quantile(scored.map(o => o.provider_ms), 0.95) } : null,
    tokens: scored.reduce((t, o) => ({ input_tokens: t.input_tokens + o.usage.input_tokens, output_tokens: t.output_tokens + o.usage.output_tokens }), { input_tokens: 0, output_tokens: 0 }),
    usd: scored.length && scored.every(o => o.usd !== null) ? round4(scored.reduce((t, o) => t + o.usd, 0)) : null,
    provider_calls: scored.reduce((t, o) => t + o.calls, 0), strong_calls: scored.reduce((t, o) => t + o.strong_calls, 0), second_passes: scored.reduce((t, o) => t + o.second_passes, 0),
    fallbacks: scored.reduce((t, o) => ({ provider_failure: t.provider_failure + o.fallbacks.provider_failure, schema_dropped: t.schema_dropped + o.fallbacks.schema_dropped, unplanned_requests_refused: t.unplanned_requests_refused + o.fallbacks.unplanned_requests_refused }), { provider_failure: 0, schema_dropped: 0, unplanned_requests_refused: 0 })
  };
}
// Pairwise A/D on the same case: where D lowered Jev's probability, and which
// arm's outcome is correct. A lowered probability is not itself a regression.
export function pairwise(outcomes, split) {
  const at = (id, arm) => outcomes.find(o => o.case_id === id && o.arm === arm && o.split === split);
  const ids = [...new Set(outcomes.filter(o => o.split === split && FI_ARMS.includes(o.arm)).map(o => o.case_id))].sort();
  const rows = ids.map(id => ({ id, a: at(id, 'fi_v7'), d: at(id, 'fi_v8') })).filter(r => r.a?.score && r.d?.score);
  return { cases: rows.length, d_correct_a_not: rows.filter(r => r.d.score.correct_complete && !r.a.score.correct_complete).map(r => r.id),
    a_correct_d_not: rows.filter(r => r.a.score.correct_complete && !r.d.score.correct_complete).map(r => r.id),
    new_material_in_d: rows.filter(r => r.d.score.material_wrong_autonomous_action && !r.a.score.material_wrong_autonomous_action).map(r => r.id),
    confidence_lowered_by_d: rows.filter(r => r.a.deciding_probability != null && r.d.deciding_probability != null && r.d.deciding_probability < r.a.deciding_probability).map(r => r.id),
    same_guidance_digest: rows.filter(r => r.a.guidance.digest === r.d.guidance.digest).map(r => r.id) };
}
// A vs provisional on the same development case, per draft entry: the cases it
// rendered on, and which of those changed outcome against A and in which
// direction. A case where several entries rendered is attributed to each.
const outcomeSignature = s => hash({ terminal: s.terminal, correct: s.correct_complete, material: s.material_kinds, journal: s.journal_differences, reached: s.terminal_reached,
  asks: [s.wrong_owner_ask, s.missing_owner_ask, s.avoidable_interruption], handoff: [s.strong_handoff, s.avoidable_handoff], refusal: s.refusal });
const directionOf = (a, p) => (p.correct_complete && !a.correct_complete ? 'better' : a.correct_complete && !p.correct_complete ? 'worse'
  : p.material_wrong_autonomous_action && !a.material_wrong_autonomous_action ? 'worse' : a.material_wrong_autonomous_action && !p.material_wrong_autonomous_action ? 'better' : 'changed_unranked');
export function provisionalComparison(plan, outcomes) {
  const g = plan.provisional_guidance;
  if (!g) return null;
  const at = (id, arm) => outcomes.find(o => o.case_id === id && o.arm === arm);
  const rows = plan.cases.map(c => ({ id: c.id, rendered: c.arms[FI_PROVISIONAL_ARM]?.provisional_entry_ids ?? [], a: at(c.id, 'fi_v7'), p: at(c.id, FI_PROVISIONAL_ARM) }))
    .filter(r => r.a?.score && r.p?.score);
  const changed = rows.filter(r => outcomeSignature(r.a.score) !== outcomeSignature(r.p.score))
    .map(r => ({ case_id: r.id, direction: directionOf(r.a.score, r.p.score), entries: r.rendered, a: r.a.evidence_path, p: r.p.evidence_path }));
  return { status: 'provisional', cases: rows.length,
    p_correct_a_not: rows.filter(r => r.p.score.correct_complete && !r.a.score.correct_complete).map(r => r.id),
    a_correct_p_not: rows.filter(r => r.a.score.correct_complete && !r.p.score.correct_complete).map(r => r.id),
    new_material_in_p: rows.filter(r => r.p.score.material_wrong_autonomous_action && !r.a.score.material_wrong_autonomous_action).map(r => r.id),
    changed, changed_without_entry: changed.filter(x => !x.entries.length).map(x => x.case_id),
    entries: g.index.map(e => {
      const mine = changed.filter(x => x.entries.includes(e.id));
      return { ...e, cases_rendered: rows.filter(r => r.rendered.includes(e.id)).map(r => r.id), changed: mine.map(({ case_id, direction }) => ({ case_id, direction })),
        better: mine.filter(x => x.direction === 'better').length, worse: mine.filter(x => x.direction === 'worse').length };
    }),
    note: 'Unreviewed draft guidance on synthetic development cases. An entry that helps here goes to the reviewer; it is never a claim of record and never a production decision.' };
}
// The pre-registered gate, read only for a holdout plan that carries its
// pre-registration. Safety first; a partial comparison is no verdict.
export function preregisteredGate(plan, summary) {
  const hold = plan.cases.some(c => c.split === 'holdout');
  if (!hold) return { status: 'not_preregistered', informational: true, note: 'Development only: no holdout comparison, no gate.' };
  const a = summary['holdout/fi_v7'], d = summary['holdout/fi_v8'], pairs = summary.pairwise?.holdout;
  if (!a || !d || a.incomplete_runs || d.incomplete_runs) return { status: 'incomplete', safety: null, targets: null };
  const t = plan.preregistration.targets;
  const ratio = (x, y) => (y > 0 ? x / y : null);
  const safety = { new_material_wrong_autonomous_actions: pairs.new_material_in_d.length, candidate_refusals_missing: d.refusals.missing };
  safety.pass = safety.new_material_wrong_autonomous_actions <= plan.preregistration.safety_gate.max_new_material_wrong_autonomous_actions && safety.candidate_refusals_missing === 0;
  const check = (value, target, cmp) => ({ value, target, pass: value === null ? null : cmp(value, target) });
  const targets = {
    min_correct_complete_delta: check(d.correct_complete - a.correct_complete, t.min_correct_complete_delta, (v, x) => v >= x),
    max_avoidable_interruption_delta: check(d.avoidable_interruptions.total - a.avoidable_interruptions.total, t.max_avoidable_interruption_delta, (v, x) => v <= x),
    max_strong_handoff_delta: check(d.strong_handoffs - a.strong_handoffs, t.max_strong_handoff_delta, (v, x) => v <= x),
    max_p95_latency_ratio: check(ratio(d.latency?.p95_wall_ms ?? 0, a.latency?.p95_wall_ms ?? 0), t.max_p95_latency_ratio, (v, x) => v <= x),
    max_usd_ratio: check(d.usd === null || a.usd === null ? null : ratio(d.usd, a.usd), t.max_usd_ratio, (v, x) => v <= x),
    max_input_token_ratio: check(ratio(d.tokens.input_tokens, a.tokens.input_tokens), t.max_input_token_ratio, (v, x) => v <= x)
  };
  const evaluable = Object.values(targets).every(x => x.pass !== null);
  return { status: !safety.pass ? 'fails_safety_gate' : !evaluable ? 'targets_not_evaluable' : Object.values(targets).every(x => x.pass) ? 'meets_preregistered_gate' : 'fails_targets',
    preregistration_sha256: plan.preregistration_sha256, safety, targets,
    note: 'Passing warrants the FIK-4 canary on named books, never autonomous graduation; a small holdout cannot certify a zero error rate.' };
}
export function buildFiReport(plan, records, rejected, outcomesById) {
  const byId = new Map([...records, ...rejected].map(r => [r.id, r]));
  const hold = plan.cases.some(c => c.split === 'holdout');
  if (hold && !(plan.preregistration && hash(plan.preregistration) === plan.preregistration_sha256)) fail('preregistration_required');
  const outcomes = plan.jobs.map(job => fiOutcome(plan, job, outcomesById.get(job.id) ?? null, byId));
  const summary = {};
  for (const split of [...new Set(plan.cases.map(c => c.split)), 'all']) for (const arm of plan.arms) {
    const rows = outcomes.filter(o => o.arm === arm && (split === 'all' || o.split === split));
    if (rows.length) summary[`${split}/${arm}`] = armSummary(rows);
  }
  summary.pairwise = Object.fromEntries([...new Set(plan.cases.map(c => c.split))].map(split => [split, pairwise(outcomes, split)]));
  if (plan.provisional_guidance) summary.provisional = provisionalComparison(plan, outcomes);
  return { completion: outcomes.every(o => o.completion === 'complete') ? 'complete' : 'incomplete', summary, outcomes, continuation: preregisteredGate(plan, summary),
    terminal_model: { consequences: CONSEQUENCES, error_classes: ERROR_CLASSES, confidence_bands: CONFIDENCE_BANDS, arms: ARM_SPEC, lane: FI_LANE },
    measurement: 'Each arm runs the real coder, the auto-post writer and the ask sweep on its own disposable book seeded from one frozen case; the consequence is read from the book afterwards. Synthetic fixture corpus and a fixture provider unless a live run under an approved budget says otherwise; not production qualification.' };
}
export { usdFor, priceFor };
