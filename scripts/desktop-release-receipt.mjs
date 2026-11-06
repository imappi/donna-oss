#!/usr/bin/env node
// desktop-release-receipt — the identity + hygiene receipt for a packaged
// desktop build (2026-09-11, the Finnish internal-test DMG). Run on the Mac
// AFTER desktop-verify-bundle.mjs, before a DMG goes anywhere:
//
//   node scripts/desktop-release-receipt.mjs --app dist-desktop/mac-arm64/Donna.app \
//        --dmg dist-desktop/Donna-<version>-arm64.dmg [--out <receipt.json>]
//
// One JSON receipt (written next to the DMG by default) + a PASS/FAIL summary
// answering the acceptance line "current merged source, UI build, packaged
// build identity and artifact SHA-256 agree; the package carries no local
// books, uploads, .env files or developer secrets":
//
//   source    git HEAD / branch / dirty state of the checkout the build ran in
//   identity  desktop/build-identity.json INSIDE the app (written by
//             write_desktop_build_identity.mjs immediately before packaging)
//             must name the same commit and be clean
//   version   root package.json inside the app == Info.plist
//             CFBundleShortVersionString == the version in the DMG filename
//   ui        the frozen dist/ inside the app is byte-identical to the
//             checkout's dist/ — EVERY file, by content hash, recursively
//             (a rebuilt asset keeps its filename when only its bytes
//             changed, so a name list is not enough) — the "repackage
//             didn't take" class, machine-checked
//   signature codesign state of the .app: an ad-hoc seal (what the unsigned
//             lane produces) or a Developer ID signature PASS; "not signed
//             at all" or a BROKEN seal (modified after sealing → macOS shows
//             "damaged", and no Open Anyway step recovers it) FAIL. This is
//             what separates the accepted unsigned/not-notarized state from
//             a damaged package.
//   arch      Mach-O header of Contents/MacOS/Donna (arm64 only today —
//             an Intel Mac cannot run this build; say so in the notes)
//   payload   the PG payload manifest is present (verify-bundle checks shas)
//   hygiene   walk of the whole .app: hard-FORBIDDEN classes (.env*,
//             provider-keys.json, .git, tmp/, dist-desktop/, backups/,
//             documents/, key/cert files, npmrc) fail the receipt; document-
//             like files outside the known synthetic fixture dirs are listed
//             for REVIEW (they do not fail — server/donna/fixtures/ ships on
//             purpose)
//   artifacts sha256 + size of the DMG (and the zip when present)
//
// Everything that can be pure IS pure and exported (plist parse, Mach-O
// arch sniff, tree scan, agreement verdict) so scripts/desktop-release-
// receipt.test.js pins it in the container; only git + the filesystem walk
// of a real .app run on the Mac.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, lstatSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const RECEIPT_FORMAT = 'donna.desktop-release-receipt.v1';

// ---- pure helpers -----------------------------------------------------------

// The four Info.plist keys the receipt reads. Plist XML from electron-builder
// is flat <key>/<string> pairs; a regex is enough and keeps plutil out.
export const parseInfoPlist = (xml) => {
  const read = (key) => {
    const m = String(xml || '').match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
    return m ? m[1] : null;
  };
  return {
    bundle_id: read('CFBundleIdentifier'),
    short_version: read('CFBundleShortVersionString'),
    bundle_version: read('CFBundleVersion'),
    minimum_system_version: read('LSMinimumSystemVersion'),
    executable: read('CFBundleExecutable')
  };
};

// Mach-O header sniff: thin 64-bit (magic 0xfeedfacf, little-endian on
// disk) → cputype at byte 4; fat (0xcafebabe, big-endian) → one cputype per
// arch entry. Only the two cputypes a Mac can be are named.
const CPU_TYPES = { 0x0100000c: 'arm64', 0x01000007: 'x86_64' };
export const detectMachOArchs = (buffer) => {
  if (!buffer || buffer.length < 8) return [];
  const magicLE = buffer.readUInt32LE(0);
  const magicBE = buffer.readUInt32BE(0);
  if (magicLE === 0xfeedfacf || magicLE === 0xfeedface) {
    const cpu = buffer.readUInt32LE(4);
    return [CPU_TYPES[cpu] || `cputype:${cpu.toString(16)}`];
  }
  if (magicBE === 0xcafebabe) {
    const count = buffer.readUInt32BE(4);
    const archs = [];
    for (let i = 0; i < count && 8 + i * 20 + 4 <= buffer.length; i += 1) {
      const cpu = buffer.readUInt32BE(8 + i * 20);
      archs.push(CPU_TYPES[cpu] || `cputype:${cpu.toString(16)}`);
    }
    return archs;
  }
  return [];
};

