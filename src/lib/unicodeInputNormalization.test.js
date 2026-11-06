import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_UNICODE_INPUT_LENGTH,
  hasUnsafeBidiControls,
  normalizeUnicodeNumericText,
  normalizeUnicodeSearchKey
} from './unicodeInputNormalization.js';

test('search keys apply NFKC, remove Arabic marks/tatweel, and narrowly fold variants', () => {
  assert.equal(normalizeUnicodeSearchKey('إيـصَال مُؤَسَّسَة'), 'ايصال مؤسسة');
  assert.equal(normalizeUnicodeSearchKey('آفاق ٱلخليج'), 'افاق الخليج');
  assert.equal(normalizeUnicodeSearchKey('على کريم یوسف'), 'علي كريم يوسف');
  assert.equal(normalizeUnicodeSearchKey('ＦＵＬＬＷＩＤＴＨ'), 'fullwidth');
  assert.notEqual(normalizeUnicodeSearchKey('ة'), normalizeUnicodeSearchKey('ه'),
    'taa marbuta is meaning-bearing and is not folded');
});

test('code-switched references and mixed filenames keep searchable logical order', () => {
  assert.equal(
    normalizeUnicodeSearchKey('إيـصَال_Receipt_۲۰۲۶.PDF'),
    'ايصال_receipt_2026.pdf'
  );
  assert.equal(
    normalizeUnicodeSearchKey('فاتورة INV-٢٠٢٦-٠٠٤٢ / TRN ۱۰۰۲۳۴۵۶۷۸۹۰۱۲۳'),
    'فاتورة inv-2026-0042 / trn 100234567890123'
  );
  assert.equal(
    normalizeUnicodeSearchKey('IBAN AE٠٧٠٣٣١٢٣٤٥٦٧٨٩٠١٢٣٤٥٦'),
    'iban ae070331234567890123456'
  );
});

test('both Arabic digit families and Arabic separators normalize without parsing', () => {
  assert.equal(normalizeUnicodeNumericText('د.إ ١٬٥٠٠٫٢٥ AED'), 'د.إ 1,500.25 AED');
  assert.equal(normalizeUnicodeNumericText('AED ۱٬۵۰۰٫۲۵'), 'AED 1,500.25');
  assert.equal(normalizeUnicodeNumericText('١٢٣٤٥٦٧٨٩٠'), '1234567890');
  assert.equal(normalizeUnicodeNumericText('۱۲۳۴۵۶۷۸۹۰'), '1234567890');
  assert.equal(normalizeUnicodeNumericText('إ'), 'إ', 'numeric mode never folds Arabic letters');
});

test('empty input is valid while oversized input and bidi controls fail closed', () => {
  assert.equal(normalizeUnicodeSearchKey(''), '');
  assert.equal(normalizeUnicodeNumericText(''), '');
  assert.equal(normalizeUnicodeSearchKey('x'.repeat(MAX_UNICODE_INPUT_LENGTH)),
    'x'.repeat(MAX_UNICODE_INPUT_LENGTH));
  assert.equal(normalizeUnicodeSearchKey('x'.repeat(MAX_UNICODE_INPUT_LENGTH + 1)), null);
  assert.equal(normalizeUnicodeNumericText('1'.repeat(MAX_UNICODE_INPUT_LENGTH + 1)), null);

  for (const control of ['\u061C', '\u200E', '\u200F', '\u202A', '\u202E', '\u2066', '\u2069']) {
    const identifier = `AE${control}070331234567890123456`;
    assert.equal(hasUnsafeBidiControls(identifier), true, `detects U+${control.codePointAt(0).toString(16)}`);
    assert.equal(normalizeUnicodeSearchKey(identifier), null);
    assert.equal(normalizeUnicodeNumericText(identifier), null);
  }
});

test('existing Latin search and numeric comparison keys remain byte-compatible', () => {
  assert.equal(normalizeUnicodeSearchKey('  CABIFY ESP  '), 'cabify esp');
  assert.equal(normalizeUnicodeSearchKey('MAY  RETAINER!'), 'may  retainer!');
  assert.equal(normalizeUnicodeSearchKey('FI/GB/US INV-2026-42'), 'fi/gb/us inv-2026-42');
  assert.equal(normalizeUnicodeNumericText('pay $1,500.00 USD'), 'pay $1,500.00 USD');
});
