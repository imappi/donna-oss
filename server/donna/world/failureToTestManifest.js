import { createHash } from 'node:crypto';

import { canonicalJson } from './unitExecutionReceipt.js';
import { validateDiagnosticReceipt } from './freshEntityDiagnostic.js';

export const FAILURE_TO_TEST_MANIFEST_VERSION = 'eaw.failure-to-test-manifest.v1';
export const FRESH_ENTITY_INCIDENT_LEDGER_VERSION = 'eaw.fresh-entity-incident-ledger.v1';

const COVERAGE_STATUSES = new Set(['protected', 'partial', 'registered_gap']);
const ASSURANCE_TIERS = new Set(['pr-deterministic', 'pr-real-pg', 'nightly-real-runtime', 'release-private-anchor']);
const SHA256 = /^[0-9a-f]{64}$/;

export function validateFailureToTestManifest(manifest, { requiredDescriptions = [], testSources = new Map() } = {}) {
  const errors = [];
  if (!isObject(manifest)) return result(['manifest must be an object']);
  if (manifest.version !== FAILURE_TO_TEST_MANIFEST_VERSION) errors.push(`version must be ${FAILURE_TO_TEST_MANIFEST_VERSION}`);
  if (!Array.isArray(manifest.failures)) return result([...errors, 'failures must be an array']);

  const ids = new Set();
  const testIds = new Set();
  const descriptions = new Set();
  manifest.failures.forEach((failure, index) => {
    const path = `failures[${index}]`;
    if (!isObject(failure)) {
      errors.push(`${path} must be an object`);
      return;
    }
    for (const field of ['id', 'description', 'owning_gate', 'runtime_stage', 'mutation_or_world_id', 'protected_test_id', 'required_assertion']) {
      if (typeof failure[field] !== 'string' || failure[field].trim() === '') errors.push(`${path}.${field} must be a non-empty string`);
    }
    if (ids.has(failure.id)) errors.push(`${path}.id duplicates ${failure.id}`);
    if (testIds.has(failure.protected_test_id)) errors.push(`${path}.protected_test_id duplicates ${failure.protected_test_id}`);
    if (descriptions.has(failure.description)) errors.push(`${path}.description is duplicated`);
    ids.add(failure.id);
    testIds.add(failure.protected_test_id);
    descriptions.add(failure.description);
    if (!COVERAGE_STATUSES.has(failure.current_status)) errors.push(`${path}.current_status is invalid`);
    if (!ASSURANCE_TIERS.has(failure.assurance_tier)) errors.push(`${path}.assurance_tier is invalid`);

    if (failure.current_status === 'registered_gap') {
      if (failure.test_path !== null || failure.test_name !== null) errors.push(`${path} registered_gap cannot claim an implemented protected test`);
    } else {
      if (typeof failure.test_path !== 'string' || !failure.test_path.endsWith('.test.js')) errors.push(`${path}.test_path must name a test file`);
      if (typeof failure.test_name !== 'string' || failure.test_name.trim() === '') errors.push(`${path}.test_name must be non-empty`);
      const source = testSources.get(failure.test_path);
      if (typeof source !== 'string') errors.push(`${path}.test_path is absent from the supplied test inventory`);
      else if (!source.includes(failure.test_name)) errors.push(`${path}.test_name is absent from ${failure.test_path}`);
    }
  });

  const expected = [...requiredDescriptions];
  const missing = expected.filter((description) => !descriptions.has(description));
  const extra = [...descriptions].filter((description) => !expected.includes(description));
  if (missing.length) errors.push(`registered design failures missing from manifest: ${missing.join(' | ')}`);
  if (extra.length) errors.push(`manifest failures absent from design register: ${extra.join(' | ')}`);
  return result(errors);
}

