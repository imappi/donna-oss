// No provider mode. This runner evaluates injected answers, never model capability.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadFixtures, runEval } from '../server/donna/evalHarness.js';
import { VERSION, hash, prepareEvidencePacket, composeEvidenceAction } from './jev_evidence_action_contract.js';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const loadContractCorpus = () => loadFixtures('jev-contract', { root: resolve(ROOT, 'data/evals/fixtures') });

// The annotations are authored development assertions, isolated from preparation.
// Never call these provider answers, calibrated judgments or independent labels.
export function injectedAnswers(prepared, annotations = {}, { unknown = false } = {}) {
  return prepared.questions.map(q => {
    const transaction = Object.entries(prepared.bank_handles).find(([, handle]) => q.action_id === `link_${handle}`)?.[0];
    const status = unknown ? 'not_established' : q.id === 'ask_fact' ? (annotations.ask_fact || 'not_established')
      : (annotations[transaction]?.[q.predicate] || 'not_established');
    return { question_id: q.id, question_sha256: q.question_sha256, packet_sha256: prepared.packet_sha256,
      action_id: q.action_id, status, confidence: 1,
      citations: status === 'not_established' ? [] : q.source_handles.map(handle => ({ source_handle: handle,
        version: prepared.state.sources.find(s => s.handle === handle).version })) };
  });
}

export async function runContract({ client, fixtures = loadContractCorpus(), mode = 'ideal', ranAt = '2026-09-17T00:00:00.000Z' }) {
  if (!['ideal', 'unknown'].includes(mode)) throw new Error('offline_injected_modes_only');
  if (!fixtures.length || fixtures.length > 100) throw new Error('invalid_fixture_bound');
  const evaluation = await runEval({ suite: 'jev-evidence-action', mode: `injected_${mode}`, ranAt, fixtures,
    runner: async f => {
      const prepared = await prepareEvidencePacket(f.packet, client);
      const answers = prepared.error ? [] : injectedAnswers(prepared, f.semantic_statuses, { unknown: mode === 'unknown' });
      return { packet_sha256: prepared.packet_sha256, questions_sha256: hash(prepared.questions),
        decision: composeEvidenceAction(prepared, answers),
        label_status: f.adjudication.status, source_family: f.adjudication.source_family };
    },
    scorer: (f, actual) => {
      const a = actual.decision;
      const proposals = a.proposals.map(p => ({ transaction_id: p.transaction_id, invoice_id: p.invoice_id, amount_minor: p.amount_minor }))
        .sort((x, y) => x.transaction_id.localeCompare(y.transaction_id));
      const expected = [...(f.expected.proposals || [])].sort((x, y) => x.transaction_id.localeCompare(y.transaction_id));
      const pass = a.route === f.expected.route && hash(proposals) === hash(expected)
        && !a.production_terminal && !a.writer_authority && !a.proposal_applied && !a.question_delivered;
      return { status: pass ? 'pass' : 'fail', truePositive: Number(pass), falsePositive: Number(!pass),
        falseNegative: Number(!pass), expectedSize: 1, actualSize: 1 };
    }
  });
  const routes = {};
  for (const c of evaluation.cases) if (c.actual) routes[c.actual.decision.route] = (routes[c.actual.decision.route] || 0) + 1;
  return { version: VERSION, evidence_kind: 'injected_development_contract_checks', provider_calls: 0,
    harness_metric_unit: 'one development behavior assertion, not a financial match or model judgment',
    hash_encoding: 'sha256 of canonical JSON encoded as UTF-8, except explicitly named legacy fixture byte digests',
    independently_reviewed_labels: fixtures.filter(f => f.adjudication.status === 'independently_reviewed').length,
    capability_verdict: 'not_measured', production_completions: 0,
    declaration: 'Passing an expected unresolved route proves contract behavior, not successful bookkeeping or reduced fallback.',
    corpus_sha256: hash(fixtures.map(({ __file, ...f }) => f)),
    code_sha256: Object.fromEntries(['scripts/jev_evidence_action_contract.js', 'scripts/jev_evidence_action.js',
      'scripts/jev_routed_protocol.js', 'server/donna/localEvidenceInventory.js', 'server/donna/reconciliationLlmCore.js',
      'server/donna/issuedInvoiceSettlementMath.js', 'server/donna/evalHarness.js']
      .map(file => [file, hash(readFileSync(resolve(ROOT, file), 'utf8'))])),
    routes, evaluation };
}

export async function main(args) {
  const options = {};
  for (const arg of args) {
    const match = /^--(mode|output)=(.+)$/.exec(arg);
    if (!match || Object.hasOwn(options, match[1])) throw new Error('invalid_arguments');
    options[match[1]] = match[2];
  }
  if (options.mode && !['ideal', 'unknown'].includes(options.mode)) throw new Error('offline_injected_modes_only');
  const url = process.env.DONNA_PG_TEST_URL;
  if (!url || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('local_disposable_postgres_required');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  let result;
  try { result = await runContract({ client, mode: options.mode || 'ideal' }); }
  finally { await client.end(); }
  const output = JSON.stringify(result, null, 2) + '\n';
  if (options.output) writeFileSync(resolve(options.output), output, { flag: 'wx', mode: 0o600 });
  else process.stdout.write(output);
  return result.evaluation.totals.errored ? 2 : result.evaluation.totals.failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    // Closed diagnostics; never print connection errors, URLs or environment.
    const code = ['invalid_arguments', 'offline_injected_modes_only', 'local_disposable_postgres_required'].includes(error.message)
      ? error.message : error.code === 'EEXIST' ? 'output_exists' : 'offline_execution_incomplete';
    process.stderr.write(`${code}\n`); process.exitCode = 2;
  });
}
