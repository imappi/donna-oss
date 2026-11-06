// Donna canonical account roles — the stable semantic identity under a chart of
// accounts (CoA architecture, slice 1). See docs/donna-coa-architecture.md.
//
// WHY. Today the coding/reporting/reconciliation/connector surfaces all key off
// account NAME strings ("Software" / "IT & software" / "SaaS" fragment), and the
// only fallback vocabulary is the SG-flavoured XERO_ACCOUNT_OPTIONS list. A small,
// stable, human-owned set of canonical ROLES gives every account — local or
// external, in any jurisdiction or language — one machine-facing identity. Display
// names and connector codes become VIEWS onto a role.
//
// KEEP-LAYER, NOT INTELLIGENCE-SUBSTITUTING. The role SET and its invariants
// (class, normal balance, control-ness) are deterministic correctness data. The
// mapping of an UNKNOWN display name → a role is the STRONG MODEL's job (a later
// slice). The deterministic mapper here covers ONLY Donna's own known seed
// accounts (the provision template + the legacy fallback list) via an EXPLICIT
// table — never a fuzzy name regex (that was the #497 "owner's name → director" anti-
// pattern). Unknown names return null, for the model to resolve.

import { normalizeIntelText } from './transactionIntel.js';

// `contra_asset` and `pnl` join the base classes for the inventory-posting roles
// (I4·posting P2, design §8). A contra-asset (the valuation allowance) is an
// asset-section line carried at a CREDIT normal balance (it reduces net
// inventory); a `pnl` role (the count variance) is a bidirectional profit-and-loss
// line that is neither a pure expense nor pure revenue. Every inventory account is
// PROVISIONED with an explicit `account_type` at capability enablement (design §8 —
// no mint-on-post), so the two `roleMeta().class` fallbacks that only know the five
// statement classes (ledgerReadModel.js, firmDb.js __ledgerAccountMintShape) are
// never reached for these roles; their statement placement rides the provisioned
// account_type, not the class fallback.
export const ACCOUNT_ROLE_CLASSES = [
  'asset', 'liability', 'equity', 'revenue', 'expense', 'clearing', 'control',
  'contra_asset', 'pnl'
];

