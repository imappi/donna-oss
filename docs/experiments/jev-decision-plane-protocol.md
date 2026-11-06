# Jev decision-plane experiment: pre-registered protocol and frozen corpus

Status: protocol and corpus authored 2026-09-18 (workstream C of the Jev / TypeSafe
investigation). No provider calls were made; no model was evaluated; no production
behaviour, configuration, schema or writer changed. This document freezes what a
later paid run may and may not touch. It follows the
[architecture reset](jev-architecture-reset.md) §3, §4, §6 and §7 and the
[evidence-to-action contract](jev-evidence-action-contract.md).

## 1. Hypothesis under test

The redesigned decision plane — contract questions (`counterparty`, `processor`,
`reference`, `obligation`, `exclusion`, `customer_fact`), action-specific composition
(`composeEvidenceAction`) and targeted escalation — resolves a materially larger
share of payment/evidence-matching work correctly than the blanket contract,
with **≤ 20 % strong-model escalation on the model-dependent holdout, zero wrong
proposals, no more false owner questions and no more unresolved cases than
strong full-case reasoning, at ≥ 2× cascade speed**. Passing warrants larger shadow
validation only; it never authorises posting.

## 2. Corpus, sizes and the sizing decision

Two directories, packet format exactly `jev-evidence-action-v1` (enforced by
`checkedSnapshot`), produced deterministically from hand-written per-family specs by
`scripts/jev_decision_plane_corpus_author.js` (no random mutation; every variant is an
explicit override with its own label reason). `scripts/jev_decision_plane_corpus.test.js`
is the expressibility gate on real PostgreSQL.

- `data/evals/fixtures/jev-plane-dev/dev-001..044.json` — **development**: 44 cases, 22 families.
- `data/evals/fixtures/jev-plane-holdout/holdout-001..084.json` — **holdout**: 84 cases, 28 families.

Recorded mix (machine-checked against the fixtures by the test):

- development: 44 cases, 22 families, 35 model-dependent; supported_proposal 17, strong_reasoning 15, customer_question 2, unresolved_research 6, not_admitted 2, retrieve_local 2
- holdout: 84 cases, 28 families, 71 model-dependent; supported_proposal 45, strong_reasoning 10, customer_question 3, unresolved_research 15, not_admitted 5, retrieve_local 6

Markets: development GB 20 / FI 12 / SG 12; holdout GB 27 / FI 27 / SG 30.
Holdout model-dependent share: 71/84 = 84.5 % (declared minimum 70 %).

**Model-dependent — the operational rule (reconciled 2026-09-18, before any call).**
The harness (`scripts/jev_decision_plane_protocol.js`, `commonRoute`) charges a
case to every arm when the contract generates questions and the only thing
stopping composition on an empty answer set is answer coverage: an arm cannot know
before asking that a mechanical conflict will decide the case. That rule gives
**73 model-dependent holdout cases and 43 development cases** (the review examples
`review-01..04` sit in the development directory and are counted there). The
author's stricter flag — the ideal composition actually consumes an answer — gives
71 and 35; the difference is cases with an eligible candidate whose route is fixed
by a mechanical conflict or direction check regardless of the answers
(holdout-045, holdout-053; dev-015, dev-029, dev-040, dev-041). **The escalation
denominator is the harness count (73)**; the fixture flag stays recorded as the
stricter view and both are reported. Cases decided before any question exists
(retrieval incomplete, not-due/settled admission, no eligible candidate) are
common no-model routes and are charged to no arm.

**Why 44 + 84, not 60 + 120.** The question is whether escalation on the
model-dependent holdout can sit at or below 20 %. With n = 71 model-dependent cases,
a Wilson 95 % interval around an observed 20 % is roughly 12–31 pp wide, and an
observed 7/71 ≈ 10 % has an upper bound near 19 % — so 71 cases can separate "about
10 %" from "20 % or worse", which is what the continuation decision needs; 120 cases
would narrow the interval by only ~3 pp while doubling authoring cost. Variants inside
a family are not independent, so the honest effective size is nearer the 28 holdout
families than the 84 cases; report family-clustered intervals. Development at 44
cases / 22 families suffices for expressibility and threshold *inspection*, not for
estimating thresholds. **No size here proves rare-error safety**: zero wrong proposals
in 71 cases bounds the wrong-proposal rate only at about 4 % (rule of three), nowhere
near the 1-in-1,000 a public posting surface would need.

