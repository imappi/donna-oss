import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import remainingSurfacesEn, {
  OPERATOR_ACTION_TYPE_MESSAGE_IDS,
  TRANSACTION_REJECTION_MESSAGE_IDS
} from '../i18n/catalogs/remainingSurfaces.en.js';
import {
  MATCH_REJECTION_CHOICES,
  matchRejectionPrompt
} from './transactionChat.js';

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

const feedSource = read('../components/financials/feed-chat.jsx');
const transactionSource = read('../components/financials/transaction-artifact.jsx');
const stripsSource = read('../components/shared/operator-proposal-card-strips.jsx');
const helperSource = read('./transactionChat.js');
const previewSource = read('../components/i18n/LocaleWorkspaceStatesPreview.jsx');
const localeCatalogSource = read('../i18n/localeCatalog.js');

test('shipping feed and transaction cards resolve canonical action types at the presentation boundary', () => {
  for (const source of [feedSource, transactionSource]) {
    assert.match(source, /OPERATOR_ACTION_TYPE_MESSAGE_IDS\[action\.type\]/);
    assert.match(source, /useIntl/);
    assert.match(source, /<ProposalMetaStrip action=\{action\}/);
    assert.match(source, /<ApplyReceiptStrip action=\{action\}/);
  }
  assert.doesNotMatch(feedSource, /const ACTION_TYPE_LABELS/);
  assert.doesNotMatch(transactionSource, /TRANSACTION_ACTION_TYPE_LABELS/);
  for (const messageId of Object.values(OPERATOR_ACTION_TYPE_MESSAGE_IDS)) {
    assert.equal(typeof remainingSurfacesEn[messageId], 'string', messageId);
  }
});

test('rejection choices localize without translating the persisted reason code or canonical prompt', () => {
  assert.match(transactionSource, /TRANSACTION_REJECTION_MESSAGE_IDS\[choice\.id\]\.label/);
  assert.match(transactionSource, /matchRejectionPrompt\(choiceId\)/);
  assert.match(transactionSource, /matchRejectionPrompt\(choiceId\) === message\.content/);
  for (const choice of MATCH_REJECTION_CHOICES) {
    const contract = TRANSACTION_REJECTION_MESSAGE_IDS[choice.id];
    assert.ok(contract, choice.id);
    assert.equal(typeof remainingSurfacesEn[contract.label], 'string');
    if (contract.prompt) {
      assert.equal(matchRejectionPrompt(choice.id), remainingSurfacesEn[contract.prompt]);
    } else {
      assert.equal(matchRejectionPrompt(choice.id), null);
    }
  }
});

test('dynamic prose, identifiers, dates, amounts and counts use the shared bidi and locale boundaries', () => {
  for (const source of [feedSource, transactionSource, stripsSource]) {
    assert.match(source, /BidiText/);
    assert.match(source, /IdentifierText/);
    assert.match(source, /FormattedValue/);
  }
  assert.match(feedSource, /const \{ formatAmount \} = useInterfaceLocale\(\)/);
  assert.match(transactionSource, /describeTransactionActionDetails\(action\)/);
  assert.match(transactionSource, /formatDate\(detail\.value/);
  assert.match(stripsSource, /intl\.formatNumber/);
  assert.doesNotMatch(feedSource, /\.toLocaleString\(/);
  for (const source of [feedSource, transactionSource, stripsSource]) {
    assert.doesNotMatch(source, /\b(?:marginLeft|marginRight|paddingLeft|paddingRight|borderLeft|borderRight|left|right):/);
  }
});

test('the locale lab mounts both production paths with every lifecycle and constrained layout state', () => {
  assert.match(previewSource, /<FeedChat[\s\S]*previewMessages=\{FEED_ACTION_CONVERSATION\}/);
  assert.match(previewSource, /<TransactionArtifact artifact=\{TRANSACTION_ACTION_ARTIFACT\}/);
  assert.match(feedSource, /if \(previewMode\) \{[\s\S]*setMessages/);
  assert.match(transactionSource, /if \(actionPreview\) \{[\s\S]*setMessages/);
  assert.match(previewSource, /type: 'apply_category'[\s\S]*status: 'proposed'/);
  assert.match(previewSource, /type: 'ask_client'[\s\S]*status: 'applied'/);
  assert.match(previewSource, /type: 'future_action'[\s\S]*status: 'proposed'/);
  assert.match(previewSource, /status: 'error', error: 'تعذّر التطبيق · ERR-PARSE-42'/);
  assert.match(previewSource, /شركة النور للتجارة LLC/);
  assert.match(previewSource, /INV-2026-001/);
  assert.match(previewSource, /\{ id: 'compact', width: 390, label: '390px' \}/);
  assert.match(previewSource, /\{ id: 'zoom-200', width: 360, label: '200%' \}/);
  assert.match(previewSource, /data-zoom-equivalent/);
  assert.match(feedSource, /event\.key === 'Enter' && \(event\.metaKey \|\| event\.ctrlKey\)/);
  assert.match(transactionSource, /event\.key === 'Enter' && \(event\.metaKey \|\| event\.ctrlKey\)/);
});

test('the slice stays presentation-only after the AR-3A catalog lands', () => {
  for (const source of [feedSource, transactionSource, stripsSource, helperSource]) {
    assert.doesNotMatch(source, /ar-AE/);
  }
  assert.match(localeCatalogSource, /AR_AE_CATALOG_VERSION/);
  assert.match(localeCatalogSource, /'ar-AE': arAE/);
});
