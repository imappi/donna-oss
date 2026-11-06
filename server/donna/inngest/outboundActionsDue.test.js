import assert from 'node:assert/strict';
import test from 'node:test';

import { emailDeliverer } from './outboundActionsDue.js';

test('AR-4E: production due-sweep deliverer preserves text, HTML, identity and attachments', async () => {
  const calls = [];
  const attachment = {
    filename: 'invoice.pdf', contentType: 'application/pdf', content: Buffer.from('pdf')
  };
  const result = await emailDeliverer({
    recipient: 'ap@example-ae.example', subject: 'Invoice', body: 'compatibility text',
    text: 'logical text', html: '<html><body>logical text</body></html>',
    identity: { from: 'Roofline <billing@example.com>', replyTo: 'owner@example.com' },
    headers: { 'List-Unsubscribe': '<https://example.com/u>' },
    attachments: [attachment],
    send: async (message) => {
      calls.push(message);
      return { ok: true, id: 'provider-1' };
    }
  });
  assert.deepEqual(result, { providerMessageId: 'provider-1' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, 'logical text');
  assert.equal(calls[0].html, '<html><body>logical text</body></html>');
  assert.equal(calls[0].attachments[0], attachment);
  assert.equal(calls[0].from, 'Roofline <billing@example.com>');
  assert.equal(calls[0].replyTo, 'owner@example.com');
});

test('legacy body remains the text fallback when a caller has not adopted the explicit alias', async () => {
  const calls = [];
  await emailDeliverer({
    recipient: 'ap@example.com', subject: 'Reminder', body: 'legacy body',
    send: async (message) => { calls.push(message); return { ok: true, id: 'provider-2' }; }
  });
  assert.equal(calls[0].text, 'legacy body');
  assert.equal('html' in calls[0], false);
});
