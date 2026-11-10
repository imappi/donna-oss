// Labels for values that code inserts into an interface sentence. The value
// itself (a stored code, a model's free-text guess) never changes and never
// reaches the screen as it is stored: a known code reads as its catalog label,
// anything else as its kind's catalog fallback. The messages live in
// src/i18n/catalogs/interfaceValues.*.js.

const message = (formatMessage, id, defaultMessage, values) => (
  typeof formatMessage === 'function'
    ? formatMessage({ id, defaultMessage }, values)
    : defaultMessage
);

// Stored document types (the documents.document_type vocabulary) and the
// generic extractor's example guesses (server/donna/genericDocument.js prompt),
// in snake case. Scope slugs (supplier-bill) and humanised guesses
// (tax notice) normalise to the same code.
const DOCUMENT_TYPE_MESSAGES = Object.freeze({
  receipt: ['upload.documentType.receipt', 'receipt'],
  supplier_bill: ['upload.documentType.supplierBill', 'supplier bill'],
  sales_invoice: ['upload.documentType.salesInvoice', 'sales invoice'],
  issued_receipt: ['upload.documentType.issuedReceipt', 'issued receipt'],
  payment_confirmation: ['upload.documentType.paymentConfirmation', 'payment confirmation'],
  payment_account_statement: ['upload.documentType.paymentAccountStatement', 'payment account statement'],
  contract: ['upload.documentType.contract', 'contract'],
  payout_statement: ['upload.documentType.payoutStatement', 'payout statement'],
  deposit_slip: ['upload.documentType.depositSlip', 'deposit slip'],
  bank_statement: ['upload.documentType.bankStatement', 'bank statement'],
  statutory_record: ['upload.documentType.statutoryRecord', 'registry document'],
  company_or_statutory_record: ['upload.documentType.statutoryRecord', 'registry document'],
  tax_notice: ['upload.documentType.taxNotice', 'tax notice'],
  government_letter: ['upload.documentType.governmentLetter', 'letter from an authority'],
  insurance_policy: ['upload.documentType.insurancePolicy', 'insurance policy'],
  utility_bill: ['upload.documentType.utilityBill', 'utility bill'],
  rental_agreement: ['upload.documentType.rentalAgreement', 'rental agreement'],
  safety_certificate: ['upload.documentType.safetyCertificate', 'safety certificate']
});
const OTHER_DOCUMENT = ['upload.documentType.other', 'other document'];

export const documentTypeCode = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .replace(/[\s-]+/g, '_');

// A document type in mid-sentence form ("Saved · {documentType}").
export const trayDocumentTypeLabel = (value, formatMessage = null) => {
  const [id, fallback] = DOCUMENT_TYPE_MESSAGES[documentTypeCode(value)] || OTHER_DOCUMENT;
  return message(formatMessage, id, fallback);
};

// The ask-client prompt's {businessUse} phrase.
export const askClientBusinessUse = (moneyIn, formatMessage = null) => (
  moneyIn
    ? message(formatMessage, 'transaction.question.businessIncome', 'business income')
    : message(formatMessage, 'transaction.question.businessExpense', 'a business expense')
);

// The ask-client prompt's {transaction} phrase: which line, and when / how
// much when known. `date` and `amount` arrive already formatted.
export const askClientTransactionPhrase = ({ vendor = null, date = null, amount = null } = {}, formatMessage = null) => {
  const subject = vendor
    ? message(formatMessage, 'transaction.question.subjectNamed', `the ${vendor} transaction`, { vendor })
    : message(formatMessage, 'transaction.question.subjectUnnamed', 'this transaction');
  const known = [date, amount].filter((value) => value && value !== '—');
  if (!known.length) return subject;
  const detail = known.length === 2
    ? message(formatMessage, 'transaction.question.dateAmount', `${date} for ${amount}`, { date, amount })
    : known[0];
  return message(formatMessage, 'transaction.question.subjectWhen', `${subject} on ${detail}`, { transaction: subject, detail });
};

