import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

const consoleSource = read('../components/FirmOpsConsole.jsx');
const feedSource = read('../components/financials/donna-financials-panel.jsx');
const askSource = read('../components/financials/ask-batch-panel.jsx');
const appSource = read('../App.jsx');
const preloadSource = read('../../desktop/preload.cjs');
const mainSource = read('../../desktop/main.mjs');

test('the client menu contains only lifecycle, useful read, and real profile destinations', () => {
  assert.match(consoleSource, /id: 'overview',[\s\S]*firm\.menu\.overview/);
  assert.match(feedSource, /\{ id: 'aging', label: intl\.formatMessage\(\{ id: 'mounted\.financial\.tabs\.aging' \}\) \}/);
  assert.match(consoleSource, /\{ key: 'profile', labelId: 'firm\.menu\.profile' \}/);
  assert.match(consoleSource, /\{ key: 'people', labelId: 'firm\.menu\.people' \}/);
  assert.match(consoleSource, /id: 'portal',[\s\S]*firm\.menu\.openPortal/);

  for (const obsolete of [
    /\{ id: 'facts', label: 'Facts' \}/,
    /\{ id: 'resolved', label: 'Resolved'/,
    /\{ id: 'recent', label: 'Recent' \}/,
    /\{ key: 'compliance', label: 'Compliance' \}/,
    /\{ key: 'reverse', label: 'Reverse' \}/
  ]) {
    assert.doesNotMatch(feedSource + consoleSource, obsolete);
  }
  assert.doesNotMatch(askSource, /label: liveDraft \? 'Re-draft message' : 'Draft message'/);
  assert.doesNotMatch(consoleSource, /actionsMenu|onRegisterMenu/);
});

test('real statutory return destinations remain conditional, not discarded as menu tails', () => {
  assert.match(feedSource, /annualReturnAvailable[\s\S]*\{ id: 'veroilmoitus', label: intl\.formatMessage\(\{ id: 'mounted\.financial\.tabs\.annualReturn' \}\) \}/);
  assert.match(feedSource, /alvReturnAvailable[\s\S]*\{ id: 'alv', label: intl\.formatMessage\(\{ id: 'mounted\.financial\.tabs\.vatReturn' \}\) \}/);
});

test('desktop portal preview leaves Electron and uses the narrow main-process bridge', () => {
  assert.match(consoleSource, /openClientPortal\(\{ clientId: selectedClient\.id \}\)/);
  assert.doesNotMatch(consoleSource, /window\.location\.assign/);
  assert.match(preloadSource, /clientPortal:[\s\S]*open: \(clientId\) => ipcRenderer\.invoke\('donna:client-portal:open'/);
  assert.match(mainSource, /createPortalPreviewServer/);
  assert.match(mainSource, /await shell\.openExternal\(url\)/);
  assert.doesNotMatch(appSource, /Back to the firm workspace \(client-portal preview\)/);
  assert.match(appSource, /hasStoredAuth\(\) \|\| hasDesktopRuntimeAccess\(\)/);
});
