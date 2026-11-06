// INT-1 (ledger integrations finish plan): a dead refresh token must flip the
// connection row to 'expired' and throw a named re-auth error — never leave
// the row resting at 'connected' while every sync/push fails. Pure-core tests:
// fake DB client + stubbed globalThis.fetch, no live DB, no live Xero/QBO.
// The best-effort status write inside the catch goes through queryFirmDb
// (separate pool) and is swallowed when no DATABASE_URL is configured — these
// tests assert the thrown error contract, and the update-SQL assertions run
// against the injected client on the success path.

process.env.XERO_CLIENT_ID = process.env.XERO_CLIENT_ID || 'test-xero-client';
process.env.XERO_CLIENT_SECRET = process.env.XERO_CLIENT_SECRET || 'test-xero-secret';
process.env.XERO_REDIRECT_URI = process.env.XERO_REDIRECT_URI || 'https://example.test/api/donna/firms/xero/callback';
process.env.QBO_CLIENT_ID = process.env.QBO_CLIENT_ID || 'test-qbo-client';
process.env.QBO_CLIENT_SECRET = process.env.QBO_CLIENT_SECRET || 'test-qbo-secret';
process.env.QBO_REDIRECT_URI = process.env.QBO_REDIRECT_URI || 'https://example.test/api/donna/firms/qbo/callback';
process.env.HMRC_CLIENT_ID = process.env.HMRC_CLIENT_ID || 'test-hmrc-client';
process.env.HMRC_CLIENT_SECRET = process.env.HMRC_CLIENT_SECRET || 'test-hmrc-secret';
process.env.HMRC_REDIRECT_URI = process.env.HMRC_REDIRECT_URI || 'https://example.test/api/donna/firms/hmrc/callback';
process.env.HMRC_TOKEN_KEY = process.env.HMRC_TOKEN_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getFreshXeroConnectionForSync,
  getFreshQboConnectionForSync,
  getFreshHmrcConnectionForSync
} from './firmDb.js';
import { encryptHmrcToken } from './taxAuthorities/hmrcClient.js';

const PAST = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();

const connectionRow = (overrides = {}) => ({
  id: 'conn-1',
  status: 'connected',
  refresh_token: 'dead-refresh-token',
  access_token: 'stale-access-token',
  refresh_token_encrypted: encryptHmrcToken('dead-refresh-token'),
  access_token_encrypted: encryptHmrcToken('stale-access-token'),
  expires_at: PAST,
  ...overrides
});

// Fake DB client: first query returns the connection row; later queries
// (the post-refresh update) are recorded and echo a row back.
const fakeClient = (row) => {
  const queries = [];
  return {
    queries,
    query: async (text, params) => {
      queries.push({ text, params });
      if (queries.length === 1) return { rows: [row] };
      return { rows: [{ ...row, status: 'connected' }] };
    }
  };
};

const stubFetch = (t, responder) => {
  const original = globalThis.fetch;
  globalThis.fetch = responder;
  t.after(() => {
    globalThis.fetch = original;
  });
};

const failingTokenEndpoint = async () =>
  new Response(JSON.stringify({ error: 'invalid_grant' }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' }
  });

test('xero: refresh failure throws XERO_CONNECTION_EXPIRED with statusCode 401', async (t) => {
  stubFetch(t, failingTokenEndpoint);
  const client = fakeClient(connectionRow());
  await assert.rejects(
    getFreshXeroConnectionForSync({ client, firmId: 'firm-1', clientId: 'client-1' }),
    (error) => {
      assert.equal(error.code, 'XERO_CONNECTION_EXPIRED');
      assert.equal(error.statusCode, 401);
      assert.ok(error.cause, 'carries the underlying refresh error as cause');
      return true;
    }
  );
  // The injected client saw only the select — the honesty flip rides a
  // separate connection so a caller's rollback can't undo it.
  assert.equal(client.queries.length, 1);
});

test('qbo: refresh failure throws QBO_CONNECTION_EXPIRED with statusCode 401', async (t) => {
  stubFetch(t, failingTokenEndpoint);
  const client = fakeClient(connectionRow());
  await assert.rejects(
    getFreshQboConnectionForSync({ client, firmId: 'firm-1', clientId: 'client-1' }),
    (error) => {
      assert.equal(error.code, 'QBO_CONNECTION_EXPIRED');
      assert.equal(error.statusCode, 401);
      return true;
    }
  );
  assert.equal(client.queries.length, 1);
});

test('hmrc: refresh failure throws HMRC_CONNECTION_EXPIRED with statusCode 401', async (t) => {
  stubFetch(t, failingTokenEndpoint);
  const client = fakeClient(connectionRow({ status: 'active' }));
  await assert.rejects(
    getFreshHmrcConnectionForSync({ client, firmId: 'firm-1', clientId: 'client-1' }),
    (error) => {
      assert.equal(error.code, 'HMRC_CONNECTION_EXPIRED');
      assert.equal(error.statusCode, 401);
      return true;
    }
  );
  assert.equal(client.queries.length, 1);
});

test('hmrc: non-invalid_grant refresh failure throws refresh-failed without expiring grant', async (t) => {
  stubFetch(t, async () =>
    new Response(JSON.stringify({ error: 'server_error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  );
  const client = fakeClient(connectionRow({ status: 'active' }));
  await assert.rejects(
    getFreshHmrcConnectionForSync({ client, firmId: 'firm-1', clientId: 'client-1' }),
    (error) => {
      assert.equal(error.code, 'HMRC_CONNECTION_REFRESH_FAILED');
      assert.equal(error.statusCode, 500);
      return true;
    }
  );
  assert.equal(client.queries.length, 1);
});

test('xero: successful refresh updates the row back to connected', async (t) => {
  stubFetch(t, async () =>
    new Response(
      JSON.stringify({
        access_token: 'fresh-access',
        refresh_token: 'fresh-refresh',
        token_type: 'Bearer',
        expires_in: 1800,
        scope: 'accounting.settings'
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  );
  const client = fakeClient(connectionRow());
  const result = await getFreshXeroConnectionForSync({ client, firmId: 'firm-1', clientId: 'client-1' });
  assert.equal(result.status, 'connected');
  const update = client.queries[1];
  assert.match(update.text, /set status = 'connected'/);
  assert.match(update.text, /last_error = null/);
});

test('qbo: fresh token short-circuits without any network call', async (t) => {
  stubFetch(t, async () => {
    throw new Error('fetch must not be called when the token is still fresh');
  });
  const client = fakeClient(connectionRow({ expires_at: FUTURE }));
  const result = await getFreshQboConnectionForSync({ client, firmId: 'firm-1', clientId: 'client-1' });
  assert.equal(result.id, 'conn-1');
  assert.equal(client.queries.length, 1);
});

test('hmrc: successful refresh encrypts rotated tokens and updates row back to active', async (t) => {
  stubFetch(t, async () =>
    new Response(
      JSON.stringify({
        access_token: 'fresh-hmrc-access',
        refresh_token: 'fresh-hmrc-refresh',
        token_type: 'bearer',
        expires_in: 14400,
        scope: 'read:vat write:vat'
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  );
  const client = fakeClient(connectionRow({ status: 'active' }));
  const result = await getFreshHmrcConnectionForSync({ client, firmId: 'firm-1', clientId: 'client-1' });
  assert.equal(result.status, 'connected');
  const update = client.queries[1];
  assert.match(update.text, /set status = 'active'/);
  assert.match(update.text, /access_token_encrypted = \$4/);
  assert.notEqual(update.params[3], 'fresh-hmrc-access');
  assert.notEqual(update.params[4], 'fresh-hmrc-refresh');
});
