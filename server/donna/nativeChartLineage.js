// Read/validation boundary only. The existing palette writer owns every insert.
// A retained birth receipt is authority for identity, never for accounting use.
import { createHash } from 'node:crypto';

// Discovery can conservatively exclude retained/partial markers, but must
// never use this predicate to grant authority. The verified reader decides.
export const retainedNativeMarkerSql = (alias = 't') => `(
  exists(select 1 from audit_events native_a where native_a.firm_id=${alias}.firm_id
    and native_a.resource_id=${alias}.client_id
    and native_a.id>coalesce((select max(native_d.id) from audit_events native_d
      where native_d.firm_id=${alias}.firm_id and native_d.resource_id=${alias}.client_id
        and native_d.action='client.delete'),0)
    and ((native_a.action='ledger.chart.palette_seeded' and native_a.metadata ? 'birth_contract')
      or (native_a.action='client.create' and native_a.metadata ? 'native_chart_birth')))
  or exists(select 1 from ledger_accounts native_account where native_account.firm_id=${alias}.firm_id
    and native_account.client_id=${alias}.client_id and native_account.payload ? 'birth_contract'))`;
import { resolveProvisioningBirthContract, resolveProvisioningPolicy } from './provisioningPolicyRegistry.js';
import { ledgerRecordId } from './db/shared.js';
import { readAccountingCurrency, readAccountingProfile } from '../../src/lib/accountingProfile.js';
import { toUtcIsoDay } from './dates.js';

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const nativeChartDigest = value => createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'undefined').digest('hex');
export const nativeChartFailure = reason => {
  throw Object.assign(new Error(`Native chart lineage refused: ${reason}`), {
    code: 'NATIVE_CHART_LINEAGE_INVALID', statusCode: 409, details: { reason }
  });
};
const requireThat = (condition, reason) => { if (!condition) nativeChartFailure(reason); };
const same = (a, b) => nativeChartDigest(a) === nativeChartDigest(b);
const SEED = 'ledger.chart.palette_seeded';
const VERSION = 'ledger.native-chart-birth.v1';

export const nativeBirthDefinition = contractId => {
  let definition;
  try { definition = resolveProvisioningBirthContract(contractId); }
  catch { nativeChartFailure('contract_unavailable'); }
  requireThat(definition && definition.contract_id === contractId, 'contract_unsupported');
  requireThat(nativeChartDigest(definition.selection) === definition.selection_digest, 'retained_selection_unavailable');
  requireThat(nativeChartDigest(definition.reference) === definition.reference_digest, 'retained_reference_unavailable');
  return definition;
};

export const nativeAccountProjection = row => ({
  id: row.id, code: row.code, name: row.name, account_type: row.account_type,
  normal_balance: row.normal_balance, canonical_role: row.canonical_role,
  status: row.status, currency: row.currency, statutory_group: row.payload?.statutory_group,
  reserved_use: row.payload?.reserved_use,
  birth_contract: row.payload?.birth_contract,
  selection_digest: row.payload?.selection_digest
});

export const nativeBirthAccounts = ({ contractId, firmId, clientId }) => {
  const definition = nativeBirthDefinition(contractId);
  return definition.selection.accounts.map(account => ({
    id: ledgerRecordId('account', firmId, clientId, account.code), code: account.code,
    name: account.name_en, account_type: account.account_type,
    normal_balance: account.normal_balance, canonical_role: account.canonical_role,
    status: 'active', currency: 'SGD', statutory_group: account.statutory_group, reserved_use: account.reserved_use,
    birth_contract: contractId, selection_digest: definition.selection_digest
  }));
};

