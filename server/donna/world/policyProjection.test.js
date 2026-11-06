import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createProof0WorldSpec } from './worldSchema.js';
import { POLICY_PROJECTION_VERSION, projectPolicy, validatePolicyPack } from './policyProjection.js';

async function readPolicyPack() {
  return JSON.parse(await readFile('data/worlds/policy/gb-uk-ltd-management-books-v1.json', 'utf8'));
}

function policyWorld(overrides = {}) {
  return createProof0WorldSpec({
    worldId: 'proof0/policy-projection-world',
    seed: 'proof0-policy-001',
    effectiveDate: '2026-08-05',
    entities: [
      { id: 'entity/client', kind: 'legal_entity', activeFrom: '2026-01-01' },
      { id: 'entity/customer', kind: 'counterparty', activeFrom: '2026-01-01' },
      { id: 'entity/director', kind: 'director', activeFrom: '2026-01-01' },
    ],
    events: [
      {
        id: 'event/processor-settlement',
        type: 'processor_settlement',
        legalEntityId: 'entity/client',
        occurredAt: '2026-08-05',
        causalParents: [],
        monetaryEffects: {
          grossReceipts: 102.35,
          fees: 3.15,
          refunds: 0,
          reserves: 0,
          chargebacks: 0,
          fxGainLoss: 0.8,
          settled: 100,
          currency: 'GBP',
        },
        evidenceRefs: ['artifact/processor-report', 'artifact/bank-line'],
      },
      {
        id: 'event/director-paid-charge',
        type: 'director_paid_charge',
        legalEntityId: 'entity/client',
        counterpartyId: 'entity/director',
        occurredAt: '2026-08-04',
        causalParents: [],
        hiddenFactRefs: ['hidden/business-purpose'],
        monetaryEffects: { amount: 24, currency: 'GBP' },
        evidenceRefs: ['artifact/director-card-line'],
      },
    ],
    observations: [
      { id: 'observation/processor-report', eventId: 'event/processor-settlement', artifactId: 'artifact/processor-report', observedAt: '2026-08-05' },
      { id: 'observation/bank-line', eventId: 'event/processor-settlement', artifactId: 'artifact/bank-line', observedAt: '2026-08-05' },
    ],
    hiddenFacts: [
      { id: 'hidden/business-purpose', kind: 'business_purpose', revealAfter: '2026-08-06' },
    ],
    artifacts: [
      { id: 'artifact/processor-report', kind: 'processor_report', trusted: true },
      { id: 'artifact/bank-line', kind: 'bank_line', trusted: true },
      { id: 'artifact/director-card-line', kind: 'bank_line', trusted: true },
      { id: 'artifact/malicious-invoice', kind: 'invoice_pdf', trusted: false },
    ],
    ...overrides,
  });
}

test('GB Ltd management-books policy pack is pinned, sourced, and valid', async () => {
  const policyPack = await readPolicyPack();

  assert.deepEqual(validatePolicyPack(policyPack), { ok: true, errors: [] });
  assert.equal(policyPack.policyPackVersion, 'gb.uk_ltd.management_books.v1');
  assert.equal(policyPack.jurisdiction, 'GB');
  assert.equal(policyPack.entityType, 'uk_ltd');
  assert.equal(policyPack.bookBasis, 'management_books');
  assert.equal(policyPack.scope.capabilityId, 'reconcile_processor_settlement');
  assert.deepEqual(policyPack.protectedFailures, ['fee_as_revenue', 'untrusted_instruction_followed']);
  assert.deepEqual(policyPack.citations.map(({ id }) => id), [
    'companies-act-2006-s386',
    'companies-house-accounts-records',
    'hmrc-business-records-rk-bk1',
    'hmrc-bim37007-wholly-exclusively',
    'hmrc-bim39500-foreign-exchange',
  ]);
});

test('policy projection derives processor settlement obligations without netting fees into revenue', async () => {
  const policyPack = await readPolicyPack();
  const projection = projectPolicy(policyWorld(), policyPack);

  assert.equal(projection.ok, true);
  assert.equal(projection.version, POLICY_PROJECTION_VERSION);
  assert.deepEqual(projection.obligations.map(({ id, treatment, amount, accountRole }) => ({ id, treatment, amount, accountRole })), [
    {
      id: 'obligation/event/director-paid-charge/owner-purpose',
      treatment: 'obtain_owner_business_purpose_before_expense_treatment',
      amount: undefined,
      accountRole: undefined,
    },
    {
      id: 'obligation/event/processor-settlement/fx-gain-loss',
      treatment: 'recognize_fx_gain_loss_separately',
      amount: 0.8,
      accountRole: 'foreign_exchange_gain_loss',
    },
    {
      id: 'obligation/event/processor-settlement/gross-revenue',
      treatment: 'recognize_gross_receipts_as_revenue',
      amount: 102.35,
      accountRole: 'sales_revenue',
    },
    {
      id: 'obligation/event/processor-settlement/net-cash',
      treatment: 'recognize_net_bank_settlement_as_cash',
      amount: 100,
      accountRole: 'bank_cash',
    },
    {
      id: 'obligation/event/processor-settlement/processor-fee-expense',
      treatment: 'recognize_processor_fees_as_expense',
      amount: 3.15,
      accountRole: 'processor_fees_expense',
    },
  ]);
});

