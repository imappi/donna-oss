// Gate 1B.3 — bounded enrollment for the Gate 1B.2 admission fence.
//
// Two postures may act, both client-specific and both still capped at canary:
//   - manual + a nonempty reason: the existing EAW / targeted-legacy selector;
//   - default + the exact source-controlled reason below: a genuinely new
//     desktop client enrolled inside its create transaction.
//
// Firm defaults, cohorts, arbitrary `default` rows and `auto` remain invalid.
// Cloud creation never calls this writer, so direct signed PUT stays observe-only.

import {
  ENTITY_READINESS_ADMISSION_FLAG,
  setClientFlagStage
} from './clientConfig.js';

export const ENTITY_READINESS_NEW_CLIENT_STAGE = 'canary';
export const ENTITY_READINESS_NEW_CLIENT_SOURCE = 'default';
export const ENTITY_READINESS_NEW_CLIENT_REASON = 'gate1b3_new_client_default_2026-08-30';
export const ENTITY_READINESS_ENROLLMENT_ACTION = 'entity.readiness.enrolled';

const clean = (value) => String(value ?? '').trim();
const rows = (result) => Array.isArray(result?.rows) ? result.rows : [];

export const classifyEntityReadinessEnrollment = (flagRow) => {
  if (!flagRow || flagRow.stage !== 'canary' || !clean(flagRow.reason)) {
    return { valid: false, enrollment_kind: null };
  }
  if (flagRow.source === 'manual') {
    return { valid: true, enrollment_kind: 'manual_target' };
  }
  if (flagRow.source === ENTITY_READINESS_NEW_CLIENT_SOURCE
      && flagRow.reason === ENTITY_READINESS_NEW_CLIENT_REASON) {
    return { valid: true, enrollment_kind: 'new_client_default' };
  }
  return { valid: false, enrollment_kind: null };
};

// Called only for a row that createClientInDb proved did not exist before the
// current transaction. A live row is nevertheless preserved defensively: a
// provisioning retry is never authority to supersede an explicit decision.
export const seedNewClientReadinessEnrollmentWithClient = async (
  client,
  { firmId, clientId } = {}
) => {
  if (!client || !clean(firmId) || !clean(clientId)) {
    throw new Error('New-client readiness enrollment needs client, firmId and clientId.');
  }
  const existing = rows(await client.query(
    `select id, flag_key, stage, source, reason
       from client_capability_config
      where firm_id = $1 and client_id = $2 and flag_key = $3
        and valid_to is null
      order by valid_from desc, id desc
      limit 1`,
    [firmId, clientId, ENTITY_READINESS_ADMISSION_FLAG]
  ))[0] || null;
  if (existing) return { applied: false, config_row: existing, receipt_id: null };

  const configRow = await setClientFlagStage(client, {
    firmId,
    clientId,
    flagKey: ENTITY_READINESS_ADMISSION_FLAG,
    stage: ENTITY_READINESS_NEW_CLIENT_STAGE,
    source: ENTITY_READINESS_NEW_CLIENT_SOURCE,
    reason: ENTITY_READINESS_NEW_CLIENT_REASON,
    actorType: 'system',
    actorId: 'entityReadinessNewClientEnrollment'
  });
  const receipt = rows(await client.query(
    `insert into audit_events
       (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'system', 'entityReadinessNewClientEnrollment', $3,
             'entity_readiness_enrollment', $2, $4::jsonb)
     returning id, created_at`,
    [
      firmId,
      clientId,
      ENTITY_READINESS_ENROLLMENT_ACTION,
      JSON.stringify({
        contract_version: 'donna.entity-readiness-enrollment.v1',
        enrollment_kind: 'new_client_default',
        rollout_stage: ENTITY_READINESS_NEW_CLIENT_STAGE,
        config_source: ENTITY_READINESS_NEW_CLIENT_SOURCE,
        reason: ENTITY_READINESS_NEW_CLIENT_REASON,
        config_row_id: configRow.id,
        authority_basis: {
          source: 'source_controlled_gate1b3_graduation',
          decision_date: '2026-08-30',
          scope: 'new_desktop_clients_only'
        },
        cloud_upload_enforcement: false
      })
    ]
  ))[0] || null;
  return {
    applied: true,
    config_row: configRow,
    receipt_id: receipt?.id == null ? null : Number(receipt.id)
  };
};
