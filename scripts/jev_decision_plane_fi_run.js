// FIK-3 — the Finnish coding lane's runtime (offline research only). Each arm
// of each frozen case gets its OWN disposable PostgreSQL book, cloned from a
// migrated template, seeded through the real config writer, and coded by the
// REAL coder (`batchSuggestTransactionCodingInDb`), auto-post writer and ask
// sweep. Every provider request the coder makes is routed through the runner's
// shared `obtain` (spend ledger, reservation, resume, replay, checkpoints); the
// consequence is read back from the book afterwards. Local disposable
// PostgreSQL only; nothing here can reach a real book.
import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { runEval } from '../server/donna/evalHarness.js';
import { hash } from '../server/donna/jevEvidenceContract.js';
import { fetchProviderJson } from '../server/donna/providerTransport.js';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from '../server/donna/firmDb.js';
import { batchSuggestTransactionCodingInDb, resolveClientCodingPolicyWithClient, CODING_PROVIDER_FAILURE_PAYLOAD_KEY } from '../server/donna/db/coding.js';
import { sweepCodingAutoPost } from '../server/donna/codingAutoPost.js';
import { enrollJevExperiment } from '../server/donna/jevExperimentPolicy.js';
import { canonicalFactSubject, CODING_FACT_ADMISSION_FLAG } from '../server/donna/firmFacts.js';
import { FI_JEV_DECISION_GUIDANCE_FLAG } from '../server/donna/codingGuidanceVariant.js';
import { FI_GUIDANCE_VARIANT, __runWithFiProvisionalGuidanceForHarness } from '../server/donna/finland/decisionGuidance.js';
import { codingPolicyReceipt } from '../server/donna/codingPolicy.js';
import { setClientFlagStage } from '../server/donna/clientConfig.js';
import { settleCommittedConvergenceMarks, recomputeConvergenceDrift } from '../server/donna/reconcileConvergenceState.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TYPESAFE_TIMEOUT_MS, MAX_TIMEOUT_MS, runDecisionPlane, savePrivate, publicSummary } from './jev_decision_plane.js';
import { verifyBudget } from './jev_decision_plane_protocol.js';
import { CODING_DEFAULT_MODEL } from '../server/donna/transactionLlm.js';
import { FI_VERSION, FI_LANE, FI_CORPUS, FI_SPLITS, FI_ARMS, FI_COMPARATOR_ARM, FI_PROVISIONAL_ARM, ARM_SPEC, loadFiProvisionalGuidance, loadFiCorpus, fiCorpusDigest, fiCodeHashes, validateFiCase, checkSplit,
  verifyPreregistration, verifyBaselineSummary, assertHoldoutUnread, consumeHoldout, assertHoldoutReadBy, verifyFiPlan, assertArmsDifferOnlyInPolicy,
  estimateFiRequest, verifyFiBudget, buildFiReport, scoreFiOutcome, emptyHoldoutLedger } from './jev_decision_plane_fi.js';

const fail = code => { throw new Error(code); };
const sha256 = text => createHash('sha256').update(text).digest('hex');
export const LOCAL_HOSTS = Object.freeze(['localhost', '127.0.0.1', '[::1]']);
export const assertLocalPostgres = url => { if (!url || !LOCAL_HOSTS.includes(new URL(url).hostname)) fail('local_disposable_postgres_required'); return url; };
const dbUrl = (adminUrl, name) => { const u = new URL(adminUrl); u.pathname = `/${name}`; return u.toString(); };

// The book every arm shares: one firm, the case's legal entity and any sibling
// entities it names, neutral ids (no case id, family or label reaches a
// request). Common flags are the FIK-0b admission and the FI coding/posting
// path; the arm adds only Jev (A, D, P) and, for D, the FIK-2 guidance flag.
// The provisional arm P stages exactly A's flags: no flag selects its content.
export const FIRM_ID = 'firm-1', ENTITY_ID = 'entity-1', LINE_ID = 'line-1', DOC_ID = 'doc-1', MATCH_ID = 'match-1', ACTOR_ID = 'fik3-operator';
export const COMMON_FLAGS = Object.freeze(['JURISDICTION_ACCOUNT_PALETTE', 'FINLAND_ALV_CODING', 'CODING_AUTO_POST', CODING_FACT_ADMISSION_FLAG]);
export const armFlags = arm => [...COMMON_FLAGS, ...(ARM_SPEC[arm].engine === 'jev' ? ['JEV_RECONCILIATION'] : []), ...(ARM_SPEC[arm].guidanceVariant === FI_GUIDANCE_VARIANT ? [FI_JEV_DECISION_GUIDANCE_FLAG] : [])];
export const armsFor = (planCase, comparator, provisional = false) => [...FI_ARMS, ...(comparator && planCase.strong_is_alternative ? [FI_COMPARATOR_ARM] : []), ...(provisional ? [FI_PROVISIONAL_ARM] : [])];
export const seedOf = c => structuredClone({ entity: c.entity, sibling_entities: c.sibling_entities || [], book: c.book, facts: c.facts, transaction: c.transaction, document: c.document });

