// Small gaps in the audit record, each proved on real PostgreSQL through the
// real route or function. Only the identity provider and the SMS provider are
// fixtures. All firms, people, companies and numbers are synthetic.
//
//   1. Callers of the profile writer that act for a person name that person:
//      the owner's initial company setup, the operator's Finnish pilot
//      preparation, and the seller identity the owner gives in the invoice
//      chat. A write with no person behind it stays 'system'.
//   2. A corrected legalName replaces the alias it corrects in
//      profile.legalNames, so clients.legal_names (derived from the profile)
//      drops the wrong name. Other aliases stay.
//   3. entityType and accountingCurrency are known profile keys: no
//      "unknown key" warning on the pilot's write, and a malformed value is
//      refused.
//   5. The evidence-topic reminder sweep counts a skip (no bound channel,
//      Telegram switched off, a text withheld as sensitive) apart from a
//      failure, and the scheduler's partial-failure summary reads a real error.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import pg from 'pg';
import donnaRouter from '../../api/donna-router.js';
import { prepareFinnishHostedPilotInDb } from './hostedPilot.js';
import { selfProvisionClientWorkspace } from './selfProvisionDb.js';
import { DEFAULT_FIRM_ID, __setFirmDbPoolForTests, __resetFirmDbPoolForTests, deriveClientIdentityColumns } from './firmDb.js';
import { correctLegalNameAliases } from './db/clients.js';
import { persistFinlandSellerIdentityInDb } from './finland/issuanceDb.js';
import { runEvidenceTopicReminderSweep } from './channels/evidenceTopicReminders.js';
import { hashPhoneE164 } from './channels/whatsappWebhookCore.js';
import { parseCronSummaryFailures } from './parseCronSummaryFailures.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;

test('correctLegalNameAliases: a corrected name replaces the one it corrects, and only that one', () => {
  const aliases = ['Wrong Oy', 'Trading Name'];
  assert.deepEqual(correctLegalNameAliases({ aliases, previous: 'Wrong Oy', next: 'Right Oy' }), ['Right Oy', 'Trading Name']);
  assert.deepEqual(correctLegalNameAliases({ aliases: ['wrong oy ', 'Trading Name'], previous: 'Wrong Oy', next: 'Right Oy' }), ['Right Oy', 'Trading Name'], 'case and spacing');
  assert.deepEqual(correctLegalNameAliases({ aliases, previous: 'Wrong Oy', next: null }), ['Trading Name'], 'a cleared legal name takes its alias with it');
  assert.deepEqual(correctLegalNameAliases({ aliases: ['Wrong Oy', 'Right Oy'], previous: 'Wrong Oy', next: 'Right Oy' }), ['Right Oy'], 'no duplicate');
  assert.equal(correctLegalNameAliases({ aliases, previous: 'Other Oy', next: 'Right Oy' }), null, 'nothing to correct: unchanged');
  assert.equal(correctLegalNameAliases({ aliases, previous: null, next: 'Right Oy' }), null, 'a first legal name corrects nothing');
  assert.equal(correctLegalNameAliases({ aliases, previous: 'Wrong Oy', next: 'wrong oy' }), null, 'a re-statement is not a correction');
  assert.equal(correctLegalNameAliases({ aliases: undefined, previous: 'Wrong Oy', next: 'Right Oy' }), null);
});

