// Donna config control plane — Phase 0A (docs/donna-config-control-plane-phase-0A-impl.md
// + docs/donna-self-awareness-plan.md §6). THE one helper that resolves a per-client
// feature-flag STAGE from the DB-backed client_capability_config table (migration 042),
// shimming over the legacy env canaries (RECONCILIATION_*_CLIENTS): read DB first, fall
// back to env.
//
// DORMANT in this slice — nothing calls clientFlagActs yet, so prod behaviour is
// byte-identical. Wiring the first flag (twin-date) is 0A.2. The shim preserves each
// flag's EXISTING env semantics because the caller passes that flag's OWN predicate as
// `envFallback`; so a GATE-whole flag (fail-closed) and a NARROW-only flag (no allowlist
// ⇒ true) both keep their behaviour until a DB row exists for the client.
//
// CLAUDE.md "Keep" layer: system-correctness config plumbing — no LLM, no verdict, no
// intelligence-substituting scaffolding. It only decides WHICH client a behaviour is on
// for, and at what rollout stage.

import { randomUUID, createHash } from 'node:crypto';

// The flag-as-stage vocabulary. Pinned to the migration 042 CHECK by migrations.test.js so
// the column and the runtime can never drift.
export const CONFIG_STAGES = Object.freeze(['off', 'dry_run', 'shadow', 'canary', 'auto']);

// Gate 1B's admission fence is an admitted capability extension, not part of
// the desktop baseline. Gate 1B.3 consumes only exact client-scoped canary
// postures: a manual target or the source-controlled new-client default.
// clientFlagActs still uses envFallback: () => false; missing/off/dry_run/
// shadow rows preserve the legacy behavior.
export const ENTITY_READINESS_ADMISSION_FLAG = 'ENTITY_READINESS_ADMISSION';

// Flags whose `auto` terminal is NOT yet approved. The config plane refuses to
// PERSIST an `auto` row for these through ANY guarded writer (setClientFlagStage /
// setCohortFlagStage) — "the lever refusing it" is not a real control if a direct
// config write can still set it (2c-iii §M, amendment 9). Removing a flag from this
// set IS the terminal-slice decision — made deliberately, with its own approval,
// never as a drive-by. MEMORY_RETRIEVAL_V2's `auto` (unconditional v2, legacy
// deleted) is a separate later slice; the runtime acting dual also fails closed on
// an `auto` row that bypassed the writer (memoryRetrievalV2Acts).
// The four OUTBOUND_* keys are the outbound-actions gate (M0.4, plan A2):
// `auto` is the EARNED per-action-type terminal — unattended third-party sends
// — and stays forbidden until Kari approves each action type's terminal
// individually (US dunning additionally gated on the D4 settlement signal).
// OUTBOUND_PAY_LINKS (M2, D4) is conservatively held with them: creating
// payment objects on a client's Stripe account acts at 'canary'; a blanket
// firm-default 'auto' row waits for the same deliberate call.
// OUTBOUND_REFERENCE_CAPTURE (M3, G12) is held here by Kari's explicit call
// (2026-07-24, exercising the veto the G12 PR flagged): it is DB-only
// enrichment with no external side effect, but every OUTBOUND_* terminal
// graduates by the same deliberate per-terminal decision — no exceptions by
// category. OUTBOUND_REPLY_INGESTION (reply_if_wrong v2) is born under the
// same category-wide veto: its acting lane records D1 corrections off owner
// email replies (conservative-direction — it only ever demotes automation),
// but a blanket firm-default 'auto' row waits for the same deliberate call.
// MCP_ENTITY_EXPOSE (the per-entity "expose this entity to Claude" consent,
// server/donna/mcp/mcpReadSurface.js) is auto-forbidden by DESIGN, not as a
// pending graduation: consent is per entity, so the only sanctioned shape is
// a client-specific row at canary — a firm-default 'auto' row would expose
// every client (present and future) in one write, which is exactly the
// blanket the consent screen exists to prevent. Do not "graduate" this one.
// MEMORY_LEGACY_AI_RULE_DEMOTION (DMEM-R1 W1, 2026-09-04, audit F-01 / S09):
// the read-boundary demotion of the legacy created_by='ai' ACTIVE client_rules
// to suggestion-only. It is a CANARY on the mini's book under the D-M4
// prompts_per_100 ceiling (audit §6.2) — Kari confirms the ceiling in the W1
// PR and the flag does not leave canary before he does, so its `auto` terminal
// is forbidden here by construction, not by convention.
export const MEMORY_LEGACY_AI_RULE_DEMOTION_FLAG = 'MEMORY_LEGACY_AI_RULE_DEMOTION';

