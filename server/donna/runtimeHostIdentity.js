// Deployment coordinates are operational identity, never a rollout flag.
// Read only server environment metadata; never accept a request's host claims.
import { createHash } from 'node:crypto';

export const CLOUD_RUNTIME_HOST = 'vercel';
export const CLOUD_PILOT_CAPABILITY_MANIFEST = 'fi-cloud-pilot.v1';
export const DESKTOP_HOST_ID = 'desktop-local';
const clean = value => String(value ?? '').trim();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const endpoint = value => {
  try {
    const url = new URL(value);
    return { protocol: url.protocol, hostname: url.hostname, port: url.port, pathname: url.pathname, username: url.username };
  } catch { return null; }
};

export const resolveRuntimeHostIdentity = (env = process.env) => {
  const cloud = clean(env.VERCEL) === '1' || Boolean(clean(env.VERCEL_PROJECT_ID) || clean(env.VERCEL_ENV));
  if (!cloud) return { runtime_host: 'desktop', host_id: DESKTOP_HOST_ID, reason: null };
  if (clean(env.DONNA_DESKTOP_BLOB_DIR)) {
    return { runtime_host: CLOUD_RUNTIME_HOST, host_id: null, reason: 'cloud_desktop_identity_conflict' };
  }
  const project = clean(env.VERCEL_PROJECT_ID);
  const environment = clean(env.VERCEL_ENV);
  const valid = Boolean(project) && ['production', 'preview', 'development'].includes(environment);
  const database = endpoint(env.DATABASE_URL);
  const storage = endpoint(env.SUPABASE_URL || env.VITE_SUPABASE_URL);
  const generation = {
    deployment_id: clean(env.VERCEL_DEPLOYMENT_ID) || null,
    source_commit: clean(env.VERCEL_GIT_COMMIT_SHA) || null,
    database_target: database ? digest(database) : null,
    storage_target: storage ? digest({ endpoint: storage, bucket: clean(env.DONNA_EVIDENCE_BUCKET || env.SUPABASE_EVIDENCE_BUCKET) || 'donna-evidence' }) : null,
    worker_target: digest({ app_id: clean(env.INNGEST_APP_ID) || 'donna-firm', environment })
  };
  return {
    runtime_host: CLOUD_RUNTIME_HOST,
    host_id: valid ? `vercel:${digest({ project, environment })}` : null,
    reason: !valid ? 'cloud_host_identity_missing' : Object.values(generation).some(value => !value) ? 'cloud_host_generation_missing' : null,
    generation,
    generation_digest: digest(generation)
  };
};

// The public deploy-vintage receipt (/api/donna/firms/health) and the
// token-gated diagnostics block read the SAME coordinates from here: the
// commit alone cannot say WHICH repository, branch or deployment produced
// the running build (2026-09-21: production reported a commit main had left
// hours earlier while `vercel ls` named a commit this repo never had). Vercel
// injects every field below on both git-integration and CLI deploys; they
// are operational identity, never secrets — keep this list to coordinates.
export const resolveDeploymentReceipt = (env = process.env) => ({
  commit_sha: clean(env.VERCEL_GIT_COMMIT_SHA).slice(0, 12) || null,
  vercel_env: clean(env.VERCEL_ENV) || null,
  deployment_id: clean(env.VERCEL_DEPLOYMENT_ID) || null,
  deployment_url: clean(env.VERCEL_URL) || null,
  git_provider: clean(env.VERCEL_GIT_PROVIDER) || null,
  git_repo: clean(env.VERCEL_GIT_REPO_OWNER) && clean(env.VERCEL_GIT_REPO_SLUG)
    ? `${clean(env.VERCEL_GIT_REPO_OWNER)}/${clean(env.VERCEL_GIT_REPO_SLUG)}`
    : null,
  git_ref: clean(env.VERCEL_GIT_COMMIT_REF) || null
});

export const cloudCertificateIdentityMatches = (certificate, identity) =>
  identity?.runtime_host === CLOUD_RUNTIME_HOST
  && !identity.reason
  && certificate?.runtime_host === CLOUD_RUNTIME_HOST
  && certificate?.host_identity?.host_id === identity.host_id
  && certificate?.host_identity?.generation_digest === identity.generation_digest;
