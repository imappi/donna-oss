// S2 of docs/design-donna-desktop-runtime-on.md — the plane-native half of
// the appliance's runtime-ON posture. Phase 1 (hostRuntimeDefaults.js)
// carried the extractor wave on env fallback as a stated interim; this
// module seeds the REAL client_capability_config rows (stage 'auto',
// source 'default', reason DESKTOP_SEED_REASON) so the posture is
// auditable, per-client visible, and survives launch-line hygiene — after
// which the env map dropped the wave keys. CODING_AUTO_POST can ONLY
// arrive this way: its env fallback is fail-closed behind a _CLIENTS
// allowlist (the config-plane anti-pattern), so a plane row is the only
// opener (codingAutoPost.js) — this is the flag whose absence kept the
// desktop Open tab resting at Suggested while the web book auto-posted.
//
// Two entry points, one rule — only-where-no-live-row, so a prior decision
// (including an explicit 'off') is never overwritten:
//   - seedDesktopClientPlaneRowsWithClient: called inside createClientInDb's
//     transaction on the desktop host, so a client born mid-session parses
//     and codes immediately (the appliance flow is create-entity-then-drop-
//     documents in one sitting — a boot-only seed would miss it). Failure
//     aborts that create transaction; an operationally incomplete client is
//     never committed.
//   - backfillDesktopRuntimePlane: desktop boot (runtimeServer assembly),
//     heals pre-S2/legacy clients; also seeds the firm-metadata half
//     (auto_explain per-firm enables + loops.tier='canary') that
//     resolveBillAutoExplainConfig / resolveFirmTier read. Firm materiality
//     numbers stay code defaults (Kari's dated call, 2026-08-03: ship code
//     defaults, tune from the sample close).

import { setClientFlagStage } from '../clientConfig.js';

export const DESKTOP_SEED_REASON = 'desktop_host_default';

