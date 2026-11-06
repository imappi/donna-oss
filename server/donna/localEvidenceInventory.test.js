import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assignExclusiveCitableEvidence,
  citableRefreshDue,
  localDocumentCandidate,
  localEvidenceCandidatesByTransaction,
  localEvidenceCandidateReceipt,
  citableEvidenceCandidates
} from './localEvidenceInventory.js';

const tx = (overrides = {}) => ({
  id: 'tx-1',
  transaction_date: '2025-01-07',
  description: 'SQ *KEEPMORE · 5982337100',
  money_in: 2935.04,
  money_out: 0,
  currency: 'USD',
  ...overrides
});

const doc = (overrides = {}) => ({
  id: 'doc-1',
  filename: 'deposit_square_keepmore_jan7_2025.pdf',
  document_type: 'unknown',
  parse_status: 'skipped',
  duplicate_of: null,
  total_amount: null,
  currency: null,
  live_match_transaction_ids: [],
  ...overrides
});

test('opaque skipped evidence is present when filename identity and date both agree', () => {
  const candidate = localDocumentCandidate(tx(), doc());
  assert.equal(candidate.id, 'doc-1');
  assert.equal(candidate.basis, 'counterparty_nearby_date');
  assert.equal(candidate.parse_status, 'skipped');
});

test('misrouted sales invoice is present on exact amount and nearby date regardless of direction label', () => {
  const candidate = localDocumentCandidate(
    tx({
      transaction_date: '2025-01-14',
      description: 'SYSCO CENTRAL TX',
      money_in: 0,
      money_out: 1083.73
    }),
    doc({
      filename: 'invoice_sysco_jan14_2025.pdf',
      document_type: 'sales_invoice',
      parse_status: 'completed',
      document_date: '2025-01-13',
      total_amount: 1083.73,
      vendor_name: null,
      customer_name: 'Cactus Blossom Café Corp'
    })
  );
  assert.equal(candidate.basis, 'exact_amount_nearby_date');
});

test('unrelated same-day file cannot suppress a client ask without identity or exact amount', () => {
  assert.equal(localDocumentCandidate(
    tx(),
    doc({ filename: 'payroll_gusto_jan7_2025.pdf' })
  ), null);
});

test('primary bank statements are never treated as supporting-document candidates', () => {
  assert.equal(localDocumentCandidate(
    tx(),
    doc({
      filename: 'Cactus_Blossom_Cafe_Statement_2025-01_Jan.pdf',
      document_type: 'bank_statement',
      parse_status: 'completed',
      document_date: '2025-01-01',
      total_amount: 2935.04
    })
  ), null);
});

test('document already live-matched to another line cannot suppress this line', () => {
  assert.equal(localDocumentCandidate(
    tx(),
    doc({ live_match_transaction_ids: ['tx-other'] })
  ), null);
});

test('Cactus-shaped skipped and misrouted evidence is inventoried per transaction', () => {
  const transactions = [
    tx(),
    tx({
      id: 'tx-gusto', transaction_date: '2025-01-15', description: 'GUSTO · 781151148',
      money_in: 0, money_out: 4302.09
    }),
    tx({
      id: 'tx-usfoods', transaction_date: '2025-01-17', description: 'US FOODS AUSTIN · 880739888271',
      money_in: 0, money_out: 216.57
    })
  ];
  const documents = [
    doc(),
    doc({ id: 'doc-gusto', filename: 'payroll_gusto_jan15_2025.pdf', document_type: 'payroll_cpf' }),
    doc({
      id: 'doc-usfoods', filename: 'invoice_usfoods_jan17_2025.pdf', document_type: 'sales_invoice',
      parse_status: 'completed', document_date: '2025-01-16', total_amount: 216.57
    })
  ];
  const found = localEvidenceCandidatesByTransaction({ transactions, documents });
  assert.deepEqual([...found.keys()], ['tx-1', 'tx-gusto', 'tx-usfoods']);
  assert.deepEqual(localEvidenceCandidateReceipt(found), {
    'tx-1': [{
      document_id: 'doc-1', filename: 'deposit_square_keepmore_jan7_2025.pdf',
      document_type: 'unknown', parse_status: 'skipped', document_date: null,
      total_amount: null, currency: null, basis: 'counterparty_nearby_date',
      day_distance: 0
    }],
    'tx-gusto': [{
      document_id: 'doc-gusto', filename: 'payroll_gusto_jan15_2025.pdf',
      document_type: 'payroll_cpf', parse_status: 'skipped', document_date: null,
      total_amount: null, currency: null, basis: 'counterparty_nearby_date',
      day_distance: 0
    }],
    'tx-usfoods': [{
      document_id: 'doc-usfoods', filename: 'invoice_usfoods_jan17_2025.pdf',
      document_type: 'sales_invoice', parse_status: 'completed', document_date: '2025-01-16',
      total_amount: 216.57, currency: null, basis: 'exact_amount_nearby_date',
      day_distance: 1
    }]
  });
});

