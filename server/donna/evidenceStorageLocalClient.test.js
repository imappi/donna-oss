// storeLocalEvidenceBytes single-connection contract.
//
// The local blob writer's index insert must run on the CALLER'S database
// client when one is passed: the route handler already holds a pooled
// connection for the readiness-admission transaction, and going back to the
// pool for a second connection mid-hold is the nested acquisition that
// deadlocked the desktop runtime on the 2026-08-31 multi-file drop (every
// upload frozen at "Uploading 0%"). These tests run with NO DATABASE_URL on
// purpose — if the writer ever reaches for the pool despite being handed a
// client, it throws FIRM_DB_NOT_CONFIGURED and the first test fails.
//
// node --test server/donna/evidenceStorageLocalClient.test.js

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { storeLocalEvidenceBytes } from './evidenceStorage.js';

const ENV_KEYS = ['DONNA_DESKTOP_BLOB_DIR', 'DATABASE_URL'];

const withLocalMode = async (run) => {
  const prior = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const blobDir = await mkdtemp(path.join(os.tmpdir(), 'donna-local-evidence-client-'));
  process.env.DONNA_DESKTOP_BLOB_DIR = blobDir;
  delete process.env.DATABASE_URL;
  try {
    await run({ blobDir });
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(blobDir, { recursive: true, force: true });
  }
};

test('a passed client carries the index insert — the pool is never touched', async () => {
  await withLocalMode(async ({ blobDir }) => {
    const queries = [];
    const client = {
      query: async (text, params) => {
        queries.push({ text: String(text), params });
        return { rows: [] };
      }
    };
    const bytes = Buffer.from('local-evidence-bytes-through-held-client');
    const stored = await storeLocalEvidenceBytes({
      bucket: 'donna-evidence',
      key: 'client-a/evidence/held-client.pdf',
      bytes,
      contentType: 'application/pdf',
      client
    });
    assert.equal(stored.byte_length, bytes.length);
    assert.ok(stored.content_hash);
    const insert = queries.find((entry) => entry.text.includes('local_evidence_objects'));
    assert.ok(insert, 'blob index insert ran on the caller-held client');
    assert.equal(insert.params[0], 'donna-evidence');
    assert.equal(insert.params[1], 'client-a/evidence/held-client.pdf');
    // The bytes really landed in the content-addressed store
    // (<root>/sha256/<first-2>/<hash>.bin — localBlobStore.js layout).
    const blobPath = path.join(
      blobDir,
      'sha256',
      stored.content_hash.slice(0, 2),
      `${stored.content_hash}.bin`
    );
    const onDisk = await readFile(blobPath).catch(() => null);
    assert.ok(onDisk && onDisk.equals(bytes), `blob file exists at ${blobPath}`);
  });
});

test('without a client the standalone fallback still reaches for the pool', async () => {
  await withLocalMode(async () => {
    // No DATABASE_URL → the pool shim must fail loudly. This pins that the
    // fallback path still exists for standalone callers (host certificate
    // drill) rather than silently skipping the index write.
    await assert.rejects(
      storeLocalEvidenceBytes({
        bucket: 'donna-evidence',
        key: 'client-a/evidence/pool-fallback.pdf',
        bytes: Buffer.from('fallback-path-bytes'),
        contentType: 'application/pdf'
      }),
      (error) => error?.code === 'FIRM_DB_NOT_CONFIGURED'
    );
  });
});
