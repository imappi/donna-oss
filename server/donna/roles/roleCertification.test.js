// roleCertification (S6) — the gate above the lanes. Pins:
//   - the manifest lint: R1×GB×v1 validates clean; core worlds and leash
//     tests must exist in the tree; max_gaps and max_would_blocks are pinned 0;
//   - the HONESTY RULE: empty evidence reads red with insufficient_data on
//     every requirement — never green;
//   - INV-S9: a green constituent model lane alone is NOT a certified role;
//   - the gate is arithmetic, not a hardcoded red: fully green evidence
//     evaluates green;
//   - observed would-blocks REFUTE (fail), they are not thin data;
//   - runtime-version mismatch refuses (a certification must not outlive the
//     runtime it certified);
//   - the claim ladder is fail-closed: null / unsigned / undeclared-manifest /
//     stale-vintage records all read 'preview'; only a signed green record on
//     a declared manifest at the CURRENT runtime vintage reads 'autonomous' —
//     and the registry carries none today;
//   - the ceremony's terms are enforced (WHO-SIGNS, §10.8): only the signer
//     of record signs, the verdict reference must live under
//     data/certifications/ and is refused UNREAD anywhere else, and
//     signed_at must be a real ISO date;
//   - the verdict artifact's green gate is RE-DERIVED from its own numbers —
//     a verdict is its evidence's arithmetic, not a field;
//   - the journey-report laws (kind, identity, vintage) live IN the
//     arithmetic: an embedded bare { gate: 'PASS' } blob refutes at every
//     layer, the record layer included;
//   - the leash RUN REPORT is the evidence (rides the gather, embedded in
//     the verdict): green is read FROM it, it answers for kind and vintage
//     in the arithmetic, and hand-authored rows alone are never green;
//   - the verdict artifact is unsigned and never claims (nothing
//     auto-certifies);
//   - gather: observation evidence counts role-leash-passed SENT receipts for
//     the role's send verbs only, models ride from the receipts.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CERTIFICATION_CLAIMS,
  CURRENT_ROLE_RUNTIME_VERSION,
  DB_GATHERED_REQUIREMENTS,
  ROLE_CERTIFICATION_ARTIFACT_HOME,
  ROLE_CERTIFICATION_MANIFESTS,
  ROLE_CERTIFICATION_OFFLINE_PREVIEW_ARTIFACT,
  ROLE_CERTIFICATION_SIGNERS,
  ROLE_CERTIFICATION_VERDICT_ARTIFACT,
  ROLE_JOURNEY_RUN_ARTIFACT,
  ROLE_LEASH_TEST_RUN_ARTIFACT,
  buildRoleCertificationOfflinePreview,
  buildRoleCertificationVerdict,
  certificationClaimForRole,
  certificationSummaryForRole,
  evaluateRoleCertification,
  findCertificationManifest,
  gatherRoleCertificationEvidence,
  manifestsForRole,
  validateCertificationRecord,
  validateRoleCertificationManifests
} from './roleCertification.js';
import { ROLE_DEFINITIONS, findRoleDefinition } from './roleRegistry.js';

const MANIFEST = findCertificationManifest('invoicing_collections', 'GB', 1);

const REQUIREMENT_NAMES = [
  'model_lane_gates', 'eaw_core_curriculum', 'eaw_role_curriculum',
  'journey_tests', 'leash_tests', 'wiring_coverage',
  'observation_evidence', 'runtime_version'
];

const greenEvidence = () => ({
  lane_gates: Object.fromEntries(MANIFEST.required_model_lane_gates.map((id) =>
    [id, { verdict: 'green', insufficient_data: false, reasons: [] }])),
  eaw_reports: Object.fromEntries([
    ...MANIFEST.required_eaw_core_curriculum.map((id) => [id, { gate: 'PASS' }]),
    ...MANIFEST.required_eaw_role_curriculum.map((entry) => [entry.id, { gate: 'PASS' }])
  ]),
  // Gathered journey evidence is the producer's report passed through, so the
  // fixture carries the artifact kind, the journey id and the runtime vintage
  // the real gather demands of supplied ones.
  journey_runs: Object.fromEntries(MANIFEST.required_journey_tests.map((entry) =>
    [entry.id, {
      artifact: ROLE_JOURNEY_RUN_ARTIFACT, journey: entry.id,
      runtime_version: CURRENT_ROLE_RUNTIME_VERSION, gate: 'PASS'
    }])),
  leash_tests: Object.fromEntries(MANIFEST.required_leash_tests.map((relPath) =>
    [relPath, { exists: true, green: true }])),
  // The report the rows were derived from (2026-08-16): the arithmetic reads
  // green FROM it and asks its kind and vintage — rows alone are not evidence.
  leash_test_run: {
    artifact: ROLE_LEASH_TEST_RUN_ARTIFACT,
    runtime_version: CURRENT_ROLE_RUNTIME_VERSION,
    gate: 'PASS',
    files: Object.fromEntries(MANIFEST.required_leash_tests.map((relPath) =>
      [relPath, { green: true }]))
  },
  wiring: { surface: 'roleActionSurface.R1_AUTONOMOUS_SURFACE', gaps: [] },
  observation: {
    table_present: true,
    role_receipts: 500,
    would_blocks: 0,
    first_receipt_at: '2026-07-01T00:00:00.000Z',
    last_receipt_at: '2026-07-31T00:00:00.000Z',
    window_days: 30,
    models: ['gpt-5.4']
  },
  runtime_version: MANIFEST.runtime_version
});

