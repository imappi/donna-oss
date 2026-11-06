// FI-1 — Finnish standard chart of accounts (tilikartta) + statutory account-role
// map. Pure DATA + pure lookup. This module is the Kirjanpitoasetus-scheme
// reference the ledger seeds/validates against once Donna's internal ledger is the
// statutory book of record (kirjanpito). It does NOT mutate the ledger and MUST
// NOT import any isolation-listed file (`ledger.js`, writers, matchers). Seeding
// the chart into `ledger_accounts` is a separate, gated slice.
//
// Shape of each entry:
//   { code, name_fi, name_en, account_type, normal_balance, statutory_group }
// - `code`            — the account number (string; Finnish SME convention ranges).
// - `account_type`    — free text (matches `ledger_accounts.account_type`, which
//                       has no CHECK constraint). Used for grouping/reporting.
// - `normal_balance`  — 'debit' | 'credit' (matches the `ledger_accounts`
//                       CHECK constraint exactly).
// - `statutory_group` — the Kirjanpitoasetus (KPA) BS/IS line this account rolls
//                       up to. Keyed to STATUTORY_GROUPS below. FI-7 (tilinpäätös
//                       export) renders the statutory statements off this key.
//
// Rates/thresholds are NOT encoded here — this is the chart, not the ALV
// vocabulary (that is FI-2, `alvCodes.js`).

