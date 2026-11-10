// How an owner's typed reply is read for words: the ONE letter rule and the ONE
// normalisation, shared by the reply keyword lists (inboundCore.js
// assessEvidenceTopicTurn) and the "Ref" anchor (whatsappWebhookCore.js
// extractAskRef). Leaf module (no imports), so both can use it without a cycle.

// A letter is any Unicode letter or digit, so Finnish ä, ö and å count as
// letters. JavaScript's \b does not: it reads "kohta" inside "henkilökohtainen"
// as a whole word.
const LETTER = '[\\p{L}\\p{N}]';
export const OWNER_REPLY_WORD_START = `(?<!${LETTER})`;
export const OWNER_REPLY_WORD_END = `(?!${LETTER})`;

// Whole words and phrases only. Entries are regex sources, written with a
// straight apostrophe and plain spaces; test them against
// normalizeOwnerReplyText(text).
export const ownerReplyKeywords = (...entries) =>
  new RegExp(`${OWNER_REPLY_WORD_START}(?:${entries.join('|')})${OWNER_REPLY_WORD_END}`, 'iu');

// Phones insert typographic characters the keyword lists do not contain: a
// curly apostrophe in "can’t", a non-breaking space, a decomposed ä. This maps
// them to their plain forms. It is used only to READ the reply; the owner's
// own text is stored and forwarded unchanged.
const APOSTROPHES = /[‘’‚‛′ʼʻ`´＇]/g;
const QUOTES = /[“”„‟″«»＂]/g;
const SPACES = /[   -   　]/g;
const INVISIBLE = /[­​‌‍⁠﻿]/g;
const DASHES = /[‐‑‒–—―−]/g;

export const normalizeOwnerReplyText = (text) => String(text ?? '')
  .normalize('NFC')
  .replace(APOSTROPHES, "'")
  .replace(QUOTES, '"')
  .replace(SPACES, ' ')
  .replace(INVISIBLE, '')
  .replace(DASHES, '-');
