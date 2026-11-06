# Jev capability boundary: evidence vs reasoning (2026-09-18)

Status: **built, dry-run, reviewed twice, frozen with real ids and RUN ONCE
(2026-09-18) — the outcomes are in
`jev-capability-boundary-run-2026-09-18.md`; this record is the build
record and is unchanged by the run.** This record is the deliverable of Kari's capability-boundary brief
(`docs/session-handoff-2026-09-18-jev-capability-boundary.md` §1): it says
exactly what changed in the harness, records the frozen digests, and states
the planned live arms with their cost ceiling. No provider was called, no
production authority, writer, permission or threshold changed, and the fresh
family set was authored from the brief's list, corrected under the first
pre-run review (§8) and marked under the second (§9), and has not been run.
Kari runs it once; nothing here is tuned from it.

The question under test: **when the accounting evidence actually exists, how
much of routine reconciliation can Jev terminate correctly on its own, and
which classes genuinely require frontier reasoning?**

## 1. The terminal model, in the contract and the scorer

**Three terminals, mapped onto the existing contract (no new spine).**

| Brief terminal | Contract routes | Operational consequence |
| --- | --- | --- |
| RESOLVED | `supported_proposal`; `not_admitted`; a determinate `unresolved_research` (nothing in scope settles the invoice: every candidate excluded, contradicted, reversed or wrong-direction) | `RESOLVED_AUTONOMOUSLY` |
| NEEDS_EVIDENCE | `customer_question` (a declared owner-only fact); **`needs_evidence` (new)**: a required payment-specific source does not exist in the packet | `ASK_OWNER` |
| RESOLVED (no settlement) | typed: the compiler's determinate `unresolved_research`; strong: **`no_settlement` (new, explicit)** | `RESOLVED_AUTONOMOUSLY` |
| NEEDS_REASONING | `strong_reasoning` from a typed pass → `ESCALATE_MODEL`; `strong_reasoning` / `unresolved_research` ("cannot finish") from the strong model → `REQUIRES_ACCOUNTING_JUDGMENT` | one class: the case leaves autonomous handling |
| — | `retrieve_local`; guard refusals; malformed answers; contract refusals; `forced_block:*` | `BLOCK` |

- **`operationalConsequence(decision)`** (`jev_decision_plane_protocol.js`)
  projects every route onto the next step it implies. Five consequences,
  four classes: `ESCALATE_MODEL` and `REQUIRES_ACCOUNTING_JUDGMENT` are one
  class. Arms are scored on the class (`consequence.correct`) beside the raw
  route (`score.correct`, unchanged); a route-different but class-equal
  outcome is recorded per case as **ontology debt**, never as a capability
  difference. Every arm distinguishes "determinate no settlement" from
  "cannot finish" explicitly and both are scored identically: the typed
  arm's determinate negative and the strong model's `no_settlement` are
  RESOLVED; the strong model's `unresolved_research` is "cannot finish" and
  is correct only against a reasoning label. The label vocabulary's
  `unresolved_research` for a determinate negative is the debt, named per
  case (`unresolved_research→no_settlement`). Companion owner requests
  beside a resolution (`evidence_requests`, expressible by the typed arm
  and, through the schema, by the strong model) are scored separately: a
  proposal that omits a labelled request, or adds one, is not a complete
  resolution — on the arm's INITIAL decision (`own_correct`,
  `own_companions`) as much as on its final one (§9, finding 1). The
  full-case interpretation (`no_settlement` RESOLVED; `unresolved_research`
  "cannot finish") applies to every arm whose own decision is a full-case
  outcome, the optional cheap arm included (§9, finding 3).
- **Labels.** The fresh set carries `expected.terminal` (RESOLVED /
  NEEDS_EVIDENCE / NEEDS_REASONING) beside `expected.route`;
  `labelConsequence` reads the terminal when present and derives it from the
  route on the frozen corpora (`strong_reasoning` → escalate;
  `unresolved_research` → resolved-negative).
