// roleEmployment (S2) — the employment contract, split from authorization.
// Pins the slice's laws:
//   - INV-S10 with teeth: a hire stages the envelope and mints NO grant rows;
//   - the stage law: OUTBOUND_* lanes hire at 'canary' (structurally ask-first
//     — the A2 gate caps canary at hold_for_approval and 'auto' is refused by
//     AUTO_FORBIDDEN_FLAGS); every other lane hires at 'shadow' (observe);
//   - a hire only ever stages UP — existing stages are never lowered/churned;
//   - authority ⊆ leash: a grant outside the role's action_set refuses;
//   - grants require employment, a time bound, and the owner actor;
//   - occupant replacement is end-then-hire, never a silent upsert swap;
//   - every writer receipts (role.hired / role.ended / role.grant_approved /
//     role.grant_revoked) in the same transaction.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ROLE_EMPLOYMENT_AUDIT_ACTIONS,
  AI_OCCUPANT_PRINCIPAL_ID,
  ROLE_HIRE_CONFIG_SOURCE,
  GRANT_SHAPE_DOMAINS,
  hireStageForFlag,
  buildRoleAssignmentId,
  compileRoleEnvelope,
  readActiveSpecialistAssignment,
  hireRole,
  endRoleAssignment,
  approveRoleGrant,
  revokeRoleGrant
} from './roleEmployment.js';
import { ROLE_DEFINITIONS, findRoleDefinition } from './roleRegistry.js';
import { assertStageAllowedForFlag } from '../clientConfig.js';

const R1 = findRoleDefinition('invoicing_collections');

// Fake client covering the SQL surface of the module + the config writer it
// routes through (setClientFlagStage: close-then-insert + audit).
const makeClient = ({
  assignmentRows = [], snapshotRows = [], grantRows = [], updatedAssignmentRows = null
} = {}) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      const text = String(sql);
      calls.push({ sql: text, params });
      const lower = text.toLowerCase();
      if (lower.includes('select id, principal_type, principal_id, status from client_assignments')) {
        return { rows: assignmentRows };
      }
      if (lower.includes('select * from client_assignments')) {
        return { rows: assignmentRows };
      }
      if (lower.includes('update client_assignments')) {
        return { rows: updatedAssignmentRows ?? [] };
      }
      if (lower.includes('insert into client_assignments')) return { rows: [] };
      if (lower.includes('from cohort_capability_config')) return { rows: [] };
      if (lower.includes('select flag_key, stage, source, client_id')) {
        return { rows: snapshotRows };
      }
      if (lower.includes('update client_capability_config')) return { rows: [] };
      if (lower.includes('insert into client_capability_config')) return { rows: [] };
      if (lower.includes('from action_authority_grants')) return { rows: grantRows };
      if (lower.includes('insert into action_authority_grants')) {
        return { rows: [{ id: params[0], inserted: true, status: params[13] }] };
      }
      if (lower.includes('update action_authority_grants')) {
        return { rows: grantRows };
      }
      if (lower.includes('insert into audit_events')) return { rows: [] };
      throw new Error(`unexpected sql: ${text}`);
    }
  };
};

const auditsOf = (client, action) =>
  client.calls.filter((c) => c.sql.includes('insert into audit_events') && c.params?.includes(action));

const BASE = { firmId: 'firm-1', clientId: 'client-1' };

// ── The stage law ───────────────────────────────────────────────────────────

test('hire stage law: OUTBOUND_* lanes hire at canary (ask-first by construction), everything else at shadow', () => {
  assert.equal(hireStageForFlag('OUTBOUND_DUNNING'), 'canary');
  assert.equal(hireStageForFlag('OUTBOUND_PAY_LINKS'), 'canary');
  assert.equal(hireStageForFlag('HMRC_MTD_VAT'), 'shadow');
  assert.equal(hireStageForFlag('INVENTORY_ACCOUNTING'), 'shadow');
});

test('every registry template flag hires at a stage the guarded writer accepts (never auto, never past a ceiling)', () => {
  for (const role of ROLE_DEFINITIONS) {
    for (const flagKey of role.authority_template.flags) {
      const stage = hireStageForFlag(flagKey);
      assert.ok(['shadow', 'canary'].includes(stage), `${flagKey} hires at ${stage}`);
      assert.doesNotThrow(() => assertStageAllowedForFlag(flagKey, stage));
    }
  }
});

