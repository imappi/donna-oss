// Operator reverse panel (G2 PR-15) — read, render, confirm, execute.
//
// Founder-only surface over the EXISTING /operator/reverse executor: select
// applied actions, read the dry-run plan honestly (all four dispositions, the
// memory/ask legs' reasons, the surfaced side effects a reverse does NOT undo,
// and the verbatim adjustment-journal instruction on posted lines), confirm,
// execute, read the receipt. This panel adds no server surface: the server
// re-plans and re-checks everything at execute time regardless (the dry run is
// a preview, never an authorization), and requireMember + the capability layer
// gate the endpoint, so the panel's own gate is honesty, not security.
//
// Execute-only-on-confirm is structural: the network call with execute: true
// sits behind canExecuteReverse (reversePlanView.js), which only passes from
// an armed confirm phase. The wiring test pins that guard.

import { useCallback, useEffect, useRef, useState } from 'react';
import { T } from './shared/design-tokens.js';
import { formatFirmError, reverseOperatorApplies } from '../lib/firmApi.js';
import {
  LINE_HANGING_WARNING,
  buildReversePlanView,
  buildReverseReceiptView,
  canExecuteReverse,
  initialReverseUiState,
  reverseUiReduce,
  selectedReverseCount
} from '../lib/reversePlanView.js';

const TONE_COLORS = {
  ok: { fg: T.ok, bg: T.okSoft },
  amber: { fg: T.amber, bg: T.amberSoft },
  alert: { fg: T.alert, bg: T.alertSoft },
  muted: { fg: T.muted, bg: T.ruleSoft }
};

const chipStyle = (tone) => ({
  display: 'inline-block',
  padding: '1px 8px',
  borderRadius: 999,
  fontSize: 11.5,
  fontWeight: 600,
  color: (TONE_COLORS[tone] || TONE_COLORS.muted).fg,
  background: (TONE_COLORS[tone] || TONE_COLORS.muted).bg,
  whiteSpace: 'nowrap'
});

const cardStyle = {
  background: T.card,
  border: `1px solid ${T.rule}`,
  borderRadius: 12,
  padding: 16
};

