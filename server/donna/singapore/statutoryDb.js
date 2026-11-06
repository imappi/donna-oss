// Country-owned statutory readers, watches, filing lifecycles and mandates.
// Moved from db/statutory.js without changing the named writers or receipt contracts.
import { clientFlagActs, readClientConfigSnapshot } from '../clientConfig.js';
import { assertGstF5Foots, buildGstF5FromLedgerLines, gstF5BoxMapProvenance, resolveGstPeriod, SINGAPORE_GST_FILING_FLAG_KEY, SINGAPORE_GST_RETURN_FLAG_KEY } from './gstReturn.js';
import { gstPeriodCadenceForProfile } from './gstRegistration.js';
import { CORPPASS_SCOPE_GST, evaluateCorpPassMandate } from './corpPassMandate.js';
import { gstReturnConfirmQuestion, gstReviewQuestion } from './gstReturnRoute.js';
import { withFirmDbClient } from '../db/pool.js';
import { shortHash } from '../db/shared.js';
import { DEFAULT_FIRM_ID, requireClientInFirm, getClientJurisdictionForEnrichment } from '../db/clients.js';
import { normalizeLedgerCurrency } from '../ledgerCurrency.js';
import { toIsoDay } from '../dates.js';
import { rowToClientEvidenceRequestPayload } from '../db/asks.js';
import { rowToLedgerLinePayload } from '../db/ledger.js';
import { deliverWhatsAppEvidenceAsksAfterSend } from '../db/channels.js';


// The ledger statuses a GST return counts. `closed` is a posted journal that a
// close lock has sealed (close.js flips posted → closed on POST /close/lock); the
// return must read the same books before and after the lock, exactly as the
// close's own trial balance (status <> 'voided') and the AE VAT reader do.
// draft/voided journals stay excluded.
const GST_RETURN_LEDGER_STATUSES = Object.freeze(['posted', 'closed']);

const refuseIdentity = (code, message) => {
  throw Object.assign(new Error(message), { code, statusCode: 409 });
};

// The ONE owner of the SGD / client-identity guard. The F5 has no currency
// conversion contract, so a foreign, unknown or cross-scope ledger amount must
// never be labelled SGD — by the compute read, the draft/filing lane that reuses
// it, or the review artifact. Identity/denomination only, never an aggregation.
const assertSingaporeGstLedgerIdentity = async ({ client, firmId, clientId, period }) => {
  if (await getClientJurisdictionForEnrichment({ client, firmId, clientId }) !== 'sg') {
    refuseIdentity('SINGAPORE_GST_DRAFT_JURISDICTION_REQUIRED', 'A GST F5 draft requires a persisted Singapore client identity.');
  }
  const { rows } = await client.query('select profile from clients where firm_id = $1 and id = $2', [firmId, clientId]);
  const profile = rows[0]?.profile || {};
  const currencies = [profile.accountingCurrency, profile.baseCurrency, profile.defaultCurrency]
    .filter(value => value != null && String(value).trim() !== '');
  if (!currencies.length || currencies.some(value => normalizeLedgerCurrency(value) !== 'SGD')) {
    refuseIdentity('SINGAPORE_GST_DRAFT_CURRENCY_REQUIRED', 'Confirm SGD accounting currency before computing a GST F5.');
  }
  const invalid = await client.query(
    `select ll.id from ledger_lines ll
       join ledger_journals lj on lj.id = ll.journal_id
       join ledger_accounts la on la.id = ll.account_id
      where ll.firm_id = $1 and ll.client_id = $2
        and lj.journal_date >= $3 and lj.journal_date <= $4 and lj.status = any($5::text[])
        and (upper(trim(ll.currency)) is distinct from 'SGD'
          or upper(trim(lj.currency)) is distinct from 'SGD'
          or lj.firm_id <> $1 or lj.client_id <> $2
          or la.firm_id <> $1 or la.client_id <> $2)
      limit 1`,
    [firmId, clientId, period.starts_on, period.ends_on, GST_RETURN_LEDGER_STATUSES]);
  if (invalid.rows.length) {
    refuseIdentity('SINGAPORE_GST_DRAFT_LEDGER_IDENTITY_INVALID', 'The period contains ledger amounts without consistent client and SGD identity.');
  }
};

