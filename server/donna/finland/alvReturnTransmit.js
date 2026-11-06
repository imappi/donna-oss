// FI-3 slice P — the ALV return filing transmit seam. I/O fully injected.
//
// D3 (Kari, 2026-07-10) is COMPUTE-AND-FILE: Donna transmits the ilmoitus to
// Verohallinto itself, under the owner's confirmed authority. THIS module is the
// seam, not the channel: the real OmaVero / Ilmoitin adapter is FI-8's own
// design-first slice — it plugs in as the injected `submitReturn`. Until FI-8
// lands, no default channel exists and a transmit without one is a typed refusal
// (never a silent no-op or a false receipt).
//
// KEEP-layer: the stored verdict is re-footed (assertAlvReturnFoots — the 308
// identity) before anything leaves the building, exactly as the engine header
// demands of any lane acting on a persisted verdict.
// Design: docs/design-donna-finland-fi3-alv-return.md (slice P).

import { assertAlvReturnFoots } from './alvReturn.js';
import { assertSuomifiMandateValidForFiling, SUOMIFI_MANDATE_SCOPE_TAX } from './suomifiMandate.js';

const refusal = (message, code) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

// transmitAlvReturnFiling({ verdict, period, authorityBasis, actorId, model,
// mandate, submitReturn, now }) → { receipt }.
//
// `verdict` is the persisted alv_returns.verdict envelope ({ alvReturn, review,
// provenance }); `period` the persisted { key, type, starts_on, ends_on };
// `mandate` the persisted suomifi_mandates row (migration 067) for the client;
// `submitReturn({ period, boxes, payable, nilReturn })` the injected filing
// channel (FI-8), returning at minimum { submission_id? , ...provider fields }.
// Refusals (typed, thrown — a refused filing must not look like a soft error):
//   • ALV_FILING_AUTHORITY_REQUIRED — no authorityBasis.source / actorId. A
//     statutory submission is the most outward-facing act in the system; nothing
//     transmits without the owner's confirmation receipt.
//   • ALV_FILING_MANDATE_REQUIRED — no valid Suomi.fi mandate (veroasioiden
//     hoito) for the client at the filing moment (G-3 / D-FI8-1): the "kyllä"
//     is Donna's internal receipt, the mandate is the LEGAL authorization
//     Verohallinto sees — both must hold. Reason rides `error.mandateReason`
//     (closed enum: no_mandate | wrong_scope | revoked | not_yet_effective |
//     expired).
//   • ALV_FILING_NO_CHANNEL — no injected submitReturn (FI-8 not wired).
//   • ALV_FILING_NOT_READY — the stored verdict is not a ready return (blockers
//     present, or the boxes don't re-foot).
export const transmitAlvReturnFiling = async ({
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
      "ALV filing requires an authority basis (the owner's confirmation receipt) and an actor id.",
      'ALV_FILING_AUTHORITY_REQUIRED'
    );
  }
  // The legal authorization gates BEFORE channel mechanics: no valid mandate,
  // nothing else matters. Evaluated at the filing moment so the verdict is
  // reproducible from the receipt.
  assertSuomifiMandateValidForFiling({ mandate, scope: SUOMIFI_MANDATE_SCOPE_TAX, onDate: now() });
  if (typeof submitReturn !== 'function') {
    throw refusal(
      'ALV filing requires an injected submitReturn channel (the OmaVero/Ilmoitin adapter is FI-8).',
      'ALV_FILING_NO_CHANNEL'
    );
  }
  const alvReturn = verdict?.alvReturn;
  const periodKey = period?.key;
  if (!alvReturn || !periodKey) {
    throw refusal('ALV filing requires the persisted verdict and its period.', 'ALV_FILING_NOT_READY');
  }
  if (verdict?.review && verdict.review.status !== 'ready') {
    throw refusal(
      `ALV return is not ready to file: ${(verdict.review.blockers || []).join(', ') || verdict.review.status}.`,
      'ALV_FILING_NOT_READY'
    );
  }
  try {
    assertAlvReturnFoots(alvReturn);
  } catch (error) {
    throw refusal(`ALV return does not re-foot before filing: ${error.message}`, 'ALV_FILING_NOT_READY');
  }

  const providerResult = await submitReturn({
    period: { key: periodKey, type: period.type, starts_on: period.starts_on, ends_on: period.ends_on },
    boxes: alvReturn.boxes,
    payable: alvReturn.payable,
    nilReturn: alvReturn.nilReturn === true
  });

  return {
    receipt: {
      channel: providerResult?.channel || 'injected_submit_return',
      period_key: periodKey,
      payable: alvReturn.payable,
      nil_return: alvReturn.nilReturn === true,
      submission_id: providerResult?.submission_id || providerResult?.id || null,
      transmitted_at: now(),
      provider_result: providerResult ?? null,
      authority_basis: authorityBasis,
      actor_id: actorId,
      // The mandate is part of the receipt: which legal authorization this
      // filing rode, reproducible after the fact (G-3).
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
