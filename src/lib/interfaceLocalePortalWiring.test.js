import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

const appSource = read('../App.jsx');
const portalSource = read('../components/donna-client-portal.jsx');
const chatSource = read('../components/ClientPortalChatPanel.jsx');
const previewSource = read('../components/i18n/LocaleWorkspaceStatesPreview.jsx');
const vatSource = read('./gbVatReturnView.js');
const catalogSource = read('../i18n/catalogs/remainingSurfaces.en.js');

test('the production owner portal mounts the localized detail and chat composition', () => {
  assert.match(appSource, /import ClientPortal from '\.\/components\/donna-client-portal\.jsx'/);
  assert.match(portalSource, /import ClientPortalChatPanel from '\.\/ClientPortalChatPanel\.jsx'/);
  assert.match(portalSource, /<ClientPortalChatPanel[\s\S]*clientId=\{selectedClient\.id\}/);
  assert.match(portalSource, /<ClientReports[\s\S]*databaseMode=\{liveDatabaseMode\}/);
});

test('remaining portal chrome consumes only reserved portal message ids', () => {
  const requiredPortalIds = [
    'portal.setup.entity.title',
    'portal.setup.fiscal.title',
    'portal.setup.gb.title',
    'portal.channel.whatsapp.title',
    'portal.channel.telegram.title',
    'portal.vat.title',
    'portal.documents.tabs.aria',
    'portal.documents.archive.body',
    'portal.activity.title',
    'portal.messages.title',
    'portal.footer.security'
  ];
  const requiredChatIds = [
    'portal.chat.launch',
    'portal.chat.dialogAria',
    'portal.chat.welcome',
    'portal.chat.open.title',
    'portal.chat.intent.title',
    'portal.chat.action.confirm',
    'portal.chat.loading.thread',
    'portal.chat.attach',
    'portal.chat.placeholder',
    'portal.chat.send'
  ];
  for (const id of requiredPortalIds) {
    assert.match(portalSource, new RegExp(id.replaceAll('.', '\\.')));
    assert.match(catalogSource, new RegExp(`'${id.replaceAll('.', '\\.')}':`));
  }
  for (const id of requiredChatIds) {
    assert.match(chatSource, new RegExp(id.replaceAll('.', '\\.')));
    assert.match(catalogSource, new RegExp(`'${id.replaceAll('.', '\\.')}':`));
  }
  for (const source of [portalSource, chatSource]) {
    assert.doesNotMatch(source, /['"](?:report|operator|feed|transaction)\./);
  }
});

test('canonical legal forms and document types cross presentation bridges without changing stored values', () => {
  assert.match(portalSource, /PORTAL_DOCUMENT_TYPE_MESSAGE_IDS/);
  assert.match(portalSource, /PORTAL_LEGAL_FORM_MESSAGE_IDS/);
  assert.match(portalSource, /<option key=\{option\} value=\{option\}>[\s\S]*PORTAL_LEGAL_FORM_MESSAGE_IDS\[option\]/);
  assert.match(portalSource, /const typeMessageId = PORTAL_DOCUMENT_TYPE_MESSAGE_IDS\[doc\.document_type\]/);
  assert.match(portalSource, /profilePatch: \{[\s\S]*entity_type: entityTypeDraft\.entity_type/);
  assert.match(portalSource, /document_type: doc\.document_type/);
  assert.match(vatSource, /currency: 'GBP'/);
  assert.match(vatSource, /netVat: Number\(vatReturn\.netVat\)/);
});

test('mixed-direction prose, filenames, identifiers, amounts, dates, and counts use shared boundaries', () => {
  assert.match(portalSource, /<BidiText direction="auto">\{doc\.filename/);
  assert.match(portalSource, /<IdentifierText>\{fileExtensionBadge\(doc\.filename\)\}<\/IdentifierText>/);
  assert.match(portalSource, /formatAmount\(row\.amount, \{ currency: ownerVatCard\.view\.currency \}\)/);
  assert.match(portalSource, /formatDate\(ownerVatCard\.view\.dueDate\)/);
  assert.match(portalSource, /formatTimestamp\(activityFixture\.uploadedAt\)/);
  assert.match(portalSource, /intl\.formatNumber\(visibleUploads\.length\)/);
  assert.match(chatSource, /<BidiText direction="auto">\{entry\.text\}<\/BidiText>/);
  assert.match(chatSource, /<IdentifierText>\{card\.intentKind\}<\/IdentifierText>/);
  assert.match(chatSource, /formatTimestamp\(card\.lastOwnerMessageAt\)/);
  assert.match(portalSource, /formatTimestamp\(item\.q\.topic\.lastOwnerMessageAt\)/);
  assert.doesNotMatch(chatSource, /\{card\.outcomeLabel\}/);
  for (const source of [portalSource, chatSource]) {
    assert.doesNotMatch(source, /toLocale(?:String|DateString)\(/);
    assert.doesNotMatch(source, /['"]en-US['"]/);
  }
});

test('the chat dialog traps keyboard focus, restores the launcher, and mirrors logically', () => {
  assert.match(chatSource, /role="dialog"[\s\S]*aria-modal="true"/);
  assert.match(chatSource, /event\.key === 'Escape'[\s\S]*closePanel\(\)/);
  assert.match(chatSource, /event\.key !== 'Tab'/);
  assert.match(chatSource, /returnFocusRef\.current\?\.focus\(\)/);
  assert.match(chatSource, /composerRef\.current\?\.focus\(\)/);
  assert.match(chatSource, /dir="auto"/);
  for (const source of [portalSource, chatSource]) {
    assert.doesNotMatch(source, /\b(?:marginLeft|marginRight|paddingLeft|paddingRight|borderLeft|borderRight|left|right|top|bottom):/);
  }
  assert.match(chatSource, /insetInlineEnd:/);
  assert.match(chatSource, /borderInlineStart:/);
});

test('the locale lab pins real portal detail, empty, setup, chat, error, compact, and zoom states', () => {
  assert.match(previewSource, /<DonnaClientPortal[\s\S]*previewState=\{previewState\}/);
  for (const fixture of [
    'شركة النور للتجارة · Al Noor Trading Ltd',
    'INV-2026-001_فاتورة-شركة-النور.pdf',
    'GB29NWBK60161331926819',
    'TRN-100483729100003',
    'Kari Ledger · كاري'
  ]) {
    assert.ok(previewSource.includes(fixture), `missing mixed-direction portal fixture: ${fixture}`);
  }
  for (const scenario of ['detail', 'empty', 'setup', 'chat', 'states']) {
    assert.match(previewSource, new RegExp(`['"]${scenario}['"]`));
  }
  assert.match(previewSource, /\['en', 'workspacePreview\.locale\.english'\]/);
  assert.match(previewSource, /\['ar-AE', 'settings\.language\.arabic\.label'\]/);
  assert.match(previewSource, /\['ar-XB', 'workspacePreview\.locale\.rtl'\]/);
  assert.match(previewSource, /\['compact', '390px'\]/);
  assert.match(previewSource, /\['zoom', '200%'\]/);
  assert.match(previewSource, /zoom: 2/);
  assert.match(previewSource, /setupDue: \['jurisdiction', 'entity_type', 'fiscal_period', 'gb_filing', 'channel_connect'\]/);
  assert.match(previewSource, /loading: true/);
  assert.match(previewSource, /portal\.chat\.error\.send/);
});

test('preview branches stay local before any owner-portal network or mutation call', () => {
  assert.match(portalSource, /if \(previewMode\) \{[\s\S]*return Array\.from\(files\)/);
  assert.match(portalSource, /if \(previewMode\) \{[\s\S]*setDownloadingDocId\(''\);[\s\S]*return;/);
  assert.match(chatSource, /if \(previewMode\) \{[\s\S]*setMessages[\s\S]*return;[\s\S]*postClientPortalChatMessage/);
  assert.match(chatSource, /if \(previewMode\) \{[\s\S]*status: 'applied'[\s\S]*return;[\s\S]*applyClientPortalChatAction/);
});
