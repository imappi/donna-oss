// Finland's form-5 quarantine policy. Generic blocker lifecycle and persistence
// are imported directly from the shared statutoryBlocker.js by their consumers.
import { mintStatutoryBlocker } from '../statutoryBlocker.js';


// Known reason codes — DOCUMENTATION only, deliberately NOT a CHECK (the
// condition enumeration can never be complete; the C7 default-blocker doctrine).
// A new statutory surface may mint a reason_code not listed here and that is
// legal.
export const KNOWN_BLOCKER_REASON_CODES = Object.freeze([
  'entity_unsupported_annual_return', // an Oy reached the form-5 elinkeinonharjoittaja return
  'entity_unsupported',               // generic: a Finnish statutory surface not built for this legal form
  'entity_type_unknown',              // fail-closed-on-unknown (13.0b flip) — legal form not resolvable
  'missing_payroll_evidence',         // D-FI13-16 — external payroll package missing, close blocked
  'incomplete_oy_cutover_document_set', // D-FI13-22 — Oy cutover doc set missing material items, opening balances refused
  'unclassified_condition'            // C7 default-blocker — a condition no support matrix covers
]);


// The shared resolution path for the form-5 (elinkeinonharjoittaja annual return)
// obstruction on an osakeyhtiö. Both the read-path refusal
// (getFinlandAnnualReturnFromDb) and the proactive quarantine-on-identification
// (createClientInDb) mint the SAME blocker — identical surface + reason_code ⇒
// identical deterministic id, so the two sites collapse into ONE durable row.
// Sharing this string keeps the mint's ON CONFLICT resolution_path update from
// flip-flopping between the sites.
export const FORM5_OY_UNSUPPORTED_RESOLUTION_PATH =
  'An osakeyhtiö files veroilmoitus 6B with a separate tilinpäätös. ' +
  'Correct the client legal form, or build the Oy annual-return lane, ' +
  'before a statutory return can be generated for this client.';


// mintForm5OyQuarantineBlocker — the form-5 lane quarantine for an osakeyhtiö
// (D-FI13-2 v2, the last 13.0 piece). An Oy files veroilmoitus 6B, never the
// elinkeinonharjoittaja form 5. The form-5 output is never PERSISTED (it is
// computed on-read and already fail-closes for fi-oy), so there is no stored
// artifact to tombstone — the "quarantine" is a durable legal_violation blocker
// that rests the superseded-lane obligation on the FIRM. Minted proactively the
// moment a client is identified as fi-oy (createClientInDb) AND lazily on a
// form-5 read refusal (getFinlandAnnualReturnFromDb); both use this surface +
// reason_code, so they collapse to ONE idempotent row whose append-only event
// trail carries both origins (proactive `minted`, later read `re_raised`). Thin
// wrapper over mintStatutoryBlocker — inherits its pre-migration soft-fail and
// its "the mint never masks the load-bearing refusal" posture.
export const mintForm5OyQuarantineBlocker = async ({
  client, firmId, clientId, reason = null, detail = {}, actorType = 'system', actorId = null
} = {}) =>
  mintStatutoryBlocker({
    client,
    firmId,
    clientId,
    surface: 'finland_annual_return',
    reasonCode: 'entity_unsupported_annual_return',
    severity: 'legal_violation',
    assignedTo: 'firm',
    entityType: 'oy',
    resolutionPath: FORM5_OY_UNSUPPORTED_RESOLUTION_PATH,
    detail,
    reason,
    actorType,
    actorId
  });
