# FIK-1 — clause inventory of the current Finnish coding guidance (2026-09-23)

**Status:** inventory drafted. **Nothing in it is reviewed.** No runtime, prompt,
policy version, corpus, flag or authority is changed by this document. Every
row has an empty reviewer and the status `unreviewed`. Activating any
replacement guidance stays gated on the Finnish accounting reviewer Kari names
([plan §4, §8](plan-2026-09-22-fi-jev-decision-knowledge.md)).

**Base:** `origin/main` at `a4b36dca191c3da950e389e9f43eaebf68a4e097`. The
policy is `fi_alv_coding` **integer version 8** (FIK-V, #2201). In the plan's
terms this is still the **unreviewed ("v7") guidance**: see plan §8.2.

**Scope:** the two blocks in `server/donna/finland/codingPolicy.js`,
`FI_ALV_INSTRUCTIONS_NOTE` and `FI_DOCUMENT_POSTING_NOTE`, exactly as they are
on that base. They are joined into `FI_CODING_POLICY.taxInstructions` and sent
on every Finnish coding request (Jev and the strong coder). The shared,
market-neutral coder prompt in `transactionLlm.js` is out of scope. Where it
overlaps a Finnish clause, the overlap is noted.

## 1. Method and environment record

- **Split.** Each block is cut into single claims, one per row. A sentence
  holding a statutory premise and a workflow instruction becomes two rows. Each
  claim is quoted **exactly**; `…` marks words left out of a longer sentence.
  A check confirms every quote is a verbatim substring of its block on the base
  commit (§6).
- **Classify.** One of four classes (plan §4):
  - `statutory` means statutory/guidance: a claim about Finnish law or Vero
    guidance.
  - `interpretation` means an accounting interpretation.
  - `evidence guard` means a source-evidence guard.
  - `workflow` means a product workflow contract.

  A workflow instruction is never labelled as law. A row whose main claim
  rests on a legal premise names that premise in its flags.
- **Link.** The executable counterpart is the file plus the function, constant
  or test that enforces or depends on the claim. Each was verified by grep on
  the base commit. "None found" means the grep found no code or test that
  enforces the claim; the claim is then **prose-only**.
- **Record.** Effective period, only where the claim is dated or the code dates
  it. Candidate primary source, always **unverified**. Countercase, where the
  claim needs one. Reviewer blank, status `unreviewed`.
- **Network check (this environment).** On 2026-09-23 at 08:50 UTC, from the
  Claude Code cloud session that drafted this inventory, `curl -I` to
  `https://www.vero.fi/en/businesses-and-corporations/taxes-and-charges/vat/rates-of-vat/`
  and to `https://www.finlex.fi/fi/lainsaadanto/1997/1336` both failed with
  `CONNECT tunnel failed, response 403` from the egress proxy. No page was
  fetched. **No snapshot, excerpt or hash exists for any source below.** Each
  URL and section number is a lead for the reviewer, drafted from memory of
  the statute's structure. Each must be opened and checked in a network-open
  environment. That environment is recorded when it is used (plan §4, K1
  capture procedure).
- **Candidate source shorthand** (all unverified):
  - **AVL**: Arvonlisäverolaki 1501/1993, `https://www.finlex.fi/fi/lainsaadanto/1993/1501`.
    The plan's §4 Finlex link, 1336/1997, is the Kirjanpitolaki (Accounting
    Act). That act is relevant to the interpretation rows, not to the VAT
    rows.
  - **KPL**: Kirjanpitolaki 1336/1997, `https://www.finlex.fi/fi/lainsaadanto/1997/1336`.
  - **OYL**: Osakeyhtiölaki 624/2006, `https://www.finlex.fi/fi/lainsaadanto/2006/624`.
  - **OVML**: Laki oma-aloitteisten verojen verotusmenettelystä 768/2016, `https://www.finlex.fi/fi/lainsaadanto/2016/768`.
  - **EPL**: Ennakkoperintälaki 1118/1996, `https://www.finlex.fi/fi/lainsaadanto/1996/1118`.
  - **SVML**: Laki työnantajan sairausvakuutusmaksusta 771/2016, `https://www.finlex.fi/fi/lainsaadanto/2016/771`.
  - **Vero-rates**: `https://www.vero.fi/en/businesses-and-corporations/taxes-and-charges/vat/rates-of-vat/`.
  - **Vero-change**: `https://www.vero.fi/en/businesses-and-corporations/taxes-and-charges/vat/rates-of-vat/the-changes-to-VAT-rates/`.
  - **Vero-deduct**: `https://www.vero.fi/en/businesses-and-corporations/taxes-and-charges/vat/deducting-vat-on-purchases/`.
- **Clause history** (from the amendment log in
  `server/donna/testSupport/jurisdictionExtension/wave4-policy-receipts.json`,
  pinned by `jurisdictionPolicyReplay.test.js`):

  | Version change | When | What it added |
  | --- | --- | --- |
  | 1 → 2 | RT-25, 2026-09-09 | Same-rate composite and rent sentences |
  | 2 → 3 | Live validation, 2026-09-11 | Source allocation, owner facts and payroll package |
  | 3 → 4 | 2026-09-11 | Withholding-remittance liability |
  | 4 → 5 | 2026-09-11 | Posting-recovery and historical-transport sentences |
  | 5 → 6 | 2026-09-20 | Oy menu and shareholder receivable |
  | 6 → 7 | Commit `00a5c7e` / `14f6816`, no amendment entry | `historical_rate_basis` and combined-line sentences |
  | 7 → 8 | FIK-V | Non-deductible sentence |

  The pin hashes the whole `taxInstructions` string. **Any edit to either block
  is a policy-version event.** The pin does not check any single claim.

## 2. `FI_ALV_INSTRUCTIONS_NOTE`

