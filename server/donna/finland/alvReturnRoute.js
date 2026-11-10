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

// The confirm summary renders the PERSISTED verdict (render-the-persisted-verdict)
// — the same boxes the filing will transmit, never a re-compute.
export const summarizeAlvReturnVerdict = ({ periodKey = '', verdict = {} } = {}) => {
  const alvReturn = verdict.alvReturn || {};
  const out = [`ALV-ilmoitus, verokausi ${periodKey}`];
  if (alvReturn.nilReturn) out.push('Ei ALV-toimintaa kaudella — nollailmoitus.');
  else if (alvReturn.refund) out.push(`Palautukseen oikeuttava vero ${euro(Math.abs(alvReturn.payable))}.`);
  else out.push(`Maksettava vero ${euro(alvReturn.payable)}.`);
  const boxes = alvReturn.boxes || {};
  const outputTax = ['301', '302', '303'].reduce((sum, f) => sum + (Number(boxes[f]) || 0), 0);
  const deductible = Number(boxes['307']) || 0;
  if (!alvReturn.nilReturn) {
    out.push(`Myynnin vero ${euro(outputTax)} · Vähennettävä vero ${euro(deductible)}.`);
  }
  return out.join('\n');
};

const CONFIRM_INSTRUCTION = 'Vahvista vastaamalla “kyllä”, niin lähetän ilmoituksen Verohallinnolle. Peru vastaamalla “ei”.';
const NUDGE_CONFIRM = 'Vastaa “kyllä” niin lähetän ALV-ilmoituksen Verohallinnolle, tai “ei” niin perun sen.';
const FILE_FAILED_TEXT = 'ALV-ilmoituksen lähetys ei onnistunut. Vastaa “kyllä” niin yritän uudelleen, tai “ei” niin perun ilmoituksen.';
// G-3: the Suomi.fi mandate is the one filing precondition only the OWNER can
// fix — granting Donna the "veroasioiden hoito" valtuutus happens in Suomi.fi,
// not in Donna. The ask stays open; the next "kyllä" retries after the grant.
const MANDATE_MISSING_TEXT = 'ALV-ilmoitusta ei voi vielä lähettää: Suomi.fi-valtuutus (veroasioiden hoito) puuttuu tai ei ole voimassa. Myönnä valtuutus Suomi.fi-valtuudet-palvelussa, niin vahvistetaan kirjaus — sen jälkeen vastaa “kyllä” uudelleen.';

// ALV_RETURN_FILING_OVERLAP: another live return already covers some of these
// dates. Nothing was sent. The owner can cancel this return ("ei"); a filed
// return stays as filed. Two returns both waiting: neither is sent until one
// is cancelled.
const OVERLAP_STATUS_WORDS = { filed: 'lähetetty', draft_pending_confirmation: 'odottaa vahvistusta' };
const filingOverlapText = ({ periodKey, error }) => {
  const others = Array.isArray(error?.details?.overlapping) ? error.details.overlapping : [];
  const named = others.map((other) => `${other.period_key} (${OVERLAP_STATUS_WORDS[other.status] || other.status})`).join(', ');
  const anyFiled = others.some((other) => other.status === 'filed');
  return [
    `ALV-ilmoitusta (${periodKey}) ei lähetetty: ${named ? `ilmoitus ${named}` : 'toinen ilmoitus'} kattaa jo osan samoista päivistä.`,
    'Samoja myyntejä ja ostoja ei voi ilmoittaa kahdesti.',
    anyFiled
      ? 'Lähetetty ilmoitus pysyy ennallaan. Peru tämä ilmoitus vastaamalla “ei”.'
      : 'Kumpaakaan ei lähetetä, ennen kuin toinen perutaan. Peru tämä ilmoitus vastaamalla “ei”.'
  ].join(' ');
};

export const alvReturnConfirmQuestion = ({ periodKey, verdict }) =>
  `${summarizeAlvReturnVerdict({ periodKey, verdict })}\n\n${CONFIRM_INSTRUCTION}`;

