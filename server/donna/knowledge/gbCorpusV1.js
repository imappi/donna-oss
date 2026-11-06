// Donna — K1 MVP: the UK corpus WORKSHEET (design-donna-k1-uk-corpus-mvp.md,
// signed by Kari 2026-08-01 via #1216; D1–D5 as written).
//
// ── WHAT THIS FILE IS, AND IS NOT ────────────────────────────────────────────
//
// This is the committed, machine-checked worksheet for the 32-question UK
// corpus — the questions, topics, answer shapes, named primary sources,
// owner phrasings (retrieval keys), outcome-2 variables, refusal boundaries,
// and the labelled curation targets (D5). It is NOT the corpus itself:
//
//   - `source_excerpt` is null on every entry, DELIBERATELY. The store
//     contract (`validateKnowledgePassageDraft`) refuses a passage without an
//     exact quoted excerpt, and excerpts can only be captured in Kari's
//     network-open curation session (gov.uk 403s through this environment's
//     egress proxy). Writing them from model recollection is the §8
//     laundering machine — the one failure this design exists to prevent.
//   - `draft_proposition` and `curation_expected` are the drafting model's
//     labelled recollection (D5): curation TARGETS the session verifies
//     against the fetched primary, corrects where wrong, and reviews. They
//     are never rendered to an owner and can never reach the store
//     unreviewed — the loader refuses any entry whose excerpt is missing,
//     and activation additionally requires snapshot + hash + named reviewer.
//
// Two-terminal check (CLAUDE.md): every entry here rests either as an ACTIVE
// store row with a full provenance receipt (after the curation session) or in
// this worksheet, owned by that named session. There is no third resting
// state.
//
// This module imports nothing and is imported only by the loader script and
// tests — it is data, not a K1 ground module, and it stays off every runtime
// import path.

// D4 (signed): exact-value shapes (rate/threshold) are re-verified after the
// autumn fiscal event and before the SA peak; rules/procedures/definitions
// get a year.
export const GB_CORPUS_REVIEW_DUE = Object.freeze({
  exact_value: '2027-01-31T00:00:00.000Z',
  rule: '2027-07-31T00:00:00.000Z'
});

const HMRC = 'HM Revenue & Customs';

// Every source is named for the curation session: fetched, snapshotted,
// hashed, reviewed there. `as_of`, `content_hash`, `snapshot_ref` are null
// until then; `confirmed_against_primary` flips only in that session.
const VERIFICATION_PENDING =
  'Named for the network-open curation session; not yet fetched — this terminal is egress-locked (gov.uk 403 through the proxy).';

const src = (key, title, source_url, citation = null) => ({
  key,
  authority: HMRC,
  authority_class: 'tax_authority_guidance',
  jurisdiction: 'GB',
  language: 'en',
  title,
  source_url,
  citation,
  as_of: null,
  content_hash: null,
  snapshot_ref: null,
  confirmed_against_primary: false,
  verification_note: VERIFICATION_PENDING
});

