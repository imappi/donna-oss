// Shared presentation for the mounted feed and transaction proposal cards.
// Persisted action types, reason codes, writer names and result values remain
// canonical. This boundary localizes only their human-facing explanation and
// isolates every dynamic value according to its semantic direction.

import { useIntl } from 'react-intl';

import { BidiText, FormattedValue, IdentifierText } from '../../i18n/BidiText.jsx';
import { useInterfaceLocale } from '../../i18n/LocaleProvider.jsx';

const REVERSIBILITY_MESSAGE_IDS = Object.freeze({
  reversible: 'operator.action.safety.reversible',
  reversible_with_care: 'operator.action.safety.reversibleWithCare',
  one_way: 'operator.action.safety.oneWay',
  safe_rerun: 'operator.action.safety.safeRerun',
  read_only: 'operator.action.safety.readOnly'
});

const ACTION_EFFECT_MESSAGE_IDS = Object.freeze({
  apply_category: 'operator.action.effect.applyCategory',
  ask_client: 'operator.action.effect.askClient',
  remember_merchant: 'operator.action.effect.rememberMerchant',
  remember_fact: 'operator.action.effect.rememberFact',
  mark_personal: 'operator.action.effect.markPersonal',
  link_document: 'operator.action.effect.linkDocument',
  resolve_match_group: 'operator.action.effect.resolveMatchGroup',
  reject_match: 'operator.action.effect.rejectMatch',
  correct_document_field: 'operator.action.effect.correctDocumentField',
  leave_review_note: 'operator.action.effect.leaveReviewNote',
  mark_evidence_owed: 'operator.action.effect.markEvidenceOwed',
  sync_to_accounting: 'operator.action.effect.syncToAccounting',
  diagnose: 'operator.action.effect.explain',
  retry_parse: 'operator.action.effect.retryParse',
  recode_decided: 'operator.action.effect.recodeDecided',
  future_action: 'operator.action.effect.future'
});

const ACTION_GUARD_MESSAGE_IDS = Object.freeze({
  reject_match: 'operator.action.guard.rejectMatch',
  correct_document_field: 'operator.action.guard.correctDocumentField',
  retry_parse: 'operator.action.guard.retryParse',
  recode_decided: 'operator.action.guard.recodeDecided',
  link_document: 'operator.action.guard.linkDocument',
  resolve_match_group: 'operator.action.guard.resolveMatchGroup'
});

const DETAIL_LABEL_MESSAGE_IDS = Object.freeze({
  Account: 'operator.action.detail.account',
  Tax: 'operator.action.detail.tax',
  Document: 'operator.action.detail.document',
  Scope: 'operator.action.detail.scope',
  Subject: 'operator.action.detail.subject',
  Fact: 'operator.action.detail.fact',
  Confidence: 'operator.action.detail.confidence',
  'Existing fact': 'operator.action.detail.existingFact',
  Applied: 'operator.receipt.applied',
  Failed: 'operator.receipt.status.failed',
  Skipped: 'operator.receipt.status.skipped',
  'Posting failed': 'operator.receipt.postingFailed',
  'Ledger adjustment pending': 'operator.receipt.adjustmentPending',
  'Review item': 'operator.action.detail.reviewItem',
  Posting: 'operator.action.detail.posting',
  'Original journal': 'operator.action.detail.originalJournal',
  Parse: 'operator.action.detail.parse',
  'Parse run': 'operator.action.detail.parseRun',
  Match: 'operator.action.detail.match',
  Was: 'operator.action.detail.was',
  Line: 'operator.action.detail.line',
  Status: 'operator.action.detail.status',
  'Crossed suggestions retired': 'operator.action.detail.crossedSuggestions',
  Request: 'operator.action.detail.request',
  Rule: 'operator.action.detail.rule',
  'Operator words': 'operator.action.detail.operatorWords',
  'Source rows': 'operator.action.detail.sourceRows',
  'Follow-up': 'operator.action.detail.followUp'
});