- **Evidence sufficiency in code.** `evidenceSufficiency(prepared)`
  (`jev_evidence_action_contract.js`) reads the packet: retrieval not
  covered; a declared owner-only fact; an eligible, direction-compatible
  candidate with no link. "Missing" is claimed **only when the packet holds
  no unbound evidence at all** (`unboundEvidence`: any non-structural
  source that no link binds — a chat, a voucher, a payslip, a report naming
  a sibling). When unbound evidence or a link elsewhere exists the status is
  `uninterpreted`: present evidence a reader must say the meaning of, never
  a document to request from the owner. It is on every plan case and every
  composition receipt.
- **The reversal fact.** `transactions[].instrument` (optional, declared by
  the packet assembler: a cheque number, a SEPA end-to-end id, a card
  authorisation; never parsed from text). `instrumentReversal(p, t)`: a
  later-or-same-day row on the same instrument, opposite direction, **same
  amount**. It rides `candidateMechanicalChecks` (`reversal`), so the
  compiler excludes a reversed candidate under every policy
  (`instrument_reversed_no_settlement`), the strong-outcome guard refuses a
  proposal on it (`instrument_reversed`), and `mechanical_facts` shows
  `instrument` / `reversed_by` to the strong model. A partial refund is not
  a reversal (amount differs). The frozen corpora carry no instrument field
  and are byte-identical; the state's `instrument` key is emitted only when
  present, so **every typed request on the frozen corpora is unchanged**
  (old checkpoints resume). Regression fixtures authored on development:
  `data/evals/fixtures/jev-plane-reversal/` (3 families, 8 cases: the
  returned cheque, the returned-and-resent transfer, the refunded card
  charge, each with the non-reversal control).

## 2. The three policies (`POLICIES`, shadow-only)

`composeEvidenceAction(prepared, raw, { policy })` with `POLICY_SPEC`; a named
policy pins its floor and refuses any other. No production compose caller
is touched; the policies exist only through the research plan.

| Policy | Base | Floor | Sufficiency in front | Escape hatch |
| --- | --- | ---: | --- | --- |
| `safe` | `conjunction` | .90 | no | yes (the frozen reference) |
| `max_authority` | `attempt_first` | 0 | yes | yes, only on genuine "cannot establish" |
| `forced` | `attempt_first` | 0 | yes | **none** |

- **`max_authority`.** A candidate with no link **and no unbound evidence
  in the packet** is `needs_evidence` (never a strong call). A candidate with
  no link while unbound evidence or a link elsewhere exists is
  `present_evidence_not_interpreted`: it escalates (evidence exists; the
  typed pass did not establish what it means). A declared owner-only fact is
  asked on the packet's declaration (`declared_customer_fact_unconfirmed`
  when the typed `customer_fact` answer is unsure) **only when no unbound
  evidence exists**; with unbound evidence an unsure answer escalates as
  under `safe`, and a contradiction at majority mass escalates
  (`customer_fact_contradicted_by_source`). A supported obligation proposes;
  an evidence-missing sibling rides the proposal as `evidence_requests`
  instead of blocking it. What still escalates: mechanical conflicts,
  identity or reference contradictions, an obligation not established on a
  linked candidate, unread unbound evidence.
- **`forced`.** Mechanical facts BLOCK (`forced_block:<reason>`: conflicting
  allocations/remittances, arithmetic, consumed allocation, absent
  reference, group over-allocation). A semantic contradiction, a
  self-contradicting exclusion or a repeated reference is decided by the
  candidate's `obligation` answer (`forced_overrides`); an obligation Jev
  does not establish is a `negative`. Every case ends in a terminal from the
  typed answers; the plan freezes no escalation and `costTable` shows zero
  escalation calls.
- **Raw probabilities preserved.** Every composition receipt carries
  `deciding_answers` (question, status, Jev's raw probability, outcome:
  proposal / negative / forced-over / escalate / customer question) for
  **every** semantic decision, vetoes included (a .60 counterparty that
  blocks the conjunction is recorded as `escalate:counterparty_veto`, a
  contradiction as `escalate:contradiction`), and `decidingProbability` =
  the lowest among the answers whose status itself asserts the action. An
  answer whose status does not assert the action (a `not_established`
  obligation turned into a negative under `forced`) is marked `imposed`:
  the model's confidence in uncertainty is never read as confidence in the
  action. **Any imposed step makes the whole decision `policy_imposed`**
  (§9, finding 2): it carries no deciding probability at all and sits in
  the separate `policy_imposed` band — a sibling's asserted answer (an
  exclusion at .99) never lends a forced negative on the focal candidate a
  confidence it did not earn. Under `forced` every imposed answer is
  essential to the route, because the same answers escalate under
  `max_authority`. These ride the decision into the public summary
  (`DECISION_FACT_KEYS`; no prose, no model id).