const JOURNAL_STATUSES = new Set(['draft', 'posted', 'voided', 'closed']);
// A ledger journal's stored status (ledger_journals.status).
export const journalStatusLabel = (status, formatMessage = null) => {
  const code = String(status || '').trim().toLowerCase();
  return JOURNAL_STATUSES.has(code)
    ? message(formatMessage, `portal.inspection.journalStatus.${code}`, code)
    : message(formatMessage, 'portal.inspection.journalStatus.unknown', 'Status not recognised');
};

// A chat action's stored status once it can no longer be applied (proposed
// and applied have their own affordances in the feed card).
export const feedActionStatusLabel = (status, formatMessage = null) => (
  status === 'superseded'
    ? message(formatMessage, 'feed.action.status.superseded', 'Superseded by a later reply')
    : message(formatMessage, 'feed.action.status.unknown', 'Not applied')
);

// A code → message table with one fallback. `table` maps a stored code to
// [id, English fallback]; anything else reads as `other`.
const labelFrom = (table, other) => (code, formatMessage = null, values = undefined) => {
  const [id, fallback] = table[String(code ?? '').trim()] || other;
  return message(formatMessage, id, fallback, values);
};

// ── Team panel ─────────────────────────────────────────────────────────────
// A specialist role's standing grant: its action (the roleRegistry.js
// action_set verbs) and its status (actionAuthorityGrants.js
// ACTION_GRANT_STATUSES, the same labels as the reconciliation grants).
export const teamGrantActionLabel = labelFrom({
  issue_invoice: ['team.grant.action.issueInvoice', 'Issue invoices'],
  send_quote: ['team.grant.action.sendQuote', 'Send quotes'],
  send_receivable_reminder: ['team.grant.action.sendReceivableReminder', 'Send payment reminders'],
  create_pay_link: ['team.grant.action.createPayLink', 'Create payment links'],
  record_reply_correction: ['team.grant.action.recordReplyCorrection', 'Record corrections from replies'],
  capture_structured_reference: ['team.grant.action.captureStructuredReference', 'Capture payment references'],
  post_inventory_journal: ['team.grant.action.postInventoryJournal', 'Post inventory journals']
}, ['team.grant.action.unknown', 'Another action']);

export const authorityGrantStatusLabel = labelFrom({
  proposed: ['firm.reconAuthority.grants.status.proposed', 'Proposed'],
  active: ['firm.reconAuthority.grants.status.active', 'Active'],
  suspended: ['firm.reconAuthority.grants.status.suspended', 'Suspended'],
  revoked: ['firm.reconAuthority.grants.status.revoked', 'Revoked']
}, ['firm.reconAuthority.grants.status.unknown', 'Status not recognised']);

export const UNKNOWN_SEAT_ROLE = ['team.seat.role.unknown', 'Role not recognised'];
export const seatRoleUnknownLabel = (formatMessage = null) => message(formatMessage, ...UNKNOWN_SEAT_ROLE);

// An invite email's outcome (seatsDb.js / clientOwnerInvitesDb.js: sent,
// skipped, failed), as the word inside "Invite email {status}".
export const inviteEmailStatusWord = labelFrom({
  sent: ['team.inviteEmail.status.sent', 'sent'],
  skipped: ['team.inviteEmail.status.skipped', 'not sent'],
  failed: ['team.inviteEmail.status.failed', 'failed to send']
}, ['team.inviteEmail.status.unknown', 'status not recognised']);

// Why an invite email was not sent. The server's reason is a code or a
// provider's error text; only the codes have a sentence, the rest read as the
// generic one.
export const inviteEmailReasonLabel = labelFrom({
  resend_not_configured: ['team.inviteEmail.reason.notConfigured', 'Email sending is not set up on this deployment'],
  public_origin_not_configured: ['team.inviteEmail.reason.noPublicAddress', 'This deployment has no public address for the sign-in link']
}, ['team.inviteEmail.reason.other', 'The email provider did not accept the message']);

// ── Hosted pilot readiness (hostCertificateA.js) ───────────────────────────
export const pilotCheckStatusLabel = labelFrom({
  PASS: ['settings.cloudPilot.checkStatus.pass', 'Passed'],
  FAIL: ['settings.cloudPilot.checkStatus.fail', 'Failed'],
  INCOMPLETE: ['settings.cloudPilot.checkStatus.incomplete', 'Incomplete']
}, ['settings.cloudPilot.checkStatus.unknown', 'Status not recognised']);

