import test from 'node:test';
import assert from 'node:assert/strict';

import { generateMatchExplanation } from './matchExplanation.js';

// The proactive ask-client question is sent to the business owner, so it is
// worded in the owner's language. English stays byte-identical; the firm's own
// fields (headline, explanation, reason) stay English in both.
const OUT = { id: 'tx-1', description: 'CARD KAHVILA ESIMERKKI 0042', money_out: 1234.5, money_in: 0, currency: 'EUR', transaction_date: new Date(2025, 5, 16) };
const IN = { id: 'tx-2', description: 'TRANSFER ESIMERKKI ASIAKAS OY', money_out: 0, money_in: 7500, currency: 'EUR', transaction_date: '2025-02-03' };

test('owner language — the English ask-client question is byte-identical', () => {
  const out = generateMatchExplanation({ transaction: OUT });
  assert.equal(out.proactive_ask_client.question,
    "Hi — quick check on the KAHVILA ESIMERKKI 0042 transaction on 16 Jun 2025 for EUR 1234.50. Could you let me know what this was for and confirm whether it's a business expense? Thanks!");
  assert.equal(out.proactive_ask_client.reason, 'No matching vendor pattern or supporting document — client confirmation recommended.');
  assert.deepEqual(generateMatchExplanation({ transaction: OUT, language: 'en' }), out);
  assert.equal(generateMatchExplanation({ transaction: IN }).proactive_ask_client.question,
    "Hi — quick check on the ESIMERKKI ASIAKAS OY transaction on 03 Feb 2025 for EUR 7500.00. Could you let me know what this was for and confirm whether it's business income? Thanks!");
});

test('owner language — the Finnish ask-client question, with Finnish amounts and dates', () => {
  const out = generateMatchExplanation({ transaction: OUT, language: 'fi' });
  assert.equal(out.proactive_ask_client.question,
    'Hei! Pikainen tarkistus tapahtumasta: KAHVILA ESIMERKKI 0042, 16.6.2025, 1234,50 EUR. Kertoisitko, mitä se koski, ja onko se yrityksen kulu? Kiitos!');
  assert.equal(out.proactive_ask_client.evidence_type, 'business_purpose');
  assert.equal(out.proactive_ask_client.reason, 'No matching vendor pattern or supporting document — client confirmation recommended.', 'the firm note stays English');
  assert.equal(out.headline, 'Uncategorized transaction', 'the firm view stays English');
  assert.equal(generateMatchExplanation({ transaction: IN, language: 'fi' }).proactive_ask_client.question,
    'Hei! Pikainen tarkistus tapahtumasta: ESIMERKKI ASIAKAS OY, 3.2.2025, 7500,00 EUR. Kertoisitko, mitä se koski, ja onko se yrityksen tuloa? Kiitos!');
  assert.equal(generateMatchExplanation({ transaction: { id: 'tx-3' }, language: 'fi' }).proactive_ask_client.question,
    'Hei! Pikainen tarkistus tästä tapahtumasta. Kertoisitko, mitä se koski, ja onko se yrityksen kulu? Kiitos!');
});

test('owner language — the case snapshot reads the client profile and words the question for a Finnish owner', async () => {
  const { getOperatorCaseSnapshot } = await import('./operatorCaseSnapshot.js');
  const snapshotFor = async (clientRow) => getOperatorCaseSnapshot({
    firmId: 'firm-1', clientId: 'client-1', focus: { type: 'transaction', id: 'tx-1' }, include: ['matches'],
    deps: {
      queryFirmDb: async (sql) => {
        if (/from transactions where/.test(sql)) return { rows: [OUT] };
        if (/from clients where/.test(sql)) return { rows: clientRow ? [clientRow] : [] };
        return { rows: [] };
      }
    }
  });
  const fi = await snapshotFor({ jurisdiction: 'FI', profile: {} });
  assert.match(fi.focus_state.explanation.proactive_ask_client.question, /^Hei! Pikainen tarkistus tapahtumasta: KAHVILA ESIMERKKI 0042, 16\.6\.2025, 1234,50 EUR\./);
  const en = await snapshotFor({ jurisdiction: 'FI', profile: { locale: 'en-GB' } });
  assert.match(en.focus_state.explanation.proactive_ask_client.question, /^Hi — quick check on the KAHVILA ESIMERKKI 0042 transaction/);
});