// The canonical roles. Coarse and stable by design — granularity should emerge
// from real operational need (a model proposal), not by minting a role per
// merchant. control/clearing roles carry no fixed normal balance (bidirectional).
// normal_balance: 'debit' | 'credit' | null.
export const ACCOUNT_ROLES = {
  'asset.cash': { class: 'asset', normal_balance: 'debit', control: false, label: 'Cash / bank' },
  'asset.accounts_receivable': { class: 'asset', normal_balance: 'debit', control: false, label: 'Accounts receivable' },
  'asset.prepaid': { class: 'asset', normal_balance: 'debit', control: false, label: 'Prepayments' },
  'asset.fixed': { class: 'asset', normal_balance: 'debit', control: false, label: 'Fixed assets' },
  // Inventory-posting roles (I4·posting P2, design §8). asset.inventory is the
  // perpetual cost subledger's GL asset; receivable_from_owner is the Oy private-use
  // variant (I6-gated — v1 detects-and-escalates private use, never auto-posts).
  'asset.inventory': { class: 'asset', normal_balance: 'debit', control: false, label: 'Inventory' },
  'asset.receivable_from_owner': { class: 'asset', normal_balance: 'debit', control: false, label: 'Receivable from owner' },

  'liability.accounts_payable': { class: 'liability', normal_balance: 'credit', control: false, label: 'Accounts payable' },
  // Goods-received-not-invoiced: the accrued purchase liability between receipt and
  // bill (design §5-A). A MONETARY liability — foreign-currency GRNI is retranslated
  // at close (§5-A/§10), surfaced by the §16 GRNI reconciliation.
  'liability.grni': { class: 'liability', normal_balance: 'credit', control: false, label: 'Goods received not invoiced (GRNI)' },
  'liability.tax_payable': { class: 'liability', normal_balance: 'credit', control: true, label: 'Tax payable' },
  // The CONSUMPTION-tax control account, split out from liability.tax_payable
  // (gap 10). Both first-class markets declared two accounts on the shared role
  // — FI: Suoritettava arvonlisävero + Ennakkovero payable; GB: VAT payable +
  // Corporation tax payable — so a posting path that resolves by role could
  // only ever refuse AMBIGUOUS and never reach a VAT control leg. Neither pack
  // was wrong: VAT and corporation tax are separately assessed, separately paid
  // and separately reconciled. The CONTRACT could not express the distinction,
  // and per the pack rail the engine is the bug.
  //
  // Why it must be resolvable at all: FI and SG each hardcode their control
  // account (tilikartta 2939, SFRS 2950) because each market ships a STATUTORY
  // chart, so the code is a real statutory fact. The UK ships none — a
  // hardcoded GB code would be an invention wearing a statutory face — so GB's
  // control leg resolves from the client's own chart by this role.
  //
  // Market-neutral by construction: it must name FI's ALV, GB's VAT, SG's and
  // AU's GST without favouring one. `liability.vat_payable` would have been a
  // GB design that FI merely tolerated. With this role carrying the
  // consumption tax, liability.tax_payable now unambiguously means "an assessed
  // tax that is not the consumption tax" (corporation tax, ennakkovero).
  'liability.sales_tax_payable': { class: 'liability', normal_balance: 'credit', control: true, label: 'Sales tax / VAT payable' },
  'liability.payroll_payable': { class: 'liability', normal_balance: 'credit', control: true, label: 'Payroll / statutory payable' },
  'liability.loan': { class: 'liability', normal_balance: 'credit', control: false, label: 'Loan payable' },
  'liability.director_loan': { class: 'liability', normal_balance: 'credit', control: false, label: 'Director / shareholder loan' },
  'liability.related_party_loan': { class: 'liability', normal_balance: 'credit', control: false, label: 'Related-party loan' },

  'equity.share_capital': { class: 'equity', normal_balance: 'credit', control: false, label: 'Share capital' },
  'equity.share_premium': { class: 'equity', normal_balance: 'credit', control: false, label: 'Share premium' },
  'equity.retained_earnings': { class: 'equity', normal_balance: 'credit', control: false, label: 'Retained earnings' },
  'equity.owner_drawings': { class: 'equity', normal_balance: 'debit', control: false, label: 'Owner drawings' },
  // Contributed capital of an UNINCORPORATED owner — GB sole trader "Owner
  // capital introduced", FI toiminimi "Oma pääoma" (the yksityissijoitukset
  // side). Decided 2026-07-31 (the batch-4 review question), market-neutral by
  // construction: both markets pose the same account and no existing equity
  // role can carry it. Reusing equity.retained_earnings was the least-wrong
  // placeholder and it BROKE the singleton discipline — the GB sole-trader
  // default chart put two accounts on one cutover-singleton role, so an
  // opening-balance intake could never land a retained-earnings line. Distinct
  // from equity.share_capital (an incorporated share issue) and from
  // equity.retained_earnings (accumulated results); the credit-normal partner
  // of equity.owner_drawings.
  'equity.owner_capital': { class: 'equity', normal_balance: 'credit', control: false, label: 'Owner capital' },

  'revenue.operating': { class: 'revenue', normal_balance: 'credit', control: false, label: 'Operating revenue' },
  'revenue.other': { class: 'revenue', normal_balance: 'credit', control: false, label: 'Other income' },
  'expense.interest': { class: 'expense', normal_balance: 'debit', control: false, label: 'Interest expense' },
  'revenue.interest': { class: 'revenue', normal_balance: 'credit', control: false, label: 'Interest income' },

  'expense.cost_of_sales': { class: 'expense', normal_balance: 'debit', control: false, label: 'Cost of sales' },
  // Inventory-posting P&L roles (I4·posting P2, design §8/§5). cost_of_sales_adjustment
  // routes non-PPV cost movements (landed cost, provisional-to-actual) that must not be
  // forced onto the PPV line; purchase_price_variance is the signed PPV component of the
  // §4 variance decomposition (favorable or unfavorable → bidirectional); inventory_write_down
  // is the §5-F NRV write-down expense.
  'expense.cost_of_sales_adjustment': { class: 'expense', normal_balance: 'debit', control: false, label: 'Cost of sales adjustment' },
  'expense.purchase_price_variance': { class: 'expense', normal_balance: 'debit', control: false, bidirectional: true, label: 'Purchase price variance' },
  'expense.inventory_write_down': { class: 'expense', normal_balance: 'debit', control: false, label: 'Inventory write-down' },
  'expense.software': { class: 'expense', normal_balance: 'debit', control: false, label: 'Software & IT' },
  'expense.travel': { class: 'expense', normal_balance: 'debit', control: false, label: 'Travel' },
  'expense.meals': { class: 'expense', normal_balance: 'debit', control: false, label: 'Meals & entertainment' },
  'expense.marketing': { class: 'expense', normal_balance: 'debit', control: false, label: 'Marketing' },
  'expense.professional_fees': { class: 'expense', normal_balance: 'debit', control: false, label: 'Professional fees' },
  'expense.accounting_fees': { class: 'expense', normal_balance: 'debit', control: false, label: 'Accounting fees' },
  'expense.statutory_fees': { class: 'expense', normal_balance: 'debit', control: false, label: 'Statutory / filing fees' },
  'expense.payroll': { class: 'expense', normal_balance: 'debit', control: false, label: 'Payroll' },
  'expense.rent': { class: 'expense', normal_balance: 'debit', control: false, label: 'Rent' },
  'expense.telecom': { class: 'expense', normal_balance: 'debit', control: false, label: 'Telecommunications' },
  'expense.insurance': { class: 'expense', normal_balance: 'debit', control: false, label: 'Insurance' },
  'expense.office': { class: 'expense', normal_balance: 'debit', control: false, label: 'Office operations' },
  // Consumable materials used to run the trade but not booked through the
  // inventory/COGS subledger: apiary smoker fuel and hive staples, workshop
  // consumables, cleaning materials and PPE. Distinct from expense.office
  // (administrative supplies) and expense.cost_of_sales (inventory issued on
  // sale). The strong coder decides which role fits the evidence; this role
  // keeps the closed account enum from forcing operational inputs into either
  // of those two materially different buckets.
  'expense.operating_supplies': { class: 'expense', normal_balance: 'debit', control: false, label: 'Operating supplies' },
  'expense.bank_fees': { class: 'expense', normal_balance: 'debit', control: false, label: 'Bank fees' },
  // RT-18 (2026-09-02): the commission a payment processor, card acquirer,
  // POS provider, marketplace or delivery platform retains from the firm's
  // GROSS sales before paying the net out (Deliveroo commission, Stripe
  // processing fees, Amazon referral fees, Clover settlement fees). The
  // payout family books gross sales to revenue and this deduction here —
  // never revenue net of it (round-4 Desert Rose review §D: "payouts booked
  // NET as Sales understate gross sales and hide commissions"). Distinct
  // from expense.bank_fees (the firm's own bank charging it) and from
  // expense.marketing (a platform's promotion spend is marketing; its
  // commission is not). Market-neutral: every market's payouts carry it,
  // and the tax on the fee rides the fee; added to all four packs at once.
  'expense.platform_fees': { class: 'expense', normal_balance: 'debit', control: false, label: 'Platform and processor fees' },
  // Country-pack fallback-palette roles (gap 7). Added because BOTH first-class
  // markets need them and the legacy SG fallback list had neither: premises
  // running costs (electricity, heating, water — FI sähkö/lämmitys, GB
  // utilities) and vehicle running costs (FI ajoneuvokulut, GB motor expenses)
  // are among the highest-volume small-business lines in each. Adding the role
  // is the right move over omitting the account: if a pack declares what the
  // market requires and the engine cannot express it, the ENGINE is the bug.
  'expense.utilities': { class: 'expense', normal_balance: 'debit', control: false, label: 'Utilities' },
  'expense.motor': { class: 'expense', normal_balance: 'debit', control: false, label: 'Motor / vehicle expenses' },
  // Round-4 Desert Rose review §D (2026-09-01): two universal expense classes no
  // pack could express. AC maintenance flipped between Operating supplies and
  // Utilities across identical runs because NO palette offered repairs; the FTA
  // administrative penalty landed in statutory fees because nothing named a
  // fines account. Both are market-neutral (repairs exist everywhere; fines
  // and penalties are non-deductible for CT/corporation tax in AE and GB alike
  // and need their own account so the CT computation can add them back).
  'expense.repairs_maintenance': { class: 'expense', normal_balance: 'debit', control: false, label: 'Repairs and maintenance' },
  'expense.fines_penalties': { class: 'expense', normal_balance: 'debit', control: false, label: 'Fines and penalties (non-deductible)' },
  // FX gain/loss is a P&L line that can swing either way; carried as an expense
  // role for normal-balance defaulting, flagged so callers know it's bidirectional.
  'expense.fx': { class: 'expense', normal_balance: 'debit', control: false, bidirectional: true, label: 'Foreign exchange gain/loss' },

  // Inventory valuation allowance (design §5-F) — a contra-asset carried at a CREDIT
  // normal balance: net inventory = gross cost subledger − allowance. Never a direct
  // credit to asset.inventory (that would desync the cost subledger from GL).
  'contra_asset.inventory_valuation_allowance': { class: 'contra_asset', normal_balance: 'credit', control: false, label: 'Inventory valuation allowance' },

  // Inventory count variance (design §5-E) — a neutral P&L line for count loss/gain.
  // NOT a "shrinkage expense" auto-credited for found stock: bidirectional, debit-normal
  // for the common loss case, credited only for a confirmed reversal of earlier shrinkage.
  'pnl.inventory_count_variance': { class: 'pnl', normal_balance: 'debit', control: false, bidirectional: true, label: 'Inventory count variance' },

  'clearing.intercompany': { class: 'clearing', normal_balance: null, control: true, label: 'Intercompany clearing' },
  'clearing.payment_processor': { class: 'clearing', normal_balance: null, control: true, label: 'Payment-processor clearing' },

  'control.suspense': { class: 'control', normal_balance: null, control: true, label: 'Suspense' }
};

