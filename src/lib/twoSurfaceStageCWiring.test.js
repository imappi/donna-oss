// Two-surface IA stage C wiring pins (docs/design-donna-two-surface-ia.md §7,
// Kari's picks 2026-08-26: TB/P&L/cash live in Donna chat → the artifact
// rail; closed periods are grouped and visually marked in the Reconciled
// list itself).
//
// C1 — the open_financials chat verb's FE half: the label, the Open button,
// the opener threaded dock → chat, and the artifact that renders the
// PERSISTED close-preview read-model (never figures from the model). The
// server half (enum/schema/prompt/sanitize) is pinned in feedChat.test.js.
// C2a — the month grouping is UNCONDITIONAL (graduated 2026-08-27 — the
// TWO_SURFACE_CLOSE_FOLD flag and the Close tab code are deleted), and
// the Locked badge reads the persisted close_periods status.
// C2b — the close-event rows: the console derives the list from the PERSISTED
// snapshot (close_periods verdict payloads), and the work artifact reads the persisted
// close-preview read-model + existing close writers only. Lock resolves
// the card (a locked row never derives an entry).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

const consoleSource = read('../components/FirmOpsConsole.jsx');
const dockSource = read('../components/firm-dock.jsx');
const chatSource = read('../components/financials/feed-chat.jsx');
const panelSource = read('../components/financials/donna-financials-panel.jsx');
const artifactPanelSource = read('../components/financials/artifact-panel.jsx');
const reportSource = read('../components/financials/financials-report-artifact.jsx');
const statementSource = read('../components/donna-client-reports.jsx');
const workspaceSource = read('../components/financials/financial-report-workspace.jsx');
const remainingCatalogSource = read('../i18n/catalogs/remainingSurfaces.en.js');

test('C1: the open_financials opener is threaded console → dock → chat, and the card renders Open', () => {
  assert.match(consoleSource, /const openFinancialsFromChat = useCallback/);
  assert.match(consoleSource, /onOpenFinancials=\{openFinancialsFromChat\}/);
  assert.match(dockSource, /onOpenFinancials=\{onOpenFinancials\}/);
  assert.match(chatSource, /OPERATOR_ACTION_TYPE_MESSAGE_IDS\[action\.type\]/);
  assert.match(remainingCatalogSource, /open_financials: 'operator\.action\.type\.openFinancials'/);
  assert.match(remainingCatalogSource, /'operator\.action\.type\.openFinancials': 'Open financials'/);
  assert.match(chatSource, /const canOpenFinancials = !!financialTarget/);
  assert.match(chatSource, /action\.financial_summary\?\.available !== false/);
  assert.match(chatSource, /onOpenFinancials\(financialTarget\)/);
  assert.match(consoleSource, /const clientId = target\?\.clientId \|\| selectedClient\?\.id;/);
});

