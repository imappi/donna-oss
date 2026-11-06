// Seat ONE model as the deciding model on EVERY policy-governed lane,
// firm-wide (client_id null — survives entity resets, covers new entities)
// — the Q9 sole-model lab seating (Kari's dated call, 2026-08-16: "whenever
// Donna or any part of its workflow invokes an LLM, it needs to be qwen 27B
// — everything else is a bug").
//
// WHAT THIS DOES AND DOES NOT DO:
//  - Seats the model on every lane whose QUALIFIED set includes it
//    (modelLanes.js) via setLaneDecidingPolicy — the store refuses
//    unqualified models (MODEL_NOT_QUALIFIED), so this script can never
//    widen a qualified set; extending one stays a dated code change.
//  - Lanes governed but NOT qualified for the model are SKIPPED loudly
//    (e.g. unified_extraction, qualified to its two providers' strong defaults).
//  - Lanes not yet governed by the feed (qualified: null — extraction,
//    vision, chat, asks, memory…) are LISTED as the remaining sole-model
//    bug surface; seating them requires their own migration slice first
//    (the Q9 arc table in docs/design-donna-qwen-descent-ladder.md).
//
// SAFETY: dry-run by DEFAULT (prints the plan, writes nothing). --apply to
// commit. Each seat is receipted by the store (model_lane.policy_set audit
// row in the same transaction). ROLLBACK: clearLaneDecidingPolicy per lane,
// or re-run with --model <strong default> per lane via the settings
// dropdown; receipts stay.
//
// USAGE:
//   node scripts/seat_qwen_sole_model.js                        # dry-run
//   DATABASE_URL='…pooler…' node scripts/seat_qwen_sole_model.js --apply
//   … --firm donna-demo-firm --model qwen/qwen3.8-27b --apply

import { withFirmDbClient, getFirmDatabaseUrl } from '../server/donna/firmDb.js';
import { listLaneDecidingPolicies, setLaneDecidingPolicy } from '../server/donna/modelLanePolicy.js';
import { MODEL_LANES } from '../server/donna/modelLanes.js';

const DEFAULTS = Object.freeze({
  firmId: 'donna-demo-firm',
  model: 'qwen/qwen3.8-27b'
});

export const parseArgv = (argv = process.argv.slice(2)) => {
  const out = { apply: false, ...DEFAULTS, reason: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--firm') { out.firmId = argv[i + 1]; i += 1; }
    else if (a === '--model') { out.model = argv[i + 1]; i += 1; }
    else if (a === '--reason') { out.reason = argv[i + 1]; i += 1; }
  }
  return out;
};

// Pure plan builder (exported, unit-tested without a DB): which governed
// lanes the model seats on, which governed lanes refuse it, and which lanes
// remain outside the feed entirely — the honest three-way split.
export const buildSoleModelSeatPlan = ({ model, lanes = MODEL_LANES } = {}) => {
  const seats = [];
  const skipped = [];
  const ungoverned = [];
  for (const lane of lanes) {
    if (!Array.isArray(lane.qualified)) {
      ungoverned.push(lane.id);
      continue;
    }
    if (lane.qualified.includes(model)) seats.push(lane.id);
    else skipped.push({ laneId: lane.id, qualified: [...lane.qualified] });
  }
  return { model, seats, skipped, ungoverned, ok: seats.length > 0 };
};

const log = (...args) => console.log('[seat-qwen-sole-model]', ...args);

export const run = async (opts) => {
  const plan = buildSoleModelSeatPlan({ model: opts.model });
  log(`firm=${opts.firmId} model=${opts.model} (firm-wide rows, client_id null)`);
  log(`SEATS (${plan.seats.length}): ${plan.seats.join(', ') || '(none)'}`);
  for (const skip of plan.skipped) {
    log(`SKIPPED ${skip.laneId} — '${opts.model}' is outside its qualified set [${skip.qualified.join(', ')}]; extending a set is a dated code change`);
  }
  log(`STILL OUTSIDE THE FEED (${plan.ungoverned.length} lanes — the remaining sole-model bug surface, each needs its own migration slice): ${plan.ungoverned.join(', ')}`);
  if (!plan.ok) {
    log(`REFUSED: '${opts.model}' is qualified on no lane.`);
    return { applied: false, plan };
  }
  if (!opts.apply) {
    log('DRY-RUN — no write. Re-run with --apply to commit.');
    return { applied: false, plan };
  }
  const results = [];
  await withFirmDbClient(async (client) => {
    for (const laneId of plan.seats) {
      const result = await setLaneDecidingPolicy({
        client,
        firmId: opts.firmId,
        clientId: null,
        laneId,
        decidingModel: opts.model,
        basis: 'experiment',
        reason: opts.reason || `Q9 sole-model lab seating (2026-08-16 Kari call) via seat_qwen_sole_model.js`,
        actorType: 'system'
      });
      log(`SEATED FIRM-WIDE: ${laneId} → ${opts.model}`);
      results.push(result);
    }
    const active = await listLaneDecidingPolicies({ client, firmId: opts.firmId });
    log('active policies now:', JSON.stringify(active, null, 2));
  });
  log('VERIFY: new verdicts stamp model/policy_basis from the policy — `select lane, deciding_model, client_id from model_lane_policy where valid_to is null`.');
  return { applied: true, plan, results };
};

// Only connect/run when invoked directly (importing for tests never touches the DB).
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('seat_qwen_sole_model.js');
if (invokedDirectly) {
  const opts = parseArgv();
  const dbUrl = getFirmDatabaseUrl();
  if (!dbUrl) {
    console.error(
      '[seat-qwen-sole-model] FAILED: no database URL.\n'
      + '  Set DATABASE_URL (or POSTGRES_URL / SUPABASE_DB_URL) to the pooler string.'
    );
    process.exit(1);
  }
  run(opts)
    .then((r) => process.exit(r.applied || !opts.apply ? 0 : 1))
    .catch((err) => { console.error('[seat-qwen-sole-model] FAILED', err); process.exit(1); });
}
