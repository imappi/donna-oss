import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dockSource = readFileSync(new URL('../components/firm-dock.jsx', import.meta.url), 'utf8');
const chatSource = readFileSync(new URL('../components/financials/feed-chat.jsx', import.meta.url), 'utf8');
const sharedChatSource = readFileSync(new URL('../components/shared/donna-chat.jsx', import.meta.url), 'utf8');
const traySource = readFileSync(new URL('../components/UploadTray.jsx', import.meta.url), 'utf8');
const consoleSource = readFileSync(new URL('../components/FirmOpsConsole.jsx', import.meta.url), 'utf8');
const stylesSource = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const remainingCatalogSource = readFileSync(new URL('../i18n/catalogs/remainingSurfaces.en.js', import.meta.url), 'utf8');

test('the mascot opens a Donna-first surface with quiet scope copy', () => {
  assert.match(dockSource, />\s*Donna\s*</);
  assert.match(dockSource, /clientName \|\| intl\.formatMessage\(\{ id: 'mounted\.dock\.thisVenture' \}\)/);
  assert.match(dockSource, /intl\.formatMessage\(\{ id: 'mounted\.dock\.allVentures' \}\)/);
  assert.doesNotMatch(dockSource, /Command every venture|Command this venture/);
});

test('suggested questions stay beside the composer and act in one click', () => {
  const suggestionPosition = chatSource.indexOf('<StarterActions firmScope={firmScope}');
  const composerPosition = chatSource.indexOf('<Composer');
  assert.ok(suggestionPosition > 0 && suggestionPosition < composerPosition);
  assert.match(chatSource, /onClick=\{\(\) => onRun\(item\.prompt\)\}/);
  assert.match(chatSource, /disabled=\{sending\} onRun=\{send\}/);
  assert.match(chatSource, /feed\.suggestions\.title/);
  assert.match(remainingCatalogSource, /'feed\.suggestions\.title': 'Suggested questions'/);
  // S4: role threads address the persona ("Ask Clara"); the main surface
  // keeps "Ask Donna" as the fallback — the law this pin protects.
  assert.match(chatSource, /feed\.composer\.askActor/);
  assert.match(chatSource, /feed\.composer\.askDonna/);
  assert.match(remainingCatalogSource, /'feed\.composer\.askDonna': 'Ask Donna'/);
  assert.doesNotMatch(chatSource, /What should I handle\?|I've got every venture's feed|Command it in one sentence|Just say it/);
});

test('working states use truthful rotating verbs while the request is in flight', () => {
  assert.match(chatSource, /role="status"/);
  assert.match(chatSource, /feed\.working\.opening/);
  assert.match(chatSource, /feed\.working\.client\.reading/);
  assert.match(chatSource, /feed\.working\.client\.checking/);
  assert.match(chatSource, /feed\.working\.client\.preparing/);
  assert.match(remainingCatalogSource, /'feed\.working\.opening': 'Opening Donna…'/);
  assert.match(remainingCatalogSource, /'feed\.working\.client\.reading': 'Reading the open work…'/);
  assert.match(remainingCatalogSource, /'feed\.working\.client\.checking': 'Checking each venture…'/);
  assert.match(remainingCatalogSource, /'feed\.working\.client\.preparing': 'Preparing the answer…'/);
  assert.match(chatSource, /animation: 'dotPulse 1\.2s ease-in-out infinite'/);
  assert.match(chatSource, /className="donna-working-verb"/);
  assert.match(chatSource, /className="donna-working-dot"/);
  assert.match(stylesSource, /\.donna-working-dot\s*\{\s*animation: none !important;/);
});

test('chat messages animate, collapse long text, and preserve structured replies', () => {
  assert.match(sharedChatSource, /className="donna-chat-message"/);
  assert.match(sharedChatSource, /ASSISTANT_COLLAPSE_AT = 1100/);
  assert.match(sharedChatSource, /USER_COLLAPSE_AT = 360/);
  assert.match(sharedChatSource, /donna\.chat\.showMore/);
  assert.match(sharedChatSource, /export const StructuredResponse/);
  assert.match(sharedChatSource, /accountMenuParts\(text\)/);
  assert.match(chatSource, /<AssistantBody text=\{message\.content\}>/);
  assert.match(chatSource, /<StructuredResponse text=\{message\.content\}/);
});

test('the dock renders real upload state with its own compact interactive view', () => {
  assert.match(dockSource, /inlineVariant="dock"/);
  assert.match(dockSource, /hideSettledFromPreviousSessions/);
  assert.doesNotMatch(dockSource, /autoDismissCompleted/);
  assert.match(traySource, /const renderInlineDock/);
  assert.match(traySource, /uiMessage\(intl, 'upload\.activity\.aria'\)/);
  assert.match(traySource, /uiMessage\(intl, 'upload\.title'/);
  assert.match(traySource, /duplicateOfSameName \? uiMessage\(intl, 'upload\.status\.alreadyUploaded'\)/);
  assert.match(traySource, /uiMessage\(intl, 'upload\.duplicate\.keepBoth'\)/);
  assert.match(traySource, /isRetrying \? 'upload\.retrying' : 'upload\.retry'/);
  assert.match(traySource, /isRechecking \? 'upload\.checking' : 'upload\.recheckNow'/);
  assert.match(traySource, /inlineVariant = 'dossier'/);
});

test('visual-QA fixture switches do not ship in the mounted app', () => {
  assert.doesNotMatch(consoleSource, /dock-preview/);
  assert.doesNotMatch(traySource, /dock-activity|preview-reading|preview-failed/);
});
