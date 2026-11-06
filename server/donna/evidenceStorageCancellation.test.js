import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createEvidenceSignedUploadUrl, fetchEvidenceObjectBytes, listEvidenceObjects, deleteEvidenceObjects } from './evidenceStorage.js';

test('cloud storage adapters cancel actual headers and bodies without swallowing abort as empty success', async () => {
  const env = { DONNA_DESKTOP_BLOB_DIR: '', SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-cancellation-key' };
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    for (const operation of [createEvidenceSignedUploadUrl, fetchEvidenceObjectBytes, listEvidenceObjects, deleteEvidenceObjects]) {
      for (const phase of ['headers', 'body']) {
        const controller = new AbortController();
        const reason = Object.assign(new Error('Synthetic deadline'), { code: 'PROBE_TEST_DEADLINE' });
        let timer, onClosed;
        const closed = new Promise(resolve => { onClosed = resolve; });
        const server = createServer((req, res) => {
          req.resume();
          res.once('close', onClosed);
          if (phase === 'body') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.write('[');
          }
          timer = setTimeout(() => controller.abort(reason), 30);
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        process.env.SUPABASE_URL = `http://127.0.0.1:${server.address().port}`;
        try {
          await assert.rejects(operation({ bucket: 'isolated', key: 'probe', keys: ['probe'], signal: controller.signal }),
            error => error === reason || error.name === 'AbortError', `${operation.name}: ${phase}`);
          await closed;
        } finally {
          clearTimeout(timer);
          server.closeAllConnections();
          await new Promise(resolve => server.close(resolve));
        }
      }
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
