// FI-6 opening-balance owner route: specialized ask resolution for the WhatsApp
// anchored-answer loop. It is intentionally I/O-injectable: tests run without DB,
// LLM, or WhatsApp; production passes the existing ask/send/post functions.

import {
  classifyOpeningIntake,
  confirmOpeningBalanceIntake,
  runTrialBalanceIntake
} from './openingBalanceIntake.js';

export const OPENING_BALANCE_ASK_KIND = 'opening_balance';

const clean = (value) => String(value || '').trim();
const lower = (value) => clean(value).toLowerCase();

export const isOpeningBalanceAsk = (ask = {}) => {
  ask = ask || {};
  const payload = ask.request_payload || ask.payload || {};
  return Boolean(ask.kind === OPENING_BALANCE_ASK_KIND
    || ask.evidence_type === OPENING_BALANCE_ASK_KIND
    || payload.kind === OPENING_BALANCE_ASK_KIND
    || payload.opening_balance?.kind === OPENING_BALANCE_ASK_KIND
    || payload.opening_balance);
};

const isAffirmative = (text) => /^(yes|y|kyllä|kylla|joo|juu|ok|okay|vahvistan)$/iu.test(lower(text));

const amountFromText = (text) => {
  const match = clean(text).replace(/,/g, '.').match(/(?:€|eur)?\s*([0-9]+(?:\s?[0-9]{3})*(?:\.\d{1,2})?)\s*(?:€|eur)?/i);
  if (!match) return null;
  const amount = Number(match[1].replace(/\s/g, ''));
  return Number.isFinite(amount) ? amount : null;
};

const isBankOnlyText = (text) => /(bank|pankki|pankkisaldo|saldo|cash|käteinen|kateinen)/iu.test(lower(text));
const confirmsCashOnly = (text) => /(only|just|sole|pelkk[aä]|pelk[aä]ll[aä]|vain|ainoastaan|ei muuta)/iu.test(lower(text));

// The route's own owner lines, per owner language (preferredOwnerTemplateLanguage,
// passed in as `language`). English is the historical copy, unchanged; anything
// but 'fi' gets it. The confirm tail and the posted line were Finnish for every
// owner; an owner who chose English now gets them in English (the English tail
// invites “yes”, which isAffirmative reads).
const OPENING_ROUTE_COPY = Object.freeze({
  en: Object.freeze({
    openingLine: 'Opening line',
    summaryLine: (label, amount, currency) => `• ${label} — ${amount.toFixed(2)} ${currency}`,
    total: (total, currency) => `Total: ${total.toFixed(2)} ${currency}`,
    nudge: 'Please reply “kyllä” or “yes” if you want me to post this opening balance. If anything is wrong, send the corrected figures instead.',
    clarify: 'Could you clarify your opening balance figures?',
    confirmTail: 'Confirm by replying “yes” and I will post the opening balance.',
    posted: 'Opening balance posted.'
  }),
  fi: Object.freeze({
    openingLine: 'Avaava erä',
    summaryLine: (label, amount, currency) => `• ${label}: ${amount.toFixed(2).replace('.', ',')} ${currency}`,
    total: (total, currency) => `Yhteensä: ${total.toFixed(2).replace('.', ',')} ${currency}`,
    nudge: 'Vastaa “kyllä”, jos haluat, että kirjaan tämän avaavan taseen. Jos jokin on väärin, lähetä korjatut luvut.',
    clarify: 'Voisitko tarkentaa avaavan taseen lukuja?',
    confirmTail: 'Vahvista vastaamalla “kyllä”, niin kirjaan avaavan taseen.',
    posted: 'Avaava tase kirjattu.'
  })
});
const routeCopyFor = (language) => OPENING_ROUTE_COPY[language] || OPENING_ROUTE_COPY.en;

const lineAmount = (line = {}) => Number(line.debit || line.credit || line.amount || 0) || 0;
const lineLabel = (line = {}, language = 'en') => [line.account_code || line.code, line.account_name || line.name].filter(Boolean).join(' ') || routeCopyFor(language).openingLine;

export const summarizeOpeningBalanceProposal = (verdict = {}, { language = 'en' } = {}) => {
  const copy = routeCopyFor(language);
  const proposal = verdict.proposal || {};
  const currency = proposal.currency || 'EUR';
  const lines = Array.isArray(proposal.openingLines) ? proposal.openingLines : [];
  const rendered = lines.map((line) => copy.summaryLine(lineLabel(line, language), lineAmount(line), currency));
  rendered.push(copy.total(Number(proposal.total) || 0, currency));
  return rendered.join('\n');
};

// The ask payload is the ONLY state source — the route is a pure function of the
// persisted ask (render-the-persisted-verdict; no side-channel state getter).
const stateFromAsk = ({ ask }) => {
  const payload = ask?.request_payload || ask?.payload || {};
  const raw = payload.opening_balance || {};
  // Legacy unwrap: early confirm-request asks persisted the state one level deeper
  // (`opening_balance: { kind, state: {...} }`); flatten so `verdict`/`phase` read the same.
  return raw.state && typeof raw.state === 'object' ? { kind: raw.kind, ...raw.state } : raw;
};

const createOpeningAsk = async ({ createAsk, firmId, clientId, parentAsk, kind, question, state, actorId }) => {
  if (typeof createAsk !== 'function') return { question, kind, state };
  return createAsk({
    firmId,
    clientId,
    parentAskId: parentAsk?.id || null,
    kind: OPENING_BALANCE_ASK_KIND,
    evidenceType: OPENING_BALANCE_ASK_KIND,
    question,
    actorId,
    requestPayload: {
      kind: OPENING_BALANCE_ASK_KIND,
      // Flat state: `stateFromAsk` spreads `payload.opening_balance` directly, so
      // `phase`/`verdict`/`summary` MUST live at this level (nesting them under a
      // `state` key broke the confirm-post read — verdict arrived undefined).
      opening_balance: { kind, ...state }
    }
  });
};

