// G0.3 (build-spec PR-7) — firm chat LEAKAGE tests, proven on real
// PostgreSQL against the live access substrate (assertFirmAccess +
// client_assignments), not asserted from mocks.
//
// What this file proves, per the plan §5 G0 amended exit:
//   - a client-scoped collaborator cannot reach the firm surface AT ALL
//     (requireMember excludes them at the door — retrieval AND thread);
//   - an apply targeting an unassigned venture refuses for a scoped
//     principal (the route's per-venture re-check, live defense-in-depth);
//   - assignments are time-bounded: an expired assignment grants nothing;
//   - the venture-universe read scopes by allowedClientIds — the latent
//     hazard named in the ground-truth audit (an UNFILTERED clients query,
//     safe only while requireMember holds) is CLOSED, and an empty
//     assignment set yields an empty universe (fail-closed), never "no
//     filter";
//   - the rate-limit count is user-rows-only, thread-scoped, and rolling.
//
// OPT-IN like its siblings (firmFactsPgLifecycle / memoriesPgLifecycle):
// set DONNA_PG_TEST_URL to a scratch PostgreSQL whose role may CREATE
// DATABASE. Without it the test SKIPS loudly. Everything runs in a
// throwaway DATABASE with the base, firm-chat, and current human-seat schema
// executed VERBATIM; the
// firmDb module itself is pointed at the scratch DB via DATABASE_URL
// (read lazily at first query), so the assertions exercise the REAL
// queryFirmDb paths the routes call.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import {
  assertFirmAccess,
  countRecentFirmChatUserMessagesInDb,
  listFirmChatVentureUniverseInDb,
  __endFirmDbPoolForTests
} from './firmDb.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const FIRM = 'firm-leak';
const MEMBER_AUTH = { email: 'member@leak.test' };
const COLLAB_AUTH = { email: 'collab@leak.test' };

const expect403 = async (promise, messagePattern, label) => {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.statusCode, 403, `${label}: statusCode`);
    if (messagePattern) assert.match(error?.message || '', messagePattern, `${label}: message`);
    return true;
  }, label);
};

