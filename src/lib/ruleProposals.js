// Reconciliation PR 5 — pure helpers for the "Proposed memory" review
// UI.
//
// Mirrors src/lib/receiptReview.js — every export is a pure function
// that takes plain objects and returns plain objects. No React, no
// DOM, no fetch, no localStorage. The React component in
// src/components/financials/financials-view.jsx imports these and
// renders.
//
// The bucket feeds the new "Proposed memory" section between PR 4's
// "Auto-explained · awaiting review" and the existing "Needs review"
// surface. Each proposed rule renders with a status chip, a
// classifier-style hint, and Commit / Discard actions. Both actions
// route through PATCH /client-rules/{id} so the writer can audit and
// enforce prior-state guards.

const SYSTEM_LEARNED_SOURCE = 'system_learned';
const PROPOSAL_STATUS = 'proposed';

const STATUS_CHIP_LABEL = Object.freeze({
  proposed: 'Proposed memory',
  active: 'Active memory',
  retired: 'Retired memory'
});

// PII contract — proposals must never surface raw vendor names,
// transaction descriptions, or reference numbers in human-facing copy
// or telemetry. Canonical pattern (the normalized form) is OK.
const PII_FIELDS = Object.freeze([
  'vendor_name',
  'merchant_display_name',
  'reference_number',
  'description',
  'raw_description',
  'contact'
]);

const safeArray = (value) => (Array.isArray(value) ? value : []);
// Strict: only the `created_by` column qualifies a rule as system-learned.
// payload.source is metadata; firm-typed rules sometimes carry it too.
const isSystemLearned = (rule) =>
  !!rule && rule.created_by === SYSTEM_LEARNED_SOURCE;

const ruleStatus = (rule) => {
  const s = rule?.status;
  if (s === 'proposed' || s === 'active' || s === 'retired') return s;
  return null;
};

const titleCaseExpenseKind = (kind = '') =>
  String(kind)
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

const confidenceBandFor = (avg) => {
  const n = Number(avg);
  if (!Number.isFinite(n)) return 'low';
  if (n >= 0.85) return 'high';
  if (n >= 0.7) return 'medium';
  return 'low';
};

export const proposedRuleSummary = (rule) => {
  if (!rule) return null;
  const payload = (rule.payload && typeof rule.payload === 'object') ? rule.payload : {};
  const canonical = String(rule.pattern_text || payload.merchant_pattern || '').trim();
  if (!canonical) return null;
  const expenseKind = String(payload.expense_kind || '').trim();
  const accountCode = String(rule.account_code || payload.account_code || '').trim();
  const observationCount = Number(payload.observation_count || 0);
  const confidenceAvg = Number(payload.confidence_avg);
  return {
    pattern_display: canonical,
    kind_display: expenseKind ? titleCaseExpenseKind(expenseKind) : '',
    account_code: accountCode,
    confidence_band: confidenceBandFor(confidenceAvg),
    observation_count: Number.isFinite(observationCount) ? observationCount : 0,
    last_observed_at: payload.last_observed_at || null,
    window_days: Number(payload.observation_window_days) || null
  };
};

export const allowedRuleActionsFor = (rule) => {
  const status = ruleStatus(rule);
  if (status === PROPOSAL_STATUS) return ['commit', 'discard'];
  return [];
};

export const buildRulePatchForAction = ({ action, rule } = {}) => {
  if (!rule) return null;
  if (action === 'commit') return { status: 'active' };
  if (action === 'discard') return { status: 'retired' };
  return null;
};

// Q9 — both Commit and Discard prompt for confirmation. Commit is
// semi-destructive (subsequent transactions auto-code without further
// firm review until the firm retires the rule); Discard removes the
// proposal. Native window.confirm() with explicit copy at the call
// site.
export const requiresRuleConfirmPrompt = (action) => action === 'commit' || action === 'discard';

export const ruleChipLabel = (rule) => STATUS_CHIP_LABEL[ruleStatus(rule)] || STATUS_CHIP_LABEL.proposed;

export const formatRuleChip = (summary) => {
  if (!summary) return '';
  const kind = summary.kind_display || 'Memory';
  const count = summary.observation_count || 0;
  return `${kind} · ${count} firm confirmation${count === 1 ? '' : 's'}`;
};

export const buildProposedRuleRow = ({ rule }) => {
  if (!rule || !isSystemLearned(rule)) return null;
  if (ruleStatus(rule) !== PROPOSAL_STATUS) return null;
  const summary = proposedRuleSummary(rule);
  if (!summary) return null;
  return {
    id: rule.id,
    rule,
    summary,
    chip: PROPOSAL_STATUS,
    chipLabel: ruleChipLabel(rule),
    allowedActions: allowedRuleActionsFor(rule)
  };
};

const compareByLastObserved = (left, right) => {
  const leftKey = String(left?.summary?.last_observed_at || left?.rule?.updated_at || '');
  const rightKey = String(right?.summary?.last_observed_at || right?.rule?.updated_at || '');
  if (leftKey !== rightKey) return rightKey.localeCompare(leftKey);
  return String(left?.id || '').localeCompare(String(right?.id || ''));
};

export const buildProposedRuleRows = ({ clientRules = [] } = {}) => {
  const rows = [];
  for (const rule of clientRules) {
    const row = buildProposedRuleRow({ rule });
    if (row) rows.push(row);
  }
  rows.sort(compareByLastObserved);
  return rows;
};

// Telemetry payload shape. Pure helper — JSX caller is free to fire
// it or not. v1 ships WITHOUT a sink (same as PR 4); the JSX call
// site carries a TODO marker. The contract this helper enforces — no
// PII, enum/numeric metadata only — is what tests pin.
export const buildRuleTelemetry = ({ action, rule } = {}) => {
  const summary = proposedRuleSummary(rule);
  return {
    event: 'rule_proposal.action_clicked',
    action: action || null,
    prev_status: ruleStatus(rule) || null,
    next_status: buildRulePatchForAction({ action, rule })?.status || null,
    has_classifier_metadata: !!summary,
    confidence_band: summary ? summary.confidence_band : null,
    observation_count: summary ? summary.observation_count : null
  };
};

export const ruleTelemetryHasPii = (payload) => {
  if (!payload || typeof payload !== 'object') return false;
  return PII_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(payload, field));
};
