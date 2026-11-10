// A client's country lives in the authoritative `clients.jurisdiction` column
// (the country packs and statutory code read it). A Finnish client whose
// country is ONLY in that column — nothing in the profile JSON — is written
// to in Finnish on every owner path, through the one resolver
// (ownerLanguage.js). Precedence is unchanged: an explicit owner language
// wins, a non-Finnish client stays English, a profile-only country still
// works, and a column/profile conflict gives no country default (English).
// Real PostgreSQL, the real readers and writers; only the email provider is a
// capture. Synthetic data only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, getClientOwnerLanguageInDb } from './firmDb.js';
import { deliverEmailEvidenceAsksAfterSend } from './db/channels.js';
import { __createClientEvidenceRequestWithClient } from './db/asks.js';
import { buildAskDraftInput } from './askPipeline.js';
import { portalDefaultInterfaceLocale } from '../../src/i18n/portalInterfaceLocale.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
const FIRM = 'firm-ownerlang-column';

// clientId → [clients.jurisdiction column, profile language keys, expected owner language]
const CASES = Object.freeze({
  'c-column-fi': ['FI', {}, 'fi'],
  'c-column-fi-chose-en': ['FI', { locale: 'en-GB' }, 'en'],
  'c-column-gb': ['GB', {}, 'en'],
  'c-profile-fi': [null, { jurisdiction: 'FI' }, 'fi'],
  'c-conflict': ['FI', { jurisdiction: 'GB' }, 'en']
});

test('owner language reads the client\'s country from the authoritative jurisdiction column', { skip: !pgUrl && 'DONNA_PG_TEST_URL not set' }, async (t) => {
  const admin = new pg.Client({ connectionString: pgUrl }); await admin.connect();
  const name = `donna_ownerlang_col_${process.pid}_${Date.now()}`;
  await admin.query(`create database "${name}"`); const url = new URL(pgUrl); url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() }); const closed = [];
  pool.on('connect', c => closed.push(new Promise(resolve => c.once('end', resolve))));
  __setFirmDbPoolForTests(pool);
  t.after(async () => {
    __resetFirmDbPoolForTests();
    await pool.end(); await Promise.all(closed); await admin.query(`drop database "${name}" with (force)`); await admin.end();
  });
  await pool.query(`create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]); create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb);`);
  const migrations = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(f => f.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, migrations), 'utf8'));
  await pool.query("insert into firms(id,name,slug) values($1,'Example Accounting','ownerlang-column')", [FIRM]);

  let n = 0;
  for (const [id, [jurisdiction, languageKeys]] of Object.entries(CASES)) {
    const profile = { email: `${id}@example.test`, ...languageKeys };
    await pool.query('insert into clients(id,firm_id,company_name,jurisdiction,profile) values($1,$2,$3,$4,$5::jsonb)',
      [id, FIRM, `Synthetic ${id}`, jurisdiction, JSON.stringify(profile)]);
    await pool.query(`insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source,reason,set_by_actor_type,set_by_actor_id)
      values($1,$2,$3,'OWNER_EMAIL_ASKS','canary','manual','synthetic owner-language test','firm_member','op')`, [`flag-${++n}`, FIRM, id]);
    await pool.query(`insert into documents (id, firm_id, client_id, filename, document_type, parse_status, total_amount, currency, vendor_name, payload)
      values ($1, $2, $3, 'kuitti-0216.pdf', 'receipt', 'completed', 41.2, 'EUR', 'Esimerkki Kauppa Oy', '{}'::jsonb)`, [`doc-${id}`, FIRM, id]);
  }

  const client = await pool.connect();
  try {
  for (const [id, [, , expected]] of Object.entries(CASES)) {
    // 1. The code-side channels' reader (SMS, Telegram, WhatsApp inbound, reminders, parse summaries).
    assert.equal(await getClientOwnerLanguageInDb({ firmId: FIRM, clientId: id }), expected, `${id}: owner-channel reader`);

    // 2. The writer's own fallback question (a document ask minted with no question).
    const ask = await __createClientEvidenceRequestWithClient({
      client, firmId: FIRM, clientId: id, documentId: `doc-${id}`, question: '', actorId: 'system', markTransactionNeedsClient: false
    });
    assert.equal(ask.question.startsWith('Miten tämä tosite maksettiin'), expected === 'fi', `${id}: fallback question: ${ask.question}`);

    // 3. The owner email wrapper (subject and greeting), and the language on its ledger receipt.
    const sent = [];
    const result = await deliverEmailEvidenceAsksAfterSend({
      client, firmId: FIRM, clientId: id, evidenceRequestIds: [ask.id],
      deps: { deliverOwnerMessage: async (args) => { sent.push(args); return { ok: true, id: `rs-${id}` }; } }
    });
    assert.equal(result.sent, 1, `${id}: email delivered`);
    assert.match(sent[0].email.subject, expected === 'fi' ? /kirjanpidostasi/ : /about your books/, `${id}: email subject`);
    const receipt = (await client.query('select provider_payload from message_delivery_ledger where ask_id = $1', [ask.id])).rows[0];
    assert.equal(receipt.provider_payload.language, expected, `${id}: delivery receipt language`);
  }
  } finally {
    client.release();
  }

  // 4. The ask drafter: the language handed to the model, from the client
  //    projection the batch drafter builds (column carried as persisted_identity).
  for (const [id, [jurisdiction, languageKeys, expected]] of Object.entries(CASES)) {
    const profile = { email: `${id}@example.test`, ...languageKeys };
    const clientProfile = { ...profile, jurisdiction: profile.jurisdiction || jurisdiction || '', persisted_identity: { jurisdiction } };
    assert.equal(buildAskDraftInput({ clientProfile }).client.language, expected, `${id}: drafter language`);
    // 5. The portal's first-paint language from the firm snapshot's client shape.
    assert.equal(portalDefaultInterfaceLocale({ ...profile, id, persisted_identity: { jurisdiction } }), expected, `${id}: portal`);
  }
});
