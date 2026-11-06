// Physical counts orchestrate the existing inventory, evidence, case and ledger owners.
// All writers own ONE transaction; nested inventory/posting calls never commit independently.
import { assertFirmAccess, getAssignmentRoleForPrincipal } from '../db/authority.js';
import { authorizeOperatorAction } from '../operatorCapability.js';
import { normalizeJurisdictionKey } from '../taxCodeJurisdiction.js';
import { foldOperations } from './core.js';
import { clientFlagActs, readClientConfigSnapshot } from '../clientConfig.js';
import { openOrFindCase, appendCaseEvent, linkObject, openBlocker, resolveBlocker, markCaseResolved } from '../caseManager.js';
import { applyInventoryCountCorrectionWithinTransaction, lockInventoryScope } from './db.js';
import { valueInventoryOperations } from './valuation.js';
import { buildInventoryJournalDraft } from './posting.js';
import { postInventoryJournalWithinTransaction } from './postingDb.js';
import { ensurePhysicalAsk, resolvePhysicalAsk, physicalTaskAssignment } from './physicalReconciliationAsks.js';
import { runInventoryReconciliationFromDb } from './reconciliationDb.js';
import { PHYSICAL_RECONCILIATION_FLAG_KEY, PHYSICAL_TERMINAL_STATES, physicalHash, physicalAskAcknowledged, physicalRefusal, proposePhysicalObservation, validatePhysicalResolution } from './physicalReconciliation.js';

export const PHYSICAL_INVENTORY_APPLY_FLAG_KEY = 'PHYSICAL_INVENTORY_APPLY';
const protocol = 'physical-human-count/1';
const fail = (reason, detail = {}) => { throw Object.assign(new Error(reason), { physicalRefusal: physicalRefusal(reason, detail) }); };
const flag = (snapshot, flagKey) => clientFlagActs({ snapshot, flagKey, envFallback: () => false });
const json = (v) => JSON.stringify(v);
const now = async (client) => (await client.query('select clock_timestamp() as time')).rows[0].time.toISOString();
const owner = (a) => ({ type: ['firm','firm_member','firm_collaborator'].includes(a.actorType) ? 'reviewer' : 'customer', actorId: a.actorId });
const context = async (a) => {
  if (!a.client || !a.firmId || !a.clientId || !a.actorId || a.actorId === 'system') fail('invalid_scope');
  const row = (await a.client.query('select id, profile from clients where firm_id=$1 and id=$2 for update', [a.firmId, a.clientId])).rows[0];
  if (!row) fail('scope_refused');
  return row;
};
const audit = async (a, intent, resourceId, receipt) => a.client.query(
  `insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
   values($1,$2,'user',$3,$4,'inventory_count_session',$5,$6::jsonb)`,
  [a.firmId, a.clientId, a.actorId, intent, String(resourceId), json({ receipt })]);
const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => [k, canonical(v[k])])) : v;

const mutate = async (a, intent, body) => {
  if (typeof a.idempotencyKey !== 'string' || !a.idempotencyKey.trim() || a.idempotencyKey.length > 200) return physicalRefusal('invalid_idempotency_key');
  const { client, authorize, ...input } = a;
  const inputHash = physicalHash(canonical(input));
  const key = `physical:${a.firmId}:${a.clientId}:${intent}:${a.idempotencyKey}`;
  await client.query('begin');
  try {
    await lockInventoryScope({ client, clientId: a.clientId });
    await context(a);
    if (authorize) await authorize(client);
    if (['firm_member','firm_collaborator'].includes(a.actorType)) {
      await client.query(a.actorType === 'firm_member'
        ? 'select id from firm_members where firm_id=$1 and id=$2 for share'
        : 'select id from firm_collaborators where firm_id=$1 and id=$2 for share', [a.firmId,a.actorId]);
      await client.query('select id from client_assignments where firm_id=$1 and client_id=$2 and principal_type=$3 and principal_id=$4 for share', [a.firmId,a.clientId,a.actorType,a.actorId]);
    }
    await client.query('select id from client_capability_config where firm_id=$1 and (client_id=$2 or client_id is null) for share', [a.firmId,a.clientId]);
    const principal = (await assertFirmAccess({ firmId: a.firmId, clientIds: [a.clientId], resolvedPrincipal: { principalType: a.actorType, principalId: a.actorId }, dbClient: client })).principal;
    const assignmentRole = await getAssignmentRoleForPrincipal({ firmId: a.firmId, clientId: a.clientId, principal, dbClient: client });
    if (!authorizeOperatorAction({ principal, assignmentRole, actionType: `${intent}_physical_reconciliation` }).allowed) fail('authority_refused');
    if (intent === 'resolve' && ['confirmed_shortage','confirmed_found_stock'].includes(a.action)
      && !authorizeOperatorAction({ principal, assignmentRole, actionType: 'post_inventory_journal' }).allowed) fail('posting_authority_refused');
    const snapshot = await readClientConfigSnapshot(client, a);
    if (!flag(snapshot, PHYSICAL_RECONCILIATION_FLAG_KEY) || !flag(snapshot, 'INVENTORY_CORE')) fail('flag_disabled');
    const prior = (await client.query('select receipt from inventory_command_receipts where firm_id=$1 and client_id=$2 and idempotency_key=$3', [a.firmId, a.clientId, key])).rows[0]?.receipt;
    if (prior) {
      if (prior.inputHash !== inputHash) fail('idempotency_conflict');
      await client.query('commit');
      return { applied: true, receipt: { ...prior, replayed: true }, ...(await getPhysicalReconciliation({ ...a, sessionId: prior.sessionId })) };
    }
    const receipt = { ...(await body({ snapshot, key, asOf: await now(client) })), inputHash, actorId: a.actorId,
      authorityBasis: 'authenticated_scoped_actor_and_current_client_configuration', intent: `inventory.physical.${intent}` };
    await client.query('insert into inventory_command_receipts(firm_id,client_id,idempotency_key,intent,receipt) values($1,$2,$3,$4,$5::jsonb)', [a.firmId, a.clientId, key, receipt.intent, json(receipt)]);
    await audit(a, receipt.intent, receipt.sessionId, receipt);
    await client.query('commit');
    return { applied: true, receipt, ...(await getPhysicalReconciliation({ ...a, sessionId: receipt.sessionId })) };
  } catch (error) {
    await client.query('rollback');
    if (error.physicalRefusal) return error.physicalRefusal;
    throw error;
  }
};

