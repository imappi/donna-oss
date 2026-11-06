import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { firmFetch, coerceErrorMessage } from '../lib/firmApi.js';
import { D } from './shared/design-tokens.js';

const outcomeLabels = {
  resolve: 'Jev would allocate this payment',
  ask_owner: 'Jev would ask the owner',
  no_settlement: 'Jev would select none of these payments',
  needs_more_work: 'This case needs more work',
  abstain: 'Jev could not choose a supported plan'
};
const words = (value) => String(value || '').replaceAll('_', ' ');
const supportedTypes = new Set(['sales_invoice', 'supplier_bill', 'receipt', 'issued_receipt']);
const previewErrors = {
  jev_invalid_response: 'Jev returned an unreadable answer. No decision was applied. You can try again.',
  jev_request_too_large: 'This document has too much evidence for the current preview. No model call was made. Try another document.',
  no_eligible_payments: 'No available bank payments were found for this preview. Upload a bank statement, wait until it finishes reading, then try again.'
};
const automaticReasons = {
  jev_abstain: 'Jev could not finish this case with the available actions.',
  jev_no_settlement: 'Jev found no settlement among the payments it considered.',
  jev_unsupported_complete_plan: 'The selected treatment needs an accounting action that is not yet supported.',
  jev_unsupported_amount_plan: 'The selected treatment needs a different amount or currency treatment.',
  jev_validator_refused: 'The selected payment did not pass the accounting checks.',
  jev_evidence_changed_before_write: 'The evidence changed before the payment could be matched.',
  jev_writer_did_not_auto_reconcile: 'The accounting update did not complete. The case remains unfinished.',
  jev_match_held_for_authority: 'This payment match needs the owner\'s confirmation before it is posted.',
  jev_runtime_failed: 'The automatic attempt failed. The case remains unfinished.',
  jev_source_incomplete: 'The document has no issue or due date, or no currency, so it cannot be matched yet.',
  already_settled: 'This document is already fully settled.'
};

export const supportsJevPreview = (document) => supportedTypes.has(document?.document_type)
  && document?.parse_status === 'completed' && Number(document?.total_amount) > 0;