// SG-3 — the GST F5 for a prescribed accounting period, computed from posted
// ledger lines. Deterministic read, mirroring getFinlandAlvReturnFromDb 1:1:
// flag-gated on the config plane, no model call, no ledger write, no persisted
// gst_returns row (the lifecycle store below mints that only from the start
// motion — a row minted here could only rest at "computed and parked", the
// two-terminal-states violation).
export const getSingaporeGstReturnFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  period,
  readAt = null,
  withFirmDbClientFn = withFirmDbClient
} = {}) => {
  if (!clientId) {
    const error = new Error('Client id is required for a Singapore GST return.');
    error.statusCode = 400;
    throw error;
  }
  const resolvedPeriod = resolveGstPeriod(period);

  return withFirmDbClientFn(async (client) => {
    await requireClientInFirm({ client, firmId, clientId });
    // Identity before the flag read: a foreign-jurisdiction / non-SGD client is
    // refused for what it is, whichever lane (compute, draft, filing, artifact)
    // reached this reader.
    await assertSingaporeGstLedgerIdentity({ client, firmId, clientId, period: resolvedPeriod });
    const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
    const gstReturnActs = clientFlagActs({ flagKey: SINGAPORE_GST_RETURN_FLAG_KEY, snapshot, envFallback: () => false });
    if (!gstReturnActs) {
      const error = new Error('Singapore GST return requires SINGAPORE_GST_RETURN for this client.');
      error.statusCode = 403;
      error.code = 'SINGAPORE_GST_RETURN_DISABLED';
      throw error;
    }

    // The client's IRAS-assigned filing cadence is DATA on clients.profile
    // (gst_period); surface it on the envelope so the read surface leads its
    // period picker with the right cadence (quarterly default).
    const profileResult = await client.query(
      'select profile from clients where firm_id = $1 and id = $2',
      [firmId, clientId]
    );
    const gstPeriod = gstPeriodCadenceForProfile(profileResult.rows[0]?.profile || {});

    const linesResult = await client.query(
      `select ll.*, la.account_type, la.canonical_role
         from ledger_lines ll
         join ledger_journals lj on lj.id = ll.journal_id
         join ledger_accounts la on la.id = ll.account_id
        where ll.firm_id = $1
          and ll.client_id = $2
          and lj.journal_date >= $3
          and lj.journal_date <= $4
          and lj.status = any($5::text[])
        order by lj.journal_date, lj.created_at, ll.line_no`,
      [firmId, clientId, resolvedPeriod.starts_on, resolvedPeriod.ends_on, GST_RETURN_LEDGER_STATUSES]
    );

    // rowToLedgerLinePayload lifts the joined la.account_type onto the line.
    const computed = buildGstF5FromLedgerLines({
      period: resolvedPeriod,
      lines: linesResult.rows.map(row => ({ ...rowToLedgerLinePayload(row), canonical_role: row.canonical_role || null }))
    });
    return {
      ...computed,
      gst_period: gstPeriod,
      provenance: {
        source: 'ledger_read_model',
        readAt: readAt || null,
        deterministic: true,
        boxMap: gstF5BoxMapProvenance()
      }
    };
  });
};


// ---------------------------------------------------------------------------------
// SG-3 — the GST return lifecycle store (migration 089) + the gst_return ask
// writer + the compute-and-file start motion. Mirrors the FI-3 alv_returns
// block above 1:1: compute-and-file; the owner's "yes" is the filing authority;
// the transmit channel is the injected IRAS adapter. Lifecycle enum is CLOSED
// (draft_pending_confirmation | filed | cancelled), every transition
// audit-as-precondition.
// ---------------------------------------------------------------------------------

export const singaporeGstFilingFlagActsInDb = async ({ firmId = DEFAULT_FIRM_ID, clientId } = {}) => {
  if (!clientId) return false;
  return withFirmDbClient(async (client) => {
    const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
    return Boolean(clientFlagActs({ flagKey: SINGAPORE_GST_FILING_FLAG_KEY, snapshot, envFallback: () => false }));
  });
};


export const createGstReturnEvidenceRequestInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  question,
  evidenceType = 'gst_return',
  requestPayload = {},
  actorId = 'system'
} = {}) => {
  const cleanClientId = String(clientId || '').trim();
  const cleanQuestion = String(question || '').trim();
  if (!cleanClientId || !cleanQuestion) {
    const error = new Error('Client id and question are required for a GST-return ask.');
    error.statusCode = 400;
    throw error;
  }
  const requestId = `gst-return-${firmId}-${cleanClientId}-${shortHash(`${Date.now()}:${cleanQuestion}`)}`;
  return withFirmDbClient(async (client) => {
    const result = await client.query(
      `insert into client_evidence_requests (
         id, firm_id, client_id, status, evidence_type, question, request_payload,
         first_sent_at, last_sent_at, send_count, created_by
       )
       values ($1, $2, $3, 'open', $4, $5, $6::jsonb, now(), now(), 1, $7)
       returning *`,
      [
        requestId,
        firmId,
        cleanClientId,
        String(evidenceType || 'gst_return'),
        cleanQuestion,
        JSON.stringify({ kind: String(evidenceType || 'gst_return'), ...(requestPayload || {}) }),
        actorId
      ]
    );
    return rowToClientEvidenceRequestPayload(result.rows[0]);
  });
};


const rowToGstReturnPayload = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    firm_id: row.firm_id,
    client_id: row.client_id,
    period_key: row.period_key,
    period_type: row.period_type,
    starts_on: toIsoDay(row.starts_on),
    ends_on: toIsoDay(row.ends_on),
    status: row.status,
    verdict: row.verdict || {},
    model: row.model || null,
    filing_receipt: row.filing_receipt || null,
    authority_basis: row.authority_basis || null,
    filed_at: row.filed_at || null,
    filed_by: row.filed_by || null,
    cancelled_at: row.cancelled_at || null,
    cancel_reason: row.cancel_reason || null,
    created_by: row.created_by || null
  };
};


