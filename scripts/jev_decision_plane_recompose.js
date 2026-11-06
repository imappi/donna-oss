#!/usr/bin/env node
// Offline DIAGNOSTIC over a committed public run summary: recompose the recorded
// typed answers under alternative composition policies and floors, re-guard the
// recorded strong outcomes through the shared mechanical validator, and measure
// what code-carried allocation amounts would change. No provider calls, no
// database writes, nothing tuned: the historical result stays as published and
// every number here is labelled a diagnostic. Any policy chosen from it needs a
// fresh evaluation on a fresh family set.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { hash, composeEvidenceAction, candidateMechanicalChecks, POLICIES, POLICY_SPEC, CONFIDENCE_FLOOR } from './jev_evidence_action_contract.js';
import { VERSION, buildDecisionPlan, guardStrongOutcome, needsEscalation, normalizeProposals, SENSITIVITY_FLOORS } from './jev_decision_plane_protocol.js';

export const DIAGNOSTIC_VERSION = 'jev-decision-plane-recompose-v1';
const TYPED_ARMS = ['jev_redesigned', 'strong_atomic'];
// The pre-registered sensitivity floors plus the attempt-first floors (Kari,
// 2026-09-18): majority mass (.5) and none (0) — the selected status counts
// whenever a citation survived, and only contradictions and mechanical facts block.
export const RECOMPOSE_FLOORS = Object.freeze([...SENSITIVITY_FLOORS, 0.5, 0]);
const STRONG_ARMS = ['jev_redesigned', 'strong_full_case', 'strong_atomic', 'jev_blanket'];

// Raw contract answers from the recorded per-question diagnostics: the selected
// status with its real probability when a citation survived (the composition
// applies the floor), `not_established` otherwise — the same downgrade the live
// adapter applied. Nothing is manufactured: statuses, probabilities and
// citations are the recorded ones.
export function rawFromRecorded(prepared, diagnostics) {
  const version = h => prepared.state.sources.find(s => s.handle === h).version;
  return prepared.questions.map(q => {
    const d = diagnostics.find(d => d.question_id === q.id);
    const status = d && d.cited.length ? d.selected : 'not_established';
    return { question_id: q.id, question_sha256: q.question_sha256, packet_sha256: prepared.packet_sha256, action_id: q.action_id, status,
      confidence: status === 'not_established' ? 0 : d.probability, citations: status === 'not_established' ? [] : d.cited.map(h => ({ source_handle: h, version: version(h) })) };
  });
}

const correctFor = (c, d) => d.route === c.expected.route && hash(normalizeProposals(d.proposals)) === hash(normalizeProposals(c.expected.proposals));
const wrongFor = (c, d) => d.route === 'supported_proposal' && normalizeProposals(d.proposals).some(p => !c.expected.proposals.some(e => e.transaction_id === p.transaction_id && e.amount_minor === p.amount_minor));