// ── Disposable databases ────────────────────────────────────────────────────
export async function createTemplate(adminUrl) {
  assertLocalPostgres(adminUrl);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const name = `fik3_tpl_${process.pid}_${Date.now().toString(36)}`;
  let n = 0;
  await admin.query(`create database "${name}"`);
  const pool = new pg.Pool({ connectionString: dbUrl(adminUrl, name) });
  try {
    await pool.query(`create schema storage;
      create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
      create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb);`);
    const root = new URL('../db/migrations/', import.meta.url);
    for (const file of (await readdir(root)).filter(f => f.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, root), 'utf8'));
  } finally { await pool.end(); }
  return {
    name,
    async clone() {
      const db = `${name}_${++n}`;
      await admin.query(`create database "${db}" template "${name}"`);
      const pool = new pg.Pool({ connectionString: dbUrl(adminUrl, db) });
      const closed = [];
      pool.on('connect', c => closed.push(new Promise(r => c.once('end', r))));
      return { pool, async drop() { await pool.end(); await Promise.all(closed); await admin.query(`drop database if exists "${db}"`); } };
    },
    async drop() { try { await admin.query(`drop database if exists "${name}"`); } finally { await admin.end(); } }
  };
}

const entityIds = seed => Object.fromEntries([seed.entity, ...seed.sibling_entities].map((key, i) => [key, `entity-${i + 1}`]));
export async function seedBook(pool, seed, arm, models) {
  const ids = entityIds(seed), client = await pool.connect();
  try {
    await client.query("insert into firms (id, name, slug) values ($1, 'Synthetic firm', 'fik3-synthetic')", [FIRM_ID]);
    await client.query("insert into firm_members (id, firm_id, email, name, role, status) values ('member', $1, 'fixture@example.invalid', 'Fixture', 'admin', 'active')", [FIRM_ID]);
    for (const [key, id] of Object.entries(ids)) {
      const profile = { jurisdiction: 'fi', accounting_system: 'none', accounting_basis: seed.book.accounting_basis || 'accrual' };
      await client.query('insert into clients (id, firm_id, company_name, jurisdiction, entity_type, profile) values ($1, $2, $3, $4, $5, $6::jsonb)',
        [id, FIRM_ID, key === seed.entity ? seed.book.company_name : `Sibling ${id} Oy`, 'fi', seed.book.entity_type, JSON.stringify(profile)]);
    }
    for (const flagKey of armFlags(arm)) await setClientFlagStage(client, { firmId: FIRM_ID, clientId: ENTITY_ID, flagKey, stage: 'canary', reason: 'FIK-3 offline comparison book', actorId: ACTOR_ID });
    if (ARM_SPEC[arm].engine === 'jev') await enrollJevExperiment({ client, firmId: FIRM_ID, clientId: ENTITY_ID, actorId: 'member', authorityBasis: 'FIK-3 offline comparison (disposable book)',
      trialId: 'fik3-offline', expiresAt: '2100-01-01', model: models.jev });
    // Memory as a book holds it: entity-keyed rows, legacy firm-keyed merchant
    // rows with their asserters, and jurisdiction rows the admission excludes.
    for (const [i, f] of seed.facts.entries()) {
      const asserters = (f.asserted_by || [seed.entity]).map(k => ids[k] ?? fail('unknown_fact_asserter'));
      const provenance = { source: 'fik3-fixture', client_id: asserters[0], asserted_by_clients: asserters, ...(f.entity ? { entity_client_id: ids[f.entity] ?? fail('unknown_fact_entity') } : {}) };
      const subject = f.scope === 'firm' ? FIRM_ID : canonicalFactSubject({ scope: f.scope, value: f.subject });
      await client.query(`insert into firm_facts (id, firm_id, scope, subject, fact, provenance, confidence, model, status)
        values ($1, $2, $3, $4, $5, $6::jsonb, 'medium', 'firm_operator', 'active')`, [`fact-${i + 1}`, FIRM_ID, f.scope, subject, f.fact, JSON.stringify(provenance)]);
    }
    const t = seed.transaction;
    await client.query(`insert into transactions (id, firm_id, client_id, transaction_date, description, money_in, money_out, currency, status, payload)
      values ($1, $2, $3, $4, $5, $6, $7, $8, 'needs_review', '{}'::jsonb)`, [LINE_ID, FIRM_ID, ENTITY_ID, t.date, t.description, t.money_in, t.money_out, t.currency]);
    const d = seed.document;
    if (d) {
      const sale = d.document_type === 'sales_invoice';
      await client.query(`insert into documents (id, firm_id, client_id, filename, document_type, parse_status, document_date, currency, total_amount, tax_amount, parse_summary, vendor_name, customer_name)
        values ($1, $2, $3, 'source.pdf', $4, 'completed', $5, 'EUR', $6, $7, $8::jsonb, $9, $10)`,
      [DOC_ID, FIRM_ID, ENTITY_ID, d.document_type, d.document_date || t.date, d.total_amount, d.tax_amount, JSON.stringify({ line_amounts_include_tax: d.line_amounts_include_tax !== false }),
        sale ? null : d.party || null, sale ? d.party || null : null]);
      for (const [i, l] of d.lines.entries()) await client.query(`insert into document_lines (id, firm_id, client_id, document_id, line_no, description, amount, tax_rate, payload)
        values ($1, $2, $3, $4, $5, $6, $7, $8, '{}'::jsonb)`, [`${DOC_ID}-line-${i + 1}`, FIRM_ID, ENTITY_ID, DOC_ID, i + 1, l.description, l.amount, l.tax_rate]);
      await client.query(`insert into reconciliation_matches (id, firm_id, client_id, bank_transaction_id, matched_object_type, matched_object_id, status, match_amount, match_confidence, payload)
        values ($1, $2, $3, $4, $5, $6, $7, $8, 0.99, '{}'::jsonb)`, [MATCH_ID, FIRM_ID, ENTITY_ID, LINE_ID, d.document_type, DOC_ID, d.match_status, d.total_amount]);
    }
  } finally { client.release(); }
}

