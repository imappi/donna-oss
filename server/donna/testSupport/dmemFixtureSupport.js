// DMEM-R1 W0 — fixture support for the protected lifecycle scenarios
// (docs/audit-2026-09-04-memory-re-baseline.md §6, §7; plan v1.0 §9).
//
// Three things live here, and nothing that touches production behaviour:
//
//   1. EXPECTED FAILURES. `expectedFailure({ id, fingerprint }, fn)` runs a
//      scenario that is KNOWN to fail on the current tree and turns the failure
//      into a fingerprinted, visibly red result: the fixture still FAILS (node:test
//      reports it red), but with a canonical marker line the runner
//      (scripts/run-tests.mjs, EXPECTED_FAILURE_TESTS) recognises. Three outcomes:
//        - the body throws with the registered fingerprint → the marker
//          `DMEM_EXPECTED_FAILURE <id> :: <fingerprint>` (red, expected);
//        - the body PASSES → `DMEM_EXPECTED_FAILURE_NOW_PASSES <id>` (the slice that
//          closed the finding must flip the registry entry — the runner refuses
//          an unflipped pass);
//        - the body throws something ELSE → `DMEM_UNEXPECTED_FAILURE <id>` (the
//          fingerprint drifted or a different layer broke first — the runner
//          refuses this too).
//      `registeredGap({ id, reason })` marks a layer the tree cannot express yet
//      (`DMEM_REGISTERED_GAP <id> :: <reason>`): also red, also fingerprinted,
//      never a skip (INV-20). Neither counts as a pass.
//
//   2. THE FOUR LAYERS (plan v1.0 §9). Assertion messages are prefixed
//      `<scenario>/L<n>:` by `layerMessage`, so the FIRST failing layer names
//      itself in the fingerprint. `accountingEffectHash` is the canonical
//      accounting-effect hash of §6.1 (ledger journals + lines); `zeroEffectOracle`
//      is the before/after equality plus the unauthorized-write diff over the
//      memory-plane tables.
//
//   3. THE FENCE CHECKS (W0's seeded-mutation proof): five read-only SQL checks —
//      scope, state, time, transaction, dependency — each returning the offending
//      identifiers. `dmemHarnessGuardsPgLifecycle.test.js` seeds one mutation per
//      fence and proves each check catches exactly it.
//
// `canonicalDigest` is the interim implementation of §6.1's serialization; MX-1's
// `canonicalDigest` replaces it when MX-1 merges (same definition: sorted keys, no
// insignificant whitespace, UTF-8, sha256 hex).

import { createHash } from 'node:crypto';
import { canonicalJson as mx1CanonicalJson, canonicalDigest as mx1CanonicalDigest } from '../liveRepair/manifestContract.js';

export const DMEM_EXPECTED_FAILURE_MARK = 'DMEM_EXPECTED_FAILURE';
export const DMEM_NOW_PASSES_MARK = 'DMEM_EXPECTED_FAILURE_NOW_PASSES';
export const DMEM_UNEXPECTED_MARK = 'DMEM_UNEXPECTED_FAILURE';
export const DMEM_REGISTERED_GAP_MARK = 'DMEM_REGISTERED_GAP';

const emit = (line) => {
  // Written to stderr as ONE line so the runner can match it whatever reporter
  // node:test chose (TAP re-flows long error strings).
  process.stderr.write(`[dmem] ${line}\n`);
};

export const expectedFailureMarker = ({ id, fingerprint }) => `${DMEM_EXPECTED_FAILURE_MARK} ${id} :: ${fingerprint}`;
export const registeredGapMarker = ({ id, reason }) => `${DMEM_REGISTERED_GAP_MARK} ${id} :: ${reason}`;

