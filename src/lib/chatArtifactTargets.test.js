import assert from 'node:assert/strict';
import test from 'node:test';

import { documentTargetForAction, financialReportTargetForAction } from './chatArtifactTargets.js';

test('firm-Inbox financial actions retain their own venture target', () => {
  assert.deepEqual(
    financialReportTargetForAction({
      type: 'open_financials',
      client_id: 'honeybee',
      client_name: 'Honeybee Hills Apiary LLC',
      period: '2025-08'
    }, null),
    { clientId: 'honeybee', clientName: 'Honeybee Hills Apiary LLC', period: '2025-08' }
  );
});

test('venture-local actions inherit the mounted venture and malformed periods do not pass through', () => {
  assert.deepEqual(
    financialReportTargetForAction({ type: 'open_financials', period: 'latest' }, 'cactus'),
    { clientId: 'cactus', clientName: null, period: null }
  );
  assert.deepEqual(
    documentTargetForAction({ type: 'open_document', document_id: 'document-1' }, 'cactus'),
    { clientId: 'cactus', documentId: 'document-1' }
  );
});
