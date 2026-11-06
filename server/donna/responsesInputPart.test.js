// Pins for the Responses-API input-part selection (2026-07-21
// Telegram receipt incident): images MUST go through `input_image`,
// PDFs MUST stay on `input_file` byte-identically to the pre-helper
// construction, and magic bytes outrank the declared mime. Pure
// module — runs with no dependencies via `node --test`.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildResponsesDocumentPart, __sniffMimeFromBase64 } from './responsesInputPart.js';

// Real magic-byte prefixes, base64-encoded from the on-disk signatures.
const JPEG_B64 = '/9j/4AAQSkZJRgABAQAAAQ'; // ÿØÿà …JFIF
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUg'; // .PNG....
const GIF_B64 = 'R0lGODlhAQABAAAAACw'; // GIF89a
// "RIFF" + 4 size bytes + "WEBP" → chars 12-15 are always 'RUJQ'.
const WEBP_B64 = Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ', 'binary').toString('base64');
const WAV_B64 = Buffer.from('RIFF\u0000\u0000\u0000\u0000WAVEfmt ', 'binary').toString('base64');
const PDF_B64 = Buffer.from('%PDF-1.7\n%rest', 'binary').toString('base64');

test('jpeg data URL routes to input_image, URL passed through unchanged', () => {
  const dataUrl = `data:image/jpeg;base64,${JPEG_B64}`;
  const part = buildResponsesDocumentPart({ dataUrl, filename: 'file_11.jpg' });
  assert.deepEqual(part, { type: 'input_image', image_url: dataUrl });
});

test('png / gif / webp data URLs route to input_image', () => {
  for (const [mime, b64] of [
    ['image/png', PNG_B64],
    ['image/gif', GIF_B64],
    ['image/webp', WEBP_B64]
  ]) {
    const dataUrl = `data:${mime};base64,${b64}`;
    const part = buildResponsesDocumentPart({ dataUrl, filename: 'x' });
    assert.equal(part.type, 'input_image', mime);
    assert.equal(part.image_url, dataUrl, mime);
  }
});

test('pdf stays on input_file byte-identically (filename fallback included)', () => {
  const dataUrl = `data:application/pdf;base64,${PDF_B64}`;
  assert.deepEqual(
    buildResponsesDocumentPart({ dataUrl, filename: 'inv.pdf', fallbackFilename: 'receipt.pdf' }),
    { type: 'input_file', filename: 'inv.pdf', file_data: dataUrl }
  );
  assert.deepEqual(
    buildResponsesDocumentPart({ dataUrl, filename: '', fallbackFilename: 'receipt.pdf' }),
    { type: 'input_file', filename: 'receipt.pdf', file_data: dataUrl }
  );
});

test('jpeg mislabeled application/pdf still reaches the image lane, mime rewritten', () => {
  // The octet-stream era: dataUrl builders default a missing mime to
  // application/pdf, but the bytes are a photo.
  const part = buildResponsesDocumentPart({
    dataUrl: `data:application/pdf;base64,${JPEG_B64}`,
    filename: 'photo.bin'
  });
  assert.deepEqual(part, {
    type: 'input_image',
    image_url: `data:image/jpeg;base64,${JPEG_B64}`
  });
});

test('pdf mislabeled image/* stays on the file lane (magic bytes win)', () => {
  const dataUrl = `data:image/jpeg;base64,${PDF_B64}`;
  assert.deepEqual(
    buildResponsesDocumentPart({ dataUrl, filename: 'scan.jpg' }),
    { type: 'input_file', filename: 'scan.jpg', file_data: dataUrl }
  );
});

test('declared image with unrecognised bytes (e.g. HEIC) goes to the image lane as declared', () => {
  const dataUrl = 'data:image/heic;base64,AAAAGGZ0eXBoZWlj';
  assert.deepEqual(
    buildResponsesDocumentPart({ dataUrl, filename: 'IMG_1.heic' }),
    { type: 'input_image', image_url: dataUrl }
  );
});

test('unrecognised non-image stays on input_file (no behavior change)', () => {
  const dataUrl = 'data:application/octet-stream;base64,AAAA';
  assert.deepEqual(
    buildResponsesDocumentPart({ dataUrl, filename: '' , fallbackFilename: 'document.pdf' }),
    { type: 'input_file', filename: 'document.pdf', file_data: dataUrl }
  );
});

test('sniffer: RIFF requires the WEBP tag — WAV is not an image', () => {
  assert.equal(__sniffMimeFromBase64(WEBP_B64), 'image/webp');
  assert.equal(__sniffMimeFromBase64(WAV_B64), null);
  assert.equal(__sniffMimeFromBase64(PDF_B64), 'application/pdf');
  assert.equal(__sniffMimeFromBase64(''), null);
});

test('malformed / empty data URL degrades to input_file', () => {
  for (const dataUrl of ['', 'not-a-data-url', 'data:image/jpeg']) {
    const part = buildResponsesDocumentPart({ dataUrl, filename: 'f.pdf' });
    assert.equal(part.type, 'input_file', JSON.stringify(dataUrl));
  }
});
