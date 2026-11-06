import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

const appSource = read('../App.jsx');
const mainSource = read('../main.jsx');
const authSource = read('../components/FirmAuthGate.jsx');
const onboardingSource = read('../components/FirstRunOnboarding.jsx');
const feedbackSource = read('../components/FeedbackModal.jsx');
const dropSource = read('../components/FirmDropOverlay.jsx');
const toastSource = read('../components/shared/toast-host.jsx');
const uploadSource = read('../components/UploadTray.jsx');
const uploadLabelsSource = read('./uploadTray.js');
const previewSource = read('../components/i18n/LocaleShellStatesPreview.jsx');

test('the developer shell lab mounts real production surfaces without the app route rewrite', () => {
  assert.match(mainSource, /isLocaleShellPreview\(\)[\s\S]*<LocaleShellStatesPreview \/>/);
  assert.match(appSource, /isLocaleSettingsPreview\(\) \|\| isLocaleShellPreview\(\)[\s\S]*return/);
  for (const component of [
    'FirmAuthGate',
    'FirstRunOnboarding',
    'FeedbackModal',
    'UploadActivityRows',
    'Toast',
    'FirmDropTarget'
  ]) {
    assert.match(previewSource, new RegExp(`<${component}\\b`));
  }
});

test('shell state copy, labels and errors use the shared interface catalog', () => {
  for (const source of [appSource, authSource, onboardingSource, feedbackSource, dropSource, toastSource, uploadSource]) {
    assert.match(source, /useIntl|FormattedMessage/);
  }
  assert.match(uploadLabelsSource, /formatMessage\(\{ id, defaultMessage \}, values\)/);
  assert.match(uploadSource, /labelForTrayRow\(row, intl\.formatMessage, formatAmount\)/);
  assert.match(uploadSource, /duplicateResolveStateForRow\(row, intl\.formatMessage\)/);
});

test('mixed-direction shell values and form fields carry explicit direction contracts', () => {
  assert.match(authSource, /type="email"[\s\S]*dir="ltr"/);
  assert.match(authSource, /<IdentifierText>\{CONTACT_EMAIL\}<\/IdentifierText>/);
  assert.match(onboardingSource, /id="fr-firm"[\s\S]*dir="auto"/);
  assert.match(onboardingSource, /id="fr-email"[\s\S]*dir="ltr"/);
  assert.match(feedbackSource, /<textarea[\s\S]*dir="auto"/);
  assert.match(dropSource, /<BidiText direction="auto"[\s\S]*clientName/);
  assert.match(toastSource, /<BidiText direction="auto">\{toast\.message\}<\/BidiText>/);
  assert.match(uploadSource, /<BidiText direction="auto">\{row\.filename\}<\/BidiText>/);
});

test('movable shell chrome uses logical positioning and the modal owns keyboard focus', () => {
  assert.doesNotMatch(dropSource, /\b(left|right):/);
  assert.doesNotMatch(toastSource, /\b(left|right):/);
  assert.doesNotMatch(uploadSource, /\b(left|right|borderLeft|borderRight|paddingLeft|paddingRight):/);
  assert.match(feedbackSource, /event\.key !== 'Tab'/);
  assert.match(feedbackSource, /returnFocusRef\.current\.focus\(\)/);
  assert.match(authSource, /direction === 'rtl' \? '←' : '→'/);
});
