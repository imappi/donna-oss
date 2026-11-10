#!/usr/bin/env node
// Load the Finnish demo company into a running local Donna (the quickstart in
// README.md, "Run Donna locally").
//
// Everything goes through the runtime's own HTTP routes, the same ones the
// web app calls, so the demo company is born exactly as one an operator
// creates by hand. No SQL is written here:
//   1. POST /api/donna/firms/first-run   mint the firm (only on an empty book)
//   2. POST /api/donna/firms/clients     create Kampaamo Kultalanka Oy
//   3. POST /api/donna/firms/documents/upload-url, PUT the signed URL,
//      POST /api/donna/firms/documents/register
//                                        upload the month's bank statement
//
// The company and its documents are the synthetic test pack
// data/evals/fixtures/fi-kultalanka-2025-02 (every name, business ID and
// IBAN in it is invented). The answer key (file 90) is never uploaded.
//
// Re-running is safe: an existing firm is kept (409 from first-run), an
// existing client is not re-created, and a document already on the client
// (same file name) is not uploaded again.
//
//   DONNA_ACCESS_TOKEN=... node scripts/load_finnish_demo.mjs [--all-documents]
//
// Env:
//   DONNA_ACCESS_TOKEN   required; the token the runtime was started with
//   DONNA_DESKTOP_PORT   runtime port (default 8787, loopback only)

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEMO_PACK_DIR = path.join(ROOT, 'data', 'evals', 'fixtures', 'fi-kultalanka-2025-02');
export const DEMO_CLIENT_ID = 'kampaamo-kultalanka-oy';
export const DEMO_STATEMENT_FILE = '01 OP Tiliote 02-2025.pdf';
// The pack's answer key. It holds the expected bookings, so it must never
// reach the book as evidence.
export const ANSWER_KEY_PREFIX = '90 ';

// Synthetic firm identity for the first-run mint. example.com is reserved
// for documentation (RFC 2606); no mail is sent from a local book.
export const DEMO_FIRM = Object.freeze({
  firm_name: 'Demo Tilitoimisto',
  owner_name: 'Demo Operator',
  owner_email: 'operator@example.com',
  jurisdiction: 'FI'
});

// The client profile, from the pack's own entity block (labels.json).
export const buildDemoClientProfile = (entity) => {
  if (!entity || entity.jurisdiction !== 'FI') {
    throw new Error('The demo pack entity must be a Finnish company.');
  }
  return {
    id: DEMO_CLIENT_ID,
    companyName: entity.company_name,
    legalName: entity.company_name,
    uen: entity.business_id,
    businessId: entity.business_id,
    vatNumber: entity.vat_id,
    vatRegistered: true,
    jurisdiction: 'FI',
    entityType: entity.entity_type,
    defaultCurrency: entity.currency,
    accountingBasis: entity.accounting_basis,
    fiscalYearEnd: '12-31'
  };
};

// The pack's source files, in pack order. The statement goes first; the
// answer key is never included.
export const listDemoDocuments = (files, { all = false } = {}) => {
  const sources = [...files]
    .filter((name) => name.toLowerCase().endsWith('.pdf'))
    .filter((name) => !name.startsWith(ANSWER_KEY_PREFIX))
    .sort();
  if (!sources.includes(DEMO_STATEMENT_FILE)) {
    throw new Error(`The demo pack is missing its bank statement (${DEMO_STATEMENT_FILE}).`);
  }
  return all ? sources : [DEMO_STATEMENT_FILE];
};

// The register call's document_type. The statement is declared as one, as
// the intake path does for a document it has read; anything else is left to
// the runtime's own router ('unknown').
export const demoDocumentType = (filename) => (filename === DEMO_STATEMENT_FILE ? 'bank_statement' : 'unknown');

export const demoDocumentId = (filename) =>
  `doc-${DEMO_CLIENT_ID}-${createHash('sha256').update(filename).digest('hex').slice(0, 12)}`;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// A small JSON client over the runtime's loopback port. `fetchFn` is