- **Strong requests changed** (every arm, deliberately): `MODEL_ROUTES`
  gains `needs_evidence` and `no_settlement`; the full-case schema gains a
  required `missing_evidence` string and a required `evidence_requests`
  array (companion requests, the typed arm's equivalent); the prompt
  defines the routes and the escalation suffix asks the model to say WHY the
  typed pass could not finish (resolve / evidence absent / judgment /
  other). The guard refuses a `needs_evidence` without a statement, a
  request on an unknown candidate, and a request on a candidate the model
  itself proposed. Consequence: strong full-case and escalation records
  from earlier runs are not reused by digest; typed records are.

## 3. Scoring: the brief's measures, bands and attribution

`summary[split/arm].boundary` (model-dependent cases; Jev-specific error counts
exclude disputed ground truth, which is reported beside them):
`autonomous_coverage`(+rate), `correct_autonomous_resolutions`,
`wrong_autonomous_resolutions`(+including_disputed),
`wrong_final_resolutions`(+including_disputed),
`needs_evidence_correctly_identified`, `needs_evidence_missed`,
`false_evidence_requests`, `genuine_needs_reasoning`,
`reasoning_labels_escalated`, `unnecessary_escalation`, `escalations`,
`unresolved_outcomes` (BLOCK), `accounting_judgment_outcomes`,
`contract_gap_reasoning_labels[]` (reasoning labels that measure a contract
restriction) and `rule_blocked_reasoning_labels[]` (reasoning labels a
mechanical check decides before any semantic answer is consulted, §9) — both
reported apart from `genuine_needs_reasoning`, which counts only labels a
semantic answer can change — `escalations_by_attribution` and
`incorrect_by_attribution` (each by who decided: `contract_rule`,
`routing_policy`, `model`), `companion_requests_missed`,
`companion_requests_unrequested`,
`correct_final_by_consequence`, `correct_final_exact`, `ontology_debt[]`,
`strong_calls`, `provider_calls`, `actual_usd` (the sum of each record's
reconciled charge, at the budget's model-specific price where it names
one), p50/p95 own and cascade latency, `deciding_probability_mean`
(correct vs incorrect).

- **`confidence_bands`** for the typed arms: band (`<0.50`, `0.50-0.59`, …,
  `0.90-1.00`, `mechanical`, `policy_imposed`) × decisions × correct ×
  incorrect × error_rate × error_types, from each own decision's deciding
  probability. `mechanical` holds decisions no semantic answer made;
  `policy_imposed` holds every decision with a policy-imposed step (§9,
  finding 2). An own decision that omits or adds a companion request is
  incorrect in its band (§9, finding 1). Exposes the curve; no threshold is
  derived.
- **`error_attribution`**: the brief's eleven classes (`ERROR_CLASSES`),
  attributed mechanically from the decision's own reason codes, the
  candidate's shape (fee-bearing or cross-currency link, payment before the
  invoice date, a reversed instrument, a same-amount sibling) and the label;
  protocol §7's taxonomy stays as `LEGACY_TAXONOMY_CROSSWALK`. **Two
  attributions, two events** (§9, item 6): every escalated result carries
  `escalation_attribution`, read from the INITIAL decision alone and
  unchanged by whatever the fallback answers; every incorrect result
  carries `error_attribution`, read from the FAILING decision, with
  `authored_by` (`full_case_model` for an escalated fallback or a
  full-case arm's own answer; `typed_composition` otherwise). Each carries
  its `class`, its `basis` and **`attributed_to`** — who decided it:
  `contract_rule` (a
  mechanical check no semantic answer could change: a conflict, arithmetic,
  a consumed allocation, a reversal, a guard refusal), `routing_policy`
  (the policy's evidence rule on the packet's shape: an escalation whose
  reason is `present_evidence_not_interpreted` or a
  `customer_fact_not_established` with unbound evidence, the declaration
  ask, the safe policy's refusal to ask), or `model` (a typed or full-case
  answer; a full-case model's wrong answer is always the model's, whatever
  route the typed pass escalated on, unless a guard refused it). The
  unbound-source rule's excess escalations are therefore attributed to
  routing policy, never automatically to Jev's capability (§9). A wrong
  negative the policy imposed on a `not_established` answer is attributed
  to the model (it failed to establish an evidenced obligation) but never
  as a confidence claim (`policy_imposed`). `boundary` counts
  `escalations_by_attribution` from the escalation attribution and
  `incorrect_by_attribution` / `incorrect_by_author` from the error
  attribution.
- **dev-006** is `DISPUTED_GROUND_TRUTH`: reported on every arm
  (`disputed_cases`, band `disputed` counts, the `_including_disputed`
  rows), excluded from the Jev-specific error and attribution counts.
- **The old five continuation checks are kept and marked
  `informational: true`** (`continuation.note`); no ≤ 20 % escalation gate
  governs anything.

## 4. The fresh family set (frozen; run once)

`data/evals/fixtures/jev-plane-fresh/`, authored by `FRESH_FAMILIES` in
`scripts/jev_decision_plane_corpus_author.js` from the brief's list, split
`fresh`, three-terminal labels, expressibility gate on real PostgreSQL under
`max_authority` (`jev_decision_plane_corpus.test.js`). Machine-checked line:

fresh: 36 cases, 12 families, 32 model-dependent by the fixture flag; RESOLVED 29, NEEDS_EVIDENCE 3, NEEDS_REASONING 4; supported_proposal 23, strong_reasoning 4, customer_question 1, needs_evidence 2, unresolved_research 6, not_admitted 0, retrieve_local 0

Markets GB 12 / FI 12 / SG 12; the harness's operational rule makes all 36
model-dependent (no common route). Families (3 cases each): cheque deposit
returned then cleared (GB); supplier transfer bounced and re-sent (FI);
Stripe payout with the settlement statement present, missing, or bundling
another order (SG); director transfer — salary, loan, dividend or
reimbursement (GB); instalment payments with the viite, the last one
overshooting (FI); USD invoice with an SGD inward remittance, advice present,
missing, or short (SG); two open invoices of one customer (GB); MobilePay
fee-netted settlement, exact, ten cents off, two captures (FI); two
same-amount credits the same day — a true duplicate, an unrelated payer with
and without its own advice (SG); cash direction, a refund beside the payment
(GB); ALV net-or-gross payment and a reverse-charge bill (FI); a
remittance email and a PayNow reference that agree, disagree, or arrive
twice as a forwarded copy (SG; added under the review, §8).

**The four NEEDS_REASONING labels, stated for what each measures** (the task
is payment allocation of the focal invoice; the disposition of a remainder
is remaining work). **None of them measures Jev's reasoning.** fresh-023 (a
settlement report and the bank disagree by ten cents, no source explains
it) and fresh-035 (the bank reference and the customer's remittance name
different invoices) are **rule-blocked** (`rule_blocked` in the fixture:
`relationship_amount_conflict`, `conflicting_allocations`): every document
exists, but the contract refuses each mechanically before any semantic
answer is consulted — ideal and unknown answers escalate on the same code
with zero deciding answers (machine-checked by the corpus gate) — so their
results cannot establish that Jev lacks reasoning capability or that a
frontier model is necessary; they are reported apart
(`rule_blocked_reasoning_labels`) as **underdetermined**, and their
escalations are attributed to `contract_rule` (§9, finding 4). fresh-015 (a
reference-linked instalment overshooting the remaining amount) and
fresh-025 (a true duplicate payment) are declared **contract gaps**
(`contract_gap`: a reference link carries one amount; no duplicate-payment
convention) and are reported apart (`contract_gap_reasoning_labels`).
`genuine_needs_reasoning` is therefore **0** on the fresh set. The honest
consequence, stated plainly: under this contract a NEEDS_REASONING label a
semantic answer *could* change can only say "the ideal `obligation` answer
is `not_established` on a mechanically clean link", i.e. the label would
assert that Jev *should* be unsure — a label about our assumptions, which
is exactly what the brief forbids as a pre-escalation. No such family is
authored. **The fresh set bounds the reasoning boundary from below only:**
if Jev has one, it shows up as wrong autonomous resolutions in the
confidence table under `forced` and `max_authority`, not as reasoning
labels. fresh-026 carries the labelled companion request
(`evidence_requests: [tx-t2]`) beside its proposal.