// Fake client covering the gather's SQL surface (the roleRoster.test.js
// harness style). model_challenger_runs reads absent so lane gates come back
// red-with-insufficient — today's honest state.
const makeClient = ({
  receiptsRow = { role_receipts: 0, first_receipt_at: null, last_receipt_at: null },
  modelRows = [],
  wouldBlocks = 0
} = {}) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      const text = String(sql);
      calls.push({ sql: text, params });
      if (text.includes("to_regclass('public.model_challenger_runs')")) return { rows: [{ present: null }] };
      if (text.includes("to_regclass('public.outbound_action_receipts')")) return { rows: [{ present: 'outbound_action_receipts' }] };
      if (text.includes('count(*)::int as role_receipts')) return { rows: [receiptsRow] };
      if (text.includes('select distinct model')) return { rows: modelRows };
      if (text.includes('specialist_role.would_block')) return { rows: [{ would_blocks: wouldBlocks }] };
      throw new Error(`unexpected sql: ${text}`);
    }
  };
};

// ── The manifest lint ───────────────────────────────────────────────────────

test('the declared manifests validate clean (roles, lanes, worlds, leash files, pinned zeros)', () => {
  assert.deepEqual(validateRoleCertificationManifests(), []);
});

test('R1×GB×v1 exists and is the only manifest; lookups resolve it', () => {
  assert.equal(ROLE_CERTIFICATION_MANIFESTS.length, 1);
  assert.ok(MANIFEST);
  assert.equal(MANIFEST.runtime_version, CURRENT_ROLE_RUNTIME_VERSION);
  assert.deepEqual(manifestsForRole('invoicing_collections'), [MANIFEST]);
  assert.deepEqual(manifestsForRole('tax'), []);
  assert.equal(findCertificationManifest('invoicing_collections', 'FI', 1), null);
});

test('a missing world fixture, leash-test file or journey file fails the lint (the fs half is real)', () => {
  const problems = validateRoleCertificationManifests({ deps: { existsSync: () => false } });
  assert.ok(problems.some((p) => p.includes("core world 'proof0' has no fixture")));
  assert.ok(problems.some((p) => p.includes('leash test') && p.includes('does not exist')));
  // The journeys are BUILT (2026-08-15), so a declared journey whose defining
  // file is gone is a lint failure — not a requirement that quietly waits
  // forever for a run report nothing can produce.
  assert.ok(problems.some((p) => p.includes('journey') && p.includes('does not exist')));
});

test('every declared journey names a file that really exists in the tree', () => {
  for (const entry of MANIFEST.required_journey_tests) {
    assert.ok(entry.file, `${entry.id} must name its defining file`);
  }
  // The real fs, not the injected double: the declaration is checked against
  // the running tree (the verify-the-running-tree rail).
  assert.deepEqual(validateRoleCertificationManifests(), []);
});

// ── The honesty rule ────────────────────────────────────────────────────────

test('empty evidence reads red with insufficient_data; every requirement is present and red', () => {
  const gate = evaluateRoleCertification({ manifest: MANIFEST, evidence: {} });
  assert.equal(gate.verdict, 'red');
  assert.equal(gate.insufficient_data, true);
  assert.deepEqual(Object.keys(gate.requirements).sort(), [...REQUIREMENT_NAMES].sort());
  for (const name of REQUIREMENT_NAMES) {
    assert.equal(gate.requirements[name].verdict, 'red', `${name} must read red on no evidence`);
  }
});

test('no manifest reads red, never green', () => {
  const gate = evaluateRoleCertification({ manifest: null, evidence: greenEvidence() });
  assert.equal(gate.verdict, 'red');
  assert.equal(gate.insufficient_data, true);
});

// ── INV-S9: a green lane is not a certified role ────────────────────────────

test('INV-S9: all constituent lane gates green but nothing else ⇒ still red', () => {
  const evidence = { lane_gates: greenEvidence().lane_gates };
  const gate = evaluateRoleCertification({ manifest: MANIFEST, evidence });
  assert.equal(gate.verdict, 'red');
  assert.equal(gate.requirements.model_lane_gates.verdict, 'green');
  assert.equal(gate.requirements.eaw_role_curriculum.verdict, 'red');
  assert.equal(gate.requirements.observation_evidence.verdict, 'red');
});

// ── The gate is arithmetic ──────────────────────────────────────────────────

test('fully green evidence evaluates green with sufficient data (the gate CAN pass)', () => {
  const gate = evaluateRoleCertification({ manifest: MANIFEST, evidence: greenEvidence() });
  assert.equal(gate.verdict, 'green');
  assert.equal(gate.insufficient_data, false);
  assert.deepEqual(gate.reasons, []);
});