// The ask payload is the ONLY conversation state source; the alv_returns row is
// the ONLY verdict source. Flat state under payload.alv_return (the FI-6 lesson).
const stateFromAsk = ({ ask }) => {
  const payload = ask?.request_payload || ask?.payload || {};
  const raw = payload.alv_return || {};
  return raw.state && typeof raw.state === 'object' ? { kind: raw.kind, ...raw.state } : raw;
};

// fileConfirmedAlvReturn — the filing motion: overlap check → transmit
// (re-footed, refused without authority/mandate/channel) → mark filed with the
// receipt (audit-as-precondition, in-txn). The FI-8 channel must be idempotent
// per period — the persisted row flips only after a successful transmit, so a
// crash between the two legs retries the transmit on the next "kyllä".
//
// The overlap check (assertAlvReturnFileableInDb) runs BEFORE anything is
// transmitted: returns that overlapped before migration 172 must not both be
// reported. It refuses ALV_RETURN_FILING_OVERLAP while any other live return
// covers one of these dates. Fail-closed: no check wired ⇒ nothing transmits.
export const fileConfirmedAlvReturn = async ({
  firmId,
  clientId,
  row,
  authorityBasis,
  actorId,
  mandate = null,
  transmitImpl = transmitAlvReturnFiling,
  submitReturn,
  assertFileableImpl,
  markFiledImpl
} = {}) => {
  if (typeof assertFileableImpl !== 'function') {
    throw Object.assign(
      new Error('ALV filing refused: the overlap check before transmit is not wired.'),
      { code: 'ALV_FILING_OVERLAP_CHECK_REQUIRED' }
    );
  }
  await assertFileableImpl({ firmId, clientId, alvReturnId: row.id });
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
  assertFileableImpl,
  markFiledImpl,
  cancelImpl,
  fileImpl = fileConfirmedAlvReturn,
  transmitImpl,
  submitReturn,
  resolveAsk,
  sendText
} = {}) => {
  if (!flagActs) return { action: 'skipped', reason: 'flag_off' };

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
    if (typeof sendText === 'function') await sendText({ text: 'Tämä ALV-ilmoitus on jo käsitelty.' });
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
        assertFileableImpl,
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
        const reason = error?.code === 'ALV_RETURN_FILING_OVERLAP'
          ? filingOverlapText({ periodKey: row.period_key, error })
          : error?.code === 'ALV_FILING_MANDATE_REQUIRED'
          ? MANDATE_MISSING_TEXT
          : (error?.code === 'ALV_FILING_REJECTED' && error?.channelReason
            ? `ALV-ilmoitusta ei hyväksytty: ${error.channelReason}\n\n${FILE_FAILED_TEXT}`
            : FILE_FAILED_TEXT);
        await sendText({ text: reason });
      }
      return { action: 'file_failed', error: error?.code || error?.message || 'unknown', ask };
    }
    await closeAnsweredAsk('alv_return_filed');
    if (typeof sendText === 'function') {
      const payable = row.verdict?.alvReturn?.payable || 0;
      const parts = [`ALV-ilmoitus (${row.period_key}) lähetetty Verohallinnolle.`];
      if (row.verdict?.alvReturn?.nilReturn) parts.push('Nollailmoitus.');
      else if (payable < 0) parts.push(`Palautusta odotettavissa ${euro(Math.abs(payable))}.`);
      else parts.push(`Maksettavaa ${euro(payable)} — maksuohjeet OmaVerossa.`);
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
      await sendText({ text: `ALV-ilmoitus (${row.period_key}) peruttu. Korjataan kirjanpito ja lasken sen uudelleen.` });
    }
    return { action: 'cancelled', alvReturn: cancelled };
  }

  // Neither yes nor no: a statutory filing takes only an explicit answer.
  if (typeof sendText === 'function') await sendText({ text: NUDGE_CONFIRM });
  return { action: 'nudge', reason: 'ambiguous_confirmation', ask };
};