Under ideal answers, without a provider: `max_authority` lands 36/36 labels
including the companion request, and every one of its four escalations is
attributed to `contract_rule` (`escalations_by_attribution`:
contract_rule 4, routing_policy 0, model 0); `safe` escalates three more
(fresh-008 and -017, the missing settlement statement and the missing FX
advice; fresh-026, a proposal with an unevidenced same-amount sibling),
attributed to `routing_policy`, and lands every label after a scripted
escalation; `forced` blocks the four mechanically-fixed NEEDS_REASONING
labels and makes no wrong autonomous resolution on ideal answers. Under unknown typed answers, `max_authority` asks or requests
evidence only where the packet is mechanically missing evidence (fresh-008,
-010, -017); a dividend voucher (fresh-011) or a remittance naming the
sibling (fresh-020) escalates as unread evidence. Nothing in the set can be
reached by party, amount and date alone; every NEEDS_EVIDENCE label is
authored on absence, not difficulty.

**On the frozen corpora**, `max_authority` under ideal answers differs from
the old labels on exactly seven cases: the six whose evidence is absent
(dev-004, -007, -010, -013, -020, holdout-069 → `needs_evidence` where the
label said `strong_reasoning`: the conflation the brief names) and disputed
dev-006 (a proposal with an evidence request for the sibling). `forced`
additionally turns every mechanical escalation into a BLOCK and decides
four label-strong cases by the obligation answer (review-04, holdout-025,
holdout-052 propose; dev-017, holdout-021, holdout-055 negative) — the
confidently-wrong exposure the policy exists to measure. `safe` equals the
frozen conjunction at .90 on every case.

