import { withFirmDbClient } from '../firmDb.js';
import { normalizeHmrcVatCustomerProfile } from './hmrcVatCustomerProfile.js';

// The closed obligation-state vocabulary. Exported so migrations.test.js can PIN
// it to migration 111's CHECK constraint — a status this module accepts but the
// column rejects would be a silent write failure, and the repo pins every such
// vocabulary to its runtime for exactly that reason.
//
// 'unknown' is a deliberate local state, not a guess at an HMRC value: it is what
// a period is called when the authority's own status has not been confirmed. No
// wire semantics are asserted here.
export const VAT_PERIOD_STATUSES = Object.freeze(['open', 'fulfilled', 'unknown']);

const PERIOD_STATUSES = new Set(VAT_PERIOD_STATUSES);

const typedError = (code, message, statusCode = 503) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

export const mtdVatReadTransportPendingConfirmation = async () => {
  throw typedError(
    'GB_VAT_FILING_CHANNEL_UNAVAILABLE',
    'The HMRC VAT read channel is unavailable pending confirmation.'
  );
};

export const createHmrcVatReadAdapter = ({
  transport = mtdVatReadTransportPendingConfirmation
} = {}) => ({
  readCustomerProfileAndObligations: (request) => transport(request)
});

const requireText = (value, field) => {
  if (typeof value !== 'string' || value.length === 0) {
    throw typedError('GB_VAT_OBLIGATION_INVALID', `${field} is required.`, 400);
  }
  return value;
};

const normalizeRead = ({ profile, periods } = {}) => {
  if (!profile || !Array.isArray(periods)) {
    throw typedError('GB_VAT_OBLIGATION_INVALID', 'Profile and periods are required.', 400);
  }
  const normalizedProfile = normalizeHmrcVatCustomerProfile(profile);
  const normalizedPeriods = periods.map((period) => {
    const status = requireText(period.status, 'period.status');
    if (!PERIOD_STATUSES.has(status)) {
      throw typedError('GB_VAT_OBLIGATION_INVALID', 'period.status is unsupported.', 400);
    }
    if (period.payload === undefined) {
      throw typedError('GB_VAT_OBLIGATION_INVALID', 'period.payload is required.', 400);
    }
    return {
      id: requireText(period.id, 'period.id'),
      // Deliberately no trim, parsing, decoding, or reconstruction.
      periodKey: requireText(period.periodKey, 'period.periodKey'),
      startDate: requireText(period.startDate, 'period.startDate'),
      endDate: requireText(period.endDate, 'period.endDate'),
      dueDate: requireText(period.dueDate, 'period.dueDate'),
      receivedDate: period.receivedDate ?? null,
      status,
      payload: period.payload
    };
  });
  return { profile: normalizedProfile, periods: normalizedPeriods };
};

export const persistHmrcVatReadWithClient = async ({
  client,
  firmId,
  clientId,
  syncedAt,
  read
}) => {
  requireText(firmId, 'firmId');
  requireText(clientId, 'clientId');
  requireText(syncedAt, 'syncedAt');
  const { profile, periods } = normalizeRead(read);

  await client.query('begin');
  try {
    await client.query(
      `insert into vat_customer_profiles (
         id, firm_id, client_id, vrn, effective_registration_date,
         flat_rate_scheme, deregistration_date, hmrc_payload, synced_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
       on conflict (firm_id, client_id, vrn) do update set
         effective_registration_date = excluded.effective_registration_date,
         flat_rate_scheme = excluded.flat_rate_scheme,
         deregistration_date = excluded.deregistration_date,
         hmrc_payload = excluded.hmrc_payload,
         synced_at = excluded.synced_at,
         updated_at = excluded.synced_at`,
      [profile.id, firmId, clientId, profile.vrn, profile.effectiveRegistrationDate,
        profile.flatRateScheme, profile.deregistrationDate, JSON.stringify(profile.payload), syncedAt]
    );
    for (const period of periods) {
      const periodWrite = await client.query(
        `insert into vat_periods (
           id, firm_id, client_id, vrn, period_key, start_date, end_date,
           due_date, received_date, status, hmrc_obligation_payload, synced_at
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
         on conflict (id) do update set
           start_date = excluded.start_date,
           end_date = excluded.end_date,
           due_date = excluded.due_date,
           received_date = excluded.received_date,
           status = excluded.status,
           hmrc_obligation_payload = excluded.hmrc_obligation_payload,
           synced_at = excluded.synced_at,
           updated_at = excluded.synced_at
         where vat_periods.firm_id = excluded.firm_id
           and vat_periods.client_id = excluded.client_id
         returning id`,
        [period.id, firmId, clientId, profile.vrn, period.periodKey, period.startDate,
          period.endDate, period.dueDate, period.receivedDate, period.status,
          JSON.stringify(period.payload), syncedAt]
      );
      if (periodWrite.rowCount !== 1 && periodWrite.rows?.length !== 1) {
        throw typedError(
          'GB_VAT_PERIOD_TENANT_COLLISION',
          'VAT period id is already owned by another firm or client.',
          409
        );
      }
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
};

export const syncHmrcVatReadWithClient = async ({
  client,
  firmId,
  clientId,
  syncedAt,
  adapter = createHmrcVatReadAdapter()
}) => {
  const read = await adapter.readCustomerProfileAndObligations({ firmId, clientId });
  await persistHmrcVatReadWithClient({ client, firmId, clientId, syncedAt, read });
};

// Production intentionally supplies no transport override. The refusing default
// is the live behavior until the outstanding wire facts are confirmed.
export const syncHmrcVatReadFromDb = ({
  firmId,
  clientId,
  syncedAt,
  withFirmDbClientFn = withFirmDbClient
} = {}) =>
  withFirmDbClientFn((client) => syncHmrcVatReadWithClient({
    client,
    firmId,
    clientId,
    syncedAt,
    adapter: createHmrcVatReadAdapter()
  }));
