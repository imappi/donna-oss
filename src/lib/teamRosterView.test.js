// teamRosterView (S3) — pins the card-state laws:
//   INV-S9 chip ceiling (Supervised unless the server's S6 claim ladder says
//   exactly 'autonomous'; the chip renders the claim, never derives one),
//   INV-S8 two-shape status line from the persisted projection,
//   the hireable law (empty leash / parked roles are not hireable),
//   honest controls (Hire renders only when the bench flag acts),
//   the hire confirm states the envelope plan + INV-S10.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PARKED_ROLE_IDS,
  isRoleHired,
  isRoleHireable,
  roleChip,
  roleCta,
  roleStatusLine,
  hireConfirmCopy,
  grantSummary
} from './teamRosterView.js';

const collections = ({ hired = false, projection = null, envelope = null } = {}) => ({
  id: 'invoicing_collections',
  title: 'Invoices & Collections',
  action_set: ['issue_invoice', 'send_quote', 'send_receivable_reminder', 'create_pay_link'],
  profile: { persona: 'Clara' },
  assignment: hired ? { status: 'active' } : null,
  projection,
  envelope
});

const tax = { id: 'tax', title: 'Tax', action_set: [], assignment: null, projection: null };
const inventory = {
  id: 'inventory_purchasing', title: 'Inventory & Purchasing',
  action_set: ['post_inventory_journal'], assignment: null, projection: null
};

test('hireable law: empty leash and parked roles are not hireable', () => {
  assert.equal(isRoleHireable(collections()), true);
  assert.equal(isRoleHireable(tax), false, 'empty action_set has no surface to hire');
  assert.equal(isRoleHireable(inventory), false, 'parked until the dated scope-reversal call');
  assert.ok(PARKED_ROLE_IDS.includes('inventory_purchasing'));
});

test('chip ceiling (INV-S9): hired reads Supervised, unhired reads nothing', () => {
  assert.deepEqual(roleChip(collections({ hired: true })), { label: 'Supervised', tone: 'ok' });
  assert.equal(roleChip(collections()), null);
});

test('chip ladder (S6): only exactly claim=autonomous flips the chip; anything else stays Supervised', () => {
  const hired = collections({ hired: true });
  assert.deepEqual(roleChip({ ...hired, certification_claim: 'autonomous' }), { label: 'Autonomous', tone: 'ok' });
  for (const claim of ['preview', 'certified', 'green', 'AUTONOMOUS', true, 1, null, undefined]) {
    assert.deepEqual(roleChip({ ...hired, certification_claim: claim }), { label: 'Supervised', tone: 'ok' },
      `claim ${String(claim)} must not flip the chip`);
  }
  // Unhired never chips, certified or not.
  assert.equal(roleChip({ ...collections(), certification_claim: 'autonomous' }), null);
});

test('CTA honesty: Hire only under act mode; parked and empty-leash roles get labels, never buttons', () => {
  assert.deepEqual(roleCta(collections(), 'act'), { kind: 'hire', label: 'Hire' });
  assert.deepEqual(roleCta(collections(), 'shadow'), { kind: 'label', label: 'Coming soon' });
  assert.deepEqual(roleCta(collections(), 'off'), { kind: 'label', label: 'Coming soon' });
  assert.deepEqual(roleCta(tax, 'act'), { kind: 'label', label: 'Coming soon' });
  assert.deepEqual(roleCta(inventory, 'act'), { kind: 'label', label: 'Parked' });
  assert.equal(roleCta(collections({ hired: true }), 'act'), null);
});

test('status line (INV-S8): exactly two shapes, only from a persisted projection', () => {
  assert.equal(roleStatusLine(collections({ hired: true, projection: { waiting_on_owner: 0 } })), 'All handled');
  assert.equal(roleStatusLine(collections({ hired: true, projection: { waiting_on_owner: 3 } })), '3 waiting on you');
  assert.equal(roleStatusLine(collections({ hired: true })), null, 'no projection, no line — never freeform');
  assert.equal(roleStatusLine(collections({ projection: { waiting_on_owner: 2 } })), null, 'unhired projects nothing');
});

test('hire confirm: lists the staged lanes and states that hiring authorizes nothing', () => {
  const copy = hireConfirmCopy({
    role: collections({
      envelope: {
        flags: [
          { flag_key: 'OUTBOUND_INVOICING', from: null, to: 'canary', action: 'stage' },
          { flag_key: 'OUTBOUND_QUOTES', from: 'canary', to: 'canary', action: 'keep' }
        ]
      }
    })
  });
  assert.match(copy, /Hire Clara into Invoices & Collections\?/);
  assert.match(copy, /OUTBOUND_INVOICING: off to canary/);
  assert.ok(!copy.includes('OUTBOUND_QUOTES'), 'kept lanes are not listed as changes');
  assert.match(copy, /Nothing sends or posts without your approval/);
});

