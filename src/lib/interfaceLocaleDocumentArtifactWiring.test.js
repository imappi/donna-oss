import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { formatChatTimestamp } from './documentChat.js';

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

const artifactSource = read('../components/financials/document-artifact.jsx');
const chatSource = read('../components/documents/document-chat.jsx');
const sharedChatSource = read('../components/shared/donna-chat.jsx');
const previewSource = read('../components/i18n/LocaleWorkspaceStatesPreview.jsx');
const catalogSource = read('../i18n/catalogs/en.js');
const registrySource = read('../i18n/localeRegistry.js');
const transactionSource = read('../components/financials/transaction-artifact.jsx');
const feedChatSource = read('../components/financials/feed-chat.jsx');

test('the locale lab mounts the production document artifact in detail and conversation states', () => {
  assert.match(previewSource, /<DocumentArtifact key=\{scenario\} artifact=\{documentArtifactPreview\(scenario\)\}/);
  assert.match(previewSource, /previewMode: scenario === 'conversation' \? 'conversation' : 'detail'/);
  assert.match(previewSource, /workspacePreview\.document\.matched/);
  assert.match(previewSource, /workspacePreview\.document\.search/);
  assert.match(previewSource, /workspacePreview\.document\.conversation/);
  assert.match(previewSource, /INV-2026-001_فاتورة-شركة-النور\.pdf/);
  assert.match(artifactSource, /previewMode=\{data\.previewMode \|\| null\}/);
  assert.match(artifactSource, /previewMessages=\{data\.previewMessages \|\| undefined\}/);
  assert.match(artifactSource, /previewAppliableActionTypes=\{data\.previewAppliableActionTypes \|\| undefined\}/);
});

test('document-specific chrome, resolution states and errors route through the ICU catalog', () => {
  assert.match(artifactSource, /useIntl/);
  assert.match(chatSource, /useIntl/);
  for (const id of [
    'document.unavailable',
    'document.original.view',
    'document.conversation.loading',
    'document.matches.potential',
    'document.matches.hint.vendorMatch',
    'document.match.confirmed',
    'document.match.pending'
  ]) {
    assert.match(catalogSource, new RegExp(`'${id}'`));
    assert.match(`${artifactSource}\n${chatSource}`, new RegExp(id.replaceAll('.', '\\.')));
  }
});

test('document accounting values use locale context and mixed-direction values are isolated', () => {
  assert.match(chatSource, /const \{ formatAmount, formatDate, formatTimestamp \} = useInterfaceLocale\(\)/);
  assert.doesNotMatch(chatSource, /toLocale(?:DateString|TimeString|String)\(['"]en-/);
  assert.doesNotMatch(read('./documentChat.js'), /toLocaleTimeString\(['"]en-/);
  assert.match(chatSource, /<BidiText direction="auto">\{title\}<\/BidiText>/);
  assert.match(chatSource, /<BidiText direction="auto">\{tx\.description \|\| tx\.raw_description \|\| '—'\}<\/BidiText>/);
  assert.match(chatSource, /<FormattedValue>\{fmtAmt\(tx, formatAmount\)\}<\/FormattedValue>/);
  assert.match(chatSource, /signDisplay: 'always'/);
  assert.equal(formatChatTimestamp('2026-08-31T20:15:30Z', () => 'localized-time'), 'localized-time');
  assert.match(transactionSource, /formatChatTimestamp\(message\.created_at, \(value\) => formatTimestamp/);
  assert.match(feedChatSource, /formatChatTimestamp\(message\.created_at, \(value\) => formatTimestamp/);
});

test('detail previews stay quiet while the conversation preview drives mounted local consumers', () => {
  assert.match(chatSource, /const conversationPreview = previewMode === 'conversation'/);
  assert.match(chatSource, /const previewOnly = detailPreview \|\| conversationPreview/);
  assert.match(chatSource, /showPrompts=\{!detailPreview\}/);
  assert.match(chatSource, /!detailPreview && filterSupersededComments\(messages\)\.map/);
  assert.match(chatSource, /!detailPreview && <Composer/);
  assert.match(chatSource, /if \(conversationPreview\) \{[\s\S]*buildOptimisticUserMessage/);
  assert.match(chatSource, /if \(conversationPreview\) \{[\s\S]*status: 'applied'/);
  assert.match(previewSource, /previewAppliableActionTypes: scenario === 'conversation' \? \['link_transaction'\] : \[\]/);
  assert.match(chatSource, /const ActionCard/);
});

test('mounted document layout uses logical bidi structure and Arabic availability is production-ready', () => {
  for (const source of [artifactSource, chatSource, sharedChatSource]) {
    assert.doesNotMatch(source, /\b(?:marginLeft|marginRight|paddingLeft|paddingRight|borderLeft|borderRight|left|right):/);
  }
  assert.match(chatSource, /borderBlockEnd:/);
  assert.match(chatSource, /marginInlineStart: 'auto'/);
  assert.match(sharedChatSource, /borderEndEndRadius: 4/);
  assert.match(sharedChatSource, /paddingInlineStart: 18/);
  assert.match(registrySource, /'ar-AE':[\s\S]*status: 'ready'/);
  assert.match(read('../i18n/localeCatalog.js'), /'ar-AE': arAE/);
});