// Hygiene classes. Paths are relative to the .app root, '/'-separated.
const FORBIDDEN_NAME = /^(\.env(\..+)?|provider-keys\.json|\.npmrc|\.netrc|id_(rsa|ed25519)(\.pub)?|.*\.(pem|p12|key|keystore))$/;
const FORBIDDEN_DIR_SEGMENTS = new Set(['.git', 'tmp', 'dist-desktop', 'backups', 'documents', 'renders', '.claude']);
// The app copy of the repo lives here; desktop/vendor (the staged PG source)
// must NOT be inside it — the payload rides Resources/pg16 instead.
const FORBIDDEN_APP_SUBTREES = ['Contents/Resources/app/desktop/vendor', 'Contents/Resources/app/node_modules/.cache'];
const DOCUMENT_LIKE = /\.(pdf|csv|xlsx|xls|ofx|qif|jpe?g|png|heic|tiff?)$/i;
// Where document-like files are EXPECTED: synthetic fixtures, the app icon
// sources, and the built SPA's own images.
const REVIEW_EXEMPT_PREFIXES = [
  'Contents/Resources/app/server/donna/fixtures/',
  'Contents/Resources/app/desktop/build/',
  'Contents/Resources/app/dist/',
  'Contents/Resources/app/packs/',
  'Contents/Resources/app/node_modules/',
  'Contents/Resources/'
];
const REVIEW_EXEMPT_EXACT = new Set(['Contents/Resources/app/desktop/build/icon.png']);

export const classifyPath = (rel) => {
  const segments = rel.split('/');
  const name = segments[segments.length - 1];
  if (FORBIDDEN_NAME.test(name)) return 'forbidden';
  if (FORBIDDEN_APP_SUBTREES.some((p) => rel === p || rel.startsWith(`${p}/`))) return 'forbidden';
  // Directory segments are judged inside the app copy of the repo only —
  // Resources/app/tmp is a leaked working dir; Contents/Frameworks/… is
  // Electron's own layout and never carries these names for our reasons.
  if (rel.startsWith('Contents/Resources/app/')) {
    const inner = segments.slice(3, -1);
    if (inner.some((seg) => FORBIDDEN_DIR_SEGMENTS.has(seg))) return 'forbidden';
  }
  if (DOCUMENT_LIKE.test(name)) {
    if (REVIEW_EXEMPT_EXACT.has(rel)) return 'ok';
    const exemptPrefix = REVIEW_EXEMPT_PREFIXES.find((p) => rel.startsWith(p));
    // Resources/ itself is exempt only for the non-app payload (icons, pg16).
    if (exemptPrefix && !(exemptPrefix === 'Contents/Resources/' && rel.startsWith('Contents/Resources/app/'))) return 'ok';
    return 'review';
  }
  return 'ok';
};

export const scanAppTree = (appDir, { fsImpl = { readdirSync, lstatSync } } = {}) => {
  const forbidden = [];
  const review = [];
  let files = 0;
  const walk = (dir) => {
    for (const entry of fsImpl.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(appDir, abs).split(path.sep).join('/');
      if (entry.isSymbolicLink()) { files += 1; continue; }
      if (entry.isDirectory()) {
        // A forbidden directory is reported once, by its own path.
        const probe = classifyPath(`${rel}/x`);
        if (probe === 'forbidden' && classifyPath(`${path.posix.dirname(rel)}/x`) !== 'forbidden') {
          forbidden.push(`${rel}/`);
          continue;
        }
        walk(abs);
        continue;
      }
      files += 1;
      const verdict = classifyPath(rel);
      if (verdict === 'forbidden') forbidden.push(rel);
      else if (verdict === 'review') review.push(rel);
    }
  };
  walk(appDir);
  return { files, forbidden: forbidden.sort(), review: review.sort() };
};

