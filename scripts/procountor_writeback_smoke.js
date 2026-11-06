#!/usr/bin/env node
// Placeholder CLI for the Procountor live writeback runbook. It is intentionally
// env-free in tests; operators run the documented API steps after credentials
// and a Procountor test company are configured.
import { classifyProcountorWritebackSmoke } from '../server/donna/procountorWritebackSmoke.js';

if (process.argv.includes('--self-test')) {
  console.log(JSON.stringify(classifyProcountorWritebackSmoke({
    dryRun: { xero_writeback: { status: 'preview' } },
    execute: { xero_writeback: { status: 'synced', procountor_journal_entry_id: 'self-test' } },
    verify: { procountor_mirror_verification: { counts: { ok: 1, drift: 0, missing: 0 } } }
  }), null, 2));
} else {
  console.log('See docs/procountor-live-writeback-runbook.md. Pass --retry in the documented live lane to exercise mirror retry.');
}
