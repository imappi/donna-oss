// MCP endpoint handshake file — unit tests.
//
// Load-bearing properties: owner-only mode on every write (0600, enforced
// with chmod because writeFileSync's mode is create-only), required inputs
// refused, removal best-effort (ENOENT silent, other errors logged not
// thrown — quit must not wedge).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mcpEndpointFilePath,
  writeMcpEndpointFile,
  removeMcpEndpointFile
} from './mcpEndpointFile.mjs';

const fakeFs = () => {
  const calls = { mkdir: [], write: [], chmod: [], unlink: [] };
  return {
    calls,
    mkdirSync: (dir, opts) => calls.mkdir.push({ dir, opts }),
    writeFileSync: (file, data, opts) => calls.write.push({ file, data, opts }),
    chmodSync: (file, mode) => calls.chmod.push({ file, mode }),
    unlinkSync: (file) => calls.unlink.push({ file })
  };
};

test('writeMcpEndpointFile: writes socket+token under runtime/, 0600 both at create and on overwrite', () => {
  const fsImpl = fakeFs();
  const filePath = writeMcpEndpointFile({
    dataDir: '/data/Donna',
    socketPath: '/data/Donna/runtime/sockets/api.sock',
    token: 'per-boot-token',
    fsImpl
  });
  assert.equal(filePath, mcpEndpointFilePath('/data/Donna'));
  assert.match(filePath, /runtime[/\\]mcp-endpoint\.json$/);
  assert.equal(fsImpl.calls.write[0].opts.mode, 0o600);
  assert.equal(fsImpl.calls.chmod[0].mode, 0o600);
  const written = JSON.parse(fsImpl.calls.write[0].data);
  assert.equal(written.socket_path, '/data/Donna/runtime/sockets/api.sock');
  assert.equal(written.token, 'per-boot-token');
  assert.equal(written.api_prefix, '/api/donna/mcp');
});

test('writeMcpEndpointFile: refuses missing inputs', () => {
  assert.throws(() => writeMcpEndpointFile({ dataDir: '/d', socketPath: '/s', fsImpl: fakeFs() }), /requires/);
  assert.throws(() => writeMcpEndpointFile({ socketPath: '/s', token: 't', fsImpl: fakeFs() }), /requires/);
});

test('removeMcpEndpointFile: ENOENT is silent, other errors are logged not thrown', () => {
  const quiet = { warn: () => {} };
  const enoent = {
    unlinkSync: () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); }
  };
  assert.equal(removeMcpEndpointFile({ dataDir: '/d', fsImpl: enoent, logger: quiet }), false);

  const warned = [];
  const eperm = {
    unlinkSync: () => { throw Object.assign(new Error('nope'), { code: 'EPERM' }); }
  };
  assert.equal(
    removeMcpEndpointFile({ dataDir: '/d', fsImpl: eperm, logger: { warn: (line) => warned.push(line) } }),
    false
  );
  assert.equal(warned.length, 1);

  const ok = fakeFs();
  assert.equal(removeMcpEndpointFile({ dataDir: '/d', fsImpl: ok }), true);
  assert.equal(ok.calls.unlink.length, 1);
});