const FIXED_NOTE_MESSAGE_IDS = Object.freeze({
  'written to firm memory on Apply; dismissable later via governance': 'operator.action.detail.memoryApply',
  'current coding resolved on apply': 'operator.action.detail.currentCodingOnApply',
  'prior value read at apply': 'operator.action.detail.priorValueOnApply',
  'review before Apply': 'operator.action.detail.reviewBeforeApply',
  'ledger reclassed (adjustment posted)': 'operator.receipt.ledgerReclassed'
});

const CHECK_REASON_MESSAGE_IDS = Object.freeze({
  'Declared total doesn’t match the extracted obligations': 'operator.action.finding.declaredTotal',
  'An expected payment has no matching deposit': 'operator.action.finding.missingDeposit',
  'An obligation matches more than one transaction': 'operator.action.finding.ambiguousPayment',
  'There are deposits the agreement doesn’t explain': 'operator.action.finding.unexplainedDeposits',
  'No transactions matched the obligations': 'operator.action.finding.noMatches',
  'Only the totals agree — no per-payment match': 'operator.action.finding.totalOnly',
  'No obligations were extracted to check': 'operator.action.finding.noObligations'
});

const pairIndexFor = (label) => {
  const match = /^Pair (\d+)$/.exec(String(label || ''));
  return match ? Number(match[1]) : null;
};

const labelMessage = (label, message) => {
  const pairIndex = pairIndexFor(label);
  if (pairIndex) return message('operator.action.detail.pair', { index: pairIndex });
  const id = DETAIL_LABEL_MESSAGE_IDS[label];
  return id ? message(id) : null;
};

const isIdentifierLabel = (label) => [
  'Document', 'Scope', 'Tax', 'Confidence', 'Review item', 'Posting', 'Original journal',
  'Parse', 'Parse run', 'Match', 'Was', 'Line', 'Status', 'Request', 'Rule'
].includes(label) || pairIndexFor(label) != null;

const isReceiptIdentifierLabel = (label) => [
  'Document', 'Review item', 'Posting', 'Original journal', 'Parse', 'Parse run',
  'Match', 'Was', 'Line', 'Status', 'Request', 'Rule', 'Fact'
].includes(label) || pairIndexFor(label) != null;

const DynamicValue = ({ value, identifier = false }) => {
  if (identifier) return <IdentifierText>{value}</IdentifierText>;
  return <BidiText direction="auto">{value}</BidiText>;
};

export function MetaChip({ label, color, tone }) {
  return (
    <span
      style={{
        fontFamily: tone.mono,
        fontSize: 9.5,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color,
        border: `1px solid ${color}55`,
        borderRadius: 4,
        padding: '1px 6px'
      }}
    >
      {label}
    </span>
  );
}

const ProposalWarnings = ({ action, meta, tone, message }) => {
  const warnings = [];
  if (action?.type === 'recode_decided') warnings.push({ id: 'operator.action.warning.recodeDecided' });
  if (action?.type === 'reject_match') warnings.push({ id: 'operator.action.effect.rejectMatch' });
  if (action?.type === 'retry_parse') warnings.push({ id: 'operator.action.warning.retryParse' });
  const conflicts = Array.isArray(action?.memory_conflicts) ? action.memory_conflicts : [];
  if (conflicts.length) warnings.push({ id: 'operator.action.warning.factConflict', values: { count: conflicts.length } });
  const omitted = Array.isArray(action?.omitted_matching_transaction_ids)
    ? action.omitted_matching_transaction_ids
    : [];
  if (omitted.length) warnings.push({
    id: 'operator.action.warning.excludedRows',
    values: { count: omitted.length },
    identifiers: omitted.slice(0, 3),
    remaining: Math.max(0, omitted.length - 3)
  });
  if (meta.clientVisible) warnings.push({ id: 'operator.action.warning.oneWay' });
  return warnings.map((warning, index) => (
    <div key={`${warning.id}:${index}`} style={{ fontSize: 11.5, color: tone.warning.color, lineHeight: tone.warning.lineHeight }}>
      <span aria-hidden="true">⚠ </span>{message(warning.id, warning.values)}
      {warning.identifiers?.length > 0 && (
        <> · <IdentifierText>{warning.identifiers.join(', ')}</IdentifierText>{warning.remaining > 0 ? ` +${warning.remaining}` : ''}</>
      )}
    </div>
  ));
};