test('observed would-blocks REFUTE the leash claim (a fail, not thin data)', () => {
  const evidence = greenEvidence();
  evidence.observation = { ...evidence.observation, would_blocks: 1 };
  const gate = evaluateRoleCertification({ manifest: MANIFEST, evidence });
  assert.equal(gate.verdict, 'red');
  assert.equal(gate.insufficient_data, false);
  assert.ok(gate.reasons.some((r) => r.code === 'would_blocks_observed'));
});

test('a thin observation window is insufficient, not a pass', () => {
  const evidence = greenEvidence();
  evidence.observation = { ...evidence.observation, role_receipts: 3, window_days: 2 };
  const gate = evaluateRoleCertification({ manifest: MANIFEST, evidence });
  assert.equal(gate.verdict, 'red');
  assert.equal(gate.insufficient_data, true);
  assert.ok(gate.reasons.some((r) => r.code === 'insufficient_role_receipts'));
  assert.ok(gate.reasons.some((r) => r.code === 'observation_window_too_short'));
});

test('a runtime-version mismatch refuses: certification must not outlive its runtime', () => {
  const evidence = { ...greenEvidence(), runtime_version: MANIFEST.runtime_version + 1 };
  const gate = evaluateRoleCertification({ manifest: MANIFEST, evidence });
  assert.equal(gate.verdict, 'red');
  assert.ok(gate.reasons.some((r) => r.code === 'runtime_version_mismatch'));
});

test('a red (non-insufficient) lane gate fails rather than reading thin', () => {
  const evidence = greenEvidence();
  const [laneId] = MANIFEST.required_model_lane_gates;
  evidence.lane_gates[laneId] = {
    verdict: 'red', insufficient_data: false, reasons: [{ code: 'decision_agreement_below_threshold' }]
  };
  const gate = evaluateRoleCertification({ manifest: MANIFEST, evidence });
  assert.equal(gate.verdict, 'red');
  assert.equal(gate.insufficient_data, false);
  assert.ok(gate.reasons.some((r) => r.code === 'lane_gate_red'));
});

// ── The claim ladder (fail-closed) ──────────────────────────────────────────

const signedRecord = () => ({
  manifest: { role: 'invoicing_collections', jurisdiction: 'GB', version: 1 },
  verdict: 'green',
  verdict_artifact: 'data/certifications/invoicing_collections-GB-v1-2026-08-14.json',
  // The vintage the verdict was gathered at (2026-08-16): the claim ladder
  // reads 'preview' the moment the runtime moves past it.
  runtime_version: CURRENT_ROLE_RUNTIME_VERSION,
  signed_by: 'kari',
  signed_at: '2026-08-14'
});

// The committed verdict artifact the ceremony reads (WHO-SIGNS, 2026-08-16):
// validation opens the referenced file and checks it IS the verdict the
// record claims. Tests inject the read so the pins stay fs-free. It carries
// honest green numbers because the validator RE-DERIVES the gate from them
// (2026-08-16): a verdict is its evidence's arithmetic, not a field.
const verdictBlob = () => ({
  artifact: ROLE_CERTIFICATION_VERDICT_ARTIFACT,
  manifest: {
    role: 'invoicing_collections', jurisdiction: 'GB', version: 1,
    runtime_version: CURRENT_ROLE_RUNTIME_VERSION
  },
  gate: { verdict: 'green' },
  numbers: greenEvidence()
});

const artifactDeps = (blob = verdictBlob()) => ({ deps: { readArtifact: () => blob } });

test('claim ladder: null reads preview; a valid signed record with a real verdict artifact reads autonomous', () => {
  const role = findRoleDefinition('invoicing_collections');
  assert.deepEqual(CERTIFICATION_CLAIMS, ['preview', 'autonomous']);
  assert.equal(certificationClaimForRole(role), 'preview');
  assert.equal(
    certificationClaimForRole({ ...role, certification: signedRecord() }, artifactDeps()),
    'autonomous'
  );
});

test('claim ladder: unsigned, non-green, artifact-less, undeclared-manifest, or stale-vintage records all read preview', () => {
  const role = findRoleDefinition('invoicing_collections');
  const staleVintage = { ...signedRecord(), runtime_version: CURRENT_ROLE_RUNTIME_VERSION + 1 };
  const noVintage = (({ runtime_version, ...rest }) => rest)(signedRecord());
  const cases = [
    { ...signedRecord(), signed_by: null },
    { ...signedRecord(), signed_at: '' },
    { ...signedRecord(), verdict: 'red' },
    { ...signedRecord(), verdict_artifact: null },
    { ...signedRecord(), manifest: { role: 'invoicing_collections', jurisdiction: 'FI', version: 1 } },
    { ...signedRecord(), manifest: { role: 'tax', jurisdiction: 'GB', version: 1 } },
    staleVintage,
    noVintage,
    'not-an-object'
  ];
  for (const record of cases) {
    assert.ok(validateCertificationRecord(role.id, record, artifactDeps()).length > 0, 'the record must be refused');
    assert.equal(certificationClaimForRole({ ...role, certification: record }, artifactDeps()), 'preview');
  }
  // The vintage law at the CLAIM layer (2026-08-16): a signed record from a
  // runtime the current one has moved past degrades to preview AUTOMATICALLY —
  // this is what makes "a certification must never quietly outlive the runtime
  // it certified" machine-checked end to end (the gather refuses stale
  // EVIDENCE; the ladder refuses the stale CLAIM). The problem message names
  // both versions and the way back.
  const problems = validateCertificationRecord(role.id, staleVintage, artifactDeps());
  assert.ok(
    problems.some((p) => p.includes(`certifies runtime v${CURRENT_ROLE_RUNTIME_VERSION + 1}`)
      && p.includes(`the runtime is v${CURRENT_ROLE_RUNTIME_VERSION}`)
      && p.includes('re-gather, re-evaluate, re-sign')),
    JSON.stringify(problems)
  );
  assert.ok(
    validateCertificationRecord(role.id, noVintage, artifactDeps())
      .some((p) => p.includes('must state the runtime vintage')),
    'a record with no vintage must be refused by name'
  );
});

