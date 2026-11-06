#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { buildPhysicalQualification, renderPhysicalQualification } from '../server/donna/inventory/physicalQualification.js';
import { exportPhysicalQualification } from '../server/donna/inventory/physicalQualificationDb.js';

const { values } = parseArgs({ options: {
  snapshot: { type: 'string' }, inputs: { type: 'string' }, firm: { type: 'string' }, client: { type: 'string' },
  actor: { type: 'string' }, 'export-snapshot': { type: 'string' }, json: { type: 'string' }, markdown: { type: 'string' }
} });
let snapshot;
if (values.snapshot) {
  if (values.firm || values.client || values.actor) throw new Error('Use either a saved snapshot or exact database scope.');
  snapshot = JSON.parse(await readFile(values.snapshot, 'utf8'));
} else {
  if (!process.env.DATABASE_URL || !values.firm || !values.client || !values.actor) throw new Error('DATABASE_URL and --firm/--client/--actor required, or supply --snapshot.');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try { snapshot = await exportPhysicalQualification({ client, firmId: values.firm, clientId: values.client, actorId: values.actor }); }
  finally { await client.end(); }
}
const inputs = values.inputs ? JSON.parse(await readFile(values.inputs, 'utf8')) : {};
const report = buildPhysicalQualification(snapshot, inputs);
// Exclusive creation prevents accidental destruction of a retained receipt.
for (const [path, content] of [[values['export-snapshot'], JSON.stringify(snapshot,null,2)+'\n'],
  [values.json, JSON.stringify(report,null,2)+'\n'], [values.markdown, renderPhysicalQualification(report)]]) {
  if (path) await writeFile(path,content,{ flag:'wx', mode:0o600 });
}
if (!values.markdown) process.stdout.write(renderPhysicalQualification(report));