const sessionRow = async (a, lock = false) => {
  if (!/^[1-9][0-9]*$/.test(String(a.sessionId))) fail('session_not_found');
  const row = (await a.client.query(lock
    ? 'select * from inventory_count_sessions where firm_id=$1 and client_id=$2 and id=$3 and physical_reconciliation for update'
    : 'select * from inventory_count_sessions where firm_id=$1 and client_id=$2 and id=$3 and physical_reconciliation', [a.firmId, a.clientId, a.sessionId])).rows[0];
  if (!row) fail('session_not_found');
  return row;
};
const lineRow = async (a) => {
  if (!/^[1-9][0-9]*$/.test(String(a.lineId))) fail('line_not_found');
  const session = await sessionRow(a, true);
  const line = (await a.client.query('select * from inventory_count_lines where firm_id=$1 and client_id=$2 and count_session_id=$3 and id=$4 for update', [a.firmId, a.clientId, a.sessionId, a.lineId])).rows[0];
  if (!line) fail('line_not_found');
  return { session, line };
};
const stream = async (a, itemId, locationId) => (await a.client.query(
  'select * from inventory_operations where firm_id=$1 and client_id=$2 and item_id=$3 and location_id=$4 order by occurred_at,id', [a.firmId, a.clientId, itemId, locationId])).rows;