## 5. Frozen digests (Kari's real-id freeze, 2026-09-18, head `2f961da`)

The plan rows below are the digests Kari's laptop printed at the real-id
freeze (three dry-runs from head `2f961da`, two docs-only commits past
`2ca1615`; no code file changed, so the 13 hashed code files and the corpus
digests are those of `2ca1615`). The earlier placeholder-id freeze
(`TYPESAFE_MODEL=placeholder-typed`, `JEV_STRONG_MODEL=placeholder-strong`)
minted `6acec0da…` (safe) / `79ea5ec9…` (max_authority) / `e12a153a…`
(forced); the remote session reproduced those byte-for-byte from `2f961da`
before the real-id freeze, so the only difference between the two freezes is
the model id strings in the requests (the real-id cost tables carry the same
72 + ≤ 36 calls and differ from the placeholder tables by 120 estimated input
tokens, the length of the id strings). Plan files are private
(`~/private/jev/`), never committed; the model ids live only there and in the
private receipts.

| Item | Digest |
| --- | --- |
| corpus `jev-plane-fresh` | `826bcc42fe58e90d13c1e6d36a0f221386f266b71d7c46dfbebc9538ac8934bd` |
| corpus `jev-plane-reversal` | `9db55a627e2288df844ad7321df59419937748b702228a7b57df017f5ec07aea` |
| corpus `jev-plane-dev` (unchanged) | `f0f11a25be3b92a98eb8d3901c6216c91081f586bcd0dfbd2b83183ced4ab082` |
| corpus `jev-plane-holdout` (unchanged) | `03dcf6a1d12f7d642c3a7c70d904a27056eba73bdf19e24da6a2f3d5aa500dff` |
| `jev_evidence_action_contract.js` | `e5d010d058f1534d…` |
| `jev_decision_plane_protocol.js` | `5acb7b6da8ca2303…` |
| `jev_decision_plane.js` | `110e7731c946dccb…` |
| plan `max_authority` (real ids) | `43a16719787d9900c2c5ef681a3c77c1e6aa7b785b32174a90e79e88fc2de1f5` |
| plan `safe` (real ids) | `f3e24caf77a85fde85e9132336275e2f135e403cbba3418cd134fb23fd434cf9` |
| plan `forced` (real ids) | `2c5318707cf089f5e22ba44b82a03ec26fa6b0ad76b44ab2eefe8ab41ca15de9` |