// ── What the book holds afterwards (structured; no prose, no model id) ──────
const minProbability = receipt => {
  const ps = [receipt?.probability, ...Object.values(receipt?.answers || {}).map(a => a?.probability), ...(receipt?.composition || []).flatMap(p => Object.values(p.answers || {}).map(a => a?.probability))];
  const xs = ps.filter(p => typeof p === 'number' && Number.isFinite(p));
  return xs.length ? Math.min(...xs) : null;
};
// The coder's persisted decision on one transaction payload (structured; no
// prose, no model id). Shared with the Kultalanka month scorer.
export function decisionFromPayload(payload) {
  const s = payload?.ai_suggestion || null, jev = s?.jev_decision || s?.jev_handoff || null;
  return s ? { engine: s.decision_engine ?? (jev ? null : 'strong'), selected: jev?.selected ?? null, jev_terminal: jev?.terminal ?? null, account: s.proposed_account ?? null, tax_treatment: s.tax_treatment ?? null,
    posting_requirement: s.posting_requirement ?? null, strong_handoff: s.decision_engine === 'strong_after_jev', handoff_cause: s.jev_handoff?.cause ?? null,
    tax_unresolved: jev?.tax_unresolved ?? null, deciding_probability: s.decision_engine === 'jev' ? minProbability(jev) : null, choice_mode: jev?.choice_mode ?? null,
    coding_policy: s.coding_policy ?? null, delivered_facts: jev?.delivered_facts ?? null, fact_read_status: jev?.fact_read_status ?? null, jev_basis: jev?.jev_basis ?? null,
    request_sha256s: jev?.request_sha256s ?? null } : null;
}
export const providerFailureOf = payload => { const failure = payload?.[CODING_PROVIDER_FAILURE_PAYLOAD_KEY]; return failure ? (failure.code || 'provider_failure') : null; };
export async function readSnapshot(pool) {
  const tx = (await pool.query('select coding_state, status, convergence_state, convergence_reason, payload from transactions where id = $1', [LINE_ID])).rows[0];
  const journals = (await pool.query(`select j.id, j.source_type, j.source_id, j.status, l.line_no, l.account_code, l.account_name, l.direction, l.amount, l.tax_type, l.payload->>'role' as role
    from ledger_journals j left join ledger_lines l on l.journal_id = j.id where j.firm_id = $1 and j.source_id = any($2::text[]) order by j.id, l.line_no`, [FIRM_ID, [LINE_ID, DOC_ID]])).rows;
  const byJournal = new Map();
  for (const r of journals) {
    const j = byJournal.get(r.id) || byJournal.set(r.id, { source_type: r.source_type, status: r.status, lines: [] }).get(r.id);
    if (r.line_no != null) j.lines.push({ role: r.role, account: r.account_code || r.account_name, direction: r.direction, amount: Number(r.amount), tax_code: r.tax_type || 'NONE' });
  }
  const asks = (await pool.query('select evidence_type, status from client_evidence_requests where firm_id = $1 and transaction_id = $2 order by id', [FIRM_ID, LINE_ID])).rows;
  const reconciliation = (await pool.query('select id, matched_object_id, status from reconciliation_matches where firm_id = $1 and bank_transaction_id = $2 order by id', [FIRM_ID, LINE_ID])).rows
    .map(m => ({ matched_object_id: m.matched_object_id, status: m.status, seeded: m.id === MATCH_ID }));
  const drift = await recomputeConvergenceDrift(pool, { firmId: FIRM_ID, clientId: ENTITY_ID, sampleLimit: 50 });
  const drifted = (drift?.drifted_sample || []).find(x => x.target_type === 'transaction' && x.target_id === LINE_ID);
  return {
    coding_state: tx.coding_state,
    provider_failure: providerFailureOf(tx.payload),
    decision: decisionFromPayload(tx.payload),
    refusal: tx.payload?.ledger_post_refusal?.code ?? null,
    journals: [...byJournal.values()], asks, reconciliation,
    convergence: { state: tx.convergence_state, reason: tx.convergence_reason, drift: Boolean(drifted), derived: drifted ? drifted.derived : null }
  };
}

