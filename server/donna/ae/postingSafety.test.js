import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePostingPolicy } from '../postingPolicy.js';
import { buildLedgerJournalForTransaction } from '../ledger.js';
import { AE_VAT_CODES } from './vatCodes.js';
import { aeNativeStandardSplit } from './nativeVatPosting.js';

const policy = resolvePostingPolicy({ jurisdiction: 'ae' });
const adapter = policy.adapter;
const bankAccount = { code: 'BANK', name: 'AED bank' };
const sale = { id: 'ae-sale', date: '2026-09-09', currency: 'AED', money_in: 105 };
const purchase = { id: 'ae-purchase', date: '2026-09-09', currency: 'AED', money_out: 105 };
const revenue = { account_code: 'SALES', account_name: 'Sales', account_type: 'revenue' };
const expense = { account_code: 'EXPENSE', account_name: 'Operating expenses', account_type: 'expense' };
const liability = { account_code: 'LOAN', account_name: 'Loan payable', account_type: 'liability' };
const input = (coding, transaction = sale, taxCodingEnabled = true) => ({ coding, transaction, taxCodingEnabled });
const guarded = (coding, transaction = sale, taxCodingEnabled = true) => {
  const enriched = adapter.enrichCoding(input(coding, transaction, taxCodingEnabled));
  return adapter.assertPostableTaxCoding(input(enriched, transaction, taxCodingEnabled));
};
const refusal = (code) => (error) => error.code === code && error.statusCode === 409;

test('AE capabilities declare native standard splitting while invoice/AP operations remain unsupported', () => {
  assert.equal(policy.postingTaxCodingFlagKey, 'JURISDICTION_TAX_CODING');
  assert.equal(policy.capabilities.assertPostableTaxCoding, true);
  assert.equal(policy.capabilities.transactionSplit, true);
  for (const operation of ['salesInvoiceTaxPosting', 'supplierBillTaxPosting']) {
    assert.equal(policy.capabilities[operation], false);
    assert.throws(() => adapter[operation](input({ ...revenue, tax_type: 'AE_VAT_SR_5_OUTPUT' })),
      refusal('posting_operation_unsupported'));
  }
  const ownership = policy.nativeTaxCodeOwnership.find(({ jurisdiction }) => jurisdiction === 'ae');
  assert.deepEqual(ownership.prefixes, ['AE_VAT_']);
  assert.deepEqual(ownership.codes, AE_VAT_CODES.map(({ code }) => code));
});

test('AE enrichment maps only the existing vocabulary and respects cash direction', () => {
  const treatments = [
    ['VAT 5% (standard rated)', 'SR_5'],
    ['Zero-rated supply', 'ZR'],
    ['Exempt supply', 'EXEMPT'],
    ['Out of scope of UAE VAT', 'OUTSIDE_SCOPE']
  ];
  for (const [transaction, base, direction] of [[sale, revenue, 'OUTPUT'], [purchase, expense, 'INPUT']]) {
    for (const [tax_treatment, suffix] of treatments) {
      const original = { ...base, tax_treatment };
      const snapshot = structuredClone(original);
      const coding = adapter.enrichCoding(input(original, transaction));
      assert.equal(coding.tax_type, `AE_VAT_${suffix}_${direction}`, tax_treatment);
      assert.equal(coding.xero_tax_type, `AE_VAT_${suffix}_${direction}`, tax_treatment);
      assert.deepEqual(original, snapshot, 'enrichment must not mutate authoritative coding');
    }
  }
  const rcm = adapter.enrichCoding(input({ ...expense, tax_treatment: 'Reverse charge (RCM)' }, purchase));
  assert.equal(rcm.tax_type, 'AE_VAT_RCM_5_INPUT');
});

test('unknown treatment and the coder unsure marker cannot finish a relevant AE P&L leg with either flag state', () => {
  for (const [base, transaction] of [[revenue, sale], [expense, purchase]]) {
    for (const taxCodingEnabled of [true, false]) {
      for (const coding of [base, { ...base, tax_type: 'NONE' }, { ...base, xero_tax_type: 'NONE' },
        ...[undefined, '', 'UAE VAT check', 'VAT 5%', 'GST 9%', 'probably exempt'].map(tax_treatment => ({ ...base, tax_treatment }))]) {
        assert.throws(() => guarded(coding, transaction, taxCodingEnabled),
          refusal('TRANSACTION_AE_VAT_TREATMENT_UNRESOLVED'));
        assert.throws(() => adapter.assertPostableTaxCoding(input(coding, transaction, taxCodingEnabled)),
          refusal('TRANSACTION_AE_VAT_TREATMENT_UNRESOLVED'), 'direct commit cannot bypass the unconditional safety rule');
      }
    }
  }
});

