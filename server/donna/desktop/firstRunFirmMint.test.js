// Gate 3 first-run firm mint — unit coverage for the orchestration (host
// guard, zero-firms guard, transaction shape, id derivation, validation)
// with stubbed DB deps, per the selfProvisionDb.test.js pattern. The raw
// SQL is exercised live by the Gate 3 acceptance run on the appliance.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FIRST_RUN_JURISDICTIONS,
  FirstRunAlreadyProvisionedError,
  FirstRunNotDesktopError,
  FirstRunValidationError,
  mintFirstRunFirm,
  normalizeFirstRunInput,
  resolveClientCreateFirmId,
  slugifyFirmName
} from './firstRunFirmMint.js';

const validBody = {
  firm_name: 'Meadow Ledger Oy',
  owner_name: 'Kari',
  owner_email: 'Kari@Books.example',
  jurisdiction: 'gb'
};

// A stub pg client capturing queries; `firmRows` controls the zero-firms probe.
const makeClient = ({ firmRows = [] } = {}) => {
  const queries = [];
  return {
    queries,
    query: async (text, params = []) => {
      queries.push({ text: String(text).replace(/\s+/g, ' ').trim(), params });
      if (/select id from firms/.test(text)) return { rows: firmRows };
      return { rows: [] };
    }
  };
};

const makeDeps = ({ firmRows = [], desktop = true, seeded = ['loops.tier'] } = {}) => {
  const client = makeClient({ firmRows });
  const seedCalls = [];
  return {
    client,
    seedCalls,
    deps: {
      withFirmDbClientFn: (fn) => fn(client),
      isDesktopHost: () => desktop,
      seedFirmMetadata: async (_c, args) => {
        seedCalls.push(args);
        return seeded;
      }
    }
  };
};

test('normalize: happy path derives currency, slug, lowercased email', () => {
  const input = normalizeFirstRunInput(validBody);
  assert.equal(input.firmName, 'Meadow Ledger Oy');
  assert.equal(input.ownerEmail, 'kari@books.example');
  assert.equal(input.jurisdiction, 'GB');
  assert.equal(input.currency, 'GBP', 'currency derived from jurisdiction');
  assert.equal(input.slug, 'meadow-ledger-oy');
});

test('normalize: explicit currency override wins; camelCase keys accepted', () => {
  const input = normalizeFirstRunInput({
    firmName: 'Apiary Co', ownerName: 'J', ownerEmail: 'j@x-io.example',
    jurisdiction: 'SG', currency: 'usd'
  });
  assert.equal(input.currency, 'USD');
});

test('normalize: every jurisdiction in the map has a 3-letter default currency', () => {
  for (const [code, currency] of Object.entries(FIRST_RUN_JURISDICTIONS)) {
    assert.match(code, /^[A-Z]{2}$/);
    assert.match(currency, /^[A-Z]{3}$/);
  }
});

test('normalize: rejections are typed 400s', () => {
  const cases = [
    { ...validBody, firm_name: '  ' },
    { ...validBody, owner_name: '' },
    { ...validBody, owner_email: 'not-an-email' },
    { ...validBody, jurisdiction: 'DE' },
    { ...validBody, firm_name: '§§§' }
  ];
  for (const body of cases) {
    assert.throws(() => normalizeFirstRunInput(body), FirstRunValidationError);
  }
  try {
    normalizeFirstRunInput({ ...validBody, jurisdiction: 'DE' });
  } catch (e) {
    assert.equal(e.statusCode, 400);
  }
});

test('slugify: diacritics fold, punctuation collapses, length capped', () => {
  assert.equal(slugifyFirmName('Kärkkäinen & Söner AB'), 'karkkainen-soner-ab');
  assert.equal(slugifyFirmName('  --  '), '');
  assert.ok(slugifyFirmName('x'.repeat(100)).length <= 48);
});

test('mint: refuses off-desktop with a typed 403 before touching the DB', async () => {
  const { deps, client } = makeDeps({ desktop: false });
  await assert.rejects(
    () => mintFirstRunFirm({ input: normalizeFirstRunInput(validBody), deps }),
    FirstRunNotDesktopError
  );
  assert.equal(client.queries.length, 0, 'no DB traffic off-desktop');
});

test('mint: refuses with 409 when any firm exists, and rolls back', async () => {
  const { deps, client } = makeDeps({ firmRows: [{ id: 'firm-existing' }] });
  await assert.rejects(
    () => mintFirstRunFirm({ input: normalizeFirstRunInput(validBody), deps }),
    (e) => e instanceof FirstRunAlreadyProvisionedError && e.statusCode === 409 && e.firmId === 'firm-existing'
  );
  const texts = client.queries.map((q) => q.text);
  assert.ok(texts.includes('rollback'), 'transaction ended');
  assert.ok(!texts.some((t) => t.startsWith('insert into firms')), 'nothing inserted');
});