// The Kirjanpitoasetus statement lines a chart account may roll up to. Balance
// sheet = KPA 1:6 (kaavan mukainen tase); income statement = KPA 1:1
// (kululajikohtainen tuloslaskelma). Each key names a statutory line; `statement`
// is 'balance_sheet' | 'income_statement'; `side` disambiguates the BS halves.
export const STATUTORY_GROUPS = {
  // --- Tase / Balance sheet — Vastaavaa (assets) ---
  intangible_assets: { statement: 'balance_sheet', side: 'assets', name_fi: 'Aineettomat hyödykkeet', name_en: 'Intangible assets' },
  tangible_assets: { statement: 'balance_sheet', side: 'assets', name_fi: 'Aineelliset hyödykkeet', name_en: 'Tangible assets' },
  investments: { statement: 'balance_sheet', side: 'assets', name_fi: 'Sijoitukset', name_en: 'Investments' },
  inventory: { statement: 'balance_sheet', side: 'assets', name_fi: 'Vaihto-omaisuus', name_en: 'Inventory' },
  trade_receivables: { statement: 'balance_sheet', side: 'assets', name_fi: 'Myyntisaamiset', name_en: 'Trade receivables' },
  other_receivables: { statement: 'balance_sheet', side: 'assets', name_fi: 'Muut saamiset', name_en: 'Other receivables' },
  accrued_income: { statement: 'balance_sheet', side: 'assets', name_fi: 'Siirtosaamiset', name_en: 'Accrued income / prepayments' },
  cash_and_bank: { statement: 'balance_sheet', side: 'assets', name_fi: 'Rahat ja pankkisaamiset', name_en: 'Cash and bank' },
  // --- Tase / Balance sheet — Vastattavaa (equity + liabilities) ---
  share_capital: { statement: 'balance_sheet', side: 'equity', name_fi: 'Osakepääoma', name_en: 'Share capital' },
  // Ylikurssirahasto — restricted equity a pre-2006 share issue may still
  // carry (KPA 1:6 Vastattavaa A II). Its own line: never folded into share
  // capital or SVOP (D-FI13-9).
  share_premium: { statement: 'balance_sheet', side: 'equity', name_fi: 'Ylikurssirahasto', name_en: 'Share premium fund' },
  // SVOP (sijoitetun vapaan oman pääoman rahasto) — the invested unrestricted
  // equity reserve. A DISTINCT KPA equity line (OYL 8:2): a shareholder's equity
  // contribution that is NOT share capital lands here, never collapsed into share
  // capital or retained earnings (D-FI13-9 — opening balances may not collapse the
  // Oy equity items). It matters downstream for distributable-equity and
  // return-of-capital treatment.
  invested_unrestricted_equity: { statement: 'balance_sheet', side: 'equity', name_fi: 'Sijoitetun vapaan oman pääoman rahasto (SVOP)', name_en: 'Reserve for invested unrestricted equity (SVOP)' },
  retained_earnings: { statement: 'balance_sheet', side: 'equity', name_fi: 'Edellisten tilikausien voitto (tappio)', name_en: 'Retained earnings' },
  profit_for_year: { statement: 'balance_sheet', side: 'equity', name_fi: 'Tilikauden voitto (tappio)', name_en: 'Profit (loss) for the financial year' },
  // Capital loan (pääomalaina, OYL 12 luku) — a subordinated loan with equity-like
  // repayment restrictions. Its statutory PRESENTATION (equity vs a separate
  // liability item) is FI-accountant-sensitive and depends on the loan's terms;
  // modelled here as its own line so it is never silently folded into share capital
  // or ordinary loans. A Finnish accountant confirms the placement before any FI
  // canary. confirmedAgainstPrimary: false.
  capital_loans: { statement: 'balance_sheet', side: 'liabilities', name_fi: 'Pääomalainat', name_en: 'Capital loans' },
  // Shareholder / related-party balances — kept as DISTINCT statutory lines (not
  // folded into generic receivables/payables) so FI-7 can render the related-party
  // note and the D-FI13-18/19 watches read them directly (D-FI13-9).
  shareholder_loan_receivable: { statement: 'balance_sheet', side: 'assets', name_fi: 'Lainasaamiset osakkailta', name_en: 'Loan receivables from shareholders' },
  long_term_liabilities: { statement: 'balance_sheet', side: 'liabilities', name_fi: 'Pitkäaikainen vieras pääoma', name_en: 'Long-term liabilities' },
  trade_payables: { statement: 'balance_sheet', side: 'liabilities', name_fi: 'Ostovelat', name_en: 'Trade payables' },
  shareholder_loan_payable: { statement: 'balance_sheet', side: 'liabilities', name_fi: 'Lainat osakkailta', name_en: 'Loans from shareholders' },
  dividends_payable: { statement: 'balance_sheet', side: 'liabilities', name_fi: 'Osingonjakovelka', name_en: 'Dividends payable' },
  shareholder_reimbursements_payable: { statement: 'balance_sheet', side: 'liabilities', name_fi: 'Kulukorvausvelat osakkaille', name_en: 'Expense reimbursements payable to shareholders' },
  vat_liability: { statement: 'balance_sheet', side: 'liabilities', name_fi: 'Arvonlisäverovelka', name_en: 'VAT (ALV) liability' },
  other_liabilities: { statement: 'balance_sheet', side: 'liabilities', name_fi: 'Muut velat', name_en: 'Other liabilities' },
  accrued_liabilities: { statement: 'balance_sheet', side: 'liabilities', name_fi: 'Siirtovelat', name_en: 'Accrued liabilities' },
  // --- Tuloslaskelma / Income statement (KPA 1:1) ---
  turnover: { statement: 'income_statement', name_fi: 'Liikevaihto', name_en: 'Turnover' },
  other_operating_income: { statement: 'income_statement', name_fi: 'Liiketoiminnan muut tuotot', name_en: 'Other operating income' },
  materials_and_services: { statement: 'income_statement', name_fi: 'Materiaalit ja palvelut', name_en: 'Materials and services' },
  personnel_expenses: { statement: 'income_statement', name_fi: 'Henkilöstökulut', name_en: 'Personnel expenses' },
  depreciation: { statement: 'income_statement', name_fi: 'Poistot ja arvonalentumiset', name_en: 'Depreciation and impairment' },
  other_operating_expenses: { statement: 'income_statement', name_fi: 'Liiketoiminnan muut kulut', name_en: 'Other operating expenses' },
  financial_income_and_expenses: { statement: 'income_statement', name_fi: 'Rahoitustuotot ja -kulut', name_en: 'Financial income and expenses' },
  income_taxes: { statement: 'income_statement', name_fi: 'Tuloverot', name_en: 'Income taxes' },
  // Toiminimi (sole-trader) equity — the private account. A toiminimi has no share
  // capital; equity moves via private withdrawals/deposits (yksityisnostot/
  // yksityissijoitukset) against the owner's capital (oma pääoma / yksityistili).
  private_equity: { statement: 'balance_sheet', side: 'equity', name_fi: 'Oma pääoma (yksityistili)', name_en: "Owner's equity (private account)" }
};

