import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { PRODUCTION_INTERFACE_LOCALES } from '../i18n/localeRegistry.js';

const mainSource = readFileSync(new URL('../main.jsx', import.meta.url), 'utf8');
const indexSource = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const registrySource = readFileSync(new URL('../i18n/localeRegistry.js', import.meta.url), 'utf8');
const catalogSource = readFileSync(new URL('../i18n/localeCatalog.js', import.meta.url), 'utf8');
const bidiSource = readFileSync(new URL('../i18n/BidiText.jsx', import.meta.url), 'utf8');
const sidebarSource = readFileSync(new URL('../components/settings/SettingsSidebar.jsx', import.meta.url), 'utf8');
const panelSource = readFileSync(new URL('../components/settings/SettingsPanel.jsx', import.meta.url), 'utf8');

test('the mounted root applies locale before paint and wraps every app surface in one provider', () => {
  assert.ok(
    mainSource.indexOf("import './i18n/prepaint.js';") < mainSource.indexOf("import React from 'react';"),
    'prepaint is the first evaluated main entry dependency'
  );
  assert.match(mainSource, /<LocaleProvider>[\s\S]*<App \/>[\s\S]*<\/LocaleProvider>/);
  assert.match(indexSource, /<html lang="en" dir="ltr">/);
});

test('Arabic is ready with an installed catalog and the production option set excludes pseudo-RTL', () => {
  assert.match(registrySource, /'ar-AE':[\s\S]*status: 'ready'/);
  assert.match(catalogSource, /'ar-AE':\s*arAE/);
  assert.deepEqual(PRODUCTION_INTERFACE_LOCALES.map((entry) => entry.tag), ['en', 'ar-AE']);
  assert.ok(PRODUCTION_INTERFACE_LOCALES.every((entry) => entry.status === 'ready'));
  assert.equal(PRODUCTION_INTERFACE_LOCALES.some((entry) => entry.tag === 'ar-XB'), false);
  assert.match(panelSource, /PRODUCTION_INTERFACE_LOCALES\.map/);
  assert.match(panelSource, /localeLabEnabled \? \([\s\S]*<option value="ar-XB"/);
});

test('the real mounted Settings pair carries the production language screen', () => {
  assert.match(sidebarSource, /items: \[[\s\S]*id: 'language'/);
  assert.doesNotMatch(sidebarSource, /localeLabEnabled/);
  assert.match(panelSource, /section === 'language' && <LanguageRegionSection \/>/);
  assert.match(panelSource, /setInterfaceLocale\(event\.target\.value\)/);
  assert.match(panelSource, /setNumberStyle\(event\.target\.value\)/);
  assert.match(panelSource, /lang=\{entry\.tag\} dir=\{entry\.direction\}/);
});

test('mixed-direction values use isolating markup and explicit identifier direction', () => {
  assert.match(bidiSource, /<bdi[^>]*dir=\{direction\}/);
  assert.match(bidiSource, /direction="ltr"/);
  assert.match(panelSource, /<IdentifierText>INV-2026-001<\/IdentifierText>/);
  assert.match(panelSource, /<IdentifierText>AE070331234567890123456<\/IdentifierText>/);
});
