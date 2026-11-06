// electron-builder afterSign hook — sign the bundled PG payload (M0b).
//
// electron-builder signs the Electron app's own Mach-Os but does not reliably
// deep-sign extraResources; an unsigned binary anywhere in the bundle fails
// notarization. This hook walks the payload manifest written by
// scripts/desktop-stage-pg.mjs and signs every Mach-O in
// Contents/Resources/pg16 with hardened runtime + timestamp, using the same
// Developer ID identity as the app.
//
// ORDER NOTE (verify on the first Mac build): electron-builder ≥24 runs the
// user afterSign hook after signing and runs `notarize` after that — the
// payload must be signed BEFORE notarization submits. If the observed order
// differs, move this into a custom `sign` step or run it via afterPack +
// re-sign; the manifest-driven walk stays the same either way.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export default async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const payloadRoot = path.join(context.appOutDir, appName, 'Contents', 'Resources', 'pg16');
  const manifestPath = path.join(payloadRoot, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(
      `[sign-pg] no PG payload manifest at ${manifestPath} — run \`node scripts/desktop-stage-pg.mjs\` before dist:mac (the bundle must never ship without its Postgres).`
    );
  }

  // Interim unsigned-local lane (Kari, 2026-08-07: Developer ID cert parked
  // ~2 weeks — see the handoff §signing identity). The manifest guard above
  // still ran: even an unsigned build must never ship PG-less. Everything
  // below (payload signing, re-seal, deep verify) is skipped — the produced
  // app runs on the BUILD machine only; Gatekeeper refuses it anywhere else.
  // This lane must never produce a build that leaves the machine unmarked:
  // pair it with `desktop-verify-bundle.mjs --unsigned`, which prints the
  // same warning.
  if (process.env.DONNA_UNSIGNED_LOCAL === '1') {
    console.warn(
      '[sign-pg] ⚠️  DONNA_UNSIGNED_LOCAL=1 — SKIPPING payload signing. ' +
        'This build is unsigned and not notarized: Gatekeeper blocks it on every ' +
        'other Mac until the user chooses Open Anyway. Internal trusted testers only ' +
        '(Kari, 2026-09-11); the M0b exit still requires the signed + notarized build.'
    );
    return;
  }

  const identity = process.env.CSC_NAME || process.env.DONNA_SIGN_IDENTITY;
  if (!identity) {
    throw new Error('[sign-pg] set CSC_NAME (Developer ID Application identity) — unsigned payloads fail notarization. For local-only iteration without a cert, use `npm run dist:mac:unsigned` (sets DONNA_UNSIGNED_LOCAL=1).');
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const machOs = manifest.files.filter((f) => f.machO);
  console.log(`[sign-pg] signing ${machOs.length} payload Mach-Os with "${identity}"…`);
  // Libraries first, then executables — sign inside-out like a bundle.
  const ordered = [...machOs].sort((a, b) => {
    const aBin = a.path.startsWith('bin/') ? 1 : 0;
    const bBin = b.path.startsWith('bin/') ? 1 : 0;
    return aBin - bBin;
  });
  for (const file of ordered) {
    execFileSync('codesign', [
      '--force',
      '--options', 'runtime',
      '--timestamp',
      '--sign', identity,
      path.join(payloadRoot, file.path)
    ]);
  }
  // The payload changed after the app was signed — re-seal the outer bundle
  // signature so the .app verifies as a whole.
  execFileSync('codesign', [
    '--force',
    '--options', 'runtime',
    '--timestamp',
    '--sign', identity,
    path.join(context.appOutDir, appName)
  ]);
  execFileSync('codesign', ['--verify', '--deep', '--strict', path.join(context.appOutDir, appName)]);
  console.log('[sign-pg] payload signed; bundle re-sealed and verified.');
}
