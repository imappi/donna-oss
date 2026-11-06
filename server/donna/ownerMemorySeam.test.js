// Donna — BizOS Slice 2c-iii (sub-PR 7): the canary seam. Proves the §O
// acceptance invariants at the seam: 10a (force-throw → no-memory, not legacy),
// 10b (rollback → legacy restored), 10c (shadow byte-identical; only canary
// replaces), test 1 (full-payload legacy-sentinel leak), test 16 (suspension), and
// the blocked short-circuit.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildOwnerTurnMemory, controlledMemoryUnavailableText } from './ownerMemorySeam.js';
import { MEMORY_RETRIEVAL_V2_FLAG_KEY } from './memoryRetrieval.js';
import { MEMORY_CONTEXT_SECURITY_SUSPEND_KEY } from './memoryContextMode.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const LEGACY_SENTINEL = 'SENTINEL-VAT-REG-4-MAY-2019';

const baseContext = () => ({
  client: { name: 'Honeybee Ltd' },
  today: '2026-07-13',
  known_facts: [{ scope: 'client', subject: 'Honeybee', fact: LEGACY_SENTINEL }]
});

const snapshot = {
  schema: 'memret.shadow.snapshot.v1',
  source_turn_id: 'clchat-honeybee-user-abc',
  tenant_id: 'f1',
  purpose_id: 'portal_owner_context',
  consumer_capability_id: 'clientPortalChatContext',
  source_surface: 'portal_chat',
  authenticated_principal: { id: 'owner-1', principal_type: 'owner', principal_id: 'owner-1' },
  delegated_principal: { id: 'owner-1', principal_type: 'owner', principal_id: 'owner-1' },
  resolved_audience: { audience_class: 'owner' },
  resolved_subject_refs: [{ subject_type: 'legal_entity', subject_id: 'c1' }],
  conversation_boundary: { up_to_message_id: 'clchat-honeybee-user-abc' },
  authoritative_as_of: '2026-07-13T00:00:00.000Z',
  legacy_included: []
};

const history = [
  { id: 'h1', role: 'user', content: 'earlier question', created_at: '2026-05-01T00:00:00.000Z' },
  { id: 'h2', role: 'assistant', content: `your VAT date is ${LEGACY_SENTINEL}`, created_at: '2026-05-02T00:00:00.000Z' },
  { id: 'h3', role: 'user', content: 'current question', created_at: '2026-07-13T00:00:00.000Z' }
];

// A db client whose config snapshot + epoch are scriptable.
const makeClient = ({ config = {}, epoch = null } = {}) => ({
  query: async (text) => {
    if (/from client_capability_config/i.test(text) || /from cohort_capability_config/i.test(text)) {
      // readClientConfigSnapshot issues two selects; return the flag rows on the base one.
      if (/client_capability_config/i.test(text)) {
        return { rows: Object.entries(config).map(([flag_key, v]) => ({ flag_key, stage: v.stage, source: 'manual', client_id: 'c1' })) };
      }
      return { rows: [] };
    }
    if (/from memory_history_epochs/i.test(text)) return { rows: epoch ? [epoch] : [] };
    return { rows: [] };
  }
});

const v2Bundle = {
  status: 'ok', failure: null,
  bundle: { context_items: [{ subject_ref: 'legal_entity:c1', predicate: 'vat_number', rendered_value: 'GB999', valid_from: '2026-01-01' }], conflict_markers: [] },
  consumer_receipt: { included: [{}], visible_excluded: [], bundle_fingerprint: 'bundle-xyz', as_of: '2026-07-13T00:00:00.000Z' }
};

const v2Deps = (over = {}) => ({
  buildBundle: async () => v2Bundle,
  makeDeps: () => ({}),
  withDeadline: async ({ buildBundle, invocation }) => ({ result: await buildBundle({ ...invocation, deps: {} }), timedOut: false, threw: false }),
  deadlineMs: 300,
  ...over
});

// ── 10c: legacy / shadow is byte-identical; only canary replaces ──────────────