Reviewer is blank and status is `unreviewed` on every row.

| ID | Claim (exact quote) | Class | Executable counterpart (grep-verified) | Effective period | Candidate source (unverified) | Countercase | Flags | Reviewer | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| FI-ALV-01 | "The applicable jurisdiction is Finland; the tax_treatment options are Finnish ALV treatments." | workflow | `FI_CODING_POLICY` (`jurisdiction: 'fi'`, `taxVocabulary: FI_ALV_TAX_VOCABULARY`, `taxTreatmentOptions: FI_ALV_TAX_TREATMENT_OPTIONS`), `finland/codingPolicy.js`; menu in `finland/alvCodes.js` | — | — (product contract) | — | — | | unreviewed |
| FI-ALV-02 | "Pick the treatment the line's substance supports" | workflow | None found (prose-only) | — | — | — | — | | unreviewed |
| FI-ALV-03 | "standard 25,5 % for most domestic sales/purchases" | statutory | `FI_STANDARD_RATE`, `FI_ALV_RATES_BY_ERA` rows `2024-09-01` and `2026-01-01` (`standard: 25.5`, `confirmedAgainstPrimary: false`), `finland/alvCodes.js`; tests `alvCodes.test.js` "the 2024 standard rate is 25.5% (not 24%)…" and "G-1 pin: the rate eras…" | From 2024-09-01 (code). **The prose gives no date.** | AVL 84 §; Vero-rates | A supply before 2024-09-01 was taxed at 24 %. | **Undated prose.** 24 % is deliberately not in the vocabulary (`fiAlvRateSetForDate` comment), so a pre-2024-09-01 supply cannot be coded correctly. **Load-bearing legal claim, unsourced.** | | unreviewed |
| FI-ALV-04 | "the reduced rates only where they genuinely apply" | interpretation | None found (prose-only) | — | — | — | — | | unreviewed |
| FI-ALV-05 | "13,5 % (food, restaurants, books, medicine, transport, accommodation, culture, sport) for supplies from 1.1.2026" | statutory | Era `2026-01-01` `reduced: [13.5, 10]` (`FI_ALV_RATES_BY_ERA`); code `ALV_13_5_*`; test "G-1: fiAlvRateSetForDate resolves the era by date; the boundary is exact" | From 2026-01-01 | AVL 85 §, 85 a §; Vero-change | Yle broadcasting also moved 10 → 13,5 %; the era `source` string records this as "scope, not encoded". Newspapers and periodicals stay at 10 % (FI-ALV-08). | The category list exists only in prose; no code encodes categories. The era row says `confirmedAgainstPrimary: false` ("search-extraction grade", follow-up F-G1-V). **Load-bearing legal claim, unsourced.** | | unreviewed |
| FI-ALV-06 | "14 % for those categories where the goods were delivered, the service performed, or an advance payment received during 2025" | statutory | Era `2024-09-01` `reduced: [14, 10]`; `historicalTaxTreatmentsFor` returns `'ALV 14 %'` for dates ≥ 2026-01-01, `finland/codingPolicy.js` | 2025-01-01 – 2025-12-31 (prose); code: 14 % is current until 2025-12-31 | AVL 85 §, 85 a §, transitional provisions of the 2025 amendment; Vero-change | Food and restaurant supplies were already 14 % **before** 2025. The prose names only "during 2025". | Incomplete, not contradictory: for a pre-2025 date the code treats 14 % as current, and the prose is silent there. **Load-bearing legal claim, unsourced.** | | unreviewed |
| FI-ALV-07 | "(the time of supply decides the rate, not the payment date — a 2026 bank line settling a 2025 supply is still 14 %)" | statutory | `historicalTaxTreatmentsFor` plus the `historical_rate_basis` schema field and `historicalGuard`, `transactionLlm.js`; test `fiCodingBoundaryGuards.test.js` "FI strong coder: a historical rate without a stated basis is the document_discrepancy question…" | Rate changes of 2025-01-01 and 2026-01-01 | AVL rate-change transitional provisions; Vero-change | An advance received in 2025 for a supply made in 2026 is 14 %. That case is covered by FI-POST-20's `advance_paid_before_rate_change`, not by this sentence. | Overlaps FI-POST-14 to FI-POST-20. **Load-bearing legal claim, unsourced.** | | unreviewed |
| FI-ALV-08 | "and 10 % for newspapers and periodicals" | statutory | Both eras include 10 in `reduced`; `historicalTaxTreatmentsFor` marks `'ALV 10 %'` historical from 2025-01-01, so a current periodical needs `historical_rate_basis: 'periodical'` | Narrowed to periodicals from 2025-01-01 (era comment) | AVL 85 a §; Vero-rates | A single-issue publication or an e-publication: does the 10 % scope cover it? This is a reviewer question. | The code's `periodical` basis is consistent with this claim. **Load-bearing legal claim, unsourced.** | | unreviewed |
| FI-ALV-09 | "for historical supplies or advances before 1.1.2025, the categories then taxed at 10 % (including passenger transport) retain that historical rate" | statutory | `historicalTaxTreatmentsFor` (`'ALV 10 %'` from 2025-01-01); `historical_rate_basis` `supply_before_rate_change` / `advance_paid_before_rate_change`, `transactionLlm.js` | Before 2025-01-01 | AVL 85 a § before and after the 2025 amendment; Vero-change | A 2025 receipt printing 10 % for a 2025 supply (FI-POST-16 and FI-POST-17). | The 2025-01-01 **scope** reform is **not** an era in `FI_ALV_RATES_BY_ERA` (eras are rate sets, and the rate set did not change). It exists only here, in `historicalTaxTreatmentsFor` and in FI-POST-16. **Load-bearing legal claim, unsourced.** | | unreviewed |
| FI-ALV-10 | "'ALV 0 % / vienti' for exports outside the EU" | statutory | Code `ALV_0_OUTPUT` (`return_boxes: { base: '309' }`), `finland/alvCodes.js`; test "resolveAlvCode maps zero-rated, exempt, and out-of-scope prose" | — | AVL 70 §; Vero VAT guidance on exports | Other 0 % supplies that are not exports: does field 309 still apply? Reviewer question. | Candidate section number unverified. | | unreviewed |
| FI-ALV-11 | "the EU options for intra-community goods/services (myynti = the client sells, osto = the client buys)" | workflow | Codes `ALV_EU_SUPPLY`, `ALV_EU_ACQUISITION`, `ALV_EU_SERVICE_SUPPLY`, `ALV_EU_SERVICE_ACQUISITION`; `resolveAlvCode`; tests "resolveAlvCode maps EU intra-community supply vs acquisition" and "FI-3 EU prose with 'käännetty' routes to the EU codes…" | — | AVL 72 a §, 72 b §; AVL 9 § (services) | A B2C distance sale to another EU country (OSS) is **not** `EU-tavaramyynti`. | The prose states label meanings only; the B2B condition is left implicit. **No OSS treatment exists in the vocabulary.** A gold outcome for an OSS sale is therefore not expressible (a FIK-V-class gap for FIK-0 to size). | | unreviewed |
| FI-ALV-12 | "'Maahantuonti EU:n ulkopuolelta' for imports of goods from outside the EU" | statutory | Code `ALV_IMPORT` (`return_boxes: { base: '310', tax: '304', deductible: '307' }`); test "FI-3 resolveAlvCode maps EU services and imports to the new codes" | Self-assessed import VAT, from 2018 (code comment) | AVL import chapter; Vero import-VAT guidance | A service bought from a non-EU supplier: which menu option and which return field? | Unresolved countercase: the menu has no explicit non-EU service-purchase treatment. **Load-bearing legal claim, unsourced.** | | unreviewed |
| FI-ALV-13 | "'Rakennusalan käännetty ALV' only for construction-industry reverse charge" | statutory | Codes `ALV_REVERSE_CHARGE_SALES` / `ALV_REVERSE_CHARGE_PURCHASE` (fields 318, 319, 320); test "resolveAlvCode maps reverse-charge prose (FI + EN), direction-sensitive" | — | AVL 8 c § | Scrap-metal reverse charge (AVL 8 d §) is also a domestic reverse charge and has no menu option. | Vocabulary gap for FIK-0 to size. | | unreviewed |
| FI-ALV-14 | "'Veroton toiminta (ALV-vapaa)' for exempt activities (healthcare, financial, insurance, education)" | statutory | Code `ALV_EXEMPT` (`direction: 'both'`, `return_boxes: null`) | — | AVL exemption chapter (e.g. 34 §, 39 §, 41 §, 44 §) | A business below the registration threshold (not registered) is not an "exempt activity". Out-of-scope movements belong to FI-ALV-19. | The list is illustrative, not exhaustive. Premises rent (FI-ALV-23) is also mapped to this label. **Load-bearing legal claim, unsourced.** | | unreviewed |
| FI-ALV-15 | "'Vähennyskelvoton ALV (osto)' for a purchase on which ALV was charged but which the client may not deduct — the gross amount stays in the expense and no input VAT is claimed" | interpretation | Code `ALV_NONDEDUCTIBLE_INPUT` (`rate: null`, `kind: 'blocked'`, `return_boxes: null`); `resolveAlvCode`; tests `fiNonDeductibleVatPgLifecycle.test.js` (both); `alvCodes.test.js` "FIK-V: the non-deductible code is input-only, unreported, unsplit, and not out of scope" | — | AVL 102 §, 114 §; Vero-deduct | A partly deductible (mixed-use) purchase has no pro-rata treatment (plan §8.2, named limit 2). | By design this defines the label only. **Which** purchases qualify (e.g. representation, private use) is FIK-1 topic work, not an existing claim. | | unreviewed |
| FI-ALV-16 | "it is never for an EU acquisition, import or construction reverse charge (their self-assessed tax is still due)" | statutory | `resolveAlvCode` returns `''` for non-deductible plus self-assessed prose, then `TRANSACTION_ALV_TREATMENT_UNRESOLVED`; test "FIK-V: a restricted deduction on a self-assessed purchase resolves to nothing, never drops its output tax" | — | AVL 2 §, 9 §, 8 c §, 26 f § (self-assessed liabilities); AVL 114 § | A self-assessed purchase with a restricted deduction cannot be expressed (plan §8.2, named limit 3). | Executable agrees. **Load-bearing legal premise, unsourced.** | | unreviewed |
| FI-ALV-17 | "never for a purchase that carried no ALV" | evidence guard | None found (prose-only). `rate: null` makes every rate-gated guard stand aside, so no stated-VAT check applies. | — | — | — | Prose-only guard. | | unreviewed |
| FI-ALV-18 | "and never a substitute for a missing receipt" | evidence guard | None found. `jevCoding.js` `missing_input_tax_evidence` excludes only `inputDeductible` treatments, so the non-deductible choice **stays available without a receipt** (plan §8.2). | — | — | — | Prose-only guard; the code deliberately permits the choice without a receipt. The risk is under-claimed VAT, not a wrong reclaim. | | unreviewed |
| FI-ALV-19 | "'Ei ALV-käsittelyä' for out-of-scope internal transfers/equity/capital movements" | interpretation | `outOfScopeTaxTreatment: 'Ei ALV-käsittelyä'`; code `ALV_OUT_OF_SCOPE`; `FI_POSTING_POLICY.assertPostableTaxCoding` does not require a code on balance-sheet codings, `finland/postingPolicy.js` | — | AVL 1 § (scope) | — | Overlaps the shared "Internal movements" paragraph of the coder prompt (`transactionLlm.js`). | | unreviewed |
| FI-ALV-20 | "When you genuinely cannot determine the treatment, answer 'ALV-tarkistus' — it flags the line for review instead of guessing a rate." | workflow | `FI_ALV_UNSURE_MARKER` maps to no code; `assertPostableTaxCoding` raises `TRANSACTION_ALV_TREATMENT_UNRESOLVED`; `unresolvedTreatmentGuard`, `transactionLlm.js`; tests `jevCoding.test.js` "FI statement-only line: a resolved account with the unsure tax marker is a source-document ask…" and "FI matched source with the unsure tax marker is judgment work…" | — | — (product contract) | — | **Prose and code disagree.** "flags the line for review" describes a firm-review state. The code instead makes the line an owner source-document ask (statement-only line), a reasoning handoff, or work for the source-recheck lane (settled source). The two-terminal principle forbids a firm-review state. | | unreviewed |
| FI-ALV-21 | "'ALV-tarkistus' is for a line whose plausible components carry DIFFERENT rates and the evidence cannot split them" | interpretation | None found as a guard (RT-25 prose) | — | — | — | — | | unreviewed |
| FI-ALV-22 | "it is never the answer for a composite whose every plausible component carries the same rate — a hair salon's or a shop's card-terminal payout mixes services and retail goods that are all 25,5 %, so it is 'ALV 25,5 %'" | interpretation | No guard. The fixture `settlementRowSplitPgLifecycle.test.js` (Nets card settlement coded `Sales` / `'ALV 25,5 %'`) depends on it. | — | Statutory premise that hairdressing and ordinary retail goods are standard-rated: AVL 84 §, 85 § (unverified) | A shop whose goods include food (13,5 %) has components at different rates, so FI-ALV-21 applies. | Rests on an unsourced statutory premise. The example's merchant types are an incident fixture living in production prose; plan §4 says those belong in regression fixtures. | | unreviewed |
| FI-ALV-23 | "Commercial premises rent follows the matched rent bill: if the bill states ALV, 'ALV 25,5 %'; if it states no ALV (the landlord has not opted to tax the premises), 'Veroton toiminta (ALV-vapaa)'" | statutory | None found (prose-only) | — | AVL 27 § (exempt real-estate lease), 30 § (voluntary tax liability); Vero guidance on voluntary VAT on property | A rent bill for a pre-2024-09-01 period stating 24 %. Parking or separately charged services stated on the same bill. | The legal premise (exempt unless the lessor has opted in) is **load-bearing and unsourced**. The bill-following half is FI-ALV-24. | | unreviewed |
| FI-ALV-24 | "read the bill's tax fields before answering 'ALV-tarkistus'" | evidence guard | None found (prose-only) | — | — | A rent line with no matched bill. | Prose-only. | | unreviewed |
| FI-ALV-25 | "A bank payment to Verohallinto / OmaVero that settles the client's ALV (VAT) — typically referencing the client's OmaVero/tax-account reference — is NOT an expense: code it to the ALV payable account 'Suoritettava arvonlisävero' with 'Ei ALV-käsittelyä'" | interpretation | `requiredAccountNames: [FINLAND_ALV_SETTLEMENT_ACCOUNT.name]`; `applyAlvCodingToCoding` never stamps a rate on the control account; tests `finlandAlvSettlementWiring.test.js` "the OmaVero settlement posts DR coded 2939 (tax NONE) / CR bank…" and `alvCodes.test.js` "308: applyAlvCodingToCoding never stamps an ALV code onto a control-account coding". `codingStatutoryEvidenceGap` (`codingStatutoryEvidence.js`, role `liability.tax_payable`) holds an outgoing payment without a current source; test `codingStatutoryEvidencePgLifecycle.test.js` "canonical statutory roles require a current source…" | — | OVML (self-assessed taxes); KPL (liability) | **The OmaVero reference may be shared across all self-assessed taxes** (VAT, withholding and employer contributions), so the reference alone may not identify ALV. This is the reviewer's to verify; it is not asserted here. | **The prose leaves out a gate the code enforces.** The prose implies the reference is enough to code the line. The code holds it until a current source exists (the ALV return, or a payment confirmation). Overlaps FI-POST-04 and the shared "Statutory payments" paragraph (`transactionLlm.js`). | | unreviewed |
| FI-ALV-26 | "(it clears the liability the ALV return already reported)" | interpretation | Same as FI-ALV-25 | — | KPL | A payment made before the return is filed, or a payment that covers several periods. | — | | unreviewed |
| FI-ALV-27 | "an ALV refund FROM Verohallinto codes to the same account" | interpretation | `codingStatutoryEvidenceGap` does not gate an incoming refund (the same test asserts `money_in` → `false`) | — | OVML | A tax-account refund that nets several taxes, or that includes refund interest. | — | | unreviewed |
| FI-ALV-28 | "A Verohallinto payment that is clearly a different tax (income-tax prepayment / ennakkovero, employer payroll contributions) is NOT the ALV settlement — code it by its own substance, or answer 'ALV-tarkistus' if you cannot tell which tax it settles." | workflow | `jevCoding.js` owner choices `ask_obligation` and `ask_statutory_source` are the executable routes for "which obligation did this settle" | — | OVML; EPL | — | **Prose and code diverge.** The prose uses the tax-treatment unsure marker to mean "unknown account/obligation". The code's routes for that question are `ask_obligation` / `ask_statutory_source`. Overlaps FI-POST-04 (payroll remittance). | | unreviewed |

