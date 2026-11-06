// Manual driver for the bank-line disposition sweep — the appliance's
// stand-in for the hourly cron until the desktop app runs its background
// half (which, as of 2026-08-17, it never has: zero loop_runs, cron never
// fired). Runs the EXACT production entry point (runBankLineDisposition
// from inngest/bankLineDisposition.js) — same firm gate, same policy
// resolution, same challenger hooks, same receipts.
//
// The 2026-08-17 lesson this script hardens against: an ad-hoc `node -e`
// invocation ran against the wrong DATABASE_URL (a sourced .env overrode
// the appliance socket) and then against a stale endpoint (.env's Together
// config instead of .env.local's OpenRouter) — so this driver PRINTS ITS
// RECEIPTS FIRST (database, firm gates, endpoint, model) and refuses to
// run until invoked with --run. The deploy-state rail, applied to sweeps:
// the first reading is the receipt, not a hypothesis.
//
// The env mode gate (BANK_LINE_DISPOSITION_MODE=llm) is forced for this
// invocation and SAID so — invoking this script IS the deliberate act the
// env switch represents. The durable authority stays the firm metadata
// gate (metadata->bank_line_disposition->enabled = 'true'), which this
// script reads and prints but never writes.
//
// USAGE:
//   node scripts/run_bank_line_disposition_sweep.js          # receipts only, no sweep
//   node scripts/run_bank_line_disposition_sweep.js --run    # receipts, then sweep

import { withFirmDbClient } from '../server/donna/firmDb.js';
import { runBankLineDisposition } from '../server/donna/inngest/bankLineDisposition.js';

export const parseArgv = (argv = process.argv.slice(2)) => {
  const out = { run: false };
  for (const a of argv) {
    if (a === '--run') out.run = true;
  }
  return out;
};

const log = (...args) => console.log('[run-disposition-sweep]', ...args);

const main = async () => {
  const opts = parseArgv();

  // Receipt 1 — which database this process will sweep.
  const dbReceipt = await withFirmDbClient(async (client) => {
    const db = await client.query('select current_database() as db');
    const gates = await client.query(
      `select id, metadata->'bank_line_disposition'->>'enabled' as gate
         from firms
        order by id`
    );
    return { db: db.rows[0]?.db, gates: gates.rows || [] };
  });
  log(`database: ${dbReceipt.db}`);
  for (const firm of dbReceipt.gates) {
    log(`  firm ${firm.id}: cron gate = ${firm.gate || '(unset — the sweep will not enumerate this firm)'}`);
  }

  // Receipt 2 — the endpoint the seated policy would route over. Base URL
  // and model only; never the key.
  log(`endpoint: ${process.env.OPENAI_COMPATIBLE_BASE_URL || '(unset)'}  model: ${process.env.OPENAI_COMPATIBLE_MODEL || '(unset)'}`);
  log(`anthropic key present: ${process.env.ANTHROPIC_API_KEY ? 'yes' : 'NO — anthropic-DECIDED sweeps report no_anthropic_api_key; a seated non-claude rung still runs, unscored (no reverse shadow)'}`);

  if (!opts.run) {
    log('RECEIPTS ONLY — no sweep. Re-run with --run to execute.');
    return;
  }

  // The deliberate act: this invocation is the env switch.
  process.env.BANK_LINE_DISPOSITION_MODE = 'llm';
  log('BANK_LINE_DISPOSITION_MODE forced to llm for this invocation (firm gates still apply).');

  const summary = await runBankLineDisposition({});
  log('summary:', JSON.stringify(summary, null, 2));
  if (summary.transport_failures > 0 || (summary.errors || []).length > 0) {
    log('⚠ transport failures / errors present — nothing junk was stamped (transport-class failures skip the stamp), fix the endpoint and re-run; the incremental guard re-picks the skipped lines.');
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(() => process.exit(0))
    .catch((error) => { console.error('[run-disposition-sweep] FAILED:', error?.message || error); process.exit(1); });
}
