// Sending identity + unsubscribe plumbing (M1, G8 — D7). Pins:
//   - the From ADDRESS always stays on the Resend-verified domain; only the
//     DISPLAY name is per-customer, sanitized against header injection —
//     the customer's domain is never impersonated;
//   - owner reply-to resolves through the billing ladder (email →
//     contact_email → owner_email → null keeps the monitored default);
//   - unsubscribe/approval URLs need BOTH a base URL and a token — either
//     missing yields null (and the executor's render then refuses, so a
//     reminder never ships a dead link);
//   - one-click unsubscribe headers match the marketing rail's shape.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCounterpartyFrom, resolveOwnerReplyTo, outboundPublicBaseUrl,
  buildOutboundUnsubscribeUrl, buildOutboundApprovalUrl,
  buildUnsubscribeHeaders, buildCounterpartySendingIdentity
} from './sendingIdentity.js';

test('From keeps the verified-domain address; display name is the customer, sanitized', () => {
  const from = buildCounterpartyFrom({ ownerBusinessName: 'Roofline Co' });
  assert.match(from, /^"Roofline Co via Donna" <.+@.+>$/);
  assert.ok(from.includes('updates.donnamail.example'), 'address stays on the verified domain');

  const injected = buildCounterpartyFrom({ ownerBusinessName: 'Evil"<evil@attacker-com.example>\r\nBcc: x' });
  const display = (injected.match(/^"([^"]*)" </) || [])[1];
  assert.ok(display !== undefined, 'display stays a single quoted string');
  assert.ok(!/[<>"@\r\n]/.test(display), 'display name cannot form an addr-spec or extra headers');
  assert.ok(!/[\r\n]/.test(injected), 'no header injection');
  assert.ok(injected.includes('updates.donnamail.example'));

  const empty = buildCounterpartyFrom({});
  assert.ok(empty.includes('updates.donnamail.example'), 'no name falls back to the plain default');
});

test('owner reply-to resolves through the billing ladder', () => {
  assert.equal(resolveOwnerReplyTo({ email: 'kari@books.example' }), 'kari@books.example');
  assert.equal(resolveOwnerReplyTo({ contact_email: 'owner@roofline-co.example' }), 'owner@roofline-co.example');
  assert.equal(resolveOwnerReplyTo({ owner_email: 'o@x-com.example' }), 'o@x-com.example');
  assert.equal(resolveOwnerReplyTo({}), null);
  assert.equal(resolveOwnerReplyTo(null), null);
});

test('URLs require base + token; base URL env falls back to the marketing rail knob', () => {
  assert.equal(
    buildOutboundUnsubscribeUrl('https://donna.test/', 'tok-1'),
    'https://donna.test/api/donna/outbound/unsubscribe?token=tok-1'
  );
  assert.equal(buildOutboundUnsubscribeUrl('', 'tok-1'), null);
  assert.equal(buildOutboundUnsubscribeUrl('https://donna.test', ''), null);
  assert.equal(
    buildOutboundApprovalUrl('https://donna.test', 'tok-2', 'decline'),
    'https://donna.test/api/donna/outbound/approval?token=tok-2&decision=decline'
  );
  assert.equal(outboundPublicBaseUrl({ PUBLIC_APP_URL: 'https://app.test', OUTBOUND_PUBLIC_BASE_URL: 'https://a.test' }), 'https://app.test');
  assert.equal(outboundPublicBaseUrl({ OUTBOUND_PUBLIC_BASE_URL: 'https://a.test' }), 'https://a.test');
  assert.equal(outboundPublicBaseUrl({ MARKETING_PUBLIC_BASE_URL: 'https://b.test' }), 'https://b.test');
  assert.equal(outboundPublicBaseUrl({}), '');
});

test('one-click unsubscribe headers match the marketing rail shape', () => {
  const headers = buildUnsubscribeHeaders('https://donna.test/u?token=t');
  assert.equal(headers['List-Unsubscribe'], '<https://donna.test/u?token=t>');
  assert.equal(headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.deepEqual(buildUnsubscribeHeaders(null), {});
});

test('the composed identity carries from + replyTo', () => {
  const identity = buildCounterpartySendingIdentity({
    ownerBusinessName: 'Roofline Co', profile: { email: 'kari@roofline-co.example' }
  });
  assert.match(identity.from, /Roofline Co via Donna/);
  assert.equal(identity.replyTo, 'kari@roofline-co.example');
});