export const expectedFailure = async ({ id, fingerprint }, fn) => {
  if (!id || !fingerprint) throw new Error('expectedFailure requires { id, fingerprint }');
  let thrown = null;
  try {
    await fn();
  } catch (error) {
    thrown = error;
  }
  if (!thrown) {
    const line = `${DMEM_NOW_PASSES_MARK} ${id} :: ${fingerprint}`;
    emit(line);
    throw new Error(`${line} — the tree now satisfies this layer; flip the fixture to expected-to-pass in the slice that closed it (scripts/run-tests.mjs EXPECTED_FAILURE_TESTS)`);
  }
  const message = String(thrown?.message ?? thrown);
  if (message.includes(fingerprint)) {
    const line = expectedFailureMarker({ id, fingerprint });
    emit(line);
    const error = new Error(line);
    error.cause = thrown;
    throw error;
  }
  const line = `${DMEM_UNEXPECTED_MARK} ${id} :: expected fingerprint "${fingerprint}" but the first failure was: ${message.split('\n')[0].slice(0, 400)}`;
  emit(line);
  const error = new Error(line);
  error.cause = thrown;
  throw error;
};

export const registeredGap = ({ id, reason }) => {
  const line = registeredGapMarker({ id, reason });
  emit(line);
  throw new Error(line);
};

export const layerMessage = (scenario, layer, text) => `${scenario}/L${layer}: ${text}`;

// ── Canonical serialization (§6.1) ───────────────────────────────────────────
// The digest law is MX-1's (server/donna/liveRepair/manifestContract.js: sorted keys,
// no insignificant whitespace, sha256 over the UTF-8 bytes). What this module adds is
// ONLY the driver-type normalization the contract does not know about: a pg Date
// becomes its ISO instant (MX-1's canonicalJson would serialize a Date as `{}`), a
// bigint becomes its decimal string, undefined becomes null. Applied BEFORE the
// contract's canonicalJson so the bytes hashed are the contract's, never a fork.
const normalizeDriverTypes = (node) => {
  if (Array.isArray(node)) return node.map(normalizeDriverTypes);
  if (node && typeof node === 'object') {
    if (node instanceof Date) return node.toISOString();
    const out = {};
    for (const key of Object.keys(node)) out[key] = normalizeDriverTypes(node[key]);
    return out;
  }
  if (typeof node === 'bigint') return node.toString();
  return node === undefined ? null : node;
};

export const canonicalJson = (value) => mx1CanonicalJson(normalizeDriverTypes(value));
export const canonicalDigest = (value) => mx1CanonicalDigest(normalizeDriverTypes(value));
export const setDigest = (ids) => canonicalDigest([...new Set(ids.map(String))].sort());
export const money2 = (value) => (Math.round((Number(value) + Number.EPSILON) * 100) / 100).toFixed(2);

// ── The accounting-effect hash and the zero-effect oracle (§6.1) ─────────────
export const accountingEffectHash = async (query, { firmId }) => {
  const journals = (await query(
    `select id, client_id, source_type, source_id, journal_date::text as journal_date, currency, status
       from ledger_journals where firm_id = $1 order by id`,
    [firmId]
  )).rows;
  const lines = (await query(
    `select journal_id, line_no, account_code, direction, debit::text as debit, credit::text as credit,
            amount::text as amount, currency, tax_type
       from ledger_lines where firm_id = $1 order by journal_id, line_no`,
    [firmId]
  )).rows.map((line) => ({
    ...line,
    debit: money2(line.debit), credit: money2(line.credit), amount: money2(line.amount)
  }));
  return { hash: canonicalDigest({ journals, lines }), journals: journals.length, lines: lines.length };
};

export const MEMORY_PLANE_TABLES = Object.freeze([
  'firm_facts', 'memory_candidates', 'memories', 'memory_relations', 'memory_history_epochs',
  'memory_replay_evidence', 'client_rules', 'accounting_rules',
  'reconciliation_matches', 'reconciliation_evaluations', 'client_evidence_requests',
  'ledger_journals', 'ledger_lines', 'audit_events', 'llm_decisions'
]);

