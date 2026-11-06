#!/usr/bin/env node
// AR-5B's bounded evidence + owner-conversation evaluation adapter.
// The independent oracle/comparator lives under server/donna/world. This file
// alone imports the shipping extractors, owner-chat engine, Arabic PDF
// typesetter, recorded-provider boundary and approved live-provider capture.

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractStructuredFromOpenAiVision } from '../server/donna/bankStatementVision.js';
import { generateClientPortalChatReply } from '../server/donna/clientPortalChat.js';
import { typesetArabicPdfTemplate } from '../server/donna/outbound/arabicPdfText.js';
import { installRecordedProviders } from '../server/donna/testSupport/recordedProviders.js';
import { extractUnified } from '../server/donna/unifiedExtractor.js';
import {
  compareAeArabicWithEnglish,
  evaluateAeEvidenceCase,
  evaluateAeOwnerChatCase,
  validateAeArabicEvidenceWorld
} from '../server/donna/world/aeArabicEvidenceEvaluation.js';
import { createGate2bProviderCapture } from './eval_world_gate2b_provider_capture.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const AE_ARABIC_EVIDENCE_WORLD_PATH = 'data/worlds/ae/ae-arabic-evidence-evals.json';
const ARTIFACT_DIMENSIONS = Object.freeze([595.28, 841.89]);

export async function loadAeArabicEvidenceWorld(path = resolve(REPO, AE_ARABIC_EVIDENCE_WORLD_PATH)) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function runAeArabicEvidenceEvaluation({
  world = null,
  mode = 'replay',
  budget = null,
  runs = null,
  runTokenPrefix = 'ar5b'
} = {}) {
  const spec = world || await loadAeArabicEvidenceWorld();
  const validation = validateAeArabicEvidenceWorld(spec);
  if (!validation.ok) return { status: 'INCOMPLETE', validation };
  if (!['replay', 'live'].includes(mode)) throw new Error('AR-5B mode must be replay or live');
  const runCount = runs ?? (mode === 'live' ? spec.limits.live_runs : 1);
  if (!Number.isSafeInteger(runCount) || runCount <= 0 || runCount > spec.limits.live_runs) {
    throw new Error(`AR-5B runs must be 1..${spec.limits.live_runs}`);
  }
  if (mode === 'live' && runCount !== spec.limits.live_runs) {
    throw new Error(`AR-5B live quality evidence requires exactly ${spec.limits.live_runs} runs`);
  }
  assertLivePreflight({ mode, budget, world: spec });

  const priorEnv = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY
  };
  let providers = null;
  let capture = null;
  try {
    if (mode === 'replay') {
      process.env.ANTHROPIC_API_KEY = 'recorded-replay-key';
      process.env.OPENAI_API_KEY = 'recorded-replay-key';
      providers = installRecordedProviders();
      scriptReplay(spec, providers, runCount);
    } else {
      capture = createGate2bProviderCapture({ budget });
      capture.install();
    }

    const artifacts = await materializeArtifacts(spec);
    const artifactReceipts = Object.fromEntries([...artifacts].map(([id, artifact]) => [id, {
      sha256: sha256(artifact.bytes),
      byte_length: artifact.bytes.length,
      mime_type: artifact.mimeType,
      kind: artifact.kind,
      source_path: artifact.sourcePath || null
    }]));
    for (const [id, receipt] of Object.entries(artifactReceipts)) {
      if (receipt.byte_length > spec.limits.max_artifact_bytes) throw new Error(`${id} exceeds max_artifact_bytes`);
    }

    const evidenceResults = [];
    const ownerChatResults = [];
    const runReceipts = [];
    for (let runIndex = 0; runIndex < runCount; runIndex += 1) {
      const runToken = `${runTokenPrefix}-${runIndex + 1}`;
      if (capture) capture.setRunToken(runToken);
      const callsBefore = providerCalls({ providers, capture }).length;
      for (const pair of spec.evidence_pairs) {
        for (const item of pair.cases) {
          const artifact = artifacts.get(item.id);
          const actual = pair.kind === 'bank_statement'
            ? await extractStructuredFromOpenAiVision({
                base64: artifact.bytes.toString('base64'),
                filename: artifact.filename,
                mimeType: artifact.mimeType
              })
            : await extractUnified({
                base64: artifact.bytes.toString('base64'),
                filename: artifact.filename,
                mimeType: artifact.mimeType,
                clientIdentity: spec.client_identity,
                apiKey: process.env.ANTHROPIC_API_KEY
              });
          const call = providerCalls({ providers, capture }).at(-1) || null;
          evidenceResults.push({
            ...evaluateAeEvidenceCase({ pair, item, actual, providerReceipt: projectProviderCall(call, mode) }),
            run_token: runToken,
            artifact_receipt: artifactReceipts[item.id]
          });
        }
      }
      for (const pair of spec.owner_chat_pairs) {
        for (const item of pair.cases) {
          const actual = await generateClientPortalChatReply({
            context: pair.context,
            history: [],
            userMessage: item.user_message,
            validAskIds: (pair.context.open_asks || []).map((ask) => ask.id)
          });
          const call = providerCalls({ providers, capture }).at(-1) || null;
          ownerChatResults.push({
            ...evaluateAeOwnerChatCase({ pair, item, actual, providerReceipt: projectProviderCall(call, mode) }),
            run_token: runToken
          });
        }
      }
      const runCalls = providerCalls({ providers, capture }).slice(callsBefore);
      runReceipts.push({
        run_token: runToken,
        provider_calls: runCalls.length,
        expected_provider_calls: spec.limits.max_provider_calls_per_run,
        call_cap_respected: runCalls.length === spec.limits.max_provider_calls_per_run,
        calls: runCalls.map((call) => projectProviderCall(call, mode))
      });
    }
    if (providers) providers.assertNoUnscripted();
    const comparison = compareAeArabicWithEnglish({ world: spec, evidenceResults, ownerChatResults, runMode: mode });
    const providerReceipt = capture
      ? capture.receipt({
          configurationDigest: sha256(Buffer.from(JSON.stringify({ world: spec.world_id, runs: runCount }))),
          artifactDigests: Object.values(artifactReceipts).map((receipt) => receipt.sha256)
        })
      : replayReceipt(providers.calls, artifactReceipts);
    const completeRuns = runReceipts.every((receipt) => receipt.call_cap_respected);
    const liveReceiptCounted = mode === 'live' && providerReceipt.status === 'counted';
    return {
      status: comparison.status,
      promotion_status: comparison.status === 'PASS' && completeRuns && liveReceiptCounted ? 'PASS' : 'INCOMPLETE',
      validation,
      mode,
      run_count: runCount,
      comparison: {
        ...comparison,
        language_quality_claim_allowed: comparison.status === 'PASS' && completeRuns && liveReceiptCounted,
        promotion_status: comparison.status === 'PASS' && completeRuns && liveReceiptCounted ? 'PASS' : 'INCOMPLETE'
      },
      artifact_receipts: artifactReceipts,
      provider_receipt: providerReceipt,
      run_receipts: runReceipts,
      authority: {
        extraction_paths: ['extractUnified', 'extractStructuredFromOpenAiVision'],
        owner_chat_path: 'generateClientPortalChatReply',
        accounting_writes: 0,
        external_sends: 0,
        synthetic_replay_is_model_quality_evidence: false,
        shipping_arabic_declaration: false
      }
    };
  } finally {
    if (providers) providers.restore();
    if (capture) capture.restore();
    restoreEnv('ANTHROPIC_API_KEY', priorEnv.ANTHROPIC_API_KEY);
    restoreEnv('OPENAI_API_KEY', priorEnv.OPENAI_API_KEY);
  }
}

