// The owner VAT-return surface dispatcher — the market-NEUTRAL home for the
// server-owned verdict behind the portal's "Your VAT return" card
// (docs/design-donna-owner-vat-return-dispatch.md). Moved here from
// gb/vatReturnRoute.js so AE could join without a gb→ae import. Country
// preparation now resolves through the named statutory registry, with profile
// mapping owned by each country implementation.
//
// The surface is UNCONDITIONAL for covered jurisdictions — the born-dark
// OWNER_VAT_RETURN_SURFACE flag was deleted 2026-08-31 (Kari, "nothing
// dark"; a rendering surface under the 2026-08-27 zero-users rail — it
// writes nothing). The client's stored jurisdiction decides WHICH market
// preparation runs; a jurisdiction with no registered preparer reads dark —
// honest about the gap, never a foreign market's figures. An uncoded book
// does not lie either way: the preparation's typed refusal folds into the
// envelope, so the card says "not prepared, because X" rather than showing
// a wrong number.
//
// The server owns the whole verdict (the row-17 binding-state pattern — the
// FE never guesses), and each preparation's NAMED refusals fold into the
// envelope as data instead of surfacing as bare errors: which refusals the
// owner should see (a missing registration is THEIR fact; an uncoded ledger
// is Donna's work-in-progress) is the view-model's call, not a catch
// block's. Infrastructure errors (no typed code) still throw.

import { withFirmDbClient, DEFAULT_FIRM_ID } from './firmDb.js';
import { resolveStatutoryHandler, STATUTORY_REGISTRY } from './statutoryRegistry.js';
import { toLocalIsoDay } from './dates.js';

// Registration declares the operation; each country owns its profile mapping.
// Unimplemented jurisdictions retain the existing honest dark surface.
const DARK = Object.freeze({ surface_acts: false, prepared: null, refusal: null });

export const ownerVatReturnFromDb = ({ firmId = DEFAULT_FIRM_ID, clientId, periodKey, asOf, withFirmDbClientFn = withFirmDbClient } = {}) =>
  withFirmDbClientFn(async (client) => {
    const row = await client.query(
      'select jurisdiction, profile from clients where firm_id = $1 and id = $2 limit 1',
      [firmId, clientId]
    );
    // Storage already canonicalises the jurisdiction (uk → gb at write time,
    // clientProfileSchema.js), so uppercasing is the only normalisation here.
    const jurisdiction = String(row.rows[0]?.jurisdiction || row.rows[0]?.profile?.jurisdiction || '').toUpperCase();
    // Keep this persisted-surface contract canonical-only. A registry alias is
    // useful to callers, but does not widen the historical stored-row admission.
    if (!Object.hasOwn(STATUTORY_REGISTRY, jurisdiction.toLowerCase())) return DARK;
    let prepare;
    try { prepare = resolveStatutoryHandler({ jurisdiction, operation: 'prepareOwnerVatReturnWithClient' }); }
    catch (error) {
      if (['statutory_jurisdiction_unresolved', 'statutory_jurisdiction_unsupported', 'statutory_operation_unsupported'].includes(error?.code)) return DARK;
      throw error;
    }
    try {
      // The owner asks "where do I stand NOW": with no explicit period the
      // current one resolves by today's date (both markets' period resolvers
      // match nothing when periodKey and asOf are both absent).
      const effectiveAsOf = asOf || (periodKey === undefined ? toLocalIsoDay(new Date()) : undefined); // host-local day (audit F-11)
      const prepared = await prepare({
        client,
        firmId,
        clientId,
        periodKey,
        asOf: effectiveAsOf,
        profile: row.rows[0]?.profile
      });
      return { surface_acts: true, prepared, refusal: null };
    } catch (error) {
      if (error?.code) return { surface_acts: true, prepared: null, refusal: { code: error.code, message: error.message } };
      throw error;
    }
  });
