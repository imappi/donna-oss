// FI-13 13.3A PR2 — YEL applicability derived from the ownership + authority
// models (D-FI13-7 v2). node --test server/donna/finland/oyYelApplicability.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import { computeCapTable } from './ownership.js';
import {
  FINLAND_OY_YEL_APPLICABILITY_FLAG_KEY,
  YEL_LEADING_POSITION_ROLES,
  YEL_OWNERSHIP_THRESHOLD_ALONE_PCT,
  YEL_OWNERSHIP_THRESHOLD_FAMILY_PCT,
  YEL_PENSION_REGIMES,
  evaluateOyYelApplicability
} from './oyYelApplicability.js';
import {
  getFinlandOyYelApplicabilityFromDb
} from '../statutoryRegistry.js';

// Build a cap table through the real computeCapTable so the family_group_ref
// passthrough is exercised end-to-end.
const holding = ({ id, name, ownershipShares, votesPerShare = 1, family = null }) => ({
  shareholder_id: id, display_name: name, party_type: 'natural_person', is_finnish_resident: true,
  family_group_ref: family, share_class_id: `cls-${votesPerShare}`, class_name: 'ordinary',
  votes_per_share: votesPerShare, share_count: ownershipShares
});
const role = ({ shareholderId = null, name = null, role: r }) => ({
  role: r, shareholder_id: shareholderId, holder_display_name: name, holder_ref: null
});

test('pins: flag key, leading roles, thresholds, the closed regime enum', () => {
  assert.equal(FINLAND_OY_YEL_APPLICABILITY_FLAG_KEY, 'FINLAND_OY_YEL_APPLICABILITY');
  assert.deepEqual([...YEL_LEADING_POSITION_ROLES], ['board_membership', 'company_representation']);
  assert.equal(YEL_OWNERSHIP_THRESHOLD_ALONE_PCT, 30);
  assert.equal(YEL_OWNERSHIP_THRESHOLD_FAMILY_PCT, 50);
  assert.deepEqual([...YEL_PENSION_REGIMES], ['yel', 'tyel', 'undetermined']);
});

test('empty models → not determinable, escalate rather than guess', () => {
  const out = evaluateOyYelApplicability({ capTable: null, authorityRoles: [] });
  assert.equal(out.determinable, false);
  assert.deepEqual(out.persons, []);
  assert.equal(out.confirmedAgainstPrimary, false);
  assert.deepEqual([...out.caveats], ['indirect_holdings_not_modelled']);
  assert.doesNotThrow(() => evaluateOyYelApplicability());
});

test('the single 100 % owner in a leading position is YEL, not TyEL', () => {
  const capTable = computeCapTable({ holdings: [holding({ id: 's1', name: 'Owner', ownershipShares: 100 })] });
  const out = evaluateOyYelApplicability({
    capTable,
    authorityRoles: [role({ shareholderId: 's1', role: 'board_membership' }), role({ shareholderId: 's1', role: 'company_representation' })]
  });
  assert.equal(out.determinable, true);
  assert.equal(out.persons.length, 1);
  const p = out.persons[0];
  assert.equal(p.pension_regime, 'yel');
  assert.equal(p.basis, 'leading_position_over_30_alone');
  assert.equal(p.leading_position, true);
  assert.deepEqual(p.leading_roles, ['board_membership', 'company_representation']);
  assert.equal(p.controlling_pct, 100);
  assert.ok(p.note_fi.includes('YEL'));
  // Donna NEVER emits a työtulo figure.
  assert.equal('work_income_eur' in p, false);
  assert.equal(JSON.stringify(out).includes('työtulo'), true); // only ever in the "we do NOT determine" copy
});

test('leading position but minority ownership → TyEL', () => {
  const capTable = computeCapTable({
    holdings: [holding({ id: 's1', name: 'Minority', ownershipShares: 20 }), holding({ id: 's2', name: 'Major', ownershipShares: 80 })]
  });
  const out = evaluateOyYelApplicability({ capTable, authorityRoles: [role({ shareholderId: 's1', role: 'board_membership' })] });
  const s1 = out.persons.find((p) => p.shareholder_id === 's1');
  assert.equal(s1.pension_regime, 'tyel');
  assert.equal(s1.basis, 'below_ownership_threshold');
  // s2 owns 80 % but holds no leading role → undetermined (passive owner).
  const s2 = out.persons.find((p) => p.shareholder_id === 's2');
  assert.equal(s2.pension_regime, 'undetermined');
  assert.equal(s2.basis, 'no_leading_position');
});

test('family aggregation lifts a leading minority owner over the 50 % family line → YEL', () => {
  const capTable = computeCapTable({
    holdings: [
      holding({ id: 's1', name: 'Spouse A', ownershipShares: 30, family: 'fam-1' }),
      holding({ id: 's2', name: 'Spouse B', ownershipShares: 30, family: 'fam-1' }),
      holding({ id: 's3', name: 'Outsider', ownershipShares: 40 })
    ]
  });
  const out = evaluateOyYelApplicability({ capTable, authorityRoles: [role({ shareholderId: 's1', role: 'company_representation' })] });
  const s1 = out.persons.find((p) => p.shareholder_id === 's1');
  assert.equal(s1.controlling_pct, 30); // alone below 30 (not strictly over)
  assert.equal(s1.family_controlling_pct, 60); // 30 + 30 with family
  assert.equal(s1.pension_regime, 'yel');
  assert.equal(s1.basis, 'leading_position_over_50_family');
});

