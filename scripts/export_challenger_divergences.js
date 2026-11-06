#!/usr/bin/env node
//
// Descent ladder Q5 — export challenger divergences as EAW quarantine
// candidates (docs/design-donna-qwen-descent-ladder.md §4.2).
//
// Reads model_challenger_runs (the Q2 receipts), reconstructs each case's
// minimized observation from the durable domain objects behind its
// execution ref (the receipts deliberately store no prompt/response text —
// the llmCall retention posture), and writes one JSON candidate per run
// into a quarantine directory.
//
// WHAT THESE FILES ARE — and are not. Each candidate is an INPUT to EAW
// Slice 6's correction-quarantine (design-donna-executable-accounting-world.md
// §14): classified by lane × failure class, carrying the §14.2
// privacy/provenance block, adjudication status 'quarantined_unadjudicated'.
// They are NOT finished EAW world fixtures — promotion into the corpus is
// the EAW lane's adjudicated act, routed through Kari (the 2026-08-09
// lane-discipline rule). This script never writes under data/worlds/.
//
// Privacy (§14.2): the observation carries the client's transaction text
// (that is what makes a fixture discriminate), so every candidate is
// marked use: private-client-pack-only until adjudication decides
// otherwise. Raw content enters no broad corpus by this script.
//
// Usage:
//   node scripts/export_challenger_divergences.js [--firm <id>] [--lane <id>]
//     [--since <iso>] [--include-matches] [--out <dir>] [--dry-run]
//
// Default outcome filter: divergence + parse_failure + challenger_error
// (matches are the denominator, not the product; --include-matches for
// calibration exports).

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { withFirmDbClient } from '../server/donna/firmDb.js';

export const QUARANTINE_SPEC_VERSION = 'donna.challengerQuarantine.v1';
export const DEFAULT_OUT_DIR = 'data/challenger-quarantine';
const EXPORTED_OUTCOMES = ['divergence', 'parse_failure', 'challenger_error'];

// ── Lane observation reconstructors ─────────────────────────────────────
// Keyed by root_execution_type. Each returns the lane's MINIMIZED
// observation (exactly the fields the deciding prompt was built from), or
// null when the domain object no longer exists — the candidate still
// exports with observation:null + a note, because the verdict row alone
// can justify adjudication interest.
const OBSERVATION_RECONSTRUCTORS = {
  bank_line_auto_explain: async (client, run) => {
    const result = await client.query(
      `select description, raw_description, money_out, currency
         from transactions
        where id = $1 and firm_id = $2 and client_id = $3`,
      [run.root_execution_id, run.firm_id, run.client_id]
    );
    const tx = result.rows?.[0];
    if (!tx) return null;
    return {
      kind: 'bank_line',
      description: tx.description || tx.raw_description || '',
      amount: tx.money_out == null ? null : Number(tx.money_out),
      currency: tx.currency || ''
    };
  },
  // Q6a — the disposition lane's runs share the bank-line observation
  // shape; the amount rides whichever direction the line carries.
  bank_line_disposition: async (client, run) => {
    const result = await client.query(
      `select description, raw_description, money_out, money_in, currency
         from transactions
        where id = $1 and firm_id = $2 and client_id = $3`,
      [run.root_execution_id, run.firm_id, run.client_id]
    );
    const tx = result.rows?.[0];
    if (!tx) return null;
    const amount = tx.money_out != null && Number(tx.money_out) > 0 ? tx.money_out : tx.money_in;
    return {
      kind: 'bank_line',
      description: tx.description || tx.raw_description || '',
      amount: amount == null ? null : Number(amount),
      currency: tx.currency || ''
    };
  }
};

// Pure candidate builder — everything the file carries, minus I/O.
export const buildQuarantineCandidate = ({ run, observation = null }) => ({
  specVersion: QUARANTINE_SPEC_VERSION,
  candidateId: run.id,
  lane: run.lane,
  outcome: run.outcome,
  failureClass: run.failure_class ?? null,
  source: {
    kind: 'production_challenger_run',
    runId: run.id,
    firmId: run.firm_id,
    clientId: run.client_id,
    createdAt: run.created_at ? new Date(run.created_at).toISOString() : null,
    rootExecution: { type: run.root_execution_type, id: run.root_execution_id }
  },
  models: {
    deciding: run.deciding ?? null,
    challenger: run.challenger ?? null
  },
  verdict: {
    outcome: run.outcome,
    failureClass: run.failure_class ?? null,
    divergenceSummary: run.divergence_summary ?? null
  },
  observation,
  observationNote: observation ? null : 'domain object unavailable at export time — verdict row only',
  privacy: {
    basis: 'operator_export',
    minimised: true,
    pseudonymised: false,
    use: 'private_client_pack_only_until_adjudicated'
  },
  adjudication: {
    status: 'quarantined_unadjudicated',
    quarantineClass: null
  }
});

export const exportChallengerDivergences = async ({
  client,
  firmId = null,
  lane = null,
  since = null,
  includeMatches = false,
  reconstructors = OBSERVATION_RECONSTRUCTORS
}) => {
  const where = ['1=1'];
  const params = [];
  const add = (clause, value) => { params.push(value); where.push(`${clause} $${params.length}`); };
  if (!includeMatches) {
    params.push(EXPORTED_OUTCOMES);
    where.push(`outcome = any($${params.length}::text[])`);
  }
  if (firmId) add('firm_id =', firmId);
  if (lane) add('lane =', lane);
  if (since) add('created_at >=', since);

  const runs = await client.query(
    `select id, firm_id, client_id, lane, root_execution_type, root_execution_id,
            deciding, challenger, outcome, failure_class, divergence_summary, created_at
       from model_challenger_runs
      where ${where.join(' and ')}
      order by created_at asc`,
    params
  );

  const candidates = [];
  for (const run of runs.rows || []) {
    const reconstruct = reconstructors[run.root_execution_type];
    let observation = null;
    if (reconstruct) {
      try {
        observation = await reconstruct(client, run);
      } catch {
        observation = null;
      }
    }
    candidates.push(buildQuarantineCandidate({ run, observation }));
  }
  return candidates;
};

const parseArgs = (argv) => {
  const args = { out: DEFAULT_OUT_DIR, includeMatches: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--firm') args.firm = argv[++i];
    else if (arg === '--lane') args.lane = argv[++i];
    else if (arg === '--since') args.since = argv[++i];
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--include-matches') args.includeMatches = true;
    else if (arg === '--dry-run') args.dryRun = true;
  }
  return args;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const candidates = await withFirmDbClient((client) => exportChallengerDivergences({
    client,
    firmId: args.firm || null,
    lane: args.lane || null,
    since: args.since || null,
    includeMatches: args.includeMatches
  }));

  const byClass = {};
  for (const candidate of candidates) {
    const key = `${candidate.lane} × ${candidate.failureClass || candidate.outcome}`;
    byClass[key] = (byClass[key] || 0) + 1;
  }

  if (args.dryRun) {
    console.log(JSON.stringify({ candidates: candidates.length, by_class: byClass }, null, 2));
    return;
  }

  for (const candidate of candidates) {
    const dir = path.join(args.out, candidate.lane);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${candidate.candidateId}.json`), `${JSON.stringify(candidate, null, 2)}\n`);
  }
  console.log(JSON.stringify({ exported: candidates.length, out: args.out, by_class: byClass }, null, 2));
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    () => process.exit(0),
    (error) => { console.error(error?.message || error); process.exit(1); }
  );
}
