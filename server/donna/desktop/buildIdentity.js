// Build identity supplied to live Host A observations. Source checkouts derive
// it from git; packaged apps read the immutable file produced immediately
// before electron-builder runs. Neither path guesses that an unknown build is
// clean — Host A reports INCOMPLETE instead.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DESKTOP_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const DESKTOP_BUILD_IDENTITY_PATH = path.join(DESKTOP_REPO_ROOT, 'desktop', 'build-identity.json');
export const DESKTOP_RUNTIME_DIRTY_SCOPE = 'desktop-accounting-runtime.v1';

// Host A protects the accounting runtime, not the whole developer workspace.
// Renderer source is served/bundled separately and every consequential request
// still crosses the certified server-side admission fences. Keep this list
// explicit: adding another load-bearing runtime root must be a reviewed change.
export const DESKTOP_RUNTIME_IDENTITY_PATHS = Object.freeze([
  'data/worlds/admitted-entity-profiles.json',
  'data/worlds/policy',
  'db/migrations',
  'desktop/main.mjs',
  'desktop/package.json',
  'desktop/preload.cjs',
  'desktop/runtime.mjs',
  'packs',
  'server'
]);

const runGit = (args, rootDir) => execFileSync('git', args, {
  cwd: rootDir,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore']
}).trim();

export const resolveDesktopBuildIdentity = ({
  rootDir = DESKTOP_REPO_ROOT,
  metadataPath = DESKTOP_BUILD_IDENTITY_PATH,
  git = runGit
} = {}) => {
  try {
    const workspaceDirty = Boolean(git(['status', '--porcelain', '--untracked-files=no'], rootDir));
    const runtimeDirty = Boolean(git([
      'status', '--porcelain', '--untracked-files=no', '--', ...DESKTOP_RUNTIME_IDENTITY_PATHS
    ], rootDir));
    return {
      commit_sha: git(['rev-parse', 'HEAD'], rootDir),
      dirty: runtimeDirty,
      workspace_dirty: workspaceDirty,
      dirty_scope: DESKTOP_RUNTIME_DIRTY_SCOPE,
      source: 'git_checkout'
    };
  } catch {
    try {
      const stored = JSON.parse(readFileSync(metadataPath, 'utf8'));
      if (typeof stored.commit_sha === 'string' && typeof stored.dirty === 'boolean') {
        const runtimeDirty = typeof stored.runtime_dirty === 'boolean' ? stored.runtime_dirty : stored.dirty;
        return {
          commit_sha: stored.commit_sha,
          dirty: runtimeDirty,
          workspace_dirty: stored.dirty,
          dirty_scope: DESKTOP_RUNTIME_DIRTY_SCOPE,
          source: 'packaged_build_metadata'
        };
      }
    } catch { /* Host A will report the missing identity explicitly. */ }
    return {
      commit_sha: null,
      dirty: null,
      workspace_dirty: null,
      dirty_scope: DESKTOP_RUNTIME_DIRTY_SCOPE,
      source: 'unavailable'
    };
  }
};

export const applyDesktopBuildIdentityDefaults = (env = process.env, options = {}) => {
  if ((env.DONNA_BUILD_COMMIT_SHA || env.GITHUB_SHA || env.VERCEL_GIT_COMMIT_SHA)
      && env.DONNA_BUILD_DIRTY && env.DONNA_RUNTIME_BUILD_DIRTY) return resolveDesktopBuildIdentity(options);
  const identity = resolveDesktopBuildIdentity(options);
  if (!env.DONNA_BUILD_COMMIT_SHA && !env.GITHUB_SHA && !env.VERCEL_GIT_COMMIT_SHA && identity.commit_sha) {
    env.DONNA_BUILD_COMMIT_SHA = identity.commit_sha;
  }
  if (!env.DONNA_BUILD_DIRTY && identity.workspace_dirty !== null) {
    env.DONNA_BUILD_DIRTY = identity.workspace_dirty ? 'true' : 'false';
  }
  if (!env.DONNA_RUNTIME_BUILD_DIRTY && identity.dirty !== null) {
    env.DONNA_RUNTIME_BUILD_DIRTY = identity.dirty ? 'true' : 'false';
  }
  return identity;
};