// The grantable-actions map moved server-side with the team-screen recede
// (roleEmployment.GRANT_SHAPE_ACTION_FAMILIES) — delegation happens in chat,
// so the FE keeps only read-only renderings.

test('grant summary reads as one terse line', () => {
  assert.equal(
    grantSummary({
      action_type: 'send_receivable_reminder', scope_key: 'Acme Ltd',
      amount_ceiling: 500, currency: 'GBP', review_after: '2026-11-12T00:00:00Z'
    }),
    'send receivable reminder for Acme Ltd up to 500 GBP review 2026-11-12'
  );
});

// ── S5: teamwork narration (INV-S5 — narration renders events, never a
// mechanism; unknown shapes render NOTHING) ──────────────────────────────────

test('S5: handoff events narrate deterministically by commitment and action type', async () => {
  const { narrateTeamworkEvent } = await import('./teamRosterView.js');
  const base = {
    id: '41', at: '2026-08-14T10:00:00Z',
    type: 'role.handed_to_owner',
    responsible_role: 'invoicing_collections',
    next_commitment: 'approve_or_decline_send'
  };
  assert.deepEqual(narrateTeamworkEvent({ ...base, action_type: 'issue_invoice' }), {
    id: '41', who: 'Clara',
    line: 'Clara prepared an invoice and is waiting on your approval.',
    at: '2026-08-14T10:00:00Z'
  });
  assert.equal(
    narrateTeamworkEvent({ ...base, action_type: 'send_receivable_reminder' }).line,
    'Clara prepared a payment reminder and is waiting on your approval.'
  );
  assert.equal(
    narrateTeamworkEvent({
      ...base, action_type: 'send_receivable_reminder',
      next_commitment: 'decide_collection_next_step'
    }).line,
    'Clara finished the reminder cadence and needs your call.'
  );
});

test('S5: resume events narrate the typed outcome', async () => {
  const { narrateTeamworkEvent } = await import('./teamRosterView.js');
  const base = {
    id: '42', at: '2026-08-14T11:00:00Z',
    type: 'role.resumed_from_owner',
    responsible_role: 'invoicing_collections',
    action_type: 'send_receivable_reminder'
  };
  assert.equal(narrateTeamworkEvent({ ...base, outcome: 'approved' }).line,
    'You approved. Clara sends it from here.');
  assert.equal(narrateTeamworkEvent({ ...base, outcome: 'declined' }).line,
    'You declined. Clara closed it out.');
  assert.equal(narrateTeamworkEvent({ ...base, outcome: 'withdrawn' }).line,
    'Clara withdrew it. Nothing for you to do.');
});

test('S5: unknown shapes render NOTHING — never a freeform line', async () => {
  const { narrateTeamworkEvent } = await import('./teamRosterView.js');
  assert.equal(narrateTeamworkEvent(null), null);
  assert.equal(narrateTeamworkEvent({}), null);
  assert.equal(narrateTeamworkEvent({
    type: 'role.handed_to_owner', responsible_role: 'not_a_role'
  }), null);
  assert.equal(narrateTeamworkEvent({
    type: 'role.resumed_from_owner',
    responsible_role: 'invoicing_collections', outcome: 'shrugged'
  }), null);
  assert.equal(narrateTeamworkEvent({
    type: 'role.gossiped', responsible_role: 'invoicing_collections'
  }), null);
});

test('S5: narration copy follows the UI rules (terse, no em dashes)', async () => {
  const { narrateTeamworkEvent } = await import('./teamRosterView.js');
  const lines = [
    narrateTeamworkEvent({
      id: '1', type: 'role.handed_to_owner', responsible_role: 'invoicing_collections',
      next_commitment: 'approve_or_decline_send', action_type: 'issue_invoice'
    }),
    narrateTeamworkEvent({
      id: '2', type: 'role.handed_to_owner', responsible_role: 'invoicing_collections',
      next_commitment: 'decide_collection_next_step', action_type: 'send_receivable_reminder'
    }),
    narrateTeamworkEvent({
      id: '3', type: 'role.resumed_from_owner', responsible_role: 'invoicing_collections',
      action_type: 'send_quote', outcome: 'approved'
    })
  ];
  for (const row of lines) {
    assert.ok(row, 'every known shape narrates');
    assert.ok(!row.line.includes('—'), 'no em dashes in UI copy');
    assert.ok(row.line.length <= 80, 'one terse line');
  }
});