// MEMORY_MODEL_V2 (DMEM-R1 W2, 2026-09-04): the governed memory plane's key. Its
// `authoritative` posture IS the `auto` stage, and that terminal is W6A's
// AUTHORITATIVE_CUTOVER decision (one manifest, Kari's digest — plan
// docs/plan-2026-09-02-memory-remediation-slices.md; audit §4.7). Until then the
// plane admits off / dry_run / shadow / canary rows only; the kill switch is
// CLIENT_CONFIG_FORCE_DISABLE, as for every key (clientFlagPosture → 'kill').
export const AUTO_FORBIDDEN_FLAGS = Object.freeze(new Set([
  ENTITY_READINESS_ADMISSION_FLAG,
  MEMORY_LEGACY_AI_RULE_DEMOTION_FLAG,
  'MEMORY_RETRIEVAL_V2',
  'MEMORY_MODEL_V2',
  'MCP_ENTITY_EXPOSE',
  'OUTBOUND_INVOICING',
  'OUTBOUND_QUOTES',
  'OUTBOUND_DUNNING',
  'OUTBOUND_PAYABLES',
  'OUTBOUND_PAY_LINKS',
  'OUTBOUND_REFERENCE_CAPTURE',
  'OUTBOUND_REPLY_INGESTION',
  // Complimentary access (complimentaryAccess.js): `canary` is its only acting
  // stage — a firm-default row grants billing entitlement and nothing else.
  'COMPLIMENTARY_ACCESS',
  // FIK-2/FIK-4 (plan-2026-09-22-fi-jev-decision-knowledge.md §8): the reviewed
  // Finnish guidance variant is a per-book canary. A firm-default `auto` row
  // would switch — and recode — every Finnish book at once; FIK-5 graduation
  // deletes the flag instead (terminal state 1).
  'FI_JEV_DECISION_GUIDANCE'
]));

// Flags whose stage may not pass 'shadow' (no canary, no auto) through ANY
// guarded writer — a stronger cap than AUTO_FORBIDDEN_FLAGS, for enforcement
// gates whose own precondition is not yet met. SPECIALIST_ROLE_ENFORCE sits
// here per INV-S2(b) (specialist-roles doc §2): role enforcement may not act
// until the coverage audit says the canonical action namespace covers the
// role's whole autonomous surface AND the shadow observation window has run.
// Removing a flag from this set IS that graduation decision — deliberate,
// dated, and blocked by roleActionSurface.test.js while coverage gaps exist.
export const SHADOW_CEILING_FLAGS = Object.freeze(new Set([
  'SPECIALIST_ROLE_ENFORCE'
]));

// Throws if `stage` may not be persisted for `flagKey`. Called by every guarded
// stage writer BEFORE the mutation, so no route (lever, script, admin) can enable
// a forbidden terminal without editing this code + its approval.
export const assertStageAllowedForFlag = (flagKey, stage) => {
  if (stage === 'auto' && AUTO_FORBIDDEN_FLAGS.has(flagKey)) {
    throw new Error(`flag '${flagKey}' may not be staged 'auto' yet — its terminal slice is not approved (config-plane §M guard)`);
  }
  if ((stage === 'canary' || stage === 'auto') && SHADOW_CEILING_FLAGS.has(flagKey)) {
    throw new Error(`flag '${flagKey}' may not be staged past 'shadow' — its coverage/observation gate has not lifted the ceiling (INV-S2(b))`);
  }
};