// The standard Finnish SME chart. Codes follow the common Finnish numbering:
// 1xxx = assets, 2xxx = equity + liabilities, 3xxx = turnover, 4xxx = materials,
// 5xxx = personnel, 6-7xxx = other operating, 8xxx = depreciation, 9xxx = finance
// + taxes. This is a representative statutory core (not every possible account) —
// extending it is a data addition, not a design change.
export const TILIKARTTA = [
  // --- Vastaavaa (assets) ---
  { code: '1000', name_fi: 'Kehittämismenot', name_en: 'Development costs', account_type: 'intangible_asset', normal_balance: 'debit', statutory_group: 'intangible_assets' },
  { code: '1030', name_fi: 'Aineettomat oikeudet', name_en: 'Intangible rights', account_type: 'intangible_asset', normal_balance: 'debit', statutory_group: 'intangible_assets' },
  { code: '1120', name_fi: 'Koneet ja kalusto', name_en: 'Machinery and equipment', account_type: 'tangible_asset', normal_balance: 'debit', statutory_group: 'tangible_assets' },
  { code: '1180', name_fi: 'Kertyneet poistot koneista ja kalustosta', name_en: 'Accumulated depreciation, machinery and equipment', account_type: 'tangible_asset', normal_balance: 'credit', statutory_group: 'tangible_assets' },
  { code: '1400', name_fi: 'Osuudet saman konsernin yrityksissä', name_en: 'Holdings in group undertakings', account_type: 'investment', normal_balance: 'debit', statutory_group: 'investments' },
  { code: '1500', name_fi: 'Aineet ja tarvikkeet', name_en: 'Materials and supplies', account_type: 'inventory', normal_balance: 'debit', statutory_group: 'inventory' },
  { code: '1700', name_fi: 'Myyntisaamiset', name_en: 'Trade receivables', account_type: 'receivable', normal_balance: 'debit', statutory_group: 'trade_receivables' },
  { code: '1730', name_fi: 'Muut saamiset', name_en: 'Other receivables', account_type: 'receivable', normal_balance: 'debit', statutory_group: 'other_receivables' },
  { code: '1750', name_fi: 'Siirtosaamiset', name_en: 'Accrued income and prepaid expenses', account_type: 'receivable', normal_balance: 'debit', statutory_group: 'accrued_income' },
  { code: '1763', name_fi: 'Arvonlisäverosaaminen', name_en: 'VAT (ALV) receivable', account_type: 'receivable', normal_balance: 'debit', statutory_group: 'other_receivables' },
  { code: '1900', name_fi: 'Käteinen raha', name_en: 'Cash on hand', account_type: 'cash', normal_balance: 'debit', statutory_group: 'cash_and_bank' },
  { code: '1910', name_fi: 'Pankkitili', name_en: 'Bank account', account_type: 'bank', normal_balance: 'debit', statutory_group: 'cash_and_bank' },
  // --- Vastattavaa (equity + liabilities) ---
  { code: '2000', name_fi: 'Osakepääoma', name_en: 'Share capital', account_type: 'equity', normal_balance: 'credit', statutory_group: 'share_capital' },
  { code: '2251', name_fi: 'Edellisten tilikausien voitto (tappio)', name_en: 'Retained earnings (loss)', account_type: 'equity', normal_balance: 'credit', statutory_group: 'retained_earnings' },
  { code: '2371', name_fi: 'Tilikauden voitto (tappio)', name_en: 'Profit (loss) for the financial year', account_type: 'equity', normal_balance: 'credit', statutory_group: 'profit_for_year' },
  { code: '2620', name_fi: 'Lainat rahoituslaitoksilta', name_en: 'Loans from financial institutions', account_type: 'liability', normal_balance: 'credit', statutory_group: 'long_term_liabilities' },
  { code: '2870', name_fi: 'Ostovelat', name_en: 'Trade payables', account_type: 'liability', normal_balance: 'credit', statutory_group: 'trade_payables' },
  // Inventory-posting GRNI (I4·posting P2, design §5-A/§8). The accrued purchase
  // liability between goods-receipt and supplier-bill, monetary (FX-retranslated at
  // close). Statutory placement under Siirtovelat (accrued liabilities) is the
  // accrual-nature home for an uninvoiced obligation; the final Ostovelat-vs-Siirtovelat
  // presentation is FI-statutory-sensitive and a Finnish accountant confirms it before
  // any FI canary (design §8). Not exported/seeded until the INVENTORY_ACCOUNTING flag
  // and per-client capability enablement turn on.
  { code: '2880', name_fi: 'Saapuneet, laskuttamattomat ostot', name_en: 'Goods received not invoiced (GRNI)', account_type: 'liability', normal_balance: 'credit', statutory_group: 'accrued_liabilities' },
  { code: '2930', name_fi: 'Tuloverovelka', name_en: 'Income tax payable', account_type: 'liability', normal_balance: 'credit', statutory_group: 'other_liabilities' },
  { code: '2939', name_fi: 'Suoritettava arvonlisävero', name_en: 'VAT (ALV) payable', account_type: 'liability', normal_balance: 'credit', statutory_group: 'vat_liability' },
  { code: '2940', name_fi: 'Vähennettävä arvonlisävero', name_en: 'Deductible VAT (ALV)', account_type: 'liability', normal_balance: 'debit', statutory_group: 'vat_liability' },
  { code: '2945', name_fi: 'Ennakonpidätys- ja sosiaaliturvamaksuvelat', name_en: 'Withholding tax and social security contributions payable', account_type: 'liability', normal_balance: 'credit', statutory_group: 'other_liabilities' },
  { code: '2950', name_fi: 'Työeläke- ja sivukuluvelat', name_en: 'Pension and payroll contributions payable', account_type: 'liability', normal_balance: 'credit', statutory_group: 'other_liabilities' },
  { code: '2960', name_fi: 'Muut velat', name_en: 'Other liabilities', account_type: 'liability', normal_balance: 'credit', statutory_group: 'other_liabilities' },
  { code: '2970', name_fi: 'Siirtovelat', name_en: 'Accrued liabilities and deferred income', account_type: 'liability', normal_balance: 'credit', statutory_group: 'accrued_liabilities' },
  // --- Tuloslaskelma: tuotot (income) ---
  // 3000 is the general sales account: the ALV code on each line carries the
  // rate (FI-21 — the coder's 'Sales' posts here whatever the rate).
  { code: '3000', name_fi: 'Myynti', name_en: 'Sales', account_type: 'revenue', normal_balance: 'credit', statutory_group: 'turnover' },
  { code: '3060', name_fi: 'Myynti (alennettu ALV-kanta)', name_en: 'Sales (reduced-rated)', account_type: 'revenue', normal_balance: 'credit', statutory_group: 'turnover' },
  { code: '3200', name_fi: 'Myynti EU-alueelle (yhteisömyynti)', name_en: 'Intra-EU supplies', account_type: 'revenue', normal_balance: 'credit', statutory_group: 'turnover' },
  { code: '3400', name_fi: 'Vientimyynti EU:n ulkopuolelle', name_en: 'Exports outside EU', account_type: 'revenue', normal_balance: 'credit', statutory_group: 'turnover' },
  { code: '3900', name_fi: 'Liiketoiminnan muut tuotot', name_en: 'Other operating income', account_type: 'revenue', normal_balance: 'credit', statutory_group: 'other_operating_income' },
  // --- Tuloslaskelma: kulut (expenses) ---
  { code: '4000', name_fi: 'Ostot tilikauden aikana', name_en: 'Purchases during the financial year', account_type: 'expense', normal_balance: 'debit', statutory_group: 'materials_and_services' },
  // Inventory change (I4·posting P2, design §8). The kululajikohtainen tuloslaskelma
  // (KPA 1:1) presents "Materiaalit ja palvelut" by NATURE: Ostot (4000) ± Varastojen
  // muutos. Bidirectional (an inventory increase credits/reduces cost; a decrease
  // debits/increases it) — debit-normal here to sit in the materials expense family.
  // PERPETUAL-VS-STATUTORY: Donna's operational ledger is PERPETUAL — it posts inventory
  // and COGS continuously and NEVER posts to this account directly. This row exists only
  // as the target for the I6 FI-pack reporting mapping that re-presents the perpetual
  // movements in the statutory purchases + Varaston muutos form; that mapping is I6 and a
  // Finnish accountant confirms it before any FI canary (design §8).
  { code: '4090', name_fi: 'Varastojen muutos', name_en: 'Change in inventories', account_type: 'expense', normal_balance: 'debit', statutory_group: 'materials_and_services' },
  { code: '4100', name_fi: 'Tarvikeostot', name_en: 'Supplies purchases', account_type: 'expense', normal_balance: 'debit', statutory_group: 'materials_and_services' },
  { code: '4400', name_fi: 'Ulkopuoliset palvelut', name_en: 'External services', account_type: 'expense', normal_balance: 'debit', statutory_group: 'materials_and_services' },
  { code: '5000', name_fi: 'Palkat ja palkkiot', name_en: 'Wages and salaries', account_type: 'expense', normal_balance: 'debit', statutory_group: 'personnel_expenses' },
  { code: '5300', name_fi: 'Eläkekulut', name_en: 'Pension costs', account_type: 'expense', normal_balance: 'debit', statutory_group: 'personnel_expenses' },
  { code: '5310', name_fi: 'YEL-maksut', name_en: 'YEL pension contributions', account_type: 'expense', normal_balance: 'debit', statutory_group: 'personnel_expenses' },
  { code: '5400', name_fi: 'Muut henkilösivukulut', name_en: 'Other social security costs', account_type: 'expense', normal_balance: 'debit', statutory_group: 'personnel_expenses' },
  { code: '6800', name_fi: 'Suunnitelman mukaiset poistot', name_en: 'Depreciation according to plan', account_type: 'expense', normal_balance: 'debit', statutory_group: 'depreciation' },
  { code: '7000', name_fi: 'Vuokrakulut', name_en: 'Rent expenses', account_type: 'expense', normal_balance: 'debit', statutory_group: 'other_operating_expenses' },
  // FI-21 (2026-10-15): the operating-expense accounts the FI pack palette
  // codes against (software, telecom, insurance, …) so a born chart carries a
  // statutory home for every coding choice. Representative SME numbering, the
  // same unreviewed status as the rest of this chart: a Finnish accountant
  // confirms names and codes before they are treated as reviewed.
  { code: '7050', name_fi: 'Sähkö, vesi ja lämpö', name_en: 'Electricity, water and heating', account_type: 'expense', normal_balance: 'debit', statutory_group: 'other_operating_expenses' },
  { code: '7300', name_fi: 'Matkakulut', name_en: 'Travel expenses', account_type: 'expense', normal_balance: 'debit', statutory_group: 'other_operating_expenses' },
  { code: '7350', name_fi: 'Edustuskulut', name_en: 'Entertainment expenses', account_type: 'expense', normal_balance: 'debit', statutory_group: 'other_operating_expenses' },
  { code: '7400', name_fi: 'Ajoneuvokulut', name_en: 'Vehicle expenses', account_type: 'expense', normal_balance: 'debit', statutory_group: 'other_operating_expenses' },
  { code: '7600', name_fi: 'Markkinointikulut', name_en: 'Marketing expenses', account_type: 'expense', normal_balance: 'debit', statutory_group: 'other_operating_expenses' },
  { code: '7680', name_fi: 'ATK-ohjelmistot ja -lisenssit', name_en: 'Software and licences', account_type: 'expense', normal_balance: 'debit', statutory_group: 'other_operating_expenses' },
  { code: '7700', name_fi: 'Puhelin- ja tietoliikennekulut', name_en: 'Telephone and data communication', account_type: 'expense', normal_balance: 'debit', statutory_group: 'other_operating_expenses' },
  { code: '7720', name_fi: 'Vakuutukset', name_en: 'Insurance premiums', account_type: 'expense', normal_balance: 'debit', statutory_group: 'other_operating_expenses' },
  { code: '7740', name_fi: 'Toimistotarvikkeet ja -kulut', name_en: 'Office supplies and expenses', account_type: 'expense', normal_balance: 'debit', statutory_group: 'other_operating_expenses' },
  { code: '7800', name_fi: 'Muut liiketoiminnan kulut', name_en: 'Other operating expenses', account_type: 'expense', normal_balance: 'debit', statutory_group: 'other_operating_expenses' },
  { code: '7840', name_fi: 'Kirjanpito- ja tilintarkastuspalvelut', name_en: 'Accounting and audit services', account_type: 'expense', normal_balance: 'debit', statutory_group: 'other_operating_expenses' },
  { code: '7860', name_fi: 'Asiantuntijapalvelut', name_en: 'Professional services', account_type: 'expense', normal_balance: 'debit', statutory_group: 'other_operating_expenses' },
  { code: '7870', name_fi: 'Viranomaismaksut', name_en: 'Statutory and registration fees', account_type: 'expense', normal_balance: 'debit', statutory_group: 'other_operating_expenses' },
  { code: '7900', name_fi: 'Pankkikulut', name_en: 'Bank charges', account_type: 'expense', normal_balance: 'debit', statutory_group: 'other_operating_expenses' },
  { code: '7910', name_fi: 'Maksunvälityspalkkiot', name_en: 'Payment processing fees', account_type: 'expense', normal_balance: 'debit', statutory_group: 'other_operating_expenses' },
  { code: '9200', name_fi: 'Korkokulut', name_en: 'Interest expenses', account_type: 'expense', normal_balance: 'debit', statutory_group: 'financial_income_and_expenses' },
  { code: '9300', name_fi: 'Korkotuotot', name_en: 'Interest income', account_type: 'revenue', normal_balance: 'credit', statutory_group: 'financial_income_and_expenses' },
  // Exchange-rate differences post both ways (a gain credits, a loss debits).
  { code: '9400', name_fi: 'Kurssierot', name_en: 'Exchange rate differences', account_type: 'expense', normal_balance: 'debit', statutory_group: 'financial_income_and_expenses' },
  { code: '9800', name_fi: 'Tuloverot', name_en: 'Income taxes', account_type: 'expense', normal_balance: 'debit', statutory_group: 'income_taxes' }
];

