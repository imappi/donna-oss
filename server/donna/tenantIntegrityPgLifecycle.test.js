// SG2 fix-B — real router + real PostgreSQL proof of the tenant-integrity
// findings F-4 (queue upsert fence), F-3 (document PATCH allowlist + actor),
// F-10 (document routes authorize before any snapshot; uniform 404).
//
// OPT-IN like the other real-PG lifecycle suites: DONNA_PG_TEST_URL must name a
// scratch role that may CREATE DATABASE. Principals: two firms, a member of
// each, an assigned collaborator, and an inactive member — all through the
// Supabase-bearer path the production router uses.

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// The default firm is baked at module load; a collaborator resolves against it
// on the bearer path, so bind it to firm A BEFORE the router is imported.
const priorDefaultFirm = process.env.DONNA_DEFAULT_FIRM_ID;
process.env.DONNA_DEFAULT_FIRM_ID = 'firm-ti-a';
const { handleDonnaApiRequest } = await import('./api.js');
const { __endFirmDbPoolForTests } = await import('./firmDb.js');
if (priorDefaultFirm === undefined) delete process.env.DONNA_DEFAULT_FIRM_ID;
else process.env.DONNA_DEFAULT_FIRM_ID = priorDefaultFirm;

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const A = 'firm-ti-a';
const B = 'firm-ti-b';
const USERS = {
  'a-member': { id: 'u-a-member', email: 'member@a.ti.example' },
  'b-member': { id: 'u-b-member', email: 'member@b.ti.example' },
  'a-collab': { id: 'u-a-collab', email: 'owner@a-client.ti.example' },
  'a-inactive': { id: 'u-a-inactive', email: 'gone@a.ti.example' }
};

const restoreEnv = (key, prior) => {
  if (prior === undefined) delete process.env[key];
  else process.env[key] = prior;
};

const call = async ({ method = 'GET', url, token, body }) => {
  const encoded = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(encoded ? [Buffer.from(encoded)] : []);
  req.method = method;
  req.url = `/api/donna/firms${url}`;
  req.headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(encoded))
  };
  let responseBody = '';
  let resolveEnded;
  const ended = new Promise((resolve) => { resolveEnded = resolve; });
  const res = {
    statusCode: 200,
    setHeader: () => {},
    end: (value = '') => {
      responseBody = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
      resolveEnded();
    }
  };
  await handleDonnaApiRequest(req, res);
  await ended;
  let parsed = null;
  try { parsed = responseBody ? JSON.parse(responseBody) : null; } catch { parsed = responseBody; }
  return { statusCode: res.statusCode, body: parsed };
};

