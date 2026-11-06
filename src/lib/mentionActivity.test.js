import test from 'node:test';
import assert from 'node:assert/strict';

import {
  filterMentionOptionsForSelection,
  isDirectDonnaMention,
  nextMentionSelection,
  pendingAgentMentionAsks
} from './mentionActivity.js';

const donna = {
  key: 'agent:donna:operator', actor_type: 'agent', agent_id: 'donna',
  role: 'operator', display: 'Donna'
};
const clara = {
  key: 'agent:clara:collections', actor_type: 'agent', agent_id: 'clara',
  role: 'collections', display: 'Clara'
};
const david = {
  key: 'seat:firm_collaborator:david', actor_type: 'seat',
  principal_type: 'firm_collaborator', principal_id: 'david', display: 'David'
};

test('@Donna is a direct chat address; a specialist defaults to Ask', () => {
  const donnaPick = nextMentionSelection({ current: [], picked: donna });
  assert.equal(donnaPick.flavor, 'mention');
  assert.equal(isDirectDonnaMention(donnaPick.mentions), true);

  const specialistPick = nextMentionSelection({ current: [], picked: clara });
  assert.equal(specialistPick.flavor, 'ask');
  assert.deepEqual(specialistPick.mentions, [clara]);
});

test('a human remains an FYI mention and agents stay single-addressee', () => {
  assert.deepEqual(nextMentionSelection({ current: [], picked: david }), {
    mentions: [david],
    flavor: 'mention'
  });
  assert.deepEqual(nextMentionSelection({ current: [david], picked: clara }), {
    mentions: [clara],
    flavor: 'ask'
  });
});

test('the typeahead never mixes a human FYI with an agent execution request', () => {
  assert.deepEqual(filterMentionOptionsForSelection({
    current: [david], options: [donna, clara, david]
  }), [david]);
  assert.deepEqual(filterMentionOptionsForSelection({
    current: [donna], options: [donna, clara, david]
  }), []);
  assert.deepEqual(filterMentionOptionsForSelection({
    current: [], options: [donna, david]
  }), [donna, david]);
});

test('pending agent activity survives refresh and clears only on the persisted reply', () => {
  const ask = {
    id: 'm-ask', role: 'user',
    payload: { kind: 'comment', flavor: 'ask', ask_id: 'ask-1', mentions: [clara] }
  };
  assert.deepEqual(pendingAgentMentionAsks([ask]), [{
    ask_id: 'ask-1', agent_id: 'clara', display: 'Clara'
  }]);

  const reply = {
    id: 'm-reply', role: 'assistant',
    payload: { kind: 'comment', flavor: 'mention', ask_id: 'ask-1', mentions: [david] }
  };
  assert.deepEqual(pendingAgentMentionAsks([ask, reply]), []);
});