test('voting rights count: 20 % shares but 40 % votes (multi-vote class) → over the 30 % line', () => {
  const capTable = computeCapTable({
    holdings: [
      holding({ id: 's1', name: 'Controller', ownershipShares: 20, votesPerShare: 10 }), // 200 votes
      holding({ id: 's2', name: 'Rest', ownershipShares: 80, votesPerShare: 1 }) // 80 votes → s1 = 200/280 ≈ 71 % votes
    ]
  });
  const out = evaluateOyYelApplicability({ capTable, authorityRoles: [role({ shareholderId: 's1', role: 'board_membership' })] });
  const s1 = out.persons.find((p) => p.shareholder_id === 's1');
  assert.ok(s1.voting_pct > 30, 'votes exceed 30 % even though shares are 20 %');
  assert.equal(s1.pension_regime, 'yel');
  assert.equal(s1.basis, 'leading_position_over_30_alone');
});

test('a hired managing director with no shares is TyEL; the model still classifies them', () => {
  const capTable = computeCapTable({ holdings: [holding({ id: 's1', name: 'Owner', ownershipShares: 100 })] });
  const out = evaluateOyYelApplicability({
    capTable,
    authorityRoles: [
      role({ shareholderId: 's1', role: 'board_membership' }),
      role({ name: 'Hired CEO', role: 'company_representation' }) // no shareholder link
    ]
  });
  const ceo = out.persons.find((p) => p.display_name === 'Hired CEO');
  assert.equal(ceo.pension_regime, 'tyel');
  assert.equal(ceo.basis, 'leading_position_no_ownership');
  assert.equal(ceo.controlling_pct, 0);
  // The 100 % owner-director is YEL.
  assert.equal(out.persons.find((p) => p.shareholder_id === 's1').pension_regime, 'yel');
});

// ── The DB caller (entity-gated + flag-gated) ────────────────────────────────

const fakeClient = ({ entityType = 'fi-oy', flags = {}, shareholdings = [], authorityRows = [] } = {}) => ({
  async query(sql, params = []) {
    if (sql.includes('select id from clients')) return { rows: [{ id: 'client-1' }] };
    if (sql.includes('entity_type') && sql.includes('from clients')) {
      return { rows: [{ entity_type: entityType, profile: null }] };
    }
    if (sql.includes('from client_capability_config')) {
      return { rows: Object.entries(flags).map(([flag_key, stage]) => ({ flag_key, stage, source: 'test', client_id: 'client-1' })) };
    }
    if (sql.includes('from cohort_capability_config')) return { rows: [] };
    if (sql.includes('from finland_shareholdings')) return { rows: shareholdings };
    if (sql.includes('from finland_authority_roles')) return { rows: authorityRows };
    throw new Error(`Unexpected query: ${sql}`);
  }
});

const call = (opts) => getFinlandOyYelApplicabilityFromDb({
  firmId: 'firm-1', clientId: 'client-1', readAt: '2026-07-12T00:00:00.000Z',
  withFirmDbClientFn: async (fn) => fn(fakeClient(opts))
});

test('DB caller: a non-oy client is refused (409); a dark flag is a typed 403', async () => {
  await assert.rejects(
    call({ entityType: 'fi-toiminimi', flags: { FINLAND_OY_YEL_APPLICABILITY: 'canary' } }),
    (e) => e.statusCode === 409 && e.code === 'FINLAND_OY_YEL_ENTITY_NOT_OY'
  );
  await assert.rejects(
    call({ entityType: 'fi-oy', flags: {} }),
    (e) => e.statusCode === 403 && e.code === 'FINLAND_OY_YEL_APPLICABILITY_DISABLED'
  );
});

test('DB caller: an fi-oy canary derives applicability from the persisted models', async () => {
  const out = await call({
    entityType: 'fi-oy',
    flags: { FINLAND_OY_YEL_APPLICABILITY: 'canary' },
    shareholdings: [{
      shareholder_id: 's1', display_name: 'Owner', party_type: 'natural_person', is_finnish_resident: true,
      family_group_ref: null, share_class_id: 'cls', class_name: 'ordinary', votes_per_share: 1, share_count: 100
    }],
    authorityRows: [
      { id: 'a1', holder_display_name: 'Owner', holder_ref: null, shareholder_id: 's1', role: 'board_membership', authority_basis: 'trade_register', valid_from: '2026-01-01', valid_until: null, status: 'active' },
      { id: 'a2', holder_display_name: 'Owner', holder_ref: null, shareholder_id: 's1', role: 'company_representation', authority_basis: 'trade_register', valid_from: '2026-01-01', valid_until: null, status: 'active' }
    ]
  });
  assert.equal(out.applicability.determinable, true);
  assert.equal(out.applicability.persons.length, 1);
  assert.equal(out.applicability.persons[0].pension_regime, 'yel');
  assert.equal(out.applicability.confirmedAgainstPrimary, false);
  assert.equal(out.provenance.deterministic, true);
});