// stage → "does this flag take its LIVE action for this client?" Uniform DB semantics:
// off / dry_run / shadow do NOT act (observe / propose only); canary / auto DO. A missing
// row or unknown stage ⇒ ∅ ⇒ false (invariant #3: empty config never broadens scope).
export const stageActs = (stage) => stage === 'canary' || stage === 'auto';

// stage → "does this flag OBSERVE (shadow-persist) for this client?" The observe DUAL of
// stageActs, for an observe-only behaviour — a shadow read / receipt that never touches live
// state. `shadow` IS the observe stage by the vocabulary above, so observation is ON from
// `shadow` upward (canary / auto observe too — they also act). off / dry_run and an unknown
// stage do NOT observe. A missing row or unknown stage ⇒ ∅ ⇒ false (invariant #3), so a caller
// that wants the legacy "always observe when globally enabled" behaviour supplies an envFallback
// (see clientFlagObserves), exactly as the act-side shim flags do. Gating an observe-only
// behaviour on stageActs would be a footgun: staging it `shadow` — the natural "observe this in
// shadow" choice — would read as "do NOT act" and switch the observation OFF.
export const stageObserves = (stage) => stage === 'shadow' || stageActs(stage);

// Emergency break-glass: CLIENT_CONFIG_FORCE_DISABLE = 'all' | comma-list of flag_keys.
// May only force a flag OFF — env can KILL a behaviour, never silently ENABLE one
// (self-awareness plan: emergency override = force-disable-only).
export const forceDisabled = (flagKey, env = process.env) => {
  const raw = String(env?.CLIENT_CONFIG_FORCE_DISABLE ?? '').trim();
  if (!raw) return false;
  if (raw.toLowerCase() === 'all') return true;
  return raw.split(',').map((s) => s.trim()).filter(Boolean).includes(flagKey);
};

// THE shim. With a DB snapshot row for this flag → the DB stage decides (fail-closed,
// empty = ∅). Without one → the flag's OWN legacy env predicate (byte-identical fallback).
// A force-disable always wins. `snapshot` is the per-client map from
// readClientConfigSnapshot; `envFallback` is the flag's current predicate, e.g.
// () => settledVerdictCanaryAllows(clientId, env).
export const clientFlagActs = ({ flagKey, snapshot = null, envFallback, env = process.env } = {}) => {
  if (!flagKey) return false;
  if (forceDisabled(flagKey, env)) return false;
  const row = snapshot && typeof snapshot === 'object' ? snapshot[flagKey] : null;
  if (row && typeof row === 'object' && 'stage' in row) return stageActs(row.stage);
  return typeof envFallback === 'function' ? !!envFallback() : false;
};

// The posture PROJECTION of the same resolution (DMEM-R1 W2, doctrine INV-26 /
// audit §4.3 "never a second resolver"): the row clientFlagActs / clientFlagObserves
// read, the same kill switch, rendered as ONE closed word a caller can branch on
// or receipt. `kill` = force-disabled (env may kill, never enable); `off` = no row,
// off, dry_run, or an unknown stage (∅ never broadens); `shadow` = observes only;
// `canary` = acts for this client; `authoritative` = the `auto` terminal. The
// legacy env fallback, when a flag has one, can only ever yield `canary` (it acts)
// or `off` — a plane-born key passes () => false and never reaches it. Every
// posture agrees with the two shims by construction: acts ⇔ canary | authoritative,
// observes ⇔ shadow | canary | authoritative.
export const FLAG_POSTURES = Object.freeze(['kill', 'off', 'shadow', 'canary', 'authoritative']);

