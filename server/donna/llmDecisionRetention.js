// Decision-receipt retention — the 90-day clock on llm_decisions.llm_raw_response.
//
// Policy: docs/donna-kernel-audit/decisions-2026-07-28.md, decision 4 (Kari,
// 2026-07-28) — 90-day retention on the raw response, firm-member-only access.
// Mechanism: docs/donna-kernel-audit/telemetry-retention-design.md.
//
// ── THE THREE TIERS (docs/donna-data-lifecycle-policy.md, Kari 2026-07-28) ──
//   1. structured decision receipt — RETAINED (subject to client deletion)
//   2. curated model reasoning (llm_reasoning) — 90 DAYS. The populated column,
//      and the one that makes this policy real rather than prospective.
//   3. raw provider envelope (llm_raw_response) — NOT CAPTURED by default; its
//      clock below stays a PROSPECTIVE control until capture is separately
//      authorized against the policy doc's nine conditions.
//
// ── READ §1 OF THE DESIGN NOTE BEFORE DESCRIBING TIER 3 AS CLOSING A LEAK ──
// `llm_decisions.llm_raw_response` is NULL on every row in production, because
// no production caller has ever passed a value for it: `recordLlmDecision`
// defaults `llmRawResponse = null` (llmDecisions.js:17) and all six call sites
// omit it. (The "10 call sites" in the decision brief was a grep LINE count —
// it counted three imports and the export itself.) So this is a PROSPECTIVE
// control, landed while the column is empty and before M3's `llmCall` seam
// begins populating it. The migration runs against no hot data, the partial
// index is empty on creation, and the guard is standing before the first raw
// response arrives. It is NOT a remediation of a live exposure.
//
// The column that DOES carry free-form model prose on these rows is
// `llm_reasoning` — written at five of six call sites. That went back to Kari
// with the corrected facts and he answered on 2026-07-28: **tier 2 gets the
// same 90-day clock**, and tier 3 stays uncaptured. Both sweeps live here.
//
// Redacting tier 2 breaks nothing, verified: `llm_reasoning` has ZERO database
// readers. Its one apparent consumer (louisPipeline.js:54) interpolates
// reasoning into Louis's QA prompt, but evaluatePipelineDecision is called with
// an IN-MEMORY decision object built at decision time, before the row exists.
//
// KEEP layer, in the CLAUDE.md sense: deterministic date math plus a writer
// whose every refusal is enforced by migration 105's trigger, not by this
// file's good behaviour.

// ── Policy ──────────────────────────────────────────────────────────────────
// 90 is POLICY, not a tuning knob, so it is a constant here and NOT an env var.
// The rollout-flag rail (CLAUDE.md) allows env only for secrets, tuning knobs
// and kill switches; a retention window a stray env var could widen is the
// "client name in an env var" anti-pattern wearing a different hat. The cron
// SCHEDULE is a legitimate env knob and lives in the cron module.
export const LLM_RAW_RESPONSE_RETENTION_DAYS = 90;

// Tier 2. Deliberately a SEPARATE constant from its tier-3 sibling even though
// both are 90 today: the tiers have independent lifecycles (tier 3 may never be
// captured at all), and the policy permits tier 3 to be SHORTER but never
// longer. One shared constant would silently couple them.
export const LLM_REASONING_RETENTION_DAYS = 90;

// The two prose tiers, as data rather than as duplicated code. Each carries its
// OWN write-once redaction stamp, matching migration 107's per-column gate: one
// UPDATE per column, each shaped exactly like its own four-clause predicate. A
// combined statement would be REFUSED on a row that has reasoning but no raw —
// the raw stamp would change while raw_redaction was false. That is the trigger
// working, not a bug to route around.
export const PROSE_TIERS = Object.freeze([
  { tier: 2, column: 'llm_reasoning', stamp: 'llm_reasoning_redacted_at', days: LLM_REASONING_RETENTION_DAYS, key: 'reasoning_redacted' },
  { tier: 3, column: 'llm_raw_response', stamp: 'llm_raw_response_redacted_at', days: LLM_RAW_RESPONSE_RETENTION_DAYS, key: 'raw_redacted' }
]);

export const LLM_RAW_RESPONSE_RETENTION_PROVENANCE = Object.freeze({
  decision: 'decisions-2026-07-28.md — decision 4',
  decidedBy: 'Kari',
  decidedOn: '2026-07-28',
  basis: 'GDPR storage limitation (Art. 5(1)(e)) in BOTH first-class markets — UK GDPR, and EU GDPR via Finland. The same position holds identically in each, which is the "does this hold for the OTHER market too?" question answering yes.'
});

