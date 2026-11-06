// The K1 wiring at the assembler (corpus spec §7 B3/B4): the per-client config
// snapshot is READ and passed to the seam (the flag is stageable — a
// control-plane row, never an env pair), the compose call is injected from the
// surface (never imported by the seam), and the model id rides only when a
// compose call can actually run. Env inside each test body; no after-hook
// cleanup (the webhookRoutesSeam interleave trap).

import test from 'node:test';
import assert from 'node:assert/strict';

import { assembleClientPortalTurn } from './clientPortalTurn.js';
import { CodingPolicyError } from './codingPolicy.js';

const CANARY_ROWS = [{ flag_key: 'KNOWLEDGE_BASE_RETRIEVAL', stage: 'canary', source: 'seam', client_id: 'client-1' }];

const fakeDbClient = (configRows = []) => ({
  queries: [],
  async query(sql, params) {
    this.queries.push({ sql, params });
    if (/from client_capability_config/.test(sql)) return { rows: configRows, rowCount: configRows.length };
    return { rows: [], rowCount: 0 };
  }
});

const baseDeps = (dbClient, extra = {}) => ({
  getThread: async () => [],
  getProfile: async () => ({ jurisdiction: 'GB', name: 'Test Owner Ltd' }),
  getEvidenceRequests: async () => ({ requests: [] }),
  getDocs: async () => ({ rows: [], totalCount: 0 }),
  getFeedRows: async () => ({ rows: [], totalCount: 0 }),
  getLedgerPreview: async () => null,
  getFirmFacts: async () => [],
  buildOwnerTurnMemory: async () => null,
  buildSelfKnowledge: async () => null,
  withFirmDbClient: async (fn) => fn(dbClient),
  ...extra
});

const USER_ROW = { id: 'msg-1', content: 'Do I need to register for VAT?' };

test('typed policy failure stops portal assembly before any accounting or knowledge provider work', async () => {
  const failure = new CodingPolicyError('jurisdiction_unresolved');
  let downstreamCalls = 0;
  await assert.rejects(assembleClientPortalTurn({
    firmId: 'firm-1', clientId: 'client-1', userMessageRow: USER_ROW,
    deps: baseDeps(fakeDbClient(), {
      getProfile: async () => { throw failure; },
      getEvidenceRequests: async () => { downstreamCalls += 1; return { requests: [] }; },
      buildKnowledgeGrounding: async () => { downstreamCalls += 1; }
    })
  }), (error) => error === failure);
  assert.equal(downstreamCalls, 0);
});

test('the seam receives the per-client config snapshot, its content-addressed id, and an injected compose', async () => {
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  const dbClient = fakeDbClient(CANARY_ROWS);
  const seen = [];
  const composeSpy = async () => null;
  await assembleClientPortalTurn({
    firmId: 'firm-1',
    clientId: 'client-1',
    userMessageRow: USER_ROW,
    deps: baseDeps(dbClient, {
      knowledgeCompose: composeSpy,
      buildKnowledgeGrounding: async (args) => { seen.push(args); return null; }
    })
  });
  assert.equal(seen.length, 1);
  const args = seen[0];
  assert.deepEqual(args.configSnapshot, { KNOWLEDGE_BASE_RETRIEVAL: { stage: 'canary', source: 'seam' } });
  assert.match(String(args.configSnapshotId || ''), /./, 'a content-addressed snapshot id must ride along');
  assert.equal(args.deps.compose, composeSpy, 'the injected compose passes through untouched');
  assert.equal(args.questionText, USER_ROW.content);
  assert.ok(dbClient.queries.some((q) => /client_capability_config/.test(q.sql)), 'the snapshot read actually ran');
});

test('deps.knowledgeCompose: null keeps compose null AND modelId null — no model answered, none is claimed', async () => {
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  const seen = [];
  await assembleClientPortalTurn({
    firmId: 'firm-1',
    clientId: 'client-1',
    userMessageRow: USER_ROW,
    deps: baseDeps(fakeDbClient(), {
      knowledgeCompose: null,
      buildKnowledgeGrounding: async (args) => { seen.push(args); return null; }
    })
  });
  assert.equal(seen[0].deps.compose, null);
  assert.equal(seen[0].modelId, null);
});

test('END-TO-END through the REAL seam: a canary snapshot row activates K1 and an empty corpus renders the deterministic refusal', async () => {
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  delete process.env.CLIENT_CONFIG_FORCE_DISABLE;
  const dbClient = fakeDbClient(CANARY_ROWS);
  const result = await assembleClientPortalTurn({
    firmId: 'firm-1',
    clientId: 'client-1',
    userMessageRow: USER_ROW,
    deps: baseDeps(dbClient, { knowledgeCompose: null })
  });
  assert.ok(result.knowledgeGrounding, 'the flag acts via the DB snapshot row — B4 is real');
  assert.equal(result.knowledgeGrounding.outcome, 'refusal');
  assert.ok(result.knowledgeGrounding.receipt, 'the answer receipt rides the grounding result');
  assert.match(result.knowledgeGrounding.answer?.grounding_block || '', /SOURCED KNOWLEDGE/);
});

test('no snapshot row → the born-off flag does not act and the turn is byte-identical legacy (grounding null)', async () => {
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  const result = await assembleClientPortalTurn({
    firmId: 'firm-1',
    clientId: 'client-1',
    userMessageRow: USER_ROW,
    deps: baseDeps(fakeDbClient(), { knowledgeCompose: null })
  });
  assert.equal(result.knowledgeGrounding, null);
});
