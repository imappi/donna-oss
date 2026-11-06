import { toIsoDay } from '../dates.js';
// A bounded view and guard over the existing profile writer, never a new writer.
export const FI_INTAKE_KEYS = Object.freeze(['businessId', 'incorporation_date', 'alv_registration', 'verokausi']);
const canonical = value => value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (left, right) => JSON.stringify(canonical(left ?? null)) === JSON.stringify(canonical(right ?? null));
const isFiOy = row => String(row?.jurisdiction).toUpperCase() === 'FI' && row?.entity_type === 'fi-oy';
// The lock protects what pilot preparation bound. An existing-owner adoption
// binds the WHOLE profile by digest, so any change invalidates it; birth-time
// preparation (authenticated firm creation, self-provisioned owner) binds no
// digest and runs before any form could be saved. There a still-empty fact may
// be filled once, receipted; a recorded value stays locked either way.
const preparation = async (client, firmId, clientId) => {
  const rows = (await client.query(`select id, metadata from audit_events
    where firm_id=$1 and client_id=$2 and resource_type='client' and resource_id=$2 and action='pilot.prepared'
    order by id`, [firmId, clientId])).rows;
  if (!rows.length) return null;
  return { receiptId: Number(rows.at(-1).id), adoptionBound: rows.some(({ metadata }) =>
    metadata?.owner_provenance?.kind === 'existing_owner_revalidated'
    || metadata?.adopted_profile_digest !== undefined || metadata?.adopted_admission_digest !== undefined) };
};
const empty = value => value == null || value === ''
  || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
const lockedKeys = (current, prep) => !prep ? [] : FI_INTAKE_KEYS.filter(key => prep.adoptionBound || !empty(current[key]));
const facts = row => Object.fromEntries(FI_INTAKE_KEYS.map(key => [key, key === 'incorporation_date'
  ? (toIsoDay(row.profile?.incorporation_date || row.incorporation_date) || null)
  : row.profile?.[key] ?? null]));

export const readFinnishProfileIntakeWithClient = async (client, { firmId, clientId }) => {
  const row = (await client.query('select jurisdiction,entity_type,incorporation_date,profile from clients where firm_id=$1 and id=$2', [firmId, clientId])).rows[0];
  if (!isFiOy(row)) throw Object.assign(new Error('Finnish company details require a Finnish Oy workspace.'), { code: 'FI_PROFILE_CLIENT_REQUIRED', statusCode: 409 });
  const fields = facts(row), prep = await preparation(client, firmId, clientId);
  const locked = lockedKeys(fields, prep);
  return { client_id: clientId, fields, editable: locked.length < FI_INTAKE_KEYS.length, locked_fields: locked,
    reason: locked.length ? 'pilot_prepared' : null };
};

// Called inside the existing writer's transaction. This locks the same client
// as pilot preparation, so a stale form cannot invalidate an adopted generation.
// Returns the keys to omit (semantic replays) and, after preparation, the
// receipt facts for any first fill, which the writer records on its audit.
export const assertFinnishProfileIntakeMutableWithClient = async (client, { firmId, clientId, patch }) => {
  const none = { preserved: [], firstFill: null };
  const keys = FI_INTAKE_KEYS.filter(key => Object.hasOwn(patch, key));
  if (!keys.length) return none;
  const row = (await client.query('select jurisdiction,entity_type,incorporation_date,profile from clients where firm_id=$1 and id=$2 for update', [firmId, clientId])).rows[0];
  if (!isFiOy(row)) return none;
  const current = facts(row);
  const prep = await preparation(client, firmId, clientId);
  if (!prep) return none;
  // Omit semantic replays altogether: adding a missing null key or copying the
  // column fallback into JSON would change the already-adopted profile digest.
  const preserved = keys.filter(key => same(current[key], patch[key]) || (empty(current[key]) && empty(patch[key])));
  const changed = keys.filter(key => !preserved.includes(key));
  const locked = lockedKeys(current, prep);
  if (changed.some(key => locked.includes(key))) {
    throw Object.assign(new Error('Pilot preparation already binds these company facts. Recorded facts are read-only until a reviewed reapproval workflow is available.'), { code: 'FI_PROFILE_PILOT_PREPARED', statusCode: 409 });
  }
  return { preserved, firstFill: changed.length ? { keys: changed, preparation_receipt_id: prep.receiptId,
    basis: 'empty_fact_after_birth_preparation', prior: Object.fromEntries(changed.map(key => [key, current[key]])) } : null };
};
