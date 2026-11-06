// roleRoster (S3) — the roster read. Pins:
//   - the bench UI flag ladder: off/dry_run hide, shadow shows read-only,
//     canary/auto act — and the flag may legally reach 'auto' (a UI surface,
//     not an acting lane: deliberately absent from both refusal sets);
//   - INV-S9: the claim rides the S6 ladder (roleCertification) and no role
//     holds a signed record today, so it is 'preview' on every card — never
//     'autonomous' — and the roster carries the certification summary;
//   - INV-S8: the projection counts owner-resting items only (approvals +
//     escalated + needs-input), from the SAME gather as the owner Actions tab;
//   - the projection is read ONLY for an actively hired collections role;
//   - grants attach to their role by provenance, revoked rows excluded by the
//     reader's SQL (status filter pinned in the query shape).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SPECIALIST_ROLE_BENCH_FLAG_KEY,
  benchUiMode,
  projectionFromOwnerSurface,
  readRoleRoster
} from './roleRoster.js';
import { ROLE_DEFINITIONS } from './roleRegistry.js';
import { assertStageAllowedForFlag } from '../clientConfig.js';

const ENV = {};

const snapshotWith = (stage) => ({
  [SPECIALIST_ROLE_BENCH_FLAG_KEY]: { stage, source: 'manual' }
});

// Fake client covering the module's SQL surface (the roleEmployment.test.js
// harness style).
const makeClient = ({ assignmentRows = [], grantRows = [], snapshotRows = [], teamworkRows = [] } = {}) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      const text = String(sql);
      calls.push({ sql: text, params });
      const lower = text.toLowerCase();
      if (lower.includes('from cohort_capability_config')) return { rows: [] };
      if (lower.includes('select flag_key, stage, source, client_id')) {
        return { rows: snapshotRows };
      }
      if (lower.includes('from client_assignments')) return { rows: assignmentRows };
      if (lower.includes('from action_authority_grants')) return { rows: grantRows };
      if (lower.includes('from audit_events')) return { rows: teamworkRows };
      throw new Error(`unexpected sql: ${text}`);
    }
  };
};

const BASE = { firmId: 'firm-1', clientId: 'client-1', env: ENV };

// ── The flag ladder ─────────────────────────────────────────────────────────

test('bench UI flag ladder: off/dry_run hide, shadow shows, canary/auto act; no row = dormant', () => {
  assert.equal(benchUiMode({ snapshot: null, env: ENV }), 'off');
  assert.equal(benchUiMode({ snapshot: snapshotWith('off'), env: ENV }), 'off');
  assert.equal(benchUiMode({ snapshot: snapshotWith('dry_run'), env: ENV }), 'off');
  assert.equal(benchUiMode({ snapshot: snapshotWith('shadow'), env: ENV }), 'shadow');
  assert.equal(benchUiMode({ snapshot: snapshotWith('canary'), env: ENV }), 'act');
  assert.equal(benchUiMode({ snapshot: snapshotWith('auto'), env: ENV }), 'act');
});

test('the bench UI flag may legally stage to auto (UI visibility, not an acting lane)', () => {
  assert.doesNotThrow(() => assertStageAllowedForFlag(SPECIALIST_ROLE_BENCH_FLAG_KEY, 'auto'));
});

// ── INV-S8: the projection ──────────────────────────────────────────────────

test('projection counts owner-resting items only: approvals + escalated + needs_input', () => {
  const projection = projectionFromOwnerSurface({
    pipeline_active: true,
    pending: [{ id: 'a1' }, { id: 'a2' }],
    escalated: [{ id: 'c1' }],
    needs_input: [{ id: 'c2' }],
    failed: [{ id: 'f1' }],   // Donna-side continuation — never on the owner line
    stale: [{ id: 's1' }],
    auto_sent: [{ id: 'n1' }],
    owner_replies: [{ id: 'r1' }]
  });
  assert.equal(projection.waiting_on_owner, 4);
  assert.deepEqual(projection.breakdown, { approvals: 2, escalated: 1, needs_input: 1 });
  assert.equal(projection.pipeline_active, true);
  assert.equal(projection.source, 'owner_actions_surface');
});

test('an empty surface projects zero (the "All handled" shape)', () => {
  assert.equal(projectionFromOwnerSurface({}).waiting_on_owner, 0);
});

// ── The roster read ─────────────────────────────────────────────────────────

test('roster: every registry role renders; certification claim is preview everywhere (INV-S9)', async () => {
  const client = makeClient();
  const roster = await readRoleRoster(client, BASE);
  assert.equal(roster.bench.mode, 'off');
  assert.equal(roster.bench.flag_key, SPECIALIST_ROLE_BENCH_FLAG_KEY);
  assert.equal(roster.roles.length, ROLE_DEFINITIONS.length);
  for (const role of roster.roles) {
    assert.equal(role.certification_claim, 'preview');
    assert.equal(role.certification.claim, 'preview');
    assert.equal(role.certification.record, null);
    assert.ok(Array.isArray(role.certification.manifests));
    assert.ok(role.profile?.persona, `${role.id} carries its AI profile persona`);
    assert.ok(Array.isArray(role.envelope.flags));
    assert.equal(role.assignment, null);
    assert.equal(role.projection, null);
  }
});