test('an absent chart account or unknown account class cannot exempt unresolved VAT in either flag state', () => {
  for (const taxCodingEnabled of [true, false]) {
    for (const transaction of [sale, purchase]) {
      for (const account of [
        { account_name: 'Unmapped fixture activity' },
        { proposed_account: 'Unmapped fixture activity', account_code: '' },
        { account_code: 'UNMAPPED', account_type: 'unknown' },
        { account_name: 'Unmapped fixture activity', xero_account_type: 'OTHER' }
      ]) {
        for (const sourceCoding of [{}, { tax_treatment: 'UAE VAT check' }, { tax_treatment: 'unrecognised treatment' }]) {
          const coding = { ...account, ...sourceCoding };
          assert.throws(() => guarded(coding, transaction, taxCodingEnabled),
            refusal('TRANSACTION_AE_VAT_TREATMENT_UNRESOLVED'));
          assert.throws(() => adapter.assertPostableTaxCoding({ ...input(coding, transaction, taxCodingEnabled), sourceCoding }),
            refusal('TRANSACTION_AE_VAT_TREATMENT_UNRESOLVED'), 'the commit guard also requires positive evidence of a non-tax account class');
        }
      }
    }
  }
});

test('name-only accounts with exact safe VAT semantics retain the existing journal minting path', () => {
  for (const taxCodingEnabled of [true, false]) {
    for (const [transaction, direction] of [[sale, 'OUTPUT'], [purchase, 'INPUT']]) {
      for (const [tax_treatment, suffix] of [['Exempt supply', 'EXEMPT'], ['Out of scope of UAE VAT', 'OUTSIDE_SCOPE']]) {
        const coding = guarded({ account_name: 'Unmapped fixture activity', tax_treatment }, transaction, taxCodingEnabled);
        assert.equal(coding.tax_type, `AE_VAT_${suffix}_${direction}`);
        const journal = buildLedgerJournalForTransaction({ transaction, coding, bankAccount });
        assert.equal(journal.lines.length, 2);
        assert.equal(journal.lines.find(line => line.account.role === 'counterparty').account.name, 'Unmapped fixture activity');
        assert.equal(journal.lines.reduce((sum, line) => sum + line.debit, 0), 105);
        assert.equal(journal.lines.reduce((sum, line) => sum + line.credit, 0), 105);
      }
    }
    for (const account_type of ['asset', 'liability', 'equity', 'bank']) {
      const coding = { account_name: 'Known non-tax account', account_type };
      assert.deepEqual(guarded(coding, purchase, taxCodingEnabled), coding,
        'positively typed non-tax accounts remain unaffected');
    }
  }
});

test('standard VAT and reverse charge refuse the unsupported posting even when their labels map', () => {
  for (const [base, transaction, tax_treatment, code] of [
    [revenue, sale, 'VAT 5% (standard rated)', 'AE_VAT_SR_5_OUTPUT'],
    [expense, purchase, 'VAT 5% (standard rated)', 'AE_VAT_SR_5_INPUT'],
    [expense, purchase, 'Reverse charge (RCM)', 'AE_VAT_RCM_5_INPUT']
  ]) {
    assert.throws(() => guarded({ ...base, tax_treatment }, transaction),
      refusal('TRANSACTION_AE_VAT_POSTING_UNSUPPORTED'));
    assert.throws(() => adapter.assertPostableTaxCoding(input({ ...base, tax_treatment }, transaction)),
      refusal('TRANSACTION_AE_VAT_POSTING_UNSUPPORTED'), 'the guard must also be safe without prior enrichment');
    for (const taxCodingEnabled of [true, false]) {
      assert.throws(() => guarded({ ...base, tax_type: code }, transaction, taxCodingEnabled),
        refusal('TRANSACTION_AE_VAT_POSTING_UNSUPPORTED'), 'explicit taxable codes must never post gross');
    }
  }
});

