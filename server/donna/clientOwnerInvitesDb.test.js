import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildClientOwnerInviteEmail,
  principalMayAdministerClientOwner,
  sendClientOwnerInviteEmail,
  hashOwnerInviteToken,
  acceptClientOwnerInviteInDb,
  principalIsFirmInvitedOwnerInDb
} from './clientOwnerInvitesDb.js';
import { validateClientOwnerInvite } from './seatModel.js';

test('only the firm-side owner shapes administer a client owner; a portal owner or a seat never does', () => {
  assert.equal(principalMayAdministerClientOwner({ principalType: 'firm_member', unrestricted: true }), true);
  assert.equal(principalMayAdministerClientOwner({ principalType: 'access_token', unrestricted: true }), true);
  assert.equal(principalMayAdministerClientOwner({ principalType: 'firm_collaborator', role: 'owner', unrestricted: false }), false);
  assert.equal(principalMayAdministerClientOwner({ principalType: 'firm_collaborator', role: 'partner', seatRole: 'partner' }), false);
  assert.equal(principalMayAdministerClientOwner({ principalType: 'firm_member' }), false, 'unrestricted must be explicit');
  assert.equal(principalMayAdministerClientOwner(null), false);
});

test('invite validation normalizes the email and accepts only fi/en', () => {
  assert.deepEqual(validateClientOwnerInvite({ name: ' A Person ', email: ' Owner@Example.Invalid ', language: 'FI' }),
    { ok: true, normalized: { name: 'A Person', email: 'owner@example.invalid', language: 'fi' } });
  assert.equal(validateClientOwnerInvite({ name: 'A', email: 'a@b.invalid', language: '' }).normalized.language, null);
  assert.equal(validateClientOwnerInvite({ name: '', email: 'a@b.invalid' }).code, 'name_required');
  assert.equal(validateClientOwnerInvite({ name: 'A', email: 'nope' }).code, 'email_invalid');
  assert.equal(validateClientOwnerInvite({ name: 'A', email: 'a@b.invalid', language: 'sv' }).code, 'language_invalid');
});

test('the email is in the firm name, informal Finnish for fi, and escapes every interpolated value', () => {
  const fi = buildClientOwnerInviteEmail({ firmName: 'Tilitoimisto Esimerkki', companyName: 'Esimerkki Oy', ownerName: 'Synthetic Owner',
    email: 'owner@example.invalid', link: 'https://app.invalid/owner-invite?token=abc', expiresAt: '2026-11-23T10:00:00Z', language: 'fi' });
  assert.equal(fi.subject, 'Tilitoimisto Esimerkki kutsuu sinut Donnaan');
  assert.match(fi.html, /Hei Synthetic Owner/);
  assert.match(fi.html, /Kirjaudu sisään tai luo tunnus/);
  assert.match(fi.html, /23\. marraskuuta 2026/);
  assert.doesNotMatch(fi.html, /\bTe\b|teidän|Teidät/, 'sinä form, never the formal Te');
  const en = buildClientOwnerInviteEmail({ firmName: 'Books & Co', companyName: '<script>x</script>', ownerName: 'A "B"',
    email: 'a@b.invalid', link: 'https://app.invalid/owner-invite?token=x', expiresAt: '2026-11-23T10:00:00Z', language: 'en' });
  assert.equal(en.subject, 'Books & Co has invited you to Donna');
  assert.match(en.html, /Books &amp; Co/);
  assert.match(en.html, /&lt;script&gt;/);
  assert.doesNotMatch(en.html, /<script>/);
});

test('the invite email skips loudly without a provider or a public origin, and never sends a dead link', async () => {
  const invite = { name: 'A', email: 'a@b.invalid', expires_at: '2026-11-23T00:00:00Z' };
  let calls = 0;
  const sendEmail = async () => { calls += 1; return { ok: true }; };
  assert.equal((await sendClientOwnerInviteEmail({ invite, token: 't', deps: { sendEmail, env: {} } })).reason, 'resend_not_configured');
  assert.equal((await sendClientOwnerInviteEmail({ invite, token: 't', deps: { sendEmail, env: { RESEND_API_KEY: 'k' } } })).reason, 'public_origin_not_configured');
  assert.equal(calls, 0);
  let captured;
  const result = await sendClientOwnerInviteEmail({ invite, token: 'tok_1', firmName: 'F', language: 'en',
    deps: { sendEmail: async (m) => { captured = m; return { ok: true }; }, env: { RESEND_API_KEY: 'k', PUBLIC_APP_URL: 'https://app.invalid/' } } });
  assert.equal(result.status, 'sent');
  assert.match(captured.html, /https:\/\/app\.invalid\/owner-invite\?token=tok_1/);
});

test('acceptance needs a signed-in person and a well-formed link before any database read', async () => {
  const deps = { withFirmDbClient: async () => { throw new Error('must not reach the database'); } };
  await assert.rejects(acceptClientOwnerInviteInDb({ auth: { type: 'access_token' }, token: 'x', deps }), { statusCode: 401 });
  await assert.rejects(acceptClientOwnerInviteInDb({ auth: { type: 'supabase_user', email: 'a@b.invalid', userId: 'u' }, token: 'short', deps }),
    { statusCode: 410, code: 'CLIENT_OWNER_INVITE_INVALID' });
  assert.equal(hashOwnerInviteToken('a').length, 64);
});

test('the seat-admin fence is fail-closed for owner principals and never touches seats or members', async () => {
  const failing = { withFirmDbClient: async () => { throw new Error('db down'); } };
  assert.equal(await principalIsFirmInvitedOwnerInDb({ firmId: 'f', principal: { principalType: 'firm_collaborator', role: 'owner', principalId: 'c' }, deps: failing }), true);
  assert.equal(await principalIsFirmInvitedOwnerInDb({ firmId: 'f', principal: { principalType: 'firm_member', role: 'admin' }, deps: failing }), false);
  assert.equal(await principalIsFirmInvitedOwnerInDb({ firmId: 'f', principal: { principalType: 'firm_collaborator', role: 'partner', seatRole: 'partner' }, deps: failing }), false);
  const none = { withFirmDbClient: async (fn) => fn({ query: async () => ({ rows: [] }) }) };
  assert.equal(await principalIsFirmInvitedOwnerInDb({ firmId: 'f', principal: { principalType: 'firm_collaborator', role: 'owner', principalId: 'c' }, deps: none }), false,
    'a self-serve owner (no firm invite) keeps its seat administration');
});