export const __createGstReturnDraftWithClient = async ({
  client,
  firmId = DEFAULT_FIRM_ID,
  clientId,
  period,
  verdict,
  model = null,
  actorId = 'system'
} = {}) => {
  if (!clientId || !period?.key || !verdict?.gstReturn) {
    const error = new Error('Client id, a resolved period, and a computed verdict are required to draft a GST return.');
    error.statusCode = 400;
    throw error;
  }
  // A needs_review compute must NEVER mint a row — its blockers ride an owner
  // clarification ask instead (no parked state). Typed refusal, not a shade.
  if (verdict.review?.status !== 'ready') {
    const error = new Error(`GST return is not ready to draft: ${(verdict.review?.blockers || []).join(', ') || 'needs_review'}.`);
    error.statusCode = 409;
    error.code = 'GST_RETURN_NEEDS_REVIEW';
    throw error;
  }
  // The table's separate foreign keys cannot prove that this client belongs
  // to this firm. Reuse the existing ownership guard in the mint transaction.
  await requireClientInFirm({ client, firmId, clientId });
  assertGstF5Foots(verdict.gstReturn);
  const resolvedPeriod = resolveGstPeriod(period.key);
  const fields = ['type', 'starts_on', 'ends_on'];
  if (fields.some(field => period[field] !== resolvedPeriod[field])
    || (verdict.period && ['key', ...fields].some(field => verdict.period[field] !== resolvedPeriod[field]))) {
    throw Object.assign(new Error('GST draft period and verdict must match the canonical accounting period.'), {
      statusCode: 400, code: 'SINGAPORE_GST_PERIOD_INVALID'
    });
  }
  period = resolvedPeriod;
  const id = `gst-return-${firmId}-${clientId}-${period.key.toLowerCase()}-${shortHash(`${Date.now()}`)}`;
  let inserted;
  try {
    inserted = await client.query(
      `insert into gst_returns (
         id, firm_id, client_id, period_key, period_type, starts_on, ends_on, status, verdict, model, created_by
       )
       values ($1, $2, $3, $4, $5, $6, $7, 'draft_pending_confirmation', $8::jsonb, $9, $10)
       returning *`,
      [id, firmId, clientId, period.key, period.type, period.starts_on, period.ends_on, JSON.stringify(verdict), model, actorId]
    );
  } catch (error) {
    if (error?.code === '23505') {
      const refusal = new Error(`A GST return for ${period.key} is already pending or filed for this client.`);
      refusal.statusCode = 409;
      refusal.code = 'GST_RETURN_ALREADY_LIVE';
      throw refusal;
    }
    throw error;
  }
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'system', $3, 'gst_return.draft_created', 'gst_return', $4, $5::jsonb)`,
    [firmId, clientId, actorId, id, JSON.stringify({
      period_key: period.key,
      payable: verdict.gstReturn?.payable ?? null,
      nil_return: verdict.gstReturn?.nilReturn === true,
      model: model || null
    })]
  );
  return rowToGstReturnPayload(inserted.rows[0]);
};


export const createGstReturnDraftInDb = async (args = {}) => {
  return withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      const result = await __createGstReturnDraftWithClient({ client, ...args });
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
};


// Guarded transition helper: only a pending draft moves; anything else is a
// typed refusal, never a shade.
const gstReturnTransitionRefusal = () => {
  const error = new Error('GST return transition refused: the row is not a pending draft.');
  error.statusCode = 409;
  error.code = 'GST_RETURN_NOT_PENDING';
  return error;
};


export const __cancelGstReturnWithClient = async ({
  client,
  firmId = DEFAULT_FIRM_ID,
  clientId,
  gstReturnId,
  reason = 'owner_declined',
  authorityBasis = null,
  actorId = 'system'
} = {}) => {
  const updated = await client.query(
    `update gst_returns
        set status = 'cancelled', cancelled_at = now(), cancel_reason = $5,
            authority_basis = $6::jsonb, updated_at = now()
      where firm_id = $1 and client_id = $2 and id = $3 and status = $4
      returning *`,
    [firmId, clientId, gstReturnId, 'draft_pending_confirmation', String(reason || 'owner_declined'), JSON.stringify(authorityBasis || null)]
  );
  if (!updated.rows.length) throw gstReturnTransitionRefusal();
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'client', $3, 'gst_return.cancelled', 'gst_return', $4, $5::jsonb)`,
    [firmId, clientId, actorId, gstReturnId, JSON.stringify({
      period_key: updated.rows[0].period_key,
      reason: String(reason || 'owner_declined'),
      authority_basis: authorityBasis || null
    })]
  );
  return rowToGstReturnPayload(updated.rows[0]);
};


export const cancelGstReturnInDb = async (args = {}) => {
  return withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      const result = await __cancelGstReturnWithClient({ client, ...args });
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
};


