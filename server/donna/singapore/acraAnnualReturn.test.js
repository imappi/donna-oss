// SG-5 — ACRA calendar + XBRL requirement + the annual-return readiness verdict.
// node --test server/donna/singapore/acraAnnualReturn.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SINGAPORE_ACRA_FILINGS_FLAG_KEY,
  ACRA_FILING_PROVENANCE,
  buildAcraStatutoryDeadlines,
  XBRL_SMALLER_COMPANY_CEILING_SGD,
  XBRL_REQUIREMENTS,
  xbrlRequirementFor,
  buildAnnualReturnAssessment
} from './acraAnnualReturn.js';

test('the statutory calendar: AGM +6 months, annual return +7 months, month-end clamped', () => {
  assert.equal(SINGAPORE_ACRA_FILINGS_FLAG_KEY, 'SINGAPORE_ACRA_FILINGS');
  const calendar = buildAcraStatutoryDeadlines({ fyEndsOn: '2025-12-31' });
  const [agm, ar] = calendar.deadlines;
  assert.equal(agm.kind, 'agm');
  assert.equal(agm.due_on, '2026-06-30');
  assert.equal(agm.applies, true);
  assert.equal(ar.kind, 'annual_return');
  assert.equal(ar.due_on, '2026-07-31');
  // Month-end clamp: FYE Aug 31 → AGM due Feb 28/29.
  assert.equal(buildAcraStatutoryDeadlines({ fyEndsOn: '2025-08-31' }).deadlines[0].due_on, '2026-02-28');
  // AGM exemption flips applies, keeps the row (never dropped silently).
  const exempt = buildAcraStatutoryDeadlines({ fyEndsOn: '2025-12-31', agmExempt: true });
  assert.equal(exempt.deadlines[0].applies, false);
  assert.match(exempt.deadlines[0].note, /exempt/i);
  assert.throws(() => buildAcraStatutoryDeadlines({}), (e) => e.code === 'SINGAPORE_ACRA_PERIOD_INVALID');
  assert.equal(ACRA_FILING_PROVENANCE.confirmedAgainstPrimary, true);
});

test('XBRL requirement: solvent EPC none; smaller company simplified; otherwise full', () => {
  assert.equal(XBRL_SMALLER_COMPANY_CEILING_SGD, 500000);
  assert.deepEqual([...XBRL_REQUIREMENTS], ['none', 'simplified', 'full']);
  assert.equal(xbrlRequirementFor({ exemptPrivateCompany: true, solvent: true }), 'none');
  assert.equal(
    xbrlRequirementFor({ exemptPrivateCompany: true, solvent: false, revenue: 100000, totalAssets: 100000 }),
    'simplified',
    'an insolvent EPC files — smaller-company tier applies'
  );
  assert.equal(xbrlRequirementFor({ revenue: 400000, totalAssets: 450000 }), 'simplified');
  assert.equal(xbrlRequirementFor({ revenue: 600000, totalAssets: 100000 }), 'full', 'either ceiling breached → full');
  assert.equal(xbrlRequirementFor({ revenue: 100000, totalAssets: 600000 }), 'full');
  assert.equal(xbrlRequirementFor({ revenue: 100000, totalAssets: 100000, publiclyAccountable: true }), 'full');
});

test('the annual-return readiness verdict names its blockers (two-terminal-states: each becomes an owner ask)', () => {
  const blocked = buildAnnualReturnAssessment({
    fyEndsOn: '2025-12-31',
    financialStatementsReady: false,
    agmHeldOn: null,
    revenue: 300000,
    totalAssets: 200000
  });
  assert.equal(blocked.status, 'needs_review');
  assert.deepEqual(blocked.blockers, ['financial_statements_not_ready', 'agm_not_held', 'xbrl_source_statements_missing']);
  assert.equal(blocked.xbrl_requirement, 'simplified');

  const ready = buildAnnualReturnAssessment({
    fyEndsOn: '2025-12-31',
    financialStatementsReady: true,
    agmHeldOn: '2026-05-15',
    exemptPrivateCompany: true,
    solvent: true
  });
  assert.equal(ready.status, 'ready');
  assert.deepEqual(ready.blockers, []);
  assert.equal(ready.xbrl_requirement, 'none');

  const agmExempt = buildAnnualReturnAssessment({
    fyEndsOn: '2025-12-31',
    agmExempt: true,
    financialStatementsReady: true,
    exemptPrivateCompany: true,
    solvent: true
  });
  assert.equal(agmExempt.status, 'ready', 'an AGM-exempt company does not block on agm_not_held');
});

// ACRA Financial statements: Filing requirements & exemptions, retrieved 2026-09-24.
// https://www.acra.gov.sg/manage/companies/legal-requirements-common-offences/filing-financial-statements-in-xbrl-format/requirements-exemptions/
test('smaller-company tier includes exactly S$500k in both current-year measures', () => {
  assert.equal(xbrlRequirementFor({ revenue: 500000, totalAssets: 500000 }), 'simplified');
  assert.equal(xbrlRequirementFor({ revenue: 500000.01, totalAssets: 500000 }), 'full');
  assert.equal(xbrlRequirementFor({ revenue: 500000, totalAssets: 500000.01 }), 'full');
  assert.equal(ACRA_FILING_PROVENANCE.epc.quote, 'not more than 20 members');
  assert.match(ACRA_FILING_PROVENANCE.xbrl.scope, /consolidated/);
});

// ACRA Step 4.2: Choosing a company's financial year end, 2026-09-24.
// https://www.acra.gov.sg/register/business/registering-different-business-structures/local-company/choosing-a-companys-financial-year-end/
test('ACRA September-FYE dates preserve the day, unlike IRAS month-end ECI dates', () => {
  const [agm, ar] = buildAcraStatutoryDeadlines({ fyEndsOn: '2025-09-30' }).deadlines;
  assert.equal(agm.due_on, '2026-03-30');
  assert.equal(ar.due_on, '2026-04-30');
});
