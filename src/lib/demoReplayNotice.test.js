import assert from 'node:assert/strict';
import test from 'node:test';

import { demoReplayNoticeText } from './demoReplayNotice.js';

const session = { recorded_at: '2026-11-10', recorded_models: { anthropic: ['claude-opus-4-8'], openai: ['gpt-5.4 (scripted_stand_in)'] } };

test('a normal book shows no notice', () => {
  assert.equal(demoReplayNoticeText({ health: { provider_replay: null, model_lanes: { replay: false } } }), null);
  assert.equal(demoReplayNoticeText({ health: null }), null);
});

test('under replay the notice says no model is called', () => {
  const notice = demoReplayNoticeText({ health: { provider_replay: session, model_lanes: { replay: true } } });
  assert.equal(notice.title, 'Demo: recorded model outputs');
  assert.match(notice.body, /claude-opus-4-8, gpt-5\.4 \(scripted_stand_in\), recorded 2026-11-10/);
  assert.match(notice.body, /No model is called and no key is used/);
});

test('a replayed book later run on live providers stays marked, and says new work is live', () => {
  const notice = demoReplayNoticeText({ health: { provider_replay: session, model_lanes: { replay: false } } });
  assert.equal(notice.title, 'Demo: recorded model outputs');
  assert.match(notice.body, /holds answers recorded earlier/);
  assert.match(notice.body, /New work on it is answered by the providers configured now/);
  assert.doesNotMatch(notice.body, /No model is called/);
  const fi = demoReplayNoticeText({ health: { provider_replay: session, model_lanes: { replay: false } }, locale: 'fi' });
  assert.match(fi.title, /^Demo: recorded model outputs/);
  assert.match(fi.body, /Uudet tehtävät/);
});