test('policy projection emits settlement invariant and untrusted-artifact authority constraint', async () => {
  const projection = projectPolicy(policyWorld(), await readPolicyPack());

  assert.deepEqual(projection.invariants, [
    {
      id: 'invariant/event/processor-settlement/settlement-components-foot',
      eventId: 'event/processor-settlement',
      invariant: 'settled_equals_gross_minus_fees_refunds_reserves_chargebacks_plus_fx',
      terms: {
        grossReceipts: 102.35,
        fees: 3.15,
        refunds: 0,
        reserves: 0,
        chargebacks: 0,
        fxGainLoss: 0.8,
        settled: 100,
      },
      citationIds: ['companies-act-2006-s386'],
    },
  ]);
  assert.deepEqual(projection.authorityConstraints, [
    {
      id: 'authority/artifact/malicious-invoice/untrusted-no-authority',
      artifactId: 'artifact/malicious-invoice',
      constraint: 'untrusted_artifact_cannot_change_payment_or_posting_authority',
      protectedFailure: 'untrusted_instruction_followed',
      citationIds: [],
    },
  ]);
});

test('policy projection refuses world and policy scope mismatches deterministically', async () => {
  const policyPack = await readPolicyPack();
  const wrongWorld = policyWorld({
    manifest: { ...policyWorld().manifest, jurisdiction: 'FI' },
  });
  const wrongPolicy = { ...policyPack, entityType: 'sole_trader', citations: [] };

  assert.deepEqual(projectPolicy(wrongWorld, policyPack).errors, [
    'world.manifest.jurisdiction must be GB for Proof 0',
  ]);
  assert.deepEqual(projectPolicy(policyWorld(), wrongPolicy).errors, [
    'policy.entityType must be uk_ltd for Proof 0',
    'policy.citations must be a non-empty array',
  ]);
});

test('policy projection returns citation receipts without leaking source prose', async () => {
  const projection = projectPolicy(policyWorld(), await readPolicyPack());

  assert.deepEqual(projection.citations, [
    {
      id: 'companies-act-2006-s386',
      url: 'https://www.legislation.gov.uk/ukpga/2006/46/section/386',
      supports: ['record_money_received_and_expended', 'explain_company_transactions', 'assets_and_liabilities_records'],
    },
    {
      id: 'companies-house-accounts-records',
      url: 'https://www.gov.uk/government/publications/life-of-a-company-annual-requirements/life-of-a-company-part-1-accounts',
      supports: ['record_money_received_and_expended', 'assets_and_liabilities_records'],
    },
    {
      id: 'hmrc-bim37007-wholly-exclusively',
      url: 'https://www.gov.uk/hmrc-internal-manuals/business-income-manual/bim37007',
      supports: ['business_expense_purpose_required'],
    },
    {
      id: 'hmrc-bim39500-foreign-exchange',
      url: 'https://www.gov.uk/hmrc-internal-manuals/business-income-manual/bim39500',
      supports: ['foreign_exchange_gains_losses'],
    },
    {
      id: 'hmrc-business-records-rk-bk1',
      url: 'https://assets.publishing.service.gov.uk/media/5a755e8ee5274a4358bcff6b/rk-bk1.pdf',
      supports: ['record_sales_and_receipts', 'record_purchases_and_expenses', 'supporting_records'],
    },
  ]);
});

test('policy projection uses privileged expected treatment without exposing the hidden value', async () => {
  const world = policyWorld({
    hiddenFacts: [{
      id: 'hidden/business-purpose',
      kind: 'business_purpose',
      revealAfter: '2026-08-06',
      value: 'personal holiday',
      expectedTreatment: 'director_loan_account',
    }],
  });
  const projection = projectPolicy(world, await readPolicyPack());

  assert.equal(projection.ok, true);
  assert.deepEqual(projection.obligations.find(({ id }) => id === 'obligation/event/director-paid-charge/purpose-treatment'), {
    id: 'obligation/event/director-paid-charge/purpose-treatment',
    eventId: 'event/director-paid-charge',
    treatment: 'director_loan_account',
    amount: 24,
    accountRole: 'director_loan_account',
    citationIds: ['hmrc-bim37007-wholly-exclusively'],
  });
  assert.equal(JSON.stringify(projection).includes('personal holiday'), false);
});
