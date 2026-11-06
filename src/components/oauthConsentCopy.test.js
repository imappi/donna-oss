// Copy-rail pins for the chat-surface consent page (/oauth/consent —
// OAuthConsentPage.jsx; docs/design-donna-chatgpt-app-build-brief.md §4.2/§8).
//
// The rails: bridge register (tool results reach the chat host's model
// provider — said plainly), NO custody slogans (2026-08-11), the surface's
// verbs stated as enforcement facts (the five reads, ask Donna, confirm one
// proposal on the owner's say-so; cannot post/approve/file/send anything
// else; per-business consent; audit receipt), no prices, and no promise the
// product does not keep (the revoke path named is the real one: the consent
// screen, "AI chat access" since the hosted surface's slice 4). The route is
// wired into the mounted App (wire-into-the-mounted-surface rail).
// (Source-text pins, like claudeExtensionCopy.test.js — node:test cannot
// import JSX.)
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./OAuthConsentPage.jsx', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../App.jsx', import.meta.url), 'utf8');
// Copy only: the JSX after the component's helpers (comments above may name
// the forbidden patterns while documenting the rail).
const copy = source.slice(source.indexOf('const SignInCard'));

test('the route is mounted in App and intercepted before the firm gate', () => {
  assert.match(appSource, /import OAuthConsentPage, \{ isOAuthConsentPath \}/);
  assert.match(appSource, /if \(isOAuthConsentRoute\(\)\) \{\s*return <OAuthConsentPage \/>;/);
  assert.ok(
    appSource.indexOf('if (isOAuthConsentRoute())') < appSource.indexOf('if (firmMode && firmAccessStatus !== \'ready\')'),
    'consent renders before the firm auth gate can claim the route'
  );
  assert.match(source, /clean === CONSENT_PATH/);
  assert.match(source, /const CONSENT_PATH = '\/oauth\/consent'/);
});

test('data posture stated plainly, no custody slogans, no prices', () => {
  assert.match(copy, /sent to \{clientName\}’s model provider/);
  assert.doesNotMatch(copy, /never leaves?|stays? on (this|your) (machine|office)|100% private/i);
  assert.doesNotMatch(copy, /[$£€]\s?\d|\d+\s?(\/|per\s)(mo|month|year|yr)/i);
});

test('the surface’s verbs stated as enforcement facts: five reads, ask, confirm on the owner’s say-so; cannot post/approve/file/send anything else; per-business consent; audit receipt', () => {
  assert.match(copy, /wants to talk to Donna about your books/);
  assert.match(copy, /see close status and what is blocking the close/);
  assert.match(copy, /ask Donna about the books, in your words/);
  assert.match(copy, /confirm an answer she proposed, only when you say so, through the same tracked path as the Confirm button/);
  assert.match(copy, /cannot post, approve, file or send anything else/);
  assert.match(copy, /Settings → AI chat access/);
  assert.doesNotMatch(copy, /Settings → Claude access/, 'the menu label generalized in slice 4');
  assert.match(copy, /written to Donna’s audit trail, naming \{clientName\} as the door/);
  // No capability words beyond the registry's verbs.
  assert.doesNotMatch(copy, /will (draft|send|post|file|approve|chase|pay)/i);
});

test('names the real revoke path, not a screen that does not exist', () => {
  assert.match(copy, /remove Donna from the chat app or switch the business off under Settings → AI chat access/);
  assert.doesNotMatch(copy, /account settings/i);
});

test('the consent calls are the GoTrue OAuth-server endpoints, bearer-authenticated', async () => {
  const auth = await readFile(new URL('../lib/supabaseAuth.js', import.meta.url), 'utf8');
  assert.match(auth, /\/auth\/v1\/oauth\/authorizations\/\$\{id\}\$\{suffix\}/);
  assert.match(auth, /const suffix = method === 'POST' \? '\/consent' : ''/);
  assert.match(auth, /action !== 'approve' && action !== 'deny'/);
});