const withTenantDb = async (run) => {
  const dbName = `donna_ti_${Date.now().toString(36)}_${process.pid}`;
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  await admin.query(`create database "${dbName}"`);
  const scratchUrl = new URL(PG_URL);
  scratchUrl.pathname = `/${dbName}`;
  const seed = new pg.Client({ connectionString: scratchUrl.toString() });
  await seed.connect();

  const envKeys = ['DATABASE_URL', 'DATABASE_POOL_MAX', 'DONNA_DESKTOP_BLOB_DIR', 'DONNA_ACCESS_TOKEN',
    'DONNA_DEFAULT_FIRM_ID', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY',
    'DONNA_AUTH_ALLOWED_EMAILS', 'STRIPE_SECRET_KEY'];
  const priorEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const realFetch = globalThis.fetch;
  try {
    await seed.query('create schema if not exists storage; create table if not exists storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]); create table if not exists storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb);');
    const migrations = (await readdir(path.join(ROOT, 'db', 'migrations'))).filter((f) => f.endsWith('.sql')).sort();
    for (const file of migrations) {
      await seed.query(await readFile(path.join(ROOT, 'db', 'migrations', file), 'utf8'));
      await seed.query('insert into schema_migrations(version) values($1) on conflict do nothing', [file.slice(0, -4)]);
    }
    await seed.query(`insert into firms (id, name, slug) values ($1,'TI A','ti-a'), ($2,'TI B','ti-b')`, [A, B]);
    await seed.query(
      `insert into firm_members (id, firm_id, user_id, email, name, role, status, access_level) values
        ('m-a', $1, $3, $4, 'A Member', 'owner', 'active', 'staff'),
        ('m-b', $2, $5, $6, 'B Member', 'owner', 'active', 'staff'),
        ('m-a-gone', $1, $7, $8, 'A Gone', 'staff', 'inactive', 'staff')`,
      [A, B, USERS['a-member'].id, USERS['a-member'].email, USERS['b-member'].id, USERS['b-member'].email,
        USERS['a-inactive'].id, USERS['a-inactive'].email]
    );
    await seed.query(
      `insert into clients (id, firm_id, company_name) values
        ('a-client', $1, 'A Client'), ('b-client', $2, 'B Client')`, [A, B]);
    await seed.query(
      `insert into firm_collaborators (id, firm_id, user_id, email, name, status, access_level)
       values ('c-a', $1, $2, $3, 'A Portal Owner', 'active', 'client_scoped')`,
      [A, USERS['a-collab'].id, USERS['a-collab'].email]);
    await seed.query(
      `insert into client_assignments (id, firm_id, client_id, principal_type, principal_id, role, access_level)
       values ('asg-c-a', $1, 'a-client', 'firm_collaborator', 'c-a', 'editor', 'client_scoped')`, [A]);

    process.env.DATABASE_URL = scratchUrl.toString();
    process.env.DATABASE_POOL_MAX = '2';
    delete process.env.DONNA_DESKTOP_BLOB_DIR;
    process.env.DONNA_ACCESS_TOKEN = 'ti-shared-token-unused';
    process.env.DONNA_DEFAULT_FIRM_ID = A;
    process.env.SUPABASE_URL = 'https://auth.ti.invalid';
    process.env.SUPABASE_ANON_KEY = 'ti-anon';
    delete process.env.SUPABASE_PUBLISHABLE_KEY;
    process.env.DONNA_AUTH_ALLOWED_EMAILS = [USERS['a-member'], USERS['b-member'], USERS['a-inactive']].map((u) => u.email).join(',');
    delete process.env.STRIPE_SECRET_KEY;
    globalThis.fetch = async (url, options = {}) => {
      const token = String(options.headers?.Authorization || '').replace(/^Bearer\s+/i, '');
      const user = USERS[token];
      return user ? { ok: true, json: async () => user } : { ok: false, json: async () => null };
    };
    await run({ seed });
  } finally {
    globalThis.fetch = realFetch;
    await __endFirmDbPoolForTests();
    for (const key of envKeys) restoreEnv(key, priorEnv[key]);
    await seed.end();
    await admin.query(`drop database if exists "${dbName}" with (force)`);
    await admin.end();
  }
};

