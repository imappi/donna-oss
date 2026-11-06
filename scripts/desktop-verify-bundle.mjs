#!/usr/bin/env node
// desktop-verify-bundle — post-build acceptance checks for the packaged app
// (M0b). Run on the Mac against the built bundle BEFORE any DMG leaves the
// machine:
//
//   node scripts/desktop-verify-bundle.mjs --app "dist-desktop/mac-arm64/Donna.app"
//
// Checks (each prints PASS/FAIL; exit 1 on any FAIL):
//   1. codesign --verify --deep --strict on the whole bundle. In the
//      --unsigned lane this still runs: an ad-hoc seal that verifies is the
//      accepted state, "not signed at all" or a broken seal FAILS (damaged
//      package — distinct from merely unsigned/not notarized).
//   2. spctl --assess (Gatekeeper would run it) — needs notarization stapled;
//      SKIPped in the --unsigned lane (would always reject).
//   3. The PG payload exists, its manifest shas match what was staged, and
//      every payload Mach-O's otool -L closure stays inside the bundle or
//      /usr/lib//System (no Homebrew/Postgres.app/host references).
//   4. Relocation smoke: Resources/pg16/bin/pg_ctl --version runs FROM THE
//      BUNDLE PATH and reports the pinned major.
//
// The kill-test / restore / update drills are ON TOP of this (they need a
// running app + data dir): see the M0b handoff runbook.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { PG_MAJOR } from '../server/donna/desktop/pgSupervisor.js';
import { readCodeSignature } from './desktop-release-receipt.mjs';