test('a token shared by most documents carries no identity (the uae_ prefix storm)', () => {
  // Desert Rose, 2026-09-01: all fixture files began "uae_" and the bank line
  // said "OFFICE DEPOT UAE", so one charge collected eight absurd candidates.
  const documents = [
    'uae_alislami_invoice2_jan17.pdf', 'uae_clover_keepmore1_jan8.pdf',
    'uae_clover_keepmore2_jan25.pdf', 'uae_deliveroo_payout2_jan27.pdf',
    'uae_fta_vat_payment_jan15.pdf', 'uae_nbd_charges_jan25.pdf',
    'uae_nol_topup_jan10.pdf', 'uae_oman_insurance_jan14.pdf'
  ].map((filename, index) => doc({
    id: `doc-${index}`, filename, total_amount: null, parse_status: 'completed',
    document_date: `2025-01-${String(10 + index).padStart(2, '0')}`
  }));
  const map = localEvidenceCandidatesByTransaction({
    transactions: [tx({
      id: 'tx-office',
      transaction_date: '2025-01-21',
      description: 'OFFICE DEPOT UAE',
      money_in: 0,
      money_out: 340
    })],
    documents
  });
  assert.equal(map.get('tx-office'), undefined);
});

test('a real vendor token still identifies its document inside a prefixed batch', () => {
  const documents = [
    'uae_talabat_payout1_jan4.pdf', 'uae_clover_keepmore1_jan8.pdf',
    'uae_clover_keepmore2_jan25.pdf', 'uae_deliveroo_payout2_jan27.pdf',
    'uae_fta_vat_payment_jan15.pdf', 'uae_nbd_charges_jan25.pdf',
    'uae_nol_topup_jan10.pdf', 'uae_oman_insurance_jan14.pdf'
  ].map((filename, index) => doc({
    id: `doc-${index}`, filename, total_amount: null, parse_status: 'completed',
    document_date: index === 0 ? '2025-01-04' : `2025-01-${String(10 + index).padStart(2, '0')}`
  }));
  const map = localEvidenceCandidatesByTransaction({
    transactions: [tx({
      id: 'tx-talabat',
      transaction_date: '2025-01-04',
      description: 'TALABAT PAYOUT · T-884712',
      money_in: 4850,
      money_out: 0
    })],
    documents
  });
  const candidates = map.get('tx-talabat') || [];
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].filename, 'uae_talabat_payout1_jan4.pdf');
  assert.equal(candidates[0].basis, 'counterparty_nearby_date');
});

test('small document sets keep full identity — frequency cannot be established under eight docs', () => {
  const map = localEvidenceCandidatesByTransaction({
    transactions: [tx({ id: 'tx-1' })],
    documents: [doc()]
  });
  assert.equal((map.get('tx-1') || []).length, 1);
});

test('an amount-only candidate is never citable — direction-blind collisions must not be named', () => {
  // Desert Rose, 2026-09-01: a 1,450 Careem payout (money IN, 29 Jan) qualified
  // as evidence for a 1,450 Gulf Food supplier payment (money OUT, 22 Jan) —
  // magnitude() is direction-blind, so equal amounts collide inside ±31 days.
  const candidate = localDocumentCandidate(
    tx({ id: 'tx-gulf', transaction_date: '2026-01-22', description: 'GULF FOOD DISTRIBUTORS', money_in: 0, money_out: 1450 }),
    doc({ id: 'doc-careem', filename: 'uae_careem_pay_jan29.pdf', parse_status: 'completed', document_date: '2026-01-29', total_amount: 1450 })
  );
  assert.equal(candidate.basis, 'exact_amount_nearby_date', 'still a candidate for the send-hold guard');
  assert.deepEqual(citableEvidenceCandidates([candidate]), [], 'but never named to the owner');
});

