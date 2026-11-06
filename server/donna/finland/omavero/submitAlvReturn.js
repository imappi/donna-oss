// FI-8 — the Verohallinto ALV filing adapter behind FI-3's `submitReturn` seam.
// Design: docs/design-donna-finland-fi8-omavero-adapter.md (greenlit by Kari
// 2026-07-10, on the design's current source basis — F-FI8-R1 still open).
//
// Two layers, kept separate (the verkkolaskuTransmit discipline):
//   • PURE — renderVsralvkvRecord: the VSRALVKV name:value record for a footed
//     ALV return verdict. KEEP-layer only (Y-tunnus check digit, the 308
//     identity re-run, period validation); no model call anywhere in this file.
//   • I/O-INJECTABLE — createIlmoitinSubmitAlvReturn: the factory producing the
//     seam's ONE injected function. The wire transport is itself injected; the
//     DEFAULT transport refuses (typed, retryable) until F-FI8-R1 confirms the
//     ApitamoPKI protocol against the primary sources from a network-open
//     session. A tax-authority submission never runs on guessed bytes: the
//     renderer's unconfirmed details are inert until the confirmed transport
//     replaces the pending one.
//
// Contract upstream (alvReturnTransmit.js — do NOT rebuild): the verdict is
// re-footed and the owner's authority receipt recorded before this is called; a
// THROW leaves the alv_returns row pending and the WhatsApp ask OPEN (the next
// "kyllä" retries) — so refusals here are typed and idempotency is per
// (client, period): a deterministic reference rides every transport call, and
// the adapter itself NEVER retries (double-filing protection is the channel's
// duplicate handling + the one-live-row-per-period unique index upstream).

import { isValidBusinessId } from '../verkkolasku.js';
import { ALV_RETURN_BOXES, ALV_TAX_FIELDS_IN_308 } from '../alvCodes.js';

const clean = (value) => String(value ?? '').trim();
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

export const ALV_FILING_CHANNEL = 'ilmoitin_apitamopki';

const refusal = (message, code, extra = {}) => Object.assign(new Error(message), { code, ...extra });

// ---------------------------------------------------------------------------------
// Provenance — the-model-id-is-part-of-the-receipt discipline, applied to the
// statutory record layout (the same pattern as ALV_RETURN_BOX_PROVENANCE).
// ---------------------------------------------------------------------------------
// The structural field ids and value conventions below were assembled from the
// Verohallinto tietuekuvaus family conventions + the FI-3 VSRALVKV cross-
// confirmation (secondary sources); the container's network policy blocks a
// byte-level read of the primary spec (CONNECT 403 to vero.fi/ilmoitin.fi,
// re-verified 2026-07-10). F-FI8-R1 MUST re-confirm every field id and value
// convention in VSRALVKV_STRUCTURAL_FIELDS + the pin-test fixture against the
// fetched primary spec and flip `confirmedAgainstPrimary` in the same commit —
// the pending default transport guarantees nothing transmits before that.
export const VSRALVKV_RECORD_PROVENANCE = Object.freeze({
  confirmedAgainstPrimary: false,
  source: 'Verohallinto tietuekuvaus family conventions + VSRALVKV cross-confirmation via secondary sources (FI-3, 2026-07-10); primary fetch blocked by network policy (F-FI8-R1)'
});

// The structural (non-money) field ids of the record. Money fields are the
// VSRALVKV box numbers themselves (ALV_RETURN_BOXES). Every id here is subject
// to the F-FI8-R1 re-confirmation above.
export const VSRALVKV_STRUCTURAL_FIELDS = Object.freeze({
  recordId: '000', // tietuekuvauksen tunniste — value VSRALVKV
  timestamp: '198', // ohjelmiston tuottama aikaleima (ddMMyyyyHHmmss)
  softwareId: '014', // ilmoituksen tuottaneen ohjelmiston yksilöivä tunnus
  businessId: '010', // verovelvollisen Y-tunnus
  periodType: '050', // verokauden tyyppi (K = kuukausi, Q = neljännes, V = vuosi)
  periodNumber: '052', // kohdekauden numero (kuukausi 1–12 / neljännes 1–4 / vuosi: 1)
  periodYear: '053', // kohdekauden vuosi
  noActivity: '056', // ei ALV-toimintaa kaudella (nollailmoitus) — value 1
  end: '999' // lopputietue
});