const PILOT_REASONS = Object.freeze({
  postgresql_not_configured: ['settings.cloudPilot.reason.databaseNotConfigured', 'The database is not configured'],
  postgresql_probe_failed: ['settings.cloudPilot.reason.databaseProbeFailed', 'The database did not answer the check'],
  storage_not_configured: ['settings.cloudPilot.reason.storageNotConfigured', 'File storage is not configured'],
  storage_lifecycle_probe_failed: ['settings.cloudPilot.reason.storageProbeFailed', 'The file storage check failed'],
  runtime_manifest_missing: ['settings.cloudPilot.reason.workerListMissing', 'The list of workers is missing'],
  scheduler_manifest_probe_failed: ['settings.cloudPilot.reason.workerProbeFailed', 'The worker check failed'],
  config_plane_probe_failed: ['settings.cloudPilot.reason.configProbeFailed', 'The configuration check failed'],
  artifact_digest_failed: ['settings.cloudPilot.reason.policyFilesUnchecked', 'The policy files could not be checked'],
  work_queue_needs_recovery: ['settings.cloudPilot.reason.workQueueRecovery', 'The work queue needs recovery'],
  build_commit_missing: ['settings.cloudPilot.reason.buildVersionMissing', 'The deployed version is not recorded'],
  build_dirty_state_missing: ['settings.cloudPilot.reason.buildChangesUnknown', 'It is not recorded whether the build had local changes'],
  dirty_runtime_build: ['settings.cloudPilot.reason.buildHasChanges', 'The deployed build has local changes'],
  workspace_dirty_runtime_clean: ['settings.cloudPilot.reason.changesOutsideRuntime', 'Local changes exist outside the running code'],
  response_unverified: ['settings.cloudPilot.reason.responseUnverified', 'No verified provider response yet'],
  response_failed: ['settings.cloudPilot.reason.responseFailed', 'The provider’s response failed'],
  execution_unverified: ['settings.cloudPilot.reason.executionUnverified', 'No verified worker run yet'],
  execution_failed: ['settings.cloudPilot.reason.executionFailed', 'The worker run failed']
});
// An unknown reason keeps its code, shown as a code.
export const pilotCheckReasonLabel = (reason, formatMessage = null) => {
  const known = PILOT_REASONS[String(reason || '').trim()];
  return known
    ? message(formatMessage, ...known)
    : message(formatMessage, 'settings.cloudPilot.reason.unknown', `Another reason, code ${reason}`, { code: String(reason) });
};

export const PILOT_CHECK_IDS = Object.freeze([
  'source_build', 'database_schema', 'scheduler_worker_manifest', 'evidence_storage', 'model_routes',
  'provider_capability', 'policy_oracle_artifacts', 'config_control_plane', 'accounting_adapter', 'spend_meter'
]);

// The entity readiness row's state after the reviewed settings are saved
// (entityReadiness ENTITY_READINESS_STATES; anything else is incomplete).
export const pilotEntityStateLabel = labelFrom({
  ready: ['settings.cloudPilot.entityState.ready', 'ready'],
  provisioning: ['settings.cloudPilot.entityState.provisioning', 'being set up'],
  failed: ['settings.cloudPilot.entityState.failed', 'failed']
}, ['settings.cloudPilot.entityState.incomplete', 'incomplete']);

// A capability flag's stage (clientConfig.js CONFIG_STAGES).
export const configStageLabel = labelFrom({
  off: ['settings.cloudPilot.stage.off', 'off'],
  dry_run: ['settings.cloudPilot.stage.dryRun', 'dry run'],
  shadow: ['settings.cloudPilot.stage.shadow', 'shadow (observed only)'],
  canary: ['settings.cloudPilot.stage.canary', 'canary (this client only)'],
  auto: ['settings.cloudPilot.stage.auto', 'on']
}, ['settings.cloudPilot.stage.unknown', 'stage not recognised']);