function assertLivePreflight({ mode, budget, world }) {
  if (mode !== 'live') return;
  if (!process.env.ANTHROPIC_API_KEY || !process.env.OPENAI_API_KEY) {
    throw Object.assign(new Error('AR-5B live run refused before spend: both provider credentials are required.'), { code: 'AR5B_LIVE_CREDENTIALS_REQUIRED' });
  }
  if (budget?.status !== 'APPROVED' || budget?.first_live_call_allowed !== true) {
    throw Object.assign(new Error('AR-5B live run refused before spend: supply a calculated, approved provider budget.'), { code: 'AR5B_LIVE_BUDGET_REQUIRED' });
  }
  const required = Object.fromEntries(world.live_provider_caps.map((cap) => [cap.provider, {
    calls: cap.max_calls_per_run,
    input: cap.max_input_tokens_per_call,
    output: cap.max_output_tokens_per_call
  }]));
  const lanes = Array.isArray(budget.lanes) ? budget.lanes : [];
  const capsMatch = budget.world_id === world.world_id
    && budget.k === world.limits.live_runs
    && lanes.length === 2
    && Object.entries(required).every(([provider, cap]) => {
      const lane = lanes.find((item) => item.provider === provider);
      return lane
        && lane.max_calls_per_run === cap.calls
        && lane.max_input_tokens_per_call === cap.input
        && lane.max_output_tokens_per_call === cap.output;
    })
    && budget.totals?.calls === 48;
  if (!capsMatch) {
    throw Object.assign(new Error('AR-5B live run refused before spend: approved budget does not match the predeclared 3 x 16-call schedule.'), { code: 'AR5B_LIVE_BUDGET_MISMATCH' });
  }
}

