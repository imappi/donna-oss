import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const titlebarSource = readFileSync(new URL('../components/DesktopTitlebar.jsx', import.meta.url), 'utf8');
const sidebarSource = readFileSync(new URL('../components/FirmSidebar.jsx', import.meta.url), 'utf8');
const settingsSidebarSource = readFileSync(new URL('../components/settings/SettingsSidebar.jsx', import.meta.url), 'utf8');
const consoleSource = readFileSync(new URL('../components/FirmOpsConsole.jsx', import.meta.url), 'utf8');
const stylesSource = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

test('the desktop titlebar drag region spans the reserved shell band', () => {
  assert.match(titlebarSource, /className="desktop-titlebar"/);
  assert.match(titlebarSource, /left: 0,[\s\S]*right: 0,[\s\S]*WebkitAppRegion: 'drag'/);
  assert.doesNotMatch(titlebarSource, /SIDEBAR_WIDTH/);
  assert.match(titlebarSource, /gap: 2,[\s\S]*WebkitAppRegion: 'no-drag'/);
});

test('entity tabs expand with the cancelled pane insets so they centre on the measured list', () => {
  assert.match(consoleSource, /width: `calc\(100% \+ \$\{PANE_PAD_X \* 2\}px\)`/);
  assert.match(consoleSource, /maxWidth: 'none'/);
  assert.match(consoleSource, /maxWidth: D\.measure/);
});

test('desktop focus remains visible without the browser-heavy black outline', () => {
  assert.match(stylesSource, /--desktop-focus-ring:/);
  assert.match(stylesSource, /html\.donna-desktop :where\([\s\S]*\):focus-visible \{[\s\S]*outline: 1px solid var\(--desktop-focus-ring\) !important;[\s\S]*outline-offset: -1px !important;/);
});

test('application chrome is non-selectable while content remains copyable', () => {
  assert.match(sidebarSource, /className="firm-sidebar"/);
  assert.match(settingsSidebarSource, /className="firm-sidebar"/);
  assert.match(consoleSource, /className="firm-console__entity-chrome"/);
  assert.match(stylesSource, /\.firm-sidebar,[\s\S]*\.firm-console__entity-chrome[\s\S]*user-select: none;/);
  assert.doesNotMatch(stylesSource, /html\.donna-desktop body \{[\s\S]{0,160}user-select: none;/);
});

test('desktop shell suppresses browser drag ghosts and scroll chaining', () => {
  assert.match(stylesSource, /html\.donna-desktop :where\(a, img\) \{[\s\S]*-webkit-user-drag: none;/);
  assert.match(stylesSource, /html\.donna-desktop \.firm-shell__main \{[\s\S]*overscroll-behavior: contain;/);
});
