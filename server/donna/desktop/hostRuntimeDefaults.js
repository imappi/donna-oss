// The desktop appliance's runtime posture — S1 of
// docs/design-donna-desktop-runtime-on.md (Kari's dated go, 2026-08-03).
//
// Every stage of Donna's loop-until-terminal runtime is present on the
// desktop host but individually default-off behind cloud-canary env gates
// ("opt-in until calibration"). A single-owner box a firm bought BECAUSE
// Donna runs the books must not ship in calibration mode, so the HOST
// supplies the runtime-ON env at boot — the same pattern runtimeServer.js
// uses to stamp DONNA_DESKTOP_BLOB_DIR. Consequences, by design:
//
//   - Zero edits to isolation-listed files: parseDocumentsDb.js keeps
//     reading the env var it already reads; this module supplies the value.
//   - Env stays the kill switch: a var already set (including 'false' on
//     the launch line) is NEVER overwritten.
//   - Cloud is untouched: this module runs only from the desktop boot
//     (scripts/desktop-boot.mjs / desktop/runtime.mjs via runtimeServer).
//   - The config-plane rail is respected: this is the appliance's PLATFORM
//     configuration — the host is the hosting environment, the same class
//     as Vercel's env screen where these vars live for the cloud. Plane-
//     keyed flags get real client_capability_config rows in S2, after
//     which their entries here are dropped.
//
// DELIBERATELY ABSENT from the map:
//   - The extractor wave (DOCUMENT_EXTRACTORS_ENABLED, DOCUMENT_LINES_ENABLED,
//     GENERIC_DOCUMENT_EXTRACTOR_ENABLED) — carried here as S1's stated
//     interim, DROPPED in S2: real client_capability_config rows are seeded
//     at client creation + boot backfill (hostPlaneSeed.js), the plane-native
//     end state. Re-adding them here would mask a broken seed.
//   - CODING_AUTO_POST — its env fallback is fail-closed behind a
//     CODING_AUTO_POST_CLIENTS allowlist (a client name in an env var is
//     the config-plane anti-pattern). Plane rows via hostPlaneSeed.js (S2).
//   - OWNER_EMAIL_ASKS — governed by the asks design
//     (design-donna-desktop-asks-firms-first.md); per-firm plane rows, and
//     the email channel itself is deferred pre-launch (Kari, 2026-08-03).
//   - The unified extractor's switches — none exist any more. RT-12
//     (2026-09-02) deleted the EXTRACTOR_UNIFIED_<TYPE> plane keys and the
//     EXTRACTOR_MODE/_FAMILIES/_CLIENTS env cluster: on the desktop host the
//     unified extractor is the CODE DEFAULT for every reconcilable type and
//     resolves its provider from whichever key is present (spec §2 row 2 is
//     closed). Env keeps only its kill switch (UNIFIED_EXTRACTOR_DISABLED)
//     and tuning knobs (UNIFIED_EXTRACTOR_PROVIDER / _MODEL) — never set here.
//   - RECEIPT_MATCHER_ENABLED — already default ON.
//   - BANK_STATEMENT_LOCAL_OCR — already host-aware (isLocalOcrEnabled).
//   - RECONCILIATION_AUTO_MATCH_MATERIALITY_CEILING and
//     DISPOSITION_MATERIALITY_CEILING — DELETED from the map by RT-11b
//     (2026-09-02). The map carried the Gate E ceiling (500) from S1 because an
//     unset ceiling fails Gate E closed on every match (findings §4b-xx). Since
//     RT-11 every authored pack declares BOTH ceilings in its home currency
//     (packs/<id>/manifest.json reconciliation.materiality_ceiling /
//     .disposition_ceiling) and the resolvers (getAutoMatchPolicy({ jurisdiction }),
//     getDispositionMaterialityPolicy({ jurisdiction })) read the client's pack
//     with env as the ONLY override — so a value here would silently override
//     every client's pack. Env stays the operator's override/kill switch on the
//     launch line; the appliance's default is the pack.

