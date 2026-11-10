import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveOpeningBalanceInbound, OPENING_BALANCE_ASK_KIND } from './openingBalanceRoute.js';

const proposalVerdict = {
  terminal: 'proposal',
  proposal: {
    source: 'trial_balance',
    currency: 'EUR',
    total: 4200,
    openingLines: [
      { account_code: '1910', account_name: 'Pankkitili', debit: 4200, credit: 0 },
      { account_code: '2050', account_name: 'Oma pääoma', debit: 0, credit: 4200 }
    ],
    model: 'test-model'
  }
};

const baseAsk = (state = { phase: 'intake' }) => ({
  id: 'ask-opening-1',
  client_id: 'client-1',
  evidence_type: OPENING_BALANCE_ASK_KIND,
  request_payload: { kind: OPENING_BALANCE_ASK_KIND, opening_balance: state }
});

const baseArgs = (overrides = {}) => ({
  firmId: 'firm-1',
  clientId: 'client-1',
  ask: baseAsk(),
  documentText: 'closing balance sheet text',
  actorId: 'owner-1',
  phoneHash: 'phone_hash_1',
  message: { id: 'wamid.1', timestamp: '2026-07-09T10:00:00.000Z' },
  createAsk: async (ask) => ({ id: `ask-${ask.requestPayload.opening_balance.kind}`, ...ask }),
  sendText: async () => {},
  ...overrides
});

test('doc reply → proposal → request_confirmation with mapped lines and total', async () => {
  const sent = [];
  const result = await resolveOpeningBalanceInbound(baseArgs({
    runTrialBalanceIntakeImpl: async () => proposalVerdict,
    sendText: async ({ text }) => sent.push(text)
  }));

  assert.equal(result.action, 'request_confirmation');
  assert.equal(result.verdict, proposalVerdict);
  assert.match(result.ask.summary, /1910 Pankkitili/);
  assert.match(result.ask.summary, /2050 Oma pääoma/);
  assert.match(result.ask.summary, /Total: 4200\.00 EUR/);
  assert.match(sent[0], /Confirm by replying “yes”/);
});

// The webhook wiring passes ANTHROPIC_API_KEY down; without this forward the
// trial-balance intake silently degrades to a no_api_key escalation in prod.
test('doc reply forwards apiKey and fetchImpl into the trial-balance intake', async () => {
  const seen = [];
  const fetchImpl = async () => {};
  await resolveOpeningBalanceInbound(baseArgs({
    apiKey: 'sk-ant-test',
    fetchImpl,
    runTrialBalanceIntakeImpl: async (input) => { seen.push(input); return proposalVerdict; }
  }));

  assert.equal(seen[0].apiKey, 'sk-ant-test');
  assert.equal(seen[0].fetchImpl, fetchImpl);
});

test('doc reply → escalate persists the owner question', async () => {
  const verdict = { terminal: 'escalate', escalation: { reason: 'unmapped_accounts', question: 'Which account is this?' } };
  const created = [];
  const result = await resolveOpeningBalanceInbound(baseArgs({
    runTrialBalanceIntakeImpl: async () => verdict,
    createAsk: async (ask) => { created.push(ask); return { id: 'ask-escalation', ...ask }; }
  }));

  assert.equal(result.action, 'escalate');
  assert.equal(result.ask.question, 'Which account is this?');
  assert.equal(created[0].requestPayload.opening_balance.kind, 'escalation');
});

test('affirmative reply → confirm_and_post with authorityBasis and owner actorId', async () => {
  const posts = [];
  const result = await resolveOpeningBalanceInbound(baseArgs({
    ask: baseAsk({ phase: 'confirm_request', verdict: proposalVerdict }),
    replyText: 'kyllä',
    confirmOpeningBalanceIntakeImpl: async (args) => { posts.push(args); return { ok: true, idempotency_key: 'posted-1' }; }
  }));

  assert.equal(result.action, 'confirm_and_post');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].actorId, 'owner-1');
  assert.equal(posts[0].authorityBasis.providerMessageId, 'wamid.1');
  assert.equal(posts[0].authorityBasis.phoneHash, 'phone_hash_1');
});

