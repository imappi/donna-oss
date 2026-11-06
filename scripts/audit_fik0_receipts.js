// FIK-0 — read-only receipt audit (docs/plan-2026-09-22-fi-jev-decision-knowledge.md
// §3 and §8). It counts what the FIK-0a coding receipts say reached each Jev
// decision, so FIK-0b's blast radius is sized from measured delivery rather
// than guessed. It reads the persisted receipts only: no model call, no
// replay, no write (the whole read runs in a READ ONLY transaction, so a write
// anywhere underneath fails instead of landing).
//
// What it does NOT do, by design:
// - It is not the FIK-0 case audit. Cause classification, adjudication and
//   the 20–30 case families are the operator's reviewed work over their
//   approved store; this only supplies the delivery counts that audit needs.
// - A decision coded before FIK-0a carries no delivery receipt. It is counted
//   as `unknown`, never as "no facts were delivered".
// - Only the CURRENT suggestion per line is persisted, so the same line's
//   single-line vs batch deliveries cannot be compared from rows; that
//   comparison needs a controlled re-run. The `source` split is reported as
//   stored, without inferring a path.
// - Output carries ids and counts, never fact text, descriptions or amounts.
//
// Usage (operator, against their own database):
//   DONNA_FIK0_AUDIT_DATABASE_URL=postgres://… node scripts/audit_fik0_receipts.js --firm <firm_id> [--client <client_id> …]
// Set TYPESAFE_MODEL to the host's configured Jev model to resolve
// experiment-enrolled books; without it an experiment basis stays unresolved.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { readJevDecisionPolicy } from '../server/donna/jevTrialProvider.js';
import { getLane } from '../server/donna/modelLanes.js';

export const FIK0_RECEIPT_AUDIT_CONTRACT = 'donna.fik0-receipt-audit.v1';

const receiptOf = suggestion => suggestion?.jev_decision || suggestion?.jev_handoff || null;
const bump = (map, key) => { const k = key ?? 'absent'; map[k] = (map[k] || 0) + 1; };

const asserterList = provenance => Array.isArray(provenance?.asserted_by_clients)
  ? provenance.asserted_by_clients.filter(Boolean).map(String)
  : provenance?.client_id ? [String(provenance.client_id)] : [];

// Pure. `decisions` are { transaction_id, client_id, suggestion }; `facts` are
// the firm_facts rows the receipts name (id, scope, status, provenance,
// effective_from, effective_to); `books` carry the resolved bases.
export const summarizeFik0Receipts = ({ decisions = [], facts = [], books = [] } = {}) => {
  const factsById = new Map(facts.map(fact => [fact.id, fact]));
  const perBook = new Map(books.map(book => [book.client_id, {
    ...book, decisions: 0, instrumented: 0, unknown: 0,
    by_engine: {}, by_jev_basis: {}, by_fact_read_status: {}, by_source: {},
    delivered: { total: 0, by_scope: {}, legacy_firm_scope: 0, fact_row_absent: 0, with_effective_interval: 0 },
    decisions_with_jurisdiction_fact: [], decisions_with_cross_entity_legacy_fact: [], decisions_with_read_failure: []
  }]));
  for (const { transaction_id, client_id, suggestion } of decisions) {
    const book = perBook.get(client_id);
    if (!book) continue;
    const receipt = receiptOf(suggestion);
    book.decisions += 1;
    bump(book.by_engine, suggestion?.decision_engine);
    bump(book.by_source, suggestion?.source);
    // FIK-0a's marker is the digest list; without it the delivery is unknown.
    if (!receipt || !Array.isArray(receipt.request_sha256s)) { book.unknown += 1; continue; }
    book.instrumented += 1;
    bump(book.by_jev_basis, receipt.jev_basis);
    bump(book.by_fact_read_status, receipt.fact_read_status);
    if (receipt.fact_read_status === 'read_failed') book.decisions_with_read_failure.push(transaction_id);
    let jurisdiction = false, crossEntity = false;
    for (const delivered of Array.isArray(receipt.delivered_facts) ? receipt.delivered_facts : []) {
      book.delivered.total += 1;
      bump(book.delivered.by_scope, delivered.scope);
      if (delivered.scope === 'jurisdiction') jurisdiction = true;
      const row = delivered.id ? factsById.get(delivered.id) : null;
      if (!row) { book.delivered.fact_row_absent += 1; }
      else if (row.effective_from || row.effective_to) book.delivered.with_effective_interval += 1;
      if (delivered.legacy_firm_scope) {
        book.delivered.legacy_firm_scope += 1;
        // §2: a legacy firm-wide fact is admitted only to its own asserters.
        // A row that no longer exists cannot be judged either way.
        if (row && !asserterList(row.provenance).includes(String(client_id))) crossEntity = true;
      }
    }
    if (jurisdiction) book.decisions_with_jurisdiction_fact.push(transaction_id);
    if (crossEntity) book.decisions_with_cross_entity_legacy_fact.push(transaction_id);
  }
  const rows = [...perBook.values()];
  const sum = key => rows.reduce((total, book) => total + book[key], 0);
  const count = key => rows.reduce((total, book) => total + book[key].length, 0);
  return {
    contract: FIK0_RECEIPT_AUDIT_CONTRACT,
    totals: {
      books: rows.length, decisions: sum('decisions'), instrumented: sum('instrumented'), unknown: sum('unknown'),
      decisions_with_jurisdiction_fact: count('decisions_with_jurisdiction_fact'),
      decisions_with_cross_entity_legacy_fact: count('decisions_with_cross_entity_legacy_fact'),
      decisions_with_read_failure: count('decisions_with_read_failure')
    },
    books: rows
  };
};

