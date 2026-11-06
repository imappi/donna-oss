#!/usr/bin/env node
// desktop-stage-pg — stage a relocatable Postgres 16 payload for the packaged
// desktop app (M0b: PG is BUNDLED from the get-go — no host-Postgres debt).
//
//   node scripts/desktop-stage-pg.mjs [--from <pg16 root|bin dir>] [--out <dir>]
//                                     [--plan]
//
// What it does (macOS; --plan works anywhere):
//   1. Resolves the source PG 16 layout (bin/ lib/ share/) from --from or the
//      pgSupervisor host candidates (Postgres.app is the preferred source —
//      its payload is built relocatable, so step 3 is mostly a verify).
//   2. Copies the REQUIRED_BINARIES subset + the whole lib/ + share/ into
//      desktop/vendor/pg16 (git-ignored; carried into the app as
//      extraResources → Contents/Resources/pg16 by desktop/electron-builder.yml).
//   3. Relocation fixup: walks every Mach-O in the payload with `otool -L`,
//      pulls any non-system dylib living OUTSIDE the payload into lib/
//      (dependency closure), rewrites references to @executable_path/../lib
//      (binaries) / @loader_path (libs) with `install_name_tool`, and ad-hoc
//      re-signs each touched file (install_name_tool invalidates signatures;
//      the REAL Developer ID signing happens at electron-builder time via
//      scripts/desktop-sign-pg.mjs).
//   4. Verifies: payload pg_ctl --version runs, and no Mach-O still references
//      /opt/homebrew, /usr/local, or the source keg.
//   5. Writes vendor/pg16/manifest.json — source, version, per-file sha256 —
//      which the sign hook and desktop-verify-bundle.mjs both read.
//
// PostgreSQL is designed relocatable (find_my_exec walks from the real binary
// path when the compiled-in prefix is absent), so bin/../share/postgresql and
// bin/../lib resolve inside the payload without patching any prefix.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { PG_MAJOR, findPgBin } from '../server/donna/desktop/pgSupervisor.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const DEFAULT_OUT = path.join(ROOT, 'desktop', 'vendor', `pg${PG_MAJOR}`);

// The binaries the desktop lane actually calls: supervisor (initdb, pg_ctl,
// postgres — pg_ctl launches it —, psql, createdb) + backup packages
// (pg_dump, pg_restore). Everything else in a PG distribution stays behind.
export const REQUIRED_BINARIES = ['initdb', 'pg_ctl', 'postgres', 'psql', 'createdb', 'pg_dump', 'pg_restore'];

// System prefixes that are always present on macOS and never bundled.
const SYSTEM_PREFIXES = ['/usr/lib/', '/System/'];

// Resolve a source root-or-bin argument into {bin, lib, share} directories.
// Understands the three real-world layouts: Homebrew keg
// (…/postgresql@16/{bin,lib,share/postgresql@16}), Postgres.app
// (…/Versions/16/{bin,lib,share/postgresql}), EDB (…/16/{bin,lib,share/postgresql}).
export const resolveSourceLayout = (fromDir) => {
  const root = path.basename(fromDir) === 'bin' ? path.dirname(fromDir) : fromDir;
  const bin = path.join(root, 'bin');
  if (!existsSync(path.join(bin, 'pg_ctl'))) {
    throw new Error(`no pg_ctl under ${bin} — pass --from <pg${PG_MAJOR} root or bin dir>`);
  }
  const lib = path.join(root, 'lib');
  if (!existsSync(lib)) throw new Error(`no lib/ next to ${bin}`);
  const shareCandidates = [
    path.join(root, 'share', `postgresql@${PG_MAJOR}`),
    path.join(root, 'share', 'postgresql'),
    path.join(root, 'share')
  ];
  const share = shareCandidates.find((dir) => existsSync(path.join(dir, 'postgres.bki')));
  if (!share) {
    throw new Error(
      `no share dir with postgres.bki under ${root} — initdb cannot run without it (checked: ${shareCandidates.join(', ')})`
    );
  }
  return { root, bin, lib, share };
};

// The copy plan, as data — pure so it's testable off-Mac. share/ is
// normalized to share/postgresql regardless of the source flavor.
export const planStaging = ({ source, out }) => {
  const plan = [];
  for (const name of REQUIRED_BINARIES) {
    const from = path.join(source.bin, name);
    if (!existsSync(from)) throw new Error(`required binary missing at source: ${from}`);
    plan.push({ from, to: path.join(out, 'bin', name) });
  }
  plan.push({ from: source.lib, to: path.join(out, 'lib'), dir: true });
  plan.push({ from: source.share, to: path.join(out, 'share', 'postgresql'), dir: true });
  return plan;
};

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