export const clientFlagPosture = ({ flagKey, snapshot = null, envFallback = () => false, env = process.env } = {}) => {
  if (!flagKey) return 'off';
  if (forceDisabled(flagKey, env)) return 'kill';
  const row = snapshot && typeof snapshot === 'object' ? snapshot[flagKey] : null;
  if (row && typeof row === 'object' && 'stage' in row) {
    if (row.stage === 'auto') return 'authoritative';
    if (row.stage === 'canary') return 'canary';
    if (row.stage === 'shadow') return 'shadow';
    return 'off';
  }
  return typeof envFallback === 'function' && envFallback() ? 'canary' : 'off';
};

export const postureActs = (posture) => posture === 'canary' || posture === 'authoritative';
export const postureObserves = (posture) => posture === 'shadow' || postureActs(posture);

// THE observe-side shim — the dual of clientFlagActs for an observe-only behaviour. With a DB
// snapshot row → the DB stage decides via stageObserves (shadow / canary / auto observe; off /
// dry_run do not). Without one → the flag's OWN legacy env predicate (byte-identical fallback).
// A force-disable always wins (env may KILL an observation, never silently ENABLE scope). Same
// shape and same invariants as clientFlagActs — only the stage predicate differs.
export const clientFlagObserves = ({ flagKey, snapshot = null, envFallback, env = process.env } = {}) => {
  if (!flagKey) return false;
  if (forceDisabled(flagKey, env)) return false;
  const row = snapshot && typeof snapshot === 'object' ? snapshot[flagKey] : null;
  if (row && typeof row === 'object' && 'stage' in row) return stageObserves(row.stage);
  return typeof envFallback === 'function' ? !!envFallback() : false;
};

// Read all ACTIVE config rows for a (firm, client) into { flagKey: { stage, source } },
// resolving the THREE precedence layers (0A.3):
//
//   client-specific (042, client_id set)  >  cohort (043, via membership)  >  firm default (042, client_id null)
//
// "inherit via membership" is resolved at READ time (not materialised), so a client newly
// added to a cohort inherits the cohort's enrolled flags at its next read — no per-client
// copy to keep in sync. Empty enrollment = ∅ (invariant #3): no membership / no cohort row
// broadens nothing. The cohort layer reads with an INDEPENDENT soft-fail, so a DB that has
// 042 but not yet 043 keeps its 042 rows working (the cohort layer just resolves empty).
// Soft-fails to {} overall (mirrors loopExecutionGate.readFirmExecutionContext) so a missing
// table / absent row degrades to the env fallback. Callers that must distinguish
// an unreadable configuration from an empty one opt into strict:true.
export const readClientConfigSnapshot = async (client, { firmId, clientId, strict = false } = {}) => {
  if (!client || !firmId) return {};
  // Layers 0 + 2 — firm-wide defaults + client-specific rows (migration 042).
  const baseRes = await client.query(
    `select flag_key, stage, source, client_id
       from client_capability_config
      where firm_id = $1 and valid_to is null
        and (client_id = $2 or client_id is null)`,
    [firmId, clientId ?? null]
  ).catch((error) => { if (strict) throw error; return { rows: [] }; });
  // Layer 1 — cohort rows for every cohort this client is an active member of (migration
  // 043). Independent soft-fail so a pre-043 DB keeps the 042 rows above.
  const cohortRes = await client.query(
    `select cc.flag_key, cc.stage, cc.source
       from cohort_capability_config cc
       join client_cohort_members m
         on m.firm_id = cc.firm_id and m.cohort_key = cc.cohort_key
      where cc.firm_id = $1 and cc.valid_to is null
        and m.valid_to is null and m.client_id = $2`,
    [firmId, clientId ?? null]
  ).catch((error) => { if (strict) throw error; return { rows: [] }; });

  const out = {};
  // Layer 0 — firm-wide defaults first.
  for (const r of (baseRes?.rows || [])) {
    if (r.client_id == null) out[r.flag_key] = { stage: r.stage, source: r.source };
  }
  // Layer 1 — cohort rows override the firm default. Among MULTIPLE cohorts setting the
  // same flag (a client in two cohorts), the MOST CONSERVATIVE stage wins — a config
  // conflict must never broaden scope (invariant #3, fail-closed). An unknown stage sorts
  // most-conservative (index -1) and never acts anyway (stageActs).
  const cohortByFlag = {};
  for (const r of (cohortRes?.rows || [])) {
    const prev = cohortByFlag[r.flag_key];
    if (!prev || CONFIG_STAGES.indexOf(r.stage) < CONFIG_STAGES.indexOf(prev.stage)) {
      cohortByFlag[r.flag_key] = { stage: r.stage, source: r.source };
    }
  }
  for (const flagKey of Object.keys(cohortByFlag)) out[flagKey] = cohortByFlag[flagKey];
  // Layer 2 — a client-specific row overrides cohort + default (most specific wins,
  // regardless of stage: an explicit per-client decision is intentional).
  for (const r of (baseRes?.rows || [])) {
    if (r.client_id != null) out[r.flag_key] = { stage: r.stage, source: r.source };
  }
  return out;
};

