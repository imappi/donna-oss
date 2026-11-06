// RT-09 (audit F-06) — the host-wait vocabulary is pinned, exhaustive, and
// ratcheted against the code that mints it.
//
// The rule in runtimeReadiness.js charges no episode budget when an entity's
// first certificate failure is a host-wait reason. Two failure modes this
// file exists to catch: a NEW host-side code minted by
// entityCertificateB.js's hostCompatibilityCheck (or a new freshness reason
// in hostCertificateA.js) that nobody classified — it would silently start
// burning budgets again — and a wait code quietly dropped from the list.
// Every code the host check can mint must be classified deliberately as a
// WAIT (host not ready; healed by the next PASS renewal) or an
// INCOMPATIBILITY (the entity's declaration does not fit this host; a
// renewal heals nothing; budgeted).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { REQUIRED_HOST_COMPATIBILITY_CHECKS } from './entityCertificateB.js';
import {
  ENTITY_READINESS_HOST_INCOMPATIBILITY_REASON_CODES,
  ENTITY_READINESS_HOST_INCOMPATIBILITY_REASON_PREFIXES,
  ENTITY_READINESS_HOST_WAIT_REASON_CODES,
  isEntityReadinessHostWaitReason,
  listTargetedEntityReadinessRecoveryCandidates
} from './runtimeReadiness.js';

const certificateBSource = readFileSync(new URL('./entityCertificateB.js', import.meta.url), 'utf8');
const certificateASource = readFileSync(new URL('./hostCertificateA.js', import.meta.url), 'utf8');

const functionSource = (source, marker) => {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `source marker not found: ${marker}`);
  const end = source.indexOf('\n};\n', start);
  assert.ok(end > start, `function end not found after: ${marker}`);
  return source.slice(start, end);
};

test('the host-wait list is exactly the pinned vocabulary (a change here is a deliberate budget decision)', () => {
  assert.deepEqual([...ENTITY_READINESS_HOST_WAIT_REASON_CODES], [
    'host_certificate_missing',
    'host_certificate_version_mismatch',
    'host_certificate_not_pass',
    'host_database_schema_not_pass',
    'host_scheduler_worker_manifest_not_pass',
    'host_evidence_storage_not_pass',
    'host_policy_oracle_artifacts_not_pass',
    'host_config_control_plane_not_pass',
    'host_accounting_adapter_not_pass',
    'host_certificate_digest_missing',
    'host_certificate_digest_mismatch',
    'host_compatibility_contract_version_mismatch',
    'host_compatibility_digest_missing',
    'host_compatibility_digest_mismatch',
    'host_freshness_contract_invalid',
    'host_certificate_not_yet_valid',
    'host_certificate_expired'
  ]);
  assert.deepEqual([...ENTITY_READINESS_HOST_INCOMPATIBILITY_REASON_CODES], [
    'runtime_host_mismatch',
    'desktop_storage_provider_mismatch',
    'accounting_adapter_not_registered'
  ]);
  assert.deepEqual([...ENTITY_READINESS_HOST_INCOMPATIBILITY_REASON_PREFIXES], ['host_capability_key_unsupported:']);
  for (const code of ENTITY_READINESS_HOST_INCOMPATIBILITY_REASON_CODES) {
    assert.equal(ENTITY_READINESS_HOST_WAIT_REASON_CODES.includes(code), false, `${code} is classified once`);
  }
  // Host A v5 no longer mints these three companions (RT-01): they are not
  // waits the runtime can enter any more, so they are not in the live list.
  for (const retired of ['host_source_build_not_pass', 'host_model_routes_not_pass', 'host_spend_meter_not_pass']) {
    assert.equal(isEntityReadinessHostWaitReason(retired), false, `${retired} is a pre-v5 code`);
  }
  assert.equal(isEntityReadinessHostWaitReason('host_certificate_not_pass'), true);
  assert.equal(isEntityReadinessHostWaitReason(' host_certificate_expired '), true, 'the predicate trims');
  assert.equal(isEntityReadinessHostWaitReason('entity_dependency_changed'), false);
  assert.equal(isEntityReadinessHostWaitReason('host_capability_key_unsupported:FOO'), false);
  assert.equal(isEntityReadinessHostWaitReason(null), false);
});