test('among same-token siblings only the nearest-dated slip is citable', () => {
  // Three cash-deposit slips share the token "cash"; the 17 Jan line must cite
  // the 17 Jan slip, not the 30 Jan one it previously named.
  const documents = [
    { file: 'uae_cash_deposit_jan2.pdf', date: '2026-01-02' },
    { file: 'uae_cash_deposit2_jan17.pdf', date: '2026-01-17' },
    { file: 'uae_cash_deposit3_jan30.pdf', date: '2026-01-30' }
  ].map((d, index) => doc({
    id: `doc-${index}`, filename: d.file, parse_status: 'completed',
    document_date: d.date, total_amount: null
  }));
  const map = localEvidenceCandidatesByTransaction({
    transactions: [tx({
      id: 'tx-cash', transaction_date: '2026-01-17', description: 'CASH DEPOSIT',
      money_in: 2100, money_out: 0
    })],
    documents
  });
  const cited = citableEvidenceCandidates(map.get('tx-cash') || []);
  assert.equal(cited.length, 1);
  assert.equal(cited[0].filename, 'uae_cash_deposit2_jan17.pdf');
  assert.equal(cited[0].day_distance, 0);
});

test('a same-day identity match stays citable — the good asks must survive', () => {
  const candidate = localDocumentCandidate(
    tx({ id: 'tx-nol', transaction_date: '2026-01-10', description: 'NOL CARD TOPUP BULK', money_in: 0, money_out: 175 }),
    doc({ id: 'doc-nol', filename: 'uae_nol_topup_jan10.pdf', parse_status: 'completed', document_date: '2026-01-10', total_amount: null })
  );
  assert.equal(candidate.basis, 'counterparty_nearby_date');
  assert.equal(citableEvidenceCandidates([candidate])[0].filename, 'uae_nol_topup_jan10.pdf');
});

// ── The exclusive-citable assignment (third Desert Rose run, 2026-09-01) ──

test('one dated document shared by four settlements is citable only on the nearest line (the clover_std storm)', () => {
  // Live rows: uae_clover_std_jan15.pdf (no extracted date/amount — the
  // filename carries the date) was cited as the evidence for FOUR Clover
  // settlements. Only the 15 Jan one can be right.
  const cloverDoc = doc({
    id: 'doc-clover-std',
    filename: 'uae_clover_std_jan15.pdf',
    document_date: '2025-01-15', // the date-carrying lookalike — its siblings had none
    total_amount: null
  });
  const lines = [
    tx({ id: 'tx-clover-08', transaction_date: '2025-01-08', description: 'CLOVER SETTLEMENT', money_in: 1810.4 }),
    tx({ id: 'tx-clover-15', transaction_date: '2025-01-15', description: 'CLOVER SETTLEMENT', money_in: 2240.75 }),
    tx({ id: 'tx-clover-22', transaction_date: '2025-01-22', description: 'CLOVER SETTLEMENT', money_in: 1975.1 }),
    tx({ id: 'tx-clover-29', transaction_date: '2025-01-29', description: 'CLOVER SETTLEMENT', money_in: 2105.3 })
  ];
  const found = localEvidenceCandidatesByTransaction({ transactions: lines, documents: [cloverDoc] });
  // Every line within the 14-day window collects the doc as a candidate…
  assert.ok((found.get('tx-clover-15') || []).length === 1);
  assert.ok((found.get('tx-clover-22') || []).length === 1);
  // …but only the nearest line may CITE it.
  const assigned = assignExclusiveCitableEvidence(found);
  assert.deepEqual(
    [...assigned.entries()].map(([id, list]) => [id, list.map((c) => c.id)]),
    [
      ['tx-clover-08', []],
      ['tx-clover-15', ['doc-clover-std']],
      ['tx-clover-22', []],
      ['tx-clover-29', []]
    ]
  );
});

test('an amount-only collision is never citable (the careem_pay counter deposit)', () => {
  // Live rows: uae_careem_pay_jan29.pdf (money in) was named as the evidence
  // for the 22 Jan counter deposit purely on the equal amount.
  const careemDoc = doc({
    id: 'doc-careem',
    filename: 'uae_careem_pay_jan29.pdf',
    document_date: '2025-01-29',
    total_amount: 1450,
    parse_status: 'completed'
  });
  const counterDeposit = tx({
    id: 'tx-counter-22',
    transaction_date: '2025-01-22',
    description: 'COUNTER DEPOSIT',
    money_in: 1450
  });
  const found = localEvidenceCandidatesByTransaction({
    transactions: [counterDeposit],
    documents: [careemDoc]
  });
  const candidates = found.get('tx-counter-22') || [];
  assert.equal(candidates.length, 1, 'the hold/receipt inventory still sees it');
  assert.equal(candidates[0].basis, 'exact_amount_nearby_date');
  const assigned = assignExclusiveCitableEvidence(found);
  assert.deepEqual(assigned.get('tx-counter-22'), [], 'but nothing may be NAMED to the owner');
});

