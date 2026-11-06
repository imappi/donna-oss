// F-32 (2026-09-29) — an ask nobody can receive is not terminal 2. A never-sent
// draft on a send-contained client with no owner/seat assignment projects
// hanging/owner_ask_undeliverable; the same ask with a sent stamp, an active
// owner/seat assignment, or on an ordinary (uncontained) client keeps the old
// on_owner reading. The SQL twin of the containment reader is pinned equal to
// readInternalPilotSendContainmentWithClient on every fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { computeConvergenceForTarget } from './reconcileConvergenceState.js';
import { readInternalPilotSendContainmentWithClient, HOSTED_PILOT_VERSION, SG_HOSTED_REVIEW_VERSION,
  PILOT_SEND_RELEASE_ACTION, PILOT_SEND_RELEASE_VERSION } from './internalPilotAccess.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIRM = 'firm-f32';

test('F-32 real PG: a draft ask nobody can receive hangs owner_ask_undeliverable; sent / seated / uncontained asks stay on_owner', { skip: !PG_URL }, async () => {
  const dbName = `donna_f32_${Date.now().toString(36)}_${process.pid}`;
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  await admin.query(`create database "${dbName}"`);
  const url = new URL(PG_URL); url.pathname = `/${dbName}`;
  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  try {
    const supabaseOnly = new Set(['010_evidence_object_storage.sql', '032_lock_down_public_rls.sql', '060_procountor_api_key.sql']);
    for (const file of (await readdir(path.join(ROOT, 'db', 'migrations'))).filter((f) => f.endsWith('.sql') && !supabaseOnly.has(f)).sort()) {
      await db.query(await readFile(path.join(ROOT, 'db', 'migrations', file), 'utf8'));
    }
    await db.query(`insert into firms (id, name, slug) values ($1, 'F-32 Firm', 'f32')`, [FIRM]);
    let n = 0;
    const seedClient = async (id, { enroll = null } = {}) => {
      await db.query(`insert into clients (id, firm_id, company_name) values ($1, $2, $1)`, [id, FIRM]);
      if (enroll) {
        await db.query(`insert into client_capability_config (id, firm_id, client_id, flag_key, stage, source, reason, set_by_actor_type, set_by_actor_id)
          values ($4, $1, $2, 'INTERNAL_PILOT_ACCESS', 'canary', 'manual', $3, 'firm_member', 'op')`, [FIRM, id, enroll, `cfg-${id}`]);
      }
      const tx = `tx-${id}`;
      await db.query(`insert into transactions (id, firm_id, client_id, transaction_date, description, money_out, currency, reconciliation_status, payload)
        values ($1, $2, $3, '2026-08-20', 'line', 120, 'SGD', 'pending', '{}'::jsonb)`, [tx, FIRM, id]);
      return tx;
    };
    const ask = (clientId, txId, { status = 'draft', sendCount = 0 } = {}) => db.query(
      `insert into client_evidence_requests (id, firm_id, client_id, transaction_id, status, evidence_type, question, created_by, audience, send_count)
       values ($1, $2, $3, $4, $5, 'business_purpose', 'Q?', 'ask_batch', 'client', $6)`, [`ask-${++n}`, FIRM, clientId, txId, status, sendCount]);
    const verdict = async (txId) => {
      const c = await computeConvergenceForTarget(db, { firmId: FIRM, transactionId: txId });
      return `${c.derived.state}/${c.derived.reason}`;
    };
    const contained = async (clientId) => (await readInternalPilotSendContainmentWithClient(db, { firmId: FIRM, clientId })).contained;

    // 1. SG-review enrolled, draft, nobody to receive it → hanging (reproduces
    //    the reviewer's on_owner / open_owner_ask on the unfixed law).
    const sg = await seedClient('sg', { enroll: SG_HOSTED_REVIEW_VERSION });
    await ask('sg', sg);
    assert.equal(await contained('sg'), true);
    assert.equal(await verdict(sg), 'hanging/owner_ask_undeliverable');

    // 2. Neighbour: an ordinary client's draft is with the owner, unchanged.
    const plain = await seedClient('plain');
    await ask('plain', plain);
    assert.equal(await contained('plain'), false);
    assert.equal(await verdict(plain), 'on_owner/open_owner_ask');

    // 3. Neighbour: an ask that WAS sent (status open) on the contained client.
    const sent = await seedClient('sent', { enroll: SG_HOSTED_REVIEW_VERSION });
    await ask('sent', sent, { status: 'open' });
    assert.equal(await verdict(sent), 'on_owner/open_owner_ask');

    // 4. An active owner assignment can receive the draft → on_owner; an
    //    ended assignment or a staff firm_member does not.
    const seated = await seedClient('seated', { enroll: SG_HOSTED_REVIEW_VERSION });
    await ask('seated', seated);
    await db.query(`insert into firm_collaborators (id, firm_id, email, name, role, status) values ('own-1', $1, 'o@x.invalid', 'Owner', 'owner', 'active')`, [FIRM]);
    await db.query(`insert into client_assignments (id, firm_id, client_id, principal_type, principal_id, role) values ('asg-1', $1, 'seated', 'firm_collaborator', 'own-1', 'owner')`, [FIRM]);
    assert.equal(await verdict(seated), 'on_owner/open_owner_ask');
    await db.query(`update client_assignments set ends_at = now() - interval '1 minute' where id = 'asg-1'`);
    assert.equal(await verdict(seated), 'hanging/owner_ask_undeliverable');

    // 5. A receipted release lifts containment; the SQL twin agrees with the reader.
    const fi = await seedClient('fi', { enroll: HOSTED_PILOT_VERSION });
    await ask('fi', fi);
    assert.equal(await contained('fi'), true);
    assert.equal(await verdict(fi), 'hanging/owner_ask_undeliverable');
    await db.query(`insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
      values ($1, 'fi', 'firm_member', 'op', $2, 'client', 'fi', $3::jsonb)`,
    [FIRM, PILOT_SEND_RELEASE_ACTION, JSON.stringify({ version: PILOT_SEND_RELEASE_VERSION, firm_id: FIRM, client_id: 'fi', actor_id: 'op' })]);
    assert.equal(await contained('fi'), false);
    assert.equal(await verdict(fi), 'on_owner/open_owner_ask');
  } finally {
    await db.end().catch(() => {});
    await admin.query(`drop database if exists "${dbName}" with (force)`).catch(() => {});
    await admin.end().catch(() => {});
  }
});
