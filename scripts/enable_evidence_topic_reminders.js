// Stage the evidence-topic reminder flag (EVIDENCE_TOPIC_REMINDERS) for a single
// client, via the config control plane (migration 042 client_capability_config)
// — NOT a raw env pair, NOT raw SQL.
//
// WHAT IT GATES: whether runEvidenceTopicReminderSweep actually SENDS a nudge for
// this client's quiet open evidence topics (server/donna/channels/evidenceTopicReminders.js).
// When the flag does not act, the sweep still runs but HOLDS every candidate
// (stats.held) — no message leaves.
//
// IMPORTANT — this flag only controls SENDING. Nothing invokes the sweep on a
// schedule: there is deliberately NO cron/daily-clock wiring (the design keeps
// reminders manual until a scheduled cadence is an explicit, separate decision).
// To fire a sweep for a demo, run scripts/run_evidence_topic_reminder_sweep.js.
//
// DORMANT BY DEFAULT: the flag falls back to false everywhere (envFallback:()=>false).
//   canary / auto — ACT: the sweep may send for this client (canary = one client).
//   shadow / dry_run / off — dormant: the sweep holds, no send.
//
// SAFETY: dry-run by DEFAULT; pass --apply to commit. ROLLBACK: `--stage off --apply`.
// CLIENT_CONFIG_FORCE_DISABLE=EVIDENCE_TOPIC_REMINDERS kills it fleet-wide.
//
// USAGE:
//   node scripts/enable_evidence_topic_reminders.js                          # dry-run (canary, Honeybee)
//   node scripts/enable_evidence_topic_reminders.js --client <id> --apply     # arm sends for a demo client
//   node scripts/enable_evidence_topic_reminders.js --client <id> --stage off --apply  # rollback

import { withFirmDbClient } from '../server/donna/firmDb.js';
import { setClientFlagStage, readClientConfigSnapshot, CONFIG_STAGES } from '../server/donna/clientConfig.js';
import { EVIDENCE_TOPIC_REMINDERS_FLAG_KEY } from '../server/donna/channels/evidenceTopicReminders.js';

const DEFAULTS = Object.freeze({
  firmId: 'donna-production',
  clientId: 'honeybee-hills-apiary-llc',
  stage: 'canary'
});

export const parseArgv = (argv = process.argv.slice(2)) => {
  const out = { apply: false, ...DEFAULTS, reason: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--firm') { out.firmId = argv[i + 1]; i += 1; }
    else if (a === '--client') { out.clientId = argv[i + 1]; i += 1; }
    else if (a === '--stage') { out.stage = argv[i + 1]; i += 1; }
    else if (a === '--reason') { out.reason = argv[i + 1]; i += 1; }
  }
  return out;
};

// Pure plan — the flag key is PINNED (never taken from argv); fail-closed on a bad
// stage or missing client so a typo can't stage the wrong thing.
export const buildReminderFlagPlan = ({ firmId, clientId, stage, currentStage = null } = {}) => {
  if (!firmId) return { ok: false, error: 'firmId is required.' };
  if (!clientId) return { ok: false, error: 'clientId is required.' };
  if (!CONFIG_STAGES.includes(stage)) return { ok: false, error: `invalid stage '${stage}'` };
  const willAct = stage === 'canary' || stage === 'auto';
  return { ok: true, flagKey: EVIDENCE_TOPIC_REMINDERS_FLAG_KEY, firmId, clientId, stage, currentStage, willAct };
};

const log = (...args) => console.log('[enable-topic-reminders]', ...args);

const main = async () => {
  const opts = parseArgv();
  const current = await withFirmDbClient((client) =>
    readClientConfigSnapshot(client, { firmId: opts.firmId, clientId: opts.clientId })
  ).catch(() => ({}));
  const currentStage = current?.[EVIDENCE_TOPIC_REMINDERS_FLAG_KEY]?.stage || null;
  const plan = buildReminderFlagPlan({ firmId: opts.firmId, clientId: opts.clientId, stage: opts.stage, currentStage });
  if (!plan.ok) { log('REFUSED:', plan.error); process.exit(1); return; }

  log(`flag=${plan.flagKey} firm=${plan.firmId} client=${plan.clientId}`);
  log(`stage: ${currentStage || '(none)'} -> ${plan.stage}  (acts=${plan.willAct})`);
  if (!opts.apply) { log('DRY RUN — no write. Re-run with --apply to commit.'); return; }
  const result = await withFirmDbClient((client) => setClientFlagStage(client, {
    firmId: plan.firmId,
    clientId: plan.clientId,
    flagKey: plan.flagKey,
    stage: plan.stage,
    source: 'manual',
    reason: opts.reason || 'evidence-topic reminders demo staging',
    actorType: 'operator',
    actorId: 'kari@books.example'
  }));
  log('APPLIED — config row', result.id);
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
}