export const GB_CORPUS_SOURCES = Object.freeze([
  src('vat_notice_700_1', 'Who should register for VAT (VAT Notice 700/1)', 'https://www.gov.uk/guidance/who-should-register-for-vat-notice-7001', 'VAT Notice 700/1'),
  src('vat_registration_when', 'Register for VAT: When to register', 'https://www.gov.uk/vat-registration/when-to-register'),
  src('vat_rates_goods_services', 'VAT rates on different goods and services', 'https://www.gov.uk/guidance/rates-of-vat-on-different-goods-and-services'),
  src('vat_notice_733', 'Flat Rate Scheme for small businesses (VAT Notice 733)', 'https://www.gov.uk/guidance/flat-rate-scheme-for-small-businesses-vat-notice-733', 'VAT Notice 733'),
  src('vat_notice_700', 'VAT guide (VAT Notice 700)', 'https://www.gov.uk/guidance/vat-guide-notice-700', 'VAT Notice 700'),
  src('vat_notice_700_64', 'Motoring expenses (VAT Notice 700/64)', 'https://www.gov.uk/guidance/vat-on-motoring-expenses-notice-70064', 'VAT Notice 700/64'),
  src('vat_notice_700_65', 'Business entertainment (VAT Notice 700/65)', 'https://www.gov.uk/guidance/vat-on-entertainment-supplied-to-employees-and-non-employees-notice-70065', 'VAT Notice 700/65'),
  src('vat_notice_741a', 'Place of supply of services (VAT Notice 741A)', 'https://www.gov.uk/guidance/vat-place-of-supply-of-services-notice-741a', 'VAT Notice 741A'),
  src('bim_entertainment', 'Business Income Manual: entertainment expenses (BIM45000 series)', 'https://www.gov.uk/hmrc-internal-manuals/business-income-manual/bim45000', 'BIM45000'),
  src('expenses_self_employed', "Expenses if you're self-employed", 'https://www.gov.uk/expenses-if-youre-self-employed'),
  src('simplified_expenses', "Simplified expenses if you're self-employed", 'https://www.gov.uk/simpler-income-tax-simplified-expenses'),
  src('mileage_rates_amap', 'Travel — mileage and fuel rates and allowances', 'https://www.gov.uk/government/publications/rates-and-allowances-travel-mileage-and-fuel-allowances'),
  src('bim_travel', 'Business Income Manual: travel expenses (BIM37600 series)', 'https://www.gov.uk/hmrc-internal-manuals/business-income-manual/bim37600', 'BIM37600'),
  src('bim_home', 'Business Income Manual: use of home (BIM47800 series)', 'https://www.gov.uk/hmrc-internal-manuals/business-income-manual/bim47800', 'BIM47800'),
  src('hs283_prr', 'Private Residence Relief (Self Assessment helpsheet HS283)', 'https://www.gov.uk/government/publications/private-residence-relief-hs283-self-assessment-helpsheet', 'HS283'),
  src('capital_allowances', 'Claim capital allowances', 'https://www.gov.uk/capital-allowances'),
  src('cash_basis', 'Cash basis', 'https://www.gov.uk/simpler-income-tax-cash-basis'),
  src('takes_money_out_ltd', 'Running a limited company: taking money out', 'https://www.gov.uk/running-a-limited-company/taking-money-out-of-a-limited-company'),
  src('tax_on_dividends', 'Tax on dividends', 'https://www.gov.uk/tax-on-dividends'),
  src('register_employer', 'Register as an employer', 'https://www.gov.uk/register-employer'),
  src('paye_basics', 'PAYE and payroll for employers', 'https://www.gov.uk/paye-for-employers'),
  src('se_nics', 'Self-employed National Insurance rates', 'https://www.gov.uk/self-employed-national-insurance-rates'),
  src('invoicing_rules', 'Invoicing and taking payment from customers', 'https://www.gov.uk/invoicing-and-taking-payment-from-customers'),
  src('sa_records', "Business records if you're self-employed", 'https://www.gov.uk/self-employed-records'),
  src('vat_record_keeping', 'Record keeping (VAT Notice 700/21)', 'https://www.gov.uk/guidance/record-keeping-for-vat-notice-70021', 'VAT Notice 700/21'),
  src('sa_deadlines', 'Self Assessment tax returns: deadlines', 'https://www.gov.uk/self-assessment-tax-returns/deadlines'),
  src('sa_payments_on_account', 'Understand your Self Assessment tax bill: payments on account', 'https://www.gov.uk/understand-self-assessment-bill/payments-on-account'),
  src('basis_period_reform', 'Get help with basis period reform', 'https://www.gov.uk/guidance/get-help-with-basis-period-reform'),
  src('mtd_income_tax', 'Use Making Tax Digital for Income Tax', 'https://www.gov.uk/guidance/use-making-tax-digital-for-income-tax'),
  src('social_functions', 'Expenses and benefits: social functions and parties', 'https://www.gov.uk/expenses-benefits-social-functions-parties')
]);

// q(spec row) — one worksheet entry per spec §5 question. `question_forms` are
// owner phrasings (retrieval keys — safe to author now; they carry no
// statutory claim). `draft_proposition` + `curation_expected` are D5-labelled
// recollection. `source_anchor` tells the curator where in the document to
// look; the session replaces it with the exact anchor of the quoted excerpt.
const q = (entry) => Object.freeze({ source_excerpt: null, caveats: null, outcome2: null, ...entry });

