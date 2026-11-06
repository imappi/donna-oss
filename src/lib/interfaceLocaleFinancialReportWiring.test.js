import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createIntl, createIntlCache } from 'react-intl';

import en from '../i18n/catalogs/en.js';
import {
  REPORT_DRAFT_REASON_MESSAGE_IDS,
  REPORT_MESSAGES
} from '../i18n/catalogs/remainingSurfaces.en.js';
import { getInterfaceCatalog } from '../i18n/localeCatalog.js';
import { buildFinancialReportCsv } from '../../server/donna/financialReportExport.js';

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

const workspaceSource = read('../components/financials/financial-report-workspace.jsx');
const artifactSource = read('../components/financials/financials-report-artifact.jsx');
const reportsSource = read('../components/donna-client-reports.jsx');
const previewSource = read('../components/i18n/LocaleWorkspaceStatesPreview.jsx');
const combinedReportSource = [workspaceSource, artifactSource, reportsSource, previewSource].join('\n');

test('the workspace locale lab mounts all three production report surfaces over bidi accounting fixtures', () => {
  assert.match(previewSource, /<FinancialReportWorkspace/);
  assert.match(previewSource, /<FinancialsReportArtifact artifact=\{REPORT_COMPACT_ARTIFACT\}/);
  assert.match(workspaceSource, /<ClientReports/);
  assert.match(previewSource, /const \[surface, setSurface\] = useState\('report'\)/);
  assert.match(previewSource, /\['report', 'report\.heading\.eyebrow'\]/);
  assert.match(previewSource, /شركة النور للتجارة LLC/);
  assert.match(previewSource, /INV-2026-001 · مصروف غير مصنف/);
  assert.match(previewSource, /gridTemplateColumns: 'repeat\(auto-fit, minmax\(min\(100%, 360px\), 1fr\)\)'/);
  assert.match(previewSource, /\['en', 'workspacePreview\.locale\.english'\]/);
  assert.match(previewSource, /\['ar-AE', 'settings\.language\.arabic\.label'\]/);
  assert.match(previewSource, /\['ar-XB', 'workspacePreview\.locale\.rtl'\]/);
});

test('every reserved report message is consumed by production report wiring', () => {
  const bridgedReasonIds = new Set(Object.values(REPORT_DRAFT_REASON_MESSAGE_IDS));
  const missing = Object.keys(REPORT_MESSAGES)
    .filter((id) => !combinedReportSource.includes(id) && !bridgedReasonIds.has(id));
  assert.deepEqual(missing, []);
  assert.equal(Object.keys(REPORT_MESSAGES).length, 74);
});

test('report values use shared locale and bidi primitives with no hardcoded product locale or physical inline side', () => {
  for (const source of [workspaceSource, artifactSource, reportsSource]) {
    assert.match(source, /useIntl/);
    assert.match(source, /useInterfaceLocale/);
    assert.doesNotMatch(source, /(?:Intl\.(?:NumberFormat|DateTimeFormat)|toLocale(?:String|DateString))\(['"]en-/);
    assert.doesNotMatch(source, /\b(?:marginLeft|marginRight|paddingLeft|paddingRight|borderLeft|borderRight|left|right):/);
  }
  assert.match(reportsSource, /<BidiText direction="auto">\{resolvedVentureLabel\}<\/BidiText>/);
  assert.match(reportsSource, /dynamicLabel \? <BidiText direction="auto">\{label\}<\/BidiText>/);
  assert.match(reportsSource, /<IdentifierText>\{currency\}<\/IdentifierText>/);
  assert.match(reportsSource, /<FormattedValue>\{formatDate\(/);
  assert.match(artifactSource, /<IdentifierText>\{periodValue\(period\)\}<\/IdentifierText>/);
  assert.match(artifactSource, /direction === 'rtl' \? '›' : '‹'/);
});

test('persisted draft reason codes select closed messages while unknown detail stays isolated and unchanged', () => {
  assert.match(reportsSource, /REPORT_DRAFT_REASON_MESSAGE_IDS\[reason\?\.code\]/);
  assert.match(reportsSource, /id=\{messageId\}/);
  assert.match(reportsSource, /detail: <BidiText direction="auto">\{reason\?\.detail \|\| reason\?\.code \|\| '—'\}<\/BidiText>/);
  assert.doesNotMatch(reportsSource, /reason\.detail\s*=/);

  const cache = createIntlCache();
  const english = createIntl({ locale: 'en', messages: en }, cache);
  const pseudo = createIntl({ locale: 'ar-XB', messages: getInterfaceCatalog('ar-XB') }, cache);
  assert.equal(
    english.formatMessage({ id: REPORT_DRAFT_REASON_MESSAGE_IDS.unposted_transactions }, { count: 2 }),
    '2 transactions not yet posted to the ledger.'
  );
  assert.notEqual(
    pseudo.formatMessage({ id: REPORT_DRAFT_REASON_MESSAGE_IDS.unposted_transactions }, { count: 2 }),
    '2 transactions not yet posted to the ledger.'
  );
  assert.equal(
    english.formatMessage({ id: 'report.reason.unknown' }, { detail: 'مراجعة INV-2026-001' }),
    'مراجعة INV-2026-001'
  );
});

test('interface locale never enters the canonical report download or export bytes', () => {
  assert.match(reportsSource, /const canonicalRequest = \{ clientId, periodStart, periodEnd, basis, format \};/);
  assert.match(reportsSource, /downloadFinancialReport\(canonicalRequest\)/);
  assert.doesNotMatch(reportsSource, /canonicalRequest\s*=\s*\{[^}]*locale/);

  const canonicalReport = {
    firm_id: 'firm-preview',
    client_id: 'client-preview-ae',
    period_start: '2026-08-01',
    period_end: '2026-08-31',
    as_of: '2026-08-31',
    basis: 'accrual',
    currency: { presentation: 'AED', currencies: ['AED'], mixed: false },
    profit_and_loss: {
      accounts: [{ id: 'revenue', code: '4000', name: 'إيرادات الاستشارات', account_type: 'revenue', currency: 'AED', revenue: 1234.56, expense: 0, net: 1234.56 }],
      revenue: 1234.56,
      expenses: 0,
      net_income: 1234.56
    },
    balance_sheet: { assets: { accounts: [] }, liabilities: { accounts: [] }, equity: { accounts: [] } },
    trial_balance: { accounts: [] },
    cash: { accounts: [] },
    draft: { is_draft: true, stamp: 'DRAFT', reasons: [{ code: 'pending_questions', detail: '1 item awaiting client evidence or review.' }] }
  };
  const beforeLocaleSwitch = buildFinancialReportCsv(canonicalReport);
  const afterLocaleSwitch = buildFinancialReportCsv(structuredClone(canonicalReport));
  assert.equal(afterLocaleSwitch, beforeLocaleSwitch);
  assert.match(beforeLocaleSwitch, /2026-08-01 to 2026-08-31/);
  assert.match(beforeLocaleSwitch, /1234\.56/);
});