test(
  'firm chat leakage on real PG: collaborator exclusion, unassigned-venture refusal, scoped universe, rate-limit count',
  { skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set — real-PG firm chat leakage not exercised in this run' },
  async () => {
    const dbName = `donna_fcl_${Date.now().toString(36)}_${process.pid}`;
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`create database "${dbName}"`);
    const scratchUrl = new URL(PG_URL);
    scratchUrl.pathname = `/${dbName}`;
    const seed = new pg.Client({ connectionString: scratchUrl.toString() });
    await seed.connect();
    try {
      for (const file of [
        '001_firm_core.sql',
        '042_client_capability_config.sql',
        '114_firm_chat_messages.sql',
        '117_specialist_role_assignments.sql',
        '122_human_seats.sql'
      ]) {
        await seed.query(await readFile(path.join(ROOT, 'db', 'migrations', file), 'utf8'));
      }

      await seed.query(
        `insert into firms (id, name, slug) values ($1, 'Leakage Test Firm', 'leakage-test-firm')`,
        [FIRM]
      );
      // company_name order pins the deterministic window: Alpha < Bravo < Cedar.
      for (const [id, name] of [
        ['venture-a', 'Alpha Apiary LLC'],
        ['venture-b', 'Bravo Books Ltd'],
        ['venture-c', 'Cedar Cafe Oy']
      ]) {
        await seed.query(
          `insert into clients (id, firm_id, company_name) values ($1, $2, $3)`,
          [id, FIRM, name]
        );
      }
      await seed.query(
        `insert into firm_members (id, firm_id, email, name) values ('member-1', $1, $2, 'Member One')`,
        [FIRM, MEMBER_AUTH.email]
      );
      await seed.query(
        `insert into firm_collaborators (id, firm_id, email, name) values ('collab-1', $1, $2, 'Collab One')`,
        [FIRM, COLLAB_AUTH.email]
      );
      // Live assignment to venture-a only; the venture-b assignment EXPIRED
      // an hour ago — time-bounding must exclude it everywhere.
      await seed.query(
        `insert into client_assignments (id, firm_id, client_id, principal_type, principal_id)
         values ('asgn-a', $1, 'venture-a', 'firm_collaborator', 'collab-1')`,
        [FIRM]
      );
      await seed.query(
        `insert into client_assignments (id, firm_id, client_id, principal_type, principal_id, ends_at)
         values ('asgn-b', $1, 'venture-b', 'firm_collaborator', 'collab-1', now() - interval '1 hour')`,
        [FIRM]
      );

      // Point the REAL firmDb module at the scratch DB (env is read lazily
      // at first query; nothing has queried yet in this process).
      process.env.DATABASE_URL = scratchUrl.toString();
      process.env.DATABASE_POOL_MAX = '1';

      // ── 1. A firm member passes the firm-route posture; scope verdict is
      //       null (unrestricted — the universe read applies NO filter). ──
      const memberAccess = await assertFirmAccess({
        firmId: FIRM, auth: MEMBER_AUTH, clientIds: [], requireMember: true
      });
      assert.equal(memberAccess.principal.principalType, 'firm_member');
      assert.equal(memberAccess.allowedClientIds, null);

      // ── 2. The collaborator is refused at the firm-route door — the
      //       requireMember exclusion that makes retrieval safe today. ──
      await expect403(
        assertFirmAccess({ firmId: FIRM, auth: COLLAB_AUTH, clientIds: [], requireMember: true }),
        /member access is required/i,
        'collaborator on the firm surface'
      );

      // ── 3. Apply defense-in-depth: an unassigned venture refuses even
      //       WITHOUT requireMember (the route's per-venture re-check), and
      //       an expired assignment grants nothing. ──
      await expect403(
        assertFirmAccess({ firmId: FIRM, auth: COLLAB_AUTH, clientIds: ['venture-b'] }),
        /venture-b/,
        'apply targeting an unassigned venture'
      );
      const collabAccess = await assertFirmAccess({
        firmId: FIRM, auth: COLLAB_AUTH, clientIds: ['venture-a']
      });
      assert.deepEqual(collabAccess.allowedClientIds, ['venture-a'],
        'live assignments only — the expired venture-b grant is excluded');

      // ── 4. The venture universe scopes by the SAME verdict. ──
      const unfiltered = await listFirmChatVentureUniverseInDb({
        firmId: FIRM, offset: 0, limit: 8, allowedClientIds: null
      });
      assert.equal(unfiltered.total, 3);
      assert.deepEqual(unfiltered.rows.map((row) => row.id), ['venture-a', 'venture-b', 'venture-c']);

      const scoped = await listFirmChatVentureUniverseInDb({
        firmId: FIRM, offset: 0, limit: 8, allowedClientIds: collabAccess.allowedClientIds
      });
      assert.equal(scoped.total, 1, 'the total is computed over the ALLOWED universe');
      assert.deepEqual(scoped.rows.map((row) => row.id), ['venture-a'],
        'a scoped principal can never retrieve an unassigned venture');

      const none = await listFirmChatVentureUniverseInDb({
        firmId: FIRM, offset: 0, limit: 8, allowedClientIds: []
      });
      assert.equal(none.total, 0, 'zero assignments → zero ventures (fail-closed, never "no filter")');
      assert.deepEqual(none.rows, []);

      // Window semantics stay deterministic under the filter.
      const windowed = await listFirmChatVentureUniverseInDb({
        firmId: FIRM, offset: 1, limit: 1, allowedClientIds: null
      });
      assert.equal(windowed.total, 3);
      assert.deepEqual(windowed.rows.map((row) => row.id), ['venture-b'],
        'name-then-id order pins the continuation batch');

      // ── 5. The rate-limit count: user rows only, thread-scoped, rolling. ──
      const addMessage = (id, role, thread, createdAt = null) => seed.query(
        `insert into firm_chat_messages (id, firm_id, thread, role, content, created_at)
         values ($1, $2, $3, $4, 'x', coalesce($5::timestamptz, now()))`,
        [id, FIRM, thread, role, createdAt]
      );
      await addMessage('m1', 'user', '__firm_feed__');
      await addMessage('m2', 'user', '__firm_feed__');
      await addMessage('m3', 'user', '__firm_feed__');
      await addMessage('m4', 'assistant', '__firm_feed__');
      await addMessage('m5', 'user', '__firm_feed__', new Date(Date.now() - 2 * 3600 * 1000).toISOString());
      await addMessage('m6', 'user', '__other_thread__');
      assert.equal(
        await countRecentFirmChatUserMessagesInDb({ firmId: FIRM, thread: '__firm_feed__' }),
        3,
        'assistant rows, aged-out rows, and other threads never count against the limit'
      );
    } finally {
      await seed.end();
      // Release firmDb's own scratch connections BEFORE the drop, or the
      // drop's forced termination hits an idle pooled client and surfaces
      // as an uncaught error after the test ends.
      await __endFirmDbPoolForTests();
      try { await admin.query(`drop database "${dbName}" with (force)`); } catch { /* teardown best-effort */ }
      await admin.end();
    }
  }
);