test('10c: no config row (legacy) → base context + full history UNCHANGED', async () => {
  const bc = baseContext();
  const out = await buildOwnerTurnMemory({ client: makeClient(), firmId: 'f1', clientId: 'c1', baseContext: bc, history, snapshot, env: {}, deps: v2Deps() });
  assert.equal(out.mode, 'legacy');
  assert.equal(out.promptContext, bc);                 // same reference — untouched
  assert.equal(out.systemPromptExtra, null);
  assert.equal(out.promptHistory.length, 3);           // no fence
});

test('10c: a SHADOW client does not act → legacy, byte-identical', async () => {
  const out = await buildOwnerTurnMemory({
    client: makeClient({ config: { [MEMORY_RETRIEVAL_V2_FLAG_KEY]: { stage: 'shadow' } } }),
    firmId: 'f1', clientId: 'c1', baseContext: baseContext(), history, snapshot, env: {}, deps: v2Deps()
  });
  assert.equal(out.mode, 'legacy');
  assert.equal(out.systemPromptExtra, null);
});

test('10c: a CANARY client replaces the legacy paste with the v2 block', async () => {
  const out = await buildOwnerTurnMemory({
    client: makeClient({ config: { [MEMORY_RETRIEVAL_V2_FLAG_KEY]: { stage: 'canary' } } }),
    firmId: 'f1', clientId: 'c1', baseContext: baseContext(), history, snapshot, env: {}, deps: v2Deps()
  });
  assert.equal(out.mode, 'v2');
  assert.equal(out.promptContext.known_facts, null, 'legacy paste stripped from context');
  assert.equal(out.memoryContext.status, 'available');
  assert.ok(out.systemPromptExtra.includes('OWNER RECORDED FACTS'));
  assert.ok(out.systemPromptExtra.includes('GB999'));
});

// ── test 1: full-payload legacy-sentinel leak ──────────────────────────────────

test('test 1: at canary, the legacy sentinel appears NOWHERE in the model-bound payload', async () => {
  const out = await buildOwnerTurnMemory({
    client: makeClient({
      config: { [MEMORY_RETRIEVAL_V2_FLAG_KEY]: { stage: 'canary' } },
      // an epoch entered mid-2026 fences the pre-epoch assistant turn carrying the sentinel
      epoch: { id: 'e1', tenant_id: 'f1', client_id: 'c1', audience: 'owner', purpose: 'portal_owner_context', epoch_seq: 1, mode_entered: 'v2', boundary_at: '2026-06-01T00:00:00.000Z', created_at: '2026-06-01T00:00:00.000Z' }
    }),
    firmId: 'f1', clientId: 'c1', baseContext: baseContext(), history, snapshot, env: {}, deps: v2Deps()
  });
  const fullPayload = JSON.stringify({
    context: out.promptContext,
    history: out.promptHistory,
    systemPromptExtra: out.systemPromptExtra
  });
  assert.ok(!fullPayload.includes(LEGACY_SENTINEL), 'no legacy sentinel anywhere in the payload');
  // and the fenced history dropped the pre-epoch turns
  assert.deepEqual(out.promptHistory.map((m) => m.id), ['h3']);
});

// ── 10a: force-throw → no-memory, NOT legacy ───────────────────────────────────

test('10a: retrieval throws at canary → unavailable memory, NOT legacy paste', async () => {
  const out = await buildOwnerTurnMemory({
    client: makeClient({ config: { [MEMORY_RETRIEVAL_V2_FLAG_KEY]: { stage: 'canary' } } }),
    firmId: 'f1', clientId: 'c1', baseContext: baseContext(), history, snapshot, env: {},
    deps: v2Deps({ withDeadline: async () => ({ result: null, threw: true, timedOut: false }) })
  });
  assert.equal(out.mode, 'v2');
  assert.equal(out.memoryContext.status, 'unavailable');
  assert.equal(out.promptContext.known_facts, null, 'NO legacy fallback');
  assert.ok(!JSON.stringify(out.promptContext).includes(LEGACY_SENTINEL));
  assert.ok(out.systemPromptExtra.includes('temporarily unavailable'));
});

