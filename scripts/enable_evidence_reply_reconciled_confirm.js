// Stage the "booked ✓" reply-confirmation flag (EVIDENCE_REPLY_RECONCILED_CONFIRM)
// for a single client, via the config control plane (migration 042
// client_capability_config) — NOT a raw env pair, NOT raw SQL.
//
// WHAT IT GATES: the proactive WhatsApp follow-up that tells an owner what Donna
// booked after their PHOTO/DOC answer reconciled the line on parse-completion
// (server/donna/channels/evidenceReplyConfirm.js). The text-answer path replies
// in-band and is NOT gated by this flag.
//
// DORMANT BY DEFAULT: the flag falls back to false everywhere (envFallback:()=>false).
// Stages:
//   canary / auto — ACT: the follow-up send is live for this client. Use canary
//                   for the demo (one client). 'auto' = fleet-wide, a later call.
//   shadow / dry_run / off — dormant: no send. (There is no shadow telemetry for
//                   this flag; shadow behaves as off here.)
//
// SAFETY: dry-run by DEFAULT; pass --apply to commit. Belt-and-suspenders: even
// when this flag acts, the send still requires the WhatsApp master gate
// (WHATSAPP_ENABLED=true + the client in WHATSAPP_CLIENTS) and an active binding.
// ROLLBACK: `--stage off --apply`. CLIENT_CONFIG_FORCE_DISABLE=EVIDENCE_REPLY_RECONCILED_CONFIRM
// kills it fleet-wide regardless of stage rows.
//
// USAGE:
//   node scripts/enable_evidence_reply_reconciled_confirm.js                       # dry-run (canary, Honeybee)
//   node scripts/enable_evidence_reply_reconciled_confirm.js --client <id> --apply  # go live for a demo client
//   node scripts/enable_evidence_reply_reconciled_confirm.js --client <id> --stage off --apply  # rollback

import { withFirmDbClient } from '../server/donna/firmDb.js';
import { setClientFlagStage, readClientConfigSnapshot, CONFIG_STAGES } from '../server/donna/clientConfig.js';
import { EVIDENCE_REPLY_RECONCILED_CONFIRM_FLAG_KEY } from '../server/donna/channels/evidenceReplyConfirm.js';

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

// Pure plan — the flag key is PINNED (never taken from argv), and fail-closed on
// a bad stage or missing client so a typo can't stage the wrong thing.
export const buildConfirmFlagPlan = ({ firmId, clientId, stage, currentStage = null } = {}) => {
  if (!firmId) return { ok: false, error: 'firmId is required.' };
  if (!clientId) return { ok: false, error: 'clientId is required.' };
  if (!CONFIG_STAGES.includes(stage)) return { ok: false, error: `invalid stage '${stage}'` };
  const willAct = stage === 'canary' || stage === 'auto';
  return {
    ok: true,
    flagKey: EVIDENCE_REPLY_RECONCILED_CONFIRM_FLAG_KEY,
    firmId,
    clientId,
    stage,
    currentStage,
    willAct
  };
};

const log = (...args) => console.log('[enable-reply-confirm]', ...args);

const main = async () => {
  const opts = parseArgv();
  const current = await withFirmDbClient((client) =>
    readClientConfigSnapshot(client, { firmId: opts.firmId, clientId: opts.clientId })
  ).catch(() => ({}));
  const currentStage = current?.[EVIDENCE_REPLY_RECONCILED_CONFIRM_FLAG_KEY]?.stage || null;
  const plan = buildConfirmFlagPlan({ firmId: opts.firmId, clientId: opts.clientId, stage: opts.stage, currentStage });
  if (!plan.ok) { log('REFUSED:', plan.error); process.exit(1); return; }

  log(`flag=${plan.flagKey} firm=${plan.firmId} client=${plan.clientId}`);
  log(`stage: ${currentStage || '(none)'} -> ${plan.stage}  (acts=${plan.willAct})`);
  if (!opts.apply) {
    log('DRY RUN — no write. Re-run with --apply to commit.');
    return;
  }
  const result = await withFirmDbClient((client) => setClientFlagStage(client, {
    firmId: plan.firmId,
    clientId: plan.clientId,
    flagKey: plan.flagKey,
    stage: plan.stage,
    source: 'manual',
    reason: opts.reason || 'evidence-reply-confirm demo staging',
    actorType: 'operator',
    actorId: 'kari@books.example'
  }));
  log('APPLIED — config row', result.id);
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
}
