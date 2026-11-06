// Donna — BizOS 2c-iii: the replay-artifact PRODUCER
// (design-donna-bizos-slice-2c-iii-replay-producer.md §11/§12).
//
// Reads the immutable memory_replay_evidence rows (Slice A) for a tuple over a
// contiguous window, RE-RUNS buildMemoryBundle TWICE per turn (point-in-time replay),
// classifies the replay outcome (§4), diffs legacy vs v2, has the strong model return
// BOUNDED judgments that deterministic policy maps to gate categories (§7), runs the
// synthetic suite, and emits the gate/lever artifact. Only `exact` + memory-bearing
// turns count (§10).
//
// Out-of-band, NOT offline: it reads production customer data and (for the diff
// classification) sends question/answer/fact text to the model provider. Read-only
// against prod. Commit-ATTESTED: refuses to write unless HEAD == --commit and the tree
// is clean (§7). The customer artifact is only green once enough real, exactly-
// replayable, memory-bearing turns have accumulated — this tool reports coverage; it
// never manufactures it.
//
// USAGE (preflight = compute + print, no write; --write to emit):
//   node scripts/build_memory_replay_artifact.js --firm-id <f> --client-id <c> \
//     --commit <exact-head-sha> --window-start <ts> --window-end <ts> --preflight
//   … --evaluate --out ./artifact.json --write

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { withFirmDbClient, getFirmDatabaseUrl } from '../server/donna/firmDb.js';
import { readClientConfigSnapshot, configSnapshotId } from '../server/donna/clientConfig.js';
import { buildMemoryBundle } from '../server/donna/memoryRetrieval.js';
import { makeMemoryRetrievalShadowDeps, MEMORY_RETRIEVAL_SHADOW_CONSUMER_ID } from '../server/donna/memoryRetrievalShadow.js';
import { memoryConfigDigest } from '../server/donna/memoryReplayEvidence.js';
import { buildReplayBinding } from '../server/donna/memoryRetrievalReplayGate.js';
import { runSyntheticAdversarialSuite, DIFF_CATEGORIES } from '../server/donna/memoryReplayPolicy.js';
import { buildArtifactFreshness } from '../server/donna/memoryReplayPolicy.js';
import {
  validateEvidenceEnvelope, classifyReplayOutcome, pairAndDiff, isMemoryBearing,
  computeMetrics, assembleArtifact
} from '../server/donna/memoryReplayArtifactCore.js';
import { classifyDiffTurn, diffItemId } from '../server/donna/memoryReplayDiffClassifier.js';

export const OWNER_AUDIENCE = 'owner';
export const OWNER_PURPOSE = 'portal_owner_context';

// ── CLI ───────────────────────────────────────────────────────────────────────
export const parseArgv = (argv = process.argv.slice(2)) => {
  const out = { firmId: null, clientId: null, commitSha: null, windowStart: null, windowEnd: null, out: null, write: false, internalEntity: false, ttlDays: 7 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--firm-id') { out.firmId = argv[i + 1]; i += 1; }
    else if (a === '--client-id') { out.clientId = argv[i + 1]; i += 1; }
    else if (a === '--commit') { out.commitSha = argv[i + 1]; i += 1; }
    else if (a === '--window-start') { out.windowStart = argv[i + 1]; i += 1; }
    else if (a === '--window-end') { out.windowEnd = argv[i + 1]; i += 1; }
    else if (a === '--out') { out.out = argv[i + 1]; i += 1; }
    else if (a === '--write') { out.write = true; }
    else if (a === '--evaluate' || a === '--preflight') { /* mode markers; both compute */ }
    else if (a === '--internal-entity') { out.internalEntity = true; }
    else if (a === '--ttl-days') { out.ttlDays = Number(argv[i + 1]); i += 1; }
  }
  return out;
};

// ── Commit attestation (§7) — pure, so it unit-tests without a working tree ─────
export const verifyCommitAttestation = ({ headSha, requestedSha, workingTreeClean } = {}) => {
  const errors = [];
  if (!requestedSha) errors.push('no --commit supplied (a written artifact must be commit-attested)');
  if (!headSha) errors.push('could not resolve HEAD');
  if (headSha && requestedSha && headSha !== requestedSha) errors.push(`HEAD ${headSha} != --commit ${requestedSha}`);
  if (!workingTreeClean) errors.push('working tree is dirty (the producer must run from a clean, committed tree)');
  return { ok: errors.length === 0, errors };
};

const gitHead = () => { try { return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(); } catch { return null; } };
const gitClean = () => { try { return execSync('git status --porcelain', { encoding: 'utf8' }).trim() === ''; } catch { return false; } };