const formatWhen = (value) => {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

const SummaryChips = ({ summary }) => (
  <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
    {summary.reverse > 0 && <span style={chipStyle('ok')}>{summary.reverse} will reverse</span>}
    {summary.stale > 0 && <span style={chipStyle('amber')}>{summary.stale} moved</span>}
    {summary.needs_ledger_adjustment > 0 && (
      <span style={chipStyle('alert')}>{summary.needs_ledger_adjustment} ledger</span>
    )}
    {summary.skip > 0 && <span style={chipStyle('muted')}>{summary.skip} nothing to write</span>}
    {summary.surfaced > 0 && <span style={chipStyle('amber')}>{summary.surfaced} stays taught</span>}
  </span>
);

const EntryRow = ({ entry }) => (
  <div style={{ padding: '8px 0', borderTop: `1px solid ${T.ruleSoft}` }}>
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
      <span style={chipStyle(entry.tone)}>{entry.dispositionLabel}</span>
      <span style={{ fontFamily: T.mono, fontSize: 12, color: T.inkSoft }}>
        {entry.kind ? `${entry.kind} ` : ''}{entry.target}
        {entry.matchId ? ` (match ${entry.matchId})` : ''}
      </span>
    </div>
    {entry.reasonCopy && (
      <div style={{ fontSize: 12.5, color: entry.tone === 'alert' ? T.alert : T.muted, marginTop: 4 }}>
        {entry.reasonCopy}
      </div>
    )}
    {entry.movement && (
      <div style={{ fontFamily: T.mono, fontSize: 12, color: T.muted, marginTop: 2 }}>
        recorded {entry.movement.expected ?? '(none)'} → now {entry.movement.actual ?? '(none)'}
      </div>
    )}
    {entry.instruction && entry.instruction !== entry.reasonCopy && (
      // The verbatim adjustment-journal instruction always renders on a ledger
      // row, whatever reason token the entry carried.
      <div style={{ fontSize: 12.5, color: T.alert, marginTop: 4 }}>{entry.instruction}</div>
    )}
    {entry.surfaced.map((row, index) => (
      <div
        key={`${row.kind}-${index}`}
        style={{ marginTop: 6, padding: '6px 10px', borderRadius: 8, background: T.amberSoft, fontSize: 12.5 }}
      >
        <span style={{ fontWeight: 600, color: T.ink }}>{row.label}.</span>{' '}
        <span style={{ color: T.inkSoft }}>{row.detail}</span>
        {row.kind === 'rule_confirmation_bump' && row.reviewItemId && (
          <span style={{ color: T.muted }}>
            {' '}Bumped by review item <span style={{ fontFamily: T.mono, fontSize: 11.5 }}>{row.reviewItemId}</span>
            {row.priorCount != null && row.confirmationCount != null
              ? ` (${row.priorCount} → ${row.confirmationCount}).`
              : '.'}
          </span>
        )}
        {row.kind === 'rule_cascade_not_unwound' && row.matched != null && (
          <span style={{ color: T.muted }}> {row.matched} row{row.matched === 1 ? '' : 's'} were coded by the cascade.</span>
        )}
      </div>
    ))}
  </div>
);

const buttonStyle = (variant) => ({
  padding: '8px 16px',
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 600,
  fontFamily: T.sans,
  cursor: 'pointer',
  border: variant === 'primary' ? 'none' : `1px solid ${T.rule}`,
  background: variant === 'primary' ? T.ink : T.card,
  color: variant === 'primary' ? T.paper : T.ink
});

const OperatorReversePanel = ({ profile, firmId = null, onDatabaseSnapshot }) => {
  const clientId = profile?.id || null;
  const [ui, setUi] = useState(initialReverseUiState);
  const [planView, setPlanView] = useState(null);
  const [receiptView, setReceiptView] = useState(null);
  // The ask-batch panel's revision guard, not an AbortController: a stale
  // response from a previous client simply loses the race and is dropped.
  const loadRevisionRef = useRef(0);

  const dispatch = useCallback((event) => setUi((state) => reverseUiReduce(state, event)), []);

  const loadPlan = useCallback(async () => {
    if (!clientId) return;
    loadRevisionRef.current += 1;
    const revision = loadRevisionRef.current;
    setUi(initialReverseUiState);
    setReceiptView(null);
    try {
      const response = await reverseOperatorApplies({ clientId, firmId });
      if (loadRevisionRef.current !== revision) return;
      setPlanView(buildReversePlanView(response));
      dispatch({ type: 'plan_loaded' });
    } catch (error) {
      if (loadRevisionRef.current !== revision) return;
      setPlanView(null);
      dispatch({ type: 'plan_failed', message: formatFirmError(error, 'Could not load the reverse plan.') });
    }
  }, [clientId, firmId, dispatch]);

  useEffect(() => { loadPlan(); }, [loadPlan]);

  const executeReverse = useCallback(async () => {
    // Structural guard: execute: true is unreachable outside an armed confirm.
    setUi((state) => {
      if (!canExecuteReverse(state)) return state;
      const selected = state.selected;
      const next = reverseUiReduce(state, { type: 'execute_start' });
      (async () => {
        try {
          const response = await reverseOperatorApplies({ clientId, firmId, proposalIds: selected, execute: true });
          setReceiptView(buildReverseReceiptView(response));
          // The execute response carries the fresh firm snapshot; reconciling it
          // keeps the surrounding workspace honest about what just moved.
          if (response?.snapshot && typeof onDatabaseSnapshot === 'function') {
            onDatabaseSnapshot(response.snapshot);
          }
          setUi((s) => reverseUiReduce(s, { type: 'execute_done' }));
        } catch (error) {
          setUi((s) => reverseUiReduce(s, { type: 'execute_failed', message: formatFirmError(error, 'Reverse failed.') }));
        }
      })();
      return next;
    });
  }, [clientId, firmId, onDatabaseSnapshot]);

  if (!clientId) return null;

  const selectedWriteCount = planView ? selectedReverseCount(planView, ui.selected) : 0;
  const selectedCards = planView ? planView.cards.filter((card) => ui.selected.includes(card.id)) : [];

  return (
    <div style={{ fontFamily: T.sans, color: T.ink, display: 'grid', gap: 14, maxWidth: 860 }}>
      <header>
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Reverse</h2>
        <p style={{ fontSize: 13, color: T.muted, margin: '4px 0 0', lineHeight: 1.5 }}>
          Select applied actions. Donna re-checks every row and reverses only what is still safe.
          Posted lines get a dated adjustment journal instruction. What an apply taught or asked
          is part of the plan, and what a reverse leaves in place is said out loud.
        </p>
      </header>

      {ui.phase === 'loading' && (
        <div style={{ ...cardStyle, color: T.muted, fontSize: 13 }}>Reading the reverse plan…</div>
      )}

      {ui.phase === 'error' && (
        <div style={{ ...cardStyle, borderColor: T.alert }}>
          <div style={{ fontSize: 13, color: T.alert }}>{ui.error}</div>
          <div style={{ marginTop: 10 }}>
            <button type="button" style={buttonStyle('secondary')} onClick={() => loadPlan()}>Retry</button>
          </div>
        </div>
      )}

      {(ui.phase === 'plan' || ui.phase === 'confirm' || ui.phase === 'executing') && planView && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12.5, color: T.muted }}>
              {planView.cards.length} reversible appl{planView.cards.length === 1 ? 'y' : 'ies'}
            </span>
            <SummaryChips summary={planView.summary} />
          </div>

          {planView.cards.length === 0 && (
            <div style={{ ...cardStyle, color: T.muted, fontSize: 13 }}>
              Nothing to reverse. Applies that captured a before state appear here.
            </div>
          )}

          {planView.cards.map((card) => (
            <div key={card.id} style={{ ...cardStyle, opacity: ui.phase !== 'plan' && !ui.selected.includes(card.id) ? 0.55 : 1 }}>
              <label style={{ display: 'flex', alignItems: 'baseline', gap: 10, cursor: card.selectable ? 'pointer' : 'default' }}>
                {card.selectable ? (
                  <input
                    type="checkbox"
                    checked={ui.selected.includes(card.id)}
                    disabled={ui.phase !== 'plan'}
                    onChange={() => dispatch({ type: 'toggle', id: card.id })}
                    style={{ marginTop: 2 }}
                  />
                ) : (
                  <span style={{ width: 13 }} aria-hidden="true" />
                )}
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{card.writerLabel}</span>
                  {card.proposalType && (
                    <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.muted, marginLeft: 8 }}>{card.proposalType}</span>
                  )}
                  {card.createdAt && (
                    <span style={{ fontSize: 12, color: T.muted, marginLeft: 8 }}>{formatWhen(card.createdAt)}</span>
                  )}
                </span>
                <SummaryChips summary={card.summary} />
              </label>
              {!card.selectable && (
                <div style={{ fontSize: 12, color: T.muted, marginTop: 4 }}>Report only. No row on this apply can be written.</div>
              )}
              <div style={{ marginTop: 8 }}>
                {card.entries.map((entry, index) => (
                  <EntryRow key={`${entry.target || 'row'}-${index}`} entry={entry} />
                ))}
              </div>
            </div>
          ))}

          {ui.phase === 'plan' && planView.cards.some((card) => card.selectable) && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 13, color: T.muted }}>
                {ui.selected.length} selected · {selectedWriteCount} row{selectedWriteCount === 1 ? '' : 's'} would write
              </span>
              <button
                type="button"
                style={{ ...buttonStyle('primary'), opacity: selectedWriteCount > 0 ? 1 : 0.4, cursor: selectedWriteCount > 0 ? 'pointer' : 'default' }}
                disabled={selectedWriteCount === 0}
                onClick={() => dispatch({ type: 'request_confirm' })}
              >
                Review reverse
              </button>
            </div>
          )}

          {(ui.phase === 'confirm' || ui.phase === 'executing') && (
            <div style={{ ...cardStyle, borderColor: T.ink }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>
                Reverse {selectedWriteCount} row{selectedWriteCount === 1 ? '' : 's'} across {selectedCards.length} appl{selectedCards.length === 1 ? 'y' : 'ies'}?
              </div>
              <p style={{ fontSize: 12.5, color: T.muted, margin: '6px 0 0', lineHeight: 1.5 }}>
                Only rows marked "Will reverse" are written, each through the same governed writer the
                apply used, receipted in the audit trail. Moved rows, posted lines and surfaced side
                effects are reported, not touched. The server re-checks every row before writing.
              </p>
              {ui.error && <div style={{ fontSize: 12.5, color: T.alert, marginTop: 8 }}>{ui.error}</div>}
              <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
                <button
                  type="button"
                  style={buttonStyle('primary')}
                  disabled={ui.phase === 'executing'}
                  onClick={executeReverse}
                >
                  {ui.phase === 'executing' ? 'Reversing…' : `Reverse ${selectedWriteCount} row${selectedWriteCount === 1 ? '' : 's'}`}
                </button>
                <button
                  type="button"
                  style={buttonStyle('secondary')}
                  disabled={ui.phase === 'executing'}
                  onClick={() => dispatch({ type: 'cancel_confirm' })}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {ui.phase === 'receipt' && receiptView && (
        <div style={cardStyle}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>
            Reversed {receiptView.summary.reversed} row{receiptView.summary.reversed === 1 ? '' : 's'}
            {receiptView.summary.errors > 0 ? `, ${receiptView.summary.errors} failed` : ''}.
          </div>
          {receiptView.hangingCount > 0 && (
            <div style={{ marginTop: 8, padding: '8px 12px', borderRadius: 8, background: T.alertSoft, color: T.alert, fontSize: 12.5 }}>
              {LINE_HANGING_WARNING} ({receiptView.hangingCount} line{receiptView.hangingCount === 1 ? '' : 's'}.)
            </div>
          )}
          <div style={{ marginTop: 6 }}>
            {receiptView.applied.map((row, index) => (
              <div key={`${row.target || 'row'}-${index}`} style={{ padding: '8px 0', borderTop: `1px solid ${T.ruleSoft}` }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  <span style={chipStyle(row.tone)}>{row.statusLabel}</span>
                  <span style={{ fontFamily: T.mono, fontSize: 12, color: T.inkSoft }}>
                    {row.kind ? `${row.kind} ` : ''}{row.target}
                    {row.matchId ? ` (match ${row.matchId})` : ''}
                  </span>
                </div>
                {row.memoryStatusCopy && (
                  <div style={{ fontSize: 12.5, color: T.muted, marginTop: 4 }}>{row.memoryStatusCopy}</div>
                )}
                {row.leavesLineHanging && (
                  <div style={{ fontSize: 12.5, color: T.alert, marginTop: 4 }}>{LINE_HANGING_WARNING}</div>
                )}
                {row.status !== 'reversed' && row.reasonCopy && (
                  <div style={{ fontSize: 12.5, color: row.tone === 'alert' ? T.alert : T.muted, marginTop: 4 }}>{row.reasonCopy}</div>
                )}
              </div>
            ))}
          </div>
          <div style={{ marginTop: 12 }}>
            <button type="button" style={buttonStyle('secondary')} onClick={() => loadPlan()}>Back to the plan</button>
          </div>
        </div>
      )}
    </div>
  );
};

export default OperatorReversePanel;
