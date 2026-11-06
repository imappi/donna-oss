// Xero live-writeback smoke harness — pure core.
//
// "Validate the live Xero writeback end-to-end" is fundamentally a run-it-
// against-a-connected-sandbox activity: the write path makes REAL HTTP calls to
// Xero when credentials are present, but it has never been exercised against a
// live org (every test is mock-only). This module turns a DRY-RUN outcome of
// `writebackXeroTransactionInDb({ dryRun: true })` — a success preview OR a
// thrown blocker — into a structured READY / NOT-READY verdict with an operator
// hint, so the first live writeback is a guided, observable pre-flight instead
// of an opaque pass/throw. It performs no I/O; the CLI (scripts/
// xero_writeback_smoke.js) does the orchestration, this does the interpretation.
//
// Trust-the-strong-LLM principle — still in force (see CLAUDE.md +
// docs/donna-llm-trust-strategy.md): this is system-correctness scaffolding
// (surfacing a real persisted/preview verdict), not intelligence substitution.

const trim = (value) => String(value ?? '').trim();

// Label a desired Donna CoA account from a provision-plan action.
const desiredLabel = (desired = {}) => {
  const code = trim(desired.code);
  const name = trim(desired.name);
  return code && name ? `${code} · ${name}` : name || code;
};

// The build-time validations in buildXeroBankTransactionWriteback all throw with
// code 'XERO_WRITEBACK_INVALID_PAYLOAD' but DISTINCT messages, so the specific
// blocker is matched by a stable message fragment. Machine `error.code`s
// (already-synced, ambiguous, configured/connection) are preferred when present.
// Each rule carries the one-line operator fix.
const BLOCKER_RULES = [
  // Pre-flight / connection (matched by code first, then message).
  { code: 'not_configured', match: ({ message }) => /not configured|XERO_CLIENT_ID|XERO_CLIENT_SECRET|XERO_REDIRECT/i.test(message),
    hint: 'Set XERO_CLIENT_ID / XERO_CLIENT_SECRET / XERO_REDIRECT_URI in the environment, then redeploy.' },
  { code: 'not_connected', match: ({ message }) => /no (fresh )?xero connection|not connected to xero|connect a xero|no xero org/i.test(message),
    hint: 'Connect a Xero org first: GET /xero/connect → authorise in Xero → /xero/callback. Confirm an xero_connections row (status=connected).' },
  { code: 'missing_scope', match: ({ message }) => /scope/i.test(message),
    hint: 'Reconnect the Xero org with the accounting.banktransactions scope.' },
  { code: 'already_synced', match: ({ code }) => code === 'XERO_WRITEBACK_ALREADY_SYNCED',
    hint: 'This transaction already carries a xero_bank_transaction_id. Re-run with --force to overwrite it in Xero.' },
  { code: 'transaction_not_found', match: ({ message }) => /transaction not found/i.test(message),
    hint: 'Check the --transaction id belongs to this --client.' },
  // Build-time payload validations (all code XERO_WRITEBACK_INVALID_PAYLOAD).
  { code: 'no_bank_account', match: ({ message }) => /bank account is synced/i.test(message),
    hint: 'Sync reference data (--sync) and ensure a Xero bank account exists for this transaction currency.' },
  { code: 'account_unmatched', match: ({ message }) => /matched Xero account code/i.test(message),
    hint: 'The coded account has no Xero match. Sync reference data (--sync), then map it — or provision the chart of accounts (POST /xero/provision-coa) so the account exists in Xero.' },
  { code: 'bank_account_no_identifier', match: ({ message }) => /missing both Code and AccountID/i.test(message),
    hint: 'The synced Xero bank account row has neither a Code nor an AccountID — re-sync reference data.' },
  { code: 'bank_equals_line', match: ({ message }) => /same as the bank account/i.test(message),
    hint: 'The coded account resolves to the bank account itself — recode the line to an income/expense account.' },
  { code: 'invalid_amount', match: ({ message }) => /amount must be greater than zero/i.test(message),
    hint: 'The transaction has no positive amount to write back.' },
  { code: 'no_direction', match: ({ message }) => /money_in or money_out/i.test(message),
    hint: 'The transaction has neither money_in nor money_out — it cannot post as a SPEND or RECEIVE.' },
  { code: 'no_date', match: ({ message }) => /date is required/i.test(message),
    hint: 'The transaction has no date to post against.' }
];