test('exclusive assignment is deterministic: dated beats undated, transaction id breaks a tie', () => {
  const shared = { id: 'doc-x', filename: 'x.pdf', basis: 'counterparty_nearby_date' };
  const assigned = assignExclusiveCitableEvidence(new Map([
    ['tx-b', [{ ...shared, day_distance: 3 }]],
    ['tx-a', [{ ...shared, day_distance: 3 }]],
    ['tx-undated', [{ ...shared, day_distance: null }]]
  ]));
  assert.deepEqual(assigned.get('tx-a').map((c) => c.id), ['doc-x'], 'tie → lexically smaller id');
  assert.deepEqual(assigned.get('tx-b'), []);
  assert.deepEqual(assigned.get('tx-undated'), []);
});

test('the receipt shape round-trips the assignment (draft and send derive the same winners)', () => {
  const found = localEvidenceCandidatesByTransaction({
    transactions: [
      tx({ id: 'tx-near', transaction_date: '2025-01-15', description: 'CLOVER SETTLEMENT', money_in: 100 }),
      tx({ id: 'tx-far', transaction_date: '2025-01-22', description: 'CLOVER SETTLEMENT', money_in: 200 })
    ],
    documents: [doc({
      id: 'doc-clover', filename: 'uae_clover_std_jan15.pdf',
      document_date: '2025-01-15', total_amount: null
    })]
  });
  const receipt = localEvidenceCandidateReceipt(found);
  const fromLive = assignExclusiveCitableEvidence(found);
  const fromReceipt = assignExclusiveCitableEvidence(receipt);
  const winners = (assigned) => [...assigned.entries()]
    .map(([id, list]) => [id, list.map((c) => String(c.id || c.document_id))])
    .sort(([a], [b]) => a.localeCompare(b));
  assert.deepEqual(winners(fromReceipt), winners(fromLive));
  assert.deepEqual(winners(fromLive), [['tx-far', []], ['tx-near', ['doc-clover']]]);
});

// ── citableRefreshDue — the stale-ask refresh once-guard (2026-09-01) ────────
// A supersedable sweep ask is re-fed to the drafter only when the CITABLE set
// genuinely changed since the ask last named it; anything weaker is the 9×
// re-send loop wearing refresh clothes.

test('citableRefreshDue: nothing citable now means no refresh, whatever was persisted', () => {
  assert.equal(citableRefreshDue({ persisted: [], candidates: [] }), false);
  // An amount-only coincidence is not citable and therefore never re-opens a
  // question — the same law that keeps it out of the wording (#1945).
  assert.equal(citableRefreshDue({
    persisted: [],
    candidates: [{ id: 'doc-x', basis: 'exact_amount_nearby_date', day_distance: 3 }]
  }), false);
  // A previously-named file disappearing is also not a refresh: naming
  // nothing instead of something is not a better basis.
  assert.equal(citableRefreshDue({
    persisted: [{ document_id: 'doc-x' }],
    candidates: []
  }), false);
});

test('citableRefreshDue: a citable candidate the ask never named is due', () => {
  assert.equal(citableRefreshDue({
    persisted: [],
    candidates: [{ id: 'doc-payout', basis: 'counterparty_nearby_date', day_distance: 0 }]
  }), true);
  assert.equal(citableRefreshDue({
    persisted: [{ document_id: 'doc-old' }],
    candidates: [{ id: 'doc-payout', basis: 'counterparty_nearby_date', day_distance: 0 }]
  }), true);
});

test('citableRefreshDue: an unchanged citable set stays quiet (exactly-once)', () => {
  assert.equal(citableRefreshDue({
    persisted: [{ document_id: 'doc-payout', filename: 'x.pdf' }],
    candidates: [{ id: 'doc-payout', basis: 'counterparty_nearby_date', day_distance: 0 }]
  }), false);
  // The comparison is id-set based: a parse-status change on the same file is
  // not worth re-prompting the owner.
  assert.equal(citableRefreshDue({
    persisted: [{ document_id: 'doc-payout' }],
    candidates: [{ id: 'doc-payout', basis: 'exact_amount_counterparty', parse_status: 'completed', day_distance: 1 }]
  }), false);
});
