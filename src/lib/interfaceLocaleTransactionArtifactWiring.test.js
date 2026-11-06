import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildAuditTimelineView } from './auditTimelineView.js';
import { buildCaseHealthView } from './caseHealthView.js';

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

const artifactSource = read('../components/financials/transaction-artifact.jsx');
const auditSource = read('../components/financials/transaction-audit-timeline.jsx');
const panelSource = read('../components/financials/artifact-panel.jsx');
const previewSource = read('../components/i18n/LocaleWorkspaceStatesPreview.jsx');
const matchSource = read('./transactionMatchHero.js');
const formattingSource = read('../i18n/localeFormatting.js');
const catalogSource = read('../i18n/catalogs/en.js');
const registrySource = read('../i18n/localeRegistry.js');

test('the mounted policy incident retries through the existing artifact coding action and shows its result', () => {
  assert.match(artifactSource, /onRetryCoding=\{onSuggestTransactionCoding \? handleRefreshClick : null\}/);
  assert.match(artifactSource, /retryingCoding=\{recoding\}/);
  assert.match(artifactSource, /retryCodingError=\{recodeError\}/);
  assert.match(artifactSource, /await onSuggestTransactionCoding\(transactionId\)/);
  assert.match(auditSource, /health\.blocker\.canRetryCoding && onRetryCoding && !previewSnapshot/);
  assert.match(auditSource, /onClick=\{onRetryCoding\}/);
  assert.match(auditSource, /disabled=\{retryingCoding\}/);
  assert.match(auditSource, /role="alert"/);
  assert.match(auditSource, /'common\.retrying' : 'artifact\.refresh\.transaction'/);
});

test('the locale lab mounts the production transaction detail with persisted audit fixtures', () => {
  assert.match(previewSource, /<TransactionArtifact artifact=\{TRANSACTION_ARTIFACT\}/);
  assert.match(previewSource, /previewMode: 'detail'/);
  assert.match(previewSource, /previewAuditSnapshot/);
  assert.match(previewSource, /INV-2026-001_فاتورة-شركة-النور\.pdf/);
  assert.match(artifactSource, /<TransactionAuditTimeline[\s\S]*previewSnapshot=\{data\.previewAuditSnapshot \|\| null\}/);
});

test('transaction summary and audit copy route through the ICU catalog', () => {
  for (const source of [artifactSource, auditSource, panelSource]) {
    assert.match(source, /useIntl/);
  }
  for (const id of [
    'transaction.match.why',
    'transaction.audit.title',
    'transaction.audit.timestampMissing',
    'transaction.health.blocker.integrationFailure',
    'transaction.post.xero',
    'artifact.hide'
  ]) {
    assert.match(catalogSource, new RegExp(`'${id}'`));
  }

  const translate = ({ id }) => `translated:${id}`;
  const timeline = buildAuditTimelineView({
    present: true,
    terminal: { present: true, state: 'auto_reconciled' },
    events: [{ kind: 'document_received', density: 'owner', fields: {} }],
    gaps: [{ kind: 'empty_timeline' }]
  }, translate);
  assert.equal(timeline.terminal.headline, 'translated:transaction.audit.terminal.autoReconciled');
  assert.equal(timeline.events[0].headline, 'translated:transaction.audit.event.evidenceReceived');
  assert.equal(timeline.gaps[0], 'translated:transaction.audit.gap.empty');

  const health = buildCaseHealthView({
    present: true,
    phase: 'stuck',
    blocker: { kind: 'integration_failure' },
    recovery: { class: null },
    gaps: []
  }, translate);
  assert.equal(health.phase.label, 'translated:transaction.health.phase.stuck');
  assert.equal(health.blocker.headline, 'translated:transaction.health.blocker.integrationFailure');
});

test('transaction accounting values use locale context and mixed-direction data is isolated', () => {
  for (const source of [artifactSource, auditSource, matchSource]) {
    assert.doesNotMatch(source, /toLocale(?:DateString|String)\(['"]en-/);
  }
  assert.match(artifactSource, /const \{ formatAmount, formatDate, formatTimestamp \} = useInterfaceLocale\(\)/);
  assert.match(auditSource, /const \{ formatTimestamp \} = useInterfaceLocale\(\)/);
  assert.match(formattingSource, /timeZone = 'Asia\/Dubai'/);
  assert.match(formattingSource, /calendar: 'gregory'/);
  assert.match(artifactSource, /<BidiText direction="auto">\{documentTitle\}<\/BidiText>/);
  assert.match(artifactSource, /<FormattedValue>\{transactionMeta\}<\/FormattedValue>/);
  assert.match(auditSource, /<IdentifierText>\{view\.kind\}<\/IdentifierText>/);
  assert.match(auditSource, /<pre dir="ltr"/);
  assert.match(panelSource, /borderInlineStart:/);
  assert.match(panelSource, /insetInlineStart: 0/);
  assert.doesNotMatch(panelSource, /\b(?:marginLeft|marginRight|paddingLeft|paddingRight|borderLeft|borderRight|left|right):/);
});

test('the real Arabic locale is ready with its complete catalog installed', () => {
  assert.match(registrySource, /'ar-AE':[\s\S]*status: 'ready'/);
  assert.match(read('../i18n/localeCatalog.js'), /'ar-AE': arAE/);
});

test('every localized label helper call carries its formatter — a bare call is the 2026-08-31 QuickPrompts crash', () => {
  // amountLabel(tx) without the formatter threw "formatAmount is not a
  // function" and unmounted the whole app on every unreconciled line click:
  // QuickPrompts only renders for lines without a match, so the localized
  // preview fixtures never exercised it. Pin the helper arity at the source
  // level for every call site.
  assert.doesNotMatch(artifactSource, /amountLabel\(\s*[^,)]+\s*\)/);
  assert.doesNotMatch(artifactSource, /dateLabel\(\s*[^,)]+\s*\)/);
  assert.match(artifactSource, /<QuickPrompts[\s\S]*?formatAmount=\{formatAmount\}[\s\S]*?formatDate=\{formatDate\}/);
});
