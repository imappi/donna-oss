// Vercel build entry point.
//
// Runs the DB migration step on production deploys, then builds the
// frontend bundle. Preview / development deploys skip the migration —
// running a feature-branch's migrations against the shared production
// DB before the PR merges would corrupt the schema for everyone else.
//
// Configured via package.json's `vercel-build` script; Vercel runs
// that instead of `build` when present. VERCEL_ENV is set by Vercel
// automatically: 'production' | 'preview' | 'development'.

import { spawnSync } from 'node:child_process';

const env = process.env.VERCEL_ENV || 'development';
const isProduction = env === 'production';

const run = (cmd, args) => {
  const result = spawnSync(cmd, args, { stdio: 'inherit', env: process.env });
  if (result.status !== 0) {
    console.error(`[vercel-build] '${cmd} ${args.join(' ')}' exited with code ${result.status}`);
    process.exit(result.status || 1);
  }
};

if (isProduction) {
  console.log('[vercel-build] VERCEL_ENV=production — running DB migrations before build');
  run('npm', ['run', 'db:migrate']);
} else {
  console.log(`[vercel-build] VERCEL_ENV=${env} — skipping DB migrations (production-only)`);
}

console.log('[vercel-build] building frontend bundle');
run('npm', ['run', 'build']);