// injectable for tests.
export const createRuntimeClient = ({ baseUrl, accessToken, fetchFn = fetch }) => {
  const call = async (method, url, { body, headers = {}, auth = true } = {}) => {
    const response = await fetchFn(new URL(url, baseUrl), {
      method,
      headers: {
        ...(auth ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...headers
      },
      body
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: response.status, json, text };
  };
  return {
    get: (url, opts) => call('GET', url, opts),
    postJson: (url, payload) =>
      call('POST', url, { body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json' } }),
    put: (url, opts) => call('PUT', url, opts)
  };
};

const fail = (step, response) => {
  const detail = response?.json?.error || response?.text || `HTTP ${response?.status}`;
  const error = new Error(`${step} failed (HTTP ${response?.status}): ${String(detail).slice(0, 300)}`);
  error.status = response?.status;
  return error;
};

export const loadFinnishDemo = async ({
  client,
  packDir = DEMO_PACK_DIR,
  allDocuments = false,
  readFile = readFileSync,
  readDir = readdirSync,
  log = console.log
}) => {
  const health = await client.get('/api/donna/firms/health', { auth: false });
  if (health.status !== 200) throw fail('Reaching the runtime', health);
  if (!health.json?.database_configured) {
    throw new Error('The runtime has no database. Start it with `npm run local:runtime` first.');
  }

  // 1. The firm. 409 means a firm already exists on this book: keep it.
  const mint = await client.postJson('/api/donna/firms/first-run', DEMO_FIRM);
  if (mint.status === 201) {
    log(`[demo] firm created: ${mint.json.firm_id} (${DEMO_FIRM.jurisdiction}, ${mint.json.currency})`);
  } else if (mint.status === 409) {
    log('[demo] a firm already exists on this book; using it');
  } else if (mint.status === 403) {
    throw new Error('The runtime is not running as a local book (first-run refused). Start it with `npm run local:runtime`.');
  } else {
    throw fail('Creating the firm', mint);
  }

  const snapshotBefore = await client.get('/api/donna/firms/snapshot');
  if (snapshotBefore.status !== 200) throw fail('Reading the firm', snapshotBefore);
  const firmId = snapshotBefore.json?.firm?.id || null;

  // 2. The company.
  const labels = JSON.parse(readFile(path.join(packDir, 'labels.json'), 'utf8'));
  const profile = buildDemoClientProfile(labels.entity);
  const existingClient = (snapshotBefore.json?.clients || []).find((row) => row.id === DEMO_CLIENT_ID);
  if (existingClient) {
    log(`[demo] company already exists: ${profile.companyName}`);
  } else {
    const created = await client.postJson('/api/donna/firms/clients', {
      ...(firmId ? { firm_id: firmId } : {}),
      profile
    });
    if (created.status !== 200) throw fail('Creating the company', created);
    log(`[demo] company created: ${profile.companyName} (${profile.uen}, ${profile.entityType})`);
  }

  // 3. The documents.
  const snapshot = await client.get('/api/donna/firms/snapshot');
  if (snapshot.status !== 200) throw fail('Reading the firm', snapshot);
  const existingNames = new Set(
    (snapshot.json?.documents || [])
      .filter((doc) => doc.client_id === DEMO_CLIENT_ID)
      .map((doc) => doc.filename)
  );
  const files = listDemoDocuments(readDir(path.join(packDir, 'sources')), { all: allDocuments });
  const uploaded = [];
  for (const filename of files) {
    if (existingNames.has(filename)) {
      log(`[demo] already uploaded: ${filename}`);
      continue;
    }
    const bytes = readFile(path.join(packDir, 'sources', filename));
    const checksum = sha256(bytes);
    const signed = await client.postJson('/api/donna/firms/documents/upload-url', {
      ...(firmId ? { firm_id: firmId } : {}),
      client_id: DEMO_CLIENT_ID,
      filename,
      mime_type: 'application/pdf',
      size: bytes.length,
      checksum_sha256: checksum
    });
    if (signed.status !== 200) throw fail(`Preparing the upload of ${filename}`, signed);
    // The signed URL carries its own authority; no access token is sent.
    const put = await client.put(signed.json.signed_url, {
      auth: false,
      body: bytes,
      headers: { 'Content-Type': signed.json.content_type || 'application/pdf', 'x-upsert': 'false' }
    });
    if (put.status !== 200) throw fail(`Storing ${filename}`, put);
    const register = await client.postJson('/api/donna/firms/documents/register', {
      ...(firmId ? { firm_id: firmId } : {}),
      documents: [{
        id: demoDocumentId(filename),
        client_id: DEMO_CLIENT_ID,
        filename,
        document_type: demoDocumentType(filename),
        uploaded_at: Date.now(),
        source: 'firm_intake',
        storage_bucket: signed.json.bucket,
        storage_object_key: signed.json.key,
        checksum_sha256: checksum,
        file_storage: {
          mode: 'object_storage',
          provider: signed.json.provider,
          bucket: signed.json.bucket,
          key: signed.json.key,
          checksum_sha256: checksum,
          filename,
          mime_type: 'application/pdf',
          size: bytes.length,
          note: 'Synthetic demo pack fi-kultalanka-2025-02.'
        }
      }]
    });
    if (register.status !== 200) throw fail(`Registering ${filename}`, register);
    uploaded.push(filename);
    log(`[demo] uploaded: ${filename}`);
  }

  return { firmId, clientId: DEMO_CLIENT_ID, uploaded };
};

const isDirectRun = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isDirectRun) {
  const accessToken = String(process.env.DONNA_ACCESS_TOKEN || '').trim();
  if (!accessToken) {
    console.error('[demo] set DONNA_ACCESS_TOKEN to the token the runtime was started with.');
    process.exit(1);
  }
  const port = Number(process.env.DONNA_DESKTOP_PORT || 8787);
  const client = createRuntimeClient({ baseUrl: `http://127.0.0.1:${port}`, accessToken });
  loadFinnishDemo({ client, allDocuments: process.argv.includes('--all-documents') }).then(
    ({ uploaded }) => {
      console.log(`[demo] done; ${uploaded.length} document(s) uploaded. Open http://127.0.0.1:${process.env.DONNA_LOCAL_WEB_PORT || 5173}/firms`);
    },
    (error) => {
      const refused = error?.cause?.code === 'ECONNREFUSED';
      console.error(refused
        ? `[demo] nothing is listening on 127.0.0.1:${port}. Start the runtime with \`npm run local:runtime\` first.`
        : `[demo] ${error.message}`);
      process.exit(1);
    }
  );
}
