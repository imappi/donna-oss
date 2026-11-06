import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { withFirmDbClient } from '../server/donna/firmDb.js';

const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations');

const main = async () => {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    const applied = await withFirmDbClient((client) =>
      client.query('select version from schema_migrations where version = $1', [version])
    ).catch((error) => {
      if (file === files[0]) return { rows: [] };
      throw error;
    });
    if (applied.rows.length) {
      console.log(`Skipping ${file}`);
      continue;
    }

    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    await withFirmDbClient(async (client) => {
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (version) values ($1) on conflict (version) do nothing', [version]);
        await client.query('commit');
        console.log(`Applied ${file}`);
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    });
  }
};

main().catch((error) => {
  console.error(error.message || error);
  if (error.code === 'ERR_MODULE_NOT_FOUND') {
    console.error('Install the Postgres driver with `npm install pg` before running migrations.');
  }
  process.exit(1);
});
