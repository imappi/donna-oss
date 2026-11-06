import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveFirmIntakeIdentity } from './clientIntakeIdentity.js';

const profile = { id: 'kampaamo-kultalanka-oy-32244558', companyName: 'Kampaamo Kultalanka Oy', uen: '3224455-8' };
const queue = [{ id: 'welcome-kultalanka', client_id: profile.id }];
const resolve = (firmId, exists = false) => resolveFirmIntakeIdentity({
  firmId, profile, queue,
  withFirmDbClientFn: (fn) => fn({ query: async (_sql, params) => {
    assert.deepEqual(params, [firmId, profile.id]);
    return { rows: exists ? [{ id: profile.id }] : [] };
  } })
});

test('new intake scopes book and queue identity to the firm, with stable retries', async () => {
  const first = await resolve('firm-a');
  const second = await resolve('firm-b');
  assert.notEqual(first.profile.id, second.profile.id);
  assert.notEqual(first.queue[0].id, second.queue[0].id);
  assert.equal(first.queue[0].client_id, first.profile.id);
  assert.equal(second.queue[0].client_id, second.profile.id);
  assert.equal(first.profile.uen, profile.uen);
  assert.deepEqual(await resolve('firm-a'), first);
});

test('same-firm legacy re-intake retains its book and queue identity', async () => {
  assert.deepEqual(await resolve('firm-a', true), { profile, queue });
});