// Firm-wide resolution of ONE flag across every client — the bootstrap-read dual of
// readClientConfigSnapshot for a surface that renders per-client UI from a single
// firm query (the /snapshot builder), where N per-client round-trips would be waste.
// Same three-layer precedence, same fail-closed posture, same soft-fail-to-empty:
//
//   client-specific  >  cohort (most conservative among multiple)  >  firm default
//
// Returns { byClient: { [clientId]: { stage, source } }, firmDefault: { stage, source } | null }.
// byClient holds only clients with a client-specific or cohort row; a caller resolves a
// client with no entry to firmDefault, and a null firmDefault to its env fallback —
// feed the winning row to clientFlagActs/clientFlagObserves so force-disable and the
// stage predicates stay the single authority.
export const readFirmFlagResolution = async (client, { firmId, flagKey } = {}) => {
  if (!client || !firmId || !flagKey) return { byClient: {}, firmDefault: null };
  const baseRes = await client.query(
    `select stage, source, client_id
       from client_capability_config
      where firm_id = $1 and valid_to is null and flag_key = $2`,
    [firmId, flagKey]
  ).catch(() => ({ rows: [] }));
  // Cohort layer — independent soft-fail, mirroring readClientConfigSnapshot.
  const cohortRes = await client.query(
    `select cc.stage, cc.source, m.client_id
       from cohort_capability_config cc
       join client_cohort_members m
         on m.firm_id = cc.firm_id and m.cohort_key = cc.cohort_key
      where cc.firm_id = $1 and cc.flag_key = $2
        and cc.valid_to is null and m.valid_to is null`,
    [firmId, flagKey]
  ).catch(() => ({ rows: [] }));

  let firmDefault = null;
  const byClient = {};
  for (const r of (baseRes?.rows || [])) {
    if (r.client_id == null) firmDefault = { stage: r.stage, source: r.source };
  }
  // Cohorts before client-specific rows; among multiple cohorts the MOST
  // CONSERVATIVE stage wins (invariant #3 — a config conflict never broadens).
  for (const r of (cohortRes?.rows || [])) {
    const prev = byClient[r.client_id];
    if (!prev || CONFIG_STAGES.indexOf(r.stage) < CONFIG_STAGES.indexOf(prev.stage)) {
      byClient[r.client_id] = { stage: r.stage, source: r.source };
    }
  }
  for (const r of (baseRes?.rows || [])) {
    if (r.client_id != null) byClient[r.client_id] = { stage: r.stage, source: r.source };
  }
  return { byClient, firmDefault };
};

