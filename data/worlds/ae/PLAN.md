# UAE executable accounting-world coverage plan

Status: **EXECUTION AUTHORIZED — Kari, 2026-08-31.** AE-0 is the first
implementation slice. Later slices remain separately reviewable and gain no
production authority merely by landing.

Trust-the-strong-LLM principle — still in force; see `CLAUDE.md`. The world
engine supplies sourced policy, schemas, arithmetic, identity, authority and
receipts. It does not grow deterministic language rules to manufacture green
extraction or classification scores.

## 1. Objective

Build jurisdiction-grade synthetic coverage for UAE bookkeeping across
mainland and free-zone businesses by extending the existing executable
accounting world. The corpus must expose country-specific failure classes,
exercise Donna's real runtime, and keep economic, evidence, policy, tax-period,
authority and external-state truth separate.

Synthetic results are capability-scoped evidence, never a production defect
rate or a claim that the AE pack is ready for customers.

## 2. Inherited architecture and boundaries

- Reuse `server/donna/world/**`; there is no AE-only generator or second
  oracle.
- Reuse production paths at the runner seam; never build an eval-only Donna.
- Keep world/oracle modules independent from solve modules and keep
  `worldBoundary.test.js` green.
- Keep policy effective-dated and sourced. A changed rule re-derives and
  re-audits affected cases; it never silently rewrites a golden.
- Each slice is one reviewable PR with its tests and tracker receipt. No slice
  flips production flags, writes a ledger, sends, files or pays.
- The current Arabic UI initiative remains separate. AE-6 consumes its
  verified locale/artifact contracts; it does not infer that Arabic UI makes
  Arabic document intelligence safe.

## 3. UAE truth axes

The corpus keeps these independent:

1. legal form and licensing authority;
2. mainland/free-zone establishment standing, emirate and effective date;
3. designated-zone status for VAT — a sourced fact, not inferred from the
   phrase "free zone";
4. VAT registration status/TRN/effective date and the FTA-assigned return
   period;
5. owner elections and mandates;
6. QFZP, de-minimis and Small Business Relief outcomes per tax period;
7. book, VAT, corporate-tax and filed-state consequences.

An entity profile never stores `is_qfzp`, `sbr_eligible` or another per-period
tax verdict as timeless identity.

## 4. Capability manifests

Coverage is split into explicit capabilities rather than one promise to "do
UAE bookkeeping":

- `record_ae_entity_tax_context`;
- `assess_ae_vat_registration`;
- `prepare_ae_vat_period`;
- `reconcile_ae_operating_cash`;
- `account_ae_payroll_and_statutory_costs`;
- `assess_ae_free_zone_ct_period`;
- `consume_pint_ae_invoice`;
- `understand_arabic_ae_bookkeeping_evidence`.

Each manifest names its entity types, required families, protected failures,
authority ceiling and safe blocked state before it can become release-blocking.

## 5. Corpus shape

Use six lifecycle worlds plus focused micro-fixtures and paired mutations:

1. mainland service LLC, VAT registered;
2. mainland SME crossing the VAT threshold;
3. sole establishment around the natural-person CT threshold;
4. non-designated free-zone service company;
5. designated-zone goods trader;
6. free-zone company passing, then breaching, the QFZP de-minimis test.

Every load-bearing rule receives boundary cases, a one-fact sensitivity pair,
an irrelevant-layout metamorphic pair and at least one temporal ordering pair.

## 6. Slice ladder

