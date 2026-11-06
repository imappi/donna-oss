// File-backed shell log (2026-09-11, the Finnish internal-test DMG).
//
// main.mjs and the runtime utility process log to stdout/stderr only. In the
// dev shell that is the terminal; when the PACKAGED app is launched from
// Finder there is no terminal, so every boot line — data dir, bundled-PG
// initdb, migrations, the model-lane receipt ("openai LIT / anthropic DARK"),
// runtime restarts, the cold-start give-up — evaporated. A tester reporting
// "it did not start" had nothing to send except pg.log and the watchdog kill
// receipts. This module tees the shell's own output (and, via main's pipe
// forwarding, the runtime child's) into <dataDir>/logs/desktop.log so the
// failure report can carry the evidence.
//
// Rails:
// - Pure node, no Electron import (testable like apiProxy / runtimeWatchdog).
// - Never breaks the boot: every write is try/catch; a failing file simply
//   stops receiving lines (the console keeps working).
// - Never holds key material: nothing here decides WHAT is logged — the
//   provider-key seams already log key NAMES only, and this file mirrors the
//   console verbatim. Keep it that way: do not add redaction here as a
//   substitute for not logging secrets at the source.
// - Bounded: one rotation at LOG_ROTATE_BYTES on open (desktop.log →
//   desktop.log.1), so the folder never grows past two files of that size
//   plus one boot's worth.
// - Owner-only (0600 file, 0700 dir): consolidated from PR #2103 (2026-09-11).
// - Timestamped per LINE (ISO-8601 UTC) in the file only; the console keeps
//   the exact bytes it always had. Chunks are line-buffered per source so a
//   partial write never gets a stamp mid-line.

import fs from 'node:fs';
import path from 'node:path';

export const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
export const LOG_FILE_NAME = 'desktop.log';

// Rotate on open only — one rename, no size polling during the run.
export const rotateLogFile = ({ file, maxBytes = LOG_ROTATE_BYTES, fsImpl = fs } = {}) => {
  try {
    const size = fsImpl.statSync(file).size;
    if (size < maxBytes) return { rotated: false, size };
    fsImpl.renameSync(file, `${file}.1`);
    return { rotated: true, size };
  } catch (error) {
    if (error?.code === 'ENOENT') return { rotated: false, size: 0 };
    return { rotated: false, size: null, error: error?.message || String(error) };
  }
};

// Splits a stream of chunks into complete lines; the trailing partial line
// waits for the next chunk (or flush()).
export const createLineBuffer = (onLine) => {
  let pending = '';
  return {
    push: (chunk) => {
      pending += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      let index = pending.indexOf('\n');
      while (index !== -1) {
        onLine(pending.slice(0, index));
        pending = pending.slice(index + 1);
        index = pending.indexOf('\n');
      }
    },
    flush: () => {
      if (pending) onLine(pending);
      pending = '';
    }
  };
};

export const createFileLog = ({
  file,
  fsImpl = fs,
  maxBytes = LOG_ROTATE_BYTES,
  now = () => new Date()
} = {}) => {
  if (!file) throw new Error('createFileLog: file is required');
  let fd = null;
  let failed = null;
  const open = () => {
    try {
      // Owner-only, like the ciphertext key file next door: the log mirrors
      // the console verbatim, and a world-readable copy of every boot line
      // is more than another account on the Mac needs. openSync's mode only
      // applies on creation, so an existing file is tightened explicitly.
      fsImpl.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      rotateLogFile({ file, maxBytes, fsImpl });
      fd = fsImpl.openSync(file, 'a', 0o600);
      try { fsImpl.chmodSync?.(file, 0o600); } catch { /* best-effort on exotic volumes */ }
    } catch (error) {
      failed = error?.message || String(error);
      fd = null;
    }
  };
  open();

  const writeLine = (source, line) => {
    if (fd == null) return false;
    try {
      fsImpl.writeSync(fd, `${now().toISOString()} ${source} ${line}\n`);
      return true;
    } catch (error) {
      failed = error?.message || String(error);
      try { fsImpl.closeSync(fd); } catch { /* already gone */ }
      fd = null;
      return false;
    }
  };

  const buffers = new Map();
  const bufferFor = (source) => {
    if (!buffers.has(source)) buffers.set(source, createLineBuffer((line) => writeLine(source, line)));
    return buffers.get(source);
  };

  // Mirror a chunk destined for the console into the file under a source
  // label ('main', 'main:err', 'runtime', 'runtime:err', 'migrate', …).
  const mirror = (source, chunk) => {
    if (fd == null || chunk == null) return;
    try { bufferFor(source).push(chunk); } catch { /* never throw into a write path */ }
  };

  // Tee process.stdout / process.stderr. Returns a restore function. Also
  // swallows EPIPE on the console streams: a Finder launch has no reader on
  // the other end, and an unhandled stream error on stdout would take the
  // whole shell down for the sake of a log line.
  const originals = new Map(); // stream → its un-tee'd write
  const captureProcessOutput = ({ proc = process } = {}) => {
    const restore = [];
    for (const [name, source] of [['stdout', 'main'], ['stderr', 'main:err']]) {
      const stream = proc[name];
      if (!stream || typeof stream.write !== 'function') continue;
      const original = stream.write.bind(stream);
      originals.set(stream, original);
      stream.write = (chunk, ...rest) => {
        mirror(source, chunk);
        return original(chunk, ...rest);
      };
      if (typeof stream.on === 'function') stream.on('error', () => { /* EPIPE-class: keep running */ });
      restore.push(() => { stream.write = original; originals.delete(stream); });
    }
    return () => restore.forEach((fn) => fn());
  };

  // Forward a piped child's stdout/stderr to the console (which is tee'd) —
  // the child's lines reach the file through `mirror` with their own source
  // label, so runtime output is distinguishable from the shell's.
  const forwardChild = (child, { source = 'child', proc = process } = {}) => {
    const wire = (stream, label, target) => {
      if (!stream || typeof stream.on !== 'function') return;
      stream.on('data', (chunk) => {
        mirror(label, chunk);
        try {
          // Mirror already took the chunk; write to the console without a
          // second mirror pass (the tee would re-label it as 'main').
          const write = originals.get(target) || target?.write?.bind(target);
          if (typeof write === 'function') write(chunk);
        } catch { /* console gone — the file still has it */ }
      });
      stream.on('error', () => { /* child pipe closed — nothing to do */ });
    };
    wire(child?.stdout, source, proc.stdout);
    wire(child?.stderr, `${source}:err`, proc.stderr);
  };

  const close = () => {
    for (const buffer of buffers.values()) buffer.flush();
    if (fd != null) {
      try { fsImpl.closeSync(fd); } catch { /* best-effort */ }
      fd = null;
    }
  };

  return {
    path: file,
    get active() { return fd != null; },
    get failure() { return failed; },
    mirror,
    captureProcessOutput,
    forwardChild,
    close
  };
};