const basis = async (a, itemId, locationId, snapshot, asOf) => {
  const item = (await a.client.query('select * from inventory_items where firm_id=$1 and client_id=$2 and id=$3', [a.firmId, a.clientId, itemId])).rows[0];
  const location = (await a.client.query('select * from inventory_locations where firm_id=$1 and client_id=$2 and id=$3', [a.firmId, a.clientId, locationId])).rows[0];
  if (!item || !location || item.status !== 'active' || !item.base_uom_id) fail('unsupported_inventory_scope');
  const level = (await a.client.query('select * from inventory_item_levels where firm_id=$1 and client_id=$2 and item_id=$3 and location_id=$4 for update', [a.firmId, a.clientId, itemId, locationId])).rows[0];
  const operations = await stream(a, itemId, locationId);
  if (operations.some((op) => new Date(op.occurred_at).getTime() > Date.parse(asOf))) fail('future_inventory_movement');
  const folded = foldOperations(operations)[0];
  if (Math.abs(Number(folded?.on_hand || 0) - Number(level?.on_hand || 0)) > 0.000001) fail('inventory_projection_mismatch');
  const entity = (await a.client.query('select jurisdiction,profile from clients where firm_id=$1 and id=$2', [a.firmId,a.clientId])).rows[0];
  const policy = entity?.profile?.physical_reconciliation || null;
  const accountMappings = (await a.client.query("select id,code,name,canonical_role,account_type,normal_balance,currency,status,payload from ledger_accounts where firm_id=$1 and client_id=$2 and canonical_role=any($3::text[]) order by id for share", [a.firmId,a.clientId,['asset.inventory','pnl.inventory_count_variance']])).rows;
  const valuation = valueInventoryOperations({ operations });
  if (valuation.applied && Math.abs(valuation.receipt.qtyOnHand - Number(level?.on_hand || 0)) > 0.000001) fail('inventory_projection_mismatch');
  const accountingLinks = (await a.client.query(`select a.operation_id,a.ledger_journal_id,a.ledger_line_id,a.allocated_amount,a.allocated_currency,j.status,j.journal_date,j.updated_at
    from inventory_journal_allocations a join ledger_journals j on j.id=a.ledger_journal_id
    where a.firm_id=$1 and a.client_id=$2 and a.operation_id=any($3::text[]) order by a.id`,
    [a.firmId,a.clientId,operations.map((op) => String(op.id))])).rows;
  const uom = (await a.client.query('select * from inventory_units_of_measure where firm_id=$1 and client_id=$2 and id=$3', [a.firmId, a.clientId, item.base_uom_id])).rows[0];
  if (!uom) fail('unsupported_inventory_scope');
  const source = { item: { id: item.id, sku: item.sku, name: item.name, baseUomId: item.base_uom_id, status: item.status, payload: item.payload },
    location: { id: location.id, code: location.code, name: location.name }, uom,
    quantity: Number(level?.on_hand || 0), lastOperationId: level?.last_operation_id || null,
    operations: operations.map(({ id, operation_type, quantity, occurred_at, reverses_operation_id, unit_cost_amount, unit_cost_currency, provisional_cost, payload, reference_type, reference_id }) => ({ id, operation_type, quantity, occurred_at, reverses_operation_id, unit_cost_amount, unit_cost_currency, provisional_cost, payload, reference_type, reference_id })),
    configuration: snapshot, policy, jurisdiction: entity?.jurisdiction, accountMappings, accountingLinks };
  return { version: 1, inputDigest: physicalHash(canonical(source)), expectedQuantity: source.quantity, baseUomId: item.base_uom_id,
    cutoff: asOf, effectiveTime: asOf, period: null, streamHead: source.lastOperationId,
    operationIds: operations.map((op) => String(op.id)), identity: source.item, accountingLinks,
    accountingCoverage: accountingLinks.length ? 'linked_source_allocations' : 'no_linked_source_journal_allocations',
    valuation: valuation.applied && operations.length && valuation.receipt.currency ? { status: 'priced', inputHash: valuation.receipt.inputHash, currency: valuation.receipt.currency,
      unitCost: valuation.receipt.movingAverage, carryingValue: valuation.receipt.inventoryValue } : { status: 'insufficient_evidence', reason: valuation.reason || 'no_evidenced_cost_basis' },
    limitations: ['Current observation only; no historical period assertion or movement bridge.', 'Uploaded evidence and human assertion; no independent assurance.'], protocol };
};

const admittedEvidence = async (a, refs) => {
  if (!Array.isArray(refs) || !refs.length || refs.length > 10) fail('evidence_required');
  if (new Set(refs.map((ref) => ref.documentId)).size !== refs.length) fail('duplicate_evidence');
  const out = [];
  for (const ref of refs) {
    if (!ref?.documentId || !/^[a-f0-9]{64}$/.test(ref.checksum || '')) fail('invalid_evidence_reference');
    const document = (await a.client.query('select * from documents where firm_id=$1 and client_id=$2 and id=$3 for share', [a.firmId, a.clientId, ref.documentId])).rows[0];
    if (!document || document.checksum_sha256 !== ref.checksum || !document.storage_object_key || (ref.storageKey && ref.storageKey !== document.storage_object_key)) fail('evidence_scope_or_checksum_refused');
    out.push({ documentId: document.id, checksum: document.checksum_sha256, storageKey: document.storage_object_key,
      mimeType: document.payload?.mime_type || document.payload?.file_storage?.mime_type, size: document.payload?.file_size || document.payload?.file_storage?.size, receivedAt: document.created_at,
      sourceKind: 'browser_photo_upload', sourceGroup: `customer:${a.clientId}`, captureControl: 'uploaded', challengeOutcome: 'not_used',
      continuity: 'not_asserted', identityMatch: 'human_asserted', professionalAssurance: 'absent' });
  }
  return out;
};