function scriptReplay(world, providers, runCount) {
  const evidence = world.evidence_pairs.flatMap((pair) => pair.cases.map((item) => ({ pair, item })));
  const unified = evidence.filter(({ pair }) => pair.kind === 'unified_document').map(({ item }) => item.recording);
  const statements = evidence.filter(({ pair }) => pair.kind === 'bank_statement').map(({ item }) => item.recording);
  const chat = world.owner_chat_pairs.flatMap((pair) => pair.cases.map((item) => item.recording));
  providers.script('unified_extraction', Array.from({ length: runCount }, () => unified).flat());
  providers.script('bank_statement_extraction', Array.from({ length: runCount }, () => statements).flat());
  providers.script('chat_engine', Array.from({ length: runCount }, () => chat).flat());
}

async function materializeArtifacts(world) {
  const artifacts = new Map();
  for (const pair of world.evidence_pairs) {
    for (const item of pair.cases) {
      if (item.artifact.kind === 'versioned_scan_png') {
        const absolute = boundedFixturePath(item.artifact.path);
        artifacts.set(item.id, {
          bytes: await readFile(absolute),
          filename: absolute.split('/').at(-1),
          mimeType: item.artifact.mime_type,
          kind: item.artifact.kind,
          sourcePath: item.artifact.source_path
        });
        continue;
      }
      const rendered = await typesetArabicPdfTemplate({
        rendered: { subject: item.artifact.subject, body: item.artifact.body },
        dimensions: ARTIFACT_DIMENSIONS,
        margin: 56,
        titleSize: 18,
        bodySize: 10,
        lineHeight: 15,
        language: item.presentation === 'english' ? 'en-AE' : 'ar-AE'
      });
      artifacts.set(item.id, {
        bytes: rendered.content,
        filename: item.artifact.filename,
        mimeType: item.artifact.mime_type,
        kind: item.artifact.kind
      });
    }
  }
  return artifacts;
}

function boundedFixturePath(relativePath) {
  const absolute = resolve(REPO, relativePath);
  const allowed = resolve(REPO, 'data/worlds/ae/artifacts/ar5b');
  if (absolute !== allowed && !absolute.startsWith(`${allowed}/`)) throw new Error(`AR-5B artifact escaped fixture root: ${relativePath}`);
  return absolute;
}

function providerCalls({ providers, capture }) {
  return providers ? providers.calls : capture.calls();
}

function projectProviderCall(call, mode) {
  if (!call) return null;
  return {
    evidence_class: mode === 'live' ? 'measured_live_provider' : 'synthetic_recorded_replay',
    lane: call.lane,
    endpoint_class: call.endpoint_class || call.provider || null,
    model_requested: call.model_requested || null,
    model_served: call.model_served || call.model_id || null,
    response_id: call.response_id || null,
    input_tokens: call.input_tokens ?? null,
    output_tokens: call.output_tokens ?? null,
    wall_time_ms: call.wall_time_ms ?? null,
    request_digest: call.request_digest || null,
    status: call.status || call.http_status || null,
    recording: call.recording || null,
    cost_usd: null
  };
}

function replayReceipt(calls, artifactReceipts) {
  const body = {
    status: 'replay_only',
    evidence_class: 'synthetic_recorded_replay',
    provider_calls: calls.length,
    measured_tokens: false,
    measured_cost: false,
    cash_usd: 0,
    network_egress: false,
    recordings: calls.map((call) => call.recording),
    artifact_digests: Object.values(artifactReceipts).map((receipt) => receipt.sha256).sort()
  };
  return { ...body, receipt_digest: sha256(Buffer.from(JSON.stringify(body))) };
}

function restoreEnv(key, value) {
  if (value == null) delete process.env[key];
  else process.env[key] = value;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseArgs(argv) {
  const args = { mode: 'replay', budget: null, output: null };
  for (const raw of argv) {
    if (raw.startsWith('--mode=')) args.mode = raw.slice('--mode='.length);
    else if (raw.startsWith('--budget=')) args.budget = raw.slice('--budget='.length);
    else if (raw.startsWith('--output=')) args.output = raw.slice('--output='.length);
    else throw new Error(`Unknown argument: ${raw}`);
  }
  return args;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const budget = args.budget ? JSON.parse(await readFile(resolve(args.budget), 'utf8')) : null;
  const receipt = await runAeArabicEvidenceEvaluation({ mode: args.mode, budget });
  const rendered = `${JSON.stringify(receipt, null, 2)}\n`;
  if (args.output) await writeFile(resolve(args.output), rendered, 'utf8');
  process.stdout.write(rendered);
  if (receipt.status !== 'PASS') process.exitCode = 1;
}
