import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_FIRM_ID, withFirmDbClient } from '../server/donna/firmDb.js';

const firmId = process.env.DONNA_RESET_FIRM_ID || DEFAULT_FIRM_ID;
const actorId = process.env.DONNA_RESET_ACTOR_ID || 'codex-fresh-onboarding-reset';
const requiredFlag = `fresh-onboarding:${firmId}`;
const destructiveFlag = process.env.DONNA_ALLOW_DESTRUCTIVE_RESET || '';
const dryRun = process.env.DONNA_RESET_DRY_RUN === '1' || process.argv.includes('--dry-run');
const backupRoot = process.env.DONNA_RESET_BACKUP_DIR || path.join(process.cwd(), 'backups', 'fresh-onboarding-reset');

const targetTables = [
  'audit_events',
  'close_checks',
  'close_periods',
  'close_archives',
  'ledger_lines',
  'ledger_journals',
  'ledger_accounts',
  'client_evidence_requests',
  'xero_sync_runs',
  'xero_accounts',
  'xero_contacts',
  'xero_connections',
  'reconciliation_matches',
  'transaction_review_queue',
  'client_rules',
  'merchant_aliases',
  'merchants',
  'document_lines',
  'transactions',
  'documents',
  'accounting_rules',
  'queue_items',
  'history_items',
  'client_assignments',
  'clients'
];

const deleteOrder = [
  'close_checks',
  'close_archives',
  'close_periods',
  'ledger_lines',
  'ledger_journals',
  'ledger_accounts',
  'client_evidence_requests',
  'xero_sync_runs',
  'xero_accounts',
  'xero_contacts',
  'xero_connections',
  'reconciliation_matches',
  'transaction_review_queue',
  'client_rules',
  'merchant_aliases',
  'merchants',
  'document_lines',
  'transactions',
  'documents',
  'accounting_rules',
  'queue_items',
  'history_items',
  'client_assignments',
  'clients',
  'audit_events'
];

const log = (step, payload = {}) => {
  console.log(JSON.stringify({ step, ...payload }));
};

const cleanEnv = (value = '') => String(value || '').trim().replace(/^['"]|['"]$/g, '');

const readDotEnv = () => {
  const vars = {};
  try {
    const envPath = path.join(process.cwd(), '.env');
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
        const match = line.match(/^(\w+)=(.*)$/);
        if (match) vars[match[1]] = match[2].trim();
      }
    }
  } catch { /* best-effort reset guard */ }
  return vars;
};

const storageConfig = () => {
  const dotEnv = readDotEnv();
  const supabaseUrl = cleanEnv(
    process.env.SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL ||
    dotEnv.SUPABASE_URL ||
    dotEnv.VITE_SUPABASE_URL ||
    ''
  ).replace(/\/+$/, '');
  const serviceKey = cleanEnv(
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    dotEnv.SUPABASE_SERVICE_ROLE_KEY ||
    dotEnv.SUPABASE_SERVICE_KEY ||
    dotEnv.SUPABASE_SECRET_KEY ||
    ''
  );
  return { supabaseUrl, serviceKey };
};

const optionalQuery = async (client, sql, params = []) => {
  try {
    return await client.query(sql, params);
  } catch (error) {
    if (error?.code === '42P01' || error?.code === '42703') return { rows: [], rowCount: 0, missing: true };
    throw error;
  }
};

const deleteEvidenceStorageObjects = async (objects = []) => {
  const objectNames = [...new Set(objects.map((object) => object?.name).filter(Boolean))];
  if (!objectNames.length) return { deleted: 0, chunks: 0 };

  const { supabaseUrl, serviceKey } = storageConfig();
  if (!supabaseUrl || !serviceKey) {
    const error = new Error('Supabase service-role storage credentials are required before wiping evidence objects.');
    error.code = 'EVIDENCE_STORAGE_SERVICE_KEY_REQUIRED';
    throw error;
  }

  let deleted = 0;
  let chunks = 0;
  const bucket = process.env.DONNA_EVIDENCE_BUCKET || process.env.SUPABASE_EVIDENCE_BUCKET || 'donna-evidence';
  for (let index = 0; index < objectNames.length; index += 100) {
    const prefixes = objectNames.slice(index, index + 100);
    const response = await fetch(`${supabaseUrl}/storage/v1/object/${encodeURIComponent(bucket)}`, {
      method: 'DELETE',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ prefixes })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body?.message || `Evidence storage delete failed with ${response.status}.`);
      error.code = 'EVIDENCE_STORAGE_DELETE_FAILED';
      error.details = { status: response.status, body, bucket, prefixes };
      throw error;
    }
    deleted += Array.isArray(body) ? body.length : prefixes.length;
    chunks += 1;
  }
  return { deleted, chunks };
};