export function recompose(plan, summary) {
  if (summary.version !== VERSION || summary.corpus_sha256 !== plan.corpus_sha256) throw new Error('summary_corpus_mismatch');
  const caseOf = id => plan.cases.find(c => c.id === id);
  const out = { version: DIAGNOSTIC_VERSION, diagnostic: true, historical_result_unchanged: true, corpus: summary.corpus, corpus_sha256: summary.corpus_sha256,
    source_plan_sha256: summary.plan_sha256, source_ranAt: summary.ranAt, policies: {}, vetoes: {}, reguard: {}, amounts: {}, cases: {} };
  // 1. Composition policies × floors on the recorded typed answers.
  for (const arm of TYPED_ARMS) {
    const rows = summary.outcomes.filter(o => o.arm === arm && !o.common_route && Array.isArray(o.answers) && o.answers.length);
    const original = summary.summary[`${summary.outcomes[0]?.split ?? 'all'}/${arm}`] ?? null;
    out.policies[arm] = { cases: rows.length, original: original && { correct: original.correct_model_cases, escalations: original.escalations, wrong_proposals: original.wrong_proposals, unresolved: original.unresolved } };
    out.vetoes[arm] = {};
    // A pinned policy (safe / max_authority / forced) recomposes at its own floor only.
    for (const policy of POLICIES) for (const floor of POLICY_SPEC[policy].floor === null ? RECOMPOSE_FLOORS : [POLICY_SPEC[policy].floor]) {
      const key = `${policy}@${floor}`;
      const agg = { correct_before_escalation: 0, proposals: 0, correct_proposals: 0, wrong_proposals: 0, would_escalate: 0, customer_questions: 0, unresolved: 0, blocked_by: {} };
      for (const o of rows) {
        const c = caseOf(o.case_id);
        const d = composeEvidenceAction(c.prepared, rawFromRecorded(c.prepared, o.answers), { policy, floor });
        const proposals = normalizeProposals(d.proposals);
        const correct = correctFor(c, { route: d.route, proposals }), wrong = wrongFor(c, { route: d.route, proposals });
        agg.correct_before_escalation += correct;
        if (d.route === 'supported_proposal') { agg.proposals++; agg.correct_proposals += correct; agg.wrong_proposals += wrong; }
        if (d.route === 'customer_question') agg.customer_questions++;
        if (d.route === 'unresolved_research') agg.unresolved++;
        if (needsEscalation('jev_redesigned', { route: d.route, reason: d.reason, proposals }, { escape: POLICY_SPEC[policy].escape })) agg.would_escalate++;
        if (d.route === 'needs_evidence') agg.needs_evidence = (agg.needs_evidence || 0) + 1;
        for (const dep of d.dependencies || []) if (dep.blocked_by) { const k = dep.blocked_by.join('+'); agg.blocked_by[k] = (agg.blocked_by[k] || 0) + 1; }
        ((out.cases[o.case_id] ||= {})[arm] ||= {})[key] = { route: d.route, reason: d.reason, proposals, correct, wrong, blocked_by: (d.dependencies || []).filter(x => x.blocked_by).map(x => ({ candidate: x.candidate, reason: x.reason, blocked_by: x.blocked_by })) };
      }
      out.policies[arm][key] = agg;
    }
  }
  // 2. Re-guard the recorded strong outcomes through the shared validator.
  for (const arm of STRONG_ARMS) {
    const rows = summary.outcomes.filter(o => o.arm === arm && !o.common_route);
    const r = { strong_outcomes: 0, previously_accepted: 0, now_refused: [], previously_refused: 0, still_refused: 0 };
    for (const o of rows) {
      const c = caseOf(o.case_id), handles = c.prepared.bank_handles;
      // The recorded strong decision: the escalation for the typed arms and the
      // blanket fallback, the initial call for strong full-case; pre-guard
      // proposals live in guard.initial when the old guard refused.
      const rec = arm === 'strong_full_case' ? o.initial : o.escalated;
      if (!rec || rec.reason?.startsWith('malformed_answer')) continue;
      const pre = rec.guard ? rec.guard.initial : { route: rec.route, proposals: rec.proposals };
      if (!pre || pre.route !== 'supported_proposal') continue;
      r.strong_outcomes++;
      const g = guardStrongOutcome(c.prepared, { route: 'supported_proposal', proposals: pre.proposals.map(p => ({ candidate_handle: handles[p.transaction_id], amount_minor: p.amount_minor })), missing_fact_needed: false, reasoning: '' });
      if (rec.guard) { r.previously_refused++; if (g.guard) r.still_refused++; continue; }
      r.previously_accepted++;
      if (g.guard) r.now_refused.push({ case_id: o.case_id, codes: g.guard.refusals.map(x => x.code), was_correct: correctFor(c, rec), was_wrong: wrongFor(c, rec) });
    }
    out.reguard[arm] = r;
  }
  // 3. Amounts: arithmetic refusals where the model named a candidate whose single
  //    focal link is consistent — code carrying the link's invoice amount would
  //    have produced the labelled allocation (or not).
  for (const arm of STRONG_ARMS) {
    const rows = summary.outcomes.filter(o => o.arm === arm && !o.common_route);
    const a = { arithmetic_refusals: 0, code_amount_matches_label: [], code_amount_differs: [] };
    for (const o of rows) {
      const c = caseOf(o.case_id), p = c.prepared.packet;
      const rec = arm === 'strong_full_case' ? o.initial : o.escalated;
      const refusals = rec?.guard?.refusals?.filter(x => x.code === 'allocation_arithmetic_conflict') || [];
      if (!refusals.length) continue;
      a.arithmetic_refusals++;
      const remaining = p.invoice.amount_minor - p.allocations.filter(x => x.status !== 'rejected' && x.invoice_id === p.invoice.id && x.object_type === p.invoice.document_type).reduce((n, x) => n + x.amount_minor, 0);
      const proposed = [];
      for (const pr of rec.guard.initial.proposals) {
        const t = p.transactions.find(t => t.id === pr.transaction_id); if (!t) continue;
        const m = candidateMechanicalChecks(c.prepared, t, remaining);
        if (m.link && m.arithmetic && m.mine.length === 1 && !m.conflict && !m.reference_rule) proposed.push({ transaction_id: t.id, invoice_id: p.invoice.id, amount_minor: m.link.invoice_amount_minor });
      }
      const dedup = normalizeProposals([...new Map(proposed.map(x => [x.transaction_id, x])).values()]);
      (hash(dedup) === hash(normalizeProposals(c.expected.proposals)) ? a.code_amount_matches_label : a.code_amount_differs).push({ case_id: o.case_id, proposed_minor: rec.guard.initial.proposals.map(x => x.amount_minor), code_minor: dedup.map(x => x.amount_minor), label_minor: c.expected.proposals.map(x => x.amount_minor) });
    }
    out.amounts[arm] = a;
  }
  return out;
}