const TENANT_KEYED_TABLES = new Set(['memories', 'memory_relations', 'memory_history_epochs']);
const firmColumnFor = (table) => (TENANT_KEYED_TABLES.has(table) ? 'tenant_id' : 'firm_id');

export const memoryPlaneRowCounts = async (query, { firmId }) => {
  const counts = {};
  for (const table of MEMORY_PLANE_TABLES) {
    const res = await query(`select count(*)::int as n from ${table} where ${firmColumnFor(table)} = $1`, [firmId]);
    counts[table] = res.rows[0].n;
  }
  return counts;
};

// declared: { table: expectedDelta } — the scenario's own legitimate writes.
export const unauthorizedWriteDiff = (before, after, declared = {}) => {
  const diff = {};
  for (const table of MEMORY_PLANE_TABLES) {
    const delta = (after[table] || 0) - (before[table] || 0) - (declared[table] || 0);
    if (delta !== 0) diff[table] = delta;
  }
  return diff;
};

export const zeroEffectOracle = async (query, { firmId }) => {
  const effect = await accountingEffectHash(query, { firmId });
  const counts = await memoryPlaneRowCounts(query, { firmId });
  return {
    effect,
    counts,
    // Compare a later snapshot against this one.
    diffAgainst: async (declared = {}) => {
      const later = await accountingEffectHash(query, { firmId });
      const laterCounts = await memoryPlaneRowCounts(query, { firmId });
      return {
        effectUnchanged: later.hash === effect.hash,
        before: effect.hash,
        after: later.hash,
        unauthorizedWrites: unauthorizedWriteDiff(counts, laterCounts, declared)
      };
    }
  };
};

