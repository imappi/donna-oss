#!/usr/bin/env node
// Records the appliance's PostgreSQL cluster fingerprint so the RT-06 test
// harness can REFUSE it (INV-24 — a session must never run a lifecycle
// fixture against the appliance database). Run ONCE on the appliance, as the
// operator, against the appliance's own DSN; the file it writes is read by
// `bootApplianceForTest` (server/donna/testSupport/applianceHarness.js) before
// any scratch database is provisioned.
//
//   DATABASE_URL=<the appliance DSN> node scripts/record-appliance-fingerprint.mjs
//
// Env:
//   DATABASE_URL                        the appliance's own connection string (READ ONLY:
//                                       the script runs SELECTs against pg_database and
//                                       pg_control_system, and writes nothing to the DB)
//   DONNA_DESKTOP_BLOB_DIR              the object root; its realpath joins the record
//   DONNA_APPLIANCE_FINGERPRINT_FILE    where to write (default ~/.donna/appliance-fingerprint.json)
//
// The record is content-safe: database names + OIDs, the cluster system
// identifier, socket paths, data directory, host machine id and the object
// root realpath. No row data, no credentials — the DSN itself is NOT stored.
import { recordApplianceFingerprint } from '../server/donna/testSupport/applianceHarness.js';

const adminUrl = process.env.DATABASE_URL;
if (!adminUrl) {
  console.error('DATABASE_URL (the appliance DSN) is required');
  process.exit(2);
}
const { file, record } = await recordApplianceFingerprint({
  adminUrl,
  objectRoot: process.env.DONNA_DESKTOP_BLOB_DIR || null
});
console.log(`recorded ${record.schema} → ${file}`);
console.log(JSON.stringify({
  database_names: record.database_names,
  database_oids: record.database_oids,
  system_identifiers: record.system_identifiers,
  socket_paths: record.socket_paths,
  data_directories: record.data_directories,
  object_roots: record.object_roots
}, null, 2));