const DAY_MS = 86400000;

// The cutoff instant: rows created STRICTLY BEFORE this are due for redaction.
// Pure, UTC, and total — an unusable `now` throws rather than silently
// computing a cutoff in 1970 and redacting nothing (or everything).
export const retentionCutoff = (now = Date.now(), { days = LLM_RAW_RESPONSE_RETENTION_DAYS } = {}) => {
  const ms = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(ms)) {
    throw Object.assign(new Error('retentionCutoff needs a finite instant.'), { code: 'RETENTION_BAD_NOW' });
  }
  if (!Number.isFinite(days) || days < 0) {
    throw Object.assign(new Error('retentionCutoff needs a non-negative window.'), { code: 'RETENTION_BAD_WINDOW' });
  }
  return new Date(ms - days * DAY_MS).toISOString();
};

// Bounded per firm per run so one large backlog cannot hold a statement open
// across the table. The sweep is idempotent and re-entrant: whatever it does
// not reach today it reaches tomorrow, and the partial index makes finding the
// remainder proportional to what is left rather than to the table.
export const DEFAULT_SWEEP_LIMIT = 5000;

// ── The writer ──────────────────────────────────────────────────────────────
// ONE UPDATE PER TIER, each shaped to match migration 107's per-column predicate
// EXACTLY: non-null → null, stamping that tier's own *_redacted_at in the SAME
// statement. Any other shape is refused by the trigger — including nulling
// without the stamp, which is how "nothing silent" is enforced by the database
// rather than by this function remembering to be honest.
//
// WHY NOT ONE STATEMENT FOR BOTH: a combined UPDATE would be REFUSED on a row
// that carries reasoning but no raw response — which is EVERY row today. The
// raw stamp would change while `raw_redaction` was false, so the diff catches
// it. That is the trigger working, not a bug to route around.
//
// `created_at` is nullable (migration 018 declares `default now()`, not
// `not null`). A row with no created_at cannot be aged, so it is NOT swept —
// but it is COUNTED and reported as `undated` rather than silently included or
// excluded. recordLlmDecision never writes one, so the count should be 0;
// naming it beats discovering it.
const sweepTier = async ({ client, firmId, tier, now, cap }) => {
  const cutoff = retentionCutoff(now, { days: tier.days });
  const redactedResult = await client.query(
    `update llm_decisions
        set ${tier.column} = null,
            ${tier.stamp} = now()
      where id in (
        select id
          from llm_decisions
         where firm_id = $1
           and ${tier.column} is not null
           and created_at is not null
           and created_at < $2
         order by created_at
         limit $3
      )
      returning id`,
    [firmId, cutoff, cap]
  );
  const undatedResult = await client.query(
    `select count(*)::int as undated
       from llm_decisions
      where firm_id = $1
        and ${tier.column} is not null
        and created_at is null`,
    [firmId]
  );
  return {
    tier: tier.tier,
    column: tier.column,
    cutoff,
    retention_days: tier.days,
    redacted: redactedResult.rowCount || 0,
    undated: undatedResult.rows?.[0]?.undated || 0
  };
};