const clearBlockers = async (a, caseId, reason) => {
  const rows = (await a.client.query("select id from bookkeeping_case_blockers where case_id=$1 and status='open'", [caseId])).rows;
  for (const row of rows) await resolveBlocker({ client: a.client, blockerId: row.id, reason });
};
const ownedCase = async (a, line, reason, asOf, reviewer = false) => {
  const askScope = { ...a, sessionId: line.count_session_id || a.sessionId, lineId: line.id, caseId: line.case_id };
  await resolvePhysicalAsk({ ...askScope, reason, evidenceRefs: line.physical_observation?.evidenceRefs || [], observationDigest: line.physical_observation?.inputDigest || null });
  await clearBlockers(a, line.case_id, reason);
  const assignment = await physicalTaskAssignment(a, { review: reviewer, asOf });
  const { dueAt } = assignment;
  const ask = await ensurePhysicalAsk({ ...askScope, ...assignment, question: reason, review: reviewer });
  await openBlocker({ ...a, caseId: line.case_id, blockerType: reviewer ? 'accountant_judgment_required' : 'missing_client_answer',
    ownerType: reviewer ? 'accountant' : 'client', objectType: 'inventory_count_line', objectId: String(line.id), reason, dueAt });
  return { type: reviewer ? 'reviewer' : 'customer', actorId: assignment.recipient.principalId, ...assignment, ask, deliveryStatus: ask.deliveryStatus, reason };
};
const finishCase = async (a, line, reason) => {
  await resolvePhysicalAsk({ ...a, sessionId: line.count_session_id || a.sessionId, lineId: line.id, caseId: line.case_id, reason, evidenceRefs: line.physical_observation?.evidenceRefs || [], observationDigest: line.physical_observation?.inputDigest || null });
  await clearBlockers(a, line.case_id, reason);
  await markCaseResolved({ ...a, caseId: line.case_id, reason });
};
const maybeClose = async (a, sessionId) => a.client.query(
  `update inventory_count_sessions set state='closed',closed_at=clock_timestamp(),scope=jsonb_set(scope,'{physicalScopeStatus}', '"completed"'::jsonb) where firm_id=$1 and client_id=$2 and id=$3
   and not exists(select 1 from inventory_count_lines where count_session_id=$3 and physical_status <> all($4::text[]))`,
  [a.firmId, a.clientId, sessionId, PHYSICAL_TERMINAL_STATES]);

export const listPhysicalReconciliation = async (a) => {
  try {
    await context(a);
    const sessions = (await a.client.query('select * from inventory_count_sessions where firm_id=$1 and client_id=$2 and physical_reconciliation order by id desc limit 20', [a.firmId, a.clientId])).rows;
    const items = (await a.client.query("select id,sku,name,base_uom_id from inventory_items where firm_id=$1 and client_id=$2 and status='active' order by sku limit 100", [a.firmId, a.clientId])).rows;
    const locations = (await a.client.query('select id,code,name from inventory_locations where firm_id=$1 and client_id=$2 order by code limit 100', [a.firmId, a.clientId])).rows;
    const evidence = (await a.client.query('select id,filename,checksum_sha256 from documents where firm_id=$1 and client_id=$2 and checksum_sha256 is not null and storage_object_key is not null order by created_at desc limit 100', [a.firmId, a.clientId])).rows;
    return { applied: true, sessions, items, locations, evidence };
  } catch (error) { if (error.physicalRefusal) return error.physicalRefusal; throw error; }
};
export const getPhysicalReconciliation = async (a) => {
  try {
    await context(a);
    const session = await sessionRow(a);
    const rows = (await a.client.query('select l.*,i.sku,i.name from inventory_count_lines l join inventory_items i on i.id=l.item_id where l.firm_id=$1 and l.client_id=$2 and l.count_session_id=$3 order by l.id', [a.firmId, a.clientId, a.sessionId])).rows;
    const asks = (await a.client.query(`select * from client_evidence_requests where firm_id=$1 and client_id=$2 and evidence_type='physical_inventory' and request_payload->>'physical_session_id'=$3 and status=any($4::text[]) order by created_at desc`, [a.firmId,a.clientId,String(a.sessionId),['draft','open','replied']])).rows;
    const lines = [];
    for (const line of rows) {
      const ask = asks.find((r) => r.request_payload?.physical_count_line_id === String(line.id));
      if (ask) line.payload = { ...line.payload, owner: { ...line.payload.owner, actorId: ask.addressee_principal_id, dueAt: ask.due_at, ask: { id: ask.id, status: ask.status, deliveryStatus: physicalAskAcknowledged(ask) ? 'acknowledged' : 'not_delivered', question: ask.question, dueAt: ask.due_at, recipient: { principalType: ask.addressee_principal_type, principalId: ask.addressee_principal_id } } } };
      if (line.physical_observation || a.review === true) line.movements = (await a.client.query('select id,operation_type,quantity,uom_id,occurred_at,reference_type,reference_id from inventory_operations where firm_id=$1 and client_id=$2 and item_id=$3 and location_id=$4 and not(id::text=any($5::text[])) order by id limit 100', [a.firmId,a.clientId,line.item_id,line.location_id,line.physical_basis.operationIds])).rows;
      if (!line.physical_observation && a.review !== true) lines.push({ ...line, expected_quantity: null, physical_basis: { baseUomId: line.uom_id, cutoff: line.physical_basis?.cutoff, protocol }, payload: { blindCount: true, owner: line.payload.owner } });
      else lines.push(line);
    }
    return { applied: true, session, lines };
  } catch (error) { if (error.physicalRefusal) return error.physicalRefusal; throw error; }
};