// ── The fence checks (scope · state · time · transaction · dependency) ───────
//
// Each returns an array of { table, id, reason }. Every query is read-only and
// firm-scoped. They are deliberately CONSERVATIVE (a violation is a row the
// doctrine says cannot exist), so a clean scratch database returns [] for all
// five — the seeded-mutation test relies on that baseline.
export const runFenceChecks = async (query, { firmId }) => {
  const rows = async (sql, params) => (await query(sql, params)).rows;
  const scope = [
    ...(await rows(
      `select r.id, 'client_rules' as "table", 'client belongs to another firm' as reason
         from client_rules r join clients c on c.id = r.client_id
        where r.firm_id = $1 and c.firm_id <> r.firm_id`,
      [firmId]
    )),
    ...(await rows(
      `select m.id, 'memory_candidates' as "table", 'client_id names no client of this firm' as reason
         from memory_candidates m
        where m.firm_id = $1 and not exists (select 1 from clients c where c.firm_id = m.firm_id and c.id = m.client_id)`,
      [firmId]
    )),
    ...(await rows(
      `select f.id, 'firm_facts' as "table", 'merchant fact keyed to a client of another firm' as reason
         from firm_facts f
        where f.firm_id = $1 and f.scope = 'merchant' and f.provenance->>'entity_client_id' is not null
          and not exists (select 1 from clients c where c.firm_id = f.firm_id and c.id = f.provenance->>'entity_client_id')`,
      [firmId]
    )),
    ...(await rows(
      `select m.memory_id as id, 'memories' as "table", 'legal-entity memory owned by a client of another firm' as reason
         from memories m
        where m.tenant_id = $1 and m.lifecycle_owner_type = 'legal_entity'
          and not exists (select 1 from clients c where c.firm_id = m.tenant_id and c.id = m.owner_client_id)`,
      [firmId]
    ))
  ];
  const state = [
    ...(await rows(
      `select id, 'memory_candidates' as "table", 'promoted without a minted fact or memory' as reason
         from memory_candidates
        where firm_id = $1 and status = 'promoted' and minted_fact_id is null and minted_memory_id is null`,
      [firmId]
    )),
    ...(await rows(
      `select id, 'client_rules' as "table", 'status outside proposed/active/retired' as reason
         from client_rules where firm_id = $1 and status not in ('proposed', 'active', 'retired')`,
      [firmId]
    )),
    ...(await rows(
      `select id, 'firm_facts' as "table", 'status outside active/dismissed/erased' as reason
         from firm_facts where firm_id = $1 and status not in ('active', 'dismissed', 'erased')`,
      [firmId]
    ))
  ];
  const time = [
    ...(await rows(
      `select id, 'firm_facts' as "table", 'updated_at precedes created_at' as reason
         from firm_facts where firm_id = $1 and updated_at < created_at`,
      [firmId]
    )),
    ...(await rows(
      `select memory_id as id, 'memories' as "table", 'valid_from is not before valid_until' as reason
         from memories where tenant_id = $1 and valid_from is not null and valid_until is not null and valid_from >= valid_until`,
      [firmId]
    )),
    ...(await rows(
      `select memory_id as id, 'memories' as "table", 'recorded_at precedes observed_at' as reason
         from memories where tenant_id = $1 and recorded_at < observed_at`,
      [firmId]
    )),
    ...(await rows(
      `select id, 'memory_candidates' as "table", 'decided_at set while still suggested' as reason
         from memory_candidates where firm_id = $1 and status = 'suggested' and decided_at is not null`,
      [firmId]
    ))
  ];
  const transaction = [
    ...(await rows(
      `select r.id, 'client_rules' as "table", 'mint effect without its merchant_rule_saved receipt' as reason
         from client_rules r
        where r.firm_id = $1 and r.status = 'active' and r.payload ? 'source'
          and not exists (select 1 from audit_events a
                           where a.firm_id = r.firm_id and a.resource_type = 'client_rule' and a.resource_id = r.id
                             and a.action = 'client_rule.merchant_rule_saved')`,
      [firmId]
    )),
    ...(await rows(
      `select a.resource_id as id, 'audit_events' as "table", 'merchant_rule_saved receipt without its rule row' as reason
         from audit_events a
        where a.firm_id = $1 and a.action = 'client_rule.merchant_rule_saved'
          and not exists (select 1 from client_rules r where r.firm_id = a.firm_id and r.id = a.resource_id)`,
      [firmId]
    )),
    ...(await rows(
      `select f.id, 'firm_facts' as "table", 'active fact without its firm_fact.created receipt' as reason
         from firm_facts f
        where f.firm_id = $1 and f.status = 'active'
          and not exists (select 1 from audit_events a
                           where a.firm_id = f.firm_id and a.resource_type = 'firm_fact' and a.resource_id = f.id
                             and a.action = 'firm_fact.created')`,
      [firmId]
    ))
  ];
  const dependency = [
    ...(await rows(
      `select m.id, 'memory_candidates' as "table", 'minted_fact_id names no firm fact' as reason
         from memory_candidates m
        where m.firm_id = $1 and m.minted_fact_id is not null
          and not exists (select 1 from firm_facts f where f.firm_id = m.firm_id and f.id = m.minted_fact_id)`,
      [firmId]
    )),
    ...(await rows(
      `select m.id, 'memory_candidates' as "table", 'minted_memory_id names no memory' as reason
         from memory_candidates m
        where m.firm_id = $1 and m.minted_memory_id is not null
          and not exists (select 1 from memories x where x.tenant_id = m.firm_id and x.memory_id = m.minted_memory_id)`,
      [firmId]
    )),
    ...(await rows(
      `select r.source_memory_id as id, 'memory_relations' as "table", 'relation names a missing memory' as reason
         from memory_relations r
        where r.tenant_id = $1
          and (not exists (select 1 from memories x where x.memory_id = r.source_memory_id)
            or not exists (select 1 from memories x where x.memory_id = r.target_memory_id))`,
      [firmId]
    )),
    ...(await rows(
      `select m.memory_id as id, 'memories' as "table", 'supersedes_memory_id names a missing memory' as reason
         from memories m
        where m.tenant_id = $1 and m.supersedes_memory_id is not null
          and not exists (select 1 from memories x where x.memory_id = m.supersedes_memory_id)`,
      [firmId]
    )),
    ...(await rows(
      `select rm.id, 'reconciliation_matches' as "table", 'matched document is gone' as reason
         from reconciliation_matches rm
        where rm.firm_id = $1 and rm.matched_object_type = 'document' and rm.matched_object_id is not null
          and not exists (select 1 from documents d where d.firm_id = rm.firm_id and d.id = rm.matched_object_id)`,
      [firmId]
    ))
  ];
  return { scope, state, time, transaction, dependency };
};