test('ambiguous confirmation reply nudges and never posts', async () => {
  let posted = false;
  const result = await resolveOpeningBalanceInbound(baseArgs({
    ask: baseAsk({ phase: 'confirm_request', verdict: proposalVerdict }),
    replyText: 'looks fine maybe',
    confirmOpeningBalanceIntakeImpl: async () => { posted = true; }
  }));

  assert.equal(result.action, 'nudge');
  assert.equal(posted, false);
});

test('text bank-only reply uses the bank-only intake path', async () => {
  const calls = [];
  const result = await resolveOpeningBalanceInbound(baseArgs({
    documentText: '',
    replyText: 'Aloitan pelkällä pankkisaldolla 4200€',
    classifyOpeningIntakeImpl: (input) => { calls.push(input); return proposalVerdict; },
    runTrialBalanceIntakeImpl: async () => { throw new Error('should not run document intake'); }
  }));

  assert.equal(result.action, 'request_confirmation');
  assert.equal(calls[0].source, 'bank_only');
  assert.equal(calls[0].bankBalance, 4200);
  assert.equal(calls[0].confirmedCashOnly, true);
});

test('escalation clarification reply runs a fresh intake', async () => {
  const calls = [];
  const result = await resolveOpeningBalanceInbound(baseArgs({
    ask: baseAsk({ phase: 'escalation', clarification: true }),
    documentText: '',
    replyText: 'The missing line is owner equity.',
    runTrialBalanceIntakeImpl: async (input) => { calls.push(input); return proposalVerdict; }
  }));

  assert.equal(result.action, 'request_confirmation');
  assert.equal(calls.length, 1);
  assert.match(calls[0].memo, /Owner clarification/);
});

test('flag-off skips routing', async () => {
  let ran = false;
  const result = await resolveOpeningBalanceInbound(baseArgs({
    flagActs: false,
    runTrialBalanceIntakeImpl: async () => { ran = true; return proposalVerdict; }
  }));

  assert.equal(result.action, 'skipped');
  assert.equal(result.reason, 'flag_off');
  assert.equal(ran, false);
});

// Two-terminal-states lifecycle: the ANSWERED ask must be resolved on each real
// transition so exactly one opening_balance ask is ever open per client (otherwise
// answered asks pile up open and break resolveInboundAnchor's unique-ref match).
test('confirm-post RESOLVES the answered confirm-request ask', async () => {
  const resolved = [];
  const result = await resolveOpeningBalanceInbound(baseArgs({
    ask: baseAsk({ phase: 'confirm_request', verdict: proposalVerdict }),
    replyText: 'kyllä',
    confirmOpeningBalanceIntakeImpl: async () => ({ ok: true }),
    resolveAsk: async (a) => resolved.push(a)
  }));
  assert.equal(result.action, 'confirm_and_post');
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].askId, 'ask-opening-1');
  assert.equal(resolved[0].resolutionNote, 'opening_balance_posted');
  assert.equal(resolved[0].actorId, 'owner-1');
});

test('proposal → request_confirmation RESOLVES the answered onboarding ask', async () => {
  const resolved = [];
  const result = await resolveOpeningBalanceInbound(baseArgs({
    runTrialBalanceIntakeImpl: async () => proposalVerdict,
    resolveAsk: async (a) => resolved.push(a)
  }));
  assert.equal(result.action, 'request_confirmation');
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].askId, 'ask-opening-1');
  assert.equal(resolved[0].resolutionNote, 'opening_balance_confirmation_requested');
});

test('escalate RESOLVES the answered ask (prior ask closed, only the new escalation open)', async () => {
  const resolved = [];
  const result = await resolveOpeningBalanceInbound(baseArgs({
    runTrialBalanceIntakeImpl: async () => ({ terminal: 'escalate', escalation: { question: 'Which account?' } }),
    resolveAsk: async (a) => resolved.push(a)
  }));
  assert.equal(result.action, 'escalate');
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].askId, 'ask-opening-1');
  assert.equal(resolved[0].resolutionNote, 'opening_balance_escalated');
});

