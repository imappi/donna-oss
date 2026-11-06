// Shared governance backstop for operator memory (firm_facts, Layer 2).
//
// A remember_fact must carry durable JUDGMENT memory, never an autonomy/policy
// control. A firm request to change unattended behaviour — raise an auto-apply
// ceiling, stop the asking flow, post without review — is a policy_request, not
// a fact; letting it land in firm_facts would silently turn a policy ask into
// active memory the coder weighs forever (the trust-the-strong-LLM hazard:
// scaffolding that quietly ratifies a misread instead of surfacing it).
//
// The prompt routes such asks to triage policy_request at propose time; this
// module is the SERVER BACKSTOP, used at BOTH ends with ONE copy so the two
// points can never drift:
//   - proposal time — feedChat.__sanitizeFeedChatActions demotes an
//     autonomy-shaped remember_fact to a non-appliable future_action, so the
//     operator never sees an Apply button on a card that would only be refused
//     at write time. The firm still sees the request, correctly framed as
//     policy that needs an operator — nothing is hidden.
//   - apply time — feedChatApply.rememberFact refuses the write as the final
//     guard against a stale or forged request that reaches the writer anyway.
//
// Kept deliberately CONSERVATIVE: only clear automation-policy language trips
// it, so a genuine judgment fact about a client's own behaviour (e.g. "Jordan
// is a subcontractor, not an employee") is never blocked.

export const AUTONOMY_POLICY_PATTERNS = [
  /\bauto[-\s]?appl(y|ies|ied|ying)\b/i,
  /\bauto[-\s]?(categor|post|reconcil)/i,
  /\bautomatically\s+(apply|post|categor|reconcil|approve)/i,
  /\bunattended\b/i,
  /\bwithout\s+(my\s+|human\s+|firm\s+)?(review|approval|sign-?off|asking)\b/i,
  /\b(raise|lower|set|change|increase|decrease|adjust)\s+(the\s+)?(auto[-\s]?apply\s+)?(ceiling|threshold|limit)\b/i,
  /\bstop\s+(asking|auto|the\s+ask)/i
];

// True when a remember_fact action's text reads as an autonomy/policy request
// rather than judgment memory. Reads the fields a fact carries (fact_text,
// fact_subject, reason) and trips only on the conservative patterns above.
export const factRequestsAutonomy = (action = {}) => {
  const text = [action.fact_text, action.fact_subject, action.reason]
    .map((value) => String(value || ''))
    .join(' ');
  return AUTONOMY_POLICY_PATTERNS.some((pattern) => pattern.test(text));
};

// ─── Future-coding policy / generalisation detection ───────────────────────

// A remember_fact must be durable JUDGMENT about a SPECIFIC subject, never a
// standing instruction for how to code a CLASS of yet-unseen rows. "All future
// inflows get the same treatment", "from now on code these to consulting
// revenue" is a future-coding POLICY (or, for a named merchant, a
// remember_merchant rule) — folding it into firm_facts turns a generalisation
// into memory the coder then weighs on every future line. That is the same
// trust-the-strong-LLM hazard the autonomy detector guards: scaffolding that
// quietly ratifies an over-broad instruction instead of surfacing it as the
// policy it is. Genuine identity/status facts — "X is a shareholder", "Y is a
// contractor not a director" — name a subject and carry no future-class/coding
// cue, so they are never tripped (this was the investor-name class:
// a share-issue "remember this for next time" that wanted to become memory).
//
// Kept as CONSERVATIVE as the autonomy detector: it fires only when the text
// names a CLASS of FUTURE transactions, or pairs an explicit "from here on"
// generalisation WITH a coding/treatment verb (so "from now on Kari is the sole
// director" — an identity fact — is NOT caught).

// A class of future transactions named as the thing to be coded.
const FUTURE_TRANSACTION_CLASS_RE =
  /\b(future|upcoming|subsequent|further)\s+(inflow|deposit|payment|transaction|receipt|credit|debit|line|charge|expense|amount|invoice)s?\b/i;

