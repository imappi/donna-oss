import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveClosePolicy } from './closePolicyRegistry.js';
import { resolvePostingAdmission } from './postingAdmissionRegistry.js';
import { resolveClientLifecycleAxis } from './clientLifecycleRegistry.js';
import { resolveProvisioningCertificateChart } from './provisioningPolicyRegistry.js';
import { evaluateCodingAutoPost } from './codingAutoPost.js';
import { lifecycleJurisdiction } from './countryLifecycleContext.js';
import { deriveRequiredRolesForClient } from './canonicalRoleResolutionDb.js';
import { resolveGbVatRegistrationOnDate } from './gb/vatRegistration.js';

test('missing, cleared and conflicting current identity never selects a lifecycle implementation', () => {
  for (const row of [{}, { jurisdiction:null,profile:{jurisdiction:'fi'} },
    { jurisdiction:'FI',profile:{jurisdiction:'gb'} },
    { jurisdiction:'FI',entity_type:'gb-ltd' },
    { jurisdiction:'FI',entity_type:'fi-oy',profile:{entityType:'fi-toiminimi'} }]) {
    assert.equal(lifecycleJurisdiction(row),null);
    assert.equal(resolveClosePolicy(row),null);
    assert.equal(resolvePostingAdmission(row),null);
    assert.equal(resolveClientLifecycleAxis(row),null);
  }
  assert.equal(resolveClosePolicy({jurisdiction:'zz'}),null);
});

test('only the explicit FI admission can demote a reverse-charge coding',()=>{
  const suggestion={proposed_account:'Fixture expense',confidence:'high',evidence_required:false,xero_account_type:'EXPENSE',tax_type:'ALV_REVERSE_CHARGE_PURCHASE'};
  for(const jurisdiction of ['fi','gb','sg','ae','us','au',null,'zz']) {
    const verdict=evaluateCodingAutoPost({jurisdiction,suggestion,scopeDriftPostingGateActs:true});
    assert.equal(verdict.action,jurisdiction==='fi'?'owner_ask':'auto_post');
  }
});

test('dated GB role requirements retain the original tri-state and date refusal',()=>{
  for(const registration of [null,{status:'not_registered'},{status:'registered',registered_from:'2026-06-01',vat_registration_number:'123456789'}]) {
    for(const onDate of ['2026-05-31','2026-06-01']) {
      const registered=resolveGbVatRegistrationOnDate({registration,onDate}).registered;
      const result=deriveRequiredRolesForClient({jurisdiction:'gb',profile:{vat_registration:registration},onDate});
      assert.equal(result.evidence.gb_vat_registered,registered);
      assert.deepEqual(result.roles,registered===true?['liability.sales_tax_payable']:[]);
    }
  }
  assert.throws(()=>deriveRequiredRolesForClient({jurisdiction:'gb'}));
});

test('additional lifecycle and certificate contracts register without shared algorithm changes',()=>{
  const fixture={resolveFiscalYear:()=>({label:'fixture',starts_on:'2026-02-01',ends_on:'2027-01-31'})};
  assert.equal(resolveClosePolicy({jurisdiction:'nz'},{nz:fixture}),fixture);
  assert.equal(resolveClientLifecycleAxis({jurisdiction:'nz'},{nz:{entityAxis:()=> 'fixture-axis'}}),'fixture-axis');
  const chart=Object.freeze([{code:'F1'}]);
  assert.equal(resolveProvisioningCertificateChart('fixture.v1',{nz:{certificateCharts:{'fixture.v1':chart}}}),chart);
  assert.throws(()=>resolveProvisioningCertificateChart('fixture.v1',{nz:{certificateCharts:{'fixture.v1':chart}},zz:{certificateCharts:{'fixture.v1':chart}}}),/Ambiguous/);
});

test('US gross-only books: a would-be auto-post of collected sales tax asks the owner for the sales record; nothing else moves (2026-10-01)',()=>{
  const sale={proposed_account:'Sales',confidence:'high',evidence_required:false,xero_account_type:'REVENUE',tax_treatment:'Sales tax collected'};
  for(const jurisdiction of ['us','fi','gb','sg','ae',null]) {
    const verdict=evaluateCodingAutoPost({jurisdiction,suggestion:sale});
    if(jurisdiction==='us') assert.deepEqual(verdict,{action:'owner_ask',reason:'revenue_source_required',blockers:['us_sales_tax_collected_gross_only']});
    else assert.equal(verdict.action,'auto_post',String(jurisdiction));
  }
  for(const tax_treatment of ['No sales tax','Out of scope',undefined]) {
    assert.equal(evaluateCodingAutoPost({jurisdiction:'us',suggestion:{...sale,tax_treatment}}).action,'auto_post',String(tax_treatment));
  }
  // Narrowing only: a verdict that is not an auto-post is returned untouched.
  const low=evaluateCodingAutoPost({jurisdiction:'us',suggestion:{...sale,confidence:'low'}});
  assert.notEqual(low.action,'auto_post');
  assert.notEqual(low.reason,'revenue_source_required');
  assert.ok(resolvePostingAdmission({jurisdiction:'US',entity_type:'us-llc'})?.codingAutoPostVerdict);
  assert.equal(resolvePostingAdmission({jurisdiction:'US',entity_type:'us-llc'}).beforeJournalWrite,undefined,'US admission never writes');
});