// ── Config snapshot → decision-receipt bridge (Phase 0B.1) ────────────────────────────
// docs/donna-self-awareness-plan.md §4 (`config_snapshot_id`). A decision receipt must be
// able to point at the config that drove it. We content-address the RESOLVED snapshot (the
// { flag_key: { stage, source } } map from readClientConfigSnapshot), NAMESPACED by (firm,
// client) so an id never spans tenants. Pure + deterministic: the same config for the same
// client always hashes to the same id; a config change yields a new id (and a new immutable
// config_snapshots row). Used to stamp llm_decisions.config_snapshot_id.

// Canonical form: only { stage, source } per flag, flags sorted — so key order / extra
// payload fields never perturb the hash. An empty/absent config canonicalises to {} and
// still produces a STABLE id ("ran under empty config / env fallback").
const canonicalizeConfigSnapshot = (snapshot) => {
  if (!snapshot || typeof snapshot !== 'object') return {};
  const out = {};
  for (const key of Object.keys(snapshot).sort()) {
    const row = snapshot[key];
    if (row && typeof row === 'object') {
      out[key] = { stage: row.stage ?? null, source: row.source ?? null };
    }
  }
  return out;
};

export const configSnapshotId = ({ firmId = null, clientId = null, snapshot = null } = {}) => {
  const canonical = JSON.stringify({
    firm_id: firmId ?? null,
    client_id: clientId ?? null,
    snapshot: canonicalizeConfigSnapshot(snapshot)
  });
  return `cfg-${createHash('sha256').update(canonical).digest('hex')}`;
};

// Insert-once (content-addressed, immutable) and return the id, so a decision can reference
// the exact config it ran under. Soft-fails to null (mirrors readClientConfigSnapshot) so a
// missing table / transient error degrades to an un-stamped receipt, never throwing inside a
// reconcile/coding run. `client` is a pg client/transaction handle (withFirmDbClient).
export const persistConfigSnapshot = async (client, { firmId, clientId = null, snapshot = null } = {}) => {
  if (!client || !firmId) return null;
  const id = configSnapshotId({ firmId, clientId, snapshot });
  try {
    await client.query(
      `insert into config_snapshots (id, firm_id, client_id, snapshot)
       values ($1, $2, $3, $4::jsonb)
       on conflict (id) do nothing`,
      [id, firmId, clientId, JSON.stringify(canonicalizeConfigSnapshot(snapshot))]
    );
  } catch {
    return null;
  }
  return id;
};

// Writer: set the active stage for (firm, client, flag) and AUDIT it. Closes the prior
// active row (valid_to = now) and inserts a fresh one, so the row history is preserved.
// Every mutation writes one audit_events row (no silent config change). `client` is a pg
// client/transaction handle (withFirmDbClient). The emergency_override source may ONLY
// force-disable — the force-disable-only invariant, enforced here in code.
export const setClientFlagStage = async (client, {
  firmId, clientId = null, flagKey, stage,
  source = 'manual', reason = null, actorType = 'system', actorId = null
} = {}) => {
  if (!client || !firmId || !flagKey) {
    throw new Error('setClientFlagStage requires client, firmId, flagKey');
  }
  if (!CONFIG_STAGES.includes(stage)) {
    throw new Error(`setClientFlagStage: invalid stage '${stage}'`);
  }
  assertStageAllowedForFlag(flagKey, stage);
  if (source === 'emergency_override' && stage !== 'off') {
    throw new Error('emergency_override may only force-disable (stage=off)');
  }
  await client.query(
    `update client_capability_config set valid_to = now(), updated_at = now()
      where firm_id = $1 and flag_key = $2 and valid_to is null
        and client_id is not distinct from $3`,
    [firmId, flagKey, clientId]
  );
  const id = randomUUID();
  await client.query(
    `insert into client_capability_config
       (id, firm_id, client_id, flag_key, stage, source, reason, set_by_actor_type, set_by_actor_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, firmId, clientId, flagKey, stage, source, reason, actorType, actorId]
  );
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
     values ($1, $2, $3, 'client_config.stage_set', 'client_config', $4, $5::jsonb)`,
    [firmId, clientId, actorType, flagKey, JSON.stringify({ flagKey, stage, source, reason, configRowId: id })]
  );
  return { id, firmId, clientId, flagKey, stage, source };
};

