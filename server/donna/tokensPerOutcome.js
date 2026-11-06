// tokens_per_outcome — the read surface M3 exists to produce.
//
// G3's charge is that 31 modules call a provider directly with no shared
// envelope, so the tree cannot answer three questions: what did an outcome
// COST, how many calls did a task take, and what did RETRIES cost. #1133 built
// the envelope, migration 106 built the typed columns and the
// `idx_llm_decisions_root_execution` join index, and this is the query that
// turns them into an answer.
//
// ── ORDER MATTERS, AND IT WAS NEARLY GOT WRONG ──────────────────────────────
// This module is deliberately NOT the first thing M3 built. Migration 106's
// columns had no producer at all — `telemetryForDecision` had zero production
// callers, so the owner-command lane's telemetry was captured and dropped one
// frame later. A ranking query over columns nothing writes returns an empty
// table that LOOKS like "no spend", which is worse than no query. The producer
// landed first; this reads what it writes.
//
// ── WHY THIS IS THE UNBLOCKER FOR THE REST OF M3 ────────────────────────────
// G3 is explicit that migrating the other 29 call sites against a guessed "top
// spenders" list is wrong, because THE SPEND RANKING DOES NOT EXIST. This
// creates it. The next adoption pass picks its targets from `laneSpend()`
// output, not from a plausible-sounding list — which is exactly the mistake the
// stale §S1 spec would have caused (it routed the first instrumentation pass
// into two isolation-listed files, chosen by a ranking that did not exist).
//
// ── COVERAGE IS REPORTED, NEVER ASSUMED ─────────────────────────────────────
// Adoption is deliberately partial, so every read here returns its own
// coverage alongside its numbers. A caller cannot accidentally read a short
// population as if it were the whole system: `instrumentedShare` says what
// fraction of receipts in the window carry telemetry at all. Silent truncation
// reading as "covered everything" is the named anti-pattern; this is the
// no-silent-caps rail applied to a metric.
//
// KNOWN EXCLUSION, stated rather than discovered later: the INTENT COMPILER's
// cost is NOT in these columns. That lane's receipt home is the compile stamp
// on `client_chat_messages.payload` (model id, prompt version, config snapshot,
// token usage, and now the envelope telemetry), and it joins on the very key
// the stamp is stored under. Giving it a second `llm_decisions` row would be
// duplication of one call. So it is partial adoption recorded as partial — the
// same posture as its retained provider-URL allowlist entry — and
// `KNOWN_UNINSTRUMENTED_LANES` names it so a future session does not read this
// query as complete.
//
// READ-ONLY. This module runs no mutation, holds no authority, and is not on
// any decision path. It is a measurement surface, and measurement that starts
// deciding is the intelligence-substituting scaffolding the trust rail is about.

// Lanes whose model-call cost is real but deliberately NOT in llm_decisions.
// Named here so "this query returned nothing for X" is answerable without a
// grep. Adding a lane to this list is a claim that must be true of the tree.
export const KNOWN_UNINSTRUMENTED_LANES = Object.freeze([
  Object.freeze({
    lane: 'intent_compiler',
    receiptHome: 'client_chat_messages.payload->intent_compile',
    joinKey: 'source_message_id',
    reason: 'owns a structured transport seam; adopts the envelope SHAPE, keeps its own receipt home'
  })
]);

const DEFAULT_WINDOW_DAYS = 30;

// Postgres `usage` is the normalized envelope blob:
// { input_tokens, output_tokens, total_tokens, provider, provider_usage }.
// Read the NORMALIZED keys, never `provider_usage` — that blob is kept for
// diagnosing a normalization bug, and reading it here would launder the bug
// into the metric it was kept to expose.
const TOKENS = `
  coalesce((usage->>'input_tokens')::bigint, 0)  as input_tokens,
  coalesce((usage->>'output_tokens')::bigint, 0) as output_tokens,
  coalesce(
    nullif((usage->>'total_tokens')::bigint, 0),
    coalesce((usage->>'input_tokens')::bigint, 0) + coalesce((usage->>'output_tokens')::bigint, 0)
  ) as total_tokens`;

const windowStart = ({ windowDays = DEFAULT_WINDOW_DAYS, now = Date.now() } = {}) => {
  const days = Number.isFinite(windowDays) && windowDays > 0 ? Math.floor(windowDays) : DEFAULT_WINDOW_DAYS;
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
};