test('resolved non-tax treatments preserve balanced gross journals and return-visible native codes', () => {
  for (const [base, transaction, direction] of [[revenue, sale, 'OUTPUT'], [expense, purchase, 'INPUT']]) {
    for (const [tax_treatment, suffix] of [
      ['Zero-rated supply', 'ZR'], ['Exempt supply', 'EXEMPT'], ['Out of scope of UAE VAT', 'OUTSIDE_SCOPE']
    ]) {
      const coding = guarded({ ...base, tax_treatment }, transaction);
      const journal = buildLedgerJournalForTransaction({ transaction, coding, bankAccount });
      assert.equal(journal.amount, 105);
      assert.equal(journal.lines.length, 2);
      assert.equal(journal.lines.find(({ account }) => account.role === 'counterparty').account.tax_type,
        `AE_VAT_${suffix}_${direction}`);
      assert.equal(journal.lines.reduce((sum, line) => sum + line.debit, 0), 105);
      assert.equal(journal.lines.reduce((sum, line) => sum + line.credit, 0), 105);
    }
  }
  const blocked = guarded({ ...expense, tax_type: 'AE_VAT_BLOCKED_INPUT' }, purchase);
  const journal = buildLedgerJournalForTransaction({ transaction: purchase, coding: blocked, bankAccount });
  assert.equal(journal.lines.length, 2, 'blocked VAT stays in the expense with no recovery leg');
  assert.equal(journal.lines.find(({ account }) => account.role === 'counterparty').debit, 105);
});

test('genuinely non-tax balance-sheet behavior remains intact while explicit taxable coding still refuses', () => {
  for (const coding of [liability, { ...liability, tax_type: 'NONE' }]) {
    const accepted = guarded(coding, purchase);
    assert.deepEqual(accepted, coding);
    assert.equal(buildLedgerJournalForTransaction({ transaction: purchase, coding: accepted, bankAccount }).lines.length, 2);
  }
  assert.throws(() => guarded({ ...liability, tax_type: 'AE_VAT_SR_5_INPUT' }, purchase),
    refusal('TRANSACTION_AE_VAT_POSTING_UNSUPPORTED'));
  for (const tax_treatment of ['UAE VAT check', ' UAE VAT check ']) {
    assert.throws(() => guarded({ ...revenue, tax_treatment }, sale, false),
      refusal('TRANSACTION_AE_VAT_TREATMENT_UNRESOLVED'), 'explicit VAT uncertainty cannot be bypassed by disabling the flag');
  }
  for (const [base, transaction, tax_type] of [
    [revenue, sale, 'AE_VAT_SR_5_OUTPUT'], [expense, purchase, 'AE_VAT_RCM_5_INPUT']
  ]) {
    assert.throws(() => guarded({ ...base, tax_type, tax_treatment: 'UAE VAT check' }, transaction, false),
      error => error.statusCode === 409 && ['TRANSACTION_AE_VAT_TREATMENT_UNRESOLVED', 'TRANSACTION_AE_VAT_POSTING_UNSUPPORTED'].includes(error.code),
      'a native taxable code plus uncertainty cannot post gross');
  }
});

test('direction mismatches and contradictory native code homes cannot become apparently valid treatments', () => {
  for (const [coding, transaction] of [
    [{ ...revenue, tax_type: 'AE_VAT_ZR_INPUT' }, sale],
    [{ ...expense, xero_tax_type: 'AE_VAT_EXEMPT_OUTPUT' }, purchase],
    [{ ...revenue, tax_treatment: 'Reverse charge (RCM)' }, sale]
  ]) {
    assert.throws(() => guarded(coding, transaction), refusal('TRANSACTION_AE_VAT_DIRECTION_MISMATCH'));
  }
  for (const coding of [
    { ...revenue, tax_type: 'AE_VAT_ZR_OUTPUT', tax_treatment: 'Exempt supply' },
    { ...revenue, tax_type: 'AE_VAT_ZR_OUTPUT', xero_tax_type: 'AE_VAT_EXEMPT_OUTPUT' }
  ]) {
    assert.throws(() => guarded(coding), refusal('TRANSACTION_AE_VAT_CODING_CONFLICT'));
    assert.throws(() => adapter.assertPostableTaxCoding(input(coding)), refusal('TRANSACTION_AE_VAT_CODING_CONFLICT'));
  }
});