| Slice | Scope | Exit gate |
| --- | --- | --- |
| **AE-0 — world admission** | Jurisdiction-neutral world-spec construction; preserve the frozen Proof-0 scope; first AE entity-context world through existing validity and renderer paths | AE world passes schema/validity/render; a non-GB `proof0.world.v1` still fails; no AE tax outcome is projected |
| **AE-1 — entity and registration facts** | Mainland/free-zone/designated-zone axes; VAT registration and FTA period facts; mainland LLC, free-zone service company and sole-establishment families | Missing or conflated axes refuse by name; threshold −1/exact/+1 pairs remain distinct; period outcomes cannot live on the profile |
| **AE-2 — VAT documents and return** | Full/simplified invoices, seller/buyer TRN conditions, credit notes, deposits, foreign-currency VAT-in-AED, emirate split, imports/RCM, input recovery and apportionment | VAT201 semantic state and journals agree; customs imports and imported services cannot swap lanes; due dates use recorded FTA periods |
| **AE-3 — free-zone corporate tax** | QFZP conditions, qualifying/excluded income, de minimis, elections, audited-financial requirement, related parties and SBR effective dates | One-invoice de-minimis breach flips the period and four successors; services do not inherit designated-zone goods treatment; judgment blocks visibly |
| **AE-4 — payroll and operating obligations** | WPS batches, expatriate EOSB, GCC pension, alternative EOSB scheme, licences, visas, deposits, rent/prepayments and post-dated cheques | Payroll/bank/ledger tie; employee class selects the correct obligation; deposits and prepayments do not become immediate expense |
| **AE-5 — cash, FX and commerce** | AED/foreign-currency accounts, processor/marketplace/BNPL gross-to-net, refunds, chargebacks, reserves, fee VAT, bounced cheques and reference collisions | Cash and clearing drain to T1/T2; arrival-order pairs converge; no net-sales or duplicate-posting escape |
| **AE-6 — Arabic and PINT AE evidence** | Arabic/bilingual scans and native PDFs; both digit systems; bidi identifiers; valid Invoice/CreditNote plus malformed structured near-misses and PDF lookalikes | Canonical economics stay language-invariant; visual/copy order is correct; only valid structured payloads enter the PINT lane |
| **AE-7 — whole-period convergence and mutations** | Run the six worlds through the real runtime; oracle mutations, resets, replays, document-first/bank-first, hidden siblings and shrinkers | Every atomic obligation reaches T1/T2; all protected mutations are caught; replay is byte-stable and cross-entity leakage fails closed |
| **AE-8 — external anchoring and promotion** | Independent UAE practitioner review plus a licensed/redacted reality set spanning banks, free-zone authorities, payroll, FTA outputs and commerce | Load-bearing outcomes signed or explicitly unassured; layout gaps become fixtures; synthetic scores remain separate from production calibration |

## 7. Permanent mutation pack

At minimum the UAE oracle must detect:

- free zone treated automatically as designated zone or QFZP;
- AED 375,000 VAT registration confused with the similarly numbered CT
  taxable-income band;
- natural-person, SBR and QFZP revenue tests conflated;
- a QFZP breach applied only to one transaction instead of the affected
  periods;
- foreign-currency VAT omitted in AED or converted on the wrong date;
- imported services placed in the customs-import lane, or vice versa;
- blocked input VAT recovered;
- client entertainment made fully deductible without support;
- expatriate EOSB and GCC pension obligations swapped;
- a PDF lookalike accepted as a structured eInvoice;
- Arabic digits, bidi text or page order changing the economic result;
- a document/bank arrival-order change causing a different terminal result;
- evidence already held triggering another upload request;
- cross-firm or same-name identity leakage.

## 8. Effective-date and source policy

The first policy registry is pinned as of 2026-08-31. Primary anchors include:

- FTA VAT registration and return guidance;
- FTA designated-zone and free-zone corporate-tax guides;
- Ministerial Decision 229 of 2025 for qualifying/excluded activities;
- Ministerial Decision 131 of 2026 for Small Business Relief through tax
  periods ending on or before 2029-12-31;
- FTA tax-invoice, foreign-currency, input-recovery and CT-return guidance;
- MoHRE WPS/EOSB guidance;
- MoF/FTA PINT AE and eInvoicing publications.

The stale 2026 Small Business Relief sunset in
`docs/design-donna-ae-freezone-and-wafeq.md` is not admissible policy truth.
AE-3 carries its correction and a before/after effective-date regression.

## 9. Data acquisition