// The plane-keyed flags every desktop client is born with (spec §2 rows 1
// and 11; OPERATOR_CAPABILITY_ENFORCE graduated canary → desktop default by
// G2 PR-17, design-donna-chat-memory-godmode-build-spec-g2.md — capability
// enforcement is the resting posture of every desktop client, the recorded
// launch precondition for Practice staff seats. Blast radius is sub-founder
// principals only: an unrestricted firm member always resolves to founder
// class and can never be locked out, and the gate fails open on infra error
// — operatorCapability.js / firmDb.assertActionCapability. Seeding it also
// means a client reset re-arms enforcement automatically instead of dying
// silently with the authority plane's FK cascade.) All entries act at
// 'auto' (none are AUTO_FORBIDDEN or shadow-ceilinged — clientConfig would
// refuse the write otherwise, which is the guard we want).
//
// MODEL_CHALLENGER joined per Kari's all-entities lab call (2026-08-16):
// every desktop client — existing on heal, new on creation, recreated on
// reset — is born observed. The flag is OBSERVE-only by construction
// (shadow-challenger dispatch, evidence + receipt, never a decision), and
// 'auto' observes (stageObserves), so seeding it re-arms the model-lab
// shadow automatically instead of dying silently with each client reset —
// the exact whack-a-mole this seed list exists to end. Dispatch still
// requires the env four (endpoint pair + candidate + cap), so a machine
// with no challenger config stays dark, fail-closed.
//
// JURISDICTION_ACCOUNT_PALETTE joined after the 2026-08-28 clean Honeybee
// rebuild proved the practical cost of leaving the country-pack chart dark:
// the US apiary's correctly-extracted Tractor Supply receipt described smoker
// fuel, hive staples and work gloves, but the legacy schema enum did not offer
// the authored country chart. The follow-up live model pass then proved that
// even the prior US chart lacked a distinct operating-supplies answer, so that
// role now lives in every authored pack instead of forcing consumables into
// Office expenses or inventory COGS. The pack marker changes no accounting authority; it
// gives the existing coder the authored fallback chart for the client's stored
// jurisdiction. Unknown/unauthored jurisdictions still fail soft to the legacy
// list, and a live off row remains an explicit decision that this seed will not
// overwrite.
//
// The two ask-settling gates joined after the same clean Honeybee
// rebuild reproduced irreversible receipt requests while the same upload
// burst was still reconciling. They are Keep-layer timing invariants, not
// accounting authority: quiescence prevents drafting while ANY client
// document is still parsing; the settle gate prevents sending while an
// unattributed owner upload is still parsing. Seeding both means deleting
// and recreating a desktop client cannot silently remove those protections.
export const DESKTOP_CLIENT_FLAG_SEEDS = Object.freeze([
  'DOCUMENT_EXTRACTORS_ENABLED',
  'DOCUMENT_LINES_ENABLED',
  'GENERIC_DOCUMENT_EXTRACTOR_ENABLED',
  'DOCUMENT_ROUTER_ENABLED',
  // Bank statements are load-bearing accounting extraction. The desktop
  // baseline sends their text layer through the structured model first; the
  // deterministic parser remains a fail-closed fallback with period, balance,
  // and row-footing proofs. Boot backfill gives existing/recreated clients the
  // same posture without an env switch.
  'BANK_STATEMENT_LLM_EXTRACTION',
  'CODING_AUTO_POST',
  // Permanent first-line reasoning posture, approved 2026-09-20. Creation
  // and boot healing use the same governed seed; reset cannot lose routing.
  // This grants no posting/correction authority and no paid shadow budget.
  'JEV_RECONCILIATION',
  'LEDGER_AUTO_POST',
  'JURISDICTION_ACCOUNT_PALETTE',
  // The coder routes to the client's OWN jurisdiction vocabulary (ae_vat,
  // gb_vat, …) instead of the legacy SG default — jurisdiction-safe by
  // construction (an sg client resolves to the default either way). Seeded
  // on the appliance since 2026-08-31 (Kari, "nothing dark" — the AE lane
  // must code a UAE book without manual staging); cloud staging is
  // unchanged, this list is the desktop posture like LEDGER_AUTO_POST above.
  'JURISDICTION_TAX_CODING',
  // FINLAND_ALV_CODING (2026-09-08, the first Finnish book — orchestrator-7
  // §1a): the FI posting policy names this key as its postingTaxCodingFlagKey
  // (finland/postingPolicy.js), the way GB names JURISDICTION_TAX_CODING above.
  // The coder already routes the FI ALV vocabulary by jurisdiction; without
  // this row no ALV code reaches ledger_lines.tax_type, so finland/alvReturn.js
  // read an empty return on a fully coded month (no input VAT, no reverse
  // charge, the wrong payable) — a material, silent error. Seeded 'auto' like
  // its GB sibling: it acts only where the fi posting policy consults it. The
  // FI threshold watch (FINLAND_ALV_THRESHOLD_WATCH, not seeded, dark here)
  // keys its "already registered" guard on this flag — a conflation to move
  // onto the effective-dated registration record (alvRegistration.js) in the
  // statutory lane, not here.
  'FINLAND_ALV_CODING',
  'RECONCILIATION_ASK_QUIESCENCE_GATE',
  'ASK_SEND_SETTLE_GATE',
  'OPERATOR_CAPABILITY_ENFORCE',
  'MODEL_CHALLENGER',
  // The doc-first terminal drain (documentDispositionLlm.js): a parsed,
  // amount-bearing reconcilable doc the family matchers left bare gets ONE
  // strong-model verdict — auto_explain settles it, chase_evidence routes it
  // to the owner, needs_human stays surfaced. Born on the plane with
  // envFallback false, so without a row the drain never runs and such docs
  // rest "Processing" forever in the owner's list (Desert Rose, 2026-09-01:
  // four unmatched January documents pinned exactly this). Seeding it 'auto'
  // makes the drain the appliance's resting posture; the settlement-entry
  // producer behind it keeps its OWN flag (DOCUMENT_SETTLEMENT_LEDGER_ENTRY,
  // absent ⇒ inert); the Finnish baseline also enables its tax-aware writer.
  'DOCUMENT_NO_LINE_DISPOSITION',
  // Ask lifecycle honesty (RT-11, 2026-09-02; audit F-16/F-17, decisions D2–D4).
  // Three plane keys the owner shell is born with, so a fresh client's asks
  // are honest from the first close (Desert Rose round 4: 16 of 95 asks were
  // authority-only; Salik/Zoho carried a purpose ask after their own
  // auto_explain):
  //   - RECONCILIATION_MATERIAL_AUTO_FYI (D2): a confident MATERIAL match
  //     (A–D proved, only the materiality ceiling held) auto-reconciles and
  //     FYIs the owner instead of converting to a confirm ask — decide-and-
  //     notify is the confident branch of the first principle, and on the
  //     owner ICP the owner IS the authority. Same blast-radius header as
  //     scripts/enable_honeybee_material_auto_commit.js: the ceiling and any
  //     grants stay in force; this changes who may EXECUTE a proved match.
  //   - RECONCILE_AUTO_EXPLAIN_RETRACTS (D4): Donna's own immaterial
  //     auto_explain retracts an open purpose/document ask on that line,
  //     receipted (reconciliationTwinAging.js).
  //   - RECONCILE_RETRACTION_AUTOSEND (the converted env pair): the retraction
  //     lane may tell the owner "you can ignore what we asked" on its own; a
  //     retraction the owner is never told about would be a resolved row and a
  //     stale question in the same breath.
  'RECONCILIATION_MATERIAL_AUTO_FYI',
  'RECONCILE_AUTO_EXPLAIN_RETRACTS',
  'RECONCILE_RETRACTION_AUTOSEND',
  // DMEM-R1 W1 (2026-09-04, audit F-10 / N-05): the ONE posture of the
  // memory-candidate feature. Born on the plane with envFallback false (the
  // three raw LOOPS_SHADOW reads are gone); seeded `auto` on the owner shell
  // because the owner IS the governance human on the appliance: a correction
  // or reply now STAGES a `suggested` candidate (never an active fact), and the
  // owner promotes or dismisses it from the Memory tab. A promotion is still an
  // explicit human click with a receipt — this seed activates no memory by
  // itself. MEMORY_LEGACY_AI_RULE_DEMOTION is deliberately NOT here: it is a
  // canary on the mini's book under the D-M4 owner-interruption ceiling
  // (declared in admitted_extensions, auto-forbidden until Kari confirms).
  'MEMORY_CANDIDATES'
]);

