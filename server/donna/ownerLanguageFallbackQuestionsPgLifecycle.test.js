// The ask writer's own fallback questions (a document or transaction ask
// minted with no question) are written in the owner's language, read once
// from the client profile through preferredOwnerTemplateLanguage. English is
// byte-identical. Real PostgreSQL: the writer's real queries and upsert.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { __createClientEvidenceRequestWithClient } from './db/asks.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIRM = 'firm-ownerlang';

const bootScratchDatabase = async () => {
  const dbName = `donna_ownerlang_${Date.now().toString(36)}_${process.pid}`;
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  await admin.query(`create database "${dbName}"`);
  const scratchUrl = new URL(PG_URL);
  scratchUrl.pathname = `/${dbName}`;
  const seed = new pg.Client({ connectionString: scratchUrl.toString() });
  await seed.connect();
  const supabaseOnly = new Set(['010_evidence_object_storage.sql', '032_lock_down_public_rls.sql', '060_procountor_api_key.sql']);
  const files = (await readdir(path.join(ROOT, 'db', 'migrations'))).filter((file) => file.endsWith('.sql') && !supabaseOnly.has(file)).sort();
  for (const file of files) await seed.query(await readFile(path.join(ROOT, 'db', 'migrations', file), 'utf8'));
  await seed.query(`insert into firms (id, name, slug) values ($1, 'Synthetic Firm', 'synthetic-ownerlang-firm')`, [FIRM]);
  const stop = async () => {
    await seed.end().catch(() => {});
    await admin.query(`drop database if exists "${dbName}" with (force)`).catch(() => {});
    await admin.end().catch(() => {});
  };
  return { seed, stop };
};

const seedClient = async (seed, { clientId, profile }) => {
  await seed.query(`insert into clients (id, firm_id, company_name, profile) values ($1, $2, 'Synthetic Company', $3::jsonb)`, [clientId, FIRM, JSON.stringify(profile)]);
  await seed.query(`insert into transactions (id, firm_id, client_id, transaction_date, description, money_out, currency, payload)
    values ($1, $2, $3, '2026-02-16', 'KORTTIOSTO ESIMERKKI', 41.2, 'EUR', '{}'::jsonb)`, [`tx-${clientId}`, FIRM, clientId]);
  await seed.query(`insert into documents (id, firm_id, client_id, filename, document_type, parse_status, total_amount, currency, vendor_name, payload)
    values ($1, $2, $3, 'kuitti-0216.pdf', 'receipt', 'completed', 41.2, 'EUR', 'Esimerkki Kauppa Oy', '{}'::jsonb)`, [`doc-${clientId}`, FIRM, clientId]);
};

test('real PG: the writer\'s fallback document and transaction questions follow the owner language',
  { skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set' }, async () => {
    const { seed, stop } = await bootScratchDatabase();
    try {
      await seedClient(seed, { clientId: 'client-fi', profile: { jurisdiction: 'FI' } });
      await seedClient(seed, { clientId: 'client-gb', profile: { jurisdiction: 'GB' } });
      const mint = async (clientId, target) => (await __createClientEvidenceRequestWithClient({
        client: seed, firmId: FIRM, clientId, ...target, question: '', actorId: 'system', markTransactionNeedsClient: false
      })).question;
      assert.equal(await mint('client-gb', { documentId: 'doc-client-gb' }),
        'How was Esimerkki Kauppa Oy — kuitti-0216.pdf paid — cash, a personal card, or an account we should have a statement for?');
      assert.equal(await mint('client-gb', { transactionId: 'tx-client-gb' }),
        'Please confirm the business purpose and upload supporting evidence for KORTTIOSTO ESIMERKKI.');
      assert.equal(await mint('client-fi', { documentId: 'doc-client-fi' }),
        'Miten tämä tosite maksettiin (Esimerkki Kauppa Oy, kuitti-0216.pdf)? Käteisellä, omalla kortillasi vai tililtä, jonka tiliote meidän pitäisi saada?');
      assert.equal(await mint('client-fi', { transactionId: 'tx-client-fi' }),
        'Tapahtuma: KORTTIOSTO ESIMERKKI. Kerro, mihin yrityksesi tarpeeseen se liittyi, ja lähetä siitä kuitti tai muu tosite.');
    } finally {
      await stop();
    }
  });
