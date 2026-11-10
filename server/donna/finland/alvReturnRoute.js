// FI-3 slice P — the ALV return filing owner route: the WhatsApp confirm/cancel
// state machine around a persisted alv_returns draft. Mirrors
// invoiceIssuanceRoute.js: PURE + I/O-injectable (tests run without DB, WhatsApp,
// or a filing channel). D3 (Kari, 2026-07-10) is compute-and-file — the owner's
// "kyllä" IS the filing authority (§1A guardrail 2: a scoped, audited grant,
// never a bare thumbs-up), and the transmit channel behind it is FI-8's injected
// adapter. Design: docs/design-donna-finland-fi3-alv-return.md (slice P).
//
// Deliberately NO correction flow: a wrong return is not correctable by prose —
// the owner answers "ei", the books get fixed (recode / evidence), and the lane
// re-runs a fresh compute. Only kyllä / ei / nudge exist here.

import { transmitAlvReturnFiling } from './alvReturnTransmit.js';
import { SUOMIFI_MANDATE_SCOPE_TAX } from './suomifiMandate.js';

export const ALV_RETURN_ASK_KIND = 'alv_return';

const clean = (value) => String(value || '').trim();
const lower = (value) => clean(value).toLowerCase();

export const isAlvReturnAsk = (ask = {}) => {
  ask = ask || {};
  const payload = ask.request_payload || ask.payload || {};
  return Boolean(ask.kind === ALV_RETURN_ASK_KIND
    || ask.evidence_type === ALV_RETURN_ASK_KIND
    || payload.kind === ALV_RETURN_ASK_KIND
    || payload.alv_return);
};

// Conservative explicit yes/no — the FI-6/FI-10 twins. Anything else is NEVER a
// filing and NEVER a cancel (two-terminal-states: the ask stays open, on the owner).
const isAffirmative = (text) => /^(yes|y|kyllä|kylla|joo|juu|ok|okay|vahvistan)$/iu.test(lower(text));
const isNegative = (text) => /^(no|ei|peru|peruuta|peruutus|cancel|stop)$/iu.test(lower(text));

export const buildAlvFilingAuthorityBasis = ({ message = {}, phoneHash = null } = {}) => ({
  source: 'owner_whatsapp_alv_filing_confirmation',
  provider: 'whatsapp',
  providerMessageId: message.id || message.message_id || null,
  sentAt: message.timestamp || message.sent_at || message.received_at || null,
  phoneHash: phoneHash || null
});

const euro = (n) => `${(Number(n) || 0).toFixed(2).replace('.', ',')} €`;
const euroEn = (n) => `${(Number(n) || 0).toFixed(2)} €`;

// The route's owner lines, per owner language (preferredOwnerTemplateLanguage,
// passed in as `language`). This is a Finnish lane, so an absent language keeps
// the historical Finnish copy, unchanged; 'en' (an owner who chose English) gets
// English. The English lines invite only replies the route reads (yes / no).
// G-3: the Suomi.fi mandate is the one filing precondition only the OWNER can
// fix — granting Donna the "veroasioiden hoito" valtuutus happens in Suomi.fi,
// not in Donna. The ask stays open; the next "kyllä" retries after the grant.
const ALV_ROUTE_COPY = Object.freeze({
  fi: Object.freeze({
    heading: (periodKey) => `ALV-ilmoitus, verokausi ${periodKey}`,
    nil: 'Ei ALV-toimintaa kaudella — nollailmoitus.',
    refund: (amount) => `Palautukseen oikeuttava vero ${euro(amount)}.`,
    payable: (amount) => `Maksettava vero ${euro(amount)}.`,
    taxes: (outputTax, deductible) => `Myynnin vero ${euro(outputTax)} · Vähennettävä vero ${euro(deductible)}.`,
    confirm: 'Vahvista vastaamalla “kyllä”, niin lähetän ilmoituksen Verohallinnolle. Peru vastaamalla “ei”.',
    nudge: 'Vastaa “kyllä” niin lähetän ALV-ilmoituksen Verohallinnolle, tai “ei” niin perun sen.',
    fileFailed: 'ALV-ilmoituksen lähetys ei onnistunut. Vastaa “kyllä” niin yritän uudelleen, tai “ei” niin perun ilmoituksen.',
    mandateMissing: 'ALV-ilmoitusta ei voi vielä lähettää: Suomi.fi-valtuutus (veroasioiden hoito) puuttuu tai ei ole voimassa. Myönnä valtuutus Suomi.fi-valtuudet-palvelussa, niin vahvistetaan kirjaus — sen jälkeen vastaa “kyllä” uudelleen.',
    rejected: (reason) => `ALV-ilmoitusta ei hyväksytty: ${reason}`,
    stale: 'Tämä ALV-ilmoitus on jo käsitelty.',
    filed: (periodKey) => `ALV-ilmoitus (${periodKey}) lähetetty Verohallinnolle.`,
    filedNil: 'Nollailmoitus.',
    filedRefund: (amount) => `Palautusta odotettavissa ${euro(amount)}.`,
    filedPayable: (amount) => `Maksettavaa ${euro(amount)} — maksuohjeet OmaVerossa.`,
    cancelled: (periodKey) => `ALV-ilmoitus (${periodKey}) peruttu. Korjataan kirjanpito ja lasken sen uudelleen.`,
    textOnly: 'Vastaa tekstillä: “kyllä” tai “ei”.'
  }),
  en: Object.freeze({
    heading: (periodKey) => `VAT return, tax period ${periodKey}`,
    nil: 'No VAT activity in the period, so this is a nil return.',
    refund: (amount) => `VAT to be refunded ${euroEn(amount)}.`,
    payable: (amount) => `VAT payable ${euroEn(amount)}.`,
    taxes: (outputTax, deductible) => `VAT on sales ${euroEn(outputTax)} · Deductible VAT ${euroEn(deductible)}.`,
    confirm: 'Reply “yes” to confirm and I will file the return with the Finnish Tax Administration. Reply “no” to cancel.',
    nudge: 'Reply “yes” and I will file the VAT return with the Finnish Tax Administration, or “no” and I will cancel it.',
    fileFailed: 'Filing the VAT return did not go through. Reply “yes” and I will try again, or “no” and I will cancel the return.',
    mandateMissing: 'I can\'t file the VAT return yet: the Suomi.fi authorisation for tax matters (veroasioiden hoito) is missing or no longer valid. Grant the authorisation in the Suomi.fi e-Authorizations service, then reply “yes” again.',
    rejected: (reason) => `The VAT return was not accepted: ${reason}`,
    stale: 'This VAT return has already been handled.',
    filed: (periodKey) => `VAT return (${periodKey}) filed with the Finnish Tax Administration.`,
    filedNil: 'Nil return.',
    filedRefund: (amount) => `A refund of ${euroEn(amount)} is expected.`,
    filedPayable: (amount) => `${euroEn(amount)} to pay. The payment instructions are in OmaVero.`,
    cancelled: (periodKey) => `VAT return (${periodKey}) cancelled. Let's fix the books and I will calculate it again.`,
    textOnly: 'Please reply in text: “yes” or “no”.'
  })
});
export const alvRouteCopyFor = (language) => ALV_ROUTE_COPY[language] || ALV_ROUTE_COPY.fi;

