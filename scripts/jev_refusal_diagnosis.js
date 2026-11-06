#!/usr/bin/env node
// Offline DIAGNOSTIC over the published fresh-set summaries (Kari's direct-action
// brief, 2026-09-18, step 1): for each named case, rebuild the recorded typed
// answers from the public summary's per-question diagnostics, re-run the
// contract's answer validator ONE ANSWER AT A TIME against the re-prepared
// packet, and report which answer each `affirmative_source_not_cited` refusal
// named, whether the refused answer sat on a candidate the composition would
// ever have consumed, and what the composition yields on the recorded answers
// with the refused answers neutralised (a mechanical derivation, labelled as
// such, never a new capability observation). No provider call, no database
// write, nothing tuned; the published summaries are read only.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { prepareEvidencePacket, validateSemanticAnswers, composeEvidenceAction, evidenceSufficiency, unboundEvidence } from './jev_evidence_action_contract.js';
import { ROOT, loadCorpus, decisionFacts, operationalConsequence, normalizeProposals } from './jev_decision_plane_protocol.js';
import { candidateFacts } from './jev_direct_action.js';

export const DIAGNOSIS_VERSION = 'jev-refusal-diagnosis-v1';
export const NAMED_CASES = Object.freeze(['fresh-005', 'fresh-006', 'fresh-017', 'fresh-028', 'fresh-029', 'fresh-030', 'fresh-011', 'fresh-012']);
export const SUMMARIES = Object.freeze({ max_authority: 'data/evals/experiments/jev-capability-boundary-fresh-max-2026-09-18.json', safe: 'data/evals/experiments/jev-capability-boundary-fresh-safe-2026-09-18.json', forced: 'data/evals/experiments/jev-capability-boundary-fresh-forced-2026-09-18.json' });