Programmatic world-first artifacts are sufficient through AE-7. AE-8 requires
permissioned, redacted real documents; random internet PDFs do not become
goldens merely because they look realistic. Public official schemas and blank
forms may anchor structure but cannot establish real bank, authority or vendor
layout prevalence.

## 10. Programme acceptance

The programme is complete only when:

- all eight capability manifests have explicit authority/fallback contracts;
- all six lifecycle worlds pass schema, causal validity and independent policy
  projection;
- every permanent mutation is caught at its predeclared check;
- Arabic/English and observation-order pairs preserve canonical economics;
- the real runtime drains every in-scope obligation to T1/T2;
- resets and replays are deterministic and cross-entity isolation is proven;
- a UAE practitioner has reviewed the load-bearing VAT/CT/payroll outcomes, or
  those capabilities remain explicitly non-blocking;
- no result is represented as production readiness without separate
  production calibration evidence.

## Execution tracker

| Slice | State | Evidence | Next |
| --- | --- | --- | --- |
| AE-0 | complete | 33 focused checks; 326 world/eval checks; all 784 repository test files; production build | Merged; foundation available to later slices |
| AE-1 | complete | 23 focused checks; 354 world/eval checks; all 798 repository test files; production build | Merged in #1892; opens AE-2 through AE-5 |
| AE-2 | complete | 20 focused checks; 404 world/eval checks; all 806 repository test files; production build; supported VAT201 subset exact, with customs Box 6 and partial-recovery runtime gaps named | Rebased over merged AE-3/4/5; keep the two production gaps non-blocking until separate production slices close them |
| AE-3 | complete | 10 focused checks; 374 world/eval checks; all 803 repository test files; production build | Merged in #1898; no production authority granted |
| AE-4 | complete | 10 focused checks; 384 world/eval checks; all 804 repository test files; production build | Merged in #1899; exact WPS/ledger tie, four employee classes/schemes, five temporal pairs, nine named protected mutations |
| AE-5 | complete | 10 focused checks; 364 world/eval checks; all 800 repository test files; production build | Merged in #1897; exact AED/FX and four gross-to-net groups; 13 protected mutations |
| AE-6 | complete | 79 focused parser/renderer/world checks; 414 complete world/eval checks; all 834 repository test files; production build; three Invoice language variants share one canonical digest; CreditNote remains distinct with signed economics; all 11 protected mutations caught | Implementation PR pending Claude gatekeeping; Arabic remains undeclared and AR-4F human review is deferred until preview alpha; AE-7 starts only after merge |
| AE-7 | incomplete | Offline certificate: 25 focused checks; 439 world/eval checks; all 836 repository test files; build; 68 obligations at 67 T1 + 1 named-owner T2 + 0 limbo; all 19 mutations and 4 identity collisions refused; zero spend | Run the named-writer crash/resume, persisted observer and zero-residue retirement lifecycle in pinned real PostgreSQL; do not promote the offline certificate to production completion |
| AE-8 | blocked | dispatch prompt ready | Waits for AE-7 plus permissioned reality data and practitioner review |

The self-contained dispatch handouts live in `data/worlds/ae/dispatch/AE-3.md`
through `AE-8.md`. AE-2 through AE-5 are complete. The later prompts carry
hard fail-closed launch gates so parallel work cannot
serialize ahead of the verified Arabic, convergence or external-assurance
dependencies.

## Subscription-service readiness audit — 2026-09-09

The [service readiness tracker](../../../docs/donna-uae-service-readiness-2026-09-09.md)
audits the completed-books subscription brief against runtime base
`2b2316d60b573adcfce8cb8516b1794ea4c7d8d9`. It records 26 capability rows,
explicit evidence-milestone percentages, current production gaps and a proposed
execution sequence. A clean focused run passed 417 checks across 40 files,
including nine real-PostgreSQL lifecycle suites, with zero skips. This does not
graduate AE-7 or AE-8: the whole-period runner still declares its four persisted
runtime prerequisites incomplete. No launch, service scope expansion or
implementation is authorized by this audit. Existing slice acceptance remains
binding; the tracker adds the service-level distinction between managed owner
questions and a finalized accounting period.