const ProposalDiffRow = ({ action, row, tone, message }) => {
  const localizedLabel = labelMessage(row.label, message);
  const stateLabel = (state) => state === 'known'
    ? message('operator.action.value.knownNow')
    : message('operator.action.value.proposed');
  const renderSide = (value, state) => {
    if (value == null || value === '') return null;
    const pairIndex = pairIndexFor(row.label);
    if (pairIndex && Array.isArray(action?.match_pairs)) {
      const pair = action.match_pairs[pairIndex - 1];
      if (pair?.transaction_id && pair?.document_id) return (
        <><IdentifierText>{pair.transaction_id}</IdentifierText><span aria-hidden="true"> → </span><IdentifierText>{pair.document_id}</IdentifierText> ({stateLabel(state)})</>
      );
    }
    if (row.label === 'Account' && state === 'proposed' && action?.account_name) return (
      <><BidiText direction="auto">{action.account_name}</BidiText>{action.account_code ? <> (<IdentifierText>{action.account_code}</IdentifierText>)</> : null} ({stateLabel(state)})</>
    );
    const cleared = value === '(cleared)' ? message('operator.action.detail.cleared') : value;
    return <><DynamicValue value={cleared} identifier={isIdentifierLabel(row.label)} /> ({stateLabel(state)})</>;
  };
  const before = renderSide(row.before, row.beforeState);
  const after = renderSide(row.after, row.afterState);
  const fixedNoteId = FIXED_NOTE_MESSAGE_IDS[row.note];
  const currentFact = /^current fact (.+) — supersede or keep$/.exec(String(row.note || ''));
  return (
    <div style={{ fontSize: 11.5, color: tone.diff.color, fontFamily: tone.mono }}>
      {localizedLabel ? <span>{localizedLabel}</span> : <IdentifierText>{row.label}</IdentifierText>}
      <span aria-hidden="true">: </span>
      {before ? <>{before}<span aria-hidden="true"> → </span></> : null}{after}
      {row.note && (
        <span style={{ color: tone.diff.noteColor }}>
          <span aria-hidden="true"> · </span>
          {fixedNoteId
            ? message(fixedNoteId)
            : currentFact
              ? message('operator.action.detail.currentFact', { index: currentFact[1] })
              : <BidiText direction="auto">{row.note}</BidiText>}
        </span>
      )}
    </div>
  );
};

export function ProposalMetaStrip({ action, meta, tone }) {
  const intl = useIntl();
  const message = (id, values = undefined) => intl.formatMessage({ id }, values);
  if (!meta) return null;
  const effectId = action?.type === 'apply_category'
    && String(action?.account_name || '').trim().toLowerCase() === 'suspense'
    ? 'operator.action.effect.suspense'
    : ACTION_EFFECT_MESSAGE_IDS[action?.type];
  const guardId = ACTION_GUARD_MESSAGE_IDS[action?.type];
  const reversibilityId = REVERSIBILITY_MESSAGE_IDS[meta.reversibility];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingBlockStart: 6, borderBlockStart: `1px solid ${tone.border}` }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        <MetaChip label={reversibilityId ? message(reversibilityId) : <IdentifierText>{meta.reversibility}</IdentifierText>} color={tone.chip.reversibility} tone={tone} />
        {meta.guarded && <MetaChip label={message('operator.action.card.guarded')} color={tone.chip.guarded} tone={tone} />}
        {meta.clientVisible && <MetaChip label={message('operator.action.card.clientVisible')} color={tone.chip.clientVisible} tone={tone} />}
      </div>
      {effectId && <div style={{ fontSize: tone.metaLine.size, color: tone.metaLine.color, lineHeight: tone.metaLine.lineHeight, fontFamily: tone.bodyFont }}>{message(effectId)}</div>}
      {guardId && <div style={{ fontSize: tone.metaLine.size, color: tone.metaLine.color, lineHeight: tone.metaLine.lineHeight, fontFamily: tone.bodyFont }}>{message(guardId)}</div>}
      {/* meta.writer (the internal function that would apply this) is kept for
          receipts and tests but never shown: the effect line above already says
          what the change does, in the interface language. */}
      {meta.beforeAfter.map((row, index) => <ProposalDiffRow key={`ba-${index}`} action={action} row={row} tone={tone} message={message} />)}
      <ProposalWarnings action={action} meta={meta} tone={tone} message={message} />
      {meta.checkReport && <CheckReportStrip checkReport={meta.checkReport} tone={tone} />}
    </div>
  );
}

