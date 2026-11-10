// A reply to a question that is already closed.
//
// Donna tells the owner they can disagree with an answer she recorded, so a
// later reply on a closed question is a correction to the answer it holds. The
// reply writer (resolveClientEvidenceRequestInDb, db/asks.js) decides whether
// the question's kind has a reader that can take one:
//   - a structured lane adapter that declares `readsCorrections`
//     (the VAT/ALV registration question, taxRegistrationReply.js), on the
//     structured owner-reply worker (structuredOwnerReply.js);
//   - the coder's reply path, for an ordinary line question whose line is
//     still with the coder (not applied, held, posted, synced or closed).
// With a reader, the question is put back to `replied` with the correction
// receipted (who, when, the earlier answer, the new text) and the reader reads
// it, marked as a correction. A correction the reader does not record puts the
// question back exactly as it was, with its own receipt, and moves no line.
// Without a reader nothing is written: the writer refuses with
// EVIDENCE_REQUEST_CLOSED_NOT_CORRECTABLE and a chat channel reads the text as
// a new message from the owner, and says so (channels/inboundCore.js).
//
// This module holds only the vocabulary and the owner-facing lines; the
// language is the one resolver's (ownerLanguage.js). Leaf module.
import { preferredOwnerTemplateLanguage } from './ownerLanguage.js';

export const CORRECTION_NOT_CORRECTABLE_CODE = 'EVIDENCE_REQUEST_CLOSED_NOT_CORRECTABLE';
export const CORRECTION_READERS = Object.freeze({ structured: 'structured_owner_reply', coder: 'coder_reply' });
export const CORRECTION_OUTCOMES = Object.freeze({ recorded: 'recorded', notRecorded: 'not_recorded' });
// The coding states the coder's reply path does not re-open (the owner-reply
// worker's own terminal set, ownerReplyRecovery.js).
export const CODER_FINISHED_CODING_STATES = Object.freeze(['applied', 'held', 'posted', 'synced', 'closed']);

const COPY = Object.freeze({
  en: Object.freeze({
    notRecorded: 'Thanks. I did not change anything: your earlier answer still stands. If it is wrong, please tell your accountant.',
    closedQuestion: 'That question is already closed, so I read your message as a new one.'
  }),
  fi: Object.freeze({
    notRecorded: 'Kiitos. En muuttanut mitään: aiempi vastauksesi on edelleen voimassa. Jos se ei pidä paikkaansa, kerro asiasta kirjanpitäjällesi.',
    closedQuestion: 'Kysymys on jo suljettu, joten luin viestisi uutena viestinä.'
  })
});
const copyFor = (language) => COPY[language] || COPY.en;

// The correction was read and nothing changed: one line, no invitation (it is
// both the in-band line and the statement, ownerReplyNotice.js).
export const correctionNotRecordedNotice = ({ language = null, profile = null, client = null } = {}) =>
  copyFor(language || preferredOwnerTemplateLanguage(profile || {}, client)).notRecorded;

// A chat channel's line before it reads a reply to a closed question as a new message.
export const closedQuestionNotice = ({ language = 'en' } = {}) => copyFor(language).closedQuestion;

// The correction block the reply writer puts on reply_processing and the
// readers carry to their receipts. Only the facts; never model output.
export const correctionOf = (request) => {
  const correction = request?.response_payload?.reply_processing?.correction;
  return correction && typeof correction === 'object' && !Array.isArray(correction) ? correction : null;
};
