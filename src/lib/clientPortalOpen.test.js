import test from 'node:test';
import assert from 'node:assert/strict';

import { clientPortalPath, openClientPortal } from './clientPortalOpen.js';

test('client portal path encodes one selected client identity', () => {
  assert.equal(clientPortalPath('client/a'), '/client/client%2Fa');
  assert.equal(clientPortalPath(''), null);
});

test('desktop delegates only the client identity to the shell bridge', async () => {
  const calls = [];
  const result = await openClientPortal({
    clientId: 'client-1',
    desktopBridge: { open: async (clientId) => { calls.push(clientId); return { ok: true }; } },
    location: { origin: 'donna://app' },
    openWindow: () => { throw new Error('window.open must not run in Electron'); }
  });
  assert.deepEqual(calls, ['client-1']);
  assert.deepEqual(result, { host: 'desktop', url: null });
});

test('web opens an absolute same-origin portal URL in a new browser tab', async () => {
  const calls = [];
  const result = await openClientPortal({
    clientId: 'client-1',
    desktopBridge: null,
    location: { origin: 'https://app.example' },
    openWindow: (...args) => { calls.push(args); return {}; }
  });
  assert.deepEqual(calls, [['https://app.example/client/client-1', '_blank', 'noopener,noreferrer']]);
  assert.deepEqual(result, { host: 'web', url: 'https://app.example/client/client-1' });
});

test('bridge refusal and popup blocking fail loudly', async () => {
  await assert.rejects(
    openClientPortal({ clientId: 'client', desktopBridge: { open: async () => ({ ok: false, error: 'Preview unavailable.' }) } }),
    /Preview unavailable/
  );
  await assert.rejects(
    openClientPortal({ clientId: 'client', desktopBridge: null, location: { origin: 'https://app.example' }, openWindow: () => null }),
    /blocked/
  );
});