## 3. `FI_DOCUMENT_POSTING_NOTE`

Reviewer is blank and status is `unreviewed` on every row.

| ID | Claim (exact quote) | Class | Executable counterpart (grep-verified) | Effective period | Candidate source (unverified) | Countercase | Flags | Reviewer | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| FI-POST-01 | "For a Finnish out-of-scope loan payment whose matched notice decomposes principal and interest, use posting_requirement document_allocation: select every source line's call-local handle exactly once in document_allocations with its correct chart account." | workflow | `resolveDocumentAllocation` "Every document component must be allocated exactly once." (`TRANSACTION_DOCUMENT_ALLOCATION_INVALID`), `db/documentAllocation.js`; test `fiCodingEvidencePgLifecycle.test.js` "real PG: the real coder consumes late evidence, posts principal/interest separately…" | — | — (product contract) | — | "out-of-scope" is narrower than the code; see FI-POST-28. | | unreviewed |
| FI-POST-02 | "Amounts come from the document; never invent amounts or book interest as principal." | evidence guard | `resolveDocumentAllocation`: the component gross comes from `documentSourceComponents`, and the document total must equal the bank movement | — | KPL (interest is an expense; principal reduces the liability) | — | — | | unreviewed |
| FI-POST-03 | "A payment described as principal plus interest needs the loan notice: without it set evidence_required true and request that notice." | evidence guard | `jevCoding.js` `ask_source_document`; `fiCodingEvidencePgLifecycle.test.js` (late evidence) | — | — | — | — | | unreviewed |
| FI-POST-04 | "A remittance of employee payroll withholding and employer health-insurance contributions settles Payroll withholding and employer health-insurance payable, with Ei ALV-käsittelyä; it is not a fresh Payroll expense." | interpretation | Account `Payroll withholding and employer health-insurance payable` in `packs/fi/manifest.json`; `fiCodingEvidencePgLifecycle.test.js` asserts the debit to it; `codingStatutoryEvidenceGap` (`liability.payroll_payable`) | — | EPL; SVML; OVML | — | Rests on the statutory premise that withholding and the employer's health-insurance contribution are remitted together as self-assessed taxes. **Load-bearing, unsourced.** Overlaps FI-ALV-28 and the shared "Statutory payments" paragraph. | | unreviewed |
| FI-POST-05 | "Keep pension/unemployment contributions on their evidenced payroll-contribution liability." | interpretation | `codingStatutoryEvidenceGap` statutory-liability roles | — | TyEL 395/2006; the unemployment-insurance contribution act (numbers unverified) | — | Statutory premise (these are paid to the pension insurer and the Employment Fund, not to Vero) is left implicit and unsourced. | | unreviewed |
| FI-POST-06 | "If a required liability is absent from a synced chart, request the missing account instead of substituting an expense." | workflow | None found | — | — | — | **Conflicts with FI-POST-26 in the same block** ("missing chart capability is Donna's problem"). This one says to request the account, without saying from whom. | | unreviewed |
| FI-POST-07 | "An Oy has no owner drawings" | statutory | `FI_CODING_POLICY.loadAccountPalette`: `excludedAccountNames: ['Owner drawings']` when `isFinlandOsakeyhtio`; test `fiMaterialErrorsPgLifecycle.test.js` "legal form and source family bound the actual coding menu" | — | OYL 13 luku (distribution of assets) | A toiminimi keeps `Owner drawings` (same test). | Executable agrees. **Load-bearing legal claim, unsourced.** | | unreviewed |
| FI-POST-08 | "private expenditure paid by the company requires an evidenced receivable from the shareholder or the appropriate taxable benefit treatment." | statutory | Account `Shareholder receivable` in `packs/fi/manifest.json`; `codingSourceBusinessUseConflict`, `sourceBusinessUse.js` | — | OYL 13 luku; tuloverolaki 1535/1992 (taxable benefit; hidden dividend) | Hidden dividend (peitelty osinko) is a third outcome that the prose does not name. | **Load-bearing legal claim, unsourced.** | | unreviewed |
| FI-POST-09 | "Do not infer the recipient relationship or a shareholder loan merely from private-use evidence." | evidence guard | `codingRelatedPartyRelationshipGuard`, `sourceBusinessUse.js`; test `fiCodingBoundaryGuards.test.js` "FI strong coder: a related-party receivable from a private-use source needs the relationship from the owner" | — | — | — | Overlaps the shared "Owner draws…" principals paragraph (`transactionLlm.js`). | | unreviewed |
| FI-POST-10 | "Finnish Oy salary payments require an external balanced payroll package (gross/net, withholding, employer contributions, pension/insurance and liability accounts)." | workflow | `posting_requirement: 'payroll_package'`, `transactionLlm.js`; `jevCoding.js` `ask_payroll_package`; test `oyOwnerTransactionTaxonomy.test.js` "salary is never inferred — it needs a payroll package…" | — | — (product contract: Donna does not run payroll) | A toiminimi with employees also has payroll. | **The prose is Oy-scoped; the code is not.** `ask_payroll_package` is gated on source family, not entity type (`jevCoding.js`). | | unreviewed |
| FI-POST-11 | "A payslip alone is not that package: use payroll_package and ask specifically for the missing payroll journal, acknowledging the payslip held." | evidence guard | Test `jevCoding.test.js` "statement-only salary may ask for the payroll package; a matched non-payroll source excludes it…" | — | — | — | — | | unreviewed |
| FI-POST-12 | "Never book net salary as the whole payroll expense or invent employer contributions." | evidence guard | `payroll_package` requirement (above); no separate arithmetic guard found | — | — | — | — | | unreviewed |
| FI-POST-13 | "When posting_recovery is present, the original file has been independently re-read after a posting refusal." | workflow | `posting_recovery` in `db/codingCorrection.js`, `db/codingEvidence.js`, `caseHealth.js`; test `fiProviderRecoveryPgLifecycle.test.js` | — | — | — | — | | unreviewed |
| FI-POST-14 | "First establish the evidenced supply or advance-payment date, then the applicable dated Finnish treatment, then compare the printed amounts." | workflow | `historicalGuard` (`transactionLlm.js`); `assertPostableTaxCoding` source comparison (`finland/postingPolicy.js`) | — | — | — | Overlaps FI-ALV-07. | | unreviewed |
| FI-POST-15 | "Printed VAT is evidence of what the supplier charged; it does not establish that the rate is applicable." | evidence guard | `historicalGuard` comment and receipt `constraint: 'historical_rate_basis_unestablished'`; `jevCoding.js` `ask_supply_timing` | — | — | — | — | | unreviewed |
| FI-POST-16 | "Passenger transport supplied in 2025 is 14%, NOT 10%." | statutory | `historicalTaxTreatmentsFor` (`'ALV 10 %'` historical from 2025-01-01) | 2025-01-01 – 2025-12-31 | AVL 85 §, 85 a § after the 2025 amendment; Vero-change | The same supply in 2026 is 13,5 % (FI-ALV-05). | **Duplicates FI-ALV-06 / FI-ALV-09.** Incident-specific (plan §4: incident examples belong in fixtures). **Load-bearing legal claim, unsourced.** | | unreviewed |
| FI-POST-17 | "A 2025 receipt printing 10% does not itself prove a pre-2025 supply or advance payment." | evidence guard | `historicalGuard`; test `jevCoding.test.js` "FI held source printing a historical rate: Jev may ask for the timing…" | 2025 | — | — | Duplicates FI-POST-15 for one year. | | unreviewed |
| FI-POST-18 | "Only explicit source evidence or an attributable owner answer can establish that exception; never infer it merely because the printed arithmetic works." | evidence guard | `historical_rate_basis` enum; `historicalGuard` accepts only the three established bases | — | — | — | — | | unreviewed |
| FI-POST-19 | "If that timing fact is absent after the source re-read, retain the discrepancy and ask for the factual timing or a corrected receipt." | workflow | `jevCoding.js` `ask_supply_timing` (offered only when `hasVerifiedSourceForDiscrepancy`); `historicalGuard` question text | — | — | — | — | | unreviewed |
| FI-POST-20 | "Whenever you select a rate that applied only before a rate change (10 % on a line dated 2025 or later; 14 % on a line dated 2026 or later), state its basis in historical_rate_basis: periodical, supply_before_rate_change or advance_paid_before_rate_change, each only when the source or an attributable owner answer establishes it; otherwise timing_not_established, which makes the line a document_discrepancy question, never a posting." | workflow | `historicalTaxTreatmentsFor` (dates match); `historical_rate_basis` schema enum and `historicalGuard`, `transactionLlm.js`; tests `fiCodingBoundaryGuards.test.js` (first two tests) | Rate changes of 2025-01-01 and 2026-01-01 | — | — | **Two prose/code differences.** (1) `historicalGuard` sets `document_discrepancy` only when `hasVerifiedSourceForDiscrepancy`; otherwise it sets **`owner_fact`**. (2) The guard runs only when `money_out > 0`, so a **sale** coded at a historical rate is not guarded. The prose says "whenever". The date boundaries in the prose match the code. | | unreviewed |
| FI-POST-21 | "A single printed source line that combines two separately accounted charges without stating each amount (for example late interest together with a reminder fee) cannot be allocated: never book the whole line to one of them and never invent a split; use document_discrepancy and ask for the split or a corrected document." | evidence guard | `jevCoding.js` `ask_component_split` (offered only with a verified source); test `jevCoding.test.js` "FI combined source line: a component split question holds the whole allocation as a document_discrepancy ask" | — | — | Each charge stated separately: allocate normally. | — | | unreviewed |
| FI-POST-22 | "Correct your coding if your earlier treatment was wrong." | workflow | None found (prose-only) | — | — | — | — | | unreviewed |
| FI-POST-23 | "Never change the printed VAT or select a false rate just to make posting pass." | evidence guard | `assertPostableTaxCoding`: `TRANSACTION_ALV_CODING_SOURCE_CONFLICT` / `TRANSACTION_ALV_DOCUMENT_AMOUNT_MISMATCH` (`finland/postingPolicy.js`); component rate check in `resolveDocumentAllocation` | — | — | — | Overlaps FI-ALV-20 ("instead of guessing a rate"). | | unreviewed |
| FI-POST-24 | "If a genuine source discrepancy remains, use posting_requirement document_discrepancy, evidence_required true and a precise ask_client_question citing the file and conflicting figures." | workflow | `transactionLlm.js` forces `evidence_required: true` for `document_discrepancy` | — | — | — | — | | unreviewed |
| FI-POST-25 | "Ask only for a missing factual date, explanation or corrected document; never ask the owner which VAT rate/account to choose or request the same file again." | workflow | None found as a guard (prose-only). `jevCoding.js` removes `ask_source_document` when a settled source is held, which covers "the same file again" for that one choice. | — | — (CLAUDE.md fact-vs-knowledge doctrine) | — | Partly enforced. | | unreviewed |
| FI-POST-26 | "A technical failure, unsupported allocation or missing chart capability is Donna's problem and is not document_discrepancy." | workflow | `jevCoding.js` `reasoning_allocation` / `reasoning_vocabulary` choices | — | — | — | Conflicts with FI-POST-06 (see above). | | unreviewed |
| FI-POST-27 | "On an owner reply, consider the new factual answer and the tax amounts in reply_documents before retaining that requirement." | workflow | `client_reply_context.reply_documents`, `transactionLlm.js`, `db/coding.js`; test `askReplyRecode.test.js` | — | — | — | — | | unreviewed |
| FI-POST-28 | "This slice supports positive, out-of-scope document components; tax-bearing allocations and signed payroll imports require their own source contract." | workflow | `resolveDocumentAllocation` posts **tax-bearing** components through `sourceTaxPosting` ("A tax-bearing allocation requires source tax evidence for that component."); tests `documentAllocationTax.test.js` "source group arithmetic preserves mixed VAT…" and "the existing journal builder posts each selected component tax…", `documentAllocationTaxPgLifecycle.test.js`, `fiNonDeductibleVatPgLifecycle.test.js` "real PG: a document allocation mixes a non-deductible component with a deductible one", `fiCodingBoundaryGuards.test.js` "FI strong coder: one historical component holds a whole document allocation" | — | — | — | **Stale; prose and code disagree.** Tax-bearing allocations **are** supported and tested. FI-POST-20 in the same block already assumes rate-bearing components. A coder reading this sentence may refuse a valid mixed-VAT allocation. "signed payroll imports" was not checked. | | unreviewed |

