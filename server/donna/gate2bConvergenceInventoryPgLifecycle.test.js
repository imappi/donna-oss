// Gate 2B — real PostgreSQL owner-checkpoint projection proof.
//
// The pure certificate tests prove the checkpoint policy. This lifecycle pin
// proves the runner reads that policy from the current persisted schema and
// the production ask writers: an open owner question is T2, an answered but
// unprocessed question is visible firm-side work, and the named resolution
// writer retires the answered ask into a different sufficient T2. No model or
// injected I/O seam is involved; an unposted accepted line is never called T1.

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';

import {
  createClientEvidenceRequestInDb,
  __endFirmDbPoolForTests,
  resolveClientEvidenceRequestInDb,
} from './firmDb.js';
import { evaluateGate2bOwnerCheckpoints } from './world/gate2bConvergenceProof.js';
import {
  bindGate2bProductionOperations,
  captureRepliedCheckpoint,
  loadGate2bWorld,
  readGate2bInventory,
} from '../../scripts/eval_world_birth_to_quiescence.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIRM_ID = 'eaw-gate2b-owner-pg';
const CLIENT_ID = 'eaw-gate2b-owner-pg-client-1';
const TRANSACTION_ID = 'eaw-gate2b-owner-pg-director-charge';
const ACTOR_ID = 'eaw-gate2b-owner';