const PERIOD_TYPE_CODES = Object.freeze({ month: 'K', quarter: 'Q', year: 'V' });

// Verohallinto money convention: euros with a comma decimal separator, two
// decimals, leading minus for negatives, no thousands separators.
export const formatVsralvkvAmount = (value) => {
  const n = round2(num(value));
  const sign = n < 0 ? '-' : '';
  return `${sign}${Math.abs(n).toFixed(2).replace('.', ',')}`;
};

// The deterministic idempotency reference per (filer, period) — identical on
// every retry of the same filing, so the channel's duplicate handling can
// recognise a re-submit. Pure string assembly, no timestamp on purpose.
export const alvFilingReference = ({ businessId, periodKey } = {}) =>
  `VSRALVKV/${clean(businessId)}/${clean(periodKey)}`;

const periodFields = (period = {}) => {
  const type = clean(period.type).toLowerCase();
  const key = clean(period.key);
  const code = PERIOD_TYPE_CODES[type];
  if (!code || !key) return null;
  let number = null;
  let year = null;
  let match;
  if (type === 'month' && (match = key.match(/^(\d{4})-(\d{2})$/))) {
    year = match[1];
    number = String(Number(match[2]));
  } else if (type === 'quarter' && (match = key.match(/^(\d{4})-Q([1-4])$/i))) {
    year = match[1];
    number = match[2];
  } else if (type === 'year' && (match = key.match(/^(\d{4})$/))) {
    year = match[1];
    number = '1';
  }
  if (!number || !year || Number(number) < 1 || (type === 'month' && Number(number) > 12)) return null;
  return { code, number, year };
};

// ---------------------------------------------------------------------------------
// renderVsralvkvRecord — the pure payload renderer. Never throws.
// ---------------------------------------------------------------------------------
// { period, boxes, payable, nilReturn, filer: { businessId }, softwareId,
//   timestamp } → { ok, errors, record: { reference, lines, text } }.
// KEEP-layer refusals (ok:false): invalid Y-tunnus, unresolvable period, a box
// set that does not re-foot (the 308 identity, run AGAIN here — defense in
// depth on the last surface before the wire), unknown box ids.
export const renderVsralvkvRecord = ({
  period = {},
  boxes = {},
  payable = 0,
  nilReturn = false,
  filer = {},
  softwareId = 'Donna',
  timestamp = ''
} = {}) => {
  const errors = [];

  const businessId = clean(filer.businessId);
  if (!isValidBusinessId(businessId)) {
    errors.push('filer.businessId must be a valid Y-tunnus (NNNNNNN-C)');
  }

  const kausi = periodFields(period);
  if (!kausi) errors.push(`period must be a resolved verokausi (month/quarter/year with a matching key; got type "${period.type}", key "${period.key}")`);

  const ts = clean(timestamp);
  if (!/^\d{14}$/.test(ts)) errors.push('timestamp must be ddMMyyyyHHmmss (14 digits)');

  const software = clean(softwareId);
  if (!software) errors.push('softwareId is required');

  // Money fields: known VSRALVKV boxes only, and the 308 identity must re-foot.
  const moneyFields = [];
  const taxTotal = ALV_TAX_FIELDS_IN_308.reduce((sum, field) => round2(sum + num(boxes[field])), 0);
  const expected308 = round2(taxTotal - num(boxes['307']));
  if (round2(num(boxes['308'])) !== expected308 || round2(num(payable)) !== expected308) {
    errors.push(`boxes do not re-foot: 308=${boxes['308']} payable=${payable} expected=${expected308}`);
  }
  for (const field of Object.keys(boxes)) {
    if (!ALV_RETURN_BOXES[field]) errors.push(`unknown VSRALVKV box "${field}"`);
  }

  if (errors.length) return { ok: false, errors, record: null };

  const lines = [];
  const F = VSRALVKV_STRUCTURAL_FIELDS;
  lines.push(`${F.recordId}:VSRALVKV`);
  lines.push(`${F.timestamp}:${ts}`);
  lines.push(`${F.softwareId}:${software}`);
  lines.push(`${F.businessId}:${businessId}`);
  lines.push(`${F.periodType}:${kausi.code}`);
  lines.push(`${F.periodNumber}:${kausi.number}`);
  lines.push(`${F.periodYear}:${kausi.year}`);
  if (nilReturn === true) {
    // A nollailmoitus reports the no-activity flag and NO money fields.
    lines.push(`${F.noActivity}:1`);
  } else {
    // Non-zero boxes in ascending field order; 308 always present (it is the
    // return's net verdict even when zero).
    const fields = Object.keys(ALV_RETURN_BOXES).sort((a, b) => Number(a) - Number(b));
    for (const field of fields) {
      const value = round2(num(boxes[field]));
      if (field === '308' || value !== 0) lines.push(`${field}:${formatVsralvkvAmount(value)}`);
    }
  }
  lines.push(`${F.end}:1`);

  return {
    ok: true,
    errors: [],
    record: {
      reference: alvFilingReference({ businessId, periodKey: period.key }),
      lines,
      text: lines.join('\n')
    }
  };
};