// Round-trip integration: the confirm-request ask fed back into the route is the ask
// `createOpeningAsk` ACTUALLY produced (persisted the way the DB writer stores and
// returns request_payload), and the confirm branch runs the REAL
// confirmOpeningBalanceIntake — only the ledger write is injected. This is the seam
// the flat-vs-nested payload bug slipped through: earlier tests hand-built the ask
// payload instead of using the writer's shape, so `state.verdict` reading undefined
// never surfaced (Lesson C — seam tests are not integration tests).
const persistLikeDbWriter = ({ question, requestPayload }) => JSON.parse(JSON.stringify({
  id: 'ask-confirm-rt',
  client_id: 'client-1',
  status: 'open',
  evidence_type: OPENING_BALANCE_ASK_KIND,
  question,
  request_payload: { kind: OPENING_BALANCE_ASK_KIND, ...(requestPayload || {}) }
}));

test('E2E round-trip: intake → confirm-request ask (real payload) → “kyllä” → REAL confirm posts the lines', async () => {
  let persistedAsk = null;
  const first = await resolveOpeningBalanceInbound(baseArgs({
    runTrialBalanceIntakeImpl: async () => proposalVerdict,
    createAsk: async (ask) => { persistedAsk = persistLikeDbWriter(ask); return persistedAsk; }
  }));
  assert.equal(first.action, 'request_confirmation');
  assert.ok(persistedAsk, 'confirm-request ask was persisted');

  const posts = [];
  const second = await resolveOpeningBalanceInbound(baseArgs({
    ask: persistedAsk,
    replyText: 'kyllä',
    asOf: '2026-01-01',
    // NO confirmOpeningBalanceIntakeImpl injection: the real terminal-proposal check runs.
    postImpl: async (args) => { posts.push(args); return { ok: true, idempotency_key: 'posted-rt' }; }
  }));

  assert.equal(second.action, 'confirm_and_post');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].openingLines.length, 2);
  assert.equal(posts[0].openingLines[0].account_code, '1910');
  assert.equal(posts[0].currency, 'EUR');
  assert.equal(posts[0].model, 'test-model');
  assert.equal(posts[0].actorId, 'owner-1');
  assert.equal(posts[0].authorityBasis.providerMessageId, 'wamid.1');
});

test('legacy nested confirm-request payload ({kind, state:{...}}) still confirms and posts', async () => {
  const posts = [];
  const legacyAsk = {
    id: 'ask-legacy-1',
    client_id: 'client-1',
    evidence_type: OPENING_BALANCE_ASK_KIND,
    request_payload: {
      kind: OPENING_BALANCE_ASK_KIND,
      opening_balance: { kind: 'confirm_request', state: { phase: 'confirm_request', verdict: proposalVerdict, summary: 'x' } }
    }
  };
  const result = await resolveOpeningBalanceInbound(baseArgs({
    ask: legacyAsk,
    replyText: 'yes',
    postImpl: async (args) => { posts.push(args); return { ok: true }; }
  }));
  assert.equal(result.action, 'confirm_and_post');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].openingLines.length, 2);
});

test('ambiguous confirmation nudge does NOT resolve the ask (stays open on the owner)', async () => {
  const resolved = [];
  const result = await resolveOpeningBalanceInbound(baseArgs({
    ask: baseAsk({ phase: 'confirm_request', verdict: proposalVerdict }),
    replyText: 'looks fine maybe',
    resolveAsk: async (a) => resolved.push(a)
  }));
  assert.equal(result.action, 'nudge');
  assert.equal(resolved.length, 0);
});

// ── The owner's language on the opening-balance lane ─────────────────────────
// A Finnish owner read English route and intake lines before this change. The
// English output is pinned verbatim; the Finnish replies invited are ones the
// route already reads.
import { classifyOpeningIntake } from './openingBalanceIntake.js';