export const validateNativeBirthInput = (input, clientRow, creationAudit) => {
  requireThat(input && typeof input === 'object' && !Array.isArray(input)
    && Object.keys(input).sort().join(',') === 'bookkeeping_start_date,id,registration_observation', 'birth_input_invalid');
  const definition = nativeBirthDefinition(input.id);
  requireThat(clientRow?.jurisdiction?.toLowerCase() === definition.selection.jurisdiction
    && clientRow.entity_type === definition.selection.legal_form
    && (!clientRow.profile?.jurisdiction || clientRow.profile.jurisdiction.toLowerCase() === definition.selection.jurisdiction)
    && [clientRow.profile?.entityType, clientRow.profile?.entity_type].every(form => !form || form === definition.selection.legal_form), 'birth_identity_invalid');
  requireThat(clientRow.profile?.accounting_system === 'none'
    && readAccountingProfile(clientRow.profile).view.value === 'management_books'
    && readAccountingProfile(clientRow.profile).view.status === 'stated'
    && readAccountingCurrency(clientRow.profile).value === 'SGD'
    && readAccountingCurrency(clientRow.profile).status === 'stated', 'birth_accounting_posture_invalid');
  const date = input.bookkeeping_start_date;
  requireThat(typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
    && toUtcIsoDay(date) === date, 'bookkeeping_start_date_invalid');
  // Observation, not GST eligibility or a fabricated registration history.
  const observation = input.registration_observation;
  requireThat(observation && typeof observation === 'object' && !Array.isArray(observation)
    && Object.keys(observation).sort().join(',') === 'record,revision'
    && observation.revision === 'profile.gst_registration.observation.v1'
    && same(observation.record, clientRow.profile.gst_registration ?? null), 'registration_observation_mismatch');
  requireThat(creationAudit?.actorType === 'firm_member' && creationAudit.actorId && creationAudit.actorId !== 'system'
    && creationAudit.authorityBasis?.source === 'authenticated_firm_create_route'
    && creationAudit.authorityBasis?.principal_id === creationAudit.actorId, 'birth_actor_required');
  return definition;
};

// Bounded current-life evidence. Keep old receipts available to distinguish a
// recreated client from a retry; never use the stable readiness saga as a life.
export const readNativeChartReceipts = async ({ query, firmId, clientId }) => (await query(
  `select id::text,firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata
    from audit_events where firm_id=$1 and resource_id=$2
    and action = any($3::text[]) order by audit_events.id`, [firmId, clientId, ['client.create', 'client.delete', SEED]])).rows;

export const readNativeChartObservation = async ({ query, firmId, clientId, receipts = null, lock = false }) => {
  const client = (await (lock ? query(`select id,firm_id,jurisdiction,entity_type,profile,
    to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as birth_created_at
    from clients where firm_id=$1 and id=$2 for share nowait`, [firmId, clientId])
    : query(`select id,firm_id,jurisdiction,entity_type,profile,
    to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as birth_created_at
    from clients where firm_id=$1 and id=$2`, [firmId, clientId]))).rows[0] || null;
  const accounts = (await (lock ? query(`select id,code,name,account_type,normal_balance,canonical_role,status,currency,payload
    from ledger_accounts where firm_id=$1 and client_id=$2 order by id for share nowait`, [firmId, clientId])
    : query(`select id,code,name,account_type,normal_balance,canonical_role,status,currency,payload
    from ledger_accounts where firm_id=$1 and client_id=$2 order by id`, [firmId, clientId]))).rows;
  return { firmId, clientId, client, accounts, receipts: receipts || await readNativeChartReceipts({ query, firmId, clientId }) };
};

