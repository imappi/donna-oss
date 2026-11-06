#!/usr/bin/env node
//
// Light up the "Memory" tab (Donna Loops Phase 6.2) against an existing book by
// reconstructing memory_candidates from the firm_facts a client already minted.
//
// The Facts tab (firm_facts) is the TRUSTED end-state; the Memory tab is the
// review queue that feeds it (memory_candidates). In a flag-off deploy the Memory
// tab is hidden because the LOOPS_SHADOW-gated /memory-candidates endpoint returns
// no candidates. This script stages the candidates so the tab has something to
// render — one 'fact' candidate per existing firm_fact, status reflecting the
// PERSISTED fact verdict (active -> promoted, dismissed -> dismissed), pointing
// back at the fact (rail #1). It is the Phase-6.0 backfill
// (backfillMemoryCandidatesFromFacts) wrapped for the command line — idempotent,
// dry-run by default, and it NEVER resurrects a dismissed candidate.
//
// THREE THINGS must be true to SEE the tab afterwards (all dev-side):
//   1. migration 036_donna_loops_memory_candidates.sql is applied,
//   2. the candidate rows exist (this script, with --apply),
//   3. the app process serving the API runs with LOOPS_SHADOW=on
//      (the script forces the flag for its own write via allowWhenDisabled, but
//       the running server must also have it on for the endpoint to return them).
//
// Scope:
//   --firm   <firm_id>    defaults to donna-demo-firm
//   --client <client_id>  the book to backfill; omit to LIST clients that have
//                         facts (so you can pick the right one) and exit
//   --apply               commits the candidates; default is a dry-run (no writes)

import { withFirmDbClient, getFirmDatabaseUrl } from '../server/donna/firmDb.js';
import {
  backfillMemoryCandidatesFromFacts,
  memoryCandidatesTablePresent
} from '../server/donna/memoryCandidates.js';

export const parseArgv = (argv = process.argv.slice(2)) => {
  const out = { apply: false, firmId: 'donna-demo-firm', clientId: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--firm') { out.firmId = argv[i + 1]; i += 1; }
    else if (a === '--client') { out.clientId = argv[i + 1]; i += 1; }
  }
  return out;
};

const log = (...args) => console.log('[memory-candidate-backfill]', ...args);

// ── Connection diagnostics ──────────────────────────────────────────────────
//
// The #1 way this script fails is a DATABASE_URL pointed at the WRONG Supabase
// endpoint, and both wrong endpoints surface as the same opaque ETIMEDOUT:
//   • the project/API host (<ref>.supabase.co) — Cloudflare-fronted; Postgres is
//     not served there, so :5432 times out against Cloudflare IPs, and
//   • the direct host (db.<ref>.supabase.co) — IPv6-only, so it times out from
//     an IPv4-only network.
// The fix for both is the connection POOLER. Rather than guess from the raw
// socket error (rail #3 — diagnose, don't guess), classify the configured host
// up front, echo it (host only — never the password), and refuse fast with the
// pooler recipe on a definitively-wrong endpoint. Pure + exported so the
// classification is unit-tested without a live DB.

const hostFromUrl = (url = '') => {
  const value = String(url || '');
  if (!value) return '';
  try { return new URL(value).hostname.toLowerCase(); }
  catch {
    const m = value.match(/@([^:/?]+)/);
    return (m ? m[1] : '').toLowerCase();
  }
};

const usernameFromUrl = (url = '') => {
  try { return decodeURIComponent(new URL(String(url || '')).username || ''); }
  catch { return ''; }
};

// Classify a DATABASE_URL by its host into the connection kinds that matter here.
// supabase-api / supabase-direct are definitively wrong (Postgres never reachable
// on :5432); supabase-pooler is the target — but the pooler additionally requires
// the project ref embedded in the username (postgres.<ref>), so a plain "postgres"
// against the pooler is its own failure (poolerUsernameMissingRef).
export const classifyDbConnectionTarget = (url = '') => {
  const host = hostFromUrl(url);
  const username = usernameFromUrl(url);
  let kind = 'other';
  if (!host) kind = 'empty';
  else if (host.includes('pooler.supabase.com')) kind = 'supabase-pooler';
  else if (host.startsWith('db.') && host.endsWith('.supabase.co')) kind = 'supabase-direct';
  else if (host.endsWith('.supabase.co')) kind = 'supabase-api';
  else if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host.endsWith('.local')) kind = 'local';
  const poolerUsernameMissingRef = kind === 'supabase-pooler' && Boolean(username) && !username.includes('.');
  return { host, username, kind, poolerUsernameMissingRef };
};

const POOLER_RECIPE = [
  'Use the Supabase connection POOLER (Dashboard → Project → Settings → Database',
  '→ Connection string → "Session pooler"):',
  '    postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres',
  '  Session mode is :5432 (use this for the backfill); transaction mode is :6543.',
  '  The username MUST be postgres.<project-ref> and the host MUST be',
  '  aws-0-<region>.pooler.supabase.com. Set it as DATABASE_URL (env or .env) and re-run.'
].join('\n  ');

