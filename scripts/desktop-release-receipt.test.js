import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildAgreementChecks, classifyCodeSignature, classifyPath, compareDist, detectMachOArchs, hashTree, parseArtifactName, parseInfoPlist, readCodeSignature, scanAppTree
} from './desktop-release-receipt.mjs';

test('parseInfoPlist reads the identity keys electron-builder writes', () => {
  const xml = `<?xml version="1.0"?><plist><dict>
    <key>CFBundleExecutable</key><string>Donna</string>
    <key>CFBundleIdentifier</key>
    <string>example.donna.desktop</string>
    <key>CFBundleShortVersionString</key><string>0.1.0</string>
    <key>CFBundleVersion</key><string>0.1.0</string>
    <key>LSMinimumSystemVersion</key><string>12.0</string>
  </dict></plist>`;
  assert.deepEqual(parseInfoPlist(xml), {
    bundle_id: 'example.donna.desktop',
    short_version: '0.1.0',
    bundle_version: '0.1.0',
    minimum_system_version: '12.0',
    executable: 'Donna'
  });
  assert.equal(parseInfoPlist('').bundle_id, null);
});

test('detectMachOArchs names arm64 / x86_64 for thin and fat headers', () => {
  const thin = Buffer.alloc(32);
  thin.writeUInt32LE(0xfeedfacf, 0);
  thin.writeUInt32LE(0x0100000c, 4);
  assert.deepEqual(detectMachOArchs(thin), ['arm64']);
  const thinX = Buffer.alloc(32);
  thinX.writeUInt32LE(0xfeedfacf, 0);
  thinX.writeUInt32LE(0x01000007, 4);
  assert.deepEqual(detectMachOArchs(thinX), ['x86_64']);
  const fat = Buffer.alloc(8 + 2 * 20);
  fat.writeUInt32BE(0xcafebabe, 0);
  fat.writeUInt32BE(2, 4);
  fat.writeUInt32BE(0x01000007, 8);
  fat.writeUInt32BE(0x0100000c, 28);
  assert.deepEqual(detectMachOArchs(fat), ['x86_64', 'arm64']);
  assert.deepEqual(detectMachOArchs(Buffer.from('not a binary')), []);
});

test('classifyPath: secrets, working dirs and local books are forbidden; fixtures are fine; stray documents are review', () => {
  const app = 'Contents/Resources/app';
  assert.equal(classifyPath(`${app}/.env`), 'forbidden');
  assert.equal(classifyPath(`${app}/.env.local`), 'forbidden');
  assert.equal(classifyPath(`${app}/runtime/provider-keys.json`), 'forbidden');
  assert.equal(classifyPath(`${app}/tmp/kultalanka/report.md`), 'forbidden');
  assert.equal(classifyPath(`${app}/dist-desktop/Donna.dmg`), 'forbidden');
  assert.equal(classifyPath(`${app}/documents/ab/cd.bin`), 'forbidden');
  assert.equal(classifyPath(`${app}/backups/daily/manifest.json`), 'forbidden');
  assert.equal(classifyPath(`${app}/desktop/vendor/pg16/bin/pg_ctl`), 'forbidden');
  assert.equal(classifyPath(`${app}/.git/HEAD`), 'forbidden');
  assert.equal(classifyPath(`${app}/certs/server.pem`), 'forbidden');
  assert.equal(classifyPath(`${app}/server/donna/fixtures/appliance/receipt.pdf`), 'ok');
  assert.equal(classifyPath(`${app}/desktop/build/icon.png`), 'ok');
  assert.equal(classifyPath(`${app}/dist/assets/logo.png`), 'ok');
  assert.equal(classifyPath('Contents/Resources/icon.icns'), 'ok');
  assert.equal(classifyPath('Contents/Resources/pg16/share/postgresql/postgres.bki'), 'ok');
  assert.equal(classifyPath(`${app}/server/donna/kampaamo-statement.pdf`), 'review');
  assert.equal(classifyPath(`${app}/uploads/bank.csv`), 'review');
  assert.equal(classifyPath(`${app}/server/donna/firmDb.js`), 'ok');
  // Electron's own layout is never judged by the app-dir segment rule.
  assert.equal(classifyPath('Contents/Frameworks/Electron Framework.framework/Resources/tmp.txt'), 'ok');
});

