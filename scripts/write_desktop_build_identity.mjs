#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DESKTOP_RUNTIME_IDENTITY_PATHS } from '../server/donna/desktop/buildIdentity.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (args) => execFileSync('git', args, {
  cwd: ROOT,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit']
}).trim();
const identity = {
  version: 'donna.desktop-build-identity.v2',
  commit_sha: git(['rev-parse', 'HEAD']),
  dirty: Boolean(git(['status', '--porcelain', '--untracked-files=no'])),
  runtime_dirty: Boolean(git([
    'status', '--porcelain', '--untracked-files=no', '--', ...DESKTOP_RUNTIME_IDENTITY_PATHS
  ]))
};
await writeFile(
  path.join(ROOT, 'desktop', 'build-identity.json'),
  `${JSON.stringify(identity, null, 2)}\n`,
  'utf8'
);
console.log(`Desktop build identity: ${identity.commit_sha.slice(0, 12)}${identity.dirty ? ' (dirty)' : ''}`);
