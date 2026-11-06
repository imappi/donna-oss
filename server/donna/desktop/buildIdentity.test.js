import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DESKTOP_RUNTIME_DIRTY_SCOPE,
  applyDesktopBuildIdentityDefaults,
  resolveDesktopBuildIdentity
} from './buildIdentity.js';

test('desktop build identity records workspace dirt without poisoning a clean accounting runtime', () => {
  const calls = [];
  const identity = resolveDesktopBuildIdentity({
    rootDir: '/repo',
    git: (args, root) => {
      calls.push({ args, root });
      if (args[0] === 'rev-parse') return 'abc123';
      return args.includes('--') ? '' : ' M src/App.jsx';
    }
  });
  assert.deepEqual(identity, {
    commit_sha: 'abc123',
    dirty: false,
    workspace_dirty: true,
    dirty_scope: DESKTOP_RUNTIME_DIRTY_SCOPE,
    source: 'git_checkout'
  });
  assert.equal(calls.length, 3);
  assert.ok(calls.find(({ args }) => args.includes('--')).args.includes('server'));
});

test('desktop build identity still fails closed for a changed runtime path', () => {
  const identity = resolveDesktopBuildIdentity({
    rootDir: '/repo',
    git: (args) => args[0] === 'rev-parse' ? 'abc123' : ' M server/donna/api.js'
  });
  assert.equal(identity.dirty, true);
  assert.equal(identity.workspace_dirty, true);
});

test('real git checkout distinguishes renderer-only and runtime source edits', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'donna-build-identity-git-'));
  const git = (...args) => execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
  try {
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await mkdir(path.join(dir, 'server', 'donna'), { recursive: true });
    await writeFile(path.join(dir, 'src', 'App.jsx'), 'export default null;\n', 'utf8');
    await writeFile(path.join(dir, 'server', 'donna', 'api.js'), 'export const api = true;\n', 'utf8');
    git('init');
    git('add', '.');
    git('-c', 'user.name=Donna Test', '-c', 'user.email=donna@example.invalid', 'commit', '-m', 'baseline');

    await writeFile(path.join(dir, 'src', 'App.jsx'), 'export default "renderer edit";\n', 'utf8');
    const rendererOnly = resolveDesktopBuildIdentity({ rootDir: dir });
    assert.equal(rendererOnly.workspace_dirty, true);
    assert.equal(rendererOnly.dirty, false);

    await writeFile(path.join(dir, 'server', 'donna', 'api.js'), 'export const api = "runtime edit";\n', 'utf8');
    const runtimeChanged = resolveDesktopBuildIdentity({ rootDir: dir });
    assert.equal(runtimeChanged.workspace_dirty, true);
    assert.equal(runtimeChanged.dirty, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('packaged build metadata supplies identity when git is unavailable without overriding launch-line values', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'donna-build-identity-'));
  const metadataPath = path.join(dir, 'build-identity.json');
  try {
    await writeFile(metadataPath, JSON.stringify({ commit_sha: 'packaged-sha', dirty: false }), 'utf8');
    const options = {
      metadataPath,
      git: () => { throw new Error('no git'); }
    };
    assert.deepEqual(resolveDesktopBuildIdentity(options), {
      commit_sha: 'packaged-sha',
      dirty: false,
      workspace_dirty: false,
      dirty_scope: DESKTOP_RUNTIME_DIRTY_SCOPE,
      source: 'packaged_build_metadata'
    });
    const env = {};
    applyDesktopBuildIdentityDefaults(env, options);
    assert.equal(env.DONNA_BUILD_COMMIT_SHA, 'packaged-sha');
    assert.equal(env.DONNA_BUILD_DIRTY, 'false');
    assert.equal(env.DONNA_RUNTIME_BUILD_DIRTY, 'false');

    const explicit = {
      DONNA_BUILD_COMMIT_SHA: 'launch-sha',
      DONNA_BUILD_DIRTY: 'true',
      DONNA_RUNTIME_BUILD_DIRTY: 'true'
    };
    applyDesktopBuildIdentityDefaults(explicit, options);
    assert.deepEqual(explicit, {
      DONNA_BUILD_COMMIT_SHA: 'launch-sha',
      DONNA_BUILD_DIRTY: 'true',
      DONNA_RUNTIME_BUILD_DIRTY: 'true'
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