The full code-digest set is the plan's `code_hashes` (13 files); `verifyPlan`
refuses a live run whose tree differs from its freeze.

Real-id cost tables at the freeze (the estimator's ceilings, not spend):
`max_authority` and `safe` 72 initial + ≤ 36 escalation calls, ~389k input /
~162k output tokens, ≤ $4.92 each at the assumed prices; `forced` 72 calls,
~288k / ~88k, ≤ $2.57; the resume chain buys the typed set once, so the
cumulative ceiling of the core stays ≈ $7.27 under the $10 cap (budget
bounds: 180 calls, 650k input, 320k output tokens, $10).

## 6. Planned live arms and the cost ceiling

Three policies, one paid typed answer set. The typed requests are identical
under every policy, so the `max_authority` plan runs first and the other two
resume from its checkpoint by request digest: `safe` buys only its extra
escalations, `forced` buys nothing. Arm C (strong full-case) is bought once.
**The cap is experiment-wide:** every run carries a `budget.cumulative`
ledger (the resume chain's whole spend, re-bought escalations and
uncertain charges included) and refuses any call that would cross a bound
on either the run or the cumulative total. A budget may name model-specific
prices (`prices.models[<id>]`, private file) so a cheap arm is charged at
its own rate.

| Run | Arms | Calls (ceiling) | Est. USD at assumed prices (TypeSafe $1/$5, strong $5/$25 per M) |
| --- | --- | ---: | ---: |
| 1. `max_authority` | `jev_redesigned`, `strong_full_case` | 72 + ≤ 36 escalations | ≤ $4.92 |
| 2. `safe` (resume from 1) | same | + ≤ 36 escalations | ≤ $2.35 |
| 3. `forced` (resume from 2) | same | 0 new | $0 |
| Optional | `strong_atomic`, `cheap_full_case` (`JEV_CHEAP_MODEL`) beside the above under `max_authority` | 144 + ≤ 108 | ≤ $14.10 for the four-arm plan at the strong rate |

**Proposed cap: $10 for the three-policy core (cumulative ceiling ≈ $7.30);
$25 if the optional arms are added.** The runner refuses any call that would
cross it and invalidates the run on an overrun. Commands (Kari's laptop, zsh):

```
git pull --ff-only
set -a; source ~/.config/donna/jev.env; source .env; set +a
export DONNA_PG_TEST_URL=postgresql://$USER@127.0.0.1:55487/postgres
P=$HOME/private/jev
node scripts/jev_decision_plane.js --mode=dry-run --corpus=jev-plane-fresh --arms=jev_redesigned,strong_full_case --policy=max_authority --plan=$P/plan-fresh-max.json --budget=$P/budget.json
node scripts/jev_decision_plane.js --mode=dry-run --corpus=jev-plane-fresh --arms=jev_redesigned,strong_full_case --policy=safe --plan=$P/plan-fresh-safe.json --budget=$P/budget.json
node scripts/jev_decision_plane.js --mode=dry-run --corpus=jev-plane-fresh --arms=jev_redesigned,strong_full_case --policy=forced --plan=$P/plan-fresh-forced.json --budget=$P/budget.json
node scripts/jev_decision_plane.js --mode=live --plan=$P/plan-fresh-max.json --budget=$P/budget.json --output=$P/fresh-max.json --public=$P/fresh-max-public.json
node scripts/jev_decision_plane.js --mode=live --plan=$P/plan-fresh-safe.json --budget=$P/budget.json --resume=$P/fresh-max.json --output=$P/fresh-safe.json --public=$P/fresh-safe-public.json
node scripts/jev_decision_plane.js --mode=live --plan=$P/plan-fresh-forced.json --budget=$P/budget.json --resume=$P/fresh-safe.json --output=$P/fresh-forced.json --public=$P/fresh-forced-public.json
cp $P/fresh-max-public.json data/evals/experiments/jev-capability-boundary-fresh-max-2026-09-18.json   # and safe / forced
```

Read, in this order: the `boundary` rows of `fresh/jev_redesigned` under the
three policies against `fresh/strong_full_case`; the confidence-band table
under `forced` (does Jev know when it does not know?); `error_attribution`
per class and `escalations_by_attribution` / `incorrect_by_attribution`
(what the model decided versus what a rule or the routing policy decided
for it); `ontology_debt` per case. One shot: no tuning from the fresh
outcomes followed by a rerun.

## 7. Honest limits

- Labels are provisional and authored; the fresh set has not been
  independently adjudicated. Zero wrong among ~29 resolvable cases bounds a
  wrong-resolution rate only near 10 %. **The set carries no reasoning
  label a semantic answer can change** (two are rule-blocked, two are
  contract gaps, §4): it cannot locate a reasoning boundary, only bound it
  from below, and a reasoning limitation can appear in this run solely as a
  wrong autonomous resolution in the confidence table.
- "Missing" in code is the absence of any unbound source; it cannot tell a
  relevant unbound source from an irrelevant one, so an irrelevant chat in
  the packet turns a genuinely absent document into `uninterpreted` (an
  escalation, never a wrong ask). That errs toward the strong model, not
  toward the owner.
- Attribution is mechanical and reproducible, not adjudicated; a human may
  reclassify.
- The strong request changed (schema and prompt); arm C on the fresh set is
  that arm, not byte-for-byte the holdout's.
- Nothing about what Donna may post changes; every proposal awaits the same
  authority checks; the harness posts nothing.

## 8. Pre-run review (2026-09-18) and what it changed

An external review of the first freeze (six findings, relayed by Kari) was
applied before any live call; every item is pinned by a test.

1. **Ambiguous `unresolved_research` credit.** The lenient match is gone. The
   strong model has an explicit `no_settlement` route (RESOLVED, autonomous);
   its `unresolved_research` is "cannot finish" and is correct only against a
   reasoning label. Same rule on every arm; the label vocabulary's debt is
   named per case.
2. **`needs_evidence` conflated missing evidence with failed interpretation.**
   The compiler now claims "missing" only when the packet holds no unbound
   evidence at all and the candidate has no link anywhere; a link elsewhere
   or any unbound source makes the case `present_evidence_not_interpreted`
   (escalate; `forced`: a negative). The declaration-ask on an owner fact
   follows the same rule. Under unknown answers fresh-011/-012/-020 now
   escalate; only fresh-008/-010/-017 ask.
3. **The reasoning labels.** fresh-032 is relabelled RESOLVED (partial
   allocation of the evidenced 1 000,00 €, per dev-001b / holdout-028b; the
   tax question is the remainder's, not the allocation's). fresh-015 and
   fresh-025 are declared contract gaps and reported apart. A twelfth family
   adds a genuine reasoning case (two payment-specific sources that
   disagree) beside fresh-023. The task is stated: payment allocation of the
   focal invoice.
4. **Manufactured "confidently wrong".** Policy-imposed decisions are marked
   `imposed`, contribute no deciding probability and sit in their own band;
   every semantic veto's answer is recorded, so a .60 counterparty under
   `safe` is a `0.60-0.69` decision, not `mechanical`.
5. **Mixed resolution plus owner request.** Companion requests are labelled
   (`expected.evidence_requests`), expressible by both arms, and scored
   separately (`companions.match` gates `correct`;
   `companion_requests_missed` / `_unrequested` are measures).
6. **Cumulative spend.** `budget.cumulative` spans the resume chain and the
   cap applies to it; per-model prices are honoured.

dev-006 stays as the review read it: disputed, excluded from the designated
counts, reported inclusively, pending adjudication.

## 9. Pre-run review, second round (2026-09-18) and what it changed

The reviewer checked head `220d553` offline (53/53 focused tests, the corpus
digest `2292f6b4…` reproduced, no provider calls) and named four remaining
gaps; all four are applied and pinned by a test, before any live call.

1. **Companion requests now bind the initial decision** (`fresh-026`).
   `consequenceOf` matches companions on the arm's own decision
   (`own_companions`) as on its final one, so `own_correct`,
   `correct_autonomous_resolutions` / `wrong_autonomous_resolutions` and the
   confidence table never credit a proposal that omitted the labelled
   sibling request; the attribution names it (`companion evidence request
   omitted`, a full-case arm's own, the typed arm's `routing_policy`).
2. **A policy-imposed step makes the whole decision policy-imposed**
   (`fresh-027`). `policyImposed` is true on ANY imposed deciding answer and
   `decidingProbability` is then null: a forced wrong negative on the focal
   candidate no longer borrows the sibling exclusion's 1.0, lands in the
   `policy_imposed` band, and enters no `deciding_probability_mean`. The
   rule's justification is stated in code: under `forced` every imposed
   answer is essential to the route, because the same answers escalate
   under `max_authority`.
3. **The cheap arm reads a "cannot finish" as the strong arm does**
   (`fresh-011`). `FULL_CASE_ARMS` (strong and cheap full-case) share the
   full-case interpretation: `no_settlement` is RESOLVED and
   `unresolved_research` is REQUIRES_ACCOUNTING_JUDGMENT — incorrect and
   non-autonomous against a resolved-negative label — on both arms from the
   identical reply.
4. **fresh-023 and fresh-035 are rule-blocked, not measured** (§4). The
   fixtures carry `rule_blocked` (beside `contract_gap`) with rewritten
   terminal reasons; the corpus gate machine-checks the marker (ideal and
   unknown answers escalate on the marker's code with zero deciding
   answers, and a reasoning label without a marker must be changeable by a
   semantic answer); `boundary` reports `rule_blocked_reasoning_labels` and
   `genuine_needs_reasoning` counts only labels a semantic answer can
   change (0 on this set). The decision on the honest consequence is
   recorded in §4: no "ideal answer is unsure" family is authored; the set
   bounds the reasoning boundary from below only.
5. **Routing-policy attribution** (the reviewer's caveat on the accepted
   unbound-source rule). `error_attribution.attributed_to` names who decided
   every attributed result (`contract_rule` / `routing_policy` / `model`),
   and `boundary` carries `escalations_by_attribution` and
   `incorrect_by_attribution`, so an escalation on
   `present_evidence_not_interpreted` or a `customer_fact_not_established`
   with unbound evidence is counted as the policy's before anyone reads the
   escalation rate as Jev's. `present_evidence_not_interpreted` also joins
   the obligation-shaped class map (it classified as `other` before).
6. **Escalation cause and error cause are two attributions** (the
   reviewer's follow-up P2 on `79dbf46`, reproduced on fresh-034,
   fresh-035 and fresh-008 under `safe`). One field had carried both, so a
   strong fallback's wrong answer re-coloured the escalation that preceded
   it and a typed escalation's code re-coloured the model's error.
   `escalation_attribution` is read from the initial decision alone;
   `error_attribution` from the failing decision, with `authored_by`
   naming whether a full-case model wrote it; the two counters read their
   own field. This changes the explanation of failures, not the
   correctness scores.

Dispositions the reviewer accepted are not reopened: fresh-032 as a partial
allocation, the two contract-gap declarations, the unbound-source rule as a
conservative rule for this experiment, the cumulative ledger ($4.9192
first-run ceiling reproduced; ≈ $7.30 across the core sequence), dev-006
disputed and separately reported. The corpus digest moved with the two
marked fixtures (§5); the frozen corpora are byte-identical; the contract
and the runner are unchanged (their digests stand).

## Trust-the-strong-LLM principle — still in force

[CLAUDE.md](../../CLAUDE.md) and the [trust strategy](../donna-llm-trust-strategy.md)
govern. This work lets the typed model attempt more and lets code carry only
what code can verify (a reversed instrument, an absent source, arithmetic);
it grants no authority, changes no qualified model, and keeps the Keep
layer whole. Its intended lesson runs both ways: where Jev is confidently
wrong, that is an architectural fact to expose, not a threshold to tune.
