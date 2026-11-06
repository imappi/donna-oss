import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

const sharedSource = read('../components/shared/donna-chat.jsx');
const documentSource = read('../components/documents/document-chat.jsx');
const previewSource = read('../components/i18n/LocaleWorkspaceStatesPreview.jsx');
const helperSource = read('./documentChat.js');
const catalogSource = read('../i18n/catalogs/en.js');
const registrySource = read('../i18n/localeRegistry.js');
const localeCatalogSource = read('../i18n/localeCatalog.js');

test('shared Donna message and composer grammar uses the ICU catalog', () => {
  assert.match(sharedSource, /useIntl/);
  for (const id of [
    'donna.chat.showLess',
    'donna.chat.showMore',
    'donna.chat.composer.placeholder',
    'donna.chat.send',
    'donna.chat.sending'
  ]) {
    assert.match(catalogSource, new RegExp(`'${id}'`));
    assert.match(sharedSource, new RegExp(id.replaceAll('.', '\\.')));
  }
  assert.doesNotMatch(sharedSource, /placeholder\s*=\s*['"]Ask Donna/);
  assert.doesNotMatch(sharedSource, /aria-label\s*=\s*\{?['"]Send/);
});

test('shared conversation content and controls are bidi-safe', () => {
  assert.match(sharedSource, /dir="auto"/);
  assert.match(sharedSource, /<BidiText direction="auto">/);
  assert.match(sharedSource, /<FormattedValue>/);
  assert.match(sharedSource, /paddingInlineEnd/);
  assert.match(sharedSource, /marginInlineStart/);
  assert.match(sharedSource, /transform: direction === 'rtl' \? 'scaleX\(-1\)' : undefined/);
  assert.doesNotMatch(sharedSource, /\b(?:marginLeft|marginRight|paddingLeft|paddingRight|borderLeft|borderRight|left|right):/);
});

test('document action cards separate translatable labels from typed accounting values', () => {
  assert.match(helperSource, /ACTION_TYPE_MESSAGE_IDS/);
  assert.doesNotMatch(helperSource, /ACTION_TYPE_LABELS/);
  assert.doesNotMatch(helperSource, /Explain match reasoning|Narrow transaction search|Link to transaction/);
  assert.match(documentSource, /const ActionDetailValue/);
  assert.match(documentSource, /detail\.kind === 'amount'/);
  assert.match(documentSource, /formatAmount\(detail\.value/);
  assert.match(documentSource, /detail\.kind === 'date_range'/);
  assert.match(documentSource, /formatActionDate/);
  assert.match(documentSource, /<IdentifierText>/);
  assert.match(documentSource, /ACTION_TYPE_MESSAGE_IDS\[action\.type\]/);
  assert.match(documentSource, /message\(detail\.labelId\)/);
  assert.match(documentSource, /message\(card\.statusMessageId\)/);
  assert.match(documentSource, /message\(card\.buttonMessageId\)/);
});

test('mounted preview covers Arabic, mixed identifiers, and each consequential card state', () => {
  assert.match(previewSource, /const DOCUMENT_CONVERSATION = \[/);
  assert.match(previewSource, /role: 'system'/);
  assert.match(previewSource, /role: 'user'/);
  assert.match(previewSource, /role: 'assistant'/);
  assert.match(previewSource, /اربط هذه الفاتورة بالدفع INV-2026-001/);
  assert.match(previewSource, /type: 'link_transaction'[\s\S]*status: 'proposed'/);
  assert.match(previewSource, /type: 'leave_review_note'[\s\S]*status: 'applied'/);
  assert.match(previewSource, /type: 'future_action'[\s\S]*status: 'proposed'/);
  assert.match(documentSource, /if \(conversationPreview\) \{[\s\S]*setMessages/);
});

test('Arabic is production-ready after the AR-3C technical gate', () => {
  assert.match(registrySource, /'ar-AE': Object\.freeze\(\{[\s\S]*status: 'ready'/);
  assert.match(localeCatalogSource, /'ar-AE': arAE/);
});