export const sweepLlmProseRetention = async ({
  client,
  firmId,
  now = Date.now(),
  limit = DEFAULT_SWEEP_LIMIT,
  logger = null
} = {}) => {
  if (!client) throw Object.assign(new Error('sweepLlmProseRetention needs a db client.'), { code: 'RETENTION_NO_CLIENT' });
  if (!firmId) throw Object.assign(new Error('sweepLlmProseRetention needs a firmId.'), { code: 'RETENTION_NO_FIRM' });

  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_SWEEP_LIMIT;

  const tiers = [];
  for (const tier of PROSE_TIERS) {
    tiers.push(await sweepTier({ client, firmId, tier, now, cap }));
  }

  const byKey = (key) => PROSE_TIERS.find((t) => t.key === key);
  const resultFor = (key) => tiers.find((t) => t.column === byKey(key).column);
  const reasoning = resultFor('reasoning_redacted');
  const raw = resultFor('raw_redacted');
  const redacted = tiers.reduce((sum, t) => sum + t.redacted, 0);

  const summary = {
    firm_id: firmId,
    limit: cap,
    redacted,
    reasoning_redacted: reasoning.redacted,
    raw_redacted: raw.redacted,
    undated: tiers.reduce((sum, t) => sum + t.undated, 0),
    tiers,
    // True when ANY tier hit its cap, so the caller says "more remains" instead
    // of implying convergence. The next run picks it up.
    more_remaining: tiers.some((t) => t.redacted >= cap)
  };

  // Audited per firm per RUN, not per row: the per-row receipt is the tier's own
  // *_redacted_at stamp, which migration 107 makes mandatory and write-once. A
  // per-row audit event would double the write volume to say the same thing. A
  // run that redacted nothing writes nothing — a converged firm stays quiet.
  //
  // Best-effort BY DESIGN and safe to be: the durable receipt is already on the
  // row, enforced by the trigger, so a failed roll-up loses no evidence that a
  // redaction happened.
  if (redacted > 0) {
    try {
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, null, 'system', 'llm_decision.prose_redacted', 'llm_decisions', $2, $3::jsonb)`,
        [firmId, firmId, JSON.stringify(summary)]
      );
    } catch (error) {
      (logger || console).error?.('[llmDecisionRetention] redaction roll-up audit failed', {
        firm_id: firmId,
        redacted,
        error: error?.message || String(error)
      });
    }
  }

  return summary;
};

// ── Client deletion (policy doc §4/§7) ──────────────────────────────────────
// Retention by AGE and lifecycle by OWNING SCOPE are different questions; this
// is the second. `llm_decisions.client_id` is plain text with NO foreign key
// (migration 018), so the `on delete cascade` that clears every other
// client-keyed table misses this one entirely — receipts survived client
// deletion by SCHEMA OMISSION, not by decision, which is the one posture that is
// definitely wrong.
//
// Decided (Kari, 2026-07-28): client deletion explicitly removes the deleted
// client's TIER 2 and TIER 3 payloads, in-transaction, alongside the existing
// purge chain in firmDb.js.
//
// Decided 2026-08-31 after the recreated-client readiness incident: TIER 1
// survives as minimized firm-level audit evidence, but is DE-LINKED exactly as
// audit_events is. Migration 129 makes client_id nullable and adds a write-once
// client_detached_at stamp. Leaving the old plain id attached is not archival:
// deterministic ids are reused on recreate, so the old receipts become false
// live state for the new legal-entity generation.
//
// No age filter: deletion is not expiry. Presence-guarded on the retention and
// detachment columns so a mismatched pre-migration process cannot block a
// client deletion; Host A still refuses admitted work until migrations match.
export const archiveLlmDecisionsForDeletedClient = async ({ client, firmId, clientId } = {}) => {
  if (!client || !firmId || !clientId) return { redacted: 0, detached: 0, tiers: [] };
  const tiers = [];
  for (const tier of PROSE_TIERS) {
    try {
      const result = await client.query(
        `update llm_decisions
            set ${tier.column} = null,
                ${tier.stamp} = now()
          where firm_id = $1
            and client_id = $2
            and ${tier.column} is not null
          returning id`,
        [firmId, clientId]
      );
      tiers.push({ tier: tier.tier, column: tier.column, redacted: result.rowCount || 0 });
    } catch (error) {
      // A missing column means the deploy predates 107. A client deletion must
      // never be blocked by a retention column that does not exist yet — the
      // firm_facts presence-guard posture.
      if (error?.code === '42703') {
        tiers.push({ tier: tier.tier, column: tier.column, redacted: 0, skipped: 'column_absent' });
        continue;
      }
      throw error;
    }
  }
  const redacted = tiers.reduce((sum, t) => sum + t.redacted, 0);
  let detached = 0;
  let detachmentSkipped = null;
  try {
    await client.query(
      `select set_config('donna.allow_llm_decision_client_detachment', 'on', true)`
    );
    const result = await client.query(
      `update llm_decisions
          set client_id = null,
              client_detached_at = now()
        where firm_id = $1
          and client_id = $2
          and client_detached_at is null
          and llm_reasoning is null
          and llm_raw_response is null
        returning id`,
      [firmId, clientId]
    );
    detached = result.rowCount || 0;
  } catch (error) {
    if (error?.code === '42703' || error?.code === '23502') {
      detachmentSkipped = 'migration_129_absent';
    } else {
      throw error;
    }
  }

  if (detached > 0) {
    await client.query(
      `insert into audit_events
         (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       values ($1, null, 'system', 'llmDecisionLifecycle',
               'llm_decision.client_detached', 'llm_decisions', $2, $3::jsonb)`,
      [firmId, clientId, JSON.stringify({
        contract_version: 'donna.llm-decision-client-detachment.v1',
        detached_receipts: detached,
        prose_redactions: redacted,
        authority_basis: 'client_delete_transaction'
      })]
    );
  }

  return { redacted, detached, detachment_skipped: detachmentSkipped, tiers };
};