test('every registry grant shape has a domain mapping (a shape without one cannot be approved)', () => {
  for (const role of ROLE_DEFINITIONS) {
    for (const shape of role.authority_template.grant_shapes) {
      assert.ok(GRANT_SHAPE_DOMAINS[shape.kind], `shape '${shape.kind}' (role ${role.id}) has no domain`);
    }
  }
});

// ── The envelope compiler ───────────────────────────────────────────────────

test('compileRoleEnvelope stages up from empty, keeps equal-or-higher stages, and fail-closes on garbage', () => {
  const snapshot = {
    OUTBOUND_INVOICING: { stage: 'canary', source: 'manual' }, // already at posture → keep
    OUTBOUND_QUOTES: { stage: 'shadow', source: 'manual' },    // below → stage up
    OUTBOUND_DUNNING: { stage: 'weird', source: 'manual' }     // unrankable → keep (fail closed)
  };
  const envelope = compileRoleEnvelope({ role: R1, snapshot });
  const byFlag = Object.fromEntries(envelope.flags.map((f) => [f.flag_key, f]));
  assert.deepEqual(byFlag.OUTBOUND_INVOICING, { flag_key: 'OUTBOUND_INVOICING', from: 'canary', to: 'canary', action: 'keep' });
  assert.deepEqual(byFlag.OUTBOUND_QUOTES, { flag_key: 'OUTBOUND_QUOTES', from: 'shadow', to: 'canary', action: 'stage' });
  assert.deepEqual(byFlag.OUTBOUND_DUNNING, { flag_key: 'OUTBOUND_DUNNING', from: 'weird', to: 'weird', action: 'keep' });
  assert.deepEqual(byFlag.OUTBOUND_PAY_LINKS, { flag_key: 'OUTBOUND_PAY_LINKS', from: null, to: 'canary', action: 'stage' });
  assert.deepEqual(envelope.grant_shapes_offered, R1.authority_template.grant_shapes);
});

test('buildRoleAssignmentId is deterministic and keyed by firm × client × role', () => {
  const a = buildRoleAssignmentId({ firmId: 'f', clientId: 'c', roleId: 'invoicing_collections' });
  assert.equal(a, buildRoleAssignmentId({ firmId: 'f', clientId: 'c', roleId: 'invoicing_collections' }));
  assert.notEqual(a, buildRoleAssignmentId({ firmId: 'f', clientId: 'c2', roleId: 'invoicing_collections' }));
  assert.match(a, /^role-assign-invoicing-collections-c-/);
});

// ── HIRE (INV-S10 with teeth) ───────────────────────────────────────────────

test('hireRole stages the envelope, receipts role.hired, and mints NO grants (INV-S10)', async () => {
  const client = makeClient();
  const out = await hireRole(client, { ...BASE, roleId: 'invoicing_collections', actorType: 'owner', actorId: 'kari@books.example' });
  assert.equal(out.hired, true);
  assert.equal(out.envelope.flags.filter((f) => f.action === 'stage').length, R1.authority_template.flags.length);
  // Six flag stagings, each through the audited config writer at the hire posture.
  const configInserts = client.calls.filter((c) => c.sql.includes('insert into client_capability_config'));
  assert.equal(configInserts.length, 6);
  for (const call of configInserts) {
    assert.equal(call.params[4], 'canary'); // stage
    assert.equal(call.params[5], ROLE_HIRE_CONFIG_SOURCE); // source
  }
  // INV-S10: no grant rows minted by a hire, ever.
  assert.equal(client.calls.filter((c) => c.sql.includes('insert into action_authority_grants')).length, 0);
  // The employment receipt, in-transaction.
  const receipts = auditsOf(client, ROLE_EMPLOYMENT_AUDIT_ACTIONS.hired);
  assert.equal(receipts.length, 1);
  const metadata = JSON.parse(receipts[0].params[6]);
  assert.equal(metadata.role_id, 'invoicing_collections');
  assert.deepEqual(metadata.grants_minted, []);
  assert.equal(metadata.occupant.principal_id, AI_OCCUPANT_PRINCIPAL_ID);
  assert.equal(metadata.occupant.ai_profile, 'clara');
});