test('10a: timeout at canary → unavailable/timeout, not legacy', async () => {
  const out = await buildOwnerTurnMemory({
    client: makeClient({ config: { [MEMORY_RETRIEVAL_V2_FLAG_KEY]: { stage: 'canary' } } }),
    firmId: 'f1', clientId: 'c1', baseContext: baseContext(), history, snapshot, env: {},
    deps: v2Deps({ withDeadline: async () => ({ result: null, threw: false, timedOut: true }) })
  });
  assert.equal(out.memoryContext.status, 'unavailable');
  assert.equal(out.memoryContext.public_reason, 'timeout');
  assert.equal(out.promptContext.known_facts, null);
});

// ── 10b: rollback → legacy restored ───────────────────────────────────────────

test('10b: force-disable (rollback) → legacy paste restored, byte-identical', async () => {
  const bc = baseContext();
  const out = await buildOwnerTurnMemory({
    client: makeClient({ config: { [MEMORY_RETRIEVAL_V2_FLAG_KEY]: { stage: 'canary' } } }),
    firmId: 'f1', clientId: 'c1', baseContext: bc, history, snapshot,
    env: { CLIENT_CONFIG_FORCE_DISABLE: 'MEMORY_RETRIEVAL_V2' }, deps: v2Deps()
  });
  assert.equal(out.mode, 'legacy');
  assert.equal(out.promptContext, bc);
  assert.equal(out.systemPromptExtra, null);
});

// ── test 16: security suspension withholds BOTH ───────────────────────────────

test('test 16: suspension → NEITHER v2 nor legacy, audited', async () => {
  const out = await buildOwnerTurnMemory({
    client: makeClient({ config: { [MEMORY_RETRIEVAL_V2_FLAG_KEY]: { stage: 'canary' } } }),
    firmId: 'f1', clientId: 'c1', baseContext: baseContext(), history, snapshot,
    env: { [MEMORY_CONTEXT_SECURITY_SUSPEND_KEY]: 'all' }, deps: v2Deps()
  });
  assert.equal(out.mode, 'suspended');
  assert.equal(out.promptContext.known_facts, null, 'no legacy');
  assert.equal(out.memoryContext.status, 'unavailable', 'no v2 data');
  assert.equal(out.memoryContext.recorded_facts.length, 0);
  assert.equal(out.auditEvents.length, 1);
  assert.equal(out.auditEvents[0].action, 'memory_context.security_suspended');
  assert.deepEqual(out.auditEvents[0].metadata.withheld, ['v2', 'legacy']);
});

// ── blocked short-circuit ──────────────────────────────────────────────────────

test('blocked (integrity) → shortCircuit set, controlled text, no legacy', async () => {
  const out = await buildOwnerTurnMemory({
    client: makeClient({ config: { [MEMORY_RETRIEVAL_V2_FLAG_KEY]: { stage: 'canary' } } }),
    firmId: 'f1', clientId: 'c1', baseContext: baseContext(), history, snapshot, env: {},
    deps: v2Deps({ withDeadline: async () => ({ result: { status: 'refused', failure: 'integrity_failed', bundle: { context_items: [] }, consumer_receipt: { visible_excluded: [] } }, threw: false, timedOut: false }) })
  });
  assert.ok(out.shortCircuit);
  assert.equal(out.shortCircuit.public_reason, 'integrity');
  assert.equal(out.systemPromptExtra, null);
  assert.equal(out.promptContext.known_facts, null);
  assert.ok(controlledMemoryUnavailableText().length > 0);
});

// ── fail-safe ──────────────────────────────────────────────────────────────────

test('seam is fail-safe: a config read that throws → legacy (never crashes the turn)', async () => {
  const throwingClient = { query: async (text) => { if (/client_capability_config/i.test(text)) throw new Error('db down'); return { rows: [] }; } };
  const out = await buildOwnerTurnMemory({ client: throwingClient, firmId: 'f1', clientId: 'c1', baseContext: baseContext(), history, snapshot, env: {}, deps: v2Deps() });
  assert.equal(out.mode, 'legacy');
});