export const __markGstReturnFiledWithClient = async ({
  client,
  firmId = DEFAULT_FIRM_ID,
  clientId,
  gstReturnId,
  filingReceipt = null,
  authorityBasis = null,
  actorId = 'system'
} = {}) => {
  if (!authorityBasis || !authorityBasis.source) {
    const error = new Error("Filing a GST return requires the owner's authority basis (the confirmation receipt).");
    error.statusCode = 400;
    error.code = 'GST_RETURN_AUTHORITY_REQUIRED';
    throw error;
  }
  const updated = await client.query(
    `update gst_returns
        set status = 'filed', filed_at = now(), filed_by = $5,
            filing_receipt = $6::jsonb, authority_basis = $7::jsonb, updated_at = now()
      where firm_id = $1 and client_id = $2 and id = $3 and status = $4
      returning *`,
    [firmId, clientId, gstReturnId, 'draft_pending_confirmation', actorId, JSON.stringify(filingReceipt || null), JSON.stringify(authorityBasis)]
  );
  if (!updated.rows.length) throw gstReturnTransitionRefusal();
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'client', $3, 'gst_return.filed', 'gst_return', $4, $5::jsonb)`,
    [firmId, clientId, actorId, gstReturnId, JSON.stringify({
      period_key: updated.rows[0].period_key,
      payable: updated.rows[0].verdict?.gstReturn?.payable ?? null,
      submission_id: filingReceipt?.submission_id || null,
      channel: filingReceipt?.channel || null,
      authority_basis: authorityBasis,
      // The model id is part of the receipt (null for a deterministic compute).
      model: updated.rows[0].model || filingReceipt?.model || null
    })]
  );
  return rowToGstReturnPayload(updated.rows[0]);
};


export const markGstReturnFiledInDb = async (args = {}) => {
  return withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      const result = await __markGstReturnFiledWithClient({ client, ...args });
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
};


export const getGstReturnByIdInDb = async ({ firmId = DEFAULT_FIRM_ID, clientId, gstReturnId } = {}) => {
  if (!gstReturnId) return null;
  return withFirmDbClient(async (client) => {
    const result = await client.query(
      'select * from gst_returns where firm_id = $1 and client_id = $2 and id = $3 limit 1',
      [firmId, clientId, gstReturnId]
    );
    return rowToGstReturnPayload(result.rows[0]);
  });
};


// The latest lifecycle row for a period — the read surface renders it beside
// the compute envelope (render-the-persisted-verdict). Latest-first so a
// cancel followed by a re-mint shows the live row.
export const getGstReturnForPeriodInDb = async ({ firmId = DEFAULT_FIRM_ID, clientId, periodKey } = {}) => {
  if (!clientId || !periodKey) return null;
  return withFirmDbClient(async (client) => {
    const result = await client.query(
      `select * from gst_returns
        where firm_id = $1 and client_id = $2 and period_key = $3
        order by created_at desc limit 1`,
      [firmId, clientId, String(periodKey).toUpperCase()]
    );
    return rowToGstReturnPayload(result.rows[0]);
  });
};


// ---------------------------------------------------------------------------------
// SG G-3 — the CorpPass mandate store (migration 089). The CorpPass grant is
// the LEGAL authorization IRAS/ACRA see when Donna files for a client; the
// transmit seam refuses without a valid one (SG_FILING_CORPPASS_REQUIRED).
// Status enum is CLOSED (active | revoked); expiry evaluates at read time
// (evaluateCorpPassMandate). Record/revoke are firm actions:
// audit-as-precondition, operator-attributed. Mirrors the suomifi_mandates
// store above 1:1.
// ---------------------------------------------------------------------------------

const rowToCorpPassMandatePayload = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    firm_id: row.firm_id,
    client_id: row.client_id,
    scope: row.scope,
    status: row.status,
    granted_on: row.granted_on,
    expires_on: row.expires_on || null,
    revoked_on: row.revoked_on || null,
    revoke_reason: row.revoke_reason || null,
    reference: row.reference || null,
    provenance: row.provenance || {},
    recorded_by: row.recorded_by || null,
    created_at: row.created_at || null
  };
};


export const __recordCorpPassMandateWithClient = async ({
  client,
  firmId = DEFAULT_FIRM_ID,
  clientId,
  scope = CORPPASS_SCOPE_GST,
  grantedOn,
  expiresOn = null,
  reference = null,
  provenance = {},
  actorId = 'system'
} = {}) => {
  const cleanClientId = String(clientId || '').trim();
  const cleanScope = String(scope || '').trim();
  const cleanGrantedOn = String(grantedOn || '').slice(0, 10);
  if (!cleanClientId || !cleanScope || !/^\d{4}-\d{2}-\d{2}$/.test(cleanGrantedOn)) {
    const error = new Error('Recording a CorpPass mandate requires client id, scope, and a granted_on date (YYYY-MM-DD).');
    error.statusCode = 400;
    throw error;
  }
  const id = `corppass-mandate-${firmId}-${cleanClientId}-${shortHash(`${cleanScope}:${Date.now()}`)}`;
  let inserted;
  try {
    inserted = await client.query(
      `insert into corppass_mandates (
         id, firm_id, client_id, scope, status, granted_on, expires_on, reference, provenance, recorded_by
       )
       values ($1, $2, $3, $4, 'active', $5, $6, $7, $8::jsonb, $9)
       returning *`,
      [id, firmId, cleanClientId, cleanScope, cleanGrantedOn, expiresOn || null, reference || null, JSON.stringify(provenance || {}), actorId]
    );
  } catch (error) {
    if (error?.code === '23505') {
      const refusal = new Error(`An active CorpPass mandate (${cleanScope}) is already recorded for this client — revoke it before recording a new grant.`);
      refusal.statusCode = 409;
      refusal.code = 'CORPPASS_MANDATE_ALREADY_ACTIVE';
      throw refusal;
    }
    throw error;
  }
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'firm_member', $3, 'corppass_mandate.recorded', 'corppass_mandate', $4, $5::jsonb)`,
    [firmId, cleanClientId, actorId, id, JSON.stringify({
      scope: cleanScope,
      granted_on: cleanGrantedOn,
      expires_on: expiresOn || null,
      reference: reference || null,
      provenance: provenance || {}
    })]
  );
  return rowToCorpPassMandatePayload(inserted.rows[0]);
};