test('opening-balance lane: a Finnish owner gets the Finnish summary, nudge and fallback question', async () => {
  const sent = [];
  const fi = await resolveOpeningBalanceInbound(baseArgs({
    language: 'fi',
    runTrialBalanceIntakeImpl: async () => proposalVerdict,
    sendText: async ({ text }) => sent.push(text)
  }));
  assert.equal(fi.ask.summary, '• 1910 Pankkitili: 4200,00 EUR\n• 2050 Oma pääoma: 4200,00 EUR\nYhteensä: 4200,00 EUR');
  assert.equal(sent[0], `${fi.ask.summary}\n\nVahvista vastaamalla “kyllä”, niin kirjaan avaavan taseen.`);

  const en = await resolveOpeningBalanceInbound(baseArgs({ runTrialBalanceIntakeImpl: async () => proposalVerdict }));
  assert.equal(en.ask.summary, '• 1910 Pankkitili — 4200.00 EUR\n• 2050 Oma pääoma — 4200.00 EUR\nTotal: 4200.00 EUR');

  const confirmAsk = baseAsk({ phase: 'confirm_request', verdict: proposalVerdict });
  const nudgeFi = await resolveOpeningBalanceInbound(baseArgs({ ask: confirmAsk, replyText: 'hmm', language: 'fi' }));
  assert.equal(nudgeFi.text, 'Vastaa “kyllä”, jos haluat, että kirjaan tämän avaavan taseen. Jos jokin on väärin, lähetä korjatut luvut.');
  const nudgeEn = await resolveOpeningBalanceInbound(baseArgs({ ask: confirmAsk, replyText: 'hmm' }));
  assert.equal(nudgeEn.text, 'Please reply “kyllä” or “yes” if you want me to post this opening balance. If anything is wrong, send the corrected figures instead.');

  const fallbackFi = await resolveOpeningBalanceInbound(baseArgs({ language: 'fi', runTrialBalanceIntakeImpl: async () => ({ terminal: 'escalate' }) }));
  assert.equal(fallbackFi.ask.question, 'Voisitko tarkentaa avaavan taseen lukuja?');
  const fallbackEn = await resolveOpeningBalanceInbound(baseArgs({ runTrialBalanceIntakeImpl: async () => ({ terminal: 'escalate' }) }));
  assert.equal(fallbackEn.ask.question, 'Could you clarify your opening balance figures?');
});

test('opening-balance lane: the owner language reaches the intake on both paths', async () => {
  const seen = [];
  await resolveOpeningBalanceInbound(baseArgs({ language: 'fi', runTrialBalanceIntakeImpl: async (input) => { seen.push(input.language); return proposalVerdict; } }));
  await resolveOpeningBalanceInbound(baseArgs({
    language: 'fi', documentText: '', replyText: 'Pankkitilillä 5000 euroa, vain pankkitili',
    classifyOpeningIntakeImpl: (input) => { seen.push(input.language); return proposalVerdict; }
  }));
  await resolveOpeningBalanceInbound(baseArgs({ runTrialBalanceIntakeImpl: async (input) => { seen.push(input.language); return proposalVerdict; } }));
  assert.deepEqual(seen, ['fi', 'fi', 'en']);
});