test('every code hostCompatibilityCheck can mint is classified — a new host code cannot silently burn budgets', () => {
  const hostCheck = functionSource(certificateBSource, 'const hostCompatibilityCheck = (');
  const waits = new Set(ENTITY_READINESS_HOST_WAIT_REASON_CODES);
  const charged = new Set(ENTITY_READINESS_HOST_INCOMPATIBILITY_REASON_CODES);
  const classified = (code) => waits.has(code) || charged.has(code);
  const seen = new Set();

  // The INCOMPLETE receipt when no Host A row exists at all.
  const incomplete = hostCheck.match(/failures:\s*\['([^']+)'\]/);
  assert.ok(incomplete, 'the missing-certificate INCOMPLETE branch names its code');
  seen.add(incomplete[1]);
  assert.ok(waits.has(incomplete[1]), `${incomplete[1]} is a host wait`);

  // String-literal pushes.
  for (const [, code] of hostCheck.matchAll(/failures\.push\('([^']+)'\)/g)) {
    seen.add(code);
    assert.ok(classified(code), `unclassified host compatibility code: ${code} — add it to the WAIT or INCOMPATIBILITY list deliberately`);
  }

  // Template pushes: exactly two shapes are known; any other must be classified by hand.
  const templates = [...hostCheck.matchAll(/failures\.push\(`([^`]+)`\)/g)].map(([, body]) => body);
  assert.ok(templates.length >= 2, 'the per-check and per-key template pushes are present');
  for (const template of templates) {
    if (template === 'host_${id}_not_pass') {
      for (const id of REQUIRED_HOST_COMPATIBILITY_CHECKS) {
        const code = `host_${id}_not_pass`;
        seen.add(code);
        assert.ok(waits.has(code), `${code} (a required host check not PASS) is a host wait`);
      }
      continue;
    }
    const prefix = template.replace(/\$\{[^}]+\}$/, '');
    if (prefix !== template && ENTITY_READINESS_HOST_INCOMPATIBILITY_REASON_PREFIXES.includes(prefix)) {
      assert.equal(prefix, 'host_capability_key_unsupported:');
      continue;
    }
    assert.fail(`unclassified host compatibility template: \`${template}\``);
  }

  // The freshness reasons ride in through `failures.push(freshness.reason)`.
  assert.match(hostCheck, /failures\.push\(freshness\.reason\)/);
  const freshness = functionSource(certificateASource, 'export const evaluateHostCertificateFreshness = (');
  const freshnessReasons = [...freshness.matchAll(/reason:\s*'([a-z_]+)'/g)].map(([, code]) => code);
  assert.deepEqual(freshnessReasons, [
    'host_freshness_contract_invalid',
    'host_certificate_not_yet_valid',
    'host_certificate_expired'
  ]);
  for (const code of freshnessReasons) {
    seen.add(code);
    assert.ok(waits.has(code), `${code} (a stale or malformed receipt) is a host wait`);
  }

  // No dead entries: every WAIT code is something the check actually mints.
  for (const code of waits) assert.ok(seen.has(code), `${code} is in the wait list but hostCompatibilityCheck never mints it`);
  for (const code of charged) assert.ok(seen.has(code), `${code} is in the incompatibility list but hostCompatibilityCheck never mints it`);
});

test('the recovery candidate query accepts a clockless host wait only when the PASS-transition heal asks for it', async () => {
  const calls = [];
  const withFirmDbClientFn = async (fn) => fn({
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [] };
    }
  });
  await listTargetedEntityReadinessRecoveryCandidates({ withFirmDbClientFn, asOf: '2026-09-02T09:00:00.000Z' });
  await listTargetedEntityReadinessRecoveryCandidates({ withFirmDbClientFn, asOf: '2026-09-02T09:00:00.000Z', includeHostWait: false });
  assert.equal(calls.length, 2);
  for (const { sql } of calls) {
    assert.match(sql, /\(\$6::boolean and saga\.next_retry_at is null\) or saga\.next_retry_at <= \$2::timestamptz/);
    assert.equal((sql.match(/\$6::boolean/g) || []).length, 2, 'both enrollment branches honour the switch');
    assert.match(sql, /saga\.client_id is null/, 'an absent saga on a manual canary is still selected regardless');
  }
  assert.equal(calls[0].params[5], true, 'the renewal-time heal selects host waits');
  assert.equal(calls[1].params[5], false, 'the queue-activity heal leaves them to the host transition');
});
