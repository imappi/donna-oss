import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = (relativeUrl) => readFileSync(new URL(relativeUrl, import.meta.url), 'utf8');

test('AR-5A shared normalizer is wired through the three verified production consumers', () => {
  const manualPicker = source('./manualLinkPicker.js');
  const documentArtifact = source('../components/financials/document-artifact.jsx');
  const documentChat = source('../components/documents/document-chat.jsx');
  const artifactPanel = source('../components/financials/artifact-panel.jsx');
  const firmConsole = source('../components/FirmOpsConsole.jsx');
  assert.match(manualPicker, /import \{ normalizeUnicodeSearchKey \} from '\.\/unicodeInputNormalization\.js'/);
  assert.match(manualPicker, /normalizeUnicodeSearchKey\(value\)/);
  assert.match(documentArtifact, /buildManualLinkPickerData\(/);
  assert.match(documentArtifact, /<DocumentChat/);
  assert.match(documentChat, /buildManualLinkPickerData\(/);
  assert.match(artifactPanel, /<DocumentArtifact/);
  assert.match(firmConsole, /<ArtifactPanel/);

  const mentionResolution = source('../../server/donna/mentions/mentionResolution.js');
  const api = source('../../server/donna/api.js');
  const mentionComposer = source('../components/shared/mention-composer.jsx');
  const transactionArtifact = source('../components/financials/transaction-artifact.jsx');
  assert.match(mentionResolution, /import \{ normalizeUnicodeSearchKey \} from .*unicodeInputNormalization\.js/);
  assert.match(mentionResolution, /export const filterMentionRoster/);
  assert.match(api, /actors: filterMentionRoster\(roster, query\)/);
  assert.match(mentionComposer, /fetchMentionRoster\(\{ clientId, query: token\.query \}\)/);
  assert.match(documentChat, /useMentionComposer\(/);
  assert.match(transactionArtifact, /useMentionComposer\(/);

  const ownerInvoice = source('../../server/donna/ownerInvoiceCommand.js');
  const inbound = source('../../server/donna/channels/inboundCore.js');
  assert.match(ownerInvoice, /import \{ normalizeUnicodeNumericText \} from .*unicodeInputNormalization\.js/);
  assert.match(ownerInvoice, /const text = normalizeUnicodeNumericText\(messageText\)/);
  assert.match(inbound, /await maybeRunOwnerInvoiceCommand\(/);
});

test('AR-5A does not count dormant account pickers as production coverage', () => {
  const donnaPanel = source('../components/financials/donna-financials-panel.jsx');
  const legacyFinancialsView = source('../components/financials/financials-view.jsx');
  const firmConsole = source('../components/FirmOpsConsole.jsx');

  assert.match(donnaPanel, /function GhostPicker\(/, 'the intentionally retained legacy definition is visible');
  assert.doesNotMatch(donnaPanel, /<GhostPicker\b/, 'GhostPicker has no mounted render site');
  assert.doesNotMatch(donnaPanel, /unicodeInputNormalization/, 'dormant GhostPicker is outside AR-5A');
  assert.match(legacyFinancialsView, /function CategoryAutocomplete\(/);
  assert.doesNotMatch(legacyFinancialsView, /unicodeInputNormalization/,
    'the unmounted CategoryAutocomplete is outside AR-5A');
  assert.match(firmConsole,
    /import \{ buildDocumentArtifactData \} from '\.\/financials\/financials-view\.jsx'/,
    'the live console imports only the named artifact-data helper, not the legacy default UI');
  assert.doesNotMatch(firmConsole, /import FinancialsView from/);
});
