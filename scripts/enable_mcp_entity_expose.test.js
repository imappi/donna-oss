// Unit tests for the MCP per-entity exposure script — the PURE plan logic only
// (parseArgv + buildExposurePlan), no live DB. Load-bearing properties:
//   - dry-run is the default (apply only when --apply present);
//   - NO default client: a data-exposure grant must name its entity;
//   - a stage that ACTS (canary) is flagged as EXPOSING the entity to Claude;
//   - 'auto' is refused in the plan itself (the writer refuses it too via
//     AUTO_FORBIDDEN_FLAGS — belt and braces: this script should never even
//     attempt the write);
//   - the flag key is pinned to MCP_ENTITY_EXPOSE, never taken from argv.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgv, buildExposurePlan } from './enable_mcp_entity_expose.js';
import { MCP_ENTITY_EXPOSE_FLAG_KEY } from '../server/donna/mcp/mcpReadSurface.js';

test('parseArgv: dry-run, demo firm, NO default client, canary by default', () => {
  const o = parseArgv([]);
  assert.equal(o.apply, false);
  assert.equal(o.firmId, 'donna-demo-firm');
  assert.equal(o.clientId, null);
  assert.equal(o.stage, 'canary');
});

test('parseArgv: flags override the defaults (no --flag arg — the key is pinned)', () => {
  const o = parseArgv(['--apply', '--firm', 'f2', '--client', 'c2', '--stage', 'off', '--reason', 'revoke']);
  assert.deepEqual(o, { apply: true, firmId: 'f2', clientId: 'c2', stage: 'off', reason: 'revoke' });
});

test('buildExposurePlan: missing client is REFUSED — consent names its entity', () => {
  const p = buildExposurePlan({ firmId: 'f1', clientId: null, stage: 'canary' });
  assert.equal(p.ok, false);
  assert.match(p.errors.join(' '), /name its entity/);
});

test('buildExposurePlan: canary EXPOSES and pins the flag key', () => {
  const p = buildExposurePlan({ firmId: 'f1', clientId: 'alpha', stage: 'canary', currentStage: null });
  assert.equal(p.ok, true);
  assert.equal(p.flagKey, MCP_ENTITY_EXPOSE_FLAG_KEY);
  assert.equal(p.willExpose, true);
  assert.equal(p.willChange, true);
});

test('buildExposurePlan: off revokes (does not expose); auto is refused', () => {
  const off = buildExposurePlan({ firmId: 'f1', clientId: 'alpha', stage: 'off', currentStage: 'canary' });
  assert.equal(off.ok, true);
  assert.equal(off.willExpose, false);

  const auto = buildExposurePlan({ firmId: 'f1', clientId: 'alpha', stage: 'auto' });
  assert.equal(auto.ok, false);
  assert.match(auto.errors.join(' '), /AUTO_FORBIDDEN/);

  const bad = buildExposurePlan({ firmId: 'f1', clientId: 'alpha', stage: 'sideways' });
  assert.equal(bad.ok, false);
});
