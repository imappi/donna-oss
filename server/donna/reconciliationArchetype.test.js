// Archetype gating — classifier unit tests (Slice 4 of #5).
// docs/proposal-2026-06-23-delegated-authority-material-matches.md (§7, §9).
//
// Load-bearing properties:
//   - the classifier is PURE + deterministic + fail-closed: any doubt → null;
//   - only the V1-safe set ever classifies non-null, and only recurring_rent_lease
//     can satisfy its evidence predicate from the V1 data surface;
//   - internal_transfer is ALWAYS null (no same-entity proof in V1); a
//     verified_card_payment shape is ALWAYS null (no verified card-liability link);
//   - every excluded nature / subtype fails closed;
//   - the canonical scope_key is pinned to a golden string (lookup + mint agree).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyReconciliationArchetype,
  ARCHETYPE_RECURRING_RENT_LEASE,
  ARCHETYPE_VERIFIED_CARD_PAYMENT,
  ARCHETYPE_INTERNAL_TRANSFER,
  scopeKindForArchetype,
  __test__
} from './reconciliationArchetype.js';

// A representative recurring rent bill we PAY: a supplier_bill from a vendor we
// have matched before, money_out, coded to ledger 6000, rent in the descriptor.
const rentDoc = (over = {}) => ({
  id: 'sb-rent-1',
  document_type: 'supplier_bill',
  vendor_name: 'Sonoran Properties',
  total_amount: 900,
  currency: 'GBP',
  reference_number: 'RENT-2026-06',
  filename: 'sonoran-rent-june.pdf',
  parse_summary: { warnings: [] },
  ...over
});

const rentLine = (over = {}) => ({
  id: 'tx-rent-1',
  money_in: 0,
  money_out: 900,
  currency: 'GBP',
  date: '2026-06-05',
  description: 'RENT SONORAN PROPERTIES',
  raw_description: 'MONTHLY RENT SONORAN PROPERTIES',
  contact: 'Sonoran Properties',
  account_code: '6000',
  ...over
});

const recurringContext = (vendor = 'Sonoran Properties') => ({
  recentConfirmedMatches: [
    { vendor_name: vendor, doc_amount: 900, doc_currency: 'GBP', tx_description: 'RENT' }
  ]
});

const classifyRent = (over = {}) =>
  classifyReconciliationArchetype({
    proposal: { bank_transaction_id: 'tx-rent-1', confidence: 0.95, hops: [] },
    bankLine: rentLine(over.bankLine),
    document: rentDoc(over.document),
    firmContext: over.firmContext === undefined ? recurringContext() : over.firmContext
  });

// The single golden scope_key the lookup AND a future mint must both produce.
const GOLDEN_RENT_SCOPE_KEY = 'merchant:sonoran-properties|doc:supplier-bill|acct:6000';

// ── recurring_rent_lease — the live V1 path ───────────────────────────
test('classify: a recurring, coded, rent-natured supplier bill → recurring_rent_lease', () => {
  const out = classifyRent();
  assert.equal(out.archetype, ARCHETYPE_RECURRING_RENT_LEASE);
  assert.equal(out.scopeKind, 'merchant');
  assert.equal(out.scopeKey, GOLDEN_RENT_SCOPE_KEY, 'canonical scope_key pinned (golden)');
  assert.equal(out.firstUseAccountInvolved, false, 'established account by construction');
  assert.equal(out.evidenceOk, true);
});

// ── scopeKindForArchetype — the Slice-3b grant-mint scope_kind source ──
// The confirm/grant handler reads the classifier's PERSISTED archetype + scope_key
// off the open authorization request (which has no scope_kind column) and derives
// scope_kind here. It MUST agree with what the classifier emits inline, or a minted
// grant's deterministic id diverges from the lookup the orchestrator will perform.
test('scopeKindForArchetype: agrees with the classifier and fails closed off the V1 set', () => {
  const out = classifyRent();
  assert.equal(scopeKindForArchetype(out.archetype), out.scopeKind, 'derived scope_kind == the classifier verdict');
  assert.equal(scopeKindForArchetype(ARCHETYPE_RECURRING_RENT_LEASE), 'merchant', 'rent/lease → merchant');
  // Excluded / non-grantable archetypes have no mint scope_kind (fail closed → the
  // handler refuses to mint and offers confirm-only instead).
  assert.equal(scopeKindForArchetype(ARCHETYPE_VERIFIED_CARD_PAYMENT), null, 'excluded archetype → null');
  assert.equal(scopeKindForArchetype(ARCHETYPE_INTERNAL_TRANSFER), null, 'excluded archetype → null');
  assert.equal(scopeKindForArchetype(null), null, 'null archetype → null');
  assert.equal(scopeKindForArchetype('nonsense'), null, 'unknown archetype → null');
});

test('classify: the golden scope_key is stable across vendor punctuation/casing', () => {
  // "Sonoran Properties LLC" normalises to the same canonical merchant.
  const out = classifyRent({ document: { vendor_name: 'SONORAN  PROPERTIES, LLC' } });
  assert.equal(out.scopeKey, GOLDEN_RENT_SCOPE_KEY, 'merchant normalisation is stable');
});

test('classify: a ledger account from category (not account_code) still resolves', () => {
  const out = classifyRent({ bankLine: { account_code: null, category: '6000' } });
  assert.equal(out.scopeKey, GOLDEN_RENT_SCOPE_KEY);
});

