import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleFinnishPilotOperator } from './hostedPilotOperator.js';
const profile = { companyName: 'Synthetic Oy', jurisdiction: 'FI', entityType: 'fi-oy', accountingCurrency: 'EUR',
  accounting_system: 'none', accounting_view: 'management_books', accountingBasis: 'accrual' };
const request = { auth: { userId: 'auth-user' }, firmId: 'f', clientId: 'c', method: 'POST',
  body: { firm_id: 'f', profile_patch: profile, confirmed: true, client_version: 'a'.repeat(64) } };
const authorize = async args => {
  assert.deepEqual(args, { firmId: 'f', auth: request.auth, clientIds: ['c'], requireMember: true });
  return { principal: { principalType: 'firm_member', principalId: 'real-member' } };
};
test('operator adapter invokes only the existing setup writer with server-resolved actor and reviewed version', async () => {
  const receipt = { processing_readiness: 'INCOMPLETE' };
  assert.equal(await handleFinnishPilotOperator(request, { authorize, prepare: async args => {
    assert.deepEqual(args, { firmId: 'f', clientId: 'c', actorId: 'real-member', profilePatch: profile, expectedClientVersion: 'a'.repeat(64) });
    return receipt;
  } }), receipt);
});
test('operator adapter refuses shared tokens, owners, missing confirmation and forged actor/extra profile fields before setup', async () => {
  const prepare = () => assert.fail('must not invoke setup');
  for (const principalType of ['access_token', 'firm_collaborator']) {
    await assert.rejects(handleFinnishPilotOperator(request, { authorize: async () => ({ principal: { principalType, principalId: 'fake' } }), prepare }), { code: 'PILOT_OPERATOR_REQUIRED' });
  }
  for (const body of [ { ...request.body, confirmed: false }, { ...request.body, client_version: '' },
    { ...request.body, actor_id: 'spoof' }, { ...request.body, authority_basis: 'spoof' },
    { ...request.body, profile_patch: { ...profile, posting: true } } ]) {
    await assert.rejects(handleFinnishPilotOperator({ ...request, body }, { authorize, prepare }));
  }
});
test('review shares member authorization and never invokes setup', async () => {
  assert.equal(await handleFinnishPilotOperator({ ...request, method: 'GET' }, { authorize,
    prepare: () => assert.fail('read never prepares'), review: async scope => {
      assert.equal(scope.actorId, 'real-member'); return 'review';
    } }), 'review');
});

test('hosted pilot transport has the exact production router rewrite', () => {
  const config = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url)));
  assert.deepEqual(config.rewrites.find(row => row.source === '/api/donna/firms/clients/:id/finnish-pilot-setup'), {
    source: '/api/donna/firms/clients/:id/finnish-pilot-setup', destination: '/api/donna-router?path=firms/clients/:id/finnish-pilot-setup'
  });
});

test('recovery transport bypasses the email-fallback resolver and forwards only a closed explicit request',async()=>{
  const auth={type:'supabase_user',userId:'verified-subject',email:'operator@proof.invalid'};
  const authorize=()=>assert.fail('recovery must never call generic auto-binding authorization');
  const base={auth,firmId:'f',clientId:'c',method:'GET',recovery:true};
  const recover=async input=>{assert.equal(input.auth,auth);assert.deepEqual(input.request,{action:'review'});return 'recovery-review';};
  assert.equal(await handleFinnishPilotOperator(base,{authorize,recover}),'recovery-review');
  const owner_recovery={action:'approve',confirmed:true,review_digest:'a'.repeat(64)};
  assert.equal(await handleFinnishPilotOperator({...base,method:'POST',body:{firm_id:'f',owner_recovery}},
    {authorize,recover:async input=>{assert.deepEqual(input.request,owner_recovery);return 'applied';}}),'applied');
  for(const body of [{firm_id:'f',owner_recovery,actor_id:'spoof'}, {firm_id:'f',owner_recovery:null},
    {firm_id:'f',owner_recovery:{...owner_recovery,action:'review'}}]){
    await assert.rejects(handleFinnishPilotOperator({...base,method:'POST',body},{authorize,recover:()=>assert.fail('closed envelope')}),{code:'PILOT_INPUT_INVALID'});
  }
});
