import {
  getHmrcApiBaseUrl,
  hmrcCorrelationIdFromHeaders,
  HMRC_VAT_ACCEPT_HEADER
} from './hmrcClient.js';
import { buildHmrcFraudPreventionHeaders } from './hmrcFraudPreventionHeaders.js';

// Endpoint paths, fraud-prevention header vocabulary and the nine-box wire
// field names have not yet been re-checked against the primary HMRC
// documentation in this environment. Keep that fact on every receipt so
// callers cannot mistake remembered wire knowledge for source-confirmed
// filing authority.
export const HMRC_VAT_API_PROVENANCE = Object.freeze({
  confirmedAgainstPrimary: false,
  note: 'HMRC VAT API paths, fraud-prevention header set and nine-box wire field names await a network-open primary-source verification pass.'
});

// The prepared return keys its boxes with the canonical digits "1".."9"
// (gb/vatReturn.js builds them; gb/vatReturnRoute.js asserts them). The wire
// wants named fields. This map only RENAMES keys — values pass verbatim; the
// transport never derives a number.
export const HMRC_VAT_BOX_FIELDS = Object.freeze({
  1: 'vatDueSales',
  2: 'vatDueAcquisitions',
  3: 'totalVatDue',
  4: 'vatReclaimedCurrPeriod',
  5: 'netVatDue',
  6: 'totalValueSalesExVAT',
  7: 'totalValuePurchasesExVAT',
  8: 'totalValueGoodsSuppliedExVAT',
  9: 'totalAcquisitionsExVAT'
});

export const buildHmrcVatFraudPreventionHeaders = (inputs = {}) =>
  buildHmrcFraudPreventionHeaders(inputs);

const encode = (value) => encodeURIComponent(String(value));

const request = async ({ endpoint, path, method = 'GET', accessToken, body, fraudHeaders = {}, fetchImpl = fetch, baseUrl } = {}) => {
  const response = await fetchImpl(`${baseUrl || getHmrcApiBaseUrl()}${path}`, {
    method,
    headers: {
      Accept: HMRC_VAT_ACCEPT_HEADER,
      Authorization: `Bearer ${accessToken}`,
      ...fraudHeaders,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  const receipt = {
    endpoint,
    httpStatus: response.status,
    correlationId: hmrcCorrelationIdFromHeaders(response.headers) || null,
    provenance: HMRC_VAT_API_PROVENANCE
  };
  if (!response.ok) {
    return {
      result: {
        ok: false,
        refusal: 'HMRC_VAT_API_REFUSED',
        errorCode: payload?.code || payload?.error || null,
        payload
      },
      receipt
    };
  }
  return { result: { ok: true, payload }, receipt };
};

const vatPath = (vrn, suffix) => `/organisations/vat/${encode(vrn)}/${suffix}`;

export const retrieveObligations = ({ vrn, from, to, status, ...options } = {}) => {
  const query = new URLSearchParams();
  if (from) query.set('from', from);
  if (to) query.set('to', to);
  if (status) query.set('status', status);
  const suffix = query.size ? `obligations?${query}` : 'obligations';
  return request({ endpoint: 'retrieveObligations', path: vatPath(vrn, suffix), ...options });
};

export const submitReturn = ({ vrn, periodKey, boxes, finalised = false, ...options } = {}) => {
  const unknown = Object.keys(boxes || {}).filter((key) => !HMRC_VAT_BOX_FIELDS[key]);
  if (unknown.length) {
    return Promise.resolve({
      result: {
        ok: false,
        refusal: 'HMRC_VAT_BOX_VOCABULARY_UNKNOWN',
        errorCode: null,
        payload: { unknownBoxKeys: unknown }
      },
      receipt: { endpoint: 'submitReturn', httpStatus: null, correlationId: null, provenance: HMRC_VAT_API_PROVENANCE }
    });
  }
  const wireBoxes = Object.fromEntries(Object.entries(boxes || {}).map(([key, value]) => [HMRC_VAT_BOX_FIELDS[key], value]));
  return request({
    endpoint: 'submitReturn',
    path: vatPath(vrn, 'returns'),
    method: 'POST',
    body: { periodKey, ...wireBoxes, finalised: finalised === true },
    ...options
  });
};

export const viewReturn = ({ vrn, periodKey, ...options } = {}) =>
  request({ endpoint: 'viewReturn', path: vatPath(vrn, `returns/${encode(periodKey)}`), ...options });

export const retrieveLiabilities = ({ vrn, from, to, ...options } = {}) =>
  request({ endpoint: 'retrieveLiabilities', path: vatPath(vrn, `liabilities?from=${encode(from)}&to=${encode(to)}`), ...options });

export const retrievePayments = ({ vrn, from, to, ...options } = {}) =>
  request({ endpoint: 'retrievePayments', path: vatPath(vrn, `payments?from=${encode(from)}&to=${encode(to)}`), ...options });

// Adapter for gb/vatReturnRoute.js. It deliberately requires credentials and
// finalisation intent at injection time; the route's refusing default remains.
export const createHmrcVatSubmissionTransport = ({ accessToken, vrn, fraudHeaders = {}, fetchImpl = fetch, baseUrl, finalised = false } = {}) =>
  async ({ prepared } = {}) => submitReturn({
    accessToken,
    vrn,
    periodKey: prepared?.period?.periodKey,
    boxes: prepared?.vatReturn?.boxes,
    finalised,
    fraudHeaders,
    fetchImpl,
    baseUrl
  });