// ---------------------------------------------------------------------------------
// Env config — secrets and the test-vs-prod endpoint knob (D-FI8-2).
// ---------------------------------------------------------------------------------
// Env holds ONLY the named exceptions: the certificate secret pair, the endpoint
// tuning knob, and the software id. Enablement stays on the config plane
// (`FINLAND_ALV_FILING`) — these vars can never turn the lane on by themselves.
export const resolveVeroFilingConfigFromEnv = (env = process.env) => ({
  endpoint: clean(env.VERO_FILING_ENDPOINT) || null,
  cert: env.VERO_FILING_CERT || null,
  certKey: env.VERO_FILING_CERT_KEY || null,
  softwareId: clean(env.VERO_FILING_SOFTWARE_ID) || 'Donna'
});

// ---------------------------------------------------------------------------------
// The default transport — typed refusal until F-FI8-R1 lands.
// ---------------------------------------------------------------------------------
// The ApitamoPKI wire protocol (endpoints, signature envelope, ack shape) is
// exactly what the blocked research must confirm; transmitting a statutory
// filing on an unconfirmed protocol is categorically out. Until the follow-up
// replaces this with the confirmed transport, every attempt is a RETRYABLE
// refusal: the row stays pending, the ask stays open, nothing false is minted.
export const apitamoPkiTransportPendingConfirmation = async () => {
  throw refusal(
    'ApitamoPKI wire transport is pending primary-source confirmation (F-FI8-R1); the filing channel is not yet live.',
    'ALV_FILING_CHANNEL_UNAVAILABLE'
  );
};