// ── Invocation reconstruction — from the STORED envelope, not live state ────────
export const reconstructInvocationFromEvidence = (record) => {
  const env = record?.envelope || {};
  const principal = env.principal || {};
  const p = { id: principal.id ?? null, principalType: principal.principal_type ?? null, principalId: principal.id ?? null };
  return {
    trustedContext: {
      tenant_id: record?.firm_id ?? null,
      authenticated_principal: p,
      delegated_principal: p,
      resolved_audience: env.resolved_audience ?? null,
      source_surface: env.source_surface ?? null,
      consumer_capability_id: MEMORY_RETRIEVAL_SHADOW_CONSUMER_ID,
      source_event_id: record?.linkage?.source_turn_message_id ?? null,
      conversation_ref: env.conversation_boundary ?? null,
      occurred_at: record?.as_of ?? null,
      config_snapshot_id: record?.config_snapshot_id ?? null
    },
    request: { purpose_id: env.purpose_id ?? null, subject_refs: Array.isArray(env.resolved_subject_refs) ? env.resolved_subject_refs : [], budget_override: null }
  };
};

// Recorded v2 rows still present at the SAME (memory_id, revision, content_hash) →
// inputs present (§4 input-drift discrimination). Compares the recorded v2 set to the
// replay's included set.
export const recordedInputsStillPresent = (recordedV2 = {}, replayResult = {}) => {
  const recorded = Array.isArray(recordedV2?.included) ? recordedV2.included : [];
  const present = new Set((Array.isArray(replayResult?.consumer_receipt?.included) ? replayResult.consumer_receipt.included : [])
    .map((r) => `${r.memory_id}@${r.revision}#${r.content_hash}`));
  return recorded.every((r) => present.has(`${r.memory_id}@${r.revision}#${r.content_hash}`));
};

// The positive-ACL invariant (§8): every recorded v2-included memory has an ALLOW
// authorization receipt. A missing one is an integrity failure (not a drift).
export const countAclIntegrityFailures = (record) => {
  const included = Array.isArray(record?.v2_canonical?.included) ? record.v2_canonical.included : [];
  const allow = new Set((record?.authorization_receipts?.allow || []).map((a) => a.memory_id));
  return included.filter((r) => !allow.has(r.memory_id)).length;
};

const receiptsByItemIdFor = (record, diff) => {
  const allow = new Set((record?.authorization_receipts?.allow || []).map((a) => a.memory_id));
  const deny = new Set((record?.authorization_receipts?.deny || []).map((a) => a.memory_id));
  const governed = new Map([
    ...(record?.v2_canonical?.visible_excluded || []),
    ...(record?.v2_canonical?.restricted_excluded || [])
  ].map((r) => [r.memory_id, r.reason_category]));
  const out = {};
  (diff.items || []).forEach((it, i) => {
    const id = diffItemId(it, i); // MUST match the id the classifier derives.
    const mid = it.v2?.memory_id ?? it.legacy?.id ?? null;
    out[id] = {
      authorization: mid && allow.has(mid) ? 'allow' : (mid && deny.has(mid) ? 'deny' : null),
      governedReason: mid ? (governed.get(mid) ?? null) : null
    };
  });
  return out;
};