// Plane keys the desktop client is BORN OFF with (DMEM-R1 W2, 2026-09-04):
// declared here in lock-step with data/worlds/admitted-entity-profiles.json
// `admitted_extensions`, and deliberately NOT seeded — "born off on the config
// control plane" means NO ROW (clientFlagActs → envFallback () => false → off;
// clientFlagPosture → 'off'), never an explicit off row: migration 127's
// dependency fence invalidates a ready entity the moment a
// client_capability_config row lands, so a boot backfill that wrote one row
// per client would block admission on every appliance for a flag that does
// nothing. The lever that stages one of these is its wave's canary manifest
// (W5's LIVE_CANARY for MEMORY_MODEL_V2), through setClientFlagStage, and
// Certificate B admits the row under the extension's allowed postures.
// The load-time invariant below refuses a build that lists a dark extension
// among the auto seeds — the two lists are disjoint by construction.
export const DESKTOP_DARK_PLANE_EXTENSIONS = Object.freeze([
  'MEMORY_MODEL_V2'
]);

for (const flagKey of DESKTOP_DARK_PLANE_EXTENSIONS) {
  if (DESKTOP_CLIENT_FLAG_SEEDS.includes(flagKey)) {
    throw new Error(`hostPlaneSeed: ${flagKey} is a dark plane extension (born off, no row) and cannot also be an auto seed`);
  }
}

// The firm-metadata keys the backfill seeds (spec §2 rows 9 and 12), each
// only-where-absent — an existing key with ANY value (including false) is
// a decision and stays.
export const DESKTOP_FIRM_AUTO_EXPLAIN_KEYS = Object.freeze([
  'sales_invoice_enabled',
  'supplier_bill_enabled'
]);
export const DESKTOP_FIRM_LOOPS_TIER = 'canary';

// The desktop host signal — same convention as isLocalOcrEnabled /
// isInngestConfigured (bankStatement.js:41, inngest/client.js:42).
export const isDesktopHostEnv = (env = process.env) =>
  Boolean(env?.DONNA_DESKTOP_BLOB_DIR);

export const DESKTOP_FINLAND_FLAG_SEEDS = Object.freeze(['DOCUMENT_SETTLEMENT_LEDGER_ENTRY']);

// Seed missing plane rows for one client inside an open transaction.
// Returns the flag keys inserted. A LIVE row (valid_to null) at any stage
// means a decision exists for this client — never superseded from here.
// Writes go through setClientFlagStage (supersede + insert + audit in the
// same transaction), never raw inserts.
export const seedDesktopClientPlaneRowsWithClient = async (client, { firmId, clientId } = {}) => {
  if (!client || !firmId || !clientId) return [];
  const identity = (await client.query('select jurisdiction, entity_type from clients where firm_id=$1 and id=$2',[firmId,clientId])).rows[0];
  const seeds = [...DESKTOP_CLIENT_FLAG_SEEDS, ...(String(identity?.jurisdiction || '').toLowerCase() === 'fi' && identity?.entity_type === 'fi-oy' ? DESKTOP_FINLAND_FLAG_SEEDS : [])];
  const existing = await client.query(
    `select flag_key from client_capability_config
      where firm_id = $1 and client_id = $2 and valid_to is null
        and flag_key = any($3::text[])`,
    [firmId, clientId, seeds]
  );
  const have = new Set(existing.rows.map((r) => r.flag_key));
  const applied = [];
  for (const flagKey of seeds) {
    if (have.has(flagKey)) continue;
    await setClientFlagStage(client, {
      firmId,
      clientId,
      flagKey,
      stage: 'auto',
      source: 'default',
      reason: DESKTOP_SEED_REASON,
      actorType: 'system'
    });
    applied.push(flagKey);
  }
  return applied;
};