export const recordCorpPassMandateInDb = async (args = {}) => {
  return withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      const result = await __recordCorpPassMandateWithClient({ client, ...args });
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
};


export const __revokeCorpPassMandateWithClient = async ({
  client,
  firmId = DEFAULT_FIRM_ID,
  clientId,
  mandateId,
  reason = 'revoked_by_firm',
  actorId = 'system'
} = {}) => {
  const updated = await client.query(
    `update corppass_mandates
        set status = 'revoked', revoked_on = now()::date, revoke_reason = $5, updated_at = now()
      where firm_id = $1 and client_id = $2 and id = $3 and status = $4
      returning *`,
    [firmId, clientId, mandateId, 'active', String(reason || 'revoked_by_firm')]
  );
  if (!updated.rows.length) {
    const error = new Error('CorpPass mandate revocation refused: the row is not an active mandate.');
    error.statusCode = 409;
    error.code = 'CORPPASS_MANDATE_NOT_ACTIVE';
    throw error;
  }
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'firm_member', $3, 'corppass_mandate.revoked', 'corppass_mandate', $4, $5::jsonb)`,
    [firmId, clientId, actorId, mandateId, JSON.stringify({
      scope: updated.rows[0].scope,
      reason: String(reason || 'revoked_by_firm')
    })]
  );
  return rowToCorpPassMandatePayload(updated.rows[0]);
};


export const revokeCorpPassMandateInDb = async (args = {}) => {
  return withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      const result = await __revokeCorpPassMandateWithClient({ client, ...args });
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
};


// The filing gate's lookup: the single active row for (client, scope). Validity
// (expiry, effectivity) is evaluated by the PURE module at the filing moment —
// this read never decides, it only fetches.
export const getActiveCorpPassMandateInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  scope = CORPPASS_SCOPE_GST
} = {}) => {
  if (!clientId) return null;
  return withFirmDbClient(async (client) => {
    const result = await client.query(
      `select * from corppass_mandates
        where firm_id = $1 and client_id = $2 and scope = $3 and status = 'active'
        order by created_at desc limit 1`,
      [firmId, clientId, String(scope)]
    );
    return rowToCorpPassMandatePayload(result.rows[0]);
  });
};


// The report surface: mandate + dated evaluation in one envelope
// (render-the-persisted-verdict).
export const getCorpPassMandateStatusInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  scope = CORPPASS_SCOPE_GST,
  readAt = new Date().toISOString()
} = {}) => {
  const mandate = await getActiveCorpPassMandateInDb({ firmId, clientId, scope });
  const evaluation = evaluateCorpPassMandate({ mandate, scope, onDate: readAt });
  return { scope: String(scope), mandate, evaluation, read_at: readAt };
};


// startSingaporeGstReturnFilingInDb — the lane's start motion, mirroring
// startFinlandAlvReturnFilingInDb: compute the period F5 (the same
// deterministic read as getSingaporeGstReturnFromDb), then drive it to one of
// the two sanctioned places:
//   • ready  → mint the draft row + the gst_return confirm ask, deliver over
//     the existing outbound-ask substrate — ON THE OWNER;
//   • needs_review → NO row; the blockers ride an owner clarification ask
//     (evidence_type gst_return_review, resolved via the generic evidence
//     path) — ON THE OWNER.
// Gated by SINGAPORE_GST_FILING (the compute read inside keeps its own
// SINGAPORE_GST_RETURN gate).
export const startSingaporeGstReturnFilingInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  period,
  actorId = 'system',
  computeImpl = null,
  deliverAsksImpl = null,
  flagActsImpl = null,
  createDraftImpl = null,
  createAskImpl = null
} = {}) => {
  if (!clientId) {
    const error = new Error('Client id is required to start a GST return filing.');
    error.statusCode = 400;
    throw error;
  }
  const flagActsFn = flagActsImpl || singaporeGstFilingFlagActsInDb;
  const filingActs = await flagActsFn({ firmId, clientId });
  if (!filingActs) {
    const error = new Error('The Singapore GST filing lane is not enabled for this client.');
    error.statusCode = 403;
    error.code = 'SINGAPORE_GST_FILING_DISABLED';
    throw error;
  }
  const compute = computeImpl || getSingaporeGstReturnFromDb;
  const computed = await compute({ firmId, clientId, period });

  if (computed.review?.status !== 'ready') {
    const blockers = computed.review?.blockers || [];
    const question = gstReviewQuestion(computed);
    const createAsk = createAskImpl || createGstReturnEvidenceRequestInDb;
    const ask = await createAsk({
      firmId,
      clientId,
      question,
      evidenceType: 'gst_return_review',
      requestPayload: { period_key: computed.period.key, blockers },
      actorId
    });
    const deliver = deliverAsksImpl
      || ((args) => withFirmDbClient((client) => deliverWhatsAppEvidenceAsksAfterSend({ client, ...args })));
    await deliver({ firmId, clientId, evidenceRequestIds: [ask.id] });
    return { action: 'escalated', blockers, ask, period: computed.period };
  }

  const createDraft = createDraftImpl || createGstReturnDraftInDb;
  const row = await createDraft({
    firmId,
    clientId,
    period: computed.period,
    verdict: { gstReturn: computed.gstReturn, review: computed.review, provenance: computed.provenance },
    model: null,
    actorId
  });
  const question = gstReturnConfirmQuestion({ periodKey: row.period_key, verdict: row.verdict });
  const createAsk = createAskImpl || createGstReturnEvidenceRequestInDb;
  const ask = await createAsk({
    firmId,
    clientId,
    question,
    evidenceType: 'gst_return',
    requestPayload: { gst_return: { phase: 'confirm_request', gst_return_id: row.id, period_key: row.period_key } },
    actorId
  });
  const deliver = deliverAsksImpl
    || ((args) => withFirmDbClient((client) => deliverWhatsAppEvidenceAsksAfterSend({ client, ...args })));
  await deliver({ firmId, clientId, evidenceRequestIds: [ask.id] });
  return { action: 'confirmation_requested', gstReturn: row, ask };
};


// SG — filer identity for the IRAS adapter: the client's UEN (+ any special
// GST registration number) off the profile. The UEN rides profile.uen with
// profile.business_id as the generic-identity fallback (the same free-form
// profile-key posture as the Finland seller context). Missing pieces are the
// route's cue to refuse typed (GST_FILING_REJECTED, owner-readable), never to
// guess.
export const getSingaporeFilerContextInDb = async ({ firmId = DEFAULT_FIRM_ID, clientId } = {}) => {
  if (!clientId) return {};
  return withFirmDbClient(async (client) => {
    const result = await client.query(
      `select profile from clients where firm_id = $1 and id = $2 limit 1`,
      [firmId, clientId]
    );
    const profile = result.rows[0]?.profile || {};
    const registration = profile.gst_registration && typeof profile.gst_registration === 'object'
      ? profile.gst_registration
      : {};
    return {
      uen: String(profile.uen || profile.business_id || '').trim() || null,
      gstRegistrationNumber: String(registration.gst_registration_number || '').trim() || null
    };
  });
};