test('an authoritative native code survives an opaque connector tax id without hiding native conflicts', () => {
  for (const taxCodingEnabled of [true, false]) {
    for (const xero_tax_type of ['NONE', 'CUSTOM_EXEMPT_RATE']) {
      const sourceCoding = { tax_type: 'AE_VAT_EXEMPT_OUTPUT', xero_tax_type };
      const request = { ...input({ ...revenue, ...sourceCoding }, sale, taxCodingEnabled), sourceCoding };
      const coding = adapter.enrichCoding(request);
      assert.equal(coding.tax_type, 'AE_VAT_EXEMPT_OUTPUT');
      assert.equal(coding.xero_tax_type, 'AE_VAT_EXEMPT_OUTPUT');
      assert.deepEqual(adapter.assertPostableTaxCoding({ ...request, coding }), coding);
    }
    const request = { ...input(revenue, sale, taxCodingEnabled),
      sourceCoding: { tax_type: 'AE_VAT_EXEMPT_OUTPUT', xero_tax_type: 'VAT_SR_20_OUTPUT' } };
    assert.throws(() => adapter.enrichCoding(request), refusal('posting_tax_code_foreign'),
      'source validation must reject a foreign native code before AE filters transport ids');
    assert.throws(() => adapter.enrichCoding({ ...request,
      sourceCoding: { tax_type: 'AE_VAT_EXEMPT_OUTPUT', xero_tax_type: 'AE_VAT_ZR_OUTPUT' } }),
    refusal('TRANSACTION_AE_VAT_CODING_CONFLICT'));
  }
});

test('all six countries enforce native AE ownership without weakening existing country codes', () => {
  for (const jurisdiction of ['fi', 'gb', 'sg', 'ae', 'us', 'au']) {
    const selected = resolvePostingPolicy({ jurisdiction });
    const foreignCodes = jurisdiction === 'ae' ? ['ALV_25_5_OUTPUT', 'VAT_SR_20_OUTPUT'] : ['AE_VAT_ZR_OUTPUT'];
    for (const code of foreignCodes) {
      for (const field of ['tax_type', 'xero_tax_type']) {
        for (const operation of ['enrichCoding', 'assertPostableTaxCoding', 'transactionSplit']) {
          if (!selected.capabilities[operation]) continue;
          assert.throws(() => selected.adapter[operation](input({ ...revenue, [field]: code }, sale, false)),
            refusal('posting_tax_code_foreign'), `${jurisdiction}/${operation}/${field}`);
        }
      }
    }
  }
  for (const field of ['tax_type', 'xero_tax_type']) {
    assert.throws(() => adapter.enrichCoding(input({ ...revenue, [field]: 'AE_VAT_INVENTED_OUTPUT' })),
      refusal('posting_tax_code_invalid'));
  }
});

test('persisted source treatment governs enrichment; a stale chart default cannot resolve an unsure verdict', () => {
  for (const sourceCoding of [{}, { tax_treatment: 'UAE VAT check' }]) {
    const request = { ...input({ ...revenue, tax_type: 'AE_VAT_ZR_OUTPUT', tax_treatment: 'Zero-rated supply' }), sourceCoding };
    const coding = adapter.enrichCoding(request);
    assert.equal(coding.tax_type || '', '');
    assert.equal(coding.xero_tax_type || '', '');
    assert.throws(() => adapter.assertPostableTaxCoding({ ...request, coding }),
      refusal('TRANSACTION_AE_VAT_TREATMENT_UNRESOLVED'));
  }
  const taxableRequest = {
    ...input({ ...revenue, tax_type: 'AE_VAT_OUTSIDE_SCOPE_OUTPUT', tax_treatment: 'Out of scope of UAE VAT' }),
    sourceCoding: { tax_treatment: 'VAT 5% (standard rated)' }
  };
  const taxableCoding = adapter.enrichCoding(taxableRequest);
  assert.equal(taxableCoding.tax_type, 'AE_VAT_SR_5_OUTPUT');
  assert.throws(() => adapter.assertPostableTaxCoding({ ...taxableRequest, coding: taxableCoding }),
    refusal('TRANSACTION_AE_VAT_POSTING_UNSUPPORTED'));
  const correctedRequest = {
    ...input({ ...revenue, tax_type: 'AE_VAT_SR_5_OUTPUT', tax_treatment: 'VAT 5% (standard rated)' }),
    sourceCoding: { tax_treatment: 'Out of scope of UAE VAT' }
  };
  const correctedCoding = adapter.enrichCoding(correctedRequest);
  assert.equal(correctedCoding.tax_type, 'AE_VAT_OUTSIDE_SCOPE_OUTPUT');
  assert.deepEqual(adapter.assertPostableTaxCoding({ ...correctedRequest, coding: correctedCoding }), correctedCoding);
  assert.throws(() => adapter.assertPostableTaxCoding(correctedRequest),
    refusal('TRANSACTION_AE_VAT_CODING_CONFLICT'), 'commit cannot reuse prepared tax coding that disagrees with the current source');
});