export const verifyNativeChartObservation = (observation, { requireCreation = true, expectedContract = null } = {}) => {
  const { firmId, clientId, client, accounts, receipts } = observation;
  const deleted = receipts.filter(row => row.action === 'client.delete').at(-1);
  const deletionId = deleted?.id || '0';
  const current = receipts.filter(row => BigInt(row.id) > BigInt(deletionId));
  const seeds = current.filter(row => row.action === SEED);
  const births = current.filter(row => row.action === 'client.create');
  const marked = expectedContract || seeds.some(row => row.metadata?.birth_contract)
    || births.some(row => row.metadata?.native_chart_birth)
    || accounts.some(row => row.payload?.birth_contract);
  if (!marked) return null;
  requireThat(client && client.firm_id === firmId && client.id === clientId, 'client_life_missing');
  requireThat(seeds.length === 1, 'seed_receipt_count');
  const receipt = seeds[0], metadata = receipt.metadata || {};
  const definition = nativeBirthDefinition(metadata.birth_contract);
  requireThat(client.jurisdiction?.toLowerCase() === definition.selection.jurisdiction
    && client.entity_type === definition.selection.legal_form, 'birth_identity_invalid');
  requireThat(!expectedContract || metadata.birth_contract === expectedContract, 'birth_contract_mismatch');
  requireThat(metadata.version === VERSION && metadata.pack_id === definition.selection.jurisdiction, 'receipt_version_invalid');
  const inScope = row => row.firm_id === firmId && row.client_id === clientId
    && row.resource_type === 'client' && row.resource_id === clientId;
  requireThat(inScope(receipt) && receipt.actor_type === 'firm_member' && receipt.actor_id
    && receipt.actor_id !== 'system' && metadata.authority_basis?.source === 'authenticated_firm_create_route'
    && metadata.authority_basis?.principal_id === receipt.actor_id, 'receipt_authority_invalid');
  const life = { firm_id: firmId, client_id: clientId, created_at: client.birth_created_at, after_delete_id: deletionId };
  requireThat(same(metadata.client_life, life), 'client_life_mismatch');
  requireThat(metadata.native_chart_id === definition.selection.native_chart_id
    && metadata.native_chart_version === definition.selection.native_chart_version
    && metadata.native_content_digest === nativeChartDigest(definition.reference)
    && metadata.selection_id === definition.selection.selection_id
    && metadata.selection_version === definition.selection.selection_version
    && metadata.selection_digest === definition.selection_digest
    && metadata.menu_contract_version === definition.menu_contract_version, 'definition_mismatch');
  requireThat(metadata.status === 'provisional' && metadata.review_status === 'unreviewed'
    && metadata.processing_scope === 'document_processing_review_only' && metadata.accounting_ready === false, 'processing_scope_invalid');
  const { receipt_digest: digest, ...body } = metadata;
  requireThat(digest === nativeChartDigest(body), 'receipt_digest_mismatch');
  requireThat(metadata.registration_digest === nativeChartDigest(metadata.registration_observation), 'registration_digest_mismatch');
  const expected = nativeBirthAccounts({ contractId: metadata.birth_contract, firmId, clientId });
  const ordered = rows => [...rows].sort((a, b) => a.id.localeCompare(b.id));
  requireThat(same(ordered(expected), ordered(metadata.accounts || [])), 'receipt_accounts_mismatch');
  requireThat(same(ordered(expected), ordered(accounts.map(nativeAccountProjection))), 'persisted_accounts_mismatch');
  if (requireCreation) {
    const birth = births[0];
    requireThat(birth && inScope(birth) && BigInt(birth.id) > BigInt(receipt.id)
      && same(birth.metadata?.native_chart_birth, { receipt_id: receipt.id, receipt_digest: digest, contract_id: metadata.birth_contract })
      && birth.actor_type === receipt.actor_type && birth.actor_id === receipt.actor_id
      && same(birth.metadata?.authority_basis, metadata.authority_basis), 'creation_reference_invalid');
    requireThat(births.filter(row => row.metadata?.native_chart_birth).length === 1, 'creation_reference_count');
  }
  return { receipt, definition, accounts: expected, client_life: life };
};

export const readNativeChartLineage = async (args, options) => {
  // Probe through the canonical observation/validator first. Unmarked books
  // keep their existing writer lock semantics; every partial native marker
  // still refuses rather than falling back to legacy. A marked book is read
  // and verified again under its native locks before the caller can mutate.
  const lineage = verifyNativeChartObservation(await readNativeChartObservation({ ...args, lock: false }), options);
  if (!lineage || !args.lock) return lineage;
  return verifyNativeChartObservation(await readNativeChartObservation(args), options);
};

export const nativeRegistrationPolicyForLineage = lineage => lineage
  ? resolveProvisioningPolicy(lineage.definition.selection.jurisdiction)?.nativeRegistration || null : null;

