// S2 (design-donna-desktop-runtime-on.md Phase 2) — the plane seed:
// only-where-no-live-row, through the governed writer (supersede + insert +
// audit), firm metadata only-where-absent, and the createClientInDb hook
// host-gated + fail-closed so a seed failure rolls back onboarding.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DESKTOP_CLIENT_FLAG_SEEDS,
  DESKTOP_SEED_REASON,
  isDesktopHostEnv,
  seedDesktopClientPlaneRowsWithClient,
  backfillDesktopRuntimePlane
} from './hostPlaneSeed.js';
import { createClientInDb } from '../firmDb.js';
import { OPERATOR_CAPABILITY_FLAG_KEY } from '../operatorCapability.js';
import { assertStageAllowedForFlag } from '../clientConfig.js';
import {
  ENTITY_READINESS_ENROLLMENT_ACTION,
  ENTITY_READINESS_NEW_CLIENT_REASON
} from '../runtimeReadinessEnrollment.js';

// Recording mock in the firmDb.test.js style, programmable per-query.
const makeSeedClient = ({
  existingFlagRows = [],
  firmMetadata = {},
  firms = [{ id: 'firm-1' }],
  clients = [{ id: 'client-1' }],
  existingClientRows = [],
  throwOnConfigInsert = false
} = {}) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      const text = String(sql);
      calls.push({ sql: text, params });
      if (text.includes('select flag_key from client_capability_config')) {
        return { rows: existingFlagRows };
      }
      if (text.includes('insert into client_capability_config') && throwOnConfigInsert) {
        throw new Error('config insert refused (test)');
      }
      if (text.includes('select metadata from firms')) {
        return { rows: [{ metadata: firmMetadata }] };
      }
      if (text.includes('select id from firms')) return { rows: firms };
      if (text.includes('select id from clients where firm_id')) return { rows: clients };
      if (text.includes('select entity_type')) return { rows: existingClientRows };
      if (text.includes('insert into clients')) return { rows: [{ id: 'client-1', firm_id: 'firm-1' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
  };
};

const configInserts = (client) =>
  client.calls.filter((c) => c.sql.includes('insert into client_capability_config'));

test('isDesktopHostEnv keys off DONNA_DESKTOP_BLOB_DIR', () => {
  assert.equal(isDesktopHostEnv({ DONNA_DESKTOP_BLOB_DIR: '/tmp/blobs' }), true);
  assert.equal(isDesktopHostEnv({}), false);
  assert.equal(isDesktopHostEnv({ DONNA_DESKTOP_BLOB_DIR: '' }), false);
});

test('seed inserts every seed key at auto/default with the desktop reason', async () => {
  const client = makeSeedClient();
  const applied = await seedDesktopClientPlaneRowsWithClient(client, {
    firmId: 'firm-1',
    clientId: 'client-1'
  });
  assert.deepEqual(applied, [...DESKTOP_CLIENT_FLAG_SEEDS]);
  const inserts = configInserts(client);
  assert.equal(inserts.length, DESKTOP_CLIENT_FLAG_SEEDS.length);
  for (const insert of inserts) {
    assert.equal(insert.params[4], 'auto', 'stage');
    assert.equal(insert.params[5], 'default', 'source');
    assert.equal(insert.params[6], DESKTOP_SEED_REASON, 'reason');
  }
  // The governed writer audits each row in the same transaction.
  const audits = client.calls.filter((c) => c.sql.includes('client_config.stage_set'));
  assert.equal(audits.length, DESKTOP_CLIENT_FLAG_SEEDS.length);
});

test('capability enforcement is a desktop seed and stays persistable at auto (G2 PR-17)', () => {
  assert.ok(
    DESKTOP_CLIENT_FLAG_SEEDS.includes(OPERATOR_CAPABILITY_FLAG_KEY),
    'OPERATOR_CAPABILITY_ENFORCE must be seeded — enforcement is the desktop default posture'
  );
  // The seed writes 'auto' through the governed writer, which refuses
  // AUTO_FORBIDDEN / shadow-ceilinged flags. If this flag ever joins one of
  // those sets the desktop seed would start failing at boot — catch the
  // contradiction here, at CI time, instead.
  assert.doesNotThrow(() => assertStageAllowedForFlag(OPERATOR_CAPABILITY_FLAG_KEY, 'auto'));
});

test('client reset re-arms both ask-settling protections on desktop', () => {
  for (const flagKey of ['RECONCILIATION_ASK_QUIESCENCE_GATE', 'ASK_SEND_SETTLE_GATE']) {
    assert.ok(
      DESKTOP_CLIENT_FLAG_SEEDS.includes(flagKey),
      `${flagKey} must survive delete/recreate through the desktop baseline seed`
    );
    assert.doesNotThrow(() => assertStageAllowedForFlag(flagKey, 'auto'));
  }
});

test('client reset re-arms the jurisdiction account palette on desktop', () => {
  const flagKey = 'JURISDICTION_ACCOUNT_PALETTE';
  assert.ok(
    DESKTOP_CLIENT_FLAG_SEEDS.includes(flagKey),
    'a recreated client must not fall back to the legacy Singapore-flavoured coding enum'
  );
  assert.doesNotThrow(() => assertStageAllowedForFlag(flagKey, 'auto'));
});

test('client reset re-arms structured bank-statement extraction on desktop', () => {
  const flagKey = 'BANK_STATEMENT_LLM_EXTRACTION';
  assert.ok(
    DESKTOP_CLIENT_FLAG_SEEDS.includes(flagKey),
    'a recreated client must not fall back to regex-first bank-statement extraction'
  );
  assert.doesNotThrow(() => assertStageAllowedForFlag(flagKey, 'auto'));
});

test('client reset re-arms ask lifecycle honesty on desktop (RT-11: D2 material auto-FYI, D4 auto-explain retraction, the retraction lane)', () => {
  for (const flagKey of ['RECONCILIATION_MATERIAL_AUTO_FYI', 'RECONCILE_AUTO_EXPLAIN_RETRACTS', 'RECONCILE_RETRACTION_AUTOSEND']) {
    assert.ok(
      DESKTOP_CLIENT_FLAG_SEEDS.includes(flagKey),
      `${flagKey} must be born with the owner shell — a fresh client's material matches and stale asks are otherwise dishonest from the first close`
    );
    assert.doesNotThrow(() => assertStageAllowedForFlag(flagKey, 'auto'));
  }
});

test('seed skips keys with a live row — an explicit off is a decision', async () => {
  const client = makeSeedClient({ existingFlagRows: [{ flag_key: 'CODING_AUTO_POST' }] });
  const applied = await seedDesktopClientPlaneRowsWithClient(client, {
    firmId: 'firm-1',
    clientId: 'client-1'
  });
  assert.ok(!applied.includes('CODING_AUTO_POST'));
  assert.equal(applied.length, DESKTOP_CLIENT_FLAG_SEEDS.length - 1);
  const touched = configInserts(client).map((c) => c.params[3]);
  assert.ok(!touched.includes('CODING_AUTO_POST'), 'no supersede of the existing decision');
});

test('backfill seeds every client of every firm + firm metadata in one transaction', async () => {
  const client = makeSeedClient({ clients: [{ id: 'c1' }, { id: 'c2' }] });
  const result = await backfillDesktopRuntimePlane({
    withFirmDbClientFn: (fn) => fn(client),
    logger: { log: () => {} }
  });
  assert.equal(result.clientRows, DESKTOP_CLIENT_FLAG_SEEDS.length * 2);
  assert.equal(result.clientCount, 2);
  assert.deepEqual(result.firmMetadata, [
    'auto_explain.sales_invoice_enabled',
    'auto_explain.supplier_bill_enabled',
    'loops.tier'
  ]);
  const update = client.calls.find((c) => c.sql.includes('update firms set metadata'));
  assert.ok(update, 'firms metadata written');
  const metadata = JSON.parse(update.params[1]);
  assert.equal(metadata.auto_explain.sales_invoice_enabled, true);
  assert.equal(metadata.auto_explain.supplier_bill_enabled, true);
  assert.equal(metadata.loops.tier, 'canary');
  assert.ok(client.calls.find((c) => c.sql.includes('firm.metadata.desktop_seed')), 'seed audited');
  assert.ok(client.calls.some((c) => c.sql === 'commit'), 'committed');
});

test('backfill preserves existing firm-metadata decisions, including false', async () => {
  const client = makeSeedClient({
    firmMetadata: {
      auto_explain: { sales_invoice_enabled: false, confidence_floor: 0.9 },
      loops: { tier: 'shadow', auto_send_client_asks: false }
    },
    clients: []
  });
  const result = await backfillDesktopRuntimePlane({
    withFirmDbClientFn: (fn) => fn(client),
    logger: { log: () => {} }
  });
  assert.deepEqual(result.firmMetadata, ['auto_explain.supplier_bill_enabled']);
  const metadata = JSON.parse(client.calls.find((c) => c.sql.includes('update firms set metadata')).params[1]);
  assert.equal(metadata.auto_explain.sales_invoice_enabled, false, 'explicit false preserved');
  assert.equal(metadata.auto_explain.confidence_floor, 0.9, 'sibling keys preserved');
  assert.equal(metadata.loops.tier, 'shadow', 'existing tier preserved');
  assert.equal(metadata.loops.auto_send_client_asks, false, 'sibling loops keys preserved');
});

test('backfill with nothing missing writes nothing and reports it', async () => {
  const client = makeSeedClient({
    existingFlagRows: DESKTOP_CLIENT_FLAG_SEEDS.map((flag_key) => ({ flag_key })),
    firmMetadata: {
      auto_explain: { sales_invoice_enabled: true, supplier_bill_enabled: true },
      loops: { tier: 'canary' }
    }
  });
  const result = await backfillDesktopRuntimePlane({
    withFirmDbClientFn: (fn) => fn(client),
    logger: { log: () => {} }
  });
  assert.equal(result.clientRows, 0);
  assert.deepEqual(result.firmMetadata, []);
  assert.ok(!client.calls.find((c) => c.sql.includes('update firms set metadata')), 'no metadata write');
  assert.equal(configInserts(client).length, 0, 'no flag writes');
});

// ── the createClientInDb hook ──────────────────────────────────────────

const withDesktopEnv = async (fn) => {
  const prior = process.env.DONNA_DESKTOP_BLOB_DIR;
  process.env.DONNA_DESKTOP_BLOB_DIR = '/tmp/donna-test-blobs';
  try {
    return await fn();
  } finally {
    if (prior === undefined) delete process.env.DONNA_DESKTOP_BLOB_DIR;
    else process.env.DONNA_DESKTOP_BLOB_DIR = prior;
  }
};

test('createClientInDb on the desktop host seeds plane rows in the create transaction', async () => {
  await withDesktopEnv(async () => {
    const client = makeSeedClient();
    const created = await createClientInDb({
      firmId: 'firm-1',
      dbClient: client,
      profile: { id: 'client-1', companyName: 'Honeybee Hills Apiary LLC' }
    });
    assert.equal(created.created, true, 'a fresh row reports created for the birth-scope decision');
    assert.equal(configInserts(client).length, DESKTOP_CLIENT_FLAG_SEEDS.length + 1);
    const readiness = configInserts(client).find(({ params }) => params[3] === 'ENTITY_READINESS_ADMISSION');
    assert.ok(readiness, 'new desktop client receives the client-specific readiness canary');
    assert.equal(readiness.params[4], 'canary');
    assert.equal(readiness.params[5], 'default');
    assert.equal(readiness.params[6], ENTITY_READINESS_NEW_CLIENT_REASON);
    assert.ok(
      client.calls.find(({ params }) => params?.[2] === ENTITY_READINESS_ENROLLMENT_ACTION),
      'new-client enrollment carries its own dated receipt'
    );
    assert.ok(client.calls.find((c) => c.sql.includes("'client.create'")), 'create audited');
    assert.ok(client.calls.some((c) => c.sql === 'commit'), 'committed');
  });
});

test('an existing desktop client upsert keeps legacy readiness posture', async () => {
  await withDesktopEnv(async () => {
    const client = makeSeedClient({
      existingClientRows: [{
        entity_type: 'gb-ltd', firm_id: 'firm-1', accounting_system: 'none'
      }]
    });
    const upserted = await createClientInDb({
      firmId: 'firm-1',
      dbClient: client,
      profile: { id: 'client-1', companyName: 'Existing Client Ltd', jurisdiction: 'GB', entityType: 'gb-ltd' }
    });
    assert.equal(upserted.created, false, 'an idempotent upsert reports not-created so provisioning skips birth scope');
    assert.equal(
      configInserts(client).some(({ params }) => params[3] === 'ENTITY_READINESS_ADMISSION'),
      false,
      'an idempotent upsert is not a new-client graduation event'
    );
  });
});

test('createClientInDb off the desktop host issues no plane writes', async () => {
  const prior = process.env.DONNA_DESKTOP_BLOB_DIR;
  delete process.env.DONNA_DESKTOP_BLOB_DIR;
  try {
    const client = makeSeedClient();
    await createClientInDb({
      firmId: 'firm-1',
      dbClient: client,
      profile: { id: 'client-1', companyName: 'Cloud Client Ltd' }
    });
    assert.ok(
      !client.calls.find((c) => c.sql.includes('client_capability_config')),
      'cloud path untouched'
    );
  } finally {
    if (prior !== undefined) process.env.DONNA_DESKTOP_BLOB_DIR = prior;
  }
});

test('a seed failure aborts and rolls back the whole client create', async () => {
  await withDesktopEnv(async () => {
    const client = makeSeedClient({ throwOnConfigInsert: true });
    const priorError = console.error;
    console.error = () => {};
    try {
      await assert.rejects(
        createClientInDb({
          firmId: 'firm-1',
          dbClient: client,
          profile: { id: 'client-1', companyName: 'Honeybee Hills Apiary LLC' }
        }),
        (error) => {
          assert.equal(error?.statusCode, 503);
          assert.equal(error?.code, 'CLIENT_RUNTIME_INITIALIZATION_FAILED');
          assert.deepEqual(error?.details, {
            stage: 'desktop_client_plane_seed',
            client_id: 'client-1',
            retryable: true
          });
          assert.match(error?.cause?.message || '', /config insert refused/);
          return true;
        }
      );
    } finally {
      console.error = priorError;
    }
    assert.ok(client.calls.some((c) => c.sql === 'rollback'), 'whole create transaction rolled back');
    assert.ok(
      !client.calls.some((c) => c.sql.includes('savepoint desktop_plane_seed')),
      'load-bearing seed is not isolated from the create transaction'
    );
    assert.ok(!client.calls.some((c) => c.sql === 'commit'), 'failed create never committed');
    assert.ok(!client.calls.find((c) => c.sql.includes("'client.create'")), 'no success audit on failure');
  });
});

test('backfill runs the injected chart seed per client, in the same transaction, and counts it', async () => {
  const client = makeSeedClient({ clients: [{ id: 'c1' }, { id: 'c2' }] });
  const seen = [];
  const result = await backfillDesktopRuntimePlane({
    withFirmDbClientFn: (fn) => fn(client),
    logger: { log: () => {} },
    seedChartFn: async (dbClient, { firmId, clientId }) => {
      assert.equal(dbClient, client, 'same connection/transaction as the flag seed');
      seen.push(`${firmId}/${clientId}`);
      return { seeded: true, inserted: ['Rent', 'Sales'], filled: clientId === 'c2' ? ['Motor expenses'] : [] };
    }
  });
  assert.deepEqual(seen, ['firm-1/c1', 'firm-1/c2']);
  assert.equal(result.chartAccounts, 5);
  const commitIndex = client.calls.findIndex((c) => c.sql === 'commit');
  assert.ok(commitIndex > 0, 'committed after the seeds');
  // Absent ⇒ byte-identical to the flag-only backfill.
  const plain = makeSeedClient();
  const noChart = await backfillDesktopRuntimePlane({ withFirmDbClientFn: (fn) => fn(plain), logger: { log: () => {} } });
  assert.equal(noChart.chartAccounts, 0);
});

// ── DMEM-R1 W2: dark plane extensions are declared, never seeded ─────────────

test('DESKTOP_DARK_PLANE_EXTENSIONS: MEMORY_MODEL_V2 is born off (no row) — disjoint from the auto seeds and declared as an admitted extension in lock-step', async () => {
  const { readFileSync } = await import('node:fs');
  const { DESKTOP_DARK_PLANE_EXTENSIONS } = await import('./hostPlaneSeed.js');
  assert.deepEqual([...DESKTOP_DARK_PLANE_EXTENSIONS], ['MEMORY_MODEL_V2']);
  for (const key of DESKTOP_DARK_PLANE_EXTENSIONS) {
    assert.ok(!DESKTOP_CLIENT_FLAG_SEEDS.includes(key), `${key} is never an auto seed`);
  }
  const manifest = JSON.parse(readFileSync(new URL('../../../data/worlds/admitted-entity-profiles.json', import.meta.url), 'utf8'));
  const extensions = manifest.capability_manifests['desktop-runtime.v2'].admitted_extensions;
  for (const key of DESKTOP_DARK_PLANE_EXTENSIONS) {
    const declared = extensions.find((row) => row.flag_key === key);
    assert.ok(declared, `${key} is declared in admitted_extensions`);
    assert.deepEqual(declared.allowed_stages, ['off', 'dry_run', 'shadow', 'canary'], 'authoritative (auto) waits for W6A');
    assert.deepEqual(declared.allowed_sources, ['default', 'manual']);
    assert.equal(declared.reason_required, true);
  }
  // The seed writes nothing for it: a fresh client's rows are exactly the auto seeds.
  const client = makeSeedClient();
  const applied = await seedDesktopClientPlaneRowsWithClient(client, { firmId: 'firm-1', clientId: 'client-1' });
  assert.ok(!applied.includes('MEMORY_MODEL_V2'));
  assert.ok(!configInserts(client).some((insert) => insert.params[3] === 'MEMORY_MODEL_V2'));
});
