// Finnish close, voucher validation and retention policy. Existing fiscal-year
// writers are injected by the shared transaction owner; this is not a new ledger writer.
import { clientFlagActs, readClientConfigSnapshot } from '../clientConfig.js';
import { assertTositeSequenceGapFree, assertValidTilikausi, FINLAND_OPENING_BALANCES_FLAG_KEY, FINLAND_TILIKAUSI_FLAG_KEY, FINLAND_TOSITENUMERO_FLAG_KEY, periodNestsInFiscalYear, resolveFiscalYearForEntity } from './tilikausi.js';
import { describeArchiveRetention, evaluateRetentionHold } from './retention.js';

const heldFiscalYearsForRetention = async (client, { firmId, clientId, retentionClass, onDate = null, retainedFiscalStarts = null } = {}) => {
  if (!clientId) return null;
  const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  if (!clientFlagActs({ flagKey: FINLAND_TILIKAUSI_FLAG_KEY, snapshot, envFallback: () => false })) return null;
  const params = [firmId, clientId];
  let where = `firm_id = $1 and client_id = $2 and status <> 'open'`;
  if (onDate) {
    params.push(onDate);
    where += ' and starts_on <= $3::date and ends_on >= $3::date';
  }
  if (retainedFiscalStarts) {
    params.push(retainedFiscalStarts);
    where += ` and starts_on = any($${params.length}::date[])`;
  }
  let rows;
  try {
    const result = await client.query(
      `select label, starts_on::text as starts_on, ends_on::text as ends_on, status
         from fiscal_years where ${where} order by starts_on`,
      params
    );
    rows = result.rows;
  } catch (error) {
    if (error?.code === '42P01') return null; // pre-063 deploy: no table, no hold
    throw error;
  }
  const held = rows
    .map((fy) => ({ ...fy, hold: evaluateRetentionHold({ retentionClass, fiscalYearEndsOn: fy.ends_on, status: fy.status }) }))
    .filter((fy) => fy.hold.held);
  return held.length ? held : null;
};
const archiveRetentionForPeriod = async ({ client, firmId, clientId, periodStart, periodEnd }) => {
  try {
    const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
    if (!clientFlagActs({ flagKey: FINLAND_TILIKAUSI_FLAG_KEY, snapshot, envFallback: () => false })) return null;
    const result = await client.query(
      `select label, starts_on::text as starts_on, ends_on::text as ends_on, status
         from fiscal_years
        where firm_id = $1 and client_id = $2 and starts_on <= $3::date and ends_on >= $4::date
        order by starts_on
        limit 1`,
      [firmId, clientId, periodStart, periodEnd]
    );
    return result.rows.length ? describeArchiveRetention({ fiscalYear: result.rows[0] }) : null;
  } catch {
    return null;
  }
};
const enforceTilikausiNestingTx = async ({ client, firmId, clientId, period, actorId = 'system', resolveClientFiscalYearTx, ensureFiscalYearRowTx }) => {
  const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  if (!clientFlagActs({ flagKey: FINLAND_TILIKAUSI_FLAG_KEY, snapshot, envFallback: () => false })) return null;

  const clientRow = await client.query(
    `select incorporation_date, entity_type from clients where firm_id = $1 and id = $2 limit 1`,
    [firmId, clientId]
  );
  const incorporationDate = clientRow.rows[0]?.incorporation_date || null;
  const entityType = clientRow.rows[0]?.entity_type || null;

  // Entity-aware resolution of BOTH period ends (C6): for an Oy each end must
  // resolve from the persisted registry or throw; for a toiminimi both are
  // calendar resolutions, so comparing their labels is exactly the prior
  // periodStraddlesTilikausi check and the nesting check is unchanged.
  const fiscalYear = await resolveClientFiscalYearTx({ client, firmId, clientId, date: period.period_start, incorporationDate, entityType });
  const fiscalYearEnd = await resolveClientFiscalYearTx({ client, firmId, clientId, date: period.period_end, incorporationDate, entityType });
  if (fiscalYear.label !== fiscalYearEnd.label) {
    const error = new Error('Close period straddles two tilikaudet (Finnish fiscal years). Split it at the year boundary.');
    error.statusCode = 409;
    error.code = 'CLOSE_PERIOD_STRADDLES_TILIKAUSI';
    throw error;
  }

  if (!periodNestsInFiscalYear({ period_start: period.period_start, period_end: period.period_end }, fiscalYear)) {
    const error = new Error('Close period falls outside its tilikausi (e.g. a date before the business start).');
    error.statusCode = 409;
    error.code = 'CLOSE_PERIOD_OUTSIDE_TILIKAUSI';
    throw error;
  }

  return ensureFiscalYearRowTx({ client, firmId, clientId, fiscalYear, actorId });
};
const enforceTositeSequenceGapFreeTx = async ({ client, firmId, clientId, period, resolveClientFiscalYearTx, ledgerRecordId }) => {
  const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  const tositeActs = clientFlagActs({ flagKey: FINLAND_TOSITENUMERO_FLAG_KEY, snapshot, envFallback: () => false });
  const tilikausiActs = clientFlagActs({ flagKey: FINLAND_TILIKAUSI_FLAG_KEY, snapshot, envFallback: () => false });
  if (!tositeActs || !tilikausiActs) return null;

  const clientRow = await client.query(
    `select incorporation_date, entity_type from clients where firm_id = $1 and id = $2 limit 1`,
    [firmId, clientId]
  );
  const incorporationDate = clientRow.rows[0]?.incorporation_date || null;
  const entityType = clientRow.rows[0]?.entity_type || null;
  const fiscalYear = await resolveClientFiscalYearTx({ client, firmId, clientId, date: period.period_start, incorporationDate, entityType });
  const fiscalYearId = ledgerRecordId('fiscalyear', firmId, clientId, fiscalYear.starts_on);
  const assigned = await client.query(
    `select tosite_number
       from ledger_journals
      where firm_id = $1 and client_id = $2 and fiscal_year_id = $3 and tosite_number is not null`,
    [firmId, clientId, fiscalYearId]
  );
  // Throws (409 TOSITE_SEQUENCE_GAP / _DUPLICATE) on a broken sequence.
  assertTositeSequenceGapFree(assigned.rows.map((r) => r.tosite_number));
  return true;
};

export const FI_CLOSE_POLICY = Object.freeze({
  readsPersistedPeriod: ({ entityType }) => entityType === 'fi-oy',
  resolveFiscalYear: resolveFiscalYearForEntity,
  statutoryAssert: (entityType) => ({ starts_on, ends_on }) => assertValidTilikausi({ starts_on, ends_on, profile: entityType === 'fi-oy' ? 'general' : 'toiminimi' }),
  carryforwardActs: ({ snapshot }) => [FINLAND_OPENING_BALANCES_FLAG_KEY, FINLAND_TILIKAUSI_FLAG_KEY].every(flagKey => clientFlagActs({ flagKey, snapshot, envFallback: () => false })),
  retentionActs: ({ snapshot }) => clientFlagActs({ flagKey: FINLAND_TILIKAUSI_FLAG_KEY, snapshot, envFallback: () => false }),
  recognizesRetainedArchive: (retention) => retention?.statute === 'Kirjanpitolaki 2:10' && typeof retention?.fiscal_year?.starts_on === 'string',
  heldFiscalYearsForRetention,
  archiveRetentionForPeriod,
  enforcePeriodNesting: enforceTilikausiNestingTx,
  enforceVoucherSequence: enforceTositeSequenceGapFreeTx
});