export const openPhysicalReconciliation = (a) => mutate(a, 'open', async ({ snapshot, key, asOf }) => {
  if (a.asOf || a.period || a.cutoff) fail('historical_cutoff_unsupported');
  if (!a.locationId || !Array.isArray(a.itemIds) || a.itemIds.length < 1 || a.itemIds.length > 20 || new Set(a.itemIds).size !== a.itemIds.length) fail('invalid_count_scope');
  await physicalTaskAssignment(a, { asOf });
  const overlap = (await a.client.query(`select l.id from inventory_count_lines l join inventory_count_sessions s on s.id=l.count_session_id
    where s.client_id=$1 and s.state='open' and l.location_id=$2 and l.item_id=any($3::text[]) limit 1`, [a.clientId, a.locationId, a.itemIds])).rows[0];
  if (overlap) fail('overlapping_count');
  const pinned = [];
  for (const itemId of [...a.itemIds].sort()) pinned.push({ itemId, basis: await basis(a, itemId, a.locationId, snapshot, asOf) });
  const scope = { version: 1, locationId: a.locationId, itemIds: [...a.itemIds].sort(), protocol, period: null,
    physicalScopeStatus: 'in_progress', serviceSignoff: 'not_requested', professionalAssurance: 'absent', selectedAt: asOf,
    limitations: ['Only selected SKUs and named location are in scope.', 'No period close or service sign-off is implied.'] };
  const session = (await a.client.query(`insert into inventory_count_sessions(firm_id,client_id,scope,state,idempotency_key,actor_id,physical_reconciliation)
    values($1,$2,$3::jsonb,'open',$4,$5,true) returning id`, [a.firmId, a.clientId, json(scope), key, a.actorId])).rows[0];
  for (const pin of pinned) {
    const line = (await a.client.query(`insert into inventory_count_lines(firm_id,client_id,count_session_id,item_id,location_id,uom_id,counted_quantity,expected_quantity,physical_status,physical_basis,payload)
      values($1,$2,$3,$4,$5,$6,null,$7,'awaiting_observation',$8::jsonb,$9::jsonb) returning *`,
    [a.firmId, a.clientId, session.id, pin.itemId, a.locationId, pin.basis.baseUomId, pin.basis.expectedQuantity, json(pin.basis), json({ versions: [], laterOutcome: { status: 'unknown' }, owner: owner(a) })])).rows[0];
    const c = await openOrFindCase({ ...a, caseType: 'reconciliation', primaryObject: { type: 'inventory_count_line', id: String(line.id) }, title: `Physical check: ${pin.basis.identity.sku}`, summary: 'Blind human count and supporting evidence requested; delivery status is recorded separately.' });
    line.case_id = c.id;
    await linkObject({ ...a, caseId: c.id, objectType: 'inventory_count_session', objectId: String(session.id), role: 'primary' });
    const assignment = await ownedCase(a, line, 'Supply a blind count and photo, or explain why the item cannot be counted safely.', asOf);
    await a.client.query('update inventory_count_lines set case_id=$2,payload=payload || $3::jsonb where id=$1', [line.id, c.id, json({ owner: assignment })]);
  }
  return { sessionId: session.id, selectedCount: a.itemIds.length, consequence: { stockChanged: false, accountingChanged: false } };
});

export const observePhysicalReconciliation = (a) => mutate(a, 'observe', async ({ snapshot, asOf }) => {
  const { session, line } = await lineRow(a);
  if (session.state !== 'open' || PHYSICAL_TERMINAL_STATES.includes(line.physical_status)) fail('line_already_resolved');
  const current = await basis(a, line.item_id, line.location_id, snapshot, asOf);
  if (current.inputDigest !== line.physical_basis.inputDigest) fail('stale_expectation');
  const evidenceRefs = await admittedEvidence(a, a.evidenceRefs);
  if ((line.payload.versions || []).length >= 100) fail('review_attempt_limit', { nextAction: 'Open a new scoped check retaining this case history.' });
  const proposed = proposePhysicalObservation({ ...a, evidenceRefs, expectedQuantity: line.expected_quantity, cutoff: line.physical_basis.cutoff, asOf });
  if (!proposed.applied) fail(proposed.reason, proposed.detail);
  const observation = { ...proposed.observation, version: (line.payload.versions || []).length + 1,
    expectedDigest: line.physical_basis.inputDigest, receivedAt: asOf, protocol, modelStatus: a.modelReceipt ? 'reported' : 'not_used',
    sourceKind: 'browser_photo_upload', assurance: { captureControl: 'uploaded', continuity: 'not_asserted', independent: false, professionalAssurance: 'absent' } };
  observation.inputDigest = physicalHash(observation);
  const versions = [...(line.payload.versions || []), { kind: 'observation', observation }];
  let anomalyId = line.anomaly_id;
  let assignment = null;
  if (proposed.status === 'matched') {
    await finishCase(a, line, 'Confirmed blind count matches the pinned current state; no inventory change.');
    if (anomalyId) await a.client.query("update inventory_anomalies set status='resolved' where id=$1 and client_id=$2", [anomalyId, a.clientId]);
  } else {
    if (!anomalyId) anomalyId = (await a.client.query(`insert into inventory_anomalies(firm_id,client_id,item_id,location_id,anomaly_type,payload)
      values($1,$2,$3,$4,'count_variance',$5::jsonb) returning id`, [a.firmId, a.clientId, line.item_id, line.location_id, json({ sessionId: a.sessionId, lineId: line.id, caseId: line.case_id, observation })])).rows[0].id;
    assignment = await ownedCase(a, line, proposed.status === 'uncertain' ? 'Confirm quantity or request a recount; uncertainty remains unresolved.' : 'Review observed difference and factual cause before accepting a correction.', asOf, proposed.status === 'variance');
  }
  for (const ref of evidenceRefs) await linkObject({ ...a, caseId: line.case_id, objectType: 'document', objectId: ref.documentId, objectVersion: ref.checksum, role: 'evidence' });
  await appendCaseEvent({ ...a, caseId: line.case_id, actorType: ['firm','firm_member','firm_collaborator'].includes(a.actorType) ? 'firm' : 'client', eventType: 'physical.observation_recorded', payload: { observation, status: proposed.status } });
  await a.client.query(`update inventory_count_lines set counted_quantity=$2,physical_status=$3,physical_observation=$4::jsonb,anomaly_id=$5,payload=payload || $6::jsonb where id=$1`,
    [line.id, observation.quantity, proposed.status, json(observation), anomalyId, json({ versions, owner: assignment })]);
  await maybeClose(a, a.sessionId);
  return { sessionId: a.sessionId, lineId: line.id, status: proposed.status, variance: observation.variance, observationDigest: observation.inputDigest, consequence: { stockChanged: false, accountingChanged: false } };
});