test(
  'real PG: Gate 2B observes T2, replied/hanging, then a different T2 through the named ask writers',
  { skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set — Gate 2B real lifecycle not exercised' },
  async () => {
    const dbName = `donna_gate2b_owner_${Date.now().toString(36)}_${process.pid}`;
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`create database "${dbName}"`);
    const scratchUrl = new URL(PG_URL);
    scratchUrl.pathname = `/${dbName}`;
    const seed = new pg.Client({ connectionString: scratchUrl.toString() });
    await seed.connect();

    const envKeys = [
      'DATABASE_URL',
      'DATABASE_POOL_MAX',
      'DONNA_DEFAULT_FIRM_ID',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'AUTO_AI_CODING_ENABLED',
    ];
    const priorEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

    try {
      await seed.query(`
        create schema if not exists storage;
        create table if not exists storage.buckets (
          id text primary key, name text, public boolean,
          file_size_limit bigint, allowed_mime_types text[]);
        create table if not exists storage.objects (
          id uuid default gen_random_uuid() primary key,
          bucket_id text references storage.buckets(id), name text, metadata jsonb);
      `);
      const migrations = (await readdir(path.join(ROOT, 'db', 'migrations')))
        .filter((file) => file.endsWith('.sql'))
        .sort();
      for (const file of migrations) {
        await seed.query(await readFile(path.join(ROOT, 'db', 'migrations', file), 'utf8'));
        await seed.query(
          'insert into schema_migrations (version) values ($1) on conflict (version) do nothing',
          [file.replace(/\.sql$/, '')],
        );
      }

      await seed.query(
        `insert into firms (id, name, slug)
         values ($1, 'Gate 2B Owner Lifecycle', 'gate-2b-owner-lifecycle')`,
        [FIRM_ID],
      );
      await seed.query(
        `insert into clients (id, firm_id, company_name, jurisdiction, profile)
         values ($1, $2, 'Gate Two Apiary Ltd', 'GB', $3::jsonb)`,
        [CLIENT_ID, FIRM_ID, JSON.stringify({ companyName: 'Gate Two Apiary Ltd', jurisdiction: 'GB' })],
      );
      await seed.query(
        `insert into transactions
           (id, firm_id, client_id, transaction_date, description, raw_description,
            money_out, currency, status, payload)
         values ($1, $2, $3, '2026-08-04', 'GWR director card charge',
                 'GWR director card charge', 24, 'GBP', 'needs_review', '{}'::jsonb)`,
        [TRANSACTION_ID, FIRM_ID, CLIENT_ID],
      );

      process.env.DATABASE_URL = scratchUrl.toString();
      process.env.DATABASE_POOL_MAX = '2';
      process.env.DONNA_DEFAULT_FIRM_ID = FIRM_ID;
      process.env.OPENAI_API_KEY = '';
      process.env.ANTHROPIC_API_KEY = '';
      process.env.AUTO_AI_CODING_ENABLED = '0';

      const world = await loadGate2bWorld();
      const hiddenFact = world.hiddenFacts.find((fact) => fact.id === world.gate2b.ownerHiddenFactId);
      assert.ok(hiddenFact, 'the declared owner-only fact must exist');
      const ops = bindGate2bProductionOperations();

      const minted = await createClientEvidenceRequestInDb({
        firmId: FIRM_ID,
        clientId: CLIENT_ID,
        transactionId: TRANSACTION_ID,
        question: 'What was the business purpose of this £24 GWR charge?',
        evidenceType: hiddenFact.kind,
        actorId: ACTOR_ID,
        returnSnapshot: false,
      });
      assert.equal(minted.minted, true);
      const askId = minted.evidence_request.id;
      const obligationId = 'obligation/event/director-charge';

      const preAnswer = await readGate2bInventory({ ops, world, firmId: FIRM_ID, clientId: CLIENT_ID });
      assert.deepEqual(
        preAnswer.obligations.find((row) => row.id === obligationId),
        {
          id: obligationId,
          canonical_identity: 'terminal/event/director-charge',
          source_item_id: 'source/event/director-charge',
          state: 'on_owner',
          reason: 'open_owner_ask',
          ask_id: askId,
          responsible_actor: 'owner',
          fact_class: hiddenFact.kind,
        },
      );

      // Drive the actual reply writer and observe its durable checkpoint while
      // its post-commit recode is still running. Provider credentials are
      // deliberately absent, so this integration proof remains zero-spend; the
      // live C1 runner exercises the same path with its approved model boundary.
      const observedReply = await captureRepliedCheckpoint({
        askId,
        startReply: () => resolveClientEvidenceRequestInDb({
          firmId: FIRM_ID,
          evidenceRequestId: askId,
          reply: hiddenFact.value,
          actorId: ACTOR_ID,
          actorType: 'firm',
          answerSource: 'in_person',
        }),
        readAskStatus: async () => {
          const result = await ops.queryFirmDb(
            'select status from client_evidence_requests where firm_id = $1 and id = $2',
            [FIRM_ID, askId],
          );
          return result.rows?.[0]?.status || null;
        },
        readInventory: () => readGate2bInventory({ ops, world, firmId: FIRM_ID, clientId: CLIENT_ID }),
      });
      const replied = observedReply.checkpoint;
      const repliedObligation = replied.obligations.find((row) => row.id === obligationId);
      assert.equal(replied.asks.find((row) => row.id === askId)?.status, 'replied');
      assert.equal(repliedObligation?.state, 'hanging');
      assert.equal(repliedObligation?.reason, 'owner_answered_processing');
      assert.equal(repliedObligation?.responsible_actor, null);

      await resolveClientEvidenceRequestInDb({
        firmId: FIRM_ID,
        evidenceRequestId: askId,
        reply: hiddenFact.value,
        nextReviewState: 'waiting',
        resolutionNote: 'Business purpose answered; a different customer identity fact is still required.',
        actorId: ACTOR_ID,
        actorType: 'firm',
        answerSource: 'in_person',
      });
      const followUp = await createClientEvidenceRequestInDb({
        firmId: FIRM_ID,
        clientId: CLIENT_ID,
        transactionId: TRANSACTION_ID,
        question: 'Which customer site was this journey for?',
        evidenceType: 'customer_identity',
        actorId: ACTOR_ID,
        returnSnapshot: false,
      });
      assert.equal(followUp.minted, true);
      const followUpAskId = followUp.evidence_request.id;
      const postResume = await readGate2bInventory({ ops, world, firmId: FIRM_ID, clientId: CLIENT_ID });
      assert.equal(postResume.asks.find((row) => row.id === askId)?.status, 'resolved');
      const postObligation = postResume.obligations.find((row) => row.id === obligationId);
      assert.equal(postResume.asks.find((row) => row.id === followUpAskId)?.status, 'draft'); // W1: a re-minted follow-up is a draft until a channel sends it
      assert.equal(postObligation?.state, 'on_owner');
      assert.equal(postObligation?.ask_id, followUpAskId);
      assert.equal(postObligation?.fact_class, 'customer_identity');

      const receipt = evaluateGate2bOwnerCheckpoints({
        declared_hidden_facts: world.hiddenFacts,
        pre_answer: preAnswer,
        replied,
        post_resume: postResume,
        answer: {
          ask_id: askId,
          hidden_fact_id: hiddenFact.id,
          fact_class: hiddenFact.kind,
          obligation_id: obligationId,
        },
      });
      assert.equal(receipt.status, 'PASS', JSON.stringify(receipt.failures));

      const audit = await seed.query(
        `select actor_type, actor_id, action
           from audit_events
          where firm_id = $1 and resource_id = any($2::text[])
          order by created_at`,
        [FIRM_ID, [askId, followUpAskId]],
      );
      assert.ok(audit.rows.some((row) => row.action === 'evidence_request.create'));
      assert.ok(audit.rows.some((row) => row.action === 'evidence_request.resolve'
        && row.actor_type === 'firm' && row.actor_id === ACTOR_ID));
    } finally {
      await __endFirmDbPoolForTests().catch(() => {});
      await seed.end().catch(() => {});
      await admin.query(
        'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
        [dbName],
      ).catch(() => {});
      await admin.query(`drop database if exists "${dbName}"`).catch(() => {});
      await admin.end().catch(() => {});
      for (const [key, value] of Object.entries(priorEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
);