**Deviation from the suggested route mix, on purpose.** The brief suggested
20–30 % `strong_reasoning`. A label-required strong route is an unavoidable
escalation, so a holdout with 25 % ideal-strong cases makes the ≤ 20 % target
unattainable even for a perfect reader. The holdout therefore carries 10/84
label-required strong cases (14 % of the model-dependent denominator: the
**escalation floor**), leaving ~6 pp of headroom; the ambiguous-evidence stress lives in
development (15/44 strong). `customer_question` is 3/84 (below the suggested 5–10 %)
because the label-review rule — an owner question must be grounded in the evidence
shape (owner-initiated payment, no message, complete inventory), never in a source
saying "only the owner knows" — leaves few justified owner questions in a
receivables-heavy set; the three present are all owner-initiated payments.

### 2.1 Development families (stress and calibration; may be tuned against)

| Family | Market | Cases | Ideal routes | Error mode |
| --- | --- | --- | --- | --- |
| `dev-gb-fpi-direct-reference-supplier-bill` | GB | 001–002 | SP, SP | short payment allocated by reference |
| `dev-fi-sepa-viitenumero-supplier-bill` | FI | 003–004 | SP, SR | viite typo; structured reference decides |
| `dev-sg-paynow-sales-invoice-reference` | SG | 005–006 | SP, SR | second unreferenced same-day credit |
| `dev-gb-two-bacs-same-supplier-two-equal-bills` | GB | 007–008 | SR, CQ | owner-initiated twins with sequence messages |
| `dev-fi-card-purchase-with-supplier-receipt` | FI | 009–010 | SP, SR | reference-free receipt vs party/amount/date decoy |
| `dev-gb-stripe-payout-eur-invoice-gbp-settlement` | GB | 011–012 | SP, SR | FX payout; fee arithmetic mismatch |
| `dev-sg-stripe-payout-without-report` | SG | 013–014 | SR, UR | processor ≠ customer; report naming a sibling |
| `dev-gb-remittance-names-other-invoice` | GB | 015–016 | SR, UR | bank reference vs remittance conflict; exclusion |
| `dev-gb-repeated-po-reference-monthly-retainer` | GB | 017–018 | SR, SP | repeated PO across months; remittance resolves |
| `dev-sg-payment-before-invoice-pro-forma` | SG | 019–020 | SP, SR | payment precedes invoice date |
| `dev-gb-retainer-deposit-vs-invoice` | GB | 021–022 | UR, SP | deposit on account vs applied part payment |
| `dev-fi-bank-line-already-allocated` | FI | 023–024 | SR, NA | consumed bank line; full prior settlement |
| `dev-sg-invoice-not-yet-due` | SG | 025–026 | NA, SP | not-due admission vs early payment |
| `dev-gb-remittance-pdf-not-yet-retrieved` | GB | 027–028 | RL, RL | truncated retrieval; pending collision |
| `dev-fi-conflicting-and-duplicate-remittances` | FI | 029–030 | SR, SP | conflicting advices; identical forwarded copy |
| `dev-gb-owner-card-purchase-private-or-business` | GB | 031–032 | CQ, SR | justified owner fact; fact already in a source |
| `dev-sg-remittance-with-prompt-injection` | SG | 033–034 | SP, SR | instruction text as data; amount conflict |
| `dev-gb-gocardless-direct-debit-payout` | GB | 035–036 | SP, UR | DD payout; report naming a sibling |
| `dev-fi-split-payment-two-transfers-same-viite` | FI | 037–038 | SP, SR | exact split; group over-allocation |
| `dev-sg-supplier-refund-wrong-direction` | SG | 039–040 | SP, UR | money-in refund beside the real payment |
| `dev-gb-stripe-payout-covering-two-invoices` | GB | 041–042 | SR, SP | **contract gap**: bundled two-invoice payout |
| `dev-fi-no-candidate-and-credit-note-netting` | FI | 043–044 | UR, SP | zero candidates; **contract gap**: credit-note netting |

