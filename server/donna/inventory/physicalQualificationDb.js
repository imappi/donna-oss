// Operator export only. One consistent, read-only snapshot; no capture credential,
// new store, accounting writer, feature enrollment or inference call.
import { assertFirmAccess } from '../db/authority.js';
import { physicalHash } from './physicalReconciliation.js';

export async function exportPhysicalQualification({ client, firmId, clientId, actorId }) {
  if (!client || !firmId || !clientId || !actorId || actorId === 'system') throw new Error('qualification_scope_required');
  // The existing authority owner uses SELECT FOR SHARE, which PostgreSQL
  // refuses in READ ONLY. Authorize first, then recheck that member within the
  // export snapshot without a lock; exporting grants no mutation authority.
  await assertFirmAccess({ firmId, clientIds: [clientId], requireMember: true, dbClient: client,
    resolvedPrincipal: { principalType: 'firm_member', principalId: actorId } });
  await client.query('begin isolation level repeatable read read only');
  try {
    if (!(await client.query("select id from firm_members where firm_id=$1 and id=$2 and status='active'", [firmId, actorId])).rows.length) throw new Error('qualification_scope_refused');
    const entity = (await client.query('select id,firm_id from clients where firm_id=$1 and id=$2', [firmId, clientId])).rows[0];
    if (!entity) throw new Error('qualification_scope_refused');
    const asOf = (await client.query('select transaction_timestamp() as time')).rows[0].time.toISOString();
    // Do not reuse the UI's last-20 sessions/active asks projection: qualification
    // needs every admitted attempt, including closed, dismissed and incomplete work.
    const sessions = (await client.query('select * from inventory_count_sessions where firm_id=$1 and client_id=$2 and physical_reconciliation order by id', [firmId, clientId])).rows;
    const ids = sessions.map(s => String(s.id));
    const lines = (await client.query('select * from inventory_count_lines where firm_id=$1 and client_id=$2 and count_session_id::text=any($3::text[]) order by id', [firmId, clientId, ids])).rows;
    const asks = (await client.query("select * from client_evidence_requests where firm_id=$1 and client_id=$2 and evidence_type='physical_inventory' and request_payload->>'physical_session_id'=any($3::text[]) order by id", [firmId, clientId, ids])).rows;
    const audit = (await client.query("select id,action,resource_id,actor_id,created_at,metadata from audit_events where firm_id=$1 and client_id=$2 and action like 'inventory.physical.%' and resource_id=any($3::text[]) order by id", [firmId, clientId, ids])).rows;
    const caseIds = lines.map(l => l.case_id).filter(Boolean);
    const cases = (await client.query('select * from bookkeeping_cases where firm_id=$1 and client_id=$2 and id=any($3::text[]) order by id', [firmId, clientId, caseIds])).rows;
    const caseEvents = (await client.query('select e.* from bookkeeping_case_events e join bookkeeping_cases c on c.id=e.case_id where c.firm_id=$1 and c.client_id=$2 and e.firm_id=$1 and e.client_id=$2 and c.id=any($3::text[]) order by e.id', [firmId, clientId, caseIds])).rows;
    const documents = (await client.query('select id,checksum_sha256,created_at,storage_object_key,payload from documents where firm_id=$1 and client_id=$2 and id=any($3::text[]) order by id',
      [firmId, clientId, [...new Set(lines.flatMap(l => (l.payload?.versions || []).flatMap(v => v.observation?.evidenceRefs || [])).map(r => r.documentId))]])).rows;
    const operations = (await client.query('select * from inventory_operations where firm_id=$1 and client_id=$2 and item_id=any($3::text[]) order by id', [firmId, clientId, [...new Set(lines.map(l => l.item_id))]])).rows;
    await client.query('commit');
    const data = JSON.parse(JSON.stringify({ version: 1, scope: { firmId, clientId }, asOf, sessions, lines, asks, audit, cases, caseEvents, documents, operations }));
    return { ...data, sourceDigest: physicalHash(data) };
  } catch (error) { await client.query('rollback'); throw error; }
}