test('scanAppTree walks a fixture .app and reports forbidden + review paths', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'donna-receipt-'));
  try {
    const app = path.join(dir, 'Donna.app');
    const put = (rel, body = 'x') => {
      const file = path.join(app, rel);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, body);
    };
    put('Contents/Info.plist');
    put('Contents/MacOS/Donna');
    put('Contents/Resources/pg16/manifest.json');
    put('Contents/Resources/app/package.json');
    put('Contents/Resources/app/server/donna/firmDb.js');
    put('Contents/Resources/app/server/donna/fixtures/appliance/receipt.pdf');
    put('Contents/Resources/app/server/donna/stray-invoice.pdf');
    put('Contents/Resources/app/.env');
    put('Contents/Resources/app/tmp/kultalanka/validation-report.md');
    put('Contents/Resources/app/tmp/kultalanka/deep/nested.json');
    const scan = scanAppTree(app);
    assert.deepEqual(scan.forbidden, [
      'Contents/Resources/app/.env',
      'Contents/Resources/app/tmp/'
    ]);
    assert.deepEqual(scan.review, ['Contents/Resources/app/server/donna/stray-invoice.pdf']);
    assert.equal(scan.files, 8); // the tmp/ subtree is reported once, not walked
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('compareDist compares EVERY file by content: same filenames with different bytes fail', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'donna-receipt-dist-'));
  try {
    const mk = (name, files) => {
      const d = path.join(dir, name);
      for (const [rel, body] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
        writeFileSync(path.join(d, rel), body);
      }
      return d;
    };
    const files = {
      'index.html': '<html>v2</html>',
      'assets/index-abc.js': 'console.log("v2")',
      'assets/index-abc.css': 'body{}',
      'assets/nested/logo.png': 'PNGv2',
      'favicon.ico': 'ico'
    };
    const checkout = mk('checkout', files);
    const same = mk('same', files);
    const result = compareDist({ checkoutDist: checkout, appDist: same });
    assert.equal(result.matches, true);
    assert.equal(result.checkout_files, 5);
    assert.deepEqual(result.differing, []);

    // The case a filename list cannot see: identical names, one asset's
    // bytes changed (a re-run build that froze an older nested image).
    const staleContent = mk('stale-content', { ...files, 'assets/nested/logo.png': 'PNGv1' });
    const drift = compareDist({ checkoutDist: checkout, appDist: staleContent });
    assert.equal(drift.matches, false);
    assert.deepEqual(drift.differing, ['assets/nested/logo.png']);
    assert.match(drift.detail, /1 differ by content: assets\/nested\/logo\.png/);

    // Same for an un-hashed top-level file (index.html) and for a missing file.
    assert.equal(compareDist({ checkoutDist: checkout, appDist: mk('stale-index', { ...files, 'index.html': '<html>v1</html>' }) }).differing[0], 'index.html');
    const { 'favicon.ico': _omit, ...withoutFavicon } = files;
    const missing = compareDist({ checkoutDist: checkout, appDist: mk('missing', withoutFavicon) });
    assert.equal(missing.matches, false);
    assert.deepEqual(missing.only_in_checkout, ['favicon.ico']);
    const extra = compareDist({ checkoutDist: checkout, appDist: mk('extra', { ...files, 'assets/index-old.js': 'old' }) });
    assert.equal(extra.matches, false);
    assert.deepEqual(extra.only_in_app, ['assets/index-old.js']);

    assert.equal(compareDist({ checkoutDist: path.join(dir, 'absent'), appDist: same }).matches, null);
    assert.equal(compareDist({ checkoutDist: checkout, appDist: path.join(dir, 'absent') }).matches, false);
    assert.equal(hashTree(checkout).size, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyCodeSignature separates the accepted unsigned state (ad-hoc, verifies) from a damaged package', () => {
  const adhocInfo = 'Executable=/x/Donna.app/Contents/MacOS/Donna\nIdentifier=example.donna.desktop\nFormat=app bundle with Mach-O thin (arm64)\nSignature=adhoc\nInfo.plist entries=30\nSealed Resources version=2 rules=13 files=3000\n';
  const adhoc = classifyCodeSignature({ verifyOk: true, infoOutput: adhocInfo });
  assert.equal(adhoc.state, 'adhoc');
  assert.equal(adhoc.ok, true);

  const broken = classifyCodeSignature({ verifyOk: false, verifyOutput: '/x/Donna.app: a sealed resource is missing or invalid\nfile modified: /x/Donna.app/Contents/Resources/app/dist/index.html', infoOutput: adhocInfo });
  assert.equal(broken.state, 'broken');
  assert.equal(broken.ok, false);
  assert.match(broken.detail, /sealed resource is missing or invalid/);

  const unsigned = classifyCodeSignature({ verifyOk: false, verifyOutput: '/x/Donna.app: code object is not signed at all', infoOutput: '/x/Donna.app: code object is not signed at all' });
  assert.equal(unsigned.state, 'unsigned');
  assert.equal(unsigned.ok, false);

  const devId = classifyCodeSignature({ verifyOk: true, infoOutput: 'Identifier=example.donna.desktop\nAuthority=Developer ID Application: Donna Inc (TEAMID)\nAuthority=Developer ID Certification Authority\nTimestamp=…\n' });
  assert.equal(devId.state, 'developer-id');
  assert.equal(devId.ok, true);

  // A verify that passes but reports neither authority nor ad-hoc is not trusted.
  assert.equal(classifyCodeSignature({ verifyOk: true, infoOutput: 'Identifier=x\n' }).ok, false);
});

