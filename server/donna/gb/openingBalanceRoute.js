import { normalizeGbOpeningBalanceIntake } from './cutover.js';

const defaultPost = async (args) => (await import('../firmDb.js')).postGbOpeningBalanceJournalFromDb(args);

export const GB_OPENING_BALANCE_ASK_KIND = 'gb_opening_balance';
const lower = (value) => String(value || '').trim().toLowerCase();
// The owner questions, per owner language (preferredOwnerTemplateLanguage, passed
// in as `language`). English is the historical copy: the intake's own question
// and the confirm line below, unchanged. The Finnish confirm line invites the
// literal “yes”, because that is the word this route reads; the reply parser is
// not changed here.
const GB_OPENING_QUESTIONS_FI = Object.freeze({
  GB_OPENING_BALANCE_DECLARATION_REQUIRED: () => 'Lähetä avaava tase punnissa (GBP) niin, että jokainen rivi on liitetty tilin rooliin.',
  GB_OPENING_BALANCE_CANONICAL_ROLE_REQUIRED: (verdict) => `Liitä yksi tili jokaiseen puuttuvaan tai epäselvään rooliin: ${(verdict.missing_roles || []).join(', ')}.`,
  GB_OPENING_BALANCE_CONTROL_MISMATCH: (verdict) => {
    const mismatch = (verdict.checks || []).find((check) => check.delta !== 0);
    return mismatch ? `Täsmäytä kohdan ${mismatch.code} erotus, ${Math.abs(mismatch.delta).toFixed(2).replace('.', ',')} GBP.` : null;
  }
});
const GB_CONFIRM_QUESTION = Object.freeze({
  en: 'Please confirm this GBP opening trial balance by replying “yes”.',
  fi: 'Vahvista tämä avaava tase (GBP) vastaamalla “yes”.'
});
const ownerQuestionFor = (verdict, language) => (language === 'fi' && GB_OPENING_QUESTIONS_FI[verdict.code]?.(verdict)) || verdict.question;

export const isGbOpeningBalanceAsk = (ask = {}) => ask?.evidence_type === GB_OPENING_BALANCE_ASK_KIND || ask?.request_payload?.kind === GB_OPENING_BALANCE_ASK_KIND;

export const resolveGbOpeningBalanceInbound = async ({ firmId, clientId, ask = {}, replyText = '', intake = null, currentFiscalPeriodId = null, actorId, authorityBasis = null, message = {}, phoneHash = null, createAsk, resolveAsk, postImpl, flagActs = true, language = 'en' } = {}) => {
  if (!flagActs) return { action: 'skipped', reason: 'flag_off' };
  const close = async (note) => { if (ask.id && resolveAsk) await resolveAsk({ firmId, askId: ask.id, resolutionNote: note, actorId }); };
  const payload = ask.request_payload || ask.requestPayload || {};
  const phase = payload.gb_opening_balance?.phase || 'intake';
  if (/^(cancel|cancelled|no)$/u.test(lower(replyText))) {
    await close('gb_opening_balance_cancelled');
    return { action: 'cancelled' };
  }
  if (phase === 'confirm_request') {
    const state = payload.gb_opening_balance;
    if (currentFiscalPeriodId && String(state.fiscal_period_id || '') !== String(currentFiscalPeriodId)) {
      await close('gb_opening_balance_stale');
      return { action: 'stale' };
    }
    if (!/^(yes|confirm|confirmed)$/u.test(lower(replyText))) return { action: 'nudge', ask };
    const receiptAuthority = authorityBasis || { source: 'owner_channel_confirmation', providerMessageId: message.id || message.message_id || null, phoneHash };
    if (!actorId || !receiptAuthority.providerMessageId || !receiptAuthority.phoneHash) throw Object.assign(new Error('GB opening-balance confirmation requires the owner actor and channel receipt.'), { code: 'OPENING_BALANCE_AUTHORITY_REQUIRED' });
    const receipt = await (postImpl || defaultPost)({ firmId, clientId, asOf: state.as_of, openingLines: state.proposal.openingLines, currency: 'GBP', authorityBasis: receiptAuthority, actorId });
    await close('gb_opening_balance_posted');
    return { action: 'confirm_and_post', receipt };
  }
  const verdict = normalizeGbOpeningBalanceIntake(intake || {});
  if (verdict.terminal === 'owner_ask') {
    const next = await createAsk({ firmId, clientId, evidenceType: GB_OPENING_BALANCE_ASK_KIND, question: ownerQuestionFor(verdict, language), actorId, requestPayload: { kind: GB_OPENING_BALANCE_ASK_KIND, gb_opening_balance: { phase: 'intake', verdict } } });
    await close('gb_opening_balance_clarification_requested');
    return { action: 'escalate', ask: next, verdict };
  }
  const next = await createAsk({ firmId, clientId, evidenceType: GB_OPENING_BALANCE_ASK_KIND, question: GB_CONFIRM_QUESTION[language] || GB_CONFIRM_QUESTION.en, actorId, requestPayload: { kind: GB_OPENING_BALANCE_ASK_KIND, gb_opening_balance: { phase: 'confirm_request', proposal: verdict.proposal, as_of: intake.as_of, fiscal_period_id: intake.fiscal_period_id } } });
  await close('gb_opening_balance_confirmation_requested');
  return { action: 'request_confirmation', ask: next, verdict };
};
