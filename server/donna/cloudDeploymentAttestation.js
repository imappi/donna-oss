import { createPublicKey, verify } from 'node:crypto';
import { hostDigest, canonicalHostJson } from './hostCertificateA.js';

export const CLOUD_ATTESTATION_VERSION = 'donna.cloud-deployment-attestation.v1';
export const CLOUD_ATTESTATION_KEY = '__host_certificate_a__/deployment-attestation.json';
// One artifact per deployment, so attesting a staged build before it is
// promoted never voids the deployment still serving production (2026-09-23:
// the single slot above made every merge a window with no valid attestation).
// The slot above stays readable for artifacts minted by hand (the runbook's
// fallback); the verifier binds the deployment id either way.
export const cloudAttestationKeyFor = deploymentId => {
  if (!/^dpl_[A-Za-z0-9]+$/.test(String(deploymentId || ''))) return null;
  return `__host_certificate_a__/deployments/${deploymentId}.json`;
};
export const CLOUD_ATTESTATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const attestationBytes = payload => Buffer.from(canonicalHostJson(payload));

// Only the operator CLI may mint this artifact, after its own authenticated
// platform request. The runtime holds the public verification key, never the
// signing key or a Vercel API credential. No status/PASS field is consumed.
export const verifyCloudDeploymentAttestation = ({ artifact, identity, env = process.env, observedAt }) => {
  const refuse = reason => ({ id: 'source_build', status: 'INCOMPLETE', detail: { reason,
    commit_sha: identity?.generation?.source_commit || null, dirty: null, dirty_scope: 'vercel-deployment' } });
  try {
    if (identity?.reason || !identity?.host_id) return refuse('cloud_host_identity_unresolved');
    if (!env.DONNA_HOST_ATTESTATION_PUBLIC_KEY || !(env.VERCEL_ORG_ID || env.DONNA_HOST_ATTESTATION_TEAM_ID)) return refuse('cloud_attestation_verifier_missing');
    const { payload, signature } = artifact || {};
    const key = createPublicKey(env.DONNA_HOST_ATTESTATION_PUBLIC_KEY.replace(/\\n/g, '\n'));
    if (key.asymmetricKeyType !== 'ed25519' || !verify(null, attestationBytes(payload), key, Buffer.from(signature || '', 'base64'))) return refuse('cloud_attestation_signature_invalid');
    const now = Date.parse(observedAt), issued = Date.parse(payload.issued_at), expires = Date.parse(payload.expires_at);
    if (![now, issued, expires].every(Number.isFinite) || issued > now || expires <= now
      || expires - issued > CLOUD_ATTESTATION_MAX_AGE_MS || expires <= issued) return refuse('cloud_attestation_expired');
    if (payload.version !== CLOUD_ATTESTATION_VERSION || payload.platform !== 'vercel'
      || payload.platform_state !== 'READY' || payload.deployment_id !== identity.generation.deployment_id
      || payload.source_commit !== identity.generation.source_commit || payload.project_id !== env.VERCEL_PROJECT_ID
      || payload.environment !== env.VERCEL_ENV || payload.team_id !== (env.VERCEL_ORG_ID || env.DONNA_HOST_ATTESTATION_TEAM_ID) || !payload.platform_response_digest) return refuse('cloud_attestation_generation_mismatch');
    return { id: 'source_build', status: 'PASS', detail: { host_id: identity.host_id,
      generation_digest: identity.generation_digest, commit_sha: payload.source_commit,
      dirty: false, dirty_scope: 'vercel-deployment', deployment_id: payload.deployment_id,
      attestation_digest: hostDigest(artifact), verifier_digest: hostDigest(key.export({ type: 'spki', format: 'pem' })),
      platform_response_digest: payload.platform_response_digest, expires_at: payload.expires_at } };
  } catch { return refuse('cloud_attestation_invalid'); }
};
