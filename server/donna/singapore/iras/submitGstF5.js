// SG-8 — the IRAS GST filing adapter behind SG-3's `submitReturn` seam,
// mirroring finland/omavero/submitAlvReturn.js 1:1.
//
// Two layers, kept separate (the verkkolaskuTransmit discipline):
//   • PURE — renderGstF5Submission: the F5 submission payload for a footed GST
//     return verdict. KEEP-layer only (UEN structural check, the box-4/box-8
//     identities re-run, period validation); no model call anywhere in this file.
//   • I/O-INJECTABLE — createIrasSubmitGstF5: the factory producing the seam's
//     ONE injected function. The wire transport is itself injected; the DEFAULT
//     transport refuses (typed, retryable) until follow-up F-SG-2 confirms the
//     IRAS myTax API protocol (the published "GST Return – F5" API family:
//     endpoints, auth envelope — CorpPass-authenticated OAuth, ack shape)
//     against the primary sources from a network-open session. A tax-authority
//     submission never runs on guessed bytes: the renderer's unconfirmed
//     details are inert until the confirmed transport replaces the pending one.
//
// Contract upstream (gstReturnTransmit.js — do NOT rebuild): the verdict is
// re-footed and the owner's authority receipt + CorpPass grant recorded before
// this is called; a THROW leaves the gst_returns row pending and the chat ask
// OPEN (the next "yes" retries) — so refusals here are typed and idempotency is
// per (client, period): a deterministic reference rides every transport call,
// and the adapter itself NEVER retries (double-filing protection is the
// channel's duplicate handling + the one-live-row-per-period unique index
// upstream).

import { isValidUen } from '../entity.js';
import { GST_F5_BOXES, GST_SUPPLY_BOXES_IN_4 } from '../gstCodes.js';

const clean = (value) => String(value ?? '').trim();
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

export const GST_FILING_CHANNEL = 'iras_mytax_api';

const refusal = (message, code, extra = {}) => Object.assign(new Error(message), { code, ...extra });

// ---------------------------------------------------------------------------------
// Provenance — the-model-id-is-part-of-the-receipt discipline, applied to the
// submission payload layout (the VSRALVKV_RECORD_PROVENANCE pattern).
// ---------------------------------------------------------------------------------
// IRAS publishes a GST F5 submission API on its API Marketplace (apiservices.
// iras.gov.sg — the "GST Return – F5" family, CorpPass-authenticated). The
// payload shape below follows the F5 box structure; the exact field names, auth
// envelope, and ack shape are subject to the F-SG-2 primary confirmation — the
// container's network policy blocks a byte-level read of the API spec
// (iras.gov.sg unreachable, verified 2026-07-23). F-SG-2 MUST re-confirm every
// field and flip `confirmedAgainstPrimary` in the same commit — the pending
// default transport guarantees nothing transmits before that.
export const GST_F5_SUBMISSION_PROVENANCE = Object.freeze({
  confirmedAgainstPrimary: false,
  source: 'IRAS API Marketplace GST Return – F5 API family via training-corpus knowledge 2026-07-23; primary fetch blocked by network policy (F-SG-2)'
});

// The deterministic idempotency reference per (filer, period) — identical on
// every retry of the same filing, so the channel's duplicate handling can
// recognise a re-submit. Pure string assembly, no timestamp on purpose.
export const gstFilingReference = ({ uen, periodKey } = {}) =>
  `GSTF5/${clean(uen)}/${clean(periodKey)}`;

const periodFields = (period = {}) => {
  const type = clean(period.type).toLowerCase();
  const key = clean(period.key);
  const starts = clean(period.starts_on).slice(0, 10);
  const ends = clean(period.ends_on).slice(0, 10);
  if (!['month', 'quarter'].includes(type)) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(starts) || !/^\d{4}-\d{2}-\d{2}$/.test(ends)) return null;
  if (type === 'month' && !/^\d{4}-\d{2}$/.test(key)) return null;
  if (type === 'quarter' && !/^\d{4}-Q[1-4]$/i.test(key)) return null;
  return { type, key, starts, ends };
};