// --- Toiminimi (sole-trader) profile ---------------------------------------
// The base TILIKARTTA above is Oy-shaped (share capital, retained earnings). A
// sole trader's chart differs: no share capital, equity via the private account
// (yksityisnostot/-sijoitukset), and — for a NON-ALV-registered toiminimi (below
// the €20,000 turnover threshold) — the ALV accounts are dormant. `buildToiminimiChart`
// derives the sole-trader chart from the shared base WITHOUT removing the Oy
// accounts (which Phase 2 needs), so there is one source of truth for the chart.

// The private-account (oma pääoma) additions for a toiminimi.
export const TOIMINIMI_EQUITY_ACCOUNTS = [
  { code: '2050', name_fi: 'Oma pääoma', name_en: "Owner's equity", account_type: 'equity', normal_balance: 'credit', statutory_group: 'private_equity' },
  { code: '2051', name_fi: 'Yksityisnostot', name_en: 'Private withdrawals', account_type: 'equity', normal_balance: 'debit', statutory_group: 'private_equity' },
  { code: '2052', name_fi: 'Yksityissijoitukset', name_en: 'Private deposits', account_type: 'equity', normal_balance: 'credit', statutory_group: 'private_equity' }
];

// --- Osakeyhtiö (Oy) profile -----------------------------------------------
// The base TILIKARTTA already carries the CORE Oy equity (2000 share capital,
// 2251 retained earnings, 2371 result for the year). The FULL D-FI13-9 Oy equity
// + owner/related-party model needs the accounts below in ADDITION — SVOP, the
// capital loan, and the shareholder-balance accounts (loan receivable AND
// payable, dividends payable, expense reimbursements payable). They live in a
// separate array (not the base) so a toiminimi chart never picks them up, exactly
// like TOIMINIMI_EQUITY_ACCOUNTS. `buildOyChart` composes base + these.
//
// D-FI13-9: opening balances may NOT collapse these into generic equity — each is
// an explicit account with its own statutory_group so FI-7 renders them and the
// D-FI13-18/19 watches (osakaslaina, distributable equity, related-party) read
// them directly. The pääomalaina placement is FI-accountant-confirmed
// (confirmedAgainstPrimary: false — see the capital_loans group note above).
export const OY_EQUITY_ACCOUNTS = [
  { code: '2020', name_fi: 'Ylikurssirahasto', name_en: 'Share premium fund', account_type: 'equity', normal_balance: 'credit', statutory_group: 'share_premium' },
  { code: '2110', name_fi: 'Sijoitetun vapaan oman pääoman rahasto (SVOP)', name_en: 'Reserve for invested unrestricted equity (SVOP)', account_type: 'equity', normal_balance: 'credit', statutory_group: 'invested_unrestricted_equity' },
  { code: '2760', name_fi: 'Pääomalaina', name_en: 'Capital loan', account_type: 'liability', normal_balance: 'credit', statutory_group: 'capital_loans' },
  { code: '1760', name_fi: 'Lainasaamiset osakkailta', name_en: 'Loan receivables from shareholders', account_type: 'receivable', normal_balance: 'debit', statutory_group: 'shareholder_loan_receivable' },
  { code: '2762', name_fi: 'Lainat osakkailta', name_en: 'Loans from shareholders', account_type: 'liability', normal_balance: 'credit', statutory_group: 'shareholder_loan_payable' },
  { code: '2764', name_fi: 'Osingonjakovelka', name_en: 'Dividends payable', account_type: 'liability', normal_balance: 'credit', statutory_group: 'dividends_payable' },
  { code: '2766', name_fi: 'Kulukorvausvelka osakkaalle', name_en: 'Expense reimbursements payable to shareholder', account_type: 'liability', normal_balance: 'credit', statutory_group: 'shareholder_reimbursements_payable' }
];

