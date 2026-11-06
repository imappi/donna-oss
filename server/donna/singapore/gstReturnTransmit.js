// SG-3 (file-half) — the GST F5 filing transmit seam. I/O fully injected,
// mirroring finland/alvReturnTransmit.js 1:1.
//
// Compute-and-file: Donna transmits the F5 to IRAS itself, under the owner's
// confirmed authority. THIS module is the seam, not the channel: the real IRAS
// myTax API adapter is iras/submitGstF5.js — it plugs in as the injected
// `submitReturn`. Until its wire protocol is primary-confirmed, no default
// channel transmits and a transmit without one is a typed refusal (never a
// silent no-op or a false receipt).
//
// KEEP-layer: the stored verdict is re-footed (assertGstF5Foots — the box-4 and
// box-8 identities) before anything leaves the building, exactly as the engine
// header demands of any lane acting on a persisted verdict.

import { assertGstF5Foots } from './gstReturn.js';
import { assertCorpPassMandateValidForFiling, CORPPASS_SCOPE_GST } from './corpPassMandate.js';

const refusal = (message, code) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

// transmitGstReturnFiling({ verdict, period, authorityBasis, actorId, model,
// mandate, submitReturn, now }) → { receipt }.
//
// `verdict` is the persisted gst_returns.verdict envelope ({ gstReturn, review,
// provenance }); `period` the persisted { key, type, starts_on, ends_on };
// `mandate` the persisted corppass_mandates row (migration 089) for the client;
// `submitReturn({ period, boxes, payable, nilReturn })` the injected filing
// channel, returning at minimum { submission_id?, ...provider fields }.
// Refusals (typed, thrown — a refused filing must not look like a soft error):
//   • GST_FILING_AUTHORITY_REQUIRED — no authorityBasis.source / actorId. A
//     statutory submission is the most outward-facing act in the system;
//     nothing transmits without the owner's confirmation receipt.
//   • SG_FILING_CORPPASS_REQUIRED — no valid CorpPass authorization (iras_gst)
//     for the client at the filing moment: the "yes" is Donna's internal
//     receipt, the CorpPass grant is the LEGAL authorization IRAS sees — both
//     must hold. Reason rides `error.mandateReason` (closed enum).
//   • GST_FILING_NO_CHANNEL — no injected submitReturn.
//   • GST_FILING_NOT_READY — the stored verdict is not a ready return
//     (blockers present, or the boxes don't re-foot).
export const transmitGstReturnFiling = async ({
  verdict = null,
  period = null,
  authorityBasis = null,
  actorId = null,
  model = null,
  mandate = null,
  submitReturn,
  now = () => new Date().toISOString()
} = {}) => {
  if (!authorityBasis || !authorityBasis.source || !actorId) {
    throw refusal(
      "GST filing requires an authority basis (the owner's confirmation receipt) and an actor id.",
      'GST_FILING_AUTHORITY_REQUIRED'
    );
  }
  // The legal authorization gates BEFORE channel mechanics: no valid CorpPass
  // grant, nothing else matters. Evaluated at the filing moment so the verdict
  // is reproducible from the receipt.
  assertCorpPassMandateValidForFiling({ mandate, scope: CORPPASS_SCOPE_GST, onDate: now() });
  if (typeof submitReturn !== 'function') {
    throw refusal(
      'GST filing requires an injected submitReturn channel (the IRAS myTax adapter is iras/submitGstF5.js).',
      'GST_FILING_NO_CHANNEL'
    );
  }
  const gstReturn = verdict?.gstReturn;
  const periodKey = period?.key;
  if (!gstReturn || !periodKey) {
    throw refusal('GST filing requires the persisted verdict and its period.', 'GST_FILING_NOT_READY');
  }
  if (verdict?.review && verdict.review.status !== 'ready') {
    throw refusal(
      `GST F5 is not ready to file: ${(verdict.review.blockers || []).join(', ') || verdict.review.status}.`,
      'GST_FILING_NOT_READY'
    );
  }
  try {
    assertGstF5Foots(gstReturn);
  } catch (error) {
    throw refusal(`GST F5 does not re-foot before filing: ${error.message}`, 'GST_FILING_NOT_READY');
  }

  const providerResult = await submitReturn({
    period: { key: periodKey, type: period.type, starts_on: period.starts_on, ends_on: period.ends_on },
    boxes: gstReturn.boxes,
    payable: gstReturn.payable,
    nilReturn: gstReturn.nilReturn === true
  });

  return {
    receipt: {
      channel: providerResult?.channel || 'injected_submit_return',
      period_key: periodKey,
      payable: gstReturn.payable,
      nil_return: gstReturn.nilReturn === true,
      submission_id: providerResult?.submission_id || providerResult?.id || null,
      transmitted_at: now(),
      provider_result: providerResult ?? null,
      authority_basis: authorityBasis,
      actor_id: actorId,
      // The CorpPass grant is part of the receipt: which legal authorization
      // this filing rode, reproducible after the fact (the G-3 pattern).
      mandate: {
        id: mandate.id || null,
        scope: mandate.scope || null,
        granted_on: mandate.granted_on || null,
        expires_on: mandate.expires_on || null
      },
      // The model id is part of the receipt (null for a deterministic compute).
      model: model || null
    }
  };
};