// ---------------------------------------------------------------------------------
// renderGstF5Submission — the pure payload renderer. Never throws.
// ---------------------------------------------------------------------------------
// { period, boxes, payable, nilReturn, filer: { uen, gstRegistrationNumber } }
// → { ok, errors, submission: { reference, payload } }.
// KEEP-layer refusals (ok:false): structurally invalid UEN, unresolvable
// period, a box set that does not re-foot (the box-4 + box-8 identities, run
// AGAIN here — defense in depth on the last surface before the wire), unknown
// box ids.
export const renderGstF5Submission = ({
  period = {},
  boxes = {},
  payable = 0,
  nilReturn = false,
  filer = {}
} = {}) => {
  const errors = [];

  const uen = clean(filer.uen).toUpperCase();
  if (!isValidUen(uen)) {
    errors.push('filer.uen must be a structurally valid UEN');
  }
  // The GST registration number defaults to the UEN (the common case); an
  // M-prefixed special registration rides verbatim when supplied.
  const gstRegNo = clean(filer.gstRegistrationNumber).toUpperCase() || uen;

  const kausi = periodFields(period);
  if (!kausi) errors.push(`period must be a resolved GST accounting period (month/quarter with a matching key; got type "${period.type}", key "${period.key}")`);

  // Money fields: known F5 boxes only, and both identities must re-foot.
  const expected4 = GST_SUPPLY_BOXES_IN_4.reduce((sum, box) => round2(sum + num(boxes[box])), 0);
  const expected8 = round2(num(boxes['6']) - num(boxes['7']));
  if (round2(num(boxes['4'])) !== expected4) {
    errors.push(`boxes do not re-foot: box 4=${boxes['4']} expected=${expected4} (1+2+3)`);
  }
  if (round2(num(boxes['8'])) !== expected8 || round2(num(payable)) !== expected8) {
    errors.push(`boxes do not re-foot: box 8=${boxes['8']} payable=${payable} expected=${expected8} (6−7)`);
  }
  for (const box of Object.keys(boxes)) {
    if (!GST_F5_BOXES[box]) errors.push(`unknown GST F5 box "${box}"`);
  }

  if (errors.length) return { ok: false, errors, submission: null };

  // The submission payload: F5 boxes keyed by number, amounts as round2
  // numbers. A nil return transmits all-zero boxes (IRAS requires the filing
  // itself; there is no separate no-activity flag on the F5 — the deliberate
  // difference from the VSRALVKV 056 record).
  const payloadBoxes = {};
  const boxIds = Object.keys(GST_F5_BOXES).sort((a, b) => Number(a) - Number(b));
  for (const box of boxIds) payloadBoxes[box] = nilReturn ? 0 : round2(num(boxes[box]));

  return {
    ok: true,
    errors: [],
    submission: {
      reference: gstFilingReference({ uen, periodKey: kausi.key }),
      payload: {
        uen,
        gst_registration_number: gstRegNo,
        period: { key: kausi.key, type: kausi.type, starts_on: kausi.starts, ends_on: kausi.ends },
        boxes: payloadBoxes,
        nil_return: nilReturn === true
      }
    }
  };
};

// ---------------------------------------------------------------------------------
// Env config — secrets and the test-vs-prod endpoint knob (the D-FI8-2 posture).
// ---------------------------------------------------------------------------------
// Env holds ONLY the named exceptions: the API credential pair, the endpoint
// tuning knob, and the software id. Enablement stays on the config plane
// (`SINGAPORE_GST_FILING`) — these vars can never turn the lane on by themselves.
export const resolveIrasFilingConfigFromEnv = (env = process.env) => ({
  endpoint: clean(env.IRAS_FILING_ENDPOINT) || null,
  clientId: env.IRAS_FILING_CLIENT_ID || null,
  clientSecret: env.IRAS_FILING_CLIENT_SECRET || null,
  softwareId: clean(env.IRAS_FILING_SOFTWARE_ID) || 'Donna'
});

// ---------------------------------------------------------------------------------
// The default transport — typed refusal until F-SG-2 lands.
// ---------------------------------------------------------------------------------
// The IRAS myTax API wire protocol (endpoints, CorpPass-authenticated OAuth
// envelope, ack shape) is exactly what the blocked research must confirm;
// transmitting a statutory filing on an unconfirmed protocol is categorically
// out. Until the follow-up replaces this with the confirmed transport, every
// attempt is a RETRYABLE refusal: the row stays pending, the ask stays open,
// nothing false is minted.
export const irasApiTransportPendingConfirmation = async () => {
  throw refusal(
    'IRAS myTax API wire transport is pending primary-source confirmation (F-SG-2); the filing channel is not yet live.',
    'GST_FILING_CHANNEL_UNAVAILABLE'
  );
};