const args = process.argv.slice(2);
const appFlag = args.indexOf('--app');
const APP = appFlag === -1 ? null : path.resolve(args[appFlag + 1]);
// --unsigned: the interim local-iteration lane (no Developer ID cert yet —
// Kari 2026-08-07, handoff §signing identity). Signature/Gatekeeper checks
// are replaced by a FULL manifest-sha pass (nothing re-signed the payload,
// so every file — Mach-O included — must match staging exactly). The other
// checks (closure containment, relocation smoke) run unchanged.
const UNSIGNED = args.includes('--unsigned');
if (!APP || !existsSync(APP)) {
  console.error('usage: node scripts/desktop-verify-bundle.mjs --app <path to Donna.app> [--unsigned]');
  process.exit(2);
}

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${String(error.message).split('\n').join('\n      ')}`);
  }
};

const payload = path.join(APP, 'Contents', 'Resources', 'pg16');

if (UNSIGNED) {
  // The unsigned lane has no Developer ID to verify against, but the seal
  // still has to be INTACT: electron-builder ad-hoc signs the app (an
  // unsigned arm64 executable would not launch at all), and a bundle
  // modified after that seal — a hand-patched .app, a stray file — makes
  // macOS report "damaged" on a quarantined copy, which no "Open Anyway"
  // step recovers. So: ad-hoc (or a real identity) that verifies = PASS,
  // "not signed at all" or a broken seal = FAIL. Consolidated 2026-09-11
  // (PR #2103's check, in #2102's lane).
  check('app code signature intact (ad-hoc accepted in the unsigned lane; "not signed" / broken seal FAIL)', () => {
    const verdict = readCodeSignature(APP);
    if (!verdict.ok) throw new Error(`${verdict.state}: ${verdict.detail}`);
    console.log(`      signature: ${verdict.state} — ${verdict.detail}`);
  });
  console.log('SKIP  Gatekeeper assessment (unsigned lane — not notarized, spctl would always reject; testers use Open Anyway)');
} else {
  check('bundle signature (codesign --verify --deep --strict)', () => {
    execFileSync('codesign', ['--verify', '--deep', '--strict', APP], { stdio: 'pipe' });
  });

  check('Gatekeeper assessment (spctl) — requires notarization', () => {
    execFileSync('spctl', ['--assess', '--type', 'execute', APP], { stdio: 'pipe' });
  });
}

check(`PG payload manifest present and shas intact${UNSIGNED ? ' (ALL files — unsigned, nothing may drift)' : ''}`, () => {
  const manifest = JSON.parse(readFileSync(path.join(payload, 'manifest.json'), 'utf8'));
  if (manifest.pg_major !== PG_MAJOR) throw new Error(`manifest pg_major ${manifest.pg_major} ≠ ${PG_MAJOR}`);
  let checked = 0;
  for (const file of manifest.files) {
    // Signing rewrites Mach-O signatures, so their shas legitimately drift
    // from staging; non-Mach-O files (share/, .sql, .bki) must be intact.
    // In the unsigned lane NOTHING re-signed the payload, so every file —
    // Mach-O included — must still match staging exactly.
    if (file.machO && !UNSIGNED) continue;
    const digest = createHash('sha256').update(readFileSync(path.join(payload, file.path))).digest('hex');
    if (digest !== file.sha256) throw new Error(`sha mismatch: ${file.path}`);
    checked += 1;
  }
  if (checked === 0) throw new Error('manifest listed no files to verify');
});

check('payload dylib closure stays inside the bundle (no dangling @-refs)', () => {
  const offenders = [];
  const isMachO = (file) => {
    try {
      if (lstatSync(file).isSymbolicLink()) return false;
      const magic = readFileSync(file).subarray(0, 4).toString('hex');
      return ['cffaedfe', 'cefaedfe', 'cafebabe', 'bebafeca'].includes(magic);
    } catch { return false; }
  };
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (isMachO(file)) {
        const deps = execFileSync('otool', ['-L', file], { encoding: 'utf8' })
          .split('\n').slice(1).map((l) => l.trim().split(' (')[0]).filter(Boolean);
        for (const dep of deps) {
          if (dep.startsWith('/usr/lib') || dep.startsWith('/System')) continue;
          if (dep.startsWith('@')) {
            // An @-reference may LOOK relocatable and still dangle — the
            // libicudata class the first bundled initdb hit (2026-08-07).
            // Resolve it (dyld semantics: @executable_path = the payload's
            // bin/) and require the target to exist inside the bundle.
            const resolved = dep.startsWith('@loader_path/')
              ? path.resolve(path.dirname(file), dep.slice('@loader_path/'.length))
              : dep.startsWith('@executable_path/')
                ? path.resolve(payload, 'bin', dep.slice('@executable_path/'.length))
                : null;
            if (resolved && !existsSync(resolved)) offenders.push(`${path.relative(APP, file)} → ${dep} (dangling)`);
            if (!resolved && !existsSync(path.join(payload, 'lib', path.basename(dep)))) {
              offenders.push(`${path.relative(APP, file)} → ${dep} (unresolvable @rpath-style reference)`);
            }
            continue;
          }
          offenders.push(`${path.relative(APP, file)} → ${dep}`);
        }
      }
    }
  };
  walk(payload);
  if (offenders.length) throw new Error(offenders.join('\n'));
});

check(`relocation smoke: bundled pg_ctl runs and reports major ${PG_MAJOR}`, () => {
  const out = execFileSync(path.join(payload, 'bin', 'pg_ctl'), ['--version'], { encoding: 'utf8' }).trim();
  if (!new RegExp(`\\b${PG_MAJOR}\\.`).test(out)) throw new Error(`got "${out}"`);
});

console.log(failures === 0 ? '\nAll bundle checks passed.' : `\n${failures} check(s) FAILED.`);
if (UNSIGNED && failures === 0) {
  // Posture amended (Kari, 2026-09-11): an UNSIGNED build MAY go to known,
  // trusted internal testers for the Finnish pilot — Gatekeeper refuses it
  // on every other Mac until the tester allows it (System Settings → Privacy
  // & Security → Open Anyway). Signed + notarized stays the M0b exit line.
  console.warn(
    '\n⚠️  UNSIGNED BUILD — no Developer ID signature, not notarized. On any Mac\n' +
      'other than this one Gatekeeper blocks the first launch until the user\n' +
      'allows it (Privacy & Security → Open Anyway). Internal, trusted testers\n' +
      'ONLY (Kari, 2026-09-11) — never a customer. Run desktop-release-receipt.mjs\n' +
      'next; the M0b exit still requires the signed + notarized build.'
  );
}
process.exit(failures === 0 ? 0 : 1);