test('parseArtifactName reads electron-builder names', () => {
  assert.deepEqual(parseArtifactName('Donna-0.1.0-arm64.dmg'), { version: '0.1.0', arch: 'arm64', ext: 'dmg' });
  assert.deepEqual(parseArtifactName('Donna-0.1.0-arm64-mac.zip'), { version: '0.1.0', arch: 'arm64', ext: 'zip' });
  assert.equal(parseArtifactName('Donna.dmg'), null);
});

test('signature reader preserves successful subprocess stderr and refuses failed inspection', () => {
  // Real child processes reproduce codesign's successful stderr-only report.
  // The earlier execFileSync wiring lost this output despite pure classifier pins.
  const runFor = (verifyExit, infoExit = 0) => (command, args, options) => {
    assert.equal(command, 'codesign');
    assert.equal(args.at(-1), '/candidate/Donna.app');
    const verifying = args[0] === '--verify';
    const message = verifying ? 'resource seal checked' : 'Signature=adhoc\nSealed Resources version=2';
    return spawnSync(process.execPath, ['-e',
      'process.stderr.write(process.argv[1]); process.exit(Number(process.argv[2]));',
      message, String(verifying ? verifyExit : infoExit)], options);
  };
  const inspect = (run) => readCodeSignature('/candidate/Donna.app', { platform: 'darwin', run });
  assert.equal(inspect(runFor(0)).state, 'adhoc');
  assert.equal(inspect(runFor(0)).ok, true);
  assert.equal(inspect(runFor(1)).state, 'broken');
  assert.equal(inspect(runFor(0, 1)).ok, false);
  assert.equal(inspect(() => ({ status: null, error: new Error('spawn ENOENT') })).ok, false);
  assert.equal(readCodeSignature('/candidate/Donna.app', { platform: 'linux' }).state, 'unavailable');
});

test('buildAgreementChecks passes only when every identity agrees, and names each disagreement', () => {
  const sha = 'a'.repeat(40);
  const good = {
    gitHead: sha,
    gitDirty: false,
    buildIdentity: { commit_sha: sha, dirty: false },
    appPackageVersion: '0.1.0',
    plist: { bundle_id: 'example.donna.desktop', short_version: '0.1.0' },
    dmgName: 'Donna-0.1.0-arm64.dmg',
    distMatches: true,
    archs: ['arm64'],
    payloadPresent: true,
    scan: { files: 10, forbidden: [], review: [] },
    signature: { state: 'adhoc', ok: true, detail: 'ad-hoc seal, verifies' }
  };
  assert.equal(buildAgreementChecks(good).ok, true);

  const failing = (patch) => buildAgreementChecks({ ...good, ...patch }).checks.filter((c) => !c.ok).map((c) => c.name);
  assert.deepEqual(failing({ buildIdentity: { commit_sha: 'b'.repeat(40), dirty: false } }), ['build identity commit == checkout HEAD']);
  assert.deepEqual(failing({ buildIdentity: { commit_sha: sha, dirty: true } }), ['build identity is clean (no local changes at packaging time)']);
  assert.deepEqual(failing({ gitDirty: true }), ['checkout is clean now']);
  assert.deepEqual(failing({ appPackageVersion: '0.0.0' }), ['app package.json version == Info.plist version']);
  assert.deepEqual(failing({ dmgName: 'Donna-0.0.9-arm64.dmg' }), ['DMG filename carries the same version']);
  assert.deepEqual(failing({ distMatches: false }), ['frozen dist/ inside the app == checkout dist/ (every file, by content)']);
  assert.deepEqual(failing({ signature: { state: 'broken', ok: false, detail: 'seal does not verify' } }), ['app code signature intact (ad-hoc or Developer ID; "not signed" and a broken seal fail)']);
  assert.deepEqual(failing({ signature: { state: 'unsigned', ok: false, detail: 'not signed at all' } }), ['app code signature intact (ad-hoc or Developer ID; "not signed" and a broken seal fail)']);
  assert.deepEqual(failing({ signature: null }), ['app code signature intact (ad-hoc or Developer ID; "not signed" and a broken seal fail)']);
  assert.equal(buildAgreementChecks({ ...good, signature: { state: 'developer-id', ok: true, detail: 'Developer ID Application: Donna Inc' } }).ok, true);
  assert.deepEqual(failing({ archs: ['x86_64'] }), ['Mach-O arch']);
  assert.deepEqual(failing({ payloadPresent: false }), ['bundled PG payload manifest present']);
  assert.deepEqual(failing({ scan: { files: 3, forbidden: ['Contents/Resources/app/.env'], review: [] } }), ['no forbidden files in the bundle']);
  assert.deepEqual(failing({ plist: { bundle_id: 'com.other', short_version: '0.1.0' } }), ['bundle id']);
});