const receiptSummary = (action, message) => {
  const result = action?.result && typeof action.result === 'object' ? action.result : {};
  const count = Number.isFinite(result.applied) ? result.applied : null;
  switch (action?.type) {
    case 'correct_document_field': return message('operator.receipt.documentCorrected');
    case 'retry_parse': return message('operator.receipt.parseRequeued');
    case 'apply_category': return result.posting?.status === 'error' ? message('operator.receipt.codingSavedPostingFailed') : count == null ? message('operator.receipt.codedPosted') : message('operator.receipt.codedPostedCount', { count });
    case 'recode_decided': return message('operator.receipt.recodeDecided');
    case 'reject_match': return message('operator.receipt.matchRejected');
    case 'link_document': return result.match_status === 'confirmed' ? message('operator.receipt.matchConfirmed') : message('operator.receipt.documentLinked');
    case 'resolve_match_group': return message('operator.receipt.groupResolved', { matchCount: Number(result.reconciled_count) || 0, lineCount: Number(result.reconciled_count) || 0 });
    case 'ask_client': return count == null ? message('operator.receipt.questionSent') : message('operator.receipt.questionSentCount', { count });
    case 'remember_merchant': return message(result.rule_id ? 'operator.receipt.ruleSaved' : 'operator.receipt.ruleNotSaved');
    case 'remember_fact': return message(result.already_present ? 'operator.receipt.factUpdated' : (result.fact_id ? 'operator.receipt.factSaved' : 'operator.receipt.factNotSaved'));
    case 'mark_personal': return message('operator.receipt.markedPersonal');
    case 'leave_review_note': return message('operator.receipt.reviewNoteSaved');
    case 'mark_evidence_owed': return count == null ? message('operator.receipt.waitingEvidence') : message('operator.receipt.waitingEvidenceCount', { count });
    case 'sync_to_accounting': return count == null ? message('operator.receipt.postedBooks') : message('operator.receipt.postedBooksCount', { count });
    default: return count == null ? message('operator.receipt.applied') : message('operator.receipt.appliedCount', { count });
  }
};

const ReceiptStatus = ({ action, receipt, color, tone, message }) => {
  const result = action?.result && typeof action.result === 'object' ? action.result : {};
  let labels;
  if (receipt.status === 'partial') {
    const pending = (Array.isArray(result.results) ? result.results : []).some((row) => row?.posting?.step === 'ledger_adjustment_required' && row?.posting?.status === 'pending');
    labels = [message('operator.receipt.status.applied'), message(pending ? 'operator.receipt.adjustmentPending' : 'operator.receipt.status.failed')];
  } else {
    const id = {
      applied: 'operator.receipt.status.applied',
      failed: 'operator.receipt.status.failed',
      skipped: 'operator.receipt.status.skipped'
    }[receipt.status] || 'operator.receipt.status.skipped';
    labels = [message(id)];
  }
  return <MetaChip label={labels.join(' · ')} color={color} tone={tone} />;
};

