// G14 (outbound-actions M1) — the owner-ask EMAIL deliverer. Pins:
//   - config-plane gate: OWNER_EMAIL_ASKS off ⇒ internal no-op (born off,
//     envFallback false — the rollout-flags rail, no env pair);
//   - one email per batch carrying every question un-truncated, addressed
//     via the profile owner-email ladder;
//   - one delivery-ledger entry PER ask (reply-anchoring stays per-request),
//     failure recorded as the visible fallback entry;
//   - no owner email on file ⇒ named skip, never a throw.

import assert from 'node:assert/strict';
import test from 'node:test';

import { deliverEmailEvidenceAsksAfterSend, OWNER_EMAIL_ASKS_FLAG_KEY } from './firmDb.js';
import { defaultFrom, senderWithDisplayName } from './email/resendClient.js';

const FIRM = 'firm-1';
const CLIENT = 'client-1';

const askRow = (id, question) => ({
  id, question, request_payload: { period: 'June 2026' }
});

const makeMockClient = ({ stage = 'canary', profile = { email: 'kari@books.example' }, asks = [], firmName = null } = {}) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const text = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (text.includes('from client_capability_config')) {
        return { rows: stage ? [{ flag_key: OWNER_EMAIL_ASKS_FLAG_KEY, stage, source: 'test', client_id: CLIENT }] : [] };
      }
      if (text.includes('from cohort_capability_config')) return { rows: [] };
      if (text.includes('select company_name, jurisdiction, profile from clients')) {
        return { rows: [{ company_name: 'Roofline Co', profile }] };
      }
      if (text.includes('select name from firms')) {
        return { rows: firmName ? [{ name: firmName }] : [] };
      }
      if (text.includes('from client_evidence_requests')) {
        const found = asks.find((a) => a.id === params[2]);
        return { rows: found ? [found] : [] };
      }
      if (text.includes('insert into message_delivery_ledger')) {
        return { rows: [{ id: params[0] }] };
      }
      return { rows: [], rowCount: 0 };
    }
  };
};

const okDeliver = () => {
  const sent = [];
  return {
    sent,
    deliverOwnerMessage: async (args) => { sent.push(args); return { ok: true, id: 'rs-ask-1' }; },
    OWNER_CHANNELS: { EMAIL: 'email' }
  };
};

test('flag off means an internal no-op', async () => {
  const deps = okDeliver();
  const client = makeMockClient({ stage: 'off', asks: [askRow('ask-1', 'What was this?')] });
  const result = await deliverEmailEvidenceAsksAfterSend({
    client, firmId: FIRM, clientId: CLIENT, evidenceRequestIds: ['ask-1'], deps
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'flag_off');
  assert.equal(deps.sent.length, 0);
});

test('one email per batch, full questions, one ledger entry per ask', async () => {
  const deps = okDeliver();
  const client = makeMockClient({
    asks: [
      askRow('ask-1', 'What was the $420 charge from Vistaprint for?'),
      askRow('ask-2', 'Is the Delta flight on June 12 a business trip?')
    ]
  });
  const result = await deliverEmailEvidenceAsksAfterSend({
    client, firmId: FIRM, clientId: CLIENT, evidenceRequestIds: ['ask-1', 'ask-2'], deps
  });
  assert.equal(result.sent, 2, JSON.stringify(result));
  assert.equal(deps.sent.length, 1, 'ONE email for the whole batch');
  assert.equal(deps.sent[0].channel, 'email');
  assert.equal(deps.sent[0].recipient.email, 'kari@books.example');
  assert.ok(deps.sent[0].email.text.includes('Vistaprint'));
  assert.ok(deps.sent[0].email.text.includes('Delta'));
  assert.ok(deps.sent[0].email.subject.includes('2 questions'));
  const ledger = client.calls.filter((c) => c.sql.includes('insert into message_delivery_ledger'));
  assert.equal(ledger.length, 2, 'per-ask ledger entries');
});

test('no owner email on file is a named skip', async () => {
  const deps = okDeliver();
  const client = makeMockClient({ profile: {}, asks: [askRow('ask-1', 'q')] });
  const result = await deliverEmailEvidenceAsksAfterSend({
    client, firmId: FIRM, clientId: CLIENT, evidenceRequestIds: ['ask-1'], deps
  });
  assert.equal(result.reason, 'no_owner_email');
  assert.equal(deps.sent.length, 0);
});

test('a failed send records the visible fallback entry per ask', async () => {
  const client = makeMockClient({ asks: [askRow('ask-1', 'q')] });
  const result = await deliverEmailEvidenceAsksAfterSend({
    client, firmId: FIRM, clientId: CLIENT, evidenceRequestIds: ['ask-1'],
    deps: {
      deliverOwnerMessage: async () => ({ ok: false, error: 'resend 500' }),
      OWNER_CHANNELS: { EMAIL: 'email' }
    }
  });
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 1);
  const ledger = client.calls.find((c) => c.sql.includes('insert into message_delivery_ledger'));
  assert.ok(ledger.params.some((p) => String(p).includes('email_fallback_ask-1')));
});