// ---------------------------------------------------------------------------------
// createIlmoitinSubmitAlvReturn — the factory for the seam's injected function.
// ---------------------------------------------------------------------------------
// { resolveConfig, resolveFiler, transport, now } → async submitReturn(...).
// The produced function accepts the seam payload ({ period, boxes, payable,
// nilReturn }) plus the { firmId, clientId } the inbound wiring binds in (the
// seam itself carries no client identity; the Y-tunnus must come from the
// client profile). Refusals:
//   • ALV_FILING_REJECTED — the record cannot be rendered (missing/invalid
//     Y-tunnus, misfooted boxes) or the channel REFUSED the filing; the
//     channel's reason rides `error.channelReason` verbatim for the owner text.
//   • ALV_FILING_CHANNEL_UNAVAILABLE — missing endpoint/cert config, transport
//     failure, or the pending-confirmation default; retryable, the ask stays open.
// Success: { channel, submission_id, reference, raw_ack } — lands verbatim in
// filing_receipt upstream (the ack is the statutory proof, untrimmed).
export const createIlmoitinSubmitAlvReturn = ({
  resolveConfig = () => resolveVeroFilingConfigFromEnv(process.env),
  resolveFiler = null,
  transport = apitamoPkiTransportPendingConfirmation,
  now = () => new Date()
} = {}) => async ({ period = {}, boxes = {}, payable = 0, nilReturn = false, firmId = null, clientId = null } = {}) => {
  if (typeof resolveFiler !== 'function') {
    throw refusal('ALV filing channel has no filer identity source wired.', 'ALV_FILING_CHANNEL_UNAVAILABLE');
  }
  const filer = (await resolveFiler({ firmId, clientId })) || {};
  if (!isValidBusinessId(clean(filer.businessId))) {
    throw refusal(
      'ALV filing requires the client\'s valid Y-tunnus on the profile before the return can be transmitted.',
      'ALV_FILING_REJECTED',
      { channelReason: 'Y-tunnus puuttuu asiakkaan profiilista tai on virheellinen.' }
    );
  }

  const config = resolveConfig() || {};
  const at = now();
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${pad(at.getUTCDate())}${pad(at.getUTCMonth() + 1)}${at.getUTCFullYear()}${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`;

  const rendered = renderVsralvkvRecord({
    period,
    boxes,
    payable,
    nilReturn,
    filer,
    softwareId: config.softwareId,
    timestamp: ts
  });
  if (!rendered.ok) {
    throw refusal(
      `ALV return does not render to a VSRALVKV record: ${rendered.errors.join('; ')}`,
      'ALV_FILING_REJECTED',
      { channelReason: rendered.errors.join('; ') }
    );
  }

  if (!config.endpoint || !config.cert || !config.certKey) {
    throw refusal(
      'ALV filing channel is not configured (VERO_FILING_ENDPOINT / VERO_FILING_CERT / VERO_FILING_CERT_KEY).',
      'ALV_FILING_CHANNEL_UNAVAILABLE'
    );
  }

  let result;
  try {
    // ONE attempt, no retries — a transport-level ambiguity must surface as a
    // retryable refusal (next "kyllä"), never as a second in-flight filing.
    result = await transport({
      endpoint: config.endpoint,
      record: rendered.record,
      reference: rendered.record.reference,
      credentials: { cert: config.cert, certKey: config.certKey },
      softwareId: config.softwareId
    });
  } catch (error) {
    if (error?.code === 'ALV_FILING_REJECTED' || error?.code === 'ALV_FILING_CHANNEL_UNAVAILABLE') throw error;
    throw refusal(
      `ALV filing channel unavailable: ${error?.message || 'transport error'}`,
      'ALV_FILING_CHANNEL_UNAVAILABLE'
    );
  }

  if (result?.status === 'rejected') {
    // The channel's validation verdict, verbatim — the owner (and Kari) must
    // see WHAT Verohallinto refused, not a paraphrase.
    const reason = clean(result.reason) || 'ilmoitus hylättiin (syytä ei annettu)';
    throw refusal(`Verohallinto rejected the ALV return: ${reason}`, 'ALV_FILING_REJECTED', {
      channelReason: reason,
      rawAck: result.ack ?? null
    });
  }
  if (result?.status !== 'accepted' || !clean(result.submissionId)) {
    throw refusal(
      'ALV filing channel returned an unrecognised result; treating as unavailable (nothing was marked filed).',
      'ALV_FILING_CHANNEL_UNAVAILABLE'
    );
  }

  return {
    channel: ALV_FILING_CHANNEL,
    submission_id: clean(result.submissionId),
    reference: rendered.record.reference,
    raw_ack: result.ack ?? null
  };
};
