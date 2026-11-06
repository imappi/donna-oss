// Read-only operator audit. Deliberately requires its own nonempty URL instead
// of falling back to localhost, a developer .env, or Donna's local data.
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

import { PILOT_REQUIRED_COLUMNS, compareHostedPilotSchema } from '../server/donna/cloudHostSchema.js';
export { PILOT_REQUIRED_COLUMNS, compareHostedPilotSchema };

export const auditHostedPilotParity = async ({ client, root = new URL('../', import.meta.url) }) => {
  const dir = new URL('db/migrations/', root);
  const files = (await readdir(dir)).filter(file => file.endsWith('.sql')).sort();
  const hash = createHash('sha256');
  for (const file of files) { hash.update(file); hash.update(await readFile(new URL(file, dir))); }
  await client.query('begin isolation level repeatable read read only');
  try {
    // A single PostgreSQL connection executes one command at a time.
    const identity = (await client.query("select current_setting('server_version_num') as server_version_num, current_setting('transaction_read_only') as read_only, now() as observed_at")).rows[0];
    const hasMigrationTable = (await client.query("select to_regclass('public.schema_migrations') is not null as present")).rows[0].present;
    const applied = hasMigrationTable ? (await client.query('select version from schema_migrations order by version')).rows.map(row => row.version) : [];
    const columns = (await client.query("select table_name, column_name from information_schema.columns where table_schema='public' order by table_name, column_name")).rows;
    const schema = compareHostedPilotSchema({ expected: files.map(file => file.slice(0, -4)), applied, columns });
    const report = { contract: 'donna.hosted-pilot-parity.v1', identity, migration_content_sha256: hash.digest('hex'), schema,
      // Catalog inventory proves these objects exist; their behavior still
      // requires deployment-specific integration checks, not a version guess.
      triggers: (await client.query("select event_object_table as table_name, trigger_name from information_schema.triggers where trigger_schema='public' order by event_object_table, trigger_name")).rows,
      processing_readiness: 'INCOMPLETE', reason: 'hosted_worker_storage_provider_and_admission_proofs_required' };
    await client.query('rollback');
    return report;
  } catch (error) { await client.query('rollback'); throw error; }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let client;
  try {
    const connectionString = String(process.env.DONNA_HOSTED_AUDIT_DATABASE_URL || '').trim();
    if (!/^postgres(?:ql)?:\/\//.test(connectionString)) throw Object.assign(new Error(), { code: 'HOSTED_AUDIT_URL_REQUIRED' });
    client = new pg.Client({ connectionString, connectionTimeoutMillis: 10000, statement_timeout: 15000,
      application_name: 'donna-hosted-pilot-read-only-audit' });
    await client.connect();
    const report = await auditHostedPilotParity({ client });
    report.source_commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    console.log(JSON.stringify(report, null, 2));
    if (report.schema.status !== 'PASS') process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ status: 'INCOMPLETE', code: error.code || 'HOSTED_AUDIT_FAILED' }));
    process.exitCode = 1;
  } finally { if (client) await client.end(); }
}