### 2.2 Holdout families (never tuned; whole families; no legacy scenario shapes)

| Family | Market | Cases | Ideal routes | Error mode |
| --- | --- | --- | --- | --- |
| `holdout-sg-airwallex-usd-invoice-sgd-settlement` | SG | 001–003 | SP, UR, SR | USD→SGD settlement; sibling invoice; net mismatch |
| `holdout-fi-paytrail-webshop-settlement` | FI | 004–006 | SP, SP, UR | tilitys; partial capture; refunded order |
| `holdout-gb-paypal-sale-and-balance-withdrawal` | GB | 007–009 | SP, RL, UR | two-hop PayPal; report missing; reversed sale |
| `holdout-sg-customer-po-number-as-payment-reference` | SG | 010–012 | SP, SP, SP | PO reference; parent-company payer; milestone partial |
| `holdout-gb-wise-eur-receipt-into-gbp-account` | GB | 013–015 | SP, SR, UR | Wise FX receipt; one-penny mismatch; sibling |
| `holdout-fi-supplier-statement-of-account` | FI | 016–018 | SP, UR, SP | saldoerittely; applied to older bill; concordant |
| `holdout-sg-cheque-deposit-with-remittance-slip` | SG | 019–021 | SP, SP, SR | cheque slip; second customer's cheque; bounced |
| `holdout-gb-shopify-payments-payout` | GB | 022–024 | SP, SP, UR | Shopify payout; delayed; other order |
| `holdout-fi-invoice-copy-uploaded-twice` | FI | 025–027 | SR, SP, NA | duplicate document viite; corrected invoice; settled |
| `holdout-sg-overpayment-and-short-payment` | SG | 028–030 | SP, SP, SP | overpayment with advice; bank charges; split |
| `holdout-gb-sumup-card-reader-payout` | GB | 031–033 | SP, SP, RL | SumUp payout; two payouts; receipt pending |
| `holdout-fi-instant-transfer-to-private-person` | FI | 034–036 | CQ, SR, SP | owner fact; fact in source; freelancer receipt |
| `holdout-sg-invoice-financing-third-party-payer` | SG | 037–039 | SP, UR, RL | financier pays; other invoice; schedule missing |
| `holdout-gb-director-pays-from-personal-account` | GB | 040–042 | SP, SP, NA | individual payer; prior email; not due |
| `holdout-fi-invoice-number-in-message-instead-of-viite` | FI | 043–045 | SP, UR, SR | message reference; sibling; viite vs message |
| `holdout-sg-four-paynow-credits-one-week` | SG | 046–048 | SP, SP, SP | four candidates, three siblings; statement email; split |
| `holdout-gb-supplier-card-payment-with-payment-received-email` | GB | 049–051 | SP, SP, SP | card + supplier email; settlement lag; two charges |
| `holdout-fi-payment-returned-and-resent` | FI | 052–054 | SR, UR, SP | returned transfer; rejected allocation; re-sent |
| `holdout-sg-quarterly-contract-reference-repeated` | SG | 055–057 | SR, SP, NA | repeated contract ref; email resolves; not due |
| `holdout-gb-invoice-plus-late-payment-interest` | GB | 058–060 | SP, SP, UR | interest on top; separate interest invoice; interest only |
| `holdout-fi-mobilepay-business-settlement` | FI | 061–063 | SP, SP, RL | MobilePay settlement; prepayment; report failed |
| `holdout-sg-owner-transfer-from-personal-account` | SG | 064–066 | CQ, UR, SP | owner fact; capital top-up; deposited customer cash |
| `holdout-gb-saas-subscription-card-charges` | GB | 067–069 | SP, NA, SR | SaaS receipt; not due; identical charges |
| `holdout-fi-two-suppliers-with-similar-names` | FI | 070–072 | SP, UR, UR | viite identity; rent message; other supplier's viite |
| `holdout-sg-deposit-then-balance-with-prior-allocation` | SG | 073–075 | SP, NA, SP | prior partial; fully settled; both unallocated |
| `holdout-gb-remittance-pdf-retrieval-states` | GB | 076–078 | RL, SP, RL | pending / present / failed retrieval |
| `holdout-fi-forwarded-remittance-with-instruction-text` | FI | 079–081 | SP, UR, SR | injection as data; sibling; amount conflict |
| `holdout-sg-owner-paid-supplier-two-equal-bills` | SG | 082–084 | CQ, SP, UR | owner intention; owner statement; other bill |