export const FENCE_NAMES = Object.freeze(['scope', 'state', 'time', 'transaction', 'dependency']);

// ── Seeds the scenarios share ────────────────────────────────────────────────
//
// A bank line written straight to `transactions` in the shape the parse writer
// leaves (needs_review, no ai_suggestion), so a scenario can drive the REAL
// coder / mint / ask writers on it without a statement parse. The seed is the
// scenario's declared input, never the thing under test.
export const seedBankLine = async (query, {
  firmId, clientId, id, date, description, moneyOut = 0, moneyIn = 0, currency = 'GBP', payload = {}
}) => {
  await query(
    `insert into transactions (id, firm_id, client_id, transaction_date, description, raw_description, money_in, money_out, currency, status, payload)
     values ($1, $2, $3, $4::date, $5, $5, $6, $7, $8, 'needs_review', $9::jsonb)`,
    [id, firmId, clientId, date, description, moneyIn, moneyOut, currency, JSON.stringify(payload)]
  );
  return id;
};

// The OpenAI Responses body the batch coder parses (transactionLlm.js
// suggestTransactionCodingBatch → schema transaction_coding_batch_suggestion):
// one suggestion per line, authored by the scenario. `remember_candidate` is
// the F-01 trigger.
export const codingBatchBody = ({ suggestions = [], groupSummary = [], model = 'dmem-recorded-coder' } = {}) => ({
  id: 'resp_dmem_coding_batch',
  object: 'response',
  created_at: 1756684800,
  status: 'completed',
  model,
  store: false,
  output: [{
    id: 'msg_dmem_coding_batch',
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', annotations: [], text: JSON.stringify({ suggestions, group_summary: groupSummary }) }]
  }],
  usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
});

export const codingSuggestion = ({
  transactionId, proposedAccount, contact, merchantPattern, rememberCandidate = false,
  evidenceRequired = false, autoExplainLimit = 50, confidence = 'high', taxTreatment = 'standard',
  supportNote = 'Recurring small supplier purchase.', reasoning = 'Named supplier, small recurring amount.'
} = {}) => ({
  transaction_id: transactionId,
  proposed_account: proposedAccount,
  contact,
  tax_treatment: taxTreatment,
  support_note: supportNote,
  ask_client_question: '',
  evidence_required: evidenceRequired,
  remember_candidate: rememberCandidate,
  merchant_pattern: merchantPattern,
  missing_account_name: '',
  missing_account_type: '',
  missing_account_reason: '',
  auto_explain_limit: autoExplainLimit,
  confidence,
  materiality: 'low',
  reasoning,
  warnings: [],
  alternatives: []
});

// The OpenAI Responses body the firm-fact distiller parses (firmFacts.js
// distillFirmFactsFromEvent → schema firm_fact_distillation, lane
// memory_extraction at the wire).
export const distillerBody = ({ facts = [], model = 'dmem-recorded-distiller' } = {}) => ({
  id: 'resp_dmem_distiller',
  object: 'response',
  status: 'completed',
  model,
  output: [{ id: 'msg_dmem_distiller', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', annotations: [], text: JSON.stringify({ facts }) }] }],
  usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
});