CC review incorporated 2026-09-09: the audit now distinguishes active AE posting/invoice error paths from missing capabilities, records management-only admission, adds U26 retention and D05 provider standing, and maps each row to existing manifest duty ids or an explicit gap. This is audit evidence, not a runtime fix or GTM amendment.

Later on 2026-09-09, Kari authorized engineering execution with parallel sessions. [Execution wave 1](../../../docs/plan-2026-09-09-uae-execution-wave1.md) dispatches U08-S1 posting safety, U15-S1 invoice requirements and U25-S1 persisted-runtime diagnostics in isolated worktrees. This supersedes the preceding audit's no-implementation boundary, but does not advance any completion score or AE-7/AE-8 certificate. Each implementation task owns its named slice receipt; the coordinator owns the aggregate readiness evidence.

### U25-S1 — runtime diagnostic (2026-09-09)

Implemented, pending gatekeeper review; **AE-7 remains INCOMPLETE**.
[Scope and acceptance](../../../docs/design-2026-09-09-ae7-runtime-diagnostic.md).
The existing runner now has an explicit disposable-PG diagnostic: raw PDF/CSV
intake in both orders, process loss after committed queue admission, new-process
resume/replay, production persisted observer and named retirement/zero-residue
checks. One AED 1,050 bank row parses per order; the invoice's durable job reports
`openai_not_configured`, the uncoded bank line remains hanging, and no journal or
owner ask is fabricated. Missing schema/dependencies fail loudly. The offline
68-obligation certificate stays separate. Full writer crash matrix, actual
intelligence/period completion, remaining AE functional dependencies and AE-8
external assurance remain owed. No launch or production authority is granted.

## U15-S1 — active full-invoice buyer TRN floor

Engineering authorized 2026-09-09. **Implemented; draft PR/gatekeeper review
pending.** [Slice contract and acceptance](../../../docs/design-2026-09-09-ae-invoice-floor.md):
market-neutral buyer-conditional floor, attributed dated party facts, actual
owner-input/ask continuation, draft and send revalidation, English/Arabic
statutory fields and immutable receipt proof. Dedicated disposable PostgreSQL
tests drive the full current schema and real writers; mail/model transports
alone are mocked. No live customer database, messages or paid model calls used. Node 20 full-suite
proof: 942 passing test files + 9 expected-failure fixtures (all fingerprints
matched), zero quarantine; build and bilingual PDF visual checks passed.

U15 remains open. Gap 12 is implemented; gap 14 remains open and AE issuance
is AED-only. Recurring supply facts, structured e-invoicing and broader
statutory delivery are not claimed. No launch or service authority is granted.

## U08-S1 — transaction posting safety (2026-09-09)

Engineering execution authorized by Kari on 2026-09-09; this readiness slice is
separate from the world/evaluation ladder above. Implemented for draft review
from `fc1eec1b56943b750d5a44255f0d9bc4782f8e5b`:
[scope, acceptance and recovery contract](../../../docs/design-2026-09-09-ae-posting-safety.md).
Exact AE treatments/native codes now meet prepare and commit guards; required
standard/RCM tax legs refuse explicitly until implemented. Valid no-split
semantics preserve native codes; absent split capability is declared honestly.
Unknown/name-only account classes require resolved treatment. The actual Xero
export validates before HTTP, rechecks source/context/chart before send, and
keeps native mirror codes separate from the supported explicit NONE/NoTax
provider contract; other provider mappings remain unsupported.
Refusals use the existing visible runtime repair ownership/retry lifecycle,
without invented owner evidence requests. Native posting and whole-period
T1/T2 completion remain open U08 dependencies. Proof: 63 focused checks, zero skips, including real-PG preparation/commit/
correction/incident lifecycle; full Node20 suite: 941 passing files plus 9 matched
expected-failure fixtures, zero quarantines; build passed. Review corrections add
25 pure/recovery checks and seven actual-Xero real-PG checks, all passing without
skips; corrected full-suite result pending. No launch, filing, provider or
paid-inference authority is added.