// Classify a dry-run outcome. Pass EITHER { result } (the resolved value of
// writebackXeroTransactionInDb with dryRun:true) OR { error } (the thrown
// blocker). Returns { ready, blocker, summary }.
export const classifyXeroWritebackDryRun = ({ result = null, error = null } = {}) => {
  if (error) {
    const code = error?.code || null;
    const message = String(error?.message || error || '').trim();
    const rule = BLOCKER_RULES.find((r) => r.match({ code, message })) || null;
    return {
      ready: false,
      blocker: {
        code: rule?.code || code || 'error',
        message,
        hint: rule?.hint || null,
        status: error?.statusCode || null
      },
      summary: null
    };
  }
  const wb = result?.xero_writeback || null;
  // Dry-run PROPOSE: a coded account with no Xero match now returns a structured
  // provision plan instead of throwing. Read the persisted verdict and surface
  // the plan (accounts to create) so the operator can apply provision-coa in one
  // view — it is a PROPOSE, never an auto-create.
  if (wb && wb.ready === false && wb.blocker === 'account_unmatched') {
    const plan = wb.provision_plan || {};
    const counts = plan.counts || {};
    const um = wb.unmatched || {};
    const account = trim(um.account_name) || trim(um.proposed_account) || trim(um.account_code) || '(unknown)';
    const toCreate = Array.isArray(plan.actions)
      ? plan.actions.filter((action) => action.action === 'create').map((action) => desiredLabel(action.desired))
      : [];
    return {
      ready: false,
      blocker: {
        code: 'account_unmatched',
        message: `Coded account "${account}" has no matching Xero account code.`,
        hint: 'Provision the chart of accounts (POST /xero/provision-coa) so the coded account exists in Xero, then re-run. PROPOSE only — review the plan before applying.',
        status: null,
        unmatched: um,
        provision_plan: counts.desired != null ? counts : null,
        proposed_accounts: toCreate
      },
      summary: null
    };
  }
  if (!wb || !wb.bank_transaction) {
    return {
      ready: false,
      blocker: { code: 'no_preview', message: 'Dry run returned no Xero writeback preview.', hint: 'Confirm writebackXeroTransactionInDb was called with dryRun: true.', status: null },
      summary: null
    };
  }
  const bt = wb.bank_transaction;
  const line = (Array.isArray(bt.LineItems) ? bt.LineItems[0] : null) || {};
  return {
    ready: true,
    blocker: null,
    summary: {
      tenant: wb.tenant_name || wb.tenant_id || null,
      type: bt.Type || null, // SPEND | RECEIVE
      amount: line.UnitAmount ?? null,
      line_account_code: line.AccountCode || null,
      line_account_label: wb.coding?.account_label || wb.coding?.xero_account_name || null,
      tax_type: line.TaxType || bt.LineAmountTypes || null,
      contact: bt.Contact?.Name || null,
      bank_account: wb.bank_account?.name || wb.bank_account?.code || null,
      reference: bt.Reference || null,
      idempotency_key: wb.idempotency_key || null
    }
  };
};

// A bounded, printable report for the CLI and the runbook. Pure.
export const formatXeroWritebackReadiness = (verdict = {}, { transactionId } = {}) => {
  const lines = [];
  const head = verdict.ready ? 'READY' : 'NOT READY';
  lines.push(`Transaction ${transactionId || '(unknown)'} — Xero writeback dry-run: ${head}`);
  if (verdict.ready && verdict.summary) {
    const s = verdict.summary;
    lines.push(`  org:       ${s.tenant ?? '(unknown)'}`);
    lines.push(`  posting:   ${s.type ?? '?'} ${s.amount ?? '?'} -> ${s.line_account_code ?? '?'} (${s.line_account_label ?? '?'}) [${s.tax_type ?? '?'}]`);
    lines.push(`  contact:   ${s.contact || '(none)'}`);
    lines.push(`  bank acct: ${s.bank_account ?? '(unknown)'}`);
    lines.push(`  idem-key:  ${s.idempotency_key ?? '(none)'}`);
  } else if (verdict.blocker) {
    const b = verdict.blocker;
    lines.push(`  blocker:   [${b.code}] ${b.message}`);
    if (b.unmatched) {
      const coded = b.unmatched.account_name || b.unmatched.proposed_account || b.unmatched.account_code;
      if (coded) lines.push(`  coded as:  ${coded} (no Xero match)`);
    }
    if (b.provision_plan) {
      const p = b.provision_plan;
      lines.push(`  provision: ${p.create ?? 0} to create, ${p.already_exists ?? 0} already in Xero, ${p.blocked ?? 0} blocked (of ${p.desired ?? 0} Donna accounts)`);
    }
    if (Array.isArray(b.proposed_accounts) && b.proposed_accounts.length) {
      lines.push(`  to create: ${b.proposed_accounts.join(', ')}`);
    }
    if (b.hint) lines.push(`  fix:       ${b.hint}`);
  }
  return lines.join('\n');
};