test('classifyOpeningIntake words every escalation in the owner language; English unchanged', () => {
  const ask = (input) => classifyOpeningIntake(input).escalation;
  const cases = [
    [{ source: 'bank_only', bankBalance: 0 }, 'bank_balance_missing',
      "What was the balance on your business bank account on the day you switched to Donna? I'll open your books from there once you confirm it's the only opening position.",
      'Mikä oli yrityksesi pankkitilin saldo sinä päivänä, kun siirryit Donnaan? Avaan kirjanpitosi siitä, kun vahvistat, että se on ainoa avaava eräsi.'],
    [{ source: 'bank_only', bankBalance: 5000.5 }, 'awaiting_cash_only_confirmation',
      "Is your only opening position the bank balance of 5000.50 EUR? No outstanding invoices, unpaid bills, loans, equipment, or prior-year profit? Confirm and I'll open your books from it.",
      'Onko pankkitilin saldo 5000,50 EUR ainoa avaava eräsi? Ei avoimia myyntilaskuja, maksamattomia laskuja, lainoja, laitteita tai edellisen vuoden voittoa? Vahvista, niin avaan kirjanpitosi sen pohjalta.'],
    [{ source: 'bank_only', bankBalance: 5000, ownerMessage: 'pankkitili ja pankkilaina' }, 'richer_position_suspected',
      "Before I set your opening balance from just the bank balance, do you also have any of these at the switch date? In particular: Long-term liabilities (Pitkäaikainen vieras pääoma). Tell me the amounts and I'll include them; if it really is just the bank balance, confirm and I'll set it.",
      'Ennen kuin teen avaavan taseen pelkän pankkisaldon perusteella: onko sinulla vaihtopäivänä myös jotain näistä? Erityisesti: Pitkäaikainen vieras pääoma. Kerro summat, niin otan ne mukaan. Jos kyse on tosiaan vain pankkisaldosta, vahvista se, niin teen taseen sen pohjalta.'],
    [{ source: 'trial_balance', parsed: { ok: false } }, 'tb_unextractable',
      "I couldn't read the opening balances from that document. Could you upload a clearer copy of your accountant's closing balance sheet, or tell me the figures directly?",
      'En saanut luettua avaavia saldoja tuosta asiakirjasta. Voisitko lähettää selkeämmän kopion tilitoimistosi tilinpäätöksen taseesta tai kertoa luvut suoraan?'],
    [{ source: 'trial_balance', parsed: { ok: true, lines: [] } }, 'no_opening_positions',
      "I read the document but didn't find any opening balance-sheet positions. Could you confirm your accountant's closing figures?",
      'Luin asiakirjan, mutta en löytänyt siitä avaavan taseen eriä. Voisitko vahvistaa tilitoimistosi tilinpäätösluvut?']
  ];
  for (const [input, reason, english, finnish] of cases) {
    const en = ask(input);
    const fi = ask({ ...input, language: 'fi' });
    assert.equal(en.reason, reason);
    assert.equal(en.question, english, `English pinned for ${reason}`);
    assert.equal(fi.reason, reason, 'the language never changes the verdict');
    assert.deepEqual(fi.details, en.details);
    assert.equal(fi.question, finnish, `Finnish for ${reason}`);
  }
});

// A Finnish company whose owner chose English: the lane is the Finnish one, the
// owner's language is English (the one resolver decides it; inboundCore passes
// it). Before, the confirm tail and the posted line were Finnish for every owner.
test('opening-balance lane: a Finnish company whose owner chose English gets the confirm tail and the posted line in English', async () => {
  const sent = [];
  const proposal = await resolveOpeningBalanceInbound(baseArgs({
    language: 'en',
    entityType: 'oy',
    runTrialBalanceIntakeImpl: async () => proposalVerdict,
    sendText: async ({ text }) => sent.push(text)
  }));
  assert.equal(sent[0], `${proposal.ask.summary}\n\nConfirm by replying “yes” and I will post the opening balance.`);
  assert.doesNotMatch(sent[0], /Vahvista|kyllä/);

  // The invited word is one the route reads: "yes" posts.
  const posted = [];
  const posts = [];
  const confirmed = await resolveOpeningBalanceInbound(baseArgs({
    language: 'en',
    ask: baseAsk({ phase: 'confirm_request', verdict: proposalVerdict }),
    replyText: 'yes',
    confirmOpeningBalanceIntakeImpl: async (args) => { posts.push(args); return { ok: true }; },
    sendText: async ({ text }) => posted.push(text)
  }));
  assert.equal(confirmed.action, 'confirm_and_post');
  assert.equal(posts.length, 1);
  assert.deepEqual(posted, ['Opening balance posted.']);

  // A Finnish owner keeps the Finnish lines.
  const postedFi = [];
  await resolveOpeningBalanceInbound(baseArgs({
    language: 'fi',
    ask: baseAsk({ phase: 'confirm_request', verdict: proposalVerdict }),
    replyText: 'kyllä',
    confirmOpeningBalanceIntakeImpl: async () => ({ ok: true }),
    sendText: async ({ text }) => postedFi.push(text)
  }));
  assert.deepEqual(postedFi, ['Avaava tase kirjattu.']);
});
