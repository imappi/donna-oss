// Re-stage ALL the client-scoped authority canaries after a lab client
// reset, in one command — the 2026-08-17 clean-round lesson. A client
// delete FK-cascades the authority plane (fail-closed by design, receipted
// as client.authority_plane_purged); the desktop seed restores only the
// baseline DESKTOP_CLIENT_FLAG_SEEDS. The authority canaries are NOT in
// that list and must be re-staged by hand — and the list turned out to be
// THREE flags, not two: the 2026-08-17 handoff's §5.2 named material-auto-FYI
// and ledger-auto-post, and the round then stalled a third time on the
// unstaged disposition-driven ask gather (the "I need 3 things" draft that
// ignored 11 disposition verdicts). One script, all three, so a partial
// re-stage can't happen again.
//
//   RECONCILIATION_MATERIAL_AUTO_FYI  — material matches auto-reconcile + owner FYI
//                                       (without it they rest at 'suggested' BY DESIGN
//                                       — the Sonoran $854.41 hold)
//   LEDGER_AUTO_POST                  — auto-reconciled lines post to the internal
//                                       ledger (without it they rest at "Ready to post")
//   RECONCILIATION_DISPOSITION_DRIVEN_ASK — the ask-batch gather includes bare lines
//                                       the disposition pass flagged for the owner
//                                       (without it the draft only sees coder verdicts)
//
// Flag keys are PINNED imports — never taken from argv — so a typo can't
// stage the wrong thing. Writes go through the audited setClientFlagStage
// writer (history-preserving close-then-insert + an audit_events row each).
//
// SAFETY: dry-run by DEFAULT (prints the plan, writes nothing). Pass
// --apply to commit. ROLLBACK: --stage off --apply re-disarms all three.
//
// USAGE (lab defaults: donna-demo-firm / honeybee-hills-apiary-llc):
//   node scripts/restage_lab_canaries.js                          # dry-run
//   node scripts/restage_lab_canaries.js --apply
//   node scripts/restage_lab_canaries.js --client <id> --apply
//   node scripts/restage_lab_canaries.js --stage off --apply      # disarm

import { withFirmDbClient, DISPOSITION_DRIVEN_ASK_FLAG_KEY } from '../server/donna/firmDb.js';
import { setClientFlagStage, readClientConfigSnapshot, CONFIG_STAGES } from '../server/donna/clientConfig.js';
import { MATERIAL_AUTO_FYI_FLAG_KEY } from '../server/donna/reconciliationLlmCore.js';
import { LEDGER_AUTO_POST_FLAG_KEY } from '../server/donna/ledgerAutoPost.js';

export const LAB_CANARY_FLAG_KEYS = Object.freeze([
  MATERIAL_AUTO_FYI_FLAG_KEY,
  LEDGER_AUTO_POST_FLAG_KEY,
  DISPOSITION_DRIVEN_ASK_FLAG_KEY
]);

const DEFAULTS = Object.freeze({
  firmId: 'donna-demo-firm',
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

// Pure plan: one row per pinned flag with its current stage, fail-closed on
// bad input. Refuses a firm-wide run (clientId required) — these canaries
// are client-scoped authority by design.
export const buildRestagePlan = ({ firmId, clientId, stage, snapshot = {} } = {}) => {
  if (!firmId) return { ok: false, error: 'firmId is required.' };
  if (!clientId) return { ok: false, error: 'clientId is required (refuse a firm-wide canary flip).' };
  if (!CONFIG_STAGES.includes(stage)) {
    return { ok: false, error: `invalid stage '${stage}' (expected one of ${CONFIG_STAGES.join('|')})` };
  }
  return {
    ok: true,
    firmId,
    clientId,
    stage,
    flags: LAB_CANARY_FLAG_KEYS.map((flagKey) => ({
      flagKey,
      currentStage: snapshot?.[flagKey]?.stage || null
    }))
  };
};

const log = (...args) => console.log('[restage-lab-canaries]', ...args);

const main = async () => {
  const opts = parseArgv();
  const snapshot = await withFirmDbClient((client) =>
    readClientConfigSnapshot(client, { firmId: opts.firmId, clientId: opts.clientId })
  ).catch(() => ({}));
  const plan = buildRestagePlan({ firmId: opts.firmId, clientId: opts.clientId, stage: opts.stage, snapshot });
  if (!plan.ok) { log('REFUSED:', plan.error); process.exit(1); return; }

  log(`firm=${plan.firmId} client=${plan.clientId} target stage=${plan.stage}`);
  for (const flag of plan.flags) {
    log(`  ${flag.flagKey}: ${flag.currentStage || '(none — ∅, fail-closed)'} -> ${plan.stage}`);
  }
  if (!opts.apply) { log('DRY RUN — no writes. Re-run with --apply to commit.'); return; }

  for (const flag of plan.flags) {
    const result = await withFirmDbClient((client) => setClientFlagStage(client, {
      firmId: plan.firmId,
      clientId: plan.clientId,
      flagKey: flag.flagKey,
      stage: plan.stage,
      source: 'manual',
      reason: opts.reason || 'lab canary re-stage after client reset (restage_lab_canaries.js)',
      actorType: 'operator',
      actorId: 'kari@books.example'
    }));
    log(`APPLIED: ${JSON.stringify(result)}`);
  }

  // Receipt: the live stage rows as the DB now sees them.
  const after = await withFirmDbClient((client) =>
    readClientConfigSnapshot(client, { firmId: plan.firmId, clientId: plan.clientId })
  ).catch(() => ({}));
  for (const flagKey of LAB_CANARY_FLAG_KEYS) {
    log(`VERIFY: ${flagKey} = ${after?.[flagKey]?.stage || '(none)'}`);
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(() => process.exit(0))
    .catch((error) => { console.error('[restage-lab-canaries] FAILED:', error?.message || error); process.exit(1); });
}