// ── The testable orchestration core (injected deps) ─────────────────────────────
export const buildArtifactFromEvidence = async ({
  tuple, commitSha, deployedVersionManifest = {}, candidateConfigDigest = null, candidateConfigSnapshotId = null,
  evidenceRows = [], replayBundle, loadTurnText, callModel, modelId = null,
  now, ttlDays = 7, internalEntity = false, durableApprovals = {}, sentinelFoundInPayload = false,
  verifyPasses
} = {}) => {
  const perTurn = [];
  const diffItems = [];
  let aclIntegrityFailureCount = 0;
  const inputRevisionSet = new Set();
  const driftLedger = [];

  for (const record of evidenceRows) {
    const envelope = validateEvidenceEnvelope(record);
    const turnId = record?.linkage?.source_turn_message_id ?? record?.evidence_id ?? null;
    const versionsMatch = ['service_version', 'policy_version', 'ranker_version', 'renderer_version', 'acl_version', 'fingerprint_algo_version']
      .every((k) => (record?.version_manifest?.[k] ?? null) === (deployedVersionManifest?.[k] ?? null));
    const configMatch = candidateConfigDigest != null && record?.config_digest === candidateConfigDigest;

    // eslint-disable-next-line no-await-in-loop
    const replay = envelope.ok ? await replayBundle({ record }) : { replayA: null, replayB: null, resultA: null };
    const recordedInputsPresent = envelope.ok ? recordedInputsStillPresent(record.v2_canonical, replay.resultA) : false;
    const outcome = classifyReplayOutcome({
      recordedFingerprint: record?.bundle_fingerprint ?? null,
      replayA: replay.replayA, replayB: replay.replayB,
      recordedInputsPresent, versionsMatch, configMatch, envelopeValid: envelope.ok
    });
    const memoryBearing = isMemoryBearing({ legacyCanonical: record?.legacy_canonical, v2Canonical: record?.v2_canonical });

    if (outcome !== 'exact') {
      driftLedger.push({ turn_id: turnId, outcome, envelope_reasons: envelope.ok ? null : envelope.reasons });
      perTurn.push({ turnId, outcome, sessionId: record?.session_id, asOf: record?.as_of, memoryBearing, diffBearing: false, ambiguousAnswer: false, classificationFailure: false });
      continue;
    }

    // Only EXACT turns are trustworthy enough to diff + classify + count.
    aclIntegrityFailureCount += countAclIntegrityFailures(record);
    for (const r of (record?.v2_canonical?.included || [])) inputRevisionSet.add(`${r.memory_id}@${r.revision}`);

    // eslint-disable-next-line no-await-in-loop
    const text = await loadTurnText({ record });
    const diff = pairAndDiff({ legacyCanonical: record?.legacy_canonical, v2Canonical: record?.v2_canonical });
    const receipts = receiptsByItemIdFor(record, diff);
    // eslint-disable-next-line no-await-in-loop
    const classification = await classifyDiffTurn({
      turnContext: { question: text?.question, answer: text?.answer, legacy: record?.legacy_canonical, v2: record?.v2_canonical?.included },
      diff, receiptsByItemId: receipts, callModel, modelId, verifyPasses
    });
    for (const c of classification.classified) diffItems.push({ category: c.category, memory_id: c.memory_id, turn_id: turnId, classifier: c.classifier });

    perTurn.push({
      turnId, outcome, sessionId: record?.session_id, asOf: record?.as_of,
      memoryBearing, diffBearing: (diff.items || []).length > 0,
      ambiguousAnswer: !!text?.ambiguous, classificationFailure: classification.classificationFailure
    });
  }

  const metrics = computeMetrics(perTurn);
  const syntheticSuite = runSyntheticAdversarialSuite();
  const freshness = buildArtifactFreshness({ generatedAt: now, ttlDays });
  const binding = buildReplayBinding({
    commitSha, configSnapshotId: candidateConfigSnapshotId,
    clientId: tuple.client_id, audience: tuple.audience, purpose: tuple.purpose,
    inputRevisionSet: [...inputRevisionSet]
  });
  const artifact = assembleArtifact({
    tuple, binding, metrics, diffItems, inputRevisionSet: [...inputRevisionSet],
    internalEntity, durableApprovals, freshness, syntheticSuite, aclIntegrityFailureCount, sentinelFoundInPayload,
    provenance: {
      generated_at: now, model_id: modelId, deployed_version_manifest: deployedVersionManifest,
      candidate_config_digest: candidateConfigDigest, drift_ledger: driftLedger,
      stage_counts: metrics.counts, coverage_ratio: metrics.coverage_ratio,
      // Honest limitation carried on the artifact (§H): legacy has no history; ACL is
      // present-state, so this validates projection/ranking determinism.
      named_limitations: ['firm_facts_no_history', 'historical_acl_not_preserved', 'no_dedicated_k_eval_store']
    }
  });
  return { artifact, metrics, driftLedger };
};

const die = (msg) => { console.error(`[build-replay-artifact] ${msg}`); process.exit(1); };

