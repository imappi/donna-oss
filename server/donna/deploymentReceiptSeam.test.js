// The public deploy-vintage receipt must name WHERE the running build came
// from, not only which commit: on 2026-09-21 production reported a commit that
// `main` had left hours earlier while `vercel ls` showed a commit this repo
// never contained, and the receipt could not say whether that was a
// git-integration build, a CLI push from another checkout, or a stale
// promotion. This drives the real router entry (no bearer, as the public
// exemption allows) and pins the coordinates, and pins that the receipt stays
// coordinates-only (no key values).
import test from 'node:test';
import assert from 'node:assert/strict';

import { requestDonnaApi } from './testSupport/apiSeamHarness.js';
import { resolveDeploymentReceipt } from './runtimeHostIdentity.js';

const SEAM_KEY = 'sk-seam-only-never-in-a-receipt';
const VERCEL_KEYS = [
  'VERCEL_GIT_COMMIT_SHA', 'VERCEL_ENV', 'VERCEL_DEPLOYMENT_ID', 'VERCEL_URL',
  'VERCEL_GIT_PROVIDER', 'VERCEL_GIT_REPO_OWNER', 'VERCEL_GIT_REPO_SLUG', 'VERCEL_GIT_COMMIT_REF',
  'OPENAI_API_KEY'
];
const prior = Object.fromEntries(VERCEL_KEYS.map(key => [key, process.env[key]]));
const restore = () => {
  for (const key of VERCEL_KEYS) {
    if (prior[key] === undefined) delete process.env[key];
    else process.env[key] = prior[key];
  }
};

await test('public /health names the deployment, repository and branch behind the commit', async () => {
  Object.assign(process.env, {
    VERCEL_GIT_COMMIT_SHA: 'e3e1562ae7e8993fabdc79805b4aa44d7b046f6a',
    VERCEL_ENV: 'production',
    VERCEL_DEPLOYMENT_ID: 'dpl_ExampleDeployment00000000000',
    VERCEL_URL: 'preview-abc123.books-app.example',
    VERCEL_GIT_PROVIDER: 'github',
    VERCEL_GIT_REPO_OWNER: 'example-owner',
    VERCEL_GIT_REPO_SLUG: 'donna',
    VERCEL_GIT_COMMIT_REF: 'main',
    OPENAI_API_KEY: SEAM_KEY
  });
  try {
    const response = await requestDonnaApi({ url: '/api/donna/firms/health' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json.commit_sha, 'e3e1562ae7e8');
    assert.equal(response.json.vercel_env, 'production');
    assert.equal(response.json.deployment_id, 'dpl_ExampleDeployment00000000000');
    assert.equal(response.json.deployment_url, 'preview-abc123.books-app.example');
    assert.equal(response.json.git_provider, 'github');
    assert.equal(response.json.git_repo, 'example-owner/donna');
    assert.equal(response.json.git_ref, 'main');
    assert.deepEqual(Object.keys(response.json).sort(), [
      'commit_sha', 'database_configured', 'deployment_id', 'deployment_url',
      'git_provider', 'git_ref', 'git_repo', 'model_lanes', 'provider_replay', 'vercel_env'
    ]);
    // No replay demo on this host: no stored replay record, no replay lane.
    assert.equal(response.json.provider_replay, null);
    assert.equal(response.json.model_lanes.replay, false);
    // Coordinates only: a configured lane shows as presence, never as its value.
    const serialized = JSON.stringify(response.json);
    assert.ok(!serialized.includes(SEAM_KEY), 'receipt must carry lane presence, never a key value');
    assert.equal(typeof response.json.model_lanes.openai, 'boolean');
  } finally {
    restore();
  }
});

await test('a build without git coordinates reports nulls, never a guessed repository', () => {
  const receipt = resolveDeploymentReceipt({
    VERCEL_GIT_COMMIT_SHA: '52b3b4f418da00', VERCEL_ENV: 'production',
    VERCEL_DEPLOYMENT_ID: 'dpl_1', VERCEL_GIT_REPO_OWNER: 'example-owner'
  });
  assert.deepEqual(receipt, {
    commit_sha: '52b3b4f418da', vercel_env: 'production', deployment_id: 'dpl_1',
    deployment_url: null, git_provider: null, git_repo: null, git_ref: null
  });
  assert.deepEqual(resolveDeploymentReceipt({}), {
    commit_sha: null, vercel_env: null, deployment_id: null, deployment_url: null,
    git_provider: null, git_repo: null, git_ref: null
  });
});