test('the ceremony verifies the attached verdict artifact — a preview can never back an Autonomous claim', () => {
  const role = findRoleDefinition('invoicing_collections');
  const claimWith = (blobOrNull) =>
    certificationClaimForRole({ ...role, certification: signedRecord() }, artifactDeps(blobOrNull));

  // THE pin this slice exists for (the module's own stated law, enforced at
  // the record layer at last): a signed record referencing the never-signable
  // OFFLINE PREVIEW artifact is refused by kind.
  const preview = { ...verdictBlob(), artifact: ROLE_CERTIFICATION_OFFLINE_PREVIEW_ARTIFACT };
  assert.equal(claimWith(preview), 'preview');
  assert.ok(
    validateCertificationRecord(role.id, signedRecord(), artifactDeps(preview))
      .some((p) => p.includes(ROLE_CERTIFICATION_OFFLINE_PREVIEW_ARTIFACT)
        && p.includes('can never back an Autonomous claim')),
    'the preview kind must be refused by name'
  );

  // Missing from the tree: a signed verdict is COMMITTED evidence.
  assert.equal(claimWith(null), 'preview');
  assert.ok(
    validateCertificationRecord(role.id, signedRecord(), artifactDeps(null))
      .some((p) => p.includes('does not exist in the tree')),
    'a dangling reference must be refused by name'
  );

  // A red-gate verdict is unsignable; signing it anyway must not stick.
  assert.equal(claimWith({ ...verdictBlob(), gate: { verdict: 'red' } }), 'preview');

  // The artifact must certify the record's own coordinates and vintage.
  assert.equal(
    claimWith({ ...verdictBlob(), manifest: { ...verdictBlob().manifest, jurisdiction: 'FI' } }),
    'preview'
  );
  assert.equal(
    claimWith({ ...verdictBlob(), manifest: { ...verdictBlob().manifest, runtime_version: CURRENT_ROLE_RUNTIME_VERSION + 1 } }),
    'preview'
  );

  // An unreadable artifact refuses loudly rather than silently passing.
  const unreadable = {
    deps: { readArtifact: () => { throw new Error('EACCES: permission denied'); } }
  };
  assert.ok(
    validateCertificationRecord(role.id, signedRecord(), unreadable)
      .some((p) => p.includes('is unreadable')),
    'a read error is a named problem, not a pass'
  );

  // The real thing still validates clean.
  assert.deepEqual(validateCertificationRecord(role.id, signedRecord(), artifactDeps()), []);
});

test("the ceremony's terms are enforced: signer of record, committed home, dated signature", () => {
  const role = findRoleDefinition('invoicing_collections');
  // The WHO-SIGNS decision as data (design §10.8): Kari, by name. A second
  // name here is a new dated decision.
  assert.deepEqual(ROLE_CERTIFICATION_SIGNERS, ['kari']);
  assert.equal(ROLE_CERTIFICATION_ARTIFACT_HOME, 'data/certifications/');

  // THE pin: a signer who is not the signer of record is refused BY NAME.
  // Before this slice any non-empty string signed — 'system' validating
  // alongside 'kari' is auto-sign's door left ajar (argued and rejected in
  // §10.8), one field wide.
  for (const signed_by of ['system', 'donna', 'product_owner']) {
    const record = { ...signedRecord(), signed_by };
    assert.equal(certificationClaimForRole({ ...role, certification: record }, artifactDeps()), 'preview');
    assert.ok(
      validateCertificationRecord(role.id, record, artifactDeps())
        .some((p) => p.includes(`signed by '${signed_by}'`) && p.includes('not a signer of record')),
      `'${signed_by}' must be refused as a signer, by name`
    );
  }

  // The home law refuses UNREAD: a reference outside data/certifications/ —
  // a loose in-tree file, a '../' hop escaping the tree, an absolute path, a
  // backslash sneak — is judged before it is dereferenced, so the validator
  // never opens a path on the strength of an unvalidated record.
  const outside = [
    'server/donna/roles/roleCertification.test.js',
    '../outside-the-tree/verdict.json',
    'data/certifications/../../package.json',
    '/etc/donna/verdict.json',
    'data\\certifications\\verdict.json'
  ];
  for (const verdict_artifact of outside) {
    let reads = 0;
    const spy = { deps: { readArtifact: () => { reads += 1; return verdictBlob(); } } };
    const record = { ...signedRecord(), verdict_artifact };
    const problems = validateCertificationRecord(role.id, record, spy);
    assert.ok(
      problems.some((p) => p.includes(ROLE_CERTIFICATION_ARTIFACT_HOME) && p.includes('refused unread')),
      `'${verdict_artifact}' must be refused by the home law: ${JSON.stringify(problems)}`
    );
    assert.equal(reads, 0, `'${verdict_artifact}' must not be dereferenced`);
    assert.equal(certificationClaimForRole({ ...role, certification: record }, spy), 'preview');
  }

  // "A dated commit" needs an actual date: a signature that cannot say when
  // the ceremony happened is not dated.
  for (const signed_at of ['yes', 'last week', '14/08/2026', '2026-13-99']) {
    const record = { ...signedRecord(), signed_at };
    assert.equal(certificationClaimForRole({ ...role, certification: record }, artifactDeps()), 'preview');
    assert.ok(
      validateCertificationRecord(role.id, record, artifactDeps())
        .some((p) => p.includes('is not an ISO date')),
      `'${signed_at}' must be refused as undated`
    );
  }
  // A date-time form still signs — the law is "a real ISO date", not midnight.
  assert.deepEqual(
    validateCertificationRecord(role.id, { ...signedRecord(), signed_at: '2026-08-16T09:30:00Z' }, artifactDeps()),
    []
  );
});

