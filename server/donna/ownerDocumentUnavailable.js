// "I have no such document" — an answer every document-requesting question can take.
//
// A line question that asks the owner for a document (a receipt, a corrected
// receipt, the payroll journal, a statement, a filing) has, besides "here it
// is" and an unclear reply, one more truthful answer: the document does not
// exist, or the owner does not have it and cannot get it. That is a fact about
// the owner's world. Donna records it on the question (who said it, when, in
// their words) and on the line, decides the line again with that fact in
// front of its normal decider, and does the best the fact allows herself:
//   - where the deterministic posting checks allow a posting without the
//     document, she books it, says so in one line in the owner's language,
//     and the coding carries that this was its basis;
//   - where they do not, the line rests as ONE open request on the owner that
//     says what cannot be booked without the document and what would unblock
//     it (convergence: on the owner).
// Once recorded, no later sweep, clock tick or re-coding asks for a document
// for that line again (codingAutoPost.js, createClientEvidenceRequestWithClient).
//
// The reader is the strong owner-reply interpreter (ownerReplyInterpreter.js)
// with a closed set of outcomes; nothing here matches words. It is read by the
// coder's reply path (db/asks.js recodeTransactionAfterClientReplyWithClient)
// under the owner-reply worker's lease and bounded failures
// (ownerReplyRecovery.js). Market-neutral: no country rule lives here — what
// may be posted is the country posting policy's, read through the existing
// posting writer's own checks.
//
// Leaf module (the language resolver only; the interpreter is loaded when a
// reply is read, so the coder contract can import the fact's shape from here).
import { preferredOwnerTemplateLanguage } from './ownerLanguage.js';

// The line question kinds that ask the owner for a document (the bank-line
// evidence vocabulary, askPipeline.js ASK_EVIDENCE_TYPES, minus the purpose
// question 'business_purpose', which asks for a fact, not a document).
export const DOCUMENT_REQUEST_EVIDENCE_TYPES = Object.freeze(['supporting_document', 'bank_statement', 'payroll_package', 'document_discrepancy']);
export const DOCUMENT_REPLY_OUTCOMES = Object.freeze({
  noSuchDocument: 'no_such_document',
  documentToFollow: 'document_to_follow',
  answeredOtherwise: 'answered_otherwise'
});
export const DOCUMENT_UNAVAILABLE_ACTIONS = Object.freeze({
  posted: 'owner_has_no_such_document_posted',
  rests: 'owner_has_no_such_document_cannot_book'
});
// The basis a posting made without the document carries on its coding.
export const DOCUMENT_UNAVAILABLE_BASIS = 'owner_stated_no_such_document';

export const isDocumentRequestEvidenceType = (evidenceType) => DOCUMENT_REQUEST_EVIDENCE_TYPES.includes(String(evidenceType || ''));

// A bank-line question to the owner that asks for a document.
export const asksOwnerForDocument = (request) => Boolean(request?.transaction_id)
  && String(request?.audience || 'client') === 'client'
  && isDocumentRequestEvidenceType(request?.evidence_type);

// The reader's contract on the shared interpreter: one closed outcome.
export const documentReplyReader = Object.freeze({
  action: 'owner_document_reply',
  instructions: 'The question asked the owner for a document about one bank line. Classify the owner\'s reply into exactly one outcome. '
    + '"no_such_document": the owner states that the document asked for does not exist, or that they do not have it and cannot obtain it, in any wording or language (for example "there is no corrected receipt", "we have no payroll journal", "ei ole", "minulla ei ole sitä", "I lost it and cannot get a copy"). '
    + 'A reply that states the document does not exist is this outcome even when it also gives facts, for example confirming that the date or figures on the held document are right. '
    + '"document_to_follow": the owner says they will send it, are getting it, or it is on its way. '
    + '"answered_otherwise": the owner answers with facts or an explanation and does not say whether the document exists (a date, what the payment was, where the document can be found). '
    + 'When you choose an outcome, clarification is null. Only when the reply fits none of these, or only says the owner does not know or will check, return a clarification and no outcome. Never infer an outcome the reply does not state.',
  answerSchema: Object.freeze({ type: 'object', additionalProperties: false, required: ['outcome'],
    properties: { outcome: { type: 'string', enum: Object.values(DOCUMENT_REPLY_OUTCOMES) } } }),
  validateAnswer: (answer) => Boolean(answer && typeof answer === 'object' && !Array.isArray(answer)
    && Object.keys(answer).length === 1 && Object.values(DOCUMENT_REPLY_OUTCOMES).includes(answer.outcome))
});

const READER_INVALID_CODES = new Set(['OWNER_REPLY_INTERPRETATION_INVALID']);

// One strong reading of the persisted reply. A provider that cannot answer is
// the clock's outage (OWNER_REPLY_PROVIDER_UNAVAILABLE: bounded retries, then
// the cooldown re-entry); an answer outside the contract keeps its own code.
export const readDocumentRequestReply = async ({ request, line = null, heldDocument = null, env = process.env, fetchImpl = globalThis.fetch, interpret = null }) => {
  const context = {
    ask_id: request.id, evidence_type: request.evidence_type, question: request.question,
    reply: request.response_payload?.reply || '', replied_at: request.response_payload?.responded_at || null,
    line: line ? { date: line.date || null, description: line.description || '', money_in: Number(line.money_in || 0),
      money_out: Number(line.money_out || 0), currency: line.currency || line.account_currency || '' } : null,
    held_document: heldDocument ? { filename: heldDocument.filename || '', document_type: heldDocument.document_type || '' } : null
  };
  let interpretation;
  try {
    const read = interpret || (await import('./ownerReplyInterpreter.js')).interpretOwnerReply;
    interpretation = await read({ request, adapter: documentReplyReader, context, env, fetchImpl });
  } catch (error) {
    if (READER_INVALID_CODES.has(error?.code)) throw error;
    throw Object.assign(new Error(`The reply reader is unavailable: ${String(error?.message || error).slice(0, 200)}`),
      { code: 'OWNER_REPLY_PROVIDER_UNAVAILABLE', cause_code: error?.code || null, ...(error?.interpretation ? { interpretation: error.interpretation } : {}) });
  }
  return {
    outcome: interpretation.needsClarification ? null : interpretation.answer?.outcome || null,
    clarification: interpretation.needsClarification ? interpretation.clarification : null,
    confidence: interpretation.confidence, model: interpretation.model, prompt_version: interpretation.promptVersion
  };
};

