import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildOptimisticUserMessage,
  removeOptimisticChatTurn,
  settleOptimisticChatTurn
} from './chatOptimistic.js';

test('optimistic turn is immediately a right-side viewer-authored user message', () => {
  const message = buildOptimisticUserMessage({
    id: 'local:tx-1:1',
    content: '  @Donna fix this  ',
    payload: { kind: 'agent_instruction' }
  });
  assert.equal(message.role, 'user');
  assert.equal(message.content, '@Donna fix this');
  assert.equal(message.viewer_is_actor, true);
  assert.equal(message.optimistic, true);
});

test('settle replaces the placeholder in place with the persisted turn and reply', () => {
  const before = [
    { id: 'old' },
    { id: 'local:tx-1:1', optimistic: true },
    { id: 'later-local-row' }
  ];
  const settled = settleOptimisticChatTurn(before, 'local:tx-1:1', [
    { id: 'server-user', role: 'user' },
    { id: 'server-assistant', role: 'assistant' }
  ]);
  assert.deepEqual(settled.map((message) => message.id), [
    'old',
    'server-user',
    'server-assistant',
    'later-local-row'
  ]);
});

test('settle dedupes a server row already merged and failed sends remove only their placeholder', () => {
  const before = [
    { id: 'server-user', role: 'user' },
    { id: 'local:tx-1:1', optimistic: true }
  ];
  const settled = settleOptimisticChatTurn(before, 'local:tx-1:1', [
    { id: 'server-user', role: 'user' },
    { id: 'server-assistant', role: 'assistant' }
  ]);
  assert.deepEqual(settled.map((message) => message.id), ['server-user', 'server-assistant']);
  assert.deepEqual(
    removeOptimisticChatTurn([...settled, { id: 'local:tx-1:2' }], 'local:tx-1:2').map((message) => message.id),
    ['server-user', 'server-assistant']
  );
});