// ---------------------------------------------------------------------------------
// createIrasSubmitGstF5 — the factory for the seam's injected function.
// ---------------------------------------------------------------------------------
// { resolveConfig, resolveFiler, transport, now } → async submitReturn(...).
// The produced function accepts the seam payload ({ period, boxes, payable,
// nilReturn }) plus the { firmId, clientId } the inbound wiring binds in (the
// seam itself carries no client identity; the UEN must come from the client
// profile). Refusals:
//   • GST_FILING_REJECTED — the submission cannot be rendered (missing/invalid
//     UEN, misfooted boxes) or the channel REFUSED the filing; the channel's
//     reason rides `error.channelReason` verbatim for the owner text.
//   • GST_FILING_CHANNEL_UNAVAILABLE — missing endpoint/credential config,
//     transport failure, or the pending-confirmation default; retryable, the
//     ask stays open.
// Success: { channel, submission_id, reference, raw_ack } — lands verbatim in
// filing_receipt upstream (the ack is the statutory proof, untrimmed).
export const createIrasSubmitGstF5 = ({
  resolveConfig = () => resolveIrasFilingConfigFromEnv(process.env),
  resolveFiler = null,
  transport = irasApiTransportPendingConfirmation,
  now = () => new Date()
} = {}) => async ({ period = {}, boxes = {}, payable = 0, nilReturn = false, firmId = null, clientId = null } = {}) => {
  if (typeof resolveFiler !== 'function') {
    throw refusal('GST filing channel has no filer identity source wired.', 'GST_FILING_CHANNEL_UNAVAILABLE');
  }
  const filer = (await resolveFiler({ firmId, clientId })) || {};
  if (!isValidUen(clean(filer.uen))) {
    throw refusal(
      "GST filing requires the client's valid UEN on the profile before the return can be transmitted.",
      'GST_FILING_REJECTED',
      { channelReason: 'UEN is missing from the client profile or structurally invalid.' }
    );
  }

  const config = resolveConfig() || {};
  const rendered = renderGstF5Submission({ period, boxes, payable, nilReturn, filer });
  if (!rendered.ok) {
    throw refusal(
      `GST F5 does not render to a submission: ${rendered.errors.join('; ')}`,
      'GST_FILING_REJECTED',
      { channelReason: rendered.errors.join('; ') }
    );
  }

  if (!config.endpoint || !config.clientId || !config.clientSecret) {
    throw refusal(
      'GST filing channel is not configured (IRAS_FILING_ENDPOINT / IRAS_FILING_CLIENT_ID / IRAS_FILING_CLIENT_SECRET).',
      'GST_FILING_CHANNEL_UNAVAILABLE'
    );
  }

  let result;
  try {
    // ONE attempt, no retries — a transport-level ambiguity must surface as a
    // retryable refusal (next "yes"), never as a second in-flight filing.
    result = await transport({
      endpoint: config.endpoint,
      submission: rendered.submission,
      reference: rendered.submission.reference,
      credentials: { clientId: config.clientId, clientSecret: config.clientSecret },
      softwareId: config.softwareId,
      submittedAt: now().toISOString()
    });
  } catch (error) {
    if (error?.code === 'GST_FILING_REJECTED' || error?.code === 'GST_FILING_CHANNEL_UNAVAILABLE') throw error;
    throw refusal(
      `GST filing channel unavailable: ${error?.message || 'transport error'}`,
      'GST_FILING_CHANNEL_UNAVAILABLE'
    );
  }

  if (result?.status === 'rejected') {
    // The channel's validation verdict, verbatim — the owner (and Kari) must
    // see WHAT IRAS refused, not a paraphrase.
    const reason = clean(result.reason) || 'the return was rejected (no reason given)';
    throw refusal(`IRAS rejected the GST F5: ${reason}`, 'GST_FILING_REJECTED', {
      channelReason: reason,
      rawAck: result.ack ?? null
    });
  }
  if (result?.status !== 'accepted' || !clean(result.submissionId)) {
    throw refusal(
      'GST filing channel returned an unrecognised result; treating as unavailable (nothing was marked filed).',
      'GST_FILING_CHANNEL_UNAVAILABLE'
    );
  }

  return {
    channel: GST_FILING_CHANNEL,
    submission_id: clean(result.submissionId),
    reference: rendered.submission.reference,
    raw_ack: result.ack ?? null
  };
};
