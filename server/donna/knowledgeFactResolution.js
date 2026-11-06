// Donna — K1-5: RESOLVE BEFORE ASKING
// (docs/design-donna-knowledge-base.md §6, outcome 2; adopted from the
// 2026-07-29 external review, §14).
//
// THE RULE. Outcome 2 gives the rule, names the variable that could change it,
// and — where that variable is a BUSINESS FACT — asks the owner. But only after
// trying to resolve it from what we already hold. The design's own words:
//
//   "A competent accountant reads the invoice before asking the owner what it
//    was for; a question the data already answers is an owner interruption the
//    decider metric counts against us."
//
// Owner-interruption rate is one of the three load-bearing decider metrics under
// the AI-operated model, so this is not politeness — it is the metric.
//
// ── THE DIRECTION THIS FAILS, AND WHY IT IS THAT DIRECTION ──────────────────
//
// EVERY probe fails OPEN, to asking. An unresolved variable becomes an owner
// question, which is terminal state 2 — a sanctioned resting place under the
// two-terminal-states principle. A WRONGLY resolved variable is a silent wrong
// premise underneath a confident answer, which is failure mode two from §1 and
// has no terminal state at all. Those costs are nowhere near symmetric, so when
// a probe is unsure it does not guess: it lets the ask through.
//
// ── WHY THE PROBES ARE SO NARROW ────────────────────────────────────────────
//
// They read STRUCTURED FIELDS ONLY — `client.jurisdiction`, `client.entity_type`,
// the client-declared `tax_profile` — and nothing else. That is deliberate and it
// is the trust-the-strong-LLM principle applied honestly rather than
// enthusiastically.
//
// The other three sources §6 names (documents on the case, ledger coding,
// `firm_facts`) are PROSE. `firm_facts.fact` is free text; a document is a
// document. Writing keyword rules to decide whether "customer paid in cash, EU
// B2B" answers `vat_reverse_charge_applies` would be exactly the
// intelligence-substituting scaffolding the doctrine warns about — a hand-written
// classifier standing in for a strong model's reading, and one that fails
// silently and confidently.
//
// So the split is: DETERMINISTIC probes resolve structured fields and HARD-
// SUPPRESS the corresponding ask; the prose sources are handed to the model
// inside the grounding block under "ALREADY KNOWN about this business", and the
// model does the reading. Both halves are resolve-before-asking. Only the
// deterministic half gets to overrule the model, because only it can be checked.
//
// PURE, AND IT IMPORTS NOTHING. It reads a context object the turn already
// assembled — it opens no connection and issues no query, so resolve-before-
// asking costs zero extra reads. It also keeps this module off K1's import-taint
// set (§2), same as knowledgeAnswer.js.

const stripControl = (s) => String(s ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ');

// A value counts as RESOLVED only if it is a non-empty scalar. null, '', and
// whitespace are absence — and absence must ask, never assume a default.
const usableValue = (raw) => {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'boolean') return raw ? 'yes' : 'no';
  if (typeof raw === 'number') return Number.isFinite(raw) ? String(raw) : null;
  if (typeof raw !== 'string') return null;
  const clean = stripControl(raw).trim();
  return clean.length > 0 ? clean.slice(0, 200) : null;
};

const readPath = (root, path) => {
  let node = root;
  for (const key of path) {
    if (node === null || node === undefined || typeof node !== 'object') return undefined;
    node = node[key];
  }
  return node;
};

// ── The probe registry ───────────────────────────────────────────────────────
//
// CLOSED, and every entry points at a field verified to exist on the portal-chat
// context (`buildClientPortalChatContext`). Adding an entry is a decision, not a
// commit — the same posture as the topic vocabulary — because each one is a
// question Donna will stop asking the owner, and a wrong entry is invisible.
//
// `tax_profile` is a client-declared object of unpinned shape, so its probes read
// a named key WITHOUT assuming the key exists. Missing ⇒ unresolved ⇒ ask.
export const KNOWLEDGE_FACT_PROBES = Object.freeze([
  { variable: 'entity_jurisdiction', source: 'client_profile', path: ['client', 'jurisdiction'] },
  { variable: 'entity_type', source: 'client_profile', path: ['client', 'entity_type'] },
  { variable: 'accounting_currency', source: 'client_profile', path: ['client', 'accounting_currency'] },
  { variable: 'accounting_system', source: 'client_profile', path: ['client', 'accounting_system'] },
  { variable: 'vat_registered', source: 'tax_profile', path: ['client', 'tax_profile', 'vat_registered'] },
  { variable: 'vat_scheme', source: 'tax_profile', path: ['client', 'tax_profile', 'vat_scheme'] },
  { variable: 'accounting_basis', source: 'tax_profile', path: ['client', 'tax_profile', 'accounting_basis'] },
  { variable: 'fiscal_year_end', source: 'tax_profile', path: ['client', 'tax_profile', 'fiscal_year_end'] }
]);

