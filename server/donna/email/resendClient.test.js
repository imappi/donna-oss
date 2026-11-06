import assert from 'node:assert/strict';
import test from 'node:test';

import { sendEmail, isEmailEnabled, defaultFrom, RESEND_API_URL } from './resendClient.js';

const okResponse = (body = { id: 'email_123' }) => ({
  ok: true,
  status: 200,
  json: async () => body
});

test('isEmailEnabled reflects RESEND_API_KEY presence', () => {
  const prev = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  assert.equal(isEmailEnabled(), false);
  process.env.RESEND_API_KEY = 're_test';
  assert.equal(isEmailEnabled(), true);
  if (prev === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = prev;
});

test('skips (no throw) when the API key is unset', async () => {
  let called = false;
  const result = await sendEmail({
    to: 'a@b-com.example',
    subject: 'Hi',
    html: '<p>hi</p>',
    deps: { apiKey: '', fetchImpl: async () => { called = true; return okResponse(); } }
  });
  assert.deepEqual(result, { ok: false, skipped: true, reason: 'RESEND_NOT_CONFIGURED' });
  assert.equal(called, false);
});

test('rejects missing required fields without calling Resend', async () => {
  let called = false;
  const result = await sendEmail({
    to: 'a@b-com.example',
    subject: '',
    deps: { apiKey: 're_test', fetchImpl: async () => { called = true; return okResponse(); } }
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /requires/);
  assert.equal(called, false);
});

test('posts a well-formed request and returns the Resend id', async () => {
  let captured = null;
  const result = await sendEmail({
    to: 'owner@biz-com.example',
    subject: 'Confirm',
    html: '<p>x</p>',
    deps: {
      apiKey: 're_live',
      fetchImpl: async (url, opts) => { captured = { url, opts }; return okResponse({ id: 'email_abc' }); }
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.id, 'email_abc');
  assert.equal(captured.url, RESEND_API_URL);
  assert.equal(captured.opts.method, 'POST');
  assert.equal(captured.opts.headers.Authorization, 'Bearer re_live');
  const body = JSON.parse(captured.opts.body);
  assert.equal(body.from, defaultFrom());
  assert.deepEqual(body.to, ['owner@biz-com.example']);
  assert.equal(body.subject, 'Confirm');
  assert.equal(body.html, '<p>x</p>');
});

test('base64-encodes attachments for the Resend payload (FI-10 Finvoice XML lane)', async () => {
  let captured = null;
  const result = await sendEmail({
    to: 'lasku@asiakas-fi.example',
    subject: 'Lasku 2026001',
    text: 'Liitteenä verkkolasku.',
    attachments: [{ filename: 'finvoice-2026001.xml', content: '<Finvoice/>', contentType: 'application/xml' }],
    deps: {
      apiKey: 're_live',
      fetchImpl: async (url, opts) => { captured = { url, opts }; return okResponse({ id: 'email_att' }); }
    }
  });
  assert.equal(result.ok, true);
  const body = JSON.parse(captured.opts.body);
  assert.equal(body.attachments.length, 1);
  assert.equal(body.attachments[0].filename, 'finvoice-2026001.xml');
  assert.equal(Buffer.from(body.attachments[0].content, 'base64').toString('utf8'), '<Finvoice/>');
  assert.equal(body.attachments[0].content_type, 'application/xml');
});

test('omits the attachments key entirely when none are passed', async () => {
  let captured = null;
  await sendEmail({
    to: 'owner@biz-com.example',
    subject: 'x',
    text: 'y',
    deps: { apiKey: 're_live', fetchImpl: async (url, opts) => { captured = { url, opts }; return okResponse({ id: 'e' }); } }
  });
  assert.equal('attachments' in JSON.parse(captured.opts.body), false);
});

test('surfaces a Resend API error without throwing', async () => {
  const result = await sendEmail({
    to: 'a@b-com.example',
    subject: 'Hi',
    html: '<p>hi</p>',
    deps: {
      apiKey: 're_test',
      fetchImpl: async () => ({ ok: false, status: 422, json: async () => ({ message: 'domain not verified' }) })
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 422);
  assert.match(result.error, /domain not verified/);
});

test('surfaces a network/throw as a result, not an exception', async () => {
  const result = await sendEmail({
    to: 'a@b-com.example',
    subject: 'Hi',
    html: '<p>hi</p>',
    deps: { apiKey: 're_test', fetchImpl: async () => { throw new Error('socket hang up'); } }
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /socket hang up/);
});
