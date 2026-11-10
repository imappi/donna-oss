import test from 'node:test';
import assert from 'node:assert/strict';

import { buildModelLaneReceipt, MODEL_LANES } from './capabilityReceipt.js';

const FULL_COMPATIBLE = Object.freeze({
  OPENAI_COMPATIBLE_API_KEY: 'tk-secret-key',
  OPENAI_COMPATIBLE_BASE_URL: 'https://api.together.xyz/v1',
  OPENAI_COMPATIBLE_MODEL: 'Qwen/Qwen3.5-397B-A17B',
  MODEL_CHALLENGER_CAP_TOKENS: '1000000'
});

test('everything provisioned → all three lanes LIT, no DARK anywhere', () => {
  const r = buildModelLaneReceipt({ OPENAI_API_KEY: 'sk-x', ANTHROPIC_API_KEY: 'sk-ant-x', ...FULL_COMPATIBLE });
  assert.equal(r.openai, true);
  assert.equal(r.anthropic, true);
  assert.equal(r.openai_compatible, true);
  assert.match(r.line, /openai LIT/);
  assert.match(r.line, /anthropic LIT/);
  assert.match(r.line, /openai_compatible LIT — host api\.together\.xyz, candidate Qwen\/Qwen3\.5-397B-A17B, cap 1000000 tokens\/client\/mo/);
  assert.ok(!r.line.includes('DARK'));
});

test('the challenger endpoint names each missing env row — a provisioning gap is one boot line', () => {
  const r = buildModelLaneReceipt({
    OPENAI_API_KEY: 'sk-x',
    ANTHROPIC_API_KEY: 'sk-ant-x',
    OPENAI_COMPATIBLE_API_KEY: 'tk-x',
    OPENAI_COMPATIBLE_BASE_URL: 'https://api.together.xyz/v1'
  });
  assert.equal(r.openai_compatible, false);
  assert.match(r.line, /openai_compatible DARK — no OPENAI_COMPATIBLE_MODEL, no MODEL_CHALLENGER_CAP_TOKENS/);
  assert.ok(r.line.includes('shadow challenger — bank-line classification (evidence-only)'));
});

test('the OpenAI-only appliance names every dark Anthropic lane and its reason', () => {
  const r = buildModelLaneReceipt({ OPENAI_API_KEY: 'sk-x' });
  assert.equal(r.anthropic, false);
  assert.match(r.line, /anthropic DARK — no ANTHROPIC_API_KEY/);
  for (const lane of MODEL_LANES.anthropic) {
    assert.ok(r.line.includes(lane), lane);
  }
});

test('a blank/whitespace key counts as absent (the empty-string env trap)', () => {
  const r = buildModelLaneReceipt({ OPENAI_API_KEY: '  ', ANTHROPIC_API_KEY: '' });
  assert.equal(r.openai, false);
  assert.equal(r.anthropic, false);
  assert.match(r.line, /openai DARK — no OPENAI_API_KEY/);
});

test('the receipt never leaks key material — host, candidate model, and cap print; keys never do', () => {
  const r = buildModelLaneReceipt({ OPENAI_API_KEY: 'sk-secret-abc', ANTHROPIC_API_KEY: 'sk-ant-secret-xyz', ...FULL_COMPATIBLE });
  assert.ok(!r.line.includes('secret'));
  assert.ok(!r.line.includes('tk-secret-key'));
});

test('a set model-override knob is named on the lit lane (the nano-downgrade trap)', () => {
  const r = buildModelLaneReceipt({
    OPENAI_API_KEY: 'sk-x',
    OPENAI_MODEL: 'gpt-5.4-nano',
    ANTHROPIC_API_KEY: 'sk-ant-x',
    LOUIS_MODEL: 'claude-opus-4-8'
  });
  assert.match(r.line, /openai LIT — OPENAI_MODEL override: gpt-5\.4-nano/);
  assert.match(r.line, /anthropic LIT — LOUIS_MODEL override: claude-opus-4-8/);
});

test('no override knob set → the line keeps its original shape', () => {
  const r = buildModelLaneReceipt({ OPENAI_API_KEY: 'sk-x', ANTHROPIC_API_KEY: 'sk-ant-x' });
  assert.ok(!r.line.includes('override'));
  assert.match(r.line, /openai LIT \(/);
});

test('a blank override knob counts as unset; a DARK lane never names an override', () => {
  const blank = buildModelLaneReceipt({ OPENAI_API_KEY: 'sk-x', OPENAI_MODEL: '  ', ANTHROPIC_API_KEY: 'sk-ant-x' });
  assert.ok(!blank.line.includes('override'));
  const dark = buildModelLaneReceipt({ OPENAI_MODEL: 'gpt-5.4-nano' });
  assert.match(dark.line, /openai DARK — no OPENAI_API_KEY/);
  assert.ok(!dark.line.includes('override'));
});

test('2026-11-10: the Anthropic-only appliance — every text lane is on the LIT Anthropic line', () => {
  const r = buildModelLaneReceipt({ ANTHROPIC_API_KEY: 'sk-ant-x' });
  assert.equal(r.anthropic, true);
  assert.match(r.line, /anthropic LIT \(/);
  for (const lane of ['coding (batch coder)', 'ask drafting', 'memory extraction', 'owner invoice commands', 'document chat', 'marketing drafters + reply reader']) {
    assert.ok(MODEL_LANES.anthropic.includes(lane), lane);
  }
  assert.match(r.line, /openai DARK — no OPENAI_API_KEY \([^)]*the text lanes only when no Anthropic key is set/);
  const pinned = buildModelLaneReceipt({ ANTHROPIC_API_KEY: 'sk-ant-x', OPENAI_MODEL: 'claude-opus-4-8' });
  assert.match(pinned.line, /anthropic LIT — OPENAI_MODEL override: claude-opus-4-8 \(text lanes\)/);
});