## 4. Flags

### 4.1 Load-bearing legal claims that cannot yet be sourced

No claim in either block is sourced: there is no snapshot, and network access
was blocked (§1). These rows decide a rate, a treatment or a legal-form
outcome. They must not be activated in any reviewed successor until the
reviewer verifies them against a captured primary source:

| Topic | Rows |
| --- | --- |
| Rates and rate eras | FI-ALV-03, FI-ALV-05, FI-ALV-06, FI-ALV-07, FI-ALV-08, FI-ALV-09, FI-POST-16 |
| Import and self-assessment | FI-ALV-12, FI-ALV-16 |
| Exemptions and premises rent | FI-ALV-14, FI-ALV-23 |
| Standard-rate premise of the composite example | FI-ALV-22 |
| Payroll remittance | FI-POST-04, FI-POST-05 |
| Oy owner rules | FI-POST-07, FI-POST-08 |

The executable rate eras carry the same caveat:
`FI_ALV_RATES_BY_ERA[*].confirmedAgainstPrimary === false` (follow-up F-G1-V),
and `ALV_RETURN_BOX_PROVENANCE.confirmedAgainstPrimary === false` (F-FI3-1).
Prose and code therefore rest on the same unverified extraction. Agreement
between them is **not** independent confirmation.

### 4.2 Duplicated or overlapping claims