export const buildOpeningBalanceAuthorityBasis = ({ message = {}, phoneHash = null } = {}) => ({
  source: 'owner_whatsapp_confirmation',
  provider: 'whatsapp',
  providerMessageId: message.id || message.message_id || null,
  sentAt: message.timestamp || message.sent_at || message.received_at || null,
  phoneHash: phoneHash || null
});

export const resolveOpeningBalanceInbound = async ({
  firmId,
  clientId,
  ask = {},
  documentText = '',
  replyText = '',
  firmContext = null,
  entityType = 'toiminimi',
  currency = 'EUR',
  asOf = null,
  message = {},
  phoneHash = null,
  actorId = null,
  flagActs = true,
  apiKey,
  fetchImpl,
  runTrialBalanceIntakeImpl = runTrialBalanceIntake,
  classifyOpeningIntakeImpl = classifyOpeningIntake,
  confirmOpeningBalanceIntakeImpl = confirmOpeningBalanceIntake,
  createAsk,
  sendText,
  resolveAsk,
  postImpl,
  // The owner's language (preferredOwnerTemplateLanguage); absent ⇒ English.
  language = 'en'
} = {}) => {
  if (!flagActs) return { action: 'skipped', reason: 'flag_off' };
  const copy = routeCopyFor(language);

  const state = stateFromAsk({ ask });
  const phase = state.phase || state.kind || 'intake';
  const text = clean(replyText);

  // Two-terminal-states: resolve the ANSWERED ask on each transition so exactly one
  // opening_balance ask is ever open per client. Without this, answered asks pile up
  // 'open' — a firm-side limbo AND a break of resolveInboundAnchor's unique-ref match
  // (multiple open opening_balance asks ⇒ ref_not_unique on the owner's next reply).
  // NOT called on a nudge/duplicate: an ambiguous confirm reply leaves the
  // confirm-request ask open (still on the owner), which is correct.
  const closeAnsweredAsk = async (resolutionNote) => {
    if (typeof resolveAsk === 'function' && ask?.id) {
      await resolveAsk({ firmId, askId: ask.id, resolutionNote, actorId });
    }
  };

  if (phase === 'confirm_request') {
    if (!isAffirmative(text)) {
      const nudgeText = copy.nudge;
      if (typeof sendText === 'function') await sendText({ text: nudgeText });
      return { action: 'nudge', reason: 'ambiguous_confirmation', ask, text: nudgeText };
    }
    // No route-level replay check: duplicate inbound messages are dead before this
    // runs — the channel claims every inbound message id exactly once
    // (claimInboundMessage in inboundCore), and a successful post RESOLVES this
    // confirm-request ask, so a later "kyllä" has no open ask to anchor to.
    const authorityBasis = buildOpeningBalanceAuthorityBasis({ message, phoneHash });
    if (!authorityBasis.providerMessageId || !authorityBasis.phoneHash || !actorId) {
      throw Object.assign(new Error('Opening-balance confirmation requires provider message id, phone hash, and owner actor id.'), { code: 'OPENING_BALANCE_AUTHORITY_REQUIRED' });
    }
    const verdict = state.verdict;
    const receipt = await confirmOpeningBalanceIntakeImpl({ firmId, clientId, asOf, verdict, authorityBasis, actorId, postImpl });
    await closeAnsweredAsk('opening_balance_posted');
    if (typeof sendText === 'function') await sendText({ text: copy.posted });
    return { action: 'confirm_and_post', verdict, authorityBasis, actorId, receipt };
  }

  let verdict;
  if (isBankOnlyText(text) && amountFromText(text) !== null && !documentText) {
    verdict = classifyOpeningIntakeImpl({
      source: 'bank_only',
      bankBalance: amountFromText(text),
      confirmedCashOnly: confirmsCashOnly(text),
      ownerMessage: text,
      entityType,
      currency,
      memo: 'Owner-provided bank-only opening balance',
      language
    });
  } else {
    verdict = await runTrialBalanceIntakeImpl({
      documentText: documentText || text,
      firmContext,
      entityType,
      currency,
      apiKey,
      fetchImpl,
      memo: state.clarification ? `Owner clarification: ${text}` : null,
      language
    });
  }

  if (verdict?.terminal === 'proposal') {
    const summary = summarizeOpeningBalanceProposal(verdict, { language });
    const question = `${summary}\n\n${copy.confirmTail}`;
    const confirmationAsk = await createOpeningAsk({
      createAsk,
      firmId,
      clientId,
      parentAsk: ask,
      kind: 'confirm_request',
      question,
      actorId,
      state: { phase: 'confirm_request', verdict, summary }
    });
    await closeAnsweredAsk('opening_balance_confirmation_requested');
    if (typeof sendText === 'function') await sendText({ text: question, ask: confirmationAsk });
    return { action: 'request_confirmation', ask: { ...confirmationAsk, summary, question }, verdict };
  }

  const escalation = verdict?.escalation || { question: copy.clarify, reason: 'unknown' };
  const escalationAsk = await createOpeningAsk({
    createAsk,
    firmId,
    clientId,
    parentAsk: ask,
    kind: 'escalation',
    question: escalation.question,
    actorId,
    state: { phase: 'escalation', verdict, clarification: true }
  });
  await closeAnsweredAsk('opening_balance_escalated');
  if (typeof sendText === 'function') await sendText({ text: escalation.question, ask: escalationAsk });
  return { action: 'escalate', ask: { ...escalationAsk, question: escalation.question }, verdict };
};