// ── Owner portal chat (ownerIntentRuntime.js, intentObjects.js) ────────────
export const ownerIntentKindLabel = labelFrom({
  memory: ['portal.chat.intent.kind.memory', 'Something to remember'],
  preference: ['portal.chat.intent.kind.preference', 'Preference'],
  policy: ['portal.chat.intent.kind.policy', 'Rule'],
  goal: ['portal.chat.intent.kind.goal', 'Goal'],
  commitment: ['portal.chat.intent.kind.commitment', 'Commitment'],
  task: ['portal.chat.intent.kind.task', 'Task'],
  automation: ['portal.chat.intent.kind.automation', 'Automation'],
  workflow: ['portal.chat.intent.kind.workflow', 'Workflow'],
  authority_grant: ['portal.chat.intent.kind.authorityGrant', 'Permission request']
}, ['portal.chat.intent.kind.unknown', 'Other request']);

export const ownerIntentStatusLabel = labelFrom({
  suggested: ['portal.chat.intent.status.suggested', 'Suggested'],
  prepared: ['portal.chat.intent.status.prepared', 'Prepared'],
  staged: ['portal.chat.intent.status.staged', 'Waiting'],
  planned: ['portal.chat.intent.status.planned', 'Planned'],
  computed: ['portal.chat.intent.status.computed', 'Worked out'],
  not_computed: ['portal.chat.intent.status.notComputed', 'Not worked out yet'],
  blocked: ['portal.chat.intent.status.blocked', 'Blocked'],
  requires_review: ['portal.chat.intent.status.requiresReview', 'Needs review'],
  requires_confirmation: ['portal.chat.intent.status.requiresConfirmation', 'Needs confirmation'],
  owner_confirmation_required: ['portal.chat.intent.status.ownerConfirmationRequired', 'Needs your confirmation'],
  pass: ['portal.chat.intent.status.pass', 'Passed'],
  warning: ['portal.chat.intent.status.warning', 'Passed with a warning'],
  fail: ['portal.chat.intent.status.fail', 'Failed'],
  refused: ['portal.chat.intent.status.refused', 'Refused'],
  skipped: ['portal.chat.intent.status.skipped', 'Skipped']
}, ['portal.chat.intent.status.unknown', 'Status not recognised']);

export const ownerIntentBlockerLabel = labelFrom({
  apply_executor_not_enabled: ['portal.chat.intent.blocker.applyNotEnabled', 'Applying is not switched on yet'],
  consequence_diff_not_computed: ['portal.chat.intent.blocker.effectNotWorkedOut', 'The effect of this change has not been worked out yet'],
  authority_envelope_blocked: ['portal.chat.intent.blocker.permissionIncomplete', 'The permission for this change is not complete'],
  unsupported_intent_kind: ['portal.chat.intent.blocker.unsupportedKind', 'Donna cannot carry out this kind of request yet'],
  ask_client_diff_missing_summary: ['portal.chat.intent.blocker.summaryMissing', 'The request needs a short summary first']
}, ['portal.chat.intent.blocker.unknown', 'Another check is still open']);

export const portalChannelLabel = labelFrom({
  email: ['portal.chat.channel.email', 'Email'],
  whatsapp: ['portal.chat.channel.whatsapp', 'WhatsApp'],
  sms: ['portal.chat.channel.sms', 'Text message'],
  telegram: ['portal.chat.channel.telegram', 'Telegram'],
  portal: ['portal.chat.channel.portal', 'Portal'],
  client_chat: ['portal.chat.channel.portal', 'Portal'],
  mobile: ['portal.chat.channel.mobile', 'Mobile app']
}, ['portal.chat.channel.other', 'Another channel']);

// ── Transaction audit panel: a failed load ─────────────────────────────────
// The transport error ("Firm data request failed with 404") never reaches the
// screen; its HTTP status picks a sentence that says what to do.
export const auditLoadErrorMessageId = (error) => {
  const status = Number(error?.status || error?.statusCode || 0);
  if (status === 404) return 'transaction.audit.error.notFound';
  if (status === 401 || status === 403) return 'transaction.audit.error.session';
  if (!status || status >= 500) return 'transaction.audit.error.unavailable';
  return 'transaction.audit.error.load';
};