const ReceiptRow = ({ action, row, tone, message, formatCount, formatDate }) => {
  const localizedLabel = labelMessage(row.label, message);
  const countLabel = ['Applied', 'Failed', 'Skipped', 'Posting failed', 'Ledger adjustment pending', 'Crossed suggestions retired', 'Source rows'].includes(row.label);
  const account = action?.result && typeof action.result === 'object' && row.label === 'Account'
    ? action.result
    : null;
  const renderValue = () => {
    if (countLabel && Number.isFinite(Number(row.value))) {
      return <FormattedValue>{formatCount(Number(row.value))}</FormattedValue>;
    }
    if (row.label === 'Follow-up') {
      try {
        return <FormattedValue>{formatDate(row.value)}</FormattedValue>;
      } catch {
        return <IdentifierText>{row.value}</IdentifierText>;
      }
    }
    if (account?.account_name) return (
      <><BidiText direction="auto">{account.account_name}</BidiText>{account.account_code ? <> (<IdentifierText>{account.account_code}</IdentifierText>)</> : null}</>
    );
    return <DynamicValue value={row.value} identifier={isReceiptIdentifierLabel(row.label)} />;
  };
  return (
    <div style={{ fontSize: 11.5, color: tone.receipt.rowColor, fontFamily: tone.mono }}>
      {localizedLabel ? <span>{localizedLabel}</span> : <IdentifierText>{row.label}</IdentifierText>}
      <span aria-hidden="true">: </span>
      {renderValue()}
    </div>
  );
};

const ReceiptNote = ({ note, tone, message }) => {
  const fixedId = FIXED_NOTE_MESSAGE_IDS[note];
  const was = /^was (.+)$/.exec(String(note || ''));
  const rowNote = /^([^:]+):\s*(.*)$/.exec(String(note || ''));
  return (
    <div style={{ fontSize: 11.5, color: tone.receipt.noteColor }}>
      {fixedId
        ? message(fixedId)
        : was
          ? <>{message('operator.action.detail.was')}: <IdentifierText>{was[1]}</IdentifierText></>
          : rowNote
            ? <><IdentifierText>{rowNote[1]}</IdentifierText>: <BidiText direction="auto">{rowNote[2]}</BidiText></>
            : <BidiText direction="auto">{note}</BidiText>}
    </div>
  );
};

const ReceiptWarnings = ({ action, receipt, tone, message }) => {
  const result = action?.result && typeof action.result === 'object' ? action.result : {};
  const warnings = [];
  const rows = Array.isArray(result.results) ? result.results : [];
  const postingFailed = rows.filter((row) => row?.applied === true && row?.posting?.status === 'error');
  const adjustmentPending = rows.filter((row) => row?.applied === true && row?.posting?.step === 'ledger_adjustment_required' && row?.posting?.status === 'pending');
  if (postingFailed.length) warnings.push({ id: 'operator.receipt.postingFailedBody', values: { count: postingFailed.length } });
  if (adjustmentPending.length) warnings.push({ id: 'operator.receipt.adjustmentPendingBody', values: { count: adjustmentPending.length } });
  if (result.posting?.status === 'error') warnings.push({ id: 'operator.receipt.postingFailed', detail: result.posting.error || 'unknown' });
  if (result.ledger_adjustment_required) warnings.push({ id: 'operator.action.detail.priorPostedState' });
  if (action?.type === 'reject_match' && result.leaves_line_hanging) warnings.push({ id: 'operator.action.warning.wrongLinkRemoved' });
  const fallback = receipt.warnings.slice(warnings.length);
  return (
    <>
      {warnings.map((warning, index) => (
        <div key={`${warning.id}:${index}`} style={{ fontSize: 11.5, color: tone.warning.color, lineHeight: tone.warning.lineHeight }}>
          <span aria-hidden="true">⚠ </span>{message(warning.id, warning.values)}{warning.detail ? <>: <BidiText direction="auto">{warning.detail}</BidiText></> : null}
        </div>
      ))}
      {fallback.map((warning, index) => (
        <div key={`fallback:${index}`} style={{ fontSize: 11.5, color: tone.warning.color, lineHeight: tone.warning.lineHeight }}>
          <span aria-hidden="true">⚠ </span><BidiText direction="auto">{warning}</BidiText>
        </div>
      ))}
    </>
  );
};