export function renderRecompose(out) {
  const lines = [`corpus=${out.corpus} source_plan=${out.source_plan_sha256.slice(0, 12)} (diagnostic; historical result unchanged)`];
  for (const [arm, rows] of Object.entries(out.policies)) {
    lines.push(`\n[${arm}] cases=${rows.cases} original: correct=${rows.original?.correct} escalations=${rows.original?.escalations} wrong=${rows.original?.wrong_proposals}`);
    lines.push('policy@floor          correct  proposals  correct_props  wrong  escalate  CQ  unresolved  blocked_by');
    for (const [key, a] of Object.entries(rows)) if (key.includes('@')) lines.push(`${key.padEnd(21)} ${String(a.correct_before_escalation).padStart(7)}  ${String(a.proposals).padStart(9)}  ${String(a.correct_proposals).padStart(13)}  ${String(a.wrong_proposals).padStart(5)}  ${String(a.would_escalate).padStart(8)}  ${String(a.customer_questions).padStart(2)}  ${String(a.unresolved).padStart(10)}  ${JSON.stringify(a.blocked_by)}`);
  }
  for (const [arm, r] of Object.entries(out.reguard)) lines.push(`\n[reguard ${arm}] strong proposals=${r.strong_outcomes} accepted=${r.previously_accepted} now_refused=${JSON.stringify(r.now_refused)} previously_refused=${r.previously_refused} still_refused=${r.still_refused}`);
  for (const [arm, a] of Object.entries(out.amounts)) lines.push(`\n[amounts ${arm}] arithmetic_refusals=${a.arithmetic_refusals} code_amount_matches_label=${a.code_amount_matches_label.map(x => `${x.case_id}(${x.proposed_minor}->${x.code_minor})`).join(',') || '-'} differs=${a.code_amount_differs.map(x => `${x.case_id}(${x.proposed_minor}->${x.code_minor} vs ${x.label_minor})`).join(',') || '-'}`);
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const args = {};
  for (const v of argv) { const m = /^--(summary|corpus|output)=(.+)$/.exec(v); if (!m || args[m[1]]) throw new Error('invalid_argument'); args[m[1]] = m[2]; }
  if (!args.summary || !args.corpus) throw new Error('invalid_selection');
  const url = process.env.DONNA_PG_TEST_URL;
  if (!url || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('local_disposable_postgres_required');
  const summary = JSON.parse(readFileSync(resolve(args.summary), 'utf8'));
  if (Array.isArray(summary.records)) throw new Error('public_summary_required');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  let plan;
  try { plan = await buildDecisionPlan({ client, corpus: args.corpus, split: 'all', jevModel: 'diagnostic', strongModel: 'diagnostic' }); }
  finally { await client.end(); }
  const out = recompose(plan, summary);
  if (args.output) { mkdirSync(dirname(resolve(args.output)), { recursive: true }); writeFileSync(resolve(args.output), JSON.stringify(out, null, 2) + '\n'); }
  process.stdout.write(renderRecompose(out) + '\n');
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().then(code => { process.exitCode = code; }).catch(error => {
  console.error(['invalid_argument', 'invalid_selection', 'local_disposable_postgres_required', 'public_summary_required', 'summary_corpus_mismatch', 'invalid_corpus'].includes(error?.message) ? error.message : 'Recomposition refused; check the public summary, corpus name and disposable PostgreSQL.');
  process.exitCode = 2;
});