| Topic | Rows | Note |
| --- | --- | --- |
| Historical rate and time of supply | FI-ALV-06, 07, 09 and FI-POST-14 to FI-POST-20 | The same rule is stated three ways; passenger transport is named in both blocks. |
| "Don't guess a rate" | FI-ALV-20 and FI-POST-23 | |
| Tax-authority payments | FI-ALV-25 to 28, FI-POST-04, and the shared "Statutory payments" paragraph in `transactionLlm.js` | |
| Owner and equity movements | FI-ALV-19, FI-POST-07 to 09, and the shared "Internal movements" / "Owner draws" paragraphs | |
| Missing receipt | FI-ALV-18 and FI-POST-03 / FI-POST-11 | Different topics, same guard shape. |

A reviewed successor states each covered rule **once** (plan §4, §10).

### 4.3 Executable counterpart disagrees with the prose

| Row | Disagreement |
| --- | --- |
| FI-POST-28 | Says tax-bearing allocations are unsupported; they are supported and tested. Also contradicts FI-POST-20 in the same block. |
| FI-POST-20 | Says `timing_not_established` always becomes `document_discrepancy`. The code uses `owner_fact` when no verified source is held, and skips the guard on money-in lines. |
| FI-ALV-20 | Says the line is "flagged for review". The code makes it an owner source-document ask, a reasoning handoff, or recheck-lane work. |
| FI-ALV-28 | Uses the tax-treatment unsure marker to ask which obligation was settled. The code routes that question through `ask_obligation` / `ask_statutory_source`. |
| FI-ALV-25 | The prose implies the OmaVero reference is enough to code the line. `codingStatutoryEvidenceGap` holds it until a current source exists. |
| FI-ALV-03 | The standard rate is undated in the prose. The code starts at 2024-09-01 and has no 24 % option. |
| FI-POST-10 | Oy-scoped in the prose; entity-neutral in the code. |
| FI-POST-06 / FI-POST-26 | Internal conflict within the posting block. |