// The confirm summary renders the PERSISTED verdict (render-the-persisted-verdict)
// — the same boxes the filing will transmit, never a re-compute.
export const summarizeAlvReturnVerdict = ({ periodKey = '', verdict = {}, language = 'fi' } = {}) => {
  const copy = alvRouteCopyFor(language);
  const alvReturn = verdict.alvReturn || {};
  const out = [copy.heading(periodKey)];
  if (alvReturn.nilReturn) out.push(copy.nil);
  else if (alvReturn.refund) out.push(copy.refund(Math.abs(alvReturn.payable)));
  else out.push(copy.payable(alvReturn.payable));
  const boxes = alvReturn.boxes || {};
  const outputTax = ['301', '302', '303'].reduce((sum, f) => sum + (Number(boxes[f]) || 0), 0);
  const deductible = Number(boxes['307']) || 0;
  if (!alvReturn.nilReturn) {
    out.push(copy.taxes(outputTax, deductible));
  }
  return out.join('\n');
};

export const alvReturnConfirmQuestion = ({ periodKey, verdict, language = 'fi' }) =>
  `${summarizeAlvReturnVerdict({ periodKey, verdict, language })}\n\n${alvRouteCopyFor(language).confirm}`;

// The ask payload is the ONLY conversation state source; the alv_returns row is
// the ONLY verdict source. Flat state under payload.alv_return (the FI-6 lesson).
const stateFromAsk = ({ ask }) => {
  const payload = ask?.request_payload || ask?.payload || {};
  const raw = payload.alv_return || {};
  return raw.state && typeof raw.state === 'object' ? { kind: raw.kind, ...raw.state } : raw;
};

// fileConfirmedAlvReturn — the filing motion: transmit (re-footed, refused
// without authority/mandate/channel) → mark filed with the receipt (audit-as-
// precondition, in-txn). The FI-8 channel must be idempotent per period —
// the persisted row flips only after a successful transmit, so a crash between
// the two legs retries the transmit on the next "kyllä".
export const fileConfirmedAlvReturn = async ({
  firmId,
  clientId,
  row,
  authorityBasis,
  actorId,
  mandate = null,
  transmitImpl = transmitAlvReturnFiling,
  submitReturn,
  markFiledImpl
} = {}) => {
  const { receipt } = await transmitImpl({
    verdict: row.verdict,
    period: { key: row.period_key, type: row.period_type, starts_on: row.starts_on, ends_on: row.ends_on },
    authorityBasis,
    actorId,
    model: row.model || null,
    mandate,
    submitReturn
  });
  const filed = await markFiledImpl({
    firmId,
    clientId,
    alvReturnId: row.id,
    filingReceipt: receipt,
    authorityBasis,
    actorId
  });
  return { alvReturn: filed, receipt };
};

