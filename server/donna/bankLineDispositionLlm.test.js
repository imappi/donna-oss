// Bank-line disposition: the needs-human owner question in the owner's
// language (preferredOwnerTemplateLanguage). Mock-pg + recorded-provider
// fetch (synthetic bytes); no live model call, no database.

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildNeedsHumanOwnerQuestion, runBankLineDispositionForTransaction } from './bankLineDispositionLlm.js';

const makeMockClient = (responses = []) => {
  const calls = [];
  const reserved = [...responses];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const text = String(sql).trim().toLowerCase();
      const idx = reserved.findIndex((r) => text.includes(r.match));
      if (idx !== -1) {
        const [response] = reserved.splice(idx, 1);
        return { rows: response.rows || [], rowCount: (response.rows || []).length };
      }
      return { rows: [], rowCount: 0 };
    }
  };
};

// The recorded provider reply: a judgment needs_human (synthetic).
const NEEDS_HUMAN = {
  disposition: 'needs_human', line_identified: false, materiality: 'material',
  expense_kind: 'unknown', confidence: 0.4, reasoning: 'The counterparty is not one the firm knows.'
};
const recordedProvider = (reply, bodies = []) => async (_url, init) => {
  bodies.push(JSON.parse(init.body));
  return { ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify(reply) }] }) };
};

const DEBIT = {
  id: 'tx-fi-1', money_in: null, money_out: '41.2', currency: 'EUR',
  transaction_date: '2026-05-14', description: 'KAUPPA ESIMERKKI', raw_description: '', reconciliation_status: 'unmatched'
};
const CREDIT = { ...DEBIT, id: 'tx-fi-2', money_in: '1250', money_out: null, description: 'MAKSUPALVELU ESIMERKKI' };

test('owner language — the needs-human bank-line question, in Finnish and byte-identical English', () => {
  const semantic = { reasoning: NEEDS_HUMAN.reasoning };
  assert.equal(buildNeedsHumanOwnerQuestion({ transaction: DEBIT, direction: 'money_out', semantic }),
    'We could not tell what the EUR 41.20 paid on 2026-05-14 ("KAUPPA ESIMERKKI") was for. The counterparty is not one the firm knows. Was it a business expense, what was it for, and is there a receipt or bill for it?');
  assert.equal(buildNeedsHumanOwnerQuestion({ transaction: CREDIT, direction: 'money_in', semantic }),
    'We could not tell what the EUR 1250.00 received on 2026-05-14 ("MAKSUPALVELU ESIMERKKI") was. The counterparty is not one the firm knows. What was it for — a customer payment, a payout, a loan or transfer, a refund — and is there a document for it?');
  // Finnish: wholly code-built; the internal English reasoning is not spliced in.
  assert.equal(buildNeedsHumanOwnerQuestion({ transaction: DEBIT, direction: 'money_out', semantic, language: 'fi' }),
    'Maksu tililtä (41,20 EUR, 14.5.2026, "KAUPPA ESIMERKKI"): Emme tunnistaneet, mistä tässä maksussa on kyse. Oliko se yrityksen kulu, ja mihin se liittyi? Onko sinulla siitä kuitti tai lasku?');
  assert.equal(buildNeedsHumanOwnerQuestion({ transaction: CREDIT, direction: 'money_in', semantic, language: 'fi' }),
    'Tilille tullut maksu (1250,00 EUR, 14.5.2026, "MAKSUPALVELU ESIMERKKI"): Emme tunnistaneet, mistä tässä tilillesi tulleessa rahassa on kyse. Mistä raha tuli: asiakkaan maksu, maksupalvelun tilitys, laina tai siirto, vai palautus? Onko siitä jokin tosite?');
  // pg hands a date column back as a local-midnight Date; nothing missing is invented.
  assert.equal(buildNeedsHumanOwnerQuestion({ transaction: { money_out: 9, transaction_date: new Date(2026, 1, 3) }, direction: 'money_out', language: 'fi' }),
    'Maksu tililtä (9,00, 3.2.2026): Emme tunnistaneet, mistä tässä maksussa on kyse. Oliko se yrityksen kulu, ja mihin se liittyi? Onko sinulla siitä kuitti tai lasku?');
});

const mintFor = async ({ profile, transaction = DEBIT }) => {
  const client = makeMockClient([
    { match: 'and id = $3', rows: [transaction] },
    { match: 'from clients where firm_id', rows: [{ id: 'client-1', company_name: 'Esimerkki Oy', legal_names: [], jurisdiction: 'FI' }] },
    { match: 'select profile from clients', rows: [{ profile }] }
  ]);
  const mints = [];
  const bodies = [];
  const result = await runBankLineDispositionForTransaction({
    client, firmId: 'firm-1', clientId: 'client-1', transactionId: transaction.id,
    apiKeyOverride: 'sk-test', fetchImpl: recordedProvider(NEEDS_HUMAN, bodies), jevEnabled: false,
    laneDeps: {
      mintOwnerAsk: async (args) => { mints.push(args); if (args.mintOutcome) args.mintOutcome.minted = true; return { id: 'ask-1' }; },
      enqueueRerun: async () => ({ id: 1 })
    }
  });
  return { result, mints, bodies };
};

test('owner language — the bank-line mint reads the owner language from the client profile', async () => {
  const fi = await mintFor({ profile: { jurisdiction: 'FI' } });
  assert.equal(fi.bodies.length, 1, 'one recorded provider call');
  assert.equal(fi.result.lane?.kind, 'owner_ask');
  assert.match(fi.mints[0].question, /^Maksu tililtä \(41,20 EUR, 14\.5\.2026, "KAUPPA ESIMERKKI"\): Emme tunnistaneet/);
  const fiIn = await mintFor({ profile: { locale: 'fi-FI' }, transaction: CREDIT });
  assert.match(fiIn.mints[0].question, /^Tilille tullut maksu \(1250,00 EUR/);
  // An owner who chose English keeps English, byte for byte.
  const en = await mintFor({ profile: { jurisdiction: 'FI', locale: 'en' } });
  assert.equal(en.mints[0].question,
    'We could not tell what the EUR 41.20 paid on 2026-05-14 ("KAUPPA ESIMERKKI") was for. The counterparty is not one the firm knows. Was it a business expense, what was it for, and is there a receipt or bill for it?');
});