// The result is deliberately independent of the feed's reconciliation state:
// a selected plan and a refused plan must both remain visible in this trial.
export default function JevPreview({ document }) {
  const intl = useIntl();
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const [automatic, setAutomatic] = useState(null);
  const [statusError, setStatusError] = useState(false);
  const active = useRef(null);
  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ client_id: document.client_id, document_id: document.id });
    setAutomatic(null);
    setStatusError(false);
    firmFetch(`/api/donna/firms/jev-preview?${params}`, { signal: controller.signal, headers: { Accept: 'application/json' } })
      .then(async (response) => {
        if (!response.ok) throw new Error('status_unavailable');
        const body = await response.json();
        if (!controller.signal.aborted) setAutomatic(body);
      })
      .catch(() => { if (!controller.signal.aborted) setStatusError(true); });
    return () => controller.abort();
  }, [document.client_id, document.id, document.payment_status]);

  const money = (minor, currency = document.currency) => {
    const value = Number(minor) / 100;
    if (!Number.isFinite(value)) return 'Amount unavailable';
    try { return intl.formatNumber(value, { style: 'currency', currency }); }
    catch { return `${intl.formatNumber(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency || ''}`; }
  };

  const run = async () => {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setRunning(true);
    setError('');
    setResult(null);
    try {
      const response = await firmFetch('/api/donna/firms/jev-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ client_id: document.client_id, document_id: document.id }),
        signal: controller.signal
      });
      const body = await response.json();
      if (!response.ok) throw new Error(previewErrors[body.code] || previewErrors[body.error]
        || coerceErrorMessage(body.error, 'Jev could not run. Please try again.'));
      if (!controller.signal.aborted) setResult(body);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure.message || 'Jev could not run. Please try again.');
    } finally {
      if (!controller.signal.aborted) {
        active.current = null;
        setRunning(false);
      }
    }
  };

  const plan = result?.selected_plan;
  const candidates = new Map((result?.candidates || []).map((candidate) => [candidate.id, candidate]));
  const candidateLabel = (item) => {
    const candidate = candidates.get(item.transaction_id);
    return candidate
      ? [candidate.description || 'Bank payment', candidate.date].filter(Boolean).join(' · ')
      : item.candidate || 'Bank payment';
  };
  const limits = result?.limits || {};
  const hasLimits = result && (result.menu?.truncated
    || limits.transactions_capped || limits.documents_capped || limits.unparsed_documents > 0
    || limits.clipped_sources?.length > 0);
  const rowStyle = { margin: '6px 0' };
  const lastRun = automatic?.last_run;

  return (
    <section aria-label="Jev preview" style={{ padding: '14px 18px', borderBottom: `1px solid ${D.ruleSoft}`, color: D.ink, fontSize: 13, flexShrink: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <strong>Jev matching</strong>
          <div style={{ color: D.inkSoft, fontSize: 12, marginTop: 3 }}>
            {automatic?.enabled === true ? 'Automatic Jev matching is enabled'
              : automatic?.enabled === false ? 'Automatic Jev matching is not enabled'
                : statusError ? 'Automatic matching status is unavailable' : 'Checking automatic matching…'}
          </div>
        </div>
        <button type="button" onClick={run} disabled={running} style={{ padding: '7px 12px', border: `1px solid ${D.rule}`, borderRadius: 7, background: D.card, color: D.ink, font: 'inherit', cursor: running ? 'wait' : 'pointer', opacity: running ? 0.6 : 1 }}>
          {running ? 'Jev is reading…' : result ? 'Try again' : 'Try Jev'}
        </button>
      </div>
      <p style={{ ...rowStyle, color: D.inkMute, fontSize: 12 }}>Jev decides first on payment matching, bank-line treatment, and account and tax coding. It asks for missing owner facts or requests further reasoning when it cannot finish. Unsupported accounting actions remain visible as unfinished work.</p>
      {lastRun ? <div style={{ margin: '10px 0', padding: '8px 10px', background: D.paperDeep, borderRadius: 6 }}>
        <strong style={{ fontSize: 12 }}>Last automatic attempt</strong>
        <div style={{ marginTop: 4 }}>{lastRun.execution === 'applied' ? 'Payment matched automatically'
          : lastRun.execution === 'held' ? 'Payment match waiting for owner confirmation'
          : lastRun.execution === 'not_applied' ? 'No change applied' : words(lastRun.execution || lastRun.outcome || 'Recorded')}</div>
        {lastRun.reason && <div style={{ color: D.inkSoft, marginTop: 3 }}>{automaticReasons[lastRun.reason] || words(lastRun.reason)}</div>}
        {Number.isFinite(lastRun.probability) && <div style={{ color: D.inkMute, fontSize: 12, marginTop: 3 }}>{intl.formatNumber(lastRun.probability, { style: 'percent', maximumFractionDigits: 0 })} choice confidence</div>}
        {lastRun.model && <details style={{ color: D.inkMute, fontSize: 12, marginTop: 5 }}><summary style={{ cursor: 'pointer' }}>Decision details</summary><div>Model: {lastRun.model}</div>{lastRun.outcome && <div>Decision: {words(lastRun.outcome)}</div>}</details>}
      </div> : automatic?.enabled === true && <p style={{ ...rowStyle, color: D.inkMute, fontSize: 12 }}>No automatic decision has been recorded for this document yet.</p>}
      <p style={{ ...rowStyle, color: D.inkMute, fontSize: 12 }}>Try Jev runs a preview of the same decision. Preview — books unchanged.</p>
      <div aria-live="polite" aria-busy={running}>
        {error && <p role="alert" style={{ color: D.alert, marginBottom: 0 }}>{error}</p>}
        {result && <div style={{ marginTop: 14 }}>
          <strong>{outcomeLabels[result.outcome] || 'Jev returned a decision'}</strong>
          <div style={{ color: D.inkMute, fontSize: 12, marginTop: 4 }}>
            {Number.isFinite(result.latency_ms) && `${intl.formatNumber(result.latency_ms / 1000, { maximumFractionDigits: 2 })} seconds`}
            {Number.isFinite(result.probability) && ` · ${intl.formatNumber(result.probability, { style: 'percent', maximumFractionDigits: 0 })} choice confidence`}
          </div>
          {(plan?.allocations || []).map((allocation, index) => <div key={index} style={{ marginTop: 10 }}>
            <div>{money(allocation.amount_minor, allocation.currency)} from {candidateLabel(allocation)}</div>
            {allocation.fee_minor > 0 && <div style={{ color: D.inkSoft }}>Fee: {money(allocation.fee_minor, allocation.basis === 'source_grounded_fee' ? allocation.currency : allocation.bank_currency)}</div>}
            {allocation.surplus_minor > 0 && <div style={{ color: D.inkSoft }}>Surplus: {money(allocation.surplus_minor, allocation.currency)} · {words(plan.surplus_disposition)}</div>}
          </div>)}
          {(plan?.exclusions || []).filter((item) => item.reason === 'duplicate_payment' && item.surplus_minor > 0).map((item, index) => <p key={`surplus-${index}`} style={rowStyle}>Duplicate payment: {money(item.surplus_minor)} · {candidateLabel(item)}. Remaining work: refund or credit.</p>)}
          {plan && Number.isFinite(plan.retained_balance_minor) && <p style={rowStyle}>{plan.allocations?.length ? 'Unpaid balance after this plan' : 'Unpaid balance'}: {money(plan.retained_balance_minor)}</p>}
          {(plan?.requests || []).map((request, index) => <p key={index} style={rowStyle}>Ask for {request.missing === 'payment_specific_source' ? 'evidence explaining this payment' : words(request.missing || 'payment evidence')} · {candidateLabel(request)}</p>)}
          {plan?.fact_request && <p style={rowStyle}>Ask the owner for the missing fact.</p>}
          {(result.outcome === 'abstain' || result.outcome === 'needs_more_work') && <p style={rowStyle}>The full-payment choices cannot finish this case. No owner request was made.</p>}
          <p style={{ ...rowStyle, color: result.accepted ? D.inkSoft : D.alert }}>
            {result.accepted ? 'Mechanical checks passed. Nothing has been applied.' : 'Mechanical checks did not accept this decision. Nothing has been applied.'}
          </p>
          {hasLimits && <p style={{ ...rowStyle, color: D.alert }}>This preview has limited coverage. See details before judging the result.</p>}
          <details style={{ marginTop: 10 }}>
            <summary style={{ cursor: 'pointer', color: D.inkSoft }}>Evidence and checks</summary>
            <p style={rowStyle}>Jev reads the extracted records provided here, not the original PDFs. The search is bounded, so it cannot prove that a document is absent from the whole book. This decision does not return individual source citations.</p>
            {(result.evidence || []).length > 0 && <div style={{ marginTop: 8 }}><strong>Evidence provided</strong><ul style={{ paddingInlineStart: 18 }}>{result.evidence.map((source, index) => <li key={source.id || index}>{source.label || words(source.kind) || 'Source'}{source.cited ? <strong> · Cited by Jev</strong> : null}</li>)}</ul></div>}
            {(plan?.exclusions || []).length > 0 && <div><strong>Other payments</strong><ul style={{ paddingInlineStart: 18 }}>{plan.exclusions.map((item, index) => <li key={index}>{candidateLabel(item)} · {words(item.reason)}</li>)}</ul></div>}
            {(result.refusals || []).length > 0 && <ul style={{ paddingInlineStart: 18 }}>{result.refusals.map((refusal, index) => <li key={index}>{refusal.message || words(refusal.code || refusal)}</li>)}</ul>}
            {hasLimits && <div><strong>Coverage limits</strong><ul style={{ paddingInlineStart: 18 }}>
              {result.menu?.truncated && <li>Some possible plans were omitted to keep the choice manageable.</li>}
              {limits.transactions_capped && <li>Some bank payments were outside the search limit.</li>}
              {limits.documents_capped && <li>Some documents were outside the search limit.</li>}
              {limits.unparsed_documents > 0 && <li>{limits.unparsed_documents} documents are not yet fully read.</li>}
              {limits.clipped_sources?.length > 0 && <li>{limits.clipped_sources.length} source records were shortened.</li>}
            </ul></div>}
            {limits.document_type_mapping && <p style={rowStyle}>Receipt evaluated using {words(limits.document_type_mapping)}.</p>}
          </details>
        </div>}
      </div>
    </section>
  );
}
