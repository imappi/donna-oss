import test from 'node:test';
import assert from 'node:assert/strict';

import { downloadTelegramMedia, TELEGRAM_INBOUND_COPY } from './telegramInbound.js';

// The Donna voice rule (clientPortalChat.js system prompt, held for static
// channel copy too, Kari 2026-07-21): never an em or en dash. This pin keeps
// the whole copy object honest, including function-valued entries.
test('telegram inbound copy never uses em or en dashes', () => {
  for (const [key, value] of Object.entries(TELEGRAM_INBOUND_COPY)) {
    const text = typeof value === 'function' ? value('Sample Client Oy') : String(value);
    assert.doesNotMatch(text, /—|–/, `copy key "${key}" violates the Donna voice rule`);
  }
});

// Telegram's file CDN serves photos as application/octet-stream regardless of
// content; the evidence bucket's MIME allowlist refuses that generic type with
// 415. These pins drive the REAL download function with a stubbed fetch so the
// mime-resolution guard cannot regress silently (the 2026-07-20 silent-photo
// bug: docs/donna-telegram-receipt-silence-diagnostic.md §7).

const stubFetch = ({ contentType }) => async (url) => {
  if (String(url).includes('/getFile')) {
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { file_path: 'photos/file_38.jpg' } }) };
  }
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? contentType : null) }
  };
};

const env = { TELEGRAM_BOT_TOKEN: 'test-token' };

test('generic octet-stream CDN header never shadows the descriptor mime (the 415 bug)', async () => {
  const media = await downloadTelegramMedia({
    mediaId: 'file-id',
    env,
    fetchImpl: stubFetch({ contentType: 'application/octet-stream' }),
    descriptor: { kind: 'image', mimeType: 'image/jpeg' }
  });
  assert.equal(media.mimeType, 'image/jpeg');
});

test('a specific CDN header wins over the descriptor, with parameters stripped', async () => {
  const media = await downloadTelegramMedia({
    mediaId: 'file-id',
    env,
    fetchImpl: stubFetch({ contentType: 'image/webp; charset=binary' }),
    descriptor: { kind: 'image', mimeType: 'image/jpeg' }
  });
  assert.equal(media.mimeType, 'image/webp');
});

test('no header and no descriptor still falls back to octet-stream', async () => {
  const media = await downloadTelegramMedia({
    mediaId: 'file-id',
    env,
    fetchImpl: stubFetch({ contentType: null })
  });
  assert.equal(media.mimeType, 'application/octet-stream');
});