// The ONE owner of the basis decision is readJevDecisionPolicy; the audit
// asks it what each book would resolve to on each host shape, never a copy of
// its predicate. The synthetic env names a host shape only — no credential.
const hostEnvs = model => {
  const key = getLane('jev_reconciliation').desktopDefault.modelEnvironmentKey;
  return {
    desktop: { DONNA_DESKTOP_BLOB_DIR: '/fik0-audit', [key]: model },
    hosted: { VERCEL: '1', VERCEL_PROJECT_ID: 'fik0-audit', VERCEL_ENV: 'production', VERCEL_DEPLOYMENT_ID: 'fik0-audit',
      VERCEL_GIT_COMMIT_SHA: 'fik0-audit', DATABASE_URL: 'postgres://fik0-audit.invalid/db', SUPABASE_URL: 'https://fik0-audit.invalid', [key]: model }
  };
};
const resolveBasis = async ({ client, firmId, clientId, env }) => {
  await client.query('savepoint fik0_basis');
  try {
    const { policy } = await readJevDecisionPolicy({ client, firmId, clientId, env });
    await client.query('release savepoint fik0_basis');
    return { basis: policy.basis };
  } catch (error) {
    await client.query('rollback to savepoint fik0_basis');
    return { basis: null, code: error.code || 'basis_unresolved' };
  }
};

export const auditFik0Receipts = async ({ client, firmId, clientIds = [], model = '' }) => {
  if (!firmId) throw Object.assign(new Error('--firm is required'), { code: 'FIK0_AUDIT_FIRM_REQUIRED' });
  await client.query('begin isolation level repeatable read read only');
  try {
    const bookRows = (await client.query(`select id, jurisdiction, entity_type from clients
      where firm_id=$1 and ($2::text[] is null or id = any($2::text[])) order by id`,
    [firmId, clientIds.length ? clientIds : null])).rows;
    const envs = hostEnvs(model || 'fik0-audit-model-not-supplied');
    const books = [];
    for (const row of bookRows) {
      books.push({ client_id: row.id, jurisdiction: row.jurisdiction, entity_type: row.entity_type,
        resolved_basis: {
          desktop: await resolveBasis({ client, firmId, clientId: row.id, env: envs.desktop }),
          hosted: await resolveBasis({ client, firmId, clientId: row.id, env: envs.hosted })
        } });
    }
    const decisions = (await client.query(`select id as transaction_id, client_id, payload->'ai_suggestion' as suggestion
      from transactions where firm_id=$1 and client_id = any($2::text[])
        and (payload->'ai_suggestion'->>'decision_engine' in ('jev','strong_after_jev')
          or payload->'ai_suggestion' ? 'jev_decision' or payload->'ai_suggestion' ? 'jev_handoff')
      order by client_id, id`, [firmId, bookRows.map(row => row.id)])).rows;
    const ids = [...new Set(decisions.flatMap(({ suggestion }) =>
      (receiptOf(suggestion)?.delivered_facts || []).map(fact => fact.id).filter(Boolean)))];
    const facts = ids.length ? (await client.query(`select id, scope, status, provenance, effective_from, effective_to
      from firm_facts where firm_id=$1 and id = any($2::text[])`, [firmId, ids])).rows : [];
    const identity = (await client.query("select now() as observed_at, current_setting('transaction_read_only') as read_only")).rows[0];
    await client.query('rollback');
    return { ...summarizeFik0Receipts({ decisions, facts, books }), firm_id: firmId,
      model_supplied: Boolean(model), observed_at: identity.observed_at, read_only: identity.read_only };
  } catch (error) { await client.query('rollback'); throw error; }
};

const parseArgs = argv => {
  const out = { firmId: '', clientIds: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--firm') out.firmId = String(argv[++i] || '');
    else if (argv[i] === '--client') out.clientIds.push(String(argv[++i] || ''));
    else throw Object.assign(new Error(`Unknown argument ${argv[i]}`), { code: 'FIK0_AUDIT_ARGUMENT' });
  }
  return out;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let client;
  try {
    const args = parseArgs(process.argv.slice(2));
    // Deliberately its own nonempty URL: never localhost, a developer .env or
    // Donna's own DATABASE_URL by accident.
    const connectionString = String(process.env.DONNA_FIK0_AUDIT_DATABASE_URL || '').trim();
    if (!/^postgres(?:ql)?:\/\//.test(connectionString)) throw Object.assign(new Error(), { code: 'FIK0_AUDIT_URL_REQUIRED' });
    client = new pg.Client({ connectionString, connectionTimeoutMillis: 10000, statement_timeout: 30000,
      application_name: 'donna-fik0-read-only-receipt-audit' });
    await client.connect();
    const report = await auditFik0Receipts({ client, ...args, model: String(process.env.TYPESAFE_MODEL || '').trim() });
    report.source_commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status: 'INCOMPLETE', code: error.code || 'FIK0_AUDIT_FAILED' }));
    process.exitCode = 1;
  } finally { if (client) await client.end(); }
}