// ── 1. What did each OUTCOME cost? ──────────────────────────────────────────
//
// The question in its literal form: group by (decision_type, final_state) and
// report tokens. `final_state` is the outcome the tokens were spent REACHING,
// which is why the owner-command lane writes its receipt at the resting state
// rather than when the telemetry arrives.
//
// `attempt_count > 1` is broken out because retry cost is one of G3's three
// named unanswerable questions, and an average that silently blends retried
// calls with first-try calls answers it wrongly rather than not at all.
export const tokensPerOutcome = async (client, {
  firmId = null, clientId = null, windowDays = DEFAULT_WINDOW_DAYS, now = Date.now()
} = {}) => {
  const since = windowStart({ windowDays, now });
  const { rows } = await client.query(
    `with scoped as (
       select decision_type, final_state, lane, model_name, attempt_count, latency_ms,
              ${TOKENS}
         from llm_decisions
        where created_at >= $1
          and usage is not null
          and ($2::text is null or firm_id = $2)
          and ($3::text is null or client_id = $3)
     )
     select decision_type, final_state, lane,
            count(*)::int                             as decisions,
            sum(total_tokens)::bigint                 as total_tokens,
            sum(input_tokens)::bigint                 as input_tokens,
            sum(output_tokens)::bigint                as output_tokens,
            round(avg(total_tokens))::bigint          as avg_tokens_per_outcome,
            round(avg(latency_ms))::bigint            as avg_latency_ms,
            count(*) filter (where attempt_count > 1)::int as retried_decisions,
            coalesce(sum(total_tokens) filter (where attempt_count > 1), 0)::bigint as retried_tokens,
            count(distinct model_name)::int           as model_ids
       from scoped
      group by decision_type, final_state, lane
      order by total_tokens desc`,
    [since, firmId, clientId]
  );
  return rows;
};

// ── 2. What did one EXECUTION cost, end to end? ─────────────────────────────
//
// The typed root ref is what makes this a join rather than a guess, and this
// query is the reason migration 106 refused §S1's four-way nullable union: you
// cannot group by an identity spread across four nullable columns.
//
// It also answers "calls per task" — G3's second unanswerable question — as
// `calls`, because a task that made three model calls has three receipts under
// one root.
export const executionSpend = async (client, {
  rootExecutionType = null, rootExecutionId = null,
  firmId = null, windowDays = DEFAULT_WINDOW_DAYS, now = Date.now(), limit = 100
} = {}) => {
  const since = windowStart({ windowDays, now });
  const { rows } = await client.query(
    `with scoped as (
       select root_execution_type, root_execution_id, decision_type, final_state,
              attempt_count, latency_ms, ${TOKENS}
         from llm_decisions
        where created_at >= $1
          and root_execution_id is not null
          and usage is not null
          and ($2::text is null or root_execution_type = $2)
          and ($3::text is null or root_execution_id = $3)
          and ($4::text is null or firm_id = $4)
     )
     select root_execution_type, root_execution_id,
            count(*)::int                    as calls,
            sum(total_tokens)::bigint        as total_tokens,
            sum(attempt_count)::bigint       as attempts,
            sum(latency_ms)::bigint          as total_latency_ms,
            max(final_state)                 as final_state
       from scoped
      group by root_execution_type, root_execution_id
      order by total_tokens desc
      limit $5`,
    [since, rootExecutionType, rootExecutionId, firmId, Math.max(1, Math.floor(limit) || 100)]
  );
  return rows;
};

// ── 3. THE SPEND RANKING — the thing that does not exist yet ────────────────
//
// This is what the next adoption pass picks its targets from. Until it returns
// data, "migrate the top spenders" is guesswork, which is precisely why G3
// refuses that ordering and why the other 29 sites are deliberately unmigrated.
//
// `instrumentedShare` is the honest part: a lane absent from these rows is not
// a lane that spends nothing, it is a lane not yet on the envelope. The two are
// indistinguishable from the numbers alone, so the coverage rides along with
// them and `KNOWN_UNINSTRUMENTED_LANES` names the one we already know about.
export const laneSpend = async (client, {
  firmId = null, windowDays = DEFAULT_WINDOW_DAYS, now = Date.now()
} = {}) => {
  const since = windowStart({ windowDays, now });
  // The CTE is not decoration: it names the per-row token total so the outer
  // ORDER BY resolves against a derived column rather than against
  // `llm_decisions`. Same shape as the two queries above — and the repo's SQL
  // writer lint refuses the flat version, correctly.
  //
  // Unlike them, this one does NOT filter `usage is not null`: the whole point
  // is to compare instrumented lanes against un-instrumented ones, and a
  // population that excluded the latter could not report coverage at all.
  const { rows } = await client.query(
    `with scoped as (
       select coalesce(lane, decision_type) as lane, usage, model_name,
              ${TOKENS}
         from llm_decisions
        where created_at >= $1
          and ($2::text is null or firm_id = $2)
     )
     select lane,
            count(*)::int                                   as decisions,
            count(*) filter (where usage is not null)::int   as instrumented,
            coalesce(sum(total_tokens) filter (where usage is not null), 0)::bigint as total_tokens,
            count(distinct model_name)::int                  as model_ids
       from scoped
      group by lane
      order by total_tokens desc, count(*) desc`,
    [since, firmId]
  );

  const decisions = rows.reduce((n, r) => n + Number(r.decisions || 0), 0);
  const instrumented = rows.reduce((n, r) => n + Number(r.instrumented || 0), 0);
  return {
    windowDays: Number.isFinite(windowDays) && windowDays > 0 ? Math.floor(windowDays) : DEFAULT_WINDOW_DAYS,
    lanes: rows,
    coverage: {
      decisions,
      instrumented,
      // null, never 0, on an empty window: "no receipts at all" and "receipts
      // that all lack telemetry" are different facts and must not read alike.
      instrumentedShare: decisions ? instrumented / decisions : null,
      knownUninstrumentedLanes: KNOWN_UNINSTRUMENTED_LANES
    }
  };
};