export const NATIVE_REGISTRATION_HISTORY_LIMIT = 256;

export function verifyNativeRegistrationObservation({ lineage, profile, revisions = [], sourceDocument = null, forAppend = false }) {
  const policy = nativeRegistrationPolicyForLineage(lineage);
  if (!policy) return null;
  if (revisions.length > NATIVE_REGISTRATION_HISTORY_LIMIT) nativeChartFailure('registration_revision_history_overflow');
  if (forAppend && revisions.length === NATIVE_REGISTRATION_HISTORY_LIMIT) {
    throw Object.assign(new Error('Native registration history capacity reached; the current revision remains usable. Further edits require a separately qualified history-capacity change.'), {
      code: 'NATIVE_REGISTRATION_HISTORY_CAPACITY_REACHED', statusCode: 409,
      details: { limit: NATIVE_REGISTRATION_HISTORY_LIMIT, revision_count: revisions.length }
    });
  }
  return policy.verifyRevisions({ registration: profile?.[policy.field], storedRevision: profile?.[policy.revisionField],
    revisions, clientLife: lineage.client_life, birthDigest: lineage.receipt.metadata.registration_digest,
    birthRecord: lineage.receipt.metadata.registration_observation.record, sourceDocument });
}

// Existing profile is the projection; append-only profile audit is its proof.
// An unmarked client never enters this read or acquires native-only locks.
export async function readNativeRegistrationEvidence({ query, firmId, clientId, lineage, profile, lock = false, forAppend = false }) {
  const policy = nativeRegistrationPolicyForLineage(lineage);
  if (!policy) return null;
  const revisions = (await query(`select id,firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata
    from audit_events where firm_id=$1 and client_id=$2 and id>$3::bigint
      and action='client.profile.update' and metadata ? 'native_registration'
    order by id limit $4`, [firmId, clientId, lineage.client_life.after_delete_id, NATIVE_REGISTRATION_HISTORY_LIMIT + 1])).rows;
  const sourceId = profile?.[policy.field]?.source_document_id;
  const sourceDocument = sourceId ? (lock
    ? (await query('select * from documents where firm_id=$1 and client_id=$2 and id=$3 for share nowait', [firmId, clientId, sourceId])).rows[0] || null
    : (await query('select * from documents where firm_id=$1 and client_id=$2 and id=$3', [firmId, clientId, sourceId])).rows[0] || null) : null;
  return verifyNativeRegistrationObservation({ lineage, profile, revisions, sourceDocument, forAppend });
}

export const nativeBirthReceipt = ({ observation, birthContract, creationAudit }) => {
  const definition = validateNativeBirthInput(birthContract, observation.client, creationAudit);
  const deletionId = observation.receipts.filter(row => row.action === 'client.delete').at(-1)?.id || '0';
  const body = {
    version: VERSION, birth_contract: birthContract.id, pack_id: definition.selection.jurisdiction,
    client_life: { firm_id: observation.firmId, client_id: observation.clientId,
      created_at: observation.client.birth_created_at, after_delete_id: deletionId },
    authority_basis: creationAudit.authorityBasis,
    native_chart_id: definition.selection.native_chart_id, native_chart_version: definition.selection.native_chart_version,
    native_content_digest: nativeChartDigest(definition.reference),
    selection_id: definition.selection.selection_id, selection_version: definition.selection.selection_version,
    selection_digest: definition.selection_digest, menu_contract_version: definition.menu_contract_version,
    accounts: nativeBirthAccounts({ contractId: birthContract.id, firmId: observation.firmId, clientId: observation.clientId }),
    bookkeeping_start_date: birthContract.bookkeeping_start_date,
    registration_observation: birthContract.registration_observation,
    registration_digest: nativeChartDigest(birthContract.registration_observation),
    status: 'provisional', review_status: 'unreviewed', processing_scope: 'document_processing_review_only', accounting_ready: false
  };
  return { ...body, receipt_digest: nativeChartDigest(body) };
};