const ledgerPayloads = (client) => client.calls
  .filter((c) => c.sql.includes('insert into message_delivery_ledger'))
  .map((c) => JSON.parse(c.params[c.params.length - 1]));

test('a Finnish owner gets Finnish copy from the firm, with singular and plural counts', async () => {
  const profile = { email: 'owner@books.example', jurisdiction: 'FI', assistant_name: 'Aino' };
  const one = okDeliver();
  const single = makeMockClient({ profile, firmName: 'Tilitoimisto Esimerkki Oy', asks: [askRow('ask-1', 'Mikä oli 42 euron veloitus?')] });
  await deliverEmailEvidenceAsksAfterSend({ client: single, firmId: FIRM, clientId: CLIENT, evidenceRequestIds: ['ask-1'], deps: one });
  const sent = one.sent[0].email;
  assert.equal(sent.subject, 'Tilitoimisto Esimerkki Oy: 1 kysymys kirjanpidostasi — Roofline Co');
  assert.ok(sent.text.startsWith('Hei! Täällä Aino, Tilitoimisto Esimerkki Oy. Jotta kirjanpitosi pysyy ajan tasalla, tarvitsen sinulta vastauksen yhteen kysymykseen:'), sent.text);
  assert.ok(sent.text.includes('Mikä oli 42 euron veloitus?'), 'the question passes through unchanged');
  assert.ok(sent.text.endsWith('Vastaa vain tähän sähköpostiin (kuvat ja kuitit voit liittää mukaan), niin hoidan loput.'));
  assert.doesNotMatch(`${sent.subject}\n${sent.text}`, /Donna|question|this period/);
  assert.deepEqual(ledgerPayloads(single).map((p) => p.language), ['fi']);

  const many = okDeliver();
  const batch = makeMockClient({
    profile, firmName: 'Tilitoimisto Esimerkki Oy',
    asks: [askRow('ask-1', 'a'), askRow('ask-2', 'b'), { id: 'ask-3', question: 'c', request_payload: {} }]
  });
  await deliverEmailEvidenceAsksAfterSend({ client: batch, firmId: FIRM, clientId: CLIENT, evidenceRequestIds: ['ask-1', 'ask-2', 'ask-3'], deps: many });
  assert.ok(many.sent[0].email.subject.startsWith('Tilitoimisto Esimerkki Oy: 3 kysymystä kirjanpidostasi'));
  assert.ok(many.sent[0].email.text.includes('vastauksia muutamaan kysymykseen'));
  assert.ok(many.sent[0].email.text.includes('3. [tämä kausi] c (ref ASK3)'), 'Finnish period fallback, ref kept for reply anchoring');
  assert.deepEqual(ledgerPayloads(batch).map((p) => p.language), ['fi', 'fi', 'fi']);
});

test('a non-Finnish owner gets the English copy, named by the resolver and the firm', async () => {
  const deps = okDeliver();
  const client = makeMockClient({ firmName: 'Ledger & Co', asks: [askRow('ask-1', 'What was this?')] });
  await deliverEmailEvidenceAsksAfterSend({ client, firmId: FIRM, clientId: CLIENT, evidenceRequestIds: ['ask-1'], deps });
  const sent = deps.sent[0].email;
  assert.equal(sent.subject, 'Ledger & Co: 1 question about your books — Roofline Co');
  assert.ok(sent.text.startsWith('Hi — Donna here from Ledger & Co. To keep your books current I need one answer only you can give:'), sent.text);
  assert.ok(sent.text.endsWith('Just reply to this email with the answers (or photos/receipts attached) and I will take it from there.'));
  assert.deepEqual(ledgerPayloads(client).map((p) => p.language), ['en']);

  // With no firm name on file the sender falls back to the resolver's name
  // (here a renamed assistant, so nothing is hardcoded).
  const renamed = okDeliver();
  const bare = makeMockClient({ profile: { email: 'owner@books.example', assistant_name: 'Tessa' }, asks: [askRow('ask-1', 'q')] });
  await deliverEmailEvidenceAsksAfterSend({ client: bare, firmId: FIRM, clientId: CLIENT, evidenceRequestIds: ['ask-1'], deps: renamed });
  assert.ok(renamed.sent[0].email.subject.startsWith('Tessa: 1 question'));
  assert.ok(renamed.sent[0].email.text.startsWith('Hi — Tessa here. To keep'));
  assert.doesNotMatch(renamed.sent[0].email.text, /Donna/);
});