export function ApplyReceiptStrip({ action, receipt, tone }) {
  const intl = useIntl();
  const { formatDate } = useInterfaceLocale();
  const message = (id, values = undefined) => intl.formatMessage({ id }, values);
  const formatCount = (value) => intl.formatNumber(value, { maximumFractionDigits: 0 });
  if (!receipt) return null;
  const color = tone.receipt.status[receipt.status] || tone.receipt.status.skipped;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingBlockStart: 6, borderBlockStart: `1px solid ${tone.border}` }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        <ReceiptStatus action={action} receipt={receipt} color={color} tone={tone} message={message} />
        <span style={{ fontSize: tone.receipt.summarySize, color: tone.receipt.summaryColor }}>{receiptSummary(action, message)}</span>
      </div>
      {receipt.rows.map((row, index) => (
        <ReceiptRow key={`r-${index}`} action={action} row={row} tone={tone} message={message} formatCount={formatCount} formatDate={formatDate} />
      ))}
      {receipt.notes.map((note, index) => <ReceiptNote key={`n-${index}`} note={note} tone={tone} message={message} />)}
      <ReceiptWarnings action={action} receipt={receipt} tone={tone} message={message} />
    </div>
  );
}

export function CheckReportStrip({ checkReport, tone }) {
  const intl = useIntl();
  const { formatAmount } = useInterfaceLocale();
  const message = (id, values = undefined) => intl.formatMessage({ id }, values);
  if (!checkReport) return null;
  const { status, currency, summary, totals, counts, notes, warnings } = checkReport;
  const statusId = status === 'pass' ? 'operator.action.card.clear' : 'operator.action.card.requiresReview';
  const statusColor = status === 'pass' ? tone.chip.clientVisible : tone.warning.color;
  const formattedAmount = (value) => value == null
    ? '—'
    : formatAmount(value, { currency: currency || '', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingBlockStart: 6, borderBlockStart: `1px solid ${tone.border}` }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        <MetaChip label={message('operator.action.card.readOnly')} color={tone.chip.guarded} tone={tone} />
        <MetaChip label={message(statusId)} color={statusColor} tone={tone} />
      </div>
      <div style={{ fontSize: tone.metaLine.size, color: tone.metaLine.color, lineHeight: tone.metaLine.lineHeight, fontFamily: tone.bodyFont }}>{message('operator.action.card.readOnlyBody')}</div>
      {summary && <div style={{ fontSize: tone.metaLine.size, color: tone.metaLine.color, fontFamily: tone.bodyFont }}><BidiText direction="auto">{summary}</BidiText></div>}
      <div style={{ fontSize: 11.5, color: tone.metaLine.color, fontFamily: tone.mono }}>
        {message('operator.action.card.matchCounts', {
          matched: intl.formatNumber(counts.matched),
          missing: intl.formatNumber(counts.missing),
          ambiguous: intl.formatNumber(counts.ambiguous),
          unexplained: intl.formatNumber(counts.extra)
        })}
      </div>
      {totals.expected != null && (
        <div style={{ fontSize: 11.5, color: tone.metaLine.color, fontFamily: tone.mono }}>
          {message('operator.action.card.expected', {
            expected: formattedAmount(totals.expected),
            matched: formattedAmount(totals.observed),
            variance: formattedAmount(totals.variance)
          })}
        </div>
      )}
      {notes.map((note, index) => <div key={`cn-${index}`} style={{ fontSize: 11.5, color: tone.diff.noteColor, fontFamily: tone.bodyFont }}>· <BidiText direction="auto">{note}</BidiText></div>)}
      {warnings.map((warning, index) => (
        <div key={`cw-${index}`} style={{ fontSize: 11.5, color: tone.warning.color, lineHeight: tone.warning.lineHeight }}>
          <span aria-hidden="true">⚠ </span>{CHECK_REASON_MESSAGE_IDS[warning]
            ? message(CHECK_REASON_MESSAGE_IDS[warning])
            : <BidiText direction="auto">{warning}</BidiText>}
        </div>
      ))}
    </div>
  );
}