const copyTree = (from, to) => {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isSymbolicLink()) {
      try { symlinkSync(readlinkSync(src), dst); } catch { /* duplicate on re-run */ }
    } else if (entry.isDirectory()) {
      copyTree(src, dst);
    } else {
      copyFileSync(src, dst);
    }
  }
};

const isMachO = (file) => {
  try {
    if (lstatSync(file).isSymbolicLink()) return false;
    const magic = readFileSync(file).subarray(0, 4).toString('hex');
    return ['cffaedfe', 'cefaedfe', 'cafebabe', 'bebafeca'].includes(magic);
  } catch {
    return false;
  }
};

const otoolDeps = (file) =>
  execFileSync('otool', ['-L', file], { encoding: 'utf8' })
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(' (')[0])
    .filter(Boolean);

// Resolve an @-prefixed Mach-O reference to the absolute path dyld would try
// inside the payload (@executable_path = the payload's bin/, since only the
// payload binaries load these libs). @rpath cannot be resolved statically →
// null. Pure path math, exported for the plan-layer tests.
export const resolvePayloadRef = ({ dep, fileDir, binDir }) => {
  if (dep.startsWith('@loader_path/')) return path.resolve(fileDir, dep.slice('@loader_path/'.length));
  if (dep.startsWith('@executable_path/')) return path.resolve(binDir, dep.slice('@executable_path/'.length));
  return null;
};

const rewriteMachO = ({ file, out, kind, log, sourceLibDirs }) => {
  const pulled = [];
  const libDir = path.join(out, 'lib');
  const binDir = path.join(out, 'bin');
  const fileDir = path.dirname(file);
  // The canonical reference form, correct for files BELOW lib/ too
  // (lib/postgresql/*.so needs @loader_path/../name, not @loader_path/name).
  const canonicalRef = (name) => {
    if (kind === 'bin') return `@executable_path/../lib/${name}`;
    const rel = path.relative(fileDir, libDir);
    return rel ? `@loader_path/${rel}/${name}` : `@loader_path/${name}`;
  };
  for (const dep of otoolDeps(file)) {
    if (SYSTEM_PREFIXES.some((prefix) => dep.startsWith(prefix))) continue;
    const name = path.basename(dep);
    const target = path.join(libDir, name);
    if (dep.startsWith('@')) {
      // A source-relative reference. Relocatable-LOOKING is not
      // relocatable-COMPLETE: Homebrew's ICU links its siblings via
      // @loader_path, so the target may never have been pulled —
      // libicudata.78 broke the first bundled initdb this way (2026-08-07;
      // pg_ctl doesn't link ICU, so only initdb could surface it). Pull the
      // missing target from the source lib dirs seen so far and
      // canonicalize the reference like any other dep.
      const resolved = resolvePayloadRef({ dep, fileDir, binDir });
      if (resolved && existsSync(resolved)) continue; // already sound (incl. dylib self-ids)
      if (!existsSync(target)) {
        const from = [...sourceLibDirs].map((dir) => path.join(dir, name)).find((f) => existsSync(f));
        if (!from) {
          throw new Error(
            `${file} references ${dep} but ${name} is neither in the payload nor in any known source lib dir (${[...sourceLibDirs].join(', ')})`
          );
        }
        log(`  closure: pulling ${from} → lib/${name} (via ${dep})`);
        copyFileSync(from, target);
        pulled.push(target);
      }
      const ref = canonicalRef(name);
      if (ref !== dep) execFileSync('install_name_tool', ['-change', dep, ref, file]);
      continue;
    }
    if (!existsSync(target) && existsSync(dep)) {
      log(`  closure: pulling ${dep} → lib/${name}`);
      copyFileSync(dep, target);
      pulled.push(target);
      // Remember where host libs live — an @loader_path sibling of THIS lib
      // (see above) must be findable later.
      sourceLibDirs.add(path.dirname(dep));
      try { sourceLibDirs.add(path.dirname(realpathSync(dep))); } catch { /* dangling source symlink */ }
    }
    execFileSync('install_name_tool', ['-change', dep, canonicalRef(name), file]);
  }
  if (kind === 'lib') {
    execFileSync('install_name_tool', ['-id', `@loader_path/${path.basename(file)}`, file]);
  }
  // install_name_tool invalidates the signature; ad-hoc re-sign so the staged
  // payload still runs locally. Developer ID signing happens at build time.
  execFileSync('codesign', ['--force', '--sign', '-', file]);
  return pulled;
};