test('first-ask emails carry no reminder wording; the re-ask sweep marker selects it in both languages', async () => {
  const fiProfile = { email: 'owner@books.example', jurisdiction: 'FI', assistant_name: 'Aino' };
  const first = okDeliver();
  const firstClient = makeMockClient({ profile: fiProfile, firmName: 'Tilitoimisto Esimerkki Oy', asks: [askRow('ask-1', 'Mikä tämä oli?')] });
  await deliverEmailEvidenceAsksAfterSend({ client: firstClient, firmId: FIRM, clientId: CLIENT, evidenceRequestIds: ['ask-1'], deps: first });
  assert.doesNotMatch(`${first.sent[0].email.subject}\n${first.sent[0].email.text}`, /Muistut/);
  assert.equal(ledgerPayloads(firstClient)[0].wording, undefined);

  const fi = okDeliver();
  const fiClient = makeMockClient({ profile: fiProfile, firmName: 'Tilitoimisto Esimerkki Oy', asks: [askRow('ask-1', 'Mikä tämä oli?')] });
  await deliverEmailEvidenceAsksAfterSend({ client: fiClient, firmId: FIRM, clientId: CLIENT, evidenceRequestIds: ['ask-1'], deps: { ...fi, askWording: 'reminder' } });
  assert.equal(fi.sent[0].email.subject, 'Tilitoimisto Esimerkki Oy: 1 kysymys kirjanpidostasi (muistutus) — Roofline Co');
  assert.ok(fi.sent[0].email.text.startsWith('Hei! Täällä Aino, Tilitoimisto Esimerkki Oy. Muistutan vielä: tarvitsen sinulta vastauksen yhteen kysymykseen, jotta kirjanpitosi pysyy ajan tasalla:'), fi.sent[0].email.text);
  assert.ok(fi.sent[0].email.text.includes('(ref ASK1)'), 'the reply anchor survives the reminder wording');
  assert.deepEqual(ledgerPayloads(fiClient).map((p) => [p.language, p.wording]), [['fi', 'reminder']]);

  const en = okDeliver();
  const enClient = makeMockClient({ asks: [askRow('ask-1', 'q1'), askRow('ask-2', 'q2')] });
  await deliverEmailEvidenceAsksAfterSend({ client: enClient, firmId: FIRM, clientId: CLIENT, evidenceRequestIds: ['ask-1', 'ask-2'], deps: { ...en, askWording: 'reminder' } });
  assert.equal(en.sent[0].email.subject, 'Donna: 2 questions about your books (reminder) — Roofline Co');
  assert.ok(en.sent[0].email.text.startsWith('Hi — Donna here. A quick reminder: I still need a few answers only you can give to keep your books current:'), en.sent[0].email.text);
});

test('the From display name names the firm and keeps the configured sender address; no firm keeps the default sender', async () => {
  const named = okDeliver();
  const client = makeMockClient({ profile: { email: 'owner@books.example', jurisdiction: 'FI', assistant_name: 'Aino' }, firmName: 'Tilitoimisto Esimerkki Oy', asks: [askRow('ask-1', 'q')] });
  await deliverEmailEvidenceAsksAfterSend({ client, firmId: FIRM, clientId: CLIENT, evidenceRequestIds: ['ask-1'], deps: named });
  const configured = defaultFrom();
  const address = (configured.match(/<([^<>]+)>\s*$/) || [null, configured])[1].trim();
  assert.equal(named.sent[0].email.from, `"Aino, Tilitoimisto Esimerkki Oy" <${address}>`);

  const bare = okDeliver();
  const bareClient = makeMockClient({ asks: [askRow('ask-1', 'q')] });
  await deliverEmailEvidenceAsksAfterSend({ client: bareClient, firmId: FIRM, clientId: CLIENT, evidenceRequestIds: ['ask-1'], deps: bare });
  assert.equal('from' in bare.sent[0].email, false, 'no firm on file: the configured sender, unchanged');
});

test('senderWithDisplayName swaps only the display name', () => {
  assert.equal(senderWithDisplayName('Aino, Esimerkki Oy', 'Donna <donna@updates.example.test>'), '"Aino, Esimerkki Oy" <donna@updates.example.test>');
  assert.equal(senderWithDisplayName('Aino', 'donna@updates.example.test'), '"Aino" <donna@updates.example.test>');
  assert.equal(senderWithDisplayName('Bad "quote" <x>', 'Donna <donna@updates.example.test>'), '"Bad quote x" <donna@updates.example.test>');
  assert.equal(senderWithDisplayName('', 'Donna <donna@updates.example.test>'), 'Donna <donna@updates.example.test>');
});