// The recorded answers, in the contract's answer shape: the selected status with
// its recorded probability when a citation survived the adapter, else the
// downgrade the live adapter applied (`not_established`, no citation). Nothing
// is manufactured; the recorded not_established probability of a downgraded
// answer is not in the public summary, so `confidence` there is 0 — route-
// neutral, since a not_established answer never asserts an action.
export function recordedAnswers(prepared, diagnostics) {
  const version = h => prepared.state.sources.find(s => s.handle === h).version;
  return prepared.questions.map(q => {
    const d = diagnostics.find(d => d.question_id === q.id);
    const status = d && !d.downgraded_without_citation && d.asked ? d.selected : 'not_established';
    return { question_id: q.id, question_sha256: q.question_sha256, packet_sha256: prepared.packet_sha256, action_id: q.action_id, status,
      confidence: status === 'not_established' ? 0 : d.probability, citations: status === 'not_established' ? [] : d.cited.map(h => ({ source_handle: h, version: version(h) })) };
  });
}
// Validate one answer at a time: every other answer is a not_established
// placeholder, so the refusal (if any) is this answer's own.
export function refusedAnswers(prepared, answers) {
  const out = [];
  for (const a of answers) {
    const alone = answers.map(x => x.question_id === a.question_id ? x : { ...x, status: 'not_established', confidence: 0, citations: [] });
    try { validateSemanticAnswers(prepared, alone); } catch (error) { out.push({ question_id: a.question_id, status: a.status, probability: a.confidence, cited: a.citations.map(c => c.source_handle), refusal: error.message }); }
  }
  return out;
}
export async function diagnoseCase(client, fixture, summaries) {
  const prepared = await prepareEvidencePacket(fixture.packet, client);
  if (prepared.error) return { id: fixture.id, error: prepared.error };
  const outcome = policy => summaries[policy].outcomes.find(o => o.id === `${fixture.id}/jev_redesigned`);
  const diagnostics = outcome('max_authority').answers;
  for (const policy of Object.keys(summaries)) if (JSON.stringify(outcome(policy).answers) !== JSON.stringify(diagnostics)) throw new Error(`recorded answers differ across policies: ${fixture.id}`);
  const answers = recordedAnswers(prepared, diagnostics);
  let wholeSet = 'accepted';
  try { validateSemanticAnswers(prepared, answers); } catch (error) { wholeSet = error.message; }
  const refused = refusedAnswers(prepared, answers);
  const facts = candidateFacts(prepared);
  const candidateOf = qid => facts.find(f => qid.startsWith(`link_${f.handle}_`)) ?? null;
  const refusedIds = new Set(refused.map(r => r.question_id));
  const neutralised = answers.map(x => refusedIds.has(x.question_id) ? { ...x, status: 'not_established', confidence: 0, citations: [] } : x);
  const recomposed = {};
  for (const policy of ['max_authority', 'forced']) { const c = composeEvidenceAction(prepared, neutralised, { policy }); recomposed[policy] = { route: c.route, reason: c.reason, proposals: normalizeProposals(c.proposals), consequence: operationalConsequence({ route: c.route, reason: c.reason }), ...decisionFacts(c) }; }
  const strong = summaries.max_authority.outcomes.find(o => o.id === `${fixture.id}/strong_full_case`);
  return {
    id: fixture.id, expected: fixture.expected, evidence_sufficiency: evidenceSufficiency(prepared).status, unbound_sources: unboundEvidence(prepared.packet).map(id => prepared.source_handles[id]),
    sources: Object.fromEntries(prepared.state.sources.map(s => [s.handle, s.kind])),
    candidates: facts.map(f => ({ handle: f.handle, eligible: f.eligible, direction_compatible: f.direction_compatible, reversed_by: f.reversed_by, focal_links: f.focal_links.map(l => l.handle), links_elsewhere: f.links_elsewhere.map(l => l.handle), settlement_capable: f.settlement_capable })),
    recorded_answers: diagnostics.filter(d => d.asked).map(d => ({ question_id: d.question_id, selected: d.selected, probability: d.probability, cited: d.cited, grounding: d.citation_grounding, downgraded_without_citation: d.downgraded_without_citation,
      admissible_sources: prepared.questions.find(q => q.id === d.question_id).source_handles })),
    whole_set_validation: wholeSet,
    refused_answers: refused.map(r => { const f = candidateOf(r.question_id); return { ...r, candidate: f?.handle ?? null, candidate_consumed_by_composition: Boolean(f?.settlement_capable), candidate_direction_compatible: f?.direction_compatible ?? null, candidate_has_focal_link: Boolean(f?.focal_links.length) }; }),
    recomposed_with_refused_answers_neutralised: recomposed,
    recorded: Object.fromEntries(Object.keys(summaries).map(policy => { const o = outcome(policy); return [policy, { evidence_path: o.evidence_path, initial: { route: o.initial?.route, reason: o.initial?.reason }, final: { route: o.final?.route, reason: o.final?.reason, proposals: o.final?.proposals, evidence_requests: o.final?.evidence_requests?.map(r => r.transaction_id) }, own: o.consequence.own, final_consequence: o.consequence.final, correct: o.consequence.correct, escalation_attribution: o.escalation_attribution, error_attribution: o.error_attribution }]; })),
    strong_full_case: { final: { route: strong.final?.route, proposals: strong.final?.proposals, evidence_requests: strong.final?.evidence_requests?.map(r => r.transaction_id) }, consequence: strong.consequence.final, correct: strong.consequence.correct, error_attribution: strong.error_attribution }
  };
}
export async function diagnose(client, { ids = NAMED_CASES } = {}) {
  const corpus = loadCorpus('jev-plane-fresh');
  const summaries = Object.fromEntries(Object.entries(SUMMARIES).map(([k, path]) => [k, JSON.parse(readFileSync(resolve(ROOT, path), 'utf8'))]));
  const cases = [];
  for (const id of ids) { const f = corpus.find(f => f.id === id); if (!f) throw new Error(`unknown_case:${id}`); cases.push(await diagnoseCase(client, f, summaries)); }
  return { version: DIAGNOSIS_VERSION, summaries: SUMMARIES, note: 'Offline diagnosis on development material: recorded answers re-validated one at a time; recomposition with refused answers neutralised is a mechanical derivation, not fresh capability evidence. No model id.', cases };
}
export function renderDiagnosis(result) {
  const lines = [];
  for (const c of result.cases) {
    lines.push(`## ${c.id} — label ${c.expected.route}${c.expected.terminal ? ` (${c.expected.terminal})` : ''}; sufficiency ${c.evidence_sufficiency}; unbound ${c.unbound_sources.join(', ') || 'none'}`);
    lines.push(`candidates: ${c.candidates.map(x => `${x.handle}[${x.direction_compatible ? 'dir-ok' : 'wrong-dir'}${x.reversed_by ? `,reversed-by:${x.reversed_by}` : ''}${x.focal_links.length ? `,focal:${x.focal_links.join('+')}` : ',no-focal-link'}${x.links_elsewhere.length ? `,elsewhere:${x.links_elsewhere.join('+')}` : ''}]`).join(' ')}`);
    lines.push(`whole set: ${c.whole_set_validation}`);
    for (const r of c.refused_answers) lines.push(`  refused: ${r.question_id} ${r.status} p=${r.probability} cited=[${r.cited.join(',')}] → ${r.refusal}; candidate ${r.candidate} consumed_by_composition=${r.candidate_consumed_by_composition} direction_compatible=${r.candidate_direction_compatible} focal_link=${r.candidate_has_focal_link}`);
    for (const a of c.recorded_answers) lines.push(`  answer: ${a.question_id.padEnd(32)} ${a.selected.padEnd(16)} p=${a.probability} cited=[${a.cited.join(',')}] admissible=[${a.admissible_sources.join(',')}]${a.downgraded_without_citation ? ' DOWNGRADED(no source ≥ .50)' : ''}`);
    for (const [policy, r] of Object.entries(c.recomposed_with_refused_answers_neutralised)) lines.push(`  recomposed(${policy}, refused neutralised): ${r.route}/${r.reason} proposals=${JSON.stringify(r.proposals)} → ${r.consequence}`);
    for (const [policy, r] of Object.entries(c.recorded)) lines.push(`  recorded(${policy}): ${r.evidence_path} → own ${r.own}, final ${r.final_consequence} (${r.final.route}${r.final.proposals?.length ? ` ${JSON.stringify(r.final.proposals)}` : ''}${r.final.evidence_requests?.length ? ` +requests ${JSON.stringify(r.final.evidence_requests)}` : ''}) correct=${r.correct}`);
    lines.push(`  strong full-case: ${c.strong_full_case.final.route}${c.strong_full_case.final.evidence_requests?.length ? ` +requests ${JSON.stringify(c.strong_full_case.final.evidence_requests)}` : ''} → ${c.strong_full_case.consequence} correct=${c.strong_full_case.correct}`);
    lines.push('');
  }
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const out = argv.find(a => a.startsWith('--output='))?.slice(9) ?? null;
  const url = process.env.DONNA_PG_TEST_URL;
  if (!url || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('local_disposable_postgres_required');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  let result;
  try { result = await diagnose(client); } finally { await client.end(); }
  if (out) { mkdirSync(dirname(resolve(out)), { recursive: true }); writeFileSync(resolve(out), JSON.stringify(result, null, 2) + '\n'); }
  process.stdout.write(renderDiagnosis(result));
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().then(code => { process.exitCode = code; }).catch(error => { console.error(error?.message === 'local_disposable_postgres_required' ? error.message : 'Diagnosis refused; check disposable PostgreSQL and the published summaries.'); process.exitCode = 2; });