export const isAccountRole = (role) => Object.prototype.hasOwnProperty.call(ACCOUNT_ROLES, String(role || ''));

export const roleMeta = (role) => ACCOUNT_ROLES[String(role || '')] || null;

export const normalBalanceForRole = (role) => roleMeta(role)?.normal_balance ?? null;

export const isControlRole = (role) => Boolean(roleMeta(role)?.control);

export const rolesForClass = (klass) =>
  Object.keys(ACCOUNT_ROLES).filter((role) => ACCOUNT_ROLES[role].class === klass);

// Explicit name → role table for Donna's OWN known seed accounts: the legacy
// fallback palette (transactionLlm.XERO_ACCOUNT_OPTIONS) and the provision
// template (xeroCoaProvisioning.DONNA_COA_ACCOUNTS). Keys are normalized via
// normalizeIntelText at load. This is NOT a general classifier — only the names
// Donna itself defines map here; everything else is the model's to resolve.
const SEED_NAME_ROLES = {
  // legacy fallback list (XERO_ACCOUNT_OPTIONS)
  'sales': 'revenue.operating',
  'bank fees': 'expense.bank_fees',
  // RT-18 pack seed name (all four packs) — the payout family's fee leg.
  'platform and processor fees': 'expense.platform_fees',
  'software subscriptions': 'expense.software',
  'travel': 'expense.travel',
  'meals and entertainment': 'expense.meals',
  'marketing': 'expense.marketing',
  'professional fees': 'expense.professional_fees',
  'accounting fees': 'expense.accounting_fees',
  'statutory filing fees': 'expense.statutory_fees',
  'payroll': 'expense.payroll',
  'cpf payable': 'liability.payroll_payable',
  'payroll withholding and employer health-insurance payable': 'liability.payroll_payable',
  'rent': 'expense.rent',
  'telecommunications': 'expense.telecom',
  'insurance': 'expense.insurance',
  'office expenses': 'expense.office',
  'operating supplies': 'expense.operating_supplies',
  'director loan': 'liability.director_loan',
  'owner drawings': 'equity.owner_drawings',
  // GB sole-trader default-chart seed name (gb/defaultChart.js) — Donna's own
  // seed data, so it belongs in this table like the DONNA/provision names do.
  'owner capital introduced': 'equity.owner_capital',
  'share capital': 'equity.share_capital',
  'share premium': 'equity.share_premium',
  'retained earnings': 'equity.retained_earnings',
  'loan payable': 'liability.loan',
  'intercompany transfer': 'clearing.intercompany',
  'interest expense': 'expense.interest',
  'interest income': 'revenue.interest',
  'tax payable': 'liability.tax_payable',
  'foreign exchange gain loss': 'expense.fx',
  'repairs and maintenance': 'expense.repairs_maintenance',
  'fines and penalties': 'expense.fines_penalties',
  'suspense': 'control.suspense',
  // provision template extras (DONNA_COA_ACCOUNTS)
  'sales income': 'revenue.operating',
  'other income': 'revenue.other',
  'it and software': 'expense.software',
  'office operations': 'expense.office',
  'intercompany clearing': 'clearing.intercompany',
  'related party loan': 'liability.related_party_loan',
  // Inventory-posting seed names (I4·posting P2, design §8). These match the account
  // names the capability-enablement provisioning proposes, so a provisioned inventory
  // account resolves back to its canonical role by name (roleForSeedName) — the same
  // annotated-role-agrees discipline the DONNA template already follows.
  'inventory': 'asset.inventory',
  'goods received not invoiced': 'liability.grni',
  'accounts payable': 'liability.accounts_payable',
  'cost of sales': 'expense.cost_of_sales',
  'cost of sales adjustment': 'expense.cost_of_sales_adjustment',
  'purchase price variance': 'expense.purchase_price_variance',
  'inventory write-down': 'expense.inventory_write_down',
  'inventory valuation allowance': 'contra_asset.inventory_valuation_allowance',
  'inventory count variance': 'pnl.inventory_count_variance',
  'receivable from owner': 'asset.receivable_from_owner'
};

const NORMALIZED_SEED_NAME_ROLES = new Map(
  Object.entries(SEED_NAME_ROLES).map(([name, role]) => [normalizeIntelText(name), role])
);

// Map one of Donna's known seed account names → its canonical role, or null when
// the name isn't one Donna defines (the strong model resolves those later).
export const roleForSeedName = (name) => {
  const key = normalizeIntelText(name);
  if (!key) return null;
  return NORMALIZED_SEED_NAME_ROLES.get(key) || null;
};

export const __SEED_NAME_ROLES = SEED_NAME_ROLES;
