// Evidence-topic turn writers — the real-PostgreSQL test (2026-09-03).
//
// Why this file has to hit a real database, not mocks: `recordEvidenceTopicTurnInDb`
// bound FIVE values to a THREE-placeholder update from its birth in #1932 and
// `stampEvidenceTopicReminderInDb` bound four. A fake `client.query` accepts any
// array, so the mocked writer tests stayed green while PostgreSQL refused every
// bind ("bind message supplies 5 parameters, but prepared statement "" requires
// 3") — every client-portal reply that read as a conversational turn, every
// SMS / Telegram / WhatsApp inbound turn and every reminder stamp threw, and the
// owner's reply never left the ask row (Kari, 2026-09-03: the Shopify settlement
// file). Only a real bind proves the arrays and the statements agree.
//
// OPT-IN like its siblings (askLifecyclePgLifecycle): set DONNA_PG_TEST_URL to a
// scratch PostgreSQL whose role may CREATE DATABASE; without it the test SKIPS
// loudly. It runs in a throwaway DATABASE with the ask schema migrations executed
// VERBATIM and points the REAL firmDb module at it via DATABASE_URL.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import {
  recordEvidenceTopicTurnInDb,
  stampEvidenceTopicReminderInDb,
  listOpenEvidenceTopicsForReminderInDb,
  __endFirmDbPoolForTests
} from './firmDb.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const FIRM = 'firm-topicturn';
const CLIENT = 'venture-topicturn';

test(
  'evidence-topic turn + reminder writers bind on real PG and land the topic on the open ask',
  { skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set — real-PG topic-turn writers not exercised in this run' },
  async () => {
    const dbName = `donna_topicturn_${Date.now().toString(36)}_${process.pid}`;
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
        '002_transaction_intelligence.sql',
        '005_local_ledger.sql',
        '009_client_evidence_requests.sql',
        '022_client_jurisdiction.sql',
        '035_ledger_account_canonical_role.sql',
        '108_evidence_request_identity.sql',
        '122_ask_audience.sql'
      ]) {
        await seed.query(await readFile(path.join(ROOT, 'db', 'migrations', file), 'utf8'));
      }
      await seed.query(`insert into firms (id, name, slug) values ($1, 'Topic Turn Firm', 'topic-turn-firm')`, [FIRM]);
      await seed.query(`insert into clients (id, firm_id, company_name) values ($1, $2, 'Topic Turn Ltd')`, [CLIENT, FIRM]);
      await seed.query(
        `insert into transactions (id, firm_id, client_id, description) values ('tx-shopify', $1, $2, 'SHOPIFY payout')`,
        [FIRM, CLIENT]
      );
      await seed.query(
        `insert into client_evidence_requests
           (id, firm_id, client_id, transaction_id, status, evidence_type, question,
            send_count, first_sent_at, last_sent_at, due_at, canonical_anchor, blocker_code, audience,
            request_payload)
         values ('ask-shopify', $1, $2, 'tx-shopify', 'open', 'supporting_document',
                 'Please send the Shopify payout settlement for this deposit.',
                 1, now() - interval '3 days', now() - interval '3 days', now() + interval '4 days',
                 'test:ask-shopify', 'supporting_document', 'client', '{"untouched": true}'::jsonb)`,
        [FIRM, CLIENT]
      );

      // Point the REAL firmDb module at the scratch DB (env read lazily at first query).
      process.env.DATABASE_URL = scratchUrl.toString();
      process.env.DATABASE_POOL_MAX = '1';

      // 1. The portal turn: the exact call api.js's resolve route makes.
      const topicState = {
        status: 'open',
        channel: 'portal',
        actor_id: 'owner@example.test',
        last_owner_message_at: '2026-09-03T10:00:00.000Z',
        turns: [{ text: 'Attached the settlement file.', document_ids: ['doc-settlement'] }]
      };
      const recorded = await recordEvidenceTopicTurnInDb({
        firmId: FIRM,
        evidenceRequestId: 'ask-shopify',
        topicState,
        actorId: 'owner@example.test',
        actorType: 'client'
      });
      assert.equal(recorded.evidence_request.status, 'open', 'a topic turn keeps the ask open (it is not an answer)');
      assert.deepEqual(recorded.evidence_topic, topicState);
      assert.deepEqual(recorded.evidence_request.request_payload.untouched, true, 'the merge keeps the rest of the payload');

      const stored = await seed.query(`select request_payload from client_evidence_requests where id = 'ask-shopify'`);
      assert.deepEqual(stored.rows[0].request_payload.evidence_topic, topicState, 'the topic is persisted, not just echoed');

      // 2. The reminder sweep sees the open topic and stamps it.
      const due = await listOpenEvidenceTopicsForReminderInDb({ firmId: FIRM, clientId: CLIENT });
      assert.deepEqual(due.map((row) => row.id), ['ask-shopify']);
      const stamped = await stampEvidenceTopicReminderInDb({
        firmId: FIRM,
        evidenceRequestId: 'ask-shopify',
        topicState: { ...topicState, last_donna_message_at: '2026-09-03T11:00:00.000Z' }
      });
      assert.equal(stamped.evidence_topic.last_donna_message_at, '2026-09-03T11:00:00.000Z');

      // 3. A turn on a request that is not open is refused, not silently written.
      await seed.query(`update client_evidence_requests set status = 'replied' where id = 'ask-shopify'`);
      await assert.rejects(
        recordEvidenceTopicTurnInDb({ firmId: FIRM, evidenceRequestId: 'ask-shopify', topicState }),
        (error) => error.code === 'OPEN_EVIDENCE_REQUEST_NOT_FOUND'
      );
    } finally {
      await __endFirmDbPoolForTests().catch(() => {});
      await seed.end().catch(() => {});
      await admin.query(`drop database if exists "${dbName}" with (force)`).catch(() => {});
      await admin.end().catch(() => {});
    }
  }
);
