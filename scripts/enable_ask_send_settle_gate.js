// Stage the ask-send settle gate (ASK_SEND_SETTLE_GATE) for a single client, via
// the config control plane (migration 042 client_capability_config) — NOT a raw
// env pair, NOT raw SQL.
//
// WHAT IT GATES: whether drainAutoSendAskBatches HOLDS a client's ask batch while
// that client has an owner-initiated upload still being read
// (server/donna/askAutoSendProducer.js).
//
// WHY IT EXISTS (the 2026-07-29 report): uploading ONE receipt after a quiet
// period produced five ask messages, one of which asked for a photo of the very
// receipt just sent. The chain is upload → parse → reconcile → the post-reconcile
// seam files a draft request → the whole open-ask set is re-drafted → sent, same
// tick. The narrow fix ("don't ask about the line the receipt covers") is
// impossible: an owner upload is registered with transaction_id: null, so nothing
// knows which line it answers until it has been parsed AND reconciled. The gate is
// therefore client-scoped: if the owner has just sent evidence and we do not yet
// know what it answers, do not ask them anything until we do.
//
// IT DEFERS, IT NEVER DROPS. A held batch stays a live draft and the next tick
// reconsiders it, by which point the parse has settled and the batch has been
// re-drafted without the questions the upload answered. Two bounds:
//   * a staleness ceiling (ASK_SEND_SETTLE_MINUTES, default 20) so a parse stuck
//     in 'processing' can never silence a client's asks indefinitely;
//   * fail-OPEN on a read error — an unreadable gate sends exactly as today.
//
// DORMANT BY DEFAULT: the flag falls back to false everywhere (envFallback:()=>false).
//   canary / auto — ACT: this client's sends wait for their uploads to settle.
//   shadow / dry_run / off — dormant: sends exactly as before the gate existed.
//
// SAFETY: dry-run by DEFAULT; pass --apply to commit. ROLLBACK: `--stage off --apply`.
// CLIENT_CONFIG_FORCE_DISABLE=ASK_SEND_SETTLE_GATE kills it fleet-wide.
//
// USAGE:
//   node scripts/enable_ask_send_settle_gate.js                                  # dry-run (canary, Honeybee)
//   node scripts/enable_ask_send_settle_gate.js --client <id> --apply            # arm the gate
//   node scripts/enable_ask_send_settle_gate.js --client <id> --stage off --apply # rollback

import { withFirmDbClient } from '../server/donna/firmDb.js';
import { setClientFlagStage, readClientConfigSnapshot, CONFIG_STAGES } from '../server/donna/clientConfig.js';
import { ASK_SEND_SETTLE_FLAG_KEY } from '../server/donna/askAutoSendProducer.js';

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
export const buildSettleGatePlan = ({ firmId, clientId, stage, currentStage = null } = {}) => {
  if (!firmId) return { ok: false, error: 'firmId is required.' };
  if (!clientId) return { ok: false, error: 'clientId is required.' };
  if (!CONFIG_STAGES.includes(stage)) return { ok: false, error: `invalid stage '${stage}'` };
  const willAct = stage === 'canary' || stage === 'auto';
  return { ok: true, flagKey: ASK_SEND_SETTLE_FLAG_KEY, firmId, clientId, stage, currentStage, willAct };
};

const log = (...args) => console.log('[enable-ask-settle-gate]', ...args);

const main = async () => {
  const opts = parseArgv();
  const current = await withFirmDbClient((client) =>
    readClientConfigSnapshot(client, { firmId: opts.firmId, clientId: opts.clientId })
  ).catch(() => ({}));
  const currentStage = current?.[ASK_SEND_SETTLE_FLAG_KEY]?.stage || null;
  const plan = buildSettleGatePlan({ firmId: opts.firmId, clientId: opts.clientId, stage: opts.stage, currentStage });
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
    reason: opts.reason || 'settle ask sends behind in-flight owner uploads',
    actorType: 'operator',
    actorId: 'kari@books.example'
  }));
  log('APPLIED — config row', result.id);
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
}