test('roster: an unhired collections role reads NO owner surface (no gather spent, no projection)', async () => {
  const client = makeClient();
  let surfaceReads = 0;
  await readRoleRoster(client, {
    ...BASE,
    deps: { readOwnerActionsSurface: async () => { surfaceReads += 1; return {}; } }
  });
  assert.equal(surfaceReads, 0);
});

test('roster: an actively hired collections role carries the owner-surface projection', async () => {
  const client = makeClient({
    assignmentRows: [{
      id: 'role-assign-1', role: 'invoicing_collections',
      principal_type: 'ai_occupant', principal_id: 'donna_ai',
      ai_profile: 'clara', status: 'active', starts_at: 't0', ends_at: null
    }]
  });
  const roster = await readRoleRoster(client, {
    ...BASE,
    deps: {
      readOwnerActionsSurface: async () => ({
        pipeline_active: false,
        pending: [{ id: 'a1' }],
        escalated: [],
        needs_input: [{ id: 'c1' }, { id: 'c2' }]
      })
    }
  });
  const collections = roster.roles.find((role) => role.id === 'invoicing_collections');
  assert.equal(collections.assignment.status, 'active');
  assert.equal(collections.assignment.ai_profile, 'clara');
  assert.equal(collections.projection.waiting_on_owner, 3);
  const tax = roster.roles.find((role) => role.id === 'tax');
  assert.equal(tax.projection, null);
});

test('roster: an ENDED assignment renders as history, not as hired — and spends no gather', async () => {
  const client = makeClient({
    assignmentRows: [{
      id: 'role-assign-1', role: 'invoicing_collections',
      principal_type: 'ai_occupant', principal_id: 'donna_ai',
      ai_profile: 'clara', status: 'ended', starts_at: 't0', ends_at: 't1'
    }]
  });
  let surfaceReads = 0;
  const roster = await readRoleRoster(client, {
    ...BASE,
    deps: { readOwnerActionsSurface: async () => { surfaceReads += 1; return {}; } }
  });
  const collections = roster.roles.find((role) => role.id === 'invoicing_collections');
  assert.equal(collections.assignment.status, 'ended');
  assert.equal(collections.projection, null);
  assert.equal(surfaceReads, 0);
});

// ── S5: teamwork narration source ───────────────────────────────────────────

test('roster: an empty bench gathers NO teamwork (no rows, no read spent)', async () => {
  const client = makeClient();
  let teamworkReads = 0;
  const roster = await readRoleRoster(client, {
    ...BASE,
    deps: { readRoleTeamwork: async () => { teamworkReads += 1; return []; } }
  });
  assert.deepEqual(roster.teamwork, []);
  assert.equal(teamworkReads, 0);
});

test('roster: a hired bench carries the persisted role events as teamwork', async () => {
  const client = makeClient({
    assignmentRows: [{
      id: 'role-assign-1', role: 'invoicing_collections',
      principal_type: 'ai_occupant', principal_id: 'donna_ai',
      ai_profile: 'clara', status: 'active', starts_at: 't0', ends_at: null
    }]
  });
  const event = {
    id: '41', type: 'role.handed_to_owner', at: 't2',
    responsible_role: 'invoicing_collections',
    current_actor: 'owner', next_commitment: 'approve_or_decline_send',
    action_type: 'send_receivable_reminder'
  };
  const roster = await readRoleRoster(client, {
    ...BASE,
    deps: {
      readOwnerActionsSurface: async () => ({}),
      readRoleTeamwork: async () => [event]
    }
  });
  assert.deepEqual(roster.teamwork, [event]);
});

test('roster: grants attach to their role by provenance; the reader excludes revoked in SQL', async () => {
  const client = makeClient({
    grantRows: [{
      id: 'grant-1', domain: 'outbound', action_type: 'send_receivable_reminder',
      scope_kind: 'counterparty', scope_key: 'acme', amount_ceiling: '500', currency: 'GBP',
      status: 'active', use_count: 2, correction_count: 0,
      expires_at: null, review_after: 't9',
      provenance: { role_id: 'invoicing_collections', grant_shape: 'standing_send_authority' },
      created_at: 't1'
    }]
  });
  const roster = await readRoleRoster(client, BASE);
  const collections = roster.roles.find((role) => role.id === 'invoicing_collections');
  assert.equal(collections.grants.length, 1);
  assert.equal(collections.grants[0].id, 'grant-1');
  const tax = roster.roles.find((role) => role.id === 'tax');
  assert.equal(tax.grants.length, 0);
  const grantSql = client.calls.find((call) => call.sql.includes('from action_authority_grants'));
  assert.ok(grantSql.sql.includes(`status in ('proposed', 'active', 'suspended')`));
  assert.ok(grantSql.sql.includes(`provenance->>'role_id' is not null`));
});
