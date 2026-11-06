import { gbEntityType } from './entity.js';
import { resolveGbFiscalYearForEntity } from './accountingPeriod.js';
import { calendarFiscalPeriod } from '../calendarFiscalPeriod.js';
import { ledgerDateOnly } from '../ledger.js';
export const GB_CLOSE_POLICY = Object.freeze({
  readsPersistedPeriod: ({ entityType }) => Boolean(gbEntityType({ entity_type: entityType })),
  resolveFiscalYear({ date, entityType, incorporationDate, persistedPeriod }) {
    const entityAxis = gbEntityType({ entity_type: entityType });
    // Preserve the existing noncanonical-form calendar projection; it grants no filing authority.
    return entityAxis ? resolveGbFiscalYearForEntity({ date, entityAxis, incorporationDate: incorporationDate ? ledgerDateOnly(incorporationDate) : null, persistedPeriod })
      : calendarFiscalPeriod({ date, incorporationDate });
  }
});
