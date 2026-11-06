import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const documentSurface = readFileSync(new URL('../components/documents/document-chat.jsx', import.meta.url), 'utf8');
const transactionSurface = readFileSync(new URL('../components/financials/transaction-artifact.jsx', import.meta.url), 'utf8');
const composer = readFileSync(new URL('../components/shared/mention-composer.jsx', import.meta.url), 'utf8');
const apiClient = readFileSync(new URL('./firmApi.js', import.meta.url), 'utf8');
const server = readFileSync(new URL('../../server/donna/api.js', import.meta.url), 'utf8');

test('both mounted artifact chats route @Donna through the real Donna turn', () => {
  for (const source of [documentSurface, transactionSurface]) {
    assert.match(source, /selectedMentions\.length > 0 && !directDonna/);
    assert.match(source, /const addressedAgent = directDonna \? selectedMentions\[0\] : null/);
    assert.match(source, /addressedAgent[\s\S]*?postFirm(?:Document|Transaction)ChatMessage/);
    assert.match(source, /<AgentMentionActivity/);
  }
  assert.match(apiClient, /addressed_agent: addressedAgent/);
  assert.match(server, /validateDirectAgentChatRef/);
  assert.match(server, /kind: 'agent_instruction', mentions: \[addressedAgent\]/);
});

test('the shared composer uses ordinary chat feedback, not a pre-send promise pill', () => {
  assert.doesNotMatch(composer, /Donna will reply/);
  assert.match(composer, /Reading your message…/);
  assert.match(composer, /Checking the artifact…/);
  assert.match(composer, /Preparing a reply…/);
  assert.match(composer, /role="status"/);
  assert.match(composer, /className="donna-working-dot"/);
  assert.match(composer, /className="donna-chat-message"/);
});

test('both mounted chats append an optimistic human bubble before awaiting Donna', () => {
  for (const source of [documentSurface, transactionSurface]) {
    assert.match(source, /buildOptimisticUserMessage/);
    assert.match(source, /settleOptimisticChatTurn/);
    assert.match(source, /setMessages\(\(prev\) => \[/);
    assert.match(source, /setActiveMentionAgent\(addressedAgent\)/);
    assert.match(source, /mentionComposer\.reset\(\)[\s\S]*?setMessages\(\(prev\) => \[/);
  }
  assert.match(server, /projectChatMessagesForViewer/);
  assert.match(server, /actorId: viewerActorId/);
});