Hard negatives and traps present in both splits: same party/amount/date with no
affirmative evidence; remittances naming another invoice; duplicate and conflicting
remittances; repeated references; wrong cash direction; already-allocated bank lines;
FX processor payouts with exact fee arithmetic; processor ≠ customer; justified and
unjustified owner facts; reference-free receipts that do support a match;
instruction-like sentences inside evidence.

## 3. What is frozen before holdout execution

1. **Evidence and labels.** The 84 holdout fixtures, their `semantic_statuses`,
   `expected` and `adjudication` blocks. The test asserts the committed files equal the
   author's output; any change is a new corpus version, never an edit.
2. **Questions and answer mapping.** `prepareEvidencePacket`'s question set and
   instructions, and the provider answer adapter in
   `scripts/jev_decision_plane_protocol.js` (`atomicQuestions`, `validateAtomicResponse`,
   `contractAnswers`: status = the chosen option, confidence = the API's probability
   for that option, citations = source handles whose grounding answer reaches
   majority mass, `processor`/`exclusion` asked only where the evidence shape makes
   them applicable, never manufactured; revised 2026-09-18 from the first
   development run's ablation, before the holdout) as documented in
   [the comparison design](jev-decision-plane-comparison.md); the frozen plan
   records its digest (`code_hashes`) before the first paid call.
3. **Action policy and thresholds.** `composeEvidenceAction` as committed, and
   `CONFIDENCE_FLOOR = 0.90` — an **unvalidated research policy**, not a calibration
   claim. Development data may be used to inspect calibration and to choose the floor;
   once chosen it is fixed for the holdout.
4. **Comparison arms** (identical prepared packets, identical eligibility SQL):
   A — current blanket Jev contract with its honest fallback; B — redesigned Jev
   contract (typed questions → `composeEvidenceAction` → targeted escalation to one
   bounded strong call carrying the full collision group); C — strong full-case
   reasoning free to solve the actual contract; D — strong model answering the
   redesigned atomic questions (isolates model from architecture).
5. **Metrics and denominators** (§4), **spend bound and stopping rules** (§5).
6. **Code digests** of `jev_evidence_action_contract.js`, `jev_evidence_action.js`,
   `jev_routed_protocol.js`, `reconciliationLlmCore.js`, `issuedInvoiceSettlementMath.js`,
   `localEvidenceInventory.js`, `evalHarness.js` and the author, as `runContract`
   already records them.

## 4. Metrics and denominators

Report every metric twice: over all holdout cases (84) and over model-dependent cases
(73 by the operational rule; 71 by the fixture flag — both reported). Report per market and per lane (identity, reference, obligation, exclusion,
customer fact). Intervals: Wilson 95 % on cases and a family-clustered bootstrap.

| Metric | Definition | Denominator |
| --- | --- | --- |
| Strong escalation | cases where arm B issued ≥ 1 strong call | model-dependent |
| Escalation floor | label-required `strong_reasoning` cases (10 of the 73) | model-dependent |
| Excess escalation | escalations on cases whose label is not `strong_reasoning` | model-dependent minus floor |
| Correct completion | route and proposals equal the label | all; model-dependent |
| Wrong proposal | a proposal the label does not contain (counted even if a later guard would catch it) | all |
| False owner question | `customer_question` where the label is not | all |
| Missed owner question | label `customer_question`, arm did not ask | all |
| Unresolved | `unresolved_research`/`strong_reasoning` where the label is a completion | all |
| Per-question accuracy | answer status equals the ideal status; also citation validity and refusal counts | questions |
| Owner interruptions | questions the owner would receive, per 100 cases | all |
| Cost and latency | strong calls, tokens, retrieval/drafting calls per completed case; p50/p95 serialized inference latency; cascade speed = Σ latency(C) / Σ latency(B), escalation included | all |

## 5. Spend bound and stopping rules

- Max calls, from the frozen dry-run plans (`jev_decision_plane.js --mode=dry-run`):
  holdout 292 initial + 146 escalation ceilings = **438**; development 172 + 86 =
  **258** (arm A's fallback reuses arm C's call and adds none; arms B and D each
  carry one escalation ceiling per model-dependent case). Retries count as calls.
- Max USD = Σ over arms of (cases × price per call at the frozen per-call token
  ceiling) + escalation calls × strong price ceiling, computed from the provider price
  lists on the run date and written into the budget file the runner requires
  (`--budget`, `approved: true`, per-provider prices) **before** the first call; the
  runner refuses any call that would cross a bound and reconciles actual usage after
  each call. Dry-run ceilings at assumed prices (strong $5/$25 per million input/output,
  TypeSafe **unknown**, assumed $1/$5): holdout ≈ 1.61M input / 0.61M output tokens ≈ $20;
  development ≈ 0.83M / 0.35M ≈ $11. The recorded cap is the number Kari approves.
  The runner reserves each estimate before dispatch, retains the estimate of any
  call whose response never arrives, and invalidates the run (`invalid_budget_overrun`)
  if actual usage crosses a bound the estimate did not predict.
- Request size: the harness refuses at plan time any frozen request above
  128,000 characters. The holdout's four-candidate families (holdout-046/047)
  freeze ~92k-character requests carrying 120–125 typed questions; requests of
  that size are untested on the live TypeSafe API. The development run, which goes
  first, exercises up to ~44 questions per request; a provider rejection of the
  larger holdout requests stops the run as INCOMPLETE and is a finding about
  request composition, not a reason to split questions across calls silently.
- A provider failure that survives one retry, a malformed answer rate above 10 % in
  any arm's first 20 cases, or reaching either cap **stops the run**; the report is
  marked `INCOMPLETE` with the case count reached, and nothing partial is used for a
  continuation decision.
- **Dated deviation (2026-09-18, recorded before the resumed holdout run, after
  the first holdout run stopped on `holdout-046/strong_atomic` with
  `provider_http_400` in 552 ms).** The strong provider refused the 90-question
  schema-constrained atomic request outright; its documented cause class is a
  compiled-grammar complexity limit on `output_config.format` (the threshold is not
  published; the largest schema that had succeeded carried 40 questions). The one
  retry this rule allows is, for that case only, the same frozen request WITHOUT
  `output_config`: the questions, prompt, model, output allowance and validator are
  unchanged, the refused attempt is charged and recorded in `failures[]` with the
  provider's error type, and the receipt carries `fallback: schema_dropped` and the
  digest of the request actually sent. Questions are never split across calls. A
  request refused twice still stops the run. The holdout record reports which cases
  needed the fallback; an unconstrained answer that fails validation is that arm's
  malformed failure, as for any other answer.
- Development cases may be run first for calibration; their spend is counted
  separately and does not draw on the holdout cap.

## 6. Continuation targets (pre-registered)

All must hold for the redesigned arm B on the model-dependent holdout:

1. Strong escalation ≤ 20 % of the 73 (floor 10/73 ≈ 14 %; also report excess escalation).
2. Zero wrong proposals.
3. False owner questions ≤ arm C's; unresolved cases ≤ arm C's.
4. Cascade speed ≥ 2× arm C at comparable correct completion (within the family-
   clustered interval).

Any dangerous regression (a wrong proposal, a false owner question on a case where
arm C did not ask) fails the gate regardless of the other numbers. Passing warrants a
larger shadow validation, not autonomous posting.

## 7. Failure taxonomy and the smallest follow-up per class

| Class | Attribution rule | Smallest follow-up |
| --- | --- | --- |
| Missing evidence | the packet lacks a source a human would need | re-author the family with the source; it stays out of the holdout |
| Bad label | independent review disagrees with the ideal status/route | correct the label in a new corpus version; re-score only that family |
| Extraction error | a rendered field disagrees with the source text | fix the author's renderer; regenerate; diff must touch only that field |
| Poor question decomposition | the ideal answers are correct but the compiler cannot reach the label | contract change with a regression fixture; re-run the expressibility gate |
| Model limitation | ideal answers reach the label, the model's answers do not, citations valid | one focused question variant on the failing lane, run on development only |
| Composition defect | valid answers, wrong route/proposal | unit test reproducing it; fix; re-run both splits |
| Expensive fallback | correct outcome only after strong escalation | measure whether a warm alias/processor mapping (§4.6 of the reset) removes it, on development |

## 8. Statements of scope

- Development data may be used for calibration, prompt wording and threshold choice.
  **The holdout is never tuned**; a look at holdout answers to adjust anything ends the
  holdout's validity and requires a new family set.
- A small sample with zero errors is not proof of rare-error safety (§2).
- Proposal accuracy is not bookkeeping completion: a `supported_proposal` is a
  proposal awaiting existing authority checks; `not_admitted` and `retrieve_local`
  complete nothing; a justified owner question is a valid terminal but not automatic
  completion.
- All labels are provisional and authored synthetic; no case is independently
  adjudicated. Gold-set use requires the independent review the contract document
  names.

## 9. Inexpressible under the current contract (findings, not trimmed scenarios)

1. **Bundled multi-invoice settlement** (`dev-041`): one payout truthfully covering two
   invoices is two links on one candidate and is refused as `conflicting_allocations`.
   The accounting answer (allocate both) needs a group allocation across invoices.
2. **Credit-note netting** (`dev-044`): a payment net of a credit note allocates the
   cash correctly but the credit note settling the remainder is outside the contract.
3. **Third-party payers** (holdout-011, -019, -037, -040, -041, -066): a parent company,
   a cheque drawer, a financier, a director or the owner depositing customer cash can
   only be expressed through the `processor` predicate ("represents the customer").
   The vocabulary should name representation generally, not processors.
4. **Duplicate documents of one invoice** (holdout-025): a re-uploaded copy is a related
   invoice with the same reference and blocks as a repeated reference.
5. **Customer PO numbers as the linking reference**: the reference path recognises only
   the invoice's own number; PO-based association needs an advice (holdout-010) — the
   packet carries one `reference` per invoice, so invoice number vs viite must be chosen
   by the author (holdout-043 carries the invoice number).
6. **Fees deducted before conversion** (holdout-013): the link carries only a bank-
   currency fee, so a EUR fee on a GBP receipt is recorded as delivered gross with zero fee.
7. **Refund/chargeback adjustments inside a payout** and **non-two-decimal currencies**
   are not authored at all; the contract has no fields for them.

## 10. Trust-the-strong-LLM principle — still in force

[CLAUDE.md](../../CLAUDE.md) and the [trust strategy](../donna-llm-trust-strategy.md)
govern. This protocol measures whether a typed decision plane can do a bounded job
well; it does not retire the strong extractor, add vendor-specific repairs, change
qualified models, or grant any writer authority. Unresolved outcomes are reported as
failures, never relabelled as terminals.