const accounting = async (a, line, operationId, snapshot, asOf) => {
  const operations = await stream(a, line.item_id, line.location_id);
  const valued = valueInventoryOperations({ operations });
  if (!valued.applied) fail('missing_valuation_basis', { reason: valued.reason });
  const valuation = valued.receipt;
  if (!flag(snapshot, 'INVENTORY_ACCOUNTING')) return { status: 'disabled', reason: 'INVENTORY_ACCOUNTING is off', valuationRunId: valuation.valuationRunId, owner: owner(a) };
  const roleRows = (await a.client.query("select * from ledger_accounts where firm_id=$1 and client_id=$2 and status='active' and canonical_role=any($3::text[])", [a.firmId, a.clientId, ['asset.inventory', 'pnl.inventory_count_variance']])).rows;
  if (new Set(roleRows.map((r) => r.canonical_role)).size !== roleRows.length) fail('ambiguous_inventory_account');
  const roleAccounts = Object.fromEntries(roleRows.map((row) => [row.canonical_role, { ...row, type: row.account_type }]));
  const effect = valuation.operationEffects.find((e) => String(e.operationId) === String(operationId));
  const monetaryEffect = effect && effect.legs.length === 0 && effect.amountToInventory === 0 ? { ...effect, posting: 'no_journal_required' } : effect;
  const draft = buildInventoryJournalDraft({ effect: monetaryEffect, roleAccounts, valuationRunId: valuation.valuationRunId, context: { count_cause: a.countCause } });
  if (!draft.applied) fail('accounting_requires_review', { reason: draft.reason });
  await a.client.query('select id from inventory_posting_authority_grants where firm_id=$1 and client_id=$2 for share', [a.firmId,a.clientId]);
  const jurisdictionRow = (await a.client.query('select jurisdiction,profile from clients where firm_id=$1 and id=$2', [a.firmId,a.clientId])).rows[0];
  const jurisdiction = normalizeJurisdictionKey(jurisdictionRow?.jurisdiction) || 'unknown';
  if (jurisdictionRow?.profile?.jurisdiction && normalizeJurisdictionKey(jurisdictionRow.profile.jurisdiction) !== jurisdiction) fail('jurisdiction_conflict');
  const variancePolicy = jurisdictionRow?.profile?.physical_reconciliation?.variancePolicy;
  if (!draft.no_journal_required && (!variancePolicy || variancePolicy.currency !== valuation.currency
    || !(Number(variancePolicy.maxAbsoluteValue) > 0) || !(Number(variancePolicy.maxPercentage) > 0))) fail('variance_policy_required');
  const usedRoles = (await a.client.query(`select distinct a.canonical_role from ledger_accounts a join ledger_lines l on l.account_id=a.id
    join ledger_journals j on j.id=l.journal_id where a.firm_id=$1 and a.client_id=$2 and a.canonical_role=any($3::text[]) and j.status='posted'`, [a.firmId,a.clientId,roleRows.map((r) => r.canonical_role)])).rows;
  const firstUseAccount = roleRows.some((r) => !usedRoles.some((used) => used.canonical_role === r.canonical_role));
  const unusualCountVariance = !draft.no_journal_required && (!(Number(line.expected_quantity)>0)
    || draft.journal.amount > Number(variancePolicy.maxAbsoluteValue)
    || Math.abs(line.physical_observation.variance) / Number(line.expected_quantity) * 100 > Number(variancePolicy.maxPercentage));
  const result = await postInventoryJournalWithinTransaction(a.client, { ...a, draft, valuationIdentity: valuation, accountingReady: true,
    authorization: { enforce: true, asOf, periodStart: '0001-01-01', periodEnd: '9999-12-31', context: { confidence: line.physical_observation.confidence, evidencePresent: true, jurisdiction, firstUseAccount, unusualCountVariance } },
    provenance: { count_session_id: a.sessionId, count_line_id: line.id, observation_digest: line.physical_observation.inputDigest,
      extraction_receipt_ids: [], human_confirmation_ids: [`physical:${line.id}:${line.physical_observation.inputDigest}`], actor_id: a.actorId },
    allocations: [{ operation_id: String(operationId), allocated_amount: draft.journal?.amount || 0, allocated_currency: valuation.currency, allocated_quantity: Math.abs(line.physical_observation.variance), valuation_run_id: valuation.valuationRunId }] });
  if (!['posted', 'replayed', 'no_journal_required'].includes(result.status)) fail('accounting_refused', { posting: result });
  // The financial gather is whole-client. Fold EACH scope independently before aggregating;
  // never compare a selected SKU value against the whole inventory GL and call it reconciled.
  const all = (await a.client.query('select * from inventory_operations where firm_id=$1 and client_id=$2 order by occurred_at,id', [a.firmId, a.clientId])).rows;
  const groups = new Map();
  for (const op of all) { const key = `${op.item_id}:${op.location_id}`; groups.set(key, [...(groups.get(key) || []), op]); }
  const folds = [...groups.values()].map((ops) => valueInventoryOperations({ operations: ops }));
  let reconciliation = { status: 'insufficient_evidence', reason: 'Unpriced or mixed-currency inventory scope; whole-book reconciliation unavailable.' };
  if (folds.every((f) => f.applied && f.receipt.currency === valuation.currency)) {
    const subledger = { currency: valuation.currency, inventoryValue: folds.reduce((sum, f) => sum + f.receipt.inventoryValue, 0), operationEffects: folds.flatMap((f) => f.receipt.operationEffects) };
    const check = await runInventoryReconciliationFromDb({ ...a, subledger });
    reconciliation = { status: 'checked_current_only', verdict: check.verdict, period: null, serviceSignoff: 'not_issued' };
  }
  return { ...result, valuationRunId: valuation.valuationRunId, valuationInputHash: valuation.inputHash, reconciliation };
};

