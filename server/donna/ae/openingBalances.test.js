import assert from 'node:assert/strict';
import test from 'node:test';
import { aeOpeningFils, normalizeAeOpeningTrialBalance, assertAeOpeningIdentity } from './openingBalances.js';
const chart=[{id:'bank',code:'B',name:'Bank',account_type:'bank',normal_balance:'debit',canonical_role:'asset.cash',currency:'AED',status:'active'},
  {id:'equity',code:'E',name:'Capital',account_type:'equity',normal_balance:'credit',canonical_role:'equity.share_capital',currency:'AED',status:'active'}];
const intake={as_of:'2026-01-01',source_as_of:'2025-12-31',complete:true,currency:'AED',declared_lines:[{account_id:'bank',debit:'100.25'},{account_id:'equity',credit:'100.25'}]};
const args={intake,chart,period:{starts_on:'2026-01-01'},clientRow:{jurisdiction:'ae',entity_type:'ae-llc',incorporation_date:'2020-01-01',profile:{currency:'AED',accounting_system:'none'}}};
test('AED full TB uses exact fils and persisted canonical account classes',()=>{
  assert.equal(aeOpeningFils('100.25'),10025);
  const result=normalizeAeOpeningTrialBalance(args);
  assert.equal(result.proposal.totals.assets,100.25);assert.equal(result.proposal.totals.equity,100.25);
  for(const value of ['',null,'NaN','1e3','-1','0.001','Infinity'])assert.throws(()=>aeOpeningFils(value),{code:'AE_OPENING_AMOUNT_INVALID'});
});
test('missing completeness remains on owner; invalid accounting refuses',()=>{
  assert.equal(normalizeAeOpeningTrialBalance({...args,intake:{...intake,complete:false}}).terminal,'owner_ask');
  assert.throws(()=>normalizeAeOpeningTrialBalance({...args,intake:{...intake,currency:null}}),{code:'AE_OPENING_CURRENCY_REQUIRED'});
  assert.throws(()=>normalizeAeOpeningTrialBalance({...args,intake:{...intake,declared_lines:[intake.declared_lines[0]]}}),{code:'AE_OPENING_UNBALANCED'});
  assert.throws(()=>normalizeAeOpeningTrialBalance({...args,intake:{...intake,declared_lines:[...intake.declared_lines,intake.declared_lines[0]]}}),{code:'AE_OPENING_ACCOUNT_DUPLICATE'});
  assert.throws(()=>normalizeAeOpeningTrialBalance({...args,intake:{...intake,source_as_of:'2025-02-30'}}),{code:'AE_OPENING_DATE_REQUIRED'});
  assert.throws(()=>normalizeAeOpeningTrialBalance({...args,chart:[chart[0],{...chart[1],canonical_role:'liability.tax_payable',account_type:'liability'}]}),{code:'AE_OPENING_CARRY_IN_UNSUPPORTED'});
});

test('opening consumes the shared authoritative currency, view and method contract',()=>{
  for(const key of ['currency','accountingCurrency','baseCurrency','defaultCurrency','default_currency'])
    assert.doesNotThrow(()=>assertAeOpeningIdentity({...args.clientRow,profile:{accounting_system:'none',[key]:'AED'}}));
  for(const method of ['cash','accrual'])assert.doesNotThrow(()=>assertAeOpeningIdentity({...args.clientRow,profile:{...args.clientRow.profile,accounting_view:'management_books',accountingBasis:method}}));
  for(const profile of [{currency:'USD',accounting_currency:'AED'},{currency:'AED',default_currency:'USD'},{currency:null},{accounting_currency:'AED'}])
    assert.throws(()=>assertAeOpeningIdentity({...args.clientRow,profile:{accounting_system:'none',...profile}}),{code:'AE_OPENING_CURRENCY_REQUIRED'});
  for(const profile of [{accounting_view:'statutory_books'},{accounting_view:null},{accountingBasis:'cash',accounting_basis:'accrual'},{accountingBasis:null}])
    assert.throws(()=>assertAeOpeningIdentity({...args.clientRow,profile:{...args.clientRow.profile,...profile}}),{code:'AE_OPENING_BOOK_UNSUPPORTED'});
});
