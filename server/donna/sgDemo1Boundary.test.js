import assert from 'node:assert/strict';
import { builtinModules } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENTRY = path.join(ROOT, 'scripts/eval_sg_demo_1.js');
const ALLOWED_LOCAL_MODULES = new Set([
  'scripts/eval_sg_demo_1.js',
  'server/donna/testSupport/sgDemo1Definition.js',
  'server/donna/testSupport/sgDemo1Goldset.js',
]);
const READ_ONLY_BUILTINS = new Set([
  'node:crypto', 'node:fs', 'node:path', 'node:process', 'node:url',
  'crypto', 'fs', 'path', 'process', 'url',
]);
const ALL_BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => name.startsWith('node:') ? name : `node:${name}`)]);
const FORBIDDEN_SOURCE = [
  ['fetch', /\bfetch\s*\(/],
  ['network', /node:(?:http|https|net|tls|dns)/],
  ['child_process', /node:child_process|\bchild_process\b/],
  ['filesystem_write', /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|renameSync|unlinkSync|rmSync|mkdirSync)\b/],
  ['environment_read', /\bprocess\.env\b/],
  ['production_db', /\b(?:firmDb|parseDocumentsDb|reconcileConvergenceState)\b/],
  ['model_or_provider', /\b(?:modelLanes|OpenAI|Anthropic|recordedProvider)\b/],
  ['send_or_post', /\b(?:sendClientMessage|sendInternalMessage|postLedger|writeLedgerJournal|authorizeAccounting|mutateClientFlag|writeProductionData)\b/],
  ['live_pack_or_migration', /\b(?:packs\/sg|migrations\/|clientFlagActs)\b/],
];

test('the real SG-Demo-1 evaluator import graph contains only three local modules and read-only Node builtins', () => {
  const audit = auditEvaluatorGraph(ENTRY);
  assert.deepEqual(audit.violations, []);
  assert.deepEqual([...audit.localModules].sort(), [...ALLOWED_LOCAL_MODULES].sort());
});

test('the real CLI passes with network, subprocess, filesystem-write, and credential access trapped closed', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'sg-demo-1-boundary-'));
  const trapPath = path.join(temporary, 'trap.cjs');
  writeFileSync(trapPath, runtimeTrapSource());
  const result = spawnSync(process.execPath, [ENTRY], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { NODE_OPTIONS: `--require=${trapPath}`, TZ: 'UTC', LANG: 'C' },
  });
  assert.equal(result.status, 0, result.stderr);
  const committed = readFileSync(path.join(ROOT, 'data/worlds/sg/receipts/sg-demo-1-goldset-v1.json'), 'utf8');
  assert.equal(result.stdout, committed);
  assert.equal(result.stderr, '');
});

test('the boundary proof is non-vacuous for named send/post/authorize/config/production-write canaries', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'sg-demo-1-canary-'));
  const canary = path.join(temporary, 'canary.mjs');
  writeFileSync(canary, `
    import 'node:http';
    export const sendClientMessage = () => {};
    export const postLedger = () => {};
    export const authorizeAccounting = () => {};
    export const mutateClientFlag = () => {};
    export const writeProductionData = () => {};
  `);
  const audit = auditEvaluatorGraph(canary, { permitRootOutsideAllowlist: true });
  assert.ok(audit.violations.some(({ kind }) => kind === 'builtin_not_read_only'));
  assert.ok(audit.violations.some(({ kind, detail }) => kind === 'forbidden_source' && detail === 'send_or_post'));
});

test('the runtime trap is non-vacuous: a network attempt terminates before any request', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'sg-demo-1-runtime-canary-'));
  const trapPath = path.join(temporary, 'trap.cjs');
  const canaryPath = path.join(temporary, 'network-canary.mjs');
  writeFileSync(trapPath, runtimeTrapSource());
  writeFileSync(canaryPath, `fetch('https://example.invalid/');\n`);
  const result = spawnSync(process.execPath, [canaryPath], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { NODE_OPTIONS: `--require=${trapPath}` },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SG_DEMO_1_TRAP:fetch/);
});

function auditEvaluatorGraph(entry, { permitRootOutsideAllowlist = false } = {}) {
  const queue = [entry];
  const seen = new Set();
  const localModules = new Set();
  const violations = [];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const relative = path.relative(ROOT, file).split(path.sep).join('/');
    const allowed = ALLOWED_LOCAL_MODULES.has(relative);
    if (!allowed && !(permitRootOutsideAllowlist && file === entry)) violations.push({ kind: 'local_module_not_allowed', file: relative });
    if (allowed) localModules.add(relative);
    const source = readFileSync(file, 'utf8');
    for (const [detail, pattern] of FORBIDDEN_SOURCE) if (pattern.test(source)) violations.push({ kind: 'forbidden_source', file: relative, detail });
    for (const specifier of importSpecifiers(source)) {
      if (ALL_BUILTINS.has(specifier)) {
        if (!READ_ONLY_BUILTINS.has(specifier)) violations.push({ kind: 'builtin_not_read_only', file: relative, detail: specifier });
        continue;
      }
      if (!specifier.startsWith('.')) {
        violations.push({ kind: 'package_not_allowed', file: relative, detail: specifier });
        continue;
      }
      const resolved = resolveLocal(file, specifier);
      queue.push(resolved);
    }
  }
  return { violations, localModules };
}

function importSpecifiers(source) {
  const patterns = [
    /\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]/gs,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]));
}

function resolveLocal(importer, specifier) {
  const unresolved = path.resolve(path.dirname(importer), specifier);
  return path.extname(unresolved) ? unresolved : `${unresolved}.js`;
}

function runtimeTrapSource() {
  return `
    const fail = (name) => function trapped() { throw new Error('SG_DEMO_1_TRAP:' + name); };
    global.fetch = fail('fetch');
    for (const name of ['node:http', 'node:https']) {
      const module = require(name);
      module.request = fail(name + '.request');
      module.get = fail(name + '.get');
    }
    const net = require('node:net');
    net.Socket.prototype.connect = fail('net.connect');
    const child = require('node:child_process');
    for (const name of ['exec', 'execFile', 'fork', 'spawn', 'execSync', 'execFileSync', 'spawnSync']) child[name] = fail('child_process.' + name);
    const fs = require('node:fs');
    for (const name of ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream', 'rename', 'renameSync', 'unlink', 'unlinkSync', 'rm', 'rmSync', 'mkdir', 'mkdirSync']) fs[name] = fail('fs.' + name);
    const promises = require('node:fs/promises');
    for (const name of ['writeFile', 'appendFile', 'rename', 'unlink', 'rm', 'mkdir']) promises[name] = fail('fs.promises.' + name);
  `;
}