// Writer: set the active stage for a COHORT's flag (043 cohort_capability_config) + AUDIT.
// Same history-preserving close-then-insert shape as setClientFlagStage, keyed by cohort_key
// instead of client_id. Resolved into per-client effect at READ time via membership, so this
// is the single place an operator enrolls "every client in cohort C runs flag F at stage S."
// emergency_override may ONLY force-disable (stage=off) — the force-disable-only invariant.
export const setCohortFlagStage = async (client, {
  firmId, cohortKey, flagKey, stage,
  source = 'cohort', reason = null, actorType = 'system', actorId = null
} = {}) => {
  if (!client || !firmId || !cohortKey || !flagKey) {
    throw new Error('setCohortFlagStage requires client, firmId, cohortKey, flagKey');
  }
  if (!CONFIG_STAGES.includes(stage)) {
    throw new Error(`setCohortFlagStage: invalid stage '${stage}'`);
  }
  assertStageAllowedForFlag(flagKey, stage);
  if (source === 'emergency_override' && stage !== 'off') {
    throw new Error('emergency_override may only force-disable (stage=off)');
  }
  await client.query(
    `update cohort_capability_config set valid_to = now(), updated_at = now()
      where firm_id = $1 and cohort_key = $2 and flag_key = $3 and valid_to is null`,
    [firmId, cohortKey, flagKey]
  );
  const id = randomUUID();
  await client.query(
    `insert into cohort_capability_config
       (id, firm_id, cohort_key, flag_key, stage, source, reason, set_by_actor_type, set_by_actor_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, firmId, cohortKey, flagKey, stage, source, reason, actorType, actorId]
  );
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
     values ($1, null, $2, 'cohort_config.stage_set', 'cohort_config', $3, $4::jsonb)`,
    [firmId, actorType, `${cohortKey}:${flagKey}`, JSON.stringify({ cohortKey, flagKey, stage, source, reason, configRowId: id })]
  );
  return { id, firmId, cohortKey, flagKey, stage, source };
};

// Writer: add (active=true) or remove (active=false) a client's membership in a cohort
// (043 client_cohort_members) + AUDIT. Always closes the prior active membership first, so
// adding is idempotent and removing is a clean valid_to close (the row history is kept).
// Membership is the load-bearing edge of "inherit via membership": a new member inherits the
// cohort's enrolled flags at its next config read, with no re-materialisation.
export const setClientCohortMembership = async (client, {
  firmId, cohortKey, clientId, active = true,
  reason = null, actorType = 'system', actorId = null
} = {}) => {
  if (!client || !firmId || !cohortKey || !clientId) {
    throw new Error('setClientCohortMembership requires client, firmId, cohortKey, clientId');
  }
  await client.query(
    `update client_cohort_members set valid_to = now(), updated_at = now()
      where firm_id = $1 and cohort_key = $2 and client_id = $3 and valid_to is null`,
    [firmId, cohortKey, clientId]
  );
  let id = null;
  if (active) {
    id = randomUUID();
    await client.query(
      `insert into client_cohort_members
         (id, firm_id, cohort_key, client_id, reason, set_by_actor_type, set_by_actor_id)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [id, firmId, cohortKey, clientId, reason, actorType, actorId]
    );
  }
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
     values ($1, $2, $3, 'cohort_membership.set', 'cohort_membership', $4, $5::jsonb)`,
    [firmId, clientId, actorType, cohortKey, JSON.stringify({ cohortKey, clientId, active, reason, membershipRowId: id })]
  );
  return { id, firmId, cohortKey, clientId, active };
};
