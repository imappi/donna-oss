import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DATABASE_URL ||= 'postgres://localhost:5432/donna-desktop-principal-test';

const { resolveDesktopClientCreationPrincipal } = await import('./firmDb.js');

const tokenPrincipal = {
  principalType: 'access_token',
  principalId: 'access-token',
  unrestricted: true,
};

test('desktop access token resolves to the sole active owner for a client-create receipt', async () => {
  const queries = [];
  const resolved = await resolveDesktopClientCreationPrincipal({
    firmId: 'firm-1',
    principal: tokenPrincipal,
    desktopHost: true,
    queryFn: async (sql, params) => {
      queries.push({ sql, params });
      return { rows: [{
        id: 'member-owner', user_id: 'user-owner', email: 'owner@example.invalid',
        role: 'admin', access_level: 'owner', status: 'active',
      }] };
    },
  });
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].params, ['firm-1']);
  assert.equal(resolved.principalType, 'firm_member');
  assert.equal(resolved.principalId, 'member-owner');
  assert.equal(resolved.authenticatedVia, 'desktop_access_token');
});

test('desktop client creation refuses ambiguous members instead of guessing an actor', async () => {
  await assert.rejects(
    resolveDesktopClientCreationPrincipal({
      firmId: 'firm-1',
      principal: tokenPrincipal,
      desktopHost: true,
      queryFn: async () => ({ rows: [
        { id: 'member-1', access_level: 'owner' },
        { id: 'member-2', access_level: 'owner' },
      ] }),
    }),
    (error) => error.code === 'CLIENT_CREATION_MEMBER_AMBIGUOUS'
      && error.statusCode === 409
      && error.details.active_owners === 2,
  );
});

test('cloud and already-resolved human principals remain unchanged', async () => {
  let queried = false;
  const member = { principalType: 'firm_member', principalId: 'member-1' };
  assert.equal(await resolveDesktopClientCreationPrincipal({
    firmId: 'firm-1', principal: member, desktopHost: true,
    queryFn: async () => { queried = true; return { rows: [] }; },
  }), member);
  assert.equal(await resolveDesktopClientCreationPrincipal({
    firmId: 'firm-1', principal: tokenPrincipal, desktopHost: false,
    queryFn: async () => { queried = true; return { rows: [] }; },
  }), tokenPrincipal);
  assert.equal(queried, false);
});
