import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isSelfServeProvisioningEnabled,
  provisionClientWorkspaceForAuth
} from './selfServeProvisioning.js';

test('isSelfServeProvisioningEnabled: off by default, on only with the explicit env', () => {
  assert.equal(isSelfServeProvisioningEnabled({}), false);
  assert.equal(isSelfServeProvisioningEnabled({ DONNA_SELF_SERVE_PROVISIONING: 'false' }), false);
  assert.equal(isSelfServeProvisioningEnabled({ DONNA_SELF_SERVE_PROVISIONING: '1' }), false);
  assert.equal(isSelfServeProvisioningEnabled({ DONNA_SELF_SERVE_PROVISIONING: 'true' }), true);
});

test('delegates to the single provisioning implementation (no parallel impl here)', async () => {
  const seen = [];
  const result = await provisionClientWorkspaceForAuth({
    firmId: 'donna-production',
    auth: { type: 'supabase_user', userId: 'user-123', email: 'Founder@Acme-io.example' },
    deps: {
      provision: async (args) => {
        seen.push(args);
        return { clientId: 'client-self-abc', created: true };
      }
    }
  });

  // The wrapper passes firmId + auth straight through to the one implementation.
  assert.equal(seen.length, 1);
  assert.equal(seen[0].firmId, 'donna-production');
  assert.equal(seen[0].auth.email, 'Founder@Acme-io.example');
});

test('maps the result onto client_id (snake_case) so the App.jsx redirect fires', async () => {
  // The historic bug: this endpoint returned only `clientId` (camelCase) while
  // App.jsx reads `result.client_id`, so the /client/<id> redirect never fired.
  const result = await provisionClientWorkspaceForAuth({
    auth: { type: 'supabase_user', userId: 'u1', email: 'a@b-com.example' },
    deps: { provision: async () => ({ clientId: 'client-self-xyz', created: true }) }
  });
  assert.equal(result.client_id, 'client-self-xyz');
  assert.equal(result.clientId, 'client-self-xyz');
  assert.equal(result.provisioned, true);
});

test('a returning owner (created:false) reports provisioned:false but still carries the id', async () => {
  const result = await provisionClientWorkspaceForAuth({
    auth: { type: 'supabase_user', userId: 'u1', email: 'a@b-com.example' },
    deps: { provision: async () => ({ clientId: 'client-self-existing', created: false }) }
  });
  assert.equal(result.provisioned, false);
  assert.equal(result.client_id, 'client-self-existing');
});

test('propagates the implementation auth error (e.g. no email) instead of swallowing it', async () => {
  await assert.rejects(
    () => provisionClientWorkspaceForAuth({
      auth: { type: 'access_token' },
      deps: {
        provision: async () => {
          const error = new Error('A signed-in account is required to set up a workspace.');
          error.statusCode = 401;
          error.code = 'PROVISION_AUTH_REQUIRED';
          throw error;
        }
      }
    }),
    (error) => error.code === 'PROVISION_AUTH_REQUIRED' && error.statusCode === 401
  );
});