// Code-signature state from the two codesign outputs (pure: the Mac glue
// runs the commands, this classifies). States:
//   'developer-id' — Authority=Developer ID Application (the signed lane)
//   'adhoc'        — Signature=adhoc (what dist:mac:unsigned produces; the
//                    ACCEPTED internal-test state — Gatekeeper asks, Open
//                    Anyway works)
//   'unsigned'     — no signature at all (an arm64 main executable will not
//                    launch; a packaging defect)
//   'broken'       — a seal exists but --verify fails: the bundle was modified
//                    after signing (a hand-patched .app, a stray file) → macOS
//                    reports "damaged" and refuses even with Open Anyway
export const classifyCodeSignature = ({ verifyOk, verifyOutput = '', infoOutput = '' }) => {
  const info = String(infoOutput || '');
  const verifyText = String(verifyOutput || '');
  const notSigned = /not signed at all/i.test(verifyText) || /not signed at all/i.test(info);
  if (notSigned) return { state: 'unsigned', ok: false, detail: 'code object is not signed at all' };
  const authority = (info.match(/^Authority=(.+)$/m) || [])[1] || null;
  const adhoc = /^Signature=adhoc$/m.test(info);
  if (!verifyOk) {
    const firstLine = verifyText.split('\n').map((l) => l.trim()).find(Boolean) || 'codesign --verify failed';
    return { state: 'broken', ok: false, detail: `seal does not verify — ${firstLine}`, authority, adhoc };
  }
  if (authority && /Developer ID Application/i.test(authority)) return { state: 'developer-id', ok: true, detail: authority, authority, adhoc: false };
  if (adhoc) return { state: 'adhoc', ok: true, detail: 'ad-hoc seal, verifies (unsigned lane — Gatekeeper "Open Anyway" required)', authority: null, adhoc: true };
  if (authority) return { state: 'signed', ok: true, detail: authority, authority, adhoc: false };
  return { state: 'unknown', ok: false, detail: 'codesign -dv reported neither an authority nor an ad-hoc signature' };
};

// The DMG electron-builder names "Donna-${version}-${arch}.dmg".
export const parseArtifactName = (fileName) => {
  const m = String(fileName || '').match(/^Donna-(.+)-(arm64|x64|universal)(?:-mac)?\.(dmg|zip)$/);
  return m ? { version: m[1], arch: m[2], ext: m[3] } : null;
};

// The agreement verdict — every input already read; pure so the test can
// drive each disagreement. `checks` is the machine-readable row list.
export const buildAgreementChecks = ({
  gitHead, gitDirty, buildIdentity, appPackageVersion, plist, dmgName, distMatches, distDetail = null, archs, payloadPresent, scan, signature = null, expectedBundleId = 'example.donna.desktop'
}) => {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
  add('build identity present in the app', Boolean(buildIdentity?.commit_sha), buildIdentity?.commit_sha ? `${buildIdentity.commit_sha.slice(0, 12)}` : 'desktop/build-identity.json missing or unreadable');
  add('build identity commit == checkout HEAD', Boolean(gitHead) && buildIdentity?.commit_sha === gitHead, `identity ${buildIdentity?.commit_sha?.slice(0, 12) || '?'} · HEAD ${gitHead?.slice(0, 12) || '?'}`);
  add('build identity is clean (no local changes at packaging time)', buildIdentity && buildIdentity.dirty === false, buildIdentity?.dirty === false ? 'clean' : `dirty=${buildIdentity?.dirty}`);
  add('checkout is clean now', gitDirty === false, gitDirty === false ? 'clean' : 'uncommitted changes present');
  add('bundle id', plist?.bundle_id === expectedBundleId, plist?.bundle_id || 'missing');
  add('app package.json version == Info.plist version', Boolean(appPackageVersion) && appPackageVersion === plist?.short_version, `${appPackageVersion || '?'} vs ${plist?.short_version || '?'}`);
  const parsed = parseArtifactName(dmgName);
  add('DMG filename carries the same version', Boolean(parsed) && parsed.version === plist?.short_version, dmgName || 'no dmg');
  add('frozen dist/ inside the app == checkout dist/ (every file, by content)', distMatches === true,
    distMatches === true ? (distDetail || 'identical') : (distMatches === null ? 'checkout has no dist/ (run npm run build first)' : `DIFFERENT — the repackage did not take${distDetail ? ` (${distDetail})` : ''}`));
  add('Mach-O arch', Array.isArray(archs) && archs.includes('arm64'), (archs || []).join(',') || 'unreadable');
  add('bundled PG payload manifest present', payloadPresent === true, payloadPresent ? 'Resources/pg16/manifest.json' : 'MISSING');
  add('app code signature intact (ad-hoc or Developer ID; "not signed" and a broken seal fail)', Boolean(signature?.ok), signature ? `${signature.state} — ${signature.detail}` : 'not checked');
  add('no forbidden files in the bundle', scan && scan.forbidden.length === 0, scan ? (scan.forbidden.length ? scan.forbidden.slice(0, 10).join(', ') : `${scan.files} files scanned`) : 'not scanned');
  return { checks, ok: checks.every((c) => c.ok) };
};

// ---- Mac-side glue ------------------------------------------------------------

const sha256File = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

const readHead = (file, bytes) => {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const n = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, n);
  } finally {
    closeSync(fd);
  }
};

