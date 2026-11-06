// FIK-0b chat admission (docs/plan-2026-09-22-fi-jev-decision-knowledge.md
// §2 / §8.4): a jurisdiction-scope firm fact is an unreviewed general rule, so
// it never reaches a chat model's context — owner portal chat, transaction
// chat, feed chat or firm feed chat — nor the transaction-case packet that
// mirrors transaction chat. The client-scope sibling still does.
//
// Real PG and the mounted routes through the appliance harness. The provider is
// never reached: the test wraps fetch to capture the exact outgoing request
// body, then lets the recorded-providers stub refuse it. What the model would
// have seen is the evidence; the chat's own reply is not under test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApplianceForTest, applianceHarnessSkipReason } from './testSupport/applianceHarness.js';
import { withFirmDbClient } from './firmDb.js';
import { saveFirmFact, getFirmFactsForTransactionCase } from './firmFacts.js';

const RULE = 'Every GB business must treat sponsorship income as exempt from VAT.';
const LOCAL = 'Kestrel Print Studio Ltd invoices its sponsors through its director.';

test('real PG: no chat surface puts a jurisdiction-scope fact in front of the model; the client fact still goes', { skip: applianceHarnessSkipReason() }, async () => {
  const app = await bootApplianceForTest();
  const captured = [];
  const stub = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (/api\.anthropic\.com|api\.openai\.com/.test(url) && init?.body != null) {
      captured.push(typeof init.body === 'string' ? init.body : Buffer.from(init.body).toString('utf8'));
    }
    return stub(input, init);
  };
  try {
    const { firmId } = app;
    const { clientId } = await app.createClient();
    // Pre-existing rows, as FIK-0b found them: minted through the real writer
    // before any guard existed. Nothing here rewrites or dismisses them.
    await withFirmDbClient(async (client) => {
      for (const [scope, subject, fact] of [['jurisdiction', 'GB', RULE], ['client', 'Kestrel Print Studio Ltd', LOCAL]]) {
        const saved = await saveFirmFact({ client, firmId, teach: 'explicit', scope, subject, fact, confidence: 'high',
          provenance: { source: 'legacy-fixture', client_id: clientId }, model: 'firm_operator' });
        assert.equal(saved.status, 'active', `fixture: the ${scope} fact is active`);
      }
    });
    const txId = `${clientId}-tx-1`;
    await app.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload)
      values($1,$2,$3,'2026-09-01','SPONSOR PAYMENT ACME',500,0,'GBP','needs_review','{}'::jsonb)`, [txId, firmId, clientId]);

    const surfaces = [
      ['client-chat', '/api/donna/firms/client-chat/messages', { firm_id: firmId, client_id: clientId, message: 'Is our sponsorship income taxable?' }],
      ['transaction-chat', '/api/donna/firms/transaction-chat/messages', { firm_id: firmId, client_id: clientId, transaction_id: txId, message: 'How should this sponsor payment be treated?' }],
      ['feed-chat', '/api/donna/firms/feed-chat/messages', { firm_id: firmId, client_id: clientId, message: 'How should sponsor payments be treated?' }],
      ['firm-feed-chat', '/api/donna/firms/feed-chat/firm/messages', { firm_id: firmId, message: 'How should sponsor payments be treated?' }]
    ];
    for (const [name, path, body] of surfaces) {
      captured.length = 0;
      await app.api.request({ method: 'POST', path, auth: true, body });
      assert.ok(captured.length > 0, `${name}: the route assembled a model request`);
      const wire = captured.join('\n');
      assert.ok(wire.includes(LOCAL), `${name}: the client-scope fact is still in the model context`);
      assert.ok(!wire.includes(RULE), `${name}: the jurisdiction-scope rule never reaches the model`);
    }

    // The packet reader mirrors transaction chat, so its receipt matches.
    const packetFacts = await withFirmDbClient((client) => getFirmFactsForTransactionCase({ client, firmId, clientId, transactionId: txId }));
    assert.deepEqual(packetFacts.map((fact) => fact.scope), ['client']);

    assert.equal((await app.query("select count(*)::int as n from firm_facts where firm_id=$1 and scope='jurisdiction' and status='active'", [firmId])).rows[0].n, 1,
      'the existing row is filtered at read, never rewritten');
  } finally {
    globalThis.fetch = stub;
    await app.stop();
  }
});
