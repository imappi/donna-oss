import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { staticArtifactCheck } from './hostCertificateA.js';
import { loadAdmittedEntityProfileManifest, observeEntityCertificateB } from './entityCertificateB.js';
import { loadOutboundPack } from './outbound/packs.js';

const root = path.resolve(import.meta.dirname, '../..');

test('both hosted function asset declarations preserve the complete certificate inventory', async (t) => {
  const config = JSON.parse(await readFile(path.join(root, 'vercel.json'), 'utf8'));
  const source = await staticArtifactCheck({ rootDir: root });
  assert.equal(source.status, 'PASS');
  const migrations = (await readdir(path.join(root, 'db/migrations'))).filter(name => name.endsWith('.sql')).sort();
  for (const entrypoint of ['api/donna-router.js', 'api/inngest.js']) {
    const destination = await mkdtemp(path.join(os.tmpdir(), 'donna-host-assets-'));
    t.after(() => rm(destination, { recursive: true, force: true }));
    const included = config.functions[entrypoint].includeFiles;
    assert.equal(typeof included, 'string', 'Vercel project schema requires one glob string');
    assert.ok(included.length <= 256 && included.startsWith('{') && included.endsWith('}'));
    const patterns = included.slice(1, -1).split(',');
    // This contract intentionally uses literal files and whole trees only.
    // The separate actual @vercel/node build proof qualifies glob semantics.
    for (const pattern of patterns) {
      const relative = pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern;
      assert.ok(!relative.includes('*') && !relative.includes('..'), `Unsupported asset pattern: ${pattern}`);
      await mkdir(path.dirname(path.join(destination, relative)), { recursive: true });
      await cp(path.join(root, relative), path.join(destination, relative), { recursive: true });
    }
    assert.deepEqual(await staticArtifactCheck({ rootDir: destination }), source, entrypoint);
    assert.deepEqual(await loadAdmittedEntityProfileManifest({ rootDir: destination }),
      await loadAdmittedEntityProfileManifest({ rootDir: root }), entrypoint);
    const pack = loadOutboundPack('fi', { packsRoot: path.join(destination, 'packs'), bypassCache: true });
    assert.ok(pack.chart_of_accounts.fallback_accounts.length > 0);
    for (const creation of ['self-provision', 'existing-owner-adoption']) {
      const profileId = `fi-oy.${creation}.vercel.none.management-books.fi-cloud-pilot-v1`;
      const observe = rootDir => observeEntityCertificateB({ rootDir, profileId,
        firmId: 'synthetic-fi-firm', clientId: 'synthetic-fi-client',
        observedAt: '2026-09-14T00:00:00.000Z', query: async () => ({ rows: [] }) });
      const certificate = await observe(destination);
      assert.deepEqual(certificate, await observe(root), `${entrypoint}: ${profileId}`);
      for (const id of ['admitted_profile', 'country_pack', 'persisted_chart']) {
        assert.equal(certificate.checks.find(check => check.id === id)?.status, 'PASS', id);
      }
      assert.notEqual(certificate.status, 'PASS', 'asset availability never invents a ready entity');
    }
    assert.deepEqual((await readdir(path.join(destination, 'db/migrations'))).filter(name => name.endsWith('.sql')).sort(), migrations, entrypoint);
  }
});