test("the verdict is its evidence's arithmetic: a green gate the artifact's own numbers do not support is refused", () => {
  const role = findRoleDefinition('invoicing_collections');
  const claimWith = (blob) =>
    certificationClaimForRole({ ...role, certification: signedRecord() }, artifactDeps(blob));

  // THE pin: a committed file wearing the verdict kind with `gate: green`
  // over NO evidence at all — the cheapest possible lie — is refused by name.
  const noNumbers = (({ numbers, ...rest }) => rest)(verdictBlob());
  assert.equal(claimWith(noNumbers), 'preview');
  assert.ok(
    validateCertificationRecord(role.id, signedRecord(), artifactDeps(noNumbers))
      .some((p) => p.includes("its evidence's arithmetic, not a field")),
    'a numbers-less green verdict must be refused by name'
  );

  // Refuted evidence under a green gate field: a would-block observed
  // re-evaluates red on evidence, not thin.
  const refuted = verdictBlob();
  refuted.numbers.observation.would_blocks = 3;
  assert.equal(claimWith(refuted), 'preview');
  assert.ok(
    validateCertificationRecord(role.id, signedRecord(), artifactDeps(refuted))
      .some((p) => p.includes('re-evaluates red') && !p.includes('insufficient data')),
    'refuted evidence under a green gate field must be refused as red, not thin'
  );

  // Thin evidence under a green gate field: a missing journey run
  // re-evaluates red with insufficient data — still refused.
  const thin = verdictBlob();
  delete thin.numbers.journey_runs[MANIFEST.required_journey_tests[0].id];
  assert.equal(claimWith(thin), 'preview');
  assert.ok(
    validateCertificationRecord(role.id, signedRecord(), artifactDeps(thin))
      .some((p) => p.includes('re-evaluates red (insufficient data)')),
    'missing evidence under a green gate field must be refused as insufficient'
  );

  // The honest artifact — numbers that really evaluate green — still signs.
  assert.deepEqual(validateCertificationRecord(role.id, signedRecord(), artifactDeps()), []);
});

test('the journey-report laws live in the arithmetic: an embedded bare blob refutes at every layer', () => {
  const [entry] = MANIFEST.required_journey_tests;
  // Arithmetic level: kind, identity and vintage each refute by code, as
  // REFUTATION (the evidence was looked at and found wrong), never thin data.
  const wrongs = [
    [{ gate: 'PASS' }, 'journey_run_wrong_kind'], // the #1688 blob itself
    [{ artifact: 'donna.other.v1', journey: entry.id, runtime_version: CURRENT_ROLE_RUNTIME_VERSION, gate: 'PASS' }, 'journey_run_wrong_kind'],
    [{ artifact: ROLE_JOURNEY_RUN_ARTIFACT, journey: 'journey.other.v1', runtime_version: CURRENT_ROLE_RUNTIME_VERSION, gate: 'PASS' }, 'journey_run_wrong_identity'],
    [{ artifact: ROLE_JOURNEY_RUN_ARTIFACT, journey: entry.id, runtime_version: CURRENT_ROLE_RUNTIME_VERSION + 1, gate: 'PASS' }, 'journey_run_wrong_vintage']
  ];
  for (const [run, code] of wrongs) {
    const evidence = greenEvidence();
    evidence.journey_runs[entry.id] = run;
    const gate = evaluateRoleCertification({ manifest: MANIFEST, evidence });
    assert.equal(gate.verdict, 'red');
    assert.ok(
      gate.reasons.some((r) => r.requirement === 'journey_tests' && r.code === code && r.insufficient === false),
      `${code} expected: ${JSON.stringify(gate.reasons)}`
    );
  }

  // THE pin — the record layer: a fabricated verdict artifact embedding the
  // #1688 blob (gate PASS, no kind/identity/vintage) could re-derive green
  // before the laws moved into the arithmetic. Now it re-evaluates red and
  // the signed record reads preview.
  const role = findRoleDefinition('invoicing_collections');
  const fabricated = verdictBlob();
  fabricated.numbers.journey_runs = Object.fromEntries(
    MANIFEST.required_journey_tests.map((e) => [e.id, { gate: 'PASS' }]));
  assert.equal(
    certificationClaimForRole({ ...role, certification: signedRecord() }, artifactDeps(fabricated)),
    'preview'
  );
  assert.ok(
    validateCertificationRecord(role.id, signedRecord(), artifactDeps(fabricated))
      .some((p) => p.includes('re-evaluates red')),
    'embedded bare journey blobs must refute the re-derived gate'
  );
});