test('hireRole is idempotent for the same active occupant — no restaging, no receipt churn', async () => {
  const client = makeClient({
    assignmentRows: [{ id: 'ra1', principal_type: 'ai_occupant', principal_id: AI_OCCUPANT_PRINCIPAL_ID, status: 'active' }]
  });
  const out = await hireRole(client, { ...BASE, roleId: 'invoicing_collections' });
  assert.deepEqual(out, { hired: false, assignment_id: 'ra1', envelope: null });
  assert.equal(client.calls.filter((c) => c.sql.includes('insert into client_capability_config')).length, 0);
  assert.equal(auditsOf(client, ROLE_EMPLOYMENT_AUDIT_ACTIONS.hired).length, 0);
});

test('hireRole refuses a silent occupant swap on an occupied role', async () => {
  const client = makeClient({
    assignmentRows: [{ id: 'ra1', principal_type: 'firm_collaborator', principal_id: 'collab-7', status: 'active' }]
  });
  await assert.rejects(
    () => hireRole(client, { ...BASE, roleId: 'invoicing_collections' }),
    /end that assignment first/
  );
});

test('hireRole is an OWNER action and refuses unknown roles', async () => {
  await assert.rejects(() => hireRole(makeClient(), { ...BASE, roleId: 'invoicing_collections', actorType: 'system' }), /OWNER action/);
  await assert.rejects(() => hireRole(makeClient(), { ...BASE, roleId: 'nope' }), /unknown role/);
});

test('hireRole validates a human occupant through the assignment shape law (persona on AI only)', async () => {
  const client = makeClient();
  const out = await hireRole(client, {
    ...BASE,
    roleId: 'invoicing_collections',
    occupant: { actor_type: 'human', principal_type: 'firm_collaborator', principal_id: 'collab-7' }
  });
  assert.equal(out.hired, true);
  const receipts = auditsOf(client, ROLE_EMPLOYMENT_AUDIT_ACTIONS.hired);
  const metadata = JSON.parse(receipts[0].params[6]);
  assert.equal(metadata.occupant.principal_type, 'firm_collaborator');
  assert.equal(metadata.occupant.ai_profile, null);
  // An AI occupant with an unknown profile refuses at the shape law.
  await assert.rejects(
    () => hireRole(makeClient(), {
      ...BASE,
      roleId: 'invoicing_collections',
      occupant: { actor_type: 'ai', principal_type: 'ai_occupant', principal_id: 'donna_ai', ai_profile: 'nobody' }
    }),
    /invalid assignment/
  );
});

// ── END ─────────────────────────────────────────────────────────────────────

test('endRoleAssignment ends + receipts with the lower/revoke checklist; flags are left as-is', async () => {
  const client = makeClient({
    updatedAssignmentRows: [{ id: 'ra1', principal_type: 'ai_occupant', principal_id: AI_OCCUPANT_PRINCIPAL_ID, ai_profile: 'clara' }],
    snapshotRows: [{ flag_key: 'OUTBOUND_DUNNING', stage: 'canary', source: 'role_hire', client_id: 'client-1' }],
    grantRows: [{ id: 'ag1', domain: 'outbound', action_type: 'send_receivable_reminder', scope_kind: 'counterparty', scope_key: 'p-1', amount_ceiling: '500', currency: 'GBP', status: 'active' }]
  });
  const out = await endRoleAssignment(client, { ...BASE, roleId: 'invoicing_collections', reason: 'trial over' });
  assert.equal(out.ended, true);
  // No flag is lowered by an end — the receipt is the checklist, not the act.
  assert.equal(client.calls.filter((c) => c.sql.includes('insert into client_capability_config')).length, 0);
  const receipts = auditsOf(client, ROLE_EMPLOYMENT_AUDIT_ACTIONS.ended);
  assert.equal(receipts.length, 1);
  const metadata = JSON.parse(receipts[0].params[6]);
  assert.equal(metadata.flags_left_as_is.find((f) => f.flag_key === 'OUTBOUND_DUNNING').stage, 'canary');
  assert.deepEqual(metadata.grants_left_live.map((g) => g.id), ['ag1']);
});

test('endRoleAssignment with nothing to end returns ended:false and writes nothing', async () => {
  const client = makeClient({ updatedAssignmentRows: [] });
  const out = await endRoleAssignment(client, { ...BASE, roleId: 'invoicing_collections' });
  assert.deepEqual(out, { ended: false, assignment_id: null });
  assert.equal(auditsOf(client, ROLE_EMPLOYMENT_AUDIT_ACTIONS.ended).length, 0);
});