// The fact as recorded on the question and the line: who said it, when, in
// their words, and what had been asked for. Only facts; the reader's receipt
// rides beside them.
export const documentUnavailableFact = ({ request, replyKey, actorId, actorType, reading }) => ({
  basis: DOCUMENT_UNAVAILABLE_BASIS,
  evidence_request_id: request.id,
  evidence_type: request.evidence_type,
  asked: String(request.question || '').slice(0, 600),
  stated_by: actorId, stated_by_type: actorType,
  stated_at: request.response_payload?.responded_at || null,
  words: String(request.response_payload?.reply || '').slice(0, 2000),
  reply_key: replyKey,
  read_by: { model: reading?.model || null, prompt_version: reading?.prompt_version || null, confidence: reading?.confidence ?? null }
});

// The fact a line already carries, or null.
export const documentUnavailableOf = (transactionPayload) => {
  const fact = transactionPayload?.owner_document_unavailable;
  return fact && typeof fact === 'object' && !Array.isArray(fact) && fact.basis === DOCUMENT_UNAVAILABLE_BASIS ? fact : null;
};

// What the coder is shown (transactionLlm.js): the fact, never an instruction.
export const documentUnavailableCoderInput = (fact) => (fact ? {
  owner_stated_no_such_document: { evidence_type: fact.evidence_type, asked: fact.asked, owner_words: fact.words, stated_at: fact.stated_at,
    meaning: 'The owner has stated that the document asked for does not exist or cannot be obtained. No further document will come for this line.' }
} : {});

// ── The owner's lines (the language resolver's; en and fi) ──
const DOCUMENT_WORDS = Object.freeze({
  en: Object.freeze({ supporting_document: 'the receipt or source document', bank_statement: 'the statement', payroll_package: 'the payroll journal (gross pay, withholding, employer contributions and liabilities)', document_discrepancy: 'a corrected document' }),
  fi: Object.freeze({ supporting_document: 'kuitti tai muu tosite', bank_statement: 'tiliote', payroll_package: 'palkkakirjanpidon tosite (palkkajournaali: bruttopalkat, ennakonpidätykset, työnantajamaksut ja velat)', document_discrepancy: 'korjattu tosite' })
});
const money = (value, language) => {
  const text = Math.abs(Number(value || 0)).toFixed(2);
  return language === 'fi' ? text.replace('.', ',') : text;
};
const lineLabel = ({ line = {}, language }) => {
  const amount = Math.abs(Number(line.money_out || 0)) || Math.abs(Number(line.money_in || 0));
  const currency = String(line.currency || line.account_currency || '').toUpperCase();
  const description = String(line.description || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const date = String(line.date || line.transaction_date || '').slice(0, 10);
  return `“${description}” ${date}${amount ? ` (${money(amount, language)}${currency ? ` ${currency}` : ''})` : ''}`.trim();
};
export const ownerLanguageFor = ({ profile = null, client = null } = {}) => preferredOwnerTemplateLanguage(profile || {}, client);

// Booked without the document: what was done and why, one line, no invitation.
export const postedWithoutDocumentNotice = ({ language = 'en', line = {}, account = '', taxTreatment = '', evidenceType = '' } = {}) => {
  const words = (DOCUMENT_WORDS[language] || DOCUMENT_WORDS.en)[evidenceType] || (DOCUMENT_WORDS[language] || DOCUMENT_WORDS.en).supporting_document;
  const treatment = taxTreatment ? ` (${taxTreatment})` : '';
  if (language === 'fi') return `Kirjasin tapahtuman ${lineLabel({ line, language })} tilille ${account}${treatment} ilman pyytämääni asiakirjaa (${words}), koska kerroit, ettei sitä ole.`;
  return `I booked ${lineLabel({ line, language })} to ${account}${treatment} without the document I asked for (${words}), because you told me there is none.`;
};

// Cannot be booked without the document: what, and what would unblock it.
export const cannotBookWithoutDocumentRequest = ({ language = 'en', line = {}, evidenceType = '' } = {}) => {
  const words = (DOCUMENT_WORDS[language] || DOCUMENT_WORDS.en)[evidenceType] || (DOCUMENT_WORDS[language] || DOCUMENT_WORDS.en).supporting_document;
  if (language === 'fi') return `Tapahtumaa ${lineLabel({ line, language })} ei voi kirjata kirjanpitoon ilman asiakirjaa: ${words}. Kirjasin, että sinulla ei ole sitä. Kirjaan tapahtuman heti, kun asiakirja on saatavilla – lähetä se tähän, jos saat sen myöhemmin (esimerkiksi palkanlaskennasta, myyjältä tai pankista).`;
  return `${lineLabel({ line, language })} cannot be booked without ${words}. I have recorded that you do not have it. I will book it as soon as that document is available: send it here if you get it later (for example from your payroll service, the seller or the bank).`;
};