test('real PG: profile callers name who acted, a corrected legal name replaces its alias, the pilot keys are known, reminder skips are not failures', {
  skip: pgUrl ? false : 'DONNA_PG_TEST_URL not set', timeout: 300_000
}, async (t) => {
  const name = `donna_audit_gaps_${process.pid}_${Date.now().toString(36)}`;
  const admin = new pg.Client({ connectionString: pgUrl });
  await admin.connect(); await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl); url.pathname = `/${name}`;
  const seed = new pg.Client({ connectionString: url.toString() }); await seed.connect();
  const pool = new pg.Pool({ connectionString: url.toString() });
  const closed = []; pool.on('connect', (c) => closed.push(new Promise((resolve) => c.once('end', resolve))));
  __setFirmDbPoolForTests(pool);
  const firmId = DEFAULT_FIRM_ID;
  const savedEnv = Object.fromEntries(['DATABASE_URL', 'DONNA_ACCESS_TOKEN', 'DONNA_DEFAULT_FIRM_ID', 'DONNA_DESKTOP_BLOB_DIR', 'SUPABASE_URL',
    'SUPABASE_PUBLISHABLE_KEY', 'DONNA_AUTH_ALLOWED_EMAILS', 'STRIPE_SECRET_KEY', 'TELEGRAM_ENABLED', 'TELEGRAM_CLIENTS'].map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    __resetFirmDbPoolForTests(); await pool.end(); await Promise.all(closed); await seed.end();
    await admin.query(`drop database "${name}" with (force)`); await admin.end();
  });
  await seed.query(`create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb)`);
  const root = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(root)).filter((f) => f.endsWith('.sql')).sort()) {
    await seed.query(await readFile(new URL(file, root), 'utf8'));
    await seed.query('insert into schema_migrations(version) values($1) on conflict do nothing', [file.slice(0, -4)]);
  }
  await seed.query("insert into firms(id,name,slug,jurisdiction,default_currency) values($1,'Audit gaps firm',$1,'FI','EUR')", [firmId]);
  const operatorId = 'member-audit-gaps-operator';
  const member = { userId: 'user-audit-gaps-member', email: 'operator@audit-gaps.invalid' };
  const ownerA = { userId: 'user-audit-gaps-owner-a', email: 'a@audit-gaps.invalid' };
  const ownerB = { userId: 'user-audit-gaps-owner-b', email: 'b@audit-gaps.invalid' };
  await seed.query("insert into firm_members(id,firm_id,user_id,email,name,role,status) values($1,$2,$3,$4,'Fixture operator','admin','active')",
    [operatorId, firmId, member.userId, member.email]);
  Object.assign(process.env, { DATABASE_URL: url.toString(), DONNA_ACCESS_TOKEN: 'not-a-tester-token', DONNA_DEFAULT_FIRM_ID: firmId,
    SUPABASE_URL: 'https://audit-gaps-auth.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-public-key', DONNA_AUTH_ALLOWED_EMAILS: '' });
  delete process.env.DONNA_DESKTOP_BLOB_DIR; delete process.env.STRIPE_SECRET_KEY;
  delete process.env.TELEGRAM_ENABLED; delete process.env.TELEGRAM_CLIENTS;
  globalThis.fetch = async (address, init) => {
    assert.equal(address, 'https://audit-gaps-auth.invalid/auth/v1/user', 'no provider call in this proof');
    const who = { 'Bearer member': member, 'Bearer owner-a': ownerA, 'Bearer owner-b': ownerB }[init.headers.Authorization] || null;
    return new Response(JSON.stringify(who ? { id: who.userId, email: who.email } : {}), { status: who ? 200 : 401 });
  };
  const request = async (token, path, body) => {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    req.method = body ? 'POST' : 'GET';
    req.url = `/api/donna-router?path=${encodeURIComponent(`firms${path}`)}`;
    req.headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    return new Promise((resolve, reject) => {
      const res = { statusCode: 200, setHeader() {}, end(value) { resolve({ status: this.statusCode, body: value ? JSON.parse(String(value)) : null }); } };
      Promise.resolve(donnaRouter(req, res)).catch(reject);
    });
  };
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.map(String).join(' ')); realWarn(...args); };
  t.after(() => { console.warn = realWarn; });
  const lastProfileAudit = async (clientId) => (await seed.query(`select actor_type, actor_id, metadata from audit_events
    where client_id=$1 and action='client.profile.update' order by id desc limit 1`, [clientId])).rows[0];
  const unknownKeyWarnings = () => warnings.filter((line) => line.includes('Unknown profile key'));

  const a = await selfProvisionClientWorkspace({ auth: ownerA });
  const b = await selfProvisionClientWorkspace({ auth: ownerB, companyName: 'Kettu Lantern Works', jurisdiction: 'FI', entityType: 'fi-oy' });
  const ownerACollaborator = (await seed.query('select id from firm_collaborators where firm_id=$1 and user_id=$2', [firmId, ownerA.userId])).rows[0].id;

  await t.test('1a. the owner\'s initial company setup names the owner on the profile row', async () => {
    const setup = await request('owner-a', `/clients/${a.clientId}/profile`, { owner_setup: true,
      profile_patch: { companyName: 'Pohjoinen Synthetic Oy', jurisdiction: 'FI', entityType: 'fi-oy', incorporation_date: '2025-01-01' } });
    assert.equal(setup.status, 200, JSON.stringify(setup.body));
    const row = await lastProfileAudit(a.clientId);
    assert.deepEqual([row.actor_type, row.actor_id], ['supabase_user', ownerA.userId],
      'the same person and type as the client.owner_company_setup row beside it, not "system"');
    const companion = (await seed.query("select actor_type, actor_id from audit_events where client_id=$1 and action='client.owner_company_setup'", [a.clientId])).rows[0];
    assert.deepEqual([companion.actor_type, companion.actor_id], [row.actor_type, row.actor_id]);
  });

  await t.test('1b + 3. the operator\'s pilot preparation names the member; entityType and accountingCurrency are known keys', async () => {
    warnings.length = 0;
    await prepareFinnishHostedPilotInDb({ firmId, clientId: a.clientId, actorId: operatorId, profilePatch: { companyName: 'Pohjoinen Synthetic Oy',
      jurisdiction: 'FI', entityType: 'fi-oy', accountingCurrency: 'EUR', accounting_system: 'none', accounting_view: 'management_books', accountingBasis: 'accrual' } });
    const row = await lastProfileAudit(a.clientId);
    assert.deepEqual([row.actor_type, row.actor_id], ['firm_member', operatorId], 'the active member who prepared it, not "system"');
    assert.deepEqual(unknownKeyWarnings(), [], 'the pilot\'s own keys are known keys');
    const stored = (await seed.query('select profile from clients where id=$1', [a.clientId])).rows[0].profile;
    assert.deepEqual([stored.entityType, stored.accountingCurrency], ['fi-oy', 'EUR']);
    // A malformed value is refused, and nothing is written.
    for (const patch of [{ accountingCurrency: 'euro' }, { accountingCurrency: 12 }, { entityType: 'fi-made-up-form' }, { entityType: 7 }]) {
      const refused = await request('member', `/clients/${b.clientId}/profile`, { firm_id: firmId, profile_patch: patch });
      assert.equal(refused.status, 400, `${JSON.stringify(patch)}: ${JSON.stringify(refused.body)}`);
    }
    const normalised = await request('member', `/clients/${b.clientId}/profile`, { firm_id: firmId, profile_patch: { accountingCurrency: ' eur ' } });
    assert.equal(normalised.status, 200, JSON.stringify(normalised.body));
    assert.equal((await seed.query('select profile from clients where id=$1', [b.clientId])).rows[0].profile.accountingCurrency, 'EUR');
    const cleared = await request('member', `/clients/${b.clientId}/profile`, { firm_id: firmId, profile_patch: { accountingCurrency: null } });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.deepEqual(unknownKeyWarnings(), []);
  });

  await t.test('1c. the invoice chat\'s seller identity names the owner; the webhook fallback stays "system"', async () => {
    // On book b: a prepared pilot book holds its company facts read-only.
    const ownerBCollaborator = (await seed.query('select id from firm_collaborators where firm_id=$1 and user_id=$2', [firmId, ownerB.userId])).rows[0].id;
    await persistFinlandSellerIdentityInDb({ firmId, clientId: b.clientId, sellerIdentity: { businessId: '0000002-7' }, actorId: ownerBCollaborator });
    const named = await lastProfileAudit(b.clientId);
    assert.deepEqual([named.actor_type, named.actor_id], ['firm_collaborator', ownerBCollaborator], 'the owner bound to the chat, by their own row');
    // A binding with no collaborator records the transport's fallback id: no person to name.
    await persistFinlandSellerIdentityInDb({ firmId, clientId: b.clientId, sellerIdentity: { iban: 'FI00 0000 0000 0000 00' }, actorId: 'whatsapp:webhook' });
    const fallback = await lastProfileAudit(b.clientId);
    assert.deepEqual([fallback.actor_type, fallback.actor_id], ['system', 'whatsapp:webhook']);
    // The owner of another book is not named on this one.
    await persistFinlandSellerIdentityInDb({ firmId, clientId: b.clientId, sellerIdentity: { businessId: '0000003-5' }, actorId: ownerACollaborator });
    assert.deepEqual(Object.values(await lastProfileAudit(b.clientId)).slice(0, 2), ['system', ownerACollaborator]);
  });

  await t.test('2. a corrected legalName replaces the alias it corrects; other aliases and the record stay', async () => {
    // At intake the wrong name was taken as both the legal name and an alias.
    const intake = { legalName: 'Kettu Lanterns Wrong Oy', legalNames: ['Kettu Lanterns Wrong Oy', 'Kettu Trading'] };
    await seed.query("update clients set profile = profile || $2::jsonb, legal_names = $3 where id=$1", [b.clientId, JSON.stringify(intake),
      deriveClientIdentityColumns({ companyName: 'Kettu Lantern Works', ...intake }).legalNames]);
    assert.deepEqual((await seed.query('select legal_names from clients where id=$1', [b.clientId])).rows[0].legal_names,
      ['Kettu Lantern Works', 'Kettu Lanterns Wrong Oy', 'Kettu Trading']);
    const corrected = await request('member', `/clients/${b.clientId}/profile`, { firm_id: firmId, profile_patch: { legalName: 'Kettu Lanterns Oy' } });
    assert.equal(corrected.status, 200, JSON.stringify(corrected.body));
    const row = (await seed.query('select legal_names, profile from clients where id=$1', [b.clientId])).rows[0];
    assert.deepEqual(row.legal_names, ['Kettu Lantern Works', 'Kettu Lanterns Oy', 'Kettu Trading'], 'the wrong alias is gone, the trading name stays');
    assert.deepEqual(row.profile.legalNames, ['Kettu Lanterns Oy', 'Kettu Trading'], 'the list is what the profile says');
    assert.deepEqual(row.legal_names, deriveClientIdentityColumns({ companyName: 'Kettu Lantern Works', ...row.profile }).legalNames, 'one derivation');
    const audit = await lastProfileAudit(b.clientId);
    assert.deepEqual(audit.metadata.previous_values, { legalName: intake.legalName, legalNames: intake.legalNames }, 'the record alone can undo it');
    assert.deepEqual(audit.metadata.keys.sort(), ['legalName', 'legalNames']);
    assert.equal(audit.metadata.channel, undefined, 'a web write claims no channel');
    // A caller that states the list itself is taken at its word.
    const stated = await request('member', `/clients/${b.clientId}/profile`, { firm_id: firmId,
      profile_patch: { legalName: 'Kettu Lanterns Ab', legalNames: ['Kettu Lanterns Oy'] } });
    assert.equal(stated.status, 200, JSON.stringify(stated.body));
    assert.deepEqual((await seed.query('select profile from clients where id=$1', [b.clientId])).rows[0].profile.legalNames, ['Kettu Lanterns Oy']);
  });

  await t.test('5. reminder skips are counted apart from failures; an error fails the scheduled run', async () => {
    const FIRM = firmId;
    const topic = { version: 1, status: 'open', current_need: 'Please send the fuel receipt.', last_owner_message_at: '2026-01-01T00:00:00.000Z',
      last_donna_message_at: null, last_assessment: { outcome: 'defer_later', can_resolve: false, still_missing: ['receipt'], reason: 'owner_deferred_evidence' }, turns: [] };
    let n = 0;
    const seedClient = async (id) => {
      await seed.query("insert into clients(id,firm_id,company_name,profile) values($1,$2,$3,'{}'::jsonb)", [id, FIRM, `Synthetic ${id} Oy`]);
      await seed.query(`insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source,reason,set_by_actor_type,set_by_actor_id)
        values($1,$2,$3,'EVIDENCE_TOPIC_REMINDERS','canary','manual','synthetic audit gaps','firm_member','op')`, [`flag-rem-${++n}`, FIRM, id]);
    };
    const bind = (clientId, channel, address) => seed.query(`insert into client_whatsapp_bindings(id,firm_id,client_id,phone_e164,phone_hash,verified_set_by,opted_in_set_by,channel)
      values($1,$2,$3,$4,$5,'op','op',$6)`, [`bind-${clientId}`, FIRM, clientId, address, hashPhoneE164(address), channel]);
    const seedAsk = (id, clientId, needOverride = null) => seed.query(`insert into client_evidence_requests(id,firm_id,client_id,status,evidence_type,question,request_payload,audience,send_count,created_by)
      values($1,$2,$3,'open','supporting_document','Who was the 120 EUR transfer to?',$4::jsonb,'client',1,'ask_batch')`,
    [id, FIRM, clientId, JSON.stringify({ evidence_topic: needOverride ? { ...topic, current_need: needOverride } : topic })]);
    await seedClient('rem-unbound'); await seedAsk('ask-rem-unbound', 'rem-unbound');
    await seedClient('rem-telegram'); await bind('rem-telegram', 'telegram', '700000001'); await seedAsk('ask-rem-telegram', 'rem-telegram');
    await seedClient('rem-sensitive'); await bind('rem-sensitive', 'sms', '+15555550111');
    await seedAsk('ask-rem-sensitive', 'rem-sensitive', 'Please send the IBAN of the supplier.');
    await seedClient('rem-rejected'); await bind('rem-rejected', 'sms', '+15555550112'); await seedAsk('ask-rem-rejected', 'rem-rejected');
    await seedClient('rem-sent'); await bind('rem-sent', 'sms', '+15555550113'); await seedAsk('ask-rem-sent', 'rem-sent');
    const texts = [];
    const sweep = (stampReminder) => runEvidenceTopicReminderSweep({ firmId: FIRM, now: new Date().toISOString(), env: {}, deps: {
      sendSmsText: async ({ to, text }) => {
        texts.push({ to, text });
        return to === '+15555550112' ? { ok: false, reason: 'PROVIDER_REJECTED' } : { ok: true, id: `sms-${texts.length}` };
      },
      ...(stampReminder ? { stampReminder } : {})
    } });
    const stats = await sweep();
    assert.deepEqual(texts.map((m) => m.to).sort(), ['+15555550112', '+15555550113'], 'skips send nothing; what is sent does not change');
    assert.equal(stats.sent, 1, JSON.stringify(stats));
    assert.deepEqual([stats.unbound, stats.channel_off, stats.withheld_sensitive], [1, 1, 1], `each skip by name: ${JSON.stringify(stats)}`);
    assert.equal(stats.failed, 1, `only the provider's refusal is a failure: ${JSON.stringify(stats)}`);
    assert.equal(stats.errors, 0);
    assert.deepEqual(parseCronSummaryFailures({ evidence_topic_reminders: stats }), [],
      'skips and a provider refusal (which has its own failed ledger row) do not fail the scheduled run');
    const ledger = (await seed.query("select failure_reason from message_delivery_ledger where ask_id='ask-rem-rejected'")).rows;
    assert.deepEqual(ledger.map((r) => r.failure_reason), ['PROVIDER_REJECTED'], 'the refusal\'s own receipt');

    // A send that went but whose stamp was refused has no receipt of its own:
    // that is an error the scheduler must see.
    await seed.query("update client_evidence_requests set request_payload = jsonb_set(request_payload, '{evidence_topic,last_donna_message_at}', 'null') where id='ask-rem-sent'");
    texts.length = 0;
    const broken = await sweep(async () => { throw new Error('stamp refused (fixture)'); });
    assert.deepEqual([broken.sent, broken.failed, broken.errors], [0, 1, 1], JSON.stringify(broken));
    assert.deepEqual(broken.error_details, [{ evidence_request_id: 'ask-rem-sent', client_id: 'rem-sent', error: 'stamp refused (fixture)' }]);
    const failures = parseCronSummaryFailures({ evidence_topic_reminders: broken });
    assert.ok(failures.length >= 1 && failures.every((f) => f.task === 'evidence_topic_reminders'), JSON.stringify(failures));
    assert.match(failures[0].error, /stamp refused \(fixture\)/);
  });
});