// ── APPROVE / REVOKE ────────────────────────────────────────────────────────

const HIRED = [{ id: 'ra1', role: 'invoicing_collections', principal_type: 'ai_occupant', principal_id: AI_OCCUPANT_PRINCIPAL_ID, status: 'active' }];
const APPROVAL = {
  ...BASE,
  roleId: 'invoicing_collections',
  grantShape: 'standing_send_authority',
  actionType: 'send_receivable_reminder',
  scopeKey: 'party-9',
  amountCeiling: 500,
  currency: 'GBP',
  reviewAfter: '2026-11-14T00:00:00Z',
  actorId: 'kari@books.example'
};

test('approveRoleGrant mints through the store with role provenance and receipts role.grant_approved', async () => {
  const client = makeClient({ assignmentRows: HIRED });
  const out = await approveRoleGrant(client, APPROVAL);
  assert.equal(out.inserted, true);
  assert.equal(out.status, 'active');
  const mint = client.calls.find((c) => c.sql.includes('insert into action_authority_grants'));
  assert.ok(mint, 'grant minted through the store');
  const provenance = JSON.parse(mint.params[12]);
  assert.equal(provenance.role_id, 'invoicing_collections');
  assert.equal(provenance.assignment_id, 'ra1');
  assert.equal(provenance.grant_shape, 'standing_send_authority');
  assert.equal(auditsOf(client, ROLE_EMPLOYMENT_AUDIT_ACTIONS.grantApproved).length, 1);
});

test('approveRoleGrant refuses: outside the leash, unknown shape, no time bound, unhired role, non-owner', async () => {
  const hired = () => makeClient({ assignmentRows: HIRED });
  await assert.rejects(() => approveRoleGrant(hired(), { ...APPROVAL, actionType: 'send_payable_notice' }), /outside role/);
  await assert.rejects(() => approveRoleGrant(hired(), { ...APPROVAL, grantShape: 'nope' }), /does not offer grant shape/);
  await assert.rejects(() => approveRoleGrant(hired(), { ...APPROVAL, reviewAfter: null, expiresAt: null }), /time bound is required/);
  await assert.rejects(() => approveRoleGrant(makeClient({ assignmentRows: [] }), APPROVAL), /not actively hired/);
  await assert.rejects(() => approveRoleGrant(hired(), { ...APPROVAL, actorType: 'system' }), /OWNER action/);
});

test('revokeRoleGrant revokes through the store and receipts role.grant_revoked with the role linkage', async () => {
  const client = makeClient({
    grantRows: [{
      id: 'ag1', client_id: 'client-1', domain: 'outbound', action_type: 'send_receivable_reminder',
      scope_kind: 'counterparty', scope_key: 'party-9', status: 'revoked',
      provenance: { role_id: 'invoicing_collections', assignment_id: 'ra1' }
    }]
  });
  const out = await revokeRoleGrant(client, { ...BASE, grantId: 'ag1', reason: 'too generous' });
  assert.deepEqual(out, { revoked: true, grant_id: 'ag1', role_id: 'invoicing_collections' });
  assert.equal(auditsOf(client, ROLE_EMPLOYMENT_AUDIT_ACTIONS.grantRevoked).length, 1);
});

test('revokeRoleGrant on a missing/already-revoked grant returns revoked:false and writes no receipt', async () => {
  const client = makeClient({ grantRows: [] });
  const out = await revokeRoleGrant(client, { ...BASE, grantId: 'ag-missing' });
  assert.deepEqual(out, { revoked: false, grant_id: 'ag-missing' });
  assert.equal(auditsOf(client, ROLE_EMPLOYMENT_AUDIT_ACTIONS.grantRevoked).length, 0);
});

test('readActiveSpecialistAssignment returns the active occupant row or null', async () => {
  const hit = await readActiveSpecialistAssignment(makeClient({ assignmentRows: HIRED }), { ...BASE, roleId: 'invoicing_collections' });
  assert.equal(hit.id, 'ra1');
  const miss = await readActiveSpecialistAssignment(makeClient({ assignmentRows: [] }), { ...BASE, roleId: 'invoicing_collections' });
  assert.equal(miss, null);
});