export const KNOWLEDGE_FACT_PROBE_VARIABLES = Object.freeze(KNOWLEDGE_FACT_PROBES.map((p) => p.variable));

// ── The duplicate-ask probe ──────────────────────────────────────────────────
//
// Re-asking a question the owner has already answered is the single most
// corrosive owner interruption there is: it tells them Donna does not remember,
// which under the self-service model is the whole product.
//
// It matches ONLY on an explicit marker K1 writes onto its own asks
// (`request_payload.knowledge_variable`). It deliberately does NOT try to guess
// whether some ask minted elsewhere "is really about" this variable — a fuzzy
// match here would suppress a legitimate question and leave the answer resting
// on a premise nobody ever confirmed. On the first run no ask carries the marker
// and nothing is suppressed, which is correct.
export const findPriorAskForVariable = (openAsks = [], variable) => {
  if (!variable) return null;
  for (const ask of Array.isArray(openAsks) ? openAsks : []) {
    const marker = ask?.knowledge_variable
      ?? ask?.request_payload?.knowledge_variable
      ?? ask?.payload?.knowledge_variable
      ?? null;
    if (marker === variable) return ask;
  }
  return null;
};

// ── The resolution pass ──────────────────────────────────────────────────────
//
// resolveKnowledgeFacts({ variables, context, openAsks }) → {
//   attempted, resolved, unresolved, suppressed_asks
// }
//
// `variables` is the set of business-fact variables the answer might need. It may
// come from the model's `named_variables` on a second pass, or — the normal case
// — from the probe registry itself, run speculatively BEFORE composition so the
// resolved values can be put into the grounding block and the model never forms
// the intention to ask. That ordering is the point: suppressing an ask after the
// fact still wasted the reasoning, and a model told what is already known writes
// a better answer than one told not to ask.
//
// Every attempt is recorded, hit or miss. "We asked without looking" has to be
// diagnosable from the receipt, otherwise the rule is unenforceable.
export const resolveKnowledgeFacts = ({
  variables = null,
  context = null,
  openAsks = []
} = {}) => {
  const wanted = Array.isArray(variables) && variables.length > 0
    ? variables.filter((v) => typeof v === 'string')
    : KNOWLEDGE_FACT_PROBE_VARIABLES;

  const attempted = [];
  const resolved = [];
  const unresolved = [];
  const suppressedAsks = [];

  for (const variable of wanted) {
    const probe = KNOWLEDGE_FACT_PROBES.find((p) => p.variable === variable) || null;

    // A prior answered ask settles the variable regardless of whether a
    // structured probe exists for it.
    const prior = findPriorAskForVariable(openAsks, variable);
    if (prior && (prior.status === 'replied' || prior.status === 'resolved')) {
      const value = usableValue(prior.answer ?? prior.reply ?? null);
      attempted.push({ variable, source: 'prior_owner_answer', hit: true });
      resolved.push({
        variable,
        value: value ?? 'answered previously',
        resolved_from: 'prior_owner_answer'
      });
      continue;
    }
    // An ask still OPEN is not resolved — but re-asking it is still wrong. It is
    // suppressed without being resolved, so the answer keeps its caveat and the
    // owner is not asked twice while the first ask is in flight.
    if (prior && prior.status === 'open') {
      attempted.push({ variable, source: 'prior_owner_answer', hit: false });
      unresolved.push({ variable, reason: 'ask_already_open' });
      suppressedAsks.push(variable);
      continue;
    }

    if (!probe) {
      // No structured probe and no prior ask — this is one for the owner, or for
      // the model to read out of the prose sources in the grounding block.
      attempted.push({ variable, source: 'none', hit: false });
      unresolved.push({ variable, reason: 'no_probe' });
      continue;
    }

    const value = usableValue(readPath(context, probe.path));
    attempted.push({ variable, source: probe.source, hit: value !== null });
    if (value !== null) resolved.push({ variable, value, resolved_from: probe.source });
    else unresolved.push({ variable, reason: 'not_recorded' });
  }

  return { attempted, resolved, unresolved, suppressed_asks: suppressedAsks };
};

// The marker K1's own asks must carry so the duplicate-ask probe can find them
// next time. Exported so the ask-minting side and the probe cannot drift apart.
export const KNOWLEDGE_ASK_VARIABLE_KEY = 'knowledge_variable';

export const stampKnowledgeAskVariable = (payload = {}, variable = null) =>
  (variable ? { ...payload, [KNOWLEDGE_ASK_VARIABLE_KEY]: variable } : { ...payload });