// ── fail-closed: the rent predicates ──────────────────────────────────
test('classify: no recurring evidence → null (an unestablished pattern is never pre-authorised)', () => {
  const out = classifyRent({ firmContext: { recentConfirmedMatches: [] } });
  assert.equal(out.archetype, null, 'spec §7 requires a real matched recurring bill');
});

test('classify: an uncoded line (no approved ledger account) → null', () => {
  const out = classifyRent({ bankLine: { account_code: null, category: null } });
  assert.equal(out.archetype, null, 'no approved ledger account → fail closed');
});

test('classify: money_in (AR) line → null (rent is never something we are paid)', () => {
  const out = classifyRent({ bankLine: { money_in: 900, money_out: 0 } });
  assert.equal(out.archetype, null);
});

test('classify: a non-bill document_type (e.g. receipt) → null', () => {
  const out = classifyRent({ document: { document_type: 'receipt' } });
  assert.equal(out.archetype, null);
});

test('classify: no rent/lease signal anywhere → null', () => {
  const out = classifyRent({
    document: { vendor_name: 'Globex Supplies', reference_number: 'INV-9', filename: 'globex.pdf' },
    bankLine: { description: 'GLOBEX SUPPLIES', raw_description: 'GLOBEX SUPPLIES', contact: 'Globex' },
    firmContext: recurringContext('Globex Supplies')
  });
  assert.equal(out.archetype, null, 'no rent keyword → not a rent archetype');
});

test('classify: excluded rent SUBTYPES fail closed even with a rent keyword', () => {
  for (const subtype of ['security deposit', 'CAM charge', 'repair', 'late fee', 'first month', 'property tax']) {
    const out = classifyRent({
      bankLine: { description: `RENT ${subtype} SONORAN`, raw_description: `RENT ${subtype}` }
    });
    assert.equal(out.archetype, null, `subtype "${subtype}" → fail closed`);
  }
});

test('classify: an excluded high-risk nature is never rescued by a rent keyword', () => {
  for (const marker of ['IRS', 'payroll', 'owner draw', 'shareholder loan', 'stripe payout']) {
    const out = classifyRent({
      bankLine: { description: `RENT ${marker}`, raw_description: `RENT ${marker} SONORAN` }
    });
    assert.equal(out.archetype, null, `nature "${marker}" → fail closed`);
  }
});

// ── fail-closed: the two excluded V1 archetypes ───────────────────────
test('classify: an internal-transfer shape is ALWAYS null in V1 (no same-entity proof)', () => {
  const out = classifyReconciliationArchetype({
    proposal: { bank_transaction_id: 'tx-x', confidence: 0.95, hops: [] },
    bankLine: rentLine({ description: 'INTERNAL TRANSFER TO OWN ACCOUNT', raw_description: 'BOOK TRANSFER SWEEP' }),
    document: rentDoc(),
    firmContext: recurringContext()
  });
  assert.equal(out.archetype, null, 'entity_id unavailable + multi-entity possible → exclude internal_transfer');
});

test('classify: a verified-card-payment shape is ALWAYS null in V1 (no verified card-liability link)', () => {
  const out = classifyReconciliationArchetype({
    proposal: { bank_transaction_id: 'tx-x', confidence: 0.95, hops: [] },
    bankLine: rentLine({ description: 'CREDIT CARD PAYMENT VISA', raw_description: 'CARD SETTLEMENT STATEMENT BALANCE' }),
    document: rentDoc(),
    firmContext: recurringContext()
  });
  assert.equal(out.archetype, null, 'pre-linked verified card-liability account is not in the V1 data surface');
});

// ── fail-closed: malformed / missing inputs ───────────────────────────
test('classify: missing bankLine or document → null without throwing', () => {
  assert.equal(classifyReconciliationArchetype({}).archetype, null);
  assert.equal(classifyReconciliationArchetype({ bankLine: rentLine() }).archetype, null);
  assert.equal(classifyReconciliationArchetype({ document: rentDoc() }).archetype, null);
  assert.equal(classifyReconciliationArchetype().archetype, null);
});

test('classify: the null verdict carries the documented fail-closed shape', () => {
  const out = classifyReconciliationArchetype({});
  assert.deepEqual(out, __test__.NO_ARCHETYPE, 'archetype null, scope null, firstUse false, evidence false');
});

// ── pure helpers (the classifier never re-scores; it only labels) ─────
test('helpers: isMoneyOut isolates the AP/expense direction', () => {
  assert.equal(__test__.isMoneyOut({ money_out: 10, money_in: 0 }), true);
  assert.equal(__test__.isMoneyOut({ money_out: 10, money_in: 5 }), false, 'a two-sided line is not a clean payment');
  assert.equal(__test__.isMoneyOut({ money_out: 0, money_in: 10 }), false);
});

test('helpers: recurring evidence matches on the canonical merchant, not raw text', () => {
  assert.equal(
    __test__.hasRecurringVendorEvidence('Sonoran Properties', {
      recentConfirmedMatches: [{ vendor_name: 'SONORAN PROPERTIES LLC' }]
    }),
    true
  );
  assert.equal(
    __test__.hasRecurringVendorEvidence('Sonoran Properties', { recentConfirmedMatches: [{ vendor_name: 'Acme' }] }),
    false
  );
  assert.equal(__test__.hasRecurringVendorEvidence('', { recentConfirmedMatches: [{ vendor_name: 'x' }] }), false);
});
