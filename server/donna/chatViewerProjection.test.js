import test from 'node:test';
import assert from 'node:assert/strict';

import {
  projectChatMessageForViewer,
  projectChatMessagesForViewer
} from './chatViewerProjection.js';

test('chat direction is viewer-relative without mutating the persisted row', () => {
  const persisted = { id: 'm-1', role: 'user', actor_type: 'firm', actor_id: 'Kari@example.com' };
  const own = projectChatMessageForViewer(persisted, 'kari@example.com');
  const colleague = projectChatMessageForViewer(persisted, 'maya@example.com');
  assert.equal(own.viewer_is_actor, true);
  assert.equal(colleague.viewer_is_actor, false);
  assert.equal('viewer_is_actor' in persisted, false);
});

test('machine and unattributed legacy rows are never claimed as the viewer', () => {
  const projected = projectChatMessagesForViewer([
    { id: 'legacy', actor_id: null },
    { id: 'bot', actor_type: 'system', actor_id: 'system' }
  ], 'system');
  assert.deepEqual(projected.map((message) => message.viewer_is_actor), [false, false]);
});
