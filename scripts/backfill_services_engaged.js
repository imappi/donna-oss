#!/usr/bin/env node
//
// Phase 1.5 backfill — give the live clients an EXPLICIT services_engaged
// so they land in the new cohort model instead of the legacy all-tiles
// shim.
//
// Background: Phase 1 shipped "empty/absent services_engaged → render
// every portal tile" as a backward-compat shim. Phase 1.5 splits the
// cohort:
//   - absent key            → legacy → still all tiles
//   - explicit []           → "not scoped yet" placeholder (new clients)
//   - explicit non-empty    → scoped → mapped tiles only
//
// New clients now get [] at creation (createClientInDb). The existing
// live clients predate that, so this one-off migrates each to an explicit
// services_engaged derived from their current state:
//   - already has a non-empty services_engaged → leave it (report only).
//   - already has an explicit []               → leave it (report only).
//   - has legacy applicable_intake_categories  → map tile ids → service
//                                                ids and write them.
//   - has neither                              → DO NOT GUESS. Reported
//                                                and skipped; an operator
//                                                scopes it on the firm
//                                                card (writing [] here
//                                                would hide every tile
//                                                from an established
//                                                client).
//
// Usage:
//   DATABASE_URL='postgresql://…' node scripts/backfill_services_engaged.js            # dry-run
//   DATABASE_URL='…' node scripts/backfill_services_engaged.js --apply                 # commit
//
// Re-running is safe: once a client carries an explicit services_engaged
// the second run reports "already explicit" and writes nothing.

import { withFirmDbClient, DEFAULT_FIRM_ID } from '../server/donna/firmDb.js';
import { TILE_TO_SERVICE, SERVICE_IDS } from '../src/lib/clientAxes.js';

const FIRM_ID = process.env.BACKFILL_FIRM_ID || DEFAULT_FIRM_ID;
const TARGET_CLIENT_IDS = [
  'honeybee-hills-apiary',
  'alex-morgan-personal',
  'cactus-blossom-cafe'
];
const APPLY = process.argv.includes('--apply');
const SERVICE_ID_SET = new Set(SERVICE_IDS);

const log = (...args) => console.log('[services-engaged-backfill]', ...args);

// Pure helper — exported for tests. Maps a legacy
// applicable_intake_categories list (tile ids) to canonical service ids
// via the shared TILE_TO_SERVICE map, deduped, junk dropped, original
// order preserved.
export const mapLegacyTilesToServices = (tiles = []) => {
  if (!Array.isArray(tiles)) return [];
  const out = [];
  for (const raw of tiles) {
    const tile = typeof raw === 'string' ? raw.trim() : '';
    const service = TILE_TO_SERVICE[tile];
    if (service && SERVICE_ID_SET.has(service) && !out.includes(service)) {
      out.push(service);
    }
  }
  return out;
};

// Decide what (if anything) to write for one client's profile. Pure —
// returns { action, services } where action ∈ 'skip_already_scoped' |
// 'skip_already_unscoped' | 'skip_no_signal' | 'write'.
export const planClientBackfill = (profile = {}) => {
  const existing = profile?.services_engaged;
  if (Array.isArray(existing)) {
    return existing.length
      ? { action: 'skip_already_scoped', services: existing }
      : { action: 'skip_already_unscoped', services: [] };
  }
  const legacy = profile?.applicable_intake_categories;
  if (Array.isArray(legacy) && legacy.length) {
    const services = mapLegacyTilesToServices(legacy);
    // Even if the map yields nothing usable, the client clearly had a
    // legacy filter — writing the (possibly empty) mapped set is honest.
    return { action: 'write', services };
  }
  return { action: 'skip_no_signal', services: null };
};

const runScript = async () => {
  log(`firm=${FIRM_ID} mode=${APPLY ? 'APPLY' : 'dry-run'} targets=${TARGET_CLIENT_IDS.join(', ')}`);

  await withFirmDbClient(async (client) => {
    for (const clientId of TARGET_CLIENT_IDS) {
      const result = await client.query(
        'select id, company_name, profile from clients where firm_id = $1 and id = $2',
        [FIRM_ID, clientId]
      );
      const row = result.rows[0];
      if (!row) {
        log(`  ${clientId}: NOT FOUND in firm ${FIRM_ID} — skipped.`);
        continue;
      }
      const profile = row.profile || {};
      const plan = planClientBackfill(profile);
      const legacy = Array.isArray(profile.applicable_intake_categories)
        ? profile.applicable_intake_categories
        : [];

      switch (plan.action) {
        case 'skip_already_scoped':
          log(`  ${clientId}: already scoped (${plan.services.join(', ')}) — no change.`);
          continue;
        case 'skip_already_unscoped':
          log(`  ${clientId}: already explicit [] (unscoped) — no change.`);
          continue;
        case 'skip_no_signal':
          log(`  ${clientId}: no services_engaged and no legacy categories — SKIPPED. Scope it on the firm card (writing [] would hide every tile).`);
          continue;
        case 'write':
          log(`  ${clientId}: legacy [${legacy.join(', ')}] → services_engaged [${plan.services.join(', ')}]`);
          if (APPLY) {
            await client.query(
              `update clients
                  set profile = coalesce(profile, '{}'::jsonb) || $3::jsonb,
                      updated_at = now()
                where firm_id = $1 and id = $2`,
              [FIRM_ID, clientId, JSON.stringify({ services_engaged: plan.services })]
            );
            await client.query(
              `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
               values ($1, $2, 'system', 'client.profile.update', 'client', $2, $3::jsonb)`,
              [FIRM_ID, clientId, JSON.stringify({
                keys: ['services_engaged'],
                source: 'phase_1_5_services_engaged_backfill',
                from_legacy: legacy,
                services_engaged: plan.services
              })]
            );
            log(`    written.`);
          }
          continue;
        default:
          continue;
      }
    }

    if (!APPLY) {
      log(`\nDry run complete. Re-run with --apply to commit.`);
    } else {
      log(`\nDone. Verify:`);
      log(`  select id, profile->'services_engaged' as services_engaged`);
      log(`    from clients where firm_id='${FIRM_ID}' and id = any($targets);`);
    }
  });
};

// Skip auto-run on import (tests). Only the CLI entry point runs it.
const invokedAsScript = import.meta.url === `file://${process.argv[1]}`;
if (invokedAsScript) {
  runScript().catch((err) => {
    console.error('[services-engaged-backfill] failed:', err?.message || err);
    process.exit(1);
  });
}