## U08-S2 — native standard-rate AED posting (2026-09-09)

Implemented for draft review from `15dba008ad3a23f6f0db4a7f2b8777c96947e1d7`:
[contract, primary sources and evidence](../../../docs/design-2026-09-09-ae-native-vat-posting.md).
An attributed review correction binds one retained sales invoice or supplier bill
to a fully paid same-day AED bank line. The existing transaction writer posts
net 100 / VAT 5 / bank 105, with explicit full input recovery and one existing
canonical VAT control. Native statutory receipts feed the existing VAT201,
including closed journals; this is not a cash-basis VAT election.

Missing/unsupported facts, stale evidence, duplicate invoice use, ambiguous chart,
different tax points and disabled tax coding refuse through existing repair
ownership. Actual Xero remains unsupported for standard/RCM before provider
calls, even with native-postable facts. No new journal writer or migration.
Proof additionally passes on an actual API-created/admitted client using the
U02 setup consumer and exact name-only chart: real retained PDF upload, review
account/fact intake, attributed API posting and VAT201. No final chart/certificate/
journal is seeded in that proof. Native lifecycle12 and shared/country regression85
checks pass with zero skips; clean AE7 diagnostic5 passes. Final clean frozen
full-suite/build receipts are recorded in PR review. Full U01/U02 ancestry is required. U08 remains partial: generic receipts, automatic tax-fact generation,
foreign currency, AP/AR, RCM, general period allocation and filing remain open.
No world score, service, launch, provider or paid-inference authority is changed.
## U01-S1 — Accounting view and method admission (2026-09-09)

Design/receipt: `docs/design-2026-09-09-ae-accounting-admission.md`.
This slice separates management/statutory view from cash/accrual method through
existing creation/profile writers, mounted Profile controls, Certificate B and the
readiness invalidation/recovery path. Historical omitted fields retain their shape;
explicit unknowns and conflicting declarations cannot manufacture readiness.
Certificate B v3 states its technical birth scope. AE statutory admission remains
refused; no statutory profile, external authority or readiness score is added.
Remaining statutory dependencies: U02, U08, U10/U11, U13, U19/U20, U26 and external
D01/D05. Full evidence and rollback are recorded in the dedicated receipt.


## U02-S1 — opening trial balance source slice (2026-09-09)

Source contract: `docs/design-2026-09-09-ae-opening-balances.md`. Depends on U01
accounting-profile admission commit `0b769250`; adds an off-by-default AED complete
owner trial-balance intake, persisted confirmation/reconfirmation, exact actor and
source receipts, same named opening journal writer, ask closure, and shared account
setup for the U08 prerequisite. Nonzero AR/AP/tax/inventory carry-in, statutory
migration, tax carry-forwards and depreciation schedules remain unsupported.
Real PostgreSQL proof uses actual AE create/upload/period/account-setup routes,
normal confirm/cancel/reply consumers, mutation refusals and concurrent close with
pool size two. Source PR pending parent review; no aggregate readiness or score
increase is asserted. Parent retains integration and merge authority.
## UAE engineering tournament 2 — 2026-09-09

Wave 1 is merged through PR #2084 at `15dba008ad3a23f6f0db4a7f2b8777c96947e1d7`: invoice safeguards, VAT posting refusals and bounded persisted runtime diagnostics. Combined local and UTC/Dubai gates pass; AE-7/AE-8 do not graduate. Kari requested the next tournament. [Wave 2 board](../../../docs/plan-2026-09-09-uae-execution-wave2.md) dispatches U08-S2 native standard VAT journals, U02-S1 AED opening balances and U01-S1 accounting-view/basis admission with exclusive named-function ownership, actual-consumer PostgreSQL proof and a combined merge gate.
