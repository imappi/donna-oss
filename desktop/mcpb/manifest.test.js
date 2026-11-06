// MCPB manifest pins — packaging honesty + parity with the shim's tool mirror.
//
// The manifest is what the Claude Desktop directory renders and what ships in
// the .mcpb bundle. These pins keep it aligned with the code so a tool rename
// or copy drift cannot ship silently:
//   - tools[] mirrors STATIC_TOOL_MIRROR name-for-name (the shim serves that
//     mirror as tools/list whenever Donna is not reachable, so the two lists
//     are the same promise made in two places);
//   - the copy register (2026-08-11): manifest copy states the read-only
//     posture plainly and carries no custody slogans;
//   - privacy_policies, once present for directory submission, are HTTPS URLs.
// This file is excluded from the packed bundle by .mcpbignore (*.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SHIM_VERSION, STATIC_TOOL_MIRROR } from './server/shimCore.mjs';

const manifestPath = fileURLToPath(new URL('./manifest.json', import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

test('manifest carries the fields mcpb pack requires', () => {
  assert.equal(manifest.manifest_version, '0.3');
  assert.equal(manifest.name, 'donna-books');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, SHIM_VERSION);
  assert.ok(manifest.description);
  assert.ok(manifest.author?.name);
  assert.equal(manifest.server?.type, 'node');
  assert.equal(manifest.server?.entry_point, 'server/index.mjs');
  assert.deepEqual(manifest.server?.mcp_config?.args, ['${__dirname}/server/index.mjs']);
});

test('manifest tools mirror the shim tool list name-for-name', () => {
  assert.deepEqual(
    manifest.tools.map((t) => t.name),
    STATIC_TOOL_MIRROR.map((t) => t.name)
  );
  for (const tool of manifest.tools) assert.ok(tool.description);
});

test('manifest copy follows the copy register: read-only stated, no custody slogans', () => {
  const copy = `${manifest.description} ${manifest.long_description}`;
  assert.match(copy, /read-only/i);
  assert.doesNotMatch(copy, /never leaves?|stays? on (this|your) (machine|office)|100% private/i);
});

test('privacy_policies, when present, are HTTPS URLs', () => {
  for (const url of manifest.privacy_policies || []) {
    assert.match(url, /^https:\/\//);
  }
});