None of these is fixed here. Changing either block is a policy-version event
(§1), and plan §8 routes any rewrite through FIK-1 review and FIK-2.

### 4.4 Treatments missing from the vocabulary (surfaced, not sized)

- OSS / B2C EU distance sales (FI-ALV-11).
- Scrap-metal reverse charge (FI-ALV-13).
- A service purchase from outside the EU (FI-ALV-12).
- The 24 % standard rate for supplies before 2024-09-01 (FI-ALV-03).
- A partly deductible purchase and a self-assessed purchase with a restricted
  deduction (FI-ALV-15, FI-ALV-16; already named in plan §8.2).

Per plan §8 (FIK-V row), further vocabulary additions wait for FIK-0's
evidence of gold outcomes that cannot be expressed. The reviewer should
confirm or reject each premise first.

## 5. What this inventory does not do

- It does not review, source or activate anything. Every row is `unreviewed`
  and has no named reviewer.
- It changes no runtime code, prompt, policy version, flag or receipt.
- It does not add topics. Plan §4 orders the work: this inventory and the
  FIK-0 cause audit come first, and FIK-0 is still blocked on the operator's
  data.

**Next step (on Kari):** name the Finnish accounting reviewer. The reviewer
takes this table and does the following, in a network-open environment that
is recorded:

1. Captures each candidate source.
2. Confirms or corrects each row's class, period and countercase.
3. Adjudicates the §4.3 disagreements.

The per-claim capture list for the §4.1 rows (candidate sources, what to
confirm, the enforcing code and the `confirmedAgainstPrimary` follow-ups) is
the [reviewer source-capture worksheet](fik-1-reviewer-source-worksheet.md).

## 6. Quote check

A scratch script (not committed) ran two checks on the base commit. It read
the `FI_ALV_INSTRUCTIONS_NOTE` and `FI_DOCUMENT_POSTING_NOTE` template literals
from `codingPolicy.js`, then:

1. **Verbatim.** Each row's quote is an exact substring of its block. All 56
   quotes passed (28 per block).
2. **Coverage.** Together, the quotes leave no uncovered text in either block
   other than punctuation and joining whitespace. No claim was skipped.

Rerun both checks after any edit to either block.

## 7. Changes after this inventory

### 2026-09-23 — version 9: four workflow-contract sentences aligned with the code

Kari approved these fixes the same day. They need no Finnish accounting
reviewer because none of them changes a legal claim. Each sentence now says
what the executable contract already does. The quotes in §2 and §3 remain
the **version-8** text; the rows below are the only ones whose wording
changed.

| Row | Version-8 wording | Version-9 wording (summary) |
| --- | --- | --- |
| FI-POST-28 | Tax-bearing allocations "require their own source contract" | Positive components each carry an explicit tax treatment. A tax-bearing component needs its own tax evidence and a rate matching the source. Signed components and signed payroll imports still need their own contract. |
| FI-ALV-20 | `'ALV-tarkistus'` "flags the line for review" | It never posts. Without a held source the owner is asked for the source document; with one, the line is re-examined against that source. |
| FI-ALV-28 | Answer `'ALV-tarkistus'` when unsure which tax a Verohallinto payment settles | Ask which tax or contribution it settles. `'ALV-tarkistus'` is a tax-treatment marker, never the answer to which obligation was paid. |
| FI-POST-20 | `timing_not_established` always becomes a `document_discrepancy` question | A timing question against the held source when it has been verified, otherwise to the owner. |

