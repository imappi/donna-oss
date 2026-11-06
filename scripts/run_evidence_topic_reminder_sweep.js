// One-shot MANUAL trigger for the evidence-topic reminder sweep — the demo/ops
// way to fire reminders on quiet open topics on demand. The scheduled cadence
// this header once said was "an explicit, separate decision" was decided by the
// UK readiness audit's §10 wire-existing list (2026-07-31): a daily cron now
// runs the sweep firm-wide (vercel.json → parse-cron?task=evidence_topic_reminders).
// This script stays for targeted single-client runs. Invoking either is safe by
// construction — runEvidenceTopicReminderSweep only sends where the
// EVIDENCE_TOPIC_REMINDERS flag ACTS (config-plane, canary/auto) AND an active
// binding exists; otherwise every candidate is HELD and nothing leaves.
//
// A --client is REQUIRED so this can never fan out across the whole firm by
// accident (an omitted clientId sweeps every client for the firm).
//
// USAGE:
//   node scripts/run_evidence_topic_reminder_sweep.js --client <id>            # sweep one client now
//   node scripts/run_evidence_topic_reminder_sweep.js --client <id> --firm <f> --limit 10

import { runEvidenceTopicReminderSweep } from '../server/donna/channels/evidenceTopicReminders.js';

export const parseArgv = (argv = process.argv.slice(2)) => {
  const out = { firmId: 'donna-production', clientId: null, limit: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--firm') { out.firmId = argv[i + 1]; i += 1; }
    else if (a === '--client') { out.clientId = argv[i + 1]; i += 1; }
    else if (a === '--limit') { out.limit = Number(argv[i + 1]); i += 1; }
  }
  return out;
};

const log = (...args) => console.log('[topic-reminder-sweep]', ...args);

const main = async () => {
  const opts = parseArgv();
  if (!opts.clientId) {
    log('REFUSED: --client <id> is required (refusing to sweep the whole firm).');
    process.exit(1);
    return;
  }
  log(`sweeping firm=${opts.firmId} client=${opts.clientId}${opts.limit ? ` limit=${opts.limit}` : ''}`);
  const stats = await runEvidenceTopicReminderSweep({
    firmId: opts.firmId,
    clientId: opts.clientId,
    ...(Number.isFinite(opts.limit) ? { limit: opts.limit } : {})
  });
  log('done:', JSON.stringify(stats));
  if (stats?.sent === 0 && stats?.held > 0) {
    log('NOTE: candidates were HELD — the EVIDENCE_TOPIC_REMINDERS flag is not acting for this client.');
    log('      Arm it: node scripts/enable_evidence_topic_reminders.js --client ' + opts.clientId + ' --apply');
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
}
