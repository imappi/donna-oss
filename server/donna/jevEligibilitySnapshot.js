// Offline eligibility replay helper. Production callers supply live eligibility
// to prepareEvidencePacketFromEligibility and never invoke this TEMP-table path.
import { CANDIDATE_TX_STATUS_SQL, SUPPRESSION_STATUSES } from './reconciliationLlmCore.js';

// Execute the real candidate query against transaction-local TEMP tables only.
// No persistent relation is read or written, even on a populated test database.
export async function eligibleSnapshot(fixture, client) {
  const scoped = (fixture.matches || []).filter(m => m.firm_id === fixture.firm_id && m.client_id === fixture.client_id);
  await client.query('begin');
  try {
    await client.query('set local search_path = pg_temp, pg_catalog');
    await client.query('create temporary table transactions (id text primary key, reconciliation_status text, payload jsonb, coding_state text) on commit drop');
    await client.query('create temporary table reconciliation_matches (id text, bank_transaction_id text, matched_object_type text, matched_object_id text, status text) on commit drop');
    for (const b of fixture.candidate_bank_lines) await client.query('insert into pg_temp.transactions values ($1,$2,$3,$4)', [b.id, b.reconciliation_status || null, JSON.stringify(b.payload || {}), b.coding_state || null]);
    for (const m of scoped) await client.query('insert into pg_temp.reconciliation_matches values ($1,$2,$3,$4,$5)', [m.id, m.bank_transaction_id, m.matched_object_type, m.matched_object_id, m.status]);
    const result = await client.query(`select id from pg_temp.transactions where ${CANDIDATE_TX_STATUS_SQL} order by id`);
    const suppressed = new Set(scoped.filter(m => m.matched_object_id === fixture.document.id && m.matched_object_type === fixture.document.document_type && SUPPRESSION_STATUSES.has(m.status)).map(m => m.bank_transaction_id));
    return result.rows.map(r => r.id).filter(id => !suppressed.has(id));
  } finally { await client.query('rollback'); }
}