The replay pin records the 8 → 9 amendment
(`wave4-policy-receipts.json`). A stored version-8 suggestion conflicts at its
next apply and re-codes under the existing clock. Posted journals are
unaffected.

**Still open from §4.3** (as of version 9; see the version-10 entry below):

- FI-ALV-25 (the OmaVero line does not mention the source gate; the shared
  "Statutory payments" paragraph does).
- FI-ALV-03 (undated standard rate; no 24 % option).
- FI-POST-10 (Oy-scoped prose; entity-neutral code).
- FI-POST-06 / FI-POST-26. These contradict each other on a missing chart
  account; which one wins is a product decision not yet traced through the
  code.
- The FI-POST-20 guard skips money-in lines. That is a code gap, not a
  wording one.

The US, GB, AE and AU instruction notes carry the same "flags the line for
review" wording as the old FI-ALV-20. Changing them is a policy-version event
in each of those markets, so it is left for a separate change.

### 2026-09-24 — version 10: three more sentences aligned with the code

Kari approved these fixes on 2026-09-24. Like version 9, none of them changes
a legal claim: no rate, treatment, exemption or legal-form rule. Each sentence
now says what the executable contract already does. The quotes in §2 and §3
remain the **version-8** text.

| Row | Version-9 wording | Version-10 wording (summary) | Code it now matches |
| --- | --- | --- | --- |
| FI-ALV-25 | Code the Verohallinto / OmaVero ALV payment to `Suoritettava arvonlisävero`, "typically referencing the client's OmaVero/tax-account reference" | The bank line and its reference do not by themselves establish the liability. Without the ALV return, tax notice or payment confirmation, ask for that source. Once it is held, code the payment to the ALV payable account. | `codingStatutoryEvidenceGap` (`codingStatutoryEvidence.js`) holds an outgoing payment to a statutory-liability role until a matched return, tax notice, payment confirmation or statutory notice is held (`db/codingEvidence.js`, `TRANSACTION_STATUTORY_SOURCE_REQUIRED`); Jev's `ask_statutory_source`; the shared "Statutory payments" paragraph in `transactionLlm.js`. An incoming refund is not gated, so FI-ALV-27 is unchanged. |
| FI-POST-10 | Scoped to an Oy: "Finnish Oy salary payments require an external balanced payroll package" | A Finnish salary payment, whatever the employer's legal form, requires that package. | `posting_requirement: 'payroll_package'` and its refusal (`db/codingEvidence.js`) and Jev's `ask_payroll_package` (`jevCoding.js`, gated on source family only) read no entity type. FI-POST-11 and FI-POST-12 were already unscoped. Whether payroll is in scope for a toiminimi at all is a separate, unchanged check (`finland/scopeDrift.js`, `first_employee`). |
| FI-POST-06 | On a missing liability: "request the missing account instead of substituting an expense" | Never substitute an expense: the missing account is a chart-capability gap for Donna to resolve, not a question for the owner. FI-POST-26 is unchanged, so the block now states one rule. | The shared coder prompt parks the line on `Suspense` with the `missing_account_*` fields ("do not ask the client for it", `transactionLlm.js`); the Jev prompt says "A missing account is an execution-vocabulary gap, not an owner fact", and `reasoning_vocabulary` records the cause `vocabulary_gap` (`jevCoding.js`). Neither path has an owner ask for a chart account. |

The replay pin records the 9 → 10 amendment (`wave4-policy-receipts.json`),
with the prior digest. A stored version-9 suggestion conflicts at its next
apply and re-codes under the existing clock. Posted journals are unaffected.

**Still open from §4.3:**

- FI-ALV-03 (undated standard rate; no 24 % option). This is a legal claim, so
  it stays with the Finnish reviewer
  ([source-capture worksheet](fik-1-reviewer-source-worksheet.md)).
- The FI-POST-20 guard skips money-in lines. That is a code gap, not a
  wording one.
