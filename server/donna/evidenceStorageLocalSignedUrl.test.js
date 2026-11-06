// The local signed evidence URL is origin-relative by contract.
//
// The appliance runtime listens on a private Unix socket; the SPA reaches it
// through whichever Donna origin served the page — `donna://app` in the
// Electron renderer, the loopback portal-preview server in the system
// browser — and each proxies `/api/` to the socket with the access token.
// Before 2026-09-04 the runtime was handed DONNA_DESKTOP_BASE_URL='donna://app'
// and minted ABSOLUTE donna:// URLs, which Safari cannot fetch from the
// preview's http origin: every file reply and evidence view in the client
// portal preview failed with WebKit's "Load failed" before a request was
// made. These tests run with NO DATABASE_URL on purpose — signing is pure
// HMAC over the boot access token — and they keep the old boot base in the
// environment to prove it is no longer consulted.
//
// node --test server/donna/evidenceStorageLocalSignedUrl.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEvidenceSignedUploadUrl,
  createEvidenceSignedUrl,
  verifyLocalEvidenceAccess
} from './evidenceStorage.js';

// The literal, not the module's constant: on the pre-fix tree this file must
// fail on the ASSERTION (with the donna:// url in the message), not on an import.
const LOCAL_EVIDENCE_PATH = '/api/donna/evidence-local';

const ENV_KEYS = [
  'DONNA_DESKTOP_BLOB_DIR',
  'DONNA_DESKTOP_BASE_URL',
  'DONNA_DESKTOP_PORT',
  'DONNA_ACCESS_TOKEN',
  'DATABASE_URL'
];

// The two origins the SPA is actually served from on the appliance.
const SPA_ORIGINS = ['donna://app', 'http://127.0.0.1:53127'];

const originOf = (url) => (url.origin && url.origin !== 'null' ? url.origin : `${url.protocol}//${url.host}`);

const withApplianceEnv = async (run) => {
  const prior = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.DONNA_DESKTOP_BLOB_DIR = '/srv/appliance/documents';
  // The pre-fix boot value, deliberately left in place: it must not shape the URL.
  process.env.DONNA_DESKTOP_BASE_URL = 'donna://app';
  delete process.env.DONNA_DESKTOP_PORT;
  process.env.DONNA_ACCESS_TOKEN = 'per-boot-token';
  delete process.env.DATABASE_URL;
  try {
    await run();
  } finally {
    for (const key of ENV_KEYS) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
  }
};

const tokenOf = (signedUrl) => new URL(signedUrl, 'http://127.0.0.1').searchParams.get('token') || '';

test('a local signed UPLOAD url is an origin-relative path that resolves on whichever origin served the page', async () => {
  await withApplianceEnv(async () => {
    const signed = await createEvidenceSignedUploadUrl({
      bucket: 'donna-evidence',
      key: 'firm-1/client-1/evidence/probe.pdf',
      expiresIn: 60
    });
    assert.equal(signed.provider, 'local_blob');
    assert.ok(
      signed.signed_url.startsWith(`${LOCAL_EVIDENCE_PATH}?token=`),
      `expected an origin-relative signed url, got ${signed.signed_url}`
    );
    assert.doesNotMatch(signed.signed_url, /^[a-z][a-z0-9+.-]*:\/\//i, 'no scheme, no host');

    for (const origin of SPA_ORIGINS) {
      const resolved = new URL(signed.signed_url, origin);
      assert.equal(originOf(resolved), origin, `must stay on ${origin}`);
      assert.equal(resolved.pathname, LOCAL_EVIDENCE_PATH);
    }

    const token = tokenOf(signed.signed_url);
    const put = verifyLocalEvidenceAccess({ token, method: 'PUT' });
    assert.equal(put.enabled, true);
    assert.equal(put.claim?.bucket, 'donna-evidence');
    assert.equal(put.claim?.key, 'firm-1/client-1/evidence/probe.pdf');
    // Minted for PUT only — a GET with the same token is refused.
    assert.equal(verifyLocalEvidenceAccess({ token, method: 'GET' }).claim, null);
  });
});

test('a local signed DOWNLOAD url follows the same contract (evidence viewing in the preview)', async () => {
  await withApplianceEnv(async () => {
    const signedUrl = await createEvidenceSignedUrl({
      bucket: 'donna-evidence',
      key: 'firm-1/client-1/evidence/probe.pdf',
      expiresIn: 60
    });
    assert.equal(typeof signedUrl, 'string');
    assert.ok(signedUrl.startsWith(`${LOCAL_EVIDENCE_PATH}?token=`), signedUrl);
    for (const origin of SPA_ORIGINS) {
      assert.equal(originOf(new URL(signedUrl, origin)), origin);
    }
    const token = tokenOf(signedUrl);
    assert.equal(verifyLocalEvidenceAccess({ token, method: 'GET' }).claim?.key, 'firm-1/client-1/evidence/probe.pdf');
    assert.equal(verifyLocalEvidenceAccess({ token, method: 'PUT' }).claim, null);
  });
});

test('the pre-fix shape could not have been fetched from the preview origin', () => {
  // Documentation as an assertion: a donna:// url resolved against the http
  // preview origin keeps its own host, so the browser would have to open a
  // scheme it does not know. That is the "Load failed" the portal showed.
  const legacy = new URL('donna://app/api/donna/evidence-local?token=t', 'http://127.0.0.1:53127');
  assert.equal(`${legacy.protocol}//${legacy.host}`, 'donna://app');
});