export const GB_CORPUS_PASSAGES = Object.freeze([
  // ── vat_registration ──────────────────────────────────────────────────────
  q({
    spec_question: 'Q1', topic: 'vat_registration', answer_shape: 'threshold', source_key: 'vat_registration_when',
    source_anchor: 'threshold + rolling-12-month test statement',
    question_forms: ['Do I need to register for VAT?', 'When do I have to be VAT registered?', 'What is the VAT registration threshold?', 'Am I over the VAT threshold?'],
    draft_proposition: 'A business must register for VAT when taxable turnover in any rolling 12-month period exceeds the registration threshold, or when it expects to exceed it in the next 30 days alone.',
    curation_expected: { threshold_gbp: 90000, basis: 'rolling 12 months, not the accounting year' },
    outcome2: { variable: 'rolling_12m_taxable_turnover', resolve_from: 'ledger (the threshold-watch lane computes this)' },
    refusal_boundary: 'Group/divisional registration; overseas establishment (NETP) rules.'
  }),
  q({
    spec_question: 'Q2', topic: 'vat_registration', answer_shape: 'procedure', source_key: 'vat_notice_700_1',
    source_anchor: 'when to notify / effective date of registration',
    question_forms: ['I went over the VAT threshold — when must I register?', 'From what date do I have to charge VAT?', 'How long do I have to tell HMRC I crossed the threshold?'],
    draft_proposition: 'After the backward-look test is met, HMRC must be notified within 30 days of the end of the month in which the threshold was crossed, and registration takes effect from the first day of the second month after; under the 30-day forward-look test, registration takes effect from the date the expectation arose.',
    curation_expected: { notify_within_days: 30, effective: 'first day of the second month after crossing (backward look)' },
    outcome2: { variable: 'which_test_fired', resolve_from: 'ledger turnover series + owner' },
    refusal_boundary: 'Retrospective registration disputes; exception-from-registration requests.'
  }),
  q({
    spec_question: 'Q3', topic: 'vat_registration', answer_shape: 'rule', source_key: 'vat_notice_700_1',
    source_anchor: 'voluntary registration section',
    question_forms: ['Should I register for VAT voluntarily?', 'Can I register for VAT below the threshold?', 'Is voluntary VAT registration worth it?'],
    draft_proposition: 'A business below the threshold may register voluntarily; the trade-offs are reclaiming input VAT versus charging VAT to customers and taking on return obligations. The rule and the trade-offs are stated; the decision is the owner’s.',
    curation_expected: { voluntary_registration_permitted: true },
    outcome2: { variable: 'customer_mix_business_vs_consumer', resolve_from: 'ledger counterparties' },
    refusal_boundary: 'The verdict itself — Donna states the rule and the owner’s numbers, never the decision.'
  }),

  // ── vat_rates ─────────────────────────────────────────────────────────────
  q({
    spec_question: 'Q4', topic: 'vat_rates', answer_shape: 'rate', source_key: 'vat_rates_goods_services',
    source_anchor: 'rates overview table',
    question_forms: ['What VAT rate do I charge?', 'Is my service standard rated?', 'What are the UK VAT rates?'],
    draft_proposition: 'UK VAT has a standard rate applying to most services, a reduced rate and zero rate for named classes, and exemptions; most business services are standard-rated.',
    curation_expected: { standard_pct: 20, reduced_pct: 5, zero_pct: 0 },
    outcome2: { variable: 'what_the_entity_sells', resolve_from: 'profile services_engaged + invoice history' },
    refusal_boundary: 'Rate classification of an unusual or mixed supply — honest partial naming the nearest class and source.'
  }),
  q({
    spec_question: 'Q5', topic: 'vat_rates', answer_shape: 'threshold', source_key: 'vat_notice_733',
    source_anchor: 'eligibility + limited cost business sections',
    question_forms: ['What is the Flat Rate Scheme?', 'Can I join the VAT flat rate scheme?', 'What is a limited cost trader?'],
    draft_proposition: 'The Flat Rate Scheme is open below a joining turnover ceiling; VAT is paid as a fixed sector percentage of gross turnover, with a higher fixed percentage for a limited-cost business whose goods spend falls under the scheme’s test.',
    curation_expected: { join_ceiling_ex_vat_gbp: 150000, limited_cost_pct: 16.5 },
    outcome2: { variable: 'goods_spend_ratio', resolve_from: 'ledger' },
    refusal_boundary: 'Choosing the trade-sector percentage for an ambiguous trade — honest partial with the sector table cited.'
  }),

  // ── vat_deduction ─────────────────────────────────────────────────────────
  q({
    spec_question: 'Q6', topic: 'vat_deduction', answer_shape: 'rule', source_key: 'vat_notice_700',
    source_anchor: 'input tax on goods/services bought before registration',
    question_forms: ['Can I reclaim VAT on things I bought before registering?', 'Pre-registration VAT — can I claim it back?'],
    draft_proposition: 'Input VAT on goods bought before registration is reclaimable within a look-back window if the goods are still on hand, and on services within a shorter window, subject to the ordinary business-use conditions.',
    curation_expected: { goods_lookback_years: 4, services_lookback_months: 6 },
    outcome2: { variable: 'purchase_dates_and_still_in_use', resolve_from: 'documents + ledger' },
    refusal_boundary: 'Partial-exemption interaction.'
  }),
  q({
    spec_question: 'Q7', topic: 'vat_deduction', answer_shape: 'rule', source_key: 'vat_notice_700_65',
    source_anchor: 'input tax block on business entertainment (cars: 700/64, Q14)',
    question_forms: ['What VAT can I never reclaim?', 'Is there VAT I cannot claim back?'],
    draft_proposition: 'Input VAT is blocked on business entertainment and on most car purchases, regardless of business purpose; these blocks apply even where the expense itself is a business cost.',
    curation_expected: { blocked: ['business entertainment', 'most car purchase VAT'] },
    refusal_boundary: 'Partial exemption; margin schemes.'
  }),
  q({
    spec_question: 'Q8', topic: 'vat_deduction', answer_shape: 'rule', source_key: 'vat_notice_700',
    source_anchor: 'evidence for input tax / simplified invoices',
    question_forms: ['Do I need a VAT invoice to reclaim VAT?', 'Can I claim VAT back without a receipt?'],
    draft_proposition: 'Reclaiming input VAT requires a VAT invoice as evidence above the simplified-invoice level; below it a less detailed invoice suffices.',
    curation_expected: { simplified_invoice_ceiling_gbp: 250 },
    refusal_boundary: 'Alternative-evidence claims where invoices are lost.'
  }),

  // ── reverse_charge ────────────────────────────────────────────────────────
  q({
    spec_question: 'Q9', topic: 'reverse_charge', answer_shape: 'rule', source_key: 'vat_notice_741a',
    source_anchor: 'reverse charge on services received from abroad',
    question_forms: ['I buy software from a US company — what about VAT?', 'Do I pay VAT on foreign SaaS subscriptions?', 'What is the reverse charge on imported services?'],
    draft_proposition: 'A UK business buying services from abroad generally accounts for the VAT itself under the reverse charge; the self-charged amount counts toward the registration threshold turnover test.',
    curation_expected: { counts_toward_registration_threshold: true },
    outcome2: { variable: 'vat_registration_status', resolve_from: 'profile vat_registration (top-level schema home, not gb.*)' },
    refusal_boundary: 'The domestic construction (CIS) reverse charge — out of ICP scope, named refusal.'
  }),
  q({
    spec_question: 'Q10', topic: 'reverse_charge', answer_shape: 'rule', source_key: 'vat_notice_741a',
    source_anchor: 'general place-of-supply rules (B2B / B2C)',
    question_forms: ['Do I charge VAT to overseas clients?', 'My client is in the EU — do I add VAT?', 'Invoicing a US customer — VAT or not?'],
    draft_proposition: 'For services, the general B2B rule places the supply where the business customer belongs (outside UK VAT where they belong abroad), while the general B2C rule places it where the supplier belongs, with named exceptions.',
    curation_expected: { b2b_general_rule: 'customer location', b2c_general_rule: 'supplier location' },
    outcome2: { variable: 'customer_country_and_business_status', resolve_from: 'invoices' },
    refusal_boundary: 'Digital-services OSS/IOSS registration questions — honest partial with the nearest source.'
  }),

  // ── entertainment_and_meals ───────────────────────────────────────────────
  q({
    spec_question: 'Q11', topic: 'entertainment_and_meals', answer_shape: 'rule', source_key: 'bim_entertainment',
    source_anchor: 'business entertainment disallowance (with VAT Notice 700/65)',
    question_forms: ['Can I deduct taking a client to lunch?', 'Is client entertainment tax deductible?', 'Can I expense client dinners?'],
    draft_proposition: 'Client entertainment is not deductible for tax and its input VAT is blocked, for sole traders and companies alike, even when it is genuinely for business.',
    curation_expected: { client_entertainment_deductible: false, input_vat_blocked: true },
    refusal_boundary: 'Contractual/promotional-event edge cases.'
  }),
  q({
    spec_question: 'Q12', topic: 'entertainment_and_meals', answer_shape: 'rule', source_key: 'social_functions',
    source_anchor: 'annual events exemption (with BIM subsistence for own meals)',
    question_forms: ['Can I claim my own lunch?', 'Are staff meals deductible?', 'Can the company pay for a Christmas party?'],
    draft_proposition: 'An owner’s own meals are claimable only as subsistence when travelling outside the normal work pattern; for a company, staff annual events are exempt from benefit charges up to a per-head ceiling.',
    curation_expected: { annual_event_per_head_gbp: 150 },
    outcome2: { variable: 'entity_type', resolve_from: 'profile entity_type via gbEntityType' },
    refusal_boundary: 'Benefit-in-kind edges beyond the annual-event exemption.'
  }),

  // ── vehicle_costs ─────────────────────────────────────────────────────────
  q({
    spec_question: 'Q13', topic: 'vehicle_costs', answer_shape: 'rate', source_key: 'mileage_rates_amap',
    source_anchor: 'approved mileage rates table',
    question_forms: ['Can I claim mileage?', 'What is the mileage rate?', 'How much per mile can I claim?'],
    draft_proposition: 'Business mileage in a personally-owned car is claimable at the approved rate per mile up to an annual mileage break, and a lower rate beyond it; the mileage method cannot be mixed with actual vehicle costs for the same vehicle.',
    curation_expected: { rate_first_band_p: 45, band_miles: 10000, rate_after_p: 25 },
    outcome2: { variable: 'method_already_in_use', resolve_from: 'ledger + firm_facts' },
    refusal_boundary: 'Company-car benefit-in-kind computation — named refusal (outside MVP).'
  }),
  q({
    spec_question: 'Q14', topic: 'vehicle_costs', answer_shape: 'rule', source_key: 'vat_notice_700_64',
    source_anchor: 'VAT on car purchase and fuel',
    question_forms: ['Can I reclaim VAT on a car?', 'Can I claim VAT on fuel?', 'VAT on buying a van?'],
    draft_proposition: 'VAT on buying a car is blocked except in narrow classes (vans and qualifying vehicles differ); VAT on fuel with mixed private use is handled via the fuel scale charge or detailed mileage records.',
    curation_expected: { car_purchase_vat: 'blocked except narrow classes', mixed_fuel: 'scale charge or full records' },
    outcome2: { variable: 'car_vs_van', resolve_from: 'documents' },
    refusal_boundary: 'Leasing/PCP classification edges.'
  }),
  q({
    spec_question: 'Q15', topic: 'vehicle_costs', answer_shape: 'rule', source_key: 'expenses_self_employed',
    source_anchor: 'vehicle costs: capital allowances vs simplified expenses',
    question_forms: ['Should I put my car through the business?', 'Buy a car through my company or personally?'],
    draft_proposition: 'Both routes exist and their rules are stated — actual costs with capital allowances apportioned for private use, versus the mileage method — and the outcome depends on the vehicle, emissions band and usage split; the rules are cited, the choice is the owner’s.',
    curation_expected: { routes: ['actual costs + capital allowances', 'approved mileage'] },
    outcome2: { variable: 'usage_split_and_vehicle_band', resolve_from: 'owner facts' },
    refusal_boundary: 'The recommendation itself — same posture as Q3.'
  }),

  // ── home_office ───────────────────────────────────────────────────────────
  q({
    spec_question: 'Q16', topic: 'home_office', answer_shape: 'rate', source_key: 'simplified_expenses', supporting_source_keys: ['bim_home'],
    source_anchor: 'working from home flat rates table',
    question_forms: ['Can I claim for working from home?', 'What is the home office allowance?', 'How much can I claim for my home office?'],
    draft_proposition: 'A self-employed owner may use monthly flat rates banded by hours worked from home, or claim an actual-cost apportionment; the method should be applied consistently.',
    curation_expected: { flat_rates_gbp: { '25_50h': 10, '51_100h': 18, '101h_plus': 26 } },
    outcome2: { variable: 'hours_at_home_band', resolve_from: 'owner fact' },
    refusal_boundary: 'Ltd director home-working (a different regime) — cited separately if asked.'
  }),
  q({
    spec_question: 'Q17', topic: 'home_office', answer_shape: 'rule', source_key: 'hs283_prr',
    source_anchor: 'exclusive business use and private residence relief',
    question_forms: ['Will claiming home office affect selling my house?', 'Does a home office create capital gains tax?'],
    draft_proposition: 'Using a room exclusively for business can restrict private residence relief on a later sale; non-exclusive use does not. This entry carries the boundary statement only.',
    curation_expected: { exclusive_use_restricts_relief: true },
    outcome2: { variable: 'exclusive_vs_shared_use', resolve_from: 'owner fact' },
    refusal_boundary: 'Any CGT computation — hard refusal, out of MVP scope by design.'
  }),

  // ── travel_and_per_diem ───────────────────────────────────────────────────
  q({
    spec_question: 'Q18', topic: 'travel_and_per_diem', answer_shape: 'rule', source_key: 'bim_travel',
    source_anchor: 'wholly & exclusively; ordinary commuting vs itinerant base',
    question_forms: ['What travel can I claim?', 'Can I claim my commute?', 'Is travel to a client site deductible?'],
    draft_proposition: 'Business journeys are deductible; ordinary commuting between home and a regular base is not; an itinerant trade with home as its base treats travel to customer sites as business travel.',
    curation_expected: { ordinary_commuting_deductible: false },
    outcome2: { variable: 'regular_place_of_work_pattern', resolve_from: 'owner fact' },
    refusal_boundary: 'The 24-month temporary-workplace rule in depth (employee/Ltd side).'
  }),
  q({
    spec_question: 'Q19', topic: 'travel_and_per_diem', answer_shape: 'rule', source_key: 'bim_travel',
    source_anchor: 'subsistence on qualifying travel',
    question_forms: ['Can I claim hotels on a work trip?', 'Are meals on business travel deductible?'],
    draft_proposition: 'Reasonable accommodation and subsistence on a qualifying business journey are deductible alongside the travel itself.',
    curation_expected: { subsistence_on_qualifying_travel: true },
    outcome2: { variable: 'trip_business_purpose', resolve_from: 'owner fact / calendar evidence' },
    refusal_boundary: 'Scale-rate / bespoke-rate agreements (employer side).'
  }),

  // ── capitalize_vs_expense ─────────────────────────────────────────────────
  q({
    spec_question: 'Q20', topic: 'capitalize_vs_expense', answer_shape: 'rule', source_key: 'capital_allowances', supporting_source_keys: ['cash_basis'],
    source_anchor: 'AIA / plant and machinery (with cash-basis equipment treatment)',
    question_forms: ['I bought a laptop — is it an expense or an asset?', 'Do I capitalize equipment?', 'How do I treat a new computer for tax?'],
    draft_proposition: 'Under the cash basis most equipment is simply deducted when paid for; under accruals accounting the annual investment allowance gives full first-year relief for qualifying plant anyway — so for small kit the tax outcome usually converges, and the distinction is presentational.',
    curation_expected: { cash_basis: 'deduct outright', accruals: 'AIA full relief' },
    outcome2: { variable: 'accounting_basis', resolve_from: 'profile' },
    refusal_boundary: 'Software capitalization edges; assets with private use.'
  }),
  q({
    spec_question: 'Q21', topic: 'capitalize_vs_expense', answer_shape: 'threshold', source_key: 'capital_allowances',
    source_anchor: 'annual investment allowance amount',
    question_forms: ['What is the Annual Investment Allowance?', 'How much is the AIA?'],
    draft_proposition: 'The annual investment allowance gives 100% first-year relief on qualifying plant and machinery up to a permanent annual ceiling.',
    curation_expected: { aia_gbp: 1000000, permanent: true },
    refusal_boundary: 'Full-expensing (companies) interaction detail.'
  }),

  // ── payroll_basics ────────────────────────────────────────────────────────
  q({
    spec_question: 'Q22', topic: 'payroll_basics', answer_shape: 'definition', source_key: 'expenses_self_employed',
    source_anchor: 'drawings are not an expense (sole trader)',
    question_forms: ['How do I pay myself as a sole trader?', 'Are my drawings an expense?', 'Is my own salary deductible?'],
    draft_proposition: 'A sole trader takes drawings — not salary, not payroll, not a deductible expense; tax arises on the business profits through Self Assessment regardless of what is drawn.',
    curation_expected: { drawings_deductible: false, taxed_on: 'profits via SA' },
    refusal_boundary: null
  }),
  q({
    spec_question: 'Q23', topic: 'payroll_basics', answer_shape: 'rule', source_key: 'takes_money_out_ltd', supporting_source_keys: ['tax_on_dividends'],
    source_anchor: 'salary, dividends, directors’ loans (with Tax on dividends)',
    question_forms: ['How do I pay myself from my limited company?', 'Salary or dividends?', 'Can I just transfer money from the company to myself?'],
    draft_proposition: 'A director takes money out as PAYE salary, as dividends from distributable profits (requiring available profits and declarations), or creates a director’s loan with its own consequences; each route’s rules are cited. The optimal split is not computed.',
    curation_expected: { routes: ['salary (PAYE)', 'dividends (distributable profits)', 'director’s loan'] },
    outcome2: { variable: 'distributable_reserves', resolve_from: 'ledger' },
    refusal_boundary: 'The optimal salary/dividend split — outcome 2 naming the variables, never a computed optimum.'
  }),
  q({
    spec_question: 'Q24', topic: 'payroll_basics', answer_shape: 'procedure', source_key: 'register_employer', supporting_source_keys: ['paye_basics'],
    source_anchor: 'when to register + RTI basics (with PAYE and payroll for employers)',
    question_forms: ['I am hiring my first employee — what do I do?', 'Do I need to register for PAYE?', 'What are my obligations as a new employer?'],
    draft_proposition: 'A new employer registers with HMRC before the first payday, runs real-time (RTI) payroll submissions, and takes on workplace-pension auto-enrolment duties; the obligations are named, running payroll is not performed here.',
    curation_expected: { register_before_first_payday: true },
    refusal_boundary: 'Payroll RUNNING (calculations) — named refusal; K1 grounds the obligations only.'
  }),
  q({
    spec_question: 'Q25', topic: 'payroll_basics', answer_shape: 'rate', source_key: 'se_nics',
    source_anchor: 'current Class 4 / Class 2 treatment — CHANGED RECENTLY, curate carefully',
    question_forms: ['What National Insurance do I pay as a sole trader?', 'Do I still pay Class 2 NI?', 'What are the self-employed NI rates?'],
    draft_proposition: 'A sole trader pays Class 4 contributions on profits above the lower limit; the Class 2 position changed in the 2024 reform (credited/abolished band) — the curation session must pin the CURRENT state and rates.',
    curation_expected: { class_2_note: 'post-2024 reform state to confirm', class_4: 'on profits above lower limit' },
    outcome2: { variable: 'profit_level', resolve_from: 'ledger' },
    refusal_boundary: 'Voluntary Class 3; state-pension gap planning.'
  }),

  // ── invoice_requirements ──────────────────────────────────────────────────
  q({
    spec_question: 'Q26', topic: 'invoice_requirements', answer_shape: 'rule', source_key: 'invoicing_rules',
    source_anchor: 'required invoice contents',
    question_forms: ['What must be on my invoices?', 'What are the legal requirements for an invoice?'],
    draft_proposition: 'An invoice must carry the business name and address, an identifying number, the date, a description, and the amount; a limited company adds its registered details; VAT registration adds the Q27 fields.',
    curation_expected: { ltd_adds_registered_details: true },
    outcome2: { variable: 'vat_registration_status', resolve_from: 'profile vat_registration (top-level schema home, not gb.*)' },
    refusal_boundary: 'Sector-specific (CIS) invoicing.'
  }),
  q({
    spec_question: 'Q27', topic: 'invoice_requirements', answer_shape: 'procedure', source_key: 'vat_notice_700',
    source_anchor: '§16 VAT invoices: contents, 30-day issue, simplified invoices',
    question_forms: ['What extra fields does a VAT invoice need?', 'When must I issue a VAT invoice?', 'What is a simplified VAT invoice?'],
    draft_proposition: 'A VAT invoice adds the VAT number, tax point, per-line rate and the VAT amount, and must be issued within the issue window after supply; below the simplified ceiling a simplified invoice is allowed.',
    curation_expected: { issue_within_days: 30, simplified_ceiling_gbp: 250 },
    refusal_boundary: 'Self-billing arrangements.'
  }),

  // ── record_retention ──────────────────────────────────────────────────────
  q({
    spec_question: 'Q28', topic: 'record_retention', answer_shape: 'rule', source_key: 'sa_records',
    source_anchor: 'how long to keep records (with VAT Notice 700/21 for VAT)',
    question_forms: ['How long do I keep my records?', 'How many years of receipts must I keep?'],
    draft_proposition: 'Self Assessment records are kept for a fixed period after the filing deadline, VAT records longer, and company records longer still; the applicable regimes stack.',
    curation_expected: { sa_years_after_deadline: 5, vat_years: 6, company_years: 6 },
    outcome2: { variable: 'which_regimes_apply', resolve_from: 'profile (VAT-registered? Ltd?)' },
    refusal_boundary: 'Records for schemes outside scope (payroll depth, CIS).'
  }),
  q({
    spec_question: 'Q29', topic: 'record_retention', answer_shape: 'rule', source_key: 'vat_record_keeping',
    source_anchor: 'digital records / copies',
    question_forms: ['Are digital copies of receipts enough?', 'Can I throw away paper receipts after scanning?'],
    draft_proposition: 'Digital copies are generally acceptable business records, and Making Tax Digital requires digital record-keeping for VAT.',
    curation_expected: { digital_copies_acceptable: true },
    outcome2: { variable: 'mtd_status', resolve_from: 'profile' },
    refusal_boundary: 'Evidential edge cases in an enquiry.'
  }),

  // ── fiscal_period_basics ──────────────────────────────────────────────────
  q({
    spec_question: 'Q30', topic: 'fiscal_period_basics', answer_shape: 'procedure', source_key: 'sa_deadlines', supporting_source_keys: ['sa_payments_on_account'],
    source_anchor: 'deadlines + payments on account (with the POA page)',
    question_forms: ['When is my Self Assessment due?', 'What are payments on account?', 'When do I pay my tax bill?'],
    draft_proposition: 'Paper returns are due 31 October and online returns 31 January after the tax year, with the balancing payment; payments on account fall 31 January and 31 July when the prior bill exceeds the threshold and less than 80% was collected at source. The client’s OWN computed dates render from the statutory surface (soleTraderStatutoryDeadlines); this passage grounds the general rule and citation.',
    curation_expected: { online_deadline: '31 January', paper_deadline: '31 October', poa_threshold_gbp: 1000 },
    outcome2: { variable: 'prior_year_liability', resolve_from: 'the statutory surface’s named owner-fact refusal' },
    refusal_boundary: 'Calculating the tax itself.'
  }),
  q({
    spec_question: 'Q31', topic: 'fiscal_period_basics', answer_shape: 'definition', source_key: 'basis_period_reform',
    source_anchor: 'tax-year basis from 2024-25; transition rules named',
    question_forms: ['What period do I pay tax on?', 'What is basis period reform?', 'My accounting year is not April — what profits go on my return?'],
    draft_proposition: 'From 2024-25 the self-employed are taxed on the tax-year basis regardless of accounting date; transition-year spreading rules exist and are named, not computed.',
    curation_expected: { tax_year_basis_from: '2024-25' },
    outcome2: { variable: 'accounting_date', resolve_from: 'profile' },
    refusal_boundary: 'Computing transition-profit spreading — named refusal.'
  }),
  q({
    spec_question: 'Q32', topic: 'fiscal_period_basics', answer_shape: 'threshold', source_key: 'mtd_income_tax',
    source_anchor: 'who must join and from when — LIVE in the MVP’s first weeks, curate carefully',
    question_forms: ['What is Making Tax Digital?', 'Does MTD apply to me?', 'Do I have to do quarterly tax updates now?'],
    draft_proposition: 'Making Tax Digital for Income Tax applies from April 2026 to self-employment and property income over the entry threshold, with a lower threshold following; it requires digital records and quarterly updates. The curation session must pin the exact current thresholds and start dates.',
    curation_expected: { start: 'April 2026', threshold_gbp: 50000, next_threshold_gbp: 30000 },
    outcome2: { variable: 'qualifying_income', resolve_from: 'ledger' },
    refusal_boundary: 'MTD software-choice recommendations beyond “Donna keeps digital records”.'
  })
]);

export const GB_CORPUS_V1 = Object.freeze({
  corpus_version: 'gb-corpus.v1',
  jurisdiction: 'GB',
  spec: 'docs/design-donna-k1-uk-corpus-mvp.md',
  signed: '2026-08-01 (Kari, #1216 merged — D1-D5 as written)',
  review_due: GB_CORPUS_REVIEW_DUE,
  sources: GB_CORPUS_SOURCES,
  passages: GB_CORPUS_PASSAGES
});