// The Oy-only statutory groups (present in an Oy chart, absent from a toiminimi's).
// Used by tests and any consumer that needs to know "is this an Oy equity line?".
export const OY_ONLY_STATUTORY_GROUPS = new Set([
  'share_capital', 'share_premium', 'retained_earnings', 'invested_unrestricted_equity', 'capital_loans',
  'shareholder_loan_receivable', 'shareholder_loan_payable', 'dividends_payable',
  'shareholder_reimbursements_payable'
]);

// The ALV account codes — dormant for a non-ALV toiminimi (kept in the base chart
// for Phase 2). Matched by code so the base chart's grouping is not disturbed.
export const ALV_ACCOUNT_CODES = new Set(['1763', '2939', '2940']);

// Oy-only equity statutory groups (share capital / retained earnings) — excluded
// from a toiminimi chart; a sole trader's result flows to the private account.
const OY_ONLY_EQUITY_GROUPS = new Set(['share_capital', 'retained_earnings']);

// buildToiminimiChart({ alvRegistered }) — the sole-trader account list derived
// from the shared base: drop Oy-only equity, add the private-account equity, and
// (when not ALV-registered) drop the dormant ALV accounts. Pure; returns a new
// array, never mutates TILIKARTTA.
export const buildToiminimiChart = ({ alvRegistered = false } = {}) => {
  const base = TILIKARTTA.filter((e) => {
    if (OY_ONLY_EQUITY_GROUPS.has(e.statutory_group)) return false;
    if (!alvRegistered && ALV_ACCOUNT_CODES.has(e.code)) return false;
    return true;
  });
  return [...base, ...TOIMINIMI_EQUITY_ACCOUNTS];
};