const rowsForBackup = async (client, table) => {
  const result = await optionalQuery(client, `select * from ${table} where firm_id = $1 order by 1`, [firmId]);
  return result.rows || [];
};

const buildBackup = async () => {
  const generatedAt = new Date().toISOString();
  const backup = await withFirmDbClient(async (client) => {
    const firmResult = await optionalQuery(client, 'select * from firms where id = $1', [firmId]);
    const membersResult = await optionalQuery(client, 'select * from firm_members where firm_id = $1 order by email', [firmId]);
    const collaboratorsResult = await optionalQuery(client, 'select * from firm_collaborators where firm_id = $1 order by email', [firmId]);
    const tables = {};
    const counts = {};
    for (const table of targetTables) {
      const rows = await rowsForBackup(client, table);
      tables[table] = rows;
      counts[table] = rows.length;
    }
    const storageObjectsResult = await optionalQuery(
      client,
      `select id, bucket_id, name, owner, created_at, updated_at, last_accessed_at, metadata
       from storage.objects
       where bucket_id = 'donna-evidence'
       order by created_at nulls last, name`
    );
    return {
      source: 'donna_fresh_onboarding_reset_backup',
      generated_at: generatedAt,
      firm_id: firmId,
      dry_run: dryRun,
      preserve: {
        firms: firmResult.rows || [],
        firm_members: membersResult.rows || [],
        firm_collaborators: collaboratorsResult.rows || []
      },
      counts,
      tables,
      storage: {
        bucket_id: 'donna-evidence',
        objects: storageObjectsResult.rows || []
      }
    };
  });

  await mkdir(backupRoot, { recursive: true });
  const backupPath = path.join(
    backupRoot,
    `${firmId}-${generatedAt.replace(/[:.]/g, '-')}${dryRun ? '-dry-run' : ''}.json`
  );
  await writeFile(backupPath, JSON.stringify(backup, null, 2));
  return { backup, backupPath };
};

const resetData = async ({ backupPath, backup }) => {
  if (dryRun) return { deleted: {}, storage_deleted: 0, audit_marker_id: null };
  if (destructiveFlag !== requiredFlag) {
    const error = new Error(`Refusing reset. Set DONNA_ALLOW_DESTRUCTIVE_RESET=${requiredFlag}`);
    error.code = 'DESTRUCTIVE_RESET_FLAG_REQUIRED';
    throw error;
  }

  const storageDelete = await deleteEvidenceStorageObjects(backup.storage.objects);

  return withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      const deleted = {};
      for (const table of deleteOrder) {
        const result = await optionalQuery(client, `delete from ${table} where firm_id = $1`, [firmId]);
        deleted[table] = result.rowCount || 0;
      }
      const auditResult = await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         values ($1, null, 'system', $2, 'firm.fresh_onboarding_reset', 'firm', $1, $3::jsonb)
         returning id`,
        [
          firmId,
          actorId,
          JSON.stringify({
            backup_path: backupPath,
            deleted,
            storage_deleted: storageDelete.deleted,
            storage_delete_chunks: storageDelete.chunks,
            backup_counts: backup.counts,
            preserved: ['firms', 'firm_members', 'firm_collaborators'],
            purpose: 'Fresh first-use onboarding rehearsal from Bizfile and client portal uploads.'
          })
        ]
      );
      await client.query('commit');
      return {
        deleted,
        storage_deleted: storageDelete.deleted,
        audit_marker_id: auditResult.rows[0]?.id || null
      };
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
};

const main = async () => {
  log('backup_start', { firm_id: firmId, dry_run: dryRun, required_flag: requiredFlag });
  const { backup, backupPath } = await buildBackup();
  log('backup_written', {
    backup_path: backupPath,
    counts: backup.counts,
    storage_objects: backup.storage.objects.length
  });
  const result = await resetData({ backupPath, backup });
  log(dryRun ? 'reset_dry_run_complete' : 'reset_complete', {
    firm_id: firmId,
    backup_path: backupPath,
    ...result
  });
};

main().catch((error) => {
  console.error(JSON.stringify({
    step: 'reset_failed',
    message: error.message,
    code: error.code || null,
    stack: error.stack
  }, null, 2));
  process.exit(1);
});