test('disabled tax coding cannot retain a taxable effective code even when the source coding is absent or non-tax', () => {
  for (const [transaction, base, nativeCode] of [
    [sale, revenue, 'AE_VAT_SR_5_OUTPUT'],
    [purchase, expense, 'AE_VAT_SR_5_INPUT'],
    [purchase, expense, 'AE_VAT_RCM_5_INPUT']
  ]) {
    for (const sourceCoding of [{}, { tax_treatment: 'Out of scope of UAE VAT' }]) {
      const expectedCode = sourceCoding.tax_treatment ? 'TRANSACTION_AE_VAT_CODING_CONFLICT' : 'TRANSACTION_AE_VAT_POSTING_UNSUPPORTED';
      for (const field of ['tax_type', 'xero_tax_type']) {
        const request = { ...input({ ...base, [field]: nativeCode }, transaction, false), sourceCoding };
        const enriched = adapter.enrichCoding(request);
        if (sourceCoding.tax_treatment) {
          const expectedNative = transaction === sale ? 'AE_VAT_OUTSIDE_SCOPE_OUTPUT' : 'AE_VAT_OUTSIDE_SCOPE_INPUT';
          assert.equal(enriched.tax_type, expectedNative);
          assert.equal(enriched.xero_tax_type, expectedNative);
          assert.deepEqual(adapter.assertPostableTaxCoding({ ...request, coding: enriched }), enriched);
        } else {
          assert.throws(() => adapter.assertPostableTaxCoding({ ...request, coding: enriched }),
            refusal('TRANSACTION_AE_VAT_TREATMENT_UNRESOLVED'), `${nativeCode}/${field}`);
        }
        assert.throws(() => adapter.assertPostableTaxCoding(request),
          refusal(expectedCode), 'the lower commit guard must independently refuse the effective tax code');
      }
    }
  }
});

test('disabled tax coding cannot replace source non-tax semantics with an inherited native chart code', () => {
  for (const [transaction, base, direction] of [[sale, revenue, 'OUTPUT'], [purchase, expense, 'INPUT']]) {
    for (const suffix of ['ZR', 'EXEMPT']) {
      const nativeCode = `AE_VAT_${suffix}_${direction}`;
      for (const field of ['tax_type', 'xero_tax_type']) {
        const coding = { ...base, [field]: nativeCode };
        for (const [sourceCoding, expectedCode] of [
          [{}, 'TRANSACTION_AE_VAT_TREATMENT_UNRESOLVED'],
          [{ tax_treatment: 'Out of scope of UAE VAT' }, 'TRANSACTION_AE_VAT_CODING_CONFLICT']
        ]) {
          const request = { ...input(coding, transaction, false), sourceCoding };
          const enriched = adapter.enrichCoding(request);
          if (sourceCoding.tax_treatment) {
            assert.equal(enriched.tax_type, `AE_VAT_OUTSIDE_SCOPE_${direction}`);
            assert.equal(enriched.xero_tax_type, `AE_VAT_OUTSIDE_SCOPE_${direction}`);
            assert.deepEqual(adapter.assertPostableTaxCoding({ ...request, coding: enriched }), enriched);
          } else {
            assert.throws(() => adapter.assertPostableTaxCoding({ ...request, coding: enriched }),
              refusal(expectedCode), `${nativeCode}/${field}`);
          }
          assert.throws(() => adapter.assertPostableTaxCoding(request), refusal(expectedCode));
        }
      }
    }
  }
});

