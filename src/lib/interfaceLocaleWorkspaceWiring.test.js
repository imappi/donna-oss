import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

const appSource = read('../App.jsx');
const mainSource = read('../main.jsx');
const previewSource = read('../components/i18n/LocaleWorkspaceStatesPreview.jsx');
const consoleSource = read('../components/FirmOpsConsole.jsx');
const inboxSource = read('../components/donna-firm-feed-panel.jsx');
const feedSource = read('../components/shared/feed-list.jsx');
const bankFeedStyleSource = read('../components/shared/bank-feed-list-style.js');
const financialsSource = read('../components/financials/donna-financials-panel.jsx');
const portalSource = read('../components/donna-client-portal.jsx');
const periodSource = read('./periodOverview.js');

test('the workspace locale lab mounts production lifecycle and owner portal surfaces', () => {
  assert.match(mainSource, /isLocaleWorkspacePreview\(\)[\s\S]*<LocaleWorkspaceStatesPreview \/>/);
  assert.match(appSource, /isLocaleWorkspacePreview\(\)[\s\S]*return/);
  for (const component of [
    'PeriodHeader',
    'PeriodTransactionRow',
    'DonnaClientPortal'
  ]) {
    assert.match(previewSource, new RegExp(`<${component}\\b`));
  }
});

test('workspace chrome and lifecycle labels use the shared ICU catalog', () => {
  for (const source of [consoleSource, inboxSource, feedSource, financialsSource, portalSource]) {
    assert.match(source, /useIntl/);
  }
  assert.match(periodSource, /lifecycle\.period\.summary\.needsInput/);
  assert.match(financialsSource, /periodSummaryLabel\(period, intl\.formatMessage\)/);
  assert.match(portalSource, /portal\.hero\.thingCount/);
  assert.match(portalSource, /portal\.list\.title/);
});

test('mixed-direction workspace values are isolated and accounting rows use locale context', () => {
  assert.match(consoleSource, /<BidiText direction="auto">\{selectedClient\.companyName\}<\/BidiText>/);
  assert.match(feedSource, /shortDate\(item\.transaction_date, formatDate\)/);
  assert.match(feedSource, /formatAmount\(item\.amount, formatLocaleAmount/);
  assert.match(financialsSource, /<FormattedValue>\{amount\}<\/FormattedValue>/);
  assert.match(financialsSource, /title=\{description\}[\s\S]*?<BidiText[\s\S]*?direction="auto"[\s\S]*?\{description\}[\s\S]*?<\/BidiText>/);
  assert.match(portalSource, /<BidiText direction="auto">\{ventureLabel\}<\/BidiText>/);
  assert.match(portalSource, /buildQuestionFromEvidenceRequest\(request, \{[\s\S]*?formatAmount,[\s\S]*?formatDate,[\s\S]*?formatMessage: intl\.formatMessage[\s\S]*?\}\)/);
});

test('the shared lifecycle grammar mirrors with logical inline properties', () => {
  for (const source of [feedSource, bankFeedStyleSource, inboxSource]) {
    assert.doesNotMatch(source, /\b(marginLeft|marginRight|paddingLeft|paddingRight|borderLeft|borderRight|left|right):/);
  }
  assert.match(bankFeedStyleSource, /insetInlineStart: 0/);
  // The sticky month boundary pins with a logical block property, so the
  // single-list grammar mirrors without physical top/left offsets.
  assert.match(financialsSource, /insetBlockStart: 0/);
});
