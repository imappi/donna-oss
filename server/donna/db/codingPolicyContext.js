// One persisted read context for coding and posting lineage. Callers own the
// transaction; profile, guidance snapshot and native lineage travel together.
import { readClientConfigSnapshot } from '../clientConfig.js';
import { readNativeChartLineage, readNativeRegistrationEvidence } from '../nativeChartLineage.js';
import { nativeCodingContext } from '../codingAccountChoices.js';
import { codingGuidanceVariantForSnapshot } from '../codingGuidanceVariant.js';
import { resolveCodingPolicy, CodingPolicyError, isCodingPolicyError } from '../codingPolicy.js';

// F-31: lock contention on the client's native source/profile fence is a typed,
// retryable 409 — never a raw 500 and never a runtime-policy incident. The write
// rolls back whole and stays proposed/re-appliable; nothing failed, so no
// transaction.coding.policy_failed receipt is minted for a collision (the same
// pattern as cloud evidence intake's lockUploadClientInFirm). The driver's
// 55P03 code stays on the error so every caller that classifies a skip as
// contended keeps working; only the status, the member-facing text and the
// retryable marker are added.
export const isFenceContention = (error) => error?.code === '55P03';
export const nativeSourceFenceBusy = (error) => {
  if (!error || error.statusCode === 409 && error.retryable === true) return error;
  error.pgMessage = error.message;
  error.message = "Another update to this client's books is in progress. Retry in a moment.";
  error.statusCode = 409;
  error.retryable = true;
  return error;
};

export const readClientCodingContextWithClient = async ({ client, firmId, clientId, businessDate = null, lockContext = false }) => {
  try {
    // The native lineage reader already owns a NOWAIT client/account fence.
    // Acquire it before the legacy profile share lock, or an in-flight native
    // profile edit would wait here before reaching its intended refusal fence.
    const lineage = await readNativeChartLineage({ query: client.query.bind(client), firmId, clientId, lock: lockContext });
    const result = lockContext
      ? await client.query('select jurisdiction, entity_type, profile from clients where firm_id = $1 and id = $2 limit 1 for share', [firmId, clientId])
      : await client.query('select jurisdiction, entity_type, profile from clients where firm_id = $1 and id = $2 limit 1', [firmId, clientId]);
    const row = result.rows[0] || {};
    const registration = await readNativeRegistrationEvidence({ query: client.query.bind(client), firmId, clientId,
      lineage, profile: row.profile, lock: lockContext });
    const snapshot = await readClientConfigSnapshot(client, { firmId, clientId, strict: true });
    const codingPolicy = resolveCodingPolicy({
      guidanceVariant: codingGuidanceVariantForSnapshot(snapshot),
      jurisdiction: row.jurisdiction, profileJurisdiction: row.profile?.jurisdiction,
      entityType: row.entity_type || row.profile?.entityType || row.profile?.entity_type,
      profileEntityType: row.profile?.entityType || row.profile?.entity_type,
      businessDate, nativeChart: nativeCodingContext(lineage, row.profile, registration),
      taxProfile: row.profile?.taxProfile || row.profile?.tax_profile,
      accountingSystem: row.profile?.accounting_system
    });
    return { row, snapshot, codingPolicy };
  } catch (error) {
    if (isCodingPolicyError(error)) throw error;
    if (isFenceContention(error)) throw nativeSourceFenceBusy(error);
    throw new CodingPolicyError('coding_policy_unavailable', { details: { cause: error.code || 'configuration_read_failed' } });
  }
};