const git = (args) => {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};

// Mac-side: the two codesign reads the classifier needs. Non-darwin hosts
// get an explicit 'unavailable' (the receipt must never guess a seal).
export const readCodeSignature = (appDir, { platform = process.platform, run = spawnSync } = {}) => {
  if (platform !== 'darwin') return { state: 'unavailable', ok: false, detail: 'codesign needs macOS' };
  const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
  const verify = run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appDir], options);
  const info = run('codesign', ['-dv', '--verbose=2', appDir], options);
  // codesign reports on stderr even when it exits successfully. execFileSync
  // only returns stdout, so reading stderr only in catch discarded good seals.
  const output = (result) => `${result.stdout || ''}\n${result.stderr || ''}\n${result.error?.message || ''}`.trim();
  if (info.error || info.status !== 0) {
    return { state: 'unavailable', ok: false, detail: output(info) || 'codesign identity inspection failed' };
  }
  return classifyCodeSignature({ verifyOk: !verify.error && verify.status === 0, verifyOutput: output(verify), infoOutput: output(info) });
};

const readJson = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
};

// Recursive content comparison of two dist trees. Returns every relative
// path with its sha256 on each side and the disagreement lists. A rebuilt
// asset can keep its exact filename (vite hashes are content-derived, but
// index.html, images and any un-hashed file are not), so equality is by
// bytes for EVERY file — never by name list or by index.html alone.
export const hashTree = (rootDir, { fsImpl = { readdirSync, lstatSync, readFileSync } } = {}) => {
  const out = new Map();
  const walk = (dir) => {
    for (const entry of fsImpl.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(rootDir, abs).split(path.sep).join('/');
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { walk(abs); continue; }
      out.set(rel, createHash('sha256').update(fsImpl.readFileSync(abs)).digest('hex'));
    }
  };
  walk(rootDir);
  return out;
};

export const compareDist = ({ checkoutDist, appDist, fsImpl } = {}) => {
  if (!existsSync(path.join(checkoutDist, 'index.html'))) return { matches: null, reason: 'checkout dist/ missing' };
  if (!existsSync(path.join(appDist, 'index.html'))) return { matches: false, reason: 'app dist/ missing' };
  const a = hashTree(checkoutDist, fsImpl ? { fsImpl } : undefined);
  const b = hashTree(appDist, fsImpl ? { fsImpl } : undefined);
  const onlyInCheckout = [...a.keys()].filter((k) => !b.has(k)).sort();
  const onlyInApp = [...b.keys()].filter((k) => !a.has(k)).sort();
  const differing = [...a.keys()].filter((k) => b.has(k) && a.get(k) !== b.get(k)).sort();
  const matches = onlyInCheckout.length === 0 && onlyInApp.length === 0 && differing.length === 0;
  const detail = matches
    ? `${a.size} files identical by content`
    : [differing.length ? `${differing.length} differ by content: ${differing.slice(0, 5).join(', ')}` : null,
       onlyInCheckout.length ? `${onlyInCheckout.length} only in checkout: ${onlyInCheckout.slice(0, 5).join(', ')}` : null,
       onlyInApp.length ? `${onlyInApp.length} only in app: ${onlyInApp.slice(0, 5).join(', ')}` : null].filter(Boolean).join('; ');
  return {
    matches,
    detail,
    checkout_files: a.size,
    app_files: b.size,
    checkout_index_sha256: a.get('index.html') || null,
    app_index_sha256: b.get('index.html') || null,
    differing,
    only_in_checkout: onlyInCheckout,
    only_in_app: onlyInApp
  };
};

