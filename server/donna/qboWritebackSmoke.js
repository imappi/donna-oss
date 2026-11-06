// QBO live-writeback smoke harness — pure core (INT-2 of
// docs/donna-ledger-integrations-finish-plan.md; ports xeroWritebackSmoke.js).
//
// The QBO write path (connect → reference sync → JournalEntry writeback →
// mirror-verify) is live server-side but has NEVER been exercised against a
// real Intuit sandbox — that validation is the exit criterion for the FE
// `available: false` gate in src/lib/clientAxes.js. This module turns a
// DRY-RUN outcome of `writebackQboTransactionInDb({ dryRun: true })` — a
// success preview OR a thrown blocker — into a structured READY / NOT-READY
// verdict with an operator hint, so the first live QBO write is a guided,
// observable pre-flight instead of an opaque pass/throw. No I/O here; the CLI
// (scripts/qbo_writeback_smoke.js) orchestrates, this interprets.
//
// Trust-the-strong-LLM principle — still in force (see CLAUDE.md +
// docs/donna-llm-trust-strategy.md): this is system-correctness scaffolding
// (surfacing a real persisted/preview verdict), not intelligence substitution.

const trim = (value) => String(value ?? '').trim();

// QBO writeback failures carry stable machine codes (qboWriteback.js throws
// QBO_WRITEBACK_*; firmDb.js throws QBO_CONNECTION_EXPIRED since INT-1), so —
// unlike the Xero rules, which mostly match message fragments — codes match
// first and messages are the fallback for the pre-code errors (config,
// connection row, journal lookup). Each rule carries the one-line operator fix.
const BLOCKER_RULES = [
  { code: 'not_configured', match: ({ message }) => /not configured|QBO_CLIENT_ID|QBO_CLIENT_SECRET|QBO_REDIRECT/i.test(message),
    hint: 'Set QBO_CLIENT_ID / QBO_CLIENT_SECRET / QBO_REDIRECT_URI (and QBO_ENVIRONMENT) in the environment, then redeploy.' },
  { code: 'not_connected', match: ({ message }) => /QuickBooks Online connection not found/i.test(message),
    hint: 'Connect a QBO company first: GET /xero/connect for a qbo client → authorise at Intuit → /qbo/callback. Confirm a qbo_connections row (status=connected).' },
  { code: 'connection_expired', match: ({ code }) => code === 'QBO_CONNECTION_EXPIRED',
    hint: 'The refresh token is dead (Intuit rotates + hard-expires them ~100 days). Reconnect QuickBooks from the firm workspace accounting card.' },
  { code: 'journal_not_posted', match: ({ message }) => /No posted ledger journal found/i.test(message),
    hint: 'QBO writeback mirrors POSTED Donna ledger journals. Post the transaction to the ledger first (/ledger/post-transaction), then re-run.' },
  { code: 'no_lines', match: ({ code }) => code === 'QBO_WRITEBACK_NO_LINES',
    hint: 'The ledger journal has no postable (non-zero) lines — inspect the journal.' },
  { code: 'no_accounts', match: ({ code }) => code === 'QBO_WRITEBACK_NO_ACCOUNTS',
    hint: 'No QuickBooks accounts are synced for this client — run the reference sync (--sync) first.' },
  { code: 'unmapped_account', match: ({ code }) => code === 'QBO_WRITEBACK_UNMAPPED_ACCOUNT',
    hint: 'A ledger line has no QBO account match (AcctNum, then name). Re-sync (--sync); if it persists, align the QBO account number/name with the Donna chart — QBO has no provision-coa, mapping is resolve-at-writeback.' },
  { code: 'unbalanced', match: ({ code }) => code === 'QBO_WRITEBACK_UNBALANCED',
    hint: 'Debits ≠ credits on the ledger journal — this should be impossible for a posted journal; investigate before writing anything to QBO.' }
];

// Classify a dry-run outcome. Pass EITHER { result } (the resolved value of
// writebackQboTransactionInDb with dryRun:true) OR { error } (the thrown
// blocker). Returns { ready, blocker, summary }.
export const classifyQboWritebackDryRun = ({ result = null, error = null } = {}) => {
  if (error) {
    const code = error?.code || null;
    const message = String(error?.message || error || '').trim();
    const rule = BLOCKER_RULES.find((r) => r.match({ code, message })) || null;
    const blocker = {
      code: rule?.code || code || 'error',
      message,
      hint: rule?.hint || null,
      status: error?.statusCode || null
    };
    // The unmapped-account error carries the offending lines — surface them.
    if (Array.isArray(error?.unmapped) && error.unmapped.length) {
      blocker.unmapped = error.unmapped;
    }
    return { ready: false, blocker, summary: null };
  }
  // The single-transaction writer returns the preview under the route's
  // existing `xero_writeback` envelope key even for QBO (naming debt noted in
  // the census §6/§9); the inner source marks the connector.
  const wb = result?.xero_writeback || result?.preview || null;
  if (!wb || !wb.journal_entry) {
    return {
      ready: false,
      blocker: { code: 'no_preview', message: 'Dry run returned no QBO journal-entry preview.', hint: 'Confirm writebackQboTransactionInDb was called with dryRun: true.', status: null },
      summary: null
    };
  }
  const je = wb.journal_entry;
  const summary = wb.summary || {};
  return {
    ready: true,
    blocker: null,
    summary: {
      realm: wb.realm_id || null,
      journal_id: wb.journal_id || null,
      doc_number: summary.doc_number || je.DocNumber || null,
      txn_date: je.TxnDate || null,
      lines: summary.lines ?? (Array.isArray(je.Line) ? je.Line.length : null),
      debit_total: summary.debit_total ?? null,
      credit_total: summary.credit_total ?? null,
      update: Boolean(summary.update),
      already_synced: Boolean(wb.already_synced)
    }
  };
};

// A bounded, printable report for the CLI and the runbook. Pure.
export const formatQboWritebackReadiness = (verdict = {}, { transactionId } = {}) => {
  const lines = [];
  const head = verdict.ready ? 'READY' : 'NOT READY';
  lines.push(`Transaction ${transactionId || '(unknown)'} — QBO writeback dry-run: ${head}`);
  if (verdict.ready && verdict.summary) {
    const s = verdict.summary;
    lines.push(`  realm:     ${s.realm ?? '(unknown)'}`);
    lines.push(`  journal:   ${s.journal_id ?? '?'} → JournalEntry ${s.update ? 'UPDATE' : 'create'} (doc ${s.doc_number ?? '?'}, ${s.txn_date ?? '?'})`);
    lines.push(`  lines:     ${s.lines ?? '?'} (debits ${s.debit_total ?? '?'} / credits ${s.credit_total ?? '?'})`);
    if (s.already_synced) {
      lines.push('  note:      mirror already synced — execute will skip unless --force (then it updates in place via Id+SyncToken).');
    }
  } else if (verdict.blocker) {
    const b = verdict.blocker;
    lines.push(`  blocker:   [${b.code}] ${b.message}`);
    if (Array.isArray(b.unmapped) && b.unmapped.length) {
      const labels = b.unmapped
        .map((u) => trim(u.account_code) && trim(u.account_name)
          ? `${trim(u.account_code)} · ${trim(u.account_name)}`
          : trim(u.account_name) || trim(u.account_code) || '(unnamed)')
        .join(', ');
      lines.push(`  unmapped:  ${labels}`);
    }
    if (b.hint) lines.push(`  fix:       ${b.hint}`);
  }
  return lines.join('\n');
};