// A "from here on / across the board" generalisation cue …
const CODING_GENERALISATION_RE =
  /\b(all|every|any|each)\s+(future|upcoming|subsequent|further)\b|\b(going\s+forward|from\s+now\s+on|henceforth|in\s+(the\s+)?future)\b/i;

// … which, paired with a coding/treatment verb, is a policy rather than a fact.
const CODING_TREATMENT_RE =
  /\b(code|cod(?:ed|ing)|categori[sz]e[ds]?|categori[sz]ing|treat(?:ed|ing|ment)?|appl(?:y|ied|ies)|book(?:ed)?|post(?:ed)?)\b|\b(same|identical)\s+(treatment|coding|categor(?:y|isation|ization)|account|handling|way)\b/i;

// True when a remember_fact reads as a future-coding generalisation/policy
// rather than durable judgment about a specific subject. Reads the same fields
// factRequestsAutonomy does. A named class of future rows is enough on its own;
// a bare generalisation cue only trips when paired with a coding/treatment verb.
export const factRequestsFutureCodingPolicy = (action = {}) => {
  const text = [action.fact_text, action.fact_subject, action.reason]
    .map((value) => String(value || ''))
    .join(' ');
  if (FUTURE_TRANSACTION_CLASS_RE.test(text)) return true;
  return CODING_GENERALISATION_RE.test(text) && CODING_TREATMENT_RE.test(text);
};

// FIK-0b (docs/plan-2026-09-22-fi-jev-decision-knowledge.md §2): a
// jurisdiction-scope fact applies to every client in that jurisdiction, so it
// is general accounting or tax knowledge by construction — and migration 030
// forbids general bookkeeping knowledge in firm_facts. Such a claim belongs in
// the reviewed country policy (the FIK-1 source-review intake), never in firm
// memory. A fact about THIS business is taught under client or merchant scope.
export const factIsJurisdictionKnowledge = (action = {}) =>
  String(action.fact_scope || '').trim().toLowerCase() === 'jurisdiction';

// ─── remember_fact conflict surfacing ─────────────────────────────────────

// Detect bounded SAME-scope/SAME-subject conflicts between a PROPOSED
// remember_fact and the firm's ACTIVE known_facts. A second fact about the same
// subject (same scope) whose text DIFFERS from one already on file is a
// potential contradiction the operator should see BEFORE minting — so we
// SURFACE it (carrying the existing fact's id, addressable thanks to the
// known_facts id rail) and NEVER resolve it: the proposal stays appliable and
// the operator decides whether to supersede, keep both, or cancel. Identical
// text is NOT a conflict (re-asserting the same fact is a no-op). Bounded so the
// annotation can never flood the card. Pure: reads only the proposal + the
// already-loaded context facts; mutates nothing.
export const findRememberFactConflicts = (action = {}, knownFacts = [], { limit = 3 } = {}) => {
  if (action?.type !== 'remember_fact') return [];
  const scope = String(action.fact_scope || '').trim().toLowerCase();
  const subject = String(action.fact_subject || '').trim().toLowerCase();
  const proposed = String(action.fact_text || '').trim();
  if (!scope || !subject || !proposed) return [];
  const conflicts = [];
  for (const fact of Array.isArray(knownFacts) ? knownFacts : []) {
    if (conflicts.length >= limit) break;
    if (!fact || typeof fact !== 'object') continue;
    const sameScope = String(fact.scope || '').trim().toLowerCase() === scope;
    const sameSubject = String(fact.subject || '').trim().toLowerCase() === subject;
    const existing = String(fact.fact || '').trim();
    if (sameScope && sameSubject && existing && existing !== proposed) {
      conflicts.push({
        id: fact.id || null,
        scope: fact.scope || null,
        subject: fact.subject || null,
        fact: existing,
        confidence: fact.confidence || null,
        status: fact.status || null
      });
    }
  }
  return conflicts;
};