export function buildFailureToTestReport(manifest) {
  const failures = Array.isArray(manifest?.failures) ? manifest.failures : [];
  const byStatus = { protected: 0, partial: 0, registered_gap: 0 };
  const byGate = {};
  for (const failure of failures) {
    if (Object.hasOwn(byStatus, failure.current_status)) byStatus[failure.current_status] += 1;
    const gate = byGate[failure.owning_gate] ??= { protected: 0, partial: 0, registered_gap: 0, verdict: 'PASS' };
    if (Object.hasOwn(gate, failure.current_status)) gate[failure.current_status] += 1;
  }
  for (const gate of Object.values(byGate)) {
    gate.verdict = gate.registered_gap > 0 || gate.partial > 0 ? 'INCOMPLETE' : 'PASS';
  }
  return Object.freeze({
    version: FAILURE_TO_TEST_MANIFEST_VERSION,
    verdict: byStatus.registered_gap > 0 || byStatus.partial > 0 ? 'INCOMPLETE' : 'PASS',
    total: failures.length,
    mapped: failures.filter(({ protected_test_id }) => typeof protected_test_id === 'string' && protected_test_id.trim()).length,
    by_status: Object.freeze(byStatus),
    by_gate: Object.freeze(byGate),
  });
}

export function validateFreshEntityIncidentLedger(ledger, { testSources = new Map(), reproducerSources = new Map(), diagnosticReceiptSources = new Map() } = {}) {
  const errors = [];
  if (!isObject(ledger)) return result(['incident ledger must be an object']);
  if (ledger.version !== FRESH_ENTITY_INCIDENT_LEDGER_VERSION) errors.push(`version must be ${FRESH_ENTITY_INCIDENT_LEDGER_VERSION}`);
  if (!Array.isArray(ledger.incidents)) return result([...errors, 'incidents must be an array']);
  const ids = new Set();
  for (const [index, incident] of ledger.incidents.entries()) {
    const path = `incidents[${index}]`;
    for (const field of ['incident_id', 'stage', 'reason_code', 'status', 'protected_test_id', 'test_path', 'test_name']) {
      if (typeof incident?.[field] !== 'string' || incident[field].trim() === '') errors.push(`${path}.${field} must be a non-empty string`);
    }
    if (ids.has(incident?.incident_id)) errors.push(`${path}.incident_id is duplicated`);
    ids.add(incident?.incident_id);
    if (!['resolved', 'active', 'watch'].includes(incident?.status)) errors.push(`${path}.status is invalid`);
    const source = testSources.get(incident?.test_path);
    if (typeof source !== 'string') errors.push(`${path}.test_path is absent from the supplied test inventory`);
    else if (!source.includes(incident.test_name)) errors.push(`${path}.test_name is absent from ${incident.test_path}`);
    if (incident?.reproducer_path != null) {
      const reproducer = reproducerSources.get(incident.reproducer_path);
      if (typeof reproducer !== 'string') errors.push(`${path}.reproducer_path is absent`);
      else {
        try {
          const parsed = JSON.parse(reproducer);
          if (parsed.fictional !== true || parsed.incident_id !== incident.incident_id) errors.push(`${path}.reproducer_path is not the incident's fictional reproducer`);
        } catch {
          errors.push(`${path}.reproducer_path is not valid JSON`);
        }
      }
    }
    if (incident?.diagnostic_receipt_path != null) {
      const diagnosticSource = diagnosticReceiptSources.get(incident.diagnostic_receipt_path);
      if (typeof diagnosticSource !== 'string') errors.push(`${path}.diagnostic_receipt_path is absent`);
      else {
        try {
          const diagnostic = JSON.parse(diagnosticSource);
          const validation = validateDiagnosticReceipt(diagnostic);
          if (!validation.ok) errors.push(`${path}.diagnostic_receipt_path is invalid: ${validation.errors.join('; ')}`);
          if (diagnostic.incident_id !== incident.incident_id || diagnostic.first_divergence?.stage !== incident.stage) {
            errors.push(`${path}.diagnostic_receipt_path does not localize this incident`);
          }
        } catch {
          errors.push(`${path}.diagnostic_receipt_path is not valid JSON`);
        }
      }
    }
  }
  if (typeof ledger.source_digest !== 'string' || !SHA256.test(ledger.source_digest)) errors.push('source_digest must be a lowercase SHA-256 digest');
  else {
    const expectedDigest = createHash('sha256').update(canonicalJson(ledger.incidents)).digest('hex');
    if (ledger.source_digest !== expectedDigest) errors.push('source_digest does not match the canonical incident ledger');
  }
  return result(errors);
}

function result(errors) {
  return { ok: errors.length === 0, errors };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
