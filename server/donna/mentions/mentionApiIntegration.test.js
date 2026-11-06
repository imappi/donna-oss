import test from 'node:test';
import assert from 'node:assert/strict';

import { createApiSeamPool, requestDonnaApi } from '../testSupport/apiSeamHarness.js';

const TOKEN = 'mention-api-token';
const priorToken = process.env.DONNA_ACCESS_TOKEN;
const priorDatabaseUrl = process.env.DATABASE_URL;
process.env.DONNA_ACCESS_TOKEN = TOKEN;
process.env.DATABASE_URL = 'postgres://seam.invalid/donna';

test.after(() => {
  if (priorToken === undefined) delete process.env.DONNA_ACCESS_TOKEN;
  else process.env.DONNA_ACCESS_TOKEN = priorToken;
  if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = priorDatabaseUrl;
});

const rosterResponders = () => [
  [/select id, name, email from firm_members/, {
    rows: [{ id: 'member-david', name: 'David', email: 'david@example.test' }], rowCount: 1
  }],
  [/from firm_collaborators fc/, { rows: [], rowCount: 0 }],
  [/assignment_kind = 'specialist_role'/, { rows: [], rowCount: 0 }]
];

await test('real comment route commits a human mention and its notification together', async () => {
  process.env.DONNA_ACCESS_TOKEN = TOKEN;
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  const pool = createApiSeamPool([
    ...rosterResponders(),
    [/select 1 from transactions/, { rows: [{ one: 1 }], rowCount: 1 }],
    [/insert into transaction_chat_messages/, ({ params }) => ({
      rows: [{
        id: params[0], firm_id: params[1], client_id: params[2], transaction_id: params[3],
        role: params[4], content: params[5], payload: JSON.parse(params[6]),
        model: params[7], model_version: params[8], actor_type: params[9],
        actor_id: params[10], created_at: new Date('2026-08-27T19:17:13Z')
      }],
      rowCount: 1
    })],
    [/insert into audit_events/, { rows: [], rowCount: 1 }],
    [/insert into mention_notifications/, { rows: [], rowCount: 1 }]
  ]);

  const response = await requestDonnaApi({
    method: 'POST',
    url: '/api/donna/firms/chat-comments',
    headers: { authorization: `Bearer ${TOKEN}` },
    pool,
    body: {
      client_id: 'client-1',
      surface: 'transaction_chat',
      transaction_id: 'tx-1',
      text: '@David please check this',
      flavor: 'mention',
      mentions: [{
        actor_type: 'seat', principal_type: 'firm_member', principal_id: 'member-david'
      }]
    }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json?.message?.payload?.flavor, 'mention');
  const notificationInserts = pool.matching(/insert into mention_notifications/);
  assert.equal(notificationInserts.length, 1);
  assert.equal(notificationInserts[0].params[3], 'firm_member');
  assert.equal(notificationInserts[0].params[4], 'member-david');
  assert.equal(notificationInserts[0].params[5], 'mention');
  assert.equal(pool.matching(/^commit$/i).length, 1);
});

await test('real comment route refuses an agent FYI before persisting a silent no-op', async () => {
  process.env.DONNA_ACCESS_TOKEN = TOKEN;
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  const pool = createApiSeamPool(rosterResponders());
  const response = await requestDonnaApi({
    method: 'POST',
    url: '/api/donna/firms/chat-comments',
    headers: { authorization: `Bearer ${TOKEN}` },
    pool,
    body: {
      client_id: 'client-1',
      surface: 'transaction_chat',
      transaction_id: 'tx-1',
      text: '@Donna please answer this',
      flavor: 'mention',
      mentions: [{ actor_type: 'agent', agent_id: 'donna', role: 'operator' }]
    }
  });

  assert.equal(response.statusCode, 400, JSON.stringify(response.json));
  assert.equal(response.json?.code, 'AGENT_REQUIRES_ASK');
  assert.match(response.json?.error || '', /ask the agent/i);
  assert.equal(pool.matching(/insert into transaction_chat_messages/).length, 0);
});

await test('real Donna chat route revalidates the structured addressee before persistence', async () => {
  process.env.DONNA_ACCESS_TOKEN = TOKEN;
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  const pool = createApiSeamPool(rosterResponders());
  const response = await requestDonnaApi({
    method: 'POST',
    url: '/api/donna/firms/document-chat/messages',
    headers: { authorization: `Bearer ${TOKEN}` },
    pool,
    body: {
      client_id: 'client-1',
      document_id: 'doc-1',
      message: '@David please answer this',
      addressed_agent: {
        actor_type: 'seat', principal_type: 'firm_member', principal_id: 'member-david'
      }
    }
  });

  assert.equal(response.statusCode, 400, JSON.stringify(response.json));
  assert.equal(response.json?.code, 'direct_chat_requires_donna');
  assert.equal(pool.matching(/insert into document_chat_messages/).length, 0);
});