export const resolvePhysicalReconciliation = (a) => mutate(a, 'resolve', async ({ snapshot, key, asOf }) => {
  const { session, line } = await lineRow(a);
  if (session.state !== 'open') fail('session_closed');
  const decision = validatePhysicalResolution({ ...a, line });
  if (!decision.applied) fail(decision.reason, decision.detail);
  if (line.physical_observation && a.expectedObservationDigest !== line.physical_observation.inputDigest) fail('stale_observation');
  let status = a.action, operationId = null, consequence = { status: 'not_applicable' }, assignment = null;
  const previous = { basis: line.physical_basis, observation: line.physical_observation, status: line.physical_status };
  const resolution = { version: 1, action: a.action, reason: a.reason, actorId: a.actorId, actorType: a.actorType || 'client', resolvedAt: asOf,
    expectedDigest: line.physical_basis.inputDigest, observationDigest: line.physical_observation?.inputDigest || null, countCause: a.countCause || null };
  if (a.action === 'recount_required') {
    const refreshed = await basis(a, line.item_id, line.location_id, snapshot, asOf);
    await a.client.query('update inventory_count_lines set physical_basis=$2::jsonb,expected_quantity=$3,counted_quantity=null,physical_observation=null where id=$1', [line.id, json(refreshed), refreshed.expectedQuantity]);
    assignment = await ownedCase(a, line, a.reason, asOf);
  } else if (a.action === 'uncertain') {
    assignment = await ownedCase(a, line, a.reason, asOf);
  } else {
    if (a.action !== 'dismissed') {
      const current = await basis(a, line.item_id, line.location_id, snapshot, asOf);
      if (current.inputDigest !== line.physical_basis.inputDigest) fail('stale_expectation');
      await admittedEvidence(a, line.physical_observation.evidenceRefs);
    }
    if (['confirmed_shortage', 'confirmed_found_stock'].includes(a.action)) {
      if (a.action === 'confirmed_found_stock') {
        const source = (await a.client.query(`select * from inventory_operations where firm_id=$1 and client_id=$2 and item_id=$3 and location_id=$4 and id::text=$5 and operation_type='count_correction' and quantity<0`, [a.firmId,a.clientId,line.item_id,line.location_id,String(a.reversesCountOperationId || '')])).rows[0];
        if (!source) fail('found_stock_shrinkage_source_required');
        const prior = (await a.client.query(`select coalesce(sum(quantity),0) restored from inventory_operations where firm_id=$1 and client_id=$2 and item_id=$3 and location_id=$4 and operation_type='count_correction' and quantity>0 and payload->'physical_resolution'->>'reversesCountOperationId'=$5`, [a.firmId,a.clientId,line.item_id,line.location_id,String(source.id)])).rows[0];
        const reversed = (await a.client.query('select id from inventory_operations where client_id=$1 and reverses_operation_id=$2', [a.clientId,source.id])).rows.length;
        if (reversed || Number(prior.restored) + line.physical_observation.variance > Math.abs(Number(source.quantity))) fail('found_stock_exceeds_prior_shrinkage');
        resolution.reversesCountOperationId = String(source.id);
      }
      if (a.actorId === line.physical_observation.actorId) fail('second_reviewer_required');
      if (!flag(snapshot, PHYSICAL_INVENTORY_APPLY_FLAG_KEY)) fail('apply_flag_disabled');
      if (line.physical_basis.valuation.status !== 'priced') fail('missing_valuation_basis');
      const applied = await applyInventoryCountCorrectionWithinTransaction({ ...a, idempotencyKey: `${key}:correction`, itemId: line.item_id,
        locationId: line.location_id, operationType: 'count_correction', quantity: line.physical_observation.variance, uomId: line.uom_id,
        occurredAt: asOf, authorityBasis: 'explicit_physical_resolution', referenceType: 'count_session', referenceId: String(a.sessionId),
        reference: { countSessionId: a.sessionId, countLineId: line.id, observationDigest: line.physical_observation.inputDigest },
        payload: { physical_resolution: resolution, evidence: line.physical_observation.evidenceRefs }, reason: a.reason });
      if (!applied.applied) fail(applied.reason, applied.detail);
      operationId = applied.receipt.operationId;
      consequence = await accounting(a, line, operationId, snapshot, asOf);
      status = 'applied';
      await linkObject({ ...a, caseId: line.case_id, objectType: 'inventory_operation', objectId: String(operationId), role: 'receipt' });
    }
    if (consequence.status === 'disabled' || (consequence.reconciliation && consequence.reconciliation.verdict?.reconciliation_status !== 'reconciled')) assignment = await ownedCase(a, line, 'Physical correction accepted; accounting reconciliation remains explicitly unresolved. Review the persisted financial consequence.', asOf, true);
    else await finishCase(a, line, a.reason);
    if (line.anomaly_id) await a.client.query("update inventory_anomalies set status='resolved',payload=payload || $3::jsonb where id=$1 and client_id=$2", [line.anomaly_id, a.clientId, json({ resolution, operationId })]);
  }
  const learning = { version: 1, protocol, environment: 'declared_inventory_location', assertion: 'quantity',
    failureClass: a.failureClass || (a.action === 'confirmed_shortage' ? 'quantity_shortage' : a.action === 'confirmed_found_stock' ? 'found_stock' : a.action),
    originalUncertainty: line.physical_observation?.uncertain ?? null, originalObservation: line.physical_observation,
    expectationDigest: line.physical_basis.inputDigest, evidenceRefs: line.physical_observation?.evidenceRefs || [],
    correctedLabel: a.action, factualBasis: a.reason, alternateAction: a.alternateAction || null,
    reviewer: { actorId: a.actorId, actorType: a.actorType || 'client', reviewedAt: asOf, seconds: Number.isFinite(a.reviewSeconds) && a.reviewSeconds >= 0 ? a.reviewSeconds : null },
    reuse: { eligible: false, exclusionReason: 'Tenant-private human assertion; independent later outcome not yet validated.', missingEvidence: 'Independent recount or corroborated business cause.' },
    laterOutcome: { status: 'unknown' }, operationId, accounting: consequence };
  const finalResolution = { ...resolution, operationId, accounting: consequence, learning };
  const versions = [...(line.payload.versions || []), { kind: 'resolution', before: previous, resolution: finalResolution }];
  await appendCaseEvent({ ...a, caseId: line.case_id, actorType: ['firm','firm_member','firm_collaborator'].includes(a.actorType) ? 'firm' : 'client', eventType: 'physical.resolution_recorded', payload: finalResolution });
  await a.client.query('update inventory_count_lines set physical_status=$2,physical_resolution=$3::jsonb,payload=payload || $4::jsonb where id=$1', [line.id, status, json(finalResolution), json({ versions, owner: assignment })]);
  await maybeClose(a, a.sessionId);
  return { sessionId: a.sessionId, lineId: line.id, status, operationId, accounting: consequence, resolution: finalResolution,
    consequence: { stockChanged: operationId !== null, accountingChanged: consequence.status === 'posted', serviceSignoff: 'not_issued' } };
});
