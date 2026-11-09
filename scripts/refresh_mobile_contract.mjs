#!/usr/bin/env node
// Refresh the pinned mobile API contract from a checkout of the mobile app
// repository (imappi/donna-mobile-oss). The contract is OWNED there; this repo
// keeps a byte-identical copy plus a JSON rendition the conformance tests read
// (so the test suite needs no YAML parser).
//
//   git clone --depth 1 https://github.com/imappi/donna-mobile-oss ../donna-mobile-oss
//   node scripts/refresh_mobile_contract.mjs ../donna-mobile-oss
//
// Then run `node --test server/donna/mobile/*.test.js` and review the diff:
// a contract change is a reviewed change to this adapter, never automatic.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'server/donna/mobile/contract');
const checkout = path.resolve(process.argv[2] || path.join(ROOT, '..', 'donna-mobile-oss'));
const source = path.join(checkout, 'contract/mobile-api.yaml');

const yamlText = readFileSync(source, 'utf8');
const commit = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
let YAML;
try {
  YAML = await import('yaml');
} catch {
  console.error('The `yaml` package is not installed here. Run: npx --yes yaml@2.9.0 --help (or npm i --no-save yaml@2.9.0) and retry.');
  process.exit(1);
}
const document = YAML.parse(yamlText);
const sha256 = createHash('sha256').update(yamlText).digest('hex');

writeFileSync(path.join(OUT, 'mobile-api.yaml'), yamlText);
writeFileSync(path.join(OUT, 'mobile-api.json'), `${JSON.stringify(document, null, 1)}\n`);
writeFileSync(path.join(OUT, 'SOURCE.json'), `${JSON.stringify({
  repository: 'https://github.com/imappi/donna-mobile-oss',
  path: 'contract/mobile-api.yaml',
  commit,
  yaml_sha256: sha256,
  contract_version: document?.info?.version || null,
  refresh: 'node scripts/refresh_mobile_contract.mjs <path-to-donna-mobile-oss-checkout>'
}, null, 2)}\n`);
console.log(`Pinned mobile contract ${document?.info?.version} from ${commit} (sha256 ${sha256.slice(0, 12)}…).`);