test('C1: the legacy compact artifact remains ledger-backed while Donna opens the shared full statement view', () => {
  assert.match(artifactPanelSource, /visible\.type === 'financials' && visible\.data && \(/);
  assert.match(artifactPanelSource, /<FinancialsReportArtifact artifact=\{visible\} onRefreshRef=\{refreshRef\} \/>/);
  assert.match(reportSource, /fetchClosePeriodPreview/);
  // Render-the-persisted-verdict: the artifact's ONLY data import is the
  // close-preview read fetch — no chat/inference module reaches it.
  const imports = reportSource.match(/^import .*$/gm) || [];
  assert.deepEqual(
    imports.filter((line) => /firmApi/.test(line)),
    ["import { fetchClosePeriodPreview } from '../../lib/firmApi.js';"]
  );
  assert.match(reportSource, /trial_balance|profit_and_loss/);
  assert.match(consoleSource, /<FinancialReportWorkspace/);
  assert.match(workspaceSource, /<ClientReports/);
  assert.match(workspaceSource, /showSupportingStatements/);
  assert.match(statementSource, /report\.download\.pdf/);
  assert.match(statementSource, /report\.download\.csv/);
  assert.match(statementSource, /report\.section\.cash/);
  assert.match(statementSource, /report\.section\.trialBalance/);
});

test('C2a: period grouping is unconditional — no flag, prop, or env gate survives', () => {
  assert.doesNotMatch(panelSource, /ui_flags|closeTabFolded|monthGrouping/);
  assert.doesNotMatch(panelSource, /(import\.meta\.env|process\.env)\.\w*TWO_SURFACE/);
  assert.match(panelSource, /buildPeriodOverview\(\{/);
  assert.match(panelSource, /<PeriodHeader/);
  assert.match(panelSource, /periodSummaryLabel\(period, intl\.formatMessage\)/);
});

const closeRowsSource = read('../components/financials/close-action-rows.jsx');
const closePeriodArtifactSource = read('../components/financials/close-period-artifact.jsx');
const inventorySource = read('../components/shared/close-action-inventory.js');

test('C2b: standalone close rows are retired from the mounted overview', () => {
  assert.doesNotMatch(consoleSource, /CloseActionRows|deriveCloseActionPeriods|closeActionPeriods/);
  assert.match(panelSource, /closePeriods=\{closePeriods\}/);
  assert.match(panelSource, /openPeriodClose/);
  assert.match(panelSource, /type: 'close_period'/);
  assert.match(panelSource, /type: 'close_receipt'/);
});

test('C2b: a persisted close verdict rides on its month instead of becoming another list item', () => {
  assert.match(panelSource, /period\.closePeriod/);
  assert.match(panelSource, /id: period\.closed \? 'lifecycle\.closed' : 'lifecycle\.open'/);
  assert.match(panelSource, /period\.closeStatus === 'ready'[\s\S]*?'lifecycle\.close\.readyToLock'[\s\S]*?'lifecycle\.close\.details'/);
  assert.doesNotMatch(consoleSource, /closeActionForYouCount|entityOwnerCounts/);
});

test('C2b: the close doorway stays a native button; the month label carries no toggle', () => {
  // Single-list amendment (Kari, 2026-08-31): the month is a boundary
  // label, not a container — nothing collapses, so the header has no
  // disclosure button, but the close-event doorway remains a real button.
  assert.match(panelSource, /onClick=\{onOpenClose\}/);
  assert.doesNotMatch(panelSource, /onClick=\{onToggle\}/);
  assert.doesNotMatch(panelSource, /aria-expanded=\{expanded\}/);
  assert.doesNotMatch(panelSource, /data-period-disclosure/);
  assert.match(artifactPanelSource, /visible\.type === 'close_period' && visible\.data && \(/);
  assert.match(artifactPanelSource, /<ClosePeriodArtifact artifact=\{visible\} onRefreshRef=\{refreshRef\} \/>/);
});

test('single list: months are sticky boundary labels over one date-sorted stream, states are pills', () => {
  // Kari, 2026-08-31 ("a single list can do it all with states"): no
  // collapsed rectangles, no per-month lanes, no expansion state — one
  // stream per month boundary. Amended 2026-09-01: the state-filter chip
  // strip is gone too (noise; the month header's counts carry the summary),
  // and the trailing pill renders the row's STATE off the persisted
  // convergence verdict via the one classifier (streamEntryState) — a
  // hanging row reads Stalled, never a laundered Processing and never a
  // category costume.
  assert.doesNotMatch(panelSource, /data-period-view/);
  assert.doesNotMatch(panelSource, /expandedPeriodKeys|togglePeriod|PeriodLaneHeading/);
  assert.match(panelSource, /position: 'sticky',\s*\n\s*insetBlockStart: 0/);
  assert.match(panelSource, /\{stream\.map\(\(entry\) => \{/);
  assert.doesNotMatch(panelSource, /STREAM_FILTER_LANES|streamFilter|streamTotals/);
  assert.doesNotMatch(panelSource, /lifecycle\.filter\./);
  assert.match(panelSource, /streamEntryState\(lane, row\)/);
  assert.match(panelSource, /streamEntryState\('open', tx\)/);
  assert.match(panelSource, /streamEntryState\('document', row\)/);
  assert.match(panelSource, /stalled: \{ labelId: 'lifecycle\.stalled', voice: 'alert' \}/);
});

test('C2b: the work artifact reads the persisted close read-model and mutates through the existing close writers only', () => {
  const firmApiNames = [
    'acceptClientEvidenceRequest',
    'fetchClosePeriodPreview',
    'formatFirmError',
    'lockClosePeriod',
    'postLedgerPeriod',
    'rejectClientEvidenceRequest',
    'runCloseChecks'
  ];
  for (const name of firmApiNames) {
    assert.match(closePeriodArtifactSource, new RegExp(`  ${name},?\\n`));
  }
  assert.doesNotMatch(closePeriodArtifactSource, /feed-chat|feedChat|donnaChat/);
  assert.doesNotMatch(closePeriodArtifactSource, /(import\.meta\.env|process\.env)/);
  // The not-lockable 409 renders the blocking checks verdict, not a generic
  // failure line — and checks dedupe by check_type (the doubled-list bug
  // from the first canary pass: the read-model returns the live summary
  // alongside the persisted row).
  assert.match(closePeriodArtifactSource, /CLOSE_PERIOD_NOT_LOCKABLE/);
  assert.match(closePeriodArtifactSource, /const dedupeChecks = /);
});

test('C2c: the Close tab is gone for good; stale main-tab values land on the overview', () => {
  assert.doesNotMatch(consoleSource, /\{ key: 'close', label: 'Close' \}/);
  assert.doesNotMatch(consoleSource, /donna-close-panel/);
  assert.match(consoleSource, /const entityTab = ENTITY_MENU_TABS\.some/);
  assert.match(consoleSource, /: 'overview';/);
});

test('C2a: reconciled months are newest-first and collapsed until opened', () => {
  assert.match(panelSource, /return \[\.\.\.reconciledRows\]\.sort\(\(a, b\) => ts\(b\) - ts\(a\)\);/);
  assert.match(panelSource, /const \[expandedMonths, setExpandedMonths\] = useState\(\(\) => new Set\(\)\);/);
  assert.match(panelSource, /aria-expanded=\{monthExpanded\}/);
  assert.match(panelSource, /onClick=\{\(\) => toggleMonth\(monthKey\)\}/);
  assert.match(panelSource, /\{monthExpanded && <div/);
});

test('C2c: the Locked badge opens the close receipt artifact, mounted in the rail', () => {
  assert.match(panelSource, /const openCloseReceipt = \(monthKey, monthLabel\) => \{/);
  assert.match(panelSource, /type: 'close_receipt'/);
  assert.match(panelSource, /onClick=\{\(\) => openCloseReceipt\(monthKey, monthLabel\)\}/);
  // The opener captures PERSISTED snapshot rows only — the close_periods row,
  // the matching close_archives row, and the period's ledger_journals.
  assert.match(panelSource, /closePeriod: period,/);
  assert.match(panelSource, /archiveRecord,/);
  assert.match(panelSource, /periodJournals/);
  assert.match(artifactPanelSource, /visible\.type === 'close_receipt' && visible\.data && \(/);
  assert.match(artifactPanelSource, /<CloseReceiptArtifact artifact=\{visible\} onRefreshRef=\{refreshRef\} \/>/);
});

test('C2c: the receipt artifact renders persisted rows and touches only the archive read/generate/export writers', () => {
  const receiptSource = read('../components/financials/close-receipt-artifact.jsx');
  for (const name of ['createCloseArchive', 'fetchCloseArchiveExport', 'fetchCloseArchivePreview', 'formatFirmError']) {
    assert.match(receiptSource, new RegExp(`  ${name},?\\n`));
  }
  // Locked-at and the statutory voucher numbers render the persisted rows.
  assert.match(receiptSource, /closePeriod\?\.locked_at/);
  assert.match(receiptSource, /buildTositeIndex/);
  assert.doesNotMatch(receiptSource, /(import\.meta\.env|process\.env)/);
  assert.doesNotMatch(receiptSource, /feed-chat|feedChat|donnaChat/);
});

// ── Stage-C finish pass (Kari's 2026-08-26 canary walkthrough findings) ──

test('finish 1: the Period close rows keep the shared 1080 list measure of their sibling sections', () => {
  assert.match(closeRowsSource, /maxWidth: BANK_FEED_LIST_MEASURE, margin: '0 auto'/);
});

test('finish 2: the dock chat stacks beneath every artifact type without its own item chat', () => {
  // One work surface (Kari's standing UI rail): document/transaction carry
  // their own item-scoped chat; every other artifact type gets the dock
  // stacked beneath it — never a separate chat-less panel.
  assert.match(artifactPanelSource, /export const ARTIFACT_TYPES_WITH_OWN_CHAT = new Set\(\['document', 'transaction'\]\);/);
  assert.match(artifactPanelSource, /const showDock = dockOpen && !!dock\n\s*&& \(!artifact \|\| !ARTIFACT_TYPES_WITH_OWN_CHAT\.has\(artifact\.type\)\);/);
});

test('finish 3: every month-key/day consumer of snapshot date columns routes through snapshot-dates', () => {
  // The January-in-December TZ class: pg date columns serialize as
  // local-midnight UTC instants on a non-UTC host; raw regex/slice
  // consumers group the row under the WRONG month.
  assert.match(inventorySource, /from '\.\/snapshot-dates\.js'/);
  assert.doesNotMatch(inventorySource, /MONTH_KEY_RE/);
  assert.match(panelSource, /from '\.\.\/shared\/snapshot-dates\.js'/);
  assert.match(panelSource, /const key = snapshotMonthKey\(p\.period_start\);/);
  assert.match(panelSource, /const start = snapshotDayString\(period\.period_start\);/);
  // The work artifact normalizes at entry, so the close writers can never
  // receive a shifted day (the second-December mint vector), and the
  // header humanizes the range instead of echoing raw ISO instants.
  assert.match(closePeriodArtifactSource, /snapshotDayString\(data\.periodStart\)/);
  assert.match(closePeriodArtifactSource, /\{dayRangeLabel\(periodStart, periodEnd\)\}/);
  const receiptSource = read('../components/financials/close-receipt-artifact.jsx');
  assert.match(receiptSource, /\{dayRangeLabel\(periodStart, periodEnd\)\}/);
});

test('finish 3: the snapshot normalizes close/transaction/journal date columns at the source', () => {
  // RT-17: firmDb.js is decomposed plane by plane into server/donna/db/<plane>.js
  // (the hub re-exports every public symbol). The DTO builders pinned here live
  // in whichever file their plane has reached, so read the whole surface: every
  // plane file (sorted) followed by the hub.
  const firmDbSource = [
    ...readdirSync(new URL('../../server/donna/db/', import.meta.url))
      .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
      .sort()
      .map((f) => read(`../../server/donna/db/${f}`)),
    read('../../server/donna/firmDb.js')
  ].join('\n');
  assert.match(firmDbSource, /closePeriods: closePeriodsResult\.rows\.map\(rowToClosePeriodPayload\),/);
  assert.match(firmDbSource, /const rowToClosePeriodPayload = \(row = \{\}\) => \(\{\n  \.\.\.row,\n  period_start: row\.period_start \? toIsoDay\(row\.period_start\) : null,\n  period_end: row\.period_end \? toIsoDay\(row\.period_end\) : null\n\}\);/);
  assert.match(firmDbSource, /date: row\.transaction_date \? toIsoDay\(row\.transaction_date\) : row\.payload\?\.date,/);
  assert.match(firmDbSource, /journal_date: row\.journal_date \? toIsoDay\(row\.journal_date\) : row\.journal_date,/);
  assert.match(firmDbSource, /period_start: row\.period_start \? toIsoDay\(row\.period_start\) : null,\n  period_end: row\.period_end \? toIsoDay\(row\.period_end\) : null,\n  status: row\.status,\n  schema_version: row\.schema_version,/);
});

// ── Canary round 2 (Kari's 2026-08-26 evening findings on the finish pass) ──

test('round 2: trailing statuses are right-aligned pills in the shared list grammar', () => {
  const styleSource = read('../components/shared/bank-feed-list-style.js');
  assert.match(styleSource, /export const bankFeedPillStyle = \(voice = 'ink'\) => \{/);
  // Close rows: the status pill renders inside the trailing cell, so it
  // terminates on the row's right edge exactly like Material's pills.
  assert.match(closeRowsSource, /BANK_FEED_TRAILING_CELL_STYLE, display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end'/);
  assert.match(closeRowsSource, /bankFeedPillStyle\(meta\.pill\)/);
  // Every visible ask row's "Awaiting reply" status speaks the same grammar.
  const askSource = read('../components/financials/ask-batch-panel.jsx');
  assert.match(askSource, /bankFeedPillStyle\('muted'\)\}>Awaiting reply/);
});

test('round 2: the rail is ONE chat surface — embedded dock, natural-height artifact block', () => {
  // Beneath a chat-less artifact the dock renders EMBEDDED: conversation +
  // composer only — no second header, no upload tray, no fixed 58/42 split
  // (a single chat stream/session, per the standing UI rail).
  assert.match(artifactPanelSource, /cloneElement\(dock, \{ embedded: true \}\)/);
  assert.match(artifactPanelSource, /flex: showDock \? '0 1 auto' : 1/);
  assert.doesNotMatch(artifactPanelSource, /0 0 42%/);
  assert.doesNotMatch(artifactPanelSource, /borderTop: visible/);
  assert.match(dockSource, /embedded = false/);
  assert.match(dockSource, /\{!embedded && \(\n    <div style=\{\{ borderBottom/);
  // The upload tray starts as a one-line strip (Kari, 2026-09-01: the rail
  // is one continuous chat, never split by a 40%-tall tray block). Expanded
  // it shows the WHOLE batch — no arbitrary height cap (Kari's same-day
  // follow-up): the tray takes its natural height and only scrolls when it
  // would crush the chat below the chat's minHeight floor, which keeps the
  // composer reachable at any batch size. The tray stays mounted in both
  // states so its parse-status poller keeps running.
  assert.match(dockSource, /useState\(false\)/);
  assert.match(dockSource, /\{!embedded && \(\n    <div style=\{uploadsOpen\n      \? \{ flex: '0 1 auto', minHeight: 0, overflowY: 'auto'/);
  assert.doesNotMatch(dockSource, /maxHeight: '40%'/);
  assert.match(dockSource, /flex: '1 1 0', minHeight: 280/);
  assert.match(dockSource, /collapsed=\{!uploadsOpen\}/);
});

test('C2a: the Locked badge renders the persisted close_periods verdict', () => {
  assert.match(panelSource, /const lockedMonths = useMemo\(/);
  assert.match(panelSource, /String\(p\?\.status \|\| ''\) !== 'locked'/);
  assert.match(panelSource, /lockedMonths\.has\(monthKey\)/);
  // closePeriods rides the snapshot thread console → workspace → panel.
  assert.match(consoleSource, /closePeriods=\{selectedClosePeriods\}/);
  assert.match(read('../components/FirmClientWorkspace.jsx'), /closePeriods=\{closePeriods\}/);
});
