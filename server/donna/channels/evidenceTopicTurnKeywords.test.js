import test from 'node:test';
import assert from 'node:assert/strict';

import { assessEvidenceTopicTurn } from './inboundCore.js';

// The channels (WhatsApp, Telegram, SMS) and the portal reply route all read an
// owner's text reply through assessEvidenceTopicTurn. Its keyword lists must
// match whole words and phrases only, with letters defined for Finnish and
// English (ä, ö, å are letters), so an ordinary word that happens to contain a
// keyword is not read as that keyword.
const ask = { id: 'ask-1', question: 'Was this a business expense?' };
const outcomeOf = (text) => assessEvidenceTopicTurn({ ask, text }).outcome;

test('a complete answer that merely contains a defer keyword is an answer, not a deferral', () => {
  for (const reply of [
    'henkilökohtainen',
    'Henkilökohtainen',
    'henkilökohtainen kulu',
    'yksityiskohta',
    'kohtainen',
    'kohtalainen summa',
    'Collateral for the van loan',
    'escalated by the bank',
    'resend it was not needed, it is personal',
    'tomorrowland festival tickets, personal',
    'palaanko tähän, no, personal'
  ]) {
    assert.equal(outcomeOf(reply), 'answered', `"${reply}" should be an answer`);
  }
});

test('replies that defer are still read as deferring, in Finnish and English', () => {
  for (const reply of [
    'palaan asiaan huomenna',
    'Palaan asiaan',
    'lähetän kohta',
    'kohta!',
    'Kohta.',
    'huomenna',
    'lähetän sen myöhemmin',
    "I'll send it later",
    'I will send the receipt tonight',
    'later',
    'Tomorrow!',
    'next week',
    'send it after lunch',
    'will send this on monday'
  ]) {
    assert.equal(outcomeOf(reply), 'defer_later', `"${reply}" should defer`);
  }
});

test('Finnish keywords ending in ä or ö are matched as whole words', () => {
  assert.equal(outcomeOf('ehkä se oli työkulu'), 'partial_answer');
  assert.equal(outcomeOf('en tiedä'), 'needs_review');
  assert.equal(outcomeOf('mitä kuittia tarkoitetaan'), 'clarification_requested');
  assert.equal(outcomeOf('mikä lasku'), 'clarification_requested');
});

test('Finnish keywords do not fire inside longer words', () => {
  // "ehkäisy" (prevention) contains "ehkä"; "mitätön" (void) contains "mitä".
  assert.equal(outcomeOf('ehkäisyvälineet, henkilökohtainen'), 'answered');
  assert.equal(outcomeOf('mitätön kuitti, henkilökohtainen'), 'answered');
});

test('the other English keyword lists keep their existing reads', () => {
  assert.equal(outcomeOf('not sure'), 'partial_answer');
  assert.equal(outcomeOf('en ole varma'), 'partial_answer');
  assert.equal(outcomeOf("I don't know"), 'needs_review');
  assert.equal(outcomeOf('ei onnistu'), 'needs_review');
  assert.equal(outcomeOf('which receipt'), 'clarification_requested');
  assert.equal(outcomeOf('Fuel for the work van'), 'answered');
  assert.equal(outcomeOf('Missing'), 'partial_answer');
  assert.equal(outcomeOf('Cannot'), 'needs_review');
});

// Phones type a curly apostrophe (’, U+2019) and insert non-breaking spaces;
// the keyword lists are written with a straight apostrophe and plain spaces.
// One normalisation runs before the keyword tests, so both forms read the same.
test('curly apostrophes and phone spacing read like their plain forms, in Finnish and English', () => {
  const pairs = [
    ["I can't", 'needs_review'],
    ['I can’t', 'needs_review'],
    ['can’t find it', 'needs_review'],
    ["I don't know", 'needs_review'],
    ['I don’t know', 'needs_review'],
    ['I donʼt know', 'needs_review'],
    ["I'll send it later", 'defer_later'],
    ['I’ll send it later', 'defer_later'],
    ['I’ll send the receipt', 'defer_later'],
    ['I don’t have all of them', 'partial_answer'],
    ['not sure', 'partial_answer'],
    ['next week', 'defer_later'],
    ['en tiedä', 'needs_review'],
    ['en ole varma', 'partial_answer'],
    ['ei onnistu', 'needs_review'],
    ['palaan asiaan huomenna', 'defer_later'],
    // A decomposed ä (a + U+0308), as some keyboards send it.
    ['en tiedä', 'needs_review'],
    ['ehkä se oli työkulu', 'partial_answer']
  ];
  for (const [reply, outcome] of pairs) {
    assert.equal(outcomeOf(reply), outcome, `${JSON.stringify(reply)} should read as ${outcome}`);
  }
});

test('normalising does not make an ordinary word contain a keyword', () => {
  for (const reply of [
    'henkilökohtainen kulu',
    'yksityiskohta’s',
    'Collateral for the van loan',
    'ehkäisyvälineet, henkilökohtainen'
  ]) {
    assert.equal(outcomeOf(reply), 'answered', `${JSON.stringify(reply)} should be an answer`);
  }
});