// A one-paragraph, actionable diagnosis for a classified target. Definitively-
// wrong kinds name the specific misconfiguration; a correct-looking pooler points
// at the remaining variables (password / region / egress).
export const connectionDiagnosis = (target) => {
  const t = target || { kind: 'empty' };
  switch (t.kind) {
    case 'empty':
      return `DATABASE_URL is not set. ${POOLER_RECIPE}`;
    case 'supabase-api':
      return `host "${t.host}" is the Supabase REST/API endpoint (Cloudflare-fronted) — ` +
        `Postgres is NOT served there, so :5432 times out against Cloudflare IPs. ${POOLER_RECIPE}`;
    case 'supabase-direct':
      return `host "${t.host}" is the Supabase DIRECT database endpoint, which is IPv6-only — ` +
        `from an IPv4-only network it times out. ${POOLER_RECIPE}`;
    case 'supabase-pooler':
      if (t.poolerUsernameMissingRef) {
        return `host "${t.host}" is the pooler (good), but username "${t.username}" is missing the ` +
          `project ref — the pooler requires username postgres.<project-ref>. ${POOLER_RECIPE}`;
      }
      return `host "${t.host}" is the Supabase pooler — the connection target looks correct. ` +
        `If it still times out, check the password, the <region> in the host, and network egress to :5432.`;
    default:
      return `host "${t.host || '(unparseable)'}" — verify it is reachable on the Postgres port. ` +
        `If this is Supabase, ${POOLER_RECIPE}`;
  }
};

// A target whose endpoint can never serve Postgres on :5432 — refuse fast rather
// than hang until the socket times out.
export const isDefinitivelyWrongTarget = (target) =>
  ['empty', 'supabase-api', 'supabase-direct'].includes(target?.kind) ||
  Boolean(target?.poolerUsernameMissingRef);

// Whether an error is a connection/network failure (vs. a query/logic error), so
// the catch can append the pooler guidance only when it's actually relevant.
export const isConnectionError = (err) => {
  if (!err) return false;
  const code = err.code || err.errno || '';
  if (['ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED', 'EAI_AGAIN', 'ECONNRESET'].includes(code)) return true;
  return /timeout|timed out|ETIMEDOUT|ENETUNREACH|getaddrinfo|connect ECONN/i.test(String(err.message || ''));
};

// Which clients under this firm have facts to reconstruct (keyed off the
// firm_facts provenance.client_id convention the backfill reads). Surfaced so the
// operator can pick a client id without guessing it from a fact id.
const listClientsWithFacts = async (client, firmId) => {
  const res = await client.query(
    `select provenance->>'client_id' as client_id,
            count(*)::int as fact_count,
            count(*) filter (where status = 'active')::int as active_count,
            min(subject) as sample_subject
       from firm_facts
      where firm_id = $1 and provenance->>'client_id' is not null
      group by provenance->>'client_id'
      order by fact_count desc`,
    [firmId]
  );
  return res.rows;
};

const main = async () => {
  const args = parseArgv();
  const mode = args.apply ? 'APPLY' : 'DRY-RUN';
  log(`mode=${mode} firm=${args.firmId} client=${args.clientId || '(none — listing)'}`);

  // Echo the resolved connection target (host only — never the password) and
  // refuse fast on a definitively-wrong Supabase endpoint, with the pooler fix,
  // instead of hanging until an opaque socket ETIMEDOUT (rail #3 — diagnose).
  const target = classifyDbConnectionTarget(getFirmDatabaseUrl());
  log(`db target: host=${target.host || '(none)'} kind=${target.kind}`);
  if (isDefinitivelyWrongTarget(target)) {
    log(`✗ ${connectionDiagnosis(target)}`);
    process.exit(1);
  }

  try {
    await withFirmDbClient(async (client) => {
      if (!(await memoryCandidatesTablePresent(client))) {
        log('memory_candidates table is ABSENT — apply migration 036_donna_loops_memory_candidates.sql first, then re-run.');
        return;
      }

      if (!args.clientId) {
        const rows = await listClientsWithFacts(client, args.firmId);
        if (rows.length === 0) {
          log('no firm_facts found for this firm — nothing to backfill.');
          return;
        }
        log(`clients with facts under ${args.firmId} (re-run with --client <id> --apply):`);
        for (const r of rows) {
          log(`  client_id=${r.client_id}  facts=${r.fact_count} (active=${r.active_count})  e.g. "${r.sample_subject}"`);
        }
        return;
      }

      // DMEM-R1 W1: the backfill is a governance ACTION and runs only while the
      // MEMORY_CANDIDATES plane key ACTS for this client (the ONE posture the
      // producers, routes and UI share) — there is no local override any more.
      // `skipped: -1` with the resolved posture means "stage the flag first".
      // dryRun mirrors --apply.
      const summary = await backfillMemoryCandidatesFromFacts({
        client,
        firmId: args.firmId,
        clientId: args.clientId,
        dryRun: !args.apply
      });
      log(`summary: ${JSON.stringify(summary)}`);
      if (summary.skipped === -1) {
        log(`MEMORY_CANDIDATES does not act for this client (posture: ${summary.posture}); stage it canary/auto on the config plane first.`);
        return;
      }

      if (!args.apply) {
        log(`would stage ${summary.scanned} candidate(s) (dry-run); re-run with --apply to commit.`);
        return;
      }

      const staged = await client.query(
        `select status, candidate_type, scope, subject, minted_fact_id
           from memory_candidates
          where firm_id = $1 and client_id = $2
          order by created_at desc`,
        [args.firmId, args.clientId]
      );
      log(`staged ${staged.rows.length} candidate(s):`);
      for (const r of staged.rows) {
        log(`  [${r.status}] ${r.candidate_type}/${r.scope} "${r.subject}" -> fact ${r.minted_fact_id || '(none)'}`);
      }
      log('done. The Memory tab renders while MEMORY_CANDIDATES acts for the client (the same posture this backfill ran under).');
    });
  } catch (err) {
    if (isConnectionError(err)) {
      log(`connection FAILED (${err.code || err.errno || 'error'}): ${connectionDiagnosis(target)}`);
    }
    throw err;
  }
};

const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error('[memory-candidate-backfill] FAILED', err);
      process.exit(1);
    }
  );
}