test('the leash run report is the evidence: hand-authored rows without the report are not green', () => {
  // THE pin: green rows with NO report read insufficient — before this slice
  // the rows alone satisfied the requirement, so the record layer's
  // re-derivation read rows a fabricated artifact could hand-author (#1706's
  // journey hole, one requirement over).
  const rowsOnly = (({ leash_test_run, ...rest }) => rest)(greenEvidence());
  const rowsGate = evaluateRoleCertification({ manifest: MANIFEST, evidence: rowsOnly });
  assert.equal(rowsGate.verdict, 'red');
  assert.ok(
    rowsGate.reasons.some((r) => r.requirement === 'leash_tests'
      && r.code === 'leash_test_run_missing' && r.insufficient === true),
    `rows without the report must read insufficient: ${JSON.stringify(rowsGate.reasons)}`
  );

  // The report answers for its kind and vintage in the arithmetic —
  // refutation class, like the journey laws.
  for (const [patch, code] of [
    [{ artifact: 'donna.other.v1' }, 'leash_run_wrong_kind'],
    [{ runtime_version: CURRENT_ROLE_RUNTIME_VERSION + 1 }, 'leash_run_wrong_vintage']
  ]) {
    const evidence = greenEvidence();
    evidence.leash_test_run = { ...evidence.leash_test_run, ...patch };
    const gate = evaluateRoleCertification({ manifest: MANIFEST, evidence });
    assert.equal(gate.verdict, 'red');
    assert.ok(
      gate.reasons.some((r) => r.requirement === 'leash_tests' && r.code === code && r.insufficient === false),
      `${code} expected: ${JSON.stringify(gate.reasons)}`
    );
  }

  // Green comes FROM the report: a file the report did not run stays missing
  // even when its row claims green.
  const partial = greenEvidence();
  delete partial.leash_test_run.files[MANIFEST.required_leash_tests[0]];
  const partialGate = evaluateRoleCertification({ manifest: MANIFEST, evidence: partial });
  assert.equal(partialGate.verdict, 'red');
  assert.ok(partialGate.reasons.some((r) => r.code === 'leash_test_run_missing'));

  // The record layer: a fabricated verdict artifact with green rows but no
  // embedded report re-derives red and the signed record reads preview.
  const role = findRoleDefinition('invoicing_collections');
  const fabricated = verdictBlob();
  delete fabricated.numbers.leash_test_run;
  assert.equal(
    certificationClaimForRole({ ...role, certification: signedRecord() }, artifactDeps(fabricated)),
    'preview'
  );
  assert.ok(
    validateCertificationRecord(role.id, signedRecord(), artifactDeps(fabricated))
      .some((p) => p.includes('re-evaluates red')),
    'row-only leash evidence must refute the re-derived gate'
  );
});

test('registry law: every role today carries certification null ⇒ claim preview everywhere', () => {
  for (const role of ROLE_DEFINITIONS) {
    if (role.certification !== null) {
      assert.deepEqual(validateCertificationRecord(role.id, role.certification), [],
        `${role.id}: a non-null certification record must validate`);
    }
    assert.equal(certificationClaimForRole(role), 'preview');
    const summary = certificationSummaryForRole(role);
    assert.equal(summary.claim, 'preview');
    assert.equal(summary.record, null);
    assert.ok(Array.isArray(summary.manifests));
  }
  assert.deepEqual(certificationSummaryForRole(findRoleDefinition('invoicing_collections')).manifests,
    [{ jurisdiction: 'GB', version: 1 }]);
});

// ── The verdict artifact ────────────────────────────────────────────────────

test('the verdict artifact is unsigned, never claims, and carries the receipt-grade numbers', () => {
  const evidence = greenEvidence();
  const gate = evaluateRoleCertification({ manifest: MANIFEST, evidence });
  const verdict = buildRoleCertificationVerdict({
    manifest: MANIFEST, evidence, gate, producedAt: '2026-08-14T12:00:00Z'
  });
  assert.equal(verdict.artifact, ROLE_CERTIFICATION_VERDICT_ARTIFACT);
  assert.deepEqual(verdict.manifest, { role: 'invoicing_collections', jurisdiction: 'GB', version: 1, runtime_version: 1 });
  assert.equal(verdict.claim.happens_here, false);
  assert.equal(verdict.signature.signed_by, null);
  assert.equal(verdict.signature.signed_at, null);
  // Model ids ride from receipts (observation.models), never from code.
  assert.deepEqual(verdict.numbers.observation.models, ['gpt-5.4']);
});

