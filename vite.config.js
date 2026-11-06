import { execSync } from 'node:child_process';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { createDonnaApiPlugin } from './server/donna/api.js';

// What the bundle was built FROM: branch @ short SHA, with a marker when the
// tree was dirty. The 2026-08-07 deploy-state ping-pong (see the CLAUDE.md
// rail) was a `git pull` landing on a parked Codex branch — the build was
// clean, the WHEN stamp was fresh, and the sidebar was still old, because
// nothing on screen said WHAT the bundle was built from. Best-effort: a
// build outside a git checkout (CI tarball) stamps 'unknown' rather than
// failing the build.
const describeBuildSource = () => {
  try {
    const run = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();
    const branch = run('git rev-parse --abbrev-ref HEAD');
    const sha = run('git rev-parse --short HEAD');
    const dirty = run('git status --porcelain') ? ' +local changes' : '';
    return `${branch} @ ${sha}${dirty}`;
  } catch {
    return 'unknown';
  }
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  if (!process.env.OPENAI_API_KEY && env.OPENAI_API_KEY) {
    process.env.OPENAI_API_KEY = env.OPENAI_API_KEY;
  }
  if (!process.env.OPENAI_MODEL && env.OPENAI_MODEL) {
    process.env.OPENAI_MODEL = env.OPENAI_MODEL;
  }
  if (!process.env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
  }
  if (!process.env.LOUIS_MODEL && env.LOUIS_MODEL) {
    process.env.LOUIS_MODEL = env.LOUIS_MODEL;
  }

  return {
    // The renderer-side build receipt, shown on Settings → About. The server
    // half has /firms/health commit_sha; the BUNDLE had no fingerprint at
    // all, which cost a day of "merged UI change doesn't show" (2026-08-07:
    // stale dist vs packaged app vs Electron cache were indistinguishable
    // on screen). Same rail as "the model id is part of the receipt".
    define: {
      __DONNA_UI_BUILD__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ') + 'Z'),
      __DONNA_UI_SOURCE__: JSON.stringify(describeBuildSource())
    },
    plugins: [react(), createDonnaApiPlugin()],
    server: {
      port: 5173,
      open: false
    }
  };
});