// resolveAlvReturnInbound — anchored replies to an alv_return confirm ask.
// Every terminal transition resolves the ANSWERED ask (two-terminal-states /
// Lesson B: each pending row keeps exactly ONE open ask); a nudge or a failed
// filing leg leaves the ask open — still on the owner, the next "kyllä" retries.
export const resolveAlvReturnInbound = async ({
  firmId,
  clientId,
  ask = {},
  replyText = '',
  message = {},
  phoneHash = null,
  actorId = null,
  flagActs = true,
  getAlvReturnImpl,
  getMandateImpl,
  markFiledImpl,
  cancelImpl,
  fileImpl = fileConfirmedAlvReturn,
  transmitImpl,
  submitReturn,
  resolveAsk,
  sendText,
  // The owner's language (preferredOwnerTemplateLanguage); absent ⇒ Finnish.
  language = 'fi'
} = {}) => {
  if (!flagActs) return { action: 'skipped', reason: 'flag_off' };
  const copy = alvRouteCopyFor(language);

  const state = stateFromAsk({ ask });
  const text = clean(replyText);

  const closeAnsweredAsk = async (resolutionNote) => {
    if (typeof resolveAsk === 'function' && ask?.id) {
      await resolveAsk({ firmId, askId: ask.id, resolutionNote, actorId });
    }
  };

  const row = state.alv_return_id && typeof getAlvReturnImpl === 'function'
    ? await getAlvReturnImpl({ firmId, clientId, alvReturnId: state.alv_return_id })
    : null;
  if (!row || row.status !== 'draft_pending_confirmation') {
    // The row already reached a terminal (filed/cancelled) — the ask is stale.
    await closeAnsweredAsk('alv_return_stale_ask');
    if (typeof sendText === 'function') await sendText({ text: copy.stale });
    return { action: 'stale', alvReturnId: state.alv_return_id || null };
  }

  if (isAffirmative(text)) {
    const authorityBasis = buildAlvFilingAuthorityBasis({ message, phoneHash });
    if (!authorityBasis.providerMessageId || !authorityBasis.phoneHash || !actorId) {
      throw Object.assign(
        new Error('ALV filing confirmation requires provider message id, phone hash, and owner actor id.'),
        { code: 'ALV_FILING_AUTHORITY_REQUIRED' }
      );
    }
    // G-3: resolve the client's Suomi.fi mandate (veroasioiden hoito) for the
    // transmit gate. Fail-closed: no lookup wired ⇒ no mandate ⇒ the transmit
    // refuses typed — a statutory filing never rides an unverified authorization.
    const mandate = typeof getMandateImpl === 'function'
      ? await getMandateImpl({ firmId, clientId, scope: SUOMIFI_MANDATE_SCOPE_TAX })
      : null;
    let filed;
    try {
      filed = await fileImpl({
        firmId,
        clientId,
        row,
        authorityBasis,
        actorId,
        mandate,
        ...(transmitImpl ? { transmitImpl } : {}),
        submitReturn,
        markFiledImpl
      });
    } catch (error) {
      // Any failed leg leaves the row pending and the ask OPEN (still on the
      // owner) — the next "kyllä" retries against an idempotent channel. A
      // channel REJECTION carries its reason verbatim (FI-8): the owner must
      // see what Verohallinto refused, not a paraphrase. A missing/invalid
      // Suomi.fi mandate gets its own copy — granting it is an OWNER action
      // (Suomi.fi valtuudet), so the ask legitimately rests on them.
      if (typeof sendText === 'function') {
        const reason = error?.code === 'ALV_FILING_MANDATE_REQUIRED'
          ? copy.mandateMissing
          : (error?.code === 'ALV_FILING_REJECTED' && error?.channelReason
            ? `${copy.rejected(error.channelReason)}\n\n${copy.fileFailed}`
            : copy.fileFailed);
        await sendText({ text: reason });
      }
      return { action: 'file_failed', error: error?.code || error?.message || 'unknown', ask };
    }
    await closeAnsweredAsk('alv_return_filed');
    if (typeof sendText === 'function') {
      const payable = row.verdict?.alvReturn?.payable || 0;
      const parts = [copy.filed(row.period_key)];
      if (row.verdict?.alvReturn?.nilReturn) parts.push(copy.filedNil);
      else if (payable < 0) parts.push(copy.filedRefund(Math.abs(payable)));
      else parts.push(copy.filedPayable(payable));
      await sendText({ text: parts.join(' ') });
    }
    return { action: 'confirm_and_file', authorityBasis, actorId, ...filed };
  }

  if (isNegative(text)) {
    const authorityBasis = buildAlvFilingAuthorityBasis({ message, phoneHash });
    const cancelled = await cancelImpl({
      firmId, clientId, alvReturnId: row.id, reason: 'owner_declined', authorityBasis, actorId
    });
    await closeAnsweredAsk('alv_return_cancelled');
    if (typeof sendText === 'function') {
      await sendText({ text: copy.cancelled(row.period_key) });
    }
    return { action: 'cancelled', alvReturn: cancelled };
  }

  // Neither yes nor no: a statutory filing takes only an explicit answer.
  if (typeof sendText === 'function') await sendText({ text: copy.nudge });
  return { action: 'nudge', reason: 'ambiguous_confirmation', ask };
};