export const DESKTOP_RUNTIME_ENV_DEFAULTS = Object.freeze({
  // The parser, UI reads, and one long reconciliation pass share this pool.
  // The cloud default of two connections lets two model-backed matchers hold
  // the entire pool while awaiting providers, which turned capability reads
  // into eight-second timeouts on the appliance. Six remains small for local
  // Postgres while leaving headroom for foreground parse/status requests.
  DATABASE_POOL_MAX: '6',
  // The matcher wave (spec §2 rows 4–7) — cloud default off.
  SALES_INVOICE_MATCHER_ENABLED: 'true',
  BILL_MATCHER_ENABLED: 'true',
  PAYMENT_CONFIRMATION_MATCHER_ENABLED: 'true',
  PAYMENT_ACCOUNT_STATEMENT_MATCHER_ENABLED: 'true',
  // RT-18 (2026-09-02): the payout / deposit-slip family matcher
  // (payoutReconciliation.js) — same wave, same pattern: the family was
  // born for the appliance (a UAE café's Deliveroo settlements typed
  // unknown, revenue booked net), so it must not ship in calibration mode.
  PAYOUT_MATCHER_ENABLED: 'true',
  // The order-agnostic re-match sweep (spec §2 row 8) — "whichever side
  // arrives second triggers the matching". Its absence is what left the
  // Honeybee rebuild's 16 receipts at No-match (findings §4b-vi).
  BANK_STATEMENT_MATCHER_ENABLED: 'true',
  // AR/AP auto-explain, env half (spec §2 row 9). NOTE: double-gated — the
  // per-firm firms.metadata.auto_explain.* half is seeded in S2, so these
  // alone do not flip auto-explain on.
  SALES_INVOICE_AUTO_EXPLAIN_ENABLED: 'true',
  BILL_AUTO_EXPLAIN_ENABLED: 'true',
  // The bill matcher's DETERMINISTIC promote switch (Stage 2.7,
  // billReconciliation.js:69). BILL_MATCHER_ENABLED above turns the matcher
  // ON but bills reach auto_matched by exactly two paths: LLM triage —
  // which self-disables without ANTHROPIC_API_KEY, i.e. always on the
  // OpenAI-only appliance — or evaluateBillAutoMatch's advisory behind this
  // second kill switch. Without it every bill match rests 'suggested'
  // forever regardless of quality (the Dadant 150.23 acceptance finding,
  // §4b-xiii): the S1 map had switched on the matcher but not its promote
  // path. The advisory's own Keep-layer gates (eligible tier + vendor
  // overlap + window + extraction-confidence floor + no amount_mismatch +
  // currency parity + not-a-duplicate) all stay in force — this flips who
  // may EXECUTE a clean verdict, not what counts as clean.
  BILL_MATCHER_AUTO_PROMOTE_TIER_1: 'true',
  // suggested → auto_matched promotion (spec §2 row 10; Kari's dated YES,
  // 2026-08-03). The materiality ceiling and reconciliation_authority_grants
  // stay in force — this changes resting state, not authority. The
  // RECONCILIATION_AUTO_MATCH_CLIENTS allowlist stays unset on purpose:
  // narrow-only semantics (unset ⇒ all clients), which is exactly right on
  // a single-firm appliance.
  RECONCILIATION_AUTO_MATCH_POLICY: 'true',
  // The goal-first loop system's global ceiling (spec §2 row 12). 'canary'
  // enables the system and sets the ceiling; each FIRM still defaults to
  // 'shadow' until its metadata tier is seeded (S2), and client-visible
  // auto-send stays behind the per-firm auto_send_client_asks human
  // authorization regardless of tier (V1-forbidden by design).
  LOOPS_TIER: 'canary',
  // The uncoded-residue ask lane (the 2026-08-06 leak audit — ten Suspense
  // lines resting in firm limbo with no ask). Two halves, both of which
  // existed and were dark on the appliance:
  //   - The bank-line DISPOSITION producer (bankLineDispositionLlm.js) stamps
  //     a bare/Suspense line's no_match/auto_explained verdict. Its hourly
  //     handler is already in handlerManifest.js; the producer gates on this
  //     mode flag, which the S1 map never set. It is ALSO Anthropic-keyed
  //     (reconciliationLlmCore.getApiKey), so without ANTHROPIC_API_KEY it
  //     self-disables — this default is inert until the key lands, live the
  //     moment it does. No behavior without the key; no calibration mode with
  //     it.
  BANK_LINE_DISPOSITION_MODE: 'llm',
  //   - The gather half (ASK_BATCH_CANDIDATE_SQL $5, firmDb.js): admits a bare
  //     line whose persisted disposition verdict says the owner must clarify,
  //     even with no coder suggestion — the ask surface then renders it.
  //     Fail-closed without verdicts, so this too is inert until the producer
  //     runs. Narrow-only caveat does NOT apply (flag off ⇒ off; no allowlist
  //     inversion).
  RECONCILIATION_DISPOSITION_DRIVEN_ASK: 'true'
});

// Apply the map to `env`, setting ONLY keys that are absent (== null).
// An empty string counts as "explicitly set" and is preserved — some gates
// give '' a meaning (e.g. the receipt matcher treats it as on), and the
// operator who typed FLAG= on a launch line said something on purpose.
// Returns { applied, preserved } for boot logging.
export const applyDesktopHostRuntimeDefaults = (env = process.env) => {
  const applied = [];
  const preserved = [];
  for (const [key, value] of Object.entries(DESKTOP_RUNTIME_ENV_DEFAULTS)) {
    if (env[key] == null) {
      env[key] = value;
      applied.push(key);
    } else {
      preserved.push(key);
    }
  }
  return { applied, preserved };
};