test('mint: happy path — firm, member, audit, metadata seed, commit, deterministic ids', async () => {
  const { deps, client, seedCalls } = makeDeps({});
  const result = await mintFirstRunFirm({ input: normalizeFirstRunInput(validBody), deps });

  assert.equal(result.firmId, 'firm-meadow-ledger-oy');
  assert.equal(result.memberId, 'member-kari');
  assert.deepEqual(result.seeded, ['loops.tier']);

  const texts = client.queries.map((q) => q.text);
  assert.equal(texts[0], 'begin');
  assert.equal(texts.at(-1), 'commit');
  assert.ok(!texts.includes('rollback'));

  const firmInsert = client.queries.find((q) => q.text.startsWith('insert into firms'));
  assert.deepEqual(firmInsert.params.slice(0, 5), [
    'firm-meadow-ledger-oy', 'Meadow Ledger Oy', 'meadow-ledger-oy', 'GB', 'GBP'
  ]);
  assert.equal(JSON.parse(firmInsert.params[5]).created_via, 'desktop_first_run');

  const memberInsert = client.queries.find((q) => q.text.startsWith('insert into firm_members'));
  assert.deepEqual(memberInsert.params.slice(0, 4), [
    'member-kari', 'firm-meadow-ledger-oy', 'kari@books.example', 'Kari'
  ]);
  assert.match(memberInsert.text, /'admin', 'active', 'owner'/);

  const audit = client.queries.find((q) => q.text.startsWith('insert into audit_events'));
  assert.equal(audit.params[1], 'kari@books.example', 'actor is the real owner email');
  assert.equal(JSON.parse(audit.params[2]).member_id, 'member-kari');
  assert.match(audit.text, /firm\.first_run_minted/);

  assert.deepEqual(seedCalls, [{ firmId: 'firm-meadow-ledger-oy' }], 'firm metadata seeded in-transaction');

  // Ordering: audit + seed happen BEFORE commit (audit-as-precondition shape).
  const commitIdx = texts.indexOf('commit');
  const auditIdx = client.queries.findIndex((q) => q.text.startsWith('insert into audit_events'));
  assert.ok(auditIdx < commitIdx);
});

test('mint: a failed insert rolls back and rethrows', async () => {
  const { deps, client } = makeDeps({});
  client.query = async (text) => {
    if (/insert into firm_members/.test(text)) throw new Error('boom');
    client.queries.push({ text: String(text).replace(/\s+/g, ' ').trim() });
    if (/select id from firms/.test(text)) return { rows: [] };
    return { rows: [] };
  };
  const origPush = client.queries;
  await assert.rejects(
    () => mintFirstRunFirm({ input: normalizeFirstRunInput(validBody), deps }),
    /boom/
  );
  assert.ok(origPush.some((q) => q.text === 'rollback'));
});

test('resolveClientCreateFirmId: request > configured > sole firm > null', () => {
  assert.equal(
    resolveClientCreateFirmId({ requestedFirmId: 'firm-x', configuredFirmId: 'firm-c', firmRows: [{ id: 'firm-a' }] }),
    'firm-x'
  );
  assert.equal(
    resolveClientCreateFirmId({ configuredFirmId: 'firm-c', firmRows: [{ id: 'firm-a' }] }),
    'firm-c'
  );
  assert.equal(resolveClientCreateFirmId({ firmRows: [{ id: 'firm-a' }] }), 'firm-a');
  assert.equal(resolveClientCreateFirmId({ firmRows: [] }), null, 'zero firms → caller default');
  assert.equal(
    resolveClientCreateFirmId({ firmRows: [{ id: 'a' }, { id: 'b' }] }),
    null,
    'multi-firm → never guess'
  );
});

// adoptResolvedDefaultFirmId — the live-binding re-point (firmDb.js). Gated
// on the desktop host env and on the absence of an explicit env config;
// tested here (not in a firmDb test) because it is Gate 3 machinery.

import { DEFAULT_FIRM_ID, adoptResolvedDefaultFirmId } from '../firmDb.js';

test('adopt: refuses off-desktop and under explicit env config; applies on the appliance', () => {
  const quiet = { log: () => {} };
  const before = DEFAULT_FIRM_ID;

  delete process.env.DONNA_DESKTOP_BLOB_DIR;
  assert.equal(adoptResolvedDefaultFirmId('firm-nope', { logger: quiet }), before, 'no-op off-desktop');

  process.env.DONNA_DESKTOP_BLOB_DIR = '/tmp/x';
  process.env.DONNA_DEFAULT_FIRM_ID = 'firm-configured';
  assert.equal(adoptResolvedDefaultFirmId('firm-nope', { logger: quiet }), before, 'explicit config wins');
  delete process.env.DONNA_DEFAULT_FIRM_ID;

  assert.equal(adoptResolvedDefaultFirmId('', { logger: quiet }), before, 'empty id is a no-op');
  const adopted = adoptResolvedDefaultFirmId('firm-real', { logger: quiet });
  assert.equal(adopted, 'firm-real');
  delete process.env.DONNA_DESKTOP_BLOB_DIR;
});