// Firm-metadata half. Read-merge-write is safe here: the appliance is a
// single-writer host and the call sits inside the backfill's transaction.
// Exported for the Gate 3 first-run mint (firstRunFirmMint.js), which seeds
// a firm born mid-session inside its own transaction — same rationale as
// seedDesktopClientPlaneRowsWithClient above.
export const seedDesktopFirmMetadataWithClient = async (client, { firmId } = {}) => {
  const res = await client.query('select metadata from firms where id = $1', [firmId]);
  if (!res.rows.length) return [];
  const metadata = res.rows[0].metadata && typeof res.rows[0].metadata === 'object'
    ? res.rows[0].metadata
    : {};
  const applied = [];
  const autoExplain = { ...(metadata.auto_explain && typeof metadata.auto_explain === 'object' ? metadata.auto_explain : {}) };
  for (const key of DESKTOP_FIRM_AUTO_EXPLAIN_KEYS) {
    if (key in autoExplain) continue;
    autoExplain[key] = true;
    applied.push(`auto_explain.${key}`);
  }
  const loops = { ...(metadata.loops && typeof metadata.loops === 'object' ? metadata.loops : {}) };
  if (!('tier' in loops)) {
    loops.tier = DESKTOP_FIRM_LOOPS_TIER;
    applied.push('loops.tier');
  }
  if (!applied.length) return applied;
  await client.query(
    'update firms set metadata = $2::jsonb, updated_at = now() where id = $1',
    [firmId, JSON.stringify({ ...metadata, auto_explain: autoExplain, loops })]
  );
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
     values ($1, null, 'system', 'firm.metadata.desktop_seed', 'firm', $1, $2::jsonb)`,
    [firmId, JSON.stringify({ applied, reason: DESKTOP_SEED_REASON })]
  );
  return applied;
};

// Boot backfill: every firm on the box (the appliance has one), every
// client, only-where-missing — idempotent per boot by construction. One
// transaction so a partial seed never survives a crash; the whole call is
// best-effort at the boot site (a failure must not stop the runtime), but
// LOUD there, because after S2 the extractor wave has no env fallback and
// a silently-failed backfill would be §4b-v reborn. This is legacy recovery,
// never a substitute for the fail-closed creation-time seed above.
//
// seedChartFn (optional): the pack-palette chart seed
// (firmDb.seedPackPaletteChartWithClient), injected by the boot site rather
// than imported — firmDb imports this module, so importing it back would be a
// cycle. Runs per client AFTER the flag rows, in the same transaction, so a
// legacy client whose chart was minted account-by-account at posting gets the
// palette rows it is missing and its half-typed rows filled (the Desert Rose
// 'unknown' accounts). Absent ⇒ byte-identical to the flag-only backfill.
export const backfillDesktopRuntimePlane = async ({ withFirmDbClientFn, logger = console, seedChartFn = null } = {}) => {
  if (typeof withFirmDbClientFn !== 'function') {
    throw new Error('backfillDesktopRuntimePlane requires withFirmDbClientFn');
  }
  return withFirmDbClientFn(async (client) => {
    await client.query('begin');
    try {
      const firms = await client.query('select id from firms');
      let clientRows = 0;
      let clientCount = 0;
      let chartAccounts = 0;
      const firmMetadata = [];
      for (const firm of firms.rows) {
        const clients = await client.query('select id from clients where firm_id = $1', [firm.id]);
        clientCount += clients.rows.length;
        for (const row of clients.rows) {
          const applied = await seedDesktopClientPlaneRowsWithClient(client, {
            firmId: firm.id,
            clientId: row.id
          });
          clientRows += applied.length;
          if (typeof seedChartFn === 'function') {
            const chart = await seedChartFn(client, { firmId: firm.id, clientId: row.id });
            chartAccounts += (chart?.inserted?.length || 0) + (chart?.filled?.length || 0);
          }
        }
        const metaApplied = await seedDesktopFirmMetadataWithClient(client, { firmId: firm.id });
        firmMetadata.push(...metaApplied);
      }
      await client.query('commit');
      logger.log?.(
        `[runtime-server] desktop plane seed: ${clientRows} client flag rows across ${clientCount} clients; chart accounts seeded/filled: ${chartAccounts}; firm metadata: ${firmMetadata.length ? firmMetadata.join(', ') : 'none missing'}`
      );
      return { clientRows, clientCount, chartAccounts, firmMetadata };
    } catch (error) {
      try { await client.query('rollback'); } catch { /* connection-level failure — nothing to unwind */ }
      throw error;
    }
  });
};