// ── Gather ──────────────────────────────────────────────────────────────────

test('gather: today\'s real state evaluates red with insufficient_data (nothing is green-washed)', async () => {
  const client = makeClient();
  const evidence = await gatherRoleCertificationEvidence(client, {
    manifest: MANIFEST,
    deps: { existsSync: () => true }
  });
  // Lane gates: model_challenger_runs absent ⇒ red insufficient, per lane.
  for (const laneId of MANIFEST.required_model_lane_gates) {
    assert.equal(evidence.lane_gates[laneId].verdict, 'red');
    assert.equal(evidence.lane_gates[laneId].insufficient_data, true);
  }
  // Wiring: the audited R1 surface has zero gaps — the one green requirement.
  assert.deepEqual(evidence.wiring.gaps, []);
  assert.equal(evidence.runtime_version, CURRENT_ROLE_RUNTIME_VERSION);
  const gate = evaluateRoleCertification({ manifest: MANIFEST, evidence });
  assert.equal(gate.verdict, 'red');
  assert.equal(gate.insufficient_data, true);
  assert.equal(gate.requirements.wiring_coverage.verdict, 'green');
  assert.equal(gate.requirements.model_lane_gates.verdict, 'red');
});

test('gather: observation counts role-leash-passed SENT receipts for the role\'s send verbs only', async () => {
  const client = makeClient({
    receiptsRow: {
      role_receipts: 7,
      first_receipt_at: '2026-08-01T00:00:00Z',
      last_receipt_at: '2026-08-10T00:00:00Z'
    },
    modelRows: [{ model: 'donna-outbound-template' }],
    wouldBlocks: 2
  });
  const evidence = await gatherRoleCertificationEvidence(client, {
    manifest: MANIFEST,
    deps: { existsSync: () => true }
  });
  assert.equal(evidence.observation.role_receipts, 7);
  assert.equal(evidence.observation.would_blocks, 2);
  assert.equal(Math.round(evidence.observation.window_days), 9);
  assert.deepEqual(evidence.observation.models, ['donna-outbound-template']);
  const receiptsCall = client.calls.find((c) => c.sql.includes('count(*)::int as role_receipts'));
  // The three send verbs — the role's action_set ∩ the outbound enum; the
  // sweep identities (create_pay_link …) are not send receipts.
  assert.deepEqual(receiptsCall.params[0], ['issue_invoice', 'send_quote', 'send_receivable_reminder']);
  assert.ok(receiptsCall.sql.includes("outcome = 'sent'"));
  assert.ok(String(receiptsCall.params[1]).includes('role_leash'));
});

// ── The offline half (gather offline + tagged reasons + the preview) ────────

test('reasons carry their class: missing evidence is insufficient, a refutation is not', () => {
  const gate = evaluateRoleCertification({ manifest: MANIFEST, evidence: {} });
  for (const reason of gate.reasons) {
    assert.equal(reason.insufficient, true, `${reason.code} on empty evidence must be insufficient`);
  }
  const refuted = greenEvidence();
  refuted.observation = { ...refuted.observation, would_blocks: 3 };
  const refutedGate = evaluateRoleCertification({ manifest: MANIFEST, evidence: refuted });
  const wouldBlock = refutedGate.reasons.find((r) => r.code === 'would_blocks_observed');
  assert.equal(wouldBlock.insufficient, false, 'an observed would-block is a refutation, not thin data');
});

test('offline gather: DB requirements stay ungathered; nothing is fabricated', async () => {
  const evidence = await gatherRoleCertificationEvidence(null, {
    manifest: MANIFEST,
    offline: true,
    // Until 2026-08-15 this line passed a bare `{ gate: 'PASS' }` blob — the
    // assertion that encoded the hole the journey kind-refusal closed; the
    // journey id and the runtime vintage followed on 2026-08-16, when the
    // identity and vintage refusals started demanding a supplied report
    // record the journey it stands for and the runtime it ran under.
    journeyRuns: Object.fromEntries(MANIFEST.required_journey_tests.map((entry) =>
      [entry.id, {
        artifact: ROLE_JOURNEY_RUN_ARTIFACT, journey: entry.id,
        runtime_version: CURRENT_ROLE_RUNTIME_VERSION, gate: 'PASS'
      }])),
    testRunReport: {
      artifact: ROLE_LEASH_TEST_RUN_ARTIFACT,
      runtime_version: CURRENT_ROLE_RUNTIME_VERSION,
      files: Object.fromEntries(MANIFEST.required_leash_tests.map((relPath) => [relPath, { green: true }]))
    },
    deps: { existsSync: () => true }
  });
  assert.equal(evidence.offline, true);
  assert.deepEqual(evidence.lane_gates, {});
  assert.equal(evidence.observation, null);
  assert.deepEqual(evidence.wiring.gaps, []);

  const gate = evaluateRoleCertification({ manifest: MANIFEST, evidence });
  // The offline gate can NEVER be green: observation lives in the DB.
  assert.equal(gate.verdict, 'red');
  assert.equal(gate.insufficient_data, true);
  // The DB-gathered requirements are red ONLY for absent evidence…
  for (const name of DB_GATHERED_REQUIREMENTS) {
    assert.equal(gate.requirements[name].verdict, 'red');
    assert.ok(gate.requirements[name].reasons.every((r) => r.insufficient === true),
      `${name} offline must be red on absence, never refuted`);
  }
  // …while the offline-evaluable requirements read green on real evidence.
  for (const name of ['journey_tests', 'leash_tests', 'wiring_coverage', 'runtime_version']) {
    assert.equal(gate.requirements[name].verdict, 'green', `${name} must be green`);
  }
  // EAW: no reports supplied, insufficient — awaiting the cross-lane producer.
  assert.ok(gate.requirements.eaw_core_curriculum.reasons.every((r) => r.insufficient === true));
});

