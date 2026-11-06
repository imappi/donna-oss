import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LOG_ROTATE_BYTES, createFileLog, createLineBuffer, rotateLogFile } from './fileLog.mjs';

const tmpDir = () => mkdtempSync(path.join(os.tmpdir(), 'donna-filelog-'));
const fixedNow = () => new Date('2026-09-11T10:00:00.000Z');

test('line buffer emits complete lines and holds the partial tail until flush', () => {
  const lines = [];
  const buffer = createLineBuffer((line) => lines.push(line));
  buffer.push('alpha\nbe');
  buffer.push(Buffer.from('ta\ngam'));
  assert.deepEqual(lines, ['alpha', 'beta']);
  buffer.flush();
  assert.deepEqual(lines, ['alpha', 'beta', 'gam']);
});

test('writes timestamped, source-labelled lines and creates the logs dir', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'logs', 'desktop.log');
    const log = createFileLog({ file, now: fixedNow });
    assert.equal(log.active, true);
    log.mirror('main', '[desktop-main] data dir: /x\n[desktop-main] applying migrations…\n');
    log.mirror('runtime', '[runtime-server] model lanes: openai LIT');
    log.close();
    const text = readFileSync(file, 'utf8');
    assert.equal(text, [
      '2026-09-11T10:00:00.000Z main [desktop-main] data dir: /x',
      '2026-09-11T10:00:00.000Z main [desktop-main] applying migrations…',
      '2026-09-11T10:00:00.000Z runtime [runtime-server] model lanes: openai LIT',
      ''
    ].join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the log file and its directory are owner-only, even when the file already existed', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'logs', 'desktop.log');
    const fresh = createFileLog({ file, now: fixedNow });
    fresh.mirror('main', 'one\n');
    fresh.close();
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
    // A file left world-readable by an older build is tightened on open.
    chmodSync(file, 0o644);
    const again = createFileLog({ file, now: fixedNow });
    again.close();
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rotates an oversized log to .1 on open and starts fresh', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'desktop.log');
    writeFileSync(file, 'x'.repeat(64));
    const result = rotateLogFile({ file, maxBytes: 32 });
    assert.equal(result.rotated, true);
    assert.equal(existsSync(`${file}.1`), true);
    assert.equal(existsSync(file), false);
    // A second rotation replaces the previous .1 — never a growing chain.
    writeFileSync(file, 'y'.repeat(64));
    rotateLogFile({ file, maxBytes: 32 });
    assert.equal(readFileSync(`${file}.1`, 'utf8'), 'y'.repeat(64));
    // Under the threshold: untouched.
    writeFileSync(file, 'z');
    assert.deepEqual(rotateLogFile({ file, maxBytes: 32 }), { rotated: false, size: 1 });
    // Missing file: a no-op, not an error.
    assert.deepEqual(rotateLogFile({ file: path.join(dir, 'absent.log') }), { rotated: false, size: 0 });
    assert.equal(LOG_ROTATE_BYTES, 5 * 1024 * 1024);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a log that cannot be opened or written never throws into the caller', () => {
  const fsImpl = {
    mkdirSync: () => {},
    statSync: () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; },
    renameSync: () => {},
    openSync: () => { throw new Error('read-only volume'); },
    writeSync: () => {},
    closeSync: () => {}
  };
  const log = createFileLog({ file: '/nowhere/desktop.log', fsImpl, now: fixedNow });
  assert.equal(log.active, false);
  assert.match(log.failure, /read-only volume/);
  assert.doesNotThrow(() => log.mirror('main', 'still fine\n'));

  // Opens, then the disk fills: the failure is recorded, later writes are
  // dropped, and nothing propagates.
  let writes = 0;
  const flaky = {
    ...fsImpl,
    openSync: () => 7,
    writeSync: () => { writes += 1; if (writes > 1) throw new Error('ENOSPC'); }
  };
  const log2 = createFileLog({ file: '/somewhere/desktop.log', fsImpl: flaky, now: fixedNow });
  assert.equal(log2.active, true);
  log2.mirror('main', 'one\ntwo\nthree\n');
  assert.equal(log2.active, false);
  assert.match(log2.failure, /ENOSPC/);
  assert.doesNotThrow(() => log2.mirror('main', 'four\n'));
  assert.doesNotThrow(() => log2.close());
});

test('tees the console streams into the file and forwards a piped child once', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'desktop.log');
    const log = createFileLog({ file, now: fixedNow });
    const console = [];
    const makeStream = (name) => {
      const stream = new EventEmitter();
      stream.write = (chunk) => { console.push(`${name}:${chunk}`); return true; };
      return stream;
    };
    const proc = { stdout: makeStream('out'), stderr: makeStream('err') };
    const restore = log.captureProcessOutput({ proc });

    proc.stdout.write('[desktop-main] up\n');
    proc.stderr.write('[desktop-main] boot failed: x\n');
    // A console EPIPE must be swallowed, not thrown.
    assert.doesNotThrow(() => proc.stdout.emit('error', new Error('EPIPE')));

    const child = { stdout: new EventEmitter(), stderr: new EventEmitter() };
    log.forwardChild(child, { source: 'runtime', proc });
    child.stdout.emit('data', Buffer.from('[runtime-server] ready\n'));
    child.stderr.emit('data', 'warn: something\n');
    assert.doesNotThrow(() => child.stdout.emit('error', new Error('closed')));

    restore();
    proc.stdout.write('after restore\n');
    log.close();

    // Console saw everything exactly once, in order.
    assert.deepEqual(console, [
      'out:[desktop-main] up\n',
      'err:[desktop-main] boot failed: x\n',
      'out:[runtime-server] ready\n',
      'err:warn: something\n',
      'out:after restore\n'
    ]);
    // The file saw the tee'd lines with their own source labels — and NOT the
    // post-restore line.
    const text = readFileSync(file, 'utf8');
    assert.equal(text, [
      '2026-09-11T10:00:00.000Z main [desktop-main] up',
      '2026-09-11T10:00:00.000Z main:err [desktop-main] boot failed: x',
      '2026-09-11T10:00:00.000Z runtime [runtime-server] ready',
      '2026-09-11T10:00:00.000Z runtime:err warn: something',
      ''
    ].join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