// ── One arm on one case ─────────────────────────────────────────────────────
const PROVIDER_URLS = [['typesafe', /^https:\/\/api\.typesafe\.ai\//], ['openai', /^https:\/\/api\.openai\.com\/v1\/responses$/]];
const providerOf = url => PROVIDER_URLS.find(([, re]) => re.test(String(url)))?.[0] ?? null;
const ENV_KEYS = ['TYPESAFE_API_KEY', 'TYPESAFE_MODEL', 'OPENAI_API_KEY', 'OPENAI_MODEL'];
// `onRequest(provider, request, url, init)` answers one provider request; any
// other external request (a merchant web lookup) is refused and counted: the
// offline replay has no merchant web context, and the snapshot says so.
// `provisional`: the frozen draft entries, required by and only by arm P; the
// whole arm (coder, writer, sweep) runs inside the renderer's harness scope.
export async function runArm({ provisional = null, ...args }) {
  if ((args.arm === FI_PROVISIONAL_ARM) !== Boolean(provisional)) fail('provisional_entries_only_for_provisional_arm');
  if (!provisional) return runArmInBook(args);
  const { result, renderedEntryIds } = await __runWithFiProvisionalGuidanceForHarness(provisional, () => runArmInBook(args));
  return { ...result, provisional_entry_ids: renderedEntryIds };
}
async function runArmInBook({ template, seed, arm, models, onRequest, offline = false, tolerate = () => false }) {
  const { pool, drop } = await template.clone();
  const saved = { fetch: globalThis.fetch, env: Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]])) };
  let unplanned = 0, harnessError = null;
  try {
    __setFirmDbPoolForTests(pool);
    // The frozen models are the coder's models (Jev enrollment checks its own).
    Object.assign(process.env, { TYPESAFE_MODEL: models.jev, OPENAI_MODEL: models.strong, ...(offline ? { TYPESAFE_API_KEY: 'fik3-offline', OPENAI_API_KEY: 'fik3-offline' } : {}) });
    await seedBook(pool, seed, arm, models);
    const policy = await resolveClientCodingPolicyWithClient({ client: pool, firmId: FIRM_ID, clientId: ENTITY_ID, businessDate: seed.transaction.date });
    globalThis.fetch = async (url, init = {}) => {
      const provider = providerOf(url);
      if (!provider) { unplanned++; throw new Error('fik3_unplanned_external_request_refused'); }
      try { return await onRequest(provider, JSON.parse(init.body), String(url), init); }
      catch (error) { if (error?.fik3Harness) harnessError ||= error; throw error; }
    };
    const start = performance.now();
    try {
      await batchSuggestTransactionCodingInDb({ firmId: FIRM_ID, clientIds: [ENTITY_ID], limit: 5, autoApply: true });
      await sweepCodingAutoPost({ firmId: FIRM_ID, clientId: ENTITY_ID });
    } catch (error) { if (harnessError || !tolerate(error)) throw harnessError || error; }
    const settle = await pool.connect();
    try { await settleCommittedConvergenceMarks(settle); } finally { settle.release(); }
    const wall_ms = Math.round(performance.now() - start);
    globalThis.fetch = saved.fetch;
    if (harnessError) throw harnessError;
    return { policy, snapshot: { ...(await readSnapshot(pool)), unplanned_requests: unplanned, timing: { wall_ms } } };
  } finally {
    globalThis.fetch = saved.fetch;
    for (const [k, v] of Object.entries(saved.env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    __resetFirmDbPoolForTests();
    await drop();
  }
}
const harness = (code, cause) => Object.assign(new Error(code, cause ? { cause } : undefined), { fik3Harness: true });

// ── Freeze ──────────────────────────────────────────────────────────────────
// The plan freezes each arm's FIRST request exactly as the coder built it,
// proves A and D differ only in their policy, and binds the labels, the
// corpus, the code and — for a holdout — the pre-registration into its digest.
export async function captureFirstRequest({ template, seed, arm, models, provisional = null }) {
  let first = null;
  // The coder handles a failed Jev request itself; the strong path rethrows
  // a non-provider error, which is tolerated here and only here.
  const { policy, snapshot, provisional_entry_ids } = await runArm({ template, seed, arm, models, provisional, offline: true, tolerate: error => error?.message === 'fik3_capture_complete', onRequest: async (provider, request, url) => {
    if (!first) first = { provider, request, url };
    throw new Error('fik3_capture_complete');
  } });
  if (!first) fail(`no_provider_request:${arm}`);
  return { ...first, policy: { taxInstructions: policy.taxInstructions, receipt: codingPolicyReceipt(policy) }, delivered_facts: first.request?.state?.known_facts ?? null, snapshot,
    ...(provisional_entry_ids ? { provisional_entry_ids } : {}) };
}
// `provisional`: a record from loadFiProvisionalGuidance (an explicit file);
// it adds the development-only arm P and is frozen whole into the plan.
export async function buildFiPlan({ adminUrl, corpus = FI_CORPUS, split = 'development', comparator = false, models, preregistration = null, baselineSummary = null, holdoutLedger = null, cases: filter = null, provisional = null } = {}) {
  assertLocalPostgres(adminUrl);
  if (!FI_SPLITS.includes(split)) fail('invalid_selection');
  if (provisional && split === 'holdout') fail('provisional_arm_not_allowed_on_holdout');
  if (!models?.jev?.trim() || !models?.strong?.trim()) fail('missing_credentials_or_model');
  const fixtures = loadFiCorpus(corpus);
  fixtures.forEach(validateFiCase);
  if (!fixtures.length || new Set(fixtures.map(f => f.id)).size !== fixtures.length) fail('invalid_corpus');
  checkSplit(fixtures);
  const corpusSha = fiCorpusDigest(fixtures);
  if (filter !== null && (!Array.isArray(filter) || !filter.length || filter.some(id => !fixtures.some(f => f.id === id && f.split === split)))) fail('unknown_case');
  const selected = [...fixtures].sort((a, b) => a.id.localeCompare(b.id)).filter(f => f.split === split && (!filter || filter.includes(f.id)));
  if (!selected.length) fail('empty_selection');
  let prereg = null;
  if (split === 'holdout') {
    if (!preregistration) fail('preregistration_required');
    prereg = verifyPreregistration(preregistration, { corpus, corpusSha256: corpusSha });
    if (!baselineSummary) fail('baseline_summary_required');
    verifyBaselineSummary(baselineSummary, prereg);
    if (!holdoutLedger) fail('holdout_ledger_required');
    assertHoldoutUnread(holdoutLedger, corpus, selected.map(f => f.id));
  } else if (preregistration) fail('preregistration_is_for_holdout');
  const template = await createTemplate(adminUrl);
  const cases = [], jobs = [];
  try {
    for (const f of selected) {
      const seed = seedOf(f), captured = {};
      for (const arm of armsFor(f, comparator, Boolean(provisional))) captured[arm] = await captureFirstRequest({ template, seed, arm, models, provisional: arm === FI_PROVISIONAL_ARM ? provisional.entries : null });
      const arm_check = assertArmsDifferOnlyInPolicy(f.id, captured);
      const arms = Object.fromEntries(Object.entries(captured).map(([arm, c]) => [arm, { guidance_variant: ARM_SPEC[arm].guidanceVariant, policy_receipt: c.policy.receipt,
        guidance_digest: c.policy.receipt.guidanceDigest ?? null, policy_text_sha256: sha256(c.policy.taxInstructions), delivered_facts: c.delivered_facts, first_provider: c.provider,
        ...(arm === FI_COMPARATOR_ARM ? { source_packet_sha256: hash(c.request) } : {}), ...(arm === FI_PROVISIONAL_ARM ? { provisional_entry_ids: c.provisional_entry_ids } : {}) }]));
      cases.push({ id: f.id, split: f.split, family: f.family, entity: f.entity, sibling_entities: f.sibling_entities || [], period: f.period, decision_class: f.decision_class,
        strong_is_alternative: f.strong_is_alternative, seed, labels: structuredClone(f.labels), expressible: structuredClone(f.expressible), arms, arm_check });
      for (const [arm, c] of Object.entries(captured)) jobs.push({ id: `${f.id}/${arm}`, case_id: f.id, split: f.split, arm, provider: c.provider, request: c.request, request_sha256: hash(c.request), estimate: estimateFiRequest(c.request, c.provider) });
    }
  } finally { await template.drop(); }
  const plan = { version: FI_VERSION, lane: FI_LANE, corpus, split, arms: [...FI_ARMS, ...(comparator ? [FI_COMPARATOR_ARM] : []), ...(provisional ? [FI_PROVISIONAL_ARM] : [])], models_frozen: true, models: { jev: models.jev, strong: models.strong },
    arm_spec: ARM_SPEC, book_flags: Object.fromEntries(Object.keys(ARM_SPEC).map(arm => [arm, armFlags(arm)])), code_hashes: fiCodeHashes(), corpus_sha256: corpusSha, cases, jobs,
    ...(prereg ? { preregistration: prereg, preregistration_sha256: hash(prereg) } : {}), ...(provisional ? { provisional_guidance: structuredClone(provisional) } : {}) };
  return { ...plan, plan_sha256: hash(plan) };
}

// ── The lane the shared runner drives ───────────────────────────────────────
// `holdoutLedger`: { read(), write(ledger) } — required to run or replay any
// plan holding holdout cases (the CLI keeps it in a private file). `offline`:
// a fixture provider answers (tests); the coder gets placeholder keys.
export function makeFiLane({ adminUrl = null, holdoutLedger = null, offline = false, now = () => new Date().toISOString() } = {}) {
  const outcomes = new Map(), pending = new Map();
  const originalFetch = globalThis.fetch;
  const jobOfRecord = (plan, id) => plan.jobs.find(j => id === j.id || (typeof id === 'string' && id.startsWith(`${j.id}/`) && /^\d+$/.test(id.slice(j.id.length + 1))));
  return {
    version: FI_VERSION, verifyPlan: verifyFiPlan, jobOfRecord, estimateRequest: estimateFiRequest, verifyBudget: verifyFiBudget,
    checkCredentials: plan => { if (!offline && (!process.env.TYPESAFE_API_KEY?.trim() || !process.env.OPENAI_API_KEY?.trim() || !plan.models?.jev || !plan.models?.strong)) fail('missing_credentials_or_model'); },
    // The coder's own request, as built, to the coder's own endpoint and
    // headers; the answer flows back to the coder and onto the ledger.
    async dispatch({ provider, request }, { fetchImpl } = {}) {
      const sent = pending.get(hash(request)) || fail('dispatch_without_pending_request');
      let result;
      try { result = await fetchProviderJson({ provider, url: sent.url, fetchImpl: fetchImpl || originalFetch, timeoutMs: provider === 'typesafe' ? TYPESAFE_TIMEOUT_MS : MAX_TIMEOUT_MS, init: { ...sent.init, redirect: 'error' } }); }
      catch (error) { throw new Error('provider_transport_failure', { cause: error }); }
      if (!result.ok) {
        const body = result.payload && typeof result.payload === 'object' ? result.payload : null;
        throw new Error(`provider_http_${result.status}`, { cause: { code: 'PROVIDER_HTTP', status: result.status, reason: typeof body?.error?.type === 'string' ? body.error.type : null, detail: typeof body?.error?.message === 'string' ? body.error.message : null } });
      }
      return result.payload;
    },
    async evaluate({ plan, mode, ranAt, replay, resuming = false, obtain, isStopped }) {
      // One-shot holdout: the read is recorded before the first holdout request;
      // a replay may re-read only what this plan recorded.
      if (plan.cases.some(c => c.split === 'holdout')) {
        if (!holdoutLedger) fail('holdout_ledger_required');
        const ledger = await holdoutLedger.read();
        if (mode === 'live') await holdoutLedger.write(consumeHoldout(ledger, plan, { at: now(), resuming }));
        else assertHoldoutReadBy(ledger, plan);
      }
      const template = mode === 'live' ? await createTemplate(assertLocalPostgres(adminUrl)) : null;
      const caseOf = id => plan.cases.find(c => c.id === id);
      // A first request the plan did not freeze means the plan no longer
      // describes this code and configuration: the whole run stops there.
      let halted = null;
      try {
        return await runEval({ suite: FI_VERSION, mode, ranAt, fixtures: plan.jobs,
          scorer: (job, snapshot) => { const s = scoreFiOutcome(caseOf(job.case_id), snapshot); return { status: s.correct_complete ? 'pass' : 'fail', truePositive: Number(s.correct_complete), falsePositive: Number(!s.correct_complete), falseNegative: Number(!s.correct_complete), expectedSize: 1, actualSize: 1 }; },
          runner: async job => {
            if (isStopped() || halted) throw new Error('not_attempted_after_failure');
            const meta = n => ({ kind: n === 1 ? 'initial' : 'follow_on', case_id: job.case_id, arm: job.arm });
            let snapshot;
            if (mode === 'replay') {
              snapshot = replay?.lane_outcomes?.[job.id] || fail('replay_outcome_missing');
              if (snapshot.request_refs[0]?.id !== job.id || snapshot.request_refs[0]?.request_sha256 !== job.request_sha256) fail('replay_record_mismatch');
              for (const [i, ref] of snapshot.request_refs.entries()) await obtain(ref.id, ref.provider, null, ref.request_sha256, meta(i + 1), raw => raw);
            } else {
              const refs = [];
              const { snapshot: snap } = await runArm({ template, seed: caseOf(job.case_id).seed, arm: job.arm, models: plan.models, offline,
                provisional: job.arm === FI_PROVISIONAL_ARM ? plan.provisional_guidance.entries : null, onRequest: async (provider, request, url, init) => {
                const n = refs.length + 1, id = n === 1 ? job.id : `${job.id}/${n}`, requestSha = hash(request);
                if (n === 1 && (requestSha !== job.request_sha256 || provider !== job.provider)) throw (halted = harness('frozen_request_mismatch'));
                pending.set(requestSha, { url, init });
                let got;
                try { got = await obtain(id, provider, request, requestSha, meta(n), raw => raw); }
                catch (error) { throw harness(error.message, error); }
                finally { pending.delete(requestSha); }
                refs.push({ id, provider, request_sha256: requestSha, wire_sha256: sha256(init.body) });
                return new Response(JSON.stringify(got.receipt.raw), { status: 200, headers: { 'content-type': 'application/json' } });
              } });
              // The FIK-0a receipt names the exact bytes each Jev request carried.
              const wire = refs.filter(r => r.provider === 'typesafe').map(r => r.wire_sha256);
              snapshot = { ...snap, request_refs: refs, request_receipt_consistent: snap.decision?.request_sha256s ? hash(snap.decision.request_sha256s) === hash(wire.slice(0, snap.decision.request_sha256s.length)) : null };
            }
            outcomes.set(job.id, snapshot);
            return snapshot;
          } });
      } finally { if (template) await template.drop(); }
    },
    buildReport: (plan, records, rejected) => buildFiReport(plan, records, rejected, outcomes),
    checkpointExtras: () => ({ lane: FI_LANE, lane_outcomes: Object.fromEntries(outcomes) }),
    resultExtras: () => ({ lane: FI_LANE, lane_outcomes: Object.fromEntries(outcomes) })
  };
}

// ── CLI (`node scripts/jev_decision_plane.js --lane=fi-coding …`) ────────────
// dry-run freezes a plan (a holdout plan needs --preregistration, --baseline
// and --holdout-ledger; --provisional=<file> adds the development-only draft
// arm P, frozen into the plan); live runs it under --budget; replay reproduces the
// report from a result with no network and no database. Paths are private
// files (0600); outputs must be fresh.
export const fileHoldoutLedger = path => ({ read: () => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : emptyHoldoutLedger(), write: ledger => savePrivate(path, ledger) });
export async function mainFi(args) {
  const read = p => JSON.parse(readFileSync(p, 'utf8'));
  const paths = [args.plan, args.output, args.replay, args.budget, args.public, args.resume, args.preregistration, args.baseline, args['holdout-ledger'], args.provisional].filter(Boolean).map(p => resolve(p));
  if (new Set(paths).size !== paths.length) fail('path_collision');
  if (!['dry-run', 'live', 'replay'].includes(args.mode) || !args.plan || ((args.mode === 'replay') !== Boolean(args.replay)) || args.arms || args.policy || args.floor) fail('invalid_selection');
  if (args.public && existsSync(args.public)) fail('fresh_output_required');
  const ledger = args['holdout-ledger'] ? fileHoldoutLedger(resolve(args['holdout-ledger'])) : null;
  let result;
  if (args.mode === 'dry-run') {
    if (existsSync(args.plan)) fail('plan_exists');
    if (args.output || args.replay || args.budget || args.resume || args.public) fail('invalid_selection');
    const plan = await buildFiPlan({ adminUrl: process.env.DONNA_PG_TEST_URL, corpus: args.corpus || FI_CORPUS, split: args.split || 'development', comparator: args.comparator === 'true',
      models: { jev: process.env.TYPESAFE_MODEL || '', strong: process.env.OPENAI_MODEL || CODING_DEFAULT_MODEL }, cases: args.cases ? args.cases.split(',') : null,
      preregistration: args.preregistration ? read(args.preregistration) : null, baselineSummary: args.baseline ? read(args.baseline) : null, holdoutLedger: ledger ? await ledger.read() : null,
      provisional: args.provisional ? loadFiProvisionalGuidance(resolve(args.provisional)) : null });
    savePrivate(resolve(args.plan), plan);
    result = { completion: 'not_run', provider_calls: 0, selected_calls: plan.jobs.length, plan_sha256: plan.plan_sha256 };
  } else {
    if (!args.output || existsSync(args.output) || args.corpus || args.split || args.cases || args.comparator || args.preregistration || args.baseline || args.provisional) fail('fresh_output_required');
    if (args.mode === 'live' && !args.budget) fail('budget_required');
    if (args.resume && (args.mode !== 'live' || !existsSync(args.resume))) fail('invalid_resume');
    const plan = read(args.plan);
    const lane = makeFiLane({ adminUrl: process.env.DONNA_PG_TEST_URL, holdoutLedger: ledger });
    result = await runDecisionPlane(plan, { mode: args.mode, lane, replay: args.replay ? read(args.replay) : null, budget: args.budget ? verifyBudget(read(args.budget)) : null,
      resume: args.resume ? read(args.resume) : null, onCheckpoint: r => savePrivate(resolve(args.output), r) });
    savePrivate(resolve(args.output), result);
    if (args.public) savePrivate(resolve(args.public), publicSummary(result));
  }
  console.log(JSON.stringify({ completion: result.completion, provider_calls: result.provider_calls, resumed_calls: result.resumed_calls, selected_calls: result.selected_calls, plan_sha256: result.plan_sha256, continuation: result.continuation?.status ?? null }));
  return result.completion === 'incomplete' ? 2 : 0;
}