test('offline gather refuses a client, refuses gold reports; the full gather refuses no client', async () => {
  const client = makeClient();
  await assert.rejects(
    () => gatherRoleCertificationEvidence(client, { manifest: MANIFEST, offline: true, deps: { existsSync: () => true } }),
    /offline gather with a DB client at hand is a contradiction/
  );
  await assert.rejects(
    () => gatherRoleCertificationEvidence(null, {
      manifest: MANIFEST, offline: true, goldReports: { owner_invoice_command_read: {} }, deps: { existsSync: () => true }
    }),
    /gold reports cannot be evaluated offline/
  );
  // The full gather without a client is a NAMED refusal now, not a TypeError
  // three calls deep inside computeLaneGapTable.
  await assert.rejects(
    () => gatherRoleCertificationEvidence(null, { manifest: MANIFEST, deps: { existsSync: () => true } }),
    /full gather requires a DB client/
  );
});

test('the offline preview artifact is a distinct kind, unsignable, and refuses full evidence', async () => {
  const evidence = await gatherRoleCertificationEvidence(null, {
    manifest: MANIFEST, offline: true, deps: { existsSync: () => true }
  });
  const gate = evaluateRoleCertification({ manifest: MANIFEST, evidence });
  const preview = buildRoleCertificationOfflinePreview({
    manifest: MANIFEST, evidence, gate, producedAt: '2026-08-15T12:00:00Z'
  });
  assert.equal(preview.artifact, ROLE_CERTIFICATION_OFFLINE_PREVIEW_ARTIFACT);
  assert.notEqual(preview.artifact, ROLE_CERTIFICATION_VERDICT_ARTIFACT);
  assert.equal(preview.preview.signable, false);
  assert.deepEqual(preview.preview.not_gathered, [...DB_GATHERED_REQUIREMENTS]);
  assert.equal(preview.numbers.lane_gates, null);
  assert.equal(preview.numbers.observation, null);
  assert.equal('signature' in preview, false, 'a preview has no signature block to fill');

  // Full (non-offline) evidence is refused: it belongs in the verdict artifact.
  const full = await gatherRoleCertificationEvidence(makeClient(), {
    manifest: MANIFEST, deps: { existsSync: () => true }
  });
  const fullGate = evaluateRoleCertification({ manifest: MANIFEST, evidence: full });
  assert.throws(
    () => buildRoleCertificationOfflinePreview({ manifest: MANIFEST, evidence: full, gate: fullGate }),
    /OFFLINE-gathered evidence only/
  );

  // A green gate on "offline" evidence means fabrication — crash, not publish.
  assert.throws(
    () => buildRoleCertificationOfflinePreview({
      manifest: MANIFEST, evidence: { offline: true }, gate: { verdict: 'green' }
    }),
    /can never read green/
  );
});

test('gather: leash-test evidence records existence but never green without a run report', async () => {
  const client = makeClient();
  const evidence = await gatherRoleCertificationEvidence(client, {
    manifest: MANIFEST,
    deps: { existsSync: () => true }
  });
  for (const relPath of MANIFEST.required_leash_tests) {
    assert.equal(evidence.leash_tests[relPath].exists, true);
    assert.equal(evidence.leash_tests[relPath].green, null);
  }
  // The report must be a RUN (scripts/run_role_leash_tests.js), not a claim:
  // this assertion used to pass a bare `{ files: { …: { green: true } } }`
  // blob, which is exactly the hand-authored evidence the producer replaced.
  // leashTestRun.test.js pins the refusal of that shape.
  const withReport = await gatherRoleCertificationEvidence(client, {
    manifest: MANIFEST,
    testRunReport: {
      artifact: ROLE_LEASH_TEST_RUN_ARTIFACT,
      runtime_version: CURRENT_ROLE_RUNTIME_VERSION,
      files: { [MANIFEST.required_leash_tests[0]]: { green: true } }
    },
    deps: { existsSync: () => true }
  });
  assert.equal(withReport.leash_tests[MANIFEST.required_leash_tests[0]].green, true);
  assert.equal(withReport.leash_tests[MANIFEST.required_leash_tests[1]].green, null);
});
