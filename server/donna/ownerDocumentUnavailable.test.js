import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DOCUMENT_REQUEST_EVIDENCE_TYPES, asksOwnerForDocument, cannotBookWithoutDocumentRequest, documentReplyReader, documentUnavailableCoderInput,
  documentUnavailableFact, documentUnavailableOf, postedWithoutDocumentNotice, readDocumentRequestReply
} from './ownerDocumentUnavailable.js';

const request = { id: 'ask-1', transaction_id: 'tx-1', audience: 'client', evidence_type: 'payroll_package', question: 'Please send the payroll journal.',
  response_payload: { reply: 'Palkkajournaalia ei ole.', responded_at: '2026-11-10T10:00:00.000Z' } };

test('document-requesting line questions are the four document kinds, addressed to the owner', () => {
  assert.deepEqual(DOCUMENT_REQUEST_EVIDENCE_TYPES, ['supporting_document', 'bank_statement', 'payroll_package', 'document_discrepancy']);
  assert.equal(asksOwnerForDocument(request), true);
  assert.equal(asksOwnerForDocument({ ...request, evidence_type: 'business_purpose' }), false, 'a purpose question asks for a fact');
  assert.equal(asksOwnerForDocument({ ...request, transaction_id: null }), false, 'a document-anchored ask has its own reader');
  assert.equal(asksOwnerForDocument({ ...request, audience: 'seat' }), false);
});

test('the reader is the strong interpreter with a closed set; it never matches words', async () => {
  let seen = null;
  const reading = await readDocumentRequestReply({ request, interpret: async (args) => { seen = args;
    return { answer: { outcome: 'no_such_document' }, confidence: 0.96, clarification: null, needsClarification: false, model: 'strong', promptVersion: 'v1' }; } });
  assert.deepEqual(reading, { outcome: 'no_such_document', clarification: null, confidence: 0.96, model: 'strong', prompt_version: 'v1' });
  assert.equal(seen.adapter, documentReplyReader);
  assert.equal(seen.context.reply, 'Palkkajournaalia ei ole.');
  assert.equal(documentReplyReader.validateAnswer({ outcome: 'no_such_document' }), true);
  assert.equal(documentReplyReader.validateAnswer({ outcome: 'maybe' }), false);
  assert.equal(documentReplyReader.validateAnswer({ outcome: 'no_such_document', extra: 1 }), false);
  const unclear = await readDocumentRequestReply({ request, interpret: async () => ({ answer: null, confidence: 0.4, clarification: 'Which?', needsClarification: true, model: 'strong', promptVersion: 'v1' }) });
  assert.deepEqual([unclear.outcome, unclear.clarification], [null, 'Which?']);
});

test('a reader that cannot answer is the clock\'s named outage; an answer outside the contract keeps its own code', async () => {
  await assert.rejects(readDocumentRequestReply({ request, interpret: async () => { throw Object.assign(new Error('down'), { code: 'LLM_HTTP_ERROR' }); } }),
    { code: 'OWNER_REPLY_PROVIDER_UNAVAILABLE', cause_code: 'LLM_HTTP_ERROR' });
  await assert.rejects(readDocumentRequestReply({ request, interpret: async () => { throw Object.assign(new Error('bad'), { code: 'OWNER_REPLY_INTERPRETATION_INVALID' }); } }),
    { code: 'OWNER_REPLY_INTERPRETATION_INVALID' });
});

test('the fact records who said it, when and in their words; the coder sees it as a fact', () => {
  const fact = documentUnavailableFact({ request, replyKey: 'k1', actorId: 'member-1', actorType: 'client', reading: { model: 'strong', prompt_version: 'v1', confidence: 0.96 } });
  assert.deepEqual([fact.stated_by, fact.stated_at, fact.words, fact.evidence_type, fact.reply_key], ['member-1', '2026-11-10T10:00:00.000Z', 'Palkkajournaalia ei ole.', 'payroll_package', 'k1']);
  assert.deepEqual(documentUnavailableOf({ owner_document_unavailable: fact }), fact);
  assert.equal(documentUnavailableOf({ owner_document_unavailable: { basis: 'other' } }), null);
  assert.deepEqual(Object.keys(documentUnavailableCoderInput(fact)), ['owner_stated_no_such_document']);
  assert.deepEqual(documentUnavailableCoderInput(null), {});
});

test('the owner\'s lines say what was done or what cannot be booked, in their language', () => {
  const line = { description: 'VR MATKUSTAJALIIKENNE VR.FI', date: '2025-02-21', money_out: 28.6, currency: 'EUR' };
  assert.equal(postedWithoutDocumentNotice({ language: 'fi', line, account: '7300 · Matkakulut', taxTreatment: 'Vähennyskelvoton ALV (osto)', evidenceType: 'document_discrepancy' }),
    'Kirjasin tapahtuman “VR MATKUSTAJALIIKENNE VR.FI” 2025-02-21 (28,60 EUR) tilille 7300 · Matkakulut (Vähennyskelvoton ALV (osto)) ilman pyytämääni asiakirjaa (korjattu tosite), koska kerroit, ettei sitä ole.');
  assert.match(postedWithoutDocumentNotice({ language: 'en', line, account: 'Travel', evidenceType: 'supporting_document' }), /^I booked “VR MATKUSTAJALIIKENNE VR\.FI” 2025-02-21 \(28\.60 EUR\) to Travel without the document I asked for \(the receipt or source document\), because you told me there is none\.$/);
  assert.match(cannotBookWithoutDocumentRequest({ language: 'en', line, evidenceType: 'payroll_package' }), /cannot be booked without the payroll journal/);
  assert.match(cannotBookWithoutDocumentRequest({ language: 'fi', line, evidenceType: 'bank_statement' }), /ei voi kirjata kirjanpitoon ilman asiakirjaa: tiliote\./);
});