const skip = { skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set — tenant-integrity lifecycle not exercised' };

test('F-4: POST /clients cannot overwrite another firm\'s queue item, nor point one at another client', skip, async () => {
  await withTenantDb(async ({ seed }) => {
    await seed.query(
      `insert into queue_items (id, firm_id, client_id, queue_label, status, payload)
       values ('q-b-1', $1, 'b-client', 'B private item', 'open', '{"secret":"b"}'::jsonb)`, [B]);
    const readB = async () => (await seed.query(`select * from queue_items where id = 'q-b-1'`)).rows[0];
    const before = await readB();

    const hijack = await call({
      method: 'POST', url: '/clients', token: 'a-member',
      body: { firm_id: A, profile: { id: 'a-squat', companyName: 'Squat', jurisdiction: 'US', entityType: 'us-llc' },
        queue: [{ id: 'q-b-1', queue_label: 'hijacked by A' }] }
    });
    assert.equal(hijack.statusCode, 409, JSON.stringify(hijack.body));
    assert.equal(hijack.body.code, 'QUEUE_ITEM_FIRM_CONFLICT');
    assert.deepEqual(await readB(), before, "firm B's queue row is byte-for-byte unchanged");
    assert.equal((await seed.query(`select count(*)::int n from clients where id = 'a-squat'`)).rows[0].n, 0,
      'the refusal rolls back the whole create');

    // Variant: an item that names a client other than the one being written.
    const cross = await call({
      method: 'POST', url: '/clients', token: 'a-member',
      body: { firm_id: A, profile: { id: 'a-two', companyName: 'Two', jurisdiction: 'US', entityType: 'us-llc' },
        queue: [{ id: 'q-a-cross', client_id: 'b-client', queue_label: 'points at B' }] }
    });
    assert.equal(cross.statusCode, 409, JSON.stringify(cross.body));
    assert.equal(cross.body.code, 'QUEUE_ITEM_CLIENT_MISMATCH');
    assert.equal((await seed.query(`select count(*)::int n from queue_items where id = 'q-a-cross'`)).rows[0].n, 0);

    // Neighbour: the client's own welcome item still upserts, idempotently.
    const create = () => call({
      method: 'POST', url: '/clients', token: 'a-member',
      body: { firm_id: A, profile: { id: 'a-ok', companyName: 'Ok Ltd', jurisdiction: 'US', entityType: 'us-llc' },
        queue: [{ id: 'q-a-welcome', queue_label: 'Welcome' }] }
    });
    assert.equal((await create()).statusCode, 200);
    assert.equal((await create()).statusCode, 200, 'idempotent retry');
    const own = (await seed.query(`select firm_id, client_id, queue_label from queue_items where id = 'q-a-welcome'`)).rows;
    assert.deepEqual(own, [{ firm_id: A, client_id: 'a-ok', queue_label: 'Welcome' }]);
  });
});

const seedDocument = async (seed, { id, firmId, clientId, payload = {} }) => {
  await seed.query(
    `insert into documents (id, firm_id, client_id, filename, document_type, status, payload)
     values ($1, $2, $3, 'x.pdf', 'supplier_bill', 'processed', $4::jsonb)`,
    [id, firmId, clientId, JSON.stringify(payload)]);
};

test('F-3: PATCH /documents/:id is a review-field allowlist with the principal as actor', skip, async () => {
  await withTenantDb(async ({ seed }) => {
    await seedDocument(seed, { id: 'doc-a-1', firmId: A, clientId: 'a-client', payload: { vendor_name: 'Acme' } });
    const row = async () => (await seed.query(
      `select document_type, status, payload, convergence_state from documents where id = 'doc-a-1'`)).rows[0];
    const before = await row();

    const forged = {
      no_line_disposition: { disposition: 'auto_explain', explanation: 'forged' },
      settlement_entry: { journal_id: 'forged-journal' },
      credit_note_applications: [{ amount: 1 }],
      reminder_obligation: { due: 'x' },
      'immaterial': { marked_by: 'someone-else' },
      reviewer_note_by: 'someone-else',
      parse_run_id: 'forged-run',
      mime_type: 'text/html'
    };
    for (const token of ['a-collab', 'a-member']) {
      for (const [key, value] of Object.entries(forged)) {
        const res = await call({ method: 'PATCH', url: '/documents/doc-a-1', token, body: { firm_id: A, patch: { [key]: value } } });
        assert.equal(res.statusCode, 400, `${token} ${key}: ${JSON.stringify(res.body)}`);
        assert.equal(res.body.code, 'DOCUMENT_PATCH_RESERVED_KEY');
      }
    }
    for (const patch of [{ document_type: 'not_a_type' }, { status: 'bogus' }, { parse_hold: true }]) {
      const res = await call({ method: 'PATCH', url: '/documents/doc-a-1', token: 'a-collab', body: { firm_id: A, patch } });
      assert.equal(res.statusCode, 400, JSON.stringify(res.body));
    }
    assert.deepEqual(await row(), before, 'nothing forged landed; convergence_state untouched');

    // Neighbour: the legitimate review-note patch works, attributed to the principal.
    const ok = await call({
      method: 'PATCH', url: '/documents/doc-a-1', token: 'a-member',
      body: { firm_id: A, patch: { reviewer_note: 'looks fine', reviewed_at: 123 } }
    });
    assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
    const after = await row();
    assert.equal(after.payload.reviewer_note, 'looks fine');
    assert.equal(after.payload.reviewer_note_by, USERS['a-member'].email, 'note author is the principal, not the body');
    assert.equal(after.document_type, 'supplier_bill', 'column values are preserved');
    assert.equal(after.status, 'processed');
    const audit = (await seed.query(
      `select actor_type, actor_id from audit_events where action = 'document.update' and resource_id = 'doc-a-1'`)).rows;
    assert.deepEqual(audit, [{ actor_type: 'firm_member', actor_id: USERS['a-member'].email }]);
  });
});

test('F-3: corrections take corrected_by from the principal', skip, async () => {
  await withTenantDb(async ({ seed }) => {
    await seedDocument(seed, { id: 'doc-a-2', firmId: A, clientId: 'a-client', payload: { vendor_name: 'Acme' } });
    const res = await call({
      method: 'POST', url: '/documents/doc-a-2/corrections', token: 'a-member',
      body: { firm_id: A, field_path: 'vendor_name', corrected_value: 'Acme Ltd', corrected_by: 'spoofed@example.com' }
    });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    const rows = (await seed.query(`select corrected_by from document_corrections where document_id = 'doc-a-2'`)).rows;
    assert.deepEqual(rows, [{ corrected_by: USERS['a-member'].email }]);
  });
});

test('F-10: document routes answer a uniform 404 before any snapshot; own access still works', skip, async () => {
  await withTenantDb(async ({ seed }) => {
    await seedDocument(seed, { id: 'doc-a-3', firmId: A, clientId: 'a-client' });
    const probes = [
      { method: 'GET', url: `/documents/doc-a-3/download?firm_id=${A}` },
      { method: 'PATCH', url: '/documents/doc-a-3', body: { firm_id: A, patch: { reviewer_note: 'x' } } },
      { method: 'DELETE', url: `/documents/doc-a-3?firm_id=${A}` }
    ];
    const missing = [
      { method: 'GET', url: `/documents/nope/download?firm_id=${A}` },
      { method: 'PATCH', url: '/documents/nope', body: { firm_id: A, patch: { reviewer_note: 'x' } } },
      { method: 'DELETE', url: `/documents/nope?firm_id=${A}` }
    ];
    // Oracle for "no firm snapshot before authorization": the snapshot is what
    // reads queue_items/ledger_journals (and settles that firm's marks), so a
    // foreign probe must issue none of those statements. (Mark counts are not a
    // usable oracle: every client release sweeps marks generically.)
    const statements = [];
    const originalQuery = pg.Client.prototype.query;
    pg.Client.prototype.query = function spy(...args) {
      statements.push(String(args[0]?.text ?? args[0]));
      return originalQuery.apply(this, args);
    };
    try {
    for (const token of ['b-member', 'a-inactive']) {
      for (let i = 0; i < probes.length; i += 1) {
        statements.length = 0;
        const existing = await call({ ...probes[i], token });
        const snapshotReads = statements.filter((sql) => /queue_items|ledger_journals/.test(sql));
        assert.deepEqual(snapshotReads, [], `${token} ${probes[i].method}: no snapshot statements before authorization`);
        const absent = await call({ ...missing[i], token });
        assert.equal(existing.statusCode, 404, `${token} ${probes[i].method}: ${JSON.stringify(existing.body)}`);
        assert.deepEqual(existing, absent, `${token} ${probes[i].method}: existing vs missing must be identical`);
      }
    }
    } finally {
      pg.Client.prototype.query = originalQuery;
    }
    assert.equal((await seed.query(`select count(*)::int n from documents where id = 'doc-a-3'`)).rows[0].n, 1);

    // Neighbour: the collaborator sees their own document but a delete is member-only (403, not 404).
    const collabDelete = await call({ method: 'DELETE', url: `/documents/doc-a-3?firm_id=${A}`, token: 'a-collab' });
    assert.equal(collabDelete.statusCode, 403, JSON.stringify(collabDelete.body));
    // Neighbour: firm A's own member gets past the gate (no storage metadata seeded ⇒ the download's own 404 code).
    const own = await call({ method: 'GET', url: `/documents/doc-a-3/download?firm_id=${A}`, token: 'a-member' });
    assert.equal(own.body.code, 'DOCUMENT_STORAGE_MISSING', JSON.stringify(own.body));
    const ownDelete = await call({ method: 'DELETE', url: `/documents/doc-a-3?firm_id=${A}`, token: 'a-member' });
    assert.equal(ownDelete.statusCode, 200, JSON.stringify(ownDelete.body));
  });
});

test('F-20: Telegram inbound ids are chat-scoped — two chats\' message 57 both land; redelivery still dedupes', skip, async () => {
  await withTenantDb(async ({ seed }) => {
    const { processTelegramInboundMessage } = await import('./channels/telegramInbound.js');
    const { claimInboundTelegramMessageInDb } = await import('./firmDb.js');
    const { hashPhoneE164 } = await import('./channels/whatsappWebhookCore.js');
    const persisted = [];
    const chatDeps = ({ chatKey, clientId }) => ({
      getBindingsByPhoneHash: async () => [{ id: `tgb-${chatKey}`, client_id: clientId, collaborator_id: `owner-${chatKey}`, phone_hash: hashPhoneE164(chatKey), channel: 'telegram' }],
      // The reply anchors to an open ask, so the message reaches the ledger claim.
      getDeliveryByMessageId: async () => ({ ask_id: `ask-${clientId}`, client_id: clientId, message_id: '9' }),
      getOpenAskByRef: async () => null,
      getAskById: async () => ({ id: `ask-${clientId}`, client_id: clientId, status: 'open', evidence_type: 'clarification', question: 'what was this?', request_payload: {} }),
      recordEvidenceTopicTurn: async () => ({}),
      claimInboundMessage: claimInboundTelegramMessageInDb,   // the REAL ledger claim
      appendClientPortalChatMessage: async (row) => { persisted.push(row); return { ...row, created_at: '2026-07-15T00:00:00.000Z' }; },
      assembleClientPortalTurn: async () => ({ context: { client: { name: 'X' } }, history: [], validAskIds: [], assistantName: 'Donna', ownerMemory: null }),
      generateClientPortalChatReply: async () => ({ kind: 'ok', text: 'ok', actions: [], model: 'test-model' }),
      resolveEvidenceRequest: async ({ evidenceRequestId }) => ({ evidence_request: { id: evidenceRequestId, status: 'resolved' } }),
      recordLedger: async () => ({}),
      sendText: async () => ({ ok: true })
    });
    const receive = ({ chatId, firmId, clientId, messageId }) => processTelegramInboundMessage({
      message: { message_id: messageId, chat: { id: chatId, type: 'private' }, reply_to_message: { message_id: 9 }, text: 'It was a client dinner.' },
      from: String(chatId),
      firmId,
      env: { ...process.env, TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_ENABLED: 'true', TELEGRAM_CLIENTS: 'a-client,b-client' },
      deps: chatDeps({ chatKey: String(chatId), clientId })
    });
    const a1 = await receive({ chatId: 1001, firmId: A, clientId: 'a-client', messageId: 57 });
    const b1 = await receive({ chatId: 2002, firmId: B, clientId: 'b-client', messageId: 57 });
    assert.notEqual(a1.status, 'duplicate', JSON.stringify(a1));
    assert.notEqual(b1.status, 'duplicate', `firm B's message 57 must not collide with firm A's: ${JSON.stringify(b1)}`);
    const redelivery = await receive({ chatId: 1001, firmId: A, clientId: 'a-client', messageId: 57 });
    assert.equal(redelivery.status, 'duplicate', 'redelivery inside one chat is still deduped');
    const ids = (await seed.query(`select message_id from message_delivery_ledger where provider = 'telegram' order by message_id`)).rows.map((r) => r.message_id);
    assert.deepEqual(ids, ['tg_1001_57', 'tg_2002_57']);
  });
});
