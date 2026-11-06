export const DEFAULT_MODEL = 'gpt-4.1';
export const MODEL_OPTIONS = ['gpt-4.1', 'gpt-5.4'];

export const QUEUE_LABELS = {
  auto_send: 'Auto-send',
  ops_review: 'Client intake',
  expert_review: 'Compliance review',
  execution_queue: 'Xero handoff'
};

export const QUEUE_BADGE_VARIANT = {
  auto_send: 'green',
  ops_review: 'amber',
  expert_review: 'red',
  execution_queue: 'blue'
};

export const CONFIDENCE_LABELS = {
  high: 'High confidence',
  medium: 'Medium',
  low: 'Low confidence'
};

export const CONFIDENCE_VARIANT = {
  high: 'green',
  low: 'red',
  medium: 'amber'
};

export const TRIGGER_FRIENDLY = {
  looping: 'Customer repeating themselves',
  contradiction: 'Conflicting guidance given',
  no_path: 'No clear next step',
  queue_age: 'Waiting too long',
  frustration: 'Customer frustrated',
  high_impact: 'High-value issue',
  firm_missing_docs: 'Missing documents',
  firm_software_support: 'Software support',
  firm_closed_period: 'Closed period',
  firm_accountant_review: 'Compliance review',
  firm_reconciliation: 'Reconciliation',
  firm_client_intake: 'Client intake',
  firm_bizfile_mismatch: 'Bizfile mismatch',
  firm_compliance_review: 'Compliance review',
  firm_record_change: 'Officer/shareholder change',
  firm_xero_handoff: 'Xero handoff',
  firm_annual_return: 'Annual return',
  firm_accounting_document_intake: 'Document intake'
};

export const FIRM_PATTERN_LABELS = {
  tax_or_advisory_boundary: 'Advisory boundary',
  missing_docs: 'Missing docs',
  software_admin: 'Software admin',
  closed_period: 'Closed period',
  banking_reconciliation: 'Reconciliation',
  missing_intake_detail: 'Missing intake detail',
  bizfile_mismatch: 'Bizfile mismatch',
  aml_cdd_evidence: 'AML/CDD evidence',
  officer_shareholder_change: 'Officer/shareholder change',
  annual_return_deadline: 'Annual return deadline',
  xero_sync_issue: 'Xero sync issue',
  xero_handoff: 'Xero handoff',
  bookkeeping_document_intake: 'Bookkeeping intake',
  rqi_compliance_review: 'RQI/compliance review'
};

export const OUTCOME_LABELS = {
  approved: 'Sent',
  rejected: 'Rejected',
  unblocked: 'Resolved',
  still_stuck: 'Still stuck',
  escalated: 'Escalated',
  reopened: 'Reopened',
  assigned_accountant: 'Assigned',
  accountant_answered: 'Reviewed',
  accountant_needs_info: 'Needs info',
  returned_to_ops: 'Returned'
};

export const OUTCOME_VARIANT = {
  approved: 'green',
  rejected: 'red',
  unblocked: 'green',
  still_stuck: 'red',
  escalated: 'amber',
  reopened: 'amber',
  assigned_accountant: 'blue',
  accountant_answered: 'green',
  accountant_needs_info: 'amber',
  returned_to_ops: 'amber'
};

export const HOLD_REASON_FRIENDLY = {
  confidence_low: {
    reason: 'We need one more detail to handle this safely.',
    action: 'Confirm what this payment was for so we can sort it correctly.'
  },
  amount_threshold: {
    reason: 'The amount is above the review threshold.',
    action: 'Upload the receipt or invoice for this transaction.'
  },
  new_vendor: {
    reason: 'This vendor is new in your records.',
    action: 'Confirm this vendor is expected so we can continue.'
  },
  possible_duplicate: {
    reason: 'This might be a duplicate transaction.',
    action: 'Confirm which transaction is the right one.'
  },
  missing_document: {
    reason: 'A required document is still missing.',
    action: 'Upload the missing evidence (or a screenshot if export is unavailable).'
  },
  platform_deposit: {
    reason: 'We need to match the platform payout to the bank deposit.',
    action: 'Upload the payout report for the matching date and amount.'
  },
  unusual_pattern: {
    reason: 'This transaction pattern looks unusual.',
    action: 'Confirm the transaction context so we can safely clear the hold.'
  }
};

export const REVIEW_REASONS = [
  { value: 'factually_wrong', label: 'Factually wrong' },
  { value: 'too_vague', label: 'Too vague' },
  { value: 'wrong_escalation', label: 'Wrong escalation' },
  { value: 'wrong_procedure', label: 'Wrong procedure' },
  { value: 'wrong_language', label: 'Wrong language / wording' },
  { value: 'bad_tone', label: 'Bad tone' },
  { value: 'other', label: 'Other' }
];

export const RETURN_TO_OPS_REASONS = [
  { value: 'missing_client_context', label: 'Need intake context' },
  { value: 'missing_document', label: 'Need document first' },
  { value: 'software_access', label: 'Xero access issue' },
  { value: 'not_advisory', label: 'Intake can handle' },
  { value: 'other', label: 'Other' }
];

export const SKILL_TYPE_LABELS = {
  soul: 'Core',
  skill: 'Skill',
  vibe: 'Tone',
  example: 'Example'
};

export const STORAGE_KEYS = {
  queue: 'donna.queue',
  skillsByProfile: 'donna.skills.by_profile',
  history: 'donna.history',
  feedbackLog: 'donna.feedback_log',
  testLibrary: 'donna.test_library',
  batchJob: 'donna.batch_job',
  runModel: 'donna.run_model',
  compareModel: 'donna.compare_model',
  activeProfile: 'donna.active_profile'
};

export const LEGACY_STORAGE_KEYS = {
  skills: 'donna.skills',
  feedbackLog: 'donna_feedback_log',
  testLibrary: 'donna_test_library',
  batchJob: 'donna_batch_job',
  runModel: 'donna_run_model',
  compareModel: 'donna_compare_model'
};