test('exact no-split AE treatments and native codes remain postable and stamped with the flag disabled', () => {
  for (const [transaction, base, direction] of [[sale, revenue, 'OUTPUT'], [purchase, expense, 'INPUT']]) {
    for (const [tax_treatment, suffix] of [
      ['Zero-rated supply', 'ZR'], ['Exempt supply', 'EXEMPT'], ['Out of scope of UAE VAT', 'OUTSIDE_SCOPE']
    ]) {
      const code = `AE_VAT_${suffix}_${direction}`;
      for (const source of [{ tax_treatment }, { tax_type: code }, { xero_tax_type: code }]) {
        const coding = guarded({ ...base, ...source }, transaction, false);
        assert.equal(coding.tax_type, code);
        assert.equal(coding.xero_tax_type, code);
        const journal = buildLedgerJournalForTransaction({ transaction, coding, bankAccount });
        assert.equal(journal.lines.length, 2);
        assert.equal(journal.lines.find(({ account }) => account.role === 'counterparty').account.tax_type, code);
        assert.equal(journal.lines.reduce((sum, line) => sum + line.debit, 0), 105);
        assert.equal(journal.lines.reduce((sum, line) => sum + line.credit, 0), 105);
      }
    }
  }
  const blocked = guarded({ ...expense, tax_type: 'AE_VAT_BLOCKED_INPUT' }, purchase, false);
  assert.equal(blocked.xero_tax_type, 'AE_VAT_BLOCKED_INPUT');
  assert.equal(buildLedgerJournalForTransaction({ transaction: purchase, coding: blocked, bankAccount }).lines.length, 2);
});


test('a stale standard split cannot survive nonstandard enrichment or reach any no-tax journal',()=>{
  for(const [tax_treatment,tax_type] of [['Exempt supply','AE_VAT_EXEMPT_OUTPUT'],['Zero-rated supply','AE_VAT_ZR_OUTPUT'],['Out of scope of UAE VAT','AE_VAT_OUTSIDE_SCOPE_OUTPUT']]){
    const coding={...revenue,tax_treatment,tax_type,ae_vat_split:{net:100,vat:5,role:'vat_output'}};
    assert.throws(()=>adapter.assertPostableTaxCoding(input(coding)),refusal('TRANSACTION_AE_VAT_FACTS_STALE'));
    assert.equal(adapter.transactionSplit(input(coding)),null);
    const enriched=adapter.enrichCoding(input(coding));assert.equal(enriched.ae_vat_split,undefined);
    assert.equal(adapter.transactionSplit(input(enriched)),null);
  }
});

test('native tax facts require exact existing ISO calendar days, independently of the host zone',()=>{
  const splitFor = value => aeNativeStandardSplit({
    entry: { direction:'out' }, coding:revenue, transaction:{...sale,date:value}, taxCodingEnabled:true,
    taxPostingContext: {
      authority:true, evidenceCurrent:true,
      profile:{accounting_system:'none',accounting_view:'management_books',accountingBasis:'cash',
        vat_registration:{status:'registered',registered_from:'2026-01-01',vat_registration_number:'100123456789012'}},
      evidence:{currency:'AED',document_type:'sales_invoice',parse_status:'completed',total_amount:105,tax_amount:5},
      ledgerAccounts:[
        {code:'SALES',name:'Sales',type:'revenue',status:'active',currency:'AED'},
        {code:'VAT',name:'VAT control',type:'liability',status:'active',currency:'AED',normal_balance:'credit',canonical_role:'liability.sales_tax_payable'}
      ],
      facts:{version:1,actor_id:'fixture-member',authority_basis:'transaction_review_correction',
        document_id:'fixture-invoice',evidence_digest:'fixture-digest',direction:'out',
        date_of_supply:value,reporting_date:value,supply_class:'ordinary_domestic',payment_method:'bank_transfer',
        invoice_validity:'confirmed',fully_paid:true,taxable_amount:'100.00',vat_amount:'5.00'}
    }
  });
  for(const value of ['2026-09-09','2028-02-29']) {
    const split=splitFor(value);
    assert.equal(split.tax_point.date_of_supply,value);
    assert.equal(split.vat,5);
  }
  // Both fact dates and the source use the same malformed value: equality
  // alone must not let the string fast path accept a non-existent day.
  for(const value of ['2026-02-29','2026-02-30','2026-04-31','2026-00-10','2026-13-01','2026-09-00',
    '2026-09-31','2026-9-09','2026-09-09T00:00:00Z',' 2026-09-09 ',null,new Date('2026-09-09T00:00:00Z')]) {
    assert.throws(()=>splitFor(value),refusal('TRANSACTION_AE_VAT_TAX_POINT_UNSUPPORTED'));
  }
});