// buildOyChart({ alvRegistered }) — the osakeyhtiö account list: the shared base
// (which already carries the core Oy equity) plus the full D-FI13-9 Oy equity +
// owner/related-party accounts. Unlike the toiminimi chart it KEEPS the share
// capital / retained-earnings lines and never adds the private-account equity.
// `alvRegistered` defaults true (an Oy is ordinarily ALV-registered) but a small
// non-registered Oy drops the dormant ALV accounts, same rule as the toiminimi
// chart. Pure; returns a new array, never mutates TILIKARTTA.
export const buildOyChart = ({ alvRegistered = true } = {}) => {
  const base = TILIKARTTA.filter((e) => {
    if (!alvRegistered && ALV_ACCOUNT_CODES.has(e.code)) return false;
    return true;
  });
  return [...base, ...OY_EQUITY_ACCOUNTS];
};

// FI-13 13.3A — the Oy account-code groups the balance-sheet watches
// (oyBalanceSheetWatches.js) read from the posted ledger. Derived from the Oy
// chart by statutory_group so the reader can never drift from the chart
// definition. Frozen at load.
export const OY_WATCH_ACCOUNT_CODES = (() => {
  const chart = buildOyChart({ alvRegistered: true });
  const byGroup = (groups) => chart.filter((a) => groups.includes(a.statutory_group)).map((a) => a.code);
  return Object.freeze({
    equity: Object.freeze(byGroup(['share_capital', 'share_premium', 'invested_unrestricted_equity', 'retained_earnings', 'profit_for_year'])),
    distributable_equity: Object.freeze(byGroup(['invested_unrestricted_equity', 'retained_earnings', 'profit_for_year'])),
    capital_loans: Object.freeze(byGroup(['capital_loans'])),
    shareholder_loan_receivable: Object.freeze(byGroup(['shareholder_loan_receivable'])),
    vat_liability: Object.freeze(byGroup(['vat_liability']))
  });
})();

// O(1) lookup by code. Built once at module load.
const BY_CODE = new Map(TILIKARTTA.map((entry) => [entry.code, entry]));

// resolveAccount(code) — return the chart entry for an account number, or null.
// Pure; never throws on a miss (a miss = "not a standard tilikartta account",
// which the caller decides how to handle — it is not an error here).
export const resolveAccount = (code) => {
  if (code === null || code === undefined) return null;
  return BY_CODE.get(String(code).trim()) || null;
};

// resolveStatutoryGroup(key) — return the KPA statement-line descriptor, or null.
export const resolveStatutoryGroup = (key) => STATUTORY_GROUPS[key] || null;

// The set of valid statutory-group keys (for validation by callers/tests).
export const STATUTORY_GROUP_KEYS = new Set(Object.keys(STATUTORY_GROUPS));
