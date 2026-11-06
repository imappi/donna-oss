// Regenerate the capability-registry canonical snapshot BUILD ARTIFACT (addendum §2).
//
// A receipt pins registry_fingerprint; the fingerprint proves difference, but only the
// retained snapshot makes history REPRODUCIBLE — this file + git history resolve any
// historical fingerprint back to the full registry it named. capabilityRegistry.test.js
// pins the artifact to the live registry, so a registry change without a regenerated
// snapshot fails CI (run this script in the same commit).
//
// USAGE: node scripts/write_capability_registry_snapshot.js

import { writeFileSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalCapabilityRegistrySnapshot,
  capabilityRegistryFingerprint
} from '../server/donna/capabilityRegistry.js';

const target = resolvePath(dirname(fileURLToPath(import.meta.url)), '../server/donna/capabilityRegistrySnapshot.json');
const artifact = {
  fingerprint: capabilityRegistryFingerprint(),
  capabilities: canonicalCapabilityRegistrySnapshot()
};
writeFileSync(target, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`[capability-registry-snapshot] wrote ${target} (${artifact.fingerprint})`);