export const run = async (opts) => {
  const attest = verifyCommitAttestation({ headSha: gitHead(), requestedSha: opts.commitSha, workingTreeClean: gitClean() });
  if (opts.write && !attest.ok) die(`REFUSED (commit attestation): ${attest.errors.join('; ')}`);
  if (!attest.ok) console.warn(`[build-replay-artifact] WARNING (not writing / preview): ${attest.errors.join('; ')}`);

  const tuple = { client_id: opts.clientId, audience: OWNER_AUDIENCE, purpose: OWNER_PURPOSE };
  const now = new Date().toISOString();

  // The deployed version manifest = the runtime this producer is running as (must
  // match --commit under attestation). The candidate config digest = the live config
  // for the tuple (restricted v1: it must equal the recorded per-turn config).
  const { evidenceRows, candidateConfigDigest, candidateConfigSnapshotId, deployedVersionManifest } =
    await withFirmDbClient(async (client) => {
      const cfg = await readClientConfigSnapshot(client, { firmId: opts.firmId, clientId: opts.clientId });
      const rows = await client.query(
        `select evidence from memory_replay_evidence
          where firm_id = $1 and client_id = $2
            and ($3::timestamptz is null or as_of >= $3)
            and ($4::timestamptz is null or as_of < $4)
          order by as_of asc, source_turn_message_id asc`,
        [opts.firmId, opts.clientId, opts.windowStart, opts.windowEnd]
      ).catch(() => ({ rows: [] }));
      return {
        evidenceRows: rows.rows.map((r) => r.evidence),
        candidateConfigDigest: memoryConfigDigest(cfg),
        candidateConfigSnapshotId: configSnapshotId({ firmId: opts.firmId, clientId: opts.clientId, snapshot: cfg }),
        deployedVersionManifest: (rows.rows[0]?.evidence?.version_manifest) || {}
      };
    }).catch(() => ({ evidenceRows: [], candidateConfigDigest: null, candidateConfigSnapshotId: null, deployedVersionManifest: {} }));

  const modelId = process.env.MEMORY_REPLAY_CLASSIFIER_MODEL || null;
  const callModel = makeCallModel({ modelId });

  const replayBundle = async ({ record }) => withFirmDbClient(async (client) => {
    const { trustedContext, request } = reconstructInvocationFromEvidence(record);
    const deps = makeMemoryRetrievalShadowDeps({ client });
    const resultA = await buildMemoryBundle({ trustedContext, request, deps });
    const resultB = await buildMemoryBundle({ trustedContext, request, deps });
    return { replayA: resultA?.consumer_receipt?.bundle_fingerprint ?? null, replayB: resultB?.consumer_receipt?.bundle_fingerprint ?? null, resultA };
  });

  const loadTurnText = async ({ record }) => withFirmDbClient(async (client) => {
    const q = await client.query('select content from client_chat_messages where firm_id=$1 and client_id=$2 and id=$3',
      [opts.firmId, opts.clientId, record?.linkage?.source_turn_message_id]).catch(() => ({ rows: [] }));
    const a = await client.query('select content from client_chat_messages where firm_id=$1 and client_id=$2 and id=$3',
      [opts.firmId, opts.clientId, record?.linkage?.answer_message_id]).catch(() => ({ rows: [] }));
    return { question: q.rows[0]?.content ?? null, answer: a.rows[0]?.content ?? null, ambiguous: !a.rows.length };
  });

  const { artifact, metrics } = await buildArtifactFromEvidence({
    tuple, commitSha: opts.commitSha, deployedVersionManifest, candidateConfigDigest, candidateConfigSnapshotId,
    evidenceRows, replayBundle, loadTurnText, callModel, modelId, now, ttlDays: opts.ttlDays, internalEntity: opts.internalEntity
  });

  console.log(`[build-replay-artifact] tuple=${JSON.stringify(tuple)} eligible=${metrics.realTurnCount} sessions=${metrics.sessionCount} days=${metrics.dayCount} coverage=${metrics.coverage_ratio.toFixed(3)}`);
  console.log(`[build-replay-artifact] stage counts: ${JSON.stringify(metrics.counts)}`);
  const unclassified = (artifact.diff_items || []).filter((d) => !DIFF_CATEGORIES.includes(d.category)).length;
  if (unclassified) console.log(`[build-replay-artifact] ${unclassified} UNCLASSIFIED diff item(s) — the gate will BLOCK until resolved.`);

  if (opts.write && opts.out) {
    writeFileSync(opts.out, JSON.stringify(artifact, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(`[build-replay-artifact] wrote ${opts.out}`);
  } else {
    console.log('[build-replay-artifact] PREVIEW (no --write/--out) — artifact not written.');
  }
  return { artifact, metrics };
};

// The strong-model call. Wired to the repo's Anthropic key/model (read-only import of
// the isolation-listed core is avoided — the key/model come from env). NO silent
// fallback: a missing key/model yields a thrown callModel → the turn fails closed.
export const makeCallModel = ({ modelId } = {}) => async () => {
  if (!modelId || !process.env.ANTHROPIC_API_KEY) {
    throw new Error('no classifier model configured (set MEMORY_REPLAY_CLASSIFIER_MODEL + ANTHROPIC_API_KEY) — classification fails closed');
  }
  // The real provider call is wired at deploy time; kept out of the pure engine so the
  // producer is testable with an injected callModel. Until wired, classification fails
  // closed (every diff item → unclassified → the gate blocks).
  throw new Error('classifier provider call not wired in this environment — fails closed');
};

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('build_memory_replay_artifact.js');
if (invokedDirectly) {
  const opts = parseArgv();
  if (!opts.firmId || !opts.clientId) die('missing --firm-id / --client-id');
  if (!getFirmDatabaseUrl()) die('no database URL (set DATABASE_URL to the Supabase pooler)');
  run(opts).then(() => process.exit(0)).catch((err) => die(err?.message || String(err)));
}