const verifyPayload = ({ out, log }) => {
  const version = execFileSync(path.join(out, 'bin', 'pg_ctl'), ['--version'], { encoding: 'utf8' }).trim();
  if (!version.includes(` ${PG_MAJOR}.`) && !/\s16(\.|$)/.test(version)) {
    throw new Error(`staged pg_ctl reports "${version}" — expected major ${PG_MAJOR}`);
  }
  log(`verify: ${version}`);
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (isMachO(file)) {
        for (const dep of otoolDeps(file)) {
          if (dep.startsWith('/opt/homebrew') || dep.startsWith('/usr/local') || dep.startsWith('/Applications/Postgres.app')) {
            offenders.push(`${file} → ${dep}`);
          } else if (dep.startsWith('@')) {
            // A reference may LOOK relocatable and still dangle (the
            // libicudata class) — resolve it and require the target to
            // exist, so this fails at stage time, not at first initdb.
            const resolved = resolvePayloadRef({ dep, fileDir: path.dirname(file), binDir: path.join(out, 'bin') });
            if (resolved && !existsSync(resolved)) offenders.push(`${file} → ${dep} (dangling)`);
            if (!resolved && !existsSync(path.join(out, 'lib', path.basename(dep)))) {
              offenders.push(`${file} → ${dep} (unresolvable @rpath-style reference)`);
            }
          }
        }
      }
    }
  };
  walk(out);
  if (offenders.length) {
    throw new Error(`payload still references host paths:\n${offenders.join('\n')}`);
  }
  log('verify: no host-path or dangling references remain');
};

const writeManifest = ({ out, source, log }) => {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (!entry.isSymbolicLink()) {
        files.push({
          path: path.relative(out, file),
          sha256: sha256(file),
          machO: isMachO(file)
        });
      }
    }
  };
  walk(out);
  const manifest = {
    pg_major: PG_MAJOR,
    source: source.root,
    version: execFileSync(path.join(out, 'bin', 'pg_ctl'), ['--version'], { encoding: 'utf8' }).trim(),
    staged_files: files.length,
    mach_o_count: files.filter((f) => f.machO).length,
    files
  };
  writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  log(`manifest: ${files.length} files (${manifest.mach_o_count} Mach-O) → manifest.json`);
};

const main = () => {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? null : args[i + 1];
  };
  const planOnly = args.includes('--plan');
  const out = flag('--out') || DEFAULT_OUT;
  const fromArg = flag('--from');

  const log = (line) => console.log(`[stage-pg] ${line}`);

  const source = resolveSourceLayout(fromArg || findPgBin());
  log(`source: ${source.root}`);
  const plan = planStaging({ source, out });

  if (planOnly) {
    for (const step of plan) log(`plan: ${step.dir ? 'tree' : 'file'} ${step.from} → ${step.to}`);
    return;
  }
  if (process.platform !== 'darwin') {
    throw new Error('staging executes otool/install_name_tool/codesign — run on macOS (use --plan elsewhere)');
  }

  rmSync(out, { recursive: true, force: true });
  mkdirSync(path.join(out, 'bin'), { recursive: true });
  for (const step of plan) {
    log(`copy: ${step.from} → ${step.to}`);
    if (step.dir) copyTree(step.from, step.to);
    else copyFileSync(step.from, step.to);
  }

  // Relocation fixup over the whole payload. Closure pulls can add new libs;
  // iterate until a pass pulls nothing. sourceLibDirs accumulates every host
  // dir a lib was pulled from, so an @loader_path SIBLING reference (Homebrew
  // ICU style) can be satisfied even though its path never appears absolute.
  const sourceLibDirs = new Set([source.lib]);
  let pass = 0;
  for (;;) {
    pass += 1;
    log(`fixup pass ${pass}…`);
    let pulled = 0;
    for (const name of REQUIRED_BINARIES) {
      pulled += rewriteMachO({ file: path.join(out, 'bin', name), out, kind: 'bin', log, sourceLibDirs }).length;
    }
    const walkLibs = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walkLibs(file);
        else if (isMachO(file)) pulled += rewriteMachO({ file, out, kind: 'lib', log, sourceLibDirs }).length;
      }
    };
    walkLibs(path.join(out, 'lib'));
    if (pulled === 0) break;
    if (pass > 6) throw new Error('dependency closure did not converge in 6 passes — inspect otool -L output');
  }

  verifyPayload({ out, log });
  writeManifest({ out, source, log });
  log(`staged Postgres ${PG_MAJOR} payload at ${out}`);
  log('next: cd desktop && npm run dist:mac (signing + notarization per docs/session-handoff-2026-08-07-m0b-bundled-pg-packaging.md)');
};

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(`[stage-pg] failed: ${error.message}`);
    process.exit(1);
  }
}