const main = () => {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? null : args[i + 1];
  };
  const appDir = flag('--app') ? path.resolve(flag('--app')) : null;
  const dmg = flag('--dmg') ? path.resolve(flag('--dmg')) : null;
  if (!appDir || !existsSync(appDir) || !dmg || !existsSync(dmg)) {
    console.error('usage: node scripts/desktop-release-receipt.mjs --app <Donna.app> --dmg <Donna-<version>-arm64.dmg> [--out <receipt.json>]');
    process.exit(2);
  }
  const out = flag('--out') ? path.resolve(flag('--out')) : `${dmg}.receipt.json`;

  const appRoot = path.join(appDir, 'Contents', 'Resources', 'app');
  const plist = parseInfoPlist(readFileSync(path.join(appDir, 'Contents', 'Info.plist'), 'utf8'));
  const appPackage = readJson(path.join(appRoot, 'package.json'));
  const buildIdentity = readJson(path.join(appRoot, 'desktop', 'build-identity.json'));
  const gitHead = git(['rev-parse', 'HEAD']);
  const gitBranch = git(['branch', '--show-current']);
  const gitStatus = git(['status', '--porcelain', '--untracked-files=no']);
  const gitDirty = gitStatus == null ? null : gitStatus.length > 0;
  const originMain = git(['rev-parse', 'origin/main']);
  const headOnMain = gitHead && originMain
    ? git(['merge-base', '--is-ancestor', gitHead, originMain]) !== null
    : null;

  const executable = path.join(appDir, 'Contents', 'MacOS', plist.executable || 'Donna');
  const archs = existsSync(executable) ? detectMachOArchs(readHead(executable, 4096)) : [];
  const payloadManifest = readJson(path.join(appDir, 'Contents', 'Resources', 'pg16', 'manifest.json'));
  const dist = compareDist({ checkoutDist: path.join(ROOT, 'dist'), appDist: path.join(appRoot, 'dist') });
  const scan = scanAppTree(appDir);
  const signature = readCodeSignature(appDir);

  const artifacts = [dmg];
  const zip = dmg.replace(/\.dmg$/, '-mac.zip');
  if (existsSync(zip)) artifacts.push(zip);
  const artifactRows = artifacts.map((file) => ({
    file: path.basename(file),
    path: file,
    bytes: statSync(file).size,
    sha256: sha256File(file)
  }));

  const { checks, ok } = buildAgreementChecks({
    gitHead, gitDirty, buildIdentity, appPackageVersion: appPackage?.version, plist,
    dmgName: path.basename(dmg), distMatches: dist.matches, distDetail: dist.detail || null, archs,
    payloadPresent: Boolean(payloadManifest), scan, signature
  });

  let macos = null;
  try { macos = execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(); } catch { /* not macOS */ }

  const receipt = {
    version: RECEIPT_FORMAT,
    created_at: new Date().toISOString(),
    build_host: { platform: process.platform, arch: process.arch, macos, node: process.version },
    source: { head: gitHead, branch: gitBranch, dirty: gitDirty, origin_main: originMain, head_is_on_origin_main: headOnMain },
    build_identity: buildIdentity,
    app: {
      path: appDir,
      bundle_id: plist.bundle_id,
      short_version: plist.short_version,
      bundle_version: plist.bundle_version,
      minimum_system_version: plist.minimum_system_version,
      package_version: appPackage?.version || null,
      archs,
      pg_payload: payloadManifest ? { version: payloadManifest.version, staged_files: payloadManifest.staged_files, mach_o_count: payloadManifest.mach_o_count } : null,
      dist,
      signature,
      signing_posture: signature?.state === 'developer-id'
        ? 'Developer ID signed (notarization not checked here — spctl in desktop-verify-bundle.mjs)'
        : 'unsigned / not notarized (Kari, 2026-09-11: accepted for the internal Finnish pilot — Gatekeeper "Open Anyway" required on every other Mac); an ad-hoc seal that verifies is the accepted state, a broken seal is a damaged package'
    },
    hygiene: { files_scanned: scan.files, forbidden: scan.forbidden, review: scan.review },
    artifacts: artifactRows,
    checks,
    ok
  };
  writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`);

  for (const check of checks) console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name} — ${check.detail}`);
  if (scan.review.length) {
    console.log(`\nREVIEW  ${scan.review.length} document-like file(s) outside the known fixture dirs (not a failure — confirm they are not client material):`);
    for (const rel of scan.review.slice(0, 40)) console.log(`        ${rel}`);
    if (scan.review.length > 40) console.log(`        … ${scan.review.length - 40} more in the receipt`);
  }
  console.log('');
  for (const row of artifactRows) console.log(`${row.sha256}  ${row.file}  (${row.bytes} bytes)`);
  console.log(`\nsource ${gitBranch || '?'} @ ${gitHead?.slice(0, 12) || '?'}${gitDirty ? ' +local changes' : ''}${headOnMain === false ? '  ⚠️ HEAD is NOT on origin/main' : ''}`);
  console.log(`app    ${plist.bundle_id} ${plist.short_version} · ${archs.join(',') || '?'} · identity ${buildIdentity?.commit_sha?.slice(0, 12) || '?'}${buildIdentity?.dirty ? ' (dirty)' : ''} · signature ${signature.state}`);
  console.log(`receipt → ${out}`);
  console.log(ok ? '\nRelease receipt: ALL CHECKS PASSED.' : '\nRelease receipt: FAILED — do not distribute this DMG.');
  process.exit(ok ? 0 : 1);
};

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(`[release-receipt] failed: ${error.message}`);
    process.exit(1);
  }
}
